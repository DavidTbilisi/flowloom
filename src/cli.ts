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
import { parseModel, ModelError, type Model, type Expr } from "./lang/index.js";
import { simulateAsync, analyzeLoops, type SimResult, type LoopReport } from "./engine/index.js";

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
}

function parseArgs(argv: string[]): Args {
  const a: Args = { cmd: "", format: "table", plot: [], sets: [], rows: 21, chart: false };
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
      default:
        if (arg.startsWith("--plot=")) a.plot.push(...splitList(arg.slice(7)));
        else if (arg.startsWith("--set=")) a.sets.push(arg.slice(6));
        else if (arg.startsWith("--rows=")) a.rows = Math.max(2, Math.floor(Number(arg.slice(7))));
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

// ── overrides: text is canonical, but a constant-folded AST edit is the safe,
// dependency-preserving way to bind a value without re-tokenising the source. ──
function applyOverride(model: Model, spec: string): void {
  const eq = spec.indexOf("=");
  if (eq < 0) die(`--set expects key=value, got "${spec}"`);
  const key = spec.slice(0, eq).trim();
  const raw = spec.slice(eq + 1).trim();

  if (key === "method") {
    if (raw !== "euler" && raw !== "rk4") die(`--set method must be euler or rk4, got "${raw}"`);
    model.settings.method = raw;
    return;
  }
  if (key === "dt" || key === "to" || key === "start") {
    const v = Number(raw);
    if (!Number.isFinite(v)) die(`--set ${key} must be a number, got "${raw}"`);
    model.settings[key] = v;
    return;
  }

  const v = Number(raw);
  if (!Number.isFinite(v)) die(`--set ${key}: value must be a number, got "${raw}"`);
  const node: Expr = { kind: "num", value: v, loc: { line: 0, col: 0 } };

  // VarDecl objects are shared across vars/varIndex/order, so mutating .expr in
  // place rebinds the name everywhere the compiler will look.
  const decl = model.varIndex.get(key);
  if (decl) {
    if (decl.kind !== "param") warn(`overriding ${decl.kind} "${key}" with a constant`);
    decl.expr = node;
    return;
  }
  const stock = model.stocks.find((s) => s.name === key);
  if (stock) { stock.initExpr = node; return; }
  die(`--set ${key}: no param, stock, or sim setting by that name`);
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
  for (const s of args.sets) applyOverride(model, s);
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
  flowloom run   <model.flow> [options]   simulate and print results
  flowloom loops <model.flow> [--json]    list reinforcing/balancing loops
  flowloom check <model.flow>             parse only; non-zero exit on error
  flowloom <model.flow>                   shorthand for: run

run options:
  --csv | --tsv | --json   machine-readable output (all steps, all series)
  --plot a,b,c             choose series (default: model's plot line, else stocks)
  --chart                  ascii sparklines under the table
  --rows N                 sampled rows in the table view (default 21)
  --set k=v                override a param, stock init, or dt/to/start/method
                           repeatable; applied before the run

examples:
  flowloom run examples/coffee-cooling.flow
  flowloom run examples/cashflow-escaping-the-rat-race.flow --plot freedom --chart
  flowloom run model.flow --set yield=0.03 --set to=240 --csv > sweep.csv
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
    case "": die("no command — try `flowloom --help`");
    default: die(`unknown command "${args.cmd}" — try `+"`flowloom --help`");
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
