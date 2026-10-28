import { describe, expect, test } from "bun:test";
import { writeLane } from "../src/lane.ts";
import { mergeBody } from "../src/connectors/hue/client.ts";
import { mergeWrites, setMode, setPower, setTarget } from "../src/connectors/daikin/client.ts";
import { manualClock } from "./clock.ts";

/** A lane whose writes record when they ran and what they carried. */
function recorded(options: { gapMs: number; perMinute?: number }) {
  const { clock, advance } = manualClock();
  const sends: { at: number; slot: string; body: unknown }[] = [];
  const lane = writeLane({ ...options, clock });
  const send = <B>(slot: string, body: B, merge?: (a: B, b: B) => B) =>
    lane.send(slot, body, async (b) => (sends.push({ at: clock.now(), slot, body: b }), b), merge);
  return { send, sends, advance };
}

describe("writeLane", () => {
  test("a per-minute cap below 1 is refused", () => {
    expect(() => writeLane({ gapMs: 100, perMinute: 0 })).toThrow(RangeError);
  });

  test("a burst to one slot: the first goes now, the middle drops, the last lands after the gap", async () => {
    const { send, sends, advance } = recorded({ gapMs: 1000 });
    const results = [21, 22, 23, 24].map((c) => send("ac", c));
    await advance(1000);
    expect(sends.map((s) => [s.at, s.body])).toEqual([[0, 21], [1000, 24]]);
    expect(await Promise.all(results)).toEqual([21, 24, 24, 24]); // a merged write resolves with the send that carried it
  });

  test("merge keeps each field's newest value", async () => {
    const { send, sends, advance } = recorded({ gapMs: 100 });
    void send("light/1", { on: { on: true } }, mergeBody);
    void send("light/1", { dimming: { brightness: 20 } }, mergeBody);
    void send("light/1", { dimming: { brightness: 80 } }, mergeBody);
    await advance(100);
    expect(sends[1]!.body).toEqual({ dimming: { brightness: 80 } });
    void send("light/1", { on: { on: false } }, mergeBody);
    void send("light/1", { dimming: { brightness: 5 } }, mergeBody);
    await advance(100);
    expect(sends[2]!.body).toEqual({ on: { on: false }, dimming: { brightness: 5 } });
  });

  test("slots keep their order and share the lane's gap", async () => {
    const { send, sends, advance } = recorded({ gapMs: 100 });
    for (const slot of ["a", "b", "c", "b"]) void send(slot, slot);
    for (let i = 0; i < 3; i++) await advance(100);
    expect(sends.map((s) => [s.at, s.slot])).toEqual([[0, "a"], [100, "b"], [200, "c"]]);
  });

  test("a slot over its rate waits, still coalescing, and other slots go meanwhile", async () => {
    const { send, sends, advance } = recorded({ gapMs: 0, perMinute: 2 });
    void send("ac", 1);
    await advance(10);
    void send("ac", 2);
    await advance(10);
    void send("ac", 3);
    void send("ac", 4);
    void send("fan", "on");
    await advance(0);
    expect(sends.map((s) => s.body)).toEqual([1, 2, "on"]);
    await advance(59_980); // the clock reads 60 000: the first ac send leaves the minute
    expect(sends.map((s) => [s.at, s.body])).toEqual([[0, 1], [10, 2], [20, "on"], [60_000, 4]]);
  });

  test("a failed send rejects every write it carried, and the lane carries on", async () => {
    const { clock, advance } = manualClock();
    const lane = writeLane({ gapMs: 100, clock });
    const fail = () => Promise.reject(new Error("refused"));
    void lane.send("x", 1, async (b) => b);
    const a = lane.send("x", 2, fail).catch((e: Error) => e.message);
    const b = lane.send("x", 3, fail).catch((e: Error) => e.message);
    await advance(100);
    expect(await Promise.all([a, b])).toEqual(["refused", "refused"]);
    const c = lane.send("x", 4, async (n) => n);
    await advance(100);
    expect(await c).toBe(4);
  });
});

describe("mergeWrites (Daikin)", () => {
  test("mode then power off goes as one request: mode kept, power off", () => {
    const merged = JSON.stringify(mergeWrites(setMode("cool"), setPower(false)));
    expect(merged).toContain('"pv":"00"');
    expect(merged).toContain('"pv":"0200"');
    expect(merged).not.toContain('"pv":"01"');
  });

  test("the newest setpoint wins", () => {
    expect(mergeWrites(setTarget(22, "cool"), setTarget(24, "cool"))).toEqual(setTarget(24, "cool"));
  });
});
