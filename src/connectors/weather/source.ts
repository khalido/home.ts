import { ConnectorError, fetchTimeout } from "../../connector.ts";
import type { Reason } from "../../home.ts";

// The one place a weather provider plugs in: a `WeatherSource` returns slices, and `mergeWeather` picks one per slice.

/** Sent on every request, so each service can see who is calling rather than a runtime's default string. */
export const USER_AGENT = "home (+https://github.com/khalido/home.ts)";

export type Place = { latitude: number; longitude: number };

/** The one polling number for observations and sky: every 15 minutes, KO's call. Forecasts follow their issue times. */
export const DEFAULT_POLL_MINUTES = 15;
/** Reads land this far past each slot, so BOM's 10-minutely file (sent about 3 minutes past) is there: :05, :20, :35, :50. */
const SLOT_OFFSET_MS = 5 * 60_000;

/** The next read slot after `at`: every `pollMinutes` from 5 minutes past the hour when `pollMinutes` divides 60 (else from the epoch, plus 5 minutes). */
export function nextPoll(
  at: number,
  pollMinutes = DEFAULT_POLL_MINUTES,
): number {
  const step = pollMinutes * 60_000;
  return (
    Math.floor((at - SLOT_OFFSET_MS) / step) * step + step + SLOT_OFFSET_MS
  );
}

/** What a source is asked to read: where, at what instant (epoch ms), the polling interval to schedule by, and `force` to read everything now. */
export type ReadRequest = {
  place: Place;
  at: number;
  pollMinutes: number;
  force?: boolean;
  signal?: AbortSignal;
};

/** Every slice says who made it, whether it is a model rather than an instrument, the time it is for, and when it was fetched. */
export type SliceMeta = {
  source: string;
  modelled: boolean;
  at: string;
  fetchedAt: string;
};

/** Outside now. Speeds in km/h, direction where the wind comes from. */
export type WeatherNow = SliceMeta & {
  tempC?: number;
  apparentC?: number;
  humidity?: number; // percent
  windKmh?: number;
  windDir?: string; // compass point as the source gives it, e.g. "ESE"
  windDeg?: number;
  gustKmh?: number;
  rainMm?: number; // rain since 9am, over rainFrom..rainTo, which can differ from `at`
  rainFrom?: string;
  rainTo?: string;
  station?: { name: string; distanceKm: number };
};

/** One forecast day. Any field can be missing: after BOM's afternoon issue, today has no min, max or rain range. */
export type ForecastDay = {
  date: string; // local YYYY-MM-DD
  minC?: number;
  maxC?: number;
  rainChance?: number; // percent
  rainMm?: number; // a model's single amount
  rainRangeMm?: [number, number]; // a forecaster's range, e.g. "0 to 1 mm"
  text?: string;
  code?: string; // the source's own icon or condition code (BOM 1–19, WMO for Open-Meteo, a type name for Google)
};

export type WeatherForecast = SliceMeta & {
  issuedAt?: string;
  today?: ForecastDay;
  tomorrow?: ForecastDay;
};

/** Cloud, UV and sunlight on the ground. `radiationWm2` is shortwave (global horizontal) irradiance. */
export type SkyHour = {
  at: string;
  cloudPct?: number;
  uvIndex?: number;
  radiationWm2?: number;
};
export type WeatherSky = SliceMeta & Omit<SkyHour, "at"> & { hours: SkyHour[] };

/** One stretch of the minute-by-minute rain forecast. `from` and `to` are UTC ISO; `type` is the source's own (`NONE`, `RAIN`, ...). */
export type RainSegment = {
  from: string;
  to: string;
  type?: string;
  chance?: number;
  mm?: number;
  intensity?: string;
};
/** Rain minute by minute, up to `RAIN_HORIZON_MINUTES` ahead. `at` is when the forecast starts. Ask `rainSoon` what it means. */
export type WeatherRain = SliceMeta & { segments: RainSegment[] };
/** How far ahead the rain forecast is kept and read: two hours, KO's call. */
export const RAIN_HORIZON_MINUTES = 120;

/** Weather in words, mildest first, so an hour from any source reads the same and a stretch of hours takes its worst. */
export const CONDITIONS = [
  "clear",
  "partly cloudy",
  "cloudy",
  "fog",
  "drizzle",
  "showers",
  "rain",
  "snow",
  "storm",
] as const;
export type Condition = (typeof CONDITIONS)[number];

/** One forecast hour, starting at `at`. `rainChance` in percent, `rainMm` over the hour, `code` the source's own, `condition` it in a word. */
export type ForecastHour = {
  at: string;
  tempC?: number;
  apparentC?: number;
  rainChance?: number;
  rainMm?: number;
  windKmh?: number;
  gustKmh?: number;
  cloudPct?: number;
  uvIndex?: number;
  code?: string;
  condition?: Condition;
};
/** The hourly forecast for today and tomorrow, from the home's midnight. `at` is when it was read. Ask `dayBlocks` for mornings and evenings. */
export type WeatherHourly = SliceMeta & { hours: ForecastHour[] };

export type SliceName = "now" | "forecast" | "hourly" | "sky" | "rain";
export type Slices = {
  now?: WeatherNow;
  forecast?: WeatherForecast;
  hourly?: WeatherHourly;
  sky?: WeatherSky;
  rain?: WeatherRain;
};

/** One read of a source: the slices it has (last good ones included), when to call again, and anything to report. */
export type SourceReading = Slices & {
  nextAt: number; // epoch ms; the integration never calls sooner
  problem?: string; // a failed product, a missing option; the source keeps going
  anomaly?: string; // a value the source sent that could not be read as given
  stop?: string; // a terminal problem (a rejected key): the integration stops calling this source
  stopReason?: Exclude<Reason, "crashed">; // with `stop`: a person must re-key, or fix a setting (the default)
};

/**
 * A weather provider. `owns` names the slices it can fill and how old each may get (by its `at`, beyond one polling
 * interval) before the next source's is used. `read` fetches what is due and returns every slice it holds; it throws only on a bug.
 */
export type WeatherSource = {
  name: string;
  owns: Partial<Record<SliceName, number>>; // slice → ms of age allowed on top of one polling interval
  minPollMinutes?: number; // a floor under the shared interval, for a source billed per call
  read(request: ReadRequest): Promise<SourceReading>;
};

/** The interval a source actually reads at: the shared `pollMinutes`, or its own floor if that is longer. */
export const sourcePollMinutes = (source: WeatherSource, pollMinutes: number) =>
  Math.max(pollMinutes, source.minPollMinutes ?? 0);

/** Hourly: how often forecast and hourly-sky reads happen where nothing documented changes faster. */
export const HOURLY_MINUTES = 60;

/**
 * One owner for which source fills each slice, so the integration and `home status` show the same thing.
 * `readings` are in preference order; a slice older than its source's `owns` age plus one polling interval falls through.
 */
export function mergeWeather(
  readings: { source: WeatherSource; reading?: SourceReading }[],
  at: number,
  pollMinutes = DEFAULT_POLL_MINUTES,
): Slices {
  const pick = <K extends SliceName>(name: K): Slices[K] => {
    for (const { source, reading } of readings) {
      const slice = reading?.[name];
      const maxAge = source.owns[name];
      if (
        slice &&
        maxAge !== undefined &&
        at - Date.parse(slice.at) <=
          maxAge + sourcePollMinutes(source, pollMinutes) * 60_000
      )
        return slice;
    }
    return undefined;
  };
  return {
    now: pick("now"),
    forecast: pick("forecast"),
    hourly: pick("hourly"),
    sky: pick("sky"),
    rain: pick("rain"),
  };
}

/** GET a URL as text (BOM's XML), with the timeout and user agent every source sends. A non-ok status throws `ConnectorError` with it. */
export async function getText(
  fetcher: typeof fetch,
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetchTimeout(
    fetcher,
    url,
    { headers: { "user-agent": USER_AGENT } },
    { signal },
  );
  if (!res.ok)
    throw new ConnectorError(
      `HTTP ${res.status} on GET ${new URL(url).pathname}`,
      { status: res.status },
    );
  return res.text();
}

/** A number from a string the source sent, or undefined plus a note in `odd`. Never rounds or clamps. */
export function num(
  value: unknown,
  what: string,
  odd: string[],
): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(n)) return n;
  odd.push(`${what} is not a number: ${String(value)}`);
  return undefined;
}

/** A source's timestamp as UTC ISO, or undefined when it does not parse: one odd time never sinks a whole read. */
export const iso = (s: string | undefined) =>
  s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : undefined;

/** The local calendar date (YYYY-MM-DD) of an instant at a UTC offset in seconds. */
export const localDate = (at: number, offsetSeconds: number) =>
  new Date(at + offsetSeconds * 1000).toISOString().slice(0, 10);
