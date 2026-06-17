import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { simulate } from "../../src/engine/index.js";
import { EXAMPLES } from "../../src/examples/index.js";

// Numeric contracts: the engine's output is pinned against closed-form solutions
// and conserved quantities, not just "it runs". If the integrator drifts, these
// fail.

function run(src: string) {
  return simulate(parseModel(src));
}
function final(src: string, series: string) {
  const r = run(src);
  const arr = r.series.get(series)!;
  return arr[arr.length - 1]!;
}

describe("integrator vs closed form", () => {
  it("Newton cooling matches the analytic exponential (RK4)", () => {
    // Temp(t) = room + (T0-room)·e^(-k t) = 20 + 70·e^(-0.3·20)
    const got = final(
      `stock Temp = 90\nparam room = 20\nparam k = 0.3\nflow cooling = k*(Temp-room)\nd(Temp) = -cooling\nsim dt=0.05 to=20 method=rk4`,
      "Temp",
    );
    const exact = 20 + 70 * Math.exp(-0.3 * 20);
    expect(got).toBeCloseTo(exact, 4);
  });

  it("compound savings (Euler) matches the exact recurrence", () => {
    // B_{n+1} = 1.05·B_n + 200, B_0 = 1000  ⇒  B_n = 5000·1.05^n − 4000
    const got = final(
      `stock Balance = 1000\nparam rate = 0.05\nparam deposit = 200\nflow interest = rate*Balance\nflow saving = deposit\nd(Balance) = interest + saving\nsim dt=1 to=40 method=euler`,
      "Balance",
    );
    const exact = 5000 * Math.pow(1.05, 40) - 4000;
    expect(got).toBeCloseTo(exact, 6);
  });

  it("exponential growth dN/dt = rN matches e^(rt) (RK4)", () => {
    const got = final(`stock N = 1\nparam r = 1\nd(N) = r*N\nsim dt=0.01 to=3 method=rk4`, "N");
    expect(got).toBeCloseTo(Math.E ** 3, 3);
  });
});

describe("conserved quantities & qualitative behaviour", () => {
  it("SIR conserves total population", () => {
    const r = run(EXAMPLES.find((e) => e.name === "SIR epidemic")!.source);
    const S = r.series.get("S")!;
    const I = r.series.get("I")!;
    const R = r.series.get("R")!;
    for (let i = 0; i < S.length; i += 20) {
      expect(S[i]! + I[i]! + R[i]!).toBeCloseTo(1000, 6);
    }
  });

  it("logistic growth is monotone and approaches carrying capacity", () => {
    const r = run(EXAMPLES.find((e) => e.name === "Logistic growth")!.source);
    const P = r.series.get("Population")!;
    for (let i = 1; i < P.length; i++) expect(P[i]!).toBeGreaterThanOrEqual(P[i - 1]! - 1e-9);
    expect(P[P.length - 1]!).toBeGreaterThan(990);
    expect(P[P.length - 1]!).toBeLessThanOrEqual(1000.0001);
  });

  it("predator-prey oscillates (non-monotone) and stays positive", () => {
    const r = run(EXAMPLES.find((e) => e.name === "Predator–prey")!.source);
    const prey = r.series.get("Prey")!;
    expect(prey.every((v) => v > 0)).toBe(true);
    let dirChanges = 0;
    for (let i = 2; i < prey.length; i++) {
      const a = Math.sign(prey[i]! - prey[i - 1]!);
      const b = Math.sign(prey[i - 1]! - prey[i - 2]!);
      if (a !== 0 && b !== 0 && a !== b) dirChanges++;
    }
    expect(dirChanges).toBeGreaterThan(1); // genuine oscillation
  });
});

describe("stateful builtins (delays/smooth)", () => {
  it("SMOOTH of a constant input holds that constant", () => {
    const got = final(`stock X = 0\nparam c = 7\naux s = smooth(c, 3)\nd(X) = 0\nsim dt=0.1 to=10`, "s");
    expect(got).toBeCloseTo(7, 6);
  });

  it("SMOOTH approaches a stepped input with the right time constant", () => {
    // input steps 0→1 at t=0; first-order smooth ⇒ s(τ) ≈ 1−e^-1 ≈ 0.632
    const r = run(`stock X = 0\naux input = step(1, 0)\naux s = smoothi(input, 5, 0)\nd(X) = 0\nsim dt=0.01 to=5 method=rk4`);
    const s = r.series.get("s")!;
    expect(s[s.length - 1]!).toBeCloseTo(1 - Math.exp(-1), 2);
  });

  it("DELAY3 conserves material in steady state", () => {
    // constant inflow through a 3rd-order delay ⇒ outflow equals inflow at steady state
    const got = final(`stock X = 0\nparam inflow = 4\nflow out = delay3(inflow, 6)\nd(X) = 0\nsim dt=0.05 to=40 method=rk4`, "out");
    expect(got).toBeCloseTo(4, 4);
  });

  it("table lookup interpolates linearly", () => {
    const got = final(`stock X = 30\ntable f = (0,0) (20,2) (40,5)\naux y = f(X)\nd(X) = 0\nsim dt=1 to=1`, "y");
    // X=30 is halfway between (20,2) and (40,5) ⇒ 3.5
    expect(got).toBeCloseTo(3.5, 9);
  });
});

describe("robustness", () => {
  it("flags a blow-up instead of producing Infinity silently", () => {
    const r = run(`stock X = 1\nd(X) = X*X*X\nsim dt=0.5 to=100 method=euler`);
    expect(r.note).toMatch(/non-finite/);
  });

  it("all built-in examples simulate without error", () => {
    for (const ex of EXAMPLES) {
      const r = run(ex.source);
      expect(r.t.length).toBeGreaterThan(1);
    }
  });
});
