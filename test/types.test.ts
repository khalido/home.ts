import { expect, test } from "bun:test";
import {
  createHome,
  type HomeIntegration,
  type HomeSnapshot,
  type Part,
  type StateOf,
} from "../src/index.ts";
import type { WeatherState } from "../src/connectors/weather/index.ts";
import type { AmberSnapshot } from "../src/connectors/amber/index.ts";
import { amber } from "../src/connectors/amber/index.ts";
import { weather } from "../src/connectors/weather/index.ts";

// Compile-time checks: `bun run check` fails if the snapshot loses its types. The runtime part only proves the file ran.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
const is = <T extends true>() => true as T;

test("a hand-wired home's snapshot is typed by each integration's name", () => {
  const home = createHome([
    weather({ latitude: -33.8688, longitude: 151.2093 }),
    amber({ key: "k", fetch }),
  ]);
  is<
    Equal<
      NonNullable<ReturnType<typeof home.part<"weather">>>["state"],
      WeatherState | undefined
    >
  >();
  is<
    Equal<
      NonNullable<ReturnType<typeof home.snapshot>["amber"]>["state"],
      AmberSnapshot | undefined
    >
  >();
  // @ts-expect-error: no hue in this home
  home.part("hue");
  expect(() => {
    // @ts-expect-error: refresh takes only names in this home
    home.refresh("daikin");
  }).toThrow('no integration "daikin"');
  expect(home.part("weather")?.status).toBe("connecting");
});

test("loadHome's integrations type every known connector", () => {
  is<
    Equal<StateOf<Extract<HomeIntegration, { name: "weather" }>>, WeatherState>
  >();
  is<
    Equal<
      HomeSnapshot<HomeIntegration>["weather"],
      Part<WeatherState> | undefined
    >
  >();
  is<Equal<NonNullable<HomeSnapshot["any"]>["state"], unknown>>(); // untyped, a state is unknown, not any
  expect(true).toBe(true);
});
