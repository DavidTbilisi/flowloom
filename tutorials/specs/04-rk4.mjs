// Tutorial 04 — Euler vs RK4: why the integration method matters.
export default {
  num: "04",
  slug: "rk4",
  title: "Euler vs RK4 — why integration matters",
  voice: "en-US-AriaNeural",
  rate: "-2%",
  viewport: { width: 1440, height: 810 },
  url: "http://localhost:5174/",
  segments: [
    {
      text: "A simulator is only as trustworthy as its math. Let's see why flowloom defaults to fourth-order Runge–Kutta. Here's the predator–prey model, running cleanly.",
      do: async (page, h) => { await h.example("Predator–prey"); await h.run(); },
    },
    {
      text: "Now switch the method to Euler and push the time step up. Watch the orbits drift and balloon — that's numerical error, not real dynamics.",
      do: async (page, h) => { await h.setDt(0.4); await h.method("euler"); },
    },
    {
      text: "Switch back to RK4 at the very same step, and the orbits settle into the stable cycle the model actually describes.",
      do: async (page, h) => { await h.method("rk4"); },
    },
    {
      text: "RK4 samples the slope four times per step instead of once, so it tracks the curvature that Euler misses — far more accuracy for the same time step.",
      do: async () => {},
    },
    {
      text: "So when an AI writes a model here, you don't trust it — you run it, and the numbers are real. Validate, don't vibe.",
      do: async () => {},
    },
  ],
};
