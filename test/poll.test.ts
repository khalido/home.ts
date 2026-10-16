import { describe, expect, test } from "bun:test";
import { type Clock, createHome, type Integration } from "../src/index.ts";
import { poller } from "../src/poll.ts";

/** A clock whose sleeps never end by themselves: only an abort (or a nudge) ends one. */
const stuck: Clock = { now: () => 0, sleep: (_ms, signal) => new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })) };

describe("poller", () => {
  test("wait resolves on nudge, and says so", async () => {
    const poll = poller(stuck);
    const waiting = poll.wait(60_000);
    poll.nudge();
    expect(await waiting).toBe(true);
  });

  test("wait resolves on abort", async () => {
    const poll = poller(stuck);
    const stop = new AbortController();
    const waiting = poll.wait(60_000, stop.signal);
    stop.abort();
    expect(await waiting).toBe(false);
  });

  test("a nudge while nobody waits makes the next wait return at once, once", async () => {
    const poll = poller(stuck);
    poll.nudge();
    expect(await poll.wait(60_000)).toBe(true);
    let done = false;
    const second = poll.wait(60_000).then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    poll.nudge();
    await second;
  });
});

describe("createHome refresh", () => {
  const counting = (name: string) => {
    const counter = { refreshed: 0 };
    const i: Integration = { name, run: async () => {}, refresh: () => void counter.refreshed++ };
    return { i, counter };
  };

  test("reaches every integration, or one by name", () => {
    const a = counting("a");
    const b = counting("b");
    const home = createHome([a.i, b.i]);
    home.refresh();
    expect([a.counter.refreshed, b.counter.refreshed]).toEqual([1, 1]);
    home.refresh("b");
    expect([a.counter.refreshed, b.counter.refreshed]).toEqual([1, 2]);
    expect(() => home.refresh("nope")).toThrow('no integration "nope"; have a, b');
  });
});
