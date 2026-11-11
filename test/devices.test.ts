import { describe, expect, test } from "bun:test";
import {
  byRoom,
  DEVICES,
  type HomeDevice,
  homeDevices,
  SERVICES,
  spotifyElsewhere,
} from "../src/devices.ts";
import type { Part } from "../src/index.ts";
import { MANIFESTS } from "../src/manifests.ts";
import {
  type CastDevice,
  castHomeDevices,
  type CastSnapshot,
} from "../src/connectors/cast/index.ts";
import {
  daikinHomeDevices,
  type DaikinSnapshot,
} from "../src/connectors/daikin/index.ts";
import type { EnphaseSnapshot } from "../src/connectors/enphase/index.ts";
import { Resource } from "../src/connectors/hue/schemas.ts";
import { snapshotFrom } from "../src/connectors/hue/state.ts";
import type { PrintersState } from "../src/connectors/printers/index.ts";
import {
  spotifyHomeDevices,
  type SpotifyState,
} from "../src/connectors/spotify/index.ts";

const AT = "2026-11-10T02:00:00.000Z";
const ok = <S>(state: S): Part<S> => ({ status: "connected", state });

const hue = snapshotFrom(
  Resource.array().parse(
    (
      await Bun.file(
        new URL("./fixtures/resources.json", import.meta.url),
      ).json()
    ).data,
  ),
  AT,
);
const castDevice = (
  id: string,
  name: string,
  extra: Partial<CastDevice> = {},
): CastDevice => ({
  id,
  name,
  kind: "device",
  status: "connected",
  idle: true,
  volume: 0.4,
  asOf: AT,
  ...extra,
});
const cast: CastSnapshot = {
  devices: {
    aa: castDevice("aa", "Kitchen display", { form: "display" }),
    bb: castDevice("bb", "Front room speaker", {
      form: "speaker",
      idle: false,
      app: "Spotify",
      appId: "CC32E753",
      playerState: "PLAYING",
      title: "Song",
    }),
    gg: castDevice("gg", "Everywhere", {
      kind: "group",
      members: ["aa", "bb"],
    }),
  },
  asOf: AT,
};
const daikin: DaikinSnapshot = {
  on: true,
  mode: "cool",
  targetC: 23,
  roomC: 25,
  asOf: AT,
};
const enphase: EnphaseSnapshot = {
  productionW: 2400,
  consumptionW: 900,
  source: "meter",
  tokenDaysLeft: 200,
  asOf: AT,
};
const printers: PrintersState = {
  printers: {
    p1: {
      uuid: "p1",
      name: "Brother",
      state: "idle",
      room: "room-hall",
      ipps: false,
      asOf: AT,
    },
    p2: {
      uuid: "p2",
      name: "Old inkjet",
      state: "offline",
      ipps: false,
      asOf: AT,
    },
  },
  asOf: AT,
};
const spotify: SpotifyState = {
  loggedIn: true,
  deviceName: "Chota",
  active: true,
  status: "paused",
  volume: 60,
  asOf: AT,
};

const snapshot = {
  hue: ok(hue),
  daikin: ok(daikin),
  enphase: ok(enphase),
  amber: ok({}),
  cast: ok(cast),
  printers: ok(printers),
  spotify: ok(spotify),
};
const common = (d: HomeDevice) =>
  [
    d.connector,
    d.kind,
    d.id,
    d.name,
    d.available,
    d.state,
    d.room,
    d.members?.join("+"),
  ]
    .map((v) => v ?? "-")
    .join(" | ");

describe("homeDevices", () => {
  test("every device in the home answers the same few questions", () => {
    expect(homeDevices(snapshot).map(common)).toEqual([
      "hue | light | light-1 | Floor lamp | true | on | - | -",
      "hue | light | light-2 | Shelf | false | off | - | -",
      "hue | group | room-living | Living | - | on | - | light-1+light-2",
      "hue | group | zone-reading | Reading | - | - | - | light-2",
      "daikin | ac | daikin | Daikin | true | cool | - | -",
      "enphase | solar | enphase | Enphase IQ Gateway | true | producing | - | -",
      "cast | speaker | bb | Front room speaker | true | busy | - | -",
      "cast | display | aa | Kitchen display | true | idle | - | -",
      "cast | group | gg | Everywhere | true | busy | - | aa+bb",
      "printers | printer | p1 | Brother | true | idle | room-hall | -",
      "printers | printer | p2 | Old inkjet | false | offline | - | -",
      "spotify | speaker | spotify | Chota | true | paused | - | -",
    ]);
  });

  test("text is one line for people, from each connector's own words", () => {
    expect(homeDevices(snapshot).map((d) => d.text)).toEqual([
      "Floor lamp: on · 60%",
      "Shelf: off",
      "Living: on · 60%",
      "Reading",
      "Daikin: on · cool 23 °C · room 25 °C",
      "Enphase IQ Gateway: solar 2.4 kW, using 0.9 kW · token 200 days left",
      'Front room speaker: Spotify · playing "Song" · 40%',
      "Kitchen display: idle · 40%",
      "Everywhere: idle · 40% · 2 members: Kitchen display, Front room speaker",
      "Brother: idle",
      "Old inkjet: offline, never seen",
      "Chota: paused · 60%",
    ]);
  });

  // The drill-down KO was shown: `connector` (and `kind`) narrow `detail` to the connector's own typed row. It compiles, or the design is wrong.
  test("detail is the connector's own typed row, narrowed by connector and kind", () => {
    const seen: string[] = [];
    for (const d of homeDevices(snapshot)) {
      if (d.connector === "cast") seen.push(`cast volume ${d.detail.volume}`);
      if (d.connector === "hue" && d.kind === "light")
        seen.push(`light brightness ${d.detail.brightness}`);
      if (d.connector === "hue" && d.kind === "group")
        seen.push(`group lights ${d.detail.lightIds.length}`);
      if (d.connector === "daikin") seen.push(`ac target ${d.detail.targetC}`);
      if (d.connector === "enphase")
        seen.push(`solar ${d.detail.productionW} W`);
      if (d.connector === "printers") seen.push(`printer tls ${d.detail.ipps}`);
      if (d.connector === "spotify")
        seen.push(`speaker volume ${d.detail.volume}`);
      // @ts-expect-error a printer has no volume: the compiler knows which row this is
      if (d.connector === "printers") void d.detail.volume;
    }
    expect(seen).toEqual([
      "light brightness 60",
      "light brightness 20",
      "group lights 2",
      "group lights 1",
      "ac target 23",
      "solar 2400 W",
      "cast volume 0.4",
      "cast volume 0.4",
      "cast volume 0.4",
      "printer tls false",
      "printer tls false",
      "speaker volume 60",
    ]);
  });

  test("a connector that is not connected has no device available; its last values stay", () => {
    const down = <S>(state: S): Part<S> => ({ status: "disconnected", state });
    const all = homeDevices({
      hue: down(hue),
      daikin: { status: "unavailable", state: daikin },
      enphase: down(enphase),
      cast: down(cast),
      printers: down(printers),
      spotify: down(spotify),
    });
    expect(
      all.map((d) => `${d.name} ${d.available} ${d.state ?? "-"}`),
    ).toEqual([
      "Floor lamp false on",
      "Shelf false off",
      "Living false on",
      "Reading false -",
      "Daikin false cool",
      "Enphase IQ Gateway false producing",
      "Front room speaker false busy",
      "Kitchen display false idle",
      "Everywhere false busy",
      "Brother false idle",
      "Old inkjet false offline",
      "Chota false offline", // the speaker's word for it is the part's status
    ]);
    // The same from one connector's own function: the rule has one owner.
    expect(daikinHomeDevices(down(daikin))[0]?.available).toBe(false);
    expect(spotifyHomeDevices(down(spotify))[0]?.available).toBe(false);
  });

  test("a device that isn't available says why in one word, and every reading has its time", () => {
    const why = (snap: Record<string, Part>) =>
      Object.fromEntries(
        homeDevices(snap).map((d) => [d.name, d.reason ?? "-"]),
      );
    expect(why(snapshot)).toMatchObject({
      "Floor lamp": "-",
      Shelf: "offline", // the bridge is up, this light's Zigbee link is not
      "Old inkjet": "offline",
      Brother: "-",
    });
    expect(
      why({
        hue: { status: "unavailable", reason: "auth", state: hue },
        daikin: { status: "disconnected", state: daikin },
        enphase: { status: "unavailable", reason: "config", state: enphase },
      }),
    ).toEqual({
      "Floor lamp": "auth",
      Shelf: "auth",
      Living: "auth",
      Reading: "auth",
      Daikin: "offline",
      "Enphase IQ Gateway": "config",
    });
    const times = homeDevices({
      ...snapshot,
      printers: ok({
        ...printers,
        printers: {
          ...printers.printers,
          p2: {
            ...printers.printers.p2!,
            lastSeen: "2026-11-09T20:00:00.000Z",
          },
        },
      }),
    }).map((d) => d.asOf);
    expect(new Set(times)).toEqual(new Set([AT, "2026-11-09T20:00:00.000Z"])); // an offline printer's is when it last answered
    expect(
      "asOf" in homeDevices(snapshot).find((d) => d.name === "Old inkjet")!,
    ).toBe(false); // never seen: no time to give
  });

  test("Cast: connecting, or connected and not heard from yet, is not known; disconnected is not available", () => {
    const one = (extra: Partial<CastDevice>) =>
      castHomeDevices(
        ok({ devices: { aa: castDevice("aa", "A", extra) }, asOf: AT }),
      )[0]!;
    expect("available" in one({ status: "connecting" })).toBe(false);
    expect("available" in one({ idle: undefined })).toBe(false);
    expect(one({ status: "disconnected" }).available).toBe(false);
    expect(one({}).available).toBe(true);
    expect(one({}).asOf).toBe(AT);
    expect("asOf" in one({ asOf: undefined })).toBe(false); // never answered: no time, as a never-seen printer has none
  });

  test("nothing for a connector with no state yet, a service, or a name the library doesn't know", () => {
    expect(
      homeDevices({
        hue: { status: "connecting" },
        amber: ok({}),
        spotify: ok({}),
        mystery: ok({}),
      }),
    ).toEqual([]);
  });

  test("the home config names and places them", () => {
    const placed = homeDevices(snapshot, {
      rooms: [
        { id: "room-living", name: "Living", hueRoom: "gl-living" },
        { id: "room-study", name: "Study", hueRoom: "zone-reading" },
      ],
      devices: [
        {
          connector: "daikin",
          id: "ac",
          name: "Lounge AC",
          room: "room-living",
          host: "192.0.2.20",
          mac: "00:11:22:33:44:55",
        },
        {
          connector: "cast",
          id: "kitchen-display",
          name: "Kitchen display",
          room: "room-kitchen",
          castId: "AA",
        },
        {
          connector: "spotify",
          id: "music",
          name: "Kitchen speaker",
          room: "room-kitchen",
        },
      ],
    });
    const by = (id: string) => placed.find((d) => d.id === id)!;
    expect(by("daikin")).toMatchObject({
      name: "Lounge AC",
      room: "room-living",
      text: "Lounge AC: on · cool 23 °C · room 25 °C",
    });
    expect(by("spotify")).toMatchObject({
      name: "Chota",
      room: "room-kitchen",
    }); // its own name is never replaced
    expect(by("aa").room).toBe("room-kitchen"); // matched by castId, any case
    expect(by("bb").room).toBeUndefined();
    expect(by("room-living").room).toBe("room-living"); // by its grouped light
    expect(by("light-1").room).toBe("room-living");
    expect(by("zone-reading").room).toBe("room-study");
    expect(by("light-2").room).toBe("room-living"); // in the room and the zone: the room's
    expect(by("p1").room).toBe("room-hall"); // the printer's own, from its factory
  });

  test("every connector is a device connector or a service: a new one must choose", () => {
    expect([...Object.keys(DEVICES), ...SERVICES].sort()).toEqual(
      MANIFESTS.map((m) => m.name).sort(),
    );
  });
});

describe("spotifyElsewhere", () => {
  const away: SpotifyState = {
    ...spotify,
    active: false,
    status: "playing",
    track: { uri: "spotify:track:x", name: "Song", artists: [] },
  };
  test("names the Cast device playing that track in Spotify", () => {
    const there = { ...snapshot, spotify: ok(away) };
    expect(spotifyElsewhere(there)).toEqual(["Front room speaker"]);
    expect(
      homeDevices(there).find((d) => d.connector === "spotify"),
    ).toMatchObject({
      state: "elsewhere",
      text: 'Chota: silent · "Song" is playing on Front room speaker',
    });
  });
  test("a group playing it is named, not its members", () => {
    const playing = { app: "Spotify", playerState: "PLAYING", title: "Song" };
    const grouped: CastSnapshot = {
      ...cast,
      devices: {
        aa: { ...cast.devices.aa!, ...playing, playingVia: "gg" },
        bb: { ...cast.devices.bb!, playingVia: "gg" },
        gg: { ...cast.devices.gg!, ...playing },
      },
    };
    expect(spotifyElsewhere({ cast: ok(grouped), spotify: ok(away) })).toEqual([
      "Everywhere",
    ]);
  });
  test("empty when it plays here, on another track, or with no Cast part", () => {
    expect(spotifyElsewhere(snapshot)).toEqual([]);
    expect(
      spotifyElsewhere({ ...snapshot, spotify: ok({ ...away, active: true }) }),
    ).toEqual([]);
    expect(
      spotifyElsewhere({
        ...snapshot,
        spotify: ok({ ...away, track: { ...away.track!, name: "Other" } }),
      }),
    ).toEqual([]);
    expect(spotifyElsewhere({ spotify: ok(away) })).toEqual([]);
  });
});

describe("byRoom", () => {
  const config = {
    rooms: [
      {
        id: "room-living",
        name: "Living",
        floor: "ground",
        hueRoom: "gl-living",
      },
      { id: "room-kitchen", name: "Kitchen" },
      { id: "room-shed", name: "Shed" },
    ],
    devices: [
      {
        connector: "daikin" as const,
        id: "ac",
        name: "Lounge AC",
        room: "room-living",
        host: "192.0.2.20",
        mac: "00:11:22:33:44:55",
      },
      {
        connector: "spotify" as const,
        id: "music",
        name: "Kitchen speaker",
        room: "room-kitchen",
      },
    ],
  };
  test("each room of the config with its devices, in the config's order; the rest unplaced", () => {
    const { rooms, unplaced } = byRoom(snapshot, config);
    expect(rooms.map((r) => [r.id, r.name, r.floor, r.noData])).toEqual([
      ["room-living", "Living", "ground", []],
      ["room-kitchen", "Kitchen", undefined, []],
      ["room-shed", "Shed", undefined, []],
    ]);
    expect(rooms[0]!.devices.map((d) => d.connector)).toContain("daikin");
    expect(rooms[0]!.devices.some((d) => d.connector === "hue")).toBe(true);
    expect(rooms[1]!.devices.map((d) => d.id)).toEqual(["spotify"]);
    expect(rooms[2]!.devices).toEqual([]);
    // The printer places itself in a room this config doesn't have.
    expect(unplaced.map((d) => d.id)).toContain("p1");
    expect(unplaced.some((d) => d.room === "room-living")).toBe(false);
  });
  test("a connector the config places in a room that has nothing to list is noData; one that is down but read before still lists", () => {
    const { rooms } = byRoom(
      {
        ...snapshot,
        hue: { status: "connecting" },
        daikin: { status: "disconnected", state: daikin },
        spotify: undefined,
      },
      config,
    );
    expect(rooms[0]!.noData).toEqual(["hue"]);
    expect(rooms[0]!.devices).toMatchObject([
      { connector: "daikin", available: false },
    ]);
    expect(rooms[1]!.noData).toEqual(["spotify"]);
  });
});
