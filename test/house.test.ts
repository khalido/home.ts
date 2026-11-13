import { describe, expect, test } from "bun:test";
import type { DaikinSnapshot } from "../src/connectors/daikin/index.ts";
import type { EnphaseSnapshot } from "../src/connectors/enphase/index.ts";
import { Resource } from "../src/connectors/hue/schemas.ts";
import { snapshotFrom } from "../src/connectors/hue/state.ts";
import type { WeatherState } from "../src/connectors/weather/index.ts";
import { houseSummary, type Part, ventilation } from "../src/index.ts";

const AT = "2026-11-13T09:00:00.000Z";
const ok = <S>(state: S): Part<S> => ({ status: "connected", state });
// The Hue fixture: Floor lamp on and Shelf off, both in the room Living.
const hue = snapshotFrom(
  Resource.array().parse(
    (
      await Bun.file(
        new URL("./fixtures/resources.json", import.meta.url),
      ).json()
    ).data,
  ),
  AT,
);
const ac = (s: Partial<DaikinSnapshot>): DaikinSnapshot => ({
  on: false,
  mode: "cool",
  targetC: 25,
  asOf: AT,
  ...s,
});
const outside = (
  tempC: number | undefined,
  extra: Partial<WeatherState> = {},
): WeatherState =>
  ({
    now:
      tempC === undefined
        ? undefined
        : { tempC, humidity: 60, at: AT, source: "bom" },
    rainSoon: { wet: false, coveredMin: 120 },
    sources: {},
    ...extra,
  }) as unknown as WeatherState;
const house = (
  inside: Partial<DaikinSnapshot>,
  out: WeatherState,
): Record<string, Part> => ({
  daikin: ok(ac(inside)),
  weather: ok(out),
});

describe("ventilation", () => {
  test("hot inside and 2 °C cooler outside: open", () => {
    expect(ventilation(house({ roomC: 27 }, outside(22)))).toEqual({
      advice: "open",
      why: "cooler outside",
      insideC: 27,
      outsideC: 22,
      outsideHumidity: 60,
    });
  });

  test("hot inside and hotter outside: close; within 2 °C: either", () => {
    expect(ventilation(house({ roomC: 27 }, outside(31))).advice).toBe("close");
    expect(ventilation(house({ roomC: 27 }, outside(25.6))).advice).toBe(
      "either",
    );
  });

  test("comfortable inside: well past the band outside closes them, else either", () => {
    expect(ventilation(house({ roomC: 23 }, outside(38)))).toMatchObject({
      advice: "close",
      why: "hot outside",
    });
    expect(ventilation(house({ roomC: 21 }, outside(10))).why).toBe(
      "cold outside",
    );
    expect(ventilation(house({ roomC: 22 }, outside(25))).advice).toBe(
      "either",
    );
  });

  test("cold inside: warmer outside opens, colder closes", () => {
    expect(ventilation(house({ roomC: 17 }, outside(21))).advice).toBe("open");
    expect(ventilation(house({ roomC: 17 }, outside(12))).advice).toBe("close");
  });

  test("rain within 30 minutes, or the AC cooling, closes them whatever the temperatures", () => {
    const soon = outside(18, {
      rainSoon: { wet: true, startsInMin: 20, coveredMin: 120 },
    });
    expect(ventilation(house({ roomC: 27 }, soon))).toMatchObject({
      advice: "close",
      why: "rain in 20 min",
    });
    const later = outside(18, {
      rainSoon: { wet: true, startsInMin: 90, coveredMin: 120 },
    });
    expect(ventilation(house({ roomC: 27 }, later)).advice).toBe("open");
    expect(
      ventilation(house({ roomC: 27, on: true, mode: "cool" }, outside(18))),
    ).toMatchObject({ advice: "close", why: "the AC is cooling" });
    expect(
      ventilation(house({ roomC: 27, on: true, mode: "auto" }, outside(18))),
    ).toMatchObject({ advice: "close", why: "the AC is on (auto)" });
    expect(
      ventilation(house({ roomC: 27, on: true, mode: "fan" }, outside(18)))
        .advice,
    ).toBe("open"); // a fan only moves the air: the window helps
  });

  test("humid outside is said, not weighed; a missing reading is unknown, saying which", () => {
    const humid = outside(20);
    humid.now!.humidity = 90;
    expect(ventilation(house({ roomC: 27 }, humid)).why).toBe(
      "cooler outside, humid out (90%)",
    );
    expect(ventilation(house({}, outside(20)))).toMatchObject({
      advice: "unknown",
      why: "no inside temperature",
    });
    expect(ventilation({ daikin: ok(ac({ roomC: 25 })) }).why).toBe(
      "no outside temperature",
    );
  });

  test("a part that isn't connected isn't read", () => {
    expect(
      ventilation({
        daikin: { status: "disconnected", state: ac({ roomC: 27 }) },
        weather: ok(outside(20)),
      }).advice,
    ).toBe("unknown");
  });
});

describe("houseSummary", () => {
  const NOW = Date.parse(AT);
  const enphase = {
    productionW: 2400,
    consumptionW: 900,
    netW: -1500,
    source: "meter",
    tokenDaysLeft: 200,
    asOf: AT,
  } as EnphaseSnapshot;

  test("lights by room, the AC, energy, outside and the windows, each said once", () => {
    expect(
      houseSummary(
        {
          hue: ok(hue),
          daikin: ok(ac({ roomC: 27 })),
          enphase: ok(enphase),
          weather: ok(outside(22)),
        },
        undefined,
        { now: NOW },
      ),
    ).toBe(
      "1 light on: Living 1. Daikin: off · cool 25 °C · room 27 °C. Solar 2.4 kW, using 0.9 kW, exporting 1.5 kW. 22 °C outside. Windows better open (cooler outside).",
    );
  });

  test("rain is said once: the windows don't repeat it", () => {
    const wet = outside(18, {
      rainSoon: { wet: true, startsInMin: 20, coveredMin: 120 },
    });
    expect(
      houseSummary(
        { daikin: ok(ac({ roomC: 27 })), weather: ok(wet) },
        undefined,
        {
          now: NOW,
        },
      ),
    ).toEndWith("18 °C outside, rain in 20 min. Windows better closed.");
  });

  test("what plays: the speaker, and a Cast device playing but not a member of a playing group or a paused one", () => {
    const device = (id: string, name: string, extra: object) => ({
      id,
      name,
      kind: "device",
      status: "connected",
      idle: false,
      asOf: AT,
      ...extra,
    });
    const cast = ok({
      devices: {
        a: device("a", "Den speaker", {
          form: "speaker",
          app: "Spotify",
          playerState: "PLAYING",
          title: "Song",
        }),
        b: device("b", "Living TV", {
          form: "tv",
          app: "YouTube",
          playerState: "PAUSED",
          title: "Clip",
        }),
      },
      asOf: AT,
    });
    const spotify = ok({
      loggedIn: true,
      deviceName: "Chota",
      active: true,
      status: "playing",
      track: { name: "Tune", artists: ["Band"] },
      volume: 40,
      asOf: AT,
    });
    const text = houseSummary(
      { cast, spotify } as Record<string, Part>,
      undefined,
      {
        now: NOW,
      },
    );
    expect(text).toContain("Den speaker");
    expect(text).not.toContain("Living TV");
    expect(text).toContain("Chota: playing");
  });

  test("a printer out of paper is said; an idle one isn't", () => {
    const printer = (reasons: string[]) =>
      ok({
        printers: {
          p: {
            uuid: "p",
            name: "Laser",
            state: "idle",
            reasons,
            ipps: false,
            asOf: AT,
          },
        },
        asOf: AT,
      });
    expect(
      houseSummary({ printers: printer(["media-empty"]) }, undefined, {
        now: NOW,
      }),
    ).toContain("Laser");
    expect(
      houseSummary({ printers: printer(["none"]) }, undefined, { now: NOW }),
    ).toBe("Nothing read yet.");
  });

  test("down by health's rules, not during a reconnect; a rejected key is said apart", () => {
    const since = (ms: number) => new Date(NOW - ms).toISOString();
    expect(
      houseSummary(
        {
          hue: { status: "disconnected", downSince: since(5_000) },
          daikin: { status: "disconnected", downSince: since(3_600_000) },
          amber: { status: "unavailable", reason: "auth" },
        },
        undefined,
        { now: NOW },
      ),
    ).toBe("Not answering: daikin. Needs a new key: amber.");
    expect(houseSummary({}, undefined, { now: NOW })).toBe("Nothing read yet.");
  });
});
