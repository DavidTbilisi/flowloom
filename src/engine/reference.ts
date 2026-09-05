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
  { name: "stock", kind: "keyword", signature: "stock NAME [unit] [>= 0] = EXPR", doc: "stocks", summary: "An accumulator (an integral). EXPR is its initial value; it then changes only through its change() rate. Add `>= 0` for a physical quantity that cannot go negative (an inventory, a workforce) — the integrator holds it at zero instead of letting an outflow drain past empty; without it a stock is signed, which is right for cash or a net position." },
  { name: "change", kind: "keyword", signature: "change(NAME) = EXPR", doc: "stocks", summary: "The net rate of change of a stock — literally dNAME/dt. This line is the engine; flowloom integrates it." },
  { name: "d", kind: "keyword", signature: "d(NAME) = EXPR", doc: "stocks", summary: "Shorthand alias of change(NAME) — the net rate of change of a stock (dNAME/dt)." },
  { name: "flow", kind: "keyword", signature: "flow NAME [unit] = EXPR", doc: "vars", summary: "A named rate. Same maths as aux, but drawn as a flow on the diagram." },
  { name: "aux", kind: "keyword", signature: "aux NAME [unit] = EXPR", doc: "vars", summary: "An instantaneous computed value (a converter/variable) recomputed every step." },
  { name: "param", kind: "keyword", signature: "param NAME [unit] = EXPR [± TOL | ± PCT% | in LO..HI]", doc: "vars", summary: "A constant knob — evaluated once. `const` is an alias. The optional trailing range says how well the knob is known: Monte Carlo samples it once per run (so a deterministic model gets real bands), global sensitivity explores it instead of a made-up ±10% box, and calibrate is not allowed to fit outside it. Write ± or +/- (never +-, which is subtraction)." },
  { name: "const", kind: "keyword", signature: "const NAME [unit] = EXPR", doc: "vars", summary: "A structural constant — a calendar length, a conversion factor — not a knob: no slider, and sensitivity/calibration skip it unless it is named explicitly. Same maths as param." },
  { name: "switch", kind: "keyword", signature: "switch NAME = on|off", doc: "switches", summary: "A two-state policy toggle (a param that is only ever 0 or 1). Use it in if(NAME, a, b). Sensitivity tests it off→on, sliders show a toggle, and overrides/scenarios accept on/off." },
  { name: "link", kind: "keyword", signature: "link A -> B +|-", doc: "links", summary: "A declared signed influence: + (B moves with A) or − (against). The causal-loop sketch you draw before any equation exists — a model of links alone draws and has R/B loops but does not simulate; links also mark dependencies the equations don't carry yet." },
  { name: "scenario", kind: "keyword", signature: "scenario NAME key=value key=value …", doc: "scenarios", summary: "A named set of overrides kept in the text: params, switches (on/off), stock initial values, or dt/to/start/seed/method. Run it with --scenario NAME / the scenario picker; `compare` tabulates base vs every scenario." },
  { name: "expect", kind: "keyword", signature: "expect [SCENARIO] <op>:<series> <|<=|>|>=|== VALUE [± TOL[%]]   |   expect [SCENARIO] always <condition>", doc: "expects", summary: "A claim the model must keep satisfying — its own regression test, kept in the text. Metrics: final/max/min/mean/at:<t>/time-to-peak/settle-time of a series, or loops:active|total|reinforcing|balancing|rank. `always <condition>` instead checks an expression at EVERY recorded step, so it can compare two series (always Inventory <= Capacity), state an implication (always !a || b), and report the step it first broke on with the values there. Run them with `test`; == is exact unless given ± tol (absolute or %)." },
  { name: "data", kind: "keyword", signature: "data NAME [unit] = (t, v) (t, v) … [linear]", doc: "data", summary: "A measured time series read off the clock — an exogenous input. Step-held between samples by default (a sampled series keeps its value); `linear` interpolates. A plain name in expressions and a plotted series; `flowloom data obs.csv` prints these lines from a CSV; calibrate can fit against one (--against Series=dataName); `rmse:<series>:<data>` measures the fit." },
  { name: "table", kind: "keyword", signature: "table NAME = (x,y) (x,y) … [hold] [extrapolate]", doc: "tables", summary: "A graphical lookup function; call it as NAME(x). Piecewise-linear between the points and clamped past the ends by default. `hold` steps instead of interpolating (the value is the last point at or before x); `extrapolate` continues the slope of the end segment past the ends instead of clamping. The two are mutually exclusive." },
  { name: "dim", kind: "keyword", signature: "dim NAME = A, B, C", doc: "subscripts", summary: "A subscript dimension (array index) with named elements. Declare arrays as stock X[NAME], use X[NAME] elementwise, and collapse with sum(X)." },
  { name: "sim", kind: "keyword", signature: "sim dt=.1 to=50 start=0 method=rk4 timeunit=month seed=0 savper=1", doc: "sim", summary: "Simulation settings. method: rk4 (default) | euler | map. For a discrete-period model (monthly, yearly) use method=map — stock(t+dt) = stock(t) + change(t), change() a per-step increment in the stock's own units, no × dt. timeunit names the time unit for units checking; seed fixes random*(); savper is how often to RECORD a sample (the model still integrates at dt), which is what makes a small step affordable on a long horizon. The toolbar edits this line — the text stays canonical." },
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
  { name: "sum", kind: "builtin", signature: "sum(X, axis?, …)", doc: "subscripts", summary: "Total of a subscripted X. sum(X) collapses every dimension to a scalar; sum(X, dim) collapses only that axis and keeps the rest (e.g. row[from] = sum(Trade, to))." },
  { name: "mean", kind: "builtin", signature: "mean(X, axis?, …)", doc: "subscripts", summary: "Average over a subscripted X — sum divided by the element count. Same axis rules as sum(): mean(X) collapses every dimension, mean(X, dim) only that one." },
  { name: "min", kind: "builtin", signature: "min(a, b, …)  |  min(X, axis?, …)", doc: "subscripts", summary: "Smallest of its arguments — or, given a bare subscripted name, the smallest element of that array (same axis rules as sum). min(Pop) reduces; min(Pop[North], 5) is the scalar form." },
  { name: "max", kind: "builtin", signature: "max(a, b, …)  |  max(X, axis?, …)", doc: "subscripts", summary: "Largest of its arguments — or, given a bare subscripted name, the largest element of that array (same axis rules as sum). max(Pop) reduces; max(Pop[North], 5) is the scalar form." },
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
  { name: "random_lognormal", kind: "builtin", signature: "random_lognormal(median, sigma)", doc: "inputs", summary: "A positive, right-skewed draw: exp(ln(median) + sigma·normal). The shape of a delivery time, a project duration, an income — anything bounded below by zero with a long tail." },
  { name: "random_triangular", kind: "builtin", signature: "random_triangular(lo, mode, hi)", doc: "inputs", summary: "The three-point estimate — worst case, most likely, best case — as a distribution. What an expert judgement actually looks like when you have no data." },
  { name: "random_exponential", kind: "builtin", signature: "random_exponential(rate)", doc: "inputs", summary: "A waiting time at a constant hazard rate; mean 1/rate. The gap between Poisson arrivals." },
  { name: "random_poisson", kind: "builtin", signature: "random_poisson(mean)", doc: "inputs", summary: "A non-negative integer count with the given mean — arrivals in a period, failures in a month. Variance equals the mean, which is the point." },
  { name: "random_normal_truncated", kind: "builtin", signature: "random_normal_truncated(mean, sd, lo, hi)", doc: "inputs", summary: "A normal that genuinely lives in [lo, hi]: the inverse CDF is evaluated on the truncated interval, so the shape inside is right. Clamping a normal instead piles probability on the two bounds — a different distribution with the same name." },
];

// ── stateful builtins (compiled into internal stocks; see compile.ts) ─────────
const STATEFUL_ENTRIES: RefEntry[] = [
  { name: "smooth", kind: "stateful", signature: "smooth(input, τ)", arity: [2, 2], doc: "delays", summary: "First-order exponential smoothing with time constant τ." },
  { name: "smoothi", kind: "stateful", signature: "smoothi(input, τ, init)", arity: [3, 3], doc: "delays", summary: "First-order smoothing starting from init." },
  { name: "smooth3", kind: "stateful", signature: "smooth3(input, τ)", arity: [2, 2], doc: "delays", summary: "Third-order (smoother) exponential smoothing." },
  { name: "delay1", kind: "stateful", signature: "delay1(input, τ)", arity: [2, 2], doc: "delays", summary: "First-order material delay — output lags input by ~τ." },
  { name: "delay3", kind: "stateful", signature: "delay3(input, τ)", arity: [2, 2], doc: "delays", summary: "Third-order material delay (a more realistic pipeline lag)." },
  { name: "previous", kind: "stateful", signature: "previous(X, init?)", arity: [1, 2], doc: "discrete", summary: "X exactly one step ago (sample-and-hold on the time grid). Before the first step it is init, or X's initial value. Breaks an instantaneous dependency: a = previous(b), b = a + 1 is legal." },
  { name: "delay_fixed", kind: "stateful", signature: "delay_fixed(X, length, init?)", arity: [2, 3], doc: "discrete", summary: "X exactly `length` time units ago — a pipeline delay, not an exponential lag (compare delay1/delay3). length is read once at t=start and rounded to whole steps (min 1). Before enough history exists it is init, or X's initial value." },
  { name: "initial", kind: "stateful", signature: "initial(x)", doc: "delays", summary: "The value of x at t = start, held for the whole run — Vensim's INITIAL. Compiles to a stock with a zero rate, so it is computed once and never moves. Use it for \"relative to where it began\" (Pop / initial(Pop)) without duplicating the starting expression as a param." },
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
