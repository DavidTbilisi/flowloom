// ── Calibration ──────────────────────────────────────────────────────────────
// Fit model params to observed data by minimising the summed normalised-RMSE
// across mapped series. Derivative-free Nelder–Mead over the param vector — same
// clone-and-run trial as sweep/solve (each evaluation rebinds the params via
// applyOverride on a fresh clone), no autodiff, keeping the no-eval ethos. Works
// for one param or several; returns the fitted values and the achieved fit.
//
// The fit is *bounded* wherever the model says so: a `param x = 0.03 ± 0.01`
// declares the plausible interval, and the simplex is projected into it after
// every move. That matters more here than anywhere else in the engine, because
// calibration is the one analysis that writes its answer back into the canonical
// text (`setParamValue`) — an unbounded simplex will walk a rate constant
// negative, and the only thing that used to stop it was a non-finite run. A
// merely absurd fit was accepted silently and became the model.

import type { Model } from "../lang/types.js";
import { simulateAsync } from "./simulator.js";
import { applyOverride } from "./overrides.js";
import { operatingPoint } from "./loops.js";
import { interpAt, nrmse } from "./fit.js";
import { paramRanges } from "./uncertainty.js";
import type { Dataset } from "./dataset.js";
import { minimize } from "./simplex.js";

export interface CalibrateOptions {
  /** Params (or stock inits) to fit. */
  params: string[];
  /** Observed data to fit against. */
  dataset: Dataset;
  /** Model series → dataset column. Defaults to identity for matching names. */
  map?: Record<string, string>;
  /** Max objective evaluations. Default 200. */
  maxEvals?: number;
  /** Stop when the simplex objective spread is below this. Default 1e-6. */
  tol?: number;
  /** Ignore declared `± / in` bounds and fit unconstrained. Off by default; the
   *  bounds exist to keep a fit inside what the modeller called plausible. */
  unbounded?: boolean;
  /**
   * Per-series weight in the summed residual. Default 1 each.
   *
   * The residual is a sum of *normalised* RMSEs, so every series counts the
   * same however big its numbers are — but also however many observations it
   * has, which is rarely what a modeller means when one series has 5 samples
   * and another 500. Weights are the knob for that; they are explicit rather
   * than derived from the counts, because "trust the long series more" is a
   * judgement about the data, not a fact about it.
   */
  weights?: Record<string, number>;
}

export interface CalibrateResult {
  params: Record<string, number>;
  /** Starting values (the model's operating point). */
  start: Record<string, number>;
  /** Final summed nrmse across all mapped series. */
  residual: number;
  /** nrmse per mapped series at the fitted params. */
  perSeries: Record<string, number>;
  evals: number;
  converged: boolean;
  /** Params whose fitted value sits on a declared bound — the data wanted to go
   *  further than the model said was plausible. Either the bound is wrong or the
   *  structure is; both are worth knowing, and neither is visible from the
   *  residual alone. */
  atBound?: string[];
  /** Bounds that were enforced, for the report. */
  bounds?: Record<string, [number, number]>;
  /** Per-series weights applied to the residual, when any were given. */
  weights?: Record<string, number>;
}

/** Resolve which model series map to which dataset columns. */
function resolveMap(opts: CalibrateOptions, names: string[]): Array<[string, string]> {
  if (opts.map && Object.keys(opts.map).length) {
    return Object.entries(opts.map).map(([series, col]) => {
      if (!names.includes(series)) throw new Error(`calibrate: model has no series "${series}"`);
      if (!opts.dataset.columns.has(col)) throw new Error(`calibrate: dataset has no column "${col}"`);
      return [series, col];
    });
  }
  // Default: every dataset column whose name matches a model series.
  const pairs = [...opts.dataset.columns.keys()].filter((c) => names.includes(c)).map((c) => [c, c] as [string, string]);
  if (!pairs.length) throw new Error("calibrate: no series/column name matches — pass an explicit map");
  return pairs;
}

export async function calibrate(model: Model, opts: CalibrateOptions): Promise<CalibrateResult> {
  if (!opts.params.length) throw new Error("calibrate needs at least one param");
  const maxEvals = opts.maxEvals ?? 200;
  const tol = opts.tol ?? 1e-6;

  const base = operatingPoint(model);
  const names = (await simulateAsync(model)).names;
  const mapping = resolveMap(opts, names);

  // Per-mapped-series nrmse at a given param vector (interpolating onto the data grid).
  const weightOf = (series: string) => {
    const w = opts.weights?.[series];
    if (w === undefined) return 1;
    if (!Number.isFinite(w) || w < 0) throw new Error(`calibrate: weight for "${series}" must be a non-negative number, got ${w}`);
    return w;
  };
  for (const key of Object.keys(opts.weights ?? {})) {
    if (!mapping.some(([series]) => series === key)) {
      throw new Error(`calibrate: weight names "${key}", which is not one of the fitted series (${mapping.map(([s]) => s).join(", ")})`);
    }
  }

  const score = async (x: number[]): Promise<{ total: number; per: Record<string, number> }> => {
    const m = structuredClone(model);
    opts.params.forEach((p, i) => applyOverride(m, `${p}=${x[i]}`));
    const res = await simulateAsync(m);
    const per: Record<string, number> = {};
    let total = 0;
    for (const [series, col] of mapping) {
      const sim = res.series.get(series)!;
      const pred = opts.dataset.t.map((tt) => interpAt(res.t, sim, tt));
      const e = nrmse(pred, opts.dataset.columns.get(col)!);
      per[series] = e;                 // reported unweighted — it is a fit, not a score
      total += weightOf(series) * e;
    }
    if (!Number.isFinite(total)) total = 1e9; // non-finite run ⇒ heavy penalty
    return { total, per };
  };

  const start = opts.params.map((p) => (Number.isFinite(base[p]!) ? base[p]! : 0));

  // Declared bounds, per fitted param, as the box the simplex is projected into.
  // This matters more here than anywhere else in the engine, because calibration
  // is the one analysis that writes its answer back into the canonical text.
  const declared = opts.unbounded ? new Map() : paramRanges(model, base);
  const box = opts.params.map((p) => {
    const r = declared.get(p);
    return r ? ([r.lo, r.hi] as [number, number]) : ([-Infinity, Infinity] as [number, number]);
  });

  const search = await minimize(async (x) => (await score(x)).total, {
    start,
    box,
    maxEvals,
    tol,
  });
  const fitted = search.x;
  const final = await score(fitted);
  const params: Record<string, number> = {};
  const startRec: Record<string, number> = {};
  opts.params.forEach((p, i) => { params[p] = fitted[i]!; startRec[p] = start[i]!; });
  const atBound = search.atBound.map((i) => opts.params[i]!);
  const bounds: Record<string, [number, number]> = {};
  opts.params.forEach((p, i) => { if (Number.isFinite(box[i]![0]) || Number.isFinite(box[i]![1])) bounds[p] = box[i]!; });
  return {
    params,
    start: startRec,
    residual: final.total,
    perSeries: final.per,
    evals: search.evals,
    converged: search.converged,
    ...(atBound.length ? { atBound } : {}),
    ...(Object.keys(bounds).length ? { bounds } : {}),
    ...(opts.weights && Object.keys(opts.weights).length ? { weights: { ...opts.weights } } : {}),
  };
}
