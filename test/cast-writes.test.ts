import { describe, expect, test } from "bun:test";
import type { Clock, Part } from "../src/index.ts";
import { idleClock, manualClock } from "./clock.ts";
import {
  cast,
  type CastConnect,
  type CastSnapshot,
} from "../src/connectors/cast/index.ts";
import {
  type CastChannel,
  type CastMessage,
  NS,
} from "../src/connectors/cast/codec.ts";
import { type Resolved } from "../src/connectors/cast/state.ts";
import { serveClip } from "../src/connectors/cast/serve.ts";

// Writes on a scripted fake: every device answers as the live ones do for reads (docs/cast.md), and LAUNCH, LOAD,
// SET_VOLUME and STOP as Google's docs and pychromecast describe them. Nothing here has met a real device.

const dashed = (id: string) =>
  `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
const DMR = {
  appId: "CC1AD845",
  displayName: "Default Media Receiver",
  sessionId: "00000000-0000-4000-8000-0000000000d1",
  transportId: "web-1",
  namespaces: [{ name: NS.media }],
};
const BACKDROP = {
  appId: "E8C28D3C",
  displayName: "Backdrop",
  isIdleScreen: true,
  sessionId: "00000000-0000-4000-8000-0000000000b1",
  transportId: "web-0",
  namespaces: [],
};
const SPOTIFY = {
  appId: "CC32E753",
  displayName: "Spotify",
  sessionId: "00000000-0000-4000-8000-0000000000c1",
  transportId: "web-2",
  namespaces: [{ name: NS.media }],
};
const CLIP = "http://192.0.2.200:40000/clip";

type Fake = {
  id: string;
  name: string;
  host: string;
  port: number;
  group?: boolean;
  leader?: string;
  level: number;
  muted?: boolean;
  app?: object;
  media?: object[];
  members?: string[];
};
type Script = {
  launch?: "ignore";
  load?: "finish" | "silent" | "ignore" | "error" | "stuck" | "unplayable";
  reload?: "error";
  durationS?: number;
};

const home = (): Fake[] => [
  {
    id: "00000000000040008000000000000011",
    name: "Kitchen",
    host: "192.0.2.11",
    port: 8009,
    level: 0.3,
    app: BACKDROP,
  },
  {
    id: "00000000000040008000000000000012",
    name: "Lounge",
    host: "192.0.2.12",
    port: 8009,
    level: 0.5,
  },
  {
    id: "00000000000040008000000000000013",
    name: "Downstairs",
    host: "192.0.2.11",
    port: 32001,
    group: true,
    leader: "00000000000040008000000000000011",
    level: 0.4,
    members: [
      "00000000000040008000000000000011",
      "00000000000040008000000000000012",
    ],
  },
];

/** A network of fakes that answer reads and writes and record what they were sent. */
function fakeHome(list: Fake[], script: Script = {}) {
  const sent: { to: string; ns: string; destination: string; p: any }[] = [];
  const byId = new Map(list.map((f) => [f.id, f]));
  let mediaSession = 10;
  const down = new Set<string>(); // names whose connects fail
  const sockets = new Map<
    string,
    (p: object, namespace: string, source: string) => void
  >();
  const connect: CastConnect = async ({ host, port }) => {
    const f = list.find((x) => x.host === host && x.port === port);
    if (!f || down.has(f.name)) throw new Error(`nothing at ${host}:${port}`);
    const queue: CastMessage[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    const push = (p: object, namespace: string, source: string) => (
      queue.push({
        source,
        destination: "sender-0",
        namespace,
        payload: JSON.stringify(p),
      }),
      wake?.()
    );
    sockets.set(f.name, push);
    const status = (requestId?: number) => ({
      type: "RECEIVER_STATUS",
      requestId,
      status: {
        applications: f.app ? [f.app] : undefined,
        volume: {
          controlType: "master",
          level: f.level,
          muted: f.muted ?? false,
        },
      },
    });
    const channel: CastChannel = {
      peer: dashed(f.leader ?? f.id),
      send(m) {
        const p = JSON.parse(m.payload!);
        sent.push({
          to: f.name,
          ns: m.namespace.split(".").pop()!,
          destination: m.destination,
          p,
        });
        const reply = (x: object) => push(x, m.namespace, m.destination);
        const media = (x: object[], requestId?: number) =>
          push(
            { type: "MEDIA_STATUS", requestId, status: x },
            NS.media,
            m.destination,
          );
        switch (`${m.namespace.split(".").pop()} ${p.type}`) {
          case "receiver GET_STATUS":
            return reply(status(p.requestId));
          case "multizone GET_STATUS": {
            const devices = (f.members ?? [f.id])
              .map((id) => byId.get(id)!)
              .map((x) => ({
                deviceId: dashed(x.id),
                name: x.name,
                volume: { level: x.level, muted: x.muted ?? false },
              }));
            return reply({
              type: "MULTIZONE_STATUS",
              requestId: p.requestId,
              status: { devices },
            });
          }
          case "receiver SET_VOLUME":
            if (p.volume.level !== undefined)
              for (const x of [
                f,
                ...(f.members ?? []).map((id) => byId.get(id)!),
              ])
                x.level = p.volume.level;
            if (p.volume.muted !== undefined) f.muted = p.volume.muted;
            return reply(status(p.requestId));
          case "receiver LAUNCH":
            if (script.launch === "ignore") return;
            ((f.app = DMR), (f.media = []));
            return reply(status(p.requestId));
          case "receiver STOP":
            ((f.app = BACKDROP), (f.media = undefined));
            return reply(status(p.requestId));
          case "media GET_STATUS":
            return media(f.media ?? [], p.requestId);
          case "media LOAD": {
            const s = ++mediaSession;
            const playing = {
              mediaSessionId: s,
              playerState: "PLAYING",
              currentTime: p.currentTime ?? 0,
              media: { ...p.media, duration: script.durationS },
            };
            if (p.currentTime !== undefined && script.reload === "error")
              return reply({ type: "LOAD_FAILED", requestId: p.requestId });
            if (p.currentTime !== undefined)
              return ((f.media = [playing]), media(f.media, p.requestId)); // a restore
            if (script.load === "ignore") return;
            if (script.load === "error")
              return reply({ type: "LOAD_FAILED", requestId: p.requestId });
            media([{ ...playing, playerState: "BUFFERING" }], p.requestId);
            if (script.load === "stuck") return;
            if (script.load === "unplayable")
              return media([
                {
                  mediaSessionId: s,
                  playerState: "IDLE",
                  idleReason: "ERROR",
                  detailedErrorCode: 301,
                },
              ]);
            media([
              {
                mediaSessionId: s - 1,
                playerState: "IDLE",
                idleReason: "INTERRUPTED",
              },
            ]); // a stale session's end: never ours
            media([playing]);
            if (script.load !== "silent")
              media([
                {
                  mediaSessionId: s,
                  playerState: "IDLE",
                  idleReason: "FINISHED",
                },
              ]);
            return;
          }
        }
      },
      close: () => ((closed = true), wake?.()),
      messages: (async function* () {
        for (;;) {
          while (queue.length) yield queue.shift()!;
          if (closed) return;
          await new Promise<void>((r) => (wake = r));
        }
      })(),
    };
    return channel;
  };
  let from = 0;
  /** What one fake was sent since `mark()`, as "namespace TYPE", without connection chatter or the integration's own read of a media app. */
  const writes = (name: string) =>
    sent
      .slice(from)
      .filter(
        (x) =>
          x.to === name &&
          !["CONNECT", "PING", "PONG", "CLOSE"].includes(x.p.type) &&
          !(x.ns === "media" && x.p.type === "GET_STATUS"),
      )
      .map((x) => `${x.ns} ${x.p.type}`);
  /** The device drops its socket and stops answering connects. */
  const drop = (name: string) => (
    down.add(name),
    sockets.get(name)?.({ type: "CLOSE" }, NS.connection, "receiver-0")
  );
  return {
    connect,
    sent,
    writes,
    mark: () => void (from = sent.length),
    drop,
    down,
  };
}

const idle = idleClock();
const until = async (check: () => boolean, ms = 2000) => {
  for (const end = Date.now() + ms; !check(); await Bun.sleep(2))
    if (Date.now() > end) throw new Error("timed out");
};
const resolved = (list: Fake[]): Resolved[] =>
  list.map((f) => ({
    id: f.id,
    name: f.name,
    host: f.host,
    port: f.port,
    group: f.group ?? false,
  }));

/** A running cast() over the fakes, connected; `done()` stops it. */
async function connected(
  list: Fake[],
  script: Script = {},
  options: { clock?: Clock; serve?: Parameters<typeof cast>[0]["serve"] } = {},
) {
  const net = fakeHome(list, script);
  const parts: Part<CastSnapshot>[] = [];
  const stop = new AbortController();
  let resolves = 0;
  const c = cast({
    resolve: async () => (resolves++, resolved(list)),
    connect: net.connect,
    clock: options.clock ?? idle,
    pingMs: 3_600_000,
    serve: options.serve,
  });
  const running = c.run(stop.signal, (p) => parts.push(p));
  await until(
    () =>
      parts.at(-1)?.status === "connected" &&
      Object.values(parts.at(-1)!.state!.devices).every(
        (d) => d.status === "connected" && d.asOf,
      ),
  );
  await Bun.sleep(5); // the multizone answers too
  net.mark();
  return {
    c,
    net,
    parts,
    resolves: () => resolves,
    done: async () => (stop.abort(), await running),
  };
}

describe("announce", () => {
  test("an idle speaker: volume, LAUNCH, LOAD, wait for FINISHED, then STOP and the volume back", async () => {
    const list = home();
    const h = await connected(list);
    const r = await h.c.announce(
      "kitchen",
      { url: CLIP, type: "audio/mp4" },
      { volume: 0.6 },
    );
    expect(r).toEqual({
      played: true,
      restored: ["Kitchen: idle", "Kitchen: volume"],
      notRestored: [],
    });
    expect(h.net.writes("Kitchen")).toEqual([
      "receiver GET_STATUS",
      "receiver SET_VOLUME",
      "receiver LAUNCH",
      "media LOAD",
      "receiver STOP",
      "receiver SET_VOLUME",
    ]);
    const load = h.net.sent.find((x) => x.p.type === "LOAD")!;
    expect(load).toMatchObject({
      destination: "web-1",
      p: {
        media: {
          contentId: CLIP,
          contentType: "audio/mp4",
          streamType: "BUFFERED",
        },
        autoplay: true,
      },
    });
    expect(
      h.net.sent
        .filter((x) => x.p.type === "SET_VOLUME")
        .map((x) => x.p.volume.level),
    ).toEqual([0.6, 0.3]);
    expect(list[0]).toMatchObject({ level: 0.3, app: BACKDROP });
    await h.done();
  });

  test("a group: re-resolved first, its volume on the group socket, the group's own volume back and then each member's through its own socket", async () => {
    const list = home();
    const h = await connected(list);
    const before = h.resolves();
    const r = await h.c.announce("Downstairs", { url: CLIP }, { volume: 0.7 });
    expect(h.resolves()).toBe(before + 1);
    expect(r).toEqual({
      played: true,
      restored: [
        "Downstairs: idle",
        "Downstairs: volume",
        "Kitchen: volume",
        "Lounge: volume",
      ],
      notRestored: [],
    });
    expect(
      h.net.sent
        .filter((x) => x.p.type === "SET_VOLUME")
        .map((x) => `${x.to} ${x.p.volume.level}`),
    ).toEqual([
      "Downstairs 0.7",
      "Downstairs 0.4",
      "Kitchen 0.3",
      "Lounge 0.5",
    ]);
    expect(list.map((f) => f.level)).toEqual([0.3, 0.5, 0.4]); // the group's own level back first; here that moves the members, and their own levels land last
    await h.done();
  });

  test("a group whose leader moved: the stale socket is closed and the announcement goes to the new address", async () => {
    const list = home();
    const fast: Clock = {
      now: () => Date.now(),
      sleep: (ms, signal) =>
        ms === 1000 ? Bun.sleep(1) : idle.sleep(ms, signal),
    };
    const h = await connected(list, {}, { clock: fast });
    Object.assign(list[2]!, {
      host: "192.0.2.12",
      port: 32002,
      leader: list[1]!.id,
    });
    const before = h.resolves();
    const r = await h.c.announce("Downstairs", { url: CLIP });
    expect(r.played).toBe(true);
    await Bun.sleep(20);
    expect(h.resolves()).toBe(before + 1); // announce's own discovery; closing the stale socket does not start a second
    expect(
      h.net.sent.filter(
        (x) =>
          x.to === "Downstairs" &&
          x.destination === "web-1" &&
          x.p.type === "CONNECT",
      ),
    ).toHaveLength(1); // one CONNECT to the player's transport
    expect(h.net.sent.find((x) => x.p.type === "LOAD")!.to).toBe("Downstairs");
    expect(h.parts.at(-1)!.state!.devices[list[2]!.id]).toMatchObject({
      host: "192.0.2.12",
      port: 32002,
      leader: list[1]!.id,
    });
    await h.done();
  });

  test("what the Default Media Receiver was playing is loaded again where it was", async () => {
    const list = home();
    const song = {
      contentId: "http://192.0.2.50/song.mp3",
      contentType: "audio/mpeg",
      streamType: "BUFFERED",
      metadata: { title: "A song" },
    };
    Object.assign(list[1]!, {
      app: DMR,
      media: [
        {
          mediaSessionId: 1,
          playerState: "PLAYING",
          currentTime: 42.5,
          media: song,
        },
      ],
    });
    const h = await connected(list);
    const r = await h.c.announce("Lounge", { url: CLIP });
    expect(r).toEqual({
      played: true,
      restored: ["Lounge: what was playing"],
      notRestored: [],
    });
    const loads = h.net.sent.filter((x) => x.p.type === "LOAD").map((x) => x.p);
    expect(loads[1]).toMatchObject({
      media: song,
      currentTime: 42.5,
      autoplay: true,
    });
    expect(h.net.writes("Lounge")).not.toContain("receiver STOP");
    await h.done();
  });

  test("another app is interrupted: the device goes idle and the result says it cannot be resumed", async () => {
    const list = home();
    list[1]!.app = SPOTIFY;
    const h = await connected(list);
    const r = await h.c.announce("Lounge", { url: CLIP });
    expect(r).toEqual({
      played: true,
      restored: [],
      notRestored: [
        {
          name: "Lounge",
          why: "Spotify was interrupted and cannot be resumed from here",
        },
      ],
    });
    expect(h.net.writes("Lounge").at(-1)).toBe("receiver STOP");
    await h.done();
  });

  test("bytes are served for the device's address and the server closed after", async () => {
    const list = home();
    const calls: { type: string; host?: string }[] = [];
    let closed = 0;
    const serve = async (
      _bytes: Uint8Array,
      type: string,
      o?: { host?: string },
    ) => (
      calls.push({ type, host: o?.host }),
      { url: CLIP, close: () => void closed++ }
    );
    const h = await connected(list, {}, { serve });
    const r = await h.c.announce("Kitchen", {
      bytes: new Uint8Array([1, 2, 3]),
      type: "audio/mp4",
    });
    expect(r.played).toBe(true);
    expect(calls).toEqual([{ type: "audio/mp4", host: "192.0.2.11" }]);
    expect(closed).toBe(1);
    await h.done();
  });

  test("a muted target is unmuted for the clip and muted again after, with its volume", async () => {
    const list = home();
    list[0]!.muted = true;
    const h = await connected(list);
    const r = await h.c.announce("Kitchen", { url: CLIP });
    expect(r).toEqual({
      played: true,
      restored: ["Kitchen: idle", "Kitchen: volume, muted"],
      notRestored: [],
    });
    expect(
      h.net.sent
        .filter((x) => x.p.type === "SET_VOLUME")
        .map((x) => JSON.stringify(x.p.volume)),
    ).toEqual(['{"muted":false}', '{"level":0.3}', '{"muted":true}']);
    expect(list[0]).toMatchObject({ level: 0.3, muted: true });
    await h.done();
  });

  test("a group member whose socket is down cannot have its volume put back, and the result says so", async () => {
    const list = home();
    const h = await connected(list);
    h.net.drop("Lounge");
    await until(
      () =>
        h.parts.at(-1)?.state?.devices[list[1]!.id]?.status === "disconnected",
    );
    const r = await h.c.announce("Downstairs", { url: CLIP }, { volume: 0.7 });
    expect(r).toEqual({
      played: true,
      restored: ["Downstairs: idle", "Downstairs: volume", "Kitchen: volume"],
      notRestored: [
        {
          name: "Lounge",
          why: "not connected, so its volume stays as the announcement set it",
        },
      ],
    });
    await h.done();
  });

  test("what was playing, refused when loaded again, is reported, not thrown", async () => {
    const list = home();
    const song = {
      contentId: "http://192.0.2.50/song.mp3",
      contentType: "audio/mpeg",
      streamType: "BUFFERED",
    };
    Object.assign(list[1]!, {
      app: DMR,
      media: [
        {
          mediaSessionId: 1,
          playerState: "PLAYING",
          currentTime: 7,
          media: song,
        },
      ],
    });
    const h = await connected(list, { reload: "error" });
    const r = await h.c.announce("Lounge", { url: CLIP });
    expect(r).toEqual({
      played: true,
      restored: [],
      notRestored: [
        {
          name: "Lounge",
          why: "what was playing not restored: LOAD refused: LOAD_FAILED",
        },
      ],
    });
    await h.done();
  });

  test("refused before anything changes: an unknown target, a volume out of range, bytes without serve", async () => {
    const h = await connected(home());
    await expect(h.c.announce("Attic", { url: CLIP })).rejects.toThrow(
      'no Cast device or group "Attic"; have: Downstairs, Kitchen, Lounge',
    );
    await expect(
      h.c.announce("Kitchen", { url: CLIP }, { volume: 47 }),
    ).rejects.toThrow("volume is 0 to 1, got 47");
    await expect(
      h.c.announce("Kitchen", { bytes: new Uint8Array(1), type: "audio/mp4" }),
    ).rejects.toThrow("needs serve");
    await Bun.sleep(5);
    expect(h.net.writes("Kitchen")).toEqual([]);
    await h.done();
  });
});

describe("announce timeouts and failures, always restored", () => {
  /** A cast() on a clock the test moves; announce runs until the test has advanced it. */
  async function timed(script: Script) {
    const list = home();
    const { clock, advance } = manualClock();
    const h = await connected(list, script, { clock });
    return { list, h, advance };
  }

  test("a group whose leader moved and does not answer at its new address: refused after 10 s, nothing sent", async () => {
    const { list, h, advance } = await timed({});
    Object.assign(list[2]!, {
      host: "192.0.2.12",
      port: 32002,
      leader: list[1]!.id,
    });
    h.net.down.add("Downstairs");
    const r = h.c.announce("Downstairs", { url: CLIP }, { volume: 0.9 });
    r.catch(() => {});
    await Bun.sleep(5);
    await advance(10_000);
    await expect(r).rejects.toThrow("Downstairs did not connect in 10 s");
    expect(h.net.writes("Downstairs")).toEqual([]);
    await h.done();
  });

  test("LAUNCH unanswered for 10 s: not played, nothing of ours to stop, the volume back", async () => {
    const { list, h, advance } = await timed({ launch: "ignore" });
    const r = h.c.announce("Kitchen", { url: CLIP }, { volume: 0.9 });
    await Bun.sleep(5);
    await advance(10_000);
    expect(await r).toEqual({
      played: false,
      why: "no Default Media Receiver in 10 s",
      restored: ["Kitchen: volume"],
      notRestored: [],
    });
    expect(h.net.writes("Kitchen")).not.toContain("receiver STOP");
    expect(list[0]!.level).toBe(0.3);
    await h.done();
  });

  test("LOAD unanswered for 10 s, and LOAD refused: not played, the device put back to idle", async () => {
    for (const load of ["ignore", "error"] as const) {
      const { h, advance } = await timed({ load });
      const r = h.c.announce("Kitchen", { url: CLIP });
      await Bun.sleep(5);
      if (load === "ignore") await advance(10_000);
      expect(await r).toEqual({
        played: false,
        why:
          load === "ignore"
            ? "no answer to LOAD in 10 s"
            : "LOAD refused: LOAD_FAILED",
        restored: ["Kitchen: idle"],
        notRestored: [],
      });
      await h.done();
    }
  });

  test("a clip that never starts fails in 15 s, and everything is put back", async () => {
    const { h, advance } = await timed({ load: "stuck" });
    const r = h.c.announce("Kitchen", { url: CLIP });
    await Bun.sleep(5);
    await advance(15_000);
    expect(await r).toEqual({
      played: false,
      why: "no start of the clip (audio/mpeg, which this device may not play) in 15 s",
      restored: ["Kitchen: idle"],
      notRestored: [],
    });
    await h.done();
  });

  test("a clip the device can't play says so, with the receiver's code and the type", async () => {
    const { h } = await timed({ load: "unplayable" });
    const r = await h.c.announce("Kitchen", { url: CLIP, type: "audio/wav" });
    expect(r.played).toBe(false);
    expect(r.why).toBe(
      "the clip stopped: ERROR (detailed error 301); this device may not play audio/wav",
    );
    await h.done();
  });

  test("announceAll: one result per device, an unknown target its own failure, a bad volume one error", async () => {
    const { h } = await timed({});
    await expect(
      h.c.announceAll(["Kitchen"], { url: CLIP }, { volume: 50 }),
    ).rejects.toThrow();
    const r = await h.c.announceAll(["Kitchen", "Nowhere", "kitchen"], {
      url: CLIP,
    });
    expect(r.map((x) => [x.target, x.played])).toEqual([
      ["Kitchen", true],
      ["Nowhere", false],
    ]);
    expect(r[1]!.why).toContain("Nowhere");
    await h.done();
  });

  test("a clip that never finishes: the wait is 60 s plus the clip's own length, then STOP", async () => {
    const { list, h, advance } = await timed({ load: "silent", durationS: 3 });
    let settled = false;
    const r = h.c
      .announce("Kitchen", { url: CLIP })
      .finally(() => (settled = true));
    await Bun.sleep(5);
    await advance(60_000);
    expect(settled).toBe(false);
    await advance(3_000);
    expect(await r).toEqual({
      played: false,
      why: "no end of the clip in 63 s",
      restored: ["Kitchen: idle"],
      notRestored: [],
    });
    expect(list[0]!.app).toBe(BACKDROP);
    await h.done();
  });
});

describe("volume, mute, stop", () => {
  test("each goes to the target's own socket; a group's volume to the group's", async () => {
    const list = home();
    list[1]!.app = SPOTIFY;
    const h = await connected(list);
    await h.c.setVolume("Downstairs", 0.25);
    await h.c.setMuted(list[0]!.id, true);
    await h.c.stop("lounge");
    await h.c.stop("Kitchen"); // idle: nothing to stop
    expect(
      h.net.sent
        .filter((x) => ["SET_VOLUME", "STOP"].includes(x.p.type))
        .map((x) => `${x.to} ${JSON.stringify(x.p.volume ?? x.p.sessionId)}`),
    ).toEqual([
      'Downstairs {"level":0.25}',
      'Kitchen {"muted":true}',
      `Lounge "${SPOTIFY.sessionId}"`,
    ]);
    await expect(h.c.setVolume("Kitchen", -0.1)).rejects.toThrow(
      "volume is 0 to 1",
    );
    await h.done();
  });

  test("a burst of levels sends the first and the last; a mute goes as its own request", async () => {
    const h = await connected(home());
    await Promise.all([
      h.c.setVolume("Kitchen", 0.1),
      h.c.setVolume("Kitchen", 0.2),
      h.c.setMuted("Kitchen", true),
      h.c.setVolume("Kitchen", 0.3),
    ]);
    expect(
      h.net.sent
        .filter((x) => x.p.type === "SET_VOLUME")
        .map((x) => JSON.stringify(x.p.volume)),
    ).toEqual(['{"level":0.1}', '{"level":0.3}', '{"muted":true}']);
    await h.done();
  });
});

describe("serveClip", () => {
  test("serves the bytes with their type and length to every GET (a probe first is fine) and HEAD, until closed", async () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const { url, close } = await serveClip(bytes, "audio/mp4", {
      host: "127.0.0.1",
    });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]{36}$/);
    expect((await fetch(new URL("/other", url))).status).toBe(404);
    const head = await fetch(url, { method: "HEAD" });
    expect([head.status, head.headers.get("content-length")]).toEqual([
      200,
      "8",
    ]);
    for (let i = 0; i < 2; i++) {
      const got = await fetch(url);
      expect(got.headers.get("content-type")).toBe("audio/mp4");
      expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
    }
    close();
    await expect(fetch(url)).rejects.toThrow();
  });

  test("close() and an aborted signal end it unfetched", async () => {
    const a = await serveClip(new Uint8Array(1), "audio/mpeg", {
      host: "127.0.0.1",
    });
    a.close();
    await expect(fetch(a.url)).rejects.toThrow();
    const stop = new AbortController();
    const b = await serveClip(new Uint8Array(1), "audio/mpeg", {
      host: "127.0.0.1",
      signal: stop.signal,
    });
    stop.abort();
    await expect(fetch(b.url)).rejects.toThrow();
  });

  test("an address on the target's network, or none", async () => {
    const { lanAddress } = await import("../src/connectors/cast/serve.ts");
    const nets = {
      en0: [
        {
          family: "IPv4",
          address: "192.0.2.7",
          netmask: "255.255.255.0",
          internal: false,
        },
      ],
      lo0: [
        {
          family: "IPv4",
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          internal: true,
        },
      ],
    } as never;
    expect(lanAddress("192.0.2.11", nets)).toBe("192.0.2.7");
    expect(lanAddress(undefined, nets)).toBe("192.0.2.7");
    expect(() => lanAddress("198.51.100.4", nets)).toThrow(
      "no address of this machine on 198.51.100.4's network",
    );
  });
});
