# Changelog

All notable changes to home.ts (`@khalido/home` on npm), in [Keep a Changelog](https://keepachangelog.com/) form. Versions follow [SemVer](https://semver.org) at 0.x: a minor release can break what a consumer calls, a patch can't. A release that breaks something opens with a **Breaking** heading, so a consumer on `latest` sees it first.

## [Unreleased]

### Breaking

- **spotify: music on another Spotify device no longer reads as this speaker playing.** When Soloist says `playing` while it isn't the account's active device, `speakerState` now gives `elsewhere` (it gave `playing`), `spotifyText` says `silent · "Song" by Band is playing on another Spotify device`, and `spotifyChanges` treats it as silence: the music leaving is `stopped`, arriving is `started` then `track`, and nothing fires for its tracks or pauses meanwhile (it fired `resumed` with the box silent). `home devices --json` carries the new `state`. What to do: add `elsewhere` wherever you switch on `speakerState`; `state.status` is still what Soloist said.
- **cast: `CastSkipped.why` can be `form`**, only when `castFree` is given `forms`. What to do: add it to a switch that lists every `why`.

### Fixed

- **spotify:** the stall watch no longer looks at, or repairs, music playing on another device.

### Changed

- **cli:** `home room <name> <n>` and `home scene` print the room's line after the write, where they printed nothing; a wrong name is a usage error (exit 2), where it was exit 1. `home scene <name>` no longer takes the first match when several rooms have a scene by that name: it lists them, and `home scene <name> in <room>` picks one.
- **hue:** a light's line shows its white temperature or colour when on (`Desk: on · 40% · 2700 K`), in `home hue`, `home devices` and `homeDevices`.
- **docs, for a consumer:** `docs/using.md` has each write and what it resolves with in one table, an announce-where-free example, and what a part's `status` and `reason` and an error's `code` mean. `docs/config.md`'s `loadHome` call now passes what Cast needs (`finders`, `castConnect`). `llms.txt` says what to call.
- **`MissingTool`** is exported from `@khalido/home/finders`: thrown when the discovery tool (`avahi-browse` on Linux) isn't installed.
- **docs:** `castStatus` and `castFree` take the Cast part's state (`home.part("cast")?.state`), which the docs called "the snapshot".
- **cli:** `home` and `home daikin` find the Daikin by UDP broadcast when `DAIKIN_HOST` is unset, as the write commands do, so `DAIKIN_HOST` is optional. With no unit on the network it reads "not set up".
- **cli:** `home cast volume | mute | stop` print the device's line once it reports the change, where they printed nothing; after 2 s without it, "sent; the device has not reported it yet".
- **cli:** "no route to host" on macOS now adds that the terminal may need the Local Network permission.

### Added

- **`byRoom(snapshot, config)`** from `@khalido/home`, for a map of the home: each room of the config with its devices, `noData` for a connector the config places there that has nothing to list, and `unplaced` for the rest.
- **config: `photos` on a room**, a list of paths. The library carries them and reads nothing.
- **cast: `castFree(state, targets, { forms })`**: with `forms: ["speaker", "display"]` a TV is left out, and a group holding one becomes its other free members.
- **`home.add(integration)` and `home.remove(name)`** on the home `createHome` returns: add one while the rest keep running (a bridge paired just now), replace one by name (the old run has ended before the new one starts; how an `unavailable` part comes back after a re-key), or stop one and drop its part. `start` now also waits for those added.
- **spotify: `playingElsewhere(state)`**, and **`spotifyElsewhere(snapshot)`** from `@khalido/home`: the names of the Cast devices and groups playing that track in Spotify, matched by the track's name since Soloist doesn't say where the music is. Empty for a phone or a laptop. `homeDevices` and `home devices` put it in the speaker's line (`silent · "Song" is playing on Front room speaker`), and `spotifyText(state, on)` takes it. Tested on built snapshots only.
- **hue: lights, rooms and scenes by name.** `client.light(name, change)`, `client.room(name, change)` and `client.scene(name, room?)`, each resolving `{ state, confirmed }` (`HueApplied`). `change` (`LightChange`) is `{ on?, brightness?, color?, kelvin?, transitionMs? }`: a colour as hex or `{ r, g, b }`, sent as `xy` inside the light's own gamut; a white temperature in kelvin, checked against the light's range. An unknown name or a value the light can't take throws `HueError` with `code: "invalid"` before anything is sent, and a light the bridge has lost throws with `code: "offline"`.
- **hue: colour in the state.** Each light's `kelvin` and `kelvinRange`, and on a colour light its `xy`, `hex` and `gamut`. `colorToXy`, `xyToHex`, `kelvinToMirek`, `mirekToKelvin` and `hueText` are exported.
- **`home light <name> …`**, and `home room` and `home scene` now take a brightness, a temperature (`2700k`) and a colour (`ff8800`) together, name a scene's room (`in <room>`), and print what the bridge then reported.
- **hue: Signify's root certificates are in the package**, as `HUE_BRIDGE_ROOT_CA` from `@khalido/home/hue`: both roots, the bundle from Signify's "Using HTTPS" page. `ca` is now optional everywhere it was required: `hue({ host, bridgeId, key })`, `bunPinnedFetch(bridgeId)`, `nodePinnedFetch(bridgeId)`, the config's `ca` and the CLI's `HUE_CA_FILE`. One given still replaces the bundle. `home probe` reads the bridge without setup, and `home discover --write` no longer writes a `ca` line.
- **hue: `pairWhenPressed`**: `pair`, asked every 2 s for 30 s until the bridge's button is pressed, with `onWaiting` for the moment to prompt. `pair` takes a `signal`. `home pair` now waits 60 s for the button, counting down, and says when no press was detected.
- **daikin: `client.power(on)` and `client.mode(mode, targetC?)`**, resolving with `{ state, confirmed }` (`DaikinApplied`) once the unit reports what was asked, or after 5 s (`CONFIRM_MS`) without it. `mode` sends the mode, power on and the setpoint as one request: the one given, else the library's defaults, `DEFAULT_TARGET_C` (cool 25, heat 27).
- **`home daikin on | off`** (power only, as it was last left) and **`home daikin cool | heat | auto [°C] | dry | fan`**, each printing what the unit then reports.
- **`home devices`:** every device the connectors read, one line each from `homeDevices`: its state, its room and name from the config when there is one, and why when it isn't available. `--json` prints the records. A connector that isn't connected is named on stderr.

## [0.1.3] - 2026-11-10

### Added

- **`Part.reason`:** why a part is `unavailable`, for code to switch on: `auth` (a key or token was rejected or unusable, so a person must re-key), `config` (a setting or file is wrong) or `crashed` (its `run` threw). `health()` and `home --json` carry it. It can be absent. Hue, Enphase, Amber and Up set `auth` on a rejected key, and so does an Enphase token that does not parse. In `home status`, a connector that fails to build from the environment says `auth` or `config`.
- **`homeDevices(snapshot, config?)`:** every device in one list (Amber, Up and the weather read services and list nothing), each answering the same questions (`connector`, `id`, `name`, `kind`, `available`, `reason`, `asOf`, `state`, `text`, `room`, `members`), with the connector's own typed row in `detail` and `connector` narrowing its type. Each device connector also exports its own: `hueHomeDevices`, `daikinHomeDevices`, `enphaseHomeDevices`, `castHomeDevices`, `printersHomeDevices`, `spotifyHomeDevices`. `DeviceRecord` is the common shape and `deviceRecords(part, records)` what a connector returns them through: while its part isn't connected, none is `available`.
- **`ConnectorCode`:** the type of `ConnectorError.code`, every code the library sets, so a consumer's table of messages fails to compile when one is added.
- **cast:** `castStatus(snapshot)` says what each device and group is doing (`idle`, `restorable`, `busy` or `offline`, with the app, title and volume), and `castFree(snapshot, targets)` gives the targets an announcement would not disturb, with the ones it `skipped` and why. For announcing only where nothing is playing.
- **weather:** `reason` on an `unavailable` weather part (`auth` if a stopped source's key was rejected, else `config`), and `state.sources.<name>.reason` beside `stopped`, so code can see a dead Google key while another source keeps the part `connected`. A custom `WeatherSource` can return `stopReason` with `stop`.

### Changed

- **`ConnectorError.code`** is typed `ConnectorCode`, no longer `string`. Reading it is unchanged. Only code that builds a `ConnectorError` with a code outside that set stops compiling; chota-bot and jaldi don't.
- **hue:** a room or zone the bridge gives no on or off for prints its name alone in `home hue`, no longer "off".
- **weather:** Google's key is sent in the `X-Goog-Api-Key` header, no longer in the URL.
- **weather:** Google's stop text says which it was: `google: the key was rejected (HTTP 400 API_KEY_INVALID)` or `google: the request was refused (HTTP 400); check the latitude and longitude`. Before, both read `google: key rejected or request refused (HTTP 400)`.

### Fixed

- **cast:** `announce` to a group with a `volume` left the group's own level at the announcement's, though every member's was put back. The group's is now restored too, before its members', so theirs land last.
- **spotify:** `interrupt` paused the music when the account was playing on another speaker (the box reports `playing` while not the active device). It now leaves it alone and returns `music: "untouched"`, as `duck` does.
- **spotify:** `maxVolume` gave up when a lowering was refused or unanswered after a second start signal (buffering, then playing) had opened a new window, leaving the volume above the cap. The new window now lowers again.
- **`createHome`:** an `onChange` that throws or rejects no longer marks the integration `unavailable`; the error goes to `console.error` and the integration keeps running.
- **`createHome`:** `refresh()` before `start()` resolves at once instead of never.
- **`createHome`:** an integration whose `run` fails after a good report keeps its last `state`.
- **`createHome`:** a `run` that throws synchronously marks that integration `unavailable`; the others still start.
- **`home <connector> --config`** needs only that connector's keys, and runs only that connector.
- **`realClock.sleep`** resolves at once on an already-aborted signal.
- **Docs:** the `readFile` in `docs/config.md` expands `~/`, which `home discover --write` puts in Enphase's `token`. The README says the package is ESM only.

## [0.1.2] - 2026-11-09

From chota-bot's live writes on a Raspberry Pi. `setVolume` on an inactive speaker now rejects, and `track` events can come later than before.

### Added

- **spotify:** `activate()`, and `home spotify activate`.
- **cast:** `announceAll(targets, clip, options)`, one result per device, and repeated `--to` on `home cast announce` (`--json` is an array with several).
- **cast:** `form` on a device whose model it knows (`speaker`, `display`, `tv`, from `castForm(model)`), so "all speakers" can skip TVs. The address cache keeps the model; a cached device without one goes through discovery once.
- **up:** the integration has `client`, for a consumer's writes.

### Changed

- **spotify:** `setVolume` while the speaker isn't the active device rejects with code `inactive`, instead of `confirmed: false`: Soloist accepts it and drops it. `duck` then runs `fn` with `music: "untouched"`.
- **spotify:** `play` while inactive goes active first.
- **spotify:** the `track` event waits for the track's name.
- **cast:** a clip that doesn't start playing fails after 15 s (or `timeoutMs`), naming its type. An error the receiver reports sooner gives its reason, and its code if it has one.

### Fixed

- **spotify:** `maxVolume` waits until the speaker is active, retries until Soloist reports the lower volume, and says "lowered it" only then; if it never shows, `detail` says so. It said "lowered it" at 56 with a cap of 40. The window also opens when the speaker goes active.
- **spotify:** `setRepeat("off")` from `track` stayed on `track`: the two commands now go 600 ms apart.
- **spotify:** a volume within 1 of the request confirms, since Soloist rounds it.
- **spotify:** a stall repair can run again when a track comes back after another.
- **`home cast announce`** exits 1 when a clip didn't play.

## [0.1.1] - 2026-11-09

Fixes from chota-bot's first live reads, on a Raspberry Pi and a Mac. No breaking changes.

### Added

- **`discover`:** a `stopOn` option, for an error no later pass could get past.

### Changed

- **cast:** `tlsConnect` gives up after 3 s, down from 10 s, so one offline device holds up a one-shot read for less. A device whose cached address fails and that discovery can't find no longer gets a second try before it shows as disconnected. `home cast` with one device down: 13.3 s to 2.3 s (Bun 1.4.4, macOS, 2026-11-09).

### Fixed

- **spotify:** `maxVolume`'s first-play window now opens on a start through `buffering` too: idle → buffering → playing escaped it.
- **weather:** the text's chance of rain for today is the highest of the hours still to come, once that's lower than the day's figure and from the same source, and it says "the rest of the day". `forecast.today.rainChance` stays as the source gave it.
- **`home discover`:** without `avahi-browse` or `dns-sd` it fails at once, naming the package, instead of after both passes.
- **spotify:** a frame or open event from a socket that had already ended (dropped, or closed after 10 s with no message) no longer changes the state or the next socket's status.
- **cast:** `@khalido/home/cast/serve`'s types no longer name `NodeJS.Dict`, so they compile without `@types/node`.
- **Docs:** corrected the config parser, the printers exception to one device per connector, Daikin's `home status` address, and the weather user agent. `skills/draw-home` no longer points at private paths.

## [0.1.0] - 2026-11-08

First release. Nine connectors: Hue, Daikin, Enphase, Google Cast, AirPrint printers and a Spotify Soloist speaker on the local network; Amber prices, Up Bank spending and the weather from the cloud. Each connector's README says what has run against a real device.

### Added

- **One snapshot, typed by name.** `createHome` runs the integrations and keeps their parts; `home.part("weather")?.state` is a `WeatherState`. `loadHome` builds them from a home config.
- **Health.** Each part carries `lastGoodAt` and `downSince`; `health(snapshot, now)` says ok, stale or down per integration, with its thresholds. `onChange` gets what changed: `{ name, before, after }`.
- **Writes** hang off the integration (`home.integration("daikin")?.client.write(…)`) and go through a write lane: spaced, a burst merged so the last value lands, and they follow a device that moves.
- **Weather** by the hour and by part of the day. The parts of the day are yours to name (`blocks`), with UV per part.
- **Energy.** `energyNow` combines solar, use and price; `bestWindow` finds the cheapest or greenest hours in Amber's forecast.
- **Spotify.** `spotify()` reads a [Spotify Soloist](https://developer.spotify.com/documentation/soloist) speaker over its local WebSocket and plays, pauses, skips and sets the volume, held to a `maxVolume`. Each write resolves with the state once Soloist reports the change (`{ state, confirmed }`). `duck(fn, { to })` turns the music down around an announcement and `interrupt(fn)` pauses it; both put it back unless someone changed it from a phone meanwhile. `state.upNext` is what plays next, `setRepeat` sets repeat, `speakerState(part)` gives one word to switch on (offline, connecting, waiting, idle, playing, paused, buffering), and `spotifyChanges(before, after)` turns two reports into events (started, resumed, paused, stopped, track, offline, online, waiting, picked), marking the playback ones that come from the library's own `duck` or `interrupt`. It notices playback that stalls while Soloist says playing (Soloist issue #5), says so in `anomaly` and as `stalled` and `recovered` events, and with `repairStalls: true` tries once per track to restart it. The connector has only run against a fake socket; no real Soloist has answered it yet.
- **A home config** (`home.jsonc`, checked by `home.schema.json`): each device by the identity its own discovery reports, its last address, key env names (never keys) and its room. A device that moves is found again by discovery after failed reads, and `loadHome` keeps an address book.
- **The `home` command** (Bun): `home` for every connector's status, `home <connector>` for one, `discover`, a read-only `probe`, `config check`, `locate`, `cache`, `pair` for Hue, `enphase login`, and writes for Hue (`lights`, `room`, `scene`), Cast, Up and the Spotify speaker. `--json` on the reads.
- **Agent skills** in `skills/`: `use-home` (reading safely, connecting, the rules for writes) and `draw-home` (an SVG plan of a home and its rooms). `llms.txt` points agents at the docs.
- **Node.** Hue and Enphase take the fetches in `@khalido/home/node`. The library runs on Bun 1.4+ and Node 24+; the `home` command needs Bun.

[Unreleased]: https://github.com/khalido/home.ts/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/khalido/home.ts/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/khalido/home.ts/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/khalido/home.ts/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/khalido/home.ts/releases/tag/v0.1.0
