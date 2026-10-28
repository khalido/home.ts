import { describe, expect, test } from "bun:test";
import { localDay } from "../src/clock.ts";
import { checkHome, checkPlan, HomeConfigError, loadHome } from "../src/config.ts";
import { schemaText } from "../scripts/schema.ts";

const example = Bun.JSONC.parse(await Bun.file(new URL("../examples/home.jsonc", import.meta.url)).text()) as Record<string, any>;
const svg = await Bun.file(new URL("../examples/home.svg", import.meta.url)).text();
const env = { HUE_APPLICATION_KEY: "k", AMBER_KEY: "a" };
const files = (path: string) => (path.endsWith(".json") ? JSON.stringify({ token: "t.e.s" }) : "-----BEGIN CERTIFICATE-----");

describe("schema", () => {
  test("the committed home.schema.json matches the zod schema (run `bun run schema`)", async () => {
    expect(await Bun.file(new URL("../home.schema.json", import.meta.url)).text()).toBe(schemaText());
  });

  test("the example is valid, every device's room exists, nothing is unset", () => {
    expect(checkHome(example, env).problems).toEqual([]);
  });

  test("every room in the example has a room group and a marker in home.svg", () => {
    for (const room of example.rooms) {
      expect(svg).toContain(`<g class="room" id="${room.id}"`);
      expect(svg).toContain(`id="marker-${room.id.slice("room-".length)}"`);
    }
  });

  test("a room's old marker key (now hueRoom) is a problem, so a stale file does not lose its lights silently", () => {
    expect(checkPlan({ rooms: [{ id: "room-a", name: "A", marker: "x" }] }).problems).toEqual(["rooms[0] (room-a).marker: renamed hueRoom; marker now means only an SVG marker id"]);
  });

  test("a device drawn outside any room (the roof's solar array) has its marker in home.svg", () => {
    const marked = example.devices.filter((d: { marker?: string }) => d.marker);
    expect(marked.map((d: { connector: string }) => d.connector)).toEqual(["enphase"]);
    for (const d of marked) expect(svg).toContain(`<g class="marker" id="${d.marker}"`);
  });

  test("location.timezone is an IANA name; it sets where the home's day starts", () => {
    expect(checkPlan({ location: { latitude: 0, longitude: 0, timezone: "Australia/Sydney" } }).problems).toEqual([]);
    expect(checkPlan({ location: { latitude: 0, longitude: 0, timezone: "AEST+10" } }).problems).toEqual(["location.timezone: an IANA time zone, e.g. Australia/Sydney"]);
    const at = Date.parse("2026-10-13T23:30:00Z"); // 10:30 the next morning in Sydney
    expect(localDay(at, "Australia/Sydney")).toBe("2026-10-14");
    expect(localDay(at, "UTC")).toBe("2026-10-13");
  });

  test("two devices with one id are a problem", () => {
    const twin = { ...example, devices: [...example.devices, { ...example.devices[3] }] };
    expect(checkPlan(twin).problems).toEqual([`devices[${example.devices.length}] (prices).id: a second device with this id`]);
  });

  test("an unknown connector is refused, naming the field", () => {
    const bad = { ...example, devices: [{ id: "tv", connector: "sonos", host: "192.0.2.9" }] };
    expect(checkPlan(bad).problems).toEqual(["devices[0] (tv).connector: Invalid discriminator value. Expected 'hue' | 'daikin' | 'enphase' | 'amber' | 'up' | 'cast' | 'printers'"]);
  });

  test("a pasted secret is refused: keys are env names", () => {
    const bad = { devices: [{ id: "prices", connector: "amber", key: "psk_abc123" }] };
    expect(checkPlan(bad).problems).toEqual(["devices[0] (prices).key: an environment variable name (e.g. AMBER_KEY), not the secret itself"]);
  });

  test("a missing connector field is refused", () => {
    expect(checkPlan({ devices: [{ id: "ac", connector: "daikin" }] }).problems).toEqual(["devices[0] (ac).host: Invalid input: expected string, received undefined"]);
  });

  test("unknown keys pass through for a consumer's own use", () => {
    const own = { ...example, jaldi: { panel: "left" }, devices: [{ id: "ac", connector: "daikin", host: "192.0.2.10", note: "under the stairs" }] };
    const { config } = checkPlan(own);
    expect((config as Record<string, unknown>).jaldi).toEqual({ panel: "left" });
    expect((config!.devices![0] as Record<string, unknown>).note).toBe("under the stairs");
  });

  test("a device in a missing room, a twice-listed room, a second device of one connector", () => {
    const bad = {
      rooms: [{ id: "room-a", name: "A" }, { id: "room-a", name: "A again" }],
      devices: [{ id: "ac", connector: "daikin", host: "192.0.2.10", room: "room-attic" }, { id: "ac2", connector: "daikin", host: "192.0.2.11" }],
    };
    expect(checkHome(bad, {}).problems).toEqual([
      "rooms: room-a twice",
      "devices[0] (ac).room: no room room-attic",
      "devices[1] (ac2): a second daikin device (first: ac); one per connector for now",
    ]);
  });
});

describe("checkHome", () => {
  test("a missing env name is a problem naming the field; the setup shows it unset, never a value", () => {
    const r = checkHome(example, { HUE_APPLICATION_KEY: "k" });
    expect(r.problems).toEqual(["devices[3] (prices).key: env AMBER_KEY is not set"]);
    expect(r.setup).toEqual([
      { name: "hue", from: "bridge", settings: { host: "192.0.2.2", bridgeId: "0017880000000000", ca: "hue-root-ca.pem" }, secrets: { HUE_APPLICATION_KEY: "set" } },
      { name: "daikin", from: "ac", settings: { host: "192.0.2.10", mac: "00005E005301" }, secrets: {} },
      { name: "enphase", from: "solar", settings: { host: "192.0.2.21", serial: "000000000000", token: "enphase-token.json", marker: "marker-solar", capacityW: 6600 }, secrets: {} },
      { name: "amber", from: "prices", settings: {}, secrets: { AMBER_KEY: "unset" } },
      { name: "weather", from: "location", settings: { latitude: -33.8688, longitude: 151.2093, sources: "bom, open-meteo", bomForecast: "Sydney" }, secrets: {} },
    ]);
  });

  test("a field the schema does not know is not shown: it may be a pasted secret", () => {
    const r = checkHome({ devices: [{ id: "ac", connector: "daikin", host: "192.0.2.10", token: "s3cret" }] }, {});
    expect(r.setup[0]!.settings).toEqual({ host: "192.0.2.10" });
  });

  test("google as a source needs its key's env name", () => {
    const r = checkHome({ location: { latitude: 0, longitude: 0 }, weather: { sources: ["google"] } }, {});
    expect(r.problems).toEqual(["weather.googleKey: needed when weather.sources has google"]);
  });
});

describe("home config check", () => {
  test("prints each integration, secrets as set or unset by name, then the problems; exits 1", () => {
    const run = Bun.spawnSync(["bun", "--env-file=/dev/null", "src/cli/main.ts", "config", "check", "examples/home.jsonc"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { PATH: process.env.PATH, AMBER_KEY: "psk_secret" },
    });
    const out = run.stdout.toString();
    expect(out.split("\n").slice(0, 5)).toEqual([
      "hue      from bridge · host 192.0.2.2 · bridgeId 0017880000000000 · ca hue-root-ca.pem · HUE_APPLICATION_KEY unset",
      "daikin   from ac · host 192.0.2.10 · mac 00005E005301",
      "enphase  from solar · host 192.0.2.21 · serial 000000000000 · token enphase-token.json · marker marker-solar · capacityW 6600",
      "amber    from prices · AMBER_KEY set",
      "weather  from location · latitude -33.8688 · longitude 151.2093 · sources bom, open-meteo · bomForecast Sydney",
    ]);
    expect(out).toContain("problem: devices[0] (bridge).key: env HUE_APPLICATION_KEY is not set");
    expect(out).toContain("problem: bridge.ca: no file hue-root-ca.pem");
    expect(out).not.toContain("psk_secret");
    expect(run.exitCode).toBe(1);
  });
});

describe("loadHome", () => {
  test("builds one integration per device in order, weather last", () => {
    expect(loadHome(example, { env, readFile: files }).map((i) => i.name)).toEqual(["hue", "daikin", "enphase", "amber", "weather"]);
  });

  test("throws every problem at once, naming the fields", () => {
    expect(() => loadHome(example, { env: {}, readFile: files })).toThrow(
      new HomeConfigError(["devices[0] (bridge).key: env HUE_APPLICATION_KEY is not set", "devices[3] (prices).key: env AMBER_KEY is not set"]),
    );
  });

  test("the clock reaches every integration", async () => {
    const { manualClock } = await import("./clock.ts");
    const { settle } = await import("../src/home.ts");
    const prices = await Bun.file(new URL("./fixtures/amber/current.json", import.meta.url)).text();
    const f = (async (url: string) => new Response(url.endsWith("/sites") ? JSON.stringify([{ id: "S1", status: "active" }]) : prices)) as unknown as typeof fetch;
    const integrations = loadHome({ devices: [{ id: "prices", connector: "amber", key: "AMBER_KEY" }] }, { env, fetch: f, clock: manualClock().clock });
    const s = (await settle(integrations, { ms: 1000 })) as Record<string, { state?: { asOf?: string } }>;
    expect(s.amber?.state?.asOf).toBe(new Date(0).toISOString()); // the fake clock's time, not the wall's
  });

  test("a token file that is not JSON is named, not a bare SyntaxError", () => {
    const broken = (path: string) => (path.endsWith(".json") ? "{ token: " : files(path));
    expect(() => loadHome(example, { env, readFile: broken })).toThrow(/devices\[2\] \(solar\)\.token: not JSON/);
  });

  test("a file the config needs, with no reader, is named", () => {
    expect(() => loadHome(example, { env })).toThrow("devices[0] (bridge).ca: needs readFile to read hue-root-ca.pem; devices[2] (solar).token: needs readFile to read enphase-token.json");
  });
});

describe("cast entries", () => {
  // Invented ids and names; a speaker group is one more entry.
  const castConfig = {
    devices: [
      { id: "kitchen", connector: "cast", room: "room-kitchen", name: "Kitchen speaker", castId: "00000000000040008000000000000001" },
      { id: "prices", connector: "amber", key: "AMBER_KEY" },
      { id: "group", connector: "cast", name: "Downstairs", castId: "00000000-0000-4000-8000-000000000002" },
    ],
    rooms: [{ id: "room-kitchen", name: "Kitchen" }],
  };
  const castOptions = { env, finders: { cast: async () => [] }, castConnect: async () => Promise.reject(new Error("unused")) };

  test("any number of Cast entries; each needs its Google Home name", () => {
    expect(checkHome(castConfig, env).problems).toEqual([]);
    const { name: _, ...unnamed } = castConfig.devices[0]!;
    expect(checkHome({ ...castConfig, devices: [unnamed] }, env).problems[0]).toStartWith("devices[0] (kitchen).name:");
  });

  test("the same Cast device twice is a problem", () => {
    const twice = { ...castConfig, devices: [castConfig.devices[0]!, { ...castConfig.devices[0]!, id: "again", castId: "00000000-0000-4000-8000-000000000001" }] };
    expect(checkHome(twice, env).problems).toEqual(["devices[1] (again).castId: the same Cast device as devices[0] (kitchen)"]);
  });

  test("fold into one cast integration at the first entry's place", () => {
    expect(loadHome(castConfig, castOptions).map((i) => i.name)).toEqual(["cast", "amber"]);
  });

  test("without a transport or a finder, each is named", () => {
    expect(() => loadHome(castConfig, { env })).toThrow(
      "devices[0] (kitchen): Cast needs castConnect (tlsConnect from @khalido/home/cast/tls); devices[0] (kitchen): Cast needs finders.cast (its mDNS discovery)",
    );
  });
});
