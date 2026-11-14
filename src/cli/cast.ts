// `home cast announce|volume|mute|stop …`: one write to a Cast device or group, by its name or castId. `announce` plays a
// clip (macOS `say`, or a file) and puts back what was playing and the volume; another app it interrupts cannot be resumed, and it says so.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import {
  cast,
  type CastDevice,
  type CastSnapshot,
  castText,
  resolvedFrom,
} from "../connectors/cast/index.ts";
import { findCast } from "../connectors/cast/state.ts";
import type { CastDryRun, CastRequest } from "../connectors/cast/writes.ts";
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
            model: c.model,
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
  act: (
    c: ReturnType<typeof castNow>,
    state: () => CastSnapshot | undefined,
  ) => Promise<T>,
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
    return await act(c, () => last?.state);
  } finally {
    stop.abort();
    await running;
  }
}

export const CAST_USAGE =
  'usage: home cast announce --to <name> [--to <name>…] (--say "<text>" [--wav] | --file <path>) [--volume 0-100] | volume <name> <0-100> | mute <name> on|off | stop <name> | url <name> <url> | launch <name> <appId>';

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
    "announce: the device or group, by name or castId; repeat for several",
    { type: [String] },
  ],
  ["--say <text>", "announce: words spoken by macOS `say`", { type: [String] }],
  ["--file <path>", "announce: an audio file to play", { type: [String] }],
  [
    "--wav",
    "announce: with --say, speak into a 24 kHz mono WAV, as a TTS gives (announce converts it); else AAC",
  ],
  ["--volume <0-100>", "announce: the volume for the clip"],
];

/** How long a write waits for the device to report the change before saying it was only sent. */
const SHOWN_MS = 2000;

/** A dry run's messages, one line each: `would send <device> <channel> <payload>`. */
const dryLines = (sends: CastRequest[], who = "") =>
  sends.length
    ? sends.forEach((r) =>
        console.log(
          `${who}would send ${r.device} ${r.namespace ?? r.channel} ${JSON.stringify(r.payload)}`,
        ),
      )
    : console.log(`${who}nothing to send`);

/** One write, then the device's line once it reports what was asked, or that it has not yet. Dry: what would be sent. */
const wrote = (
  name: string,
  write: (
    c: ReturnType<typeof castNow>,
    options: { dryRun: boolean },
  ) => Promise<CastDryRun | undefined>,
  shown: (d: CastDevice) => boolean,
  dryRun: boolean,
) =>
  withCast(async (c, state) => {
    const dry = await write(c, { dryRun });
    if (dry) {
      console.log("dry run, nothing sent:");
      return dryLines(dry.wouldSend);
    }
    const now = () => {
      const s = state();
      const d = s && findCast(s.devices, name);
      return s && d ? { line: castText(d, s), ok: shown(d) } : undefined;
    };
    for (const until = Date.now() + SHOWN_MS; Date.now() < until;) {
      if (now()?.ok) break;
      await Bun.sleep(50);
    }
    const after = now();
    console.log(
      after?.ok
        ? after.line
        : `sent; the device has not reported it yet${after ? ` (${after.line})` : ""}`,
    );
  });

export const castVerbs: Verbs = {
  async volume([name, value], o) {
    if (!name) usage(CAST_USAGE);
    const level = percentLevel(value);
    await wrote(
      name!,
      (c, dry) => c.setVolume(name!, level, dry),
      (d) => d.volume !== undefined && Math.abs(d.volume - level) < 0.006,
      !!o.dryRun,
    );
  },
  async mute([name, value], o) {
    if (!name || (value !== "on" && value !== "off")) usage(CAST_USAGE);
    await wrote(
      name!,
      (c, dry) => c.setMuted(name!, value === "on", dry),
      (d) => d.muted === (value === "on"),
      !!o.dryRun,
    );
  },
  async stop([name], o) {
    if (!name) usage(CAST_USAGE);
    await wrote(
      name!,
      (c, dry) => c.stop(name!, dry),
      (d) => d.idle === true,
      !!o.dryRun,
    );
  },
  // A web page through DashCast, or any Cast app by its id. `stop <name>` ends either.
  async url([name, url, extra], o) {
    if (!name || !url || extra) usage(CAST_USAGE);
    const r = await withCast((c) =>
      c.castUrl(name!, url!, { dryRun: !!o.dryRun }),
    );
    if ("wouldSend" in r) {
      console.log("dry run, nothing sent:");
      return dryLines(r.wouldSend);
    }
    console.log(`${name}: showing ${url} (DashCast, ${r.transportId})`);
  },
  async launch([name, appId, extra], o) {
    if (!name || !appId || extra) usage(CAST_USAGE);
    const r = await withCast((c) =>
      c.launch(name!, appId!, { dryRun: !!o.dryRun }),
    );
    if ("wouldSend" in r) {
      console.log("dry run, nothing sent:");
      return dryLines(r.wouldSend);
    }
    console.log(
      `${name}: running ${r.displayName ?? r.appId} (${r.transportId})`,
    );
  },
  async announce(_, o) {
    const [say, file] = [text(o.say), text(o.file)];
    const to = [o.to].flat().filter(Boolean).map(String); // --to can repeat
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
    if (!to.length || !say === !file || (o.wav && !say)) usage(CAST_USAGE); // --wav shapes --say's speech, not a file
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
      // --data-format=aac, m4af holds uncompressed PCM (afinfo, macOS 27.0). --wav: 24 kHz mono 16-bit WAV, the shape a
      // TTS service gives, to test the path a bot takes (announce rewrites it as 48 kHz stereo).
      const wav = !!o.wav;
      const tmp = join(
        tmpdir(),
        `home-say-${randomUUID()}.${wav ? "wav" : "m4a"}`,
      );
      try {
        const said = spawnSync(
          "say",
          [
            "-o",
            tmp,
            ...(wav
              ? ["--file-format=WAVE", "--data-format=LEI16@24000"]
              : ["--file-format=m4af", "--data-format=aac"]),
            say!,
          ],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        if (said.error || said.status !== 0)
          fail(`say: ${said.error?.message ?? said.stderr.toString().trim()}`);
        bytes = readFileSync(tmp);
      } finally {
        rmSync(tmp, { force: true });
      }
      type = wav ? "audio/wav" : "audio/mp4";
    }
    const results = await withCast((c) =>
      c.announceAll(to, { bytes, type }, { volume, dryRun: !!o.dryRun }),
    );
    const failed = results.some((r) => (o.dryRun ? !r.wouldSend : !r.played));
    if (failed) process.exitCode = 1; // docs/cli.md: 1 is a failure, so a script can tell
    if (o.json) return printJson(to.length === 1 ? results[0] : results);
    const named = results.length > 1;
    if (o.dryRun) console.log("dry run, nothing sent:");
    for (const r of results) {
      const who = named ? `${r.target}: ` : "";
      if (r.wouldSend) {
        dryLines(r.wouldSend, who);
        for (const n of r.notRestored)
          console.log(`${who}would not restore: ${n.name}: ${n.why}`);
        continue;
      }
      console.log(`${who}${r.played ? "played" : `not played: ${r.why}`}`);
      if (r.restored.length)
        console.log(`${who}restored: ${r.restored.join(", ")}`);
      for (const n of r.notRestored)
        console.log(`${who}not restored: ${n.name}: ${n.why}`);
    }
  },
};
