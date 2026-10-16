// Printers without a config: what `home status`, `home printers` and `home probe` run. Cached addresses first, then
// discovery (AirPrint over mDNS) finds the rest. Read-only; the integration has no writes yet.
import { printers } from "../connectors/printers/index.ts";
import { addressBook } from "../discover.ts";
import { FINDERS } from "../finders.ts";
import { addresses } from "./context.ts";

/** Every printer the address cache knows plus whatever discovery finds, read once. */
export function printersNow() {
  const book = addressBook(addresses.cache);
  const known = Object.entries(book.entries()).flatMap(([key, c]) => (key.startsWith("printers:") ? [{ uuid: key.slice(9), name: c.name, host: c.host, port: c.port }] : []));
  return printers({ printers: known, find: FINDERS.printers, seen: (uuid, a) => book.seen("printers", uuid, a) });
}
