// Tutorial 06 — graphical lookup tables & material delays.
export default {
  num: "06",
  slug: "tables-delays",
  title: "Lookup tables & delays",
  voice: "en-US-AriaNeural",
  rate: "-2%",
  viewport: { width: 1440, height: 810 },
  url: "http://localhost:5174/",
  segments: [
    {
      text: "Not every relationship is a tidy equation. Sometimes you just have a curve. flowloom's lookup tables let you draw one. Let's load the bathtub-and-lookup example.",
      do: async (page, h) => { await h.example("Bathtub + lookup"); await h.run(); },
    },
    {
      text: "A table maps an input to an output through a set of points — a nonlinear response you can shape by hand, no formula required, and the simulation interpolates between them.",
      do: async (page, h) => { await h.tab("Table"); },
    },
    {
      text: "The other half of realism is time. Things don't arrive instantly — orders, shipments, information all lag. Let's load the inventory-and-delay example.",
      do: async (page, h) => { await h.example("Inventory + delay"); await h.run(); },
    },
    {
      text: "flowloom has first- and third-order delays — delay1 and delay3 — plus smoothing. delay3 models a realistic pipeline, where a change at the input shows up gently, spread out over time, at the output.",
      do: async (page, h) => { await h.tab("Plot"); await h.play(); },
    },
    {
      text: "Lookups for nonlinear shape, delays for lag. Together they turn a toy model into one that behaves like the real world.",
      do: async () => {},
    },
  ],
};
