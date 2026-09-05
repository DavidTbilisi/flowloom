import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { causesTree, usesTree, renderTree, documentModel, renderDocument } from "../../src/engine/trace.js";
import { handlers } from "../../src/mcp.js";

const SIR = `stock S [people] = 999
stock I [people] = 1
stock R [people] = 0
param beta = 0.3
param gamma = 0.1
param N = 1000
flow infection = beta * S * I / N
flow recovery = gamma * I
change(S) = -infection
change(I) = infection - recovery
change(R) = recovery
sim dt=0.25 to=60 method=rk4`;

const names = (n: { children: Array<{ name: string }> }) => n.children.map((c) => c.name).sort();

describe("causes tree", () => {
  it("includes params — they are the levers a causes tree exists to find", () => {
    // structure() in loops.ts drops params on purpose (a constant carries no
    // feedback), which is why this walks the parsed Model rather than the
    // compiled one: "what determines the infection rate" is answered by beta
    // as much as by S.
    const t = causesTree(parseModel(SIR), "infection", { depth: 1 });
    expect(names(t)).toEqual(["I", "N", "S", "beta"]);
    expect(t.children.find((c) => c.name === "beta")!.kind).toBe("param");
  });

  it("signs each edge the way the diagram does", () => {
    const t = causesTree(parseModel(SIR), "infection", { depth: 1 });
    const sign = (n: string) => t.children.find((c) => c.name === n)!.sign;
    expect(sign("beta")).toBe(1);
    expect(sign("S")).toBe(1);
    expect(sign("N")).toBe(-1);
  });

  it("a stock's causes are what changes it, not what it started at", () => {
    const t = causesTree(parseModel(SIR), "S", { depth: 1 });
    expect(names(t)).toEqual(["infection"]);
    expect(t.children[0]!.sign).toBe(-1);
    expect(t.children[0]!.via).toBe("rate");
  });

  it("follows the initial value only when asked", () => {
    const src = "param start0 = 5\nstock X = start0\nchange(X) = 1\nsim dt=1 to=2";
    expect(names(causesTree(parseModel(src), "X", { depth: 1 }))).toEqual([]);
    const withInit = causesTree(parseModel(src), "X", { depth: 1, init: true });
    expect(names(withInit)).toEqual(["start0"]);
    expect(withInit.children[0]!.via).toBe("init");
  });

  it("closes a branch that loops back instead of unrolling forever", () => {
    const t = causesTree(parseModel(SIR), "infection", { depth: 6 });
    const s = t.children.find((c) => c.name === "S")!;
    expect(s.children[0]).toMatchObject({ name: "infection", cycle: true });
    expect(s.children[0]!.children).toEqual([]);
  });

  it("marks what the depth limit cut off", () => {
    const t = causesTree(parseModel(SIR), "infection", { depth: 1 });
    expect(t.children.find((c) => c.name === "S")!.more).toBe(1);
    expect(t.children.find((c) => c.name === "beta")!.more).toBeUndefined();
  });

  it("names the model's own symbols when the target isn't one", () => {
    expect(() => causesTree(parseModel(SIR), "infektion")).toThrow(/did you mean "infection"/);
  });
});

describe("uses tree — the reverse index", () => {
  it("answers what breaks if I change this", () => {
    const t = usesTree(parseModel(SIR), "beta", { depth: 2 });
    expect(names(t)).toEqual(["infection"]);
    expect(names(t.children[0]!)).toEqual(["I", "S"]);
  });

  it("is signed from the reader's equation, not the target's", () => {
    // infection lowers S and raises I: the sign belongs to the edge, so the two
    // children of `infection` disagree even though the parent is the same.
    const t = usesTree(parseModel(SIR), "infection", { depth: 1 });
    expect(t.children.find((c) => c.name === "S")!.sign).toBe(-1);
    expect(t.children.find((c) => c.name === "I")!.sign).toBe(1);
  });

  it("reports a name nothing reads", () => {
    const src = `${SIR}\nparam unused = 1`;
    expect(usesTree(parseModel(src), "unused").children).toEqual([]);
  });
});

describe("declared links are traced too", () => {
  const sketch = "link population -> births +\nlink births -> population +\nlink population -> deaths +\nlink deaths -> population -";

  it("works on a model with no equations at all", () => {
    const t = causesTree(parseModel(sketch), "population", { depth: 1 });
    expect(names(t)).toEqual(["births", "deaths"]);
    expect(t.children.map((c) => c.via)).toEqual(["link", "link"]);
    expect(t.children.find((c) => c.name === "deaths")!.sign).toBe(-1);
  });
});

describe("subscripted models", () => {
  const src = `dim region = North, South
stock Pop [region] = 100
param rate = 0.02
flow births [region] = rate * Pop[region]
change(Pop[region]) = births[region]
sim dt=1 to=5 method=euler`;

  it("traces an element on the lowered model, with real signs", () => {
    const t = causesTree(parseModel(src), "Pop[North]", { depth: 2 });
    expect(t.name).toBe("Pop.North");
    expect(names(t)).toEqual(["births.North"]);
    expect(t.children[0]!.sign).toBe(1);
    expect(names(t.children[0]!)).toEqual(["Pop.North", "rate"]);
  });

  it("accepts the already-scalar spelling", () => {
    expect(causesTree(parseModel(src), "Pop.South").name).toBe("Pop.South");
  });

  it("still shows structure for the bare vector, with signs unread", () => {
    // `births[region]` has no value until scalarization, so the honest answer
    // is "?" rather than a made-up sign.
    const t = causesTree(parseModel(src), "Pop", { depth: 1 });
    expect(names(t)).toEqual(["births"]);
    expect(t.children[0]!.sign).toBe(0);
  });
});

describe("document", () => {
  const doc = () => documentModel(parseModel(SIR));

  it("carries the reverse index for every name", () => {
    const beta = doc().find((e) => e.name === "beta")!;
    expect(beta.kind).toBe("param");
    expect(beta.usedBy).toEqual([{ name: "infection", sign: 1, via: "equation" }]);
    expect(beta.uses).toEqual([]);
  });

  it("shows a stock's init and its change() separately", () => {
    const s = doc().find((e) => e.name === "S")!;
    expect(s.init).toBe("999");
    expect(s.definition).toBe("change(S) = -infection");
    expect(s.unit).toBe("people");
  });

  it("covers every declared name", () => {
    expect(doc().map((e) => e.name).sort()).toEqual(["I", "N", "R", "S", "beta", "gamma", "infection", "recovery"]);
  });

  it("says so when nothing reads a name", () => {
    expect(renderDocument(documentModel(parseModel(`${SIR}\nparam unused = 1`))))
      .toMatch(/unused.*\n.*def.*\n.*nothing reads it/);
  });
});

describe("rendering", () => {
  it("draws signs, kinds and the cycle marker", () => {
    const s = renderTree(causesTree(parseModel(SIR), "infection", { depth: 2 }));
    expect(s.split("\n")[0]).toBe("infection  [flow]");
    expect(s).toContain("├─ + beta  [param]");
    expect(s).toContain("− infection  [flow] ↺");
  });
});

describe("MCP surface", () => {
  const json = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

  it("flow_causes and flow_uses return both the tree and the rendering", () => {
    const c = json(handlers.flow_causes({ model: SIR, name: "infection", depth: 1 }));
    expect(c.tree.children.map((x: { name: string }) => x.name).sort()).toEqual(["I", "N", "S", "beta"]);
    expect(c.rendered).toContain("+ beta");
    expect(json(handlers.flow_uses({ model: SIR, name: "gamma", depth: 1 })).tree.children[0].name).toBe("recovery");
  });

  it("flow_document lists every name with its readers", () => {
    const d = json(handlers.flow_document({ model: SIR }));
    expect(d.entries.find((e: { name: string }) => e.name === "gamma").usedBy[0].name).toBe("recovery");
  });

  it("flow_scenarios reports the declared experiments", () => {
    const src = `${SIR}\nscenario distancing beta=0.15   # @rung 5`;
    const r = json(handlers.flow_scenarios({ model: src }));
    expect(r.scenarios).toEqual([{ name: "distancing", sets: [{ key: "beta", value: "0.15" }], rung: 5 }]);
  });

  it("flow_data turns a CSV into data lines", () => {
    const r = json(handlers.flow_data({ csv: "t,obs\n0,1\n1,2\n2,4\n", unit: "people" }));
    expect(r.lines[0]).toMatch(/^data obs \[people\] = \(0, ?1\)/);
    expect(r.rows).toBe(3);
  });

  it("flow_bundle inlines the parts it is handed", () => {
    const main = 'include "income.flow" as inc\nstock Cash = 0\nchange(Cash) = inc.wage\nsim dt=1 to=2';
    const part = "param wage = 10\nstock Paid = 0\nchange(Paid) = wage\nsim dt=1 to=9";
    const r = json(handlers.flow_bundle({ model: main, parts: { "income.flow": part } }));
    expect(r.inlined).toBe(1);
    expect(r.bundled).toContain("param inc.wage = 10");
    expect(r.bundled).toContain("# (from include, inert) sim dt=1 to=9");
  });

  it("flow_bundle says which part it is missing rather than reading the disk", () => {
    const main = 'include "income.flow" as inc\nstock Cash = 0\nchange(Cash) = 1\nsim dt=1 to=2';
    expect(() => handlers.flow_bundle({ model: main })).toThrow(/no text supplied for include "income.flow"/);
  });

  it("flow_reference serves the same catalog as the resource", () => {
    expect(json(handlers.flow_reference({ format: "json" })).some((e: { name: string }) => e.name === "stock")).toBe(true);
    expect(handlers.flow_reference({}).content[0]!.text).toMatch(/stock/);
  });
});
