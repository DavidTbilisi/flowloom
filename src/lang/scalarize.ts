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

/**
 * Every element tuple of a declaration's dimensions, in the order a per-element
 * value list (`= a, b, c`) and the expansion below both use. Exported because
 * anything that addresses one element by position — a `--set Pop[North]=…`
 * override, for one — has to agree with that order exactly.
 */
export function elemTuples(dims: string[], all: Map<string, { elements: string[] }>): string[][] {
  return product(dims.map((d) => all.get(d)?.elements ?? []));
}

/** Cartesian product of per-dimension element lists: [[A,B],[X,Y]] → AX AY BX BY. */
function product(lists: string[][]): string[][] {
  return lists.reduce<string[][]>(
    (acc, list) => acc.flatMap((tuple) => list.map((el) => [...tuple, el])),
    [[]],
  );
}

/** The array reducers. `sum` is always one; min/max double as scalar builtins. */
export const REDUCERS = new Set(["sum", "mean", "min", "max"]);

/**
 * Does this call reduce an array?
 *
 * True when the function is a reducer and its first argument is a *bare* name
 * declared over dimensions. That is the whole disambiguation rule: `min(X)` over
 * a subscripted X collapses it, `min(X[North], 5)` and `min(a, b)` are the
 * ordinary variadic builtin. `dimsOf` is supplied by the caller because the
 * parser and the scalarizer each hold their own copy of it.
 */
export function isArrayReduction(
  e: Expr & { kind: "call" },
  dimsOf: (name: string) => string[] | undefined,
): boolean {
  const fn = e.name.toLowerCase();
  if (!REDUCERS.has(fn)) return false;
  // `sum` and `mean` exist only as reducers, so they are always one — and
  // `mean(3)` gets "needs a subscripted argument" rather than sliding through as
  // an unknown function. min/max also have a scalar meaning, so they reduce only
  // when handed a bare name that is actually subscripted.
  if (fn === "sum" || fn === "mean") return true;
  const arg = e.args[0];
  return !!arg && arg.kind === "ident" && !!dimsOf(arg.name)?.length;
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

  // R(X) collapses every dimension of X; R(X, d, …) collapses only the named axes
  // and keeps the rest (each pinned to the current elementwise binding). All four
  // reducers lower to the same element list over the Cartesian product of the
  // collapsed axes; only what they build from it differs.
  const lowerReduce = (e: Expr & { kind: "call" }, bind: Binding | null): Expr => {
    const fn = e.name.toLowerCase();
    const arg = e.args[0];
    const base = arg && (arg.kind === "ident" || arg.kind === "index") ? arg.name : undefined;
    const dims = base ? dimsOf.get(base) : undefined;
    if (!base || !dims) throw new ScalarizeError(`${fn}() needs a subscripted argument, e.g. ${fn}(Population)`, e.loc);
    // A literal pin / reorder on the array arg is silently discarded below — reject
    // it (parser flags this too; this guards models built without going through it).
    if (arg!.kind === "index" && (arg!.subs.length !== dims.length || arg!.subs.some((s, i) => s !== dims[i])))
      throw new ScalarizeError(`${fn}()'s argument '${base}[${arg!.subs.join(", ")}]' can't pin or reorder dimensions — use ${fn}(${base}) or ${fn}(${base}, axis)`, e.loc);

    const axes = e.args.length === 1
      ? dims.slice() // no axis given ⇒ collapse all
      : e.args.slice(1).map((a) => {
          if (a.kind !== "ident" || !dims.includes(a.name))
            throw new ScalarizeError(`${fn}()'s axis must be a dimension of '${base}' (one of ${dims.join(", ")})`, a.loc);
          return a.name;
        });
    if (new Set(axes).size !== axes.length) throw new ScalarizeError(`${fn}() lists a dimension more than once`, e.loc);
    const collapsed = new Set(axes);

    const axisTuples = product(axes.map(elements));
    if (!axisTuples.length) throw new ScalarizeError(`'${base}' has a dimension with no elements`, e.loc);
    const parts = axisTuples.map((axisTuple) => {
      const pick = new Map<string, string>();
      axes.forEach((d, i) => pick.set(d, axisTuple[i]!));
      // Reassemble the full positional tuple: collapsed axes iterate, the rest
      // are held at the binding of the surrounding elementwise context.
      const tuple = dims.map((d) => {
        if (collapsed.has(d)) return pick.get(d)!;
        const held = bind?.get(d);
        if (held === undefined) throw new ScalarizeError(`${fn}() over ${axes.join(", ")} leaves dimension '${d}' free — declare the result over '[${d}]'`, e.loc);
        return held;
      });
      return ident(elemName(base, tuple), e.loc);
    });

    const total = (): Expr => {
      let acc: Expr = parts[0]!;
      for (const cur of parts.slice(1)) acc = { kind: "binary", op: "+", left: acc, right: cur, loc: e.loc };
      return acc;
    };
    switch (fn) {
      case "sum": return total();
      // The divisor is the element count, folded in here rather than left as a
      // division by a name — the number of elements is known at lowering time.
      case "mean": return { kind: "binary", op: "/", left: total(), right: { kind: "num", value: parts.length, loc: e.loc }, loc: e.loc };
      // min/max are variadic builtins already, so one call over the elements is
      // both the smallest tree and exactly what a hand-written model would say.
      default: return { kind: "call", name: fn, args: parts, loc: e.loc };
    }
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
        // A reduction is signalled by a *bare subscripted name* in the first
        // argument: `min(Population)` collapses the array, while
        // `min(Population[North], 5)` is the ordinary scalar builtin. One rule,
        // and it keeps min/max working as they always have.
        if (isArrayReduction(e, (n) => dimsOf.get(n))) return lowerReduce(e, bind);
        return { ...e, args: e.args.map((a) => sub(a, bind)) };
    }
  };

  // ── expand declarations ──
  // A subscripted decl uses its per-element expression list when given, else the
  // single expression broadcasts to (and is lowered under) every element tuple.
  // Spread the declaration rather than rebuilding it field by field: an element
  // is the same *kind* of thing its declaration was, so every flag on it —
  // `nonNegative`, `constant`, `boolean`, `data`, `rung` — has to survive the
  // expansion. Only the two things scalarization consumes are dropped, and only
  // the two things it computes are overwritten.
  const scalarized = <T extends { dims?: string[]; elemExprs?: Expr[] }>(d: T): Omit<T, "dims" | "elemExprs"> => {
    const { dims: _dims, elemExprs: _elems, ...rest } = d;
    return rest;
  };

  const expandStock = (s: StockDecl): StockDecl[] => {
    if (!s.dims) return [{ ...s, initExpr: sub(s.initExpr, null) }];
    return tuplesOf(s.dims).map((tuple, i) => ({
      ...scalarized(s),
      name: elemName(s.name, tuple),
      initExpr: sub(s.elemExprs ? s.elemExprs[i]! : s.initExpr, bindingFor(s.dims!, tuple)),
    }));
  };

  const expandVar = (v: VarDecl): VarDecl[] => {
    if (!v.dims) return [{ ...v, expr: sub(v.expr, null) }];
    return tuplesOf(v.dims).map((tuple, i) => ({
      ...scalarized(v),
      name: elemName(v.name, tuple),
      expr: sub(v.elemExprs ? v.elemExprs[i]! : v.expr, bindingFor(v.dims!, tuple)),
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
    scenarios: model.scenarios,
    links: model.links,
    expects: model.expects,
    settings: model.settings,
    plot,
    order,
    diagnostics: model.diagnostics,
  };
}
