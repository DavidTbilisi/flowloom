import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { simulate } from "../../src/engine/index.js";
import { u01, runif, rnorm } from "../../src/engine/rng.js";

const finalOf = (src: string, name: string) => simulate(parseModel(src)).series.get(name)!.at(-1)!;

const WALK = (seed: number) => `
stock Walk = 0
flow shock = random_normal(0, 1)
d(Walk) = shock
sim dt=0.5 to=50 method=rk4 seed=${seed}`;

describe("rng primitives", () => {
  it("u01 is pure and in [0,1)", () => {
    const a = u01(7, 3, 0);
    expect(a).toBe(u01(7, 3, 0)); // deterministic
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
  });

  it("decorrelates seed, step, and draw index", () => {
    expect(u01(1, 0, 0)).not.toBe(u01(2, 0, 0));
    expect(u01(1, 0, 0)).not.toBe(u01(1, 1, 0));
    expect(u01(1, 0, 0)).not.toBe(u01(1, 0, 1));
  });

  it("runif/rnorm shift and scale the base draw", () => {
    const u = u01(5, 5, 0);
    expect(runif(5, 5, 0, 10, 20)).toBeCloseTo(10 + 10 * u, 12);
    // rnorm with sd=0 collapses to the mean
    expect(rnorm(5, 5, 0, 3, 0)).toBe(3);
  });
});

describe("randomness in a simulation", () => {
  it("is reproducible for a fixed seed", () => {
    expect(finalOf(WALK(42), "Walk")).toBe(finalOf(WALK(42), "Walk"));
  });

  it("differs across seeds", () => {
    expect(finalOf(WALK(1), "Walk")).not.toBe(finalOf(WALK(2), "Walk"));
  });

  it("defaults to a reproducible seed when none is given", () => {
    const a = finalOf(`stock W=0\nflow s=random()\nd(W)=s\nsim dt=1 to=20`, "W");
    const b = finalOf(`stock W=0\nflow s=random()\nd(W)=s\nsim dt=1 to=20`, "W");
    expect(a).toBe(b);
  });

  it("holds the draw constant across RK4 sub-stages", () => {
    // If random() were resampled per derivative eval, RK4's four samples per step
    // would differ and a constant-rate integral would drift from N·draw·dt. Here
    // d(X)=random() with a single step means X(dt) == draw·dt exactly.
    const r = simulate(parseModel(`stock X=0\nflow s=random()\nd(X)=s\nsim dt=1 to=1 method=rk4 seed=99`));
    const x = r.series.get("X")!;
    expect(x[1]! - x[0]!).toBeCloseTo(u01(99, 0, 0), 12);
  });

  it("samples random_uniform within range", () => {
    const r = simulate(parseModel(`stock S=0\nflow u=random_uniform(2,5)\naux v=u\nd(S)=0\nsim dt=1 to=200 seed=7`));
    const vs = r.series.get("v")!;
    expect(Math.min(...vs)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...vs)).toBeLessThan(5);
  });
});
