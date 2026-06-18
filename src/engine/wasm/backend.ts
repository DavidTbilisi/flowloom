// ── WASM derivative backend ─────────────────────────────────────────────────
// Instantiate a model's generated module and expose it as a DerivBackend whose
// `mem`/`rates` are typed-array views directly over the module's linear memory —
// so the shared integrator (codegen.ts) reads and writes WASM memory with zero
// copying, and only the per-step `deriv` crosses into WASM. The imported helpers
// replicate builtins.ts exactly so results match the TS backend bit-for-bit
// (apart from the inherent reordering of floating-point you'd get either way).

import type { SimPlan, DerivBackend } from "../codegen.js";
import { lookupTable } from "../builtins.js";
import { compileWasm, type WasmProgram } from "./codegen.js";

export function wasmAvailable(): boolean {
  return typeof WebAssembly !== "undefined" && typeof WebAssembly.instantiate === "function";
}

function imports(program: WasmProgram): WebAssembly.Imports {
  const tp = program.tablePoints;
  return {
    e: {
      sin: Math.sin, cos: Math.cos, tan: Math.tan, exp: Math.exp,
      ln: Math.log, log10: Math.log10, sign: Math.sign, round: Math.round,
      pow: Math.pow,
      rem: (a: number, b: number) => a % b,
      step: (h: number, t0: number, t: number) => (t >= t0 ? h : 0),
      pulse: (t0: number, width: number, t: number) => {
        if (width <= 0) return t === t0 ? 1 : 0;
        return t >= t0 && t < t0 + width ? 1 : 0;
      },
      ramp: (slope: number, t0: number, t1: number, t: number) => {
        if (t <= t0) return 0;
        return slope * (Math.min(t, t1) - t0);
      },
      lookup: (id: number, x: number) => lookupTable(tp[id]!, x),
    },
  };
}

/** Compile + instantiate a plan into a WASM-backed derivative evaluator. */
export async function createWasmBackend(plan: SimPlan): Promise<DerivBackend> {
  const program = compileWasm(plan);
  const { instance } = await WebAssembly.instantiate(program.bytes as BufferSource, imports(program));
  const memory = instance.exports.memory as WebAssembly.Memory;
  const buf = memory.buffer;
  const mem = new Float64Array(buf, 0, plan.size);
  const rates = new Float64Array(buf, plan.size * 8, plan.stateSlots.length);
  const derivFn = instance.exports.deriv as (t: number) => void;
  return { mem, rates, deriv: (t: number) => derivFn(t) };
}
