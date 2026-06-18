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
import { REFERENCE } from "../engine/index.js";

export interface HelpEntry {
  title: string;
  body: string;
  /** When set, the status bar shows a "Learn more ›" link to the Format tab. */
  doc?: string;
}

// ── language entries, derived from the shared catalog ────────────────────────
// Keyword/builtin/const help comes straight from src/engine/reference.ts so the
// editor status bar and the agent-facing reference (CLI / MCP / llms.txt) stay
// in lock-step. Keys match how highlight.ts emits them: bare keyword, `fn:NAME`,
// `const:NAME`. The `ui:*` chrome entries below are UI-only and live here.
const LANGUAGE_HELP: Record<string, HelpEntry> = {};
for (const e of REFERENCE) {
  const key = e.kind === "keyword" ? e.name : e.kind === "const" ? `const:${e.name}` : `fn:${e.name}`;
  LANGUAGE_HELP[key] = { title: e.signature, body: e.summary, ...(e.doc ? { doc: e.doc } : {}) };
}

export const HELP: Record<string, HelpEntry> = {
  ...LANGUAGE_HELP,

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
