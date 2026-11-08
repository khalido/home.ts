# Amber

Amber Electric's live wholesale-linked prices, read through Amber's public API. Cloud, not local: one HTTPS call with a key. `iot_class`: **cloud_polling**, every 60 s.

## Built

- `amber({ key, fetch })` finds the account's active site once, then polls `GET /v1/sites/{id}/prices/current?next=96` every 60 s (Home Assistant's amberelectric integration polls every minute too). One call took about 270 ms with `next=1` (measured, Bun 1.4.2); `next=96` returns about 52 intervals instead of 3.
- `toPrices` keeps the **CurrentInterval** of each channel: `importCents` (general), `exportCents` (feed-in, sign flipped so it reads as what you are paid), `priceDescriptor` (the general channel's descriptor) and `exportDescriptor`, `spike` (Amber's own `spikeStatus`: `none`, `potential`, `spike`; the library sets no threshold), `renewables`, `estimate`, and the next interval's import forecast.
- `forecast`: the current interval, then each forecast one, both channels on one row (`PriceInterval`). `next=96` asks for more than Amber has, so the reply runs as far as Amber forecasts: on 2026-10-28 at 3 pm, 12 five-minute intervals then 14 half-hours, to 11 pm. Amber's `startTime` is a second past the interval's start, so `start` is taken to the minute.
- `estimate: true` means the current interval's price can still move; it is shown as "(estimate)", never as an anomaly.
- The Amber line in `home status` shows the descriptor, "(estimate)", a spike other than `none`, and a negative price. `energyNow` combines the prices with Enphase; see Energy below.
- A 401 marks Amber unavailable and stops polling.

## Energy

`energyNow(enphase, amber)` in `src/energy.ts` is the one place the two combine, so the CLI, jaldi and the bot show the same numbers.

- **Now**: solar, use, grid flow, and what the grid flow costs or earns per hour (`centsPerHour`), plus Amber's descriptor, spike and estimate.
- **Negative prices**: `negativePrice` is "paid to use" when the import price is below zero, else "exporting at a loss" when the feed-in price is. Both can hold in one interval; the import side wins.
- **Surplus**: `surplusW` is the export as a positive number (`-gridW` while exporting, else 0; undefined with no grid reading), and `surplusCentsPerHour` what it earns at the export price, negative when exporting costs you, never clamped.
- **Best window**: `bestWindow(forecast, hours, { by, from })` is the cheapest run of `hours` by import price, or the greenest by renewables, averaged by time over unbroken intervals; undefined when the forecast is shorter or broken. An average some interval lacks is left out (a greenest window can have no `importCents`). A forecast row whose times do not parse is left out and counted in `anomaly`. It ranks by `perKwh`, not Amber's `advancedPrice.predicted` (14.70c against 15.56c on the first forecast interval of the fixture). On the 2026-10-28 forecast (`test/fixtures/amber/forecast.json`, read at 3 pm Sydney) the cheapest 2 hours were 3:40–5:40 pm at 13.7c. Solar is not in it: Enphase has no forecast.
- **Renewables above 100%**: the same forecast has 101.17 and 102.6. Passed through as Amber sends them.
- **Flow**: `"importing"`, `"exporting"` or `"balanced"`. Balanced is a display rule: within `BALANCED_W` (20 W) of zero the word and any animation say balanced, so a meter wobbling around zero does not flip; `gridW` and `surplusW` stay as read.
- **Words and drawing**: `gridText(now)` gives the phrase every view shares ("exporting 1.2 kW, earning 42 c/h"), which `home status` prints in its `now` line. `solarLevel(now, capacityW)` scales solar for a drawing against the array's rated size or, without it, today's peak, and says which.

## What the API said (KO's account, 2026-10-13)

- `GET /v1/sites`: one active site, its network named, `intervalLength: 5`, channels `general` and `feedIn`.
- `GET …/prices/current?next=1&previous=1`: for each channel an `ActualInterval`, a `CurrentInterval` (with `estimate`) and a `ForecastInterval` (with `advancedPrice`). Fields: `perKwh` and `spotPerKwh` (c/kWh incl. GST), `renewables` (%), `descriptor`, `spikeStatus`, `startTime`, `endTime`, `nemTime`, `tariffInformation`.
- **Rate limit** from the response headers: `ratelimit-policy: 50;w=300`, so 50 calls per 5 minutes. A 60 s poll uses 5.
- **Feed-in sign**: the feed-in `perKwh` was −35.3 with spot at +33.1 and descriptor `high`, so a negative feed-in price means you are paid. Amber's spec does not say this; it is inferred from the live reply. A positive feed-in price would mean exporting costs you.
- Prices move in 5-minute intervals and the current one is revised until `estimate` is false, so polling faster than a minute adds nothing; slower than 5 minutes misses intervals.

## Sources

| Source                                                                                                                   | Licence        | Used for                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Amber developer page](https://app.amber.com.au/developers)                                                              | Amber's terms  | the key and the API                                                                                                                                                                                        |
| [amberelectric/public-api](https://github.com/amberelectric/public-api) (`swagger.json`)                                 | MIT per GitHub | endpoints, field enums (`descriptor`: extremelyLow, veryLow, low, neutral, high, spike, and the retired negative; `spikeStatus`: none, potential, spike); the spec is version 1.0 at `/v1`, there is no v2 |
| [Home Assistant `amberelectric`](https://github.com/home-assistant/core/tree/dev/homeassistant/components/amberelectric) | Apache-2.0     | 1-minute poll, current plus forecast intervals                                                                                                                                                             |
