import { z } from "zod";
import { type Clock, realClock } from "./clock.ts";
import { errorText } from "./connector.ts";

/** A secret in a home config is the name of an environment variable, never the secret: a pasted key fails here. */
export const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "an environment variable name (e.g. AMBER_KEY), not the secret itself");
/** A file a connector needs (a CA, a token), relative to the config file. The caller reads it; the library reads no files. */
export const filePath = z.string().min(1);

/** How an integration is doing. "unavailable" means it stopped and will not retry by itself. */
export type Status = "connecting" | "connected" | "disconnected" | "unavailable";

/** One integration's slice of the home: its status, a human detail, anything odd the device reported, and its state. */
export type Part<S = unknown> = { status: Status; detail?: string; anomaly?: string; state?: S };

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
export type HomeSnapshot<I extends Integration<any, string> = Integration<unknown, string>> = { [X in I as X["name"]]?: Part<StateOf<X>> };

/** Load a home: run each integration, keep one snapshot, call `onChange` with it after every change. */
export function createHome<I extends Integration<any, string>>(integrations: readonly I[], onChange?: (home: HomeSnapshot<I>) => void) {
  type Name = I["name"];
  let snapshot = Object.fromEntries(integrations.map((i) => [i.name, { status: "connecting" }])) as HomeSnapshot<I>;
  const waiting = new Map<string, (() => void)[]>(); // refresh() callers, resolved by the integration's next report
  const finished = new Set<string>(); // integrations whose run has ended: a refresh of one resolves at once, nothing will report
  const set = (name: Name, part: Part) => {
    snapshot = { ...snapshot, [name]: part };
    onChange?.(snapshot);
    const w = waiting.get(name);
    if (w) {
      waiting.delete(name);
      for (const resolve of w) resolve();
    }
  };
  return {
    /** The latest snapshot. Never touches a device. */
    snapshot: () => snapshot,
    /** One integration's part, typed by its name: `home.part("weather")?.state?.blocks`. */
    part: <N extends Name>(name: N): HomeSnapshot<I>[N] => snapshot[name],
    /**
     * Read now: one integration by name, or every one. Results arrive through the snapshot and `onChange` as usual; the
     * promise resolves once each target has reported (its next update, good or bad), or at once for one whose run has ended.
     */
    refresh(name?: Name): Promise<void> {
      const targets = name === undefined ? integrations : integrations.filter((i) => i.name === name);
      if (!targets.length) throw new Error(`no integration "${name}"; have ${integrations.map((i) => i.name).join(", ")}`);
      const reported = targets.map(
        (i) =>
          new Promise<void>((resolve) => {
            if (finished.has(i.name)) return resolve();
            waiting.set(i.name, [...(waiting.get(i.name) ?? []), resolve]);
          }),
      );
      for (const i of targets) i.refresh();
      return Promise.all(reported).then(() => undefined);
    },
    /** Run every integration until `signal` aborts. One failing marks itself unavailable; the rest carry on. */
    async start(signal: AbortSignal): Promise<void> {
      await Promise.all(
        integrations.map((i) =>
          i
            .run(signal, (part) => set(i.name, part))
            .catch((error) => set(i.name, { status: "unavailable", detail: errorText(error) }))
            .finally(() => {
              finished.add(i.name);
              for (const resolve of waiting.get(i.name) ?? []) resolve(); // nothing more will report
              waiting.delete(i.name);
            }),
        ),
      );
    },
  };
}

/** Answered: past connecting, and when the state lists sources (the weather), every source has read. */
const answered = (p: Part | undefined) => !!p && p.status !== "connecting" && Object.values((p.state as { sources?: Record<string, { read: boolean }> })?.sources ?? {}).every((s) => s.read);

/**
 * One read of everything, for a script, a test or a one-shot command: run the integrations until each has answered
 * (connected or not), at most `ms`, then stop them and return the snapshot.
 */
export async function settle<I extends Integration<any, string>>(integrations: readonly I[], ms = 15_000, clock: Clock = realClock): Promise<HomeSnapshot<I>> {
  const stop = new AbortController();
  const home = createHome(integrations, (snapshot) => {
    if (Object.values(snapshot as Record<string, Part>).every(answered)) stop.abort();
  });
  const running = home.start(stop.signal);
  await Promise.race([clock.sleep(ms, stop.signal), running]);
  stop.abort();
  await running;
  return home.snapshot();
}
