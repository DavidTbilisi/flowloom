import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { describeModel, explainModel } from "../../src/engine/index.js";

const SRC = `# logistic growth
stock Population [people] = 5    # the herd
param birthRate = 0.7
param carrying  = 1000
flow growth = birthRate * Population * (1 - Population / carrying)
d(Population) = growth
sim dt=0.1 to=25 method=rk4
plot Population`;

describe("describeModel", () => {
  const d = describeModel(parseModel(SRC));

  it("captures stocks with init, unit, and doc", () => {
    expect(d.stocks).toEqual([{ name: "Population", init: "5", unit: "people", doc: "the herd" }]);
  });

  it("captures rates keyed by stock", () => {
    expect(d.rates).toContainEqual({ stock: "Population", expr: "growth" });
  });

  it("captures vars with kind and model-only deps", () => {
    const growth = d.vars.find((v) => v.name === "growth")!;
    expect(growth.kind).toBe("flow");
    // deps exclude builtins/constants — only the model's own names
    expect(growth.deps.sort()).toEqual(["Population", "birthRate", "carrying"]);
  });

  it("derives the feedback-loop summary", () => {
    expect(d.loops.counts.R + d.loops.counts.B).toBeGreaterThan(0);
  });

  it("is JSON-serializable", () => {
    expect(() => JSON.stringify(d)).not.toThrow();
  });
});

describe("explainModel", () => {
  const text = explainModel(parseModel(SRC));

  it("names stocks, knobs, and loops", () => {
    expect(text).toMatch(/Population/);
    expect(text).toMatch(/birthRate = 0.7/);
    expect(text).toMatch(/feedback loop/);
    expect(text).toMatch(/dt=0.1/);
  });
});
