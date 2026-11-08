# Using the library from Bun and Node

## Before you start: reserve device addresses

Give every device a fixed address in your router (a DHCP reservation; eero, UniFi and most routers have one): the Hue bridge, the Enphase gateway, the AC. The library takes addresses as parameters and the CLI reads them from the environment; discovery (`home discover`) finds devices, but mDNS and UDP broadcasts miss now and then, and a device on the guest Wi-Fi is invisible to the main network.

## Bun and Node

**Bun** (jaldi): leave out `fetch` and `hue()` pins with Bun's `tls` fetch option.

**Node** (chota-bot): Node's `fetch` takes no CA, so Hue and Enphase need the fetches in `@khalido/home/node`, built on undici:

```ts
import { NODE_TLS, nodePinnedFetch } from "@khalido/home/node";
loadHome(config, { env: process.env, readFile, tls: NODE_TLS }); // from a home config
hue({ host, bridgeId, key, ca, fetch: nodePinnedFetch(bridgeId, ca) }); // or one integration
```

Checked on Node 24.20 and 26.11 against a local TLS server (2026-10-28): the right CA and CN pass, another certificate or CN is rejected. Not yet against a real bridge.

Pairing, pinning, the event stream and the rate limits are in [`src/connectors/hue/README.md`](../src/connectors/hue/README.md). On the local network the bridge still needs an application key: without one it answers 403. `home pair` gets one with the link button; no cloud account is involved.

## One home

```ts
import { createHome, health, loadHome } from "@khalido/home";

const home = createHome(loadHome(config, options), (snapshot, change) => {
  if (change.after.status !== change.before.status) log(`${change.name}: ${change.before.status} → ${change.after.status}`);
});
home.start(signal);
home.part("weather")?.state;           // typed by name, read from memory
await home.refresh("amber");           // read now; resolves at its next report
health(home.snapshot(), Date.now());   // per integration: ok, stale or down, with lastGoodAt, downSince and the thresholds
```

`createHome` stamps each part with `lastGoodAt` (its last good read) and `downSince` (when it stopped being connected). `health` judges from those: a polling connector is stale after 2½ polls with no good read and down after 3 polls not connected; Hue and Cast are down after 2 minutes not connected. Health takes each connector's interval from its manifest; a home that changes one (the weather's `pollMinutes`) passes it: `health(snapshot, now, { pollSeconds: { weather: 60 * 60 } })`. For a one-shot read (a script, a printed brief), `settle(integrations, { ms })` runs them until each has answered and returns the snapshot.

## Writes

Writes hang off the integration: `home.integration("daikin")?.client.write(setMode("cool"))`, `home.integration("hue")?.client.recallScene(id)`, `home.integration("cast")?.setVolume(…)`, `home.integration("spotify")?.play(link)`. Each goes through the device's write lane: spaced, and a burst to one light or the AC merges so the last value lands.

## Text for people and agents

Each connector's manifest turns its part into lines: `manifest.lines(part)`, the first line its summary (`import { manifest } from "@khalido/home/amber"`). The text helpers say the same in one line: `weatherText`, `blockText`, `acText`, `enphaseText`, `amberText`, `castText`, `printerText`, `spotifyText`, `upText`.

## Energy

`energyNow(enphase, amber)` is solar, use, grid flow and its cost now. `bestWindow(amber.forecast, 2, { by: "price", from: Date.now() })` is the cheapest 2 hours ahead in Amber's forecast; `by: "renewables"` the greenest.

## Testing an app without devices

An `Integration` is a name, `run` and `refresh`, so a fixed part is a few lines:

```ts
const fixed = <S>(name: string, part: Part<S>): Integration<S> => ({
  name,
  refresh() {},
  run: (signal, update) => new Promise((done) => (update(part), signal.addEventListener("abort", () => done()))),
});
```
