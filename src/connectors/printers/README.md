# Printers

AirPrint printers, found by mDNS and read over IPP on the local network. `iot_class`: **local_polling** (one Get-Printer-Attributes per printer every 120 s). Built read-only; **untried on a live printer** (the Brother KO has did not answer mDNS on 2026-10-14, see Live findings).

Try it: `home printers`

## Built

- `printers({ printers, fetch, find, seen })` keeps every printer current as one integration. A config entry per printer (`uuid`, `name`, last known `host` and `port`, `room`, `offlineDays`); discovery adds any AirPrint printer the config does not list.
- Per poll: one `POST` to each printer. The snapshot (`PrintersState`) holds one `Printer` per UUID (lowercase, no dashes): `name`, `model`, `host`, `state` (`idle`, `printing`, `stopped`, `offline`), `stateCode`, `reasons`, `message`, `markers` (`name`, `level`, `type`, `color`), `media` (`media-ready`), `queuedJobs`, `acceptingJobs`, `formats`, `ippVersions`, `alerts`, `ipps`, `lastSeen`, `asOf`, `detail`, `anomaly`.
- **Offline.** An unreachable printer stays in the snapshot as `offline`, keeping its last good values and `lastSeen`. The part is `connected` while any printer answers and `disconnected` otherwise, never `unavailable` for being unreachable (printers go on and off). After `offlineDays` (default 14) without an answer the entry says so in `anomaly`; after a day its `detail` says "no answer for a day". `lastSeen` lives in memory: a restart starts the count again.
- **Odd values pass through.** A `printer-state` outside 3 to 5 leaves `state` out, keeps `stateCode`, and is named in `anomaly`. A marker level outside 0 to 100 stays as sent and is named (PWG 5100.13 reserves negative levels for "unknown" kinds; read it before treating one as empty). Marker lists of different lengths are named too.
- **Identity check.** The printer's `printer-uuid` must match the entry's UUID, or the read fails with "the address answers as another printer", so a recycled address never shows one printer's toner under another's name.
- **Discovery** is one shared scan, as Cast's is, not a relocator per printer (the relocator is one device and one scan each; three printers down would be three `dns-sd` runs). It runs at start, after a failed read at 1, 5 and 15 minutes then hourly (`rescanDelay`), hourly for new printers, and a `refresh()` resets the backoff. A moved printer is found by its UUID and read again at once; `detail` says "not found by discovery" only after a scan looked and missed it (`lostDetail`).
- `home discover` lists printers and `--write` adds them (`uuid`, `name`, `host`, `port`); `home probe` reads each once. No writes. The place for them is marked `TODO(writes…)` in `client.ts`.

## Protocol

IPP is a binary message in an HTTP `POST` with `content-type: application/ipp`, to `http://host:port/<rp>`; `ipps` is the same over TLS. The path `rp` is TXT `rp` (most printers: `ipp/print`; the default here). The request names the printer by an `ipp://` or `ipps://` URI.

The Get-Printer-Attributes request (`codec.ts`), RFC 8010 section 3: version 2.0, operation `0x000B`, a request id, then the operation-attributes group with `attributes-charset` `utf-8`, `attributes-natural-language` `en`, `printer-uri`, and `requested-attributes`: `printer-state`, `printer-state-reasons`, `printer-state-message`, `marker-names`, `marker-levels`, `marker-types`, `marker-colors`, `media-ready`, `queued-job-count`, `printer-alert`, `printer-make-and-model`, `printer-uuid`, `document-format-supported`, `ipp-versions-supported`, `printer-is-accepting-jobs`.

The codec is about 200 lines by hand, like Cast's, in place of the `ipp` npm package. It decodes integer, enum, boolean, every string tag, dateTime, resolution, rangeOfInteger and octetString; any other tag, a wrong length for a known tag, and a whole collection (skipped by depth) come back as `{ tag, bytes }`, never thrown. Only a message cut short throws. A response status of `0x0100` or more, or a non-2xx HTTP status, is a `ConnectorError` naming it.

Discovery is mDNS `_ipp._tcp` and `_ipps._tcp` ([Apple's AirPrint TXT keys](https://developer.apple.com/bonjour/printing-specification/bonjourprinting-1.2.pdf)): `UUID` is the identity (the instance name when absent), `ty` the name and model, `rp` the path; `pdl`, `URF`, `product`, `adminurl` and `note` are kept in the found record's `txt`. A printer on both types is one entry, the plain `_ipp._tcp` one, so a self-signed certificate on `_ipps._tcp` never decides; a printer on `_ipps._tcp` alone is read over TLS.

**TLS.** Printers sign their own certificates. `fetch` verifies them, and the read fails with its error in `detail`; nothing here turns verification off. If a printer only speaks IPPS, the fix is the caller's `fetch` (pin the certificate, as Hue's does), not this package's.

**Node.** Node's `fetch` refuses port 631 (it is on the WHATWG bad-port list, as IPP's well-known port). Bun does not. A Node caller would need a `fetch` that allows it, or the IPPS entry on 443. Not tried.

## Unverified

Everything, until a real printer answers: the request bytes (the codec is checked against RFC 8010's layout and a fixture of invented values, not a printer), the default path `ipp/print`, that `printer-uuid` equals TXT `UUID` on a Brother, that a sleeping printer wakes for the request, what a Brother sends for `marker-levels` and `printer-alert` (the sample uses invented values), Bun's `fetch` on port 631, and the macOS local-network prompt on first use.

## Live findings

None yet. 2026-10-14 (Bun 1.4.3): `home discover` (two passes) and `home printers` found no `_ipp._tcp` or `_ipps._tcp` instance on the network, so the Brother was not advertising (off, asleep, or on another network).

## Sources

- [RFC 8010](https://www.rfc-editor.org/rfc/rfc8010) (IPP/1.1: Encoding and Transport) and [RFC 8011](https://www.rfc-editor.org/rfc/rfc8011) (Model and Semantics): the layout, the tags, `Get-Printer-Attributes`, `printer-state`. IETF documents; facts and layouts used, no text copied.
- [PWG 5100.13](https://ftp.pwg.org/pub/pwg/candidates/cs-ippjobprinterext3v10-20120727-5100.13.pdf) (IPP Job and Printer Extensions Set 3): `marker-*`. [PWG 5101.1](https://ftp.pwg.org/pub/pwg/candidates/cs-pwgmsn20-20130328-5101.1.pdf): media keywords such as `iso_a4_210x297mm`. PWG documents, facts only.
- [CUPS](https://www.cups.org/doc/spec-ipp.html) documentation of the IPP attributes it uses (Apache-2.0 with exceptions); read, not copied.
- Home Assistant's [`ipp` integration](https://www.home-assistant.io/integrations/ipp/) (Apache-2.0) and its library [pyipp](https://github.com/ctalkington/python-ipp) (MIT): read for which attributes to ask for and how states and markers are interpreted.
- Apple's [Bonjour Printing Specification](https://developer.apple.com/bonjour/printing-specification/) for the TXT keys.
- The fixture (`test/fixtures/printers/get-printer-attributes.hex`) is an invented printer built with this codec: documentation-style values, a made-up UUID, nothing from a real device.
