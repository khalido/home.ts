import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHome, type Clock } from "../src/index.ts";
import { loadHome } from "../src/config.ts";
import { type AddressCache, addressBook, type CachedAddress, type Found } from "../src/discover.ts";
import { dnsSd, fileCache } from "../src/finders.ts";

// Invented addresses (192.0.2.0/24) and identities.
const memory = (start: Record<string, CachedAddress> = {}) => {
  const writes: Record<string, CachedAddress>[] = [];
  const cache: AddressCache = { read: () => structuredClone(start), write: (e) => void writes.push(e) };
  return { cache, writes };
};
const ac = { id: "ac", connector: "daikin", host: "192.0.2.10", mac: "00005E005301" };
const status = await Bun.file(new URL("./fixtures/daikin/status.json", import.meta.url)).text();
/** A Daikin that answers only at `at`. */
const daikinAt = (at: string, asked: string[]) =>
  (async (url: string) => (asked.push(new URL(url).hostname), url.includes(`//${at}/`) ? new Response(status) : Promise.reject(new Error("no route")))) as unknown as typeof fetch;

describe("addressBook", () => {
  test("a cached address counts only when confirmed since the config; seen writes only what changed or was stale", () => {
    const { cache, writes } = memory({ "daikin:00005e005301": { host: "192.0.2.44", seenAt: "2026-10-13T00:00:00.000Z" } });
    expect(addressBook(cache, { configAt: Date.parse("2026-10-12T00:00:00Z") }).fresh("daikin", "00:00:5E:00:53:01")?.host).toBe("192.0.2.44");
    let t = Date.parse("2026-10-15T00:00:00Z");
    const book = addressBook(cache, { configAt: Date.parse("2026-10-14T00:00:00Z"), now: () => t });
    expect(book.fresh("daikin", "00005E005301")).toBeUndefined(); // the config was edited since
    book.seen("daikin", "00005E005301", { host: "192.0.2.44" }); // a good read at the same address: trusted again
    expect(writes).toEqual([{ "daikin:00005e005301": { host: "192.0.2.44", seenAt: "2026-10-15T00:00:00.000Z" } }]);
    expect(book.fresh("daikin", "00005E005301")?.host).toBe("192.0.2.44");
    t += 60_000;
    book.seen("daikin", "00005E005301", { host: "192.0.2.44" }); // unchanged and fresh: no write
    expect(writes).toHaveLength(1);
    book.seen("daikin", "00005E005301", { host: "192.0.2.45" });
    expect(writes.at(-1)).toEqual({ "daikin:00005e005301": { host: "192.0.2.45", seenAt: "2026-10-15T00:01:00.000Z" } });
  });

  test("a Cast device's new name is written; a call without a name keeps the cached one", () => {
    const { cache, writes } = memory({ "cast:00000000000040008000000000000001": { host: "192.0.2.30", port: 8009, name: "Kitchen speaker", seenAt: new Date().toISOString() } });
    const book = addressBook(cache);
    book.seen("cast", "00000000000040008000000000000001", { host: "192.0.2.30", port: 8009 });
    expect(writes).toEqual([]);
    book.seen("cast", "00000000000040008000000000000001", { host: "192.0.2.30", port: 8009, name: "Pantry speaker" });
    expect(writes.at(-1)!["cast:00000000000040008000000000000001"]!.name).toBe("Pantry speaker");
    book.seen("cast", "00000000000040008000000000000001", { host: "192.0.2.31", port: 8009 });
    expect(writes.at(-1)!["cast:00000000000040008000000000000001"]).toMatchObject({ host: "192.0.2.31", name: "Pantry speaker" });
  });
});

describe("loadHome with an address cache", () => {
  const run = async (cache: AddressCache, f: typeof fetch, find: () => Promise<Found[]>) => {
    const [daikin] = loadHome({ devices: [ac] }, { env: {}, fetch: f, cache, finders: { daikin: find } });
    const home = createHome([daikin!]);
    const stop = new AbortController();
    const running = home.start(stop.signal);
    for (let i = 0; i < 500 && home.snapshot().daikin?.status !== "connected"; i++) await Bun.sleep(2);
    stop.abort();
    daikin!.refresh(); // wake its poll wait
    await running;
    return home.snapshot().daikin;
  };

  test("a cache hit reads at the cached address and never discovers", async () => {
    const { cache, writes } = memory({ "daikin:00005e005301": { host: "192.0.2.44", seenAt: new Date().toISOString() } });
    const asked: string[] = [];
    let scans = 0;
    expect(await run(cache, daikinAt("192.0.2.44", asked), async () => (scans++, []))).toMatchObject({ status: "connected" });
    expect(asked).toEqual(["192.0.2.44"]);
    expect(scans).toBe(0);
    expect(writes).toEqual([]); // unchanged: nothing to write
  });

  test("a stale cache discovers on the first failure and the cache is rewritten", async () => {
    const { cache, writes } = memory({ "daikin:00005e005301": { host: "192.0.2.44", seenAt: new Date().toISOString() } });
    const asked: string[] = [];
    const find = async (): Promise<Found[]> => [{ connector: "daikin", id: "00005E005301", host: "192.0.2.50" }];
    expect(await run(cache, daikinAt("192.0.2.50", asked), find)).toMatchObject({ status: "connected", detail: "moved from 192.0.2.44 to 192.0.2.50" });
    expect(asked).toEqual(["192.0.2.44", "192.0.2.50"]);
    expect(writes.at(-1)!["daikin:00005e005301"]!.host).toBe("192.0.2.50");
  });
});

describe("fileCache", () => {
  test("round-trips, owner-only, and a missing or broken file reads as empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "home-cache-"));
    try {
      const path = join(dir, "home", "addresses.json");
      const file = fileCache(path);
      expect(file.read()).toEqual({});
      const entries = { "cast:00000000000040008000000000000001": { host: "192.0.2.30", port: 8009, name: "Kitchen speaker", seenAt: "2026-10-13T00:00:00.000Z" } };
      file.write(entries);
      expect(file.read()).toEqual(entries);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "home")).mode & 0o777).toBe(0o700);
      await Bun.write(path, "{ not json");
      expect(file.read()).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dnsSd", () => {
  test("a missing binary rejects, naming it, rather than finding nothing", async () => {
    await expect(dnsSd(["-B", "_hue._tcp"], { command: "dns-sd-not-installed" })).rejects.toThrow("dns-sd-not-installed not found; mDNS discovery needs it");
    await expect(dnsSd(["--parsable"], { command: "avahi-browse-not-installed", install: "apt install avahi-utils" })).rejects.toThrow("avahi-browse-not-installed not found; mDNS discovery needs it (apt install avahi-utils)");
  });
});
