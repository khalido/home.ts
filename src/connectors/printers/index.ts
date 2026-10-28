import { z } from "zod";
import { asOf, type Clock, realClock } from "../../clock.ts";
import { errorText } from "../../connector.ts";
import { DAY_MS, discover, type Finder, HOUR, type Found, type Lost, lostDetail, rescanDelay } from "../../discover.ts";
import type { Integration, Part, Status } from "../../home.ts";
import type { Manifest } from "../../manifest.ts";
import { poller } from "../../poll.ts";
import { getPrinterAttributes, printerUrl } from "./client.ts";
import { attributesOf } from "./codec.ts";
import { type Printer, printerKey, printerText, type PrintersState, type Reading, toState } from "./state.ts";

export { type Marker, type Printer, type PrintersState, type PrinterStatus, printerText } from "./state.ts";

/** One printer in a home config. Everything the printer reports about itself (model, markers, state) comes live; `host` and `port` are only where it last answered. */
export const configSchema = z.looseObject({
  connector: z.literal("printers"),
  name: z.string().describe("the printer's name for display (mDNS `ty`, or its instance name); `home discover --write` fills it"),
  uuid: z.string().describe("the printer's UUID from its mDNS TXT record, the stable identity; `home discover --write` fills it"),
  host: z.string().optional().describe("the address it last answered at; discovery refreshes it"),
  port: z.number().int().min(1).max(65535).optional().describe("its IPP port (631 plain, 443 TLS); discovery fills it"),
  offlineDays: z.number().positive().optional().describe("days an unreachable printer shows as offline with its last-seen time before its entry flags it as long gone; default 14"),
});

export type PrinterEntry = { uuid: string; name?: string; host?: string; port?: number; room?: string; offlineDays?: number };

export type PrintersConfig = {
  /** The config's printers (a `name` is the config's and stays; without one the printer's own, from discovery, is used). Discovery adds any others it finds. */
  printers?: PrinterEntry[];
  /** Plain HTTP and HTTPS; the global `fetch` when left out. A printer's self-signed certificate on IPPS fails here, as it should. */
  fetch?: typeof fetch;
  /** mDNS discovery (`FINDERS.printers`): at start, then after a failed read on the relocator's cadence (1, 5, 15 minutes, hourly), and hourly for new printers. Without it only the configured addresses are read. */
  find?: Finder;
  /** Each address that answered, for an address cache. */
  seen?: (uuid: string, address: { host: string; port: number; name?: string }) => void;
  clock?: Clock;
  /** Poll interval; default 120 s. */
  pollMs?: number;
};

export const POLL_MS = 120_000;
/** A printer unreachable this many days gets a note in `anomaly`, unless its config says otherwise. */
const OFFLINE_DAYS = 14;

/** What the integration knows about one printer between polls. */
type Target = {
  key: string;
  name: string;
  fixedName: boolean; // the config named it
  room?: string;
  offlineDays: number;
  host?: string;
  port?: number;
  rp?: string; // from discovery's TXT
  secure?: boolean; // from discovery: found on _ipps._tcp alone
  foundModel?: string;
  good?: Reading; // the last read that worked
  lastSeen?: number;
  since: number; // when we first looked, the start of "no answer" for a printer never seen
  failure?: string; // why the latest read failed; absent after a good read
  lost: Lost; // what the latest scan learned about a failed one
  ipps: boolean;
};

/**
 * Every printer as one integration, state only: a Get-Printer-Attributes over IPP to each, every 120 s. An unreachable
 * printer stays in the snapshot as `offline` with its last good values and `lastSeen`, and the part is never
 * `unavailable` for that. Discovery is one shared scan, as Cast's is, not a relocator per printer: it finds printers
 * the config does not list, and after a failed read it looks for the printer's new address (at 1, 5 and 15 minutes, then hourly).
 */
export function printers(config: PrintersConfig = {}): Integration<PrintersState, "printers"> {
  const clock = config.clock ?? realClock;
  const fetcher = config.fetch ?? fetch;
  const pollMs = config.pollMs ?? POLL_MS;
  const poll = poller(clock);
  const targets = new Map<string, Target>();
  const add = (t: Partial<Target> & { key: string; name: string; fixedName: boolean }): Target => {
    const target: Target = { offlineDays: OFFLINE_DAYS, since: clock.now(), lost: {}, ipps: false, ...t };
    targets.set(t.key, target);
    return target;
  };
  for (const p of config.printers ?? []) add({ key: printerKey(p.uuid), name: p.name ?? p.uuid, fixedName: p.name !== undefined, room: p.room, host: p.host, port: p.port, offlineDays: p.offlineDays ?? OFFLINE_DAYS });
  let report: ((part: Part<PrintersState>) => void) | undefined;
  let polled = false;
  let requestId = 0;
  let lastScan = Number.NEGATIVE_INFINITY;
  let nextScan = 0;
  let attempt = 0;
  let scanError: string | undefined;

  /** The entry for the snapshot: the last good values, `offline` while the latest read has failed. */
  function view(t: Target, now: string): Printer {
    const { uuid: _, anomaly: oddReading, ...good } = t.good ?? {};
    const offline = t.failure !== undefined;
    const base = t.lastSeen ?? t.since;
    const idle = clock.now() - base;
    const long = offline && idle > t.offlineDays * DAY_MS ? `no answer for ${Math.floor(idle / DAY_MS)} days` : undefined;
    return {
      ...good,
      uuid: t.key,
      name: t.name,
      model: good.model ?? t.foundModel,
      host: t.host,
      room: t.room,
      ...(offline ? { state: "offline" as const } : {}),
      ipps: t.ipps,
      lastSeen: t.lastSeen === undefined ? undefined : new Date(t.lastSeen).toISOString(),
      asOf: now,
      detail: offline ? lostDetail({ ...t.lost, ...(idle >= DAY_MS ? { overADay: true } : {}) }, t.failure) : undefined,
      anomaly: [oddReading, long].filter(Boolean).join("; ") || undefined,
    };
  }

  function publish() {
    const now = asOf(clock);
    const list = [...targets.values()].map((t) => view(t, now));
    const down = list.filter((p) => p.state === "offline");
    const status: Status = !polled ? "connecting" : list.length && down.length < list.length ? "connected" : "disconnected";
    const detail = [scanError && `discovery failed: ${scanError}`, list.length ? (down.length ? `${down.map((p) => p.name).join(", ")} offline` : "") : config.find ? "no printers found" : "no printers configured"].filter(Boolean).join("; ") || undefined;
    const anomaly = list.filter((p) => p.anomaly).map((p) => `${p.name}: ${p.anomaly}`).join("; ") || undefined;
    report?.({ status, detail, anomaly, state: { printers: Object.fromEntries(list.map((p) => [p.uuid, p])), asOf: now } });
  }

  /** One read. A failure is data (`failure`), never thrown; an address that answers as another printer is a failure. */
  async function read(t: Target, signal: AbortSignal): Promise<void> {
    if (!t.host) {
      t.failure = "no address yet";
      return;
    }
    const address = { host: t.host, port: t.port, rp: t.rp, secure: t.secure };
    t.ipps = printerUrl(address).secure;
    try {
      const reading = toState(attributesOf(await getPrinterAttributes(fetcher, address, { signal, requestId: ++requestId })));
      if (reading.uuid && /^[0-9a-f]{32}$/.test(t.key) && printerKey(reading.uuid) !== t.key) throw new Error("the address answers as another printer");
      t.good = reading;
      t.lastSeen = clock.now();
      t.failure = undefined;
      t.lost = {};
      config.seen?.(t.key, { host: t.host, port: t.port ?? (t.ipps ? 443 : 631), name: t.fixedName ? undefined : t.name });
    } catch (error) {
      if (!signal.aborted) t.failure = errorText(error);
    }
  }

  /** One discovery. Printers it finds get their address and TXT; ones the config lacks join the snapshot. Returns those that need reading again. */
  async function scan(signal: AbortSignal, failed: Target[]): Promise<Target[]> {
    lastScan = clock.now();
    let all: Found[];
    try {
      const wanted = failed.map((t) => t.key);
      all = await discover(config.find!, {
        clock,
        signal,
        passes: failed.length ? undefined : 1,
        done: wanted.length ? (found) => wanted.every((k) => found.some((f) => printerKey(f.id) === k)) : undefined,
      });
      scanError = undefined;
    } catch (error) {
      scanError = errorText(error);
      for (const t of failed) t.lost = { discoveryFailed: scanError };
      return [];
    }
    const changed: Target[] = [];
    const mine = all.filter((f) => f.connector === "printers");
    for (const f of mine) {
      const key = printerKey(f.id);
      const known = targets.get(key);
      const t = known ?? add({ key, name: f.name ?? f.id, fixedName: false });
      const moved = t.host !== f.host || (f.port !== undefined && t.port !== f.port);
      // A printer known by host alone was read at the default path over http; the TXT may say otherwise.
      const reroute = (f.txt?.rp !== undefined && f.txt.rp !== t.rp) || (f.secure !== undefined && f.secure !== t.secure);
      if (!t.fixedName && f.name) t.name = f.name;
      Object.assign(t, { host: f.host, port: f.port ?? t.port, rp: f.txt?.rp ?? t.rp, secure: f.secure ?? t.secure, foundModel: f.model ?? t.foundModel });
      if (!known || moved || reroute) changed.push(t);
      else if (failed.includes(t)) t.lost = { seenHere: true };
    }
    for (const t of failed) if (!mine.some((f) => printerKey(f.id) === t.key)) t.lost = { seenHere: false };
    return changed;
  }

  async function pollOnce(signal: AbortSignal): Promise<void> {
    const first = !polled;
    await Promise.all([...targets.values()].map((t) => read(t, signal)));
    if (signal.aborted || !config.find) return;
    const now = clock.now();
    const failed = () => [...targets.values()].filter((t) => t.failure !== undefined);
    if (!(first || (failed().length && now >= nextScan) || now >= lastScan + HOUR)) return;
    const changed = await scan(signal, failed());
    await Promise.all(changed.map((t) => read(t, signal)));
    if (failed().length) nextScan = now + rescanDelay(attempt++);
    else (attempt = 0), (nextScan = 0);
  }

  return {
    name: "printers",
    /** Read now; a printer that is down is looked for again at once. */
    refresh() {
      attempt = 0;
      nextScan = 0;
      poll.nudge();
    },
    async run(signal, update) {
      report = update;
      while (!signal.aborted) {
        await pollOnce(signal);
        if (signal.aborted) return;
        polled = true;
        publish();
        await poll.wait(pollMs, signal);
      }
    },
  };
}

/** Printers sorted by name. */
export const printerList = (s: PrintersState) => Object.values(s.printers).sort((a, b) => a.name.localeCompare(b.name));

export const manifest: Manifest<PrintersState> = {
  name: "printers",
  title: "Printers",
  iotClass: "local_polling",
  pollSeconds: POLL_MS / 1000,
  access: "local IPP over HTTP, no key; found by mDNS (AirPrint)",
  env: [],
  lines({ state }) {
    if (!state) return [];
    const list = printerList(state);
    return [`${list.length} printer${list.length === 1 ? "" : "s"}`, ...list.map(printerText)];
  },
};
