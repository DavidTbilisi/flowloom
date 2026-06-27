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
    expect(m.stocks[0]!.dims).toBeUndefined();
  });
});

describe("subscripts — multiple dimensions", () => {
  it("expands a 2-D stock into the full Cartesian product", () => {
    const r = simulate(parseModel(`dim from = A, B
dim to = X, Y
stock Trade[from, to] = 1
change(Trade[from, to]) = 0
sim dt=1 to=1
plot Trade`));
    for (const n of ["Trade.A.X", "Trade.A.Y", "Trade.B.X", "Trade.B.Y"]) expect(r.names).toContain(n);
  });

  it("a 2-D array model matches its hand-written scalar expansion", () => {
    // Trade[f,t] grows at rate cost[t]; a per-column (to) param, referenced elementwise.
    const array = `dim from = A, B
dim to = X, Y
param cost[to] = 0.1
stock Trade[from, to] = 2
change(Trade[from, to]) = cost[to] * Trade[from, to]
aux total = sum(Trade)
sim dt=0.5 to=6 method=rk4
plot Trade total`;
    const scalar = `param costX = 0.1
param costY = 0.1
stock TradeAX = 2
stock TradeAY = 2
stock TradeBX = 2
stock TradeBY = 2
change(TradeAX) = costX * TradeAX
change(TradeAY) = costY * TradeAY
change(TradeBX) = costX * TradeBX
change(TradeBY) = costY * TradeBY
aux total = TradeAX + TradeAY + TradeBX + TradeBY
sim dt=0.5 to=6 method=rk4
plot total`;
    const a = simulate(parseModel(array));
    const s = simulate(parseModel(scalar));
    const eq = (x: number[], y: number[]) => x.forEach((v, i) => expect(v).toBeCloseTo(y[i]!, 9));
    eq(a.series.get("Trade.A.X")!, s.series.get("TradeAX")!);
    eq(a.series.get("Trade.B.Y")!, s.series.get("TradeBY")!);
    eq(a.series.get("total")!, s.series.get("total")!);
  });

  it("sum() over a 2-D array collapses every element", () => {
    const tot = series(`dim from = A, B
dim to = X, Y
stock Trade[from, to] = 3
change(Trade[from, to]) = 0
aux total = sum(Trade)
sim dt=1 to=1
plot total`, "total");
    expect(tot[0]).toBe(12); // 4 elements × 3
  });

  it("rejects the wrong number of subscripts", () => {
    const err = (() => {
      try { parseModel(`dim from = A, B\ndim to = X, Y\nstock Trade[from, to] = 1\nchange(Trade[from, to]) = Trade[from]`); return ""; }
      catch (e) { return (e as Error).message; }
    })();
    expect(err).toMatch(/2 dimension\(s\).*indexed with 1/);
  });
});

describe("subscripts — per-element values", () => {
  it("gives each element its own initial value, in product order", () => {
    const r = simulate(parseModel(`dim region = North, South
dim product = Food, Tools
stock Inventory[region, product] = 10, 20, 30, 40
change(Inventory[region, product]) = 0
sim dt=1 to=1
plot Inventory`));
    expect(r.series.get("Inventory.North.Food")![0]).toBe(10);
    expect(r.series.get("Inventory.North.Tools")![0]).toBe(20);
    expect(r.series.get("Inventory.South.Food")![0]).toBe(30);
    expect(r.series.get("Inventory.South.Tools")![0]).toBe(40);
  });

  it("a per-element param drives distinct dynamics, matching the closed form", () => {
    const r = simulate(parseModel(`dim product = Food, Tools
param growth[product] = 0.1, 0.5
stock Inv[product] = 10
change(Inv[product]) = growth[product] * Inv[product]
sim dt=0.25 to=2 method=rk4
plot Inv`));
    expect(r.series.get("Inv.Food")!.at(-1)!).toBeCloseTo(10 * Math.exp(0.1 * 2), 4);
    expect(r.series.get("Inv.Tools")!.at(-1)!).toBeCloseTo(10 * Math.exp(0.5 * 2), 4);
  });

  it("a single value still broadcasts to all elements", () => {
    const r = simulate(parseModel(`dim r = N, S, E\nstock Pop[r] = 7\nchange(Pop[r]) = 0\nsim dt=1 to=1\nplot Pop`));
    for (const el of ["N", "S", "E"]) expect(r.series.get(`Pop.${el}`)![0]).toBe(7);
  });

  it("leaves a comma inside a call intact (not an element list)", () => {
    const r = simulate(parseModel(`dim r = N, S\nstock Pop[r] = max(3, 8)\nchange(Pop[r]) = 0\nsim dt=1 to=1\nplot Pop`));
    expect(r.series.get("Pop.N")![0]).toBe(8);
    expect(r.series.get("Pop.S")![0]).toBe(8);
  });

  it("rejects a value-count / element-count mismatch", () => {
    const err = (() => {
      try { parseModel(`dim r = N, S, E\nstock Pop[r] = 1, 2\nchange(Pop[r]) = 0`); return ""; }
      catch (e) { return (e as Error).message; }
    })();
    expect(err).toMatch(/3 element\(s\) but 2 value\(s\)/);
  });

  it("rejects per-element values on a non-subscripted declaration", () => {
    const err = (() => {
      try { parseModel(`stock Pop = 1, 2\nchange(Pop) = 0`); return ""; }
      catch (e) { return (e as Error).message; }
    })();
    expect(err).toMatch(/per-element values need a dimension/);
  });
});

describe("subscripts — partial-axis sum", () => {
  const m = () => simulate(parseModel(`dim from = A, B
dim to = X, Y
stock Trade[from, to] = 1, 2, 3, 4
change(Trade[from, to]) = 0
aux out_by_from[from] = sum(Trade, to)
aux in_by_to[to]      = sum(Trade, from)
aux grand             = sum(Trade)
sim dt=1 to=1
plot Trade out_by_from in_by_to grand`));

  it("sum(X, axis) collapses one axis and keeps the rest", () => {
    const r = m();
    expect(r.series.get("out_by_from.A")![0]).toBe(3); // Trade[A,X] + Trade[A,Y] = 1+2
    expect(r.series.get("out_by_from.B")![0]).toBe(7); // 3+4
  });

  it("collapses the other axis symmetrically", () => {
    const r = m();
    expect(r.series.get("in_by_to.X")![0]).toBe(4); // Trade[A,X] + Trade[B,X] = 1+3
    expect(r.series.get("in_by_to.Y")![0]).toBe(6); // 2+4
  });

  it("a no-axis sum still collapses everything, equal to summing the partials", () => {
    const r = m();
    expect(r.series.get("grand")![0]).toBe(10);
    expect(r.series.get("out_by_from.A")![0] + r.series.get("out_by_from.B")![0]).toBe(10);
    expect(r.series.get("in_by_to.X")![0] + r.series.get("in_by_to.Y")![0]).toBe(10);
  });

  it("rejects an axis that isn't a dimension of the array", () => {
    const err = (() => {
      try { parseModel(`dim from = A, B\ndim to = X, Y\nstock Trade[from, to] = 1\nchange(Trade[from, to]) = 0\naux bad[from] = sum(Trade, region)`); return ""; }
      catch (e) { return (e as Error).message; }
    })();
    expect(err).toMatch(/axis must be a dimension of 'Trade'/);
  });

  it("rejects a partial sum whose leftover axis isn't bound by the result", () => {
    const err = (() => {
      try { parseModel(`dim from = A, B\ndim to = X, Y\nstock Trade[from, to] = 1\nchange(Trade[from, to]) = 0\naux scalar = sum(Trade, to)`); return ""; }
      catch (e) { return (e as Error).message; }
    })();
    expect(err).toMatch(/leaves dimension 'from' free/);
  });
});

describe("subscripts — printExpr round-trip", () => {
  it("renders index and sum faithfully", () => {
    expect(printExpr(parseExpr("Pop[region]", 1))).toBe("Pop[region]");
    expect(printExpr(parseExpr("Pop[North]", 1))).toBe("Pop[North]");
    expect(printExpr(parseExpr("sum(Pop)", 1))).toBe("sum(Pop)");
  });
});
