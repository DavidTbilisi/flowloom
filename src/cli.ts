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
//
// `--set k=v` overrides a param, a stock's initial value, or a sim setting
// (dt/to/start/method) before the run — which turns a model into a function you
// can sweep from a shell loop. Pass `-` as the path to read the model on stdin.

import { readFileSync } from "node:fs";
import process from "node:process";
import { parseModel, ModelError, type Model } from "./lang/index.js";
import {
  simulateAsync,
  analyzeLoops,
  applyOverride,
  describeModel,
  explainModel,
  summarizeRun,
  sweepParam,
  sensitivity,
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
  type SolveResult,
  type SolveOptions,
  type EnsembleResult,
  type CalibrateResult,
  type LoopReport,
} from "./engine/index.js";

const VERSION = "0.1.0";

// ── tiny arg model ───────────────────────────────────────────────────────────
interface Args {
  cmd: string;
  file?: string;
  format: "table" | "csv" | "tsv" | "json";
  plot: string[]; // explicit column selection; empty = use model defaults
  sets: string[]; // raw "key=value" overrides, applied in order
  rows: number; // sampled rows for the table view
  chart: boolean; // render sparklines after the table
  params: string[]; // --param: a knob (sweep/solve) or a list (sensitivity)
  range?: string; // --range FROM..TO[/STEPS] for sweep
  metric?: string; // --metric SPEC (e.g. final:Stock) for sweep/sensitivity/solve
  frac: number; // --frac: ± fraction for sensitivity
  target?: number; // --target N for solve
  bracket?: string; // --bracket A..B for solve
  tol?: number; // --tol T for solve
  runs?: number; // --runs N for montecarlo
  seed?: number; // --seed N base seed for montecarlo
  data?: string; // --data FILE.csv for calibrate
  against: string[]; // --against Series=column mappings for calibrate
}

function parseArgs(argv: string[]): Args {
  const a: Args = { cmd: "", format: "table", plot: [], sets: [], rows: 21, chart: false, params: [], frac: 0.1, against: [] };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--csv": a.format = "csv"; break;
      case "--tsv": a.format = "tsv"; break;
      case "--json": a.format = "json"; break;
      case "--chart": a.chart = true; break;
      case "--plot": a.plot.push(...splitList(need(argv, ++i, arg))); break;
      case "-s":
      case "--set": a.sets.push(need(argv, ++i, arg)); break;
      case "--rows": a.rows = Math.max(2, Math.floor(Number(need(argv, ++i, arg)))); break;
      case "--param": a.params.push(...splitList(need(argv, ++i, arg))); break;
      case "--range": a.range = need(argv, ++i, arg); break;
      case "--metric": a.metric = need(argv, ++i, arg); break;
      case "--frac": a.frac = Number(need(argv, ++i, arg)); break;
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
        else if (arg.startsWith("--rows=")) a.rows = Math.max(2, Math.floor(Number(arg.slice(7))));
        else if (arg.startsWith("--param=")) a.params.push(...splitList(arg.slice(8)));
        else if (arg.startsWith("--range=")) a.range = arg.slice(8);
        else if (arg.startsWith("--metric=")) a.metric = arg.slice(9);
        else if (arg.startsWith("--frac=")) a.frac = Number(arg.slice(7));
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
function columns(args: Args, res: SimResult): string[] {
  const want = args.plot.length ? args.plot : [];
  if (want.length) {
    for (const c of want) if (!res.series.has(c)) die(`no series named "${c}" (have: ${res.names.join(", ")})`);
    return want;
  }
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
  const cols = columns(args, res);
  if (args.format === "csv") out(renderDelimited(res, cols, ","));
  else if (args.format === "tsv") out(renderDelimited(res, cols, "\t"));
  else if (args.format === "json") out(renderJson(res, cols));
  else {
    out(renderTable(res, cols, args.rows));
    if (args.chart) out("\n" + renderChart(res, cols));
  }
}

function cmdLoops(args: Args): void {
  const model = load(args);
  const rep: LoopReport = analyzeLoops(model);
  if (args.format === "json") {
    out(JSON.stringify({ counts: rep.counts, capped: rep.capped, loops: rep.loops.map((l) => ({ polarity: l.polarity, nodes: l.nodes })) }, null, 2));
    return;
  }
  const { R, B } = rep.counts;
  out(`${rep.loops.length} feedback loop${rep.loops.length === 1 ? "" : "s"}  (${R} reinforcing, ${B} balancing${rep.counts["?"] ? `, ${rep.counts["?"]} ambiguous` : ""})${rep.capped ? "  [capped]" : ""}`);
  rep.loops.forEach((l, i) => out(`  ${String(i + 1).padStart(2)}. [${l.polarity}] ${l.nodes.join(" → ")}`));
  if (!rep.loops.length) out("  (no closed loops — this model is purely feed-forward)");
}

function cmdCheck(args: Args): void {
  const model = load(args); // exits non-zero on parse error
  const loops = analyzeLoops(model).loops.length;
  out(`ok: ${model.stocks.length} stock${plural(model.stocks.length)}, ${model.vars.length} variable${plural(model.vars.length)}, ${loops} loop${plural(loops)}`);
  for (const d of lintModel(model)) warn(`line ${d.loc.line}: ${d.message}`);
}

function cmdLint(args: Args): void {
  const model = load(args);
  const warnings = lintModel(model);
  if (args.format === "json") {
    out(JSON.stringify(warnings.map((d) => ({ line: d.loc.line, col: d.loc.col, severity: d.severity, message: d.message })), null, 2));
    return;
  }
  if (!warnings.length) { out("no lint warnings"); return; }
  for (const d of warnings) out(`line ${String(d.loc.line).padStart(3)}: ${d.message}`);
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
  const cols = columns(args, res);
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
  const head = `sensitivity of ${r.metric} to ±${fmt(r.frac * 100)}% (one factor at a time, by |Δ|)`;
  if (!r.rows.length) return `${head}\n  (no numeric params to vary)`;
  const wp = Math.max(...r.rows.map((x) => x.param.length));
  const maxAbs = Math.max(...r.rows.map((x) => Math.abs(x.delta))) || 1;
  const lines = r.rows.map((x) => {
    const bar = "█".repeat(Math.round((Math.abs(x.delta) / maxAbs) * 24)) || "·";
    return `  ${x.param.padEnd(wp)}  ${fmt(x.low)} → ${fmt(x.high)}   Δ=${fmt(x.delta).padStart(10)}  ${bar}`;
  });
  return [head, ...lines].join("\n");
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

async function cmdSensitivity(args: Args): Promise<void> {
  const model = load(args);
  if (!args.metric) die("sensitivity needs --metric SPEC (e.g. max:Infected)");
  let r: SensitivityResult;
  try {
    r = await sensitivity(model, args.params, args.metric, args.frac);
  } catch (e) {
    die((e as Error).message);
  }
  out(args.format === "json" ? JSON.stringify(r, null, 2) : renderSensitivity(r));
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
    ["Stateful builtins (compile into stocks)", "stateful"],
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
  flowloom loops    <model.flow> [--json]    list reinforcing/balancing loops
  flowloom check    <model.flow>             parse + lint; non-zero exit on parse error
  flowloom lint     <model.flow> [--json]    non-fatal warnings (unused params, dead vars, bad τ)
  flowloom describe <model.flow> [--json]    dump model structure (stocks/rates/vars/loops)
  flowloom explain  <model.flow>             plain-language summary of the model
  flowloom summary  <model.flow> [--json]    classify each series' dynamics (no raw arrays)
  flowloom sweep    <model.flow> --param P --range A..B[/N] --metric SPEC [--json]
  flowloom sensitivity <model.flow> --metric SPEC [--param a,b] [--frac F] [--json]
  flowloom solve    <model.flow> --param P --metric SPEC --target N [--bracket A..B] [--json]
  flowloom montecarlo <model.flow> [--runs N] [--seed N] [--plot a,b] [--json]
  flowloom calibrate <model.flow> --param a,b --data obs.csv [--against S=col] [--json]
  flowloom reference [--json]                the .flow language + builtins catalog
  flowloom <model.flow>                       shorthand for: run

run options:
  --csv | --tsv | --json   machine-readable output (all steps, all series)
  --plot a,b,c             choose series (default: model's plot line, else stocks)
  --chart                  ascii sparklines under the table
  --rows N                 sampled rows in the table view (default 21)
  --set k=v                override a param, stock init, or dt/to/start/method
                           repeatable; applied before the run

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
  flowloom solve examples/sir-epidemic.flow --param beta --metric max:I --target 300
  flowloom montecarlo model.flow --runs 200 --seed 1 --plot Revenue
  flowloom calibrate model.flow --param a,b --data observed.csv --against Infected=I
  flowloom run model.flow --set yield=0.03 --set to=240 --csv > out.csv
  cat model.flow | flowloom loops -`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help") { out(HELP); return; }
  if (argv[0] === "-v" || argv[0] === "--version") { out(VERSION); return; }
  const args = parseArgs(argv);
  switch (args.cmd) {
    case "run": await cmdRun(args); break;
    case "loops": cmdLoops(args); break;
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
    case "reference": cmdReference(args); break;
    case "": die("no command — try `flowloom --help`");
    default: die(`unknown command "${args.cmd}" — try `+"`flowloom --help`");
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
