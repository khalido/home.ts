# Using the library from Bun and Node

## Before you start: reserve device addresses

Give every device a fixed address in your router (a DHCP reservation; eero, UniFi and most routers have one): the Hue bridge, the Enphase gateway, the AC. The library takes addresses as parameters and the CLI reads them from the environment; discovery (`home discover`) finds devices, but mDNS and UDP broadcasts miss now and then, and a device on the guest Wi-Fi is invisible to the main network.

## Bun and Node

**Bun** (jaldi, chota-bot): leave out `fetch` and `hue()` pins with Bun's `tls` fetch option.

**Node**: Node's `fetch` takes no CA, so Hue and Enphase need the fetches in `@khalido/home/node`, built on undici:

```ts
import { NODE_TLS, nodePinnedFetch } from "@khalido/home/node";
loadHome(config, { env: process.env, readFile, tls: NODE_TLS }); // from a home config
hue({ host, bridgeId, key, fetch: nodePinnedFetch(bridgeId) }); // or one integration
```

Checked on Node 24.20 and 26.11 against a local TLS server (2026-10-28): the right CA and CN pass, another certificate or CN is rejected. Not yet against a real bridge.

Pairing from code is `pairWhenPressed` ([hue.md](hue.md#pairing) has the whole flow); pinning, the event stream and the rate limits are in [`src/connectors/hue/README.md`](../src/connectors/hue/README.md). On the local network the bridge still needs an application key: without one it answers 403. `home pair` gets one with the link button; no cloud account is involved.

## One home

```ts
import { createHome, health, loadHome } from "@khalido/home";

const home = createHome(loadHome(config, options), (snapshot, change) => {
  if (change.after.status !== change.before.status)
    log(`${change.name}: ${change.before.status} → ${change.after.status}`);
});
home.start(signal);
home.part("weather")?.state; // typed by name, read from memory
await home.refresh("amber"); // read now; resolves at its next report
health(home.snapshot(), Date.now()); // per integration: ok, stale or down, with lastGoodAt, downSince and the thresholds
```

`createHome` stamps each part with `lastGoodAt` (its last good read) and `downSince` (when it stopped being connected). `health` judges from those: a polling connector is stale after 2½ polls with no good read and down after 3 polls not connected; Hue and Cast are down after 2 minutes not connected. Health takes each connector's interval from its manifest; a home that changes one (the weather's `pollMinutes`) passes it: `health(snapshot, now, { pollSeconds: { weather: 60 * 60 } })`. For a one-shot read (a script, a printed brief), `settle(integrations, { ms })` runs them until each has answered and returns the snapshot.

From a config file, with everything a Bun app on the home's network passes (Cast, discovery, an address cache), the call is at the top of [config.md](config.md).

## Every device, the same way

`homeDevices(home.snapshot(), config)` lists every device the home has: each Hue light, room and zone, the Daikin, the Enphase gateway, each Cast device and group, each printer and the Soloist speaker. Each answers the same questions in the same words: `connector`, `id`, `name`, `kind` (light, group, speaker, display, tv, ac, printer, solar; `cast` for a Cast model the library doesn't know), `available` (and when it is false, `reason`: `offline`, `auth`, `config` or `crashed`), `asOf` (when the device last reported or was last read; a quiet light can be hours old and current), `state` (one word: on, off, idle, busy, cool, printing), `text` (one line for people), `room` and, for a group, `members`. A field the device hasn't reported is absent. The config is optional: with it a device takes its entry's `room`, and a device with no name of its own (the Daikin, the gateway) its entry's `name`; a device's own name is never replaced. While a connector isn't connected none of its devices is `available`, and each keeps its last values.

To drill down, `detail` is the connector's own typed row, and `connector` (with `kind` for Hue) tells TypeScript which:

```ts
for (const d of homeDevices(home.snapshot(), config)) {
  console.log(d.text); // "Kitchen: on · 60%"
  if (d.connector === "cast") d.detail.volume; // CastStatus
  if (d.connector === "hue" && d.kind === "light") d.detail.brightness; // LightView
  if (d.connector === "printers") d.detail.markers; // Printer
}
```

Below that is the connector's snapshot, exactly as the device sent it (`home.part("hue")?.state`). One connector alone: `castHomeDevices(home.part("cast"))`, and likewise `hueHomeDevices`, `daikinHomeDevices`, `enphaseHomeDevices`, `printersHomeDevices`, `spotifyHomeDevices`. The list is for reading; a write goes to the device's connector, with `d.id` where it takes one.

For a map of the home, `byRoom(home.snapshot(), config)` gives `{ rooms, unplaced }`: each room of the config in order (`id`, `name`, `floor`, `devices`), and `noData`, the connectors the config places in that room that have nothing to list yet, so an unread room isn't drawn as an empty one. A connector that is down but has read before still lists its devices, `available: false`.

## Writes

A write changes someone's house: make one only when a person asked for it. Writes hang off the integration, `home.integration(name)`, and each goes through the device's write lane: spaced, and a burst to one light or the AC merges so the last value lands.

| Connector | Call                                                                                                               | Resolves with                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| daikin    | `.client.power(on, opts?)`, `.client.mode(mode, targetC?, opts?)`                                                  | `{ state, confirmed }`                                                                           |
| spotify   | `.play(link?)`, `.pause()`, `.next()`, `.setVolume(0–100)`, `.activate()` and the rest                             | `{ state, confirmed }`                                                                           |
| spotify   | `.duck(fn, { to })`, `.interrupt(fn)`                                                                              | `{ value, music, why? }`: `fn`'s result, and `music` `untouched`, `restored`, `kept` or `failed` |
| cast      | `.announce(target, clip, { volume? })`                                                                             | `{ played, why?, restored, notRestored }`                                                        |
| cast      | `.announceAll(targets, clip, { volume? })`                                                                         | one of those per target, each with its `target`                                                  |
| cast      | `.setVolume(target, 0–1)`, `.setMuted(target, on)`, `.stop(target)`                                                | nothing                                                                                          |
| hue       | `.client.light(name, change, opts?)`, `.room(name, change, opts?)`, `.scene(name, room?, opts?)`, `.allOff(opts?)` | `{ state, confirmed }`, `state` the light, the room, or every light                              |
| hue       | `.client.put(kind, id, body)`, `.client.recallScene(id)`                                                           | the bridge's answer, for what the typed writes don't cover                                       |

- **`confirmed`** is true once the device reported what was asked. False is a result, not an error: the write was sent and the device hasn't shown it yet, and `state` is how it stood.
- **Dry run.** `opts` is `{ dryRun: true }` on Hue's, the Daikin's, Cast's and Spotify's writes: every check made before sending runs (the name, the range, a lost light; a colour off the gamut shows moved in the body) and nothing is sent. The device can still refuse a real write that a dry run passed. The result has `wouldSend`, the request it would make (Hue: `{ method, path, body }`; Daikin adds `sets`, `{ on?, mode?, targetC? }`; Spotify: the WebSocket commands in order), `state` as things stand now, and `confirmed: false`, so check `wouldSend` first. Cast's `setVolume`, `setMuted` and `stop` resolve `{ wouldSend }` (each `{ device, channel, payload }`), and `announce` its usual result with `played: false`, `why: "dry run"`, `wouldSend` and, in `notRestored`, what the real one could not put back (an app it would interrupt); nothing is served. Spotify's `duck` and `interrupt` run `fn`, touch nothing, and say in `why` what they would have done, so `duck(() => cast.announce(…, { dryRun: true }), { to: 20, dryRun: true })` tests an announcement end to end without a sound. A wrong name still throws with the names that exist. For testing a bot end to end with people home; `home … --dry-run` does the same from the terminal.
- **Use the returned state.** The Daikin's part in the snapshot is from its last poll and can be 120 s behind, unless you call `home.refresh("daikin")`.
- **Daikin defaults.** `mode("cool")` is 25 °C and `mode("heat")` 27 (`DEFAULT_TARGET_C`); `mode("cool", 23)` for another. `power(true)` brings the unit back as it was last left.
- **A target** for Cast is a device's or group's name or id. A clip is `{ url, type? }` or `{ bytes, type }`; bytes need `castServe`.
- **Clips: MP3 or AAC.** A 24 kHz mono WAV played on the displays and failed on the audio-only speakers (2026-11-09), so convert a WAV from a text-to-speech engine first.
- **Adding one while it runs.** `await home.add(integration)` starts it on the running home; the rest keep their sockets. One already there under that name is stopped first, so this is also how an `unavailable` part comes back once its key is fixed. `await home.remove(name)` stops one and drops its part. After pairing Hue from a chat, add the bridge's entry to the config (`loadHome` refuses an entry whose key is unset, so it can't be there before), build it as the config would, so it gets the pinned fetch and discovery, and add that one:

  ```ts
  const { key } = await pairWhenPressed({
    host,
    fetch: bunPinnedFetch(bridgeId),
    deviceType: "chota#pi",
  });
  const built = loadHome(config, {
    ...options,
    env: { ...process.env, HUE_APPLICATION_KEY: key },
  });
  await home.add(built.find((i) => i.name === "hue")!);
  ```

  A replaced part starts over from `connecting`, with no state and no `lastGoodAt`, and no `onChange` until its first report. The second `loadHome` keeps its own copy of the address cache, so pass the same `cache` and expect the last writer to win.

- **Hue by name.** `room("Bedroom", { brightness: 40, kelvin: 2700 })`, `light("Desk lamp", { color: "#ff8800" })`, `scene("Relax", "Bedroom")`, and `allOff()` for every light in the home. A change is `{ on?, brightness?, color?, kelvin?, transitionMs? }`; an unknown name throws with the names that exist.
- **Volume scales differ:** Cast 0–1, Spotify 0–100.

Announce only where nothing is playing, with the music on this machine turned down meanwhile:

```ts
import { castFreeSpeakers } from "@khalido/home/cast";

const cast = home.integration("cast");
const state = home.part("cast")?.state;
if (cast && state) {
  // Every free speaker and display, a whole group where all of it is free, never a TV.
  const { free, skipped } = castFreeSpeakers(state); // skipped: { name, why }
  const announce = () =>
    cast.announceAll(free, { url: clipUrl }, { volume: 0.3 });
  const speaker = home.integration("spotify");
  const results = speaker
    ? (await speaker.duck(announce, { to: 20 })).value
    : await announce();
  for (const r of results) if (!r.played) log(`${r.target}: ${r.why}`);
}
```

`castStatus(state)` gives each device's and group's `idle`, `restorable`, `busy` or `offline`, with the app and title. For Spotify, `speakerState(part)` says the speaker in one word (offline, waiting, idle, playing, paused, or elsewhere when the account's music is on another Spotify device; `spotifyElsewhere(home.snapshot())` names the Cast device when it is one) and `spotifyChanges(change.before, change.after)` turns an `onChange` into events (started, resumed, paused, stopped, track, stalled, recovered, offline, waiting, picked), those from the library's own `duck` or `interrupt` marked `own`.

## When something is wrong

Two places say so, for two different things.

**A part's status** is about the connection, and reading it never throws:

| `status`       | Means                                     | Do                                                          |
| -------------- | ----------------------------------------- | ----------------------------------------------------------- |
| `connecting`   | not answered yet                          | wait                                                        |
| `connected`    | reading                                   |                                                             |
| `disconnected` | unreachable now; the last `state` is kept | nothing: it keeps trying, and looks for a device that moved |
| `unavailable`  | stopped for good                          | read `reason`, fix it, `home.add` it again                  |

`reason` is set on `unavailable`, when known: `auth` (a key or token was rejected: a person must re-key), `config` (a setting or file is wrong) or `crashed` (its `run` threw; a bug). `detail` is the sentence for a person, `anomaly` an odd reading passed through. An `unavailable` part does not recover by itself: after the fix, `home.add` a fresh one under the same name.

**A write that can't be made throws** a `ConnectorError` (`HueError`, `DaikinError` and so on are subclasses), with the HTTP `status` when there was one and, where code can act on it, a `code`:

| `code`        | From         | Means                                                                         |
| ------------- | ------------ | ----------------------------------------------------------------------------- |
| `link_button` | hue          | pairing: the bridge's button has not been pressed                             |
| `offline`     | spotify, hue | not connected; for Hue, a light the bridge has lost                           |
| `waiting`     | spotify      | signed out: someone must pick the speaker in the Spotify app                  |
| `inactive`    | spotify      | it is not the active device; `activate()` first, if that is wanted            |
| `refused`     | spotify      | Soloist answered no                                                           |
| `timeout`     | spotify      | no answer in time                                                             |
| `invalid`     | spotify, hue | a value it can't take, or for Hue a name that doesn't exist; nothing was sent |
| `ipp`         | printers     | the printer answered an IPP error, its number in `status`                     |

Other failures carry no `code`: read the message (a Daikin setpoint off its range, a Cast target that doesn't exist, a device that didn't answer). Cast's `announce` throws only before anything changed; after that a failure is `played: false` with `why`.

`ConnectorCode` is the union, so a `switch` over it fails to compile when one is added.

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
  run: (signal, update) =>
    new Promise(
      (done) => (update(part), signal.addEventListener("abort", () => done())),
    ),
});
```
