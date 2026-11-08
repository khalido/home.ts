import type { CastPayload } from "./schemas.ts";

/** A Cast device or group as found by discovery: what `resolve` returns for each. */
export type Resolved = {
  id: string;
  name: string;
  model?: string;
  host: string;
  port: number;
  group: boolean;
};

/**
 * One Cast device or group. `name` is the device's own (mDNS fn, or a device's own multizone status), a config's only until it answers. Ids are the mDNS id, lowercase without dashes; `members`, `leader`, `groups` and
 * `playingVia` name other entries by id. Volume is the device's own number, unrounded.
 */
export type CastDevice = {
  id: string;
  name: string;
  model?: string;
  kind: "device" | "group";
  host?: string;
  port?: number;
  app?: string; // the running app's display name
  appId?: string;
  idle?: boolean; // no app, or an idle screen (Backdrop's isIdleScreen)
  standby?: boolean; // TVs: the TV is off or on another input
  volume?: number;
  muted?: boolean;
  volumeControl?: string; // "master" | "attenuation" | "fixed"
  playerState?: string; // "PLAYING" | "PAUSED" | "BUFFERING" | "IDLE"
  title?: string;
  artist?: string;
  members?: string[]; // groups: from the group's multizone status
  leader?: string; // groups: the member whose certificate the group's socket presents
  groups?: string[]; // devices: the groups that list it
  playingVia?: string; // devices: the group whose media this device shows, its own being empty
  status: "connecting" | "connected" | "disconnected";
  detail?: string;
  asOf?: string; // when it last answered
};

export type CastSnapshot = {
  devices: Record<string, CastDevice>;
  asOf: string;
};

/** An id as the snapshot keys it: the mDNS id (32 hex) and the certificate's and multizone's dashed UUID are one key. */
export const castKey = (id: string) => id.toLowerCase().replace(/-/g, "");

/** Add or update what discovery found; devices it did not find this time are kept as they were. */
export function found(
  s: CastSnapshot,
  entries: Resolved[],
  asOf: string,
): CastSnapshot {
  const devices = { ...s.devices };
  for (const e of entries) {
    const id = castKey(e.id);
    const kind = e.group ? "group" : "device";
    devices[id] = {
      ...(devices[id] ?? { status: "connecting" }),
      id,
      name: e.name,
      model: e.model,
      kind,
      host: e.host,
      port: e.port,
    };
  }
  return link({ devices, asOf });
}

/** A socket opened or dropped. A group's `leader` comes with its socket. */
export function connection(
  s: CastSnapshot,
  id: string,
  change: { status: CastDevice["status"]; detail?: string; leader?: string },
  asOf: string,
): CastSnapshot {
  const key = castKey(id);
  const d = s.devices[key];
  if (!d) return s;
  const leader =
    change.leader === undefined ? d.leader : castKey(change.leader);
  return link({
    devices: {
      ...s.devices,
      [key]: { ...d, status: change.status, detail: change.detail, leader },
    },
    asOf,
  });
}

/** One payload from one entry's socket. Pure: returns a new snapshot. */
export function reduce(
  s: CastSnapshot,
  id: string,
  p: CastPayload,
  asOf: string,
): CastSnapshot {
  const key = castKey(id);
  const prev = s.devices[key];
  if (!prev) return s;
  const d: CastDevice = { ...prev, asOf };
  if (p.type === "RECEIVER_STATUS") {
    const app = p.status?.applications?.[0];
    const v = p.status?.volume;
    Object.assign(d, {
      app: app?.displayName,
      appId: app?.appId,
      idle: !app || app.isIdleScreen === true,
      standby: p.status?.isStandBy,
      volume: v?.level,
      muted: v?.muted,
      volumeControl: v?.controlType,
    });
    if (!mediaApp(app))
      Object.assign(d, {
        playerState: undefined,
        title: undefined,
        artist: undefined,
      });
  } else if (p.type === "MEDIA_STATUS") {
    const m = p.status?.[0];
    delete d.playingVia; // its own media now: link borrows the group's again only if this is empty
    Object.assign(d, {
      playerState: m?.playerState,
      title: m?.media?.metadata?.title,
      artist: m?.media?.metadata?.artist,
    });
  } else if (d.kind === "device") {
    // A device's own port lists only itself, by its current name in the Google Home app (mDNS fn; all six live devices
    // matched, 2026-10-13): the name follows a rename without a discovery. Membership is read from a group's port alone.
    if (p.type === "MULTIZONE_STATUS") {
      const self = p.status?.devices?.find(
        (m) => m.deviceId !== undefined && castKey(m.deviceId) === key,
      );
      if (self?.name) d.name = self.name;
    }
  } else {
    const members = new Set(d.members ?? []);
    if (p.type === "MULTIZONE_STATUS")
      d.members = (p.status?.devices ?? []).flatMap((m) =>
        m.deviceId ? [castKey(m.deviceId)] : [],
      );
    else {
      const member =
        p.type === "DEVICE_REMOVED" ? p.deviceId : p.device?.deviceId;
      if (member)
        p.type === "DEVICE_REMOVED"
          ? members.delete(castKey(member))
          : members.add(castKey(member));
      d.members = [...members];
    }
  }
  return link({ devices: { ...s.devices, [key]: d }, asOf });
}

/** The app's transport speaks media status: connect to it to read what is playing. */
export const mediaApp = (app?: {
  namespaces?: { name?: string }[];
  transportId?: string;
}) =>
  app?.transportId !== undefined &&
  (app.namespaces ?? []).some(
    (n) => n.name === "urn:x-cast:com.google.cast.media",
  );

const active = (state?: string) => state !== undefined && state !== "IDLE";

/**
 * The cross-links, recomputed from scratch on every change: each device's groups, and a member with no media of its
 * own shows a playing group's, with `playingVia` naming the group (Home Assistant's model).
 */
function link(s: CastSnapshot): CastSnapshot {
  const devices: Record<string, CastDevice> = {};
  for (const [id, d] of Object.entries(s.devices)) {
    const own = d.playingVia
      ? { playerState: undefined, title: undefined, artist: undefined }
      : {};
    devices[id] = { ...d, ...own, groups: undefined, playingVia: undefined };
  }
  for (const g of Object.values(devices).filter((d) => d.kind === "group")) {
    for (const m of g.members ?? []) {
      const d = devices[m];
      if (!d || d.kind === "group") continue;
      d.groups = [...(d.groups ?? []), g.id];
      if (active(g.playerState) && !active(d.playerState))
        Object.assign(d, {
          playerState: g.playerState,
          title: g.title,
          artist: g.artist,
          playingVia: g.id,
        });
    }
  }
  for (const d of Object.values(devices))
    if (d.groups === undefined) delete d.groups;
  for (const d of Object.values(devices))
    if (d.playingVia === undefined) delete d.playingVia;
  return { devices, asOf: s.asOf };
}
