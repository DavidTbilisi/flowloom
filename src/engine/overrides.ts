// ── Parameter / setting overrides ───────────────────────────────────────────
// Bind a value onto a parsed Model before running it: a param, a stock's initial
// value, or a sim setting (dt/to/start/method). Text is canonical, but a
// constant-folded AST edit is the safe, dependency-preserving way to rebind a
// name without re-tokenising the source — the same trick the studio's toolbar
// uses. Shared by the CLI's `--set` and the MCP server's `set` argument so both
// override the same way. Throws on a malformed/unknown spec; returns any soft
// warnings (e.g. overriding a non-param) for the caller to surface.

import type { Model, Expr } from "../lang/index.js";
import { SWITCH_WORDS, SETTING_KEYS } from "../lang/index.js";
import { suggestName } from "../lang/suggest.js";

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

  // A switch takes on/off (or 0/1) and nothing in between.
  const word = decl?.boolean ? SWITCH_WORDS[raw.toLowerCase()] : undefined;
  const v = word !== undefined ? word : Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${key}: value must be a number, got "${raw}"`);
  if (decl?.boolean && v !== 0 && v !== 1) throw new Error(`${key} is a switch — set it on or off (1 or 0), not "${raw}"`);
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

/** The name of the un-overridden model, as a scenario selector. */
export const BASE_SCENARIO = "base";

/**
 * Apply a named `scenario` from the model text, in place. "base" (or an empty
 * name) is the model as written — a no-op. Each binding goes through
 * applyOverride, so a scenario can do exactly what `--set` can and nothing more.
 * Throws on an unknown scenario (with a did-you-mean); returns soft warnings.
 */
export function applyScenario(model: Model, name: string | undefined): string[] {
  if (!name || name === BASE_SCENARIO) return [];
  const sc = model.scenarios.get(name);
  if (!sc) {
    const names = [...model.scenarios.keys()];
    const hint = suggestName(name, names);
    throw new Error(
      `no scenario named "${name}"` +
        (hint ? ` — did you mean "${hint}"?` : names.length ? ` (have: ${names.join(", ")})` : " (the model declares no scenario lines)"),
    );
  }
  const warnings: string[] = [];
  for (const { key, value } of sc.sets) warnings.push(...applyOverride(model, `${key}=${value}`));
  return warnings;
}
