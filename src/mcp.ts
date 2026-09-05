#!/usr/bin/env node
// ── flowloom MCP server ─────────────────────────────────────────────────────
// Exposes the headless engine to agents (Claude Code / Claude Desktop) over an
// MCP stdio transport. Like the CLI, it sits entirely on the DOM-free
// `lang`/`engine` barrels (plus the embedded examples) and never touches
// `src/ui`, so it stays in the `tsconfig.cli.json` build graph and produces the
// same numbers as the studio. Every tool takes the model as text — the canonical
// representation — and returns structured results.
//
// Build: `npm run build:cli` emits dist-cli/mcp.js (the `flowloom-mcp` bin).

import { readFileSync } from "node:fs";
import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { VERSION } from "./version.js";
import { parseModel, printModel, ModelError, type Model } from "./lang/index.js";
import {
  simulateAsync,
  analyzeLoops,
  applyOverride,
  applyScenario,
  compareScenarios,
  searchPolicies,
  loopDominance,
  leverageLadder,
  runExpects,
  diffModels,
  describeModel,
  explainModel,
  summarizeRun,
  sweepParam,
  sensitivity,
  globalSensitivity,
  lintModel,
  checkNumerics,
  solveParam,
  monteCarlo,
  parseDataset,
  datasetFromModel,
  calibrate,
  REFERENCE,
  type EnsembleResult,
} from "./engine/index.js";
import { EXAMPLES } from "./examples/index.js";
import { importXmile } from "./interop/xmile.js";

// ── result helpers ───────────────────────────────────────────────────────────
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const text = (v: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
});

const diag = (d: { loc: { line: number; col: number }; message: string; severity: string }) => ({
  line: d.loc.line,
  col: d.loc.col,
  severity: d.severity,
  message: d.message,
});

/** Parse + apply a scenario, then overrides; throws ModelError (parse) or Error (bad override). */
function loadModel(src: string, sets?: string[], scenario?: string): Model {
  const model = parseModel(src);
  applyScenario(model, scenario);
  for (const s of sets ?? []) applyOverride(model, s);
  return model;
}

// ── tool implementations (pure-ish; reused by the smoke test) ────────────────
export const handlers = {
  async flow_check({ model, numerics, tol }: { model: string; numerics?: boolean; tol?: number }): Promise<ToolResult> {
    let m: Model;
    try {
      m = parseModel(model);
    } catch (e) {
      if (e instanceof ModelError) return text({ ok: false, diagnostics: e.diagnostics.map(diag) });
      throw e;
    }
    // Call validation (unknown function / wrong arity) rides in lint as severity
    // "error": those expressions parse but won't run. Promote them to ok:false so
    // `check` is trustworthy on its own — an agent must be able to treat ok:true
    // as "this will run", not have a crashing error buried in the lint array.
    // Doing it explicitly (rather than relying on a later analyzeLoops() throw)
    // also guarantees the agent gets structured {line, message} diagnostics.
    const lint = lintModel(m);
    const errors = lint.filter((d) => d.severity === "error");
    if (errors.length) return text({ ok: false, diagnostics: errors.map(diag) });
    const warnings = m.diagnostics.filter((d) => d.severity === "warning").map(diag);
    const base = { ok: true, stocks: m.stocks.length, vars: m.vars.length, loops: analyzeLoops(m).loops.length, warnings, lint: lint.map(diag) };
    // The numbers are only worth reporting if the run that produced them holds
    // up at a smaller step — but it costs extra simulations, so it is opt-in.
    if (!numerics) return text(base);
    const report = await checkNumerics(m, tol !== undefined ? { tol } : {});
    return text({ ...base, numerics: report });
  },

  flow_lint({ model }: { model: string }): ToolResult {
    return text({ warnings: lintModel(parseModel(model)).map(diag) });
  },

  flow_import({ xmile }: { xmile: string }): ToolResult {
    const r = importXmile(xmile);
    return text(r);
  },

  flow_fmt({ model }: { model: string }): ToolResult {
    const formatted = printModel(parseModel(model), model);
    return text({ formatted, changed: formatted !== model });
  },

  async flow_run({ model, plot, set, scenario, maxPoints }: { model: string; plot?: string[]; set?: string[]; scenario?: string; maxPoints?: number }): Promise<ToolResult> {
    const res = await simulateAsync(loadModel(model, set, scenario));
    const cols = plot?.length ? plot : res.stockNames.length ? [...res.stockNames, ...res.varNames] : res.names;
    // Safe-by-default payload: the model still integrates at full resolution
    // (the numerics are untouched), but a long/fine run can be 100k+ samples —
    // megabytes of JSON that would blow an agent's context. Downsample the
    // *returned* arrays to a cap, keeping first and last, and say so. Small runs
    // (the common case) are returned verbatim.
    const cap = Math.max(2, Math.floor(maxPoints ?? 1000));
    const N = res.t.length;
    const stride = N > cap ? Math.ceil(N / cap) : 1;
    const pick = <T>(a: T[]): T[] => (stride === 1 ? a : a.filter((_, i) => i % stride === 0 || i === N - 1));
    const series: Record<string, number[]> = {};
    for (const c of cols) {
      const arr = res.series.get(c);
      if (!arr) throw new Error(`no series named "${c}" (have: ${res.names.join(", ")})`);
      series[c] = pick(arr);
    }
    const t = pick(res.t);
    return text({
      dt: res.dt,
      method: res.method,
      steps: N,
      note: res.note,
      ...(stride > 1
        ? { sampled: { returned: t.length, of: N, note: `series downsampled to ~${cap} points (full-resolution run; every ${stride}th sample shown). Raise maxPoints for finer detail, or use flow_summary / a metric for exact values.` } }
        : {}),
      t,
      series,
    });
  },

  async flow_summary({ model, plot, set, scenario }: { model: string; plot?: string[]; set?: string[]; scenario?: string }): Promise<ToolResult> {
    const res = await simulateAsync(loadModel(model, set, scenario));
    return text(summarizeRun(res, plot));
  },

  async flow_sweep(
    { model, param, from, to, steps, metric, set, scenario }:
      { model: string; param: string; from: number; to: number; steps?: number; metric: string; set?: string[]; scenario?: string },
  ): Promise<ToolResult> {
    const r = await sweepParam(loadModel(model, set, scenario), param, { from, to, steps: steps ?? 11 }, metric);
    return text(r);
  },

  async flow_sensitivity(
    { model, metric, params, frac, method, samples, set, scenario }:
      { model: string; metric: string; params?: string[]; frac?: number; method?: "ofat" | "morris" | "sobol"; samples?: number; set?: string[]; scenario?: string },
  ): Promise<ToolResult> {
    const m = loadModel(model, set, scenario);
    if (method === "morris" || method === "sobol") {
      return text(await globalSensitivity(m, { method, metric, params, frac: frac ?? 0.1, ...(samples !== undefined ? { samples } : {}) }));
    }
    return text(await sensitivity(m, params ?? [], metric, frac ?? 0.1));
  },

  async flow_solve(
    { model, param, metric, target, bracket, tol, set, scenario }:
      { model: string; param: string; metric: string; target: number; bracket?: [number, number]; tol?: number; set?: string[]; scenario?: string },
  ): Promise<ToolResult> {
    const r = await solveParam(loadModel(model, set, scenario), param, metric, target, {
      ...(bracket ? { bracket } : {}),
      ...(tol !== undefined ? { tol } : {}),
    });
    return text(r);
  },

  async flow_montecarlo(
    { model, runs, seed, series, set, scenario }:
      { model: string; runs?: number; seed?: number; series?: string[]; set?: string[]; scenario?: string },
  ): Promise<ToolResult> {
    const r = await monteCarlo(loadModel(model, set, scenario), {
      runs: runs ?? 100,
      ...(seed !== undefined ? { seed } : {}),
      ...(series?.length ? { series } : {}),
    });
    return text(compactEnsemble(r));
  },

  async flow_calibrate(
    { model, params, data, map, set, scenario }:
      { model: string; params: string[]; data?: string; map?: Record<string, string>; set?: string[]; scenario?: string },
  ): Promise<ToolResult> {
    const m = loadModel(model, set, scenario);
    let dataset;
    if (data) dataset = parseDataset(data);
    else {
      if (!map || !Object.keys(map).length) throw new Error("without `data` text, calibrate fits against the model's own `data` lines — pass map: { modelSeries: dataName }");
      dataset = datasetFromModel(m, Object.values(map));
    }
    const r = await calibrate(m, { params, dataset, ...(map ? { map } : {}) });
    return text(r);
  },

  async flow_loops({ model, metric, all, basis, set, scenario }: { model: string; metric?: string; all?: boolean; basis?: boolean; set?: string[]; scenario?: string }): Promise<ToolResult> {
    const m = loadModel(model, set, scenario);
    const rep = analyzeLoops(m);
    const loops = rep.loops
      .map((l, i) => ({ index: i + 1, polarity: l.polarity, active: l.active, flips: l.flips, nodes: l.nodes,
        ...(l.independent ? { independent: true } : {}),
        ...(l.resolvedAt !== undefined ? { resolvedAt: l.resolvedAt } : {}),
        ...(l.deadLinks ? { deadLinks: l.deadLinks } : {}) }))
      .filter((l) => (basis ? l.independent : true) && (all || l.active));
    const base = { counts: rep.counts, flipping: rep.flipping, inactive: rep.inactive, rank: rep.rank, independent: rep.independent, capped: rep.capped, samples: rep.sampleTimes.length, loops,
      ...(rep.inactive && !all ? { note: `${rep.inactive} loop(s) never engage in this run (a link is flat at every sample) and are omitted; pass all:true to list them with the flat link` } : {}) };
    if (!metric) return text(base);
    const dom = await loopDominance(m, metric, rep);
    return text({ ...base, dominance: { metric: dom.metric, base: dom.base, rows: dom.rows, skipped: dom.skipped } });
  },

  flow_describe({ model, set, scenario }: { model: string; set?: string[]; scenario?: string }): ToolResult {
    return text(describeModel(loadModel(model, set, scenario)));
  },

  flow_explain({ model, set, scenario }: { model: string; set?: string[]; scenario?: string }): ToolResult {
    return text(explainModel(loadModel(model, set, scenario)));
  },

  async flow_compare(
    { model, metrics, scenarios, set }:
      { model: string; metrics: string[]; scenarios?: string[]; set?: string[] },
  ): Promise<ToolResult> {
    const m = loadModel(model, set);
    if (!m.scenarios.size && !scenarios?.length) throw new Error("the model declares no `scenario` lines — add e.g. `scenario safe separate=on`");
    return text(await compareScenarios(m, metrics, scenarios));
  },

  async flow_policies(
    { model, metric, switches, goal, target, cost, set, scenario }:
      { model: string; metric: string; switches?: string[]; goal?: "max" | "min"; target?: number; cost?: Record<string, number>; set?: string[]; scenario?: string },
  ): Promise<ToolResult> {
    const r = await searchPolicies(loadModel(model, set, scenario), {
      metric, switches, ...(goal ? { goal } : {}), ...(target !== undefined ? { target } : {}), ...(cost ? { cost } : {}),
    });
    // Keep the payload small: the full combination table only when it is short.
    const { combos, ...rest } = r;
    return text(combos.length <= 64 ? r : { ...rest, top: combos.slice(0, 10), combosOmitted: combos.length - 10 });
  },

  async flow_leverage({ model, metric, frac, set, scenario }: { model: string; metric: string; frac?: number; set?: string[]; scenario?: string }): Promise<ToolResult> {
    const r = await leverageLadder(loadModel(model, set, scenario), metric, frac ?? 0.1);
    if (!r.rungs.some((g) => g.levers.length)) throw new Error("nothing is tagged — add `# @rung N` (12 = constants … 1 = transcending paradigms) to a param, switch, or scenario's doc comment");
    return text({ ...r, rungs: r.rungs.filter((g) => g.levers.length) });
  },

  async flow_test({ model, scenarios, set }: { model: string; scenarios?: string[]; set?: string[] }): Promise<ToolResult> {
    const m = loadModel(model, set);
    if (!m.expects.length) throw new Error("the model declares no `expect` lines — add e.g. `expect final:Cash > 0` or `expect recovery final:netWorth == 493370 ± 1%`");
    const r = await runExpects(m, scenarios);
    return text({
      passed: r.passed, failed: r.failed, scenarios: r.scenarios,
      results: r.results.map((x) => ({
        line: x.expect.loc.line, scenario: x.scenario, metric: x.expect.metric, op: x.expect.op, value: x.expect.value,
        ...(x.expect.tol ? { tol: x.expect.tol } : {}), actual: x.actual, pass: x.pass,
        ...(x.off !== undefined ? { off: x.off, allowed: x.allowed } : {}), ...(x.error ? { error: x.error } : {}), ...(x.note ? { note: x.note } : {}), ...(x.expect.doc ? { doc: x.expect.doc } : {}),
      })),
    });
  },

  async flow_diff({ model, other, scenarios, tol, loops }: { model: string; other: string; scenarios?: string[]; tol?: number; loops?: boolean }): Promise<ToolResult> {
    const a = loadModel(model), b = loadModel(other);
    return text(await diffModels(a, b, { ...(tol !== undefined ? { tol } : {}), scenarios, loops: loops !== false }));
  },

  flow_examples({ name }: { name?: string }): ToolResult {
    if (!name) return text(EXAMPLES.map((e) => ({ name: e.name, blurb: e.blurb })));
    const ex = EXAMPLES.find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (!ex) throw new Error(`no example named "${name}" (have: ${EXAMPLES.map((e) => e.name).join(", ")})`);
    return text({ name: ex.name, blurb: ex.blurb, source: ex.source });
  },
};

/**
 * Shrink an ensemble to an agent-friendly payload: the final-step distribution
 * per series, plus a downsampled p05/p50/p95 trajectory (≤ 25 points).
 */
function compactEnsemble(r: EnsembleResult) {
  const N = r.t.length;
  const every = Math.max(1, Math.ceil(N / 25));
  const pick = <T>(a: T[]) => a.filter((_, i) => i % every === 0 || i === N - 1);
  const series = r.series.map((name) => {
    const b = r.bands.get(name)!;
    const last = N - 1;
    return {
      name,
      final: { p05: b.p05[last], p25: b.p25[last], p50: b.p50[last], p75: b.p75[last], p95: b.p95[last], mean: b.mean[last] },
      trajectory: { t: pick(r.t), p05: pick(b.p05), p50: pick(b.p50), p95: pick(b.p95) },
    };
  });
  // What varied is part of the answer: flat bands with nothing sampled mean
  // "nothing in this model is uncertain", not "this outcome is certain".
  const sampled = r.sampled.map((p) => ({ param: p.name, lo: p.lo, hi: p.hi }));
  const note = sampled.length
    ? undefined
    : "no param declares a range, so only the RNG seed varied — without random*() every run is identical and these bands are flat. Add a range (e.g. `param rate = 0.03 ± 0.01`) to get a real spread.";
  return {
    runs: r.runs, baseSeed: r.baseSeed, sampled, series,
    ...(note ? { flat: note } : {}),
    ...(r.notes ? { notes: r.notes } : {}),
  };
}

/** Wrap a handler so thrown errors (incl. parse diagnostics) become tool errors. */
function guard<A>(fn: (a: A) => ToolResult | Promise<ToolResult>) {
  return async (a: A): Promise<ToolResult> => {
    try {
      return await fn(a);
    } catch (e) {
      if (e instanceof ModelError) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "parse error", diagnostics: e.diagnostics.map(diag) }, null, 2) }], isError: true };
      }
      return { content: [{ type: "text", text: `error: ${(e as Error).message}` }], isError: true };
    }
  };
}

// ── reference text (the llms.txt guide), read once, with a fallback ──────────
function referenceGuide(): string {
  try {
    return readFileSync(new URL("../docs/llms.txt", import.meta.url), "utf8");
  } catch {
    // dist may not ship docs/; fall back to a catalog dump so the resource works.
    return (
      `# flowloom .flow reference (v${VERSION})\n\n` +
      REFERENCE.map((e) => `${e.signature}\n    ${e.summary}`).join("\n")
    );
  }
}

// ── server-level orientation ─────────────────────────────────────────────────
// Surfaced to the client on the MCP `initialize` handshake — the first thing an
// agent reads about this server. It hands over the authoring loop and the few
// gotchas that aren't guessable, so the agent doesn't have to discover the
// workflow by trial and error across 14 flat tools.
export const INSTRUCTIONS = `flowloom is a text-first systems-thinking studio (Vensim-style stocks, flows, and feedback loops). A model is plain .flow text, and that text is CANONICAL — every tool takes the model as a string and returns structured results.

Don't guess the syntax. Read the resource flow://reference (a one-page grammar + builtins guide) before writing or editing a model.

The authoring loop:
1. flow_check — parse + lint cheaply. Do this after every edit; it returns {line, col, message} diagnostics with a "did you mean" / recovery hint, so fix those before running. Add numerics:true before you quote a number from a model to anyone: the integrator is fixed-step, so a converged-looking run can still be wrong, and this re-runs at half the step to say whether the answer actually holds (it also flags a branch on a stock under rk4, a random draw whose variance scales with dt, and a time constant the grid cannot resolve). Costs a couple of extra runs.
2. flow_run (raw time series) or, better, flow_summary (a classified per-series read: start/final, min/max, a behaviour label like s-shaped/decay/oscillation, settle time) — prefer flow_summary unless you need the raw arrays.
3. flow_explain (plain-language structure) / flow_describe (JSON structure) / flow_loops (R/B feedback loops read along the run; with a metric, ranked by knockout; basis:true for the shortest independent loop set — the rank-many loops every other loop is built from) — to understand an existing model before changing it.

Analysis: flow_sweep (response curve of one knob), flow_sensitivity (rank knobs; a 'switch' is tested off→on), flow_solve (goal-seek a knob to a target), flow_montecarlo (uncertainty bands — samples every 'param … ± tol' / 'in lo..hi' once per run, plus the RNG seed; if no param declares a range the bands on a deterministic model are flat and the result says so), flow_calibrate (fit params to observed data — CSV text, or the model's own 'data' lines), flow_compare (base vs each 'scenario' line, one row per scenario), flow_policies (every on/off combination of the switches: best, cheapest-to-target, Shapley contribution per switch), flow_leverage (the model's levers on Meadows' twelve leverage points, via '# @rung N' tags), flow_test (the model's own 'expect' lines — pass/fail per claim), flow_diff (before vs after an edit: every series under every shared scenario plus the live-loop census — run it after any refactor). Most tools accept "set" overrides ("key=value") and a "scenario" name to try a what-if WITHOUT rewriting the text.

Discrete-period models (monthly, yearly): use 'sim method=map dt=1' (stock(t+dt) = stock(t) + change(t); change() is a per-step increment in the stock's own units, so no x dt bookkeeping), previous(X) for last step's value, delay_fixed(X, n) for a pipeline lag of exactly n periods (delay1/delay3 are exponential lags, not pipelines).

Multi-file models: 'include "part.flow" as ns' composes models from parts, but MCP tools take ONE text — resolve first with the CLI ('flowloom bundle main.flow') and pass the bundled text; the parser's error says the same if an include line slips through.

Gotchas: every referenced name must be defined and a model needs ≥1 stock; a stock changes ONLY through its change()/d() rate; if(cond,a,b) evaluates BOTH branches (guard the operand, e.g. x/max(y,1e-9), not the branch). Start from flow_examples if you want a known-good template.`;

// ── server wiring ────────────────────────────────────────────────────────────
const modelArg = z.string().describe("The .flow model as text (the canonical representation).");
const setArg = z.array(z.string()).optional().describe('Overrides as "key=value": a param, a switch (on/off), a stock init, or dt/to/start/method. Applied before the run (after any scenario).');
const scenarioArg = z.string().optional().describe("Name of a `scenario` line in the model to apply before the run (\"base\" or omitted = the model as written).");
const metricArg = z
  .string()
  .describe('A scalar read from a run: "<op>:<series>" where op is final|max|min|mean|time-to-peak|settle-time, "at:<t>:<series>", or "rmse:<series>:<series>" (fit of a model series to a data series). E.g. "final:Cash", "max:Infected", "at:50:Inventory", "rmse:N:obs".');

export function buildServer(): McpServer {
  const server = new McpServer({ name: "flowloom", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "flow_run",
    {
      title: "Run a model",
      description: "Simulate a .flow model and return the time series (t plus each chosen series).",
      inputSchema: {
        model: modelArg,
        plot: z.array(z.string()).optional().describe("Series to return (default: stocks then aux/flows)."),
        maxPoints: z.number().optional().describe("Cap on returned samples per series (default 1000). The model still integrates at full resolution; long/fine runs are evenly downsampled (first & last kept) so the payload stays small. Raise it for finer detail, or prefer flow_summary."),
        set: setArg,
        scenario: scenarioArg,
      },
    },
    guard(handlers.flow_run),
  );

  server.registerTool(
    "flow_summary",
    {
      title: "Summarize a run",
      description:
        "Run a .flow model and return a compact, classified summary per series (start/final, min/max, a behaviour label like s-shaped/decay/oscillation, settling time) instead of the raw time series.",
      inputSchema: {
        model: modelArg,
        plot: z.array(z.string()).optional().describe("Series to summarize (default: stocks then aux/flows)."),
        set: setArg,
        scenario: scenarioArg,
      },
    },
    guard(handlers.flow_summary),
  );

  server.registerTool(
    "flow_sweep",
    {
      title: "Sweep a knob",
      description:
        "Vary one param (or stock init) across an inclusive range and report a scalar metric per run — a response curve, without raw series. metric: final:|max:|min:|mean:|at:<t>:|time-to-peak:|settle-time: + a series name.",
      inputSchema: {
        model: modelArg,
        param: z.string().describe("The param (or stock init) to vary."),
        from: z.number().describe("Range start (inclusive)."),
        to: z.number().describe("Range end (inclusive)."),
        steps: z.number().optional().describe("Number of samples across [from, to] (default 11)."),
        metric: metricArg,
        set: setArg,
        scenario: scenarioArg,
      },
    },
    guard(handlers.flow_sweep),
  );

  server.registerTool(
    "flow_sensitivity",
    {
      title: "Rank knob sensitivity",
      description:
        "Rank params by how much they move the metric. method=ofat (default): one-factor-at-a-time tornado around the base. method=morris: global elementary-effects screening (mu*/sigma). method=sobol: variance-based first-order (S1) and total-order (ST) indices. All vary each param ±frac of its base.",
      inputSchema: {
        model: modelArg,
        metric: metricArg,
        params: z.array(z.string()).optional().describe("Params to vary (default: all params in the model)."),
        frac: z.number().optional().describe("± fraction of each param's base value (default 0.1)."),
        method: z.enum(["ofat", "morris", "sobol"]).optional().describe("Sensitivity method (default ofat)."),
        samples: z.number().optional().describe("morris: number of trajectories (default 10). sobol: base sample size N (default 128)."),
        set: setArg,
        scenario: scenarioArg,
      },
    },
    guard(handlers.flow_sensitivity),
  );

  server.registerTool(
    "flow_solve",
    {
      title: "Solve for a knob",
      description:
        "Goal-seek: find the param value that makes a metric equal a target, by bisection (auto-brackets outward from the base value). Returns the value, the achieved metric, and whether it converged.",
      inputSchema: {
        model: modelArg,
        param: z.string().describe("The param (or stock init) to solve for."),
        metric: metricArg,
        target: z.number().describe("The value the metric should reach."),
        bracket: z.tuple([z.number(), z.number()]).optional().describe("Search interval [lo, hi]; omit to auto-bracket from the base value."),
        tol: z.number().optional().describe("Convergence tolerance on |metric − target| (default 1e-6·max(1,|target|))."),
        set: setArg,
        scenario: scenarioArg,
      },
    },
    guard(handlers.flow_solve),
  );

  server.registerTool(
    "flow_montecarlo",
    {
      title: "Monte Carlo ensemble",
      description:
        "Run a stochastic model (one using random()/random_uniform/random_normal) under N seeds and return percentile bands (p05/p25/p50/p75/p95 + mean): the final-step distribution per series plus a downsampled p05/p50/p95 trajectory.",
      inputSchema: {
        model: modelArg,
        runs: z.number().optional().describe("Number of runs / seeds (default 100)."),
        seed: z.number().optional().describe("Base seed; run i uses seed+i (default: the model's sim seed, else 0)."),
        series: z.array(z.string()).optional().describe("Series to band (default: the model's plot line, else every output)."),
        set: setArg,
        scenario: scenarioArg,
      },
    },
    guard(handlers.flow_montecarlo),
  );

  server.registerTool(
    "flow_calibrate",
    {
      title: "Calibrate to data",
      description:
        "Fit model params to an observed time series (CSV/TSV text) by minimising normalised RMSE (derivative-free Nelder–Mead). Returns the fitted params, the starting values, and the achieved fit per series.",
      inputSchema: {
        model: modelArg,
        params: z.array(z.string()).describe("Params (or stock inits) to fit."),
        data: z.string().optional().describe("Observed data as CSV/TSV text: a header row, one time column (t/time or the first), then named series columns. Omit to fit against the model's own `data` lines (then `map` names which: { modelSeries: dataName })."),
        map: z.record(z.string(), z.string()).optional().describe('Model series → dataset column, e.g. {"Infected":"I"}. Defaults to columns whose name matches a series.'),
        set: setArg,
        scenario: scenarioArg,
      },
    },
    guard(handlers.flow_calibrate),
  );

  server.registerTool(
    "flow_check",
    {
      title: "Validate a model",
      description:
        "Parse a .flow model; report ok with counts and lint warnings, or structured parse diagnostics ({line, col, message}, with a 'did you mean' hint on a misspelled name). With numerics:true it also validates the *run*: re-simulates at half the step and reports whether the answer moved, suggests a dt when it did, and flags a state-dependent branch under rk4, a random draw whose variance scales with dt, and a time constant the grid cannot resolve. Costs 2+ extra simulations — use it before quoting a number from a model.",
      inputSchema: {
        model: modelArg,
        numerics: z.boolean().optional().describe("Also check that the numbers survive a smaller step (2+ extra runs). Do this before citing a result."),
        tol: z.number().optional().describe("Convergence threshold for the numerics check, as normalised RMSE. Default 1e-3 (0.1% of a series' range)."),
      },
    },
    guard(handlers.flow_check),
  );

  server.registerTool(
    "flow_import",
    {
      title: "Import an XMILE model",
      description:
        "Convert an XMILE document (Stella's .stmx, or .xmile) into .flow text. Returns {model, notes} — `notes` lists what did not survive (arrays flattened, macros skipped, functions with no equivalent), so check it before trusting the result. Run flow_check on the model afterwards.",
      inputSchema: { xmile: z.string().describe("The XMILE document as text.") },
    },
    guard(handlers.flow_import),
  );

  server.registerTool(
    "flow_fmt",
    {
      title: "Format a model",
      description:
        "Reprint a .flow model in canonical form: source order and grouping kept, spelling and spacing normalised (one space around `=`, on/off for a switch, a `data` line back in one piece, trailing comments aligned). Run it on a model you just wrote before flow_diff — otherwise the diff is mostly whitespace.",
      inputSchema: { model: modelArg },
    },
    guard(handlers.flow_fmt),
  );

  server.registerTool(
    "flow_lint",
    { title: "Lint a model", description: "Non-fatal warnings a parse won't raise: unused params, dead (computed-but-unused) vars, stocks with no rate, non-positive smooth/delay time constants.", inputSchema: { model: modelArg } },
    guard(handlers.flow_lint),
  );

  server.registerTool(
    "flow_loops",
    {
      title: "Feedback loops",
      description: "List the model's feedback loops with R/B polarity read along the actual run (a loop gated by an if() gets its polarity once the gate opens; loops that never engage are reported inactive with the flat link named; loops that flip R↔B are flagged). With `metric`, rank the active loops by knockout: cut one link of each, re-run, and report how far the metric moves — the answer to \"which loop is running this system?\".",
      inputSchema: {
        model: modelArg,
        metric: metricArg.optional().describe("Rank loops by knockout on this metric (e.g. min:Cash)."),
        all: z.boolean().optional().describe("Include loops that never engage in this run (default false)."),
        basis: z.boolean().optional().describe("Only the shortest independent loop set: `rank` (= cycle rank) loops, shortest first, that every other loop is a combination of. The bounded, complete read of the feedback structure — use it on a model with hundreds of loops, or whenever enumeration is capped."),
        set: setArg,
        scenario: scenarioArg,
      },
    },
    guard(handlers.flow_loops),
  );

  server.registerTool(
    "flow_describe",
    { title: "Describe structure", description: "Dump the model's structure as JSON: stocks, rates, vars (with deps), tables, settings, and the loop summary.", inputSchema: { model: modelArg, set: setArg, scenario: scenarioArg } },
    guard(handlers.flow_describe),
  );

  server.registerTool(
    "flow_explain",
    { title: "Explain a model", description: "A plain-language summary of what the model is and does (stocks, knobs, flows, loops).", inputSchema: { model: modelArg, set: setArg, scenario: scenarioArg } },
    guard(handlers.flow_explain),
  );

  server.registerTool(
    "flow_compare",
    {
      title: "Compare scenarios",
      description: "Run the base model and each `scenario` line (default: all), reduce every run to the same metrics, and return one row per scenario with deltas vs base. The tabular answer to \"what does this policy change?\".",
      inputSchema: {
        model: modelArg,
        metrics: z.array(metricArg).describe("Metrics to read from every run, e.g. [\"final:Cash\", \"min:Cash\"]."),
        scenarios: z.array(z.string()).optional().describe("Scenario names to include (default: every scenario in the model). Base is always first."),
        set: setArg,
      },
    },
    guard(handlers.flow_compare),
  );

  server.registerTool(
    "flow_policies",
    {
      title: "Policy search over switches",
      description: "Enumerate every on/off combination of the model's switches (≤ 12 ⇒ ≤ 4096 runs), reduce each run to one metric, and report the best combination, the cheapest one reaching a target, and each switch's Shapley contribution (average marginal effect across all combinations) next to its effect alone. The answer to \"which moves are worth it together?\".",
      inputSchema: {
        model: modelArg,
        metric: metricArg,
        switches: z.array(z.string()).optional().describe("Switches to search over (default: every switch that is off as written — the moves still available; switches on as written are facts of the world and stay as written unless named)."),
        goal: z.enum(["max", "min"]).optional().describe("Whether a bigger metric is better (default max)."),
        target: z.number().optional().describe("A level the metric should reach — enables the cheapest-combination answer."),
        cost: z.record(z.string(), z.number()).optional().describe("Cost of turning each switch on (default 1 each)."),
        set: setArg,
        scenario: scenarioArg,
      },
    },
    guard(handlers.flow_policies),
  );

  server.registerTool(
    "flow_leverage",
    {
      title: "Leverage ladder",
      description: "Lay the model's levers out on Donella Meadows' twelve leverage points (12 = constants … 1 = transcending paradigms) using the `# @rung N` tags on params, switches and scenarios, and measure each on a metric (params ±frac with grain awareness, switches off→on, scenarios vs base). Returns the occupied rungs, each rung's best lever, the model's own rung ranking, and the untagged levers.",
      inputSchema: {
        model: modelArg,
        metric: metricArg,
        frac: z.number().optional().describe("± fraction for param bumps (default 0.1)."),
        set: setArg,
        scenario: scenarioArg,
      },
    },
    guard(handlers.flow_leverage),
  );

  server.registerTool(
    "flow_test",
    {
      title: "Run the model's expect lines",
      description: "Check every `expect [scenario] <metric> <op> <value> [± tol]` line in the model — its own regression tests — one run per scenario. Returns pass/fail per claim with the measured value and, for ==, how far off it was. Use after an edit to see whether the numbers the model is known for still hold.",
      inputSchema: {
        model: modelArg,
        scenarios: z.array(z.string()).optional().describe("Only the claims under these scenarios (\"base\" for the model itself). Default: all."),
        set: setArg,
      },
    },
    guard(handlers.flow_test),
  );

  server.registerTool(
    "flow_diff",
    {
      title: "Diff two models",
      description: "Did an edit change what the model computes? Compares two model texts: declarations (stocks/vars/scenarios added or removed, param values and sim settings that differ), every series under base and every scenario both declare (max |Δ| per series on the shared time grid), and the loop census (total/live loops, live loops that appeared or vanished). `identical` is the refactor verdict — numbers and live loops — while structure changes are informational.",
      inputSchema: {
        model: modelArg.describe("The model before the edit (the canonical text)."),
        other: z.string().describe("The model after the edit."),
        scenarios: z.array(z.string()).optional().describe("Scenarios to compare (default: base + every scenario both models declare)."),
        tol: z.number().optional().describe("|a − b| ≤ tol × max(1, |a|, |b|) counts as equal (default 1e-9)."),
        loops: z.boolean().optional().describe("Compare the loop census too (default true)."),
      },
    },
    guard(handlers.flow_diff),
  );

  server.registerTool(
    "flow_examples",
    { title: "Bundled examples", description: "List the built-in example models, or fetch one by name to learn the format.", inputSchema: { name: z.string().optional().describe("Example name; omit to list all.") } },
    guard(handlers.flow_examples),
  );

  server.registerResource(
    "reference",
    "flow://reference",
    { title: ".flow authoring guide", description: "One-page language + builtins guide for writing valid .flow.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: referenceGuide() }] }),
  );

  server.registerResource(
    "reference-json",
    "flow://reference.json",
    { title: ".flow catalog (JSON)", description: "Every keyword, builtin, and constant with signature, summary, and arity.", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(REFERENCE, null, 2) }] }),
  );

  return server;
}

async function main(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}

// Only start the server when run as the entrypoint (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`flowloom-mcp: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
