import type { z } from "zod";

// What every connector's client shares: one timeout, one error, one fetch that a run's abort can cancel.

/** No device or service call waits longer than this. */
export const TIMEOUT_MS = 10_000;

/**
 * An error as a detail line: its message ("fetch failed", not "TypeError: fetch failed"), and its cause's when it has one.
 * Node's fetch puts the reason there: "fetch failed: connect ECONNREFUSED 192.0.2.10:443".
 */
export function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : undefined;
  return cause && cause !== error.message ? `${error.message}: ${cause}` : error.message;
}

/** A failed device or service call. `status` is the HTTP status (or a device's own code); `code` a connector's own reason. */
export class ConnectorError extends Error {
  readonly status?: number;
  readonly code?: string;
  constructor(message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name; // a subclass (HueError, AmberError) names itself in logs; a detail shows only the message
    this.status = options.status;
    this.code = options.code;
  }
}

/** `fetch` that gives up after `timeoutMs`, or as soon as `signal` (a run's) aborts. Returns the response whatever its status. */
export function fetchTimeout(fetcher: typeof fetch, url: string | URL, init: Omit<RequestInit, "signal"> = {}, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Response> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS);
  return fetcher(url, { ...init, signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout });
}

/**
 * GET (or `init.method`) JSON through `fetchTimeout`. A non-ok status throws `error` (ConnectorError by default) with the
 * status, as "HTTP 500 on GET /path" (no query: it can carry a key). With a `schema` the body is parsed by it.
 */
export async function getJson<T = unknown>(
  fetcher: typeof fetch,
  url: string | URL,
  options: { init?: Omit<RequestInit, "signal">; timeoutMs?: number; signal?: AbortSignal; schema?: z.ZodType<T>; error?: typeof ConnectorError } = {},
): Promise<T> {
  const res = await fetchTimeout(fetcher, url, options.init, options);
  if (!res.ok) throw new (options.error ?? ConnectorError)(`HTTP ${res.status} on ${options.init?.method ?? "GET"} ${new URL(url).pathname}`, { status: res.status });
  const body: unknown = await res.json();
  return options.schema ? options.schema.parse(body) : (body as T);
}
