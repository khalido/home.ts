import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { asOf, ConnectorError } from "../src/index.ts";
import { fetchTimeout, getJson } from "../src/connector.ts";
import { AmberError } from "../src/connectors/amber/index.ts";
import { manualClock } from "./clock.ts";

/** A fetch that never answers: it rejects with the signal's reason once the signal aborts. */
const hang = (async (_url: string, init?: RequestInit) =>
  new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }))) as unknown as typeof fetch;

const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("fetchTimeout", () => {
  test("a caller's abort cancels the read in flight", async () => {
    const run = new AbortController();
    const read = fetchTimeout(hang, "http://192.0.2.1/", {}, { signal: run.signal });
    run.abort();
    expect((await read.catch((e) => e)).name).toBe("AbortError");
  });
  test("the timeout fires without a caller's signal", async () => {
    expect((await fetchTimeout(hang, "http://192.0.2.1/", {}, { timeoutMs: 10 }).catch((e) => e)).name).toBe("TimeoutError");
  });
  test("the timeout still fires when a caller's signal is given and never aborts", async () => {
    const read = fetchTimeout(hang, "http://192.0.2.1/", {}, { timeoutMs: 10, signal: new AbortController().signal });
    expect((await read.catch((e) => e)).name).toBe("TimeoutError");
  });
  test("returns a non-ok response as it is", async () => {
    expect((await fetchTimeout(answer({}, 503), "http://192.0.2.1/")).status).toBe(503);
  });
});

describe("getJson", () => {
  test("a non-ok status becomes a ConnectorError with the status and the path, never the query", async () => {
    const error = await getJson(answer({}, 401), "http://192.0.2.1/v1/sites?key=secret").catch((e) => e);
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error).toMatchObject({ status: 401, message: "HTTP 401 on GET /v1/sites" });
  });
  test("throws the connector's own error class, whose name shows in a detail", async () => {
    const error = await getJson(answer({}, 500), "http://192.0.2.1/x", { init: { method: "POST" }, error: AmberError }).catch((e) => e);
    expect(error).toBeInstanceOf(AmberError);
    expect(String(error)).toBe("AmberError: HTTP 500 on POST /x");
  });
  test("a schema parses the body; without one the body comes back as sent", async () => {
    const schema = z.looseObject({ n: z.number().optional() });
    expect(await getJson(answer({ n: 1, extra: true }), "http://192.0.2.1/", { schema })).toEqual({ n: 1, extra: true });
    await expect(getJson(answer({ n: "one" }), "http://192.0.2.1/", { schema })).rejects.toThrow();
    expect(await getJson(answer([1, 2]), "http://192.0.2.1/")).toEqual([1, 2]);
  });
});

describe("asOf", () => {
  test("the clock's now as ISO", async () => {
    const { clock, advance } = manualClock();
    expect(asOf(clock)).toBe("1970-01-01T00:00:00.000Z");
    await advance(90_000);
    expect(asOf(clock)).toBe("1970-01-01T00:01:30.000Z");
  });
});

describe("errorText", () => {
  test("the message, and the cause's when it differs: Node's fetch keeps the reason there", async () => {
    const { errorText } = await import("../src/connector.ts");
    expect(errorText(new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 192.0.2.10:443") }))).toBe("fetch failed: connect ECONNREFUSED 192.0.2.10:443");
    expect(errorText(new Error("no route"))).toBe("no route");
    expect(errorText("plain")).toBe("plain");
  });
});
