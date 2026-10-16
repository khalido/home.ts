import { ConnectorError, fetchTimeout } from "../../connector.ts";
import { attributesOf, decodeMessage, getPrinterAttributesRequest, type IppMessage } from "./codec.ts";

// Pure reads: a `fetch`, an address and a path come in, the printer's attributes go out. No writes here yet.
// TODO(writes, behind KO's hand): Identify-Printer (0x003C, a beep) first, then Print-Job (0x0002) with application/pdf
// where `document-format-supported` lists it. Each is one more request builder in codec.ts and one function here.

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
export type PrinterAddress = { host: string; port?: number; rp?: string; secure?: boolean };

/** Most printers answer on this path (IPP Everywhere); the TXT `rp` says when theirs differs. */
export const DEFAULT_RP = "ipp/print";

/** The URL to POST to and the `ipp(s)://` URI the request names. A TXT `rp` may or may not start with a slash. */
export function printerUrl(a: PrinterAddress): { http: string; ipp: string; secure: boolean; path: string } {
  const secure = a.secure ?? a.port === 443;
  const port = a.port ?? (secure ? 443 : 631);
  const path = (a.rp || DEFAULT_RP).replace(/^\/+/, "");
  const host = a.host.includes(":") ? `[${a.host}]` : a.host;
  return { http: `${secure ? "https" : "http"}://${host}:${port}/${path}`, ipp: `${secure ? "ipps" : "ipp"}://${host}:${port}/${path}`, secure, path };
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

/**
 * Get-Printer-Attributes over HTTP, through `fetchTimeout`. A non-ok HTTP status or an IPP status of 0x0100 and up throws a
 * ConnectorError saying which. Returns the whole response; `attributesOf` gives the printer's attributes.
 */
export async function getPrinterAttributes(
  fetcher: typeof fetch,
  address: PrinterAddress,
  options: { requestId?: number; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<IppMessage> {
  const url = printerUrl(address);
  const res = await fetchTimeout(
    fetcher,
    url.http,
    { method: "POST", headers: { "content-type": "application/ipp", accept: "application/ipp" }, body: getPrinterAttributesRequest(url.ipp, REQUESTED, options.requestId) },
    options,
  );
  if (!res.ok) throw new ConnectorError(`HTTP ${res.status} on POST /${url.path}`, { status: res.status });
  const message = decodeMessage(new Uint8Array(await res.arrayBuffer()));
  if (message.code >= 0x0100) {
    const why = attributesOf(message, 1)["status-message"]?.[0];
    throw new ConnectorError(`IPP ${STATUS[message.code] ?? `status 0x${message.code.toString(16).padStart(4, "0")}`}${typeof why === "string" ? `: ${why}` : ""}`, { status: message.code, code: "ipp" });
  }
  return message;
}
