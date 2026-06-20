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
  rate: /^(?:change|d)\(\s*([A-Za-z_]\w*)\s*(?:\[\s*[A-Za-z_]\w*\s*\])?\s*\)\s*=\s*(.+)$/,
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

  // A bracket [X] is a subscript dimension when X names a declared `dim`; otherwise
  // it's the legacy unit annotation. Resolve now that all dims are known.
  for (const d of [...m.stocks, ...m.vars]) {
    if (d.unit && m.dims.has(d.unit)) { d.dim = d.unit; d.unit = undefined; }
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
      m.stocks.push({ name: name!, initExpr: parseExpr(expr!, lineNo), unit: unit?.trim(), doc, loc });
    } else if ((mt = line.match(RE.rate))) {
      const [, name, expr] = mt;
      if (m.rates.has(name!)) push(m, "error", loc, `change(${name}) is defined twice`);
      m.rates.set(name!, { target: name!, expr: parseExpr(expr!, lineNo), loc });
    } else if ((mt = line.match(RE.var))) {
      const [, kw, name, unit, expr] = mt;
      claim(m, name!, loc);
      const kind: VarKind = kw === "const" ? "param" : (kw as VarKind);
      const v: VarDecl = { name: name!, kind, expr: parseExpr(expr!, lineNo), unit: unit?.trim(), doc, loc };
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
    for (const id of freeVars(v.expr)) {
      if (varNames.has(id) && id !== v.name) d.add(id);
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

  for (const s of m.stocks) check(s.initExpr, s.loc);
  for (const v of m.vars) check(v.expr, v.loc);
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
  const dimOf = new Map<string, string>();
  for (const s of m.stocks) if (s.dim) dimOf.set(s.name, s.dim);
  for (const v of m.vars) if (v.dim) dimOf.set(v.name, v.dim);
  if (!m.dims.size && !dimOf.size) return; // nothing subscripted

  const elems = (d: string) => m.dims.get(d)?.elements ?? [];

  const walk = (e: Parameters<typeof freeVars>[0], loc: Loc, insideSum: boolean): void => {
    switch (e.kind) {
      case "ident":
        if (dimOf.has(e.name) && !insideSum) {
          push(m, "error", loc, `'${e.name}' is subscripted — index it (${e.name}[${dimOf.get(e.name)}]) or aggregate it (sum(${e.name}))`);
        }
        break;
      case "index": {
        const d = dimOf.get(e.name);
        if (!d) push(m, "error", loc, `'${e.name}' is not subscripted, so '${e.name}[${e.sub}]' is invalid`);
        else if (e.sub !== d && !elems(d).includes(e.sub)) {
          push(m, "error", loc, m.dims.has(e.sub)
            ? `'${e.name}[${e.sub}]' mixes dimensions — use '${d}' elementwise or a single element`
            : `'${e.sub}' is not an element of dimension '${d}'`);
        }
        break;
      }
      case "unary":
        walk(e.arg, loc, insideSum);
        break;
      case "binary":
        walk(e.left, loc, insideSum);
        walk(e.right, loc, insideSum);
        break;
      case "call": {
        if (e.name.toLowerCase() === "sum") {
          const a = e.args[0];
          const base = a && (a.kind === "ident" || a.kind === "index") ? a.name : undefined;
          if (!base || !dimOf.has(base)) push(m, "error", loc, "sum() needs a subscripted argument, e.g. sum(Population)");
          e.args.forEach((arg) => walk(arg, loc, true));
        } else {
          e.args.forEach((arg) => walk(arg, loc, insideSum));
        }
        break;
      }
    }
  };

  for (const s of m.stocks) walk(s.initExpr, s.loc, false);
  for (const v of m.vars) walk(v.expr, v.loc, false);
  for (const r of m.rates.values()) walk(r.expr, r.loc, false);
}
