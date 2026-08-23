// ── Model diff ───────────────────────────────────────────────────────────────
// "Did this edit change what the model computes?" is the most common question
// about a living model and the easiest to answer wrong by eye. A refactor — a
// renamed aux, `× dt` bookkeeping removed, a term moved — should leave every
// number alone; an edit that is meant to move numbers should move only the ones
// it meant to. diffModels answers in three layers: structure (what is declared),
// numbers (every series, under base and every scenario both sides declare), and
// the loop census (which loops exist and which engage — the thing a refactor
// breaks silently, since the numbers can stay while the analysis changes).

import type { Model } from "../lang/types.js";
import { simulateAsync, type SimResult } from "./simulator.js";
import { applyScenario, BASE_SCENARIO } from "./overrides.js";
import { analyzeLoops, operatingPoint } from "./loops.js";
import { loopKey } from "./sils.js";

export interface SeriesDiff {
  name: string;
  /** Largest |a − b| over the shared time grid, and where it occurs. */
  maxAbs: number;
  at: number;
  /** maxAbs relative to the larger magnitude at that point (floor 1). */
  rel: number;
  /** Value on each side at the worst point. */
  a: number;
  b: number;
}

export interface LoopCensus { total: number; active: number }

export interface ScenarioDiff {
  scenario: string;
  /** Steps on each side; the comparison runs over the times both grids share. */
  steps: [number, number];
  shared: number;
  /** Series present on both sides whose difference exceeds the tolerance, worst first. */
  changed: SeriesDiff[];
  /** Series present on both sides and equal within tolerance. */
  same: number;
  onlyA: string[];
  onlyB: string[];
  loops?: { a: LoopCensus; b: LoopCensus; activeOnlyA: string[]; activeOnlyB: string[] };
  /** A run halted early on one side. */
  notes?: { a?: string; b?: string };
  error?: string;
}

export interface StructureDiff {
  stocksOnlyA: string[];
  stocksOnlyB: string[];
  varsOnlyA: string[];
  varsOnlyB: string[];
  scenariosOnlyA: string[];
  scenariosOnlyB: string[];
  /** Params / switches / consts declared on both sides whose value at t=start differs. */
  values: Array<{ name: string; a: number; b: number }>;
  settings: Array<{ key: string; a: string | number; b: string | number }>;
}

export interface DiffResult {
  tol: number;
  structure: StructureDiff;
  scenarios: ScenarioDiff[];
  /** No series moved beyond tol and no live loop appeared or vanished, under any compared scenario. */
  identical: boolean;
  /** Structure changed (declarations, values, settings) — informational; does not affect `identical`. */
  structureChanged: boolean;
}

export interface DiffOptions {
  /** |a − b| ≤ tol · max(1, |a|, |b|) counts as equal. Default 1e-9. */
  tol?: number;
  /** Scenarios to compare (default: base + every scenario both sides declare). */
  scenarios?: string[];
  /** Compare the loop census too (default true; it costs a loop analysis per side per scenario). */
  loops?: boolean;
}

const only = (a: Iterable<string>, b: Iterable<string>): string[] => { const sb = new Set(b); return [...a].filter((x) => !sb.has(x)); };

function structureDiff(a: Model, b: Model): StructureDiff {
  const stocksA = a.stocks.map((s) => s.name), stocksB = b.stocks.map((s) => s.name);
  const varsA = a.vars.map((v) => v.name), varsB = b.vars.map((v) => v.name);
  const values: StructureDiff["values"] = [];
  let opA: Record<string, number> = {}, opB: Record<string, number> = {};
  try { opA = operatingPoint(a); opB = operatingPoint(b); } catch { /* a sketch: no values to compare */ }
  for (const v of a.vars) {
    if (v.kind !== "param") continue;
    const w = b.varIndex.get(v.name);
    if (!w || w.kind !== "param") continue;
    const x = opA[v.name], y = opB[v.name];
    if (x !== undefined && y !== undefined && x !== y) values.push({ name: v.name, a: x, b: y });
  }
  const settings: StructureDiff["settings"] = [];
  for (const key of ["dt", "to", "start", "method", "seed", "timeunit"] as const) {
    const x = a.settings[key], y = b.settings[key];
    if (x !== y && !(x === undefined && y === undefined)) settings.push({ key, a: x ?? "", b: y ?? "" });
  }
  return {
    stocksOnlyA: only(stocksA, stocksB), stocksOnlyB: only(stocksB, stocksA),
    varsOnlyA: only(varsA, varsB), varsOnlyB: only(varsB, varsA),
    scenariosOnlyA: only(a.scenarios.keys(), b.scenarios.keys()), scenariosOnlyB: only(b.scenarios.keys(), a.scenarios.keys()),
    values, settings,
  };
}

/** Indices of the time points both grids share (|ta − tb| < 1e-9), in order. */
function sharedGrid(ta: number[], tb: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let j = 0;
  for (let i = 0; i < ta.length; i++) {
    while (j < tb.length && tb[j]! < ta[i]! - 1e-9) j++;
    if (j < tb.length && Math.abs(tb[j]! - ta[i]!) < 1e-9) out.push([i, j]);
  }
  return out;
}

function compareRuns(name: string, ra: SimResult, rb: SimResult, tol: number): ScenarioDiff {
  const grid = sharedGrid(ra.t, rb.t);
  const namesA = ra.names, namesB = rb.names;
  const changed: SeriesDiff[] = [];
  let same = 0;
  for (const s of namesA) {
    const va = ra.series.get(s), vb = rb.series.get(s);
    if (!va || !vb) continue;
    let worst: SeriesDiff | undefined;
    for (const [i, j] of grid) {
      const x = va[i]!, y = vb[j]!;
      const d = Math.abs(x - y);
      const scale = Math.max(1, Math.abs(x), Math.abs(y));
      // NaN on one side only is a difference; NaN on both is agreement.
      const diff = Number.isNaN(d) ? (Number.isNaN(x) === Number.isNaN(y) ? 0 : Infinity) : d;
      if (!worst || diff > worst.maxAbs) worst = { name: s, maxAbs: diff, at: ra.t[i]!, rel: diff / scale, a: x, b: y };
    }
    if (!worst) continue;
    if (worst.rel > tol) changed.push(worst); else same++;
  }
  changed.sort((x, y) => y.rel - x.rel);
  const d: ScenarioDiff = {
    scenario: name, steps: [ra.t.length, rb.t.length], shared: grid.length, changed, same,
    onlyA: only(namesA, namesB), onlyB: only(namesB, namesA),
  };
  if (ra.note || rb.note) d.notes = { ...(ra.note ? { a: ra.note } : {}), ...(rb.note ? { b: rb.note } : {}) };
  return d;
}

function loopDiff(a: Model, b: Model): ScenarioDiff["loops"] {
  const la = analyzeLoops(a), lb = analyzeLoops(b);
  const liveA = new Map(la.loops.filter((l) => l.active).map((l) => [loopKey(l.nodes), l.nodes.join(" → ")]));
  const liveB = new Map(lb.loops.filter((l) => l.active).map((l) => [loopKey(l.nodes), l.nodes.join(" → ")]));
  return {
    a: { total: la.loops.length, active: liveA.size },
    b: { total: lb.loops.length, active: liveB.size },
    activeOnlyA: [...liveA].filter(([k]) => !liveB.has(k)).map(([, v]) => v),
    activeOnlyB: [...liveB].filter(([k]) => !liveA.has(k)).map(([, v]) => v),
  };
}

/**
 * Compare two models: declarations, every series under base and every shared
 * scenario, and the loop census. A scenario only one side declares is reported
 * in `structure` and not run. `identical` is the refactor verdict — numbers and
 * live loops — while structure changes are listed but do not fail it.
 */
export async function diffModels(a: Model, b: Model, opts: DiffOptions = {}): Promise<DiffResult> {
  const tol = opts.tol ?? 1e-9;
  const structure = structureDiff(a, b);
  const shared = [...a.scenarios.keys()].filter((n) => b.scenarios.has(n));
  let names = opts.scenarios?.length ? opts.scenarios : [BASE_SCENARIO, ...shared];
  for (const n of names) {
    if (n !== BASE_SCENARIO && (!a.scenarios.has(n) || !b.scenarios.has(n))) throw new Error(`scenario '${n}' is not declared on both sides (${!a.scenarios.has(n) ? "missing in the first model" : "missing in the second"})`);
  }
  names = [...new Set(names)];

  const scenarios: ScenarioDiff[] = [];
  for (const name of names) {
    const ma = structuredClone(a), mb = structuredClone(b);
    try {
      applyScenario(ma, name);
      applyScenario(mb, name);
      const [ra, rb] = await Promise.all([simulateAsync(ma), simulateAsync(mb)]);
      const d = compareRuns(name, ra, rb, tol);
      if (opts.loops !== false) d.loops = loopDiff(ma, mb);
      scenarios.push(d);
    } catch (err) {
      scenarios.push({ scenario: name, steps: [0, 0], shared: 0, changed: [], same: 0, onlyA: [], onlyB: [], error: (err as Error).message });
    }
  }

  const identical = scenarios.every((s) => !s.error && s.changed.length === 0 && !(s.loops && (s.loops.activeOnlyA.length || s.loops.activeOnlyB.length)));
  const st = structure;
  const structureChanged = Boolean(st.stocksOnlyA.length || st.stocksOnlyB.length || st.varsOnlyA.length || st.varsOnlyB.length || st.scenariosOnlyA.length || st.scenariosOnlyB.length || st.values.length || st.settings.length);
  return { tol, structure, scenarios, identical, structureChanged };
}
