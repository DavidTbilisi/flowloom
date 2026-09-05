// ── Model → canonical text ──────────────────────────────────────────────────
// The inverse of the parser: render a `Model` back to `.flow` source.
//
// flowloom's whole thesis is that the text is canonical, and until now nothing
// could produce it. Every writer in the codebase edits *text* surgically
// (`model-edit.ts`, `model-build.ts`) or edits the AST and never renders it
// (`overrides.ts`); `bundle` is text-to-text. That was fine while the only
// author was a person typing — but a formatter, and any importer bringing a
// model in from another tool, both need to go the other way.
//
// The contract is a round trip: `parseModel(printModel(parseModel(src)))` is
// structurally the same model as `parseModel(src)`, for every example. Formatting
// is normalised (that is the point of `fmt`); meaning is not.
//
// What deliberately does *not* survive: `# @pos` layout hints and free-standing
// comments, which are not part of the Model — a doc comment attached to a
// declaration is, and is printed back on its line. `include` lines are already
// gone by the time anything holds a Model (they are a source-to-source pass), so
// printing a model assembled from parts yields the flat text, which is exactly
// what `bundle` produces.

import type { Model, StockDecl, VarDecl, TableDecl, Expr, RangeDecl } from "./types.js";
import { printExpr } from "./expr.js";
import { DEFAULT_SETTINGS } from "./types.js";

/** `# doc`, with the `@rung` tag put back where `extractRung` took it from. */
function comment(doc: string | undefined, rung: number | undefined): string {
  const parts = [rung !== undefined ? `@rung ${rung}` : "", doc ?? ""].filter(Boolean);
  return parts.length ? `   # ${parts.join(" ")}` : "";
}

/** `[unit]` or `[dim, dim]` — the same bracket, disambiguated by the dims list. */
function bracket(d: { unit?: string; dims?: string[] }): string {
  if (d.dims?.length) return `[${d.dims.join(", ")}]`;
  return d.unit ? ` [${d.unit}]` : "";
}

/** The right-hand side: one expression, or the per-element list. */
function rhs(single: Expr, elems: Expr[] | undefined): string {
  return (elems?.length ? elems : [single]).map(printExpr).join(", ");
}

/** A percentage was stored as a fraction, so `× 100` reintroduces float dust —
 *  `± 7%` would print as `± 7.000000000000001%`, which makes `fmt` rewrite a
 *  file that was already formatted and fail forever as a CI gate. */
const clean = (v: number): number => Number(v.toPrecision(12));

function range(r: RangeDecl | undefined): string {
  if (!r) return "";
  if (r.kind === "bounds") return ` in ${r.lo}..${r.hi}`;
  return ` ± ${r.pct ? `${clean(r.value * 100)}%` : r.value}`;
}

function stockLine(s: StockDecl): string {
  return `stock ${s.name}${bracket(s)}${s.nonNegative ? " >= 0" : ""} = ${rhs(s.initExpr, s.elemExprs)}${comment(s.doc, undefined)}`;
}

function varLine(v: VarDecl): string {
  const kw = v.boolean ? "switch" : v.constant ? "const" : v.kind;
  if (v.boolean) return `switch ${v.name} = ${printExpr(v.expr) === "1" ? "on" : "off"}${comment(v.doc, v.rung)}`;
  return `${kw} ${v.name}${bracket(v)} = ${rhs(v.expr, v.elemExprs)}${range(v.range)}${comment(v.doc, v.rung)}`;
}

function tableLine(t: TableDecl): string {
  return `table ${t.name} = ${t.points.map(([x, y]) => `(${x}, ${y})`).join(" ")}`;
}

/**
 * Re-sugar a `data` line.
 *
 * `data NAME = (t,v)…` desugars in the parser to a hidden `NAME#data` table plus
 * an aux flagged `data: true`. Printing has to put it back: emitting the two
 * halves would still parse and still run, but it would leak an internal name
 * into the canonical text and lose the line the modeller actually wrote.
 */
function dataLine(v: VarDecl, tables: Map<string, TableDecl>): string | undefined {
  const t = tables.get(`${v.name}#data`);
  if (!t) return undefined;
  const pts = t.points.map(([x, y]) => `(${x}, ${y})`).join(" ");
  return `data ${v.name}${bracket(v)} = ${pts}${t.hold ? "" : " linear"}${comment(v.doc, v.rung)}`;
}

function simLine(m: Model): string {
  const s = m.settings;
  const bits = [`dt=${s.dt}`, `to=${s.to}`];
  if (s.start !== DEFAULT_SETTINGS.start) bits.push(`start=${s.start}`);
  bits.push(`method=${s.method}`);
  if (s.timeunit) bits.push(`timeunit=${s.timeunit}`);
  if (s.seed !== undefined) bits.push(`seed=${s.seed}`);
  return `sim ${bits.join(" ")}`;
}

/**
 * Render a model as canonical `.flow` text.
 *
 * Declarations come out in the order they were written, because that order is
 * information: it is how the author grouped the model, and it is what fixes the
 * output series order (and therefore plot colours and CSV columns). Regrouping
 * by kind prints more tidily and quietly changes both. So `fmt` normalises
 * *spelling and spacing* — one space around `=`, `on`/`off` for a switch, a
 * `data` line back in one piece — and leaves the shape of the file alone. Blank
 * lines between groups are kept, since a gap in the source is the author saying
 * "these belong together".
 *
 * Pass the original `source` to carry its **comments** through, in place. A
 * comment attached to a declaration is part of the Model and always survives;
 * a comment on its own line is not, and dropping it would mean `fmt --write`
 * silently deleting someone's section headers and explanations. `# @pos` layout
 * hints ride along the same path — except that a position for a name the model
 * no longer declares is dropped, which is the tidy-up a rename or delete wants.
 */
export function printModel(model: Model, source?: string): string {
  const lines: Array<{ at: number; text: string }> = [];
  const add = (at: number, text: string) => lines.push({ at, text });

  for (const d of model.dims.values()) add(d.loc.line, `dim ${d.name} = ${d.elements.join(", ")}`);
  for (const s of model.stocks) add(s.loc.line, stockLine(s));
  for (const r of model.rates.values()) {
    const dims = model.stocks.find((s) => s.name === r.target)?.dims;
    add(r.loc.line, `change(${r.target}${dims?.length ? `[${dims.join(", ")}]` : ""}) = ${printExpr(r.expr)}`);
  }
  for (const v of model.vars) {
    if (v.name.includes("#")) continue; // an internal name, never written by hand
    const sugar = v.data ? dataLine(v, model.tables) : undefined;
    add(v.loc.line, sugar ?? varLine(v));
  }
  // `NAME#data` tables belong to their data line, which has already been printed.
  for (const t of model.tables.values()) if (!t.name.includes("#")) add(t.loc.line, tableLine(t));
  for (const l of model.links) add(l.loc.line, `link ${l.from} -> ${l.to} ${l.sign === 1 ? "+" : "-"}${comment(l.doc, undefined)}`);
  for (const sc of model.scenarios.values()) {
    add(sc.loc.line, `scenario ${sc.name} ${sc.sets.map((b) => `${b.key}=${b.value}`).join(" ")}${comment(sc.doc, sc.rung)}`);
  }
  for (const e of model.expects) {
    const tol = e.tol ? ` ± ${e.tol.pct ? `${clean(e.tol.value * 100)}%` : e.tol.value}` : "";
    add(e.loc.line, `expect ${e.scenario ? `${e.scenario} ` : ""}${e.metric} ${e.op} ${e.value}${tol}${comment(e.doc, undefined)}`);
  }

  if (source) lines.push(...sourceComments(source, model));
  lines.sort((a, b) => a.at - b.at);

  // The `sim`/`plot` block is the model's trailing settings, wherever it was
  // written — always last, always in that order.
  const out: string[] = [];
  let prev = 0;
  for (const l of lines) {
    if (prev && l.at - prev > 1) out.push("");
    out.push(l.text);
    prev = l.at;
  }
  if (out.length) out.push("");
  out.push(simLine(model));
  if (model.plot.length) out.push(`plot ${model.plot.join(" ")}`);

  // A dropped line (a stale `# @pos`) can leave two gaps where the source had
  // one; never emit more than one blank line in a row.
  const tidy = alignComments(out).filter((line, i, all) => line !== "" || all[i - 1] !== "");
  return tidy.join("\n") + "\n";
}

const POS = /^#\s*@pos\s+([A-Za-z_]\w*)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*$/;

/**
 * Comment-only lines from the source, at their own line numbers so they land
 * back where they were written.
 *
 * A trailing comment on a declaration is already carried by the Model (as its
 * `doc`) and is printed on that line — only whole-line comments come through
 * here, so nothing is printed twice. The one filtered case is a `# @pos` hint
 * for a name that no longer exists.
 */
function sourceComments(source: string, model: Model): Array<{ at: number; text: string }> {
  const declared = new Set([...model.stocks.map((s) => s.name), ...model.vars.map((v) => v.name)]);
  const out: Array<{ at: number; text: string }> = [];
  source.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#")) return;
    const pos = trimmed.match(POS);
    if (pos && !declared.has(pos[1]!)) return;
    out.push({ at: i + 1, text: trimmed });
  });
  return out;
}

/**
 * Line up trailing `#` comments within each blank-line-separated group.
 *
 * Hand-written flowloom models do this, and a formatter whose output reads worse
 * than what people already type is a formatter nobody runs. The grouping is the
 * author's — alignment never crosses a blank line, so one long line cannot push
 * an unrelated block of comments off to the right.
 */
function alignComments(lines: string[]): string[] {
  const out = lines.slice();
  let start = 0;
  const flush = (end: number) => {
    const idx: number[] = [];
    for (let i = start; i < end; i++) if (out[i]!.includes("   # ")) idx.push(i);
    if (idx.length < 2) return;
    const width = Math.max(...idx.map((i) => out[i]!.indexOf("   # ")));
    for (const i of idx) {
      const at = out[i]!.indexOf("   # ");
      out[i] = out[i]!.slice(0, at) + " ".repeat(width - at) + out[i]!.slice(at);
    }
  };
  for (let i = 0; i <= out.length; i++) {
    if (i === out.length || out[i] === "") { flush(i); start = i + 1; }
  }
  return out;
}
