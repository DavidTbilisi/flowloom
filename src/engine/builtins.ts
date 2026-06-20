// ── Stateless builtin functions ─────────────────────────────────────────────
// Pure math plus the classic system-dynamics *test input* functions (STEP,
// PULSE, RAMP). Stateful builtins (SMOOTH, DELAY1/3) are NOT here — they expand
// into internal stocks during compilation (see compile.ts) because they carry
// state across time and must be integrated.
//
// Every builtin receives (args, t) so the time-based inputs can read the clock.

export type Builtin = (args: number[], t: number) => number;

export const BUILTINS: Record<string, Builtin> = {
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
  abs: (a) => Math.abs(a[0]!),
  exp: (a) => Math.exp(a[0]!),
  ln: (a) => Math.log(a[0]!),
  log: (a) => Math.log(a[0]!),
  log10: (a) => Math.log10(a[0]!),
  sqrt: (a) => Math.sqrt(a[0]!),
  pow: (a) => Math.pow(a[0]!, a[1]!),
  sin: (a) => Math.sin(a[0]!),
  cos: (a) => Math.cos(a[0]!),
  tan: (a) => Math.tan(a[0]!),
  floor: (a) => Math.floor(a[0]!),
  ceil: (a) => Math.ceil(a[0]!),
  round: (a) => Math.round(a[0]!),
  sign: (a) => Math.sign(a[0]!),

  // IF(cond, a, b) — note: both branches are evaluated (pure interpreter).
  if: (a) => (a[0] ? a[1]! : a[2]!),
  clamp: (a) => Math.max(a[1]!, Math.min(a[2]!, a[0]!)),

  // ── test inputs (read the simulation clock `t`) ──────────────────────────
  // STEP(height, t0): 0 before t0, then height.
  step: (a, t) => (t >= a[1]! ? a[0]! : 0),
  // PULSE(t0, width): 1 on [t0, t0+width), else 0. width<=0 ⇒ single-instant 1 at t0.
  pulse: (a, t) => {
    const t0 = a[0]!;
    const width = a[1] ?? 0;
    if (width <= 0) return t === t0 ? 1 : 0;
    return t >= t0 && t < t0 + width ? 1 : 0;
  },
  // RAMP(slope, t0, t1): 0 before t0, slope*(t-t0) between, frozen after t1.
  ramp: (a, t) => {
    const slope = a[0]!;
    const t0 = a[1]!;
    const t1 = a[2] ?? Infinity;
    if (t <= t0) return 0;
    const end = Math.min(t, t1);
    return slope * (end - t0);
  },
};

/** Arity check used by the validator for nicer error messages (min..max). */
export const ARITY: Record<string, [number, number]> = {
  min: [1, Infinity],
  max: [1, Infinity],
  abs: [1, 1],
  exp: [1, 1],
  ln: [1, 1],
  log: [1, 1],
  log10: [1, 1],
  sqrt: [1, 1],
  pow: [2, 2],
  sin: [1, 1],
  cos: [1, 1],
  tan: [1, 1],
  floor: [1, 1],
  ceil: [1, 1],
  round: [1, 1],
  sign: [1, 1],
  if: [3, 3],
  clamp: [3, 3],
  step: [2, 2],
  pulse: [1, 2],
  ramp: [2, 3],
  // Seeded randomness — routed specially (they need seed/step/draw-index, not the
  // generic (args,t) ABI), but registered here so the validator and catalog see them.
  random: [0, 0],
  random_uniform: [2, 2],
  random_normal: [2, 2],
};

/** Names of the stateful delay/smooth builtins handled by the compiler. */
export const STATEFUL = new Set(["smooth", "smoothi", "smooth3", "delay1", "delay3"]);

/** Piecewise-linear interpolation of a graphical/lookup table; clamps at the ends. */
export function lookupTable(points: ReadonlyArray<readonly [number, number]>, x: number): number {
  const n = points.length;
  if (x <= points[0]![0]) return points[0]![1];
  if (x >= points[n - 1]![0]) return points[n - 1]![1];
  // binary search for the bracketing segment
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid]![0] <= x) lo = mid;
    else hi = mid;
  }
  const [x0, y0] = points[lo]!;
  const [x1, y1] = points[hi]!;
  const f = (x - x0) / (x1 - x0);
  return y0 + f * (y1 - y0);
}
