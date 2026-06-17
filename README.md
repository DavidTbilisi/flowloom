# flowloom

**A systems-thinking studio that runs on plain text.** Stocks, flows, and
feedback loops — a Vensim-style stock-and-flow modeller where the model is
*text*, not a hand-drawn diagram. The diagram, plots, and animation are all
generated *from* the text.

```flow
stock Population = 5
param birthRate = 0.7
param carrying  = 1000
flow growth = birthRate * Population * (1 - Population / carrying)
d(Population) = growth
```
→ Run → an S-curve, an animated causal diagram, and its reinforcing loop, found
automatically.

## Why text-first

A stock-and-flow diagram is the *worst* representation for a machine (or an LLM)
to read or edit — the meaning is encoded in pixel positions and arrow wiring. The
same model as text is the *best*: an AI can add a stock, retune a loop, or explain
the dynamics by editing lines. flowloom keeps the **text canonical** and *derives*
the picture. Even the toolbar's dt/method controls edit the text, so what an AI
reads is always what ran.

## What's in it

- **A real language** — `stock`, `d()`, `flow`, `aux`, `param`, `table`, with a
  safe AST interpreter (no `eval`). See [`docs/language.md`](docs/language.md).
- **A proper engine** — Euler and classical **RK4** integration; `step`/`pulse`/
  `ramp` test inputs; graphical **lookup tables**; first- and third-order
  **delays and smoothing** (`smooth`, `delay1`, `delay3`, …). Expressions compile
  to slots in a reused typed array (no `eval`), and **very large models run in a
  Web Worker with a generated WebAssembly backend** so the UI never blocks.
- **Automatic feedback-loop analysis** — a signed influence graph finds every
  loop and labels it **R** (reinforcing) or **B** (balancing).
- **An animated diagram on an infinite canvas** — press play and watch stocks
  fill to their level while signed causal links march; hover a loop to trace it
  with its R/B badge. **Scroll to zoom, drag to pan, Fit to frame** — large
  models lay out on a scalable grid (and degrade to a navigable dot-map) so even
  a thousand-node graph stays explorable.
- **Plots, a data table, and a time scrubber**, all synchronized to one clock.
- **Learn-as-you-go** — a syntax-highlighted editor, a contextual-help bar that
  explains whatever the mouse is over, and a **Learn** button with a guided tour,
  interactive lessons, and example walkthroughs. See
  [`docs/ui-guide.md`](docs/ui-guide.md).

## Run it

```bash
npm install
npm run dev          # open the studio with hot reload
```

Build a static bundle with `npm run build` (output in `dist/`). There is no
backend — the engine runs entirely in the browser.

## Tests are the contract

```bash
npm test             # Vitest: language semantics + numeric behaviour
npm run test:e2e     # Playwright: the studio's behaviour end-to-end
npm run test:all     # both
```

The unit tests pin the engine against closed-form solutions (exponential
decay/growth, the compound-interest recurrence) and conserved quantities (SIR
population invariance). The e2e tests drive the real app: boot, edit-reruns,
errors, diagram, loops, and playback.

## The format in one table

| line | meaning |
|---|---|
| `stock NAME [unit] = EXPR` | an accumulator (an integral); EXPR is its initial value |
| `d(NAME) = EXPR` | the net rate of change of a stock — `dNAME/dt`. **The engine.** |
| `flow NAME = EXPR` | a named rate; drawn as a flow |
| `aux NAME = EXPR` | an instantaneous computed value |
| `param NAME = EXPR` | a constant knob |
| `table NAME = (x,y) …` | a graphical lookup function, called `NAME(x)` |
| `sim dt=.1 to=50 method=rk4` | simulation settings |
| `plot A B C` | which series start visible |

Full reference: [`docs/language.md`](docs/language.md) ·
Architecture: [`docs/architecture.md`](docs/architecture.md).

## Examples

In `examples/` and the in-app dropdown: logistic growth, Lotka–Volterra
predator–prey, SIR epidemic, compound savings, Newton's-law cooling, an
inventory model with an acquisition **delay**, and a bathtub driven by a
**lookup table**. (`npm run gen:examples` regenerates the `.flow` files from the
canonical source so they never drift.)

## Keyboard

- **⌘/Ctrl + Enter** — run
- Tabs: Plot · Diagram · Loops · Table · Format
- On Plot/Diagram, use the transport bar to play, pause, or scrub time.
- The editor highlights syntax as you type; hover any keyword, node, or control
  to see it explained in the status bar at the bottom. The **Learn** button opens
  a tour, lessons, and walkthroughs.

## Roadmap

- [x] R/B loop polarity auto-detection and labeling
- [x] animated causal diagram with interactive loop overlay
- [x] AST language with delays, lookups, and test inputs
- [x] contract tests (Vitest) + e2e tests (Playwright)
- [x] save/load `.flow` files (drag-drop) and shareable URL state
- [x] compiled (slot-based) evaluator + a generated **WASM** backend for large
      models, run off-thread in a Web Worker
- [ ] units checking from the `[unit]` annotations
- [ ] a `flowloom` CLI (`flowloom run model.flow --csv`) sharing this engine

The original single-file prototype is preserved at
[`reference/flowloom-v1.html`](reference/flowloom-v1.html).

## License
MIT (see LICENSE).
