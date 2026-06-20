import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { parseUnit, fmtDim, mulDim, divDim, powDim, eqDim, lintModel, UnitParseError } from "../../src/engine/index.js";

// Everything lint emits except the pre-existing (non-units) checks, so a test can
// assert "no units complaint" without tripping over an unrelated "unused" warning.
const NON_UNIT = /never used|never changes|non-positive time constant/;
const unitWarnings = (src: string) =>
  lintModel(parseModel(src))
    .map((d) => d.message)
    .filter((m) => !NON_UNIT.test(m));

describe("parseUnit", () => {
  it("parses a simple token", () => {
    expect([...parseUnit("people")]).toEqual([["people", 1]]);
  });

  it("parses a quotient", () => {
    expect([...parseUnit("widgets/month")].sort()).toEqual([
      ["month", -1],
      ["widgets", 1],
    ]);
  });

  it("treats literal 1 as dimensionless", () => {
    expect([...parseUnit("1/day")]).toEqual([["day", -1]]);
    expect(parseUnit("1").size).toBe(0);
    expect(parseUnit("").size).toBe(0);
  });

  it("handles exponents and parens", () => {
    expect([...parseUnit("m^2")]).toEqual([["m", 2]]);
    expect([...parseUnit("kg*m/(s^2)")].sort()).toEqual([
      ["kg", 1],
      ["m", 1],
      ["s", -2],
    ]);
  });

  it("normalizes case and is plural-sensitive", () => {
    expect(eqDim(parseUnit("People"), parseUnit("people"))).toBe(true);
    expect(eqDim(parseUnit("widget"), parseUnit("widgets"))).toBe(false);
  });

  it("rejects malformed units", () => {
    expect(() => parseUnit("kg/")).toThrow(UnitParseError);
    expect(() => parseUnit("m^x")).toThrow(UnitParseError);
    expect(() => parseUnit("(m")).toThrow(UnitParseError);
  });
});

describe("Dim algebra", () => {
  it("multiplies, divides, and powers", () => {
    expect(fmtDim(mulDim(parseUnit("m"), parseUnit("m")))).toBe("m^2");
    expect(fmtDim(divDim(parseUnit("m"), parseUnit("s")))).toBe("m/s");
    expect(fmtDim(powDim(parseUnit("m"), 3))).toBe("m^3");
    expect(fmtDim(divDim(parseUnit("m"), parseUnit("m"))).length).toBeGreaterThan(0);
    expect(fmtDim(divDim(parseUnit("m"), parseUnit("m")))).toBe("1");
  });
});

describe("checkUnits via lint", () => {
  it("stays silent on a fully un-annotated model (UNKNOWN suppression)", () => {
    const src = `
stock Tank = 10
change(Tank) = inflow - outflow
flow inflow = 5
flow outflow = 0.1 * Tank
sim dt=0.1 to=10`;
    expect(unitWarnings(src)).toEqual([]);
  });

  it("flags adding incompatible units", () => {
    const src = `
stock S = 0
param a [people] = 3
param b [widgets] = 4
aux c = a + b`;
    expect(unitWarnings(src).some((m) => /unit mismatch/.test(m))).toBe(true);
  });

  it("does not warn when only one side is annotated", () => {
    const src = `
stock S = 0
param a [people] = 3
param b = 4
aux c = a + b`;
    expect(unitWarnings(src)).toEqual([]);
  });

  it("flags a dimensioned argument to exp()", () => {
    const src = `
stock S = 0
param a [people] = 3
aux c = exp(a)`;
    expect(unitWarnings(src).some((m) => /dimensionless/.test(m))).toBe(true);
  });

  it("checks change(stock) is stock-units per time", () => {
    const good = `
stock Tank [liters] = 10
change(Tank) = flowin
flow flowin [liters/time] = 2`;
    expect(unitWarnings(good)).toEqual([]);

    const bad = `
stock Tank [liters] = 10
change(Tank) = rate
flow rate [liters] = 2`;
    expect(unitWarnings(bad).some((m) => /change\(Tank\)/.test(m))).toBe(true);
  });

  it("respects a custom timeunit", () => {
    const src = `
stock Tank [liters] = 10
change(Tank) = rate
flow rate [liters/month] = 2
sim timeunit=month`;
    expect(unitWarnings(src)).toEqual([]);
  });

  it("flags a stock whose initial value units differ", () => {
    const src = `
stock Tank [liters] = start
param start [people] = 10
change(Tank) = 0`;
    expect(unitWarnings(src).some((m) => /initial value/.test(m))).toBe(true);
  });

  it("warns on a malformed unit string", () => {
    const src = `
stock S = 0
param a [kg/] = 3`;
    expect(lintModel(parseModel(src)).some((d) => /unit/.test(d.message))).toBe(true);
  });
});
