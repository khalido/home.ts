// `home probe`: read-only checks that need no key: Hue's public config, Daikin discovery and state, the IQ Gateway's
// /info, each Cast device's status, each printer's status, each weather source.
import { type CastSnapshot, castDevices } from "../connectors/cast/index.ts";
import { type PrintersState, printerList } from "../connectors/printers/index.ts";
import { gatewayHost } from "../connectors/enphase/client.ts";
import { bunPinnedFetch } from "../connectors/hue/index.ts";
import { type WeatherSource } from "../connectors/weather/index.ts";
import { DEFAULT_POLL_MINUTES, sourcePollMinutes } from "../connectors/weather/source.ts";
import { checkHome } from "../config.ts";
import { daikinFields, findDaikins } from "../finders.ts";
import { castNow } from "./cast.ts";
import { printersNow } from "./printers.ts";
import { settle } from "../home.ts";
import { configPathOf, env, fail, fromConfig, type Options, printJson, readConfig } from "./context.ts";
import { bridge, ca } from "./hue.ts";
import { place, weatherSources } from "./status.ts";

/** The env names `probe` reads, filled from a config's addresses (secrets by the names it gives), so probe needs no second reading of it. */
function envFromConfig(path: string): Record<string, string> {
  const { config, problems } = checkHome(readConfig(path), env);
  if (!config) fail(`${path}: ${problems.join("; ")}`);
  const out: Record<string, string | undefined> = {};
  for (const d of config!.devices ?? []) {
    if (d.connector === "hue") Object.assign(out, { HUE_BRIDGE_HOST: d.host, HUE_BRIDGE_ID: d.bridgeId, HUE_CA_FILE: fromConfig(path, d.ca), HUE_APPLICATION_KEY: env[d.key] });
    if (d.connector === "daikin") out.DAIKIN_HOST = d.host;
    if (d.connector === "enphase") out.IQ_GATEWAY_HOST = d.host;
    if (d.connector === "amber") Object.assign(out, { AMBER_KEY: env[d.key], AMBER_SITE_ID: d.siteId });
  }
  const at = config!.location;
  if (at) Object.assign(out, { HOME_LATITUDE: String(at.latitude), HOME_LONGITUDE: String(at.longitude), HOME_BOM_FORECAST: at.bomForecast });
  const g = config!.weather?.googleKey;
  if (g) out.GOOGLE_WEATHER_KEY = env[g];
  return Object.fromEntries(Object.entries(out).filter((e): e is [string, string] => e[1] !== undefined));
}

/** GET a URL and return its text, or the error, within 5 s. */
const tryGet = (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(5000) }).then(
    async (r) => ({ status: r.status, body: await r.text() }),
    (e: Error) => ({ status: 0, body: e.message }),
  );

const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

/** What `basic_info` and the UDP answer may show: the adapter and firmware, never its name, MAC, Wi-Fi name or password. */
const DAIKIN_SHOWN = ["ret", "type", "reg", "ver", "rev", "adp_kind", "pv", "cpv", "method", "err", "en_setzone"];

/** The BRP084 reply's response codes only: its `adp_i` node holds the adapter's MAC (pydaikin reads it there). */
const answered = (reply: { responses?: { fr?: string; rsc?: number }[]; notJson?: string }) =>
  reply.notJson ? reply : { status: "answers", responses: reply.responses?.map((r) => ({ from: r.fr, code: r.rsc })) };

/** JSON, or the start of the body as text when it is not. */
const jsonOr = (body: string) => {
  try {
    return JSON.parse(body);
  } catch {
    return { notJson: body.slice(0, 80) };
  }
};

export async function probe(o: Options): Promise<void> {
  const configPath = configPathOf(o);
  if (configPath) Object.assign(env, envFromConfig(configPath)); // the config's addresses, for this one command
  const out: Record<string, unknown> = {};
  try {
    const b = await bridge();
    const fetchPinned = env.HUE_CA_FILE ? bunPinnedFetch(b.id, ca()) : undefined;
    const r = fetchPinned ? await fetchPinned(`https://${b.host}/api/0/config`).then((x) => x.json()) : "needs HUE_CA_FILE";
    out.hue = typeof r === "string" ? { status: r } : { status: "answers", ...pick(r, ["name", "modelid", "apiversion", "swversion"]) };
  } catch (error) {
    out.hue = { status: "unavailable", detail: (error as Error).message };
  }
  const daikins = env.DAIKIN_HOST ? [{ ip: env.DAIKIN_HOST, fields: {} }] : await findDaikins();
  out.daikin = daikins.length
    ? await Promise.all(
        daikins.map(async (d) => {
          const info = await tryGet(`http://${d.ip}/common/basic_info`);
          const control = await tryGet(`http://${d.ip}/aircon/get_control_info`);
          const sensor = await tryGet(`http://${d.ip}/aircon/get_sensor_info`);
          const f = (r: { status: number; body: string }) => (r.status === 200 ? daikinFields(r.body) : { status: r.status, error: r.body.slice(0, 80) });
          const shown = (r: typeof info) => (r.status === 200 ? pick(daikinFields(r.body), DAIKIN_SHOWN) : f(r));
          const result: Record<string, unknown> = { ip: d.ip, udp: pick(d.fields, DAIKIN_SHOWN), basic_info: shown(info), control_info: f(control), sensor_info: f(sensor) };
          if (info.status === 404) {
            // Not the BRP069 API. Try the newer JSON one (BRP084): op 2 is a read of the adapter's info, as pydaikin does.
            const body = JSON.stringify({
              requests: [
                { op: 2, to: "/dsiot/edge.adp_i" },
                { op: 2, to: "/dsiot/edge/adr_0100.dgc_status?filter=pv,pt,md" },
              ],
            });
            const r = await tryGet(`http://${d.ip}/dsiot/multireq`, { method: "POST", headers: { "content-type": "application/json" }, body });
            result.dsiot = r.status === 200 ? answered(jsonOr(r.body)) : { status: r.status, error: r.body.slice(0, 80) };
          }
          return result;
        }),
      )
    : { status: "no answer to the UDP broadcast; set DAIKIN_HOST to try one address" };
  const gateway = env.IQ_GATEWAY_HOST && gatewayHost(env.IQ_GATEWAY_HOST);
  if (gateway) {
    // Bun cannot verify the gateway's chain (README); this unauthenticated read sends nothing secret.
    const r = await tryGet(`https://${gateway}/info`, { tls: { rejectUnauthorized: false } } as RequestInit);
    const tag = (t: string) => r.body.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1];
    const serial = tag("sn");
    out.enphase = r.status === 200
      ? { status: "answers", software: tag("software") ?? tag("version"), part: tag("pn"), serialMatchesEnv: env.IQ_GATEWAY_SERIAL_NUMBER ? serial === env.IQ_GATEWAY_SERIAL_NUMBER : "IQ_GATEWAY_SERIAL_NUMBER unset" }
      : { status: "unavailable", detail: `${r.status} ${r.body.slice(0, 80)}` };
  } else out.enphase = { status: "needs IQ_GATEWAY_HOST" };
  // Cast: connect to every device and group, read receiver (and group) status, close. Nothing is launched or changed.
  const c = (await settle([castNow()], 10_000)).cast!;
  const devices = (c.state as CastSnapshot | undefined)?.devices ?? {};
  out.cast = { status: c.status, detail: c.detail, anomaly: c.anomaly, devices: castDevices({ devices, asOf: "" }).map(({ host: _, asOf: __, ...d }) => d) };
  // Printers: one Get-Printer-Attributes to each AirPrint printer that answers mDNS (or the address cache). Nothing is sent but the read.
  const pr = (await settle([printersNow()], 15_000)).printers!;
  out.printers = { status: pr.status, detail: pr.detail, anomaly: pr.anomaly, printers: printerList((pr.state as PrintersState | undefined) ?? { printers: {}, asOf: "" }).map(({ host: _, asOf: __, ...p }) => p) };
  const needs = ["HOME_LATITUDE", "HOME_LONGITUDE"].filter((n) => !env[n]);
  if (needs.length) out.weather = { status: `needs ${needs.join(", ")}` };
  else {
    const at = place();
    const now = Date.now();
    const probeOne = async (source: WeatherSource) => {
      const t = performance.now();
      const r = await source.read({ place: at, at: now, pollMinutes: sourcePollMinutes(source, DEFAULT_POLL_MINUTES) });
      const when = (s?: { at: string; modelled: boolean }) => (s ? `${s.at}${s.modelled ? " (modelled)" : ""}` : undefined);
      return {
        status: r.stop ? "unavailable" : r.now || r.forecast || r.sky || r.rain ? "answers" : "no data",
        ms: Math.round(performance.now() - t),
        now: when(r.now),
        station: r.now?.station,
        forecastIssued: r.forecast?.issuedAt ?? when(r.forecast),
        sky: when(r.sky),
        rain: when(r.rain),
        problem: r.stop ?? r.problem,
        anomaly: r.anomaly,
      };
    };
    const probed = await Promise.all(weatherSources().map(async (s) => [s.name, await probeOne(s)] as const));
    out.weather = { ...Object.fromEntries(probed), ...(env.GOOGLE_WEATHER_KEY ? {} : { google: { status: "no key: set GOOGLE_WEATHER_KEY" } }) };
  }
  printJson(out);
}
