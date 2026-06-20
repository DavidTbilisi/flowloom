import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { globalSensitivity } from "../../src/engine/index.js";

// Additive model: out = 3·x1 + 1·x2 + 0·x3, with all params at base 1 and equal
// ±10% ranges ⇒ equal input variances. So first-order Sobol indices go as coef²:
// x1 ≈ 9/10, x2 ≈ 1/10, x3 ≈ 0; and Morris mu* goes as |coef|: x1:x2:x3 ≈ 3:1:0.
const SRC = `stock Y = 0
param x1 = 1
param x2 = 1
param x3 = 1
aux out = 3*x1 + x2 + 0*x3
change(Y) = 0
sim dt=1 to=1
plot out`;

const byName = (rows: { param: string }[]) => Object.fromEntries(rows.map((r, i) => [r.param, i]));

describe("globalSensitivity — Sobol", () => {
  it("apportions variance by coefficient² and ranks correctly", async () => {
    const r = await globalSensitivity(parseModel(SRC), { method: "sobol", metric: "final:out", samples: 256, seed: 1 });
    expect(r.method).toBe("sobol");
    expect(r.runs).toBe(256 * (3 + 2));
    const m = Object.fromEntries(r.rows.map((row) => [row.param, row]));
    // x1 dominates; x3 is inert
    expect(r.rows[0]!.param).toBe("x1");
    expect(m.x1!.s1!).toBeGreaterThan(0.7);
    expect(m.x2!.s1!).toBeGreaterThan(0.03);
    expect(m.x2!.s1!).toBeLessThan(0.3);
    expect(Math.abs(m.x3!.s1!)).toBeLessThan(0.05);
    // additive ⇒ total ≈ first order
    expect(m.x1!.st!).toBeCloseTo(m.x1!.s1!, 1);
  });
});

describe("globalSensitivity — Morris", () => {
  it("ranks by |coefficient| and flags the inert param", async () => {
    const r = await globalSensitivity(parseModel(SRC), { method: "morris", metric: "final:out", samples: 20, seed: 1 });
    expect(r.method).toBe("morris");
    const order = byName(r.rows);
    expect(order.x1).toBeLessThan(order.x2); // x1 ranked above x2
    expect(order.x2).toBeLessThan(order.x3); // x2 above the inert x3
    const m = Object.fromEntries(r.rows.map((row) => [row.param, row]));
    expect(m.x1!.muStar! / m.x2!.muStar!).toBeCloseTo(3, 0); // |3|:|1|
    expect(m.x3!.muStar!).toBeLessThan(1e-9); // inert
    expect(m.x1!.sigma!).toBeLessThan(1e-6); // linear ⇒ no spread in effects
  });

  it("defaults to every param when none are named", async () => {
    const r = await globalSensitivity(parseModel(SRC), { method: "morris", metric: "final:out", samples: 4 });
    expect(r.rows.map((x) => x.param).sort()).toEqual(["x1", "x2", "x3"]);
  });
});
