import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { analyzeLoops, loopDominance, explainModel } from "../../src/engine/index.js";
import { handlers } from "../../src/mcp.js";

// CONTRACT: loop polarity is read along the actual run, not only at t=start —
// a gated loop resolves once its gate opens, a loop that never engages is
// reported inactive with the flat link named, a loop that changes sign is
// flagged; and `loopDominance` ranks active loops by knockout.

describe("polarity along the trajectory", () => {
  it("logistic growth is R at start and flips to B as the ceiling bites", () => {
    const r = analyzeLoops(parseModel(`stock P = 5\nparam r = 0.7\nparam K = 1000\nflow g = r*P*(1 - P/K)\nd(P) = g\nsim dt=0.1 to=25`));
    const l = r.loops[0]!;
    expect(l.polarity).toBe("R"); // the start reading is kept (contract)
    expect(l.flips).toBe(true);
    expect(l.trace[0]).toBe("R");
    expect(l.trace.at(-1)).toBe("B");
    expect(r.flipping).toBe(1);
    expect(r.sampleTimes.length).toBeGreaterThan(8);
  });

  it("a gated loop is '?' at start and resolves when the gate opens", () => {
    // spending only kicks in above a threshold the stock crosses later
    const src = `stock S = 0\nparam gate = 5\nflow fill = 2\nflow leak = if(S > gate, 0.5 * S, 0)\nd(S) = fill - leak\nsim dt=1 to=20 method=euler`;
    const r = analyzeLoops(parseModel(src));
    const l = r.loops.find((x) => x.nodes.includes("leak"))!;
    expect(l.trace[0]).toBe("?");
    expect(l.polarity).toBe("B");
    expect(l.active).toBe(true);
    expect(l.resolvedAt).toBeGreaterThan(0);
    expect(r.counts.B).toBe(1);
    // start-only reading still gives "?"
    expect(analyzeLoops(parseModel(src), { samples: 1 }).loops.find((x) => x.nodes.includes("leak"))!.polarity).toBe("?");
  });

  it("a loop through a branch that never runs is inactive, with the flat link named", () => {
    const src = `stock S = 1\nswitch brake = off\nflow g = 0.1 * S\nflow b = if(brake, 0.2 * S, 0)\nd(S) = g - b\nsim dt=1 to=10 method=euler`;
    const r = analyzeLoops(parseModel(src));
    const dead = r.loops.find((x) => x.nodes.includes("b"))!;
    expect(dead.active).toBe(false);
    expect(dead.polarity).toBe("?");
    expect(dead.deadLinks).toEqual([{ from: "S", to: "b" }]);
    expect(r.inactive).toBe(1);
    expect(r.loops.find((x) => x.nodes.includes("g"))!.active).toBe(true);
    expect(explainModel(parseModel(src))).toMatch(/never engage/);
  });

  it("drops the phantom self-loop of the map idiom change(X) = (next - X) / dt", () => {
    const src = `stock X = 1\naux next = 2 * X\nchange(X) = (next - X) / dt\nsim dt=1 to=5 method=euler`;
    const r = analyzeLoops(parseModel(src));
    expect(r.loops.map((l) => l.nodes.join(">"))).toEqual(["X>next>X"]);
    // a real self-dependence is kept
    const real = analyzeLoops(parseModel(`stock X = 1\nchange(X) = (X * 1.1 - X) / dt\nsim dt=1 to=5 method=euler`));
    expect(real.loops.map((l) => l.nodes.join(">"))).toEqual(["X>X"]);
    // the idiom with a transfer term on the side — (next − X) / dt − out — is still the idiom
    const out = analyzeLoops(parseModel(`stock X = 1\nstock Y = 0\naux next = 2 * X\nflow out = 0.1 * next\nchange(X) = (next - X) / dt - out\nchange(Y) = out\nsim dt=1 to=5 method=euler`));
    expect(out.loops.map((l) => l.nodes.join(">")).sort()).toEqual(["X>next>X", "X>next>out>X"]); // no X>X
  });

  it("under method=map the bare A − X (− out) is the idiom; under euler it is goal-seeking", () => {
    const map = `stock X = 1\nstock Y = 0\naux next = 2 * X\nflow out = 0.1 * next\nchange(X) = next - X - out\nchange(Y) = out\nsim dt=1 to=5 method=map`;
    expect(analyzeLoops(parseModel(map)).loops.map((l) => l.nodes.join(">")).sort()).toEqual(["X>next>X", "X>next>out>X"]); // no X>X
    const euler = `stock X = 1\nparam goal = 10\nchange(X) = goal - X\nsim dt=0.1 to=5 method=euler`;
    expect(analyzeLoops(parseModel(euler)).loops.map((l) => `${l.polarity}:${l.nodes.join(">")}`)).toEqual(["B:X>X"]);
  });
});

describe("loop dominance by knockout", () => {
  const SIR = `stock S = 990\nstock I = 10\nstock R = 0\nparam beta = 0.3\nparam gamma = 0.1\nflow infection = beta * S * I / 1000\nflow recovery = gamma * I\nd(S) = -infection\nd(I) = infection - recovery\nd(R) = recovery\nsim dt=0.5 to=100`;

  it("ranks active loops by how far cutting a link moves the metric", async () => {
    const d = await loopDominance(parseModel(SIR), "max:I");
    expect(d.rows).toHaveLength(3);
    expect(d.base).toBeGreaterThan(10);
    const cut = d.rows.find((r) => r.cut.from === "S" && r.cut.to === "infection")!;
    expect(cut.runaway).toBe(true); // no depletion ⇒ I explodes
    const recovery = d.rows.find((r) => r.nodes.includes("recovery"))!;
    expect(recovery.delta).toBeGreaterThan(0); // no recovery ⇒ a bigger peak
    const spread = d.rows.find((r) => r.cut.from === "I" && r.cut.to === "infection")!;
    expect(spread.delta).toBeLessThan(0); // frozen contagion ⇒ a smaller peak
    expect(d.inactive).toBe(0);
  });

  it("never cuts a transfer flow's link into a stock while another link is available", async () => {
    // Cash → investing → Cash: investing leaves Cash and enters Assets. Cutting
    // investing → Cash would create money; the honest cut is Cash → investing.
    const src = `stock Cash = 100\nstock Assets = 0\nparam r = 0.1\nflow investing = r * Cash\nflow earn = 0.05 * Assets\nd(Cash) = earn - investing\nd(Assets) = investing\nsim dt=1 to=10 method=euler`;
    const d = await loopDominance(parseModel(src), "final:Cash");
    const self = d.rows.find((r) => r.nodes.join(">") === "Cash>investing>Cash")!;
    expect(self.cut).toEqual({ from: "Cash", to: "investing" });
    expect(self.note).toBeUndefined();
  });

  it("skips inactive loops and counts them", async () => {
    const src = `stock S = 1\nswitch brake = off\nflow g = 0.1 * S\nflow b = if(brake, 0.2 * S, 0)\nd(S) = g - b\nsim dt=1 to=10 method=euler`;
    const d = await loopDominance(parseModel(src), "final:S");
    expect(d.rows).toHaveLength(1);
    expect(d.inactive).toBe(1);
  });

  it("is exposed over MCP with the metric on flow_loops", async () => {
    const r = JSON.parse((await handlers.flow_loops({ model: SIR, metric: "max:I" })).content[0]!.text);
    expect(r.loops).toHaveLength(3);
    expect(r.dominance.rows).toHaveLength(3);
    expect(r.samples).toBeGreaterThan(1);
  });
});
