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
change(Population) = growth
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

And — unlike the AI tools that only *draw* a causal-loop diagram — flowloom
**actually simulates**: real units, RK4 integration, automatic R/B loop detection.
So when an AI writes a model here, you don't trust it — you **run it**, watch the
dynamics, and check the numbers. Validate, don't vibe.

## What's in it

- **A real language** — `stock`, `change()`, `flow`, `aux`, `param`, `table`, with a
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
- **Draft a model with AI** — describe a system in plain English (*"a coffee
  shop where word-of-mouth drives growth but limited seating caps it"*) and
  Claude writes the `.flow`. It's then **parsed, checked, and run** by the same
  engine — so the AI's output is *verifiable*, not a sketch. Bring your own
  Anthropic key (stored only in your browser); the studio is fully functional
  without it.
- **Live parameter knobs** — every `param` gets a slider; drag it and the plot,
  diagram, loops, and table all re-simulate at once (Vensim's "SyntheSim", in the
  browser). The slider edits the *text*, so what you tuned is what's saved.
- **Plots that look designed** — round-number axes, gradient area fills, and
  hover-to-scrub the time cursor across every series.
- **A data table and a time scrubber**, all synchronized to one clock.
- **Learn-as-you-go** — a syntax-highlighted editor, a contextual-help bar that
  explains whatever the mouse is over, and a **Learn** button with a guided tour,
  interactive lessons, and example walkthroughs. See
  [`docs/ui-guide.md`](docs/ui-guide.md).

## Run it

**Live:** <https://davidtbilisi.github.io/flowloom/> — pushed to `main` auto-deploys
via GitHub Actions (`.github/workflows/deploy.yml`). A model shared as a link
(`#m=…`) opens straight into the studio.

```bash
npm install
npm run dev          # open the studio with hot reload
```

Build a static bundle with `npm run build` (output in `dist/`). There is no
backend — the engine runs entirely in the browser.

## Use it from an AI agent

The in-app **✨ AI** button is one way to get a model from a prompt. The other is
headless: the same DOM-free engine runs without the UI, so an agent (Claude Code,
Claude Desktop, a script) can author, run, and reason about models — and critique
them against real loop analysis and simulation, not a hallucinated mental run:

```bash
npm i -g .                                   # installs `flowloom` + `flowloom-mcp`
flowloom run     model.flow --json           # simulate → all series as JSON
flowloom explain model.flow                  # plain-language summary (stocks, knobs, loops)
flowloom describe model.flow --json          # full structure (stocks/rates/vars/deps/loops)
flowloom loops   model.flow --json           # feedback loops with R/B polarity
flowloom check   model.flow                  # validate; non-zero exit + line/col diagnostics
flowloom reference --json                     # the language + builtins catalog
```

- **One-page authoring guide:** [`docs/llms.txt`](docs/llms.txt) — a prompt-ready
  `.flow` cheatsheet (grammar, every builtin, the gotchas). Generated from the
  canonical catalog (`npm run gen:llms`), so it never drifts.
- **MCP server:** `flowloom-mcp` exposes the engine to Claude Code / Claude Desktop
  as tools — `flow_run`, `flow_check`, `flow_loops`, `flow_describe`, `flow_explain`,
  `flow_examples` — plus a `flow://reference` resource carrying the guide. Each tool
  takes the model as text. Register it as a stdio MCP server pointing at
  `dist-cli/mcp.js` (build with `npm run build:cli`).

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

## The language, by example

A `.flow` model is just a list of statements, **one per line**. Blank lines are
ignored; `#` starts a comment to end of line (a trailing comment on a declaration
becomes that symbol's doc string). Here's every construct, each with a snippet you
can paste into the editor.

**The seven line forms at a glance:**

| line | meaning |
|---|---|
| `stock NAME [unit] = EXPR` | an accumulator (an integral); `EXPR` is its value at `start` |
| `change(NAME) = EXPR` / `d(NAME) = EXPR` | the net rate of change of a stock — `dNAME/dt`. **The engine.** |
| `flow NAME [unit] = EXPR` | a named rate; drawn as a flow valve |
| `aux NAME [unit] = EXPR` | an instantaneous computed value (a "converter") |
| `param NAME [unit] = EXPR` | a constant knob (`const` is an alias) |
| `table NAME = (x,y) …` | a graphical lookup function, called `NAME(x)` |
| `sim dt=.1 to=50 method=rk4` | simulation settings |
| `plot A B C` | which series start visible |

### Stocks and `change()` — the engine

A **stock** accumulates; you write its derivative with `change(NAME)` (or the
alias `d(NAME)`), and flowloom integrates it:

```flow
stock Water [liters] = 80         # value at t = start
param inflow = 5
flow draining = 0.1 * Water        # drains faster when fuller
change(Water) = inflow - draining  # net rate: in minus out  →  stock(t+dt) = stock(t) + dt·change
```

A stock with **no** `change()` line stays constant. Every `change(NAME)` must name
a declared `stock`. At least one stock is required — that's what makes it a
dynamic model.

### Variables: `flow`, `aux`, `param`

All three are expressions recomputed each step; they differ only in **role and
diagram appearance**:

```flow
param birthRate = 0.03            # a constant knob — evaluated once, gets a UI slider
aux   gap = target - Inventory    # an intermediate calculation
flow  births = birthRate * Pop    # an aux that represents a rate — drawn as a flow
```

Variables may reference stocks, params, and each other — but **not in an
algebraic loop** (a flow can't instantaneously depend on itself). Route real
feedback through a stock or a delay; flowloom orders variables automatically and
reports algebraic loops as errors.

### Expressions

Standard infix math with the usual precedence:

```flow
aux a = (x + y) * 2 ^ 3           # + - * / %, ^ for power (right-assoc; ** also works)
aux b = Cash > 0 && !paused       # comparisons == != < <= > >= return 1/0; && || ! (or: and/or/not)
aux c = if(Cash > 0 && !paused, hireRate, 0)   # if(cond, a, b)
aux d = clamp(level, 0, 100)      # the current time is `t` (or `time`); constants PI, E
```

`if(cond, a, b)` is a **pure function, not control flow** — all three arguments are
evaluated, then one result is selected. Don't use the untaken branch to dodge a
divide-by-zero; guard the operand instead (`x / max(y, 1e-9)`).

**Pure math functions:** `min max abs exp ln log log10 sqrt pow sin cos tan floor
ceil round sign clamp(x,lo,hi) if(cond,a,b)`.

### Test inputs — drive a model over time

```flow
flow shock = step(100, 20)        # 0 before t=20, then 100
flow blip  = pulse(5, 2)          # 1 during [5, 7), else 0
flow rise  = ramp(3, 10, 40)      # slope-3 line between t=10 and t=40, frozen after
```

### Delays and smoothing (stateful)

These carry state across time — flowloom compiles each into hidden internal
stocks, so they integrate correctly under RK4 **and** show up in loop detection:

```flow
flow receiving = delay3(orders, leadTime)   # orders arrive after a 3rd-order delay
aux  expected  = smooth(demand, 8)          # 1st-order exponential smoothing, τ=8
```

`smooth(in,τ)`, `smoothi(in,τ,init)`, `smooth3(in,τ)`, `delay1(in,τ)`,
`delay3(in,τ)`.

### Tables (graphical functions)

A piecewise-linear lookup; `x` values must strictly increase, and it clamps to the
end values outside the range:

```flow
table drainCurve = (0,0) (20,2) (40,5) (60,9) (80,14)
flow draining = drainCurve(Water)
```

### Randomness (seeded, reproducible)

```flow
flow gain = Balance * (ret + random_normal(0, vol))   # also random(), random_uniform(lo,hi)
sim dt=1 to=60 seed=1                                  # same seed → identical run every time
```

### Subscripts (arrays)

Model many similar things as one array. `dim` declares an ordered dimension;
equations over `[dim]` are **elementwise**:

```flow
dim region = North, South, East
stock Population[region] = 1000               # one stock per element
flow  births[region] = 0.03 * Population[region]
change(Population[region]) = births[region]
aux   Total = sum(Population)                 # sum() collapses the dimension to a scalar
```

Index one element with a literal (`Population[North]`). A bracket that doesn't name
a declared `dim` is still treated as a unit (`stock Tank [liters] = …`).

### Units — opt-in dimensional analysis

The `[unit]` annotation never changes the numbers, but where you supply it,
`check`/`lint` flag adding unlike units, passing a dimensioned value to
`exp`/`ln`/`sin`, or a `change(stock)` whose units aren't the stock's-per-time.
Un-annotated names are *unknown* (not dimensionless), so checking only fires where
you've annotated enough to make the claim. Set the time unit with
`sim timeunit=month`.

### Simulation settings and `plot`

```flow
sim dt=0.1 to=50 start=0 method=rk4   # dt: step (smaller = more accurate, slower)
plot S I R                            # method: rk4 (default, accurate) or euler
```

The toolbar's dt / to / method controls rewrite this exact line, so the text
always reflects what ran. `plot` only sets which series start visible — it's
cosmetic.

### A complete model

```flow
# SIR epidemic — Susceptible -> Infected -> Recovered.
stock S [people] = 999
stock I [people] = 1
stock R [people] = 0

param beta  = 0.4     # infections per S-I contact
param gamma = 0.1     # recovery rate
param N     = 1000    # total population

flow infection = beta * S * I / N
flow recovery  = gamma * I

change(S) = -infection
change(I) = infection - recovery
change(R) = recovery

sim dt=0.25 to=120 method=rk4
plot S I R
```

Full reference (every edge case, parser errors, the `# @pos` builder comments):
[`docs/language.md`](docs/language.md) ·
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
- [x] units checking (dimensional analysis) from the `[unit]` annotations
- [x] seeded randomness (`random`/`random_uniform`/`random_normal`) + Monte Carlo bands
- [x] data import + calibration (fit params to an observed CSV by normalised-RMSE)
- [x] studio plot overlays: Monte Carlo bands, observed-data overlay, model comparison, in-app calibrate
- [x] a `flowloom` CLI (`flowloom run model.flow --csv`) sharing this engine
- [x] AI-facing surface — CLI `explain`/`describe`/`reference`, a generated
      `llms.txt` guide, and a `flowloom-mcp` MCP server over the same engine
- [x] **in-app AI draft** — prose → `.flow`, parsed and run on the spot (BYO key)
- [x] **live parameter sliders** — drag a knob, the whole model re-simulates
- [x] designed plots — round-number axes, gradient fills, hover-to-scrub

The original single-file prototype is preserved at
[`reference/flowloom-v1.html`](reference/flowloom-v1.html).

## License
MIT (see LICENSE).
