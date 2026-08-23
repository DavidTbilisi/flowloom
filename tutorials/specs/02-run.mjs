// Tutorial 02 — running a model & reading the plot.
export default {
  num: "02",
  slug: "run",
  title: "Run a model & read the plot",
  voice: "en-US-AriaNeural",
  rate: "-2%",
  viewport: { width: 1440, height: 810 },
  url: "http://localhost:5174/",
  segments: [
    {
      text: "Once a model is written, the right side comes alive. Let's run this logistic growth model and read what flowloom shows.",
      do: async (page, h) => { await h.run(); },
    },
    {
      text: "The plot traces every stock over time — here, population climbing its S-curve toward the ceiling of one thousand.",
      do: async (page, h) => { await h.tab("Plot"); },
    },
    {
      text: "This timeline scrubs through the run. Press play, and the readouts update live as the model steps forward.",
      do: async (page, h) => { await h.play(); },
    },
    {
      text: "Up top you steer the simulation — the time step, the horizon, the integration method. Stretch the horizon to fifty, and it re-simulates instantly.",
      do: async (page, h) => { await h.setTo(50); await h.run(); },
    },
    {
      text: "And the Tune panel lets you drag any parameter and re-simulate on the spot — systems thinking you can feel.",
      do: async () => {},
    },
    {
      text: "Run, read, scrub, tune. The text stays canonical — even these controls edit it — so what you see is always what ran.",
      do: async () => {},
    },
  ],
};
