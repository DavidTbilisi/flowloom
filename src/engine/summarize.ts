// ── Run summaries + scalar metrics ──────────────────────────────────────────
// Two pure, DOM-free reductions of a SimResult, for the headless consumers (CLI
// `summary`, MCP `flow_summary`) and as the substrate the parameter-sweep and
// goal-seek features build on:
//   summarizeRun  → a compact, classified view of each series (start/final,
//                   extrema, a behaviour label, settling) so an agent can read
//                   *what a run did* without ingesting thousands of floats.
//   resolveMetric → one scalar out of a run by a string spec ("final:Cash",
//                   "max:Infected", "at:50:Stock"). A string so it travels
//                   through a CLI flag or an MCP arg unchanged; the same hook a
//                   sweep or a solve reduces a run through.
// Classification is heuristic but fully deterministic — no randomness, no eval —
// so the contract tests can pin labels against the closed-form examples.

import type { SimResult } from "./simulator.js";

export type Behavior =
  | "constant"
  | "linear"
  | "growth"
  | "decay"
  | "s-shaped"
  | "overshoot"
  | "oscillation-damped"
  | "oscillation-sustained"
  | "equilibrium";

export interface SeriesSummary {
  name: string;
  start: number;
  final: number;
  min: { value: number; t: number };
  max: { value: number; t: number };
  monotonic: "up" | "down" | "none";
  behavior: Behavior;
  settled: boolean;
  /** First time the series enters (and stays inside) a ±2%-of-range band around `final`. */
  settleTime?: number;
  /** Interior local maxima — the hump count for oscillation/overshoot. */
  peaks?: number;
  /** Mean peak-to-peak time, when there are ≥2 interior maxima. */
  period?: number;
  /** Carried from res.note when the run halted early on this/any series. */
  note?: string;
}

export interface RunSummary {
  dt: number;
  method: "euler" | "rk4";
  steps: number;
  tStart: number;
  tEnd: number;
  note?: string;
  series: SeriesSummary[];
}

/**
 * Interior turning points of a series, ignoring wiggles below `eps`. A reversal
 * is only confirmed once the value pulls back more than `eps` from the running
 * extreme, so numerical noise near a plateau doesn't register as oscillation.
 */
function turningPoints(v: number[], eps: number): Array<{ idx: number; kind: "max" | "min" }> {
  const tp: Array<{ idx: number; kind: "max" | "min" }> = [];
  let dir = 0; // +1 rising, -1 falling, 0 not yet broken out of the start deadband
  let extIdx = 0; // index of the running extreme in the current direction
  for (let i = 1; i < v.length; i++) {
    if (dir === 0) {
      // Seed the direction from the first move beyond eps; until then track the
      // running extreme so the seed sits at the true local extreme.
      if (v[i]! > v[extIdx]! + eps) dir = 1;
      else if (v[i]! < v[extIdx]! - eps) dir = -1;
      else { if (v[i]! > v[extIdx]!) extIdx = i; continue; }
    }
    if (dir > 0) {
      if (v[i]! >= v[extIdx]!) extIdx = i; // extend the running max
      else if (v[i]! < v[extIdx]! - eps) { tp.push({ idx: extIdx, kind: "max" }); dir = -1; extIdx = i; }
    } else {
      if (v[i]! <= v[extIdx]!) extIdx = i; // extend the running min
      else if (v[i]! > v[extIdx]! + eps) { tp.push({ idx: extIdx, kind: "min" }); dir = 1; extIdx = i; }
    }
  }
  return tp;
}

/** Classify one series' dynamics into a single behaviour label. */
function classify(v: number[], t: number[]): {
  behavior: Behavior;
  monotonic: SeriesSummary["monotonic"];
  settled: boolean;
  settleTime?: number;
  peaks?: number;
  period?: number;
} {
  const n = v.length;
  const final = v[n - 1]!;
  let lo = Infinity, hi = -Infinity;
  for (const x of v) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  const range = hi - lo;
  const scale = Math.max(range, Math.abs(final), 1);

  // Settling: the longest contiguous tail that stays within ±2% of range of `final`.
  const band = Math.max(range * 0.02, scale * 1e-9);
  let settleIdx = n - 1;
  for (let i = n - 1; i >= 0; i--) {
    if (Math.abs(v[i]! - final) <= band) settleIdx = i;
    else break;
  }
  const settled = settleIdx >= 1 && settleIdx <= n - 2;
  const settleTime = settled ? t[settleIdx]! : undefined;

  // Essentially flat over the whole run.
  if (range <= scale * 1e-9) {
    return { behavior: "constant", monotonic: "none", settled: false };
  }

  const tp = turningPoints(v, range * 0.01);
  const maxima = tp.filter((p) => p.kind === "max");
  const peaks = maxima.length;
  const period =
    maxima.length >= 2
      ? (t[maxima[maxima.length - 1]!.idx]! - t[maxima[0]!.idx]!) / (maxima.length - 1)
      : undefined;

  // ≥2 alternating extrema → an oscillation; shrinking swings ⇒ damped.
  if (tp.length >= 2) {
    const amp = (a: number, b: number) => Math.abs(v[a]! - v[b]!);
    const first = amp(tp[0]!.idx, tp[1]!.idx);
    const last = amp(tp[tp.length - 2]!.idx, tp[tp.length - 1]!.idx);
    const behavior: Behavior = last < first * 0.66 ? "oscillation-damped" : "oscillation-sustained";
    // A sustained oscillation never settles; a tail that happens to sit near a
    // swing's end isn't convergence.
    if (behavior === "oscillation-sustained") return { behavior, monotonic: "none", settled: false, peaks, period };
    return { behavior, monotonic: "none", settled, settleTime, peaks, period };
  }

  // Exactly one interior hump/dip then a reversal → an overshoot.
  if (tp.length === 1) {
    return { behavior: "overshoot", monotonic: "none", settled, settleTime, peaks, period };
  }

  // Monotone from here on.
  const dir: SeriesSummary["monotonic"] = final > v[0]! ? "up" : final < v[0]! ? "down" : "none";

  // Where is the steepest step? (start ⇒ relaxation; interior ⇒ sigmoid; end ⇒ accelerating.)
  let maxStep = 0, stepIdx = 0;
  for (let i = 1; i < n; i++) {
    const s = Math.abs(v[i]! - v[i - 1]!);
    if (s > maxStep) {
      maxStep = s;
      stepIdx = i;
    }
  }
  const interiorPeak = stepIdx > n * 0.1 && stepIdx < n * 0.9;

  if (settled) {
    // Reached an asymptote. An up-going sigmoid (accelerate then decelerate) is
    // the S-curve; anything else that settles is treated as reaching equilibrium.
    if (dir === "up" && interiorPeak) return { behavior: "s-shaped", monotonic: dir, settled, settleTime };
    return { behavior: "equilibrium", monotonic: dir, settled, settleTime };
  }

  // Still moving at the horizon. Constant slope ⇒ linear; else growth/decay by direction.
  const totalStep = Math.abs(final - v[0]!);
  const avgStep = totalStep / (n - 1);
  const nearLinear = maxStep <= avgStep * 1.25;
  if (nearLinear) return { behavior: "linear", monotonic: dir, settled: false };
  return { behavior: dir === "down" ? "decay" : "growth", monotonic: dir, settled: false };
}

/** Compact, classified view of a run — one SeriesSummary per chosen series. */
export function summarizeRun(res: SimResult, names?: string[]): RunSummary {
  const t = res.t;
  const cols = names?.length ? names : res.stockNames.length ? [...res.stockNames, ...res.varNames] : res.names;
  const series = cols.map((name) => {
    const v = res.series.get(name);
    if (!v) throw new Error(`no series named "${name}" (have: ${res.names.join(", ")})`);
    let lo = Infinity, hi = -Infinity, loI = 0, hiI = 0;
    for (let i = 0; i < v.length; i++) {
      if (v[i]! < lo) { lo = v[i]!; loI = i; }
      if (v[i]! > hi) { hi = v[i]!; hiI = i; }
    }
    const c = classify(v, t);
    const s: SeriesSummary = {
      name,
      start: v[0]!,
      final: v[v.length - 1]!,
      min: { value: lo, t: t[loI]! },
      max: { value: hi, t: t[hiI]! },
      monotonic: c.monotonic,
      behavior: c.behavior,
      settled: c.settled,
      ...(c.settleTime !== undefined ? { settleTime: c.settleTime } : {}),
      ...(c.peaks ? { peaks: c.peaks } : {}),
      ...(c.period !== undefined ? { period: c.period } : {}),
      ...(res.note ? { note: res.note } : {}),
    };
    return s;
  });
  return {
    dt: res.dt,
    method: res.method,
    steps: t.length,
    tStart: t[0]!,
    tEnd: t[t.length - 1]!,
    ...(res.note ? { note: res.note } : {}),
    series,
  };
}

/** Look up one series' values, with a clear error listing what's available. */
function getSeries(res: SimResult, name: string): number[] {
  const v = res.series.get(name);
  if (!v) throw new Error(`no series named "${name}" (have: ${res.names.join(", ")})`);
  return v;
}

/** Linear-interpolated value of a series at simulation time `time`. */
function valueAt(res: SimResult, v: number[], time: number): number {
  const t = res.t;
  if (time <= t[0]!) return v[0]!;
  if (time >= t[t.length - 1]!) return v[v.length - 1]!;
  let i = 1;
  while (i < t.length && t[i]! < time) i++;
  const t0 = t[i - 1]!, t1 = t[i]!;
  const f = t1 === t0 ? 0 : (time - t0) / (t1 - t0);
  return v[i - 1]! + f * (v[i]! - v[i - 1]!);
}

/**
 * Reduce a run to one number by a string spec — the shared output-metric hook:
 *   final:<series>  max:<series>  min:<series>  mean:<series>
 *   at:<t>:<series>  time-to-peak:<series>  settle-time:<series>
 * Throws on an unknown op, a malformed spec, or an unknown series name.
 */
export function resolveMetric(res: SimResult, spec: string): number {
  const parts = spec.split(":");
  const op = parts[0]!.trim();

  if (op === "at") {
    if (parts.length !== 3) throw new Error(`metric "at" expects at:<time>:<series>, got "${spec}"`);
    const time = Number(parts[1]);
    if (!Number.isFinite(time)) throw new Error(`metric "at" time must be a number, got "${parts[1]}"`);
    const name = parts[2]!.trim();
    return valueAt(res, getSeries(res, name), time);
  }

  if (parts.length !== 2) throw new Error(`metric expects <op>:<series>, got "${spec}"`);
  const name = parts[1]!.trim();
  const v = getSeries(res, name);

  switch (op) {
    case "final":
      return v[v.length - 1]!;
    case "max":
      return Math.max(...v);
    case "min":
      return Math.min(...v);
    case "mean":
      return v.reduce((a, b) => a + b, 0) / v.length;
    case "time-to-peak": {
      let hi = -Infinity, hiI = 0;
      for (let i = 0; i < v.length; i++) if (v[i]! > hi) { hi = v[i]!; hiI = i; }
      return res.t[hiI]!;
    }
    case "settle-time": {
      const s = summarizeRun(res, [name]).series[0]!;
      if (s.settleTime === undefined) throw new Error(`"${name}" never settles within the run`);
      return s.settleTime;
    }
    default:
      throw new Error(
        `unknown metric "${op}" — use final|max|min|mean|at:<t>|time-to-peak|settle-time`,
      );
  }
}
