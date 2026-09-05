import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { parseUnit, unitScale, fmtDim, mulDim, divDim, powDim, eqDim, lintModel, UnitParseError } from "../../src/engine/index.js";

// Everything lint emits except the pre-existing (non-units) checks, so a test can
// assert "no units complaint" without tripping over an unrelated "unused" warning.
const NON_UNIT = /never used|never changes|non-positive time constant/;
const unitWarnings = (src: string) =>
  lintModel(parseModel(src))
    .map((d) => d.message)
    .filter((m) => !NON_UNIT.test(m));

describe("parseUnit", () => {
  // A token the library knows reduces to its base dimensions; one it does not
  // stays its own base, which is what keeps free-form vocabulary working.
  it("reduces known vocabulary to base dimensions", () => {
    expect([...parseUnit("people")]).toEqual([["person", 1]]);
    expect([...parseUnit("person")]).toEqual([["person", 1]]);
  });

  it("leaves unknown vocabulary alone", () => {
    expect([...parseUnit("widgets")]).toEqual([["widgets", 1]]);
    expect([...parseUnit("GEL")]).toEqual([["gel", 1]]);
  });

  it("parses a quotient", () => {
    expect([...parseUnit("widgets/month")].sort()).toEqual([
      ["s", -1],
      ["widgets", 1],
    ]);
  });

  it("treats literal 1 as dimensionless", () => {
    expect([...parseUnit("1/day")]).toEqual([["s", -1]]);
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

  it("normalizes case; plural folding is model-local, not a parseUnit rule", () => {
    expect(eqDim(parseUnit("People"), parseUnit("people"))).toBe(true);
    // `widget`/`widgets` are unknown vocabulary: they unify only when a model
    // writes both (see the pluralFolding suite), never by a blanket -s rule —
    // which would also turn `mass` into `mas`.
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

describe("bare literals are unit-polymorphic", () => {
  const warnings = (src: string) => lintModel(parseModel(src)).map((d) => d.message).filter((m) => /unit|units|time constant/.test(m));

  it("never warns against a literal on its own", () => {
    const src = `stock Cash [gel] = 0
param pay [gel/month] = 6400
aux low = Cash < 0
aux floor0 [gel] = max(0, Cash)
aux tick = t % 12 == 0
flow net [gel/month] = pay - if(low, 0, 100)
change(Cash) = net
sim dt=1 to=3 method=euler timeunit=month`;
    expect(warnings(src)).toEqual([]);
  });

  it("still flags two concrete, conflicting units", () => {
    const src = `stock S = 0\nparam a [people] = 3\nparam b [widgets] = 4\naux c = max(a, b)\nchange(S) = 0`;
    expect(warnings(src).some((m) => /disagree on units/.test(m))).toBe(true);
  });

  it("checks a delay_fixed length against the time unit", () => {
    const src = `stock S [gel] = 0\nparam n [gel] = 2\naux d = delay_fixed(S, n)\nchange(S) = 0\nsim timeunit=month`;
    expect(warnings(src).some((m) => /delay_fixed\(\) time constant should be in month/.test(m))).toBe(true);
  });
});

// ── the vocabulary layer ────────────────────────────────────────────────────
// CONTRACT: the checker reduces units to base dimensions so that a model
// written in mixed vocabulary checks at all — but it never rescales a number,
// so a scale mismatch is *reported* rather than silently absorbed.

describe("unit library — aliases and prefixes", () => {
  const same = (a: string, b: string) => eqDim(parseUnit(a), parseUnit(b));

  it("resolves the person/people irregular the appendix named", () => {
    expect(same("person", "people")).toBe(true);
    expect(same("people/month", "person/month")).toBe(true);
  });

  it("makes hours and days the same dimension", () => {
    expect(same("hour", "day")).toBe(true);
    expect(same("widgets/hr", "widgets/day")).toBe(true);
    expect(same("m/s", "mile/hour")).toBe(true);
  });

  it("applies SI prefixes to prefixable bases", () => {
    expect(same("km", "m")).toBe(true);
    expect(same("MW", "watt")).toBe(true);
    expect(same("kilometer", "m")).toBe(true);
    expect(unitScale("km")).toBe(1000);
    expect(unitScale("MW")).toBe(1e6);
  });

  it("never guesses a prefix over a known unit", () => {
    // `min` is a minute, not a milli-inch; `cal` a calorie, not a centi-litre;
    // `day` is not a deca-year. A known token always wins.
    expect(unitScale("min")).toBe(60);
    expect(same("min", "second")).toBe(true);
    expect(unitScale("cal")).toBe(4.184);
    expect(unitScale("day")).toBe(86_400);
  });

  it("does not prefix a base that isn't on the whitelist", () => {
    // "day" would otherwise read as deca-year, "person" as pico-erson…
    expect([...parseUnit("dyear")]).toEqual([["dyear", 1]]);
  });

  it("expands derived units", () => {
    expect(same("W", "J/s")).toBe(true);
    expect(same("N", "kg*m/s^2")).toBe(true);
    expect(same("Hz", "1/s")).toBe(true);
    expect(same("liter", "m^3")).toBe(true);
  });
});

describe("plural folding is model-local", () => {
  it("unifies two spellings a model actually uses", () => {
    const src = `stock Stored [widgets] = 0
param made [widget] = 3
change(Stored) = made
sim timeunit=day`;
    // `widget` and `widgets` both appear, so they are one thing and the only
    // complaint left is the rate's missing /time — not a bogus mismatch.
    expect(unitWarnings(src).some((m) => /widget.*widgets|widgets.*widget/.test(m))).toBe(false);
  });

  it("leaves a lone -s word alone", () => {
    // `mass` must not become `mas`, and `mas` is not in this model anyway.
    const src = `stock M [mass] = 0\nparam g [mass] = 1\nchange(M) = g\nsim timeunit=s`;
    expect(unitWarnings(src).some((m) => /\bmas\b/.test(m))).toBe(false);
  });
});

describe("mixed scales are named, not absorbed", () => {
  it("warns when one dimension is written at two scales", () => {
    const src = `stock Work [hour] = 0
param shift [day] = 1
change(Work) = shift
sim dt=1 to=5 timeunit=hour`;
    const w = unitWarnings(src).join("\n");
    expect(w).toMatch(/measures .* in hour and day/);
    expect(w).toMatch(/1 day = 24 hour/);
    expect(w).toMatch(/never rescales/);
  });

  it("says nothing when the model is consistent", () => {
    const src = `stock Work [hour] = 0
param shift [hour] = 1
change(Work) = shift
sim dt=1 to=5 timeunit=hour`;
    expect(unitWarnings(src).some((m) => /different scales/.test(m))).toBe(false);
  });

  it("does not fire on free-form vocabulary, which has no scale", () => {
    const src = `stock S [widgets] = 0\nparam a [gel] = 1\nchange(S) = a\nsim timeunit=month`;
    expect(unitWarnings(src).some((m) => /different scales/.test(m))).toBe(false);
  });
});

describe("diagnostics speak the model's vocabulary, not SI", () => {
  it("says people/month, not person/s", () => {
    const src = `stock Pop [people] = 10
param rate [people] = 1
change(Pop) = rate
sim dt=1 to=5 timeunit=month`;
    const w = unitWarnings(src).join("\n");
    expect(w).toMatch(/change\(Pop\) should be people\/month/);
    expect(w).not.toMatch(/person\/s/);
  });
});
