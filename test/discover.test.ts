import { describe, expect, test } from "bun:test";
import { type Clock, createHome } from "../src/index.ts";
import { checkPlan, type HomeConfig } from "../src/config.ts";
import { daikin } from "../src/connectors/daikin/index.ts";
import { applyFound, DAY_MS, discover, type Found, lostDetail, matchFound, parseAvahi, parseAvahiBrowse, parseBrowse, parseResolve, relocator } from "../src/discover.ts";

// Invented addresses (192.0.2.0/24) and identities, in the shape each discovery reports them.
const text = `// a home
{
  "devices": [
    // the AC in the living room
    { "id": "ac", "connector": "daikin", "host": "192.0.2.10", "mac": "00005E005301", "note": "kept" },
    { "id": "solar", "connector": "enphase", "host": "192.0.2.21", "token": "t.json" },
  ],
}
`;
const config = checkPlan(Bun.JSONC.parse(text)).config as HomeConfig;
const found: Found[] = [
  { connector: "daikin", id: "00:00:5e:00:53:01", host: "192.0.2.44" }, // the AC, moved, its MAC written differently
  { connector: "enphase", id: "000000000001", host: "192.0.2.21" }, // the gateway at its host; the config has no serial
  { connector: "hue", id: "0017880000000000", host: "192.0.2.2" }, // new
  { connector: "daikin", id: "00005E005399", host: "192.0.2.45" }, // a second AC
];

describe("matchFound", () => {
  test("by identity: moved, new, known by host with a hint, and a second device skipped", () => {
    expect(matchFound(config, found)).toEqual({
      moved: [{ index: 0, id: "ac", connector: "daikin", from: "192.0.2.10", to: "192.0.2.44" }],
      renamed: [],
      known: [{ id: "solar", connector: "enphase", hint: 'add "serial": "000000000001" to recognise it after a move' }],
      added: [{ found: found[2]!, entry: { id: "hue", connector: "hue", host: "192.0.2.2", bridgeId: "0017880000000000", key: "HUE_APPLICATION_KEY", ca: "hue-root-ca.pem" } }],
      skipped: [{ found: found[3]!, why: "a second daikin device; one per connector for now" }],
    });
  });

  test("a device at an entry's host with another identity is a conflict, not that entry", () => {
    expect(matchFound(config, [{ connector: "daikin", id: "00005E005399", host: "192.0.2.10" }]).skipped).toEqual([
      { found: { connector: "daikin", id: "00005E005399", host: "192.0.2.10" }, why: "answers at ac's host with a different mac" },
    ]);
  });

  test("a device elsewhere, when the entry has no identity, could be that entry moved", () => {
    expect(matchFound(config, [{ connector: "enphase", id: "000000000001", host: "192.0.2.77" }]).skipped[0]!.why).toBe('could be solar moved; add "serial" to tell');
  });

  test("a new entry's id is unique: a second Cast device of the same name is name-2", () => {
    const two: Found[] = [1, 2].map((n) => ({ connector: "cast", id: `0000000000004000800000000000000${n}`, host: `192.0.2.3${n}`, name: "Speaker" }));
    const withSpeaker = checkPlan({ devices: [{ id: "speaker", connector: "daikin", host: "192.0.2.9" }] }).config as HomeConfig;
    expect(matchFound(withSpeaker, two).added.map((a) => a.entry.id)).toEqual(["speaker-2", "speaker-3"]);
  });

  test("a device at its known host is known", () => {
    expect(matchFound(config, [{ connector: "daikin", id: "00005E005301", host: "192.0.2.10" }]).known).toEqual([{ id: "ac", connector: "daikin" }]);
  });
});

describe("applyFound", () => {
  test("updates the moved host and appends the new device; comments, unknown keys and other lines stay", () => {
    const out = applyFound(text, matchFound(config, found), true);
    const before = text.split("\n");
    const after = out.split("\n");
    expect(after).toHaveLength(before.length + 1);
    expect(after[4]).toBe(before[4]!.replace("192.0.2.10", "192.0.2.44"));
    expect(after[6]).toBe(`    { "id": "hue", "connector": "hue", "host": "192.0.2.2", "bridgeId": "0017880000000000", "key": "HUE_APPLICATION_KEY", "ca": "hue-root-ca.pem" },`);
    expect(after.filter((_, i) => i !== 4 && i !== 6)).toEqual(before.filter((_, i) => i !== 4));
    expect(checkPlan(Bun.JSONC.parse(out)).problems).toEqual([]);
  });

  test("a config with no devices gets a devices list", () => {
    const bare = `{\n  // nothing yet\n  "name": "x"\n}\n`;
    const out = applyFound(bare, matchFound({}, [found[2]!]), false);
    expect(out).toContain("// nothing yet");
    expect((Bun.JSONC.parse(out) as HomeConfig).devices).toHaveLength(1);
  });
});

describe("discover", () => {
  test("two passes by default, 5 s apart: the union, each pass's additions reported as they come", async () => {
    let t = 0;
    const clock: Clock = { now: () => t, sleep: async (ms) => void (t += ms) };
    const ac: Found = { connector: "daikin", id: "00005E005301", host: "192.0.2.10" };
    const hub: Found = { connector: "hue", id: "0017880000000000", host: "192.0.2.2" };
    const answers = [[ac], [{ ...ac, id: "00:00:5e:00:53:01" }, hub]]; // the second pass hears the AC again, written differently
    let n = 0;
    const seen: [number, Found[], number][] = [];
    const all = await discover(async () => answers[n++]!, { clock, onPass: (pass, added) => seen.push([pass, added, t]) });
    expect(all).toEqual([ac, hub]);
    expect(seen).toEqual([[1, [ac], 0], [2, [hub], 5000]]);
  });

  test("one pass when asked; done ends it early", async () => {
    const clock: Clock = { now: () => 0, sleep: async () => {} };
    let calls = 0;
    await discover(async () => (calls++, []), { clock, passes: 1 });
    expect(calls).toBe(1);
    await discover(async () => (calls++, [{ connector: "hue", id: "x", host: "h" } as Found]), { clock, done: (all) => all.length > 0 });
    expect(calls).toBe(2);
  });
});

describe("discover when passes throw", () => {
  const clock: Clock = { now: () => 0, sleep: async () => {} };
  test("every pass threw: it throws, since discovery never ran", async () => {
    await expect(discover(async () => Promise.reject(new Error("spawn dns-sd ENOENT")), { clock })).rejects.toThrow("spawn dns-sd ENOENT");
  });
  test("one pass threw: the other's answers, as before", async () => {
    let n = 0;
    const hub: Found = { connector: "hue", id: "0017880000000000", host: "192.0.2.2" };
    expect(await discover(async () => (n++ ? [hub] : Promise.reject(new Error("busy"))), { clock })).toEqual([hub]);
  });
  test("an aborted signal stops between passes", async () => {
    const stop = new AbortController();
    let calls = 0;
    await discover(async () => (calls++, stop.abort(), []), { clock, signal: stop.signal });
    expect(calls).toBe(1);
  });
});

describe("relocator", () => {
  const MIN = 60_000;
  const setup = (answers: () => Found[]) => {
    let t = 0;
    const scans: number[] = [];
    const clock: Clock = { now: () => t, sleep: async () => {} };
    const where = relocator({ host: "192.0.2.10", id: "00005E005301", clock, find: async () => (scans.at(-1) === t || scans.push(t), answers()) }); // one scan's two passes count once
    return { where, scans, at: (ms: number) => void (t = ms) };
  };

  test("scans after three failures, then at 1, 5 and 15 minutes, then hourly; after a day it says so and keeps scanning", async () => {
    let answers: Found[] = [];
    const { where, scans, at } = setup(() => answers);
    for (const ms of [0, 2 * MIN, 4 * MIN]) at(ms), await where.failed(); // the third failure scans
    for (let ms = 5 * MIN; ms <= 180 * MIN; ms += MIN) at(ms), await where.failed(); // a failure every minute for three hours
    expect(scans.slice(0, 6)).toEqual([4 * MIN, 5 * MIN, 10 * MIN, 25 * MIN, 85 * MIN, 145 * MIN]);
    at(4 * MIN + DAY_MS);
    expect(await where.failed()).toEqual({ overADay: true, seenHere: false });
    at(4 * MIN + DAY_MS + 60 * MIN);
    answers = [{ connector: "daikin", id: "00005E005301", host: "192.0.2.44" }]; // back, at a new address
    expect(await where.failed()).toEqual({ moved: "moved from 192.0.2.10 to 192.0.2.44" });
  });

  test("the detail says what discovery found, and only says not found after a scan missed it", async () => {
    const { where, at } = setup(() => [{ connector: "daikin", id: "00005E005301", host: "192.0.2.10" }]);
    at(0);
    expect(await where.failed()).toEqual({});
    expect(lostDetail({}, "Error: timeout")).toBe("Error: timeout");
    expect(lostDetail({}, new TypeError("fetch failed"))).toBe("fetch failed"); // the message, not the class
    await where.failed();
    const r = await where.failed();
    expect(r).toEqual({ seenHere: true });
    expect(lostDetail(r, "Error: timeout")).toBe("discovery finds it at its address but reads fail; Error: timeout");
    expect(lostDetail({ overADay: true, seenHere: false }, "Error: timeout")).toBe("no answer for a day; not found by discovery; Error: timeout");
  });

  test("a match at a new address is a move; a good read and a refresh reset the backoff", async () => {
    let answers: Found[] = [];
    const { where, scans, at } = setup(() => answers);
    for (const ms of [0, 1, 2]) at(ms), await where.failed();
    expect(scans).toEqual([2]);
    where.reset(); // a refresh: the next failure scans at once
    at(3);
    answers = [{ connector: "daikin", id: "00:00:5E:00:53:01", host: "192.0.2.44" }];
    expect(await where.failed()).toEqual({ moved: "moved from 192.0.2.10 to 192.0.2.44" });
    expect(where.host()).toBe("192.0.2.44");
    where.ok();
    for (const ms of [4, 5]) at(ms), await where.failed();
    expect(scans).toEqual([2, 3]); // two failures after a good read: no scan yet
  });

  test("a scan is two passes 5 s apart, and the second pass can find what the first missed", async () => {
    let t = 0;
    const passes: number[] = [];
    const clock: Clock = { now: () => t, sleep: async (ms) => void (t += ms) };
    const answers: Found[][] = [[], [{ connector: "daikin", id: "00005E005301", host: "192.0.2.44" }]];
    const where = relocator({ host: "192.0.2.10", id: "00005E005301", clock, find: async () => (passes.push(t), answers[passes.length - 1] ?? []) });
    for (let i = 0; i < 2; i++) await where.failed();
    expect(await where.failed()).toEqual({ moved: "moved from 192.0.2.10 to 192.0.2.44" });
    expect(passes).toEqual([0, 5000]);
  });

  test("a scan that could not run says discovery failed, not not found", async () => {
    const where = relocator({ host: "192.0.2.10", id: "00005E005301", clock: { now: () => 0, sleep: async () => {} }, find: async () => Promise.reject(new Error("spawn dns-sd ENOENT")) });
    for (let i = 0; i < 2; i++) await where.failed();
    const r = await where.failed();
    expect(r).toEqual({ discoveryFailed: "spawn dns-sd ENOENT" });
    expect(lostDetail(r, "Error: timeout")).toBe("discovery failed: spawn dns-sd ENOENT; Error: timeout");
    expect(await where.failed()).toEqual(r); // between scans it still says so
  });

  test("without an identity or a finder it never scans", async () => {
    const where = relocator({ host: "h", clock: { now: () => 0, sleep: async () => {} }, find: async () => [] });
    for (let i = 0; i < 5; i++) expect(await where.failed()).toEqual({});
  });
});

describe("a polling connector that moves", () => {
  test("Daikin finds its AC at a new address after three failed reads and says so in detail", async () => {
    const status = await Bun.file(new URL("./fixtures/daikin/status.json", import.meta.url)).text();
    const f = (async (url: string) => (url.includes("192.0.2.44") ? new Response(status) : Promise.reject(new Error("no route")))) as unknown as typeof fetch;
    let t = 0;
    const stop = new AbortController();
    const clock: Clock = { now: () => t, sleep: async (ms) => void ((t += ms), t > 10 * 120_000 && stop.abort()) };
    const find = async (): Promise<Found[]> => [{ connector: "daikin", id: "00005E005301", host: "192.0.2.44" }];
    const details: (string | undefined)[] = [];
    const home = createHome([daikin({ host: "192.0.2.10", mac: "00005E005301", find, fetch: f, clock })], (s) => details.push(s.daikin?.detail));
    await home.start(stop.signal);
    expect(details.slice(0, 4)).toEqual(["no route", "no route", "moved from 192.0.2.10 to 192.0.2.44", "moved from 192.0.2.10 to 192.0.2.44"]);
    expect(home.snapshot().daikin).toMatchObject({ status: "connected", detail: "moved from 192.0.2.10 to 192.0.2.44", state: { targetC: 25 } });
  });
});

describe("a polling connector down for over a day", () => {
  test("stays disconnected, never unavailable, and reads again when the device is back", async () => {
    const status = await Bun.file(new URL("./fixtures/daikin/status.json", import.meta.url)).text();
    let t = 0;
    let back = false;
    const f = (async () => (back ? new Response(status) : Promise.reject(new Error("no route")))) as unknown as typeof fetch;
    const stop = new AbortController();
    const clock: Clock = { now: () => t, sleep: async (ms) => void ((t += ms), (back ||= t > DAY_MS + 3_600_000), t > DAY_MS + 4 * 3_600_000 && stop.abort()) };
    const parts: { status: string; detail?: string }[] = [];
    const home = createHome([daikin({ host: "192.0.2.10", mac: "00005E005301", find: async () => [], fetch: f, clock })], (s) => parts.push(s.daikin!));
    await home.start(stop.signal);
    expect(parts.some((p) => p.status === "unavailable")).toBe(false);
    expect(parts.some((p) => p.detail?.startsWith("no answer for a day; not found by discovery"))).toBe(true);
    expect(home.snapshot().daikin).toMatchObject({ status: "connected", state: { targetC: 25 } });
  });
});

describe("Cast", () => {
  const speaker: Found = { connector: "cast", id: "00000000000040008000000000000001", host: "192.0.2.30", port: 8009, name: "Kitchen speaker", model: "Google Nest Mini" };
  const group: Found = { connector: "cast", id: "00000000-0000-4000-8000-000000000002", host: "192.0.2.30", port: 32123, name: "Downstairs", model: "Google Cast Group", group: true };

  test("every device and group is added, by name and castId, no host", () => {
    expect(matchFound(config, [speaker, group]).added.map((a) => a.entry)).toEqual([
      { id: "kitchen-speaker", connector: "cast", name: "Kitchen speaker", castId: "00000000000040008000000000000001" },
      { id: "downstairs", connector: "cast", name: "Downstairs", castId: "00000000-0000-4000-8000-000000000002" },
    ]);
  });

  test("a listed one is known by castId, dashes or none, wherever it answers", () => {
    const listed = checkPlan({ devices: [{ id: "k", connector: "cast", name: "Kitchen speaker", castId: "00000000-0000-4000-8000-000000000001" }] }).config as HomeConfig;
    expect(matchFound(listed, [{ ...speaker, host: "192.0.2.99" }])).toEqual({ moved: [], renamed: [], added: [], skipped: [], known: [{ id: "k", connector: "cast" }] });
  });

  test("a device renamed in the Google Home app: same castId, new fn, and --write refreshes the entry's name alone", () => {
    const text = `{\n  "devices": [\n    // the kitchen\n    { "id": "k", "connector": "cast", "room": "room-x", "name": "Kitchen speaker", "castId": "00000000-0000-4000-8000-000000000001" }\n  ]\n}\n`;
    const listed = checkPlan(Bun.JSONC.parse(text)).config as HomeConfig;
    const match = matchFound(listed, [{ ...speaker, name: "Pantry speaker" }]);
    expect(match.renamed).toEqual([{ index: 0, id: "k", connector: "cast", from: "Kitchen speaker", to: "Pantry speaker" }]);
    expect(match.known).toEqual([{ id: "k", connector: "cast" }]);
    const out = applyFound(text, match, true);
    expect(out).toBe(text.replace('"Kitchen speaker"', '"Pantry speaker"'));
  });

  test("no fn in the TXT record is not a rename: the entry keeps its name", () => {
    const listed = checkPlan({ devices: [{ id: "k", connector: "cast", name: "Kitchen speaker", castId: speaker.id }] }).config as HomeConfig;
    expect(matchFound(listed, [{ ...speaker, name: undefined }]).renamed).toEqual([]);
  });

  test("dns-sd's browse: each instance once", () => {
    const text = "21:02:28.396  Add        3  14 local.               _googlecast._tcp.    Google-Nest-Mini-0000\n21:02:28.396  Add        2  15 local.               _googlecast._tcp.    Google-Nest-Mini-0000\n";
    expect(parseBrowse(text)).toEqual(["Google-Nest-Mini-0000"]);
  });

  test("avahi-browse's resolve (Linux): IPv4 only, each instance once, names and TXT unescaped as dns-sd's", () => {
    // Invented values in avahi-browse --parsable --resolve's shape: a + line per sighting, a = line per resolve.
    const text = [
      "+;wlan0;IPv4;Google-Nest-Mini-0000;_googlecast._tcp;local",
      "+;wlan0;IPv6;Google-Nest-Mini-0000;_googlecast._tcp;local",
      '=;wlan0;IPv6;Google-Nest-Mini-0000;_googlecast._tcp;local;0000-0000.local;fe80::1;8009;"id=00000000000040008000000000000001"',
      '=;wlan0;IPv4;Google-Nest-Mini-0000;_googlecast._tcp;local;0000-0000.local;192.0.2.31;8009;"rs=" "fn=KO\\226\\128\\153s kitchen" "md=Google Nest Mini" "id=00000000000040008000000000000001" "nf"',
      '=;eth0;IPv4;Google-Nest-Mini-0000;_googlecast._tcp;local;0000-0000.local;192.0.2.31;8009;"id=00000000000040008000000000000001"',
      '=;wlan0;IPv4;Hue\\032Bridge\\032-\\032000000;_hue._tcp;local;ecb5fa000000.local;192.0.2.2;443;"bridgeid=0017880000000000" "modelid=BSB002"',
    ].join("\n");
    expect(parseAvahi(text)).toEqual([
      { instance: "Google-Nest-Mini-0000", hostname: "0000-0000.local", host: "192.0.2.31", port: 8009, txt: { rs: "", fn: "KO’s kitchen", md: "Google Nest Mini", id: "00000000000040008000000000000001", nf: "" } },
      { instance: "Hue Bridge - 000000", hostname: "ecb5fa000000.local", host: "192.0.2.2", port: 443, txt: { bridgeid: "0017880000000000", modelid: "BSB002" } },
    ]);
    expect(parseAvahiBrowse(text)).toEqual(["Google-Nest-Mini-0000"]);
  });

  test("avahi-browse as Debian trixie prints it: ; and quotes escaped, loopback skipped", () => {
    // Captured from avahi-utils in a debian:trixie container publishing a test service (2026-10-16); the address changed to a documentation one.
    const text = [
      "+;lo;IPv4;Hue\\032Bridge\\032\\226\\128\\147\\032KO\\039s\\059\\032test\\.one;_hue._tcp;local",
      '=;lo;IPv4;Hue\\032Bridge\\032\\226\\128\\147\\032KO\\039s\\059\\032test\\.one;_hue._tcp;local;e317183b6abc.local;127.0.0.1;443;"fn=say \\"hi\\"\\\\x" "flag" "rs=" "bridgeid=0017880000000000"',
      '=;eth0;IPv4;Hue\\032Bridge\\032\\226\\128\\147\\032KO\\039s\\059\\032test\\.one;_hue._tcp;local;e317183b6abc.local;192.0.2.2;443;"fn=say \\"hi\\"\\\\x" "flag" "rs=" "bridgeid=0017880000000000"',
    ].join("\n");
    expect(parseAvahi(text)).toEqual([
      { instance: "Hue Bridge – KO's; test.one", hostname: "e317183b6abc.local", host: "192.0.2.2", port: 443, txt: { fn: 'say "hi"\\x', flag: "", rs: "", bridgeid: "0017880000000000" } },
    ]);
    expect(parseAvahiBrowse(text)).toEqual(["Hue Bridge – KO's; test.one"]);
  });

  test("dns-sd's resolve: host, port, and TXT with escaped spaces and UTF-8 bytes undone", () => {
    const text = [
      "Lookup Google-Nest-Mini-0000._googlecast._tcp.local",
      "21:02:44.417  Google-Nest-Mini-0000._googlecast._tcp.local. can be reached at 0000-0000.local.:8009 (interface 14)",
      " id=00000000000040008000000000000001 md=Google\\ Nest\\ Mini fn=KO\\226\\128\\153s\\ kitchen rs= nf=1",
    ].join("\n");
    expect(parseResolve(text)).toEqual({
      hostname: "0000-0000.local",
      port: 8009,
      txt: { id: "00000000000040008000000000000001", md: "Google Nest Mini", fn: "KO\u2019s kitchen", rs: "", nf: "1" },
    });
  });
});
