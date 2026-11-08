# Handover

2026-11-08. Read `AGENTS.md` first, then this.

## Where things stand

- **0.1.0 is ready to publish.** `bun run check` clean, 451 tests (Bun 1.4.4, 2026-11-08). A clean clone passed check, test (bare env, `TZ=UTC`) and build on macOS (Oct); the Ubuntu runner is untested until the first push. `bun publish --dry-run` runs `prepublishOnly` (check, test, build) and packs: access public, tag latest. KO is logged in (`bunx npm login`, the `khalido` account owns the scope). Repacked 8 Nov: installed with no devDependencies, every entry point checked earlier (Node 24.20, 26.11, Bun, 28 Oct) and the spotify one now on Node 26.11.1 and Bun 1.4.4. `docs/handover.md` and `docs/publishing.md` are not in it; `llms.txt` is.
- **GitHub:** `khalido/home.ts`, **private**, nothing since 28 Oct pushed, so GitHub still shows the old README with its mermaid map; the local README dropped it. KO pushes, flips it public, publishes; until it is public the npm page's links and `llms.txt`'s 404.
- **New since `origin/main`** (`CHANGELOG.md`, `docs/using.md`): `health`, `onChange`, `home.integration(name)`, `settle`; writes on the integration; `dayBlocks` with `uvIndex`; Amber `forecast` and `bestWindow`; `@khalido/home/node`; the `spotify` connector.
- **Live:** Amber and weather read 2026-10-28; the Enphase gateway refused connections. No write has reached a device except `setPower(true)` on the Daikin at KO's request.

## spotify (Soloist)

Built 8 Nov in three groups agreed with chota-bot, each reviewed (`/ko-review`, plus Gemini and a Sonnet pass on group 1): confirmed writes (`{ state, confirmed }`), `duck` and `interrupt` (`{ value, music, why? }`), `upNext`, `setRepeat`, `speakerState`, `spotifyChanges` with `own` marking, and the stall watch (issue #5) with opt-in `repairStalls`. The connector README has all of it, the protocol and the Unverified list. Pure helpers are in `changes.ts`; the integration's closure stays whole in `index.ts`, since its parts share one state.

- **Never run against a real Soloist.** chota's Pi ran Soloist through `soloist ctl` only. First live check, on the Pi with `SOLOIST_WS=ws://127.0.0.1:9091`: `home spotify` read-only, then each write with KO's say-so (KO listens on it; don't write while he is).
- **Search lives in chota-bot** (KO, 8 Nov); the library stays device control. Research in `docs/ideas.md`.
- `drafts/soloist/` (git-ignored) is chota's old client and units: delete once chota switches.

## chota-bot as a consumer

On Bun on a Raspberry Pi 5 (Pi OS Lite Trixie arm64, Wi-Fi), one long-lived `loadHome`, thin agent tools. Its 2-day install wait is off, so it can take 0.1.0 as soon as it's out.

| chota wants | home API | Missing or untried |
| :- | :- | :- |
| Lights, scenes | `integration("hue").client.put`, `recallScene` | Hue not paired; writes return `unknown[]` |
| AC status and set | `part("daikin").state`, `client.write(...)` | 120 s poll; `write` returns `void`; only `setPower` tried live |
| Morning brief | `energyNow`, `bestWindow` | Enphase unreachable since 28 Oct |
| Announce on Nest speakers | `integration("cast").announce` + `serveClip` | never run on a device; check `serveClip` picks the LAN address, not Tailscale's |
| Music | `integration("spotify")`, `speakerState`, `spotifyChanges`, `duck` around `announce` | never run against Soloist |
| Print a PDF on the Brother | none | Next item 3 |
| Spend to categorise | `part("up").state`, `setCategory` | writes untried |
| Admin page, alerts | `health()`, `onChange` | an "expected off" option, so a printer off at night isn't `down` |

On the Pi: home's Linux finders need `avahi-utils`; Wi-Fi makes mDNS lossier, so the address cache matters more. `cast/serve.d.ts` needs `@types/node`. Check Vite's SSR build keeps `@khalido/home` external.

## Publishing (KO)

1. `git push`, then flip `khalido/home.ts` public. `check.yml` runs for the first time.
2. fx: add `AI_GATEWAY_API_KEY` and allow Actions to create PRs, or disable `fx.yml`.
3. `bun publish` (logged in already; `--auth-type legacy` for a terminal OTP prompt). No provenance; trusted publishing from Actions later (`docs/publishing.md`).
4. Tell chota-bot the version is out.

## Waiting on KO

- Hue pairing (`home pair`, `.env`, `HUE_CA_FILE`, then `home hue`).
- Enphase: why the gateway refuses connections (`home discover`), then a read on Node with `NODE_TLS`.
- First writes, each with KO's say-so: Up categorise, Daikin presets, a Hue burst, spotify on the Pi.
- Four old agent worktrees under `.claude/worktrees/`, clean and merged: `git worktree remove`, `git branch -D`; keep `pre-squash`.

## Next, in order

1. **From Gemini's second pass** (not bugs, or KO's call): Google-only weather goes `disconnected` when only the minute forecast failed; printers off at night go `down`; `createHome`'s clock is its third argument; `MANIFESTS` not exported; CI runs Bun only; `loadHome`'s Node `tls` check has no test.
2. **Writes that return the resulting state for Hue and Daikin**, in spotify's shape (`{ state, confirmed }`).
3. **Printers: print a PDF on the Brother** over IPP Print-Job, through the lane: a live read, Identify-Printer, then Print-Job, each with KO's say-so.
4. **Weather**: BOM warnings; Google's hourly as a second source; compare with chota's weather tool first.
5. **Leftovers**: TS 5.6 and older fail on `Uint8Array<…>` in `printers/codec.d.ts` with `skipLibCheck: false`; `cast/serve.d.ts` names `NodeJS.Dict`; `exports.test.ts` imports `src`, not `dist`; `FROM_ENV` and `loadHome` build integrations two ways; `withSpotify` and `withCast` in the CLI are near-copies (two, under the rule of three).
6. **A docs site** later: GitHub Pages from an Actions build (not a `gh-pages` branch or a committed folder), serving `llms.txt`.

## To see the current state

`bun run check && bun test`; `home`, `home amber`; `npm pack` and install the tarball into an empty folder to check what ships.
