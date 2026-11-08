import { z } from "zod";
import { asOf, type Clock, realClock } from "../../clock.ts";
import { ConnectorError, errorText } from "../../connector.ts";
import type { Integration, Part, Status } from "../../home.ts";
import { writeLane } from "../../lane.ts";
import type { Manifest } from "../../manifest.ts";
import { commandFrame, fold, Frame, FRAME_TYPES, OPEN, oddities, type SocketFactory, type SocketLike, type SpotifyState, toSpotifyUri } from "./client.ts";

export { positionMs, type PositionAnchor, type SocketFactory, type SocketLike, type SpotifyState, toSpotifyUri, type Track } from "./client.ts";

/** Soloist has no default port (`--ws ADDR:PORT` opens it); this library assumes this one, the port in chota-bot's unit. */
export const DEFAULT_URL = "ws://127.0.0.1:9091";

/** A Soloist speaker in a home config. No key: Soloist's API key is the daemon's, never the library's. */
export const configSchema = z.looseObject({
  connector: z.literal("spotify"),
  url: z.url({ protocol: /^wss?$/ }).optional().describe(`Soloist's WebSocket, as its --ws flag opens it; ${DEFAULT_URL} when left out. It has no auth: keep it on loopback`),
  maxVolume: z.number().int().min(0).max(100).optional().describe("the loudest a write may set (0–100), and where a first play that starts above it is lowered to (Soloist issue #23)"),
});

export type SpotifyConfig = {
  /** Soloist's WebSocket; `DEFAULT_URL` when left out. */
  url?: string;
  /** Volume ceiling 0–100 for writes, and for a first play that starts louder (issue #23). */
  maxVolume?: number;
  /** Opens the socket; the runtime's `WebSocket` by default. Tests pass a fake. */
  connect?: SocketFactory;
  clock?: Clock;
};

/** The writes, on the object `spotify()` returns. Each resolves when Soloist accepts the command (`command_result`): sent, not yet applied; the state follows. */
export type SpotifyActions = {
  /** Play a Spotify link or URI (track, album, playlist, episode), or resume what is loaded when none is given. */
  play(linkOrUri?: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  /** Jump to a position in the current track, in ms. */
  seek(ms: number): Promise<void>;
  /** Set the volume 0–100, held to `maxVolume` and rounded to a whole percent. Resolves to the volume sent. */
  setVolume(volume: number): Promise<number>;
  /** Add a track to the queue: Soloist queues tracks only. */
  queue(track: string): Promise<void>;
  setShuffle(on: boolean): Promise<void>;
  /** Pause if playing, run `fn`, then resume, even if `fn` throws. Not playing (or not connected): just run `fn`. For "pause the music, say this, carry on". */
  interrupt<T>(fn: () => Promise<T> | T): Promise<T>;
};

/** How long a command waits for Soloist's answer. Loopback answers in milliseconds; a stated guess. */
const COMMAND_TIMEOUT_MS = 3000;
/** A socket that has said nothing this long after opening is closed: Soloist sends `auth_state` at once on connect. */
const HELLO_MS = 10_000;
/** After an idle → playing change, a volume above the cap is lowered for this long: the volume can come before or after the status (issue #23). */
const CAP_WINDOW_MS = 10_000;
/** How long `interrupt` waits for the pause to show before running `fn`. */
const PAUSE_WAIT_MS = 2000;
/** Between two commands. Soloist publishes no limit; it is on loopback; a stated guess. */
const WRITE_GAP_MS = 100;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

const NOT_SIGNED_IN = "Soloist is running with no Spotify session: nobody has picked it in the Spotify app yet, or its API key is bad (a bad key never signs in, Soloist issue #18)";

/**
 * A Spotify Soloist speaker as one integration: one WebSocket to Soloist, its `auth_state` and `playback_state` on connect,
 * then its events folded in. A drop reconnects with backoff (1 s doubling to 60 s). Unreachable is `disconnected`;
 * running without a Spotify session is `connected` with `loggedIn: false` and the detail saying so. The writes are on the
 * same object, through one write lane, over the same socket.
 */
export function spotify(config: SpotifyConfig = {}): Integration<SpotifyState, "spotify"> & SpotifyActions {
  const clock = config.clock ?? realClock;
  const url = config.url ?? DEFAULT_URL;
  const cap = config.maxVolume;
  const connect: SocketFactory = config.connect ?? ((u) => new WebSocket(u) as unknown as SocketLike);
  const lane = writeLane({ gapMs: WRITE_GAP_MS, clock });

  let state: SpotifyState = { asOf: asOf(clock) };
  let socket: SocketLike | undefined;
  let open = false;
  let heard = false; // an auth_state on this socket: until then the part stays connecting
  let whole = false; // signed in, the first playback_state has come too (or HELLO_MS passed): a one-shot read sees the track
  let down: string | undefined; // why the last socket ended, while there is none open
  let statusKnown = false; // Soloist has told this socket its status: only then is idle → playing an edge
  let signedIn = false; // signed out → in on this socket: the first status after it counts as a start if it is playing
  let capUntil = -Infinity;
  let capped = false; // the cap has been sent in this window
  let capNote: string | undefined; // the last first-play lowering, in `anomaly` until the speaker goes idle
  let frameNote: string | undefined; // a frame the schema rejected, or an error nothing was waiting for
  let note: string | undefined; // a write the integration made itself that failed (the cap, interrupt's resume), in `detail`
  let pending: { command: string; answers?: string; finish: (error?: Error) => void } | undefined; // the lane sends one at a time
  const waiters = new Set<() => void>();
  let report: ((part: Part<SpotifyState>) => void) | undefined;
  let wake: AbortController | undefined; // cuts a backoff short on refresh
  let reported = false;

  const publish = () => {
    let status: Status;
    let detail: string | undefined;
    if (!open) (status = reported || down ? "disconnected" : "connecting"), (detail = down);
    else if (!heard || (state.loggedIn === true && !whole)) status = "connecting";
    else (status = "connected"), (detail = state.loggedIn === false ? NOT_SIGNED_IN : note);
    if (status === "connecting" && !reported) return;
    const anomaly = [capNote, oddities(state), frameNote].filter(Boolean).join("; ") || undefined;
    frameNote = undefined;
    reported = true;
    report?.({ status, detail, anomaly, state });
  };

  const offline = () => new ConnectorError(`Soloist is not connected at ${url}`, { code: "offline" });

  /**
   * Send one command and wait for its answer: a control's `command_result`, or for a query the frame it `answers`
   * (`get_state` → `playback_state`). An `error` carries no command, so it is the one in flight's: every command, queries
   * too, goes through the lane, one at a time.
   */
  const command = (name: string, fields: Record<string, unknown> = {}, answers?: string) =>
    new Promise<void>((resolve, reject) => {
      const s = socket;
      if (!s || !open || s.readyState !== OPEN) return reject(offline());
      if (state.loggedIn === false && !answers) return reject(new ConnectorError(NOT_SIGNED_IN, { code: "logged-out" }));
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
      void clock.sleep(COMMAND_TIMEOUT_MS, stop.signal).then(() => stop.signal.aborted || p.finish(new ConnectorError(`Soloist did not answer ${name} in ${COMMAND_TIMEOUT_MS / 1000} s`, { code: "timeout" })));
    });

  type Body = { command: string; fields?: Record<string, unknown>; answers?: string };
  const send = (body: Body) => command(body.command, body.fields, body.answers);
  let once = 0; // skips and queued tracks never merge: two nexts are two skips
  const write = (slot: string, body: Body) => lane.send(slot, body, send);
  /** Ask Soloist for its state, through the lane; queries merge into one. A refusal is an anomaly, a drop is the status's to say. */
  const query = (name: "get_state" | "get_auth_state") =>
    void write("query", { command: name, answers: name === "get_state" ? "playback_state" : "auth_state" }).catch((error) => {
      if (error instanceof ConnectorError && error.code === "offline") return;
      frameNote = `${name} failed: ${errorText(error)}`;
      publish();
    });

  /** Within the window after idle → playing, a volume above the cap is lowered to it, once (issue #23). */
  const applyCap = () => {
    if (cap === undefined || capped || state.volume === undefined || clock.now() > capUntil || state.volume <= cap) return;
    capped = true;
    capNote = `started at volume ${state.volume}, above maxVolume ${cap}; lowered it (Soloist issue #23)`;
    write("volume", { command: "set_volume", fields: { volume: cap } }).catch((error) => ((note = `lowering the volume to ${cap} failed: ${errorText(error)}`), publish()));
  };

  const handle = (data: unknown) => {
    let raw: unknown;
    try {
      raw = JSON.parse(String(data));
    } catch {
      return;
    }
    const type = (raw as { type?: unknown } | null)?.type;
    if (typeof type !== "string" || !FRAME_TYPES.has(type)) return; // queue_changed and anything new: not read here
    const parsed = Frame.safeParse(raw);
    if (!parsed.success) return (frameNote = `a ${type} the schema did not recognise`), publish();
    const f = parsed.data;
    if (f.type === "command_result") return void (pending && pending.command === f.command && pending.finish());
    if (f.type === "error") {
      const message = f.message ?? "an error with no message";
      if (pending) return pending.finish(new ConnectorError(`Soloist refused ${pending.command}: ${message}`, { code: "refused" }));
      return (frameNote = `Soloist said: ${message}`), publish();
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
      else if (f.logged_in === true && wasSignedIn === false) (signedIn = true), query("get_state");
    }
    if (f.type === "playback_state") whole = true;
    if (pending?.answers === f.type) pending.finish();
    if ((f.type === "playback_state" || f.type === "playback_changed") && f.status !== undefined) {
      // A start is idle → playing, or a sign-in whose first status is playing: a phone picked the speaker and played (issue #23).
      const started = f.status === "playing" && (statusKnown ? before === "idle" : signedIn);
      if (started) (capUntil = clock.now() + CAP_WINDOW_MS), (capped = false);
      signedIn = false;
      if (f.status === "idle") capNote = undefined;
      statusKnown = true;
    }
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
        return resolve({ why: `could not open ${url}: ${errorText(error)}`, opened: false });
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
        statusKnown = false;
        signedIn = false;
        pending?.finish(offline());
        resolve({ why: was ? why : `nothing answered at ${url}`, opened: was });
      };
      const stop = () => (end("stopped"), s.close());
      signal.addEventListener("abort", stop, { once: true });
      s.onopen = () => {
        open = true;
        down = undefined;
        note = undefined; // a new socket: what failed on the last one is history
        void clock.sleep(HELLO_MS, quiet.signal).then(() => {
          if (quiet.signal.aborted) return;
          if (!heard) return end(`Soloist said nothing in ${HELLO_MS / 1000} s`), s.close();
          if (!whole) (whole = true), publish(); // signed in, no playback_state: connected with what there is
        });
      };
      s.onmessage = (ev) => handle(ev.data);
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

  const actions: SpotifyActions = {
    play(linkOrUri) {
      if (linkOrUri === undefined) return write("transport", { command: "play" });
      const uri = toSpotifyUri(linkOrUri);
      if (!uri) return Promise.reject(new RangeError(`not a Spotify link or URI: ${linkOrUri}`));
      return write("transport", { command: "play", fields: { uri } });
    },
    pause: () => write("transport", { command: "pause" }),
    resume: () => write("transport", { command: "play" }),
    next: () => write(`once-${++once}`, { command: "skip_next" }),
    prev: () => write(`once-${++once}`, { command: "skip_prev" }),
    seek(ms) {
      if (!Number.isFinite(ms) || ms < 0) return Promise.reject(new RangeError(`a position in ms, 0 or more, not ${ms}`));
      return write("seek", { command: "seek", fields: { position_ms: ms } });
    },
    async setVolume(volume) {
      if (!Number.isFinite(volume) || volume < 0 || volume > 100) throw new RangeError(`volume is 0–100, not ${volume}`);
      const v = Math.round(cap === undefined ? volume : Math.min(volume, cap));
      await write("volume", { command: "set_volume", fields: { volume: v } });
      return v;
    },
    queue(track) {
      const uri = toSpotifyUri(track);
      if (!uri?.startsWith("spotify:track:")) return Promise.reject(new RangeError(`only a Spotify track can be queued, not ${track}`));
      return write(`once-${++once}`, { command: "add_to_queue", fields: { uri } });
    },
    setShuffle: (on) => write("shuffle", { command: "set_shuffle", fields: { enabled: on } }),
    async interrupt(fn) {
      const playing = () => state.status === "playing" || state.status === "buffering";
      if (!open || !playing()) return fn();
      try {
        await actions.pause();
      } catch (error) {
        // What interrupts the music matters more than the music: run it anyway, and leave the music as it is.
        note = `pause before interrupt failed: ${errorText(error)}`;
        publish();
        return fn();
      }
      await waitFor(() => !playing(), PAUSE_WAIT_MS);
      try {
        return await fn();
      } finally {
        await actions.resume().catch((error) => ((note = `resume after interrupt failed: ${errorText(error)}`), publish()));
      }
    },
  };

  return {
    ...actions,
    name: "spotify",
    /** Ask Soloist for its state again (`get_state`, or `get_auth_state` without a session); while it is unreachable, reconnect now. */
    refresh() {
      const s = socket;
      if (s && open && s.readyState === OPEN) return query(state.loggedIn === false || !heard ? "get_auth_state" : "get_state");
      wake?.abort();
    },
    async run(signal, update) {
      report = update;
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

/** The speaker in a few words: `Kitchen speaker: playing "Song" by Band · 35%`, or `…: not signed in`. */
export function spotifyText(s: SpotifyState): string {
  const who = s.deviceName ?? "Soloist";
  if (s.loggedIn === false) return `${who}: not signed in`;
  const t = s.track;
  const what = t ? `${t.name ? ` "${t.name}"` : ` ${t.uri}`}${t.artists.length ? ` by ${t.artists.join(", ")}` : ""}` : "";
  const parts = [`${s.status ?? "status unknown"}${what}`, s.volume === undefined ? "" : `${s.volume}%`, s.shuffle ? "shuffle" : ""];
  return `${who}: ${parts.filter(Boolean).join(" · ")}`;
}

export const manifest: Manifest<SpotifyState> = {
  name: "spotify",
  title: "Spotify (Soloist)",
  iotClass: "local_push",
  access: "Soloist's WebSocket on loopback, no key",
  env: [
    { name: "SOLOIST_WS", example: DEFAULT_URL, what: "Soloist's --ws address as a URL; `home status` skips the speaker without it" },
    { name: "SOLOIST_MAX_VOLUME", example: "60", optional: true, what: "the loudest `home spotify volume` sets, and where a first play above it is lowered to" },
  ],
  /** Nothing until Soloist has said something: a speaker never reached has no line. */
  lines: ({ state }) => (state && (state.loggedIn !== undefined || state.status !== undefined) ? [spotifyText(state)] : []),
};
