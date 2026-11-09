import type { Part } from "../../home.ts";
import type { SpotifyState, Stall, Track } from "./client.ts";

// What a consumer reads off the speaker's parts: one word, the events between two reports, a line of text. Pure: no socket, no clock.

/** A stall in a few words: `playback stalled at 1:39 (Soloist issue #5); tried a seek`. */
export function stallText(s: Stall | undefined): string | undefined {
  if (!s) return undefined;
  const at = `${Math.floor(s.ms / 60_000)}:${String(Math.floor((s.ms % 60_000) / 1000)).padStart(2, "0")}`;
  const what =
    s.how === "overrun"
      ? `playback stuck past the end of the track (Soloist issue #5)`
      : `playback stalled at ${at} (Soloist issue #5)`;
  return s.tried ? `${what}; tried ${s.tried}` : what;
}

/** The speaker in one word, to switch on. `offline`: not reached (or no part); `waiting`: running, nobody has picked it. A status Soloist sends beyond its four passes through. */
export type SpeakerState =
  | "offline"
  | "connecting"
  | "waiting"
  | "idle"
  | "playing"
  | "paused"
  | "buffering"
  | (string & {});

export function speakerState(
  part: Part<SpotifyState> | undefined,
): SpeakerState {
  if (!part || part.status === "disconnected" || part.status === "unavailable")
    return "offline";
  if (part.status === "connecting") return "connecting";
  if (part.state?.loggedIn === false) return "waiting";
  return part.state?.status ?? "idle"; // signed in, nothing reported yet: nothing is playing
}

/**
 * A change worth telling someone about, from two reports of the speaker. `own`, on playback events only: it happened while
 * this library's `duck`, `interrupt` or stall repair ran (its own writes, or a person's change in that time), so a consumer
 * needn't react to it. `offline`, `online`, `waiting`, `picked`, `stalled` and `recovered` are never `own`.
 */
export type SpotifyEvent = { own?: true } & (
  | {
      type:
        | "offline"
        | "online"
        | "waiting"
        | "picked"
        | "started"
        | "resumed"
        | "paused"
        | "stopped"
        | "recovered";
    }
  | { type: "stalled"; stall: Stall }
  | { type: "track"; track: Track }
);

const PLAYING = new Set(["playing", "buffering"]);

/**
 * The events between two reports, for `onChange`'s `before` and `after`: `offline` and `online`; `waiting` (signed out) and
 * `picked` (someone picked the speaker); `started` (from idle), `resumed` (from paused), `paused`, `stopped` (to idle), then
 * `track` for a new track, once it has a name, then `stalled` and `recovered` (Soloist issue #5). Buffering counts as playing. No `before`, or one
 * with no state (createHome's placeholder before the first report, as at a restart): nothing, since nothing was seen to change. No volume or queue events: read the state.
 */
export function spotifyChanges(
  before: Part<SpotifyState> | undefined,
  after: Part<SpotifyState> | undefined,
): SpotifyEvent[] {
  if (!before?.state) return []; // createHome's first `before` is a bare connecting part: a boot is no change
  const own =
    before.state?.aside || after?.state?.aside ? { own: true as const } : {}; // playback events only: a drop or a sign-out is never the library's
  const down = (p: Part<SpotifyState> | undefined) =>
    ["offline", "connecting"].includes(speakerState(p)); // a reconnect passes through connecting
  const was = down(before);
  if (speakerState(after) === "offline")
    return was ? [] : [{ type: "offline" }];
  if (after?.status === "connecting") return [];
  const events: SpotifyEvent[] = [];
  const add = (e: SpotifyEvent) => events.push({ ...e, ...own });
  if (was) events.push({ type: "online" });
  const b = before.state;
  const a = after?.state;
  if (b?.loggedIn !== false && a?.loggedIn === false)
    events.push({ type: "waiting" });
  if (b?.loggedIn === false && a?.loggedIn === true)
    events.push({ type: "picked" });
  const from = b?.status;
  const to = a?.status;
  const playingNow = to !== undefined && PLAYING.has(to);
  const playingThen = from !== undefined && PLAYING.has(from);
  if (playingNow && !playingThen)
    add({ type: from === "paused" ? "resumed" : "started" });
  if (to === "paused" && from !== "paused") add({ type: "paused" });
  if (to === "idle" && from !== undefined && from !== "idle")
    add({ type: "stopped" });
  // Soloist's first report of a new track can have no name yet (seen live): the event waits for it.
  const named = (p?: SpotifyState) => !!p?.track?.name;
  if (a?.track && named(a) && (a.track.uri !== b?.track?.uri || !named(b)))
    add({ type: "track", track: a.track });
  if (a?.stalled && !b?.stalled)
    events.push({ type: "stalled", stall: a.stalled });
  if (
    b?.stalled &&
    !a?.stalled &&
    a?.status === "playing" &&
    a.track?.uri === b.stalled.track
  )
    events.push({ type: "recovered" });
  return events;
}

/** The speaker in a few words: `Kitchen speaker: playing "Song" by Band · 35%`, or `…: waiting for someone to pick it`. */
export function spotifyText(s: SpotifyState): string {
  const who = s.deviceName ?? "Soloist";
  if (s.loggedIn === false) return `${who}: waiting for someone to pick it`;
  const t = s.track;
  const what = t
    ? `${t.name ? ` "${t.name}"` : ` ${t.uri}`}${t.artists.length ? ` by ${t.artists.join(", ")}` : ""}`
    : "";
  const parts = [
    `${s.status ?? "status unknown"}${what}`,
    s.volume === undefined ? "" : `${s.volume}%`,
    s.shuffle ? "shuffle" : "",
  ];
  return `${who}: ${parts.filter(Boolean).join(" · ")}`;
}
