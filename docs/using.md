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
