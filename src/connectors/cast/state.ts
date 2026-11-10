import type { CastPayload } from "./schemas.ts";

/** What a device is for, read from its model name; a model it doesn't know has none. A group is `kind: "group"`. */
export type CastForm = "speaker" | "display" | "tv";
export function castForm(model?: string): CastForm | undefined {
  if (!model) return undefined;
  if (/hub|tablet|display/i.test(model)) return "display";
  if (/audio|speaker|mini|google home/i.test(model)) return "speaker";
  if (/chromecast|streamer|\btv\b/i.test(model)) return "tv";
  return undefined;
}

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
  form?: CastForm; // devices: speaker, display or tv, when the model is one it knows
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
      form: kind === "device" ? castForm(e.model) : undefined,
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

/** Google's own player for a URL of audio or video: what `announce` plays a clip with, and can put back. */
export const DEFAULT_MEDIA_RECEIVER = "CC1AD845";

/** Devices first, then groups, each by name. */
export const castDevices = (s: CastSnapshot) =>
  Object.values(s.devices).sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
  );

/** A target is a castId, else a name in any case. `announce` and `castFree` find it the same way. */
export const findCast = (
  devices: Record<string, CastDevice>,
  target: string,
): CastDevice | undefined => {
  const all = Object.values(devices);
  return (
    all.find((x) => x.id === castKey(target)) ??
    all.find((x) => x.name.toLowerCase() === target.toLowerCase())
  );
};

/**
 * What a device or group is doing, for a caller choosing where to play something. `state`:
 * - `idle`: no app, or the idle screen.
 * - `restorable`: the Default Media Receiver, whose clip `announce` puts back at its position.
 * - `busy`: another app, playing or paused. An announce ends it and nothing here can resume it.
 * - `offline`: not connected, or connected and not heard from yet.
 * A member playing its group's media takes the group's state, with `via` naming the group and `app` the group's. A group
 * is as free as its least free connected member. `standby` is a TV that is off or on another input: `idle` by its app,
 * but a clip may wake it.
 */
export type CastStatus = {
  id: string;
  name: string;
  kind: "device" | "group";
  state: "idle" | "restorable" | "busy" | "offline";
  app?: string;
  playerState?: string;
  title?: string;
  artist?: string;
  via?: string;
  volume?: number;
  muted?: boolean;
  standby?: boolean;
  members?: CastStatus[]; // groups: each member the snapshot has
};

const RANK = { idle: 0, restorable: 1, busy: 2, offline: 3 } as const;

/** By its own app alone: not its group's media, not its members. */
const ownState = (d: CastDevice): CastStatus["state"] =>
  d.status !== "connected" || d.idle === undefined
    ? "offline"
    : d.idle
      ? "idle"
      : d.appId === DEFAULT_MEDIA_RECEIVER
        ? "restorable"
        : "busy";

/** Every device and group in the snapshot as a `CastStatus`, devices first, each by name. */
export function castStatus(s: CastSnapshot): CastStatus[] {
  const one = (d: CastDevice): CastStatus => {
    const group = d.playingVia ? s.devices[d.playingVia] : undefined;
    const own = ownState(d);
    // Its group's media is playing on it: the group's app decides, and an unknown one counts as busy.
    const self =
      own === "offline" || !d.playingVia
        ? own
        : group && ownState(group) === "restorable"
          ? "restorable"
          : "busy";
    const members =
      d.kind === "group"
        ? (d.members ?? []).flatMap((id) =>
            s.devices[id] ? [one(s.devices[id])] : [],
          )
        : undefined;
    const state =
      self === "offline"
        ? self
        : (members ?? [])
            .map((m) => m.state)
            .filter((m) => m !== "offline")
            .reduce((a, b) => (RANK[b] > RANK[a] ? b : a), self);
    const status: CastStatus = {
      id: d.id,
      name: d.name,
      kind: d.kind,
      state,
      app:
        d.idle === false
          ? d.app
          : group?.idle === false
            ? group.app
            : undefined,
      playerState: d.playerState,
      title: d.title,
      artist: d.artist,
      via: d.playingVia && (group?.name ?? d.playingVia),
      volume: d.volume,
      muted: d.muted,
      standby: d.standby,
      members,
    };
    for (const k of Object.keys(status) as (keyof CastStatus)[])
      if (status[k] === undefined) delete status[k];
    return status;
  };
  return castDevices(s).map(one);
}

/** A target `castFree` left out: `standby` is a TV that is off, which a clip may wake. */
export type CastSkipped = {
  name: string;
  why: "busy" | "offline" | "standby" | "unknown";
  app?: string;
};

/**
 * Of these targets (names in any case, or ids), the ones an announcement would not disturb: `idle` or `restorable`, and
 * not a TV in standby. `free` is names, for `announceAll`; `skipped` says which were left out and why.
 * - A group stays a group while every connected member is free. An offline member doesn't split it: the group plays without it.
 * - A group playing another app is skipped whole. Otherwise a group with a busy member, or one whose own socket is down,
 *   becomes its free members, named one by one (they then play out of step with each other).
 * - A device is never named beside a free group that holds it, nor two groups that share a member: the second becomes its
 *   members not yet covered.
 */
export function castFree(
  s: CastSnapshot,
  targets: string[],
): { free: string[]; skipped: CastSkipped[] } {
  const status = new Map(castStatus(s).map((c) => [c.id, c]));
  const free = new Map<string, CastStatus>();
  const covered = new Set<string>(); // members of the groups in `free`
  const skipped = new Map<string, CastSkipped>();
  const ok = (c: CastStatus) =>
    (c.state === "idle" || c.state === "restorable") && !c.standby;
  const skip = (c: CastStatus) =>
    skipped.set(c.id, {
      name: c.name,
      why:
        c.state === "offline"
          ? "offline"
          : c.standby && c.state !== "busy"
            ? "standby"
            : "busy",
      ...(c.app ? { app: c.app } : {}),
    });
  const device = (c: CastStatus) => (ok(c) ? free.set(c.id, c) : skip(c));
  for (const target of targets) {
    const d = findCast(s.devices, target);
    const c = d && status.get(d.id);
    if (!d || !c) skipped.set(target, { name: target, why: "unknown" });
    else if (c.kind === "device") device(c);
    else {
      const members = c.members ?? [];
      const own = ownState(d);
      const up = members.filter((m) => m.state !== "offline");
      if (own === "busy" || (own === "offline" && !members.length)) skip(c);
      else if (
        own !== "offline" &&
        up.every(ok) &&
        !members.some((m) => covered.has(m.id))
      ) {
        free.set(c.id, c);
        for (const m of members) covered.add(m.id);
      } else for (const m of members) device(m);
    }
  }
  return {
    free: [...free.values()]
      .filter((c) => c.kind === "group" || !covered.has(c.id))
      .map((c) => c.name),
    skipped: [...skipped.values()],
  };
}
