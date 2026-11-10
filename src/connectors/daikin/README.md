# Daikin

Reads one Daikin AC over its local JSON `dsiot` API. `iot_class`: **local_polling**. KO's unit is a Daikin Australia **Alira X** with built-in Wi-Fi (likely; it reports a blank model string).

- `client.ts`: `daikinClient({ host, fetch }).read()` returns `DaikinState` (power, mode, the selected mode's setpoint and fan speed, room °C, humidity, outside °C, `anomaly`). `setPower`, `setMode`, `setTarget`, `setFan` build write requests; `client.write(request)` sends one, through a write lane: 1 s apart and at most 20 a minute (guesses), a waiting write merging the next one field by field (`mergeWrites`). Every request times out at 10 s.
- `index.ts`: `daikin({ host, fetch, clock })` reads now, then every **120 s** (Home Assistant's `update_interval`). A failed poll is `disconnected` and keeps the last reading with `asOf`; a 404 on `/dsiot/multireq` is a failed read too, saying "not a dsiot Daikin": the address may now be another device's, so discovery looks for the unit. There is no key, so nothing is terminal. Writes go through `daikin().client.write(…)`: one client for the integration's life, at the unit's current address.
- `home status` reads `DAIKIN_HOST`, or a home config's address, with discovery by `mac` if the unit moves. There is no CLI command that writes.

## The protocol

Plain HTTP on port 80, no key, no registration. Everything is one endpoint, `POST /dsiot/multireq`, with `{"requests": [...]}`.

- **Discovery**: a UDP broadcast of `DAIKIN_UDP/common/basic_info` to port 30050 from port 30000 gets a `key=value` answer (KO's unit: `type=GPF`, `protocol=DGC`, `ver=3_12_3`, `api_ver=2_2`). Home Assistant also matches the zeroconf type `_dkapi._tcp`, which `home discover` now looks for.
- **Read** (`op: 2`): `/dsiot/edge/adr_0100.dgc_status?filter=pv,pt,md` (indoor unit, tree under `e_1002`) and `/dsiot/edge/adr_0200.dgc_status?filter=pv,pt,md` (outdoor unit, `e_1003`), in one request. Each response carries `rsc`; `2000` is OK. Every value is a hex string `pv`, and `md` gives the unit's own step (`st`), min (`mi`) and max (`mx`).
- **Values are read by name**, never by position in the child list. Multi-byte values are little-endian; temperatures are signed.

| Path                                         | Meaning                       | Decoding                                                      |
| -------------------------------------------- | ----------------------------- | ------------------------------------------------------------- |
| `e_1002/e_A002/p_01`                         | power                         | `00` off, `01` on                                             |
| `e_1002/e_3001/p_01`                         | mode                          | `0000` fan, `0100` heat, `0200` cool, `0300` auto, `0500` dry |
| `e_1002/e_3001/p_02`, `p_03`, `p_1D`         | setpoint for cool, heat, auto | one byte, °C × 2                                              |
| `e_1002/e_3001/p_09`, `p_0A`, `p_26`, `p_28` | fan for cool, heat, auto, fan | `0300`–`0700` speeds 1–5, `0A00` auto, `0B00` quiet           |
| `e_1002/e_A00B/p_01`                         | room °C                       | signed byte, whole degrees (`mi F7` is −9)                    |
| `e_1002/e_A00B/p_02`                         | humidity %                    | byte                                                          |
| `e_1003/e_A00D/p_01`                         | outside °C                    | signed little-endian, °C × 2 (`mi EEFF` is −9 °C)             |

Dry mode has no setpoint or fan field in this map, so both read as undefined there rather than a default. An unknown mode, fan or power code is left undefined and named in `anomaly`.

- **Write** (`op: 3`): the same `to` without the filter, and a `pc` tree `dgc_status → e_1002 → <entity> → {pn, pv}`; several fields can share one tree. `setMode` writes power `01` with the mode, as both sources do. `setTarget` writes one uppercase byte (25 °C is `32`) to the given mode's field and throws, never rounds, off 0.5 steps or outside that field's `mi`–`mx` on KO's unit (cool 18–32, heat 10–30, auto 18–30). `write` fails on an `rsc` of 4000 or more.

## What KO's unit answered (2026-10-13)

One read-only request, saved with the MAC, SSID, `edid` and the unit's ASCII ids removed as `test/fixtures/daikin/status.json`. All three responses `rsc 2000`. Decoded: **off, cool, target 25 °C, room 24 °C, humidity 70%, fan 3, outside 19.5 °C** (`2700`). `adp_i`: `ver 3_12_3`, `api_ver 2_2`, `reg th`. `home status` printed the same line live.

## Energy (2026-10-15)

`POST /dsiot/multireq` with `op: 2` to `/dsiot/edge/adr_0100.i_power.week_power` answered `rsc` 2000 with `week_power/today_runtime` (0 while the unit was off), `week_power/datas` (seven numbers) and `week_power/datas2` (seven numbers); the values were multiples of 100. The same path under `adr_0200`, and `adr_0100.i_power` and `.today`, answered 4041. **Unconfirmed**: the unit of the numbers, which end of the array is today, what `datas2` splits from `datas`, and whether they are measured or estimated. Compare them with the Daikin app's weekly graph before reading them as kWh. Not built.

## Unconfirmed

- **The write lane's rates** (1 s apart, 20 a minute) are guesses. One client lives as long as the integration and reads the unit's address at each send, so a move keeps the lane's count, and a write still waiting goes to the new address.
- **Writes other than power.** Only `setPower(true)` has been sent to KO's unit (2026-10-16, Bun 1.4.3, see below); mode, setpoint and fan writes are untried. The encodings come from pydaikin, which reports verified live writes on other BRP084 units. The two sources disagree in three places, plus one choice of our own, settled here as follows:
  - Setpoint width: pydaikin sends one byte, Alira two (`3200`). One byte, because the live field is one byte (`p_02` `mi 24`, `mx 40`).
  - Method: pydaikin POSTs, Alira PUTs. POST, the method reads already use.
  - Field: Alira always writes `p_03` and `p_0A`. Those are pydaikin's heat-mode setpoint and fan, and Alira reads by list position (its `[2]` and `[8]` are `p_03` and `p_0A`), so it appears written on a unit in heat. Per-mode fields here.
  - Hex case: pydaikin sends lowercase (`32`), this sends uppercase, matching what the unit reports (`EEFF`).
- The success `rsc` for a write: the indoor unit's answer must be under 4000. pydaikin does not check it; it re-reads the state, which the first watched write should do too.
- Whether firmware updates move these paths, and what `reg=th` means.

## First write (2026-10-16)

`setPower(true)` at KO's request: the unit answered under 4000, and a re-read 8 s later showed `on: true` (before: off, cool 25 °C, room 20 °C, outside 15 °C, 75 % humidity; after: room 21 °C). The POST, one-byte payload and uppercase hex were accepted as built. Mode, setpoint and fan writes remain untried.

All setpoint and fan fields, read from `e_3001` with `md` (setpoint is one byte, °C × 2, and `md.st` is 245 on all of them):

| Field          | Meaning            | Value           | Range |
| -------------- | ------------------ | --------------- | ----- |
| `p_02`         | cool setpoint      | 25 °C           | 18–32 |
| `p_03`         | heat setpoint      | 25 °C           | 10–30 |
| `p_1D`         | auto setpoint      | 24 °C           | 18–30 |
| `p_09`, `p_0A` | cool, heat fan     | `0500`, speed 3 |       |
| `p_26`, `p_28` | auto, fan-mode fan | auto, speed 5   |       |

Unmapped and unread: `p_27` (`0A00`, like auto), `p_34` (one signed byte, `00`, `mi FA`, `mx 00`), and the `p_05`–`p_08`, `p_20`–`p_25` fields (3- and 4-byte values, mostly `0F…`, likely schedules or limits). Meaning unknown.

## Read from a Pi (2026-11-10)

`home daikin` on 0.1.2 (Bun 1.4.4; chota-bot's session): "connected · off · dry · room 26 °C · outdoor unit 28 °C". `home discover` found the unit by UDP. No write was sent.

## Sources

Both Daikin protocol sources are GPL-3.0, so they are read for facts only (endpoints, field paths, value maps) and no code is copied; that keeps this package MIT.

| Source                                                                                                                                                                              | Licence             | Used for                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [Home Assistant `daikin` integration](https://github.com/home-assistant/core/tree/dev/homeassistant/components/daikin) ([docs](https://www.home-assistant.io/integrations/daikin/)) | Apache-2.0          | `iot_class` `local_polling`, the 120 s poll, zeroconf `_dkapi._tcp`; built on `pydaikin==2.20.0`                          |
| [fredrike/pydaikin](https://github.com/fredrike/pydaikin), `daikin_brp084.py`                                                                                                       | GPL-3.0, facts only | UDP discovery packet, the `dsiot` paths, mode and fan maps, per-mode setpoint and fan fields, write tree, value encodings |
| [cambot1901/ha-daikin-alira](https://github.com/cambot1901/ha-daikin-alira)                                                                                                         | GPL-3.0, facts only | a second account of the read and write requests on an Alira; its sensor polls every 30 s with a 10 s timeout              |

## Energy, second read (2026-10-16)

After the unit ran 15 minutes in cool: `today_runtime` 15, `datas` `[0,0,600,100,0,0,0]`, `datas2` `[0,0,100,0,0,0,100]`. The 2026-10-15 read was `datas` `[100,0,0,600,100,0,0]`, `datas2` `[0,0,0,100,0,0,0]`. So both lists shift one place left per day: oldest first, last is today, and `today_runtime` is minutes. Today's `datas2` rose to 100 while `datas` stayed 0, so `datas2` may be cooling and `datas` heating, in steps of 100 (Wh?). One data point; the units are still unconfirmed, and the figures may be the unit's estimate rather than a metered reading.
