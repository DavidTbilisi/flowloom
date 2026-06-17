// ── Goal-seek / calibration ─────────────────────────────────────────────────
// Invert a model: find the knob value that drives an output metric to a target.
// Build on Phase-1 resolveMetric + Phase-2 clone-and-run — each trial is a fresh
// run with one param rebound — and root-find f(x) = metric(run(x)) − target = 0
// by bisection. Bisection is derivative-free and can't diverge, which suits a
// black-box simulation with no gradient and the no-eval ethos; we auto-bracket
// by expanding outward from the model's base value until the metric straddles
// the target. Turns "what value hits X?" into one call instead of a --set hunt.

import type { Model } from "../lang/types.js";
import { metricWith } from "./sweep.js";
import { operatingPoint } from "./loops.js";

export interface SolveOptions {
  /** Search interval [lo, hi]; omitted ⇒ auto-bracket outward from the base value. */
  bracket?: [number, number];
  /** Converged when |metric − target| ≤ tol. Default 1e-6·max(1,|target|). */
  tol?: number;
  /** Max bisection steps. Default 50 (≈ halves the interval 50 times). */
  maxIter?: number;
}

export interface SolveResult {
  param: string;
  metric: string;
  target: number;
  /** Best knob value found. */
  value: number;
  /** The metric at `value`. */
  achieved: number;
  /** |achieved − target| at `value`. */
  error: number;
  converged: boolean;
  /** Total runs performed. */
  iters: number;
  note?: string;
}

const finite = (x: number | undefined, fallback: number) => (x !== undefined && Number.isFinite(x) ? x : fallback);
const straddles = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && a !== 0 && b !== 0 && (a < 0) !== (b < 0);

/**
 * Find the value of `param` that makes `metric` equal `target`, by bisection.
 * Always returns the closest value tried; `converged` says whether it hit `tol`.
 */
export async function solveParam(
  model: Model,
  param: string,
  metric: string,
  target: number,
  opts: SolveOptions = {},
): Promise<SolveResult> {
  const tol = opts.tol ?? 1e-6 * Math.max(1, Math.abs(target));
  const maxIter = opts.maxIter ?? 50;

  let iters = 0;
  let best = { value: NaN, achieved: NaN, error: Infinity };
  // f(x) = metric(run with param=x) − target, tracking the closest point seen.
  const f = async (x: number): Promise<number> => {
    const r = await metricWith(model, `${param}=${x}`, metric);
    iters++;
    const err = Math.abs(r.metric - target);
    if (Number.isFinite(err) && err < best.error) best = { value: x, achieved: r.metric, error: err };
    return r.metric - target;
  };

  const done = (converged: boolean, note?: string): SolveResult => ({
    param,
    metric,
    target,
    value: best.value,
    achieved: best.achieved,
    error: best.error,
    converged,
    iters,
    ...(note ? { note } : {}),
  });

  // ── Establish a bracket [lo, hi] whose endpoints straddle the target ────────
  let lo = NaN, hi = NaN, ylo = NaN;
  if (opts.bracket) {
    [lo, hi] = opts.bracket;
    ylo = await f(lo);
    const yhi = await f(hi);
    if (best.error <= tol) return done(true);
    if (!straddles(ylo, yhi)) {
      return done(false, `the bracket [${lo}, ${hi}] doesn't straddle the target (metric ${yi(ylo, target)} and ${yi(yhi, target)}); widen it or pick a different metric`);
    }
  } else {
    const base = finite(operatingPoint(model)[param], 1);
    const y0 = await f(base);
    if (best.error <= tol) return done(true);
    let step = (base !== 0 ? Math.abs(base) : 1) * 0.5;
    let found = false;
    for (let k = 0; k < 40 && !found; k++) {
      const right = base + step;
      const yr = await f(right);
      if (straddles(y0, yr)) { lo = base; hi = right; ylo = y0; found = true; break; }
      const left = base - step;
      const yl = await f(left);
      if (straddles(yl, y0)) { lo = left; hi = base; ylo = yl; found = true; break; }
      step *= 2;
    }
    if (!found) {
      return done(false, `couldn't bracket the target by expanding around ${param}=${base}; the metric may never reach ${target} or isn't monotonic in ${param} (closest: ${param}=${best.value})`);
    }
  }

  // ── Bisection ───────────────────────────────────────────────────────────────
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const ym = await f(mid);
    if (best.error <= tol) return done(true);
    if (!Number.isFinite(ym)) return done(false, `the run went non-finite at ${param}=${mid}; stopping (closest: ${param}=${best.value})`);
    if (straddles(ylo, ym)) { hi = mid; } else { lo = mid; ylo = ym; }
  }
  return done(best.error <= tol, best.error <= tol ? undefined : `did not reach tol=${tol} in ${maxIter} steps (closest |error|=${best.error})`);
}

/** Render a metric value relative to the target for a diagnostic message. */
const yi = (y: number, target: number) => (Number.isFinite(y) ? y + target : y);
