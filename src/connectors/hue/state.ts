import { type Gamut, mirekToKelvin, type XY, xyToHex } from "./color.ts";
import type { HueEvent, Resource } from "./schemas.ts";

/** Every resource on the bridge by id, from the last full read plus every event since. `asOf` is local time it was last known fresh. */
export type HueSnapshot = {
  resources: Record<string, Resource>;
  asOf: string;
  lastEventId?: string;
  lastError?: HueEvent;
};

/** A snapshot from one full `get()`. */
export function snapshotFrom(resources: Resource[], asOf: string): HueSnapshot {
  return {
    resources: Object.fromEntries(resources.map((r) => [r.id, r])),
    asOf,
  };
}

/** Apply one event batch. Pure: returns a new snapshot. Updates carry only changed fields, so they merge; unknown types are ignored. */
export function reduce(snapshot: HueSnapshot, event: HueEvent): HueSnapshot {
  if (event.type === "error") return { ...snapshot, lastError: event };
  if (!["add", "update", "delete"].includes(event.type)) return snapshot;
  const resources = { ...snapshot.resources };
  for (const item of event.data) {
    const prev = resources[item.id];
    if (event.type === "delete") delete resources[item.id];
    else
      resources[item.id] = (
        event.type === "update" && prev ? merge(prev, item) : item
      ) as Resource;
  }
  return { ...snapshot, resources };
}

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain =>
  typeof v === "object" && v !== null && !Array.isArray(v);
function merge(a: Plain, b: Plain): Plain {
  const out = { ...a };
  for (const [k, v] of Object.entries(b))
    out[k] = isPlain(v) && isPlain(a[k]) ? merge(a[k], v) : v;
  return out;
}

const ofType = (s: HueSnapshot, type: string) =>
  Object.values(s.resources).filter((r) => r.type === type);
const groupedLightOf = (s: HueSnapshot, r: Resource) =>
  r.services
    ?.map((x) => s.resources[x.rid])
    .find((x) => x?.type === "grouped_light");

/** A light as a row shows it. `reachable` is undefined when the bridge has no connectivity record for it. */
export type LightView = {
  id: string;
  name?: string;
  on?: boolean;
  brightness?: number;
  reachable?: boolean;
  /** White temperature in kelvin, while the light shows a white; its range is `kelvinRange` (warmest, coolest). */
  kelvin?: number;
  kelvinRange?: [number, number];
  /** The colour it shows: the bridge's `xy`, and `hex` for a screen (the hue at full brightness). Colour lights only. */
  xy?: XY;
  hex?: string;
  /** The colours it can show. Present on a colour light, so its presence says "takes a colour". */
  gamut?: Gamut;
};

/** Every light, with on, brightness, reachability, and its white temperature and colour where it has them. */
export function lights(s: HueSnapshot): LightView[] {
  const zigbee = ofType(s, "zigbee_connectivity");
  return ofType(s, "light").map((l) => {
    const link = zigbee.find((z) => z.owner?.rid === l.owner?.rid);
    return {
      id: l.id,
      name: l.metadata?.name,
      on: l.on?.on,
      brightness: l.dimming?.brightness,
      reachable: link ? link.status === "connected" : undefined,
      ...colorOf(l),
    };
  });
}

/** A light's temperature and colour fields, only those the bridge reported. */
function colorOf(l: Resource): Partial<LightView> {
  const out: Partial<LightView> = {};
  const ct = l.color_temperature;
  if (typeof ct?.mirek === "number") out.kelvin = mirekToKelvin(ct.mirek);
  const { mirek_minimum: min, mirek_maximum: max } = ct?.mirek_schema ?? {};
  if (min !== undefined && max !== undefined)
    out.kelvinRange = [mirekToKelvin(max), mirekToKelvin(min)];
  if (l.color?.xy) {
    out.xy = l.color.xy;
    out.hex = xyToHex(l.color.xy);
  }
  if (l.color?.gamut) out.gamut = l.color.gamut;
  return out;
}

/** A room or zone as a row shows it, with its grouped light's state. */
export type GroupView = {
  id: string;
  type: "room" | "zone";
  name?: string;
  groupedLightId?: string;
  on?: boolean;
  brightness?: number;
  lightIds: string[];
};

/** Rooms and zones. A room's children are devices; a zone's are lights. */
export function groups(s: HueSnapshot): GroupView[] {
  const all = ofType(s, "light");
  return [...ofType(s, "room"), ...ofType(s, "zone")].map((g) => {
    const kids = new Set(g.children?.map((c) => c.rid));
    const grouped = groupedLightOf(s, g);
    return {
      id: g.id,
      type: g.type as "room" | "zone",
      name: g.metadata?.name,
      groupedLightId: grouped?.id,
      on: grouped?.on?.on,
      brightness: grouped?.dimming?.brightness,
      lightIds: all
        .filter((l) => kids.has(l.id) || kids.has(l.owner?.rid ?? ""))
        .map((l) => l.id),
    };
  });
}

/** The grouped light for the whole home: one PUT `{ on: { on: false } }` to it is "Lights off". */
export function homeGroupedLightId(s: HueSnapshot): string | undefined {
  const home = ofType(s, "bridge_home")[0];
  return home && groupedLightOf(s, home)?.id;
}

/** Scenes with their room or zone and whether one is active (`status.active` other than "inactive"). */
export function scenes(s: HueSnapshot) {
  return ofType(s, "scene").map((sc) => {
    const active = (sc.status as { active?: string } | undefined)?.active;
    return {
      id: sc.id,
      name: sc.metadata?.name,
      groupId: sc.group?.rid,
      active: active !== undefined && active !== "inactive",
    };
  });
}
