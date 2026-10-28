# @khalido/home

My house as a TypeScript import: Philips Hue, a Daikin AC, Enphase solar, Google Cast speakers and screens, and AirPrint printers on the local network, plus Amber Electric's live prices, Up Bank spending and the weather. One small library and a `home` command. No server, no cloud of its own.

- Read every device into one typed snapshot, kept current by event stream or on a timer.
- Turn lights on, set the AC, change speaker volume. Writes are spaced and merged, so a burst never floods a device.
- Find what answers on your network, and check it read-only from the terminal.
- Combine solar, grid and price into one energy figure.

## Try it

Needs [Bun](https://bun.sh) 1.4 or newer. Not on npm yet, so clone it:

```sh
bun install
bun test        # runs on fixtures, no device needed
bun link        # puts `home` on your PATH
home discover   # what answers on this network, and which of it this package supports
home probe      # read-only checks, no keys
home            # each connector: connected, or what it still needs
```

Copy [.env.example](.env.example) to `.env` and fill in the connectors you have, or describe the home in a [config file](docs/config.md) ([example](examples/home.jsonc)).

## Use it from code

Weather needs no key or device, so this runs anywhere:

```ts
import { createHome } from "@khalido/home";
import { weather } from "@khalido/home/weather";

const home = createHome([weather({ latitude: -33.87, longitude: 151.21 })], (snapshot) => console.log(snapshot));
home.start(new AbortController().signal); // connects, reads, keeps reading, reconnects
home.part("weather")?.state;              // typed by name, read from memory, never from the device
```

The library never reads your environment or a file: you pass addresses, keys and a `fetch`. Under Node, Hue and Enphase take the fetches in `@khalido/home/node`. From a clone, run `bun run build` first: the package's entry points resolve to `dist/`. More in [using it from an app](docs/using.md).

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
| [weather](src/connectors/weather/README.md) | now, forecast by the hour and by part of the day, rain soon, the sun, from BOM, Open-Meteo and Google | none |

Each connector's README says what has run against a real device and what has not. This covers only the devices I own; [Home Assistant](https://www.home-assistant.io/) is the inspiration and the reference for every protocol.

## More

- [The `home` command](docs/cli.md) and [the home config](docs/config.md)
- [Why it is shaped this way](docs/philosophy.md) and [decisions](docs/decisions.md)
- To add a connector, follow [AGENTS.md](AGENTS.md)

I use it from jaldi, a Mac launcher (Bun), and chota-bot, a family bot (Node); the docs name both.

## Licence

MIT. Each connector's README lists its sources and their licences. Two Daikin sources are GPL-3.0 and are read for facts only, never copied.
