import { describe, expect, test } from "bun:test";
import { createHome, type Clock, type HomeSnapshot, type Integration, type Part } from "../src/index.ts";
import { groups, homeGroupedLightId, hue, hueClient, HueError, lights, pair, scenes, type HueSnapshot } from "../src/connectors/hue/index.ts";
import { hueEvents, IDLE_MS, parseSse } from "../src/connectors/hue/events.ts";
import { reduce, snapshotFrom } from "../src/connectors/hue/state.ts";
import { Resource } from "../src/connectors/hue/schemas.ts";
import { manualClock } from "./clock.ts";

// Fixtures follow the shapes in openhue-api's spec and its event-stream example; ids are made up.
const resourcesJson = await Bun.file(new URL("./fixtures/resources.json", import.meta.url)).text();
const streamText = await Bun.file(new URL("./fixtures/stream.txt", import.meta.url)).text();

const streamOf = (text: string, chunk = text.length) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      const bytes = new TextEncoder().encode(text);
      for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk));
      c.close();
    },
  });

const collect = async <T>(it: AsyncIterable<T>, max = Infinity) => {
  const out: T[] = [];
  for await (const x of it) if (out.push(x) >= max) break;
  return out;
};

/**
 * A clock that never waits: sleep moves time forward and records the wait. The event stream's watchdog wait (`IDLE_MS`)
 * is the exception: it ends only on abort, since these tests are not about silence (the watchdog's own use `manualClock`).
 */
const fakeClock = () => {
  let t = 0;
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => t,
    sleep: (ms, signal) =>
      ms === IDLE_MS
        ? new Promise((r) => (signal?.aborted ? r() : signal?.addEventListener("abort", () => r(), { once: true })))
        : Promise.resolve(void (sleeps.push(ms), (t += ms))),
  };
  return { clock, sleeps };
};

const initial = () => snapshotFrom(Resource.array().parse(JSON.parse(resourcesJson).data), "2026-02-06T02:00:00Z");

describe("parseSse", () => {
  test("splits messages, keeps ids, skips comments", async () => {
    const messages = await collect(parseSse(streamOf(streamText)));
    expect(messages.map((m) => m.id)).toEqual(["1770343753:0", "1770343754:0"]);
    expect(JSON.parse(messages[0]!.data)[0].id).toBe("ev-1");
  });
  test("gives the same messages one byte at a time and with CRLF", async () => {
    const whole = await collect(parseSse(streamOf(streamText)));
    expect(await collect(parseSse(streamOf(streamText, 1)))).toEqual(whole);
    expect(await collect(parseSse(streamOf(streamText.replaceAll("\n", "\r\n"), 3)))).toEqual(whole);
  });
});

describe("reduce and views", () => {
  test("the initial read gives rooms, zones, lights, reachability, scenes and the home group", () => {
    const s = initial();
    expect(groups(s)).toEqual([
      { id: "room-living", type: "room", name: "Living", groupedLightId: "gl-living", on: true, brightness: 60, lightIds: ["light-1", "light-2"] },
      { id: "zone-reading", type: "zone", name: "Reading", groupedLightId: undefined, on: undefined, brightness: undefined, lightIds: ["light-2"] },
    ]);
    expect(lights(s).map((l) => [l.id, l.on, l.reachable])).toEqual([["light-1", true, true], ["light-2", false, false]]);
    expect(homeGroupedLightId(s)).toBe("gl-home");
    expect(scenes(s)).toEqual([{ id: "scene-relax", name: "Relax", groupId: "room-living", active: true }]);
  });

  test("events merge partial updates, delete, and leave the old snapshot alone", async () => {
    const before = initial();
    let s = before;
    for (const m of await collect(parseSse(streamOf(streamText)))) for (const e of JSON.parse(m.data)) s = reduce(s, e);
    expect(lights(s)[0]!.on).toBe(false);
    expect(groups(s)[0]).toMatchObject({ on: true, brightness: 30 }); // `on` kept, brightness merged
    expect(scenes(s)).toEqual([]);
    expect(s.asOf).toBe(before.asOf); // asOf is set by the caller, from its own clock
    expect(lights(before)[0]!.on).toBe(true);
  });

  test("an unknown event type is ignored, not fatal", () => {
    const s = initial();
    expect(reduce(s, { id: "x", type: "rename", creationtime: "t", data: [{ id: "light-1", type: "light" }] })).toBe(s);
  });

  test("an error event is kept, not applied", () => {
    const e = { id: "x", type: "error" as const, creationtime: "t", data: [{ id: "light-1", type: "light" }] };
    const s = reduce(initial(), e);
    expect(s.lastError).toEqual(e);
    expect(s.resources["light-1"]).toEqual(initial().resources["light-1"]!);
  });
});

/** A fetch that records calls and answers from `respond`. */
const fakeFetch = (respond: (url: string, init?: RequestInit) => Response) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => (calls.push({ url, init }), respond(url, init))) as unknown as typeof fetch;
  return { f, calls };
};

describe("client", () => {
  test("get sends the key and parses every resource", async () => {
    const { f, calls } = fakeFetch(() => new Response(resourcesJson));
    const all = await hueClient({ host: "192.0.2.2", key: "k", fetch: f }).get();
    expect(all).toHaveLength(11);
    expect(calls[0]!.url).toBe("https://192.0.2.2/clip/v2/resource");
    expect((calls[0]!.init!.headers as Record<string, string>)["hue-application-key"]).toBe("k");
  });

  test("bridge errors become a HueError with the bridge's words", async () => {
    const { f } = fakeFetch(() => new Response(JSON.stringify({ errors: [{ description: "device (light) is \"soft off\"" }], data: [] }), { status: 207 }));
    await expect(hueClient({ host: "h", key: "k", fetch: f }).put("light", "l", { on: { on: true } })).rejects.toThrow("soft off");
  });

  test("writes are spaced: grouped lights 1 s apart, lights 100 ms apart, lanes independent", async () => {
    const { clock, sleeps } = fakeClock();
    const at: [string, number][] = [];
    const { f } = fakeFetch((url) => (at.push([url.split("/")[6]!, clock.now()]), new Response('{"errors":[],"data":[]}')));
    const c = hueClient({ host: "h", key: "k", fetch: f, clock });
    await Promise.all([c.put("grouped_light", "a", {}), c.put("grouped_light", "b", {}), c.recallScene("s"), c.put("light", "x", {}), c.put("light", "y", {})]);
    expect(at.filter(([k]) => k !== "light").map(([, t]) => t)).toEqual([0, 1000, 2000]);
    expect(at.filter(([k]) => k === "light").map(([, t]) => t).every((t, i, a) => i === 0 || t - a[i - 1]! >= 100)).toBe(true);
    expect(sleeps.length).toBeGreaterThan(0);
  });
});

describe("pair", () => {
  test("returns the key and client key", async () => {
    const { f, calls } = fakeFetch(() => new Response('[{"success":{"username":"abc","clientkey":"DEF"}}]'));
    expect(await pair({ host: "h", fetch: f, deviceType: "jaldi#mac" })).toEqual({ key: "abc", clientKey: "DEF" });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ devicetype: "jaldi#mac", generateclientkey: true });
  });
  test("link button not pressed: one call, a typed error", async () => {
    const { f, calls } = fakeFetch(() => new Response('[{"error":{"type":101,"address":"","description":"link button not pressed"}}]'));
    const error = await pair({ host: "h", fetch: f, deviceType: "d" }).catch((e) => e);
    expect(error).toBeInstanceOf(HueError);
    expect(error.code).toBe("link_button");
    expect(calls).toHaveLength(1);
  });
});

describe("event stream", () => {
  test("connects, yields events, reconnects with backoff after a drop", async () => {
    const { clock, sleeps } = fakeClock();
    let n = 0;
    const { f, calls } = fakeFetch(() => (n++ === 1 ? new Response("nope", { status: 503 }) : new Response(streamOf(streamText))));
    const items = await collect(hueEvents({ host: "h", key: "k", fetch: f, clock }), 7);
    expect(items.map((i) => i.kind)).toEqual(["connected", "events", "events", "disconnected", "disconnected", "connected", "events"]);
    expect(sleeps).toEqual([1000, 5000]); // the stream ending, then the 503
    expect((calls[0]!.init!.headers as Record<string, string>).accept).toBe("text/event-stream");
  });
});

describe("event stream failures", () => {
  test("a bridge that accepts and closes at once still backs off", async () => {
    const { clock, sleeps } = fakeClock();
    const { f } = fakeFetch(() => new Response(streamOf("")));
    await collect(hueEvents({ host: "h", key: "k", fetch: f, clock }), 8);
    expect(sleeps).toEqual([1000, 5000, 15000]);
  });

  test("a quiet connection is probed with a silent reconnect on the clock; any bytes re-arm it; only a failed probe is reported", async () => {
    const { clock, advance } = manualClock();
    const quiet = () => new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new TextEncoder().encode(": hi\n\n")) }); // one comment, then nothing
    let push!: (text: string) => void;
    let n = 0;
    const { f, calls } = fakeFetch(() => {
      if (++n === 2) return new Response(new ReadableStream<Uint8Array>({ start: (c) => void (push = (text) => c.enqueue(new TextEncoder().encode(text))) }));
      if (n >= 3) throw new Error("no route");
      return new Response(quiet());
    });
    const it = hueEvents({ host: "h", key: "k", fetch: f, clock });
    expect((await it.next()).value).toEqual({ kind: "connected" });
    const next = it.next();
    await advance(IDLE_MS); // 90 s with nothing: a fresh connection, no "disconnected"
    expect((await next).value).toEqual({ kind: "connected" });
    expect(calls).toHaveLength(2);
    const after = it.next();
    await advance(IDLE_MS - 1000);
    push(": still here\n\n"); // any bytes re-arm it
    await Bun.sleep(5);
    await advance(IDLE_MS - 1000);
    expect(calls).toHaveLength(2);
    await advance(1000); // now quiet for 90 s: the probe fails, and that is reported, at the first backoff step
    const failed = (await after).value as { kind: string; error: unknown; retryInMs: number };
    expect(failed.kind).toBe("disconnected");
    expect(String(failed.error)).toContain("no route");
    expect(failed.retryInMs).toBe(1000);
    await it.return(undefined);
  });

  test("a rejected key stops the stream instead of retrying", async () => {
    const { f, calls } = fakeFetch(() => new Response("", { status: 403 }));
    const error = await collect(hueEvents({ host: "h", key: "k", fetch: f })).catch((e) => e);
    expect(error).toBeInstanceOf(HueError);
    expect(calls).toHaveLength(1);
  });

  test("an already-aborted signal makes no request", async () => {
    const { f, calls } = fakeFetch(() => new Response(streamOf(streamText)));
    expect(await collect(hueEvents({ host: "h", key: "k", fetch: f, signal: AbortSignal.abort() }))).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("recallScene works when pulled off the client", async () => {
    const { f, calls } = fakeFetch(() => new Response('{"errors":[],"data":[]}'));
    const { recallScene } = hueClient({ host: "h", key: "k", fetch: f });
    await recallScene("s");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ recall: { action: "active" } });
  });
});

describe("home", () => {
  test("a rejected key marks hue unavailable and stops", async () => {
    const { f } = fakeFetch(() => new Response("", { status: 403 }));
    const home = createHome([hue({ host: "h", bridgeId: "b", key: "k", ca: "", fetch: f })]);
    await home.start(new AbortController().signal);
    expect(home.snapshot().hue).toMatchObject({ status: "unavailable", detail: "the bridge rejected the key; pair again" });
  });

  test("a bridge that stops answering is found again by bridgeId after three failed reconnects, and followed", async () => {
    const { clock } = fakeClock();
    const f = (async (url: string) => {
      if (url.includes("192.0.2.2/")) throw new Error("no route");
      return url.endsWith("/resource") ? new Response(resourcesJson) : new Response(streamOf(streamText));
    }) as unknown as typeof fetch;
    let scans = 0;
    const find = async () => (scans++, [{ connector: "hue" as const, id: "001788FFFE000000", host: "192.0.2.44" }]);
    const parts: Part[] = [];
    const stop = new AbortController();
    const h = hue({ host: "192.0.2.2", bridgeId: "001788fffe000000", key: "k", ca: "", fetch: f, clock, find });
    await h.run(stop.signal, (p) => (parts.push(p), p.status === "connected" && stop.abort()));
    expect(parts.slice(0, parts.findIndex((p) => p.status === "connected") + 1).map((p) => p.detail)).toEqual(["no route", "no route", "moved from 192.0.2.2 to 192.0.2.44", "moved from 192.0.2.2 to 192.0.2.44"]);
    expect(parts.at(-1)!.status).toBe("connected");
    expect(scans).toBe(1);
  });

  test("a refresh after a move keeps saying where it moved", async () => {
    const { clock } = fakeClock();
    let gets = 0;
    const f = (async (url: string) => {
      if (url.includes("192.0.2.2/")) throw new Error("no route");
      if (url.endsWith("/resource")) return (gets++, new Response(resourcesJson));
      return new Response(new ReadableStream()); // a stream that stays open and quiet
    }) as unknown as typeof fetch;
    const find = async () => [{ connector: "hue" as const, id: "001788FFFE000000", host: "192.0.2.44" }];
    const stop = new AbortController();
    const h = hue({ host: "192.0.2.2", bridgeId: "001788fffe000000", key: "k", ca: "", fetch: f, clock, find });
    const fromRefresh = await new Promise<Part>((resolve) => {
      void h.run(stop.signal, (p) => {
        if (p.status !== "connected") return;
        if (gets === 1) h.refresh();
        else resolve(p);
      });
    });
    stop.abort();
    expect(gets).toBe(2);
    expect(fromRefresh.detail).toBe("moved from 192.0.2.2 to 192.0.2.44");
  });

  test("a refresh re-applies the events that arrived while its GET was in flight", async () => {
    const { clock } = fakeClock();
    let push!: (text: string) => void;
    const stream = new ReadableStream<Uint8Array>({ start: (c) => void (push = (text) => c.enqueue(new TextEncoder().encode(text))) });
    let gets = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const f = (async (url: string) => {
      if (!url.endsWith("/resource")) return new Response(stream);
      if (gets++ > 0) await held; // the refresh's GET waits until the test lets it go
      return new Response(resourcesJson);
    }) as unknown as typeof fetch;
    const h = hue({ host: "h", bridgeId: "b", key: "k", ca: "", fetch: f, clock });
    const parts: Part[] = [];
    const stop = new AbortController();
    void h.run(stop.signal, (p) => parts.push(p));
    const until = async (n: number) => {
      while (parts.length < n) await Bun.sleep(1);
    };
    push(": hi\n\n");
    await until(1);
    expect(lights(parts[0]!.state as HueSnapshot)[0]!.on).toBe(true);
    h.refresh();
    push(`${streamText.split("\n\n")[1]}\n\n`); // light-1 turns off while the GET is out
    await until(2);
    release();
    await until(3);
    expect(gets).toBe(2);
    expect(lights(parts[2]!.state as HueSnapshot)[0]!.on).toBe(false);
    stop.abort();
  });

  test("hue loads on connect, patches from events, and reports per integration", async () => {
    const { clock } = fakeClock();
    const { f } = fakeFetch((url) => (url.endsWith("/resource") ? new Response(resourcesJson) : new Response(streamOf(streamText))));
    const broken: Integration = { name: "daikin", refresh: () => {}, run: async () => { throw new Error("no controller"); } };
    const stop = new AbortController();
    const seen: HomeSnapshot[] = [];
    const home = createHome([hue({ host: "h", bridgeId: "b", key: "k", ca: "", fetch: f, clock }), broken], (s) => {
      seen.push(s);
      if (seen.length === 4) stop.abort();
    });
    await home.start(stop.signal);
    const now = home.snapshot();
    expect(now.daikin).toEqual({ status: "unavailable", detail: "Error: no controller" });
    expect(now.hue!.status).toBe("connected");
    const s = now.hue!.state as HueSnapshot;
    expect(lights(s)[0]!.on).toBe(false);
    expect(s.lastEventId).toBe("1770343754:0");
  });
});
