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

describe("comparison / logical operators", () => {
  // The compiled (codegen) backend is exercised here; wasm.test.ts pins WASM to
  // these same numbers, and the operators feed if(cond,a,b).
  const M = `stock S = 0
param a = 5
param b = 10
aux lt = a < b
aux gt = a > b
aux ge = b >= 10
aux eq = a == 5
aux ne = a != 5
aux andv = (a > 0) && (b > 0)
aux orv  = (a > 100) || (b > 0)
aux notv = !(a > 100)
aux precCmp = 2 + 3 > 4
aux precAnd = 1 < 2 && 3 < 1
aux worded = a > 0 and not (a > 100)
d(S) = 0
sim dt=1 to=1
plot lt gt ge eq ne andv orv notv precCmp precAnd worded`;

  const r = run(M);
  const at0 = (name: string) => r.series.get(name)![0]!;

  it("comparisons return 1/0", () => {
    expect(at0("lt")).toBe(1);
    expect(at0("gt")).toBe(0);
    expect(at0("ge")).toBe(1);
    expect(at0("eq")).toBe(1);
    expect(at0("ne")).toBe(0);
  });
  it("logical && / || / ! treat any non-zero as true", () => {
    expect(at0("andv")).toBe(1);
    expect(at0("orv")).toBe(1);
    expect(at0("notv")).toBe(1);
  });
  it("binds arithmetic > comparison > logical", () => {
    expect(at0("precCmp")).toBe(1); // (2+3) > 4
    expect(at0("precAnd")).toBe(0); // (1<2) && (3<1)
    expect(at0("worded")).toBe(1);  // (a>0) and not(a>100)
  });
});

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

describe("non-negative stocks (`>= 0`)", () => {
  // CONTRACT: the floor bounds the *integrated* value after each completed step
  // — what Vensim and Stella do. It is not a constrained integration, and the
  // difference is deliberate: the outflow is truncated, so mass is not
  // conserved across the floor. That is reported, never hidden.
  const draining = (floor: boolean) =>
    simulate(parseModel(`stock Inv [u] ${floor ? ">= 0 " : ""}= 100\nparam out = 30\nparam inn = 10\nchange(Inv) = inn - out\nsim dt=0.25 to=20 method=rk4`));

  it("holds the stock at zero instead of letting an outflow drain past empty", () => {
    const ys = draining(true).series.get("Inv")!;
    expect(Math.min(...ys)).toBe(0);
    expect(ys.at(-1)).toBe(0);
  });

  it("leaves an undeclared stock signed — the default is unchanged", () => {
    const ys = draining(false).series.get("Inv")!;
    expect(ys.at(-1)).toBeCloseTo(100 - 20 * 20, 6); // 100 + (10-30)·20
  });

  it("does not touch a floored stock that never reaches zero", () => {
    const with_ = simulate(parseModel("stock X [u] >= 0 = 100\nparam k = 0.1\nchange(X) = -k * X\nsim dt=0.1 to=20 method=rk4"));
    const without = simulate(parseModel("stock X [u] = 100\nparam k = 0.1\nchange(X) = -k * X\nsim dt=0.1 to=20 method=rk4"));
    expect(with_.clamped).toBeUndefined();
    const a = with_.series.get("X")!, b = without.series.get("X")!;
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]!);
  });

  it("reports which stocks hit the floor, so the truncated outflow is visible", () => {
    expect(draining(true).clamped).toEqual(["Inv"]);
  });

  it("floors an initial value below zero rather than reporting a state the stock can't hold", () => {
    const r = simulate(parseModel("stock X [u] >= 0 = -5\nchange(X) = 1\nsim dt=1 to=5 method=euler"));
    expect(r.series.get("X")![0]).toBe(0);
    expect(r.clamped).toEqual(["X"]);
  });

  it("applies under every integration method", () => {
    for (const method of ["euler", "rk4", "map"] as const) {
      const r = simulate(parseModel(`stock Inv [u] >= 0 = 10\nchange(Inv) = -3\nsim dt=1 to=10 method=${method}`));
      expect(Math.min(...r.series.get("Inv")!), method).toBe(0);
    }
  });

  it("floors each element of a subscripted stock independently", () => {
    const r = simulate(parseModel(
      "dim region = North, South\nstock Pop[region] >= 0 = 10, 100\nchange(Pop[region]) = -3\nsim dt=1 to=10 method=euler",
    ));
    expect(Math.min(...r.series.get("Pop.North")!)).toBe(0);
    expect(Math.min(...r.series.get("Pop.South")!)).toBe(100 - 30);
    expect(r.clamped).toEqual(["Pop.North"]);
  });
});


describe("lookup tables — how the curve is read past its ends", () => {
  // CONTRACT: a table clamps by default, because a curve fitted over an observed
  // range says nothing outside it. `extrapolate` opts into continuing the slope;
  // `hold` steps instead of interpolating.
  const run = (decl: string, x: number) => {
    const src = `${decl}
stock S = 0
change(S) = 0
aux Y = curve(${x})
sim dt=1 to=1 method=euler
plot Y`;
    return simulate(parseModel(src)).series.get("Y")!.at(-1)!;
  };
  const LINEAR = "table curve = (0,0) (10,10) (20,30)";

  it("interpolates between points and clamps outside", () => {
    expect(run(LINEAR, 5)).toBeCloseTo(5, 9);
    expect(run(LINEAR, 15)).toBeCloseTo(20, 9);
    expect(run(LINEAR, -100)).toBe(0);
    expect(run(LINEAR, 100)).toBe(30);
  });

  it("continues the end slope when asked", () => {
    const t = `${LINEAR} extrapolate`;
    expect(run(t, 5)).toBeCloseTo(5, 9);        // unchanged inside
    expect(run(t, -5)).toBeCloseTo(-5, 9);      // first segment's slope of 1
    expect(run(t, 25)).toBeCloseTo(40, 9);      // last segment's slope of 2
  });

  it("steps rather than interpolating under hold", () => {
    const t = "table curve = (0,0) (10,5) (20,9) hold";
    expect(run(t, 4)).toBe(0);
    expect(run(t, 14)).toBe(5);
    expect(run(t, 99)).toBe(9);                 // still clamped past the end
  });

  it("refuses the contradiction, and an unknown modifier", () => {
    expect(() => parseModel(`${LINEAR} hold extrapolate\nstock S = 0\nchange(S) = 0\nsim dt=1 to=1`))
      .toThrow(/'hold' and 'extrapolate' contradict each other/);
    expect(() => parseModel(`${LINEAR} smooth\nstock S = 0\nchange(S) = 0\nsim dt=1 to=1`))
      .toThrow(/don't understand 'smooth'/);
  });

  it("round-trips the modifiers through fmt", async () => {
    const { printModel } = await import("../../src/lang/index.js");
    for (const how of ["", " hold", " extrapolate"]) {
      const src = `${LINEAR}${how}\nstock S = 0\nchange(S) = 0\naux Y = curve(5)\nsim dt=1 to=1 method=euler`;
      const printed = printModel(parseModel(src));
      expect(printed).toContain(`table curve = (0, 0) (10, 10) (20, 30)${how}`);
      expect(printModel(parseModel(printed))).toBe(printed);
    }
  });
});

describe("initial() — the value at t = start, held", () => {
  // CONTRACT: a stock with a zero rate *is* an initial value, which is why this
  // is a compile-time rewrite like every other stateful builtin rather than a
  // special case in the integrator.
  const run = (src: string, name: string) => simulate(parseModel(src)).series.get(name)!;

  const GROWTH = `stock Pop = 100
param growth = 0.05
change(Pop) = growth * Pop
aux Start = initial(Pop)
aux Ratio = Pop / initial(Pop)
sim dt=1 to=10 method=euler
plot Pop Start Ratio`;

  it("holds the starting value for the whole run", () => {
    const start = run(GROWTH, "Start");
    expect(new Set(start).size).toBe(1);
    expect(start[0]).toBe(100);
  });

  it("expresses growth relative to where it began", () => {
    const pop = run(GROWTH, "Pop");
    const ratio = run(GROWTH, "Ratio");
    for (let i = 0; i < pop.length; i++) expect(ratio[i]).toBeCloseTo(pop[i]! / 100, 9);
  });

  it("captures an expression, not just a stock", () => {
    const src = `stock A = 3
stock B = 4
change(A) = 1
change(B) = 1
aux Diag = initial(sqrt(A * A + B * B))
sim dt=1 to=5 method=euler
plot Diag`;
    expect(new Set(run(src, "Diag"))).toEqual(new Set([5]));
  });

  it("respects `start`, not t=0", () => {
    const src = `stock T = 0
change(T) = 0
aux Began = initial(t)
sim dt=1 start=7 to=12 method=euler
plot Began`;
    expect(run(src, "Began")[0]).toBe(7);
  });

  it("breaks an algebraic loop the way a delay does", () => {
    // `a` depends on `b`'s *starting* value, not its current one, so this is not
    // instantaneous self-reference.
    const src = `stock S = 2
change(S) = 0
aux a = initial(b)
aux b = S + 1
sim dt=1 to=3 method=euler
plot a b`;
    expect(run(src, "a")[0]).toBe(3);
  });

  it("says so when the initial value is genuinely circular", () => {
    const src = `stock S = 0
change(S) = 0
aux a = initial(b)
aux b = a + 1
sim dt=1 to=3 method=euler`;
    expect(simulate(parseModel(src)).note).toMatch(/did not settle/);
  });
});
