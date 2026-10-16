import { z } from "zod";
import { type ConnectorError, getJson } from "../../connector.ts";
import { RAIN_INTENSITIES } from "./rain.ts";
import { sunDisagrees } from "./sun.ts";
import { type ForecastDay, HOURLY_MINUTES, iso, nextPoll, num, type Place, RAIN_HORIZON_MINUTES, type SourceReading, USER_AGENT, type WeatherRain, type WeatherSource } from "./source.ts";

// Google's Weather API (Maps Platform, https://developers.google.com/maps/documentation/weather): needs a key with
// billing. Built from the docs' example responses, checked live against Sydney on 2026-10-13. Every slice is a model.
export const BASE = "https://weather.googleapis.com/v1";

const Temp = z.looseObject({ degrees: z.number().optional(), unit: z.string().optional() }).optional();
const Speed = z.looseObject({ value: z.number().optional(), unit: z.string().optional() }).optional();
const Condition = z.looseObject({ description: z.looseObject({ text: z.string().optional() }).optional(), type: z.string().optional() }).optional();
const Precipitation = z
  .looseObject({
    probability: z.looseObject({ percent: z.number().optional() }).optional(),
    qpf: z.looseObject({ quantity: z.number().optional(), unit: z.string().optional() }).optional(),
  })
  .optional();
const Interval = z.looseObject({ startTime: z.string().optional(), endTime: z.string().optional() }).optional();

const Current = z.looseObject({
  currentTime: z.string().optional(),
  weatherCondition: Condition,
  temperature: Temp,
  feelsLikeTemperature: Temp,
  relativeHumidity: z.number().optional(),
  uvIndex: z.number().optional(),
  cloudCover: z.number().optional(),
  wind: z
    .looseObject({ direction: z.looseObject({ degrees: z.number().optional(), cardinal: z.string().optional() }).optional(), speed: Speed, gust: Speed })
    .optional(),
});
const Half = z.looseObject({ weatherCondition: Condition, precipitation: Precipitation }).optional();
const Days = z.looseObject({
  forecastDays: z
    .array(
      z.looseObject({
        interval: Interval,
        displayDate: z.looseObject({ year: z.number(), month: z.number(), day: z.number() }).optional(),
        daytimeForecast: Half,
        nighttimeForecast: Half,
        maxTemperature: Temp,
        minTemperature: Temp,
        sunEvents: z.looseObject({ sunriseTime: z.string().optional(), sunsetTime: z.string().optional() }).optional(),
      }),
    )
    .optional(),
});
const Hours = z.looseObject({
  forecastHours: z.array(z.looseObject({ interval: Interval, uvIndex: z.number().optional(), cloudCover: z.number().optional() })).optional(),
});

const Minutes = z.looseObject({
  overallPredictionTimeframe: Interval,
  segments: z
    .array(
      z.looseObject({
        timeFrame: Interval,
        type: z.string().optional(),
        probability: z.number().optional(),
        qpf: z.looseObject({ quantity: z.number().optional(), unit: z.string().optional() }).optional(),
        intensity: z.string().optional(),
      }),
    )
    .optional(),
});

/** Celsius, or undefined plus a note: the requests ask for METRIC, so another unit is a surprise worth seeing. */
const celsius = (t: z.infer<typeof Temp>, what: string, odd: string[]) => {
  if (t?.unit && t.unit !== "CELSIUS") odd.push(`${what} in ${t.unit}`);
  return t?.unit === "CELSIUS" || t?.unit === undefined ? num(t?.degrees, what, odd) : undefined;
};
const kmh = (s: z.infer<typeof Speed>, what: string, odd: string[]) => {
  if (s?.unit && s.unit !== "KILOMETERS_PER_HOUR") odd.push(`${what} in ${s.unit}`);
  return s?.unit === "KILOMETERS_PER_HOUR" || s?.unit === undefined ? num(s?.value, what, odd) : undefined;
};
const contains = (i: z.infer<typeof Interval>, at: number) => Date.parse(i?.startTime ?? "") <= at && at < Date.parse(i?.endTime ?? "");

/**
 * Map the three responses to slices. A day's rain chance is the higher of its day and night halves; its amount is their sum.
 * With `place`, each day's `sunEvents` are checked against the computed sun (the owner); one more than 2 minutes out is an anomaly.
 */
export function toSlices(current: unknown, days: unknown, hours: unknown, fetchedAt: number, forecastAt = fetchedAt, place?: Place): Omit<SourceReading, "nextAt"> {
  const odd: string[] = [];
  const c = Current.parse(current);
  const meta = (at: string) => ({ source: "google", modelled: true, at, fetchedAt: new Date(fetchedAt).toISOString() });
  const at = iso(c.currentTime);
  if (c.currentTime !== undefined && !at) odd.push(`currentTime not understood: ${c.currentTime}`);
  const now = at
    ? {
        ...meta(at),
        tempC: celsius(c.temperature, "temperature", odd),
        apparentC: celsius(c.feelsLikeTemperature, "feels like", odd),
        humidity: c.relativeHumidity,
        windKmh: kmh(c.wind?.speed, "wind", odd),
        windDir: c.wind?.direction?.cardinal,
        windDeg: c.wind?.direction?.degrees,
        gustKmh: kmh(c.wind?.gust, "gust", odd),
      }
    : undefined;
  const hourly = (Hours.parse(hours).forecastHours ?? []).flatMap((h) => {
    const at = iso(h.interval?.startTime);
    if (!at) odd.push(`forecast hour time not understood: ${h.interval?.startTime}`);
    return at ? [{ at, cloudPct: h.cloudCover, uvIndex: h.uvIndex }] : [];
  });
  const sky = at ? { ...meta(at), cloudPct: c.cloudCover, uvIndex: c.uvIndex, hours: hourly } : undefined;
  const list = Days.parse(days).forecastDays ?? [];
  if (place)
    for (const d of list) {
      const off = sunDisagrees("google", place.latitude, place.longitude, { sunrise: d.sunEvents?.sunriseTime, sunset: d.sunEvents?.sunsetTime });
      if (off) odd.push(off);
    }
  const i = list.findIndex((d) => contains(d.interval, fetchedAt));
  const day = (d: (typeof list)[number] | undefined): ForecastDay | undefined => {
    if (!d?.displayDate) return undefined;
    const { year, month, day: dd } = d.displayDate;
    const chances = [d.daytimeForecast, d.nighttimeForecast].map((h) => h?.precipitation?.probability?.percent).filter((p) => p !== undefined);
    const amounts = [d.daytimeForecast, d.nighttimeForecast].map((h) => h?.precipitation?.qpf);
    for (const q of amounts) if (q?.unit && q.unit !== "MILLIMETERS") odd.push(`rain in ${q.unit}`);
    const mm = amounts.every((q) => q?.quantity !== undefined && (q.unit ?? "MILLIMETERS") === "MILLIMETERS") ? amounts.reduce((s, q) => s + q!.quantity!, 0) : undefined;
    return {
      date: `${year}-${String(month).padStart(2, "0")}-${String(dd).padStart(2, "0")}`,
      minC: celsius(d.minTemperature, "minimum", odd),
      maxC: celsius(d.maxTemperature, "maximum", odd),
      rainChance: chances.length ? Math.max(...chances) : undefined,
      rainMm: mm,
      text: d.daytimeForecast?.weatherCondition?.description?.text,
      code: d.daytimeForecast?.weatherCondition?.type,
    };
  };
  const forecastIso = new Date(forecastAt).toISOString();
  const forecast = list.length ? { ...meta(forecastIso), fetchedAt: forecastIso, today: i < 0 ? undefined : day(list[i]), tomorrow: i < 0 ? undefined : day(list[i + 1]) } : undefined;
  return { now, forecast, sky, anomaly: odd.length ? odd.join("; ") : undefined };
}

/**
 * The minute forecast as a `rain` slice: the segments that start within `RAIN_HORIZON_MINUTES` of `fetchedAt`. A segment with an odd time is
 * skipped and noted; a rain amount in a unit other than millimetres is left out and noted, never converted.
 */
export function toRain(minutes: unknown, fetchedAt: number): { rain?: WeatherRain; anomaly?: string } {
  const odd: string[] = [];
  const parsed = Minutes.safeParse(minutes);
  if (!parsed.success) return { anomaly: "minute forecast not understood: the response is not the documented shape" };
  const m = parsed.data;
  const at = iso(m.overallPredictionTimeframe?.startTime);
  if (!at) odd.push(`minute forecast has no start time: ${m.overallPredictionTimeframe?.startTime}`);
  const limit = fetchedAt + RAIN_HORIZON_MINUTES * 60_000;
  const segments = (m.segments ?? []).flatMap((s) => {
    const from = iso(s.timeFrame?.startTime);
    const to = iso(s.timeFrame?.endTime);
    if (!from || !to) {
      odd.push(`minute forecast segment time not understood: ${s.timeFrame?.startTime}`);
      return [];
    }
    if (Date.parse(from) >= limit) return [];
    if (s.qpf?.unit && s.qpf.unit !== "MILLIMETERS") odd.push(`rain in ${s.qpf.unit}`);
    if (s.intensity && !RAIN_INTENSITIES.includes(s.intensity)) odd.push(`rain intensity not understood: ${s.intensity}`);
    const mm = s.qpf?.unit === undefined || s.qpf.unit === "MILLIMETERS" ? num(s.qpf?.quantity, "rain amount", odd) : undefined;
    return [{ from, to, type: s.type, chance: s.probability, mm, intensity: s.intensity }];
  });
  const anomaly = odd.length ? odd.join("; ") : undefined;
  if (!at || !segments.length) return { anomaly };
  return { rain: { source: "google", modelled: true, at, fetchedAt: new Date(fetchedAt).toISOString(), segments }, anomaly };
}

export type GoogleOptions = { key: string; fetch?: typeof fetch; base?: string };

/**
 * The shortest interval Google is read at: the minute forecast moves in 15-minute segments. Billed per call, 10,000 free a month across the key:
 * rain every 15 minutes, current conditions every 30 (`CURRENT_MINUTES`), the day and hour forecasts hourly: 192 calls a day, about 5,900 a month.
 */
export const MIN_POLL_MINUTES = 15;
export const CURRENT_MINUTES = 30;

/**
 * Google Weather as a source: modelled `now`, `forecast` (10 days available, 2 read), `sky` without radiation, and `rain` from the
 * minute forecast (Experimental at Google, so its failure is a `problem` on `rain` and never stops the other slices).
 */
export function google(options: GoogleOptions): WeatherSource {
  const fetcher = options.fetch ?? fetch;
  const base = options.base ?? BASE;
  let slices: Omit<SourceReading, "nextAt"> = {};
  let rain: WeatherRain | undefined;
  let forecasts: { days: unknown; hours: unknown; at: number } | undefined;
  let forecastsDue = 0;
  let slowDue = 0;
  return {
    name: "google",
    owns: { now: 30 * 60_000, forecast: 6 * 3_600_000, sky: 30 * 60_000, rain: 15 * 60_000 },
    minPollMinutes: MIN_POLL_MINUTES,
    async read({ place, at, pollMinutes, force, signal }): Promise<SourceReading> {
      const q = (extra: string) => `key=${encodeURIComponent(options.key)}&location.latitude=${place.latitude}&location.longitude=${place.longitude}${extra}`;
      const json = (path: string) => getJson(fetcher, `${base}/${path}`, { init: { headers: { "user-agent": USER_AGENT } }, signal });
      // Started first and never throws: a failed minute forecast must not sink the rest.
      const minutes = json(`forecast/minutes:lookup?${q("")}`).then(
        (value) => ({ value }),
        (error: unknown) => ({ error: error as Error }),
      );
      let problem: string | undefined;
      let failed = false;
      try {
        if (force || at >= slowDue) {
          const both = force || !forecasts || at >= forecastsDue;
          const [current, days, hours] = await Promise.all([
            json(`currentConditions:lookup?${q("")}`),
            both ? json(`forecast/days:lookup?${q("&days=2")}`) : forecasts!.days,
            both ? json(`forecast/hours:lookup?${q("&hours=6")}`) : forecasts!.hours,
          ]);
          if (both) (forecasts = { days, hours, at }), (forecastsDue = nextPoll(at, HOURLY_MINUTES));
          slices = toSlices(current, days, hours, at, forecasts!.at, place);
          slowDue = nextPoll(at, Math.max(pollMinutes, CURRENT_MINUTES));
        }
      } catch (error) {
        const status = (error as ConnectorError).status;
        if (status === 400 || status === 401 || status === 403) return { stop: `google: key rejected or request refused (HTTP ${status})`, nextAt: Infinity };
        problem = `google: ${(error as Error).message}`; // the old slices stay; the minute forecast below is still used
        failed = true;
      }
      const m = await minutes;
      let rainOdd: string | undefined;
      if ("error" in m) problem = [problem, `google minute forecast: ${m.error.message}`].filter(Boolean).join("; ");
      else {
        const r = toRain(m.value, at);
        rainOdd = r.anomaly;
        if (r.rain) rain = r.rain;
        else problem = [problem, "google minute forecast: no segments"].filter(Boolean).join("; ");
      }
      const anomaly = [failed ? undefined : slices.anomaly, rainOdd].filter(Boolean).join("; ") || undefined;
      return { ...slices, rain, anomaly, problem, nextAt: nextPoll(at, pollMinutes) };
    },
  };
}
