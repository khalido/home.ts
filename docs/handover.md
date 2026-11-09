# Handover

2026-11-09. Read `AGENTS.md` first, then this.

## Where things stand

- **0.1.1 is on npm** (2026-11-09), with provenance. A clean `bun add @khalido/home` imports on Bun 1.4.4 and Node 26.11.1 and gives the `home` command. `khalido/home.ts` is public.
- **Releases stage:** a GitHub release runs `publish.yml`, KO approves with 2FA (`docs/publishing.md`, the `release` skill). It worked first time on 0.1.1.
- **Live:** Amber and weather read 2026-10-28; the Enphase gateway refused connections. No write has reached a device except `setPower(true)` on the Daikin at KO's request.

## spotify (Soloist)

Built 8 Nov in three groups agreed with chota-bot, each reviewed (`/ko-review`, plus Gemini and a Sonnet pass on group 1): confirmed writes (`{ state, confirmed }`), `duck` and `interrupt` (`{ value, music, why? }`), `upNext`, `setRepeat`, `speakerState`, `spotifyChanges` with `own` marking, and the stall watch (issue #5) with opt-in `repairStalls`. The connector README has all of it, the protocol and the Unverified list. Pure helpers are in `changes.ts`; the integration's closure stays whole in `index.ts`, since its parts share one state.

- **Reads seen live** on chota's Pi, 2026-11-09. No write has run through the connector: each with KO's say-so (KO listens on it; don't write while he is).
- **Search lives in chota-bot** (KO, 8 Nov); the library stays device control. Research in `docs/ideas.md`.
- `drafts/soloist/` (git-ignored) is chota's old client and units: delete once chota switches.

## chota-bot as a consumer

On Bun on a Raspberry Pi 5 (Pi OS Lite Trixie arm64, Wi-Fi), one long-lived `loadHome`, thin agent tools. Its 2-day install wait is off, so it can take 0.1.0 as soon as it's out.

| chota wants                | home API                                                                             | Missing or untried                                                              |
| :------------------------- | :----------------------------------------------------------------------------------- | :------------------------------------------------------------------------------ |
| Lights, scenes             | `integration("hue").client.put`, `recallScene`                                       | Hue not paired; writes return `unknown[]`                                       |
| AC status and set          | `part("daikin").state`, `client.write(...)`                                          | 120 s poll; `write` returns `void`; only `setPower` tried live                  |
| Morning brief              | `energyNow`, `bestWindow`                                                            | Enphase unreachable since 28 Oct                                                |
| Announce on Nest speakers  | `integration("cast").announce` + `serveClip`                                         | never run on a device; check `serveClip` picks the LAN address, not Tailscale's |
| Music                      | `integration("spotify")`, `speakerState`, `spotifyChanges`, `duck` around `announce` | reads live; writes untried                                                      |
| Print a PDF on the Brother | none                                                                                 | Next item 3                                                                     |
| Spend to categorise        | `part("up").state`, `setCategory`                                                    | writes untried                                                                  |
| Admin page, alerts         | `health()`, `onChange`                                                               | an "expected off" option, so a printer off at night isn't `down`                |

On the Pi: home's Linux finders need `avahi-utils`; Wi-Fi makes mDNS lossier, so the address cache matters more. Check Vite's SSR build keeps `@khalido/home` external.

## Waiting on KO

- Hue pairing (`home pair`, `.env`, `HUE_CA_FILE`, then `home hue`).
- Enphase: why the gateway refuses connections (`home discover`), then a read on Node with `NODE_TLS`.
- First writes, each with KO's say-so: Up categorise, Daikin presets, a Hue burst, spotify on the Pi.
- Package Settings → Publishing access → "Require two-factor authentication and disallow tokens", now a release has gone through.
- jaldi hasn't been told 0.1.0 or 0.1.1 are out: no session is open there.
- Four old agent worktrees under `.claude/worktrees/`, clean and merged: `git worktree remove`, `git branch -D`; keep `pre-squash`.

## Next, in order

0. **0.1.2: chota-bot's wishlist (not built; waiting on KO).** Group A blocks chota switching to home.
   - **A, spotify on the Pi (0.1.1, 2026-11-09).** Soloist drops `set_volume` while inactive (three times) and takes it at once after `activate`. (1) Apply `maxVolume` once `device_changed` reports active, retrying within the window; open the window on any start signal, since event order varies. (2) `applyCap` writes `capNote` and sets `capped` before the write and only a throw counts as failure: say "lowered" only once confirmed, else `detail`. (3) Add `activate()`; `setVolume` and `duck` activate first or refuse with an `inactive` code. `activate` makes a new stream, so the level can jump to WirePlumber's saved one (62 to 40). (4) `setRepeat("off")` from `track` stays on `track`; raw commands 600 ms apart work, ours go back to back. (5) `play()` with no URI from paused and inactive doesn't take; `resume` does.
   - **B, Cast.** (6) 24 kHz mono WAV failed on both audio-only Nest speakers, played on displays; MP3 played on all four: say so in `docs/cast.md`. (7) "the clip stopped: ERROR" took 35-44 s: fail in about 10 s with the receiver's reason. (8) `home cast announce` exits 0 when not played. (9) Several targets, one result each. (10) Device kinds: speaker, display, tv, group.
   - **C, spotify events.** (11) One phone press fires track, resumed, stopped, started, track in 3 s, sometimes a `waiting` blip: a note or a settle window. (12) The first `track` has no name: hold it. (13) `volume` isn't real until active. (14) Confirm volumes with a tolerance of 1: reports are rounded.
   - **D, spotify README.** (15) A Music-role stream at a set level (`pw-play --volume`) is saved for Spotify's next stream; `-P '{ state.restore-props = false }'` avoids it. (16) WirePlumber restores `channelVolumes`, so the first play comes in at the last level, and config alone can't force a start level (restore off skips the default too; 0.5.8 source). (17) `available_actions` when a consumer needs it.
   - **Then chota's live tests:** `duck` around an announce, announce over playback, to a group, `home cast volume`, `mute`, `stop`. Open: one speaker read 50 before a failed announce and 56 after; check the restore after a failure.
1. **From Gemini's second pass** (not bugs, or KO's call): Google-only weather goes `disconnected` when only the minute forecast failed; printers off at night go `down`; `createHome`'s clock is its third argument; `MANIFESTS` not exported; CI runs Bun only; `loadHome`'s Node `tls` check has no test.
2. **Writes that return the resulting state for Hue and Daikin**, in spotify's shape (`{ state, confirmed }`).
3. **Printers: print a PDF on the Brother** over IPP Print-Job, through the lane: a live read, Identify-Printer, then Print-Job, each with KO's say-so.
4. **Weather**: BOM warnings; Google's hourly as a second source; compare with chota's weather tool first.
5. **Leftovers**: TS 5.6 and older fail on `Uint8Array<…>` in `printers/codec.d.ts` with `skipLibCheck: false`; `exports.test.ts` imports `src`, not `dist`; `FROM_ENV` and `loadHome` build integrations two ways; `withSpotify` and `withCast` in the CLI are near-copies (two, under the rule of three).
6. **A docs site** later: GitHub Pages from an Actions build (not a `gh-pages` branch or a committed folder), serving `llms.txt`.

After live tests: spotify's socket flags as one `phase` union with a pure `next()` (chota-bot's idea; its `whatsapp-conn.ts` is a small example); `repairedFor` never clears, so a track stalls-and-repairs once per run; a Cast `play(target, url)` for streams. For a 0.2.0: writes in one shape across connectors, Up's client exposed, Cast's volume 0–1 against spotify's 0–100.

## To see the current state

`bun run check && bun test`; `home`, `home amber`; `npm pack` and install the tarball into an empty folder to check what ships.
