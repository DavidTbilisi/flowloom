// Tutorial 03 — the causal diagram & automatic feedback-loop detection.
export default {
  num: "03",
  slug: "diagram-loops",
  title: "Causal diagram & feedback loops",
  voice: "en-US-AriaNeural",
  rate: "-2%",
  viewport: { width: 1440, height: 810 },
  url: "http://localhost:5174/",
  segments: [
    {
      text: "flowloom doesn't only plot numbers — it draws the structure behind them. Let's load the predator–prey model and run it.",
      do: async (page, h) => { await h.example("Predator–prey"); await h.run(); },
    },
    {
      text: "The plot shows the classic oscillation: predators and prey chasing each other in endless cycles. Press play to watch it move.",
      do: async (page, h) => { await h.tab("Plot"); await h.play(); },
    },
    {
      text: "Now click Diagram. flowloom lays out the causal structure automatically, straight from the text — stocks, flows, and the links between them.",
      do: async (page, h) => { await h.tab("Diagram"); },
    },
    {
      text: "Open Loops, and flowloom finds the feedback loops by itself, labelling each one: reinforcing loops that amplify, balancing loops that rein things in.",
      do: async (page, h) => { await h.tab("Loops"); },
    },
    {
      text: "This is the payoff of text-first modeling: the diagram and the loops are derived, never hand-drawn — so they can never drift from what actually runs.",
      do: async () => {},
    },
    {
      text: "Plot for behavior, Diagram for structure, Loops for the why. One model, three lenses.",
      do: async () => {},
    },
  ],
};
