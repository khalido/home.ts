# Spotify (Soloist)

What a [Spotify Soloist](https://developer.spotify.com/documentation/soloist) speaker is playing (start with its [basic integration](https://developer.spotify.com/documentation/soloist/howtos/basic-integration)), and control over it, over Soloist's local WebSocket. `iot_class`: **local_push**. Tested against a fake socket only: no real Soloist has answered this connector yet.

Soloist is Spotify's own headless Spotify Connect client (Linux arm64, armv7, x86_64, Apple Silicon, Windows x86_64). The machine running it is a speaker in every Spotify app on the network; this connector is how a program on the same machine sees and steers it. It doesn't search Spotify or read a library: Soloist plays URIs and reports its own session. Search belongs to the consumer (KO, 2026-11-08; `docs/ideas.md`).

## Built

**Connecting.** `spotify({ url?, maxVolume?, repairStalls?, stallCheckMs?, connect?, clock? })` holds one WebSocket to `url`, `ws://127.0.0.1:9091` by default (chota-bot's port; Soloist has none, its docs' example is 9090, so start it with `--ws 127.0.0.1:9091` or pass `url`). `connect` defaults to the runtime's `WebSocket` (Bun, Node 22+).

- No report until `auth_state` and, signed in, the first `playback_state` (at most 10 s): the part stays createHome's `connecting`, and a one-shot read sees the track. Then `connected`. Nothing answering, or a drop, is `disconnected` with the reason in `detail` and the last state kept; a reconnect stays `disconnected` until Soloist answers. A socket silent for 10 s is closed. Backoff 1 s doubling to 60 s, back to 1 s after a socket that opened. Without `SOLOIST_WS`, `home` lists the speaker as not set up.
- **Signed out is normal** until someone picks the speaker in a Spotify app (seen live): `connected`, `loggedIn: false`, detail "waiting for someone to pick it in the Spotify app", which also names a bad key ([#18](https://github.com/spotify/soloist/issues/18)). Writes are refused unsent with code `waiting`.
- `refresh()` asks again (`get_state`, or `get_auth_state` signed out; a refused query is an `anomaly`), or reconnects now while down.

**State.** Each frame passes a zod schema, every field optional, and folds into `SpotifyState`: `loggedIn`, `deviceName`, `active`, `status`, `track` (`uri`, `type`, `name`, `artists`, `album`, cover, `durationMs`), `context`, `position` (Soloist's anchor `ms`, `atMs`, `speed`; `positionMs(state, now)` moves it on, not clamped), `volume`, `shuffle`, `repeat`, `upNext` (from `queue_changed`, plus one `get_queue` with `limit: 10` per socket; an unanswered one is quiet, as an empty queue may send nothing). An empty item `uri` is nothing loaded: no `track`. Unknown frame types are skipped. The library adds `aside` while its own `duck`, `interrupt` or stall repair runs, and `stalled`. Odd readings pass through into `anomaly`: an unknown status or repeat, a volume outside 0–100, a negative speed, a position past the track's end, a frame the schema rejects (which leaves the state as it was).

**Writes**, on the integration: `play(linkOrUri?)`, `pause`, `resume`, `next`, `prev`, `seek(ms)`, `setVolume(0–100)`, `queue(track)`, `setShuffle(on)`, `setRepeat("off" | "context" | "track")`. A link is an `open.spotify.com` URL or a `spotify:` URI; `spotify.link` short links are refused.

- Each resolves `{ state, confirmed }`: after Soloist accepts (`command_result`), it waits up to 2 s for the event that shows _this caller's_ change (the volume sent, `paused` or `playing`, a new track URI, the context or track played, a position near the seek, the shuffle or repeat set, the track in `upNext`), then gives the state. No such event: `confirmed: false`, the state as it stands. A write merged into a later one confirms only if its own change shows; a write of what is already so confirms at once; a drop ends the wait. `next` also confirms on idle (end of queue) or a restart, `prev` on a restart from 5 s or more in.
- Errors are `ConnectorError` with `code`: `offline`, `waiting`, `refused` (Soloist's `error`), `timeout` (3 s), `invalid` (bad input, nothing sent).
- One write lane, 100 ms apart (a guess). `volume`, `seek`, `shuffle`, `repeat` merge to the last; `play`, `pause`, `resume` share a slot, so the last wins; each `next`, `prev`, `queue` is its own. Queries go through the lane too, at most 1 s each, since Soloist's `error` names no command.
- `setRepeat` is two commands in the docs' order (clear the other mode, then set this one); if the second is refused, repeat may be left off.
- A failed write the library made itself stays in `detail` until a write works or the socket reconnects.

**`maxVolume`** holds requests (rounded to a whole percent). Within 10 s of idle → playing, a reported volume above it is lowered once and `anomaly` says so until the speaker goes idle: [#23](https://github.com/spotify/soloist/issues/23), the first play on PipeWire starts at 100%. `--initial-volume` is ignored there. Not on resuming from pause, not on connecting to a song already playing, and a person turning it up again keeps it.

**`duck(fn, { to })` and `interrupt(fn)`** turn the music down, or pause it, around `fn`, then put it back. Both resolve `{ value, music, why? }`, `music` one of:

- `untouched`: not playing or buffering, not connected, (duck) the volume unknown or already at `to` or below, or the lowering or pause failed, so `fn` ran over it.
- `restored`: put back as it was.
- `kept`: someone changed it meanwhile (resumed, skipped, set the volume), or the pause or lower volume never showed. Theirs stays.
- `failed`: the restore failed or was never reported; it may be left quiet or paused.

The restore runs even if `fn` throws: the error is `fn`'s, and a failed restore goes to `detail`. `duck` restores the earlier volume even above `maxVolume`. One aside at a time: never call one inside another's `fn` (it waits forever), and put two announcements in one `fn`. With Cast: `speaker.duck(() => cast.announce("Kitchen", clip), { to: 20 })`. Cast's own `announce` restores what a Cast device was playing; these are for Soloist's output.

**Reading it.** `speakerState(part)`: `offline`, `connecting`, `waiting`, then Soloist's status (`idle`, `playing`, `paused`, `buffering`, or its own string); signed in with no status yet is `idle`. `spotifyChanges(before, after)`, for `onChange`, gives events in this order: `offline`, `online`, `waiting`, `picked`, `started` (from idle), `resumed` (from paused), `paused`, `stopped`, `track`, `stalled`, `recovered`. Buffering counts as playing. Nothing on the first report, so a restart announces nothing; no volume or queue events. Playback events during an aside carry `own: true`; connection, sign-in and stall events never do.

**Stalls** ([#5](https://github.com/spotify/soloist/issues/5): playback stops mid-track, often the first after idle, while Soloist still says `playing`). While playing, one `get_state` every 20 s (`stallCheckMs`, code only; 0 turns it off).

- `frozen`: two fresh reports at least 10 s apart by Soloist's clock, under 1 s of movement. `overrun`: the same track more than 15 s past its length (the reported symptom), not with repeat-track. A pause or drop between checks starts over. Paused, buffering, idle and the library's own asides are not looked at.
- Sets `state.stalled` (`track`, `ms`, `how`, `tried`), "playback stalled at 1:39 (Soloist issue #5)" in `anomaly`, and a `stalled` event; `recovered` when a later check sees it move. A new track or a stop just ends it.
- `repairStalls: true` (off by default: an unasked write) tries once per track: a skip for an overrun; otherwise a seek to where it stuck, then a pause and play if it hasn't moved 5 s later. It queues with `duck` and `interrupt`, runs as an aside, and stops if the music stops, changes or another aside starts. #5 reports no workaround: the nudges are guesses.

**CLI and config.** `home spotify` and the writes `home spotify pause | play [link] | next | volume <0-100>` (held to `SOLOIST_MAX_VOLUME`) need `SOLOIST_WS`, and print what Soloist then reported. Config: `{ "connector": "spotify", "url"?, "maxVolume"?, "repairStalls"?, "name"? }`, one per home.

## Protocol

JSON text frames on a plain WebSocket: no path, subprotocol, auth, TLS or origin check, so bind it to loopback (any web page on the same machine can reach it). Client frames are `{ "type": "command", "command": "…", …fields }`.

- **Server** (every frame has a `type`): `auth_state` (`logged_in`, `is_active`, `device_name`), `playback_state` (`status`, `item`, `context`, `position`, `volume`, `is_active`, `options`, `available_actions`), `track_changed`, `playback_changed`, `volume_changed`, `device_changed`, `context_changed`, `options_changed` (`shuffle`, `repeat`: off, context, track), `position_sync` (`position_ms`, `timestamp_ms` epoch ms, `speed`), `queue_changed` (`previous`, `upcoming`; broadcasts capped at 10), `command_result` (`command`), `error` (`message`).
- **Commands:** queries `get_auth_state`, `get_state`, `get_queue` (answered by their frame, no `command_result`); controls `play` (`uri`?), `pause`, `skip_next`, `skip_prev`, `seek` (`position_ms`), `set_volume` (`volume`, 0–100), `set_shuffle`, `set_repeat_context` and `set_repeat_track` (`enabled`), `add_to_queue` (`uri`, tracks only), `activate`, `deactivate`. Controls need a session; without one Soloist answers `error` "command requires authentication".
- On connect: `auth_state`, then `playback_state` only if signed in. A later sign-in is promised only `auth_state`, so the connector asks `get_state`.
- If `--ws` can't bind, Soloist runs without it and only logs a warning: `disconnected` while the daemon looks healthy. `--ws ADDR:0` writes the port to the data dir; this connector takes a fixed `url`.

Not built: `activate`/`deactivate`, `available_actions`. An ad (`entity_type: "ad"`) shows as a `track`.

## Unverified

Everything through this connector; only `soloist ctl` has talked to a real Soloist. In particular:

- **Stalls:** whether the reported position freezes in one (if not, only an overrun is caught), whether `get_state` re-anchors the position, and whether a seek or a pause and play restarts it.
- **Writes:** that each confirming event arrives within 2 s; which events a `play` of an album or playlist sends; `play` of a new URI with no phone around; seek on playback a phone started.
- **The rest:** `get_queue` answered by `queue_changed`; `play` with nothing loaded; whole-number volumes; the order of `auth_state` and `playback_state`; the 100% first play and its lowering; Family-plan members picking the speaker; whether the session survives a Soloist restart; a USB speaker's standby dropping it mid-play.

## Live findings

**2026-11-08, Raspberry Pi 5, Pi OS Lite Trixie arm64, via `soloist ctl`** (chota-bot's session). `soloist 1.3.10.51 build 1793988108 (20261106)` as a systemd user unit with `-w 127.0.0.1:9091`. It logs the days left on the build (88), the WebSocket listening, then "waiting for login". Builds expire 90 days after they're made (exit code 10); chota-bot's units refresh weekly.

- Not logged in until a phone picked the speaker: the normal waiting state. After: logged in, active device.
- Playback a phone started was controllable from the Pi: volume, pause, and `play` with no `uri` resumed in place.
- Soloist and avahi-daemon both bound UDP 5353 (`ss -ulpn`) and the phone found the speaker ([#1](https://github.com/spotify/soloist/issues/1) didn't bite).
- Under PipeWire 1.4 the stream is a node "Spotify". The USB speaker has no hardware volume, so the sink stays at 100% and Soloist's volume is the music's: `maxVolume` caps that only.
- Logs: `journalctl _SYSTEMD_USER_UNIT=soloist.service`.
- chota-bot found a client-credentials search URI that Soloist then played (outside this library).

## Sources

- [Soloist documentation](https://developer.spotify.com/documentation/soloist), [WebSocket API](https://developer.spotify.com/documentation/soloist/reference/websocket-api), [`soloist ctl`](https://developer.spotify.com/documentation/soloist/reference/soloist-ctl), [command line](https://developer.spotify.com/documentation/soloist/reference/command-line) (read 2026-11-08). Soloist is Spotify's binary, never redistributed here.
- [Soloist's issues](https://github.com/spotify/soloist/issues): #1, #5, #15, #18, #23, #24.
- chota-bot's first client (KO's, 2026-11-08), ported here. Home Assistant has no Soloist integration; its `spotify` is the cloud Web API.
