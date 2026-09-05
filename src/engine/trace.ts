// ── Causal tracing: what feeds this, and what does this feed ────────────────
// `describeModel` answers "what does X depend on" one level deep and forwards
// only. The *reverse* index — who reads X — already exists inside loops.ts and
// diagram.ts, but nothing ever exposed it, so the two questions a modeller
// actually asks of an unfamiliar model ("why did this move?" and "what breaks
// if I change this?") had no answer short of grepping the text.
//
// These are Vensim's Causes Tree / Uses Tree and its Document export, built
// from the parsed Model rather than the compiled one on purpose:
//   • params are causes. `structure()` (loops.ts) drops them because a constant
//     cannot carry feedback — but "what determines the infection rate" is
//     answered by `contactRate` as much as by `S`, and a causes tree that hides
//     the knobs hides the levers.
//   • internal names are not. `smooth(X, tau)` becomes a `delay#N` stock in the
//     compiled model; the author wrote neither, so the tree shows `X` and `tau`.
// Signs are read the same way loops.ts reads them — central difference at the
// operating point — so a `+`/`−` here means what it means everywhere else.

import type { Expr, Model, VarDecl } from "../lang/index.js";
import { printExpr, freeVars, declExprs, scalarize } from "../lang/index.js";
import { elemName } from "../lang/scalarize.js";
import { compile } from "./compile.js";
import { evalExpr, type EvalCtx } from "./eval.js";
import { operatingPoint } from "./loops.js";
import { suggestName } from "../lang/suggest.js";

export type NodeKind =
  | "stock" | "flow" | "aux" | "param" | "const" | "switch" | "data"
  | "table" | "time" | "sketch";

/** How one name comes to influence another. */
export type Via = "equation" | "rate" | "init" | "link";

export interface TraceNode {
  name: string;
  kind: NodeKind;
  /** Sign of the edge that reached this node (absent at the root). */
  sign?: -1 | 0 | 1;
  via?: Via;
  children: TraceNode[];
  /** This name is already open further up the branch — the walk stops rather
   *  than unrolling a feedback loop forever. The loop itself is real; `loops`
   *  is where it gets named. */
  cycle?: true;
  /** The node has neighbours the depth limit cut off. */
  more?: number;
}

export interface TraceOptions {
  /** Levels to expand. Default 3 — deep enough to see a mechanism, shallow
   *  enough to read. */
  depth?: number;
  /** Follow a stock's *initial value* as well as its rate. Off by default: at
   *  t>0 the init is history, and including it buries the live causes. */
  init?: boolean;
}

interface Dep { name: string; via: Via; expr?: Expr; sign?: -1 | 0 | 1 }

// ── the dependency index ────────────────────────────────────────────────────

/** Every name the model itself binds, plus the clock. */
function kindsOf(model: Model): Map<string, NodeKind> {
  const kinds = new Map<string, NodeKind>();
  for (const s of model.stocks) kinds.set(s.name, "stock");
  for (const v of model.vars) kinds.set(v.name, varKind(v));
  for (const t of model.tables.keys()) if (!t.endsWith("#data")) kinds.set(t, "table");
  for (const l of model.links) for (const n of [l.from, l.to]) if (!kinds.has(n)) kinds.set(n, "sketch");
  for (const n of ["t", "time", "dt"]) kinds.set(n, "time");
  return kinds;
}

function varKind(v: VarDecl): NodeKind {
  if (v.data) return "data";
  if (v.kind !== "param") return v.kind;
  return v.boolean ? "switch" : v.constant ? "const" : "param";
}

/**
 * Direct causes of every name: the free variables of whatever defines it.
 *
 * A stock is defined by its `change()` — that is what moves it — with its
 * initial value available separately, because at any t > 0 the init is history
 * rather than a live influence.
 */
function causeIndex(model: Model, withInit: boolean): Map<string, Dep[]> {
  const kinds = kindsOf(model);
  const out = new Map<string, Dep[]>();
  const add = (to: string, expr: Expr, via: Via) => {
    const list = out.get(to) ?? [];
    for (const u of freeVars(expr)) {
      if (!kinds.has(u) || u === to) continue;
      if (!list.some((d) => d.name === u && d.via === via)) list.push({ name: u, via, expr });
    }
    out.set(to, list);
  };
  for (const v of model.vars) for (const e of declExprs(v.expr, v.elemExprs)) add(v.name, e, "equation");
  for (const r of model.rates.values()) add(r.target, r.expr, "rate");
  if (withInit) for (const s of model.stocks) for (const e of declExprs(s.initExpr, s.elemExprs)) add(s.name, e, "init");
  // A declared link is a cause the equations don't carry — the whole point of a
  // qualitative sketch, and of a link line added to a quantitative model.
  for (const l of model.links) {
    const list = out.get(l.to) ?? [];
    if (!list.some((d) => d.name === l.from && d.via === "link")) list.push({ name: l.from, via: "link", sign: l.sign });
    out.set(l.to, list);
  }
  for (const n of kinds.keys()) if (!out.has(n)) out.set(n, []);
  return out;
}

/** Invert the cause index: who reads each name. */
function invert(causes: Map<string, Dep[]>): Map<string, Dep[]> {
  const out = new Map<string, Dep[]>();
  for (const k of causes.keys()) out.set(k, []);
  for (const [to, deps] of causes) {
    for (const d of deps) {
      const list = out.get(d.name) ?? [];
      list.push({ name: to, via: d.via, ...(d.expr ? { expr: d.expr } : {}), ...(d.sign !== undefined ? { sign: d.sign } : {}) });
      out.set(d.name, list);
    }
  }
  return out;
}

/**
 * Sign reader: how does moving `from` move the expression that defines `to`?
 *
 * The same central difference loops.ts uses, at the same operating point, so a
 * `+` in a causes tree and a `+` on a diagram edge are the same claim. Built
 * lazily — a `document` over a large model asks for a lot of signs, and a
 * qualitative sketch has no operating point worth computing.
 */
function signReader(model: Model): (from: string, expr?: Expr, declared?: -1 | 0 | 1) => -1 | 0 | 1 {
  let ctx: EvalCtx | undefined;
  let scope: Record<string, number> | undefined;
  return (from, expr, declared) => {
    if (declared !== undefined) return declared;
    if (!expr) return 0;
    if (!ctx) {
      try {
        scope = operatingPoint(model);
        ctx = { scope, tables: compile(model).tables };
      } catch {
        return 0;
      }
    }
    const s = scope!;
    const x0 = s[from] ?? 0;
    const h = 1e-6 * Math.max(1, Math.abs(x0));
    try {
      s[from] = x0 + h;
      const up = evalExpr(expr, ctx);
      s[from] = x0 - h;
      const dn = evalExpr(expr, ctx);
      if (!Number.isFinite(up) || !Number.isFinite(dn)) return 0;
      return up > dn ? 1 : up < dn ? -1 : 0;
    } catch {
      // A subscripted expression (`births[region]`, `sum(Population)`) has no
      // meaning until scalarization, so its sign reads "?" — ask for an element
      // (`causes Population[North]`) to get the lowered model and real signs.
      return 0;
    } finally {
      s[from] = x0;
    }
  };
}

// ── the trees ───────────────────────────────────────────────────────────────

/**
 * Pick the model a trace should run over.
 *
 * Subscripts are lowered before anything evaluates, so an element (`Pop[North]`
 * or the scalar `Pop.North`) is traced on the scalarized model — where the
 * expressions are ordinary arithmetic and every sign can be read. A bare vector
 * name stays on the text as written, which is the structure the author sees;
 * its signs come back "?" because `births[region]` has no value yet.
 */
function forTrace(model: Model, name: string): { model: Model; name: string } {
  const subscripted = model.stocks.some((s) => s.dims?.length) || model.vars.some((v) => v.dims?.length);
  if (!subscripted) return { model, name };
  const bracket = name.match(/^([^[\]]+?)\s*\[([^\]]*)\]$/);
  const wanted = bracket
    ? elemName(bracket[1]!.trim(), bracket[2]!.split(/[\s,]+/).filter(Boolean))
    : name;
  try {
    const flat = scalarize(model);
    if (kindsOf(flat).has(wanted)) return { model: flat, name: wanted };
  } catch { /* fall back to the un-lowered view */ }
  return { model, name };
}

function build(
  model: Model,
  root: string,
  index: Map<string, Dep[]>,
  depth: number,
  direction: "causes" | "uses",
): TraceNode {
  const kinds = kindsOf(model);
  if (!kinds.has(root)) {
    const known = [...kinds.keys()].filter((n) => !["t", "time", "dt"].includes(n));
    const hint = suggestName(root, known);
    throw new Error(`no stock, variable or table named "${root}"` + (hint ? ` — did you mean "${hint}"?` : known.length ? ` (have: ${known.slice(0, 12).join(", ")}${known.length > 12 ? ", …" : ""})` : ""));
  }
  const sign = signReader(model);
  const walk = (name: string, level: number, open: Set<string>): TraceNode => {
    const node: TraceNode = { name, kind: kinds.get(name) ?? "sketch", children: [] };
    const deps = index.get(name) ?? [];
    if (open.has(name)) { if (deps.length) node.cycle = true; return node; }
    if (level >= depth) { if (deps.length) node.more = deps.length; return node; }
    open.add(name);
    for (const d of deps) {
      // For a *causes* edge the perturbed name is the dependency; for a *uses*
      // edge it is the node we came from — the expression belongs to the reader
      // either way.
      const child = walk(d.name, level + 1, open);
      child.sign = sign(direction === "causes" ? d.name : name, d.expr, d.sign);
      child.via = d.via;
      node.children.push(child);
    }
    open.delete(name);
    return node;
  };
  return walk(root, 0, new Set());
}

/** What feeds `name`, recursively — Vensim's Causes Tree. */
export function causesTree(model: Model, name: string, opts: TraceOptions = {}): TraceNode {
  const t = forTrace(model, name);
  return build(t.model, t.name, causeIndex(t.model, opts.init === true), opts.depth ?? 3, "causes");
}

/** What `name` feeds, recursively — Vensim's Uses Tree. */
export function usesTree(model: Model, name: string, opts: TraceOptions = {}): TraceNode {
  const t = forTrace(model, name);
  return build(t.model, t.name, invert(causeIndex(t.model, opts.init === true)), opts.depth ?? 3, "uses");
}

const MARK: Record<number, string> = { 1: "+", [-1]: "−", 0: "?" };

/** Render a trace as an indented ASCII tree. */
export function renderTree(node: TraceNode, opts: { kinds?: boolean } = {}): string {
  const out: string[] = [`${node.name}${opts.kinds === false ? "" : `  [${node.kind}]`}`];
  const walk = (n: TraceNode, prefix: string): void => {
    n.children.forEach((c, i) => {
      const last = i === n.children.length - 1;
      const mark = c.sign === undefined ? " " : MARK[c.sign]!;
      const tag = c.cycle ? " ↺" : c.more ? ` (+${c.more} more)` : "";
      const via = c.via === "link" ? " (link)" : c.via === "init" ? " (init)" : "";
      out.push(`${prefix}${last ? "└─" : "├─"} ${mark} ${c.name}${opts.kinds === false ? "" : `  [${c.kind}]`}${via}${tag}`);
      walk(c, `${prefix}${last ? "   " : "│  "}`);
    });
  };
  walk(node, "");
  return out.join("\n");
}

// ── document ────────────────────────────────────────────────────────────────

export interface DocEntry {
  name: string;
  kind: NodeKind;
  unit?: string;
  doc?: string;
  /** The definition as written (the rate for a stock, the equation otherwise). */
  definition: string;
  /** A stock's initial value. */
  init?: string;
  /** Direct causes, signed. */
  uses: Array<{ name: string; sign: -1 | 0 | 1; via: Via }>;
  /** Direct readers, signed — the reverse index, which nothing surfaced before. */
  usedBy: Array<{ name: string; sign: -1 | 0 | 1; via: Via }>;
}

/**
 * Every name in the model with its definition, its causes and — the part that
 * was missing — everything that reads it. This is the "what breaks if I change
 * this" view, and the thing to hand an agent before it edits an unfamiliar model.
 */
export function documentModel(model: Model): DocEntry[] {
  const kinds = kindsOf(model);
  const causes = causeIndex(model, true);
  const uses = invert(causes);
  const sign = signReader(model);
  const rhs = (single: Expr, list?: Expr[]) => declExprs(single, list).map(printExpr).join(", ");
  const varOf = new Map(model.vars.map((v) => [v.name, v]));
  const stockOf = new Map(model.stocks.map((s) => [s.name, s]));

  const entries: DocEntry[] = [];
  for (const [name, kind] of kinds) {
    if (kind === "time") continue;
    const s = stockOf.get(name);
    const v = varOf.get(name);
    const table = model.tables.get(name);
    const rate = model.rates.get(name);
    const definition = s
      ? rate ? `change(${name}) = ${printExpr(rate.expr)}` : "(no change() — the stock is constant)"
      : v ? rhs(v.expr, v.elemExprs)
      : table ? `${table.points.length} points, ${table.points[0]![0]} … ${table.points[table.points.length - 1]![0]}`
      : "(declared only by a link line)";
    entries.push({
      name,
      kind,
      ...(s?.unit ?? v?.unit ? { unit: (s?.unit ?? v?.unit)! } : {}),
      ...(s?.doc ?? v?.doc ? { doc: (s?.doc ?? v?.doc)! } : {}),
      definition,
      ...(s ? { init: rhs(s.initExpr, s.elemExprs) } : {}),
      uses: (causes.get(name) ?? []).map((d) => ({ name: d.name, sign: sign(d.name, d.expr, d.sign), via: d.via })),
      usedBy: (uses.get(name) ?? []).map((d) => ({ name: d.name, sign: sign(name, d.expr, d.sign), via: d.via })),
    });
  }
  return entries;
}

/** `documentModel` as readable text. */
export function renderDocument(entries: DocEntry[]): string {
  const out: string[] = [];
  const label = (l: { name: string; sign: -1 | 0 | 1; via: Via }) =>
    `${MARK[l.sign]} ${l.name}${l.via === "link" ? " (link)" : l.via === "init" ? " (init)" : ""}`;
  for (const e of entries) {
    out.push(`${e.name}  [${e.kind}]${e.unit ? ` [${e.unit}]` : ""}`);
    if (e.doc) out.push(`  ${e.doc}`);
    if (e.init !== undefined) out.push(`  init       ${e.init}`);
    out.push(`  ${e.init !== undefined ? "change" : "def"}${" ".repeat(e.init !== undefined ? 5 : 8)}${e.definition}`);
    if (e.uses.length) out.push(`  uses       ${e.uses.map(label).join(", ")}`);
    if (e.usedBy.length) out.push(`  used by    ${e.usedBy.map(label).join(", ")}`);
    else out.push(`  used by    — nothing reads it`);
    out.push("");
  }
  return out.join("\n").replace(/\n+$/, "\n");
}
