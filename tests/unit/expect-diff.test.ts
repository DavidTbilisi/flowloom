import { describe, it, expect } from "vitest";
import { parseModel, ModelError } from "../../src/lang/index.js";
import { runExpects, judge, diffModels, describeModel, explainModel, lintModel } from "../../src/engine/index.js";
import { handlers } from "../../src/mcp.js";

// CONTRACT: `expect` lines are the model's own tests — a number that leaves the
// model (cited on a page, in a report) gets a guard in the text it came from.
// `diff` is the refactor verdict: every series under every shared scenario plus
// the live-loop census, so an edit that keeps the numbers but changes the
// analysis (the phantom-self-loop regression) is caught, not just one that
// moves a number.

const SRC = `stock Cash = 100
param income = 30
switch save = off
flow spend = if(save, 10, 20)
change(Cash) = income - spend
scenario thrifty save=on
scenario broke income=5
expect final:Cash == 200
expect final:Cash == 200.4 ± 0.5
expect thrifty final:Cash == 300 ± 1%      # saving doubles the gain
expect broke min:Cash < 100
expect loops:total == 0
expect broke loops:active >= 0
sim dt=1 to=10 method=map`;

describe("expect lines", () => {
  it("parse: optional scenario, metric, comparison, value, ± tolerance (absolute or %)", () => {
    const m = parseModel(SRC);
    expect(m.expects).toHaveLength(6);
    expect(m.expects[0]).toMatchObject({ metric: "final:Cash", op: "==", value: 200 });
    expect(m.expects[0]!.scenario).toBeUndefined();
    expect(m.expects[1]!.tol).toEqual({ value: 0.5, pct: false });
    expect(m.expects[2]).toMatchObject({ scenario: "thrifty", tol: { value: 0.01, pct: true }, doc: "saving doubles the gain" });
    expect(m.expects[3]).toMatchObject({ scenario: "broke", metric: "min:Cash", op: "<", value: 100 });
    // `base` names the model itself
    expect(parseModel(`stock S = 1\nchange(S) = 1\nexpect base final:S > 0`).expects[0]!.scenario).toBeUndefined();
  });

  it("parse errors teach the grammar: unknown scenario, unknown metric, a param is not a series, bad tolerance", () => {
    const base = "stock S = 1\nparam k = 2\nchange(S) = k\nscenario fast k=4\n";
    const err = (line: string) => { try { parseModel(base + line); } catch (e) { return (e as ModelError).diagnostics.map((d) => d.message).join("\n"); } return ""; };
    expect(err("expect fasst final:S > 0")).toMatch(/no scenario named 'fasst' — did you mean 'fast'/);
    expect(err("expect finale:S > 0")).toMatch(/unknown metric 'finale:' — did you mean 'final:'/);
    expect(err("expect final:k > 0")).toMatch(/a param is not a series/);
    expect(err("expect final:Z > 0")).toMatch(/no stock, flow or aux named 'Z'/);
    expect(err("expect final:S ~ 0")).toMatch(/comparison must be one of/);
    expect(err("expect final:S == 1 ± x")).toMatch(/tolerance must be a non-negative number/);
    expect(err("expect final:S == 1 ± 5% extra")).toMatch(/unexpected 'extra'/);
    expect(err("expect loops:alive == 1")).toMatch(/loops:<what> takes active\|total/);
    expect(err("expect at:x:S == 1")).toMatch(/malformed/);
    // a tolerance after a non-== comparison is a warning, not an error
    expect(lintModel(parseModel(base + "expect final:S > 1 ± 2")).length).toBe(0); // parse-time warning lives in diagnostics
    expect(parseModel(base + "expect final:S > 1 ± 2").diagnostics.some((d) => /only applies to ==/.test(d.message))).toBe(true);
  });

  it("judge: == is exact unless given a tolerance; the others are plain comparisons", () => {
    const e = (op: "<" | "<=" | ">" | ">=" | "==", value: number, tol?: { value: number; pct: boolean }) => ({ metric: "final:x", op, value, loc: { line: 1, col: 1 }, ...(tol ? { tol } : {}) });
    expect(judge(e("==", 200), 200.0001).pass).toBe(false);
    expect(judge(e("==", 200, { value: 0.5, pct: false }), 200.4)).toMatchObject({ pass: true, off: expect.closeTo(0.4, 9), allowed: 0.5 });
    expect(judge(e("==", 200, { value: 0.01, pct: true }), 201.9).pass).toBe(true);
    expect(judge(e("==", 200, { value: 0.01, pct: true }), 202.1).pass).toBe(false);
    expect(judge(e(">=", 0), 0).pass).toBe(true);
    expect(judge(e(">", 0), 0).pass).toBe(false);
    expect(judge(e("<", 1), NaN).pass).toBe(false);
  });

  it("runExpects: one run per scenario, results in source order, loop metrics included", async () => {
    const r = await runExpects(parseModel(SRC));
    expect(r.scenarios.sort()).toEqual(["base", "broke", "thrifty"]);
    expect(r.results.map((x) => x.pass)).toEqual([true, true, true, true, true, true]);
    expect(r.results[0]!.actual).toBe(200); // 100 + 10 × 10
    expect(r.results[2]!.actual).toBe(300);
    expect(r.results[3]!.actual).toBe(-50); // broke: 100 − 15 × 10
    expect(r.results.map((x) => x.expect.loc.line)).toEqual([8, 9, 10, 11, 12, 13]);
    // a failing == says how far off
    const bad = await runExpects(parseModel(SRC.replace("expect final:Cash == 200\n", "expect final:Cash == 199.5\n")));
    expect(bad.failed).toBe(1);
    expect(bad.results[0]).toMatchObject({ pass: false, off: 0.5, allowed: 0 });
    // restricting to scenarios
    const only = await runExpects(parseModel(SRC), ["thrifty"]);
    expect(only.results).toHaveLength(1);
  });

  it("describe / explain / MCP carry the expects", async () => {
    const d = describeModel(parseModel(SRC));
    expect(d.expects).toHaveLength(6);
    expect(d.expects[2]).toMatchObject({ scenario: "thrifty", tol: { value: 0.01, pct: true } });
    expect(explainModel(parseModel(SRC))).toMatch(/Expectations \(6/);
    const r = JSON.parse((await handlers.flow_test({ model: SRC })).content[0]!.text);
    expect(r.passed).toBe(6);
    expect(r.results[2]).toMatchObject({ line: 10, scenario: "thrifty", pass: true });
    await expect(handlers.flow_test({ model: "stock S = 1\nchange(S) = 1" })).rejects.toThrow(/no `expect` lines/);
  });
});

describe("diff", () => {
  const A = `stock S = 10\nparam r = 0.1\nflow g = r * S\nchange(S) = g\nscenario fast r=0.2\nscenario slow r=0.05\nsim dt=1 to=10 method=euler`;

  it("an equivalent rewrite is identical: numbers and live loops, structure noted", async () => {
    // euler with `(next − S) / dt` vs map with `next − S`: same numbers, same loops
    const eu = `stock S = 10\nparam r = 0.1\naux next = S * (1 + r)\nchange(S) = (next - S) / dt\nscenario fast r=0.2\nsim dt=1 to=10 method=euler`;
    const mp = eu.replace("(next - S) / dt", "next - S").replace("method=euler", "method=map");
    const d = await diffModels(parseModel(eu), parseModel(mp));
    expect(d.identical).toBe(true);
    expect(d.structureChanged).toBe(true);
    expect(d.structure.settings).toEqual([{ key: "method", a: "euler", b: "map" }]);
    expect(d.scenarios.map((s) => s.scenario)).toEqual(["base", "fast"]);
    expect(d.scenarios[0]!.changed).toEqual([]);
    expect(d.scenarios[0]!.loops).toMatchObject({ a: { active: 1 }, b: { active: 1 }, activeOnlyA: [], activeOnlyB: [] });
  });

  it("a moved number is reported per series with where it moved most; structure lists what changed", async () => {
    const B = A.replace("param r = 0.1", "param r = 0.12").replace("scenario slow r=0.05", "scenario slow r=0.05\nscenario off r=0\naux h = S / 2");
    const d = await diffModels(parseModel(A), parseModel(B));
    expect(d.identical).toBe(false);
    expect(d.structure.values).toEqual([{ name: "r", a: 0.1, b: 0.12 }]);
    expect(d.structure.scenariosOnlyB).toEqual(["off"]);
    expect(d.structure.varsOnlyB).toEqual(["h"]);
    const base = d.scenarios.find((s) => s.scenario === "base")!;
    expect(base.changed.map((c) => c.name).sort()).toEqual(["S", "g"]);
    expect(base.changed[0]!.at).toBe(10); // compounding: the gap is widest at the end
    expect(base.onlyB).toEqual(["h"]);
    // the scenarios that pin r agree on both sides
    expect(d.scenarios.find((s) => s.scenario === "fast")!.changed).toEqual([]);
  });

  it("a live loop that appears with the numbers unchanged still fails the verdict", async () => {
    // B adds an inactive loop (a gate that never opens) — not a difference; then a live one
    const gated = A.replace("change(S) = g", "switch brake = off\nflow b = if(brake, 0.5 * S, 0)\nchange(S) = g - b");
    const d1 = await diffModels(parseModel(A), parseModel(gated));
    expect(d1.identical).toBe(true);
    expect(d1.scenarios[0]!.loops).toMatchObject({ a: { total: 1, active: 1 }, b: { total: 2, active: 1 } });
    const live = A.replace("change(S) = g", "flow b = 0 * S + 0.0000000001 * S\nchange(S) = g - b"); // numerically ≈ same, structurally live
    const d2 = await diffModels(parseModel(A), parseModel(live), { tol: 1e-6 });
    expect(d2.scenarios[0]!.changed).toEqual([]);
    expect(d2.scenarios[0]!.loops!.activeOnlyB).toEqual(["S → b → S"]);
    expect(d2.identical).toBe(false);
  });

  it("grids that differ compare on the shared times; an unknown scenario is an error; --no-loops skips the census", async () => {
    const fine = A.replace("sim dt=1", "sim dt=0.5");
    const d = await diffModels(parseModel(A), parseModel(fine), { loops: false });
    expect(d.scenarios[0]!.steps).toEqual([11, 21]);
    expect(d.scenarios[0]!.shared).toBe(11);
    expect(d.scenarios[0]!.loops).toBeUndefined();
    expect(d.scenarios[0]!.changed.length).toBeGreaterThan(0); // euler at a finer step is a different number
    await expect(diffModels(parseModel(A), parseModel(A), { scenarios: ["nope"] })).rejects.toThrow(/not declared on both sides/);
    const r = JSON.parse((await handlers.flow_diff({ model: A, other: A })).content[0]!.text);
    expect(r.identical).toBe(true);
    expect(r.structureChanged).toBe(false);
  });
});
