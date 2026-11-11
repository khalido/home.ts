import {
  type CastHomeDevice,
  type CastSnapshot,
  castHomeDevices,
} from "./connectors/cast/index.ts";
import {
  type DaikinHomeDevice,
  daikinHomeDevices,
} from "./connectors/daikin/index.ts";
import {
  type EnphaseHomeDevice,
  enphaseHomeDevices,
} from "./connectors/enphase/index.ts";
import { type HueHomeDevice, hueHomeDevices } from "./connectors/hue/index.ts";
import {
  type PrinterHomeDevice,
  printersHomeDevices,
} from "./connectors/printers/index.ts";
import {
  playingElsewhere,
  type SpotifyHomeDevice,
  type SpotifyState,
  spotifyHomeDevices,
  spotifyText,
} from "./connectors/spotify/index.ts";
import type { HomeConfig } from "./config.ts";
import { IDENTITY, sameId } from "./discover.ts";
import type { DeviceRecord, Part } from "./home.ts";
import { manifestOf } from "./manifests.ts";

// Every device in the home in one list, each answering the same few questions (`DeviceRecord`), with its connector's own
// typed row in `detail`. A connector with devices exports `<name>HomeDevices(part)` and is listed here, once in the union
// and once in DEVICES; test/devices.test.ts fails for a manifest that is in neither DEVICES nor SERVICES.

/** Any device this library reads. `connector`, then `kind` where a connector has more than one, narrows `detail` and `state`. */
export type HomeDevice =
  | HueHomeDevice
  | DaikinHomeDevice
  | EnphaseHomeDevice
  | CastHomeDevice
  | PrinterHomeDevice
  | SpotifyHomeDevice;

/** Each connector's devices from its part, in the order `home status` lists the connectors. */
export const DEVICES = {
  hue: hueHomeDevices,
  daikin: daikinHomeDevices,
  enphase: enphaseHomeDevices,
  cast: castHomeDevices,
  printers: printersHomeDevices,
  spotify: spotifyHomeDevices,
} satisfies Record<string, (part: Part<any> | undefined) => DeviceRecord[]>;

/** Connectors that read a service, not a device: nothing to list. */
export const SERVICES: readonly string[] = ["amber", "up", "weather"];

/**
 * Every device in the snapshot. With the home `config`, a device takes the `room` its entry gives it, a Hue room or zone
 * (and its lights) the room whose `hueRoom` names it (a light in a room and a zone, the room's), and a device that reports
 * no name of its own (the Daikin, the Enphase gateway) the entry's `name`. A device's own name is never replaced.
 */
export function homeDevices(
  snapshot: Record<string, Part | undefined>,
  config?: Pick<HomeConfig, "devices" | "rooms">,
): HomeDevice[] {
  // Soloist doesn't say where its music went; a Cast device playing that track does, so the speaker's line names it.
  const on = spotifyElsewhere(snapshot);
  const all = Object.entries(DEVICES)
    .flatMap(([name, devices]): HomeDevice[] =>
      devices(snapshot[name] as never),
    )
    .map((d) =>
      d.connector === "spotify" && on.length
        ? { ...d, text: spotifyText(d.detail, on) }
        : d,
    );
  if (!config) return all;
  const entries = config.devices ?? [];
  const hueRooms = new Map<string, string>(); // a Hue group's or light's id → the config room showing it
  for (const d of all)
    if (d.connector === "hue" && d.kind === "group") {
      const room = config.rooms?.find(
        (r) =>
          r.hueRoom !== undefined &&
          (r.hueRoom === d.id || r.hueRoom === d.detail.groupedLightId),
      )?.id;
      // A light in a room and a zone takes the room's: rooms come first, and the first one stays.
      if (room)
        for (const id of [d.id, ...d.detail.lightIds])
          if (!hueRooms.has(id)) hueRooms.set(id, room);
    }
  return all.map((d) => {
    const mine = entries.filter((e) => e.connector === d.connector);
    const field = (IDENTITY as Record<string, string>)[d.connector];
    // One device for the connector: its entry is this device. Many: the entry whose identity is this device's id.
    const entry =
      d.id === d.connector
        ? mine[0]
        : mine.find((e) => {
            const id = field && (e as Record<string, unknown>)[field];
            return typeof id === "string" && sameId(id, d.id);
          });
    const room = d.room ?? entry?.room ?? hueRooms.get(d.id);
    // A device with no name of its own carries its connector's title: only then does the entry's name replace it.
    const unnamed = d.name === manifestOf(d.connector)?.title;
    const name = unnamed ? (entry?.name ?? d.name) : d.name;
    // Its line opens with its name, so a new name opens the line too.
    const text =
      name !== d.name && d.text.startsWith(`${d.name}: `)
        ? name + d.text.slice(d.name.length)
        : d.text;
    return { ...d, name, text, ...(room ? { room } : {}) };
  });
}

/**
 * Where the account's Spotify is playing when the Soloist speaker says it is on another device: the names of the Cast
 * devices and groups playing a track of that name in Spotify. A group is named, not its members. Empty when the music is
 * on the speaker itself, nothing is playing, or it is on something Cast can't see (a phone, a laptop). Matched by the
 * track's name, since neither side names the other.
 */
export function spotifyElsewhere(
  snapshot: Record<string, Part | undefined>,
): string[] {
  const s = snapshot.spotify?.state as SpotifyState | undefined;
  const cast = snapshot.cast?.state as CastSnapshot | undefined;
  const name = s?.track?.name;
  if (!playingElsewhere(s) || !name || !cast) return [];
  return Object.values(cast.devices)
    .filter(
      (d) =>
        d.status === "connected" &&
        !d.playingVia && // its group's music: the group is named
        d.app === "Spotify" &&
        d.title === name &&
        (d.playerState === "PLAYING" || d.playerState === "BUFFERING"),
    )
    .map((d) => d.name);
}

/** A room of the home config with the devices placed in it. `noData`: device connectors the config places here that listed nothing in it (never reached, not set up, or a `hueRoom` the bridge doesn't have), so the room isn't empty, it is unread. Per connector, not per device. */
export type RoomDevices = {
  id: string;
  name: string;
  floor?: string;
  devices: HomeDevice[];
  noData: string[];
};

/**
 * `homeDevices` room by room, in the config's order, for a map of the home. A connector that is down but has read before
 * still lists its devices, `available: false`; `noData` names one the config places in the room (a device's `room`, or
 * `hueRoom`) that has nothing to list. `unplaced`: devices with no room, or one the config doesn't have.
 */
export function byRoom(
  snapshot: Record<string, Part | undefined>,
  config: Pick<HomeConfig, "devices" | "rooms">,
): { rooms: RoomDevices[]; unplaced: HomeDevice[] } {
  const all = homeDevices(snapshot, config);
  const ids = new Set((config.rooms ?? []).map((r) => r.id));
  return {
    rooms: (config.rooms ?? []).map((r) => {
      const devices = all.filter((d) => d.room === r.id);
      const expected = new Set([
        ...(config.devices ?? [])
          .filter((d) => d.room === r.id)
          .map((d) => d.connector),
        ...(r.hueRoom === undefined ? [] : ["hue"]),
      ]);
      return {
        id: r.id,
        name: r.name,
        ...(r.floor === undefined ? {} : { floor: r.floor }),
        devices,
        noData: [...expected].filter(
          (c) => c in DEVICES && !devices.some((d) => d.connector === c),
        ),
      };
    }),
    unplaced: all.filter((d) => !d.room || !ids.has(d.room)),
  };
}
