# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

flowloom is a text-first system-dynamics simulator (Vensim-style stocks/flows/loops) that runs entirely in the browser. **The model is plain text; the diagram is derived from it.** See `README.md` for the user-facing `.flow` format and rationale.

## Running / testing

There is **no build, no server, no dependencies, no test suite**. Open `index.html` in a browser (works from `file://`). To verify a change, open the file and exercise the five example models via the in-app dropdown; the Logistic growth model loads and runs on boot.

## Architecture

The **entire application is `index.html`** — one file containing CSS, markup, and ~600 lines of vanilla JS in a single `<script>`. No modules, no framework. The pipeline is stated at the top of the script:

```
parse(text) -> compile exprs -> topo-sort aux -> integrate -> draw
```

Key stages (all in `index.html`):
- **`compile(expr)`** — turns an expression string into `f(scope)->number` via `new Function` with a non-strict `with(S){...}` body, so bare identifiers resolve against the scope object. `^` is rewritten to `**`. `FN` holds the built-in math functions/constants injected into every scope.
- **`parseModel(text)`** — line-oriented parser. Each line matches one regex for `stock` / `d(NAME)` / `flow|aux|param` / `sim` / `plot`. Produces `{stocks, rates, vars, ...}`. `claim()` enforces unique names. Then `topoSort` orders aux/flow/param vars by dependency and **throws on algebraic loops** (a flow can't instantaneously depend on itself).
- **`simulate(m, dt, to, method)`** — the engine. `deriv()` evaluates aux in topo order then the `d(stock)` rates; integration is Euler or RK4. Halts cleanly and sets `out.note` if a stock goes non-finite.
- **Feedback-loop analysis** — `influenceGraph` builds a signed edge graph by **numerically perturbing** each variable at the t=0 operating point (`operatingPoint`) and reading the sign of the response. `findLoops` enumerates simple cycles (capped at 200). `classifyLoop` labels R (reinforcing) / B (balancing) by parity of negative-sign edges, or `?` if any edge sign is ambiguous.
- **Rendering** — `drawPlot` (canvas), `drawDiagram`/`renderDiagramSVG` (SVG causal graph with hover-to-trace loop overlay), `drawLoops`, `drawTable`. `run()` ties it all together and routes errors to the `#err` panel.

Global mutable state: `LAST` (last sim output), `VISIBLE` (legend selection), `DIAGRAM`, `CURRENT_MODEL`.

## Gotchas when editing

- **Examples are duplicated.** The in-app dropdown reads the `EXAMPLES` object embedded near the bottom of the script (5 models, so it runs from `file://`). The `examples/*.flow` files are a separate copy and currently only cover 3 of them. Editing one does not update the other.
- **The semantic distinction between `flow` and `aux` is presentation-only** — both are non-state computed values evaluated in topo order; `flow` is merely drawn differently on the diagram.
- Loop polarity is read at the **initial state only**; nonlinear models can flip polarity as they evolve. This is intentional and noted in the UI.

## Roadmap (from README)

Not yet built: save/load `.flow` files + shareable URL state, and a `flowloom` CLI that shares the same parser. If you build the CLI, the parser/integrator in `index.html` is the reference implementation to factor out.
