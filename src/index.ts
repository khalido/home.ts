// The root entry: the home, its config, discovery types, the clock, energy, and the sun and rain helpers. The weather types are in `./weather`.
// Each connector has its own entry point (`@khalido/home/hue` and so on). Every export is named; test/exports.test.ts lists them.
export { createHome, envName, filePath, type HomeSnapshot, type Integration, type Part, type Status } from "./home.ts";
export { asOf, type Clock, realClock } from "./clock.ts";
export { ConnectorError } from "./connector.ts";
export { type EnergyNow, energyNow, gridText, solarLevel } from "./energy.ts";
export { checkHome, checkPlan, Device, HomeConfig, HomeConfigError, type LoadOptions, loadHome, parseJsonc, Room, type Setup } from "./config.ts";
export type { AddressCache, CachedAddress, Connector, Finder, Found } from "./discover.ts";
export { type SunNow, sunNow } from "./connectors/weather/sun.ts";
export { type RainSoon, rainSoon } from "./connectors/weather/rain.ts";
export type { EnvVar, IotClass, Manifest } from "./manifest.ts";
