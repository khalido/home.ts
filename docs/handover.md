# Handover

2026-10-16. Read `AGENTS.md` first, then this.

## Where things stand

- Eight connectors: Hue, Daikin, Enphase, Cast, printers, Amber, Up, weather. All but Hue and printers have read live. `bun run check` clean, 320 tests. The global `home` is a `bun link` to this repo.
- **GitHub:** `khalido/home.ts`, **private**, `main` only, one squashed first commit under the noreply address (old history on the local branch `pre-squash`, never pushed). KO reviews it and flips it public himself. The fx workflow stays unpinned while KO develops it.
- **Every export is named** (no `export *`); `test/exports.test.ts` fails when an entry point's list changes. `weatherNow` is `mergeWeather`. All entry points load on Node 26.11.1 from `dist/`.
- **Up** landed today (`src/connectors/up/`): spending by Up's categories, read every 15 minutes, account filter by type (`UP_ACCOUNT="JOINT TRANSACTIONAL"`), `home up …` verbs. Read live; no write has run. The token in the repo's `.env` works; a session whose environment holds an older `UP_TOKEN` wins over `.env` (real env beats `.env` in Bun), so run live reads with `env -u UP_TOKEN` there.
- No write has reached a real device except `setPower(true)` on the Daikin at KO's request.

## Waiting on KO

- **Scope rule** (proposed, not yet in `decisions.md`): the library covers the house and what the household shares (LAN devices, prices, weather, nearby transport, a family calendar, the household account). A per-person tool one consumer uses stays in that consumer and moves here when a second wants it. By it, TickTick stays in chota-bot. Also open: `decisions.md` says the library covers only devices KO owns; keep that once public, or treat the survey in `docs/ideas.md` as open to contributors?
- **First Up write**: `home up categorise <id> <category>` on one transaction; the next purchase from that merchant answers whether Up learns from an API category.
- **Daikin presets**: cool 26 °C and heat 25 °C in the home config's Daikin entry; `home ac cool|heat|off`; the first mode and setpoint write runs with KO's say-so. Daikin `week_power`: compare with the app's weekly graph before building an `energy` field.
- **npm**: read [bun publish](https://bun.com/docs/pm/cli/publish) against `docs/publishing.md`; publish only on KO's word. Tell chota-bot's session the package name and version when it is out (it asked), and that `weatherNow` is now `mergeWeather`.
- Delete the merged `worktree-agent-*` branches when convenient.

## Next, in order

1. **`HueConfig.ip`** against `host` everywhere else: rename before npm.
2. **Review leftovers**: weather times use the machine's zone, not `location.timezone` (`hhmm` in `weather/index.ts`; wrong on a Pi left on UTC); `home probe` prints Daikin `basic_info` raw (allowlist; wrap `JSON.parse` and `decodeURIComponent`); Hue's full-read failure and `refresh failed` still show the error class, unlike `lostDetail`.
3. **Printers status time.** `home` takes 1.5 s more with no printer: `dns-sd` buffers when piped, so a type with no answers prints nothing and runs to its 1500 ms cap (`_ipp._tcp` 1507 ms, `_googlecast._tcp` 209 ms; Bun 1.4.3, 2026-10-16). Options: start `dnsSd`'s quiet timer at spawn (check a cold mDNS cache still answers), skip the first-poll scan when cached printers all read, or "not set up" until `home discover` caches one. Also: no printers reads "disconnected · no printers found"; `printerKey` strips `urn:uuid:` but `sameId` and the address book do not.
4. **Node for chota-bot** (adopts from npm after its Pi move): lift `settle` from `src/cli/context.ts` into `src/home.ts` with `clock.sleep` and export it; a `node --test` smoke file over `dist/`. Hue and Enphase TLS on Node (`tls:` at `hue/client.ts:97`, `enphase/client.ts:147`) waits for a Node consumer that wants them. Chota's other asks: `engines`, publish from GitHub Actions with `--provenance`, an optional logger, actions that return the resulting state.
5. **First live printer read**: Brother on, `home discover`, `home printers`. Identify-Printer as the first write, by KO's hand.
6. **Weather `hourly` slice, then Transport NSW** (chota's asks), then calendar (`docs/google.md`).
7. **Typed actions** (jaldi): start with a typed accessor from `loadHome` (it returns `Integration<any>[]`).
8. **Worth KO's thought** (architecture review): discovery spawns macOS `dns-sd`, so Cast cannot run on a Pi (`multicast-dns` would); env and config build integrations two ways (`FROM_ENV`, `loadHome`, `envFromConfig`); the relocator may be more than DHCP-reserved devices need; abort-cancels-read is tested only for Amber; `src/cli/` has few tests; Daikin's 404 is `unavailable` though the rule says that means a rejected key. Sharing the poll loop is closed: a helper breaks even at best.
9. **Ideas** in `docs/ideas.md`, with the survey of what other homes run (Shelly, Fronius, forecast.solar, MQTT lead). Raised and not there yet: internet health, Hue sensors and button, solar health, Amber cheapest windows, NSW RFS incidents. The Daikin ramp belongs in a long-lived consumer.

## To see the current state

`bun run check && bun test`; `home`, `home --help`, `home amber`, `home up categories`, `home discover` (8 s, read-only), `home config check examples/home.jsonc` offline.
