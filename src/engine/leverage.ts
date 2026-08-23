// ── The leverage ladder ─────────────────────────────────────────────────────
// Donella Meadows ranked twelve places to intervene in a system, from the
// weakest (12: the numbers) to the strongest (1: the power to transcend
// paradigms). A model's knobs, switches and scenarios can be tagged with the
// rung they sit on (`# @rung 10` in the doc comment); this view lays the model's
// levers out on that ladder and measures each one on a metric — params by a
// grain-aware ±frac bump, switches off→on, scenarios against base — so the
// model's own ranking of its levers can be read against Meadows'. Untagged
// levers are listed so the gaps are visible; nothing is guessed.

import type { Model } from "../lang/types.js";
import { sensitivity } from "./sweep.js";
import { compareScenarios } from "./compare.js";

/** Meadows (1999), "Leverage Points: Places to Intervene in a System". */
export const MEADOWS_RUNGS: Record<number, string> = {
  12: "constants, parameters, numbers",
  11: "buffer sizes",
  10: "stock-and-flow structure",
  9: "lengths of delays",
  8: "strength of balancing loops",
  7: "gain of reinforcing loops",
  6: "information flows",
  5: "rules",
  4: "self-organisation",
  3: "goals",
  2: "paradigm",
  1: "transcending paradigms",
};

export interface Lever {
  kind: "param" | "switch" | "scenario";
  name: string;
  /** Signed metric change: high − low for a param, on − off for a switch, scenario − base. */
  delta: number;
  /** What was compared, for the reader. */
  detail: string;
  doc?: string;
}

export interface LadderRung {
  rung: number;
  title: string;
  levers: Lever[];
  /** The lever on this rung with the largest |delta|. */
  best?: Lever;
}

export interface LeverageResult {
  metric: string;
  base: number;
  /** Rungs 12 … 1, each with its tagged levers (empty rungs included). */
  rungs: LadderRung[];
  /** Levers with no @rung tag. */
  untagged: Array<{ kind: Lever["kind"]; name: string }>;
  /** Rungs ranked by their best lever's |delta|. */
  ranking: number[];
}

export async function leverageLadder(model: Model, metric: string, frac = 0.1): Promise<LeverageResult> {
  const params = model.vars.filter((v) => v.kind === "param" && !v.constant);
  const tagged = params.filter((v) => v.rung !== undefined).map((v) => v.name);
  const scen = [...model.scenarios.values()];
  const taggedScen = scen.filter((s) => s.rung !== undefined).map((s) => s.name);

  const sens = tagged.length ? await sensitivity(model, tagged, metric, frac) : { rows: [] as Awaited<ReturnType<typeof sensitivity>>["rows"] };
  const cmp = await compareScenarios(model, [metric], taggedScen.length ? taggedScen : undefined);
  const base = cmp.rows[0]!.values[0]!;

  const rungs: LadderRung[] = [];
  for (let r = 12; r >= 1; r--) rungs.push({ rung: r, title: MEADOWS_RUNGS[r]!, levers: [] });
  const at = (r: number) => rungs[12 - r]!;

  for (const row of sens.rows) {
    const v = model.varIndex.get(row.param)!;
    const lever: Lever = row.switch
      ? { kind: "switch", name: row.param, delta: row.delta, detail: `off → on: ${fmt(row.low)} → ${fmt(row.high)}` }
      : { kind: "param", name: row.param, delta: row.delta, detail: `${fmt(row.base)} ±${row.step !== undefined ? fmt(row.step) : `${fmt(frac * 100)}%`}: ${fmt(row.low)} → ${fmt(row.high)}${row.flat ? " (flat)" : ""}` };
    if (v.doc) lever.doc = v.doc;
    at(v.rung!).levers.push(lever);
  }
  for (const row of cmp.rows.slice(1)) {
    const s = model.scenarios.get(row.scenario)!;
    if (s.rung === undefined) continue;
    const lever: Lever = { kind: "scenario", name: row.scenario, delta: row.delta![0]!, detail: `${row.sets.join(" ")}: ${fmt(base)} → ${fmt(row.values[0]!)}` };
    if (s.doc) lever.doc = s.doc;
    at(s.rung).levers.push(lever);
  }
  for (const rg of rungs) {
    rg.levers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    if (rg.levers.length) rg.best = rg.levers[0]!;
  }
  const ranking = rungs.filter((r) => r.best).sort((a, b) => Math.abs(b.best!.delta) - Math.abs(a.best!.delta)).map((r) => r.rung);

  const untagged: LeverageResult["untagged"] = [
    ...params.filter((v) => v.rung === undefined).map((v) => ({ kind: (v.boolean ? "switch" : "param") as Lever["kind"], name: v.name })),
    ...scen.filter((s) => s.rung === undefined).map((s) => ({ kind: "scenario" as const, name: s.name })),
  ];
  return { metric, base, rungs, untagged, ranking };
}

function fmt(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  const a = Math.abs(x);
  if (a !== 0 && (a < 1e-3 || a >= 1e7)) return x.toExponential(3);
  return String(Number(x.toPrecision(6)));
}
