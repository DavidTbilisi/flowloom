import {
  type Model,
  type StockDecl,
  type RateDecl,
  type VarDecl,
  type TableDecl,
  type VarKind,
  type SimSettings,
  type Diagnostic,
  type Loc,
  DEFAULT_SETTINGS,
} from "./types.js";
import { parseExpr, freeVars } from "./expr.js";
import { ExprSyntaxError } from "./tokenizer.js";
import { suggestName } from "./suggest.js";

// ── Model parser ────────────────────────────────────────────────────────────
// The line grammar. One statement per line; `#` starts a comment. This grammar
// IS the contract an AI reads and writes — keep it small, regular, and obvious.
//
//   stock NAME [unit] = EXPR        # an accumulator; EXPR is its initial value
//   d(NAME) = EXPR                  # dNAME/dt — the net rate of change
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
  settings: SimSettings;
  plot: string[];
  names: Set<string>;
  diagnostics: Diagnostic[];
}

const RE = {
  stock: /^stock\s+([A-Za-z_]\w*)\s*(?:\[([^\]]*)\])?\s*=\s*(.+)$/,
  rate: /^d\(\s*([A-Za-z_]\w*)\s*\)\s*=\s*(.+)$/,
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
      push(m, "error", r.loc, `d(${name}) has no matching \`stock ${name}\``);
    }
  }

  const order = topoSort(m);

  validateReferences(m);

  const model: Model = {
    stocks: m.stocks,
    rates: m.rates,
    vars: m.vars,
    varIndex: m.varIndex,
    tables: m.tables,
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
    if ((mt = line.match(RE.stock))) {
      const [, name, unit, expr] = mt;
      claim(m, name!, loc);
      m.stocks.push({ name: name!, initExpr: parseExpr(expr!, lineNo), unit: unit?.trim(), doc, loc });
    } else if ((mt = line.match(RE.rate))) {
      const [, name, expr] = mt;
      if (m.rates.has(name!)) push(m, "error", loc, `d(${name}) is defined twice`);
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
    } else {
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
        const hint = suggestName(id, [...known, ...tables, ...BUILTIN_CONSTS]);
        push(m, "error", loc, `unknown name '${id}'${hint ? ` — did you mean '${hint}'?` : ""}`);
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
