import type { Clock } from "../src/index.ts";

/** A clock the test moves: `advance(ms)` wakes every sleep whose time has come. */
export function manualClock() {
  let t = 0;
  const sleeps: { at: number; wake: () => void }[] = [];
  const clock: Clock = {
    now: () => t,
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const entry = { at: t + ms, wake: () => resolve() };
        sleeps.push(entry);
        signal?.addEventListener("abort", () => resolve(), { once: true });
      }),
  };
  const advance = async (ms: number) => {
    t += ms;
    for (const s of sleeps.filter((x) => x.at <= t))
      (sleeps.splice(sleeps.indexOf(s), 1), s.wake());
    await Bun.sleep(5);
  };
  return { clock, advance };
}

/** Time stands at `at`; the `n`th sleep stops the run. */
export const stopAfter = (stop: AbortController, n: number, at = 0): Clock => {
  let sleeps = 0;
  return {
    now: () => at,
    sleep: async () => void (++sleeps >= n && stop.abort()),
  };
};

/** Time starts at 0 and each sleep moves it on; reaching `until` stops the run. */
export const stopAt = (stop: AbortController, until: number): Clock => {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => void ((t += ms), t >= until && stop.abort()),
  };
};

/** Sleeps never end on their own, only when their signal aborts. */
export const idleClock = (now: () => number = Date.now): Clock => ({
  now,
  sleep: (_ms, signal) =>
    new Promise((resolve) =>
      signal?.aborted
        ? resolve()
        : signal?.addEventListener("abort", () => resolve(), { once: true }),
    ),
});
