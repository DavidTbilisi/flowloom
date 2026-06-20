import type { Expr, Model, TableDecl, VarDecl, Loc } from "../lang/types.js";
import { freeVars } from "../lang/expr.js";
import { scalarize } from "../lang/scalarize.js";

// ── Compiler: expand stateful delays into internal stocks ───────────────────
// SMOOTH / SMOOTHI / SMOOTH3 / DELAY1 / DELAY3 carry state over time, so they
// can't be evaluated as pure functions. We rewrite each call site into a plain
// reference to a freshly-created internal stock and register that stock's
// initial value + derivative. After this pass the model is an ordinary
// stock-and-flow system that the integrator handles uniformly (incl. RK4).

export interface StateVar {
  name: string;
  isInternal: boolean;
  initExpr: Expr;
  /** Net rate of change; null means a constant stock (no d() defined). */
  rateExpr: Expr | null;
  /** User-facing kind for series labelling. */
  unit?: string | undefined;
}

export interface CompiledVar {
  name: string;
  kind: VarDecl["kind"];
  expr: Expr;
  unit?: string | undefined;
}

export interface Compiled {
  /** Integration state, in order: user stocks first, then internal delay stocks. */
  state: StateVar[];
  /** Aux/flow/param vars in evaluation (topological) order, exprs rewritten. */
  order: CompiledVar[];
  tables: Map<string, TableDecl>;
  /** Names of the user-authored stocks (for default plotting / labelling). */
  userStocks: string[];
}

export function compile(inModel: Model): Compiled {
  // Expand subscript dimensions to scalars first, so everything below (and the
  // whole engine) deals only with scalar names — see scalarize.ts.
  const model = scalarize(inModel);
  const internal: StateVar[] = [];
  let counter = 0;
  const fresh = (): string => `delay#${counter++}`;

  const rewrite = (e: Expr): Expr => rewriteExpr(e, internal, fresh, rewrite);

  const order: CompiledVar[] = model.order.map((v) => ({
    name: v.name,
    kind: v.kind,
    expr: rewrite(v.expr),
    unit: v.unit,
  }));

  const userState: StateVar[] = model.stocks.map((s) => ({
    name: s.name,
    isInternal: false,
    initExpr: rewrite(s.initExpr),
    rateExpr: model.rates.has(s.name) ? rewrite(model.rates.get(s.name)!.expr) : null,
    unit: s.unit,
  }));

  return {
    state: [...userState, ...internal],
    order,
    tables: model.tables,
    userStocks: model.stocks.map((s) => s.name),
  };
}

// ── AST helpers ─────────────────────────────────────────────────────────────
const L0: Loc = { line: 0, col: 0 };
const id = (name: string): Expr => ({ kind: "ident", name, loc: L0 });
const num = (value: number): Expr => ({ kind: "num", value, loc: L0 });
const bin = (op: "+" | "-" | "*" | "/", left: Expr, right: Expr): Expr => ({
  kind: "binary",
  op,
  left,
  right,
  loc: L0,
});

function rewriteExpr(
  e: Expr,
  internal: StateVar[],
  fresh: () => string,
  recur: (e: Expr) => Expr,
): Expr {
  switch (e.kind) {
    case "num":
    case "ident":
    case "index": // subscripts are lowered to scalars before this pass (scalarize)
      return e;
    case "unary":
      return { ...e, arg: recur(e.arg) };
    case "binary":
      return { ...e, left: recur(e.left), right: recur(e.right) };
    case "call": {
      const name = e.name.toLowerCase();
      const args = e.args.map(recur);
      switch (name) {
        case "smooth":
          return makeSmooth(args[0]!, args[1]!, args[0]!, internal, fresh);
        case "smoothi":
          return makeSmooth(args[0]!, args[1]!, args[2]!, internal, fresh);
        case "smooth3":
          return makeSmoothN(args[0]!, args[1]!, 3, internal, fresh);
        case "delay1":
          return makeDelayN(args[0]!, args[1]!, 1, internal, fresh);
        case "delay3":
          return makeDelayN(args[0]!, args[1]!, 3, internal, fresh);
        default:
          return { ...e, args };
      }
    }
  }
}

// First-order exponential smooth: dS/dt = (input - S)/τ, output = S.
function makeSmooth(input: Expr, tau: Expr, init: Expr, internal: StateVar[], fresh: () => string): Expr {
  const name = fresh();
  internal.push({
    name,
    isInternal: true,
    initExpr: init,
    rateExpr: bin("/", bin("-", input, id(name)), tau),
  });
  return id(name);
}

// n-stage cascaded smooth, each stage with time constant τ/n.
function makeSmoothN(input: Expr, tau: Expr, n: number, internal: StateVar[], fresh: () => string): Expr {
  const tauN = bin("/", tau, num(n));
  let prev = input;
  let out: Expr = input;
  for (let i = 0; i < n; i++) {
    out = makeSmooth(prev, tauN, input, internal, fresh);
    prev = out;
  }
  return out;
}

// n-th order material delay. Each stage holds a level L_i; outflow = L_i/τ_n.
// dL_1/dt = input − L_1/τ_n ; dL_k/dt = L_{k-1}/τ_n − L_k/τ_n. Output = L_n/τ_n.
function makeDelayN(input: Expr, tau: Expr, n: number, internal: StateVar[], fresh: () => string): Expr {
  const tauN = bin("/", tau, num(n));
  let inflow = input;
  let out: Expr = input;
  for (let i = 0; i < n; i++) {
    const name = fresh();
    const level = id(name);
    const outflow = bin("/", level, tauN);
    internal.push({
      name,
      isInternal: true,
      // steady-state initial level so the delay starts in equilibrium with its input
      initExpr: bin("*", input, tauN),
      rateExpr: bin("-", inflow, outflow),
    });
    inflow = outflow;
    out = outflow;
  }
  return out;
}

/** Free variables actually used after rewriting (for influence-graph building). */
export function compiledFreeVars(e: Expr): Set<string> {
  return freeVars(e);
}
