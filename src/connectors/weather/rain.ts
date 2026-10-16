import { RAIN_HORIZON_MINUTES, type WeatherRain } from "./source.ts";

/** What the rain forecast says about the next stretch. The one owner: every consumer calls `rainSoon`. */
export type RainSoon = {
  wet: boolean; // rain somewhere in the covered part of the window
  startsInMin?: number; // 0 when it is raining now
  endsInMin?: number; // when the first wet stretch ends; missing when it runs past the window or the forecast stops while it is still wet
  chance?: number; // percent, the highest in that stretch
  mm?: number; // total over that stretch; missing if any segment lacks an amount
  intensity?: string; // the heaviest in that stretch
  type?: string; // the source's own, of the first wet segment
  coveredMin: number; // how much of the window the forecast actually covers
};

const WET = (type?: string) => type !== undefined && type !== "NONE";
/** Google's intensities, lightest first. An unknown one is noted by the source, never ranked. */
export const RAIN_INTENSITIES = ["NO_INTENSITY", "LIGHT", "MODERATE", "HEAVY"];
const minutes = (ms: number) => Math.round(ms / 60_000);

/**
 * Rain in the next `windowMin` minutes from `at` (epoch ms). A segment counts while its end is still ahead, so one that began a few minutes ago is used.
 * A segment with no `type` is unknown, not dry: it adds nothing to `coveredMin`. Returns nothing when the forecast covers none of the window.
 */
export function rainSoon(rain: WeatherRain | undefined, at: number, windowMin = RAIN_HORIZON_MINUTES): RainSoon | undefined {
  if (!rain) return undefined;
  const end = at + windowMin * 60_000;
  const segs = rain.segments
    .map((s) => ({ ...s, f: Date.parse(s.from), t: Date.parse(s.to) }))
    .filter((s) => s.t > at && s.f < end && s.type !== undefined)
    .sort((a, b) => a.f - b.f);
  const covered = segs.reduce((sum, s) => sum + Math.min(s.t, end) - Math.max(s.f, at), 0);
  if (covered <= 0) return undefined;
  const coveredMin = minutes(covered);
  const first = segs.findIndex((s) => WET(s.type));
  if (first < 0) return { wet: false, coveredMin };
  let last = first;
  while (last + 1 < segs.length && WET(segs[last + 1]!.type) && segs[last + 1]!.f <= segs[last]!.t) last++;
  const run = segs.slice(first, last + 1);
  const chances = run.map((s) => s.chance).filter((c) => c !== undefined);
  const mms = run.map((s) => s.mm);
  const heaviest = run.map((s) => s.intensity).filter((i) => i !== undefined).sort((a, b) => RAIN_INTENSITIES.indexOf(b) - RAIN_INTENSITIES.indexOf(a))[0];
  const runEnd = run[run.length - 1]!.t;
  const after = segs[last + 1]; // a known dry segment right after the run proves it ended
  return {
    wet: true,
    startsInMin: Math.max(0, minutes(run[0]!.f - at)),
    endsInMin: after && after.f <= runEnd ? minutes(runEnd - at) : undefined,
    chance: chances.length ? Math.max(...chances) : undefined,
    mm: mms.every((m) => m !== undefined) ? mms.reduce((sum, m) => sum + m!, 0) : undefined,
    intensity: heaviest,
    type: run[0]!.type,
    coveredMin,
  };
}
