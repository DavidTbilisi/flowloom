// ── Monte Carlo ensemble ─────────────────────────────────────────────────────
// Run a model N times under its declared uncertainty and summarize the spread as
// per-timestep percentile bands. Same shape as sweep.ts/solve.ts: clone the
// model, rebind via applyOverride, run, and aggregate — so an agent gets "what's
// the distribution of outcomes?" without scripting a loop of --set runs or
// ingesting every raw trajectory.
//
// Two independent sources of spread, and a run varies both:
//   • the RNG seed, for a model that calls random*()
//   • every `param … ± tol` / `in lo..hi`, sampled ONCE per run
// The second is what makes this useful on a deterministic model. Sampling a
// param once per run is the whole point and is not the same as writing
// `param x = random_normal(…)`, which resamples every step — that is noise
// inside the model, not uncertainty about a constant.
//
// Sampling draws from the same counter-based PRNG the engine uses (rng.ts),
// keyed on the run index, so an ensemble is reproducible: same seed, same bands.
//
// All runs share the dt/to/start grid, so the i-th sample of every run lines up
// in time and the bands are just per-column order statistics across the N runs.

import type { Model } from "../lang/types.js";
import { simulateAsync } from "./simulator.js";
import { applyOverride } from "./overrides.js";
import { paramRanges, type ParamRange } from "./uncertainty.js";
import { u01 } from "./rng.js";

export interface Bands {
  p05: number[];
  p25: number[];
  p50: number[];
  p75: number[];
  p95: number[];
  mean: number[];
}

export interface EnsembleResult {
  runs: number;
  /** Base seed; run i used seed = baseSeed + i. */
  baseSeed: number;
  t: number[];
  /** Output series the bands were computed for. */
  series: string[];
  bands: Map<string, Bands>;
  /** Params sampled per run, with the bounds they were sampled over. Empty when
   *  the model declares no ranges — in which case only the seed varied, and on a
   *  deterministic model the bands will be flat. */
  sampled: ParamRange[];
  /** One note per run that halted early (non-finite), if any. */
  notes?: string[];
}

/** Linear-interpolated percentile of an already-sorted ascending array. */
function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0]!;
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

export interface MonteCarloOptions {
  runs: number;
  /** Seed of the first run (defaults to the model's `sim seed`, or 0). */
  seed?: number;
  /** Series to band (defaults to the model's `plot` line, else every output). */
  series?: string[];
  /** Restrict per-run param sampling to these names (default: every param that
   *  declares a range). Pass `[]` to sample none and vary only the seed. */
  params?: string[];
}

/**
 * Run `runs` simulations at seeds baseSeed, baseSeed+1, … and reduce each output
 * series to percentile bands (p05/p25/p50/p75/p95 + mean) at every timestep.
 */
export async function monteCarlo(model: Model, opts: MonteCarloOptions): Promise<EnsembleResult> {
  const runs = Math.max(1, Math.floor(opts.runs));
  const baseSeed = opts.seed ?? model.settings.seed ?? 0;

  const declared = paramRanges(model);
  const sampled = (opts.params ? opts.params.map((n) => declared.get(n)).filter((r): r is ParamRange => !!r) : [...declared.values()]);

  const results = [];
  const notes: string[] = [];
  for (let i = 0; i < runs; i++) {
    const m = structuredClone(model);
    applyOverride(m, `seed=${baseSeed + i}`);
    // One draw per param per run, from the engine's own counter-based PRNG so
    // the ensemble is reproducible. Uniform over the declared bounds: the
    // language states a range, not a distribution, and inventing a shape the
    // modeller didn't write would put weight where they never asked for it.
    sampled.forEach((r, k) => {
      applyOverride(m, `${r.name}=${r.lo + u01(baseSeed, i, k) * (r.hi - r.lo)}`);
    });
    const res = await simulateAsync(m);
    results.push(res);
    if (res.note) notes.push(`seed ${baseSeed + i}: ${res.note}`);
  }

  // Align on the shortest run so every timestep has a value from each run.
  const first = results[0]!;
  const wanted = opts.series?.length ? opts.series : model.plot.length ? model.plot : first.names;
  const series = wanted.filter((n) => first.series.has(n));
  const len = results.reduce((min, r) => Math.min(min, r.t.length), first.t.length);
  const t = first.t.slice(0, len);

  const bands = new Map<string, Bands>();
  for (const name of series) {
    const cols = results.map((r) => r.series.get(name)!);
    const b: Bands = { p05: [], p25: [], p50: [], p75: [], p95: [], mean: [] };
    for (let i = 0; i < len; i++) {
      const col = cols.map((c) => c[i]!).sort((x, y) => x - y);
      b.p05.push(percentile(col, 0.05));
      b.p25.push(percentile(col, 0.25));
      b.p50.push(percentile(col, 0.5));
      b.p75.push(percentile(col, 0.75));
      b.p95.push(percentile(col, 0.95));
      b.mean.push(col.reduce((s, v) => s + v, 0) / col.length);
    }
    bands.set(name, b);
  }

  return { runs, baseSeed, t, series, bands, sampled, ...(notes.length ? { notes } : {}) };
}
