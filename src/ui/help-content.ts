// ── Contextual help content + resolver ──────────────────────────────────────
// One flat table of short explanations keyed the same way `highlight.ts` keys
// its tokens, plus keys for UI chrome. `resolveHelp` turns a key (+ the live
// store) into a one-line entry for the status bar. Identifier help is built
// *from the parsed model* so it always reflects the real declaration and its
// current value — no hand-maintained per-model strings.
//
// DOM-free apart from a type-only import of Store, so the coverage contract test
// can run it in Node.

import type { Store } from "./store.js";
import { printExpr } from "../lang/index.js";

export interface HelpEntry {
  title: string;
  body: string;
  /** When set, the status bar shows a "Learn more ›" link to the Format tab. */
  doc?: string;
}

// ── static entries ───────────────────────────────────────────────────────────
// Keyed exactly as highlight.ts emits: bare keyword, `fn:NAME`, `const:NAME`,
// and `ui:*` for chrome.
export const HELP: Record<string, HelpEntry> = {
  // line keywords
  stock: { title: "stock NAME = EXPR", body: "An accumulator (an integral). EXPR is its initial value; it then changes only through its d() rate.", doc: "stocks" },
  d: { title: "d(NAME) = EXPR", body: "The net rate of change of a stock — literally dNAME/dt. This line is the engine; flowloom integrates it.", doc: "stocks" },
  flow: { title: "flow NAME = EXPR", body: "A named rate. Same maths as aux, but drawn as a flow on the diagram.", doc: "vars" },
  aux: { title: "aux NAME = EXPR", body: "An instantaneous computed value (a converter/variable) recomputed every step.", doc: "vars" },
  param: { title: "param NAME = EXPR", body: "A constant knob — evaluated once. `const` is an alias.", doc: "vars" },
  const: { title: "const NAME = EXPR", body: "A constant knob (alias of param).", doc: "vars" },
  table: { title: "table NAME = (x,y) …", body: "A graphical lookup function; call it as NAME(x). Piecewise-linear, clamped past the ends.", doc: "tables" },
  sim: { title: "sim dt=.1 to=50 method=rk4", body: "Simulation settings. The toolbar edits this line — the text stays canonical.", doc: "sim" },
  plot: { title: "plot A B C", body: "Which series start visible on the plot and legend.", doc: "sim" },

  // constants / clock
  "const:t": { title: "t", body: "The current simulation time. `time` is an alias. Use it to drive test inputs." },
  "const:time": { title: "time", body: "The current simulation time (alias of t)." },
  "const:dt": { title: "dt", body: "The integration step size, set on the sim line." },
  "const:PI": { title: "PI", body: "The constant π ≈ 3.14159." },
  "const:E": { title: "E", body: "Euler's number e ≈ 2.71828." },

  // math builtins
  "fn:min": { title: "min(a, b, …)", body: "Smallest of its arguments." },
  "fn:max": { title: "max(a, b, …)", body: "Largest of its arguments." },
  "fn:abs": { title: "abs(x)", body: "Absolute value." },
  "fn:exp": { title: "exp(x)", body: "e raised to the power x." },
  "fn:ln": { title: "ln(x)", body: "Natural logarithm." },
  "fn:log": { title: "log(x)", body: "Natural logarithm (same as ln)." },
  "fn:log10": { title: "log10(x)", body: "Base-10 logarithm." },
  "fn:sqrt": { title: "sqrt(x)", body: "Square root." },
  "fn:pow": { title: "pow(x, y)", body: "x raised to the power y (same as x ^ y)." },
  "fn:sin": { title: "sin(x)", body: "Sine (radians)." },
  "fn:cos": { title: "cos(x)", body: "Cosine (radians)." },
  "fn:tan": { title: "tan(x)", body: "Tangent (radians)." },
  "fn:floor": { title: "floor(x)", body: "Round down to an integer." },
  "fn:ceil": { title: "ceil(x)", body: "Round up to an integer." },
  "fn:round": { title: "round(x)", body: "Round to the nearest integer." },
  "fn:sign": { title: "sign(x)", body: "−1, 0, or +1 by the sign of x." },
  "fn:if": { title: "if(cond, a, b)", body: "a when cond is non-zero, otherwise b." },
  "fn:clamp": { title: "clamp(x, lo, hi)", body: "x held within the range [lo, hi]." },

  // test inputs
  "fn:step": { title: "step(height, t0)", body: "0 before t0, then height — a sudden change.", doc: "inputs" },
  "fn:pulse": { title: "pulse(t0, width)", body: "1 during [t0, t0+width), else 0 — a temporary kick.", doc: "inputs" },
  "fn:ramp": { title: "ramp(slope, t0, t1)", body: "A linear ramp of the given slope between two times.", doc: "inputs" },

  // delays & smoothing
  "fn:smooth": { title: "smooth(input, τ)", body: "First-order exponential smoothing with time constant τ.", doc: "delays" },
  "fn:smoothi": { title: "smoothi(input, τ, init)", body: "First-order smoothing starting from init.", doc: "delays" },
  "fn:smooth3": { title: "smooth3(input, τ)", body: "Third-order (smoother) exponential smoothing.", doc: "delays" },
  "fn:delay1": { title: "delay1(input, τ)", body: "First-order material delay — output lags input by ~τ.", doc: "delays" },
  "fn:delay3": { title: "delay3(input, τ)", body: "Third-order material delay (a more realistic pipeline lag).", doc: "delays" },

  // ── UI chrome ──
  "ui:run": { title: "Run", body: "Parse, simulate, and redraw. Shortcut: ⌘/Ctrl + Enter." },
  "ui:dt": { title: "dt — step size", body: "Integration time step. Smaller is more accurate but slower. Edits the sim line." },
  "ui:to": { title: "to — end time", body: "How far to simulate. Edits the sim line." },
  "ui:method": { title: "method — integrator", body: "RK4 is accurate; Euler is simple and fast. Edits the sim line." },
  "ui:copy": { title: "Copy", body: "Copy the model text to share with a person or an AI." },
  "ui:share": { title: "Share", body: "Copy a link that encodes the whole model in the URL — open it to get the exact model back." },
  "ui:download": { title: "Download", body: "Save the model as a .flow file." },
  "ui:open": { title: "Open", body: "Load a .flow file (or drag one onto the editor)." },
  "ui:example": { title: "Examples", body: "Load a built-in model to learn from. Try a guided walkthrough via Learn." },
  "ui:learn": { title: "Learn", body: "Take the tour, follow an interactive lesson, or walk through an example." },
  "ui:tab-plot": { title: "Plot", body: "Series over time, with a playback cursor." },
  "ui:tab-diagram": { title: "Diagram", body: "The causal graph derived from the equations. Press play to animate." },
  "ui:tab-loops": { title: "Loops", body: "Every feedback loop, labelled R (reinforcing) or B (balancing)." },
  "ui:tab-table": { title: "Table", body: "Series sampled across the run; the highlighted row tracks the cursor." },
  "ui:tab-help": { title: "Format", body: "The .flow language reference — the contract an AI reads and writes." },
  "ui:badge-R": { title: "R — reinforcing loop", body: "A loop that compounds change: more leads to more (or less to less). Drives growth or collapse." },
  "ui:badge-B": { title: "B — balancing loop", body: "A goal-seeking loop that resists change and settles toward an equilibrium." },
  "ui:badge-Q": { title: "? — indeterminate", body: "Polarity couldn't be signed at the initial state (a link had ambiguous sign)." },
  "ui:loop": { title: "Feedback loop", body: "A closed chain of cause → effect. Hover it to trace it on the diagram." },
  "ui:legend": { title: "Legend", body: "Click a series to show or hide it. The number is its value at the cursor." },
  "ui:transport": { title: "Playback", body: "Play, pause, or scrub the simulation clock. All views share it." },
  "ui:statusbar": { title: "Help bar", body: "This bar. Hover anything — a keyword, a node, a control — for an explanation." },
  "ui:node-stock": { title: "Stock", body: "A box is a stock; it fills to its current level during playback." },
  "ui:node-flow": { title: "Flow", body: "A pill is a flow or aux that feeds a stock's rate." },
  "ui:node-aux": { title: "Auxiliary", body: "A pill is a computed variable in the causal graph." },
  "ui:node-internal": { title: "Delay stage", body: "An internal stock created to integrate a delay/smooth correctly." },
};

const fmt = (v: number): string => {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-2 || a >= 1e4)) return v.toExponential(2);
  return String(Math.round(v * 1000) / 1000);
};

const truncate = (s: string, n = 48): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Resolve a help key (+ live store) to a status-bar entry, or null. */
export function resolveHelp(key: string, store?: Store): HelpEntry | null {
  if (key.startsWith("ident:")) return store ? identHelp(key.slice(6), store) : null;
  return HELP[key] ?? null;
}

/** Build a dynamic entry for a user identifier from the parsed model. */
function identHelp(name: string, store: Store): HelpEntry | null {
  const model = store.run.model;
  if (!model) return null;
  const valOf = (): string => {
    const arr = store.run.result?.series.get(name);
    const v = arr?.[store.frame];
    return v != null ? ` · now ≈ ${fmt(v)}` : "";
  };

  const stock = model.stocks.find((s) => s.name === name);
  if (stock) {
    const unit = stock.unit ? ` [${stock.unit}]` : "";
    const doc = stock.doc ? `${stock.doc} · ` : "";
    return { title: `stock ${name}${unit}`, body: `${doc}accumulates its net flow${valOf()}`, doc: "stocks" };
  }

  const v = model.varIndex.get(name);
  if (v) {
    const unit = v.unit ? ` [${v.unit}]` : "";
    const doc = v.doc ? `${v.doc} · ` : "";
    return { title: `${v.kind} ${name}${unit}`, body: `${doc}= ${truncate(printExpr(v.expr))}${valOf()}`, doc: "vars" };
  }

  const tbl = model.tables.get(name);
  if (tbl) {
    return { title: `table ${name}`, body: `graphical lookup, ${tbl.points.length} points; call ${name}(x)`, doc: "tables" };
  }

  return null;
}
