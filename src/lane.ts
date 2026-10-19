import { type Clock, realClock } from "./clock.ts";

// Writes to a device go through a lane: one at a time, spaced by the device's gap, and coalesced per slot. A slot is
// what one write changes (a light, the AC, a speaker's volume). While a slot's write waits, a newer write to the same
// slot merges into it: the middle drops, the last value lands. A slot sending faster than `perMinute` is held to that
// rate rather than refused, so a runaway loop slows down and a person's last change still arrives.

export type LaneOptions = {
  /** Minimum time between two sends on the lane, across slots. */
  gapMs: number;
  /** At most this many sends per slot in any minute; more wait their turn, still coalescing. None: no cap. */
  perMinute?: number;
  clock?: Clock;
};

type Waiter = { resolve(value: unknown): void; reject(error: unknown): void };
type Pending = { slot: string; body: unknown; write: (body: unknown) => Promise<unknown>; waiters: Waiter[] };

const MINUTE = 60_000;

/**
 * A write lane for one device or bridge. `send(slot, body, write, merge)` resolves with the result of the send that
 * carried its body: a write merged into a later one resolves (or rejects) with that later one. `merge(older, newer)`
 * defaults to the newer body alone.
 */
export function writeLane(options: LaneOptions) {
  const clock = options.clock ?? realClock;
  const queue: Pending[] = []; // in order of each slot's first waiting write
  const sent = new Map<string, number[]>(); // send times per slot, the last minute's
  let lastAt = -Infinity;
  let running = false;
  let wake = new AbortController();

  const recent = (slot: string) => (sent.get(slot) ?? []).filter((t) => t > clock.now() - MINUTE);

  function readyAt(slot: string): number {
    const times = recent(slot);
    const capped = options.perMinute !== undefined && times.length >= options.perMinute ? times[times.length - options.perMinute]! + MINUTE : -Infinity;
    return Math.max(lastAt + options.gapMs, capped);
  }

  async function run() {
    running = true;
    while (queue.length) {
      const now = clock.now();
      const next = queue.find((p) => readyAt(p.slot) <= now);
      if (!next) {
        wake = new AbortController();
        await clock.sleep(Math.min(...queue.map((p) => readyAt(p.slot))) - now, wake.signal);
        continue;
      }
      queue.splice(queue.indexOf(next), 1);
      lastAt = now;
      sent.set(next.slot, [...recent(next.slot), now]);
      try {
        const result = await next.write(next.body);
        for (const w of next.waiters) w.resolve(result);
      } catch (error) {
        for (const w of next.waiters) w.reject(error);
      }
    }
    running = false;
  }

  return {
    send<B, T>(slot: string, body: B, write: (body: B) => Promise<T>, merge: (older: B, newer: B) => B = (_, newer) => newer): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const waiter = { resolve, reject } as Waiter;
        const waiting = queue.find((p) => p.slot === slot);
        if (waiting) {
          waiting.body = merge(waiting.body as B, body);
          waiting.write = write as Pending["write"];
          waiting.waiters.push(waiter);
          return;
        }
        queue.push({ slot, body, write: write as Pending["write"], waiters: [waiter] });
        if (running) wake.abort(); // a sleeping lane looks again: this slot may be ready sooner
        else void run();
      });
    },
  };
}
export type WriteLane = ReturnType<typeof writeLane>;
