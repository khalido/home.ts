# Handover

2026-11-08. Read `AGENTS.md` first, then this.

## Where things stand

- **0.1.0 is ready to publish, with the spotify connector in it.** `bun run check` clean, 421 tests (Bun 1.4.4, 2026-11-08). A clean clone passes check, test (bare env, `TZ=UTC`) and build on macOS; the Ubuntu runner is untested until the first push. `bun publish --dry-run` runs `prepublishOnly` (check, test, build) and packs. The packed tarball, installed with no devDependencies, loaded every entry point on Node 24.20, Node 26.11 and Bun (2026-10-28, before spotify: repack and recheck before publishing). `docs/handover.md` and `docs/publishing.md` are not in it.
- **GitHub:** `khalido/home.ts`, **private**, nothing since 28 Oct pushed. KO pushes, flips it public and publishes; until it is public the npm page's links 404.
- **New for consumers since `origin/main`** (`CHANGELOG.md`, `docs/using.md`): `health`, `onChange`, `home.integration(name)`, `settle`; writes on the integration (Hue and Daikin `client`, Cast actions, spotify's writes); `dayBlocks` with `uvIndex`; Amber `forecast` and `bestWindow`; `@khalido/home/node` (`NODE_TLS`); the `spotify` connector.
- **Live, read-only, 2026-10-28:** Amber's forecast and `bestWindow`; weather with blocks and UV. The Enphase gateway refused connections all day. No write has reached a real device except `setPower(true)` on the Daikin at KO's request.

## spotify (Soloist)

`src/connectors/spotify/`: one WebSocket to Spotify Soloist on loopback, state pushed, writes through the lane. Its README has the protocol (checked against Spotify's docs 2026-11-08), what is unverified and the Pi findings.

- **Live on chota's Pi (8 Nov), through `soloist ctl`, not this connector:** signed out is the normal state until a phone picks the speaker; playback a phone started can be paused, resumed and set in volume from the Pi; Soloist and avahi share UDP 5353 fine.
- **The connector has never talked to a real Soloist.** First live check, on the Pi with `SOLOIST_WS=ws://127.0.0.1:9091`: `home spotify` read-only, then each write with KO's say-so. Then the README's Unverified list (seek, the 100% first play and its lowering, the USB speaker's standby).
- `home` lists spotify as not set up unless `SOLOIST_WS` is set; the library and the verbs default to `ws://127.0.0.1:9091`.
- `drafts/soloist/` (git-ignored) holds chota's agent tools and systemd units for reference; delete it once chota switches.

## chota-bot as a consumer

chota-bot runs on Bun, on a Raspberry Pi 5 (Pi OS Lite Trixie arm64, Wi-Fi). Its plan: one long-lived `loadHome` held next to its Telegram and WhatsApp boot, thin agent tools in `agent/tools/home*.ts`. chota installs nothing under 2 days old (`bunfig.toml`), so either wait two days after publishing or test with the packed tarball.

| chota wants | home API | Missing or untried |
| :- | :- | :- |
| Lights, scenes | `integration("hue").client.put`, `recallScene` | Hue not paired; writes return `unknown[]` |
| AC status and set | `part("daikin").state`, `client.write(...)` | 120 s poll; `write` returns `void`; only `setPower` tried live |
| Morning brief | `energyNow`, `bestWindow` | Enphase unreachable since 28 Oct |
| Announce on Nest speakers | `integration("cast").announce` + `serveClip` | never run on a real device; check `serveClip` picks the LAN address, not Tailscale's |
| Music | `integration("spotify")`, `part("spotify").state`, `positionMs`, `interrupt` around `announce` | connector never run against Soloist |
| Print a PDF on the Brother | none | Next item 4 |
| Spend to categorise | `part("up").state`, `setCategory` | writes untried |
| Admin page, alerts | `health()`, `onChange` | an "expected off" option, so a printer off at night isn't `down` |

On the Pi: home's Linux finders need `avahi-utils` (`avahi-browse`); Wi-Fi makes mDNS and Daikin's broadcast lossier, so the address cache matters more. `cast/serve.d.ts` needs `@types/node`. Check Vite's SSR build keeps `@khalido/home` external.

**Out of date about chota** (fix while polishing): `README.md:69`, `docs/using.md:11`, `docs/cast.md:23` and `connectors/cast/README.md:29` say chota runs Node; `connectors/printers/README.md:29` says chota can't reach port 631 from Node; `docs/ideas.md:49` says the bot doesn't import the library.

## Publishing (KO)

`docs/publishing.md` has the research. The scope is `@khalido`: npm needs a user or an org named `khalido` to own it.

1. `git push`, then flip `khalido/home.ts` public. `check.yml` runs for the first time on that push.
2. fx: add `AI_GATEWAY_API_KEY` and allow Actions to create PRs, or disable `fx.yml`.
3. `bunx npm login`, then `bun publish` (`prepublishOnly` runs check, test and build). No provenance that way; trusted publishing from Actions is the later plan.
4. Tell chota-bot the version is out.

## Waiting on KO

- Hue pairing (`home pair`, `.env`, `HUE_CA_FILE`, then `home hue` read-only).
- Enphase: why the gateway refuses connections (`home discover`), then one read on Node with `NODE_TLS`.
- First writes, each with KO's say-so: Up categorise, Daikin presets, a Hue burst, spotify on the Pi.
- Four old agent worktrees under `.claude/worktrees/`, all clean, branches already merged: `git worktree remove` and `git branch -D`; keep `pre-squash`.

## Next, in order

1. **Left from Gemini's second pass** (not bugs, or KO's call): Google-only weather goes `disconnected` when only the minute forecast failed; printers off at night go `down`; `createHome`'s clock is the third argument; `MANIFESTS` not exported; Hue `put` returns `unknown[]`; CI runs Bun only; `loadHome`'s Node `tls` check has no test.
2. **Writes that return the resulting state** (jaldi, chota): a write resolves with the state it left. What chota's agent tools need most.
3. **Transport NSW** stays in chota (it has `tools/bus.ts`) unless another consumer wants it.
4. **Printers: print a PDF on the Brother** over IPP Print-Job, through the write lane: first a live read, then Identify-Printer, then Print-Job, each with KO's say-so.
5. **Weather, more**: BOM warnings; Google's hourly as a second source. Compare with chota's own weather tool before chota moves onto home's.
6. **Leftovers**: TS 5.6 and older fail on `Uint8Array<…>` in `printers/codec.d.ts` with `skipLibCheck: false`; `cast/serve.d.ts` names `NodeJS.Dict`; `exports.test.ts` imports `src`, not `dist`; the env path (`FROM_ENV`) and `loadHome` build integrations two ways.

## To see the current state

`bun run check && bun test`; `home`, `home amber`; `npm pack` and install the tarball into an empty folder to check what ships.
