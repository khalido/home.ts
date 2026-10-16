// `home cache [clear]`: the addresses kept between runs, or delete them so the next run discovers afresh.
import { rmSync } from "node:fs";
import { addresses, CACHE_FILE, die, type Options, printJson } from "./context.ts";

export async function cacheCommand(verb: string | undefined, o: Options): Promise<void> {
  if (verb === "clear") return rmSync(CACHE_FILE, { force: true }), console.log(`deleted ${CACHE_FILE}`);
  if (verb !== undefined) die("usage: home cache [clear]");
  const entries = addresses.cache.read();
  if (o.json) return printJson(entries);
  console.log(CACHE_FILE);
  for (const [key, c] of Object.entries(entries)) console.log(`  ${key}${c.name ? ` (${c.name})` : ""}: ${c.host}${c.port === undefined ? "" : `:${c.port}`} · seen ${c.seenAt}`);
  if (!Object.keys(entries).length) console.log("  empty");
}
