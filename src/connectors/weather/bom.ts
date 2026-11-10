import { XMLParser } from "fast-xml-parser";
import {
  type ForecastDay,
  getText,
  iso,
  nextPoll,
  num,
  type Place,
  type WeatherForecast,
  type WeatherNow,
  type WeatherSource,
} from "./source.ts";

// The Bureau of Meteorology's anonymous FTP products (https://www.bom.gov.au/catalogue/anon-ftp.shtml): a state's
// observations (IDx60920, every station, 10-minutely) and its précis forecast (IDx11060). Free, not for commercial use,
// BOM's default copyright terms. FTP is the channel BOM names for automated access; `fetch` must speak ftp:// (ftp.ts).

export const FTP_BASE = "ftp://ftp.bom.gov.au/anon/gen/fwo";

/** Stations whose latest observation is this much older than the file's newest are skipped (daily manual stations). */
const STALE_STATION_MS = 60 * 60_000;
/** After the forecast's own next routine issue time, wait this long for the file to land. */
const ISSUE_GRACE_MS = 5 * 60_000;
const HOUR = 3_600_000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseTagValue: false, // numbers are read here, so "-" or "80%" is seen as written
  parseAttributeValue: false,
  isArray: (name) =>
    [
      "station",
      "period",
      "level",
      "element",
      "area",
      "forecast-period",
      "text",
    ].includes(name),
});

type El = { "#text"?: string; [attr: `@${string}`]: string | undefined };
type Period = { "@time-utc"?: string; level?: { element?: El[] }[] };
type Station = {
  "@wmo-id"?: string;
  "@description"?: string;
  "@lat"?: string;
  "@lon"?: string;
  period?: Period[];
};
type FPeriod = {
  "@start-time-local"?: string;
  "@start-time-utc"?: string;
  "@end-time-utc"?: string;
  element?: El[];
  text?: El[];
};
type Area = {
  "@aac"?: string;
  "@description"?: string;
  "@type"?: string;
  "forecast-period"?: FPeriod[];
};
type Product = {
  product?: {
    amoc?: {
      "issue-time-utc"?: string;
      "next-routine-issue-time-utc"?: string;
    };
    observations?: { station?: Station[] };
    forecast?: { area?: Area[] };
  };
};

const byType = (els: El[] | undefined, type: string) =>
  els?.find((e) => e["@type"] === type);

/** Great-circle distance in km. */
export function distanceKm(a: Place, b: Place): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) *
      Math.cos(b.latitude * rad) *
      Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/**
 * The `now` slice from an observations product: the station given by WMO id, else the nearest one that reports air
 * temperature. Rain since 9am keeps its own window, which ends a few minutes after the observation time.
 */
export function toNow(
  xml: string,
  place: Place,
  fetchedAt: number,
  wmoId?: string,
): { now?: WeatherNow; anomaly?: string; problem?: string } {
  const stations =
    (parser.parse(xml) as Product).product?.observations?.station ?? [];
  const odd: string[] = [];
  const surface = (s: Station) => s.period?.[0]?.level?.[0]?.element;
  const time = (s: Station) => Date.parse(s.period?.[0]?.["@time-utc"] ?? "");
  const newest = Math.max(
    ...stations.map(time).filter((t) => !Number.isNaN(t)),
  );
  const located = stations.flatMap((s) => {
    const latitude = Number(s["@lat"]);
    const longitude = Number(s["@lon"]);
    return Number.isFinite(latitude) && Number.isFinite(longitude)
      ? [{ s, km: distanceKm(place, { latitude, longitude }) }]
      : [];
  });
  const pick = wmoId
    ? located.find(({ s }) => s["@wmo-id"] === wmoId) // a pinned station is shown however old; its `at` says so
    : located
        .filter(
          ({ s }) =>
            byType(surface(s), "air_temperature") &&
            newest - time(s) <= STALE_STATION_MS,
        )
        .sort((a, b) => a.km - b.km)[0];
  if (!pick)
    return {
      problem: wmoId
        ? `no station ${wmoId} in this product`
        : "no station with an air temperature in this product",
    };
  const { s, km } = pick;
  const els = surface(s);
  const at = iso(s.period?.[0]?.["@time-utc"]);
  if (!at)
    return { problem: `station ${s["@wmo-id"]} has no observation time` };
  const n = (type: string) => num(byType(els, type)?.["#text"], type, odd);
  const rain = byType(els, "rainfall");
  const now: WeatherNow = {
    source: "bom",
    modelled: false,
    at,
    fetchedAt: new Date(fetchedAt).toISOString(),
    tempC: n("air_temperature"),
    apparentC: n("apparent_temp"),
    humidity: n("rel-humidity"),
    windKmh: n("wind_spd_kmh"),
    windDir: byType(els, "wind_dir")?.["#text"],
    windDeg: n("wind_dir_deg"),
    gustKmh: n("gust_kmh"),
    rainMm: n("rainfall"),
    rainFrom: iso(rain?.["@start-time-utc"]),
    rainTo: iso(rain?.["@end-time-utc"]),
    station: {
      name: s["@description"] ?? s["@wmo-id"] ?? "unnamed",
      distanceKm: km,
    },
  };
  return { now, anomaly: odd.length ? odd.join("; ") : undefined };
}

/** "0 to 1 mm" → [0, 1]; anything else is reported, not guessed. */
function range(
  text: string | undefined,
  odd: string[],
): [number, number] | undefined {
  if (text === undefined) return undefined;
  const m = text.match(/^(\d+(?:\.\d+)?) to (\d+(?:\.\d+)?) mm$/);
  if (!m) odd.push(`rain range not understood: ${text}`);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/**
 * The `forecast` slice for one précis location (its name, e.g. "Sydney", or its `aac`, e.g. "NSW_PT131"). Today is the
 * period containing `fetchedAt`; after the afternoon issue it has no min, max or rain range, and they stay missing.
 */
export function toForecast(
  xml: string,
  location: string,
  fetchedAt: number,
): {
  forecast?: WeatherForecast;
  nextIssue?: number;
  anomaly?: string;
  problem?: string;
} {
  const p = (parser.parse(xml) as Product).product;
  const nextIssue = Date.parse(p?.amoc?.["next-routine-issue-time-utc"] ?? "");
  const want = location.toLowerCase();
  const areas = (p?.forecast?.area ?? []).filter(
    (a) => a["@type"] === "location",
  );
  const area = areas.find(
    (a) =>
      a["@aac"]?.toLowerCase() === want ||
      a["@description"]?.toLowerCase() === want,
  );
  const result = { nextIssue: Number.isNaN(nextIssue) ? undefined : nextIssue };
  if (!area)
    return {
      ...result,
      problem: `no forecast location "${location}"; have ${areas
        .slice(0, 8)
        .map((a) => a["@description"])
        .join(", ")}…`,
    };
  const odd: string[] = [];
  const periods = area["forecast-period"] ?? [];
  const i = periods.findIndex(
    (f) =>
      Date.parse(f["@start-time-utc"] ?? "") <= fetchedAt &&
      fetchedAt < Date.parse(f["@end-time-utc"] ?? ""),
  );
  const day = (f: FPeriod | undefined): ForecastDay | undefined => {
    if (!f) return undefined;
    const el = (type: string) => byType(f.element, type)?.["#text"];
    const chance = byType(f.text, "probability_of_precipitation")?.["#text"];
    const percent = chance?.match(/^(\d+)%$/)?.[1];
    if (chance !== undefined && percent === undefined)
      odd.push(`rain chance not understood: ${chance}`);
    return {
      date: (f["@start-time-local"] ?? "").slice(0, 10),
      minC: num(el("air_temperature_minimum"), "minimum", odd),
      maxC: num(el("air_temperature_maximum"), "maximum", odd),
      rainChance: percent === undefined ? undefined : Number(percent),
      rainRangeMm: range(el("precipitation_range"), odd),
      text: byType(f.text, "precis")?.["#text"],
      code: el("forecast_icon_code"),
    };
  };
  const issuedAt = iso(p?.amoc?.["issue-time-utc"]);
  const forecast: WeatherForecast = {
    source: "bom",
    modelled: false,
    at: issuedAt ?? new Date(fetchedAt).toISOString(),
    fetchedAt: new Date(fetchedAt).toISOString(),
    issuedAt,
    today: i < 0 ? undefined : day(periods[i]),
    tomorrow: i < 0 ? undefined : day(periods[i + 1]),
  };
  if (i < 0)
    odd.push(
      `no forecast period contains ${new Date(fetchedAt).toISOString()}`,
    );
  return {
    ...result,
    forecast,
    anomaly: odd.length ? odd.join("; ") : undefined,
  };
}

export type BomOptions = {
  /** A `fetch` that speaks ftp://, e.g. `ftpFetch()` from `@khalido/home/weather/ftp`. Without one the source stops at once. */
  fetch?: typeof fetch;
  /** The précis location by name or aac. Without one there is no BOM forecast and that slice falls to the next source. */
  forecastLocation?: string;
  /** A station's WMO id, to pin it instead of the nearest. */
  station?: string;
  /** Another state's product ids (README has the table checked on the server). Default NSW: IDN60920 and IDN11060. */
  observations?: string;
  forecasts?: string;
  base?: string;
};

/** BOM as a weather source: observed `now` every polling interval, the forecaster's `forecast` at its issue times. */
export function bom(options: BomOptions = {}): WeatherSource {
  const fetcher = options.fetch ?? fetch;
  const base = options.base ?? FTP_BASE;
  const obsUrl = `${base}/${options.observations ?? "IDN60920"}.xml`;
  const fcUrl = `${base}/${options.forecasts ?? "IDN11060"}.xml`;
  let now: WeatherNow | undefined;
  let forecast: WeatherForecast | undefined;
  let obsDue = 0;
  let fcDue = 0;
  const notes = {
    obs: {} as { problem?: string; anomaly?: string },
    fc: {} as { problem?: string; anomaly?: string },
  };
  return {
    name: "bom",
    owns: { now: 30 * 60_000, forecast: 24 * HOUR },
    async read({ place, at, pollMinutes, force, signal }) {
      // Plain fetch never reads ftp:// (Bun and Node fail differently), so this is terminal, like a rejected key.
      if (!options.fetch && base.startsWith("ftp:"))
        return {
          stop: "bom: plain fetch cannot read ftp://; pass fetch: ftpFetch() from @khalido/home/weather/ftp",
          stopReason: "config",
          nextAt: Infinity,
        };
      if (force || at >= obsDue) {
        try {
          const r = toNow(
            await getText(fetcher, obsUrl, signal),
            place,
            at,
            options.station,
          );
          now = r.now ?? now;
          notes.obs = {
            problem: r.problem && `bom observations: ${r.problem}`,
            anomaly: r.anomaly,
          };
        } catch (error) {
          notes.obs = {
            problem: `bom observations: ${(error as Error).message}`,
          };
        }
        obsDue = nextPoll(at, pollMinutes);
      }
      if (!options.forecastLocation)
        notes.fc = { problem: "bom forecast: no forecastLocation set" };
      else if (force || at >= fcDue) {
        try {
          const r = toForecast(
            await getText(fetcher, fcUrl, signal),
            options.forecastLocation,
            at,
          );
          forecast = r.forecast ?? forecast;
          notes.fc = {
            problem: r.problem && `bom forecast: ${r.problem}`,
            anomaly: r.anomaly,
          };
          // At the file's own next routine issue; hourly only when it names none. An amendment between issues waits (README).
          fcDue =
            r.nextIssue && r.nextIssue > at
              ? r.nextIssue + ISSUE_GRACE_MS
              : at + HOUR;
        } catch (error) {
          notes.fc = { problem: `bom forecast: ${(error as Error).message}` };
          fcDue = nextPoll(at, pollMinutes);
        }
      }
      const join = (a?: string, b?: string) =>
        [a, b].filter(Boolean).join("; ") || undefined;
      return {
        now,
        forecast,
        problem: join(notes.obs.problem, notes.fc.problem),
        anomaly: join(notes.obs.anomaly, notes.fc.anomaly),
        nextAt: options.forecastLocation ? Math.min(obsDue, fcDue) : obsDue,
      };
    },
  };
}
