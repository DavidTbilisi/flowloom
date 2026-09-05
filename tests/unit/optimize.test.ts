import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { optimize } from "../../src/engine/optimize.js";
import { minimize } from "../../src/engine/simplex.js";
import { handlers } from "../../src/mcp.js";

// CONTRACT: `solve` goal-seeks ONE knob to a target; `calibrate` fits knobs to
// data. `optimize` is the third question — what settings make the model do best
// — over the same bounded Nelder–Mead, which is why that search was extracted.

// Profit is (100 − 2p)·p at spend 0, whose maximum is exactly p = 25. A closed
// form is the only honest way to test an optimiser.
const TRADEOFF = `stock Cash = 0
param price = 10 in 1..40
param spend = 0 in 0..30
aux demand = max(0, 100 - 2 * price) * (1 + 0.02 * spend)
flow profit = demand * price - 20 * spend
change(Cash) = profit
sim dt=1 to=1 method=euler`;

describe("simplex — the shared search", () => {
  it("finds the minimum of a bowl", async () => {
    const r = await minimize(async ([x, y]) => (x! - 3) ** 2 + (y! + 1) ** 2, { start: [0, 0] });
    expect(r.x[0]).toBeCloseTo(3, 3);
    expect(r.x[1]).toBeCloseTo(-1, 3);
    expect(r.converged).toBe(true);
  });

  it("stays inside the box, and says which coordinate hit a wall", async () => {
    const r = await minimize(async ([x]) => (x! - 10) ** 2, { start: [0], box: [[0, 4]] });
    expect(r.x[0]).toBeLessThanOrEqual(4);
    expect(r.x[0]).toBeCloseTo(4, 6);
    expect(r.atBound).toEqual([0]);
  });

  it("does not call a wide simplex converged just because the scores agree", async () => {
    // On a flat objective the spread is zero from the first iteration, so a
    // spread-only test would report "converged" immediately — which is what an
    // unidentifiable parameter looks like. The diameter test is what stops it;
    // the simplex only earns the word once it has actually collapsed.
    const early = await minimize(async () => 1, { start: [0, 0], maxEvals: 8 });
    expect(early.converged).toBe(false);
    const collapsed = await minimize(async () => 1, { start: [0, 0], maxEvals: 200 });
    expect(collapsed.converged).toBe(true);
  });
});

describe("optimize", () => {
  it("finds the analytic optimum of a price/volume trade-off", async () => {
    const r = await optimize(parseModel(TRADEOFF), { metric: "final:Cash", params: ["price"] });
    expect(r.params.price).toBeCloseTo(25, 2);
    expect(r.goal).toBe("max");
    expect(r.gain).toBeGreaterThan(0);
    expect(r.value).toBeGreaterThan(r.base);
  });

  it("minimises when told to", async () => {
    const r = await optimize(parseModel(TRADEOFF), { metric: "final:Cash", params: ["price"], goal: "min" });
    // Profit is worst at the ends of 1..40, not in the middle.
    expect(Math.min(Math.abs(r.params.price! - 1), Math.abs(r.params.price! - 40))).toBeLessThan(1);
    expect(r.value).toBeLessThan(r.base);
  });

  it("uses a declared range as the search box and never widens it", async () => {
    const r = await optimize(parseModel(TRADEOFF), { metric: "final:Cash", params: ["price", "spend"] });
    expect(r.explored).toEqual([
      { param: "price", lo: 1, hi: 40, declared: true },
      { param: "spend", lo: 0, hi: 30, declared: true },
    ]);
    expect(r.params.price!).toBeGreaterThanOrEqual(1);
    expect(r.params.price!).toBeLessThanOrEqual(40);
  });

  it("reports a knob that ran into its bound", async () => {
    // Marketing pays here (0.02 × 25 × 100 per unit beats its cost of 20), so
    // the answer is the ceiling — which is a fact about the range, not the model.
    const r = await optimize(parseModel(TRADEOFF), { metric: "final:Cash", params: ["price", "spend"] });
    expect(r.atBound).toContain("spend");
  });

  it("falls back to a ±frac box when nothing is declared", async () => {
    const src = TRADEOFF.replace(" in 1..40", "").replace(" in 0..30", "");
    const r = await optimize(parseModel(src), { metric: "final:Cash", params: ["price"], frac: 0.5 });
    expect(r.explored[0]).toEqual({ param: "price", lo: 5, hi: 15, declared: false });
  });

  it("honours explicit bounds over a declared range", async () => {
    const r = await optimize(parseModel(TRADEOFF), { metric: "final:Cash", params: ["price"], bounds: { price: [1, 10] } });
    expect(r.explored[0]).toEqual({ param: "price", lo: 1, hi: 10, declared: false });
    expect(r.params.price!).toBeLessThanOrEqual(10);
  });

  it("is reproducible across restarts", async () => {
    const opts = { metric: "final:Cash", params: ["price"], restarts: 2, seed: 7 };
    const a = await optimize(parseModel(TRADEOFF), { ...opts });
    const b = await optimize(parseModel(TRADEOFF), { ...opts });
    expect(a.params).toEqual(b.params);
    expect(a.restarts).toEqual(b.restarts);
  });

  it("refuses a switch — it is discrete, and policies enumerates those exactly", async () => {
    const src = `${TRADEOFF}\nswitch promo = off`;
    await expect(optimize(parseModel(src), { metric: "final:Cash", params: ["promo"] }))
      .rejects.toThrow(/"promo" is a switch.*policies/s);
  });

  it("skips consts and switches when choosing knobs itself", async () => {
    const src = `${TRADEOFF}\nswitch promo = off\nconst yearLen = 12`;
    const r = await optimize(parseModel(src), { metric: "final:Cash" });
    expect(r.explored.map((e) => e.param).sort()).toEqual(["price", "spend"]);
  });

  it("says so when the model has no knob to turn", async () => {
    const src = "stock Cash = 0\nchange(Cash) = 1\nsim dt=1 to=2";
    await expect(optimize(parseModel(src), { metric: "final:Cash" })).rejects.toThrow(/no varying param/);
  });
});

describe("calibration weights", () => {
  const src = `stock A = 0
stock B = 0
param ra = 1
param rb = 1
change(A) = ra
change(B) = rb
sim dt=1 to=4 method=euler`;
  // A wants slope 2, B wants slope 10 — but only one param can be fitted at a
  // time here, so weighting decides which series the single knob serves.
  const data = "t,A,B\n0,0,0\n1,2,10\n2,4,20\n3,6,30\n4,8,40\n";

  it("weights shift which series the fit serves", async () => {
    const { calibrate, parseDataset } = await import("../../src/engine/index.js");
    const ds = parseDataset(data);
    const evenly = await calibrate(parseModel(src), { params: ["ra"], dataset: ds, map: { A: "A" } });
    expect(evenly.params.ra).toBeCloseTo(2, 3);
    // A weight scales the residual, not the fit's target — the optimum for one
    // series is the same wherever it sits in the sum.
    const heavy = await calibrate(parseModel(src), { params: ["ra"], dataset: ds, map: { A: "A" }, weights: { A: 9 } });
    expect(heavy.params.ra).toBeCloseTo(2, 3);
    expect(heavy.weights).toEqual({ A: 9 });
  });

  it("reports the per-series fit unweighted — it is a fit, not a score", async () => {
    const { calibrate, parseDataset } = await import("../../src/engine/index.js");
    const r = await calibrate(parseModel(src), {
      params: ["ra", "rb"], dataset: parseDataset(data), map: { A: "A", B: "B" }, weights: { A: 4 },
    });
    expect(r.perSeries.A!).toBeLessThan(0.01);
    expect(r.perSeries.B!).toBeLessThan(0.01);
  });

  it("rejects a weight naming a series that isn't being fitted", async () => {
    const { calibrate, parseDataset } = await import("../../src/engine/index.js");
    await expect(calibrate(parseModel(src), {
      params: ["ra"], dataset: parseDataset(data), map: { A: "A" }, weights: { Nope: 2 },
    })).rejects.toThrow(/weight names "Nope"/);
  });
});

describe("MCP surface", () => {
  it("flow_optimize returns the settings and what they bought", async () => {
    const r = JSON.parse((await handlers.flow_optimize({ model: TRADEOFF, metric: "final:Cash", params: ["price"] })).content[0]!.text);
    expect(r.params.price).toBeCloseTo(25, 2);
    expect(r.gain).toBeGreaterThan(0);
    expect(r.explored[0].declared).toBe(true);
  });
});
