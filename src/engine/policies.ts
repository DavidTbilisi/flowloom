// ── Policy search over switches ─────────────────────────────────────────────
// A `switch` is a yes/no move. The question a set of them poses is not "what
// does each do alone?" (that's `sensitivity`) but "which *combination* is worth
// it?" — moves interact: paying the Safe first and a 48-hour rule together may
// do less than the sum, or more. With n switches there are 2^n combinations;
// for the n a policy model actually has (≤ 12) that is a few thousand cheap
// runs, so enumerate them all and answer three things exactly:
//   • best      — the combination that maximises (or minimises) the metric;
//   • cheapest  — the lowest-cost combination that reaches a target;
//   • shapley   — each switch's average marginal contribution across every
//                 combination (the fair share of the total improvement, with
//                 interactions spread evenly), next to its effect alone.
// Built on structuredClone + applyOverride + resolveMetric like sweep.ts.

import type { Model } from "../lang/types.js";
import { simulateAsync } from "./simulator.js";
import { applyOverride } from "./overrides.js";
import { resolveMetric } from "./summarize.js";

export interface PolicyOptions {
  metric: string;
  /** Switches to search over. Default: every switch that is OFF as written —
   *  the moves still available. A switch that is on as written is a fact of the
   *  world (the vacation happens, the income gap happens) and stays as written
   *  unless named here, in which case its "on" is one of the moves. */
  switches?: string[];
  /** Whether a bigger metric is better (default "max"). */
  goal?: "max" | "min";
  /** A level the metric should reach; enables the `cheapest` answer. */
  target?: number;
  /** Cost of turning each switch on (default 1 each). */
  cost?: Record<string, number>;
  /** Refuse to enumerate more than this many switches (default 12 ⇒ 4096 runs). */
  maxSwitches?: number;
}

export interface PolicyCombo {
  /** The switches that are on. */
  on: string[];
  value: number;
  cost: number;
  note?: string;
}

export interface PolicyResult {
  metric: string;
  goal: "max" | "min";
  switches: string[];
  runs: number;
  /** Every searched switch off, everything else as written. With the default
   *  switch set this IS the model as written. */
  base: PolicyCombo;
  /** The model as written (differs from `base` only when a searched switch is on as written). */
  asWritten: PolicyCombo;
  best: PolicyCombo;
  /** Lowest-cost combination reaching the target (ties: better metric); null if none does. */
  cheapest?: PolicyCombo | null;
  target?: number;
  shapley: Array<{
    switch: string;
    /** Average marginal contribution across all combinations (signed, in metric units). */
    shapley: number;
    /** Effect of turning only this switch on, from all-off. */
    alone: number;
    /** Effect of turning this switch on, given every other switch is on. */
    last: number;
    cost: number;
  }>;
  /** All combinations, best first. */
  combos: PolicyCombo[];
}

/** Enumerate every on/off combination of the chosen switches. */
export async function searchPolicies(model: Model, opts: PolicyOptions): Promise<PolicyResult> {
  const goal = opts.goal ?? "max";
  const all = model.vars.filter((v) => v.kind === "param" && v.boolean).map((v) => v.name);
  const isOn = (name: string) => { const e = model.varIndex.get(name)!.expr; return e.kind === "num" && e.value !== 0; };
  const switches = opts.switches?.length ? opts.switches : all.filter((s) => !isOn(s));
  if (!all.length) throw new Error("the model declares no `switch` lines — add e.g. `switch separate = off`");
  if (!switches.length) throw new Error(`every switch is already on as written (${all.join(", ")}) — name the ones to search with --switch`);
  for (const s of switches) {
    const v = model.varIndex.get(s);
    if (!v) throw new Error(`no switch named "${s}" (have: ${all.join(", ") || "none"})`);
    if (!v.boolean) throw new Error(`"${s}" is a ${v.kind}, not a switch — policy search enumerates on/off switches only`);
  }
  const cap = opts.maxSwitches ?? 12;
  if (switches.length > cap) {
    throw new Error(`${switches.length} switches ⇒ ${2 ** switches.length} runs; pick a subset with --switch a,b,c (cap ${cap} ⇒ ${2 ** cap} runs)`);
  }
  const n = switches.length;
  const costOf = (s: string) => opts.cost?.[s] ?? 1;
  const better = (a: number, b: number) => (goal === "max" ? a > b : a < b);
  const reaches = (v: number) => (opts.target === undefined ? true : goal === "max" ? v >= opts.target : v <= opts.target);

  // value(mask) for every mask
  const values = new Float64Array(1 << n);
  const notes = new Map<number, string>();
  for (let mask = 0; mask < 1 << n; mask++) {
    const m = structuredClone(model);
    switches.forEach((s, i) => applyOverride(m, `${s}=${mask & (1 << i) ? 1 : 0}`));
    const res = await simulateAsync(m);
    values[mask] = resolveMetric(res, opts.metric);
    if (res.note) notes.set(mask, res.note);
  }
  const combo = (mask: number): PolicyCombo => {
    const on = switches.filter((_, i) => mask & (1 << i));
    const note = notes.get(mask);
    return { on, value: values[mask]!, cost: on.reduce((c, s) => c + costOf(s), 0), ...(note ? { note } : {}) };
  };

  // the model as written
  let writtenMask = 0;
  switches.forEach((s, i) => { if (isOn(s)) writtenMask |= 1 << i; });

  let bestMask = 0;
  for (let mask = 1; mask < 1 << n; mask++) if (better(values[mask]!, values[bestMask]!)) bestMask = mask;

  let cheapest: PolicyCombo | null | undefined;
  if (opts.target !== undefined) {
    cheapest = null;
    for (let mask = 0; mask < 1 << n; mask++) {
      if (!reaches(values[mask]!)) continue;
      const c = combo(mask);
      if (!cheapest || c.cost < cheapest.cost || (c.cost === cheapest.cost && better(c.value, cheapest.value))) cheapest = c;
    }
  }

  // Exact Shapley values: φ_i = Σ_{S ∌ i} |S|!(n−|S|−1)!/n! · (v(S∪{i}) − v(S)).
  const fact = (k: number): number => (k <= 1 ? 1 : k * fact(k - 1));
  const weight = (size: number) => (fact(size) * fact(n - size - 1)) / fact(n);
  const popcount = (x: number) => { let c = 0; while (x) { c += x & 1; x >>= 1; } return c; };
  const full = (1 << n) - 1;
  const shapley = switches.map((s, i) => {
    let phi = 0;
    for (let mask = 0; mask < 1 << n; mask++) {
      if (mask & (1 << i)) continue;
      phi += weight(popcount(mask)) * (values[mask | (1 << i)]! - values[mask]!);
    }
    return { switch: s, shapley: phi, alone: values[1 << i]! - values[0]!, last: values[full]! - values[full & ~(1 << i)]!, cost: costOf(s) };
  });
  shapley.sort((a, b) => Math.abs(b.shapley) - Math.abs(a.shapley));

  const combos: PolicyCombo[] = [];
  for (let mask = 0; mask < 1 << n; mask++) combos.push(combo(mask));
  combos.sort((a, b) => (goal === "max" ? b.value - a.value : a.value - b.value) || a.cost - b.cost);

  return {
    metric: opts.metric,
    goal,
    switches,
    runs: 1 << n,
    base: combo(0),
    asWritten: combo(writtenMask),
    best: combo(bestMask),
    ...(opts.target !== undefined ? { target: opts.target, cheapest } : {}),
    shapley,
    combos,
  };
}
