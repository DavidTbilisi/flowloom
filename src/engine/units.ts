// ── Dimensional analysis ─────────────────────────────────────────────────────
// The `[unit]` annotation on a stock/var is parsed and carried through the model
// but otherwise inert. This turns it into a *check*: walk the inspectable Expr
// AST and verify the units line up (you can't add widgets to people, exp() wants
// a pure number, d(stock) must be stock-units per time, …). Pure and DOM-free, so
// it rides along with `lint` everywhere lint already runs (CLI, MCP, the editor
// status bar). Everything here is severity "warning" — units never block a run.
//
// The load-bearing design choice: an *un-annotated* name is UNKNOWN, not
// dimensionless. UNKNOWN is contagious and silent, so a partially-annotated model
// only gets warnings where the user has actually annotated enough to make a claim.
// That makes units checking opt-in and incremental instead of a wall of noise.

import type { Model, Diagnostic, Expr, Loc } from "../lang/index.js";

/** A dimension: base-unit token → exponent. Empty map = dimensionless. */
export type Dim = Map<string, number>;

/** Inference result: a concrete dimension, or UNKNOWN (un-annotated / opaque). */
export const UNKNOWN = Symbol("unknown-unit");
export type DimResult = Dim | typeof UNKNOWN;

export class UnitParseError extends Error {}

// ── Dim algebra ──────────────────────────────────────────────────────────────

/** Drop zero exponents so equal dimensions are structurally comparable. */
function clean(d: Dim): Dim {
  for (const [k, v] of d) if (v === 0) d.delete(k);
  return d;
}

export function mulDim(a: Dim, b: Dim): Dim {
  const out: Dim = new Map(a);
  for (const [k, v] of b) out.set(k, (out.get(k) ?? 0) + v);
  return clean(out);
}

export function divDim(a: Dim, b: Dim): Dim {
  const out: Dim = new Map(a);
  for (const [k, v] of b) out.set(k, (out.get(k) ?? 0) - v);
  return clean(out);
}

export function powDim(a: Dim, n: number): Dim {
  const out: Dim = new Map();
  for (const [k, v] of a) out.set(k, v * n);
  return clean(out);
}

export function eqDim(a: Dim, b: Dim): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

export function isDimensionless(d: Dim): boolean {
  return d.size === 0;
}

/** Human-readable form for diagnostics: "widgets/month", "people", "1". */
export function fmtDim(d: Dim): string {
  if (d.size === 0) return "1";
  const num: string[] = [];
  const den: string[] = [];
  for (const [k, v] of [...d].sort((x, y) => x[0].localeCompare(y[0]))) {
    const tok = Math.abs(v) === 1 ? k : `${k}^${Math.abs(v)}`;
    (v > 0 ? num : den).push(tok);
  }
  const top = num.length ? num.join("·") : "1";
  return den.length ? `${top}/${den.join("·")}` : top;
}

// ── Unit-string parser ───────────────────────────────────────────────────────
// A tiny grammar of its own — deliberately NOT the model expression parser, since
// unit tokens (`widgets`, `month`) are free-form vocabulary, not model identifiers,
// and the literal `1` means dimensionless rather than the number one.
//
//   expr   := term (('*'|'/') term)*
//   term   := atom ('^' INTEGER)?
//   atom   := IDENT | '1' | '(' expr ')'

/** One place owns vocabulary equivalence: trim + lowercase, no pluralization magic. */
export function normToken(tok: string): string {
  return tok.trim().toLowerCase();
}

export function parseUnit(src: string): Dim {
  const toks = src.match(/[A-Za-z_]\w*|\d+(?:\.\d+)?|[*/^()]/g) ?? [];
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];

  function atom(): Dim {
    const t = next();
    if (t === undefined) throw new UnitParseError(`unexpected end of unit "${src}"`);
    if (t === "(") {
      const d = expr();
      if (next() !== ")") throw new UnitParseError(`unbalanced parens in unit "${src}"`);
      return d;
    }
    if (t === "1") return new Map();
    if (/^[A-Za-z_]/.test(t)) return new Map([[normToken(t), 1]]);
    throw new UnitParseError(`unexpected "${t}" in unit "${src}"`);
  }

  function term(): Dim {
    let d = atom();
    if (peek() === "^") {
      next();
      const e = next();
      if (e === undefined || !/^-?\d+$/.test(e)) throw new UnitParseError(`unit exponent must be an integer in "${src}"`);
      d = powDim(d, parseInt(e, 10));
    }
    return d;
  }

  function expr(): Dim {
    let d = term();
    while (peek() === "*" || peek() === "/") {
      const op = next();
      d = op === "*" ? mulDim(d, term()) : divDim(d, term());
    }
    return d;
  }

  if (toks.length === 0) return new Map(); // empty unit string ⇒ dimensionless
  const out = expr();
  if (i < toks.length) throw new UnitParseError(`trailing "${peek()}" in unit "${src}"`);
  return out;
}

// ── Inference over the expression AST ────────────────────────────────────────

const warn = (loc: Loc, message: string): Diagnostic => ({ severity: "warning", loc, message });

/** Builtins that demand a dimensionless argument and return a pure number. */
const DIMENSIONLESS_FN = new Set(["exp", "ln", "log", "log10", "sin", "cos", "tan"]);

export interface UnitEnv {
  /** Declared name → its dimension (UNKNOWN when un-annotated). */
  names: Map<string, DimResult>;
  tables: Set<string>;
  /** The time dimension (from `sim timeunit=…`, default the token "time"). */
  time: Dim;
}

/** Fold an expression to a constant integer (literal or negated literal), else undefined. */
function constInt(e: Expr): number | undefined {
  if (e.kind === "num") return Number.isInteger(e.value) ? e.value : undefined;
  if (e.kind === "unary") {
    const a = constInt(e.arg);
    return a === undefined ? undefined : e.op === "-" ? -a : a;
  }
  return undefined;
}

/**
 * Infer the dimension of an expression, pushing a warning for each concrete
 * mismatch. UNKNOWN is contagious and silent: it only warns when both operands
 * carry a known, conflicting dimension.
 */
export function inferDim(e: Expr, env: UnitEnv, out: Diagnostic[]): DimResult {
  switch (e.kind) {
    case "num":
      return new Map(); // a bare number is a pure scalar
    case "ident": {
      if (e.name === "t" || e.name === "time" || e.name === "dt") return env.time;
      if (e.name === "PI" || e.name === "E") return new Map();
      return env.names.get(e.name) ?? UNKNOWN;
    }
    case "index":
      // an element shares the base symbol's declared unit
      return env.names.get(e.name) ?? UNKNOWN;
    case "unary":
      // logical NOT yields a dimensionless boolean; -/+ preserve the dimension
      if (e.op === "!") { inferDim(e.arg, env, out); return new Map(); }
      return inferDim(e.arg, env, out);
    case "binary": {
      const l = inferDim(e.left, env, out);
      const r = inferDim(e.right, env, out);
      switch (e.op) {
        case "<":
        case ">":
        case "<=":
        case ">=":
        case "==":
        case "!=":
          // comparing unlike units is a mistake; the result is a dimensionless 0/1
          if (l !== UNKNOWN && r !== UNKNOWN && !eqDim(l, r)) {
            out.push(warn(e.loc, `unit mismatch: ${fmtDim(l)} ${e.op} ${fmtDim(r)} — both sides must share units`));
          }
          return new Map();
        case "&&":
        case "||":
          // logical connectives operate on booleans and yield a dimensionless 0/1
          return new Map();
        case "*":
          return l === UNKNOWN || r === UNKNOWN ? UNKNOWN : mulDim(l, r);
        case "/":
          return l === UNKNOWN || r === UNKNOWN ? UNKNOWN : divDim(l, r);
        case "+":
        case "-":
        case "%": {
          if (l !== UNKNOWN && r !== UNKNOWN && !eqDim(l, r)) {
            out.push(warn(e.loc, `unit mismatch: ${fmtDim(l)} ${e.op} ${fmtDim(r)} — both sides must share units`));
          }
          return l === UNKNOWN ? r : l;
        }
        case "^": {
          const n = constInt(e.right);
          if (l === UNKNOWN) return UNKNOWN;
          if (isDimensionless(l)) return new Map();
          if (n === undefined) {
            out.push(warn(e.loc, `cannot raise a dimensioned quantity (${fmtDim(l)}) to a non-constant-integer power`));
            return UNKNOWN;
          }
          return powDim(l, n);
        }
      }
      return UNKNOWN;
    }
    case "call":
      return inferCall(e, env, out);
  }
}

function inferCall(e: Expr & { kind: "call" }, env: UnitEnv, out: Diagnostic[]): DimResult {
  const name = e.name.toLowerCase();
  const argDim = (i: number): DimResult => (e.args[i] ? inferDim(e.args[i]!, env, out) : new Map());

  // Lookup tables carry no declared output unit — treat the result as opaque,
  // but still type-check the input expression for its own internal mismatches.
  if (env.tables.has(e.name)) {
    argDim(0);
    return UNKNOWN;
  }

  if (DIMENSIONLESS_FN.has(name)) {
    const a = argDim(0);
    if (a !== UNKNOWN && !isDimensionless(a)) {
      out.push(warn(e.loc, `${e.name}() expects a dimensionless argument, got ${fmtDim(a)}`));
    }
    return new Map();
  }

  switch (name) {
    case "sqrt": {
      const a = argDim(0);
      return a === UNKNOWN ? UNKNOWN : powDim(a, 0.5);
    }
    case "pow": {
      const base = argDim(0);
      const n = e.args[1] ? constInt(e.args[1]) : undefined;
      if (base === UNKNOWN) return UNKNOWN;
      if (isDimensionless(base)) return new Map();
      if (n === undefined) {
        out.push(warn(e.loc, `pow() of a dimensioned base (${fmtDim(base)}) needs a constant-integer exponent`));
        return UNKNOWN;
      }
      return powDim(base, n);
    }
    case "abs":
    case "floor":
    case "ceil":
    case "round":
      return argDim(0);
    case "sign":
      return new Map();
    case "min":
    case "max":
    case "clamp":
      return sameDims(e, env, out);
    case "if": {
      argDim(0); // condition: type-check but don't constrain
      const a = argDim(1);
      const b = argDim(2);
      if (a !== UNKNOWN && b !== UNKNOWN && !eqDim(a, b)) {
        out.push(warn(e.loc, `if() branches disagree on units: ${fmtDim(a)} vs ${fmtDim(b)}`));
      }
      return a === UNKNOWN ? b : a;
    }
    case "step":
      // step(height, t0): result has the height's units.
      return argDim(0);
    case "pulse":
      return new Map();
    case "ramp": {
      // ramp(slope, t0, t1): slope·time.
      const slope = argDim(0);
      return slope === UNKNOWN ? UNKNOWN : mulDim(slope, env.time);
    }
    case "smooth":
    case "smooth3":
    case "delay1":
    case "delay3":
      requireTime(e, 1, env, out);
      return argDim(0);
    case "smoothi": {
      // smoothi(input, τ, init): input and init must agree; τ is a time.
      requireTime(e, 1, env, out);
      const input = argDim(0);
      const init = argDim(2);
      if (input !== UNKNOWN && init !== UNKNOWN && !eqDim(input, init)) {
        out.push(warn(e.loc, `smoothi() init units (${fmtDim(init)}) differ from input (${fmtDim(input)})`));
      }
      return input;
    }
    default:
      // Unknown function: type-check arguments, but the result is opaque.
      for (let i = 0; i < e.args.length; i++) argDim(i);
      return UNKNOWN;
  }
}

/** min/max/clamp: every operand must share a dimension; that dimension is the result. */
function sameDims(e: Expr & { kind: "call" }, env: UnitEnv, out: Diagnostic[]): DimResult {
  let known: Dim | undefined;
  for (const arg of e.args) {
    const d = inferDim(arg, env, out);
    if (d === UNKNOWN) continue;
    if (known === undefined) known = d;
    else if (!eqDim(known, d)) {
      out.push(warn(e.loc, `${e.name}() arguments disagree on units: ${fmtDim(known)} vs ${fmtDim(d)}`));
    }
  }
  return known ?? UNKNOWN;
}

/** Warn if the i-th argument resolves to a known dimension that isn't time. */
function requireTime(e: Expr & { kind: "call" }, i: number, env: UnitEnv, out: Diagnostic[]): void {
  const arg = e.args[i];
  if (!arg) return;
  const d = inferDim(arg, env, out);
  if (d !== UNKNOWN && !eqDim(d, env.time)) {
    out.push(warn(e.loc, `${e.name}() time constant should be in ${fmtDim(env.time)}, got ${fmtDim(d)}`));
  }
}

// ── Top-level check ──────────────────────────────────────────────────────────

/** Build the name→dimension environment, warning on any malformed unit string. */
export function buildUnitEnv(model: Model, out: Diagnostic[]): UnitEnv {
  const names = new Map<string, DimResult>();
  const timeUnit = model.settings.timeunit?.trim();
  const time: Dim = new Map([[timeUnit ? normToken(timeUnit) : "time", 1]]);

  const declare = (name: string, unit: string | undefined, loc: Loc) => {
    if (unit === undefined || unit.trim() === "") {
      names.set(name, UNKNOWN);
      return;
    }
    try {
      names.set(name, parseUnit(unit));
    } catch (err) {
      names.set(name, UNKNOWN);
      out.push(warn(loc, err instanceof UnitParseError ? err.message : `invalid unit "${unit}"`));
    }
  };

  for (const s of model.stocks) declare(s.name, s.unit, s.loc);
  for (const v of model.vars) declare(v.name, v.unit, v.loc);

  return { names, tables: new Set(model.tables.keys()), time };
}

/**
 * Dimensional consistency check. Mirrors `checkTimeConstants` in lint.ts:
 * appends warnings to `out`, never throws on a valid model.
 */
export function checkUnits(model: Model, out: Diagnostic[]): void {
  const env = buildUnitEnv(model, out);

  // Var bodies and stock initialisers are checked for their own internal mismatches.
  for (const v of model.vars) inferDim(v.expr, env, out);
  for (const s of model.stocks) {
    const declared = env.names.get(s.name);
    const init = inferDim(s.initExpr, env, out);
    // A bare numeric initial value is read as "in the stock's units" (idiomatic),
    // so only a concretely dimensioned, conflicting initial value is a mismatch.
    if (declared && declared !== UNKNOWN && init !== UNKNOWN && !isDimensionless(init) && !eqDim(declared, init)) {
      out.push(warn(s.loc, `stock '${s.name}' is ${fmtDim(declared)} but its initial value is ${fmtDim(init)}`));
    }
  }

  // d(stock) must be stock-units per unit of time.
  for (const [name, r] of model.rates) {
    const stockDim = env.names.get(name);
    if (!stockDim || stockDim === UNKNOWN) continue;
    const rateDim = inferDim(r.expr, env, out);
    if (rateDim === UNKNOWN) continue;
    const expected = divDim(stockDim, env.time);
    if (!eqDim(rateDim, expected)) {
      out.push(warn(r.loc, `change(${name}) should be ${fmtDim(expected)} (${fmtDim(stockDim)} per ${fmtDim(env.time)}), got ${fmtDim(rateDim)}`));
    }
  }
}
