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
  globalSensitivity,
  lintModel,
  solveParam,
  monteCarlo,
  parseDataset,
  calibrate,
  REFERENCE,
  type EnsembleResult,
} from "./engine/index.js";
import { EXAMPLES } from "./examples/index.js";

const VERSION = "0.1.0";

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

/** Parse + apply overrides; throws ModelError (parse) or Error (bad override). */
function loadModel(src: string, sets?: string[]): Model {
  const model = parseModel(src);
  for (const s of sets ?? []) applyOverride(model, s);
  return model;
}

// ── tool implementations (pure-ish; reused by the smoke test) ────────────────
export const handlers = {
  flow_check({ model }: { model: string }): ToolResult {
    try {
      const m = parseModel(model);
      const warnings = m.diagnostics.filter((d) => d.severity === "warning").map(diag);
      return text({ ok: true, stocks: m.stocks.length, vars: m.vars.length, loops: analyzeLoops(m).loops.length, warnings, lint: lintModel(m).map(diag) });
    } catch (e) {
      if (e instanceof ModelError) return text({ ok: false, diagnostics: e.diagnostics.map(diag) });
      throw e;
    }
  },

  flow_lint({ model }: { model: string }): ToolResult {
    return text({ warnings: lintModel(parseModel(model)).map(diag) });
  },

  async flow_run({ model, plot, set }: { model: string; plot?: string[]; set?: string[] }): Promise<ToolResult> {
    const res = await simulateAsync(loadModel(model, set));
    const cols = plot?.length ? plot : res.stockNames.length ? [...res.stockNames, ...res.varNames] : res.names;
    const series: Record<string, number[]> = {};
    for (const c of cols) {
      const arr = res.series.get(c);
      if (!arr) throw new Error(`no series named "${c}" (have: ${res.names.join(", ")})`);
      series[c] = arr;
    }
    return text({ dt: res.dt, method: res.method, steps: res.t.length, note: res.note, t: res.t, series });
  },

  async flow_summary({ model, plot, set }: { model: string; plot?: string[]; set?: string[] }): Promise<ToolResult> {
    const res = await simulateAsync(loadModel(model, set));
    return text(summarizeRun(res, plot));
  },

  async flow_sweep(
    { model, param, from, to, steps, metric, set }:
      { model: string; param: string; from: number; to: number; steps?: number; metric: string; set?: string[] },
  ): Promise<ToolResult> {
    const r = await sweepParam(loadModel(model, set), param, { from, to, steps: steps ?? 11 }, metric);
    return text(r);
  },

  async flow_sensitivity(
    { model, metric, params, frac, method, samples, set }:
      { model: string; metric: string; params?: string[]; frac?: number; method?: "ofat" | "morris" | "sobol"; samples?: number; set?: string[] },
  ): Promise<ToolResult> {
    const m = loadModel(model, set);
    if (method === "morris" || method === "sobol") {
      return text(await globalSensitivity(m, { method, metric, params, frac: frac ?? 0.1, ...(samples !== undefined ? { samples } : {}) }));
    }
    return text(await sensitivity(m, params ?? [], metric, frac ?? 0.1));
  },

  async flow_solve(
    { model, param, metric, target, bracket, tol, set }:
      { model: string; param: string; metric: string; target: number; bracket?: [number, number]; tol?: number; set?: string[] },
  ): Promise<ToolResult> {
    const r = await solveParam(loadModel(model, set), param, metric, target, {
      ...(bracket ? { bracket } : {}),
      ...(tol !== undefined ? { tol } : {}),
    });
    return text(r);
  },

  async flow_montecarlo(
    { model, runs, seed, series, set }:
      { model: string; runs?: number; seed?: number; series?: string[]; set?: string[] },
  ): Promise<ToolResult> {
    const r = await monteCarlo(loadModel(model, set), {
      runs: runs ?? 100,
      ...(seed !== undefined ? { seed } : {}),
      ...(series?.length ? { series } : {}),
    });
    return text(compactEnsemble(r));
  },

  async flow_calibrate(
    { model, params, data, map, set }:
      { model: string; params: string[]; data: string; map?: Record<string, string>; set?: string[] },
  ): Promise<ToolResult> {
    const dataset = parseDataset(data);
    const r = await calibrate(loadModel(model, set), { params, dataset, ...(map ? { map } : {}) });
    return text(r);
  },

  flow_loops({ model }: { model: string }): ToolResult {
    const rep = analyzeLoops(loadModel(model));
    return text({ counts: rep.counts, capped: rep.capped, loops: rep.loops.map((l) => ({ polarity: l.polarity, nodes: l.nodes })) });
  },

  flow_describe({ model, set }: { model: string; set?: string[] }): ToolResult {
    return text(describeModel(loadModel(model, set)));
  },

  flow_explain({ model, set }: { model: string; set?: string[] }): ToolResult {
    return text(explainModel(loadModel(model, set)));
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
  return { runs: r.runs, baseSeed: r.baseSeed, series, ...(r.notes ? { notes: r.notes } : {}) };
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
1. flow_check — parse + lint cheaply. Do this after every edit; it returns {line, col, message} diagnostics with a "did you mean" / recovery hint, so fix those before running.
2. flow_run (raw time series) or, better, flow_summary (a classified per-series read: start/final, min/max, a behaviour label like s-shaped/decay/oscillation, settle time) — prefer flow_summary unless you need the raw arrays.
3. flow_explain (plain-language structure) / flow_describe (JSON structure) / flow_loops (R/B feedback loops) — to understand an existing model before changing it.

Analysis: flow_sweep (response curve of one knob), flow_sensitivity (rank knobs), flow_solve (goal-seek a knob to a target), flow_montecarlo (stochastic bands), flow_calibrate (fit params to data). Most tools accept "set" overrides ("key=value") to try a what-if WITHOUT rewriting the text.

Gotchas: every referenced name must be defined and a model needs ≥1 stock; a stock changes ONLY through its change()/d() rate; if(cond,a,b) evaluates BOTH branches (guard the operand, e.g. x/max(y,1e-9), not the branch). Start from flow_examples if you want a known-good template.`;

// ── server wiring ────────────────────────────────────────────────────────────
const modelArg = z.string().describe("The .flow model as text (the canonical representation).");
const setArg = z.array(z.string()).optional().describe('Overrides as "key=value": a param, a stock init, or dt/to/start/method. Applied before the run.');
const metricArg = z
  .string()
  .describe('A scalar read from a run: "<op>:<series>" where op is final|max|min|mean|time-to-peak|settle-time, or "at:<t>:<series>". E.g. "final:Cash", "max:Infected", "at:50:Inventory".');

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
        set: setArg,
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
        data: z.string().describe("Observed data as CSV/TSV text: a header row, one time column (t/time or the first), then named series columns."),
        map: z.record(z.string(), z.string()).optional().describe('Model series → dataset column, e.g. {"Infected":"I"}. Defaults to columns whose name matches a series.'),
        set: setArg,
      },
    },
    guard(handlers.flow_calibrate),
  );

  server.registerTool(
    "flow_check",
    { title: "Validate a model", description: "Parse a .flow model; report ok with counts and lint warnings, or structured parse diagnostics ({line, col, message}, with a 'did you mean' hint on a misspelled name).", inputSchema: { model: modelArg } },
    guard(handlers.flow_check),
  );

  server.registerTool(
    "flow_lint",
    { title: "Lint a model", description: "Non-fatal warnings a parse won't raise: unused params, dead (computed-but-unused) vars, stocks with no rate, non-positive smooth/delay time constants.", inputSchema: { model: modelArg } },
    guard(handlers.flow_lint),
  );

  server.registerTool(
    "flow_loops",
    { title: "Feedback loops", description: "List the model's feedback loops with R/B polarity (read at t=start).", inputSchema: { model: modelArg } },
    guard(handlers.flow_loops),
  );

  server.registerTool(
    "flow_describe",
    { title: "Describe structure", description: "Dump the model's structure as JSON: stocks, rates, vars (with deps), tables, settings, and the loop summary.", inputSchema: { model: modelArg, set: setArg } },
    guard(handlers.flow_describe),
  );

  server.registerTool(
    "flow_explain",
    { title: "Explain a model", description: "A plain-language summary of what the model is and does (stocks, knobs, flows, loops).", inputSchema: { model: modelArg, set: setArg } },
    guard(handlers.flow_explain),
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
