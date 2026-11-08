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
