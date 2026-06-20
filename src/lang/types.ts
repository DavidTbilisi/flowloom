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
  | { kind: "unary"; op: "-" | "+"; arg: Expr; loc: Loc }
  | { kind: "binary"; op: BinOp; left: Expr; right: Expr; loc: Loc }
  | { kind: "call"; name: string; args: Expr[]; loc: Loc }
  // Subscripted reference: `name[sub]`, where sub is a dimension name (elementwise
  // / aggregate context) or a single element name. Lowered to scalars at compile.
  | { kind: "index"; name: string; sub: string; loc: Loc };

export type BinOp = "+" | "-" | "*" | "/" | "%" | "^";

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
  unit?: string;
  /** Subscript dimension this stock is declared over (e.g. "region"), if any. */
  dim?: string;
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
  unit?: string;
  /** Subscript dimension this var is declared over, if any. */
  dim?: string;
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
