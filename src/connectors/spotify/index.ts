import { z } from "zod";
import { asOf, type Clock, realClock } from "../../clock.ts";
import { ConnectorError, errorText } from "../../connector.ts";
import type { Integration, Part, Status } from "../../home.ts";
import { writeLane } from "../../lane.ts";
import type { Manifest } from "../../manifest.ts";
import { spotifyText, stallText } from "./changes.ts";
import {
  commandFrame,
  fold,
  Frame,
  FRAME_TYPES,
  OPEN,
  oddities,
  positionMs,
  type SocketFactory,
  type SocketLike,
  type SpotifyState,
  type Stall,
  toSpotifyUri,
} from "./client.ts";

export {
  positionMs,
  type PositionAnchor,
  type SocketFactory,
  type SocketLike,
  type SpotifyState,
  type Stall,
  toSpotifyUri,
  type Track,
} from "./client.ts";
export {
  type SpeakerState,
  speakerState,
  type SpotifyEvent,
  spotifyChanges,
  spotifyText,
} from "./changes.ts";

/** Soloist has no default port (`--ws ADDR:PORT` opens it); this library assumes this one, the port in chota-bot's unit. */
export const DEFAULT_URL = "ws://127.0.0.1:9091";

/** A Soloist speaker in a home config. No key: Soloist's API key is the daemon's, never the library's. */
export const configSchema = z.looseObject({
  connector: z.literal("spotify"),
  url: z
    .url({ protocol: /^wss?$/ })
    .optional()
    .describe(
      `Soloist's WebSocket, as its --ws flag opens it; ${DEFAULT_URL} when left out. It has no auth: keep it on loopback`,
    ),
  maxVolume: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe(
      "the loudest a write may set (0–100), and where a first play that starts above it is lowered to (Soloist issue #23)",
    ),
  repairStalls: z
    .boolean()
    .optional()
    .describe(
      "when playback stalls while Soloist says playing (Soloist issue #5), try once per track to restart it: a seek, then pause and play, or a skip when it is stuck past the track's end. Off unless set",
    ),
});

export type SpotifyConfig = {
  /** Soloist's WebSocket; `DEFAULT_URL` when left out. */
  url?: string;
  /** Volume ceiling 0–100 for writes, and for a first play that starts louder (issue #23). */
  maxVolume?: number;
  /** Try once per track to restart playback that stalled (issue #5): a write the library makes unasked, so off unless set. */
  repairStalls?: boolean;
  /** How often to look for a stall while playing, in ms; `STALL_CHECK_MS` by default, 0 to never look. */
  stallCheckMs?: number;
  /** Opens the socket; the runtime's `WebSocket` by default. Tests pass a fake. */
  connect?: SocketFactory;
  clock?: Clock;
};

/** Soloist's repeat modes. */
export type Repeat = "off" | "context" | "track";

/** What a write left: the state once Soloist reported the change (`confirmed`), or the state as it stood when `CONFIRM_MS` ran out without it. */
export type Applied = { state: SpotifyState; confirmed: boolean };

/**
 * What happened to the music around `duck` or `interrupt`'s `fn`: `untouched` (it was not playing, not connected, already
 * quiet, or the pause or lowering failed, so `fn` ran over it), `restored` (put back as it was), `kept` (someone changed it
 * meanwhile, or the pause never showed: left as it is) or `failed` (the resume or restore failed or Soloist has not
 * reported it, so the music may be left paused or quiet). `why` says which, except for `restored`.
 */
export type Music = "untouched" | "restored" | "kept" | "failed";
export type Aside<T> = { value: T; music: Music; why?: string };

/**
 * The writes, on the object `spotify()` returns. Each resolves once Soloist reports the change it asked for, with the state
 * then (`confirmed: true`), or after `CONFIRM_MS` with the state as it stands (`confirmed: false`). Each rejects with a
 * `ConnectorError` whose `code` is `offline`, `waiting` (nobody has picked the speaker), `refused`, `timeout` or `invalid`.
 */
export type SpotifyActions = {
  /** Play a Spotify link or URI (track, album, playlist, artist, episode, show), or resume what is loaded when none is given. */
  play(linkOrUri?: string): Promise<Applied>;
  pause(): Promise<Applied>;
  resume(): Promise<Applied>;
  next(): Promise<Applied>;
  prev(): Promise<Applied>;
  /** Jump to a position in the current track, in ms. */
  seek(ms: number): Promise<Applied>;
  /** Set the volume 0–100, held to `maxVolume` and rounded to a whole percent: `state.volume` is what Soloist then reports. */
  setVolume(volume: number): Promise<Applied>;
  /** Add a track to the queue (Soloist queues tracks only); confirmed when it shows in `upNext`. */
  queue(track: string): Promise<Applied>;
  setShuffle(on: boolean): Promise<Applied>;
  /** Repeat off, the context (playlist, album) or the track: two commands, in the order Soloist's docs give, as one write. */
  setRepeat(mode: Repeat): Promise<Applied>;
  /**
   * Pause if playing, run `fn`, then resume, unless someone changed it meanwhile (resumed, stopped or skipped it from a
   * phone): then it is theirs and stays. The resume runs even if `fn` throws. Not playing or not connected: just `fn`.
   * One `interrupt` or `duck` at a time; a second waits for the first, so never call either from inside `fn` (it would wait
   * forever). Two announcements back to back belong in one `fn`, or the music comes back between them.
   */
  interrupt<T>(fn: () => Promise<T> | T): Promise<Aside<T>>;
  /**
   * Lower the volume to `to` while `fn` runs, then put the earlier volume back, unless someone set the volume meanwhile.
   * For a short announcement over the music. Not playing, not connected or already at `to` or below: just `fn`.
   */
  duck<T>(fn: () => Promise<T> | T, options: { to: number }): Promise<Aside<T>>;
};

/** How long a command waits for Soloist's answer. Loopback answers in milliseconds; a stated guess. */
const COMMAND_TIMEOUT_MS = 3000;
/** How long a query holds the lane for its answer: a query Soloist doesn't answer (an empty queue may send nothing) shouldn't hold the writes behind it long. */
const QUERY_TIMEOUT_MS = 1000;
/** A socket that has said nothing this long after opening is closed: Soloist sends `auth_state` at once on connect. */
const HELLO_MS = 10_000;
/** After an idle → playing change, a volume above the cap is lowered for this long: the volume can come before or after the status (issue #23). */
const CAP_WINDOW_MS = 10_000;
/** How long a write waits for Soloist to report the change it asked for. Loopback events arrive in milliseconds; a stated guess. */
const CONFIRM_MS = 2000;
/** Between two commands. Soloist publishes no limit; it is on loopback; a stated guess. */
const WRITE_GAP_MS = 100;
/** While playing, a stall check this often: one `get_state`. Soloist issue #5 reports stalls 71–150 s into a track; a stated guess. */
const STALL_CHECK_MS = 20_000;
/** Still playing the same track this far past its length: stuck ("never moved on", issue #5). */
const OVERRUN_MS = 15_000;
/** After a repair's seek, how long before looking whether the position moves again. */
const REPAIR_WAIT_MS = 5000;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

/** Signed out is Soloist's normal state until someone picks the speaker (seen live 2026-11-08); a bad key looks the same (issue #18). */
const WAITING =
  "waiting for someone to pick it in the Spotify app; if nobody can, check Soloist's API key (Soloist issue #18)";

const REPEAT_ORDER: Record<Repeat, [[string, boolean], [string, boolean]]> = {
  off: [
    ["set_repeat_track", false],
    ["set_repeat_context", false],
  ],
  context: [
    ["set_repeat_track", false],
    ["set_repeat_context", true],
  ],
  track: [
    ["set_repeat_context", false],
    ["set_repeat_track", true],
  ],
};

/**
 * A Spotify Soloist speaker as one integration: one WebSocket to Soloist, its `auth_state` and `playback_state` on connect,
 * then its events folded in. A drop reconnects with backoff (1 s doubling to 60 s). Unreachable is `disconnected`;
 * running without a Spotify session is `connected` with `loggedIn: false` and the detail saying so. The writes are on the
 * same object, through one write lane, over the same socket.
 */
export function spotify(
  config: SpotifyConfig = {},
): Integration<SpotifyState, "spotify"> & SpotifyActions {
  const clock = config.clock ?? realClock;
  const url = config.url ?? DEFAULT_URL;
  const cap = config.maxVolume;
  const connect: SocketFactory =
    config.connect ?? ((u) => new WebSocket(u) as unknown as SocketLike);
  const lane = writeLane({ gapMs: WRITE_GAP_MS, clock });
  const checkMs = config.stallCheckMs ?? STALL_CHECK_MS;

  let state: SpotifyState = { asOf: asOf(clock) };
  let socket: SocketLike | undefined;
  let open = false;
  let heard = false; // an auth_state on this socket: until then the part stays connecting
  let whole = false; // signed in, the first playback_state has come too (or HELLO_MS passed): a one-shot read sees the track
  let down: string | undefined; // why the last socket ended, while there is none open
  let statusKnown = false; // Soloist has told this socket its status: only then is idle → playing an edge
  let queueAsked = false; // get_queue sent on this socket
  let signedIn = false; // signed out → in on this socket: the first status after it counts as a start if it is playing
  let capUntil = -Infinity;
  let capped = false; // the cap has been sent in this window
  let capNote: string | undefined; // the last first-play lowering, in `anomaly` until the speaker goes idle
  let frameNote: string | undefined; // a frame the schema rejected, or an error nothing was waiting for
  let note: string | undefined; // a write the integration made itself that failed (the cap, interrupt's resume), in `detail`
  let pending:
    | { command: string; answers?: string; finish: (error?: Error) => void }
    | undefined; // the lane sends one at a time
  const waiters = new Set<() => void>();
  let report: ((part: Part<SpotifyState>) => void) | undefined;
  let wake: AbortController | undefined; // cuts a backoff short on refresh
  let reported = false;

  const publish = () => {
    let status: Status;
    let detail: string | undefined;
    if (!open)
      ((status = reported || down ? "disconnected" : "connecting"),
        (detail = down));
    else if (!heard || (state.loggedIn === true && !whole))
      status = "connecting";
    else
      ((status = "connected"),
        (detail = state.loggedIn === false ? WAITING : note));
    // Connecting is reported never: before the first report createHome's placeholder says it, and a reconnect stays
    // disconnected until Soloist has answered, so two reports in a row never hide a change behind a half-done connect.
    if (status === "connecting") return;
    const anomaly =
      [capNote, stallText(state.stalled), oddities(state), frameNote]
        .filter(Boolean)
        .join("; ") || undefined;
    frameNote = undefined;
    reported = true;
    report?.({ status, detail, anomaly, state });
  };

  const offline = () =>
    new ConnectorError(`Soloist is not connected at ${url}`, {
      code: "offline",
    });

  /**
   * Send one command and wait for its answer: a control's `command_result`, or for a query the frame it `answers`
   * (`get_state` → `playback_state`). An `error` carries no command, so it is the one in flight's: every command, queries
   * too, goes through the lane, one at a time.
   */
  const command = (
    name: string,
    fields: Record<string, unknown> = {},
    answers?: string,
  ) =>
    new Promise<void>((resolve, reject) => {
      const s = socket;
      if (!s || !open || s.readyState !== OPEN) return reject(offline());
      if (state.loggedIn === false && !answers)
        return reject(new ConnectorError(WAITING, { code: "waiting" }));
      const stop = new AbortController();
      const p = {
        command: name,
        answers,
        finish: (error?: Error) => {
          if (pending !== p) return;
          pending = undefined;
          stop.abort();
          if (error) return reject(error);
          if (!answers) note = undefined; // a write that worked: an earlier failed one is no longer news
          resolve();
        },
      };
      pending = p;
      s.send(commandFrame(name, fields));
      const ms = answers ? QUERY_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
      void clock
        .sleep(ms, stop.signal)
        .then(
          () =>
            stop.signal.aborted ||
            p.finish(
              new ConnectorError(
                `Soloist did not answer ${name} in ${ms / 1000} s`,
                { code: "timeout" },
              ),
            ),
        );
    });

  /** A command, and for a write how to tell it took: `took(now, before, at)`, `before` the state and `at` the time it was sent. */
  type Body = {
    command: string;
    fields?: Record<string, unknown>;
    answers?: string;
    then?: { command: string; fields: Record<string, unknown> };
    took?: (now: SpotifyState, before: SpotifyState, at: number) => boolean;
  };
  const send = async (body: Body) => {
    const before = state;
    const at = clock.now();
    await command(body.command, body.fields, body.answers);
    if (body.then) await command(body.then.command, body.then.fields); // repeat's second half, still this write's turn
    return { before, at };
  };
  let once = 0; // skips and queued tracks never merge: two nexts are two skips
  const write = (slot: string, body: Body) => lane.send(slot, body, send);
  /**
   * A write through the lane, resolved once the state shows that this caller's own change took, or `CONFIRM_MS` after
   * Soloist accepted the command that carried it (a merged write's may be another's: a pause merged into a later play never
   * confirms). A drop ends the wait early, unconfirmed.
   */
  const change = async (slot: string, body: Body): Promise<Applied> => {
    const sent = await write(slot, body);
    const took = () => body.took?.(state, sent.before, sent.at) ?? true;
    await waitFor(() => took() || !open, CONFIRM_MS);
    return { state, confirmed: took() };
  };
  /** The track restarted: a new anchor near 0 when it had been 5 s or more in (a prev past the first seconds, a next on repeat-track). */
  const restarted = (s: SpotifyState, b: SpotifyState, at: number) =>
    s.position !== b.position &&
    (s.position?.ms ?? Infinity) < 5000 &&
    (positionMs(b, at) ?? 0) >= 5000;
  const newTrack = (s: SpotifyState, b: SpotifyState) =>
    !!s.track && s.track.uri !== b.track?.uri;
  const invalid = (message: string) =>
    new ConnectorError(message, { code: "invalid" });
  const volumeTo = (v: number) =>
    change("volume", {
      command: "set_volume",
      fields: { volume: v },
      took: (s) => s.volume === v,
    });
  /** Ask Soloist for something, through the lane; the same query twice merges. A refusal is an anomaly, a drop is the status's to say. */
  const ANSWERS = {
    get_state: "playback_state",
    get_auth_state: "auth_state",
    get_queue: "queue_changed",
  } as const;
  const query = (
    name: keyof typeof ANSWERS,
    fields?: Record<string, unknown>,
  ) =>
    void write(`query-${name}`, {
      command: name,
      fields,
      answers: ANSWERS[name],
    }).catch((error) => {
      // A drop is the status's to say; an unanswered get_queue may just be an empty queue (unverified).
      if (
        error instanceof ConnectorError &&
        (error.code === "offline" ||
          (error.code === "timeout" && name === "get_queue"))
      )
        return;
      frameNote = `${name} failed: ${errorText(error)}`;
      publish();
    });

  /** Within the window after idle → playing, a volume above the cap is lowered to it, once (issue #23). */
  const applyCap = () => {
    if (
      cap === undefined ||
      capped ||
      state.volume === undefined ||
      clock.now() > capUntil ||
      state.volume <= cap
    )
      return;
    capped = true;
    capNote = `started at volume ${state.volume}, above maxVolume ${cap}; lowered it (Soloist issue #23)`;
    change("volume", {
      command: "set_volume",
      fields: { volume: cap },
      took: (s) => s.volume === cap,
    }).catch(
      (error) => (
        (note = `lowering the volume to ${cap} failed: ${errorText(error)}`),
        publish()
      ),
    );
  };

  const handle = (data: unknown) => {
    let raw: unknown;
    try {
      raw = JSON.parse(String(data));
    } catch {
      return;
    }
    const type = (raw as { type?: unknown } | null)?.type;
    if (typeof type !== "string" || !FRAME_TYPES.has(type)) return; // anything new: not read here
    const parsed = Frame.safeParse(raw);
    if (!parsed.success)
      return (
        (frameNote = `a ${type} the schema did not recognise`),
        publish()
      );
    const f = parsed.data;
    if (f.type === "command_result")
      return void (
        pending &&
        pending.command === f.command &&
        pending.finish()
      );
    if (f.type === "error") {
      const message = f.message ?? "an error with no message";
      if (pending)
        return pending.finish(
          new ConnectorError(`Soloist refused ${pending.command}: ${message}`, {
            code: "refused",
          }),
        );
      return ((frameNote = `Soloist said: ${message}`), publish());
    }
    const before = state.status;
    const wasSignedIn = state.loggedIn;
    state = fold(state, f, asOf(clock));
    if (f.type === "auth_state") {
      // Signed out there is no playback_state to wait for, and a later sign-in must not send the part back to connecting.
      if (!heard && f.logged_in !== true) whole = true;
      heard = true;
      if (f.logged_in === false) statusKnown = false;
      // A first sign-in (someone picked the speaker) sends only auth_state; the docs don't promise a playback_state after it.
      else if (f.logged_in === true && wasSignedIn === false)
        ((signedIn = true), query("get_state"));
    }
    if (f.type === "playback_state") {
      if (!queueAsked) ((queueAsked = true), query("get_queue", { limit: 10 })); // queue_changed pushes changes only, so ask once per socket
      whole = true;
    }
    if (pending?.answers === f.type) pending.finish();
    if (
      (f.type === "playback_state" || f.type === "playback_changed") &&
      f.status !== undefined
    ) {
      // A start is idle → playing, or a sign-in whose first status is playing: a phone picked the speaker and played (issue #23).
      const started =
        f.status === "playing" && (statusKnown ? before === "idle" : signedIn);
      if (started) ((capUntil = clock.now() + CAP_WINDOW_MS), (capped = false));
      signedIn = false;
      if (f.status === "idle") capNote = undefined;
      statusKnown = true;
    }
    stallOver();
    if (state.status !== "playing") seen = undefined; // a pause between two checks must not read as frozen
    applyCap();
    for (const w of [...waiters]) w();
    publish();
  };

  /** One socket's life: resolves with why it ended, and whether it got as far as open. */
  const session = (signal: AbortSignal) =>
    new Promise<{ why: string; opened: boolean }>((resolve) => {
      let s: SocketLike;
      try {
        s = connect(url);
      } catch (error) {
        return resolve({
          why: `could not open ${url}: ${errorText(error)}`,
          opened: false,
        });
      }
      socket = s;
      const quiet = new AbortController();
      let ended = false;
      const end = (why: string) => {
        if (ended) return;
        ended = true;
        quiet.abort();
        signal.removeEventListener("abort", stop);
        if (socket === s) socket = undefined;
        const was = open;
        open = false;
        heard = false;
        whole = false;
        queueAsked = false;
        statusKnown = false;
        signedIn = false;
        pending?.finish(offline());
        for (const w of [...waiters]) w(); // a write waiting to confirm stops waiting
        seen = undefined;
        resolve({ why: was ? why : `nothing answered at ${url}`, opened: was });
      };
      const stop = () => (end("stopped"), s.close());
      signal.addEventListener("abort", stop, { once: true });
      // An ended socket's late events belong to no session: they must not touch the next socket's state.
      s.onopen = () => {
        if (ended) return;
        open = true;
        down = undefined;
        note = undefined; // a new socket: what failed on the last one is history
        void clock.sleep(HELLO_MS, quiet.signal).then(() => {
          if (quiet.signal.aborted) return;
          if (!heard)
            return (
              end(`Soloist said nothing in ${HELLO_MS / 1000} s`),
              s.close()
            );
          if (!whole) ((whole = true), publish()); // signed in, no playback_state: connected with what there is
        });
      };
      s.onmessage = (ev) => void (ended || handle(ev.data));
      s.onerror = () => {}; // onclose follows and says it
      s.onclose = () => end("Soloist closed the socket");
    });

  /** Until `ok()` or `ms`, whichever first; each state change looks again. */
  const waitFor = async (ok: () => boolean, ms: number) => {
    if (ok()) return;
    const done = new AbortController();
    const check = () => ok() && done.abort();
    waiters.add(check);
    await clock.sleep(ms, done.signal);
    waiters.delete(check);
  };

  /** Not connected or not playing: the reason `duck` and `interrupt` just run `fn`. */
  const notPlaying = () =>
    !open
      ? "Soloist is not connected"
      : state.status === "playing" || state.status === "buffering"
        ? undefined
        : "it was not playing";
  /** A write the integration made itself that failed: in `detail`, and the reason returned. */
  const failed = (why: string) => ((note = why), publish(), why);
  let asides: Promise<unknown> = Promise.resolve();
  /** `state.aside` set or cleared, so `spotifyChanges` can mark what happens meanwhile as the library's own. */
  const marked = (kind?: "duck" | "interrupt" | "repair") => {
    const { aside: _, ...rest } = state;
    state = kind ? { ...rest, aside: kind } : rest;
    stallOver(); // a repair's skip changed the track while it ran
    publish();
  };
  /**
   * Run `fn` between `enter` and `leave`, one aside at a time. `enter` returns why it changed nothing (then `fn` just runs);
   * `leave` puts things back, or says why not, and runs even if `fn` throws.
   */
  const aside = <T>(
    kind: "duck" | "interrupt",
    fn: () => Promise<T> | T,
    enter: () => Promise<string | undefined>,
    leave: () => Promise<Left>,
  ) => {
    const run = async (): Promise<Aside<T>> => {
      if (open) marked(kind);
      try {
        return await within();
      } finally {
        if (state.aside) marked();
      }
    };
    const within = async (): Promise<Aside<T>> => {
      const skipped = await enter();
      if (skipped)
        return { value: await fn(), music: "untouched", why: skipped };
      let value: T;
      try {
        value = await fn();
      } catch (error) {
        await leave(); // its outcome is in `detail` when it fails; the error is fn's
        throw error;
      }
      return { value, ...(await leave()) };
    };
    const p = asides.then(run, run);
    asides = p.catch(() => {});
    return p;
  };
  type Left = Omit<Aside<never>, "value">;
  const putBack = (r: Applied, what: string): Left =>
    r.confirmed
      ? { music: "restored" }
      : {
          music: "failed",
          why: failed(`sent the ${what}; Soloist has not reported it`),
        };

  const actions: SpotifyActions = {
    async play(linkOrUri) {
      if (linkOrUri === undefined)
        return change("transport", {
          command: "play",
          took: (s) => s.status === "playing",
        });
      const uri = toSpotifyUri(linkOrUri);
      if (!uri) throw invalid(`not a Spotify link or URI: ${linkOrUri}`);
      return change("transport", {
        command: "play",
        fields: { uri },
        took: (s) =>
          s.status === "playing" &&
          (s.track?.uri === uri || s.context?.uri === uri),
      });
    },
    pause: () =>
      change("transport", {
        command: "pause",
        took: (s) => s.status === "paused",
      }),
    resume: () =>
      change("transport", {
        command: "play",
        took: (s) => s.status === "playing",
      }),
    // The end of the queue goes idle; repeat-track restarts it.
    next: () =>
      change(`once-${++once}`, {
        command: "skip_next",
        took: (s, b, at) =>
          newTrack(s, b) ||
          (s.status === "idle" && b.status !== "idle") ||
          restarted(s, b, at),
      }),
    prev: () =>
      change(`once-${++once}`, {
        command: "skip_prev",
        took: (s, b, at) => newTrack(s, b) || restarted(s, b, at),
      }),
    async seek(ms) {
      if (!Number.isFinite(ms) || ms < 0)
        throw invalid(`a position in ms, 0 or more, not ${ms}`);
      return change("seek", {
        command: "seek",
        fields: { position_ms: ms },
        took: (s, b) =>
          s.position !== b.position &&
          Math.abs((s.position?.ms ?? -Infinity) - ms) < 2000,
      });
    },
    async setVolume(volume) {
      if (!Number.isFinite(volume) || volume < 0 || volume > 100)
        throw invalid(`volume is 0–100, not ${volume}`);
      return volumeTo(
        Math.round(cap === undefined ? volume : Math.min(volume, cap)),
      );
    },
    async queue(track) {
      const uri = toSpotifyUri(track);
      if (!uri?.startsWith("spotify:track:"))
        throw invalid(`only a Spotify track can be queued, not ${track}`);
      return change(`once-${++once}`, {
        command: "add_to_queue",
        fields: { uri },
        took: (s) => !!s.upNext?.some((t) => t.uri === uri),
      });
    },
    setShuffle: (on) =>
      change("shuffle", {
        command: "set_shuffle",
        fields: { enabled: on },
        took: (s) => s.shuffle === on,
      }),
    async setRepeat(mode) {
      // developer.spotify.com/documentation/soloist/reference/websocket-api: clear the other mode first, then set this one.
      if (!Object.hasOwn(REPEAT_ORDER, mode))
        throw invalid(`repeat is off, context or track, not ${mode}`);
      const [first, second] = REPEAT_ORDER[mode];
      return change("repeat", {
        command: first[0],
        fields: { enabled: first[1] },
        then: { command: second[0], fields: { enabled: second[1] } },
        took: (s) => s.repeat === mode,
      });
    },
    interrupt(fn) {
      let track: string | undefined;
      let shown = false; // the pause showed
      return aside(
        "interrupt",
        fn,
        async () => {
          const no = notPlaying();
          if (no) return no;
          track = state.track?.uri;
          try {
            shown = (await actions.pause()).confirmed; // a pause that never shows still runs fn: what interrupts matters more
          } catch (error) {
            return failed(`pause before interrupt failed: ${errorText(error)}`);
          }
        },
        async () => {
          if (state.status !== "paused")
            return {
              music: "kept",
              why: shown
                ? `someone changed it meanwhile: it is ${state.status ?? "in an unknown state"}`
                : "Soloist never reported the pause",
            };
          if (state.track?.uri !== track)
            return { music: "kept", why: "the track changed meanwhile" };
          try {
            return putBack(await actions.resume(), "resume");
          } catch (error) {
            return {
              music: "failed",
              why: failed(`resume after interrupt failed: ${errorText(error)}`),
            };
          }
        },
      );
    },
    duck(fn, { to }) {
      if (!Number.isFinite(to) || to < 0 || to > 100)
        return Promise.reject(invalid(`duck's volume is 0–100, not ${to}`));
      let earlier = 0;
      let shown = false; // the lowered volume showed
      return aside(
        "duck",
        fn,
        async () => {
          const no = notPlaying();
          if (no) return no;
          if (state.volume === undefined) return "its volume is not known";
          if (state.volume <= to) return `it was already at ${state.volume}`;
          earlier = state.volume;
          try {
            shown = (await volumeTo(Math.round(to))).confirmed;
          } catch (error) {
            return failed(
              `lowering the volume for duck failed: ${errorText(error)}`,
            );
          }
        },
        async () => {
          if (state.volume !== Math.round(to))
            return {
              music: "kept",
              why: shown
                ? `someone set the volume to ${state.volume} meanwhile`
                : "Soloist never reported the lower volume",
            };
          try {
            return putBack(await volumeTo(earlier), `volume ${earlier}`);
          } catch (error) {
            return {
              music: "failed",
              why: failed(
                `restoring the volume to ${earlier} after duck failed: ${errorText(error)}`,
              ),
            };
          }
        },
      );
    },
  };

  /** The stall set or cleared, through `state` so a snapshot and `spotifyChanges` see it. */
  const stallAs = (stall?: Stall) => {
    const { stalled: _, ...rest } = state;
    state = stall ? { ...rest, stalled: stall } : rest;
    publish();
  };
  /** A stall ends when its track changes or stops being played; not during the repair's own pause or skip. */
  function stallOver() {
    const st = state.stalled;
    if (
      !st ||
      state.aside === "repair" ||
      (state.track?.uri === st.track &&
        (state.status === "playing" || state.status === "buffering"))
    )
      return;
    const { stalled: _, ...rest } = state;
    state = rest;
  }
  let seen: { track: string; ms: number; atMs: number } | undefined; // the last check's reported position
  let repairedFor: string | undefined; // at most one repair per track
  /** Ask Soloist where it is, waiting for the answer (or the query's timeout). */
  const fresh = () =>
    write("query-get_state", {
      command: "get_state",
      answers: "playback_state",
    }).then(
      () => undefined,
      () => undefined,
    );
  const where = () =>
    state.track &&
    state.position?.ms !== undefined &&
    state.position.atMs !== undefined
      ? {
          track: state.track.uri,
          ms: state.position.ms,
          atMs: state.position.atMs,
        }
      : undefined;
  /** Two fresh reports of one track, at least `gap` apart by Soloist's own clock, less than a second apart in position. */
  const frozen = (a: typeof seen, b: typeof seen, gap = checkMs / 2) =>
    !!a &&
    !!b &&
    a.track === b.track &&
    b.atMs - a.atMs >= gap &&
    Math.abs(b.ms - a.ms) < 1000;
  const playing = () => open && state.status === "playing" && !state.aside;

  /** One look while playing: a fresh position, then frozen, overrun, recovered or fine (Soloist issue #5). */
  const checkStall = async () => {
    if (!playing()) return void (seen = undefined);
    await fresh();
    if (!playing()) return void (seen = undefined);
    const now = where();
    const track = state.track;
    if (!track) return void (seen = undefined);
    // Repeat-track loops one track, so running past its length is normal there.
    const over =
      state.repeat !== "track" &&
      track.durationMs !== undefined &&
      (positionMs(state, clock.now()) ?? 0) > track.durationMs + OVERRUN_MS;
    const stuck = frozen(seen, now);
    if (
      now &&
      seen &&
      now.track === seen.track &&
      !stuck &&
      !over &&
      state.stalled?.track === now.track
    )
      stallAs(); // it moves again: recovered
    else if ((stuck || over) && !state.stalled) {
      stallAs({
        track: track.uri,
        ms: now?.ms ?? 0,
        how: over ? "overrun" : "frozen",
      });
      if (config.repairStalls && repairedFor !== track.uri)
        await repair(track.uri, over);
    }
    seen = where();
  };

  /** Once per track: a skip when stuck past the end; otherwise a seek to where it stuck, then pause and play if it still doesn't move. */
  const repair = (track: string, over: boolean) => {
    repairedFor = track;
    const tried = (what: string) =>
      state.stalled && stallAs({ ...state.stalled, tried: what });
    // Still ours to fix: playing this track, stalled, and no duck, interrupt or person in between.
    const ours = () =>
      open &&
      state.status === "playing" &&
      state.track?.uri === track &&
      state.stalled?.track === track &&
      (!state.aside || state.aside === "repair");
    const run = async () => {
      if (!ours()) return;
      marked("repair");
      try {
        if (over) return void (tried("a skip"), await actions.next());
        await actions.seek(state.stalled!.ms);
        tried("a seek");
        const at = where(); // where the seek left it
        await clock.sleep(REPAIR_WAIT_MS);
        if (!ours()) return;
        await fresh();
        if (!ours() || !frozen(at, where(), REPAIR_WAIT_MS / 2)) return;
        await actions.pause();
        await actions.resume();
        tried("a seek, then pause and play");
      } catch (error) {
        tried(`a repair that failed: ${errorText(error)}`);
      } finally {
        if (state.aside === "repair") marked();
      }
    };
    // In line with duck and interrupt: one aside at a time, so a repair never runs inside an announcement.
    const p = asides.then(run, run);
    asides = p.catch(() => {});
    return p;
  };

  return {
    ...actions,
    name: "spotify",
    /** Ask Soloist for its state again (`get_state`, or `get_auth_state` without a session); while it is unreachable, reconnect now. */
    refresh() {
      const s = socket;
      if (s && open && s.readyState === OPEN)
        return query(
          state.loggedIn === false || !heard ? "get_auth_state" : "get_state",
        );
      wake?.abort();
    },
    async run(signal, update) {
      report = update;
      if (checkMs > 0)
        void (async () => {
          while (!signal.aborted) {
            await clock.sleep(checkMs, signal);
            if (!signal.aborted)
              await checkStall().catch(
                (error) => (
                  (frameNote = `stall check failed: ${errorText(error)}`),
                  publish()
                ),
              );
          }
        })();
      let backoff = MIN_BACKOFF_MS;
      while (!signal.aborted) {
        const { why, opened } = await session(signal);
        if (signal.aborted) return;
        if (opened) backoff = MIN_BACKOFF_MS; // it had been up: start over
        down = why;
        publish();
        wake = new AbortController();
        await clock.sleep(backoff, AbortSignal.any([signal, wake.signal]));
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    },
  };
}

export const manifest: Manifest<SpotifyState> = {
  name: "spotify",
  title: "Spotify (Soloist)",
  iotClass: "local_push",
  access: "Soloist's WebSocket on loopback, no key",
  env: [
    {
      name: "SOLOIST_WS",
      example: DEFAULT_URL,
      what: "Soloist's --ws address as a URL; `home status` skips the speaker without it",
    },
    {
      name: "SOLOIST_MAX_VOLUME",
      example: "60",
      optional: true,
      what: "the loudest `home spotify volume` sets, and where a first play above it is lowered to",
    },
  ],
  /** Nothing until Soloist has said something: a speaker never reached has no line. */
  lines: ({ state }) =>
    state && (state.loggedIn !== undefined || state.status !== undefined)
      ? [spotifyText(state)]
      : [],
};
