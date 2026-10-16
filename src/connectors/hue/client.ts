import { z } from "zod";
import { Envelope, type Kind, PairResponse, Resource } from "./schemas.ts";
import { type Clock, realClock } from "../../clock.ts";
import { ConnectorError, fetchTimeout } from "../../connector.ts";

/** What a Hue client needs: the bridge's LAN address, its application key, and a pinned `fetch`. */
export type HueOptions = { ip: string; key: string; fetch: typeof fetch; clock?: Clock };

/** A failed bridge call. `code` is "link_button" when pairing waits on the bridge's button. */
export class HueError extends ConnectorError {
  declare readonly code?: "link_button";
}

/** Minimum gap between writes, per lane. Signify's guidance (login-gated, unconfirmed): ~10/s to lights, 1/s to groups. */
export const WRITE_GAP_MS = { group: 1000, light: 100 } as const;
type Lane = keyof typeof WRITE_GAP_MS;

/** Which lane a write goes in: `light` writes are fast, everything else (grouped_light, scene) is a group write. */
export const laneFor = (kind: string): Lane => (kind === "light" ? "light" : "group");

/** One queue per bridge: writes run in order per lane, spaced by `WRITE_GAP_MS`. */
export function writeQueue(clock: Clock = realClock) {
  const tail: Record<Lane, Promise<unknown>> = { group: Promise.resolve(), light: Promise.resolve() };
  const lastAt: Record<Lane, number> = { group: -Infinity, light: -Infinity };
  return function enqueue<T>(lane: Lane, write: () => Promise<T>): Promise<T> {
    const run = tail[lane]
      .catch(() => {})
      .then(async () => {
        const wait = lastAt[lane] + WRITE_GAP_MS[lane] - clock.now();
        if (wait > 0) await clock.sleep(wait);
        lastAt[lane] = clock.now();
        return write();
      });
    tail[lane] = run;
    return run;
  };
}

/** A typed CLIP v2 client. Reads go straight through; writes go through the bridge's write queue. */
export function hueClient(options: HueOptions) {
  const base = `https://${options.ip}`;
  const enqueue = writeQueue(options.clock);

  async function call(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown[]> {
    const headers: Record<string, string> = { "hue-application-key": options.key };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetchTimeout(options.fetch, base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, { signal });
    const parsed = Envelope.safeParse(await res.json().catch(() => undefined));
    const errors = parsed.success ? parsed.data.errors.map((e) => e.description) : [];
    if (!res.ok || errors.length) throw new HueError(errors.join("; ") || `HTTP ${res.status} on ${method} ${path}`, { status: res.status });
    return parsed.success ? parsed.data.data : [];
  }

  /** Change one resource, e.g. `put("grouped_light", id, { on: { on: false } })`. Queued and spaced. */
  const put = (kind: Kind, id: string, body: object): Promise<unknown[]> =>
    enqueue(laneFor(kind), () => call("PUT", `/clip/v2/resource/${kind}/${id}`, body));

  return {
    put,
    /** Every resource of one kind, or every resource on the bridge when `kind` is left out (one call). */
    async get(kind?: Kind, signal?: AbortSignal): Promise<Resource[]> {
      return z.array(Resource).parse(await call("GET", `/clip/v2/resource${kind ? `/${kind}` : ""}`, undefined, signal));
    },
    /** Recall a scene in its room or zone. */
    recallScene(id: string): Promise<unknown[]> {
      return put("scene", id, { recall: { action: "active" } });
    },
  };
}
export type HueClient = ReturnType<typeof hueClient>;

/** Ask the bridge for an application key. One call: throws `HueError` with code "link_button" until KO presses it. */
export async function pair(options: { ip: string; fetch: typeof fetch; deviceType: string }): Promise<{ key: string; clientKey?: string }> {
  const res = await fetchTimeout(options.fetch, `https://${options.ip}/api`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ devicetype: options.deviceType, generateclientkey: true }),
  });
  const parsed = PairResponse.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new HueError(`unexpected answer to POST /api (HTTP ${res.status})`, { status: res.status });
  const [first] = parsed.data;
  if (first?.success) return { key: first.success.username, clientKey: first.success.clientkey };
  const error = first?.error;
  throw new HueError(error?.description ?? `HTTP ${res.status} on POST /api`, { status: res.status, code: error?.type === 101 ? "link_button" : undefined });
}

/**
 * A `fetch` that trusts only `ca` and accepts only a certificate whose CN is `bridgeId`.
 * Uses Bun's `tls` fetch option; Node ignores it and then rejects the bridge, so it fails closed there (README has Node's setup).
 */
export function bunPinnedFetch(bridgeId: string, ca: string): typeof fetch {
  const checkServerIdentity = (_host: string, cert: { subject?: { CN?: string } }) =>
    cert.subject?.CN?.toLowerCase() === bridgeId.toLowerCase()
      ? undefined
      : new Error(`Hue bridge certificate is for ${cert.subject?.CN ?? "nobody"}, expected ${bridgeId}`);
  const pinned = (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, { ...init, tls: { ca, checkServerIdentity } } as RequestInit);
  return pinned as typeof fetch;
}
