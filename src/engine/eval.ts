import type { Expr, TableDecl } from "../lang/types.js";
import { BUILTINS, lookupTable } from "./builtins.js";

// ── Expression interpreter ──────────────────────────────────────────────────
// Walks the AST against a numeric scope. No code generation, no eval — this is
// what makes the engine safe to run untrusted/AI-authored model text directly.

export interface EvalCtx {
  /** name → current numeric value (stocks, vars, params, plus `t`/`time`). */
  scope: Record<string, number>;
  tables: Map<string, TableDecl>;
}

export class EvalError extends Error {}

const CONSTS: Record<string, number> = { PI: Math.PI, E: Math.E };

export function evalExpr(e: Expr, ctx: EvalCtx): number {
  switch (e.kind) {
    case "num":
      return e.value;
    case "ident": {
      const v = ctx.scope[e.name];
      if (v !== undefined) return v;
      const c = CONSTS[e.name];
      if (c !== undefined) return c;
      throw new EvalError(`unknown name '${e.name}'`);
    }
    case "unary": {
      const a = evalExpr(e.arg, ctx);
      if (e.op === "-") return -a;
      if (e.op === "!") return a === 0 ? 1 : 0;
      return a;
    }
    case "binary": {
      const l = evalExpr(e.left, ctx);
      const r = evalExpr(e.right, ctx);
      switch (e.op) {
        case "+":
          return l + r;
        case "-":
          return l - r;
        case "*":
          return l * r;
        case "/":
          return l / r;
        case "%":
          return l % r;
        case "^":
          return Math.pow(l, r);
        // comparisons and logical connectives return 1 (true) / 0 (false)
        case "<":
          return l < r ? 1 : 0;
        case ">":
          return l > r ? 1 : 0;
        case "<=":
          return l <= r ? 1 : 0;
        case ">=":
          return l >= r ? 1 : 0;
        case "==":
          return l === r ? 1 : 0;
        case "!=":
          return l !== r ? 1 : 0;
        case "&&":
          return l !== 0 && r !== 0 ? 1 : 0;
        case "||":
          return l !== 0 || r !== 0 ? 1 : 0;
      }
      break;
    }
    case "call": {
      const name = e.name.toLowerCase();
      // table lookup: `tableName(x)`
      const table = ctx.tables.get(e.name);
      if (table) {
        return lookupTable(table.points, evalExpr(e.args[0]!, ctx));
      }
      // The tree-walker is used only for loop-polarity perturbation at the
      // operating point, where randomness should be deterministic — so each
      // random*() resolves to its distribution mean.
      if (name === "random") return 0.5;
      if (name === "random_uniform") return (evalExpr(e.args[0]!, ctx) + evalExpr(e.args[1]!, ctx)) / 2;
      if (name === "random_normal") return evalExpr(e.args[0]!, ctx);
      const fn = BUILTINS[name];
      if (!fn) throw new EvalError(`unknown function '${e.name}'`);
      // IF short-circuits to avoid div-by-zero in the untaken branch.
      if (name === "if") {
        return evalExpr(e.args[0]!, ctx) ? evalExpr(e.args[1]!, ctx) : evalExpr(e.args[2]!, ctx);
      }
      const args = e.args.map((a) => evalExpr(a, ctx));
      return fn(args, ctx.scope.t ?? 0);
    }
  }
  throw new EvalError("malformed expression");
}
