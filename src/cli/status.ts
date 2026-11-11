// `home status` and `home <connector>`: build each integration (from a config, else from the shell's env names), run
// them until each has answered, and print each through its connector's manifest.
import { existsSync, readFileSync, statSync } from "node:fs";
import { amber } from "../connectors/amber/index.ts";
import { tlsConnect } from "../connectors/cast/tls.ts";
import { daikin } from "../connectors/daikin/index.ts";
import {
  bom,
  google,
  openMeteo,
  weather,
  type WeatherSource,
} from "../connectors/weather/index.ts";
import { ftpFetch } from "../connectors/weather/ftp.ts";
import { HomeConfig, loadHome } from "../config.ts";
import { DEVICES, type HomeDevice, homeDevices } from "../devices.ts";
import { energyNow, gridText } from "../energy.ts";
import { FINDERS } from "../finders.ts";
import { type Integration, type Part, type Status, settle } from "../home.ts";
import { kw, type Manifest } from "../manifest.ts";
import { MANIFESTS, manifestOf } from "../manifests.ts";
import { castNow } from "./cast.ts";
import { daikinHost } from "./daikin.ts";
import { printersNow } from "./printers.ts";
import { spotifyFromEnv } from "./spotify.ts";
import {
  addresses,
  CliError,
  configPathOf,
  env,
  fail,
  fromConfig,
  homeTimeZone,
  type Options,
  printJson,
  readConfig,
  TOKEN_FILE,
} from "./context.ts";
import { enphaseFromEnv } from "./enphase.ts";
import { hueFromEnv } from "./hue.ts";
import { upFromEnv } from "./up.ts";

/** One connector's row: its part, or "not set up" with the env names (and steps) it still needs. */
type Row = Omit<Part, "status"> & {
  status: Status | "not set up";
  needs: string[];
};

/** HOME_LATITUDE and HOME_LONGITUDE as numbers; the manifest's `needs` has already checked they are set. */
export function place(): { latitude: number; longitude: number } {
  const latitude = Number(env.HOME_LATITUDE);
  const longitude = Number(env.HOME_LONGITUDE);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? { latitude, longitude }
    : fail("HOME_LATITUDE and HOME_LONGITUDE must be numbers");
}

/** The weather sources KO's env sets up, in preference order: BOM (opt-in, with the FTP transport), Open-Meteo, then Google if keyed, as the last resort. */
export const weatherSources = (): WeatherSource[] => [
  bom({ fetch: ftpFetch(), forecastLocation: env.HOME_BOM_FORECAST }),
  openMeteo(),
  ...(env.GOOGLE_WEATHER_KEY ? [google({ key: env.GOOGLE_WEATHER_KEY })] : []),
];

/**
 * Each connector from the shell's env names, once the manifest's non-optional names are set. `needs` adds a step that
 * is not an env name (Enphase's token file). Addresses come from the env, except the Daikin's and the Hue bridge's, which
 * are searched for when unset; `home probe` and `home discover` search for the rest.
 */
const FROM_ENV: Record<
  string,
  {
    needs?: () => string[] | Promise<string[]>;
    build: () => Integration<any> | Promise<Integration<any>>;
  }
> = {
  hue: { build: hueFromEnv },
  daikin: {
    // No address set: ask the network. A home with no unit reads "not set up", not as a failure.
    needs: async () =>
      (await daikinHost())
        ? []
        : ["DAIKIN_HOST (no unit answered the UDP broadcast)"],
    build: async () => daikin({ host: (await daikinHost())!, fetch }),
  },
  enphase: {
    needs: () => (existsSync(TOKEN_FILE) ? [] : ["`home enphase login`"]),
    build: enphaseFromEnv,
  },
  amber: {
    build: () =>
      amber({ key: env.AMBER_KEY!, siteId: env.AMBER_SITE_ID, fetch }),
  },
  up: { build: upFromEnv },
  weather: {
    build: () =>
      weather({
        ...place(),
        sources: weatherSources(),
        timeZone: homeTimeZone(),
      }),
  },
  cast: { build: castNow },
  printers: { build: printersNow },
  spotify: { build: spotifyFromEnv },
};

/** The rows for these manifests from the shell: not set up, failed to build, or run until each has answered. */
async function statusFromEnv(
  manifests: Manifest[],
): Promise<Record<string, Row>> {
  const rows: Record<string, Row> = {};
  const built = await Promise.all(
    // in parallel: Hue's build can wait on mDNS
    manifests.map(async (m): Promise<Integration<any>[]> => {
      const from = FROM_ENV[m.name]!;
      const needs = [
        ...m.env.filter((e) => !e.optional && !env[e.name]).map((e) => e.name),
        ...((await from.needs?.()) ?? []),
      ];
      rows[m.name] = {
        status: needs.length ? "not set up" : "connecting",
        needs,
      };
      if (needs.length) return [];
      try {
        return [await from.build()];
      } catch (error) {
        const code = error instanceof CliError ? error.code : undefined;
        const fix =
          error instanceof CliError && error.fix
            ? ` (run \`${error.fix}\`)`
            : "";
        rows[m.name] = {
          status: "unavailable",
          needs,
          // A build reads settings and files, so a failure is config unless it was a key (auth) or the network (nothing to fix here).
          reason:
            code === "auth"
              ? "auth"
              : code === "network"
                ? undefined
                : "config",
          detail: `${(error as Error).message}${fix}`,
        };
        return [];
      }
    }),
  );
  for (const [name, part] of Object.entries(
    (await settle(built.flat())) as Record<string, Part>,
  ))
    rows[name] = { ...part, needs: [] };
  return rows;
}

/** The config with only this connector's devices, and the weather only for `home weather`, so `home amber` doesn't need Up's key. A malformed one passes through for `loadHome` to report. */
function narrowed(input: unknown, only: string): unknown {
  const config = input as { devices?: unknown } | null;
  if (!Array.isArray(config?.devices)) return input;
  const { location, weather, ...rest } = config as Record<string, unknown>;
  return {
    ...rest,
    ...(only === "weather" ? { location, weather } : {}),
    devices: config.devices.filter((d) => d?.connector === only),
  };
}

/** The rows from a config: its integrations (or the one named) run until each has answered (weather: every source), at most 15 s. */
async function statusFromConfig(
  path: string,
  only?: string,
): Promise<Record<string, Row>> {
  const options = {
    env,
    readFile: (p: string) => readFileSync(fromConfig(path, p), "utf8"),
    ftpFetch: ftpFetch(),
    finders: FINDERS,
    castConnect: tlsConnect,
    cache: addresses.cache,
    configAt: statSync(path).mtimeMs,
  };
  const input = readConfig(path);
  const integrations = loadHome(
    only === undefined ? input : narrowed(input, only),
    options,
  );
  if (!integrations.length) fail(`no ${only} in ${path}`);
  return Object.fromEntries(
    Object.entries(await settle(integrations)).map(([name, p]) => [
      name,
      { ...p, needs: [] },
    ]),
  );
}

/** A row as `--json` prints it: status, needs and access, then the state as the connector's manifest shapes it. */
function rowRecord(name: string, r: Row): Record<string, unknown> {
  const m = manifestOf(name);
  return {
    status: r.status,
    needs: r.needs,
    access: m?.access ?? "",
    detail: r.detail,
    reason: r.reason,
    anomaly: r.anomaly,
    ...(m?.record && r.state ? m.record(r as Part) : (r.state as object)),
  };
}

/** A row's text: "name    status · summary · needs … · detail · odd: …  (access)", then its children indented. */
function rowLines(name: string, r: Row): string[] {
  const m = manifestOf(name);
  const [summary = "", ...children] =
    r.state === undefined ? [] : (m?.lines(r as Part) ?? []);
  const parts = [
    r.status,
    summary,
    r.needs.length ? `needs ${r.needs.join(", ")}` : "",
    r.detail ?? "",
    r.anomaly ? `odd: ${r.anomaly}` : "",
  ];
  return [
    `${name.padEnd(9)}${parts.filter(Boolean).join(" · ")}  (${m?.access ?? ""})`,
    ...children.map((line) => `  ${line}`),
  ];
}

/** Every connector's row (or the one named), from the config at `path`, else from the shell's env names. */
const rowsOf = (path: string | undefined, only?: string) =>
  path
    ? statusFromConfig(path, only)
    : statusFromEnv(only === undefined ? MANIFESTS : [manifestOf(only)!]);

/**
 * `home devices`: every device the connectors read, one line each from `homeDevices`, with its room and name from the
 * config when there is one. A connector that isn't connected is named on stderr.
 */
export async function devices(o: Options): Promise<void> {
  const path = configPathOf(o);
  const rows = await rowsOf(path);
  const parts: Record<string, Part> = {};
  for (const [name, r] of Object.entries(rows))
    if (r.status !== "not set up") parts[name] = r as Part;
  // loadHome has already accepted the config, so a parse that fails here is not expected: list without rooms.
  const config = path ? HomeConfig.safeParse(readConfig(path)).data : undefined;
  const list = homeDevices(parts, config);
  // A connector that isn't connected may have no device to list: say so, off stdout.
  for (const [name, r] of Object.entries(rows))
    if (name in DEVICES && r.status !== "connected")
      console.error(
        [
          `${name}: ${r.status}`,
          r.needs.length ? `needs ${r.needs.join(", ")}` : "",
          r.detail ?? "",
        ]
          .filter(Boolean)
          .join(" · "),
      );
  if (o.json) return printJson(list);
  for (const d of list) console.log(deviceLine(d));
}

/** A device's line: "connector  text · in room · not available: reason". */
export const deviceLine = (d: HomeDevice): string =>
  [
    `${d.connector.padEnd(9)}${d.text}`,
    d.room ? `in ${d.room}` : "",
    d.available === false ? `not available: ${d.reason}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

/** `home status`: every connector, with the energy now on top. With `only` (`home <connector>`), that connector alone. */
export async function status(o: Options, only?: string): Promise<void> {
  const rows = await rowsOf(configPathOf(o), only);
  if (only !== undefined) {
    const row = rows[only]!;
    if (row.status !== "connected") process.exitCode = 1; // `home <connector>` is a check a script can test; `home` alone lists every one and exits 0
    return o.json
      ? printJson(rowRecord(only, row))
      : console.log(rowLines(only, row).join("\n"));
  }
  const connected = (name: string) =>
    rows[name]?.status === "connected"
      ? (rows[name]!.state as never)
      : undefined;
  const now = energyNow(connected("enphase"), connected("amber"));
  if (o.json)
    return printJson({
      now,
      ...Object.fromEntries(
        Object.entries(rows).map(([name, r]) => [name, rowRecord(name, r)]),
      ),
    });
  if (now.gridW !== undefined)
    console.log(
      `now      solar ${kw(now.solarW)} · using ${kw(now.usingW)} · ${gridText(now)}`,
    );
  for (const [name, r] of Object.entries(rows))
    console.log(rowLines(name, r).join("\n"));
}
