// ── Payoff optimisation ─────────────────────────────────────────────────────
// `solve` goal-seeks ONE knob to hit a target (bisection on a bracket).
// `calibrate` fits several knobs to observed data. Between them sat the question
// neither answers: *what settings make this model do best?* — several continuous
// knobs, no data to fit, an objective that is a metric of the run rather than a
// residual.
//
// The search is the same bounded Nelder–Mead calibration uses (simplex.ts); the
// only difference is the objective, which is why that was worth extracting.
// Everything else follows the house pattern: clone the model, rebind the knobs
// through `applyOverride`, run, reduce with `resolveMetric`.
//
// Two things this deliberately does not pretend:
//   • Nelder–Mead is a *local* search. A model with competing loops has local
//     optima, and the reported answer is the best point this search reached, not
//     a proof. `restarts` re-runs it from spread starting points, and the
//     spread of their results is the honest signal about how local it was.
//   • A knob with no declared range is unbounded, and an unbounded payoff search
//     walks somewhere absurd. `param x = 3 in 1..9` is how a model says what is
//     plausible, and this uses it exactly as global sensitivity and calibration do.

import type { Model } from "../lang/types.js";
import { simulateAsync } from "./simulator.js";
import { applyOverride } from "./overrides.js";
import { operatingPoint } from "./loops.js";
import { resolveMetric } from "./summarize.js";
import { paramRanges } from "./uncertainty.js";
import { knobParams } from "./grain.js";
import { minimize } from "./simplex.js";
import { u01 } from "./rng.js";

export interface OptimizeOptions {
  /** Knobs to vary. Defaults to every knob param (consts and switches excluded —
   *  a switch is discrete, and `policies` already enumerates those exactly). */
  params?: string[];
  /** The payoff, as a metric spec: `final:Cash`, `min:Runway`, `max:Infected`. */
  metric: string;
  /** Bigger is better (default) or smaller is better. */
  goal?: "max" | "min";
  /** Per-param `[lo, hi]`, overriding whatever the model declares. */
  bounds?: Record<string, [number, number]>;
  /** Fraction of the base value to explore when a knob declares no range.
   *  Default 0.5 (±50%) — wider than sensitivity's ±10%, because this is a
   *  search rather than a local gradient. */
  frac?: number;
  maxEvals?: number;
  tol?: number;
  /** Extra searches from spread starting points. Default 0. The spread of their
   *  answers is the only honest evidence about local optima. */
  restarts?: number;
  /** Seed for restart starting points, so a run is reproducible. Default 0. */
  seed?: number;
}

export interface OptimizeResult {
  /** The best settings found. */
  params: Record<string, number>;
  /** The metric at those settings. */
  value: number;
  /** The metric as the model is written. */
  base: number;
  /** value − base, in the direction of the goal (positive = an improvement). */
  gain: number;
  metric: string;
  goal: "max" | "min";
  evals: number;
  converged: boolean;
  /** The interval each knob was searched over, and whether the model declared it. */
  explored: Array<{ param: string; lo: number; hi: number; declared: boolean }>;
  /** Knobs whose answer sits on a bound — the search wanted to go further than
   *  the model said was plausible. Widen the range, or accept the corner. */
  atBound?: string[];
  /** One entry per additional restart: the metric it reached. A spread here
   *  means the surface has local optima and the winner is not a proof. */
  restarts?: number[];
  /** Set when the restarts disagreed materially — reported rather than hidden. */
  note?: string;
}

/** Metric of the model with these knob values applied. */
async function payoff(model: Model, params: string[], x: number[], metric: string): Promise<number> {
  const m = structuredClone(model);
  params.forEach((p, i) => applyOverride(m, `${p}=${x[i]}`));
  const res = await simulateAsync(m);
  return resolveMetric(res, metric);
}

export async function optimize(model: Model, opts: OptimizeOptions): Promise<OptimizeResult> {
  const goal = opts.goal ?? "max";
  const frac = opts.frac ?? 0.5;
  const base = operatingPoint(model);

  // Named knobs are validated before anything is filtered, so asking for a
  // switch is told what it is rather than reported as "no knobs at all".
  for (const p of opts.params ?? []) {
    const decl = model.varIndex.get(p);
    if (!decl) throw new Error(`optimize: no param named "${p}"`);
    if (decl.boolean) throw new Error(`optimize: "${p}" is a switch — it is discrete, so use \`policies\` to enumerate it exactly rather than searching over it`);
  }
  const params = knobParams(model, opts.params ?? []).filter((p) => !model.varIndex.get(p)?.boolean);
  if (!params.length) {
    throw new Error("optimize needs at least one knob — the model declares no varying param (const and switch are excluded; use `policies` for switches)");
  }

  // Bounds: an explicit override, else the model's declared range, else a ±frac
  // box around the base value. A declared range is used as written and never
  // widened — the same rule global-sensitivity follows.
  const declared = paramRanges(model, base);
  const explored = params.map((p) => {
    const given = opts.bounds?.[p];
    if (given) return { param: p, lo: given[0], hi: given[1], declared: false };
    const r = declared.get(p);
    if (r?.explicit) return { param: p, lo: r.lo, hi: r.hi, declared: true };
    const v = Number.isFinite(base[p]!) ? base[p]! : 0;
    const span = Math.abs(v) * frac || frac;
    return { param: p, lo: v - span, hi: v + span, declared: false };
  });
  for (const e of explored) {
    if (!(e.lo < e.hi)) throw new Error(`optimize: "${e.param}" has an empty range ${e.lo}..${e.hi}`);
  }
  const box = explored.map((e) => [e.lo, e.hi] as [number, number]);

  // Maximising is minimising the negation; a non-finite run is a heavy penalty
  // in whichever direction, never a winner.
  const sign = goal === "max" ? -1 : 1;
  const f = async (x: number[]) => {
    const v = await payoff(model, params, x, opts.metric);
    return Number.isFinite(v) ? sign * v : 1e9;
  };

  const baseValue = resolveMetric(await simulateAsync(structuredClone(model)), opts.metric);
  const clampToBox = (x: number[]) => x.map((v, i) => Math.min(box[i]![1], Math.max(box[i]![0], v)));
  const startAt = (k: number): number[] =>
    k === 0
      ? clampToBox(params.map((p) => (Number.isFinite(base[p]!) ? base[p]! : 0)))
      // Restarts are drawn from the counter-based PRNG rather than Math.random,
      // so `optimize` is as reproducible as everything else in the engine.
      : box.map(([lo, hi], i) => lo + (hi - lo) * u01(opts.seed ?? 0, k, i));

  const runs: Array<Awaited<ReturnType<typeof minimize>>> = [];
  for (let k = 0; k <= (opts.restarts ?? 0); k++) {
    runs.push(await minimize(f, {
      start: startAt(k),
      box,
      ...(opts.maxEvals !== undefined ? { maxEvals: opts.maxEvals } : {}),
      ...(opts.tol !== undefined ? { tol: opts.tol } : {}),
    }));
  }
  const best = runs.reduce((a, b) => (b.fx < a.fx ? b : a));
  const value = sign * best.fx;

  const out: Record<string, number> = {};
  params.forEach((p, i) => { out[p] = best.x[i]!; });
  const atBound = best.atBound.map((i) => params[i]!);
  const others = runs.filter((r) => r !== best).map((r) => sign * r.fx);
  const scale = Math.max(1e-12, Math.abs(value));
  const scattered = others.some((v) => Math.abs(v - value) / scale > 1e-3);

  return {
    params: out,
    value,
    base: baseValue,
    gain: goal === "max" ? value - baseValue : baseValue - value,
    metric: opts.metric,
    goal,
    evals: runs.reduce((n, r) => n + r.evals, 0),
    converged: best.converged,
    explored,
    ...(atBound.length ? { atBound } : {}),
    ...(others.length ? { restarts: others } : {}),
    ...(scattered
      ? { note: "the restarts landed on different answers — this surface has local optima, so the winner is the best point found, not the best there is" }
      : {}),
  };
}
