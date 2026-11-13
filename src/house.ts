import type { DaikinSnapshot } from "./connectors/daikin/index.ts";
import { printerAttention } from "./connectors/printers/state.ts";
import type { WeatherState } from "./connectors/weather/index.ts";
import type { HomeConfig } from "./config.ts";
import { homeDevices } from "./devices.ts";
import { energyNow, gridText } from "./energy.ts";
import { health } from "./health.ts";
import type { Part } from "./home.ts";
import { kw } from "./manifest.ts";

// The house across connectors, in words a person or a bot reads: whether to open the windows, and the house in one
// paragraph. Both read a snapshot and never write.

/**
 * Whether opening the windows helps, and why in a few words ("cooler outside", "rain in 20 min"); the temperatures are
 * the fields beside it. `unknown` when the inside or outside temperature isn't read.
 */
export type Ventilation = {
  advice: "open" | "close" | "either" | "unknown";
  why: string;
  insideC?: number;
  outsideC?: number;
  insideHumidity?: number;
  outsideHumidity?: number;
};

/**
 * The rules, opinionated and stated: comfortable is 20–24 °C inside; outside has to be 2 °C better to be worth the
 * window, and 2 °C past the comfortable band closes them; rain within 30 minutes closes them, as does the AC running in
 * any mode but fan. Humidity of 85% or more outside is said, not weighed.
 */
export const VENTILATION = {
  comfortC: { low: 20, high: 24 },
  betterByC: 2,
  rainWithinMin: 30,
  humidOutside: 85,
} as const;

const connected = <S>(part: Part | undefined): S | undefined =>
  part?.status === "connected" ? (part.state as S | undefined) : undefined;

/**
 * Open or close the windows, from the Daikin's room reading inside and the weather's current reading and rain outside.
 * The Daikin's outdoor unit temperature is not used: it sits in the sun and by the compressor.
 */
export function ventilation(
  snapshot: Record<string, Part | undefined>,
): Ventilation {
  const ac = connected<DaikinSnapshot>(snapshot.daikin);
  const w = connected<WeatherState>(snapshot.weather);
  const insideC = ac?.roomC;
  const outsideC = w?.now?.tempC;
  const readings = {
    ...(insideC === undefined ? {} : { insideC }),
    ...(outsideC === undefined ? {} : { outsideC }),
    ...(ac?.humidity === undefined ? {} : { insideHumidity: ac.humidity }),
    ...(w?.now?.humidity === undefined
      ? {}
      : { outsideHumidity: w.now.humidity }),
  };
  const say = (advice: Ventilation["advice"], why: string): Ventilation => ({
    advice,
    why,
    ...readings,
  });
  const rain = w?.rainSoon;
  if (rain?.wet && rain.startsInMin !== undefined)
    if (rain.startsInMin === 0) return say("close", "it is raining");
    else if (rain.startsInMin <= VENTILATION.rainWithinMin)
      return say("close", `rain in ${rain.startsInMin} min`);
  if (ac?.on && ac.mode !== "fan")
    return say(
      "close",
      ac.mode === "cool"
        ? "the AC is cooling"
        : ac.mode === "heat"
          ? "the AC is heating"
          : `the AC is on (${ac.mode ?? "mode unknown"})`,
    );
  if (insideC === undefined || outsideC === undefined)
    return say(
      "unknown",
      `no ${insideC === undefined ? "inside" : "outside"} temperature`,
    );
  const { low, high } = VENTILATION.comfortC;
  const by = VENTILATION.betterByC;
  const humid =
    readings.outsideHumidity !== undefined &&
    readings.outsideHumidity >= VENTILATION.humidOutside
      ? `, humid out (${readings.outsideHumidity}%)`
      : "";
  if (insideC > high) {
    if (outsideC <= insideC - by) return say("open", `cooler outside${humid}`);
    if (outsideC >= insideC + by) return say("close", "hotter outside");
    return say("either", "warm inside and out");
  }
  if (insideC < low) {
    if (outsideC >= insideC + by) return say("open", `warmer outside${humid}`);
    if (outsideC <= insideC - by) return say("close", "colder outside");
    return say("either", "cool inside and out");
  }
  // Comfortable inside: keep it so when outside is well past the band either way.
  if (outsideC >= high + by) return say("close", "hot outside");
  if (outsideC <= low - by) return say("close", "cold outside");
  return say("either", "comfortable inside and out");
}

/** Up to three names, then how many more: "Kitchen, Study, Hall and 2 more". */
const names = (list: string[]) =>
  list.length <= 3
    ? list.join(", ")
    : `${list.slice(0, 3).join(", ")} and ${list.length - 3} more`;

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The house in one paragraph, for a person or a bot: the lights on, the AC, what is playing, a printer that needs
 * attention, solar and the grid, the weather, the windows, and what is down (by `health`, at `now`, default the current
 * time) or needs a new key. Each part is left out when there is nothing to say or nothing was read. Pass the home
 * `config` for its device names.
 */
export function houseSummary(
  snapshot: Record<string, Part | undefined>,
  config?: Pick<HomeConfig, "devices" | "rooms">,
  options: { now?: number } = {},
): string {
  const devices = homeDevices(snapshot, config).filter(
    (d) => d.available !== false,
  );
  const parts: string[] = [];

  // Lights on, counted by Hue room ("Kitchen 4"), since bulbs' own names rarely say where they are; one in no room by name.
  const lights = devices.filter(
    (d) => d.connector === "hue" && d.kind === "light",
  );
  const lit = new Set(lights.filter((d) => d.state === "on").map((d) => d.id));
  if (lights.length && !lit.size) parts.push(`all ${lights.length} lights off`);
  if (lit.size) {
    const placed = new Set<string>();
    const rooms: string[] = [];
    for (const d of devices)
      if (
        d.connector === "hue" &&
        d.kind === "group" &&
        d.detail.type === "room"
      ) {
        const on = d.detail.lightIds.filter((id) => lit.has(id));
        for (const id of on) placed.add(id);
        if (on.length) rooms.push(`${d.name} ${on.length}`);
      }
    const loose = lights
      .filter((d) => lit.has(d.id) && !placed.has(d.id))
      .map((d) => d.name);
    parts.push(
      `${lit.size} light${lit.size === 1 ? "" : "s"} on: ${names([...rooms, ...loose])}`,
    );
  }

  for (const d of devices) if (d.connector === "daikin") parts.push(d.text);

  // What is playing: the speaker's own line, and each Cast device or group playing, a group's members left out.
  for (const d of devices)
    if (
      (d.connector === "spotify" &&
        (d.state === "playing" || d.state === "buffering")) ||
      (d.connector === "cast" &&
        d.state === "busy" &&
        !d.detail.via &&
        (d.detail.playerState === "PLAYING" ||
          d.detail.playerState === "BUFFERING"))
    )
      parts.push(d.text);

  for (const d of devices)
    if (
      d.connector === "printers" &&
      (d.state === "stopped" || printerAttention(d.detail).length)
    )
      parts.push(d.text);

  const now = energyNow(connected(snapshot.enphase), connected(snapshot.amber));
  const energy = [
    now.solarW === undefined ? "" : `solar ${kw(now.solarW)}`,
    now.usingW === undefined ? "" : `using ${kw(now.usingW)}`,
    gridText(now),
    now.negativePrice ?? "",
  ].filter(Boolean);
  if (energy.length) parts.push(energy.join(", "));

  // Outside: the temperature and rain soon. The windows' reason is left off when this already says it.
  const w = connected<WeatherState>(snapshot.weather);
  const rain = w?.rainSoon;
  const wet = !rain?.wet
    ? ""
    : rain.startsInMin === 0
      ? "raining"
      : rain.startsInMin !== undefined
        ? `rain in ${rain.startsInMin} min`
        : "";
  const outside = [
    w?.now?.tempC === undefined ? "" : `${w.now.tempC} °C outside`,
    wet,
  ]
    .filter(Boolean)
    .join(", ");
  if (outside) parts.push(outside);

  const v = ventilation(snapshot);
  if (v.advice !== "unknown") {
    const said = v.why === "it is raining" ? "raining" : v.why;
    const why = said === wet ? "" : ` (${v.why})`;
    parts.push(
      v.advice === "either"
        ? `windows either way${why}`
        : `windows better ${v.advice === "open" ? "open" : "closed"}${why}`,
    );
  }

  // Down by `health`'s rules (a reconnect of a few seconds isn't); a rejected key is said apart, since a person must act.
  const h = health(snapshot, options.now ?? Date.now());
  const rekey = Object.entries(h)
    .filter(([, x]) => x.reason === "auth")
    .map(([name]) => name);
  const down = Object.entries(h)
    .filter(([name, x]) => x.level === "down" && !rekey.includes(name))
    .map(([name]) => name);
  if (down.length) parts.push(`not answering: ${down.join(", ")}`);
  if (rekey.length) parts.push(`needs a new key: ${rekey.join(", ")}`);

  return parts.length
    ? `${parts.map(sentence).join(". ")}.`
    : "Nothing read yet.";
}
