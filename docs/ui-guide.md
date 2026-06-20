# Using the studio

flowloom is built so you can learn it *while* using it. Three things make the
studio approachable: a syntax-highlighted editor, a contextual-help bar, and
guided learning. None of them change the model — the text stays canonical.

## The editor

The model editor highlights the `.flow` syntax as you type: **line keywords**
(`stock`, `flow`, `d`, `param`, …) in blue, **builtin functions** and constants
in cyan, **numbers** in amber, and **comments** dimmed. Highlighting is purely a
view over the textarea — what you edit and what runs is always the plain text.

## The help bar (hover anything)

A thin bar is pinned to the bottom of the window. **Move the mouse over almost
anything and it explains what you're looking at**, in one line:

- a keyword or function in the editor — what the line/call does;
- an **identifier** in the editor or a node in the diagram — its kind, unit, doc
  comment, and its **value at the current playback frame** (read live from the
  model, so it's always correct);
- a toolbar control, a tab, an **R**/**B** badge, the legend, the transport.

When a richer explanation exists, a **Learn more ›** link jumps to the **Format**
reference. When you're not hovering anything, the bar rotates a few tips.

## Plot overlays (under the Plot tab)

A row of controls beneath the legend layers extra context onto the time-series
plot — none of it changes the canonical run:

- **Monte Carlo** — for a model using `random*()`, runs N seeded simulations and
  shades a **p05–p95 percentile band** (with the median) behind each visible
  series. Re-running the model clears the bands (they belong to the old run).
- **Load data** — overlay an observed **CSV/TSV** series (a time column plus
  named columns) as hollow markers, to eyeball fit or to calibrate against.
- **Calibrate** — enabled once data is loaded: fits the model's params to the
  data (least normalised-RMSE) and **writes the fitted values back into the
  text**, keeping the model canonical. Tick/untick params to choose which to fit.
  Try the **Calibration demo** example with `examples/calibration-demo.csv`.
- **Compare** — overlay another `.flow` model's run as a **dashed** line, to see
  how two models differ on the same axes.
- **✕ overlays** — clear them all.

## Guided learning (the Learn button)

The **Learn** button (top-right) opens three kinds of guided help, all built on
one spotlight overlay:

- **Take the tour** — a quick coach-mark tour of the whole studio. It runs
  automatically the first time you open flowloom (once; dismiss with ✕).
- **Lessons** — *interactive* model-building. The lesson seeds a starter model
  and asks you to add a line; **Next stays disabled until your edit actually
  produces the right structure** (e.g. a reinforcing loop is detected). You
  build the model; flowloom checks your work against the live run.
- **Example walkthroughs** — pick any built-in model and step through it: read
  the equations, watch the behaviour, then see the feedback loops that cause it.

You can leave any guided session at any time — it never locks the studio, so you
can keep typing in the editor while a lesson waits for your edit.

## How it fits the architecture

All of this lives in the DOM-aware `src/ui` layer and is *derived from the model*
exactly like the diagram and plots:

- `highlight.ts` — a tolerant, lossless tokenizer (pure, unit-tested) that paints
  the overlay and identifies the token under the mouse.
- `help-content.ts` — one help table keyed like the tokenizer, plus a resolver
  that builds identifier help straight from the parsed AST. A contract test keeps
  it in lock-step with the language (every keyword/builtin must have an entry).
- `statusbar.ts` — the bar and the single global hover delegation.
- `editor.ts` — the highlight overlay and token hit-testing.
- `tour.ts` / `tutorials.ts` — the guided-learning engine and its content.
