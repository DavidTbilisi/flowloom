import { describe, it, expect } from "vitest";
import { parseModel, ModelError } from "../../src/lang/index.js";
import { simulate, simulateAsync, lintModel, analyzeLoops, compile, buildPlan, tsBackend, runPlan } from "../../src/engine/index.js";
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
  it("warns when the clock is tested on the grid under rk4, not under euler", () => {
    const rk4 = `stock S = 0\nchange(S) = if(t % 12 == 0, 1, 0)\nsim dt=1 to=24 method=rk4`;
    const euler = rk4.replace("rk4", "euler");
    expect(lintModel(parseModel(rk4)).some((d) => /method=euler dt=1/.test(d.message))).toBe(true);
    expect(lintModel(parseModel(euler)).some((d) => /method=euler dt=1/.test(d.message))).toBe(false);
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
