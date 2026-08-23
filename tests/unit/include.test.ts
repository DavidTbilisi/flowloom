import { describe, it, expect } from "vitest";
import { parseModel, resolveIncludes, hasIncludes } from "../../src/lang/index.js";
import { simulate, analyzeLoops, applyOverride, leverageLadder } from "../../src/engine/index.js";

// CONTRACT: `include "part.flow" as ns` composes models from parts while the
// toolchain keeps operating on ONE text — resolution is a pure source-to-source
// pass (reader injected): child names arrive prefixed `ns.`, bindings rebind a
// child default (number/on/off) or wire a parent signal into a child input
// (anything else: the child param becomes an aux in the parent's scope), and
// the child's sim/plot/scenario/expect lines are inert comments. Nothing
// downstream knows includes exist.

const ENGINE = `# a reusable engine
stock Assets [GEL] = 0
param invest = 0.6     # @rung 10 the sweep share
switch on = off
param cashIn [GEL] = 0
flow investing [GEL] = if(on, invest * max(0, cashIn), 0)
aux payout [GEL] = 0.01 * Assets
change(Assets) = investing
sim dt=1 to=5 method=map
plot Assets
scenario hot invest=0.9
expect final:Assets >= 0`;

const MAIN = `include "engine.flow" as eng cashIn=excess on=on invest=0.5
stock Cash [GEL] = 1000
aux excess [GEL] = max(0, Cash - 500)
change(Cash) = 100 + eng.payout - eng.investing
sim dt=1 to=5 method=map
plot Cash eng.Assets`;

const FILES: Record<string, string> = { "engine.flow": ENGINE, "main.flow": MAIN };
const read = (p: string): string => {
  const t = FILES[p];
  if (t === undefined) throw new Error("no such file");
  return t;
};

describe("include resolution", () => {
  it("namespaces every child name, applies bindings, and the result runs", () => {
    expect(hasIncludes(MAIN)).toBe(true);
    expect(hasIncludes(ENGINE)).toBe(false);
    const text = resolveIncludes(MAIN, { read });
    const m = parseModel(text);
    // names arrived prefixed; the binding rewired cashIn to the parent signal
    expect(m.stocks.map((s) => s.name).sort()).toEqual(["Cash", "eng.Assets"]);
    expect(m.varIndex.get("eng.cashIn")).toMatchObject({ kind: "aux" });
    expect(m.varIndex.get("eng.invest")!.expr).toMatchObject({ kind: "num", value: 0.5 });
    expect(m.varIndex.get("eng.on")).toMatchObject({ boolean: true });
    // the child's sim/plot/scenario/expect are inert; the parent's stand
    expect(m.settings.to).toBe(5);
    expect(m.scenarios.size).toBe(0);
    expect(m.expects).toHaveLength(0);
    expect(m.plot).toEqual(["Cash", "eng.Assets"]);
    // and it computes: Cash 1000 → excess 500 → invest half of it each step
    const r = simulate(m);
    expect(r.series.get("eng.Assets")![1]).toBe(250);
    // rung tags survive the rename (leverage sees eng.invest on rung 10)
    expect(m.varIndex.get("eng.invest")!.rung).toBe(10);
  });

  it("loops and overrides cross the namespace boundary", async () => {
    const m = parseModel(resolveIncludes(MAIN, { read }));
    const loops = analyzeLoops(m);
    expect(loops.loops.some((l) => l.nodes.includes("eng.investing") && l.nodes.includes("Cash"))).toBe(true);
    applyOverride(m, "eng.invest=0.25");
    expect(simulate(m).series.get("eng.Assets")![1]).toBe(125);
    const lev = await leverageLadder(m, "final:eng.Assets", 0.1);
    expect(lev.rungs.find((g) => g.rung === 10)!.levers.some((l) => l.name === "eng.invest")).toBe(true);
  });

  it("nested includes namespace twice; cycles and reused namespaces are errors", () => {
    const files: Record<string, string> = {
      ...FILES,
      "mid.flow": `include "engine.flow" as inner cashIn=feed\nstock Pool [GEL] = 10\naux feed [GEL] = Pool\nchange(Pool) = inner.payout\nsim dt=1 to=3`,
      "top.flow": `include "mid.flow" as mid\nstock S = 0\nchange(S) = mid.inner.payout\nsim dt=1 to=3`,
      "a.flow": `include "b.flow" as b\nstock A = 0\nchange(A) = 0`,
      "b.flow": `include "a.flow" as a\nstock B = 0\nchange(B) = 0`,
    };
    const rd = (p: string) => { const t = files[p]; if (t === undefined) throw new Error("no such file"); return t; };
    const m = parseModel(resolveIncludes(files["top.flow"]!, { read: rd }));
    expect(m.stocks.map((s) => s.name).sort()).toEqual(["S", "mid.Pool", "mid.inner.Assets"]);
    expect(m.varIndex.get("mid.inner.cashIn")).toMatchObject({ kind: "aux" }); // still wired to mid.feed
    expect(() => resolveIncludes(files["a.flow"]!, { read: rd, dir: "" })).toThrow(/include cycle: a.flow → b.flow → a.flow|include cycle: b.flow/);
    expect(() => resolveIncludes(`include "engine.flow" as eng\ninclude "engine.flow" as eng\nstock S = 0\nchange(S) = 0`, { read: rd })).toThrow(/namespace 'eng' is already used/);
  });

  it("errors teach: missing file, unknown binding key, a switch bound to an expression, unparseable child", () => {
    expect(() => resolveIncludes(`include "nope.flow" as x`, { read })).toThrow(/cannot read nope.flow/);
    expect(() => resolveIncludes(`include "engine.flow" as e typo=1`, { read })).toThrow(/no param, switch, const, or stock named 'typo'/);
    expect(() => resolveIncludes(`include "engine.flow" as e on=Cash`, { read })).toThrow(/switch 'on' takes on or off/);
    const bad = { "broken.flow": "stock = nope" };
    expect(() => resolveIncludes(`include "broken.flow" as b`, { read: (p) => bad[p as keyof typeof bad]! })).toThrow(/does not parse/);
    // a raw include line reaching the parser is a located, helpful error
    expect(() => parseModel(MAIN)).toThrow(/flowloom bundle/);
  });

  it("relative paths resolve against the including file's directory", () => {
    const files: Record<string, string> = {
      "parts/engine.flow": ENGINE,
      "parts/mid.flow": `include "./engine.flow" as inner\nstock P = 0\nchange(P) = inner.payout`,
    };
    const rd = (p: string) => { const t = files[p]; if (t === undefined) throw new Error("no such file"); return t; };
    const text = resolveIncludes(`include "parts/mid.flow" as m\nstock S = 0\nchange(S) = 0\nsim dt=1 to=2`, { read: rd });
    expect(parseModel(text).stocks.map((s) => s.name)).toContain("m.inner.Assets");
  });

  it("matches the hand-merged model number for number", () => {
    const merged = `stock eng.Assets [GEL] = 0
param eng.invest = 0.5
switch eng.on = on
aux eng.cashIn [GEL] = excess
flow eng.investing [GEL] = if(eng.on, eng.invest * max(0, eng.cashIn), 0)
aux eng.payout [GEL] = 0.01 * eng.Assets
change(eng.Assets) = eng.investing
stock Cash [GEL] = 1000
aux excess [GEL] = max(0, Cash - 500)
change(Cash) = 100 + eng.payout - eng.investing
sim dt=1 to=5 method=map`;
    const a = simulate(parseModel(resolveIncludes(MAIN, { read })));
    const b = simulate(parseModel(merged));
    for (const n of ["Cash", "eng.Assets", "eng.investing", "eng.payout"]) expect(a.series.get(n)).toEqual(b.series.get(n));
  });
});
