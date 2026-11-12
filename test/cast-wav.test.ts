import { describe, expect, test } from "bun:test";
import {
  CAST_WAV,
  castWav,
  isWav,
  readWav,
} from "../src/connectors/cast/wav.ts";

/** A WAV file built by hand: `samples` interleaved, as `bits`-bit integers or 32-bit floats, with an optional chunk before `data`. */
function wav(
  rate: number,
  channels: number,
  samples: number[],
  options: { bits?: number; float?: boolean; extra?: boolean } = {},
) {
  const bits = options.float ? 32 : (options.bits ?? 16);
  const width = bits / 8;
  const extra = options.extra ? 8 + 3 + 1 : 0; // a 3-byte LIST chunk, padded to 4
  const out = new Uint8Array(44 + extra + samples.length * width);
  const v = new DataView(out.buffer);
  const text = (at: number, s: string) =>
    [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, out.length - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, options.float ? 3 : 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * width, true);
  v.setUint16(32, channels * width, true);
  v.setUint16(34, bits, true);
  let at = 36;
  if (options.extra) {
    text(at, "LIST");
    v.setUint32(at + 4, 3, true);
    at += 12;
  }
  text(at, "data");
  v.setUint32(at + 4, samples.length * width, true);
  samples.forEach((x, i) => {
    const p = at + 8 + i * width;
    if (options.float) v.setFloat32(p, x, true);
    else if (bits === 16) v.setInt16(p, Math.round(x * 32767), true);
    else if (bits === 8) v.setUint8(p, Math.round(x * 127) + 128);
    else if (bits === 24) {
      const n = Math.round(x * 8388607) & 0xffffff;
      v.setUint8(p, n & 0xff);
      v.setUint8(p + 1, (n >> 8) & 0xff);
      v.setUint8(p + 2, n >> 16);
    }
  });
  return out;
}

describe("castWav", () => {
  // chota's speech: 24 kHz mono 16-bit, which audio-only Nest speakers did not play (live, 2026-11-09).
  const tone = Array.from(
    { length: 2400 },
    (_, i) => Math.sin((2 * Math.PI * 440 * i) / 24_000) * 0.5,
  );

  test("24 kHz mono becomes 48 kHz 16-bit stereo: twice the frames, the same sound in both channels", () => {
    const r = castWav(wav(24_000, 1, tone, { extra: true }));
    expect(r.converted).toBe(true);
    expect(r.from).toEqual({
      sampleRate: 24_000,
      channels: 1,
      bitsPerSample: 16,
      encoding: "pcm",
    });
    const back = readWav(r.bytes);
    expect(back.format).toEqual({ ...CAST_WAV, encoding: "pcm" });
    const [l, rr] = back.channels;
    expect(l!.length).toBe(4800);
    expect(rr).toEqual(l);
    for (let i = 0; i < 2400; i += 97)
      expect(l![i * 2]!).toBeCloseTo(tone[i]!, 3); // every other output frame is an input sample
  });

  test("a clip already 48 kHz 16-bit stereo comes back as the same bytes", () => {
    const same = wav(48_000, 2, [0, 0, 0.5, 0.5]);
    expect(castWav(same)).toMatchObject({ bytes: same, converted: false });
  });

  test("float and 8-bit WAV are read; a float past full scale is limited to it", () => {
    const f = readWav(
      castWav(wav(48_000, 1, [0.25, 1.5], { float: true })).bytes,
    );
    expect(f.channels[0]![0]).toBeCloseTo(0.25, 3);
    expect(f.channels[0]![1]).toBeCloseTo(1, 3);
    expect(
      readWav(wav(8000, 1, [0.5], { bits: 8 })).channels[0]![0],
    ).toBeCloseTo(0.5, 1);
  });

  test("24-bit samples keep their sign", () => {
    const [c] = readWav(wav(48_000, 1, [-1, -0.5, 0.5], { bits: 24 })).channels;
    expect([...c!].map((x) => Math.round(x * 100) / 100)).toEqual([
      -1, -0.5, 0.5,
    ]);
  });

  test("a file cut short, an empty one and a NaN are refused, not played as if whole", () => {
    const cut = wav(24_000, 1, [0.1, 0.2, 0.3]);
    expect(() => castWav(cut.subarray(0, cut.length - 2))).toThrow(
      "the data chunk says 6 bytes, the file has 4",
    );
    expect(() => castWav(wav(24_000, 1, []))).toThrow("no samples");
    expect(() => castWav(wav(24_000, 1, [NaN, 0], { float: true }))).toThrow(
      "sample 0 is not a number",
    );
  });

  test("not a WAV, or a format it doesn't read, throws saying which", () => {
    expect(() => castWav(new Uint8Array(20))).toThrow("not a RIFF WAVE file");
    const adpcm = wav(8000, 1, [0]);
    new DataView(adpcm.buffer).setUint16(20, 2, true);
    expect(() => castWav(adpcm)).toThrow("format 2 is not PCM or float");
  });

  test("isWav knows WAV's MIME names", () => {
    for (const t of [
      "audio/wav",
      "audio/x-wav",
      "audio/wave",
      "audio/WAV; codecs=1",
    ])
      expect(isWav(t)).toBe(true);
    expect(isWav("audio/mpeg")).toBe(false);
    expect(isWav(undefined)).toBe(false);
  });
});
