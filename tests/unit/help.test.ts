import { describe, it, expect } from "vitest";
import { BUILTINS, STATEFUL } from "../../src/engine/index.js";
import { tokenizeSource, tokenAt, KEYWORDS, CONSTS, FUNCTIONS } from "../../src/ui/highlight.js";
import { HELP, resolveHelp } from "../../src/ui/help-content.js";

// These are contracts: the help system must stay in lock-step with the
// language. If someone adds a builtin or keyword without help, this fails.

describe("contextual help coverage", () => {
  it("explains every line keyword", () => {
    for (const k of KEYWORDS) expect(HELP[k], `missing help for keyword '${k}'`).toBeTruthy();
  });

  it("explains every builtin (stateless + stateful)", () => {
    for (const name of [...Object.keys(BUILTINS), ...STATEFUL])
      expect(HELP[`fn:${name}`], `missing help for builtin '${name}'`).toBeTruthy();
  });

  it("explains every reserved constant / clock identifier", () => {
    for (const c of CONSTS) expect(HELP[`const:${c}`], `missing help for const '${c}'`).toBeTruthy();
  });

  it("FUNCTIONS set matches the engine's builtins", () => {
    for (const name of [...Object.keys(BUILTINS), ...STATEFUL]) expect(FUNCTIONS.has(name)).toBe(true);
  });
});

describe("tokenizeSource", () => {
  const sample = `# a model\nstock Population = 5\nflow growth = birthRate * Population\nd(Population) = growth\nsim dt=0.1 to=25 method=rk4`;

  it("rebuilds the source verbatim (lossless)", () => {
    const toks = tokenizeSource(sample);
    expect(toks.map((t) => t.text).join("")).toBe(sample);
  });

  it("classifies line keywords, builtins, comments, and numbers", () => {
    const toks = tokenizeSource("stock X = 5 # note\nflow f = exp(X)");
    const kindOf = (text: string) => toks.find((t) => t.text === text)?.kind;
    expect(kindOf("stock")).toBe("keyword");
    expect(kindOf("flow")).toBe("keyword");
    expect(kindOf("exp")).toBe("builtin");
    expect(kindOf("X")).toBe("ident");
    expect(kindOf("5")).toBe("number");
    expect(toks.find((t) => t.kind === "comment")?.text).toBe("# note");
  });

  it("only treats a keyword word as a keyword at the start of a line", () => {
    // `flow` used as an identifier mid-expression must stay an ident
    const toks = tokenizeSource("aux y = flow");
    expect(toks.find((t) => t.text === "aux")?.kind).toBe("keyword");
    expect(toks.find((t, i) => t.text === "flow" && i > 0)?.kind).toBe("ident");
  });

  it("scientific notation is one number token", () => {
    const toks = tokenizeSource("param k = 1.5e-3");
    expect(toks.find((t) => t.kind === "number")?.text).toBe("1.5e-3");
  });

  it("tokenAt returns the explainable token under an offset", () => {
    const src = "stock Population = 5";
    const toks = tokenizeSource(src);
    const at = tokenAt(toks, 8); // inside "Population"
    expect(at?.text).toBe("Population");
    expect(at?.helpKey).toBe("ident:Population");
    // whitespace has no help
    expect(tokenAt(toks, src.indexOf(" "))?.text).not.toBe(" ");
  });
});

describe("resolveHelp (static keys)", () => {
  it("returns entries for keyword and builtin keys without a store", () => {
    expect(resolveHelp("stock")?.title).toMatch(/stock/);
    expect(resolveHelp("fn:step")?.title).toMatch(/step/);
    expect(resolveHelp("ui:badge-R")?.title).toMatch(/reinforc/i);
  });
  it("returns null for an identifier without a store", () => {
    expect(resolveHelp("ident:Population")).toBeNull();
  });
});
