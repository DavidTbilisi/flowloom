import type { Expr, Model } from "../lang/types.js";
import { freeVars } from "../lang/expr.js";
import { evalExpr, type EvalCtx } from "./eval.js";
import { compile, type Compiled } from "./compile.js";
import { buildPlan, tsBackend, makeSlotMap } from "./codegen.js";
import { runPlan } from "./simulator.js";

// ── Feedback-loop detection ─────────────────────────────────────────────────
// A signed influence graph: an edge u → v carries the sign of ∂v/∂u, read by
// numerical perturbation. A loop's polarity is the product of its edge signs —
// an even number of negatives is REINFORCING (R), odd is BALANCING (B).
//
// Signs depend on the operating point. Reading them only at t=start (the
// classic approach) leaves every gated link — `if(Cash > cushion, …)` before the
// cushion is reached, `month == 11` outside November — flat, and the loop
// through it "?". So the analyzer runs the model once and reads every link's
// sign at up to `samples` steps along the actual trajectory. A loop is *active*
// at a sample when every link in it is non-zero there; its reading at such a
// sample is the product of the signs. `polarity` is the reading at start when
// the loop is active there (stable for the simple models the contract tests
// pin); otherwise the reading at the first sample where it becomes active
// (`resolvedAt` says when), or "?" if it never does. `trace` carries the
// reading at every sample ("?" = inactive there) and `flips` is set when the
// active readings disagree along the run (logistic growth: R early, B as the
// ceiling bites). A loop that is never active has a link that is zero at every
// sample — typically the untaken branch of an if() or a gate that never opens in
// this run; it is reported as *inactive* with that link named, which for a
// policy model is the useful fact: flip the switch and the loop comes alive.

export type Polarity = "R" | "B" | "?";

export interface Edge {
  from: string;
  to: string;
  sign: -1 | 0 | 1;
  /** The sign was declared by a `link` line, not read from an equation. */
  declared?: true;
}

export interface InfluenceGraph {
  nodes: string[];
  edges: Edge[];
}

export interface Loop {
  /** Node sequence; the loop returns to nodes[0]. */
  nodes: string[];
  /** Edges with their sign at t=start (what the diagram draws). */
  edges: Edge[];
  /** Reading at start, or — when start is "?" — the later samples' agreed reading. */
  polarity: Polarity;
  /** Polarity at each of the report's `sampleTimes`. */
  trace: Polarity[];
  /** The polarity changed sign along the run (R ↔ B). */
  flips: boolean;
  /** Time of the first sample where a start-"?" loop became determined. */
  resolvedAt?: number;
  /** False when the loop never engages in this run: `deadLinks` are zero at every sample. */
  active: boolean;
  deadLinks?: Array<{ from: string; to: string }>;
}

export interface LoopReport {
  graph: InfluenceGraph;
  loops: Loop[];
  capped: boolean;
  /** "?" counts loops that never engage in this run (see Loop.active). */
  counts: { R: number; B: number; "?": number };
  /** Number of loops whose polarity flips along the run. */
  flipping: number;
  /** Number of loops that never engage in this run. */
  inactive: number;
  /** Times at which link signs were read (the first is t=start). */
  sampleTimes: number[];
}

export interface LoopOptions {
  /** Steps along the trajectory at which to read link signs (default: every
   *  step, up to 64 evenly spaced; 1 ⇒ start only). */
  samples?: number;
}

const MAX_LOOPS = 400;
// Simple-cycle enumeration is worst-case exponential (dense graphs — grids,
// fully-coupled models — have astronomically many cycles, and most DFS paths
// never close back to the start). MAX_LOOPS bounds the *results* but not the
// search tree, so we also bound the *work*: after this many edge traversals we
// stop and mark the report capped. Keeps loop analysis bounded-time on any model.
const MAX_TRAVERSALS = 300_000;

export function analyzeLoops(model: Model, opts: LoopOptions = {}): LoopReport {
  const c = compile(model);
  const { dt, to, start } = model.settings;
  const steps = Math.max(1, Math.round((to - start) / dt));
  // Nothing integrates in a links-only sketch: every sign is declared, so one
  // operating point is all there is to read.
  const samples = c.state.length === 0 ? 1 : Math.max(1, Math.floor(opts.samples ?? Math.min(steps + 1, 64)));
  const points = samples > 1 ? trajectoryScopes(model, c, samples) : [{ t: model.settings.start, scope: operatingPoint(model) }];

  // Structure is the same at every point (it comes from the free variables);
  // only the signs move. Read them once per sample.
  const links = structure(c);
  const signsAt = points.map((pt) => readSigns(c, links, pt.scope));
  const graph: InfluenceGraph = {
    nodes: links.nodes,
    edges: links.edges.map((e, k) => ({ from: e.from, to: e.to, sign: signsAt[0]![k]!, ...(e.declared ? { declared: true as const } : {}) })),
  };

  const { loops: found, capped } = findLoops(graph);
  const edgeIndex = new Map(links.edges.map((e, k) => [`${e.from}|${e.to}`, k] as const));
  const loops: Loop[] = found.map((l) => {
    const ks = l.edges.map((e) => edgeIndex.get(`${e.from}|${e.to}`)!);
    const trace: Polarity[] = signsAt.map((signs) => {
      let neg = 0, amb = false;
      for (const k of ks) { const sg = signs[k]!; if (sg === 0) amb = true; else if (sg < 0) neg++; }
      return amb ? "?" : neg % 2 === 0 ? "R" : "B";
    });
    const firstActive = trace.findIndex((p) => p !== "?");
    const determined = trace.filter((p) => p !== "?");
    const flips = determined.some((p) => p !== determined[0]);
    let polarity = trace[0]!;
    let resolvedAt: number | undefined;
    if (polarity === "?" && firstActive > 0) {
      polarity = trace[firstActive]!;
      resolvedAt = points[firstActive]!.t;
    }
    const deadLinks = ks
      .map((k, j) => ({ k, edge: l.edges[j]! }))
      .filter(({ k }) => signsAt.every((signs) => signs[k] === 0))
      .map(({ edge }) => ({ from: edge.from, to: edge.to }));
    const active = firstActive >= 0;
    return {
      nodes: l.nodes, edges: l.edges, polarity, trace, flips, active,
      ...(resolvedAt !== undefined ? { resolvedAt } : {}),
      ...(deadLinks.length ? { deadLinks } : {}),
    };
  });

  const counts = { R: 0, B: 0, "?": 0 };
  for (const l of loops) counts[l.polarity]++;
  const flipping = loops.filter((l) => l.flips).length;
  const inactive = loops.filter((l) => !l.active).length;
  return { graph, loops, capped, counts, flipping, inactive, sampleTimes: points.map((p) => p.t) };
}

/** The signed influence graph at t=start (what the diagram draws). */
export function influenceGraph(model: Model): InfluenceGraph {
  const c = compile(model);
  const links = structure(c);
  const signs = readSigns(c, links, operatingPoint(model));
  return { nodes: links.nodes, edges: links.edges.map((e, k) => ({ from: e.from, to: e.to, sign: signs[k]!, ...(e.declared ? { declared: true as const } : {}) })) };
}

interface Structure {
  nodes: string[];
  /** Unsigned links, with the expression each one is read from — or, for a
   *  `link` line, the declared sign and no expression. */
  edges: Array<{ from: string; to: string; expr?: Parameters<typeof freeVars>[0]; declared?: 1 | -1 }>;
}

/** Nodes and links — who reads whom — independent of any operating point. */
function structure(c: Compiled): Structure {
  // Fixed-delay outputs are nodes (like delay stocks); their samplers are not —
  // the input expression links straight to the output node instead.
  const nodes = new Set<string>([
    ...c.state.map((s) => s.name),
    ...c.fixed.map((f) => f.name),
    ...c.order.filter((v) => v.kind !== "param" && !v.isInternal).map((v) => v.name),
    // Declared-link endpoints are nodes even when no equation defines them — and
    // a param named in a link becomes a node, so the equations that read it link
    // from it (the sketch is saying the param is not constant after all).
    ...c.links.flatMap((l) => [l.from, l.to]),
  ]);
  const edges: Structure["edges"] = [];
  const linkFrom = (target: string, expr: Parameters<typeof freeVars>[0], skipSelf = false) => {
    for (const u of freeVars(expr)) if (nodes.has(u) && !(skipSelf && u === target)) edges.push({ from: u, to: target, expr });
  };
  for (const v of c.order) if (v.kind !== "param" && !v.isInternal) linkFrom(v.name, v.expr);
  // A map written as a derivative — change(X) = (next − X) / dt — mentions X only
  // to cancel it; that is assignment, not feedback. Its self-link would be a
  // phantom balancing loop that shadows the real ones, so it is dropped. A
  // genuine self-dependence (X inside `next`'s own expression) is kept.
  for (const s of c.state) if (s.rateExpr) linkFrom(s.name, s.rateExpr, isMapAssignment(s.rateExpr, s.name));
  for (const f of c.fixed) linkFrom(f.name, f.inputExpr);
  // Declared links: a causal-loop sketch, or a dependency the equations don't
  // carry yet.
  for (const l of c.links) edges.push({ from: l.from, to: l.to, declared: l.sign });
  return { nodes: [...nodes], edges };
}

/** `(A − X) / dt`, `(A − X)`, or `A − X` where A does not itself read X: the
 *  discrete-map idiom for "X becomes A next step". */
function isMapAssignment(rate: Expr, stock: string): boolean {
  let e = rate;
  if (e.kind === "binary" && e.op === "/" && e.right.kind === "ident" && e.right.name === "dt") e = e.left;
  if (!(e.kind === "binary" && e.op === "-" && e.right.kind === "ident" && e.right.name === stock)) return false;
  return !freeVars(e.left).has(stock);
}

/** Sign of every link at one operating point, by central-difference perturbation. */
function readSigns(c: Compiled, links: Structure, scope: Record<string, number>): Array<-1 | 0 | 1> {
  const ctx: EvalCtx = { scope, tables: c.tables };
  return links.edges.map(({ from: u, expr, declared }) => {
    if (declared) return declared;
    if (!expr) return 0;
    const x0 = scope[u] ?? 0;
    const h = 1e-6 * Math.max(1, Math.abs(x0));
    scope[u] = x0 + h;
    const up = evalExpr(expr, ctx);
    scope[u] = x0 - h;
    const dn = evalExpr(expr, ctx);
    scope[u] = x0;
    if (!Number.isFinite(up) || !Number.isFinite(dn)) return 0;
    const slope = up - dn;
    return slope > 0 ? 1 : slope < 0 ? -1 : 0;
  });
}

/** The full scope (every state, var and internal slot) at `samples` evenly
 *  spaced steps of the actual run, first = start, last = end. */
function trajectoryScopes(model: Model, c: Compiled, samples: number): Array<{ t: number; scope: Record<string, number> }> {
  const plan = buildPlan(c);
  const slots = makeSlotMap(plan);
  const { dt, to, start } = model.settings;
  const steps = Math.max(1, Math.round((to - start) / dt));
  const wanted = new Set<number>();
  const n = Math.min(samples, steps + 1);
  for (let k = 0; k < n; k++) wanted.add(Math.round((k * steps) / Math.max(1, n - 1)));
  const out: Array<{ t: number; scope: Record<string, number> }> = [];
  runPlan(model, plan, tsBackend(plan), (i, time, mem) => {
    if (!wanted.has(i)) return;
    const scope: Record<string, number> = {};
    for (const [name, slot] of slots) scope[name] = mem[slot]!;
    scope.dt = dt;
    out.push({ t: time, scope });
  });
  // a run that halted early still yields at least the start point
  return out.length ? out : [{ t: start, scope: operatingPoint(model) }];
}

/** The model's t=start scope (stocks at initial values, variables evaluated). */
export function operatingPoint(model: Model): Record<string, number> {
  const c = compile(model);
  const scope: Record<string, number> = { t: model.settings.start, time: model.settings.start, dt: model.settings.dt };
  for (const s of c.state) scope[s.name] = 0;
  for (const f of c.fixed) scope[f.name] = 0;
  for (const v of c.order) scope[v.name] = 0;
  const ctx: EvalCtx = { scope, tables: c.tables };
  // Converge the fixed point rather than always running O(N) passes (see the
  // matching note in codegen.initStateInto) — keeps this ~O(N) on large models,
  // so loop analysis stays responsive on the main thread.
  const maxPasses = c.state.length + c.order.length + c.fixed.length + 2;
  for (let p = 0; p < maxPasses; p++) {
    let changed = 0;
    for (const v of c.order) { const nv = evalExpr(v.expr, ctx); if (nv !== scope[v.name]) { scope[v.name] = nv; changed++; } }
    for (const s of c.state) { const nv = evalExpr(s.initExpr, ctx); if (nv !== scope[s.name]) { scope[s.name] = nv; changed++; } }
    for (const f of c.fixed) { const nv = evalExpr(f.initExpr, ctx); if (nv !== scope[f.name]) { scope[f.name] = nv; changed++; } }
    if (changed === 0) break;
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
  let traversals = 0;

  // self-loops (a variable that directly feeds back into itself)
  for (const e of graph.edges) if (e.from === e.to) loops.push(makeLoop([e]));

  const dfs = (start: string, cur: string, path: Edge[], seen: Set<string>) => {
    if (loops.length >= MAX_LOOPS || traversals >= MAX_TRAVERSALS) {
      capped = true;
      return;
    }
    for (const e of adj.get(cur)!) {
      if (++traversals >= MAX_TRAVERSALS) { capped = true; return; }
      if (e.to === start) {
        loops.push(makeLoop([...path, e]));
        if (loops.length >= MAX_LOOPS) { capped = true; return; }
      } else if (!seen.has(e.to) && idx.get(e.to)! > idx.get(start)!) {
        seen.add(e.to);
        dfs(start, e.to, [...path, e], seen);
        seen.delete(e.to);
        if (capped) return;
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
  return { nodes, edges, polarity, trace: [polarity], flips: false, active: polarity !== "?" };
}
