# The flowloom modeling language

This is the **canonical, complete reference** for the flowloom `.flow` language —
the plain-text format that *is* a model. It is designed so that a human or an AI
can read, write, and edit a system-dynamics model without ever touching a
diagram. The diagram, plots, and animation are all *derived* from this text.

> Design rule: meaning lives in the text, never in pixel positions. Anything an
> AI needs to understand or change a model is one of the line forms below.

## A model is a list of statements

One statement per line. Blank lines are ignored. `#` starts a comment that runs
to the end of the line. A trailing comment on a declaration becomes that
symbol's documentation string.

```flow
stock Population [people] = 5      # the starting headcount
```

## Statement forms

| Form | Meaning |
|---|---|
| `stock NAME [unit] = EXPR` | An **accumulator** (an integral). `EXPR` is its value at `start`. |
| `d(NAME) = EXPR` | The **net rate of change** of a stock — literally `dNAME/dt`. This is what gets integrated. |
| `flow NAME [unit] = EXPR` | A named rate. Identical to `aux` but drawn as a flow on the diagram. |
| `aux NAME [unit] = EXPR` | An instantaneous computed value (a "converter"/variable). |
| `param NAME [unit] = EXPR` | A constant. `const` is an accepted alias. |
| `table NAME = (x,y) (x,y) …` | A piecewise-linear **graphical/lookup function**. Call it as `NAME(x)`. |
| `sim dt=… to=… start=… method=…` | Simulation settings. The toolbar edits this line. |
| `plot A B C` | Which series are visible by default. |

The `[unit]` annotation is optional. It does not affect the numbers, but where
you supply it, `lint`/`check` run a **dimensional analysis**: it flags adding
unlike units, passing a dimensioned value to `exp`/`ln`/`sin`/…, and a
`change(stock)` that isn't the stock's units per unit of time. Un-annotated names
are treated as *unknown* (not dimensionless), so checking is opt-in and only fires
where you've annotated enough to make the claim. Set the time unit with
`sim timeunit=month` (defaults to `time`).

### Stocks and rates — the engine

A stock is the running integral of its net flow:

```
stock(t + dt) = stock(t) + dt · change(stock)
```

You write the derivative with `change(NAME) = …`; flowloom integrates it. A stock
with **no** `change()` line stays constant. Every `change(NAME)` must refer to a
declared `stock NAME`. `d(NAME)` is accepted as a shorthand alias.

```flow
stock Water = 80
param inflow = 5
flow draining = 0.1 * Water
change(Water) = inflow - draining     # net rate: in minus out
```

### Variables: `flow`, `aux`, `param`

All three are computed each time the derivative is sampled. They differ only in
role and diagram appearance:

- `param` / `const` — a constant knob, evaluated once.
- `aux` — an intermediate calculation.
- `flow` — an `aux` that represents a rate; drawn as a flow valve.

Variables may reference stocks, params, and each other — but **not in an
algebraic loop** (a flow cannot instantaneously depend on itself). Route genuine
feedback through a stock, or through a delay. flowloom topologically orders
variables automatically and reports algebraic loops as errors.

### Tables (graphical functions)

```flow
table drainCurve = (0,0) (20,2) (40,5) (60,9) (80,14)
flow draining = drainCurve(Water)
```

`x` values must strictly increase. Lookups interpolate linearly between
breakpoints and clamp to the end values outside the defined range.

## Expressions

Standard infix math with the usual precedence:

- Arithmetic: `+ - * / %` and `^` for power (`**` is accepted and means the same).
  `^` is right-associative: `2 ^ 3 ^ 2 = 2 ^ 9`.
- Comparisons: `== != < <= > >=`. They return `1` (true) or `0` (false).
- Logical: `&&` / `and`, `||` / `or`, and unary `!` / `not`. Any non-zero value
  counts as true. The word forms are aliases — they print back as the symbols.
- Unary `-` and `+`.
- The current time is available as `t` (or `time`).
- Constants: `PI`, `E`.

Precedence, loosest to tightest: `||` < `&&` < comparisons < `+ -` < `* / %` <
`^` < unary. So `a + b > c && d` parses as `((a + b) > c) && d`. These operators
are what you put in the condition of `if(cond, a, b)` — e.g.
`if(Cash > 0 && !paused, hireRate, 0)`.

### Functions

Pure math:

```
min  max  abs  exp  ln  log  log10  sqrt  pow
sin  cos  tan  floor  ceil  round  sign
if(cond, a, b)        clamp(x, lo, hi)
```

`if(cond, a, b)` is a pure function, **not** control flow: `cond`, `a`, and `b`
are all evaluated, then the result of `a` or `b` is selected. Don't rely on the
untaken branch being skipped to avoid e.g. division by zero — guard the operand
instead (`x / max(y, 1e-9)`).

### Test-input functions

Drive a model over time:

| Call | Behaviour |
|---|---|
| `step(height, t0)` | `0` before `t0`, then `height`. |
| `pulse(t0, width)` | `1` during `[t0, t0+width)`, else `0`. |
| `ramp(slope, t0, t1)` | `0` before `t0`; a line of the given slope between `t0` and `t1`; frozen after. |

### Delays and smoothing (stateful)

These carry state across time. flowloom compiles each into internal stocks, so
they integrate correctly (including under RK4) and they correctly participate in
feedback-loop detection.

| Call | Behaviour |
|---|---|
| `smooth(input, τ)` | First-order exponential smoothing; starts equal to `input`. |
| `smoothi(input, τ, init)` | Like `smooth` but with an explicit initial value. |
| `smooth3(input, τ)` | Third-order (cascaded) smoothing. |
| `delay1(input, τ)` | First-order material delay. |
| `delay3(input, τ)` | Third-order material delay (smoother pipeline). |

```flow
flow receiving = delay3(orders, leadTime)   # orders arrive after a delay
```

## Subscripts (arrays)

Model many similar things as one array. A `dim` declares a dimension — an ordered
list of named elements — and a `[dim]` annotation makes a stock/flow/aux/param an
array over it:

```
dim region = North, South, East
stock Population[region] = 1000          # one stock per element
param birthRate = 0.03                   # a plain scalar broadcasts to all elements
flow  births[region] = birthRate * Population[region]   # elementwise
change(Population[region]) = births[region]
aux   Total = sum(Population)            # sum() collapses the dimension to a scalar
```

Equations are **elementwise**: every `[region]` reference iterates in lockstep.
Reference a single element with a literal subscript (`Population[North]`), and
collapse a whole dimension with `sum(X)`. Subscripts are **lowered to scalar
stocks** at compile time (`Population.North`, …), so they simulate, animate, and
appear in the diagram/plot exactly like hand-written scalars — and run on all
backends identically. A bracket that doesn't name a declared `dim` is still a unit
(`stock Tank [liters] = …`).

v1 covers one-dimensional subscripts, elementwise equations, single-element
indexing, and `sum`. Per-element parameter values, multi-dimensional subscripts,
and other aggregations (`mean`/`min`/`max`) are planned.

## Simulation settings

```flow
sim dt=0.1 to=50 start=0 method=rk4
```

- `dt` — integration step. Smaller is more accurate and slower.
- `to` — end time. `start` — start time (default `0`).
- `method` — `rk4` (classical Runge–Kutta, default, accurate) or `euler`
  (simple, fast, useful when a model is defined on discrete periods).

The toolbar's dt / to / method controls rewrite this exact line, so the text
always reflects what ran.

## Feedback loops

flowloom builds a **signed influence graph**: an edge `u → v` carries the sign of
`∂v/∂u`, measured at the model's initial state. A loop's polarity is the product
of its edge signs:

- **R (reinforcing)** — an even number of negative links; the loop compounds.
- **B (balancing)** — an odd number of negative links; the loop seeks a goal.
- **?** — at least one link's sign couldn't be determined at the initial state.

Polarity is read at `t = start`; nonlinear models can flip a loop's polarity as
they evolve (e.g. logistic growth is reinforcing while small and balancing near
its ceiling — the same single structural loop).

## Errors the parser will give you

- `'<name>' is defined twice` / `'<name>' is a reserved name` (`t`, `time`, `dt`, `PI`, `E`).
- `change(<name>) has no matching stock <name>`.
- `unknown name '<name>'` — a reference that resolves to nothing.
- `algebraic loop among: …` — instantaneous self-reference; route it through a stock.
- `no stocks defined` — every model needs at least one stock.

## Editing visually (the builder and `# @pos`)

The text is canonical, but you don't have to type it. On the **Diagram** tab, **✎ Edit**
turns on a visual builder:

- **+ Stock / + Flow / + Aux / + Param** append a declaration and open an inline editor for its name and equation.
- **Select** a node to rename it, change its equation (or a stock's initial value), or delete it (you're warned which lines reference it first).
- **Connect** wires things up: click a flow/aux then a stock to fold it into that stock's `change()` (the **−/＋** toggle picks the sign), or click two stocks to create a flow that drains the first and fills the second.
- **Drag** a node to position it.

Every action rewrites the same `.flow` text — there is no separate diagram state — so an edit you make by clicking is identical to one you type, and ⌘/Ctrl-Z undoes either.

Node positions are stored as a comment the parser ignores:

```flow
# @pos NAME X Y
```

Because it's a comment it doesn't change the model, but it travels with the text (including in a shared link), so a hand-arranged diagram is reproducible. Nodes without a `# @pos` fall back to automatic layout.

## A complete example

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
