import { z } from "zod";

// Spotify Soloist's local WebSocket API: the frames it sends, folded into one state, and the commands it takes.
// developer.spotify.com/documentation/soloist/reference/websocket-api (read 2026-11-08). Pure: no socket, no clock.

/** The WHATWG WebSocket surface used here: the runtime's global `WebSocket` (Bun, Node 22+, browsers), or a test's fake. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

/** Opens a socket to Soloist. The default is the runtime's `WebSocket`. */
export type SocketFactory = (url: string) => SocketLike;

export const OPEN = 1;

/** The statuses Soloist documents. Anything else is passed through and named in `anomaly`. */
export const STATUSES: ReadonlySet<string> = new Set([
  "idle",
  "playing",
  "paused",
  "buffering",
]);
export const REPEATS: ReadonlySet<string> = new Set([
  "off",
  "context",
  "track",
]);

// Every field optional: a frame missing one still folds, and a field of the wrong type fails only its own frame.
type Entity = { uri?: string; entity_type?: string; decorations?: Decorations };
type Decorations = {
  identity?: { name?: string };
  visual_identity?: { cover?: { url?: string; size?: string }[] };
  parent?: { entity?: Entity };
  creators?: { entity?: Entity }[];
  playback?: { duration_ms?: number };
};
const Entity: z.ZodType<Entity> = z.lazy(() =>
  z.looseObject({
    uri: z.string().optional(),
    entity_type: z.string().optional(),
    decorations: z
      .looseObject({
        identity: z.looseObject({ name: z.string().optional() }).optional(),
        visual_identity: z
          .looseObject({
            cover: z
              .array(
                z.looseObject({
                  url: z.string().optional(),
                  size: z.string().optional(),
                }),
              )
              .optional(),
          })
          .optional(),
        parent: z.looseObject({ entity: Entity.optional() }).optional(),
        creators: z
          .array(z.looseObject({ entity: Entity.optional() }))
          .optional(),
        playback: z
          .looseObject({ duration_ms: z.number().optional() })
          .optional(),
      })
      .optional(),
  }),
);
const Position = z.looseObject({
  position_ms: z.number().optional(),
  timestamp_ms: z.number().optional(),
  speed: z.number().optional(),
});
const Options = z.looseObject({
  shuffle: z.boolean().optional(),
  repeat: z.string().optional(),
});

const QueueEntry = z.looseObject({
  uid: z.string().optional(),
  source: z.string().optional(),
  item: Entity.optional(),
});

/** Soloist's frames by type, those this library reads. Anything else is skipped. */
export const Frame = z.discriminatedUnion("type", [
  z.looseObject({
    type: z.literal("auth_state"),
    logged_in: z.boolean().optional(),
    is_active: z.boolean().optional(),
    device_name: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal("playback_state"),
    status: z.string().optional(),
    item: Entity.optional(),
    context: Entity.optional(),
    position: Position.optional(),
    volume: z.number().optional(),
    is_active: z.boolean().optional(),
    options: Options.optional(),
  }),
  z.looseObject({ type: z.literal("track_changed"), item: Entity.optional() }),
  z.looseObject({
    type: z.literal("playback_changed"),
    status: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal("volume_changed"),
    volume: z.number().optional(),
  }),
  z.looseObject({
    type: z.literal("device_changed"),
    is_active: z.boolean().optional(),
    device_name: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal("context_changed"),
    context: Entity.optional(),
  }),
  z.looseObject({
    type: z.literal("options_changed"),
    options: Options.optional(),
  }),
  z.looseObject({
    type: z.literal("position_sync"),
    position: Position.optional(),
  }),
  z.looseObject({
    type: z.literal("queue_changed"),
    previous: z.array(QueueEntry).optional(),
    upcoming: z.array(QueueEntry).optional(),
  }),
  z.looseObject({
    type: z.literal("command_result"),
    command: z.string().optional(),
  }),
  z.looseObject({ type: z.literal("error"), message: z.string().optional() }),
]);
export type Frame = z.infer<typeof Frame>;
export const FRAME_TYPES: ReadonlySet<string> = new Set(
  Frame.options.map((o) => o.shape.type.value),
);

/** A stall the library noticed: see `SpotifyState.stalled`. */
export type Stall = {
  track: string;
  ms: number;
  how: "frozen" | "overrun";
  tried?: string;
};

/** What is loaded: a track or an episode. */
export type Track = {
  uri: string;
  type?: string;
  name?: string;
  artists: string[];
  album?: string;
  cover?: string;
  durationMs?: number;
};

/** Where the position was at a moment: `atMs` is Soloist's wall clock (epoch ms, the same box's), `speed` 1 while playing. */
export type PositionAnchor = { ms?: number; atMs?: number; speed?: number };

/**
 * The speaker as Soloist reports it. Every field is optional: none is known until Soloist says it. `loggedIn: false` is a
 * Soloist with no Spotify session (a bad key never signs in, issue #18). No `track`: nothing loaded.
 */
export type SpotifyState = {
  loggedIn?: boolean;
  /** Soloist's `--device-name`, the name phones show. */
  deviceName?: string;
  /** Whether this is the account's active Spotify Connect device. */
  active?: boolean;
  /** idle, playing, paused or buffering; anything else Soloist sends, passed through. */
  status?: string;
  track?: Track;
  /** The playlist, album or show playing from. */
  context?: { uri: string; type?: string; name?: string };
  position?: PositionAnchor;
  /** 0–100, as Soloist reports it. */
  volume?: number;
  shuffle?: boolean;
  /** off, context or track. */
  repeat?: string;
  /** What plays next, next first: Soloist's `queue_changed` (at most 10) or its answer to `get_queue`. Queued tracks, then the context's. */
  upNext?: Track[];
  /** Set by this library while its own `duck`, `interrupt` or stall repair runs, so changes then can be told from a person's. Not Soloist's. */
  aside?: "duck" | "interrupt" | "repair";
  /**
   * Set by this library when playback stalls while Soloist still says playing (Soloist issue #5): `frozen` (its reported
   * position stopped moving) or `overrun` (still on a track well past its end). `ms` the track position where it stuck, `tried` the repair.
   * Cleared when the track moves again, changes or stops. Not Soloist's.
   */
  stalled?: Stall;
  asOf: string;
};

const name = (e: Entity | undefined) => e?.decorations?.identity?.name;

/** An item as a Track, or undefined for an empty `uri` (Soloist's "nothing loaded"). */
export function toTrack(item: Entity | undefined): Track | undefined {
  if (!item?.uri) return undefined;
  const d = item.decorations ?? {};
  const covers = d.visual_identity?.cover ?? [];
  const cover = covers.find((c) => c.size === "default") ?? covers[0];
  const artists = (d.creators ?? [])
    .map((c) => name(c.entity))
    .filter((n): n is string => !!n);
  return dropUndefined({
    uri: item.uri,
    type: item.entity_type || undefined,
    name: name(item),
    artists,
    album: name(d.parent?.entity),
    cover: cover?.url,
    durationMs: d.playback?.duration_ms,
  });
}

const toContext = (e: Entity | undefined) =>
  e?.uri
    ? dropUndefined({
        uri: e.uri,
        type: e.entity_type || undefined,
        name: name(e),
      })
    : undefined;
const toAnchor = (p: z.infer<typeof Position>): PositionAnchor =>
  dropUndefined({ ms: p.position_ms, atMs: p.timestamp_ms, speed: p.speed });
const toOptions = (o: z.infer<typeof Options>) =>
  dropUndefined({ shuffle: o.shuffle, repeat: o.repeat });

/** An object without its undefined fields, so a snapshot never carries `key: undefined`. */
function dropUndefined<T extends object>(o: T): T {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as T;
}

/**
 * One frame folded into the state. `playback_state` is a full snapshot and replaces what it covers; the others patch one
 * field. `auth_state` with `logged_in: false` clears the playback (nothing plays without a session).
 */
export function fold(s: SpotifyState, f: Frame, asOf: string): SpotifyState {
  switch (f.type) {
    case "auth_state": {
      const next = {
        ...s,
        ...dropUndefined({
          loggedIn: f.logged_in,
          active: f.is_active,
          deviceName: f.device_name || undefined,
        }),
        asOf,
      };
      // signed out: nothing plays, nothing is queued
      return f.logged_in === false
        ? {
            loggedIn: false,
            ...dropUndefined({
              deviceName: next.deviceName,
              active: next.active,
            }),
            asOf,
          }
        : next;
    }
    case "playback_state": {
      const { track: _t, context: _c, position: _p, ...rest } = s;
      return dropUndefined({
        ...rest,
        loggedIn: true, // Soloist sends it only to a signed-in session
        status: f.status ?? s.status,
        track: toTrack(f.item),
        context: toContext(f.context),
        position: f.position ? toAnchor(f.position) : undefined,
        volume: f.volume ?? s.volume,
        active: f.is_active ?? s.active,
        ...(f.options ? toOptions(f.options) : {}),
        asOf,
      });
    }
    case "track_changed": {
      const { track: _t, ...rest } = s;
      const track = toTrack(f.item);
      return track ? { ...rest, track, asOf } : { ...rest, asOf };
    }
    case "playback_changed":
      return f.status === undefined ? s : { ...s, status: f.status, asOf };
    case "volume_changed":
      return f.volume === undefined ? s : { ...s, volume: f.volume, asOf };
    case "device_changed":
      return {
        ...s,
        ...dropUndefined({
          active: f.is_active,
          deviceName: f.device_name || undefined,
        }),
        asOf,
      };
    case "context_changed": {
      const { context: _c, ...rest } = s;
      const context = toContext(f.context);
      return context ? { ...rest, context, asOf } : { ...rest, asOf };
    }
    case "options_changed":
      return f.options ? { ...s, ...toOptions(f.options), asOf } : s;
    case "position_sync":
      return f.position ? { ...s, position: toAnchor(f.position), asOf } : s;
    case "queue_changed":
      return f.upcoming
        ? {
            ...s,
            upNext: f.upcoming
              .map((e) => toTrack(e.item))
              .filter((t): t is Track => !!t),
            asOf,
          }
        : s;
    default:
      return s; // command_result and error answer a command; they change no state
  }
}

/** What in the state is outside what Soloist documents, in a few words, or undefined. Passed through, never corrected. */
export function oddities(s: SpotifyState): string | undefined {
  const odd: string[] = [];
  if (s.status !== undefined && !STATUSES.has(s.status))
    odd.push(`status "${s.status}"`);
  if (s.volume !== undefined && !(s.volume >= 0 && s.volume <= 100))
    odd.push(`volume ${s.volume}, outside 0–100`);
  if (s.repeat !== undefined && !REPEATS.has(s.repeat))
    odd.push(`repeat "${s.repeat}"`);
  if (s.position?.speed !== undefined && !(s.position.speed >= 0))
    odd.push(`position speed ${s.position.speed}`);
  if (
    s.position?.ms !== undefined &&
    s.track?.durationMs !== undefined &&
    s.position.ms > s.track.durationMs
  )
    odd.push(
      `position ${s.position.ms} ms past the track's ${s.track.durationMs} ms`,
    );
  return odd.length ? odd.join("; ") : undefined;
}

/**
 * The position now, in ms: the last anchor moved on by the time since, at its speed, while playing. Not held to the track's
 * length (a reading past the end is the device's to explain), not rounded. Undefined without an anchor or a track.
 */
export function positionMs(s: SpotifyState, now: number): number | undefined {
  const p = s.position;
  if (p?.ms === undefined || !s.track) return undefined;
  if (s.status !== "playing" || p.atMs === undefined) return p.ms;
  return p.ms + (now - p.atMs) * (p.speed ?? 1); // `now` before the anchor (clock skew) gives less, not clamped
}

/**
 * A Spotify open link or URI as `spotify:<type>:<id>`, or undefined if it is neither. Short `spotify.link/…` links need a
 * network redirect, so they are not taken.
 */
export function toSpotifyUri(input: string): string | undefined {
  const s = input.trim();
  if (
    /^spotify:(track|album|playlist|artist|episode|show):[A-Za-z0-9]+$/.test(s)
  )
    return s;
  const link =
    /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]+)/.exec(
      s,
    );
  return link ? `spotify:${link[1]}:${link[2]}` : undefined;
}

/** A command frame: `{ type: "command", command, ...fields }`. */
export const commandFrame = (
  command: string,
  fields: Record<string, unknown> = {},
) => JSON.stringify({ type: "command", command, ...fields });
