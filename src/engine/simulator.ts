import type { Model } from "../lang/types.js";
import { compile, type Compiled, type StateVar, type CompiledVar } from "./compile.js";
import { buildPlan, tsBackend, initStateInto, runIntegration, type SimPlan } from "./codegen.js";

// ── The integrator ──────────────────────────────────────────────────────────
// The whole simulation is one rule applied over and over:
//     state(t+dt) = state(t) + dt · d(state)/dt
// You write the derivatives (`d(NAME) = …`); flowloom integrates them with
// Euler or classical RK4. Aux/flow variables are recomputed from state every
// time the derivative is sampled (including RK4's intermediate stages).
//
// The arithmetic itself runs through a compiled evaluation plan (codegen.ts):
// every name lives at a fixed slot in one reused Float64Array and each
// expression is compiled once. This module owns the synchronous TS backend; the
// WASM backend (engine/wasm/) reuses the same plan and integrator for very large
// models. Both produce identical numbers — the contract tests pin that.

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

/** Synchronous simulation via the compiled-TS backend. */
export function simulate(model: Model): SimResult {
  const c = compile(model);
  const plan = buildPlan(c);
  const backend = tsBackend(plan);
  return runPlan(model, plan, backend);
}

/** Heuristic: the per-model WASM compile cost only pays off for big runs. */
export function worthWasm(plan: SimPlan, settings: { dt: number; to: number; start: number }): boolean {
  const steps = Math.max(1, Math.round((settings.to - settings.start) / settings.dt));
  const states = plan.stateSlots.length;
  // ≈ derivative-evaluations; tuned so small interactive models stay on the
  // synchronous TS path and only genuinely large runs go through WASM.
  return states >= 64 && states * steps >= 2_000_000;
}

/**
 * Simulation that uses the WASM backend for large models and falls back to the
 * compiled-TS backend otherwise (or if WASM is unavailable / fails to build).
 * Always returns the same SimResult shape as {@link simulate}.
 */
export async function simulateAsync(model: Model): Promise<SimResult> {
  const c = compile(model);
  const plan = buildPlan(c);
  if (worthWasm(plan, model.settings)) {
    try {
      const { wasmAvailable, createWasmBackend } = await import("./wasm/backend.js");
      if (wasmAvailable()) {
        const backend = await createWasmBackend(plan);
        return runPlan(model, plan, backend);
      }
    } catch {
      // fall through to the TS backend
    }
  }
  return runPlan(model, plan, tsBackend(plan));
}

/**
 * Run a prepared plan with a given derivative backend (TS or WASM). Shared so
 * the WASM path produces a byte-identical SimResult shape.
 */
export function runPlan(
  model: Model,
  plan: SimPlan,
  backend: Parameters<typeof runIntegration>[1],
): SimResult {
  const { dt, method } = model.settings;
  initStateInto(plan, backend.mem, model.settings.start);
  const out = runIntegration(plan, backend, model.settings);
  return {
    t: out.t,
    series: out.series,
    names: plan.outNames,
    stockNames: plan.stockNames,
    varNames: plan.varNames,
    dt,
    method,
    note: out.note,
  };
}

/** Re-export the compiled shape for callers that want structural access (diagram). */
export type { Compiled, StateVar, CompiledVar, SimPlan };
