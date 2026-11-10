import { type Clock, localTime, realClock } from "../../clock.ts";
import type { Integration, Reason, Status } from "../../home.ts";
import { field, type Manifest } from "../../manifest.ts";
import { poller } from "../../poll.ts";
import {
  type BlockDef,
  blockText,
  checkBlocks,
  type DayBlocks,
  dayBlocks,
} from "./blocks.ts";
import { openMeteo } from "./open-meteo.ts";
import { type RainSoon, rainSoon } from "./rain.ts";
import {
  DEFAULT_POLL_MINUTES,
  type ForecastDay,
  RAIN_HORIZON_MINUTES,
  type SliceName,
  type Slices,
  sourcePollMinutes,
  type SourceReading,
  mergeWeather,
  type WeatherSource,
} from "./source.ts";
import { type SunNow, sunNow } from "./sun.ts";

export {
  type Condition,
  type ForecastDay,
  type ForecastHour,
  mergeWeather,
  nextPoll,
  type Place,
  type RainSegment,
  type ReadRequest,
  type SkyHour,
  type SliceMeta,
  type Slices,
  type SourceReading,
  type WeatherForecast,
  type WeatherHourly,
  type WeatherNow,
  type WeatherRain,
  type WeatherSky,
  type WeatherSource,
} from "./source.ts";
export { type SunNext, type SunNow, sunNow } from "./sun.ts";
export { type RainSoon, rainSoon } from "./rain.ts";
export {
  type BlockDef,
  BLOCKS,
  blockText,
  type DayBlock,
  type DayBlocks,
  dayBlocks,
} from "./blocks.ts";
export { bom, type BomOptions } from "./bom.ts";
export { openMeteo, type OpenMeteoOptions } from "./open-meteo.ts";
export { google, type GoogleOptions } from "./google.ts";

/** The sun moves about a degree every four minutes; recompute it this often between source reads. */
const SUN_MS = 5 * 60_000;
/** However soon a source asks to be called again, never sooner than this. */
const MIN_POLL_MS = 60_000;

/**
 * Where the home is, and the sources in preference order: each slice comes from the first source with a fresh one.
 * The default is `[openMeteo()]`, which works anywhere with no key. In Australia put `bom({ fetch: ftpFetch(), forecastLocation })`
 * first: it needs the FTP transport, so it is opt-in. `pollMinutes` (default 15) is how often observations and sky are read;
 * forecasts follow their issue times. `timeZone` (IANA, the runtime's when left out) is where the home's day and its times are.
 * `blocks` are the parts of the day `state.blocks` is cut into (`BLOCKS` by default).
 */
export type WeatherConfig = {
  latitude: number;
  longitude: number;
  sources?: WeatherSource[];
  pollMinutes?: number;
  timeZone?: string;
  blocks?: readonly BlockDef[];
  clock?: Clock;
};

/** The weather in the snapshot: one slice each from the preferred fresh source, the sun, and how each source is doing. */
export type WeatherState = Slices & {
  sun: SunNow;
  rainSoon?: RainSoon; // recomputed at every report and every 5 minutes; a consumer with its own clock calls `rainSoon(state.rain, now)`
  blocks?: DayBlocks; // the same: `dayBlocks(state.hourly, now, state.timeZone, blocks)`
  timeZone?: string; // the config's, which the blocks and the text use
  sources: Record<
    string,
    {
      read: boolean;
      problem?: string;
      stopped?: string; // it will not be read again, and why
      reason?: Exclude<Reason, "crashed">; // with `stopped`, for code: a dead key shows here even while another source keeps the part connected
      anomaly?: string;
    }
  >;
};

const SLICE_NAMES = [
  "now",
  "forecast",
  "hourly",
  "sky",
  "rain",
] as const satisfies readonly SliceName[];

/** Outside weather as a home integration. Each source polls on its own cadence; the sun is computed, never fetched. */
export function weather(
  config: WeatherConfig,
): Integration<WeatherState, "weather"> {
  const sources = config.sources ?? [openMeteo()];
  const clock = config.clock ?? realClock;
  const pollMinutes = config.pollMinutes ?? DEFAULT_POLL_MINUTES;
  if (!(pollMinutes >= 1))
    throw new Error(
      `weather: pollMinutes must be at least 1, got ${config.pollMinutes}`,
    );
  if (config.blocks) checkBlocks(config.blocks); // a bad block fails here, not at every report
  const place = { latitude: config.latitude, longitude: config.longitude };
  const readings = new Map<string, SourceReading>();
  const fresh = new Map<string, boolean>(); // whether a source's latest read brought anything new, rather than its last good slices again
  let readAt: number | undefined; // the last read that brought something new: the part's `lastGoodAt`, so a re-report is not a read
  const polls = new Map(sources.map((s) => [s.name, poller(clock)]));
  let answer: (() => void) | undefined; // reports now: for a refresh no source will answer

  return {
    name: "weather",
    /**
     * Read every source now, whatever its schedule, forecasts included (`force`). A source with a floor (a billed one,
     * Google) is not forced, and is skipped when its last read is younger than its floor.
     */
    refresh() {
      for (const poll of polls.values()) poll.nudge();
      if (sources.every((s) => readings.get(s.name)?.stop)) answer?.(); // every source has stopped: none will read, so say so now
    },
    async run(signal, update) {
      const emit = () => {
        const at = clock.now();
        const slices = mergeWeather(
          sources.map((source) => ({
            source,
            reading: readings.get(source.name),
          })),
          at,
          pollMinutes,
        );
        const report = Object.fromEntries(
          sources.map((s) => {
            const r = readings.get(s.name);
            return [
              s.name,
              {
                read: r !== undefined,
                problem: r?.problem,
                stopped: r?.stop,
                reason: r?.stop ? (r.stopReason ?? "config") : undefined,
                anomaly: r?.anomaly,
              },
            ];
          }),
        );
        // Connected while some source's latest read brought something new; its older slices alone are a failed read, kept as state.
        const status: Status = sources.some((s) => fresh.get(s.name))
          ? "connected"
          : sources.every((s) => readings.get(s.name)?.stop)
            ? "unavailable"
            : "disconnected";
        const notes = (k: "problem" | "stopped" | "anomaly") =>
          Object.values(report)
            .map((r) => r[k])
            .filter(Boolean)
            .join("; ") || undefined;
        const detail =
          [notes("stopped"), notes("problem")].filter(Boolean).join("; ") ||
          undefined;
        const lastGoodAt =
          status === "connected" && readAt !== undefined
            ? new Date(readAt).toISOString()
            : undefined;
        update({
          status,
          // Every source has stopped: a rejected key outranks a wrong setting, since it needs a person.
          reason:
            status !== "unavailable"
              ? undefined
              : Object.values(report).some((r) => r.reason === "auth")
                ? "auth"
                : "config",
          detail,
          anomaly: notes("anomaly"),
          lastGoodAt,
          state: {
            ...slices,
            sun: sunNow(place.latitude, place.longitude, at),
            rainSoon: rainSoon(slices.rain, at),
            blocks: dayBlocks(
              slices.hourly,
              at,
              config.timeZone,
              config.blocks,
            ),
            timeZone: config.timeZone,
            sources: report,
          },
        });
      };
      const poll = async (source: WeatherSource) => {
        const floorMs = (source.minPollMinutes ?? 0) * 60_000;
        let force = false;
        while (!signal.aborted) {
          const at = clock.now();
          const reading = await source.read({
            place,
            at,
            pollMinutes: sourcePollMinutes(source, pollMinutes),
            force,
            signal,
          });
          if (signal.aborted) return; // an aborted read is not a problem to report
          readings.set(source.name, reading);
          const isFresh = SLICE_NAMES.some((k) =>
            reading[k]?.fetchedAt
              ? Date.parse(reading[k]!.fetchedAt) >= at
              : false,
          );
          fresh.set(source.name, isFresh);
          if (isFresh) readAt = Math.max(readAt ?? at, at);
          emit();
          if (reading.stop) return;
          for (;;) {
            const woken = await polls
              .get(source.name)!
              .wait(
                Math.max(reading.nextAt - clock.now(), MIN_POLL_MS),
                signal,
              );
            if (woken && clock.now() - at < floorMs) {
              emit(); // a refresh never beats a billed source's floor, but it gets an answer: what there is now
              continue;
            }
            force = woken && !floorMs;
            break;
          }
        }
      };
      answer = emit;
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

/** "20:20" in the home's time zone (the runtime's when unset), or "?". */
const hhmmIn = (iso: string | undefined, timeZone?: string) =>
  iso ? localTime(Date.parse(iso), timeZone) : "?";
const day = (d?: ForecastDay, rainLeft?: number) =>
  d
    ? [
        d.minC === undefined && d.maxC === undefined
          ? ""
          : `${d.minC ?? "?"}–${d.maxC ?? "?"} °C`,
        d.text?.replace(/\.$/, "").toLowerCase() ?? "",
        d.rainChance === undefined
          ? ""
          : rainLeft !== undefined && rainLeft < d.rainChance
            ? `${rainLeft}% chance of rain the rest of the day`
            : `${d.rainChance}% chance of rain`,
      ]
        .filter(Boolean)
        .join(" ")
    : "?";

/** The highest hourly chance left today, all 24 hours of it, when the hourly forecast is the same source and day as the forecast: sources are never mixed. */
const rainLeftToday = (
  w: Pick<Slices, "forecast" | "hourly"> & { timeZone?: string },
  at: number,
) => {
  if (!w.hourly || w.hourly.source !== w.forecast?.source) return undefined;
  const rest = dayBlocks(w.hourly, at, w.timeZone, [
    { name: "rest", from: 0, to: 24 },
  ])?.today[0];
  return rest?.date === w.forecast.today?.date ? rest?.rainChance : undefined;
};

/** "rain in 30 min, ends in 55 min, 70%, 0.8 mm, moderate (google)", "raining, ends in 25 min", or "no rain for 2 h"; nothing when the forecast covers none of the window. */
export function rainText(
  rain: Slices["rain"],
  r: RainSoon | undefined,
): string {
  if (!r || !rain) return "";
  const covered =
    r.coveredMin >= RAIN_HORIZON_MINUTES
      ? `${RAIN_HORIZON_MINUTES / 60} h`
      : `${r.coveredMin} min`;
  if (!r.wet) return `no rain for ${covered} (${rain.source})`;
  const end =
    r.endsInMin !== undefined
      ? `ends in ${r.endsInMin} min`
      : r.startsInMin === 0
        ? `still at ${covered}`
        : "";
  const parts = [
    r.startsInMin === 0 ? "raining" : `rain in ${r.startsInMin} min`,
    end,
    field(r.chance, (v) => `${v}%`),
    field(r.mm, (v) => `${v} mm`),
    r.intensity && r.intensity !== "NO_INTENSITY"
      ? r.intensity.toLowerCase()
      : "",
  ];
  return `${parts.filter(Boolean).join(", ")} (${rain.source})`;
}

/** The weather in one line, every part named by its source and time, never mixed. */
export function weatherText(
  w: Slices & { rainSoon?: RainSoon; timeZone?: string },
  sun: SunNow,
): string {
  const n = w.now;
  const hhmm = (iso?: string) => hhmmIn(iso, w.timeZone);
  const readings = n
    ? [
        field(n.tempC, (v) => `${v} °C`),
        field(n.apparentC, (v) => `feels ${v}`),
        field(n.humidity, (v) => `${v}%`),
        field(n.rainMm, (v) => `${v} mm since 9am to ${hhmm(n.rainTo)}`),
      ]
        .filter(Boolean)
        .join(", ")
    : "";
  const now = n
    ? `${n.station ? `${n.station.name} (${n.station.distanceKm.toFixed(1)} km)` : n.source} ${hhmm(n.at)}${n.modelled ? " modelled" : ""}: ${readings}`
    : "";
  const f = w.forecast;
  const forecast = f
    ? `today ${day(f.today, rainLeftToday(w, Date.parse(sun.at)))}, tomorrow ${day(f.tomorrow)} (${f.source}${f.modelled ? " modelled" : ""})`
    : "";
  const k = w.sky;
  const skyParts = k
    ? [
        field(k.cloudPct, (v) => `cloud ${v}%`),
        field(k.uvIndex, (v) => `UV ${v}`),
        field(k.radiationWm2, (v) => `${v} W/m²`),
      ]
        .filter(Boolean)
        .join(", ")
    : "";
  const sky = k ? `${skyParts} (${k.source})` : "";
  const sunText = `sun ${Math.round(sun.altitudeDeg)}°, ${sun.rising ? "rising" : "setting"}, ${sun.daylight ? `sets ${hhmm(sun.next.sunset)}` : `rises ${hhmm(sun.next.sunrise)}`}`;
  return [now, forecast, sky, rainText(w.rain, w.rainSoon), sunText]
    .filter(Boolean)
    .join(" · ");
}

/** "today: afternoon …; evening …" and the same for tomorrow, when there is an hourly forecast. */
const blockLines = (state: Pick<WeatherState, "blocks" | "timeZone">) =>
  state.blocks
    ? (["today", "tomorrow"] as const)
        .filter((d) => state.blocks![d].length)
        .map(
          (d) =>
            `${d}: ${state.blocks![d].map((b) => blockText(b, state.timeZone)).join("; ")} (${state.blocks!.source})`,
        )
    : [];

export const manifest: Manifest<WeatherState> = {
  name: "weather",
  title: "Weather",
  iotClass: "cloud_polling",
  pollSeconds: DEFAULT_POLL_MINUTES * 60,
  access:
    "BOM anonymous FTP, Open-Meteo, Google with GOOGLE_WEATHER_KEY; sun computed",
  env: [
    {
      name: "HOME_LATITUDE",
      example: "-33.8688",
      what: "the home's position for weather and the sun (this one is Sydney CBD)",
    },
    { name: "HOME_LONGITUDE", example: "151.2093", what: "" },
    {
      name: "HOME_TIMEZONE",
      example: "Australia/Sydney",
      optional: true,
      what: "the home's IANA time zone for weather times and day blocks; this machine's when unset",
    },
    {
      name: "HOME_BOM_FORECAST",
      example: "Sydney",
      optional: true,
      what: "BOM précis location by name or aac; unset, the forecast comes from Open-Meteo",
    },
    {
      name: "GOOGLE_WEATHER_KEY",
      example: "",
      optional: true,
      what: "Maps Platform key with the Weather API enabled",
    },
  ],
  lines: ({ state }) =>
    state ? [weatherText(state, state.sun), ...blockLines(state)] : [],
  record: ({ state }) =>
    state ? { ...state, line: weatherText(state, state.sun) } : {},
};
