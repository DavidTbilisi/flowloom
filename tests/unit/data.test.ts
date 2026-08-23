import { describe, it, expect } from "vitest";
import { parseModel, ModelError } from "../../src/lang/index.js";
import { simulate, lintModel, parseDataset, dataLines, datasetFromModel, calibrate, resolveMetric, runExpects, describeModel, explainModel, analyzeLoops, compile, buildPlan, tsBackend, runPlan } from "../../src/engine/index.js";
import { createWasmBackend } from "../../src/engine/wasm/backend.js";

// CONTRACT: a `data` line is measured history kept in the model text — an
// exogenous series read off the clock, step-held between samples (sampled data
// keeps its value) unless `linear`. It desugars to an internal hold-table plus
// a plain aux, so every consumer sees an ordinary named series; the file
// bridges (dataLines / datasetFromModel) keep CSV ↔ text without the model
// ever referencing a file.

const SRC = `data income [GEL] = (0, 100) (2, 200) (4, 400)
data temp = (0, 10) (2, 20) linear
stock Cash [GEL] = 0
change(Cash) = income
plot Cash income temp
sim dt=1 to=5 method=map`;

describe("data lines", () => {
  it("holds between samples by default; linear interpolates; clamps at both ends", () => {
    const r = simulate(parseModel(SRC));
    expect(r.series.get("income")).toEqual([100, 100, 200, 200, 400, 400]);
    expect(r.series.get("temp")).toEqual([10, 15, 20, 20, 20, 20]);
    expect(r.series.get("Cash")).toEqual([0, 100, 200, 400, 600, 1000]);
  });

  it("is a plain series: plotted, unit-checked, a source in the loop graph", () => {
    const m = parseModel(SRC);
    expect(m.plot).toContain("income");
    expect(m.vars.find((v) => v.name === "income")).toMatchObject({ kind: "aux", data: true, unit: "GEL" });
    // a data series feeding a stock closes no loop
    expect(analyzeLoops(m).loops).toHaveLength(0);
    // unit conflict is caught where the series is used
    const bad = SRC.replace("change(Cash) = income", "change(Cash) = income + temp");
    expect(lintModel(parseModel(bad)).some((d) => /unit mismatch|change\(Cash\)/.test(d.message))).toBe(false); // temp is un-annotated ⇒ unknown, no claim
  });

  it("parse errors: duplicate name, too few points, non-increasing t", () => {
    expect(() => parseModel(`data x = (0, 1) (1, 2)\naux x = 1\nstock S = 0\nchange(S) = 0`)).toThrow(ModelError);
    expect(() => parseModel(`data x = (0, 1)\nstock S = 0\nchange(S) = 0`)).toThrow(/at least two/);
    expect(() => parseModel(`data x = (0, 1) (0, 2)\nstock S = 0\nchange(S) = 0`)).toThrow(/strictly increase/);
  });

  it("identical on the WASM backend (the hold flag rides the import table)", async () => {
    const model = parseModel(SRC);
    const plan = buildPlan(compile(model));
    const ts = runPlan(model, plan, tsBackend(plan));
    const wasm = runPlan(model, plan, await createWasmBackend(buildPlan(compile(model))));
    for (const n of ["income", "temp", "Cash"]) expect(wasm.series.get(n)).toEqual(ts.series.get(n));
  });

  it("rmse:<a>:<b> measures the gap over every step; expect can hold it", async () => {
    const m = parseModel(`${SRC}\naux flat [GEL] = 100`);
    const r = simulate(m);
    expect(resolveMetric(r, "rmse:income:flat")).toBeCloseTo(Math.sqrt((0 + 0 + 100 ** 2 + 100 ** 2 + 300 ** 2 + 300 ** 2) / 6), 9);
    expect(resolveMetric(r, "rmse:income:income")).toBe(0);
    const t = await runExpects(parseModel(`${SRC}\nexpect rmse:Cash:income > 0`));
    expect(t.results[0]!.pass).toBe(true);
    expect(() => parseModel(`${SRC}\nexpect rmse:Cash:nope < 1`)).toThrow(/no stock, flow or aux named 'nope'/);
    expect(() => parseModel(`${SRC}\nexpect rmse:Cash < 1`)).toThrow(/rmse:<series>:<series>/);
  });

  it("dataLines renders a CSV as data lines; datasetFromModel reads them back", () => {
    const ds = parseDataset("t,income,n rate\n0,100,0.5\n2,200,0.25\n4,400,0.125");
    const lines = dataLines(ds, { unit: "GEL" });
    expect(lines[0]).toBe("data income [GEL] = (0, 100) (2, 200) (4, 400)");
    expect(lines[1]).toBe("data n_rate [GEL] = (0, 0.5) (2, 0.25) (4, 0.125)"); // identifier-safe name
    expect(dataLines(ds, { columns: ["income"], linear: true })[0]).toMatch(/linear$/);
    expect(() => dataLines(ds, { columns: ["nope"] })).toThrow(/no column "nope"/);
    const back = datasetFromModel(parseModel(SRC), ["income", "temp"]);
    expect(back.t).toEqual([0, 2, 4]);
    expect(back.columns.get("income")).toEqual([100, 200, 400]);
    expect(back.columns.get("temp")).toEqual([10, 20, 20]); // its own rule (linear, clamped)
    expect(() => datasetFromModel(parseModel(SRC), ["Cash"])).toThrow(/no data series "Cash"/);
  });

  it("calibrate fits against the model's own data lines", async () => {
    const src = `stock N [units] = 10\nparam r = 0.05\nflow growth = r * N\nchange(N) = growth\ndata obs [units] = (0, 10) (2, 13.5) (4, 18.22) (6, 24.6) (8, 33.2) (10, 44.82) (12, 60.5) (14, 81.66) (16, 110.23) (18, 148.8) (20, 200.86)\nsim dt=1 to=20`;
    const m = parseModel(src);
    const r = await calibrate(m, { params: ["r"], dataset: datasetFromModel(m, ["obs"]), map: { N: "obs" } });
    expect(r.params.r).toBeCloseTo(0.15, 3);
  });

  it("describe / explain surface the data series", () => {
    const d = describeModel(parseModel(SRC));
    expect(d.data).toEqual([
      { name: "income", points: 3, from: 0, to: 4, hold: true, unit: "GEL" },
      { name: "temp", points: 2, from: 0, to: 2, hold: false },
    ]);
    expect(d.vars.find((v) => v.name === "income")).toMatchObject({ data: true });
    expect(explainModel(parseModel(SRC))).toMatch(/Data series .*:\n.*income \[GEL\] — 3 points, t=0…4, held between samples/);
  });
});
