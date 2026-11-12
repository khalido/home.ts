# Handover

2026-11-12. Read `AGENTS.md` first, then this.

## Where things stand

- **0.2.2 is live on npm as `latest`** (2026-11-12, approved by KO; a clean install imports `castWav`): Cast and Spotify dry run, WAV speech for Cast. chota told; it will run `home spotify pause --dry-run` on the Pi and send the output.
- **Issues posted 2026-11-12:** [#1](https://github.com/khalido/home.ts/issues/1) Soloist upstream tracking, [#2](https://github.com/khalido/home.ts/issues/2) Spotify account, [#3](https://github.com/khalido/home.ts/issues/3) draw-home. The "untried on a real device" draft is in `drafts/issues.md`, not posted; the Enphase one was dropped (the gateway had moved address).
- **Addresses:** Eero reservations (2026-11-12) for the gateway, Hue bridge, Daikin and printer; `IQ_GATEWAY_HOST` in `~/.zshrc.local` names the reserved address.
- **Releases:** a GitHub release runs `publish.yml`, which stages; KO approves (`docs/publishing.md`, the `release` skill).

## Live on KO's devices (2026-11-11 and 12, Bun 1.4.4)

- **Hue:** paired; reads; light, room and scene writes on two rooms, each put back; dry runs of a room, a scene and all off. `allOff` has not run live.
- **Daikin:** on; dry to cool at 25; dry runs of cool and heat. Untried: off, heat, auto, fan mode, fan speed.
- **Cast:** an announce to a Nest Hub from the Mac; `castFreeSpeakers` read 8 devices and groups, gave one free group, and skipped two TVs plus one device whose model wasn't reported (as `form`). `home cast volume` printed the speaker's line live (2026-11-12); `mute` and `stop` untried.
- **Printers (2026-11-12, Mac):** identify, validate, and two one-page A4 prints on the Brother (one macOS-made raster, one from `home printers print`); KO saw both come out right. Cancel, several pages, and the Pi are untried; the Pi needs `apt install poppler-utils`.
- **Spotify `elsewhere`** and `spotifyElsewhere` are tested on built snapshots only: they need music playing on a phone and on a Cast speaker.

## chota-bot

On Bun on a Pi 5, one long-lived `loadHome`; four chat tools planned: `home_status`, `lights`, `aircon`, `home_connect`. Its six asks of 2026-11-12 are all in 0.2.0 except Cast and Spotify dry run. Pairing from chat: `pairWhenPressed`, then `loadHome` again with the key in `env` and `home.add` the Hue integration (`docs/using.md`). That second `loadHome` keeps its own copy of the address cache; last writer wins.

## Next, each KO's call

1. **Spotify volume: hold the level, not a cap** (proposed 2026-11-10, not agreed). Remember the last level set or reported while steadily playing, and put it back when it moves during a start, a resume or going active. A resume while already active is never capped.
2. **chota's asks for 0.2.3** (2026-11-12, not urgent): (a) duplex PWG Raster: read `pwg-raster-document-sheet-back` (the Brother says `rotated`) and turn the even pages to match, so `two-sided-long-edge` backs aren't upside down; (b) a WAV form of `home cast announce --say` (it sends AAC), to test chota's path. chota will run `home spotify pause --dry-run` on the Pi after upgrading and send the output.
3. **Spotify account** (#2): KO wants playlists and library; it reverses part of the 2026-11-08 call that search lives in chota-bot, so decide that first. Live testing needs KO's sign-in.
4. **Auth leftovers:** an `auth` detail that names the env variable to fix; the `use-home` skill saying to `home.add` again after a re-key.
5. **`fx.yml`:** the gate is who triggers, not whose text is read; put a spend cap on the gateway key. Private: never a public issue.
6. **Printing from a long-running app:** the writes are one-shot calls on an address; put them on the integration with a lane (slot per job) when chota prints.
7. **Small:** `withSpotify` and `withCast` in the CLI are near-copies; no CLI write verb has a test against a fake device; the cast `home … volume` line waits 2 s with no test.

Decided, don't reopen: the four poll loops stay separate; no `build()` on `Manifest`; search lives in chota-bot.

## Waiting on KO

- npm: "Require two-factor authentication and disallow tokens" under Publishing access.
- Four old agent worktrees under `.claude/worktrees/`, clean and merged; keep `pre-squash`.

## To see the current state

`bun run check && bun test`; `home`, `home devices`; `npm pack` and install the tarball into an empty folder to check what ships.
