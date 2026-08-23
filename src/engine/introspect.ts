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
  vars: Array<{ name: string; kind: VarKind; expr: string; unit?: string; doc?: string; switch?: true; constant?: true; rung?: number; deps: string[] }>;
  tables: Array<{ name: string; points: Array<[number, number]> }>;
  /** Named override sets declared in the text (`scenario` lines). */
  scenarios: Array<{ name: string; sets: Array<{ key: string; value: string }>; doc?: string; rung?: number }>;
  /** Declared signed influences (`link` lines). */
  links: Array<{ from: string; to: string; sign: 1 | -1; doc?: string }>;
  /** The model's own claims (`expect` lines): scenario (base = the model), metric, comparison, value, tolerance. */
  expects: Array<{ scenario: string; metric: string; op: string; value: number; tol?: { value: number; pct: boolean }; doc?: string }>;
  /** True when the model is a causal-loop sketch: links, no stock to integrate. */
  qualitative: boolean;
  settings: Model["settings"];
  plot: string[];
  loops: {
    counts: { R: number; B: number; "?": number };
    capped: boolean;
    /** Loops that never engage in this run (a link flat at every sample). */
    inactive: number;
    flipping: number;
    items: Array<{ polarity: "R" | "B" | "?"; nodes: string[]; active: boolean; flips: boolean; resolvedAt?: number }>;
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
      ...(v.boolean ? { switch: true as const } : {}),
      ...(v.constant ? { constant: true as const } : {}),
      ...(v.rung !== undefined ? { rung: v.rung } : {}),
      deps: allDeps(v.expr, v.elemExprs),
    })),
    tables: [...model.tables.values()].map((t) => ({ name: t.name, points: t.points })),
    scenarios: [...model.scenarios.values()].map((s) => ({
      name: s.name,
      sets: s.sets.map(({ key, value }) => ({ key, value })),
      ...(s.doc ? { doc: s.doc } : {}),
      ...(s.rung !== undefined ? { rung: s.rung } : {}),
    })),
    links: model.links.map((l) => ({ from: l.from, to: l.to, sign: l.sign, ...(l.doc ? { doc: l.doc } : {}) })),
    expects: model.expects.map((e) => ({ scenario: e.scenario ?? "base", metric: e.metric, op: e.op, value: e.value, ...(e.tol ? { tol: e.tol } : {}), ...(e.doc ? { doc: e.doc } : {}) })),
    qualitative: model.stocks.length === 0 && model.links.length > 0,
    settings: model.settings,
    plot: model.plot,
    loops: {
      counts: rep.counts,
      capped: rep.capped,
      inactive: rep.inactive,
      flipping: rep.flipping,
      items: rep.loops.map((l) => ({ polarity: l.polarity, nodes: l.nodes, active: l.active, flips: l.flips, ...(l.resolvedAt !== undefined ? { resolvedAt: l.resolvedAt } : {}) })),
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
  if (d.qualitative) lines.push(`Causal-loop sketch: ${new Set(d.links.flatMap((l) => [l.from, l.to])).size} nodes, ${d.links.length} declared links, nothing to simulate yet.`);
  lines.push(
    `${nStock} stock${plural(nStock)}, ${nVar} variable${plural(nVar)}, ` +
      `${nLoop} feedback loop${plural(nLoop)} (${R} reinforcing, ${B} balancing` +
      `${amb ? `, ${amb} never active in this run` : ""}${d.loops.flipping ? `, ${d.loops.flipping} flipping` : ""}).`,
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

  const params = d.vars.filter((v) => v.kind === "param" && !v.switch && !v.constant);
  if (params.length) {
    lines.push("", "Knobs (params):");
    for (const p of params) lines.push(`  • ${p.name} = ${p.expr}${p.doc ? ` — ${p.doc}` : ""}`);
  }

  const consts = d.vars.filter((v) => v.constant);
  if (consts.length) {
    lines.push("", "Constants (structural, not knobs):");
    for (const c of consts) lines.push(`  • ${c.name} = ${c.expr}${c.doc ? ` — ${c.doc}` : ""}`);
  }

  const switches = d.vars.filter((v) => v.switch);
  if (switches.length) {
    lines.push("", "Switches (on/off policies):");
    for (const s of switches) lines.push(`  • ${s.name} = ${s.expr === "1" ? "on" : "off"}${s.doc ? ` — ${s.doc}` : ""}`);
  }

  const dynamic = d.vars.filter((v) => v.kind !== "param");
  if (dynamic.length) {
    lines.push("", "Flows & auxiliaries:");
    for (const v of dynamic) lines.push(`  • ${v.kind} ${v.name} = ${v.expr}${v.doc ? ` — ${v.doc}` : ""}`);
  }

  if (d.links.length) {
    lines.push("", "Declared links (a causal-loop sketch; + same direction, − opposite):");
    for (const l of d.links) lines.push(`  • ${l.from} ${l.sign > 0 ? "—(+)→" : "—(−)→"} ${l.to}${l.doc ? ` — ${l.doc}` : ""}`);
  }

  if (d.expects.length) {
    lines.push("", `Expectations (${d.expects.length} — the model's own tests; run them with \`test\`):`);
    for (const e of d.expects) lines.push(`  • ${e.scenario} ${e.metric} ${e.op} ${e.value}${e.tol ? ` ± ${e.tol.pct ? `${e.tol.value * 100}%` : e.tol.value}` : ""}${e.doc ? ` — ${e.doc}` : ""}`);
  }

  if (d.tables.length) {
    lines.push("", "Graphical lookups:");
    for (const t of d.tables) lines.push(`  • ${t.name}(x) — ${t.points.length} breakpoints`);
  }

  if (d.scenarios.length) {
    lines.push("", "Scenarios (named override sets; base = the model as written):");
    for (const s of d.scenarios) lines.push(`  • ${s.name}: ${s.sets.map((x) => `${x.key}=${x.value}`).join(" ")}${s.doc ? ` — ${s.doc}` : ""}`);
  }

  const activeLoops = d.loops.items.filter((l) => l.active);
  if (activeLoops.length) {
    lines.push("", "Feedback loops (polarity read along the run):");
    for (const l of activeLoops) lines.push(`  ${l.polarity}${l.flips ? "~" : " "} ${l.nodes.join(" → ")}${l.resolvedAt !== undefined ? `  (engages from t=${l.resolvedAt})` : ""}`);
    if (d.loops.inactive) lines.push(`  … ${d.loops.inactive} more never engage in this run (an if() branch or gate stays flat).`);
    if (d.loops.capped) lines.push("  … loop search capped; more loops exist.");
  } else if (d.loops.items.length) {
    lines.push("", `Feedback loops: ${d.loops.items.length} structural, none engage in this run.`);
  }

  const { dt, to, start, method } = d.settings;
  lines.push("", `Simulation: dt=${dt}, start=${start}, to=${to}, method=${method}.`);
  return lines.join("\n");
}

const plural = (n: number) => (n === 1 ? "" : "s");
