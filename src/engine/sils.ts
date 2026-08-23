// ── Shortest Independent Loop Set ───────────────────────────────────────────
// Enumerating every simple cycle is exponential and the count says little: a
// 9-stock budget has 270 loops, most of them the same few mechanisms threaded
// through different if() branches. The *cycle rank* of the influence graph —
// E − N + 1 per strongly connected component — is how many loops are actually
// independent; every other loop is a sum of those. Oliva (2004) picks that many
// shortest-first: the Shortest Independent Loop Set, a basis that reads as the
// model's fundamental feedback structure and is bounded by polynomial work, so
// it is complete even when enumeration had to stop.
//
// Construction (Horton's candidate set, directed): for every node v and every
// edge x→y inside the same strongly connected component, the closed walk
// v ⇝ x → y ⇝ v along shortest paths is a candidate; a minimum cycle basis is
// always contained in that set. Lengths come from BFS distance tables, so the
// candidates are sorted before any path is built, and the greedy pass — keep a
// candidate if it is independent of those kept, over GF(2) on edge-incidence
// vectors — stops as soon as the rank is met.
//
// One choice beyond Oliva: when the caller knows which links are flat in this
// run (`dead`), live loops are preferred — candidates are also generated over
// the live links alone and ranked ahead of the rest. Any independent set of
// rank size is a basis, so the result is still a SILS; it just reads as the
// structure *this run* exercises rather than the shortest text.

import type { Edge, InfluenceGraph, Loop } from "./loops.js";

export interface SilsResult {
  /** The independent loops, shortest first. */
  loops: Loop[];
  /** The cycle rank: how many independent loops the graph has. */
  rank: number;
  /** True when a basis of full rank was found (always, for a strongly connected digraph). */
  complete: boolean;
}

/** Tarjan's SCCs; returns component index per node. */
function sccs(nodes: string[], adj: Map<string, Edge[]>): Map<string, number> {
  const index = new Map<string, number>(), low = new Map<string, number>(), comp = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let next = 0, comps = 0;
  const visit = (v: string): void => {
    index.set(v, next); low.set(v, next); next++;
    stack.push(v); onStack.add(v);
    for (const e of adj.get(v) ?? []) {
      const w = e.to;
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      let w: string;
      do { w = stack.pop()!; onStack.delete(w); comp.set(w, comps); } while (w !== v);
      comps++;
    }
  };
  for (const n of nodes) if (!index.has(n)) visit(n);
  return comp;
}

const canon = (nodes: string[]): string => {
  const cyc = nodes.slice(0, -1); // nodes[] returns to nodes[0]
  let best = cyc.join(">");
  for (let i = 1; i < cyc.length; i++) { const r = [...cyc.slice(i), ...cyc.slice(0, i)].join(">"); if (r < best) best = r; }
  return best;
};

export interface SilsOptions {
  /** Links that are flat at every sample of the run — a loop through one never engages. */
  dead?: (e: Edge) => boolean;
}

export function independentLoops(graph: InfluenceGraph, opts: SilsOptions = {}): SilsResult {
  const dead = opts.dead ?? (() => false);
  const nodes = graph.nodes;
  const nodeIdx = new Map(nodes.map((n, i) => [n, i] as const));
  const adj = new Map<string, Edge[]>();
  for (const n of nodes) adj.set(n, []);
  for (const e of graph.edges) adj.get(e.from)?.push(e);
  const comp = sccs(nodes, adj);
  const edgeId = new Map(graph.edges.map((e, k) => [`${e.from}|${e.to}`, k] as const));

  // Cycle rank, per SCC, counting only edges inside the component.
  let rank = 0;
  const inner = new Map<number, { n: number; e: number }>();
  for (const n of nodes) { const c = comp.get(n)!; const s = inner.get(c) ?? { n: 0, e: 0 }; s.n++; inner.set(c, s); }
  for (const e of graph.edges) { const c = comp.get(e.from)!; if (comp.get(e.to) === c) inner.get(c)!.e++; }
  for (const s of inner.values()) if (s.e > 0) rank += s.e - s.n + 1;
  if (rank === 0) return { loops: [], rank: 0, complete: true };

  // Shortest-path trees from every node, within its component: over all links,
  // and over live links only (the same tree when nothing is dead).
  interface Tree { dist: Map<string, number>; prev: Map<string, Edge> }
  const bfs = (root: string, liveOnly: boolean): Tree => {
    const c = comp.get(root)!;
    const dist = new Map<string, number>([[root, 0]]);
    const prev = new Map<string, Edge>();
    const queue = [root];
    for (let q = 0; q < queue.length; q++) {
      const x = queue[q]!;
      for (const f of adj.get(x) ?? []) {
        if (comp.get(f.to) !== c || dist.has(f.to) || (liveOnly && dead(f))) continue;
        dist.set(f.to, dist.get(x)! + 1); prev.set(f.to, f); queue.push(f.to);
      }
    }
    return { dist, prev };
  };
  const anyDead = graph.edges.some(dead);
  const treesAll = new Map<string, Tree>();
  const treesLive = new Map<string, Tree>();
  for (const n of nodes) {
    if ((inner.get(comp.get(n)!)?.e ?? 0) === 0) continue;
    treesAll.set(n, bfs(n, false));
    if (anyDead) treesLive.set(n, bfs(n, true));
  }
  // Path root ⇝ x from a tree, as edges.
  const pathTo = (tree: Tree, x: string): Edge[] => {
    const out: Edge[] = [];
    for (let cur = x; tree.prev.has(cur); cur = tree.prev.get(cur)!.from) out.unshift(tree.prev.get(cur)!);
    return out;
  };

  // Candidates by (live, length), built lazily.
  interface Cand { len: number; live: boolean; v: string; e: Edge; trees: Map<string, Tree> }
  const cands: Cand[] = [];
  for (const e of graph.edges) {
    const c = comp.get(e.from)!;
    if (comp.get(e.to) !== c) continue;
    if (e.from === e.to) { cands.push({ len: 1, live: !dead(e), v: e.from, e, trees: treesAll }); continue; }
    for (const v of nodes) {
      if (comp.get(v) !== c) continue;
      const dx = treesAll.get(v)!.dist.get(e.from), dv = treesAll.get(e.to)!.dist.get(v);
      if (dx !== undefined && dv !== undefined) cands.push({ len: dx + 1 + dv, live: false, v, e, trees: treesAll });
      if (anyDead && !dead(e)) {
        const lx = treesLive.get(v)!.dist.get(e.from), lv = treesLive.get(e.to)!.dist.get(v);
        if (lx !== undefined && lv !== undefined) cands.push({ len: lx + 1 + lv, live: true, v, e, trees: treesLive });
      }
    }
  }
  if (!anyDead) for (const cd of cands) cd.live = true;
  cands.sort((a, b) => Number(b.live) - Number(a.live) || a.len - b.len || nodeIdx.get(a.v)! - nodeIdx.get(b.v)! || edgeId.get(`${a.e.from}|${a.e.to}`)! - edgeId.get(`${b.e.from}|${b.e.to}`)!);

  // GF(2) elimination on edge-incidence bitsets: keep a candidate if it does
  // not reduce to zero against the basis kept so far.
  const basis: Array<{ vec: bigint; pivot: bigint }> = [];
  const reduce = (v: bigint): bigint => {
    for (const b of basis) if (v & b.pivot) v ^= b.vec;
    return v;
  };
  const topBit = (v: bigint): bigint => { let p = 1n; while (p <= v) p <<= 1n; return p >> 1n; };
  const seen = new Set<string>();
  const loops: Loop[] = [];
  for (const cd of cands) {
    if (loops.length >= rank) break;
    let cycle: Edge[];
    if (cd.e.from === cd.e.to) cycle = [cd.e];
    else {
      const a = pathTo(cd.trees.get(cd.v)!, cd.e.from);   // v ⇝ x
      const b = pathTo(cd.trees.get(cd.e.to)!, cd.v);     // y ⇝ v
      cycle = [...a, cd.e, ...b];
      // Simple cycle only: the two paths may not share a node besides v.
      const ns = new Set<string>();
      let simple = true;
      for (const f of cycle) { if (ns.has(f.to)) { simple = false; break; } ns.add(f.to); }
      if (!simple) continue;
    }
    const key = canon([cycle[0]!.from, ...cycle.map((f) => f.to)]);
    if (seen.has(key)) continue;
    seen.add(key);
    let vec = 0n;
    for (const f of cycle) vec |= 1n << BigInt(edgeId.get(`${f.from}|${f.to}`)!);
    const r = reduce(vec);
    if (r === 0n) continue;
    basis.push({ vec: r, pivot: topBit(r) });
    basis.sort((a, b) => (a.pivot > b.pivot ? -1 : a.pivot < b.pivot ? 1 : 0));
    loops.push(makeLoop(rotate(cycle, nodeIdx)));
  }
  return { loops, rank, complete: loops.length === rank };
}

/** Start the cycle at its lowest-index node, the way findLoops reports it. */
function rotate(cycle: Edge[], nodeIdx: Map<string, number>): Edge[] {
  let best = 0;
  for (let i = 1; i < cycle.length; i++) if (nodeIdx.get(cycle[i]!.from)! < nodeIdx.get(cycle[best]!.from)!) best = i;
  return [...cycle.slice(best), ...cycle.slice(0, best)];
}

function makeLoop(edges: Edge[]): Loop {
  const neg = edges.filter((e) => e.sign < 0).length;
  const ambiguous = edges.some((e) => e.sign === 0);
  const polarity: Loop["polarity"] = ambiguous ? "?" : neg % 2 === 0 ? "R" : "B";
  const nodes = [edges[0]!.from, ...edges.map((e) => e.to)];
  return { nodes, edges, polarity, trace: [polarity], flips: false, active: polarity !== "?", independent: true };
}

export { canon as loopKey };
