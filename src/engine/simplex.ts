// ── Bounded Nelder–Mead ─────────────────────────────────────────────────────
// The derivative-free simplex, extracted from calibrate.ts so it is not welded
// to one objective. Calibration minimises a fit residual; `optimize` maximises a
// payoff metric; both want the same search, the same box projection, and the
// same two-part convergence test — and nothing else in the engine should have to
// re-implement Nelder–Mead to get them.
//
// Box projection is how a derivative-free method respects constraints: the
// simplex has no notion of them, so every candidate is clamped before it is
// scored, which keeps the search inside the box rather than letting it wander
// out and be rescued by a penalty.
//
// The convergence test is two-part on purpose. Objective spread alone calls a
// flat plateau "converged" — every vertex scores the same while the simplex is
// still wide, which is exactly what an unidentifiable parameter looks like. The
// diameter test distinguishes "we agree on the answer" from "we agree we can't
// tell", and that difference is the whole value of the `converged` flag.

export interface SimplexOptions {
  /** Starting point; the initial simplex is built around it. */
  start: number[];
  /** Per-coordinate `[lo, hi]`. Use ±Infinity for an unbounded coordinate. */
  box?: Array<[number, number]>;
  /** Max objective evaluations. Default 200. */
  maxEvals?: number;
  /** Objective-spread threshold. The diameter must also fall under √tol. Default 1e-6. */
  tol?: number;
}

export interface SimplexResult {
  x: number[];
  fx: number;
  evals: number;
  converged: boolean;
  /** Coordinates sitting on a finite bound — the search wanted to go further
   *  than the caller said was allowed. Either the bound is wrong or the model
   *  is; neither is visible from the objective value alone. */
  atBound: number[];
}

const UNBOUNDED: [number, number] = [-Infinity, Infinity];

/** Minimise `f` over a box. `f` may be async — every evaluation here is a whole
 *  simulation, so the search is written around that rather than around speed. */
export async function minimize(
  f: (x: number[]) => Promise<number>,
  opts: SimplexOptions,
): Promise<SimplexResult> {
  const n = opts.start.length;
  if (!n) throw new Error("minimize needs at least one coordinate");
  const maxEvals = opts.maxEvals ?? 200;
  const tol = opts.tol ?? 1e-6;
  const box = opts.box ?? opts.start.map(() => UNBOUNDED);
  const bounded = box.some(([lo, hi]) => Number.isFinite(lo) || Number.isFinite(hi));
  const clamp = (x: number[]): number[] =>
    bounded ? x.map((v, i) => Math.min(box[i]![1], Math.max(box[i]![0], v))) : x;

  let evals = 0;
  const evaluate = async (x: number[]) => { evals++; return f(x); };

  // Initial simplex: the start point plus a perturbation along each axis. The
  // perturbation is scaled to the box, so a narrow range still gets a simplex
  // that fits inside it rather than one clamped flat before the first move.
  const simplex: number[][] = [clamp(opts.start.slice())];
  for (let i = 0; i < n; i++) {
    const x = opts.start.slice();
    const [lo, hi] = box[i]!;
    const span = Number.isFinite(hi - lo) ? (hi - lo) * 0.25 : x[i]! !== 0 ? Math.abs(x[i]!) * 0.05 : 0.05;
    x[i] = x[i]! + (hi - x[i]! >= x[i]! - lo ? span : -span); // step toward the roomier side
    simplex.push(clamp(x));
  }
  const fv = await Promise.all(simplex.map(evaluate));

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
    const spread = Math.abs(fv[worst]! - fv[best]!);
    const diameter = Math.max(
      ...simplex.map((v) => Math.max(...v.map((c, j) => Math.abs(c - simplex[best]![j]!) / Math.max(1, Math.abs(simplex[best]![j]!))))),
    );
    if (spread <= tol && diameter <= Math.sqrt(tol)) { converged = true; break; }

    const c = centroid(worst);
    const xr = clamp(c.map((cv, j) => cv + 1.0 * (cv - simplex[worst]![j]!))); // reflect
    const fr = await evaluate(xr);

    if (fr < fv[best]!) {
      const xe = clamp(c.map((cv, j) => cv + 2.0 * (cv - simplex[worst]![j]!))); // expand
      const fe = await evaluate(xe);
      if (fe < fr) { simplex[worst] = xe; fv[worst] = fe; }
      else { simplex[worst] = xr; fv[worst] = fr; }
    } else if (fr < fv[second]!) {
      simplex[worst] = xr; fv[worst] = fr;
    } else {
      const xc = clamp(c.map((cv, j) => cv + 0.5 * (simplex[worst]![j]! - cv))); // contract
      const fc = await evaluate(xc);
      if (fc < fv[worst]!) { simplex[worst] = xc; fv[worst] = fc; }
      else {
        const b = simplex[best]!;
        for (let i = 0; i < simplex.length; i++) {
          if (i === best) continue;
          simplex[i] = simplex[i]!.map((v, j) => b[j]! + 0.5 * (v - b[j]!));
          fv[i] = await evaluate(simplex[i]!);
        }
      }
    }
  }

  const { best } = order();
  const x = simplex[best]!;
  const atBound = x.map((_, i) => i).filter((i) => {
    const [lo, hi] = box[i]!;
    if (!Number.isFinite(lo) && !Number.isFinite(hi)) return false;
    const eps = Math.max(1e-9, (hi - lo) * 1e-6);
    return x[i]! <= lo + eps || x[i]! >= hi - eps;
  });
  return { x, fx: fv[best]!, evals, converged, atBound };
}
