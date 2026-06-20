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

/** The names routed specially (they need seed/step/draw-index, not the (args,t) ABI). */
export const RANDOM_FNS = new Set(["random", "random_uniform", "random_normal"]);

/** Draw indices a call site consumes (random_normal pulls two uniforms). */
export function drawSlots(name: string): number {
  return name === "random_normal" ? 2 : 1;
}
