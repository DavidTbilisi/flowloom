import type { Expr, Model, TableDecl, VarDecl, Loc, LinkDecl } from "../lang/types.js";
import { freeVars } from "../lang/expr.js";
import { ModelError } from "../lang/parser.js";
import { scalarize } from "../lang/scalarize.js";
import { validateModel } from "./validate.js";

// ── Compiler: expand stateful delays into internal stocks ───────────────────
// SMOOTH / SMOOTHI / SMOOTH3 / DELAY1 / DELAY3 carry state over time, so they
// can't be evaluated as pure functions. We rewrite each call site into a plain
// reference to a freshly-created internal stock and register that stock's
// initial value + derivative. After this pass the model is an ordinary
// stock-and-flow system that the integrator handles uniformly (incl. RK4).
//
// PREVIOUS / DELAY_FIXED are stateful too, but they are *not* differential: the
// output at step i is the input sampled exactly n steps earlier (a pipeline, not
// an exponential lag). They can't be written as stocks, so each call site becomes
// a FixedDelay record: the input becomes an internal aux (evaluated with the
// other vars), and the output is a plain scope slot that the integrator fills
// from a per-delay ring buffer before each step (sample-and-hold across RK4
// sub-stages). The integrator is shared by every backend, so the TS and WASM
// paths agree by construction — the backends only ever read the output slot.

export interface StateVar {
  name: string;
  isInternal: boolean;
  initExpr: Expr;
  /** Net rate of change; null means a constant stock (no d() defined). */
  rateExpr: Expr | null;
  /** User-facing kind for series labelling. */
  unit?: string | undefined;
  /** Declared `>= 0` (user stocks only): the integrator floors it at zero. */
  nonNegative?: boolean;
}

export interface CompiledVar {
  name: string;
  kind: VarDecl["kind"];
  expr: Expr;
  unit?: string | undefined;
  /** Compiler-generated (a fixed delay's sampled input) — hidden from the
   *  influence graph and outputs, like delay#N stocks. */
  isInternal?: boolean;
}

/** One `previous()` / `delay_fixed()` call site after rewriting. */
export interface FixedDelay {
  /** Output name (`prev#N` / `fixed#N`), referenced where the call was. */
  name: string;
  /** Name of the internal aux that samples the input each step. */
  inputVar: string;
  /** The rewritten input expression (for the influence graph). */
  inputExpr: Expr;
  /** Delay length in time units; null ⇒ exactly one step (`previous`). Read once at t=start. */
  delayExpr: Expr | null;
  /** Output before enough history exists; defaults to the input's initial value. */
  initExpr: Expr;
}

export interface Compiled {
  /** Integration state, in order: user stocks first, then internal delay stocks. */
  state: StateVar[];
  /** Aux/flow/param vars in evaluation (topological) order, exprs rewritten.
   *  Fixed-delay input samplers come last (they depend on everything else and
   *  nothing instantaneous depends on them). */
  order: CompiledVar[];
  /** Sample-and-hold delays, in creation order (see FixedDelay). */
  fixed: FixedDelay[];
  /** Declared signed influences (`link` lines) — carried for the loop analyzer. */
  links: LinkDecl[];
  tables: Map<string, TableDecl>;
  /** Names of the user-authored stocks (for default plotting / labelling). */
  userStocks: string[];
}

export function compile(inModel: Model): Compiled {
  // Reject unknown / mis-arity function calls up front, with a source location —
  // otherwise codegen throws a line-less "unknown function" deep in the backend.
  const callErrors = validateModel(inModel);
  if (callErrors.length) throw new ModelError(callErrors);

  // Expand subscript dimensions to scalars first, so everything below (and the
  // whole engine) deals only with scalar names — see scalarize.ts.
  const model = scalarize(inModel);
  const internal: StateVar[] = [];
  const fixed: FixedDelay[] = [];
  let counter = 0;
  const fresh = (): string => `delay#${counter++}`;
  let fixedCounter = 0;
  const freshFixed = (prefix: string): string => `${prefix}#${fixedCounter++}`;

  const ctx: RewriteCtx = { internal, fixed, fresh, freshFixed };
  const rewrite = (e: Expr): Expr => rewriteExpr(e, ctx, rewrite);

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
    ...(s.nonNegative ? { nonNegative: true } : {}),
  }));

  // The samplers go after every user var: a fixed delay's input may depend on
  // anything, and nothing reads a sampler instantaneously (the integrator does,
  // at the step boundary). Order among samplers doesn't matter for the same reason.
  const samplers: CompiledVar[] = fixed.map((f) => ({ name: f.inputVar, kind: "aux", expr: f.inputExpr, isInternal: true }));

  return {
    state: [...userState, ...internal],
    order: [...order, ...samplers],
    fixed,
    links: model.links,
    tables: model.tables,
    userStocks: model.stocks.map((s) => s.name),
  };
}

interface RewriteCtx {
  internal: StateVar[];
  fixed: FixedDelay[];
  fresh: () => string;
  freshFixed: (prefix: string) => string;
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

function rewriteExpr(e: Expr, ctx: RewriteCtx, recur: (e: Expr) => Expr): Expr {
  const { internal, fresh } = ctx;
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
        case "previous":
          return makeFixed("prev", args[0]!, null, args[1], ctx);
        case "delay_fixed":
          return makeFixed("fixed", args[0]!, args[1]!, args[2], ctx);
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

// previous(X, init?) / delay_fixed(X, n, init?): register a sample-and-hold
// delay and return a reference to its output slot. The input is hoisted into an
// internal aux so the integrator can read its value each step without
// re-evaluating an arbitrary expression itself.
function makeFixed(prefix: string, input: Expr, delay: Expr | null, init: Expr | undefined, ctx: RewriteCtx): Expr {
  const name = ctx.freshFixed(prefix);
  const inputVar = `${name}.in`;
  ctx.fixed.push({
    name,
    inputVar,
    inputExpr: input,
    delayExpr: delay,
    // Default init: the input's own value at t=start, so a delay on a steady
    // input starts in equilibrium (same convention as smooth()).
    initExpr: init ?? id(inputVar),
  });
  return id(name);
}

/** Free variables actually used after rewriting (for influence-graph building). */
export function compiledFreeVars(e: Expr): Set<string> {
  return freeVars(e);
}
