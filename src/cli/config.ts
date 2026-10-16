// `home config check [path]`: validate a home config and print what it would set up, secrets as set or unset by name.
import { existsSync } from "node:fs";
import { checkHome } from "../config.ts";
import { manifestOf } from "../manifests.ts";
import { configPathOf, die, env, fromConfig, type Options, printJson, readConfig } from "./context.ts";

export async function configCommand(verb: string | undefined, file: string | undefined, o: Options): Promise<void> {
  const path = file ?? configPathOf(o);
  if (verb !== "check" || !path) die("usage: home config check [path]   (or set HOME_CONFIG, or pass --config)");
  const { config, setup, problems } = checkHome(readConfig(path!), env);
  const files = [
    ...Object.entries(config?.plan ?? {}).flatMap(([k, v]) => (typeof v === "string" ? [[`plan.${k}`, v]] : [])),
    ...setup.flatMap((s) => (manifestOf(s.name)?.files ?? []).filter((k) => typeof s.settings[k] === "string").map((k) => [`${s.from}.${k}`, s.settings[k] as string])),
  ];
  for (const [field, p] of files) if (!existsSync(fromConfig(path!, p!))) problems.push(`${field}: no file ${p}`);
  if (o.json) return printJson({ setup, problems });
  for (const s of setup) {
    const parts = [`from ${s.from}`, ...Object.entries(s.settings).map(([k, v]) => `${k} ${v}`), ...Object.entries(s.secrets).map(([k, v]) => `${k} ${v}`)];
    console.log(`${s.name.padEnd(9)}${parts.join(" · ")}`);
  }
  console.log(problems.length ? problems.map((p) => `problem: ${p}`).join("\n") : "ok");
  if (problems.length) process.exitCode = 1;
}
