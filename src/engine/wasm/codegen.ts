// ── Model → WASM derivative function ────────────────────────────────────────
// Compile a SimPlan's expressions into the body of one `deriv(f64 t)` function
// over linear memory. Scope slot s lives at byte offset s*8; the rates region
// follows the scope vector. Pure arithmetic uses native f64 ops; transcendental
// and time/test/lookup functions are imported (see encoder IMPORTS). The result
// is byte-identical numerically to the TS backend — same slot layout, same
// builtin semantics — which the parity tests pin.

import type { Expr } from "../../lang/types.js";
import type { SimPlan } from "../codegen.js";
import { makeSlotMap } from "../codegen.js";
import { buildModule, OP, FUNC, uLEB, sLEB, f64Bytes } from "./encoder.js";

const F64_BLOCK = 0x7c;
const PI = Math.PI;
const E = Math.E;

export interface WasmProgram {
  bytes: Uint8Array;
  /** Lookup tables, indexed by the id emitted into the bytecode. */
  tablePoints: ReadonlyArray<readonly [number, number]>[];
  /** f64 slots in the scope vector + rates region (for memory sizing). */
  totalSlots: number;
  scopeSlots: number;
}

export function compileWasm(plan: SimPlan): WasmProgram {
  const slots = makeSlotMap(plan);
  const tableIds = new Map<string, number>();
  const tablePoints: ReadonlyArray<readonly [number, number]>[] = [];
  const tableId = (name: string): number => {
    let id = tableIds.get(name);
    if (id === undefined) {
      id = tablePoints.length;
      tableIds.set(name, id);
      tablePoints.push(plan.compiled.tables.get(name)!.points);
    }
    return id;
  };

  const out: number[] = [];
  const storeAt = (slot: number, value: () => void) => {
    out.push(OP.i32_const, ...sLEB(slot * 8));
    value();
    out.push(OP.f64_store, 3, 0); // align=2^3=8, offset=0
  };
  const loadT = () => out.push(OP.local_get, 0);

  // emit code that leaves the value of `e` on the stack
  const emit = (e: Expr): void => {
    switch (e.kind) {
      case "num":
        out.push(OP.f64_const, ...f64Bytes(e.value));
        return;
      case "ident": {
        const s = slots.get(e.name);
        if (s !== undefined) { out.push(OP.i32_const, ...sLEB(s * 8), OP.f64_load, 3, 0); return; }
        if (e.name === "PI") { out.push(OP.f64_const, ...f64Bytes(PI)); return; }
        if (e.name === "E") { out.push(OP.f64_const, ...f64Bytes(E)); return; }
        throw new Error(`unknown name '${e.name}'`);
      }
      case "unary":
        emit(e.arg);
        if (e.op === "-") out.push(OP.f64_neg);
        return;
      case "binary": {
        emit(e.left);
        emit(e.right);
        switch (e.op) {
          case "+": out.push(OP.f64_add); return;
          case "-": out.push(OP.f64_sub); return;
          case "*": out.push(OP.f64_mul); return;
          case "/": out.push(OP.f64_div); return;
          case "%": out.push(OP.call, ...uLEB(FUNC.rem!)); return;
          case "^": out.push(OP.call, ...uLEB(FUNC.pow!)); return;
        }
        return;
      }
      case "call": {
        if (plan.compiled.tables.has(e.name)) {
          const id = tableId(e.name);
          out.push(OP.i32_const, ...sLEB(id));
          emit(e.args[0]!);
          out.push(OP.call, ...uLEB(FUNC.lookup!));
          return;
        }
        emitBuiltin(e.name.toLowerCase(), e.args, emit, out, loadT);
        return;
      }
    }
    throw new Error("malformed expression");
  };

  // deriv body: t/time, then vars in order, then rates after the scope region.
  storeAt(plan.tSlot, loadT);
  storeAt(plan.timeSlot, loadT);
  for (const v of plan.varSteps) storeAt(v.slot, () => emit(v.expr));
  for (let j = 0; j < plan.rateExprs.length; j++) {
    const expr = plan.rateExprs[j]!;
    storeAt(plan.size + j, () => (expr ? emit(expr) : out.push(OP.f64_const, ...f64Bytes(0))));
  }

  const totalSlots = plan.size + plan.rateExprs.length;
  const pages = Math.max(1, Math.ceil((totalSlots * 8) / 65536));
  return { bytes: buildModule(out, pages), tablePoints, totalSlots, scopeSlots: plan.size };
}

const NATIVE_UNARY: Record<string, number> = {
  abs: OP.f64_abs, sqrt: OP.f64_sqrt, floor: OP.f64_floor, ceil: OP.f64_ceil,
};
const IMPORT_UNARY: Record<string, string> = {
  sin: "sin", cos: "cos", tan: "tan", exp: "exp", ln: "ln", log: "ln",
  log10: "log10", sign: "sign", round: "round",
};

function emitBuiltin(name: string, args: Expr[], emit: (e: Expr) => void, out: number[], loadT: () => void): void {
  const call = (fn: string) => out.push(OP.call, ...uLEB(FUNC[fn]!));

  if (name in NATIVE_UNARY) { emit(args[0]!); out.push(NATIVE_UNARY[name]!); return; }
  if (name in IMPORT_UNARY) { emit(args[0]!); call(IMPORT_UNARY[name]!); return; }

  switch (name) {
    case "pow": emit(args[0]!); emit(args[1]!); call("pow"); return;
    case "min":
    case "max": {
      const op = name === "min" ? OP.f64_min : OP.f64_max;
      emit(args[0]!);
      for (let i = 1; i < args.length; i++) { emit(args[i]!); out.push(op); }
      return;
    }
    case "clamp": // max(lo, min(hi, x))
      emit(args[1]!); emit(args[2]!); emit(args[0]!);
      out.push(OP.f64_min, OP.f64_max);
      return;
    case "if": // both branches must NOT both eval — use a real if/else producing f64
      emit(args[0]!);
      out.push(OP.f64_const, ...f64Bytes(0), OP.f64_ne, OP.if_, F64_BLOCK);
      emit(args[1]!);
      out.push(OP.else_);
      emit(args[2]!);
      out.push(OP.end);
      return;
    case "step": // step(height, t0)
      emit(args[0]!); emit(args[1]!); loadT(); call("step"); return;
    case "pulse": // pulse(t0, width?)
      emit(args[0]!);
      if (args.length > 1) emit(args[1]!); else out.push(OP.f64_const, ...f64Bytes(0));
      loadT(); call("pulse"); return;
    case "ramp": // ramp(slope, t0, t1?)
      emit(args[0]!); emit(args[1]!);
      if (args.length > 2) emit(args[2]!); else out.push(OP.f64_const, ...f64Bytes(Infinity));
      loadT(); call("ramp"); return;
  }
  throw new Error(`unknown function '${name}'`);
}
