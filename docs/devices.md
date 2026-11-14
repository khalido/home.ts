# Devices

What this library works with, what is under consideration, and what comes later; then notes on what to buy. Prices are Australian, rough and mostly unverified (2026-10-16 onward); check the shop. The connector survey is in [ideas.md](ideas.md).

## Works with this library

Each has a connector; its README says what has run on a real device.

| Device or service                                                                                            | Connector                                        | Reads                                                         | Writes                                       | Live on a real device |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------- | --------------------- |
| Philips Hue bridge, its lights, rooms, zones, scenes and motion sensors                                      | [hue](../src/connectors/hue/README.md)           | state, pushed                                                 | lights, rooms, scenes, all off               | yes                   |
| Daikin AC with the dsiot local API (Alira X and others)                                                      | [daikin](../src/connectors/daikin/README.md)     | power, mode, setpoint, room and outdoor temperature, humidity | power, mode, setpoint                        | yes                   |
| Enphase IQ Gateway (Envoy)                                                                                   | [enphase](../src/connectors/enphase/README.md)   | solar, use, grid                                              | none                                         | yes                   |
| Google Cast: Nest Mini, Nest Audio, Google Home, Nest Hub and Hub Max, Chromecast, Google TV, speaker groups | [cast](../src/connectors/cast/README.md)         | what is playing, volume                                       | announce (MP3, AAC, WAV), volume, mute, stop | yes                   |
| AirPrint printers (Brother HL-L2350DW tried)                                                                 | [printers](../src/connectors/printers/README.md) | state, toner, paper                                           | print a PDF, identify, cancel                | yes                   |
| Spotify Soloist, a headless Spotify Connect speaker on a Pi                                                  | [spotify](../src/connectors/spotify/README.md)   | what is playing, volume                                       | play, pause, volume, queue, duck, interrupt  | yes                   |
| Amber Electric (prices)                                                                                      | [amber](../src/connectors/amber/README.md)       | import and feed-in prices, forecast                           | none                                         | yes                   |
| Up Bank (spending)                                                                                           | [up](../src/connectors/up/README.md)             | spending by category                                          | categories, tags                             | yes                   |
| Weather: BOM, Open-Meteo, Google Weather                                                                     | [weather](../src/connectors/weather/README.md)   | now, forecast, rain soon, the sun                             | none                                         | yes                   |

## Under consideration

Each would be one connector over a local API, the shape the library already has. None is bought or built yet.

- **ESPHome devices.** ESP32 boards running ESPHome firmware: plugs, sensors, relays. Each has its own local HTTP API with a live event stream (`web_server`), so the library would read and switch them directly, with no Home Assistant and no MQTT broker. They don't join the Hue bridge or appear in Google Home by themselves; some ship a Matter version that does. Candidates: Athom plugs with energy monitoring (sold for Australia), Apollo MSR-2 presence and AIR-1 air quality. Unverified: AU prices, and how the event stream behaves over hours. Source: the Gemini research pass, 2026-11-13; [ESPHome web server](https://esphome.io/components/web_server/).
- **Shelly plugs and energy meters.** Local JSON-RPC with push, energy per plug; the best template for an energy connector ([ideas.md](ideas.md)).
- **AirGradient ONE.** Indoor CO2, PM2.5, temperature and humidity over a local `/measures/current`; it would give `ventilation` an indoor reading in every room, not just where the AC is. Unverified in AU.
- **An EV charger** (Tesla Wall Connector, OpenEVSE): charge when solar is high, with Enphase and Amber. Only with a car.
- **Software, the way Soloist is:** Pi-hole or AdGuard (DNS health, pause blocking for 15 minutes); OwnTone or Snapcast (AirPlay and synced music in every room); Music Assistant. Each is a daemon on the Pi with a local API.

## Future

Waiting on something else first.

- **Matter and Thread sensors** (IKEA TIMMERFLOTTE, MYGGBETT, KLIPPBOK, Aqara, Eve): cheap, local, and in Google Home, but readable here only once a Matter controller exists ([matter.md](matter.md)). Notes on each are below.
- **Presence** (Aqara FP2, FP300; Apollo MSR-2 if ESPHome lands): rooms where people sit still.
- **Garage door** (OpenGarage, ratgdo), **irrigation** (OpenSprinkler), **blinds**, **ceiling fans** (Tuya local key or an RF bridge): only with the hardware.
- **An e-ink house display** (TRMNL): a screen for `houseSummary` on the wall.
- **Home Assistant Connect AUX-2** (US$69, 2026-11-11, [post](https://www.home-assistant.io/blog/2026/11/11/no-device-left-behind-home-assistant-connect-aux-2/)): a PoE box with RS-232 ports, optical and analog audio, USB (RS-485 Modbus with an adapter, Z-Wave), Grove sensors and a Bluetooth proxy, built for Home Assistant and ESPHome. Worth it here only for a device that speaks RS-232 (an amplifier, a TV) or to put an old amp on the network as a speaker; a Pi with a USB serial adapter does the serial part. Whether it has an API usable without Home Assistant is not in the post; if it runs ESPHome, the ESPHome connector above would reach it. No IR.

## Buy first (notes, 2026-10-16)

1. **Shelly Plus Plug S or PM Mini Gen3** (about A$35–45, unverified). Local JSON-RPC, push, energy per plug. The best template for an energy connector, already in ideas.md.
2. **Shelly EM Gen3 or Pro 3EM** (about A$60–200, unverified) if the board has room. A second, independent view of the house against Enphase. Local API.
3. **IKEA TIMMERFLOTTE** (A$14.99 on ikea.com/au, checked 2026-10-16). Cheapest Matter-over-Thread climate sensor with a display. Verdict below.
4. **A mmWave presence sensor**: Aqara FP2 (Wi-Fi, Matter via the Aqara hub, unverified) or a battery Thread sensor such as the Aqara FP300. Presence from a router's view of phones flaps; a real sensor does not.
5. **Leak sensors, any Thread or Zigbee kind** (IKEA KLIPPBOK, about A$15, unverified in AU). Cheap, and the one alert worth having.

## TIMMERFLOTTE verdict

Buy two or three and treat the numbers as indicative, not calibrated. Don't use it to drive heating or cooling decisions that need tenths of a degree.

- **Facts checked on [ikea.com/au](https://www.ikea.com/au/en/p/timmerflotte-temperature-humidity-sensor-smart-00618950/):** A$14.99, article 006.189.50, Matter over Thread, needs a Thread border router (a recent eero or a Nest Hub is one). Two AAA cells, not included; IKEA recommends LADDA rechargeables. A$12.99 for four. A small display shows temperature then humidity when you press the front. 4 out of 5 from 451 reviews.
- **Stated accuracy:** none on the AU page or in the reviews I could read. Sensor chip: not published, unverified. Reporting interval: not published, unverified. Thread sensors normally report on a change threshold plus a slow heartbeat; check the Matter cluster in the controller.
- **Tests:** [Matter Alpha](https://www.matteralpha.com/review/ikea-timmerflotte-review) liked it, gave no numbers, and said battery life is "months", not a figure. [Chris Smart](https://chrissmart.de/en/ikea-timmer-fleet-in-test-new-matt-sensor/) compared it with reference sensors and called the values "realistic and stable", also without numbers. [T3](https://www.t3.com/home-living/smart-home/ikea-timmerflotte-temperature-and-humidity-sensor-review-a-budget-friendly-way-to-monitor-your-home-environment) reports hardly any difference from a smart thermostat. I found no published side-by-side with a calibrated reference, and no Reddit or Home Assistant forum thread I could open (search blocked there), so the accuracy question is open.
- **Buyer complaints on IKEA stores:** one unit read more than 2 degrees off; humidity less accurate than temperature; some units drop off Thread every few weeks to months until the batteries are swapped; the battery percentage barely falls before the sensor stops; a button that stopped working. Anonymous and a small sample, but the drop-off reports are the real risk.
- **Google Home:** Google's [supported-devices page](https://developers.home.google.com/matter/supported-devices) lists the Matter temperature sensor and humidity sensor types, so it should pair and show both. One AU buyer reported failing to connect to Google Home. I found no test of how the app displays humidity. Unverified; try one unit first.
- **This library:** readable only through a Matter controller. Temperature and humidity are standard clusters, so no per-device code.

## Temperature and humidity

| Device                            | Radio                   | Local? | Google Home?             | AU price                   | Notes                                         |
| --------------------------------- | ----------------------- | ------ | ------------------------ | -------------------------- | --------------------------------------------- |
| IKEA TIMMERFLOTTE                 | Thread (Matter)         | yes    | yes, unconfirmed display | A$14.99                    | display on press, 2 AAA                       |
| Aqara TH sensor (Matter versions) | Thread / Zigbee         | yes    | yes                      | about A$25–35, unverified  | ±0.3 °C / ±3 %RH claimed by Aqara, unverified |
| Eve Weather / Room                | Thread (Matter)         | yes    | yes                      | about A$80–100, unverified | better-known accuracy, pricey                 |
| SwitchBot Meter                   | Bluetooth, hub to cloud | partly | via hub                  | about A$20–30              | local needs the hub's API; skip               |

Buy the IKEA unit for rooms. Buy Eve or Aqara only where accuracy matters. Battery life on all of these is months to two years on AAA or coin cells.

## Motion, occupancy and presence

| Device            | Radio                       | Local?      | Google Home? | AU price                    | Notes                                |
| ----------------- | --------------------------- | ----------- | ------------ | --------------------------- | ------------------------------------ |
| IKEA MYGGSPRAY    | Thread (Matter)             | yes         | yes          | unverified                  | indoor/outdoor motion                |
| Aqara FP2         | Wi-Fi, Matter via Aqara hub | yes via hub | yes          | about A$110–130, unverified | mmWave, zones; needs power           |
| Aqara FP300       | Thread / Zigbee             | yes         | yes          | unverified                  | battery mmWave, newer                |
| Hue motion sensor | Zigbee on the bridge        | yes         | via Hue      | about A$55–70               | already covered by the hue connector |

The Hue bridge already exposes its motion sensors; that is free. Add mmWave only for rooms where people sit still.

## Door and window contacts

| Device                  | Radio           | Local? | Google Home? | AU price               | Notes |
| ----------------------- | --------------- | ------ | ------------ | ---------------------- | ----- |
| IKEA MYGGBETT           | Thread (Matter) | yes    | yes          | unverified             |       |
| Aqara contact sensor P2 | Thread (Matter) | yes    | yes          | about A$30, unverified |       |
| Eve Door & Window       | Thread (Matter) | yes    | yes          | about A$60, unverified |       |

Google lists the contact sensor type as supported. CR2032 cells last 1–2 years.

## Leak sensors

| Device                  | Radio           | Local? | Google Home?         | AU price               | Notes       |
| ----------------------- | --------------- | ------ | -------------------- | ---------------------- | ----------- |
| IKEA KLIPPBOK           | Thread (Matter) | yes    | not listed by Google | unverified             | cheapest    |
| Aqara water leak sensor | Zigbee / Thread | yes    | via hub              | about A$25, unverified |             |
| Eve Water Guard         | Thread          | yes    | unverified           | unverified             | cable probe |

Google's page has no leak-detector device type. The alert would show in another controller (or this library) but not in Google Home. Unverified for each model.

## Air quality (CO2, PM2.5)

| Device                     | Radio           | Local?            | Google Home? | AU price   | Notes                                                 |
| -------------------------- | --------------- | ----------------- | ------------ | ---------- | ----------------------------------------------------- |
| Aqara TVOC sensor          | Zigbee          | yes               | via hub      | unverified | VOC only, no CO2                                      |
| Airthings / Awair          | Wi-Fi / BLE     | local API on some | unverified   | A$200+     | CO2 and PM2.5 properly                                |
| IKEA VINDSTYRKA / ALPSTUGA | Zigbee / Thread | yes               | unverified   | unverified | PM2.5, ALPSTUGA adds CO2 per IKEA's range, unverified |

Google supports the Matter air quality type (spec 1.2). Cheap CO2 sensors vary a lot; a local API or Matter matters more than the brand.

## Smart plugs with energy monitoring

| Device                         | Radio           | Local?                             | Google Home?               | AU price                  | Notes                                  |
| ------------------------------ | --------------- | ---------------------------------- | -------------------------- | ------------------------- | -------------------------------------- |
| Shelly Plus Plug S / Mini Gen3 | Wi-Fi (+BT)     | yes, JSON-RPC and MQTT             | no (not Matter by default) | about A$35–45, unverified | library-friendly                       |
| IKEA GRILLPLATS                | Thread (Matter) | yes                                | on/off yes                 | AU variant unverified     | energy through Google is not supported |
| Eve Energy                     | Thread (Matter) | yes                                | on/off yes                 | about A$60–70, unverified |                                        |
| Sonoff S60 / Tapo P110         | Wi-Fi           | Sonoff local mode; Tapo cloud-tied | partial                    | about A$20–30             | Tapo protocol churns (see ideas.md)    |

Google's page lists the plug type with only On/Off and Level Control, so power readings will not show in the app. Use Shelly for the numbers, and Matter plugs only where on/off is the point.

## Buttons and remotes

IKEA BILRESA (two-button and scroll-wheel; Thread, Matter) is the cheap one, a few dollars in Europe, AU unverified. Hue dimmer and Aqara buttons work if you already run those hubs. Buttons need a controller to act; nothing for this library to read.

## Ceiling fans

DC ceiling fans come two ways. Some have Wi-Fi built in, usually Tuya (the Smart Life app): those can be read and driven locally once their local key is pulled from a Tuya developer account, the way tinytuya does. Most use an RF remote: a vendor Wi-Fi module (often Tuya again), or a bridge that learns the remote (Bond Bridge, Broadlink RM4 Pro), which sends commands but cannot read the fan's state. A wall relay gives on/off only, not speed. Check the model before buying a module; compatibility lists differ between retailers.

## Blinds

Google supports the Matter window covering type. IKEA and Aqara motors, and SwitchBot Curtain (Bluetooth, hub needed), exist; prices and Matter status in AU unverified. Only buy if a window is hard to reach.

## Energy monitoring

| Device                   | Radio           | Local?                     | Google Home? | AU price                    | Notes                                                     |
| ------------------------ | --------------- | -------------------------- | ------------ | --------------------------- | --------------------------------------------------------- |
| Shelly Pro 3EM / EM Gen3 | Wi-Fi, Ethernet | yes, JSON-RPC              | no           | about A$100–200, unverified | clamps on the board; needs an electrician for the install |
| Enphase IQ Gateway       | LAN             | yes, the enphase connector | no           | comes with the solar        | covers solar and use                                      |

Enphase gives solar and use. A Shelly on a circuit (AC, hot water, pool) tells you what one load costs, which Amber prices make worth knowing.

## Water and gas

Nothing worth buying. Utility meters have no public local API (ideas.md). Clamp-on pulse readers exist but are installer jobs. Skip.

## Matter in one paragraph

Matter is the application layer: a common set of device types and clusters (temperature, occupancy, on/off) so one controller reads many brands. Thread is one radio it can ride on, a low-power mesh that suits battery sensors and needs a border router (recent eeros, Nest Hubs, Apple TVs). Wi-Fi Matter devices skip Thread. A device joins a fabric by a commissioning code (a QR or 11-digit setup code) that sets up an encrypted session; after that every message is encrypted and signed, and each fabric holds its own operational certificate for each node, so a second controller (matter.js beside Google Home) gets its own fabric and its own keys via a share code, and removing one does not touch the other. The device's own attestation certificate proves it is the certified product. The catch for this library: it is local and standard, but needs a controller that stores fabric keys in a file, which the library never does.

## Sources

- [IKEA AU TIMMERFLOTTE](https://www.ikea.com/au/en/p/timmerflotte-temperature-humidity-sensor-smart-00618950/)
- [Matter Alpha review](https://www.matteralpha.com/review/ikea-timmerflotte-review)
- [Chris Smart test](https://chrissmart.de/en/ikea-timmer-fleet-in-test-new-matt-sensor/)
- [T3 review](https://www.t3.com/home-living/smart-home/ikea-timmerflotte-temperature-and-humidity-sensor-review-a-budget-friendly-way-to-monitor-your-home-environment)
- [Matter Alpha: IKEA's 21 Matter devices](https://www.matteralpha.com/news/ikea-launches-21-new-smart-home-devices-with-native-matter-support)
- [Google Home supported Matter device types](https://developers.home.google.com/matter/supported-devices)
- [CSA listing, TIMMERFLOTTE](https://csa-iot.org/csa_product/timmerflotte-temp-hmd-sensor/)
- [Home Assistant Shelly integration](https://www.home-assistant.io/integrations/shelly/)
- [matter.js](https://github.com/project-chip/matter.js)
