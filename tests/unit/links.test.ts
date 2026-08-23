import { describe, it, expect } from "vitest";
import { parseModel, ModelError } from "../../src/lang/index.js";
import { analyzeLoops, simulate, lintModel, loopDominance, describeModel, explainModel } from "../../src/engine/index.js";

// CONTRACT: `link A -> B +|-` is a declared signed influence. A model of links
// alone is a causal-loop sketch — it parses, draws, and has R/B loops from the
// declared signs, but nothing integrates. Links can also sit beside equations.

const CITY = `link population -> births +
link births -> population +
link population -> deaths +
link deaths -> population -
link population -> crowding +
link crowding -> attractiveness -
link attractiveness -> migration +
link migration -> population +`;

describe("link lines", () => {
  it("parse with a sign and a doc, and a links-only model is valid", () => {
    const m = parseModel(CITY + "\nlink deaths -> crowding -   # fewer people, less crowding");
    expect(m.stocks).toHaveLength(0);
    expect(m.links).toHaveLength(9);
    expect(m.links[3]).toMatchObject({ from: "deaths", to: "population", sign: -1 });
    expect(m.links[8]!.doc).toBe("fewer people, less crowding");
  });

  it("reject a missing sign, a duplicate, and a reserved endpoint", () => {
    expect(() => parseModel("link a -> b")).toThrow(/needs a sign/);
    expect(() => parseModel("link a -> b +\nlink a -> b -")).toThrow(/declared twice/);
    expect(() => parseModel("link t -> b +")).toThrow(/reserved name/);
    expect(() => parseModel("param k = 1")).toThrow(ModelError); // still no stocks and no links
  });

  it("give a sketch its R/B loops from the declared signs", () => {
    const r = analyzeLoops(parseModel(CITY));
    expect(r.loops.map((l) => `${l.polarity}:${l.nodes.join(">")}`).sort()).toEqual([
      "B:population>crowding>attractiveness>migration>population",
      "B:population>deaths>population",
      "R:population>births>population",
    ]);
    expect(r.loops.every((l) => l.active && l.edges.every((e) => e.declared))).toBe(true);
    expect(r.sampleTimes).toHaveLength(1);
  });

  it("a sketch 'runs' to a note, not a crash; describe/explain say what it is", () => {
    const m = parseModel(CITY);
    expect(simulate(m).note).toMatch(/qualitative sketch/);
    const d = describeModel(m);
    expect(d.qualitative).toBe(true);
    expect(d.links).toHaveLength(8);
    expect(explainModel(m)).toMatch(/Causal-loop sketch: 6 nodes, 8 declared links/);
    expect(lintModel(m)).toEqual([]);
  });

  it("sit beside equations: a link adds an edge the equations don't carry, and lint flags one that duplicates them", () => {
    const src = `stock S = 1\nparam k = 0.1\nflow g = k * S\nchange(S) = g\nlink S -> morale +\nlink morale -> k +\nsim dt=1 to=5 method=euler`;
    const m = parseModel(src);
    const r = analyzeLoops(m);
    expect(r.graph.nodes).toContain("morale");
    expect(r.loops.some((l) => l.nodes.includes("morale") && l.polarity === "R")).toBe(true);
    expect(lintModel(m).some((d) => /declared sign overrides/.test(d.message))).toBe(false);
    const dup = parseModel(src + "\nlink S -> g -");
    expect(lintModel(dup).some((d) => /link S -> g is also an equation dependency/.test(d.message))).toBe(true);
    expect(describeModel(dup).qualitative).toBe(false);
  });

  it("are skipped by knockout (no equation to cut)", async () => {
    const d = await loopDominance(parseModel(CITY + "\nstock population = 1\nchange(population) = 0\nsim dt=1 to=5 method=euler"), "final:population");
    expect(d.rows).toHaveLength(0);
    expect(d.skipped.length).toBe(3);
    expect(d.skipped[0]!.reason).toMatch(/declared links only/);
  });
});
