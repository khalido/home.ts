# @khalido/home

KO's small, opinionated TypeScript library for his home: Hue, Daikin, Enphase, Google Cast, AirPrint printers, Amber prices, Up Bank spending and the weather. Used by jaldi's sidecar (Bun) and chota-bot (Node), plus a `home` CLI. MIT; local git today, going public on GitHub.

**Read [docs/handover.md](docs/handover.md) first**: where the last session left off and what to do next. Keep it current as you work; rewrite it clean before you stop, never append. Then `README.md`, then the README in the connector folder you are changing.

## Layout

```
src/
  home.ts        createHome, Integration, Part, Status: the contract every connector meets
  connector.ts   what connectors share: ConnectorError, TIMEOUT_MS, fetchTimeout, getJson
  manifest.ts    Manifest: what a connector declares about itself (name, iotClass, env, access, status lines)
  manifests.ts   MANIFESTS, the list the CLI, `bun run gen` and loadHome iterate
  config.ts      the home config: zod schema, checkHome, loadHome, checkPlan
  discover.ts    matching by identity, the relocator, the address book, known mDNS services
  poll.ts        poller(clock): wait(ms, signal) and nudge(), behind every polling connector
  lane.ts        writeLane: device writes one at a time, spaced, the waiting writes to one slot merged
  clock.ts       Clock, realClock, asOf(clock); tests pass a fake
  energy.ts      energyNow: the one owner of solar, use, grid flow and cost per hour
  locate.ts      geocoding for `home locate`
  finders.ts     Node-side discovery (macOS dns-sd, Linux avahi-browse, UDP) and fileCache; the only library file that spawns a process
  cli/           the home command on cac, the only code that reads the environment or the filesystem:
                 main.ts (commands from MANIFESTS), context.ts (env, config, cache, finders), status.ts,
                 discover.ts, probe.ts, config.ts, cache.ts, locate.ts, and hue.ts, enphase.ts, cast.ts for verbs that need Node
  connectors/<name>/
    client.ts    pure reads and writes: fetch, address and key in, typed values out
    index.ts     the factory returning an Integration, its configSchema and its manifest
    README.md    the one file for working on this connector (shape below)
test/            fixtures, a fake clock, one file per connector; bench/bench.ts
scripts/         schema.ts (home.schema.json from zod) and gen.ts (.env.example from the manifests); tests fail on drift
docs/            design, decisions, investigations, the handover
skills/draw-home a coding agent draws a home as SVG and writes the config's rooms
skills/use-home  an agent uses `home`: reading safely, connecting, addresses, discovery, the rules for writes
```

**Words.** A *connector* is a folder under `src/connectors/`, its factory, and the `connector:` field in the config. An *integration* is the running object the factory returns (`Integration`): a `name`, `run(signal, update)` and `refresh()`. A *Part* is one integration's slice of the snapshot: `status`, `detail`, `anomaly`, `state`. `unavailable` means stopped for good (a rejected key); unreachable is `disconnected`. A *manifest* is what a connector declares about itself (`Manifest` in `manifest.ts`): the CLI, `.env.example` and `loadHome` read it rather than knowing each connector.

## Rules

- **Runtime-neutral library.** `src/` outside `cli/` uses only `fetch`, Web Streams and the listed dependencies: no Bun or Node APIs. `tsconfig.build.json` has no runtime types and fails if one creeps in. The exceptions are `connectors/weather/ftp.ts` (BOM is FTP only), `connectors/cast/tls.ts` and `connectors/cast/serve.ts` (raw TLS, a clip served on the LAN) and `finders.ts`: each excluded there, type-checked by `tsconfig.node.json`, never imported by library code; callers pass them in.
- **Every field a device reports is optional.** Never clamp, round or correct an odd reading: pass it through and set `anomaly`.
- **Secrets.** The package never stores a key. The CLI reads KO's env names (`.env.example`); only `home enphase login` writes a file (`~/.config/home/enphase-token.json`, 0600). Never print a key, token or password. Never put an IP, MAC, serial or KO's device names in the repo.
- **KO's devices are live.** Reads are fine. **Writes to a device (lights, AC, speakers) only when KO asks.** `home probe` is the read-only check.
- **Licences.** GPL sources (pydaikin, ha-daikin-alira) are read for facts only, never copied.
- **Libraries over hand-rolled code**; ranges in `package.json`, `bun.lock` committed. One shared helper only once the same code sits in three connectors and the helper removes more lines than it adds.
- **Prose.** Plain, KO's voice, no filler. Label every measured number with the Bun version and date.

## Adding a connector

Before writing one, search Home Assistant's [integration list](https://www.home-assistant.io/integrations/) for the device, read its source at `github.com/home-assistant/core/tree/dev/homeassistant/components/<domain>` and the library its `manifest.json` requires: that is where the protocol facts are. Borrow its vocabulary (`iot_class`: `local_push`, `local_polling`, `cloud_polling`), its poll interval, and its [quality scale](https://developers.home-assistant.io/docs/core/integration-quality-scale/) as a checklist. Skip what needs a UI.

1. **Folder** `src/connectors/<name>/` with `client.ts`, `index.ts`, `README.md`. Add `./<name>` to `exports` in `package.json`. `index.ts` names every export (no `export *`): the factory, `configSchema`, `manifest`, the state types, display helpers and the writes a consumer calls; codecs, schemas and parsers stay internal, and tests import them from their own files. Add the entry point's names to `test/exports.test.ts`.
2. **Client.** Reads and writes through `getJson` or `fetchTimeout` from `src/connector.ts`, passing the run's `signal` so a shutdown cancels a read in flight. Throw `ConnectorError` (or a subclass when the connector's name belongs in the message) with the HTTP `status`. Zod schemas with every field optional.
3. **Integration.** `index.ts` exports `name(config): Integration<State, "name">`, so a snapshot is typed by name. A push device holds one stream (Hue, Cast); a poll device loops on `poller(clock)` from `src/poll.ts` at the interval the device's docs or Home Assistant use, with `refresh: poll.nudge`. Keep the last good state through a failed poll, with `asOf(clock)`. A rejected key is a terminal `unavailable`; being unreachable is `disconnected`. A timeout on every request (`TIMEOUT_MS`), backoff on reconnect, and writes through `writeLane` (`src/lane.ts`), spaced to the vendor's limit or a stated guess.
4. **Config.** Export a zod `configSchema` from `index.ts`: a `looseObject` with `connector: z.literal("<name>")` and only what reaches the device: its identity as its own discovery reports it (and that field in `IDENTITY` in `src/discover.ts`), its last known `host`, key env names via `envName`, file paths via `filePath`. Add it to the `Device` union and `HomeIntegration` in `src/config.ts` and a `case` in `loadHome`; run `bun run schema`.
5. **Moves**, for a device found by discovery: take `find` and its identity, wrap the address in `relocator` from `src/discover.ts` (`ok()` after a good read, `failed(signal)` after a bad one, `reset()` in `refresh`), rebuild the client on a move and keep "moved from a to b" in `detail`; a failed read's detail is `lostDetail(r, error)`. Take `seen(host)` and `hostCached`; `loadHome` wires both to its address book. Its finder goes in `FINDERS` in `src/finders.ts`.
6. **Manifest.** Export `manifest: Manifest<State>` from `index.ts`: `name`, `title`, `iotClass`, `pollSeconds`, `access` (what it reaches and with what key), `env` (every name the CLI reads, with its comment; `optional` when `home status` runs without it), `files` (config fields that are paths), `lines(part)` (the status text, first line the summary, then children) and `record(part)` when `--json` needs shaping. Add it to `MANIFESTS` in `src/manifests.ts`; `home status`, `home <name>` and `bun run gen` (which rewrites `.env.example`) follow from it. In `src/cli/`: how the integration is built from env in `FROM_ENV` (`status.ts`), verbs that need Node (pairing, a login, a write) in `src/cli/<name>.ts` and `VERBS` (`main.ts`), addresses for `probe` in `envFromConfig` (`probe.ts`).
7. **README** in the folder, in this shape: one line saying what it reads, its `iot_class` and what is built or untried; **Built**; the protocol; **Unverified**; dated live findings; **Sources** with licences. Investigations that outgrow it go to `docs/<name>-notes.md`. Add the connector's row to the README's table and a block to `docs/decisions.md`.

## Where things are written down

| Where | Holds |
|---|---|
| `README.md` | for a visitor: what this is, the connectors, install, links |
| `AGENTS.md` (this file; `CLAUDE.md` imports it) | rules and how the code is shaped |
| `src/connectors/<name>/README.md` | everything about one connector: protocol, what the live device said, sources |
| `docs/decisions.md` | KO's decisions and why, newest last; overrides other docs where they conflict |
| `docs/philosophy.md`, `docs/using.md`, `docs/config.md`, `docs/cli.md` | why, wiring it in, the config, the command |
| `docs/cast.md`, `docs/google.md`, `docs/up.md`, `docs/matter.md`, `docs/weather-probe.md`, `docs/enphase-notes.md` | the design or investigation behind a connector |
| `docs/ideas.md` | connectors and features considered, with the research, not yet decided |
| `docs/devices.md` | devices worth buying for a home: local, Google Home, AU price, whether this library can read them |
| `docs/handover.md` | where things stand and what is next; disposable, rewritten |

## Drawing a home

`skills/draw-home/SKILL.md` guides an agent from photos or a floor plan to `home.svg` plus the `rooms` and `plan` of the home config (checked by `checkPlan`). The invented example is in `examples/`; a real home's files stay private.

## Checks

`bun run check` (three type-checks, including the runtime-neutral build) and `bun test` must pass before a change ships. Run `/ko-review` before committing a real change. Commit with explicit file paths, in plain prose.
