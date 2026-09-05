// ── XMILE → .flow ───────────────────────────────────────────────────────────
// XMILE (OASIS) is the interchange format Stella writes as `.stmx` and several
// other tools read. Importing it is the difference between flowloom starting
// every user on a blank page and letting them bring the model they already have.
//
// The mapping is direct, because both languages describe the same thing:
//
//   <stock name="X"><eqn>10</eqn><inflow>a</inflow><outflow>b</outflow></stock>
//     →  stock X = 10
//        change(X) = a - b
//   <flow name="a"><eqn>…</eqn></flow>          →  flow a = …
//   <aux name="k"><eqn>3</eqn></aux>            →  param k = 3   (a bare number
//                                                  is a knob, not a computation)
//   <gf><xpts>…</xpts><ypts>…</ypts></gf>       →  table NAME = (x, y) …
//   <sim_specs><start/><stop/><dt/>             →  sim start= to= dt=
//
// Two rules govern everything here:
//
//  1. **Never fail on a feature we don't model.** A real file carries views,
//     macros, arrays, units the checker can't parse, and functions flowloom
//     doesn't have. Anything unsupported becomes a `note` and, where it would
//     otherwise produce a silently wrong model, a commented-out line — so the
//     import is a starting point a human can finish, not a wall.
//  2. **Emit through printModel.** The importer builds `.flow` *text* and hands
//     it to the parser; whatever comes out has been through the same validation
//     as anything a person types. An importer that produced a Model directly
//     could construct one the language cannot express.

import { parseModel, printModel } from "../lang/index.js";
import { parseXml, findAll, child, childText, XmlParseError, type XmlNode } from "./xml.js";

export interface ImportResult {
  /** The model as canonical .flow text. */
  model: string;
  /** What did not survive, or changed meaning. Never empty-and-silent: if the
   *  import dropped something, it says so here. */
  notes: string[];
}

/**
 * XMILE identifiers allow spaces and are case/underscore-insensitive; flowloom
 * identifiers are `[A-Za-z_]\w*`. Normalise, then de-duplicate.
 *
 * Two XMILE names that differ only in spacing or case are *the same name* by the
 * spec, so a file containing both is malformed — that is reported rather than
 * silently merged, because merging two variables into one is the kind of quiet
 * wrongness an import must never produce.
 */
function identifiers(names: Iterable<string>): { ids: Map<string, string>; collisions: string[][] } {
  const ids = new Map<string, string>();
  const seen = new Map<string, string[]>();
  const taken = new Set<string>();
  for (const raw of names) {
    const key = xmileKey(raw);
    const already = seen.get(key);
    if (already) { already.push(raw); continue; }
    seen.set(key, [raw]);
    let id = raw.trim().replace(/[\s.]+/g, "_").replace(/[^A-Za-z0-9_]/g, "");
    if (!id || /^\d/.test(id)) id = `v_${id}`;
    let name = id;
    for (let n = 2; taken.has(name); n++) name = `${id}${n}`;
    taken.add(name);
    ids.set(key, name);
  }
  return { ids, collisions: [...seen.values()].filter((g) => g.length > 1) };
}

/** XMILE treats spaces, underscores and case as insignificant in a name. */
const xmileKey = (s: string): string => s.trim().toLowerCase().replace(/[\s_]+/g, "");

/** Functions XMILE spells differently from flowloom, or spells the same. */
const FN: Record<string, string> = {
  abs: "abs", min: "min", max: "max", exp: "exp", ln: "ln", log10: "log10", sqrt: "sqrt",
  sin: "sin", cos: "cos", tan: "tan", int: "floor", round: "round",
  step: "step", pulse: "pulse", ramp: "ramp",
  smth1: "smooth", smth3: "smooth3", smthn: "smooth3", delay1: "delay1", delay3: "delay3",
  if_then_else: "if",
};

/** Functions with no flowloom equivalent — the model is imported with the call
 *  intact and a note, so the reader knows exactly what to replace. */
const UNSUPPORTED = new Set([
  "delayn", "forecast", "trend", "npv", "irr", "sample_if_true", "init", "previous",
  "normal", "lognormal", "poisson", "binomial", "random", "montecarlo",
  "sum", "prod", "mean", "stddev", "vmax", "vmin", "size",
]);

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Rewrite an XMILE equation into a flowloom expression.
 *
 * XMILE names may contain spaces, so this replaces *declared names literally*,
 * longest first, rather than scanning for word-shaped runs and guessing what
 * they belong to. Guessing is what would make this dangerous: an equation
 * mentioning `Total Population Growth` when only `Total Population` is declared
 * must not quietly become `Total_Population` with the rest dropped — a model
 * that parses and means something else is far worse than one that fails with a
 * name the parser can point at.
 *
 * So anything not declared and not a known function is left exactly as written.
 * If that leaves something flowloom can't parse, the caller reports it and hands
 * back the partial translation for a human to finish.
 */
function equation(eqn: string, names: Iterable<string>, ids: Map<string, string>, unknown: Set<string>): string {
  // XMILE `=` is comparison inside IF; flowloom uses `==`. Do this before any
  // identifier work so the operator can't be mistaken for part of a name.
  let s = eqn.replace(/\s+/g, " ").trim();
  s = s.replace(/([^<>=!])=([^=])/g, "$1==$2");
  s = s.replace(/<>/g, "!=");

  // IF a THEN b ELSE c  →  if(a, b, c)
  s = s.replace(/\bIF\b(.+?)\bTHEN\b(.+?)\bELSE\b(.+)$/is, (_all, c: string, a: string, b: string) => `if(${c.trim()}, ${a.trim()}, ${b.trim()})`);

  // Declared names, longest first so `Total Population` wins over `Population`.
  // Spaces and underscores are interchangeable in XMILE, and matching is
  // case-insensitive; `\b` guards mean a replacement's own output (which is
  // underscore-joined) can never be re-matched by a shorter pattern.
  for (const raw of [...names].sort((a, b) => b.length - a.length)) {
    const id = ids.get(xmileKey(raw));
    if (!id) continue;
    const pattern = raw.trim().split(/[\s_]+/).map(esc).join("[\\s_]+");
    s = s.replace(new RegExp(`\\b${pattern}\\b`, "gi"), id);
  }

  // Function names, after the declared names so a variable called `min` wins.
  s = s.replace(/\b[A-Za-z_]\w*(?=\s*\()/g, (word) => {
    const key = xmileKey(word);
    if (FN[key]) return FN[key]!;
    if (UNSUPPORTED.has(key)) unknown.add(word);
    return word;
  });
  return s.trim();
}

const numbers = (s: string | undefined): number[] =>
  (s ?? "").split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n));

/**
 * Read an XMILE (`.stmx`, `.xmile`) document and return it as `.flow` text.
 *
 * Throws only when the document is not XMILE at all; everything else it can't
 * represent comes back as a note.
 */
export function importXmile(xml: string): ImportResult {
  const notes: string[] = [];
  let doc;
  try {
    doc = parseXml(xml);
  } catch (e) {
    throw new XmlParseError(`not readable as XML: ${(e as Error).message}`);
  }
  if (!findAll(doc, "xmile").length && !findAll(doc, "model").length) {
    throw new XmlParseError("no <xmile> or <model> element — is this an XMILE (.stmx/.xmile) file?");
  }

  const models = findAll(doc, "model");
  if (models.length > 1) notes.push(`${models.length} <model> elements; imported the first (flowloom has one flat namespace — see \`include\` for composing parts)`);
  const model = models[0] ?? doc;
  const vars = child(model, "variables") ?? model;

  const stocks = findAll(vars, "stock");
  const flows = findAll(vars, "flow");
  const auxes = findAll(vars, "aux");
  // A <gf> either stands alone with a name, or sits *inside* an aux/flow — the
  // standard Stella shape, where the parent's <eqn> is the lookup's input. The
  // inline form has no name attribute, and skipping it would replace a nonlinear
  // curve with the identity: a model that runs and is confidently wrong.
  const namedGfs = findAll(vars, "gf").filter((g) => g.attrs.name);
  const inlineGfs = new Map<XmlNode, XmlNode>();
  for (const owner of [...auxes, ...flows]) {
    const g = child(owner, "gf");
    if (g && !g.attrs.name) inlineGfs.set(owner, g);
  }

  const named = [...stocks, ...flows, ...auxes, ...namedGfs].map((n) => n.attrs.name ?? "").filter(Boolean);
  const { ids, collisions } = identifiers(named);
  for (const group of collisions) {
    notes.push(`"${group.join('", "')}" are the same name in XMILE (spacing and case are not significant), so only the first was imported — rename them in the source file if they were meant to be different variables`);
  }
  const id = (raw: string): string => ids.get(xmileKey(raw)) ?? raw.trim().replace(/\s+/g, "_");
  const unknown = new Set<string>();
  const eq = (n: XmlNode): string => equation(childText(n, "eqn") ?? "0", named, ids, unknown);

  const lines: string[] = [];
  const comment = (n: XmlNode): string => {
    const doc = childText(n, "doc");
    return doc ? `   # ${doc.replace(/\s+/g, " ").slice(0, 160)}` : "";
  };
  const unit = (n: XmlNode): string => {
    const u = childText(n, "units");
    // flowloom units are identifier-ish; anything else would only produce noise
    // from the units checker, so it is dropped with the rest of the annotation.
    return u && /^[A-Za-z_][\w/*^ .-]*$/.test(u) ? ` [${u.trim().replace(/\s+/g, "_")}]` : "";
  };

  if (stocks.length === 0) notes.push("no <stock> elements — flowloom needs at least one stock to simulate; the import will not run as-is");

  for (const s of stocks) {
    const name = id(s.attrs.name!);
    if (s.attrs.dimensions || child(s, "dimensions")) notes.push(`stock "${s.attrs.name}" is subscripted in XMILE; imported as a scalar — re-declare it with \`dim\` if the array matters`);
    const nonNeg = childText(s, "non_negative") !== undefined || s.attrs.non_negative === "true";
    lines.push(`stock ${name}${unit(s)}${nonNeg ? " >= 0" : ""} = ${eq(s)}${comment(s)}`);
    const ins = s.children.filter((c) => c.name === "inflow").map((c) => id(c.text));
    const outs = s.children.filter((c) => c.name === "outflow").map((c) => id(c.text));
    const rate = [...ins, ...outs.map((o) => `-${o}`)].join(" + ").replace(/\+ -/g, "- ");
    lines.push(`change(${name}) = ${rate || "0"}`);
  }
  if (stocks.length) lines.push("");

  // Tables come first: an inline <gf> becomes a table the owning line calls, and
  // the table has to be declared before anything references it reads naturally.
  const tableLines: string[] = [];
  /** An inline <gf> on `owner`, as a table declaration plus the call to wrap the
   *  owner's own equation in. Returns undefined when the points are unusable. */
  const inlineTable = (owner: XmlNode): string | undefined => {
    const g = inlineGfs.get(owner);
    if (!g) return undefined;
    const xs = numbers(childText(g, "xpts")), ys = numbers(childText(g, "ypts"));
    const name = `${id(owner.attrs.name!)}_lookup`;
    if (xs.length < 2 || ys.length !== xs.length) {
      notes.push(`"${owner.attrs.name}" has an inline graphical function with no usable x/y points — imported as its equation alone, which is NOT the same curve`);
      return undefined;
    }
    tableLines.push(`table ${name} = ${xs.map((x, i) => `(${x}, ${ys[i]})`).join(" ")}`);
    return name;
  };

  for (const g of namedGfs) {
    const xs = numbers(childText(g, "xpts")), ys = numbers(childText(g, "ypts"));
    if (xs.length >= 2 && ys.length === xs.length) {
      tableLines.push(`table ${id(g.attrs.name!)} = ${xs.map((x, i) => `(${x}, ${ys[i]})`).join(" ")}`);
    } else {
      notes.push(`graphical function "${g.attrs.name}" has no usable x/y points; skipped`);
    }
  }

  const flowLines: string[] = [];
  for (const f of flows) {
    const lookup = inlineTable(f);
    const expr = eq(f);
    flowLines.push(`flow ${id(f.attrs.name!)}${unit(f)} = ${lookup ? `${lookup}(${expr})` : expr}${comment(f)}`);
  }

  const auxLines: string[] = [];
  for (const a of auxes) {
    const lookup = inlineTable(a);
    const expr = eq(a);
    // A bare number is a knob; anything with structure is a computation. XMILE
    // makes no distinction, but flowloom's sliders, sensitivity and calibration
    // all key off `param`, so getting this right is what makes the import useful
    // rather than merely runnable. A value fed through a lookup is never a knob.
    const kind = !lookup && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(expr) ? "param" : "aux";
    auxLines.push(`${kind} ${id(a.attrs.name!)}${unit(a)} = ${lookup ? `${lookup}(${expr})` : expr}${comment(a)}`);
  }

  if (tableLines.length) lines.push(...tableLines, "");
  if (flowLines.length) lines.push(...flowLines, "");
  if (auxLines.length) lines.push(...auxLines, "");

  const specs = child(model, "sim_specs") ?? findAll(doc, "sim_specs")[0];
  const num = (name: string): number | undefined => {
    if (!specs) return undefined;
    const v = Number(childText(specs, name));
    return Number.isFinite(v) ? v : undefined;
  };
  const start = num("start") ?? 0;
  const stop = num("stop") ?? 100;
  const dtNode = specs ? child(specs, "dt") : undefined;
  let dt = Number(dtNode?.text);
  if (dtNode?.attrs.reciprocal === "true" && dt > 0) dt = 1 / dt;
  if (!Number.isFinite(dt) || dt <= 0) dt = 1;
  const method = (specs?.attrs.method ?? "").toLowerCase().includes("rk") ? "rk4" : "euler";
  // XMILE writers put time_units either on the attribute or in a child element.
  const timeunit = specs ? (specs.attrs.time_units ?? childText(specs, "time_units")) : undefined;
  lines.push(`sim dt=${dt} to=${stop} start=${start} method=${method}${timeunit && /^\w+$/.test(timeunit) ? ` timeunit=${timeunit}` : ""}`);
  if (stocks.length) lines.push(`plot ${stocks.slice(0, 4).map((s) => id(s.attrs.name!)).join(" ")}`);

  if (method === "euler") notes.push("XMILE's default integration is Euler; imported as `method=euler`. Run `flowloom check --numerics` before trusting the numbers, and consider `method=rk4`");
  if (unknown.size) notes.push(`no flowloom equivalent for: ${[...unknown].join(", ")} — the calls were kept as written, so the model will not parse until you replace them`);
  if (findAll(model, "macro").length) notes.push("the file defines <macro>s; flowloom has no user-defined functions, so they were skipped");
  if (findAll(doc, "dimensions").length) notes.push("the file declares <dimensions>; arrays were flattened — see `dim` in docs/language.md to re-declare them");

  const text = lines.join("\n");
  // Round-trip through the parser so the import is validated and canonical.
  // If it doesn't parse, hand back the raw text plus the reason: a model the
  // reader can fix beats an exception that loses the whole translation.
  try {
    return { model: printModel(parseModel(text)), notes };
  } catch (e) {
    notes.push(`the imported model does not parse yet: ${(e as Error).message}`);
    return { model: text.replace(/\n{3,}/g, "\n\n"), notes };
  }
}
