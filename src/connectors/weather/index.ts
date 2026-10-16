import { type Clock, realClock } from "../../clock.ts";
import type { Integration, Status } from "../../home.ts";
import { field, type Manifest } from "../../manifest.ts";
import { poller } from "../../poll.ts";
import { openMeteo } from "./open-meteo.ts";
import { type RainSoon, rainSoon } from "./rain.ts";
import { DEFAULT_POLL_MINUTES, type ForecastDay, RAIN_HORIZON_MINUTES, type Slices, sourcePollMinutes, type SourceReading, weatherNow, type WeatherSource } from "./source.ts";
import { type SunNow, sunNow } from "./sun.ts";

export * from "./source.ts";
export * from "./sun.ts";
export * from "./rain.ts";
export { bom, type BomOptions, distanceKm, FTP_BASE, toForecast, toNow } from "./bom.ts";
export { openMeteo, type OpenMeteoOptions } from "./open-meteo.ts";
export { google, type GoogleOptions } from "./google.ts";

/** The sun moves about a degree every four minutes; recompute it this often between source reads. */
export const SUN_MS = 5 * 60_000;
/** However soon a source asks to be called again, never sooner than this. */
export const MIN_POLL_MS = 60_000;

/**
 * Where the home is, and the sources in preference order: each slice comes from the first source with a fresh one.
 * The default is `[openMeteo()]`, which works anywhere with no key. In Australia put `bom({ fetch: ftpFetch(), forecastLocation })`
 * first: it needs the FTP transport, so it is opt-in. `pollMinutes` (default 15) is how often observations and sky are read;
 * forecasts follow their issue times.
 */
export type WeatherConfig = { latitude: number; longitude: number; sources?: WeatherSource[]; pollMinutes?: number; clock?: Clock };

/** The weather in the snapshot: one slice each from the preferred fresh source, the sun, and how each source is doing. */
export type WeatherState = Slices & {
  sun: SunNow;
  rainSoon?: RainSoon; // recomputed at every report and every 5 minutes; a consumer with its own clock calls `rainSoon(state.rain, now)`
  sources: Record<string, { read: boolean; problem?: string; stopped?: string; anomaly?: string }>;
};

/** Outside weather as a home integration. Each source polls on its own cadence; the sun is computed, never fetched. */
export function weather(config: WeatherConfig): Integration<WeatherState> {
  const sources = config.sources ?? [openMeteo()];
  const clock = config.clock ?? realClock;
  const pollMinutes = config.pollMinutes ?? DEFAULT_POLL_MINUTES;
  if (!(pollMinutes >= 1)) throw new Error(`weather: pollMinutes must be at least 1, got ${config.pollMinutes}`);
  const place = { latitude: config.latitude, longitude: config.longitude };
  const readings = new Map<string, SourceReading>();
  const polls = new Map(sources.map((s) => [s.name, poller(clock)]));
  return {
    name: "weather",
    /**
     * Read every source now, whatever its schedule, forecasts included (`force`). A source with a floor (a billed one,
     * Google) is not forced, and is skipped when its last read is younger than its floor.
     */
    refresh() {
      for (const poll of polls.values()) poll.nudge();
    },
    async run(signal, update) {
      const emit = () => {
        const at = clock.now();
        const slices = weatherNow(sources.map((source) => ({ source, reading: readings.get(source.name) })), at, pollMinutes);
        const report = Object.fromEntries(
          sources.map((s) => {
            const r = readings.get(s.name);
            return [s.name, { read: r !== undefined, problem: r?.problem, stopped: r?.stop, anomaly: r?.anomaly }];
          }),
        );
        const any = slices.now || slices.forecast || slices.sky || slices.rain;
        const status: Status = any ? "connected" : sources.every((s) => readings.get(s.name)?.stop) ? "unavailable" : "disconnected";
        const notes = (k: "problem" | "stopped" | "anomaly") => Object.values(report).map((r) => r[k]).filter(Boolean).join("; ") || undefined;
        const detail = [notes("stopped"), notes("problem")].filter(Boolean).join("; ") || undefined;
        update({ status, detail, anomaly: notes("anomaly"), state: { ...slices, sun: sunNow(place.latitude, place.longitude, at), rainSoon: rainSoon(slices.rain, at), sources: report } });
      };
      const poll = async (source: WeatherSource) => {
        const floorMs = (source.minPollMinutes ?? 0) * 60_000;
        let force = false;
        while (!signal.aborted) {
          const at = clock.now();
          const reading = await source.read({ place, at, pollMinutes: sourcePollMinutes(source, pollMinutes), force, signal });
          if (signal.aborted) return; // an aborted read is not a problem to report
          readings.set(source.name, reading);
          emit();
          if (reading.stop) return;
          for (;;) {
            const woken = await polls.get(source.name)!.wait(Math.max(reading.nextAt - clock.now(), MIN_POLL_MS), signal);
            if (woken && clock.now() - at < floorMs) continue; // a refresh never beats a billed source's floor
            force = woken && !floorMs;
            break;
          }
        }
      };
      const sun = async () => {
        while (!signal.aborted) {
          await clock.sleep(SUN_MS, signal);
          if (!signal.aborted) emit();
        }
      };
      await Promise.all([...sources.map(poll), sun()]);
    },
  };
}

/** "20:20" in the runtime's time zone, or "?". */
const hhmm = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false }) : "?");
const day = (d?: ForecastDay) =>
  d ? [d.minC === undefined && d.maxC === undefined ? "" : `${d.minC ?? "?"}–${d.maxC ?? "?"} °C`, d.text?.replace(/\.$/, "").toLowerCase() ?? "", d.rainChance === undefined ? "" : `${d.rainChance}% chance of rain`].filter(Boolean).join(" ") : "?";

/** "rain in 30 min, ends in 55 min, 70%, 0.8 mm, moderate (google)", "raining, ends in 25 min", or "no rain for 2 h"; nothing when the forecast covers none of the window. */
export function rainText(rain: Slices["rain"], r: RainSoon | undefined): string {
  if (!r || !rain) return "";
  const covered = r.coveredMin >= RAIN_HORIZON_MINUTES ? `${RAIN_HORIZON_MINUTES / 60} h` : `${r.coveredMin} min`;
  if (!r.wet) return `no rain for ${covered} (${rain.source})`;
  const end = r.endsInMin !== undefined ? `ends in ${r.endsInMin} min` : r.startsInMin === 0 ? `still at ${covered}` : "";
  const parts = [r.startsInMin === 0 ? "raining" : `rain in ${r.startsInMin} min`, end, field(r.chance, (v) => `${v}%`), field(r.mm, (v) => `${v} mm`), r.intensity && r.intensity !== "NO_INTENSITY" ? r.intensity.toLowerCase() : ""];
  return `${parts.filter(Boolean).join(", ")} (${rain.source})`;
}

/** The weather in one line, every part named by its source and time, never mixed. */
export function weatherText(w: Slices & { rainSoon?: RainSoon }, sun: SunNow): string {
  const n = w.now;
  const readings = n
    ? [
        field(n.tempC, (v) => `${v} °C`),
        field(n.apparentC, (v) => `feels ${v}`),
        field(n.humidity, (v) => `${v}%`),
        field(n.rainMm, (v) => `${v} mm since 9am to ${hhmm(n.rainTo)}`),
      ].filter(Boolean).join(", ")
    : "";
  const now = n ? `${n.station ? `${n.station.name} (${n.station.distanceKm.toFixed(1)} km)` : n.source} ${hhmm(n.at)}${n.modelled ? " modelled" : ""}: ${readings}` : "";
  const f = w.forecast;
  const forecast = f ? `today ${day(f.today)}, tomorrow ${day(f.tomorrow)} (${f.source}${f.modelled ? " modelled" : ""})` : "";
  const k = w.sky;
  const skyParts = k ? [field(k.cloudPct, (v) => `cloud ${v}%`), field(k.uvIndex, (v) => `UV ${v}`), field(k.radiationWm2, (v) => `${v} W/m²`)].filter(Boolean).join(", ") : "";
  const sky = k ? `${skyParts} (${k.source})` : "";
  const sunText = `sun ${Math.round(sun.altitudeDeg)}°, ${sun.rising ? "rising" : "setting"}, ${sun.daylight ? `sets ${hhmm(sun.next.sunset)}` : `rises ${hhmm(sun.next.sunrise)}`}`;
  return [now, forecast, sky, rainText(w.rain, w.rainSoon), sunText].filter(Boolean).join(" · ");
}

export const manifest: Manifest<WeatherState> = {
  name: "weather",
  title: "Weather",
  iotClass: "cloud_polling",
  pollSeconds: DEFAULT_POLL_MINUTES * 60,
  access: "BOM anonymous FTP, Open-Meteo, Google with GOOGLE_WEATHER_KEY; sun computed",
  env: [
    { name: "HOME_LATITUDE", example: "-33.8688", what: "the home's position for weather and the sun (this one is Sydney CBD)" },
    { name: "HOME_LONGITUDE", example: "151.2093", what: "" },
    { name: "HOME_BOM_FORECAST", example: "Sydney", optional: true, what: "BOM précis location by name or aac; unset, the forecast comes from Open-Meteo" },
    { name: "GOOGLE_WEATHER_KEY", example: "", optional: true, what: "Maps Platform key with the Weather API enabled" },
  ],
  lines: ({ state }) => (state ? [weatherText(state, state.sun)] : []),
  record: ({ state }) => (state ? { ...state, line: weatherText(state, state.sun) } : {}),
};
