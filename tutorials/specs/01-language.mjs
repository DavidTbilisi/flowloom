// Tutorial 01 — the .flow language. Type-along: the model appears line by line
// as each construct is narrated, then we Run it and watch the S-curve.
export default {
  num: "01",
  slug: "language",
  title: "The .flow language",
  voice: "en-US-GuyNeural",
  rate: "-6%",
  viewport: { width: 1440, height: 810 },
  url: "http://localhost:5174/",
  segments: [
    {
      text: "Welcome to flowloom — a systems-thinking studio where the model is just plain text. Let's learn its language by building a population model from scratch.",
      do: async (page, h) => {
        await h.clearEditor();
      },
    },
    {
      text: "Everything starts with a stock — an accumulation that builds up or drains over time. Here: Population, measured in people, starting at five.",
      do: async (page, h) => {
        await h.typeLines(
          "# Logistic growth — a population approaching its carrying capacity.\nstock Population [people] = 5\n",
        );
      },
    },
    {
      text: "Params are the constants you can tune: an intrinsic birth rate, and a carrying capacity — the ceiling the population cannot exceed.",
      do: async (page, h) => {
        await h.typeLines("\nparam birthRate = 0.7\nparam carrying  = 1000\n");
      },
    },
    {
      text: "A flow is a rate of change. Growth rises with the birth rate and the current population, but fades as the population nears the carrying capacity.",
      do: async (page, h) => {
        await h.typeLines("\nflow growth = birthRate * Population * (1 - Population / carrying)\n");
      },
    },
    {
      text: "The change line wires the flow into the stock: Population accumulates growth, step by step.",
      do: async (page, h) => {
        await h.typeLines("\nchange(Population) = growth\n");
      },
    },
    {
      text: "Finally, sim sets the time step and the integration method — here, fourth-order Runge-Kutta — and plot chooses what to chart.",
      do: async (page, h) => {
        await h.typeLines("\nsim dt=0.1 to=25 method=rk4\nplot Population");
      },
    },
    {
      text: "Now press Run. flowloom simulates the model with a safe interpreter — no eval — and out comes the classic S-curve of logistic growth.",
      do: async (page, h) => {
        await h.run();
        await h.pause(400);
      },
    },
    {
      text: "That is the whole core language: stock, param, flow, change. You write the text; flowloom derives the plot, the causal diagram, and the feedback loops. Text in, dynamics out.",
      do: async () => {},
    },
  ],
};
