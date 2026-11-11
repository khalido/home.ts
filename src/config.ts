import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";
import { z } from "zod";
import { type Clock, isTimeZone, realClock } from "./clock.ts";
import { errorText } from "./connector.ts";
import {
  amber,
  configSchema as amberDevice,
} from "./connectors/amber/index.ts";
import {
  daikin,
  configSchema as daikinDevice,
} from "./connectors/daikin/index.ts";
import {
  cast,
  type CastConnect,
  configSchema as castDevice,
  resolvedFrom,
  type ServeClip,
} from "./connectors/cast/index.ts";
import {
  bunGatewayFetch,
  enphase,
  configSchema as enphaseDevice,
} from "./connectors/enphase/index.ts";
import {
  type AddressCache,
  addressBook,
  type Connector,
  discover,
  type Finder,
  type Found,
  MANY,
  sameId,
} from "./discover.ts";
import { envName, filePath } from "./home.ts";
import {
  bunPinnedFetch,
  hue,
  configSchema as hueDevice,
} from "./connectors/hue/index.ts";
import {
  printers,
  configSchema as printersDevice,
} from "./connectors/printers/index.ts";
import {
  spotify,
  configSchema as spotifyDevice,
} from "./connectors/spotify/index.ts";
import { up, configSchema as upDevice } from "./connectors/up/index.ts";
import { manifestOf } from "./manifests.ts";
import {
  bom,
  google,
  openMeteo,
  weather,
  type WeatherSource,
} from "./connectors/weather/index.ts";

// One home config (JSONC) that the CLI, jaldi and the bot all read. Devices hold only what it takes to reach them and
// where they live; what a device reports about itself comes live. Secrets are env names; files are paths the caller reads.

/** Where a device or marker sits: `id` matches `<g class="room" id="…">` in the plan's SVG. */
export const Room = z.looseObject({
  id: z.string().startsWith("room-"),
  name: z.string(),
  floor: z.string().optional(),
  hueRoom: z
    .string()
    .optional()
    .describe(
      "the Hue room, zone or grouped_light id whose lights this room's marker shows",
    ),
  photos: z
    .array(filePath)
    .optional()
    .describe(
      "photos of the room, as paths relative to the config or from ~/; the library never reads them, a drawing agent or an app does",
    ),
});

/** JSONC (comments and trailing commas) through jsonc-parser, which runs on Node too; a syntax error throws rather than parsing to part of the file. */
export function parseJsonc(text: string): unknown {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length)
    throw new SyntaxError(
      `JSONC: ${printParseErrorCode(errors[0]!.error)} at offset ${errors[0]!.offset}`,
    );
  return value;
}

/** Every device: an id, the room it is in (absent: the whole house), a name if the id is not enough. */
const placed = {
  id: z.string(),
  room: z.string().startsWith("room-").optional(),
  name: z.string().optional(),
};

/** A device is one connector's settings; a new connector adds its `configSchema` here, in one line. */
export const Device = z.discriminatedUnion("connector", [
  hueDevice.extend(placed),
  daikinDevice.extend(placed),
  enphaseDevice.extend(placed),
  amberDevice.extend(placed),
  upDevice.extend(placed),
  castDevice.extend({ id: placed.id, room: placed.room }), // its name is required: the Google Home name
  printersDevice.extend({ id: placed.id, room: placed.room }), // likewise: the printer's own name
  spotifyDevice.extend(placed),
]);
export type Device = z.infer<typeof Device>;

export const WEATHER_SOURCES = ["bom", "open-meteo", "google"] as const;

export const HomeConfig = z.looseObject({
  $schema: z.string().optional(),
  name: z.string().optional(),
  location: z
    .looseObject({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      bomForecast: z
        .string()
        .optional()
        .describe("BOM précis location by name or aac, e.g. Sydney"),
      timezone: z
        .string()
        .refine(isTimeZone, "an IANA time zone, e.g. Australia/Sydney")
        .optional()
        .describe(
          "the home's IANA time zone, where its day starts (Enphase's and Up's today, the weather's day blocks) and the zone weather times show in; the runtime's when left out",
        ),
    })
    .optional(),
  weather: z
    .looseObject({
      sources: z
        .array(z.enum(WEATHER_SOURCES))
        .optional()
        .describe("preference order; default open-meteo"),
      pollMinutes: z.number().min(1).optional(),
      googleKey: envName
        .optional()
        .describe(
          "env name holding a Maps Platform key, when sources has google",
        ),
    })
    .optional(),
  rooms: z.array(Room).optional(),
  devices: z.array(Device).optional(),
  plan: z
    .looseObject({ svg: filePath.optional(), json: filePath.optional() })
    .optional()
    .describe("the drawing, by path relative to this file"),
});
export type HomeConfig = z.infer<typeof HomeConfig>;

/** What a valid config would run: each integration, the device it comes from, its settings, and each secret's env name and whether it is set. */
export type Setup = {
  name: string;
  from: string;
  settings: Record<string, string | number>;
  secrets: Record<string, "set" | "unset">;
};

/** A config that cannot run. `problems` names each field. */
export class HomeConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("; "));
    this.name = "HomeConfigError";
  }
}

/** A field's path in one format for every problem: `devices[3] (prices).key`. */
function fieldPath(path: PropertyKey[], input: unknown): string {
  const devices = (input as { devices?: { id?: unknown }[] } | undefined)
    ?.devices;
  return path
    .map((p, i) => {
      if (typeof p !== "number") return `${i ? "." : ""}${String(p)}`;
      const id =
        path[i - 1] === "devices" && i === 1 ? devices?.[p]?.id : undefined;
      return `[${p}]${typeof id === "string" ? ` (${id})` : ""}`;
    })
    .join("");
}

/** The drawing side of a config: the schema, unique room and device ids, and every device's room present. Problems, not a throw. */
export function checkPlan(input: unknown): {
  config?: HomeConfig;
  problems: string[];
} {
  const parsed = HomeConfig.safeParse(input);
  if (!parsed.success)
    return {
      problems: parsed.error.issues.map(
        (i) => `${fieldPath(i.path, input) || "(root)"}: ${i.message}`,
      ),
    };
  const config = parsed.data;
  const ids = (config.rooms ?? []).map((r) => r.id);
  const rooms = new Set(ids);
  const problems = ids
    .filter((id, i) => ids.indexOf(id) !== i)
    .map((id) => `rooms: ${id} twice`);
  const deviceIds = (config.devices ?? []).map((d) => d.id);
  deviceIds.forEach(
    (id, i) =>
      deviceIds.indexOf(id) !== i &&
      problems.push(`devices[${i}] (${id}).id: a second device with this id`),
  );
  (config.devices ?? []).forEach(
    (d, i) =>
      d.room &&
      !rooms.has(d.room) &&
      problems.push(`devices[${i}] (${d.id}).room: no room ${d.room}`),
  );
  (config.rooms ?? []).forEach(
    (r, i) =>
      "marker" in r &&
      problems.push(
        `rooms[${i}] (${r.id}).marker: renamed hueRoom; marker now means only an SVG marker id`,
      ),
  );
  return { config, problems };
}

/**
 * Validate a parsed config against `env`: `checkPlan`, one device per connector (Cast and printers: any number), and every env name set.
 * Returns the problems rather than throwing, and what would be set up, secrets shown only as set or unset.
 */
export function checkHome(
  input: unknown,
  env: Record<string, string | undefined>,
): { config?: HomeConfig; setup: Setup[]; problems: string[] } {
  const { config, problems } = checkPlan(input);
  if (!config) return { setup: [], problems };
  const secret = (
    field: string,
    name: string,
  ): Record<string, "set" | "unset"> => {
    if (!env[name]) problems.push(`${field}: env ${name} is not set`);
    return { [name]: env[name] ? "set" : "unset" };
  };
  const seen = new Map<string, string>();
  const setup: Setup[] = [];
  (config.devices ?? []).forEach((d, i) => {
    const at = `devices[${i}] (${d.id})`;
    const twin = seen.get(d.connector);
    if (twin && !MANY.has(d.connector))
      problems.push(
        `${at}: a second ${d.connector} device (first: ${twin}); one per connector for now`,
      );
    seen.set(d.connector, d.id);
    if (d.connector === "cast") {
      const twinCast = (config.devices ?? []).findIndex(
        (x) => x.connector === "cast" && sameId(x.castId, d.castId),
      );
      if (twinCast < i)
        problems.push(
          `${at}.castId: the same Cast device as devices[${twinCast}] (${config.devices![twinCast]!.id})`,
        );
    }
    if (d.connector === "printers") {
      const twin = (config.devices ?? []).findIndex(
        (x) => x.connector === "printers" && sameId(x.uuid, d.uuid),
      );
      if (twin < i)
        problems.push(
          `${at}.uuid: the same printer as devices[${twin}] (${config.devices![twin]!.id})`,
        );
    }
    const { connector, id, room, name, ...rest } = d;
    // Only the schema's own fields: a loose entry may carry anything, a pasted secret included.
    const known = Device.options.find(
      (o) => o.shape.connector.value === connector,
    )!.shape;
    const settings = Object.fromEntries(
      Object.entries(rest).filter(
        ([k, v]) =>
          k in known &&
          k !== "key" &&
          (typeof v === "string" || typeof v === "number"),
      ),
    ) as Record<string, string | number>;
    const key = (d as { key?: unknown }).key; // any connector's `key` is an env name (the schema's envName)
    setup.push({
      name: connector,
      from: id,
      settings,
      secrets: typeof key === "string" ? secret(`${at}.key`, key) : {},
    });
  });
  if (config.location) {
    const sources = config.weather?.sources ?? ["open-meteo"];
    const key = config.weather?.googleKey;
    if (sources.includes("google") && !key)
      problems.push(
        "weather.googleKey: needed when weather.sources has google",
      );
    setup.push({
      name: "weather",
      from: "location",
      settings: {
        latitude: config.location.latitude,
        longitude: config.location.longitude,
        sources: sources.join(", "),
        ...(config.location.bomForecast
          ? { bomForecast: config.location.bomForecast }
          : {}),
      },
      secrets:
        sources.includes("google") && key
          ? secret("weather.googleKey", key)
          : {},
    });
  } else if (config.weather) problems.push("weather: needs location");
  return { config, setup, problems };
}

/**
 * How `loadHome` reaches devices. `fetch` reaches Daikin, Amber, Up, printers and the weather; Hue and Enphase use `tls`,
 * Bun's `tls` fetch option by default, `NODE_TLS` from `@khalido/home/node` under Node.
 */
export type LoadOptions = {
  env: Record<string, string | undefined>;
  /** Reads a path from the config (a CA, a token file); the caller resolves it against the config file's folder. */
  readFile?: (path: string) => string;
  /** For Daikin, Amber, Up, printers and the weather; the global `fetch` when left out. */
  fetch?: typeof fetch;
  /** Hue's pinned fetch and Enphase's unverified one: Bun's by default, `NODE_TLS` from `@khalido/home/node` under Node. */
  tls?: {
    hue(bridgeId: string, ca?: string): typeof fetch;
    enphase(): typeof fetch;
  };
  /** BOM's transport: `ftpFetch()` from `@khalido/home/weather/ftp`. Without it a listed `bom` source stops and says why. */
  ftpFetch?: typeof fetch;
  /** Each connector's discovery (the CLI's mDNS and UDP), used only after reads keep failing, to find a device that moved. Cast needs its finder always: it is how Cast finds every address. */
  finders?: Partial<Record<Connector, Finder>>;
  /** Cast's transport: `tlsConnect` from `@khalido/home/cast/tls`. Needed when the config lists a Cast device. */
  castConnect?: CastConnect;
  /** For Cast's `announce` with a clip of bytes: `serveClip` from `@khalido/home/cast/serve`. A URL clip needs none. */
  castServe?: ServeClip;
  /** Time for every integration; tests pass a fake. */
  clock?: Clock;
  /**
   * Addresses kept between runs (`fileCache` from `@khalido/home/finders`, or the caller's own). A cached address newer
   * than the config is tried first; each address that answers is written back when it changed or predates the config. Discovery stays for a miss.
   */
  cache?: AddressCache;
  /** When the config was last edited (ms): a cached address older than this yields to the config's `host`. */
  configAt?: number;
};

/** Any integration `loadHome` builds, typed by its name and state (and Hue's client, Cast's actions), so `createHome(loadHome(…))` is typed. */
export type HomeIntegration =
  | ReturnType<typeof hue>
  | ReturnType<typeof daikin>
  | ReturnType<typeof enphase>
  | ReturnType<typeof amber>
  | ReturnType<typeof up>
  | ReturnType<typeof cast>
  | ReturnType<typeof printers>
  | ReturnType<typeof spotify>
  | ReturnType<typeof weather>;

/** The token in a JSON token file (`home enphase login` writes `{ token, expiresAt }`); a file that is not JSON says so by name. */
function tokenFromJson(text: string, at: string): string | undefined {
  try {
    return (JSON.parse(text) as { token?: string }).token;
  } catch (error) {
    throw new HomeConfigError([`${at}: not JSON (${errorText(error)})`]);
  }
}

/** Build the integrations a config describes, in its device order, weather last. Throws `HomeConfigError` naming every problem. */
export function loadHome(
  input: unknown,
  options: LoadOptions,
): HomeIntegration[] {
  const { config, problems } = checkHome(input, options.env);
  if (config && !options.readFile)
    (config.devices ?? []).forEach((d, i) => {
      for (const f of manifestOf(d.connector)?.files ?? []) {
        const path = (d as Record<string, unknown>)[f];
        if (typeof path === "string")
          problems.push(
            `devices[${i}] (${d.id}).${f}: needs readFile to read ${path}`,
          );
      }
    });
  const castAt = (config?.devices ?? []).findIndex(
    (d) => d.connector === "cast",
  );
  const notBun = typeof (globalThis as { Bun?: unknown }).Bun === "undefined"; // Bun's fetch takes a `tls` option; elsewhere it is ignored and the read fails
  for (const [i, d] of (config?.devices ?? []).entries())
    if (
      (d.connector === "hue" || d.connector === "enphase") &&
      !options.tls &&
      notBun
    )
      problems.push(
        `devices[${i}] (${d.id}): ${d.connector} needs tls (NODE_TLS from @khalido/home/node) outside Bun`,
      );
  if (castAt >= 0 && !options.castConnect)
    problems.push(
      `devices[${castAt}] (${config!.devices![castAt]!.id}): Cast needs castConnect (tlsConnect from @khalido/home/cast/tls)`,
    );
  if (castAt >= 0 && !options.finders?.cast)
    problems.push(
      `devices[${castAt}] (${config!.devices![castAt]!.id}): Cast needs finders.cast (its mDNS discovery)`,
    );
  if (!config || problems.length) throw new HomeConfigError(problems);
  const file = (path: string) => options.readFile!(path);
  const env = (name: string) => options.env[name]!;
  const net = options.fetch ?? fetch;
  const clock = options.clock ?? realClock;
  const tls = options.tls ?? { hue: bunPinnedFetch, enphase: bunGatewayFetch };
  const book = addressBook(options.cache, { configAt: options.configAt });
  /** Where a polling connector starts: a fresh cached address, else the config's, and its write-back for each good read. */
  const start = (
    connector: Connector,
    id: string | undefined,
    configured: string,
  ) => {
    const cached = book.fresh(connector, id);
    return {
      host: cached?.host ?? configured,
      hostCached: cached !== undefined,
      seen: (at: string) => book.seen(connector, id, { host: at }),
    };
  };
  // Every Cast entry is one integration, at the first Cast entry's place; so is every printer.
  const printersAt = (config.devices ?? []).findIndex(
    (d) => d.connector === "printers",
  );
  const integrations: HomeIntegration[] = (config.devices ?? []).flatMap(
    (d, i) =>
      d.connector === "cast"
        ? i === castAt
          ? [castAll()]
          : []
        : d.connector === "printers"
          ? i === printersAt
            ? [printersAll()]
            : []
          : [one(d, `devices[${i}] (${d.id})`)],
  );
  function one(
    d: Exclude<Device, { connector: "cast" | "printers" }>,
    at: string,
  ): HomeIntegration {
    switch (d.connector) {
      case "hue": {
        const ca = d.ca === undefined ? undefined : file(d.ca);
        return hue({
          ...start("hue", d.bridgeId, d.host),
          bridgeId: d.bridgeId,
          key: env(d.key),
          ca,
          fetch: tls.hue(d.bridgeId, ca),
          find: options.finders?.hue,
          clock,
        });
      }
      case "daikin":
        return daikin({
          ...start("daikin", d.mac, d.host),
          mac: d.mac,
          find: options.finders?.daikin,
          fetch: net,
          clock,
        });
      case "enphase": {
        const text = file(d.token).trim();
        const token = text.startsWith("{")
          ? tokenFromJson(text, `${at}.token`)
          : text;
        if (!token)
          throw new HomeConfigError([`${at}.token: no token in ${d.token}`]);
        return enphase({
          ...start("enphase", d.serial, d.host),
          token,
          serial: d.serial,
          find: options.finders?.enphase,
          fetch: tls.enphase(),
          timeZone: config!.location?.timezone,
          clock,
        });
      }
      case "amber":
        return amber({ key: env(d.key), siteId: d.siteId, fetch: net, clock });
      case "up":
        return up({
          token: env(d.key),
          account: d.account,
          household: d.household,
          fetch: net,
          timeZone: config!.location?.timezone,
          clock,
        });
      case "spotify":
        return spotify({
          url: d.url,
          maxVolume: d.maxVolume,
          repairStalls: d.repairStalls,
          clock,
        });
    }
  }
  function castAll(): ReturnType<typeof cast> {
    const expect = config!.devices!.flatMap((x) => {
      if (x.connector !== "cast") return [];
      const c = book.fresh("cast", x.castId);
      return [
        {
          castId: x.castId,
          name: x.name,
          ...(c?.port === undefined
            ? {}
            : { host: c.host, port: c.port, model: c.model }),
        },
      ];
    });
    // Two passes, as every discovery runs, but done once every entry in the config has answered.
    const all = (found: Found[]) =>
      expect.every((e) => found.some((f) => sameId(f.id, e.castId)));
    const resolve = async () =>
      resolvedFrom(
        await discover(options.finders!.cast!, { clock, done: all }),
      );
    return cast({
      resolve,
      connect: options.castConnect!,
      expect,
      serve: options.castServe,
      clock,
      seen: (id, a) => book.seen("cast", id, a),
    });
  }
  function printersAll(): ReturnType<typeof printers> {
    const entries = config!.devices!.flatMap((x) => {
      if (x.connector !== "printers") return [];
      const c = book.fresh("printers", x.uuid);
      return [
        {
          uuid: x.uuid,
          name: x.name,
          host: c?.host ?? x.host,
          port: c?.port ?? x.port,
          room: x.room,
          offlineDays: x.offlineDays,
        },
      ];
    });
    return printers({
      printers: entries,
      fetch: net,
      find: options.finders?.printers,
      clock,
      seen: (uuid, a) => book.seen("printers", uuid, a),
    });
  }
  if (config.location) {
    const { latitude, longitude, bomForecast } = config.location;
    const make: Record<(typeof WEATHER_SOURCES)[number], () => WeatherSource> =
      {
        bom: () =>
          bom({ fetch: options.ftpFetch, forecastLocation: bomForecast }),
        "open-meteo": () => openMeteo({ fetch: net }),
        google: () =>
          google({ key: env(config.weather!.googleKey!), fetch: net }),
      };
    const sources = config.weather?.sources?.map((s) => make[s]());
    integrations.push(
      weather({
        latitude,
        longitude,
        sources,
        pollMinutes: config.weather?.pollMinutes,
        timeZone: config.location.timezone,
        clock,
      }),
    );
  }
  return integrations;
}
