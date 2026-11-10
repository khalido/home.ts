import { asOf, type Clock, realClock } from "../../clock.ts";
import { errorText } from "../../connector.ts";
import { z } from "zod";
import { envName, type Integration } from "../../home.ts";
import { energyNow } from "../../energy.ts";
import { field, type Manifest } from "../../manifest.ts";
import { poller } from "../../poll.ts";
import { amberClient, AmberError, type AmberState } from "./client.ts";

export {
  AmberError,
  type AmberState,
  amberClient,
  type Interval,
  type PriceInterval,
} from "./client.ts";

/** Poll every 60 s: prices move in 5-minute intervals and the current one is revised inside it; 5 calls in 5 min, limit 50. */
export const POLL_MS = 60_000;

/** Amber in a home config: the key's env name, and the site when the account has more than one. */
export const configSchema = z.looseObject({
  connector: z.literal("amber"),
  key: envName.describe("env name holding the Amber API key"),
  siteId: z
    .string()
    .optional()
    .describe("the site; the first active one when left out"),
});

/** Amber settings for a home. `siteId` is looked up once when left out. */
export type AmberConfig = {
  key: string;
  siteId?: string;
  fetch: typeof fetch;
  clock?: Clock;
};

/** What the snapshot holds: prices now and when they were read. */
export type AmberSnapshot = AmberState & { asOf: string };

/** Amber prices as a home integration: one read now, then every 60 s. */
export function amber(
  config: AmberConfig,
): Integration<AmberSnapshot, "amber"> {
  const client = amberClient(config);
  const clock = config.clock ?? realClock;
  const poll = poller(clock);
  return {
    name: "amber",
    refresh: poll.nudge,
    async run(signal, update) {
      let siteId = config.siteId;
      let last: AmberSnapshot | undefined;
      while (!signal.aborted) {
        try {
          siteId ??= await client.siteId(signal);
          last = {
            ...(await client.prices(siteId, signal)),
            asOf: asOf(clock),
          };
          update({ status: "connected", anomaly: last.anomaly, state: last });
        } catch (error) {
          if (signal.aborted) return; // stopped mid-read: not a failure
          if (error instanceof AmberError && error.status === 401)
            return update({
              status: "unavailable",
              reason: "auth",
              detail: "Amber rejected the key",
              state: last,
            });
          update({
            status: "disconnected",
            detail: errorText(error),
            state: last,
          });
        }
        await poll.wait(POLL_MS, signal);
      }
    },
  };
}

/** Amber's prices in a few words: "buy 40.9c low (estimate) · sell 35.3c · 7% renewables", with a spike and a negative price when there is one. */
export function amberText(a: AmberState): string {
  const { negativePrice } = energyNow(undefined, a);
  return [
    `buy ${a.importCents?.toFixed(1) ?? "?"}c${a.priceDescriptor ? ` ${a.priceDescriptor}` : ""}${a.estimate ? " (estimate)" : ""}`,
    a.spike && a.spike !== "none" ? `spike ${a.spike}` : "",
    `sell ${a.exportCents?.toFixed(1) ?? "?"}c`,
    negativePrice ?? "",
    field(a.renewables, (v) => `${Math.round(v)}% renewables`),
  ]
    .filter(Boolean)
    .join(" · ");
}

export const manifest: Manifest<AmberSnapshot> = {
  name: "amber",
  title: "Amber Electric",
  iotClass: "cloud_polling",
  pollSeconds: POLL_MS / 1000,
  access: "cloud HTTPS, AMBER_KEY; 50 calls per 5 min",
  env: [
    {
      name: "AMBER_KEY",
      example: "psk_xxxxxxxx",
      what: "Amber Electric API key (app.amber.com.au/developers)",
    },
    {
      name: "AMBER_SITE_ID",
      example: "",
      optional: true,
      what: "the first active site is used when unset",
    },
  ],
  lines: ({ state }) =>
    state?.importCents === undefined ? [] : [amberText(state)],
};
