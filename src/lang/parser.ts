import {
  type Model,
  type StockDecl,
  type RateDecl,
  type VarDecl,
  type TableDecl,
  type DimDecl,
  type ScenarioDecl,
  type ExpectDecl,
  type ScenarioSet,
  type LinkDecl,
  type VarKind,
  type SimSettings,
  type Diagnostic,
  type Loc,
  DEFAULT_SETTINGS,
} from "./types.js";
import { parseExpr, freeVars, instantVars, declExprs } from "./expr.js";
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
//   const NAME [unit] = EXPR        # a structural constant — not a knob (no slider, no sensitivity)
//   switch NAME = on|off            # a 0/1 policy toggle (a boolean param)
//   table NAME = (x,y) (x,y) ...    # a piecewise-linear graphical function
//   scenario NAME key=value …       # a named set of overrides, applied on request
//   link A -> B +                   # a declared signed influence (a causal-loop sketch; + or -)
//   sim dt=0.1 to=50 start=0 method=rk4        (method: euler | rk4 | map)
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
  scenarios: Map<string, ScenarioDecl>;
  links: LinkDecl[];
  expects: ExpectDecl[];
  settings: SimSettings;
  plot: string[];
  names: Set<string>;
  diagnostics: Diagnostic[];
}

/** Words accepted as switch / scenario-switch values, and the 0/1 they mean. */
export const SWITCH_WORDS: Record<string, number> = { on: 1, off: 0, true: 1, false: 0, yes: 1, no: 0 };

/** Sim-setting keys a scenario (or `--set`) may bind. One list, shared with overrides.ts. */
export const SETTING_KEYS = ["dt", "to", "start", "seed", "method"] as const;

const RE = {
  dim: /^dim\s+([A-Za-z_]\w*)\s*=\s*(.+)$/,
  stock: /^stock\s+([A-Za-z_]\w*)\s*(?:\[([^\]]*)\])?\s*=\s*(.+)$/,
  rate: /^(?:change|d)\(\s*([A-Za-z_]\w*)\s*(?:\[\s*[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*\s*\])?\s*\)\s*=\s*(.+)$/,
  var: /^(flow|aux|param|const|switch)\s+([A-Za-z_]\w*)\s*(?:\[([^\]]*)\])?\s*=\s*(.+)$/,
  table: /^table\s+([A-Za-z_]\w*)\s*=\s*(.+)$/,
  data: /^data\s+([A-Za-z_]\w*)\s*(?:\[([^\]]*)\])?\s*=\s*(.+)$/,
  scenario: /^scenario\s+([A-Za-z_]\w*)\s*:?\s*(.*)$/,
  link: /^link\s+([A-Za-z_]\w*)\s*(?:->|→)\s*([A-Za-z_]\w*)\s*([+-]|\+|−)?\s*$/,
  expect: /^expect\s+(.+)$/,
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
    scenarios: new Map(),
    links: [],
    expects: [],
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

  // A model needs something to integrate — unless it is a qualitative sketch
  // (links only), which draws and has loops but does not run.
  if (m.stocks.length === 0 && m.links.length === 0 && errors.length === 0) {
    push(m, "error", { line: 1, col: 0 }, "no stocks defined — a model needs at least one `stock NAME = value` (or, for a causal-loop sketch, `link A -> B +` lines)");
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
  validateScenarios(m);
  validateExpects(m);

  const model: Model = {
    stocks: m.stocks,
    rates: m.rates,
    vars: m.vars,
    varIndex: m.varIndex,
    tables: m.tables,
    dims: m.dims,
    scenarios: m.scenarios,
    links: m.links,
    expects: m.expects,
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
 *  subscripted decl can list one value per element while `min(a, b)` stays whole.
 *  Empty parts are KEPT (not filtered) so a stray/trailing comma surfaces as an
 *  "expected a value" parse error rather than being silently swallowed. */
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
  return parts.map((p) => p.trim());
}

/** The expressions of a declaration: its per-element list if present, else the one. */
const stockExprs = (s: StockDecl) => declExprs(s.initExpr, s.elemExprs);
const varExprs = (v: VarDecl) => declExprs(v.expr, v.elemExprs);

function extractDoc(raw: string): string | undefined {
  const m = raw.match(/#\s*(.+?)\s*$/);
  return m ? m[1] : undefined;
}

/** Pull a `@rung N` tag (Meadows' twelve leverage points, 12 = constants … 1 =
 *  transcending paradigms) out of a doc string. Returns the rung and the doc
 *  with the tag removed. */
function extractRung(doc: string | undefined, m: Raw, loc: Loc): { doc: string | undefined; rung?: number } {
  if (!doc) return { doc };
  const mt = doc.match(/(?:^|\s)@rung\s+(\d+)\b/);
  if (!mt) return { doc };
  const rung = Number(mt[1]);
  const rest = doc.replace(mt[0], " ").replace(/\s+/g, " ").trim();
  if (rung < 1 || rung > 12) {
    push(m, "warning", loc, `@rung ${rung} — Meadows' ladder runs 12 (constants) down to 1 (transcending paradigms); the tag is ignored`);
    return { doc: rest || undefined };
  }
  return { doc: rest || undefined, rung };
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
      if (kw === "switch") {
        // A switch is a param that may only be 0 or 1. `on`/`off` (and friends)
        // are sugar for the literal; anything else is rejected so a switch can't
        // silently hold 0.5 — the whole point is that sensitivity, sliders, and
        // overrides can treat it as a two-state toggle.
        const raw = expr!.trim();
        const word = SWITCH_WORDS[raw.toLowerCase()];
        const ex = word !== undefined ? parseExpr(String(word), lineNo) : parseExpr(raw, lineNo);
        if (!(ex.kind === "num" && (ex.value === 0 || ex.value === 1))) {
          push(m, "error", loc, `switch ${name} must be on or off (1 or 0), got '${raw}'`);
        }
        if (unit && unit.trim()) push(m, "error", loc, `switch ${name} can't carry a unit or subscript — it is a bare on/off toggle`);
        const tag = extractRung(doc, m, loc);
        const v: VarDecl = { name: name!, kind: "param", expr: ex, boolean: true, doc: tag.doc, loc };
        if (tag.rung !== undefined) v.rung = tag.rung;
        m.vars.push(v);
        m.varIndex.set(name!, v);
        return;
      }
      const kind: VarKind = kw === "const" ? "param" : (kw as VarKind);
      const exprs = splitTopLevel(expr!).map((p) => parseExpr(p, lineNo));
      const tag = extractRung(doc, m, loc);
      const v: VarDecl = { name: name!, kind, expr: exprs[0]!, unit: unit?.trim(), doc: tag.doc, loc };
      if (kw === "const") v.constant = true;
      if (tag.rung !== undefined) v.rung = tag.rung;
      if (exprs.length > 1) v.elemExprs = exprs;
      m.vars.push(v);
      m.varIndex.set(name!, v);
    } else if ((mt = line.match(RE.scenario))) {
      const [, name, body] = mt;
      if (name === "base") push(m, "error", loc, "'base' is the model itself — pick another scenario name");
      if (m.scenarios.has(name!)) push(m, "error", loc, `scenario ${name} is defined twice`);
      const sets: ScenarioSet[] = [];
      for (const tok of body!.split(/\s+/).filter(Boolean)) {
        const eq = tok.indexOf("=");
        if (eq <= 0 || eq === tok.length - 1) {
          push(m, "error", loc, `scenario ${name}: expected key=value, got '${tok}'`);
          continue;
        }
        sets.push({ key: tok.slice(0, eq), value: tok.slice(eq + 1) });
      }
      if (!sets.length) push(m, "error", loc, `scenario ${name} needs at least one key=value (a param, switch, stock init, or ${SETTING_KEYS.join("/")})`);
      const tag = extractRung(doc, m, loc);
      const sc: ScenarioDecl = { name: name!, sets, doc: tag.doc, loc };
      if (tag.rung !== undefined) sc.rung = tag.rung;
      m.scenarios.set(name!, sc);
    } else if ((mt = line.match(RE.link))) {
      const [, from, to, sg] = mt;
      if (!sg) { push(m, "error", loc, `link ${from} -> ${to} needs a sign: + (same direction) or - (opposite)`); return; }
      const sign: 1 | -1 = sg === "+" ? 1 : -1;
      if (m.links.some((l) => l.from === from && l.to === to)) push(m, "error", loc, `link ${from} -> ${to} is declared twice`);
      if (RESERVED.has(from!) || RESERVED.has(to!)) push(m, "error", loc, `a link can't use the reserved name '${RESERVED.has(from!) ? from : to}'`);
      m.links.push({ from: from!, to: to!, sign, doc, loc });
    } else if ((mt = line.match(RE.data))) {
      // A measured series: desugars to an internal step-hold table on the clock
      // plus an ordinary aux that reads it, so every consumer (plots, diff,
      // expect, units, loops) sees a plain named series.
      const [, name, unit, body] = mt;
      claim(m, name!, loc);
      let pts = body!;
      let hold = true;
      const mode = pts.match(/\b(linear|hold)\s*$/);
      if (mode) { hold = mode[1] === "hold"; pts = pts.slice(0, mode.index); }
      const tname = `${name}#data`;
      const table = parseTable(name!, pts, loc);
      table.name = tname;
      if (hold) table.hold = true;
      m.tables.set(tname, table);
      const v: VarDecl = { name: name!, kind: "aux", expr: { kind: "call", name: tname, args: [{ kind: "ident", name: "t", loc }], loc }, unit: unit?.trim(), data: true, doc, loc };
      m.vars.push(v);
      m.varIndex.set(name!, v);
    } else if ((mt = line.match(RE.expect))) {
      parseExpect(m, mt[1]!, doc, loc);
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
      if (v === "euler" || v === "rk4" || v === "map") m.settings.method = v;
      else push(m, "error", loc, `unknown method '${v}' (use euler, rk4 or map)`);
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
  // A var named like a sim setting is legal but a trap: `--set start=5` and a
  // scenario's `start=5` bind the *setting*, never this name.
  if ((SETTING_KEYS as readonly string[]).includes(name)) {
    push(m, "warning", loc, `'${name}' is also a sim setting — --set and scenario bindings of '${name}' change the setting, not this declaration; rename it (e.g. ${name}0) to make it overridable`);
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
      // Instantaneous deps only: the input of a delay/smooth/previous() is read
      // from earlier steps, so it doesn't make a cycle algebraic.
      for (const id of instantVars(ex)) {
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
    "dt",
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

/** Every scenario binding must target something an override can rebind — a
 *  param/switch, a stock's initial value, or a sim setting — with a value of the
 *  right shape. Checked at parse time so a typo in a scenario is a located error
 *  in the editor, not a surprise when the scenario is finally selected. */
/** Metric ops resolveMetric() understands, plus the loop-census pseudo-metrics. */
export const METRIC_OPS = ["final", "max", "min", "mean", "at", "time-to-peak", "settle-time", "rmse"] as const;
export const LOOP_METRICS = ["active", "total", "reinforcing", "balancing", "inactive", "rank"] as const;
const EXPECT_OPS = new Set(["<", "<=", ">", ">=", "=="]);

/** `expect [SCENARIO] METRIC OP VALUE [± TOL[%]]`. The scenario is optional and
 *  recognisable without lookahead: a metric spec always carries a colon, a
 *  scenario name never does. `base` names the model itself. */
function parseExpect(m: Raw, body: string, doc: string | undefined, loc: Loc): void {
  const toks = body.split(/\s+/).filter(Boolean);
  const usage = "expect [scenario] <op>:<series> <|<=|>|>=|== <number> [± <tol>[%]]";
  let scenario: string | undefined;
  if (toks.length && !toks[0]!.includes(":")) scenario = toks.shift();
  const [metric, op, valueTok, pm, tolTok, ...extra] = toks;
  if (!metric || !op || valueTok === undefined) { push(m, "error", loc, `expect: ${usage}`); return; }
  if (!EXPECT_OPS.has(op)) { push(m, "error", loc, `expect: comparison must be one of < <= > >= ==, got '${op}'`); return; }
  const value = Number(valueTok);
  if (!Number.isFinite(value)) { push(m, "error", loc, `expect: expected a number after '${op}', got '${valueTok}'`); return; }
  const e: ExpectDecl = { metric, op: op as ExpectDecl["op"], value, loc };
  if (scenario && scenario !== "base") e.scenario = scenario;
  if (doc) e.doc = doc;
  if (pm !== undefined) {
    if (!(pm === "±" || pm === "+-" || pm === "+/-") || tolTok === undefined) { push(m, "error", loc, `expect: a tolerance is written ± <number> or ± <percent>%, got '${[pm, tolTok].filter((x) => x !== undefined).join(" ")}'`); return; }
    if (op !== "==") push(m, "warning", loc, `expect: a tolerance only applies to ==, ignored after '${op}'`);
    const pct = tolTok.endsWith("%");
    const tv = Number(pct ? tolTok.slice(0, -1) : tolTok);
    if (!Number.isFinite(tv) || tv < 0) { push(m, "error", loc, `expect: tolerance must be a non-negative number, got '${tolTok}'`); return; }
    if (op === "==") e.tol = { value: pct ? tv / 100 : tv, pct };
  }
  if (extra.length) { push(m, "error", loc, `expect: unexpected '${extra.join(" ")}' — ${usage}`); return; }
  m.expects.push(e);
}

function validateExpects(m: Raw): void {
  const seriesNames = [...m.stocks.map((s) => s.name), ...m.vars.filter((v) => v.kind !== "param").map((v) => v.name)];
  for (const e of m.expects) {
    if (e.scenario && !m.scenarios.has(e.scenario)) {
      const hint = suggestName(e.scenario, [...m.scenarios.keys()]);
      push(m, "error", e.loc, `expect: no scenario named '${e.scenario}'${hint ? ` — did you mean '${hint}'?` : ""} (or did you mean a metric like final:${e.scenario}?)`);
      continue;
    }
    const parts = e.metric.split(":");
    const op = parts[0]!;
    if (op === "loops") {
      if (parts.length !== 2 || !(LOOP_METRICS as readonly string[]).includes(parts[1]!)) push(m, "error", e.loc, `expect: loops:<what> takes ${LOOP_METRICS.join("|")}, got '${e.metric}'`);
      continue;
    }
    if (!(METRIC_OPS as readonly string[]).includes(op)) {
      const hint = suggestName(op, [...METRIC_OPS, "loops"]);
      push(m, "error", e.loc, `expect: unknown metric '${op}:'${hint ? ` — did you mean '${hint}:'?` : ""} (${METRIC_OPS.join("|")}|loops)`);
      continue;
    }
    const shape = op === "at" ? (parts.length === 3 && Number.isFinite(Number(parts[1]))) : op === "rmse" ? parts.length === 3 : parts.length === 2;
    if (!shape) { push(m, "error", e.loc, `expect: metric '${e.metric}' is malformed — ${op === "at" ? "at:<time>:<series>" : op === "rmse" ? "rmse:<series>:<series>" : `${op}:<series>`}`); continue; }
    for (const series of op === "rmse" ? parts.slice(1) : [parts[parts.length - 1]!]) {
      const base = series.split(/[[.]/)[0]!;
      if (!seriesNames.includes(base)) {
        const hint = suggestName(base, seriesNames);
        push(m, "error", e.loc, `expect: no stock, flow or aux named '${base}'${hint ? ` — did you mean '${hint}'?` : ""}${m.varIndex.get(base)?.kind === "param" ? " (a param is not a series — expect reads outputs)" : ""}`);
      }
    }
  }
}

function validateScenarios(m: Raw): void {
  const settingKeys = new Set<string>(SETTING_KEYS);
  for (const sc of m.scenarios.values()) {
    const seen = new Set<string>();
    for (const { key, value } of sc.sets) {
      if (seen.has(key)) push(m, "warning", sc.loc, `scenario ${sc.name} sets '${key}' more than once — the last one wins`);
      seen.add(key);
      if (key === "method") {
        if (value !== "euler" && value !== "rk4" && value !== "map") push(m, "error", sc.loc, `scenario ${sc.name}: method must be euler, rk4 or map, got '${value}'`);
        continue;
      }
      if (settingKeys.has(key)) {
        if (!Number.isFinite(Number(value))) push(m, "error", sc.loc, `scenario ${sc.name}: ${key} must be a number, got '${value}'`);
        continue;
      }
      const decl = m.varIndex.get(key);
      const stock = decl ? undefined : m.stocks.find((s) => s.name === key);
      if (!decl && !stock) {
        const candidates = [...m.stocks.map((s) => s.name), ...m.vars.map((v) => v.name), ...SETTING_KEYS];
        const hint = suggestName(key, candidates);
        push(m, "error", sc.loc, `scenario ${sc.name}: no param, switch, stock, or sim setting named '${key}'${hint ? ` — did you mean '${hint}'?` : ""}`);
        continue;
      }
      if (decl?.boolean) {
        const w = SWITCH_WORDS[value.toLowerCase()];
        const n = w !== undefined ? w : Number(value);
        if (!(n === 0 || n === 1)) push(m, "error", sc.loc, `scenario ${sc.name}: switch '${key}' must be on or off, got '${value}'`);
        continue;
      }
      if (!Number.isFinite(Number(value))) push(m, "error", sc.loc, `scenario ${sc.name}: '${key}' must be a number, got '${value}'`);
      if (decl && decl.kind !== "param") push(m, "warning", sc.loc, `scenario ${sc.name} overrides ${decl.kind} '${key}' with a constant`);
    }
  }
}

/** Check subscript usage: valid index refs, sum of a subscripted symbol, and no
 *  bare reference to a vector outside sum(). Mirrors what scalarize.ts enforces,
 *  but at parse time so the editor flags it. */
function validateSubscripts(m: Raw): void {
  const dimsOf = new Map<string, string[]>();
  for (const s of m.stocks) if (s.dims) dimsOf.set(s.name, s.dims);
  for (const v of m.vars) if (v.dims) dimsOf.set(v.name, v.dims);
  // No early-out even when nothing is subscripted: a stray `X[i]` or a `sum(…)`
  // in a dimensionless model must still be flagged here (a clean, located error)
  // rather than slipping through to a line-less "unknown function" at codegen.

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
          if (s === di) {
            // Elementwise reference: the dimension must be in scope (the enclosing
            // declaration is subscripted over it), else there's no element to bind.
            if (!insideSum && !scope.has(di)) {
              push(m, "error", loc, `'${e.name}[${e.subs.join(", ")}]' uses dimension '${di}' but isn't in an elementwise context over it — index a single element or aggregate with sum()`);
            }
            return;
          }
          if (elems(di).includes(s)) return; // a literal element
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
          // The array arg may be written `Trade[from, to]`, but only as the plain
          // dimensions in order — a literal pin or reorder is silently dropped at
          // lowering, so reject it here instead of returning a wrong result.
          if (a!.kind === "index" && (a!.subs.length !== dims.length || a!.subs.some((s, i) => s !== dims[i]))) {
            push(m, "error", loc, `sum()'s argument '${base}[${a!.subs.join(", ")}]' can't pin or reorder dimensions — use sum(${base}) or sum(${base}, axis)`);
            break;
          }
          // Trailing args name the axes to collapse; each must be a distinct dim of `base`.
          const axes: string[] = [];
          let badAxis = false;
          for (const ax of e.args.slice(1)) {
            if (ax.kind !== "ident" || !dims.includes(ax.name)) {
              push(m, "error", loc, `sum()'s axis must be a dimension of '${base}' (one of ${dims.join(", ")})`);
              badAxis = true;
            } else if (axes.includes(ax.name)) {
              push(m, "error", loc, `sum() lists dimension '${ax.name}' more than once`);
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
