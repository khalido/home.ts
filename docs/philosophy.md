# Philosophy

I want my house in a TypeScript import. A Telegram bot, a Mac launcher and a terminal all ask the same questions: are the lights on, what is the AC doing, what is the roof making, what does power cost right now, is it about to rain. This library answers them, from memory, in a millisecond, and takes the few writes I actually make: lights off, a scene, an announcement on the speakers.

It is not a home automation server. Home Assistant is the reference and the inspiration. But it is a thing you run, with its own UI, database and rules engine, and my apps would talk to it over yet another API. I wanted the devices in-process, one folder per device, covering only what I own.

## How it is shaped

- **One folder per device.** `src/connectors/hue`, `daikin`, `enphase`, `amber`, `weather`, `cast`. Each has a client that talks to the device, an integration that keeps its state fresh, a README with the official docs and what the live device answered. A new device is a new folder; nothing in the core changes.
- **The snapshot is the cache.** Every integration keeps its own state current, by event stream or on its own timer. Callers read a snapshot that never touches a device. A slow device never slows a keystroke.
- **One call does the right thing.** `hue()` pins the bridge's certificate, keeps the connection alive, spaces writes to Signify's rate limit and reconnects with backoff. There is nothing to switch on and no configuration to get wrong.
- **Nothing is hidden or corrected.** Every field a device reports is optional, and an odd reading passes through with a flag rather than being clamped or rounded. If the solar meter says today equals the lifetime total, you see that.
- **Your keys, your storage.** The library never reads the environment or a file and never writes a key. Callers pass addresses, keys and a `fetch`. Only the `home` command reads a shell.
- **Runs in Bun and Node.** `fetch`, Web Streams and zod, nothing else, so the same code serves the launcher and the bot. The few things that need a socket or a process live on their own subpaths and are passed in.
- **Libraries over hand-rolled code**, with one exception: when the only libraries are unmaintained or GPL, I write the small version and say which sources I read.

## What it borrows

Home Assistant's vocabulary and its quality scale: a connector is `local_push` or `local_polling` or `cloud_polling`, keeps the last good data through a failed poll, stops polling on a rejected key, and never surprises the device with more writes than its vendor allows. Its integration source is where the protocol facts live; this is a pocket version of that pattern, without the parts that need a UI.

## What it is not

Not a rules engine. Automations ("hot day, excess solar, AC on") belong in the apps that import this, once the numbers have been watched for a while. No cloud between me and my devices: Hue, Daikin, Enphase and Cast are read on the LAN, and off it they say so. Amber and the weather are cloud services and are polled as such. Not a platform: there is no plugin host, and a device I do not own is a device this library does not cover.
