# Handover

2026-10-28. Read `AGENTS.md` first, then this.

## Where things stand

- **0.1.0 is ready to publish.** Since `origin/main`: the write lane, the README, dependencies, then this session's work (`f27f67c` onwards), reviewed by `/ko-review` and twice by Gemini. `bun run check` clean, 382 tests (Bun 1.4.4, 2026-10-28). A clean clone passes check, test (bare env, `TZ=UTC`) and build on macOS; the Ubuntu runner is untested until the first push. `bun publish --dry-run` runs `prepublishOnly` (check, test, build) and packs. The tarball, installed with no devDependencies, loads all 14 entry points on Node 24.20, Node 26.11 and Bun, reads the weather live, and type-checks a strict consumer with `skipLibCheck: false`. `docs/handover.md` and `docs/publishing.md` are not in it.
- **GitHub:** `khalido/home.ts`, **private**. Nothing from this session is pushed. KO pushes, flips it public and publishes; until it is public the npm page's links 404.
- **New for consumers** (`CHANGELOG.md`, `docs/using.md`):
  - `health(snapshot, now)` from times `createHome` stamps (`lastGoodAt`, `downSince`); `onChange(snapshot, { name, before, after })`; `home.integration(name)`; `settle`.
  - Writes on the integration: Hue and Daikin `client`, Cast its actions. One client for life with `host` a getter on the relocator, so a move keeps the lane and its waiting writes.
  - `dayBlocks(..., blocks)` and `weather({ blocks })`; each block has `uvIndex` and `late`.
  - Amber `forecast` (`next=96`, about 8 hours) and `bestWindow`.
  - `@khalido/home/node`: `NODE_TLS` for `loadHome({ tls })`, built on undici (a dependency).
- **Behaviour changes:** Hue `ip` is `host`. A Daikin 404 is `disconnected` and rediscovers. Weather is `connected` only while a read brought something new, and its re-reports keep the last read's `lastGoodAt`. `refresh()` answers rather than waiting out a backoff or a billed source's floor. A move is reported by the read at the new address. Under Node, `loadHome` names a missing `tls`. Error details carry the cause. `settle` and `health` take options objects.
- **Live, read-only, 2026-10-28:** Amber's forecast and `bestWindow`; weather with blocks and UV. The Enphase gateway refused connections from Bun and Node all day (ECONNREFUSED), so `nodeGatewayFetch` is checked only against a local self-signed server. `nodePinnedFetch` is checked against a local TLS server, not a real bridge.
- No write has reached a real device except `setPower(true)` on the Daikin at KO's request.

## Publishing (KO)

1. `git push`, then flip `khalido/home.ts` public. `check.yml` runs for the first time on that push; it has only run locally.
2. fx: add `AI_GATEWAY_API_KEY` and allow Actions to create PRs, or disable `fx.yml`.
3. `bunx npm login`, then `bun publish` (or `npm publish`; `prepublishOnly` runs check, test and build). `bun publish` gives no provenance; trusted publishing from Actions is the later plan in `docs/publishing.md`.
4. Tell chota-bot the version is out. Its npm config installs nothing under 2 days old, so for testing now it has the packed tarball (below).

## Waiting on KO

- **Hue pairing**: `home pair`, three lines in `.env`, `HUE_CA_FILE`, then `home hue` read-only. On Node, `nodePinnedFetch` then gets its first real bridge.
- **Enphase**: find why the gateway refuses connections (address moved? `home discover`), then one read on Node with `NODE_TLS`.
- **First writes** each need KO's say-so: Up categorise, Daikin presets, a Hue burst to see one merged send.
- **Old agent worktrees**: four under `.claude/worktrees/`, all clean, branches already in `pre-squash` or `main`. Remove with `git worktree remove` and `git branch -D` (the loop was in the previous handover); keep `pre-squash`.
- Matter (a first device), fans (Tuya local key), as before.

## Next, in order

1. **Left from Gemini's second pass** (not bugs, or KO's call):
   - Google-only weather goes `disconnected` for a poll whose only read (the minute forecast) failed.
   - Every printer off at night makes printers `down` after 3 polls; chota-bot was told.
   - `createHome(integrations, onChange?, { clock })` takes the clock third, so a clock with no `onChange` needs `undefined` in the middle.
   - `MANIFESTS` is not exported (KO's 2026-10-16 call).
   - Hue `put` returns `unknown[]`; a write that returns state will change it.
   - CI runs Bun only, not `dist` under Node.
   - The Node `tls` problem in `loadHome` is checked by hand under Node, with no test (tests run in Bun).
2. **Writes that return the resulting state** (jaldi, chota): a write resolves with the state it left, and a slot held to its rate shows in `anomaly`.
3. **Transport NSW** departures for chota (`docs/ideas.md` item 2): a stop, routes, realtime against scheduled, minutes away.
4. **Printers**: Print-Job behind chota's approval step (the TODO in `printers/client.ts`), after a first live read; `home` with no printer still takes 1.5 s longer (`dns-sd` buffering).
5. **Weather, more**: BOM warnings; Google's hourly as a second `hourly` source.
6. **Leftovers**:
   - TS 5.6 and older fail on `Uint8Array<…>` in `dist/connectors/printers/codec.d.ts`, but only with `skipLibCheck: false`.
   - `cast/serve.d.ts` names `NodeJS.Dict`.
   - `exports.test.ts` imports `src`, not `dist`.
   - `MANIFESTS` is not exported, so there is no one-call `partLines(name, part)`.
   - The env path (`FROM_ENV`) and `loadHome` still build integrations two ways.

## To see the current state

`bun run check && bun test`; `home`, `HOME_LATITUDE=-33.87 HOME_LONGITUDE=151.21 HOME_TIMEZONE=Australia/Sydney home weather`, `home amber`; `npm pack` and install the tarball into an empty folder to check what ships.
