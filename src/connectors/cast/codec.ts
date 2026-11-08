// CastV2's one protobuf message, CastMessage (cast_channel.proto), by hand: six fields, two wire types. Each message on
// the socket is a 4-byte big-endian length, then the encoded message. Only string payloads (JSON) are used.

/** One message on a Cast socket. `payload` is the JSON text; a binary payload (unused by any namespace here) comes as undefined. */
export type CastMessage = {
  source: string;
  destination: string;
  namespace: string;
  payload?: string;
};

/** The namespaces a state reader uses. */
export const NS = {
  connection: "urn:x-cast:com.google.cast.tp.connection",
  heartbeat: "urn:x-cast:com.google.cast.tp.heartbeat",
  receiver: "urn:x-cast:com.google.cast.receiver",
  media: "urn:x-cast:com.google.cast.media",
  multizone: "urn:x-cast:com.google.cast.multizone",
} as const;

/** The largest message the protocol allows (64 KiB); a longer length prefix means the stream is out of step. */
export const MAX_MESSAGE = 65_536;

const text = new TextEncoder();
const varint = (n: number): number[] => {
  const out: number[] = [];
  for (; n > 127; n = Math.floor(n / 128)) out.push((n % 128) | 128);
  return [...out, n];
};
const field = (number: number, value: string): number[] => {
  const bytes = text.encode(value);
  return [(number << 3) | 2, ...varint(bytes.length), ...bytes];
};

/** A message as framed on the socket: version 0, string payload. */
export function encode(m: CastMessage): Uint8Array {
  const body = [
    0x08,
    0,
    ...field(2, m.source),
    ...field(3, m.destination),
    ...field(4, m.namespace),
    0x28,
    0,
    ...field(6, m.payload ?? ""),
  ];
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return out;
}

/** One message's bytes (without the length prefix). Unknown fields are skipped. */
export function decode(bytes: Uint8Array): CastMessage {
  const strings: Record<number, string> = {};
  let i = 0;
  const read = () => {
    let n = 0;
    for (let scale = 1; ; scale *= 128) {
      if (i >= bytes.length) throw new Error("cast: truncated varint");
      const b = bytes[i++]!;
      n += (b & 127) * scale;
      if (b < 128) return n;
    }
  };
  const decoder = new TextDecoder();
  while (i < bytes.length) {
    const key = read();
    const wire = key & 7;
    if (wire === 0) read();
    else if (wire === 2) {
      const length = read();
      if (i + length > bytes.length) throw new Error("cast: truncated field");
      strings[key >> 3] = decoder.decode(bytes.subarray(i, i + length));
      i += length;
    } else if (wire === 1 || wire === 5) i += wire === 1 ? 8 : 4;
    else throw new Error(`cast: unknown wire type ${wire}`);
  }
  return {
    source: strings[2] ?? "",
    destination: strings[3] ?? "",
    namespace: strings[4] ?? "",
    payload: strings[6],
  };
}

/** Splits a byte stream into messages: `push` each chunk as it arrives, get back every message it completed. */
export function framer() {
  let buffer = new Uint8Array(0);
  return (chunk: Uint8Array): CastMessage[] => {
    const joined = new Uint8Array(buffer.length + chunk.length);
    joined.set(buffer);
    joined.set(chunk, buffer.length);
    const out: CastMessage[] = [];
    let at = 0;
    while (joined.length - at >= 4) {
      const length = new DataView(joined.buffer, at).getUint32(0);
      if (length > MAX_MESSAGE)
        throw new Error(
          `cast: a ${length}-byte message, over the protocol's ${MAX_MESSAGE}`,
        );
      if (joined.length - at < 4 + length) break;
      out.push(decode(joined.subarray(at + 4, at + 4 + length)));
      at += 4 + length;
    }
    buffer = joined.slice(at);
    return out;
  };
}

/** An open Cast socket. `peer` is its certificate's name (a device's id), `protocol` its TLS version. Tests pass a fake. */
export type CastChannel = {
  peer?: string;
  protocol?: string;
  send(message: CastMessage): void;
  messages: AsyncIterable<CastMessage>;
  close(): void;
};

/** How to open one: `tlsConnect` from `@khalido/home/cast/tls` in Bun and Node. */
export type CastConnect = (to: {
  host: string;
  port: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}) => Promise<CastChannel>;
