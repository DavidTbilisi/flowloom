// ── Semantic validation against the builtin catalog ─────────────────────────
// The parser (src/lang) is deliberately catalog-agnostic — it knows the grammar,
// not which functions exist. This pass closes that gap: every call must name a
// real builtin / stateful / table function, with the right argument count. It
// lives in src/engine because that's where the builtin catalog is (keeping
// src/lang free of engine imports), and it's the difference between `check`
// saying "ok" and then `run` crashing with a line-less "unknown function".
//
// DOM-free like the rest of the engine. Returns error-severity diagnostics with
// source locations and a "did you mean" hint, exactly like the parser's
// unknown-name check.

import type { Model, Diagnostic, Expr, Loc } from "../lang/index.js";
import { declExprs } from "../lang/index.js";
import { ARITY, STATEFUL } from "./builtins.js";
import { suggestSuffix } from "../lang/suggest.js";

/** Argument counts for the stateful family + the subscript aggregate, which
 *  aren't in ARITY (they're rewritten away before codegen). */
const EXTRA_ARITY: Record<string, [number, number]> = {
  smooth: [2, 2],
  smoothi: [3, 3],
  smooth3: [2, 2],
  delay1: [2, 2],
  delay3: [2, 2],
  sum: [1, Infinity], // sum(X) collapses all dims; sum(X, axis, …) collapses named axes
};

const err = (loc: Loc, message: string): Diagnostic => ({ severity: "error", loc, message });

/** Validate every function call in a parsed model. Returns error diagnostics
 *  (unknown function, wrong arity) — empty when the model is sound. */
export function validateModel(model: Model): Diagnostic[] {
  const out: Diagnostic[] = [];
  const tables = new Set(model.tables.keys());
  const arity = (name: string): [number, number] | undefined => ARITY[name] ?? EXTRA_ARITY[name];
  // Every name we'll suggest from: builtins, stateful, sum, and lookup tables.
  const known = [...Object.keys(ARITY), ...STATEFUL, "sum", ...tables];

  const visit = (e: Expr, loc: Loc): void => {
    switch (e.kind) {
      case "call": {
        // tables are case-sensitive user names; builtins resolve case-insensitively
        if (tables.has(e.name)) {
          if (e.args.length !== 1) out.push(err(loc, `lookup table ${e.name}(x) takes one argument, got ${e.args.length}`));
        } else {
          const lc = e.name.toLowerCase();
          const bounds = arity(lc);
          if (!bounds) {
            const suffix = suggestSuffix(e.name, known, "not a flowloom builtin — check the reference for the function list");
            out.push(err(loc, `unknown function '${e.name}'${suffix}`));
          } else {
            const [lo, hi] = bounds;
            const n = e.args.length;
            if (n < lo || n > hi) {
              const want = lo === hi ? `${lo}` : hi === Infinity ? `at least ${lo}` : `${lo}–${hi}`;
              out.push(err(loc, `${lc}() takes ${want} argument${lo === 1 && hi === 1 ? "" : "s"}, got ${n}`));
            }
          }
        }
        for (const a of e.args) visit(a, loc);
        break;
      }
      case "unary":
        visit(e.arg, loc);
        break;
      case "binary":
        visit(e.left, loc);
        visit(e.right, loc);
        break;
    }
  };

  for (const s of model.stocks) for (const e of declExprs(s.initExpr, s.elemExprs)) visit(e, s.loc);
  for (const v of model.vars) for (const e of declExprs(v.expr, v.elemExprs)) visit(e, v.loc);
  for (const r of model.rates.values()) visit(r.expr, r.loc);
  return out;
}
