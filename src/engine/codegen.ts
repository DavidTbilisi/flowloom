import type { Expr } from "../lang/types.js";
import type { Compiled } from "./compile.js";
import { lookupTable } from "./builtins.js";
import { runif, rnorm, RANDOM_FNS, drawSlots } from "./rng.js";

// ── Compiled evaluation plan (shared by the TS and WASM backends) ───────────
// The tree-walking interpreter (eval.ts) re-reads a string-keyed scope object on
// every node and re-allocates that object on every derivative call. For large
// models that overhead dominates. Instead we lay every name out at a fixed
// integer slot in one reused Float64Array and compile each expression *once* —
// the TS backend into closures, the WASM backend into bytecode (see wasm/). Both
// read and write the same slot layout, so they produce identical numbers.
//
// eval.ts is retained: the loop analyzer perturbs expressions symbolically and
// still uses it. This module is only the simulation hot path.

export interface SimPlan {
  /** Number of f64 slots in the scope vector (t, time, seed, step, state, vars). */
  size: number;
  tSlot: number;
  timeSlot: number;
  /** Scope slot holding the step size (written once by runPlan), so `dt` is usable in expressions. */
  dtSlot: number;
  /** Scope slot holding the run's RNG seed (written once by runPlan). */
  seedSlot: number;
  /** Scope slot holding the current integer step index (written each step). */
  stepSlot: number;
  /** Draw index assigned to each random*() call node (random_normal uses k & k+1). */
  drawIndex: Map<Expr, number>;
  /** Scope slot of each integration state var, in `Compiled.state` order. */
  stateSlots: number[];
  /** How many leading entries of `stateSlots` are user stocks (the rest are the
   *  internal states of smooth/delay1/delay3). Under `method=map` the user
   *  stocks step by their change() as a per-step increment, while the internal
   *  states keep integrating with dt so their time constants stay in time units. */
  userStates: number;
  /** Sample-and-hold delays (previous / delay_fixed), in `Compiled.fixed` order:
   *  the output slot the backends read, the slot of the internal aux that samples
   *  the input, and the length/init expressions (evaluated in TS at t=start). */
  fixedSlots: { out: number; in: number; delayExpr: Expr | null; initExpr: Expr }[];
  /** Variables to evaluate each step, in topological order, with their slot. */
  varSteps: { slot: number; expr: Expr }[];
  /** Rate expression per state var (null ⇒ constant stock). */
  rateExprs: (Expr | null)[];
  /** Initial-value expression per state var. */
  initExprs: Expr[];
  /** Output series names and the scope slot to read each from. */
  outNames: string[];
  outSlots: number[];
  /** Indices into `stateSlots` of the stocks declared `>= 0`. The integrator
   *  holds these at zero after each step; every backend shares runIntegration,
   *  so the floor cannot drift between TS and WASM. */
  flooredStates: number[];
  /** Names of the user stocks (subset of outNames, first). */
  stockNames: string[];
  varNames: string[];
  compiled: Compiled;
}

/** Assign slots and gather the ordered evaluation steps for a compiled model. */
export function buildPlan(c: Compiled): SimPlan {
  const slotOf = new Map<string, number>();
  const slot = (n: string): number => {
    let s = slotOf.get(n);
    if (s === undefined) { s = slotOf.size; slotOf.set(n, s); }
    return s;
  };
  const tSlot = slot("t");
  const timeSlot = slot("time");
  const dtSlot = slot("dt");
  // Reserved slots for the RNG. The `#` names can't collide with user identifiers
  // (same trick as compile.ts's delay#N internal stocks).
  const seedSlot = slot("#seed");
  const stepSlot = slot("#step");
  const stateSlots = c.state.map((s) => slot(s.name));
  // Fixed-delay outputs get their slots before the vars so a sampler (which is a
  // var) can reference another delay's output by name.
  const fixedOut = c.fixed.map((f) => slot(f.name));
  const varSteps = c.order.map((v) => ({ slot: slot(v.name), expr: v.expr }));
  const fixedSlots = c.fixed.map((f, i) => ({ out: fixedOut[i]!, in: slotOf.get(f.inputVar)!, delayExpr: f.delayExpr, initExpr: f.initExpr }));

  // Assign each random*() call node a stable draw index in a single AST walk, so
  // every backend reads the same map keyed on node identity (no per-backend drift).
  const drawIndex = new Map<Expr, number>();
  let nextDraw = 0;
  const scanDraws = (e: Expr): void => {
    switch (e.kind) {
      case "call":
        if (RANDOM_FNS.has(e.name.toLowerCase()) && !drawIndex.has(e)) {
          drawIndex.set(e, nextDraw);
          nextDraw += drawSlots(e.name.toLowerCase());
        }
        for (const a of e.args) scanDraws(a);
        break;
      case "binary":
        scanDraws(e.left);
        scanDraws(e.right);
        break;
      case "unary":
        scanDraws(e.arg);
        break;
    }
  };
  for (const v of c.order) scanDraws(v.expr);
  for (const s of c.state) {
    if (s.rateExpr) scanDraws(s.rateExpr);
    scanDraws(s.initExpr);
  }
  for (const f of c.fixed) { if (f.delayExpr) scanDraws(f.delayExpr); scanDraws(f.initExpr); }

  const outVars = c.order.filter((v) => v.kind !== "param" && !v.isInternal);
  const stockNames = c.userStocks.slice();
  const varNames = outVars.map((v) => v.name);
  const outNames = [...stockNames, ...varNames];
  const outSlots = outNames.map((n) => slotOf.get(n)!);

  return {
    size: slotOf.size,
    tSlot,
    timeSlot,
    dtSlot,
    seedSlot,
    stepSlot,
    drawIndex,
    stateSlots,
    userStates: c.userStocks.length,
    fixedSlots,
    varSteps,
    rateExprs: c.state.map((s) => s.rateExpr),
    initExprs: c.state.map((s) => s.initExpr),
    outNames,
    outSlots,
    flooredStates: c.state.flatMap((st, j) => (st.nonNegative ? [j] : [])),
    stockNames,
    varNames,
    compiled: c,
  };
}

// ── TS backend: compile each expression to a closure over the slot vector ────
// Semantics mirror eval.ts exactly (including IF short-circuiting and the
// builtin definitions in builtins.ts) so the contract tests hold unchanged.

type Fn = (m: Float64Array) => number;
const PI = Math.PI;
const E = Math.E;

function makeSlotMap(plan: SimPlan): Map<string, number> {
  const m = new Map<string, number>();
  m.set("t", plan.tSlot);
  m.set("time", plan.timeSlot);
  m.set("dt", plan.dtSlot);
  plan.compiled.state.forEach((s, i) => m.set(s.name, plan.stateSlots[i]!));
  plan.compiled.fixed.forEach((f, i) => m.set(f.name, plan.fixedSlots[i]!.out));
  plan.compiled.order.forEach((v, i) => m.set(v.name, plan.varSteps[i]!.slot));
  return m;
}

function compileWith(e: Expr, slots: Map<string, number>, plan: SimPlan): Fn {
  const tSlot = plan.tSlot;
  switch (e.kind) {
    case "num": {
      const v = e.value;
      return () => v;
    }
    case "ident": {
      const i = slots.get(e.name);
      if (i !== undefined) return (m) => m[i]!;
      if (e.name === "PI") return () => PI;
      if (e.name === "E") return () => E;
      throw new Error(`unknown name '${e.name}'`);
    }
    case "unary": {
      const a = compileWith(e.arg, slots, plan);
      if (e.op === "-") return (m) => -a(m);
      if (e.op === "!") return (m) => (a(m) === 0 ? 1 : 0);
      return a;
    }
    case "binary": {
      const l = compileWith(e.left, slots, plan);
      const r = compileWith(e.right, slots, plan);
      switch (e.op) {
        case "+": return (m) => l(m) + r(m);
        case "-": return (m) => l(m) - r(m);
        case "*": return (m) => l(m) * r(m);
        case "/": return (m) => l(m) / r(m);
        case "%": return (m) => l(m) % r(m);
        case "^": return (m) => Math.pow(l(m), r(m));
        case "<": return (m) => (l(m) < r(m) ? 1 : 0);
        case ">": return (m) => (l(m) > r(m) ? 1 : 0);
        case "<=": return (m) => (l(m) <= r(m) ? 1 : 0);
        case ">=": return (m) => (l(m) >= r(m) ? 1 : 0);
        case "==": return (m) => (l(m) === r(m) ? 1 : 0);
        case "!=": return (m) => (l(m) !== r(m) ? 1 : 0);
        case "&&": return (m) => (l(m) !== 0 && r(m) !== 0 ? 1 : 0);
        case "||": return (m) => (l(m) !== 0 || r(m) !== 0 ? 1 : 0);
      }
      throw new Error("bad operator");
    }
    case "call": {
      const table = plan.compiled.tables.get(e.name);
      if (table) {
        const x = compileWith(e.args[0]!, slots, plan);
        const pts = table.points;
        const hold = table.hold === true;
        return (m) => lookupTable(pts, x(m), hold);
      }
      const name = e.name.toLowerCase();
      if (RANDOM_FNS.has(name)) return compileRandom(name, e, slots, plan);
      const A = e.args.map((a) => compileWith(a, slots, plan));
      return builtinClosure(name, A, tSlot, e.name);
    }
  }
  throw new Error("malformed expression");
}

/** random*() reads seed/step from reserved slots and a compile-time draw index. */
function compileRandom(name: string, e: Expr & { kind: "call" }, slots: Map<string, number>, plan: SimPlan): Fn {
  const k = plan.drawIndex.get(e)!;
  const ss = plan.seedSlot, ps = plan.stepSlot;
  if (name === "random") return (m) => runif(m[ss]!, m[ps]!, k, 0, 1);
  const lo = compileWith(e.args[0]!, slots, plan);
  const hi = compileWith(e.args[1]!, slots, plan);
  if (name === "random_uniform") return (m) => runif(m[ss]!, m[ps]!, k, lo(m), hi(m));
  return (m) => rnorm(m[ss]!, m[ps]!, k, lo(m), hi(m));
}

/** Closures that replicate builtins.ts exactly, without per-call allocation. */
function builtinClosure(name: string, A: Fn[], tSlot: number, orig: string): Fn {
  const a0 = A[0]!, a1 = A[1]!, a2 = A[2]!;
  switch (name) {
    case "min": return specializeVariadic("min", A) ?? ((m) => Math.min(...A.map((f) => f(m))));
    case "max": return specializeVariadic("max", A) ?? ((m) => Math.max(...A.map((f) => f(m))));
    case "abs": return (m) => Math.abs(a0(m));
    case "exp": return (m) => Math.exp(a0(m));
    case "ln": return (m) => Math.log(a0(m));
    case "log": return (m) => Math.log(a0(m));
    case "log10": return (m) => Math.log10(a0(m));
    case "sqrt": return (m) => Math.sqrt(a0(m));
    case "pow": return (m) => Math.pow(a0(m), a1(m));
    case "sin": return (m) => Math.sin(a0(m));
    case "cos": return (m) => Math.cos(a0(m));
    case "tan": return (m) => Math.tan(a0(m));
    case "floor": return (m) => Math.floor(a0(m));
    case "ceil": return (m) => Math.ceil(a0(m));
    case "round": return (m) => Math.round(a0(m));
    case "sign": return (m) => Math.sign(a0(m));
    case "if": return (m) => (a0(m) ? a1(m) : a2(m));
    case "clamp": return (m) => Math.max(a1(m), Math.min(a2(m), a0(m)));
    case "step": return (m) => (m[tSlot]! >= a1(m) ? a0(m) : 0);
    case "pulse": return (m) => {
      const t = m[tSlot]!, t0 = a0(m), width = A.length > 1 ? a1(m) : 0;
      if (width <= 0) return t === t0 ? 1 : 0;
      return t >= t0 && t < t0 + width ? 1 : 0;
    };
    case "ramp": return (m) => {
      const t = m[tSlot]!, slope = a0(m), t0 = a1(m), t1 = A.length > 2 ? a2(m) : Infinity;
      if (t <= t0) return 0;
      return slope * (Math.min(t, t1) - t0);
    };
  }
  throw new Error(`unknown function '${orig}'`);
}

// ── Min specialization for fixed arity (avoid the spread allocation) ─────────
// min/max with 1–3 args are the common case; specialize them.
function specializeVariadic(name: "min" | "max", A: Fn[]): Fn | null {
  if (A.length === 1) { const a = A[0]!; return (m) => a(m); }
  if (A.length === 2) {
    const a = A[0]!, b = A[1]!;
    return name === "min" ? (m) => Math.min(a(m), b(m)) : (m) => Math.max(a(m), b(m));
  }
  return null;
}

// ── The integrator (shared) ──────────────────────────────────────────────────
// Given a derivative callback that fills `rates` from the scope vector `mem`,
// integrate with Euler or RK4. Backend-agnostic: the TS path passes closures,
// the WASM path passes a function that calls the exported module.

export interface DerivBackend {
  /** scope vector (length = plan.size); shared with the backend. */
  mem: Float64Array;
  /** rates output (length = plan.stateSlots.length); shared with the backend. */
  rates: Float64Array;
  /** Write vars into mem and rates from mem at time t. */
  deriv(t: number): void;
}

export interface RunResult {
  t: number[];
  series: Map<string, number[]>;
  note?: string;
  /** Stocks declared `>= 0` whose floor actually engaged during the run — the
   *  outflow was truncated there, so what left the stock is less than what the
   *  rate asked for. Lint reports it; the modeller should know. */
  clamped?: string[];
}

export function runIntegration(
  plan: SimPlan,
  backend: DerivBackend,
  settings: { dt: number; to: number; start: number; method: "euler" | "rk4" | "map" },
  /** Called after each step's first derivative evaluation, with the full scope
   *  vector (every state, var and internal slot at that instant). Used by the
   *  loop analyzer to read link signs along the actual trajectory. */
  onStep?: (i: number, time: number, mem: Float64Array) => void,
): RunResult {
  const { dt, to, start, method } = settings;
  const steps = Math.max(1, Math.round((to - start) / dt));
  const { mem, rates } = backend;
  const ns = plan.stateSlots.length;

  const series = new Map<string, number[]>(plan.outNames.map((n) => [n, []]));
  const cols = plan.outNames.map((n) => series.get(n)!);
  const t: number[] = [];
  let note: string | undefined;

  const k1 = new Float64Array(ns), k2 = new Float64Array(ns), k3 = new Float64Array(ns), k4 = new Float64Array(ns);
  const base = new Float64Array(ns);

  const setState = (j: number, v: number) => { mem[plan.stateSlots[j]!] = v; };
  const getState = (j: number) => mem[plan.stateSlots[j]!]!;

  // Stocks declared `>= 0` are physical quantities: an outflow cannot drain them
  // past empty. We hold the *integrated* value at the floor after each completed
  // step, which is what Vensim and Stella do — not a constrained integration.
  // The difference matters and is not hidden: when the floor engages, less left
  // the stock than the rate asked for, so mass is not conserved across that
  // step. `clamped` records it and lint says so. RK4's sub-stages are left
  // alone; clamping mid-stage would corrupt the weighted average rather than
  // bound it.
  const floors = plan.flooredStates;
  const clampedAt = new Set<string>();
  const applyFloors = () => {
    for (const j of floors) {
      if (getState(j) < 0) { setState(j, 0); clampedAt.add(plan.stockNames[j] ?? `state#${j}`); }
    }
  };

  // Fixed delays: one ring buffer per call site, `m` steps long. Before step i
  // the output slot is set to the input sampled at step i−m (or the init value
  // while i < m); after the step's first derivative evaluation the fresh input is
  // recorded. The output is held constant across RK4's sub-stages — it is a
  // sampled quantity on the time grid, not a continuous one (Vensim's DELAY
  // FIXED has the same semantics). Lengths are read once, at t=start.
  const fixed = fixedBuffers(plan, mem, dt);

  // An initial value below the declared floor is clamped too, and recorded —
  // otherwise t=start would report a value the stock is not allowed to hold.
  if (floors.length) applyFloors();

  for (let i = 0; i <= steps; i++) {
    const time = start + i * dt;
    // random() is resampled once per step and held across the four RK4 sub-stages,
    // which all read this same slot — so the integrated vector field is well-defined.
    mem[plan.stepSlot] = i;
    for (const f of fixed) mem[f.out] = i >= f.m ? f.buf[i % f.m]! : f.init;
    backend.deriv(time);
    for (const f of fixed) f.buf[i % f.m] = mem[f.in]!;
    for (let j = 0; j < ns; j++) k1[j] = rates[j]!;
    if (onStep) onStep(i, time, mem);

    t.push(time);
    for (let o = 0; o < plan.outSlots.length; o++) cols[o]!.push(mem[plan.outSlots[o]!]!);

    let bad = false;
    for (let j = 0; j < ns; j++) if (!Number.isFinite(getState(j))) { bad = true; break; }
    if (bad) {
      note = `stopped at t=${time.toFixed(3)} — a stock went non-finite (try a smaller dt or check the model).`;
      break;
    }
    if (i === steps) break;

    if (method === "euler") {
      for (let j = 0; j < ns; j++) setState(j, getState(j) + dt * k1[j]!);
    } else if (method === "map") {
      // A difference equation: stock(t+dt) = stock(t) + change(t), the change
      // being a per-step increment in the stock's own units (no × dt). The
      // internal smooth/delay states are still rates per time unit — their time
      // constants are written in time units — so they take the Euler step.
      for (let j = 0; j < plan.userStates; j++) setState(j, getState(j) + k1[j]!);
      for (let j = plan.userStates; j < ns; j++) setState(j, getState(j) + dt * k1[j]!);
    } else {
      for (let j = 0; j < ns; j++) base[j] = getState(j);
      const stage = (kIn: Float64Array, h: number, tt: number, kOut: Float64Array) => {
        for (let j = 0; j < ns; j++) setState(j, base[j]! + h * kIn[j]!);
        backend.deriv(tt);
        for (let j = 0; j < ns; j++) kOut[j] = rates[j]!;
      };
      stage(k1, dt / 2, time + dt / 2, k2);
      stage(k2, dt / 2, time + dt / 2, k3);
      stage(k3, dt, time + dt, k4);
      for (let j = 0; j < ns; j++)
        setState(j, base[j]! + (dt / 6) * (k1[j]! + 2 * k2[j]! + 2 * k3[j]! + k4[j]!));
    }
    if (floors.length) applyFloors();
  }

  return { t, series, note, ...(clampedAt.size ? { clamped: [...clampedAt] } : {}) };
}

interface FixedBuffer { out: number; in: number; m: number; init: number; buf: Float64Array }

/** Allocate the ring buffers for a run. Must be called after initStateInto so the
 *  init values (already in `mem`) and delay lengths (params) are resolved. A
 *  length shorter than one step rounds up to one: a fixed delay exists to break
 *  an instantaneous dependency, so it can never be zero (lint warns). */
function fixedBuffers(plan: SimPlan, mem: Float64Array, dt: number): FixedBuffer[] {
  if (!plan.fixedSlots.length) return [];
  const slots = makeSlotMap(plan);
  return plan.fixedSlots.map((f) => {
    const len = f.delayExpr ? compileWith(f.delayExpr, slots, plan)(mem) : dt;
    const m = Math.max(1, Math.round(Number.isFinite(len) ? len / dt : 1));
    return { out: f.out, in: f.in, m, init: mem[f.out]!, buf: new Float64Array(m) };
  });
}

// ── Initialization (shared) ──────────────────────────────────────────────────
// Stocks and variables can be mutually dependent at t=start only through delay
// boundaries, which form a DAG. Seed everything to 0 and relax to the fixed
// point. Runs in TS for both backends (it's one-time, not the hot path) and
// writes directly into the provided scope vector — which, for the WASM backend,
// is a view over the module's linear memory.
export function initStateInto(plan: SimPlan, mem: Float64Array, start: number): boolean {
  const slots = makeSlotMap(plan);
  const varFns = plan.varSteps.map((v) => ({ slot: v.slot, f: compileWith(v.expr, slots, plan) }));
  const initFns = plan.initExprs.map((e) => compileWith(e, slots, plan));
  const fixedInitFns = plan.fixedSlots.map((f) => ({ slot: f.out, f: compileWith(f.initExpr, slots, plan) }));
  mem[plan.tSlot] = start; mem[plan.timeSlot] = start;
  // Fixed-point relaxation. Variables are topologically ordered, so a single
  // pass resolves everything except mutual dependencies through delay boundaries,
  // which converge in a couple more passes. Iterate until stable rather than for
  // a fixed O(N) count — that keeps init ~O(N), not O(N²), on large models.
  const maxPasses = plan.stateSlots.length + varFns.length + fixedInitFns.length + 2; // safety bound
  const ns = plan.stateSlots.length;
  for (let p = 0; p < maxPasses; p++) {
    let changed = 0;
    for (const v of varFns) {
      const nv = v.f(mem);
      if (nv !== mem[v.slot]!) { mem[v.slot] = nv; changed++; }
    }
    for (let j = 0; j < ns; j++) {
      const nv = initFns[j]!(mem);
      if (nv !== mem[plan.stateSlots[j]!]!) { mem[plan.stateSlots[j]!] = nv; changed++; }
    }
    for (const f of fixedInitFns) {
      const nv = f.f(mem);
      if (nv !== mem[f.slot]!) { mem[f.slot] = nv; changed++; }
    }
    if (changed === 0) return true;
  }
  // Never settled: the initial state is circular. Only a previous()/delay_fixed()
  // whose default init reads its own downstream can do this (stocks' inits can't
  // reference vars that depend on them — that's an algebraic loop at parse).
  return false;
}

// ── TS derivative backend ─────────────────────────────────────────────────────
export function tsBackend(plan: SimPlan): DerivBackend {
  const slots = makeSlotMap(plan);
  const mem = new Float64Array(plan.size);
  const rates = new Float64Array(plan.stateSlots.length);

  const varFns = plan.varSteps.map((v) => ({ slot: v.slot, f: compileWith(v.expr, slots, plan) }));
  const rateFns = plan.rateExprs.map((e) => (e ? compileWith(e, slots, plan) : () => 0));

  return {
    mem,
    rates,
    deriv(t: number) {
      mem[plan.tSlot] = t; mem[plan.timeSlot] = t;
      for (const v of varFns) mem[v.slot] = v.f(mem);
      for (let j = 0; j < rateFns.length; j++) rates[j] = rateFns[j]!(mem);
    },
  };
}

export type { Fn };
export { makeSlotMap, compileWith, specializeVariadic };
