import type { Model } from "../lang/types.js";
import { evalExpr, type EvalCtx } from "./eval.js";
import { compile, type Compiled, type StateVar, type CompiledVar } from "./compile.js";

// ── The integrator ──────────────────────────────────────────────────────────
// The whole simulation is one rule applied over and over:
//     state(t+dt) = state(t) + dt · d(state)/dt
// You write the derivatives (`d(NAME) = …`); flowloom integrates them with
// Euler or classical RK4. Aux/flow variables are recomputed from state every
// time the derivative is sampled (including RK4's intermediate stages).

export interface SimResult {
  t: number[];
  series: Map<string, number[]>;
  /** Output series order: user stocks, then flow/aux variables. */
  names: string[];
  stockNames: string[];
  varNames: string[];
  dt: number;
  method: "euler" | "rk4";
  /** Set if the run halted early (e.g. a stock went non-finite). */
  note?: string;
}

type StateVec = Record<string, number>;

export function simulate(model: Model): SimResult {
  const c = compile(model);
  const { dt, to, start, method } = model.settings;
  const steps = Math.max(1, Math.round((to - start) / dt));

  const outVars = c.order.filter((v) => v.kind !== "param");
  const names = [...c.userStocks, ...outVars.map((v) => v.name)];

  const result: SimResult = {
    t: [],
    series: new Map(names.map((n) => [n, []])),
    names,
    stockNames: c.userStocks,
    varNames: outVars.map((v) => v.name),
    dt,
    method,
  };

  const state = initialState(c, start);

  for (let i = 0; i <= steps; i++) {
    const t = start + i * dt;
    const { rates, scope } = deriv(c, state, t);

    result.t.push(t);
    for (const n of names) result.series.get(n)!.push(scope[n] ?? NaN);

    if (c.state.some((s) => !Number.isFinite(state[s.name]))) {
      result.note = `stopped at t=${t.toFixed(3)} — a stock went non-finite (try a smaller dt or check the model).`;
      break;
    }
    if (i === steps) break;

    if (method === "euler") {
      for (const s of c.state) state[s.name]! += dt * rates[s.name]!;
    } else {
      const k1 = rates;
      const k2 = deriv(c, addScaled(c, state, k1, dt / 2), t + dt / 2).rates;
      const k3 = deriv(c, addScaled(c, state, k2, dt / 2), t + dt / 2).rates;
      const k4 = deriv(c, addScaled(c, state, k3, dt), t + dt).rates;
      for (const s of c.state) {
        state[s.name]! += (dt / 6) * (k1[s.name]! + 2 * k2[s.name]! + 2 * k3[s.name]! + k4[s.name]!);
      }
    }
  }

  return result;
}

/** Evaluate aux/flow variables from current state, then every state derivative. */
function deriv(c: Compiled, state: StateVec, t: number): { rates: StateVec; scope: StateVec } {
  const scope: StateVec = { t, time: t };
  for (const s of c.state) scope[s.name] = state[s.name]!;
  const ctx: EvalCtx = { scope, tables: c.tables };
  for (const v of c.order) scope[v.name] = evalExpr(v.expr, ctx);
  const rates: StateVec = {};
  for (const s of c.state) rates[s.name] = s.rateExpr ? evalExpr(s.rateExpr, ctx) : 0;
  return { rates, scope };
}

function addScaled(c: Compiled, base: StateVec, k: StateVec, h: number): StateVec {
  const out: StateVec = {};
  for (const s of c.state) out[s.name] = base[s.name]! + h * k[s.name]!;
  return out;
}

// ── Initialization ──────────────────────────────────────────────────────────
// Stocks (user + internal delay stocks) and variables can be mutually dependent
// at t=start only through delay boundaries, which form a DAG. We seed every
// name to 0 and relax to the fixed point — enough passes resolve any DAG exactly.
function initialState(c: Compiled, start: number): StateVec {
  const scope: StateVec = { t: start, time: start };
  for (const s of c.state) scope[s.name] = 0;
  for (const v of c.order) scope[v.name] = 0;
  const ctx: EvalCtx = { scope, tables: c.tables };

  const passes = c.state.length + c.order.length + 2;
  for (let p = 0; p < passes; p++) {
    for (const v of c.order) scope[v.name] = evalExpr(v.expr, ctx);
    for (const s of c.state) scope[s.name] = evalExpr(s.initExpr, ctx);
  }

  const state: StateVec = {};
  for (const s of c.state) state[s.name] = scope[s.name]!;
  return state;
}

/** Re-export the compiled shape for callers that want structural access (diagram). */
export type { Compiled, StateVar, CompiledVar };
