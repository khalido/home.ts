// `home daikin on|off`: one write to the AC, then what it reports. Power only: mode, setpoint and fan writes are untried on a unit.
import { acText, daikinClient, setPower } from "../connectors/daikin/index.ts";
import { findDaikins } from "../finders.ts";
import { env, fail, usage, type Verbs } from "./context.ts";

export const DAIKIN_USAGE = "usage: home daikin on | off";

/** The unit at DAIKIN_HOST, else the first to answer the UDP broadcast. */
async function unit() {
  const host =
    env.DAIKIN_HOST ??
    (await findDaikins())[0]?.ip ??
    fail("no Daikin answered the UDP broadcast; set DAIKIN_HOST", "network");
  return daikinClient({ host, fetch });
}

/** Send the power write, then read until the unit reports it (at most 3 s) and print its line. */
async function power(on: boolean): Promise<void> {
  const c = await unit();
  await c.write(setPower(on));
  let state = await c.read();
  for (let i = 0; state.on !== on && i < 3; i++) {
    await Bun.sleep(1000);
    state = await c.read();
  }
  console.log(
    state.on === on
      ? acText(state)
      : `sent; the unit has not reported it yet (${acText(state)})`,
  );
}

export const daikinVerbs: Verbs = {
  on: ([extra]) => (extra ? usage(DAIKIN_USAGE) : power(true)),
  off: ([extra]) => (extra ? usage(DAIKIN_USAGE) : power(false)),
};
