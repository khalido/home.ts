# Handover

2026-11-09. Read `AGENTS.md` first, then this.

## Where things stand

- **0.1.2 is on npm** (2026-11-09), with provenance. A clean `bun add @khalido/home` imports on Bun 1.4.4 and Node 26.11.1 and gives the `home` command. `khalido/home.ts` is public.
- **Unreleased, for 0.1.3:** OpenCode's review (`createHome` failure handling, `home <connector> --config` needing only that connector, `realClock.sleep`), in `CHANGELOG.md`. Release it with what chota's live tests turn up.
- **Releases stage:** a GitHub release runs `publish.yml`, KO approves with 2FA (`docs/publishing.md`, the `release` skill). It has worked for 0.1.1 and 0.1.2.
- **Live:** Amber and weather read 2026-10-28; the Enphase gateway refused connections. Writes that have reached a device: `setPower(true)` on the Daikin; spotify's and Cast's announce (0.1.1, chota-bot's Pi, 2026-11-09; the connector READMEs have the results).

## spotify (Soloist)

Built 8 Nov in three groups agreed with chota-bot, each reviewed (`/ko-review`, plus Gemini and a Sonnet pass on group 1): confirmed writes (`{ state, confirmed }`), `duck` and `interrupt` (`{ value, music, why? }`), `upNext`, `setRepeat`, `speakerState`, `spotifyChanges` with `own` marking, and the stall watch (issue #5) with opt-in `repairStalls`. The connector README has all of it, the protocol and the Unverified list. Pure helpers are in `changes.ts`; the integration's closure stays whole in `index.ts`, since its parts share one state.

- **Seen live** on chota's Pi, 2026-11-09: reads, and most writes on 0.1.1. KO listens on it: writes only with his OK, not while he is. What 0.1.2 changed is untried on Soloist.
- **Search lives in chota-bot** (KO, 8 Nov); the library stays device control. Research in `docs/ideas.md`.
- `drafts/soloist/` (git-ignored) is chota's old client and units: delete once chota switches.

## chota-bot as a consumer

On Bun on a Raspberry Pi 5 (Pi OS Lite Trixie arm64, Wi-Fi), one long-lived `loadHome`, thin agent tools. Its 2-day install wait is off, so it can take 0.1.0 as soon as it's out.

| chota wants                | home API                                                                                         | Missing or untried                                                    |
| :------------------------- | :----------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------- |
| Lights, scenes             | `integration("hue").client.put`, `recallScene`                                                   | Hue not paired; writes return `unknown[]`                             |
| AC status and set          | `part("daikin").state`, `client.write(...)`                                                      | 120 s poll; `write` returns `void`; only `setPower` tried live        |
| Morning brief              | `energyNow`, `bestWindow`                                                                        | Enphase unreachable since 28 Oct                                      |
| Announce on Nest speakers  | `integration("cast").announce`, `announceAll` + `serveClip`                                      | played live on four devices (MP3); groups and over playback untried   |
| Music                      | `integration("spotify")`, `activate`, `speakerState`, `spotifyChanges`, `duck` around `announce` | most writes live; 0.1.2's cap and `activate` then `play(uri)` untried |
| Print a PDF on the Brother | none                                                                                             | Next item 3                                                           |
| Spend to categorise        | `integration("up").client`, `setCategory`                                                        | writes untried                                                        |
| Admin page, alerts         | `health()`, `onChange`                                                                           | an "expected off" option, so a printer off at night isn't `down`      |

On the Pi: home's Linux finders need `avahi-utils`; Wi-Fi makes mDNS lossier, so the address cache matters more. Check Vite's SSR build keeps `@khalido/home` external.

## Waiting on KO

- Hue pairing (`home pair`, `.env`, `HUE_CA_FILE`, then `home hue`).
- Enphase: why the gateway refuses connections (`home discover`), then a read on Node with `NODE_TLS`.
- First writes, each with KO's say-so: Up categorise, Daikin presets, a Hue burst.
- Package Settings → Publishing access → "Require two-factor authentication and disallow tokens", now a release has gone through.
- jaldi hasn't been told 0.1.0 or 0.1.1 are out: no session is open there.
- Four old agent worktrees under `.claude/worktrees/`, clean and merged: `git worktree remove`, `git branch -D`; keep `pre-squash`.

## Next, in order

0. **chota-bot's live tests of 0.1.2** (it has the list; results come back here for the READMEs): the first-play cap at full volume, `activate` then `play(uri)` with no phone open, `setRepeat("off")`, `duck` around an announce, announce over playback, to a group, `announceAll`, `home cast volume`, `mute`, `stop`. Each with KO's OK. Open: one speaker read 50 before a failed announce and 56 after; the restore path is the same as a played clip's, and KO was editing the group then. Not built on purpose: a settle window for events, `available_actions`. 0.1.2's inactive refusal is by the release skill's rule a minor; KO kept the patch number.

1. **From Gemini's second pass** (not bugs, or KO's call): Google-only weather goes `disconnected` when only the minute forecast failed; printers off at night go `down`; `createHome`'s clock is its third argument; `MANIFESTS` not exported; CI runs Bun only; `loadHome`'s Node `tls` check has no test.
2. **Writes that return the resulting state for Hue and Daikin**, in spotify's shape (`{ state, confirmed }`).
3. **Printers: print a PDF on the Brother** over IPP Print-Job, through the lane: a live read, Identify-Printer, then Print-Job, each with KO's say-so.
4. **Weather**: BOM warnings; Google's hourly as a second source; compare with chota's weather tool first.
5. **Leftovers**: TS 5.6 and older fail on `Uint8Array<…>` in `printers/codec.d.ts` with `skipLibCheck: false`; `exports.test.ts` imports `src`, not `dist`; `FROM_ENV` and `loadHome` build integrations two ways; `withSpotify` and `withCast` in the CLI are near-copies (two, under the rule of three).
6. **A docs site** later: GitHub Pages from an Actions build (not a `gh-pages` branch or a committed folder), serving `llms.txt`.

Later: a Cast `play(target, url)` for streams. For a 0.2.0: a machine-readable reason on `Part`, so an admin page needn't match `detail`; writes in one shape across connectors, Cast's volume 0–1 against spotify's 0–100. Open: going active uses the volume reported while inactive, which isn't always the real level; the cap only ever lowers to the cap, so the worst case is a raise to it.

## To see the current state

`bun run check && bun test`; `home`, `home amber`; `npm pack` and install the tarball into an empty folder to check what ships.
