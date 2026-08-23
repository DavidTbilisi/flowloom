import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { analyzeLoops, independentLoops, findLoops } from "../../src/engine/index.js";
import type { InfluenceGraph } from "../../src/engine/index.js";
import { handlers } from "../../src/mcp.js";

// CONTRACT: the shortest independent loop set (Oliva 2004) is a basis of the
// influence graph's cycle space — exactly cycle-rank many loops (E − N + 1 per
// strongly connected component), every other loop a GF(2) sum of them. It is
// built by polynomial work from the graph, so it is complete even when simple-
// cycle enumeration had to stop; live loops are preferred when the run says
// which links are flat, and the set is still a basis.

const g = (edges: Array<[string, string]>): InfluenceGraph => {
  const nodes = [...new Set(edges.flat())];
  return { nodes, edges: edges.map(([from, to]) => ({ from, to, sign: 1 as const })) };
};

describe("independentLoops", () => {
  it("rank is E − N + 1 per strongly connected component; a DAG has none", () => {
    expect(independentLoops(g([["a", "b"], ["b", "c"]])).rank).toBe(0);
    // one 3-cycle: rank 1
    expect(independentLoops(g([["a", "b"], ["b", "c"], ["c", "a"]]))).toMatchObject({ rank: 1, complete: true });
    // two cycles sharing an edge (a→b→a and a→b→c→a): E=4, N=3 ⇒ rank 2
    const r = independentLoops(g([["a", "b"], ["b", "a"], ["b", "c"], ["c", "a"]]));
    expect(r).toMatchObject({ rank: 2, complete: true });
    expect(r.loops.map((l) => l.nodes.join(">")).sort()).toEqual(["a>b>a", "a>b>c>a"]);
    // two disjoint components each with a 2-cycle, joined by a one-way edge: rank 2
    expect(independentLoops(g([["a", "b"], ["b", "a"], ["b", "c"], ["c", "d"], ["d", "c"]])).rank).toBe(2);
    // a self-loop counts
    expect(independentLoops(g([["x", "x"], ["x", "y"], ["y", "x"]])).rank).toBe(2);
  });

  it("picks shortest first and is independent: a 4-node complete digraph has rank 9, all 2-cycles chosen", () => {
    const nodes = ["a", "b", "c", "d"];
    const edges: Array<[string, string]> = [];
    for (const u of nodes) for (const v of nodes) if (u !== v) edges.push([u, v]);
    const r = independentLoops(g(edges)); // E=12, N=4 ⇒ 9
    expect(r).toMatchObject({ rank: 9, complete: true });
    expect(r.loops.filter((l) => l.nodes.length === 3)).toHaveLength(6); // the six 2-cycles (nodes[] closes back)
    expect(r.loops.filter((l) => l.nodes.length === 4)).toHaveLength(3);
    // and it spans: every enumerated loop reduces to zero against the basis
    const all = findLoops(g(edges)).loops;
    expect(all.length).toBe(20); // 6 + 8 + 6
    const id = new Map(edges.map((e, k) => [e.join("|"), k]));
    const vec = (l: { edges: Array<{ from: string; to: string }> }) => l.edges.reduce((v, e) => v | (1n << BigInt(id.get(`${e.from}|${e.to}`)!)), 0n);
    const basis = r.loops.map(vec);
    const reduces = (v: bigint): boolean => {
      // brute force: some subset of the basis XORs to v
      for (let m = 1; m < 1 << basis.length; m++) {
        let x = 0n;
        for (let i = 0; i < basis.length; i++) if (m & (1 << i)) x ^= basis[i]!;
        if (x === v) return true;
      }
      return false;
    };
    for (const l of all) expect(reduces(vec(l))).toBe(true);
  });

  it("prefers live loops when told which links are dead, and stays a full basis", () => {
    // a→b→a (live) and a→c→a (dead via c→a): same length; without `dead` the tie breaks alphabetically
    const graph = g([["a", "b"], ["b", "a"], ["a", "c"], ["c", "a"], ["b", "c"]]); // rank 3
    const plain = independentLoops(graph);
    const live = independentLoops(graph, { dead: (e) => e.from === "c" && e.to === "a" });
    expect(plain.rank).toBe(3);
    expect(live).toMatchObject({ rank: 3, complete: true });
    const names = live.loops.map((l) => l.nodes.join(">"));
    expect(names[0]).toBe("a>b>a"); // the live 2-cycle first
    expect(names.some((n) => n.includes("c>a"))).toBe(true); // the dead edge still has to be spanned
  });
});

describe("loop report basis", () => {
  const SRC = `stock S = 10\nstock I = 1\nparam r = 0.1\nswitch brake = off\nflow g = r * S\nflow b = if(brake, 0.2 * S, 0)\nflow h = 0.05 * S * I\nchange(S) = g - b - h\nchange(I) = h - 0.1 * I\nsim dt=0.5 to=10 method=euler`;

  it("flags the basis loops in the report and counts the rank", () => {
    const r = analyzeLoops(parseModel(SRC));
    expect(r.rank).toBeGreaterThan(0);
    expect(r.independent).toBe(r.rank);
    expect(r.loops.filter((l) => l.independent)).toHaveLength(r.rank);
    // the live growth loop is in the basis; the gated brake loop is too (it is its own rank), marked inactive
    const basis = r.loops.filter((l) => l.independent);
    expect(basis.some((l) => l.nodes.join(">") === "S>g>S" && l.active)).toBe(true);
    expect(basis.some((l) => l.nodes.includes("b") && !l.active)).toBe(true);
  });

  it("when enumeration is capped the basis is still complete and its loops are in the report", () => {
    // A dense model: 9 fully-coupled auxes around one stock — far more simple cycles than MAX_LOOPS.
    const names = "abcdefghi".split("");
    const lines = [`stock X = 1`];
    for (const n of names) lines.push(`aux ${n} = 0.01 * (X${names.filter((m) => m !== n).map((m) => ` + ${m}`).join("")})`.replace(/\+ (\w)/g, "+ 0.1 * $1"));
    lines.push(`change(X) = 0.001 * (${names.join(" + ")}) - 0.01 * X`, `sim dt=1 to=3 method=euler`);
    // auxes referencing each other instantaneously form an algebraic loop — so thread them through previous():
    const src = lines.join("\n").replace(/\+ 0\.1 \* (\w)/g, "+ 0.1 * previous($1)");
    const r = analyzeLoops(parseModel(src));
    expect(r.capped).toBe(true);
    expect(r.independent).toBe(r.rank);
    expect(r.rank).toBeGreaterThan(0);
    // every basis loop is present in loops[] (possibly appended past the cap)
    expect(r.loops.filter((l) => l.independent)).toHaveLength(r.rank);
  });

  it("MCP flow_loops basis:true returns only the basis with the rank", async () => {
    const r = JSON.parse((await handlers.flow_loops({ model: SRC, basis: true, all: true })).content[0]!.text);
    expect(r.rank).toBeGreaterThan(0);
    expect(r.loops).toHaveLength(r.rank);
    expect(r.loops.every((l: { independent?: boolean }) => l.independent)).toBe(true);
  });
});
