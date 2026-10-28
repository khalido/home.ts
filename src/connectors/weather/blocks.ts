import { localDay, localHour, localTime } from "../../clock.ts";
import { field } from "../../manifest.ts";
import { CONDITIONS, type Condition, type ForecastHour, type WeatherHourly } from "./source.ts";

/** One part of a day: its name and the local hours it covers, `from` up to `to` (0–24, within one day). */
export type BlockDef = { name: string; from: number; to: number };

/** The parts of a day by default, by the local hour each starts in: KO's call. A consumer passes its own to `dayBlocks`. */
export const BLOCKS: readonly BlockDef[] = [
  { name: "morning", from: 6, to: 12 },
  { name: "afternoon", from: 12, to: 18 },
  { name: "evening", from: 18, to: 22 },
];

/**
 * One part of a day from the hourly forecast: `hours` is how many hours it summarises, fewer than its length when it is under way or
 * the source left hours out. `rainChance` is the highest hour's, `rainMm` the sum (missing if any hour lacks one), `condition` the worst hour's.
 * `late`: it starts after its part of the day does (under way, or the source began later).
 */
export type DayBlock = {
  name: string;
  date: string; // local YYYY-MM-DD
  from: string; // UTC ISO, the first hour counted
  to: string; // UTC ISO, the end of the last
  hours: number;
  late?: boolean;
  minC?: number;
  maxC?: number;
  rainChance?: number;
  rainMm?: number;
  windKmh?: number; // the highest hour's
  gustKmh?: number;
  uvIndex?: number; // the highest hour's
  condition?: Condition;
};
export type DayBlocks = { source: string; today: DayBlock[]; tomorrow: DayBlock[] };

const HOUR_MS = 3_600_000;

function summarise(block: BlockDef, date: string, hours: (ForecastHour & { t: number; hour: number })[]): DayBlock {
  const values = (k: "tempC" | "rainChance" | "windKmh" | "gustKmh" | "rainMm" | "uvIndex") => hours.map((h) => h[k]).filter((v) => v !== undefined);
  const max = (k: Parameters<typeof values>[0]) => (values(k).length ? Math.max(...values(k)) : undefined);
  const temps = values("tempC");
  const mm = values("rainMm");
  const worst = hours.map((h) => h.condition).filter((c) => c !== undefined).sort((a, b) => CONDITIONS.indexOf(b) - CONDITIONS.indexOf(a))[0];
  return {
    name: block.name,
    date,
    from: new Date(hours[0]!.t).toISOString(),
    to: new Date(hours[hours.length - 1]!.t + HOUR_MS).toISOString(),
    hours: hours.length,
    late: hours[0]!.hour > block.from || undefined,
    minC: temps.length ? Math.min(...temps) : undefined,
    maxC: temps.length ? Math.max(...temps) : undefined,
    rainChance: max("rainChance"),
    rainMm: mm.length === hours.length ? Number(mm.reduce((s, v) => s + v, 0).toFixed(2)) : undefined, // toFixed drops float noise only
    windKmh: max("windKmh"),
    gustKmh: max("gustKmh"),
    uvIndex: max("uvIndex"),
    condition: worst,
  };
}

/**
 * The rest of today and tomorrow in `blocks` (`BLOCKS` by default), from the hourly forecast, in the home's time zone (the
 * runtime's when left out). The one owner: the integration, `home weather` and a consumer with its own clock all call
 * `dayBlocks(state.hourly, now, timeZone)`. An hour counts while it has not ended; a part with no hours left is left out.
 * Throws on a block outside 0–24 or ending before it starts.
 */
export function dayBlocks(hourly: WeatherHourly | undefined, at: number, timeZone?: string, blocks: readonly BlockDef[] = BLOCKS): DayBlocks | undefined {
  checkBlocks(blocks);
  if (!hourly) return undefined;
  const hours = hourly.hours
    .map((h) => ({ ...h, t: Date.parse(h.at) }))
    .filter((h) => h.t + HOUR_MS > at)
    .map((h) => ({ ...h, date: localDay(h.t, timeZone), hour: localHour(h.t, timeZone) }));
  const cut = (date: string) =>
    blocks.flatMap((b) => {
      const inside = hours.filter((h) => h.date === date && h.hour >= b.from && h.hour < b.to);
      return inside.length ? [summarise(b, date, inside)] : [];
    });
  const today = localDay(at, timeZone);
  const [y, m, d] = today.split("-").map(Number);
  const tomorrow = new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10); // by the calendar: a day is 23 or 25 hours twice a year
  return { source: hourly.source, today: cut(today), tomorrow: cut(tomorrow) };
}

/** Throw on blocks a day cannot hold: whole hours within 0–24, each ending after it starts. */
export function checkBlocks(blocks: readonly BlockDef[]): void {
  for (const b of blocks)
    if (!(Number.isInteger(b.from) && Number.isInteger(b.to) && b.from >= 0 && b.to <= 24 && b.from < b.to))
      throw new RangeError(`day block ${b.name}: hours ${b.from}–${b.to}, want whole hours, 0 ≤ from < to ≤ 24`);
}

/** The UV index from which a block's text names it: 3, where sun protection starts to be advised (WHO's "moderate"). A display rule. */
export const UV_SHOWN = 3;

/**
 * "afternoon from 16:00 17–19 °C, showers, rain 40% 1.2 mm, wind 25 km/h gusting 40, UV 8". `from` shows when the part is
 * under way or short; UV shows from `UV_SHOWN`.
 */
export function blockText(b: DayBlock, timeZone?: string): string {
  const name = b.late ? `${b.name} from ${localTime(Date.parse(b.from), timeZone)}` : b.name;
  const temp = b.minC === undefined || b.maxC === undefined ? "" : b.minC === b.maxC ? `${b.minC} °C` : `${b.minC}–${b.maxC} °C`;
  const rain = [field(b.rainChance, (v) => `rain ${v}%`), b.rainMm ? `${b.rainChance === undefined ? "rain " : ""}${b.rainMm} mm` : ""].filter(Boolean).join(" ");
  const wind = field(b.windKmh, (v) => `wind ${v} km/h${b.gustKmh === undefined ? "" : ` gusting ${b.gustKmh}`}`);
  const uv = b.uvIndex !== undefined && b.uvIndex >= UV_SHOWN ? `UV ${b.uvIndex}` : "";
  return [`${name} ${temp}`.trim(), b.condition ?? "", rain, wind, uv].filter(Boolean).join(", ");
}
