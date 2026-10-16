import { asOf, type Clock, realClock } from "../../clock.ts";
import { z } from "zod";
import { type Finder, lostDetail, relocator } from "../../discover.ts";
import { envName, filePath, type Integration, type Part, type Status } from "../../home.ts";
import type { Manifest } from "../../manifest.ts";
import { bunPinnedFetch, hueClient } from "./client.ts";
import { hueEvents, isRejectedKey } from "./events.ts";
import type { HueEvent } from "./schemas.ts";
import { groups, type HueSnapshot, lights, reduce, snapshotFrom } from "./state.ts";

export { bunPinnedFetch, type HueClient, HueError, type HueOptions, hueClient, pair } from "./client.ts";
export type { HueEvent, Resource } from "./schemas.ts";
export { type GroupView, groups, type HueSnapshot, homeGroupedLightId, type LightView, lights, scenes } from "./state.ts";

/** A Hue bridge in a home config: what it takes to reach it. Its model and software come live into the snapshot. */
export const configSchema = z.looseObject({
  connector: z.literal("hue"),
  host: z.string().describe("the bridge's last known address"),
  bridgeId: z.string().describe("the bridge id, the CN its certificate must carry: its identity"),
  key: envName.describe("env name holding the application key from `home pair`"),
  ca: filePath.describe("Signify's root CA (PEM), relative to the config file"),
});

/**
 * Hue settings for a home. Leave out `fetch` in Bun and it pins to `ca` and `bridgeId`; in Node pass a pinned one.
 * `find` (mDNS, matched by `bridgeId`) finds the bridge again after three failed reconnects; `idleMs` is the stream's watchdog.
 */
export type HueConfig = { ip: string; bridgeId: string; key: string; ca: string; fetch?: typeof fetch; clock?: Clock; find?: Finder; idleMs?: number; seen?: (host: string) => void; hostCached?: boolean }; // seen: on each connect, for an address cache; hostCached: `ip` came from it

/**
 * Hue as a home integration: a full read on every (re)connect, then patched from the event stream; `refresh` re-reads it all.
 * A bridge that stops answering is looked for by `bridgeId` after three failed reconnects, and followed to its new address.
 */
export function hue(config: HueConfig): Integration<HueSnapshot> & { readonly client: ReturnType<typeof hueClient> } {
  let options = { ...config, fetch: config.fetch ?? bunPinnedFetch(config.bridgeId, config.ca) };
  let client = hueClient(options);
  const clock = config.clock ?? realClock;
  const where = relocator({ host: config.ip, id: config.bridgeId, find: config.find, clock, cached: config.hostCached });
  let snapshot: HueSnapshot | undefined;
  let report: ((part: Part<HueSnapshot>) => void) | undefined;
  let status: Status = "connecting";
  let running: AbortSignal | undefined;
  let buffered: HueEvent[] | undefined; // events seen while a refresh's GET is in flight, re-applied on top of it
  let moved: string | undefined; // kept in `detail` so a consumer can persist the new address
  return {
    name: "hue",
    get client() {
      return client;
    },
    /**
     * One full GET of every resource, replacing the stream-patched state; events that arrive meanwhile are re-applied on
     * top. Only while connected; a failure keeps the state and says so.
     */
    refresh() {
      where.reset(); // while it is down, the next failed reconnect looks for it at once
      // Not connected, not running, or a refresh already in flight (whose GET will cover this one): nothing to do.
      if (status !== "connected" || !report || !running || running.aborted || buffered) return;
      const signal = running;
      buffered = [];
      client.get(undefined, signal).then(
        (all) => {
          let s = snapshotFrom(all, asOf(clock));
          for (const event of buffered ?? []) s = reduce(s, event);
          buffered = undefined;
          if (signal.aborted) return;
          snapshot = s;
          report?.({ status, detail: moved, state: snapshot });
        },
        (error) => {
          buffered = undefined;
          if (!signal.aborted) report?.({ status, detail: `refresh failed: ${error}`, state: snapshot });
        },
      );
    },
    async run(signal, rawUpdate) {
      running = signal;
      report = (part) => ((status = part.status), rawUpdate(part));
      const update = report;
      while (!signal.aborted) {
        try {
          for await (const item of hueEvents({ ...options, signal })) {
            const now = asOf(clock);
            if (item.kind === "disconnected") {
              const r = await where.failed(signal);
              if (r.moved) {
                options = { ...options, ip: where.host() };
                client = hueClient(options);
                moved = r.moved;
                update({ status: "disconnected", detail: moved, state: snapshot });
                break; // connect at the new address now
              }
              update({ status: "disconnected", detail: lostDetail(r, item.error), state: snapshot });
              continue;
            }
            if (item.kind === "connected") {
              snapshot = snapshotFrom(await client.get(undefined, signal), now);
              where.ok();
              config.seen?.(options.ip);
            } else if (item.kind === "events" && snapshot) {
              for (const event of item.events) snapshot = reduce(snapshot, event);
              buffered?.push(...item.events);
              snapshot = { ...snapshot, lastEventId: item.id, asOf: now };
            }
            const anomaly = item.kind === "events" && item.skipped ? `skipped ${item.skipped} event batch(es) the schema did not recognise` : undefined;
            update({ status: "connected", detail: moved, anomaly, state: snapshot });
          }
        } catch (error) {
          if (signal.aborted) return; // stopped mid-read: not a failure
          if (isRejectedKey(error)) return update({ status: "unavailable", detail: "the bridge rejected the key; pair again", state: snapshot });
          // The full read failed after connecting: say so, wait, and start over with a fresh stream.
          update({ status: "disconnected", detail: String(error), state: snapshot });
          await clock.sleep(5000, signal);
        }
      }
    },
  };
}

/** Lights on that the bridge can reach, and each room and zone as on or off with its brightness. */
const view = (s: HueSnapshot) => ({
  lightsOn: lights(s).filter((l) => l.on && l.reachable !== false).length,
  rooms: groups(s).map(({ name, on, brightness }) => ({ name, on, brightness })),
});

export const manifest: Manifest<HueSnapshot> = {
  name: "hue",
  title: "Philips Hue",
  iotClass: "local_push",
  access: "local HTTPS, key from `home pair`",
  env: [
    { name: "HUE_BRIDGE_HOST", example: "hue-bridge.local", optional: true, what: "found by mDNS (dns-sd) when unset" },
    { name: "HUE_BRIDGE_ID", example: "0017880000000000", optional: true, what: "the certificate's CN must match it; mDNS finds it when unset" },
    { name: "HUE_APPLICATION_KEY", example: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", what: "from `home pair`" },
    { name: "HUE_CA_FILE", example: "/path/to/hue-root-ca.pem", what: "until HUE_BRIDGE_ROOT_CA ships in src/connectors/hue/" },
  ],
  files: ["ca"],
  /** "3 lights on", then "Kitchen: on · 40%" per room and zone. */
  lines({ state }) {
    if (!state) return [];
    const { lightsOn, rooms } = view(state);
    return [`${lightsOn} lights on`, ...rooms.map((r) => `${r.name}: ${r.on ? `on${r.brightness === undefined ? "" : ` · ${Math.round(r.brightness)}%`}` : "off"}`)];
  },
  record: ({ state }) => (state ? view(state) : {}),
};
