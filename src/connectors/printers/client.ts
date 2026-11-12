import { ConnectorError, fetchTimeout } from "../../connector.ts";
import {
  attributesOf,
  decodeMessage,
  getPrinterAttributesRequest,
  type IppAttribute,
  type IppMessage,
  OPERATION,
  operationRequest,
  TAG,
} from "./codec.ts";

// Pure calls: a `fetch`, an address and the bytes to send come in, the printer's answer goes out. The reads are
// Get-Printer-Attributes; the writes Identify-Printer, Validate-Job, Print-Job and Cancel-Job. The document is the caller's,
// already in a format the printer lists (`document-format-supported`): this package makes no PDF into raster.

/** Everything the integration reads from one printer. */
export const REQUESTED = [
  "printer-state",
  "printer-state-reasons",
  "printer-state-message",
  "marker-names",
  "marker-levels",
  "marker-types",
  "marker-colors",
  "media-ready",
  "queued-job-count",
  "printer-alert",
  "printer-make-and-model",
  "printer-uuid",
  "document-format-supported",
  "ipp-versions-supported",
  "printer-is-accepting-jobs",
];

/** Where a printer answers: IPP is HTTP POST to `/<rp>`; port 443 (or a found `_ipps._tcp`) is TLS. */
export type PrinterAddress = {
  host: string;
  port?: number;
  rp?: string;
  secure?: boolean;
};

/** Most printers answer on this path (IPP Everywhere); the TXT `rp` says when theirs differs. */
export const DEFAULT_RP = "ipp/print";

/** The URL to POST to and the `ipp(s)://` URI the request names. A TXT `rp` may or may not start with a slash. */
export function printerUrl(a: PrinterAddress): {
  http: string;
  ipp: string;
  secure: boolean;
  path: string;
} {
  const secure = a.secure ?? a.port === 443;
  const port = a.port ?? (secure ? 443 : 631);
  const path = (a.rp || DEFAULT_RP).replace(/^\/+/, "");
  const host = a.host.includes(":") ? `[${a.host}]` : a.host;
  return {
    http: `${secure ? "https" : "http"}://${host}:${port}/${path}`,
    ipp: `${secure ? "ipps" : "ipp"}://${host}:${port}/${path}`,
    secure,
    path,
  };
}

/** A few status codes by name, for the error text; any other shows as hex. */
const STATUS: Record<number, string> = {
  0x0400: "client-error-bad-request",
  0x0401: "client-error-forbidden",
  0x0402: "client-error-not-authenticated",
  0x0403: "client-error-not-authorized",
  0x0404: "client-error-not-possible",
  0x0406: "client-error-not-found",
  0x040a: "client-error-document-format-not-supported",
  0x0500: "server-error-internal-error",
  0x0501: "server-error-operation-not-supported",
  0x0503: "server-error-service-unavailable",
  0x0507: "server-error-busy",
};

type CallOptions = {
  requestId?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
};

/**
 * One IPP request over HTTP, through `fetchTimeout`. A non-ok HTTP status or an IPP status of 0x0100 and up throws a
 * ConnectorError saying which (`code: "ipp"`, the IPP status in `status`).
 */
async function call(
  fetcher: typeof fetch,
  address: PrinterAddress,
  body: (ippUri: string) => Uint8Array<ArrayBuffer>,
  options: CallOptions = {},
): Promise<IppMessage> {
  const url = printerUrl(address);
  const res = await fetchTimeout(
    fetcher,
    url.http,
    {
      method: "POST",
      headers: { "content-type": "application/ipp", accept: "application/ipp" },
      body: body(url.ipp),
    },
    options,
  );
  if (!res.ok)
    throw new ConnectorError(`HTTP ${res.status} on POST /${url.path}`, {
      status: res.status,
    });
  const message = decodeMessage(new Uint8Array(await res.arrayBuffer()));
  if (message.code >= 0x0100) {
    const why = attributesOf(message, 1)["status-message"]?.[0];
    throw new ConnectorError(
      `IPP ${STATUS[message.code] ?? `status 0x${message.code.toString(16).padStart(4, "0")}`}${typeof why === "string" ? `: ${why}` : ""}`,
      { status: message.code, code: "ipp" },
    );
  }
  return message;
}

/** Get-Printer-Attributes: the whole response; `attributesOf` gives the printer's attributes. `requested` replaces the poll's list. */
export const getPrinterAttributes = (
  fetcher: typeof fetch,
  address: PrinterAddress,
  options: CallOptions & { requested?: string[] } = {},
): Promise<IppMessage> =>
  call(
    fetcher,
    address,
    (uri) =>
      getPrinterAttributesRequest(
        uri,
        options.requested ?? REQUESTED,
        options.requestId,
      ),
    options,
  );

/** Identify-Printer: the printer shows or sounds that it is the one (PWG 5100.13). No paper. */
export const identifyPrinter = (
  fetcher: typeof fetch,
  address: PrinterAddress,
  options: CallOptions = {},
): Promise<unknown> =>
  call(
    fetcher,
    address,
    (uri) =>
      operationRequest(OPERATION.identifyPrinter, uri, {
        requestId: options.requestId,
      }),
    options,
  );

/**
 * What a job says about itself. `format` is the document's MIME type and must be one the printer lists; `media` a PWG
 * media name (`iso_a4_210x297mm`). `sides` defaults to `one-sided`, sent explicitly so a printer's duplex default
 * never applies to a document made for one side.
 */
export type PrintJob = {
  format: string;
  name?: string;
  user?: string;
  media?: string;
  sides?: "one-sided" | "two-sided-long-edge" | "two-sided-short-edge";
  copies?: number;
};

/** A job the printer took: its id, and its state when it answered (RFC 8011: 3 pending, 5 processing, 9 completed). */
export type PrintedJob = { jobId?: number; state?: number; reasons?: string[] };

/** Who asks: RFC 8011 has a client send it on every operation. `home` unless the caller names someone. */
const userAttribute = (user = "home"): IppAttribute => ({
  name: "requesting-user-name",
  tag: TAG.nameWithoutLanguage,
  values: [user],
});

function jobAttributes(job: PrintJob): {
  attributes: IppAttribute[];
  job: IppAttribute[];
} {
  const attributes: IppAttribute[] = [
    userAttribute(job.user),
    {
      name: "job-name",
      tag: TAG.nameWithoutLanguage,
      values: [job.name ?? "home"],
    },
    { name: "document-format", tag: TAG.mimeMediaType, values: [job.format] },
  ];
  const attrs: IppAttribute[] = [
    { name: "sides", tag: TAG.keyword, values: [job.sides ?? "one-sided"] },
  ];
  if (job.media)
    attrs.push({ name: "media", tag: TAG.keyword, values: [job.media] });
  if (job.copies !== undefined)
    attrs.push({ name: "copies", tag: TAG.integer, values: [job.copies] });
  return { attributes, job: attrs };
}

/** Validate-Job: the printer checks the job's attributes as Print-Job would, and prints nothing. */
export const validateJob = (
  fetcher: typeof fetch,
  address: PrinterAddress,
  job: PrintJob,
  options: CallOptions = {},
): Promise<unknown> =>
  call(
    fetcher,
    address,
    (uri) =>
      operationRequest(OPERATION.validateJob, uri, {
        ...jobAttributes(job),
        requestId: options.requestId,
      }),
    options,
  );

/** No upload waits longer than this: a page of raster is a few hundred kB, and a printer can be slow to take it. */
export const PRINT_TIMEOUT_MS = 60_000;

/**
 * Print-Job: the job's attributes and the document in one request. A timeout leaves it unknown whether the printer took
 * the job, so the error says not to send it again blindly.
 */
export async function printJob(
  fetcher: typeof fetch,
  address: PrinterAddress,
  job: PrintJob,
  document: Uint8Array,
  options: CallOptions = {},
): Promise<PrintedJob> {
  let answer: IppMessage;
  try {
    answer = await call(
      fetcher,
      address,
      (uri) =>
        operationRequest(OPERATION.printJob, uri, {
          ...jobAttributes(job),
          data: document,
          requestId: options.requestId,
        }),
      { timeoutMs: PRINT_TIMEOUT_MS, ...options },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError")
      throw new ConnectorError(
        "the printer did not answer the print job in time; it may still print, so check the printer before sending it again",
        { code: "timeout", cause: error },
      );
    throw error;
  }
  const a = attributesOf(answer, TAG.job);
  const n = (v: unknown) => (typeof v === "number" ? v : undefined);
  const reasons = a["job-state-reasons"]?.filter(
    (r): r is string => typeof r === "string",
  );
  return {
    jobId: n(a["job-id"]?.[0]),
    state: n(a["job-state"]?.[0]),
    reasons: reasons?.length ? reasons : undefined,
  };
}

/** Cancel-Job: stop a job by its id, from Print-Job's answer. */
export const cancelJob = (
  fetcher: typeof fetch,
  address: PrinterAddress,
  jobId: number,
  options: CallOptions & { user?: string } = {},
): Promise<unknown> =>
  call(
    fetcher,
    address,
    (uri) =>
      operationRequest(OPERATION.cancelJob, uri, {
        requestId: options.requestId,
        attributes: [
          { name: "job-id", tag: TAG.integer, values: [jobId] },
          userAttribute(options.user), // printers often let only the job's owner cancel it
        ],
      }),
    options,
  );
