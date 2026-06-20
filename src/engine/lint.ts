// ── Model lint ──────────────────────────────────────────────────────────────
// Non-fatal warnings the parser doesn't raise — the things that parse and run
// but are usually mistakes. Pure and DOM-free, so it rides along with `check`
// (CLI `lint`/`check`, MCP `flow_lint`/`flow_check`) and tightens the loop an
// agent lives in: write → check → fix. Most findings are severity "warning"
// (the model still runs); the exception is the call validation folded in from
// validate.ts, which is severity "error" — those calls won't run at all.

import type { Model, Diagnostic, Expr, Loc } from "../lang/index.js";
import { freeVars } from "../lang/index.js";
import { operatingPoint } from "./loops.js";
import { checkUnits } from "./units.js";
import { validateModel } from "./validate.js";

/** Stateful builtins whose 2nd argument is a time constant τ that must be > 0. */
const TAU_BUILTINS = new Set(["smooth", "smoothi", "smooth3", "delay1", "delay3"]);

const warn = (loc: Loc, message: string): Diagnostic => ({ severity: "warning", loc, message });

/** Lint a parsed model. Returns warnings only — never throws on a valid model. */
export function lintModel(model: Model): Diagnostic[] {
  const out: Diagnostic[] = [];

  // Calls to functions that don't exist (or with the wrong argument count) parse
  // fine but won't run — surface them here as errors so `check` is trustworthy.
  out.push(...validateModel(model));

  // Every name referenced anywhere — by a var, a rate, a stock init, or `plot`.
  const referenced = new Set<string>();
  const collect = (e: Expr) => {
    for (const id of freeVars(e)) referenced.add(id);
  };
  for (const v of model.vars) collect(v.expr);
  for (const r of model.rates.values()) collect(r.expr);
  for (const s of model.stocks) collect(s.initExpr);
  for (const name of model.plot) referenced.add(name);

  // Dead knobs and dead computations.
  for (const v of model.vars) {
    if (referenced.has(v.name)) continue;
    if (v.kind === "param") out.push(warn(v.loc, `param '${v.name}' is never used`));
    else out.push(warn(v.loc, `${v.kind} '${v.name}' is computed but never used (not referenced and not plotted)`));
  }

  // A stock with no change() rate can never change — almost always an oversight.
  for (const s of model.stocks) {
    if (!model.rates.has(s.name)) out.push(warn(s.loc, `stock '${s.name}' has no change(${s.name}) rate — it never changes`));
  }

  checkTimeConstants(model, out);
  checkUnits(model, out);
  return out;
}

/** Flag smooth/delay calls whose time constant resolves to a non-positive value. */
function checkTimeConstants(model: Model, out: Diagnostic[]): void {
  // Resolve identifier time constants against the t=start operating point, lazily
  // (and defensively — a malformed model shouldn't break the lint pass).
  let scope: Record<string, number> | undefined;
  const resolve = (): Record<string, number> => {
    if (!scope) {
      try {
        scope = operatingPoint(model);
      } catch {
        scope = {};
      }
    }
    return scope;
  };

  // Fold a τ expression to a number when it's a literal, a negated literal, or a
  // name that resolves at the operating point. Anything dynamic is left alone.
  const constValue = (e: Expr): number | undefined => {
    if (e.kind === "num") return e.value;
    if (e.kind === "unary") {
      const a = constValue(e.arg);
      return a === undefined ? undefined : e.op === "-" ? -a : a;
    }
    if (e.kind === "ident") return resolve()[e.name];
    return undefined;
  };

  const visit = (e: Expr, loc: Loc): void => {
    switch (e.kind) {
      case "call": {
        if (TAU_BUILTINS.has(e.name.toLowerCase()) && e.args[1]) {
          const value = constValue(e.args[1]);
          if (value !== undefined && Number.isFinite(value) && value <= 0) {
            out.push(warn(loc, `${e.name}(…) has a non-positive time constant (${value}) — τ should be > 0`));
          }
        }
        for (const a of e.args) visit(a, loc);
        break;
      }
      case "binary":
        visit(e.left, loc);
        visit(e.right, loc);
        break;
      case "unary":
        visit(e.arg, loc);
        break;
    }
  };

  for (const v of model.vars) visit(v.expr, v.loc);
  for (const r of model.rates.values()) visit(r.expr, r.loc);
  for (const s of model.stocks) visit(s.initExpr, s.loc);
}
