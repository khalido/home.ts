---
name: use-home
description: Use the `home` command and the @khalido/home library to see and run a home - lights, AC, solar, prices, weather, speakers, printers, household spending. Covers connecting (keys, addresses, discovery on macOS and Linux), reading safely, the JSON and exit codes, what each status means, and the rules for writes. Use when asked about the house ("is the AC on?", "what's solar doing?", "will it rain at pickup?"), when running a scheduled check of the home, or when setting `home` up on a new machine.
---

# Use home

`home` reads the house from the machine it runs on: devices on the LAN directly, cloud services (Amber, Up, weather) over HTTPS. There is no server and no cloud of ours in between. Read freely; write only when a person asks.

## Rules

- **Reads are free.** `home`, `home <connector>`, `home discover`, `home probe`, `home up spend` and every `--json` read touch nothing.
- **Writes only on request.** Lights, AC, speakers, Up categories and tags, webhooks: run one only when the person asked for that change, then read back and report the state it left. Never write to "test" something.
- **Never print a key, token or password**, not even part of one. Say "set" or "unset". Env names are fine; values are not.
- **Nothing private into a public repo**: no IPs, MACs, serials, device or room names, Up transactions or balances. A real `home.jsonc`, `home.svg` and floor plan live in a private folder.
- **Show values as read.** A missing field is unknown, not zero. An `anomaly` is something odd the device said: report it, never smooth it.

## Reading

```sh
home                          # every connector, one line each, energy now on top; exits 0
home weather                  # one connector; exits 1 when it is not connected
home weather --json | jq .blocks.today
home up spend --json          # household spending this window, by category
home --help                   # every command and verb
```

The contract (in `docs/cli.md`): stdout is data, stderr everything else. `--json` errors are `{"error", "code", "fix"}` on stderr; `fix` is the one command that resolves it. Exit 0 success (empty included), 1 a failure or a connector not connected, 2 a wrong command or argument.

What a status means:

| Status         | Meaning                                                                                                                                                         | What to do                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `connected`    | read and current                                                                                                                                                | use it                                            |
| `connecting`   | still starting (a 15 s cap in the CLI)                                                                                                                          | wait, or run again                                |
| `disconnected` | the device or service did not answer; the last good state is kept, with its `asOf`                                                                              | say so; check the device is on and at its address |
| `unavailable`  | stopped for good: a key rejected, a setting wrong; `reason`, when present, is `auth` (a person must re-key), `config` (a setting or file is wrong) or `crashed` | the `detail` names it; fix the key or setting     |
| `not set up`   | env names or a file missing (`needs` lists them)                                                                                                                | set them, or say what is needed                   |

Weather: `blocks` holds morning, afternoon and evening for today and tomorrow in the home's time zone; `rainSoon` says when rain starts in the next two hours (needs the Google key). Energy: `now` in `home --json` is the one owner of solar, use, grid flow and cost per hour; never recompute it.

## Connecting

**Keys** come from environment variables by name (`.env.example` lists them; Bun loads `.env` from the working directory). A real environment variable beats `.env`. Some keys come from a command, not a website:

- Hue: press the bridge's button, then `home pair` within 30 s; it prints the env lines. Set `HUE_CA_FILE` to Signify's root CA (`src/connectors/hue/README.md`).
- Enphase: `home enphase login` once a year writes the owner token to `~/.config/home/enphase-token.json` (0600).
- Amber, Up, Google Weather: a token from each service's website.
- Spotify (Soloist): no key in `home`; Soloist's own API key is the daemon's. Set `SOLOIST_WS` to the address its `--ws` opens. Signed out is normal until someone picks the speaker in the Spotify app.

Copying a working `.env` (and the CA file) to another machine works: the keys are not tied to the machine.

**A config instead of env**: `--config home.jsonc` or `HOME_CONFIG`. It names devices by identity, rooms and the location; secrets stay env names. `home config check` shows what it would set up and every problem, secrets only as set or unset.

## Addresses

- **Reserve them.** Give the Hue bridge, the Enphase gateway, the AC and the printers a DHCP reservation in the router. Then the config's or env's addresses stay right and discovery is only a fallback.
- **Devices are matched by identity, not address**: Hue's bridge id, the Daikin's MAC, the gateway's serial, a Cast id. A device that moves is found again by discovery after failed reads; the detail says "moved from a to b".
- **The address cache** (`~/.cache/home/addresses.json`, `home cache`, `home cache clear`) keeps what discovery found between runs.
- `home discover` lists what answers on the network and which `home` supports; with a config, `home discover --write` updates moved addresses and new devices in it.

## Discovery (mDNS and DNS-SD)

Hue, Enphase, Cast and printers announce themselves over mDNS. `home` asks the system's own mDNS daemon rather than listening itself:

- **macOS**: `dns-sd`, built in.
- **Linux** (Raspberry Pi OS): `avahi-browse`. avahi-daemon runs by default; the command is a package: `sudo apt install avahi-utils`. Without it, discovery says "avahi-browse not found".
- **Daikin** answers a UDP broadcast on port 30050, on both.

If discovery finds nothing: the machine must be on the same network and subnet as the devices (not a guest network, not a separate VLAN), multicast must pass (no "multicast optimisation" or client isolation on the access point), and a firewall must allow mDNS (UDP 5353). `home probe` checks each device read-only at its address, with no keys.

## From code

```ts
import { createHome, loadHome } from "@khalido/home";
const home = createHome(loadHome(config, options));
await home.start(signal); // runs until signal aborts
home.part("weather")?.state?.blocks; // typed by name; never touches a device
await home.refresh("daikin"); // read now; resolves when it has reported
```

`docs/using.md` covers wiring it into an app (Bun and Node). Automations ("if X then Y") belong in the app, not the library: the library gives the facts (`sunNow`, `rainSoon`, `dayBlocks`, `energyNow`) and the writes.

## A scheduled check

A routine that runs `home --json` periodically should: report what changed or looks wrong (a connector down, an anomaly, a token close to expiry, rain soon); stay silent when all is well; never write; never quote keys or addresses into a message.
