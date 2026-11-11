import { z } from "zod";
import { colorToXy, kelvinToMirek, type Rgb, type XY } from "./color.ts";
import { Envelope, type Kind, PairResponse, Resource } from "./schemas.ts";
import {
  type GroupView,
  groups,
  type LightView,
  lights,
  scenes,
  snapshotFrom,
  homeGroupedLightId,
} from "./state.ts";
import { HUE_BRIDGE_ROOT_CA } from "./ca.ts";
import { type Clock, realClock } from "../../clock.ts";
import { ConnectorError, fetchTimeout } from "../../connector.ts";
import { writeLane } from "../../lane.ts";

/** What a Hue client needs: the bridge's LAN address, its application key, and a pinned `fetch`. */
export type HueOptions = {
  host: string;
  key: string;
  fetch: typeof fetch;
  clock?: Clock;
};

/** A failed bridge call. `code` is "link_button" when pairing waits on the bridge's button, "invalid" for a change that can't be made (an unknown name, a value off the light's range) and "offline" for a light the bridge has lost, both caught before anything is sent. */
export class HueError extends ConnectorError {
  declare readonly code?: "link_button" | "invalid" | "offline";
}

/**
 * What to change on a light, or on a room or zone: only what is given is sent. `brightness` is 1–100, `color` a hex
 * string or `{ r, g, b }`, `kelvin` a white temperature; `color` and `kelvin` are one or the other. Without `on`, a
 * change turns the light on, since a light that is off takes no brightness or colour. `transitionMs` is the fade (the
 * bridge's own is 400 ms; 0 is at once).
 */
export type LightChange = {
  on?: boolean;
  brightness?: number;
  color?: string | Rgb;
  kelvin?: number;
  transitionMs?: number;
};

/**
 * What a write left: the light or group once the bridge reported the change (`confirmed`), or as it stood when
 * `CONFIRM_MS` ran out. With `{ dryRun: true }` nothing is sent: `wouldSend` is the request the write would make, `state`
 * is how things stand now, and `confirmed` is false. Check `wouldSend` first.
 */
export type HueApplied<V> = {
  state: V;
  confirmed: boolean;
  wouldSend?: HueRequest;
};
/** One CLIP v2 write: `PUT /clip/v2/resource/<path>` with this body. */
export type HueRequest = { method: "PUT"; path: string; body: object };
/** `dryRun`: every check a write makes before sending (the name, the range, a lost light) and nothing sent. For testing a bot with people home. */
export type HueWriteOptions = { dryRun?: boolean };
/** How long `light`, `room` and `scene` wait for the bridge to report what was asked, reading every half second. */
export const CONFIRM_MS = 3000;

/** Minimum gap between writes, per lane: Signify's guidance (Hue System Performance, read 2026-11-11), about 10 a second to lights and 1 a second to groups. */
export const WRITE_GAP_MS = { group: 1000, light: 100 } as const;
type Lane = keyof typeof WRITE_GAP_MS;

/** Which lane a write goes in: `light` writes are fast, everything else (grouped_light, scene) is a group write. */
export const laneFor = (kind: string): Lane =>
  kind === "light" ? "light" : "group";

/** Hue bodies merge field by field, the newer value winning: `{ on }` then `{ dimming }` lands as both. */
export function mergeBody(older: object, newer: object): object {
  const plain = (x: unknown): x is object =>
    typeof x === "object" && x !== null && !Array.isArray(x);
  const out: Record<string, unknown> = { ...older };
  for (const [k, v] of Object.entries(newer))
    out[k] = plain(out[k]) && plain(v) ? mergeBody(out[k], v) : v;
  return out;
}

/** A typed CLIP v2 client. Reads go straight through; writes go through the bridge's write queue. `host` is read at each call, so a getter follows a move. */
export function hueClient(options: HueOptions) {
  const lanes = {
    group: writeLane({ gapMs: WRITE_GAP_MS.group, clock: options.clock }),
    light: writeLane({ gapMs: WRITE_GAP_MS.light, clock: options.clock }),
  };

  async function call(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    const headers: Record<string, string> = {
      "hue-application-key": options.key,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetchTimeout(
      options.fetch,
      `https://${options.host}${path}`,
      {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      { signal },
    );
    const parsed = Envelope.safeParse(await res.json().catch(() => undefined));
    const errors = parsed.success
      ? parsed.data.errors.map((e) => e.description)
      : [];
    if (!res.ok || errors.length)
      throw new HueError(
        errors.join("; ") || `HTTP ${res.status} on ${method} ${path}`,
        { status: res.status },
      );
    return parsed.success ? parsed.data.data : [];
  }

  /** Change one resource, e.g. `put("grouped_light", id, { on: { on: false } })`. Spaced per lane; writes to one resource waiting their turn merge. */
  const put = (kind: Kind, id: string, body: object): Promise<unknown[]> =>
    lanes[laneFor(kind)].send(
      `${kind}/${id}`,
      body,
      (b) => call("PUT", `/clip/v2/resource/${kind}/${id}`, b),
      mergeBody,
    );

  const clock = options.clock ?? realClock;
  const base = {
    put,
    /** Every resource of one kind, or every resource on the bridge when `kind` is left out (one call). */
    async get(kind?: Kind, signal?: AbortSignal): Promise<Resource[]> {
      return z
        .array(Resource)
        .parse(
          await call(
            "GET",
            `/clip/v2/resource${kind ? `/${kind}` : ""}`,
            undefined,
            signal,
          ),
        );
    },
    /** Recall a scene in its room or zone. */
    recallScene(id: string): Promise<unknown[]> {
      return put("scene", id, { recall: { action: "active" } });
    },
  };

  /** Whether two of these labels are the same, so only an id tells them apart. */
  const same = (labels: string[]) => new Set(labels).size < labels.length;
  const invalid = (message: string) =>
    new HueError(message, { code: "invalid" });
  /** One of `items` by id or by name (any case). A miss, or a name two of them share, throws listing what exists. */
  function pick<T extends { id: string; name?: string }>(
    items: T[],
    target: string,
    what: string,
    label: (item: T) => string = (i) => i.name ?? i.id,
  ): T {
    const wanted = target.trim().toLowerCase();
    const found = items.filter(
      (i) => i.id === target || i.name?.toLowerCase() === wanted,
    );
    if (found.length === 1) return found[0]!;
    throw invalid(
      found.length
        ? `"${target}" names ${found.length}: ${same(found.map(label)) ? found.map((i) => `${label(i)} (${i.id})`).join(", ") : found.map(label).join(", ")}`
        : `no ${what} "${target}"; have: ${items.map(label).join(", ") || "none"}`,
    );
  }
  const read = async () => snapshotFrom(await base.get(), "");

  /** The CLIP body for `change`, checked against what the light (or a group's lights) can take. Throws before anything is sent. */
  function bodyFor(
    change: LightChange,
    name: string,
    members: LightView[],
    isOn: boolean | undefined,
  ): Record<string, unknown> {
    const { on, brightness, color, kelvin, transitionMs } = change;
    const look =
      brightness !== undefined || color !== undefined || kelvin !== undefined;
    if (on === undefined && !look) throw invalid("nothing to change");
    if (on === false && look)
      throw invalid("off takes no brightness or colour");
    if (color !== undefined && kelvin !== undefined)
      throw invalid("a colour or a white temperature, not both");
    const body: Record<string, unknown> = {};
    if (on !== undefined) body.on = { on };
    else if (isOn !== true) body.on = { on: true }; // off, or a group where some may be
    if (brightness !== undefined) {
      if (!(brightness >= 1 && brightness <= 100))
        throw invalid(`brightness is 1–100, not ${brightness}`);
      body.dimming = { brightness };
    }
    if (color !== undefined) {
      const gamut = members.find((l) => l.gamut)?.gamut;
      if (!gamut) throw invalid(`${name} has no colour light`);
      try {
        body.color = { xy: colorToXy(color, gamut) };
      } catch (error) {
        throw invalid((error as Error).message); // a bad colour, as every other change that can't be made
      }
    }
    if (kelvin !== undefined) {
      const ranges = members.flatMap((l) =>
        l.kelvinRange ? [l.kelvinRange] : [],
      );
      if (!ranges.length) throw invalid(`${name} takes no white temperature`);
      const low = Math.min(...ranges.map((r) => r[0]));
      const high = Math.max(...ranges.map((r) => r[1]));
      if (!(kelvin >= low && kelvin <= high))
        throw invalid(
          `${kelvin} K is outside ${name}'s range, ${low}–${high} K`,
        );
      body.color_temperature = { mirek: kelvinToMirek(kelvin) };
    }
    if (transitionMs !== undefined) {
      if (!(Number.isInteger(transitionMs) && transitionMs >= 0))
        throw invalid(
          `transitionMs is a whole number of ms, not ${transitionMs}`,
        );
      body.dynamics = { duration: transitionMs };
    }
    return body;
  }

  /** Read every half second until `view()` gives a state that is as `asked`, or `CONFIRM_MS` passes. A failed read is not a failed write. */
  async function confirm<V>(
    view: () => Promise<V | undefined>,
    asked: (v: V) => boolean,
  ): Promise<HueApplied<V>> {
    const until = clock.now() + CONFIRM_MS;
    let state: V | undefined;
    let failed: unknown;
    for (;;) {
      try {
        state = (await view()) ?? state;
        if (state !== undefined && asked(state)) break;
      } catch (error) {
        failed = error;
      }
      if (clock.now() >= until) break;
      await clock.sleep(500);
    }
    if (state === undefined)
      throw failed ?? new HueError("sent, but it is no longer on the bridge");
    return { state, confirmed: asked(state) };
  }
  /**
   * Whether a view shows what the body asked: on, brightness within a point, and on a light the white temperature within
   * 2 mirek or the colour within 0.02 in `xy`. A room reports neither, so its colour is not compared (its `on` is).
   */
  const shows =
    (body: Record<string, unknown>, light: boolean) =>
    (v: Partial<LightView>): boolean => {
      const on = (body.on as { on: boolean } | undefined)?.on;
      const brightness = (body.dimming as { brightness: number } | undefined)
        ?.brightness;
      const mirek = (body.color_temperature as { mirek: number } | undefined)
        ?.mirek;
      const xy = (body.color as { xy: XY } | undefined)?.xy;
      return (
        (on === undefined || v.on === on) &&
        (brightness === undefined ||
          (v.brightness !== undefined &&
            Math.abs(v.brightness - brightness) <= 1)) &&
        (!light ||
          mirek === undefined ||
          (v.kelvin !== undefined &&
            Math.abs(kelvinToMirek(v.kelvin) - mirek) <= 2)) &&
        (!light ||
          xy === undefined ||
          (v.xy !== undefined &&
            Math.abs(v.xy.x - xy.x) <= 0.02 &&
            Math.abs(v.xy.y - xy.y) <= 0.02))
      );
    };

  /** Send, or with `dryRun` say what would be sent and how `now` stands. */
  async function send<V>(
    options: HueWriteOptions | undefined,
    kind: Kind,
    id: string,
    body: object,
    now: V | undefined,
    after: () => Promise<HueApplied<V>>,
  ): Promise<HueApplied<V>> {
    if (options?.dryRun) {
      if (now === undefined)
        throw new HueError("its room or zone is not on the bridge");
      return {
        state: now,
        confirmed: false,
        wouldSend: { method: "PUT", path: `${kind}/${id}`, body },
      };
    }
    await put(kind, id, body);
    return after();
  }
  return {
    ...base,
    /** Change one light, by name or id. Only when a person asks. Resolves with the light as the bridge then reported it. */
    async light(
      target: string,
      change: LightChange,
      options?: HueWriteOptions,
    ): Promise<HueApplied<LightView>> {
      const l = pick(lights(await read()), target, "light");
      // The bridge takes a write to a light it has lost and answers "may not have effect": say so before sending.
      if (l.reachable === false)
        throw new HueError(
          `${l.name ?? l.id} is unreachable: the bridge has lost it (is it switched off at the wall?)`,
          { code: "offline" },
        );
      const body = bodyFor(change, l.name ?? l.id, [l], l.on);
      return send(options, "light", l.id, body, l, () =>
        confirm(
          async () => lights(await read()).find((x) => x.id === l.id),
          shows(body, true),
        ),
      );
    },
    /**
     * Every light in the home off, with one write to the bridge's home group. Only when a person asks. Resolves with
     * every light as the bridge then reported it, `confirmed` once none it can reach is on.
     */
    async allOff(options?: HueWriteOptions): Promise<HueApplied<LightView[]>> {
      const s = await read();
      const id = homeGroupedLightId(s);
      if (!id) throw invalid("the bridge has no home group");
      return send(
        options,
        "grouped_light",
        id,
        { on: { on: false } },
        lights(s),
        () =>
          confirm(
            async () => lights(await read()),
            (all) => all.every((l) => !l.on || l.reachable === false),
          ),
      );
    },
    /**
     * Change every light in a room or zone with one write, by name or id. Only when a person asks. Resolves with the
     * group as the bridge then reported it; its brightness is the bridge's figure for the group, so a group holding a
     * light that is off or unreachable may stay unconfirmed.
     */
    async room(
      target: string,
      change: LightChange,
      options?: HueWriteOptions,
    ): Promise<HueApplied<GroupView>> {
      const s = await read();
      const g = pick(groups(s), target, "room or zone");
      const name = g.name ?? g.id;
      if (!g.groupedLightId) throw invalid(`${name} has no lights`);
      const members = lights(s).filter((l) => g.lightIds.includes(l.id));
      const body = bodyFor(change, name, members, undefined);
      return send(options, "grouped_light", g.groupedLightId, body, g, () =>
        confirm(
          async () => groups(await read()).find((x) => x.id === g.id),
          shows(body, false),
        ),
      );
    },
    /**
     * Recall a scene by name or id. A name several rooms use ("Relax") needs `room`. Only when a person asks. Resolves
     * with the scene's room or zone, `confirmed` once the bridge reports the scene active.
     */
    async scene(
      target: string,
      room?: string,
      options?: HueWriteOptions,
    ): Promise<HueApplied<GroupView>> {
      const s = await read();
      const all = groups(s);
      const within =
        room === undefined ? undefined : pick(all, room, "room or zone");
      const roomName = (id?: string) =>
        all.find((g) => g.id === id)?.name ?? "no room";
      const sc = pick(
        scenes(s).filter((x) => !within || x.groupId === within.id),
        target,
        "scene",
        (x) => `${x.name ?? x.id} in ${roomName(x.groupId)}`,
      );
      let active = false;
      return send(
        options,
        "scene",
        sc.id,
        { recall: { action: "active" } },
        all.find((g) => g.id === sc.groupId),
        () =>
          confirm(
            async () => {
              const now = await read();
              active = scenes(now).find((x) => x.id === sc.id)?.active === true;
              return groups(now).find((x) => x.id === sc.groupId);
            },
            () => active,
          ),
      );
    },
  };
}
export type HueClient = ReturnType<typeof hueClient>;

/** Ask the bridge for an application key. One call: throws `HueError` with code "link_button" until KO presses it. */
export async function pair(options: {
  host: string;
  fetch: typeof fetch;
  deviceType: string;
  signal?: AbortSignal;
}): Promise<{ key: string; clientKey?: string }> {
  const res = await fetchTimeout(
    options.fetch,
    `https://${options.host}/api`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        devicetype: options.deviceType,
        generateclientkey: true,
      }),
    },
    { signal: options.signal },
  );
  const parsed = PairResponse.safeParse(
    await res.json().catch(() => undefined),
  );
  if (!parsed.success)
    throw new HueError(`unexpected answer to POST /api (HTTP ${res.status})`, {
      status: res.status,
    });
  const [first] = parsed.data;
  if (first?.success)
    return { key: first.success.username, clientKey: first.success.clientkey };
  const error = first?.error;
  throw new HueError(error?.description ?? `HTTP ${res.status} on POST /api`, {
    status: res.status,
    code: error?.type === 101 ? "link_button" : undefined,
  });
}

/**
 * `pair`, asked again every `everyMs` (2 s) until someone presses the bridge's button, for `timeoutMs` (30 s, as long as
 * the button stays pressed). `onWaiting` is called once, when the bridge first says the button isn't pressed: the moment
 * to tell the person. Throws the last `link_button` error when time runs out, any other error at once, and the signal's
 * reason when aborted.
 */
export async function pairWhenPressed(options: {
  host: string;
  fetch: typeof fetch;
  deviceType: string;
  timeoutMs?: number;
  everyMs?: number;
  onWaiting?: () => void;
  clock?: Clock;
  signal?: AbortSignal;
}): Promise<{ key: string; clientKey?: string }> {
  const clock = options.clock ?? realClock;
  const until = clock.now() + (options.timeoutMs ?? 30_000);
  let waiting = false;
  while (true) {
    try {
      return await pair(options);
    } catch (error) {
      const pressed = !(
        error instanceof HueError && error.code === "link_button"
      );
      if (pressed || clock.now() >= until) throw error;
      if (!waiting) options.onWaiting?.();
      waiting = true;
    }
    await clock.sleep(options.everyMs ?? 2000, options.signal);
    options.signal?.throwIfAborted();
  }
}

/**
 * A `fetch` that trusts only `ca` (Signify's roots, `HUE_BRIDGE_ROOT_CA`, when left out) and accepts only a certificate whose CN is `bridgeId`.
 * Uses Bun's `tls` fetch option; Node ignores it and then rejects the bridge, so it fails closed there; Node uses `nodePinnedFetch` from `@khalido/home/node`.
 */
export function bunPinnedFetch(
  bridgeId: string,
  ca: string = HUE_BRIDGE_ROOT_CA,
): typeof fetch {
  const checkServerIdentity = (
    _host: string,
    cert: { subject?: { CN?: string } },
  ) =>
    cert.subject?.CN?.toLowerCase() === bridgeId.toLowerCase()
      ? undefined
      : new Error(
          `Hue bridge certificate is for ${cert.subject?.CN ?? "nobody"}, expected ${bridgeId}`,
        );
  const pinned = (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, { ...init, tls: { ca, checkServerIdentity } } as RequestInit);
  return pinned as typeof fetch;
}
