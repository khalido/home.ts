# Handover

2026-11-10. Read `AGENTS.md` first, then this.

## The big-picture review is done (Fable 5.2, 2026-11-10)

Four read-only subagent tracks plus my own reads, each checked against the code. No device was written to.

**Direction.** Right library, but ahead of its consumers: no source file in jaldi or chota-bot imported it on 2026-11-10. chota-bot is now integrating it (KO, 2026-11-10), which is the work that matters most. New surface waits until chota is on it.

**Decided, don't reopen:**

- The four poll loops (Daikin, Amber, Up, Enphase) stay separate. The shared part is about 12 lines each and a helper nets about zero lines once it carries the relocator, auth and Enphase's extras. Weather and printers are a different shape. Revisit if a fifth single-device poller appears.
- No `build()` on `Manifest`. It loses the typed snapshot (`Integration<State, "name">`), three of nine connectors don't fit one device to one integration, and it can't replace `FROM_ENV`, which reads env and files. `loadHome` and `FROM_ENV` are two input modes; `envFromConfig` builds nothing (it feeds `probe`).
- The doc set (about 2,200 lines) is a fair size.

**To do, in order. KO has not agreed these yet:**

1. **Auth consistency.** One `isAuthStatus` (401 or 403) in `connector.ts`: Hue and now Google take either, Enphase, Amber and Up take 401 only. One wording for the detail, naming the env var. Say in `docs/using.md` and `use-home` that `auth` is terminal: a re-key needs the consumer restarted (`refresh()` can't revive a `run` that returned). `home pair` prints the Hue key to stdout (`cli/hue.ts:120`), against the rule here: write it privately or note the exception.
2. **`fx.yml`.** The gate is who triggers, not whose text is read: `/fx` from KO on a stranger's issue puts their text in front of a shell that can read the gateway key (the action's own `SECURITY.md`). Put a spend cap on the key; consider `mode: answer` with `contents: read`.
3. **Doc drift.** `AGENTS.md` says "going public"; the README says jaldi and chota-bot use it; `cast/README.md:3` and `docs/cast.md:106` say writes ran only on a fake socket (they played live 2026-11-09); `spotify/README.md` lines 3, 61 and 80 disagree on live writes; `decisions.md:94` says the manifest drives the README table (it is hand-written).
4. **Small code tidy:** one `withRunning(i, ms, act)` in `cli/context.ts` for `withSpotify`, `withCast` and the coming printers verb; infer `HomeIntegration` from a lifted `buildDevice` switch; a test that `FROM_ENV`'s keys equal the `MANIFESTS` names; tests for Up's `createWebhook`, `deleteWebhook`, `pingWebhook` (none today); no CLI write verb has a test.

**Unverified:** a bridge whose certificate fails validation (a self-signed one, a wrong `ca` override) retrying forever as `disconnected`.

**Untried on a device, for chota's tests:** Daikin off, heat, auto, fan mode and fan speed (on, and dry to cool at 25, worked 2026-11-11); Cast `setVolume`, `setMuted`, `stop`, `announceAll`, groups, announce over playback; Hue zones, effects and a stream event after a write (lights, rooms, scenes and colour worked, 2026-11-11); Up's writes; Enphase since 28 Oct.

## 0.1.3 is on npm (2026-11-10)

Live as `latest`, approved by KO; chota-bot has been told. jaldi has not (no session open).

In it: `homeDevices` and `DeviceRecord` (`src/devices.ts`, a function per device connector, step 7 of "Adding a connector"), `castStatus` and `castFree`, `Part.reason` (`auth`, `config`, `crashed`), `ConnectorCode`, Google's key in a header, and fixes to spotify's cap and `interrupt`, a Cast group's level after an announce, and `createHome`.

**Consumer docs, 2026-11-11:** a Sonnet audit wrote each consumer task from the shipped docs alone; its findings are fixed (`llms.txt`, `docs/using.md`'s write table and error section, `docs/config.md`'s full `loadHome` call), and the examples were type-checked against the exports. Not done from it: typed Hue writes in the table (none exist), a per-connector guide to message-only errors.

**chota's asks after reading the consumer docs (2026-11-11), for KO to decide; the doc gaps in the same message are fixed:**

- `home.add(integration)`, so a bot that pairs Hue while running needn't rebuild the home. Today the docs say to build it again.
- Hue writes by name: built (below).
- `castFree` with a `forms` option, or the docs' filter (now shown): an idle TV is free, so "announce everywhere" plays on it.
- For the home map: a `byRoom(homeDevices(snapshot, config))` helper with "no data" for a room whose connector is down; a documented `photos` field on a room; whether a walkthrough video is a source for `draw-home`.
- Still open: `spotifyText` says "playing" while `active` is false; the two cap gaps.
- For the next release note to consumers: `bun add @khalido/home@latest --no-cache` resolved 0.1.2 minutes after 0.1.3 went live; the exact version worked.

**Hue, unreleased (2026-11-11):** both of Signify's roots are in the package (`HUE_BRIDGE_ROOT_CA`, identical to Signify's page, pinned live against KO's BSB002 with reads only), `ca` is optional everywhere, and `pairWhenPressed` waits for the button. `docs/hue.md` has Signify's rules and what other projects do. `home pair` worked live for KO on 2026-11-11 and waits 60 s with a countdown. The key is in this repo's `.env` (git-ignored), and Hue reads live: `home hue`, `home devices`, a 177-resource read with every schema parsing, and the stream holding through a watchdog reconnect. No write has gone through the paired key. Typed light writes are built and unreleased (2026-11-11): `client.light`, `room` and `scene` by name with `{ state, confirmed }`, colour and kelvin, colour in the state, and `home light | room | scene` on top. They ran live on 2026-11-11 on two rooms (seven lights), each put back: every write confirmed in about a second, colours read back exactly, and a room with an unreachable light still confirmed. A Cast announce from this Mac to a Nest Hub played and restored. chota-bot wants to pair from a chat message and is waiting on a release with this.

Hue's device records are from the docs' shapes, like the rest of Hue. `home devices` is built and unreleased (2026-11-11): it listed KO's Cast devices and printer live; Hue, the Daikin and the Soloist were not set up on that machine, so their lines are still from fixtures. From chota's feedback, for the writes-in-one-shape work in 0.2.0: the actions a device accepts, a common 0–100 `level`, Cast volume 0–1 against Soloist 0–100, where writes hang and what they return, helpers taking a Part or a state, ids or names.

**Spotify cap, two gaps found live on 0.1.3** (chota, 2026-11-11; `spotify/README.md` has the timeline): Soloist puts its level back 90 ms after `playing`, after the cap's lowering was confirmed, and the cap stops at its first confirmed lowering while `anomaly` says "lowered it"; and a resume while already active is never capped. chota asks for the cap to hold on any reported volume above it while playing. KO has not decided; he said earlier not to overdo this. The Cast group restore passed live the same day.

The four cap flags in spotify (`capping`, `capped`, `capUntil`, `startBuffering`) are a state machine in all but name. Not done.

## Where things stand

- **0.1.3 is on npm** (2026-11-10), with provenance. A clean `bun add @khalido/home` of 0.1.2 imported on Bun 1.4.4 and Node 26.11.1 and gave the `home` command; not repeated for 0.1.3. `khalido/home.ts` is public.
- **Releases stage:** a GitHub release runs `publish.yml`, KO approves with 2FA (`docs/publishing.md`, the `release` skill). It has worked for 0.1.1, 0.1.2 and 0.1.3.
- **Live:** Amber and weather read 2026-10-28; the Enphase gateway refused connections. Writes that have reached a device: `setPower(true)` on the Daikin; spotify's and Cast's announce (0.1.1, chota-bot's Pi, 2026-11-09; the connector READMEs have the results).

## spotify (Soloist)

Built 8 Nov in three groups agreed with chota-bot, each reviewed (`/ko-review`, plus Gemini and a Sonnet pass on group 1): confirmed writes (`{ state, confirmed }`), `duck` and `interrupt` (`{ value, music, why? }`), `upNext`, `setRepeat`, `speakerState`, `spotifyChanges` with `own` marking, and the stall watch (issue #5) with opt-in `repairStalls`. The connector README has all of it, the protocol and the Unverified list. Pure helpers are in `changes.ts`; the integration's closure stays whole in `index.ts`, since its parts share one state.

- **Seen live** on chota's Pi, 2026-11-09: reads, and most writes on 0.1.1. KO listens on it: writes only with his OK, not while he is. What 0.1.2 changed is untried on Soloist.
- **Search lives in chota-bot** (KO, 8 Nov); the library stays device control. Research in `docs/ideas.md`.
- `drafts/soloist/` (git-ignored) is chota's old client and units: delete once chota switches.

## chota-bot as a consumer

On Bun on a Raspberry Pi 5 (Pi OS Lite Trixie arm64, Wi-Fi), one long-lived `loadHome`, thin agent tools. Its 2-day install wait is off, so it can take 0.1.0 as soon as it's out.

| chota wants                | home API                                                                                         | Missing or untried                                                                               |
| :------------------------- | :----------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------- |
| Lights, scenes             | `integration("hue").client.put`, `recallScene`                                                   | reads live; `client.light`, `room`, `scene` by name resolve `{ state, confirmed }`, untried live |
| AC status and set          | `part("daikin").state`, `client.power(on)`, `client.mode(mode, °C?)`                             | 120 s poll; both resolve `{ state, confirmed }`; on and cool 25 tried live                       |
| Morning brief              | `energyNow`, `bestWindow`                                                                        | Enphase unreachable since 28 Oct                                                                 |
| Announce on Nest speakers  | `integration("cast").announce`, `announceAll` + `serveClip`                                      | played live on four devices (MP3); groups and over playback untried                              |
| Music                      | `integration("spotify")`, `activate`, `speakerState`, `spotifyChanges`, `duck` around `announce` | most writes live; 0.1.2's cap and `activate` then `play(uri)` untried                            |
| Print a PDF on the Brother | none                                                                                             | Next item 3                                                                                      |
| Spend to categorise        | `integration("up").client`, `setCategory`                                                        | writes untried                                                                                   |
| Admin page, alerts         | `health()`, `onChange`                                                                           | an "expected off" option, so a printer off at night isn't `down`                                 |

On the Pi: home's Linux finders need `avahi-utils`; Wi-Fi makes mDNS lossier, so the address cache matters more. Check Vite's SSR build keeps `@khalido/home` external.

## Waiting on KO

- Hue pairing (`home pair`, the env lines it prints, then `home hue`).
- Enphase: why the gateway refuses connections (`home discover`), then a read on Node with `NODE_TLS`.
- First writes, each with KO's say-so: Up categorise, Daikin presets, a Hue burst.
- Package Settings → Publishing access → "Require two-factor authentication and disallow tokens", now a release has gone through.
- jaldi hasn't been told 0.1.0 or 0.1.1 are out: no session is open there.
- Four old agent worktrees under `.claude/worktrees/`, clean and merged: `git worktree remove`, `git branch -D`; keep `pre-squash`.

## Next, in order

0. **From chota-bot's live tests of 0.1.2** (2026-11-10; the cast and spotify READMEs have the results). Most of the list worked. What is left, each KO's call:
   - **spotify: what KO wants from the volume is not a cap** (2026-11-10): the speaker may go to 100; a start should come back at the level he was playing at. Proposed, not agreed: hold the level. Remember the last level set through the library or reported while steadily playing, and set it back when it moves during a start, a resume or going active; a change while playing sticks. `maxVolume` becomes the level to start at when nothing is remembered, and chota saves the last level across restarts. The hard cap is dropped. The 62 on pause did not repeat in a controlled pass (2026-11-10; the spotify README has the readings): the stream's level followed Soloist's at every step and WirePlumber saved nothing, so it isn't the Pi's audio setup. Closed unless it shows again; if it does, look at a phone session re-asserting its volume after `activate`.
   - **spotify: `playing` while `active: false`** reads as `elsewhere` (built 2026-11-11, unreleased, a breaking change for 0.2.0). To see live: the line and events with music on a phone, and `spotifyElsewhere` naming a Cast speaker.
   - **`home cast volume | mute | stop`** print the device's line (built 2026-11-11, not run against a device).
   - **Announcing over Spotify on a Cast speaker: no resume** (KO, 2026-11-10, in chota's session: "regular annoucements go to chota, and free cast spkrs. only important ones interrurpt and those are ok to disrupt the stream"). Important ones keep today's behaviour. For regular ones chota leaves busy Cast speakers alone with `castStatus` and `castFree` (built 2026-11-10, pure, over the snapshot): `castFree(snapshot, targets).free` goes to `announceAll`. To check live: what a group's members report while the group plays Spotify (the code takes `playingVia` or the member's own app as busy).
   - Small, from chota's switch to the spotify connector (it runs on 0.1.2 in chota's working tree, not deployed): `positionMs` can step back a second around an aside; Google's `forecast/hours` pages at 24 with a `nextPageToken`, which matters if the source ever asks for more than 24 (it asks for 6). Read on the Pi, 2026-11-10: `home discover` found the Hue bridge, the gateway, 8 Cast devices, the Brother and the Daikin; `home printers` and `home daikin` read their devices.
   - Still to run live: an announce to a group with a `volume` (its own level is now put back first, then each member's; fake socket only), the first-play cap from idle, stall events, `home cast stop`, an announce over a Default Media Receiver stream, `announceAll`. Open: one speaker read 50 before a failed announce and 56 after.

   - **chota's ranked wishlist** (2026-11-10, KO has the same list; my triage, not agreed). Small and real, for 0.1.3: the Cast verbs printing the device's line (not built). Next: a fake Soloist socket exported for consumers' tests (chota has written two, this repo one), `{ state, confirmed }` on Hue and Daikin writes, a tested table of clip formats per Cast device kind (needs chota's live tests), `castChanges`. Already there: `pair()` from `@khalido/home/hue` is one call that throws `link_button` until the button is pressed. Not now: writes described in the manifest with schemas so chota generates agent tools (one consumer, and Hue and Daikin writes are still untried), printer change events, an ESC/POS connector (USB, chota's).

1. **From Gemini's second pass** (not bugs, or KO's call): Google-only weather goes `disconnected` when only the minute forecast failed; printers off at night go `down`; `createHome`'s clock is its third argument; `MANIFESTS` not exported; CI runs Bun only; `loadHome`'s Node `tls` check has no test.
2. **Writes that return the resulting state for Hue**, in spotify's shape (`{ state, confirmed }`). Daikin has them (`power`, `mode`, 2026-11-11, unreleased): cool defaults to 25 and heat to 27, in the library. Live 2026-11-11: on, and dry to cool at 25 by `home daikin cool`. Untried: off, heat, auto, fan mode, fan speed. `home` and `home daikin` find the unit by UDP broadcast when `DAIKIN_HOST` is unset.
3. **Printers: print a PDF on the Brother** over IPP Print-Job, through the lane: a live read, Identify-Printer, then Print-Job, each with KO's say-so.
4. **Weather, proposed to KO and not yet agreed.** The Google key works (a public Sydney point, 2026-11-09). All three add to the API, so they can go in 0.1.3: Google hourly as a fallback, up to 48 hours (`forecast/hours:lookup` gives 24 a page; about 720 more calls a month), so hourly and the day blocks survive without Open-Meteo; alerts from `publicAlerts:lookup` (answered 200 with no active alerts, so parsing would be from Google's docs and unverified; about 720 calls a month if hourly); and the fix in item 1 for a failed minute forecast. BOM warnings are more authoritative but more work. chota's headline rules stay in chota; it can drop its own Google parsing once it moves to the library.
5. **Leftovers**: TS 5.6 and older fail on `Uint8Array<…>` in `printers/codec.d.ts` with `skipLibCheck: false`; `exports.test.ts` imports `src`, not `dist`; `FROM_ENV` and `loadHome` build integrations two ways; `withSpotify` and `withCast` in the CLI are near-copies (two, under the rule of three).
6. **A docs site** later: GitHub Pages from an Actions build (not a `gh-pages` branch or a committed folder), serving `llms.txt`.

Later: a Cast `play(target, url)` for streams. For a 0.2.0: writes in one shape across connectors, Cast's volume 0–1 against spotify's 0–100. Open: going active uses the volume reported while inactive, which isn't always the real level; the cap only ever lowers to the cap, so the worst case is a raise to it.

## To see the current state

`bun run check && bun test`; `home`, `home amber`; `npm pack` and install the tarball into an empty folder to check what ships.
