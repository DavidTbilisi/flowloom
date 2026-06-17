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

The `[unit]` annotation is optional and is carried through for labelling and
future units checking. It does not affect the numbers.

### Stocks and rates — the engine

A stock is the running integral of its net flow:

```
stock(t + dt) = stock(t) + dt · d(stock)
```

You write the derivative with `d(NAME) = …`; flowloom integrates it. A stock
with **no** `d()` line stays constant. Every `d(NAME)` must refer to a declared
`stock NAME`.

```flow
stock Water = 80
param inflow = 5
flow draining = 0.1 * Water
d(Water) = inflow - draining     # net rate: in minus out
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

- Operators: `+ - * / %` and `^` for power (`**` is accepted and means the same).
  `^` is right-associative: `2 ^ 3 ^ 2 = 2 ^ 9`.
- Unary `-` and `+`.
- The current time is available as `t` (or `time`).
- Constants: `PI`, `E`.

### Functions

Pure math:

```
min  max  abs  exp  ln  log  log10  sqrt  pow
sin  cos  tan  floor  ceil  round  sign
if(cond, a, b)        clamp(x, lo, hi)
```

`if(cond, a, b)` short-circuits — only the taken branch is evaluated, so the
untaken branch can safely divide by zero.

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
- `d(<name>) has no matching stock <name>`.
- `unknown name '<name>'` — a reference that resolves to nothing.
- `algebraic loop among: …` — instantaneous self-reference; route it through a stock.
- `no stocks defined` — every model needs at least one stock.

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

d(S) = -infection
d(I) = infection - recovery
d(R) = recovery

sim dt=0.25 to=120 method=rk4
plot S I R
```
