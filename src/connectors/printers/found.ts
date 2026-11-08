import type { Found } from "../../discover.ts";

/** One resolved mDNS instance, as `mdnsResolve` in src/finders.ts returns it. */
export type Answer = {
  host: string;
  port: number;
  instance: string;
  txt: Record<string, string>;
};

/** TXT keys are case-insensitive in DNS-SD; AirPrint's are written `UUID`, `ty`, `rp`. */
const lower = (txt: Record<string, string>) =>
  Object.fromEntries(Object.entries(txt).map(([k, v]) => [k.toLowerCase(), v]));

/**
 * AirPrint printers as found devices: the identity is TXT `UUID` (the instance name when absent), the name TXT `ty` (else
 * the instance name), the model `ty`. `txt` keeps the whole record for the connector (`rp`, `pdl`, `URF`, `product`,
 * `adminurl`, `note`). A printer on both types is one entry, the plain `_ipp._tcp` one (`ipp` listed first), so a
 * self-signed certificate on `_ipps._tcp` never decides; a printer on `_ipps._tcp` alone is `secure`.
 */
export function printersFound(ipp: Answer[], ipps: Answer[]): Found[] {
  const seen = new Set<string>();
  const out: Found[] = [];
  for (const [secure, answers] of [
    [false, ipp],
    [true, ipps],
  ] as const)
    for (const a of answers) {
      const txt = lower(a.txt);
      const id = txt.uuid || a.instance;
      const key = id.toLowerCase().replace(/[^0-9a-z]/g, "");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        connector: "printers",
        id,
        host: a.host,
        port: a.port,
        name: txt.ty || a.instance,
        model: txt.ty,
        secure,
        txt,
      });
    }
  return out;
}
