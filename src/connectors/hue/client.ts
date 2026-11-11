import { z } from "zod";
import { Envelope, type Kind, PairResponse, Resource } from "./schemas.ts";
import { HUE_BRIDGE_ROOT_CA } from "./ca.ts";
import { type Clock, realClock } from "../../clock.ts";
import { ConnectorError, fetchTimeout } from "../../connector.ts";
import { writeLane } from "../../lane.ts";

/** What a Hue client needs: the bridge's LAN address, its application key, and a pinned `fetch`. */
export type HueOptions = {
  host: string;
  key: string;
  fetch: typeof fetch;
  clock?: Clock;
};

/** A failed bridge call. `code` is "link_button" when pairing waits on the bridge's button. */
export class HueError extends ConnectorError {
  declare readonly code?: "link_button";
}

/** Minimum gap between writes, per lane: Signify's guidance (Hue System Performance, read 2026-11-11), about 10 a second to lights and 1 a second to groups. */
export const WRITE_GAP_MS = { group: 1000, light: 100 } as const;
type Lane = keyof typeof WRITE_GAP_MS;

/** Which lane a write goes in: `light` writes are fast, everything else (grouped_light, scene) is a group write. */
export const laneFor = (kind: string): Lane =>
  kind === "light" ? "light" : "group";

/** Hue bodies merge field by field, the newer value winning: `{ on }` then `{ dimming }` lands as both. */
export function mergeBody(older: object, newer: object): object {
  const plain = (x: unknown): x is object =>
    typeof x === "object" && x !== null && !Array.isArray(x);
  const out: Record<string, unknown> = { ...older };
  for (const [k, v] of Object.entries(newer))
    out[k] = plain(out[k]) && plain(v) ? mergeBody(out[k], v) : v;
  return out;
}

/** A typed CLIP v2 client. Reads go straight through; writes go through the bridge's write queue. `host` is read at each call, so a getter follows a move. */
export function hueClient(options: HueOptions) {
  const lanes = {
    group: writeLane({ gapMs: WRITE_GAP_MS.group, clock: options.clock }),
    light: writeLane({ gapMs: WRITE_GAP_MS.light, clock: options.clock }),
  };

  async function call(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    const headers: Record<string, string> = {
      "hue-application-key": options.key,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetchTimeout(
      options.fetch,
      `https://${options.host}${path}`,
      {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      { signal },
    );
    const parsed = Envelope.safeParse(await res.json().catch(() => undefined));
    const errors = parsed.success
      ? parsed.data.errors.map((e) => e.description)
      : [];
    if (!res.ok || errors.length)
      throw new HueError(
        errors.join("; ") || `HTTP ${res.status} on ${method} ${path}`,
        { status: res.status },
      );
    return parsed.success ? parsed.data.data : [];
  }

  /** Change one resource, e.g. `put("grouped_light", id, { on: { on: false } })`. Spaced per lane; writes to one resource waiting their turn merge. */
  const put = (kind: Kind, id: string, body: object): Promise<unknown[]> =>
    lanes[laneFor(kind)].send(
      `${kind}/${id}`,
      body,
      (b) => call("PUT", `/clip/v2/resource/${kind}/${id}`, b),
      mergeBody,
    );

  return {
    put,
    /** Every resource of one kind, or every resource on the bridge when `kind` is left out (one call). */
    async get(kind?: Kind, signal?: AbortSignal): Promise<Resource[]> {
      return z
        .array(Resource)
        .parse(
          await call(
            "GET",
            `/clip/v2/resource${kind ? `/${kind}` : ""}`,
            undefined,
            signal,
          ),
        );
    },
    /** Recall a scene in its room or zone. */
    recallScene(id: string): Promise<unknown[]> {
      return put("scene", id, { recall: { action: "active" } });
    },
  };
}
export type HueClient = ReturnType<typeof hueClient>;

/** Ask the bridge for an application key. One call: throws `HueError` with code "link_button" until KO presses it. */
export async function pair(options: {
  host: string;
  fetch: typeof fetch;
  deviceType: string;
  signal?: AbortSignal;
}): Promise<{ key: string; clientKey?: string }> {
  const res = await fetchTimeout(
    options.fetch,
    `https://${options.host}/api`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        devicetype: options.deviceType,
        generateclientkey: true,
      }),
    },
    { signal: options.signal },
  );
  const parsed = PairResponse.safeParse(
    await res.json().catch(() => undefined),
  );
  if (!parsed.success)
    throw new HueError(`unexpected answer to POST /api (HTTP ${res.status})`, {
      status: res.status,
    });
  const [first] = parsed.data;
  if (first?.success)
    return { key: first.success.username, clientKey: first.success.clientkey };
  const error = first?.error;
  throw new HueError(error?.description ?? `HTTP ${res.status} on POST /api`, {
    status: res.status,
    code: error?.type === 101 ? "link_button" : undefined,
  });
}

/**
 * `pair`, asked again every `everyMs` (2 s) until someone presses the bridge's button, for `timeoutMs` (30 s, as long as
 * the button stays pressed). `onWaiting` is called once, when the bridge first says the button isn't pressed: the moment
 * to tell the person. Throws the last `link_button` error when time runs out, any other error at once, and the signal's
 * reason when aborted.
 */
export async function pairWhenPressed(options: {
  host: string;
  fetch: typeof fetch;
  deviceType: string;
  timeoutMs?: number;
  everyMs?: number;
  onWaiting?: () => void;
  clock?: Clock;
  signal?: AbortSignal;
}): Promise<{ key: string; clientKey?: string }> {
  const clock = options.clock ?? realClock;
  const until = clock.now() + (options.timeoutMs ?? 30_000);
  let waiting = false;
  while (true) {
    try {
      return await pair(options);
    } catch (error) {
      const pressed = !(
        error instanceof HueError && error.code === "link_button"
      );
      if (pressed || clock.now() >= until) throw error;
      if (!waiting) options.onWaiting?.();
      waiting = true;
    }
    await clock.sleep(options.everyMs ?? 2000, options.signal);
    options.signal?.throwIfAborted();
  }
}

/**
 * A `fetch` that trusts only `ca` (Signify's roots, `HUE_BRIDGE_ROOT_CA`, when left out) and accepts only a certificate whose CN is `bridgeId`.
 * Uses Bun's `tls` fetch option; Node ignores it and then rejects the bridge, so it fails closed there; Node uses `nodePinnedFetch` from `@khalido/home/node`.
 */
export function bunPinnedFetch(
  bridgeId: string,
  ca: string = HUE_BRIDGE_ROOT_CA,
): typeof fetch {
  const checkServerIdentity = (
    _host: string,
    cert: { subject?: { CN?: string } },
  ) =>
    cert.subject?.CN?.toLowerCase() === bridgeId.toLowerCase()
      ? undefined
      : new Error(
          `Hue bridge certificate is for ${cert.subject?.CN ?? "nobody"}, expected ${bridgeId}`,
        );
  const pinned = (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, { ...init, tls: { ca, checkServerIdentity } } as RequestInit);
  return pinned as typeof fetch;
}
