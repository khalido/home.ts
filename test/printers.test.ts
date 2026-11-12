import { describe, expect, test } from "bun:test";
import { checkHome, loadHome } from "../src/config.ts";
import {
  applyFound,
  DISCOVERY_GAP_MS,
  type Found,
  matchFound,
} from "../src/discover.ts";
import { type Clock, type Part } from "../src/index.ts";
import {
  manifest,
  type Printer,
  printers,
  type PrintersState,
} from "../src/connectors/printers/index.ts";
import {
  attributesOf,
  decodeMessage,
  encodeMessage,
  getPrinterAttributesRequest,
  type IppMessage,
  TAG,
} from "../src/connectors/printers/codec.ts";
import {
  cancelJob,
  getPrinterAttributes,
  printerUrl,
  printJob,
  REQUESTED,
  validateJob,
} from "../src/connectors/printers/client.ts";
import {
  mediaPixels,
  pwgRaster,
  readPwgRaster,
} from "../src/connectors/printers/raster.ts";
import {
  mediaName,
  printerKey,
  toState,
} from "../src/connectors/printers/state.ts";
import { printersFound } from "../src/connectors/printers/found.ts";
import { parseResolve } from "../src/discover.ts";
import { manualClock } from "./clock.ts";

// The fixture is a made-up printer's response built from documentation-style values (test/fixtures/printers/), not a capture.
const fixtureBytes = async () =>
  Uint8Array.from(
    (
      await Bun.file(
        new URL(
          "./fixtures/printers/get-printer-attributes.hex",
          import.meta.url,
        ),
      ).text()
    )
      .replace(/\s/g, "")
      .match(/../g)!
      .map((h) => parseInt(h, 16)),
  );
const UUID = "00000000-0000-4000-8000-0000000000a1";
const KEY = printerKey(UUID);
const AT = "2026-10-14T00:00:00.000Z";

describe("codec", () => {
  test("the request is the bytes RFC 8010 lays out", () => {
    const bytes = getPrinterAttributesRequest(
      "ipp://p/ipp",
      ["printer-state", "marker-names"],
      7,
    );
    const text = (s: string) => [...new TextEncoder().encode(s)];
    const be16 = (n: number) => [n >> 8, n & 255];
    const attr = (tag: number, name: string, value: string) => [
      tag,
      ...be16(name.length),
      ...text(name),
      ...be16(value.length),
      ...text(value),
    ];
    expect([...bytes]).toEqual([
      2,
      0,
      0x00,
      0x0b,
      0,
      0,
      0,
      7, // IPP 2.0, Get-Printer-Attributes, request id 7
      0x01, // operation-attributes
      ...attr(0x47, "attributes-charset", "utf-8"),
      ...attr(0x48, "attributes-natural-language", "en"),
      ...attr(0x45, "printer-uri", "ipp://p/ipp"),
      ...attr(0x44, "requested-attributes", "printer-state"),
      0x44,
      0,
      0,
      ...be16("marker-names".length),
      ...text("marker-names"), // a further value: the same tag, an empty name
      0x03,
    ]);
  });

  test("every tag type round-trips; repeated values stay one attribute", () => {
    const m: IppMessage = {
      version: [2, 0],
      code: 0x0000,
      requestId: 9,
      groups: [
        {
          tag: TAG.printer,
          attributes: [
            { name: "an-integer", tag: TAG.integer, values: [-3, 100] },
            { name: "a-boolean", tag: TAG.boolean, values: [true, false] },
            { name: "an-enum", tag: TAG.enum, values: [4] },
            { name: "a-keyword", tag: TAG.keyword, values: ["a", "b", "c"] },
            {
              name: "a-name",
              tag: TAG.nameWithoutLanguage,
              values: ["Black Toner"],
            },
            {
              name: "a-text",
              tag: TAG.textWithoutLanguage,
              values: ["ünïcode"],
            },
            { name: "a-uri", tag: TAG.uri, values: ["ipp://x/y"] },
            {
              name: "some-bytes",
              tag: TAG.octetString,
              values: [Uint8Array.of(0, 1, 255)],
            },
            {
              name: "a-range",
              tag: TAG.rangeOfInteger,
              values: [{ lower: 1, upper: 99 }],
            },
            {
              name: "a-resolution",
              tag: TAG.resolution,
              values: [{ x: 600, y: 600, units: "dpi" }],
            },
            {
              name: "a-date",
              tag: TAG.dateTime,
              values: ["2026-10-14T01:02:03.4+10:00"],
            },
          ],
        },
        {
          tag: TAG.job,
          attributes: [{ name: "job-id", tag: TAG.integer, values: [1] }],
        },
      ],
    };
    expect(decodeMessage(encodeMessage(m))).toEqual(m);
  });

  test("a printer's fixture decodes; the data after the attributes is kept", async () => {
    const m = decodeMessage(await fixtureBytes());
    expect(m).toMatchObject({ version: [2, 0], code: 0, requestId: 1 });
    expect(m.groups.map((g) => g.tag)).toEqual([TAG.operation, TAG.printer]);
    expect(attributesOf(m)["marker-levels"]).toEqual([40, 85]);
    const withData = decodeMessage(Uint8Array.of(...encodeMessage(m), 9, 9));
    expect(withData.data).toEqual(Uint8Array.of(9, 9));
  });

  test("a tag it does not read is kept as bytes, not thrown; so is a wrong length and a collection", () => {
    const e = (tag: number, name: string, value: number[]) => [
      tag,
      0,
      name.length,
      ...new TextEncoder().encode(name),
      0,
      value.length,
      ...value,
    ];
    const bytes = Uint8Array.of(
      2,
      0,
      0,
      0,
      0,
      0,
      0,
      1,
      0x04,
      ...e(0x35, "with-language", [0, 2, 0x65, 0x6e, 0, 1, 0x78]), // textWithLanguage: not read
      ...e(0x7f, "mystery", [1, 2, 3]), // a tag no one has defined
      ...e(0x13, "no-value", []), // out-of-band
      ...e(0x21, "short-integer", [1, 2]), // an integer must be 4 bytes
      ...e(0x34, "media-col-ready", []), // begCollection …
      ...e(
        0x4a,
        "",
        [..."media-size"].map((c) => c.charCodeAt(0)),
      ), // …memberAttrName
      ...e(0x34, "", []), // …a nested collection
      ...e(0x21, "", [0, 0, 0, 1]),
      ...e(0x37, "", []),
      ...e(0x37, "", []), // …end
      ...e(0x21, "after", [0, 0, 0, 5]), // reading goes on after the collection
      0x03,
    );
    const a = attributesOf(decodeMessage(bytes));
    expect(a["with-language"]![0]).toMatchObject({ tag: 0x35 });
    expect(a.mystery).toEqual([{ tag: 0x7f, bytes: Uint8Array.of(1, 2, 3) }]);
    expect(a["no-value"]).toEqual([{ tag: 0x13, bytes: new Uint8Array() }]);
    expect(a["short-integer"]).toEqual([
      { tag: 0x21, bytes: Uint8Array.of(1, 2) },
    ]);
    expect(a["media-col-ready"]).toEqual([
      { tag: 0x34, bytes: new Uint8Array() },
    ]);
    expect(a.after).toEqual([5]);
  });

  test("a message cut short throws", async () => {
    const bytes = await fixtureBytes();
    expect(() => decodeMessage(bytes.subarray(0, 40))).toThrow("ipp:");
    expect(() => decodeMessage(Uint8Array.of(2, 0))).toThrow("ipp:");
  });
});

describe("toState", () => {
  test("the fixture: idle, a toner at 40%, A4 loaded", async () => {
    const r = toState(attributesOf(decodeMessage(await fixtureBytes())));
    expect(r).toMatchObject({
      uuid: `urn:uuid:${UUID}`,
      model: "Example Laser 1000 series",
      state: "idle",
      stateCode: 3,
      reasons: ["toner-low-warning"],
      message: "Sleep",
      queuedJobs: 0,
      acceptingJobs: true,
      media: ["iso_a4_210x297mm"],
      formats: [
        "application/octet-stream",
        "application/pdf",
        "image/jpeg",
        "image/urf",
      ],
      ippVersions: ["1.0", "1.1", "2.0"],
      alerts: ["index=1;code=toner-low;severity=warning"],
      markers: [
        { name: "Black Toner", level: 40, type: "toner", color: "#000000" },
        { name: "Drum Unit", level: 85, type: "opc", color: "none" },
      ],
    });
    expect(r.anomaly).toBeUndefined();
  });

  test("every field is optional: nothing sent, nothing made up", () => {
    expect(toState({})).toEqual({
      anomaly: undefined,
      markers: undefined,
      state: undefined,
      stateCode: undefined,
      model: undefined,
      uuid: undefined,
      reasons: undefined,
      message: undefined,
      media: undefined,
      queuedJobs: undefined,
      acceptingJobs: undefined,
      formats: undefined,
      ippVersions: undefined,
      alerts: undefined,
    });
  });

  test("an odd state and an odd level pass through, flagged", () => {
    const r = toState({
      "printer-state": [7],
      "marker-names": ["Black", "Cyan"],
      "marker-levels": [-3, 140],
    });
    expect(r.state).toBeUndefined();
    expect(r.stateCode).toBe(7);
    expect(r.markers).toEqual(
      [
        { name: "Black", level: -3 },
        { name: "Cyan", level: 140 },
      ].map((m) => ({ type: undefined, color: undefined, ...m })),
    );
    expect(r.anomaly).toBe(
      "printer-state 7, not 3 (idle), 4 (processing) or 5 (stopped); marker Black level -3, outside 0 to 100; marker Cyan level 140, outside 0 to 100",
    );
  });

  test("marker lists that disagree are named, and nothing is dropped", () => {
    const r = toState({
      "marker-names": ["A", "B", "C"],
      "marker-levels": [1, 2],
    });
    expect(r.markers).toHaveLength(3);
    expect(r.anomaly).toBe("marker lists of different lengths (3, 2)");
  });

  test("processing is printing, stopped is stopped", () => {
    expect(toState({ "printer-state": [4] }).state).toBe("printing");
    expect(toState({ "printer-state": [5] }).state).toBe("stopped");
  });
});

describe("lines", () => {
  const base: Printer = { uuid: KEY, name: "Office", ipps: false, asOf: AT };
  const state = (...ps: Printer[]): PrintersState => ({
    printers: Object.fromEntries(ps.map((p) => [p.uuid, p])),
    asOf: AT,
  });
  test("a count, then one line each: state, markers, media", () => {
    const toner = {
      ...base,
      state: "idle" as const,
      markers: [{ name: "toner", level: 40 }],
      media: ["iso_a4_210x297mm", "na_letter_8.5x11in"],
    };
    expect(
      manifest.lines({ status: "connected", state: state(toner) }),
    ).toEqual(["1 printer", "Office: idle · toner 40% · A4, Letter ready"]);
  });
  test("offline says when it was last seen; never seen says so", () => {
    const seen = {
      ...base,
      state: "offline" as const,
      lastSeen: "2026-10-13T22:00:00.000Z",
    };
    const never = {
      ...base,
      uuid: "b",
      name: "Spare",
      state: "offline" as const,
    };
    expect(
      manifest.lines({ status: "connected", state: state(seen, never) }),
    ).toEqual([
      "2 printers",
      "Office: offline, last seen 2 h ago",
      "Spare: offline, never seen",
    ]);
    expect(
      manifest.lines({
        status: "connected",
        state: state({ ...seen, lastSeen: "2026-10-11T00:00:00.000Z" }),
      })[1],
    ).toBe("Office: offline, last seen 3 days ago");
  });
  test("a queue, a refusal and a warning show; a missing level shows ?", () => {
    const p = {
      ...base,
      state: "stopped" as const,
      queuedJobs: 2,
      acceptingJobs: false,
      reasons: ["none", "media-empty-error", "toner-low-report"],
      markers: [{ name: "toner" }],
    };
    expect(manifest.lines({ status: "connected", state: state(p) })[1]).toBe(
      "Office: stopped · toner ?% · 2 queued · not accepting jobs · media-empty-error",
    );
  });
  test("no state, no lines", () => {
    expect(manifest.lines({ status: "disconnected" })).toEqual([]);
  });
  test("media names", () => {
    expect(
      [
        "iso_a4_210x297mm",
        "na_letter_8.5x11in",
        "na_legal_8.5x14in",
        "iso_a5_148x210mm",
        "A4",
      ].map(mediaName),
    ).toEqual(["A4", "Letter", "Legal", "A5", "A4"]);
  });
});

describe("discovery", () => {
  test("TXT: the UUID is the id, ty the name and model, the whole record kept", () => {
    const txt = {
      UUID: UUID,
      ty: "Example Laser 1000 series",
      rp: "ipp/print",
      pdl: "application/pdf,image/urf",
      URF: "CP1,W8",
      adminurl: "http://printer.local./",
    };
    const [f] = printersFound(
      [{ host: "192.0.2.20", port: 631, instance: "Example Laser", txt }],
      [],
    );
    expect(f).toEqual({
      connector: "printers",
      id: UUID,
      host: "192.0.2.20",
      port: 631,
      name: "Example Laser 1000 series",
      model: "Example Laser 1000 series",
      secure: false,
      txt: Object.fromEntries(
        Object.entries(txt).map(([k, v]) => [k.toLowerCase(), v]),
      ),
    });
  });
  test("no UUID: the instance name is the id and the name; no ty: no model", () => {
    const [f] = printersFound(
      [{ host: "192.0.2.20", port: 631, instance: "Hall Printer", txt: {} }],
      [],
    );
    expect(f).toMatchObject({
      id: "Hall Printer",
      name: "Hall Printer",
      model: undefined,
    });
  });
  test("one printer on both types is one entry, the plain one; ipps alone is secure", () => {
    const a = { host: "192.0.2.20", instance: "A", txt: { uuid: UUID } };
    const b = {
      host: "192.0.2.21",
      instance: "B",
      txt: { UUID: "00000000-0000-4000-8000-0000000000b2" },
    };
    const found = printersFound(
      [{ ...a, port: 631 }],
      [
        { ...a, port: 443 },
        { ...b, port: 443 },
      ],
    );
    expect(found.map((f) => [f.host, f.port, f.secure])).toEqual([
      ["192.0.2.20", 631, false],
      ["192.0.2.21", 443, true],
    ]);
  });
  test("dns-sd's resolve output for a printer: escaped TXT values", () => {
    const out =
      "Lookup Example Laser._ipp._tcp.local\nDATE: ---Wed 14 Oct 2026---\n10:00:00.000  Example\\032Laser._ipp._tcp.local. can be reached at printer.local.:631 (interface 15)\n UUID=00000000-0000-4000-8000-0000000000a1 ty=Example\\ Laser\\ 1000\\ series rp=ipp/print pdl=application/pdf,image/urf\n";
    const r = parseResolve(out)!;
    expect(r.port).toBe(631);
    expect(
      printersFound(
        [
          {
            host: "192.0.2.20",
            port: r.port,
            instance: "Example Laser",
            txt: r.txt,
          },
        ],
        [],
      )[0],
    ).toMatchObject({ id: UUID, name: "Example Laser 1000 series" });
  });
  test("--write adds a printer by uuid, with its port, and knows it afterwards", () => {
    const f: Found = {
      connector: "printers",
      id: UUID,
      host: "192.0.2.20",
      port: 631,
      name: "Example Laser 1000 series",
    };
    const config = checkHome({ devices: [] }, {}).config!;
    const match = matchFound(config, [f]);
    expect(match.added[0]!.entry).toEqual({
      id: "example-laser-1000-series",
      connector: "printers",
      name: "Example Laser 1000 series",
      uuid: UUID,
      host: "192.0.2.20",
      port: 631,
    });
    const text = applyFound('{\n  "devices": []\n}\n', match, false);
    const written = checkHome(JSON.parse(text), {});
    expect(written.problems).toEqual([]);
    const again = matchFound(written.config!, [
      { ...f, host: "192.0.2.99" },
      { ...f, id: "00000000-0000-4000-8000-0000000000b2", host: "192.0.2.21" },
    ]);
    expect(again.moved).toMatchObject([
      { id: "example-laser-1000-series", from: "192.0.2.20", to: "192.0.2.99" },
    ]);
    expect(again.added).toHaveLength(1); // a second printer is added: many are allowed
  });
});

describe("client", () => {
  test("POST application/ipp to http://host:port/rp; the request names the ipp URI", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const body = await fixtureBytes();
    const fetcher = (async (url: string, init: RequestInit) => (
      seen.push({ url, init }),
      new Response(body)
    )) as unknown as typeof fetch;
    const m = await getPrinterAttributes(
      fetcher,
      { host: "192.0.2.20", port: 631, rp: "/printers/laser" },
      { requestId: 3 },
    );
    expect(m.code).toBe(0);
    expect(seen[0]!.url).toBe("http://192.0.2.20:631/printers/laser");
    expect(seen[0]!.init.method).toBe("POST");
    expect(
      (seen[0]!.init.headers as Record<string, string>)["content-type"],
    ).toBe("application/ipp");
    const sent = attributesOf(
      decodeMessage(seen[0]!.init.body as Uint8Array),
      TAG.operation,
    );
    expect(sent["printer-uri"]).toEqual([
      "ipp://192.0.2.20:631/printers/laser",
    ]);
    expect(sent["requested-attributes"]).toEqual(REQUESTED);
  });
  test("port 443 or a found ipps is https and ipps://", () => {
    expect(printerUrl({ host: "h", port: 443 })).toMatchObject({
      http: "https://h:443/ipp/print",
      ipp: "ipps://h:443/ipp/print",
      secure: true,
    });
    expect(printerUrl({ host: "h", secure: true })).toMatchObject({
      http: "https://h:443/ipp/print",
    });
    expect(printerUrl({ host: "h" })).toMatchObject({
      http: "http://h:631/ipp/print",
      secure: false,
    });
    expect(printerUrl({ host: "fe80::1", port: 631, rp: "x" }).http).toBe(
      "http://[fe80::1]:631/x",
    );
  });
  test("an HTTP error and an IPP error both throw, saying which", async () => {
    const no = (async () =>
      new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(getPrinterAttributes(no, { host: "h" })).rejects.toThrow(
      "HTTP 404 on POST /ipp/print",
    );
    const refused = encodeMessage({
      version: [2, 0],
      code: 0x0406,
      requestId: 1,
      groups: [
        {
          tag: TAG.operation,
          attributes: [
            {
              name: "status-message",
              tag: TAG.textWithoutLanguage,
              values: ["no such printer"],
            },
          ],
        },
      ],
    });
    const ipp = (async () => new Response(refused)) as unknown as typeof fetch;
    await expect(getPrinterAttributes(ipp, { host: "h" })).rejects.toThrow(
      "IPP client-error-not-found: no such printer",
    );
  });
});

describe("jobs", () => {
  /** A printer that records each request and answers Print-Job with a job id. */
  function jobPrinter() {
    const sent: IppMessage[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      const m = decodeMessage(init.body as Uint8Array);
      sent.push(m);
      return new Response(
        encodeMessage({
          version: [2, 0],
          code: 0,
          requestId: m.requestId,
          groups: [
            { tag: TAG.operation, attributes: [] },
            {
              tag: TAG.job,
              attributes: [
                { name: "job-id", tag: TAG.integer, values: [346] },
                { name: "job-state", tag: TAG.enum, values: [5] },
                {
                  name: "job-state-reasons",
                  tag: TAG.keyword,
                  values: ["job-printing"],
                },
              ],
            },
          ],
        }),
      );
    }) as unknown as typeof fetch;
    return { sent, fetcher };
  }
  const job = { format: "image/pwg-raster", media: "iso_a4_210x297mm" };

  test("Print-Job sends the job's attributes and the document after them; one-sided unless asked", async () => {
    const p = jobPrinter();
    const doc = Uint8Array.of(1, 2, 3);
    expect(await printJob(p.fetcher, { host: "h" }, job, doc)).toEqual({
      jobId: 346,
      state: 5,
      reasons: ["job-printing"],
    });
    const m = p.sent[0]!;
    expect(m.code).toBe(0x0002);
    expect(attributesOf(m, TAG.operation)["document-format"]).toEqual([
      "image/pwg-raster",
    ]);
    expect(attributesOf(m, TAG.job)).toEqual({
      sides: ["one-sided"],
      media: ["iso_a4_210x297mm"],
    });
    expect(m.data).toEqual(doc);
  });

  test("Validate-Job carries the same attributes and no document; Cancel-Job names the job", async () => {
    const p = jobPrinter();
    await validateJob(p.fetcher, { host: "h" }, job);
    await cancelJob(p.fetcher, { host: "h" }, 346);
    expect(p.sent[0]!.code).toBe(0x0004);
    expect(p.sent[0]!.data?.length ?? 0).toBe(0);
    expect(attributesOf(p.sent[0]!, TAG.job).sides).toEqual(["one-sided"]);
    expect(p.sent[1]!.code).toBe(0x0008);
    expect(attributesOf(p.sent[1]!, TAG.operation)["job-id"]).toEqual([346]);
  });

  test("a Print-Job that times out says it may still print", async () => {
    const slow = (async () => {
      throw new DOMException("timed out", "TimeoutError");
    }) as unknown as typeof fetch;
    await expect(
      printJob(slow, { host: "h" }, job, Uint8Array.of(1)),
    ).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("PWG raster", () => {
  // Made by macOS's own filters (cupsfilter, the Brother's AirPrint PPD) from a one-line text page; it printed on an HL-L2350DW.
  const macos = async () =>
    new Uint8Array(
      await Bun.file(
        new URL("./fixtures/printers/macos-a4-600.pwg", import.meta.url),
      ).arrayBuffer(),
    );
  const A4 = { name: "iso_a4_210x297mm", dpi: 600 };

  test("a page macOS made decodes: A4 at 600 dpi, 8-bit grey, some black on white", async () => {
    const [page, more] = readPwgRaster(await macos());
    expect(more).toBeUndefined();
    expect(page).toMatchObject({
      width: 4960,
      height: 7015,
      dpi: 600,
      colorSpace: 18,
      bitsPerPixel: 8,
    });
    expect(mediaPixels(A4)).toEqual({ width: 4960, height: 7015 });
    const ink = page!.pixels.filter((p) => p < 128).length;
    expect(ink).toBeGreaterThan(1000);
    expect(ink).toBeLessThan(page!.pixels.length / 50);
  });

  test("its pixels encoded here decode to the same pixels, with the header PWG 5102.4 asks for", async () => {
    const [page] = readPwgRaster(await macos());
    const ours = pwgRaster([page!], A4);
    const [back] = readPwgRaster(ours);
    expect(back).toMatchObject({
      width: 4960,
      height: 7015,
      dpi: 600,
      colorSpace: 18,
      bitsPerPixel: 8,
      pageSizeName: "iso_a4_210x297mm",
    });
    expect(back!.pixels).toEqual(page!.pixels);
    expect(ours.length).toBeLessThan(80_000); // a mostly white page packs small
  });

  test("runs, literals and lone pixels round-trip, and a short page is refused", () => {
    const width = 300;
    const row = Uint8Array.from({ length: width }, (_, i) =>
      i < 140 ? 255 : i < 200 ? i % 256 : i % 3 ? 0 : 7,
    );
    const pixels = new Uint8Array(width * 4);
    pixels.set(row, 0);
    pixels.set(row, width); // a repeated line
    pixels.set(row.toReversed(), width * 2);
    pixels.fill(9, width * 3);
    const [back] = readPwgRaster(pwgRaster([{ width, height: 4, pixels }], A4));
    expect(back!.pixels).toEqual(pixels);
    expect(() =>
      pwgRaster([{ width, height: 4, pixels: new Uint8Array(3) }], A4),
    ).toThrow("needs 1200 bytes");
  });
});

describe("the integration", () => {
  /** A printer that answers while `up.on`, with the fixture's values and a replaceable marker level. */
  function fake(
    up: { on: boolean; level?: number; uuid?: string },
    urls: string[] = [],
  ) {
    return (async (url: string) => {
      urls.push(String(url));
      if (!up.on) throw new Error("connection refused");
      const m = decodeMessage(await fixtureBytes());
      const a = m.groups[1]!.attributes;
      if (up.level !== undefined)
        a.find((x) => x.name === "marker-levels")!.values = [up.level, 85];
      if (up.uuid)
        a.find((x) => x.name === "printer-uuid")!.values = [
          `urn:uuid:${up.uuid}`,
        ];
      return new Response(encodeMessage(m));
    }) as unknown as typeof fetch;
  }
  // Discovery's gap between passes passes at once, so a test needs no advance for it.
  function clocks() {
    const { clock, advance } = manualClock();
    const quick: Clock = {
      now: clock.now,
      sleep: (ms, signal) =>
        ms === DISCOVERY_GAP_MS ? Promise.resolve() : clock.sleep(ms, signal),
    };
    return { clock: quick, advance };
  }
  async function run(integration: ReturnType<typeof printers>) {
    const stop = new AbortController();
    const parts: Part<PrintersState>[] = [];
    const running = integration.run(stop.signal, (p) => parts.push(p));
    await Bun.sleep(20);
    return {
      parts,
      last: () => parts.at(-1)!,
      stop: async () => (stop.abort(), await running),
    };
  }
  const entry = { uuid: UUID, name: "Office", host: "192.0.2.20", port: 631 };

  test("reads a configured printer, then keeps it as offline with its last values and lastSeen when it goes quiet", async () => {
    const up = { on: true };
    const { clock, advance } = clocks();
    const r = await run(
      printers({ printers: [entry], fetch: fake(up), clock, pollMs: 120_000 }),
    );
    expect(r.last().status).toBe("connected");
    expect(r.last().state!.printers[KEY]).toMatchObject({
      name: "Office",
      state: "idle",
      model: "Example Laser 1000 series",
      ipps: false,
      host: "192.0.2.20",
      lastSeen: "1970-01-01T00:00:00.000Z",
    });
    up.on = false;
    await advance(120_000);
    const p = r.last().state!.printers[KEY]!;
    expect(p).toMatchObject({
      state: "offline",
      lastSeen: "1970-01-01T00:00:00.000Z",
    });
    expect(p.markers![0]).toMatchObject({ name: "Black Toner", level: 40 });
    expect(p.detail).toBe("connection refused");
    expect(p.anomaly).toBeUndefined();
    expect(r.last()).toMatchObject({
      status: "disconnected",
      detail: "Office offline",
    }); // never unavailable for being unreachable
    up.on = true;
    await advance(120_000);
    expect(r.last().state!.printers[KEY]).toMatchObject({
      state: "idle",
      detail: undefined,
      lastSeen: "1970-01-01T00:04:00.000Z",
    });
    await r.stop();
  });

  test("after offlineDays without an answer the entry says so in anomaly, and still is not unavailable", async () => {
    const up = { on: true };
    const { clock, advance } = clocks();
    const r = await run(
      printers({
        printers: [{ ...entry, offlineDays: 2 }],
        fetch: fake(up),
        clock,
        pollMs: 3_600_000,
      }),
    );
    up.on = false;
    await advance(3_600_000 * 24);
    expect(r.last().state!.printers[KEY]!.anomaly).toBeUndefined();
    expect(r.last().state!.printers[KEY]!.detail).toContain(
      "no answer for a day",
    );
    await advance(3_600_000 * 30);
    expect(r.last().state!.printers[KEY]!.anomaly).toBe("no answer for 2 days");
    expect(r.last().anomaly).toBe("Office: no answer for 2 days");
    expect(r.last().status).toBe("disconnected");
    await r.stop();
  });

  test("an odd reading is flagged in the entry and the part", async () => {
    const { clock } = clocks();
    const r = await run(
      printers({
        printers: [entry],
        fetch: fake({ on: true, level: 300 }),
        clock,
      }),
    );
    expect(r.last().state!.printers[KEY]!.anomaly).toBe(
      "marker Black Toner level 300, outside 0 to 100",
    );
    expect(r.last().state!.printers[KEY]!.markers![0]!.level).toBe(300);
    expect(r.last().anomaly).toContain("Office: marker Black Toner level 300");
    await r.stop();
  });

  test("an address that answers as another printer is a failure, not a reading", async () => {
    const { clock } = clocks();
    const r = await run(
      printers({
        printers: [entry],
        fetch: fake({ on: true, uuid: "00000000-0000-4000-8000-0000000000ff" }),
        clock,
      }),
    );
    expect(r.last().state!.printers[KEY]).toMatchObject({
      state: "offline",
      detail: "the address answers as another printer",
    });
    await r.stop();
  });

  test("discovery adds a printer the config lacks, with its rp and TLS from the TXT, and names it by ty", async () => {
    const urls: string[] = [];
    const { clock } = clocks();
    const find = async (): Promise<Found[]> => [
      {
        connector: "printers",
        id: UUID,
        host: "192.0.2.30",
        port: 443,
        name: "Example Laser 1000 series",
        model: "Example Laser 1000 series",
        secure: true,
        txt: { rp: "ipp/print" },
      },
    ];
    const r = await run(
      printers({ fetch: fake({ on: true }, urls), find, clock }),
    );
    expect(urls).toEqual(["https://192.0.2.30:443/ipp/print"]);
    expect(r.last().state!.printers[KEY]).toMatchObject({
      name: "Example Laser 1000 series",
      host: "192.0.2.30",
      ipps: true,
      state: "idle",
    });
    await r.stop();
  });

  test("a printer that moved is found by its uuid and read at once at the new address", async () => {
    const urls: string[] = [];
    const seen: string[] = [];
    const { clock } = clocks();
    const find = async (): Promise<Found[]> => [
      {
        connector: "printers",
        id: UUID,
        host: "192.0.2.77",
        port: 631,
        txt: {},
      },
    ];
    const fetcher = (async (url: string) => {
      urls.push(url);
      if (url.includes("192.0.2.20")) throw new Error("no route to host");
      return new Response(await fixtureBytes());
    }) as unknown as typeof fetch;
    const r = await run(
      printers({
        printers: [entry],
        fetch: fetcher,
        find,
        clock,
        seen: (_, a) => seen.push(a.host),
      }),
    );
    expect(urls).toEqual([
      "http://192.0.2.20:631/ipp/print",
      "http://192.0.2.77:631/ipp/print",
    ]);
    expect(r.last().state!.printers[KEY]).toMatchObject({
      name: "Office",
      state: "idle",
      host: "192.0.2.77",
    });
    expect(seen).toEqual(["192.0.2.77"]);
    await r.stop();
  });

  test("a printer known by host alone is read again at once when discovery gives its path", async () => {
    const urls: string[] = [];
    const { clock } = clocks();
    const find = async (): Promise<Found[]> => [
      {
        connector: "printers",
        id: UUID,
        host: "192.0.2.20",
        port: 631,
        txt: { rp: "ipp/printer" },
      },
    ];
    const fetcher = (async (url: string) => {
      urls.push(url);
      if (url.endsWith("/ipp/print")) return new Response("", { status: 404 });
      return new Response(await fixtureBytes());
    }) as unknown as typeof fetch;
    const r = await run(
      printers({ printers: [entry], fetch: fetcher, find, clock }),
    );
    expect(urls).toEqual([
      "http://192.0.2.20:631/ipp/print",
      "http://192.0.2.20:631/ipp/printer",
    ]);
    expect(r.last().state!.printers[KEY]).toMatchObject({ state: "idle" });
    await r.stop();
  });

  test("a printer discovery cannot find says so; a failed discovery says that", async () => {
    const { clock } = clocks();
    const none = await run(
      printers({
        printers: [entry],
        fetch: fake({ on: false }),
        find: async () => [],
        clock,
      }),
    );
    expect(none.last().state!.printers[KEY]!.detail).toBe(
      "not found by discovery; connection refused",
    );
    await none.stop();
    const broke = await run(
      printers({
        printers: [entry],
        fetch: fake({ on: false }),
        find: async () => Promise.reject(new Error("dns-sd not found")),
        clock,
      }),
    );
    expect(broke.last().detail).toContain("discovery failed: dns-sd not found");
    expect(broke.last().state!.printers[KEY]!.detail).toBe(
      "discovery failed: dns-sd not found; connection refused",
    );
    await broke.stop();
  });

  test("refresh reads now", async () => {
    const urls: string[] = [];
    const { clock } = clocks();
    const p = printers({
      printers: [entry],
      fetch: fake({ on: true }, urls),
      clock,
    });
    const r = await run(p);
    expect(urls).toHaveLength(1);
    p.refresh();
    await Bun.sleep(20);
    expect(urls).toHaveLength(2);
    await r.stop();
  });
});

describe("config", () => {
  const printer = {
    id: "office",
    connector: "printers",
    name: "Office",
    uuid: UUID,
    host: "192.0.2.20",
    port: 631,
  };
  test("any number of printers; the same uuid twice is a problem", () => {
    expect(
      checkHome(
        {
          devices: [
            printer,
            {
              ...printer,
              id: "hall",
              uuid: "00000000-0000-4000-8000-0000000000b2",
            },
          ],
        },
        {},
      ).problems,
    ).toEqual([]);
    expect(
      checkHome(
        {
          devices: [
            printer,
            { ...printer, id: "again", uuid: UUID.toUpperCase() },
          ],
        },
        {},
      ).problems,
    ).toEqual([
      "devices[1] (again).uuid: the same printer as devices[0] (office)",
    ]);
  });
  test("loadHome makes one integration for every printer, with the config's offlineDays", async () => {
    const homes = loadHome(
      {
        devices: [
          printer,
          {
            ...printer,
            id: "hall",
            name: "Hall",
            uuid: "00000000-0000-4000-8000-0000000000b2",
            host: "192.0.2.21",
            offlineDays: 3,
          },
        ],
      },
      {
        env: {},
        fetch: (async () =>
          new Response(await fixtureBytes())) as unknown as typeof fetch,
      },
    );
    expect(homes.map((h) => h.name)).toEqual(["printers"]);
    const stop = new AbortController();
    let last: Part | undefined;
    const running = homes[0]!.run(stop.signal, (p) => (last = p));
    await Bun.sleep(20);
    expect(
      Object.values((last!.state as PrintersState).printers)
        .map((p) => p.name)
        .sort(),
    ).toEqual(["Hall", "Office"]);
    stop.abort();
    await running;
  });
});
