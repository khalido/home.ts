// IPP's binary encoding (RFC 8010) by hand, enough for Get-Printer-Attributes: a request out, a response in. A message is
// version (2 bytes), operation or status code (2), request id (4), then attribute groups, then 0x03, then any document data.
// Each attribute is a value tag, a name (length + bytes) and a value (length + bytes); a further value of the same attribute
// repeats the tag with a zero-length name. Both directions share the one layout, so one encoder and one decoder.

/** Delimiter tags open a group; value tags (0x10 and up) carry one value. Only the ones this package reads or writes are named. */
export const TAG = {
  operation: 0x01,
  job: 0x02,
  end: 0x03,
  printer: 0x04,
  unsupported: 0x05,
  integer: 0x21,
  boolean: 0x22,
  enum: 0x23,
  octetString: 0x30,
  dateTime: 0x31,
  resolution: 0x32,
  rangeOfInteger: 0x33,
  begCollection: 0x34,
  endCollection: 0x37,
  textWithoutLanguage: 0x41,
  nameWithoutLanguage: 0x42,
  keyword: 0x44,
  uri: 0x45,
  uriScheme: 0x46,
  charset: 0x47,
  naturalLanguage: 0x48,
  mimeMediaType: 0x49,
} as const;

/** The operation ids this package sends (RFC 8011; Identify-Printer from PWG 5100.13). */
export const OPERATION = {
  printJob: 0x0002,
  validateJob: 0x0004,
  cancelJob: 0x0008,
  getPrinterAttributes: 0x000b,
  identifyPrinter: 0x003c,
} as const;

const STRING_TAGS: ReadonlySet<number> = new Set([
  TAG.textWithoutLanguage,
  TAG.nameWithoutLanguage,
  TAG.keyword,
  TAG.uri,
  TAG.uriScheme,
  TAG.charset,
  TAG.naturalLanguage,
  TAG.mimeMediaType,
]);

export type IppRange = { lower: number; upper: number };
export type IppResolution = {
  x: number;
  y: number;
  units: "dpi" | "dpcm" | number;
};
/** A value whose tag this decoder does not read (a language-tagged string, a collection, an out-of-band marker), or whose length is wrong for its tag: the bytes, unchanged. */
export type IppUnknown = { tag: number; bytes: Uint8Array };
/**
 * One decoded value. Integers and enums are numbers; every string tag is a string; a dateTime is an ISO 8601 string with
 * its offset; an octetString is bytes. A collection decodes to one `IppUnknown` with no bytes, its members skipped.
 */
export type IppValue =
  | number
  | boolean
  | string
  | Uint8Array
  | IppRange
  | IppResolution
  | IppUnknown;

export type IppAttribute = { name: string; tag: number; values: IppValue[] };
export type IppGroup = { tag: number; attributes: IppAttribute[] };
/** A request or a response: `code` is the operation id of a request or the status code of a response. */
export type IppMessage = {
  version: [number, number];
  code: number;
  requestId: number;
  groups: IppGroup[];
  data?: Uint8Array;
};

const utf8 = new TextEncoder();
const text = new TextDecoder();

const u16 = (n: number) => [(n >> 8) & 255, n & 255];
const u32 = (n: number) => [
  (n >>> 24) & 255,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
];

function encodeValue(tag: number, value: IppValue): number[] {
  if (STRING_TAGS.has(tag)) return [...utf8.encode(String(value))];
  if (tag === TAG.integer || tag === TAG.enum) return u32(Number(value));
  if (tag === TAG.boolean) return [value ? 1 : 0];
  if (tag === TAG.rangeOfInteger)
    return [
      ...u32((value as IppRange).lower),
      ...u32((value as IppRange).upper),
    ];
  if (tag === TAG.resolution) {
    const r = value as IppResolution;
    return [
      ...u32(r.x),
      ...u32(r.y),
      r.units === "dpi" ? 3 : r.units === "dpcm" ? 4 : Number(r.units),
    ];
  }
  if (tag === TAG.dateTime) {
    const m = String(value).match(
      /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)\.(\d)([+-])(\d\d):(\d\d)$/,
    );
    if (!m)
      throw new Error(
        `ipp: a dateTime is YYYY-MM-DDTHH:MM:SS.d+HH:MM, got ${String(value)}`,
      );
    const n = m.slice(1).map((x, i) => (i === 7 ? x.charCodeAt(0) : Number(x)));
    return [...u16(n[0]!), ...n.slice(1)];
  }
  if (value instanceof Uint8Array) return [...value];
  if (typeof value === "object" && "bytes" in value) return [...value.bytes];
  throw new Error(`ipp: cannot encode tag 0x${tag.toString(16)}`);
}

/** A message as bytes. Collections are not encoded (a Get-Printer-Attributes request has none). */
export function encodeMessage(m: IppMessage): Uint8Array<ArrayBuffer> {
  const out: number[] = [...m.version, ...u16(m.code), ...u32(m.requestId)];
  for (const g of m.groups) {
    out.push(g.tag);
    for (const a of g.attributes)
      a.values.forEach((v, i) => {
        const name = i === 0 ? utf8.encode(a.name) : new Uint8Array();
        const value = encodeValue(a.tag, v);
        out.push(
          a.tag,
          ...u16(name.length),
          ...name,
          ...u16(value.length),
          ...value,
        );
      });
  }
  out.push(TAG.end);
  const bytes = new Uint8Array(out.length + (m.data?.length ?? 0));
  bytes.set(out);
  if (m.data) bytes.set(m.data, out.length);
  return bytes;
}

/**
 * A request to one printer: IPP 2.0, utf-8, English, the printer's `ipp://` URI, then `attributes` in the operation
 * group, `job` (when given) in a job group, and `data` (a document) after the end tag.
 */
export function operationRequest(
  code: number,
  printerUri: string,
  options: {
    attributes?: IppAttribute[];
    job?: IppAttribute[];
    data?: Uint8Array;
    requestId?: number;
  } = {},
): Uint8Array<ArrayBuffer> {
  return encodeMessage({
    version: [2, 0],
    code,
    requestId: options.requestId ?? 1,
    groups: [
      {
        tag: TAG.operation,
        attributes: [
          { name: "attributes-charset", tag: TAG.charset, values: ["utf-8"] },
          {
            name: "attributes-natural-language",
            tag: TAG.naturalLanguage,
            values: ["en"],
          },
          { name: "printer-uri", tag: TAG.uri, values: [printerUri] },
          ...(options.attributes ?? []),
        ],
      },
      ...(options.job?.length
        ? [{ tag: TAG.job, attributes: options.job }]
        : []),
    ],
    data: options.data,
  });
}

/** The Get-Printer-Attributes request: the attributes wanted. */
export const getPrinterAttributesRequest = (
  printerUri: string,
  requested: string[],
  requestId = 1,
) =>
  operationRequest(OPERATION.getPrinterAttributes, printerUri, {
    requestId,
    attributes: [
      { name: "requested-attributes", tag: TAG.keyword, values: requested },
    ],
  });

const fail = (why: string): never => {
  throw new Error(`ipp: ${why}`);
};

function decodeValue(tag: number, bytes: Uint8Array): IppValue {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const unknown = { tag, bytes };
  if (STRING_TAGS.has(tag)) return text.decode(bytes);
  if (tag === TAG.octetString) return bytes;
  if (tag === TAG.integer || tag === TAG.enum)
    return bytes.length === 4 ? view.getInt32(0) : unknown;
  if (tag === TAG.boolean) return bytes.length === 1 ? bytes[0] !== 0 : unknown;
  if (tag === TAG.rangeOfInteger)
    return bytes.length === 8
      ? { lower: view.getInt32(0), upper: view.getInt32(4) }
      : unknown;
  if (tag === TAG.resolution) {
    if (bytes.length !== 9) return unknown;
    const units = bytes[8]!;
    return {
      x: view.getInt32(0),
      y: view.getInt32(4),
      units: units === 3 ? "dpi" : units === 4 ? "dpcm" : units,
    };
  }
  if (tag === TAG.dateTime) {
    if (bytes.length !== 11) return unknown;
    const p = (n: number) => String(n).padStart(2, "0");
    const [mo, d, h, mi, s, ds, dir, uh, um] = [2, 3, 4, 5, 6, 7, 8, 9, 10].map(
      (i) => bytes[i]!,
    );
    return `${view.getUint16(0)}-${p(mo!)}-${p(d!)}T${p(h!)}:${p(mi!)}:${p(s!)}.${ds}${String.fromCharCode(dir!)}${p(uh!)}:${p(um!)}`;
  }
  return unknown;
}

/**
 * A message's bytes as groups of attributes. An unknown or malformed value is kept as `IppUnknown`, never thrown; only a
 * message that cannot be walked (cut short, a value before any attribute) throws. A collection and its members are skipped.
 */
export function decodeMessage(bytes: Uint8Array): IppMessage {
  if (bytes.length < 9) fail("a message is at least 9 bytes");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  let i = 8;
  const need = (n: number) =>
    i + n <= bytes.length || fail("the message is cut short");
  /** One attribute element at `i`: tag, name, value bytes. */
  const element = () => {
    need(3);
    const tag = bytes[i++]!;
    const nameLength = view.getUint16(i);
    i += 2;
    need(nameLength + 2);
    const name = text.decode(bytes.subarray(i, i + nameLength));
    i += nameLength;
    const valueLength = view.getUint16(i);
    i += 2;
    need(valueLength);
    const value = bytes.subarray(i, i + valueLength);
    i += valueLength;
    return { tag, name, value };
  };
  const groups: IppGroup[] = [];
  let group: IppGroup | undefined;
  let last: IppAttribute | undefined;
  for (;;) {
    need(1);
    const tag = bytes[i]!;
    if (tag === TAG.end) {
      i++;
      break;
    }
    if (tag < 0x10) {
      i++;
      groups.push((group = { tag, attributes: [] }));
      last = undefined;
      continue;
    }
    const e = element();
    let value: IppValue;
    if (e.tag === TAG.begCollection) {
      for (let depth = 1; depth > 0;) {
        const inner = element();
        if (inner.tag === TAG.begCollection) depth++;
        else if (inner.tag === TAG.endCollection) depth--;
      }
      value = { tag: e.tag, bytes: new Uint8Array() };
    } else value = decodeValue(e.tag, e.value.slice());
    if (!group) fail("an attribute before any group");
    if (e.name === "") {
      if (!last) fail("a further value before any attribute");
      last!.values.push(value);
    } else {
      last = group!.attributes.find((a) => a.name === e.name);
      if (last) last.values.push(value);
      else
        group!.attributes.push(
          (last = { name: e.name, tag: e.tag, values: [value] }),
        );
    }
  }
  return {
    version: [bytes[0]!, bytes[1]!],
    code: view.getUint16(2),
    requestId: view.getUint32(4),
    groups,
    ...(i < bytes.length ? { data: bytes.slice(i) } : {}),
  };
}

/** Every attribute of the groups with this tag (default: the printer's), by name, repeats merged. */
export function attributesOf(
  m: IppMessage,
  groupTag: number = TAG.printer,
): Record<string, IppValue[]> {
  const out: Record<string, IppValue[]> = {};
  for (const g of m.groups)
    if (g.tag === groupTag)
      for (const a of g.attributes) (out[a.name] ??= []).push(...a.values);
  return out;
}
