import { describe, it, expect } from "vitest";
import { parseModel, printExpr, parseExpr, scalarize } from "../../src/lang/index.js";
import { simulate } from "../../src/engine/index.js";
import { applyOverride } from "../../src/engine/overrides.js";
import { lintModel } from "../../src/engine/lint.js";

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

describe("subscripts — review regressions", () => {
  const parseErr = (src: string) => {
    try { parseModel(src); return ""; } catch (e) { return (e as Error).message; }
  };

  it("rejects a duplicated sum axis instead of double-counting (#3)", () => {
    expect(parseErr(`dim from = A, B\ndim to = X, Y\nstock Trade[from, to] = 1\nchange(Trade[from, to]) = 0\naux row[from] = sum(Trade, to, to)`))
      .toMatch(/dimension 'to' more than once/);
  });

  it("rejects a literal pin / reorder on a sum argument instead of silently dropping it (#4)", () => {
    expect(parseErr(`dim from = A, B\ndim to = X, Y\nstock Trade[from, to] = 1\nchange(Trade[from, to]) = 0\naux row[from] = sum(Trade[A, to], to)`))
      .toMatch(/can't pin or reorder/);
  });

  it("flags a stray comma in a per-element value list instead of swallowing it (#6)", () => {
    expect(parseErr(`dim r = N, S\nstock Pop[r] = 10, , 20\nchange(Pop[r]) = 0`)).not.toBe("");
    expect(parseErr(`param x = 1,\nstock S = x\nchange(S) = 0`)).not.toBe("");
  });

  it("gives a clean located error for sum() in a model with no dimensions (#7)", () => {
    const msg = parseErr(`param a = 1\nparam b = 2\nstock S = 0\nflow g = sum(a, b)\nchange(S) = g`);
    expect(msg).toMatch(/sum\(\) needs a subscripted argument/);
    expect(msg).toMatch(/line \d+/); // located, not a line-less codegen throw
  });

  it("rejects garbage subscripts in a change() target (#8)", () => {
    expect(parseErr(`dim from = A, B\ndim to = X, Y\nstock Trade[from, to] = 1\nchange(Trade[$$$]) = 0`)).not.toBe("");
  });

  it("flags a bare elementwise reference used outside its dimension's scope (#9)", () => {
    expect(parseErr(`dim region = N, S\nstock Pop[region] = 5\nchange(Pop[region]) = 0\naux total = Pop[region]`))
      .toMatch(/isn't in an elementwise context|dimension 'region'/);
  });

  it("an override of a per-element param broadcasts to every element (#1)", () => {
    const model = parseModel(`dim product = Food, Tools
param growth[product] = 0.1, 0.5
stock Inv[product] = 10
change(Inv[product]) = growth[product] * Inv[product]
sim dt=0.5 to=2 method=rk4
plot Inv`);
    applyOverride(model, "growth=0.3");
    const r = simulate(model);
    // both elements now grow at 0.3 (the override), not the old 0.1 / 0.5
    expect(r.series.get("Inv.Food")!.at(-1)!).toBeCloseTo(10 * Math.exp(0.3 * 2), 4);
    expect(r.series.get("Inv.Tools")!.at(-1)!).toBeCloseTo(10 * Math.exp(0.3 * 2), 4);
  });

  it("validates calls inside non-first per-element expressions (#5)", () => {
    const model = parseModel(`dim d = X, Y\nparam p[d] = 1, sqrt(2, 3)\nstock S = p[X]\nchange(S) = 0`);
    const errs = lintModel(model).filter((g) => g.severity === "error");
    expect(errs.some((g) => /sqrt/.test(g.message))).toBe(true);
  });
});

describe("subscripts — printExpr round-trip", () => {
  it("renders index and sum faithfully", () => {
    expect(printExpr(parseExpr("Pop[region]", 1))).toBe("Pop[region]");
    expect(printExpr(parseExpr("Pop[North]", 1))).toBe("Pop[North]");
    expect(printExpr(parseExpr("sum(Pop)", 1))).toBe("sum(Pop)");
  });
});

describe("scalarization preserves declaration flags", () => {
  // An element is the same kind of thing its declaration was. Rebuilding the
  // decl field by field silently dropped every flag, so a subscripted `const`
  // became an ordinary sensitivity knob and its `# @rung` tag vanished from the
  // leverage ladder — with nothing anywhere saying so.
  const scalar = (src: string) => scalarize(parseModel(src));

  it("keeps `const` constant across elements", () => {
    const m = scalar("dim r = A, B\nconst rate[r] = 0.1\nstock X[r] = 1\nchange(X[r]) = rate[r]\nsim dt=1 to=3");
    for (const name of ["rate.A", "rate.B"]) expect(m.varIndex.get(name)!.constant, name).toBe(true);
  });

  it("keeps a `# @rung N` tag on every element", () => {
    const m = scalar("dim r = A, B\nparam lever[r] = 1   # @rung 4 a lever\nstock X[r] = 1\nchange(X[r]) = lever[r]\nsim dt=1 to=3");
    for (const name of ["lever.A", "lever.B"]) expect(m.varIndex.get(name)!.rung, name).toBe(4);
  });

  it("keeps a `>= 0` floor on every element", () => {
    const m = scalar("dim r = A, B\nstock Pop[r] >= 0 = 5\nchange(Pop[r]) = -1\nsim dt=1 to=3");
    for (const s of m.stocks) expect(s.nonNegative, s.name).toBe(true);
  });

  it("does not leave an expanded element claiming to be an array", () => {
    const m = scalar("dim r = A, B\nstock Pop[r] = 5, 6\nchange(Pop[r]) = -1\nsim dt=1 to=3");
    for (const s of m.stocks) {
      expect(s.dims, s.name).toBeUndefined();
      expect(s.elemExprs, s.name).toBeUndefined();
    }
  });
});


describe("change() subscripts are checked, not discarded", () => {
  // The subscript list on a rate target used to be matched by a non-capturing
  // group: `change(Pop[Sooth])` and `change(Trade[to, from])` both parsed
  // cleanly and silently meant the un-indexed stock. A wrong axis name or a
  // wrong axis *order* is exactly the mistake that survives review, so it has
  // to be a located error rather than a shrug.
  const head = `dim region = North, South\nstock Pop [region] = 10\n`;

  it("accepts the stock's own dimensions, in order", () => {
    const m = parseModel(`${head}change(Pop[region]) = 1\nsim dt=1 to=2 method=euler`);
    expect(m.rates.get("Pop")!.subs).toEqual(["region"]);
    const r = simulate(scalarize(m));
    expect(r.series.get("Pop.North")!.at(-1)).toBeCloseTo(12, 9);
  });

  it("rejects a misspelled dimension", () => {
    expect(() => parseModel(`${head}change(Pop[Sooth]) = 1\nsim dt=1 to=2`))
      .toThrow(/'Sooth' is not a declared dim.*subscripted over \[region\]/s);
  });

  it("rejects the right axes in the wrong order", () => {
    const two = `dim a = A1, A2\ndim b = B1, B2\nstock Trade [a, b] = 0\n`;
    expect(() => parseModel(`${two}change(Trade[b, a]) = 1\nsim dt=1 to=2`))
      .toThrow(/names dimension 'b' in position 1.*declared over \[a, b\]/s);
  });

  it("rejects indexing a stock that has no dimensions", () => {
    expect(() => parseModel(`dim region = North, South\nstock Cash = 0\nchange(Cash[region]) = 1\nsim dt=1 to=2`))
      .toThrow(/'Cash' is not subscripted.*write change\(Cash\)/s);
  });

  it("rejects the wrong number of axes", () => {
    const two = `dim a = A1, A2\ndim b = B1, B2\nstock Trade [a, b] = 0\n`;
    expect(() => parseModel(`${two}change(Trade[a]) = 1\nsim dt=1 to=2`))
      .toThrow(/has 2 dimension\(s\) \[a, b\] but change\(\) indexes it with 1/);
  });
});

describe("expect on a subscripted series", () => {
  // `expect final:Pop[North] > 5` used to pass parse-time validation (the base
  // was split off at the bracket and the subscript discarded) and then fail at
  // run time, because the scalarized series is `Pop.North`.
  const src = (line: string) =>
    `dim region = North, South\nstock Pop [region] = 10, 20\nchange(Pop[region]) = 0\nsim dt=1 to=2 method=euler\n${line}`;

  it("resolves the bracket form to the scalar series name", () => {
    const m = parseModel(src("expect final:Pop[South] == 20"));
    expect(m.expects[0]!.metric).toBe("final:Pop.South");
  });

  it("runs, and judges the indexed element", async () => {
    const { runExpects } = await import("../../src/engine/expect.js");
    const pass = await runExpects(parseModel(src("expect final:Pop[South] == 20")));
    expect(pass.failed).toBe(0);
    expect(pass.results[0]!.actual).toBe(20);
    const fail = await runExpects(parseModel(src("expect final:Pop[North] == 20")));
    expect(fail.failed).toBe(1);
    expect(fail.results[0]!.actual).toBe(10);
  });

  it("accepts the already-scalar spelling, so fmt output re-reads", () => {
    expect(parseModel(src("expect final:Pop.North == 10")).expects[0]!.metric).toBe("final:Pop.North");
  });

  it("rejects a bare reference to a whole vector", () => {
    expect(() => parseModel(src("expect final:Pop == 10")))
      .toThrow(/'Pop' is subscripted over \[region\].*index it, e\.g\. Pop\[North\]/s);
  });

  it("rejects an element that isn't in the dimension", () => {
    expect(() => parseModel(src("expect final:Pop[East] == 10")))
      .toThrow(/'East' is not an element of dim 'region' \(North, South\)/);
  });

  it("tells a dimension name apart from an element name", () => {
    expect(() => parseModel(src("expect final:Pop[region] == 10")))
      .toThrow(/'region' is a dimension, not an element/);
  });
});

describe("per-element overrides", () => {
  const model = () => parseModel(
    `dim region = North, South\nstock Pop [region] = 10, 20\nchange(Pop[region]) = 0\nparam rate [region] = 1\nsim dt=1 to=2 method=euler`,
  );

  it("sets one element and leaves the others alone", () => {
    const m = model();
    expect(applyOverride(m, "Pop[North]=99")).toEqual([]);
    const r = simulate(scalarize(m));
    expect(r.series.get("Pop.North")!.at(-1)).toBe(99);
    expect(r.series.get("Pop.South")!.at(-1)).toBe(20);
  });

  it("broadcasts the shared expression before replacing one entry", () => {
    // `param rate [region] = 1` has no per-element list, so overriding one
    // element has to materialise the other from the shared expression.
    const m = model();
    applyOverride(m, "rate[South]=7");
    const s = scalarize(m);
    expect(s.varIndex.get("rate.North")!.expr).toMatchObject({ kind: "num", value: 1 });
    expect(s.varIndex.get("rate.South")!.expr).toMatchObject({ kind: "num", value: 7 });
  });

  it("still supports the broadcast form, with its warning", () => {
    const m = model();
    expect(applyOverride(m, "Pop=5")).toEqual(['"Pop" is subscripted — setting every element to 5']);
    const r = simulate(scalarize(m));
    expect(r.series.get("Pop.North")!.at(-1)).toBe(5);
    expect(r.series.get("Pop.South")!.at(-1)).toBe(5);
  });

  it("rejects an element that isn't in the dimension", () => {
    expect(() => applyOverride(model(), "Pop[East]=1")).toThrow(/"East" is not an element of dim "region"/);
  });

  it("rejects indexing something that isn't subscripted", () => {
    const m = parseModel("stock Cash = 0\nchange(Cash) = 1\nsim dt=1 to=2");
    expect(() => applyOverride(m, "Cash[North]=1")).toThrow(/"Cash" is not subscripted.*set Cash instead/s);
  });
});

describe("array reducers — mean, min, max", () => {
  // `sum` was the only reducer; docs/language.md listed the others as planned.
  // They lower through the same element list; only what is built from it differs.
  const src = (extra: string) => `dim region = North, South, East
stock Pop [region] = 100, 200, 300
change(Pop[region]) = 0
${extra}
sim dt=1 to=2 method=euler`;

  const value = (extra: string, name: string) => {
    const r = simulate(scalarize(parseModel(src(extra))));
    return r.series.get(name)!.at(-1)!;
  };

  it("reduces an array four ways", () => {
    expect(value("aux Total = sum(Pop)", "Total")).toBe(600);
    expect(value("aux Avg = mean(Pop)", "Avg")).toBe(200);
    expect(value("aux Least = min(Pop)", "Least")).toBe(100);
    expect(value("aux Most = max(Pop)", "Most")).toBe(300);
  });

  it("leaves the scalar min/max builtin alone", () => {
    // The rule is a *bare subscripted name* in the first argument: an indexed
    // element or a plain expression is the ordinary variadic builtin.
    expect(value("aux Guard = min(Pop[North], 150)", "Guard")).toBe(100);
    expect(value("aux Cap = max(Pop[South], 500)", "Cap")).toBe(500);
    expect(value("aux Plain = min(3, 7, 5)", "Plain")).toBe(3);
  });

  it("collapses one axis and keeps the rest", () => {
    const two = `dim a = A1, A2
dim b = B1, B2
stock Trade [a, b] = 1, 2, 30, 40
change(Trade[a, b]) = 0
aux rowMax [a] = max(Trade, b)
aux rowAvg [a] = mean(Trade, b)
sim dt=1 to=2 method=euler`;
    const r = simulate(scalarize(parseModel(two)));
    expect(r.series.get("rowMax.A1")!.at(-1)).toBe(2);
    expect(r.series.get("rowMax.A2")!.at(-1)).toBe(40);
    expect(r.series.get("rowAvg.A1")!.at(-1)).toBe(1.5);
    expect(r.series.get("rowAvg.A2")!.at(-1)).toBe(35);
  });

  it("names the reducer in its own diagnostics", () => {
    expect(() => parseModel(src("aux X = mean(Pop, nope)")))
      .toThrow(/mean\(\)'s axis must be a dimension of 'Pop'/);
    const two = `dim a = A1, A2\ndim b = B1, B2\nstock Trade [a, b] = 1\nchange(Trade[a, b]) = 0\naux X = max(Trade, b)\nsim dt=1 to=2`;
    expect(() => parseModel(two)).toThrow(/max\(\) over b leaves dimension 'a' free/);
  });

  it("rejects mean() on something that isn't an array", () => {
    expect(() => parseModel(src("aux X = mean(3)"))).toThrow(/mean\(\) needs a subscripted argument/);
  });
});
