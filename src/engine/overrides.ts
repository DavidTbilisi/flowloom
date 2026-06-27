// ── Parameter / setting overrides ───────────────────────────────────────────
// Bind a value onto a parsed Model before running it: a param, a stock's initial
// value, or a sim setting (dt/to/start/method). Text is canonical, but a
// constant-folded AST edit is the safe, dependency-preserving way to rebind a
// name without re-tokenising the source — the same trick the studio's toolbar
// uses. Shared by the CLI's `--set` and the MCP server's `set` argument so both
// override the same way. Throws on a malformed/unknown spec; returns any soft
// warnings (e.g. overriding a non-param) for the caller to surface.

import type { Model, Expr } from "../lang/index.js";
import { suggestName } from "../lang/suggest.js";

const SETTING_KEYS = ["dt", "to", "start", "seed", "method"];

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

  // Resolve the *target* before validating the value. Otherwise a misspelled key
  // like `methdo=rk4` falls through here and is reported as "value must be a
  // number" — blaming the (correct) value instead of the typo'd key. A name with
  // no near match still gets a recovery pointer, never a bare dead end.
  const decl = model.varIndex.get(key);
  const stock = decl ? undefined : model.stocks.find((s) => s.name === key);
  if (!decl && !stock) {
    const candidates = [
      ...model.stocks.map((s) => s.name),
      ...model.vars.map((v) => v.name),
      ...SETTING_KEYS,
    ];
    const hint = suggestName(key, candidates);
    throw new Error(
      `no param, stock, or sim setting named "${key}"` +
        (hint ? ` — did you mean "${hint}"?` : ` (overridable: params, stock inits, and ${SETTING_KEYS.join("/")})`),
    );
  }

  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${key}: value must be a number, got "${raw}"`);
  const node: Expr = { kind: "num", value: v, loc: { line: 0, col: 0 } };

  // VarDecl objects are shared across vars/varIndex/order, so mutating .expr in
  // place rebinds the name everywhere the compiler will look. Clear any per-element
  // list too: a single override value broadcasts to every element (and scalarize
  // prefers elemExprs, so leaving it would silently ignore the override).
  if (decl) {
    if (decl.kind !== "param") warnings.push(`overriding ${decl.kind} "${key}" with a constant`);
    if (decl.dims && decl.elemExprs) warnings.push(`"${key}" is subscripted — setting every element to ${v}`);
    decl.expr = node;
    decl.elemExprs = undefined;
    return warnings;
  }
  if (stock!.dims && stock!.elemExprs) warnings.push(`"${key}" is subscripted — setting every element to ${v}`);
  stock!.initExpr = node;
  stock!.elemExprs = undefined;
  return warnings;
}
