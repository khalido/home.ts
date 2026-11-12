import type { Clock } from "../../clock.ts";
import { errorText } from "../../connector.ts";
import { type WriteLane, writeLane } from "../../lane.ts";
import { CAST_WAV, castWav, isWav, type WavFormat, wavText } from "./wav.ts";
import { NS } from "./codec.ts";
import {
  type Application,
  MediaStatus,
  MultizoneStatus,
  ReceiverStatus,
} from "./schemas.ts";
import {
  type CastDevice,
  castKey,
  DEFAULT_MEDIA_RECEIVER,
  findCast,
} from "./state.ts";

// Writes over the sockets `cast()` already holds: volume, mute, stop, and an announcement that plays a clip and puts
// the device back as it was. Never called by the integration itself; announce, volume and mute have run on real devices (the README has the dates).

/** Each request (a status, a volume, LAUNCH, LOAD, STOP) gets this long to answer. */
export const ANSWER_MS = 10_000;
/** How long an announcement waits for its clip to finish, beyond the clip's own length when the device reports it. */
export const PLAY_MS = 60_000;
/** How long a clip gets to start playing. A clip a speaker can't play took 35–44 s to say so (live, 2026-11-09); good ones start within a few seconds. A stated guess. */
export const START_MS = 15_000;

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

/** One Cast message, as a dry run reports it: the device it goes to, the channel (`receiver` or the app's `media`) and the payload. */
export type CastRequest = {
  device: string;
  channel: "receiver" | "media";
  payload: Record<string, unknown>;
};
/** `dryRun`: run every check a real write runs (the target, its connection, the input) and the reads it makes first, send no write, and say what would go. */
export type CastWriteOptions = { dryRun?: boolean };
/** A dry run's answer: the messages in order; empty when there is nothing to send. */
export type CastDryRun = { wouldSend: CastRequest[] };

/**
 * What `announce` did: whether the clip played to its end, why not, and what it put back or could not. A dry run has
 * `played: false`, `why: "dry run"`, `wouldSend`, and in `notRestored` what the real one could not put back.
 */
export type AnnounceResult = {
  played: boolean;
  why?: string;
  restored: string[];
  notRestored: { name: string; why: string }[];
  wouldSend?: CastRequest[];
};

/** Serves bytes once over HTTP on the LAN: `serveClip` from `@khalido/home/cast/serve`. `host` is the device that will fetch it. */
export type ServeClip = (
  bytes: Uint8Array,
  type: string,
  options?: { host?: string; signal?: AbortSignal },
) => Promise<{ url: string; close(): void }>;

/** The writes on `cast()`'s object. A target is a device's or group's name (any case) or its castId; volume is 0 to 1, as the snapshot's. */
export type CastActions = {
  /** Resolves `undefined` once sent, or a `CastDryRun` under `dryRun`. */
  setVolume(
    target: string,
    level: number,
    options?: CastWriteOptions,
  ): Promise<CastDryRun | undefined>;
  setMuted(
    target: string,
    muted: boolean,
    options?: CastWriteOptions,
  ): Promise<CastDryRun | undefined>;
  /** Ends the running app (receiver STOP), which returns the device to its idle screen. Nothing running: nothing sent. */
  stop(
    target: string,
    options?: CastWriteOptions,
  ): Promise<CastDryRun | undefined>;
  announce(
    target: string,
    clip: CastClip,
    options?: { volume?: number; timeoutMs?: number } & CastWriteOptions,
  ): Promise<AnnounceResult>;
  /** `announce` to several targets at once, one result per device, in the order given. A target that can't be reached is its own `played: false`. A group and one of its own members are not told apart. */
  announceAll(
    targets: string[],
    clip: CastClip,
    options?: { volume?: number; timeoutMs?: number } & CastWriteOptions,
  ): Promise<(AnnounceResult & { target: string })[]>;
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
  what: string | (() => string),
  pick: (raw: RawPayload) => T | undefined,
  signal?: AbortSignal,
): Promise<T> {
  const name = () => (typeof what === "string" ? what : what());
  return new Promise<T>((resolve, reject) => {
    const done = new AbortController();
    const finish = (settle: () => void) =>
      done.signal.aborted ||
      (off(),
      signal?.removeEventListener("abort", cancel),
      done.abort(),
      settle());
    const cancel = () =>
      finish(() => reject(new Error(`stopped waiting for ${name()}`)));
    const off = s.listen((raw) => {
      if (raw === undefined)
        return finish(() =>
          reject(new Error(`the socket closed waiting for ${name()}`)),
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
        reject(new Error(`no ${name()} in ${Math.round(limit() / 1000)} s`)),
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
    const d = findCast(ctx.devices(), target);
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
    media: { contentId: string; contentType: string; streamType: string },
    timeoutMs?: number,
  ): Promise<boolean> => {
    const loadId = s.nextId();
    let session: number | "any" | undefined;
    let durationS = 0;
    let started = false; // it has reached PLAYING: BUFFERING is where a clip it can't play sits
    const cancel = new AbortController();
    const finished = waitFor(
      clock,
      s,
      () => timeoutMs ?? (started ? PLAY_MS + durationS * 1000 : START_MS),
      () =>
        started
          ? "end of the clip"
          : `start of the clip (${media.contentType}, which this device may not play)`,
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
          if (m.playerState === "PLAYING") started = true;
          if (m.playerState !== "IDLE" || !m.idleReason) continue;
          if (m.idleReason === "FINISHED") return true;
          throw new Error(
            `the clip stopped: ${m.idleReason}${m.detailedErrorCode === undefined ? "" : ` (detailed error ${m.detailedErrorCode})`}${m.idleReason === "ERROR" ? `; this device may not play ${media.contentType}` : ""}`,
          );
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

  const toReceiver = (
    d: CastDevice,
    payload: Record<string, unknown>,
  ): CastRequest => ({ device: d.name, channel: "receiver", payload });
  /** A dry SET_VOLUME: the target found and connected, nothing sent. */
  const dryVolume = (
    target: string,
    volume: { level: number } | { muted: boolean },
  ): CastDryRun => {
    const d = find(target);
    live(d);
    return {
      wouldSend: [toReceiver(d, { type: "SET_VOLUME", volume })],
    };
  };

  /** Each WAV clip made here, and the format it came from, so a dry run can say what was converted. */
  const fromWav = new WeakMap<Uint8Array, WavFormat>();
  /** WAV bytes as 48 kHz 16-bit stereo, which audio-only speakers play (`wav.ts`); any other clip as it is. */
  const playable = (clip: CastClip): CastClip => {
    if ("url" in clip || !isWav(clip.type) || fromWav.has(clip.bytes))
      return clip;
    const r = castWav(clip.bytes);
    if (r.converted) fromWav.set(r.bytes, r.from);
    return { bytes: r.bytes, type: "audio/wav" };
  };

  const actions: CastActions = {
    async setVolume(target, level, options) {
      checkLevel(level);
      if (options?.dryRun) return dryVolume(target, { level });
      await setVolume(target, { level });
    },
    async setMuted(target, muted, options) {
      if (options?.dryRun) return dryVolume(target, { muted });
      await setVolume(target, { muted });
    },
    async stop(target, options) {
      const d = find(target);
      const s = live(d);
      const app = (await receiver(s)).applications?.[0];
      const stop = {
        type: "STOP",
        ...(app?.sessionId ? { sessionId: app.sessionId } : {}),
      };
      const running = app && !app.isIdleScreen;
      if (options?.dryRun)
        return { wouldSend: running ? [toReceiver(d, stop)] : [] };
      if (running) await receiver(s, stop);
    },

    /**
     * Read the target's state, set the volume if asked and unmute a muted target, launch the Default Media Receiver, play the clip to its end, then
     * put back what it can, always: what the Default Media Receiver was playing is loaded again where it was, an idle
     * device gets STOP, then the volume (a group's own first, then member by member through each member's own socket). Another app
     * (Spotify, YouTube) is interrupted and cannot be resumed from here; the result says so. Throws only before anything changed.
     */
    async announce(target, given, options = {}) {
      if (options.volume !== undefined) checkLevel(options.volume);
      if (!("url" in given) && !ctx.serve)
        throw new Error(
          "a clip of bytes needs serve: serveClip from @khalido/home/cast/serve",
        );
      const clip = playable(given); // a bad WAV throws here, before anything changed
      const wavFrom = "url" in clip ? undefined : fromWav.get(clip.bytes);
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
      if (options.dryRun) return dryAnnounce();
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

      /** What the announce would send, from the reads above; what it could not put back goes in `notRestored`. */
      function dryAnnounce(): AnnounceResult {
        const to = (
          device: { name: string },
          payload: Record<string, unknown>,
        ): CastRequest => ({
          device: device.name,
          channel: "receiver",
          payload,
        });
        const media = (payload: Record<string, unknown>): CastRequest => ({
          device: d.name,
          channel: "media",
          payload,
        });
        const sends: CastRequest[] = [];
        if (options.volume !== undefined)
          sends.push(
            to(d, { type: "SET_VOLUME", volume: { level: options.volume } }),
          );
        if (unmute)
          sends.push(to(d, { type: "SET_VOLUME", volume: { muted: false } }));
        sends.push(
          to(d, { type: "LAUNCH", appId: DEFAULT_MEDIA_RECEIVER }),
          media({
            type: "LOAD",
            media: {
              contentId:
                "url" in clip
                  ? clip.url
                  : `(${clip.bytes.length} bytes of ${clip.type}${wavFrom ? `, converted from ${wavText(wavFrom)} to ${wavText(CAST_WAV)}` : ""}, served on the LAN)`,
              contentType: clip.type ?? "audio/mpeg",
              streamType: "BUFFERED",
            },
            autoplay: true,
          }),
        );
        if (priorMedia) sends.push(media({ type: "LOAD", ...priorMedia }));
        else {
          sends.push(to(d, { type: "STOP" }));
          if (!idleApp(prior) && prior?.appId !== DEFAULT_MEDIA_RECEIVER)
            result.notRestored.push({
              name: d.name,
              why: `${prior?.displayName ?? prior?.appId ?? "an app"} would be interrupted and cannot be resumed from here`,
            });
        }
        for (const step of volumeSteps())
          if ("gap" in step)
            result.notRestored.push({ name: step.name, why: step.gap });
          else for (const p of step.payloads) sends.push(to(step, p));
        return { ...result, why: "dry run", wouldSend: sends };
      }

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

      /**
       * The volume put back after the clip, as steps: a group's own level first (it keeps one of its own, which its members'
       * levels don't bring back: live, 2026-11-10, it stayed at the announcement's 30 with every member restored), so
       * whatever it does to the members, their own levels land last; then each member's, or the target's, through its own
       * socket. A step it can't take is a gap with the reason. `restoreVolume` takes them; a dry run reports them.
       */
      function volumeSteps(): (
        | {
            name: string;
            socket: CastSession;
            payloads: Record<string, unknown>[];
            label: string;
          }
        | { name: string; gap: string }
      )[] {
        const steps: ReturnType<typeof volumeSteps> = [];
        if (d.kind === "group" && options.volume !== undefined) {
          const level = before.volume?.level;
          steps.push(
            level === undefined
              ? { name: d.name, gap: "its volume before was not reported" }
              : {
                  name: d.name,
                  socket: s,
                  payloads: [{ type: "SET_VOLUME", volume: { level } }],
                  label: `${d.name}: volume`,
                },
          );
        }
        const each =
          d.kind === "group"
            ? members
            : options.volume !== undefined || unmute
              ? [
                  {
                    id: d.id,
                    name: d.name,
                    level: before.volume?.level,
                    muted: before.volume?.muted,
                  },
                ]
              : [];
        for (const m of each) {
          const ms = m.id === d.id ? s : ctx.session(m.id);
          if (m.level === undefined)
            steps.push({
              name: m.name,
              gap: "its volume before was not reported",
            });
          else if (!ms)
            steps.push({
              name: m.name,
              gap: "not connected, so its volume stays as the announcement set it",
            });
          else
            steps.push({
              name: m.name,
              socket: ms,
              payloads: [
                { type: "SET_VOLUME", volume: { level: m.level } },
                ...(m.muted
                  ? [{ type: "SET_VOLUME", volume: { muted: true } }]
                  : []),
              ],
              label: `${m.name}: volume${m.muted ? ", muted" : ""}`,
            });
        }
        return steps;
      }

      async function restoreVolume() {
        for (const step of volumeSteps()) {
          if ("gap" in step) {
            result.notRestored.push({ name: step.name, why: step.gap });
            continue;
          }
          try {
            for (const p of step.payloads)
              await receiver(step.socket, p as { type: string });
            result.restored.push(step.label);
          } catch (error) {
            result.notRestored.push({
              name: step.name,
              why: `volume not restored: ${errorText(error)}`,
            });
          }
        }
      }
    },

    async announceAll(targets, given, options = {}) {
      // A caller's mistake is one error, not a failure per speaker.
      if (options.volume !== undefined) checkLevel(options.volume);
      if (!("url" in given) && !ctx.serve)
        throw new Error(
          "a clip of bytes needs serve: serveClip from @khalido/home/cast/serve",
        );
      const clip = playable(given); // converted once, for every target
      const id = (t: string) => {
        try {
          return find(t).id;
        } catch {
          return t; // unknown: announce says so, as this target's own failure
        }
      };
      const once = targets.filter(
        (t, i) => targets.findIndex((o) => id(o) === id(t)) === i,
      ); // one device twice would save the first's volume as the one to restore
      return Promise.all(
        once.map(async (target) => ({
          target,
          ...(await actions
            .announce(target, clip, options)
            .catch((error): AnnounceResult => ({
              played: false,
              why: errorText(error),
              restored: [],
              notRestored: [],
            }))),
        })),
      );
    },
  };
  return actions;
}
