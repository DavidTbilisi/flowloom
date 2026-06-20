import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { simulate } from "../../src/engine/index.js";
import { setSimSetting, setParamValue } from "../../src/ui/model-edit.js";
import { EXAMPLES } from "../../src/examples/index.js";
import type { Model } from "../../src/lang/types.js";

// CONTRACT: toolbar/calibrate controls keep the canonical text as the single
// source of truth by rewriting it (model-edit.ts). The "text round-trip"
// invariant the whole design rests on: editing one value via these helpers must
// change *only* that value in the reparsed model and leave the rest of the
// structure byte-identical — an AI editing the same text sees the same change.

/** Structure that must be invariant under a value/setting edit: names, kinds,
 *  units, rates, tables, plot. Deliberately excludes settings and value-exprs
 *  (those are what the edits legitimately change). */
function fingerprint(m: Model) {
  return JSON.stringify({
    stocks: m.stocks.map((s) => `${s.name}:${s.unit ?? ""}`),
    vars: m.vars.map((v) => `${v.kind} ${v.name}:${v.unit ?? ""}`),
    rates: [...m.rates.keys()].sort(),
    tables: [...m.tables.keys()].sort(),
    plot: m.plot,
  });
}

describe("setSimSetting", () => {
  const BASE = `stock S = 1\nchange(S) = 0\nsim dt=0.1 to=25 method=rk4\nplot S\n`;

  it("updates an existing key in place, leaving the others untouched", () => {
    const m = parseModel(setSimSetting(BASE, "dt", "0.5"));
    expect(m.settings.dt).toBe(0.5);
    expect(m.settings.to).toBe(25);
    expect(m.settings.method).toBe("rk4");
  });

  it("inserts a missing key onto the existing sim line", () => {
    const out = setSimSetting(BASE, "start", "3");
    expect(out.match(/^sim\b/m)).toBeTruthy();
    expect(out.match(/\bsim\b/g)!.length).toBe(1); // didn't add a second sim line
    expect(parseModel(out).settings.start).toBe(3);
  });

  it("appends a fresh sim line when the source has none", () => {
    const noSim = `stock S = 1\nchange(S) = 0\n`;
    const out = setSimSetting(noSim, "dt", "0.25");
    expect(parseModel(out).settings.dt).toBe(0.25);
  });

  it("changes the time unit setting without disturbing dt/to/method", () => {
    const m = parseModel(setSimSetting(BASE, "method", "euler"));
    expect(m.settings.method).toBe("euler");
    expect(m.settings.dt).toBe(0.1);
  });

  it("is idempotent: setting a value it already has is a no-op for the model", () => {
    const once = setSimSetting(BASE, "dt", "0.1");
    expect(fingerprint(parseModel(once))).toBe(fingerprint(parseModel(BASE)));
    expect(parseModel(once).settings.dt).toBe(0.1);
  });
});

describe("setParamValue", () => {
  const M = `stock S [kg] = 5\nparam rate [1/s] = 0.7   # the doc comment\nflow f = rate * S\nchange(S) = f\nsim dt=0.1 to=10\nplot S\n`;

  it("rebinds a param while preserving its [unit] and trailing # comment", () => {
    const out = setParamValue(M, "rate", 0.42);
    expect(out).toMatch(/param rate \[1\/s\] = 0\.42\s+# the doc comment/);
    const m = parseModel(out);
    expect(m.varIndex.get("rate")?.unit).toBe("1/s");
  });

  it("rebinds a stock's initial value, keeping its unit", () => {
    const out = setParamValue(M, "S", 12);
    const m = parseModel(out);
    expect(m.stocks.find((s) => s.name === "S")?.unit).toBe("kg");
    // the new init takes effect at t=start
    expect(simulate(m).series.get("S")![0]).toBe(12);
  });

  it("leaves the source unchanged when the name isn't a param/const/stock", () => {
    expect(setParamValue(M, "nope", 1)).toBe(M);
    expect(setParamValue(M, "f", 1)).toBe(M); // a flow is not rebindable this way
  });

  it("the rebound value actually moves the simulation (end-to-end)", () => {
    const before = simulate(parseModel(M)).series.get("S")!.at(-1)!;
    const after = simulate(parseModel(setParamValue(M, "rate", 1.4))).series.get("S")!.at(-1)!;
    expect(after).toBeGreaterThan(before); // faster growth → larger final stock
  });
});

describe("round-trip invariant across all built-in examples", () => {
  for (const ex of EXAMPLES) {
    it(`"${ex.name}": setSimSetting changes only the setting, not the structure`, () => {
      const before = parseModel(ex.source);
      const after = parseModel(setSimSetting(ex.source, "dt", "0.05"));
      expect(fingerprint(after)).toBe(fingerprint(before));
      expect(after.settings.dt).toBe(0.05);
      // every *other* setting is preserved
      expect(after.settings.to).toBe(before.settings.to);
      expect(after.settings.method).toBe(before.settings.method);
      expect(after.settings.start).toBe(before.settings.start);
    });

    it(`"${ex.name}": setParamValue on the first param preserves the structure`, () => {
      const before = parseModel(ex.source);
      const firstParam = before.vars.find((v) => v.kind === "param"); // `const` parses to param kind
      if (!firstParam) return; // some examples have no rebindable param
      const after = parseModel(setParamValue(ex.source, firstParam.name, 0.123456));
      expect(fingerprint(after)).toBe(fingerprint(before));
      // settings are untouched by a param edit
      expect(after.settings).toEqual(before.settings);
    });
  }
});
