import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { leverageLadder, MEADOWS_RUNGS, describeModel } from "../../src/engine/index.js";
import { handlers } from "../../src/mcp.js";

// CONTRACT: `# @rung N` in a doc comment places a param/switch/scenario on
// Meadows' ladder; `leverageLadder` measures every tagged lever on a metric
// and lists the untagged ones instead of guessing.

const SRC = `stock Cash = 100
param pay = 10            # @rung 12 the number
param lag = 2             # @rung 9
switch save = off         # @rung 10 pay the Safe first
param untagged = 1
flow net = pay * if(save, 1.5, 1) + 0 * lag + 0 * untagged
change(Cash) = net
scenario frugal pay=8     # @rung 12 trim the line
scenario plain pay=9
sim dt=1 to=10 method=euler`;

describe("@rung tags", () => {
  it("are parsed off the doc comment, leaving the rest of the doc", () => {
    const m = parseModel(SRC);
    expect(m.varIndex.get("pay")!.rung).toBe(12);
    expect(m.varIndex.get("pay")!.doc).toBe("the number");
    expect(m.varIndex.get("lag")!.rung).toBe(9);
    expect(m.varIndex.get("lag")!.doc).toBeUndefined();
    expect(m.varIndex.get("save")!.rung).toBe(10);
    expect(m.varIndex.get("untagged")!.rung).toBeUndefined();
    expect(m.scenarios.get("frugal")!.rung).toBe(12);
    expect(m.scenarios.get("frugal")!.doc).toBe("trim the line");
    expect(describeModel(m).vars.find((v) => v.name === "pay")!.rung).toBe(12);
  });

  it("warn and are ignored outside 1…12", () => {
    const m = parseModel(`stock S = 0\nparam a = 1   # @rung 13\nchange(S) = a`);
    expect(m.varIndex.get("a")!.rung).toBeUndefined();
    expect(m.diagnostics.some((d) => /@rung 13/.test(d.message))).toBe(true);
  });

  it("names all twelve rungs", () => {
    expect(Object.keys(MEADOWS_RUNGS)).toHaveLength(12);
    expect(MEADOWS_RUNGS[1]).toMatch(/transcend/);
  });
});

describe("leverageLadder", () => {
  it("measures each tagged lever on the metric and lists the untagged", async () => {
    const r = await leverageLadder(parseModel(SRC), "final:Cash");
    expect(r.base).toBe(200);
    expect(r.rungs.map((g) => g.rung)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    const r12 = r.rungs[0]!;
    expect(r12.levers.map((l) => l.name).sort()).toEqual(["frugal", "pay"]);
    expect(r12.levers.find((l) => l.kind === "scenario")!.delta).toBe(-20); // pay 8 ⇒ 80 + 100
    expect(r12.levers.find((l) => l.kind === "param")!.delta).toBeCloseTo(20, 9); // ±1 ⇒ 190 → 210
    const r10 = r.rungs.find((g) => g.rung === 10)!;
    expect(r10.best!.kind).toBe("switch");
    expect(r10.best!.delta).toBe(50);
    expect(r.rungs.find((g) => g.rung === 9)!.best!.delta).toBe(0); // lag does nothing here
    expect(r.rungs.find((g) => g.rung === 1)!.levers).toEqual([]);
    expect(r.ranking[0]).toBe(10);
    expect(r.untagged).toEqual([{ kind: "param", name: "untagged" }, { kind: "scenario", name: "plain" }]);
  });

  it("is exposed over MCP and refuses an untagged model", async () => {
    const r = JSON.parse((await handlers.flow_leverage({ model: SRC, metric: "final:Cash" })).content[0]!.text);
    expect(r.rungs.map((g: { rung: number }) => g.rung)).toEqual([12, 10, 9]);
    await expect(handlers.flow_leverage({ model: "stock S = 0\nparam a = 1\nchange(S) = a", metric: "final:S" })).rejects.toThrow(/nothing is tagged/);
  });
});
