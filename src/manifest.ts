import type { Part } from "./home.ts";

// What each connector declares about itself, so the CLI, `.env.example` and the docs derive from one place. Modelled on
// Home Assistant's manifest (domain, name, iot_class). Each connector's index.ts exports one as `manifest`.

/** Home Assistant's `iot_class`: where the device is and how its state arrives. */
export type IotClass = "local_push" | "local_polling" | "cloud_polling";

/** One environment name the CLI reads for a connector; `.env.example` is written from these. `optional`: `home status` runs without it. */
export type EnvVar = { name: string; what: string; optional?: boolean; example?: string };

export type Manifest<S = unknown> = {
  /** The folder, the config's connector literal, the integration's name and the CLI verb: "hue". */
  name: string;
  title: string;
  iotClass: IotClass;
  pollSeconds?: number;
  /** What it reaches and with what key, for `home status`. */
  access: string;
  /** Every env name the CLI reads for this connector, in `.env.example`'s order. */
  env: EnvVar[];
  /** Config fields that are file paths, read relative to the config file. */
  files?: string[];
  /** The status text: the first line is the connector's own summary, any further lines its children (rooms, devices). Empty without state. */
  lines(part: Part<S>): string[];
  /** The state as `home status --json` shows it, when it is not the state itself. */
  record?(part: Part<S>): Record<string, unknown>;
};

/** Watts as "1.2 kW", or "" without a number. Rounded for reading only. */
export const kw = (w: unknown) => (typeof w === "number" ? `${(w / 1000).toFixed(1)} kW` : "");

/** A value's text when it exists, else "": a missing field is left out, never printed as "undefined". */
export const field = (value: number | undefined, text: (v: number) => string) => (value === undefined ? "" : text(value));
