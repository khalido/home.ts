// `home lights off`, `home room`, `home scene`, `home pair` (also as `home hue <verb>`): one write to the bridge each.
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { bunPinnedFetch, groups, homeGroupedLightId, hue, hueClient, pair, scenes } from "../connectors/hue/index.ts";
import { snapshotFrom } from "../connectors/hue/state.ts";
import { FINDERS } from "../finders.ts";
import { die, env, fail, type Verbs } from "./context.ts";

/** The bridge from HUE_BRIDGE_HOST and HUE_BRIDGE_ID, else found by mDNS, cached nowhere. */
export async function bridge(): Promise<{ host: string; id: string }> {
  if (env.HUE_BRIDGE_HOST && env.HUE_BRIDGE_ID) return { host: env.HUE_BRIDGE_HOST, id: env.HUE_BRIDGE_ID };
  const b = (await FINDERS.hue())[0] ?? fail("no Hue bridge found by mDNS; set HUE_BRIDGE_HOST and HUE_BRIDGE_ID");
  return { host: env.HUE_BRIDGE_HOST ?? b.host, id: env.HUE_BRIDGE_ID ?? b.id };
}

export const ca = () => (env.HUE_CA_FILE ? readFileSync(env.HUE_CA_FILE, "utf8") : fail("set HUE_CA_FILE to Signify's root CA (see src/connectors/hue/README.md)"));

const key = () => env.HUE_APPLICATION_KEY ?? fail("set HUE_APPLICATION_KEY (run `home pair` to get one)");

/** Hue as an integration from the shell's env names, for `home status`. */
export async function hueFromEnv() {
  const b = await bridge();
  return hue({ ip: b.host, bridgeId: b.id, key: key(), ca: ca() });
}

async function client() {
  const b = await bridge();
  return hueClient({ ip: b.host, key: key(), fetch: bunPinnedFetch(b.id, ca()) });
}

/** Find one room, zone or scene by name, case-insensitively; a miss lists what exists. */
function byName<T extends { name?: string }>(items: T[], name: string, what: string): T {
  return items.find((i) => i.name?.toLowerCase() === name.toLowerCase()) ?? fail(`no ${what} "${name}"; have: ${items.map((i) => i.name).join(", ")}`);
}

export const hueVerbs: Verbs = {
  async lights([state]) {
    if (state !== "off") die("usage: home lights off");
    const c = await client();
    const id = homeGroupedLightId(snapshotFrom(await c.get(), "")) ?? die("the bridge has no home group");
    await c.put("grouped_light", id, { on: { on: false } });
  },

  async room([name, value]) {
    if (!name || !value) die("usage: home room <name> on|off|<1-100>");
    const c = await client();
    const room = byName(groups(snapshotFrom(await c.get(), "")), name!, "room or zone");
    if (!room.groupedLightId) die(`${room.name} has no grouped light`);
    const level = Number(value);
    if (value !== "on" && value !== "off" && !(level >= 1 && level <= 100)) die(`brightness must be 1-100, got ${value}`);
    const body = value === "on" || value === "off" ? { on: { on: value === "on" } } : { on: { on: true }, dimming: { brightness: level } };
    await c.put("grouped_light", room.groupedLightId!, body);
  },

  async scene(words) {
    const name = words.join(" ") || die("usage: home scene <name>");
    const c = await client();
    await c.recallScene(byName(scenes(snapshotFrom(await c.get(), "")), name, "scene").id);
  },

  async pair() {
    const b = await bridge();
    const { key } = await pair({ ip: b.host, fetch: bunPinnedFetch(b.id, ca()), deviceType: `home#${hostname().slice(0, 19)}` }).catch((e) =>
      die(e.code === "link_button" ? "press the link button on the bridge, then run `home pair` again within 30 s" : e.message),
    );
    console.error("Paired. Put this in your shell environment (never in a repo):");
    console.log(`HUE_APPLICATION_KEY=${key}\nHUE_BRIDGE_HOST=${b.host}\nHUE_BRIDGE_ID=${b.id}`);
  },
};
