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
import { declExprs } from "../lang/index.js";
import { resolveUnit, pluralFolding } from "./unit-library.js";

/** A dimension: base-unit token → exponent. Empty map = dimensionless. */
export type Dim = Map<string, number>;

/** Inference result: a concrete dimension, or UNKNOWN (un-annotated / opaque). */
export const UNKNOWN = Symbol("unknown-unit");
/** A bare numeric literal: unit-polymorphic. `Cash < 0`, `max(0, x)`, `t % 12`
 *  read the literal in the other operand's units (the way a modeller does), so
 *  it never raises a mismatch on its own; under `*` and `/` it is a pure scalar;
 *  an expression that is *only* literals stays polymorphic, matching anything. */
export const LITERAL = Symbol("literal-unit");
export type DimResult = Dim | typeof UNKNOWN | typeof LITERAL;

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

/**
 * Human-readable form for diagnostics: "widgets/month", "people", "1".
 *
 * `display` maps a base dimension back to the spelling the model actually uses,
 * so a model written in months is told its rate should be `people/month` rather
 * than the `people/s` its units reduce to. Reduction is an implementation
 * detail of the check; the modeller's own vocabulary is what a diagnostic
 * should speak.
 */
export function fmtDim(d: Dim, display?: Map<string, string>): string {
  if (d.size === 0) return "1";
  const num: string[] = [];
  const den: string[] = [];
  for (const [k0, v] of [...d].sort((x, y) => x[0].localeCompare(y[0]))) {
    const k = display?.get(k0) ?? k0;
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

/** One place owns vocabulary equivalence: trim + lowercase. Reduction to base
 *  units (and model-local plural folding) happens in `tokenDim` below. */
export function normToken(tok: string): string {
  return tok.trim().toLowerCase();
}

/** How a model spells its units — everything a `[…]` annotation mentions, plus
 *  the `sim timeunit`. Used to fold plurals and to name base dimensions back. */
export interface UnitVocab {
  /** Model-local plural folding, from `pluralFolding`. */
  fold?: Map<string, string>;
  /** Records the spelling each base dimension came from, for diagnostics. */
  display?: Map<string, string>;
}

/**
 * One unit token as a dimension, reduced through the library.
 *
 * A token the library knows becomes its base dimensions (`km` → m, `hour` → s,
 * `people` → person, `W` → kg·m²/s³). One it does not know stays its own base,
 * which is what keeps `widgets`, `GEL` and `customers` working exactly as they
 * always have. The token's own spelling is remembered so diagnostics can speak
 * the model's language rather than SI's.
 */
function tokenDim(raw: string, vocab?: UnitVocab): Dim {
  const norm = normToken(raw);
  const folded = vocab?.fold?.get(norm);
  // Resolve the token *as written* when no plural fold applies: `M` is mega and
  // `m` is milli, the one place in the unit vocabulary where case carries
  // meaning, and lowercasing first turned MW into a milliwatt.
  const known = resolveUnit(folded ?? raw.trim());
  const shown = folded ?? norm;
  if (!known) {
    vocab?.display?.set(shown, shown);
    return new Map([[shown, 1]]);
  }
  // Remember the spelling only for a token that *is* one base dimension —
  // "W" would otherwise claim the name of kg, m and s all at once.
  if (known.dim.length === 1 && known.dim[0]![1] === 1 && !vocab?.display?.has(known.dim[0]![0])) {
    vocab?.display?.set(known.dim[0]![0], shown);
  }
  return new Map(known.dim);
}

/** The scale of one unit token relative to its base (`day` → 86400), or 1. */
export function unitScale(raw: string, vocab?: UnitVocab): number {
  return resolveUnit(vocab?.fold?.get(normToken(raw)) ?? raw.trim())?.factor ?? 1;
}

export function parseUnit(src: string, vocab?: UnitVocab): Dim {
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
    if (/^[A-Za-z_]/.test(t)) return tokenDim(t, vocab);
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
  /** Base dimension → the spelling this model uses for it, so diagnostics speak
   *  the modeller's vocabulary rather than the SI base the check reduces to. */
  display: Map<string, string>;
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
/** Do two inferred dimensions conflict? Only when both are concrete and differ —
 *  UNKNOWN and LITERAL unify with anything. */
function conflict(l: DimResult, r: DimResult): l is Dim {
  return l !== UNKNOWN && l !== LITERAL && r !== UNKNOWN && r !== LITERAL && !eqDim(l, r as Dim);
}

/** The dimension two unified operands share: a concrete one wins over LITERAL,
 *  and LITERAL wins over UNKNOWN only when nothing concrete is present. */
function unify(l: DimResult, r: DimResult): DimResult {
  if (l !== UNKNOWN && l !== LITERAL) return l;
  if (r !== UNKNOWN && r !== LITERAL) return r;
  return l === UNKNOWN || r === UNKNOWN ? UNKNOWN : LITERAL;
}

/** A literal is a pure scalar where it multiplies or divides. */
const scalar = (d: DimResult): DimResult => (d === LITERAL ? new Map() : d);

export function inferDim(e: Expr, env: UnitEnv, out: Diagnostic[]): DimResult {
  switch (e.kind) {
    case "num":
      return LITERAL; // a bare number takes the units of whatever it meets
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
          if (conflict(l, r)) {
            out.push(warn(e.loc, `unit mismatch: ${fmtDim(l, env.display)} ${e.op} ${fmtDim(r as Dim, env.display)} — both sides must share units`));
          }
          return new Map();
        case "&&":
        case "||":
          // logical connectives operate on booleans and yield a dimensionless 0/1
          return new Map();
        case "*": {
          if (l === LITERAL && r === LITERAL) return LITERAL;
          const a = scalar(l), b = scalar(r);
          return a === UNKNOWN || b === UNKNOWN ? UNKNOWN : mulDim(a as Dim, b as Dim);
        }
        case "/": {
          if (l === LITERAL && r === LITERAL) return LITERAL;
          const a = scalar(l), b = scalar(r);
          return a === UNKNOWN || b === UNKNOWN ? UNKNOWN : divDim(a as Dim, b as Dim);
        }
        case "+":
        case "-":
        case "%": {
          if (conflict(l, r)) {
            out.push(warn(e.loc, `unit mismatch: ${fmtDim(l, env.display)} ${e.op} ${fmtDim(r as Dim, env.display)} — both sides must share units`));
          }
          return unify(l, r);
        }
        case "^": {
          const n = constInt(e.right);
          if (l === UNKNOWN) return UNKNOWN;
          if (l === LITERAL) return LITERAL;
          if (isDimensionless(l)) return new Map();
          if (n === undefined) {
            out.push(warn(e.loc, `cannot raise a dimensioned quantity (${fmtDim(l, env.display)}) to a non-constant-integer power`));
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
  // A missing optional argument constrains nothing.
  const argDim = (i: number): DimResult => (e.args[i] ? inferDim(e.args[i]!, env, out) : LITERAL);

  // Lookup tables carry no declared output unit — treat the result as opaque,
  // but still type-check the input expression for its own internal mismatches.
  if (env.tables.has(e.name)) {
    argDim(0);
    return UNKNOWN;
  }

  if (DIMENSIONLESS_FN.has(name)) {
    const a = argDim(0);
    if (a !== UNKNOWN && a !== LITERAL && !isDimensionless(a)) {
      out.push(warn(e.loc, `${e.name}() expects a dimensionless argument, got ${fmtDim(a, env.display)}`));
    }
    return new Map();
  }

  switch (name) {
    case "sqrt": {
      const a = argDim(0);
      return a === UNKNOWN || a === LITERAL ? a : powDim(a, 0.5);
    }
    case "pow": {
      const base = argDim(0);
      const n = e.args[1] ? constInt(e.args[1]) : undefined;
      if (base === UNKNOWN || base === LITERAL) return base;
      if (isDimensionless(base)) return new Map();
      if (n === undefined) {
        out.push(warn(e.loc, `pow() of a dimensioned base (${fmtDim(base, env.display)}) needs a constant-integer exponent`));
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
      if (conflict(a, b)) {
        out.push(warn(e.loc, `if() branches disagree on units: ${fmtDim(a, env.display)} vs ${fmtDim(b as Dim, env.display)}`));
      }
      return unify(a, b);
    }
    case "step":
      // step(height, t0): result has the height's units.
      return argDim(0);
    case "pulse":
      return new Map();
    case "ramp": {
      // ramp(slope, t0, t1): slope·time.
      const slope = argDim(0);
      return slope === UNKNOWN ? UNKNOWN : mulDim(scalar(slope) as Dim, env.time);
    }
    case "smooth":
    case "smooth3":
    case "delay1":
    case "delay3":
      requireTime(e, 1, env, out);
      return argDim(0);
    case "delay_fixed": {
      // delay_fixed(input, length, init?): length is a time; init matches input.
      requireTime(e, 1, env, out);
      const input = argDim(0);
      const init = argDim(2);
      if (conflict(input, init)) out.push(warn(e.loc, `delay_fixed() init units (${fmtDim(init as Dim, env.display)}) differ from input (${fmtDim(input, env.display)})`));
      return unify(input, init);
    }
    case "previous": {
      const input = argDim(0);
      const init = argDim(1);
      if (conflict(input, init)) out.push(warn(e.loc, `previous() init units (${fmtDim(init as Dim, env.display)}) differ from input (${fmtDim(input, env.display)})`));
      return unify(input, init);
    }
    case "smoothi": {
      // smoothi(input, τ, init): input and init must agree; τ is a time.
      requireTime(e, 1, env, out);
      const input = argDim(0);
      const init = argDim(2);
      if (conflict(input, init)) {
        out.push(warn(e.loc, `smoothi() init units (${fmtDim(init as Dim, env.display)}) differ from input (${fmtDim(input, env.display)})`));
      }
      return unify(input, init);
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
  let sawUnknown = false;
  for (const arg of e.args) {
    const d = inferDim(arg, env, out);
    if (d === LITERAL) continue; // a bare number agrees with whatever the others are
    if (d === UNKNOWN) { sawUnknown = true; continue; }
    if (known === undefined) known = d;
    else if (!eqDim(known, d)) {
      out.push(warn(e.loc, `${e.name}() arguments disagree on units: ${fmtDim(known, env.display)} vs ${fmtDim(d, env.display)}`));
    }
  }
  return known ?? (sawUnknown ? UNKNOWN : LITERAL);
}

/** Warn if the i-th argument resolves to a known dimension that isn't time. */
function requireTime(e: Expr & { kind: "call" }, i: number, env: UnitEnv, out: Diagnostic[]): void {
  const arg = e.args[i];
  if (!arg) return;
  const d = inferDim(arg, env, out);
  if (d !== UNKNOWN && d !== LITERAL && !eqDim(d, env.time)) {
    out.push(warn(e.loc, `${e.name}() time constant should be in ${fmtDim(env.time, env.display)}, got ${fmtDim(d, env.display)}`));
  }
}

// ── Top-level check ──────────────────────────────────────────────────────────

/** Build the name→dimension environment, warning on any malformed unit string. */
/** Every unit token the model writes, in source order. */
function unitTokens(model: Model): string[] {
  const toks: string[] = [];
  const take = (u: string | undefined) => {
    for (const t of u?.match(/[A-Za-z_]\w*/g) ?? []) if (t !== "1") toks.push(t);
  };
  for (const s of model.stocks) take(s.unit);
  for (const v of model.vars) take(v.unit);
  take(model.settings.timeunit);
  return toks;
}

export function buildUnitEnv(model: Model, out: Diagnostic[]): UnitEnv {
  const names = new Map<string, DimResult>();
  // The vocabulary is collected before anything is parsed, because plural
  // folding is model-local: `widgets` collapses onto `widget` only if the model
  // writes both. The display map is filled as tokens are resolved.
  const vocab: UnitVocab = { fold: pluralFolding(unitTokens(model)), display: new Map() };
  const timeUnit = model.settings.timeunit?.trim();
  const time: Dim = timeUnit ? parseUnit(timeUnit, vocab) : new Map([["time", 1]]);

  const declare = (name: string, unit: string | undefined, loc: Loc) => {
    if (unit === undefined || unit.trim() === "") {
      names.set(name, UNKNOWN);
      return;
    }
    try {
      names.set(name, parseUnit(unit, vocab));
    } catch (err) {
      names.set(name, UNKNOWN);
      out.push(warn(loc, err instanceof UnitParseError ? err.message : `invalid unit "${unit}"`));
    }
  };

  for (const s of model.stocks) declare(s.name, s.unit, s.loc);
  for (const v of model.vars) declare(v.name, v.unit, v.loc);

  return { names, tables: new Set(model.tables.keys()), time, display: vocab.display! };
}

/**
 * Warn where a model writes two units of the same dimension at different scales.
 *
 * Reducing `hour` and `day` to seconds is what lets them check against each
 * other at all — but flowloom has never rescaled a number for an annotation and
 * will not start, so `X [widgets/hour] * T [day]` is dimensionally clean and
 * numerically out by 24. Dimensional analysis cannot catch that; naming it can.
 * One warning per family, on the `sim` line (or the first declaration), because
 * the fix is one conversion constant, not an edit per site.
 */
function checkUnitScales(model: Model, env: UnitEnv, out: Diagnostic[]): void {
  const fold = pluralFolding(unitTokens(model));
  // base dimension → spelling → the scale it stands for
  const families = new Map<string, Map<string, number>>();
  for (const tok of unitTokens(model)) {
    const norm = normToken(tok);
    const folded = fold.get(norm);
    const known = resolveUnit(folded ?? tok);
    if (!known || known.dim.length !== 1 || known.dim[0]![1] !== 1) continue;
    const base = known.dim[0]![0];
    const seen = families.get(base) ?? new Map<string, number>();
    seen.set(folded ?? norm, known.factor);
    families.set(base, seen);
  }
  const at = model.settings.loc ?? model.stocks[0]?.loc ?? model.vars[0]?.loc;
  if (!at) return;
  for (const [base, seen] of families) {
    const scales = [...new Set(seen.values())];
    if (scales.length < 2) continue;
    const spellings = [...seen.entries()].sort((a, b) => a[1] - b[1]);
    const [smallName, small] = spellings[0]!;
    const [bigName, big] = spellings[spellings.length - 1]!;
    const ratio = big / small;
    out.push(warn(at, `this model measures ${env.display.get(base) ?? base} in ${spellings.map(([n]) => n).join(" and ")} — the same dimension at different scales, so the units check out but the arithmetic does not: 1 ${bigName} = ${Number(ratio.toPrecision(10))} ${smallName}. flowloom never rescales a number for an annotation; make the conversion explicit, e.g. \`const per${bigName[0]!.toUpperCase()}${bigName.slice(1)} [${smallName}/${bigName}] = ${Number(ratio.toPrecision(10))}\`.`));
  }
}

/**
 * Dimensional consistency check. Mirrors `checkTimeConstants` in lint.ts:
 * appends warnings to `out`, never throws on a valid model.
 */
export function checkUnits(model: Model, out: Diagnostic[]): void {
  const env = buildUnitEnv(model, out);
  checkUnitScales(model, env, out);

  // Var bodies and stock initialisers are checked for their own internal mismatches.
  for (const v of model.vars) for (const e of declExprs(v.expr, v.elemExprs)) inferDim(e, env, out);
  for (const s of model.stocks) {
    const declared = env.names.get(s.name);
    // Per-element initials all share the stock's declared unit; check each, compare
    // the first against the declared dimension (the rest are peers of it).
    for (const e of declExprs(s.initExpr, s.elemExprs).slice(1)) inferDim(e, env, out);
    const init = inferDim(s.initExpr, env, out);
    // A bare numeric initial value is read as "in the stock's units" (idiomatic),
    // so only a concretely dimensioned, conflicting initial value is a mismatch.
    if (declared && declared !== UNKNOWN && declared !== LITERAL && init !== UNKNOWN && init !== LITERAL && !isDimensionless(init) && !eqDim(declared, init)) {
      out.push(warn(s.loc, `stock '${s.name}' is ${fmtDim(declared, env.display)} but its initial value is ${fmtDim(init, env.display)}`));
    }
  }

  // d(stock) must be stock-units per unit of time — except under method=map,
  // where change() is a per-step increment and carries the stock's own units.
  const isMap = model.settings.method === "map";
  for (const [name, r] of model.rates) {
    const stockDim = env.names.get(name);
    if (!stockDim || stockDim === UNKNOWN || stockDim === LITERAL) continue;
    const rateDim = inferDim(r.expr, env, out);
    if (rateDim === UNKNOWN || rateDim === LITERAL) continue;
    const expected = isMap ? stockDim : divDim(stockDim, env.time);
    if (!eqDim(rateDim, expected)) {
      const why = isMap
        ? `(a per-step increment under method=map — the stock's own units, not per ${fmtDim(env.time, env.display)})`
        : `(${fmtDim(stockDim, env.display)} per ${fmtDim(env.time, env.display)})`;
      out.push(warn(r.loc, `change(${name}) should be ${fmtDim(expected, env.display)} ${why}, got ${fmtDim(rateDim, env.display)}`));
    }
  }
}
