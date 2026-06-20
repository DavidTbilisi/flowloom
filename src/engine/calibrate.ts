// ── Calibration ──────────────────────────────────────────────────────────────
// Fit model params to observed data by minimising the summed normalised-RMSE
// across mapped series. Derivative-free Nelder–Mead over the param vector — same
// clone-and-run trial as sweep/solve (each evaluation rebinds the params via
// applyOverride on a fresh clone), no autodiff, keeping the no-eval ethos. Works
// for one param or several; returns the fitted values and the achieved fit.

import type { Model } from "../lang/types.js";
import { simulateAsync } from "./simulator.js";
import { applyOverride } from "./overrides.js";
import { operatingPoint } from "./loops.js";
import { interpAt, nrmse } from "./fit.js";
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
  let evals = 0;
  const f = async (x: number[]) => {
    evals++;
    return (await score(x)).total;
  };

  // Initial simplex: start point + a perturbation along each axis.
  const simplex: number[][] = [start.slice()];
  for (let i = 0; i < n; i++) {
    const x = start.slice();
    x[i] = x[i]! + (x[i]! !== 0 ? x[i]! * 0.05 : 0.05);
    simplex.push(x);
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
    if (Math.abs(fv[worst]! - fv[best]!) <= tol) { converged = true; break; }

    const c = centroid(worst);
    const xr = c.map((cv, j) => cv + 1.0 * (cv - simplex[worst]![j]!)); // reflect
    const fr = await f(xr);

    if (fr < fv[best]!) {
      const xe = c.map((cv, j) => cv + 2.0 * (cv - simplex[worst]![j]!)); // expand
      const fe = await f(xe);
      if (fe < fr) { simplex[worst] = xe; fv[worst] = fe; }
      else { simplex[worst] = xr; fv[worst] = fr; }
    } else if (fr < fv[second]!) {
      simplex[worst] = xr; fv[worst] = fr;
    } else {
      const xc = c.map((cv, j) => cv + 0.5 * (simplex[worst]![j]! - cv)); // contract
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
  return { params, start: startRec, residual: final.total, perSeries: final.per, evals, converged };
}
