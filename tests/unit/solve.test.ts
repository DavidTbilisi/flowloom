import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { solveParam } from "../../src/engine/index.js";
import { EXAMPLES } from "../../src/examples/index.js";

// Contract: solveParam inverts a model — it finds the knob value that drives a
// metric to a target — by bisection, and always returns the closest value tried.

const logistic = () => parseModel(EXAMPLES.find((e) => e.name === "Logistic growth")!.source);

describe("solveParam", () => {
  it("finds the knob value that hits the target (auto-bracket)", async () => {
    // logistic saturates at carrying, so final:Population ≈ carrying.
    const r = await solveParam(logistic(), "carrying", "final:Population", 1500);
    expect(r.converged).toBe(true);
    expect(r.value).toBeCloseTo(1500, 1);
    expect(r.achieved).toBeCloseTo(1500, 2);
    expect(r.error).toBeLessThan(1e-3);
  });

  it("inverts a nonlinear metric (SIR peak)", async () => {
    const sir = parseModel(EXAMPLES.find((e) => e.name === "SIR epidemic")!.source);
    const r = await solveParam(sir, "beta", "max:I", 300);
    expect(r.converged).toBe(true);
    expect(r.achieved).toBeCloseTo(300, 1);
  });

  it("honors an explicit bracket", async () => {
    const r = await solveParam(logistic(), "carrying", "final:Population", 800, { bracket: [100, 5000] });
    expect(r.converged).toBe(true);
    expect(r.value).toBeCloseTo(800, 1);
  });

  it("reports non-convergence with the closest value and a note", async () => {
    const r = await solveParam(logistic(), "birthRate", "final:Population", 1e9);
    expect(r.converged).toBe(false);
    expect(r.note).toMatch(/bracket|monotonic|reach/);
    expect(Number.isFinite(r.value)).toBe(true);
  });

  it("flags a bracket that doesn't straddle the target", async () => {
    const r = await solveParam(logistic(), "carrying", "final:Population", 1500, { bracket: [100, 200] });
    expect(r.converged).toBe(false);
    expect(r.note).toMatch(/straddle/);
  });

  it("does not mutate the caller's model", async () => {
    const m = logistic();
    await solveParam(m, "carrying", "final:Population", 1234);
    // carrying is still its original literal in the parsed model.
    const carrying = m.varIndex.get("carrying")!.expr;
    expect(carrying).toMatchObject({ kind: "num", value: 1000 });
  });
});
