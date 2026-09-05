// ── Numerical integrity ─────────────────────────────────────────────────────
// Everything else in flowloom validates the *text*: the parser rejects bad
// syntax, `lint` flags dead knobs and bad units, `expect` pins the numbers. But
// nothing asks whether the numbers themselves are right — the integrator is
// fixed-step (euler/rk4/map, codegen.ts `runIntegration`), so it has no error
// estimate and no way to say "dt is too large". A model can converge on a
// confidently wrong trajectory and every surface downstream — plot, loops,
// calibration, MCP — reports it as fact.
//
// This module is the missing question. It runs the model again at half the
// step and asks whether the answer moved: the standard system-dynamics
// refinement test, and cheap here because the engine already re-runs whole
// models for sweep/sensitivity/dominance/diff. When the answer *does* move it
// keeps halving to find a dt that holds still, so the report can suggest one.
//
// Alongside the refinement it carries three static advisories — the failure
// modes a single refinement can miss or misattribute (discontinuities under
// rk4, dt-dependent noise, dt against the fastest time constant).
//
// DOM-free like the rest of src/engine, so the CLI, MCP and the worker all get
// it. It is opt-in everywhere: it costs two or more extra runs.

import type { Expr, Loc, Model, SimSettings } from "../lang/types.js";
import { declExprs, freeVars } from "../lang/expr.js";
import { simulateAsync, type SimResult } from "./simulator.js";
import { interpAt, nrmse } from "./fit.js";
import { STATEFUL, FIXED_DELAY } from "./builtins.js";
import { RANDOM_FNS } from "./rng.js";
import { operatingPoint } from "./loops.js";

/** Stateful builtins whose 2nd argument is a time constant τ (STATEFUL minus the
 *  fixed-delay pair, which take a pipeline length in steps rather than a τ). */
const TAU_BUILTINS = new Set([...STATEFUL].filter((n) => !FIXED_DELAY.has(n)));

const COMPARISONS = new Set(["==", "!=", "<", "<=", ">", ">="]);

/** One hit per source line: an `if(Stock > k, …)` is one problem, not two (the
 *  call and the comparison inside it), and two branches on a line read as one. */
function byLine(locs: Loc[]): Loc[] {
  const seen = new Set<number>();
  return locs.filter((l) => (seen.has(l.line) ? false : (seen.add(l.line), true)));
}

/** Per-series discrepancy between a run and the same run at half the step. */
export interface NumericsSeries {
  name: string;
  /** Discrepancy vs the refined run, normalised by the refined run's range. */
  nrmse: number;
  converged: boolean;
}

export type AdvisoryKind = "discontinuity" | "noise" | "time-constant";

/** A static finding about the *method*, read off the AST rather than the run. */
export interface NumericsAdvisory {
  kind: AdvisoryKind;
  message: string;
  loc?: Loc;
}

export interface NumericsReport {
  /** Did halving dt leave every compared series inside `tol`? */
  converged: boolean;
  tol: number;
  dt: number;
  method: SimSettings["method"];
  /** The step the run was compared against (dt/2), when a refinement ran. */
  refinedDt?: number;
  series: NumericsSeries[];
  /** The series that moved most under refinement. */
  worst?: { name: string; nrmse: number };
  /** A step at which refinement does hold still, found by halving. Absent when
   *  the run already converged, or when no tested step did. */
  suggestedDt?: number;
  /** The halving ladder actually walked: each step and how far the answer moved
   *  between it and the next one down. Lets a reader see whether refinement was
   *  converging (each rung smaller) or not (flat / growing / non-finite). */
  refinements: Array<{ dt: number; worst: number }>;
  /** Cross-check against the other continuous method at the model's own dt. */
  methodAgreement?: { other: "euler" | "rk4"; converged: boolean; worst?: { name: string; nrmse: number } };
  advisories: NumericsAdvisory[];
  /** Run notes (an early halt, a qualitative sketch) and anything skipped. */
  notes: string[];
  /** Total simulations performed, so a caller can explain the cost. */
  runs: number;
}

export interface NumericsOptions {
  /** Convergence threshold on normalised RMSE. Default 1e-3 (0.1 % of range). */
  tol?: number;
  /** How many further halvings to try when looking for a workable dt. Default 4. */
  maxRefinements?: number;
  /** Series to compare. Default: the stocks — integration error lives in the
   *  states, and every flow/aux is derived from them. */
  series?: string[];
  /** Give up refining past this many steps in one run. Default 4,000,000. */
  maxSteps?: number;
}

const DEFAULTS = { tol: 1e-3, maxRefinements: 4, maxSteps: 4_000_000 } as const;

const stepCount = (s: SimSettings, dt: number) => Math.max(1, Math.round((s.to - s.start) / dt));

/** Clone a model with a different step. `structuredClone` is what calibrate.ts
 *  already uses to get an independent Model, Maps and all. */
function atDt(model: Model, dt: number): Model {
  const m = structuredClone(model);
  m.settings.dt = dt;
  return m;
}

/**
 * Compare two runs of the same model on the coarser one's time grid.
 * `fine` is the reference: each series is normalised by *its* range, so the
 * number reads as "how far off is the coarse run, as a fraction of the swing".
 */
function discrepancy(coarse: SimResult, fine: SimResult, names: string[], tol: number): NumericsSeries[] {
  const out: NumericsSeries[] = [];
  for (const name of names) {
    const c = coarse.series.get(name);
    const f = fine.series.get(name);
    if (!c || !f || c.length === 0 || f.length === 0) continue;
    const ref = coarse.t.map((time) => interpAt(fine.t, f, time));
    const value = nrmse(c, ref);
    out.push({ name, nrmse: value, converged: Number.isFinite(value) && value <= tol });
  }
  return out;
}

const worstOf = (rows: NumericsSeries[]): { name: string; nrmse: number } | undefined => {
  let worst: NumericsSeries | undefined;
  for (const r of rows) if (!worst || !(r.nrmse <= worst.nrmse)) worst = r; // NaN sorts to the top
  return worst ? { name: worst.name, nrmse: worst.nrmse } : undefined;
};

/**
 * Check whether the run's numbers survive a smaller step.
 *
 * Runs the model at `dt` and at `dt/2` and compares them; if they disagree,
 * keeps halving to find a step that agrees with its own half, and reports it as
 * `suggestedDt`. Adds a cross-method check and the static advisories.
 *
 * `method=map` is exempt from refinement by design: a difference equation *is*
 * the recurrence at the declared step, so halving dt changes the model rather
 * than resolving it more finely. The advisories still apply.
 */
export async function checkNumerics(model: Model, opts: NumericsOptions = {}): Promise<NumericsReport> {
  const tol = opts.tol ?? DEFAULTS.tol;
  const maxRefinements = opts.maxRefinements ?? DEFAULTS.maxRefinements;
  const maxSteps = opts.maxSteps ?? DEFAULTS.maxSteps;
  const { dt, method } = model.settings;
  const notes: string[] = [];
  const advisories = staticAdvisories(model);
  const base: NumericsReport = { converged: true, tol, dt, method, series: [], refinements: [], advisories, notes, runs: 0 };

  if (model.stocks.length === 0) {
    notes.push("nothing to integrate — a link-only sketch has no state, so there is no step to refine");
    return base;
  }
  if (method === "map") {
    notes.push("method=map is a difference equation: the step is part of the model, not an approximation to it — refining dt would simulate a different model, so no refinement was run");
    return base;
  }
  if (!(dt > 0) || !Number.isFinite(dt)) {
    notes.push(`dt is ${dt} — cannot refine`);
    return base;
  }

  // A run that halts early tells us nothing about step size — track them so the
  // verdict can say "this model diverges" instead of "try a smaller dt".
  const halted: number[] = [];
  let totalRuns = 0;
  const runAt = async (step: number): Promise<SimResult> => {
    const res = await simulateAsync(step === dt ? model : atDt(model, step));
    totalRuns++;
    if (res.note?.includes("non-finite")) halted.push(step);
    else if (res.note) notes.push(`at dt=${step}: ${res.note}`);
    return res;
  };

  const coarse = await runAt(dt);

  const names = opts.series?.length ? opts.series.filter((n) => coarse.series.has(n)) : coarse.stockNames;
  if (names.length === 0) {
    notes.push("no comparable series");
    return { ...base, runs: totalRuns };
  }

  const fine = await runAt(dt / 2);

  const series = discrepancy(coarse, fine, names, tol);
  const converged = series.length > 0 && series.every((s) => s.converged);
  const report: NumericsReport = { ...base, converged, refinedDt: dt / 2, series, worst: worstOf(series), runs: totalRuns };
  report.refinements.push({ dt, worst: worstOf(series)?.nrmse ?? NaN });

  // Keep halving until a step agrees with its own half — that is the one worth
  // suggesting, since it is the first step whose answer has stopped moving.
  if (!converged) {
    let prev = fine;
    let prevDt = dt / 2;
    for (let i = 0; i < maxRefinements; i++) {
      const nextDt = prevDt / 2;
      if (stepCount(model.settings, nextDt) > maxSteps) {
        notes.push(`stopped refining at dt=${prevDt} — dt=${nextDt} would exceed ${maxSteps.toLocaleString("en-US")} steps`);
        break;
      }
      const next = await runAt(nextDt);
      const rows = discrepancy(prev, next, names, tol);
      report.refinements.push({ dt: prevDt, worst: worstOf(rows)?.nrmse ?? NaN });
      if (rows.length > 0 && rows.every((r) => r.converged)) { report.suggestedDt = prevDt; break; }
      prev = next;
      prevDt = nextDt;
    }
    report.runs = totalRuns;
    if (report.suggestedDt === undefined) notes.push(diagnose(report.refinements, prevDt, halted, advisories));
  }

  // A second opinion at the model's own dt — but only in the direction that
  // diagnoses something. rk4 is fourth-order and euler is first, so euler
  // disagreeing with rk4 is *expected* and says nothing; rk4 disagreeing with
  // euler at the same step means euler's step is too large, since rk4 is the
  // better estimate of the same ODE.
  if (method === "euler") {
    const alt = structuredClone(model);
    alt.settings.method = "rk4";
    const altRun = await simulateAsync(alt);
    report.runs = ++totalRuns;
    const altRows = discrepancy(coarse, altRun, names, tol);
    const worst = worstOf(altRows);
    report.methodAgreement = {
      other: "rk4",
      converged: altRows.length > 0 && altRows.every((r) => r.converged),
      ...(worst ? { worst } : {}),
    };
  }

  if (halted.length) {
    notes.push(`${halted.length === totalRuns ? "every" : `${halted.length} of ${totalRuns}`} run${halted.length === 1 ? "" : "s"} halted early with a stock going non-finite (dt=${halted.join(", ")})`);
  }
  return report;
}

/**
 * Why refinement failed, from the ladder rather than from guesswork. Each rung
 * is how far the answer moved between that step and the next one down; a
 * shrinking ladder means the run is converging and simply hasn't got there yet,
 * a flat or growing one means smaller steps are not the fix.
 */
function diagnose(
  ladder: Array<{ dt: number; worst: number }>,
  floorDt: number,
  halted: number[],
  advisories: NumericsAdvisory[],
): string {
  if (halted.length >= ladder.length + 1) {
    return `every step down to dt=${floorDt} halted early with a stock going non-finite — the model diverges in finite time, which no step size fixes; check the equation that runs away`;
  }
  // When an advisory already names the cause, refinement was never going to
  // settle — say which one rather than guessing at a second explanation.
  const kind = advisories.find((a) => a.kind === "noise") ?? advisories.find((a) => a.kind === "discontinuity");
  if (kind) {
    return kind.kind === "noise"
      ? `no step down to dt=${floorDt} held still, and it never will while the noise scales with dt — see the noise advisory; refinement cannot judge this model's accuracy until the step is pinned`
      : `no step down to dt=${floorDt} held still — the threshold crossing moves with the grid at every step, which is the discontinuity advisory above, not accumulated integration error`;
  }
  const moves = ladder.map((r) => r.worst).filter(Number.isFinite);
  if (moves.length >= 2) {
    const first = moves[0]!, last = moves[moves.length - 1]!;
    if (last < first / 2) {
      return `still moving at dt=${floorDt} (${(last * 100).toPrecision(3)}% and shrinking with each halving) — the run is converging but has not reached the tolerance; halve dt further, or raise the tolerance if this accuracy is enough`;
    }
    if (last > first) {
      return `the answer moves *more* at each smaller step, down to dt=${floorDt} — smaller steps are not the fix; suspect a stiff equation or a threshold the grid keeps stepping over`;
    }
  }
  return `no step down to dt=${floorDt} held still, and the discrepancy is not shrinking — suspect a stiff equation, or a discontinuity that moves with the grid`;
}

// ── Static advisories ───────────────────────────────────────────────────────
// Three things a single refinement can miss or misread. Each is read off the
// AST at the operating point, the way lint.ts's checks are.

/** Names reachable from the rates, transitively through the var definitions —
 *  i.e. everything that feeds a `change()`. Mirrors grain.ts's closure. */
function ratesClosure(model: Model): Set<string> {
  const reach = new Set<string>();
  for (const r of model.rates.values()) for (const n of freeVars(r.expr)) reach.add(n);
  let grew = true;
  while (grew) {
    grew = false;
    for (const name of [...reach]) {
      const v = model.varIndex.get(name);
      if (!v) continue;
      for (const e of declExprs(v.expr, v.elemExprs)) for (const d of freeVars(e)) if (!reach.has(d)) { reach.add(d); grew = true; }
    }
  }
  return reach;
}

/** Close a set of names backwards through the var definitions. */
function dependsOn(model: Model, seeds: Iterable<string>): Set<string> {
  const reach = new Set(seeds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const name of [...reach]) {
      const v = model.varIndex.get(name);
      if (!v) continue;
      for (const e of declExprs(v.expr, v.elemExprs)) for (const d of freeVars(e)) if (!reach.has(d)) { reach.add(d); grew = true; }
    }
  }
  return reach;
}

function staticAdvisories(model: Model): NumericsAdvisory[] {
  const out: NumericsAdvisory[] = [];
  const { method, dt } = model.settings;
  const stocks = new Set(model.stocks.map((s) => s.name));
  const feedsARate = ratesClosure(model);

  // The expressions that actually shape the trajectory: every rate, plus every
  // var a rate depends on. An advisory about a var nothing integrates is noise.
  const live: Array<{ expr: Expr; loc: Loc }> = [];
  for (const r of model.rates.values()) live.push({ expr: r.expr, loc: r.loc });
  for (const v of model.vars) {
    if (!feedsARate.has(v.name)) continue;
    for (const e of declExprs(v.expr, v.elemExprs)) live.push({ expr: e, loc: v.loc });
  }

  // 1. A state-dependent branch under rk4. `if()` is a pure function: all three
  //    arguments are evaluated and one is selected (builtins.ts), so rk4 steps
  //    *through* the switch — its four sub-stages straddle the threshold and the
  //    weighted average is a value the model never actually takes.
  if (method === "rk4") {
    const switchAt: Loc[] = [];
    const visit = (e: Expr, loc: Loc): void => {
      const condition =
        e.kind === "call" && e.name.toLowerCase() === "if" ? e.args[0]
        : e.kind === "binary" && COMPARISONS.has(e.op) ? e
        : undefined;
      if (condition) {
        const closure = dependsOn(model, freeVars(condition));
        for (const n of closure) if (stocks.has(n)) { switchAt.push(loc); break; }
      }
      switch (e.kind) {
        case "binary": visit(e.left, loc); visit(e.right, loc); break;
        case "unary": visit(e.arg, loc); break;
        case "call": for (const a of e.args) visit(a, loc); break;
      }
    };
    for (const { expr, loc } of live) visit(expr, loc);
    const places = byLine(switchAt);
    if (places.length) {
      out.push({
        kind: "discontinuity",
        loc: places[0]!,
        message: `a branch here turns on a stock's value while the model runs under rk4 — rk4 samples between steps (t + dt/2), so it integrates straight through the threshold instead of stopping at it. Refining dt moves the crossing rather than resolving it; prefer method=euler with a small dt, or smooth the switch${places.length > 1 ? ` (${places.length} places)` : ""}`,
      });
    }
  }

  // 2. White noise inside a rate. random*() is resampled once per step and held
  //    across rk4's sub-stages (rng.ts) — correct for reproducibility, but the
  //    draw is not scaled by the step, so integrating it gives Var ∝ dt: halve
  //    dt and the noise the model injects halves with it.
  {
    const noiseAt: Loc[] = [];
    const visit = (e: Expr, loc: Loc): void => {
      if (e.kind === "call" && RANDOM_FNS.has(e.name.toLowerCase())) noiseAt.push(loc);
      switch (e.kind) {
        case "binary": visit(e.left, loc); visit(e.right, loc); break;
        case "unary": visit(e.arg, loc); break;
        case "call": for (const a of e.args) visit(a, loc); break;
      }
    };
    for (const { expr, loc } of live) visit(expr, loc);
    const places = byLine(noiseAt);
    if (places.length) {
      out.push({
        kind: "noise",
        loc: places[0]!,
        message: `this random draw feeds a change(), and a draw is not scaled by the step — the variance a stock accumulates is proportional to dt, so halving dt halves the noise and the refinement test below will disagree for that reason alone. Pin dt when the noise is part of the model, or drive the stock through smooth(…) to give the noise a time constant${places.length > 1 ? ` (${places.length} places)` : ""}`,
      });
    }
  }

  // 3. dt against the fastest time constant. A τ under ~2·dt is not resolved by
  //    the grid at all — the smoothing is decided by the step, not by τ.
  {
    let scope: Record<string, number> | undefined;
    const resolve = (): Record<string, number> => (scope ??= (() => { try { return operatingPoint(model); } catch { return {}; } })());
    const constValue = (e: Expr): number | undefined => {
      if (e.kind === "num") return e.value;
      if (e.kind === "unary") { const a = constValue(e.arg); return a === undefined ? undefined : e.op === "-" ? -a : a; }
      if (e.kind === "ident") return resolve()[e.name];
      return undefined;
    };
    let fastest: { tau: number; loc: Loc } | undefined;
    const visit = (e: Expr, loc: Loc): void => {
      if (e.kind === "call" && TAU_BUILTINS.has(e.name.toLowerCase()) && e.args[1]) {
        const tau = constValue(e.args[1]);
        if (tau !== undefined && Number.isFinite(tau) && tau > 0 && (!fastest || tau < fastest.tau)) fastest = { tau, loc };
      }
      switch (e.kind) {
        case "binary": visit(e.left, loc); visit(e.right, loc); break;
        case "unary": visit(e.arg, loc); break;
        case "call": for (const a of e.args) visit(a, loc); break;
      }
    };
    for (const { expr, loc } of live) visit(expr, loc);
    if (fastest && fastest.tau < 2 * dt) {
      out.push({
        kind: "time-constant",
        loc: fastest.loc,
        message: `the fastest time constant here is τ=${fastest.tau} but dt=${dt} — the grid is too coarse to resolve it, so the response you see is the step's, not the model's. Use dt ≤ ${(fastest.tau / 4).toPrecision(2)} (τ/4) or slow the process down`,
      });
    }
  }

  return out;
}
