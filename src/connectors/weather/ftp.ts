import { Client, FTPError } from "basic-ftp";
import { Writable } from "node:stream";

// The one file in the library that uses Node APIs (net and stream, through basic-ftp), so it sits outside the
// runtime-neutral build (tsconfig.build.json) and has its own (tsconfig.node.json). Runs in Bun and Node.

/**
 * A `fetch` that also reads anonymous `ftp://` URLs (BOM's products), passing every other URL to the global `fetch`.
 * One connection per request; a missing file answers 404. Honours `init.signal`, so a caller's timeout applies.
 */
export function ftpFetch(timeoutMs = 10_000): typeof fetch {
  const f = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "ftp:") return fetch(input, init);
    const client = new Client(timeoutMs);
    const abort = () => client.close();
    init?.signal?.throwIfAborted();
    init?.signal?.addEventListener("abort", abort, { once: true });
    const chunks: Buffer[] = [];
    try {
      await client.access({
        host: url.hostname,
        port: url.port ? Number(url.port) : 21,
        user: url.username || "anonymous",
        password: url.password || "anonymous@",
      });
      const sink = new Writable({
        write: (chunk: Buffer, _encoding, done) => (chunks.push(chunk), done()),
      });
      await client.downloadTo(sink, decodeURIComponent(url.pathname));
      return new Response(new Uint8Array(Buffer.concat(chunks)), {
        status: 200,
      });
    } catch (error) {
      init?.signal?.throwIfAborted();
      if (error instanceof FTPError && error.code === 550)
        return new Response(error.message, { status: 404 });
      throw error;
    } finally {
      init?.signal?.removeEventListener("abort", abort);
      client.close();
    }
  };
  return f as typeof fetch;
}
