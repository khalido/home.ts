# Matter

Not built. It waits for the first Matter device worth reading, a temperature sensor most likely. When it comes, the plan is a `matter` connector that talks WebSocket to a Matter server on the Pi, with Google Home staying the main controller. This page holds what we found, so the next session starts from it.

## The words

- **Matter** is the language: standard device types (light, plug, temperature sensor) and their attributes, so one controller reads any brand. Buy for the Matter logo.
- **Thread** is one radio Matter runs over: a low-power mesh, right for battery sensors. Wi-Fi and Ethernet are the others. A Thread logo alone does not mean Matter.
- A **Thread border router** links the Thread mesh to the home network: recent eeros, Nest Hub 2nd gen and Max, Nest Wifi Pro, Apple TV 4K, HomePod mini. Mains-powered Thread devices (bulbs, plugs) also extend the mesh.
- A **fabric** is one controller's set of devices and keys: Google Home's, Apple Home's, ours.

## Security: who can control a device

Being on the LAN is not enough. A new device carries a setup code (a QR code or 11 digits). Commissioning uses it once to prove you hold the device, then gives the device an operational certificate for that fabric. From then on it obeys only controllers holding that fabric's certificate, over encrypted sessions. The setup code is spent once commissioned; adding a second controller needs a fresh one-time code from a controller already on the device (multi-admin). The standard asks every device to hold at least 5 fabrics; removing one leaves the others alone.

## How this house would run it

1. **Google Home is the main controller.** Commission every device in the Google Home app first, so voice and the app keep working.
2. **The Pi joins as a second admin.** In Google Home, open the device's pairing window ("Linked Matter apps & services"), get the one-time code, and commission it into our fabric.
3. **Our controller talks straight to the device** over IPv6 on the LAN; Thread devices through a border router. No cloud. It reads attributes and subscribes to changes (a sleepy sensor pushes; never poll it).
4. **The fabric's keys live with the controller**, on the Pi, in a file. The library stores no keys, so the library never holds them.

## How the library would talk Matter

| Option                                                            | What                                                                                                                                                                                                          | For                                                                                                                                                                                                                               | Against                                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **matterjs-server**, a WebSocket client in the library (the plan) | The Open Home Foundation's [Matter server](https://github.com/matter-js/matterjs-server) on the Pi (`npx matter-server` or its Docker image, port 5580, `/ws`); a `matter` connector speaks its WebSocket API | Home Assistant's own Matter server since app 9.0 (June 2026), so the device quirks get fixed there. Keys stay in the server's `--storage-path`, not in our code. WebSocket is a web standard: the connector stays runtime-neutral | One more process on the Pi. Beta, not CSA re-certified. Its API is shaped for Home Assistant |
| matter.js in-process                                              | [matter.js](https://github.com/project-chip/matter.js) as a controller inside chota                                                                                                                           | No extra process                                                                                                                                                                                                                  | Node-only code, UDP and mDNS in the consumer; chota owns fabric storage and every quirk      |
| python-matter-server                                              | The old Home Assistant server                                                                                                                                                                                 |                                                                                                                                                                                                                                   | End of life: 8.1.2 was its last release                                                      |

The Hue bridge can expose its lights over Matter. Don't use it: Home Assistant advises against it too, since the native Hue API (the hue connector) does more.

## Network

From Home Assistant's notes, which hold for any controller:

- IPv6 enabled on the Pi (link-local is enough; no IPv6 internet or DHCPv6 needed), and IPv6 multicast passing freely.
- One flat network: Wi-Fi Matter devices, border routers and the Pi on the same LAN or VLAN. Multicast "optimisation", IGMP snooping and client isolation break discovery.
- Wi-Fi Matter devices commission on 2.4 GHz.
- Commissioning needs a phone (Android 8.1+, iOS 16+) close to the device: it uses Bluetooth only to pair.

## First steps

1. Buy one Thread sensor (an IKEA TIMMERFLOTTE: see [devices.md](devices.md)) and pair it in Google Home.
2. On the Pi: `npx matter-server --storage-path ~/.local/state/matter`. Check that IPv6 is on.
3. Share the sensor from Google Home with a one-time code; commission it through the server's WebSocket API with a throwaway script.
4. Read temperature and humidity; restart the server and read again (keys and node ids survive).
5. Then decide the connector: its state is per-device attributes by Matter device type, `iot_class` `local_push`.

## Sources

- [Home Assistant: Matter](https://www.home-assistant.io/integrations/matter/): commissioning, sharing from Google Home, border routers, network requirements, troubleshooting.
- [Home Assistant: the Matter upgrade](https://www.home-assistant.io/blog/2026/06/23/the-matter-upgrade-youve-been-waiting-for/): Matter Server 9.0 on matter.js.
- [matter-js/matterjs-server](https://github.com/matter-js/matterjs-server) (Apache-2.0), [matter-js/python-matter-server](https://github.com/matter-js/python-matter-server) (end of life), [project-chip/matter.js](https://github.com/project-chip/matter.js) (Apache-2.0).
- [Google: supported Matter device types](https://developers.home.google.com/matter/supported-devices).
