// `home lights off`, `home light`, `home room`, `home scene`, `home pair` (also as `home hue <verb>`): one write to the bridge each,
// then what the bridge reports. The name lookups and the checks are the library's (`client.light`, `room`, `scene`).
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import {
  bunPinnedFetch,
  type GroupView,
  type HueApplied,
  HueError,
  homeGroupedLightId,
  hue,
  hueClient,
  hueText,
  type LightChange,
  type LightView,
  pairWhenPressed,
} from "../connectors/hue/index.ts";
import { snapshotFrom } from "../connectors/hue/state.ts";
import { FINDERS } from "../finders.ts";
import { env, fail, usage, type Verbs } from "./context.ts";

/** The bridge from HUE_BRIDGE_HOST and HUE_BRIDGE_ID, else found by mDNS, cached nowhere. */
export async function bridge(): Promise<{ host: string; id: string }> {
  if (env.HUE_BRIDGE_HOST && env.HUE_BRIDGE_ID)
    return { host: env.HUE_BRIDGE_HOST, id: env.HUE_BRIDGE_ID };
  const b =
    (await FINDERS.hue())[0] ??
    fail("no Hue bridge found by mDNS; set HUE_BRIDGE_HOST and HUE_BRIDGE_ID");
  return { host: env.HUE_BRIDGE_HOST ?? b.host, id: env.HUE_BRIDGE_ID ?? b.id };
}

/** HUE_CA_FILE when set; else undefined, and the package's own copy of Signify's roots is used. */
export const ca = () =>
  env.HUE_CA_FILE ? readFileSync(env.HUE_CA_FILE, "utf8") : undefined;

const key = () =>
  env.HUE_APPLICATION_KEY ??
  fail("set HUE_APPLICATION_KEY", "auth", "home pair");

/** Hue as an integration from the shell's env names, for `home status`. */
export async function hueFromEnv() {
  const b = await bridge();
  return hue({ host: b.host, bridgeId: b.id, key: key(), ca: ca() });
}

async function client() {
  const b = await bridge();
  return hueClient({
    host: b.host,
    key: key(),
    fetch: bunPinnedFetch(b.id, ca()),
  });
}

/** What a write left, in a line: the light or room as the bridge then reported it, or that it has not reported the change yet. */
const said = ({ state, confirmed }: HueApplied<LightView | GroupView>) =>
  console.log(
    confirmed
      ? hueText(state)
      : `sent; the bridge has not reported it yet (${hueText(state)})`,
  );

export const CHANGE_USAGE = "[on|off] [<1-100>] [<kelvin>k] [<hex colour>]";
/** The words after a name as a change: `on`, `off`, `40` (brightness), `2700k` (white), `ff8800` (colour), in any order. */
export function changeFrom(words: string[], usageLine: string): LightChange {
  const change: LightChange = {};
  for (const w of words) {
    if (w === "on" || w === "off") {
      if (change.on !== undefined && change.on !== (w === "on"))
        usage(`on or off, not both; ${usageLine}`);
      change.on = w === "on";
    } else if (/^\d{1,3}%?$/.test(w))
      change.brightness = Number.parseInt(w, 10);
    else if (/^\d{4,5}k$/i.test(w)) change.kelvin = Number.parseInt(w, 10);
    else if (/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(w)) change.color = w;
    else
      usage(
        `"${w}" is not on, off, a brightness, a temperature like 2700k or a colour like ff8800; ${usageLine}`,
      );
  }
  if (!words.length) usage(usageLine);
  return change;
}

/** A change the bridge can't make (an unknown name, a value off the light's range) is a usage error; anything else passes through. */
const orUsage = (e: unknown): never => {
  if (e instanceof HueError && e.code === "invalid") usage(e.message);
  throw e;
};

/** How long `home pair` waits for the button: time to walk to the bridge. */
const PAIR_WAIT_MS = 60_000;

export const hueVerbs: Verbs = {
  async lights([state]) {
    if (state !== "off") usage("usage: home lights off");
    const c = await client();
    const id =
      homeGroupedLightId(snapshotFrom(await c.get(), "")) ??
      fail("the bridge has no home group");
    await c.put("grouped_light", id, { on: { on: false } });
  },

  async light([name, ...words]) {
    const line = `usage: home light <name> ${CHANGE_USAGE}`;
    if (!name) usage(line);
    const change = changeFrom(words, line);
    said(await (await client()).light(name!, change).catch(orUsage));
  },

  async room([name, ...words]) {
    const line = `usage: home room <name> ${CHANGE_USAGE}`;
    if (!name) usage(line);
    const change = changeFrom(words, line);
    said(await (await client()).room(name!, change).catch(orUsage));
  },

  async scene(words) {
    const line = "usage: home scene <name> [in <room>]";
    if (!words.length) usage(line);
    const c = await client();
    // "Relax in Bedroom" is the scene Relax in that room, unless a scene is named all of it.
    const at = words.lastIndexOf("in");
    const whole = () => c.scene(words.join(" "));
    said(
      await (
        at > 0 && at < words.length - 1
          ? whole().catch(() =>
              c.scene(
                words.slice(0, at).join(" "),
                words.slice(at + 1).join(" "),
              ),
            )
          : whole()
      ).catch(orUsage),
    );
  },

  async pair() {
    const b = await bridge();
    console.error(`Hue bridge ${b.id.slice(-6).toUpperCase()} at ${b.host}.`);
    // The countdown redraws one line on a terminal; piped, it is one line said once.
    const live = process.stderr.isTTY;
    const until = Date.now() + PAIR_WAIT_MS;
    const prompt = () =>
      `Press the link button on the bridge: ${Math.max(0, Math.ceil((until - Date.now()) / 1000))} s left`;
    let tick: ReturnType<typeof setInterval> | undefined;
    const { key } = await pairWhenPressed({
      host: b.host,
      fetch: bunPinnedFetch(b.id, ca()),
      deviceType: `home#${hostname().slice(0, 19)}`,
      timeoutMs: PAIR_WAIT_MS,
      onWaiting() {
        if (!live) return console.error(prompt());
        process.stderr.write(prompt());
        tick = setInterval(
          () => process.stderr.write(`\r\x1b[K${prompt()}`),
          1000,
        );
      },
    })
      .finally(() => {
        clearInterval(tick);
        if (tick) process.stderr.write("\r\x1b[K");
      })
      .catch((e) =>
        e.code === "link_button"
          ? fail(
              `no button press detected in ${PAIR_WAIT_MS / 1000} s; nothing was changed`,
              "auth",
              "home pair",
            )
          : Promise.reject(e),
      );
    console.error(
      "Paired. Put these in your shell environment or .env (never in a repo):",
    );
    console.log(
      `HUE_APPLICATION_KEY=${key}\nHUE_BRIDGE_HOST=${b.host}\nHUE_BRIDGE_ID=${b.id}`,
    );
  },
};
