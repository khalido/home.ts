// `home cast announce|volume|mute|stop …`: one write to a Cast device or group, by its name or castId. `announce` plays a
// clip (macOS `say`, or a file) and puts back what was playing and the volume; another app it interrupts cannot be resumed, and it says so.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import {
  cast,
  type CastSnapshot,
  resolvedFrom,
} from "../connectors/cast/index.ts";
import { serveClip } from "../connectors/cast/serve.ts";
import { tlsConnect } from "../connectors/cast/tls.ts";
import { addressBook } from "../discover.ts";
import { FINDERS } from "../finders.ts";
import type { Part } from "../home.ts";
import {
  addresses,
  expandHome,
  fail,
  printJson,
  text,
  usage,
  type Verbs,
} from "./context.ts";

/** Every Cast device and group, read once: what `home status` and `home probe` run without a config. Cached addresses first; discovery when there are none or one fails. */
export function castNow() {
  const book = addressBook(addresses.cache);
  const expect = Object.entries(book.entries()).flatMap(([key, c]) =>
    key.startsWith("cast:") && c.port !== undefined
      ? [
          {
            castId: key.slice(5),
            name: c.name ?? key.slice(5),
            host: c.host,
            port: c.port,
          },
        ]
      : [],
  );
  return cast({
    resolve: async () => resolvedFrom(await FINDERS.cast()),
    connect: tlsConnect,
    expect,
    seen: (id, a) => book.seen("cast", id, a),
    serve: serveClip,
  });
}

/** Open every Cast socket, wait until each has answered (at most 10 s), run one write over them, then close them all. */
async function withCast<T>(
  act: (c: ReturnType<typeof castNow>) => Promise<T>,
): Promise<T> {
  const c = castNow();
  const stop = new AbortController();
  let last: Part<CastSnapshot> | undefined;
  const running = c.run(stop.signal, (p) => (last = p));
  try {
    for (
      const until = Date.now() + 10_000;
      Date.now() < until && (last?.status ?? "connecting") === "connecting";
    )
      await Bun.sleep(50);
    return await act(c);
  } finally {
    stop.abort();
    await running;
  }
}

export const CAST_USAGE =
  'usage: home cast announce --to <name> (--say "<text>" | --file <path>) [--volume 0-100] | volume <name> <0-100> | mute <name> on|off | stop <name>';

/** A 0–100 argument as the 0–1 a Cast device takes. */
function percentLevel(value: string | undefined): number {
  const n = Number(value);
  if (value === undefined || value.trim() === "" || !(n >= 0 && n <= 100))
    usage(CAST_USAGE);
  return n / 100;
}

/** What a clip file plays as, by its extension; the Default Media Receiver plays these, not AIFF. */
const AUDIO_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
};

/** The options `home cast` takes, beyond the global ones. Strings stay strings: "007" is a name, not 7. */
export const CAST_OPTIONS: [string, string, { type: unknown[] }?][] = [
  [
    "--to <name>",
    "announce: the device or group, by name or castId",
    { type: [String] },
  ],
  ["--say <text>", "announce: words spoken by macOS `say`", { type: [String] }],
  ["--file <path>", "announce: an audio file to play", { type: [String] }],
  ["--volume <0-100>", "announce: the volume for the clip"],
];

export const castVerbs: Verbs = {
  async volume([name, value]) {
    if (!name) usage(CAST_USAGE);
    const level = percentLevel(value);
    await withCast((c) => c.setVolume(name!, level));
  },
  async mute([name, value]) {
    if (!name || (value !== "on" && value !== "off")) usage(CAST_USAGE);
    await withCast((c) => c.setMuted(name!, value === "on"));
  },
  async stop([name]) {
    if (!name) usage(CAST_USAGE);
    await withCast((c) => c.stop(name!));
  },
  async announce(_, o) {
    const [to, say, file] = [text(o.to), text(o.say), text(o.file)];
    // cac gives "true" for a flag with no value: `--say` alone must not speak the word "true", so each flag needs a value after it.
    const bare = ["--to", "--say", "--file"].some((f) =>
      process.argv.some(
        (a, i) =>
          a === f &&
          (process.argv[i + 1] === undefined ||
            process.argv[i + 1]!.startsWith("--")),
      ),
    );
    if (bare) usage(CAST_USAGE);
    if (!to || !say === !file) usage(CAST_USAGE);
    const volume =
      o.volume === undefined ? undefined : percentLevel(text(o.volume));
    let type: string;
    let bytes: Uint8Array;
    if (file) {
      type =
        AUDIO_TYPES[extname(file).toLowerCase()] ??
        fail(
          `${file}: not a type the Default Media Receiver plays (${Object.keys(AUDIO_TYPES).join(" ")})`,
        );
      bytes = readFileSync(expandHome(file));
    } else {
      // AAC in an MP4 container, which the Default Media Receiver plays (say's default AIFF it does not). Without
      // --data-format=aac, m4af holds uncompressed PCM (afinfo, macOS 27.0).
      const tmp = join(tmpdir(), `home-say-${randomUUID()}.m4a`);
      try {
        const said = spawnSync(
          "say",
          ["-o", tmp, "--file-format=m4af", "--data-format=aac", say!],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        if (said.error || said.status !== 0)
          fail(`say: ${said.error?.message ?? said.stderr.toString().trim()}`);
        bytes = readFileSync(tmp);
      } finally {
        rmSync(tmp, { force: true });
      }
      type = "audio/mp4";
    }
    const r = await withCast((c) =>
      c.announce(to!, { bytes, type }, { volume }),
    );
    if (o.json) return printJson(r);
    console.log(r.played ? "played" : `not played: ${r.why}`);
    if (r.restored.length) console.log(`restored: ${r.restored.join(", ")}`);
    for (const n of r.notRestored)
      console.log(`not restored: ${n.name}: ${n.why}`);
  },
};
