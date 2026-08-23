// ── Knob grain ───────────────────────────────────────────────────────────────
// A ±10 % bump is the wrong probe for some knobs. A switch is two-state (handled
// by `boolean`). A *time-grain* knob — one that ends up compared with the clock
// (`t >= sideStart`, `t % yearLen`) or setting a fixed delay's length — only
// changes the run when it crosses a step boundary, so 2 ± 0.2 rounds to the same
// step and reads as Δ = 0 while a sweep shows it matters. Sensitivity therefore
// bumps such knobs by at least one step (dt). Detection is static: walk every
// expression for time contexts, collect the names inside them, and close
// backwards through the vars to the params that feed them.

import type { Expr, Model } from "../lang/types.js";
import { freeVars, declExprs } from "../lang/expr.js";

const isClock = (e: Expr) => e.kind === "ident" && (e.name === "t" || e.name === "time");

/** Names of the params whose value is read on the time grid. */
export function timeGrainParams(model: Model): Set<string> {
  const seeds = new Set<string>();
  const collect = (e: Expr) => { for (const n of freeVars(e)) seeds.add(n); };

  const visit = (e: Expr): void => {
    switch (e.kind) {
      case "binary":
        // arithmetic / comparison against the clock: the other side is a time
        if (isClock(e.left)) collect(e.right);
        else if (isClock(e.right)) collect(e.left);
        visit(e.left);
        visit(e.right);
        break;
      case "unary":
        visit(e.arg);
        break;
      case "call": {
        const n = e.name.toLowerCase();
        // delay_fixed(X, length): length is whole steps
        if (n === "delay_fixed" && e.args[1]) collect(e.args[1]);
        // test inputs: their time arguments sit on the grid
        if (n === "step" && e.args[1]) collect(e.args[1]);
        if (n === "pulse") for (const a of e.args) collect(a);
        if (n === "ramp") for (const a of e.args.slice(1)) collect(a);
        for (const a of e.args) visit(a);
        break;
      }
    }
  };
  for (const v of model.vars) for (const e of declExprs(v.expr, v.elemExprs)) visit(e);
  for (const r of model.rates.values()) visit(r.expr);
  for (const s of model.stocks) for (const e of declExprs(s.initExpr, s.elemExprs)) visit(e);

  // Close backwards: anything a seeded var depends on is on the grid too.
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
  const out = new Set<string>();
  for (const v of model.vars) if (v.kind === "param" && reach.has(v.name)) out.add(v.name);
  return out;
}

/** The params sensitivity should vary by default: knobs, not constants. An
 *  explicit list overrides the filter (naming a const is allowed). */
export function knobParams(model: Model, explicit: string[]): string[] {
  if (explicit.length) return explicit;
  return model.vars.filter((v) => v.kind === "param" && !v.constant).map((v) => v.name);
}
