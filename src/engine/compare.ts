// ── Scenario comparison ──────────────────────────────────────────────────────
// The question a scenario exists to answer is "how does this policy change the
// outcome?" — so the primitive is: run the base model and each named scenario,
// reduce every run to the same handful of metrics, and return one row per
// scenario. A policy experiment then reads as a table, not as a pile of series.
// Built on structuredClone + applyScenario + resolveMetric, exactly like sweep.

import type { Model } from "../lang/types.js";
import { simulateAsync } from "./simulator.js";
import { applyScenario, BASE_SCENARIO } from "./overrides.js";
import { resolveMetric } from "./summarize.js";

export interface CompareRow {
  scenario: string;
  /** The scenario's bindings, as written (`key=value`); empty for base. */
  sets: string[];
  /** One value per requested metric, in order. */
  values: number[];
  /** Per-metric change versus the base row (values[i] − base[i]); absent on the base row. */
  delta?: number[];
  /** Carried from the run when it halted early (non-finite). */
  note?: string;
}

export interface CompareResult {
  metrics: string[];
  rows: CompareRow[];
}

/**
 * Run base + the chosen scenarios (default: every scenario in the model) and
 * reduce each to `metrics`. The base row always comes first so deltas have a
 * reference even when the caller picks a subset.
 */
export async function compareScenarios(model: Model, metrics: string[], scenarios?: string[]): Promise<CompareResult> {
  if (!metrics.length) throw new Error("compare needs at least one metric (e.g. final:Cash)");
  const names = scenarios?.length ? scenarios : [...model.scenarios.keys()];
  const rows: CompareRow[] = [];

  const runOne = async (name: string): Promise<CompareRow> => {
    const m = structuredClone(model);
    applyScenario(m, name);
    const res = await simulateAsync(m);
    const sc = model.scenarios.get(name);
    return {
      scenario: name,
      sets: sc ? sc.sets.map((s) => `${s.key}=${s.value}`) : [],
      values: metrics.map((spec) => resolveMetric(res, spec)),
      ...(res.note ? { note: res.note } : {}),
    };
  };

  const base = await runOne(BASE_SCENARIO);
  rows.push(base);
  for (const name of names) {
    if (name === BASE_SCENARIO) continue;
    const row = await runOne(name); // throws on an unknown scenario, with a hint
    row.delta = row.values.map((v, i) => v - base.values[i]!);
    rows.push(row);
  }
  return { metrics, rows };
}
