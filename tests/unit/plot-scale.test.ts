import { describe, it, expect } from "vitest";
import { niceScale } from "../../src/ui/plot.js";

// CONTRACT: the y-axis is framed on round numbers, not padded data extremes —
// the difference between a chart that looks designed and one that looks dumped.
// (plot.ts is DOM-aware but niceScale is pure, so it unit-tests cleanly.)

describe("niceScale", () => {
  it("turns a messy data range into round bounds and ticks", () => {
    // the logistic example (Population 5 → 999.995) produced ugly 1059.695-style
    // ticks before; now it frames cleanly on 0…1000.
    const s = niceScale(5, 999.995, 5);
    expect(s.lo).toBe(0);
    expect(s.hi).toBe(1000);
    expect(s.ticks).toEqual([0, 200, 400, 600, 800, 1000]);
  });

  it("snaps bounds outward so the data always fits inside", () => {
    const s = niceScale(2, 97, 5);
    expect(s.lo).toBeLessThanOrEqual(2);
    expect(s.hi).toBeGreaterThanOrEqual(97);
    // every tick is a clean multiple of the step
    const step = s.ticks[1]! - s.ticks[0]!;
    for (const t of s.ticks) expect(Math.abs(t / step - Math.round(t / step))).toBeLessThan(1e-9);
  });

  it("produces a clean zero (no -0 or float dust) when the range crosses it", () => {
    const s = niceScale(-48, 52, 5);
    expect(s.ticks).toContain(0);
    expect(s.ticks.every((t) => Object.is(t, -0) === false)).toBe(true);
  });

  it("handles small fractional ranges", () => {
    const s = niceScale(0, 0.7, 5);
    expect(s.lo).toBe(0);
    expect(s.hi).toBeGreaterThanOrEqual(0.7);
    expect(s.ticks[0]).toBe(0);
  });

  it("degenerate (lo === hi) is returned untouched, never NaN", () => {
    const s = niceScale(5, 5, 5);
    expect(s.ticks.every(Number.isFinite)).toBe(true);
  });
});
