import { ConnectorError } from "../../connector.ts";

// Colour for Hue lights. A light's colour is an `xy` point in the CIE 1931 space, and each light can show the points
// inside its gamut triangle, which the bridge reports per light. The steps are the standard sRGB ones (gamma, the D65
// matrix), as Signify's "Color Conversion Formulas" page describes; that page's SDK extract is not copied.

export type XY = { x: number; y: number };
export type Gamut = { red: XY; green: XY; blue: XY };
export type Rgb = { r: number; g: number; b: number };

/** A colour as a caller gives it: "#ff8800", "ff8800", "#f80", or `{ r, g, b }` each 0–255. Throws on anything else. */
export function parseColor(color: string | Rgb): Rgb {
  if (typeof color !== "string") {
    const ok = [color.r, color.g, color.b].every(
      (v) => Number.isFinite(v) && v >= 0 && v <= 255,
    );
    if (!ok)
      throw new ConnectorError("a colour's r, g and b are each 0–255", {
        code: "invalid",
      });
    return color;
  }
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!hex)
    throw new ConnectorError(`"${color}" is not a colour like #ff8800`, {
      code: "invalid",
    });
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  const n = Number.parseInt(full, 16);
  return { r: n >> 16, g: (n >> 8) & 255, b: n & 255 };
}

const linear = (v: number) =>
  v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
const gamma = (v: number) =>
  v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;

const cross = (a: XY, b: XY) => a.x * b.y - a.y * b.x;
const minus = (a: XY, b: XY): XY => ({ x: a.x - b.x, y: a.y - b.y });

/** Whether `p` is inside the gamut triangle. */
export function inGamut(p: XY, g: Gamut): boolean {
  const v1 = minus(g.green, g.red);
  const v2 = minus(g.blue, g.red);
  const q = minus(p, g.red);
  const s = cross(q, v2) / cross(v1, v2);
  const t = cross(v1, q) / cross(v1, v2);
  return s >= 0 && t >= 0 && s + t <= 1;
}

/** The nearest point to `p` on the segment a–b. */
function onSegment(a: XY, b: XY, p: XY): XY {
  const ab = minus(b, a);
  const t = Math.min(
    1,
    Math.max(
      0,
      ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / (ab.x ** 2 + ab.y ** 2),
    ),
  );
  return { x: a.x + ab.x * t, y: a.y + ab.y * t };
}

/** `p` if the light can show it, else the nearest point on its gamut's edge: the colour it can show that is closest. */
export function nearestInGamut(p: XY, g: Gamut): XY {
  if (inGamut(p, g)) return p;
  const edges = [
    onSegment(g.red, g.green, p),
    onSegment(g.green, g.blue, p),
    onSegment(g.blue, g.red, p),
  ];
  const far = (q: XY) => (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
  return edges.reduce((best, q) => (far(q) < far(best) ? q : best));
}

/**
 * A colour's `xy`, moved inside `gamut` when one is given. Brightness is not part of it: black has no colour and throws
 * (turn the light off instead), and a dark red and a bright red are the same point.
 */
export function colorToXy(color: string | Rgb, gamut?: Gamut): XY {
  const { r, g, b } = parseColor(color);
  const [lr, lg, lb] = [r, g, b].map((v) => linear(v / 255)) as [
    number,
    number,
    number,
  ];
  const X = lr * 0.4124 + lg * 0.3576 + lb * 0.1805;
  const Y = lr * 0.2126 + lg * 0.7152 + lb * 0.0722;
  const Z = lr * 0.0193 + lg * 0.1192 + lb * 0.9505;
  const sum = X + Y + Z;
  if (sum === 0)
    throw new ConnectorError("black is not a colour a light can show", {
      code: "invalid",
    });
  const xy = { x: X / sum, y: Y / sum };
  const at = gamut ? nearestInGamut(xy, gamut) : xy;
  return { x: round4(at.x), y: round4(at.y) };
}
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** An `xy` as a hex colour for a screen, at full brightness: what the light's colour looks like, not how bright it is. */
export function xyToHex(xy: XY): string {
  if (xy.y <= 0) return "#000000";
  const X = xy.x / xy.y;
  const Z = (1 - xy.x - xy.y) / xy.y;
  const rgb = [
    X * 3.2406 - 1.5372 - Z * 0.4986,
    -X * 0.9689 + 1.8758 + Z * 0.0415,
    X * 0.0557 - 0.204 + Z * 1.057,
  ].map((v) => Math.max(0, v));
  const max = Math.max(...rgb);
  return `#${rgb
    .map((v) =>
      Math.round(255 * Math.min(1, Math.max(0, gamma(max > 0 ? v / max : 0))))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Colour temperature: Hue counts in mirek, a million over the kelvin. 2700 K is 370 mirek. */
export const kelvinToMirek = (kelvin: number) => Math.round(1e6 / kelvin);
export const mirekToKelvin = (mirek: number) => Math.round(1e6 / mirek);
