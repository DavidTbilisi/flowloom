// Tutorial 09 — syntax: when to use what. Type-along that builds a draining
// tank, choosing each language construct and saying when to reach for it.
export default {
  num: "09",
  slug: "syntax",
  title: "Syntax — when to use what",
  voice: "en-US-AriaNeural",
  rate: "-2%",
  viewport: { width: 1440, height: 810 },
  url: "http://localhost:5174/",
  segments: [
    {
      text: "flowloom's language is small — just a handful of building blocks. The real skill is knowing which one to reach for. Let's build a draining tank and choose each piece.",
      do: async (page, h) => { await h.clearEditor(); },
    },
    {
      text: "If something accumulates — it has memory and changes only through its rate — it's a stock. Water in a tank, eighty liters to start.",
      do: async (page, h) => {
        await h.typeLines("# When to use what — a draining tank.\nstock Water [liters] = 80\n");
      },
    },
    {
      text: "A fixed number you set once and tune is a param. Here, a steady inflow of five liters per minute.",
      do: async (page, h) => { await h.typeLines("\nparam inflow = 5\n"); },
    },
    {
      text: "When a relationship is really just a curve — something you'd rather draw than derive — use a table. This one says draining rises with the water level, interpolating between the points.",
      do: async (page, h) => { await h.typeLines("\ntable drainCurve = (0,0) (40,4) (80,12)\n"); },
    },
    {
      text: "Anything else computed each step is an aux — a derived value, like the fill fraction. And a rate that fills or drains a stock is a flow: draining, read straight off the curve.",
      do: async (page, h) => { await h.typeLines("\naux fraction = Water / 80\nflow draining = drainCurve(Water)\n"); },
    },
    {
      text: "The change line is the net rate — inflow minus draining — and flowloom integrates it into the stock for you.",
      do: async (page, h) => { await h.typeLines("\nchange(Water) = inflow - draining\n"); },
    },
    {
      text: "Finally sim sets the step and method — RK4 for accuracy, Euler only for discrete periods — and plot picks the series. Run it, and the tank settles right where inflow balances draining.",
      do: async (page, h) => {
        await h.typeLines("\nsim dt=0.1 to=40 method=rk4\nplot Water, draining");
        await h.run();
      },
    },
    {
      text: "So: if it accumulates, stock; the speed it fills or drains, flow; a fixed knob, param; a drawn curve, table; everything else computed, aux. For shocks over time reach for step, pulse, or ramp; for lags, smooth and delay. Text in, dynamics out.",
      do: async () => {},
    },
  ],
};
