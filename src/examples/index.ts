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
    name: "Regions (array / subscripts)",
    blurb: "Three regions as one subscripted stock — elementwise growth coupled through a shared sum(Population).",
    source: `# Subscripts — model many similar things as one array.
# 'dim' declares a dimension; Population[region] is one stock per element.
# Equations are elementwise; sum(Population) collapses the dimension to a scalar.
dim region = North, South, East

stock Population[region] = 1000

param birthRate = 0.03
param crowding  = 0.0001    # deaths rise with TOTAL population (shared limit)

flow births[region] = birthRate * Population[region]
flow deaths[region] = crowding * Population[region] * sum(Population)

change(Population[region]) = births[region] - deaths[region]

aux Total = sum(Population)

sim dt=0.25 to=60 method=rk4
plot Population Total`,
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
  {
    name: "Family budget (Meadows ladder)",
    blurb: "Twelve leverage points on one household budget — each rung a scenario, each policy a switch, the statement lag a fixed delay. Pick a rung under Plot ▣ Scenario; compare tabulates them all.",
    source: `# Family budget — Donella Meadows' twelve leverage points, one household move each.
# A discrete monthly map (euler, dt=1): Cash(t+1) = Cash(t) + change. Needs drift up
# toward a cap; Wants creep toward a share of pay whenever the balance *feels* comfortable
# and a weak monthly review pulls them back — but the review reads the card statement,
# which arrives two months late (delay_fixed). A shock calendar repeats every three years.
#
# Each rung of the ladder is a scenario (rung12 … rung2; rung 1 — hold the model
# loosely — changes nothing and has no line); each yes/no move is a switch. Two more
# scenarios are real households: measured (a June-2026 calibration) and recovery
# (the same family on a contracting→FTE income plan).
#   ▣ Scenario (under Plot) runs one against the dashed base;
#   flowloom compare <file> --metric final:Cash,min:Cash,final:MonthsInDebt   tabulates them all;
#   flowloom sensitivity <file> --metric min:Cash                             ranks the switches.
# Monthly amounts are [GEL/month]; where a month's amount lands on a [GEL] balance it is
# multiplied by dt (= 1 month), so the units check passes for the right reason.
# The teaching baseline is invented; the measured scenario's income, opening balance and
# target are measured, its loop constants are still assumptions.

# ── knobs ──────────────────────────────────────────────────────────────────────
param income      [GEL/month] = 6400     # take-home pay at t=0
param growth                  = 0.02     # annual raise, compounded monthly
param needsItems  [GEL/month] = 3492     # the line items that always bite
param needsCap    [GEL/month] = 4000     # the Needs ceiling; headroom = cap - items
param capFill                 = 0.5      # how much of the headroom gets spent anyway
param wants       [GEL/month] = 1805     # @rung 12 the Wants level at t=0, and what the review pulls toward
param savingsLine [GEL/month] = 1600     # @rung 10 the Safe transfer when separate is on
param delay       [month]     = 2        # @rung 9 statement lag: the review reads Cash this many months old (0 = live balance)
param creepRate               = 0.03     # @rung 6 Wants drift toward creepCap×income at this fraction of the gap per month …
param creepCap                = 0.45     # … but only while the felt balance is above the cushion
param cushion     [GEL]       = 2500    # @rung 6
param impulseScale            = 1        # @rung 6 scales the impulse buys (450 / 300 / 180)
param k                       = 0.1      # @rung 8 review-loop gain
param target      [GEL]       = 8000     # @rung 3 the reserve the review loop wants to see
param debtRate                = 0.025    # @rung 7 monthly card interest below zero
param depRate                 = 0.005    # @rung 7 monthly deposit interest above zero
param cash0       [GEL]       = 1500     # Cash at t=0
param bufferMonths            = 3        # @rung 11 bufferFirst: no vacation until Cash ≥ bufferMonths × needsCap
param plateFloor              = 0.85     # @rung 10 separate: Wants can't be squeezed below this share of (wants + impulse)
param sideAmount  [GEL/month] = 600      # @rung 4 sideIncome: the second Door, ramping up from sideStart …
param sideRamp    [GEL/month] = 50       # @rung 4 … by this much per month
param sideStart   [month]     = 10    # @rung 4
const yearLen     [month]     = 12       # the calendar, not a knob
param vacationCost [GEL]      = 4500     # once a year, month 11 of each year
param shockScale              = 1        # scales the spend shocks (car 1400 · fridge 900 · dentist 600)
param enough      [GEL/month] = 1500     # @rung 2 enoughOn: Wants pinned here, creep and review switched off

# ── policy switches (one per rung that is a yes/no move) ───────────────────────
switch separate     = off      # @rung 10 rung 10 — pay the Safe first at another bank; spend from what's left
switch rule48       = off      # @rung 5 rung 5  — 48-hour rule: an impulse over 200 shrinks to 30 %
switch ruleCarry    = off      # @rung 5 rung 5  — last month's overrun comes off this month's Wants
switch sideIncome   = off      # @rung 4 rung 4  — a second Door / the career ladder
switch bufferFirst  = off      # @rung 11 rung 11 — keep the headroom; vacation waits for the buffer
switch vacation     = on       # the annual 4,500 trip happens at all
switch vacationWaits = off     # @rung 3 rung 3  — vacation waits until Cash ≥ target
switch gapOn        = on       # the two-month income gap (months 16–17) happens
switch recovery     = off      # income follows the recovery plan instead of income×growth
switch enoughOn     = off      # @rung 2 rung 2  — "enough": Wants pinned at enough

# ── stocks ─────────────────────────────────────────────────────────────────────
stock Cash         [GEL]       = cash0
stock Level        [GEL/month] = wants         # the Wants level — it ratchets
stock MonthsInDebt             = 0
stock DebtPeak     [GEL]       = 0             # deepest the Safe went (as a positive number)
stock InterestPaid [GEL]       = 0
stock Earned       [GEL]       = 0
stock Vacations                = 0

# ── calendar: seasonal needs, impulse buys, shocks repeating every 36 months ───
table pattern = (0,40) (1,-30) (2,110) (3,-60) (4,20) (5,90) (6,-20) (7,150) (8,-40) (9,60) (10,130) (11,-10)
aux month  = t % yearLen
aux cycle  = t % 36
aux needsVar [GEL/month] = round(150 * cos(2 * PI * t / yearLen) + pattern(month))
aux impulseRaw [GEL/month] = if(t % 9 == 5, 450, if(t % 4 == 2, 300, if(t % 7 == 3, 180, 0))) * impulseScale
aux impulse    [GEL/month] = if(rule48 && impulseRaw > 200, 0.3 * impulseRaw, impulseRaw)
aux shockSpend [GEL/month] = if(cycle == 7, 1400, if(cycle == 25, 900, if(cycle == 31, 600, 0))) * shockScale
aux incomeMul = if(gapOn && (cycle == 16 || cycle == 17), 0, 1)

# ── income: plain growth, or the recovery plan (USD → GEL at a strengthening fx, net of 1 % tax)
aux raise = (1 + growth) ^ (t / 12)
aux fx = 2.70 - 0.30 * min(1, max(0, (t - 12) / 12))
aux mission [USD/month] = if(t < 10, 1500, 0)
aux trackA  [USD/month] = 600 * min(5, max(0, t - 2)) - if(t >= 10, 1500, 0)
aux trackB  [USD/month] = if(t >= 10, 5500 + 3000 * min(1, (t - 10) / 26), 0)
aux recoveryGEL [GEL/month] = (mission + trackA + trackB) * fx * 0.99
aux side [GEL/month] = if(sideIncome && t >= sideStart, min(sideAmount, sideRamp * (t - sideStart + dt) / dt) * raise, 0)
aux pay  [GEL/month] = if(recovery, recoveryGEL, income * raise) * incomeMul + side

# ── needs ──────────────────────────────────────────────────────────────────────
aux headroom [GEL/month] = needsCap - needsItems
aux needs [GEL/month] = needsItems + needsVar + if(bufferFirst, 0, capFill * max(0, headroom - needsVar)) + shockSpend

# ── wants: creep feels today's balance; the review reads the lagged statement ──
aux base [GEL/month] = if(enoughOn, enough, wants)
aux seen [GEL] = if(delay > 0, delay_fixed(Cash, max(delay, 1)), Cash)
aux perceived [GEL] = if(separate, max(0, pay - savingsLine - needs) * dt, Cash)
aux creep  [GEL/month] = if(enoughOn, 0, if(perceived > cushion, creepRate * (creepCap * pay - Level), 0))
aux afterCreep [GEL/month] = Level + creep
aux shortfall = min(1, max(0, target - seen) / target)
aux review [GEL/month] = if(enoughOn, 0, if(shortfall > 0, k * (base * (1 - 0.35 * shortfall) - afterCreep), 0))
aux levelNow [GEL/month] = if(enoughOn, enough, afterCreep + review)
change(Level) = (levelNow - Level) / dt

aux carry [GEL/month] = previous(max(0, wantsFinal - base), 0)      # last month's overrun
aux wantsAsk [GEL/month] = levelNow + impulse - if(ruleCarry, min(carry, 0.5 * base), 0)

# ── the two plumbings: one account, or Safe first ──────────────────────────────
aux spendable [GEL/month] = pay - savingsLine - needs
aux wantsFinal [GEL/month] = if(separate, max(min(wantsAsk, spendable), plateFloor * (base + impulse)), wantsAsk)
aux overrun [GEL/month] = max(0, wantsFinal - spendable)
flow save [GEL/month] = if(separate, savingsLine, pay - needs - wantsFinal)
aux afterMonth [GEL] = Cash + if(separate, save + max(0, spendable - wantsFinal) - overrun, save) * dt

# ── the annual vacation, gated by the buffer and the goal ──────────────────────
aux bufferOK = !bufferFirst || afterMonth >= bufferMonths * needsCap
aux goalOK   = !vacationWaits || afterMonth >= target
aux tripNow  = vacation && month == 11 && bufferOK && goalOK
aux afterTrip [GEL] = afterMonth - if(tripNow, vacationCost, 0)

# ── interest on both sides of zero ─────────────────────────────────────────────
flow interest [GEL/month] = if(afterTrip < 0, afterTrip * debtRate, afterTrip * depRate)
aux next [GEL] = afterTrip + interest * dt
change(Cash) = (next - Cash) / dt

change(MonthsInDebt) = if(afterTrip < 0, 1, 0)
change(DebtPeak)     = max(0, -next - DebtPeak) / dt
change(InterestPaid) = max(0, -interest)
change(Earned)       = max(0, interest)
change(Vacations)    = if(tripNow, 1, 0)

# ── the twelve, one move each (rung 1, hold it loosely, changes nothing) ───────
scenario rung12_trim      wants=1705                         # @rung 12 a number: the cafe line
scenario rung11_buffer    bufferFirst=on                     # @rung 11 keep the 508 headroom
scenario rung10_separate  separate=on                        # @rung 10 pay the Safe first (Profit First)
scenario rung9_live       delay=0                            # @rung 9 read the live balance, not the statement
scenario rung8_review     k=0.5                              # @rung 8 a stronger review loop
scenario rung7_rates      debtRate=0.008 depRate=0.009       # @rung 7 cheaper card, better deposit
scenario rung6_fridge     creepRate=0.004 impulseScale=0.5   # @rung 6 category totals on the fridge
scenario rung5_rules      rule48=on ruleCarry=on             # @rung 5 two house rules
scenario rung4_door       sideIncome=on                      # @rung 4 a second Door
scenario rung3_goal       target=48000 vacationWaits=on      # @rung 3 the runway goal; vacations wait
scenario rung2_enough     enoughOn=on impulseScale=0.5       # @rung 2 "enough"

# ── the households from the page ───────────────────────────────────────────────
scenario measured  income=4485 growth=0 cash0=10800 capFill=1 creepRate=0.05 creepCap=0.40 bufferFirst=on bufferMonths=4 target=16000
scenario recovery  income=4485 growth=0 cash0=10800 capFill=1 creepRate=0.05 creepCap=0.10 bufferFirst=on bufferMonths=4 target=23000 recovery=on gapOn=off

sim dt=1 to=36 method=euler timeunit=month
plot Cash wantsFinal needs pay`,
  },
  {
    name: "Causal-loop sketch (no equations)",
    blurb: "A city drawn as signed links only — the first hour of any new model. It draws and has R/B loops; it does not run until a stock gets a change().",
    source: `# A causal-loop sketch of a growing city — links only, no equations yet.
# link A -> B +  means B moves with A;  -  means against. This is the picture
# you draw before you know the numbers: flowloom finds the loops and labels them
# R/B from the declared signs. To make it run, give it a stock and a change():
#   stock population = 10000
#   change(population) = births - deaths + migration
# and replace links with equations as you learn them (a link that duplicates an
# equation dependency is flagged by lint).
link population -> births +
link births -> population +
link population -> deaths +
link deaths -> population -
link population -> crowding +
link crowding -> attractiveness -
link attractiveness -> migration +
link migration -> population +`,
  },
];

export const DEFAULT_EXAMPLE = EXAMPLES[0]!;
