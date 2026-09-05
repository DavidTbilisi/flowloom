import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { simulate, compile, buildPlan, tsBackend, runPlan } from "../../src/engine/index.js";
import { createWasmBackend, wasmAvailable } from "../../src/engine/wasm/backend.js";
import { u01 } from "../../src/engine/rng.js";

// CONTRACT: every distribution is built from a FIXED number of uniform draws.
// A call site is assigned its draw indices once at compile time, so a sampler
// whose draw count depended on the value it produced would collide with the
// next call site's indices and quietly correlate two "independent" streams.
// That is why these are inverse-CDF rather than rejection samplers.

/** Collect one series over a long run, so the shape can be measured. */
function sample(expr: string, n = 4000): number[] {
  const src = `stock Ignore = 0
change(Ignore) = 0
aux X = ${expr}
sim dt=1 to=${n} method=euler seed=7
plot X`;
  return simulate(parseModel(src)).series.get("X")!;
}

const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const sd = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
};

describe("lognormal", () => {
  it("is positive and skewed, with the declared median", () => {
    const xs = sample("random_lognormal(10, 0.5)");
    expect(xs.every((v) => v > 0)).toBe(true);
    const sorted = [...xs].sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)]!).toBeCloseTo(10, 0);
    // E[X] = median·e^{σ²/2} = 10·e^{0.125} ≈ 11.33 — above the median, which is
    // the whole point of reaching for it.
    expect(mean(xs)).toBeGreaterThan(10.8);
    expect(mean(xs)).toBeLessThan(11.9);
  });

  it("degenerates safely on a non-positive median", () => {
    expect(sample("random_lognormal(0, 1)", 20).every((v) => v === 0)).toBe(true);
  });
});

describe("triangular", () => {
  it("stays inside its bounds and centres on (lo+mode+hi)/3", () => {
    const xs = sample("random_triangular(1, 2, 9)");
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...xs)).toBeLessThanOrEqual(9);
    expect(mean(xs)).toBeCloseTo((1 + 2 + 9) / 3, 0);
  });

  it("handles a mode outside the range by clamping it", () => {
    const xs = sample("random_triangular(0, 100, 10)", 200);
    expect(Math.max(...xs)).toBeLessThanOrEqual(10);
  });
});

describe("exponential", () => {
  it("has mean 1/rate and is non-negative", () => {
    const xs = sample("random_exponential(0.25)");
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(mean(xs)).toBeCloseTo(4, 0);
    // an exponential's sd equals its mean
    expect(sd(xs)).toBeCloseTo(4, 0);
  });
});

describe("poisson", () => {
  it("gives non-negative integers whose variance equals the mean", () => {
    const xs = sample("random_poisson(3)");
    expect(xs.every((v) => Number.isInteger(v) && v >= 0)).toBe(true);
    expect(mean(xs)).toBeCloseTo(3, 0);
    expect(sd(xs) ** 2).toBeCloseTo(3, 0);
  });

  it("switches to the normal approximation for a large mean without changing shape", () => {
    const xs = sample("random_poisson(2000)", 800);
    expect(mean(xs)).toBeGreaterThan(1900);
    expect(mean(xs)).toBeLessThan(2100);
    expect(xs.every((v) => Number.isInteger(v) && v >= 0)).toBe(true);
  });
});

describe("truncated normal", () => {
  it("actually lives inside the interval", () => {
    const xs = sample("random_normal_truncated(0, 3, -1, 1)");
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...xs)).toBeLessThanOrEqual(1);
  });

  it("is not a clamped normal — no mass piles up on the bounds", () => {
    // Clamping N(0,3) to [-1,1] would put ~74% of draws exactly on ±1.
    const xs = sample("random_normal_truncated(0, 3, -1, 1)");
    const onEdge = xs.filter((v) => Math.abs(Math.abs(v) - 1) < 1e-9).length;
    expect(onEdge / xs.length).toBeLessThan(0.01);
    // and a wide interval leaves the normal essentially untouched
    const wide = sample("random_normal_truncated(5, 1, -100, 100)");
    expect(mean(wide)).toBeCloseTo(5, 0);
    expect(sd(wide)).toBeCloseTo(1, 0);
  });
});

describe("draw indices stay independent", () => {
  it("two call sites in one model are not correlated", () => {
    const src = `stock Ignore = 0
change(Ignore) = 0
aux A = random_poisson(4)
aux B = random_poisson(4)
sim dt=1 to=3000 method=euler seed=3
plot A B`;
    const r = simulate(parseModel(src));
    const a = r.series.get("A")!, b = r.series.get("B")!;
    const ma = mean(a), mb = mean(b);
    let cov = 0, va = 0, vb = 0;
    for (let i = 0; i < a.length; i++) {
      cov += (a[i]! - ma) * (b[i]! - mb);
      va += (a[i]! - ma) ** 2;
      vb += (b[i]! - mb) ** 2;
    }
    expect(Math.abs(cov / Math.sqrt(va * vb))).toBeLessThan(0.08);
  });

  it("is reproducible under a fixed seed and moves with a different one", () => {
    const at = (seed: number) => {
      const src = `stock Ignore = 0\nchange(Ignore) = 0\naux X = random_triangular(0, 1, 10)\nsim dt=1 to=50 method=euler seed=${seed}\nplot X`;
      return simulate(parseModel(src)).series.get("X")!;
    };
    expect(at(1)).toEqual(at(1));
    expect(at(1)).not.toEqual(at(2));
  });
});

describe("all three backends agree", () => {
  it.skipIf(!wasmAvailable())("WASM matches the compiled-TS path on every distribution", async () => {
    const src = `stock Total = 0
aux L = random_lognormal(10, 0.4)
aux T = random_triangular(1, 5, 9)
aux Ex = random_exponential(0.3)
aux P = random_poisson(6)
aux N = random_normal_truncated(2, 1, 0, 4)
change(Total) = L + T + Ex + P + N
sim dt=1 to=200 method=euler seed=11
plot Total L T Ex P N`;
    const model = parseModel(src);
    const plan = buildPlan(compile(model));
    const ts = runPlan(model, plan, tsBackend(plan));
    const wasm = runPlan(model, plan, await createWasmBackend(buildPlan(compile(model))));
    for (const n of ts.names) {
      const a = ts.series.get(n)!, b = wasm.series.get(n)!;
      for (let i = 0; i < a.length; i++) expect(b[i], `${n}[${i}]`).toBeCloseTo(a[i]!, 9);
    }
  });

  it("the tree-walker returns each distribution's mean, not a draw", async () => {
    // loops.ts perturbs at a deterministic operating point, so random*() must
    // resolve to a fixed value there.
    const { operatingPoint } = await import("../../src/engine/loops.js");
    const src = `stock S = 0
aux L = random_lognormal(10, 0)
aux T = random_triangular(0, 3, 6)
aux Ex = random_exponential(0.5)
aux P = random_poisson(7)
change(S) = 0
sim dt=1 to=2`;
    const op = operatingPoint(parseModel(src));
    expect(op.L).toBeCloseTo(10, 9);
    expect(op.T).toBeCloseTo(3, 9);
    expect(op.Ex).toBeCloseTo(2, 9);
    expect(op.P).toBeCloseTo(7, 9);
  });
});

describe("the uniform base is unchanged", () => {
  it("u01 still spans [0,1) evenly", () => {
    const xs = Array.from({ length: 5000 }, (_, i) => u01(0, i, 0));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(mean(xs)).toBeCloseTo(0.5, 1);
  });
});
