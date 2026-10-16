import { describe, expect, test } from "bun:test";
import { manifest as amber } from "../src/connectors/amber/index.ts";
import { toPrices } from "../src/connectors/amber/client.ts";
import { manifest as cast, type CastSnapshot } from "../src/connectors/cast/index.ts";
import { manifest as daikin } from "../src/connectors/daikin/index.ts";
import { toState } from "../src/connectors/daikin/client.ts";
import { manifest as enphase, type EnphaseSnapshot } from "../src/connectors/enphase/index.ts";
import { manifest as hue } from "../src/connectors/hue/index.ts";
import { Resource } from "../src/connectors/hue/schemas.ts";
import { snapshotFrom } from "../src/connectors/hue/state.ts";
import { manifest as weather, sunNow, type WeatherState } from "../src/connectors/weather/index.ts";
import { MANIFESTS } from "../src/manifests.ts";
import { envExampleText } from "../scripts/gen.ts";

const fixture = async (path: string) => JSON.parse(await Bun.file(new URL(`./fixtures/${path}`, import.meta.url)).text());
const AT = "2026-10-14T00:00:00Z";

describe("manifests", () => {
  test("one per connector, each env name once", () => {
    expect(MANIFESTS.map((m) => m.name)).toEqual(["hue", "daikin", "enphase", "amber", "weather", "cast", "printers"]);
    const names = MANIFESTS.flatMap((m) => m.env.map((e) => e.name));
    expect(new Set(names).size).toBe(names.length);
  });

  test("the committed .env.example matches the manifests (run `bun run gen`)", async () => {
    expect(await Bun.file(new URL("../.env.example", import.meta.url)).text()).toBe(envExampleText());
  });

  test(".env.example: every manifest's names in order, HOME_CONFIG last, optional ones marked, comments in one column", () => {
    const lines = envExampleText().split("\n").filter((l) => l && !l.startsWith("#"));
    expect(lines.map((l) => l.split("=")[0])).toEqual([...MANIFESTS.flatMap((m) => m.env.map((e) => e.name)), "HOME_CONFIG"]);
    expect(lines).toContain("AMBER_SITE_ID=                        # optional: the first active site is used when unset");
    expect(lines).toContain("HOME_LONGITUDE=151.2093");
  });

  test("no state, no lines", () => {
    for (const m of MANIFESTS) expect(m.lines({ status: "disconnected" })).toEqual([]);
  });
});

describe("lines", () => {
  test("hue: lights on that answer, then each room and zone", async () => {
    const state = snapshotFrom(Resource.array().parse((await fixture("resources.json")).data), AT);
    expect(hue.lines({ status: "connected", state })).toEqual(["1 lights on", "Living: on · 60%", "Reading: off"]);
    expect(hue.record!({ status: "connected", state })).toEqual({
      lightsOn: 1,
      rooms: [{ name: "Living", on: true, brightness: 60 }, { name: "Reading", on: undefined, brightness: undefined }],
    });
  });

  test("daikin: power, mode and setpoint, room and outdoor unit", async () => {
    const state = { ...toState(await fixture("daikin/status.json")), asOf: AT };
    expect(daikin.lines({ status: "connected", state })).toEqual([expect.stringMatching(/^(on|off) · \w+ [\d.]+ °C · room [\d.]+ °C · outdoor unit [\d.]+ °C$/)]);
    expect(daikin.lines({ status: "connected", state: { asOf: AT, on: false, mode: "cool", targetC: 25, roomC: 24, outsideC: 19.5 } })).toEqual(["off · cool 25 °C · room 24 °C · outdoor unit 19.5 °C"]);
  });

  test("enphase: solar and use, then the token's days (the login ask is the integration's detail)", () => {
    const base: EnphaseSnapshot = { source: "meter", productionW: 2140, consumptionW: 600, asOf: AT, tokenDaysLeft: 300 };
    expect(enphase.lines({ status: "connected", state: base })).toEqual(["solar 2.1 kW, using 0.6 kW · token 300 days left"]);
    expect(enphase.lines({ status: "connected", state: { ...base, consumptionW: undefined, tokenDaysLeft: 12 } })).toEqual(["solar 2.1 kW · token 12 days left"]);
    expect(enphase.lines({ status: "connected", state: { ...base, productionW: undefined, tokenDaysLeft: -1 } })).toEqual(["token -1 days left"]);
  });

  test("amber: buy and sell, a spike and a negative price when there is one", async () => {
    const state = { ...toPrices(await fixture("amber/current.json")), asOf: AT };
    expect(amber.lines({ status: "connected", state })).toEqual([expect.stringMatching(/^buy -?[\d.]+c/)]);
    const odd = { asOf: AT, importCents: -2.04, exportCents: 5, priceDescriptor: "extremelyLow", spike: "potential", estimate: true, renewables: 71.6 };
    expect(amber.lines({ status: "connected", state: odd })).toEqual(["buy -2.0c extremelyLow (estimate) · spike potential · sell 5.0c · paid to use · 72% renewables"]);
    expect(amber.lines({ status: "connected", state: { asOf: AT } })).toEqual([]);
  });

  test("weather: each slice named by its source, then the sun", () => {
    const meta = { modelled: false, fetchedAt: AT, at: AT };
    const state: WeatherState = {
      now: { ...meta, source: "bom", tempC: 16.6, apparentC: 16.7, humidity: 93, station: { name: "Observatory Hill", distanceKm: 1.1 } },
      forecast: { ...meta, source: "bom", today: { date: "2026-10-14", text: "Showers.", rainChance: 80 }, tomorrow: { date: "2026-10-15", minC: 14, maxC: 19 } },
      sky: { ...meta, source: "open-meteo", modelled: true, cloudPct: 100, uvIndex: 0, hours: [] },
      sun: sunNow(-33.8688, 151.2093, Date.parse(AT)),
      sources: { bom: { read: true }, "open-meteo": { read: true } },
    };
    const [line, ...rest] = weather.lines({ status: "connected", state });
    expect(rest).toEqual([]);
    expect(line).toMatch(/^Observatory Hill \(1\.1 km\) \d\d:\d\d: 16\.6 °C, feels 16\.7, 93% · today showers 80% chance of rain, tomorrow 14–19 °C \(bom\) · cloud 100%, UV 0 \(open-meteo\) · sun \d+°, (rising|setting), (sets|rises) \d\d:\d\d$/);
    expect(weather.record!({ status: "connected", state })).toMatchObject({ line, sources: state.sources });
  });

  test("cast: how many answered, then devices before groups, each by name", () => {
    const state: CastSnapshot = {
      asOf: AT,
      devices: {
        g: { id: "g", name: "Everywhere", kind: "group", host: "192.0.2.5", status: "connected", idle: true, volume: 0.44, members: ["b", "a"], leader: "b" },
        b: { id: "b", name: "Kitchen", kind: "device", host: "192.0.2.6", status: "connected", app: "Spotify", playerState: "PLAYING", title: "Song", artist: "Band", volume: 0.3 },
        a: { id: "a", name: "Bedroom", kind: "device", host: "192.0.2.7", status: "connected", standby: true, muted: true },
        t: { id: "t", name: "TV", kind: "device", status: "disconnected", detail: "not found by discovery" },
      },
    };
    expect(cast.lines({ status: "connected", state })).toEqual([
      "3 found",
      "Bedroom: standby · muted",
      "Kitchen: Spotify · playing \"Song\" by Band · 30%",
      "TV: disconnected (not found by discovery)",
      "Everywhere: idle · 44% · 2 members: Kitchen, Bedroom, led by Kitchen",
    ]);
    expect(cast.record!({ status: "connected", state })).toMatchObject({ found: 3, devices: state.devices });
  });
});
