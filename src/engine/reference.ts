// ── Language reference catalog ──────────────────────────────────────────────
// One DOM-free table describing every keyword, builtin, and reserved constant
// of the .flow language: a signature, a one-line summary, and (for callables)
// the arity. It is the single source of truth shared by the three headless
// consumers that can't reach src/ui — the CLI (`flowloom reference`), the MCP
// server (the `flow://reference` resource), and the llms.txt generator — plus
// src/ui/help-content.ts, which derives its status-bar entries from this so the
// editor help and the agent-facing reference can never drift.
//
// Arity comes straight from ARITY/STATEFUL in builtins.ts, so adding a builtin
// there and forgetting it here is caught by reference.test.ts.

import { ARITY, STATEFUL } from "./builtins.js";

export type RefKind = "keyword" | "const" | "builtin" | "stateful";

export interface RefEntry {
  name: string;
  kind: RefKind;
  /** Canonical signature, e.g. `step(height, t0)` or `stock NAME = EXPR`. */
  signature: string;
  /** One-line explanation. */
  summary: string;
  /** Argument count [min, max] for callable builtins/stateful. */
  arity?: [number, number];
  /** Anchor in docs/language.md / the Format tab, when one exists. */
  doc?: string;
}

// ── line keywords ────────────────────────────────────────────────────────────
const KEYWORDS: RefEntry[] = [
  { name: "stock", kind: "keyword", signature: "stock NAME [unit] = EXPR", doc: "stocks", summary: "An accumulator (an integral). EXPR is its initial value; it then changes only through its change() rate." },
  { name: "change", kind: "keyword", signature: "change(NAME) = EXPR", doc: "stocks", summary: "The net rate of change of a stock — literally dNAME/dt. This line is the engine; flowloom integrates it." },
  { name: "d", kind: "keyword", signature: "d(NAME) = EXPR", doc: "stocks", summary: "Shorthand alias of change(NAME) — the net rate of change of a stock (dNAME/dt)." },
  { name: "flow", kind: "keyword", signature: "flow NAME [unit] = EXPR", doc: "vars", summary: "A named rate. Same maths as aux, but drawn as a flow on the diagram." },
  { name: "aux", kind: "keyword", signature: "aux NAME [unit] = EXPR", doc: "vars", summary: "An instantaneous computed value (a converter/variable) recomputed every step." },
  { name: "param", kind: "keyword", signature: "param NAME [unit] = EXPR", doc: "vars", summary: "A constant knob — evaluated once. `const` is an alias." },
  { name: "const", kind: "keyword", signature: "const NAME [unit] = EXPR", doc: "vars", summary: "A constant knob (alias of param)." },
  { name: "table", kind: "keyword", signature: "table NAME = (x,y) (x,y) …", doc: "tables", summary: "A graphical lookup function; call it as NAME(x). Piecewise-linear, clamped past the ends." },
  { name: "dim", kind: "keyword", signature: "dim NAME = A, B, C", doc: "subscripts", summary: "A subscript dimension (array index) with named elements. Declare arrays as stock X[NAME], use X[NAME] elementwise, and collapse with sum(X)." },
  { name: "sim", kind: "keyword", signature: "sim dt=.1 to=50 start=0 method=rk4", doc: "sim", summary: "Simulation settings. The toolbar edits this line — the text stays canonical." },
  { name: "plot", kind: "keyword", signature: "plot A B C", doc: "sim", summary: "Which series start visible on the plot and legend." },
];

// ── reserved constants / clock identifiers ───────────────────────────────────
const CONSTS: RefEntry[] = [
  { name: "t", kind: "const", signature: "t", summary: "The current simulation time. `time` is an alias. Use it to drive test inputs." },
  { name: "time", kind: "const", signature: "time", summary: "The current simulation time (alias of t)." },
  { name: "dt", kind: "const", signature: "dt", summary: "The integration step size, set on the sim line." },
  { name: "PI", kind: "const", signature: "PI", summary: "The constant π ≈ 3.14159." },
  { name: "E", kind: "const", signature: "E", summary: "Euler's number e ≈ 2.71828." },
];

// ── stateless builtins (math + test inputs) ──────────────────────────────────
// Arity is attached from ARITY below, so it can't drift from the validator.
const BUILTINS: Array<Omit<RefEntry, "arity">> = [
  { name: "sum", kind: "builtin", signature: "sum(X)", doc: "subscripts", summary: "Total of a subscripted X over its dimension — collapses an array to a scalar (e.g. sum(Population))." },
  { name: "min", kind: "builtin", signature: "min(a, b, …)", summary: "Smallest of its arguments." },
  { name: "max", kind: "builtin", signature: "max(a, b, …)", summary: "Largest of its arguments." },
  { name: "abs", kind: "builtin", signature: "abs(x)", summary: "Absolute value." },
  { name: "exp", kind: "builtin", signature: "exp(x)", summary: "e raised to the power x." },
  { name: "ln", kind: "builtin", signature: "ln(x)", summary: "Natural logarithm." },
  { name: "log", kind: "builtin", signature: "log(x)", summary: "Natural logarithm (same as ln)." },
  { name: "log10", kind: "builtin", signature: "log10(x)", summary: "Base-10 logarithm." },
  { name: "sqrt", kind: "builtin", signature: "sqrt(x)", summary: "Square root." },
  { name: "pow", kind: "builtin", signature: "pow(x, y)", summary: "x raised to the power y (same as x ^ y)." },
  { name: "sin", kind: "builtin", signature: "sin(x)", summary: "Sine (radians)." },
  { name: "cos", kind: "builtin", signature: "cos(x)", summary: "Cosine (radians)." },
  { name: "tan", kind: "builtin", signature: "tan(x)", summary: "Tangent (radians)." },
  { name: "floor", kind: "builtin", signature: "floor(x)", summary: "Round down to an integer." },
  { name: "ceil", kind: "builtin", signature: "ceil(x)", summary: "Round up to an integer." },
  { name: "round", kind: "builtin", signature: "round(x)", summary: "Round to the nearest integer." },
  { name: "sign", kind: "builtin", signature: "sign(x)", summary: "−1, 0, or +1 by the sign of x." },
  { name: "if", kind: "builtin", signature: "if(cond, a, b)", summary: "a when cond is non-zero, otherwise b. Both branches are evaluated." },
  { name: "clamp", kind: "builtin", signature: "clamp(x, lo, hi)", summary: "x held within the range [lo, hi]." },
  { name: "step", kind: "builtin", signature: "step(height, t0)", doc: "inputs", summary: "0 before t0, then height — a sudden change." },
  { name: "pulse", kind: "builtin", signature: "pulse(t0, width)", doc: "inputs", summary: "1 during [t0, t0+width), else 0 — a temporary kick." },
  { name: "ramp", kind: "builtin", signature: "ramp(slope, t0, t1)", doc: "inputs", summary: "A linear ramp of the given slope between two times." },
  { name: "random", kind: "builtin", signature: "random()", doc: "inputs", summary: "A uniform random number in [0, 1), resampled each step. Seed with `sim seed=…` (default 0, so runs are reproducible)." },
  { name: "random_uniform", kind: "builtin", signature: "random_uniform(lo, hi)", doc: "inputs", summary: "A uniform random number in [lo, hi), resampled each step." },
  { name: "random_normal", kind: "builtin", signature: "random_normal(mean, sd)", doc: "inputs", summary: "A normally-distributed random number with the given mean and standard deviation." },
];

// ── stateful builtins (compiled into internal stocks; see compile.ts) ─────────
const STATEFUL_ENTRIES: RefEntry[] = [
  { name: "smooth", kind: "stateful", signature: "smooth(input, τ)", arity: [2, 2], doc: "delays", summary: "First-order exponential smoothing with time constant τ." },
  { name: "smoothi", kind: "stateful", signature: "smoothi(input, τ, init)", arity: [3, 3], doc: "delays", summary: "First-order smoothing starting from init." },
  { name: "smooth3", kind: "stateful", signature: "smooth3(input, τ)", arity: [2, 2], doc: "delays", summary: "Third-order (smoother) exponential smoothing." },
  { name: "delay1", kind: "stateful", signature: "delay1(input, τ)", arity: [2, 2], doc: "delays", summary: "First-order material delay — output lags input by ~τ." },
  { name: "delay3", kind: "stateful", signature: "delay3(input, τ)", arity: [2, 2], doc: "delays", summary: "Third-order material delay (a more realistic pipeline lag)." },
];

/** The full catalog, in a stable, readable order. */
export const REFERENCE: RefEntry[] = [
  ...KEYWORDS,
  ...CONSTS,
  ...BUILTINS.map((b) => (ARITY[b.name] ? { ...b, arity: ARITY[b.name] } : b)),
  ...STATEFUL_ENTRIES,
];

/** Catalog indexed by name for O(1) lookup. */
export const REFERENCE_BY_NAME: Map<string, RefEntry> = new Map(REFERENCE.map((e) => [e.name, e]));

/** Sanity: every callable in the engine has a catalog entry (also gated by reference.test.ts). */
export const CALLABLE_NAMES: string[] = [...Object.keys(ARITY), ...STATEFUL];
