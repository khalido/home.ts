import { describe, expect, test } from "bun:test";
import type { Part } from "../src/index.ts";
import { manualClock } from "./clock.ts";
import {
  type Applied,
  manifest,
  positionMs,
  speakerState,
  spotify,
  spotifyChanges,
  spotifyText,
  type SocketLike,
  type SpotifyState,
  toSpotifyUri,
} from "../src/connectors/spotify/index.ts";
import type { ConnectorError } from "../src/connector.ts";
import { fold, oddities } from "../src/connectors/spotify/client.ts";

// Against a fake Soloist, frames shaped as the WebSocket API reference shows them (read 2026-11-08). Nothing here has met a real Soloist.

/** A fake Soloist socket: records what the client sends; a test opens it, pushes frames, answers commands or drops it. */
class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** Answer the last command sent with its command_result, and return it. */
  ack() {
    const last = this.sent.at(-1)!;
    this.push({ type: "command_result", command: last.command });
    return last;
  }
  commands = () => this.sent.map((m) => m.command);
}

const entity = (
  uri: string,
  name: string,
  extra: Record<string, unknown> = {},
) => ({
  uri,
  entity_type: uri.split(":")[1] ?? "",
  decorations: { identity: { name }, ...extra },
});

const TRACK = entity("spotify:track:abc123", "Song A", {
  visual_identity: {
    cover: [
      { url: "https://i.example/small.jpg", size: "small" },
      { url: "https://i.example/default.jpg", size: "default" },
    ],
  },
  parent: { entity: entity("spotify:album:alb1", "Album A") },
  creators: [
    { entity: entity("spotify:artist:a1", "Artist One") },
    { entity: entity("spotify:artist:a2", "Artist Two") },
  ],
  playback: { duration_ms: 200_000 },
});

function setup(
  config: {
    maxVolume?: number;
    url?: string;
    repairStalls?: boolean;
    stallCheckMs?: number;
  } = {},
) {
  const { clock, advance } = manualClock();
  const sockets: FakeSocket[] = [];
  const parts: Part<SpotifyState>[] = [];
  const s = spotify({
    stallCheckMs: 0,
    ...config,
    clock,
    connect: (url) => (sockets.push(new FakeSocket(url)), sockets.at(-1)!),
  });
  const abort = new AbortController();
  const running = s.run(abort.signal, (p) => parts.push(p));
  const last = () => parts.at(-1)!;
  /** Open the newest socket, say what Soloist says on connect when signed in, answer the get_queue that follows, and let the lane's gap pass. `sent` starts empty. */
  const online = async (playback: Record<string, unknown> = {}) => {
    const sock = sockets.at(-1)!;
    sock.open();
    sock.push({
      type: "auth_state",
      logged_in: true,
      is_active: true,
      device_name: "Kitchen",
    });
    sock.push({
      type: "playback_state",
      status: "idle",
      item: { uri: "", entity_type: "" },
      volume: 40,
      options: { shuffle: false, repeat: "off" },
      ...playback,
    });
    sock.push({ type: "queue_changed", previous: [], upcoming: [] });
    await advance(100);
    sock.sent.length = 0;
    return sock;
  };
  const stop = async () => (abort.abort(), await running);
  return { s, sockets, parts, last, online, clock, advance, stop };
}

const tick = () => Bun.sleep(1);

/** A write, the lane's gap, Soloist's command_result, then `events` (what Soloist reports after). Returns the write's result and the frame sent. */
async function sent(
  h: ReturnType<typeof setup>,
  sock: FakeSocket,
  call: () => Promise<Applied>,
  ...events: Record<string, unknown>[]
) {
  const p = call();
  await h.advance(100);
  const frame = sock.ack();
  await tick();
  for (const e of events) sock.push(e);
  return { frame, result: await p };
}

describe("toSpotifyUri", () => {
  test("open.spotify.com links become URIs", () => {
    expect(
      toSpotifyUri(
        "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x1",
      ),
    ).toBe("spotify:track:4uLU6hMCjMI75M1A2tKUQC");
    expect(
      toSpotifyUri("https://open.spotify.com/intl-en/playlist/37i9dQZF1DX"),
    ).toBe("spotify:playlist:37i9dQZF1DX");
    expect(
      toSpotifyUri(
        "https://open.spotify.com/embed/album/1DFixLWuPkv3KT3TnV35m3",
      ),
    ).toBe("spotify:album:1DFixLWuPkv3KT3TnV35m3");
  });

  test("URIs pass through; short links and words do not", () => {
    expect(toSpotifyUri(" spotify:album:1DFixLWuPkv3KT3TnV35m3 ")).toBe(
      "spotify:album:1DFixLWuPkv3KT3TnV35m3",
    );
    expect(toSpotifyUri("https://spotify.link/abc")).toBeUndefined();
    expect(toSpotifyUri("friday")).toBeUndefined();
  });
});

describe("fold", () => {
  const AT = "2026-11-08T00:00:00.000Z";
  test("playback_state is a full snapshot; events patch one field", () => {
    let s: SpotifyState = { asOf: AT };
    s = fold(
      s,
      {
        type: "auth_state",
        logged_in: true,
        is_active: true,
        device_name: "Kitchen",
      },
      AT,
    );
    s = fold(
      s,
      {
        type: "playback_state",
        status: "paused",
        item: TRACK,
        context: entity("spotify:playlist:p1", "Mix"),
        volume: 40,
        options: { shuffle: true, repeat: "context" },
        position: { position_ms: 1000, timestamp_ms: 5, speed: 0 },
      },
      AT,
    );
    expect(s).toEqual({
      loggedIn: true,
      active: true,
      deviceName: "Kitchen",
      status: "paused",
      track: {
        uri: "spotify:track:abc123",
        type: "track",
        name: "Song A",
        artists: ["Artist One", "Artist Two"],
        album: "Album A",
        cover: "https://i.example/default.jpg",
        durationMs: 200_000,
      },
      context: { uri: "spotify:playlist:p1", type: "playlist", name: "Mix" },
      position: { ms: 1000, atMs: 5, speed: 0 },
      volume: 40,
      shuffle: true,
      repeat: "context",
      asOf: AT,
    });
    s = fold(
      s,
      { type: "track_changed", item: entity("spotify:track:zzz", "Song B") },
      AT,
    );
    s = fold(s, { type: "playback_changed", status: "playing" }, AT);
    s = fold(s, { type: "volume_changed", volume: 55 }, AT);
    s = fold(
      s,
      { type: "device_changed", is_active: false, device_name: "Lounge" },
      AT,
    );
    s = fold(s, { type: "options_changed", options: { shuffle: false } }, AT);
    expect([
      s.track?.name,
      s.status,
      s.volume,
      s.deviceName,
      s.active,
      s.shuffle,
      s.repeat,
    ]).toEqual(["Song B", "playing", 55, "Lounge", false, false, "context"]);
  });

  test("an empty item uri is nothing loaded; signing out clears the playback", () => {
    let s = fold(
      { asOf: AT },
      {
        type: "playback_state",
        status: "idle",
        item: { uri: "", entity_type: "" },
      },
      AT,
    );
    expect(s.track).toBeUndefined();
    expect("track" in s).toBe(false);
    s = fold(
      { ...s, track: { uri: "spotify:track:x", artists: [] }, volume: 30 },
      {
        type: "auth_state",
        logged_in: false,
        is_active: false,
        device_name: "Kitchen",
      },
      AT,
    );
    expect(s).toEqual({
      loggedIn: false,
      active: false,
      deviceName: "Kitchen",
      asOf: AT,
    });
  });

  test("odd readings pass through, named", () => {
    const s: SpotifyState = {
      asOf: AT,
      status: "stalled",
      volume: 140,
      repeat: "sometimes",
      position: { ms: 300_000, speed: -1 },
      track: { uri: "spotify:track:x", artists: [], durationMs: 200_000 },
    };
    expect(oddities(s)).toBe(
      'status "stalled"; volume 140, outside 0–100; repeat "sometimes"; position speed -1; position 300000 ms past the track\'s 200000 ms',
    );
    expect(
      oddities({ asOf: AT, status: "playing", volume: 0 }),
    ).toBeUndefined();
  });
});

describe("positionMs", () => {
  const base: SpotifyState = {
    asOf: "",
    status: "playing",
    track: { uri: "spotify:track:x", artists: [], durationMs: 200_000 },
    position: { ms: 10_000, atMs: 1_000_000, speed: 1 },
  };
  test("moves on while playing, at its speed; a clock behind the anchor is not clamped", () => {
    expect(positionMs(base, 1_005_000)).toBe(15_000);
    expect(
      positionMs(
        { ...base, position: { ...base.position, speed: 1.5 } },
        1_002_000,
      ),
    ).toBe(13_000);
    expect(positionMs(base, 999_000)).toBe(9_000);
  });
  test("stands still while paused; undefined without a track or an anchor", () => {
    expect(positionMs({ ...base, status: "paused" }, 1_005_000)).toBe(10_000);
    expect(
      positionMs({ ...base, track: undefined }, 1_005_000),
    ).toBeUndefined();
    expect(
      positionMs({ ...base, position: undefined }, 1_005_000),
    ).toBeUndefined();
  });
  test("is not held to the track's length", () => {
    expect(positionMs(base, 1_000_000 + 250_000)).toBe(260_000);
  });
});

describe("the integration", () => {
  test("connects to the default URL, and is connected once Soloist says who it is", async () => {
    const h = setup();
    expect(h.sockets[0]!.url).toBe("ws://127.0.0.1:9091");
    expect(h.parts).toEqual([]);
    await h.online({ status: "paused", item: TRACK });
    expect(h.last()).toMatchObject({
      status: "connected",
      state: {
        loggedIn: true,
        deviceName: "Kitchen",
        status: "paused",
        volume: 40,
        track: { name: "Song A" },
      },
    });
    expect(h.last().detail).toBeUndefined();
    h.sockets[0]!.push({ type: "volume_changed", volume: 55 });
    expect(h.last().state?.volume).toBe(55);
    await h.stop();
  });

  test("unreachable is disconnected, and it retries with backoff 1, 2, 4 s", async () => {
    const h = setup({ url: "ws://127.0.0.1:9999" });
    h.sockets[0]!.close();
    await tick();
    expect(h.last()).toMatchObject({
      status: "disconnected",
      detail: "nothing answered at ws://127.0.0.1:9999",
    });
    await h.advance(1000);
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]!.close();
    await tick();
    await h.advance(1999);
    expect(h.sockets).toHaveLength(2);
    await h.advance(1);
    expect(h.sockets).toHaveLength(3);
    await h.online();
    expect(h.last().status).toBe("connected");
    await h.stop();
    await h.advance(120_000);
    expect(h.sockets).toHaveLength(3);
  });

  test("a socket that opens and drops keeps the last state, disconnected, and starts the backoff over", async () => {
    const h = setup();
    h.sockets[0]!.close(); // never opened
    await tick();
    await h.advance(1000);
    await h.online({ status: "playing", item: TRACK });
    h.sockets[1]!.close();
    await tick();
    expect(h.last()).toMatchObject({
      status: "disconnected",
      detail: "Soloist closed the socket",
      state: { status: "playing", track: { name: "Song A" } },
    });
    await h.advance(1000); // back to 1 s, not 4
    expect(h.sockets).toHaveLength(3);
    await h.stop();
  });

  test("a constructor that throws (no WebSocket in the runtime) is disconnected, saying why", async () => {
    const { clock } = manualClock();
    const parts: Part<SpotifyState>[] = [];
    const abort = new AbortController();
    const running = spotify({
      clock,
      connect: () => {
        throw new Error("WebSocket is not defined");
      },
    }).run(abort.signal, (p) => parts.push(p));
    await tick();
    expect(parts.at(-1)).toMatchObject({
      status: "disconnected",
      detail: "could not open ws://127.0.0.1:9091: WebSocket is not defined",
    });
    abort.abort();
    await running;
  });

  test("a first sign-in asks for the state, since only auth_state is promised", () => {
    const h = setup();
    const sock = h.sockets[0]!;
    sock.open();
    sock.push({
      type: "auth_state",
      logged_in: false,
      is_active: false,
      device_name: "Kitchen",
    });
    expect(sock.commands()).toEqual([]);
    sock.push({
      type: "auth_state",
      logged_in: true,
      is_active: true,
      device_name: "Kitchen",
    });
    expect(sock.commands()).toEqual(["get_state"]);
    sock.push({
      type: "auth_state",
      logged_in: true,
      is_active: true,
      device_name: "Kitchen",
    });
    expect(sock.commands()).toEqual(["get_state"]);
  });
  test("signed out is connected, says so, and refuses writes without sending them", async () => {
    const h = setup();
    const sock = h.sockets[0]!;
    sock.open();
    sock.push({
      type: "auth_state",
      logged_in: false,
      is_active: false,
      device_name: "Kitchen",
    });
    expect(h.last()).toMatchObject({
      status: "connected",
      state: { loggedIn: false, deviceName: "Kitchen" },
    });
    expect(h.last().detail).toContain("waiting for someone to pick it");
    expect(manifest.lines(h.last())).toEqual([
      "Kitchen: waiting for someone to pick it",
    ]);
    await expect(h.s.pause()).rejects.toMatchObject({ code: "waiting" });
    expect(sock.sent).toEqual([]);
    h.s.refresh();
    await h.advance(100); // the refused pause still took its turn on the lane
    expect(sock.commands()).toEqual(["get_auth_state"]);
    await h.stop();
  });

  test("signed in, the part is connecting until playback_state, so a one-shot read sees the track", async () => {
    const h = setup();
    const sock = h.sockets[0]!;
    sock.open();
    sock.push({
      type: "auth_state",
      logged_in: true,
      is_active: true,
      device_name: "Kitchen",
    });
    expect(h.parts.every((p) => p.status !== "connected")).toBe(true);
    sock.push({
      type: "playback_state",
      status: "playing",
      item: TRACK,
      volume: 40,
    });
    expect(h.last()).toMatchObject({
      status: "connected",
      state: { status: "playing", track: { name: "Song A" } },
    });
    await h.stop();
  });

  test("signed in with no playback_state in 10 s: connected with what there is", async () => {
    const h = setup();
    const sock = h.sockets[0]!;
    sock.open();
    sock.push({
      type: "auth_state",
      logged_in: true,
      is_active: true,
      device_name: "Kitchen",
    });
    await h.advance(10_000);
    expect(h.last()).toMatchObject({
      status: "connected",
      state: { loggedIn: true, deviceName: "Kitchen" },
    });
    await h.stop();
  });

  test("an ended socket's late open and frames change nothing", async () => {
    const h = setup();
    const old = await h.online({ status: "playing", item: TRACK, volume: 40 });
    old.close();
    await tick();
    old.push({ type: "volume_changed", volume: 90 });
    old.open();
    expect(h.last()).toMatchObject({
      status: "disconnected",
      detail: "Soloist closed the socket",
      state: { volume: 40 },
    });
    await h.advance(1000);
    h.sockets[1]!.open();
    old.push({ type: "auth_state", logged_in: true });
    await h.advance(10_000); // the new socket heard nothing of its own
    expect(h.last().detail).toBe("Soloist said nothing in 10 s");
    await h.stop();
  });

  test("a socket that opens and says nothing is closed after 10 s", async () => {
    const h = setup();
    h.sockets[0]!.open();
    await h.advance(10_000);
    expect(h.last()).toMatchObject({
      status: "disconnected",
      detail: "Soloist said nothing in 10 s",
    });
    await h.stop();
  });

  test("refresh sends get_state while connected, and reconnects at once while down", async () => {
    const h = setup();
    const sock = await h.online();
    h.s.refresh();
    expect(sock.sent.at(-1)).toEqual({ type: "command", command: "get_state" });
    sock.close();
    await tick();
    expect(h.sockets).toHaveLength(1);
    h.s.refresh();
    await tick();
    expect(h.sockets).toHaveLength(2);
    await h.stop();
  });

  test("a query waits its turn: its error is not blamed on a write sent after it", async () => {
    const h = setup();
    const sock = await h.online();
    h.s.refresh();
    const paused = h.s.pause();
    expect(sock.commands()).toEqual(["get_state"]);
    sock.push({ type: "error", message: "busy" });
    await tick();
    expect(h.last().anomaly).toBe(
      "get_state failed: Soloist refused get_state: busy",
    );
    await h.advance(100);
    expect(sock.commands()).toEqual(["get_state", "pause"]);
    sock.ack();
    sock.push({ type: "playback_changed", status: "paused" });
    expect((await paused).confirmed).toBe(true);
    await h.stop();
  });

  test("a frame the schema rejects is an anomaly; unknown frame types are skipped", async () => {
    const h = setup();
    const sock = await h.online();
    sock.push({ type: "volume_changed", volume: "loud" });
    expect(h.last().anomaly).toBe(
      "a volume_changed the schema did not recognise",
    );
    expect(h.last().state?.volume).toBe(40);
    const n = h.parts.length;
    sock.push({ type: "something_new" });
    expect(h.parts.length).toBe(n);
    sock.push({ type: "volume_changed", volume: 120 });
    expect(h.last()).toMatchObject({
      anomaly: "volume 120, outside 0–100",
      state: { volume: 120 },
    });
    await h.stop();
  });

  test("lines: speaker, status, track, volume", () => {
    const state: SpotifyState = {
      asOf: "",
      deviceName: "Kitchen",
      loggedIn: true,
      status: "playing",
      volume: 35,
      track: {
        uri: "spotify:track:x",
        name: "Song",
        artists: ["Band", "Other"],
      },
    };
    expect(manifest.lines({ status: "connected", state })).toEqual([
      'Kitchen: playing "Song" by Band, Other · 35%',
    ]);
    expect(spotifyText({ asOf: "" })).toBe("Soloist: status unknown");
  });
});

describe("writes", () => {
  test("each command's frame, resolved once Soloist reports the change", async () => {
    const h = setup();
    const sock = await h.online({
      status: "paused",
      item: TRACK,
      position: { position_ms: 50_000, timestamp_ms: 0, speed: 0 },
    });
    const other = entity("spotify:track:other", "Song B");
    const cases: [
      () => Promise<Applied>,
      Record<string, unknown>,
      Record<string, unknown>[],
    ][] = [
      [
        () => h.s.play("https://open.spotify.com/album/alb1?si=1"),
        { command: "play", uri: "spotify:album:alb1" },
        [
          {
            type: "context_changed",
            context: entity("spotify:album:alb1", "Album A"),
          },
          { type: "playback_changed", status: "playing" },
        ],
      ],
      [
        () => h.s.pause(),
        { command: "pause" },
        [{ type: "playback_changed", status: "paused" }],
      ],
      [
        () => h.s.resume(),
        { command: "play" },
        [{ type: "playback_changed", status: "playing" }],
      ],
      [
        () => h.s.next(),
        { command: "skip_next" },
        [{ type: "track_changed", item: other }],
      ],
      [
        () => h.s.prev(),
        { command: "skip_prev" },
        [{ type: "track_changed", item: TRACK }],
      ],
      [
        () => h.s.seek(30_000),
        { command: "seek", position_ms: 30_000 },
        [
          {
            type: "position_sync",
            position: { position_ms: 30_010, timestamp_ms: 1, speed: 1 },
          },
        ],
      ],
      [
        () => h.s.setVolume(50),
        { command: "set_volume", volume: 50 },
        [{ type: "volume_changed", volume: 50 }],
      ],
      [
        () => h.s.queue("spotify:track:t1"),
        { command: "add_to_queue", uri: "spotify:track:t1" },
        [
          {
            type: "queue_changed",
            upcoming: [
              {
                uid: "q1",
                source: "queue",
                item: entity("spotify:track:t1", "Queued"),
              },
            ],
          },
        ],
      ],
      [
        () => h.s.setShuffle(true),
        { command: "set_shuffle", enabled: true },
        [
          {
            type: "options_changed",
            options: { shuffle: true, repeat: "off" },
          },
        ],
      ],
    ];
    for (const [call, frame, events] of cases) {
      const r = await sent(h, sock, call, ...events);
      expect(r.frame).toEqual({ type: "command", ...frame });
      expect(r.result.confirmed).toBe(true);
    }
    expect(h.last().state).toMatchObject({
      status: "playing",
      volume: 50,
      shuffle: true,
      upNext: [{ uri: "spotify:track:t1", name: "Queued" }],
    });
    await h.stop();
  });

  test("a change Soloist never reports resolves after 2 s, unconfirmed, with the state as it stands", async () => {
    const h = setup();
    const sock = await h.online({ volume: 40 });
    const p = h.s.setVolume(70);
    await h.advance(100);
    sock.ack();
    await tick();
    await h.advance(1999);
    let done = false;
    void p.then(() => (done = true));
    await tick();
    expect(done).toBe(false);
    await h.advance(1);
    expect(await p).toMatchObject({ confirmed: false, state: { volume: 40 } });
    await h.stop();
  });

  test("Soloist's error rejects the command in flight; offline and bad input reject without sending, each with a code", async () => {
    const h = setup();
    await expect(h.s.pause()).rejects.toMatchObject({
      code: "offline",
      message: "Soloist is not connected at ws://127.0.0.1:9091",
    });
    await h.advance(100); // the refused pause still took its turn in the lane
    const sock = await h.online();
    const p = h.s.next();
    sock.push({ type: "error", message: "command requires authentication" });
    await expect(p).rejects.toMatchObject({
      code: "refused",
      message: "Soloist refused skip_next: command requires authentication",
    });
    await expect(h.s.play("friday")).rejects.toMatchObject({ code: "invalid" });
    await expect(h.s.queue("spotify:album:alb1")).rejects.toThrow(
      "only a Spotify track",
    );
    await expect(h.s.setVolume(120)).rejects.toThrow("0–100");
    await expect(h.s.seek(-1)).rejects.toThrow("0 or more");
    expect(sock.commands()).toEqual(["skip_next"]);
    await h.stop();
  });

  test("an error with nothing waiting is an anomaly", async () => {
    const h = setup();
    const sock = await h.online();
    sock.push({ type: "error", message: "something went wrong" });
    expect(h.last().anomaly).toBe("Soloist said: something went wrong");
    await h.stop();
  });

  test("a command with no answer times out after 3 s; a drop fails it at once", async () => {
    const h = setup();
    const sock = await h.online();
    const caught = h.s
      .pause()
      .catch((e: ConnectorError) => [e.code, e.message]);
    await h.advance(3000);
    expect(await caught).toEqual([
      "timeout",
      "Soloist did not answer pause in 3 s",
    ]);
    await h.advance(100);
    const q = h.s.next();
    sock.close();
    await expect(q).rejects.toMatchObject({ code: "offline" });
    await h.stop();
  });

  test("a requested volume is held to maxVolume and rounded; state.volume is what Soloist reported", async () => {
    const h = setup({ maxVolume: 60 });
    const sock = await h.online();
    const a = await sent(h, sock, () => h.s.setVolume(90), {
      type: "volume_changed",
      volume: 60,
    });
    expect(a.frame).toMatchObject({ command: "set_volume", volume: 60 });
    expect(a.result).toMatchObject({ confirmed: true, state: { volume: 60 } });
    const b = await sent(h, sock, () => h.s.setVolume(33.4), {
      type: "volume_changed",
      volume: 33,
    });
    expect(b.frame).toMatchObject({ volume: 33 });
    await h.stop();
  });

  test("the lane: volumes waiting merge to the last, and each confirms on its own value; two skips stay two", async () => {
    const h = setup();
    const sock = await h.online({ item: TRACK });
    const a = h.s.setVolume(10);
    const b = h.s.setVolume(20);
    const c = h.s.setVolume(30);
    sock.ack();
    sock.push({ type: "volume_changed", volume: 10 });
    await a;
    await h.advance(100);
    expect(sock.ack()).toMatchObject({ volume: 30 });
    sock.push({ type: "volume_changed", volume: 30 });
    expect((await c).confirmed).toBe(true);
    await h.advance(2000);
    expect((await b).confirmed).toBe(false); // it asked for 20; the device got 30
    await h.advance(100);
    const n1 = h.s.next();
    const n2 = h.s.next();
    sock.ack();
    sock.push({ type: "track_changed", item: entity("spotify:track:b", "B") });
    await n1;
    await h.advance(100);
    sock.ack();
    sock.push({ type: "track_changed", item: entity("spotify:track:c", "C") });
    await n2;
    expect(sock.commands()).toEqual([
      "set_volume",
      "set_volume",
      "skip_next",
      "skip_next",
    ]);
    await h.stop();
  });

  test("the queue: asked for once on connect, then kept from queue_changed", async () => {
    const h = setup();
    const sock = h.sockets[0]!;
    sock.open();
    sock.push({
      type: "auth_state",
      logged_in: true,
      is_active: true,
      device_name: "Kitchen",
    });
    sock.push({ type: "playback_state", status: "playing", item: TRACK });
    expect(sock.sent).toEqual([
      { type: "command", command: "get_queue", limit: 10 },
    ]);
    sock.push({
      type: "queue_changed",
      previous: [],
      upcoming: [
        {
          uid: "1",
          source: "context",
          item: entity("spotify:track:n", "Next"),
        },
        { uid: "2", item: { uri: "" } },
      ],
    });
    expect(h.last().state?.upNext).toEqual([
      { uri: "spotify:track:n", type: "track", name: "Next", artists: [] },
    ]);
    sock.push({ type: "playback_state", status: "playing", item: TRACK });
    expect(sock.commands()).toEqual(["get_queue"]);
    await h.stop();
  });
});

describe("confirming", () => {
  test("a pause merged into a later play never confirms the pause; the play confirms", async () => {
    const h = setup();
    const sock = await h.online({ status: "playing", item: TRACK });
    const first = h.s.setVolume(50); // holds the lane, so the next two wait together
    const pause = h.s.pause();
    const play = h.s.play();
    sock.ack();
    sock.push({ type: "volume_changed", volume: 50 });
    await first;
    await h.advance(100);
    expect(sock.ack()).toMatchObject({ command: "play" });
    await tick();
    await h.advance(2000);
    expect((await play).confirmed).toBe(true); // already playing
    expect((await pause).confirmed).toBe(false);
    await h.stop();
  });

  test("prev: a position update early in the track is not a prev; a restart from 5 s in is", async () => {
    const h = setup();
    const sock = await h.online({
      status: "playing",
      item: TRACK,
      position: { position_ms: 1000, timestamp_ms: 0, speed: 1 },
    });
    const early = h.s.prev();
    await h.advance(100);
    sock.ack();
    await tick();
    sock.push({
      type: "position_sync",
      position: { position_ms: 1200, timestamp_ms: 100, speed: 1 },
    });
    await h.advance(2000);
    expect((await early).confirmed).toBe(false);
    sock.push({
      type: "position_sync",
      position: { position_ms: 40_000, timestamp_ms: 2100, speed: 1 },
    });
    const late = h.s.prev();
    await h.advance(100);
    sock.ack();
    await tick();
    sock.push({
      type: "position_sync",
      position: { position_ms: 0, timestamp_ms: 2200, speed: 1 },
    });
    expect((await late).confirmed).toBe(true);
    await h.stop();
  });

  test("next at the end of the queue confirms on idle", async () => {
    const h = setup();
    const sock = await h.online({ status: "playing", item: TRACK });
    const { result } = await sent(h, sock, () => h.s.next(), {
      type: "playback_state",
      status: "idle",
      item: { uri: "" },
    });
    expect(result.confirmed).toBe(true);
    await h.stop();
  });

  test("the first-play cap's write confirms on its own volume, not at once", async () => {
    const h = setup({ maxVolume: 60 });
    const sock = await h.online({ volume: 100 });
    sock.push({ type: "playback_changed", status: "playing" });
    const v = h.s.setVolume(30); // merges into the cap's waiting write? no: the cap's is in flight; this waits behind it
    sock.ack();
    sock.push({ type: "volume_changed", volume: 60 });
    await h.advance(100);
    expect(sock.ack()).toMatchObject({ volume: 30 });
    sock.push({ type: "volume_changed", volume: 30 });
    expect(await v).toMatchObject({ confirmed: true, state: { volume: 30 } });
    await h.stop();
  });

  test("a get_queue Soloist doesn't answer holds the lane 1 s, quietly", async () => {
    const h = setup();
    const sock = h.sockets[0]!;
    sock.open();
    sock.push({
      type: "auth_state",
      logged_in: true,
      is_active: true,
      device_name: "Kitchen",
    });
    sock.push({
      type: "playback_state",
      status: "playing",
      item: TRACK,
      volume: 40,
    });
    const v = h.s.setVolume(20);
    await h.advance(1000);
    await h.advance(100);
    expect(sock.commands()).toEqual(["get_queue", "set_volume"]);
    expect(h.last().anomaly).toBeUndefined();
    sock.ack();
    sock.push({ type: "volume_changed", volume: 20 });
    await v;
    await h.stop();
  });

  test("a drop during the wait ends it early, unconfirmed", async () => {
    const h = setup();
    const sock = await h.online({ status: "playing", item: TRACK });
    const p = h.s.pause();
    await h.advance(100);
    sock.ack();
    await tick();
    sock.close();
    expect((await p).confirmed).toBe(false);
    await h.stop();
  });
});

describe("the first play's volume (Soloist issue #23)", () => {
  test("idle → playing above the cap is lowered to it, once, and said in anomaly", async () => {
    const h = setup({ maxVolume: 60 });
    const sock = await h.online({ volume: 100 });
    sock.push({ type: "playback_changed", status: "playing" });
    expect(sock.sent).toEqual([
      { type: "command", command: "set_volume", volume: 60 },
    ]);
    expect(h.last().anomaly).toBeUndefined(); // not until it took
    expect(h.last().state?.volume).toBe(100); // the reading stays what Soloist said until it says otherwise
    sock.ack();
    await tick();
    sock.push({ type: "volume_changed", volume: 60 });
    await tick();
    expect(h.last().anomaly).toBe(
      "started at volume 100, above maxVolume 60; lowered it (Soloist issue #23)",
    );
    sock.push({ type: "volume_changed", volume: 95 }); // someone turned it up inside the window: theirs to keep
    expect(sock.commands()).toEqual(["set_volume"]);
    sock.push({ type: "playback_changed", status: "idle" });
    expect(h.last().anomaly).toBeUndefined();
    await h.stop();
  });

  test("a phone picking a signed-out speaker and playing at 100 is lowered too", async () => {
    const h = setup({ maxVolume: 60 });
    const sock = h.sockets[0]!;
    sock.open();
    sock.push({
      type: "auth_state",
      logged_in: false,
      is_active: false,
      device_name: "Kitchen",
    });
    sock.push({
      type: "auth_state",
      logged_in: true,
      is_active: true,
      device_name: "Kitchen",
    });
    expect(sock.commands()).toEqual(["get_state"]);
    sock.push({
      type: "playback_state",
      status: "playing",
      item: TRACK,
      volume: 100,
    });
    await h.advance(100);
    sock.push({ type: "queue_changed", upcoming: [] }); // the get_queue that follows a first playback_state
    await h.advance(100);
    expect(sock.sent.at(-1)).toEqual({
      type: "command",
      command: "set_volume",
      volume: 60,
    });
    await h.stop();
  });

  test("while inactive it waits, since Soloist drops the write; going active lowers it", async () => {
    const h = setup({ maxVolume: 40 });
    const sock = await h.online({ volume: 40 });
    sock.push({ type: "device_changed", is_active: false });
    sock.push({ type: "playback_changed", status: "playing" });
    sock.push({ type: "volume_changed", volume: 56 });
    await h.advance(100);
    expect(sock.sent).toEqual([]);
    sock.push({ type: "device_changed", is_active: true });
    await h.advance(100);
    expect(sock.sent).toEqual([
      { type: "command", command: "set_volume", volume: 40 },
    ]);
    await h.stop();
  });

  test("going active during a song opens the window, without any status change", async () => {
    const h = setup({ maxVolume: 40 });
    const sock = await h.online({ status: "paused", volume: 30 });
    sock.push({ type: "device_changed", is_active: false });
    sock.push({ type: "device_changed", is_active: true });
    sock.push({ type: "volume_changed", volume: 100 });
    await h.advance(100);
    expect(sock.commands()).toEqual(["set_volume"]);
    await h.stop();
  });

  test("a new start while a lowering is on its way re-arms it: the jump after playing is still caught", async () => {
    const h = setup({ maxVolume: 40 });
    const sock = await h.online({ volume: 100 });
    sock.push({ type: "playback_changed", status: "buffering" });
    await h.advance(100);
    sock.push({ type: "playback_changed", status: "playing" }); // opens a new window with the write still out
    sock.ack();
    await tick();
    sock.push({ type: "volume_changed", volume: 40 });
    await tick();
    sock.push({ type: "volume_changed", volume: 100 });
    await h.advance(100);
    expect(sock.commands()).toEqual(["set_volume", "set_volume"]);
    await h.stop();
  });

  test("a new start while a lowering is on its way, and that lowering refused: the new window still lowers", async () => {
    const h = setup({ maxVolume: 40 });
    const sock = await h.online({ volume: 100 });
    sock.push({ type: "playback_changed", status: "buffering" });
    await h.advance(100);
    sock.push({ type: "playback_changed", status: "playing" }); // opens a new window with the write still out
    sock.push({ type: "error", message: "no" }); // the first window's write, refused
    await tick();
    await h.advance(100);
    expect(sock.commands()).toEqual(["set_volume", "set_volume"]);
    sock.ack();
    await tick();
    sock.push({ type: "volume_changed", volume: 40 });
    await tick();
    expect(h.last().detail).toBeUndefined();
    await h.stop();
  });

  test("41 with a cap of 40 is within rounding: left alone", async () => {
    const h = setup({ maxVolume: 40 });
    const sock = await h.online({ volume: 41 });
    sock.push({ type: "playback_changed", status: "playing" });
    await h.advance(100);
    expect(sock.sent).toEqual([]);
    await h.stop();
  });

  test("a refused lowering isn't resent in that window, and says so", async () => {
    const h = setup({ maxVolume: 60 });
    const sock = await h.online({ volume: 100 });
    sock.push({ type: "playback_changed", status: "playing" });
    await h.advance(100);
    sock.push({ type: "error", message: "no" });
    await tick();
    expect(h.last().detail).toContain("lowering the volume to 60 failed");
    sock.push({ type: "volume_changed", volume: 90 });
    await h.advance(100);
    expect(sock.commands()).toEqual(["set_volume"]);
    await h.stop();
  });

  test("a lowering that never shows is retried, never called done, and ends in detail", async () => {
    const h = setup({ maxVolume: 60 });
    const sock = await h.online({ volume: 100 });
    sock.push({ type: "playback_changed", status: "idle" });
    sock.push({ type: "playback_changed", status: "playing" });
    await h.advance(100);
    sock.ack();
    await tick();
    await h.advance(2000); // no volume_changed: unconfirmed
    await h.advance(100);
    expect(sock.commands().length).toBe(2); // retried
    for (let i = 0; i < 6; i++) {
      sock.ack();
      await tick();
      await h.advance(2000);
      await h.advance(100);
    }
    expect(h.last().anomaly).toBeUndefined();
    expect(h.last().detail).toBe(
      "could not lower the volume to 60: Soloist has not reported it",
    );
    await h.stop();
  });

  test("idle → buffering → playing is a start: lowered at buffering and again on the jump after playing", async () => {
    const h = setup({ maxVolume: 60 });
    const sock = await h.online({ volume: 100 });
    sock.push({ type: "playback_changed", status: "buffering" });
    expect(sock.sent).toEqual([
      { type: "command", command: "set_volume", volume: 60 },
    ]);
    sock.ack();
    sock.push({ type: "volume_changed", volume: 60 });
    await h.advance(100);
    await h.advance(10_000); // a long buffer: the window is over, until playing
    sock.push({ type: "playback_changed", status: "playing" });
    sock.push({ type: "volume_changed", volume: 100 }); // issue #23's jump
    await h.advance(100);
    expect(sock.commands()).toEqual(["set_volume", "set_volume"]);
    sock.ack();
    sock.push({ type: "volume_changed", volume: 60 });
    sock.push({ type: "volume_changed", volume: 95 }); // turned up after that: theirs to keep
    expect(sock.commands()).toEqual(["set_volume", "set_volume"]);
    await h.stop();
  });

  test("a sign-in whose first status is buffering is a start too", async () => {
    const h = setup({ maxVolume: 60 });
    const sock = h.sockets[0]!;
    sock.open();
    sock.push({ type: "auth_state", logged_in: false });
    sock.push({ type: "auth_state", logged_in: true });
    sock.push({
      type: "playback_state",
      status: "buffering",
      item: TRACK,
      volume: 100,
    });
    await h.advance(100);
    sock.push({ type: "queue_changed", upcoming: [] });
    await h.advance(100);
    expect(sock.sent.at(-1)).toEqual({
      type: "command",
      command: "set_volume",
      volume: 60,
    });
    await h.stop();
  });

  test("paused → buffering → playing is a resume: left alone", async () => {
    const h = setup({ maxVolume: 60 });
    const sock = await h.online({ status: "paused", volume: 90 });
    sock.push({ type: "playback_changed", status: "buffering" });
    sock.push({ type: "playback_changed", status: "playing" });
    expect(sock.sent).toEqual([]);
    await h.stop();
  });

  test("also when the volume arrives after the status", async () => {
    const h = setup({ maxVolume: 60 });
    const sock = await h.online({ volume: 30 });
    sock.push({ type: "playback_changed", status: "playing" });
    expect(sock.sent).toEqual([]);
    sock.push({ type: "volume_changed", volume: 100 });
    expect(sock.sent).toEqual([
      { type: "command", command: "set_volume", volume: 60 },
    ]);
    await h.stop();
  });

  test("not resuming from pause, not after the window, not connecting mid-song, not without a cap", async () => {
    const h = setup({ maxVolume: 60 });
    const sock = await h.online({ status: "paused", volume: 90 });
    sock.push({ type: "playback_changed", status: "playing" });
    expect(sock.sent).toEqual([]);
    sock.push({ type: "playback_changed", status: "idle" });
    sock.push({ type: "volume_changed", volume: 50 });
    sock.push({ type: "playback_changed", status: "playing" });
    await h.advance(10_001);
    sock.push({ type: "volume_changed", volume: 95 });
    expect(sock.sent).toEqual([]);
    await h.stop();

    const mid = setup({ maxVolume: 60 });
    expect((await mid.online({ status: "playing", volume: 90 })).sent).toEqual(
      [],
    );
    await mid.stop();

    const free = setup();
    const s = await free.online({ volume: 100 });
    s.push({ type: "playback_changed", status: "playing" });
    expect(s.sent).toEqual([]);
    await free.stop();
  });
});

describe("interrupt", () => {
  test("pauses, runs fn once the pause shows, then resumes", async () => {
    const h = setup();
    const sock = await h.online({ status: "playing", item: TRACK });
    const order: string[] = [];
    const done = h.s.interrupt(async () => (order.push("announce"), "said"));
    await tick(); // an aside starts on the next turn
    expect(sock.ack()).toMatchObject({ command: "pause" });
    await tick();
    expect(order).toEqual([]);
    sock.push({ type: "playback_changed", status: "paused" });
    await tick();
    expect(order).toEqual(["announce"]);
    await h.advance(100);
    expect(sock.ack()).toMatchObject({ command: "play" });
    sock.push({ type: "playback_changed", status: "playing" });
    expect(await done).toEqual({ value: "said", music: "restored" });
    expect(sock.commands()).toEqual(["pause", "play"]);
    await h.stop();
  });

  test("resumes even when fn throws", async () => {
    const h = setup();
    const sock = await h.online({ status: "playing", item: TRACK });
    const caught = h.s
      .interrupt(() => Promise.reject(new Error("chime failed")))
      .catch((e: Error) => e.message);
    await tick(); // an aside starts on the next turn
    sock.ack();
    sock.push({ type: "playback_changed", status: "paused" });
    await h.advance(100);
    sock.ack();
    sock.push({ type: "playback_changed", status: "playing" });
    expect(await caught).toBe("chime failed");
    expect(sock.commands()).toEqual(["pause", "play"]);
    await h.stop();
  });

  test("someone resuming or skipping from a phone meanwhile keeps their choice", async () => {
    const h = setup();
    const sock = await h.online({ status: "playing", item: TRACK });
    const a = h.s.interrupt(() =>
      sock.push({ type: "playback_changed", status: "playing" }),
    );
    await tick(); // an aside starts on the next turn
    sock.ack();
    sock.push({ type: "playback_changed", status: "paused" });
    expect(await a).toEqual({
      value: undefined,
      music: "kept",
      why: "someone changed it meanwhile: it is playing",
    });
    await h.advance(100);
    const b = h.s.interrupt(() =>
      sock.push({
        type: "track_changed",
        item: entity("spotify:track:other", "Other"),
      }),
    );
    await tick(); // an aside starts on the next turn
    sock.ack();
    sock.push({ type: "playback_changed", status: "paused" });
    expect(await b).toMatchObject({
      music: "kept",
      why: "the track changed meanwhile",
    });
    expect(sock.commands()).toEqual(["pause", "pause"]);
    await h.stop();
  });

  test("runs fn after 2 s if the pause never shows, and then does not resume", async () => {
    const h = setup();
    const sock = await h.online({ status: "playing", item: TRACK });
    let ran = false;
    const done = h.s.interrupt(() => (ran = true));
    await tick(); // an aside starts on the next turn
    sock.ack();
    await tick();
    await h.advance(1999);
    expect(ran).toBe(false);
    await h.advance(1);
    expect(ran).toBe(true);
    expect(await done).toMatchObject({
      music: "kept",
      why: "Soloist never reported the pause",
    });
    await h.stop();
  });

  test("a failed pause still runs fn, without a resume, and says so in detail and the result", async () => {
    const h = setup();
    const sock = await h.online({ status: "playing", item: TRACK });
    const p = h.s.interrupt(() => "a");
    await tick(); // an aside starts on the next turn
    sock.push({ type: "error", message: "command requires authentication" });
    const why =
      "pause before interrupt failed: Soloist refused pause: command requires authentication";
    expect(await p).toEqual({ value: "a", music: "untouched", why });
    expect(sock.commands()).toEqual(["pause"]);
    expect(h.last().detail).toBe(why);
    await h.stop();
  });

  test("a failed write's detail clears on the next write that works", async () => {
    const h = setup();
    const sock = await h.online({ status: "playing", item: TRACK });
    const p = h.s.interrupt(() => "a");
    await tick(); // an aside starts on the next turn
    sock.push({ type: "error", message: "busy" });
    await p;
    expect(h.last().detail).toContain("pause before interrupt failed");
    const v = h.s.setVolume(30);
    await h.advance(100);
    sock.ack();
    sock.push({ type: "volume_changed", volume: 30 });
    await v;
    expect(h.last().detail).toBeUndefined();
    await h.stop();
  });

  test("not playing, or not connected: just runs fn", async () => {
    const h = setup();
    const sock = await h.online({ status: "paused", item: TRACK });
    expect(await h.s.interrupt(() => 42)).toEqual({
      value: 42,
      music: "untouched",
      why: "it was not playing",
    });
    expect(sock.sent).toEqual([]);
    sock.push({ type: "playback_changed", status: "playing" });
    sock.close();
    expect(await h.s.interrupt(() => 43)).toEqual({
      value: 43,
      music: "untouched",
      why: "Soloist is not connected",
    });
    await h.stop();
  });
});

describe("duck", () => {
  test("lowers the volume while fn runs, then puts the earlier one back", async () => {
    const h = setup();
    const sock = await h.online({ status: "playing", item: TRACK, volume: 70 });
    const order: string[] = [];
    const done = h.s.duck(
      () => order.push(`announce at ${h.last().state?.volume}`),
      { to: 20 },
    );
    await tick(); // an aside starts on the next turn
    expect(sock.ack()).toMatchObject({ command: "set_volume", volume: 20 });
    sock.push({ type: "volume_changed", volume: 20 });
    await tick();
    expect(order).toEqual(["announce at 20"]);
    await h.advance(100);
    expect(sock.ack()).toMatchObject({ command: "set_volume", volume: 70 });
    sock.push({ type: "volume_changed", volume: 70 });
    expect(await done).toEqual({ value: 1, music: "restored" });
    await h.stop();
  });

  test("restores above maxVolume when that is where it was: the cap is for requests", async () => {
    const h = setup({ maxVolume: 60 });
    const sock = await h.online({ status: "playing", item: TRACK, volume: 80 });
    const done = h.s.duck(() => "x", { to: 20 });
    await tick(); // an aside starts on the next turn
    sock.ack();
    sock.push({ type: "volume_changed", volume: 20 });
    await h.advance(100);
    expect(sock.ack()).toMatchObject({ volume: 80 });
    sock.push({ type: "volume_changed", volume: 80 });
    expect((await done).music).toBe("restored");
    await h.stop();
  });

  test("someone setting the volume meanwhile keeps it", async () => {
    const h = setup();
    const sock = await h.online({ status: "playing", item: TRACK, volume: 70 });
    const done = h.s.duck(
      () => sock.push({ type: "volume_changed", volume: 45 }),
      { to: 20 },
    );
    await tick(); // an aside starts on the next turn
    sock.ack();
    sock.push({ type: "volume_changed", volume: 20 });
    expect(await done).toEqual({
      value: undefined,
      music: "kept",
      why: "someone set the volume to 45 meanwhile",
    });
    expect(sock.commands()).toEqual(["set_volume"]);
    await h.stop();
  });

  test("restores even when fn throws", async () => {
    const h = setup();
    const sock = await h.online({ status: "playing", item: TRACK, volume: 70 });
    const caught = h.s
      .duck(() => Promise.reject(new Error("chime failed")), { to: 20 })
      .catch((e: Error) => e.message);
    await tick(); // an aside starts on the next turn
    sock.ack();
    sock.push({ type: "volume_changed", volume: 20 });
    await h.advance(100);
    expect(sock.ack()).toMatchObject({ volume: 70 });
    sock.push({ type: "volume_changed", volume: 70 });
    expect(await caught).toBe("chime failed");
    await h.stop();
  });

  test("not playing, already quiet, or a bad level: just fn, or refused", async () => {
    const h = setup();
    const sock = await h.online({ status: "playing", item: TRACK, volume: 15 });
    expect(await h.s.duck(() => 1, { to: 20 })).toEqual({
      value: 1,
      music: "untouched",
      why: "it was already at 15",
    });
    sock.push({ type: "playback_changed", status: "paused" });
    expect(await h.s.duck(() => 2, { to: 5 })).toEqual({
      value: 2,
      music: "untouched",
      why: "it was not playing",
    });
    await expect(h.s.duck(() => 3, { to: 140 })).rejects.toMatchObject({
      code: "invalid",
    });
    expect(sock.sent).toEqual([]);
    await h.stop();
  });

  test("one aside at a time: a duck during an interrupt waits for it", async () => {
    const h = setup();
    const sock = await h.online({ status: "playing", item: TRACK, volume: 70 });
    const order: string[] = [];
    const first = h.s.interrupt(() => order.push("interrupt"));
    await tick(); // an aside starts on the next turn
    const second = h.s.duck(() => order.push("duck"), { to: 20 });
    await tick(); // an aside starts on the next turn
    sock.ack();
    sock.push({ type: "playback_changed", status: "paused" });
    await h.advance(100);
    sock.ack();
    sock.push({ type: "playback_changed", status: "playing" });
    await first;
    await h.advance(100);
    expect(sock.ack()).toMatchObject({ command: "set_volume", volume: 20 });
    sock.push({ type: "volume_changed", volume: 20 });
    await h.advance(100);
    sock.ack();
    sock.push({ type: "volume_changed", volume: 70 });
    await second;
    expect(order).toEqual(["interrupt", "duck"]);
    expect(sock.commands()).toEqual([
      "pause",
      "play",
      "set_volume",
      "set_volume",
    ]);
    await h.stop();
  });
});

describe("while the speaker is not active", () => {
  const inactive = async (playback = {}) => {
    const h = setup();
    const sock = await h.online(playback);
    sock.push({ type: "device_changed", is_active: false });
    return { h, sock };
  };

  test("activate confirms on going active, and sends nothing when it already is", async () => {
    const { h, sock } = await inactive();
    const { frame, result } = await sent(h, sock, () => h.s.activate(), {
      type: "device_changed",
      is_active: true,
    });
    expect(frame).toEqual({ type: "command", command: "activate" });
    expect(result.confirmed).toBe(true);
    sock.sent.length = 0;
    expect((await h.s.activate()).confirmed).toBe(true);
    await h.advance(100);
    expect(sock.sent).toEqual([]);
    await h.stop();
  });

  test("setVolume is refused unsent, with code inactive", async () => {
    const { h, sock } = await inactive();
    const e = (await h.s.setVolume(30).catch((x) => x)) as ConnectorError;
    expect(e.code).toBe("inactive");
    await h.advance(100);
    expect(sock.sent).toEqual([]);
    await h.stop();
  });

  test("duck runs fn over the music and says why it left it alone", async () => {
    const { h, sock } = await inactive({ status: "playing", volume: 62 });
    const r = await h.s.duck(() => "said", { to: 20 });
    expect(r).toMatchObject({ value: "said", music: "untouched" });
    expect(r.why).toContain("not the active device");
    expect(sock.sent).toEqual([]);
    await h.stop();
  });

  test("interrupt runs fn and sends no pause: the music is on another speaker", async () => {
    const { h, sock } = await inactive({ status: "playing", volume: 62 });
    const r = await h.s.interrupt(() => "said");
    expect(r).toMatchObject({ value: "said", music: "untouched" });
    expect(r.why).toContain("not the active device");
    await h.advance(100);
    expect(sock.sent).toEqual([]);
    await h.stop();
  });

  test("play goes active first, then plays", async () => {
    const { h, sock } = await inactive({ status: "paused" });
    const p = h.s.play();
    await h.advance(100);
    expect(sock.ack()).toEqual({ type: "command", command: "activate" });
    await tick();
    sock.push({ type: "device_changed", is_active: true });
    await h.advance(100);
    expect(sock.ack()).toEqual({ type: "command", command: "play" });
    await tick();
    sock.push({ type: "playback_changed", status: "playing" });
    expect((await p).confirmed).toBe(true);
    await h.stop();
  });

  test("play with a bad link sends nothing, activate included", async () => {
    const { h, sock } = await inactive();
    await expect(h.s.play("not a link")).rejects.toThrow();
    await h.advance(100);
    expect(sock.sent).toEqual([]);
    await h.stop();
  });

  test("resume doesn't go active: it worked inactive, and going active can jump the volume", async () => {
    const { h, sock } = await inactive({ status: "paused" });
    const p = h.s.resume();
    await h.advance(100);
    expect(sock.ack()).toEqual({ type: "command", command: "play" });
    await tick();
    sock.push({ type: "playback_changed", status: "playing" });
    await p;
    await h.stop();
  });

  test("a reported volume within 1 of the request confirms: Soloist rounds it", async () => {
    const h = setup();
    const sock = await h.online({ volume: 20 });
    const { result } = await sent(h, sock, () => h.s.setVolume(44), {
      type: "volume_changed",
      volume: 43,
    });
    expect(result.confirmed).toBe(true);
    await h.stop();
  });
});

describe("repeat", () => {
  test("two commands in the docs' order, one write, confirmed on the mode", async () => {
    const h = setup();
    const sock = await h.online();
    const order = {
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
    } as const;
    for (const mode of ["track", "context", "off"] as const) {
      sock.sent.length = 0;
      const p = h.s.setRepeat(mode);
      await h.advance(100);
      sock.ack();
      await tick();
      await h.advance(600);
      sock.ack();
      await tick();
      sock.push({
        type: "options_changed",
        options: { shuffle: false, repeat: mode },
      });
      expect((await p).confirmed).toBe(true);
      expect(sock.sent.map((m) => [m.command, m.enabled])).toEqual(
        order[mode].map((x) => [...x]),
      );
    }
    await expect(h.s.setRepeat("all" as never)).rejects.toMatchObject({
      code: "invalid",
    });
    await h.stop();
  });
});

describe("speakerState", () => {
  const state = (s: Partial<SpotifyState>): SpotifyState => ({
    asOf: "",
    ...s,
  });
  test("one word to switch on", () => {
    expect(speakerState(undefined)).toBe("offline");
    expect(
      speakerState({
        status: "disconnected",
        state: state({ status: "playing" }),
      }),
    ).toBe("offline");
    expect(speakerState({ status: "connecting" })).toBe("connecting");
    expect(
      speakerState({ status: "connected", state: state({ loggedIn: false }) }),
    ).toBe("waiting");
    expect(
      speakerState({
        status: "connected",
        state: state({ loggedIn: true, status: "paused" }),
      }),
    ).toBe("paused");
    expect(
      speakerState({
        status: "connected",
        state: state({ loggedIn: true, status: "stalled" }),
      }),
    ).toBe("stalled"); // passed through
    expect(
      speakerState({ status: "connected", state: state({ loggedIn: true }) }),
    ).toBe("idle");
  });
});

describe("spotifyChanges", () => {
  const part = (
    status: Part["status"],
    s: Partial<SpotifyState> = {},
  ): Part<SpotifyState> => ({
    status,
    state: { asOf: "", loggedIn: true, ...s },
  });
  const track = (uri: string) => ({ uri, name: uri, artists: [] });
  const types = (b: Part<SpotifyState> | undefined, a: Part<SpotifyState>) =>
    spotifyChanges(b, a).map((e) => e.type);

  test("a new track waits for its name; the same track named later is the event", () => {
    const bare = { uri: "t2", artists: [] };
    const before = part("connected", { status: "playing", track: track("t1") });
    const nameless = part("connected", { status: "playing", track: bare });
    expect(types(before, nameless)).toEqual([]);
    expect(
      types(
        nameless,
        part("connected", { status: "playing", track: track("t2") }),
      ),
    ).toEqual(["track"]);
  });

  test("nothing at boot: no before, or createHome's bare placeholder", () => {
    expect(
      spotifyChanges(
        undefined,
        part("connected", { status: "playing", track: track("t") }),
      ),
    ).toEqual([]);
    expect(
      spotifyChanges(
        { status: "connecting" },
        part("connected", { status: "playing", track: track("t") }),
      ),
    ).toEqual([]);
  });

  test("playback: started then the track, resumed, paused, stopped; buffering counts as playing", () => {
    expect(
      spotifyChanges(
        part("connected", { status: "idle" }),
        part("connected", { status: "playing", track: track("t") }),
      ),
    ).toEqual([{ type: "started" }, { type: "track", track: track("t") }]);
    expect(
      types(
        part("connected", { status: "paused", track: track("t") }),
        part("connected", { status: "playing", track: track("t") }),
      ),
    ).toEqual(["resumed"]);
    expect(
      types(
        part("connected", { status: "paused" }),
        part("connected", { status: "buffering" }),
      ),
    ).toEqual(["resumed"]);
    expect(
      types(
        part("connected", { status: "buffering" }),
        part("connected", { status: "playing" }),
      ),
    ).toEqual([]);
    expect(
      types(
        part("connected", { status: "playing" }),
        part("connected", { status: "paused" }),
      ),
    ).toEqual(["paused"]);
    expect(
      types(
        part("connected", { status: "paused" }),
        part("connected", { status: "idle" }),
      ),
    ).toEqual(["stopped"]);
    expect(
      types(
        part("connected", { status: "playing", track: track("a") }),
        part("connected", { status: "playing", track: track("b") }),
      ),
    ).toEqual(["track"]);
    expect(
      types(
        part("connected", { status: "playing", volume: 30 }),
        part("connected", { status: "playing", volume: 60 }),
      ),
    ).toEqual([]);
  });

  test("the connection and the session: offline once, online through connecting, waiting, picked", () => {
    const playing = part("connected", { status: "playing", track: track("t") });
    const lost = { ...playing, status: "disconnected" as const };
    expect(types(playing, lost)).toEqual(["offline"]);
    expect(types(lost, lost)).toEqual([]);
    expect(types(lost, { ...lost, status: "connecting" })).toEqual([]);
    expect(types({ ...lost, status: "connecting" }, playing)).toEqual([
      "online",
    ]);
    expect(types(playing, part("connected", { loggedIn: false }))).toEqual([
      "waiting",
    ]);
    expect(
      types(
        part("connected", { loggedIn: false }),
        part("connected", { loggedIn: true }),
      ),
    ).toEqual(["picked"]);
  });

  test("a drop during an aside is offline, never own; a reconnect that signed in says online and picked", async () => {
    const h = setup();
    const sock = await h.online({ status: "playing", item: TRACK });
    const done = h.s.interrupt(() => new Promise((r) => setTimeout(r, 20)));
    await tick();
    sock.ack();
    sock.push({ type: "playback_changed", status: "paused" });
    await tick();
    sock.close();
    await Bun.sleep(30); // fn ends
    await h.advance(100); // the resume's turn in the lane: it fails offline
    expect((await done).music).toBe("failed");
    const events = h.parts
      .slice(1)
      .flatMap((p, i) => spotifyChanges(h.parts[i], p));
    expect(events).toContainEqual({ type: "offline" });
    const before = h.last();
    await h.advance(1000);
    const next = h.sockets.at(-1)!;
    next.open();
    next.push({
      type: "auth_state",
      logged_in: false,
      is_active: false,
      device_name: "Kitchen",
    });
    expect(spotifyChanges(before, h.last()).map((e) => e.type)).toEqual([
      "online",
      "waiting",
    ]);
    const waiting = h.last();
    next.push({
      type: "auth_state",
      logged_in: true,
      is_active: true,
      device_name: "Kitchen",
    });
    next.push({ type: "playback_state", status: "playing", item: TRACK });
    expect(spotifyChanges(waiting, h.last()).map((e) => e.type)).toEqual([
      "picked",
      "started",
      "track",
    ]);
    await h.stop();
  });

  test("changes while the library's own duck or interrupt runs are marked own", async () => {
    const h = setup();
    const sock = await h.online({ status: "playing", item: TRACK });
    const done = h.s.interrupt(() => "said");
    await tick();
    sock.ack();
    sock.push({ type: "playback_changed", status: "paused" });
    await h.advance(100);
    sock.ack();
    sock.push({ type: "playback_changed", status: "playing" });
    await done;
    const events = h.parts
      .slice(1)
      .flatMap((p, i) => spotifyChanges(h.parts[i], p));
    expect(events).toEqual([
      { type: "paused", own: true },
      { type: "resumed", own: true },
    ]);
    expect(h.last().state?.aside).toBeUndefined();
    sock.push({ type: "playback_changed", status: "paused" });
    expect(spotifyChanges(h.parts.at(-2), h.last())).toEqual([
      { type: "paused" },
    ]);
    await h.stop();
  });
});

describe("stalls (Soloist issue #5)", () => {
  /** Answer the get_state a stall check sends with this position, Soloist's clock at `atMs`. */
  async function answer(
    h: ReturnType<typeof setup>,
    sock: FakeSocket,
    ms: number,
    atMs: number,
  ) {
    await tick();
    expect(sock.sent.at(-1)).toMatchObject({ command: "get_state" });
    sock.push({
      type: "playback_state",
      status: "playing",
      item: TRACK,
      volume: 40,
      position: { position_ms: ms, timestamp_ms: atMs, speed: 1 },
    });
    await tick();
  }
  const playingAt = (ms: number) => ({
    status: "playing",
    item: TRACK,
    position: { position_ms: ms, timestamp_ms: 0, speed: 1 },
  });

  test("a position that stops moving is a stall: anomaly and a stalled event, no write without repairStalls", async () => {
    const h = setup({ stallCheckMs: 20_000 });
    const sock = await h.online(playingAt(80_000));
    await h.advance(19_900);
    await answer(h, sock, 99_000, 20_000);
    await h.advance(20_000);
    const before = h.last();
    await answer(h, sock, 99_100, 40_000);
    expect(h.last().state?.stalled).toEqual({
      track: "spotify:track:abc123",
      ms: 99_100,
      how: "frozen",
    });
    expect(h.last().anomaly).toBe(
      "playback stalled at 1:39 (Soloist issue #5)",
    );
    expect(spotifyChanges(before, h.last())).toContainEqual({
      type: "stalled",
      stall: { track: "spotify:track:abc123", ms: 99_100, how: "frozen" },
    });
    expect(sock.commands()).toEqual(["get_state", "get_state"]);
    const stalled = h.last();
    await h.advance(20_000);
    await answer(h, sock, 120_000, 60_000); // it moves again
    expect(h.last().state?.stalled).toBeUndefined();
    expect(spotifyChanges(stalled, h.last())).toEqual([{ type: "recovered" }]);
    await h.stop();
  });

  test("moving normally is no stall; paused or idle is not looked at", async () => {
    const h = setup({ stallCheckMs: 20_000 });
    const sock = await h.online(playingAt(10_000));
    await h.advance(19_900);
    await answer(h, sock, 30_000, 20_000);
    await h.advance(20_000);
    await answer(h, sock, 50_000, 40_000);
    expect(h.last().state?.stalled).toBeUndefined();
    sock.push({ type: "playback_changed", status: "paused" });
    sock.sent.length = 0;
    await h.advance(20_000);
    expect(sock.sent).toEqual([]);
    await h.stop();
  });

  test("repairStalls: a seek to where it stuck, and when that moves it, nothing more", async () => {
    const h = setup({ stallCheckMs: 20_000, repairStalls: true });
    const sock = await h.online(playingAt(80_000));
    await h.advance(19_900);
    await answer(h, sock, 99_000, 20_000);
    await h.advance(20_000);
    await answer(h, sock, 99_000, 40_000);
    await h.advance(100);
    expect(sock.ack()).toEqual({
      type: "command",
      command: "seek",
      position_ms: 99_000,
    });
    sock.push({
      type: "position_sync",
      position: { position_ms: 99_000, timestamp_ms: 40_200, speed: 1 },
    });
    await tick();
    expect(h.last().anomaly).toBe(
      "playback stalled at 1:39 (Soloist issue #5); tried a seek",
    );
    expect(h.last().state?.aside).toBe("repair");
    await h.advance(5000);
    await answer(h, sock, 104_000, 45_300);
    expect(sock.commands()).toEqual([
      "get_state",
      "get_state",
      "seek",
      "get_state",
    ]);
    expect(h.last().state?.aside).toBeUndefined();
    await h.stop();
  });

  test("repairStalls: still frozen after the seek, a pause and play; once per track", async () => {
    const h = setup({ stallCheckMs: 20_000, repairStalls: true });
    const sock = await h.online(playingAt(80_000));
    await h.advance(19_900);
    await answer(h, sock, 99_000, 20_000);
    await h.advance(20_000);
    await answer(h, sock, 99_000, 40_000);
    await h.advance(100);
    sock.ack();
    sock.push({
      type: "position_sync",
      position: { position_ms: 99_000, timestamp_ms: 40_200, speed: 1 },
    });
    await tick();
    await h.advance(5000);
    await answer(h, sock, 99_000, 45_300);
    await h.advance(100);
    expect(sock.ack()).toMatchObject({ command: "pause" });
    sock.push({ type: "playback_changed", status: "paused" });
    await h.advance(100);
    expect(sock.ack()).toMatchObject({ command: "play" });
    sock.push({ type: "playback_changed", status: "playing" });
    await tick();
    expect(h.last().anomaly).toBe(
      "playback stalled at 1:39 (Soloist issue #5); tried a seek, then pause and play",
    );
    expect(h.last().state?.stalled?.track).toBe("spotify:track:abc123"); // still on: the next check that sees it move clears it
    sock.sent.length = 0;
    await h.advance(20_000);
    await answer(h, sock, 99_000, 65_000);
    await h.advance(20_000);
    await answer(h, sock, 99_000, 85_000);
    expect(sock.commands()).toEqual(["get_state", "get_state"]); // no second repair on this track
    await h.stop();
  });

  test("repair: a person pausing during its wait ends it; an interrupt waits for it", async () => {
    const h = setup({ stallCheckMs: 20_000, repairStalls: true });
    const sock = await h.online(playingAt(80_000));
    await h.advance(19_900);
    await answer(h, sock, 99_000, 20_000);
    await h.advance(20_000);
    await answer(h, sock, 99_000, 40_000);
    await h.advance(100);
    sock.ack(); // the seek
    sock.push({
      type: "position_sync",
      position: { position_ms: 99_000, timestamp_ms: 40_200, speed: 1 },
    });
    await tick();
    const announced: string[] = [];
    const done = h.s.interrupt(() => announced.push("said"));
    await tick();
    expect(sock.commands()).toEqual(["get_state", "get_state", "seek"]); // the interrupt waits its turn
    sock.push({ type: "playback_changed", status: "paused" }); // someone paused from a phone
    await h.advance(5000);
    expect(await done).toMatchObject({
      value: 1,
      music: "untouched",
      why: "it was not playing",
    });
    expect(sock.commands()).toEqual(["get_state", "get_state", "seek"]); // no pause and play from the repair
    expect(h.last().state?.aside).toBeUndefined();
    await h.stop();
  });

  test("a pause between two checks is not a stall", async () => {
    const h = setup({ stallCheckMs: 20_000 });
    const sock = await h.online(playingAt(80_000));
    await h.advance(19_900);
    await answer(h, sock, 99_000, 20_000);
    sock.push({ type: "playback_changed", status: "paused" });
    sock.push({ type: "playback_changed", status: "playing" });
    await h.advance(20_000);
    await answer(h, sock, 99_300, 40_000);
    expect(h.last().state?.stalled).toBeUndefined();
    await h.stop();
  });

  test("repeat-track running past the track's length is not an overrun", async () => {
    const h = setup({ stallCheckMs: 20_000 });
    const sock = await h.online({
      ...playingAt(196_000),
      options: { shuffle: false, repeat: "track" },
    });
    await h.advance(19_900);
    await answer(h, sock, 196_000, 0);
    expect(h.last().state?.stalled).toBeUndefined();
    await h.stop();
  });

  test("stuck past the end of the track is a stall; repair skips it", async () => {
    const h = setup({ stallCheckMs: 20_000, repairStalls: true });
    const sock = await h.online(playingAt(196_000));
    await h.advance(19_900);
    await answer(h, sock, 196_000, 0); // the same old anchor: by now 216 s into a 200 s track
    await h.advance(100);
    const stalled = h.last();
    expect(stalled.state?.stalled).toMatchObject({ how: "overrun" });
    expect(stalled.anomaly).toBe(
      "playback stuck past the end of the track (Soloist issue #5); tried a skip",
    );
    expect(sock.ack()).toMatchObject({ command: "skip_next" });
    sock.push({
      type: "track_changed",
      item: entity("spotify:track:next", "Next"),
    });
    await tick();
    expect(h.last().state?.stalled).toBeUndefined();
    await h.stop();
  });
});
