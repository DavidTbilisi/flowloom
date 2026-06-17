# Architecture

flowloom is a static, browser-based systems-thinking studio with a pure-TypeScript
core. There is no backend: the engine runs entirely client-side. The same engine
modules also run in Node (the test suite, and a future CLI), because they have no
DOM dependencies.

```
text (.flow)                      the canonical model — what humans & AIs edit
   │  src/lang  (tokenize → parse → validate)
   ▼
Model (AST)                       inspectable; deps extracted, no eval
   │  src/engine/compile          expand SMOOTH/DELAY into internal stocks
   ▼
Compiled                          plain stocks + ordered vars + tables
   │  src/engine/simulator        Euler / RK4 integration
   ▼
SimResult  ──────────────┐
   │  src/engine/loops    │        signed influence graph → R/B feedback loops
   ▼                      ▼
src/ui  (plot · animated diagram · table · loops · editor)
```

## Layers

### `src/lang` — the language (zero engine/UI knowledge)

- **`tokenizer.ts`** — turns an expression string into tokens. Numbers (incl.
  scientific notation), identifiers, operators, parens, commas.
- **`expr.ts`** — a Pratt (precedence-climbing) parser producing an inspectable
  `Expr` AST, plus `freeVars` (dependency extraction) and `printExpr`
  (canonical pretty-printer used for round-tripping and tests). **No `eval` /
  `new Function`** — this is what makes running AI-authored model text safe.
- **`parser.ts`** — the line grammar. Produces a validated `Model`: declares
  symbols, enforces unique/reserved names, topologically orders variables (and
  reports algebraic loops), checks that every referenced name resolves and every
  `d()` targets a real stock. Diagnostics carry source locations.
- **`types.ts`** — the shared `Model`, `Expr`, and declaration types — the
  contract between parser and engine.

### `src/engine` — simulation & analysis (pure, Node-runnable)

- **`builtins.ts`** — stateless functions, the `step`/`pulse`/`ramp` test
  inputs, and piecewise-linear table interpolation.
- **`eval.ts`** — the AST interpreter. Walks an `Expr` against a numeric scope.
- **`compile.ts`** — expands stateful builtins (`smooth`, `smoothi`, `smooth3`,
  `delay1`, `delay3`) into **internal stocks** by AST rewrite, so the integrator
  handles them uniformly. After this pass a model is an ordinary stock-and-flow
  system.
- **`simulator.ts`** — the integrator. Initializes state (a relaxation pass that
  resolves the delay-boundary DAG), then steps with Euler or classical RK4,
  recomputing aux/flow variables at every derivative sample. Halts cleanly on a
  non-finite stock.
- **`loops.ts`** — builds the signed influence graph by **numerically
  perturbing** each variable at the initial operating point, enumerates simple
  cycles, and classifies each as R / B / ? by the parity of negative edges.

### `src/ui` — the studio (the only DOM-aware layer)

- **`store.ts`** — one observable store. A normal subscribe channel for
  structural changes plus a lighter `onFrame` channel so playback can repaint
  the plot cursor and diagram cheaply.
- **`plot.ts`** — canvas time-series plot with the animated time cursor.
- **`diagram.ts`** — the animated causal diagram (radial layout, filling stocks,
  marching-ants signed edges, loop tracing).
- **`app.ts`** — assembles the shell, wires the editor/toolbar/tabs/transport,
  and runs the single `requestAnimationFrame` clock that drives animation.
- **`model-edit.ts`** — surgical text edits (e.g. rewrite the `sim` line) so the
  toolbar keeps the text canonical.
- **`help.ts`** — the in-app language reference (Format tab).

## Why an AST instead of `new Function`

The legacy prototype (`reference/flowloom-v1.html`) compiled each expression with
`new Function` + `with(scope)`. That is compact but it (a) executes arbitrary
code, (b) can't be inspected, and (c) can't be differentiated. The AST approach
buys three things the product needs:

1. **Safety** — model text from an AI or a shared link is interpreted, not executed.
2. **Dependency analysis** — `freeVars` drives topological ordering and the
   influence graph directly from structure.
3. **Numeric differentiation** — perturbing the interpreter at an operating point
   yields the signed edges for loop polarity.

## Testing strategy — tests as contracts

- **Unit (Vitest, `tests/unit`)** pin the *language semantics* and *numeric
  behaviour*: grammar rules, and engine output checked against closed-form
  solutions (exponential decay/growth, the compound-interest recurrence) and
  conserved quantities (SIR population invariance). These are the contract a
  model author relies on.
- **E2E (Playwright, `tests/e2e`)** pin the *studio behaviour*: boot, edit-reruns,
  error reporting, diagram/loops rendering, and playback. The app exposes its
  store on `window.flowloom`, which the tests (and AI tooling) read.

## Build & run

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server with HMR. |
| `npm run build` | Typecheck (`tsc --noEmit`) then a production bundle in `dist/`. |
| `npm test` | Vitest contract tests (Node). |
| `npm run test:e2e` | Playwright e2e (boots the dev server automatically). |
| `npm run test:all` | Both suites. |
