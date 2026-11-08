import type { Part, Status } from "./home.ts";
import { MANIFESTS } from "./manifests.ts";

/**
 * How one integration is doing, judged by time: `ok`, `stale` (no good read for a while, last values still shown) or `down`.
 * The thresholds come with it, so a page can say "stale after 4 min". Push connectors (Hue, Cast) have no poll to be late
 * for: never stale, down when not connected for `PUSH_DOWN_MS`.
 */
export type Health = {
  level: "ok" | "stale" | "down";
  status: Status;
  lastGoodAt?: string;
  downSince?: string;
  staleAfterMs?: number;
  downAfterMs: number;
  detail?: string;
};

/** A polling connector is stale after this many polls with no good read: two missed, plus half of one so a slow read that ends in a timeout does not flap it, */
export const STALE_POLLS = 2.5;
/** and down after this many polls not connected. */
export const DOWN_POLLS = 3;
/** A push connector is down after this long not connected: a reconnect takes seconds, a backoff at most a minute. */
export const PUSH_DOWN_MS = 120_000;

const POLL_SECONDS: Record<string, number | undefined> = Object.fromEntries(
  MANIFESTS.map((m) => [m.name, m.pollSeconds]),
);

/**
 * Each integration's health at `now` (ms), from the times `createHome` stamps on its part. `pollSeconds` overrides a
 * connector's own interval (its manifest's, so pass the weather's when the config changes it), or names one the library does not know.
 */
export function health(
  snapshot: Record<string, Part | undefined>,
  now: number,
  options: { pollSeconds?: Record<string, number> } = {},
): Record<string, Health> {
  const poll = (name: string) =>
    options.pollSeconds?.[name] ?? POLL_SECONDS[name];
  return Object.fromEntries(
    Object.entries(snapshot).flatMap(([name, part]) =>
      part ? [[name, healthOf(part, now, poll(name))]] : [],
    ),
  );
}

function healthOf(
  part: Part,
  now: number,
  pollSeconds: number | undefined,
): Health {
  const staleAfterMs =
    pollSeconds === undefined ? undefined : STALE_POLLS * pollSeconds * 1000;
  const downAfterMs =
    pollSeconds === undefined ? PUSH_DOWN_MS : DOWN_POLLS * pollSeconds * 1000;
  const age = (iso?: string) =>
    iso === undefined ? undefined : now - Date.parse(iso);
  const down =
    part.status === "unavailable" ||
    (part.status !== "connected" && (age(part.downSince) ?? 0) >= downAfterMs);
  const goodAge = age(part.lastGoodAt) ?? age(part.downSince); // never good: as old as the wait for it
  const stale = staleAfterMs !== undefined && (goodAge ?? 0) >= staleAfterMs;
  const { status, lastGoodAt, downSince, detail } = part;
  return {
    level: down ? "down" : stale ? "stale" : "ok",
    status,
    lastGoodAt,
    downSince,
    staleAfterMs,
    downAfterMs,
    detail,
  };
}
