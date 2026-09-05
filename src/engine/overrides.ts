// ── Parameter / setting overrides ───────────────────────────────────────────
// Bind a value onto a parsed Model before running it: a param, a stock's initial
// value, or a sim setting (dt/to/start/method). Text is canonical, but a
// constant-folded AST edit is the safe, dependency-preserving way to rebind a
// name without re-tokenising the source — the same trick the studio's toolbar
// uses. Shared by the CLI's `--set` and the MCP server's `set` argument so both
// override the same way. Throws on a malformed/unknown spec; returns any soft
// warnings (e.g. overriding a non-param) for the caller to surface.

import type { Model, Expr, StockDecl, VarDecl } from "../lang/index.js";
import { SWITCH_WORDS, SETTING_KEYS } from "../lang/index.js";
import { suggestName } from "../lang/suggest.js";
import { elemTuples, elemName } from "../lang/scalarize.js";

/** Apply one `key=value` override to `model` in place. Returns warnings. */
export function applyOverride(model: Model, spec: string): string[] {
  const warnings: string[] = [];
  const eq = spec.indexOf("=");
  if (eq < 0) throw new Error(`override expects key=value, got "${spec}"`);
  const key = spec.slice(0, eq).trim();
  const raw = spec.slice(eq + 1).trim();

  if (key === "method") {
    if (raw !== "euler" && raw !== "rk4" && raw !== "map") throw new Error(`method must be euler, rk4 or map, got "${raw}"`);
    model.settings.method = raw;
    return warnings;
  }
  if (key === "dt" || key === "to" || key === "start" || key === "seed" || key === "savper") {
    const v = Number(raw);
    if (!Number.isFinite(v)) throw new Error(`${key} must be a number, got "${raw}"`);
    if (key === "savper" && v <= 0) throw new Error(`savper must be positive, got ${v}`);
    model.settings[key] = v;
    return warnings;
  }
  // The one setting whose value is a word rather than a number. It changes no
  // arithmetic — only what the units checker reads `/time` as — but a scenario
  // that reframes a model from weeks to months has to be able to say so.
  if (key === "timeunit") {
    if (!raw) throw new Error(`timeunit must be a name, e.g. timeunit=month`);
    model.settings.timeunit = raw;
    return warnings;
  }

  // `curve=steepCurve` swaps one lookup for another. A graphical function is
  // often the *policy* — a response curve, a tax schedule, a dose–effect shape —
  // so "what if the curve were steeper" is a scenario, and the alternative
  // belongs in the text beside the original rather than in a second file.
  const table = model.tables.get(key);
  if (table) {
    const replacement = model.tables.get(raw);
    if (!replacement) {
      const others = [...model.tables.keys()].filter((n) => n !== key && !n.includes("#"));
      const hint = suggestName(raw, others);
      throw new Error(
        `"${key}" is a lookup table, so it can only be set to another table, got "${raw}"`
          + (hint ? ` — did you mean "${hint}"?` : others.length ? ` (have: ${others.join(", ")})` : " (declare the alternative curve as another `table` line)"),
      );
    }
    if (replacement.name === key) return warnings; // setting a table to itself
    // Keep the name so every call site still reads `key(x)`; take the shape.
    model.tables.set(key, { ...replacement, name: key, loc: table.loc });
    return warnings;
  }

  // `Pop[North]=…` addresses one element of a subscripted declaration. Without
  // it the only thing an override could say about a vector was "every element",
  // which is rarely the experiment anyone wanted to run.
  const idx = key.match(/^([^[\]]+?)\s*\[([^\]]*)\]$/);
  if (idx) return applyElementOverride(model, idx[1]!.trim(), idx[2]!.split(/[\s,]+/).filter(Boolean), raw);

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

/**
 * Rebind a single element of a subscripted stock or var.
 *
 * A subscripted declaration carries either one expression for every element or
 * an explicit per-element list; overriding one element means materialising the
 * list first (broadcasting the shared expression) and then replacing one entry.
 * The tuple order comes from scalarize, so `Pop[North]` here and `Pop.North` in
 * the output series are the same element by construction rather than by luck.
 */
function applyElementOverride(model: Model, base: string, subs: string[], raw: string): string[] {
  const decl: VarDecl | undefined = model.varIndex.get(base);
  const stock: StockDecl | undefined = decl ? undefined : model.stocks.find((s) => s.name === base);
  const target = decl ?? stock;
  if (!target) {
    const candidates = [...model.stocks.map((s) => s.name), ...model.vars.map((v) => v.name)];
    const hint = suggestName(base, candidates);
    throw new Error(`no param, stock, or sim setting named "${base}"` + (hint ? ` — did you mean "${hint}"?` : ""));
  }
  const dims = target.dims;
  if (!dims?.length) throw new Error(`"${base}" is not subscripted, so "${base}[${subs.join(", ")}]" is invalid — set ${base} instead`);
  if (subs.length !== dims.length) {
    throw new Error(`"${base}" has ${dims.length} dimension(s) [${dims.join(", ")}] but was indexed with ${subs.length}`);
  }
  subs.forEach((sub, i) => {
    const elements = model.dims.get(dims[i]!)?.elements ?? [];
    if (elements.includes(sub)) return;
    const hint = suggestName(sub, elements);
    throw new Error(`"${sub}" is not an element of dim "${dims[i]}" (${elements.join(", ")})` + (hint ? ` — did you mean "${hint}"?` : ""));
  });

  const warnings: string[] = [];
  if (decl && decl.kind !== "param") warnings.push(`overriding ${decl.kind} "${elemName(base, subs)}" with a constant`);
  const word = decl?.boolean ? SWITCH_WORDS[raw.toLowerCase()] : undefined;
  const v = word !== undefined ? word : Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${base}[${subs.join(", ")}]: value must be a number, got "${raw}"`);
  if (decl?.boolean && v !== 0 && v !== 1) throw new Error(`"${base}" is a switch — set it on or off (1 or 0), not "${raw}"`);
  const node: Expr = { kind: "num", value: v, loc: { line: 0, col: 0 } };

  const tuples = elemTuples(dims, model.dims);
  const at = tuples.findIndex((t) => t.every((el, i) => el === subs[i]));
  const shared = decl ? decl.expr : stock!.initExpr;
  const list = target.elemExprs ? [...target.elemExprs] : tuples.map(() => shared);
  list[at] = node;
  target.elemExprs = list;
  // Single-expression consumers read the head, so keep it pointing at the same
  // element the list's first entry describes.
  if (decl) decl.expr = list[0]!; else stock!.initExpr = list[0]!;
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
