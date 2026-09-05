// ── Seeded, reproducible randomness ──────────────────────────────────────────
// A *counter-based* PRNG: the value is a pure hash of (seed, step, draw-index),
// not a stream advanced by hidden state. That matters for three reasons:
//
//   1. RK4 samples the derivative four times per step; a streaming generator
//      would emit a different number at each sub-stage, so the integrated vector
//      field wouldn't be well-defined. With a counter keyed on the integer step,
//      random() is resampled once per step and held across the four RK4 stages.
//   2. The compiled backends evaluate each expression once with no per-call-site
//      state slot — a counter keyed on a compile-time draw index fits that model.
//   3. It is bit-reproducible everywhere. The WASM backend imports *these very
//      functions* rather than re-deriving them in bytecode, so all three backends
//      (tree-walker, compiled TS, WASM) produce identical numbers by construction.
//
// SplitMix64 finalizer over BigInt for exact 64-bit arithmetic; the result is the
// top 53 bits scaled into [0, 1).

const MASK = (1n << 64n) - 1n;
const TWO53 = 9007199254740992; // 2^53

const A = 0x9e3779b97f4a7c15n; // golden-ratio odd constant
const B = 0xff51afd7ed558ccdn;
const C = 0xc4ceb9fe1a85ec53n;

function toU64(n: number): bigint {
  return BigInt(Math.trunc(n)) & MASK;
}

/** SplitMix64 finalizing mix — strong avalanche over a 64-bit word. */
function mix(x: bigint): bigint {
  x = ((x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  x = ((x ^ (x >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return (x ^ (x >> 31n)) & MASK;
}

/** Uniform draw in [0, 1) from the (seed, step, draw-index) triple. */
export function u01(seed: number, step: number, k: number): number {
  const state = (toU64(seed) * A + toU64(step) * B + toU64(k) * C) & MASK;
  return Number(mix(state) >> 11n) / TWO53;
}

/** Standard-normal draw via Box-Muller; consumes draw indices k and k+1. */
export function n01(seed: number, step: number, k: number): number {
  let u1 = u01(seed, step, k);
  const u2 = u01(seed, step, k + 1);
  if (u1 < 1e-300) u1 = 1e-300; // guard log(0)
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** random_uniform(lo, hi): uniform on [lo, hi). `random()` is runif(...,0,1). */
export function runif(seed: number, step: number, k: number, lo: number, hi: number): number {
  return lo + (hi - lo) * u01(seed, step, k);
}

/** random_normal(mean, sd): Gaussian with the given mean and standard deviation. */
export function rnorm(seed: number, step: number, k: number, mean: number, sd: number): number {
  return mean + sd * n01(seed, step, k);
}

// ── More distributions ──────────────────────────────────────────────────────
// Three distributions is enough to demonstrate noise and not enough to model it.
// A delivery time is lognormal, an expert's estimate is triangular, arrivals are
// Poisson, a waiting time is exponential, and a physical quantity that cannot go
// negative needs a normal that is actually truncated rather than one that is
// clipped after the fact.
//
// Every one of these is built from a FIXED number of uniform draws — inverse-CDF
// rather than rejection sampling. That is not a preference: a call site is
// assigned its draw indices once at compile time (buildPlan), so a sampler whose
// draw count depends on the value it happens to produce would collide with the
// next call site's indices and quietly correlate them.

/** Φ(x): standard-normal CDF, via the Abramowitz–Stegun 7.1.26 erf. */
function phi(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/** Φ⁻¹(p): inverse standard-normal CDF (Acklam's rational approximation). */
function probit(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const q = p - 0.5, r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** random_lognormal(median, sigma): exp of a normal, so it is positive and skewed. */
export function rlnorm(seed: number, step: number, k: number, median: number, sigma: number): number {
  if (!(median > 0)) return 0;
  return median * Math.exp(sigma * n01(seed, step, k));
}

/** random_triangular(lo, mode, hi): the three-point estimate, by inverse CDF. */
export function rtri(seed: number, step: number, k: number, lo: number, mode: number, hi: number): number {
  if (!(hi > lo)) return lo;
  const m = Math.min(hi, Math.max(lo, mode));
  const u = u01(seed, step, k);
  const split = (m - lo) / (hi - lo);
  return u < split
    ? lo + Math.sqrt(u * (hi - lo) * (m - lo))
    : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - m));
}

/** random_exponential(rate): waiting time at a constant hazard rate. */
export function rexp(seed: number, step: number, k: number, rate: number): number {
  if (!(rate > 0)) return 0;
  return -Math.log(1 - u01(seed, step, k)) / rate;
}

/**
 * random_poisson(mean): a non-negative integer count.
 *
 * Inverse CDF by summing terms, which is O(mean) and exact; above 500 the sum is
 * both slow and pointless, and the normal approximation is within a rounding of
 * it — that branch is why the call site reserves two draw indices.
 */
export function rpois(seed: number, step: number, k: number, mean: number): number {
  if (!(mean > 0)) return 0;
  if (mean > 500) return Math.max(0, Math.round(mean + Math.sqrt(mean) * n01(seed, step, k)));
  const u = u01(seed, step, k);
  let p = Math.exp(-mean), cum = p, n = 0;
  while (cum < u && n < 10_000) { n++; p *= mean / n; cum += p; }
  return n;
}

/**
 * random_normal_truncated(mean, sd, lo, hi): a normal that genuinely lives in
 * [lo, hi] — the inverse CDF is evaluated on the truncated interval, so the
 * shape inside it is right. Clamping a normal instead piles probability mass on
 * the two bounds, which is a different distribution wearing the same name.
 */
export function rtnorm(seed: number, step: number, k: number, mean: number, sd: number, lo: number, hi: number): number {
  if (!(sd > 0)) return Math.min(hi, Math.max(lo, mean));
  if (!(hi > lo)) return lo;
  const a = phi((lo - mean) / sd), b = phi((hi - mean) / sd);
  if (!(b > a)) return Math.min(hi, Math.max(lo, mean)); // the interval is off in the tail
  const u = a + (b - a) * u01(seed, step, k);
  return Math.min(hi, Math.max(lo, mean + sd * probit(u)));
}

/** The names routed specially (they need seed/step/draw-index, not the (args,t) ABI). */
export const RANDOM_FNS = new Set([
  "random", "random_uniform", "random_normal",
  "random_lognormal", "random_triangular", "random_exponential", "random_poisson", "random_normal_truncated",
]);

/**
 * Draw indices a call site consumes.
 *
 * Reserved at compile time and fixed for the life of the model, so a sampler
 * that *may* need a second uniform reserves it whether or not this particular
 * run takes that branch — otherwise two call sites would share an index and
 * their "independent" noise would be correlated.
 */
export function drawSlots(name: string): number {
  return name === "random_normal" || name === "random_lognormal" || name === "random_poisson" ? 2 : 1;
}
