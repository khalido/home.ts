import { z } from "zod";
import { asOf, type Clock, realClock } from "./clock.ts";
import { errorText } from "./connector.ts";

/** A secret in a home config is the name of an environment variable, never the secret: a pasted key fails here. */
export const envName = z
  .string()
  .regex(
    /^[A-Z_][A-Z0-9_]*$/,
    "an environment variable name (e.g. AMBER_KEY), not the secret itself",
  );
/** A file a connector needs (a CA, a token), relative to the config file or from `~/`. The caller reads it, and expands `~/`; the library reads no files. */
export const filePath = z.string().min(1);

/** How an integration is doing. "unavailable" means it stopped and will not retry by itself. */
export type Status =
  "connecting" | "connected" | "disconnected" | "unavailable";

/** Why a part is `unavailable`, for code to switch on; `detail` is the text for people. `auth`: a key or token was rejected or is unusable, so a person must re-key. `config`: a setting or a file is wrong. `crashed`: its `run` threw. */
export type Reason = "auth" | "config" | "crashed";

/**
 * One integration's slice of the home: its status, a human detail, `reason` (why it is `unavailable`, for code to switch on), anything odd the device reported, and its state.
 * `createHome` stamps the times (UTC ISO). `lastGoodAt`: its last report while connected, or the read time a connected report
 * gives when it repeats an older read (weather's 5-minute sun tick). `downSince`: when it stopped being connected (or started,
 * if it never has); none while connected. Any other time an integration sets is ignored.
 */
export type Part<S = unknown> = {
  status: Status;
  detail?: string;
  reason?: Reason;
  anomaly?: string;
  state?: S;
  lastGoodAt?: string;
  downSince?: string;
};

/**
 * The few things every device answers, whatever it is, in the same words; a connector's `<name>HomeDevices(part)` returns
 * these and `homeDevices(snapshot)` collects them. Everything particular to its kind is in `detail`, the connector's own
 * typed row, and `connector` (with `kind`) says which type that is. Unknown stays absent, never guessed.
 * - `id`: the device's own stable id (a Hue light id, a castId, a printer's UUID), or the connector's name when it has one device.
 * - `kind`: light, group, speaker, display, tv, ac, printer, solar (and `cast` for a Cast model this library doesn't know).
 * - `available`: it answered and can be used now. When it is false, `reason` says why in one word: `offline`, or the
 *   connector's own reason for being `unavailable` (`auth`, `config`, `crashed`).
 * - `asOf`: when the device last reported (a push connector) or was last read (a polled one). A quiet light can be hours
 *   old and current: `available` says whether it is.
 * - `state`: one short word in that kind's vocabulary: on, off, idle, busy, cool, printing.
 * - `text`: one line for people, "Kitchen: on · 60%".
 * - `room`: a room id from the home config, when one places it.
 * - `members`: a group's device ids.
 */
export type DeviceRecord<
  C extends string = string,
  K extends string = string,
  S extends string = string,
  D = unknown,
> = {
  connector: C;
  id: string;
  name: string;
  kind: K;
  available?: boolean;
  reason?: Reason | "offline";
  asOf?: string;
  state?: S;
  text: string;
  room?: string;
  members?: string[];
  detail: D;
};

/**
 * A connector's device records from its part. While the connector isn't connected none is `available`, and each keeps its
 * last values, as the part's state does. A device that isn't available gets its `reason`: the part's when it stopped for
 * good, else `offline`.
 */
export const deviceRecords = <R extends DeviceRecord>(
  part: Part | undefined,
  records: R[],
): R[] => {
  const up = part?.status === "connected";
  // A part that stopped for good without saying why is a custom integration's: `config` is the nearest true word, since it won't come back by itself.
  const why =
    part?.status === "unavailable" ? (part.reason ?? "config") : "offline";
  return records.map((r) =>
    up && r.available !== false
      ? r
      : { ...r, available: false, reason: up ? "offline" : why },
  );
};

/**
 * An integration is a folder in `src/` that exports a factory returning this.
 * `run` keeps its state current until `signal` aborts, reporting each change through `update`.
 * `refresh` asks for a fresh read now, ahead of the integration's schedule; it returns at once and the read reports through `update`.
 */
export type Integration<S = unknown, N extends string = string> = {
  name: N;
  run(signal: AbortSignal, update: (part: Part<S>) => void): Promise<void>;
  refresh(): void;
};

/** The state an integration reports. */
export type StateOf<I> = I extends Integration<infer S, string> ? S : never;

/**
 * The whole home: one `Part` per integration, by name, each typed by its integration (`snapshot.weather?.state` is a
 * `WeatherState`). A name can be missing: a config need not have every connector. This is the cache every read comes from.
 */
export type HomeSnapshot<
  I extends Integration<any, string> = Integration<unknown, string>,
> = { [X in I as X["name"]]?: Part<StateOf<X>> };

/** One report: which integration, its part before and after. Typed by name, so `change.after.state` is that integration's state. */
export type Change<
  I extends Integration<any, string> = Integration<unknown, string>,
> = {
  [X in I as X["name"]]: {
    name: X["name"];
    before: Part<StateOf<X>>;
    after: Part<StateOf<X>>;
  };
}[I["name"]];

/** The times `createHome` keeps on a part, from the one before it: when it was last good, and when it stopped being. */
function stamped(part: Part, before: Part | undefined, now: string): Part {
  if (part.status === "connected")
    return {
      ...part,
      lastGoodAt: part.lastGoodAt ?? now,
      downSince: undefined,
    };
  return {
    ...part,
    lastGoodAt: before?.lastGoodAt,
    downSince: before?.downSince ?? now,
  };
}

/**
 * Load a home: run each integration, keep one snapshot, call `onChange` with it and what changed after every report.
 * `clock` stamps each part's `lastGoodAt` and `downSince`. `add` and `remove` change the set while it runs.
 */
export function createHome<I extends Integration<any, string>>(
  integrations: readonly I[],
  onChange?: (home: HomeSnapshot<I>, change: Change<I>) => void,
  options: { clock?: Clock } = {},
) {
  type Name = I["name"];
  type Run = { stop: AbortController; done: Promise<void> };
  const clock = options.clock ?? realClock;
  const list: I[] = [...integrations]; // the integrations now: `add` and `remove` change it
  const parts = () => snapshot as Record<string, Part>;
  let snapshot = Object.fromEntries(
    list.map((i) => [i.name, { status: "connecting" }]),
  ) as HomeSnapshot<I>;
  const waiting = new Map<string, (() => void)[]>(); // refresh() callers, resolved by the integration's next report
  const runs = new Map<I, Run>(); // the ones running: before start or after its run ended, a refresh resolves at once, nothing will report
  const latest = new WeakMap<I, Run>(); // each integration's newest run: a report from an older run of the same object is dropped
  let started: AbortSignal | undefined; // start()'s signal, while it runs
  let changing: Promise<unknown> = Promise.resolve(); // add and remove, one at a time: two on one name must not overlap
  let changes = 0; // those under way or queued: start outlasts a replace of its only integration
  const change = <T>(fn: () => Promise<T>): Promise<T> => {
    changes++;
    const done = changing.then(fn).finally(() => changes--);
    changing = done.catch(() => {});
    return done;
  };
  const heard = (name: string) => {
    for (const resolve of waiting.get(name) ?? []) resolve();
    waiting.delete(name);
  };
  // A report counts only from the integration now listed under its name: one replaced or removed may still be finishing.
  const set = (i: I, run: Run, reported: Part) => {
    const name: Name = i.name;
    const before = parts()[name];
    if (latest.get(i) !== run || !list.includes(i) || !before) return;
    const part = stamped(reported, before, asOf(clock));
    snapshot = { ...snapshot, [name]: part };
    Promise.try(() =>
      onChange?.(snapshot, { name, before, after: part } as Change<I>),
    ).catch((error) =>
      console.error(`onChange threw on ${name}: ${errorText(error)}`),
    ); // the caller's bug, thrown or async, not the device's: the integration keeps running
    heard(name);
  };
  /** Run one integration until the home's signal or its own `stop` aborts. One failing marks itself unavailable. */
  const launch = (i: I, signal: AbortSignal) => {
    const stop = new AbortController();
    const run: Run = { stop, done: Promise.resolve() };
    runs.set(i, run);
    latest.set(i, run);
    run.done = Promise.try(() =>
      i.run(AbortSignal.any([signal, stop.signal]), (part) =>
        set(i, run, part),
      ),
    )
      .catch((error) =>
        set(i, run, {
          status: "unavailable",
          reason: "crashed",
          detail: errorText(error),
          state: parts()[i.name]?.state, // the last good state stays, as it does through a failed read
        }),
      )
      .finally(() => {
        if (runs.get(i) !== run) return;
        runs.delete(i);
        if (list.includes(i)) heard(i.name); // nothing more will report
      });
  };
  /** Take one out of the list and the snapshot, and wait for its run to end. */
  const drop = async (name: string) => {
    const at = list.findIndex((i) => i.name === name);
    if (at < 0) return false;
    const [old] = list.splice(at, 1);
    const { [name]: _, ...rest } = parts();
    snapshot = rest as HomeSnapshot<I>;
    heard(name);
    const run = runs.get(old!);
    run?.stop.abort();
    await run?.done;
    return true;
  };
  return {
    /** The latest snapshot. Never touches a device. */
    snapshot: () => snapshot,
    /** One integration's part, typed by its name: `home.part("weather")?.state?.blocks`. */
    part: <N extends Name>(name: N): HomeSnapshot<I>[N] => snapshot[name],
    /** One integration by name, for its writes: `home.integration("daikin")?.client.write(setPower(true))`. */
    integration: <N extends Name>(
      name: N,
    ): Extract<I, { name: N }> | undefined =>
      list.find((i) => i.name === name) as Extract<I, { name: N }> | undefined,
    /**
     * Read now: one integration by name, or every one. Results arrive through the snapshot and `onChange` as usual; the
     * promise resolves once each target has reported (its next update, good or bad), or at once for one that isn't running.
     */
    refresh(name?: Name): Promise<void> {
      const targets =
        name === undefined ? [...list] : list.filter((i) => i.name === name);
      if (!targets.length && name !== undefined)
        throw new Error(
          `no integration "${name}"; have ${list.map((i) => i.name).join(", ")}`,
        );
      const reported = targets.map(
        (i) =>
          new Promise<void>((resolve) => {
            if (!runs.has(i)) return resolve();
            waiting.set(i.name, [...(waiting.get(i.name) ?? []), resolve]);
          }),
      );
      for (const i of targets) i.refresh();
      return Promise.all(reported).then(() => undefined);
    },
    /**
     * Add an integration while the home runs, or before it starts: a bridge paired just now, a key that arrived late. One
     * already there under that name is stopped first and its part dropped, so the new one starts from `connecting` and
     * the two never run together. Resolves once the new one is running; its reports arrive as any other's. Calls on
     * one home run one at a time. Once `start`'s signal has aborted, an added one waits for the next `start`.
     */
    add: (integration: I): Promise<void> =>
      change(async () => {
        await drop(integration.name);
        list.push(integration);
        const live = started && !started.aborted ? started : undefined;
        snapshot = {
          ...snapshot,
          [integration.name]: {
            status: "connecting",
            ...(live ? { downSince: asOf(clock) } : {}),
          },
        };
        if (live) launch(integration, live);
      }),
    /** Stop one integration and drop its part from the snapshot. Resolves once its run has ended; false if there was none by that name. */
    remove: (name: Name): Promise<boolean> => change(() => drop(name)),
    /** Run every integration, and any added meanwhile, until `signal` aborts. One failing marks itself unavailable; the rest carry on. */
    async start(signal: AbortSignal): Promise<void> {
      started = signal;
      const now = asOf(clock); // the wait for a first report counts from here, not from createHome
      snapshot = Object.fromEntries(
        Object.entries(parts()).map(([name, p]) => [
          name,
          p.status === "connecting"
            ? { ...p, downSince: p.downSince ?? now }
            : p,
        ]),
      ) as HomeSnapshot<I>;
      for (const i of list) launch(i, signal); // a second start, after the first has stopped, runs them all again
      // Until every run has ended, those added meanwhile too.
      while (runs.size || changes)
        await Promise.all([...[...runs.values()].map((r) => r.done), changing]);
      // `started` stays: one added after every run has ended still runs, until the signal aborts.
    },
  };
}

/** Answered: past connecting, and when the state lists sources (the weather), every source has read. */
const answered = (p: Part | undefined) =>
  !!p &&
  p.status !== "connecting" &&
  Object.values(
    (p.state as { sources?: Record<string, { read: boolean }> })?.sources ?? {},
  ).every((s) => s.read);

/**
 * One read of everything, for a script, a test or a one-shot command: run the integrations until each has answered
 * (connected or not), at most `ms` (15 s by default) or until `signal` aborts, then stop them and return the snapshot.
 */
export async function settle<I extends Integration<any, string>>(
  integrations: readonly I[],
  options: { ms?: number; clock?: Clock; signal?: AbortSignal } = {},
): Promise<HomeSnapshot<I>> {
  const { ms = 15_000, clock = realClock, signal } = options;
  const stop = new AbortController();
  const run = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal; // the caller's signal stops it too, with nothing left on it after
  const home = createHome(
    integrations,
    (snapshot) => {
      if (Object.values(snapshot as Record<string, Part>).every(answered))
        stop.abort();
    },
    { clock },
  );
  const running = home.start(run);
  await Promise.race([clock.sleep(ms, run), running]);
  stop.abort();
  await running;
  return home.snapshot();
}
