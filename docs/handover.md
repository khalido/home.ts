# Handover

2026-11-12. Read `AGENTS.md` first, then this.

## Where things stand

- **0.2.0 is live on npm as `latest`** (2026-11-12, approved by KO). A clean `bun add @khalido/home@0.2.0 --no-cache` imported on Bun 1.4.4. chota-bot has been sent the release note (queued in its session, not confirmed read).
- **What 0.2.0 has:** `CHANGELOG.md`. In short: Hue by name (lights, rooms, scenes, `allOff`, colour, kelvin) with Signify's roots bundled and `pairWhenPressed`; Daikin `power` and `mode` (cool 25, heat 27); dry run on Hue and Daikin writes; `home.add` and `home.remove`; `byRoom` and `photos`; `castFreeSpeakers` and `castFree` `forms`; Spotify `elsewhere` and `spotifyElsewhere`; `home devices`.
- **Releases:** a GitHub release runs `publish.yml`, which stages; KO approves (`docs/publishing.md`, the `release` skill). Worked for 0.1.1 to 0.2.0.
- **jaldi** has been told nothing since 0.1.0 (no session open there).

## Live on KO's devices (2026-11-11 and 12, Bun 1.4.4)

- **Hue:** paired; reads; light, room and scene writes on two rooms, each put back; dry runs of a room, a scene and all off. `allOff` has not run live.
- **Daikin:** on; dry to cool at 25; dry runs of cool and heat. Untried: off, heat, auto, fan mode, fan speed.
- **Cast:** an announce to a Nest Hub from the Mac; `castFreeSpeakers` read 8 devices and groups, gave one free group, and skipped two TVs plus one device whose model wasn't reported (as `form`). `home cast volume | mute | stop` printing the line is untried.
- **Spotify `elsewhere`** and `spotifyElsewhere` are tested on built snapshots only: they need music playing on a phone and on a Cast speaker.

## chota-bot

On Bun on a Pi 5, one long-lived `loadHome`; four chat tools planned: `home_status`, `lights`, `aircon`, `home_connect`. Its six asks of 2026-11-12 are all in 0.2.0 except Cast and Spotify dry run. Pairing from chat: `pairWhenPressed`, then `loadHome` again with the key in `env` and `home.add` the Hue integration (`docs/using.md`). That second `loadHome` keeps its own copy of the address cache; last writer wins.

## Next, each KO's call

1. **Spotify volume: hold the level, not a cap** (proposed 2026-11-10, not agreed). Remember the last level set or reported while steadily playing, and put it back when it moves during a start, a resume or going active. The two gaps chota found live: Soloist restores its own level 90 ms after `playing`, after the cap's lowering confirmed (and `anomaly` still says "lowered it"); a resume while already active is never capped.
2. **Dry run on Cast and Spotify writes**, so chota's announce tool can be tested without a sound.
3. **`draw-home` from a walkthrough video**: a skill change; try it on a real video first.
4. **Auth consistency:** one 401-or-403 check in `connector.ts` (Hue and Google take either; Enphase, Amber and Up 401 only). `home pair` prints the key to stdout.
5. **`fx.yml`:** the gate is who triggers, not whose text is read; put a spend cap on the gateway key.
6. **Printers:** print a PDF on the Brother over IPP, with KO's say-so.
7. **Small:** `withSpotify` and `withCast` in the CLI are near-copies; no CLI write verb has a test against a fake device; the cast `home … volume` line waits 2 s with no test.

Decided, don't reopen: the four poll loops stay separate; no `build()` on `Manifest`; search lives in chota-bot.

## Waiting on KO

- Enphase: why the gateway refuses connections (since 28 Oct).
- npm: "Require two-factor authentication and disallow tokens" under Publishing access.
- Four old agent worktrees under `.claude/worktrees/`, clean and merged; keep `pre-squash`.

## To see the current state

`bun run check && bun test`; `home`, `home devices`; `npm pack` and install the tarball into an empty folder to check what ships.
