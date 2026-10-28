import { asOf, type Clock, realClock } from "../../clock.ts";
import { z } from "zod";
import type { Integration } from "../../home.ts";
import { type Finder, lostDetail, relocator } from "../../discover.ts";
import type { Manifest } from "../../manifest.ts";
import { poller } from "../../poll.ts";
import { daikinClient, DaikinError, type DaikinState } from "./client.ts";

export { DaikinError, type DaikinState, daikinClient, type Fan, type Mode, setFan, setMode, setPower, setTarget, type WriteRequest } from "./client.ts";

/** Poll every 120 s, as Home Assistant's daikin integration does (its coordinator's update_interval). */
export const POLL_MS = 120_000;

/** A Daikin AC in a home config: its last known address, and the MAC its UDP discovery reports, which is how it is recognised. */
export const configSchema = z.looseObject({
  connector: z.literal("daikin"),
  host: z.string().describe("the unit's last known address"),
  mac: z.string().optional().describe("the unit's MAC as its UDP discovery reports it: its identity"),
});

/** Daikin settings: its last known address, its MAC and a UDP discovery to find it again if it moves (both optional), and a `fetch`. */
export type DaikinConfig = { host: string; mac?: string; find?: Finder; fetch: typeof fetch; clock?: Clock; seen?: (host: string) => void; hostCached?: boolean }; // seen: after each good read, for an address cache; hostCached: `host` came from it

/** What the snapshot holds: the latest reading and when it was taken. */
export type DaikinSnapshot = DaikinState & { asOf: string };

/** What `daikin().client` is: the reads and writes of the unit, at wherever it is now. */
export type DaikinClient = ReturnType<typeof daikinClient>;

/**
 * One Daikin AC as a home integration: one read now, then every 120 s. Its writes are `client.write(setPower(true))`: one
 * client for the integration's life, so the writes share its lane and follow the unit when it moves.
 */
export function daikin(config: DaikinConfig): Integration<DaikinSnapshot, "daikin"> & { readonly client: DaikinClient } {
  const clock = config.clock ?? realClock;
  const where = relocator({ host: config.host, id: config.mac, find: config.find, clock, cached: config.hostCached });
  const client = daikinClient({
    ...config,
    get host() {
      return where.host();
    },
  });
  const poll = poller(clock);
  return {
    name: "daikin",
    client,
    refresh: () => (where.reset(), poll.nudge()),
    async run(signal, update) {
      let last: DaikinSnapshot | undefined;
      let moved: string | undefined; // kept in `detail` so a consumer can persist the new address
      while (!signal.aborted) {
        try {
          last = { ...(await client.read(signal)), asOf: asOf(clock) };
          where.ok();
          config.seen?.(where.host());
          update({ status: "connected", detail: moved, anomaly: last.anomaly, state: last });
        } catch (error) {
          if (signal.aborted) return; // stopped mid-read: not a failure
          // A 404 is a failed read like any other: the address may now be another device's, so discovery looks for the unit.
          const why = error instanceof DaikinError && error.status === 404 ? "no /dsiot/multireq at this address: not a dsiot Daikin" : error;
          const r = await where.failed(signal);
          if (r.moved) {
            moved = r.moved;
            continue; // read at the new address now; that read reports, with the move in `detail`
          }
          update({ status: "disconnected", detail: lostDetail(r, why), state: last });
        }
        await poll.wait(POLL_MS, signal);
      }
    },
  };
}

/** The AC in a few words: "off · cool 25 °C · room 24 °C · outdoor unit 19.5 °C". */
export function acText(s: DaikinState): string {
  const setting = [s.mode, s.targetC === undefined ? "" : `${s.targetC} °C`].filter(Boolean).join(" ");
  return [
    s.on === undefined ? "" : s.on ? "on" : "off",
    setting,
    s.roomC === undefined ? "" : `room ${s.roomC} °C`,
    s.outsideC === undefined ? "" : `outdoor unit ${s.outsideC} °C`,
  ].filter(Boolean).join(" · ");
}

export const manifest: Manifest<DaikinSnapshot> = {
  name: "daikin",
  title: "Daikin",
  iotClass: "local_polling",
  pollSeconds: POLL_MS / 1000,
  access: "local HTTP JSON (dsiot), no key",
  env: [{ name: "DAIKIN_HOST", example: "192.0.2.20", what: "the unit's address; `home probe` finds it by UDP broadcast" }],
  lines: ({ state }) => (state ? [acText(state)] : []),
};
