// ── flowloom model language: shared types ──────────────────────────────────
// The text DSL is the *canonical* representation of a model — the thing humans
// and AIs read and write. Everything else (diagram, plot, animation) is derived
// from a parsed Model. These types are the contract between parser and engine.

/** Source location for diagnostics. 1-based line, 0-based column. */
export interface Loc {
  line: number;
  col: number;
}

/** A parse/validation diagnostic tied to a location in the source text. */
export interface Diagnostic {
  message: string;
  loc: Loc;
  severity: "error" | "warning";
}

// ── Expression AST ──────────────────────────────────────────────────────────
// A small, evaluable, *inspectable* AST. Inspectable matters: we extract
// dependencies, compute influence-edge signs symbolically where possible, and
// can pretty-print or transform expressions for AI round-tripping.

export type Expr =
  | { kind: "num"; value: number; loc: Loc }
  | { kind: "ident"; name: string; loc: Loc }
  | { kind: "unary"; op: "-" | "+" | "!"; arg: Expr; loc: Loc }
  | { kind: "binary"; op: BinOp; left: Expr; right: Expr; loc: Loc }
  | { kind: "call"; name: string; args: Expr[]; loc: Loc }
  // Subscripted reference: `name[sub, …]`, one entry per dimension of `name`
  // (positional). Each sub is a dimension name (elementwise / aggregate context)
  // or a single element name. Lowered to scalars at compile (scalarize.ts).
  | { kind: "index"; name: string; subs: string[]; loc: Loc };

export type BinOp =
  | "+" | "-" | "*" | "/" | "%" | "^"
  // Comparisons and logical connectives. They return 1 (true) or 0 (false); any
  // non-zero operand is "true" for `&&`/`||`. This is what makes `if(cond,a,b)`
  // usable — `cond` is built from these.
  | "<" | ">" | "<=" | ">=" | "==" | "!="
  | "&&" | "||";

/** The declaration kinds a non-stock variable can have. */
export type VarKind = "flow" | "aux" | "param";

/** A subscript dimension: an ordered, named list of elements. */
export interface DimDecl {
  name: string;
  elements: string[];
  loc: Loc;
}

export interface StockDecl {
  name: string;
  initExpr: Expr;
  /** Per-element initial values for a subscripted stock, in Cartesian-product
   *  order (`= a, b, …`). When set, overrides initExpr per element; initExpr holds
   *  the first entry so single-expr consumers still see a value. */
  elemExprs?: Expr[];
  unit?: string;
  /** Subscript dimensions this stock is declared over (e.g. ["region"]), if any. */
  dims?: string[];
  doc?: string;
  loc: Loc;
}

export interface RateDecl {
  /** Stock this is the derivative of. */
  target: string;
  expr: Expr;
  loc: Loc;
}

export interface VarDecl {
  name: string;
  kind: VarKind;
  expr: Expr;
  /** Per-element expressions for a subscripted var, in Cartesian-product order
   *  (`= a, b, …`). When set, overrides expr per element; expr holds the first. */
  elemExprs?: Expr[];
  unit?: string;
  /** Subscript dimensions this var is declared over, if any. */
  dims?: string[];
  /** Declared with `switch` — a 0/1 policy toggle. Still `kind: "param"` so every
   *  consumer that treats params as knobs keeps working; the flag lets sensitivity
   *  test off→on instead of ±frac, sliders render a toggle, and overrides accept
   *  on/off. */
  boolean?: true;
  /** Declared with `const` — a structural constant (a calendar length, a unit
   *  conversion), not a knob. Still `kind: "param"`, but sensitivity, sliders
   *  and calibration leave it alone unless it is named explicitly. */
  constant?: true;
  /** Meadows leverage-point rung (12 … 1) from a `@rung N` tag in the doc comment. */
  rung?: number;
  doc?: string;
  loc: Loc;
}

/** One `key=value` binding inside a `scenario` line. The value is kept as the
 *  literal text it was written as (a number, `on`/`off`, `euler`/`rk4`) and is
 *  applied through the same override path as the CLI's `--set`. */
export interface ScenarioSet {
  key: string;
  value: string;
}

/** A named set of overrides declared in the model text:
 *  `scenario NAME key=value key=value …`. Scenarios are part of the canonical
 *  text (a policy experiment is a first-class artefact, not shell history) and
 *  are applied on top of the base model when chosen. */
export interface ScenarioDecl {
  name: string;
  sets: ScenarioSet[];
  /** Meadows leverage-point rung (12 … 1) from a `@rung N` tag in the doc comment. */
  rung?: number;
  doc?: string;
  loc: Loc;
}

/** A declared signed influence — `link A -> B +` — the qualitative unit of a
 *  causal-loop diagram. Endpoints may be equation-level names or bare
 *  qualitative nodes; a model made only of links draws and has loops but does
 *  not simulate. */
export interface LinkDecl {
  from: string;
  to: string;
  sign: 1 | -1;
  doc?: string;
  loc: Loc;
}

/** A graphical / lookup function: piecewise-linear over (x,y) breakpoints. */
export interface TableDecl {
  name: string;
  points: Array<[number, number]>;
  loc: Loc;
}

export interface SimSettings {
  dt: number;
  to: number;
  start: number;
  method: "euler" | "rk4";
  /** Optional name of the time unit, used by units checking (e.g. "month"). */
  timeunit?: string;
  /** RNG seed for random*() builtins. Defaults to 0 ⇒ runs are reproducible. */
  seed?: number;
}

/** A fully parsed, validated model ready to simulate. */
export interface Model {
  stocks: StockDecl[];
  rates: Map<string, RateDecl>;
  vars: VarDecl[];
  varIndex: Map<string, VarDecl>;
  tables: Map<string, TableDecl>;
  /** Declared subscript dimensions, by name. Consumed (emptied) by scalarization. */
  dims: Map<string, DimDecl>;
  /** Named override sets (`scenario` lines), by name. The base model is the text itself. */
  scenarios: Map<string, ScenarioDecl>;
  /** Declared signed influences (`link` lines) — a causal-loop sketch, with or without equations. */
  links: LinkDecl[];
  settings: SimSettings;
  /** Series chosen to be visible by default (the `plot` line). */
  plot: string[];
  /** Evaluation order for vars (topologically sorted, params first). */
  order: VarDecl[];
  diagnostics: Diagnostic[];
}

export const DEFAULT_SETTINGS: SimSettings = {
  dt: 0.1,
  to: 50,
  start: 0,
  method: "rk4",
};
