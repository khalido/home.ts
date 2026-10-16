# The `home` command

```sh
home <connector> [--json]     # one connector's lines: amber, cast, daikin, enphase, hue, weather
home [status|doctor] [--json] # each integration: connected or not, which env names it still needs, rooms
home lights off               # one write to the whole-home group
home room <name> on|off|<1-100>
home scene <name>
home pair                     # press the bridge's button first; prints the env lines to set
home enphase login            # once a year: mints the Enphase owner token into ~/.config/home/ (0600)
home discover [--json] [--passes n]  # which smart-home devices answer here (mDNS + Daikin UDP), which this package supports, then with a config how they match it; two passes 5 s apart
home cache [clear]            # the addresses kept between runs, or delete them so the next run discovers afresh
home config check [path]      # validate a home config: what it would set up, secrets as set or unset by name, every problem
home discover --write [path]  # with a config (the path, else --config or HOME_CONFIG): match what answers by identity, add new devices, update moved hosts and renamed Cast names in place
home probe                    # read-only, no keys: Hue's public config, Daikin by UDP broadcast, the IQ Gateway's /info, each weather source, each Cast device's status
home locate "<street address>" [--write [path]]  # latitude and longitude from OpenStreetMap's Nominatim; --write sets them in the config's location (and timezone, when absent, to this machine's)
home cast announce --to <name> (--say "<text>" | --file <path>) [--volume 0-100]  # play a clip, then put back what was playing and the volume
home cast volume <name> <0-100>
home cast mute <name> on|off
home cast stop <name>         # end the running app; the device returns to its idle screen
```

With `--config <home.jsonc>` or `HOME_CONFIG`, `status` runs the integrations the config describes until each has answered (at most 15 s) and `probe` takes its addresses from it; keys still come from the shell, by the names in the file. Without one, it reads `HUE_*` and the other names in `.env.example` from the shell, and parses arguments with [cac](https://github.com/cacjs/cac), which also generates `home --help`. Every connector has a verb of its own: `home amber`, `home cast`, `home hue` print only that connector's lines (`--json` for its record), and the verbs that need more sit under it (`home hue pair`, `home enphase login`, `home cast announce …`). The commands come from each connector's manifest (`src/manifest.ts`), as does `.env.example` (`bun run gen`). With no `HUE_BRIDGE_HOST` it finds the bridge by mDNS (`dns-sd`, macOS) every time and caches nothing. `home` with no arguments is `status`:

```
hue      not set up · needs HUE_APPLICATION_KEY, HUE_CA_FILE  (local HTTPS, key from `home pair`)
daikin   connected · off · cool 25 °C · room 24 °C · outdoor unit 19.5 °C  (local HTTP JSON (dsiot), no key)
weather  connected · Sydney - Observatory Hill (1.1 km) 20:20: 16.6 °C, feels 16.7, 93%, 23.6 mm since 9am to 20:23 · today showers rain 80%, tomorrow 14–19 °C cloudy rain 30% (bom) · cloud 100%, UV 0, 0 W/m² (open-meteo) · sun -17°, setting, rises 06:15  (BOM anonymous FTP, Open-Meteo, Google with GOOGLE_WEATHER_KEY; sun computed)
```

Startup is about 10 ms and 38 MB RSS for `home status` without a key; with Enphase, Amber and the Daikin live it takes 0.4–0.8 s, the devices read in parallel (Bun 1.4.2, Apple M5, measured 2026-10-13). The weather line adds 1.8–2.0 s, nearly all of it BOM's FTP (two files, one connection each). Cast takes about 0.3 s: `dns-sd` answers from the system's mDNS cache in 4–13 ms, the browse waits 200 ms of quiet for stragglers, each resolve ends on its TXT line, and seven sockets connect and answer in 50–80 ms (`home status` from a Cast-only config: 0.33–0.44 s, was 3.2 s with fixed 1.5 s windows; Bun 1.4.2, measured 2026-10-13). A configured entry discovery misses costs the second pass, 5 s more. `status` reads addresses from the environment only, except Cast, which has none to read; `discover` and `probe` do the other network searches. A full-screen TUI was considered (OpenTUI 0.6.2, 52 MB of native binaries) and skipped for now.
