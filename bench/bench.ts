// Performance of the parts that need no bridge. `bun run bench`; numbers go in the README with the Bun version.
import { bench, run, summary } from "mitata";
import { groups } from "../src/connectors/hue/index.ts";
import { parseSse } from "../src/connectors/hue/events.ts";
import { reduce, snapshotFrom } from "../src/connectors/hue/state.ts";
import { Resource, type HueEvent } from "../src/connectors/hue/schemas.ts";
import { writeQueue } from "../src/connectors/hue/client.ts";

const resources = Resource.array().parse(JSON.parse(await Bun.file(new URL("../test/fixtures/resources.json", import.meta.url)).text()).data);
const start = snapshotFrom(resources, "t");

// 1,000 events: brightness changes across the fixture's lights and grouped lights, as a busy evening would send.
const ids = ["light-1", "light-2", "gl-living", "gl-home"];
const events: HueEvent[] = Array.from({ length: 1000 }, (_, i) => ({
  id: `ev-${i}`, type: "update", creationtime: `2026-02-06T02:${String(i % 60).padStart(2, "0")}:00Z`,
  data: [{ id: ids[i % 4]!, type: i % 4 < 2 ? "light" : "grouped_light", dimming: { brightness: i % 100 }, on: { on: i % 3 > 0 } }],
}));
const streamText = events.map((e, i) => `id: ${1770343753 + i}:0\ndata: ${JSON.stringify([e])}\n\n`).join("");
const bytes = new TextEncoder().encode(streamText);
const chunked = (size: number) =>
  new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.subarray(i, i + size)); c.close(); } });

summary(() => {
  bench("parseSse: 1,000 messages, 4 KiB chunks", async () => { for await (const _ of parseSse(chunked(4096))); });
  bench("reduce: 1,000 events", () => { let s = start; for (const e of events) s = reduce(s, e); return s; });
  bench("groups(): rooms view of a snapshot", () => groups(start));
  bench("writeQueue: 100 queued writes, fake clock", async () => {
    let t = 0;
    const enqueue = writeQueue({ now: () => t, sleep: async (ms) => void (t += ms) });
    await Promise.all(Array.from({ length: 100 }, (_, i) => enqueue(i % 2 ? "light" : "group", async () => t)));
  });
});

await run();
