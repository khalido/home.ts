import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeFrom } from "../src/cli/hue.ts";
import { deviceLine } from "../src/cli/status.ts";

// The output contract in docs/cli.md: errors as JSON on stderr under --json, exit 2 for usage, 1 for a connector that is down.
const home = (args: string[], env: Record<string, string> = {}) => {
  const run = Bun.spawnSync(
    ["bun", "--env-file=/dev/null", "src/cli/main.ts", ...args],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: { PATH: process.env.PATH!, ...env },
    },
  );
  return {
    out: run.stdout.toString(),
    err: run.stderr.toString(),
    code: run.exitCode,
  };
};

describe("home output contract", () => {
  test("--dry-run is refused on a command whose writes don't read it, before anything runs", () => {
    for (const args of [
      ["cast", "volume", "Kitchen", "30"],
      ["spotify", "pause"],
      ["discover", "--write", "x.jsonc"],
      ["pair"],
    ]) {
      const r = home([...args, "--dry-run"]);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/dryRun|dry run/i);
    }
  });

  describe("home <connector> --config needs only that connector", () => {
    const config = join(mkdtempSync(join(tmpdir(), "home-")), "home.jsonc");
    writeFileSync(
      config,
      JSON.stringify({
        location: { latitude: -33.9, longitude: 151.2 },
        weather: { googleKey: "GOOGLE_WEATHER_KEY" },
        devices: [
          { id: "daikin", connector: "daikin", host: "127.0.0.1:1" },
          { id: "up", connector: "up", token: "UP_TOKEN" },
        ],
      }),
    );

    test("another connector's unset key, or the weather's, doesn't stop it", () => {
      const r = home(["daikin", "--config", config, "--json"]);
      expect(r.err).toBe("");
      expect(JSON.parse(r.out).status).toBe("disconnected");
      expect(r.code).toBe(1);
    });

    test("home devices lists what answered, and names on stderr the connector that didn't", () => {
      const only = join(mkdtempSync(join(tmpdir(), "home-")), "home.jsonc");
      writeFileSync(
        only,
        JSON.stringify({
          devices: [{ id: "daikin", connector: "daikin", host: "127.0.0.1:1" }],
        }),
      );
      const r = home(["devices", "--config", only, "--json"]);
      expect(JSON.parse(r.out)).toEqual([]);
      expect(r.err).toContain("daikin: disconnected");
      expect(r.code).toBe(0);
    });

    test("a connector the config doesn't have says so", () => {
      const r = home(["amber", "--config", config]);
      expect(r.err).toContain("no amber in");
      expect(r.code).toBe(1);
    });
  });

  test("a corrupt Enphase token file is reason auth", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "home-"));
    mkdirSync(join(fakeHome, ".config", "home"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".config", "home", "enphase-token.json"),
      "not json",
    );
    const r = home(["enphase", "--json"], {
      HOME: fakeHome,
      IQ_GATEWAY_HOST: "127.0.0.1:1",
    });
    expect(JSON.parse(r.out)).toMatchObject({
      status: "unavailable",
      reason: "auth",
    });
  });

  test("a build that fails on a setting is reason config", () => {
    const r = home(["hue", "--json"], {
      HUE_APPLICATION_KEY: "k",
      HUE_BRIDGE_HOST: "127.0.0.1:1",
      HUE_BRIDGE_ID: "id",
      HUE_CA_FILE: "/nonexistent/ca.pem",
    });
    expect(JSON.parse(r.out)).toMatchObject({
      status: "unavailable",
      reason: "config",
    });
  });

  test("home daikin: a wrong verb is usage, and an unreachable unit is a network error before any line prints", () => {
    const wrong = home(["daikin", "sideways"]);
    expect(wrong.err).toContain("usage: home daikin on | off | cool");
    expect(home(["daikin", "cool", "warm"]).code).toBe(2);
    const cold = home(["daikin", "cool", "12"]); // off the unit's range: said before looking for the unit
    expect(cold.err).toContain("18–32");
    expect(cold.code).toBe(2);
    expect(home(["daikin", "dry", "22"]).code).toBe(2);
    expect(wrong.code).toBe(2);
    const down = home(["daikin", "on", "--json"], {
      DAIKIN_HOST: "127.0.0.1:1",
    });
    expect(down.out).toBe("");
    expect(JSON.parse(down.err).code).toBe("network");
    expect(down.code).toBe(1);
  });

  test("a wrong command is a usage error: exit 2, one line on stderr, nothing on stdout", () => {
    expect(home(["nope"])).toEqual({
      out: "",
      err: 'home: unknown command "nope"; `home --help` lists them\n',
      code: 2,
    });
  });

  test("under --json the error is one JSON object on stderr", () => {
    const r = home(["nope", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.err)).toEqual({
      error: 'unknown command "nope"; `home --help` lists them',
      code: "usage",
    });
  });

  test("a missing key is auth, exit 1", () => {
    const r = home(["up", "categories", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err)).toEqual({ error: "set UP_TOKEN", code: "auth" });
  });

  test("home <connector> exits 1 when it is not connected; its record still prints", () => {
    const r = home(["weather", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({
      status: "not set up",
      needs: ["HOME_LATITUDE", "HOME_LONGITUDE"],
    });
  });

  test("a bad HOME_TIMEZONE names itself", () => {
    const r = home(["weather", "--json"], {
      HOME_LATITUDE: "-33.8688",
      HOME_LONGITUDE: "151.2093",
      HOME_TIMEZONE: "AEST",
    });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).detail).toBe(
      "HOME_TIMEZONE: an IANA time zone, e.g. Australia/Sydney, not AEST",
    );
  });

  test("a device's line: its connector, its text, its room, and why when it isn't available", () => {
    const d = {
      connector: "daikin",
      id: "daikin",
      name: "Lounge AC",
      kind: "ac",
      state: "cool",
      text: "Lounge AC: on · cool 23 °C",
      detail: { asOf: "2026-11-11T00:00:00.000Z" },
    } as const;
    expect(deviceLine({ ...d, available: true, room: "room-living" })).toBe(
      "daikin   Lounge AC: on · cool 23 °C · in room-living",
    );
    expect(deviceLine({ ...d, available: false, reason: "auth" })).toBe(
      "daikin   Lounge AC: on · cool 23 °C · not available: auth",
    );
  });

  test("home light and home room: the words after the name, in any order", () => {
    const u = "usage";
    expect(changeFrom(["on", "40", "2700k"], u)).toEqual({
      on: true,
      brightness: 40,
      kelvin: 2700,
    });
    expect(changeFrom(["ff8800", "100%"], u)).toEqual({
      color: "ff8800",
      brightness: 100,
    });
    expect(changeFrom(["#f80"], u)).toEqual({ color: "#f80" });
    expect(changeFrom(["123456"], u)).toEqual({ color: "123456" }); // six digits is a colour
    expect(changeFrom(["888"], u)).toEqual({ brightness: 888 }); // three is a brightness: the library refuses it; a grey is #888
    expect(() => changeFrom(["on", "off"], u)).toThrow("not both");
    expect(() => changeFrom(["warm"], u)).toThrow("is not on, off");
    expect(() => changeFrom([], u)).toThrow("usage");
  });
});
