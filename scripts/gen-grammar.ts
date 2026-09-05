// Regenerate editors/flow.tmLanguage.json — a TextMate grammar for `.flow` — from
// the same canonical token sets the studio's editor paints from (highlight.ts,
// which derives its function list from the engine's BUILTINS/STATEFUL). Written
// rather than hand-maintained for the reason every generated artefact here is:
// adding a keyword to the language must not leave the outside world's
// highlighting silently stale. Run with: npm run gen:grammar
import { writeFileSync } from "node:fs";
import process from "node:process";
import { KEYWORDS, CONSTS, FUNCTIONS } from "../src/ui/highlight.js";

const alt = (names: Iterable<string>): string =>
  [...names].sort((a, b) => b.length - a.length).join("|");

/** Build the grammar (no side effects), so a test can check the file is fresh. */
export function buildGrammar(): string {
  const grammar = {
    $schema: "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
    name: "flowloom",
    scopeName: "source.flow",
    fileTypes: ["flow"],
    patterns: [
      {
        // A `#` comment runs to end of line. `# @rung N` and `# @pos …` are
        // meaningful to flowloom, so they get their own scope inside it.
        name: "comment.line.number-sign.flow",
        begin: "#",
        end: "$",
        patterns: [{ name: "keyword.other.annotation.flow", match: "@(rung|pos)\\b" }],
      },
      { name: "keyword.control.flow", match: `^\\s*(${alt(KEYWORDS)})\\b` },
      // `change(X)` / `d(X)` on the left of `=` is a declaration, not a call.
      { name: "entity.name.function.rate.flow", match: "^\\s*(change|d)(?=\\s*\\()" },
      { name: "support.function.flow", match: `\\b(${alt(FUNCTIONS)})(?=\\s*\\()` },
      { name: "constant.language.flow", match: `\\b(${alt(CONSTS)})\\b` },
      { name: "constant.numeric.flow", match: "\\b\\d+(\\.\\d+)?([eE][+-]?\\d+)?\\b|\\B\\.\\d+" },
      // The unit / subscript bracket: one syntax, two meanings, one colour.
      { name: "entity.name.type.unit.flow", match: "\\[[^\\]]*\\]" },
      { name: "keyword.operator.range.flow", match: "±|\\+/-|\\bin\\b(?=\\s*-?[\\d.]+\\s*\\.\\.)|\\.\\." },
      { name: "keyword.operator.flow", match: "->|→|>=|<=|==|!=|&&|\\|\\||\\*\\*|[-+*/%^<>!=]" },
      { name: "constant.language.boolean.flow", match: "\\b(on|off|true|false|yes|no)\\b" },
      { name: "variable.other.flow", match: "\\b[A-Za-z_]\\w*(\\.[A-Za-z_]\\w*)*\\b" },
    ],
  };
  return JSON.stringify(grammar, null, 2) + "\n";
}

// Write only when invoked as the gen script (the npm script sets GEN_GRAMMAR=1),
// never when vitest imports buildGrammar for the freshness check.
if (process.env.GEN_GRAMMAR) {
  const doc = buildGrammar();
  writeFileSync("editors/flow.tmLanguage.json", doc);
  console.log(`wrote editors/flow.tmLanguage.json (${doc.length} bytes)`);
}
