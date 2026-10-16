import { z } from "zod";
import { ConnectorError, getJson } from "../../connector.ts";

// Amber Electric's public API v1 (https://app.amber.com.au/developers; the published spec is 1.0, there is no v2). Shapes checked against live replies,
// 2026-10-13; every field optional so a change degrades a reading rather than throwing.

/** A failed Amber call. `status` 401 means the key is wrong or revoked; 429 means the rate limit (50 per 5 min). */
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
});
export type Interval = z.infer<typeof Interval>;

const Site = z.looseObject({ id: z.string(), status: z.string().optional(), intervalLength: z.number().optional() });

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
};

/** Map `prices/current?next=1` to the state: the CurrentInterval of each channel, plus the next import forecast. */
export function toPrices(intervals: unknown): AmberState {
  const list = z.array(Interval).parse(intervals);
  const pick = (type: string, channel: string) => list.find((i) => i.type === type && i.channelType === channel);
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
  };
}

/** A read-only client for Amber's API. The key comes in; nothing is stored. */
export function amberClient(options: { key: string; fetch: typeof fetch }) {
  const headers = { authorization: `Bearer ${options.key}`, accept: "application/json" };
  const get = (path: string, signal?: AbortSignal) => getJson(options.fetch, `https://api.amber.com.au/v1${path}`, { init: { headers }, signal, error: AmberError });
  return {
    get,
    /** The account's active site id (the first active one). */
    async siteId(signal?: AbortSignal): Promise<string> {
      const sites = z.array(Site).parse(await get("/sites", signal));
      const site = sites.find((s) => s.status === "active") ?? sites[0];
      if (!site) throw new AmberError("no Amber site on this account");
      return site.id;
    },
    /** Prices now for a site: one call, ~270 ms (measured, Bun 1.4.2). */
    async prices(siteId: string, signal?: AbortSignal): Promise<AmberState> {
      return toPrices(await get(`/sites/${siteId}/prices/current?next=1`, signal));
    },
  };
}
