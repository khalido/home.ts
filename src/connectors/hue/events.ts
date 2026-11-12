import { z } from "zod";
import { type Clock, realClock } from "../../clock.ts";
import { isRejectedKey } from "../../connector.ts";
import { HueError, type HueOptions } from "./client.ts";
import { HueEvent } from "./schemas.ts";

/** One SSE message: its `id:` line (the bridge sends `<unix seconds>:0`) and its joined `data:` lines. */
export type SseMessage = { id?: string; data: string };

/** Split an SSE byte stream into messages, one per blank-line-separated block. Comment lines (`:`) are skipped. */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (
        let end = buffer.search(/\r?\n\r?\n/);
        end >= 0;
        end = buffer.search(/\r?\n\r?\n/)
      ) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
        const message = parseBlock(block);
        if (message) yield message;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseBlock(block: string): SseMessage | undefined {
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") id = value;
    else if (field === "data") data.push(value);
  }
  return data.length ? { id, data: data.join("\n") } : undefined;
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** What the stream yields: a (re)connection, a batch of events, or a drop with the wait before the next try. */
export type StreamItem =
  | { kind: "connected" }
  | { kind: "events"; id?: string; events: HueEvent[]; skipped?: number } // skipped: batches that failed the schema
  | { kind: "disconnected"; error: unknown; retryInMs: number };

/**
 * A connection with no bytes for this long is reconnected: a silent half-close otherwise looks connected forever (aiohue
 * uses 90 s). The bridge sends nothing on its own, so a quiet house trips it too; the reconnect is a silent probe.
 */
export const IDLE_MS = 90_000;

/** Waits between reconnects; the last one repeats. Reset after every successful connect. */
export const BACKOFF_MS = [1000, 5000, 15000, 60000];

/**
 * Read `GET /eventstream/clip/v2` until `signal` aborts, reconnecting with backoff.
 * Events missed while disconnected are gone, so refetch everything on each "connected".
 * A connection silent for `idleMs` is reconnected at once without a "disconnected" or a step up the backoff (the bridge
 * sends no keep-alive); only a reconnect that then fails is reported, as any failure is.
 */
export async function* hueEvents(
  options: HueOptions & { signal?: AbortSignal; idleMs?: number },
): AsyncGenerator<StreamItem> {
  const clock: Clock = options.clock ?? realClock;
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  if (options.signal?.aborted) stop.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let attempt = 0;
  let watch: AbortController | undefined; // the running watchdog's wait
  try {
    while (!stop.signal.aborted) {
      // Each connection has its own watchdog, on the clock: any bytes (events or the bridge's comment lines) re-arm it.
      const connection = new AbortController();
      const idleMs = options.idleMs ?? IDLE_MS;
      let opened = false; // this connection got as far as "connected"
      let quiet = false; // the watchdog ended it
      const arm = () => {
        watch?.abort();
        const w = (watch = new AbortController());
        void clock.sleep(idleMs, w.signal).then(() => {
          if (w.signal.aborted || connection.signal.aborted) return; // re-armed or already over (the clock's sleep resolves on abort)
          quiet = true;
          connection.abort(
            new HueError(`no data on the event stream for ${idleMs / 1000} s`),
          );
        });
      };
      try {
        arm();
        const res = await options.fetch(
          `https://${options.host}/eventstream/clip/v2`,
          {
            headers: {
              "hue-application-key": options.key,
              accept: "text/event-stream",
            },
            signal: AbortSignal.any([stop.signal, connection.signal]),
          },
        );
        if (!res.ok || !res.body)
          throw new HueError(`HTTP ${res.status} on the event stream`, {
            status: res.status,
          });
        yield { kind: "connected" };
        opened = true;
        arm(); // time spent with the consumer is not the bridge's silence
        // The watchdog errors this pass-through, which ends the read even if the body ignores the abort.
        const watched = res.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            start: (out) =>
              connection.signal.addEventListener(
                "abort",
                () => out.error(connection.signal.reason),
                { once: true },
              ),
            transform: (chunk, out) => (arm(), out.enqueue(chunk)),
          }),
        );
        for await (const message of parseSse(watched)) {
          attempt = 0; // reset only once data flows, so a bridge that accepts and drops still backs off
          // One odd batch is skipped and counted, not allowed to drop the stream (a reconnect costs a full read).
          const batches = z
            .array(z.unknown())
            .safeParse(safeJson(message.data));
          const parsed = (batches.success ? batches.data : [message.data]).map(
            (b) => HueEvent.safeParse(b),
          );
          const events = parsed.flatMap((p) => (p.success ? [p.data] : []));
          const skipped = parsed.length - events.length;
          yield {
            kind: "events",
            id: message.id,
            events,
            ...(skipped ? { skipped } : {}),
          };
        }
        throw new HueError("the event stream ended");
      } catch (caught) {
        watch?.abort();
        if (stop.signal.aborted) return;
        // Quiet, not broken: probe with a fresh connection now. Only a probe that fails is reported (it never opened).
        if (quiet && opened) continue;
        const error = connection.signal.aborted
          ? connection.signal.reason
          : caught;
        if (isRejectedKey(error)) throw error; // retrying will not help: pair again
        const retryInMs =
          BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)]!;
        yield { kind: "disconnected", error, retryInMs };
        await clock.sleep(retryInMs, stop.signal);
      }
    }
  } finally {
    watch?.abort();
    stop.abort(); // a consumer that breaks out also closes the connection
    options.signal?.removeEventListener("abort", onAbort);
  }
}
