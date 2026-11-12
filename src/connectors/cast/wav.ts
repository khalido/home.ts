// WAV for Cast speakers. Google lists WAV (LPCM) for Google Home speakers without saying which rates
// (developers.google.com/cast/docs/media), and a 24 kHz mono WAV failed on two audio-only Nest speakers while the displays
// played it (live, 2026-11-09). So a WAV clip is rewritten as 48 kHz, 16-bit, stereo, the most common LPCM there is, in
// plain TypeScript: no encoder, nothing to install. Linear interpolation with no low-pass: enough for speech (TTS is 16 to
// 24 kHz); a source above 48 kHz would alias.

/** What a WAV file says about its audio. */
export type WavFormat = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** 1 integer PCM, 3 IEEE float; WAVE_FORMAT_EXTENSIBLE is read as its sub-format. */
  encoding: "pcm" | "float";
};

/** The rate, depth and channels every WAV clip is rewritten to. */
export const CAST_WAV: Omit<WavFormat, "encoding"> = {
  sampleRate: 48_000,
  channels: 2,
  bitsPerSample: 16,
};

const WAV_TYPES = new Set([
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/vnd.wave",
]);
/** Whether a clip's MIME type is WAV. */
export const isWav = (type: string | undefined) =>
  !!type && WAV_TYPES.has(type.split(";")[0]!.trim().toLowerCase());

const ascii = (b: Uint8Array, at: number) =>
  String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

/** A WAV file's format and its samples, each channel as floats −1 to 1. Throws on anything but integer or float PCM. */
export function readWav(bytes: Uint8Array): {
  format: WavFormat;
  channels: Float32Array[];
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (
    bytes.length < 12 ||
    ascii(bytes, 0) !== "RIFF" ||
    ascii(bytes, 8) !== "WAVE"
  )
    throw new Error("wav: not a RIFF WAVE file");
  let format: WavFormat | undefined;
  let blockAlign = 0;
  let data: Uint8Array | undefined;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = ascii(bytes, at);
    const size = view.getUint32(at + 4, true);
    // 0xFFFFFFFF is a streaming writer's "unknown length" (ffmpeg on a pipe): to the end. Otherwise a chunk cut short is
    // a file cut short, and a cut-off announcement must not play as if it were whole.
    const end = size === 0xffffffff ? bytes.length : at + 8 + size;
    if (end > bytes.length && (id === "fmt " || id === "data"))
      throw new Error(
        `wav: the ${id.trim()} chunk says ${size} bytes, the file has ${bytes.length - at - 8}`,
      );
    const body = bytes.subarray(at + 8, Math.min(end, bytes.length));
    if (id === "fmt ") {
      if (body.length < 16) throw new Error("wav: a fmt chunk under 16 bytes");
      const f = new DataView(body.buffer, body.byteOffset, body.length);
      let tag = f.getUint16(0, true);
      if (tag === 0xfffe && body.length >= 26) tag = f.getUint16(24, true); // extensible: the sub-format GUID's first two bytes
      if (tag !== 1 && tag !== 3)
        throw new Error(`wav: format ${tag} is not PCM or float`);
      format = {
        channels: f.getUint16(2, true),
        sampleRate: f.getUint32(4, true),
        bitsPerSample: f.getUint16(14, true),
        encoding: tag === 3 ? "float" : "pcm",
      };
      blockAlign = f.getUint16(12, true);
    } else if (id === "data") data = body;
    if (size === 0xffffffff) break;
    at += 8 + size + (size % 2); // chunks are padded to an even length
  }
  if (!format) throw new Error("wav: no fmt chunk");
  if (!data) throw new Error("wav: no data chunk");
  const { channels: n, bitsPerSample: bits, encoding } = format;
  const width = bits / 8;
  if (
    !n ||
    !format.sampleRate ||
    !(encoding === "float" ? bits === 32 : [8, 16, 24, 32].includes(bits))
  )
    throw new Error(
      `wav: ${bits}-bit ${encoding}, ${n} channels at ${format.sampleRate} Hz is not read`,
    );
  if (blockAlign !== width * n)
    throw new Error(
      `wav: ${blockAlign} bytes a frame, not ${width * n} for ${n} × ${bits}-bit`,
    );
  const frames = Math.floor(data.length / (width * n));
  if (!frames) throw new Error("wav: no samples");
  const d = new DataView(data.buffer, data.byteOffset, data.length);
  const out = Array.from({ length: n }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < n; c++) {
      const at = (i * n + c) * width;
      out[c]![i] =
        encoding === "float"
          ? d.getFloat32(at, true)
          : bits === 8
            ? (d.getUint8(at) - 128) / 128
            : bits === 16
              ? d.getInt16(at, true) / 32768
              : bits === 24
                ? ((d.getUint8(at + 2) << 24) |
                    (d.getUint8(at + 1) << 16) |
                    (d.getUint8(at) << 8)) /
                  2147483648
                : d.getInt32(at, true) / 2147483648;
    }
  return { format, channels: out };
}

/**
 * A WAV clip as one a Cast speaker plays: 48 kHz, 16-bit, stereo (`CAST_WAV`). A clip already in that form comes back as
 * it is. Mono is copied to both channels; more than two channels keep the first two. A float sample past ±1 is limited to
 * full scale, as any 16-bit output must.
 */
export function castWav(bytes: Uint8Array): {
  bytes: Uint8Array;
  from: WavFormat;
  converted: boolean;
} {
  const { format, channels } = readWav(bytes);
  const { sampleRate: rate, channels: n, bitsPerSample } = CAST_WAV;
  if (
    format.encoding === "pcm" &&
    format.sampleRate === rate &&
    format.channels === n &&
    format.bitsPerSample === bitsPerSample
  )
    return { bytes, from: format, converted: false };
  const src = [channels[0]!, channels[1] ?? channels[0]!];
  const frames = Math.round((src[0]!.length * rate) / format.sampleRate);
  const step = format.sampleRate / rate;
  const out = new Uint8Array(44 + frames * n * 2);
  const v = new DataView(out.buffer);
  const text = (at: number, s: string) =>
    [...s].forEach((ch, i) => v.setUint8(at + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, out.length - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, n, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * n * 2, true); // bytes per second
  v.setUint16(32, n * 2, true); // bytes per frame
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, frames * n * 2, true);
  for (let i = 0; i < frames; i++) {
    const x = i * step;
    const j = Math.floor(x);
    const t = x - j;
    for (let c = 0; c < n; c++) {
      const s = src[c]!;
      const a = s[j] ?? 0;
      const b = s[j + 1] ?? a;
      const raw = a + (b - a) * t;
      if (Number.isNaN(raw))
        throw new Error(`wav: sample ${j} is not a number`);
      const y = Math.max(-1, Math.min(1, raw));
      v.setInt16(44 + (i * n + c) * 2, Math.round(y * 32767), true);
    }
  }
  return { bytes: out, from: format, converted: true };
}

/** A format in a few words: `24000 Hz mono 16-bit`. */
export const wavText = (
  f: Omit<WavFormat, "encoding"> & { encoding?: string },
) =>
  `${f.sampleRate} Hz ${f.channels === 1 ? "mono" : f.channels === 2 ? "stereo" : `${f.channels}-channel`} ${f.bitsPerSample}-bit${f.encoding === "float" ? " float" : ""}`;
