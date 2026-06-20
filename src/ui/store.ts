import { parseModel, ModelError, type Model, type Diagnostic } from "../lang/index.js";
import { simulate, analyzeLoops, type SimResult, type LoopReport, type EnsembleResult, type Dataset } from "../engine/index.js";

// ── Application state ────────────────────────────────────────────────────────
// One observable store. Components subscribe; setters notify. The animation
// clock (`frame`) is broadcast on a separate, lighter channel so playback can
// repaint the plot cursor and diagram without re-running everything.

export type Tab = "plot" | "diagram" | "loops" | "table" | "help";

export interface RunState {
  ok: boolean;
  model?: Model;
  result?: SimResult;
  loops?: LoopReport;
  diagnostics: Diagnostic[];
  error?: string;
  note?: string;
}

/** Optional things drawn over the plot, independent of the canonical run. */
export interface Overlay {
  /** Monte Carlo percentile bands (cleared when the model is re-run). */
  bands?: EnsembleResult;
  /** Observed reference series to fit/compare against (persists across edits). */
  data?: Dataset;
  /** A second model's run, overlaid for comparison (persists across edits). */
  compare?: { source: string; result: SimResult };
}

type Listener = () => void;

// A model big enough that building it could block the UI — offload everything
// (simulation + loop analysis) to the worker. Two independent costs:
//   • simulation scales with stocks × steps (worker uses the WASM backend);
//   • loop analysis scales with graph size (stocks), independent of steps.
// Either being large is reason enough to go off-thread.
function isLarge(model: Model): boolean {
  const { dt, to, start } = model.settings;
  const steps = Math.max(1, Math.round((to - start) / dt));
  const n = model.stocks.length;
  return n >= 120 || n * steps >= 2_000_000;
}

export class Store {
  source = "";
  tab: Tab = "plot";
  run: RunState = { ok: false, diagnostics: [] };
  visible = new Set<string>();
  /** Auxiliary series drawn over the plot (Monte Carlo bands, data, comparison). */
  overlay: Overlay = {};
  /** True while a large model is being simulated in the worker. */
  computing = false;

  // animation clock
  frame = 0; // index into result.t
  playing = false;
  speed = 1; // frames advanced per tick (scaled)

  private listeners = new Set<Listener>();
  private frameListeners = new Set<Listener>();
  private worker: Worker | null = null;
  private gen = 0; // generation counter to drop stale worker results

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onFrame(fn: Listener): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }
  private notify() {
    for (const fn of this.listeners) fn();
  }
  private notifyFrame() {
    for (const fn of this.frameListeners) fn();
  }

  get frameCount(): number {
    return this.run.result?.t.length ?? 0;
  }
  get currentTime(): number {
    return this.run.result?.t[this.frame] ?? 0;
  }

  setTab(tab: Tab) {
    this.tab = tab;
    this.notify();
  }

  setFrame(frame: number) {
    const n = this.frameCount;
    this.frame = n ? Math.max(0, Math.min(n - 1, Math.round(frame))) : 0;
    this.notifyFrame();
  }

  toggleSeries(name: string) {
    if (this.visible.has(name)) this.visible.delete(name);
    else this.visible.add(name);
    this.notifyFrame();
  }

  setPlaying(p: boolean) {
    this.playing = p;
    this.notifyFrame();
  }

  setBands(bands: EnsembleResult | undefined) {
    this.overlay.bands = bands;
    this.notify();
  }
  setData(data: Dataset | undefined) {
    this.overlay.data = data;
    this.notify();
  }
  setCompare(compare: { source: string; result: SimResult } | undefined) {
    this.overlay.compare = compare;
    this.notify();
  }
  clearOverlay() {
    this.overlay = {};
    this.notify();
  }

  /** Parse + simulate the current source, updating run state and default series. */
  build(source: string) {
    this.source = source;
    this.overlay.bands = undefined; // bands are tied to the previous model — stale now
    const gen = ++this.gen; // invalidate any in-flight worker result
    try {
      const model = parseModel(source);
      if (isLarge(model)) {
        // keep the UI responsive: simulate AND analyze loops in the worker
        this.computing = true;
        this.run = { ok: true, model, diagnostics: model.diagnostics };
        this.simulateInWorker(source, model, gen);
      } else {
        this.applyResult(model, simulate(model), analyzeLoops(model));
      }
    } catch (e) {
      this.computing = false;
      const error = e instanceof ModelError ? e.message : e instanceof Error ? e.message : String(e);
      const diagnostics = e instanceof ModelError ? e.diagnostics : [];
      this.run = { ok: false, diagnostics, error };
    }
    this.notify();
    this.notifyFrame();
  }

  private applyResult(model: Model, result: SimResult, loops?: LoopReport) {
    this.computing = false;
    this.run = { ok: true, model, result, loops, diagnostics: model.diagnostics, note: result.note };
    const def = (model.plot.length ? model.plot : result.stockNames).filter((n) => result.series.has(n));
    this.visible = new Set(def.length ? def : result.names.slice(0, 3));
    this.frame = result.t.length - 1; // show the finished run by default
    this.playing = false;
  }

  private simulateInWorker(source: string, model: Model, gen: number) {
    try {
      if (!this.worker) {
        this.worker = new Worker(new URL("./sim-worker.ts", import.meta.url), { type: "module" });
        this.worker.onmessage = (e: MessageEvent) => {
          const msg = e.data as { gen: number; ok: boolean; result?: SimResult; loops?: LoopReport; error?: string };
          if (msg.gen !== this.gen) return; // a newer build superseded this one
          if (msg.ok && msg.result) this.applyResult(model, msg.result, msg.loops);
          else { this.computing = false; this.run = { ok: false, diagnostics: [], error: msg.error ?? "simulation failed" }; }
          this.notify();
          this.notifyFrame();
        };
      }
      this.worker.postMessage({ gen, source });
    } catch {
      // no worker available (or it failed to start) — fall back to a sync run
      this.applyResult(model, simulate(model), analyzeLoops(model));
    }
  }
}
