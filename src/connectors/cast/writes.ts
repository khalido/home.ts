import type { Clock } from "../../clock.ts";
import { errorText } from "../../connector.ts";
import { type WriteLane, writeLane } from "../../lane.ts";
import { NS } from "./codec.ts";
import {
  type Application,
  MediaStatus,
  MultizoneStatus,
  ReceiverStatus,
} from "./schemas.ts";
import { type CastDevice, castKey } from "./state.ts";

// Writes over the sockets `cast()` already holds: volume, mute, stop, and an announcement that plays a clip and puts
// the device back as it was. Never called by the integration itself; tried on a scripted fake socket, not yet live.

/** Google's own player for a URL of audio or video. */
export const DEFAULT_MEDIA_RECEIVER = "CC1AD845";
/** Each request (a status, a volume, LAUNCH, LOAD, STOP) gets this long to answer. */
export const ANSWER_MS = 10_000;
/** How long an announcement waits for its clip to finish, beyond the clip's own length when the device reports it. */
export const PLAY_MS = 60_000;

const RECEIVER = "receiver-0";
/** Level writes, and mute writes, per device or group in any minute; more wait their turn, the newest winning. A guess: Cast publishes no limit. */
export const VOLUME_PER_MINUTE = 30;

/** Replies that refuse a request. */
const REFUSALS = new Set([
  "LAUNCH_ERROR",
  "LOAD_FAILED",
  "LOAD_CANCELLED",
  "INVALID_REQUEST",
  "INVALID_PLAYER_STATE",
  "INVALID_MEDIA_SESSION_ID",
]);

/** What to play: a URL the device can fetch (type defaults to audio/mpeg), or bytes for `serve` to put on the LAN. */
export type CastClip =
  { url: string; type?: string } | { bytes: Uint8Array; type: string };

/** What `announce` did: whether the clip played to its end, why not, and what it put back or could not. */
export type AnnounceResult = {
  played: boolean;
  why?: string;
  restored: string[];
  notRestored: { name: string; why: string }[];
};

/** Serves bytes once over HTTP on the LAN: `serveClip` from `@khalido/home/cast/serve`. `host` is the device that will fetch it. */
export type ServeClip = (
  bytes: Uint8Array,
  type: string,
  options?: { host?: string; signal?: AbortSignal },
) => Promise<{ url: string; close(): void }>;

/** The writes on `cast()`'s object. A target is a device's or group's name (any case) or its castId; volume is 0 to 1, as the snapshot's. */
export type CastActions = {
  setVolume(target: string, level: number): Promise<void>;
  setMuted(target: string, muted: boolean): Promise<void>;
  /** Ends the running app (receiver STOP), which returns the device to its idle screen. Nothing running: nothing sent. */
  stop(target: string): Promise<void>;
  announce(
    target: string,
    clip: CastClip,
    options?: { volume?: number; timeoutMs?: number },
  ): Promise<AnnounceResult>;
};

/** A payload as it came, before any schema. */
export type RawPayload = {
  type?: unknown;
  requestId?: unknown;
  reason?: unknown;
  [key: string]: unknown;
};
/** Sees every payload a socket receives, then `undefined` once when it closes. */
export type Listener = (raw: RawPayload | undefined) => void;

/** What a write needs of one live socket. */
export type CastSession = {
  host: string;
  port: number;
  send(namespace: string, destination: string, payload: object): void;
  nextId(): number;
  listen(listener: Listener): () => void;
  /** CONNECT to an app's transport, once per transport however many callers ask. */
  connect(transport: string): void;
  /** Close it after a discovery the caller just ran: it reconnects at the address the snapshot holds, without another discovery. */
  end(why: string): void;
};

/** What `castActions` needs of the integration. */
export type WriteContext = {
  clock: Clock;
  devices(): Record<string, CastDevice>;
  session(id: string): CastSession | undefined;
  discover(): Promise<void>;
  /** The entry's socket once it is open at the address the snapshot holds, within `ms`. */
  connected(id: string, ms: number): Promise<CastSession>;
  serve?: ServeClip;
};

const idleApp = (app?: Application) => !app || app.isIdleScreen === true;

function checkLevel(level: number) {
  if (!(level >= 0 && level <= 1))
    throw new RangeError(`volume is 0 to 1, got ${level}`);
}

/**
 * The first value `pick` returns for a payload on `s`. Rejects when `pick` throws, when the socket closes, when `signal`
 * aborts, or after `ms` (a function is read again each time it would expire, so a deadline can grow).
 */
function waitFor<T>(
  clock: Clock,
  s: CastSession,
  ms: number | (() => number),
  what: string,
  pick: (raw: RawPayload) => T | undefined,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const done = new AbortController();
    const finish = (settle: () => void) =>
      done.signal.aborted ||
      (off(),
      signal?.removeEventListener("abort", cancel),
      done.abort(),
      settle());
    const cancel = () =>
      finish(() => reject(new Error(`stopped waiting for ${what}`)));
    const off = s.listen((raw) => {
      if (raw === undefined)
        return finish(() =>
          reject(new Error(`the socket closed waiting for ${what}`)),
        );
      try {
        const value = pick(raw);
        if (value !== undefined) finish(() => resolve(value));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    signal?.addEventListener("abort", cancel, { once: true });
    const start = clock.now();
    const limit = typeof ms === "number" ? () => ms : ms;
    void (async () => {
      for (
        let left = limit();
        left > 0 && !done.signal.aborted;
        left = start + limit() - clock.now()
      )
        await clock.sleep(left, done.signal);
      finish(() =>
        reject(new Error(`no ${what} in ${Math.round(limit() / 1000)} s`)),
      );
    })();
  });
}

/** Send a request and take its reply by requestId; a refusal rejects, naming it. */
function request(
  clock: Clock,
  s: CastSession,
  namespace: string,
  destination: string,
  payload: { type: string; [key: string]: unknown },
  id = s.nextId(),
): Promise<RawPayload> {
  const reply = waitFor(
    clock,
    s,
    ANSWER_MS,
    `answer to ${payload.type}`,
    (raw) => {
      if (raw.requestId !== id) return undefined;
      if (typeof raw.type === "string" && REFUSALS.has(raw.type))
        throw new Error(
          `${payload.type} refused: ${raw.type}${typeof raw.reason === "string" ? ` (${raw.reason})` : ""}`,
        );
      return raw;
    },
  );
  s.send(namespace, destination, { ...payload, requestId: id });
  return reply;
}

/** Writes over the integration's sockets. */
export function castActions(ctx: WriteContext): CastActions {
  const { clock } = ctx;

  const find = (target: string): CastDevice => {
    const all = Object.values(ctx.devices());
    const d =
      all.find((x) => x.id === castKey(target)) ??
      all.find((x) => x.name.toLowerCase() === target.toLowerCase());
    if (!d)
      throw new Error(
        `no Cast device or group "${target}"; have: ${
          all
            .map((x) => x.name)
            .sort()
            .join(", ") || "none"
        }`,
      );
    return d;
  };
  const live = (d: CastDevice): CastSession => {
    const s = ctx.session(d.id);
    if (!s)
      throw new Error(
        `${d.name} is not connected${d.detail ? ` (${d.detail})` : ""}`,
      );
    return s;
  };

  /** A receiver request whose reply is a receiver status (GET_STATUS, SET_VOLUME, STOP). */
  const receiver = async (
    s: CastSession,
    payload: { type: string; [key: string]: unknown } = { type: "GET_STATUS" },
  ) => {
    const r = ReceiverStatus.safeParse(
      await request(clock, s, NS.receiver, RECEIVER, payload),
    );
    if (!r.success)
      throw new Error(
        `an answer to ${payload.type} that is not a receiver status`,
      );
    return r.data.status ?? {};
  };

  /** A group's socket at the address discovery gives now: a group lives on its leader, which can move. */
  const regroup = async (d: CastDevice): Promise<CastSession> => {
    await ctx.discover();
    const now = ctx.devices()[d.id];
    const s = ctx.session(d.id);
    if (s && now && (s.host !== now.host || s.port !== now.port))
      s.end("the group's leader moved");
    return ctx.connected(d.id, ANSWER_MS);
  };

  /** What the Default Media Receiver is playing on `transport`, enough to load it again where it was. */
  const playing = async (s: CastSession, transport: string) => {
    s.connect(transport);
    const r = MediaStatus.safeParse(
      await request(clock, s, NS.media, transport, { type: "GET_STATUS" }),
    );
    const m = r.success ? r.data.status?.[0] : undefined;
    return m?.media?.contentId
      ? {
          media: m.media,
          currentTime: m.currentTime ?? 0,
          autoplay: m.playerState !== "PAUSED",
        }
      : undefined;
  };

  /** Each member's volume and mute, from the group's multizone status. */
  const memberLevels = async (s: CastSession) => {
    const r = MultizoneStatus.safeParse(
      await request(clock, s, NS.multizone, RECEIVER, { type: "GET_STATUS" }),
    );
    if (!r.success)
      throw new Error(
        "an answer to the group's multizone status that is not one",
      );
    return (r.data.status?.devices ?? []).flatMap((m) => {
      if (!m.deviceId) return [];
      const id = castKey(m.deviceId);
      return [
        {
          id,
          name: ctx.devices()[id]?.name ?? m.name ?? m.deviceId,
          level: m.volume?.level,
          muted: m.volume?.muted,
        },
      ];
    });
  };

  /** LAUNCH the Default Media Receiver and wait for a receiver status that shows it running with a transport. */
  const launch = (s: CastSession): Promise<Application> => {
    const id = s.nextId();
    const app = waitFor(
      clock,
      s,
      ANSWER_MS,
      "Default Media Receiver",
      (raw) => {
        if (
          raw.requestId === id &&
          typeof raw.type === "string" &&
          REFUSALS.has(raw.type)
        )
          throw new Error(
            `LAUNCH refused: ${raw.type}${typeof raw.reason === "string" ? ` (${raw.reason})` : ""}`,
          );
        const r = ReceiverStatus.safeParse(raw);
        return r.success
          ? r.data.status?.applications?.find(
              (a) => a.appId === DEFAULT_MEDIA_RECEIVER && a.transportId,
            )
          : undefined;
      },
    );
    s.send(NS.receiver, RECEIVER, {
      type: "LAUNCH",
      appId: DEFAULT_MEDIA_RECEIVER,
      requestId: id,
    });
    return app;
  };

  /**
   * LOAD the clip and wait until its media session goes IDLE: true when FINISHED, an error for any other reason. The media
   * session comes from LOAD's own reply, read in the same listener, so an IDLE from before the LOAD never counts.
   */
  const play = async (
    s: CastSession,
    transport: string,
    media: object,
    timeoutMs?: number,
  ): Promise<boolean> => {
    const loadId = s.nextId();
    let session: number | "any" | undefined;
    let durationS = 0;
    const cancel = new AbortController();
    const finished = waitFor(
      clock,
      s,
      () => timeoutMs ?? PLAY_MS + durationS * 1000,
      "end of the clip",
      (raw) => {
        const r = MediaStatus.safeParse(raw);
        if (!r.success) return undefined;
        if (raw.requestId === loadId)
          session = r.data.status?.[0]?.mediaSessionId ?? "any";
        if (session === undefined) return undefined;
        for (const m of r.data.status ?? []) {
          if (
            session !== "any" &&
            m.mediaSessionId !== undefined &&
            m.mediaSessionId !== session
          )
            continue;
          if (typeof m.media?.duration === "number")
            durationS = m.media.duration;
          if (m.playerState !== "IDLE" || !m.idleReason) continue;
          if (m.idleReason === "FINISHED") return true;
          throw new Error(`the clip stopped: ${m.idleReason}`);
        }
        return undefined;
      },
      cancel.signal,
    );
    finished.catch(() => {}); // awaited below; until then a cancel must not surface as unhandled
    try {
      await request(
        clock,
        s,
        NS.media,
        transport,
        { type: "LOAD", media, autoplay: true },
        loadId,
      );
    } catch (error) {
      cancel.abort();
      throw error;
    }
    return finished;
  };

  // A lane per device, so a speaker that stopped answering holds up only itself. Level and mute are separate slots:
  // a SET_VOLUME carries one or the other, never both.
  const lanes = new Map<string, WriteLane>();
  const setVolume = (
    target: string,
    volume: { level: number } | { muted: boolean },
  ) => {
    const id = find(target).id;
    if (!lanes.has(id))
      lanes.set(
        id,
        writeLane({ gapMs: 0, perMinute: VOLUME_PER_MINUTE, clock }),
      );
    return lanes
      .get(id)!
      .send("level" in volume ? "level" : "muted", volume, (v) =>
        receiver(live(find(target)), { type: "SET_VOLUME", volume: v }),
      );
  };

  return {
    async setVolume(target, level) {
      checkLevel(level);
      await setVolume(target, { level });
    },
    async setMuted(target, muted) {
      await setVolume(target, { muted });
    },
    async stop(target) {
      const s = live(find(target));
      const app = (await receiver(s)).applications?.[0];
      if (app && !app.isIdleScreen)
        await receiver(s, {
          type: "STOP",
          ...(app.sessionId ? { sessionId: app.sessionId } : {}),
        });
    },

    /**
     * Read the target's state, set the volume if asked and unmute a muted target, launch the Default Media Receiver, play the clip to its end, then
     * put back what it can, always: what the Default Media Receiver was playing is loaded again where it was, an idle
     * device gets STOP, then the volume (a group's, member by member through each member's own socket). Another app
     * (Spotify, YouTube) is interrupted and cannot be resumed from here; the result says so. Throws only before anything changed.
     */
    async announce(target, clip, options = {}) {
      if (options.volume !== undefined) checkLevel(options.volume);
      if (!("url" in clip) && !ctx.serve)
        throw new Error(
          "a clip of bytes needs serve: serveClip from @khalido/home/cast/serve",
        );
      let d = find(target);
      const s = d.kind === "group" ? await regroup(d) : live(d);
      d = ctx.devices()[d.id] ?? d; // a group's host as discovery gives it now, for serving the clip on its network
      const before = await receiver(s);
      const prior = before.applications?.[0];
      const priorMedia =
        prior?.appId === DEFAULT_MEDIA_RECEIVER && prior.transportId
          ? await playing(s, prior.transportId)
          : undefined;
      const unmute = before.volume?.muted === true; // a muted target would play the clip silently
      const members =
        d.kind === "group" && (options.volume !== undefined || unmute)
          ? await memberLevels(s)
          : [];
      const result: AnnounceResult = {
        played: false,
        restored: [],
        notRestored: [],
      };
      const serving = new AbortController();
      let served: { close(): void } | undefined;
      let volumeSet = false;
      let launched = false;
      let ours: Application | undefined;
      try {
        let url: string;
        if ("url" in clip) url = clip.url;
        else
          ({ url } = served = await ctx.serve!(clip.bytes, clip.type, {
            host: d.host,
            signal: serving.signal,
          }));
        // Level and mute as two requests: Google's receiver docs take one or the other in a SET_VOLUME, not both.
        if (options.volume !== undefined || unmute) volumeSet = true;
        if (options.volume !== undefined)
          await receiver(s, {
            type: "SET_VOLUME",
            volume: { level: options.volume },
          });
        if (unmute)
          await receiver(s, { type: "SET_VOLUME", volume: { muted: false } });
        launched = true;
        ours = await launch(s);
        s.connect(ours.transportId!);
        result.played = await play(
          s,
          ours.transportId!,
          {
            contentId: url,
            contentType: clip.type ?? "audio/mpeg",
            streamType: "BUFFERED",
          },
          options.timeoutMs,
        );
      } catch (error) {
        result.why = errorText(error);
      } finally {
        serving.abort();
        served?.close();
        if (launched) await restoreApp();
        if (volumeSet) await restoreVolume();
      }
      return result;

      async function restoreApp() {
        try {
          // A LAUNCH that timed out may still have started: look before deciding nothing of ours runs.
          const now =
            ours ??
            (await receiver(s)).applications?.find(
              (a) => a.appId === DEFAULT_MEDIA_RECEIVER && a.transportId,
            );
          if (!now) return;
          if (priorMedia) {
            s.connect(now.transportId!);
            await request(clock, s, NS.media, now.transportId!, {
              type: "LOAD",
              ...priorMedia,
            });
            result.restored.push(`${d.name}: what was playing`);
            return;
          }
          await receiver(s, {
            type: "STOP",
            ...(now.sessionId ? { sessionId: now.sessionId } : {}),
          });
          if (idleApp(prior) || prior?.appId === DEFAULT_MEDIA_RECEIVER)
            result.restored.push(`${d.name}: idle`);
          else
            result.notRestored.push({
              name: d.name,
              why: `${prior?.displayName ?? prior?.appId ?? "an app"} was interrupted and cannot be resumed from here`,
            });
        } catch (error) {
          result.notRestored.push({
            name: d.name,
            why: `${priorMedia ? "what was playing" : "idle"} not restored: ${errorText(error)}`,
          });
        }
      }

      async function restoreVolume() {
        const each =
          d.kind === "group"
            ? members
            : [
                {
                  id: d.id,
                  name: d.name,
                  level: before.volume?.level,
                  muted: before.volume?.muted,
                },
              ];
        for (const m of each) {
          const ms = m.id === d.id ? s : ctx.session(m.id);
          if (m.level === undefined)
            result.notRestored.push({
              name: m.name,
              why: "its volume before was not reported",
            });
          else if (!ms)
            result.notRestored.push({
              name: m.name,
              why: "not connected, so its volume stays as the announcement set it",
            });
          else
            try {
              await receiver(ms, {
                type: "SET_VOLUME",
                volume: { level: m.level },
              });
              if (m.muted)
                await receiver(ms, {
                  type: "SET_VOLUME",
                  volume: { muted: true },
                });
              result.restored.push(
                `${m.name}: volume${m.muted ? ", muted" : ""}`,
              );
            } catch (error) {
              result.notRestored.push({
                name: m.name,
                why: `volume not restored: ${errorText(error)}`,
              });
            }
        }
      }
    },
  };
}
