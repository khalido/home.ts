# Google Cast

**Short answer.** Hand-roll a small CastV2 client in `src/connectors/cast/`: a runtime-neutral codec (one protobuf message, about 25 lines) and the JSON protocol, with the `node:tls` socket in a Node-only file on the `ftp.ts` precedent. The npm options are a 2019 untyped core and wrappers over it, none of which read speaker groups. First milestone: state only (app, playing, volume, standby, groups and members), about 360 lines. Announcements and the Hub dashboard follow, with KO watching.

## What is on the network (probed 2026-10-13, Bun 1.4.2, read-only)

`dns-sd -B _googlecast._tcp` found seven entries, all on port 8009 except the group:

| Name (`fn`) | Model (`md`)                  | Receiver status                                           |
| ----------- | ----------------------------- | --------------------------------------------------------- |
| Display A   | Google Nest Hub (Fuchsia)     | Backdrop, `isIdleScreen`, volume 0.47                     |
| Display B   | Google Nest Hub Max (Fuchsia) | Backdrop, `isIdleScreen`, 0.46                            |
| Speaker A   | Google Nest Mini              | no app, 0.375                                             |
| Speaker B   | Google Home Speaker           | no app, 0.30                                              |
| TV A        | Chromecast Ultra              | Backdrop, volume `attenuation` 0.80                       |
| TV B        | Google TV Streamer            | `isStandBy: true`, `isActiveInput: false`, volume `fixed` |
| Whole house | Google Cast Group             | members below                                             |

Each answered a TLS connect plus receiver `GET_STATUS` (nothing launched, no sound, no screen change) in 25–150 ms, TLS 1.2 on the two older speakers, 1.3 elsewhere. Every certificate is self-signed, CN the device id, valid 48 hours, so they rotate.

**Groups.** The group is its own mDNS entry resolving to Display A's host on its own high port, with Display A's certificate: a group lives on whichever member leads it. Multizone `GET_STATUS` on the group port lists the members (Display A, Display B, Speaker A) with their volumes; on Display A's own port it lists only itself, and `GET_CASTING_GROUPS` is refused. TXT `rm` does not mark membership (a member has it empty), so membership comes only from `MULTIZONE_STATUS`.

Not probed: media status (nothing was playing), socket lifetime, members' status while the group plays, and Node's `tls` (no Node caller yet).

## Library pick

| Package                     | Latest          | Code         | Verdict                                                                                                                    |
| --------------------------- | --------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `castv2`                    | 0.1.10, 2019    | 438 lines JS | untyped, loads `cast_channel.proto` from `__dirname` at runtime via `protobufjs` 6, hardcodes `rejectUnauthorized = false` |
| `castv2-client`             | 1.2.0, 2016     | 788          | callbacks over `castv2`                                                                                                    |
| `chromecast-api`            | 0.4.2, 2023     |              | adds SSDP, xml2js, a YouTube remote                                                                                        |
| `@foxxmd/chromecast-client` | 1.0.4, Jan 2024 | 917          | the best: typed, heartbeat, reconnect, DashCast; but on `castv2`, zod 3 beside our zod 4, no multizone                     |

The probe's codec was about 25 lines and spoke to all six devices; a library would be larger than the code it saves and still miss groups. A deliberate exception to "libraries over hand-rolling"; `protobufjs` for one six-field message is not worth a dependency. pychromecast (MIT) and Home Assistant's `cast` (Apache-2.0) are the reference for state and groups.

## Design

```
src/connectors/cast/
  codec.ts    CastMessage encode/decode, 4-byte length framing (Uint8Array, runtime-neutral)
  schemas.ts  zod, every field optional: RECEIVER_STATUS, MEDIA_STATUS, MULTIZONE_STATUS, DEVICE_ADDED/UPDATED/REMOVED
  state.ts    reduce(snapshot, deviceName, message), pure
  index.ts    cast(config): Integration<CastSnapshot> & CastActions
  writes.ts   setVolume, setMuted, stop, announce over the integration's own sockets
  serve.ts    Node-only: serveClip, the clip on the LAN for the device to fetch
  tls.ts      Node-only: tlsConnect(host, port, signal): CastChannel (excluded from tsconfig.build, in tsconfig.node)
  README.md
```

**Transport is injected.** `CastChannel = { peer, send(message), messages: AsyncIterable<CastMessage>, close() }`; tests pass a fake replaying fixtures. Every request has a `requestId`; a socket whose receiver status has not come within 10 s is dropped and retried.

**Discovery is injected too.** The library cannot browse mDNS, so `cast({ resolve, connect })` takes `resolve(): Promise<{ id, name, model, host, port, group }[]>`; the CLI and the sidecar run `dns-sd`, as `home discover` does. It runs at start and after any drop, which handles a group leader changing.

**One connection per entry**, seven here: `CONNECT` to `receiver-0`, `PING` every 5 s, receiver and multizone `GET_STATUS`, then pushed updates. When an app with the media namespace runs, connect to its `transportId` and read media status, as HA does. Reconnect with backoff at the last known address; a drop starts one shared re-discovery, repeated at 1, 5 and 15 minutes, then hourly, while anything is down or missing. `refresh()` re-sends every `GET_STATUS` and nudges that re-discovery.

**State:**

```ts
type CastDevice = {
  name: string;
  model?: string;
  kind: "device" | "group";
  app?: string;
  idle?: boolean; // idle: no app, or Backdrop's isIdleScreen
  standby?: boolean; // TVs
  volume?: number;
  muted?: boolean;
  volumeControl?: "master" | "attenuation" | "fixed";
  playerState?: "PLAYING" | "PAUSED" | "BUFFERING" | "IDLE";
  title?: string;
  artist?: string;
  members?: string[];
  leader?: string; // groups; leader = the device the group's certificate names
  groups?: string[];
  playingVia?: string; // devices
  status: "connected" | "disconnected";
  asOf: string;
};
type CastSnapshot = { devices: Record<string, CastDevice>; asOf: string };
```

As built: the snapshot is keyed by mDNS id, and `members`, `leader`, `groups` and `playingVia` hold ids; the leader comes from the group socket's certificate name (checked live: a group presents its leader's certificate), not from matching hosts. Volume passes through unrounded. **Members while a group plays**: HA keeps each group's media status and shows it on a member whose own is empty; the reducer does the same and sets `playingVia`. HA's model, to confirm live once.

**Config fragment**, one entry per Cast device or group so the home window can place it in a room:

```ts
export const configSchema = z.looseObject({
  connector: z.literal("cast"),
  name: z
    .string()
    .describe(
      "the device's or group's name in the Google Home app (mDNS fn), for display",
    ),
  castId: z
    .string()
    .describe(
      "the mDNS id, the stable identity; `home discover --write` fills it",
    ),
});
```

Decided by KO, 2026-10-13: the entry carries both, the Google Home name for display and the mDNS id as identity, so a rename in the app does not lose the device and the config reads like the app.

No host: a group's host changes with its leader. All entries fold into one `cast` integration, which `checkHome`'s one-per-connector rule forbids today (question 1). An unlisted device still appears, without a room.

**Writes, never called by the integration** (built 2026-10-14 except `castUrl`; tested on a scripted fake socket, not yet live; [src/connectors/cast/README.md](../src/connectors/cast/README.md) has what was built):

- `setVolume(name, level)`, `setMuted`, `stop(name)` (receiver `STOP` returns the device to Backdrop).
- `announce(target, clip, { volume?, timeoutMs? })`, target a device or group, `clip` a URL or bytes with their type (KO's own dictation as recorded, or TTS output; the library never synthesises) served by `serveClip`. The result names each member it could not restore. Read status, set volume, launch Default Media Receiver (`CC1AD845`), `LOAD` the clip, wait for `IDLE`/`FINISHED` (with a timeout), then restore: a prior Default Media Receiver `contentId` is re-loaded at its `currentTime`, an idle device gets `STOP`, then the volume. Spotify, YouTube and other apps cannot be resumed generically (our launch ends their session); the result says so.
- `castUrl(name, url)` launches DashCast (`84912283`, pychromecast's list) with the URL. HA casts its dashboard with its own registered receiver (`A078F6B0`), a hint at DashCast's limits. KO's own receiver costs a one-off Cast SDK fee and must be published (unpublished ones run only on serial-registered devices). Try DashCast first.

**TTS.** The library plays a URL, never synthesises. The speaker fetches it, so it must be HTTP on the LAN, not loopback, and in a format Default Media Receiver plays (MP3 or AAC; not AIFF; a 24 kHz mono WAV failed on audio-only Nest speakers, live 2026-11-09; `announce` now rewrites WAV bytes as 48 kHz 16-bit stereo, which played on every audio-only speaker and display here, 2026-11-12): `say -o msg.m4a --file-format=m4af --data-format=aac "…"` (m4af alone holds uncompressed PCM). Smallest server: a ~25-line `serveClip(bytes, type)` over `node:http` beside `tls.ts`, bound to the Mac's LAN address, random port, unguessable path, closed when the clip has played or after a minute (not after the first fetch, so a probe before it does no harm). The consumer runs `say`; `serveClip` picks the address on the target's network; the sidecar will raise macOS's local-network prompt once. A cloud voice later is MP3 bytes served the same way.

**CLI.** `home status`: `cast  7 · Display A idle 47% · TV B standby · Whole house (3, led by Display A) idle`. `home probe`: this probe.

**Tests** on the recorded payloads, ids replaced (idle hub, idle speaker, standby TV, the group's `MULTIZONE_STATUS`), invented `MEDIA_STATUS` and `DEVICE_REMOVED` until live ones are recorded, and codec round-trips.

**Size.** Codec 40, schemas 60, state 90, index 90, tls 80: about 360 for milestone 1. Writes and `serveClip` add about 150.

## Risks

- **TLS.** Rotating self-signed certs rule out pinning; verification is off, as with Enphase, with the cert CN checked against the mDNS `id`. Nothing secret is sent. Google's device-auth challenge needs its Cast root; not worth it.
- **Nest Hub firmware and unregistered receivers.** Untested; both Hubs run Fuchsia. Whether DashCast stays up is the first `castUrl` experiment.
- **Group leader changes.** Re-resolve on drop, and `announce` to a group resolves just before sending.
- **Bun `node:tls`** works (Bun 1.4.2); Node untested.
- **Seven always-open sockets.** Cheap (a PING per 5 s each) and what HA does; Hubs mark `senderConnected`, not shown on screen.

## Open questions for KO

1. ~~One `cast` integration over many config entries means relaxing `checkHome`'s one-device-per-connector rule for Cast. Fine?~~ Yes (KO, 2026-10-13); built.
2. ~~Entries by Google Home name or mDNS id?~~ Both: the name for display, the id as identity (KO, 2026-10-13).
3. ~~`serveClip` in the library (Node-only exception) or in each consumer?~~ In the library, beside `tls.ts`, on the same Node-only footing: the CLI and the sidecar both need it (lead, 2026-10-14).
4. ~~Interrupt Spotify it cannot resume, or skip that speaker and say why?~~ Interrupt, as Google's own announcements do, and report what could not be restored (lead, 2026-10-14; KO can reverse).
