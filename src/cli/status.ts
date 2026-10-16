// `home status` and `home <connector>`: build each integration (from a config, else from the shell's env names), run
// them until each has answered, and print each through its connector's manifest.
import { existsSync, readFileSync, statSync } from "node:fs";
import { amber } from "../connectors/amber/index.ts";
import { tlsConnect } from "../connectors/cast/tls.ts";
import { daikin } from "../connectors/daikin/index.ts";
import { bom, google, openMeteo, weather, type WeatherSource } from "../connectors/weather/index.ts";
import { ftpFetch } from "../connectors/weather/ftp.ts";
import { isTimeZone } from "../clock.ts";
import { loadHome } from "../config.ts";
import { energyNow, gridText } from "../energy.ts";
import { FINDERS } from "../finders.ts";
import type { Integration, Part, Status } from "../home.ts";
import { kw, type Manifest } from "../manifest.ts";
import { MANIFESTS, manifestOf } from "../manifests.ts";
import { castNow } from "./cast.ts";
import { printersNow } from "./printers.ts";
import { addresses, configPathOf, env, fail, fromConfig, type Options, printJson, readConfig, settle, TOKEN_FILE } from "./context.ts";
import { enphaseFromEnv } from "./enphase.ts";
import { hueFromEnv } from "./hue.ts";
import { upFromEnv } from "./up.ts";

/** One connector's row: its part, or "not set up" with the env names (and steps) it still needs. */
type Row = Omit<Part, "status"> & { status: Status | "not set up"; needs: string[] };

/** HOME_LATITUDE and HOME_LONGITUDE as numbers; the manifest's `needs` has already checked they are set. */
export function place(): { latitude: number; longitude: number } {
  const latitude = Number(env.HOME_LATITUDE);
  const longitude = Number(env.HOME_LONGITUDE);
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : fail("HOME_LATITUDE and HOME_LONGITUDE must be numbers");
}

/** HOME_TIMEZONE, the env form of the config's `location.timezone`; this machine's zone when unset. */
export function homeTimeZone(): string | undefined {
  const zone = env.HOME_TIMEZONE;
  return zone === undefined || isTimeZone(zone) ? zone : fail(`HOME_TIMEZONE: an IANA time zone, e.g. Australia/Sydney, not ${zone}`);
}

/** The weather sources KO's env sets up, in preference order: BOM (opt-in, with the FTP transport), Open-Meteo, then Google if keyed, as the last resort. */
export const weatherSources = (): WeatherSource[] => [
  bom({ fetch: ftpFetch(), forecastLocation: env.HOME_BOM_FORECAST }),
  openMeteo(),
  ...(env.GOOGLE_WEATHER_KEY ? [google({ key: env.GOOGLE_WEATHER_KEY })] : []),
];

/**
 * Each connector from the shell's env names, once the manifest's non-optional names are set. `needs` adds a step that
 * is not an env name (Enphase's token file). Addresses come from the env only; `home probe` and `home discover` search.
 */
const FROM_ENV: Record<string, { needs?: () => string[]; build: () => Integration<any> | Promise<Integration<any>> }> = {
  hue: { build: hueFromEnv },
  daikin: { build: () => daikin({ host: env.DAIKIN_HOST!, fetch }) },
  enphase: { needs: () => (existsSync(TOKEN_FILE) ? [] : ["`home enphase login`"]), build: enphaseFromEnv },
  amber: { build: () => amber({ key: env.AMBER_KEY!, siteId: env.AMBER_SITE_ID, fetch }) },
  up: { build: upFromEnv },
  weather: { build: () => weather({ ...place(), sources: weatherSources(), timeZone: homeTimeZone() }) },
  cast: { build: castNow },
  printers: { build: printersNow },
};

/** The rows for these manifests from the shell: not set up, failed to build, or run until each has answered. */
async function statusFromEnv(manifests: Manifest[]): Promise<Record<string, Row>> {
  const rows: Record<string, Row> = {};
  const built = await Promise.all( // in parallel: Hue's build can wait on mDNS
    manifests.map(async (m): Promise<Integration<any>[]> => {
      const from = FROM_ENV[m.name]!;
      const needs = [...m.env.filter((e) => !e.optional && !env[e.name]).map((e) => e.name), ...(from.needs?.() ?? [])];
      rows[m.name] = { status: needs.length ? "not set up" : "connecting", needs };
      if (needs.length) return [];
      try {
        return [await from.build()];
      } catch (error) {
        rows[m.name] = { status: "unavailable", needs, detail: (error as Error).message };
        return [];
      }
    }),
  );
  for (const [name, part] of Object.entries(await settle(built.flat()))) rows[name] = { ...part, needs: [] };
  return rows;
}

/** The rows from a config: its integrations (or the one named) run until each has answered (weather: every source), at most 15 s. */
async function statusFromConfig(path: string, only?: string): Promise<Record<string, Row>> {
  const options = { env, readFile: (p: string) => readFileSync(fromConfig(path, p), "utf8"), ftpFetch: ftpFetch(), finders: FINDERS, castConnect: tlsConnect, cache: addresses.cache, configAt: statSync(path).mtimeMs };
  const all = loadHome(readConfig(path), options);
  const integrations = only === undefined ? all : all.filter((i) => i.name === only);
  if (!integrations.length) fail(`no ${only} in ${path}`);
  return Object.fromEntries(Object.entries(await settle(integrations)).map(([name, p]) => [name, { ...p, needs: [] }]));
}

/** A row as `--json` prints it: status, needs and access, then the state as the connector's manifest shapes it. */
function rowRecord(name: string, r: Row): Record<string, unknown> {
  const m = manifestOf(name);
  return { status: r.status, needs: r.needs, access: m?.access ?? "", detail: r.detail, anomaly: r.anomaly, ...(m?.record && r.state ? m.record(r as Part) : (r.state as object)) };
}

/** A row's text: "name    status · summary · needs … · detail · odd: …  (access)", then its children indented. */
function rowLines(name: string, r: Row): string[] {
  const m = manifestOf(name);
  const [summary = "", ...children] = r.state === undefined ? [] : (m?.lines(r as Part) ?? []);
  const parts = [r.status, summary, r.needs.length ? `needs ${r.needs.join(", ")}` : "", r.detail ?? "", r.anomaly ? `odd: ${r.anomaly}` : ""];
  return [`${name.padEnd(9)}${parts.filter(Boolean).join(" · ")}  (${m?.access ?? ""})`, ...children.map((line) => `  ${line}`)];
}

/** `home status`: every connector, with the energy now on top. With `only` (`home <connector>`), that connector alone. */
export async function status(o: Options, only?: string): Promise<void> {
  const path = configPathOf(o);
  const manifests = only === undefined ? MANIFESTS : [manifestOf(only)!];
  const rows = path ? await statusFromConfig(path, only) : await statusFromEnv(manifests);
  if (only !== undefined) {
    const row = rows[only]!;
    return o.json ? printJson(rowRecord(only, row)) : console.log(rowLines(only, row).join("\n"));
  }
  const connected = (name: string) => (rows[name]?.status === "connected" ? (rows[name]!.state as never) : undefined);
  const now = energyNow(connected("enphase"), connected("amber"));
  if (o.json) return printJson({ now, ...Object.fromEntries(Object.entries(rows).map(([name, r]) => [name, rowRecord(name, r)])) });
  if (now.gridW !== undefined) console.log(`now      solar ${kw(now.solarW)} · using ${kw(now.usingW)} · ${gridText(now)}`);
  for (const [name, r] of Object.entries(rows)) console.log(rowLines(name, r).join("\n"));
}
