// Regenerate examples/*.flow from the canonical embedded EXAMPLES so the two
// never drift. Run with: npm run gen:examples
import { writeFileSync, readdirSync, unlinkSync } from "node:fs";
import process from "node:process";
import { EXAMPLES } from "../src/examples/index.js";

// Guard the destructive top-level run behind the env flag the npm script sets, so
// merely importing this module (e.g. from a test) never deletes examples/*.flow.
if (process.env.GEN_EXAMPLES) {
  for (const f of readdirSync("examples")) if (f.endsWith(".flow")) unlinkSync(`examples/${f}`);
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  for (const ex of EXAMPLES) {
    writeFileSync(`examples/${slug(ex.name)}.flow`, ex.source.replace(/\s*$/, "") + "\n");
  }
  console.log(`wrote ${EXAMPLES.length} examples`);
}
