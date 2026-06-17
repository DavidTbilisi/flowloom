# flowloom

**Text-first system dynamics in the browser.** Stocks, flows, and feedback loops —
a Vensim-style stock-and-flow simulator, but the model is *plain text* instead of a
hand-drawn diagram. The diagram is generated *from* the text.

Open `index.html`. No build step, no server, no dependencies. It runs from `file://`.

```
stock Population = 5
param birthRate = 0.7
param carrying  = 1000
flow growth = birthRate * Population * (1 - Population / carrying)
d(Population) = growth
```
→ Run → an S-curve.

## Why text-first

A stock-and-flow diagram is the *worst* representation for a machine (or an LLM) to
read or edit — meaning is encoded in pixel positions and arrow wiring. The same model
as text is the *best*: an AI can add a stock, retune a loop, or explain the dynamics by
editing lines. flowloom keeps the text canonical and *derives* the picture.

## The format

Every line is one of these. Comments start with `#`.

| line | meaning |
|---|---|
| `stock NAME = EXPR` | an accumulator (an integral). EXPR is its initial value. |
| `d(NAME) = EXPR` | the net rate of change of a stock — literally `dNAME/dt`. **The engine.** |
| `flow NAME = EXPR` | a named rate; same as `aux` but drawn as a flow on the diagram. |
| `aux NAME = EXPR` | an instantaneous computed value (a converter). |
| `param NAME = EXPR` | a constant knob. |
| `sim dt=0.1 to=50 method=rk4` | simulation settings (optional). |
| `plot A B C` | which series start visible (optional). |

### Expressions
Standard math (`+ - * / **`, and `^` is treated as power), the time variable `t`, and:
`min max exp log log10 sqrt pow abs sin cos tan floor ceil round sign`,
plus `IF(cond, a, b)` and `clamp(x, lo, hi)`, constants `PI E`.

Aux/flow equations may reference stocks, params, and each other — but **no algebraic
loops** (a flow can't instantaneously depend on itself; route it through a stock).

### The one idea
A stock is the running integral of its net flow:

```
stock(t+dt) = stock(t) + dt · d(stock)
```

You write the derivative; flowloom integrates it (Euler or RK4). That single update rule
*is* the whole simulation engine — everything else is editor, plot, and diagram.

## Examples
In `examples/` and in the in-app dropdown: logistic growth, Lotka–Volterra predator–prey,
SIR epidemic, compound savings, Newton's-law cooling. Each is a `.flow` text file.

## Keyboard
- **⌘/Ctrl + Enter** — run
- Tabs: Plot · Diagram · Table · Loops · Format
- On the **Diagram** tab, hover a loop chip to trace that loop and read its R/B label.

## Roadmap
- [x] R/B loop polarity auto-detection and labeling (Loops tab)
- [x] causal-graph diagram with interactive loop overlay (Diagram tab)
- [ ] save/load `.flow` files (drag-drop) and shareable URL state
- [ ] a `flowloom` CLI (`flowloom run model.flow --csv`) sharing the same parser

## License
MIT (see LICENSE).
