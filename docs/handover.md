# Handover

2026-10-16. Read `AGENTS.md` first, then this.

## Where things stand

- Eight connectors: Hue, Daikin, Enphase, Cast, printers, Amber, Up, weather. All but Hue and printers have read live. `bun run check` clean, 339 tests. The global `home` is a `bun link` to this repo.
- **GitHub:** `khalido/home.ts`, **private**, `main` only, one squashed first commit under the noreply address (old history on the local branch `pre-squash`, never pushed). KO reviews it and flips it public himself. The fx workflow stays unpinned while KO develops it.
- **Every export is named** (no `export *`); `test/exports.test.ts` fails when an entry point's list changes. All entry points load on Node 26.11.1 from `dist/`.
- **Weather by the hour** landed today: an `hourly` slice (Open-Meteo, 48 hours from the home's midnight) and `dayBlocks`, morning 6–12, afternoon 12–18, evening 18–22, with one `condition` word. Times and blocks follow the home's time zone (`location.timezone`, or `HOME_TIMEZONE` for `home` from env). Read live for Sydney CBD, also with `TZ=UTC`.
- **Up** reads live with a household filter (`UP_HOUSEHOLD="home tag:home"`, `UP_ACCOUNT="JOINT TRANSACTIONAL"`); no write has run. A session whose environment holds an older `UP_TOKEN` wins over the repo's `.env`, so run live reads with `env -u UP_TOKEN`.
- **The snapshot is typed by name**: `home.part("weather")?.state` is a `WeatherState`; `loadHome` returns `HomeIntegration[]`.
- **`docs/devices.md`** (public): devices worth buying, with the TIMMERFLOTTE verdict.
- **The CLI has an output contract** (`docs/cli.md`, Output), after kotools: stdout data, stderr notes, `--json` errors as `{error, code, fix}` on stderr, exit 0/1/2, `home <connector>` exits 1 when not connected. `test/cli.test.ts` holds it.
- No write has reached a real device except `setPower(true)` on the Daikin at KO's request.

## Waiting on KO

- **Hue pairing** (KO, 2026-10-17): press the bridge button, `home pair`, put the three lines in `.env`; then set `HUE_CA_FILE` to Signify's root CA (`src/connectors/hue/README.md`) and run `home hue` read-only. Its rooms feed the house definition (`draw-home` from the floor plan PDF, into `private/`). Chota copies the same env lines plus the CA file; on the Pi set `HUE_BRIDGE_HOST`, since mDNS discovery is macOS-only for now.
- **Matter**: waits for a first device (a TIMMERFLOTTE). Plan in `docs/matter.md`. Recording home events is in `docs/ideas.md` for later, in chota.
- **Fans**: pair the Martec Fresno in Smart Life. Then extract its local key (a Tuya IoT developer account, once) and build a `tuya` connector, `local_push`. The Claro Whisper fans need Claro's SMART Connect module (check the model and purchase date first) or an RF bridge.
- **First Up write**: `home up categorise <id> <category>` on one transaction; the next purchase from that merchant answers whether Up learns from an API category.
- **Daikin presets**: cool 26 °C and heat 25 °C in the home config's Daikin entry; `home ac cool|heat|off`; the first mode and setpoint write runs with KO's say-so.
- **npm**: read [bun publish](https://bun.com/docs/pm/cli/publish) against `docs/publishing.md`; publish only on KO's word.
- Delete the merged `worktree-agent-*` branches when convenient.

## Next, in order

1. **Change events and health** in `src/home.ts` (KO agreed): `onChange` says which part changed and from what; `health(snapshot, now)` says ok, stale or down per connector from each manifest's `pollSeconds`. The base for recording later.
2. **Tell chota-bot** the weather is ready to try: `hourly`, `dayBlocks(state.hourly, now, timeZone)`, `blockText`, `weather({ timeZone })`; `weatherNow` is `mergeWeather`. Promised: a git tag to test against before npm.
3. **`HueConfig.ip`** against `host` everywhere else: rename before npm.
4. **Review leftovers**: `home probe` prints Daikin `basic_info` raw (allowlist; wrap `JSON.parse` and `decodeURIComponent`); Hue's full-read failure and `refresh failed` still show the error class, unlike `lostDetail`. `upFromEnv` passes no time zone; `HOME_TIMEZONE` could feed it and Enphase too.
5. **Printers status time.** `home` takes 1.5 s more with no printer: `dns-sd` buffers when piped, so a type with no answers runs to its 1500 ms cap (Bun 1.4.3, 2026-10-16). Options: start `dnsSd`'s quiet timer at spawn, skip the first-poll scan when cached printers all read, or "not set up" until `home discover` caches one. Also: no printers reads "disconnected · no printers found"; `printerKey` strips `urn:uuid:` but `sameId` and the address book do not.
6. **Discovery on the Pi**: options in `docs/ideas.md` (bonjour-service, or avahi via `avahi-browse` or D-Bus); KO comes back to it. Then **Node for chota-bot**: lift `settle` from `src/cli/context.ts` into `src/home.ts` with `clock.sleep` and export it; a `node --test` smoke file over `dist/`. Chota's other asks: `engines`, publish from GitHub Actions with `--provenance`, an optional logger, actions that return the resulting state.
7. **Weather, more**: Google's hourly as a second `hourly` source; the hourly rain chance as the fallback when the minute forecast fails. Then Transport NSW, then calendar (`docs/google.md`).
8. **First live printer read**: Brother on, `home discover`, `home printers`.
9. **Writes that return the resulting state** (jaldi, chota): the typed snapshot is done; a write (Hue room, Daikin mode) should resolve with the state it left.
10. **Worth KO's thought** (architecture review): discovery spawns macOS `dns-sd`, so Cast cannot run on a Pi (`multicast-dns` would); env and config build integrations two ways (`FROM_ENV`, `loadHome`, `envFromConfig`); the relocator may be more than DHCP-reserved devices need; abort-cancels-read is tested only for Amber; `src/cli/` has few tests beyond `test/cli.test.ts`; Daikin's 404 is `unavailable` though the rule says that means a rejected key.
11. **Ideas** in `docs/ideas.md`, with the survey of what other homes run (Shelly, Fronius, forecast.solar, MQTT lead).

## To see the current state

`bun run check && bun test`; `home`, `home weather`, `home amber`, `home up categories`, `home discover` (8 s, read-only), `home config check examples/home.jsonc` offline.
