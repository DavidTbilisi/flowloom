// ── Expectations ─────────────────────────────────────────────────────────────
// `expect [SCENARIO] METRIC OP VALUE [± TOL]` lines are the model's own tests.
// A number that leaves the model — cited on a page, in a report, in a decision —
// is a claim about the model as it was; the claim is only as good as the next
// edit. Keeping it in the text, next to the scenarios it is about, means a
// refactor that moves the number is caught where it happened, not where it was
// quoted. Same shape as compare.ts: clone, applyScenario, run once per scenario,
// reduce with resolveMetric — plus the loop census for the loops:* metrics.

import type { Model, ExpectDecl } from "../lang/types.js";
import { simulateAsync } from "./simulator.js";
import { applyScenario, BASE_SCENARIO } from "./overrides.js";
import { resolveMetric } from "./summarize.js";
import { analyzeLoops, type LoopReport } from "./loops.js";

export interface ExpectResult {
  expect: ExpectDecl;
  /** The scenario the claim was checked under (`base` for the model itself). */
  scenario: string;
  /** The metric as measured; NaN when the run or the metric failed (see error). */
  actual: number;
  pass: boolean;
  /** For ==: |actual − value|, and the tolerance it was held to. */
  off?: number;
  allowed?: number;
  /** Carried from a run that halted early. */
  note?: string;
  /** The metric could not be read (unknown series under this scenario, run error). */
  error?: string;
}

export interface ExpectReport {
  results: ExpectResult[];
  passed: number;
  failed: number;
  /** Scenarios that were run (each once, however many claims it carries). */
  scenarios: string[];
}

/** The loop-census pseudo-metrics: `loops:active` etc. */
export function loopMetric(report: LoopReport, what: string): number {
  switch (what) {
    case "active": return report.loops.filter((l) => l.active).length;
    case "inactive": return report.inactive;
    case "total": return report.loops.length;
    case "rank": return report.rank;
    case "reinforcing": return report.loops.filter((l) => l.active && l.polarity === "R").length;
    case "balancing": return report.loops.filter((l) => l.active && l.polarity === "B").length;
    default: throw new Error(`loops:${what} — unknown loop metric (active|inactive|total|reinforcing|balancing|rank)`);
  }
}

/** Evaluate one claim against a measured value. Pure, so it is the same in the
 *  CLI, the MCP server and a test. `==` without a tolerance is exact — a failure
 *  message says how far off it was, which is the tolerance to write. */
export function judge(e: ExpectDecl, actual: number): Pick<ExpectResult, "pass" | "off" | "allowed"> {
  if (!Number.isFinite(actual)) return { pass: false };
  switch (e.op) {
    case "<": return { pass: actual < e.value };
    case "<=": return { pass: actual <= e.value };
    case ">": return { pass: actual > e.value };
    case ">=": return { pass: actual >= e.value };
    case "==": {
      const off = Math.abs(actual - e.value);
      const allowed = e.tol ? (e.tol.pct ? e.tol.value * Math.abs(e.value) : e.tol.value) : 0;
      return { pass: off <= allowed, off, allowed };
    }
  }
}

/**
 * Run every `expect` line (or those under the chosen scenarios), one simulation
 * per scenario, and judge each claim. Never throws for a claim that cannot be
 * read — that is a failed result with an `error`, so one broken line does not
 * hide the others.
 */
export async function runExpects(model: Model, scenarios?: string[]): Promise<ExpectReport> {
  const wanted = scenarios?.length ? new Set(scenarios) : undefined;
  const byScenario = new Map<string, ExpectDecl[]>();
  for (const e of model.expects) {
    const name = e.scenario ?? BASE_SCENARIO;
    if (wanted && !wanted.has(name)) continue;
    let list = byScenario.get(name);
    if (!list) byScenario.set(name, (list = []));
    list.push(e);
  }

  const results: ExpectResult[] = [];
  for (const [name, list] of byScenario) {
    const m = structuredClone(model);
    let res: Awaited<ReturnType<typeof simulateAsync>> | undefined;
    let runError: string | undefined;
    try {
      applyScenario(m, name);
      res = await simulateAsync(m);
    } catch (err) {
      runError = (err as Error).message;
    }
    let loops: LoopReport | undefined;
    for (const e of list) {
      if (!res) { results.push({ expect: e, scenario: name, actual: NaN, pass: false, error: runError }); continue; }
      let actual: number;
      try {
        if (e.metric.startsWith("loops:")) {
          loops ??= analyzeLoops(m);
          actual = loopMetric(loops, e.metric.slice("loops:".length));
        } else actual = resolveMetric(res, e.metric);
      } catch (err) {
        results.push({ expect: e, scenario: name, actual: NaN, pass: false, error: (err as Error).message });
        continue;
      }
      results.push({ expect: e, scenario: name, actual, ...judge(e, actual), ...(res.note ? { note: res.note } : {}) });
    }
  }
  // Source order, not scenario order: the report should read like the file.
  results.sort((a, b) => a.expect.loc.line - b.expect.loc.line);
  const passed = results.filter((r) => r.pass).length;
  return { results, passed, failed: results.length - passed, scenarios: [...byScenario.keys()] };
}

/** One line per claim, the way the text wrote it. */
export function formatExpect(e: ExpectDecl): string {
  const tol = e.tol ? ` ± ${e.tol.pct ? `${e.tol.value * 100}%` : e.tol.value}` : "";
  return `${e.scenario ?? BASE_SCENARIO} ${e.metric} ${e.op} ${e.value}${tol}`;
}
