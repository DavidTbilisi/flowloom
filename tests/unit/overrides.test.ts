import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { applyOverride, simulate } from "../../src/engine/index.js";

// CONTRACT: `--set k=v` (CLI) / `set` (MCP) rebinds a param, a stock init, or a
// sim setting on the parsed Model via a constant-folded AST edit — an agent's
// what-if knob. Pin both that it edits the right thing and that its *errors
// teach the fix* (the override path is a common agent action with no other
// coverage).

const SRC = `stock S = 100
param k = 0.05
flow grow = k * S
change(S) = grow
sim dt=0.1 to=10 method=rk4
plot S`;

const model = () => parseModel(SRC);

describe("applyOverride: what it edits", () => {
  it("rebinds a param and the run reflects it", () => {
    const m = model();
    applyOverride(m, "k=0.2");
    // higher growth rate ⇒ larger final stock than the base 0.05
    const base = simulate(parseModel(SRC)).series.get("S")!.at(-1)!;
    expect(simulate(m).series.get("S")!.at(-1)!).toBeGreaterThan(base);
  });

  it("rebinds a stock's initial value", () => {
    const m = model();
    applyOverride(m, "S=10");
    expect(simulate(m).series.get("S")![0]).toBe(10);
  });

  it("rebinds sim settings (method/dt/to/start/seed)", () => {
    const m = model();
    applyOverride(m, "dt=0.5");
    applyOverride(m, "method=euler");
    applyOverride(m, "to=20");
    expect(m.settings.dt).toBe(0.5);
    expect(m.settings.method).toBe("euler");
    expect(m.settings.to).toBe(20);
  });

  it("warns (but still applies) when overriding a non-param var", () => {
    const m = model();
    const warnings = applyOverride(m, "grow=3"); // grow is a flow
    expect(warnings.some((w) => /overriding flow "grow"/.test(w))).toBe(true);
    expect(m.varIndex.get("grow")!.expr).toMatchObject({ kind: "num", value: 3 });
  });
});

describe("applyOverride: errors teach the fix", () => {
  it("a missing '=' is reported plainly", () => {
    expect(() => applyOverride(model(), "carrying")).toThrow(/expects key=value/);
  });

  it("an unknown key suggests the nearest real name (did-you-mean)", () => {
    // 'grw' → the flow 'grow'
    expect(() => applyOverride(model(), "grw=1")).toThrow(/no param, stock, or sim setting named "grw" — did you mean "grow"\?/);
  });

  it("a misspelled SETTING key blames the key, not the value (the bug fix)", () => {
    // Before: `methdo=rk4` fell through and reported "value must be a number" —
    // blaming the (correct) value rk4. Now it points at the typo'd key.
    expect(() => applyOverride(model(), "methdo=rk4")).toThrow(/named "methdo" — did you mean "method"\?/);
  });

  it("an unknown key with no near match still gets a recovery pointer", () => {
    expect(() => applyOverride(model(), "Popultion=50")).toThrow(/named "Popultion" \(overridable: params, stock inits, and dt\/to\/start\/seed\/method\)/);
  });

  it("a genuinely non-numeric value for a real param is reported as such", () => {
    expect(() => applyOverride(model(), "k=fast")).toThrow(/k: value must be a number, got "fast"/);
  });

  it("an invalid method value is rejected with the allowed set", () => {
    expect(() => applyOverride(model(), "method=heun")).toThrow(/method must be euler or rk4/);
  });
});
