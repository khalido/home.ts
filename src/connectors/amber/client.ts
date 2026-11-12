import { z } from "zod";
import { ConnectorError, getJson } from "../../connector.ts";

// Amber Electric's public API v1 (https://app.amber.com.au/developers; the published spec is 1.0, there is no v2). Shapes checked against live replies,
// 2026-10-13; every field optional so a change degrades a reading rather than throwing.

/** A failed Amber call. `status` 401 or 403 (`isRejectedKey`) means the key is wrong or revoked; 429 means the rate limit (50 per 5 min). */
export class AmberError extends ConnectorError {}

/** One 5-minute price interval on one channel. Prices are c/kWh including GST, as a cost: negative feed-in means you are paid. */
export const Interval = z.looseObject({
  type: z.string(), // "ActualInterval" | "CurrentInterval" | "ForecastInterval"
  channelType: z.string(), // "general" (import) | "feedIn" (export) | "controlledLoad"
  perKwh: z.number(),
  spotPerKwh: z.number().optional(),
  renewables: z.number().optional(), // percent of the grid
  descriptor: z.string().optional(), // "extremelyLow" … "spike"
  spikeStatus: z.string().optional(), // "none" | "potential" | "spike"
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  estimate: z.boolean().optional(), // CurrentInterval: true until the interval's price is final
  duration: z.number().optional(), // minutes: 5 for the current hour, 30 further out
});
export type Interval = z.infer<typeof Interval>;

const Site = z.looseObject({
  id: z.string(),
  status: z.string().optional(),
  intervalLength: z.number().optional(),
});

/** Prices now, as a home view wants them: what a kWh costs to import and earns to export. */
export type AmberState = {
  importCents?: number; // c/kWh you pay now
  exportCents?: number; // c/kWh you are paid now (Amber's negative feed-in price, sign flipped)
  priceDescriptor?: string; // the general (import) channel's descriptor: "extremelyLow" | "veryLow" | "low" | "neutral" | "high" | "spike" ("negative" is legacy)
  exportDescriptor?: string;
  spike?: string; // Amber's own spikeStatus on the general channel: "none" | "potential" | "spike"; no threshold of ours
  renewables?: number; // percent
  estimate?: boolean; // true while the current interval's price can still move; information, not an anomaly
  nextImportCents?: number; // the next interval's forecast
  intervalEnds?: string;
  anomaly?: string; // forecast intervals left out because their times could not be read
  forecast?: PriceInterval[]; // the current interval, then Amber's forecast, as far ahead as Amber has one (about 8 hours, 2026-10-28)
};

/**
 * One interval of the forecast, both channels. `start` is the interval's own start: Amber's `startTime` is a second past
 * it (07:15:01 for 07:15–07:20), so it is taken to the minute. `exportCents` is what you are paid, as in `AmberState`.
 */
export type PriceInterval = {
  start: string;
  end: string;
  importCents?: number;
  exportCents?: number;
  renewables?: number;
  descriptor?: string;
};

/** How many intervals to ask for: more than Amber forecasts (48 half-hours), so the reply is as far as Amber has one. */
export const NEXT = 96;

/** Map `prices/current?next=…` to the state: the CurrentInterval of each channel, the next import forecast, and the forecast. */
export function toPrices(intervals: unknown): AmberState {
  const list = z.array(Interval).parse(intervals);
  const pick = (type: string, channel: string) =>
    list.find((i) => i.type === type && i.channelType === channel);
  const buy = pick("CurrentInterval", "general");
  const sell = pick("CurrentInterval", "feedIn");
  return {
    importCents: buy?.perKwh,
    exportCents: sell === undefined ? undefined : -sell.perKwh,
    priceDescriptor: buy?.descriptor,
    exportDescriptor: sell?.descriptor,
    spike: buy?.spikeStatus,
    renewables: buy?.renewables,
    estimate: buy?.estimate,
    nextImportCents: pick("ForecastInterval", "general")?.perKwh,
    intervalEnds: buy?.endTime,
    ...forecastOf(list),
  };
}

const MINUTE = 60_000;

/**
 * The current and forecast intervals, in time order, each channel's price on one row; none when Amber sent none. An interval
 * whose times do not parse is left out and counted in `anomaly`, so one odd row never fails the prices.
 */
function forecastOf(
  list: Interval[],
): Pick<AmberState, "forecast" | "anomaly"> {
  const timed = list.filter(
    (i) => i.type === "CurrentInterval" || i.type === "ForecastInterval",
  );
  const ahead = timed.filter(
    (i) =>
      Number.isFinite(Date.parse(i.startTime ?? "")) &&
      Number.isFinite(Date.parse(i.endTime ?? "")),
  );
  const odd = timed.length - ahead.length;
  const feedIn = new Map(
    ahead.filter((i) => i.channelType === "feedIn").map((i) => [i.endTime, i]),
  );
  const rows = ahead
    .filter((i) => i.channelType === "general")
    .map((i) => {
      const sell = feedIn.get(i.endTime);
      return {
        start: new Date(
          Math.floor(Date.parse(i.startTime!) / MINUTE) * MINUTE,
        ).toISOString(),
        end: new Date(Date.parse(i.endTime!)).toISOString(),
        importCents: i.perKwh,
        exportCents: sell === undefined ? undefined : -sell.perKwh,
        renewables: i.renewables,
        descriptor: i.descriptor,
      };
    })
    .sort((a, b) => a.start.localeCompare(b.start));
  return {
    forecast: rows.length ? rows : undefined,
    anomaly: odd
      ? `${odd} price row(s) left out: their start or end time could not be read`
      : undefined,
  };
}

/** A read-only client for Amber's API. The key comes in; nothing is stored. */
export function amberClient(options: { key: string; fetch: typeof fetch }) {
  const headers = {
    authorization: `Bearer ${options.key}`,
    accept: "application/json",
  };
  const get = (path: string, signal?: AbortSignal) =>
    getJson(options.fetch, `https://api.amber.com.au/v1${path}`, {
      init: { headers },
      signal,
      error: AmberError,
    });
  return {
    get,
    /** The account's active site id (the first active one). */
    async siteId(signal?: AbortSignal): Promise<string> {
      const sites = z.array(Site).parse(await get("/sites", signal));
      const site = sites.find((s) => s.status === "active") ?? sites[0];
      if (!site) throw new AmberError("no Amber site on this account");
      return site.id;
    },
    /** Prices now and the forecast for a site: one call, ~270 ms (measured with `next=1`, Bun 1.4.2). */
    async prices(siteId: string, signal?: AbortSignal): Promise<AmberState> {
      return toPrices(
        await get(`/sites/${siteId}/prices/current?next=${NEXT}`, signal),
      );
    },
  };
}
