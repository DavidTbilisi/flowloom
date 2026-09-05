import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { checkNumerics, type AdvisoryKind } from "../../src/engine/index.js";

// CONTRACT: `checkNumerics` answers "do these numbers survive a smaller step?".
// It is the only thing in flowloom that validates the *run* rather than the
// text, so its verdict has to be trustworthy in both directions: a model whose
// answer has converged must not be flagged, and one whose answer has not must
// not be waved through. The advisories carry the cases a refinement alone would
// misread — a discontinuity, dt-scaled noise, an unresolved time constant.

const check = (src: string, opts = {}) => checkNumerics(parseModel(src), opts);
const kinds = (advisories: Array<{ kind: AdvisoryKind }>) => advisories.map((a) => a.kind);

describe("checkNumerics — the refinement verdict", () => {
  it("passes a model whose answer has stopped moving", async () => {
    // Exponential decay under rk4: the closed form is pinned in engine.test.ts,
    // so any disagreement under halving would be the checker's fault, not the
    // model's.
    const r = await check(`stock X = 100\nparam k = 0.1\nd(X) = -k * X\nsim dt=0.1 to=50 method=rk4`);
    expect(r.converged).toBe(true);
    expect(r.refinedDt).toBe(0.05);
    expect(r.worst!.nrmse).toBeLessThan(1e-6);
  });

  it("fails a model whose answer is still moving, and finds a step where it stops", async () => {
    const r = await check(`stock X = 100\nparam k = 0.1\nd(X) = -k * X\nsim dt=1 to=10 method=euler`);
    expect(r.converged).toBe(false);
    expect(r.worst!.name).toBe("X");
    expect(r.suggestedDt).toBeDefined();
    expect(r.suggestedDt!).toBeLessThan(1);
  });

  it("says it is still converging rather than blaming stiffness, when the ladder is shrinking", async () => {
    // Euler is first-order: over a long horizon four halvings genuinely aren't
    // enough. That is a different answer from "smaller steps won't help", and
    // the note has to distinguish them or it sends the reader the wrong way.
    const r = await check(`stock X = 100\nparam k = 0.1\nd(X) = -k * X\nsim dt=4 to=50 method=euler`);
    expect(r.converged).toBe(false);
    expect(r.suggestedDt).toBeUndefined();
    expect(r.notes.join(" ")).toMatch(/shrinking with each halving/);
  });

  it("reports divergence as divergence, not as a step-size problem", async () => {
    // dX/dt = r·X² blows up in finite time; no dt rescues it, and saying "try a
    // smaller dt" would send the reader down the wrong path.
    const r = await check(`stock X = 1\nparam r = 5\nflow boom = r * X * X\nd(X) = boom\nsim dt=0.5 to=50 method=euler`);
    expect(r.converged).toBe(false);
    expect(r.suggestedDt).toBeUndefined();
    expect(r.notes.join(" ")).toMatch(/diverges in finite time/);
  });

  it("halves only in the direction that diagnoses something", async () => {
    // rk4 is the better estimate, so euler-vs-rk4 is only informative when the
    // model runs euler. An rk4 model spends two runs, not three.
    const rk4 = await check(`stock X = 100\nparam k = 0.1\nd(X) = -k * X\nsim dt=0.1 to=50 method=rk4`);
    expect(rk4.methodAgreement).toBeUndefined();
    expect(rk4.runs).toBe(2);

    const euler = await check(`stock X = 100\nparam k = 0.1\nd(X) = -k * X\nsim dt=2 to=50 method=euler`);
    expect(euler.methodAgreement!.other).toBe("rk4");
    expect(euler.methodAgreement!.converged).toBe(false);
  });

  it("records the halving ladder so a reader can see whether it was converging", async () => {
    const r = await check(`stock X = 100\nparam k = 0.1\nd(X) = -k * X\nsim dt=4 to=50 method=euler`);
    expect(r.refinements.length).toBeGreaterThan(1);
    // first-order error halves with the step: each rung is smaller than the last
    expect(r.refinements[1]!.worst).toBeLessThan(r.refinements[0]!.worst);
  });

  it("honours the tolerance", async () => {
    const src = `stock X = 100\nparam k = 0.1\nd(X) = -k * X\nsim dt=1 to=50 method=euler`;
    expect((await check(src, { tol: 1e-6 })).converged).toBe(false);
    expect((await check(src, { tol: 0.5 })).converged).toBe(true);
  });
});

describe("checkNumerics — what it declines to judge", () => {
  it("does not refine method=map: the step is the model, not an approximation", async () => {
    const r = await check(`stock Cash = 100\nparam income = 10\nd(Cash) = income\nsim dt=1 to=12 method=map`);
    expect(r.converged).toBe(true);
    expect(r.refinedDt).toBeUndefined();
    expect(r.notes.join(" ")).toMatch(/difference equation/);
  });

  it("does not refine a links-only sketch: there is no state to integrate", async () => {
    const r = await check(`link A -> B +\nlink B -> A -`);
    expect(r.refinedDt).toBeUndefined();
    expect(r.notes.join(" ")).toMatch(/nothing to integrate/);
  });
});

describe("checkNumerics — static advisories", () => {
  it("flags a branch that turns on a stock under rk4, and not under euler", async () => {
    const src = (method: string) =>
      `stock Water = 100\nparam threshold = 50\nflow draining = if(Water > threshold, 8, 1)\nd(Water) = -draining\nsim dt=0.5 to=60 method=${method}`;
    expect(kinds((await check(src("rk4"))).advisories)).toContain("discontinuity");
    expect(kinds((await check(src("euler"))).advisories)).not.toContain("discontinuity");
  });

  it("counts one discontinuity per line, not one per node", async () => {
    // `if(Water > k, …)` is a call *and* a comparison at the same place.
    const r = await check(`stock Water = 100\nparam k = 50\nflow draining = if(Water > k, 8, 1)\nd(Water) = -draining\nsim dt=0.5 to=60 method=rk4`);
    const a = r.advisories.find((x) => x.kind === "discontinuity")!;
    expect(a.message).not.toMatch(/places/);
  });

  it("does not flag a branch on a param — only a state-dependent one moves with the grid", async () => {
    const r = await check(`stock X = 10\nparam on = 1\nflow f = if(on > 0, 1, 0)\nd(X) = f\nsim dt=0.5 to=20 method=rk4`);
    expect(kinds(r.advisories)).not.toContain("discontinuity");
  });

  it("flags a random draw that feeds a change(), because its variance scales with dt", async () => {
    const r = await check(`stock B = 1000\nparam vol = 0.05\nflow gain = B * random_normal(0, vol)\nd(B) = gain\nsim dt=1 to=60`);
    expect(kinds(r.advisories)).toContain("noise");
    expect(r.notes.join(" ")).toMatch(/noise advisory/);
  });

  it("does not flag a random draw nothing integrates", async () => {
    const r = await check(`stock X = 1\nparam k = 0.1\naux watched = random_normal(0, 1)\nd(X) = -k * X\nplot X watched\nsim dt=0.1 to=20`);
    expect(kinds(r.advisories)).not.toContain("noise");
  });

  it("flags a time constant the grid cannot resolve — even when refinement converges", async () => {
    // The case a refinement test alone misses: the run is stable at every dt,
    // but the response you see belongs to the step, not to τ.
    const r = await check(`stock L = 0\nparam target = 10\naux expected = smooth(target, 0.05)\nd(L) = expected - L\nsim dt=0.5 to=20`);
    expect(r.converged).toBe(true);
    expect(kinds(r.advisories)).toContain("time-constant");
    expect(r.advisories.find((a) => a.kind === "time-constant")!.message).toMatch(/τ=0.05/);
  });

  it("says nothing about a time constant the grid resolves comfortably", async () => {
    const r = await check(`stock L = 0\nparam target = 10\naux expected = smooth(target, 8)\nd(L) = expected - L\nsim dt=0.1 to=40`);
    expect(kinds(r.advisories)).not.toContain("time-constant");
  });
});
