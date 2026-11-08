/** Time as a parameter, so queues and backoff run in tests without waiting. */
export type Clock = {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

/** The wall clock. `sleep` resolves early when `signal` aborts. */
export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      const done = () => (
        clearTimeout(timer),
        signal?.removeEventListener("abort", done),
        resolve()
      );
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
    }),
};

/** The calendar day at `ms` in an IANA time zone (the runtime's when left out), as YYYY-MM-DD: where "today" starts. */
export const localDay = (ms: number, timeZone?: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);

/** The hour of the day (0–23) at `ms` in an IANA time zone, the runtime's when left out. */
export const localHour = (ms: number, timeZone?: string) =>
  Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(ms),
  );

/** "20:15" at `ms` in an IANA time zone, the runtime's when left out. */
export const localTime = (ms: number, timeZone?: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(ms);

/** Whether a name is an IANA time zone this runtime knows. */
export function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The clock's now as an ISO string: the `asOf` every snapshot carries. */
export const asOf = (clock: Pick<Clock, "now">) =>
  new Date(clock.now()).toISOString();
