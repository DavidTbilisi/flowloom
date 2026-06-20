import { describe, it, expect } from "vitest";
import { handlers } from "../../src/mcp.js";

// Smoke test: exercise the MCP tool handlers in-process (no transport). They are
// thin wrappers over the engine, so we just assert the shapes agents will see.

const SRC = `stock Population = 5
param birthRate = 0.7
flow growth = birthRate * Population
d(Population) = growth
sim dt=0.1 to=10 method=rk4
plot Population`;

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

describe("mcp handlers", () => {
  it("flow_check reports ok with counts", () => {
    const r = parse(handlers.flow_check({ model: SRC }));
    expect(r.ok).toBe(true);
    expect(r.stocks).toBe(1);
  });

  it("flow_check surfaces structured diagnostics on a bad model", () => {
    const r = parse(handlers.flow_check({ model: "flow x = undefinedThing" }));
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]).toHaveProperty("line");
    expect(r.diagnostics[0]).toHaveProperty("message");
  });

  it("flow_check includes lint warnings on an ok model", () => {
    const r = parse(handlers.flow_check({ model: "stock X = 1\nparam unused = 9\nd(X) = 1" }));
    expect(r.ok).toBe(true);
    expect(r.lint.some((d: { message: string }) => /never used/.test(d.message))).toBe(true);
  });

  it("flow_lint reports non-fatal warnings", () => {
    const r = parse(handlers.flow_lint({ model: "stock X = 1\nstock Frozen = 5\nd(X) = 1" }));
    expect(r.warnings.some((d: { message: string }) => /has no change\(Frozen\) rate/.test(d.message))).toBe(true);
  });

  it("flow_run returns t and the requested series", async () => {
    const r = parse(await handlers.flow_run({ model: SRC, plot: ["Population"] }));
    expect(r.t.length).toBeGreaterThan(1);
    expect(r.series.Population.length).toBe(r.t.length);
    expect(r.series.Population[0]).toBe(5);
  });

  it("flow_run honors a --set override", async () => {
    const base = parse(await handlers.flow_run({ model: SRC, plot: ["Population"] }));
    const set = parse(await handlers.flow_run({ model: SRC, plot: ["Population"], set: ["Population=50"] }));
    expect(set.series.Population[0]).toBe(50);
    expect(set.series.Population[0]).not.toBe(base.series.Population[0]);
  });

  it("flow_summary classifies each series instead of dumping arrays", async () => {
    const r = parse(await handlers.flow_summary({ model: SRC, plot: ["Population"] }));
    expect(r.series[0].name).toBe("Population");
    expect(r.series[0].behavior).toBe("growth");
    expect(r.series[0]).not.toHaveProperty("t");
  });

  it("flow_sweep returns a response curve of one knob", async () => {
    const r = parse(await handlers.flow_sweep({ model: SRC, param: "birthRate", from: 0.1, to: 0.5, steps: 3, metric: "final:Population" }));
    expect(r.points).toHaveLength(3);
    expect(r.points[0].value).toBeCloseTo(0.1, 9);
    // higher growth rate ⇒ larger final population
    expect(r.points[2].metric).toBeGreaterThan(r.points[0].metric);
  });

  it("flow_sensitivity ranks params", async () => {
    const r = parse(await handlers.flow_sensitivity({ model: SRC, metric: "final:Population" }));
    expect(r.rows[0].param).toBe("birthRate");
    expect(r.rows[0]).toHaveProperty("delta");
  });

  it("flow_solve finds the knob value that hits a target", async () => {
    // final:Population grows with birthRate; solve for a reachable target.
    const r = parse(await handlers.flow_solve({ model: SRC, param: "birthRate", metric: "final:Population", target: 20 }));
    expect(r.converged).toBe(true);
    expect(r.achieved).toBeCloseTo(20, 2);
    expect(r).toHaveProperty("value");
  });

  it("flow_montecarlo returns percentile bands for a stochastic model", async () => {
    const src = `stock Walk = 0
flow shock = random_normal(0, 1)
d(Walk) = shock
sim dt=1 to=20 method=rk4 seed=1
plot Walk`;
    const r = parse(await handlers.flow_montecarlo({ model: src, runs: 50, seed: 1 }));
    expect(r.runs).toBe(50);
    const walk = r.series.find((s: { name: string }) => s.name === "Walk");
    expect(walk.final.p05).toBeLessThanOrEqual(walk.final.p50);
    expect(walk.final.p50).toBeLessThanOrEqual(walk.final.p95);
    expect(walk.trajectory.t[0]).toBe(0);
  });

  it("flow_describe returns the model structure", () => {
    const r = parse(handlers.flow_describe({ model: SRC }));
    expect(r.stocks[0].name).toBe("Population");
    expect(r.rates[0]).toEqual({ stock: "Population", expr: "growth" });
  });

  it("flow_explain returns prose", () => {
    const r = handlers.flow_explain({ model: SRC });
    expect(r.content[0]!.text).toMatch(/feedback loop/);
  });

  it("flow_examples lists then fetches by name", () => {
    const list = parse(handlers.flow_examples({}));
    expect(Array.isArray(list)).toBe(true);
    const one = parse(handlers.flow_examples({ name: list[0].name }));
    expect(one.source).toBeTruthy();
  });
});
