import { describe, expect, test } from "bun:test";
import type { Part } from "../src/index.ts";
import { manualClock } from "./clock.ts";
import { manifest, positionMs, spotify, spotifyText, type SocketLike, type SpotifyState, toSpotifyUri } from "../src/connectors/spotify/index.ts";
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

const entity = (uri: string, name: string, extra: Record<string, unknown> = {}) => ({ uri, entity_type: uri.split(":")[1] ?? "", decorations: { identity: { name }, ...extra } });

const TRACK = entity("spotify:track:abc123", "Song A", {
  visual_identity: { cover: [{ url: "https://i.example/small.jpg", size: "small" }, { url: "https://i.example/default.jpg", size: "default" }] },
  parent: { entity: entity("spotify:album:alb1", "Album A") },
  creators: [{ entity: entity("spotify:artist:a1", "Artist One") }, { entity: entity("spotify:artist:a2", "Artist Two") }],
  playback: { duration_ms: 200_000 },
});

function setup(config: { maxVolume?: number; url?: string } = {}) {
  const { clock, advance } = manualClock();
  const sockets: FakeSocket[] = [];
  const parts: Part<SpotifyState>[] = [];
  const s = spotify({ ...config, clock, connect: (url) => (sockets.push(new FakeSocket(url)), sockets.at(-1)!) });
  const abort = new AbortController();
  const running = s.run(abort.signal, (p) => parts.push(p));
  const last = () => parts.at(-1)!;
  /** Open the newest socket and say what Soloist says on connect when signed in. */
  const online = (playback: Record<string, unknown> = {}) => {
    const sock = sockets.at(-1)!;
    sock.open();
    sock.push({ type: "auth_state", logged_in: true, is_active: true, device_name: "Kitchen" });
    sock.push({ type: "playback_state", status: "idle", item: { uri: "", entity_type: "" }, volume: 40, options: { shuffle: false, repeat: "off" }, ...playback });
    return sock;
  };
  const stop = async () => (abort.abort(), await running);
  return { s, sockets, parts, last, online, clock, advance, stop };
}

const tick = () => Bun.sleep(1);

describe("toSpotifyUri", () => {
  test("open.spotify.com links become URIs", () => {
    expect(toSpotifyUri("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x1")).toBe("spotify:track:4uLU6hMCjMI75M1A2tKUQC");
    expect(toSpotifyUri("https://open.spotify.com/intl-en/playlist/37i9dQZF1DX")).toBe("spotify:playlist:37i9dQZF1DX");
    expect(toSpotifyUri("https://open.spotify.com/embed/album/1DFixLWuPkv3KT3TnV35m3")).toBe("spotify:album:1DFixLWuPkv3KT3TnV35m3");
  });

  test("URIs pass through; short links and words do not", () => {
    expect(toSpotifyUri(" spotify:album:1DFixLWuPkv3KT3TnV35m3 ")).toBe("spotify:album:1DFixLWuPkv3KT3TnV35m3");
    expect(toSpotifyUri("https://spotify.link/abc")).toBeUndefined();
    expect(toSpotifyUri("friday")).toBeUndefined();
  });
});

describe("fold", () => {
  const AT = "2026-11-08T00:00:00.000Z";
  test("playback_state is a full snapshot; events patch one field", () => {
    let s: SpotifyState = { asOf: AT };
    s = fold(s, { type: "auth_state", logged_in: true, is_active: true, device_name: "Kitchen" }, AT);
    s = fold(s, { type: "playback_state", status: "paused", item: TRACK, context: entity("spotify:playlist:p1", "Mix"), volume: 40, options: { shuffle: true, repeat: "context" }, position: { position_ms: 1000, timestamp_ms: 5, speed: 0 } }, AT);
    expect(s).toEqual({
      loggedIn: true,
      active: true,
      deviceName: "Kitchen",
      status: "paused",
      track: { uri: "spotify:track:abc123", type: "track", name: "Song A", artists: ["Artist One", "Artist Two"], album: "Album A", cover: "https://i.example/default.jpg", durationMs: 200_000 },
      context: { uri: "spotify:playlist:p1", type: "playlist", name: "Mix" },
      position: { ms: 1000, atMs: 5, speed: 0 },
      volume: 40,
      shuffle: true,
      repeat: "context",
      asOf: AT,
    });
    s = fold(s, { type: "track_changed", item: entity("spotify:track:zzz", "Song B") }, AT);
    s = fold(s, { type: "playback_changed", status: "playing" }, AT);
    s = fold(s, { type: "volume_changed", volume: 55 }, AT);
    s = fold(s, { type: "device_changed", is_active: false, device_name: "Lounge" }, AT);
    s = fold(s, { type: "options_changed", options: { shuffle: false } }, AT);
    expect([s.track?.name, s.status, s.volume, s.deviceName, s.active, s.shuffle, s.repeat]).toEqual(["Song B", "playing", 55, "Lounge", false, false, "context"]);
  });

  test("an empty item uri is nothing loaded; signing out clears the playback", () => {
    let s = fold({ asOf: AT }, { type: "playback_state", status: "idle", item: { uri: "", entity_type: "" } }, AT);
    expect(s.track).toBeUndefined();
    expect("track" in s).toBe(false);
    s = fold({ ...s, track: { uri: "spotify:track:x", artists: [] }, volume: 30 }, { type: "auth_state", logged_in: false, is_active: false, device_name: "Kitchen" }, AT);
    expect(s).toEqual({ loggedIn: false, active: false, deviceName: "Kitchen", asOf: AT });
  });

  test("odd readings pass through, named", () => {
    const s: SpotifyState = { asOf: AT, status: "stalled", volume: 140, repeat: "sometimes", position: { ms: 300_000, speed: -1 }, track: { uri: "spotify:track:x", artists: [], durationMs: 200_000 } };
    expect(oddities(s)).toBe('status "stalled"; volume 140, outside 0–100; repeat "sometimes"; position speed -1; position 300000 ms past the track\'s 200000 ms');
    expect(oddities({ asOf: AT, status: "playing", volume: 0 })).toBeUndefined();
  });
});

describe("positionMs", () => {
  const base: SpotifyState = { asOf: "", status: "playing", track: { uri: "spotify:track:x", artists: [], durationMs: 200_000 }, position: { ms: 10_000, atMs: 1_000_000, speed: 1 } };
  test("moves on while playing, at its speed; a clock behind the anchor is not clamped", () => {
    expect(positionMs(base, 1_005_000)).toBe(15_000);
    expect(positionMs({ ...base, position: { ...base.position, speed: 1.5 } }, 1_002_000)).toBe(13_000);
    expect(positionMs(base, 999_000)).toBe(9_000);
  });
  test("stands still while paused; undefined without a track or an anchor", () => {
    expect(positionMs({ ...base, status: "paused" }, 1_005_000)).toBe(10_000);
    expect(positionMs({ ...base, track: undefined }, 1_005_000)).toBeUndefined();
    expect(positionMs({ ...base, position: undefined }, 1_005_000)).toBeUndefined();
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
    h.online({ status: "paused", item: TRACK });
    expect(h.last()).toMatchObject({ status: "connected", state: { loggedIn: true, deviceName: "Kitchen", status: "paused", volume: 40, track: { name: "Song A" } } });
    expect(h.last().detail).toBeUndefined();
    h.sockets[0]!.push({ type: "volume_changed", volume: 55 });
    expect(h.last().state?.volume).toBe(55);
    await h.stop();
  });

  test("unreachable is disconnected, and it retries with backoff 1, 2, 4 s", async () => {
    const h = setup({ url: "ws://127.0.0.1:9999" });
    h.sockets[0]!.close();
    await tick();
    expect(h.last()).toMatchObject({ status: "disconnected", detail: "nothing answered at ws://127.0.0.1:9999" });
    await h.advance(1000);
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]!.close();
    await tick();
    await h.advance(1999);
    expect(h.sockets).toHaveLength(2);
    await h.advance(1);
    expect(h.sockets).toHaveLength(3);
    h.online();
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
    h.online({ status: "playing", item: TRACK });
    h.sockets[1]!.close();
    await tick();
    expect(h.last()).toMatchObject({ status: "disconnected", detail: "Soloist closed the socket", state: { status: "playing", track: { name: "Song A" } } });
    await h.advance(1000); // back to 1 s, not 4
    expect(h.sockets).toHaveLength(3);
    await h.stop();
  });

  test("a constructor that throws (no WebSocket in the runtime) is disconnected, saying why", async () => {
    const { clock } = manualClock();
    const parts: Part<SpotifyState>[] = [];
    const abort = new AbortController();
    const running = spotify({ clock, connect: () => { throw new Error("WebSocket is not defined"); } }).run(abort.signal, (p) => parts.push(p));
    await tick();
    expect(parts.at(-1)).toMatchObject({ status: "disconnected", detail: "could not open ws://127.0.0.1:9091: WebSocket is not defined" });
    abort.abort();
    await running;
  });

  test("a first sign-in asks for the state, since only auth_state is promised", () => {
    const h = setup();
    const sock = h.sockets[0]!;
    sock.open();
    sock.push({ type: "auth_state", logged_in: false, is_active: false, device_name: "Kitchen" });
    expect(sock.commands()).toEqual([]);
    sock.push({ type: "auth_state", logged_in: true, is_active: true, device_name: "Kitchen" });
    expect(sock.commands()).toEqual(["get_state"]);
    sock.push({ type: "auth_state", logged_in: true, is_active: true, device_name: "Kitchen" });
    expect(sock.commands()).toEqual(["get_state"]);
  });
  test("signed out is connected, says so, and refuses writes without sending them", async () => {
    const h = setup();
    const sock = h.sockets[0]!;
    sock.open();
    sock.push({ type: "auth_state", logged_in: false, is_active: false, device_name: "Kitchen" });
    expect(h.last()).toMatchObject({ status: "connected", state: { loggedIn: false, deviceName: "Kitchen" } });
    expect(h.last().detail).toContain("nobody has picked it");
    expect(manifest.lines(h.last())).toEqual(["Kitchen: not signed in"]);
    await expect(h.s.pause()).rejects.toThrow("no Spotify session");
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
    sock.push({ type: "auth_state", logged_in: true, is_active: true, device_name: "Kitchen" });
    expect(h.parts.every((p) => p.status !== "connected")).toBe(true);
    sock.push({ type: "playback_state", status: "playing", item: TRACK, volume: 40 });
    expect(h.last()).toMatchObject({ status: "connected", state: { status: "playing", track: { name: "Song A" } } });
    await h.stop();
  });

  test("signed in with no playback_state in 10 s: connected with what there is", async () => {
    const h = setup();
    const sock = h.sockets[0]!;
    sock.open();
    sock.push({ type: "auth_state", logged_in: true, is_active: true, device_name: "Kitchen" });
    await h.advance(10_000);
    expect(h.last()).toMatchObject({ status: "connected", state: { loggedIn: true, deviceName: "Kitchen" } });
    await h.stop();
  });

  test("a socket that opens and says nothing is closed after 10 s", async () => {
    const h = setup();
    h.sockets[0]!.open();
    await h.advance(10_000);
    expect(h.last()).toMatchObject({ status: "disconnected", detail: "Soloist said nothing in 10 s" });
    await h.stop();
  });

  test("refresh sends get_state while connected, and reconnects at once while down", async () => {
    const h = setup();
    const sock = h.online();
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
    const sock = h.online();
    h.s.refresh();
    const paused = h.s.pause();
    expect(sock.commands()).toEqual(["get_state"]);
    sock.push({ type: "error", message: "busy" });
    await tick();
    expect(h.last().anomaly).toBe("get_state failed: Soloist refused get_state: busy");
    await h.advance(100);
    expect(sock.commands()).toEqual(["get_state", "pause"]);
    sock.ack();
    await paused;
    await h.stop();
  });

  test("a frame the schema rejects is an anomaly; unknown frame types are skipped", async () => {
    const h = setup();
    const sock = h.online();
    sock.push({ type: "volume_changed", volume: "loud" });
    expect(h.last().anomaly).toBe("a volume_changed the schema did not recognise");
    expect(h.last().state?.volume).toBe(40);
    const n = h.parts.length;
    sock.push({ type: "queue_changed", previous: [], upcoming: [] });
    sock.push({ type: "something_new" });
    expect(h.parts.length).toBe(n);
    sock.push({ type: "volume_changed", volume: 120 });
    expect(h.last()).toMatchObject({ anomaly: "volume 120, outside 0–100", state: { volume: 120 } });
    await h.stop();
  });

  test("lines: speaker, status, track, volume", () => {
    const state: SpotifyState = { asOf: "", deviceName: "Kitchen", loggedIn: true, status: "playing", volume: 35, track: { uri: "spotify:track:x", name: "Song", artists: ["Band", "Other"] } };
    expect(manifest.lines({ status: "connected", state })).toEqual(['Kitchen: playing "Song" by Band, Other · 35%']);
    expect(spotifyText({ asOf: "" })).toBe("Soloist: status unknown");
  });
});

describe("writes", () => {
  test("each command's frame, resolved by its command_result", async () => {
    const h = setup();
    const sock = h.online();
    const cases: [() => Promise<unknown>, Record<string, unknown>][] = [
      [() => h.s.play("https://open.spotify.com/album/alb1?si=1"), { command: "play", uri: "spotify:album:alb1" }],
      [() => h.s.play(), { command: "play" }],
      [() => h.s.resume(), { command: "play" }],
      [() => h.s.pause(), { command: "pause" }],
      [() => h.s.next(), { command: "skip_next" }],
      [() => h.s.prev(), { command: "skip_prev" }],
      [() => h.s.seek(30_000), { command: "seek", position_ms: 30_000 }],
      [() => h.s.setVolume(50), { command: "set_volume", volume: 50 }],
      [() => h.s.queue("spotify:track:t1"), { command: "add_to_queue", uri: "spotify:track:t1" }],
      [() => h.s.setShuffle(true), { command: "set_shuffle", enabled: true }],
    ];
    for (const [call, frame] of cases) {
      const p = call();
      await h.advance(100); // the lane's gap
      expect(sock.ack()).toEqual({ type: "command", ...frame });
      await p;
    }
    await h.stop();
  });

  test("Soloist's error rejects the command in flight; offline and bad input reject without sending", async () => {
    const h = setup();
    await expect(h.s.pause()).rejects.toThrow("Soloist is not connected at ws://127.0.0.1:9091");
    const sock = h.online();
    await h.advance(100); // the refused pause still took its turn in the lane
    const p = h.s.next();
    sock.push({ type: "error", message: "command requires authentication" });
    await expect(p).rejects.toThrow("Soloist refused skip_next: command requires authentication");
    await expect(h.s.play("friday")).rejects.toThrow("not a Spotify link");
    await expect(h.s.queue("spotify:album:alb1")).rejects.toThrow("only a Spotify track");
    await expect(h.s.setVolume(120)).rejects.toThrow("0–100");
    await expect(h.s.seek(-1)).rejects.toThrow("0 or more");
    expect(sock.commands()).toEqual(["skip_next"]);
    await h.stop();
  });

  test("an error with nothing waiting is an anomaly", async () => {
    const h = setup();
    const sock = h.online();
    sock.push({ type: "error", message: "something went wrong" });
    expect(h.last().anomaly).toBe("Soloist said: something went wrong");
    await h.stop();
  });

  test("a command with no answer times out after 3 s; a drop fails it at once", async () => {
    const h = setup();
    const sock = h.online();
    const p = h.s.pause();
    const caught = p.catch((e: Error) => e.message);
    await h.advance(3000);
    expect(await caught).toBe("Soloist did not answer pause in 3 s");
    await h.advance(100);
    const q = h.s.next();
    sock.close();
    await expect(q).rejects.toThrow("not connected");
    await h.stop();
  });

  test("a requested volume is held to maxVolume and rounded; the volume sent comes back", async () => {
    const h = setup({ maxVolume: 60 });
    const sock = h.online();
    const p = h.s.setVolume(90);
    expect(sock.ack()).toMatchObject({ command: "set_volume", volume: 60 });
    expect(await p).toBe(60);
    await h.advance(100);
    const q = h.s.setVolume(33.4);
    expect(sock.ack()).toMatchObject({ volume: 33 });
    expect(await q).toBe(33);
    await h.stop();
  });

  test("the lane: volumes waiting merge to the last; two skips stay two", async () => {
    const h = setup();
    const sock = h.online();
    const a = h.s.setVolume(10);
    const b = h.s.setVolume(20);
    const c = h.s.setVolume(30);
    sock.ack();
    await a;
    await h.advance(100);
    expect(sock.ack()).toMatchObject({ volume: 30 });
    expect(await Promise.all([b, c])).toEqual([20, 30]); // each resolves with what it asked for; the device got 30
    await h.advance(100);
    const n1 = h.s.next();
    const n2 = h.s.next();
    sock.ack();
    await n1;
    await h.advance(100);
    sock.ack();
    await n2;
    expect(sock.commands()).toEqual(["set_volume", "set_volume", "skip_next", "skip_next"]);
    await h.stop();
  });
});

describe("the first play's volume (Soloist issue #23)", () => {
  test("idle → playing above the cap is lowered to it, once, and said in anomaly", async () => {
    const h = setup({ maxVolume: 60 });
    const sock = h.online({ volume: 100 });
    sock.push({ type: "playback_changed", status: "playing" });
    expect(sock.sent).toEqual([{ type: "command", command: "set_volume", volume: 60 }]);
    expect(h.last().anomaly).toBe("started at volume 100, above maxVolume 60; lowered it (Soloist issue #23)");
    expect(h.last().state?.volume).toBe(100); // the reading stays what Soloist said until it says otherwise
    sock.ack();
    sock.push({ type: "volume_changed", volume: 60 });
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
    sock.push({ type: "auth_state", logged_in: false, is_active: false, device_name: "Kitchen" });
    sock.push({ type: "auth_state", logged_in: true, is_active: true, device_name: "Kitchen" });
    expect(sock.commands()).toEqual(["get_state"]);
    sock.push({ type: "playback_state", status: "playing", item: TRACK, volume: 100 });
    await h.advance(100);
    expect(sock.sent.at(-1)).toEqual({ type: "command", command: "set_volume", volume: 60 });
    await h.stop();
  });

  test("also when the volume arrives after the status", async () => {
    const h = setup({ maxVolume: 60 });
    const sock = h.online({ volume: 30 });
    sock.push({ type: "playback_changed", status: "playing" });
    expect(sock.sent).toEqual([]);
    sock.push({ type: "volume_changed", volume: 100 });
    expect(sock.sent).toEqual([{ type: "command", command: "set_volume", volume: 60 }]);
    await h.stop();
  });

  test("not resuming from pause, not after the window, not connecting mid-song, not without a cap", async () => {
    const h = setup({ maxVolume: 60 });
    const sock = h.online({ status: "paused", volume: 90 });
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
    expect(mid.online({ status: "playing", volume: 90 }).sent).toEqual([]);
    await mid.stop();

    const free = setup();
    const s = free.online({ volume: 100 });
    s.push({ type: "playback_changed", status: "playing" });
    expect(s.sent).toEqual([]);
    await free.stop();
  });
});

describe("interrupt", () => {
  test("pauses, runs fn once the pause shows, then resumes", async () => {
    const h = setup();
    const sock = h.online({ status: "playing", item: TRACK });
    const order: string[] = [];
    const done = h.s.interrupt(async () => (order.push("announce"), "said"));
    expect(sock.ack()).toMatchObject({ command: "pause" });
    await tick();
    expect(order).toEqual([]);
    sock.push({ type: "playback_changed", status: "paused" });
    await tick();
    expect(order).toEqual(["announce"]);
    await h.advance(100);
    expect(sock.ack()).toMatchObject({ command: "play" });
    expect(await done).toBe("said");
    expect(sock.commands()).toEqual(["pause", "play"]);
    await h.stop();
  });

  test("resumes even when fn throws", async () => {
    const h = setup();
    const sock = h.online({ status: "playing", item: TRACK });
    const caught = h.s.interrupt(() => Promise.reject(new Error("chime failed"))).catch((e: Error) => e.message);
    sock.ack();
    await tick();
    sock.push({ type: "playback_changed", status: "paused" });
    await h.advance(100);
    sock.ack();
    expect(await caught).toBe("chime failed");
    expect(sock.commands()).toEqual(["pause", "play"]);
    await h.stop();
  });

  test("runs fn after 2 s if the pause never shows", async () => {
    const h = setup();
    const sock = h.online({ status: "playing", item: TRACK });
    let ran = false;
    const done = h.s.interrupt(() => (ran = true));
    sock.ack();
    await tick();
    await h.advance(1999);
    expect(ran).toBe(false);
    await h.advance(1);
    expect(ran).toBe(true);
    sock.ack();
    await done;
    await h.stop();
  });

  test("a failed pause still runs fn, without a resume, and says so in detail", async () => {
    const h = setup();
    const sock = h.online({ status: "playing", item: TRACK });
    const p = h.s.interrupt(() => "a");
    sock.push({ type: "error", message: "command requires authentication" });
    expect(await p).toBe("a");
    expect(sock.commands()).toEqual(["pause"]);
    expect(h.last().detail).toBe("pause before interrupt failed: Soloist refused pause: command requires authentication");
    await h.stop();
  });

  test("a failed write's detail clears on the next write that works", async () => {
    const h = setup();
    const sock = h.online({ status: "playing", item: TRACK });
    const p = h.s.interrupt(() => "a");
    sock.push({ type: "error", message: "busy" });
    await p;
    expect(h.last().detail).toContain("pause before interrupt failed");
    const v = h.s.setVolume(30);
    await h.advance(100);
    sock.ack();
    await v;
    sock.push({ type: "volume_changed", volume: 30 });
    expect(h.last().detail).toBeUndefined();
    await h.stop();
  });

  test("not playing, or not connected: just runs fn", async () => {
    const h = setup();
    const sock = h.online({ status: "paused", item: TRACK });
    expect(await h.s.interrupt(() => 42)).toBe(42);
    expect(sock.sent).toEqual([]);
    sock.push({ type: "playback_changed", status: "playing" });
    sock.close();
    expect(await h.s.interrupt(() => 43)).toBe(43);
    await h.stop();
  });
});
