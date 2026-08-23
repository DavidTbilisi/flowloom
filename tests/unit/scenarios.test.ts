import { describe, it, expect } from "vitest";
import { parseModel, scalarize } from "../../src/lang/index.js";
import { applyOverride, applyScenario, compareScenarios, simulate, sensitivity, globalSensitivity, describeModel, explainModel } from "../../src/engine/index.js";
import { setParamValue, setScenarioValue } from "../../src/ui/model-edit.js";
import { handlers } from "../../src/mcp.js";

// CONTRACT: `switch` is a two-state param (0/1, on/off) that sensitivity tests
// off→on; `scenario` is a named override set kept in the text, applied through
// the same path as --set, and `compare` tabulates base vs each scenario.

const SRC = `stock Cash = 1000
param pay = 500
switch save = off      # pay savings first
aux spend = if(save, 300, 450)
flow net = pay - spend
change(Cash) = net
scenario thrifty save=on
scenario rich: pay=900 Cash=2000 save=on   # after the raise
sim dt=1 to=10 method=euler
plot Cash`;

const final = (m = parseModel(SRC)) => simulate(m).series.get("Cash")!.at(-1)!;

describe("switch", () => {
  it("parses on/off and 0/1 as a boolean param", () => {
    const m = parseModel(SRC);
    const sw = m.varIndex.get("save")!;
    expect(sw.kind).toBe("param");
    expect(sw.boolean).toBe(true);
    expect(sw.expr).toMatchObject({ kind: "num", value: 0 });
    expect(parseModel(`stock S = 0\nchange(S) = 0\nswitch a = 1\nswitch b = true\nswitch c = NO`).vars.map((v) => (v.expr as { value: number }).value)).toEqual([1, 1, 0]);
  });

  it("rejects anything but a two-state value", () => {
    expect(() => parseModel(`stock S = 0\nchange(S) = 0\nswitch a = 0.5`)).toThrow(/must be on or off/);
    expect(() => parseModel(`stock S = 0\nchange(S) = 0\nswitch a = S`)).toThrow(/must be on or off/);
    expect(() => parseModel(`stock S = 0\nchange(S) = 0\nswitch a [people] = 1`)).toThrow(/can't carry a unit/);
  });

  it("--set accepts on/off and refuses in-between values", () => {
    const m = parseModel(SRC);
    applyOverride(m, "save=on");
    expect(final(m)).toBe(1000 + 10 * 200);
    expect(() => applyOverride(parseModel(SRC), "save=0.5")).toThrow(/switch/);
  });

  it("sensitivity tests a switch off → on instead of ±frac", async () => {
    const r = await sensitivity(parseModel(SRC), [], "final:Cash");
    const row = r.rows.find((x) => x.param === "save")!;
    expect(row.switch).toBe(true);
    expect(row.low).toBe(1000 + 10 * 50);
    expect(row.high).toBe(1000 + 10 * 200);
    expect(row.delta).toBe(1500); // was Δ=0 with a ±0.1 bump of 0
    expect(r.rows.find((x) => x.param === "pay")!.switch).toBeUndefined();
  });

  it("global sensitivity samples a switch as {0, 1}", async () => {
    const r = await globalSensitivity(parseModel(SRC), { method: "morris", metric: "final:Cash", params: ["save"], samples: 4 });
    expect(r.rows.find((x) => x.param === "save")!.muStar).toBeGreaterThan(0);
  });

  it("is written back to the text as on/off", () => {
    expect(setParamValue("switch save = off   # doc", "save", 1)).toBe("switch save = on   # doc");
    expect(setParamValue("switch save = on", "save", 0)).toBe("switch save = off");
  });

  it("shows up in describe/explain", () => {
    const d = describeModel(parseModel(SRC));
    expect(d.vars.find((v) => v.name === "save")!.switch).toBe(true);
    expect(explainModel(parseModel(SRC))).toMatch(/Switches/);
  });
});

describe("scenario", () => {
  it("parses bindings (with or without a colon) and keeps the doc string", () => {
    const m = parseModel(SRC);
    expect([...m.scenarios.keys()]).toEqual(["thrifty", "rich"]);
    expect(m.scenarios.get("rich")!.sets).toEqual([{ key: "pay", value: "900" }, { key: "Cash", value: "2000" }, { key: "save", value: "on" }]);
    expect(m.scenarios.get("rich")!.doc).toBe("after the raise");
    expect(scalarize(m).scenarios.size).toBe(2); // carried through lowering
  });

  it("validates every key and value at parse time", () => {
    const base = `stock S = 0\nparam k = 1\nswitch on1 = on\nchange(S) = k\n`;
    expect(() => parseModel(base + "scenario a kk=2")).toThrow(/no param, switch, stock, or sim setting named 'kk' — did you mean 'k'/);
    expect(() => parseModel(base + "scenario a on1=0.5")).toThrow(/switch 'on1' must be on or off/);
    expect(() => parseModel(base + "scenario a k=fast")).toThrow(/'k' must be a number/);
    expect(() => parseModel(base + "scenario a method=leapfrog")).toThrow(/method must be euler, rk4 or map/);
    expect(() => parseModel(base + "scenario base k=2")).toThrow(/'base' is the model itself/);
    expect(() => parseModel(base + "scenario a k")).toThrow(/expected key=value/);
    expect(() => parseModel(base + "scenario a")).toThrow(/needs at least one key=value/);
    expect(parseModel(base + "scenario a k=1 k=2").diagnostics.some((d) => /more than once/.test(d.message))).toBe(true);
  });

  it("warns when a var is named like a sim setting (overrides would miss it)", () => {
    const m = parseModel(`stock S = 0\nparam start = 5\nchange(S) = start`);
    expect(m.diagnostics.some((d) => /'start' is also a sim setting/.test(d.message))).toBe(true);
  });

  it("applies like --set, and base is a no-op", () => {
    const m = parseModel(SRC);
    expect(applyScenario(m, "base")).toEqual([]);
    expect(final(m)).toBe(1500);
    applyScenario(m, "rich");
    expect(final(m)).toBe(2000 + 10 * 600);
    expect(() => applyScenario(parseModel(SRC), "richh")).toThrow(/did you mean "rich"/);
  });

  it("compare runs base first and reports deltas per metric", async () => {
    const r = await compareScenarios(parseModel(SRC), ["final:Cash", "min:Cash"]);
    expect(r.rows.map((x) => x.scenario)).toEqual(["base", "thrifty", "rich"]);
    expect(r.rows[0]!.values).toEqual([1500, 1000]);
    expect(r.rows[0]!.delta).toBeUndefined();
    expect(r.rows[1]!.values[0]).toBe(3000);
    expect(r.rows[1]!.delta).toEqual([1500, 0]);
    expect(r.rows[2]!.sets).toEqual(["pay=900", "Cash=2000", "save=on"]);
    const sub = await compareScenarios(parseModel(SRC), ["final:Cash"], ["rich"]);
    expect(sub.rows.map((x) => x.scenario)).toEqual(["base", "rich"]);
  });

  it("is listed by describe/explain", () => {
    const d = describeModel(parseModel(SRC));
    expect(d.scenarios.map((s) => s.name)).toEqual(["thrifty", "rich"]);
    expect(explainModel(parseModel(SRC))).toMatch(/Scenarios/);
  });

  it("MCP tools take a scenario and flow_compare tabulates", async () => {
    const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);
    const run = parse(await handlers.flow_run({ model: SRC, plot: ["Cash"], scenario: "thrifty" }));
    expect(run.series.Cash.at(-1)).toBe(3000);
    const cmp = parse(await handlers.flow_compare({ model: SRC, metrics: ["final:Cash"] }));
    expect(cmp.rows.map((x: { scenario: string }) => x.scenario)).toEqual(["base", "thrifty", "rich"]);
  });

  it("setScenarioValue edits one binding on the scenario line", () => {
    const src = "scenario rich: pay=900 save=on   # after the raise";
    expect(setScenarioValue(src, "rich", "pay", "950")).toBe("scenario rich: pay=950 save=on   # after the raise");
    expect(setScenarioValue(src, "rich", "Cash", "2000")).toBe("scenario rich: pay=900 save=on Cash=2000   # after the raise");
    expect(setScenarioValue(src, "poor", "pay", "1")).toBe(src);
  });
});
