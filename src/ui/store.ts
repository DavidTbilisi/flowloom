import { parseModel, ModelError, type Model, type Diagnostic } from "../lang/index.js";
import { simulate, analyzeLoops, monteCarlo, applyScenario, BASE_SCENARIO, type SimResult, type LoopReport, type EnsembleResult, type Dataset } from "../engine/index.js";

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
  /** A second model's run, overlaid for comparison (persists across edits).
   *  `label` names it in the plot controls ("base" when it is the active
   *  scenario's reference run, else the loaded file). */
  compare?: { source: string; result: SimResult; label?: string };
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
  /** The active `scenario` line applied on top of the text ("base" = none). UI
   *  state, like the overlays: the text stays canonical, the choice is a view. */
  scenario: string = BASE_SCENARIO;
  /** True while a large model is being simulated in the worker. */
  computing = false;
  /** Log-scale the plot's y axis. A model whose series span orders of magnitude
   *  (a population next to a rate) is unreadable on one linear axis. */
  logY = false;
  /** Phase portrait: one series against another rather than against time — the
   *  view that shows a limit cycle as a closed orbit instead of two wiggles.
   *  View state like `visible`; the text stays canonical. */
  phase: { x: string; y: string } | null = null;

  // animation clock
  frame = 0; // index into result.t
  playing = false;
  speed = 1; // frames advanced per tick (scaled)

  private listeners = new Set<Listener>();
  private frameListeners = new Set<Listener>();
  private worker: Worker | null = null;
  private gen = 0; // generation counter to drop stale worker results
  /** The generation the worker is currently computing, if any. The generation
   *  counter drops a stale *result*, but the worker goes on burning a core
   *  producing it — on a 3000-stock model that is the whole machine. */
  private inFlight: number | null = null;
  // A separate worker for Monte Carlo ensembles, kept independent of the main-run
  // `gen` staleness logic; requests are matched to replies by reqId.
  private ensembleWorker: Worker | null = null;
  private ensembleReqId = 0;
  private ensemblePending = new Map<number, { resolve: (r: EnsembleResult) => void; reject: (e: Error) => void }>();

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

  setLogY(on: boolean) {
    this.logY = on;
    this.notify();
  }

  /** Choose the phase-portrait axes, or null to go back to the time series. */
  setPhase(p: { x: string; y: string } | null) {
    this.phase = p;
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

  /** Pick a scenario and re-run. Selecting a real scenario also overlays the
   *  base run (dashed) so the policy's effect is visible at once; going back to
   *  base drops that overlay (a file comparison is left alone). */
  setScenario(name: string) {
    this.scenario = name || BASE_SCENARIO;
    if (this.overlay.compare?.label === "base") this.overlay.compare = undefined;
    this.build(this.source);
  }

  /** Run a Monte Carlo ensemble off the main thread (falls back to in-process). */
  runEnsemble(opts: { runs: number; seed?: number; series?: string[] }): Promise<EnsembleResult> {
    const source = this.source;
    try {
      if (!this.ensembleWorker) {
        this.ensembleWorker = new Worker(new URL("./sim-worker.ts", import.meta.url), { type: "module" });
        this.ensembleWorker.onmessage = (e: MessageEvent) => {
          const m = e.data as { kind?: string; reqId: number; ok: boolean; bands?: EnsembleResult; error?: string };
          if (m.kind !== "ensemble") return;
          const p = this.ensemblePending.get(m.reqId);
          if (!p) return;
          this.ensemblePending.delete(m.reqId);
          if (m.ok && m.bands) p.resolve(m.bands);
          else p.reject(new Error(m.error ?? "monte carlo failed"));
        };
      }
      const reqId = ++this.ensembleReqId;
      return new Promise<EnsembleResult>((resolve, reject) => {
        this.ensemblePending.set(reqId, { resolve, reject });
        this.ensembleWorker!.postMessage({ kind: "ensemble", reqId, source, ...opts });
      });
    } catch {
      // no worker available — run in-process (blocks, but correct)
      return monteCarlo(parseModel(source), opts);
    }
  }

  /** Parse + simulate the current source, updating run state and default series. */
  build(source: string) {
    this.source = source;
    this.overlay.bands = undefined; // bands are tied to the previous model — stale now
    const gen = ++this.gen; // invalidate any in-flight worker result
    try {
      const model = parseModel(source);
      // The scenario line may have been renamed/removed by the edit — fall back
      // to base rather than failing the whole build.
      if (this.scenario !== BASE_SCENARIO && !model.scenarios.has(this.scenario)) this.scenario = BASE_SCENARIO;
      const scenario = this.scenario !== BASE_SCENARIO ? this.scenario : undefined;
      applyScenario(model, scenario);
      if (isLarge(model)) {
        // keep the UI responsive: simulate AND analyze loops in the worker
        this.computing = true;
        this.run = { ok: true, model, diagnostics: model.diagnostics };
        this.simulateInWorker(source, model, gen, scenario);
        if (this.overlay.compare?.label === "base") this.overlay.compare = undefined; // too big to run twice on the main thread
      } else {
        this.applyResult(model, simulate(model), analyzeLoops(model));
        // Reference run for the active scenario: the same text, un-overridden.
        if (scenario) this.overlay.compare = { source, result: simulate(parseModel(source)), label: "base" };
        else if (this.overlay.compare?.label === "base") this.overlay.compare = undefined;
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
    // A phase pair naming a series the edit removed would draw nothing and
    // explain nothing; fall back to the time series, as the scenario does.
    if (this.phase && !(result.series.has(this.phase.x) && result.series.has(this.phase.y))) this.phase = null;
    const def = (model.plot.length ? model.plot : result.stockNames).filter((n) => result.series.has(n));
    this.visible = new Set(def.length ? def : result.names.slice(0, 3));
    this.frame = result.t.length - 1; // show the finished run by default
    this.playing = false;
  }

  /** True while a worker run can still be stopped — what a Cancel button needs. */
  get cancellable(): boolean {
    return this.inFlight !== null;
  }

  /**
   * Stop the run in flight.
   *
   * Terminating the worker is the only way: a `postMessage` cannot interrupt a
   * synchronous integration loop, so a request to stop that arrives as a message
   * is read after the work it was meant to stop. The worker is dropped rather
   * than reused, and the next run starts a fresh one.
   */
  cancel(reason = "run cancelled — the model is unchanged, press ▶ or edit to run it again") {
    if (this.inFlight === null) return;
    this.killWorker();
    this.gen++; // any result still in the pipe belongs to a run nobody wants
    this.computing = false;
    this.run = { ...this.run, note: reason };
    this.notify();
    this.notifyFrame();
  }

  private killWorker() {
    this.worker?.terminate();
    this.worker = null;
    this.inFlight = null;
  }

  private simulateInWorker(source: string, model: Model, gen: number, scenario?: string) {
    try {
      // A superseded run cannot be called off with a message — the worker is
      // inside a synchronous loop and would not read it until afterwards. So an
      // edit that lands mid-run replaces the worker outright rather than racing
      // the previous model to the finish.
      if (this.inFlight !== null) this.killWorker();
      if (!this.worker) {
        this.worker = new Worker(new URL("./sim-worker.ts", import.meta.url), { type: "module" });
        this.worker.onmessage = (e: MessageEvent) => {
          const msg = e.data as { gen: number; ok: boolean; result?: SimResult; loops?: LoopReport; error?: string };
          if (msg.gen === this.inFlight) this.inFlight = null;
          if (msg.gen !== this.gen) return; // a newer build superseded this one
          if (msg.ok && msg.result) this.applyResult(model, msg.result, msg.loops);
          else { this.computing = false; this.run = { ok: false, diagnostics: [], error: msg.error ?? "simulation failed" }; }
          this.notify();
          this.notifyFrame();
        };
      }
      this.inFlight = gen;
      this.worker.postMessage({ gen, source, ...(scenario ? { scenario } : {}) });
    } catch {
      // no worker available (or it failed to start) — fall back to a sync run
      this.inFlight = null;
      this.applyResult(model, simulate(model), analyzeLoops(model));
    }
  }
}
