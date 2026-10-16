# Google: rain soon, a calendar, and whether it is one connector

Written 2026-10-15 from KO's questions, chota-bot's code, Google's docs and one live probe. The rain slice is built (see the weather README); the hourly slice and the calendar are not.

**Short answer.** Add a `rain` slice to the weather connector from Google's minute forecast, with the hourly forecast as fallback. Add a `calendar` connector that reads the Google Calendar API over `fetch`, with the token passed in by the caller. Keep Google as a vendor, not a connector: Weather and Calendar share nothing but a name.

## What is set up with Google today

| Where | What | How |
|---|---|---|
| home | Weather API (Maps Platform, billed). `GOOGLE_WEATHER_KEY` | `fetch` and zod, no SDK. `src/connectors/weather/google.ts` |
| home | Google Cast | Local protocol, no Google account. Not an API. |
| chota-bot | Weather API, its own key | Duplicates `google.ts` (to be replaced by this library) |
| chota-bot | Calendar. `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | better-auth Google provider, scope `calendar.readonly`; `googleapis` 186 |
| chota-bot | `@ai-sdk/google` (Gemini) | Not about the home |

The home library uses no Google SDK. `googleapis` is large and pulls in Node-only auth code. Calendar needs one endpoint. `fetch` plus zod is enough, as it is for Weather.

## How chota-bot reads the calendar

KO signs in once at `/admin` with an allowed Google account. better-auth stores the OAuth tokens in chota's database. `auth.api.getAccessToken()` refreshes them. `tools/calendar.ts` calls the Calendar API through `googleapis` for one calendar id (the family calendar, set in `chota.config.ts`). Ranges: today, tomorrow, week, next week, weekend. It keeps an in-memory cache keyed by range and Sydney date, and has a title search.

## Rain soon

Google has two precipitation sources. Both are in the Weather API.

- **Minute forecast.** `GET /v1/forecast/minutes:lookup`. Probed 2026-10-15 for Sydney CBD (curl): HTTP 200, 1.0 s, 24 segments of 15 minutes, 6 hours in all. Each segment has `type` (NONE, RAIN, SNOW, HAIL), `probability` 0–100, `qpf` in mm and `intensity` (NO_INTENSITY, LIGHT, MODERATE, HEAVY). All 24 were dry at the time.
- **Hourly forecast.** `forecast/hours:lookup`. We already call it (`hours=6`) and read only `uvIndex` and `cloudCover`. The same response holds `precipitation.probability.percent`, `precipitation.qpf` and `thunderstormProbability`. Reading them costs no extra call.

Caveats:
- Google's page calls the minute forecast **Experimental**: no backward-compatibility promise. It does not say how the forecast is made, so "ML nowcast" is unconfirmed.
- Its coverage page lists Australia for current, hourly and daily forecasts, but says nothing about the minute forecast. The probe shows it works for Sydney today.
- The page gives no price or quota. Google's terms allow caching minute values for one hour at most.
- The 2-hour window is the first 8 segments.

**Design.**
- A new `rain` slice on `WeatherSource`. Google's minute forecast owns it. Without it, `rainSoon` is built from the hourly probability and says so (`modelled`, coarser).
- One owning function, `rainSoon(slice, at, minutes = 120)`, returns `{ startsInMin?, endsInMin?, chance, mm, intensity }`, or nothing when the window is dry. Every consumer calls it.
- Poll every 15 minutes, which matches the segment length. At that rate it is about 2,900 calls a month. The existing code assumes 10,000 free calls a month across the key; whether that figure covers this endpoint is unverified.
- Unknown stays unknown: a failed read keeps the last good slice with its `asOf`, and a segment with no probability is not read as dry.

## Hourly forecast and one condition word

chota's morning print needs an hourly slice (rain chance, mm, condition) for lines such as "rain 2–4pm". Add `hourly` to the weather slices. Sources give conditions as BOM codes 1–19, WMO codes or Google type names. One function maps them to a small set (clear, cloudy, rain, storm …) and keeps the source's own text beside it.

## The calendar connector

`src/connectors/calendar/`, `iot_class` cloud_polling, polled every 15 minutes, `refresh()` as for the others.

**Sources.** One `CalendarSource` shape, as the weather has `WeatherSource`.

| | Google Calendar API | ICS feed |
|---|---|---|
| Build | First | Later, when a non-Google calendar is needed |
| Recurring events | Google expands them (`singleEvents=true`) | We expand them ourselves (RRULE) |
| Freshness | Live | Google's secret-address feed lags. Third-party pages say 8 to 48 hours; no Google page found |
| Auth | OAuth token | A secret URL, kept as an env name |
| Fits | Family calendar | School, Apple, Outlook feeds |

**Auth.** The caller passes `getToken(): Promise<string>`. The library stores no token. chota passes its better-auth token. A `home calendar login` in the CLI (loopback OAuth, token file in `~/.config/home/`, 0600, like `home enphase login`) comes later and needs an OAuth client in Google Cloud.

**State.** The next 14 days per calendar, trimmed to id, title, start, end, all-day, location. Not kept by default: description, attendees, links. All-day events are dates, not instants; they use the home's `timeZone` from the config, never the machine's. Weather has this bug today (`hhmm` in `weather/index.ts`). Calendar must not copy it.

**Helpers**, pure: `eventsOn(day)`, `next()`, `search(text)`. One owner for "what is today".

**Push.** Google can post to a public URL when a calendar changes. The library has no server. The caller verifies it and calls `home.refresh("calendar")`, the same pattern as Up's webhooks.

**Config.** Calendar ids go in the home config as `calendars: [{ id, name }]`. They are identifiers, not secrets. Open: KO to confirm.

## Is Google one connector?

No. Home Assistant has separate integrations per Google service, and so do we by the same logic. A connector here is one service with its own auth, cadence and failure modes. Weather uses an API key and a 15-minute poll. Calendar uses a user's OAuth token and a different poll. Joining them gives one folder with two unrelated halves.

Share only what repeats. The rule of three applies: Weather has a key, Calendar has a token, and a helper for Google's error shape waits for a third Google service. Candidates, none researched: Maps Routes travel time ("leave now for school"; overlaps with Transport NSW), and Books (no clear home use).

## Order

1. Read the hourly rain fields and add the `hourly` slice and the condition mapping (no new calls).
2. `rain` slice and `rainSoon` from the minute forecast.
3. Calendar connector, Google source, `getToken` passed in.
4. Transport NSW (`docs/ideas.md`).
5. ICS source, `home calendar login`.

chota-bot's `tools/weather.ts` and `tools/calendar.ts` can then shrink to formatting.

## For KO to decide

1. Use an Experimental Google endpoint for rain soon, with the hourly forecast as the fallback? Recommend yes.
2. Calendar ids in the home config? Recommend yes.
3. First version takes `getToken` from the caller only, with the CLI login later? Recommend yes.
