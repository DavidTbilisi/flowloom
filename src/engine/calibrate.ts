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
      per[series] = e;
      total += e;
    }
    if (!Number.isFinite(total)) total = 1e9; // non-finite run ⇒ heavy penalty
    return { total, per };
  };

  const n = opts.params.length;
  const start = opts.params.map((p) => (Number.isFinite(base[p]!) ? base[p]! : 0));

  // Declared bounds, per fitted param, as a box the simplex is projected into.
  // Nelder–Mead has no notion of constraints, so projection is how a
  // derivative-free method respects them: every candidate point is clamped
  // before it is scored, which keeps the simplex inside the box rather than
  // letting it wander out and be rescued by a penalty.
  const declared = opts.unbounded ? new Map() : paramRanges(model, base);
  const box = opts.params.map((p) => {
    const r = declared.get(p);
    return r ? ([r.lo, r.hi] as [number, number]) : ([-Infinity, Infinity] as [number, number]);
  });
  const bounded = box.some(([lo, hi]) => Number.isFinite(lo) || Number.isFinite(hi));
  const clamp = (x: number[]): number[] => (bounded ? x.map((v, i) => Math.min(box[i]![1], Math.max(box[i]![0], v))) : x);

  let evals = 0;
  const f = async (x: number[]) => {
    evals++;
    return (await score(x)).total;
  };

  // Initial simplex: start point + a perturbation along each axis. The
  // perturbation is scaled to the box so a narrow range still gets a simplex
  // that fits inside it rather than one that is immediately clamped flat.
  const simplex: number[][] = [clamp(start.slice())];
  for (let i = 0; i < n; i++) {
    const x = start.slice();
    const [lo, hi] = box[i]!;
    const span = Number.isFinite(hi - lo) ? (hi - lo) * 0.25 : x[i]! !== 0 ? Math.abs(x[i]!) * 0.05 : 0.05;
    // step toward the roomier side, so the vertex lands inside the box
    x[i] = x[i]! + (hi - x[i]! >= x[i]! - lo ? span : -span);
    simplex.push(clamp(x));
  }
  const fv = await Promise.all(simplex.map(f));

  const centroid = (exclude: number): number[] => {
    const c = new Array(n).fill(0);
    for (let i = 0; i < simplex.length; i++) {
      if (i === exclude) continue;
      for (let j = 0; j < n; j++) c[j] += simplex[i]![j]!;
    }
    return c.map((v) => v / n);
  };
  const order = () => {
    const idx = simplex.map((_, i) => i).sort((a, b) => fv[a]! - fv[b]!);
    return { best: idx[0]!, worst: idx[n]!, second: idx[n - 1]! };
  };

  let converged = false;
  while (evals < maxEvals) {
    const { best, worst, second } = order();
    // Two tests, both required. Objective spread alone calls a flat plateau
    // "converged" — every vertex scores the same while the simplex is still
    // wide, which is exactly what a poorly identified param looks like. The
    // diameter test is what distinguishes "we agree on the answer" from "we
    // agree we can't tell".
    const spread = Math.abs(fv[worst]! - fv[best]!);
    const diameter = Math.max(
      ...simplex.map((v) => Math.max(...v.map((c, j) => Math.abs(c - simplex[best]![j]!) / Math.max(1, Math.abs(simplex[best]![j]!))))),
    );
    if (spread <= tol && diameter <= Math.sqrt(tol)) { converged = true; break; }

    const c = centroid(worst);
    const xr = clamp(c.map((cv, j) => cv + 1.0 * (cv - simplex[worst]![j]!))); // reflect
    const fr = await f(xr);

    if (fr < fv[best]!) {
      const xe = clamp(c.map((cv, j) => cv + 2.0 * (cv - simplex[worst]![j]!))); // expand
      const fe = await f(xe);
      if (fe < fr) { simplex[worst] = xe; fv[worst] = fe; }
      else { simplex[worst] = xr; fv[worst] = fr; }
    } else if (fr < fv[second]!) {
      simplex[worst] = xr; fv[worst] = fr;
    } else {
      const xc = clamp(c.map((cv, j) => cv + 0.5 * (simplex[worst]![j]! - cv))); // contract
      const fc = await f(xc);
      if (fc < fv[worst]!) { simplex[worst] = xc; fv[worst] = fc; }
      else {
        // shrink toward the best
        const b = simplex[best]!;
        for (let i = 0; i < simplex.length; i++) {
          if (i === best) continue;
          simplex[i] = simplex[i]!.map((v, j) => b[j]! + 0.5 * (v - b[j]!));
          fv[i] = await f(simplex[i]!);
        }
      }
    }
  }

  const { best } = order();
  const fitted = simplex[best]!;
  const final = await score(fitted);
  const params: Record<string, number> = {};
  const startRec: Record<string, number> = {};
  opts.params.forEach((p, i) => { params[p] = fitted[i]!; startRec[p] = start[i]!; });
  const atBound = opts.params.filter((_, i) => {
    const [lo, hi] = box[i]!;
    if (!Number.isFinite(lo) && !Number.isFinite(hi)) return false;
    const eps = Math.max(1e-9, (hi - lo) * 1e-6);
    return fitted[i]! <= lo + eps || fitted[i]! >= hi - eps;
  });
  const bounds: Record<string, [number, number]> = {};
  opts.params.forEach((p, i) => { if (Number.isFinite(box[i]![0]) || Number.isFinite(box[i]![1])) bounds[p] = box[i]!; });
  return {
    params, start: startRec, residual: final.total, perSeries: final.per, evals, converged,
    ...(atBound.length ? { atBound } : {}),
    ...(Object.keys(bounds).length ? { bounds } : {}),
  };
}
