# Changelog

## 0.1.0

First release. Nine connectors: Hue, Daikin, Enphase, Google Cast, AirPrint printers and a Spotify Soloist speaker on the local network; Amber prices, Up Bank spending and the weather from the cloud. Each connector's README says what has run against a real device.

- **One snapshot, typed by name.** `createHome` runs the integrations and keeps their parts; `home.part("weather")?.state` is a `WeatherState`. `loadHome` builds them from a home config.
- **Health.** Each part carries `lastGoodAt` and `downSince`; `health(snapshot, now)` says ok, stale or down per integration, with its thresholds. `onChange` gets what changed: `{ name, before, after }`.
- **Writes** hang off the integration (`home.integration("daikin")?.client.write(…)`) and go through a write lane: spaced, a burst merged so the last value lands, and they follow a device that moves.
- **Weather** by the hour and by part of the day. The parts of the day are yours to name (`blocks`), with UV per part.
- **Energy.** `energyNow` combines solar, use and price; `bestWindow` finds the cheapest or greenest hours in Amber's forecast.
- **Spotify.** `spotify()` reads a [Spotify Soloist](https://developer.spotify.com/documentation/soloist) speaker over its local WebSocket and plays, pauses, skips and sets the volume, held to a `maxVolume`. Each write resolves with the state once Soloist reports the change (`{ state, confirmed }`). `duck(fn, { to })` turns the music down around an announcement and `interrupt(fn)` pauses it; both put it back unless someone changed it from a phone meanwhile. `state.upNext` is what plays next, `setRepeat` sets repeat, `speakerState(part)` gives one word to switch on (offline, waiting, idle, playing, paused), and `spotifyChanges(before, after)` turns two reports into events (started, resumed, paused, stopped, track, offline, waiting, picked), marking those from the library's own `duck` or `interrupt`. Tested against a fake Soloist only.
- **Node.** Hue and Enphase take the fetches in `@khalido/home/node`. The library runs on Bun 1.4+ and Node 24+; the `home` command needs Bun.
