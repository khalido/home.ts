# Using the library from Bun and Node

## Before you start: reserve device addresses

Give every device a fixed address in your router (a DHCP reservation; eero, UniFi and most routers have one): the Hue bridge, the Enphase gateway, the AC. The library takes addresses as parameters and the CLI reads them from the environment; discovery (`home discover`) finds devices, but mDNS and UDP broadcasts miss now and then, and a device on the guest Wi-Fi is invisible to the main network.

## Bun and Node

**Bun** (jaldi): leave out `fetch` and `hue()` pins with Bun's `tls` fetch option.

**Node** (chota-bot, untested): pass a pinned `fetch`, using `Agent` from `undici`:

```ts
import { Agent } from "undici";
const dispatcher = new Agent({ connect: { ca, checkServerIdentity: (_host, cert) => cert.subject.CN === bridgeId ? undefined : new Error("wrong bridge") } });
hue({ ip, bridgeId, key, ca, fetch: (url, init) => fetch(url, { ...init, dispatcher }) });
```

Pairing, pinning, the event stream and the rate limits are in [`src/connectors/hue/README.md`](../src/connectors/hue/README.md). On the local network the bridge still needs an application key: without one it answers 403. `home pair` gets one with the link button; no cloud account is involved.
