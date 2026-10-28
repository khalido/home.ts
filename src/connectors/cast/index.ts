import { z } from "zod";
import { asOf, type Clock, realClock } from "../../clock.ts";
import { errorText } from "../../connector.ts";
import { type Found, HOUR, lostDetail, rescanDelay } from "../../discover.ts";
import { poller } from "../../poll.ts";
import type { Integration, Part, Status } from "../../home.ts";
import type { Manifest } from "../../manifest.ts";
import { type CastChannel, type CastConnect, NS } from "./codec.ts";
import { CastPayload, KNOWN_TYPES } from "./schemas.ts";
import { type CastDevice, type CastSnapshot, castKey, connection, found, mediaApp, reduce, type Resolved } from "./state.ts";
import { type CastActions, castActions, type CastSession, type Listener, type RawPayload, type ServeClip } from "./writes.ts";

export type { CastConnect } from "./codec.ts";
export type { CastDevice, CastSnapshot, Resolved } from "./state.ts";
export type { AnnounceResult, CastActions, CastClip, ServeClip } from "./writes.ts";

/** A Cast device or speaker group in a home config. No host: a group's moves with its leader, so every address comes from discovery. */
export const configSchema = z.looseObject({
  connector: z.literal("cast"),
  name: z.string().describe("the device's or group's name in the Google Home app (mDNS fn), for display; `home discover --write` fills it and refreshes it after a rename"),
  castId: z.string().describe("the mDNS id, the stable identity; `home discover --write` fills it"),
});

/** Discovery's answers as `resolve` returns them: Cast entries only, port 8009 unless discovery said otherwise. */
export const resolvedFrom = (found: Found[]): Resolved[] =>
  found.flatMap((f) => (f.connector === "cast" ? [{ id: f.id, name: f.name ?? f.id, model: f.model, host: f.host, port: f.port ?? 8009, group: f.group ?? false }] : []));

export type CastConfig = {
  /** Every Cast device and group on the network (the CLI runs `dns-sd`). Called at start, after any drop, and on refresh while one is missing. */
  resolve: () => Promise<Resolved[]>;
  /** Opens a socket: `tlsConnect` from `@khalido/home/cast/tls`. */
  connect: CastConnect;
  /**
   * The config's entries: one discovery does not find shows as disconnected rather than not at all. With a cached
   * `host` and `port` (an address cache) an entry connects at once; discovery runs only when an entry has none, or a
   * cached address fails. A cached port other than 8009 is a group's (devices always listen on 8009).
   */
  expect?: { castId: string; name: string; host?: string; port?: number }[];
  /** Each address that connected and passed the certificate check, for an address cache; again with the device's new name when it reports a rename. `name` is the device's own, never a config's. */
  seen?: (id: string, address: { host: string; port: number; name?: string }) => void;
  clock?: Clock;
  /** Heartbeat interval; a socket silent for three of them is dropped. */
  pingMs?: number;
  /** For `announce` with a clip of bytes: `serveClip` from `@khalido/home/cast/serve`. */
  serve?: ServeClip;
};

const SENDER = "sender-0";
const RECEIVER = "receiver-0";
const MAX_BACKOFF_MS = 60_000;
/** A cached address gets this long to answer before discovery: live connects take 33–111 ms (Bun 1.4.2), a dead address hangs. */
const CACHED_CONNECT_MS = 1000;
/** A socket that has not answered its status request in this long is dropped, so the part never sits in "connecting". */
const STATUS_TIMEOUT_MS = 10_000;

/** A live socket: what a write needs, and its requests, kept so `refresh` can re-ask. */
type Session = CastSession & { ask: (namespace: string, destination: string, type: string) => void; transport?: string };

/**
 * Every Cast device and group as one integration, state only: one socket per entry, CONNECT, receiver and multizone
 * status (a group's members, a device's own name), media status from a running media app's transport, then pushed updates; a PING every 5 s.
 * A dropped socket starts one shared re-discovery (a group's leader may have changed) and reconnects with backoff at
 * whatever address discovery last gave. While anything is down or missing, discovery repeats at 1, 5 and 15 minutes, then
 * hourly, as the relocator does; never once per socket. The writes (`CastActions`) go over these same sockets.
 */
export function cast(config: CastConfig): Integration<CastSnapshot, "cast"> & CastActions {
  const clock = config.clock ?? realClock;
  const pingMs = config.pingMs ?? 5000;
  let snapshot: CastSnapshot = { devices: {}, asOf: asOf(clock) };
  let resolved = false;
  let resolveError: string | undefined;
  let lastFound: Set<string> | undefined; // the ids the last discovery that ran returned
  const anomalies = new Map<string, string>();
  const sessions = new Map<string, Session>();
  const opened = new Set<() => void>(); // woken whenever a socket opens, for a write waiting on a reconnect
  const named = new Set<string>(); // ids whose name came from the device (discovery's fn, its own multizone status), not a config
  const loops = new Map<string, Promise<void>>();
  let report: ((part: Part<CastSnapshot>) => void) | undefined;
  let running: AbortSignal | undefined;
  let discovering: Promise<void> | undefined;
  const rescan = poller(clock); // the shared re-discovery's wait; a drop or a refresh nudges it
  let attempt = 0; // re-discoveries since anything was last nudged or all up; a refresh starts it over

  const publish = () => {
    const all = Object.values(snapshot.devices);
    const down = all.filter((d) => d.status === "disconnected");
    const answered = (d: (typeof all)[number]) => d.status === "disconnected" || d.asOf !== undefined;
    const status: Status = !resolved || !all.every(answered) ? "connecting" : all.length && down.length < all.length ? "connected" : "disconnected";
    const detail = resolveError ?? (all.length ? (down.length ? `${down.map((d) => d.name).join(", ")} disconnected` : undefined) : "no Cast devices found");
    const anomaly = anomalies.size ? [...anomalies].map(([id, a]) => `${snapshot.devices[id]?.name ?? id}: ${a}`).join("; ") : undefined;
    report?.({ status, detail, anomaly, state: snapshot });
  };

  /** One discovery at a time; each found entry not yet running gets its loop, each expected one not found shows as missing. */
  const discover = () =>
    (discovering ??= (async () => {
      try {
        const all = await config.resolve();
        snapshot = found(snapshot, all, asOf(clock));
        for (const r of all) named.add(castKey(r.id));
        lastFound = new Set(all.map((r) => castKey(r.id)));
        resolveError = undefined;
      } catch (error) {
        resolveError = `discovery failed: ${errorText(error)}`;
      }
      resolved = true;
      const missing = (config.expect ?? []).filter((e) => !snapshot.devices[castKey(e.castId)]);
      if (missing.length) {
        const placeholders = missing.map((e) => [castKey(e.castId), { id: castKey(e.castId), name: e.name, kind: "device" as const, status: "disconnected" as const, detail: "not found by discovery" }]);
        snapshot = { ...snapshot, devices: { ...snapshot.devices, ...Object.fromEntries(placeholders) } };
      }
      for (const d of Object.values(snapshot.devices)) if (d.host && !loops.has(d.id) && running) loops.set(d.id, keep(d.id, running));
      publish();
    })().finally(() => (discovering = undefined)));

  /** The socket's certificate must name this device, or for a group a known device, its leader. Returns the leader. */
  const checkPeer = (id: string, peer?: string): string | undefined => {
    const d = snapshot.devices[id]!;
    if (!peer) throw new Error("the socket has no certificate name");
    if (d.kind === "device") {
      if (castKey(peer) !== id) throw new Error("the certificate names another device; the address has moved");
      return undefined;
    }
    const leader = snapshot.devices[castKey(peer)];
    if (leader?.kind !== "device") throw new Error("the certificate names no known Cast device");
    return leader.id;
  };

  /** Whether anything is missing or down, so the shared re-discovery keeps going. */
  const needed = () => !Object.keys(snapshot.devices).length || Object.values(snapshot.devices).some((d) => d.status === "disconnected");

  /** The one re-discovery loop: at once when nudged by a drop or a refresh, then at the relocator's cadence while anything stays down. */
  async function rediscover(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const nudged = await rescan.wait(needed() ? rescanDelay(attempt) : HOUR, signal);
      if (signal.aborted) return;
      if (!needed()) {
        attempt = 0;
        continue;
      }
      if (!nudged) attempt++;
      await discover();
    }
  }

  /** One socket's life: open, check, ask, then apply what arrives until it closes. Throws why it ended; `up` says whether it got as far as connected. */
  async function session(id: string, signal: AbortSignal, up: { connected: boolean; rediscovered?: boolean }, timeoutMs?: number): Promise<never> {
    const d = snapshot.devices[id]!;
    const channel: CastChannel = await config.connect({ host: d.host!, port: d.port!, signal, timeoutMs });
    const stop = new AbortController();
    let requestId = 0;
    const send = (namespace: string, destination: string, payload: object) => channel.send({ source: SENDER, destination, namespace, payload: JSON.stringify(payload) });
    let closed = false;
    const end = () => closed || ((closed = true), channel.close()); // abort and the finally both end it: close once
    const leave = () => closed || (send(NS.connection, RECEIVER, { type: "CLOSE" }), end());
    signal.addEventListener("abort", leave, { once: true });
    const listeners = new Set<Listener>();
    const joined = new Set<string>(); // transports CONNECTed on this socket
    const s: Session = {
      host: d.host!,
      port: d.port!,
      send,
      nextId: () => ++requestId,
      listen: (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
      connect: (transport) => void (joined.has(transport) || (joined.add(transport), send(NS.connection, transport, { type: "CONNECT" }))),
      end: (why) => ((ended = why), (up.rediscovered = true), end()),
      ask: (namespace, destination, type) => send(namespace, destination, { type, requestId: ++requestId }),
    };
    let heard = clock.now();
    let ended: string | undefined; // why we closed it, if we did
    let answered = false;
    try {
      const leader = checkPeer(id, channel.peer);
      send(NS.connection, RECEIVER, { type: "CONNECT" });
      s.ask(NS.receiver, RECEIVER, "GET_STATUS");
      s.ask(NS.multizone, RECEIVER, "GET_STATUS"); // a group's members; a device's own current name
      sessions.set(id, s);
      for (const wake of [...opened]) wake();
      up.connected = true;
      snapshot = connection(snapshot, id, { status: "connected", leader }, asOf(clock));
      config.seen?.(id, { host: d.host!, port: d.port!, name: named.has(id) ? d.name : undefined }); // a config's name never reaches the cache
      publish();
      void (async () => {
        while (!stop.signal.aborted) {
          await clock.sleep(pingMs, stop.signal);
          if (stop.signal.aborted) return;
          if (clock.now() - heard > 3 * pingMs) return (ended = `silent for ${(3 * pingMs) / 1000} s`), end();
          send(NS.heartbeat, RECEIVER, { type: "PING" });
        }
      })();
      void clock.sleep(STATUS_TIMEOUT_MS, stop.signal).then(() => {
        if (!stop.signal.aborted && !answered) (ended = `no status in ${STATUS_TIMEOUT_MS / 1000} s`), end();
      });
      for await (const m of channel.messages) {
        heard = clock.now();
        let raw: RawPayload | undefined;
        try {
          raw = JSON.parse(m.payload ?? "");
        } catch {
          continue;
        }
        if (typeof raw !== "object" || raw === null) continue;
        for (const listener of [...listeners]) listener(raw); // a write's replies, refusals included, before the reducer's filter
        if (m.namespace === NS.heartbeat && raw?.type === "PING") send(NS.heartbeat, m.source, { type: "PONG" });
        if (m.namespace === NS.connection && raw?.type === "CLOSE" && m.source === RECEIVER) break;
        if (typeof raw?.type !== "string" || !KNOWN_TYPES.has(raw.type)) continue;
        const parsed = CastPayload.safeParse(raw);
        if (!parsed.success) {
          anomalies.set(id, `a ${raw.type} the schema did not recognise`);
          publish();
          continue;
        }
        const p = parsed.data;
        if (p.type === "RECEIVER_STATUS") {
          answered = true;
          const app = p.status?.applications?.[0];
          const transport = mediaApp(app) ? app!.transportId : undefined;
          if (transport && transport !== s.transport) {
            s.connect(transport);
            s.ask(NS.media, transport, "GET_STATUS");
          }
          s.transport = transport;
        }
        const name = snapshot.devices[id]?.name;
        snapshot = reduce(snapshot, id, p, asOf(clock));
        const renamed = snapshot.devices[id]?.name;
        if (p.type === "MULTIZONE_STATUS" && renamed !== undefined && renamed !== name) (named.add(id), config.seen?.(id, { host: d.host!, port: d.port!, name: renamed }));
        publish();
      }
      throw new Error(ended ?? "the device closed the socket");
    } finally {
      stop.abort();
      for (const listener of [...listeners]) listener(undefined);
      sessions.delete(id);
      signal.removeEventListener("abort", leave);
      end();
    }
  }

  /** Keep one entry connected until `signal` aborts: a drop nudges the shared re-discovery, then it reconnects with backoff. */
  async function keep(id: string, signal: AbortSignal, cached = false): Promise<void> {
    for (let backoff = 1000; !signal.aborted; backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)) {
      const began = clock.now();
      const up: { connected: boolean; rediscovered?: boolean } = { connected: false };
      try {
        await session(id, signal, up, cached ? CACHED_CONNECT_MS : undefined);
      } catch (error) {
        if (signal.aborted) return;
        if (cached) {
          // A cached address that fails is only stale: discover now and try where it answers, still "connecting".
          cached = false;
          await discover();
          continue;
        }
        const why = errorText(error);
        // A cached address the last discovery did not find says so, as a polling connector's does.
        snapshot = connection(snapshot, id, { status: "disconnected", detail: lostDetail(lastFound && !lastFound.has(id) ? { seenHere: false } : {}, why) }, asOf(clock));
        publish();
        if (up.connected && !up.rediscovered) rescan.nudge(); // a drop, not a failed retry: look once now; retries wait for the cadence. A write that closed it has just discovered.
      }
      if (clock.now() - began > MAX_BACKOFF_MS) backoff = 1000; // it had been up a while: start the backoff over
      await clock.sleep(backoff, signal);
    }
  }

  /** The entry's socket once it is open at the address the snapshot now holds, within `ms`. */
  async function connected(id: string, ms: number): Promise<CastSession> {
    const start = clock.now();
    for (;;) {
      const d = snapshot.devices[id];
      const s = sessions.get(id);
      if (s && d && s.host === d.host && s.port === d.port) return s;
      const left = start + ms - clock.now();
      if (left <= 0) throw new Error(`${d?.name ?? id} did not connect in ${ms / 1000} s`);
      const woken = new AbortController();
      const wake = () => woken.abort();
      opened.add(wake);
      await clock.sleep(left, woken.signal);
      opened.delete(wake);
    }
  }

  return {
    ...castActions({ clock, devices: () => snapshot.devices, session: (id) => sessions.get(id), discover, connected, serve: config.serve }),
    name: "cast",
    /** Re-ask every open socket for its status; while an entry is missing or down, discover again too. */
    refresh() {
      for (const s of sessions.values()) {
        s.ask(NS.receiver, RECEIVER, "GET_STATUS");
        s.ask(NS.multizone, RECEIVER, "GET_STATUS");
        if (s.transport) s.ask(NS.media, s.transport, "GET_STATUS");
      }
      attempt = 0; // as the relocator's reset: the cadence starts over
      rescan.nudge(); // discovers if anything is missing or down, even with nothing found yet
    },
    async run(signal, update) {
      report = update;
      running = signal;
      const expect = config.expect ?? [];
      const cached = expect.filter((e) => e.host !== undefined && e.port !== undefined);
      snapshot = found(snapshot, cached.map((e) => ({ id: e.castId, name: e.name, host: e.host!, port: e.port!, group: e.port !== 8009 })), asOf(clock));
      for (const d of Object.values(snapshot.devices)) loops.set(d.id, keep(d.id, signal, true));
      if (expect.length && cached.length === expect.length) resolved = true;
      else await discover();
      publish();
      const rediscovery = rediscover(signal);
      await new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })));
      await Promise.all([rediscovery, ...loops.values()]);
    },
  };
}

/** One Cast device or group in a few words: "Nest Hub: idle · 47%", "Group: idle · 43% · 3 members: A, B, C, led by A". */
export function castText(d: CastDevice, s: CastSnapshot): string {
  const name = (id?: string) => (id && s.devices[id]?.name) || id;
  if (d.status !== "connected") return `${d.name}: ${d.status}${d.detail ? ` (${d.detail})` : ""}`;
  const media = d.playerState && `${d.playerState.toLowerCase()}${d.title ? ` "${d.title}"` : ""}${d.artist ? ` by ${d.artist}` : ""}${d.playingVia ? ` via ${name(d.playingVia)}` : ""}`;
  const parts = [
    d.standby ? "standby" : d.idle ? "idle" : (d.app ?? ""),
    media ?? "",
    d.muted ? "muted" : d.volumeControl === "fixed" ? "fixed volume" : d.volume === undefined ? "" : `${Math.round(d.volume * 100)}%`,
    d.kind === "group" ? `${d.members?.length ?? "?"} members${d.members?.length ? `: ${d.members.map(name).join(", ")}` : ""}${d.leader ? `, led by ${name(d.leader)}` : ""}` : "",
  ];
  return `${d.name}: ${parts.filter(Boolean).join(" · ")}`;
}

/** Devices first, then groups, each by name. */
export const castDevices = (s: CastSnapshot) => Object.values(s.devices).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

/** How many entries have an address, and one line per device and group. */
const castView = (s: CastSnapshot) => ({ found: Object.values(s.devices).filter((d) => d.host).length, lines: castDevices(s).map((d) => castText(d, s)) });

export const manifest: Manifest<CastSnapshot> = {
  name: "cast",
  title: "Google Cast",
  iotClass: "local_push",
  access: "local CastV2 over TLS, no key; certificates self-signed, their names checked",
  env: [],
  lines({ state }) {
    if (!state) return [];
    const { found, lines } = castView(state);
    return [`${found} found`, ...lines];
  },
  record: ({ state }) => (state ? { ...castView(state), devices: state.devices } : {}),
};
