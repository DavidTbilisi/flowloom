// Regenerate examples/*.flow from the canonical embedded EXAMPLES so the two
// never drift. Run with: npm run gen:examples
import { writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { EXAMPLES } from "../src/examples/index.js";

for (const f of readdirSync("examples")) if (f.endsWith(".flow")) unlinkSync(`examples/${f}`);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
for (const ex of EXAMPLES) {
  writeFileSync(`examples/${slug(ex.name)}.flow`, ex.source.replace(/\s*$/, "") + "\n");
}
console.log(`wrote ${EXAMPLES.length} examples`);
