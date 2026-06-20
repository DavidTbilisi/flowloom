import { describe, it, expect } from "vitest";
import { parseModel, printExpr, parseExpr } from "../../src/lang/index.js";
import { simulate } from "../../src/engine/index.js";

const series = (src: string, name: string) => simulate(parseModel(src)).series.get(name)!;

describe("subscripts — scalarization equivalence", () => {
  it("an array model matches its hand-written scalar expansion", () => {
    // f[B] depends on S[A] (single-element index) — an asymmetric, non-trivial case.
    const array = `dim k = A, B
stock S[k] = 5
flow f[k] = 0.2*S[k] + S[A]*0.01
change(S[k]) = f[k]
aux tot = sum(S)
sim dt=0.5 to=10 method=rk4
plot S tot`;
    const scalar = `stock SA = 5
stock SB = 5
flow fA = 0.2*SA + SA*0.01
flow fB = 0.2*SB + SA*0.01
change(SA) = fA
change(SB) = fB
aux tot = SA + SB
sim dt=0.5 to=10 method=rk4
plot SA SB tot`;
    const a = simulate(parseModel(array));
    const s = simulate(parseModel(scalar));
    const eq = (x: number[], y: number[]) => x.forEach((v, i) => expect(v).toBeCloseTo(y[i]!, 9));
    eq(a.series.get("S.A")!, s.series.get("SA")!);
    eq(a.series.get("S.B")!, s.series.get("SB")!);
    eq(a.series.get("tot")!, s.series.get("tot")!);
  });

  it("expands a subscripted stock into one scalar per element", () => {
    const r = simulate(parseModel(`dim r = N, S, E
stock Pop[r] = 100
change(Pop[r]) = 0
sim dt=1 to=2
plot Pop`));
    expect(r.names).toContain("Pop.N");
    expect(r.names).toContain("Pop.S");
    expect(r.names).toContain("Pop.E");
  });

  it("matches the closed-form per element", () => {
    const Pop = series(`dim r = N, S
stock Pop[r] = 10
param k = 0.1
change(Pop[r]) = k * Pop[r]
sim dt=0.5 to=10 method=rk4
plot Pop`, "Pop.N");
    expect(Pop.at(-1)!).toBeCloseTo(10 * Math.exp(0.1 * 10), 4);
  });

  it("sum() collapses a dimension to the running total", () => {
    const tot = series(`dim r = N, S, E
stock Pop[r] = 7
change(Pop[r]) = 0
aux tot = sum(Pop)
sim dt=1 to=1
plot tot`, "tot");
    expect(tot[0]).toBe(21); // 3 × 7
  });
});

describe("subscripts — parsing & validation", () => {
  const err = (src: string) => {
    try { parseModel(src); return ""; } catch (e) { return (e as Error).message; }
  };

  it("rejects an unknown element index", () => {
    expect(err(`dim r = N, S\nstock Pop[r] = 1\nchange(Pop[r]) = Pop[West]`)).toMatch(/not an element/);
  });

  it("rejects a bare reference to a subscripted symbol", () => {
    expect(err(`dim r = N, S\nstock Pop[r] = 1\nchange(Pop[r]) = Pop`)).toMatch(/subscripted/);
  });

  it("rejects sum() of a non-subscripted symbol", () => {
    expect(err(`dim r = N, S\nstock Pop[r] = 1\nparam g = 2\nchange(Pop[r]) = sum(g)`)).toMatch(/sum\(\) needs a subscripted/);
  });

  it("rejects indexing a non-subscripted symbol", () => {
    expect(err(`dim r = N, S\nstock Pop[r] = 1\nparam g = 2\nchange(Pop[r]) = g[N]`)).toMatch(/not subscripted/);
  });

  it("keeps a non-dimension bracket as a unit annotation", () => {
    const m = parseModel(`stock Tank [liters] = 5\nchange(Tank) = 0`);
    expect(m.stocks[0]!.unit).toBe("liters");
    expect(m.stocks[0]!.dim).toBeUndefined();
  });
});

describe("subscripts — printExpr round-trip", () => {
  it("renders index and sum faithfully", () => {
    expect(printExpr(parseExpr("Pop[region]", 1))).toBe("Pop[region]");
    expect(printExpr(parseExpr("Pop[North]", 1))).toBe("Pop[North]");
    expect(printExpr(parseExpr("sum(Pop)", 1))).toBe("sum(Pop)");
  });
});
