// ── Simulation worker ───────────────────────────────────────────────────────
// Runs large simulations off the main thread so the UI stays responsive. This
// is possible precisely because src/engine and src/lang are DOM-free — the same
// code runs here, in tests, and on the main thread. Inside the worker the engine
// uses the WASM backend (via simulateAsync) for the heavy arithmetic.
//
// SimResult contains a Map and number[]s, all of which structured-clone cleanly
// across postMessage, so no manual serialization is needed.

import { parseModel } from "../lang/index.js";
import { simulateAsync, analyzeLoops, monteCarlo } from "../engine/index.js";

interface RunReq { gen: number; source: string }
interface EnsembleReq { kind: "ensemble"; reqId: number; source: string; runs: number; seed?: number; series?: string[] }

self.onmessage = async (e: MessageEvent<RunReq | EnsembleReq>) => {
  // Monte Carlo ensembles run here too — N sequential sims would freeze the UI on
  // the main thread. Discriminated by `kind`; replies carry the matching reqId.
  if ((e.data as EnsembleReq).kind === "ensemble") {
    const { reqId, source, runs, seed, series } = e.data as EnsembleReq;
    try {
      const bands = await monteCarlo(parseModel(source), {
        runs,
        ...(seed !== undefined ? { seed } : {}),
        ...(series?.length ? { series } : {}),
      });
      (self as unknown as Worker).postMessage({ kind: "ensemble", reqId, ok: true, bands });
    } catch (err) {
      (self as unknown as Worker).postMessage({ kind: "ensemble", reqId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  const { gen, source } = e.data as RunReq;
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
