// ── Parameter sweep + sensitivity ───────────────────────────────────────────
// Turn a model into a function of one knob. Both reductions clone the parsed
// model, rebind one param/stock-init via applyOverride (a constant-folded AST
// edit — text stays canonical), run it, and read one scalar back out through
// resolveMetric. So an agent gets "how does the outcome move when I turn this?"
// without scripting a shell loop of --set runs or ingesting any raw series.
//
//   sweepParam  → the metric across a range of one knob (a response curve).
//   sensitivity → a ±frac one-factor-at-a-time bump of each param, ranked by how
//                 much it moves the metric (a tornado ordering of what matters).
//
// structuredClone gives each run an independent, internally-consistent Model
// (shared VarDecl identity across vars/varIndex/order is preserved), so points
// never contaminate each other or the caller's model.

import type { Model } from "../lang/types.js";
import { simulateAsync } from "./simulator.js";
import { applyOverride } from "./overrides.js";
import { resolveMetric } from "./summarize.js";
import { operatingPoint } from "./loops.js";
import { timeGrainParams, knobParams } from "./grain.js";

export interface SweepPoint {
  value: number;
  metric: number;
  /** Carried from res.note when this point's run halted early (non-finite). */
  note?: string;
}

export interface SweepResult {
  param: string;
  metric: string;
  /** The param's value in the unmodified model, for reference. */
  base?: number;
  points: SweepPoint[];
}

export interface SensitivityRow {
  param: string;
  base: number;
  /** Metric at base − |base|·frac and base + |base|·frac — or, for a switch, at off (0) and on (1). */
  low: number;
  high: number;
  /** high − low: signed swing in the metric across the ±frac bump (off → on for a switch). */
  delta: number;
  /** Set for a `switch`: the row compares off vs on rather than a ±frac bump. */
  switch?: true;
  /** The ± bump actually used when it isn't |base|·frac — a time-grain knob is
   *  bumped by at least one step (dt), since a smaller bump can't cross a step. */
  step?: number;
  /** low === high === the unbumped metric: the knob does nothing at this bump.
   *  Often real (a threshold not crossed) — a `sweep` over a wider range tells. */
  flat?: true;
}

export interface SensitivityResult {
  metric: string;
  frac: number;
  rows: SensitivityRow[];
}

/** The param's value at the model's t=start operating point, if numeric. */
function baseValue(model: Model, name: string): number | undefined {
  const v = operatingPoint(model)[name];
  return v !== undefined && Number.isFinite(v) ? v : undefined;
}

/** Run a clone with one override applied, reduced to a single metric. */
export async function metricWith(model: Model, spec: string, metric: string): Promise<{ metric: number; note?: string }> {
  const m = structuredClone(model);
  applyOverride(m, spec);
  const res = await simulateAsync(m);
  return { metric: resolveMetric(res, metric), ...(res.note ? { note: res.note } : {}) };
}

/** Sweep one knob across [from, to] (inclusive, `steps` samples) → response curve. */
export async function sweepParam(
  model: Model,
  param: string,
  range: { from: number; to: number; steps: number },
  metric: string,
): Promise<SweepResult> {
  const steps = Math.max(1, Math.floor(range.steps));
  const { from, to } = range;
  const points: SweepPoint[] = [];
  for (let i = 0; i < steps; i++) {
    const value = steps === 1 ? from : from + ((to - from) * i) / (steps - 1);
    const r = await metricWith(model, `${param}=${value}`, metric);
    points.push({ value, metric: r.metric, ...(r.note ? { note: r.note } : {}) });
  }
  return { param, metric, base: baseValue(model, param), points };
}

/**
 * One-factor-at-a-time sensitivity: bump each param by ±frac of its base value,
 * measure the metric at each end, and rank by the size of the swing. With no
 * `params`, every param in the model is tested. Non-numeric params are skipped.
 *
 * A `switch` is two-state, so a ±frac bump is meaningless for it (and actively
 * misleading: bumping 0 by ±0.1 lands on two truthy values, so the swing reads
 * as zero while flipping the switch could move the metric a lot). Switches are
 * measured at off (0) and on (1) instead.
 */
export async function sensitivity(
  model: Model,
  params: string[],
  metric: string,
  frac = 0.1,
): Promise<SensitivityResult> {
  const op = operatingPoint(model);
  const names = knobParams(model, params);
  const grid = timeGrainParams(model);
  const dt = model.settings.dt;
  let unbumped: number | undefined; // lazily: the metric with nothing changed
  const rows: SensitivityRow[] = [];
  for (const name of names) {
    const base = op[name];
    if (base === undefined || !Number.isFinite(base)) continue;
    if (model.varIndex.get(name)?.boolean) {
      const low = (await metricWith(model, `${name}=0`, metric)).metric;
      const high = (await metricWith(model, `${name}=1`, metric)).metric;
      rows.push({ param: name, base, low, high, delta: high - low, switch: true });
      continue;
    }
    const frac_d = base !== 0 ? Math.abs(base) * frac : frac;
    const onGrid = grid.has(name);
    const d = onGrid ? Math.max(frac_d, dt) : frac_d;
    const low = (await metricWith(model, `${name}=${base - d}`, metric)).metric;
    const high = (await metricWith(model, `${name}=${base + d}`, metric)).metric;
    const row: SensitivityRow = { param: name, base, low, high, delta: high - low };
    if (d !== frac_d) row.step = d;
    if (low === high) {
      unbumped ??= (await metricWith(model, `${name}=${base}`, metric)).metric;
      if (low === unbumped) row.flat = true;
    }
    rows.push(row);
  }
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { metric, frac, rows };
}
