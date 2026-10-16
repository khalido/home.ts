# Enphase: field notes

Investigations behind the Enphase connector, moved out of [its README](../src/connectors/enphase/README.md) on 2026-10-14: moving the gateway between networks, what the first probe found, and the cloud API that was not chosen.

## Moving it to another Wi-Fi

**The owner's path: the Enphase app.** No Installer Toolkit needed. Stand near the gateway, logged in as the system owner, and open Menu ▸ Settings ▸ Connectivity ▸ Configure Wi-Fi. When asked, **briefly press** the gateway's AP Mode button: its AP Mode LED turns solid green and it opens its own network, `ENVOY_nnnnnn` (the last six digits of the serial). Pick the home network and enter its password. Source: Enphase support, [Reconnect your gateway to Wi-Fi using the Enphase App](https://support.enphase.com/s/article/reconnecting-your-gateway-to-wi-fi-using-the-enphase-app). That page renders only in a browser; these steps come from search summaries of it and its Dutch and French versions (unconfirmed word for word).

- **Do not hold the button.** A press starts an eight-hour AP session; **holding it 5 s starts WPS** instead. If it was held, wait 2 minutes and press briefly (Dutch support article, unconfirmed).
- **Fallback: the gateway's own page.** On `ENVOY_nnnnnn`, open `http://172.30.1.1` (support article, unconfirmed), or the local interface at its LAN address, then Wi-Fi ▸ Connect Other Network, and enter the network name and password ([Envoy-S manual](https://portal.segen.co.uk/reseller/docs/Envoy-S-MAN-EN-INTL.pdf), 141-00035 Rev 02, "Envoy-S is not Connecting with a New Router"). On software 7 and later that page asks for the owner token (TEB-00060).

**LEDs** (manual): Network Communications flashing green while it connects, **solid green within three minutes** when it reaches Enphase, solid amber when it has the local network but missed its report (five minutes), off with no network. AP Mode solid green while the AP session runs; off in normal use. Never cut power while the LEDs flash green: a software update is running.

**Still "down" in the app afterwards:** the gateway reports every 15 minutes (KO's observation), so allow 15 to 30 minutes. If the LED is solid green, the cloud catches up on the next report. If it is amber or off, power-cycle the gateway at its breaker (Enphase community moderator, unconfirmed) and retry.

**Guest Wi-Fi:** eero keeps guest devices apart from the main network. A gateway there can reach Enphase but not jaldi or the `home` CLI. Use the main network, then reserve its address in the eero app.

## Probe (2026-10-13)

The gateway was first on the guest Wi-Fi, which eero keeps apart from the main network, so `home probe` found nothing; on the main network it answered `/info` over HTTPS only (port 80 closed).

## The cloud alternative

The Enlighten v4 API at [developer-v4.enphase.com](https://developer-v4.enphase.com/): OAuth 2 plus an API key, free Watt plan at 10 requests a minute and 1,000 a month, site-level data only ([plans](https://developer-v4.enphase.com/developer-plans)). Not planned while the local API works.
