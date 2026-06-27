import {
  type Model,
  type StockDecl,
  type RateDecl,
  type VarDecl,
  type TableDecl,
  type DimDecl,
  type VarKind,
  type SimSettings,
  type Diagnostic,
  type Loc,
  DEFAULT_SETTINGS,
} from "./types.js";
import { parseExpr, freeVars } from "./expr.js";
import { ExprSyntaxError } from "./tokenizer.js";
import { suggestName, suggestSuffix } from "./suggest.js";

// ── Model parser ────────────────────────────────────────────────────────────
// The line grammar. One statement per line; `#` starts a comment. This grammar
// IS the contract an AI reads and writes — keep it small, regular, and obvious.
//
//   stock NAME [unit] = EXPR        # an accumulator; EXPR is its initial value
//   change(NAME) = EXPR             # the net rate of change of a stock (d(NAME) is an alias)
//   flow  NAME [unit] = EXPR        # a named rate (drawn as a flow)
//   aux   NAME [unit] = EXPR        # an instantaneous computed value
//   param NAME [unit] = EXPR        # a constant knob
//   table NAME = (x,y) (x,y) ...    # a piecewise-linear graphical function
//   sim dt=0.1 to=50 start=0 method=rk4
//   plot A B C
//
// A trailing `# ...` after any declaration becomes that symbol's doc string.

export class ModelError extends Error {
  diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => `line ${d.loc.line}: ${d.message}`).join("\n"));
    this.name = "ModelError";
    this.diagnostics = diagnostics;
  }
}

interface Raw {
  stocks: StockDecl[];
  rates: Map<string, RateDecl>;
  vars: VarDecl[];
  varIndex: Map<string, VarDecl>;
  tables: Map<string, TableDecl>;
  dims: Map<string, DimDecl>;
  settings: SimSettings;
  plot: string[];
  names: Set<string>;
  diagnostics: Diagnostic[];
}

const RE = {
  dim: /^dim\s+([A-Za-z_]\w*)\s*=\s*(.+)$/,
  stock: /^stock\s+([A-Za-z_]\w*)\s*(?:\[([^\]]*)\])?\s*=\s*(.+)$/,
  rate: /^(?:change|d)\(\s*([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\)\s*=\s*(.+)$/,
  var: /^(flow|aux|param|const)\s+([A-Za-z_]\w*)\s*(?:\[([^\]]*)\])?\s*=\s*(.+)$/,
  table: /^table\s+([A-Za-z_]\w*)\s*=\s*(.+)$/,
  sim: /^sim\s+(.+)$/,
  plot: /^plot\s+(.+)$/,
};

/** Parse model text. Returns a Model with diagnostics; throws ModelError only on hard failure. */
export function parseModel(text: string): Model {
  const m: Raw = {
    stocks: [],
    rates: new Map(),
    vars: [],
    varIndex: new Map(),
    tables: new Map(),
    dims: new Map(),
    settings: { ...DEFAULT_SETTINGS },
    plot: [],
    names: new Set(),
    diagnostics: [],
  };

  const lines = text.split(/\r?\n/);
  lines.forEach((rawLine, i) => {
    const line = i + 1;
    parseLine(m, stripComment(rawLine), extractDoc(rawLine), line);
  });

  const errors = m.diagnostics.filter((d) => d.severity === "error");

  if (m.stocks.length === 0 && errors.length === 0) {
    push(m, "error", { line: 1, col: 0 }, "no stocks defined — a model needs at least one `stock NAME = value`");
  }

  // Every d(NAME) must target a real stock.
  for (const [name, r] of m.rates) {
    if (!m.stocks.some((s) => s.name === name)) {
      push(m, "error", r.loc, `change(${name}) has no matching \`stock ${name}\``);
    }
  }

  // A bracket [X] (or [X, Y, …]) is a subscript dimension list when every token
  // names a declared `dim`; otherwise it's the legacy unit annotation. Resolve now
  // that all dims are known.
  for (const d of [...m.stocks, ...m.vars]) {
    if (!d.unit) continue;
    const toks = d.unit.split(/[\s,]+/).filter(Boolean);
    if (toks.length && toks.every((t) => m.dims.has(t))) { d.dims = toks; d.unit = undefined; }
  }

  // Per-element value lists (`name[dim] = a, b`) need a subscript, and as many
  // values as the dimensions have element tuples (the Cartesian product).
  for (const d of [...m.stocks, ...m.vars]) {
    if (!d.elemExprs) continue;
    if (!d.dims) {
      push(m, "error", d.loc, `'${d.name}' has a comma-separated value but no subscript — per-element values need a dimension, e.g. ${d.name}[dim] = a, b`);
      continue;
    }
    const n = d.dims.reduce((acc, dim) => acc * (m.dims.get(dim)?.elements.length ?? 0), 1);
    if (d.elemExprs.length !== n) {
      push(m, "error", d.loc, `'${d.name}[${d.dims.join(", ")}]' has ${n} element(s) but ${d.elemExprs.length} value(s) were given`);
    }
  }

  const order = topoSort(m);

  validateReferences(m);
  validateSubscripts(m);

  const model: Model = {
    stocks: m.stocks,
    rates: m.rates,
    vars: m.vars,
    varIndex: m.varIndex,
    tables: m.tables,
    dims: m.dims,
    settings: m.settings,
    plot: m.plot,
    order,
    diagnostics: m.diagnostics,
  };

  const hard = m.diagnostics.filter((d) => d.severity === "error");
  if (hard.length) throw new ModelError(hard);
  return model;
}

function stripComment(raw: string): string {
  return raw.replace(/#.*$/, "").trim();
}

/** Split a declaration RHS on top-level commas (not nested in `()`/`[]`), so a
 *  subscripted decl can list one value per element while `min(a, b)` stays whole. */
function splitTopLevel(src: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) { parts.push(src.slice(start, i)); start = i + 1; }
  }
  parts.push(src.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** The expressions of a declaration: its per-element list if present, else the one. */
const stockExprs = (s: StockDecl) => s.elemExprs ?? [s.initExpr];
const varExprs = (v: VarDecl) => v.elemExprs ?? [v.expr];

function extractDoc(raw: string): string | undefined {
  const m = raw.match(/#\s*(.+?)\s*$/);
  return m ? m[1] : undefined;
}

function parseLine(m: Raw, line: string, doc: string | undefined, lineNo: number): void {
  if (!line) return;
  const loc: Loc = { line: lineNo, col: 0 };
  let mt: RegExpMatchArray | null;

  try {
    if ((mt = line.match(RE.dim))) {
      const [, name, body] = mt;
      const elements = body!.split(/[\s,]+/).filter(Boolean);
      if (elements.length === 0) push(m, "error", loc, `dim ${name} needs at least one element`);
      if (m.dims.has(name!)) push(m, "error", loc, `dim ${name} is defined twice`);
      m.dims.set(name!, { name: name!, elements, loc });
    } else if ((mt = line.match(RE.stock))) {
      const [, name, unit, expr] = mt;
      claim(m, name!, loc);
      const exprs = splitTopLevel(expr!).map((p) => parseExpr(p, lineNo));
      const s: StockDecl = { name: name!, initExpr: exprs[0]!, unit: unit?.trim(), doc, loc };
      if (exprs.length > 1) s.elemExprs = exprs;
      m.stocks.push(s);
    } else if ((mt = line.match(RE.rate))) {
      const [, name, expr] = mt;
      if (m.rates.has(name!)) push(m, "error", loc, `change(${name}) is defined twice`);
      m.rates.set(name!, { target: name!, expr: parseExpr(expr!, lineNo), loc });
    } else if ((mt = line.match(RE.var))) {
      const [, kw, name, unit, expr] = mt;
      claim(m, name!, loc);
      const kind: VarKind = kw === "const" ? "param" : (kw as VarKind);
      const exprs = splitTopLevel(expr!).map((p) => parseExpr(p, lineNo));
      const v: VarDecl = { name: name!, kind, expr: exprs[0]!, unit: unit?.trim(), doc, loc };
      if (exprs.length > 1) v.elemExprs = exprs;
      m.vars.push(v);
      m.varIndex.set(name!, v);
    } else if ((mt = line.match(RE.table))) {
      const [, name, body] = mt;
      claim(m, name!, loc);
      m.tables.set(name!, parseTable(name!, body!, loc));
    } else if ((mt = line.match(RE.sim))) {
      parseSim(m, mt[1]!, loc);
    } else if ((mt = line.match(RE.plot))) {
      m.plot = mt[1]!.split(/[\s,]+/).filter(Boolean);
    } else {
      push(m, "error", loc, `don't understand this line:\n  ${line}`);
    }
  } catch (e) {
    if (e instanceof ExprSyntaxError) {
      push(m, "error", e.loc, e.message);
    } else {
      throw e;
    }
  }
}

function parseTable(name: string, body: string, loc: Loc): TableDecl {
  const points: Array<[number, number]> = [];
  const re = /\(\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*\)/g;
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(body))) {
    points.push([Number(mt[1]), Number(mt[2])]);
  }
  if (points.length < 2) {
    throw new ExprSyntaxError(`table ${name} needs at least two (x,y) points`, loc);
  }
  // x must be strictly increasing for piecewise-linear interpolation
  for (let i = 1; i < points.length; i++) {
    if (points[i]![0] <= points[i - 1]![0]) {
      throw new ExprSyntaxError(`table ${name} x-values must strictly increase`, loc);
    }
  }
  return { name, points, loc };
}

function parseSim(m: Raw, body: string, loc: Loc): void {
  for (const tok of body.split(/\s+/)) {
    const [k, v] = tok.split("=");
    if (v === undefined) continue;
    if (k === "dt") m.settings.dt = num(m, v, loc, "dt");
    else if (k === "to") m.settings.to = num(m, v, loc, "to");
    else if (k === "start") m.settings.start = num(m, v, loc, "start");
    else if (k === "method") {
      if (v === "euler" || v === "rk4") m.settings.method = v;
      else push(m, "error", loc, `unknown method '${v}' (use euler or rk4)`);
    } else if (k === "timeunit") m.settings.timeunit = v;
    else if (k === "seed") m.settings.seed = num(m, v, loc, "seed");
    else {
      push(m, "warning", loc, `unknown sim setting '${k}'`);
    }
  }
}

function num(m: Raw, s: string, loc: Loc, what: string): number {
  const v = Number(s);
  if (!Number.isFinite(v)) {
    push(m, "error", loc, `${what} must be a number, got '${s}'`);
    return what === "dt" ? DEFAULT_SETTINGS.dt : DEFAULT_SETTINGS.to;
  }
  return v;
}

function claim(m: Raw, name: string, loc: Loc): void {
  if (RESERVED.has(name)) {
    push(m, "error", loc, `'${name}' is a reserved name`);
    return;
  }
  if (m.names.has(name)) {
    push(m, "error", loc, `'${name}' is defined twice`);
    return;
  }
  m.names.add(name);
}

const RESERVED = new Set(["t", "dt", "PI", "E", "time"]);

function push(m: Raw, severity: Diagnostic["severity"], loc: Loc, message: string): void {
  m.diagnostics.push({ severity, loc, message });
}

// ── Topological sort of aux/flow/param by inter-variable dependency ─────────
// Stocks are state (excluded — they break algebraic loops). Tables are nullary
// lookups referenced by name in calls, not data dependencies here.
function topoSort(m: Raw): VarDecl[] {
  const varNames = new Set(m.vars.map((v) => v.name));
  const deps = new Map<string, Set<string>>();
  const indeg = new Map<string, number>();

  for (const v of m.vars) {
    const d = new Set<string>();
    for (const ex of varExprs(v)) {
      for (const id of freeVars(ex)) {
        if (varNames.has(id) && id !== v.name) d.add(id);
      }
    }
    deps.set(v.name, d);
    indeg.set(v.name, d.size);
  }

  const ready = m.vars.filter((v) => indeg.get(v.name) === 0).map((v) => v.name);
  const order: string[] = [];
  while (ready.length) {
    const n = ready.shift()!;
    order.push(n);
    for (const v of m.vars) {
      const d = deps.get(v.name)!;
      if (d.has(n)) {
        d.delete(n);
        const k = indeg.get(v.name)! - 1;
        indeg.set(v.name, k);
        if (k === 0) ready.push(v.name);
      }
    }
  }

  if (order.length !== m.vars.length) {
    const stuck = m.vars.filter((v) => !order.includes(v.name)).map((v) => v.name);
    push(
      m,
      "error",
      m.varIndex.get(stuck[0]!)?.loc ?? { line: 1, col: 0 },
      `algebraic loop among: ${stuck.join(" → ")}\n` +
        `(a flow/aux can't instantaneously depend on itself — route it through a stock, or use a DELAY)`,
    );
    return m.vars.slice();
  }
  return order.map((n) => m.varIndex.get(n)!);
}

// ── Reference validation: every identifier must resolve to something ────────
function validateReferences(m: Raw): void {
  const known = new Set<string>([
    "t",
    "time",
    ...m.stocks.map((s) => s.name),
    ...m.vars.map((v) => v.name),
  ]);
  const tables = new Set(m.tables.keys());

  const check = (expr: Parameters<typeof freeVars>[0], loc: Loc) => {
    for (const id of freeVars(expr)) {
      if (!known.has(id) && !tables.has(id) && !BUILTIN_CONSTS.has(id)) {
        const suffix = suggestSuffix(id, [...known, ...tables, ...BUILTIN_CONSTS],
          "define it (stock/param/aux/flow) or check the spelling");
        push(m, "error", loc, `unknown name '${id}'${suffix}`);
      }
    }
  };

  for (const s of m.stocks) for (const ex of stockExprs(s)) check(ex, s.loc);
  for (const v of m.vars) for (const ex of varExprs(v)) check(ex, v.loc);
  for (const r of m.rates.values()) check(r.expr, r.loc);

  for (const name of m.plot) {
    if (!known.has(name)) {
      const hint = suggestName(name, known);
      push(m, "warning", { line: 1, col: 0 }, `plot references unknown series '${name}'${hint ? ` — did you mean '${hint}'?` : ""}`);
    }
  }
}

const BUILTIN_CONSTS = new Set(["PI", "E"]);

/** Check subscript usage: valid index refs, sum of a subscripted symbol, and no
 *  bare reference to a vector outside sum(). Mirrors what scalarize.ts enforces,
 *  but at parse time so the editor flags it. */
function validateSubscripts(m: Raw): void {
  const dimsOf = new Map<string, string[]>();
  for (const s of m.stocks) if (s.dims) dimsOf.set(s.name, s.dims);
  for (const v of m.vars) if (v.dims) dimsOf.set(v.name, v.dims);
  if (!m.dims.size && !dimsOf.size) return; // nothing subscripted

  const elems = (d: string) => m.dims.get(d)?.elements ?? [];

  // `scope` is the set of dimensions bound by the declaration being checked (its
  // own subscripts), so a partial sum can tell which leftover axis would escape.
  const walk = (e: Parameters<typeof freeVars>[0], loc: Loc, insideSum: boolean, scope: Set<string>): void => {
    switch (e.kind) {
      case "ident":
        if (dimsOf.has(e.name) && !insideSum) {
          push(m, "error", loc, `'${e.name}' is subscripted — index it (${e.name}[${dimsOf.get(e.name)!.join(", ")}]) or aggregate it (sum(${e.name}))`);
        }
        break;
      case "index": {
        const dims = dimsOf.get(e.name);
        if (!dims) { push(m, "error", loc, `'${e.name}' is not subscripted, so '${e.name}[${e.subs.join(", ")}]' is invalid`); break; }
        if (e.subs.length !== dims.length) {
          push(m, "error", loc, `'${e.name}' has ${dims.length} dimension(s) [${dims.join(", ")}] but is indexed with ${e.subs.length}`);
          break;
        }
        e.subs.forEach((s, i) => {
          const di = dims[i]!;
          if (s === di || elems(di).includes(s)) return; // elementwise, or a literal element
          push(m, "error", loc, m.dims.has(s)
            ? `'${e.name}[${e.subs.join(", ")}]' indexes position ${i + 1} with dimension '${s}', but that position is '${di}'`
            : `'${s}' is not an element of dimension '${di}'`);
        });
        break;
      }
      case "unary":
        walk(e.arg, loc, insideSum, scope);
        break;
      case "binary":
        walk(e.left, loc, insideSum, scope);
        walk(e.right, loc, insideSum, scope);
        break;
      case "call": {
        if (e.name.toLowerCase() === "sum") {
          const a = e.args[0];
          const base = a && (a.kind === "ident" || a.kind === "index") ? a.name : undefined;
          const dims = base ? dimsOf.get(base) : undefined;
          if (!base || !dims) { push(m, "error", loc, "sum() needs a subscripted argument, e.g. sum(Population)"); break; }
          walk(a!, loc, true, scope); // the array arg may itself be an index expression
          // Trailing args name the axes to collapse; each must be a dim of `base`.
          const axes: string[] = [];
          let badAxis = false;
          for (const ax of e.args.slice(1)) {
            if (ax.kind !== "ident" || !dims.includes(ax.name)) {
              push(m, "error", loc, `sum()'s axis must be a dimension of '${base}' (one of ${dims.join(", ")})`);
              badAxis = true;
            } else axes.push(ax.name);
          }
          if (badAxis) break;
          // Whatever isn't collapsed must be supplied by the surrounding context.
          const collapsed = new Set(axes.length ? axes : dims);
          for (const d of dims) {
            if (!collapsed.has(d) && !scope.has(d)) {
              push(m, "error", loc, `sum() over ${(axes.length ? axes : dims).join(", ")} leaves dimension '${d}' free — declare the result over '[${d}]'`);
            }
          }
        } else {
          e.args.forEach((arg) => walk(arg, loc, insideSum, scope));
        }
        break;
      }
    }
  };

  for (const s of m.stocks) { const scope = new Set(s.dims ?? []); for (const ex of stockExprs(s)) walk(ex, s.loc, false, scope); }
  for (const v of m.vars) { const scope = new Set(v.dims ?? []); for (const ex of varExprs(v)) walk(ex, v.loc, false, scope); }
  for (const r of m.rates.values()) walk(r.expr, r.loc, false, new Set(dimsOf.get(r.target) ?? []));
}
