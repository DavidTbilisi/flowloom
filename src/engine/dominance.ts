// ── Loop dominance by knockout ──────────────────────────────────────────────
// "Which loop is running this system?" A loop list can't say; 86 loops in a
// policy model is noise. The cheap, honest measure: for each active loop, cut
// one of its links — replace the reference to `from` inside `to`'s equation
// with `from`'s value at t=start, so the signal no longer travels — re-run, and
// report how far the metric moves. Loops are ranked by |Δ|, the way
// `sensitivity` ranks knobs. The cut is an AST edit on a clone (text stays
// canonical), and the cut link is chosen to disturb as few other loops as
// possible (the link shared by the fewest loops); `shared` says how many still
// go through it, so a big Δ on a heavily shared link is read with care.

import type { Expr, Model } from "../lang/types.js";
import { analyzeLoops, operatingPoint, type Loop, type LoopReport, type Polarity } from "./loops.js";
import { simulateAsync } from "./simulator.js";
import { resolveMetric } from "./summarize.js";

export interface DominanceRow {
  /** 1-based position in the LoopReport's loop list. */
  loop: number;
  polarity: Polarity;
  nodes: string[];
  /** The link that was frozen. */
  cut: { from: string; to: string };
  /** How many loops (including this one) pass through the cut link. */
  shared: number;
  /** Metric with the link cut. */
  value: number;
  /** value − base. */
  delta: number;
  /** The cut sent the metric off the scale (|value| > 10⁶ × |base|) — the loop was holding the system together. */
  runaway?: true;
  note?: string;
}

export interface DominanceResult {
  metric: string;
  base: number;
  rows: DominanceRow[];
  /** Active loops that could not be cut (every link touches an internal delay node). */
  skipped: Array<{ loop: number; nodes: string[]; reason: string }>;
  /** Loops that never engage in this run — nothing to cut. */
  inactive: number;
  report: LoopReport;
}

const L0 = { line: 0, col: 0 };

/** Replace every reference to `name` in `e` with the constant `value`. */
function freeze(e: Expr, name: string, value: number): Expr {
  switch (e.kind) {
    case "num":
      return e;
    case "ident":
    case "index":
      return e.name === name ? { kind: "num", value, loc: L0 } : e;
    case "unary":
      return { ...e, arg: freeze(e.arg, name, value) };
    case "binary":
      return { ...e, left: freeze(e.left, name, value), right: freeze(e.right, name, value) };
    case "call":
      return { ...e, args: e.args.map((a) => freeze(a, name, value)) };
  }
}

/** Is this link between two user-level names (so it can be cut in the Model)? */
function cuttable(model: Model, from: string, to: string): boolean {
  const userName = (n: string) => model.varIndex.has(n) || model.stocks.some((s) => s.name === n);
  return userName(from) && (model.varIndex.has(to) || model.rates.has(to));
}

/** Cut the link from → to on a clone of the model. */
function cutLink(model: Model, from: string, to: string, value: number): Model {
  const m = structuredClone(model);
  const v = m.varIndex.get(to);
  if (v) {
    v.expr = freeze(v.expr, from, value);
    if (v.elemExprs) v.elemExprs = v.elemExprs.map((e) => freeze(e, from, value));
  } else {
    const r = m.rates.get(to)!;
    r.expr = freeze(r.expr, from, value);
  }
  return m;
}

export async function loopDominance(model: Model, metric: string, report?: LoopReport): Promise<DominanceResult> {
  const rep = report ?? analyzeLoops(model);
  const op = operatingPoint(model);
  const base = resolveMetric(await simulateAsync(structuredClone(model)), metric);

  // how many *active* loops each link belongs to
  const linkCount = new Map<string, number>();
  for (const l of rep.loops) if (l.active) for (const e of l.edges) { const k = `${e.from}|${e.to}`; linkCount.set(k, (linkCount.get(k) ?? 0) + 1); }

  const rows: DominanceRow[] = [];
  const skipped: DominanceResult["skipped"] = [];
  let inactive = 0;
  for (let i = 0; i < rep.loops.length; i++) {
    const l: Loop = rep.loops[i]!;
    if (!l.active) { inactive++; continue; }
    const candidates = l.edges
      .filter((e) => !e.declared && cuttable(model, e.from, e.to))
      .map((e) => ({ e, shared: linkCount.get(`${e.from}|${e.to}`)! }))
      .sort((a, b) => a.shared - b.shared);
    const pick = candidates[0];
    if (!pick) { skipped.push({ loop: i + 1, nodes: l.nodes, reason: l.edges.every((e) => e.declared) ? "declared links only — no equation to cut" : "every link touches an internal delay node or is declared" }); continue; }
    const value0 = op[pick.e.from];
    if (value0 === undefined || !Number.isFinite(value0)) { skipped.push({ loop: i + 1, nodes: l.nodes, reason: `no start value for ${pick.e.from}` }); continue; }
    const res = await simulateAsync(cutLink(model, pick.e.from, pick.e.to, value0));
    const value = resolveMetric(res, metric);
    const runaway = !Number.isFinite(value) || Math.abs(value) > 1e6 * Math.max(1, Math.abs(base));
    rows.push({
      loop: i + 1, polarity: l.polarity, nodes: l.nodes,
      cut: { from: pick.e.from, to: pick.e.to }, shared: pick.shared,
      value, delta: value - base, ...(runaway ? { runaway: true as const } : {}), ...(res.note ? { note: res.note } : {}),
    });
  }
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { metric, base, rows, skipped, inactive, report: rep };
}
