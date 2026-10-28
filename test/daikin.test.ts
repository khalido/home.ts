import { describe, expect, test } from "bun:test";
import { createHome, type Clock } from "../src/index.ts";
import { daikin, daikinClient, POLL_MS, setFan, setMode, setPower, setTarget, type WriteRequest } from "../src/connectors/daikin/index.ts";
import { hexLE, toState } from "../src/connectors/daikin/client.ts";

// KO's unit, one read-only multireq on 2026-10-13 (adr_0100, adr_0200, adp_i); MAC, SSID, edid and the unit's ids removed.
const status = JSON.parse(await Bun.file(new URL("./fixtures/daikin/status.json", import.meta.url)).text());

/** The fixture with one indoor `e_1002` field replaced. */
const withIndoor = (entity: string, pn: string, pv: string) => {
  const s = structuredClone(status);
  const e1002 = s.responses[0].pc.pch.find((n: { pn: string }) => n.pn === "e_1002");
  e1002.pch.find((n: { pn: string }) => n.pn === entity).pch.find((n: { pn: string }) => n.pn === pn).pv = pv;
  return s;
};

describe("hexLE", () => {
  test("little-endian, signed when asked", () => {
    expect(hexLE("2700")).toBe(39);
    expect(hexLE("C201")).toBe(450);
    expect(hexLE("EEFF", true)).toBe(-18);
    expect(hexLE("F7", true)).toBe(-9);
    expect(hexLE("zz")).toBeUndefined();
  });
});

describe("toState", () => {
  test("KO's unit: off, cool at 25, room 24, 70%, fan 3, outside 19.5", () => {
    expect(toState(status)).toEqual({
      on: false,
      mode: "cool",
      targetC: 25,
      roomC: 24,
      humidity: 70,
      fan: "3",
      outsideC: 19.5,
      anomaly: undefined,
    });
  });

  test("the setpoint and fan follow the selected mode", () => {
    expect(toState(withIndoor("e_3001", "p_01", "0300"))).toMatchObject({ mode: "auto", targetC: 24, fan: "auto" });
  });

  test("dry has no setpoint or fan; neither is guessed", () => {
    const s = toState(withIndoor("e_3001", "p_01", "0500"));
    expect(s).toMatchObject({ mode: "dry", targetC: undefined, fan: undefined });
  });

  test("a sub-zero outside reading stays negative", () => {
    const s = structuredClone(status);
    const e1003 = s.responses[1].pc.pch.find((n: { pn: string }) => n.pn === "e_1003");
    e1003.pch.find((n: { pn: string }) => n.pn === "e_A00D").pch[0].pv = "F6FF";
    expect(toState(s).outsideC).toBe(-5);
  });

  test("an unknown mode code is flagged, not mapped", () => {
    const s = toState(withIndoor("e_3001", "p_01", "0400"));
    expect(s.mode).toBeUndefined();
    expect(s.anomaly).toBe("unknown mode code 0400");
  });

  test("missing fields read as undefined", () => {
    expect(Object.values(toState({ responses: [] })).every((v) => v === undefined)).toBe(true);
  });
});

describe("write requests", () => {
  const tree = (...fields: { pn: string; pch: { pn: string; pv: string }[] }[]): WriteRequest => ({
    requests: [{ op: 3 as const, to: "/dsiot/edge/adr_0100.dgc_status", pc: { pn: "dgc_status", pch: [{ pn: "e_1002", pch: fields }] } }],
  });
  const field = (entity: string, pn: string, pv: string) => ({ pn: entity, pch: [{ pn, pv }] });

  test("power", () => {
    expect(setPower(true)).toEqual(tree(field("e_A002", "p_01", "01")));
    expect(setPower(false)).toEqual(tree(field("e_A002", "p_01", "00")));
  });

  test("mode turns the unit on too", () => {
    expect(setMode("heat")).toEqual(tree(field("e_A002", "p_01", "01"), field("e_3001", "p_01", "0100")));
  });

  test("setpoint: one byte of °C × 2 in the mode's own field", () => {
    expect(setTarget(25, "cool")).toEqual(tree(field("e_3001", "p_02", "32")));
    expect(setTarget(21.5, "heat")).toEqual(tree(field("e_3001", "p_03", "2B")));
    expect(setTarget(24, "auto")).toEqual(tree(field("e_3001", "p_1D", "30")));
  });

  test("setpoint off the range or step throws instead of rounding", () => {
    expect(() => setTarget(25.3, "cool")).toThrow("0.5 steps");
    expect(() => setTarget(16, "cool")).toThrow("18–32");
    expect(() => setTarget(22, "fan")).toThrow("no setpoint");
  });

  test("fan speed in the mode's own field", () => {
    expect(setFan("3", "cool")).toEqual(tree(field("e_3001", "p_09", "0500")));
    expect(setFan("quiet", "heat")).toEqual(tree(field("e_3001", "p_0A", "0B00")));
    expect(() => setFan("auto", "dry")).toThrow("no fan speed");
  });
});

describe("client", () => {
  test("read: one POST of op 2 for the indoor and outdoor status, with a timeout", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const f = (async (url: string, init: RequestInit) => ((seen = { url, init }), new Response(JSON.stringify(status)))) as unknown as typeof fetch;
    expect(await daikinClient({ host: "ac.local", fetch: f }).read()).toMatchObject({ mode: "cool", outsideC: 19.5 });
    expect(seen!.url).toBe("http://ac.local/dsiot/multireq");
    expect(seen!.init.method).toBe("POST");
    expect(seen!.init.signal).toBeDefined();
    expect(JSON.parse(seen!.init.body as string)).toEqual({
      requests: [
        { op: 2, to: "/dsiot/edge/adr_0100.dgc_status?filter=pv,pt,md" },
        { op: 2, to: "/dsiot/edge/adr_0200.dgc_status?filter=pv,pt,md" },
      ],
    });
  });

  test("read: an indoor rsc other than 2000 throws", async () => {
    const f = (async () => new Response(JSON.stringify({ responses: [{ fr: "/dsiot/edge/adr_0100.dgc_status", rsc: 4004 }] }))) as unknown as typeof fetch;
    await expect(daikinClient({ host: "ac.local", fetch: f }).read()).rejects.toThrow("rsc 4004");
  });

  test("write: an error rsc throws", async () => {
    const f = (async () => new Response(JSON.stringify({ responses: [{ fr: "/dsiot/edge/adr_0100.dgc_status", rsc: 4000 }] }))) as unknown as typeof fetch;
    await expect(daikinClient({ host: "ac.local", fetch: f }).write(setPower(false))).rejects.toThrow("rsc 4000");
  });
});

describe("daikin integration", () => {
  const unit = (respond: () => Response) => {
    let calls = 0;
    const f = (async () => (calls++, respond())) as unknown as typeof fetch;
    return { f, calls: () => calls };
  };

  test("reads now, then every 120 s", async () => {
    const { f, calls } = unit(() => new Response(JSON.stringify(status)));
    let t = 0;
    const stop = new AbortController();
    const clock: Clock = { now: () => t, sleep: async (ms) => void ((t += ms), t >= 2 * POLL_MS && stop.abort()) };
    const home = createHome([daikin({ host: "ac.local", fetch: f, clock })]);
    await home.start(stop.signal);
    expect(calls()).toBe(2);
    expect(home.snapshot().daikin).toMatchObject({ status: "connected", state: { on: false, targetC: 25, asOf: new Date(POLL_MS).toISOString() } });
  });

  test("a failed poll keeps the last reading and says disconnected", async () => {
    let n = 0;
    const { f } = unit(() => (n++ === 0 ? new Response(JSON.stringify(status)) : new Response("", { status: 500 })));
    let t = 0;
    const stop = new AbortController();
    const clock: Clock = { now: () => t, sleep: async (ms) => void ((t += ms), t >= 2 * POLL_MS && stop.abort()) };
    const home = createHome([daikin({ host: "ac.local", fetch: f, clock })]);
    await home.start(stop.signal);
    expect(home.snapshot().daikin).toMatchObject({ status: "disconnected", detail: expect.stringContaining("HTTP 500"), state: { targetC: 25, asOf: new Date(0).toISOString() } });
  });

  test("no dsiot endpoint is a failed read: disconnected, saying so, and still polling", async () => {
    let t = 0;
    const stop = new AbortController();
    const clock: Clock = { now: () => t, sleep: async (ms) => void ((t += ms), t >= 2 * POLL_MS && stop.abort()) };
    const { f, calls } = unit(() => new Response("", { status: 404 }));
    const home = createHome([daikin({ host: "ac.local", fetch: f, clock })]);
    await home.start(stop.signal);
    expect(home.snapshot().daikin).toMatchObject({ status: "disconnected", detail: "no /dsiot/multireq at this address: not a dsiot Daikin" });
    expect(calls()).toBeGreaterThan(1);
  });
});

describe("daikinFields", () => {
  test("decodes values, and keeps one that is not valid encoding as sent", async () => {
    const { daikinFields } = await import("../src/finders.ts");
    expect(daikinFields("ret=OK,name=%4c%69%76%69%6e%67,odd=100%")).toEqual({ ret: "OK", name: "Living", odd: "100%" });
  });
});
