// ── Subscript scalarization ──────────────────────────────────────────────────
// Lower a model with subscript dimensions to a plain scalar model BEFORE codegen,
// exactly as compile.ts later expands smooth/delay into internal stocks. A
// subscripted `stock Population[region]` becomes N scalar stocks `Population.North`
// …; a multi-dimensional `stock Trade[from, to]` becomes the full Cartesian
// product `Trade.North.North`, `Trade.North.South`, …. Index references and
// `sum(...)` lower to scalar expressions. So the engine (codegen, WASM, loops,
// simulator) sees only more scalar names and needs no changes, and WASM↔TS parity
// holds for free.
//
// The expanded name `base.elem[.elem…]` can't collide with a user identifier: `.`
// is not a valid identifier character (same guarantee as compile.ts's `delay#N`).

import type { Expr, Model, StockDecl, VarDecl, RateDecl, Loc } from "./types.js";

const L0: Loc = { line: 0, col: 0 };
const ident = (name: string, loc: Loc = L0): Expr => ({ kind: "ident", name, loc });

/** The scalar name of one element tuple of a subscripted symbol. */
export function elemName(base: string, elems: string[]): string {
  return [base, ...elems].join(".");
}

/** Cartesian product of per-dimension element lists: [[A,B],[X,Y]] → AX AY BX BY. */
function product(lists: string[][]): string[][] {
  return lists.reduce<string[][]>(
    (acc, list) => acc.flatMap((tuple) => list.map((el) => [...tuple, el])),
    [[]],
  );
}

class ScalarizeError extends Error {
  loc: Loc;
  constructor(message: string, loc: Loc) {
    super(message);
    this.name = "ScalarizeError";
    this.loc = loc;
  }
}

/** Binding of in-scope dimension names to the current element, during elementwise expansion. */
type Binding = Map<string, string>;

const bindingFor = (dims: string[], tuple: string[]): Binding => {
  const b: Binding = new Map();
  dims.forEach((d, i) => b.set(d, tuple[i]!));
  return b;
};

/**
 * Expand all subscripts in `model` to scalars. A no-op (returns the model
 * unchanged) when no dimensions are declared. Throws ScalarizeError on an
 * inconsistent subscript (unknown dim/element, bare vector use, arity/order
 * mismatch).
 */
export function scalarize(model: Model): Model {
  if (model.dims.size === 0) return model;

  // base symbol name → its ordered dimension names
  const dimsOf = new Map<string, string[]>();
  for (const s of model.stocks) if (s.dims) dimsOf.set(s.name, s.dims);
  for (const v of model.vars) if (v.dims) dimsOf.set(v.name, v.dims);
  const elements = (dim: string): string[] => model.dims.get(dim)?.elements ?? [];
  const tuplesOf = (dims: string[]): string[][] => product(dims.map(elements));

  // Resolve a positional subscript list against the base symbol's declared dims,
  // under the current elementwise binding, to a concrete element tuple.
  const resolveSubs = (e: Expr & { kind: "index" }, bind: Binding | null): string[] => {
    const dims = dimsOf.get(e.name);
    if (!dims) throw new ScalarizeError(`'${e.name}' is not subscripted, so '${e.name}[${e.subs.join(", ")}]' is invalid`, e.loc);
    if (e.subs.length !== dims.length)
      throw new ScalarizeError(`'${e.name}' has ${dims.length} dimension(s) [${dims.join(", ")}] but is indexed with ${e.subs.length}`, e.loc);
    return e.subs.map((s, i) => {
      const di = dims[i]!;
      if (s === di) {
        // elementwise: pin to the element bound for this dimension in scope
        const el = bind?.get(di);
        if (el === undefined) throw new ScalarizeError(`'${e.name}[${e.subs.join(", ")}]' uses dimension '${di}' outside an elementwise context`, e.loc);
        return el;
      }
      if (elements(di).includes(s)) return s; // a single literal element
      if (model.dims.has(s)) throw new ScalarizeError(`'${e.name}[${e.subs.join(", ")}]' indexes position ${i + 1} with dimension '${s}', but that position is '${di}'`, e.loc);
      throw new ScalarizeError(`'${s}' is not an element of dimension '${di}'`, e.loc);
    });
  };

  // sum(X) collapses every dimension of X; sum(X, d, …) collapses only the named
  // axes and keeps the rest (each pinned to the current elementwise binding). Both
  // lower to an n-ary `+` over the Cartesian product of the collapsed axes.
  const lowerSum = (e: Expr & { kind: "call" }, bind: Binding | null): Expr => {
    const arg = e.args[0];
    const base = arg && (arg.kind === "ident" || arg.kind === "index") ? arg.name : undefined;
    const dims = base ? dimsOf.get(base) : undefined;
    if (!base || !dims) throw new ScalarizeError("sum() needs a subscripted argument, e.g. sum(Population)", e.loc);
    // A literal pin / reorder on the array arg is silently discarded below — reject
    // it (parser flags this too; this guards models built without going through it).
    if (arg!.kind === "index" && (arg!.subs.length !== dims.length || arg!.subs.some((s, i) => s !== dims[i])))
      throw new ScalarizeError(`sum()'s argument '${base}[${arg!.subs.join(", ")}]' can't pin or reorder dimensions — use sum(${base}) or sum(${base}, axis)`, e.loc);

    const axes = e.args.length === 1
      ? dims.slice() // no axis given ⇒ collapse all
      : e.args.slice(1).map((a) => {
          if (a.kind !== "ident" || !dims.includes(a.name))
            throw new ScalarizeError(`sum()'s axis must be a dimension of '${base}' (one of ${dims.join(", ")})`, a.loc);
          return a.name;
        });
    if (new Set(axes).size !== axes.length) throw new ScalarizeError(`sum() lists a dimension more than once`, e.loc);
    const collapsed = new Set(axes);

    const axisTuples = product(axes.map(elements));
    if (!axisTuples.length) throw new ScalarizeError(`'${base}' has a dimension with no elements`, e.loc);
    return axisTuples
      .map((axisTuple) => {
        const pick = new Map<string, string>();
        axes.forEach((d, i) => pick.set(d, axisTuple[i]!));
        // Reassemble the full positional tuple: collapsed axes iterate, the rest
        // are held at the binding of the surrounding elementwise context.
        const tuple = dims.map((d) => {
          if (collapsed.has(d)) return pick.get(d)!;
          const held = bind?.get(d);
          if (held === undefined) throw new ScalarizeError(`sum() over ${axes.join(", ")} leaves dimension '${d}' free — declare the result over '[${d}]'`, e.loc);
          return held;
        });
        return ident(elemName(base, tuple), e.loc);
      })
      .reduce((acc, cur) => ({ kind: "binary", op: "+", left: acc, right: cur, loc: e.loc }));
  };

  // Lower one expression under an optional elementwise binding.
  const sub = (e: Expr, bind: Binding | null): Expr => {
    switch (e.kind) {
      case "num":
        return e;
      case "ident":
        if (dimsOf.has(e.name))
          throw new ScalarizeError(`'${e.name}' is subscripted — index it (${e.name}[${dimsOf.get(e.name)!.join(", ")}]) or aggregate it (sum(${e.name}))`, e.loc);
        return e;
      case "index":
        return ident(elemName(e.name, resolveSubs(e, bind)), e.loc);
      case "unary":
        return { ...e, arg: sub(e.arg, bind) };
      case "binary":
        return { ...e, left: sub(e.left, bind), right: sub(e.right, bind) };
      case "call":
        if (e.name.toLowerCase() === "sum") return lowerSum(e, bind);
        return { ...e, args: e.args.map((a) => sub(a, bind)) };
    }
  };

  // ── expand declarations ──
  // A subscripted decl uses its per-element expression list when given, else the
  // single expression broadcasts to (and is lowered under) every element tuple.
  const expandStock = (s: StockDecl): StockDecl[] => {
    if (!s.dims) return [{ ...s, initExpr: sub(s.initExpr, null) }];
    return tuplesOf(s.dims).map((tuple, i) => ({
      name: elemName(s.name, tuple),
      initExpr: sub(s.elemExprs ? s.elemExprs[i]! : s.initExpr, bindingFor(s.dims!, tuple)),
      unit: s.unit, doc: s.doc, loc: s.loc,
    }));
  };

  const expandVar = (v: VarDecl): VarDecl[] => {
    if (!v.dims) return [{ ...v, expr: sub(v.expr, null) }];
    return tuplesOf(v.dims).map((tuple, i) => ({
      name: elemName(v.name, tuple),
      kind: v.kind,
      expr: sub(v.elemExprs ? v.elemExprs[i]! : v.expr, bindingFor(v.dims!, tuple)),
      unit: v.unit, doc: v.doc, loc: v.loc,
    }));
  };

  const stocks = model.stocks.flatMap(expandStock);
  const vars = model.vars.flatMap(expandVar);
  const order = model.order.flatMap(expandVar);
  const varIndex = new Map(vars.map((v) => [v.name, v]));

  const rates = new Map<string, RateDecl>();
  for (const [base, r] of model.rates) {
    const dims = dimsOf.get(base);
    if (!dims) { rates.set(base, { ...r, expr: sub(r.expr, null) }); continue; }
    for (const tuple of tuplesOf(dims)) {
      const name = elemName(base, tuple);
      rates.set(name, { target: name, expr: sub(r.expr, bindingFor(dims, tuple)), loc: r.loc });
    }
  }

  // `plot Trade` → all of Trade's element tuples.
  const plot = model.plot.flatMap((n) => (dimsOf.has(n) ? tuplesOf(dimsOf.get(n)!).map((t) => elemName(n, t)) : [n]));

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
