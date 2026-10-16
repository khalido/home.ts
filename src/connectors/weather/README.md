# Weather

Outside weather for the home: what it is now, today and tomorrow, how much sun is reaching the roof, and where the sun is. `iot_class`: **cloud_polling**. The probe that chose these sources is [`docs/weather-probe.md`](../../../docs/weather-probe.md).

```ts
import { weather, bom, openMeteo } from "@khalido/home/weather";
import { ftpFetch } from "@khalido/home/weather/ftp";

weather({ latitude, longitude, sources: [bom({ fetch: ftpFetch(), forecastLocation: "Sydney" }), openMeteo()] });
```

## Slices

Each slice carries `source`, `modelled` (a model, not an instrument), `at` (the time it is for) and `fetchedAt`. Observed and modelled data are never shown as each other.

| Slice | What | Owner with BOM first | Fallback |
|---|---|---|---|
| `now` | temperature, feels-like, humidity, wind and gust, rain since 9am with its own window, station and distance | BOM (observed) | Open-Meteo `current` (modelled, 15-minutely) |
| `forecast` | today and tomorrow: min, max, rain chance, rain range (BOM) or amount (models), text, the source's icon code | BOM précis | Open-Meteo daily (modelled) |
| `sky` | cloud %, UV index, shortwave radiation W/m², now and the next 6 hours | Open-Meteo (the only source with radiation) | Google (no radiation) |
| `rain` | minute by minute for the next 2 hours, in 15-minute segments: type, chance, amount, weight. `rainSoon(rain, at)` turns it into when rain starts and ends | Google's minute forecast (the only source) | none |
| `sun` | dawn, sunrise, golden hour, solar noon, sunset, dusk, astronomical night, azimuth, altitude, rising, daylight, and the next dawn, sunrise, sunset and dusk | computed: `sunNow(latitude, longitude, at)` with suncalc, no network | none needed |

`sources` is the preference order. The default is `[openMeteo()]`, which works anywhere with no key. **In Australia put BOM first; it needs the FTP transport, so it is opt-in**, as in the example above and in `home status`. Put Google last when it is used at all: it needs a key, its calls count against a monthly quota and it has no radiation, so it is the last resort for every slice, not a preference. `weatherNow` (one owner, used by the integration and `home status`) gives each slice to the first source holding one whose `at` is younger than one polling interval plus what that source allows (`owns`): `now` and `sky` 30 min for every source, BOM `forecast` 24 h, the models' `forecast` 6 h. An older one falls through to the next source. A fourth provider is a `WeatherSource` (`source.ts`): a `name`, `owns`, and `read({ place, at, pollMinutes, force, signal })` returning its slices and `nextAt`. `force` (from `refresh()`) means read everything now, forecasts included, whatever the schedule.

**One cadence.** `weather({ pollMinutes })`, default **15**, is how often every source reads observations and sky, at :05, :20, :35 and :50 (`nextPoll`), so BOM's 10-minutely file, sent about 3 minutes past, has landed. Forecasts follow their own issue times (BOM) or are read hourly (the models). A source billed per call sets a floor, `minPollMinutes`, and reads at whichever is longer: Google's is 15, the length of a rain segment, and inside that read it takes current conditions only every 30 minutes. Nothing reads faster than this, `refresh()` included: it forces only sources without a floor, and skips a billed source whose last read is younger than its floor.

**Two outside temperatures.** The Daikin outdoor unit's sensor (`outsideC`) and the BOM station are different instruments in different places. `home status` shows both, the first as "outdoor unit", the second under the station's name; nothing here prefers one.

## Sources

**BOM, anonymous FTP** (`bom.ts`, `ftp.ts`). The channel BOM's own block page names for automated access. Two state products, read with `fast-xml-parser`, every element by its `type`, numbers parsed here so "-" or "80%" shows up in `anomaly` instead of becoming NaN:

- **Observations `IDx60920`** (NSW 560 KB): every station in the state. `now` is the nearest station reporting air temperature whose last observation is within an hour of the file's newest (some stations are daily manual reports, days old), unless `station` pins a WMO id. Distance is great-circle from the station's 4-decimal coordinates. Most stations report every 10 minutes and the file lands about 3 minutes later; at the 15-minute default this is 96 reads, about **54 MB of FTP a day** for the NSW file.
- **Précis forecast `IDx11060` and siblings** (NSW 736 KB): needs `forecastLocation` (a name like "Sydney" or an aac like `NSW_PT131`), because the locations carry no coordinates and a guessed town would be worse than asking. Without one, `forecast` falls through. Today is the period containing now; after the afternoon issue it has no min, max or rain range, and they stay missing. Read again at the file's own `next-routine-issue-time-utc` plus 5 minutes (hourly if it names none), so an amendment between routine issues waits for the next one.

| State | `observations` | `forecasts` |
|---|---|---|
| NSW and ACT (default) | IDN60920 | IDN11060 |
| Victoria | IDV60920 | IDV10753 |
| Queensland | IDQ60920 | IDQ11295 |
| South Australia | IDS60920 | IDS10044 |
| Western Australia | IDW60920 | IDW14199 |
| Tasmania | IDT60920 | IDT16710 |
| Northern Territory | IDD60920 | IDD10207 |

Each id was checked on the server on 2026-10-13 (the file exists; for the forecasts, its `amoc` names the state and service `WSP`/`FPR`). `IDN10064` is a 19 KB Sydney-metro-only forecast in the same shape, if that covers the home.

Plain `fetch` cannot read `ftp://` (Bun 1.4.2: "protocol must be http:, https: or s3:"), so `bom()` takes a `fetch` that can: `ftpFetch()` from `@khalido/home/weather/ftp`, `basic-ftp` over Node's `net`, which runs in Bun and Node. It is the one library file using Node APIs, so it is outside the runtime-neutral build (`tsconfig.build.json`) and type-checked by `tsconfig.node.json`. `bom()` without an FTP `fetch` stops at once, like a rejected key: "pass fetch: ftpFetch()" goes in `detail`, nothing is fetched or retried, and its slices fall through. Measured, Bun 1.4.2: `IDN60920` 0.8 s, `IDN10064` 0.3 s, both products together 1.8–2.0 s.

**Open-Meteo** (`open-meteo.ts`, [docs](https://open-meteo.com/en/docs)). One keyless JSON call per poll: `current` is 15-minutely model data (`interval: 900`), so it is read every poll, and the daily and hourly parts, from models that update hourly at best (6-hourly for IFS), are added to one call an hour. 96 calls a day at the default, against 10,000 free. No `models` parameter: [Open-Meteo's BOM page](https://open-meteo.com/en/docs/bom-api) says BOM's open-data delivery is still suspended, and its `bom_access_global` answers only nulls. Radiation is the mean over the preceding interval. `precipitation` is the last 15 minutes, so `now.rainMm` stays empty rather than pretending to be since 9am. 1.3 s a call from Sydney, nearly all of it the TLS handshake with a server in Germany. Plain `fetch` of the JSON API, not the `openmeteo` SDK: the SDK forces FlatBuffers, reads variables by position, calls the global `fetch` (no injection for tests) and adds about 700 KB.

**Google Weather** (`google.ts`, [docs](https://developers.google.com/maps/documentation/weather)). Built from the docs' example responses (`test/fixtures/weather/google-*.json`, the complete objects only; the docs elide the rest) and checked live against Sydney on 2026-10-13: `now`, `forecast` and `sky` in 1.19 s. `google({ key })` reads `forecast/minutes:lookup` every 15 minutes (its floor), `currentConditions:lookup` every 30 and `forecast/days:lookup?days=2` and `forecast/hours:lookup?hours=6` hourly, since Google documents nothing that changes faster. That is 192 calls a day, about 5,800–5,950 a month. Google bills each call as one Weather Usage event: 10,000 free a month, then $0.15 per 1,000 ([pricing](https://developers.google.com/maps/billing-and-pricing/pricing)). Any other use of the same key shares that quota. Whether the minute forecast bills as the same event is unverified: its docs page shows no price. Every slice is `modelled: true`: the docs never say it is observed. A day's rain chance is the higher of its day and night halves, its amount their sum; `currentConditionsHistory.qpf` is a rolling 24 hours, so it is not used as rain since 9am. A 400, 401 or 403 stops the source (`stop`), with no retry loop. The key goes in the query string and never into a message.

**Google minute forecast** (`toRain` in `google.ts`, [docs](https://developers.google.com/maps/documentation/weather/minute-forecast)). `GET /v1/forecast/minutes:lookup` for a point returns `overallPredictionTimeframe` and 24 `segments` (6 hours) of 15 minutes, each with `type` (`NONE`, `RAIN`, `SNOW`, `HAIL`), `probability` 0–100, `qpf` in mm and `intensity`. Probed for Sydney CBD on 2026-10-15 (curl): HTTP 200 in 1.0 s, every segment dry; the first segment began 12 minutes before the forecast's start. Google calls it Experimental, so its failure is a `problem` on `rain` and never stops the other slices. The docs do not list its coverage by country, say nothing of how it is made, and allow keeping minute values for one hour at most: `rain` owns 15 minutes of age on top of one poll, so a stale slice is dropped, not served (with a `pollMinutes` above 45 the slice outlives that hour: keep it at 15), and the test fixture is invented values in the real shape. We keep the segments that start within 2 hours (`RAIN_HORIZON_MINUTES`). **`rainSoon(rain, at, windowMin = 120)` is the owner**: when the first wet stretch starts and ends, its chance, amount and weight, and `coveredMin`, how much of the window the forecast covers. A segment with no `type` is unknown, not dry. Next: if the minute forecast fails, fall back to the hourly rain chance (`forecast/hours:lookup` already carries `precipitation`; not read yet).

**Sun** (`sun.ts`). `sunNow` with [suncalc](https://github.com/mourner/suncalc) 2.1.1, which bundles its own types (degrees, azimuth clockwise from north; `@types/suncalc` describes v1 and is wrong for it). Times are for the local solar day containing `at`. On 2026-10-13 it matched BOM's own Sydney sunrise and sunset to the second. Dawn and dusk are civil (6° below the horizon), `nightEnd` and `night` astronomical (18°), `goldenHour` starts the evening's and `goldenHourEnd` ends the morning's (6° above). `rising` is before solar noon, which in suncalc's solar day means from solar midnight; `daylight` is altitude above 0°. **`sunNow(latitude, longitude, now)` is the owner**: the snapshot's `sun` is recomputed every 5 minutes, so a consumer showing `rising`, `daylight`, `next` or the position calls `sunNow` with its own clock, as `home status` does. `next` holds each of dawn, sunrise, sunset and dusk at its next occurrence after `at` (today's while still ahead, else tomorrow's), missing on a day that has none. The computed sun is the owner: Google's daily `sunEvents` are parsed only to check it, and a sunrise or sunset more than 2 minutes from the computed one (`sunDisagrees`, comparing within the solar day containing Google's time) goes into Google's `anomaly`, never into the sun.

Every request has a 10 s timeout and the user agent `home (+https://github.com/khalido/home)`: BOM's app API gives Bun's default `Bun/1.4.2` no answer at all, so nothing here relies on the default.

## Not built, on purpose

- **BOM's app API** (`api.weather.bom.gov.au/v1/locations/<geohash>/…`, used by [bremor/bureau_of_meteorology](https://github.com/bremor/bureau_of_meteorology)). Fast and convenient, but every response says: "This application programming interface (API) is owned by the Bureau of Meteorology. You must not use, copy or share it."
- **`reg.bom.gov.au/fwo/…`** over HTTPS. It answers anyone today, but it is BOM's Registered User host, a paid service ([charges](https://reg.bom.gov.au/other/charges.shtml)).
- **`www.bom.gov.au/fwo/…`** with a browser user agent. The 403 it gives other clients says automated access "should stop".

## Licences

- **BOM products**: not CC BY. The [data feeds catalogue](https://www.bom.gov.au/catalogue/data-feeds.shtml) says they "are free to access and are not for commercial use"; the [copyright notice](https://www.bom.gov.au/other/copyright.shtml)'s default terms allow personal use and say "You must not supply it to any other person". A home reading them is fine; the BOM fixtures here are invented values in the real shape for that reason.
- **Open-Meteo**: data [CC BY 4.0](https://open-meteo.com/en/licence) (link to Open-Meteo wherever its data is shown); the free API is non-commercial, under 10,000 calls a day, 5,000 an hour, 600 a minute ([terms](https://open-meteo.com/en/terms)).
- **Google Weather**: Maps Platform terms, billed per call (see Google Weather above).
- **Libraries**: suncalc (BSD-2-Clause), basic-ftp (MIT), fast-xml-parser (MIT).
