import { describe, expect, test } from "bun:test";
import type { Clock, Part } from "../src/index.ts";
import { idleClock, manualClock } from "./clock.ts";
import {
  cast,
  type CastDevice,
  castForm,
  castFree,
  castFreeSpeakers,
  castStatus,
  type CastConnect,
  type CastSnapshot,
} from "../src/connectors/cast/index.ts";
import {
  type CastChannel,
  type CastMessage,
  decode,
  encode,
  framer,
  NS,
} from "../src/connectors/cast/codec.ts";
import { CastPayload } from "../src/connectors/cast/schemas.ts";
import {
  castKey,
  connection,
  found,
  reduce,
  type Resolved,
} from "../src/connectors/cast/state.ts";

// Recorded from seven live devices (2026-10-13, Bun 1.4.2, read-only), ids, names, ports and sessions replaced.
const dir = new URL("./fixtures/cast/", import.meta.url);
const fixture = async (name: string) =>
  JSON.parse(await Bun.file(new URL(`${name}.json`, dir)).text());
type Recorded = Resolved & { file: string; peer: string };
const recorded: Recorded[] = await fixture("devices");
// A group answers at its leader's address on its own port; the leader is the device its certificate names.
const devices: Recorded[] = recorded.map((d, i) => ({
  ...d,
  host: `192.0.2.${recorded.findIndex((x) => !x.group && x.peer === d.peer) + 1 || i + 1}`,
}));
const byFile = (file: string) => devices.find((d) => d.file === file)!;
const AT = "2026-10-13T10:00:00.000Z";

const payload = async (name: string) => CastPayload.parse(await fixture(name));
/** Every recorded device answering receiver status, and the group (and devices) multizone status. */
async function live(): Promise<CastSnapshot> {
  let s = found({ devices: {}, asOf: AT }, devices, AT);
  for (const d of devices) {
    s = reduce(s, d.id, await payload(`${d.file}-receiver`), AT);
    s = reduce(s, d.id, await payload(`${d.file}-multizone`), AT);
  }
  return connection(
    s,
    byFile("group").id,
    { status: "connected", leader: byFile("group").peer },
    AT,
  );
}

describe("codec", () => {
  test("round-trips a message, through a framer fed one byte at a time", () => {
    const m: CastMessage = {
      source: "sender-0",
      destination: "receiver-0",
      namespace: NS.receiver,
      payload: JSON.stringify({
        type: "GET_STATUS",
        requestId: 1,
        note: "ünïcode ".repeat(3000),
      }),
    };
    const bytes = encode(m);
    expect(new DataView(bytes.buffer).getUint32(0)).toBe(bytes.length - 4);
    expect(decode(bytes.subarray(4))).toEqual(m);
    const split = framer();
    const out: CastMessage[] = [];
    for (const b of [...bytes, ...encode({ ...m, payload: "{}" })])
      out.push(...split(Uint8Array.of(b)));
    expect(out).toEqual([m, { ...m, payload: "{}" }]);
  });

  test("a length over 64 KiB is an error, not a wait", () => {
    expect(() => framer()(Uint8Array.of(0, 2, 0, 0))).toThrow(
      "over the protocol's",
    );
  });
});

describe("reduce", () => {
  test("the recorded devices: idle hubs, a speaker with no app, a TV in standby, volumes unrounded", async () => {
    const s = await live();
    const d = (file: string) => s.devices[castKey(byFile(file).id)]!;
    expect(d("hub")).toMatchObject({
      app: "Backdrop",
      idle: true,
      volume: 0.4699999988079071,
      muted: false,
      volumeControl: "master",
      groups: [castKey(byFile("group").id)],
    });
    expect(d("speaker")).toMatchObject({
      app: undefined,
      idle: true,
      volume: 0.30000001192092896,
    });
    expect(d("speaker").groups).toBeUndefined();
    expect(d("streamer")).toMatchObject({
      standby: true,
      idle: true,
      volumeControl: "fixed",
    });
    expect(d("ultra")).toMatchObject({
      app: "Backdrop",
      volumeControl: "attenuation",
      volume: 0.8000000715255737,
    });
    expect(d("hub").members).toBeUndefined(); // a device's own multizone lists only itself
  });

  test("the group: members from its multizone status, the leader its certificate names", async () => {
    const g = (await live()).devices[castKey(byFile("group").id)]!;
    expect(g).toMatchObject({
      kind: "group",
      name: "Cast Group",
      volume: 0.435001939535141,
      leader: castKey(byFile("hub").id),
    });
    expect(g.members).toEqual(
      ["hub", "hubmax", "mini"].map((f) => castKey(byFile(f).id)),
    );
  });

  test("a playing group shows on members with no media of their own, playingVia naming it; it clears when the group stops", async () => {
    // Invented: nothing was playing when the fixtures were recorded.
    const group = byFile("group").id;
    const media = (playerState: string) =>
      CastPayload.parse({
        type: "MEDIA_STATUS",
        status: [
          {
            playerState,
            media: { metadata: { title: "A song", artist: "A band" } },
          },
        ],
      });
    let s = reduce(await live(), group, media("PLAYING"), AT);
    const mini = castKey(byFile("mini").id);
    expect(s.devices[mini]).toMatchObject({
      playerState: "PLAYING",
      title: "A song",
      artist: "A band",
      playingVia: castKey(group),
    });
    expect(
      s.devices[castKey(byFile("speaker").id)]!.playingVia,
    ).toBeUndefined();
    s = reduce(s, group, media("IDLE"), AT);
    expect(s.devices[mini]!.playingVia).toBeUndefined();
    expect(s.devices[mini]!.playerState).toBeUndefined();
  });

  test("a member's own media wins over the group's it was showing", async () => {
    const group = byFile("group").id;
    const mini = byFile("mini").id;
    let s = reduce(
      await live(),
      group,
      CastPayload.parse({
        type: "MEDIA_STATUS",
        status: [
          {
            playerState: "PLAYING",
            media: { metadata: { title: "Group song" } },
          },
        ],
      }),
      AT,
    );
    expect(s.devices[castKey(mini)]).toMatchObject({
      playingVia: castKey(group),
      playerState: "PLAYING",
    });
    s = reduce(
      s,
      mini,
      CastPayload.parse({
        type: "MEDIA_STATUS",
        status: [
          { playerState: "PAUSED", media: { metadata: { title: "Own song" } } },
        ],
      }),
      AT,
    );
    expect(s.devices[castKey(mini)]).toMatchObject({
      playerState: "PAUSED",
      title: "Own song",
    });
    expect(s.devices[castKey(mini)]!.playingVia).toBeUndefined();
  });

  test("members removed and added while connected", async () => {
    const group = byFile("group").id;
    let s = reduce(
      await live(),
      group,
      CastPayload.parse({
        type: "DEVICE_REMOVED",
        deviceId: byFile("mini").peer,
      }),
      AT,
    );
    expect(s.devices[castKey(group)]!.members).toHaveLength(2);
    expect(s.devices[castKey(byFile("mini").id)]!.groups).toBeUndefined();
    s = reduce(
      s,
      group,
      CastPayload.parse({
        type: "DEVICE_ADDED",
        device: { deviceId: byFile("speaker").peer, name: "Home Speaker" },
      }),
      AT,
    );
    expect(s.devices[castKey(byFile("speaker").id)]!.groups).toEqual([
      castKey(group),
    ]);
  });

  test("an app stopping clears what was playing", async () => {
    const hub = byFile("hub").id;
    const app = {
      appId: "CC1AD845",
      displayName: "Default Media Receiver",
      transportId: "t-1",
      namespaces: [{ name: NS.media }],
    };
    let s = reduce(
      await live(),
      hub,
      CastPayload.parse({
        type: "RECEIVER_STATUS",
        status: { applications: [app] },
      }),
      AT,
    );
    s = reduce(
      s,
      hub,
      CastPayload.parse({
        type: "MEDIA_STATUS",
        status: [{ playerState: "PLAYING" }],
      }),
      AT,
    );
    expect(s.devices[castKey(hub)]).toMatchObject({
      app: "Default Media Receiver",
      idle: false,
      playerState: "PLAYING",
    });
    s = reduce(s, hub, await payload("hub-receiver"), AT);
    expect(s.devices[castKey(hub)]).toMatchObject({
      app: "Backdrop",
      idle: true,
      playerState: undefined,
    });
  });
});

/** A fake device: answers each request from the fixtures, records what it was sent. */
function fakeNetwork(
  options: {
    peer?: (d: (typeof devices)[number]) => string;
    media?: boolean;
    mute?: string;
  } = {},
) {
  const sent: { to: string; m: CastMessage }[] = [];
  const open = new Set<string>();
  const down = new Set<string>(); // files whose connects fail
  const sockets = new Map<
    string,
    (m: object, ns?: string, source?: string) => void
  >();
  const connect: CastConnect = async ({ host, port }) => {
    const d = devices.find((x) => x.host === host && x.port === port);
    if (!d || down.has(d.file)) throw new Error(`nothing at ${host}:${port}`);
    const queue: CastMessage[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    const push = (
      p: object,
      namespace: string = NS.receiver,
      source = "receiver-0",
    ) => (
      queue.push({
        source,
        destination: "sender-0",
        namespace,
        payload: JSON.stringify(p),
      }),
      wake?.()
    );
    sockets.set(d.file, push);
    open.add(d.file);
    const channel: CastChannel = {
      peer: options.peer?.(d) ?? d.peer,
      send(m) {
        sent.push({ to: d.file, m });
        const p = JSON.parse(m.payload!);
        if (p.type !== "GET_STATUS" || d.file === options.mute) return;
        if (m.namespace === NS.receiver)
          void fixture(`${d.file}-receiver`).then((r) =>
            push(
              options.media && d.file === "hub"
                ? {
                    type: "RECEIVER_STATUS",
                    status: {
                      applications: [
                        {
                          displayName: "Default Media Receiver",
                          transportId: "t-1",
                          namespaces: [{ name: NS.media }],
                        },
                      ],
                    },
                  }
                : r,
            ),
          );
        if (m.namespace === NS.multizone)
          void fixture(`${d.file}-multizone`).then((r) =>
            push(r, NS.multizone),
          );
        if (m.namespace === NS.media)
          push(
            { type: "MEDIA_STATUS", status: [{ playerState: "PAUSED" }] },
            NS.media,
            m.destination,
          );
      },
      close: () => ((closed = true), open.delete(d.file), wake?.()),
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
  return { connect, sent, open, sockets, down };
}

/** Real time, short: the integration's own clock only paces pings and backoff here. */
const until = async (check: () => boolean, ms = 2000) => {
  for (const end = Date.now() + ms; !check(); await Bun.sleep(2))
    if (Date.now() > end) throw new Error("timed out");
};

const idle = idleClock();

describe("cast()", () => {
  test("connects to every entry, reads status, and reports connected once all have answered; abort closes every socket", async () => {
    const net = fakeNetwork();
    const parts: Part<CastSnapshot>[] = [];
    const stop = new AbortController();
    const i = cast({
      resolve: async () => devices,
      connect: net.connect,
      clock: idle,
    });
    const running = i.run(stop.signal, (p) => parts.push(p));
    await until(() => parts.at(-1)?.status === "connected");
    const s = parts.at(-1)!.state!;
    expect(Object.keys(s.devices)).toHaveLength(7);
    const first = parts.findIndex((p) => p.status !== "connecting");
    expect(parts[first]!.status).toBe("connected"); // not before every device has answered
    expect(
      Object.values(parts[first]!.state!.devices).every((d) => d.asOf),
    ).toBe(true);
    expect(s.devices[castKey(byFile("group").id)]).toMatchObject({
      leader: castKey(byFile("hub").id),
      status: "connected",
    });
    // Only reads went out: CONNECT, GET_STATUS, nothing that launches, plays or changes a volume.
    expect(
      new Set(net.sent.map(({ m }) => JSON.parse(m.payload!).type)),
    ).toEqual(new Set(["CONNECT", "GET_STATUS"]));
    expect(
      net.sent.filter(({ m }) => m.namespace === NS.multizone),
    ).toHaveLength(7); // a group's members, a device's own name
    stop.abort();
    await running;
    expect(net.open.size).toBe(0);
    expect(
      net.sent.filter(({ m }) => JSON.parse(m.payload!).type === "CLOSE"),
    ).toHaveLength(7);
  });

  test("a certificate naming another device is refused; a missing configured entry shows as disconnected", async () => {
    const net = fakeNetwork({
      peer: (d) => (d.file === "mini" ? byFile("speaker").peer : d.peer),
    });
    const parts: Part<CastSnapshot>[] = [];
    const stop = new AbortController();
    const expect_ = [
      { castId: "0000000000004000800000000000ffff", name: "Gone" },
    ];
    const running = cast({
      resolve: async () => devices,
      connect: net.connect,
      clock: idle,
      expect: expect_,
    }).run(stop.signal, (p) => parts.push(p));
    await until(() => parts.at(-1)?.status === "connected");
    const s = parts.at(-1)!.state!;
    expect(s.devices[castKey(byFile("mini").id)]).toMatchObject({
      status: "disconnected",
      detail: "the certificate names another device; the address has moved",
    });
    expect(s.devices["0000000000004000800000000000ffff"]).toMatchObject({
      name: "Gone",
      status: "disconnected",
      detail: "not found by discovery",
    });
    expect(parts.at(-1)!.detail).toBe("Nest Mini, Gone disconnected");
    stop.abort();
    await running;
  });

  test("a media app's transport is connected and read; refresh re-asks every socket", async () => {
    const net = fakeNetwork({ media: true });
    const parts: Part<CastSnapshot>[] = [];
    const stop = new AbortController();
    const i = cast({
      resolve: async () => devices,
      connect: net.connect,
      clock: idle,
    });
    const running = i.run(stop.signal, (p) => parts.push(p));
    await until(
      () =>
        parts.at(-1)?.state?.devices[castKey(byFile("hub").id)]?.playerState ===
        "PAUSED",
    );
    expect(
      net.sent
        .filter(({ m }) => m.destination === "t-1")
        .map(({ m }) => JSON.parse(m.payload!).type),
    ).toEqual(["CONNECT", "GET_STATUS"]);
    const before = net.sent.length;
    i.refresh();
    const asked = net.sent
      .slice(before)
      .map(({ to, m }) => `${to} ${m.namespace.split(".").pop()}`);
    expect(asked).toHaveLength(15); // seven receivers, seven multizones, the hub's media
    expect(asked).toContain("hub media");
    stop.abort();
    await running;
  });

  test("a dropped socket reconnects after discovery, at the address discovery now gives", async () => {
    const net = fakeNetwork();
    const parts: Part<CastSnapshot>[] = [];
    const stop = new AbortController();
    let resolves = 0;
    const fast: Clock = {
      now: () => Date.now(),
      sleep: (ms, signal) =>
        ms < 1000 || ms > 1000 ? idle.sleep(ms, signal) : Bun.sleep(1),
    };
    const running = cast({
      resolve: async () => (resolves++, devices),
      connect: net.connect,
      clock: fast,
    }).run(stop.signal, (p) => parts.push(p));
    await until(() => parts.at(-1)?.status === "connected");
    net.sockets.get("speaker")!({ type: "CLOSE" }, NS.connection);
    await until(
      () =>
        resolves === 2 &&
        net.open.has("speaker") &&
        parts.at(-1)?.state?.devices[castKey(byFile("speaker").id)]?.status ===
          "connected",
    );
    expect(parts.some((p) => p.detail === "Home Speaker disconnected")).toBe(
      true,
    );
    stop.abort();
    await running;
  });

  test("cached addresses connect without discovery; a cached address that fails discovers and reconnects where it answers", async () => {
    const net = fakeNetwork();
    const parts: Part<CastSnapshot>[] = [];
    const stop = new AbortController();
    let resolves = 0;
    const seen: string[] = [];
    const speaker = byFile("speaker");
    const expect_ = devices.map((d) => ({
      castId: d.id,
      name: d.name,
      model: d.model,
      host: d.file === "speaker" ? "192.0.2.250" : d.host,
      port: d.port,
    })); // the speaker's cache is stale
    const running = cast({
      resolve: async () => (resolves++, devices),
      connect: net.connect,
      clock: idle,
      expect: expect_,
      seen: (id) => seen.push(id),
    }).run(stop.signal, (p) => parts.push(p));
    await until(() => parts.at(-1)?.status === "connected");
    expect(resolves).toBe(1); // only for the stale one
    expect(parts.at(-1)!.state!.devices[castKey(speaker.id)]).toMatchObject({
      status: "connected",
      host: speaker.host,
    });
    const first = parts.findIndex((p) => p.status !== "connecting");
    expect(parts[first]!.state!.devices[castKey(speaker.id)]!.status).toBe(
      "connected",
    ); // the stale try never showed as down
    expect(new Set(seen).size).toBe(7);
    expect(
      parts.at(-1)!.state!.devices[castKey(byFile("group").id)],
    ).toMatchObject({ kind: "group", leader: castKey(byFile("hub").id) });
    stop.abort();
    await running;
  });

  test("a cached address that fails and that discovery cannot find says not found by discovery", async () => {
    const net = fakeNetwork();
    const parts: Part<CastSnapshot>[] = [];
    const stop = new AbortController();
    const speaker = byFile("speaker");
    const expect_ = devices.map((d) => ({
      castId: d.id,
      name: d.name,
      model: d.model,
      host: d.file === "speaker" ? "192.0.2.250" : d.host,
      port: d.port,
    }));
    const others = devices.filter((d) => d.id !== speaker.id);
    let tries = 0;
    const running = cast({
      resolve: async () => others,
      connect: (o) => {
        if (o.host === "192.0.2.250") tries++;
        return net.connect(o);
      },
      clock: idle,
      expect: expect_,
    }).run(stop.signal, (p) => parts.push(p));
    await until(
      () =>
        parts.at(-1)?.state?.devices[castKey(speaker.id)]?.status ===
        "disconnected",
    );
    expect(
      parts.at(-1)!.state!.devices[castKey(speaker.id)]!.detail,
    ).toStartWith("not found by discovery; ");
    expect(tries).toBe(1); // no second wait on the address that just failed
    stop.abort();
    await running;
  });

  test("a configured name is the placeholder until the device answers, then its own name (a rename in the app, no discovery)", async () => {
    const net = fakeNetwork();
    const parts: Part<CastSnapshot>[] = [];
    const stop = new AbortController();
    const expect_ = devices.map((d) => ({
      castId: d.id,
      name: `Old ${d.name}`,
      model: d.model,
      host: d.host,
      port: d.port,
    }));
    const cached: (string | undefined)[] = [];
    const seen = (id: string, a: { name?: string }) =>
      id === castKey(byFile("hub").id) && cached.push(a.name);
    const running = cast({
      resolve: async () => devices,
      connect: net.connect,
      clock: idle,
      expect: expect_,
      seen,
    }).run(stop.signal, (p) => parts.push(p));
    expect(parts[0]!.state!.devices[castKey(byFile("hub").id)]!.name).toBe(
      "Old Nest Hub",
    );
    await until(
      () =>
        parts.at(-1)?.status === "connected" &&
        parts.at(-1)?.state?.devices[castKey(byFile("hub").id)]?.name ===
          "Nest Hub",
    );
    const s = parts.at(-1)!.state!;
    expect(s.devices[castKey(byFile("speaker").id)]!.name).toBe("Home Speaker");
    expect(s.devices[castKey(byFile("group").id)]!.name).toBe("Old Cast Group"); // a group's multizone lists its members, not itself: discovery renames it
    expect(cached).toEqual([undefined, "Nest Hub"]); // the address cache gets the device's own name, never the config's
    stop.abort();
    await running;
  });

  test("with every address cached and good, discovery never runs", async () => {
    const net = fakeNetwork();
    const parts: Part<CastSnapshot>[] = [];
    const stop = new AbortController();
    let resolves = 0;
    const expect_ = devices.map((d) => ({
      castId: d.id,
      name: d.name,
      model: d.model,
      host: d.host,
      port: d.port,
    }));
    const running = cast({
      resolve: async () => (resolves++, devices),
      connect: net.connect,
      clock: idle,
      expect: expect_,
    }).run(stop.signal, (p) => parts.push(p));
    await until(() => parts.at(-1)?.status === "connected");
    expect(resolves).toBe(0);
    stop.abort();
    await running;
  });

  test("a socket silent for three heartbeats is dropped; a PING from the device is answered", async () => {
    const net = fakeNetwork();
    let t = 0;
    const waits: (() => void)[] = [];
    const clock: Clock = {
      now: () => t,
      sleep: (_ms, signal) =>
        new Promise(
          (r) => (
            waits.push(r),
            signal?.addEventListener("abort", () => r(), { once: true })
          ),
        ),
    };
    const parts: Part<CastSnapshot>[] = [];
    const stop = new AbortController();
    const one = [byFile("speaker")];
    const running = cast({
      resolve: async () => one,
      connect: net.connect,
      clock,
    }).run(stop.signal, (p) => parts.push(p));
    await until(() => parts.at(-1)?.status === "connected");
    net.sockets.get("speaker")!({ type: "PING" }, NS.heartbeat, "Tr@n$p0rt-0");
    await until(() =>
      net.sent.some(({ m }) => JSON.parse(m.payload!).type === "PONG"),
    );
    expect(
      net.sent.find(({ m }) => JSON.parse(m.payload!).type === "PONG")!.m
        .destination,
    ).toBe("Tr@n$p0rt-0");
    for (const step of [5000, 5000, 5000, 5001]) {
      t += step;
      waits.splice(0).forEach((w) => w());
      await Bun.sleep(5);
    }
    await until(
      () =>
        parts.at(-1)?.state?.devices[castKey(byFile("speaker").id)]?.status ===
        "disconnected",
    );
    expect(
      parts.at(-1)!.state!.devices[castKey(byFile("speaker").id)]!.detail,
    ).toBe("silent for 15 s");
    expect(
      net.sent.filter(({ m }) => JSON.parse(m.payload!).type === "PING").length,
    ).toBe(3);
    stop.abort();
    waits.splice(0).forEach((w) => w());
    await running;
  });
});

describe("cast() review fixes", () => {
  test("a device that never answers its status is dropped after 10 s, so the part does not stay connecting", async () => {
    const net = fakeNetwork({ mute: "speaker" });
    const { clock, advance } = manualClock();
    const parts: Part<CastSnapshot>[] = [];
    const stop = new AbortController();
    const running = cast({
      resolve: async () => devices,
      connect: net.connect,
      clock,
      pingMs: 60_000,
    }).run(stop.signal, (p) => parts.push(p));
    await until(
      () =>
        Object.values(parts.at(-1)?.state?.devices ?? {}).filter((d) => d.asOf)
          .length === 6,
    );
    expect(parts.at(-1)!.status).toBe("connecting");
    await advance(10_000);
    await until(() => parts.at(-1)?.status === "connected");
    expect(
      parts.at(-1)!.state!.devices[castKey(byFile("speaker").id)],
    ).toMatchObject({ status: "disconnected", detail: "no status in 10 s" });
    stop.abort();
    await running;
  });

  test("an entry missing at start is looked for again at 1, 5 and 15 minutes; failed reconnects do not discover", async () => {
    const net = fakeNetwork();
    const { clock, advance } = manualClock();
    const parts: Part<CastSnapshot>[] = [];
    const stop = new AbortController();
    const speaker = byFile("speaker");
    let resolves = 0;
    let back = false;
    const resolve = async () => (
      resolves++,
      back ? devices : devices.filter((d) => d !== speaker)
    );
    const expect_ = [{ castId: speaker.id, name: speaker.name }];
    const running = cast({
      resolve,
      connect: net.connect,
      clock,
      expect: expect_,
      pingMs: 3_600_000,
    }).run(stop.signal, (p) => parts.push(p));
    await until(() => parts.at(-1)?.status === "connected");
    expect(resolves).toBe(1);
    await advance(60_000);
    expect(resolves).toBe(2);
    await advance(4 * 60_000);
    expect(resolves).toBe(2); // the next look is at 5 minutes after the last
    back = true;
    await advance(60_000);
    expect(resolves).toBe(3);
    await until(
      () =>
        parts.at(-1)?.state?.devices[castKey(speaker.id)]?.status ===
        "connected",
    );
    // An outage: the hub drops and its reconnects fail; one discovery for the drop, none per retry.
    net.down.add("hub");
    net.sockets.get("hub")!({ type: "CLOSE" }, NS.connection);
    await until(() => resolves === 4);
    for (let i = 0; i < 5; i++) await advance(2_000 * 2 ** i);
    expect(resolves).toBe(4);
    stop.abort();
    await running;
  });

  test("refresh discovers even when nothing was found at start", async () => {
    const net = fakeNetwork();
    let resolves = 0;
    const parts: Part<CastSnapshot>[] = [];
    const stop = new AbortController();
    const i = cast({
      resolve: async () => (resolves++ ? devices : []),
      connect: net.connect,
      clock: idle,
    });
    const running = i.run(stop.signal, (p) => parts.push(p));
    await until(() => parts.at(-1)?.detail === "no Cast devices found");
    i.refresh();
    await until(() => parts.at(-1)?.status === "connected");
    expect(Object.keys(parts.at(-1)!.state!.devices)).toHaveLength(7);
    stop.abort();
    await running;
  });
});

describe("castForm", () => {
  test("from the model name; a model it doesn't know has none", () => {
    expect(
      [
        "Google Nest Mini",
        "Google Home Speaker",
        "Google Home Max",
        "Google Nest Hub",
        "Google Nest Hub Max",
        "Pixel Tablet",
        "Chromecast Ultra",
        "Chromecast Audio",
        "Google TV Streamer",
        "Some Soundbar",
      ].map(castForm),
    ).toEqual([
      "speaker",
      "speaker",
      "speaker",
      "display",
      "display",
      "display",
      "tv",
      "speaker",
      "tv",
      undefined,
    ]);
    expect(castForm(undefined)).toBeUndefined();
  });
});

describe("castStatus and castFree", () => {
  const dev = (id: string, name: string, extra: Partial<CastDevice> = {}) =>
    ({
      id,
      name,
      kind: "device",
      status: "connected",
      idle: true,
      volume: 0.5,
      ...extra,
    }) as CastDevice;
  const spotifyOn = { idle: false, app: "Spotify", appId: "CC32E753" };
  const home = (over: Record<string, Partial<CastDevice>> = {}) => {
    const devices: Record<string, CastDevice> = {
      a: dev("a", "Kitchen", over.a),
      b: dev("b", "Bedroom", over.b),
      c: dev("c", "Front room", over.c),
      g: dev("g", "Everywhere", {
        kind: "group",
        members: ["a", "b", "c"],
        ...over.g,
      }),
    };
    return { devices, asOf: AT } as CastSnapshot;
  };
  const states = (s: CastSnapshot) =>
    Object.fromEntries(castStatus(s).map((c) => [c.name, c.state]));

  test("idle, the Default Media Receiver, another app, offline; devices first, each by name", () => {
    const s = home({
      a: { idle: false, app: "Default Media Receiver", appId: "CC1AD845" },
      b: { ...spotifyOn, playerState: "PAUSED", title: "Song", artist: "X" },
      c: { status: "disconnected" },
    });
    expect(castStatus(s).map((c) => c.name)).toEqual([
      "Bedroom",
      "Front room",
      "Kitchen",
      "Everywhere",
    ]);
    expect(states(s)).toEqual({
      Bedroom: "busy", // paused counts: an announce would end the app
      "Front room": "offline",
      Kitchen: "restorable",
      Everywhere: "busy", // as free as its least free connected member
    });
    expect(castStatus(s)[0]).toEqual({
      id: "b",
      name: "Bedroom",
      kind: "device",
      state: "busy",
      app: "Spotify",
      playerState: "PAUSED",
      title: "Song",
      artist: "X",
      volume: 0.5,
    });
  });

  test("a member playing its group's media is busy, via the group; a standby TV is idle and says so", () => {
    const s = home({
      a: { playerState: "PLAYING", playingVia: "g", standby: true },
      g: { ...spotifyOn, playerState: "PLAYING" },
    });
    expect(castStatus(s).find((c) => c.name === "Kitchen")).toMatchObject({
      state: "busy",
      via: "Everywhere",
      standby: true,
    });
    expect(
      castStatus(s)
        .at(-1)
        ?.members?.map((m) => m.name),
    ).toEqual(["Kitchen", "Bedroom", "Front room"]);
  });

  const dmr = {
    idle: false,
    app: "Default Media Receiver",
    appId: "CC1AD845",
  };

  test("castFree: a free group stays a group, and a member named beside it is not named twice; names in any case, and ids", () => {
    expect(castFree(home(), ["a", "everywhere"])).toEqual({
      free: ["Everywhere"],
      skipped: [],
    });
    expect(castFree(home(), ["b", "KITCHEN"]).free).toEqual([
      "Bedroom",
      "Kitchen",
    ]);
  });

  test("castFree: with forms, a TV is left out and a group holding one becomes its other members", () => {
    const s = home({
      a: { form: "display" },
      b: { form: "speaker" },
      c: { form: "tv" },
    });
    const forms = ["speaker", "display"] as const;
    expect(castFree(s, ["Everywhere"], { forms })).toEqual({
      free: ["Kitchen", "Bedroom"],
      skipped: [{ name: "Front room", why: "form" }],
    });
    // A group is skipped for its own reason, never for its form.
    expect(
      castFree(home({ g: spotifyOn }), ["Everywhere"], { forms }).skipped,
    ).toEqual([{ name: "Everywhere", why: "busy", app: "Spotify" }]);
    // A member the snapshot doesn't have may be a TV: the group becomes the members it knows.
    const missing = home({ a: { form: "speaker" }, b: { form: "speaker" } });
    delete missing.devices.c;
    expect(castFree(missing, ["Everywhere"], { forms }).free).toEqual([
      "Kitchen",
      "Bedroom",
    ]);
    expect(
      castFree(s, ["Front room", "Kitchen"], { forms: ["display"] }),
    ).toEqual({
      free: ["Kitchen"],
      skipped: [{ name: "Front room", why: "form" }],
    });
    // A model this library doesn't know has no form: with forms given it is left out.
    expect(
      castFree(home(), ["Kitchen"], { forms: ["speaker"] }).skipped,
    ).toEqual([{ name: "Kitchen", why: "form" }]);
    // Without forms, nothing changes: the group stays whole.
    expect(castFree(s, ["Everywhere"]).free).toEqual(["Everywhere"]);
  });

  test("castFreeSpeakers: every free speaker and display in one call, a whole group where it can, never a TV", () => {
    const all = { a: { form: "display" }, b: { form: "speaker" } } as const;
    expect(castFreeSpeakers(home({ ...all, c: { form: "speaker" } }))).toEqual({
      free: ["Everywhere"],
      skipped: [],
    });
    expect(castFreeSpeakers(home({ ...all, c: { form: "tv" } }))).toEqual({
      free: ["Bedroom", "Kitchen"],
      skipped: [{ name: "Front room", why: "form" }],
    });
    expect(
      castFreeSpeakers(
        home({
          ...all,
          b: { form: "speaker", ...spotifyOn },
          c: { form: "tv" },
        }),
      ),
    ).toEqual({
      free: ["Kitchen"],
      skipped: [
        { name: "Bedroom", why: "busy", app: "Spotify" },
        { name: "Front room", why: "form" },
      ],
    });
  });

  test("castFree: a group with a busy member becomes its free members, and says who was skipped", () => {
    const s = home({ b: spotifyOn, c: { standby: true } });
    expect(castFree(s, ["Everywhere", "Kitchen", "Hallway"])).toEqual({
      free: ["Kitchen"],
      skipped: [
        { name: "Bedroom", why: "busy", app: "Spotify" },
        { name: "Front room", why: "standby" },
        { name: "Hallway", why: "unknown" },
      ],
    });
  });

  test("castFree: an offline member doesn't split the group; a group whose own socket is down becomes its members", () => {
    expect(
      castFree(home({ c: { status: "disconnected" } }), ["Everywhere"]),
    ).toEqual({ free: ["Everywhere"], skipped: [] });
    expect(
      castFree(home({ g: { status: "disconnected" } }), ["Everywhere"]).free,
    ).toEqual(["Kitchen", "Bedroom", "Front room"]);
  });

  test("castFree: a group playing another app is skipped whole, whatever its members say", () => {
    const via = { playerState: "PLAYING", playingVia: "g" };
    const playing = home({ a: via, b: via, c: via, g: spotifyOn });
    const loaded = home({ g: spotifyOn }); // the app is up, no media status yet: the members still read idle
    for (const s of [playing, loaded])
      expect(castFree(s, ["Everywhere"])).toEqual({
        free: [],
        skipped: [{ name: "Everywhere", why: "busy", app: "Spotify" }],
      });
    expect(castStatus(playing).find((c) => c.name === "Kitchen")).toMatchObject(
      { state: "busy", via: "Everywhere", app: "Spotify" },
    );
  });

  test("castFree: a group playing the Default Media Receiver is restorable, members and all, and stays a group", () => {
    const via = { playerState: "PLAYING", playingVia: "g" };
    const s = home({ a: via, b: via, c: via, g: dmr });
    expect(states(s)).toEqual({
      Kitchen: "restorable",
      Bedroom: "restorable",
      "Front room": "restorable",
      Everywhere: "restorable",
    });
    expect(castFree(s, ["Everywhere"]).free).toEqual(["Everywhere"]);
    expect(castFree(home({ a: dmr }), ["Kitchen"]).free).toEqual(["Kitchen"]);
  });

  test("castFree: a device not heard from yet is offline, not idle; a group with no members known is judged by itself, never lost", () => {
    const s = home({ a: { idle: undefined }, g: { members: [] } });
    expect(castFree(s, ["Kitchen", "Everywhere"])).toEqual({
      free: ["Everywhere"],
      skipped: [{ name: "Kitchen", why: "offline" }],
    });
    const down = home({ g: { members: [], status: "disconnected" } });
    expect(castFree(down, ["Everywhere"])).toEqual({
      free: [],
      skipped: [{ name: "Everywhere", why: "offline" }],
    });
  });

  test("castFree: two groups that share a member: the second becomes its members not yet covered", () => {
    const s = home();
    s.devices.h = dev("h", "Downstairs", {
      kind: "group",
      members: ["a", "d"],
    });
    s.devices.d = dev("d", "Hall");
    expect(castFree(s, ["Everywhere", "Downstairs"]).free).toEqual([
      "Everywhere",
      "Hall",
    ]);
  });
});
