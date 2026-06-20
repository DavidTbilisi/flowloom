// ── Minimal WebAssembly binary encoder ──────────────────────────────────────
// Just enough to assemble the one module flowloom needs: a single exported
// `deriv(f64 t)` function that reads/writes f64 linear memory, plus a fixed set
// of imported math helpers and an exported memory. Hand-rolled so the engine
// has no heavyweight runtime dependency (binaryen.js is megabytes). The opcode
// subset is f64 arithmetic + load/store + a couple of control ops; see codegen.
//
// Generating WASM bytecode from the AST keeps the no-`eval` safety property:
// WASM runs sandboxed, and we never build JavaScript from model text.

// f64 = 0x7C, i32 = 0x7F
const F64 = 0x7c;
const I32 = 0x7f;

/** Fixed import table. Order defines the function indices used by codegen. */
export const IMPORTS = [
  "sin", "cos", "tan", "exp", "ln", "log10", "sign", "round", // (f64)->f64
  "pow", "rem",                                                // (f64,f64)->f64
  "step", "pulse",                                             // (f64,f64,f64)->f64
  "ramp",                                                      // (f64,f64,f64,f64)->f64
  "lookup",                                                    // (i32,f64)->f64
  "runif", "rnorm",                                            // (f64,f64,f64,f64,f64)->f64
] as const;

/** Function index of each import (and of the defined `deriv`). */
export const FUNC: Record<string, number> = Object.fromEntries(IMPORTS.map((n, i) => [n, i]));
export const DERIV_FUNC_INDEX = IMPORTS.length;

// WASM opcodes used by codegen.
export const OP = {
  f64_const: 0x44,
  f64_load: 0x2b,
  f64_store: 0x39,
  i32_const: 0x41,
  local_get: 0x20,
  call: 0x10,
  f64_neg: 0x9a,
  f64_add: 0xa0,
  f64_sub: 0xa1,
  f64_mul: 0xa2,
  f64_div: 0xa3,
  f64_min: 0xa4,
  f64_max: 0xa5,
  f64_abs: 0x99,
  f64_sqrt: 0x9f,
  f64_floor: 0x9c,
  f64_ceil: 0x9b,
  f64_trunc: 0x9d,
  f64_ne: 0x62,
  if_: 0x04,
  else_: 0x05,
  end: 0x0b,
} as const;

// ── byte helpers ─────────────────────────────────────────────────────────────
export function uLEB(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return out;
}

export function sLEB(n: number): number[] {
  const out: number[] = [];
  let more = true;
  while (more) {
    let b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) more = false;
    else b |= 0x80;
    out.push(b);
  }
  return out;
}

export function f64Bytes(x: number): number[] {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, x, true); // little-endian
  return [...new Uint8Array(buf)];
}

/** A WASM name: a length-prefixed UTF-8 byte vector. */
const str = (s: string): number[] => {
  const b = [...new TextEncoder().encode(s)];
  return [...uLEB(b.length), ...b];
};
/** A WASM vector: a uLEB count followed by the concatenated items. */
function flatVec(items: number[][]): number[] {
  return [...uLEB(items.length), ...items.flat()];
}
const section = (id: number, content: number[]): number[] => [id, ...uLEB(content.length), ...content];

// ── functype builders ────────────────────────────────────────────────────────
const funcType = (params: number[], results: number[]): number[] => [
  0x60,
  ...uLEB(params.length),
  ...params,
  ...uLEB(results.length),
  ...results,
];

// type indices
const T_A = 0; // (f64)->f64
const T_B = 1; // (f64,f64)->f64
const T_C = 2; // (f64,f64,f64)->f64
const T_D = 3; // (f64,f64,f64,f64)->f64
const T_L = 4; // (i32,f64)->f64
const T_E = 5; // (f64,f64,f64,f64,f64)->f64
const T_DERIV = 6; // (f64)->()

const importTypeIndex = (name: string): number => {
  if (["pow", "rem"].includes(name)) return T_B;
  if (["step", "pulse"].includes(name)) return T_C;
  if (name === "ramp") return T_D;
  if (name === "lookup") return T_L;
  if (["runif", "rnorm"].includes(name)) return T_E;
  return T_A;
};

/**
 * Assemble the complete module.
 * @param body  the deriv function body (instructions, WITHOUT the trailing `end`)
 * @param pages linear-memory size in 64 KiB pages
 */
export function buildModule(body: number[], pages: number): Uint8Array {
  const types = flatVec([
    funcType([F64], [F64]),
    funcType([F64, F64], [F64]),
    funcType([F64, F64, F64], [F64]),
    funcType([F64, F64, F64, F64], [F64]),
    funcType([I32, F64], [F64]),
    funcType([F64, F64, F64, F64, F64], [F64]),
    funcType([F64], []),
  ]);

  const imports = flatVec(
    IMPORTS.map((name) => [...str("e"), ...str(name), 0x00, ...uLEB(importTypeIndex(name))]),
  );

  const funcs = flatVec([uLEB(T_DERIV)]); // one defined function: deriv
  const mems = flatVec([[0x00, ...uLEB(pages)]]); // limits: min only
  const exports = flatVec([
    [...str("deriv"), 0x00, ...uLEB(DERIV_FUNC_INDEX)],
    [...str("memory"), 0x02, ...uLEB(0)],
  ]);

  // code: one function body = locals vec (none) + body + end
  const funcBody = [...uLEB(0), ...body, OP.end];
  const code = flatVec([[...uLEB(funcBody.length), ...funcBody]]);

  const bytes = [
    0x00, 0x61, 0x73, 0x6d, // \0asm
    0x01, 0x00, 0x00, 0x00, // version 1
    ...section(1, types),
    ...section(2, imports),
    ...section(3, funcs),
    ...section(5, mems),
    ...section(7, exports),
    ...section(10, code),
  ];
  return Uint8Array.from(bytes);
}
