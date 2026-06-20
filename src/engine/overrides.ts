// ── Parameter / setting overrides ───────────────────────────────────────────
// Bind a value onto a parsed Model before running it: a param, a stock's initial
// value, or a sim setting (dt/to/start/method). Text is canonical, but a
// constant-folded AST edit is the safe, dependency-preserving way to rebind a
// name without re-tokenising the source — the same trick the studio's toolbar
// uses. Shared by the CLI's `--set` and the MCP server's `set` argument so both
// override the same way. Throws on a malformed/unknown spec; returns any soft
// warnings (e.g. overriding a non-param) for the caller to surface.

import type { Model, Expr } from "../lang/index.js";

/** Apply one `key=value` override to `model` in place. Returns warnings. */
export function applyOverride(model: Model, spec: string): string[] {
  const warnings: string[] = [];
  const eq = spec.indexOf("=");
  if (eq < 0) throw new Error(`override expects key=value, got "${spec}"`);
  const key = spec.slice(0, eq).trim();
  const raw = spec.slice(eq + 1).trim();

  if (key === "method") {
    if (raw !== "euler" && raw !== "rk4") throw new Error(`method must be euler or rk4, got "${raw}"`);
    model.settings.method = raw;
    return warnings;
  }
  if (key === "dt" || key === "to" || key === "start" || key === "seed") {
    const v = Number(raw);
    if (!Number.isFinite(v)) throw new Error(`${key} must be a number, got "${raw}"`);
    model.settings[key] = v;
    return warnings;
  }

  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${key}: value must be a number, got "${raw}"`);
  const node: Expr = { kind: "num", value: v, loc: { line: 0, col: 0 } };

  // VarDecl objects are shared across vars/varIndex/order, so mutating .expr in
  // place rebinds the name everywhere the compiler will look.
  const decl = model.varIndex.get(key);
  if (decl) {
    if (decl.kind !== "param") warnings.push(`overriding ${decl.kind} "${key}" with a constant`);
    decl.expr = node;
    return warnings;
  }
  const stock = model.stocks.find((s) => s.name === key);
  if (stock) {
    stock.initExpr = node;
    return warnings;
  }
  throw new Error(`${key}: no param, stock, or sim setting by that name`);
}
