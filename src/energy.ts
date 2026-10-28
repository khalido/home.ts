import type { AmberState, PriceInterval } from "./connectors/amber/client.ts";
import type { EnphaseState } from "./connectors/enphase/client.ts";
import type { EnphaseSnapshot } from "./connectors/enphase/index.ts";

/** The home's energy right now: power from Enphase, prices from Amber, and what the grid flow costs per hour. */
export type EnergyNow = {
  solarW?: number;
  solarPeakTodayW?: number; // the highest solarW read so far today (Enphase's day, since its peakSince)
  usingW?: number;
  gridW?: number; // positive importing, negative exporting
  importCents?: number;
  exportCents?: number; // what you are paid per kWh; below zero, exporting costs you
  centsPerHour?: number; // positive costs you, negative earns you
  renewables?: number;
  priceDescriptor?: string; // Amber's descriptor for the import price ("extremelyLow" … "spike")
  spike?: string; // Amber's spikeStatus: "none" | "potential" | "spike"
  estimate?: boolean; // the current price can still move
  negativePrice?: "paid to use" | "exporting at a loss";
  flow?: "importing" | "exporting" | "balanced"; // undefined when gridW is; balanced within BALANCED_W, a display rule
  surplusW?: number; // power going out to the grid, positive: -gridW when exporting, else 0
  surplusCentsPerHour?: number; // what that export earns now at the export price (negative when exporting costs you)
};

/**
 * Within this many watts either way the grid flow reads as "balanced": a display rule for the word and the animation,
 * so a meter wobbling around zero does not flip between importing and exporting. `gridW` and `surplusW` stay as read.
 */
export const BALANCED_W = 20;

/** The grid flow in a word, from the raw `gridW`. */
function flowOf(gridW?: number): EnergyNow["flow"] {
  if (gridW === undefined) return undefined;
  return Math.abs(gridW) <= BALANCED_W ? "balanced" : gridW > 0 ? "importing" : "exporting";
}

/**
 * `"paid to use"` when the import price is below zero, else `"exporting at a loss"` when the export price is (Amber's
 * feed-in `perKwh` above zero), else undefined. Both can hold in one interval; the import side wins.
 */
function negativePrice(prices?: AmberState): EnergyNow["negativePrice"] {
  if (prices?.importCents !== undefined && prices.importCents < 0) return "paid to use";
  if (prices?.exportCents !== undefined && prices.exportCents < 0) return "exporting at a loss";
  return undefined;
}

/** One owner for the combined number, so every view (CLI, jaldi, the bot) shows the same thing. */
export function energyNow(power?: EnphaseState & Partial<Pick<EnphaseSnapshot, "productionWPeakToday">>, prices?: AmberState): EnergyNow {
  const gridW = power?.netW;
  const surplusW = gridW === undefined ? undefined : gridW < 0 ? -gridW : 0;
  const rate = gridW === undefined ? undefined : gridW >= 0 ? prices?.importCents : prices?.exportCents;
  return {
    solarW: power?.productionW,
    solarPeakTodayW: power?.productionWPeakToday,
    usingW: power?.consumptionW,
    gridW,
    importCents: prices?.importCents,
    exportCents: prices?.exportCents,
    centsPerHour: gridW === undefined || rate === undefined ? undefined : (gridW / 1000) * rate, // export: negative kW × earned c/kWh = negative cost
    renewables: prices?.renewables,
    priceDescriptor: prices?.priceDescriptor,
    spike: prices?.spike,
    estimate: prices?.estimate,
    negativePrice: negativePrice(prices),
    flow: flowOf(gridW),
    surplusW,
    surplusCentsPerHour: surplusW === undefined || prices?.exportCents === undefined ? undefined : (surplusW / 1000) * prices.exportCents,
  };
}

/**
 * How brightly to draw the panels: `solarW` as a fraction of the array's rated `capacityW` when the config has it,
 * else of today's peak so far, with which scale it is (they mean different things, so a drawing says which).
 * Never clamped: above 1 is above the scale. Undefined when there is no solar reading or nothing to scale by.
 */
export function solarLevel(now: EnergyNow, capacityW?: number): { fraction: number; scale: "capacity" | "today's peak" } | undefined {
  if (now.solarW === undefined) return undefined;
  if (capacityW !== undefined && capacityW > 0) return { fraction: now.solarW / capacityW, scale: "capacity" };
  if (now.solarPeakTodayW !== undefined && now.solarPeakTodayW > 0) return { fraction: now.solarW / now.solarPeakTodayW, scale: "today's peak" };
  return undefined;
}

/**
 * The grid flow in words every view shares: "exporting 1.2 kW, earning 42 c/h", "importing 0.8 kW, costing 33 c/h",
 * "balanced (-10 W)", or "" with no grid reading. Rounded for reading only; the numbers above stay as read.
 */
export function gridText(now: EnergyNow): string {
  const kw = (w: number) => `${(w / 1000).toFixed(1)} kW`;
  const rate = (c: number | undefined, positive: string, negative: string) => (c === undefined ? "" : `, ${c >= 0 ? positive : negative} ${Math.round(Math.abs(c))} c/h`);
  if (now.flow === "exporting" && now.surplusW !== undefined) return `exporting ${kw(now.surplusW)}${rate(now.surplusCentsPerHour, "earning", "costing")}`;
  if (now.flow === "importing" && now.gridW !== undefined) return `importing ${kw(now.gridW)}${rate(now.centsPerHour, "costing", "earning")}`;
  return now.flow === "balanced" ? `balanced (${now.gridW} W)` : "";
}

/** A run of the forecast and its time-weighted averages: import price, feed-in price and the grid's renewable share. */
export type PriceWindow = { start: string; end: string; importCents: number; exportCents?: number; renewables?: number };

const HOUR_MS = 3_600_000;

/**
 * The best `hours` to run something in, from Amber's forecast: the cheapest by import price (Amber's `perKwh`), or the
 * greenest by the grid's renewable share. The window runs over unbroken intervals that each have the number it is judged by,
 * starting no earlier than `from` (pass the clock's now; it defaults to the forecast's first interval, which began up to
 * 5 minutes ago). Prices are flat within an interval, so the best window starts or ends on an interval's edge: both are
 * tried. Averages weigh each interval by the time it covers; the earliest wins a tie. Undefined when nothing fits.
 */
export function bestWindow(forecast: PriceInterval[] | undefined, hours: number, options: { by?: "price" | "renewables"; from?: number } = {}): PriceWindow | undefined {
  if (!(hours > 0 && Number.isFinite(hours))) throw new RangeError(`bestWindow: hours must be above 0, got ${hours}`);
  const by = options.by ?? "price";
  const rows = (forecast ?? []).map((r) => ({ ...r, t0: Date.parse(r.start), t1: Date.parse(r.end) }));
  const from = options.from ?? rows[0]?.t0 ?? 0;
  const length = Math.round(hours * HOUR_MS); // whole ms, so the covered time adds up to it exactly
  const starts = [...new Set(rows.flatMap((r) => [Math.max(r.t0, from), r.t1 - length]).filter((t) => t >= from))].sort((a, b) => a - b);
  let best: PriceWindow | undefined;
  let bestScore = Infinity;
  for (const start of starts) {
    const window = windowAt(rows, start, length, by);
    const score = window && (by === "price" ? window.importCents : -window.renewables!);
    if (window && score! < bestScore) (best = window), (bestScore = score!);
  }
  return best;
}

/** The window of `length` ms from `start`, or undefined when an interval in it is missing, or lacks the number `by` needs. */
function windowAt(rows: (PriceInterval & { t0: number; t1: number })[], start: number, length: number, by: "price" | "renewables"): PriceWindow | undefined {
  const end = start + length;
  const sum = { importCents: 0, exportCents: 0, renewables: 0, exportMs: 0, renewablesMs: 0 };
  let at = start;
  for (const r of rows) {
    if (r.t1 <= at) continue;
    if (at >= end) break;
    if (r.t0 > at || r.importCents === undefined || (by === "renewables" && r.renewables === undefined)) return undefined; // a gap or a missing number
    const ms = Math.min(r.t1, end) - at;
    sum.importCents += r.importCents * ms;
    if (r.exportCents !== undefined) (sum.exportCents += r.exportCents * ms), (sum.exportMs += ms);
    if (r.renewables !== undefined) (sum.renewables += r.renewables * ms), (sum.renewablesMs += ms);
    at += ms;
  }
  if (at < end) return undefined;
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    importCents: sum.importCents / length,
    exportCents: sum.exportMs === length ? sum.exportCents / length : undefined,
    renewables: sum.renewablesMs === length ? sum.renewables / length : undefined,
  };
}
