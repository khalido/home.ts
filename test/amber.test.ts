import { describe, expect, test } from "bun:test";
import {
  bestWindow,
  createHome,
  energyNow,
  gridText,
  solarLevel,
  type Clock,
} from "../src/index.ts";
import { BALANCED_W } from "../src/energy.ts";
import { amber, amberClient, POLL_MS } from "../src/connectors/amber/index.ts";
import { toPrices } from "../src/connectors/amber/client.ts";

// Shapes from a live reply on 2026-10-13, ids removed.
const current = JSON.parse(
  await Bun.file(
    new URL("./fixtures/amber/current.json", import.meta.url),
  ).text(),
);
// `prices/current?next=96` on 2026-10-28: the current interval, 12 five-minute and 14 half-hour forecasts per channel.
const forecastReply = JSON.parse(
  await Bun.file(
    new URL("./fixtures/amber/forecast.json", import.meta.url),
  ).text(),
);

describe("toPrices", () => {
  test("the current interval of each channel; feed-in flipped to what you are paid", () => {
    expect(toPrices(current)).toEqual({
      importCents: 40.9087,
      exportCents: 35.27152,
      priceDescriptor: "low",
      exportDescriptor: "high",
      spike: "none",
      renewables: 7.078,
      estimate: false,
      nextImportCents: 43.24809,
      intervalEnds: "2026-10-13T07:20:00Z",
      forecast: [
        {
          start: "2026-10-13T07:15:00.000Z",
          end: "2026-10-13T07:20:00.000Z",
          importCents: 40.9087,
          exportCents: 35.27152,
          renewables: 7.078,
          descriptor: "low",
        },
        {
          start: "2026-10-13T07:20:00.000Z",
          end: "2026-10-13T07:25:00.000Z",
          importCents: 43.24809,
          exportCents: expect.any(Number),
          renewables: expect.any(Number),
          descriptor: expect.any(String),
        },
      ],
    });
  });

  test("an interval whose time does not parse is left out and said, not thrown", () => {
    const odd = forecastReply.map(
      (i: { type: string; startTime: string }, n: number) =>
        n === 3 ? { ...i, startTime: "soon" } : i,
    );
    const s = toPrices(odd);
    expect(s.anomaly).toBe(
      "1 price row(s) left out: their start or end time could not be read",
    );
    expect(s.forecast!.length).toBeGreaterThan(20);
  });

  test("the forecast: the current interval then each one ahead, in order, both channels on one row", () => {
    const f = toPrices(forecastReply).forecast!;
    expect(f.length).toBe(
      forecastReply.filter(
        (i: { channelType: string; type: string }) =>
          i.channelType === "general" && i.type !== "ActualInterval",
      ).length,
    );
    for (const [a, b] of f.slice(1).map((r, i) => [f[i]!, r]))
      expect(a!.end).toBe(b!.start); // unbroken
    expect(
      f.every(
        (r) => r.importCents !== undefined && r.exportCents !== undefined,
      ),
    ).toBe(true);
  });
});

describe("bestWindow", () => {
  const row = (h: number, importCents?: number, renewables?: number) => ({
    start: new Date(Date.UTC(2026, 9, 28, h)).toISOString(),
    end: new Date(Date.UTC(2026, 9, 28, h + 1)).toISOString(),
    importCents,
    renewables,
  });
  const forecast = [
    row(0, 30, 10),
    row(1, 10, 20),
    row(2, 20, 60),
    row(3, 40, 50),
    row(4, 5, 30),
  ];

  test("the cheapest two hours, averaged by time; the greenest by renewables", () => {
    expect(bestWindow(forecast, 2)).toMatchObject({
      start: row(1).start,
      end: row(3).start,
      importCents: 15,
      renewables: 40,
    });
    expect(bestWindow(forecast, 2, { by: "renewables" })).toMatchObject({
      start: row(2).start,
      renewables: 55,
    });
  });

  test("starts at `from` inside the current interval, and weighs the part hours", () => {
    const from = Date.parse(row(0).start) + 1_800_000; // half past
    expect(bestWindow(forecast, 1, { from })?.start).toBe(row(4).start);
    expect(bestWindow(forecast.slice(0, 2), 1.5, { from })).toMatchObject({
      start: new Date(from).toISOString(),
      importCents: (0.5 * 30 + 10) / 1.5,
    });
  });

  test("a window may end on an interval's edge rather than start on one", () => {
    expect(bestWindow([row(0, 50), row(1, 0), row(2, 100)], 1.5)).toMatchObject(
      { start: "2026-10-28T00:30:00.000Z", importCents: (0.5 * 50) / 1.5 },
    );
  });

  test("an hour count that is not a whole number of ms still averages every field; none above 0 throws", () => {
    expect(
      bestWindow(forecast, 1.1, { by: "renewables" })?.renewables,
    ).toBeNumber();
    expect(() => bestWindow(forecast, 0)).toThrow(RangeError);
    expect(() => bestWindow(forecast, -1)).toThrow(RangeError);
  });

  test("the greenest window needs renewables only; an import price missing anywhere leaves its average out", () => {
    const green = [row(0, undefined, 90), row(1, 10, 80)];
    expect(bestWindow(green, 2, { by: "renewables" })).toMatchObject({
      renewables: 85,
      importCents: undefined,
    });
  });

  test("never spans a gap or a missing price, and is undefined when nothing fits", () => {
    const broken = [row(0, 10), row(2, 10), row(3, undefined), row(4, 10)];
    expect(bestWindow(broken, 2)).toBeUndefined();
    expect(bestWindow(forecast, 6)).toBeUndefined();
    expect(bestWindow(undefined, 1)).toBeUndefined();
  });

  test("on the live forecast (2026-10-28): the cheapest 2 hours run across the 5- and 30-minute intervals", () => {
    const w = bestWindow(toPrices(forecastReply).forecast, 2)!;
    expect(w).toMatchObject({
      start: "2026-10-28T04:40:00.000Z",
      end: "2026-10-28T06:40:00.000Z",
    });
    expect(w.importCents).toBeCloseTo(13.7313, 4);
  });
});

describe("energyNow", () => {
  test("importing costs import price × kW per hour", () => {
    const e = energyNow(
      { productionW: 200, consumptionW: 5000, netW: 4800, source: "meter" },
      toPrices(current),
    );
    expect(e.centsPerHour).toBeCloseTo(4.8 * 40.9087, 6);
  });
  test("exporting earns: negative cost at the feed-in price", () => {
    const e = energyNow(
      { productionW: 3000, consumptionW: 1000, netW: -2000, source: "meter" },
      toPrices(current),
    );
    expect(e.centsPerHour).toBeCloseTo(-2 * 35.27152, 6);
  });
  test("missing either side leaves the cost undefined", () => {
    expect(
      energyNow(undefined, toPrices(current)).centsPerHour,
    ).toBeUndefined();
  });
  // Variants of the live reply: the current general and feed-in intervals with one field changed.
  const variant = (
    general: Record<string, unknown>,
    feedIn: Record<string, unknown> = {},
  ) =>
    toPrices(
      current.map((i: Record<string, unknown>) =>
        i.type !== "CurrentInterval"
          ? i
          : { ...i, ...(i.channelType === "general" ? general : feedIn) },
      ),
    );
  test("passes Amber's descriptor, spike status and estimate through", () => {
    expect(energyNow(undefined, toPrices(current))).toMatchObject({
      priceDescriptor: "low",
      spike: "none",
      estimate: false,
      negativePrice: undefined,
    });
    expect(
      energyNow(
        undefined,
        variant({
          spikeStatus: "potential",
          descriptor: "spike",
          estimate: true,
        }),
      ),
    ).toMatchObject({
      priceDescriptor: "spike",
      spike: "potential",
      estimate: true,
    });
  });
  test("a negative import price is paid to use; a positive feed-in price is exporting at a loss", () => {
    expect(energyNow(undefined, variant({ perKwh: -3.2 })).negativePrice).toBe(
      "paid to use",
    );
    expect(
      energyNow(undefined, variant({}, { perKwh: 4.1 })).negativePrice,
    ).toBe("exporting at a loss");
    expect(
      energyNow(undefined, variant({ perKwh: -3.2 }, { perKwh: 4.1 }))
        .negativePrice,
    ).toBe("paid to use"); // both: the import side wins
  });
});

describe("surplus and flow", () => {
  const prices = toPrices(current);
  const at = (netW?: number) =>
    energyNow(
      netW === undefined ? undefined : { netW, source: "meter" },
      prices,
    );
  test("exporting: the surplus is the export as a positive number, earning the export price", () => {
    expect(at(-1200)).toMatchObject({
      flow: "exporting",
      surplusW: 1200,
      gridW: -1200,
    });
    expect(at(-1200).surplusCentsPerHour).toBeCloseTo(1.2 * 35.27152, 6);
  });
  test("importing has no surplus", () => {
    expect(at(800)).toMatchObject({
      flow: "importing",
      surplusW: 0,
      surplusCentsPerHour: 0,
    });
  });
  test(`within ${BALANCED_W} W either way the flow reads balanced; gridW and surplusW stay as read`, () => {
    expect(at(BALANCED_W)).toMatchObject({ flow: "balanced", gridW: 20 });
    expect(at(-BALANCED_W)).toMatchObject({
      flow: "balanced",
      gridW: -20,
      surplusW: 20,
    });
    expect(at(BALANCED_W + 1).flow).toBe("importing");
    expect(at(-BALANCED_W - 1).flow).toBe("exporting");
  });
  test("no grid reading: no flow and no surplus, which a drawing shows as no data", () => {
    expect(at(undefined)).toMatchObject({
      flow: undefined,
      surplusW: undefined,
      surplusCentsPerHour: undefined,
    });
  });
  test("in words: what home status prints", () => {
    expect(gridText(at(-1200))).toBe("exporting 1.2 kW, earning 42 c/h");
    expect(gridText(at(800))).toBe("importing 0.8 kW, costing 33 c/h");
    expect(gridText(at(-10))).toBe("balanced (-10 W)");
    expect(gridText(at(undefined))).toBe("");
    expect(gridText(energyNow({ netW: -1200, source: "meter" }))).toBe(
      "exporting 1.2 kW",
    ); // no prices: no rate
  });
  test("exporting at a loss earns a negative amount, not zero", () => {
    const loss = toPrices(
      current.map((i: Record<string, unknown>) =>
        i.type === "CurrentInterval" && i.channelType === "feedIn"
          ? { ...i, perKwh: 4 }
          : i,
      ),
    );
    expect(
      energyNow({ netW: -1000, source: "meter" }, loss).surplusCentsPerHour,
    ).toBeCloseTo(-4, 6);
  });
});

describe("solarLevel", () => {
  const now = (solarW?: number, peak?: number) =>
    energyNow({
      productionW: solarW,
      productionWPeakToday: peak,
      source: "meter",
    });
  test("against the rated capacity when the config has it, else today's peak, saying which", () => {
    expect(solarLevel(now(3000, 4000), 6000)).toEqual({
      fraction: 0.5,
      scale: "capacity",
    });
    expect(solarLevel(now(3000, 4000))).toEqual({
      fraction: 0.75,
      scale: "today's peak",
    });
  });
  test("never clamped: above the rated size reads above 1", () => {
    expect(solarLevel(now(6600, 6600), 6000)!.fraction).toBeCloseTo(1.1, 9);
  });
  test("no solar reading, or nothing to scale by, is no level", () => {
    expect(solarLevel(now(undefined, 4000), 6000)).toBeUndefined();
    expect(solarLevel(now(0, 0))).toBeUndefined(); // before the first light of the day
  });
});

describe("amber integration", () => {
  const amberApi = (status = 200) => {
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(url);
      if (status !== 200) return new Response("", { status });
      return new Response(
        JSON.stringify(
          url.endsWith("/sites") ? [{ id: "S1", status: "active" }] : current,
        ),
      );
    }) as unknown as typeof fetch;
    return { f, calls };
  };

  test("finds the site once, then polls prices every 60 s", async () => {
    const { f, calls } = amberApi();
    let t = 0;
    const stop = new AbortController();
    const clock: Clock = {
      now: () => t,
      sleep: async (ms) => void ((t += ms), t >= 2 * POLL_MS && stop.abort()),
    };
    const home = createHome([amber({ key: "k", fetch: f, clock })]);
    await home.start(stop.signal);
    expect(calls).toEqual([
      "https://api.amber.com.au/v1/sites",
      "https://api.amber.com.au/v1/sites/S1/prices/current?next=96",
      "https://api.amber.com.au/v1/sites/S1/prices/current?next=96",
    ]);
    expect(home.snapshot().amber).toMatchObject({
      status: "connected",
      state: { importCents: 40.9087 },
    });
  });

  test("a rejected key marks Amber unavailable and stops", async () => {
    const home = createHome([amber({ key: "k", fetch: amberApi(401).f })]);
    await home.start(new AbortController().signal);
    expect(home.snapshot().amber).toMatchObject({ status: "unavailable" });
  });

  test("stopping the run cancels a read in flight; a refresh does not", async () => {
    let aborted = false;
    const f = (async (_url: string, init?: RequestInit) =>
      new Promise((_, reject) =>
        init!.signal!.addEventListener(
          "abort",
          () => ((aborted = true), reject(init!.signal!.reason)),
          { once: true },
        ),
      )) as unknown as typeof fetch;
    const integration = amber({ key: "k", siteId: "S1", fetch: f });
    const parts: unknown[] = [];
    const stop = new AbortController();
    const running = integration.run(stop.signal, (p) => parts.push(p));
    integration.refresh();
    await Bun.sleep(5);
    expect(aborted).toBe(false);
    stop.abort();
    await running;
    expect(aborted).toBe(true);
    expect(parts).toEqual([]); // a stopped read is not reported as a failure
  });

  test("sends the key as a bearer token", async () => {
    let auth = "";
    const f = (async (_url: string, init?: RequestInit) => (
      (auth = (init!.headers as Record<string, string>).authorization!),
      new Response(JSON.stringify(current))
    )) as unknown as typeof fetch;
    await amberClient({ key: "psk_x", fetch: f }).prices("S1");
    expect(auth).toBe("Bearer psk_x");
  });
});
