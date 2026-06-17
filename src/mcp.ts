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
  REFERENCE,
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
      return text({ ok: true, stocks: m.stocks.length, vars: m.vars.length, loops: analyzeLoops(m).loops.length, warnings });
    } catch (e) {
      if (e instanceof ModelError) return text({ ok: false, diagnostics: e.diagnostics.map(diag) });
      throw e;
    }
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

// ── server wiring ────────────────────────────────────────────────────────────
const modelArg = z.string().describe("The .flow model as text (the canonical representation).");
const setArg = z.array(z.string()).optional().describe('Overrides as "key=value": a param, a stock init, or dt/to/start/method. Applied before the run.');

export function buildServer(): McpServer {
  const server = new McpServer({ name: "flowloom", version: VERSION });

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
    "flow_check",
    { title: "Validate a model", description: "Parse a .flow model; report ok with counts, or structured parse diagnostics ({line, col, message}).", inputSchema: { model: modelArg } },
    guard(handlers.flow_check),
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
