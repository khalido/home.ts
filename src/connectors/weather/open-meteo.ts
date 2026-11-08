import { z } from "zod";
import { getJson } from "../../connector.ts";
import {
  type Condition,
  type ForecastDay,
  type ForecastHour,
  HOURLY_MINUTES,
  iso,
  localDate,
  nextPoll,
  num,
  type SourceReading,
  USER_AGENT,
  type WeatherSource,
} from "./source.ts";

// Open-Meteo's forecast API (https://open-meteo.com/en/docs): keyless, JSON, data CC BY 4.0. No `models`, so the default
// best_match answers; its BOM model (bom_access_global) has returned only nulls since BOM paused open data in mid 2025.

const CURRENT =
  "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,uv_index,shortwave_radiation,weather_code";
const HOURLY =
  "temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,cloud_cover,uv_index,shortwave_radiation";
/** How many hours ahead `sky.hours` holds. */
const SKY_HOURS = 6;
const DAILY =
  "temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,weather_code";

const series = z.array(z.number().nullable()).optional();
const OpenMeteoResponse = z.looseObject({
  utc_offset_seconds: z.number().optional(),
  current: z.record(z.string(), z.unknown()).optional(),
  hourly: z
    .looseObject({
      time: z.array(z.string()),
      temperature_2m: series,
      apparent_temperature: series,
      precipitation_probability: series,
      precipitation: series,
      weather_code: series,
      wind_speed_10m: series,
      wind_gusts_10m: series,
      cloud_cover: series,
      uv_index: series,
      shortwave_radiation: series,
    })
    .optional(),
  daily: z
    .looseObject({
      time: z.array(z.string()),
      temperature_2m_max: series,
      temperature_2m_min: series,
      precipitation_probability_max: series,
      precipitation_sum: series,
      weather_code: series,
    })
    .optional(),
});

/** WMO weather codes as Open-Meteo documents them (the table at the end of its docs page). */
const WMO: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snow",
  73: "Moderate snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

/** WMO codes in a word: 0–1 clear, 2 partly cloudy, 3 cloudy, then by family. */
export function wmoCondition(code: number): Condition | undefined {
  if (!(code in WMO)) return undefined;
  if (code <= 1) return "clear";
  if (code === 2) return "partly cloudy";
  if (code === 3) return "cloudy";
  if (code < 50) return "fog";
  if (code < 60) return "drizzle";
  if (code < 70) return "rain";
  if (code < 80) return "snow";
  if (code < 85) return "showers";
  if (code < 95) return "snow"; // snow showers
  return "storm";
}

/** Open-Meteo's local times ("2026-10-13T20:15") to UTC ISO, using the response's offset; undefined when it does not parse. Open-Meteo applies that one offset to every time it returns, across a daylight-saving change too (checked live, 2026-10-16), so it is right for all of them. */
const utc = (local: string, offset: number) => {
  const t = Date.parse(`${local}Z`);
  return Number.isNaN(t)
    ? undefined
    : iso(new Date(t - offset * 1000).toISOString());
};
const value = (s: (number | null)[] | undefined, i: number) =>
  s?.[i] ?? undefined;

/** Map one forecast response to slices. Everything here is a model, so every slice says `modelled: true`. `forecastAt` is when the daily part was read. */
export function toSlices(
  body: unknown,
  fetchedAt: number,
  forecastAt = fetchedAt,
): Omit<SourceReading, "nextAt"> {
  const r = OpenMeteoResponse.parse(body);
  const offset = r.utc_offset_seconds ?? 0;
  const odd: string[] = [];
  const meta = (at: string) => ({
    source: "open-meteo",
    modelled: true,
    at,
    fetchedAt: new Date(fetchedAt).toISOString(),
  });
  const c = r.current;
  const cur = (k: string) => num(c?.[k], `current.${k}`, odd);
  const code = cur("weather_code");
  const nowAt = typeof c?.time === "string" ? utc(c.time, offset) : undefined;
  if (c && !nowAt) odd.push(`current.time not understood: ${String(c.time)}`);
  const now = nowAt
    ? {
        ...meta(nowAt),
        tempC: cur("temperature_2m"),
        apparentC: cur("apparent_temperature"),
        humidity: cur("relative_humidity_2m"),
        windKmh: cur("wind_speed_10m"),
        windDeg: cur("wind_direction_10m"),
        gustKmh: cur("wind_gusts_10m"),
      }
    : undefined;
  const h = r.hourly;
  const unknownCodes = new Set<number>();
  const hours = (h?.time ?? []).flatMap((t, i) => {
    const at = utc(t, offset);
    if (!at) odd.push(`hourly time not understood: ${t}`);
    if (!at) return [];
    const wmo = value(h?.weather_code, i);
    if (wmo !== undefined && !(wmo in WMO)) unknownCodes.add(wmo);
    const hour: ForecastHour & { radiationWm2?: number } = {
      at,
      tempC: value(h?.temperature_2m, i),
      apparentC: value(h?.apparent_temperature, i),
      rainChance: value(h?.precipitation_probability, i),
      rainMm: value(h?.precipitation, i),
      windKmh: value(h?.wind_speed_10m, i),
      gustKmh: value(h?.wind_gusts_10m, i),
      cloudPct: value(h?.cloud_cover, i),
      uvIndex: value(h?.uv_index, i),
      radiationWm2: value(h?.shortwave_radiation, i),
      code: wmo === undefined ? undefined : String(wmo),
      condition: wmo === undefined ? undefined : wmoCondition(wmo),
    };
    return [hour];
  });
  for (const code of unknownCodes)
    odd.push(`unknown WMO code ${code} in the hourly forecast`);
  // The hourly part is read once an hour; the sky's hours run from the hour it was read in.
  const skyHours = hours
    .filter((x) => Date.parse(x.at) + 3_600_000 > forecastAt)
    .slice(0, SKY_HOURS)
    .map((x) => ({
      at: x.at,
      cloudPct: x.cloudPct,
      uvIndex: x.uvIndex,
      radiationWm2: x.radiationWm2,
    }));
  const sky = now
    ? {
        ...meta(now.at),
        cloudPct: cur("cloud_cover"),
        uvIndex: cur("uv_index"),
        radiationWm2: cur("shortwave_radiation"),
        hours: skyHours,
      }
    : undefined;
  const d = r.daily;
  const day = (date: string): ForecastDay | undefined => {
    const i = d?.time.indexOf(date) ?? -1;
    if (!d || i < 0) return undefined;
    const wmo = value(d.weather_code, i);
    return {
      date,
      minC: value(d.temperature_2m_min, i),
      maxC: value(d.temperature_2m_max, i),
      rainChance: value(d.precipitation_probability_max, i),
      rainMm: value(d.precipitation_sum, i),
      text: wmo === undefined ? undefined : WMO[wmo],
      code: wmo === undefined ? undefined : String(wmo),
    };
  };
  const today = localDate(fetchedAt, offset);
  const tomorrow = localDate(fetchedAt + 86_400_000, offset);
  const forecastIso = new Date(forecastAt).toISOString();
  const forecast = d
    ? {
        ...meta(forecastIso),
        fetchedAt: forecastIso,
        today: day(today),
        tomorrow: day(tomorrow),
      }
    : undefined;
  const hourly = hours.length
    ? {
        ...meta(forecastIso),
        fetchedAt: forecastIso,
        hours: hours.map(({ radiationWm2: _, ...x }) => x),
      }
    : undefined;
  for (const [i, wmo] of (d?.weather_code ?? []).entries())
    if (wmo !== null && !(wmo in WMO))
      odd.push(`unknown WMO code ${wmo} on ${d?.time[i]}`);
  if (code !== undefined && !(code in WMO))
    odd.push(`unknown WMO code ${code} now`);
  return {
    now,
    forecast,
    hourly,
    sky,
    anomaly: odd.length ? odd.join("; ") : undefined,
  };
}

export type OpenMeteoOptions = { fetch?: typeof fetch; base?: string };

/**
 * Open-Meteo as a weather source: modelled `now`, `forecast`, `hourly` (today and tomorrow) and `sky` (the only source with radiation). `current` is
 * 15-minutely, so it is read every poll; the daily and hourly parts come from models that update hourly at best, so
 * they are read hourly (one call with everything), and the polls between ask for `current` alone.
 */
export function openMeteo(options: OpenMeteoOptions = {}): WeatherSource {
  const fetcher = options.fetch ?? fetch;
  const base = options.base ?? "https://api.open-meteo.com/v1/forecast";
  let last: Omit<SourceReading, "nextAt"> = {};
  let full: { body: Record<string, unknown>; at: number } | undefined;
  let fullDue = 0;
  return {
    name: "open-meteo",
    owns: {
      now: 30 * 60_000,
      forecast: 6 * 3_600_000,
      hourly: 6 * 3_600_000,
      sky: 30 * 60_000,
    }, // `current.time` starts its 15-minute interval
    async read({
      place,
      at,
      pollMinutes,
      force,
      signal,
    }): Promise<SourceReading> {
      const everything = force || !full || at >= fullDue;
      const q = new URLSearchParams({
        latitude: String(place.latitude),
        longitude: String(place.longitude),
        timezone: "auto",
        current: CURRENT,
      });
      if (everything)
        for (const [k, v] of Object.entries({
          hourly: HOURLY,
          daily: DAILY,
          forecast_days: "2",
        }))
          q.set(k, v);
      try {
        const body = (await getJson(fetcher, `${base}?${q}`, {
          init: { headers: { "user-agent": USER_AGENT } },
          signal,
        })) as Record<string, unknown>;
        if (everything)
          ((full = { body, at }), (fullDue = nextPoll(at, HOURLY_MINUTES)));
        last = toSlices(
          {
            ...full!.body,
            current: body.current,
            utc_offset_seconds: body.utc_offset_seconds,
          },
          at,
          full!.at,
        );
        return { ...last, nextAt: nextPoll(at, pollMinutes) };
      } catch (error) {
        return {
          ...last,
          anomaly: undefined,
          problem: `open-meteo: ${(error as Error).message}`,
          nextAt: nextPoll(at, pollMinutes),
        };
      }
    },
  };
}
