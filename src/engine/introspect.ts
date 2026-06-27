// ── Model introspection ─────────────────────────────────────────────────────
// Two pure, DOM-free views of a parsed Model, for the headless consumers (CLI
// `describe`/`explain`, MCP `flow_describe`/`flow_explain`):
//   describeModel → a JSON-serializable structure (stocks, rates, vars, tables,
//                   settings, plot, and the derived feedback-loop summary)
//   explainModel  → a compact narrative an LLM (or a human) can read
// Both are built from the same primitives the studio uses — printExpr, freeVars,
// analyzeLoops — so what an agent reads here is exactly what ran.

import type { Expr, Model, VarKind } from "../lang/index.js";
import { printExpr, freeVars, declExprs } from "../lang/index.js";
import { analyzeLoops } from "./loops.js";

export interface ModelDescription {
  stocks: Array<{ name: string; init: string; unit?: string; doc?: string }>;
  rates: Array<{ stock: string; expr: string }>;
  vars: Array<{ name: string; kind: VarKind; expr: string; unit?: string; doc?: string; deps: string[] }>;
  tables: Array<{ name: string; points: Array<[number, number]> }>;
  settings: Model["settings"];
  plot: string[];
  loops: {
    counts: { R: number; B: number; "?": number };
    capped: boolean;
    items: Array<{ polarity: "R" | "B" | "?"; nodes: string[] }>;
  };
}

/** Names a model defines itself (stocks, vars, tables) — used to keep `deps` to real edges. */
function ownNames(model: Model): Set<string> {
  return new Set<string>([
    ...model.stocks.map((s) => s.name),
    ...model.vars.map((v) => v.name),
    ...model.tables.keys(),
  ]);
}

/** Structured, JSON-serializable view of a parsed model. */
export function describeModel(model: Model): ModelDescription {
  const own = ownNames(model);
  const rep = analyzeLoops(model);
  // A per-element decl prints its full `a, b, …` list; otherwise the single expr.
  const rhs = (single: Expr, list?: Expr[]) => declExprs(single, list).map(printExpr).join(", ");
  const allDeps = (single: Expr, list?: Expr[]) => {
    const fv = new Set<string>();
    for (const e of declExprs(single, list)) freeVars(e, fv);
    return [...fv].filter((n) => own.has(n));
  };
  return {
    stocks: model.stocks.map((s) => ({
      name: s.name,
      init: rhs(s.initExpr, s.elemExprs),
      ...(s.unit ? { unit: s.unit } : {}),
      ...(s.doc ? { doc: s.doc } : {}),
    })),
    rates: [...model.rates.values()].map((r) => ({ stock: r.target, expr: printExpr(r.expr) })),
    vars: model.vars.map((v) => ({
      name: v.name,
      kind: v.kind,
      expr: rhs(v.expr, v.elemExprs),
      ...(v.unit ? { unit: v.unit } : {}),
      ...(v.doc ? { doc: v.doc } : {}),
      deps: allDeps(v.expr, v.elemExprs),
    })),
    tables: [...model.tables.values()].map((t) => ({ name: t.name, points: t.points })),
    settings: model.settings,
    plot: model.plot,
    loops: {
      counts: rep.counts,
      capped: rep.capped,
      items: rep.loops.map((l) => ({ polarity: l.polarity, nodes: l.nodes })),
    },
  };
}

/** A compact narrative summary of what a model is and does. */
export function explainModel(model: Model): string {
  const d = describeModel(model);
  const rateOf = new Map(d.rates.map((r) => [r.stock, r.expr]));
  const lines: string[] = [];

  const nStock = d.stocks.length;
  const nVar = d.vars.length;
  const nLoop = d.loops.items.length;
  const { R, B } = d.loops.counts;
  const amb = d.loops.counts["?"];
  lines.push(
    `${nStock} stock${plural(nStock)}, ${nVar} variable${plural(nVar)}, ` +
      `${nLoop} feedback loop${plural(nLoop)} (${R} reinforcing, ${B} balancing` +
      `${amb ? `, ${amb} ambiguous` : ""}).`,
  );

  if (d.stocks.length) {
    lines.push("", "Stocks (accumulators):");
    for (const s of d.stocks) {
      const unit = s.unit ? ` [${s.unit}]` : "";
      const rate = rateOf.get(s.name);
      const doc = s.doc ? ` — ${s.doc}` : "";
      lines.push(`  • ${s.name}${unit} starts at ${s.init}${rate ? `; change(${s.name}) = ${rate}` : "; no rate"}${doc}`);
    }
  }

  const params = d.vars.filter((v) => v.kind === "param");
  if (params.length) {
    lines.push("", "Knobs (params):");
    for (const p of params) lines.push(`  • ${p.name} = ${p.expr}${p.doc ? ` — ${p.doc}` : ""}`);
  }

  const dynamic = d.vars.filter((v) => v.kind !== "param");
  if (dynamic.length) {
    lines.push("", "Flows & auxiliaries:");
    for (const v of dynamic) lines.push(`  • ${v.kind} ${v.name} = ${v.expr}${v.doc ? ` — ${v.doc}` : ""}`);
  }

  if (d.tables.length) {
    lines.push("", "Graphical lookups:");
    for (const t of d.tables) lines.push(`  • ${t.name}(x) — ${t.points.length} breakpoints`);
  }

  if (d.loops.items.length) {
    lines.push("", "Feedback loops (polarity read at t = start; nonlinear models can flip later):");
    for (const l of d.loops.items) lines.push(`  ${l.polarity}  ${l.nodes.join(" → ")}`);
    if (d.loops.capped) lines.push("  … loop search capped; more loops exist.");
  }

  const { dt, to, start, method } = d.settings;
  lines.push("", `Simulation: dt=${dt}, start=${start}, to=${to}, method=${method}.`);
  return lines.join("\n");
}

const plural = (n: number) => (n === 1 ? "" : "s");
