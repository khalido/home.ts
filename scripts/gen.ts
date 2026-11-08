// Writes .env.example from each connector's manifest. `bun run gen`; a test fails if the committed file drifts.
import type { EnvVar } from "../src/manifest.ts";
import { MANIFESTS } from "../src/manifests.ts";

const HEADER = `# Names the \`home\` CLI, the live tests and the bench read. Dummy values; copy to .env (gitignored)
# or export them in your shell. The library never reads these: callers pass everything in. Written by \`bun run gen\`
# from each connector's manifest (src/connectors/*/index.ts); edit those, not this file.`;

/** Outside any connector: which config `home` reads. */
const HOME_CONFIG: EnvVar = {
  name: "HOME_CONFIG",
  example: "",
  optional: true,
  what: "a home config (JSONC), e.g. ~/home/home.jsonc; else the names above",
};

/** `NAME=example  # what`, the comments in one column; an optional name says so. */
const line = (e: EnvVar) => {
  const what = [e.optional ? "optional" : "", e.what]
    .filter(Boolean)
    .join(": ");
  const assign = `${e.name}=${e.example ?? ""}`;
  return what ? `${assign.padEnd(37)} # ${what}` : assign;
};

export const envExampleText = () =>
  `${[HEADER, ...MANIFESTS.flatMap((m) => m.env).map(line), line(HOME_CONFIG)].join("\n")}\n`;

if (import.meta.main)
  await Bun.write(
    new URL("../.env.example", import.meta.url),
    envExampleText(),
  );
