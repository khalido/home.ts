# Changelog

All notable changes to home.ts (`@khalido/home` on npm), in [Keep a Changelog](https://keepachangelog.com/) form. Versions follow [SemVer](https://semver.org) at 0.x: a minor release can break what a consumer calls, a patch can't.

## [Unreleased]

### Added

- **`Part.reason`:** why a part is `unavailable`, for code to switch on: `auth` (a key or token was rejected or unusable, so a person must re-key), `config` (a setting or file is wrong) or `crashed` (its `run` threw). `health()` and `home --json` carry it. It can be absent. An Enphase token that does not parse is now `unavailable` with `auth`, not `crashed`.

- **`homeDevices(snapshot, config?)`:** every device in the home in one list, each answering the same questions (`connector`, `id`, `name`, `kind`, `available`, `reason`, `asOf`, `state`, `text`, `room`, `members`), with the connector's own typed row in `detail` and `connector` narrowing its type. Each device connector also exports its own: `hueHomeDevices`, `daikinHomeDevices`, `enphaseHomeDevices`, `castHomeDevices`, `printersHomeDevices`, `spotifyHomeDevices`.
- **`ConnectorCode`:** the type of `ConnectorError.code`, every code the library sets, so a consumer's table of messages fails to compile when one is added.
- **cast:** `castStatus(snapshot)` says what each device and group is doing (`idle`, `restorable`, `busy` or `offline`, with the app, title and volume), and `castFree(snapshot, targets)` gives the targets an announcement would not disturb, with the ones it `skipped` and why. For announcing only where nothing is playing.
- **weather:** `reason` on an `unavailable` weather part (`auth` if a stopped source's key was rejected, else `config`), and `state.sources.<name>.reason` beside `stopped`, so code can see a dead Google key while another source keeps the part `connected`. A custom `WeatherSource` can return `stopReason` with `stop`.

### Changed

- **`ConnectorError.code`** is typed `ConnectorCode`, no longer `string`: code that builds a `ConnectorError` with a code of its own stops compiling.

- **hue:** a room or zone the bridge gives no on or off for prints its name alone in `home hue`, no longer "off".

- **weather:** Google's key is sent in the `X-Goog-Api-Key` header, no longer in the URL.
- **weather:** Google's stop text says which it was: `google: the key was rejected (HTTP 400 API_KEY_INVALID)` or `google: the request was refused (HTTP 400); check the latitude and longitude`. Before, both read `key rejected or request refused`.

### Fixed

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

[Unreleased]: https://github.com/khalido/home.ts/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/khalido/home.ts/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/khalido/home.ts/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/khalido/home.ts/releases/tag/v0.1.0
