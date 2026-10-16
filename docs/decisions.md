# Decisions

KO's decisions on this package, newest block last. They override every other doc where they conflict. Add to the end as decisions are made; repoint links when a file moves, never rewrite the text. Until 2026-10-14 the record lived in jaldi's `docs/home-control.md`; this is the package's part of it, with addresses and device names left out.

# 2026-10-13

## What this is

- **Our own library, not an existing one.** `node-hue-api` is not CLIP v2, `Hue-Sync` has no event stream and pairs over plain HTTP, `openhue-cli` is a process per call that cannot hold a stream, and Home Assistant is a server to run. A typed `fetch` client pins, keeps alive and streams in Bun and Node.
- **Runtime-neutral, keys passed in.** `fetch`, Web Streams and zod only. Callers pass address, key and a pinned `fetch`. The library never reads the environment or a file and never writes a key; the `home` CLI is the only layer that reads a shell.
- **The snapshot is the cache.** Every read comes from memory. A slow read happens on the integration's own timer, never on a caller's read. The last good state survives a failed poll with its `asOf`.
- **Every field optional, nothing corrected.** An odd reading passes through with an `anomaly`; the Enphase daily counters equalling lifetime is the first case, and "today" is counted locally while they are equal.
- **Home Assistant is the reference.** Its integration source is where the protocol facts live; each connector states its `iot_class` and uses its poll interval. Its quality scale is the checklist. GPL sources (pydaikin, ha-daikin-alira) are read for facts only.
- **One folder per device**, each with a README of official docs, sources with licences and live findings.
- **Away from home is out of scope.** Off the LAN the local connectors say so. Amber and the weather are cloud services and are polled as such.

## Hue

- **Pin the CA, never bypass.** Trust Signify's root CA and check the certificate's CN equals the bridge id. `rejectUnauthorized: false` would hand the key to any device at the bridge's address.
- **The event stream through `fetch`, not `EventSource`**: the WHATWG constructor takes no headers, and the key is a header.
- **Writes spaced to Signify's limits**: grouped lights and scenes 1 s apart, lights 100 ms apart. "Lights off" is one PUT to the home group.
- **A 90 s idle watchdog** reconnects a silent stream without a `disconnected` or a backoff step, and the bridge is found again by its id (see Discovery). Whether the bridge sends keep-alives on a quiet night is unchecked until it is paired.

## Daikin

- **The local `dsiot` API, not BRP069** (its paths 404 on the unit). Reads every 120 s, Home Assistant's interval.
- **The first write happens with KO at the unit**, then a re-read: the two sources disagree on setpoint width, POST vs PUT and hex case. Until then writes are built and tested on fixtures only.

## Enphase

- **Local IQ Gateway with an owner token**, minted once a year by `home enphase login` into `~/.config/home/`, 0600; the password goes only to Enphase's login service. The cloud v4 API was not chosen (OAuth, 10 requests a minute on the free plan, site-level data only).
- **The fast meter endpoints** (`/ivp/meters/readings`, about 100 ms) over `/production.json` (1 to 10 s).
- **Verification skipped for the gateway only**: its chain ends in an unpublished Enphase root.

## Amber and energy

- **Amber's own descriptor and spike status**, no threshold of ours; `negativePrice` and `estimate` as information.
- **`energyNow` is the one owner** of solar, use, grid flow, surplus and cost per hour; every consumer calls it. A 20 W display dead band for "balanced"; `gridW` itself is untouched.
- **SmartShift and any automatic curtailment rejected**: a write nobody asked for.

## Weather

- **BOM over anonymous FTP**: its app API forbids use. **Open-Meteo by default** for sky and as the fallback, BOM's précis opt-in by location, **Google Weather last**, keyed, with a 30-minute floor since it bills.
- **One 15-minute cadence** at :05, :20, :35, :50, with per-source floors; forecasts and the hourly sky read hourly.
- **`sunNow` is computed locally** and owns the sun's booleans and next events; Google's sun times are only a check, and a difference over 2 minutes is an anomaly on Google's side.
- **Odd timestamps are flagged, not thrown.**

## Refresh

- **Every integration can be told to read now**: `home.refresh(name?)`. One shared poller (`poll.ts`) replaces each connector's own timer. A billed source's floor holds on refresh; Hue's refresh is one full GET and keeps its events.

## The home config

- **One JSONC file** (`home.jsonc`): location, weather sources, rooms matching the drawing, devices by connector. `checkHome` returns every problem; `loadHome` throws them all. Unknown keys pass through.
- **A device entry is only how to reach it and where it is**: identity, last known `host`, a key's env name, a file's path, its room. What a device reports about itself comes live.
- **Secrets are env variable names**, never values; a pasted key fails the schema. Files are paths relative to the config, read by the caller.
- **One device per connector, except Cast**: one entry per device and group, one `cast` integration.
- **`loadHome` is Bun only for now**: Hue and Enphase use Bun's `tls` fetch option. Per-connector fetches come when a Node consumer does.
- **One meaning for `marker`**: a room's Hue binding is `hueRoom`.

## Discovery and moves

- **Identity, not address.** A device is recognised by the id its own discovery reports (`bridgeId`, `mac`, `serial`, `castId`); `host` is a cache.
- **Two passes, 5 s apart**, since mDNS and the Daikin broadcast drop answers; the second is skipped when the first finds every configured device. `dns-sd` queries end on the answer, not a fixed window.
- **A rescan only after three failed reads**, then at 1, 5 and 15 minutes and hourly. A device is never `unavailable` for being unreachable; `unavailable` is a rejected key. The detail says what discovery found.
- **An address cache between runs**, consumer-owned (`AddressCache { read, write }`); the CLI keeps `~/.cache/home/addresses.json`. A cached address newer than the config is tried first; a failure there scans at once; a confirmed address after a config edit is re-trusted at the first good read. Nothing evicts an entry but `home cache clear`.
- **`home discover --write` is the only thing that edits the config**, through `jsonc-parser`, and only a result that passes `checkPlan`. The library writes no files.

## Cast

- **A small CastV2 client of our own** over `node:tls`: the existing packages are untyped, load a `.proto` at runtime and hardcode `rejectUnauthorized = false`. One socket per device and group, the name on the self-signed certificate checked.
- **Writes are calls on the object, never made by the integration**: `setVolume`, `setMuted`, `stop`, `announce`. `announce` interrupts another app and reports it in `notRestored` rather than refusing.
- **`serveClip` lives in the library** (Node-only subpath) so a bot can announce a generated clip.
- **Not the Local Home SDK** (needs a cloud fulfilment path we do not have). **A Matter bridge only later, in its own package.**

## Drawing

- **The library doesn't draw.** `skills/draw-home` guides an agent from photos or a plan to an SVG and the config's rooms; `checkPlan` validates them. Element ids equal room or device ids, state by `data-state`, the ha-floorplan way.

## Not built, on purpose

- No rules engine: automations belong in the apps, once the numbers have been watched.
- No TUI (OpenTUI brings 52 MB of native binaries).
- No plugin host; a device KO does not own is a device this library does not cover.

# 2026-10-14

- **Connectors live in `src/connectors/<name>/`**, core files at `src/`. Public import paths (`@khalido/home/hue`) are unchanged through `exports`. Done before the count grew.
- **Two words, two meanings.** A *connector* is the folder, its factory and the `connector:` field in the config. An *integration* is the running object a factory returns (`Integration` in `home.ts`).
- **A shared layer for what was byte-identical, nothing more**: one `ConnectorError`, one `TIMEOUT_MS`, `fetchTimeout` merging the run's signal (so a shutdown cancels a read in flight), `getJson` for the JSON connectors, `asOf(clock)`. The weather error is not a device error: Hue keeps its error-envelope parsing and BOM its text fetch on top of `fetchTimeout`, while the JSON weather sources use `getJson`. The poll loop and the relocator block stay per connector until this layer has settled.
- **Docs layout.** `AGENTS.md` is the main file; `CLAUDE.md` only imports it. The README is for a visitor: what, a map, the connectors, install, links. A connector's README is the one file for working in that folder (no per-folder AGENTS.md: six stubs is scaffold). `docs/` holds design, decisions, investigations and the handover. `docs/handover.md` is read first and rewritten clean, never appended.
- **`home discover` says when it is waiting**: a progress line on stderr before each later pass.
- **The repo is `khalido/home.ts` on GitHub**; the package stays `@khalido/home`.
- **The CLI is derived from the library.** `cli.ts` splits into `src/cli/` on [cac](https://github.com/cacjs/cac). Each connector exports a `manifest` (name, title, `iotClass`, poll seconds, access text, env names, file fields, status lines) that drives `home status`, `home <connector>`, `.env.example` and the README's connectors table, so one declaration feeds the library, the CLI and the docs. Connector verbs that need Node (pairing, logins, Cast writes) live in `src/cli/<connector>.ts`.
- **An Up Bank connector is being shaped** (`docs/ideas.md`): read-only by default; whether the category and tag writes ship from the start is open.
- **Amber is for live prices, not cost logging.** The usage endpoint work (last month's cost per channel, a daily cache, `home amber usage`) was built and reverted the same day: Amber's API is there to adjust use to the price, and a bill is the record of cost. The commit survives as `ceaa2ba` if the question comes back.
- **`home.refresh(name?)` returns a promise** resolved by each target's next report, so a one-shot consumer can await a read.
- **Printers are a connector**, read-only first: AirPrint discovery over the existing dns-sd finder (`_ipp._tcp`, `_ipps._tcp`; identity the TXT `UUID`), status over IPP Get-Printer-Attributes with a hand-rolled codec like Cast's, one shared rescan rather than a relocator per printer, an unreachable printer `offline` with its last seen for `offlineDays` (14) before `anomaly`, never `unavailable`. Identify-Printer then Print-Job come later, behind KO's hand.
- **Up Bank's token is `UP_TOKEN`**, in the repo's gitignored `.env` for testing; the connector issues GETs by default and its writes are explicit verbs.

# 2026-10-15

- **Rain soon from Google's minute forecast, two hours.** A `rain` slice on the weather connector, owned by Google alone, kept to 2 hours of 15-minute segments. `rainSoon` is the one function that says when rain starts and ends. Google's floor drops from 30 to 15 minutes; current conditions stay at 30 inside that read. The endpoint is Experimental, so its failure never stops the other slices. The hourly rain chance as a fallback, an `hourly` slice and one condition word come next, not now.
- **Calendar later, Google first.** A calendar connector reads Google Calendar; an ICS source (laggy) can come too. Google is not one connector: Weather and Calendar share a name only, and a shared Google helper comes when a third service needs it. The calendar waits. Design and open calls: `docs/google.md`.

# 2026-10-16

- **Going public: one squashed commit, a private repo first.** `khalido/home.ts` starts private with `main` as one commit under the GitHub noreply address; KO flips it public after a look. The history before it stays local.
- **Every export is named.** No `export *` anywhere: each entry point lists what it offers, and `test/exports.test.ts` fails when that list changes. The root drops `fetchTimeout`, `getJson`, `TIMEOUT_MS`, `MANIFESTS` and `manifestOf` (internals and CLI concerns); connectors drop their codecs, schemas, parsers and event streams. Done before npm, while no one imports it.
- **`weatherNow` is now `mergeWeather`**: it merges source readings into every slice, and the type `WeatherNow` is only the now slice. The old name does not come back with another meaning.
- **Up Bank's token works from the repo's `.env`.** A session whose environment holds an older `UP_TOKEN` wins over `.env` in Bun; unset it for live reads.
- **Up Bank is a connector**, built to `docs/up.md`: reads every 15 minutes, the category and tag writes and the webhook calls only as client methods and `home up` verbs. Accounts are picked by type and ownership (`JOINT TRANSACTIONAL`), never by id. "To categorise" counts spend only: salary and payments received are categorisable too, but are not what needs a category. Webhook secrets go to a 0600 file, never the terminal.
- **What the library covers: the house and what the household shares.** Devices on the LAN, plus what every app in the house wants: prices, weather, transport nearby, a family calendar, the household account. A per-person tool one consumer uses stays in that consumer and moves here when a second consumer wants it, the same rule as the Daikin ramp. So TickTick stays in chota-bot. The rule that a device KO does not own is not covered still holds; the survey in `docs/ideas.md` is a guide for anyone extending it.
- **Up has a household filter**: Up category ids and tags that count as the family's (`home` and `tag:home`, say), so the snapshot a dashboard shows holds shared spending only. Personal purchases stay out of it unless tagged in.
- **Weather by the hour and by part of the day.** An `hourly` slice (today and tomorrow, Open-Meteo's, from the call it already makes once an hour) and `dayBlocks`, the one owner of morning 6–12, afternoon 12–18 and evening 18–22, cut in the home's time zone. One `condition` word per hour, from a fixed list mildest first, so a block takes its worst hour. chota-bot asked for these to replace its own weather code. Weather times show in the home's zone (`location.timezone`, `HOME_TIMEZONE`), not the machine's.
