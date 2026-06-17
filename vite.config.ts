import { defineConfig } from "vite";

// flowloom is a static browser app — no backend required for the core studio.
// The engine (src/lang, src/engine) is framework-free pure TS so it can also run
// in Node (tests, a future CLI) and be embedded anywhere.
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
  },
  // the simulation worker dynamically imports the WASM backend (code-splitting),
  // which requires the ES module worker format.
  worker: {
    format: "es",
  },
});
