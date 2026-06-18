import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { compile, buildPlan, tsBackend, runPlan, simulate, simulateAsync, worthWasm } from "../../src/engine/index.js";
import { createWasmBackend, wasmAvailable } from "../../src/engine/wasm/backend.js";
import { compileWasm } from "../../src/engine/wasm/codegen.js";
import { buildModule, OP, uLEB, f64Bytes } from "../../src/engine/wasm/encoder.js";
import { EXAMPLES } from "../../src/examples/index.js";

// The WASM backend must reproduce the TS backend's numbers. The TS backend is
// already pinned against closed-form solutions (engine.test.ts), so parity here
// transitively pins WASM to the same contracts.

async function runBoth(src: string) {
  const model = parseModel(src);
  const plan = buildPlan(compile(model));
  const ts = runPlan(model, plan, tsBackend(plan));
  const wasm = runPlan(model, plan, await createWasmBackend(buildPlan(compile(model))));
  return { ts, wasm };
}

describe("WASM encoder", () => {
  it("assembles a valid module that runs", () => {
    // deriv: store t*2 at slot 1
    const body = [
      OP.i32_const, ...uLEB(8), OP.local_get, 0,
      OP.f64_const, ...f64Bytes(2), OP.f64_mul, OP.f64_store, 3, 0,
    ];
    const mod = new WebAssembly.Module(buildModule(body, 1) as BufferSource);
    const noop = () => 0;
    const e = Object.fromEntries(
      ["sin", "cos", "tan", "exp", "ln", "log10", "sign", "round", "pow", "rem", "step", "pulse", "ramp", "lookup"].map((n) => [n, noop]),
    );
    const inst = new WebAssembly.Instance(mod, { e });
    const mem = new Float64Array((inst.exports.memory as WebAssembly.Memory).buffer);
    (inst.exports.deriv as (t: number) => void)(21);
    expect(mem[1]).toBe(42);
  });

  it("is available in this environment", () => {
    expect(wasmAvailable()).toBe(true);
  });
});

describe("WASM ↔ TS parity", () => {
  it("matches on every built-in example", async () => {
    for (const ex of EXAMPLES) {
      const { ts, wasm } = await runBoth(ex.source);
      expect(wasm.names, ex.name).toEqual(ts.names);
      expect(wasm.t.length, ex.name).toBe(ts.t.length);
      for (const n of ts.names) {
        const a = ts.series.get(n)!, b = wasm.series.get(n)!;
        for (let i = 0; i < a.length; i++) {
          expect(b[i], `${ex.name}:${n}[${i}]`).toBeCloseTo(a[i]!, 9);
        }
      }
    }
  });

  it("matches on a model exercising every builtin family", async () => {
    const src = `
stock A = 5
stock B = 10
param p = 2
table tb = (0,0) (5,10) (10,5)
aux mathy = min(max(abs(-A), sqrt(B)), 99) + clamp(A, 0, 8) + pow(2, 3) + sign(A-3)
aux trig  = sin(A) + cos(B) + tan(0.3) + exp(0.1) + ln(B) + log10(B) + floor(A*1.3) + ceil(A*0.2) + round(A*0.7)
aux inputs = step(2, 5) + pulse(3, 2) + ramp(0.5, 1, 8) + (A % 3)
aux cond  = if(A - B, A, B)
aux looked = tb(A)
flow fa = -0.1*A + 0.02*B + inputs*0.01
flow fb = 0.05*A - 0.03*B + cond*0.001
d(A) = fa
d(B) = fb
sim dt=0.1 to=30 method=rk4
plot A B mathy trig inputs cond looked`;
    const { ts, wasm } = await runBoth(src);
    for (const n of ts.names) {
      const a = ts.series.get(n)!, b = wasm.series.get(n)!;
      for (let i = 0; i < a.length; i++) expect(b[i], `${n}[${i}]`).toBeCloseTo(a[i]!, 9);
    }
  });

  it("matches on a model with delays/smoothing (internal stocks)", async () => {
    const src = `
stock Inventory = 200
param target = 200
param adjustTime = 4
param leadTime = 6
aux sales = 20 + step(10, 10)
aux gap = target - Inventory
aux orders = max(0, sales + gap / adjustTime)
flow receiving = delay3(orders, leadTime)
aux smoothed = smooth(sales, 3)
d(Inventory) = receiving - sales
sim dt=0.25 to=60 method=rk4
plot Inventory receiving smoothed`;
    const { ts, wasm } = await runBoth(src);
    for (const n of ts.names) {
      const a = ts.series.get(n)!, b = wasm.series.get(n)!;
      for (let i = 0; i < a.length; i++) expect(b[i], `${n}[${i}]`).toBeCloseTo(a[i]!, 8);
    }
  });

  it("matches under Euler too", async () => {
    const { ts, wasm } = await runBoth(
      "stock X = 1000\nparam r = 0.05\nflow interest = r*X\nd(X) = interest\nsim dt=1 to=40 method=euler\nplot X",
    );
    expect(wasm.series.get("X")!.at(-1)).toBeCloseTo(ts.series.get("X")!.at(-1)!, 6);
  });

  it("generated modules stay small", () => {
    const plan = buildPlan(compile(parseModel(EXAMPLES[5]!.source)));
    const program = compileWasm(plan);
    expect(program.bytes.length).toBeLessThan(20_000);
  });
});

describe("simulateAsync (public entry, with fallback)", () => {
  it("matches simulate() on a small model (TS fallback path)", async () => {
    const model = parseModel(EXAMPLES[0]!.source);
    const sync = simulate(model);
    const async = await simulateAsync(model);
    for (const n of sync.names) {
      const a = sync.series.get(n)!, b = async.series.get(n)!;
      for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i]!, 9);
    }
  });

  it("routes only large/heavy runs to the WASM path", () => {
    // small model: stays on the synchronous TS backend
    const small = buildPlan(compile(parseModel(EXAMPLES[0]!.source)));
    expect(worthWasm(small, parseModel(EXAMPLES[0]!.source).settings)).toBe(false);

    // a wide model over many steps: worth the per-model WASM compile
    const N = 80, L: string[] = [];
    for (let i = 0; i < N; i++) L.push(`stock S${i} = 1`);
    for (let i = 0; i < N; i++) L.push(`d(S${i}) = 0.01`);
    L.push("sim dt=0.05 to=1500 method=rk4");
    const big = parseModel(L.join("\n"));
    expect(worthWasm(buildPlan(compile(big)), big.settings)).toBe(true);
  });
});
