import { describe, expect, test } from "bun:test";
import { createHome, health, type Integration, type Part } from "../src/index.ts";
import { manualClock } from "./clock.ts";

const MIN = 60_000;
const at = (ms: number) => new Date(ms).toISOString();

describe("createHome stamps", () => {
  test("lastGoodAt on each connected report, downSince from the first report after it, and onChange says what changed", async () => {
    const { clock, advance } = manualClock();
    let report: ((p: Part<number>) => void) | undefined;
    const i: Integration<number, "amber"> = { name: "amber", refresh() {}, run: (signal, u) => new Promise((r) => ((report = u), signal.addEventListener("abort", () => r()))) };
    const changes: unknown[] = [];
    const home = createHome([i], (_s, change) => changes.push(change), { clock });
    expect(home.part("amber")).toEqual({ status: "connecting" });
    await advance(MIN);
    const stop = new AbortController();
    const running = home.start(stop.signal);
    expect(home.part("amber")).toEqual({ status: "connecting", downSince: at(MIN) }); // from start, not from createHome
    report!({ status: "connected", state: 1 });
    await advance(MIN);
    report!({ status: "disconnected", detail: "fetch failed", state: 1, lastGoodAt: "ignored" });
    await advance(MIN);
    report!({ status: "disconnected", detail: "fetch failed", state: 1 });
    expect(home.part("amber")).toMatchObject({ lastGoodAt: at(MIN), downSince: at(2 * MIN) });
    expect(changes[1]).toMatchObject({ name: "amber", before: { status: "connected", state: 1 }, after: { status: "disconnected" } });
    expect(home.integration("amber")).toBe(i);
    stop.abort();
    await running;
  });
});

describe("health", () => {
  const amberPoll = 60; // its manifest's
  test("a poll connector: ok, stale after 2½ polls with no good read, down after 3 polls not connected", () => {
    const good: Part = { status: "connected", lastGoodAt: at(0) };
    expect(health({ amber: good }, MIN).amber).toMatchObject({ level: "ok", staleAfterMs: 2.5 * amberPoll * 1000, downAfterMs: 3 * amberPoll * 1000 });
    expect(health({ amber: good }, 131_000).amber!.level).toBe("ok"); // one read timed out, the next landed: not stale
    expect(health({ amber: good }, 2.5 * MIN).amber!.level).toBe("stale");
    const failing: Part = { status: "disconnected", lastGoodAt: at(0), downSince: at(MIN) };
    expect(health({ amber: failing }, 2.5 * MIN).amber!.level).toBe("stale");
    expect(health({ amber: failing }, 4 * MIN).amber).toMatchObject({ level: "down", lastGoodAt: at(0), downSince: at(MIN) });
  });

  test("unavailable is down at once; a push connector is never stale, down after PUSH_DOWN_MS", () => {
    expect(health({ amber: { status: "unavailable", detail: "Amber rejected the key" } }, 0).amber).toMatchObject({ level: "down", detail: "Amber rejected the key" });
    expect(health({ hue: { status: "connected", lastGoodAt: at(0) } }, 60 * MIN).hue).toMatchObject({ level: "ok", staleAfterMs: undefined });
    expect(health({ hue: { status: "connecting", downSince: at(0) } }, MIN).hue!.level).toBe("ok");
    expect(health({ hue: { status: "connecting", downSince: at(0) } }, 2 * MIN).hue!.level).toBe("down");
  });

  test("pollSeconds names an integration the library does not know", () => {
    expect(health({ bus: { status: "connected", lastGoodAt: at(0) } }, 2.5 * MIN, { bus: 60 }).bus!.level).toBe("stale");
  });
});
