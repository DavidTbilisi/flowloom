import { describe, it, expect } from "vitest";
import { parseModel, printModel } from "../../src/lang/index.js";
import { runExpects } from "../../src/engine/expect.js";

// ── `expect always` ─────────────────────────────────────────────────────────
// CONTRACT: a metric expect reduces a run to one number; `always` is a claim
// about every recorded step. It can compare two series, state an implication,
// and — the reason it exists — say *where* it first broke.

describe("expect always", () => {
  const model = (...lines: string[]) => `stock Inventory = 100
stock Capacity = 120
param demand = 12
flow ship = min(demand, Inventory)
change(Inventory) = -ship
change(Capacity) = 0
sim dt=1 to=12 method=euler
${lines.join("\n")}`;

  it("holds across every recorded step", async () => {
    const r = await runExpects(parseModel(model("expect always Inventory >= 0")));
    expect(r.failed).toBe(0);
    expect(r.results[0]!.broke).toEqual({ steps: 0, of: 13 });
    expect(r.results[0]!.brokeAt).toBeUndefined();
  });

  it("compares two series — which no metric reduction can", async () => {
    const r = await runExpects(parseModel(model("expect always Inventory <= Capacity")));
    expect(r.failed).toBe(0);
  });

  it("says where it first broke, and with what values", async () => {
    const r = await runExpects(parseModel(model("expect always ship == demand")));
    expect(r.failed).toBe(1);
    const x = r.results[0]!;
    expect(x.brokeAt!.t).toBe(8);
    expect(x.brokeAt!.values).toEqual([{ name: "ship", value: 4 }, { name: "demand", value: 12 }]);
    expect(x.broke).toEqual({ steps: 5, of: 13 });
    expect(x.actual).toBe(5); // steps at which the claim was false
  });

  it("states an implication as `!a || b`", async () => {
    // "a shipment is only ever short because the shelf could not cover it"
    const holds = await runExpects(parseModel(model("expect always !(ship < demand) || ship == Inventory")));
    expect(holds.failed).toBe(0);
    // …and the stronger reading — short only once empty — is false at t=8,
    // where 4 units were left and 12 were wanted.
    const breaks = await runExpects(parseModel(model("expect always !(ship < demand) || Inventory <= 0")));
    expect(breaks.results[0]!.brokeAt!.t).toBe(8);
  });

  it("reads the clock and a constant alongside the series", async () => {
    const r = await runExpects(parseModel(model("expect always t <= 12 && ship <= demand")));
    expect(r.failed).toBe(0);
    expect(r.results[0]!.broke).toEqual({ steps: 0, of: 13 });
  });

  it("runs under a named scenario like any other claim", async () => {
    const src = model("scenario lean demand=50", "expect lean always Inventory >= 0", "expect always ship == demand");
    const r = await runExpects(parseModel(src));
    expect(r.scenarios.sort()).toEqual(["base", "lean"]);
    expect(r.results.find((x) => x.scenario === "lean")!.pass).toBe(true);
  });

  it("round-trips through fmt", () => {
    const src = model("expect always Inventory >= 0");
    const printed = printModel(parseModel(src));
    expect(printed).toContain("expect always Inventory >= 0");
    expect(printModel(parseModel(printed))).toBe(printed);
  });

  it("names an unknown name at parse time, not at run time", () => {
    expect(() => parseModel(model("expect always Inventry >= 0")))
      .toThrow(/expect always: unknown name 'Inventry' — did you mean 'Inventory'/);
  });

  it("needs a condition", () => {
    expect(() => parseModel(model("expect always"))).toThrow(/needs a condition/);
  });

  it("is not mistaken for a scenario name", () => {
    // The scenario slot is "the leading token without a colon", which would
    // otherwise swallow `always`.
    const r = parseModel(model("expect always Inventory >= 0"));
    expect(r.expects[0]!.scenario).toBeUndefined();
    expect(r.expects[0]!.always).toBeDefined();
  });

  it("indexes a subscripted series, and rejects the bare vector", async () => {
    const src = `dim region = North, South
stock Pop [region] = 10, 20
change(Pop[region]) = 0
sim dt=1 to=3 method=euler
expect always Pop[South] >= Pop[North]`;
    expect((await runExpects(parseModel(src))).failed).toBe(0);
    expect(() => parseModel(src.replace("Pop[South] >= Pop[North]", "Pop >= 0")))
      .toThrow(/'Pop' is subscripted over \[region\]/);
  });
});
