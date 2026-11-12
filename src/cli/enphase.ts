// `home enphase login`: mint the owner token once a year and keep it owner-only.
import { readFileSync } from "node:fs";
import {
  bunGatewayFetch,
  enphase,
  mintToken,
  tokenExpiry,
} from "../connectors/enphase/index.ts";
import { daysLeft } from "../connectors/enphase/client.ts";
import { addressBook } from "../discover.ts";
import { FINDERS, writePrivate } from "../finders.ts";
import {
  addresses,
  env,
  fail,
  homeTimeZone,
  TOKEN_FILE,
  type Verbs,
} from "./context.ts";

/** The cached Enphase token, or undefined if `home enphase login` has not run. A corrupt file throws, naming it. */
export function enphaseToken(): { token: string; expiresAt: Date } | undefined {
  let text: string;
  try {
    text = readFileSync(TOKEN_FILE, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const { token } = JSON.parse(text) as { token: string };
    return { token, expiresAt: tokenExpiry(token) };
  } catch (error) {
    return fail(
      `${TOKEN_FILE}: ${(error as Error).message}`,
      "auth",
      "home enphase login",
    );
  }
}

/**
 * Enphase as an integration for `home status`: IQ_GATEWAY_HOST, else the address cache, else the first gateway mDNS finds.
 * With the gateway's serial from the cache, a read that fails is followed by discovery at once, so an IQ_GATEWAY_HOST left
 * behind by a DHCP move still reads, and its detail says where the gateway went.
 */
export async function enphaseFromEnv() {
  const t =
    enphaseToken() ?? fail("no Enphase token", "auth", "home enphase login");
  const book = addressBook(addresses.cache);
  const serial = Object.keys(book.entries())
    .find((k) => k.startsWith("enphase:"))
    ?.slice("enphase:".length);
  const cached = serial ? book.fresh("enphase", serial) : undefined;
  const host =
    env.IQ_GATEWAY_HOST ??
    cached?.host ??
    (await FINDERS.enphase())[0]?.host ??
    fail("no gateway found by mDNS; set IQ_GATEWAY_HOST", "network");
  return enphase({
    host,
    serial,
    find: FINDERS.enphase,
    seen: (h) => book.seen("enphase", serial, { host: h }),
    hostCached: true, // an env address is as likely stale as a cached one: look again after one failure
    token: t.token,
    fetch: bunGatewayFetch(),
    timeZone: homeTimeZone(),
  });
}

export const enphaseVerbs: Verbs = {
  /** Mint the owner token and cache it. Prints the days left, nothing else. */
  async login() {
    const need = (n: string) => env[n] ?? fail(`set ${n}`);
    const { token, expiresAt } = await mintToken({
      username: need("ENPHASE_USERNAME"),
      password: need("ENPHASE_PASSWORD"),
      serial: need("IQ_GATEWAY_SERIAL_NUMBER"),
      fetch,
    });
    writePrivate(
      TOKEN_FILE,
      JSON.stringify({
        token,
        expiresAt: expiresAt.toISOString(),
        mintedAt: new Date().toISOString(),
      }),
    );
    console.log(`${daysLeft(expiresAt, new Date())} days left`);
  },
};
