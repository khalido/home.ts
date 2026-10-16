import type { Clock } from "./clock.ts";

/**
 * The wait between polls, shared by every polling integration, so each can be told to read now.
 * `wait` resolves after `ms`, on abort, or on `nudge()`, and says whether a nudge woke it. A nudge while no one is waiting (mid-read) makes the next wait
 * return at once, so a refresh asked for during a read still gets a read that starts after it.
 */
export function poller(clock: Clock) {
  let wake: (() => void) | undefined;
  let pending = false;
  return {
    async wait(ms: number, signal?: AbortSignal): Promise<boolean> {
      if (signal?.aborted) return false;
      if (pending) return !(pending = false);
      const nudged = new AbortController();
      wake = () => nudged.abort();
      try {
        await clock.sleep(ms, signal ? AbortSignal.any([signal, nudged.signal]) : nudged.signal);
        return nudged.signal.aborted;
      } finally {
        wake = undefined;
        pending = false;
      }
    },
    nudge(): void {
      if (wake) wake();
      else pending = true;
    },
  };
}
