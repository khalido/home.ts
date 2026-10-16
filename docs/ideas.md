# Ideas: what else to connect

Candidates researched (Sonnet, 2026-10-14), ranked by value over effort for this home. None is decided; KO picks. "Unverified" means from memory or a thin search, to be checked before building.

## Worth it

1. **Up Bank, the money connector.** Shaped in [up.md](up.md): reads, the two gated writes, the spend helpers, the `home up` verbs and the message to the kids.
2. **Transport NSW departures.** Free API key, JSON over `fetch`, "next bus or train from home". Home Assistant has `transport_nsw`. [Trip Planner API](https://opendataforum.transport.nsw.gov.au/t/trip-planner-api-now-available/646).
3. **NSW air quality and UV.** Keyless public feeds: [NSW air quality data services](https://data.nsw.gov.au/data/dataset/nsw-air-quality-data-services) (`get_SiteDetails`, `get_Observations`; times in AEST, not daylight time; the user guide is from 2021, check the endpoints), ARPANSA UV (format unverified). Hourly; would sit beside the weather sources.
4. **Bin days** from a council iCal feed, if the council publishes one. One fetch and a parser.
5. **Who's home**, from the LAN, as an experiment in a Node-only file: phones sleep their Wi-Fi so ARP and ping flap; mDNS announcements or DHCP leases are better, but the leases are on eero. Prototype before committing.
6. **Shelly** plugs with energy, only if KO buys one: local, push, clean JSON ([HA shelly](https://www.home-assistant.io/integrations/shelly/)); the best template for a "plug with energy" connector.
7. **Printers over AirPrint and IPP** (asked for via jaldi's session, 2026-10-14; KO's test printer is a Brother laser on Wi-Fi). Discovery is Cast's shape: mDNS `_ipp._tcp` and `_ipps._tcp` through the existing dns-sd finder, TXT `UUID` as the identity in the config (like `castId`), name from TXT `ty` or the instance name, `pdl`, `URF`, `product`, `adminurl` for what it is and what it speaks. Status over IPP Get-Printer-Attributes, a small binary-over-HTTP-POST encoding worth hand-rolling like the Cast codec rather than the old `ipp` npm package: `printer-state`, `printer-state-reasons` (toner-low, media-empty, door-open), `marker-names` and `marker-levels`, `media-ready`, `queued-job-count`. Polled on the shared poller every few minutes, relocator on failure. Printers go on and off, so an unreachable one shows offline with "last seen" for a configurable number of days (14, say) before `unavailable`. Writes later and behind KO's hand: Identify-Printer (a beep) as the harmless first, then Print-Job with `application/pdf` where `pdl` lists it. Fixtures from documentation values only.
8. **What the power cost** (asked for via jaldi's session, 2026-10-14): last month's total and a daily or monthly average beside the live price, where the grid flow enters the house on the plan. Amber v1 has no bills endpoint; `GET /sites/{id}/usage?startDate&endDate` returns 5-minute intervals per channel (`general` import, `feedIn` export) with `kwh`, `cost` in cents (negative for export credit), `perKwh`, `spotPerKwh`, `quality` (`billable` or `estimated`), `descriptor`, `spikeStatus`, `tariffInformation`, `nemTime`. Limits found live: 7 days per request (422 beyond), about a day's lag, `resolution=30` ignored. A month is five calls against the 50-per-5-minutes budget, fine once a day. Shape: one owning function in the energy layer beside `energyNow` summing `cost` per channel per day, import and export never merged, with a `billable` count so a day with estimated intervals says so; daily totals cached in a consumer-owned file like the address cache so a sidecar does not re-read a month at each start; today's partial cost stays off the line. Fixtures from made-up intervals.

## Not worth it

- **eero**: cloud only, reverse-engineered from the app ([eero on PyPI](https://pypi.org/project/eero/)), login by verification code, a history of breaking. Presence from it flaps.
- **Matter controller**: waits for a Matter device worth reading (a temperature sensor). The plan, the security model and the network needs are in [matter.md](matter.md): Home Assistant's matter.js-based Matter server on the Pi, Google Home as the main controller, a runtime-neutral `matter` connector over its WebSocket.
- **Apple TV and HomePod**: tvOS 15+ folded MRP into an AirPlay 2 tunnel that needs AirPlay credentials; Companion is early-stage and a HomePod cannot show a PIN ([pyatv features](https://pyatv.dev/documentation/supported_features/)). No TypeScript library. At most a pyatv subprocess.
- **Tapo and Kasa**: local but the protocol churns by firmware and Tapo needs a cloud credential. **Roborock**: cloud login for the device key. **NBN modem, Sydney Water, gas**: no stable public API. **Pollen**: no good Australian feed found.

## What other homes run (survey, 2026-10-16)

Home Assistant's public install counts ([current_data.json](https://analytics.home-assistant.io/current_data.json), 701,678 active installs, 21,086 in Australia; HA gives no per-country integration counts, so the Australian notes are judgement). Already covered and near the top: Cast 284k, IPP 163k, Hue 88k. Lower: Enphase 10.7k, Daikin 6.5k, Amber 1.4k. The library covers devices KO owns (decisions), so this is a guide for anyone extending it, not a plan.

| Category | Connector | Installs | Local, no cloud account | Effort | Why |
|---|---|---|---|---|---|
| Energy | Shelly | 141k | yes, Gen2 JSON-RPC | small | most-installed local energy device; plugs and meters |
| Energy | Fronius | 10.1k | yes, Solar API v1 | small | common Australian inverter, one GET |
| Energy | forecast.solar | 67k | keyless free tier | small | solar forecast beside Enphase |
| Energy | Tesla Powerwall | 2.1k + fleet 5.3k | PW2 yes; PW3 mostly cloud | medium | the commonest home battery here |
| Energy | SMA, GoodWe | 5.0k, 3.7k | yes (GoodWe over UDP, Node-only) | medium | next most common Australian inverters |
| Energy | Sungrow, Huawei | custom, Modbus TCP | yes | medium, Node-only | big local market share, poorly served |
| Climate | AirTouch 5 | 543 | yes, TCP | medium, Node-only | Australian ducted zoning |
| Climate | Mitsubishi MELCloud, Sensibo | 7.0k, 6.0k | no | small to medium | split systems after Daikin; Sensibo covers any IR AC |
| Lighting | WLED | 34k | yes | small | trivial JSON |
| Media | Sonos | 90k | yes | medium | the biggest local media brand after Cast |
| Media | Samsung, LG TVs | 95k, 68k | yes, WebSocket with pairing | medium | on or off, what is playing |
| Security | Reolink, UniFi Protect, Frigate | 62k, 25k, 29k | yes | medium | cameras and person events |
| Network | MQTT | 270k | yes | medium | one connector reaches Zigbee2MQTT, Tasmota, ESPHome and Frigate |
| Network | Synology, NUT UPS | 52k, 25k | yes | small | NAS and UPS health |
| Sensors | Ecowitt | 16k | yes, the station posts to you | small, needs a listener | backyard weather station |

Takeaways: energy is where this library is strongest and where demand is; one MQTT connector would cover the cheap-sensor world without per-device code; Australian AC beyond Daikin is cloud or custom-only. Rejected before and still rejected: Tuya (cloud, churn), Matter, Apple TV, Roborock. Transport NSW has 98 HA installs: it is here for chota-bot, not for popularity.

## From chota-bot (Haiku scan, 2026-10-14)

The bot does not import this library yet. What it computes about the home that the library owns, so the bot should call the library instead: Google weather parsing (`tools/weather.ts`, duplicating `google.ts`'s `toSlices`), a 06:00–18:00 day/night proxy (`+layout.svelte`; `sunNow(...).daylight` is the owner), the condition-to-icon map (check against `weatherText`). What the bot has that the library lacks and should grow: **rain soon** ("rain in the next N minutes") and **per-day forecast blocks** as pure helpers over the forecast, one owner for the rain window; **Transport NSW departures** (item 2 above; the bot's `tools/bus.ts` is the shape: key via fetch, typed departures with `dueMins`, `cancelled`, `realtime`); a daily **sunrise and sunset times** helper beside `sunNow` for a daily print. Stays in the bot: the surf report, calendar, school, chores, lists, Telegram formatting, the agent prompts, the box hardware.

## Discovery on Linux (2026-10-16)

Discovery spawns macOS `dns-sd`, so on a Pi (Raspberry Pi OS Lite, trixie) only the Daikin's UDP broadcast works. Not urgent: with DHCP reservations the config's hosts hold, and discovery matters only when a device moves. Options, none chosen:

- **`bonjour-service`** ([onlxltd](https://github.com/onlxltd/bonjour-service), 1.4.4, July 2026, types bundled): pure JS browse and resolve on `multicast-dns`, the same code on the Mac and the Pi; likely ends the 1.5 s `dns-sd` wait too. Binds UDP 5353 beside avahi-daemon (expected to share; test on the Pi). `multicast-dns` alone is stale (last release 2022).
- **avahi-daemon**, already running on Pi OS: spawn `avahi-browse -rpt <type>` (needs `apt install avahi-utils`), the same pattern as `dns-sd` on the Mac; or talk to it over D-Bus (`dbus-next`, `@astronautlabs/avahi`), which binds no port but adds dependencies. Either way the system resolver does the work, and it is Linux-only, so one finder per OS.
- Build the chosen one beside `dns-sd`, check it finds the same devices on the Mac (or matches `dns-sd -B` on the Pi), then switch.

## Recording what happens (2026-10-16, later)

Worth having for questions like "how long are lights left on" or "AC hours against outside temperature". The bot, which runs all day, owns it: one SQLite table it can query and filter, `events(at, source, entity, kind, value)`, with `value` as JSON and `at` in UTC ms, backed up with `VACUUM INTO`. Durations come from SQL window functions (`LEAD`) over on and off rows, not extra tables. The library's part, when it comes: a pure function from two snapshots to typed events (no files, no SQL). Not recorded: what has its own record (Up transactions, Amber bills, Enphase history). Pitfalls: Hue is chatty (record semantic changes, not every event), mark when the bot was down so a gap never reads as "off", batch writes on an SD card.

## The CLI and the connectors

Two ideas from KO, 2026-10-14, not yet decided:

- **Every connector gets a `home <connector>` command** that prints only its lines (and `--json`), and its README opens with that command under "Try it", so a visitor on GitHub or an agent sees the connector and how to run it in one screen.
- **The CLI derived from the library.** Done 2026-10-14 for the CLI split and the manifest; still open is the `actions` list. The plan was: parse arguments with [cac](https://github.com/cacjs/cac) (7.1.0, maintained as of 2026-10) instead of `util.parseArgs`, and register commands from a per-connector manifest (`name`, `iotClass`, `pollSeconds`, `env`, `access`, status lines, `commands`, `actions`). The manifest then drives `home status`, `home <connector>`, `.env.example`, the README table, and the typed action list jaldi asked for, so the library and the CLI stay one thing.
