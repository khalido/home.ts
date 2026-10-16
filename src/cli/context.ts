// What every `home` command shares: the shell's environment, the config path, the address cache, and how to fail.
// src/cli/ is the one place in src/ that reads the environment (names in .env.example); the library takes parameters.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AddressCache, CachedAddress } from "../discover.ts";
import { parseJsonc } from "../config.ts";
import { fileCache } from "../finders.ts";
import { createHome, type HomeSnapshot, type Integration, type Part } from "../home.ts";

export const env = process.env;

/** What went wrong, coarsely, as `--json` errors carry it: `usage` exits 2, the rest 1. */
export type ErrorCode = "usage" | "auth" | "network" | "error";

/** An error `home` reports in one line, or as `{ error, code, fix }` under `--json`. `fix` is the one command that resolves it. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode = "error",
    readonly fix?: string,
  ) {
    super(message);
  }
}

/** Stop the command. `status` catches it per integration, so one failing connector never hides the others. */
export const fail = (message: string, code?: ErrorCode, fix?: string): never => {
  throw new CliError(message, code, fix);
};
/** A wrong command, verb or argument: the usage line, exit 2. */
export const usage = (message: string): never => fail(message, "usage");

/** The options cac parses: the global ones, and each command's own. */
export type Options = { json?: boolean; config?: string; write?: string | true; passes?: number | string; to?: unknown; say?: unknown; file?: unknown; volume?: number | string };

/** An option's text as typed: cac turns a number-like value into a number, and `type: [String]` into an array. */
export const text = (v: unknown): string | undefined => (v === undefined ? undefined : String(Array.isArray(v) ? v.at(-1) : v));

/** `--write [path]`: undefined when absent, "" when bare (the config from --config or HOME_CONFIG), else the path. */
export const writeTo = (o: Options) => (o.write === undefined ? undefined : o.write === true ? "" : String(o.write));

/** `~/` as the home folder: neither Bun's .env loading nor the shell (inside quotes) expands it. */
export const expandHome = (p: string) => p.replace(/^~(?=\/)/, homedir());

/** The home config (JSONC) from --config or HOME_CONFIG; without one, `status` and `probe` read env names. */
export const configPathOf = (o: Options) => {
  const p = o.config ?? env.HOME_CONFIG;
  return p ? expandHome(p) : undefined;
};

/** A path from the config, against the config's folder; `~/` is the home folder. */
export const fromConfig = (path: string, p: string) => resolve(dirname(path), expandHome(p));

export const readConfig = (path: string): unknown => parseJsonc(readFileSync(path, "utf8"));

/** The owner token's cache: written only by `home enphase login`, owner-only. */
export const TOKEN_FILE = join(homedir(), ".config", "home", "enphase-token.json");

/** Where discovered addresses are kept between runs (`home cache`), owner-only. */
export const CACHE_FILE = join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "home", "addresses.json");

/** The file cache, written once as `home` exits, with the latest addresses. */
export const addresses = (() => {
  const file = fileCache(CACHE_FILE);
  let pending: Record<string, CachedAddress> | undefined;
  const cache: AddressCache = { read: () => file.read(), write: (entries) => void (pending = entries) };
  return { cache, flush: () => pending && file.write(pending) };
})();

/** Answered: past connecting, and when the state lists sources (the weather), every source has read. */
const answered = (p: Part) => p.status !== "connecting" && Object.values((p.state as { sources?: Record<string, { read: boolean }> })?.sources ?? {}).every((s) => s.read);

/** Run integrations until each has answered, at most `ms`, then stop them. */
export async function settle(integrations: Integration<any>[], ms = 15_000): Promise<HomeSnapshot> {
  const home = createHome(integrations);
  const stop = new AbortController();
  const running = home.start(stop.signal);
  for (const until = Date.now() + ms; Date.now() < until && !Object.values(home.snapshot()).every(answered); ) await Bun.sleep(100);
  stop.abort();
  await running;
  return home.snapshot();
}

/** Print as JSON, two-space indented. */
export const printJson = (value: unknown) => console.log(JSON.stringify(value, null, 2));

/** A connector's verbs beyond its status (`home cast announce …`): each takes the words after the verb and the options. */
export type Verbs = Record<string, (args: string[], o: Options) => Promise<unknown>>;
