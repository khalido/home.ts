import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { createSocket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { printersFound } from "./connectors/printers/found.ts";
import {
  type AddressCache,
  type CachedAddress,
  type Connector,
  type Finder,
  type Found,
  parseAvahi,
  parseAvahiBrowse,
  parseBrowse,
  parseResolve,
} from "./discover.ts";

// Each connector's discovery on the network: mDNS through the system's own daemon (macOS `dns-sd`, Linux `avahi-browse`),
// and Daikin's UDP broadcast. Node APIs (child_process, dgram, dns), so this file sits outside the runtime-neutral build like
// weather/ftp.ts and cast/tls.ts; `home`, jaldi's sidecar and chota-bot import it from `@khalido/home/finders` and pass `FINDERS`
// to `loadHome`. Runs in Bun and Node. The system daemon keeps an mDNS cache, so answers come from memory in milliseconds and
// nothing here binds UDP 5353 beside it; a slow device (the Enphase gateway took 4 s to answer a fresh query; Bun 1.4.3, 2026-10-16)
// does not slow a scan. Without the tool the mDNS finders throw, naming it, rather than "nothing answered".
// `fileCache` keeps the addresses discovery found in a file between runs, so the next run connects straight away.

/**
 * Run a long-lived `dns-sd` query (or `avahi-browse`, by `command`) and return what it printed. It never exits by itself, so it is stopped once `done`
 * says the answer is in, or `quietMs` after the last output, or at `maxMs`. The system's mDNS cache usually answers in
 * 4–13 ms (Bun 1.4.2, measured 2026-10-13), so the wait is for a cold cache only. A missing binary rejects, naming it.
 * `command` is for tests.
 */
export function dnsSd(
  argv: string[],
  options: {
    maxMs?: number;
    quietMs?: number;
    done?: (out: string) => boolean;
    command?: string;
    install?: string;
  } = {},
): Promise<string> {
  const { maxMs = 1500, quietMs, done, command = "dns-sd", install } = options;
  return new Promise((resolve, reject) => {
    let out = "";
    const proc = spawn(command, argv, { stdio: ["ignore", "pipe", "ignore"] });
    const stop = () => proc.kill();
    const timer = setTimeout(stop, maxMs);
    let quiet: ReturnType<typeof setTimeout> | undefined;
    proc.stdout.setEncoding("utf8").on("data", (d: string) => {
      out += d;
      if (done?.(out)) return stop();
      if (quietMs !== undefined)
        (clearTimeout(quiet), (quiet = setTimeout(stop, quietMs)));
    });
    const finish = () => (
      clearTimeout(timer),
      clearTimeout(quiet),
      resolve(out)
    );
    proc.on("error", (error: NodeJS.ErrnoException) => {
      (clearTimeout(timer), clearTimeout(quiet));
      reject(
        new Error(
          error.code === "ENOENT"
            ? `${command} not found; mDNS discovery needs it${install ? ` (${install})` : ""}`
            : `${command}: ${error.message}`,
        ),
      );
    });
    proc.on("close", finish);
  });
}

/** Linux asks avahi-daemon, which Raspberry Pi OS runs by default; its command-line tool is a separate package. */
const LINUX = process.platform === "linux";
/** `avahi-browse` prints what avahi-daemon's cache holds, resolves it, and exits (`--terminate`); `maxMs` caps a slow resolve. */
const avahi = (args: string[]) =>
  dnsSd(["--parsable", "--terminate", ...args], {
    command: "avahi-browse",
    install: "apt install avahi-utils",
    maxMs: 3000,
  });

/** Instance names of one mDNS service type: what has answered, once answers stop for 200 ms. */
export const browse = async (type: string) =>
  LINUX
    ? parseAvahiBrowse(await avahi([type]))
    : parseBrowse(await dnsSd(["-B", type], { quietMs: 200 }));

/** A resolve is in once its TXT line (the line after "can be reached at") is complete. */
const resolved = (out: string) =>
  /can be reached at [^\n]*\n[^\n]*\n/.test(out);

/** Every instance of one mDNS type, resolved to an IPv4 address (the config keeps addresses, not names), its port and its TXT record. */
export async function mdnsResolve(type: string) {
  if (LINUX) return parseAvahi(await avahi(["--resolve", type]));
  const found = await Promise.all(
    (await browse(type)).map(async (name) => {
      const r = parseResolve(
        await dnsSd(["-L", name, type], { done: resolved }),
      );
      const host = r
        ? await lookup(r.hostname, { family: 4 }).then(
            (x) => x.address,
            () => undefined,
          )
        : undefined;
      return r && host ? [{ ...r, host, instance: name }] : [];
    }),
  );
  return found.flat();
}

/** Every device of one mDNS type with its identity from a TXT key, named by its mDNS instance. */
const mdnsFind = async (
  type: string,
  txtKey: string,
  connector: Connector,
): Promise<Found[]> =>
  (await mdnsResolve(type)).flatMap((r) =>
    r.txt[txtKey]
      ? [{ connector, id: r.txt[txtKey]!, host: r.host, name: r.instance }]
      : [],
  );

/** Daikin's `key=value,key=value` answers, percent-decoded. */
export const daikinFields = (text: string) =>
  Object.fromEntries(
    text
      .trim()
      .split(",")
      .map((kv) => kv.split("="))
      .map(([k, v = ""]) => [k, decoded(v)]),
  );

/** A percent-encoded value, or as sent when it is not valid encoding (a stray "%"): one odd field never fails the read. */
function decoded(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** Broadcast pydaikin's discovery packet (UDP 30000 → 30050) and collect who answers within `ms`. */
export function findDaikins(
  ms = 1500,
): Promise<{ ip: string; fields: Record<string, string> }[]> {
  return new Promise((resolve) => {
    const found: { ip: string; fields: Record<string, string> }[] = [];
    const sock = createSocket({ type: "udp4", reuseAddr: true });
    sock.on("message", (msg, from) =>
      found.push({ ip: from.address, fields: daikinFields(msg.toString()) }),
    );
    sock.on("error", () => (sock.close(), resolve(found)));
    sock.bind(30000, () => {
      sock.setBroadcast(true);
      sock.send("DAIKIN_UDP/common/basic_info", 30050, "255.255.255.255");
      setTimeout(() => (sock.close(), resolve(found)), ms);
    });
  });
}

/** A Daikin's broadcast answer as a found device, by its MAC. */
export const daikinFound = (d: {
  ip: string;
  fields: Record<string, string>;
}): Found[] =>
  d.fields.mac
    ? [
        {
          connector: "daikin",
          id: d.fields.mac,
          host: d.ip,
          name: d.fields.name,
        },
      ]
    : [];

/** Each connector's discovery, as `loadHome` (rescans, and every Cast address) and `home discover` use it. */
export const FINDERS: Record<Connector, Finder> = {
  hue: () => mdnsFind("_hue._tcp", "bridgeid", "hue"),
  enphase: () => mdnsFind("_enphase-envoy._tcp", "serialnum", "enphase"),
  daikin: async () => (await findDaikins()).flatMap(daikinFound),
  cast: async () =>
    (await mdnsResolve("_googlecast._tcp")).flatMap(({ txt, host, port }) =>
      txt.id
        ? [
            {
              connector: "cast" as const,
              id: txt.id,
              host,
              port,
              name: txt.fn,
              model: txt.md,
              group: txt.md === "Google Cast Group",
            },
          ]
        : [],
    ),
  printers: async () => {
    const [ipp, ipps] = await Promise.all([
      mdnsResolve("_ipp._tcp"),
      mdnsResolve("_ipps._tcp"),
    ]);
    return printersFound(ipp, ipps);
  },
};

/**
 * An address cache in one JSON file, owner-only (0600, its folder 0700), replaced atomically on each write. A missing
 * file is an empty cache; so is a file that does not parse, which the next write replaces (a cache, not KO's data).
 */
export function fileCache(path: string): AddressCache {
  return {
    read(): Record<string, CachedAddress> {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, CachedAddress>)
          : {};
      } catch {
        return {};
      }
    },
    write: (entries) =>
      writePrivate(path, `${JSON.stringify(entries, null, 2)}\n`),
  };
}

/** Write a file only its owner can read (0600, its folder 0700), replaced atomically: the address cache, the Enphase token. */
export function writePrivate(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true }); // so the mode applies to a fresh file
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
