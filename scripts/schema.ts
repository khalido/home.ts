// Writes home.schema.json from the zod schema in src/config.ts. `bun run schema`; a test fails if the committed file drifts.
import { z } from "zod";
import { HomeConfig } from "../src/config.ts";

export const schemaText = () =>
  `${JSON.stringify(z.toJSONSchema(HomeConfig, { io: "input" }), null, 2)}\n`;

if (import.meta.main)
  await Bun.write(
    new URL("../home.schema.json", import.meta.url),
    schemaText(),
  );
