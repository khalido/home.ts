import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import type { ServeClip } from "./writes.ts";

// Node APIs (http, os), so this sits outside the runtime-neutral build like tls.ts and is passed to `cast()` as
// `serve`. A Cast device fetches the clip itself, so it must be served over HTTP on the LAN, never loopback.

/** How long a clip stays served when nothing fetches it. */
export const SERVE_MS = 60_000;

const ipv4 = (a: string) => a.split(".").reduce((n, part) => n * 256 + Number(part), 0);
/** The network an address is on under a netmask: the address with its host bits cleared. */
const network = (address: string, netmask: string) => ipv4(address) - (ipv4(address) % (2 ** 32 - ipv4(netmask)));

/** This machine's IPv4 on the subnet that holds `host`, or with no host, its first non-internal IPv4. */
export function lanAddress(host?: string, interfaces = networkInterfaces()): string {
  const all = Object.values(interfaces).flatMap((list) => list ?? []).filter((i) => i.family === "IPv4");
  const pick = host ? all.find((i) => network(i.address, i.netmask) === network(host, i.netmask)) : all.find((i) => !i.internal);
  if (!pick) throw new Error(host ? `no address of this machine on ${host}'s network` : "no LAN IPv4 address on this machine");
  return pick.address;
}

/**
 * Serve `bytes`: a random port, an unguessable path, the given `Content-Type` and its `Content-Length`, the whole body
 * to every GET (a player may probe before it fetches). It closes on `close()` (`announce` calls it when the clip has
 * played), when `signal` aborts, or after `SERVE_MS`. `host` is the device that will fetch it, so the address is on its network.
 */
export const serveClip: ServeClip = (bytes, type, options = {}) =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Error("aborted"));
    const address = lanAddress(options.host);
    const path = `/${randomUUID()}`;
    const server = createServer((req, res) => {
      if (req.url !== path || (req.method !== "GET" && req.method !== "HEAD")) return res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": type, "Content-Length": bytes.length });
      res.end(req.method === "HEAD" ? undefined : bytes);
    });
    const timer = setTimeout(() => close(), SERVE_MS);
    function close() {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", close);
      server.close();
      server.closeAllConnections();
    }
    options.signal?.addEventListener("abort", close, { once: true });
    server.once("error", (error) => (close(), reject(error)));
    server.listen(0, address, () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://${address}:${port}${path}`, close });
    });
  });
