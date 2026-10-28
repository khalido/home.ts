import { describe, expect, test } from "bun:test";
import { type Clock, createHome } from "../src/index.ts";
import type { Part } from "../src/home.ts";
import { blockText, bom, dayBlocks, google, manifest, openMeteo, rainSoon, rainText, weatherText, type SourceReading, sunNow, weather, type WeatherSource, type WeatherState, mergeWeather } from "../src/connectors/weather/index.ts";
import { nextPoll } from "../src/connectors/weather/source.ts";
import { sunDisagrees } from "../src/connectors/weather/sun.ts";
import { toForecast, toNow } from "../src/connectors/weather/bom.ts";
import { toRain, toSlices as googleSlices } from "../src/connectors/weather/google.ts";
import { toSlices as openMeteoSlices, wmoCondition } from "../src/connectors/weather/open-meteo.ts";

const text = (name: string) => Bun.file(new URL(`./fixtures/weather/${name}`, import.meta.url)).text();
// BOM: invented values in the real shape (see each file's header). Open-Meteo: a real response for Sydney CBD,
// 2026-10-13 20:15 AEDT. Google: the docs' example responses, the complete objects only (the docs elide the rest).
const observations = await text("bom-observations.xml");
const forecastXml = await text("bom-forecast.xml");
const openMeteoJson = JSON.parse(await text("open-meteo.json"));
const [gCurrent, gDays, gHours, gMinutes] = await Promise.all(["google-current.json", "google-days.json", "google-hours.json", "google-minutes.json"].map(async (f) => JSON.parse(await text(f))));

const sydney = { latitude: -33.8688, longitude: 151.2093 };
const req = (t: number) => ({ place: sydney, at: t, pollMinutes: 15 });
const at = Date.parse("2026-10-13T09:20:00Z"); // 20:20 AEDT

describe("sunNow", () => {
  test("Sydney on 13 Oct 2026 matches BOM's own sunrise and sunset to the minute", () => {
    const s = sunNow(sydney.latitude, sydney.longitude, at);
    expect(Math.abs(Date.parse(s.sunrise!) - Date.parse("2026-10-12T19:16:53Z"))).toBeLessThan(60_000);
    expect(Math.abs(Date.parse(s.sunset!) - Date.parse("2026-10-13T08:06:40Z"))).toBeLessThan(60_000);
    expect(s.altitudeDeg).toBeLessThan(0); // after sunset
  });

  test("at solar noon in the southern hemisphere the sun is due north and high", () => {
    const s = sunNow(sydney.latitude, sydney.longitude, Date.parse("2026-10-13T01:41:30Z"));
    expect(Math.min(s.azimuthDeg, 360 - s.azimuthDeg)).toBeLessThan(1);
    expect(s.altitudeDeg).toBeGreaterThan(60);
  });

  test("civil dawn and dusk bracket sunrise and sunset; at 20:20 the sun is setting and the next events are tomorrow's", () => {
    const s = sunNow(sydney.latitude, sydney.longitude, at);
    expect(Date.parse(s.nightEnd!)).toBeLessThan(Date.parse(s.dawn!));
    expect(Date.parse(s.dawn!)).toBeLessThan(Date.parse(s.sunrise!));
    expect(Date.parse(s.goldenHour!)).toBeLessThan(Date.parse(s.sunset!));
    expect(Date.parse(s.sunset!)).toBeLessThan(Date.parse(s.dusk!));
    expect(Date.parse(s.dusk!)).toBeLessThan(Date.parse(s.night!));
    expect(s).toMatchObject({ rising: false, daylight: false });
    for (const name of ["dawn", "sunrise", "sunset", "dusk"] as const) {
      const t = Date.parse(s.next[name]!);
      expect(t).toBeGreaterThan(at);
      expect(t - Date.parse(s[name]!)).toBeGreaterThan(23 * 3_600_000); // tomorrow's, a day on from today's
    }
  });

  test("mid-morning the sun is rising and up; today's sunset and dusk are next, tomorrow's dawn and sunrise", () => {
    const morning = Date.parse("2026-10-12T22:00:00Z"); // 09:00 AEDT on the 13th
    const s = sunNow(sydney.latitude, sydney.longitude, morning);
    expect(s).toMatchObject({ rising: true, daylight: true });
    expect(s.next.sunset).toBe(s.sunset);
    expect(s.next.dusk).toBe(s.dusk);
    expect(Date.parse(s.next.sunrise!) - Date.parse(s.sunrise!)).toBeGreaterThan(23 * 3_600_000);
  });

  test("after local midnight the solar day is the coming one, so the sun is rising and sunrise is still ahead", () => {
    const s = sunNow(sydney.latitude, sydney.longitude, Date.parse("2026-10-13T15:00:00Z")); // 02:00 AEDT on the 14th
    expect(s).toMatchObject({ rising: true, daylight: false });
    expect(s.next.sunrise).toBe(s.sunrise);
  });

  test("a polar day has no sunrise or sunset, and says so", () => {
    const s = sunNow(78.2, 15.6, Date.parse("2026-06-21T12:00:00Z"));
    expect(s).toMatchObject({ sunrise: undefined, sunset: undefined, alwaysUp: true });
    expect(s.next).toEqual({ dawn: undefined, sunrise: undefined, sunset: undefined, dusk: undefined });
  });
});

describe("BOM observations", () => {
  test("the nearest fresh station with a temperature, skipping a rain gauge and a days-old manual station", () => {
    const { now, anomaly } = toNow(observations, sydney, at);
    expect(anomaly).toBeUndefined();
    expect(now).toMatchObject({
      source: "bom",
      modelled: false,
      at: "2026-10-13T09:10:00.000Z",
      tempC: 16.4,
      apparentC: 17.1,
      humidity: 88,
      windKmh: 11,
      windDir: "ESE",
      windDeg: 112,
      gustKmh: 20,
      rainMm: 12.6,
      rainFrom: "2026-10-12T22:00:00.000Z",
      rainTo: "2026-10-13T09:13:00.000Z", // its own cut-off, three minutes after the observation
      station: { name: "Sydney - Harbour Point" },
    });
    expect(now!.station!.distanceKm).toBeCloseTo(1.06, 1);
  });

  test("a pinned station is used however old, and its time says how old", () => {
    expect(toNow(observations, sydney, at, "90003").now).toMatchObject({ at: "2026-10-11T22:00:00.000Z", tempC: 14 });
    expect(toNow(observations, sydney, at, "99999").problem).toBe("no station 99999 in this product");
  });

  test("a value that is not a number is flagged, not guessed", () => {
    const r = toNow(observations.replace(">17.1<", ">-<"), sydney, at);
    expect(r.now!.apparentC).toBeUndefined();
    expect(r.anomaly).toBe("apparent_temp is not a number: -");
  });

  test("reads every 15 minutes at :05, :20, :35, :50, or on another interval", () => {
    const next = (iso: string, minutes?: number) => new Date(nextPoll(Date.parse(iso), minutes)).toISOString();
    expect(next("2026-10-13T09:04:59Z")).toBe("2026-10-13T09:05:00.000Z");
    expect(next("2026-10-13T09:05:00Z")).toBe("2026-10-13T09:20:00.000Z");
    expect(next("2026-10-13T09:49:00Z")).toBe("2026-10-13T09:50:00.000Z");
    expect(next("2026-10-13T23:56:00Z")).toBe("2026-10-14T00:05:00.000Z");
    expect(next("2026-10-13T09:06:00Z", 30)).toBe("2026-10-13T09:35:00.000Z");
  });
});

describe("BOM forecast", () => {
  test("after the afternoon issue today has no min, max or range; tomorrow has all of them", () => {
    const r = toForecast(forecastXml, "Sydney", at);
    expect(r.anomaly).toBeUndefined();
    expect(r.nextIssue).toBe(Date.parse("2026-10-13T17:15:00Z"));
    expect(r.forecast).toMatchObject({ source: "bom", modelled: false, issuedAt: "2026-10-13T05:22:18.000Z" });
    expect(r.forecast!.today).toEqual({ date: "2026-10-13", minC: undefined, maxC: undefined, rainChance: 90, rainRangeMm: undefined, text: "Rain at times.", code: "12" });
    expect(r.forecast!.tomorrow).toEqual({ date: "2026-10-14", minC: 13, maxC: 21, rainChance: 20, rainRangeMm: [0, 2], text: "Partly cloudy.", code: "3" });
  });

  test("a location by aac works; an unknown one lists what exists", () => {
    expect(toForecast(forecastXml, "nsw_pt998", at).forecast?.today?.text).toBe("Cloudy.");
    expect(toForecast(forecastXml, "Atlantis", at).problem).toBe('no forecast location "Atlantis"; have Sydney, Inland Town…');
  });

  test("an odd rain range is flagged", () => {
    expect(toForecast(forecastXml.replace("0 to 2 mm", "up to 2 mm"), "Sydney", at).anomaly).toBe("rain range not understood: up to 2 mm");
  });
});

describe("bom source", () => {
  const ftp = (async (url: string | URL) => new Response(String(url).endsWith("IDN60920.xml") ? observations : forecastXml)) as unknown as typeof fetch;

  test("reads both products; the forecast next at its own next issue time", async () => {
    const r = await bom({ fetch: ftp, forecastLocation: "Sydney" }).read(req(at));
    expect(r.now?.tempC).toBe(16.4);
    expect(r.forecast?.tomorrow?.maxC).toBe(21);
    expect(r.problem).toBeUndefined();
    expect(new Date(r.nextAt).toISOString()).toBe("2026-10-13T09:35:00.000Z");
  });

  test("without a forecast location there is no BOM forecast, and it says so", async () => {
    const r = await bom({ fetch: ftp }).read(req(at));
    expect(r.forecast).toBeUndefined();
    expect(r.problem).toBe("bom forecast: no forecastLocation set");
  });

  test("without an ftp:// fetch the source stops at once and names the fix; nothing is fetched", async () => {
    expect(await bom({ forecastLocation: "Sydney" }).read(req(at))).toEqual({ stop: "bom: plain fetch cannot read ftp://; pass fetch: ftpFetch() from @khalido/home/weather/ftp", nextAt: Infinity });
  });

  test("force reads both products now, whatever their schedule", async () => {
    const asked: string[] = [];
    const counting = (async (url: string | URL) => (asked.push(String(url).split("/").pop()!), ftp(url))) as unknown as typeof fetch;
    const s = bom({ fetch: counting, forecastLocation: "Sydney" });
    await s.read(req(at));
    await s.read(req(at + 60_000)); // nothing due a minute later
    expect(asked).toEqual(["IDN60920.xml", "IDN11060.xml"]);
    await s.read({ ...req(at + 60_000), force: true });
    expect(asked).toEqual(["IDN60920.xml", "IDN11060.xml", "IDN60920.xml", "IDN11060.xml"]);
  });

  test("a failed read keeps the last good slices", async () => {
    let fail = false;
    const flaky = (async (url: string | URL) => {
      if (fail) throw new Error("connection reset");
      return ftp(url);
    }) as unknown as typeof fetch;
    const s = bom({ fetch: flaky, forecastLocation: "Sydney" });
    await s.read(req(at));
    fail = true;
    const r = await s.read(req(Date.parse("2026-10-13T09:35:00Z"))); // the next observation read
    expect(r.now?.tempC).toBe(16.4);
    expect(r.problem).toBe("bom observations: connection reset");
  });
});

describe("Open-Meteo", () => {
  const fetchedAt = Date.parse("2026-10-16T05:50:00Z"); // 16:50 in Sydney; the fixture is a live read of Sydney CBD at 16:45
  test("a real Sydney response: every slice modelled, local times to UTC, today by local date", () => {
    const r = openMeteoSlices(openMeteoJson, fetchedAt);
    expect(r.anomaly).toBeUndefined();
    expect(r.now).toMatchObject({ source: "open-meteo", modelled: true, at: "2026-10-16T05:45:00.000Z", tempC: 18.1, apparentC: 15.7, humidity: 56, windKmh: 15.2, windDeg: 100, gustKmh: 39.2 });
    expect(r.now!.rainMm).toBeUndefined(); // `precipitation` is the last 15 minutes, not since 9am
    expect(r.sky).toMatchObject({ cloudPct: 19, uvIndex: 1.8, radiationWm2: 401 });
    expect(r.sky!.hours).toHaveLength(6); // from the hour it was read
    expect(r.sky!.hours[0]).toEqual({ at: "2026-10-16T05:00:00.000Z", cloudPct: 10, uvIndex: 3.15, radiationWm2: 571 });
    expect(r.forecast!.today).toEqual({ date: "2026-10-16", minC: 13.1, maxC: 19.3, rainChance: 87, rainMm: 1.8, text: "Moderate drizzle", code: "53" });
    expect(r.forecast!.tomorrow).toMatchObject({ date: "2026-10-17", maxC: 19.3, text: "Light drizzle" });
  });

  test("the hourly forecast: 48 hours from the home's midnight, each code also in a word", () => {
    const { hourly } = openMeteoSlices(openMeteoJson, fetchedAt);
    expect(hourly).toMatchObject({ source: "open-meteo", modelled: true, at: "2026-10-16T05:50:00.000Z" });
    expect(hourly!.hours).toHaveLength(48);
    expect(hourly!.hours[0]).toEqual({ at: "2026-10-15T13:00:00.000Z", tempC: 15.1, apparentC: 13.5, rainChance: 87, rainMm: 0.3, windKmh: 11.8, gustKmh: 24.5, cloudPct: 66, uvIndex: 0, code: "51", condition: "drizzle" });
  });

  test("WMO codes in words, by family", () => {
    expect([0, 1, 2, 3, 45, 53, 63, 73, 81, 85, 95, 99, 42].map(wmoCondition)).toEqual(["clear", "clear", "partly cloudy", "cloudy", "fog", "drizzle", "rain", "snow", "showers", "snow", "storm", "storm", undefined]);
  });

  test("one offset for every time, across a daylight-saving change, as Open-Meteo applies it", () => {
    // Live, 2026-10-16: Sydney's hours for 2026-10-03 to 04 all came at +11, including 02:00 on the 4th, which Sydney skipped.
    const dst = structuredClone(openMeteoJson);
    dst.hourly.time.splice(0, 4, "2026-10-04T00:00", "2026-10-04T01:00", "2026-10-04T02:00", "2026-10-04T03:00");
    expect(openMeteoSlices(dst, fetchedAt).hourly!.hours.slice(0, 4).map((h) => h.at)).toEqual(["2026-10-03T13:00:00.000Z", "2026-10-03T14:00:00.000Z", "2026-10-03T15:00:00.000Z", "2026-10-03T16:00:00.000Z"]);
  });

  test("an unknown weather code is flagged, once per code in the hourly forecast", () => {
    const odd = structuredClone(openMeteoJson);
    odd.daily.weather_code[1] = 42;
    odd.hourly.weather_code[3] = 42;
    odd.hourly.weather_code[4] = 42;
    const r = openMeteoSlices(odd, fetchedAt);
    expect(r.anomaly).toBe("unknown WMO code 42 in the hourly forecast; unknown WMO code 42 on 2026-10-17");
    expect(r.hourly!.hours[3]).toMatchObject({ code: "42", condition: undefined });
  });

  test("an hour with no usable time is skipped and flagged; the rest of the read stands", () => {
    const odd = structuredClone(openMeteoJson);
    odd.hourly.time[2] = "soon";
    const r = openMeteoSlices(odd, fetchedAt);
    expect(r.hourly!.hours).toHaveLength(47);
    expect(r.now?.tempC).toBe(18.1);
    expect(r.anomaly).toBe("hourly time not understood: soon");
  });

  test("a current time that does not parse drops now and sky, not the forecasts", () => {
    const odd = structuredClone(openMeteoJson);
    odd.current.time = "";
    const r = openMeteoSlices(odd, fetchedAt);
    expect(r.now).toBeUndefined();
    expect(r.sky).toBeUndefined();
    expect(r.forecast?.today?.maxC).toBe(19.3);
    expect(r.hourly?.hours).toHaveLength(48);
    expect(r.anomaly).toBe("current.time not understood: ");
  });

  test("the source asks for no model, and the next read in 15 minutes", async () => {
    let asked = "";
    const f = (async (url: string) => ((asked = url), new Response(JSON.stringify(openMeteoJson)))) as unknown as typeof fetch;
    const r = await openMeteo({ fetch: f }).read(req(fetchedAt));
    expect(asked).not.toContain("models=");
    expect(r.nextAt - fetchedAt).toBe(15 * 60_000);
  });
});

describe("Open-Meteo cadence", () => {
  test("current every poll; daily and hourly once an hour, the forecast keeping the time it was read", async () => {
    const asked: string[] = [];
    const f = (async (url: string) => (asked.push(url), new Response(JSON.stringify(openMeteoJson)))) as unknown as typeof fetch;
    const s = openMeteo({ fetch: f });
    const t0 = Date.parse("2026-10-16T05:05:00Z");
    await s.read(req(t0));
    const later = await s.read(req(t0 + 15 * 60_000));
    expect(asked.map((u) => u.includes("daily="))).toEqual([true, false]);
    expect(later.forecast?.fetchedAt).toBe(new Date(t0).toISOString());
    expect(later.sky?.hours).toHaveLength(6); // kept from the hourly read
    expect(later.hourly?.at).toBe(new Date(t0).toISOString());
    await s.read(req(t0 + 60 * 60_000));
    expect(asked.map((u) => u.includes("daily="))).toEqual([true, false, true]);
  });
});

describe("Google (the docs' examples; checked live 2026-10-13)", () => {
  const fetchedAt = Date.parse("2025-02-10T20:00:00Z"); // inside the example's first day
  const mountainView = { latitude: 37.422, longitude: -122.0841 }; // where the docs' example sun events are for (computed within 2 s)
  test("its sunrise and sunset agree with the computed sun at their place, and are an anomaly elsewhere", () => {
    expect(googleSlices(gCurrent, gDays, gHours, fetchedAt, fetchedAt, mountainView).anomaly).toBeUndefined();
    expect(googleSlices(gCurrent, gDays, gHours, fetchedAt, fetchedAt, sydney).anomaly).toMatch(/^google sunrise 2025-02-10T15:02:35\.703929582Z is [\d.]+ min from the computed .*; google sunset/);
  });
  test("near solar midnight at high latitude it still pairs each event with the nearest computed one", () => {
    const tromso = { latitude: 69.65, longitude: 18.96 }; // mid-May: sunrise about half an hour after the solar nadir
    for (let day = 14; day <= 17; day++) {
      const sunrise = sunNow(tromso.latitude, tromso.longitude, Date.UTC(2026, 4, day, 12)).sunrise!;
      const late = new Date(Date.parse(sunrise) + 90_000).toISOString();
      expect(sunDisagrees("x", tromso.latitude, tromso.longitude, { sunrise: late })).toBeUndefined();
    }
  });

  test("two minutes is the line: 1.9 min out is quiet, 2.1 min out is said", () => {
    const sunrise = sunNow(sydney.latitude, sydney.longitude, at).sunrise!;
    const shifted = (min: number) => new Date(Date.parse(sunrise) + min * 60_000).toISOString();
    expect(sunDisagrees("x", sydney.latitude, sydney.longitude, { sunrise: shifted(1.9) })).toBeUndefined();
    expect(sunDisagrees("x", sydney.latitude, sydney.longitude, { sunrise: shifted(-2.1) })).toBe(`x sunrise ${shifted(-2.1)} is 2.1 min from the computed ${sunrise}`);
  });
  test("current, one day and one hour", () => {
    const r = googleSlices(gCurrent, gDays, gHours, fetchedAt);
    expect(r.anomaly).toBeUndefined();
    expect(r.now).toMatchObject({ source: "google", modelled: true, at: "2025-01-28T22:04:12.025Z", tempC: 13.7, apparentC: 13.1, humidity: 42, windKmh: 8, windDir: "NORTH_NORTHWEST", windDeg: 335, gustKmh: 18 });
    expect(r.sky!.radiationWm2).toBeUndefined(); // Google has no radiation
    expect(r.sky).toMatchObject({ cloudPct: 0, uvIndex: 1, hours: [{ at: "2025-02-05T23:00:00.000Z", cloudPct: 0, uvIndex: 1 }] });
    expect(r.forecast!.today).toEqual({ date: "2025-02-10", minC: 1.5, maxC: 13.3, rainChance: 10, rainMm: 0, text: "Partly sunny", code: "PARTLY_CLOUDY" });
    expect(r.forecast!.tomorrow).toBeUndefined();
  });

  test("a unit other than the metric one asked for is flagged, not converted", () => {
    const f = structuredClone(gCurrent);
    f.temperature = { degrees: 56.6, unit: "FAHRENHEIT" };
    const r = googleSlices(f, gDays, gHours, fetchedAt);
    expect(r.now!.tempC).toBeUndefined();
    expect(r.anomaly).toBe("temperature in FAHRENHEIT");
  });

  test("odd times are flagged, not thrown: a bad hour is skipped, a bad current time drops now and sky only", () => {
    const hours = structuredClone(gHours);
    hours.forecastHours[0].interval.startTime = "nope";
    const current = structuredClone(gCurrent);
    current.currentTime = "nope";
    const r = googleSlices(current, gDays, hours, fetchedAt);
    expect(r.now).toBeUndefined();
    expect(r.sky).toBeUndefined();
    expect(r.forecast?.today?.maxC).toBe(13.3);
    expect(r.anomaly).toBe("currentTime not understood: nope; forecast hour time not understood: nope");
    expect(googleSlices(gCurrent, gDays, hours, fetchedAt).sky!.hours).toEqual([]);
  });

  const minutesFetch = (asked: string[], minutes: () => Response = () => new Response(JSON.stringify(gMinutes))) =>
    (async (url: string) => {
      const path = new URL(url).pathname.split("/").slice(2).join("/");
      asked.push(path);
      if (path.startsWith("forecast/minutes")) return minutes();
      return new Response(JSON.stringify(path.startsWith("currentConditions") ? gCurrent : path.startsWith("forecast/days") ? gDays : gHours));
    }) as unknown as typeof fetch;

  test("rain every 15 minutes; current every 30; the day and hour forecasts hourly; force reads them now", async () => {
    const asked: string[] = [];
    const g = google({ key: "k", fetch: minutesFetch(asked) });
    expect(g.minPollMinutes).toBe(15);
    const t0 = Date.parse("2025-02-10T20:05:00Z");
    const min = 60_000;
    const first = await g.read({ ...req(t0), pollMinutes: 15 });
    expect(new Date(first.nextAt).toISOString()).toBe("2025-02-10T20:20:00.000Z");
    expect(asked.sort()).toEqual(["currentConditions:lookup", "forecast/days:lookup", "forecast/hours:lookup", "forecast/minutes:lookup"]);
    asked.length = 0;
    const quarter = await g.read({ ...req(t0 + 15 * min), pollMinutes: 15 });
    expect(asked).toEqual(["forecast/minutes:lookup"]); // rain only
    expect(quarter.now).toEqual(first.now); // kept, with its own times
    asked.length = 0;
    await g.read({ ...req(t0 + 30 * min), pollMinutes: 15 });
    expect(asked.sort()).toEqual(["currentConditions:lookup", "forecast/minutes:lookup"]);
    asked.length = 0;
    const hour = await g.read({ ...req(t0 + 60 * min), pollMinutes: 15 });
    expect(asked.sort()).toEqual(["currentConditions:lookup", "forecast/days:lookup", "forecast/hours:lookup", "forecast/minutes:lookup"]);
    expect(hour.forecast?.fetchedAt).toBe(new Date(t0 + 60 * min).toISOString());
    asked.length = 0;
    await g.read({ ...req(t0 + 61 * min), pollMinutes: 15, force: true });
    expect(asked).toHaveLength(4);
  });

  test("the minute forecast keeps two hours of 15-minute segments, as given", () => {
    const { rain, anomaly } = toRain(gMinutes, fetchedAt);
    expect(anomaly).toBeUndefined();
    expect(rain).toMatchObject({ source: "google", modelled: true, at: "2025-02-10T20:00:00.000Z" });
    expect(rain!.segments).toHaveLength(9); // 19:45 to 21:45 starts; the 22:15 shower is past the window
    expect(rain!.segments[2]).toEqual({ from: "2025-02-10T20:15:00.000Z", to: "2025-02-10T20:30:00.000Z", type: "RAIN", chance: 40, mm: 0.2, intensity: "LIGHT" });
  });

  test("a rain amount in another unit is flagged, not converted; an odd segment time is skipped and said", () => {
    const m = structuredClone(gMinutes);
    m.segments[2].qpf = { unit: "INCHES", quantity: 0.01 };
    m.segments[3].timeFrame.startTime = "nope";
    const { rain, anomaly } = toRain(m, fetchedAt);
    expect(rain!.segments.find((x) => x.from === "2025-02-10T20:15:00.000Z")!.mm).toBeUndefined();
    expect(rain!.segments).toHaveLength(8);
    expect(anomaly).toBe("rain in INCHES; minute forecast segment time not understood: nope");
  });

  test("a body that is not the documented shape is noted, not thrown", () => {
    for (const body of [null, "x", 5, { segments: "no" }]) expect(toRain(body, fetchedAt)).toEqual({ anomaly: "minute forecast not understood: the response is not the documented shape" });
  });
  test("an intensity we do not know is noted", () => {
    const m = structuredClone(gMinutes);
    m.segments[2].intensity = "TORRENTIAL";
    expect(toRain(m, fetchedAt).anomaly).toBe("rain intensity not understood: TORRENTIAL");
  });

  test("no start time or no segments is no slice", () => {
    expect(toRain({ segments: gMinutes.segments }, fetchedAt).rain).toBeUndefined();
    expect(toRain({ overallPredictionTimeframe: gMinutes.overallPredictionTimeframe, segments: [] }, fetchedAt).rain).toBeUndefined();
  });

  test("a failed minute forecast is a problem on rain; the other slices still read and the source goes on", async () => {
    for (const status of [404, 403, 500]) {
      const g = google({ key: "k", fetch: minutesFetch([], () => new Response("no", { status })) });
      const r = await g.read({ ...req(Date.parse("2025-02-10T20:05:00Z")), pollMinutes: 15 });
      expect(r.stop).toBeUndefined();
      expect(r.now?.source).toBe("google");
      expect(r.rain).toBeUndefined();
      expect(r.problem).toMatch(/^google minute forecast: /);
    }
  });

  test("a failed current read still takes the fresh minute forecast, and says what failed", async () => {
    const asked: string[] = [];
    const f = (async (url: string) => {
      const path = new URL(url).pathname.split("/").slice(2).join("/");
      asked.push(path);
      return path.startsWith("forecast/minutes") ? new Response(JSON.stringify(gMinutes)) : new Response("down", { status: 500 });
    }) as unknown as typeof fetch;
    const r = await google({ key: "k", fetch: f }).read({ ...req(Date.parse("2025-02-10T20:05:00Z")), pollMinutes: 15 });
    expect(r.stop).toBeUndefined();
    expect(r.now).toBeUndefined();
    expect(r.rain?.segments).toHaveLength(10);
    expect(r.problem).toMatch(/^google: HTTP 500/);
  });

  test("a later failure keeps the last rain, which ages out by its own times", async () => {
    let fail = false;
    const g = google({ key: "k", fetch: minutesFetch([], () => (fail ? new Response("no", { status: 500 }) : new Response(JSON.stringify(gMinutes)))) });
    const t0 = Date.parse("2025-02-10T20:05:00Z");
    await g.read({ ...req(t0), pollMinutes: 15 });
    fail = true;
    const r = await g.read({ ...req(t0 + 15 * 60_000), pollMinutes: 15 });
    expect(r.rain?.segments).toHaveLength(10);
    expect(r.problem).toMatch(/minute forecast/);
    const readings = [{ source: g, reading: r }];
    expect(mergeWeather(readings, t0 + 15 * 60_000, 15).rain).toBeDefined();
    expect(mergeWeather(readings, t0 + 60 * 60_000, 15).rain).toBeUndefined(); // older than 15 + 15 min: dropped, not served
  });

  test("a rejected key stops the source", async () => {
    const f = (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch;
    expect(await google({ key: "k", fetch: f }).read(req(fetchedAt))).toEqual({ stop: "google: key rejected or request refused (HTTP 403)", nextAt: Infinity });
  });
});

describe("rainSoon", () => {
  const rain = toRain(gMinutes, Date.parse("2025-02-10T20:00:00Z")).rain!;
  const t = (hhmm: string) => Date.parse(`2025-02-10T${hhmm}:00Z`);
  test("rain 15 minutes away: when it starts and ends, its chance, amount and weight", () => {
    const r = rainSoon(rain, t("20:00"))!;
    expect(r).toMatchObject({ wet: true, startsInMin: 15, endsInMin: 45, chance: 70, intensity: "MODERATE", type: "RAIN", coveredMin: 120 });
    expect(r.mm).toBeCloseTo(0.8);
    expect(rainText(rain, rainSoon(rain, t("20:00")))).toBe("rain in 15 min, ends in 45 min, 70%, 0.8 mm, moderate (google)");
  });
  test("inside the wet stretch it is raining now; a segment that began minutes ago still counts", () => {
    const r = rainSoon(rain, t("20:20"))!;
    expect(r).toMatchObject({ wet: true, startsInMin: 0, endsInMin: 25 });
    expect(r.coveredMin).toBe(100); // the forecast ends at 22:00, the window at 22:20
    expect(rainText(rain, rainSoon(rain, t("20:20")))).toMatch(/^raining, ends in 25 min, 70%/);
  });
  test("a forecast that stops while it is still raining does not say when the rain ends", () => {
    const m = structuredClone(gMinutes);
    m.segments = m.segments.slice(0, 4); // ends 20:45 after wet 20:15 to 20:45
    const short = toRain(m, t("20:00")).rain!;
    const r = rainSoon(short, t("20:00"))!;
    expect(r).toMatchObject({ wet: true, startsInMin: 15, coveredMin: 45 });
    expect(r.endsInMin).toBeUndefined();
    expect(rainText(short, r)).toMatch(/^rain in 15 min, 70%/);
  });
  test("dry says how much it covers; a shorter window is respected", () => {
    expect(rainSoon(rain, t("20:50"))).toEqual({ wet: false, coveredMin: 70 });
    expect(rainText(rain, rainSoon(rain, t("20:50")))).toBe("no rain for 70 min (google)");
    expect(rainSoon(rain, t("20:00"), 10)).toEqual({ wet: false, coveredMin: 10 });
  });
  test("a forecast that is over covers nothing, so it says nothing", () => {
    expect(rainSoon(rain, t("22:30"))).toBeUndefined();
    expect(rainText(rain, rainSoon(rain, t("22:30")))).toBe("");
    expect(rainSoon(undefined, t("20:00"))).toBeUndefined();
  });
  test("a segment with no type is unknown, not dry; a wet one with no chance or amount says so", () => {
    const m = structuredClone(gMinutes);
    delete m.segments[2].type;
    delete m.segments[3].probability;
    delete m.segments[3].qpf;
    const r = rainSoon(toRain(m, t("20:00")).rain, t("20:00"))!;
    expect(r).toMatchObject({ wet: true, startsInMin: 30, coveredMin: 105 });
    expect(r.chance).toBeUndefined();
    expect(r.mm).toBeUndefined();
  });
});

/** A source that returns fixed slices. */
const fake = (name: string, reading: Omit<SourceReading, "nextAt">, owns: WeatherSource["owns"] = { now: 3_600_000, forecast: 86_400_000, sky: 3_600_000 }): WeatherSource => ({
  name,
  owns,
  read: async ({ at: t }) => ({ ...reading, nextAt: t + 600_000 }),
});
const meta = (source: string, modelled: boolean, iso: string) => ({ source, modelled, at: iso, fetchedAt: iso });

describe("mergeWeather", () => {
  const bomNow = { ...meta("bom", false, "2026-10-13T09:10:00Z"), tempC: 16.4 };
  const omNow = { ...meta("open-meteo", true, "2026-10-13T09:15:00Z"), tempC: 16.3 };
  const omSky = { ...meta("open-meteo", true, "2026-10-13T09:15:00Z"), cloudPct: 100, hours: [] };
  const sources = [fake("bom", { now: bomNow }), fake("open-meteo", { now: omNow, sky: omSky })];

  test("each slice from the first source that has it, in preference order", () => {
    const w = mergeWeather(sources.map((source) => ({ source, reading: { now: source.name === "bom" ? bomNow : omNow, sky: source.name === "bom" ? undefined : omSky, nextAt: 0 } })), at);
    expect(w.now?.source).toBe("bom");
    expect(w.sky?.source).toBe("open-meteo");
    expect(w.forecast).toBeUndefined();
  });

  test("a slice older than its source allows falls through to the next source", () => {
    const later = Date.parse("2026-10-13T10:30:00Z"); // 80 minutes: past the fake's hour plus one 15-minute poll
    const w = mergeWeather([{ source: sources[0]!, reading: { now: bomNow, nextAt: 0 } }, { source: sources[1]!, reading: { now: { ...omNow, at: "2026-10-13T10:00:00Z" }, nextAt: 0 } }], later);
    expect(w.now).toMatchObject({ source: "open-meteo", modelled: true });
  });
});

describe("weather integration", () => {
  test("composes the sources and the sun into one part", async () => {
    const stop = new AbortController();
    let sleeps = 0;
    const clock: Clock = { now: () => at, sleep: async () => void (++sleeps >= 3 && stop.abort()) };
    const sources = [
      fake("bom", { now: { ...meta("bom", false, "2026-10-13T09:10:00Z"), tempC: 16.4 }, problem: "bom forecast: no forecastLocation set" }),
      fake("open-meteo", { forecast: { ...meta("open-meteo", true, "2026-10-13T09:20:00Z") }, sky: { ...meta("open-meteo", true, "2026-10-13T09:15:00Z"), cloudPct: 100, hours: [] } }),
    ];
    const home = createHome([weather({ ...sydney, sources, clock })]);
    await home.start(stop.signal);
    const part = home.snapshot().weather!;
    expect(part).toMatchObject({ status: "connected", detail: "bom forecast: no forecastLocation set" });
    expect(part.state).toMatchObject({ now: { source: "bom", tempC: 16.4 }, forecast: { source: "open-meteo" }, sky: { cloudPct: 100 }, sun: { at: new Date(at).toISOString() } });
  });

  test("the hourly forecast becomes day blocks in the config's time zone, recomputed at each report", async () => {
    const stop = new AbortController();
    const t = Date.parse("2026-10-16T05:50:00Z");
    let sleeps = 0;
    const clock: Clock = { now: () => t, sleep: async () => void (++sleeps >= 3 && stop.abort()) };
    const hourly = openMeteoSlices(openMeteoJson, t).hourly!;
    const home = createHome([weather({ ...sydney, sources: [fake("open-meteo", { hourly }, { hourly: 6 * 3_600_000 })], timeZone: "Australia/Sydney", clock })]);
    await home.start(stop.signal);
    const part = home.snapshot().weather as Part<WeatherState>;
    expect(part.state!.timeZone).toBe("Australia/Sydney");
    expect(part.state!.blocks).toEqual(dayBlocks(hourly, t, "Australia/Sydney"));
    expect(manifest.lines(part)[1]).toStartWith("today: afternoon from 16:00 18–18.2 °C, clear");
  });

  test("refresh reads every source now, with force, before the interval is up", async () => {
    const stop = new AbortController();
    const stuck: Clock = { now: () => at, sleep: (_ms, signal) => new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })) };
    const forces: (boolean | undefined)[] = [];
    const source: WeatherSource = { name: "open-meteo", owns: { now: 1 }, read: async ({ force }) => (forces.push(force), { nextAt: at + 900_000 }) };
    const w = weather({ ...sydney, sources: [source], clock: stuck });
    const running = createHome([w]).start(stop.signal);
    await Bun.sleep(0);
    expect(forces).toEqual([false]);
    w.refresh();
    await Bun.sleep(0);
    expect(forces).toEqual([false, true]);
    stop.abort();
    await running;
  });

  test("a source's floor wins over a shorter shared interval", async () => {
    const stop = new AbortController();
    let sleeps = 0;
    const clock: Clock = { now: () => at, sleep: async () => void (++sleeps >= 2 && stop.abort()) };
    const asked: number[] = [];
    const billed: WeatherSource = { name: "google", owns: { now: 1 }, minPollMinutes: 30, read: async ({ pollMinutes }) => (asked.push(pollMinutes), { nextAt: at + 1 }) };
    const free: WeatherSource = { name: "open-meteo", owns: { now: 1 }, read: async ({ pollMinutes }) => (asked.push(pollMinutes), { nextAt: at + 1 }) };
    await createHome([weather({ ...sydney, sources: [billed, free], clock })]).start(stop.signal);
    expect(asked.slice(0, 2)).toEqual([30, 15]);
  });

  test("refresh forces a source without a floor, and leaves a billed source alone inside its floor", async () => {
    const stop = new AbortController();
    const stuck: Clock = { now: () => at, sleep: (_ms, signal) => new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })) };
    const forces: Record<string, (boolean | undefined)[]> = { google: [], "open-meteo": [] };
    const source = (name: string, minPollMinutes?: number): WeatherSource => ({ name, owns: { now: 1 }, minPollMinutes, read: async ({ force }) => (forces[name]!.push(force), { nextAt: at + 900_000 }) });
    const w = weather({ ...sydney, sources: [source("open-meteo"), source("google", 30)], clock: stuck });
    const running = createHome([w]).start(stop.signal);
    await Bun.sleep(0);
    w.refresh();
    await Bun.sleep(0);
    expect(forces).toEqual({ "open-meteo": [false, true], google: [false] });
    stop.abort();
    await running;
  });

  test("a refresh inside a billed source's floor still gets an answer, without a read", async () => {
    const stop = new AbortController();
    const stuck: Clock = { now: () => at, sleep: (_ms, signal) => new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })) };
    let reads = 0;
    const google: WeatherSource = { name: "google", owns: { now: 1 }, minPollMinutes: 30, read: async () => (reads++, { nextAt: at + 900_000 }) };
    const home = createHome([weather({ ...sydney, sources: [google], clock: stuck })]);
    const running = home.start(stop.signal);
    await Bun.sleep(0);
    await home.refresh("weather"); // resolves, rather than waiting for the 5-minute sun tick
    expect(reads).toBe(1);
    stop.abort();
    await running;
  });

  test("pollMinutes below 1 is refused", () => {
    expect(() => weather({ ...sydney, pollMinutes: 0 })).toThrow("weather: pollMinutes must be at least 1, got 0");
  });

  test("unavailable once every source has stopped", async () => {
    const stop = new AbortController();
    let sleeps = 0;
    const clock: Clock = { now: () => at, sleep: async () => void (++sleeps >= 2 && stop.abort()) };
    const dead: WeatherSource = { name: "google", owns: { now: 1 }, read: async () => ({ stop: "google: key rejected", nextAt: Infinity }) };
    const home = createHome([weather({ ...sydney, sources: [dead], clock })]);
    await home.start(stop.signal);
    expect(home.snapshot().weather).toMatchObject({ status: "unavailable", detail: "google: key rejected" });
  });

  test("one stopped source and one live one: connected, with the stop in detail", async () => {
    const stop = new AbortController();
    let sleeps = 0;
    const clock: Clock = { now: () => at, sleep: async () => void (++sleeps >= 2 && stop.abort()) };
    const dead: WeatherSource = { name: "bom", owns: { now: 1 }, read: async () => ({ stop: "bom: plain fetch cannot read ftp://", nextAt: Infinity }) };
    const live = fake("open-meteo", { now: { ...meta("open-meteo", true, new Date(at).toISOString()), tempC: 16.3 } });
    const home = createHome([weather({ ...sydney, sources: [dead, live], clock })]);
    await home.start(stop.signal);
    expect(home.snapshot().weather).toMatchObject({ status: "connected", detail: "bom: plain fetch cannot read ftp://", state: { now: { source: "open-meteo" } } });
  });

  test("a read that brings only the last good slices is a failed read: disconnected, the data kept", async () => {
    const stop = new AbortController();
    let sleeps = 0;
    const clock: Clock = { now: () => at, sleep: async () => void (++sleeps >= 2 && stop.abort()) };
    const old = fake("open-meteo", { now: { ...meta("open-meteo", true, "2026-10-13T09:15:00Z"), tempC: 16.3 }, problem: "open-meteo: fetch failed" });
    const home = createHome([weather({ ...sydney, sources: [old], clock })]);
    await home.start(stop.signal);
    expect(home.snapshot().weather).toMatchObject({ status: "disconnected", detail: "open-meteo: fetch failed", state: { now: { tempC: 16.3 } } });
  });

  test("the 5-minute sun tick re-reports without moving lastGoodAt: only a read does", async () => {
    const { manualClock } = await import("./clock.ts");
    const { clock, advance } = manualClock();
    const once: WeatherSource = { name: "open-meteo", owns: { now: 3_600_000 }, read: async ({ at: t }) => ({ now: { ...meta("open-meteo", true, new Date(t).toISOString()), tempC: 16 }, nextAt: t + 3_600_000 }) };
    const home = createHome([weather({ ...sydney, sources: [once], clock })], undefined, { clock });
    const stop = new AbortController();
    const running = home.start(stop.signal);
    await advance(0);
    const first = home.part("weather")!.lastGoodAt;
    expect(first).toBe(new Date(0).toISOString());
    await advance(10 * 60_000); // two sun ticks
    expect(home.part("weather")).toMatchObject({ status: "connected", lastGoodAt: first });
    stop.abort();
    await running;
  });

  test("a refresh once every source has stopped is answered at once", async () => {
    const stop = new AbortController();
    const stuck: Clock = { now: () => at, sleep: (_ms, signal) => new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })) };
    const dead: WeatherSource = { name: "google", owns: { now: 1 }, read: async () => ({ stop: "google: key rejected", nextAt: Infinity }) };
    const home = createHome([weather({ ...sydney, sources: [dead], clock: stuck })]);
    const running = home.start(stop.signal);
    await Bun.sleep(0);
    await home.refresh("weather");
    expect(home.part("weather")?.status).toBe("unavailable");
    stop.abort();
    await running;
  });
});

describe("dayBlocks", () => {
  const hourly = openMeteoSlices(openMeteoJson, Date.parse("2026-10-16T05:50:00Z")).hourly!;
  const zone = "Australia/Sydney";

  test("the rest of today and all of tomorrow, cut in the home's time zone", () => {
    const b = dayBlocks(hourly, Date.parse("2026-10-16T05:50:00Z"), zone)!; // 16:50
    expect(b.source).toBe("open-meteo");
    expect(b.today.map((x) => [x.name, x.hours])).toEqual([["afternoon", 2], ["evening", 4]]); // the 16:00 hour has not ended
    expect(b.tomorrow.map((x) => [x.name, x.date, x.hours])).toEqual([["morning", "2026-10-17", 6], ["afternoon", "2026-10-17", 6], ["evening", "2026-10-17", 4]]);
    expect(b.tomorrow[0]).toEqual({ name: "morning", date: "2026-10-17", from: "2026-10-16T19:00:00.000Z", to: "2026-10-17T01:00:00.000Z", hours: 6, minC: 14.2, maxC: 18.5, rainChance: 45, rainMm: 0.2, windKmh: 13.4, gustKmh: 33.5, uvIndex: 3.6, condition: "drizzle" });
  });

  test("the same hours on a machine in UTC are cut by UTC's day, which is why the home's zone is passed", () => {
    const b = dayBlocks(hourly, Date.parse("2026-10-16T05:50:00Z"), "UTC")!;
    expect(b.today.map((x) => x.name)).toEqual(["morning", "afternoon", "evening"]); // 05:50 UTC is still morning there
  });

  test("a part's worst hour sets its condition; a missing amount leaves the sum out, not zero", () => {
    const h = structuredClone(hourly);
    const i = h.hours.findIndex((x) => x.at === "2026-10-17T03:00:00.000Z"); // 14:00 tomorrow
    h.hours[i] = { ...h.hours[i]!, condition: "storm", rainMm: undefined };
    const afternoon = dayBlocks(h, Date.parse("2026-10-16T05:50:00Z"), zone)!.tomorrow[1]!;
    expect(afternoon.condition).toBe("storm");
    expect(afternoon.rainMm).toBeUndefined();
    expect(afternoon.rainChance).toBe(43);
  });

  test("tomorrow is the next calendar day, on a 25-hour day too", () => {
    // Sydney left daylight saving at 3am on 2026-04-05; 00:30 that day plus 24 hours is still the 5th.
    const t = Date.parse("2026-04-04T13:30:00Z");
    const h = { ...hourly, hours: [{ at: "2026-04-05T21:00:00.000Z", tempC: 20 }] }; // 07:00 on the 6th, at +10
    expect(dayBlocks(h, t, zone)!.tomorrow.map((b) => [b.name, b.date])).toEqual([["morning", "2026-04-06"]]);
  });

  test("a consumer's own parts of the day, with UV shown from 3", () => {
    const own = [{ name: "Morning", from: 6, to: 11 }, { name: "Noon", from: 11, to: 15 }, { name: "Evening", from: 15, to: 20 }, { name: "Night", from: 20, to: 24 }];
    const b = dayBlocks(hourly, Date.parse("2026-10-16T05:50:00Z"), zone, own)!;
    expect(b.today.map((x) => [x.name, x.hours, x.late])).toEqual([["Evening", 4, true], ["Night", 4, undefined]]);
    expect(b.tomorrow.map((x) => x.name)).toEqual(["Morning", "Noon", "Evening", "Night"]);
    expect(blockText(b.today[1]!, zone)).not.toContain("UV"); // night
  });

  test("a block a day cannot hold throws", () => {
    expect(() => dayBlocks(hourly, 0, zone, [{ name: "night", from: 22, to: 6 }])).toThrow(RangeError);
    expect(() => dayBlocks(hourly, 0, zone, [{ name: "brunch", from: 9.5, to: 12 }])).toThrow(RangeError);
    expect(() => weather({ ...sydney, blocks: [{ name: "late", from: 20, to: 25 }] })).toThrow(RangeError);
  });

  test("no hourly forecast, no blocks", () => {
    expect(dayBlocks(undefined, at, zone)).toBeUndefined();
  });

  test("in words, with the start when a part is under way", () => {
    const b = dayBlocks(hourly, Date.parse("2026-10-16T05:50:00Z"), zone)!;
    expect(blockText(b.today[0]!, zone)).toBe("afternoon from 16:00 18–18.2 °C, clear, rain 12%, wind 16.5 km/h gusting 41.8, UV 3.15");
    expect(blockText(b.tomorrow[0]!, zone)).toBe("morning 14.2–18.5 °C, drizzle, rain 45% 0.2 mm, wind 13.4 km/h gusting 33.5, UV 3.6");
  });
});

describe("weather text in the home's time zone", () => {
  test("times read in the config's zone, whatever the machine's", () => {
    const now = { ...meta("open-meteo", true, "2026-10-13T09:15:00Z"), tempC: 16.3 };
    const sun = sunNow(sydney.latitude, sydney.longitude, at);
    expect(weatherText({ now, timeZone: "Australia/Sydney" }, sun)).toStartWith("open-meteo 20:15 modelled: 16.3 °C");
    expect(weatherText({ now, timeZone: "UTC" }, sun)).toStartWith("open-meteo 09:15 modelled: 16.3 °C");
  });
});
