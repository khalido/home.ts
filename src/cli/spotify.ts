// `home spotify pause|play [link]|next|volume <0-100>`: one write to the Soloist speaker. Opens the socket, waits for
// Soloist to answer (at most 5 s), sends the command and closes.
import { spotify } from "../connectors/spotify/index.ts";
import type { Part } from "../home.ts";
import {
  type Applied,
  type SpotifyState,
  spotifyText,
} from "../connectors/spotify/index.ts";
import { env, fail, usage, type Verbs } from "./context.ts";

/** SOLOIST_MAX_VOLUME as a number 0–100, or undefined when unset. */
function maxVolume(): number | undefined {
  const raw = env.SOLOIST_MAX_VOLUME;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 100
    ? n
    : fail(`SOLOIST_MAX_VOLUME: a whole number 0-100, not ${raw}`);
}

/** The speaker from SOLOIST_WS and SOLOIST_MAX_VOLUME, for `home status` and the verbs: both need SOLOIST_WS. */
export const spotifyFromEnv = () =>
  spotify({
    url:
      env.SOLOIST_WS ||
      fail(
        "needs SOLOIST_WS, Soloist's --ws address as a URL (see .env.example)",
      ),
    maxVolume: maxVolume(),
  });

export const SPOTIFY_USAGE =
  "usage: home spotify activate | pause | play [link] | next | volume <0-100>";

async function withSpotify<T>(
  act: (s: ReturnType<typeof spotify>) => Promise<T>,
): Promise<T> {
  const s = spotifyFromEnv();
  const stop = new AbortController();
  let last: Part<SpotifyState> | undefined;
  const running = s.run(stop.signal, (p) => (last = p));
  try {
    for (
      const until = Date.now() + 5000;
      Date.now() < until && (last?.status ?? "connecting") === "connecting";
    )
      await Bun.sleep(50);
    if (last?.status !== "connected")
      fail(last?.detail ?? "Soloist did not answer in 5 s", "network");
    return await act(s);
  } finally {
    stop.abort();
    await running;
  }
}

/** What a write left, in a line: the speaker as Soloist then reported it, or that it has not reported the change yet. */
const said = ({ state, confirmed }: Applied) =>
  console.log(
    confirmed
      ? spotifyText(state)
      : `sent; Soloist has not reported it yet (${spotifyText(state)})`,
  );

export const spotifyVerbs: Verbs = {
  activate: () => withSpotify((s) => s.activate()).then(said),
  pause: () => withSpotify((s) => s.pause()).then(said),
  next: () => withSpotify((s) => s.next()).then(said),
  play: ([link]) => withSpotify((s) => s.play(link)).then(said),
  async volume([value]) {
    const n = Number(value);
    if (value === undefined || value.trim() === "" || !(n >= 0 && n <= 100))
      usage(SPOTIFY_USAGE);
    said(await withSpotify((s) => s.setVolume(n)));
  },
};
