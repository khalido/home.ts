import { describe, expect, test } from "bun:test";
import { createHome, type Clock } from "../src/index.ts";
import { enphase, enphaseClient, mintToken, POLL_MS, tokenExpiry } from "../src/connectors/enphase/index.ts";
import { daysLeft } from "../src/connectors/enphase/client.ts";
import { fromReadings, gatewayHost, toState } from "../src/connectors/enphase/client.ts";

// Gateway replies recorded by pyenphase (MIT, github.com/pyenphase/pyenphase, tests/fixtures):
// ct-* from software 8.3.5167 with production and consumption meters, noct-* from 8.2.4264 metered without CTs.
const fixture = async (name: string) => JSON.parse(await Bun.file(new URL(`./fixtures/enphase/${name}.json`, import.meta.url)).text());
const ct = { production: await fixture("ct-production"), meters: await fixture("ct-meters"), readings: await fixture("ct-readings") };
const noct = { production: await fixture("noct-production"), meters: await fixture("noct-meters") };

const jwt = (exp: number) => `x.${btoa(JSON.stringify({ exp })).replace(/=+$/, "")}.y`;

describe("toState", () => {
  test("with meters: production, consumption and net from the eim readings", () => {
    expect(toState(ct.production, ct.meters)).toMatchObject({
      productionW: 5305.189,
      productionWhToday: 19282.609,
      consumptionW: 324.922,
      consumptionWhToday: 8958,
      netW: -4980.266,
      source: "meter",
      readingTime: new Date(1753703631 * 1000).toISOString(),
    });
  });

  test("without CTs: production from the inverters, no today total, no consumption", () => {
    const s = toState(noct.production, noct.meters);
    expect(s).toMatchObject({ productionW: 5521, source: "inverters" });
    expect(s.productionWhToday).toBeUndefined();
    expect(s.consumptionW).toBeUndefined();
  });

  test("a daily counter equal to lifetime (KO's D8.3.5528) is dropped and flagged, never passed off as today", () => {
    const production = structuredClone(ct.production);
    for (const m of [...production.production, ...production.consumption]) if (m.type === "eim") m.whToday = m.whLifetime;
    const s = toState(production, ct.meters);
    expect(s.productionWhToday).toBeUndefined();
    expect(s.consumptionWhToday).toBeUndefined();
    expect(s.productionWhLifetime).toBeGreaterThan(0);
    expect(s.anomaly).toContain("equals its lifetime total");
  });

  test("a meter /ivp/meters calls disabled is ignored even if it reports", () => {
    const meters = ct.meters.map((m: { measurementType: string }) => ({ ...m, state: "disabled" }));
    expect(toState(ct.production, meters)).toMatchObject({ source: "inverters", consumptionW: undefined });
  });
});

describe("fromReadings", () => {
  test("production and net from the meters, consumption = production + net import, lifetimes joined by eid", () => {
    const s = fromReadings(ct.meters, ct.readings);
    expect(s.productionW).toBe(5235.674);
    expect(s.netW).toBe(-4912.241);
    expect(s.consumptionW).toBeCloseTo(5235.674 - 4912.241, 6);
    expect(s.productionWhLifetime).toBe(569122.622);
    expect(s.consumptionWhLifetime).toBeCloseTo(569122.622 + 99056.453 - 415089.21, 6);
    expect(s.productionWhToday).toBeUndefined();
  });

  test("a total-consumption meter is read directly", () => {
    const meters = ct.meters.map((m: { measurementType: string }) => (m.measurementType === "net-consumption" ? { ...m, measurementType: "total-consumption" } : m));
    const s = fromReadings(meters, ct.readings);
    expect(s.consumptionW).toBe(-4912.241); // whatever that meter says, unaltered
    expect(s.netW).toBeCloseTo(-4912.241 - 5235.674, 6);
  });
});

describe("token", () => {
  test("expiry comes from the JWT's exp; days left counts down", () => {
    const exp = Date.UTC(2027, 9, 13) / 1000;
    expect(tokenExpiry(jwt(exp)).toISOString()).toBe("2027-10-13T00:00:00.000Z");
    expect(daysLeft(new Date(exp * 1000), new Date(Date.UTC(2027, 8, 13)))).toBe(30);
  });

  test("mint: login for a session, then Entrez with session, serial and username", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return url.includes("login.json") ? new Response('{"session_id":"s1","message":"success"}') : new Response(jwt(2_000_000_000));
    }) as unknown as typeof fetch;
    const { token, expiresAt } = await mintToken({ username: "u@x", password: "p", serial: "123", fetch: f });
    expect(token).toBe(jwt(2_000_000_000));
    expect(expiresAt.getTime()).toBe(2_000_000_000_000);
    expect((calls[0]!.init!.body as URLSearchParams).get("user[email]")).toBe("u@x");
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({ session_id: "s1", serial_num: "123", username: "u@x" });
  });

  test("a failed login says so and never asks Entrez", async () => {
    let n = 0;
    const f = (async () => (n++, new Response('{"message":"bad"}', { status: 401 }))) as unknown as typeof fetch;
    await expect(mintToken({ username: "u", password: "p", serial: "1", fetch: f })).rejects.toThrow("login failed");
    expect(n).toBe(1);
  });
});

describe("client and home", () => {
  const gateway = (status = 200) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (status !== 200) return new Response("", { status });
      return new Response(JSON.stringify(url.includes("readings") ? ct.readings : url.includes("meters") ? ct.meters : ct.production));
    }) as unknown as typeof fetch;
    return { f, calls };
  };

  test("reads the fast meter endpoints with the bearer token when a production meter is on", async () => {
    const { f, calls } = gateway();
    const s = await enphaseClient({ host: "https://192.0.2.5/", token: "T", fetch: f }).read();
    expect(s.source).toBe("meter");
    expect(calls.map((c) => c.url)).toEqual(["https://192.0.2.5/ivp/meters", "https://192.0.2.5/ivp/meters/readings"]);
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer T");
  });

  test("polls every 60 s, warns under 30 days, keeps the token's days left in the snapshot", async () => {
    let t = Date.UTC(2027, 0, 1);
    const sleeps: number[] = [];
    const stop = new AbortController();
    const clock: Clock = { now: () => t, sleep: async (ms) => void (sleeps.push(ms), (t += ms), sleeps.length === 2 && stop.abort()) };
    const token = jwt((Date.UTC(2027, 0, 1) + 10 * 86_400_000) / 1000);
    const home = createHome([enphase({ host: "h", token, fetch: gateway().f, clock })]);
    await home.start(stop.signal);
    const part = home.snapshot().enphase!;
    expect(sleeps).toEqual([POLL_MS, POLL_MS]);
    expect(part.status).toBe("connected");
    expect(part.detail).toContain("token expires in 9 days");
    expect(part.state).toMatchObject({ productionW: 5235.674, tokenDaysLeft: 9 });
  });

  test("today is counted from the lifetime counter since the first reading of the day", async () => {
    let lifetime = 1_000_000;
    const readings = structuredClone(ct.readings);
    const f = (async (url: string) => {
      if (!url.includes("readings")) return new Response(JSON.stringify(ct.meters));
      readings[0].actEnergyDlvd = lifetime; // the production meter
      lifetime += 500;
      return new Response(JSON.stringify(readings));
    }) as unknown as typeof fetch;
    let t = Date.UTC(2027, 0, 1, 1);
    const stop = new AbortController();
    let n = 0;
    const clock: Clock = { now: () => t, sleep: async (ms) => void ((t += ms), ++n === 3 && stop.abort()) };
    const home = createHome([enphase({ host: "h", token: jwt(4_000_000_000), fetch: f, clock })]);
    await home.start(stop.signal);
    expect(home.snapshot().enphase!.state).toMatchObject({ productionWhToday: 1000, todaySince: new Date(Date.UTC(2027, 0, 1, 1)).toISOString() });
  });

  const peaks = async (startAt: number, timeZone: string) => {
    const watts = [1200, 3400, 2100, 500];
    const readings = structuredClone(ct.readings);
    let i = 0;
    const f = (async (url: string) => {
      if (!url.includes("readings")) return new Response(JSON.stringify(ct.meters));
      readings[0].activePower = watts[i++]; // the production meter
      return new Response(JSON.stringify(readings));
    }) as unknown as typeof fetch;
    let t = startAt;
    const stop = new AbortController();
    const seen: (number | undefined)[] = [];
    const clock: Clock = { now: () => t, sleep: async (ms) => void ((t += ms), i === watts.length && stop.abort()) };
    const home = createHome([enphase({ host: "h", token: jwt(4_000_000_000), fetch: f, clock, timeZone })], (snap) =>
      seen.push((snap.enphase!.state as { productionWPeakToday?: number }).productionWPeakToday),
    );
    await home.start(stop.signal);
    return { seen, peakSince: (home.snapshot().enphase!.state as { peakSince?: string }).peakSince };
  };

  test("today's peak is the highest production read since the day's first read, and starts again at midnight", async () => {
    // three reads before midnight, one after
    expect(await peaks(Date.UTC(2027, 0, 1, 23, 57), "UTC")).toEqual({ seen: [1200, 3400, 3400, 500], peakSince: new Date(Date.UTC(2027, 0, 2)).toISOString() });
  });

  test("the peak resets at the home's midnight, not the runtime's: Sydney's is 13:00Z in summer", async () => {
    expect(await peaks(Date.UTC(2027, 0, 1, 12, 57), "Australia/Sydney")).toEqual({ seen: [1200, 3400, 3400, 500], peakSince: new Date(Date.UTC(2027, 0, 1, 13)).toISOString() });
  });

  test("a host pasted with a scheme and a trailing slash is the bare host everywhere: requests, and what an address cache is told", async () => {
    expect(["https://192.0.2.21/", "HTTP://192.0.2.21", " 192.0.2.21// ", "envoy.local"].map(gatewayHost)).toEqual(["192.0.2.21", "192.0.2.21", "192.0.2.21", "envoy.local"]);
    const { f, calls } = gateway();
    const seen: string[] = [];
    const stop = new AbortController();
    const clock: Clock = { now: () => Date.UTC(2027, 0, 1), sleep: async () => stop.abort() };
    await createHome([enphase({ host: "https://192.0.2.21/", token: jwt(4_000_000_000), fetch: f, clock, seen: (h) => seen.push(h) })]).start(stop.signal);
    expect(calls[0]!.url).toBe("https://192.0.2.21/ivp/meters");
    expect(seen).toEqual(["192.0.2.21"]);
  });

  test("a malformed token marks Enphase unavailable without stopping the home", async () => {
    const home = createHome([enphase({ host: "h", token: "nope", fetch: gateway().f })]);
    await home.start(new AbortController().signal);
    expect(home.snapshot().enphase).toMatchObject({ status: "unavailable" });
  });

  test("a rejected token marks Enphase unavailable and stops polling", async () => {
    const home = createHome([enphase({ host: "h", token: jwt(4_000_000_000), fetch: gateway(401).f })]);
    await home.start(new AbortController().signal);
    expect(home.snapshot().enphase).toMatchObject({ status: "unavailable" });
  });
});
