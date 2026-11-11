// `home daikin on|off` and `home daikin cool|heat|auto|dry|fan [°C]`: one write to the AC, then what it reports.
// Live on KO's unit (2026-11-11): on, and dry to cool at 25. Off, heat, auto, fan and a fan speed are untried.
import {
  acText,
  type DaikinApplied,
  daikinClient,
  DEFAULT_TARGET_C,
  type Mode,
  setTarget,
} from "../connectors/daikin/index.ts";
import { findDaikins } from "../finders.ts";
import { env, fail, usage, type Verbs } from "./context.ts";

export const DAIKIN_USAGE = `usage: home daikin on | off | cool [°C] | heat [°C] | auto [°C] | dry | fan  (cool ${DEFAULT_TARGET_C.cool} and heat ${DEFAULT_TARGET_C.heat} when no °C is given)`;

let found: Promise<string | undefined> | undefined;
/** The unit's address: DAIKIN_HOST, else the first to answer the UDP broadcast (asked once a run). Undefined when none does. */
export const daikinHost = (): Promise<string | undefined> =>
  (found ??= env.DAIKIN_HOST
    ? Promise.resolve(env.DAIKIN_HOST)
    : findDaikins().then((units) => units[0]?.ip));

async function unit() {
  const host =
    (await daikinHost()) ??
    fail("no Daikin answered the UDP broadcast; set DAIKIN_HOST", "network");
  return daikinClient({ host, fetch });
}

/** What a write left, in a line: the unit as it then reported, or that it has not reported the change yet. */
const said = ({ state, confirmed }: DaikinApplied) =>
  console.log(
    confirmed
      ? acText(state)
      : `sent; the unit has not reported it yet (${acText(state)})`,
  );

const power =
  (on: boolean) =>
  async ([extra]: string[]) =>
    extra ? usage(DAIKIN_USAGE) : said(await (await unit()).power(on));

const mode =
  (m: Mode) =>
  async ([value, extra]: string[]) => {
    if (extra || (value !== undefined && !/^\d+(\.\d+)?$/.test(value)))
      usage(DAIKIN_USAGE);
    const c = value === undefined ? undefined : Number(value);
    // A setpoint the mode can't take is a usage error, said before looking for the unit.
    if (c !== undefined)
      try {
        setTarget(c, m);
      } catch (e) {
        usage(`${(e as Error).message}; ${DAIKIN_USAGE}`);
      }
    said(await (await unit()).mode(m, c));
  };

export const daikinVerbs: Verbs = {
  on: power(true),
  off: power(false),
  cool: mode("cool"),
  heat: mode("heat"),
  auto: mode("auto"),
  dry: mode("dry"),
  fan: mode("fan"),
};
