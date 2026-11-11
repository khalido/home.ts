# Spotify (Soloist)

What a [Spotify Soloist](https://developer.spotify.com/documentation/soloist) speaker is playing (start with its [basic integration](https://developer.spotify.com/documentation/soloist/howtos/basic-integration)), and control over it, over Soloist's local WebSocket. `iot_class`: **local_push**. Reads and most writes seen live on a real Soloist (0.1.1, 2026-11-09); what 0.1.2 changed since is tested against a fake socket only.

Soloist is Spotify's own headless Spotify Connect client (Linux arm64, armv7, x86_64, Apple Silicon, Windows x86_64). The machine running it is a speaker in every Spotify app on the network; this connector is how a program on the same machine sees and steers it. It doesn't search Spotify or read a library: Soloist plays URIs and reports its own session. Search belongs to the consumer (KO, 2026-11-08; `docs/ideas.md`).

## Built

**Connecting.** `spotify({ url?, maxVolume?, repairStalls?, stallCheckMs?, connect?, clock? })` holds one WebSocket to `url`, `ws://127.0.0.1:9091` by default (chota-bot's port; Soloist has none, its docs' example is 9090, so start it with `--ws 127.0.0.1:9091` or pass `url`). `connect` defaults to the runtime's `WebSocket` (Bun, Node 22+).

- No report until `auth_state` and, signed in, the first `playback_state` (at most 10 s): the part stays createHome's `connecting`, and a one-shot read sees the track. Then `connected`. Nothing answering, or a drop, is `disconnected` with the reason in `detail` and the last state kept; a reconnect stays `disconnected` until Soloist answers. A socket silent for 10 s is closed. Backoff 1 s doubling to 60 s, back to 1 s after a socket that opened. Without `SOLOIST_WS`, `home` lists the speaker as not set up.
- **Signed out is normal** until someone picks the speaker in a Spotify app (seen live): `connected`, `loggedIn: false`, detail "waiting for someone to pick it in the Spotify app", which also names a bad key ([#18](https://github.com/spotify/soloist/issues/18)). Writes are refused unsent with code `waiting`.
- `refresh()` asks again (`get_state`, or `get_auth_state` signed out; a refused query is an `anomaly`), or reconnects now while down.

**State.** Each frame passes a zod schema, every field optional, and folds into `SpotifyState`: `loggedIn`, `deviceName`, `active`, `status`, `track` (`uri`, `type`, `name`, `artists`, `album`, cover, `durationMs`), `context`, `position` (Soloist's anchor `ms`, `atMs`, `speed`; `positionMs(state, now)` moves it on, not clamped), `volume`, `shuffle`, `repeat`, `upNext` (from `queue_changed`, plus one `get_queue` with `limit: 10` per socket; an unanswered one is quiet, as an empty queue may send nothing). An empty item `uri` is nothing loaded: no `track`. Unknown frame types are skipped. The library adds `aside` while its own `duck`, `interrupt` or stall repair runs, and `stalled`. Odd readings pass through into `anomaly`: an unknown status or repeat, a volume outside 0–100, a negative speed, a position past the track's end, a frame the schema rejects (which leaves the state as it was).

**Writes**, on the integration: `activate()`, `play(linkOrUri?)`, `pause`, `resume`, `next`, `prev`, `seek(ms)`, `setVolume(0–100)`, `queue(track)`, `setShuffle(on)`, `setRepeat("off" | "context" | "track")`. A link is an `open.spotify.com` URL or a `spotify:` URI; `spotify.link` short links are refused.

- Each resolves `{ state, confirmed }`: after Soloist accepts (`command_result`), it waits up to 2 s for the event that shows _this caller's_ change (the volume sent, `paused` or `playing`, a new track URI, the context or track played, a position near the seek, the shuffle or repeat set, the track in `upNext`), then gives the state. No such event: `confirmed: false`, the state as it stands. A write merged into a later one confirms only if its own change shows; a write of what is already so confirms at once; a drop ends the wait. `next` also confirms on idle (end of queue) or a restart, `prev` on a restart from 5 s or more in.
- A volume reported within 1 of the request confirms, since Soloist rounds it (phone steps are sixteenths).
- **While inactive** (`state.active: false`), Soloist accepts `set_volume` and drops it, three times live. `setVolume` is refused unsent with code `inactive`; `duck` and `interrupt` run `fn` over the music with `music: "untouched"`: "playing" while inactive is the account playing on another speaker, which a pause would stop. `activate()` fixes it, but makes a new audio stream, so the volume can jump to the level last saved (62 to 40, live). `play` while inactive goes active first (a `play` alone didn't take live; going active first is untested). `resume` doesn't: it worked inactive, and `interrupt` relies on that.
- Errors are `ConnectorError` with `code`: `offline`, `waiting`, `inactive`, `refused` (Soloist's `error`), `timeout` (3 s), `invalid` (bad input, nothing sent).
- One write lane, 100 ms apart (a guess). `volume`, `seek`, `shuffle`, `repeat` merge to the last; `play`, `pause`, `resume` share a slot, so the last wins; each `next`, `prev`, `queue` is its own. Queries go through the lane too, at most 1 s each, since Soloist's `error` names no command.
- `setRepeat` is two commands in the docs' order (clear the other mode, then set this one), 600 ms apart: back to back, `off` from `track` stayed on `track` live, and 600 ms apart worked. If the second is refused, repeat may be left off.
- A failed write the library made itself stays in `detail` until a write works or the socket reconnects.

**`maxVolume`** holds requests (rounded to a whole percent). For 10 s after a start signal, a reported volume above it is lowered: a start from idle (to playing or buffering), the first such status after a sign-in, `playing` after a start through buffering, or the speaker going active. Event order differs between runs, so no one pattern is relied on. It waits until the speaker is active, retries until Soloist reports the lower volume, and only then says so in `anomaly`, until the speaker goes idle; if it never shows or Soloist refuses it, `detail` says so. A reported volume within 1 of the cap is left alone. Not on resuming from pause while active, not on connecting to a song already playing, and a person turning it up after the lowering keeps it (before Soloist has reported the lowering, a person's raise looks like the start's own jump and is lowered too). `--initial-volume` is ignored on PipeWire ([#23](https://github.com/spotify/soloist/issues/23)).

**`duck(fn, { to })` and `interrupt(fn)`** turn the music down, or pause it, around `fn`, then put it back. Both resolve `{ value, music, why? }`, `music` one of:

- `untouched`: not playing or buffering, not connected, not the active device, (duck) the volume unknown or already at `to` or below, or the lowering or pause failed, so `fn` ran over it.
- `restored`: put back as it was.
- `kept`: someone changed it meanwhile (resumed, skipped, set the volume), or the pause or lower volume never showed. Theirs stays.
- `failed`: the restore failed or was never reported; it may be left quiet or paused.

The restore runs even if `fn` throws: the error is `fn`'s, and a failed restore goes to `detail`. `duck` restores the earlier volume even above `maxVolume`. One aside at a time: never call one inside another's `fn` (it waits forever), and put two announcements in one `fn`. With Cast: `speaker.duck(() => cast.announce("Kitchen", clip), { to: 20 })`. Cast's own `announce` restores what a Cast device was playing; these are for Soloist's output.

**Reading it.** `speakerState` takes the Part; `spotifyText` and `positionMs` take its `state`. `speakerState(part)`: `offline`, `connecting`, `waiting`, `elsewhere` (Soloist says playing but isn't the active device: the music is on another Spotify device and this one is silent; `playingElsewhere(state)` is the test), then Soloist's status (`idle`, `playing`, `paused`, `buffering`, or its own string); signed in with no status yet is `idle`. `spotifyChanges(before, after)`, for `onChange`, gives events in this order: `offline`, `online`, `waiting`, `picked`, `started` (from idle), `resumed` (from paused), `paused`, `stopped`, `track`, `stalled`, `recovered`. Buffering counts as playing. Music elsewhere is silence here: leaving is `stopped`, arriving is `started` then `track`, and its tracks, pauses and stops meanwhile fire nothing (a resume there after a pause there fires one `stopped`: paused while inactive reads as Soloist says, so the resume looks like music leaving). Soloist doesn't say where it is; `spotifyElsewhere(snapshot)` from `@khalido/home` names the Cast devices playing that track in Spotify, and `homeDevices` puts them in the speaker's line (matched by name, built snapshots only, untried live), and is empty for a phone. Nothing on the first report, so a restart announces nothing; no volume or queue events. Playback events during an aside carry `own: true`; connection, sign-in and stall events never do. `track` waits for the track's name, which Soloist can send a few seconds after the track (seen live); one that never gets a name never fires. One press on a phone can fire track, resumed, stopped, started and track over 3 s, sometimes with a 0.8 s `waiting`, and the order varies: anything announcing these should wait a few seconds. `state.volume` isn't the level that will play until `active` (it reads `--initial-volume`).

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

Not built: `deactivate`, `available_actions`. An ad (`entity_type: "ad"`) shows as a `track`.

## Unverified

Writes through this connector, and what a live read hasn't shown. In particular:

- **Stalls:** whether the reported position freezes in one (if not, only an overrun is caught), whether `get_state` re-anchors the position, and whether a seek or a pause and play restarts it.
- **Writes:** that each confirming event arrives within 2 s; which events a `play` of an album or playlist sends; `play` of a new URI with no phone around; seek on playback a phone started.
- **The cap in 0.1.2:** on a real start, and whether a real burst is audible before it lands.
- **`activate`:** whether `play(uri)` with no phone around works after it.
- **The rest:** `get_queue` answered by `queue_changed`; `play` with nothing loaded; whole-number volumes; the order of `auth_state` and `playback_state`; the 100% first play and its lowering; Family-plan members picking the speaker; whether the session survives a Soloist restart; a USB speaker's standby dropping it mid-play.

## Live findings

**2026-11-11, Raspberry Pi 5, Bun 1.4.4, on 0.1.3** (chota-bot's session; `maxVolume: 40` watching, writes from the CLI in another process). Two gaps in the cap, not fixed:

- From inactive and paused at 60, `play`: lowered to 40 within 2 ms of going active, `playing` at 40, then 60 again 90 ms after `playing`, and it played at 60. The cap takes its first confirmed lowering as done, so nothing lowered it again, and `anomaly` still said "lowered it". Soloist puts its own level back after `playing`.
- The connector started while the speaker was already active and paused at 60: `play` resumed at 60, nothing lowered it, no anomaly. This is the documented "not on resuming from pause while active".
- A volume set by hand (35) held through pause and play, so the put-back belongs to activation, not to pause.

**2026-11-10, Raspberry Pi 5, Bun 1.4.4, on 0.1.2, through this connector** (chota-bot's session, KO listening).

- Confirmed with `maxVolume: 60`, the speaker active and playing: `activate`, `setVolume(50)`, `setVolume(90)` (came back 60), `seek`, `setShuffle`, `setRepeat("context")` and `("off")` (about 2.1 s each), `queue` (first in `upNext`), `play` of a playlist URI. `duck(fn, { to: 20 })` around a Cast announce: 20 inside, `music: "restored"`, 60 after, 5.2 s in all.
- **The level can jump above the cap on a pause, not only on a start.** One-shot CLI, cap 60: `volume 45` read 45, `play` 45, then `pause` read 62 and the next `play` 62 (62 was the level before the test). Nothing lowered it: a pause is not a start signal, and each CLI command is a new process.
- **That jump did not repeat, and it is not WirePlumber.** A second pass the same day, the speaker already active: 60, `volume 45`, `pause`, `play`, `volume 60`. Soloist's number and the stream's live level (`wpctl get-volume`) matched at every step (0.60, 0.45, 0.45, 0.45, 0.60), WirePlumber 0.5.8 never wrote a saved entry for the stream in `stream-properties`, and the stream kept its id across pause and play. The run that jumped had just been made active with `activate`, minutes after the account was casting from a phone, which points at the account side. One case each way.
- **`active: false` with `status: "playing"`:** the account playing on another speaker. `speakerState` said `playing`, `spotifyText` printed it as this speaker's, and `spotifyChanges` fired `resumed`, with the box silent. Since 2026-11-11 all three read it as `elsewhere`, and the stall watch skips it; not yet seen live.
- Through chota-bot's wrapper, later the same day: `play` of a playlist confirmed in 241 ms, `next` in 134 ms, `pause` in 17 ms; `duck` to 15 and `interrupt`, 2.5 s each, both `restored`. `play()` with the music paused on a Cast speaker: confirmed in 1.3 s, playing on the box at the same position.
- **`interrupt` paused music that was on another speaker** (found in chota's switch): it checked `playing` and not `active`. Fixed after 0.1.2.
- `positionMs` around a duck and an interrupt read 2 s, 2 s, 3 s, 5 s, then 4 s after a pause: it can step back a second.
- A consumer's test with a fake socket: a write goes out behind the connector's own queries (`get_state`, `get_queue`), up to about 1 s on a fresh socket, so "the command was sent" can't be checked straight after the call.
- Not run: the first-play cap from idle (the box never went active), stall events.

**2026-11-09, Raspberry Pi 5, Bun 1.4.4, Soloist 1.3.10.51, PipeWire and WirePlumber 0.5.8, on 0.1.1** (chota-bot's session; writes with KO's OK).

- Confirmed: pause, resume, next, prev, seek, shuffle, repeat to context and track, queue, all under 900 ms. `interrupt` restored the music.
- `set_volume` while inactive: `command_result`, no `volume_changed`, every time. After `activate`, at once. The docs say `command_result` only means accepted.
- **Why the first volume is what it is:** WirePlumber saves each stream's level by role and restores it, and Soloist adopts it (100 and 56 in two runs, each the last level). Config can't force a fixed start: with `restore-props` off, the default volume is skipped too (`state-stream.lua`). So the cap is the way.
- A Music-role stream played at a set level (`pw-play --volume 0.38`) leaves that level saved for Spotify's next stream. `pw-play -P '{ state.restore-props = false }'` avoids it.
- A session survives a Soloist restart: same track, paused, signed in. `deactivate` while already inactive changed nothing visible.
- Setup that works: speaker knob and sink at 100, Spotify's level only through Soloist, other sounds at their own unsaved levels.

**2026-11-09, Raspberry Pi 5, Bun 1.4.4, through this connector** (chota-bot's session, reads only). `home spotify` took 140 ms. In code: connected at 11 ms, second report at 55 ms, 51 MB RSS, a clean exit after abort. Track, volume and `paused` read correctly, with no anomaly. `spotifyChanges` gave nothing on the first report.

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
