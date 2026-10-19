# @khalido/home

My house as a TypeScript import: Philips Hue, a Daikin AC, Enphase solar, Google Cast speakers and screens, and AirPrint printers on the local network, plus Amber Electric's live prices, Up Bank spending and the weather. One small library and a `home` command. No server, no cloud of its own.

```ts
import { createHome } from "@khalido/home";
import { hue } from "@khalido/home/hue";

const home = createHome([hue({ ip, bridgeId, key, ca })], (snapshot) => render(snapshot));
home.start(signal);           // connects, reads everything, follows the event stream, reconnects
home.part("hue")?.state;      // typed by name, read from memory, never from the bridge
```

Each integration keeps its own state current, by event stream or on a timer, so reading the house is a lookup in memory. Each app that imports it runs its own copy and talks to the devices directly; mine are a Mac launcher (Bun) and a Telegram bot (Node). [Home Assistant](https://www.home-assistant.io/) is the inspiration and the reference for every protocol; this covers only the devices I own. Why it is shaped this way: [docs/philosophy.md](docs/philosophy.md).

## Connectors

| Connector | Reads | Writes |
|---|---|---|
| [hue](src/connectors/hue/README.md) | lights, rooms, scenes, over the bridge's event stream | lights, rooms, scenes |
| [daikin](src/connectors/daikin/README.md) | the AC, over its local API | power, mode, setpoint, fan |
| [enphase](src/connectors/enphase/README.md) | solar production and consumption from the IQ Gateway | none |
| [cast](src/connectors/cast/README.md) | every Cast device and speaker group | volume, mute, stop, announcements |
| [printers](src/connectors/printers/README.md) | AirPrint printers over IPP: state, toner, paper | none |
| [amber](src/connectors/amber/README.md) | live import and feed-in prices | none |
| [up](src/connectors/up/README.md) | household spending by category, what still needs one | a category or tag on a transaction |
| [weather](src/connectors/weather/README.md) | now, forecast, rain soon, the sun, from BOM, Open-Meteo and Google | none |

Each connector's README says what has been tried on a real device and what has not. Writes are spaced and coalesced, so a burst of changes never floods a device and the last one always lands.

## Install and run

Not on npm yet. Clone it, then:

```sh
bun install && bun test        # tests run on fixtures; no device needed
bun link                       # puts `home` on your PATH
home                           # each connector: connected, or what it still needs
home discover                  # what answers on this network, and which of it this package supports
home probe                     # read-only checks, no keys
```

The library never reads your environment or a file: callers pass addresses, keys and a `fetch`. The `home` command reads the names in [.env.example](.env.example), or a home config. Developed on Bun; Hue and Enphase need Bun's `fetch` today, the rest also runs on Node.

More: [using it from an app](docs/using.md), [the home config](docs/config.md), [the `home` command](docs/cli.md), [decisions](docs/decisions.md), [ideas](docs/ideas.md), [devices worth buying](docs/devices.md). To add a connector, follow [AGENTS.md](AGENTS.md).

## Licence

MIT. Each connector's README lists its sources and their licences. Two Daikin sources are GPL-3.0 and are read for facts only, never copied.
