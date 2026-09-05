// Regenerate examples/*.flow from the canonical embedded EXAMPLES so the two
// never drift. Run with: npm run gen:examples
import { writeFileSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import process from "node:process";
import { EXAMPLES } from "../src/examples/index.js";

// Guard the destructive top-level run behind the env flag the npm script sets, so
// merely importing this module (e.g. from a test) never deletes examples/*.flow.
if (process.env.GEN_EXAMPLES) {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const names = EXAMPLES.map((ex) => `${slug(ex.name)}.flow`);

  // Delete only what this script owns. Wiping every `examples/*.flow` also
  // deleted hand-written models that live there without being embedded — which
  // is a silent data loss the next person to run `gen:examples` discovers.
  // The manifest records exactly what was written last time, so a *renamed*
  // example is still cleaned up while a hand-added file survives.
  const manifest = "examples/.generated";
  let owned: string[] = [];
  try {
    owned = readFileSync(manifest, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  } catch {
    // First run after this change: fall back to the names we are about to write,
    // so nothing outside the embedded set is touched.
    owned = names;
  }
  const present = new Set(readdirSync("examples"));
  for (const f of owned) if (present.has(f) && !names.includes(f)) unlinkSync(`examples/${f}`);

  for (const ex of EXAMPLES) {
    writeFileSync(`examples/${slug(ex.name)}.flow`, ex.source.replace(/\s*$/, "") + "\n");
  }
  writeFileSync(manifest, `# written by npm run gen:examples — do not edit\n${names.join("\n")}\n`);
  console.log(`wrote ${EXAMPLES.length} examples`);
}
