import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { simulate, parseDataset, interpAt, rmse, nrmse, calibrate } from "../../src/engine/index.js";

describe("parseDataset", () => {
  it("parses CSV with a time column and named series", () => {
    const ds = parseDataset("time,Pop\n0,10\n5,20\n10,40");
    expect(ds.t).toEqual([0, 5, 10]);
    expect(ds.columns.get("Pop")).toEqual([10, 20, 40]);
  });

  it("auto-detects TSV and sorts by time", () => {
    const ds = parseDataset("t\tx\n10\t3\n0\t1\n5\t2");
    expect(ds.t).toEqual([0, 5, 10]);
    expect(ds.columns.get("x")).toEqual([1, 2, 3]);
  });

  it("uses the first column as time when none is named t/time", () => {
    const ds = parseDataset("when,a,b\n0,1,2\n1,3,4");
    expect(ds.t).toEqual([0, 1]);
    expect([...ds.columns.keys()]).toEqual(["a", "b"]);
  });

  it("skips comments and blank lines", () => {
    const ds = parseDataset("# header note\nt,y\n\n0,1\n2,5\n");
    expect(ds.t).toEqual([0, 2]);
  });
});

describe("fit helpers", () => {
  it("interpolates and clamps", () => {
    const t = [0, 10], y = [0, 100];
    expect(interpAt(t, y, 5)).toBe(50);
    expect(interpAt(t, y, -1)).toBe(0);
    expect(interpAt(t, y, 99)).toBe(100);
  });

  it("rmse is zero for an exact match and positive otherwise", () => {
    expect(rmse([1, 2, 3], [1, 2, 3])).toBe(0);
    expect(rmse([1, 2, 3], [1, 2, 4])).toBeGreaterThan(0);
  });

  it("nrmse normalizes by the observed range", () => {
    // error of 1 everywhere, observed range 10 ⇒ nrmse 0.1
    expect(nrmse([1, 6, 11], [0, 5, 10])).toBeCloseTo(0.1, 9);
  });
});

describe("calibrate", () => {
  it("recovers a known growth rate from synthetic data", async () => {
    // Generate data from the true model, then fit `rate` starting from a wrong guess.
    const truth = simulate(parseModel("stock Pop = 10\nparam rate = 0.08\nflow g = rate*Pop\nd(Pop)=g\nsim dt=1 to=20"));
    const rows = ["t,Pop", ...truth.t.map((tt, i) => `${tt},${truth.series.get("Pop")![i]}`)].join("\n");
    const ds = parseDataset(rows);

    const model = parseModel("stock Pop = 10\nparam rate = 0.2\nflow g = rate*Pop\nd(Pop)=g\nsim dt=1 to=20");
    const r = await calibrate(model, { params: ["rate"], dataset: ds });
    expect(r.params.rate).toBeCloseTo(0.08, 3);
    expect(r.residual).toBeLessThan(1e-3);
    expect(r.start.rate).toBeCloseTo(0.2, 9);
  });

  it("fits two params at once", async () => {
    const truth = simulate(parseModel("stock S = 5\nparam a = 0.3\nparam b = 1.5\nflow f = a*S + b\nd(S)=f\nsim dt=0.5 to=15"));
    const rows = ["t,S", ...truth.t.map((tt, i) => `${tt},${truth.series.get("S")![i]}`)].join("\n");
    const ds = parseDataset(rows);

    const model = parseModel("stock S = 5\nparam a = 0.1\nparam b = 0.1\nflow f = a*S + b\nd(S)=f\nsim dt=0.5 to=15");
    const r = await calibrate(model, { params: ["a", "b"], dataset: ds, map: { S: "S" } });
    expect(r.params.a).toBeCloseTo(0.3, 2);
    expect(r.params.b).toBeCloseTo(1.5, 1);
  });
});
