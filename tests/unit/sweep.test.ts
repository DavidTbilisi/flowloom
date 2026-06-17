import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { simulate, sweepParam, sensitivity } from "../../src/engine/index.js";
import { EXAMPLES } from "../../src/examples/index.js";

// Contract: a sweep/sensitivity turns a model into a function of one knob,
// cloning per run so points never contaminate each other or the caller's model.

const logistic = () => parseModel(EXAMPLES.find((e) => e.name === "Logistic growth")!.source);

describe("sweepParam", () => {
  it("traces a response curve and reports the base value", async () => {
    const r = await sweepParam(logistic(), "carrying", { from: 500, to: 2000, steps: 4 }, "final:Population");
    expect(r.base).toBeCloseTo(1000, 6);
    expect(r.points.map((p) => p.value)).toEqual([500, 1000, 1500, 2000]);
    // logistic saturates at its carrying capacity, so final ≈ carrying and rises with it.
    const ys = r.points.map((p) => p.metric);
    expect(ys[0]!).toBeCloseTo(500, 0);
    expect(ys[3]!).toBeCloseTo(2000, 0);
    for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeGreaterThan(ys[i - 1]!);
  });

  it("a single step samples just `from`", async () => {
    const r = await sweepParam(logistic(), "carrying", { from: 800, to: 800, steps: 1 }, "final:Population");
    expect(r.points).toHaveLength(1);
    expect(r.points[0]!.value).toBe(800);
  });

  it("does not mutate the caller's model", async () => {
    const m = logistic();
    const before = simulate(m).series.get("Population")!.at(-1)!;
    await sweepParam(m, "carrying", { from: 100, to: 5000, steps: 5 }, "final:Population");
    const after = simulate(m).series.get("Population")!.at(-1)!;
    expect(after).toBeCloseTo(before, 9);
  });
});

describe("sensitivity", () => {
  it("ranks params by how much they move the metric", async () => {
    const r = await sensitivity(logistic(), [], "final:Population", 0.1);
    // final ≈ carrying, so carrying dominates and birthRate barely matters.
    expect(r.rows.map((x) => x.param)).toEqual(["carrying", "birthRate"]);
    expect(Math.abs(r.rows[0]!.delta)).toBeGreaterThan(Math.abs(r.rows[1]!.delta));
    const carrying = r.rows[0]!;
    expect(carrying.base).toBeCloseTo(1000, 6);
    expect(carrying.high).toBeGreaterThan(carrying.low);
  });

  it("honors an explicit param list", async () => {
    const r = await sensitivity(logistic(), ["birthRate"], "final:Population", 0.1);
    expect(r.rows.map((x) => x.param)).toEqual(["birthRate"]);
  });
});
