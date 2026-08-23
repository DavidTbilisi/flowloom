import { describe, it, expect } from "vitest";
import { parseModel, ModelError } from "../../src/lang/index.js";
import { simulate, simulateAsync, lintModel, analyzeLoops, compile, buildPlan, tsBackend, runPlan, applyOverride } from "../../src/engine/index.js";
import { createWasmBackend } from "../../src/engine/wasm/backend.js";

// CONTRACT: previous(X) / delay_fixed(X, n) are *pipeline* delays on the time
// grid — the value exactly one step / n time units ago, sampled once per step and
// held across RK4 sub-stages. They are owned by the integrator (ring buffers),
// so every backend agrees by construction; they break instantaneous
// dependencies; and a circular default init is reported, not silently wrong.

const series = (src: string, name: string) => simulate(parseModel(src)).series.get(name)!;

describe("previous()", () => {
  it("is the input one step ago under euler dt=1", () => {
    const src = `stock S = 10\nchange(S) = 3\naux p = previous(S)\nsim dt=1 to=5 method=euler`;
    const S = series(src, "S"), p = series(src, "p");
    expect(p[0]).toBe(10); // no history yet ⇒ X's initial value
    for (let i = 1; i < S.length; i++) expect(p[i]).toBe(S[i - 1]);
  });

  it("honours an explicit init before history exists", () => {
    const src = `stock S = 10\nchange(S) = 3\naux p = previous(S, -1)\nsim dt=1 to=3 method=euler`;
    expect(series(src, "p")[0]).toBe(-1);
    expect(series(src, "p")[1]).toBe(10);
  });

  it("breaks an instantaneous dependency (a = previous(b)+1, b = a*2 is legal)", () => {
    const src = `stock S = 0\nchange(S) = 0\naux a = previous(b, 0) + 1\naux b = a * 2\nsim dt=1 to=3 method=euler`;
    const a = series(src, "a"), b = series(src, "b");
    expect(a[0]).toBe(1); expect(b[0]).toBe(2);
    expect(a[1]).toBe(3); expect(b[1]).toBe(6);
    expect(a[2]).toBe(7);
  });

  it("a genuine algebraic loop is still an error", () => {
    expect(() => parseModel(`stock S = 0\nchange(S) = 0\naux a = b + 1\naux b = a * 2`)).toThrow(ModelError);
  });

  it("a circular default init is reported by lint and noted on the run", () => {
    const src = `stock S = 0\nchange(S) = 0\naux a = previous(b) + 1\naux b = a * 2\nsim dt=1 to=3 method=euler`;
    expect(lintModel(parseModel(src)).some((d) => /circular/.test(d.message))).toBe(true);
    expect(simulate(parseModel(src)).note).toMatch(/did not settle/);
    // an explicit init fixes both
    const ok = src.replace("previous(b)", "previous(b, 0)");
    expect(lintModel(parseModel(ok)).some((d) => /circular/.test(d.message))).toBe(false);
    expect(simulate(parseModel(ok)).note).toBeUndefined();
  });
});

describe("delay_fixed()", () => {
  it("is the input exactly n time units ago, in whole steps", () => {
    const src = `stock S = 0\nchange(S) = 1\naux d = delay_fixed(S, 2)\nsim dt=0.5 to=4 method=euler`;
    const S = series(src, "S"), d = series(src, "d");
    for (let i = 0; i < S.length; i++) expect(d[i]).toBeCloseTo(i < 4 ? 0 : S[i - 4]!, 12);
  });

  it("reads its length from a param and holds across RK4 sub-stages", () => {
    const src = `stock S = 0\nparam lag = 1\nchange(S) = 1\naux d = delay_fixed(S, lag)\nsim dt=0.5 to=3 method=rk4`;
    const S = series(src, "S"), d = series(src, "d");
    for (let i = 0; i < S.length; i++) expect(d[i]).toBeCloseTo(i < 2 ? 0 : S[i - 2]!, 12);
  });

  it("rounds a sub-step length up to one step and lint says so", () => {
    const src = `stock S = 0\nchange(S) = 1\naux d = delay_fixed(S, 0.2)\nsim dt=1 to=3 method=euler`;
    expect(series(src, "d")[2]).toBe(1); // one step behind S=2
    expect(lintModel(parseModel(src)).some((d) => /shorter than one step/.test(d.message))).toBe(true);
  });

  it("validates arity", () => {
    expect(lintModel(parseModel(`stock S = 0\nchange(S) = 0\naux d = previous()`)).some((d) => /previous\(\) takes/.test(d.message))).toBe(true);
    expect(lintModel(parseModel(`stock S = 0\nchange(S) = 0\naux d = delay_fixed(S)`)).some((d) => /delay_fixed\(\) takes/.test(d.message))).toBe(true);
  });

  it("appears in the influence graph as one node (the sampler is hidden)", () => {
    const src = `stock S = 1\naux d = delay_fixed(S, 2)\nflow f = 0.1 * d\nchange(S) = f\nsim dt=1 to=3 method=euler`;
    const rep = analyzeLoops(parseModel(src));
    expect(rep.graph.nodes.some((n) => n.startsWith("fixed#") && !n.endsWith(".in"))).toBe(true);
    expect(rep.graph.nodes.some((n) => n.endsWith(".in"))).toBe(false);
    expect(rep.loops.some((l) => l.nodes.includes("d"))).toBe(true);
  });

  it("produces identical numbers on the WASM backend", async () => {
    const model = parseModel(`stock S = 0\nchange(S) = 1 + 0.1 * d\naux d = delay_fixed(S, 2)\naux p = previous(S)\nsim dt=0.5 to=6 method=rk4`);
    const plan = buildPlan(compile(model));
    const ts = runPlan(model, plan, tsBackend(plan));
    const wasm = runPlan(model, plan, await createWasmBackend(buildPlan(compile(model))));
    for (const n of ["S", "d", "p"]) expect(wasm.series.get(n)).toEqual(ts.series.get(n));
    expect((await simulateAsync(model)).series.get("d")).toEqual(ts.series.get("d"));
  });
});

describe("discrete-period lint", () => {
  it("warns when the clock is tested on the grid under rk4, not under euler or map", () => {
    const rk4 = `stock S = 0\nchange(S) = if(t % 12 == 0, 1, 0)\nsim dt=1 to=24 method=rk4`;
    const euler = rk4.replace("rk4", "euler");
    const map = rk4.replace("rk4", "map");
    expect(lintModel(parseModel(rk4)).some((d) => /method=map/.test(d.message))).toBe(true);
    expect(lintModel(parseModel(euler)).some((d) => /method=map/.test(d.message))).toBe(false);
    expect(lintModel(parseModel(map)).some((d) => /method=map/.test(d.message))).toBe(false);
  });
});

// CONTRACT: `sim method=map` is a difference equation. stock(t+dt) = stock(t) +
// change(t), change() being a per-step increment in the stock's own units — no
// × dt, so the Euler-era `(x - S) / dt` idiom is gone and the units check expects
// stock units, not stock/time. The internal states of smooth/delay1/delay3 still
// integrate with dt (their time constants stay in time units).
describe("method=map", () => {
  it("steps stock += change once per step, whatever dt is", () => {
    const src = `stock S = 100\nflow inc = 30\nflow out = 20\nchange(S) = inc - out\nsim dt=0.5 to=2 method=map`;
    expect(series(src, "S")).toEqual([100, 110, 120, 130, 140]);
    // euler with the same text multiplies by dt — half the increment per step
    expect(series(src.replace("map", "euler"), "S")).toEqual([100, 105, 110, 115, 120]);
  });

  it("equals euler dt=1 when the flows were written per time unit", () => {
    const euler = `stock S = 5\nchange(S) = if(t % 2 == 0, 3, -1) * 0.5 * S\nsim dt=1 to=8 method=euler`;
    expect(series(euler.replace("euler", "map"), "S")).toEqual(series(euler, "S"));
  });

  it("keeps smooth/delay time constants in time units (internal states use dt)", () => {
    const src = `stock S = 100\nchange(S) = 10\naux sm = smooth(S, 3)\nsim dt=0.5 to=1.5 method=map`;
    const sm = series(src, "sm");
    // S: 100, 110, 120, 130. smooth: sm += dt * (S - sm) / 3
    expect(sm[0]).toBe(100);
    expect(sm[1]).toBeCloseTo(100, 12);
    expect(sm[2]).toBeCloseTo(100 + 0.5 * (110 - 100) / 3, 12);
    expect(sm[3]).toBeCloseTo(sm[2]! + 0.5 * (120 - sm[2]!) / 3, 12);
  });

  it("units: change() carries the stock's own units, not per time", () => {
    const ok = `stock Cash [GEL] = 0\nflow inc [GEL] = 5\nchange(Cash) = inc\nsim dt=1 to=3 method=map timeunit=month`;
    expect(lintModel(parseModel(ok)).filter((d) => /change\(Cash\)/.test(d.message))).toEqual([]);
    const bad = ok.replace("[GEL] = 5", "[GEL/month] = 5");
    expect(lintModel(parseModel(bad)).some((d) => /change\(Cash\) should be gel \(a per-step increment/.test(d.message))).toBe(true);
    // the same text under euler wants gel/month
    expect(lintModel(parseModel(bad.replace("map", "euler"))).filter((d) => /change\(Cash\)/.test(d.message))).toEqual([]);
  });

  it("lint flags a leftover / dt inside change() under map only", () => {
    const src = `stock S = 0\naux goal = 10\nchange(S) = (goal - S) / dt\nsim dt=1 to=3 method=map`;
    expect(lintModel(parseModel(src)).some((d) => /drop the `\/ dt`/.test(d.message))).toBe(true);
    expect(lintModel(parseModel(src.replace("map", "euler"))).some((d) => /drop the/.test(d.message))).toBe(false);
  });

  it("is accepted by the parser, scenarios and overrides; anything else is rejected", () => {
    const m = parseModel(`stock S = 0\nchange(S) = 1\nscenario fast method=map dt=2\nsim dt=1 to=4 method=map`);
    expect(m.settings.method).toBe("map");
    expect(m.scenarios.get("fast")!.sets.find((s) => s.key === "method")!.value).toBe("map");
    expect(() => parseModel(`stock S = 0\nchange(S) = 1\nsim method=leapfrog`)).toThrow(/euler, rk4 or map/);
    expect(() => parseModel(`stock S = 0\nchange(S) = 1\nscenario x method=leapfrog`)).toThrow(/euler, rk4 or map/);
    const m2 = parseModel(`stock S = 0\nchange(S) = 1\nsim dt=0.5 to=1 method=rk4`);
    applyOverride(m2, "method=map");
    expect(simulate(m2).series.get("S")).toEqual([0, 1, 2]);
  });

  it("produces identical numbers on the WASM backend", async () => {
    const model = parseModel(`stock S = 1\nchange(S) = 0.1 * S + previous(S)\naux sm = smooth(S, 2)\nsim dt=0.5 to=4 method=map`);
    const plan = buildPlan(compile(model));
    const ts = runPlan(model, plan, tsBackend(plan));
    const wasm = runPlan(model, plan, await createWasmBackend(buildPlan(compile(model))));
    for (const n of ["S", "sm"]) expect(wasm.series.get(n)).toEqual(ts.series.get(n));
  });
});

describe("dt in expressions", () => {
  it("resolves to the step size on every path (run, operating point, WASM)", async () => {
    const src = `stock S = 0\nchange(S) = 2 / dt\naux d = dt\nsim dt=0.25 to=1 method=euler`;
    const model = parseModel(src);
    const res = simulate(model);
    expect(res.series.get("d")!.every((v) => v === 0.25)).toBe(true);
    expect(res.series.get("S")!.at(-1)).toBeCloseTo(8, 12); // 4 steps × 2
    expect(analyzeLoops(model).graph.nodes).not.toContain("dt");
    const plan = buildPlan(compile(model));
    const wasm = runPlan(model, plan, await createWasmBackend(plan));
    expect(wasm.series.get("S")).toEqual(res.series.get("S"));
  });
});
