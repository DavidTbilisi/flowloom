// Tutorial 07 — performance: typed-array compilation, Web Worker, WASM backend.
export default {
  num: "07",
  slug: "scale",
  title: "Scale — typed arrays, Web Worker, WASM",
  voice: "en-US-AriaNeural",
  rate: "-2%",
  viewport: { width: 1440, height: 810 },
  url: "http://localhost:5174/",
  segments: [
    {
      text: "flowloom is built to stay fast, even on big models. Let's load a richer one — an SIR epidemic — and run it.",
      do: async (page, h) => { await h.example("SIR epidemic"); await h.run(); },
    },
    {
      text: "There's no eval anywhere. Every expression compiles down to slots in a single reused typed array, so each simulation step is just tight arithmetic over numbers.",
      do: async () => {},
    },
    {
      text: "And very large models run off the main thread — in a Web Worker, with a generated WebAssembly backend doing the integration — so the interface never freezes while it computes.",
      do: async (page, h) => { await h.play(); },
    },
    {
      text: "That's why scrubbing, tuning, and Monte Carlo runs stay smooth: the heavy math is compiled and parallel, and the UI just reads the results.",
      do: async () => {},
    },
    {
      text: "Text in, fast simulation out — small models feel instant, and large ones still don't block.",
      do: async () => {},
    },
  ],
};
