// `home enphase login`: mint the owner token once a year and keep it owner-only.
import { readFileSync } from "node:fs";
import {
  bunGatewayFetch,
  enphase,
  mintToken,
  tokenExpiry,
} from "../connectors/enphase/index.ts";
import { daysLeft } from "../connectors/enphase/client.ts";
import { writePrivate } from "../finders.ts";
import { env, fail, homeTimeZone, TOKEN_FILE, type Verbs } from "./context.ts";

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
    return fail(`${TOKEN_FILE}: ${(error as Error).message}`);
  }
}

/** Enphase as an integration from IQ_GATEWAY_HOST and the token file, for `home status`. */
export function enphaseFromEnv() {
  const t =
    enphaseToken() ?? fail("no Enphase token", "auth", "home enphase login");
  return enphase({
    host: env.IQ_GATEWAY_HOST!,
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
