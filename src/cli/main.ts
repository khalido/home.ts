#!/usr/bin/env bun
// `home`: the terminal layer. Commands come from cac; one `home <connector>` per manifest, its verbs from src/cli/<connector>.ts.
import { cac } from "cac";
import { ConnectorError, errorText } from "../connector.ts";
import { MANIFESTS } from "../manifests.ts";
import { cacheCommand } from "./cache.ts";
import { CAST_OPTIONS, CAST_USAGE, castVerbs } from "./cast.ts";
import { configCommand } from "./config.ts";
import {
  addresses,
  CliError,
  type ErrorCode,
  type Options,
  usage,
  type Verbs,
} from "./context.ts";
import { DAIKIN_USAGE, daikinVerbs } from "./daikin.ts";
import { discover } from "./discover.ts";
import { enphaseVerbs } from "./enphase.ts";
import { CHANGE_USAGE, hueVerbs } from "./hue.ts";
import { locate } from "./locate.ts";
import { probe } from "./probe.ts";
import { SPOTIFY_USAGE, spotifyVerbs } from "./spotify.ts";
import { devices, status } from "./status.ts";
import { UP_OPTIONS, UP_USAGE, upVerbs } from "./up.ts";

const HUE_HELP: Record<string, string> = {
  lights: "lights off: one write to the whole-home group",
  light: `light <name> ${CHANGE_USAGE}`,
  room: `room <name> ${CHANGE_USAGE}: every light in a room or zone, one write`,
  scene: "scene <name> [in <room>]",
  pair: "pair: waits 60 s for the bridge's button, counting down; prints the env lines to set",
};

/** Each connector's verbs beyond its status, the usage a wrong one prints, and any options of its own. */
/** Only where a write reads it: on any other command cac refuses it, so `--dry-run` never lets a real write through. */
const DRY_RUN: [string, string] = [
  "--dry-run",
  "check the write and print what would be sent; send nothing",
];

const VERBS: Record<
  string,
  {
    verbs: Verbs;
    usage: string;
    options?: [string, string, { type: unknown[] }?][];
  }
> = {
  hue: {
    verbs: hueVerbs,
    options: [DRY_RUN],
    usage: `usage: home hue ${Object.values(HUE_HELP)
      .map((h) => h.split(":")[0])
      .join(" | ")}`,
  },
  daikin: { verbs: daikinVerbs, usage: DAIKIN_USAGE, options: [DRY_RUN] },
  enphase: { verbs: enphaseVerbs, usage: "usage: home enphase login" },
  cast: { verbs: castVerbs, usage: CAST_USAGE, options: CAST_OPTIONS },
  up: { verbs: upVerbs, usage: UP_USAGE, options: UP_OPTIONS },
  spotify: { verbs: spotifyVerbs, usage: SPOTIFY_USAGE },
};

const cli = cac("home");
cli.option("--json", "print JSON");
cli.option(
  "--config <path>",
  "a home config (JSONC); else HOME_CONFIG, else the env names in .env.example",
);

const statusCommand = cli
  .command(
    "status",
    "each integration: connected or not, which env names it still needs (the default)",
  )
  .alias("doctor")
  .alias("!") // cac's marker for the default command: `home` alone runs status
  .action((o: Options) => status(o));
cli
  .command(
    "devices",
    "every device the connectors read, one line each: its state, its room, and why when it isn't available",
  )
  .action((o: Options) => devices(o));
cli
  .command(
    "discover",
    "which smart-home devices answer here (mDNS + Daikin UDP); with a config, how they match it",
  )
  .option("--passes <n>", "discovery passes, 5 s apart (default 2)")
  .option(
    "--write [path]",
    "match what answers by identity: add new devices, update moved hosts and renamed Cast names in the config",
  )
  .action((o: Options) => discover(o));
cli
  .command(
    "probe",
    "read-only, no keys: Hue's public config, Daikin, the IQ Gateway's /info, each Cast device, each printer, each weather source",
  )
  .action((o: Options) => probe(o));
cli
  .command(
    "config [verb] [path]",
    "config check [path]: what a home config would set up, secrets as set or unset, every problem",
  )
  .action(configCommand);
cli
  .command(
    "cache [verb]",
    "the addresses kept between runs; `cache clear` deletes them",
  )
  .action(cacheCommand);
cli
  .command(
    "locate [...address]",
    "latitude and longitude of a street address from OpenStreetMap's Nominatim",
  )
  .option(
    "--write [path]",
    "set them in the config's location (and timezone, when absent)",
  )
  .action(locate);

for (const m of MANIFESTS) {
  const v = VERBS[m.name];
  const c = cli.command(
    `${m.name} [verb] [...args]`,
    `${m.title}: its status${v ? `; ${Object.keys(v.verbs).join(", ")}` : ""}`,
  );
  for (const [raw, what, config] of v?.options ?? [])
    c.option(raw, what, config);
  c.action((verb: string | undefined, args: string[], o: Options) =>
    verb === undefined
      ? status(o, m.name)
      : (v && Object.hasOwn(v.verbs, verb)
          ? v.verbs[verb]!
          : () => usage(v?.usage ?? `usage: home ${m.name}`))(args, o),
  );
}
// Hue's verbs also stand alone, as typed before the CLI had `home hue`: `home lights off`, `home room …`, `home scene …`, `home pair`.
for (const [verb, run] of Object.entries(hueVerbs)) {
  const c = cli.command(`${verb} [...args]`, `Hue: ${HUE_HELP[verb]}`);
  if (verb !== "pair") c.option(...DRY_RUN);
  c.action((args: string[], o: Options) => run(args, o));
}

cli.help();

/** An error as `home` reports it: what went wrong, a coarse code, and the command that fixes it when there is one. */
function describe(e: unknown): {
  error: string;
  code: ErrorCode;
  fix?: string;
} {
  const error = errorText(e);
  if (e instanceof CliError) return { error, code: e.code, fix: e.fix };
  if (e instanceof Error && e.name === "CACError")
    return { error, code: "usage" }; // cac: a missing argument or an unknown option
  if (e instanceof ConnectorError && (e.status === 401 || e.status === 403))
    return { error, code: "auth" };
  // A timeout, or a socket error Bun and Node tag with a code (ECONNREFUSED, ENOTFOUND). A bare TypeError is more likely a bug.
  const socket =
    typeof (e as { code?: unknown })?.code === "string" &&
    /^E[A-Z]+$/.test((e as { code: string }).code);
  if (
    e instanceof Error &&
    (e.name === "TimeoutError" || e.name === "AbortError" || socket)
  )
    return {
      // macOS answers "no route to host" for a LAN address when the terminal app lacks the Local Network permission.
      error:
        (e as { code?: string }).code === "EHOSTUNREACH" &&
        process.platform === "darwin"
          ? `${error} If the device is up, allow this terminal under System Settings > Privacy & Security > Local Network.`
          : error,
      code: "network",
    };
  return { error, code: "error" };
}

let failed: unknown;
try {
  cli.parse(process.argv, { run: false });
  if (cli.matchedCommand === statusCommand && cli.args.length)
    usage(`unknown command "${cli.args[0]}"; \`home --help\` lists them`);
  else await cli.runMatchedCommand();
} catch (e) {
  failed = e ?? "failed";
} finally {
  // Addresses discovery confirmed are kept whether the command succeeded or not; a cache that cannot be written is a warning, not a failure.
  try {
    addresses.flush();
  } catch (e) {
    console.error(`home: address cache not written: ${errorText(e)}`);
  }
}
// stdout is data, stderr everything else: under --json an error is one JSON object on stderr. Exit 2 for usage, 1 for the rest.
if (failed !== undefined) {
  const r = describe(failed);
  console.error(
    process.argv.includes("--json")
      ? JSON.stringify(r)
      : `home: ${r.error}${r.fix ? ` (run \`${r.fix}\`)` : ""}`,
  );
  process.exit(r.code === "usage" ? 2 : 1);
}
