import { getPosition, getTimes } from "suncalc";

const DAY_MS = 86_400_000;

/** The next of each event after `at`: today's while it is still ahead, else tomorrow's; missing when that day has none (polar). */
export type SunNext = { dawn?: string; sunrise?: string; sunset?: string; dusk?: string };

/**
 * The sun at a place and instant, computed locally (suncalc 2: degrees, azimuth clockwise from north). No network.
 * Times are ISO instants for the local solar day containing `at` (the one whose solar noon is nearest); any can be
 * missing at high latitudes when the sun never reaches that altitude.
 *
 * `sunNow(latitude, longitude, now)` is the owner. The weather snapshot holds one recomputed every 5 minutes, so its
 * position, `rising`, `daylight` and `next` can be that old; a consumer that shows them calls `sunNow` with its own clock,
 * as `home status` does.
 */
export type SunNow = {
  at: string;
  nightEnd?: string; // astronomical dawn, sun 18° below the horizon
  dawn?: string; // civil dawn, 6° below
  sunrise?: string; // missing on a polar day or night
  goldenHourEnd?: string; // morning golden hour ends, 6° above
  solarNoon: string;
  goldenHour?: string; // evening golden hour starts, 6° above
  sunset?: string;
  dusk?: string; // civil dusk, 6° below
  night?: string; // astronomical dusk, 18° below
  azimuthDeg: number; // 0 north, 90 east
  altitudeDeg: number; // refraction-corrected; negative below the horizon
  rising: boolean; // before solar noon: the sun is climbing (from solar midnight)
  daylight: boolean; // altitude above 0°
  next: SunNext;
  alwaysUp?: boolean;
  alwaysDown?: boolean;
};

const isoOf = (d: Date | null) => d?.toISOString();

/** One owner for the sun's numbers. `at` is epoch ms. */
export function sunNow(latitude: number, longitude: number, at: number): SunNow {
  const date = new Date(at);
  const times = getTimes(date, latitude, longitude);
  const tomorrow = getTimes(new Date(at + DAY_MS), latitude, longitude);
  const { azimuth, altitude } = getPosition(date, latitude, longitude);
  const next = (name: "dawn" | "sunrise" | "sunset" | "dusk") => {
    const today = times[name];
    return today && today.getTime() > at ? today.toISOString() : isoOf(tomorrow[name]);
  };
  return {
    at: date.toISOString(),
    nightEnd: isoOf(times.nightEnd),
    dawn: isoOf(times.dawn),
    sunrise: isoOf(times.sunrise),
    goldenHourEnd: isoOf(times.goldenHourEnd),
    solarNoon: times.solarNoon.toISOString(),
    goldenHour: isoOf(times.goldenHour),
    sunset: isoOf(times.sunset),
    dusk: isoOf(times.dusk),
    night: isoOf(times.night),
    azimuthDeg: azimuth,
    altitudeDeg: altitude,
    rising: at < times.solarNoon.getTime(),
    daylight: altitude > 0,
    next: { dawn: next("dawn"), sunrise: next("sunrise"), sunset: next("sunset"), dusk: next("dusk") },
    alwaysUp: times.alwaysUp,
    alwaysDown: times.alwaysDown,
  };
}

/** How far a source's sunrise or sunset may be from the computed one before it is worth saying. */
export const SUN_TOLERANCE_MS = 2 * 60_000;

/**
 * A source's sunrise and sunset checked against the computed sun, which stays the owner: a note per event more than
 * two minutes out, else undefined. Each is compared with the nearest computed event of the solar days either side of it,
 * so near solar midnight at high latitude, where the solar day containing it can be the neighbouring one, it still pairs.
 */
export function sunDisagrees(source: string, latitude: number, longitude: number, reported: { sunrise?: string; sunset?: string }): string | undefined {
  const notes = (["sunrise", "sunset"] as const).flatMap((name) => {
    const t = Date.parse(reported[name] ?? "");
    if (Number.isNaN(t)) return [];
    const nearest = [t - DAY_MS, t, t + DAY_MS]
      .map((day) => sunNow(latitude, longitude, day)[name])
      .filter((c) => c !== undefined)
      .map((c) => ({ computed: c, offMs: Math.abs(t - Date.parse(c)) }))
      .sort((a, b) => a.offMs - b.offMs)[0];
    if (nearest && nearest.offMs <= SUN_TOLERANCE_MS) return [];
    return [`${source} ${name} ${reported[name]} ${nearest ? `is ${(nearest.offMs / 60_000).toFixed(1)} min from the computed ${nearest.computed}` : "on a day the computed sun has none"}`];
  });
  return notes.length ? notes.join("; ") : undefined;
}
