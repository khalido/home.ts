import { manifest as amber } from "./connectors/amber/index.ts";
import { manifest as cast } from "./connectors/cast/index.ts";
import { manifest as daikin } from "./connectors/daikin/index.ts";
import { manifest as enphase } from "./connectors/enphase/index.ts";
import { manifest as hue } from "./connectors/hue/index.ts";
import { manifest as printers } from "./connectors/printers/index.ts";
import { manifest as weather } from "./connectors/weather/index.ts";
import type { Manifest } from "./manifest.ts";

/** Every connector's manifest, in the order `home status` and `.env.example` list them. */
export const MANIFESTS: Manifest<any>[] = [hue, daikin, enphase, amber, weather, cast, printers];

/** One connector's manifest by name, or undefined. */
export const manifestOf = (name: string): Manifest<any> | undefined => MANIFESTS.find((m) => m.name === name);
