import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { simulate, simulateAsync } from "../../src/engine/index.js";
import { EXAMPLES } from "../../src/examples/index.js";

// CONTRACT: the integrator (simulator.ts) is the load-bearing numerical core.
// engine.test.ts pins it against closed-form solutions; this file pins the
// *integrator's own properties* in isolation — the order of accuracy of each
// method, sync/async backend parity, and the early-halt guard — so a change to
// the stepping logic can't silently degrade them.

/** Final value of `series`, and the absolute error vs a closed-form expectation. */
function finalError(src: string, series: string, expected: number) {
  const r = simulate(parseModel(src));
  const arr = r.series.get(series)!;
  return Math.abs(arr[arr.length - 1]! - expected);
}

// Exponential decay: dS/dt = -k·S, S(0)=1  ⇒  S(t) = e^{-k t}. A clean linear
// ODE where the global truncation order of each method is visible.
const decay = (dt: number, method: "euler" | "rk4") =>
  `stock S = 1\nparam k = 1\nchange(S) = -k * S\nsim dt=${dt} to=2 method=${method}`;
const EXACT = Math.exp(-2); // S(2) with k=1

describe("method accuracy", () => {
  it("RK4 is dramatically more accurate than Euler at the same dt", () => {
    const eErr = finalError(decay(0.1, "euler"), "S", EXACT);
    const rErr = finalError(decay(0.1, "rk4"), "S", EXACT);
    expect(rErr).toBeLessThan(eErr / 1000);
  });

  it("Euler converges at first order (halving dt ~halves the error)", () => {
    const coarse = finalError(decay(0.2, "euler"), "S", EXACT);
    const fine = finalError(decay(0.1, "euler"), "S", EXACT);
    expect(coarse / fine).toBeGreaterThan(1.7);
    expect(coarse / fine).toBeLessThan(2.4);
  });

  it("RK4 converges at ~fourth order (halving dt cuts error by ≈16×)", () => {
    const coarse = finalError(decay(0.2, "rk4"), "S", EXACT);
    const fine = finalError(decay(0.1, "rk4"), "S", EXACT);
    expect(coarse / fine).toBeGreaterThan(8); // 4th order ⇒ ≈16; well clear of Euler's 2
  });

  it("both methods echo their settings into the result", () => {
    const r = simulate(parseModel(decay(0.2, "euler")));
    expect(r.method).toBe("euler");
    expect(r.dt).toBe(0.2);
    // output order is user stocks first, then flow/aux vars
    expect(r.names[0]).toBe("S");
    expect(r.stockNames).toEqual(["S"]);
  });
});

describe("early-halt guard", () => {
  it("flags and stops a run when a stock goes non-finite", () => {
    // dS/dt = S²  blows up to +∞ in finite time; with a coarse step it overflows.
    const r = simulate(parseModel(`stock S = 1e6\nchange(S) = S * S\nsim dt=1 to=100 method=euler`));
    expect(r.note).toBeTruthy();
    // it halted before producing the full 0..100 timeline
    expect(r.t[r.t.length - 1]!).toBeLessThan(100);
    // the integrator records the sample then checks it, so the last recorded
    // value is the non-finite one that tripped the guard; everything before it
    // is finite.
    const s = r.series.get("S")!;
    expect(Number.isFinite(s[s.length - 1]!)).toBe(false);
    for (const v of s.slice(0, -1)) expect(Number.isFinite(v)).toBe(true);
  });

  it("a well-posed run carries no halt note and reaches `to`", () => {
    const r = simulate(parseModel(decay(0.1, "rk4")));
    expect(r.note).toBeUndefined();
    expect(r.t[r.t.length - 1]!).toBeCloseTo(2, 9);
  });
});

describe("sync/async backend parity", () => {
  // simulateAsync routes large models through WASM and small ones back through
  // the TS backend; either way it must match simulate() exactly. The built-in
  // examples are all small, so this pins the fallback path to the sync path.
  for (const ex of EXAMPLES) {
    it(`"${ex.name}": simulateAsync matches simulate bit-for-bit`, async () => {
      const model = parseModel(ex.source);
      const sync = simulate(model);
      const async = await simulateAsync(parseModel(ex.source));
      expect(async.names).toEqual(sync.names);
      expect(async.note).toBe(sync.note);
      for (const name of sync.names) {
        expect(async.series.get(name)).toEqual(sync.series.get(name));
      }
    });
  }
});
