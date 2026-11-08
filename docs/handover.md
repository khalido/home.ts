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

0. **0.1.2, the first-play cap (not built; KO: not yet).** Live on 0.1.1 (chota-bot, Pi, 2026-11-09) the cap said "lowered it" while the volume stayed at 56: `applyCap` writes `capNote` and sets `capped` before the write, and only a throw counts as failure. Likely Soloist dropped a `set_volume` sent while inactive; run 1, sent after `device_changed` active, worked. Build: say "lowered" only once confirmed, else `detail`; retry within the window, including on going active; open the window on any start signal (event order varies between runs); a tolerance of 1 when confirming a volume (reports are rounded); hold the `track` event until it has a name. README: the first volume is likely WirePlumber's saved level, with no config-only fix (restore off skips the default too; WirePlumber 0.5.8 source); a Music-role stream at a set level changes later Spotify loudness; a phone press can fire track, resumed, stopped, started, track over 3 s and a 0.8 s sign-out; volume before activation isn't the real level. Then chota-bot's `activate` test, re-run first-play at full volume.
   0a. **chota-bot's other live writes on the Pi** (the list is in its handover; reads all passed 2026-11-09): announce, a group, volume, mute, stop, each with KO's OK.
1. **From Gemini's second pass** (not bugs, or KO's call): Google-only weather goes `disconnected` when only the minute forecast failed; printers off at night go `down`; `createHome`'s clock is its third argument; `MANIFESTS` not exported; CI runs Bun only; `loadHome`'s Node `tls` check has no test.
2. **Writes that return the resulting state for Hue and Daikin**, in spotify's shape (`{ state, confirmed }`).
3. **Printers: print a PDF on the Brother** over IPP Print-Job, through the lane: a live read, Identify-Printer, then Print-Job, each with KO's say-so.
4. **Weather**: BOM warnings; Google's hourly as a second source; compare with chota's weather tool first.
5. **Leftovers**: TS 5.6 and older fail on `Uint8Array<…>` in `printers/codec.d.ts` with `skipLibCheck: false`; `exports.test.ts` imports `src`, not `dist`; `FROM_ENV` and `loadHome` build integrations two ways; `withSpotify` and `withCast` in the CLI are near-copies (two, under the rule of three).
6. **A docs site** later: GitHub Pages from an Actions build (not a `gh-pages` branch or a committed folder), serving `llms.txt`.

After live tests: spotify's socket flags as one `phase` union with a pure `next()` (chota-bot's idea; its `whatsapp-conn.ts` is a small example); `repairedFor` never clears, so a track stalls-and-repairs once per run; a Cast `play(target, url)` for streams. For a 0.2.0: writes in one shape across connectors, Up's client exposed, Cast's volume 0–1 against spotify's 0–100.

## To see the current state

`bun run check && bun test`; `home`, `home amber`; `npm pack` and install the tarball into an empty folder to check what ships.
