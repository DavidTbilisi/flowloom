// ── Subscript scalarization ──────────────────────────────────────────────────
// Lower a model with subscript dimensions to a plain scalar model BEFORE codegen,
// exactly as compile.ts later expands smooth/delay into internal stocks. A
// subscripted `stock Population[region]` becomes N scalar stocks `Population.North`
// …; index references and `sum(...)` lower to scalar expressions. So the engine
// (codegen, WASM, loops, simulator) sees only more scalar names and needs no
// changes, and WASM↔TS parity holds for free.
//
// The expanded name `base.elem` can't collide with a user identifier: `.` is not a
// valid identifier character (same guarantee as compile.ts's `delay#N`).

import type { Expr, Model, StockDecl, VarDecl, RateDecl, Loc } from "./types.js";

const L0: Loc = { line: 0, col: 0 };
const ident = (name: string, loc: Loc = L0): Expr => ({ kind: "ident", name, loc });

/** The scalar name of one element of a subscripted symbol. */
export function elemName(base: string, elem: string): string {
  return `${base}.${elem}`;
}

class ScalarizeError extends Error {
  loc: Loc;
  constructor(message: string, loc: Loc) {
    super(message);
    this.name = "ScalarizeError";
    this.loc = loc;
  }
}

interface Ctx { dim: string; elem: string }

/**
 * Expand all subscripts in `model` to scalars. A no-op (returns the model
 * unchanged) when no dimensions are declared. Throws ScalarizeError on an
 * inconsistent subscript (unknown dim/element, bare vector use, mixed dims).
 */
export function scalarize(model: Model): Model {
  if (model.dims.size === 0) return model;

  // base symbol name → its dimension name
  const dimOf = new Map<string, string>();
  for (const s of model.stocks) if (s.dim) dimOf.set(s.name, s.dim);
  for (const v of model.vars) if (v.dim) dimOf.set(v.name, v.dim);
  const elements = (dim: string): string[] => model.dims.get(dim)?.elements ?? [];

  // Lower one expression under an optional elementwise context (dim, elem).
  const sub = (e: Expr, ctx: Ctx | null): Expr => {
    switch (e.kind) {
      case "num":
        return e;
      case "ident": {
        if (dimOf.has(e.name)) {
          throw new ScalarizeError(`'${e.name}' is subscripted — index it (${e.name}[${dimOf.get(e.name)}]) or aggregate it (sum(${e.name}))`, e.loc);
        }
        return e;
      }
      case "index": {
        const d = dimOf.get(e.name);
        if (!d) throw new ScalarizeError(`'${e.name}' is not subscripted, so '${e.name}[${e.sub}]' is invalid`, e.loc);
        if (ctx && e.sub === ctx.dim) return ident(elemName(e.name, ctx.elem), e.loc);
        if (elements(d).includes(e.sub)) return ident(elemName(e.name, e.sub), e.loc);
        if (model.dims.has(e.sub)) {
          throw new ScalarizeError(`'${e.name}[${e.sub}]' mixes dimensions — only elementwise '${d}' or a single element is supported`, e.loc);
        }
        throw new ScalarizeError(`'${e.sub}' is not an element of dimension '${d}'`, e.loc);
      }
      case "unary":
        return { ...e, arg: sub(e.arg, ctx) };
      case "binary":
        return { ...e, left: sub(e.left, ctx), right: sub(e.right, ctx) };
      case "call": {
        if (e.name.toLowerCase() === "sum") return lowerSum(e, ctx);
        return { ...e, args: e.args.map((a) => sub(a, ctx)) };
      }
    }
  };

  // sum(X) / sum(X[dim]) → an n-ary `+` of X's scalar elements.
  const lowerSum = (e: Expr & { kind: "call" }, ctx: Ctx | null): Expr => {
    const arg = e.args[0];
    if (!arg || e.args.length !== 1) throw new ScalarizeError("sum() takes exactly one subscripted argument", e.loc);
    const base = arg.kind === "ident" ? arg.name : arg.kind === "index" ? arg.name : undefined;
    const d = base ? dimOf.get(base) : undefined;
    if (!base || !d) throw new ScalarizeError("sum() needs a subscripted argument, e.g. sum(Population)", e.loc);
    const els = elements(d);
    if (!els.length) throw new ScalarizeError(`dimension '${d}' has no elements`, e.loc);
    // sum is independent of the surrounding elementwise context; it collapses `d`.
    void ctx;
    return els
      .map((el) => ident(elemName(base, el), e.loc))
      .reduce((acc, cur) => ({ kind: "binary", op: "+", left: acc, right: cur, loc: e.loc }));
  };

  // ── expand declarations ──
  const expandStock = (s: StockDecl): StockDecl[] => {
    if (!s.dim) return [{ ...s, initExpr: sub(s.initExpr, null) }];
    return elements(s.dim).map((el) => ({
      name: elemName(s.name, el),
      initExpr: sub(s.initExpr, { dim: s.dim!, elem: el }),
      unit: s.unit, doc: s.doc, loc: s.loc,
    }));
  };

  const expandVar = (v: VarDecl): VarDecl[] => {
    if (!v.dim) return [{ ...v, expr: sub(v.expr, null) }];
    return elements(v.dim).map((el) => ({
      name: elemName(v.name, el),
      kind: v.kind,
      expr: sub(v.expr, { dim: v.dim!, elem: el }),
      unit: v.unit, doc: v.doc, loc: v.loc,
    }));
  };

  const stocks = model.stocks.flatMap(expandStock);
  const vars = model.vars.flatMap(expandVar);
  const order = model.order.flatMap(expandVar);
  const varIndex = new Map(vars.map((v) => [v.name, v]));

  const rates = new Map<string, RateDecl>();
  for (const [base, r] of model.rates) {
    const d = dimOf.get(base);
    if (!d) { rates.set(base, { ...r, expr: sub(r.expr, null) }); continue; }
    for (const el of elements(d)) {
      const name = elemName(base, el);
      rates.set(name, { target: name, expr: sub(r.expr, { dim: d, elem: el }), loc: r.loc });
    }
  }

  // `plot Population` → all of Population's elements.
  const plot = model.plot.flatMap((n) => (dimOf.has(n) ? elements(dimOf.get(n)!).map((el) => elemName(n, el)) : [n]));

  return {
    stocks, rates, vars, varIndex,
    tables: model.tables,
    dims: new Map(), // consumed
    settings: model.settings,
    plot,
    order,
    diagnostics: model.diagnostics,
  };
}
