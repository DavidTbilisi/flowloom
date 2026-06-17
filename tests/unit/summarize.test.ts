import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { simulate, summarizeRun, resolveMetric } from "../../src/engine/index.js";
import { EXAMPLES } from "../../src/examples/index.js";

// Contract: the behaviour classifier is deterministic, so we pin its labels
// against the embedded examples whose dynamics are known closed-form. If the
// heuristics drift, these fail — the labels are part of what an agent reads.

const run = (name: string) => summarizeRun(simulate(parseModel(EXAMPLES.find((e) => e.name === name)!.source)));
const series = (name: string, s: string) => run(name).series.find((x) => x.name === s)!;

describe("behaviour classification", () => {
  it("logistic growth is an S-curve that settles", () => {
    const p = series("Logistic growth", "Population");
    expect(p.behavior).toBe("s-shaped");
    expect(p.monotonic).toBe("up");
    expect(p.settled).toBe(true);
  });

  it("coffee cooling relaxes to a steady value", () => {
    const t = series("Coffee cooling", "Temp");
    expect(["decay", "equilibrium"]).toContain(t.behavior);
    expect(t.monotonic).toBe("down");
    expect(t.settled).toBe(true);
  });

  it("compound savings grows without settling", () => {
    const b = series("Compound savings", "Balance");
    expect(b.behavior).toBe("growth");
    expect(b.settled).toBe(false);
  });

  it("a fixed contribution reads as constant", () => {
    expect(series("Compound savings", "saving").behavior).toBe("constant");
  });

  it("predator–prey sustains an oscillation", () => {
    const prey = series("Predator–prey", "Prey");
    expect(prey.behavior).toBe("oscillation-sustained");
    expect(prey.monotonic).toBe("none");
    expect(prey.settled).toBe(false);
    expect(prey.peaks!).toBeGreaterThanOrEqual(2);
    expect(prey.period!).toBeGreaterThan(0);
  });

  it("an inventory step response overshoots, then settles", () => {
    const inv = series("Inventory + delay", "Inventory");
    expect(["overshoot", "oscillation-damped"]).toContain(inv.behavior);
    expect(inv.settled).toBe(true);
  });

  it("the SIR infected curve rises to a single peak (overshoot)", () => {
    const i = series("SIR epidemic", "I");
    expect(["overshoot", "oscillation-damped"]).toContain(i.behavior);
    expect(i.max.value).toBeGreaterThan(i.start);
    expect(i.max.value).toBeGreaterThan(i.final);
  });
});

describe("summary fields", () => {
  it("captures start/final/min/max with their times", () => {
    const p = series("Logistic growth", "Population");
    expect(p.start).toBeCloseTo(5, 6);
    expect(p.min.value).toBeCloseTo(5, 6);
    expect(p.min.t).toBe(0);
    expect(p.max.value).toBeGreaterThan(900);
    expect(p.final).toBeGreaterThan(900);
  });

  it("honors an explicit series selection", () => {
    const res = simulate(parseModel(EXAMPLES.find((e) => e.name === "Logistic growth")!.source));
    const sum = summarizeRun(res, ["Population"]);
    expect(sum.series.map((s) => s.name)).toEqual(["Population"]);
  });
});

describe("resolveMetric", () => {
  // X(t) = 2t under Euler dt=1 → exact ramp 0,2,…,20 over t=0..10.
  const ramp = simulate(parseModel(`stock X = 0\nflow rate = 2\nd(X) = rate\nsim dt=1 to=10 method=euler`));

  it("reduces a run to a scalar by spec", () => {
    expect(resolveMetric(ramp, "final:X")).toBeCloseTo(20, 6);
    expect(resolveMetric(ramp, "max:X")).toBeCloseTo(20, 6);
    expect(resolveMetric(ramp, "min:X")).toBeCloseTo(0, 6);
    expect(resolveMetric(ramp, "mean:X")).toBeCloseTo(10, 6);
    expect(resolveMetric(ramp, "at:5:X")).toBeCloseTo(10, 6);
    expect(resolveMetric(ramp, "time-to-peak:X")).toBeCloseTo(10, 6);
  });

  it("interpolates between samples for at:<t>", () => {
    expect(resolveMetric(ramp, "at:4.5:X")).toBeCloseTo(9, 6);
  });

  it("resolves settle-time when a series converges", () => {
    const coffee = simulate(parseModel(EXAMPLES.find((e) => e.name === "Coffee cooling")!.source));
    expect(resolveMetric(coffee, "settle-time:Temp")).toBeGreaterThan(0);
  });

  it("throws on an unknown series, op, or non-settling series", () => {
    expect(() => resolveMetric(ramp, "final:Nope")).toThrow(/no series named/);
    expect(() => resolveMetric(ramp, "bogus:X")).toThrow(/unknown metric/);
    expect(() => resolveMetric(ramp, "settle-time:X")).toThrow(/never settles/);
  });
});
