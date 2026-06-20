// ── Goodness-of-fit ──────────────────────────────────────────────────────────
// Small pure helpers shared by the calibrator: interpolate a simulated series
// onto observation times, then score it against the observations. Normalised RMSE
// (by the observed range) makes series of different magnitudes comparable, so a
// multi-series objective can just sum them.

/** Linear interpolation of (t, y) at `query`, clamped to the endpoints. t ascending. */
export function interpAt(t: ArrayLike<number>, y: ArrayLike<number>, query: number): number {
  const n = t.length;
  if (n === 0) return NaN;
  if (query <= t[0]!) return y[0]!;
  if (query >= t[n - 1]!) return y[n - 1]!;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid]! <= query) lo = mid;
    else hi = mid;
  }
  const f = (query - t[lo]!) / (t[hi]! - t[lo]!);
  return y[lo]! + f * (y[hi]! - y[lo]!);
}

/** Root-mean-square error between paired predictions and observations. */
export function rmse(pred: ArrayLike<number>, obs: ArrayLike<number>): number {
  const n = Math.min(pred.length, obs.length);
  if (n === 0) return NaN;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = pred[i]! - obs[i]!;
    s += d * d;
  }
  return Math.sqrt(s / n);
}

/** RMSE normalised by the observed range (max − min); falls back to |mean|, then 1. */
export function nrmse(pred: ArrayLike<number>, obs: ArrayLike<number>): number {
  const n = obs.length;
  if (n === 0) return NaN;
  let min = Infinity, max = -Infinity, sum = 0;
  for (let i = 0; i < n; i++) {
    const v = obs[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const range = max - min;
  const scale = range > 0 ? range : Math.abs(sum / n) || 1;
  return rmse(pred, obs) / scale;
}
