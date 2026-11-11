# The home config

One JSONC file lays out the home, so the `home` command, jaldi and chota-bot read the same thing: where the home is, the weather sources, the rooms (matching the drawing), and each device by connector. [`examples/home.jsonc`](../examples/home.jsonc) is an invented one; [`home.schema.json`](../home.schema.json) gives an editor completion (`"$schema"`).

```ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createHome, loadHome, parseJsonc } from "@khalido/home";
import { serveClip } from "@khalido/home/cast/serve";
import { tlsConnect } from "@khalido/home/cast/tls";
import { FINDERS, fileCache } from "@khalido/home/finders";
import { ftpFetch } from "@khalido/home/weather/ftp";

const path = "/path/to/home.jsonc";
const cachePath = "/path/to/addresses.json";
const readFile = (p: string) =>
  readFileSync(
    resolve(dirname(path), p.replace(/^~(?=\/)/, homedir())),
    "utf8",
  ); // relative to the config, or from ~/
const home = createHome(
  loadHome(parseJsonc(readFileSync(path, "utf8")), {
    env: process.env,
    readFile,
    ftpFetch: ftpFetch(), // BOM's weather
    finders: FINDERS, // finds Cast devices, and any device that moves
    castConnect: tlsConnect, // Cast's socket; a config with Cast is refused without it
    castServe: serveClip, // only to announce a clip from bytes, not a URL
    cache: fileCache(cachePath), // addresses kept between runs
  }),
);
```

Only `env` is always needed: `readFile` for a config that names a file, `ftpFetch` for BOM, `finders` and `castConnect` for Cast. `loadHome` runs on Bun and Node. Hue and Enphase need a fetch that handles their certificates: Bun's `tls` fetch option by default, and under Node `tls: NODE_TLS` from `@khalido/home/node`. Under Node, a config with Hue or Enphase and no `tls` is a problem `loadHome` names, not a silent failure at the first read.

- **A device entry is only how to reach it and where it is**: its identity (the Hue `bridgeId`, a Daikin's `mac`, the Enphase `serial`, a Cast `castId`), its last known `host`, a key's env name, a file's path, its `room`. What a device reports about itself (model, firmware) comes live; a note about it is a comment.
- **Secrets are env variable names** (`"key": "AMBER_KEY"`), resolved against the `env` the caller passes; a pasted key fails the schema. Files (`ca`, `token`) are paths the caller reads, relative to the config or from `~/`, which the caller expands (`home discover --write` writes Enphase's token as `~/.config/home/enphase-token.json`); the library reads nothing.
- **Problems name the field**: an unknown connector, a missing env name or a device in a missing room is an error, never a skip. `checkHome` returns them all; `loadHome` throws them all. Unknown keys pass through for a consumer's own settings.
- **One device per connector** for now (each integration is named by its connector), except printers (one entry each, by `uuid`) and Cast: one entry per device and speaker group (`name`, the Google Home name, and `castId`, the mDNS id), all read by one `cast` integration that finds every address by discovery, since a group's moves with its leader. A `spotify` entry is only its Soloist `url` (and `maxVolume`): a socket on the same machine, with nothing to discover.
- **Identity, not address.** A device is recognised by the id its own discovery reports; `host` is a cache. `home discover` lists what answers (mDNS, Daikin's UDP broadcast), in two passes 5 s apart since both drop answers now and then: the first pass prints at once, the second only what it adds (`--passes 1` for a quick look; `--json` waits for both); with a config (`--config` or `HOME_CONFIG`) it then matches those against it by identity and prints new devices, moved addresses and conflicts (a different device at an entry's host). `home discover --write <file>` adds the new ones (each with an id no entry has), updates moved hosts and refreshes the `name` of a Cast entry renamed in the Google Home app through `jsonc-parser`'s edits, every comment and other line left as it was, and writes only a result that passes `checkPlan`. Nothing else writes the file; the library never does. Two devices with one id are a config problem.
- **A device that moves is found again, without periodic scans**, when the caller passes `finders` to `loadHome` (`FINDERS` from `@khalido/home/finders`, Node-side like `weather/ftp`; the CLI does, and jaldi and chota-bot can). After three failed reads in a row (Hue: three failed reconnects of its event stream), Hue, Daikin and Enphase run their discovery (two passes, the second skipped when the first finds the device), switch to the address their identity now answers at and say "moved from a to b" in `detail` (persist it with `home discover --write`); otherwise they look again at 1, 5 and 15 minutes, then hourly for as long as reads fail, so a device back from the wall socket reads again without a restart. The detail says what discovery found ("not found by discovery", or "discovery finds it at its address but reads fail", or "discovery failed: …" when it could not run), and "no answer for a day" once a day has passed; the part stays `disconnected`, since `unavailable` is for a rejected key. `refresh()` resets the wait. Amber and the weather have no discovery and do not take part. Cast always needs `finders.cast`: discovery is how it finds every address.
- **Discovery is rare: addresses are cached between runs.** `loadHome(config, { cache, configAt })` takes an `AddressCache` (`read()` and `write(entries)`, keyed by connector and identity, each entry `{ host, port?, name?, seenAt }`). A cached address newer than the config (`configAt`, the file's modified time) is tried first, a failure there scans at once rather than after three, and each address that answers is written back when it changed or predates the config, so a config edit is re-trusted at the first good read. Nothing evicts an entry but `home cache clear`: a device gone for good keeps its entry, and `home status` without a config, which reads every Cast entry from the cache, shows it as not found until then. The consumer persists it: the CLI keeps `$XDG_CACHE_HOME/home/addresses.json` (default `~/.cache/home/addresses.json`, 0600) through `fileCache` from `@khalido/home/finders`, written at the end of `status`, `probe` and `discover`; another consumer passes `FINDERS` and its own cache the same way. The config's `host` stays the human-set fallback and `home discover --write` the way to change the config. `home status` from a Cast config: 0.33–0.44 s cold, 0.13 s with a warm cache, 1.4 s once when a cached address has gone stale (Bun 1.4.2, measured 2026-10-13).
- **Parsing** is through `jsonc-parser` (comments and trailing commas), on Bun and Node alike; a syntax error throws. `bun run schema` rewrites `home.schema.json` from the zod schema, and a test fails if they drift.
- `createHome` stays for code-first use.

## Drawing the home

The library doesn't draw. [`skills/draw-home/SKILL.md`](../skills/draw-home/SKILL.md) guides a coding agent from photos or a floor plan to a themeable `home.svg` with one marker per room, and writes the rooms into the home config below. Start from [`examples/`](../examples/); `checkPlan` validates the rooms.
