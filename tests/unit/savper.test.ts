import { describe, it, expect } from "vitest";
import { parseModel, printModel } from "../../src/lang/index.js";
import { simulate, applyOverride } from "../../src/engine/index.js";

// CONTRACT: `savper` thins the OUTPUT and never the integration. The numbers on
// the samples it keeps must be bit-identical to the same model without it —
// otherwise it is not a save period, it is a bigger step wearing a disguise.

const decay = (extra: string) => `stock X = 100
change(X) = -0.1 * X
sim dt=0.1 to=10 method=rk4 ${extra}`;

describe("savper — record less, integrate the same", () => {
  it("keeps every step by default", () => {
    const r = simulate(parseModel(decay("")));
    expect(r.t.length).toBe(101);
    expect(r.savper).toBeUndefined();
  });

  it("records one sample per save period", () => {
    const r = simulate(parseModel(decay("savper=1")));
    expect(r.t).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(r.savper).toBe(1);
    expect(r.dt).toBe(0.1); // the *integration* step is untouched
  });

  it("gives the same numbers on the samples it keeps", () => {
    const full = simulate(parseModel(decay("")));
    const thin = simulate(parseModel(decay("savper=1")));
    for (let k = 0; k < thin.t.length; k++) {
      expect(thin.series.get("X")![k]).toBe(full.series.get("X")![k * 10]);
    }
  });

  it("always keeps the last step, even off the save grid", () => {
    // to=10, dt=0.1, savper=0.3 ⇒ steps 0,3,6,… land on 99, not 100.
    const r = simulate(parseModel(decay("savper=0.3")));
    expect(r.t[r.t.length - 1]).toBeCloseTo(10, 9);
    expect(r.series.get("X")!.length).toBe(r.t.length);
  });

  it("keeps the step a run halts on, so a blow-up is never thinned away", () => {
    const r = simulate(parseModel(`stock X = 1
change(X) = X * X * 1e300
sim dt=0.1 to=100 method=euler savper=10`));
    expect(r.note).toMatch(/non-finite/);
    // the halt time appears in the output even though it is not on the save grid
    const halted = Number(r.note!.match(/t=([\d.]+)/)![1]);
    expect(r.t[r.t.length - 1]).toBeCloseTo(halted, 3);
  });

  it("is a setting like any other: overridable and printed", () => {
    const m = parseModel(decay("savper=1"));
    expect(printModel(m)).toContain("savper=1");
    applyOverride(m, "savper=2");
    expect(simulate(m).t).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it("warns rather than silently rounding an awkward period", () => {
    const m = parseModel(decay("savper=0.25"));
    expect(m.diagnostics.map((d) => d.message).join("\n")).toMatch(/not a whole multiple of dt/);
  });

  it("says so when the period is finer than the step", () => {
    const m = parseModel(decay("savper=0.01"));
    expect(m.diagnostics.map((d) => d.message).join("\n")).toMatch(/smaller than dt/);
    expect(simulate(m).t.length).toBe(101);
  });

  it("rejects a non-positive period", () => {
    expect(() => parseModel(decay("savper=0"))).toThrow(/savper must be positive/);
    expect(() => applyOverride(parseModel(decay("")), "savper=-1")).toThrow(/savper must be positive/);
  });

  it("holds up on a long horizon — the case it exists for", () => {
    const src = `stock X = 0
change(X) = 1
sim dt=0.001 to=200 method=euler savper=1`;
    const r = simulate(parseModel(src));
    expect(r.t.length).toBe(201);          // not 200,001
    expect(r.series.get("X")!.at(-1)).toBeCloseTo(200, 6);
  });
});
