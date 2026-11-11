import { applyEdits, modify } from "jsonc-parser";
import type { Clock } from "./clock.ts";
import type { HomeConfig } from "./config.ts";
import { errorText } from "./connector.ts";

/** mDNS service types worth looking for at home, and what this package does with each. Extend the list as needed. */
export const KNOWN_SERVICES: Record<
  string,
  { what: string; connector?: string }
> = {
  "_hue._tcp": { what: "Philips Hue bridge", connector: "hue" },
  "_dkapi._tcp": {
    what: "Daikin AC (Home Assistant's zeroconf type)",
    connector: "daikin",
  },
  "_enphase-envoy._tcp": { what: "Enphase IQ Gateway", connector: "enphase" },
  "_googlecast._tcp": {
    what: "Google Cast (Nest speakers and hubs, Chromecast, TVs, speaker groups)",
    connector: "cast",
  },
  "_ipp._tcp": { what: "AirPrint printer (IPP)", connector: "printers" },
  "_ipps._tcp": {
    what: "AirPrint printer (IPP over TLS)",
    connector: "printers",
  },
  "_airplay._tcp": { what: "AirPlay (Apple TV, HomePod, speakers)" },
  "_raop._tcp": { what: "AirPlay audio receiver" },
  "_matter._tcp": { what: "Matter device (commissioned)" },
  "_matterc._udp": { what: "Matter device waiting to be commissioned" },
  "_hap._tcp": { what: "HomeKit accessory" },
  "_sonos._tcp": { what: "Sonos speaker" },
  "_esphomelib._tcp": { what: "ESPHome device" },
  "_shelly._tcp": { what: "Shelly relay or plug" },
  "_wled._tcp": { what: "WLED light strip" },
  "_nanoleafapi._tcp": { what: "Nanoleaf panels" },
  "_eero._tcp": { what: "eero Wi-Fi router (cloud-only API)" },
  "_home-assistant._tcp": { what: "Home Assistant server" },
};

// Identity and address: a device in the home config is recognised by the id its own discovery reports, and `host` is
// only its last known address. These are pure: the CLI finds devices, these match them and edit the config's text.

/** A device a discovery answer named: its connector, the identity it reported, and where it answered; Cast adds its name, model, port and whether it is a group; a printer adds its port, whether it answered on `_ipps._tcp`, and its TXT record. */
export type Found = {
  connector: Connector;
  id: string;
  host: string;
  name?: string;
  model?: string;
  port?: number;
  group?: boolean;
  secure?: boolean;
  txt?: Record<string, string>;
};
/** One connector's discovery, as the caller can run it (mDNS, UDP): every device of that kind that answered. */
export type Finder = () => Promise<Found[]>;

/** Which config field holds each connector's identity, as its discovery reports it. */
export const IDENTITY = {
  hue: "bridgeId",
  daikin: "mac",
  enphase: "serial",
  cast: "castId",
  printers: "uuid",
} as const;
export type Connector = keyof typeof IDENTITY;

/** Connectors with many devices in one integration (every Cast device and group, every printer); the rest allow one device for now. */
export const MANY: ReadonlySet<string> = new Set(["cast", "printers"]);

/** An identity without case, separators or a `urn:uuid:` prefix: "00:17:88:B0" is "001788b0", "urn:uuid:AB-CD" is "abcd". */
export const idKey = (id: string) =>
  id
    .toLowerCase()
    .replace(/^urn:uuid:/, "")
    .replace(/[^0-9a-z]/g, "");

/** Identities compared by `idKey`. */
export const sameId = (a: string, b: string) => idKey(a) === idKey(b);

export type Match = {
  moved: {
    index: number;
    id: string;
    connector: Connector;
    from: string;
    to: string;
  }[];
  renamed: {
    index: number;
    id: string;
    connector: Connector;
    from: string;
    to: string;
  }[]; // Cast: the device's name (mDNS fn) changed in the Google Home app
  added: { found: Found; entry: Record<string, string | number> }[];
  skipped: { found: Found; why: string }[]; // found but not written: a second device of a connector, for now
  known: { id: string; connector: Connector; hint?: string }[];
};

/** A new config entry for a found device, with the CLI's default key name and file paths, which `home config check` then verifies. */
function newEntry(f: Found): Record<string, string | number> {
  if (f.connector === "cast") {
    const name = f.name ?? f.id;
    return {
      id:
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "cast",
      connector: "cast",
      name,
      castId: f.id,
    };
  }
  if (f.connector === "printers") {
    const name = f.name ?? f.id;
    return {
      id:
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "printer",
      connector: "printers",
      name,
      uuid: f.id,
      host: f.host,
      ...(f.port === undefined ? {} : { port: f.port }),
    };
  }
  const base = {
    id: f.connector,
    connector: f.connector,
    host: f.host,
    [IDENTITY[f.connector]]: f.id,
  };
  if (f.connector === "hue") return { ...base, key: "HUE_APPLICATION_KEY" };
  if (f.connector === "enphase")
    return { ...base, token: "~/.config/home/enphase-token.json" };
  return base;
}

/** `id`, or `id-2`, `id-3`… : the first not in `taken`. */
function unique(id: string, taken: Set<string>): string {
  let out = id;
  for (let n = 2; taken.has(out); n++) out = `${id}-${n}`;
  return out;
}

/**
 * Match what discovery found against the config by identity. An entry with no identity yet is matched by host, and a
 * device at an entry's host with a different identity is a conflict, not a match. New entries get ids no entry has.
 */
export function matchFound(config: HomeConfig, found: Found[]): Match {
  const devices = config.devices ?? [];
  const match: Match = {
    moved: [],
    renamed: [],
    added: [],
    skipped: [],
    known: [],
  };
  const taken = new Set(devices.map((d) => d.id));
  const identity = (x: (typeof devices)[number], field: string) =>
    (x as Record<string, unknown>)[field] as string | undefined;
  const hostOf = (x: (typeof devices)[number] | undefined) =>
    (x as { host?: string } | undefined)?.host;
  for (const f of found) {
    const field = IDENTITY[f.connector];
    const same = devices.filter((x) => x.connector === f.connector);
    const index = devices.findIndex(
      (d) =>
        d.connector === f.connector &&
        typeof identity(d, field) === "string" &&
        sameId(identity(d, field)!, f.id),
    );
    const d = devices[index];
    const atHost = same.find((x) => hostOf(x) === f.host);
    const from = hostOf(d);
    const named =
      d && f.connector === "cast" && f.name !== undefined
        ? (d as { name?: string }).name
        : undefined;
    if (d && named !== undefined && named !== f.name)
      match.renamed.push({
        index,
        id: d.id,
        connector: f.connector,
        from: named,
        to: f.name!,
      });
    if (d && from !== undefined && from !== f.host)
      match.moved.push({
        index,
        id: d.id,
        connector: f.connector,
        from,
        to: f.host,
      });
    else if (d) match.known.push({ id: d.id, connector: f.connector });
    else if (atHost && identity(atHost, field) === undefined)
      match.known.push({
        id: atHost.id,
        connector: f.connector,
        hint: `add "${field}": "${f.id}" to recognise it after a move`,
      });
    else if (atHost)
      match.skipped.push({
        found: f,
        why: `answers at ${atHost.id}'s host with a different ${field}`,
      });
    else if (
      !MANY.has(f.connector) &&
      same.some((x) => identity(x, field) === undefined)
    )
      match.skipped.push({
        found: f,
        why: `could be ${same.find((x) => identity(x, field) === undefined)!.id} moved; add "${field}" to tell`,
      });
    else if (
      !MANY.has(f.connector) &&
      (same.length ||
        match.added.some((a) => a.found.connector === f.connector))
    )
      match.skipped.push({
        found: f,
        why: `a second ${f.connector} device; one per connector for now`,
      });
    else {
      const entry = newEntry(f);
      entry.id = unique(String(entry.id), taken);
      taken.add(String(entry.id));
      match.added.push({ found: f, entry });
    }
  }
  return match;
}

/** One entry as one line of JSON, keys in order: `{ "id": "ac", "connector": "daikin", "host": "…" }`. */
const oneLine = (entry: Record<string, string | number>) =>
  `{ ${Object.entries(entry)
    .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(", ")} }`;

/**
 * The config's text with moved hosts and renamed Cast entries updated and new devices appended, through jsonc-parser's edits: comments, unknown
 * keys and every other line stay as they were. A new device goes on its own line at its neighbour's indent.
 */
export function applyFound(
  text: string,
  match: Match,
  hasDevices: boolean,
): string {
  // hasDevices: the config has a non-empty devices list
  let out = text;
  for (const m of match.moved)
    out = applyEdits(out, modify(out, ["devices", m.index, "host"], m.to, {}));
  for (const r of match.renamed)
    out = applyEdits(out, modify(out, ["devices", r.index, "name"], r.to, {}));
  if (!hasDevices && match.added.length)
    return applyEdits(
      out,
      modify(
        out,
        ["devices"],
        match.added.map((a) => a.entry),
        { formattingOptions: { insertSpaces: true, tabSize: 2 } },
      ),
    );
  for (const { entry } of match.added) {
    const edits = modify(out, ["devices", -1], entry, {
      isArrayInsertion: true,
    });
    const before = out;
    out = applyEdits(
      out,
      edits.map((e) => {
        const indent = before
          .slice(before.lastIndexOf("\n", e.offset - 1) + 1)
          .match(/^\s*/)![0];
        return {
          ...e,
          content: e.content.replace(
            JSON.stringify(entry),
            `\n${indent}${oneLine(entry)}`,
          ),
        };
      }),
    );
  }
  return out;
}

/** mDNS and Daikin's broadcast drop answers now and then, so discovery runs this many passes by default… */
export const DISCOVERY_PASSES = 2;
/** …this far apart. */
export const DISCOVERY_GAP_MS = 5000;

/** A device's key, across discovery passes and in the address cache: its connector and identity, without case or separators. */
export const addressKey = (connector: Connector, id: string) =>
  `${connector}:${idKey(id)}`;
export const foundKey = (f: Found) => addressKey(f.connector, f.id);

/** Where a device last answered, and when that was last confirmed. `name` is kept for Cast, whose config entry may be absent. */
export type CachedAddress = {
  host: string;
  port?: number;
  name?: string;
  model?: string; // Cast: what kind of device, without a discovery
  seenAt: string;
};

/**
 * Addresses kept between runs, so discovery stays rare. The caller persists them (the CLI: a file); the library writes
 * no files. `write` gets the whole map each time an address is new or has changed.
 */
export type AddressCache = {
  read(): Record<string, CachedAddress>;
  write(entries: Record<string, CachedAddress>): void;
};

/**
 * One run's view of an address cache. `fresh` is a cached address confirmed since the config was edited (`configAt`,
 * the config file's time; a config edited since wins); `seen` records an address that answered, writing through when it
 * changed or was not fresh, so an address confirmed after a config edit is trusted again. A Cast name, when given, is the
 * device's own (discovery's fn, or its own multizone status, never a config's), so a new one is written too; a call
 * without a name keeps the one cached.
 */
export function addressBook(
  cache: AddressCache | undefined,
  options: { configAt?: number; now?: () => number } = {},
) {
  const entries = cache?.read() ?? {};
  const now = options.now ?? Date.now;
  // `seenAt` has whole milliseconds and a file time a fraction: a confirmation in the same millisecond as the edit counts.
  const isFresh = (c: CachedAddress) =>
    options.configAt === undefined ||
    Date.parse(c.seenAt) >= Math.floor(options.configAt);
  return {
    fresh(connector: Connector, id?: string): CachedAddress | undefined {
      const c =
        id === undefined ? undefined : entries[addressKey(connector, id)];
      return c && isFresh(c) ? c : undefined;
    },
    seen(
      connector: Connector,
      id: string | undefined,
      address: { host: string; port?: number; name?: string; model?: string },
    ): void {
      if (!cache || id === undefined) return;
      const key = addressKey(connector, id);
      const c = entries[key];
      if (
        c &&
        c.host === address.host &&
        c.port === address.port &&
        isFresh(c) &&
        (!address.name || address.name === c.name) &&
        (!address.model || address.model === c.model)
      )
        return;
      const name = address.name || c?.name;
      const model = address.model || c?.model;
      entries[key] = {
        host: address.host,
        ...(address.port === undefined ? {} : { port: address.port }),
        ...(name ? { name } : {}),
        ...(model ? { model } : {}),
        seenAt: new Date(now()).toISOString(),
      };
      cache.write({ ...entries });
    },
    entries: () => ({ ...entries }),
  };
}

/**
 * Run one discovery `passes` times, `gapMs` apart, and return the union (first answer wins). `onPass` sees each pass's
 * additions as they come; `done` ends it early once what was looked for has answered. A pass that throws adds nothing;
 * when every pass threw, discovery never ran, so it throws the last error rather than reporting nothing found. An error
 * `stopOn` accepts is thrown at once: no later pass could do better.
 */
export async function discover<T = Found>(
  pass: () => Promise<T[]>,
  options: {
    clock: Clock;
    passes?: number;
    gapMs?: number;
    key?: (t: T) => string;
    done?: (all: T[]) => boolean;
    stopOn?: (error: unknown) => boolean;
    onPass?: (n: number, added: T[]) => void;
    signal?: AbortSignal;
  },
): Promise<T[]> {
  const key = options.key ?? (foundKey as unknown as (t: T) => string);
  const all = new Map<string, T>();
  const passes = options.passes ?? DISCOVERY_PASSES;
  let ran = 0;
  const errors: unknown[] = [];
  for (let n = 1; n <= passes && !options.signal?.aborted; n++) {
    if (n > 1)
      await options.clock.sleep(
        options.gapMs ?? DISCOVERY_GAP_MS,
        options.signal,
      );
    if (options.signal?.aborted) break;
    ran++;
    const answers = await pass().catch((error) => {
      if (options.stopOn?.(error)) throw error;
      errors.push(error);
      return [] as T[];
    });
    const added = answers.filter((t) => !all.has(key(t)) && all.set(key(t), t));
    options.onPass?.(n, added);
    if (options.done?.([...all.values()])) break;
  }
  if (ran && errors.length === ran) throw errors.at(-1);
  return [...all.values()];
}

/** Discovery runs after this many failed reads in a row. */
export const RESCAN_AFTER_FAILURES = 3;
/** Then again after these delays, then hourly for as long as reads fail. */
export const RESCAN_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
export const HOUR = 3_600_000;
/** The wait before the next scan after `attempt` scans have missed: 1, 5 and 15 minutes, then hourly. The relocator and Cast's re-discovery share it. */
export const rescanDelay = (attempt: number) =>
  RESCAN_DELAYS_MS[attempt] ?? HOUR;
/** After this long without a read, the detail says a day has passed; the scans carry on hourly. */
export const DAY_MS = 24 * HOUR;

/** What `failed()` learned: a move, that a day has passed since the scans began, whether the last scan found it at its address, or why the last scan could not run. */
export type Lost = {
  moved?: string;
  overADay?: boolean;
  seenHere?: boolean;
  discoveryFailed?: string;
};

/**
 * A polling connector's address, rescanned only on failure. `failed()` after each failed read runs `find` once reads
 * have failed `RESCAN_AFTER_FAILURES` times in a row, then on the backoff, then hourly with no end, so a device that comes
 * back is found without a restart. `ok()` after a good read, `reset()` on a refresh (the next failure scans at once).
 * Without `find` or an identity it never scans. `cached`: the starting host came from an address cache, so the first
 * failure scans at once. `failed(signal)` takes the run's signal, so a shutdown does not wait out a scan.
 */
export function relocator(options: {
  host: string;
  id?: string;
  find?: Finder;
  clock: Clock;
  cached?: boolean;
}) {
  let host = options.host;
  let failures = 0;
  let fromCache = options.cached === true; // a cached address that fails is stale: scan on its first failure
  let attempts = 0;
  let firstScan: number | undefined;
  let nextScan = 0;
  let seenHere: boolean | undefined;
  let discoveryFailed: string | undefined;
  const reset = () => (
    (attempts = 0),
    (firstScan = undefined),
    (nextScan = 0),
    (seenHere = undefined),
    (discoveryFailed = undefined)
  );
  return {
    host: () => host,
    ok: () => ((failures = 0), (fromCache = false), reset()),
    reset,
    async failed(signal?: AbortSignal): Promise<Lost> {
      failures++;
      const { find, id, clock } = options;
      if (!find || !id || failures < (fromCache ? 1 : RESCAN_AFTER_FAILURES))
        return {};
      const now = clock.now();
      const state = (): Lost => ({
        ...(firstScan !== undefined && now - firstScan >= DAY_MS
          ? { overADay: true }
          : {}),
        ...(seenHere === undefined ? {} : { seenHere }),
        ...(discoveryFailed === undefined ? {} : { discoveryFailed }),
      });
      if (now < nextScan) return state();
      firstScan ??= now;
      let at: string | undefined;
      try {
        at = (
          await discover(find, {
            clock,
            signal,
            done: (all) => all.some((f) => sameId(f.id, id)),
          })
        ).find((f) => sameId(f.id, id))?.host;
        discoveryFailed = undefined;
      } catch (error) {
        discoveryFailed = errorText(error);
      }
      if (at && at !== host) {
        const from = host;
        host = at;
        failures = 0;
        reset();
        return { moved: `moved from ${from} to ${at}` };
      }
      seenHere = discoveryFailed === undefined ? at === host : undefined;
      nextScan = now + rescanDelay(attempts);
      attempts++;
      return state();
    },
  };
}

/** A failed read's detail, saying what discovery found: never "not found" unless a scan looked and missed it. */
export function lostDetail(lost: Lost, error: unknown): string {
  const what =
    lost.discoveryFailed !== undefined
      ? `discovery failed: ${lost.discoveryFailed}`
      : lost.seenHere === true
        ? "discovery finds it at its address but reads fail"
        : lost.seenHere === false
          ? "not found by discovery"
          : "";
  const why = errorText(error);
  return [lost.overADay ? "no answer for a day" : "", what, why]
    .filter(Boolean)
    .join("; ");
}

/** Instance names from `dns-sd -B`, each once. */
export const parseBrowse = (text: string): string[] => [
  ...new Set(
    [...text.matchAll(/ Add .*?\.\s+\S+\.\s+(.+)$/gm)].map((m) => m[1]!.trim()),
  ),
];

const utf8 = new TextEncoder();

/** Undo DNS-SD text escapes, as `dns-sd` and `avahi-browse` print them: `\ ` or `\.` for the character, `\226\128\153` for each byte of a UTF-8 character. */
function unescapeDnsSd(token: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < token.length; i++) {
    const decimal = token[i] === "\\" ? token.slice(i + 1, i + 4) : "";
    if (/^\d{3}$/.test(decimal)) (bytes.push(Number(decimal)), (i += 3));
    else bytes.push(...utf8.encode(token[token[i] === "\\" ? ++i : i]!));
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/** TXT strings as a record: `key=value`, and a bare `key` or `key=` as an empty value. */
const txtRecord = (pairs: string[]) =>
  Object.fromEntries(
    pairs
      .filter((p) => p && !p.startsWith("="))
      .map((p) =>
        p.includes("=")
          ? [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]
          : [p, ""],
      ),
  );

/**
 * `avahi-browse --parsable --resolve` (Linux): each resolved instance once, IPv4 only (the config keeps IPv4 addresses).
 * A resolved line is `=;interface;IPv4;name;type;domain;hostname;address;port;"txt" "txt"`; names and TXT strings use
 * the same escapes as `dns-sd` (`\059` for a `;` in a name, `\"` inside TXT). An instance seen on two interfaces is kept
 * once, the first; loopback is skipped. Checked against avahi-utils on Debian trixie, 2026-10-16.
 */
export function parseAvahi(text: string): {
  instance: string;
  hostname: string;
  host: string;
  port: number;
  txt: Record<string, string>;
}[] {
  const seen = new Map<
    string,
    {
      instance: string;
      hostname: string;
      host: string;
      port: number;
      txt: Record<string, string>;
    }
  >();
  for (const line of text.split("\n")) {
    const f = line.split(";");
    // By the address itself: column 3 is the protocol the service was seen on, not necessarily the address's. Loopback is a service on this machine.
    if (
      f[0] !== "=" ||
      f.length < 10 ||
      !/^\d+\.\d+\.\d+\.\d+$/.test(f[7]!) ||
      f[1] === "lo" ||
      f[7]!.startsWith("127.")
    )
      continue;
    const instance = unescapeDnsSd(f[3]!);
    const port = Number(f[8]);
    if (seen.has(instance) || !f[7] || !Number.isInteger(port)) continue;
    const txt = txtRecord(
      [
        ...f
          .slice(9)
          .join(";")
          .matchAll(/"((?:\\.|[^"\\])*)"/g),
      ].map((m) => unescapeDnsSd(m[1]!)),
    );
    seen.set(instance, { instance, hostname: f[6]!, host: f[7]!, port, txt });
  }
  return [...seen.values()];
}

/** Instance names from `avahi-browse --parsable` (a `+` line per instance and interface), each once. */
export const parseAvahiBrowse = (text: string): string[] =>
  [
    ...new Set(
      text
        .split("\n")
        .flatMap((l) =>
          l.startsWith("+;") ? [unescapeDnsSd(l.split(";")[3] ?? "")] : [],
        ),
    ),
  ].filter(Boolean);

/**
 * One `dns-sd -L` answer: the host and port it can be reached at, and its TXT record. TXT values come escaped (`\ ` for
 * a space, `\226\128\153` for each byte of a UTF-8 character); these are undone, so `fn` reads as the Google Home app shows it.
 */
export function parseResolve(
  text: string,
): { hostname: string; port: number; txt: Record<string, string> } | undefined {
  const at = text.match(/can be reached at (\S+?)\.?:(\d+)/);
  if (!at) return undefined;
  const line = text.slice(at.index).split("\n")[1] ?? "";
  const tokens = (line.trim().match(/(?:\\.|[^\s\\])+/g) ?? []).map(
    unescapeDnsSd,
  );
  return { hostname: at[1]!, port: Number(at[2]), txt: txtRecord(tokens) };
}
