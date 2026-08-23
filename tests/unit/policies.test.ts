import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { searchPolicies, sensitivity, globalSensitivity, timeGrainParams, knobParams, describeModel, explainModel } from "../../src/engine/index.js";
import { handlers } from "../../src/mcp.js";

// CONTRACT: `const` is a structural constant (skipped by sensitivity/sliders
// unless named); time-grain knobs are bumped by ≥ one step; `policies`
// enumerates every combination of the switches still off and reports best,
// cheapest-to-target, and exact Shapley contributions.

// Cash gains `a` per step when A is on and `b` when B is on, plus a bonus when
// both are on — so Shapley must split the bonus evenly (interaction), while
// `alone` does not see it.
const SRC = `stock Cash = 0
switch A = off
switch B = off
switch world = on          # on as written: a fact, not a move
param a = 10
param b = 5
param bonus = 4
const yearLen = 12         # the calendar, not a knob
param lag = 2              # a time-grain knob: feeds delay_fixed
param startAt = 3          # a time-grain knob: compared with t
aux seen = delay_fixed(Cash, lag)
flow gain = if(A, a, 0) + if(B, b, 0) + if(A && B, bonus, 0) + if(t >= startAt, 1, 0) + if(world, 0, -100) + 0 * seen + 0 * yearLen
change(Cash) = gain
sim dt=1 to=10 method=euler`;

describe("const", () => {
  it("parses as a param flagged constant", () => {
    const m = parseModel(SRC);
    expect(m.varIndex.get("yearLen")!.kind).toBe("param");
    expect(m.varIndex.get("yearLen")!.constant).toBe(true);
    expect(m.varIndex.get("a")!.constant).toBeUndefined();
  });

  it("is skipped by sensitivity unless named explicitly", async () => {
    const m = parseModel(SRC);
    expect(knobParams(m, [])).not.toContain("yearLen");
    const r = await sensitivity(m, [], "final:Cash");
    expect(r.rows.map((x) => x.param)).not.toContain("yearLen");
    const named = await sensitivity(m, ["yearLen"], "final:Cash");
    expect(named.rows.map((x) => x.param)).toEqual(["yearLen"]);
  });

  it("shows up in describe/explain as a constant", () => {
    expect(describeModel(parseModel(SRC)).vars.find((v) => v.name === "yearLen")!.constant).toBe(true);
    expect(explainModel(parseModel(SRC))).toMatch(/Constants/);
  });
});

describe("time-grain knobs", () => {
  it("are detected through delay_fixed lengths and clock comparisons, transitively", () => {
    const g = timeGrainParams(parseModel(SRC));
    expect([...g].sort()).toEqual(["lag", "startAt"]);
    const via = parseModel(`stock S = 0\nparam n = 2\naux twice = 2 * n\naux d = delay_fixed(S, twice)\nchange(S) = d`);
    expect([...timeGrainParams(via)]).toEqual(["n"]);
  });

  it("are bumped by at least one step in sensitivity (a ±10% bump of 3 can't cross a step)", async () => {
    const r = await sensitivity(parseModel(SRC), ["startAt", "a"], "final:Cash");
    const s = r.rows.find((x) => x.param === "startAt")!;
    expect(s.step).toBe(1);
    expect(s.delta).not.toBe(0); // starting the +1/step a month earlier/later moves the total
    expect(r.rows.find((x) => x.param === "a")!.step).toBeUndefined();
  });

  it("flags a knob that is flat at its bump", async () => {
    const r = await sensitivity(parseModel(SRC), ["lag"], "final:Cash"); // lag feeds nothing that matters
    expect(r.rows[0]!.flat).toBe(true);
  });

  it("snap to whole steps in global sensitivity", async () => {
    const r = await globalSensitivity(parseModel(SRC), { method: "morris", metric: "final:Cash", params: ["startAt"], samples: 4 });
    expect(r.rows[0]!.muStar).toBeGreaterThan(0);
  });
});

describe("searchPolicies", () => {
  it("enumerates the switches still off, leaving on-as-written ones alone", async () => {
    const r = await searchPolicies(parseModel(SRC), { metric: "final:Cash" });
    expect(r.switches).toEqual(["A", "B"]);
    expect(r.runs).toBe(4);
    expect(r.base.on).toEqual([]);
    expect(r.base.value).toBe(7); // +1 per step for t = 3..9 (euler integrates t = 0..9), world on
    expect(r.best.on).toEqual(["A", "B"]);
    expect(r.best.value).toBe(7 + 10 * (10 + 5 + 4));
  });

  it("computes exact Shapley values: the interaction bonus is split evenly", async () => {
    const r = await searchPolicies(parseModel(SRC), { metric: "final:Cash" });
    const A = r.shapley.find((s) => s.switch === "A")!;
    const B = r.shapley.find((s) => s.switch === "B")!;
    expect(A.alone).toBe(100);
    expect(B.alone).toBe(50);
    expect(A.shapley).toBeCloseTo(100 + 20, 9);
    expect(B.shapley).toBeCloseTo(50 + 20, 9);
    expect(A.last).toBe(100 + 40);
    expect(A.shapley + B.shapley).toBeCloseTo(r.best.value - r.base.value, 9); // efficiency
  });

  it("finds the cheapest combination reaching a target, with costs", async () => {
    const r = await searchPolicies(parseModel(SRC), { metric: "final:Cash", target: 50, cost: { A: 5, B: 1 } });
    expect(r.cheapest!.on).toEqual(["B"]);
    expect(r.cheapest!.cost).toBe(1);
    const none = await searchPolicies(parseModel(SRC), { metric: "final:Cash", target: 1e9 });
    expect(none.cheapest).toBeNull();
  });

  it("can minimise, and honours an explicit switch list (even one on as written)", async () => {
    const r = await searchPolicies(parseModel(SRC), { metric: "final:Cash", goal: "min", switches: ["world"] });
    expect(r.asWritten.on).toEqual(["world"]);
    expect(r.best.on).toEqual([]); // world off ⇒ −100/step
    expect(r.best.value).toBeLessThan(r.asWritten.value);
  });

  it("rejects non-switches, unknown names, and too many switches", async () => {
    await expect(searchPolicies(parseModel(SRC), { metric: "final:Cash", switches: ["a"] })).rejects.toThrow(/not a switch/);
    await expect(searchPolicies(parseModel(SRC), { metric: "final:Cash", switches: ["Q"] })).rejects.toThrow(/no switch named "Q"/);
    await expect(searchPolicies(parseModel(SRC), { metric: "final:Cash", maxSwitches: 1 })).rejects.toThrow(/pick a subset/);
    await expect(searchPolicies(parseModel("stock S = 0\nchange(S) = 1"), { metric: "final:S" })).rejects.toThrow(/no `switch` lines/);
  });

  it("is exposed over MCP", async () => {
    const r = JSON.parse((await handlers.flow_policies({ model: SRC, metric: "final:Cash" })).content[0]!.text);
    expect(r.best.on).toEqual(["A", "B"]);
    expect(r.shapley).toHaveLength(2);
  });
});
