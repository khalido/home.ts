import { describe, expect, test } from "bun:test";

// The output contract in docs/cli.md: errors as JSON on stderr under --json, exit 2 for usage, 1 for a connector that is down.
const home = (args: string[], env: Record<string, string> = {}) => {
  const run = Bun.spawnSync(["bun", "--env-file=/dev/null", "src/cli/main.ts", ...args], { cwd: new URL("..", import.meta.url).pathname, env: { PATH: process.env.PATH!, ...env } });
  return { out: run.stdout.toString(), err: run.stderr.toString(), code: run.exitCode };
};

describe("home output contract", () => {
  test("a wrong command is a usage error: exit 2, one line on stderr, nothing on stdout", () => {
    expect(home(["nope"])).toEqual({ out: "", err: 'home: unknown command "nope"; `home --help` lists them\n', code: 2 });
  });

  test("under --json the error is one JSON object on stderr", () => {
    const r = home(["nope", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.err)).toEqual({ error: 'unknown command "nope"; `home --help` lists them', code: "usage" });
  });

  test("a missing key is auth, exit 1", () => {
    const r = home(["up", "categories", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err)).toEqual({ error: "set UP_TOKEN", code: "auth" });
  });

  test("home <connector> exits 1 when it is not connected; its record still prints", () => {
    const r = home(["weather", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ status: "not set up", needs: ["HOME_LATITUDE", "HOME_LONGITUDE"] });
  });

  test("a bad HOME_TIMEZONE names itself", () => {
    const r = home(["weather", "--json"], { HOME_LATITUDE: "-33.8688", HOME_LONGITUDE: "151.2093", HOME_TIMEZONE: "AEST" });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).detail).toBe("HOME_TIMEZONE: an IANA time zone, e.g. Australia/Sydney, not AEST");
  });
});
