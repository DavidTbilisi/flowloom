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
  change(NAME) = EXPR                   the net rate dNAME/dt — what gets integrated (alias: d(NAME))
  flow  NAME [unit] = EXPR              a named rate (same maths as aux, drawn as a flow)
  aux   NAME [unit] = EXPR              an instantaneous computed value, recomputed each step
  param NAME [unit] = EXPR              a constant knob, evaluated once (alias: const)
  switch NAME = on|off                  a two-state policy toggle (a param that is only 0 or 1); use as if(NAME, a, b)
  table NAME = (x,y) (x,y) ...          piecewise-linear lookup; call it as NAME(x)
  scenario NAME key=value key=value …   a named override set kept in the text: params, switches (on/off), stock inits, dt/to/start/seed/method
  dim NAME = A, B, C                     a subscript dimension (array index) of named elements
  stock NAME[dim] = EXPR                 an array: one stock per element; refer to NAME[dim] / NAME[A]; sum(NAME) collapses it
  sim dt=0.1 to=50 start=0 method=rk4   integration settings (method: euler | rk4); add timeunit=month for units, seed=N for random*()
  plot A B C                            which series are visible by default
  # text after a hash is a comment; a trailing # on a decl is its doc string

Operators, loosest to tightest binding:
  ||  or                     logical OR  (word alias: or)
  &&  and                    logical AND (word alias: and)
  ==  !=  <  <=  >  >=        comparisons — yield 1 (true) or 0 (false)
  +  -                       add / subtract
  *  /  %                    multiply / divide / remainder
  ^                          power (right-associative; ** is an alias)
  -x   !x   (not x)          unary negate / logical NOT (word alias: not)
Comparisons and &&/|| return 1 or 0, and any non-zero value counts as "true" — so
they are what you put in if(cond, a, b): e.g. if(Cash > 0, hireRate, 0) or
if(Stock < reorder && !paused, batch, 0). A stock changes ONLY through its
change() rate; everything else is recomputed every step.

## Builtin functions and reserved names

${group("keyword", "Line keywords")}

${group("const", "Reserved constants / clock")}

${group("builtin", "Builtins (stateless)")}

${group("stateful", "Stateful builtins — carry state across steps")}

## Gotchas an author must know

- No eval. Expressions are an inspectable AST, never executed as code — safe to
  read/share/transform. Keep expressions to the grammar above.
- if(cond, a, b) evaluates BOTH branches (it is a pure function, not control flow).
  Don't rely on a branch being skipped to avoid e.g. division by zero — guard the
  operand instead (e.g. x / max(y, 1e-9)).
- Stateful builtins (smooth, smoothi, smooth3, delay1, delay3) carry state across
  time. They are rewritten into hidden internal stocks at compile time, so they
  integrate correctly under RK4 and appear as nodes in the loop graph.
- previous(X) and delay_fixed(X, n) are *pipeline* delays: the value exactly one
  step / n time units ago, sampled on the time grid and held across RK4 sub-steps.
  Use them for "last month's balance", "the statement from two months ago"; use
  delay1/delay3 for exponential lags. Before enough history exists they return
  their init (default: X's initial value). If X depends on the delay's own output
  and no init is given, the initial state is circular — give an explicit init.
- Discrete-period models (a monthly budget, a yearly census) are maps, not ODEs:
  write \`sim method=euler dt=1\` so stock(t+1) = stock(t) + change(t) exactly.
  Under rk4, tests on the clock (t % 12 == 0, t == 7) also get evaluated at
  t + dt/2 where they are false — lint warns about this.
- Bare numbers are unit-polymorphic in the units check: \`Cash < 0\`, \`max(0, x)\`,
  \`t % 12\` never warn on their own. Annotate flows as [unit/timeunit] and set
  \`sim timeunit=…\` and change(stock) is checked as stock-units per time.
- A switch is a param that is only ever 0 or 1. It is what sensitivity needs to
  test a policy off→on (a ±10% bump of 0 lands on two truthy values and reads as
  Δ=0 — that is why switch exists), what sliders render as a toggle, and what
  overrides/scenarios accept as on/off.
- A scenario is a named set of overrides *in the text*: \`scenario recovery
  raise=on income=9000 Cash=5000\`. Run it with --scenario NAME (CLI/MCP) or the
  studio's Scenario picker; \`compare\` runs base + every scenario and tabulates
  chosen metrics with deltas. "base" is always the model as written.
- Feedback-loop polarity — R (reinforcing) / B (balancing) — is read at t = start
  by numerical perturbation. Nonlinear models can flip polarity as they evolve.
- Every referenced name must be defined, and a model needs at least one stock.
  Algebraic loops among aux/flow/param (a cycle with no stock to break it) are an
  error; put a stock or a delay in the loop.
- Overrides (CLI --set, MCP set) are constant-folded AST edits applied before the
  run — they rebind a param, a switch (on/off), a stock's initial value, or a sim
  setting. A --scenario is applied first, then any --set on top.

## A complete example

${example!.source.replace(/\s*$/, "")}

## Running headlessly

  flowloom run model.flow [--json|--csv|--chart]   simulate; --json for all series
  flowloom summary model.flow [--json]             classify each series (s-shaped/decay/oscillation, settling) — no raw arrays
  flowloom sweep model.flow --param P --range A..B[/N] --metric SPEC   response curve of one knob
  flowloom sensitivity model.flow --metric SPEC    rank params by how much they move the metric
  flowloom solve model.flow --param P --metric SPEC --target N   find the knob value that hits a target
  flowloom explain model.flow                      plain-language summary
  flowloom describe model.flow --json              structure (stocks/rates/vars/loops) as JSON
  flowloom loops model.flow --json                 feedback loops with R/B polarity
  flowloom check model.flow                        parse + lint; non-zero exit on parse error
  flowloom lint model.flow [--json]                non-fatal warnings (unused params, dead vars, units, bad τ)
  flowloom montecarlo model.flow --runs N          percentile bands across N seeded runs
  flowloom calibrate model.flow --param a,b --data obs.csv   fit params to observed data
  flowloom scenarios model.flow                     list the model's scenario lines
  flowloom compare model.flow --metric a,b [--scenario x,y]   base vs each scenario: one row per scenario, with deltas
  flowloom reference --json                         this catalog as JSON
  (any command takes --scenario NAME to run a scenario line, and --set k=v on top)

Prefer \`summary\` over \`run\` when you only need to know *what the model did*
(did it grow, settle, oscillate, overshoot?) — it returns a few labelled numbers
per series instead of the full time series. A metric SPEC reduces a run to one
number — "<op>:<series>" with op = final|max|min|mean|time-to-peak|settle-time,
or "at:<t>:<series>" (e.g. final:Cash, max:Infected, at:50:Inventory). \`sweep\`
turns one knob across a range; \`sensitivity\` bumps every param ±frac and ranks
them (\`--method morris\` or \`sobol\` for global, variance-based ranking instead of
the local one-factor tornado); \`solve\` inverts the model — it finds the knob value that drives the metric
to a --target (bisection, derivative-free). All three read that SPEC and return
compact numbers, never raw series.

For stochastic models, random()/random_uniform(lo,hi)/random_normal(mean,sd) draw
seeded noise (set \`sim seed=N\`, default 0 ⇒ reproducible; resampled once per step).
\`montecarlo\` runs N seeds and reports p05/p25/p50/p75/p95 + mean bands per series.
\`calibrate\` fits params to an observed CSV/TSV series by minimising normalised RMSE
(derivative-free Nelder–Mead). Where you annotate \`[unit]\`s, \`lint\` runs a
dimensional check (unlike-unit adds, dimensioned args to exp/ln/sin, a
change(stock) that isn't stock-units per time).

When a name is misspelled, the parse error carries a "did you mean 'X'?" hint
(case included — birthrate vs birthRate). \`check\`/\`lint\` (and flow_check's
\`lint\` field) also flag unused params, computed-but-unused vars, stocks with no
rate, and non-positive smooth/delay time constants — none of which stop a run.

MCP: the \`flowloom-mcp\` server exposes the same engine as tools — flow_run,
flow_summary, flow_sweep, flow_sensitivity, flow_solve, flow_montecarlo,
flow_calibrate, flow_compare, flow_check, flow_lint, flow_loops, flow_describe,
flow_explain, flow_examples — plus a flow://reference resource carrying this
guide. Each tool takes the model as text, plus optional set/scenario what-ifs.
`;
}

// Write the file only when invoked as the gen script (the npm script sets
// GEN_LLMS=1), never when vitest imports buildLlmsDoc for the freshness check.
// `vite-node` rewrites process.argv to drop the script path, so an env flag is
// the reliable signal here.
if (process.env.GEN_LLMS) {
  const doc = buildLlmsDoc();
  writeFileSync("docs/llms.txt", doc);
  console.log(`wrote docs/llms.txt (${doc.length} bytes)`);
}
