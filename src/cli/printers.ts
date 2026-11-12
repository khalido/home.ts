// Printers without a config: what `home status`, `home printers` and `home probe` run. Cached addresses first, then
// discovery (AirPrint over mDNS) finds the rest.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  cancelJob,
  getPrinterAttributes,
  identifyPrinter,
  type PrinterAddress,
  type PrintJob,
  printJob,
  validateJob,
} from "../connectors/printers/client.ts";
import { attributesOf } from "../connectors/printers/codec.ts";
import {
  printerList,
  printers,
  type PrintersState,
} from "../connectors/printers/index.ts";
import {
  type GreyPage,
  mediaPixels,
  pwgRaster,
  type RasterMedia,
} from "../connectors/printers/raster.ts";
import { printerKey } from "../connectors/printers/state.ts";
import { addressBook } from "../discover.ts";
import { FINDERS } from "../finders.ts";
import { settle } from "../home.ts";
import { addresses, fail, usage, type Verbs } from "./context.ts";

/** Every printer the address cache knows plus whatever discovery finds, read once. */
export function printersNow() {
  const book = addressBook(addresses.cache);
  const known = Object.entries(book.entries()).flatMap(([key, c]) =>
    key.startsWith("printers:")
      ? [{ uuid: key.slice(9), name: c.name, host: c.host, port: c.port }]
      : [],
  );
  return printers({
    printers: known,
    find: FINDERS.printers,
    seen: (uuid, a) => book.seen("printers", uuid, a),
  });
}

// `home printers identify | print | cancel`: the writes. A printer that lists no PDF gets PWG Raster, rendered here with
// poppler's pdftoppm (the one tool this needs; `brew install poppler`, `apt install poppler-utils`).
// Live 2026-11-12 on a Brother HL-L2350DW (Bun 1.4.4): identify, validate and one A4 page.

export const PRINTERS_USAGE =
  "usage: home printers identify [printer] | print <file.pdf> [printer] | cancel <job> [printer]";

/** One printer by name or UUID, or the only one there is; with its address. */
async function onePrinter(name: string | undefined) {
  const part = (await settle([printersNow()], { ms: 15_000 })).printers!;
  const all = printerList(
    (part.state as PrintersState | undefined) ?? { printers: {}, asOf: "" },
  );
  const p = name
    ? (all.find((x) => x.uuid === printerKey(name)) ??
      all.find((x) => x.name.toLowerCase() === name.toLowerCase()))
    : all.length === 1
      ? all[0]
      : undefined;
  if (!p)
    return fail(
      name
        ? `no printer named ${name}; \`home printers\` lists them`
        : all.length
          ? `${all.length} printers: name one (${all.map((x) => x.name).join(", ")})`
          : "no printer found; `home discover` looks for them",
      name || !all.length ? "error" : "usage",
    );
  if (p.state === "offline" || !p.host)
    return fail(`${p.name} is offline`, "network");
  const address: PrinterAddress = {
    host: p.host,
    port: p.port,
    rp: p.rp,
    secure: p.ipps,
  };
  return { printer: p, address };
}

/** What the printer takes, asked for once before a print. */
async function capabilities(address: PrinterAddress) {
  const a = attributesOf(
    await getPrinterAttributes(fetch, address, {
      requested: [
        "document-format-supported",
        "pwg-raster-document-resolution-supported",
        "pwg-raster-document-type-supported",
        "media-ready",
        "media-default",
      ],
    }),
  );
  const strings = (k: string) =>
    (a[k] ?? []).filter((v): v is string => typeof v === "string");
  const dpis = (a["pwg-raster-document-resolution-supported"] ?? []).flatMap(
    (r) =>
      typeof r === "object" && "x" in r && r.units === "dpi" && r.x === r.y
        ? [r.x]
        : [],
  );
  return {
    formats: strings("document-format-supported"),
    rasterTypes: strings("pwg-raster-document-type-supported"),
    dpis,
    media: strings("media-ready")[0] ?? strings("media-default")[0],
  };
}

/**
 * A PDF's pages as 8-bit grey, one at a time, each fitted to the media and centred on white, through pdfinfo and
 * pdftoppm. A page's `/Rotate` is applied, as pdftoppm does; a landscape page is shrunk to fit, not turned.
 */
function renderPdf(
  file: string,
  media: RasterMedia,
): { count: number; pages: Iterable<GreyPage> } {
  const run = (command: string, args: string[]) => {
    const r = spawnSync(command, args, { maxBuffer: 1 << 30 });
    if (r.error)
      fail(
        `${command} is not installed: it renders the PDF for a printer that takes no PDF`,
        "error",
        process.platform === "darwin"
          ? "brew install poppler"
          : "sudo apt install poppler-utils",
      );
    if (r.status !== 0) fail(`${command}: ${r.stderr.toString().trim()}`);
    return r.stdout;
  };
  const info = run("pdfinfo", ["-l", "9999", file]).toString();
  const turned = new Map(
    [...info.matchAll(/^Page\s+(\d+) rot:\s+(\d+)/gm)].map((m) => [
      Number(m[1]),
      Number(m[2]) % 180 === 90,
    ]),
  );
  const sizes = [
    ...info.matchAll(/^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+) pts/gm),
  ].map((m) =>
    turned.get(Number(m[1]))
      ? { w: Number(m[3]), h: Number(m[2]) }
      : { w: Number(m[2]), h: Number(m[3]) },
  );
  if (!sizes.length) fail(`${file}: pdfinfo found no pages`);
  const out = mediaPixels(media);
  function* pages(): Generator<GreyPage> {
    for (const [i, size] of sizes.entries()) {
      // The largest resolution at which the page fits the media, so nothing is cut off; never above the printer's.
      const r = Math.min(
        media.dpi,
        (out.width / size.w) * 72,
        (out.height / size.h) * 72,
      );
      const pgm = run("pdftoppm", [
        "-gray",
        "-r",
        r.toFixed(3),
        "-f",
        String(i + 1),
        "-l",
        String(i + 1),
        "-singlefile",
        file,
      ]);
      const head = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(
        pgm.subarray(0, 64).toString("latin1"),
      );
      if (!head)
        return fail(`pdftoppm: page ${i + 1} is not an 8-bit grey image`);
      const w = Number(head[1]);
      const h = Number(head[2]);
      // A pixel over is rounding; more means the size was misread, and a clipped page must not print.
      if (w > out.width + 1 || h > out.height + 1)
        return fail(
          `page ${i + 1} rendered at ${w} × ${h}, larger than ${media.name} (${out.width} × ${out.height}); nothing sent`,
        );
      const pixels = new Uint8Array(out.width * out.height).fill(255);
      const left = Math.max(0, Math.floor((out.width - w) / 2));
      const top = Math.max(0, Math.floor((out.height - h) / 2));
      const from = pgm.subarray(head[0].length);
      for (let y = 0; y < Math.min(h, out.height); y++)
        pixels.set(
          from.subarray(y * w, y * w + Math.min(w, out.width)),
          (top + y) * out.width + left,
        );
      yield { ...out, pixels };
    }
  }
  return { count: sizes.length, pages: pages() };
}

const STATES: Record<number, string> = {
  3: "pending",
  4: "held",
  5: "printing",
  6: "stopped",
  7: "cancelled",
  8: "aborted",
  9: "completed",
};

export const printersVerbs: Verbs = {
  async identify([name, extra], o) {
    if (o.dryRun) usage("home printers identify has no dry run");
    if (extra) usage(PRINTERS_USAGE);
    const { printer, address } = await onePrinter(name);
    await identifyPrinter(fetch, address);
    console.log(`${printer.name}: identify sent`);
  },

  async print([file, name, extra], o) {
    if (!file || extra) return usage(PRINTERS_USAGE);
    if (!/\.pdf$/i.test(file)) return usage(`${file}: only a PDF prints`);
    if (!existsSync(file)) return usage(`${file}: no such file`);
    const { printer, address } = await onePrinter(name);
    const can = await capabilities(address);
    const job: PrintJob = {
      format: "application/pdf",
      name: basename(file),
      media: can.media,
    };
    let document: Uint8Array | undefined;
    let what = `${basename(file)} as PDF`;
    if (!can.formats.includes("application/pdf")) {
      const dpi = can.dpis.includes(600) ? 600 : can.dpis[0];
      if (!can.formats.includes("image/pwg-raster") || !dpi)
        return fail(
          `${printer.name} takes neither PDF nor PWG Raster (it lists ${can.formats.join(", ") || "nothing"})`,
        );
      if (!can.rasterTypes.includes("sgray_8"))
        return fail(
          `${printer.name}'s PWG Raster is ${can.rasterTypes.join(", ")}; only sgray_8 is built`,
        );
      if (!can.media)
        return fail(`${printer.name} reports no media loaded or default`);
      const { count, pages } = renderPdf(file, { name: can.media, dpi });
      document = pwgRaster(pages, { name: can.media, dpi }, count);
      job.format = "image/pwg-raster";
      what = `${count} page${count === 1 ? "" : "s"} of ${can.media} at ${dpi} dpi as PWG Raster (${Math.round(document.length / 1024)} kB)`;
    }
    await validateJob(fetch, address, job); // prints nothing: a dry run checks the job as the printer would
    if (o.dryRun)
      return console.log(
        `dry run, no job sent: the printer accepts it; would print ${what} on ${printer.name}`,
      );
    const done = await printJob(
      fetch,
      address,
      job,
      document ?? readFileSync(file),
    );
    console.log(
      `${printer.name}: job ${done.jobId ?? "?"} ${STATES[done.state ?? 0] ?? "sent"} · ${what}`,
    );
  },

  async cancel([id, name, extra], o) {
    if (o.dryRun) usage("home printers cancel has no dry run");
    const job = Number(id);
    if (!Number.isInteger(job) || extra) return usage(PRINTERS_USAGE);
    const { printer, address } = await onePrinter(name);
    await cancelJob(fetch, address, job);
    console.log(`${printer.name}: job ${job} cancelled`);
  },
};
