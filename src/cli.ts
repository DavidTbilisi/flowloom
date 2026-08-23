#!/usr/bin/env node
// ── flowloom CLI ────────────────────────────────────────────────────────────
// Runs flowloom models headlessly: parse → compile → simulate → print. The
// whole thing sits on top of the DOM-free `engine`/`lang` barrels — the same
// code the browser uses, the same numbers — so this file does no maths of its
// own. That portability is exactly what CLAUDE.md keeps `src/engine`/`src/lang`
// DOM-free for; this is the "planned CLI" cashing in on it.
//
//   flowloom run    model.flow [--csv|--tsv|--json] [--plot a,b] [--set k=v] [--chart]
//   flowloom loops  model.flow [--json]
//   flowloom check  model.flow
//   flowloom compare model.flow --metric final:Cash,min:Cash
//
// `--set k=v` overrides a param, a stock's initial value, or a sim setting
// (dt/to/start/method) before the run — which turns a model into a function you
// can sweep from a shell loop. `--scenario NAME` applies a `scenario` line from
// the text the same way (then any --set on top). Pass `-` as the path to read
// the model on stdin.

import { readFileSync } from "node:fs";
import process from "node:process";
import { parseModel, scalarize, ModelError, type Model } from "./lang/index.js";
import {
  simulateAsync,
  analyzeLoops,
  applyOverride,
  applyScenario,
  compareScenarios,
  searchPolicies,
  loopDominance,
  leverageLadder,
  describeModel,
  explainModel,
  summarizeRun,
  sweepParam,
  sensitivity,
  globalSensitivity,
  lintModel,
  solveParam,
  monteCarlo,
  parseDataset,
  calibrate,
  REFERENCE,
  type SimResult,
  type RunSummary,
  type SweepResult,
  type SensitivityResult,
  type SensitivityRow,
  type GsaResult,
  type SolveResult,
  type SolveOptions,
  type EnsembleResult,
  type CalibrateResult,
  type LoopReport,
  type CompareResult,
  type PolicyResult,
  type Loop,
  type DominanceResult,
  type LeverageResult,
} from "./engine/index.js";

const VERSION = "0.1.0";

// ── tiny arg model ───────────────────────────────────────────────────────────
interface Args {
  cmd: string;
  file?: string;
  format: "table" | "csv" | "tsv" | "json";
  plot: string[]; // explicit column selection; empty = use model defaults
  sets: string[]; // raw "key=value" overrides, applied in order
  scenario?: string; // --scenario NAME: a `scenario` line to apply before --set
  scenarios: string[]; // --scenario a,b for compare (a list)
  switches: string[]; // --switch a,b for policies
  goal?: "max" | "min"; // --goal for policies
  cost: string[]; // --cost a=2,b=1 for policies
  all: boolean; // --all: loops — list the inactive ones too
  rows: number; // sampled rows for the table view
  chart: boolean; // render sparklines after the table
  params: string[]; // --param: a knob (sweep/solve) or a list (sensitivity)
  range?: string; // --range FROM..TO[/STEPS] for sweep
  metric?: string; // --metric SPEC (e.g. final:Stock) for sweep/sensitivity/solve
  frac: number; // --frac: ± fraction for sensitivity
  method?: string; // --method ofat|morris|sobol for sensitivity
  samples?: number; // --samples for morris (trajectories) / sobol (base N)
  target?: number; // --target N for solve
  bracket?: string; // --bracket A..B for solve
  tol?: number; // --tol T for solve
  runs?: number; // --runs N for montecarlo
  seed?: number; // --seed N base seed for montecarlo
  data?: string; // --data FILE.csv for calibrate
  against: string[]; // --against Series=column mappings for calibrate
}

function parseArgs(argv: string[]): Args {
  const a: Args = { cmd: "", format: "table", plot: [], sets: [], scenarios: [], switches: [], cost: [], all: false, rows: 21, chart: false, params: [], frac: 0.1, against: [] };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--csv": a.format = "csv"; break;
      case "--tsv": a.format = "tsv"; break;
      case "--json": a.format = "json"; break;
      case "--chart": a.chart = true; break;
      case "--all": a.all = true; break;
      case "--plot": a.plot.push(...splitList(need(argv, ++i, arg))); break;
      case "-s":
      case "--set": a.sets.push(need(argv, ++i, arg)); break;
      case "--scenario": a.scenarios.push(...splitList(need(argv, ++i, arg))); break;
      case "--switch": a.switches.push(...splitList(need(argv, ++i, arg))); break;
      case "--goal": { const g = need(argv, ++i, arg); if (g !== "max" && g !== "min") die(`--goal must be max or min, got "${g}"`); a.goal = g; break; }
      case "--cost": a.cost.push(...splitList(need(argv, ++i, arg))); break;
      case "--rows": a.rows = Math.max(2, Math.floor(Number(need(argv, ++i, arg)))); break;
      case "--param": a.params.push(...splitList(need(argv, ++i, arg))); break;
      case "--range": a.range = need(argv, ++i, arg); break;
      case "--metric": a.metric = need(argv, ++i, arg); break;
      case "--frac": a.frac = Number(need(argv, ++i, arg)); break;
      case "--method": a.method = need(argv, ++i, arg); break;
      case "--samples": a.samples = Math.max(2, Math.floor(Number(need(argv, ++i, arg)))); break;
      case "--target": a.target = Number(need(argv, ++i, arg)); break;
      case "--bracket": a.bracket = need(argv, ++i, arg); break;
      case "--tol": a.tol = Number(need(argv, ++i, arg)); break;
      case "--runs": a.runs = Math.max(1, Math.floor(Number(need(argv, ++i, arg)))); break;
      case "--seed": a.seed = Number(need(argv, ++i, arg)); break;
      case "--data": a.data = need(argv, ++i, arg); break;
      case "--against": a.against.push(...splitList(need(argv, ++i, arg))); break;
      default:
        if (arg.startsWith("--plot=")) a.plot.push(...splitList(arg.slice(7)));
        else if (arg.startsWith("--set=")) a.sets.push(arg.slice(6));
        else if (arg.startsWith("--scenario=")) a.scenarios.push(...splitList(arg.slice(11)));
        else if (arg.startsWith("--switch=")) a.switches.push(...splitList(arg.slice(9)));
        else if (arg.startsWith("--goal=")) { const g = arg.slice(7); if (g !== "max" && g !== "min") die(`--goal must be max or min, got "${g}"`); a.goal = g; }
        else if (arg.startsWith("--cost=")) a.cost.push(...splitList(arg.slice(7)));
        else if (arg.startsWith("--rows=")) a.rows = Math.max(2, Math.floor(Number(arg.slice(7))));
        else if (arg.startsWith("--param=")) a.params.push(...splitList(arg.slice(8)));
        else if (arg.startsWith("--range=")) a.range = arg.slice(8);
        else if (arg.startsWith("--metric=")) a.metric = arg.slice(9);
        else if (arg.startsWith("--frac=")) a.frac = Number(arg.slice(7));
        else if (arg.startsWith("--method=")) a.method = arg.slice(9);
        else if (arg.startsWith("--samples=")) a.samples = Math.max(2, Math.floor(Number(arg.slice(10))));
        else if (arg.startsWith("--target=")) a.target = Number(arg.slice(9));
        else if (arg.startsWith("--bracket=")) a.bracket = arg.slice(10);
        else if (arg.startsWith("--tol=")) a.tol = Number(arg.slice(6));
        else if (arg.startsWith("--runs=")) a.runs = Math.max(1, Math.floor(Number(arg.slice(7))));
        else if (arg.startsWith("--seed=")) a.seed = Number(arg.slice(7));
        else if (arg.startsWith("--data=")) a.data = arg.slice(7);
        else if (arg.startsWith("--against=")) a.against.push(...splitList(arg.slice(10)));
        else if (arg !== "-" && arg.startsWith("-")) die(`unknown flag: ${arg}`);
        else rest.push(arg); // positional, including "-" for stdin
    }
  }
  // `flowloom model.flow` and `flowloom -` are shorthand for `run`.
  if (rest.length && (rest[0] === "-" || rest[0]!.endsWith(".flow"))) rest.unshift("run");
  a.cmd = rest[0] ?? "";
  a.file = rest[1];
  // Every command but `compare` takes one scenario; compare takes the list.
  if (a.cmd !== "compare") {
    if (a.scenarios.length > 1) die(`--scenario takes one name here (compare takes a list), got ${a.scenarios.join(", ")}`);
    a.scenario = a.scenarios[0];
  }
  return a;
}

const splitList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
function need(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined) die(`${flag} needs a value`);
  return v!;
}

// ── input ─────────────────────────────────────────────────────────────────────
function load(args: Args): Model {
  if (!args.file) die(`${args.cmd} needs a model file (or - for stdin)`);
  let text: string;
  try {
    text = args.file === "-" ? readFileSync(0, "utf8") : readFileSync(args.file!, "utf8");
  } catch (e) {
    die(`cannot read ${args.file}: ${(e as Error).message}`);
  }
  let model: Model;
  try {
    model = parseModel(text!);
  } catch (e) {
    if (e instanceof ModelError) {
      for (const d of e.diagnostics) process.stderr.write(`error: line ${d.loc.line}: ${d.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  for (const d of model.diagnostics) if (d.severity === "warning") warn(`line ${d.loc.line}: ${d.message}`);
  if (args.scenario) {
    try {
      for (const w of applyScenario(model, args.scenario)) warn(w);
    } catch (e) {
      die(`--scenario ${(e as Error).message}`);
    }
  }
  for (const s of args.sets) {
    try {
      for (const w of applyOverride(model, s)) warn(w);
    } catch (e) {
      die(`--set ${(e as Error).message}`);
    }
  }
  return model;
}

/** Which series to show: explicit --plot, else the model's `plot` line, else stocks. */
function columns(args: Args, res: SimResult, model: Model): string[] {
  if (args.plot.length) {
    for (const c of args.plot) if (!res.series.has(c)) die(`no series named "${c}" (have: ${res.names.join(", ")})`);
    return args.plot;
  }
  // Honor the model's `plot` line, expanded to scalar series (a subscripted
  // `plot Trade` becomes Trade.A.X, …). Shown in full — it's an explicit choice.
  const plotted = scalarize(model).plot.filter((n) => res.series.has(n));
  if (plotted.length) return plotted;
  // No plot line: fall back to stocks + a few vars, capped so big models don't flood.
  return res.stockNames.length ? [...res.stockNames, ...res.varNames].slice(0, 8) : res.names;
}

// ── number/format helpers ──────────────────────────────────────────────────────
function fmt(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  if (x === 0) return "0";
  const a = Math.abs(x);
  if (a >= 1e-4 && a < 1e7) return trimZeros(x.toFixed(6));
  return x.toExponential(4);
}
const trimZeros = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);

/** Evenly-spaced sample indices over [0, n) including the first and last. */
function sampleIdx(n: number, k: number): number[] {
  if (n <= k) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < k; i++) out.push(Math.round((i * (n - 1)) / (k - 1)));
  return [...new Set(out)];
}

// ── renderers ────────────────────────────────────────────────────────────────
function renderTable(res: SimResult, cols: string[], rows: number): string {
  const idx = sampleIdx(res.t.length, rows);
  const head = ["t", ...cols];
  const body = idx.map((i) => [fmt(res.t[i]!), ...cols.map((c) => fmt(res.series.get(c)![i]!))]);
  const w = head.map((h, c) => Math.max(h.length, ...body.map((r) => r[c]!.length)));
  const line = (cells: string[]) => cells.map((s, c) => s.padStart(w[c]!)).join("  ");
  const out = [line(head), w.map((n) => "─".repeat(n)).join("  "), ...body.map(line)];
  if (res.t.length > idx.length) out.push(`… ${res.t.length} steps total (sampled ${idx.length}); --rows N for more, --csv for all`);
  if (res.note) out.push(`note: ${res.note}`);
  return out.join("\n");
}

function renderDelimited(res: SimResult, cols: string[], sep: string): string {
  const lines = [["t", ...cols].join(sep)];
  for (let i = 0; i < res.t.length; i++) {
    lines.push([res.t[i]!, ...cols.map((c) => res.series.get(c)![i]!)].map(String).join(sep));
  }
  return lines.join("\n");
}

function renderJson(res: SimResult, cols: string[]): string {
  const series: Record<string, number[]> = {};
  for (const c of cols) series[c] = res.series.get(c)!;
  return JSON.stringify(
    { dt: res.dt, method: res.method, steps: res.t.length, note: res.note, t: res.t, series },
    null,
    2,
  );
}

const BARS = "▁▂▃▄▅▆▇█";
function renderChart(res: SimResult, cols: string[], width = 60): string {
  const idx = sampleIdx(res.t.length, width);
  const label = Math.max(...cols.map((c) => c.length));
  return cols
    .map((c) => {
      const vals = idx.map((i) => res.series.get(c)![i]!);
      const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
      const spark = vals.map((v) => BARS[Math.min(7, Math.floor(((v - lo) / span) * 8))]).join("");
      return `${c.padEnd(label)}  ${spark}  [${fmt(lo)} … ${fmt(hi)}]`;
    })
    .join("\n");
}

/** One compact line per series: name, behaviour, span, and settling/oscillation. */
function renderSummary(sum: RunSummary): string {
  const wName = Math.max(...sum.series.map((s) => s.name.length));
  const wBeh = Math.max(...sum.series.map((s) => s.behavior.length));
  const lines = sum.series.map((s) => {
    const span = `${fmt(s.start)} → ${fmt(s.final)}`;
    const extent = `[${fmt(s.min.value)} … ${fmt(s.max.value)}]`;
    const settle = s.settled ? `  settles t=${fmt(s.settleTime!)}` : "";
    const osc = s.peaks ? `  ${s.peaks} peak${plural(s.peaks)}${s.period !== undefined ? ` ~T=${fmt(s.period)}` : ""}` : "";
    return `${s.name.padEnd(wName)}  ${s.behavior.padEnd(wBeh)}  ${span}  ${extent}${settle}${osc}`;
  });
  const head = `${sum.steps} steps over t=[${fmt(sum.tStart)} … ${fmt(sum.tEnd)}], ${sum.method}`;
  const out = [head, ...lines];
  if (sum.note) out.push(`note: ${sum.note}`);
  return out.join("\n");
}

// ── commands ───────────────────────────────────────────────────────────────────
async function cmdRun(args: Args): Promise<void> {
  const model = load(args);
  const res = await simulateAsync(model);
  const cols = columns(args, res, model);
  if (args.format === "csv") out(renderDelimited(res, cols, ","));
  else if (args.format === "tsv") out(renderDelimited(res, cols, "\t"));
  else if (args.format === "json") out(renderJson(res, cols));
  else {
    out(renderTable(res, cols, args.rows));
    if (args.chart) out("\n" + renderChart(res, cols));
  }
}

/** `[B]`, `[B from t=17]`, `[R~B]` (flips), `[inactive]`. */
function loopTag(l: Loop): string {
  if (!l.active) return "[inactive]";
  const seq = l.trace.filter((p) => p !== "?");
  const path = seq.filter((p, i) => i === 0 || p !== seq[i - 1]).join("~");
  const tag = l.flips ? path : l.polarity;
  return `[${tag}${l.resolvedAt !== undefined ? ` from t=${fmt(l.resolvedAt)}` : ""}]`;
}

function loopJson(rep: LoopReport, all: boolean) {
  return {
    counts: rep.counts, flipping: rep.flipping, inactive: rep.inactive, capped: rep.capped, sampleTimes: rep.sampleTimes,
    loops: rep.loops
      .map((l, i) => ({ index: i + 1, polarity: l.polarity, active: l.active, flips: l.flips, nodes: l.nodes,
        ...(l.resolvedAt !== undefined ? { resolvedAt: l.resolvedAt } : {}),
        ...(l.deadLinks ? { deadLinks: l.deadLinks } : {}),
        ...(all || l.flips ? { trace: l.trace.join("") } : {}) }))
      .filter((l) => all || l.active),
  };
}

async function cmdLoops(args: Args): Promise<void> {
  const model = load(args);
  const rep: LoopReport = analyzeLoops(model);
  let dom: DominanceResult | undefined;
  if (args.metric) {
    try { dom = await loopDominance(model, args.metric, rep); } catch (e) { die((e as Error).message); }
  }
  if (args.format === "json") {
    const dominance = dom ? { metric: dom.metric, base: dom.base, rows: dom.rows, skipped: dom.skipped } : undefined;
    out(JSON.stringify({ ...loopJson(rep, args.all), ...(dominance ? { dominance } : {}) }, null, 2));
    return;
  }
  const { R, B } = rep.counts;
  const n = rep.loops.length;
  out(`${n} feedback loop${n === 1 ? "" : "s"}  (${R} reinforcing, ${B} balancing` +
    `${rep.inactive ? `; ${rep.inactive} never engage in this run` : ""}${rep.flipping ? `; ${rep.flipping} flip polarity along the run` : ""})` +
    `${rep.capped ? "  [capped]" : ""}  — signs read at ${rep.sampleTimes.length} points of the trajectory`);
  rep.loops.forEach((l, i) => {
    if (!l.active && !args.all) return;
    out(`  ${String(i + 1).padStart(2)}. ${loopTag(l)} ${l.nodes.join(" → ")}`);
    if (!l.active && l.deadLinks?.length) out(`      never engages: ${l.deadLinks.map((d) => `${d.from} → ${d.to}`).join(", ")} stay${l.deadLinks.length === 1 ? "s" : ""} flat`);
  });
  if (!n) out("  (no closed loops — this model is purely feed-forward)");
  if (rep.inactive && !args.all) out(`  … ${rep.inactive} inactive loop${rep.inactive === 1 ? "" : "s"} hidden (a link in each is flat at every sample — an untaken if() branch or a gate that never opens); --all lists them`);
  if (dom) {
    out("");
    out(`loop dominance on ${dom.metric} (base ${fmt(dom.base)}): cut one link of each active loop, re-run, rank by |Δ|`);
    if (!dom.rows.length) out("  (no active loop could be cut)");
    const maxAbs = Math.max(...dom.rows.filter((r) => !r.runaway).map((r) => Math.abs(r.delta))) || 1;
    // Loops that share a cut link get the same Δ by construction — one line, all their numbers.
    const groups = new Map<string, typeof dom.rows>();
    for (const r of dom.rows) { const k = `${r.cut.from}|${r.cut.to}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
    for (const rs of groups.values()) {
      const r = rs[0]!;
      const bar = r.runaway ? "∞" : "█".repeat(Math.round((Math.abs(r.delta) / maxAbs) * 20)) || "·";
      const d = r.runaway ? "runaway".padStart(12) : fmt(r.delta).padStart(12);
      const ids = rs.map((x) => x.loop).join("+");
      const pol = [...new Set(rs.map((x) => x.polarity))].join("/");
      out(`  ${ids.padStart(5)}. [${pol}] Δ=${d}  ${bar.padEnd(20)}  cut ${r.cut.from} → ${r.cut.to}${r.shared > rs.length ? ` (also in ${r.shared - rs.length} other active loop${r.shared - rs.length === 1 ? "" : "s"})` : ""}${r.note ? `  [${r.note}]` : ""}`);
    }
    for (const s of dom.skipped) out(`  ${String(s.loop).padStart(2)}. skipped — ${s.reason}`);
  }
}

function cmdCheck(args: Args): void {
  const model = load(args); // exits non-zero on parse error
  const diagnostics = lintModel(model);
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length) {
    for (const d of errors) process.stderr.write(`error: line ${d.loc.line}: ${d.message}\n`);
    process.exit(1);
  }
  const loops = analyzeLoops(model).loops.length;
  out(`ok: ${model.stocks.length} stock${plural(model.stocks.length)}, ${model.vars.length} variable${plural(model.vars.length)}, ${loops} loop${plural(loops)}`);
  for (const d of diagnostics) warn(`line ${d.loc.line}: ${d.message}`);
}

function cmdLint(args: Args): void {
  const model = load(args);
  const diagnostics = lintModel(model);
  if (args.format === "json") {
    out(JSON.stringify(diagnostics.map((d) => ({ line: d.loc.line, col: d.loc.col, severity: d.severity, message: d.message })), null, 2));
    if (diagnostics.some((d) => d.severity === "error")) process.exit(1);
    return;
  }
  if (!diagnostics.length) { out("no lint warnings"); return; }
  for (const d of diagnostics) out(`${d.severity === "error" ? "error" : "warn"} line ${String(d.loc.line).padStart(3)}: ${d.message}`);
  if (diagnostics.some((d) => d.severity === "error")) process.exit(1);
}

function cmdDescribe(args: Args): void {
  const desc = describeModel(load(args));
  if (args.format === "json") { out(JSON.stringify(desc, null, 2)); return; }
  for (const s of desc.stocks) out(`stock  ${s.name}${s.unit ? ` [${s.unit}]` : ""} = ${s.init}`);
  for (const r of desc.rates) out(`rate   d(${r.stock}) = ${r.expr}`);
  for (const v of desc.vars) out(`${v.kind.padEnd(6)} ${v.name} = ${v.expr}${v.deps.length ? `   (← ${v.deps.join(", ")})` : ""}`);
  for (const t of desc.tables) out(`table  ${t.name}  ${t.points.length} points`);
  const { R, B } = desc.loops.counts;
  out(`loops  ${desc.loops.items.length} (${R} R, ${B} B${desc.loops.counts["?"] ? `, ${desc.loops.counts["?"]} ?` : ""})`);
}

function cmdExplain(args: Args): void {
  out(explainModel(load(args)));
}

async function cmdSummary(args: Args): Promise<void> {
  const model = load(args);
  const res = await simulateAsync(model);
  const cols = columns(args, res, model);
  const sum = summarizeRun(res, cols);
  out(args.format === "json" ? JSON.stringify(sum, null, 2) : renderSummary(sum));
}

/** Parse `FROM..TO[/STEPS]` (e.g. "0..0.1/20") into a sweep range. */
function parseRange(raw: string): { from: number; to: number; steps: number } {
  const [span, stepsStr] = raw.split("/");
  const ends = span!.split(/\.\./);
  if (ends.length !== 2) die(`--range expects FROM..TO[/STEPS], got "${raw}"`);
  const from = Number(ends[0]), to = Number(ends[1]);
  const steps = stepsStr !== undefined ? Math.floor(Number(stepsStr)) : 11;
  if (![from, to, steps].every(Number.isFinite)) die(`--range has a non-numeric part: "${raw}"`);
  if (steps < 1) die(`--range steps must be ≥ 1, got ${steps}`);
  return { from, to, steps };
}

function renderSweep(r: SweepResult): string {
  const head = `sweep ${r.param} → ${r.metric}${r.base !== undefined ? `   (base ${r.param}=${fmt(r.base)})` : ""}`;
  const wv = Math.max(...r.points.map((p) => fmt(p.value).length));
  const wm = Math.max(...r.points.map((p) => fmt(p.metric).length));
  const ms = r.points.map((p) => p.metric).filter(Number.isFinite);
  const lo = Math.min(...ms), hi = Math.max(...ms), span = hi - lo || 1;
  const lines = r.points.map((p) => {
    const bar = Number.isFinite(p.metric) ? BARS[Math.min(7, Math.floor(((p.metric - lo) / span) * 8))] : "·";
    return `  ${fmt(p.value).padStart(wv)}  ${fmt(p.metric).padStart(wm)}  ${bar}${p.note ? `  (${p.note})` : ""}`;
  });
  return [head, ...lines].join("\n");
}

function renderSensitivity(r: SensitivityResult): string {
  const anySwitch = r.rows.some((x) => x.switch);
  const head = `sensitivity of ${r.metric} to ±${fmt(r.frac * 100)}% (one factor at a time, by |Δ|${anySwitch ? "; switches: off → on" : ""})`;
  if (!r.rows.length) return `${head}\n  (no numeric params to vary)`;
  const label = (x: SensitivityRow) => (x.switch ? `${x.param} (switch)` : x.step !== undefined ? `${x.param} (±${fmt(x.step)})` : x.param);
  const wp = Math.max(...r.rows.map((x) => label(x).length));
  const maxAbs = Math.max(...r.rows.map((x) => Math.abs(x.delta))) || 1;
  const lines = r.rows.map((x) => {
    const bar = "█".repeat(Math.round((Math.abs(x.delta) / maxAbs) * 24)) || "·";
    return `  ${label(x).padEnd(wp)}  ${fmt(x.low)} → ${fmt(x.high)}   Δ=${fmt(x.delta).padStart(10)}  ${bar}${x.flat ? "  (flat here — try sweep)" : ""}`;
  });
  return [head, ...lines].join("\n");
}

function renderPolicies(r: PolicyResult): string {
  const on = (c: { on: string[] }) => (c.on.length ? c.on.join(" ") : "(all off)");
  const lines = [
    `policy search over ${r.switches.length} switch${r.switches.length === 1 ? "" : "es"} (${r.runs} runs) — ${r.goal === "max" ? "maximize" : "minimize"} ${r.metric}`,
    `  moves: ${r.switches.join(" ")}`,
    `  base          ${fmt(r.base.value).padStart(14)}   ${r.asWritten.on.length ? "(searched switches off)" : "(as written)"}`,
    ...(r.asWritten.on.length ? [`  as written    ${fmt(r.asWritten.value).padStart(14)}   ${on(r.asWritten)}`] : []),
    `  best          ${fmt(r.best.value).padStart(14)}   ${on(r.best)}   (cost ${fmt(r.best.cost)})${r.best.note ? `  [${r.best.note}]` : ""}`,
  ];
  if (r.target !== undefined) {
    lines.push(
      r.cheapest
        ? `  cheapest ${r.goal === "max" ? "≥" : "≤"} ${fmt(r.target)}  ${fmt(r.cheapest.value).padStart(14)}   ${on(r.cheapest)}   (cost ${fmt(r.cheapest.cost)})`
        : `  no combination reaches ${r.goal === "max" ? "≥" : "≤"} ${fmt(r.target)}`,
    );
  }
  lines.push("", "  contribution — Shapley: average marginal effect over every combination · alone: from base · last: given all others on");
  const w = Math.max(...r.shapley.map((s) => s.switch.length));
  const maxAbs = Math.max(...r.shapley.map((s) => Math.abs(s.shapley))) || 1;
  for (const s of r.shapley) {
    const bar = "█".repeat(Math.round((Math.abs(s.shapley) / maxAbs) * 20)) || "·";
    lines.push(`    ${s.switch.padEnd(w)}  ${fmt(s.shapley).padStart(12)}  ${bar.padEnd(20)}  alone ${fmt(s.alone).padStart(12)}   last ${fmt(s.last).padStart(12)}`);
  }
  const top = r.combos.slice(0, 5);
  lines.push("", `  top ${top.length} of ${r.combos.length} combinations:`);
  for (const c of top) lines.push(`    ${fmt(c.value).padStart(14)}   ${on(c)}   (cost ${fmt(c.cost)})`);
  return lines.join("\n");
}

async function cmdPolicies(args: Args): Promise<void> {
  const model = load(args);
  if (!args.metric) die("policies needs --metric SPEC (e.g. min:Cash)");
  const cost: Record<string, number> = {};
  for (const spec of args.cost) {
    const [k, v] = spec.split("=");
    if (!k || v === undefined || !Number.isFinite(Number(v))) die(`--cost expects switch=number, got "${spec}"`);
    cost[k] = Number(v);
  }
  let r: PolicyResult;
  try {
    r = await searchPolicies(model, {
      metric: args.metric,
      switches: args.switches,
      ...(args.goal ? { goal: args.goal } : {}),
      ...(args.target !== undefined ? { target: args.target } : {}),
      ...(Object.keys(cost).length ? { cost } : {}),
    });
  } catch (e) {
    die((e as Error).message);
  }
  out(args.format === "json" ? JSON.stringify(r, null, 2) : renderPolicies(r));
}

function renderCompare(r: CompareResult): string {
  const names = r.rows.map((x) => x.scenario);
  const wn = Math.max(8, ...names.map((n) => n.length));
  const cells = r.rows.map((x) => x.values.map(fmt));
  const ws = r.metrics.map((m, i) => Math.max(m.length, ...cells.map((c) => c[i]!.length)));
  const head = `  ${"scenario".padEnd(wn)}  ${r.metrics.map((m, i) => m.padStart(ws[i]!)).join("  ")}`;
  const lines = r.rows.map((x, k) => {
    const vals = cells[k]!.map((c, i) => c.padStart(ws[i]!)).join("  ");
    const delta = x.delta ? `   Δ ${x.delta.map((d) => (d >= 0 ? "+" : "") + fmt(d)).join("  ")}` : "";
    const sets = x.sets.length ? `   (${x.sets.join(" ")})` : "";
    return `  ${x.scenario.padEnd(wn)}  ${vals}${delta}${sets}${x.note ? `  [${x.note}]` : ""}`;
  });
  return [head, ...lines].join("\n");
}

function renderLeverage(r: LeverageResult): string {
  const lines = [`leverage ladder on ${r.metric} (base ${fmt(r.base)}) — Meadows' twelve, with this model's levers where it tags them (# @rung N)`];
  const maxAbs = Math.max(...r.rungs.filter((g) => g.best).map((g) => Math.abs(g.best!.delta))) || 1;
  for (const g of r.rungs) {
    const head = `  ${String(g.rung).padStart(2)}  ${g.title.padEnd(30)}`;
    if (!g.best) { lines.push(`${head}  —`); continue; }
    g.levers.forEach((l, i) => {
      const bar = "█".repeat(Math.round((Math.abs(l.delta) / maxAbs) * 16)) || "·";
      const tag = l.kind === "param" ? "" : ` (${l.kind})`;
      lines.push(`${i === 0 ? head : " ".repeat(head.length)}  ${(l.delta >= 0 ? "+" : "") + fmt(l.delta)}`.padEnd(head.length + 16) + `  ${bar.padEnd(16)}  ${l.name}${tag}  ${l.detail}`);
    });
  }
  if (r.ranking.length) lines.push("", `  by this model: rung ${r.ranking.join(" > ")}   (Meadows: 1 > 2 > … > 12)`);
  if (r.untagged.length) lines.push(`  untagged: ${r.untagged.map((u) => `${u.name}${u.kind === "param" ? "" : ` (${u.kind})`}`).join(", ")} — add \`# @rung N\` to place them`);
  return lines.join("\n");
}

async function cmdLeverage(args: Args): Promise<void> {
  const model = load(args);
  if (!args.metric) die("leverage needs --metric SPEC (e.g. min:Cash)");
  let r: LeverageResult;
  try { r = await leverageLadder(model, args.metric, args.frac); } catch (e) { die((e as Error).message); }
  if (!r.rungs.some((g) => g.levers.length)) die("nothing is tagged — add `# @rung N` (12 = constants … 1 = transcending paradigms) to a param, switch, or scenario's doc comment");
  out(args.format === "json" ? JSON.stringify(r, null, 2) : renderLeverage(r));
}

async function cmdCompare(args: Args): Promise<void> {
  const model = load(args);
  if (!args.metric) die("compare needs --metric SPEC[,SPEC…] (e.g. final:Cash,min:Cash)");
  if (!model.scenarios.size && !args.scenarios.length) die("the model declares no `scenario` lines — add e.g. `scenario safe separate=on`");
  let r: CompareResult;
  try {
    r = await compareScenarios(model, splitList(args.metric), args.scenarios);
  } catch (e) {
    die((e as Error).message);
  }
  out(args.format === "json" ? JSON.stringify(r, null, 2) : renderCompare(r));
}

function cmdScenarios(args: Args): void {
  const model = load(args);
  const list = [...model.scenarios.values()].map((s) => ({ name: s.name, sets: s.sets.map((x) => `${x.key}=${x.value}`), ...(s.doc ? { doc: s.doc } : {}) }));
  if (args.format === "json") { out(JSON.stringify(list, null, 2)); return; }
  if (!list.length) { out("no scenario lines (base only)"); return; }
  const w = Math.max(...list.map((s) => s.name.length));
  out(list.map((s) => `  ${s.name.padEnd(w)}  ${s.sets.join(" ")}${s.doc ? `   # ${s.doc}` : ""}`).join("\n"));
}

async function cmdSweep(args: Args): Promise<void> {
  const model = load(args);
  if (!args.params.length) die("sweep needs --param NAME");
  if (!args.range) die("sweep needs --range FROM..TO[/STEPS]");
  if (!args.metric) die("sweep needs --metric SPEC (e.g. final:Stock, max:Infected)");
  let r: SweepResult;
  try {
    r = await sweepParam(model, args.params[0]!, parseRange(args.range), args.metric);
  } catch (e) {
    die((e as Error).message);
  }
  out(args.format === "json" ? JSON.stringify(r, null, 2) : renderSweep(r));
}

function renderGsa(r: GsaResult): string {
  const head = `global sensitivity (${r.method}) of ${r.metric} — ${r.runs} runs`;
  if (!r.rows.length) return `${head}\n  (no numeric params to vary)`;
  const wp = Math.max(...r.rows.map((x) => x.param.length));
  const lines = r.rows.map((x) => {
    if (r.method === "morris") {
      const max = Math.max(...r.rows.map((y) => y.muStar ?? 0)) || 1;
      const bar = "█".repeat(Math.round(((x.muStar ?? 0) / max) * 24)) || "·";
      return `  ${x.param.padEnd(wp)}  mu*=${fmt(x.muStar!).padStart(10)}  sigma=${fmt(x.sigma!).padStart(10)}  ${bar}`;
    }
    const bar = "█".repeat(Math.round(Math.max(0, Math.min(1, x.st ?? 0)) * 24)) || "·";
    return `  ${x.param.padEnd(wp)}  S1=${fmt(x.s1!).padStart(8)}  ST=${fmt(x.st!).padStart(8)}  ${bar}`;
  });
  return [head, ...lines].join("\n");
}

async function cmdSensitivity(args: Args): Promise<void> {
  const model = load(args);
  if (!args.metric) die("sensitivity needs --metric SPEC (e.g. max:Infected)");
  const method = args.method ?? "ofat";
  try {
    if (method === "morris" || method === "sobol") {
      const r = await globalSensitivity(model, {
        method, metric: args.metric, params: args.params, frac: args.frac,
        ...(args.samples !== undefined ? { samples: args.samples } : {}),
      });
      out(args.format === "json" ? JSON.stringify(r, null, 2) : renderGsa(r));
      return;
    }
    if (method !== "ofat") die(`unknown --method "${method}" (use ofat | morris | sobol)`);
    const r = await sensitivity(model, args.params, args.metric, args.frac);
    out(args.format === "json" ? JSON.stringify(r, null, 2) : renderSensitivity(r));
  } catch (e) {
    die((e as Error).message);
  }
}

function renderSolve(r: SolveResult): string {
  const head = `solve ${r.param} for ${r.metric} = ${fmt(r.target)}`;
  const hit = `  ${r.param} = ${fmt(r.value)}   (${r.metric} = ${fmt(r.achieved)}, |error| = ${fmt(r.error)})`;
  const status = r.converged
    ? `  converged in ${r.iters} run${plural(r.iters)}`
    : `  did NOT converge in ${r.iters} run${plural(r.iters)}${r.note ? ` — ${r.note}` : ""}`;
  return [head, hit, status].join("\n");
}

async function cmdSolve(args: Args): Promise<void> {
  const model = load(args);
  if (!args.params.length) die("solve needs --param NAME");
  if (!args.metric) die("solve needs --metric SPEC (e.g. settle-time:Inventory)");
  if (args.target === undefined || !Number.isFinite(args.target)) die("solve needs --target N");
  const opts: SolveOptions = {};
  if (args.bracket) {
    const ends = args.bracket.split(/\.\./);
    if (ends.length !== 2) die(`--bracket expects LO..HI, got "${args.bracket}"`);
    const lo = Number(ends[0]), hi = Number(ends[1]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) die(`--bracket has a non-numeric part: "${args.bracket}"`);
    opts.bracket = [lo, hi];
  }
  if (args.tol !== undefined && Number.isFinite(args.tol)) opts.tol = args.tol;
  let r: SolveResult;
  try {
    r = await solveParam(model, args.params[0]!, args.metric, args.target, opts);
  } catch (e) {
    die((e as Error).message);
  }
  out(args.format === "json" ? JSON.stringify(r, null, 2) : renderSolve(r));
}

function renderMonteCarlo(r: EnsembleResult): string {
  const head = `monte carlo — ${r.runs} runs, seeds ${r.baseSeed}…${r.baseSeed + r.runs - 1}`;
  const N = r.t.length;
  const every = Math.max(1, Math.floor(N / 14));
  const idx: number[] = [];
  for (let i = 0; i < N; i += every) idx.push(i);
  if (idx[idx.length - 1] !== N - 1) idx.push(N - 1);

  const blocks = r.series.map((name) => {
    const b = r.bands.get(name)!;
    const cols: Array<[string, number[]]> = [
      ["t", r.t], ["p05", b.p05], ["p25", b.p25], ["p50", b.p50], ["p75", b.p75], ["p95", b.p95], ["mean", b.mean],
    ];
    const widths = cols.map(([h, arr]) => Math.max(h.length, ...idx.map((i) => fmt(arr[i]!).length)));
    const header = cols.map(([h], c) => h.padStart(widths[c]!)).join("  ");
    const rows = idx.map((i) => cols.map(([, arr], c) => fmt(arr[i]!).padStart(widths[c]!)).join("  "));
    return `${name}\n  ${header}\n` + rows.map((row) => `  ${row}`).join("\n");
  });
  const notes = r.notes?.length ? "\n\n" + r.notes.map((n) => `note: ${n}`).join("\n") : "";
  return [head, ...blocks].join("\n\n") + notes;
}

async function cmdMonteCarlo(args: Args): Promise<void> {
  const model = load(args);
  let r: EnsembleResult;
  try {
    r = await monteCarlo(model, {
      runs: args.runs ?? 100,
      ...(args.seed !== undefined && Number.isFinite(args.seed) ? { seed: args.seed } : {}),
      ...(args.plot.length ? { series: args.plot } : {}),
    });
  } catch (e) {
    die((e as Error).message);
  }
  // bands is a Map (idiomatic, like SimResult.series) — flatten for JSON output.
  out(args.format === "json" ? JSON.stringify({ ...r, bands: Object.fromEntries(r.bands) }, null, 2) : renderMonteCarlo(r));
}

function renderCalibrate(r: CalibrateResult): string {
  const head = `calibrate — ${r.converged ? "converged" : "stopped"} after ${r.evals} run${plural(r.evals)} (residual nrmse ${fmt(r.residual)})`;
  const wp = Math.max(...Object.keys(r.params).map((p) => p.length));
  const params = Object.entries(r.params).map(([p, v]) => `  ${p.padEnd(wp)}  ${fmt(r.start[p]!)} → ${fmt(v)}`);
  const fits = Object.entries(r.perSeries).map(([s, e]) => `  ${s}: nrmse ${fmt(e)}`);
  return [head, "fitted params:", ...params, "fit per series:", ...fits].join("\n");
}

async function cmdCalibrate(args: Args): Promise<void> {
  const model = load(args);
  if (!args.params.length) die("calibrate needs --param NAME[,NAME] (the knobs to fit)");
  if (!args.data) die("calibrate needs --data FILE.csv (observed series to fit against)");
  let text: string;
  try {
    text = readFileSync(args.data, "utf8");
  } catch (e) {
    die(`cannot read ${args.data}: ${(e as Error).message}`);
  }
  const map: Record<string, string> = {};
  for (const spec of args.against) {
    const [series, col] = spec.split("=");
    if (!series || !col) die(`--against expects Series=column, got "${spec}"`);
    map[series] = col;
  }
  let r: CalibrateResult;
  try {
    const dataset = parseDataset(text!);
    r = await calibrate(model, { params: args.params, dataset, ...(Object.keys(map).length ? { map } : {}) });
  } catch (e) {
    die((e as Error).message);
  }
  out(args.format === "json" ? JSON.stringify(r, null, 2) : renderCalibrate(r));
}

function cmdReference(args: Args): void {
  if (args.format === "json") { out(JSON.stringify(REFERENCE, null, 2)); return; }
  const groups: Array<[string, typeof REFERENCE[number]["kind"]]> = [
    ["Line keywords", "keyword"],
    ["Reserved constants", "const"],
    ["Builtins", "builtin"],
    ["Stateful builtins (delays, smoothing, previous)", "stateful"],
  ];
  const blocks = groups.map(([title, kind]) => {
    const rows = REFERENCE.filter((e) => e.kind === kind);
    const w = Math.max(...rows.map((e) => e.signature.length));
    return `## ${title}\n` + rows.map((e) => `  ${e.signature.padEnd(w)}  ${e.summary}`).join("\n");
  });
  out(`flowloom .flow language reference (v${VERSION})\n\n` + blocks.join("\n\n"));
}

const plural = (n: number) => (n === 1 ? "" : "s");

// ── output / error plumbing ─────────────────────────────────────────────────────
const out = (s: string) => process.stdout.write(s + "\n");
const warn = (s: string) => process.stderr.write(`warning: ${s}\n`);
function die(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

const HELP = `flowloom ${VERSION} — run text-first systems models from the shell

usage:
  flowloom run      <model.flow> [options]   simulate and print results
  flowloom loops    <model.flow> [--metric SPEC] [--all] [--json]
                                             feedback loops, polarity read along the run; --metric ranks
                                             them by knockout (cut a link, re-run); --all lists inactive ones
  flowloom check    <model.flow>             parse + lint; non-zero exit on parse error
  flowloom lint     <model.flow> [--json]    non-fatal warnings (unused params, dead vars, bad τ)
  flowloom describe <model.flow> [--json]    dump model structure (stocks/rates/vars/loops)
  flowloom explain  <model.flow>             plain-language summary of the model
  flowloom summary  <model.flow> [--json]    classify each series' dynamics (no raw arrays)
  flowloom sweep    <model.flow> --param P --range A..B[/N] --metric SPEC [--json]
  flowloom sensitivity <model.flow> --metric SPEC [--param a,b] [--frac F] [--method ofat|morris|sobol] [--samples N] [--json]
  flowloom solve    <model.flow> --param P --metric SPEC --target N [--bracket A..B] [--json]
  flowloom montecarlo <model.flow> [--runs N] [--seed N] [--plot a,b] [--json]
  flowloom calibrate <model.flow> --param a,b --data obs.csv [--against S=col] [--json]
  flowloom scenarios <model.flow> [--json]   list the model's scenario lines
  flowloom compare  <model.flow> --metric SPEC[,SPEC] [--scenario a,b] [--json]
                                             base vs each scenario, one row per scenario
  flowloom leverage <model.flow> --metric SPEC [--json]
                                             the model's levers on Meadows' ladder (params, switches,
                                             scenarios tagged '# @rung N'), each measured on the metric
  flowloom policies <model.flow> --metric SPEC [--switch a,b] [--goal max|min] [--target N] [--cost a=2,b=1] [--json]
                                             every combination of the switches still off (the available moves):
                                             best, cheapest-to-target, Shapley share per switch
  flowloom reference [--json]                the .flow language + builtins catalog
  flowloom <model.flow>                       shorthand for: run

run options:
  --csv | --tsv | --json   machine-readable output (all steps, all series)
  --plot a,b,c             choose series (default: model's plot line, else stocks)
  --chart                  ascii sparklines under the table
  --rows N                 sampled rows in the table view (default 21)
  --set k=v                override a param, stock init, or dt/to/start/method
                           repeatable; applied before the run
  --scenario NAME          apply a 'scenario' line from the model first (then --set)

sweep / sensitivity options:
  --param P[,Q]            knob to sweep (sweep), or params to vary (sensitivity; default: all)
  --range A..B[/N]         inclusive range with N samples (default 11) for sweep
  --metric SPEC            scalar to read per run: final:|max:|min:|mean:|at:<t>:|
                           time-to-peak:|settle-time: followed by a series name
  --frac F                 ± fraction for sensitivity bumps (default 0.1)
  --target N               value the metric should hit (solve)
  --bracket A..B           search interval for solve (default: auto-bracket from base)
  --tol T                  convergence tolerance on |metric − target| (solve)

examples:
  flowloom run examples/coffee-cooling.flow
  flowloom explain examples/sir-epidemic.flow
  flowloom summary examples/predator-prey.flow
  flowloom sweep examples/logistic-growth.flow --param carrying --range 500..2000/7 --metric final:Population
  flowloom sensitivity examples/sir-epidemic.flow --metric max:I
  flowloom loops budget.flow --metric min:Cash
  flowloom solve examples/sir-epidemic.flow --param beta --metric max:I --target 300
  flowloom montecarlo model.flow --runs 200 --seed 1 --plot Revenue
  flowloom calibrate model.flow --param a,b --data observed.csv --against Infected=I
  flowloom run model.flow --set yield=0.03 --set to=240 --csv > out.csv
  flowloom run budget.flow --scenario recovery --plot Cash
  flowloom compare budget.flow --metric final:Cash,min:Cash
  flowloom policies budget.flow --metric min:Cash --target 0 --cost separate=2
  flowloom leverage budget.flow --metric min:Cash
  cat model.flow | flowloom loops -`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help") { out(HELP); return; }
  if (argv[0] === "-v" || argv[0] === "--version") { out(VERSION); return; }
  const args = parseArgs(argv);
  switch (args.cmd) {
    case "run": await cmdRun(args); break;
    case "loops": await cmdLoops(args); break;
    case "check": cmdCheck(args); break;
    case "lint": cmdLint(args); break;
    case "describe": cmdDescribe(args); break;
    case "explain": cmdExplain(args); break;
    case "summary": await cmdSummary(args); break;
    case "sweep": await cmdSweep(args); break;
    case "sensitivity": await cmdSensitivity(args); break;
    case "solve": await cmdSolve(args); break;
    case "montecarlo": await cmdMonteCarlo(args); break;
    case "calibrate": await cmdCalibrate(args); break;
    case "scenarios": cmdScenarios(args); break;
    case "compare": await cmdCompare(args); break;
    case "policies": await cmdPolicies(args); break;
    case "leverage": await cmdLeverage(args); break;
    case "reference": cmdReference(args); break;
    case "": die("no command — try `flowloom --help`");
    default: die(`unknown command "${args.cmd}" — try `+"`flowloom --help`");
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
