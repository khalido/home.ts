import { idKey } from "../../discover.ts";
import type { IppValue } from "./codec.ts";

/** One consumable as the printer lists it: ink or toner, a drum, a fuser, waste. The level is the printer's own number, unrounded. */
export type Marker = { name?: string; level?: number; type?: string; color?: string };

export type PrinterStatus = "idle" | "printing" | "stopped" | "offline";

/**
 * One printer. Every field the printer reports is optional; an odd reading passes through and is named in `anomaly`.
 * `uuid` is the key: the mDNS `UUID` (or `printer-uuid`) lowercase without dashes. An unreachable printer keeps its last good
 * values, with `state: "offline"` and `lastSeen`; `asOf` is when this entry was last checked, `lastSeen` when it last answered.
 */
export type Printer = {
  uuid: string;
  name: string;
  model?: string;
  host?: string;
  room?: string;
  state?: PrinterStatus; // absent when the printer sent a code outside 3 to 5; `stateCode` has it
  stateCode?: number;
  reasons?: string[];
  message?: string;
  markers?: Marker[];
  media?: string[]; // media-ready keywords, as sent: "iso_a4_210x297mm"
  queuedJobs?: number;
  acceptingJobs?: boolean;
  formats?: string[]; // document-format-supported: MIME types
  ippVersions?: string[];
  alerts?: string[];
  ipps: boolean; // read over TLS
  lastSeen?: string;
  asOf: string;
  detail?: string;
  anomaly?: string;
};

export type PrintersState = { printers: Record<string, Printer>; asOf: string };

/** An id as the snapshot keys it: a UUID in any form (`urn:uuid:…`, dashed, upper case) is its 32 hex digits; an instance name keeps its letters and digits. */
export const printerKey = idKey;

/** The fields of `Printer` that come from Get-Printer-Attributes. */
export type Reading = Partial<Pick<Printer, "model" | "state" | "stateCode" | "reasons" | "message" | "markers" | "media" | "queuedJobs" | "acceptingJobs" | "formats" | "ippVersions" | "alerts" | "anomaly">> & { uuid?: string };

const strings = (v?: IppValue[]): string[] | undefined => v?.flatMap((x) => (typeof x === "string" ? [x] : x instanceof Uint8Array ? [new TextDecoder().decode(x)] : []));
const numbers = (v?: IppValue[]): number[] | undefined => v?.flatMap((x) => (typeof x === "number" ? [x] : []));

const STATES: Record<number, PrinterStatus> = { 3: "idle", 4: "printing", 5: "stopped" };

/**
 * The printer's attributes (name → values, from `attributesOf`) as a `Reading`. Nothing is clamped or corrected: a state
 * outside 3 to 5 leaves `state` out and keeps the code; a marker level outside 0 to 100 (PWG 5100.13 gives the negative ones
 * special meanings) stays as sent; both, and lists that disagree in length, are named in `anomaly`.
 */
export function toState(attrs: Record<string, IppValue[]>): Reading {
  const odd: string[] = [];
  const [stateCode] = numbers(attrs["printer-state"]) ?? [];
  const state = stateCode === undefined ? undefined : STATES[stateCode];
  if (stateCode !== undefined && !state) odd.push(`printer-state ${stateCode}, not 3 (idle), 4 (processing) or 5 (stopped)`);
  const names = strings(attrs["marker-names"]);
  const levels = numbers(attrs["marker-levels"]);
  const types = strings(attrs["marker-types"]);
  const colors = strings(attrs["marker-colors"]);
  const count = Math.max(names?.length ?? 0, levels?.length ?? 0, types?.length ?? 0, colors?.length ?? 0);
  const lengths = [names, levels, types, colors].flatMap((x) => (x ? [x.length] : []));
  if (new Set(lengths).size > 1) odd.push(`marker lists of different lengths (${lengths.join(", ")})`);
  const markers: Marker[] = Array.from({ length: count }, (_, i) => ({ name: names?.[i], level: levels?.[i], type: types?.[i], color: colors?.[i] }));
  for (const m of markers) if (m.level !== undefined && (m.level < 0 || m.level > 100)) odd.push(`marker ${m.name ?? "?"} level ${m.level}, outside 0 to 100`);
  const accepting = attrs["printer-is-accepting-jobs"]?.[0];
  const uuid = strings(attrs["printer-uuid"])?.[0];
  return {
    uuid,
    model: strings(attrs["printer-make-and-model"])?.[0],
    state,
    stateCode,
    reasons: strings(attrs["printer-state-reasons"]),
    message: strings(attrs["printer-state-message"])?.[0],
    markers: count ? markers : undefined,
    media: strings(attrs["media-ready"]),
    queuedJobs: numbers(attrs["queued-job-count"])?.[0],
    acceptingJobs: typeof accepting === "boolean" ? accepting : undefined,
    formats: strings(attrs["document-format-supported"]),
    ippVersions: strings(attrs["ipp-versions-supported"]),
    alerts: strings(attrs["printer-alert"]),
    anomaly: odd.length ? odd.join("; ") : undefined,
  };
}

/** A PWG media keyword for reading: `iso_a4_210x297mm` is "A4", `na_letter_8.5x11in` "Letter". A keyword in another shape stays as it is. */
export function mediaName(keyword: string): string {
  const parts = keyword.split("_");
  if (parts.length < 3) return keyword;
  const name = parts[1]!;
  return /^[a-z]\d+$/.test(name) ? name.toUpperCase() : name.charAt(0).toUpperCase() + name.slice(1);
}

/** "5 min ago", "2 h ago", "3 days ago" from two instants; whole units, down. */
export function ago(fromMs: number, toMs: number): string {
  const min = Math.max(0, Math.floor((toMs - fromMs) / 60_000));
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} days ago`;
}

/** One printer in a few words: "Office: idle · Black Toner 40% · A4 ready", "Office: offline, last seen 2 h ago". */
export function printerText(p: Printer): string {
  if (p.state === "offline") {
    const seen = p.lastSeen === undefined ? "never seen" : `last seen ${ago(Date.parse(p.lastSeen), Date.parse(p.asOf))}`;
    return `${p.name}: offline, ${seen}`;
  }
  const attention = (p.reasons ?? []).filter((r) => /-(error|warning)$/.test(r));
  const media = [...new Set((p.media ?? []).map(mediaName))];
  const parts = [
    p.state ?? (p.stateCode === undefined ? "" : `state ${p.stateCode}`),
    ...(p.markers ?? []).map((m) => `${m.name ?? "?"} ${m.level ?? "?"}%`),
    media.length ? `${media.join(", ")} ready` : "",
    p.queuedJobs ? `${p.queuedJobs} queued` : "",
    p.acceptingJobs === false ? "not accepting jobs" : "",
    ...attention,
  ];
  return `${p.name}: ${parts.filter(Boolean).join(" · ")}`;
}
