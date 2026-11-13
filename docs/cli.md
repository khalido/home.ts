# The `home` command

```sh
home <connector> [--json]     # one connector's lines: amber, cast, daikin, enphase, hue, printers, spotify, up, weather
home [status|doctor] [--json] # each integration: connected or not, which env names it still needs, rooms
home devices [--json]         # every device the connectors read, one line each: its state, its room (with a config), and why when it isn't available
home up transactions | categories | uncategorised | spend | categorise | tag | webhooks  # Up Bank's lists and reports; categorise and tag write
home lights off               # one write to the whole-home group; prints how many lights are off, or how many the bridge still reports on
home light <name> [on|off] [<1-100>] [<kelvin>k] [<hex colour>]  # one light: `home light "Desk lamp" 40 2700k`, `home light Shelf ff8800`
home room <name> [on|off] [<1-100>] [<kelvin>k] [<hex colour>]   # every light in a room or zone, one write
home scene <name> [in <room>]  # a scene; name the room when several have one by that name
home pair                     # waits 60 s for the bridge's button, counting down; prints the env lines to set
home daikin on | off           # power only: the AC comes back as it was last left
home daikin cool | heat | auto [°C] | dry | fan  # mode, on, and the setpoint: the one given, else cool 25 and heat 27; prints what the unit then reports. Live on KO's unit: on, and dry to cool at 25 (2026-11-11); the rest untried
                              # --dry-run on a write (lights, light, room, scene, daikin, cast, spotify, printers print): check it and print what would be sent; nothing is sent. Refused on every other command
home enphase login            # once a year: mints the Enphase owner token into ~/.config/home/ (0600)
home discover [--json] [--passes n]  # which smart-home devices answer here (mDNS + Daikin UDP), which this package supports, then with a config how they match it; two passes 5 s apart
home cache [clear]            # the addresses kept between runs, or delete them so the next run discovers afresh
home config check [path]      # validate a home config: what it would set up, secrets as set or unset by name, every problem
home discover --write [path]  # with a config (the path, else --config or HOME_CONFIG): match what answers by identity, add new devices, update moved hosts and renamed Cast names in place
home printers print <file.pdf> [printer]   # PDF as is, or rendered to PWG Raster with pdftoppm when the printer takes no PDF; --dry-run
home printers identify | cancel <job>       # the printer shows itself; stop a job
home probe                    # read-only, no keys: Hue's public config, Daikin by UDP broadcast, the IQ Gateway's /info, each weather source, each Cast device's and printer's status
home locate "<street address>" [--write [path]]  # latitude and longitude from OpenStreetMap's Nominatim; --write sets them in the config's location (and timezone, when absent, to this machine's)
home cast announce --to <name> [--to <name>…] (--say "<text>" [--wav] | --file <path>) [--volume 0-100]  # exit 1 if any didn't play; play a clip, then put back what was playing and the volume
home cast volume <name> <0-100>
home cast mute <name> on|off
home cast stop <name>         # end the running app; the device returns to its idle screen
                              # volume, mute and stop print the device's line once it reports the change (within 2 s), else "sent; the device has not reported it yet"
home spotify activate | pause | play [link] | next | volume <0-100>  # the Soloist speaker at SOLOIST_WS; volume held to SOLOIST_MAX_VOLUME; prints what Soloist then reported
```

## Output

- **stdout is data, stderr everything else.** Notes such as "nothing to categorise" or "no webhooks" go to stderr, so `home … | jq` never sees them.
- **Bun on PATH.** The command starts with `#!/usr/bin/env bun`. A non-login SSH shell may not have `~/.bun/bin` on its PATH: run `PATH="$HOME/.bun/bin:$PATH" home`.
- **`--json` shapes.** `home --json` is one object keyed by connector, with `now` (`energyNow`) first. `home devices --json` is the array `homeDevices` returns; a connector that isn't connected is named on stderr, and the command exits 0. `home <connector> --json` is that connector's object: `status`, `needs`, `access`, `detail`, `reason` (why it is `unavailable`, when known: `auth`, `config` or `crashed`), `anomaly`, then its state (the weather adds `line`, its text). Lists (`home up transactions`, `uncategorised`, `spend --by merchant`) are arrays, `[]` when empty.
- **Errors under `--json`** are one object on stderr: `{"error": "…", "code": "usage" | "auth" | "network" | "error", "fix": "home enphase login"}`; `fix` is there only when one command resolves it. In text: `home: <error> (run \`<fix>\`)`.
- **Exit codes.** 0 success, empty results included. 1 a failure, and `home <connector>` when that connector is not `connected`, so a script can test one. 2 a wrong command, verb or argument. `home` alone lists every connector and exits 0 whatever their state.

With `--config <home.jsonc>` or `HOME_CONFIG`, `status` runs the integrations the config describes until each has answered (at most 15 s) and `probe` takes its addresses from it; keys still come from the shell, by the names in the file. Without one, it reads `HUE_*` and the other names in `.env.example` from the shell, and parses arguments with [cac](https://github.com/cacjs/cac), which also generates `home --help`. Every connector has a verb of its own: `home amber`, `home cast`, `home hue` print only that connector's lines (`--json` for its record), and the verbs that need more sit under it (`home hue pair`, `home enphase login`, `home cast announce …`). The commands come from each connector's manifest (`src/manifest.ts`), as does `.env.example` (`bun run gen`). With no `HUE_BRIDGE_HOST` it finds the bridge by mDNS (`dns-sd`, macOS) every time and caches nothing. `home` with no arguments is `status`:

```
hue      not set up · needs HUE_APPLICATION_KEY  (local HTTPS, key from `home pair`)
daikin   connected · off · cool 25 °C · room 24 °C · outdoor unit 19.5 °C  (local HTTP JSON (dsiot), no key)
weather  connected · Sydney - Observatory Hill (1.1 km) 20:20: 16.6 °C, feels 16.7, 93%, 23.6 mm since 9am to 20:23 · today showers rain 80%, tomorrow 14–19 °C cloudy rain 30% (bom) · cloud 100%, UV 0, 0 W/m² (open-meteo) · sun -17°, setting, rises 06:15  (BOM anonymous FTP, Open-Meteo, Google with GOOGLE_WEATHER_KEY; sun computed)
```

Startup is about 10 ms and 38 MB RSS for `home status` without a key; with Enphase, Amber and the Daikin live it takes 0.4–0.8 s, the devices read in parallel (Bun 1.4.2, Apple M5, measured 2026-10-13). The weather line adds 1.8–2.0 s, nearly all of it BOM's FTP (two files, one connection each). Cast takes about 0.3 s: `dns-sd` answers from the system's mDNS cache in 4–13 ms, the browse waits 200 ms of quiet for stragglers, each resolve ends on its TXT line, and seven sockets connect and answer in 50–80 ms (`home status` from a Cast-only config: 0.33–0.44 s, was 3.2 s with fixed 1.5 s windows; Bun 1.4.2, measured 2026-10-13). A configured entry discovery misses costs the second pass, 5 s more. `status` reads addresses from the environment, except Cast, which has none to read, and the Daikin, found by UDP broadcast when `DAIKIN_HOST` is unset (1.5 s); `discover` and `probe` do the other network searches. A full-screen TUI was considered (OpenTUI 0.6.2, 52 MB of native binaries) and skipped for now.
