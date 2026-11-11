import { describe, expect, test } from "bun:test";
import {
  createHome,
  type Clock,
  type HomeSnapshot,
  type Integration,
  type Part,
} from "../src/index.ts";
import {
  groups,
  homeGroupedLightId,
  hue,
  hueClient,
  HueError,
  lights,
  colorToXy,
  HUE_BRIDGE_ROOT_CA,
  kelvinToMirek,
  pair,
  pairWhenPressed,
  scenes,
  xyToHex,
  type HueSnapshot,
} from "../src/connectors/hue/index.ts";
import { hueEvents, IDLE_MS, parseSse } from "../src/connectors/hue/events.ts";
import { reduce, snapshotFrom } from "../src/connectors/hue/state.ts";
import { Resource } from "../src/connectors/hue/schemas.ts";
import { manualClock } from "./clock.ts";

// Fixtures follow the shapes in openhue-api's spec and its event-stream example; ids are made up.
const resourcesJson = await Bun.file(
  new URL("./fixtures/resources.json", import.meta.url),
).text();
const streamText = await Bun.file(
  new URL("./fixtures/stream.txt", import.meta.url),
).text();

const streamOf = (text: string, chunk = text.length) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      const bytes = new TextEncoder().encode(text);
      for (let i = 0; i < bytes.length; i += chunk)
        c.enqueue(bytes.slice(i, i + chunk));
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
        ? new Promise((r) =>
            signal?.aborted
              ? r()
              : signal?.addEventListener("abort", () => r(), { once: true }),
          )
        : Promise.resolve(void (sleeps.push(ms), (t += ms))),
  };
  return { clock, sleeps };
};

const initial = () =>
  snapshotFrom(
    Resource.array().parse(JSON.parse(resourcesJson).data),
    "2026-02-06T02:00:00Z",
  );

describe("parseSse", () => {
  test("splits messages, keeps ids, skips comments", async () => {
    const messages = await collect(parseSse(streamOf(streamText)));
    expect(messages.map((m) => m.id)).toEqual(["1770343753:0", "1770343754:0"]);
    expect(JSON.parse(messages[0]!.data)[0].id).toBe("ev-1");
  });
  test("gives the same messages one byte at a time and with CRLF", async () => {
    const whole = await collect(parseSse(streamOf(streamText)));
    expect(await collect(parseSse(streamOf(streamText, 1)))).toEqual(whole);
    expect(
      await collect(parseSse(streamOf(streamText.replaceAll("\n", "\r\n"), 3))),
    ).toEqual(whole);
  });
});

describe("reduce and views", () => {
  test("the initial read gives rooms, zones, lights, reachability, scenes and the home group", () => {
    const s = initial();
    expect(groups(s)).toEqual([
      {
        id: "room-living",
        type: "room",
        name: "Living",
        groupedLightId: "gl-living",
        on: true,
        brightness: 60,
        lightIds: ["light-1", "light-2"],
      },
      {
        id: "zone-reading",
        type: "zone",
        name: "Reading",
        groupedLightId: undefined,
        on: undefined,
        brightness: undefined,
        lightIds: ["light-2"],
      },
    ]);
    expect(lights(s).map((l) => [l.id, l.on, l.reachable])).toEqual([
      ["light-1", true, true],
      ["light-2", false, false],
    ]);
    expect(homeGroupedLightId(s)).toBe("gl-home");
    expect(scenes(s)).toEqual([
      {
        id: "scene-relax",
        name: "Relax",
        groupId: "room-living",
        active: true,
      },
    ]);
  });

  test("events merge partial updates, delete, and leave the old snapshot alone", async () => {
    const before = initial();
    let s = before;
    for (const m of await collect(parseSse(streamOf(streamText))))
      for (const e of JSON.parse(m.data)) s = reduce(s, e);
    expect(lights(s)[0]!.on).toBe(false);
    expect(groups(s)[0]).toMatchObject({ on: true, brightness: 30 }); // `on` kept, brightness merged
    expect(scenes(s)).toEqual([]);
    expect(s.asOf).toBe(before.asOf); // asOf is set by the caller, from its own clock
    expect(lights(before)[0]!.on).toBe(true);
  });

  test("an unknown event type is ignored, not fatal", () => {
    const s = initial();
    expect(
      reduce(s, {
        id: "x",
        type: "rename",
        creationtime: "t",
        data: [{ id: "light-1", type: "light" }],
      }),
    ).toBe(s);
  });

  test("an error event is kept, not applied", () => {
    const e = {
      id: "x",
      type: "error" as const,
      creationtime: "t",
      data: [{ id: "light-1", type: "light" }],
    };
    const s = reduce(initial(), e);
    expect(s.lastError).toEqual(e);
    expect(s.resources["light-1"]).toEqual(initial().resources["light-1"]!);
  });
});

/** A fetch that records calls and answers from `respond`. */
const fakeFetch = (respond: (url: string, init?: RequestInit) => Response) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => (
    calls.push({ url, init }),
    respond(url, init)
  )) as unknown as typeof fetch;
  return { f, calls };
};

describe("client", () => {
  test("get sends the key and parses every resource", async () => {
    const { f, calls } = fakeFetch(() => new Response(resourcesJson));
    const all = await hueClient({
      host: "192.0.2.2",
      key: "k",
      fetch: f,
    }).get();
    expect(all).toHaveLength(11);
    expect(calls[0]!.url).toBe("https://192.0.2.2/clip/v2/resource");
    expect(
      (calls[0]!.init!.headers as Record<string, string>)[
        "hue-application-key"
      ],
    ).toBe("k");
  });

  test("bridge errors become a HueError with the bridge's words", async () => {
    const { f } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            errors: [{ description: 'device (light) is "soft off"' }],
            data: [],
          }),
          { status: 207 },
        ),
    );
    await expect(
      hueClient({ host: "h", key: "k", fetch: f }).put("light", "l", {
        on: { on: true },
      }),
    ).rejects.toThrow("soft off");
  });

  test("writes are spaced: grouped lights 1 s apart, lights 100 ms apart, lanes independent", async () => {
    const { clock, sleeps } = fakeClock();
    const at: [string, number][] = [];
    const { f } = fakeFetch(
      (url) => (
        at.push([url.split("/")[6]!, clock.now()]),
        new Response('{"errors":[],"data":[]}')
      ),
    );
    const c = hueClient({ host: "h", key: "k", fetch: f, clock });
    await Promise.all([
      c.put("grouped_light", "a", {}),
      c.put("grouped_light", "b", {}),
      c.recallScene("s"),
      c.put("light", "x", {}),
      c.put("light", "y", {}),
    ]);
    expect(at.filter(([k]) => k !== "light").map(([, t]) => t)).toEqual([
      0, 1000, 2000,
    ]);
    expect(
      at
        .filter(([k]) => k === "light")
        .map(([, t]) => t)
        .every((t, i, a) => i === 0 || t - a[i - 1]! >= 100),
    ).toBe(true);
    expect(sleeps.length).toBeGreaterThan(0);
  });
});

describe("pair", () => {
  test("returns the key and client key", async () => {
    const { f, calls } = fakeFetch(
      () => new Response('[{"success":{"username":"abc","clientkey":"DEF"}}]'),
    );
    expect(
      await pair({ host: "h", fetch: f, deviceType: "jaldi#mac" }),
    ).toEqual({ key: "abc", clientKey: "DEF" });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      devicetype: "jaldi#mac",
      generateclientkey: true,
    });
  });
  test("link button not pressed: one call, a typed error", async () => {
    const { f, calls } = fakeFetch(
      () =>
        new Response(
          '[{"error":{"type":101,"address":"","description":"link button not pressed"}}]',
        ),
    );
    const error = await pair({ host: "h", fetch: f, deviceType: "d" }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(HueError);
    expect(error.code).toBe("link_button");
    expect(calls).toHaveLength(1);
  });

  const notPressed = () =>
    new Response(
      '[{"error":{"type":101,"address":"","description":"link button not pressed"}}]',
    );
  test("pairWhenPressed asks every 2 s until the button is pressed, and says once that it is waiting", async () => {
    const { clock, sleeps } = fakeClock();
    let n = 0;
    const { f, calls } = fakeFetch(() =>
      n++ < 3
        ? notPressed()
        : new Response('[{"success":{"username":"key-1","clientkey":"ck"}}]'),
    );
    let waiting = 0;
    const got = await pairWhenPressed({
      host: "h",
      fetch: f,
      deviceType: "d",
      clock,
      onWaiting: () => waiting++,
    });
    expect(got).toEqual({ key: "key-1", clientKey: "ck" });
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([2000, 2000, 2000]);
    expect(waiting).toBe(1);
  });
  test("pairWhenPressed gives up after 30 s with the link_button error; another error ends it at once", async () => {
    const { clock, sleeps } = fakeClock();
    const never = fakeFetch(notPressed);
    const error = await pairWhenPressed({
      host: "h",
      fetch: never.f,
      deviceType: "d",
      clock,
    }).catch((e) => e);
    expect(error.code).toBe("link_button");
    expect(sleeps).toHaveLength(15);
    expect(never.calls).toHaveLength(16);

    const broken = fakeFetch(() => new Response("nope", { status: 500 }));
    const other = await pairWhenPressed({
      host: "h",
      fetch: broken.f,
      deviceType: "d",
      clock,
    }).catch((e) => e);
    expect(other).toBeInstanceOf(HueError);
    expect(other.code).toBeUndefined();
    expect(broken.calls).toHaveLength(1);
  });
  test("pairWhenPressed stops when aborted", async () => {
    const { clock } = fakeClock();
    const stop = new AbortController();
    const { f, calls } = fakeFetch(() => (stop.abort(), notPressed()));
    const error = await pairWhenPressed({
      host: "h",
      fetch: f,
      deviceType: "d",
      clock,
      signal: stop.signal,
    }).catch((e) => e);
    expect(error.name).toBe("AbortError");
    expect(calls).toHaveLength(1);
  });
});

describe("colour", () => {
  const C = {
    red: { x: 0.6915, y: 0.3083 },
    green: { x: 0.17, y: 0.7 },
    blue: { x: 0.1532, y: 0.0475 },
  };
  test("hex and rgb to xy: white is D65, and the forms agree", () => {
    expect(colorToXy("#ffffff")).toEqual({ x: 0.3127, y: 0.329 });
    expect(colorToXy("fff")).toEqual(colorToXy({ r: 255, g: 255, b: 255 }));
    expect(colorToXy("#ff0000")).toEqual({ x: 0.6401, y: 0.33 }); // sRGB red, inside gamut C
    expect(colorToXy("#800000")).toEqual(colorToXy("#ff0000")); // brightness is not part of a colour
  });
  test("a colour the light can't show moves to the nearest point of its gamut", () => {
    const green = colorToXy("#00ff00"); // sRGB green (0.3, 0.6)
    expect(colorToXy("#00ff00", C)).toEqual(green); // gamut C holds it
    const small = { ...C, green: { x: 0.409, y: 0.518 } }; // the older bulb's
    const moved = colorToXy("#00ff00", small);
    expect(moved).not.toEqual(green);
    expect(moved.x).toBeGreaterThan(0.3);
    expect(moved.y).toBeLessThan(0.6);
  });
  test("what is not a colour throws: black, a word, a value off 0–255", () => {
    expect(() => colorToXy("#000000")).toThrow("black");
    expect(() => colorToXy("warm")).toThrow("not a colour");
    expect(() => colorToXy({ r: 300, g: 0, b: 0 })).toThrow("0–255");
  });
  test("xy back to a hex for a screen, and kelvin to mirek", () => {
    expect(xyToHex({ x: 0.3127, y: 0.329 })).toBe("#ffffff");
    expect(xyToHex({ x: 0.64, y: 0.33 })).toBe("#ff0000");
    expect(kelvinToMirek(2700)).toBe(370);
  });
});

describe("light, room and scene by name", () => {
  /** A bridge that applies each PUT to its resources and reports it on the next read; `deaf` accepts writes and changes nothing. */
  const fakeBridge = (deaf = false) => {
    const data = structuredClone(JSON.parse(resourcesJson).data) as any[];
    const one = (id: string) => data.find((r) => r.id === id);
    Object.assign(one("light-1"), {
      color: { xy: { x: 0.4, y: 0.4 }, gamut: C_GAMUT },
      color_temperature: {
        mirek: null,
        mirek_schema: { mirek_minimum: 153, mirek_maximum: 500 },
      },
    });
    one("light-2").color_temperature = {
      mirek: 366,
      mirek_schema: { mirek_minimum: 153, mirek_maximum: 454 },
    };
    one("scene-relax").status = { active: "inactive" };
    const puts: { path: string; body: any }[] = [];
    const { f } = fakeFetch((url, init) => {
      if (init?.method !== "PUT")
        return new Response(JSON.stringify({ errors: [], data }));
      const path = url.split("/resource/")[1]!;
      const body = JSON.parse(init.body as string);
      puts.push({ path, body });
      const r = one(path.split("/")[1]!);
      if (!deaf) {
        if (body.recall) r.status = { active: "static" };
        else
          for (const [k, v] of Object.entries(body))
            r[k] = { ...r[k], ...(v as object) };
      }
      return new Response(JSON.stringify({ errors: [], data: [] }));
    });
    const { clock } = fakeClock();
    return {
      c: hueClient({ host: "h", key: "k", fetch: f, clock }),
      puts,
      add: (r: object) => void data.push(r),
    };
  };
  const C_GAMUT = {
    red: { x: 0.6915, y: 0.3083 },
    green: { x: 0.17, y: 0.7 },
    blue: { x: 0.1532, y: 0.0475 },
  };

  test("a light by name: only what was asked is sent, and it resolves with what the bridge then reported", async () => {
    const b = fakeBridge();
    // Floor lamp is on at 60: brightness alone, no `on` (Signify: one Zigbee message per field).
    expect(await b.c.light("floor lamp", { brightness: 30 })).toMatchObject({
      confirmed: true,
      state: { id: "light-1", on: true, brightness: 30 },
    });
    // Shelf is off: a change turns it on.
    expect(
      await b.c.light("Shelf", { kelvin: 2700, transitionMs: 0 }),
    ).toMatchObject({ confirmed: true, state: { on: true, kelvin: 2703 } });
    expect(b.puts).toEqual([
      { path: "light/light-1", body: { dimming: { brightness: 30 } } },
      {
        path: "light/light-2",
        body: {
          on: { on: true },
          color_temperature: { mirek: 370 },
          dynamics: { duration: 0 },
        },
      },
    ]);
  });

  test("a colour goes out as xy inside the light's gamut; off is one field", async () => {
    const b = fakeBridge();
    const lit = await b.c.light("light-1", { color: "#ff0000" });
    expect(lit.state.xy).toEqual({ x: 0.6401, y: 0.33 });
    expect(lit.state.hex).toBe("#ff0000");
    await b.c.light("Floor lamp", { on: false });
    expect(b.puts.map((p) => p.body)).toEqual([
      { color: { xy: { x: 0.6401, y: 0.33 } } },
      { on: { on: false } },
    ]);
  });

  test("a room is one write to its grouped light, always with on", async () => {
    const b = fakeBridge();
    expect(await b.c.room("living", { brightness: 40 })).toMatchObject({
      confirmed: true,
      state: { id: "room-living", on: true, brightness: 40 },
    });
    expect(b.puts).toEqual([
      {
        path: "grouped_light/gl-living",
        body: { on: { on: true }, dimming: { brightness: 40 } },
      },
    ]);
  });

  test("what can't be done throws before anything is sent, saying what exists", async () => {
    const b = fakeBridge();
    const why = (p: Promise<unknown>) =>
      p.catch((e) => `${e.code}: ${e.message}`);
    expect(await why(b.c.light("Lamp", { on: true }))).toBe(
      'invalid: no light "Lamp"; have: Floor lamp, Shelf',
    );
    expect(await why(b.c.room("Attic", { on: true }))).toBe(
      'invalid: no room or zone "Attic"; have: Living, Reading',
    );
    expect(await why(b.c.light("Shelf", { color: "#ff0000" }))).toBe(
      "invalid: Shelf has no colour light",
    );
    expect(await why(b.c.light("Shelf", { kelvin: 2000 }))).toBe(
      "invalid: 2000 K is outside Shelf's range, 2203–6536 K",
    );
    expect(await why(b.c.light("Shelf", { brightness: 0 }))).toContain("1–100");
    expect(
      await why(b.c.light("Shelf", { on: false, brightness: 5 })),
    ).toContain("off takes no");
    expect(
      await why(b.c.light("Floor lamp", { color: "#fff", kelvin: 3000 })),
    ).toContain("not both");
    expect(await why(b.c.light("Shelf", {}))).toContain("nothing to change");
    expect(await why(b.c.room("Reading", { on: true }))).toContain("no lights");
    expect(b.puts).toEqual([]);
  });

  test("a scene by name, confirmed once the bridge says it is active; a miss names each scene's room", async () => {
    const b = fakeBridge();
    expect(await b.c.scene("relax")).toMatchObject({
      confirmed: true,
      state: { id: "room-living" },
    });
    expect(await b.c.scene("Relax", "Living")).toMatchObject({
      confirmed: true,
    });
    expect(b.puts[0]).toEqual({
      path: "scene/scene-relax",
      body: { recall: { action: "active" } },
    });
    expect(await b.c.scene("Party").catch((e) => e.message)).toBe(
      'no scene "Party"; have: Relax in Living',
    );
    expect(await b.c.scene("Relax", "Reading").catch((e) => e.message)).toBe(
      'no scene "Relax"; have: none',
    );
  });

  test("a bridge that accepts the write and never shows it: unconfirmed, with the light as it stands", async () => {
    const b = fakeBridge(true);
    expect(await b.c.light("Shelf", { on: true })).toMatchObject({
      confirmed: false,
      state: { on: false },
    });
  });

  test("a colour or a temperature that never shows is unconfirmed too, on a light already on", async () => {
    const b = fakeBridge(true);
    expect(
      (await b.c.light("Floor lamp", { color: "#ff0000" })).confirmed,
    ).toBe(false);
    expect((await b.c.light("Floor lamp", { kelvin: 3000 })).confirmed).toBe(
      false,
    );
    const ok = fakeBridge();
    expect(
      (await ok.c.light("Floor lamp", { color: "#ff0000" })).confirmed,
    ).toBe(true);
    expect((await ok.c.light("Floor lamp", { kelvin: 3000 })).confirmed).toBe(
      true,
    );
  });

  test("a scene name two rooms use needs the room; a room takes the widest range and the first gamut of its lights", async () => {
    const b = fakeBridge();
    b.add({
      id: "scene-relax-2",
      type: "scene",
      metadata: { name: "Relax" },
      group: { rid: "zone-reading", rtype: "zone" },
      status: { active: "inactive" },
    });
    expect(await b.c.scene("Relax").catch((e) => e.message)).toBe(
      '"Relax" names 2: Relax in Living (scene-relax), Relax in Reading (scene-relax-2)',
    );
    await b.c.scene("Relax", "reading");
    expect(b.puts.at(-1)!.path).toBe("scene/scene-relax-2");
    // Living holds a colour light (to 2000 K) and a white one (to 2203 K): 2000 K is in the room's range, and a colour goes out.
    await b.c.room("Living", { kelvin: 2000 });
    await b.c.room("Living", { color: "#00f" });
    expect(b.puts.slice(-2).map((p) => Object.keys(p.body))).toEqual([
      ["on", "color_temperature"],
      ["on", "color"],
    ]);
    expect(
      await b.c.room("Living", { kelvin: 1500 }).catch((e) => e.message),
    ).toBe("1500 K is outside Living's range, 2000–6536 K");
  });
});

describe("Signify's roots", () => {
  // The bytes other projects ship (openHAB, hb-hue-tools, openhue-go, Raycast); the first verified against KO's bridge, 2026-11-11.
  test("the package carries exactly the two, by fingerprint", async () => {
    const ders = [
      ...HUE_BRIDGE_ROOT_CA.matchAll(
        /-----BEGIN CERTIFICATE-----([^-]+)-----END CERTIFICATE-----/g,
      ),
    ].map((m) =>
      Uint8Array.from(atob(m[1]!.replace(/\s/g, "")), (c) => c.charCodeAt(0)),
    );
    const prints = await Promise.all(
      ders.map(async (d) =>
        Buffer.from(await crypto.subtle.digest("SHA-256", d)).toString("hex"),
      ),
    );
    expect(prints).toEqual([
      "f0bd8e6509e82f774d63bc009d5388c969fe3dcf7d6d541d6351b72b898d8acf", // CN=root-bridge, to 2038
      "d8b89448b2af8e1676185ac07219ee9dcbc8f01c122a026a2a4b7b5cfe0328b8", // CN=Hue Root CA 01, to 2050
    ]);
  });
});

describe("event stream", () => {
  test("connects, yields events, reconnects with backoff after a drop", async () => {
    const { clock, sleeps } = fakeClock();
    let n = 0;
    const { f, calls } = fakeFetch(() =>
      n++ === 1
        ? new Response("nope", { status: 503 })
        : new Response(streamOf(streamText)),
    );
    const items = await collect(
      hueEvents({ host: "h", key: "k", fetch: f, clock }),
      7,
    );
    expect(items.map((i) => i.kind)).toEqual([
      "connected",
      "events",
      "events",
      "disconnected",
      "disconnected",
      "connected",
      "events",
    ]);
    expect(sleeps).toEqual([1000, 5000]); // the stream ending, then the 503
    expect((calls[0]!.init!.headers as Record<string, string>).accept).toBe(
      "text/event-stream",
    );
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
    const quiet = () =>
      new ReadableStream<Uint8Array>({
        start: (c) => c.enqueue(new TextEncoder().encode(": hi\n\n")),
      }); // one comment, then nothing
    let push!: (text: string) => void;
    let n = 0;
    const { f, calls } = fakeFetch(() => {
      if (++n === 2)
        return new Response(
          new ReadableStream<Uint8Array>({
            start: (c) =>
              void (push = (text) => c.enqueue(new TextEncoder().encode(text))),
          }),
        );
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
    const failed = (await after).value as {
      kind: string;
      error: unknown;
      retryInMs: number;
    };
    expect(failed.kind).toBe("disconnected");
    expect(String(failed.error)).toContain("no route");
    expect(failed.retryInMs).toBe(1000);
    await it.return(undefined);
  });

  test("a rejected key stops the stream instead of retrying", async () => {
    const { f, calls } = fakeFetch(() => new Response("", { status: 403 }));
    const error = await collect(
      hueEvents({ host: "h", key: "k", fetch: f }),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(HueError);
    expect(calls).toHaveLength(1);
  });

  test("an already-aborted signal makes no request", async () => {
    const { f, calls } = fakeFetch(() => new Response(streamOf(streamText)));
    expect(
      await collect(
        hueEvents({
          host: "h",
          key: "k",
          fetch: f,
          signal: AbortSignal.abort(),
        }),
      ),
    ).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("recallScene works when pulled off the client", async () => {
    const { f, calls } = fakeFetch(
      () => new Response('{"errors":[],"data":[]}'),
    );
    const { recallScene } = hueClient({ host: "h", key: "k", fetch: f });
    await recallScene("s");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      recall: { action: "active" },
    });
  });
});

describe("home", () => {
  test("a rejected key marks hue unavailable and stops", async () => {
    const { f } = fakeFetch(() => new Response("", { status: 403 }));
    const home = createHome([
      hue({ host: "h", bridgeId: "b", key: "k", ca: "", fetch: f }),
    ]);
    await home.start(new AbortController().signal);
    expect(home.snapshot().hue).toMatchObject({
      status: "unavailable",
      reason: "auth",
      detail: "the bridge rejected the key; pair again",
    });
  });

  test("a bridge that stops answering is found again by bridgeId after three failed reconnects, and followed", async () => {
    const { clock } = fakeClock();
    const f = (async (url: string) => {
      if (url.includes("192.0.2.2/")) throw new Error("no route");
      return url.endsWith("/resource")
        ? new Response(resourcesJson)
        : new Response(streamOf(streamText));
    }) as unknown as typeof fetch;
    let scans = 0;
    const find = async () => (
      scans++,
      [
        {
          connector: "hue" as const,
          id: "001788FFFE000000",
          host: "192.0.2.44",
        },
      ]
    );
    const parts: Part[] = [];
    const stop = new AbortController();
    const h = hue({
      host: "192.0.2.2",
      bridgeId: "001788fffe000000",
      key: "k",
      ca: "",
      fetch: f,
      clock,
      find,
    });
    await h.run(
      stop.signal,
      (p) => (parts.push(p), p.status === "connected" && stop.abort()),
    );
    expect(
      parts
        .slice(0, parts.findIndex((p) => p.status === "connected") + 1)
        .map((p) => p.detail),
    ).toEqual(["no route", "no route", "moved from 192.0.2.2 to 192.0.2.44"]); // the move is reported by the connection at the new address
    expect(parts.at(-1)!.status).toBe("connected");
    expect(scans).toBe(1);
  });

  test("a refresh after a move keeps saying where it moved", async () => {
    const { clock } = fakeClock();
    let gets = 0;
    const f = (async (url: string) => {
      if (url.includes("192.0.2.2/")) throw new Error("no route");
      if (url.endsWith("/resource"))
        return (gets++, new Response(resourcesJson));
      return new Response(new ReadableStream()); // a stream that stays open and quiet
    }) as unknown as typeof fetch;
    const find = async () => [
      { connector: "hue" as const, id: "001788FFFE000000", host: "192.0.2.44" },
    ];
    const stop = new AbortController();
    const h = hue({
      host: "192.0.2.2",
      bridgeId: "001788fffe000000",
      key: "k",
      ca: "",
      fetch: f,
      clock,
      find,
    });
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

  test("a refresh while the bridge is unreachable answers with the last report, not after the backoff", async () => {
    const stuck: Clock = {
      now: () => 0,
      sleep: (_ms, signal) =>
        new Promise((r) =>
          signal?.addEventListener("abort", () => r(), { once: true }),
        ),
    };
    const f = (async () =>
      Promise.reject(new Error("no route"))) as unknown as typeof fetch;
    const home = createHome([
      hue({
        host: "h",
        bridgeId: "b",
        key: "k",
        ca: "",
        fetch: f,
        clock: stuck,
      }),
    ]);
    const stop = new AbortController();
    const running = home.start(stop.signal);
    while (home.part("hue")?.status !== "disconnected") await Bun.sleep(1);
    await home.refresh("hue"); // the backoff sleep never ends on this clock
    expect(home.part("hue")).toMatchObject({ status: "disconnected" });
    stop.abort();
    await running;
  });

  test("a refresh re-applies the events that arrived while its GET was in flight", async () => {
    const { clock } = fakeClock();
    let push!: (text: string) => void;
    const stream = new ReadableStream<Uint8Array>({
      start: (c) =>
        void (push = (text) => c.enqueue(new TextEncoder().encode(text))),
    });
    let gets = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const f = (async (url: string) => {
      if (!url.endsWith("/resource")) return new Response(stream);
      if (gets++ > 0) await held; // the refresh's GET waits until the test lets it go
      return new Response(resourcesJson);
    }) as unknown as typeof fetch;
    const h = hue({
      host: "h",
      bridgeId: "b",
      key: "k",
      ca: "",
      fetch: f,
      clock,
    });
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
    const { f } = fakeFetch((url) =>
      url.endsWith("/resource")
        ? new Response(resourcesJson)
        : new Response(streamOf(streamText)),
    );
    const broken: Integration = {
      name: "daikin",
      refresh: () => {},
      run: async () => {
        throw new Error("no controller");
      },
    };
    const stop = new AbortController();
    const seen: HomeSnapshot[] = [];
    const home = createHome(
      [
        hue({ host: "h", bridgeId: "b", key: "k", ca: "", fetch: f, clock }),
        broken,
      ],
      (s) => {
        seen.push(s);
        if (seen.length === 4) stop.abort();
      },
    );
    await home.start(stop.signal);
    const now = home.snapshot();
    expect(now.daikin).toMatchObject({
      status: "unavailable",
      detail: "no controller",
    });
    expect(now.hue!.status).toBe("connected");
    const s = now.hue!.state as HueSnapshot;
    expect(lights(s)[0]!.on).toBe(false);
    expect(s.lastEventId).toBe("1770343754:0");
  });
});
