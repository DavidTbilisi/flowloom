import { parseModel, ModelError, type Model, type Diagnostic } from "../lang/index.js";
import { simulate, analyzeLoops, type SimResult, type LoopReport } from "../engine/index.js";

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

type Listener = () => void;

export class Store {
  source = "";
  tab: Tab = "plot";
  run: RunState = { ok: false, diagnostics: [] };
  visible = new Set<string>();

  // animation clock
  frame = 0; // index into result.t
  playing = false;
  speed = 1; // frames advanced per tick (scaled)

  private listeners = new Set<Listener>();
  private frameListeners = new Set<Listener>();

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

  /** Parse + simulate the current source, updating run state and default series. */
  build(source: string) {
    this.source = source;
    try {
      const model = parseModel(source);
      const result = simulate(model);
      const loops = analyzeLoops(model);
      this.run = {
        ok: true,
        model,
        result,
        loops,
        diagnostics: model.diagnostics,
        note: result.note,
      };
      const def = (model.plot.length ? model.plot : result.stockNames).filter((n) => result.series.has(n));
      this.visible = new Set(def.length ? def : result.names.slice(0, 3));
      this.frame = result.t.length - 1; // show the finished run by default
      this.playing = false;
    } catch (e) {
      const error = e instanceof ModelError ? e.message : e instanceof Error ? e.message : String(e);
      const diagnostics = e instanceof ModelError ? e.diagnostics : [];
      this.run = { ok: false, diagnostics, error };
    }
    this.notify();
    this.notifyFrame();
  }
}
