// ── Structural edits to model *text* (the visual builder's write layer) ──────
// Every diagram action (add a stock, wire a flow, rename, delete…) lands here as
// a string→string transform on the canonical `.flow` source, so the text stays
// the single source of truth — exactly the spirit of `model-edit.ts`'s
// `setSimSetting`, just for structure rather than `sim` settings.
//
// These work on *text*, not a parsed Model, on purpose: the builder must keep
// editing a model that doesn't parse yet (half-finished, or with a deliberate
// error the user is about to fix). Targeting is done by line scan; renames go
// through the lossless tokenizer in `highlight.ts` so identifier rewrites can't
// be fooled by substrings. DOM-free, so it's unit-tested in Node like the engine.

import { tokenizeSource } from "./highlight.js";
import type { VarKind } from "../lang/index.js";

// ── line helpers ─────────────────────────────────────────────────────────────

const split = (src: string): string[] => src.split(/\r?\n/);
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A line splits into code and an optional trailing `# comment` (no strings in
 *  the grammar, so the first `#` always starts a comment). */
function splitComment(line: string): [string, string] {
  const h = line.indexOf("#");
  return h < 0 ? [line, ""] : [line.slice(0, h), line.slice(h)];
}

/** The right-hand side of a `name = expr` line (trimmed), or "" if there is no `=`. */
function getRHS(line: string): string {
  const [code] = splitComment(line);
  const eq = code.indexOf("=");
  return eq < 0 ? "" : code.slice(eq + 1).trim();
}

/** Replace a line's right-hand side, preserving its left side and any comment. */
function setRHS(line: string, rhs: string): string {
  const [code, comment] = splitComment(line);
  const eq = code.indexOf("=");
  if (eq < 0) return line;
  const left = code.slice(0, eq).replace(/\s+$/, "");
  return `${left} = ${rhs}${comment ? "  " + comment.trim() : ""}`;
}

// `# @pos NAME X Y` — a layout hint for the diagram. It's a comment, so the
// parser ignores it; positions therefore round-trip through the canonical text
// (and the shareable URL hash) without touching the model's semantics.
const RE_POS = /^#\s*@pos\s+([A-Za-z_]\w*)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*$/;

const RE_STOCK = (n: string) => new RegExp(`^\\s*stock\\s+${esc(n)}\\b`);
const RE_VAR = (n: string) => new RegExp(`^\\s*(?:flow|aux|param|const)\\s+${esc(n)}\\b`);
const RE_RATE = (n: string) => new RegExp(`^\\s*(?:change|d)\\(\\s*${esc(n)}\\s*\\)`);
const RE_DECL = (n: string) =>
  new RegExp(`^\\s*(?:stock|flow|aux|param|const|table)\\s+${esc(n)}\\b|^\\s*(?:change|d)\\(\\s*${esc(n)}\\s*\\)`);

/** Insert a new declaration line just above the first `sim`/`plot` line (the
 *  idiomatic trailing block), or append it if there is none. */
function insertDecl(src: string, line: string): string {
  const lines = split(src);
  const at = lines.findIndex((l) => /^\s*(?:sim|plot)\b/.test(l));
  if (at === -1) return `${src.replace(/\s*$/, "")}\n${line}\n`;
  lines.splice(at, 0, line);
  return lines.join("\n");
}

// ── introspection (text-level, no parse needed) ─────────────────────────────

/** Every name bound by a declaration (stocks, vars, tables). */
export function declaredNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const raw of split(src)) {
    const [code] = splitComment(raw);
    const m = code.match(/^\s*(?:stock|flow|aux|param|const|table)\s+([A-Za-z_]\w*)/);
    if (m) names.add(m[1]!);
  }
  return names;
}

/** `base`, or `base2`, `base3`… — the first name not already declared. */
export function uniqueName(src: string, base: string): string {
  const taken = declaredNames(src);
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(base + i)) i++;
  return base + i;
}

/** 1-based line numbers where `name` is referenced *outside* its own
 *  declaration — what would dangle if `name` were deleted. */
export function referencesTo(src: string, name: string): number[] {
  const declLines = new Set<number>();
  split(src).forEach((l, i) => { if (RE_DECL(name).test(l)) declLines.add(i + 1); });
  const hits = new Set<number>();
  for (const t of tokenizeSource(src)) {
    if (t.kind === "ident" && t.text === name && !declLines.has(t.line)) hits.add(t.line);
  }
  return [...hits].sort((a, b) => a - b);
}

/** Stored diagram positions, keyed by node name (from `# @pos` comments). */
export function readLayout(src: string): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  for (const l of split(src)) {
    const m = l.match(RE_POS);
    if (m) out.set(m[1]!, { x: Number(m[2]), y: Number(m[3]) });
  }
  return out;
}

/** Record (or update) a node's diagram position as a `# @pos` comment line. */
export function setLayoutPos(src: string, name: string, x: number, y: number): string {
  const line = `# @pos ${name} ${Math.round(x)} ${Math.round(y)}`;
  const lines = split(src);
  const i = lines.findIndex((l) => { const m = l.match(RE_POS); return m?.[1] === name; });
  if (i >= 0) { lines[i] = line; return lines.join("\n"); }
  return `${src.replace(/\s*$/, "")}\n${line}\n`;
}

// ── mutations (all string → string) ─────────────────────────────────────────

/** Add a stock with an initial value (and optional unit). */
export function addStock(src: string, name: string, init = "0", unit?: string): string {
  return insertDecl(src, `stock ${name}${unit ? ` [${unit}]` : ""} = ${init}`);
}

/** Add a flow / aux / param variable. */
export function addVar(src: string, kind: VarKind, name: string, expr = "0", unit?: string): string {
  return insertDecl(src, `${kind} ${name}${unit ? ` [${unit}]` : ""} = ${expr}`);
}

/** Set a stock's net rate of change: replace `change(stock)` or insert it. */
export function setRate(src: string, stock: string, expr: string): string {
  const lines = split(src);
  const i = lines.findIndex((l) => RE_RATE(stock).test(l));
  if (i === -1) return insertDecl(src, `change(${stock}) = ${expr}`);
  lines[i] = setRHS(lines[i]!, expr);
  return lines.join("\n");
}

/** Wire a flow/aux into a stock's rate by folding in a `± term`. Creates the
 *  rate line if the stock doesn't have one yet. */
export function connectFlowToStock(src: string, flow: string, stock: string, sign: "+" | "-" = "+"): string {
  const lines = split(src);
  const i = lines.findIndex((l) => RE_RATE(stock).test(l));
  if (i === -1) return setRate(src, stock, sign === "-" ? `-${flow}` : flow);
  const rhs = getRHS(lines[i]!);
  lines[i] = setRHS(lines[i]!, rhs ? `${rhs} ${sign} ${flow}` : `${sign === "-" ? "-" : ""}${flow}`);
  return lines.join("\n");
}

/** Create a flow that drains one stock and fills another (the Vensim "pipe"):
 *  a new `flow name = expr`, subtracted from `from`'s rate and added to `to`'s. */
export function pipeBetweenStocks(src: string, from: string, to: string, name: string, expr = "0"): string {
  let s = addVar(src, "flow", name, expr);
  s = connectFlowToStock(s, name, from, "-");
  s = connectFlowToStock(s, name, to, "+");
  return s;
}

/** Replace the equation of a flow/aux/param (its declaration's RHS). */
export function setEquation(src: string, name: string, expr: string): string {
  const lines = split(src);
  const i = lines.findIndex((l) => RE_VAR(name).test(l));
  if (i === -1) return src;
  lines[i] = setRHS(lines[i]!, expr);
  return lines.join("\n");
}

/** Replace a stock's initial value (its declaration's RHS). */
export function setInit(src: string, stock: string, init: string): string {
  const lines = split(src);
  const i = lines.findIndex((l) => RE_STOCK(stock).test(l));
  if (i === -1) return src;
  lines[i] = setRHS(lines[i]!, init);
  return lines.join("\n");
}

/** Rename a symbol everywhere it appears — declaration, expressions,
 *  `change(NAME)` targets and the `plot` list — via the lossless tokenizer, so
 *  only whole identifier tokens are touched (never substrings). */
export function renameSymbol(src: string, oldName: string, newName: string): string {
  const renamed = tokenizeSource(src)
    .map((t) => (t.kind === "ident" && t.text === oldName ? newName : t.text))
    .join("");
  // `# @pos NAME` lives inside a comment token, so the tokenizer won't touch it —
  // rewrite it explicitly so a renamed node keeps its stored position.
  return renamed.replace(new RegExp(`(^#\\s*@pos\\s+)${esc(oldName)}\\b`, "gm"), `$1${newName}`);
}

/** Remove a symbol's declaration and (for a stock) its `change()` line.
 *  References to it elsewhere are left in place — call `referencesTo` first to
 *  warn the user — so the resulting error is visible rather than silently eaten. */
export function deleteSymbol(src: string, name: string): string {
  return split(src)
    .filter((l) => !(RE_STOCK(name).test(l) || RE_VAR(name).test(l) || RE_RATE(name).test(l)
      || new RegExp(`^\\s*table\\s+${esc(name)}\\b`).test(l)
      || l.match(RE_POS)?.[1] === name))
    .join("\n");
}
