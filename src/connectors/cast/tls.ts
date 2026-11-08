import { connect } from "node:tls";
import {
  type CastChannel,
  type CastConnect,
  type CastMessage,
  encode,
  framer,
} from "./codec.ts";

// The one Node API in the Cast connector, so it sits outside the runtime-neutral build (tsconfig.build.json), like
// weather/ftp.ts, and is passed in as `connect`. Runs in Bun (1.4.2, checked live) and, untried, Node.
//
// Verification is off: every Cast device presents a self-signed certificate that rotates every 48 hours, so there is
// nothing to pin. The integration instead checks the certificate's name (`peer`, the device's id) against discovery.

/** Open a Cast socket: TLS to host:port within `timeoutMs`, framed CastMessages in and out. */
export const tlsConnect: CastConnect = ({
  host,
  port,
  signal,
  timeoutMs = 10_000,
}) =>
  new Promise<CastChannel>((resolve, reject) => {
    const socket = connect({ host, port, rejectUnauthorized: false });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: Error) => (
      clearTimeout(timer),
      signal?.removeEventListener("abort", abort),
      socket.destroy(),
      reject(error)
    );
    timer = setTimeout(
      () =>
        fail(
          new Error(
            `cast: no TLS answer from ${host}:${port} in ${timeoutMs / 1000} s`,
          ),
        ),
      timeoutMs,
    );
    const abort = () => fail(new Error("aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.off("error", fail);
      const name = socket.getPeerCertificate().subject?.CN;
      resolve(
        channel(
          socket,
          Array.isArray(name) ? name[0] : name,
          socket.getProtocol() ?? undefined,
        ),
      );
    });
  });

/** The socket as an async stream of messages; the stream ends when the socket closes and throws on a socket error. */
function channel(
  socket: ReturnType<typeof connect>,
  peer: string | undefined,
  protocol: string | undefined,
): CastChannel {
  const split = framer();
  const queue: CastMessage[] = [];
  let ended = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  const notify = () => (wake?.(), (wake = undefined));
  socket.on("data", (chunk: Buffer) => {
    try {
      queue.push(...split(new Uint8Array(chunk)));
    } catch (error) {
      failure = error as Error;
      socket.destroy();
    }
    notify();
  });
  socket.on("error", (error) => ((failure ??= error), notify()));
  socket.on("close", () => ((ended = true), notify()));
  return {
    peer,
    protocol,
    send: (m) => void (socket.writable && socket.write(encode(m))),
    // end() flushes a CLOSE written just before; a device that does not close its side within a second is cut off.
    close: () => (
      socket.end(),
      setTimeout(() => socket.destroy(), 1000).unref()
    ),
    messages: (async function* () {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (failure) throw failure;
        if (ended) return;
        await new Promise<void>((r) => (wake = r));
      }
    })(),
  };
}
