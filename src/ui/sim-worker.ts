// ── Simulation worker ───────────────────────────────────────────────────────
// Runs large simulations off the main thread so the UI stays responsive. This
// is possible precisely because src/engine and src/lang are DOM-free — the same
// code runs here, in tests, and on the main thread. Inside the worker the engine
// uses the WASM backend (via simulateAsync) for the heavy arithmetic.
//
// SimResult contains a Map and number[]s, all of which structured-clone cleanly
// across postMessage, so no manual serialization is needed.

import { parseModel } from "../lang/index.js";
import { simulateAsync, analyzeLoops } from "../engine/index.js";

interface Req { gen: number; source: string }

self.onmessage = async (e: MessageEvent<Req>) => {
  const { gen, source } = e.data;
  try {
    const model = parseModel(source);
    // Both the simulation and the loop analysis are heavy on large models, so
    // run both here, off the main thread. LoopReport is plain data (structured-
    // cloneable), so it crosses postMessage without serialization.
    const result = await simulateAsync(model);
    const loops = analyzeLoops(model);
    (self as unknown as Worker).postMessage({ gen, ok: true, result, loops });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    (self as unknown as Worker).postMessage({ gen, ok: false, error: message });
  }
};
