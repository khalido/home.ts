// PWG Raster (PWG 5102.4), 8-bit grey only: what an AirPrint printer that lists `image/pwg-raster` takes when it lists no
// PDF. A file is "RaS2", then per page a 1796-byte big-endian header and the page's pixels, compressed line by line:
// a line-repeat byte (the line appears n + 1 times), then runs: 0 to 127 is one pixel repeated n + 1 times, 129 to 255 is
// 257 − n pixels as they are. Checked against a page macOS's own filters made for a Brother (test/fixtures/printers).

/** One page: `pixels` is `width × height` bytes, row by row from the top, 0 black to 255 white. */
export type GreyPage = {
  width: number;
  height: number;
  pixels: Uint8Array;
};

/** What every page is printed as: the printer's resolution and the PWG media name and size it lists. */
export type RasterMedia = {
  /** PWG self-describing name, as the printer lists it in `media-supported`: `iso_a4_210x297mm`. */
  name: string;
  /** dots per inch, one of the printer's `pwg-raster-document-resolution-supported`. */
  dpi: number;
};

const HEADER = 1796;
const SGRAY = 18; // cupsColorSpace for sgray (PWG 5102.4 table 9)
const WHITE = 0xffffff; // AlternatePrimary: the white point, as PWG 5102.4 recommends

/** A PWG media name's size in inches: `iso_a4_210x297mm` is 8.27 × 11.69. */
function mediaInches(name: string): { width: number; height: number } {
  const m = /_(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(mm|in)$/.exec(name);
  if (!m) throw new RangeError(`not a PWG media size: ${name}`);
  const per = m[3] === "mm" ? 1 / 25.4 : 1;
  return { width: Number(m[1]) * per, height: Number(m[2]) * per };
}

/** The pixels a page of this media is at its resolution, rounded down as macOS's filters do: A4 at 600 dpi is 4960 × 7015. */
export function mediaPixels(media: RasterMedia): {
  width: number;
  height: number;
} {
  const i = mediaInches(media.name);
  return {
    width: Math.floor(i.width * media.dpi),
    height: Math.floor(i.height * media.dpi),
  };
}

function header(page: GreyPage, media: RasterMedia, total: number) {
  const h = new Uint8Array(HEADER);
  const v = new DataView(h.buffer);
  const u32 = (offset: number, n: number) => v.setUint32(offset, n);
  const str = (offset: number, s: string) =>
    h.set(new TextEncoder().encode(s).subarray(0, 63), offset);
  const pt = mediaPixels({ name: media.name, dpi: 72 }); // PageSize is in points
  str(0, "PwgRaster"); // MediaClass
  u32(276, media.dpi); // HWResolution
  u32(280, media.dpi);
  u32(340, 1); // NumCopies: copies are the job's, not the page's
  u32(352, pt.width); // PageSize, points
  u32(356, pt.height);
  u32(372, page.width); // Width, Height in pixels
  u32(376, page.height);
  u32(384, 8); // BitsPerColor
  u32(388, 8); // BitsPerPixel
  u32(392, page.width); // BytesPerLine
  u32(400, SGRAY); // ColorSpace; ColorOrder (396) 0 is chunky
  u32(420, 1); // NumColors
  u32(452, total); // TotalPageCount
  u32(456, 1); // CrossFeedTransform
  u32(460, 1); // FeedTransform
  u32(480, WHITE); // AlternatePrimary
  str(1732, media.name); // PageSizeName
  return h;
}

/** One line's runs, appended to `out`. */
function packLine(line: Uint8Array, out: number[]) {
  let i = 0;
  while (i < line.length) {
    let run = 1;
    while (run < 128 && i + run < line.length && line[i + run] === line[i])
      run++;
    if (run > 1 || i + 1 === line.length) {
      out.push(run - 1, line[i]!);
      i += run;
      continue;
    }
    // Literal: up to 128 pixels, stopping before two equal pixels that would pack better as a repeat.
    let n = 1;
    while (
      n < 128 &&
      i + n < line.length &&
      !(i + n + 1 < line.length && line[i + n] === line[i + n + 1])
    )
      n++;
    if (n === 1) {
      out.push(0, line[i]!); // a lone pixel is a repeat of one: 257 − 256 can't be written
      i += 1;
      continue;
    }
    out.push(257 - n);
    for (let k = 0; k < n; k++) out.push(line[i + k]!);
    i += n;
  }
}

/**
 * Pages as one PWG Raster document, `image/pwg-raster`. Every page must be `width × height` bytes. Pages may come one at
 * a time (a generator), so only the packed document and the current page are held; then `total` is the page count.
 */
export function pwgRaster(
  pages: Iterable<GreyPage>,
  media: RasterMedia,
  total = Array.isArray(pages) ? pages.length : 0,
): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = [new TextEncoder().encode("RaS2")];
  for (const page of pages) {
    if (page.pixels.length !== page.width * page.height)
      throw new RangeError(
        `a ${page.width} × ${page.height} page needs ${page.width * page.height} bytes, got ${page.pixels.length}`,
      );
    chunks.push(header(page, media, total));
    let y = 0;
    while (y < page.height) {
      const line = page.pixels.subarray(y * page.width, (y + 1) * page.width);
      let repeat = 0;
      while (
        repeat < 255 &&
        y + repeat + 1 < page.height &&
        equal(
          line,
          page.pixels.subarray(
            (y + repeat + 1) * page.width,
            (y + repeat + 2) * page.width,
          ),
        )
      )
        repeat++;
      const out = [repeat]; // one line at a time: a page as a number[] would be hundreds of MB
      packLine(line, out);
      chunks.push(Uint8Array.from(out));
      y += repeat + 1;
    }
  }
  const size = chunks.reduce((n, c) => n + c.length, 0);
  const file = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) (file.set(c, at), (at += c.length));
  return file;
}

function equal(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A PWG Raster document back as pages and their headers' key fields; for tests and for checking a file before it prints. */
export function readPwgRaster(file: Uint8Array): (GreyPage & {
  dpi: number;
  pageSizeName: string;
  colorSpace: number;
  bitsPerPixel: number;
})[] {
  const text = new TextDecoder();
  if (text.decode(file.subarray(0, 4)) !== "RaS2")
    throw new Error("pwg raster: no RaS2 sync word");
  const pages = [];
  let at = 4;
  while (at < file.length) {
    const v = new DataView(file.buffer, file.byteOffset + at, HEADER);
    const width = v.getUint32(372);
    const height = v.getUint32(376);
    const bitsPerPixel = v.getUint32(388);
    const bytes = bitsPerPixel / 8;
    const name = file.subarray(at + 1732, at + 1796);
    const pageSizeName = text.decode(name.subarray(0, name.indexOf(0)));
    const page = {
      width,
      height,
      dpi: v.getUint32(276),
      pageSizeName,
      colorSpace: v.getUint32(400),
      bitsPerPixel,
      pixels: new Uint8Array(width * height * bytes),
    };
    at += HEADER;
    const lineBytes = width * bytes;
    let y = 0;
    while (y < height) {
      const repeat = file[at++]! + 1;
      const line = new Uint8Array(lineBytes);
      let x = 0;
      while (x < lineBytes) {
        const c = file[at++]!;
        if (c === 128) {
          line.fill(255, x); // the rest of the line is white
          break;
        }
        if (c < 128) {
          const px = file.subarray(at, at + bytes);
          for (let k = 0; k <= c; k++) line.set(px, x + k * bytes);
          at += bytes;
          x += (c + 1) * bytes;
        } else {
          const n = (257 - c) * bytes;
          line.set(file.subarray(at, at + n), x);
          at += n;
          x += n;
        }
      }
      for (let k = 0; k < repeat && y < height; k++, y++)
        page.pixels.set(line, y * lineBytes);
    }
    pages.push(page);
  }
  return pages;
}
