// `home locate "<street address>" [--write [path]]`: the address's latitude and longitude from OpenStreetMap's Nominatim,
// printed; with --write, set in the config's `location` (and its `timezone`, when absent, to this machine's). The address
// itself goes only into the one query, never into the config or a file.
import { readFileSync, writeFileSync } from "node:fs";
import { checkPlan, parseJsonc } from "../config.ts";
import { applyLocation, geocode } from "../locate.ts";
import { configPathOf, die, fail, type Options, printJson, writeTo } from "./context.ts";

export async function locate(words: string[], o: Options): Promise<void> {
  const address = words.join(" ").trim() || die('usage: home locate "<street address>" [--write [path]]   (the address first: a word after --write is its path)');
  const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  const at = (await geocode(address, { fetch, userAgent: `khalido-home/${version}` })) ?? fail("Nominatim found no match; try the street, suburb and state");
  const write = writeTo(o);
  if (o.json && write === undefined) return printJson(at);
  console.log(`${at.name}\n${at.latitude}, ${at.longitude}`);
  if (write === undefined) return;
  const path = write || configPathOf(o) || fail("--write needs a path, --config or HOME_CONFIG");
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const r = applyLocation(readFileSync(path, "utf8"), at, timeZone);
  const problems = checkPlan(parseJsonc(r.text)).problems;
  if (problems.length) fail(`${path} not written: the result would have problems: ${problems.join("; ")}`);
  writeFileSync(path, r.text);
  console.log(`wrote ${path}: location ${at.latitude}, ${at.longitude}${r.timezoneSet ? `, timezone ${timeZone}` : ""}${r.fresh ? " (a new location object: the config had none, or only a commented-out one, left as it was)" : ""}`);
}
