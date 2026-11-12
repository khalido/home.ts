# Enphase

Reads an IQ Gateway (Envoy) on the LAN: production, consumption and grid flow. `iot_class`: **local_polling**, every 60 s. Tried on one metered gateway with microinverters, **software D8.3.5528**, `web-tokens: true` (read 2026-10-13).

## Built

- `enphase({ host, token, fetch: bunGatewayFetch() })` polls every 60 s (the caller chooses the TLS trade-off; see below). With a production meter on, it reads `GET /ivp/meters` and `GET /ivp/meters/readings`, joined by `eid` (`fromReadings`): about 100 ms on KO's gateway, where `/production.json?details=1` takes 1–10 s (measured, Bun 1.4.2) against a 10 s timeout. Production is the production meter's `activePower`; on a net-consumption meter, consumption is production plus net import, and lifetime consumption is production + imported − exported. Both matched `/production.json` live to within a few watts and to the Wh. Without a production meter it falls back to `/production.json` (`toState`).
- Today is counted by the integration from the lifetime counters, from its first reading of the day (`todaySince`). The day starts at midnight in `timeZone` (the home config's `location.timezone`, an IANA name), the runtime's zone when unset, so a consumer on a UTC server does not reset at 10 am Sydney.
- Today's peak (`productionWPeakToday`, since `peakSince`) is the highest production the integration has read today, one read a minute, so a short burst between reads is missed. It starts again at the home's midnight, or when the integration starts. A drawing scales the roof's panels by it when the config gives no `capacityW` (`solarLevel` in `src/energy.ts`).
- `host` may be pasted with a scheme or a trailing slash (`https://…/`); `gatewayHost` reduces it to the bare host for requests, discovery and the address cache.
- In the home config the device may carry `marker` (the plan's marker where the array is drawn, on the roof outside any room) and `capacityW` (the array's rated watts from the installer's paperwork, never guessed from the gateway). Neither reaches the gateway; they are for drawing.
- A meter counts only when `/ivp/meters` says `enabled` **and** its reading has `activeCount > 0`; otherwise production comes from the inverters and Wh today is left out, since pyenphase found the inverter daily total unreliable.
- The token's days left ride in the snapshot; under 30 the status says to run `home enphase login`. A 401 or 403 marks Enphase unavailable and stops polling.
- `home enphase login` mints the token (below) and writes `~/.config/home/enphase-token.json` (0600, directory 0700), printing only the days left. `home status` shows solar now, consumption and the token's days left.

**Live, KO's gateway, 2026-10-13 (D8.3.5528, owner token).** `/info` answers without a token; everything else answers 401 without one. With the token, one GET each:

- `/ivp/meters`: `production` and `net-consumption` **enabled**, `meteringStatus normal`; `storage`, `backfeed`, `load`, `evse`, `pv3p` disabled. So both CTs are fitted.
- `/production.json?details=1`: `production` holds `inverters` (`activeCount`, `wNow`, `whLifetime`, no daily fields) and `eim production` (20 fields); `consumption` holds `eim total-consumption` and `eim net-consumption`; `storage` holds an inactive `acb`. At dusk production was near zero and net consumption matched consumption less production.
- **Anomaly**: on every `eim` reading, `whToday`, `whLastSevenDays` and `whLifetime` are the same number. The daily counters are broken on this firmware. `toState` drops them and sets `anomaly`; `enphase()` counts today from the lifetime counter from its first reading of the day and marks where that count starts (`todaySince`).
- `/api/v1/production`: all zeros except `wattHoursLifetime`. Not used.
- `/ivp/meters/readings`: 8 entries with `eid`, `timestamp`, `actEnergyDlvd`, `actEnergyRcvd`, `instantaneousDemand` and more. Not used yet.
- The lifetime totals disagree across the production meter, the inverters (far lower) and `/api/v1`. The meter is used; why the inverter total is lower is unconfirmed (a reset or replacement is a guess).

## TLS: why the Bun path skips verification

The gateway's certificate is **not self-signed** on software 8: it serves `CN=<serial>.<part>._mDevice.enphaseenergy.com`, issued by `Cloud.HSM.TA`, then `Factories.MFR.CA` (valid to 2070), which chains to `root-a.PKI.CA`. The gateway does not send that root and Enphase does not publish it (searched 2026-10-13).

- **Bun 1.4.2** (measured): trusting `Factories.MFR.CA` fails with "unable to get issuer certificate" (no partial-chain trust), and with verification off Bun does not run `checkServerIdentity`, so the CN cannot be checked either. `bunGatewayFetch()` therefore skips verification for the gateway's requests only. The token goes to whatever answers at that address, so reserve the address in the router.
- **Node**: `nodeGatewayFetch()` from `@khalido/home/node` skips verification the same way (checked against a local self-signed server, 2026-10-28; the gateway did not answer that day). Untested: undici's `Agent({ connect: { ca: factoriesMfrCa, allowPartialTrustChain: true, checkServerIdentity } })`, checking the CN starts with the serial, would pin it properly (Node 22.9 and later).

## The plan: local IQ Gateway with an owner token

Source for every step: Enphase's technical brief [Accessing IQ Gateway local APIs and local UI using token](https://enphase.com/download/iq-gateway-local-apis-or-ui-access-using-token) (TEB-00060-2.0, June 2025). It lists ENV-S-WM-230 among the gateways it covers.

1. **Mint a token once** (`home enphase login`, KO runs it). Gateway software 7.0 and later needs a token for local APIs. The brief's script does two calls:
   - `POST https://enlighten.enphaseenergy.com/login/login.json` with form fields `user[email]` and `user[password]`, returning a `session_id`. (The brief writes `http://`; use HTTPS.)
   - `POST https://entrez.enphaseenergy.com/tokens` with JSON `{ session_id, serial_num, username }`, returning the token.

   A system owner's token is valid for **one year**; an installer's, or a self-installer's, for 12 hours. Unconfirmed which KO's account is; the token's expiry will say.

2. **Cache it** in `~/.config/home/enphase-token.json`, owner-only (0600), written by the CLI only. The library never stores it; callers pass it in. The password is read from `ENPHASE_PASSWORD` for those two calls and never written.
3. **Read locally**: HTTPS to the gateway with `Authorization: Bearer <token>` and `Accept: application/json`. The brief uses `curl -k`; see TLS above.

Endpoints from the brief: `/info` (serial, part number, software; **no token needed**), `/api/v1/production` (watts now, watt-hours today, seven days, lifetime), `/api/v1/production/inverters`, `/ivp/meters`, `/ivp/meters/readings`, `/ivp/pdm/energy`, `/ivp/livedata/status`, `/ivp/meters/reports/consumption`, `/ivp/meters/gridReading`.

```sh
home enphase login   # mints the token from IQ_GATEWAY_SERIAL_NUMBER, ENPHASE_USERNAME, ENPHASE_PASSWORD; prints its expiry
```

## From Home Assistant's `enphase_envoy`

Its coordinator polls the gateway every 60 s, rechecks the firmware every 4 h, checks the token once a day, and refreshes it when fewer than 30 days remain, raising a repair notice if that fails. The plan copies the policy: `home status` shows the token's days left, and a client warns under 30.

## Sources

| Source                                                                                                                               | Licence                     | Used for                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Enphase [Envoy-S manual](https://portal.segen.co.uk/reseller/docs/Envoy-S-MAN-EN-INTL.pdf) (141-00035 Rev 02, a reseller's copy)     | Enphase document            | LEDs, AP mode, Wi-Fi change                                                                                                   |
| Enphase [TEB-00060-2.0](https://enphase.com/download/iq-gateway-local-apis-or-ui-access-using-token)                                 | Enphase document, © Enphase | token flow, local endpoints                                                                                                   |
| [Enphase developer v4](https://developer-v4.enphase.com/)                                                                            | Enphase API terms           | the cloud alternative                                                                                                         |
| [Home Assistant `enphase_envoy` integration](https://github.com/home-assistant/core/tree/dev/homeassistant/components/enphase_envoy) | Apache-2.0                  | how HA reads a local gateway                                                                                                  |
| [pyenphase/pyenphase](https://github.com/pyenphase/pyenphase)                                                                        | MIT                         | endpoints for software 8, the meter rules, and the test fixtures (copied with attribution)                                    |
| The author's earlier Python dashboard (not public)                                                                                   | the author's                | ran against this gateway: the env names, `/production.json` with `/ivp/meters`, trusting a meter only when enabled and active |
