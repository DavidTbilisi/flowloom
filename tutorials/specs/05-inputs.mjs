// Tutorial 05 — test inputs: step, pulse, ramp.
const MODEL = `# Test inputs — step, pulse, and ramp drive a reservoir.
stock Level = 0                      # a stock the inputs flow into

aux stepIn  = step(8, 10)            # jumps from 0 to 8 at t = 10
aux pulseIn = 6 * pulse(25, 4)       # a kick of height 6 for 4 time units
aux rampIn  = ramp(0.4, 35, 55)      # a line of slope 0.4 from t = 35 to 55

change(Level) = stepIn + pulseIn + rampIn - 0.2 * Level

sim dt=0.1 to=60 method=rk4
plot stepIn, pulseIn, rampIn, Level`;

export default {
  num: "05",
  slug: "inputs",
  title: "Test inputs — step, pulse, ramp",
  voice: "en-US-AriaNeural",
  rate: "-2%",
  viewport: { width: 1440, height: 810 },
  url: "http://localhost:5174/",
  model: MODEL,
  segments: [
    {
      text: "Real systems get poked from the outside. flowloom has built-in test inputs to model those shocks. Let's plot three of them.",
      do: async (page, h) => { await h.clearEditor(); await h.setModel(MODEL); await h.run(); },
    },
    {
      text: "Step jumps from zero to a new level at a chosen time — a permanent change, like a price hike or a new policy switching on.",
      do: async () => {},
    },
    {
      text: "Pulse is a temporary kick: it rises for a fixed window, then drops back — a one-off shock, like a flash sale or a sudden outage.",
      do: async () => {},
    },
    {
      text: "And ramp climbs at a steady slope between two times, then holds — a gradual trend, like demand rising into a new season.",
      do: async () => {},
    },
    {
      text: "Drive any flow with these and you can stress-test a model: hit it with a step, a pulse, or a ramp, and watch how the loops absorb the shock.",
      do: async () => {},
    },
  ],
};
