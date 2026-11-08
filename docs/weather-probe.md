# Weather probe, 2026-10-13

Build BOM from the anonymous FTP products, not the app API and not the website's HTTP paths. Open-Meteo owns `sky` and backs everything else; its BOM model is dead. Live probes from Sydney on 2026-10-13 around 20:00 AEDT, against Sydney CBD (-33.8688, 151.2093), curl 8.7.1 and Bun 1.4.2.

Two premises of the brief did not hold:

- **The app API has stated terms now.** Every response carries `"copyright": "This application programming interface (API) is owned by the Bureau of Meteorology. You must not use, copy or share it."`
- **The official feeds are not CC BY.** The catalogue says they "are free to access and are not for commercial use". The copyright page grants CC BY only where a page says so, and otherwise allows "personal use, or use within your organisation. You must not supply it to any other person". The product files point to that page. KO's home is personal use, so it is fine to read them. Committing real BOM files as test fixtures in a public repo is supplying them, so BOM fixtures should be invented values in the real shape.

## What answered

| Path                                                                                                                   | Result                                                                     | User agent                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App API `api.weather.bom.gov.au/v1/locations/r3gx2f/observations`, `/forecasts/daily`, `/forecasts/hourly`, `?search=` | 200, 25–80 ms, `cache-control: max-age≈100`                                | Bun's default `Bun/1.4.2` gets no answer at all (10 s timeout, not a 403). `Bun`, `curl/8.7.1`, `home/0.1`, empty and browser UAs all get 200.                                                                                                             |
| `www.bom.gov.au/fwo/IDN60901/IDN60901.94768.json` (station JSON) and `/fwo/IDN11060.xml` (NSW precis)                  | 403 for curl, `home/0.1` and Bun; 200 for empty or browser UA              | The 403 body: "The Bureau of Meteorology website does not support web scraping: if you are trying to access Bureau data through automated means, you should stop." It names anonymous FTP as the channel.                                                  |
| `reg.bom.gov.au/fwo/...` (same files)                                                                                  | 200 for every UA, no auth                                                  | This is the Registered User host: the block page links it for paid services ($1,282/yr FTP registration). Serving unauthenticated looks like a gap, not permission. Ignores `If-None-Match` (200, not 304).                                                |
| FTP `ftp://ftp.bom.gov.au/anon/gen/fwo/`                                                                               | 226, 0.8–1.0 s per file                                                    | Any UA. Station JSON is **not** on FTP (550).                                                                                                                                                                                                              |
| Open-Meteo `api.open-meteo.com/v1/forecast`                                                                            | 200, 1.3 s every time (TLS to a German origin: 0.32 s connect, 0.95 s TLS) | Bun default UA fine.                                                                                                                                                                                                                                       |
| Open-Meteo `models=bom_access_global`                                                                                  | 200 but every value `null`; `/v1/bom` the same                             | Its metadata says `data_end_time` 2025-06-30. The docs page: "BOM is currently upgrading its key platforms and services. During this process, open-data delivery has been temporarily suspended." Do not pass `models`; the default `best_match` answered. |

Bun's `fetch` refuses FTP (measured: `TypeError: protocol must be http:, https: or s3:`).

## The FTP products

- **Observations: `IDN60920.xml`** (562 KB, all NSW stations). Observatory Hill (WMO 94768) has air and apparent temperature, humidity, wind direction, speed and degrees, gust when present, rain since 9am (`rainfall`, with its own start and end time), running max and min. Every station has `lat`/`lon` to 4 decimals and a `forecast-district-id`, so the nearest station comes from the file itself, with distance, from latitude and longitude alone. Other states: `IDV60920`, `IDQ60920`, and so on.
- **Forecast: `IDN10064.xml`** (19 KB, Sydney metro: Sydney, Penrith, Parramatta, Bondi and 4 more) or `IDN11060.xml` (736 KB, all NSW precis). Per location and day: icon code, precis text, rain chance, rain range, min, max. Locations carry an `aac` and a name but **no coordinates**, so mapping a home to its forecast location needs either an option (`forecastLocation: "Sydney"`) or a heuristic (the nearest station's `forecast-district-id` matches the location's parent area). I recommend the option; a wrong guess at a forecast town is worse than asking once.
- **Cadence.** `IDN60920` is 10-minutely: at 20:23 most stations, Observatory Hill included, had a 20:10 observation, issued at 20:11 and sent at 20:13. The build reads at `:05` and `:35` anyway (see `src/connectors/weather/README.md`). (The station JSON lists only `:00` and `:30` rows, which is what an earlier draft of this note read as half-hourly.) Some stations in the file are days old (daily manual reports). The precis is issued twice a day plus amendments; each file names its `next-routine-issue-time` (04:15 and 04:35 next morning here), so poll hourly and parse the issue time.
- **After the afternoon issue, today has no min, max or rain range** in both the precis and the app API's daily. `forecast.today` must accept missing fields.

## Rain since 9am disagreed, and it is not rounding

At the same minute the app API said 15 mm, the station JSON `rain_trace` said "14.2" (at 20:00) and the FTP XML said 15.0 mm (09:00 to 20:03). Same station, different cut-off times. The slice carries the time it is for, so this shows up as two honest values rather than an error.

## Which slices each source can own

- **BOM (FTP)**: `now` (observed), `forecast` (official precis). No cloud, UV or radiation.
- **BOM app API**: `now`, `forecast` with UV max and sunrise, hourly UV. No cloud % or radiation. Prohibited by its own terms.
- **Open-Meteo**: `sky` (cloud, UV, shortwave radiation: the only source with radiation), plus `now` and `forecast` as modelled fallbacks. `current` is 15-minute interpolated (`"interval": 900`), so it is `modelled: true`. Limits: 600/min, 5,000/h, 10,000/day, 300,000/month; data CC BY 4.0, attribution link required where shown.
- **Google Weather**: `now` (`currentConditions`, not stated as observed, so modelled until shown otherwise), `forecast` (10 days), `sky` minus radiation (cloud, UV). Australia is covered for current, hourly and daily. Its `currentConditionsHistory.qpf` is a rolling 24 h, not since 9am; I will not map one onto the other.
- **`sun`**: local, `suncalc`, no source.

That gives the default `[bom(), openMeteo()]`: observed beats modelled for `now`, the forecaster's precis beats a model for `forecast`, and `sky` falls through to Open-Meteo whatever the order. Google slots in after BOM when KO has a key.

## Decision for KO: how `bom()` reaches FTP

Recommended: `bom({ fetch })` stays a fetch-only client, parsing XML, and a small FTP transport turns `ftp://` URLs into a `Response`. It uses `basic-ftp` (6.2.3, MIT, no dependencies, Node `net`; measured in Bun 1.4.2: `IDN10064.xml` in 267 ms, `IDN60920.xml` in 765 ms) and lives outside the runtime-neutral build, the way `bunPinnedFetch` and `bunGatewayFetch` are runtime transports passed in today. Cost: one dependency, under 1 s per poll, 562 KB per read, about 27 MB a day at two reads an hour, for observations. If FTP dies, `now` and `forecast` fall back to Open-Meteo, marked modelled.

Alternatives, not recommended:

1. App API: one JSON shape, nearest station and distance for free, 30 ms. Against it: "You must not use, copy or share it", undocumented, and it silently drops Bun's default UA. Home Assistant's bremor integration still uses it, sending `User-Agent: MakeThisAPIOpenSource/1.0.0`, 6-character geohash (its `geohash7` variable is 6 characters too), polling every 5 minutes.
2. `reg.bom.gov.au` over HTTPS: works with plain `fetch` today, but it is the paid host and unannounced access could be cut or billed.
3. `www.bom.gov.au` with a browser UA: evades a block whose message says to stop. No.

## The `openmeteo` npm SDK: not using it

Read from the installed `openmeteo@1.2.3` (`lib/index.d.ts`, `lib/index.js`) and `@openmeteo/sdk@1.28.0`. `fetchWeatherApi(url, params: any, retries?, backoffFactor?, backoffMax?, fetchOptions?)` forces `format=flatbuffers` and returns `WeatherApiResponse[]`. Values are read by position (`hourly().variables(0).valuesArray()` as a `Float32Array`) in the order you asked for them, not by name. It calls the global `fetch` with only `fetchOptions`, so a test cannot inject a `fetch` the way every other client here does. Fixtures would be binary. It adds `flatbuffers` and the SDK, about 700 KB, for one point and a dozen variables. Plain `fetch` of the JSON API gives named fields, a readable fixture and zod, so the SDK buys nothing here.

## Sources

- BOM catalogue: https://www.bom.gov.au/catalogue/data-feeds.shtml, FTP guide: https://www.bom.gov.au/catalogue/anon-ftp.shtml, copyright: https://www.bom.gov.au/other/copyright.shtml (all 403 to non-browser clients)
- bremor/bureau_of_meteorology at `e9cd8da` (2026-10-07): `PyBoM/const.py`, `PyBoM/collector.py`, `PyBoM/helpers.py`
- Open-Meteo: https://open-meteo.com/en/docs, https://open-meteo.com/en/docs/bom-api, https://open-meteo.com/en/licence, https://open-meteo.com/en/terms
- Google Weather: https://developers.google.com/maps/documentation/weather/current-conditions, https://developers.google.com/maps/documentation/weather/coverage
