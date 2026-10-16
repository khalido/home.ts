import { z } from "zod";
import { ConnectorError, fetchTimeout, getJson } from "../../connector.ts";
import { Login, Meters, Production, Readings, type Measurement } from "./schemas.ts";

/** A failed Enphase call. `status` 401 means the token is wrong or expired. */
export class EnphaseError extends ConnectorError {}

/** Solar right now and today. Watts and watt-hours as the gateway reports them, negatives included. */
export type EnphaseState = {
  productionW?: number;
  productionWhToday?: number; // undefined when the gateway's daily counter is missing or broken (see anomaly)
  productionWhLifetime?: number;
  consumptionW?: number; // needs a consumption meter
  consumptionWhToday?: number;
  consumptionWhLifetime?: number;
  netW?: number; // positive imports from the grid, negative exports
  source: "meter" | "inverters"; // where production came from
  readingTime?: string; // the gateway's own reading time
  anomaly?: string; // something the gateway reported that cannot be right, kept visible rather than corrected
};

/** A daily counter equal to the lifetime one is the software 8 bug seen on KO's gateway (D8.3.5528): not today's energy. */
const today = (m: Measurement | undefined) =>
  m?.whToday !== undefined && m.whToday !== m.whLifetime ? m.whToday : undefined;

const find = (list: Measurement[], type: string, measurementType?: string) =>
  list.find((m) => m.type === type && (measurementType === undefined || m.measurementType === measurementType));
const live = (m: Measurement | undefined) => (m && (m.activeCount ?? 0) > 0 ? m : undefined);

/**
 * Map `/production.json` and `/ivp/meters` to a state. A meter counts only when `/ivp/meters` says
 * "enabled" and its reading has `activeCount > 0` (KO's v1 code, pyenphase); else production falls back to the inverters.
 */
export function toState(production: unknown, meters: unknown): EnphaseState {
  const p = Production.parse(production);
  const enabled = new Set(Meters.parse(meters).filter((m) => m.state === "enabled").map((m) => m.measurementType));
  const prodMeter = enabled.has("production") ? live(find(p.production, "eim", "production")) : undefined;
  const inverters = find(p.production, "inverters");
  const hasConsumption = enabled.has("total-consumption") || enabled.has("net-consumption");
  const total = hasConsumption ? live(find(p.consumption, "eim", "total-consumption")) : undefined;
  const net = hasConsumption ? live(find(p.consumption, "eim", "net-consumption")) : undefined;
  const at = (prodMeter ?? inverters)?.readingTime;
  const broken = [prodMeter, total].some((m) => m?.whToday !== undefined && m.whToday === m.whLifetime);
  return {
    productionW: (prodMeter ?? inverters)?.wNow,
    productionWhToday: today(prodMeter),
    productionWhLifetime: (prodMeter ?? inverters)?.whLifetime,
    consumptionW: total?.wNow,
    consumptionWhToday: today(total),
    consumptionWhLifetime: total?.whLifetime,
    ...(broken ? { anomaly: "the gateway's whToday equals its lifetime total; today is counted from the lifetime counter instead" } : {}),
    netW: net?.wNow,
    source: prodMeter ? "meter" : "inverters",
    readingTime: at ? new Date(at * 1000).toISOString() : undefined,
  };
}

/**
 * Map `/ivp/meters` and `/ivp/meters/readings` to a state: ~100 ms on KO's gateway against 1–10 s for
 * `/production.json` (measured, Bun 1.4.2). Consumption is production plus net import on a net-consumption meter,
 * or read directly from a total-consumption meter (pyenphase's meter types). No daily totals here: callers count today.
 */
export function fromReadings(meters: unknown, readings: unknown): EnphaseState {
  const enabled = Meters.parse(meters).filter((m) => m.state === "enabled");
  const byEid = new Map(Readings.parse(readings).map((r) => [r.eid, r]));
  const reading = (type: string) => byEid.get(enabled.find((m) => m.measurementType === type)?.eid ?? -1);
  const prod = reading("production");
  const net = reading("net-consumption");
  const total = reading("total-consumption");
  const pW = prod?.activePower;
  const consumptionW = total?.activePower ?? (net?.activePower !== undefined && pW !== undefined ? pW + net.activePower : undefined);
  const pLife = prod?.actEnergyDlvd;
  const consumptionWhLifetime =
    total?.actEnergyDlvd ??
    (pLife !== undefined && net?.actEnergyDlvd !== undefined && net.actEnergyRcvd !== undefined ? pLife + net.actEnergyDlvd - net.actEnergyRcvd : undefined);
  const at = prod?.timestamp;
  return {
    productionW: pW,
    productionWhLifetime: pLife,
    consumptionW,
    consumptionWhLifetime,
    netW: net?.activePower ?? (consumptionW !== undefined && pW !== undefined ? consumptionW - pW : undefined),
    source: "meter",
    readingTime: at ? new Date(at * 1000).toISOString() : undefined,
  };
}

/** What a gateway client needs: its LAN address, an owner token, and a `fetch` that accepts its certificate. */
export type EnphaseOptions = { host: string; token: string; fetch: typeof fetch };

/** The gateway's address as a bare host: a scheme prefix and a trailing slash, as people paste it, are dropped. */
export const gatewayHost = (host: string) => host.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");

/** A read-only client for the IQ Gateway's local API (software 7 and later). */
export function enphaseClient(options: EnphaseOptions) {
  const base = `https://${gatewayHost(options.host)}`;
  const headers = { authorization: `Bearer ${options.token}`, accept: "application/json" };
  const get = (path: string, signal?: AbortSignal) => getJson(options.fetch, base + path, { init: { headers }, signal, error: EnphaseError });
  return {
    get,
    /** Production, consumption and net now: the fast meter readings when a production meter is on, else `/production.json`. */
    async read(signal?: AbortSignal): Promise<EnphaseState> {
      const meters = await get("/ivp/meters", signal);
      const metered = Meters.parse(meters).some((m) => m.measurementType === "production" && m.state === "enabled");
      return metered ? fromReadings(meters, await get("/ivp/meters/readings", signal)) : toState(await get("/production.json?details=1", signal), meters);
    },
  };
}

/** When a JWT expires, from its `exp` claim. Throws on anything that is not a JWT. */
export function tokenExpiry(token: string): Date {
  const payload = token.split(".")[1];
  if (!payload) throw new EnphaseError("not a JWT");
  const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  const exp = z.object({ exp: z.number() }).parse(json).exp;
  return new Date(exp * 1000);
}

/** Whole days until `expiresAt`, negative once expired. */
export const daysLeft = (expiresAt: Date, now: Date) => Math.floor((expiresAt.getTime() - now.getTime()) / 86_400_000);

/**
 * Mint an owner token as Enphase's TEB-00060 shows: log in for a session id, then ask Entrez for the gateway's token.
 * Two calls to Enphase's cloud; nothing is stored here.
 */
export async function mintToken(options: { username: string; password: string; serial: string; fetch: typeof fetch }) {
  const form = new URLSearchParams({ "user[email]": options.username, "user[password]": options.password });
  const login = await fetchTimeout(options.fetch, "https://enlighten.enphaseenergy.com/login/login.json", { method: "POST", body: form });
  const session = Login.safeParse(await login.json().catch(() => undefined));
  if (!login.ok || !session.success) throw new EnphaseError(`Enphase login failed (HTTP ${login.status})`, { status: login.status });
  const res = await fetchTimeout(options.fetch, "https://entrez.enphaseenergy.com/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: session.data.session_id, serial_num: options.serial, username: options.username }),
  });
  const token = (await res.text()).trim();
  if (!res.ok) throw new EnphaseError(`Entrez refused the token (HTTP ${res.status})`, { status: res.status });
  return { token, expiresAt: tokenExpiry(token) };
}

/**
 * A `fetch` for the gateway that skips certificate verification, for this gateway's requests only (Bun's `tls` option).
 * The gateway's chain ends at Enphase's unpublished `root-a.PKI.CA`, and Bun 1.4.2 neither trusts a partial chain nor
 * runs `checkServerIdentity` with verification off, so it cannot pin (measured). Reserve the gateway's IP. Node: see README.
 */
export function bunGatewayFetch(): typeof fetch {
  const f = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, tls: { rejectUnauthorized: false } } as RequestInit);
  return f as typeof fetch;
}
