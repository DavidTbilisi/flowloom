import type { Model } from "../lang/types.js";
import { freeVars } from "../lang/expr.js";
import { evalExpr, type EvalCtx } from "./eval.js";
import { compile } from "./compile.js";

// ── Feedback-loop detection ─────────────────────────────────────────────────
// A signed influence graph: an edge u → v carries the sign of ∂v/∂u, read at
// the model's initial operating point by numerical perturbation. A loop's
// polarity is the product of its edge signs — an even number of negatives is
// REINFORCING (R), odd is BALANCING (B). Polarity is read at t=start; nonlinear
// models can change loop polarity as they evolve, which we note in the UI.

export interface Edge {
  from: string;
  to: string;
  sign: -1 | 0 | 1;
}

export interface InfluenceGraph {
  nodes: string[];
  edges: Edge[];
}

export interface Loop {
  /** Node sequence; the loop returns to nodes[0]. */
  nodes: string[];
  edges: Edge[];
  polarity: "R" | "B" | "?";
}

export interface LoopReport {
  graph: InfluenceGraph;
  loops: Loop[];
  capped: boolean;
  counts: { R: number; B: number; "?": number };
}

const MAX_LOOPS = 400;

export function analyzeLoops(model: Model): LoopReport {
  const graph = influenceGraph(model);
  const { loops, capped } = findLoops(graph);
  const counts = { R: 0, B: 0, "?": 0 };
  for (const l of loops) counts[l.polarity]++;
  return { graph, loops, capped, counts };
}

export function influenceGraph(model: Model): InfluenceGraph {
  const c = compile(model);
  const scope = operatingPoint(model);
  const ctx: EvalCtx = { scope, tables: c.tables };

  const nodes = new Set<string>([...c.state.map((s) => s.name), ...c.order.filter((v) => v.kind !== "param").map((v) => v.name)]);
  const edges: Edge[] = [];

  const linkFrom = (target: string, expr: Parameters<typeof freeVars>[0]) => {
    const sources = [...freeVars(expr)].filter((id) => nodes.has(id));
    if (sources.length === 0) return;
    const base = evalExpr(expr, ctx);
    for (const u of sources) {
      const x0 = scope[u]!;
      const h = 1e-6 * Math.max(1, Math.abs(x0));
      scope[u] = x0 + h;
      const up = evalExpr(expr, ctx);
      scope[u] = x0 - h;
      const dn = evalExpr(expr, ctx);
      scope[u] = x0;
      let sign: -1 | 0 | 1 = 0;
      if (Number.isFinite(up) && Number.isFinite(dn) && Number.isFinite(base)) {
        const slope = up - dn;
        sign = slope > 0 ? 1 : slope < 0 ? -1 : 0;
      }
      edges.push({ from: u, to: target, sign });
    }
  };

  for (const v of c.order) if (v.kind !== "param") linkFrom(v.name, v.expr);
  for (const s of c.state) if (s.rateExpr) linkFrom(s.name, s.rateExpr);

  return { nodes: [...nodes], edges };
}

/** The model's t=start scope (stocks at initial values, variables evaluated). */
function operatingPoint(model: Model): Record<string, number> {
  const c = compile(model);
  const scope: Record<string, number> = { t: model.settings.start, time: model.settings.start };
  for (const s of c.state) scope[s.name] = 0;
  for (const v of c.order) scope[v.name] = 0;
  const ctx: EvalCtx = { scope, tables: c.tables };
  const passes = c.state.length + c.order.length + 2;
  for (let p = 0; p < passes; p++) {
    for (const v of c.order) scope[v.name] = evalExpr(v.expr, ctx);
    for (const s of c.state) scope[s.name] = evalExpr(s.initExpr, ctx);
  }
  return scope;
}

// ── Simple-cycle enumeration ────────────────────────────────────────────────
// Canonicalize each cycle so it is found exactly once: only extend to nodes
// with a higher index than the start, and only close back to the start node.
export function findLoops(graph: InfluenceGraph): { loops: Loop[]; capped: boolean } {
  const adj = new Map<string, Edge[]>();
  for (const n of graph.nodes) adj.set(n, []);
  for (const e of graph.edges) if (e.from !== e.to) adj.get(e.from)!.push(e);

  const idx = new Map(graph.nodes.map((n, i) => [n, i] as const));
  const loops: Loop[] = [];
  let capped = false;

  // self-loops (a variable that directly feeds back into itself)
  for (const e of graph.edges) if (e.from === e.to) loops.push(makeLoop([e]));

  const dfs = (start: string, cur: string, path: Edge[], seen: Set<string>) => {
    if (loops.length >= MAX_LOOPS) {
      capped = true;
      return;
    }
    for (const e of adj.get(cur)!) {
      if (e.to === start) {
        loops.push(makeLoop([...path, e]));
      } else if (!seen.has(e.to) && idx.get(e.to)! > idx.get(start)!) {
        seen.add(e.to);
        dfs(start, e.to, [...path, e], seen);
        seen.delete(e.to);
      }
    }
  };

  for (const start of graph.nodes) {
    if (capped) break;
    dfs(start, start, [], new Set([start]));
  }
  return { loops, capped };
}

function makeLoop(edges: Edge[]): Loop {
  const neg = edges.filter((e) => e.sign < 0).length;
  const ambiguous = edges.some((e) => e.sign === 0);
  const polarity: Loop["polarity"] = ambiguous ? "?" : neg % 2 === 0 ? "R" : "B";
  const nodes = [edges[0]!.from, ...edges.map((e) => e.to)];
  return { nodes, edges, polarity };
}
