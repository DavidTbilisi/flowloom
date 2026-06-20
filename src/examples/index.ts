// ── Built-in example models ─────────────────────────────────────────────────
// Embedded so the app runs with zero network and so the examples double as a
// living tour of the language. Keep these readable: they teach the format.

export interface Example {
  name: string;
  blurb: string;
  source: string;
}

export const EXAMPLES: Example[] = [
  {
    name: "Logistic growth",
    blurb: "Reinforcing growth braked by a balancing limit — the canonical limits-to-growth S-curve.",
    source: `# Logistic growth — a population approaching its carrying capacity.
# A reinforcing loop (growth) braked by a balancing loop that tightens
# as the stock nears the ceiling.
stock Population [people] = 5

param birthRate = 0.7      # intrinsic growth rate
param carrying  = 1000     # carrying capacity (the ceiling)

flow growth = birthRate * Population * (1 - Population / carrying)

change(Population) = growth

sim dt=0.1 to=25 method=rk4
plot Population`,
  },
  {
    name: "Predator–prey",
    blurb: "Lotka–Volterra: two coupled stocks oscillate forever.",
    source: `# Lotka–Volterra — two coupled stocks oscillate forever.
# Prey grow on their own; predators eat prey; predators starve without prey.
stock Prey      = 40
stock Predators = 9

param preyGrowth     = 0.6    # prey birth rate
param predation      = 0.02   # kills per predator-prey encounter
param predDeath      = 0.5    # predator death rate
param predEfficiency = 0.01   # prey eaten -> new predators

flow births   = preyGrowth * Prey
flow kills    = predation * Prey * Predators
flow predGain = predEfficiency * Prey * Predators
flow predLoss = predDeath * Predators

change(Prey)      = births - kills
change(Predators) = predGain - predLoss

sim dt=0.05 to=60 method=rk4
plot Prey Predators`,
  },
  {
    name: "SIR epidemic",
    blurb: "Susceptible → Infected → Recovered. A reinforcing spread loop meets balancing recovery.",
    source: `# SIR — Susceptible -> Infected -> Recovered.
# beta drives the reinforcing spread loop; gamma is the balancing recovery.
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
plot S I R`,
  },
  {
    name: "Coffee cooling",
    blurb: "Newton's law of cooling — a single balancing loop seeking room temperature.",
    source: `# Newton's law of cooling — a single balancing loop.
# The bigger the gap to room temperature, the faster heat leaves.
stock Temp [degC] = 90

param room = 20        # ambient temperature
param k    = 0.3       # cooling constant

flow cooling = k * (Temp - room)

change(Temp) = -cooling

sim dt=0.1 to=20 method=rk4
plot Temp`,
  },
  {
    name: "Compound savings",
    blurb: "A reinforcing interest loop plus a steady deposit.",
    source: `# Compound savings — a reinforcing interest loop plus a steady deposit.
stock Balance [USD] = 1000

param rate    = 0.05    # interest per period
param deposit = 200     # added each period

flow interest = rate * Balance
flow saving   = deposit

change(Balance) = interest + saving

sim dt=1 to=40 method=euler
plot Balance`,
  },
  {
    name: "Inventory + delay",
    blurb: "A supply line with a third-order acquisition delay chasing a sales step — shows DELAY3.",
    source: `# Inventory control with an acquisition delay.
# Orders take time to arrive (DELAY3). A step up in sales at t=10 forces
# the stock to hunt for its target, overshooting because of the pipeline delay.
stock Inventory [units] = 200

param target     = 200    # desired inventory
param adjustTime = 4      # how fast we correct the gap
param leadTime   = 6      # acquisition delay (periods)

aux  sales      = 20 + step(10, 10)         # baseline 20, +10 step at t=10
aux  gap        = target - Inventory
aux  orders     = max(0, sales + gap / adjustTime)
flow receiving  = delay3(orders, leadTime)  # orders arrive after a 3rd-order delay

change(Inventory) = receiving - sales

sim dt=0.25 to=60 method=rk4
plot Inventory sales receiving`,
  },
  {
    name: "Bathtub + lookup",
    blurb: "A graphical (table) function shapes the drain — demonstrates lookups and tables.",
    source: `# A bathtub whose drain rate is a nonlinear function of water depth,
# defined by a graphical lookup table.
stock Water [L] = 80

param inflow = 5

table drainCurve = (0,0) (20,2) (40,5) (60,9) (80,14) (100,20)

flow draining = drainCurve(Water)

change(Water) = inflow - draining

sim dt=0.1 to=40 method=rk4
plot Water draining`,
  },
  {
    name: "Cashflow: escaping the Rat Race",
    blurb: "The CASHFLOW game's money system — a reinforcing wealth Engine racing the balancing lifestyle-creep Trap.",
    source: `# Cashflow — escaping the Rat Race.
# The personal-finance system the CASHFLOW game teaches, drawn as stocks & flows.
# Seed numbers are the game's "Engineer" profession.
#
# Two loops fight here:
#   R  the Engine  — invest surplus -> Assets -> passive income -> more surplus
#   B  the Trap    — lifestyle creep: expenses chase income, draining the surplus
# You leave the Rat Race when passive income alone covers your expenses.
stock Cash     [USD] = 2540    # starting cash = monthly cash flow + savings
stock Assets   [USD] = 0       # invested capital — "the Engine"
stock Expenses [USD] = 2760    # monthly expenses; creeps up as income rises

param salary   [USD] = 4900    # earned (E-quadrant) income, fixed
param yield          = 0.02    # monthly cash-on-cash return on invested assets
param invest         = 0.6     # share of free cash put to work each month
param buffer   [USD] = 2000    # cash kept on hand before investing
param creep          = 0.015   # how fast lifestyle expenses chase income
param creepCap       = 0.7     # expenses drift toward this fraction of income

flow passive   [USD] = yield * Assets              # passive income from the Engine
aux  income    [USD] = salary + passive            # total monthly income
flow surplus   [USD] = income - Expenses           # monthly cash flow
flow investing [USD] = invest * max(0, Cash - buffer)   # cash swept into Assets

change(Cash)     = surplus - investing
change(Assets)   = investing
change(Expenses) = creep * (creepCap * income - Expenses)    # the Rat Race trap

aux freedom = passive - Expenses    # crosses 0 when you escape the Rat Race

sim dt=0.25 to=180 method=rk4
plot Assets passive Expenses freedom`,
  },
  {
    name: "Noisy savings (stochastic)",
    blurb: "A balance with a noisy monthly return — press ⤳ Monte Carlo (under Plot) to see the spread of outcomes.",
    source: `# Noisy savings — compound returns with month-to-month volatility.
# The return each step is a mean plus a Gaussian shock (random_normal).
# Seeded, so the run is reproducible; the Monte Carlo button (under the Plot
# tab) runs many seeds at once and shades the p05–p95 band.
stock Balance [USD] = 1000

param ret = 0.04           # mean monthly return
param vol = 0.03           # volatility — standard deviation of the shock

flow gain = Balance * (ret + random_normal(0, vol))

change(Balance) = gain

sim dt=1 to=60 seed=1
plot Balance`,
  },
  {
    name: "Calibration demo",
    blurb: "Fit a param to data: Load data (examples/calibration-demo.csv), then ◎ Calibrate to recover the growth rate.",
    source: `# Calibration demo — the growth rate starts deliberately wrong.
# Under the Plot tab: 📊 Load data → examples/calibration-demo.csv (a column
# 'N' of observations), then ◎ Calibrate. flowloom fits 'r' (least normalised
# RMSE) and writes the value back into this text — you'll see r jump to ~0.15.
stock N [units] = 10

param r = 0.05             # start wrong; Calibrate recovers it from the data

flow growth = r * N

change(N) = growth

sim dt=1 to=20
plot N`,
  },
];

export const DEFAULT_EXAMPLE = EXAMPLES[0]!;
