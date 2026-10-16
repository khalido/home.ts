import { describe, expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };

// Every entry point's runtime exports, by name. A new export, or an `export *` that drags internals in, fails here:
// add the name on purpose or keep it internal. Types do not show at runtime; tsc checks those.
const PUBLIC: Record<string, string[]> = {
  ".": ["ConnectorError", "Device", "HomeConfig", "HomeConfigError", "Room", "asOf", "checkHome", "checkPlan", "createHome", "energyNow", "envName", "filePath", "gridText", "loadHome", "parseJsonc", "rainSoon", "realClock", "solarLevel", "sunNow"],
  "./hue": ["HueError", "bunPinnedFetch", "configSchema", "groups", "homeGroupedLightId", "hue", "hueClient", "lights", "manifest", "pair", "scenes"],
  "./daikin": ["DaikinError", "POLL_MS", "acText", "configSchema", "daikin", "daikinClient", "manifest", "setFan", "setMode", "setPower", "setTarget"],
  "./enphase": ["EnphaseError", "POLL_MS", "bunGatewayFetch", "configSchema", "enphase", "enphaseClient", "enphaseText", "manifest", "mintToken", "tokenExpiry"],
  "./amber": ["AmberError", "POLL_MS", "amber", "amberClient", "amberText", "configSchema", "manifest"],
  "./weather": ["bom", "google", "manifest", "mergeWeather", "nextPoll", "openMeteo", "rainSoon", "rainText", "sunNow", "weather", "weatherText"],
  "./weather/ftp": ["ftpFetch"],
  "./cast": ["cast", "castDevices", "castText", "configSchema", "manifest", "resolvedFrom"],
  "./printers": ["POLL_MS", "configSchema", "manifest", "printerList", "printerText", "printers"],
  "./cast/tls": ["tlsConnect"],
  "./cast/serve": ["SERVE_MS", "lanAddress", "serveClip"],
  "./finders": ["FINDERS", "fileCache"],
  "./up": ["POLL_MS", "SIGNATURE_HEADER", "UpError", "categoryLines", "configSchema", "dollars", "isSpend", "manifest", "merchantKey", "notSpend", "parseWebhookEvent", "readTransactions", "recurring", "spendByCategory", "spendByMerchant", "toSnapshot", "uncategorised", "unusual", "up", "upClient", "upText", "verifyWebhook"],
};

describe("exports", () => {
  test("package.json lists exactly these entry points", () => {
    expect(Object.keys(pkg.exports).sort()).toEqual(Object.keys(PUBLIC).sort());
  });

  for (const [entry, names] of Object.entries(PUBLIC)) {
    test(`${entry} exports only its named list`, async () => {
      const file = (pkg.exports as Record<string, { import: string }>)[entry]!.import.replace("./dist/", "../src/").replace(/\.js$/, ".ts");
      expect(Object.keys(await import(file)).sort()).toEqual(names);
    });
  }
});
