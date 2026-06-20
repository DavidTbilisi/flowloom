import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import {
  addStock, addVar, setRate, connectFlowToStock, pipeBetweenStocks, setEquation, setInit,
  renameSymbol, deleteSymbol, declaredNames, uniqueName, referencesTo, readLayout, setLayoutPos,
} from "../../src/ui/model-build.js";

// CONTRACT: the visual builder edits the canonical text. Every mutation is a
// string→string transform whose *result must parse to the intended model*. We
// assert against a real parse, not just string shape, so the builder can never
// silently produce a model that differs from what the diagram action implied.

const BASE = `# demo
stock Population = 5

param birthRate = 0.7
param carrying  = 1000

sim dt=0.1 to=25 method=rk4
plot Population
`;

describe("model-build: adding declarations", () => {
  it("addStock inserts a parseable stock before the sim/plot block", () => {
    const out = addStock(BASE, "Resource", "100", "kg");
    const m = parseModel(out);
    expect(m.stocks.find((s) => s.name === "Resource")?.unit).toBe("kg");
    // the new line lands above `sim`, not after `plot`
    const lines = out.split("\n");
    expect(lines.findIndex((l) => l.includes("stock Resource"))).toBeLessThan(
      lines.findIndex((l) => l.startsWith("sim")),
    );
  });

  it("addVar adds a flow/aux/param that parses with the right kind", () => {
    const m = parseModel(addVar(BASE, "flow", "growth", "birthRate * Population"));
    expect(m.varIndex.get("growth")?.kind).toBe("flow");
    expect(parseModel(addVar(BASE, "param", "decay", "0.1")).varIndex.get("decay")?.kind).toBe("param");
  });

  it("appends a sim line when the source has no sim/plot block", () => {
    const out = addStock("stock A = 1\n", "B", "2");
    const m = parseModel(out);
    expect(m.stocks.map((s) => s.name).sort()).toEqual(["A", "B"]);
  });
});

describe("model-build: rates and connections", () => {
  it("setRate inserts then replaces the change() line", () => {
    const withFlow = addVar(BASE, "flow", "growth", "birthRate * Population");
    const wired = setRate(withFlow, "Population", "growth");
    expect(parseModel(wired).rates.get("Population")).toBeTruthy();
    // replacing keeps a single rate, with the new RHS
    const rewired = setRate(wired, "Population", "growth * 2");
    const m = parseModel(rewired);
    expect(m.rates.size).toBe(1);
    expect(rewired).toContain("change(Population) = growth * 2");
  });

  it("connectFlowToStock folds a term into an existing rate", () => {
    let src = addVar(BASE, "flow", "births", "birthRate * Population");
    src = addVar(src, "flow", "deaths", "0.2 * Population");
    src = connectFlowToStock(src, "births", "Population", "+");
    src = connectFlowToStock(src, "deaths", "Population", "-");
    expect(parseModel(src).rates.get("Population")).toBeTruthy();
    expect(src).toContain("change(Population) = births - deaths");
  });

  it("connectFlowToStock creates the rate when none exists", () => {
    const src = connectFlowToStock(addVar(BASE, "flow", "g", "1"), "g", "Population", "-");
    expect(src).toContain("change(Population) = -g");
    expect(parseModel(src).rates.get("Population")).toBeTruthy();
  });

  it("pipeBetweenStocks drains the source and fills the target", () => {
    const src = pipeBetweenStocks(addStock(BASE, "Sink", "0"), "Population", "Sink", "outflow", "0.1 * Population");
    const m = parseModel(src);
    expect(m.varIndex.get("outflow")?.kind).toBe("flow");
    expect(src).toContain("change(Population) = -outflow");
    expect(src).toContain("change(Sink) = outflow");
    expect(m.rates.get("Population")).toBeTruthy();
    expect(m.rates.get("Sink")).toBeTruthy();
  });
});

describe("model-build: editing equations", () => {
  it("setEquation replaces a var RHS, preserving comments", () => {
    const withComment = "param k = 0.7  # rate\nstock S = 1\nsim dt=1 to=2\n";
    const out = setEquation(withComment, "k", "0.9");
    expect(out).toContain("param k = 0.9  # rate");
    expect(parseModel(out).varIndex.get("k")?.kind).toBe("param");
  });

  it("setInit replaces a stock's initial value, preserving its unit", () => {
    const out = setInit(BASE, "Population", "42");
    expect(out).toContain("stock Population = 42");
    expect(parseModel(out).stocks.find((s) => s.name === "Population")?.initExpr).toMatchObject({ value: 42 });
  });
});

describe("model-build: rename", () => {
  it("renames a symbol across decl, expressions, change() and plot", () => {
    let src = addVar(BASE, "flow", "growth", "birthRate * Population");
    src = setRate(src, "Population", "growth");
    src = renameSymbol(src, "Population", "Pop");
    const m = parseModel(src);
    expect(m.stocks.map((s) => s.name)).toContain("Pop");
    expect(m.rates.get("Pop")).toBeTruthy();
    expect(m.plot).toContain("Pop");
    expect(m.varIndex.get("growth")?.expr).toBeTruthy();
    // no stray "Population" identifier survives
    expect(src).not.toMatch(/\bPopulation\b/);
  });

  it("carries a node's stored position across a rename", () => {
    let src = setLayoutPos(BASE, "Population", 120, -40);
    src = renameSymbol(src, "Population", "Pop");
    expect(src).toMatch(/# @pos Pop 120 -40/);
    expect(src).not.toMatch(/# @pos Population/);
    expect(readLayout(src).get("Pop")).toEqual({ x: 120, y: -40 });
  });

  it("does not rename substrings or unrelated tokens", () => {
    const src = "param rate = 1\nparam rateLimit = 2\nstock S = rate\nsim dt=1 to=2\n";
    const out = renameSymbol(src, "rate", "speed");
    expect(out).toContain("param speed = 1");
    expect(out).toContain("param rateLimit = 2"); // untouched
    expect(out).toContain("stock S = speed");
  });
});

describe("model-build: delete + references", () => {
  it("deleteSymbol removes a stock and its change() line", () => {
    let src = addVar(BASE, "flow", "growth", "birthRate * Population");
    src = setRate(src, "Population", "growth");
    const out = deleteSymbol(src, "Population");
    expect(out).not.toMatch(/^\s*stock Population\b/m);
    expect(out).not.toMatch(/change\(Population\)/);
  });

  it("referencesTo finds usages outside the declaration", () => {
    let src = addVar(BASE, "flow", "growth", "birthRate * Population");
    src = setRate(src, "Population", "growth");
    // birthRate is used by `growth`; carrying is unused
    expect(referencesTo(src, "birthRate").length).toBeGreaterThan(0);
    expect(referencesTo(src, "carrying")).toEqual([]);
    // Population is referenced by growth's expression and the plot line
    expect(referencesTo(src, "Population").length).toBeGreaterThan(0);
  });
});

describe("model-build: layout positions (# @pos)", () => {
  it("round-trips a position through a comment the parser ignores", () => {
    const out = setLayoutPos(BASE, "Population", 120.4, -40.8);
    expect(out).toMatch(/# @pos Population 120 -41/);
    // the position comment must not change the parsed model
    const m = parseModel(out);
    expect(m.stocks.map((s) => s.name)).toContain("Population");
    expect(readLayout(out).get("Population")).toEqual({ x: 120, y: -41 });
  });

  it("updates an existing position in place rather than duplicating", () => {
    let s = setLayoutPos(BASE, "Population", 10, 20);
    s = setLayoutPos(s, "Population", 30, 40);
    expect(s.match(/# @pos Population/g)?.length).toBe(1);
    expect(readLayout(s).get("Population")).toEqual({ x: 30, y: 40 });
  });

  it("deleteSymbol also removes the node's stored position", () => {
    const s = setLayoutPos(addStock(BASE, "Tmp", "1"), "Tmp", 5, 5);
    expect(readLayout(s).has("Tmp")).toBe(true);
    expect(readLayout(deleteSymbol(s, "Tmp")).has("Tmp")).toBe(false);
  });
});

describe("model-build: naming helpers", () => {
  it("declaredNames lists every bound name", () => {
    expect([...declaredNames(BASE)].sort()).toEqual(["Population", "birthRate", "carrying"]);
  });

  it("uniqueName avoids collisions", () => {
    expect(uniqueName(BASE, "growth")).toBe("growth");
    const once = addVar(BASE, "flow", "growth", "1");
    expect(uniqueName(once, "growth")).toBe("growth2");
    expect(uniqueName(addVar(once, "flow", "growth2", "1"), "growth")).toBe("growth3");
  });
});
