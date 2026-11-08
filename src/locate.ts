import { applyEdits, modify, parse } from "jsonc-parser";
import { z } from "zod";

// A street address to the home's latitude and longitude, once, through OpenStreetMap's Nominatim, and that position
// written into a home config's text. Pure: the caller passes `fetch` and its User-Agent, and writes the file.

/** One Nominatim match. It sends the coordinates as strings; they are read as numbers, never rounded. */
const Place = z.looseObject({
  display_name: z.string(),
  lat: z.coerce.number(),
  lon: z.coerce.number(),
});

export type Located = { name: string; latitude: number; longitude: number };

/**
 * The best match for `address`, or undefined when Nominatim finds none. Its usage policy requires a User-Agent that
 * names the application, and allows one request a second: this is for a one-off lookup, not a loop.
 */
export async function geocode(
  address: string,
  options: { fetch?: typeof fetch; userAgent: string; signal?: AbortSignal },
): Promise<Located | undefined> {
  const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: address, format: "jsonv2", limit: "1" })}`;
  const res = await (options.fetch ?? fetch)(url, {
    headers: { "User-Agent": options.userAgent },
    signal: options.signal ?? AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Nominatim answered ${res.status}`);
  const places = z.array(Place).safeParse(await res.json());
  if (!places.success)
    throw new Error(
      "Nominatim's answer was not a list of places with coordinates",
    );
  const p = places.data[0];
  return p && { name: p.display_name, latitude: p.lat, longitude: p.lon };
}

/**
 * A config's text with `location.latitude` and `.longitude` set and, when it has none, `.timezone`, through
 * jsonc-parser's edits: comments and every other key stay. With no `location` (absent or commented out) a fresh one is
 * added, and `fresh` says so; a commented-out one is left as it was.
 */
export function applyLocation(
  text: string,
  at: { latitude: number; longitude: number },
  timeZone: string,
): { text: string; fresh: boolean; timezoneSet: boolean } {
  const location = (parse(text) as { location?: unknown } | undefined)
    ?.location;
  const format = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
  if (typeof location !== "object" || location === null) {
    return {
      text: applyEdits(
        text,
        modify(
          text,
          ["location"],
          {
            latitude: at.latitude,
            longitude: at.longitude,
            timezone: timeZone,
          },
          format,
        ),
      ),
      fresh: true,
      timezoneSet: true,
    };
  }
  let out = text;
  for (const [key, value] of [
    ["latitude", at.latitude],
    ["longitude", at.longitude],
  ] as const)
    out = applyEdits(out, modify(out, ["location", key], value, format));
  const timezoneSet =
    (location as { timezone?: unknown }).timezone === undefined;
  if (timezoneSet)
    out = applyEdits(
      out,
      modify(out, ["location", "timezone"], timeZone, format),
    );
  return { text: out, fresh: false, timezoneSet };
}
