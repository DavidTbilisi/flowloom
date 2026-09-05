import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildGrammar } from "../../scripts/gen-grammar.js";
import { KEYWORDS, FUNCTIONS, CONSTS } from "../../src/ui/highlight.js";

// CONTRACT: the TextMate grammar is generated from the same token sets the
// studio's own editor paints from. Adding a keyword or a builtin to the language
// must not leave `.flow` highlighting silently stale everywhere outside the app.

describe("editors/flow.tmLanguage.json", () => {
  const onDisk = readFileSync(new URL("../../editors/flow.tmLanguage.json", import.meta.url), "utf8");

  it("is up to date — run `npm run gen:grammar` if this fails", () => {
    expect(onDisk).toBe(buildGrammar());
  });

  it("is valid JSON with the scope an editor looks for", () => {
    const g = JSON.parse(onDisk) as { scopeName: string; fileTypes: string[]; patterns: unknown[] };
    expect(g.scopeName).toBe("source.flow");
    expect(g.fileTypes).toEqual(["flow"]);
    expect(g.patterns.length).toBeGreaterThan(5);
  });

  it("covers every keyword, builtin and reserved constant", () => {
    for (const k of KEYWORDS) expect(onDisk, k).toContain(k);
    for (const f of FUNCTIONS) expect(onDisk, f).toContain(f);
    for (const c of CONSTS) expect(onDisk, c).toContain(c);
  });

  it("matches longest-first, so `smooth3` is not painted as `smooth` plus a stray 3", () => {
    const g = JSON.parse(onDisk) as { patterns: Array<{ name: string; match?: string }> };
    const fns = g.patterns.find((p) => p.name === "support.function.flow")!.match!;
    expect(fns.indexOf("smooth3")).toBeLessThan(fns.indexOf("|smooth|"));
  });
});
