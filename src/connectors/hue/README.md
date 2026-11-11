# Hue

Philips Hue over the bridge's local CLIP v2 API: HTTPS on the LAN, one key, one event stream. Square (v2) bridges only. `iot_class`: **local_push**.

## Official docs

The developer pages need a free Hue developer login.

- [Getting started](https://developers.meethue.com/develop/hue-api-v2/getting-started/): pairing (`POST /api` with `devicetype` and `generateclientkey`), the `hue-application-key` header, the resource URLs.
- [Core concepts](https://developers.meethue.com/develop/hue-api-v2/core-concepts/): the resource model (devices own services; rooms and zones group them; `grouped_light`, `bridge_home`), the event stream, and the rate guidance.
- [Using HTTPS](https://developers.meethue.com/develop/application-design-guidance/using-https/): the bridge certificate and Signify's two root CAs.
- [Bridge release notes](https://www.philips-hue.com/en-au/support/release-notes/bridge) (no login): what each bridge software version changed.

[docs/hue.md](../../../docs/hue.md) has every link and what each page asks of an app.

The schemas here were checked against [openhue-api](https://github.com/openhue/openhue-api) (Apache-2.0), an OpenAPI spec of CLIP v2, not against Signify's gated pages. Treat every field as unconfirmed from the primary source; all are optional, so a change degrades rather than throws.

## Pinning

The bridge serves its certificate, `CN=<bridge id>`, signed by one of Signify's two private roots. Trust those two and nothing else, and check the CN equals your bridge id. Never turn verification off: the key goes out on every request. The package carries both roots as `HUE_BRIDGE_ROOT_CA`, the bundle from Signify's page byte for byte; [docs/hue.md](../../../docs/hue.md) has Signify's rules, the fingerprints and what other projects do.

- **Bun**: `bunPinnedFetch(bridgeId, ca?)`, which `hue()` uses by default. Measured on Bun 1.4.2: 124 ms cold, 16 ms kept alive.
- **Node**: `nodePinnedFetch(bridgeId, ca?)` from `@khalido/home/node`, undici's `fetch` with an `Agent` holding the roots and the same CN check. Checked on Node 24.20 and 26.11 against a local TLS server (2026-10-28), not yet a real bridge.

`ca` replaces the bundle when given (the config's `ca`, the CLI's `HUE_CA_FILE`); nobody needs it for a real bridge. Live against KO's BSB002 (software 1978545030, Bun 1.4.4, 2026-11-11): the bundle is accepted, the second root alone and a wrong bridge id are refused. A bridge still on a self-signed certificate (software before 1971060010, May 2025) is refused: update it. A Bridge Pro is untried.

## Pairing

`pair({ host, fetch, deviceType })` makes one `POST /api`. Until someone presses the bridge's link button it throws `HueError` with `code: "link_button"` (bridge error 101). `pairWhenPressed` takes the same and asks every 2 s (`everyMs`) for 30 s (`timeoutMs`), calling `onWaiting` once when the bridge first says the button isn't pressed, so the caller can prompt; then it throws that error. `home pair` uses it with 60 s and a countdown. Pairing happens once: the key it returns keeps working, and the library never stores it. Live, 2026-11-11, KO's BSB002 (Bun 1.4.4): `home pair` timed out with no press, then returned a key once the button was pressed.

## Lights, rooms and scenes

`hueClient` (and `hue().client`) has three writes by name or id, each resolving `{ state, confirmed }`: the light or group as the bridge then reported it, read every half second for at most 3 s (`CONFIRM_MS`). Unconfirmed is a result, not an error.

- `light(name, change)` changes one light; `room(name, change)` every light in a room or zone with one group write.
- `change` is `{ on?, brightness?, color?, kelvin?, transitionMs? }`, and only what is given is sent. `brightness` is 1–100. `color` is a hex string or `{ r, g, b }`, sent as `xy` moved inside the light's own gamut (a room: its first colour light's). `kelvin` is a white temperature, checked against the light's own range (a room: the widest of its lights'). `color` and `kelvin` are one or the other. `transitionMs` is the fade; the bridge's own is 400 ms.
- Without `on`, a change to a light that is off turns it on, since an off light takes nothing else; a light already on gets no `on`. A room always gets `on: true`, since some of its lights may be off.
- `scene(name, room?)` recalls a scene. Scene names repeat across rooms, so a name several rooms use needs `room`. `confirmed` is the bridge reporting the scene active.
- A name is matched whole, in any case. A miss, a name two things share, a value off the range, a colour for a white light: each throws `HueError` with `code: "invalid"` before anything is sent; a miss lists what exists, and a name two things share lists them with their ids.
- Confirmation compares on/off, brightness within a point, and on a light the white temperature (within 2 mirek) or the colour (within 0.02 in `xy`). A room reports no colour, so only its on/off and brightness are compared; its brightness is the bridge's figure for the group.

The state has each light's `kelvin` and `kelvinRange`, and on a colour light its `xy`, a `hex` for a screen (the hue at full brightness) and its `gamut`. `colorToXy`, `xyToHex`, `kelvinToMirek` and `mirekToKelvin` are exported. `hueText(view)` is the line.

CLI: `home light <name> [on|off] [<1-100>] [<kelvin>k] [<hex colour>]`, the same for `home room`, and `home scene <name> [in <room>]`, each printing what the bridge then reported. Quote a name with a space. **Untried on a bridge** (2026-11-11): every one of these writes, and so whether the bridge reports a change inside the 3 s.

## Events

`GET /eventstream/clip/v2` with `Accept: text/event-stream`, read through `fetch` (the `EventSource` constructor takes no headers). Each message has `id: <unix seconds>:0` and `data:` holding an array of batches, each `add`, `update`, `delete` or `error`. Updates carry only changed fields, so `reduce` merges them. The bridge keeps a short buffer and does not say when you fell out of it, so after every reconnect `hue()` reads everything again. Reconnects back off 1 s, 5 s, 15 s, then every 60 s. A watchdog reconnects a connection that has sent no bytes, events or comment lines, for 90 s (`IDLE_MS`, aiohue's figure), so a silent half-close does not look connected forever. The bridge sends nothing on its own (aiohue source), so a quiet 90 s costs one silent reconnect: at once, with no `disconnected` and no step up the backoff, then the usual full read (one request; 16 ms kept alive, Bun 1.4.2, as measured under Pinning). Only a reconnect that fails is reported. So a bridge that accepts the stream and then never sends anything reconnects every 90 s, silently, for as long as that lasts. The alternative is aiohue's: it provokes traffic by writing a geofence client to the bridge every 60 s. That is a write to the bridge KO has not asked for, so it is not done; it is KO's call to switch. After three failed reconnects in a row, `hue({ find })` looks for the bridge by `bridgeId` (mDNS, two passes) and follows it to a new address, saying "moved from a to b" in `detail`, as Daikin and Enphase do; `loadHome` passes `finders.hue`.

Unconfirmed: whether the bridge resumes from `Last-Event-ID`; how many streams one bridge allows.

## Rates

Two write lanes per client (`src/lane.ts`). `grouped_light` and `scene` writes go out 1 s apart, `light` writes 100 ms apart, each lane in order. A write to a resource whose last write is still waiting merges into it (`mergeBody`, the newer field winning), so a burst cannot build a backlog; the merged write keeps the first one's place in the lane. Unverified: which the bridge applies when a merge carries both `color_temperature` and `color`. That is Signify's guidance (about 10 commands a second to lights, 1 a second to groups; its Hue System Performance page, read 2026-11-11; [docs/hue.md](../../../docs/hue.md) has the rest). Prefer one `grouped_light` or scene write over many light writes: the bridge sends it to every light at once.

## First live read (2026-11-11)

KO's BSB002, software 1978545030, Bun 1.4.4, reads only, with the key from `home pair` and the bundled roots.

- `home hue`: connected in 0.47 s. A full read is 177 resources in 286 ms, and every one parsed.
- 16 lights, 6 rooms, 30 scenes, 2 lights unreachable (shown as not available, reason `offline`). A room with no lights has no on/off and prints its name alone.
- Every light has `dimming` and `color_temperature`, each with its own mirek range (153–500 on a colour light, 153–454 on a white one). 6 have `color`, with `xy` and their gamut (type C) on the resource, as Signify's page says. `grouped_light` carries `on`, `dimming`, `color_temperature` and `color` too.
- The event stream: connected at 0.4 s, then nothing from the bridge for 90 s, so the watchdog reconnected and read again at 90.8 s, as designed. With no light changing, that is one full read every 90 s.
- Untried: any write through the paired key, an event arriving (nothing changed while watching), a move to a new address.

## Sources

What this folder learned from, and on what terms. No code was copied.

| Source                                                                                                           | Licence                      | Used for                                |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------- |
| [Signify's Hue API docs](https://developers.meethue.com/develop/hue-api-v2/)                                     | Developer terms, login-gated | the API itself                          |
| [openhue/openhue-api](https://github.com/openhue/openhue-api)                                                    | Apache-2.0                   | resource and event-stream shapes        |
| [Home Assistant `hue` integration](https://github.com/home-assistant/core/tree/dev/homeassistant/components/hue) | Apache-2.0                   | how HA wires aiohue into entities       |
| [home-assistant-libs/aiohue](https://github.com/home-assistant-libs/aiohue)                                      | Apache-2.0                   | reconnect behaviour                     |
| [Signify's Using HTTPS page](https://developers.meethue.com/develop/application-design-guidance/using-https/)    | Developer terms, login-gated | the two root certificates, as published |
| [jdmg94/Hue-Sync](https://github.com/jdmg94/Hue-Sync)                                                            | Apache-2.0                   | resource types, cross-checked           |
| [vchlum/smart-home](https://github.com/vchlum/smart-home)                                                        | MIT                          | a compact CLIP v2 event loop            |
