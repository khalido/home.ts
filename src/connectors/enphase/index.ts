import { type Clock, localDay, realClock } from "../../clock.ts";
import { z } from "zod";
import { filePath, type Integration } from "../../home.ts";
import { type Finder, lostDetail, relocator } from "../../discover.ts";
import { kw, type Manifest } from "../../manifest.ts";
import { poller } from "../../poll.ts";
import {
  daysLeft,
  enphaseClient,
  EnphaseError,
  type EnphaseState,
  gatewayHost,
  tokenExpiry,
} from "./client.ts";

export {
  bunGatewayFetch,
  EnphaseError,
  type EnphaseOptions,
  type EnphaseState,
  enphaseClient,
  mintToken,
  tokenExpiry,
} from "./client.ts";

/** Poll every 60 s, as Home Assistant's enphase_envoy does. */
export const POLL_MS = 60_000;
/** Warn when the token has fewer days left than this (Home Assistant's threshold). */
const TOKEN_WARN_DAYS = 30;

/** An IQ Gateway in a home config: its last known address, its serial (its identity), and the owner token's file. */
export const configSchema = z.looseObject({
  connector: z.literal("enphase"),
  host: z.string().describe("the gateway's last known address"),
  serial: z
    .string()
    .optional()
    .describe(
      "the gateway's serial, as mDNS `serialnum` (and /info) report it: its identity",
    ),
  token: filePath.describe(
    "the owner token file: JSON with a `token` field (what `home enphase login` writes), or the bare token",
  ),
  marker: z
    .string()
    .startsWith("marker-")
    .optional()
    .describe(
      "the plan's marker where the solar array is drawn, on the roof outside any room",
    ),
  capacityW: z
    .number()
    .positive()
    .optional()
    .describe(
      "the array's rated size in watts, from the installer's paperwork; never guessed from the gateway",
    ),
});

/** Enphase settings: last known address, owner token, and optionally its serial and an mDNS discovery to find it again if it moves. `fetch` must accept the gateway's certificate: `bunGatewayFetch()` in Bun (see README). */
export type EnphaseConfig = {
  host: string;
  token: string;
  serial?: string;
  find?: Finder;
  fetch: typeof fetch;
  clock?: Clock;
  timeZone?: string;
  seen?: (host: string) => void;
  hostCached?: boolean;
}; // seen: after each good read, for an address cache; hostCached: `host` came from it // timeZone: where "today" starts (IANA), the runtime's by default

/** What the snapshot holds: the latest reading, when it was taken, and the token's days left. */
export type EnphaseSnapshot = EnphaseState & {
  asOf: string;
  tokenDaysLeft: number;
  todaySince?: string; // set when "today" is counted locally from the lifetime counter: it starts here, not at midnight
  productionWPeakToday?: number; // the highest productionW this integration has read today, one read a minute, since `peakSince`
  peakSince?: string; // midnight's first read, or when the integration started
};

/** The IQ Gateway as a home integration: one read now, then every 60 s. */
export function enphase(
  config: EnphaseConfig,
): Integration<EnphaseSnapshot, "enphase"> {
  const clock = config.clock ?? realClock;
  const where = relocator({
    host: gatewayHost(config.host),
    id: config.serial,
    find: config.find,
    clock,
    cached: config.hostCached,
  });
  const client = enphaseClient({
    ...config,
    get host() {
      return where.host();
    },
  });
  const poll = poller(clock);
  return {
    name: "enphase",
    refresh: () => (where.reset(), poll.nudge()),
    async run(signal, update) {
      let expiresAt: Date;
      try {
        expiresAt = tokenExpiry(config.token); // a bad token fails this integration only
      } catch {
        return update({
          status: "unavailable",
          reason: "auth",
          detail: "the token is unreadable; run `home enphase login`",
        });
      }
      let last: EnphaseSnapshot | undefined;
      let day:
        | {
            date: string;
            since: string;
            production?: number;
            consumption?: number;
            peakW?: number;
          }
        | undefined;
      let moved: string | undefined; // kept in `detail` so a consumer can persist the new address
      while (!signal.aborted) {
        const now = new Date(clock.now());
        const date = localDay(now.getTime(), config.timeZone); // the home's day, not the runtime's: a bot on a UTC box still resets at local midnight
        const tokenDaysLeft = daysLeft(expiresAt, now);
        // The one owner of the login ask: in `detail` whether the read works or not, so it shows while the gateway is unreachable too.
        const warn =
          tokenDaysLeft < 0
            ? "token expired; run `home enphase login`"
            : tokenDaysLeft < TOKEN_WARN_DAYS
              ? `token expires in ${tokenDaysLeft} days; run \`home enphase login\``
              : undefined;
        try {
          const s = await client.read(signal);
          if (day?.date !== date)
            day = {
              date,
              since: now.toISOString(),
              production: s.productionWhLifetime,
              consumption: s.consumptionWhLifetime,
            };
          if (s.productionW !== undefined)
            day.peakW = Math.max(day.peakW ?? s.productionW, s.productionW);
          const since = (lifetime?: number, start?: number) =>
            lifetime !== undefined && start !== undefined
              ? lifetime - start
              : undefined;
          last = {
            ...s,
            productionWhToday:
              s.productionWhToday ??
              since(s.productionWhLifetime, day.production),
            consumptionWhToday:
              s.consumptionWhToday ??
              since(s.consumptionWhLifetime, day.consumption),
            todaySince:
              s.productionWhToday === undefined ? day.since : undefined,
            productionWPeakToday: day.peakW,
            peakSince: day.since,
            asOf: now.toISOString(),
            tokenDaysLeft,
          };
          where.ok();
          config.seen?.(where.host());
          update({
            status: "connected",
            detail: [moved, warn].filter(Boolean).join("; ") || undefined,
            anomaly: s.anomaly,
            state: last,
          });
        } catch (error) {
          if (signal.aborted) return; // stopped mid-read: not a failure
          if (error instanceof EnphaseError && error.status === 401)
            return update({
              status: "unavailable",
              reason: "auth",
              detail:
                "the gateway rejected the token; run `home enphase login`",
              state: last,
            });
          const r = await where.failed(signal);
          if (r.moved) {
            moved = r.moved;
            continue; // read at the new address now; that read reports, with the move in `detail`
          }
          update({
            status: "disconnected",
            detail: [lostDetail(r, error), warn].filter(Boolean).join("; "),
            state: last,
          });
        }
        await poll.wait(POLL_MS, signal);
      }
    },
  };
}

/** "solar 2.1 kW, using 0.6 kW · token 300 days left". The login ask near the end is the integration's, in `detail`. */
export function enphaseText(s: EnphaseSnapshot): string {
  const solar =
    s.productionW === undefined
      ? ""
      : [
          `solar ${kw(s.productionW)}`,
          s.consumptionW === undefined ? "" : `using ${kw(s.consumptionW)}`,
        ]
          .filter(Boolean)
          .join(", ");
  const token =
    s.tokenDaysLeft === undefined ? "" : `token ${s.tokenDaysLeft} days left`;
  return [solar, token].filter(Boolean).join(" · ");
}

export const manifest: Manifest<EnphaseSnapshot> = {
  name: "enphase",
  title: "Enphase IQ Gateway",
  iotClass: "local_polling",
  pollSeconds: POLL_MS / 1000,
  access: "local HTTPS, owner token from `home enphase login`",
  env: [
    {
      name: "IQ_GATEWAY_HOST",
      example: "envoy.local",
      what: "the IQ Gateway on the LAN (a scheme is tolerated)",
    },
    {
      name: "IQ_GATEWAY_SERIAL_NUMBER",
      example: "000000000000",
      optional: true,
      what: "for `home enphase login`; from the Enphase app: System > Devices > Gateway",
    },
    {
      name: "ENPHASE_USERNAME",
      example: "you@example.com",
      optional: true,
      what: "for `home enphase login`, once a year: the Enphase account",
    },
    {
      name: "ENPHASE_PASSWORD",
      example: "xxxxxxxx",
      optional: true,
      what: "for `home enphase login`; never stored, only sent to Enphase's login service",
    },
  ],
  files: ["token"],
  lines: ({ state }) => (state ? [enphaseText(state)] : []),
};
