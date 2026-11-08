# Changelog

All notable changes to home.ts (`@khalido/home` on npm), in [Keep a Changelog](https://keepachangelog.com/) form. Versions follow [SemVer](https://semver.org) at 0.x: a minor release can break what a consumer calls, a patch can't.

## [Unreleased]

### Fixed

- **spotify:** a frame or open event from a socket that had already ended (dropped, or closed after 10 s of silence) no longer changes the state or the next socket's status.
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

[Unreleased]: https://github.com/khalido/home.ts/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/khalido/home.ts/releases/tag/v0.1.0
