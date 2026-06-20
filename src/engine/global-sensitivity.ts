// ── Global sensitivity analysis ──────────────────────────────────────────────
// The existing `sensitivity` (sweep.ts) is one-factor-at-a-time around the base
// point — a local tornado. This adds two *global* methods that vary all params
// together across their ranges:
//
//   morris — elementary-effects screening (cheap): per-param mu* (importance) and
//            sigma (nonlinearity/interaction). Good for ranking many params.
//   sobol  — variance-based (Saltelli): first-order S1 (a param's own share of
//            output variance) and total-order ST (its share including interactions).
//
// Same trial machinery as sweep/solve: clone the model, rebind params via
// applyOverride, run simulateAsync, reduce with resolveMetric. Sampling uses the
// engine's seeded PRNG (rng.ts) so results are reproducible with no new dependency.

import type { Model } from "../lang/types.js";
import { simulateAsync } from "./simulator.js";
import { applyOverride } from "./overrides.js";
import { resolveMetric } from "./summarize.js";
import { operatingPoint } from "./loops.js";
import { u01 } from "./rng.js";

export interface GsaRow {
  param: string;
  base: number;
  /** Morris: mean of |elementary effects| (importance). */
  muStar?: number;
  /** Morris: std of elementary effects (nonlinearity / interactions). */
  sigma?: number;
  /** Sobol: first-order index (own-variance share). */
  s1?: number;
  /** Sobol: total-order index (incl. interactions). */
  st?: number;
}

export interface GsaResult {
  method: "morris" | "sobol";
  metric: string;
  /** Total model runs performed. */
  runs: number;
  /** Ranked most-influential first (by mu* / ST). */
  rows: GsaRow[];
}

export interface GsaOptions {
  method: "morris" | "sobol";
  metric: string;
  /** Params to vary (default: every param in the model). */
  params?: string[];
  /** Half-width of each param's range as a fraction of its base value (default 0.1). */
  frac?: number;
  /** Morris: number of trajectories (default 10). Sobol: base sample size N (default 128). */
  samples?: number;
  /** PRNG seed for sampling (default 1). */
  seed?: number;
}

interface Range { name: string; base: number; lo: number; hi: number }

/** Build [base-d, base+d] ranges for the chosen (numeric) params. */
function ranges(model: Model, params: string[], frac: number): Range[] {
  const op = operatingPoint(model);
  const out: Range[] = [];
  for (const name of params) {
    const base = op[name];
    if (base === undefined || !Number.isFinite(base)) continue;
    const d = base !== 0 ? Math.abs(base) * frac : frac;
    out.push({ name, base, lo: base - d, hi: base + d });
  }
  return out;
}

/** Run the model with each param set to a point value and reduce to one metric. */
async function evalAt(model: Model, rs: Range[], point: number[], metric: string): Promise<number> {
  const m = structuredClone(model);
  rs.forEach((r, i) => applyOverride(m, `${r.name}=${point[i]}`));
  const res = await simulateAsync(m);
  return resolveMetric(res, metric);
}

const mapPoint = (rs: Range[], unit: number[]): number[] => rs.map((r, i) => r.lo + unit[i]! * (r.hi - r.lo));

export async function globalSensitivity(model: Model, opts: GsaOptions): Promise<GsaResult> {
  const frac = opts.frac ?? 0.1;
  const seed = opts.seed ?? 1;
  const names = opts.params?.length ? opts.params : model.vars.filter((v) => v.kind === "param").map((v) => v.name);
  const rs = ranges(model, names, frac);
  if (!rs.length) return { method: opts.method, metric: opts.metric, runs: 0, rows: [] };

  return opts.method === "morris"
    ? morris(model, rs, opts.metric, opts.samples ?? 10, seed)
    : sobol(model, rs, opts.metric, opts.samples ?? 128, seed);
}

// ── Morris elementary effects ────────────────────────────────────────────────
async function morris(model: Model, rs: Range[], metric: string, traj: number, seed: number): Promise<GsaResult> {
  const delta = 0.1; // step in normalized [0,1] space
  const effects: number[][] = rs.map(() => []);
  let runs = 0;

  for (let t = 0; t < traj; t++) {
    // random base point + a deterministic per-trajectory factor order
    const base = rs.map((_, i) => u01(seed, t, i));
    const order = rs.map((_, i) => i).sort((a, b) => u01(seed, t + 1000, a) - u01(seed, t + 1000, b));

    let prev = base.slice();
    let yPrev = await evalAt(model, rs, mapPoint(rs, prev), metric); runs++;
    for (const i of order) {
      const step = prev[i]! + delta <= 1 ? delta : -delta; // stay inside [0,1]
      const next = prev.slice();
      next[i] = prev[i]! + step;
      const yNext = await evalAt(model, rs, mapPoint(rs, next), metric); runs++;
      if (Number.isFinite(yNext) && Number.isFinite(yPrev)) effects[i]!.push((yNext - yPrev) / step);
      prev = next; yPrev = yNext;
    }
  }

  const rows: GsaRow[] = rs.map((r, i) => {
    const ee = effects[i]!;
    const muStar = ee.length ? ee.reduce((s, v) => s + Math.abs(v), 0) / ee.length : 0;
    const mean = ee.length ? ee.reduce((s, v) => s + v, 0) / ee.length : 0;
    const sigma = ee.length > 1 ? Math.sqrt(ee.reduce((s, v) => s + (v - mean) ** 2, 0) / (ee.length - 1)) : 0;
    return { param: r.name, base: r.base, muStar, sigma };
  });
  rows.sort((a, b) => (b.muStar ?? 0) - (a.muStar ?? 0));
  return { method: "morris", metric, runs, rows };
}

// ── Sobol indices (Saltelli estimators) ──────────────────────────────────────
async function sobol(model: Model, rs: Range[], metric: string, N: number, seed: number): Promise<GsaResult> {
  const k = rs.length;
  // Two independent sample matrices A, B in [0,1]^k. Draw every uniform from a
  // single monotonic counter so each has a distinct, well-mixed hash input
  // (adjacent seed namespaces produced correlated columns and broke the ST estimate).
  let ctr = 0;
  const draw = () => u01(seed, ctr++, 0);
  const A = Array.from({ length: N }, () => rs.map(draw));
  const B = Array.from({ length: N }, () => rs.map(draw));

  const run = (rows: number[][]) => Promise.all(rows.map((u) => evalAt(model, rs, mapPoint(rs, u), metric)));
  const yA = await run(A);
  const yB = await run(B);

  // mean/variance from the combined A∪B sample.
  const all = [...yA, ...yB].filter(Number.isFinite);
  const mean = all.reduce((s, v) => s + v, 0) / all.length;
  const variance = all.reduce((s, v) => s + (v - mean) ** 2, 0) / all.length || 1;

  const rows: GsaRow[] = [];
  let runs = 2 * N;
  for (let i = 0; i < k; i++) {
    const ABi = A.map((row, j) => row.map((v, c) => (c === i ? B[j]![c]! : v)));
    const yABi = await run(ABi); runs += N;
    // Saltelli (2010) estimators.
    let s1 = 0, st = 0;
    for (let j = 0; j < N; j++) {
      // Mean-centre the S1 estimator — without it the large output mean dominates
      // and the estimate is wildly noisy (even negative); ST uses differences so
      // the mean already cancels.
      s1 += (yB[j]! - mean) * (yABi[j]! - yA[j]!);
      st += (yA[j]! - yABi[j]!) ** 2;
    }
    rows.push({
      param: rs[i]!.name, base: rs[i]!.base,
      s1: s1 / N / variance,
      st: st / (2 * N) / variance,
    });
  }
  rows.sort((a, b) => (b.st ?? 0) - (a.st ?? 0));
  return { method: "sobol", metric, runs, rows };
}
