import { describe, expect, spyOn, test } from "bun:test";
import { realClock } from "../src/clock.ts";
import { createHome, type Integration, settle } from "../src/home.ts";
import { manualClock } from "./clock.ts";

/** A fake integration: reports when poked, ends when its signal aborts. */
function fake(name: string) {
  let update: ((p: { status: "connected"; state: number }) => void) | undefined;
  let reads = 0;
  const i: Integration<number> & { report(): void } = {
    name,
    run: (signal, u) =>
      new Promise((resolve) => {
        update = u;
        signal.addEventListener("abort", () => resolve());
      }),
    refresh: () => {
      reads++;
    },
    report: () => update?.({ status: "connected", state: reads }),
  };
  return i;
}

describe("createHome.refresh", () => {
  test("resolves once the integration reports, with the snapshot already updated", async () => {
    const a = fake("a");
    const home = createHome([a]);
    const ac = new AbortController();
    const running = home.start(ac.signal);
    let done = false;
    const p = home.refresh("a").then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false); // nothing reported yet
    a.report();
    await p;
    expect(home.snapshot().a?.state).toBe(1);
    ac.abort();
    await running;
  });

  test("refresh() with no name waits for every integration; an unknown name throws", async () => {
    const a = fake("a");
    const b = fake("b");
    const home = createHome([a, b]);
    const ac = new AbortController();
    const running = home.start(ac.signal);
    let done = false;
    const p = home.refresh().then(() => (done = true));
    a.report();
    await Promise.resolve();
    expect(done).toBe(false); // b has not reported
    b.report();
    await p;
    expect(() => home.refresh("zzz")).toThrow('no integration "zzz"');
    ac.abort();
    await running;
  });

  test("a refresh of an integration whose run has ended resolves at once", async () => {
    const a = fake("a");
    const home = createHome([a]);
    const ac = new AbortController();
    const running = home.start(ac.signal);
    ac.abort();
    await running;
    await home.refresh("a"); // would hang if it waited for a report
    expect(home.snapshot().a?.status).toBe("connecting"); // never reported, never flipped
  });

  test("a refresh before start resolves at once", async () => {
    await createHome([fake("a")]).refresh("a"); // would hang if it waited for a report
  });
});

describe("createHome failures", () => {
  test("an onChange that throws is logged, and the integration keeps running", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const a = fake("a");
    const home = createHome([a], () => {
      throw new Error("consumer bug");
    });
    const ac = new AbortController();
    const running = home.start(ac.signal);
    a.report();
    ac.abort();
    await running;
    expect(home.snapshot().a?.status).toBe("connected");
    expect(logged.mock.calls[0]?.[0]).toContain("consumer bug");
    logged.mockRestore();
  });

  test("a run that fails after a good report keeps its state", async () => {
    const a: Integration<number> = {
      name: "a",
      run: async (_, update) => {
        update({ status: "connected", state: 7 });
        throw new Error("broke");
      },
      refresh: () => {},
    };
    const home = createHome([a]);
    await home.start(new AbortController().signal);
    expect(home.snapshot().a).toMatchObject({
      status: "unavailable",
      detail: "broke",
      state: 7,
    });
  });

  test("a run that throws synchronously fails alone", async () => {
    const bad: Integration<number> = {
      name: "bad",
      run: () => {
        throw new Error("no promise");
      },
      refresh: () => {},
    };
    const ran: string[] = [];
    const good: Integration<number> = {
      name: "good",
      run: async () => void ran.push("good"),
      refresh: () => {},
    };
    const home = createHome([bad, good]);
    await home.start(new AbortController().signal);
    expect(home.snapshot().bad?.status).toBe("unavailable");
    expect(ran).toEqual(["good"]);
  });
});

test("realClock.sleep resolves at once on an aborted signal", async () => {
  const start = Date.now();
  await realClock.sleep(5_000, AbortSignal.abort());
  expect(Date.now() - start).toBeLessThan(1_000);
});

describe("createHome.start", () => {
  test("a second start, after the first has stopped, runs every integration again", async () => {
    let runs = 0;
    const i: Integration<number> = {
      name: "a",
      refresh() {},
      run: (signal) =>
        new Promise(
          (r) => (runs++, signal.addEventListener("abort", () => r())),
        ),
    };
    const home = createHome([i]);
    for (let n = 0; n < 2; n++) {
      const stop = new AbortController();
      const running = home.start(stop.signal);
      stop.abort();
      await running;
    }
    expect(runs).toBe(2);
  });
});

describe("settle", () => {
  test("returns once every integration has answered, and stops them", async () => {
    const a = fake("a");
    const b = fake("b");
    const { clock } = manualClock();
    const p = settle([a, b], { clock });
    await Promise.resolve();
    a.report();
    b.report();
    expect((await p).b).toMatchObject({ status: "connected", state: 0 });
  });

  test("the caller's signal stops it early", async () => {
    const stop = new AbortController();
    const p = settle([fake("a")], { signal: stop.signal });
    stop.abort();
    expect((await p).a?.status).toBe("connecting");
  });

  test("gives up after `ms`, leaving a silent one connecting", async () => {
    const a = fake("a");
    const b = fake("b");
    const { clock, advance } = manualClock();
    const p = settle([a, b], { ms: 1000, clock });
    await Promise.resolve();
    a.report();
    await advance(1000);
    const s = await p;
    expect([s.a?.status, s.b?.status]).toEqual(["connected", "connecting"]);
  });
});
