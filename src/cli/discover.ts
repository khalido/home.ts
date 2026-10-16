// `home discover [--passes n] [--write [path]]`: what smart-home devices answer on this network, and which this package
// supports. mDNS (macOS dns-sd) plus Daikin's UDP broadcast; with a config, how they match it.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { realClock } from "../clock.ts";
import { checkPlan, parseJsonc } from "../config.ts";
import { addressBook, applyFound, discover as discoverAll, DISCOVERY_GAP_MS, DISCOVERY_PASSES, type Found, foundKey, KNOWN_SERVICES, matchFound } from "../discover.ts";
import { browse, daikinFound, FINDERS, findDaikins } from "../finders.ts";
import { addresses, configPathOf, fail, type Options, printJson, writeTo } from "./context.ts";

export async function discover(o: Options): Promise<void> {
  const write = writeTo(o);
  const path = write || configPathOf(o);
  if (write !== undefined && !path) fail("--write needs a path, --config or HOME_CONFIG");
  const text = path ? readFileSync(path, "utf8") : undefined;
  const plan = text === undefined ? undefined : checkPlan(parseJsonc(text));
  if (plan && !plan.config) fail(`${path}: ${plan.problems.join("; ")}`);
  const passes = o.passes === undefined ? undefined : Number(o.passes);
  if (passes !== undefined && !(Number.isInteger(passes) && passes >= 1)) fail(`--passes must be a whole number from 1, got ${o.passes}`);
  // One pass: every connector's discovery (Daikin's broadcast once), and the instances of every other known mDNS type.
  type Seen = { what: string; connector?: string; name: string; found?: Found };
  const what = (c: string) => (c === "daikin" ? "Daikin AC (UDP broadcast)" : Object.values(KNOWN_SERVICES).find((s) => s.connector === c)!.what);
  const pass = async (): Promise<Seen[]> => {
    const others = Object.entries(KNOWN_SERVICES).filter(([, info]) => !info.connector);
    const [services, daikins, mdns] = await Promise.all([
      Promise.all(others.map(async ([type, info]) => (await browse(type)).map((name) => ({ what: info.what, name })))).then((all) => all.flat()),
      findDaikins(),
      Promise.all([FINDERS.hue(), FINDERS.enphase(), FINDERS.cast(), FINDERS.printers()]).then((all) => all.flat()),
    ]);
    return [...[...mdns, ...daikins.flatMap(daikinFound)].map((f) => ({ what: what(f.connector), connector: f.connector, name: f.name ?? f.id, found: f })), ...services];
  };
  const listing = (seen: Seen[]) => {
    for (const w of [...new Set(seen.map((x) => x.what))]) {
      const rows = seen.filter((x) => x.what === w);
      const connector = rows[0]!.connector;
      console.log(`${w} · ${rows.length} found · ${connector ? `supported: ${connector}` : "not supported"}`);
      if (connector) for (const r of rows) console.log(`  ${r.name}`);
    }
  };
  const seen = await discoverAll(pass, {
    clock: realClock,
    passes,
    key: (x) => (x.found ? foundKey(x.found) : `${x.what}:${x.name}`),
    onPass: (n, added) => {
      if (o.json) return;
      const tty = process.stderr.isTTY;
      const label = (k: number) => (k === 2 ? "second pass" : `pass ${k}`);
      if (tty && n > 1) process.stderr.write("\r\x1b[K");
      if (n === 1) listing(added);
      else console.log(added.length ? added.map((x) => `${label(n)}: found ${x.what}: ${x.name}`).join("\n") : `${label(n)}: nothing new`);
      // The wait before the next pass is otherwise silent: say so on stderr, where a pipe does not see it.
      if (tty && n < (passes ?? DISCOVERY_PASSES)) process.stderr.write(`${label(n + 1)} in ${DISCOVERY_GAP_MS / 1000} s…`);
    },
  });
  const found = seen.flatMap((x) => (x.found ? [x.found] : []));
  const rows = [...new Set(seen.map((x) => x.what))].map((w) => {
    const these = seen.filter((x) => x.what === w);
    return { what: w, connector: these[0]!.connector, names: these.map((x) => x.name) };
  });
  // With a config: match what answers by identity; write moved hosts and new devices only with --write, and only a result that checks.
  const match = plan?.config && matchFound(plan.config, found);
  let wrote: string | undefined;
  const changes = match ? match.moved.length + match.renamed.length + match.added.length : 0;
  if (match && write !== undefined && changes) {
    const out = applyFound(text!, match, !!plan!.config!.devices?.length);
    let after: string[];
    try {
      after = checkPlan(parseJsonc(out)).problems;
    } catch (error) {
      after = [String(error)];
    }
    if (after.length) fail(`${path} not written: the result would have problems: ${after.join("; ")}`);
    writeFileSync(path!, out);
    wrote = `wrote ${path}: ${match.moved.length} moved, ${match.renamed.length} renamed, ${match.added.length} added; check it with \`home config check\``;
  }
  // Into the cache after the config is written, against its new time, so every address just confirmed is fresh.
  const book = addressBook(addresses.cache, { configAt: path && existsSync(path) ? statSync(path).mtimeMs : undefined });
  for (const f of found) book.seen(f.connector, f.id, { host: f.host, port: f.port, name: f.connector === "cast" ? f.name : undefined });
  if (o.json) return printJson(match ? { services: rows, match, wrote } : rows);
  if (!match) return;
  console.log(`\n${path}:`);
  for (const k of match.known) console.log(`known   ${k.connector} ${k.id}${k.hint ? ` · ${k.hint}` : ""}`);
  for (const m of match.moved) console.log(`moved   ${m.connector} ${m.id}: ${m.from} → ${m.to}`);
  for (const r of match.renamed) console.log(`renamed ${r.connector} ${r.id}: "${r.from}" → "${r.to}"`);
  for (const a of match.added) console.log(`new     ${a.found.connector} ${a.found.name ? `"${a.found.name}" ` : ""}${a.found.id} at ${a.found.host}`);
  for (const s of match.skipped) console.log(`skipped ${s.found.connector} ${s.found.id} at ${s.found.host} · ${s.why}`);
  if (!found.length) console.error("home: nothing answered (mDNS and the Daikin broadcast)");
  else if (write === undefined) console.error(changes ? `home: run with --write ${path} to update it` : "home: the config is current");
  else console.error(`home: ${wrote ?? "nothing to write"}`);
}
