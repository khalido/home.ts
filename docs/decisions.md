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
- **Two words, two meanings.** A _connector_ is the folder, its factory and the `connector:` field in the config. An _integration_ is the running object a factory returns (`Integration` in `home.ts`).
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
- **A typed snapshot.** Each factory returns `Integration<State, "name">`, so `createHome` maps names to states: `home.part("weather")?.state` is a `WeatherState`, and a name the home lacks does not compile. `loadHome` returns `HomeIntegration[]`, the union of every connector, so the same holds for a home built from a config. The CLI stays untyped by name. Types only: nothing changes at runtime.
- **Discovery on Linux asks avahi.** On a Pi (Raspberry Pi OS, Debian trixie) the mDNS finders spawn `avahi-browse --parsable --terminate --resolve`, as they spawn `dns-sd` on macOS: the system daemon keeps the mDNS cache, so nothing binds UDP 5353 beside it and a slow device does not slow a scan. It needs `apt install avahi-utils` (avahi-daemon runs by default); without it discovery says so. Tried and dropped: `bonjour-service` (pure JS), which misread empty TXT values and, with no system cache, saw the Enphase gateway only after 4 s (2026-10-16); `multicast-dns` alone is stale. D-Bus to avahi would bind no port either but adds dependencies for the same answer. Checked in Debian trixie containers (avahi-utils, Bun 1.3.4, 2026-10-16): about 1 s per service type, the types in parallel. Not yet on the Pi itself.

# 2026-10-19

- **Writes coalesce; a runaway slows down, never gets refused.** Every device write goes through a write lane (`src/lane.ts`): one send at a time, spaced by the device's gap, coalesced per slot (a light, the AC, a speaker's volume). A newer write to a slot whose write is still waiting merges into it, field by field: the middle drops, the last value lands. A burst of ten sends the first at once and the last after the gap. A loop slower than the gap still gets every write through, so an effect built from writes keeps its rate. A slot over its per-minute rate waits for its turn rather than failing, so a person's last change always arrives. A merged write resolves with the send that carried it. Rates are guesses until a device shows otherwise: Hue as before (lights 100 ms apart, groups and scenes 1 s, no cap: the gap is the protection), Daikin 1 s apart and 20 a minute (the BRP084 publishes nothing; the compressor protects itself), Cast level and mute each 30 a minute per device, a lane per device. Not coalesced: Cast announcements and prints, since each is different content. For prints (chota's, not this library's): queue in order and never drop one; past a count an hour, say so rather than refuse. Reporting a slowed slot in the part's `anomaly` comes with writes that return the resulting state. Weighed: a budget that refuses writes past a count (Home Assistant's Digital Alchemy guards runaway service calls that way), dropped because a refused AC change or a refused print is worse than a slow one.

# 2026-10-28

- **Before 0.1.0, Hue's `ip` is `host`**, like every other connector. A breaking rename, done while nothing imports the package.
- **Node gets its own fetches: `@khalido/home/node`.** Node's `fetch` takes no CA, so Hue's pinned fetch and Enphase's unverified one use undici's `fetch` and `Agent`. `loadHome` takes them as `tls` (`NODE_TLS`); Bun's stay the default. undici is a dependency, not an optional peer: chota-bot on Node gets it with one install, at the cost of about 2.5 MB in a Bun install that never loads it.
- **`settle` is in the library**: run integrations until each has answered, then stop. The CLI and chota-bot's one-shot reads share it.
- **Amber reads its forecast; `bestWindow` picks the hours to run something.** The same 60 s call asks for `next=96`, so the forecast costs no extra calls. `bestWindow` (cheapest by price or greenest by renewables) lives beside `energyNow` as the one owner, so chota-bot's brief and jaldi say the same thing.
- **Health is judged from times `createHome` stamps.** Each part carries `lastGoodAt` (its last connected report) and `downSince` (when it stopped being connected, or started, if it never was). An integration sets neither, except that a connected report repeating an older read passes that read's time as `lastGoodAt` (weather's 5-minute sun tick, Hue's failed refresh), so a re-report never counts as a read. `health(snapshot, now)` says ok, stale or down per integration with its thresholds: a polling connector is stale after 2½ polls with no good read (two missed, and half of one so a read that times out does not flap it) and down after 3 polls not connected; a push one (Hue, Cast) is never stale and is down after 2 minutes not connected; `unavailable` is down at once. `onChange` gets the change as a second argument, `{ name, before, after }`, typed by name. chota-bot asked for both, for its admin page and its job alerts. Weather is `connected` only while some source's latest read brought something new; a read that returns only its last good slices is a failed read, `disconnected` with the data kept, as for every other connector.
- **The parts of the day are a consumer's choice.** `dayBlocks` and `weather()` take `blocks`, so chota-bot's Morning, Noon, Evening and Night come from the library; KO's three stay the default. A block's name is any string, and each block carries its highest UV index.
- **Writes hang off the integration.** Hue and Daikin expose `client`, Cast its actions; `home.integration(name)` hands one back, typed, so an app built from `loadHome` reaches the writes without keeping the array. Each client lives as long as its integration and reads the device's address at each send, so a move keeps the write lane and its waiting writes. A second `daikinClient` for writes is no longer needed.
- **A Daikin 404 is a failed read, not `unavailable`.** Another device may have taken the AC's address; discovery now looks for it. `unavailable` stays for a rejected key.
- **A move is reported by the read at the new address.** Daikin, Enphase and Hue no longer send a `disconnected` "moved" report before reading there, so a one-shot read (`settle`, `home status`) waits for that read, and the address book keeps the new address. If that read fails too, its failure is the detail and the move shows only once a read succeeds.
- **Under Node, `loadHome` names a missing `tls`** for Hue and Enphase, rather than defaulting to Bun's fetch and failing at the first read. Error details carry the cause (`fetch failed: connect ECONNREFUSED …`), which is where Node puts the reason.

# 2026-11-08

- **A `spotify` connector over Spotify Soloist**, for chota-bot first: Spotify's own headless Connect client, so the box is a speaker in every phone's Spotify app, and its local WebSocket gives state and control. Not go-librespot (reverse-engineered) and not the Web API (a cloud account, five users in development mode). Ported from chota-bot's client onto the connector shape: the repo's `Clock` for every timer, every field optional, zod per frame, writes through `writeLane`. `local_push`, one per home, no key (Soloist's key is the daemon's).
- **Signed out is `connected`, not `unavailable`.** The socket is up and Soloist is answering; `unavailable` means stopped for good, and a restart of Soloist with a good key fixes it. `loggedIn: false` and the `detail` say it, and writes are refused unsent. A live Soloist (2026-11-08) is signed out as its normal state until a phone picks it, which confirms `connected` rather than a fault; the detail names waiting for a phone first and a bad key second.
- **`maxVolume` is a write policy**, not a correction of a reading: requests are held to it, and a first play that starts above it (Soloist issue #23) is lowered once, said in `anomaly`. The reported volume stays what Soloist says.
- **No discovery, no `IDENTITY` entry**, a departure from "Adding a connector" steps 4 and 5, and no `probe` entry (step 6): the connector reaches a WebSocket on loopback, so there is no address to find, follow or probe. `url` is the whole of its reach.
- **The default URL is ours, not Soloist's**: `ws://127.0.0.1:9091`, the port chota-bot's unit opens. Soloist has no default; `--ws` turns the API on.
- **The systemd units stay in chota-bot** (and in a local, untracked draft until chota switches), not `examples/`: they carry chota's paths and user, and how to run Soloist is the consumer's business.
- **Spotify writes resolve with what Soloist then reported**, `{ state, confirmed }`, waiting up to 2 s for the event that shows the caller's own change (a write merged into another confirms only if its own change shows); unconfirmed is a result, not an error. The first connector to do Next item 2; Hue and Daikin follow the same shape when they get it. chota-bot asked, so the bot says "volume's at 40" only when Soloist said 40.
- **`duck` and `interrupt` leave a person's change alone.** If someone resumed, skipped or set the volume from a phone while `fn` ran, the music stays as they left it, and the result says so: `music` is `untouched`, `restored`, `kept` or `failed` (Gemini's point: one `restored: false` hid four outcomes a bot answers differently). One aside at a time. `duck` restores the earlier volume even above `maxVolume`: the cap holds requests, and the earlier volume was the person's.
- **Before 0.1.0, not after**, since these change the writes' return types.
- **Spotify's change events, agreed with chota-bot (8 Nov):** `spotifyChanges(before, after)` is a pure helper on two Parts, not part of `onChange`; a second connector that wants events gets its own until three share a shape. `resumed` stays apart from `started`; no volume or queue events; nothing on the first report, so a restart announces nothing; a start comes before its track. Playback events while the library's own `duck` or `interrupt` runs are marked `own` (through `state.aside`) rather than dropped, so a consumer can still see them; connection and sign-in events never are. The connector reports nothing while connecting, so a reconnect goes straight from `disconnected` to `connected` and no change hides in between.
- **Signed out reads as waiting**, everywhere: `speakerState` says `waiting`, the detail says "waiting for someone to pick it", the write error's code is `waiting`.
- **Stalls (Soloist issue #5) are noticed by default and repaired only when asked** (`repairStalls: true`): the repair is the library's first write nobody asked for, so a consumer opts in. Two signals, since the issue doesn't say whether the reported position freezes: a frozen position across fresh reports, and still playing well past the track's end, the symptom actually reported. One repair per track, never a loop. The nudges (seek, then pause and play; a skip past the end) are guesses until a stall is seen live.
- **The project is home.ts; the npm package stays `@khalido/home`** (KO, 2026-11-08), so imports stay short (`@khalido/home/spotify`). It is home automation for TypeScript, starting with the devices in KO's house, and is meant to grow into more of the basics.
- **Spotify: inactive is refused, and activating is the caller's choice** (KO, 2026-11-09). Soloist accepts and drops `set_volume` while it isn't the active device. `setVolume` refuses with code `inactive`, and `activate()` is separate, because activating makes a new stream and can jump the volume to the level last saved. `duck` runs `fn` anyway, with `music: "untouched"`, because the announcement matters more. `play` goes active itself, since someone asking for music wants it to start; `resume` doesn't, since it worked inactive. The `maxVolume` cap says "lowered" only once Soloist reports it.

- **`Part.reason`, only on `unavailable`** (KO, 2026-11-09). An admin page had to match `detail` text like "pair again" to know a person must re-key. `reason` is `auth` (a key or token rejected or unusable), `config` (a setting or file is wrong) or `crashed` (a `run` threw), for code to switch on; `detail` stays the text for people. `disconnected` gets none: it already says unreachable. Additive, so a patch. `config` came a day later (KO, 2026-11-10), so "re-key", "fix a setting" and "report a bug" are three answers; `crashed` stays though nothing reads it yet. Weather has one too: each source says why it stopped (`stopReason`), the part is `auth` if any stopped source is, else `config`, and `state.sources.<name>.reason` shows a dead key while another source keeps the part `connected`.
- **Google's key goes in the `X-Goog-Api-Key` header, not the URL** (KO, 2026-11-10), so nothing that prints a URL can print it. Its rejection is read from the error body: a bad key and a bad latitude are both HTTP 400, and only the key's carries `API_KEY_INVALID` (live, 2026-11-10).
- **Every device answers the same few questions** (KO, 2026-11-10: "nice and consistent so we can easily and consistently add devices"). `DeviceRecord` is identity, availability, one word of state and one line of text, the same for a light, a speaker and a printer; `homeDevices(snapshot, config?)` lists them all. Everything particular to a kind stays in the connector's own typed row, carried as `detail`, so the common record never grows a field only one kind has. Three levels, each inside the last: the house list, the connector's typed row, the raw snapshot. Each connector exports its own typed function, listed by hand in `src/devices.ts`, and not a manifest field: `MANIFESTS` is untyped, and `detail` must narrow by `connector`. The list is read-only: a write means something different for a light, a speaker and an air conditioner, so there is no generic `turnOn`. Not done, for a 0.2.0: Hue's `reachable` becoming `available`, and its groups joining its lights in one call.

# 2026-11-11

- **Signify's two root certificates ship in the package** (KO, 2026-11-11). Signify's own page tells apps to bundle both and validate against them, and openHAB, Homebridge's tools, openhue-go and Raycast do. `ca` stays as an override. No trust-on-first-use and no way to turn validation off: self-signed bridges were updated in May 2025, and Home Assistant's `ssl=False` is what this avoids. `docs/hue.md` has the detail.
- **`pairWhenPressed` polls for 30 s; `pair` stays one request.** A consumer pairing from a chat wants "press the button" and then a key, not its own retry loop. 2 s between asks is this library's choice (openHAB uses 0.5 s, openhue-cli 1 s, Homebridge 15 s).
- **Hue discovery stays mDNS only.** Signify's cloud endpoint (`discovery.meethue.com`) would also find a bridge, but nothing here calls a cloud to reach a local device.
- **The Daikin's default setpoints live in the library: cool 25, heat 27** (KO, 2026-11-11: "I like having opinionated defaults"). `mode("cool")` always sets one, since the unit keeps a setpoint per mode and would otherwise give whatever the remote last left; `power(true)` is the way to get it "as it was". A caller that wants another number passes it.
- **Daikin's `power` and `mode` resolve with `{ state, confirmed }`**, as spotify's writes do: the unit is read until it shows what was asked, so a bot can tell "done" from "sent".
- **Hue's writes are by name, on the client, and read before they write** (KO, 2026-11-11, after chota asked for what the CLI had). `light`, `room` and `scene` resolve a name against a fresh read, check the change against that light's own gamut and kelvin range, send only what was asked, and resolve `{ state, confirmed }` as the Daikin's do. A read costs about 0.3 s (289 ms for 177 resources, Bun 1.4.4, 2026-11-11); it buys a miss that lists what exists and no table of bulb models. A colour off the gamut moves to the nearest the light can show, as Signify's page says to; a kelvin off the range throws, since there is no "nearest" a person would expect.
- **Spotify playing on another device reads as `elsewhere`, not `playing`** (KO, 2026-11-11; chota raised it three times). Soloist reports the account's playback, not the box's, so `playing` while inactive is a silent speaker. `speakerState`, `spotifyText` and `spotifyChanges` all go through one test, `playingElsewhere`. Paused while inactive is left as Soloist says: nothing live shows whose pause it is. Soloist never names the other device, so where is a join with Cast by track name (`spotifyElsewhere`), passed to `spotifyText(state, on)` by `homeDevices`, which sees both parts; the speaker's own part can't know it, so `home status` says "another Spotify device".
- **`home.add` replaces by name and starts the part over** (KO, 2026-11-11; chota pairs Hue from a chat). The old run ends before the new one starts, so a device never has two streams; the new part is a bare `connecting`, since the old state belonged to another key or address. No type widening: a `loadHome` home is already typed for every connector, so `add` takes the home's own integration type. `remove` fires no `onChange`: a change needs an `after`.
- **Dry run is an option on each write, not a separate client** (KO, 2026-11-12; chota asked, since KO's rule is no device write without his OK at the time). It runs the read and every check a real write runs, so a wrong name or an unreachable light fails the same way, and returns the request instead of sending it, in the same `{ state, confirmed }` shape with `wouldSend` added. Hue and Daikin first, chota's lights and aircon tools; Cast and Spotify when a tool needs them.
