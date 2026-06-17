// Regenerate docs/llms.txt — a one-page, prompt-ready .flow authoring guide for
// LLMs — from the canonical sources (the REFERENCE catalog + a bundled example)
// so it never drifts from the language. Run with: npm run gen:llms
import { writeFileSync } from "node:fs";
import process from "node:process";
import { REFERENCE } from "../src/engine/reference.js";
import { EXAMPLES } from "../src/examples/index.js";

const group = (kind: string, title: string): string => {
  const rows = REFERENCE.filter((e) => e.kind === kind);
  const w = Math.max(...rows.map((e) => e.signature.length));
  return `### ${title}\n` + rows.map((e) => `  ${e.signature.padEnd(w)}  ${e.summary}`).join("\n");
};

const example = EXAMPLES.find((e) => e.name === "Logistic growth") ?? EXAMPLES[0];

/** Build the llms.txt content from the canonical sources (no side effects). */
export function buildLlmsDoc(): string {
  return `# flowloom — .flow authoring guide for LLMs

flowloom is a text-first systems-thinking studio (Vensim-style stocks, flows, and
feedback loops). The plain-text .flow model is CANONICAL: the diagram, plots, and
animation are all derived from it. Read and edit a model entirely as text.

## Grammar — one statement per line

  stock NAME [unit] = EXPR              an accumulator; EXPR is its INITIAL value
  d(NAME) = EXPR                        the net rate dNAME/dt — what gets integrated
  flow  NAME [unit] = EXPR              a named rate (same maths as aux, drawn as a flow)
  aux   NAME [unit] = EXPR              an instantaneous computed value, recomputed each step
  param NAME [unit] = EXPR              a constant knob, evaluated once (alias: const)
  table NAME = (x,y) (x,y) ...          piecewise-linear lookup; call it as NAME(x)
  sim dt=0.1 to=50 start=0 method=rk4   integration settings (method: euler | rk4)
  plot A B C                            which series are visible by default
  # text after a hash is a comment; a trailing # on a decl is its doc string

Operators: + - * / % ^ (power, right-assoc), unary -, and parentheses. There are
no boolean/comparison operators — branch with if(cond, a, b), where any non-zero
value is "true". A stock changes ONLY through its d() rate; everything else is
recomputed every step.

## Builtin functions and reserved names

${group("keyword", "Line keywords")}

${group("const", "Reserved constants / clock")}

${group("builtin", "Builtins (stateless)")}

${group("stateful", "Stateful builtins — compile into hidden internal stocks")}

## Gotchas an author must know

- No eval. Expressions are an inspectable AST, never executed as code — safe to
  read/share/transform. Keep expressions to the grammar above.
- if(cond, a, b) evaluates BOTH branches (it is a pure function, not control flow).
  Don't rely on a branch being skipped to avoid e.g. division by zero — guard the
  operand instead (e.g. x / max(y, 1e-9)).
- Stateful builtins (smooth, smoothi, smooth3, delay1, delay3) carry state across
  time. They are rewritten into hidden internal stocks at compile time, so they
  integrate correctly under RK4 and appear as nodes in the loop graph.
- Feedback-loop polarity — R (reinforcing) / B (balancing) — is read at t = start
  by numerical perturbation. Nonlinear models can flip polarity as they evolve.
- Every referenced name must be defined, and a model needs at least one stock.
  Algebraic loops among aux/flow/param (a cycle with no stock to break it) are an
  error; put a stock or a delay in the loop.
- Overrides (CLI --set, MCP set) are constant-folded AST edits applied before the
  run — they rebind a param, a stock's initial value, or a sim setting.

## A complete example

${example!.source.replace(/\s*$/, "")}

## Running headlessly

  flowloom run model.flow [--json|--csv|--chart]   simulate; --json for all series
  flowloom summary model.flow [--json]             classify each series (s-shaped/decay/oscillation, settling) — no raw arrays
  flowloom explain model.flow                      plain-language summary
  flowloom describe model.flow --json              structure (stocks/rates/vars/loops) as JSON
  flowloom loops model.flow --json                 feedback loops with R/B polarity
  flowloom check model.flow                        validate; non-zero exit on error
  flowloom reference --json                         this catalog as JSON

Prefer \`summary\` over \`run\` when you only need to know *what the model did*
(did it grow, settle, oscillate, overshoot?) — it returns a few labelled numbers
per series instead of the full time series.

MCP: the \`flowloom-mcp\` server exposes the same engine as tools — flow_run,
flow_summary, flow_check, flow_loops, flow_describe, flow_explain, flow_examples
— plus a flow://reference resource carrying this guide. Each tool takes the model
as text.
`;
}

// Run as a script (not when imported by the freshness test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const doc = buildLlmsDoc();
  writeFileSync("docs/llms.txt", doc);
  console.log(`wrote docs/llms.txt (${doc.length} bytes)`);
}
