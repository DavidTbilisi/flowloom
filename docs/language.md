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
| `stock NAME [unit] [>= 0] = EXPR` | An **accumulator** (an integral). `EXPR` is its value at `start`; `>= 0` marks a quantity that cannot go negative. |
| `d(NAME) = EXPR` | The **net rate of change** of a stock — literally `dNAME/dt`. This is what gets integrated. |
| `flow NAME [unit] = EXPR` | A named rate. Identical to `aux` but drawn as a flow on the diagram. |
| `aux NAME [unit] = EXPR` | An instantaneous computed value (a "converter"/variable). |
| `param NAME [unit] = EXPR` | A constant **knob** — what sliders, sensitivity and calibration vary. |
| `const NAME [unit] = EXPR` | A **structural constant** (a calendar length, a conversion factor). Same maths as `param`, but not a knob: no slider, and sensitivity/calibration skip it unless it is named. |
| `switch NAME = on\|off` | A **two-state policy toggle** — a param that is only ever 0 or 1. See [Switches](#switches). |
| `table NAME = (x,y) (x,y) …` | A piecewise-linear **graphical/lookup function**. Call it as `NAME(x)`. |
| `scenario NAME key=value …` | A **named set of overrides** kept in the text. See [Scenarios](#scenarios). |
| `link A -> B +` / `link A -> B -` | A **declared signed influence** — the causal-loop sketch you draw before equations. See [Sketching first](#sketching-first-link). |
| `expect [SCENARIO] METRIC OP VALUE [± TOL]` | A **claim the model must keep satisfying** — its own test. See [Expectations](#expectations). |
| `data NAME [unit] = (t, v) …` | A **measured time series** read off the clock — an exogenous input. See [Data series](#data-series). |
| `include "part.flow" as NS [k=v …]` | **Compose from parts**: inline another model with every name prefixed `NS.`. See [Composing models](#composing-models-include). |
| `sim dt=… to=… start=… method=…` | Simulation settings. The toolbar edits this line. |
| `plot A B C` | Which series are visible by default. |

The `[unit]` annotation is optional. It does not affect the numbers, but where
you supply it, `lint`/`check` run a **dimensional analysis**: it flags adding
unlike units, passing a dimensioned value to `exp`/`ln`/`sin`/…, and a
`change(stock)` that isn't the stock's units per unit of time. Un-annotated names
are treated as *unknown* (not dimensionless), so checking is opt-in and only fires
where you've annotated enough to make the claim. Set the time unit with
`sim timeunit=month` (defaults to `time`). Bare numbers are **unit-polymorphic**:
`Cash < 0`, `max(0, x)`, `t % 12` read the literal in the other operand's units and
never warn on their own (the way a modeller reads them); under `*` and `/` a
literal is a pure scalar.

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

#### `>= 0` — a stock that cannot go negative

A stock is **signed** by default, and that is usually right: cash goes into
debt, a net position crosses zero, a temperature difference changes sign. But an
inventory, a workforce, or a queue cannot — and nothing stops an outflow from
draining one past empty, because `change()` says how fast to drain, not whether
there is anything left.

Declare the floor and the integrator holds the stock at zero:

```flow
stock Inventory [units] >= 0 = 100
param orders = 30
param restock = 10
change(Inventory) = restock - orders   # without `>= 0`, this reaches −300
```

Only `>= 0` is accepted. Zero is the bound that means something — it is what
makes a stock a physical quantity rather than a signed number. A floor at any
other level is a *policy*, not a property, and belongs in the outflow where a
reader can see it (`max(0, X - 5)`).

The floor bounds the **integrated value** after each completed step, which is
what Vensim and Stella do. It is not a constrained integration, and the
difference is real: holding the stock at zero *truncates the outflow*, so from
that moment less leaves the stock than `change()` asked for — and if that
outflow fills another stock, that one receives more than existed. `lint` reports
where a floor engaged for exactly this reason. When the balance matters, gate
the outflow yourself:

```flow
flow shipping = min(orders, Inventory / dt)   # never ship more than is on hand
```

### Variables: `flow`, `aux`, `param`

All three are computed each time the derivative is sampled. They differ only in
role and diagram appearance:

- `param` — a constant knob, evaluated once. `const` is the same value with a
  different role: a structural constant that tools leave alone (see the table
  above) — declare the length of a year or a unit conversion with it, so
  `sensitivity` does not rank "months per year" as your most powerful lever.
- `aux` — an intermediate calculation.
- `flow` — an `aux` that represents a rate; drawn as a flow valve.

#### `± tol` / `in lo..hi` — how well a knob is known

A param can carry the range you'd actually defend:

```flow
param birthRate = 0.03 ± 0.01        # give or take
param mortality = 0.01 ± 20%         # a percentage of the value itself
param carrying  = 1000 in 800..1400  # explicit bounds
```

The number still runs as written — the range changes nothing about the base run.
It is read by the three tools that need to know how far a knob can move:

| tool | what the range does |
|---|---|
| `montecarlo` | samples the param **once per run**, so a model with no `random*()` still gets real percentile bands. Without a declared range only the RNG seed varies, and on a deterministic model every run is identical — the bands are flat and say so. |
| `sensitivity --method morris\|sobol` | explores the declared interval instead of an invented ±10% box, so the index answers the question you asked. |
| `calibrate` | is not allowed to fit outside it, and reports any param that fitted **to** the edge — the data wanting to go further than you called plausible is a finding, not a detail. |

Sampling once per run is the point, and it is not the same as
`param x = random_normal(0.03, 0.01)`: that resamples every step, which is noise
*inside* the model, not uncertainty about a constant.

Write `±` or `+/-`. **`+-` is not accepted**, because `5 +- 1` is already a valid
expression meaning 4 — silently changing what that means would be worse than
asking for one more character; the parser warns if you write it.

A range belongs on a `param`. On a `const` it contradicts the declaration (a
const is *not* a knob), on a `switch` the uncertainty is which state — which
`policies` already enumerates — and on an `aux`/`flow` there is nothing to be
uncertain about, since the value is computed. Each of those is an error naming
the alternative. `lint` also flags a param whose own value sits outside the range
it declares.

Variables may reference stocks, params, and each other — but **not in an
algebraic loop** (a flow cannot instantaneously depend on itself). Route genuine
feedback through a stock, or through a delay — the input of `smooth`/`delay1`/
`delay3`/`previous`/`delay_fixed` is read from earlier steps, so it does not count
as an instantaneous dependency. flowloom topologically orders variables
automatically and reports algebraic loops as errors.

### Switches

```flow
switch separate = off        # pay savings first (Profit First)
switch rule48   = on         # 48-hour rule on impulse buys
aux wants = if(separate, fromLeftover, fromBalance) * if(rule48, 0.3, 1)
```

A `switch` is a `param` that may only be `on`/`off` (`1`/`0`; `true`/`false` and
`yes`/`no` are accepted too). It exists because a policy is two-state, and a
two-state knob needs different treatment everywhere a number gets bumped:

- `sensitivity` tests a switch **off → on** instead of ±10 % (a ±0.1 bump of `0`
  lands on two truthy values and reads as Δ = 0 — exactly wrong for the knob you
  most want ranked). Morris/Sobol sample it as {0, 1}.
- The studio's Tune panel renders it as a toggle, and writes `on`/`off` back.
- `--set separate=on`, MCP `set`, and scenario bindings accept `on`/`off`; any
  other value is an error, so a switch can never silently hold `0.5`.
- `flowloom policies model.flow --metric min:Cash [--target 0] [--cost separate=2]`
  enumerates **every combination** of the switches that are still off (the moves
  available; a switch that is on as written is a fact of the world and stays so
  unless named with `--switch`) and reports the best combination, the cheapest
  one reaching the target, and each switch's **Shapley contribution** — its
  average marginal effect over all combinations, so interactions between moves
  are shared out fairly — beside its effect *alone* and its effect *last* (given
  every other move). Up to 12 switches (4,096 runs); MCP: `flow_policies`.

#### The leverage ladder (`# @rung N`)

Donella Meadows ranked twelve places to intervene in a system, from the weakest
(12: the numbers) to the strongest (1: transcending paradigms). Tag a `param`,
`switch` or `scenario` with the rung it sits on in its doc comment —

```flow
param wants = 1805          # @rung 12 the cafe line
switch separate = off       # @rung 10 pay the Safe first
scenario rung3_goal target=48000 vacationWaits=on   # @rung 3 the runway goal
```

— and `flowloom leverage model.flow --metric min:Cash` (MCP `flow_leverage`) lays
the model's levers out on that ladder, measuring each on the metric: params by a
grain-aware ±10 % bump, switches off→on, scenarios against base. It reports every
rung's best lever, the model's own rung ranking next to Meadows', and the
untagged levers (nothing is placed by guesswork). Read the ranking with the
caveat it prints: a ±10 % bump on a big number is a large *move*, not a large
*effort* — the comparison is of metric swings. The studio's Tune panel groups
tagged knobs under their rung.

#### Knobs on the time grid

A knob whose value is read on the time grid — the length of a `delay_fixed`,
anything compared with the clock (`t >= sideStart`, `t % yearLen`), a `step`/
`pulse`/`ramp` time — only changes the run when it crosses a step. `sensitivity`
detects these statically (closing backwards from every such context to the
params that feed it) and bumps them by at least one `dt`; the row is labelled
`(±1)`. A knob whose bump leaves the metric exactly unchanged is marked *flat* —
usually a threshold not crossed at ±10 %; `sweep` it over a wider range.

### Scenarios

```flow
scenario safe     separate=on rule48=on
scenario recovery separate=on pay=9000 Cash=5000    # the plan after the raise
```

A `scenario` is a named set of overrides that lives **in the model text** — a
policy experiment is a first-class artefact, not shell history. Each binding may
target a `param`, a `switch` (`on`/`off`), a stock's initial value, or a sim
setting (`dt`/`to`/`start`/`seed`/`method`/`timeunit`); the parser checks every
key and value so a typo is a located error in the editor. `base` is reserved for
the model as written. Scenarios are applied on top of the base text when chosen:

- CLI: `flowloom run model.flow --scenario recovery` (then any `--set` on top);
  `flowloom scenarios model.flow` lists them; `flowloom compare model.flow
  --metric final:Cash,min:Cash` runs base + every scenario and prints one row per
  scenario with deltas.
- MCP: every analysis tool takes `scenario`; `flow_compare` tabulates.
- Studio: the **▣ Scenario** picker under the plot runs one, overlaying the base
  run as dashed lines; a Tune knob the scenario binds edits the scenario line;
  **▤ Scenarios table** runs base and every scenario and tabulates final / min /
  max of the visible series with the change against base (the studio's
  `compare`).

### Expectations

```flow
expect final:Cash > 0                          # the family ends above water
expect min:Cash == -2490.35 ± 0.01             # the floor the page cites
expect loops:active == 9                       # nine loops engage in the base run
expect recovery final:netWorth == 493370 ± 1%  # vs the source model's 487k
expect rung10_separate min:Cash >= 0           # Profit First keeps the card unused
```

An `expect` line is a claim about the model kept **in the model** — its own
regression test. A number that leaves the model (cited on a page, in a report,
in a decision) is a claim about the model *as it was*; the next edit can move it
silently. Written next to the scenarios it is about, the claim fails where the
edit happened, not where the number was quoted.

- The optional first token names a **scenario** (`base` = the model itself). It
  is unambiguous without lookahead: a metric always carries a colon, a scenario
  name never does.
- **METRIC** is a [metric spec](#simulation-settings) — `final:`/`max:`/`min:`/
  `mean:`/`time-to-peak:`/`settle-time:` of a series, `at:<t>:<series>`,
  `rmse:<series>:<series>` (fit of a model series to a [data series](#data-series)) — or a
  loop census: `loops:active`, `loops:total`, `loops:reinforcing`,
  `loops:balancing`, `loops:inactive`, `loops:rank` (the number of independent
  loops).
- **OP** is `<`, `<=`, `>`, `>=` or `==`. `==` is **exact** unless given a
  tolerance — `± 0.01` (absolute) or `± 1%` (of the value). An exact `==` that
  fails says how far off it was, which is the tolerance to write if that is
  acceptable.
- The parser checks the scenario, the metric and the series name (a `param` is
  not a series — expectations read outputs), so a typo is a located error.

Run them: `flowloom test model.flow` (one simulation per scenario, a line per
claim, non-zero exit on any failure — so a model can sit in CI); `flow_test` over
MCP; `describe`/`explain` list them.

### Data series

```flow
data income [GEL] = (0, 4485) (3, 4700) (6, 5200)      # held between samples
data temp = (0, 10) (2, 20) linear                      # interpolated
```

A `data` line is a **measured series read off the clock** — actual history as a
model input, kept in the text like everything else. It behaves as a plain named
series: use it in expressions (`change(Cash) = income - spend`), plot it, `diff`
it, guard it with `expect`. Between samples the value **holds** by default
(sampled data keeps its value until the next observation); write `linear` to
interpolate. Before the first point and after the last, the nearest value.

The file bridge runs both ways without the model ever referencing a file:

- `flowloom data obs.csv [--column a,b] [--time COL] [--unit U] [--linear]`
  prints CSV columns as `data` lines to paste in (`>> model.flow` works).
- `flowloom calibrate model.flow --param r --against N=obs` (no `--data`) fits
  params against the model's **own** data lines; same over MCP.
- The metric `rmse:<series>:<data>` measures the fit over every step of the run,
  so `expect rmse:N:obs < 5` keeps a calibration honest after later edits.

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

### Discrete periods: `previous`, `delay_fixed`

A monthly budget or a yearly census is a **map on the time grid**, not an ODE:
`stock(t+dt) = stock(t) + change(t)`. Write it with `sim method=map dt=1
timeunit=month`: under `map` every `change()` is a **per-step increment** in the
stock's own units — `change(Cash) = income - spend` with `income [GEL]` — and no
`× dt` / `÷ dt` bookkeeping is needed (the units check expects `[GEL]`, not
`[GEL/month]`, and `lint` flags a leftover `/ dt`). Under `rk4` the derivative is
also sampled at `t + dt/2`, where a clock test like `t % 12 == 0` is false and
`t == 7` never fires; `lint` warns when it sees clock tests under rk4. (`euler
dt=1` with per-time-unit flows gives the same numbers as `map`; `map` says what
the model *is*.) `smooth`/`delay1`/`delay3` keep their time constants in time
units under `map` — their internal states still integrate with `dt`.

| Call | Behaviour |
|---|---|
| `previous(X, init?)` | `X` exactly one step ago. |
| `delay_fixed(X, length, init?)` | `X` exactly `length` time units ago — a **pipeline** delay (`delay1`/`delay3` are exponential lags). |

Both sample on the grid and hold their value across RK4 sub-steps (Vensim's
`DELAY FIXED` has the same semantics). `length` is read once at `start` and
rounded to whole steps, minimum one. Before enough history exists they return
`init`, or `X`'s initial value when omitted. Because their input is read from
earlier steps, they break instantaneous dependencies — `a = previous(b) + 1`,
`b = a * 2` is legal. If `X` depends on the delay's own output *and* no `init` is
given, the initial state is circular: `lint` says so and the run carries a note;
give an explicit `init`.

```flow
aux statement [GEL] = delay_fixed(Cash, 2)     # the review reads a 2-month-old statement
aux lastMonth [GEL] = previous(Cash)
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

Multiple dimensions compose as a **Cartesian product** — list them positionally:

```
dim region  = North, South
dim product = Food, Tools
stock Inventory[region, product] = 10                   # 4 scalar stocks: Inventory.North.Food, …
flow  restock[region, product] = 0.2 * Inventory[region, product]
change(Inventory[region, product]) = restock[region, product]
aux   Total = sum(Inventory)                            # collapses every element → one scalar
```

A reference's subscripts are matched **by position** to the symbol's declared
dimensions, so `Inventory[region, product]` and `Inventory[North, Food]` both
resolve against `[region, product]` in order. `sum(X)` collapses *all* of `X`'s
dimensions.

Give each element its own value with a **comma-separated list** on the right-hand
side, in Cartesian-product order (first dimension outermost); a single expression
still broadcasts to all elements:

```
dim product = Food, Tools
param growth[product]     = 0.1, 0.5             # Food → 0.1, Tools → 0.5
stock Inventory[region, product] = 10, 20, 30, 40   # North.Food, North.Tools, South.Food, South.Tools
flow  restock[region, product]   = growth[product] * Inventory[region, product]   # one expr, broadcast
```

The list length must equal the number of element tuples. Commas inside a call
(`max(a, b)`) are not element separators.

`sum(X)` collapses *every* dimension of `X` to a scalar. To collapse just one axis
of a multi-dimensional array and keep the rest, name it: `sum(X, dim)`. The result
is still indexed by the remaining dimensions, so it goes in a declaration over them:

```
flow outflow[from] = sum(Trade, to)     # row sum: for each `from`, total over `to`
aux  inflow[to]    = sum(Trade, from)   # column sum: for each `to`, total over `from`
aux  grand         = sum(Trade)         # everything → one scalar
```

The axis must be a dimension of the array, and whatever you don't collapse has to
be supplied by the surrounding declaration's subscripts (`sum(Trade, to)` leaves
`from`, so it belongs on a `[from]` result).

A `change()` may name the stock's dimensions — `change(Population[region])` —
and they are **checked**: the axes must be the stock's own, in the stock's own
order, because a rate is elementwise over the whole stock. `change(Pop[Sooth])`
and `change(Trade[to, from])` are located errors, not silently the un-indexed
stock.

Elements are addressable everywhere a name is:

```flow
expect final:Population[North] > 1200      # one element's series
```

```console
$ flowloom run model.flow --set Population[North]=500   # one element's value
$ flowloom causes model.flow 'Population[North]'        # one element's causes
```

An `expect` on the bare vector is an error (it is not one series), and both
`Population[North]` and the lowered spelling `Population.North` are accepted.

Covered today: multi-dimensional subscripts, elementwise equations, single-element
indexing, per-element values, per-element overrides, full and partial/axis `sum`.
Other reducers (`mean`/`min`/`max`) are planned.

## Composing models (`include`)

```flow
include "engine.flow" as eng cashIn=excess invest=0.5

stock Cash [GEL] = 1000
aux excess [GEL] = max(0, Cash - 2000)
change(Cash) = income + eng.payout - eng.investing
```

`include` composes a model out of parts while keeping the thing every tool
operates on **a single text**: resolution is a source-to-source pass that
inlines the child file with every declared name prefixed `NS.` — the parser,
engine, studio and MCP never learn includes exist. The CLI resolves includes
from disk automatically (relative to the including file); `flowloom bundle
main.flow` prints the resolved text for the places that only take one text
(the studio, MCP tools, share links). Nested includes namespace twice
(`eng.inner.x`); cycles are an error naming the chain.

An include takes the child's **structure** — stocks, rates, flows, auxes,
params/consts/switches, tables, `data` lines, dims, `link`s — and drops, as
inert comments, its `sim`, `plot`, `scenario` and `expect` lines: the parent
owns time, presentation and claims.

**Bindings** rewire the child at include time. `key=value` with a number /
`on` / `off` rebinds the child declaration's default in place. Any other value
is an expression in the **parent's** scope: the child's `param cashIn = 0`
becomes `aux eng.cashIn = excess` — the composition point where a parent signal
drives a child input. (After inclusion you can still override `eng.invest`
with `--set`, a scenario line, or a slider — a namespaced param is a param.)

## Simulation settings

```flow
sim dt=0.1 to=50 start=0 method=rk4   # method: rk4 | euler | map
```

- `dt` — integration step. Smaller is more accurate and slower.
- `to` — end time. `start` — start time (default `0`).
- `method` — `rk4` (classical Runge–Kutta, default, accurate), `euler`
  (simple, fast), or `map` — a difference equation, `stock(t+dt) = stock(t) +
  change(t)`, where `change()` is a per-step increment in the stock's own units:
  the *right* choice when a model is defined on discrete periods — see
  [Discrete periods](#discrete-periods-previous-delay_fixed).
- `timeunit` — the name of the time unit for units checking (e.g. `month`).
- `seed` — the RNG seed for `random*()` (default `0`, so runs are reproducible).

Every one of these is bindable by `--set`, a scenario line, or MCP `set` —
including `timeunit`, so a scenario can re-frame a model from weeks to months
without editing the `sim` line.

The toolbar's dt / to / method controls rewrite this exact line, so the text
always reflects what ran.

## Sketching first (`link`)

The first hour of a new system is a causal-loop diagram, not equations. Write it
as links — `+` means B moves with A, `-` against:

```flow
link population -> births +
link births -> population +
link population -> deaths +
link deaths -> population -
link population -> crowding +
link crowding -> attractiveness -
link attractiveness -> migration +
link migration -> population +
```

A model of links alone is valid: it draws, `loops` finds its loops with polarity
from the declared signs (`R` births, `B` deaths, `B` crowding), `explain`
describes it — and `run` returns a note instead of a result, because nothing
integrates. To make it run, add a stock and its `change()` and replace links with
equations as you learn them. Links and equations coexist: a link between two
equation-level names adds an edge the equations don't carry yet (lint flags a
link that merely duplicates an equation dependency), and a param named in a link
becomes a node. Declared links can't be cut by `loops --metric` (there is no
equation to freeze), so they are listed as skipped there.

## Canonical form (`fmt`) and importing (`import`)

The text is the model, so there is a canonical way to write it:

```bash
flowloom fmt model.flow            # print it; non-zero exit if it wasn't already formatted
flowloom fmt model.flow --write    # rewrite it in place
```

`fmt` normalises *spelling and spacing* — one space around `=`, `on`/`off` for a
switch, a `data` line back in one piece, trailing comments lined up — and leaves
the **shape of your file alone**: declarations stay in the order you wrote them,
and blank lines between groups are kept. That order is not cosmetic; it fixes the
output series order, and therefore plot colours and CSV columns.

Run it on a model an AI just wrote, and `diff` becomes a list of real changes
instead of a list of whitespace.

`# @pos` layout comments (what the visual builder writes when you drag a node)
are carried through, so formatting never costs you a diagram you arranged by
hand. Positions for names the model no longer declares are dropped — the tidy-up
a rename or a delete wants.

Models from other tools come in through XMILE — the OASIS interchange format
Stella writes as `.stmx`:

```bash
flowloom import model.stmx > model.flow
```

Stocks with their in/outflows become `stock` + `change()`, a bare-number `aux`
becomes a `param` (so it gets a slider and shows up in sensitivity), a `<gf>`
becomes a `table`, `IF/THEN/ELSE` becomes `if(…)`, and `non_negative` becomes
`>= 0`. Anything that could not come across — arrays flattened, macros skipped, a
function with no flowloom equivalent — is **reported on stderr, never dropped
silently**, and the partial translation is still returned so you can finish it.
XMILE's default integration is Euler, so run `check --numerics` before trusting
the numbers.

## Checking an edit (`diff`)

```
flowloom diff before.flow after.flow [--scenario a,b] [--tol 1e-9] [--no-loops]
```

"Did this edit change what the model computes?" is the most common question
about a living model and the easiest to answer wrong by eye. `diff` compares two
model texts in three layers: **structure** (stocks, variables and scenarios
added or removed; param values and sim settings that differ), **numbers** (every
series, under base and every scenario both sides declare, on the shared time
grid — the largest |Δ| per series and where it occurs), and the **loop census**
(total and live loops per side, and any live loop that appeared or vanished).
The verdict `identical` means numbers and live loops — a refactor that renames
an aux, removes `× dt` bookkeeping or moves a term should pass it; structure
changes are listed but do not fail it. Exit status is non-zero when different,
like `diff(1)`. The loop layer is what catches an edit that keeps every number
and still changes the analysis — a phantom self-loop reappearing, a loop going
dead — which no numeric comparison sees.

## Feedback loops

Link signs are read by numerical perturbation at **every sampled step of the
run** (up to 64, evenly spaced), not only at `start`. A loop is *active* at a
sample when each of its links is non-zero there; its polarity is the product of
the signs. The reported polarity is the reading at `start` when the loop is
active there, else the reading where it first engages (`from t=…`). A loop that
changes sign along the run is marked `R~B` (logistic growth: reinforcing early,
balancing as the ceiling bites). A loop with a link that is flat at every sample
— the untaken branch of an `if()`, a gate that never opens in this run — is
reported **inactive** with that link named; flipping a switch or choosing a
scenario is what brings it alive. The map idiom `change(X) = (next − X) / dt`
does not count as a self-loop of `X`.

`flowloom loops model.flow --metric min:Cash` adds **loop dominance by
knockout**: for each active loop, one link (the one shared by the fewest other
active loops) is frozen at its start value, the model re-runs, and loops are
ranked by how far the metric moves — the answer to "which loop is running this
system". A cut that sends the metric off the scale is reported as *runaway*
(the loop was holding the system together). MCP: `flow_loops` with `metric`.

**The basis.** Enumerating every simple loop is exponential and the count says
little — a 9-stock budget has 270 loops, most of them the same few mechanisms
threaded through different `if()` branches. The graph's **cycle rank** (links −
nodes + 1 per strongly connected component) is how many loops are independent;
every other loop is a combination of those. flowloom computes a **shortest
independent loop set** (Oliva 2004; Horton's candidate set, Gaussian elimination
over GF(2) on link-incidence vectors) — rank-many loops, shortest first, live
loops preferred — and marks them `*` (CLI) / *basis* (studio). `loops --basis`
lists just those; the studio's *basis only* toggle does the same; MCP
`flow_loops` takes `basis: true`. It is built by polynomial work straight from
the graph, so it is complete even when enumeration had to stop at its cap —
on a large model the basis is the read that is guaranteed whole.


flowloom builds a **signed influence graph**: an edge `u → v` carries the sign of
`∂v/∂u`, measured at the model's initial state. A loop's polarity is the product
of its edge signs:

- **R (reinforcing)** — an even number of negative links; the loop compounds.
- **B (balancing)** — an odd number of negative links; the loop seeks a goal.
- **?** — at least one link's sign couldn't be determined at the initial state.

Polarity is read at `t = start`; nonlinear models can flip a loop's polarity as
they evolve (e.g. logistic growth is reinforcing while small and balancing near
its ceiling — the same single structural loop).

## Tracing: what feeds this, what does this feed

Loops answer "what is this system doing"; tracing answers the two questions you
have *before* editing an unfamiliar model:

```console
$ flowloom causes model.flow infection
infection  [flow]
├─ + beta  [param]
├─ + S  [stock]
│  └─ − infection  [flow] ↺
├─ + I  [stock]
│  ├─ + infection  [flow] ↺
│  └─ − recovery  [flow]
│     ├─ + gamma  [param]
│     └─ + I  [stock] ↺
└─ − N  [param]

$ flowloom uses model.flow beta        # what breaks if I change this
$ flowloom document model.flow         # every name: definition, causes, readers
```

`+` / `−` is the sign of the edge, read the same way loop polarity is (central
difference at the operating point), and `↺` closes a branch that has come back
to a name already open above it — the loop is real, and `loops` is where it gets
named. `(+N more)` marks what `--depth` (default 3) cut off.

Two deliberate differences from the loop graph: **params are included**, because
"what determines the infection rate" is answered by `beta` as much as by `S` and
a causes tree that hides the knobs hides the levers; and **internal names are
not** — `smooth(X, tau)` becomes a hidden stock when compiled, but the author
wrote `X` and `tau`, so that is what the tree shows. A stock's causes are what
its `change()` reads; add `--init` to follow its initial value too.

On a subscripted model, ask for an element (`causes model.flow 'Pop[North]'`) to
trace the lowered model with real signs; the bare vector name gives the
structure with `?` signs, since `births[region]` has no value until it is
lowered. MCP: `flow_causes`, `flow_uses`, `flow_document`.

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
