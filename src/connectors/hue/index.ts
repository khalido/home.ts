import { asOf, type Clock, realClock } from "../../clock.ts";
import { errorText } from "../../connector.ts";
import { z } from "zod";
import { type Finder, lostDetail, relocator } from "../../discover.ts";
import {
  envName,
  filePath,
  type DeviceRecord,
  deviceRecords,
  type Integration,
  type Part,
  type Status,
} from "../../home.ts";
import type { Manifest } from "../../manifest.ts";
import { bunPinnedFetch, type HueClient, hueClient } from "./client.ts";
import { hueEvents, isRejectedKey } from "./events.ts";
import type { HueEvent } from "./schemas.ts";
import {
  type GroupView,
  groups,
  type HueSnapshot,
  type LightView,
  lights,
  reduce,
  snapshotFrom,
} from "./state.ts";

export { HUE_BRIDGE_ROOT_CA } from "./ca.ts";
export {
  bunPinnedFetch,
  type HueClient,
  HueError,
  type HueOptions,
  hueClient,
  pair,
  pairWhenPressed,
} from "./client.ts";
export type { HueEvent, Resource } from "./schemas.ts";
export {
  type GroupView,
  groups,
  type HueSnapshot,
  homeGroupedLightId,
  type LightView,
  lights,
  scenes,
} from "./state.ts";

/** A Hue bridge in a home config: what it takes to reach it. Its model and software come live into the snapshot. */
export const configSchema = z.looseObject({
  connector: z.literal("hue"),
  host: z.string().describe("the bridge's last known address"),
  bridgeId: z
    .string()
    .describe("the bridge id, the CN its certificate must carry: its identity"),
  key: envName.describe(
    "env name holding the application key from `home pair`",
  ),
  ca: filePath
    .optional()
    .describe(
      "a root CA (PEM) to trust instead of Signify's two, which the package carries; relative to the config file",
    ),
});

/**
 * Hue settings for a home. Leave out `fetch` in Bun and it pins to `bridgeId` and `ca` (Signify's roots, `HUE_BRIDGE_ROOT_CA`, when left out); in Node pass a pinned one.
 * `find` (mDNS, matched by `bridgeId`) finds the bridge again after three failed reconnects; `idleMs` is the stream's watchdog.
 */
export type HueConfig = {
  host: string;
  bridgeId: string;
  key: string;
  ca?: string;
  fetch?: typeof fetch;
  clock?: Clock;
  find?: Finder;
  idleMs?: number;
  seen?: (host: string) => void;
  hostCached?: boolean;
}; // seen: on each connect, for an address cache; hostCached: `host` came from it

/**
 * Hue as a home integration: a full read on every (re)connect, then patched from the event stream; `refresh` re-reads it all.
 * A bridge that stops answering is looked for by `bridgeId` after three failed reconnects, and followed to its new address.
 */
export function hue(
  config: HueConfig,
): Integration<HueSnapshot, "hue"> & { readonly client: HueClient } {
  const clock = config.clock ?? realClock;
  const where = relocator({
    host: config.host,
    id: config.bridgeId,
    find: config.find,
    clock,
    cached: config.hostCached,
  });
  // One client for the integration's life, at wherever the bridge is now: a move keeps the write lane and the writes waiting in it.
  const options = {
    ...config,
    fetch: config.fetch ?? bunPinnedFetch(config.bridgeId, config.ca),
    get host() {
      return where.host();
    },
  };
  const client = hueClient(options);
  let snapshot: HueSnapshot | undefined;
  let report: ((part: Part<HueSnapshot>) => void) | undefined;
  let status: Status = "connecting";
  let last: Part<HueSnapshot> = { status }; // the last report, said again to a refresh that cannot read
  let running: AbortSignal | undefined;
  let buffered: HueEvent[] | undefined; // events seen while a refresh's GET is in flight, re-applied on top of it
  let moved: string | undefined; // kept in `detail` so a consumer can persist the new address
  return {
    name: "hue",
    client,
    /**
     * One full GET of every resource, replacing the stream-patched state; events that arrive meanwhile are re-applied on
     * top. Only while connected; a failure keeps the state and says so.
     */
    refresh() {
      where.reset(); // while it is down, the next failed reconnect looks for it at once
      if (!report || !running || running.aborted) return; // not running: nothing will report
      // Not connected: nothing to read until the stream is back, so answer with the last report rather than leave the caller waiting out the backoff.
      if (status !== "connected") return report(last);
      if (buffered) return; // a refresh already in flight, whose GET covers this one
      const signal = running;
      buffered = [];
      client.get(undefined, signal).then(
        (all) => {
          let s = snapshotFrom(all, asOf(clock));
          for (const event of buffered ?? []) s = reduce(s, event);
          buffered = undefined;
          if (signal.aborted || status !== "connected") return; // the stream dropped meanwhile, or the key was rejected: the next connect reads it all
          snapshot = s;
          report?.({ status, detail: moved, state: snapshot });
        },
        (error) => {
          buffered = undefined;
          // Still connected (the stream is fine) but this read failed: not a good read, so the last one's time stands.
          if (!signal.aborted && status === "connected")
            report?.({
              status,
              detail: `refresh failed: ${errorText(error)}`,
              state: snapshot,
              lastGoodAt: snapshot?.asOf,
            });
        },
      );
    },
    async run(signal, rawUpdate) {
      running = signal;
      report = (part) => (
        (status = part.status),
        (last = part),
        rawUpdate(part)
      );
      const update = report;
      while (!signal.aborted) {
        try {
          for await (const item of hueEvents({ ...options, signal })) {
            const now = asOf(clock);
            if (item.kind === "disconnected") {
              const r = await where.failed(signal);
              if (r.moved) {
                moved = r.moved;
                break; // connect at the new address now; that connection reports, with the move in `detail`
              }
              update({
                status: "disconnected",
                detail: lostDetail(r, item.error),
                state: snapshot,
              });
              continue;
            }
            if (item.kind === "connected") {
              snapshot = snapshotFrom(await client.get(undefined, signal), now);
              where.ok();
              config.seen?.(options.host);
            } else if (item.kind === "events" && snapshot) {
              for (const event of item.events)
                snapshot = reduce(snapshot, event);
              buffered?.push(...item.events);
              snapshot = { ...snapshot, lastEventId: item.id, asOf: now };
            }
            const anomaly =
              item.kind === "events" && item.skipped
                ? `skipped ${item.skipped} event batch(es) the schema did not recognise`
                : undefined;
            update({
              status: "connected",
              detail: moved,
              anomaly,
              state: snapshot,
            });
          }
        } catch (error) {
          if (signal.aborted) return; // stopped mid-read: not a failure
          if (isRejectedKey(error))
            return update({
              status: "unavailable",
              reason: "auth",
              detail: "the bridge rejected the key; pair again",
              state: snapshot,
            });
          // The full read failed after connecting: say so, wait, and start over with a fresh stream.
          update({
            status: "disconnected",
            detail: errorText(error),
            state: snapshot,
          });
          await clock.sleep(5000, signal);
        }
      }
    },
  };
}

/** Lights on that the bridge can reach, and each room and zone as on or off with its brightness. */
const view = (s: HueSnapshot) => ({
  lightsOn: lights(s).filter((l) => l.on && l.reachable !== false).length,
  rooms: groups(s).map(({ name, on, brightness }) => ({
    name,
    on,
    brightness,
  })),
});

/** "Kitchen: on · 40%", "Kitchen: off", or the name alone when the bridge hasn't said. */
const onText = (v: {
  name?: string;
  id: string;
  on?: boolean;
  brightness?: number;
}) =>
  `${v.name ?? v.id}${v.on === undefined ? "" : `: ${v.on ? `on${v.brightness === undefined ? "" : ` · ${Math.round(v.brightness)}%`}` : "off"}`}`;

/** A Hue light, or a room or zone, as a home device: `detail` is its `LightView` or `GroupView`. */
export type HueHomeDevice =
  | DeviceRecord<"hue", "light", "on" | "off", LightView>
  | DeviceRecord<"hue", "group", "on" | "off", GroupView>;

/** Every light, then every room and zone. A light's `available` is its Zigbee link; a group's `members` are its lights. */
export function hueHomeDevices(
  part: Part<HueSnapshot> | undefined,
): HueHomeDevice[] {
  const s = part?.state;
  if (!s) return [];
  const on = (v: { on?: boolean }) =>
    v.on === undefined
      ? {}
      : { state: v.on ? ("on" as const) : ("off" as const) };
  return deviceRecords<HueHomeDevice>(part, [
    ...lights(s).map((l): HueHomeDevice => ({
      connector: "hue",
      id: l.id,
      name: l.name ?? l.id,
      kind: "light",
      ...(l.reachable === undefined ? {} : { available: l.reachable }),
      ...on(l),
      asOf: s.asOf,
      text: onText(l),
      detail: l,
    })),
    ...groups(s).map((g): HueHomeDevice => ({
      connector: "hue",
      id: g.id,
      name: g.name ?? g.id,
      kind: "group",
      ...on(g),
      asOf: s.asOf,
      text: onText(g),
      members: g.lightIds,
      detail: g,
    })),
  ]);
}

export const manifest: Manifest<HueSnapshot> = {
  name: "hue",
  title: "Philips Hue",
  iotClass: "local_push",
  access: "local HTTPS, key from `home pair`",
  env: [
    {
      name: "HUE_BRIDGE_HOST",
      example: "hue-bridge.local",
      optional: true,
      what: "found by mDNS (dns-sd) when unset",
    },
    {
      name: "HUE_BRIDGE_ID",
      example: "0017880000000000",
      optional: true,
      what: "the certificate's CN must match it; mDNS finds it when unset",
    },
    {
      name: "HUE_APPLICATION_KEY",
      example: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      what: "from `home pair`",
    },
    {
      name: "HUE_CA_FILE",
      example: "/path/to/hue-root-ca.pem",
      optional: true,
      what: "a root CA to trust instead of Signify's two, which the package carries",
    },
  ],
  files: ["ca"],
  /** "3 lights on", then "Kitchen: on · 40%" per room and zone. */
  lines({ state }) {
    if (!state) return [];
    const { lightsOn } = view(state);
    return [`${lightsOn} lights on`, ...groups(state).map(onText)];
  },
  record: ({ state }) => (state ? view(state) : {}),
};
