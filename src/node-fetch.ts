import { Agent, fetch as undiciFetch } from "undici";
import type { LoadOptions } from "./config.ts";

// `@khalido/home/node`: the fetches Hue and Enphase need under Node, where Bun's `tls` fetch option does not exist. Node's
// global `fetch` takes no CA, so these use undici's own `fetch` and `Agent` (one undici on both sides). Outside the
// runtime-neutral build, like cast/tls.ts; a Node consumer passes `NODE_TLS` to `loadHome`, or one fetch to `hue()` or `enphase()`.

/** undici's `fetch` through `dispatcher`. Takes a URL, not a `Request`, and returns undici's own `Response`. */
const through = (dispatcher: Agent) => ((input: RequestInfo | URL, init?: RequestInit) => undiciFetch(input as never, { ...init, dispatcher } as never)) as unknown as typeof fetch;

/** A `fetch` that trusts only `ca` and accepts only a certificate whose CN is `bridgeId`: Node's `bunPinnedFetch`. */
export function nodePinnedFetch(bridgeId: string, ca: string): typeof fetch {
  const checkServerIdentity = (_host: string, cert: { subject?: { CN?: string | string[] } }) => {
    const cn = [cert.subject?.CN].flat()[0];
    return cn?.toLowerCase() === bridgeId.toLowerCase() ? undefined : new Error(`Hue bridge certificate is for ${cn ?? "nobody"}, expected ${bridgeId}`);
  };
  return through(new Agent({ connect: { ca, checkServerIdentity } }));
}

/** A `fetch` for the Enphase gateway that skips certificate verification, for its requests only: Node's `bunGatewayFetch`. */
export function nodeGatewayFetch(): typeof fetch {
  return through(new Agent({ connect: { rejectUnauthorized: false } }));
}

/** What `loadHome` takes as `tls` under Node. */
export const NODE_TLS = { hue: nodePinnedFetch, enphase: nodeGatewayFetch } satisfies LoadOptions["tls"];
