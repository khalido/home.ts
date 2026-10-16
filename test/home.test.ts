import { describe, expect, test } from "bun:test";
import { createHome, type Integration } from "../src/home.ts";

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
});
