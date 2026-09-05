// ── Model lint ──────────────────────────────────────────────────────────────
// Non-fatal warnings the parser doesn't raise — the things that parse and run
// but are usually mistakes. Pure and DOM-free, so it rides along with `check`
// (CLI `lint`/`check`, MCP `flow_lint`/`flow_check`) and tightens the loop an
// agent lives in: write → check → fix. Most findings are severity "warning"
// (the model still runs); the exception is the call validation folded in from
// validate.ts, which is severity "error" — those calls won't run at all.

import type { Model, Diagnostic, Expr, Loc } from "../lang/index.js";
import { freeVars, declExprs } from "../lang/index.js";
import { operatingPoint } from "./loops.js";
import { compile } from "./compile.js";
import { simulate, type SimResult } from "./simulator.js";
import { paramRanges } from "./uncertainty.js";
import { checkUnits } from "./units.js";
import { validateModel } from "./validate.js";

/** Stateful builtins whose 2nd argument is a time constant τ that must be > 0. */
const TAU_BUILTINS = new Set(["smooth", "smoothi", "smooth3", "delay1", "delay3"]);

const warn = (loc: Loc, message: string): Diagnostic => ({ severity: "warning", loc, message });

/** Lint a parsed model. Returns warnings only — never throws on a valid model. */
export function lintModel(model: Model): Diagnostic[] {
  const out: Diagnostic[] = [];

  // Calls to functions that don't exist (or with the wrong argument count) parse
  // fine but won't run — surface them here as errors so `check` is trustworthy.
  out.push(...validateModel(model));

  // Every name referenced anywhere — by a var, a rate, a stock init, or `plot`.
  const referenced = new Set<string>();
  const collect = (e: Expr) => {
    for (const id of freeVars(e)) referenced.add(id);
  };
  for (const v of model.vars) for (const e of declExprs(v.expr, v.elemExprs)) collect(e);
  for (const r of model.rates.values()) collect(r.expr);
  for (const s of model.stocks) for (const e of declExprs(s.initExpr, s.elemExprs)) collect(e);
  for (const name of model.plot) referenced.add(name);

  // Dead knobs and dead computations.
  for (const v of model.vars) {
    if (referenced.has(v.name)) continue;
    if (v.kind === "param") out.push(warn(v.loc, `param '${v.name}' is never used`));
    else out.push(warn(v.loc, `${v.kind} '${v.name}' is computed but never used (not referenced and not plotted)`));
  }

  // A stock with no change() rate can never change — almost always an oversight,
  // except in a causal-loop sketch where stocks are drawn, not yet integrated.
  const sketch = model.links.length > 0 && model.rates.size === 0;
  for (const s of model.stocks) {
    if (!model.rates.has(s.name) && !sketch) out.push(warn(s.loc, `stock '${s.name}' has no change(${s.name}) rate — it never changes`));
  }
  // A link between two equation-level names is redundant with the equation
  // (the sign is read from it) unless the equation doesn't mention the source.
  for (const l of model.links) {
    const target = model.varIndex.get(l.to) ?? model.rates.get(l.to);
    if (target && freeVars(target.expr).has(l.from)) out.push(warn(l.loc, `link ${l.from} -> ${l.to} is also an equation dependency — the declared sign overrides the one read from the equation`));
  }

  checkTimeConstants(model, out);
  checkDiscreteTime(model, out);
  checkCircularInit(model, out);
  checkStockFloor(model, out);
  checkDeclaredRanges(model, out);
  checkUnits(model, out);
  return out;
}

/** Runs the lint would rather not pay for: past this, the floor check is skipped
 *  rather than making `lint` cost a full simulation of a very large model. */
const FLOOR_CHECK_BUDGET = 2_000_000;

/**
 * Report where a `>= 0` stock actually hit its floor.
 *
 * The declaration is what makes this checkable at all: flowloom cannot guess
 * that Cash may go negative (debt) while Inventory may not, so the floor is
 * opt-in and this check follows it. When the floor engages it is doing its job —
 * but it does that job by *truncating an outflow*, so from that moment the
 * model's mass balance no longer holds: less left the stock than the rate
 * asked for, and whatever was supposed to receive it received more than
 * existed. That is worth a line, with the time it first bit.
 *
 * Nothing warns about an undeclared stock going negative. It would fire on
 * every runway, budget and net-worth model, where crossing zero is the answer
 * rather than a bug — `>= 0` (or an `expect min:X >= 0` line) is how you say
 * which kind of stock you have.
 */
function checkStockFloor(model: Model, out: Diagnostic[]): void {
  const floored = model.stocks.filter((s) => s.nonNegative);
  if (!floored.length) return;
  const { dt, to, start } = model.settings;
  const steps = Math.max(1, Math.round((to - start) / dt));
  // Cost the run the way it will actually be run: a subscripted stock becomes
  // one state per element, so 3 stocks over a 50-element dim is 150 states, not
  // 3. Getting this wrong lets a run 50× over budget execute inside a lint that
  // `check`, `lint`, `flow_check` and `flow_lint` all call.
  const states = model.stocks.reduce((n, s) => n + (s.dims?.reduce((k, d) => k * (model.dims.get(d)?.elements.length ?? 1), 1) ?? 1), 0);
  if (states * steps > FLOOR_CHECK_BUDGET) return;

  let res: SimResult;
  try {
    res = simulate(model);
  } catch {
    return; // a model that won't run has louder problems than this
  }
  if (!res.clamped?.length) return;
  const hit = new Set(res.clamped);

  for (const decl of floored) {
    // A subscripted stock is scalarized on the way into the run, so one
    // declaration can stand behind many series.
    const names = [...hit].filter((n) => n === decl.name || n.startsWith(`${decl.name}.`));
    if (!names.length) continue;
    const ys = res.series.get(names[0]!);
    const at = ys ? ys.findIndex((y) => y === 0) : -1;
    const when = at > 0 && res.t[at] !== undefined ? ` from t=${fmtNum(res.t[at]!)}` : "";
    out.push(
      warn(
        decl.loc,
        `stock '${decl.name}' hits its \`>= 0\` floor${when}${names.length > 1 ? ` (${names.length} elements)` : ""} — the floor holds it at zero by truncating the outflow, so past that point less leaves the stock than change(${decl.name}) asks for and whatever it feeds receives more than existed. Gate the outflow on what is left (e.g. min(demand, ${decl.name} / dt)) if the downstream stock must balance`,
      ),
    );
  }
}

/** A param whose own value sits outside the range it declares. Nothing else
 *  would catch it: the model runs, and the range is only consulted by Monte
 *  Carlo, global sensitivity and calibration — each of which would quietly move
 *  the knob to somewhere the base run never visits. */
function checkDeclaredRanges(model: Model, out: Diagnostic[]): void {
  const ranges = paramRanges(model);
  if (!ranges.size) return;
  for (const v of model.vars) {
    const r = ranges.get(v.name);
    if (!r) continue;
    if (r.base < r.lo || r.base > r.hi) {
      out.push(warn(v.loc, `param '${v.name}' is ${fmtNum(r.base)} but declares the range ${fmtNum(r.lo)}..${fmtNum(r.hi)} — the value sits outside its own bounds, so Monte Carlo, global sensitivity and calibrate would all move it somewhere the base run never goes`));
    }
  }
}

/** Compact number for a diagnostic: no exponent soup, no 15-digit float dust. */
function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-4) return v.toExponential(2);
  return String(Math.round(v * 1e4) / 1e4);
}

/**
 * A previous()/delay_fixed() with no init value starts at its input's initial
 * value. If that input (instantaneously) depends on the delay's own output —
 * `a = previous(b) + 1`, `b = a * 2` — the initial state is circular and the
 * run's first value is garbage. The engine notes it at run time; this says it
 * at check time, with the line.
 */
function checkCircularInit(model: Model, out: Diagnostic[]): void {
  let c: ReturnType<typeof compile>;
  try { c = compile(model); } catch { return; }
  if (!c.fixed.length) return;
  // Instantaneous dependency graph over compiled vars + fixed outputs, where a
  // fixed output with a *default* init depends on its input (through the init).
  const deps = new Map<string, Set<string>>();
  for (const v of c.order) deps.set(v.name, freeVars(v.expr));
  for (const f of c.fixed) deps.set(f.name, f.initExpr.kind === "ident" && f.initExpr.name === f.inputVar ? freeVars(f.inputExpr) : new Set());
  const reaches = (from: string, target: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const n = stack.pop()!;
      if (n === target) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const d of deps.get(n) ?? []) stack.push(d);
    }
    return false;
  };
  // Report at the line that holds the call: the var/rate/stock whose *source*
  // expression mentions previous/delay_fixed and whose compiled form references
  // this fixed output.
  const locOf = (fixedName: string): Loc | undefined => {
    const uses = (e: Expr): boolean => freeVars(e).has(fixedName);
    const src = (name: string) => model.varIndex.get(name)?.loc ?? model.stocks.find((s) => s.name === name)?.loc;
    for (const v of c.order) if (!v.isInternal && uses(v.expr)) return src(v.name);
    for (const s of c.state) if (!s.isInternal && ((s.rateExpr && uses(s.rateExpr)) || uses(s.initExpr))) return model.rates.get(s.name)?.loc ?? src(s.name);
    return undefined;
  };
  for (const f of c.fixed) {
    if (!(f.initExpr.kind === "ident" && f.initExpr.name === f.inputVar)) continue; // explicit init — fine
    for (const d of deps.get(f.name)!) {
      if (reaches(d, f.name)) {
        const fn = f.name.startsWith("prev") ? "previous" : "delay_fixed";
        out.push(warn(locOf(f.name) ?? { line: 1, col: 0 }, `${fn}(…) has no init value and its input depends on its own output — the initial state is circular; give it an explicit init, e.g. ${fn}(X, …, 0)`));
        break;
      }
    }
  }
}

/**
 * Discrete-period models — a monthly budget, a yearly census — are written as
 * maps on the time grid: `t % 12 == 0`, `previous(X)`, `delay_fixed(X, 2)`. Two
 * things silently go wrong with them under the defaults, so say so:
 *   • RK4 evaluates the derivative between grid points (t + dt/2), where a
 *     `t % n == k` test is false and a `t == k` test never fires — the model
 *     runs, with the wrong dynamics. `method=map` is the honest stepper for a
 *     difference equation: state(t+dt) = state(t) + change(t).
 *   • under method=map a change() that still divides by dt is the Euler-era
 *     idiom for "this is a per-step amount" — now a double conversion.
 *   • a fixed delay shorter than one step rounds up to one step.
 */
function checkDiscreteTime(model: Model, out: Diagnostic[]): void {
  const { method, dt } = model.settings;
  const gridTests: Loc[] = [];
  let scope: Record<string, number> | undefined;
  const resolve = () => (scope ??= (() => { try { return operatingPoint(model); } catch { return {}; } })());
  const constValue = (e: Expr): number | undefined =>
    e.kind === "num" ? e.value : e.kind === "ident" ? resolve()[e.name] : undefined;
  const isClock = (e: Expr) => e.kind === "ident" && (e.name === "t" || e.name === "time");
  const isDt = (e: Expr) => e.kind === "ident" && e.name === "dt";
  const dtDivisions: Loc[] = [];

  const visit = (e: Expr, loc: Loc, inRate = false): void => {
    switch (e.kind) {
      case "binary":
        // `t % n`, `t == k`, `t != k`: only meaningful on the grid
        if ((e.op === "%" || e.op === "==" || e.op === "!=") && (isClock(e.left) || isClock(e.right))) gridTests.push(loc);
        // `… / dt` inside a change() under method=map: the per-step amount is
        // already what the stepper adds, so the division converts it twice.
        if (inRate && e.op === "/" && isDt(e.right)) dtDivisions.push(loc);
        visit(e.left, loc, inRate);
        visit(e.right, loc, inRate);
        break;
      case "unary":
        visit(e.arg, loc, inRate);
        break;
      case "call": {
        if (e.name.toLowerCase() === "delay_fixed" && e.args[1]) {
          const len = constValue(e.args[1]);
          if (len !== undefined && Number.isFinite(len)) {
            if (len <= 0) out.push(warn(loc, `delay_fixed(…) length is ${len} — a fixed delay must be at least one step (dt=${dt}); it will be rounded up to one`));
            else if (len < dt) out.push(warn(loc, `delay_fixed(…) length ${len} is shorter than one step (dt=${dt}) — it will be rounded up to one step`));
            else if (Math.abs(len / dt - Math.round(len / dt)) > 1e-9) out.push(warn(loc, `delay_fixed(…) length ${len} is not a whole number of steps (dt=${dt}) — it will be rounded to ${Math.max(1, Math.round(len / dt))} step(s)`));
          }
        }
        for (const a of e.args) visit(a, loc, inRate);
        break;
      }
    }
  };
  for (const v of model.vars) for (const e of declExprs(v.expr, v.elemExprs)) visit(e, v.loc);
  for (const r of model.rates.values()) visit(r.expr, r.loc, method === "map");
  for (const s of model.stocks) for (const e of declExprs(s.initExpr, s.elemExprs)) visit(e, s.loc);

  if (method === "rk4" && gridTests.length) {
    const first = gridTests[0]!;
    out.push(warn(first, `this model tests the clock on the time grid (t % n, t == k) but runs under rk4, which also samples between steps (t + dt/2) where those tests are false — for a discrete-period model use \`sim method=map\` (stock(t+dt) = stock(t) + change(t))${gridTests.length > 1 ? ` (${gridTests.length} places)` : ""}`));
  }
  if (method === "map" && dtDivisions.length) {
    const first = dtDivisions[0]!;
    out.push(warn(first, `under method=map change() is already a per-step increment — dividing it by dt converts twice; drop the \`/ dt\`${dtDivisions.length > 1 ? ` (${dtDivisions.length} places)` : ""}`));
  }
}

/** Flag smooth/delay calls whose time constant resolves to a non-positive value. */
function checkTimeConstants(model: Model, out: Diagnostic[]): void {
  // Resolve identifier time constants against the t=start operating point, lazily
  // (and defensively — a malformed model shouldn't break the lint pass).
  let scope: Record<string, number> | undefined;
  const resolve = (): Record<string, number> => {
    if (!scope) {
      try {
        scope = operatingPoint(model);
      } catch {
        scope = {};
      }
    }
    return scope;
  };

  // Fold a τ expression to a number when it's a literal, a negated literal, or a
  // name that resolves at the operating point. Anything dynamic is left alone.
  const constValue = (e: Expr): number | undefined => {
    if (e.kind === "num") return e.value;
    if (e.kind === "unary") {
      const a = constValue(e.arg);
      return a === undefined ? undefined : e.op === "-" ? -a : a;
    }
    if (e.kind === "ident") return resolve()[e.name];
    return undefined;
  };

  const visit = (e: Expr, loc: Loc): void => {
    switch (e.kind) {
      case "call": {
        if (TAU_BUILTINS.has(e.name.toLowerCase()) && e.args[1]) {
          const value = constValue(e.args[1]);
          if (value !== undefined && Number.isFinite(value) && value <= 0) {
            out.push(warn(loc, `${e.name}(…) has a non-positive time constant (${value}) — τ should be > 0`));
          }
        }
        for (const a of e.args) visit(a, loc);
        break;
      }
      case "binary":
        visit(e.left, loc);
        visit(e.right, loc);
        break;
      case "unary":
        visit(e.arg, loc);
        break;
    }
  };

  for (const v of model.vars) visit(v.expr, v.loc);
  for (const r of model.rates.values()) visit(r.expr, r.loc);
  for (const s of model.stocks) visit(s.initExpr, s.loc);
}
