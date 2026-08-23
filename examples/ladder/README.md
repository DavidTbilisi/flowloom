# flowloom example ladder — small → most complex

A graded set of `.flow` models, each adding **one new idea** on top of the last.
Every model is validated (`flowloom check` + `run`). Work top to bottom.

| # | File | Concept it adds | Shape |
|---|---|---|---|
| **Tier 1 — pure accumulation** |||
| 01 | `01-bathtub.flow` | a stock is an integral; constant net flow | 1 stock, 0 loops |
| 02 | `02-exponential-decay.flow` | outflow ∝ stock → decay (first balancing loop) | 1 stock, 1 loop |
| 03 | `03-exponential-growth.flow` | inflow ∝ stock → compounding (reinforcing loop) | 1 stock, 1 loop |
| **Tier 2 — one feedback loop** |||
| 04 | `04-goal-seeking.flow` | rate driven by a gap to a target | 1 stock |
| 05 | `05-logistic-growth.flow` | reinforcing + balancing in one structure (ceiling) | 1 stock |
| **Tier 3 — coupled stocks** |||
| 06 | `06-two-tanks.flow` | chaining stocks (one's outflow is another's inflow) | 2 stocks |
| 07 | `07-predator-prey.flow` | coupled oscillation (Lotka–Volterra) | 2 stocks, 5 loops |
| 08 | `08-sir-epidemic.flow` | a 3-stock flow-through chain | 3 stocks |
| **Tier 4 — realism: inputs, tables, delays** |||
| 09 | `09-test-inputs.flow` | `step` / `pulse` / `ramp` external drivers | 1 stock |
| 10 | `10-lookup-table.flow` | a nonlinear `table` you draw, not derive | 1 stock |
| 11 | `11-material-delay.flow` | `delay3` pipeline lag (source of overshoot) | 1 stock |
| **Tier 5 — multi-loop & structure** |||
| 12 | `12-bass-diffusion.flow` | two adoption loops + saturation | 2 stocks |
| 13 | `13-seir-epidemic.flow` | a longer 4-stock chain (adds Exposed) | 4 stocks |
| 14 | `14-supply-chain.flow` | ordering policy + delay → bullwhip | 2 stocks |
| 15 | `15-regions-subscripts.flow` | `dim` arrays, elementwise eqns, `sum()` | array |
| 16 | `16-startup-capstone.flow` | reinforcing + balancing + table + delay together | 3 stocks, 9 loops |

## Run / open one

```bash
# from the flowloom repo root
node dist-cli/cli.js run   examples/ladder/05-logistic-growth.flow   # simulate, print a table
node dist-cli/cli.js check examples/ladder/05-logistic-growth.flow   # parse + structure summary
node dist-cli/cli.js loops examples/ladder/07-predator-prey.flow     # list feedback loops
```

In the web app: paste the file's text into the editor (or **Import**), then **Run** —
the plot, causal **Diagram**, and **Loops** are all derived from the text.

> Companion video tutorials live in `../../tutorials/out/` (language, run,
> diagram+loops, RK4, inputs, tables/delays, scale, AI/MCP, and a syntax
> "when to use what" walkthrough).
