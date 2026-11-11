# Hue: certificates, discovery, write rates, rooms, colour and pairing

What Signify asks of an app on the bridge's local API, what other projects do, and what this library does. Signify's developer pages need a free Hue developer login; KO read them on 2026-11-11 and the points below are from those, in our words. The connector's own file is [src/connectors/hue/README.md](../src/connectors/hue/README.md).

## Links

| Page                                                                                                                                          | For                                                              | Login |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----- |
| [Bridge release notes](https://www.philips-hue.com/en-au/support/release-notes/bridge)                                                        | what each bridge software version changed; check after an update | no    |
| [Using HTTPS](https://developers.meethue.com/develop/application-design-guidance/using-https/)                                                | the two root certificates, CN check, self-signed bridges         | yes   |
| [Hue Bridge Discovery](https://developers.meethue.com/develop/application-design-guidance/hue-bridge-discovery/)                              | mDNS, the cloud endpoint, validating a bridge                    | yes   |
| [Hue System Performance](https://developers.meethue.com/develop/application-design-guidance/hue-system-performance/)                          | latency, how many commands a second                              | yes   |
| [Color Conversion Formulas](https://developers.meethue.com/develop/application-design-guidance/color-conversion-formulas-rgb-to-xy-and-back/) | RGB to `xy` and back, the gamuts                                 | yes   |
| [API v2: getting started](https://developers.meethue.com/develop/hue-api-v2/getting-started/)                                                 | pairing, the key header, resource URLs                           | yes   |
| [API v2: core concepts](https://developers.meethue.com/develop/hue-api-v2/core-concepts/)                                                     | the resource model, the event stream                             | yes   |
| [openhue-api](https://github.com/openhue/openhue-api)                                                                                         | an OpenAPI spec of CLIP v2 (Apache-2.0), no login                | no    |
| [IANA: `hue` service](https://www.iana.org/assignments/service-names-port-numbers/service-names-port-numbers.xhtml?&search=hue)               | the registered mDNS service and its TXT keys                     | no    |

## Certificates

Signify's rules ([Using HTTPS](https://developers.meethue.com/develop/application-design-guidance/using-https/)):

- The local API is HTTPS only, port 443. No fallback to HTTP: a fake bridge could ask for one and collect the key.
- Signify has two private root certificates for bridges: one in use, and a second it may switch to. An app bundles both and validates the bridge's certificate against them.
- The certificate's Common Name is the bridge id. Check it, since the certificate carries no address.
- Today the root signs a bridge's certificate directly. Under the second root there will likely be an intermediate, which the bridge sends in the handshake, so the two roots are still all an app carries.
- Self-signed certificates are gone: the few early bridges that had them were updated (the release notes put this at software 1971060010, 22 May 2025). A bridge that fails validation needs its firmware updated. Trust-on-first-use code can be removed.
- Turning validation off is for development only.
- Keep the connection alive between requests.

| Root                               | Valid to   | SHA-256 of the DER                                                                                |
| ---------------------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `CN=root-bridge, O=Philips Hue`    | 2038-01-19 | `F0:BD:8E:65:09:E8:2F:77:4D:63:BC:00:9D:53:88:C9:69:FE:3D:CF:7D:6D:54:1D:63:51:B7:2B:89:8D:8A:CF` |
| `CN=Hue Root CA 01, O=Signify Hue` | 2050-12-31 | `D8:B8:94:48:B2:AF:8E:16:76:18:5A:C0:72:19:EE:9D:CB:C8:F0:1C:12:2A:02:6A:2A:4B:7B:5C:FE:03:28:B8` |

**What this library does.** Both roots are in the package as `HUE_BRIDGE_ROOT_CA` (`src/connectors/hue/ca.ts`), byte for byte the bundle on Signify's page (compared 2026-11-11), and a test holds the two fingerprints. `bunPinnedFetch(bridgeId)` and `nodePinnedFetch(bridgeId)` trust those two and nothing else, and accept only a certificate whose CN is the bridge id. A caller can still pass its own `ca`. There is no trust-on-first-use and no way to turn validation off.

**Live, 2026-11-11, KO's BSB002 on software 1978545030 (Bun 1.4.4), reads of `/api/0/config` only:**

- Its certificate is `CN=<bridge id>`, issued 9 April 2025 by `root-bridge`, with no intermediate.
- The bundle: accepted. The two roots in the other order: accepted, so Bun reads both from one PEM string. The second root alone: refused ("unable to verify the first certificate"). Another bridge id: refused by the CN check.

**Untried:** a Bridge Pro (BSB003). Others report it chains to the second root through an intermediate (hb-hue-tools, openHAB #20400); nothing here has met one. Node's fetch against a real bridge.

**What others do** (their sources read 2026-11-11):

| Project                   | Approach                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| Home Assistant (aiohue)   | validation off (`ssl=False`)                                                                    |
| node-hue-api, openhue-cli | validation off; node-hue-api compares the CN to the bridge id it read over that same connection |
| openHAB hue binding       | both roots bundled; an option trusts the bridge's own certificate instead                       |
| hb-hue-tools (Homebridge) | both roots bundled, CN and serial checked against the bridge id                                 |
| openhue-go                | both roots bundled, chain checked, no CN check                                                  |
| Raycast's Hue extension   | both roots bundled, CN checked; self-signed support dropped June 2025                           |
| Hue-Sync                  | the first root as a file; the user points `NODE_EXTRA_CA_CERTS` at it                           |

Everyone who bundles carries the same bytes and cites Signify's page. Signify's page tells apps to bundle them; no licence text for the certificates was found.

## Discovery

Signify's rules ([Hue Bridge Discovery](https://developers.meethue.com/develop/application-design-guidance/hue-bridge-discovery/)):

- Discover only at first install, or when the stored address stops answering. Store the address; check it at each start.
- **mDNS** first: service `_hue._tcp`, with `bridgeid` and `modelid` in the TXT record. SSDP is gone.
- **The cloud endpoint**, `https://discovery.meethue.com`: the bridges seen from this network's public address, each with its id and LAN address. At most one request per 15 minutes per client. Empty if the bridge has never been online.
- **A typed address** as the fallback.
- Validate what was found with `GET https://<address>/api/0/config`, which needs no key: name, `bridgeid`, `modelid`, software version.
- Several bridges: list them by id for the person to pick, or start pairing on all and let the button press pick.

**What this library does.** mDNS only (`FINDERS.hue`), matched by bridge id. The address lives in the config or the caller's address cache; `hue()` searches again only after three failed reconnects, and follows the bridge to a new address. `home probe` is the `/api/0/config` check. A typed address is `host` in the config or `HUE_BRIDGE_HOST`.

**Not done:**

- The cloud endpoint. It would find a bridge where mDNS is blocked, at the cost of one request to Signify; nothing here calls a cloud to reach a local device. Worth adding to `home discover` only if mDNS fails someone.
- More than one bridge: the CLI takes the first mDNS answer. A config can list several by `bridgeId`.

## Write rates

Signify's rules ([Hue System Performance](https://developers.meethue.com/develop/application-design-guidance/hue-system-performance/)):

- **About 10 commands a second to lights, 100 ms apart; at most 1 a second to groups.** Send fewer where you can: the Zigbee network is shared with switches and the bridge's own housekeeping.
- The bridge turns each command into one Zigbee message per thing changed, and the network carries about 25 a second. Brightness alone is one message, brightness and colour two, those plus on/off three. So send only what changes: no `on` to a light already on.
- Latency to one light, wired, one hop: about 55 ms for one message, 95 ms for two, 125 ms for three.
- A group command is a Zigbee broadcast, limited to about one a second, and broadcasts slow single-light commands too.
- Past the limit the bridge buffers without saying so and latency grows to seconds; when the buffer fills it drops the command and answers an error (type 901, "Internal error, 503").
- Other apps share the same budget. A light several hops away is slower.
- Fast updates to many lights for more than a few seconds belong on the Entertainment streaming API, not this one.

**What this library does.** Two write lanes per client (`WRITE_GAP_MS` in `client.ts`): `light` writes 100 ms apart, `grouped_light` and `scene` writes 1 s apart, both Signify's figures. A write to a resource whose last write is still waiting merges into it, so a burst cannot build a backlog. Prefer one `grouped_light` or scene write over many light writes.

**Not done:** a 503 (error 901) is reported as a failed write, not retried or slowed for. Whether a merged write carries a field the light already has (an `on` to a light that is on) is the caller's to avoid. No Entertainment API.

**Transition time.** A change fades over 400 ms unless the write says otherwise, and the setting does not stick: each write that wants another time must carry it (v2: `dynamics.duration`, in ms). Right for everyday use; an app that wants a light to respond at once sends 0. Latency above is measured with 0. This library sends none, so every write takes the bridge's 400 ms.

## Rooms, zones and scenes

People group their lights into rooms in the Hue app, so a home app should use those rooms and not make its own. Signify's [groups and scenes guide](https://developers.meethue.com/develop/application-design-guidance/hue-groups-rooms-and-scene-control/) is written for API v1; the points that carry over to v2:

- **A write to a group changes its lights together**, with no popcorn effect, and costs one broadcast (the one-a-second limit above).
- **A light is in at most one room.** Zones (v2) are the free groupings; a light can be in several. The whole-home group is made by the bridge.
- **Each light does what it can:** a dimmable light ignores a colour sent to its group.
- **A light that is off takes no brightness or colour change.** Turn it on in the same write.
- **Colour has one mode at a time.** If a write carries more than one, `xy` wins over colour temperature.
- **A scene belongs to a room or zone and stores each light's state.** Recalling it changes only the lights that are in both.

In v2 a room or zone is a `room` or `zone` resource whose `grouped_light` service takes the writes, and the whole home is `bridge_home`.

**What this library does.** Reads rooms, zones (`groups(state)`, each with its lights and its grouped light's on/off and brightness), the whole-home group (`homeGroupedLightId`) and scenes (`scenes(state)`). The config's `hueRoom` ties a Hue room to a room on the plan, and `homeDevices` gives each light its room. Writes: `home lights off`, `home room <name> on|off|<1-100>`, `home scene <name>`, each one group write; from code, `client.put("grouped_light", id, body)` and `client.recallScene(id)`.

**Not done:** typed writes for a room or a light (on, brightness, colour, temperature, transition); creating or editing rooms and scenes, which stays in the Hue app.

## Colour

Signify's rules ([Color Conversion Formulas](https://developers.meethue.com/develop/application-design-guidance/color-conversion-formulas-rgb-to-xy-and-back/)):

- A light's colour is an `xy` point in the CIE colour space, so one `xy` is the same colour on every light that can show it. Brightness is separate.
- Each light can show the colours inside a triangle, its gamut. Three are named: C for newer lights (red 0.6915, 0.3038; green 0.17, 0.7; blue 0.1532, 0.0475), B for the older bulb, A for the legacy LivingColors lamps and strips. **API v2 gives each light's gamut on its `light` resource**, so nothing needs a table of models.
- RGB to `xy`: scale to 0–1, undo the sRGB gamma, convert to XYZ with the D65 matrix, then `x = X / (X + Y + Z)` and `y = Y / (X + Y + Z)`; `Y` is the brightness. If the point is outside the light's gamut, move it to the nearest point on the triangle.
- `xy` to RGB, for showing a light's colour on a screen, is the same in reverse, with the brightness as `Y`.
- A colour given as hue, saturation and value goes to RGB first.
- White is a colour temperature in mirek (`color_temperature.mirek`, 153 cool to 500 warm on most lights), not an `xy`.

**What this library does: nothing yet.** The schema reads `on` and `dimming.brightness` and no colour. Writes are `client.put(kind, id, body)` with a raw CLIP body, and `recallScene(id)`. The conversions are public maths; Signify's page also carries an iOS SDK extract "as is", which is read for the method and not copied.

## Pairing

`POST https://<address>/api` with `{ devicetype, generateclientkey: true }`. Until the link button is pressed the bridge answers error 101; for about 30 s after, it answers with the application key. The key keeps working until it is deleted on the bridge. `devicetype` is `app#instance`, at most 40 characters.

**What this library does.**

- `pair({ host, fetch, deviceType })`: one request. Throws `HueError` with `code: "link_button"` until the button is pressed.
- `pairWhenPressed({ …, timeoutMs?, everyMs?, onWaiting?, signal? })`: asks every 2 s for 30 s, calls `onWaiting` once when the bridge first says the button isn't pressed, and returns the key. After the time it throws the `link_button` error.
- `home pair` uses it with 60 s, names the bridge it found, counts down on a terminal, and prints the env lines. With no press it says so and exits 1.
- The library never stores the key.

A consumer pairing from a chat:

```ts
import { FINDERS } from "@khalido/home/finders";
import { bunPinnedFetch, pairWhenPressed } from "@khalido/home/hue";

const [bridge] = await FINDERS.hue(); // mDNS: needs avahi-utils on Linux, else throws MissingTool
if (!bridge) throw new Error("no Hue bridge answered");
const { key } = await pairWhenPressed({
  host: bridge.host,
  fetch: bunPinnedFetch(bridge.id),
  deviceType: "chota#pi",
  onWaiting: () => say("Press the button on the Hue bridge."),
});
// store `key` as a secret; then hue({ host: bridge.host, bridgeId: bridge.id, key })
```

That is Bun. Under Node, `nodePinnedFetch(bridge.id)` from `@khalido/home/node` takes the place of `bunPinnedFetch`.

**What others do:** Home Assistant asks the person to press, then makes one request per click of Submit. openHAB asks every 0.5 s for 5 minutes, Homebridge every 15 s with no limit, openhue-cli every second with no limit. Home Assistant and openHAB leave out `generateclientkey`.

**Live, 2026-11-11, KO's BSB002 (Bun 1.4.4):** `home pair` gave the `link_button` error after its wait with no press, and a key on the next run once the button was pressed. The key has not yet been used for a read.
