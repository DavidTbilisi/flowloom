import { describe, it, expect } from "vitest";
import { parseModel, ModelError } from "../../src/lang/index.js";
import { parseExpr, printExpr, freeVars } from "../../src/lang/expr.js";

// These tests PIN the language grammar and semantics. They are the contract an
// AI (or a human) can rely on when writing flowloom models. Changing them is a
// deliberate language change, not an incidental refactor.

describe("expression parser", () => {
  it("respects precedence and associativity", () => {
    expect(printExpr(parseExpr("1 + 2 * 3", 1))).toBe("1 + 2 * 3");
    expect(printExpr(parseExpr("(1 + 2) * 3", 1))).toBe("(1 + 2) * 3");
    // ^ is right-associative
    expect(printExpr(parseExpr("2 ^ 3 ^ 2", 1))).toBe("2 ^ 3 ^ 2");
  });

  it("treats ** as ^ (power)", () => {
    const e = parseExpr("2 ** 10", 1);
    expect(printExpr(e)).toBe("2 ^ 10");
  });

  it("extracts free variables, excluding function names", () => {
    const vars = freeVars(parseExpr("birthRate * Population * (1 - Population / carrying)", 1));
    expect([...vars].sort()).toEqual(["Population", "birthRate", "carrying"]);
    expect([...freeVars(parseExpr("max(0, x + y)", 1))].sort()).toEqual(["x", "y"]);
  });

  it("rejects malformed expressions with a location", () => {
    expect(() => parseExpr("1 +", 7)).toThrow();
    expect(() => parseExpr("(1 + 2", 7)).toThrow();
  });
});

describe("model parser", () => {
  it("parses the canonical declarations", () => {
    const m = parseModel(`stock X = 5\nparam r = 0.1\nflow f = r * X\nd(X) = f`);
    expect(m.stocks.map((s) => s.name)).toEqual(["X"]);
    expect(m.vars.map((v) => v.name)).toEqual(["r", "f"]);
    expect(m.rates.has("X")).toBe(true);
  });

  it("captures units and trailing-comment docs", () => {
    const m = parseModel(`stock Population [people] = 5   # the headcount\nd(Population) = 0`);
    expect(m.stocks[0]!.unit).toBe("people");
    expect(m.stocks[0]!.doc).toBe("the headcount");
  });

  it("topologically orders auxiliaries", () => {
    const m = parseModel(`stock X = 1\nparam a = 2\naux c = b + 1\naux b = a * 2\nd(X) = c`);
    const order = m.order.map((v) => v.name);
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
  });

  it("rejects duplicate definitions", () => {
    expect(() => parseModel(`stock X = 1\nstock X = 2`)).toThrow(ModelError);
  });

  it("rejects reserved names", () => {
    expect(() => parseModel(`stock t = 1`)).toThrow(/reserved/);
  });

  it("rejects an algebraic loop among auxiliaries", () => {
    expect(() => parseModel(`stock X = 1\naux a = b + 1\naux b = a + 1\nd(X) = a`)).toThrow(/algebraic loop/);
  });

  it("rejects references to unknown names", () => {
    expect(() => parseModel(`stock X = 1\nd(X) = nonexistent`)).toThrow(/unknown name 'nonexistent'/);
  });

  it("requires at least one stock", () => {
    expect(() => parseModel(`param r = 1`)).toThrow(/no stocks/);
  });

  it("requires d() to target a real stock", () => {
    expect(() => parseModel(`stock X = 1\nd(Y) = 1`)).toThrow(/no matching/);
  });

  it("parses tables and overrides sim settings", () => {
    const m = parseModel(`stock X = 1\ntable f = (0,0) (1,2) (2,3)\nflow g = f(X)\nd(X) = g\nsim dt=0.5 to=10 method=euler`);
    expect(m.tables.get("f")!.points).toEqual([
      [0, 0],
      [1, 2],
      [2, 3],
    ]);
    expect(m.settings).toMatchObject({ dt: 0.5, to: 10, method: "euler" });
  });

  it("rejects a table whose x-values do not strictly increase", () => {
    expect(() => parseModel(`stock X=1\ntable f = (0,0) (0,1)\nd(X)=0`)).toThrow(/strictly increase/);
  });
});
