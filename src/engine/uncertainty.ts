// ── Declared uncertainty ────────────────────────────────────────────────────
// `param birthRate = 0.03 ± 0.01` — how well a knob is known, written where the
// knob is written.
//
// Three analyses used to each invent their own answer to that question and none
// of them could be told the real one: `monteCarlo` varied only the RNG seed (so
// on a deterministic model — which is most of them — every run was identical and
// the band had zero width), `globalSensitivity` made up a symmetric ±frac box
// around the base value, and `calibrate` had no bounds at all and would happily
// fit a rate parameter negative. One declaration in the text answers all three,
// and the text stays canonical: what an AI reads is what varies.
//
// Bounds are resolved here rather than at parse time because a param's value
// need not be a literal (`param x = base * 2 ± 10%`) — the operating point is
// what turns a declared tolerance into two numbers.

import type { Model } from "../lang/types.js";
import { operatingPoint } from "./loops.js";

export interface ParamRange {
  name: string;
  /** The declared value, at the operating point. */
  base: number;
  lo: number;
  hi: number;
  /** True when the bounds came from `in lo..hi` rather than a ± tolerance. */
  explicit: boolean;
}

/**
 * Resolve every `param … ± tol` / `param … in lo..hi` into concrete bounds.
 *
 * Params without a range are absent from the map — callers decide what to do
 * with an undeclared knob (sample it, leave it alone, fall back to a ±frac box).
 */
export function paramRanges(model: Model, scope?: Record<string, number>): Map<string, ParamRange> {
  const out = new Map<string, ParamRange>();
  const declared = model.vars.filter((v) => v.kind === "param" && v.range);
  if (!declared.length) return out;

  let op = scope;
  const at = (name: string): number | undefined => {
    if (!op) { try { op = operatingPoint(model); } catch { op = {}; } }
    return op[name];
  };

  for (const v of declared) {
    const r = v.range!;
    const base = at(v.name);
    if (base === undefined || !Number.isFinite(base)) continue;
    if (r.kind === "bounds") {
      out.set(v.name, { name: v.name, base, lo: r.lo, hi: r.hi, explicit: true });
      continue;
    }
    // A percentage is of the value itself; a zero-valued knob has no scale to be
    // a percentage of, so its ± band would be empty — skip rather than pretend.
    const d = r.pct ? Math.abs(base) * r.value : r.value;
    if (!(d > 0)) continue;
    out.set(v.name, { name: v.name, base, lo: base - d, hi: base + d, explicit: false });
  }
  return out;
}
