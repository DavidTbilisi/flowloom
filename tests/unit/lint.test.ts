import { describe, it, expect } from "vitest";
import { parseModel } from "../../src/lang/index.js";
import { editDistance, suggestName } from "../../src/lang/suggest.js";
import { lintModel } from "../../src/engine/index.js";
import { EXAMPLES } from "../../src/examples/index.js";

const messages = (src: string) => lintModel(parseModel(src)).map((d) => d.message);

describe("suggestName / did-you-mean", () => {
  it("measures edit distance", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("abc", "abc")).toBe(0);
  });

  it("prefers a case-only match", () => {
    expect(suggestName("birthrate", ["Population", "birthRate"])).toBe("birthRate");
  });

  it("suggests a near miss but not a wild guess", () => {
    expect(suggestName("Populaton", ["Population", "birthRate"])).toBe("Population");
    expect(suggestName("zzzzzz", ["Population", "birthRate"])).toBeUndefined();
  });

  it("the parser enriches an unknown-name error with the hint", () => {
    expect(() =>
      parseModel(`stock Population = 5\nparam birthRate = 0.7\nflow g = birthrate * Population\nd(Population) = g`),
    ).toThrow(/unknown name 'birthrate' — did you mean 'birthRate'\?/);
  });

  it("an unknown name with no near miss still gets a recovery pointer (never a dead end)", () => {
    expect(() => parseModel(`stock S = 1\nd(S) = velocity`)).toThrow(
      /unknown name 'velocity' — define it \(stock\/param\/aux\/flow\) or check the spelling/,
    );
  });
});

describe("lintModel", () => {
  it("flags an unused param", () => {
    expect(messages(`stock X = 1\nparam unusedKnob = 9\nd(X) = 1`)).toContain("param 'unusedKnob' is never used");
  });

  it("flags a computed-but-unused var", () => {
    const m = messages(`stock X = 1\nparam r = 2\nflow dead = r * 2\nd(X) = r\nplot X`);
    expect(m.some((s) => /flow 'dead' is computed but never used/.test(s))).toBe(true);
  });

  it("flags a stock with no rate", () => {
    expect(messages(`stock X = 1\nstock Frozen = 5\nd(X) = 1`)).toContain("stock 'Frozen' has no change(Frozen) rate — it never changes");
  });

  it("flags a non-positive time constant — literal or resolved param", () => {
    expect(messages(`stock X = 1\nflow s = smooth(X, -2)\nd(X) = s`).some((s) => /non-positive time constant \(-2\)/.test(s))).toBe(true);
    expect(messages(`stock X = 1\nparam lag = -3\nflow s = delay3(X, lag)\nd(X) = s`).some((s) => /non-positive time constant \(-3\)/.test(s))).toBe(true);
  });

  it("does not warn on a positive time constant", () => {
    expect(messages(`stock X = 1\nparam lag = 4\nflow s = smooth(X, lag)\nd(X) = s\nplot X`).some((s) => /time constant/.test(s))).toBe(false);
  });

  it("a well-formed example lints clean", () => {
    expect(lintModel(parseModel(EXAMPLES.find((e) => e.name === "Logistic growth")!.source))).toEqual([]);
  });
});

describe("call validation (unknown function / arity)", () => {
  const diags = (src: string) => lintModel(parseModel(src));

  it("flags an unknown function as an error with a line and did-you-mean", () => {
    const d = diags(`stock S = 1\nd(S) = sqrtt(S)`);
    const e = d.find((x) => x.severity === "error")!;
    expect(e.message).toMatch(/unknown function 'sqrtt' — did you mean 'sqrt'\?/);
    expect(e.loc.line).toBe(2);
  });

  it("a function with no near miss still gets a recovery pointer (never a dead end)", () => {
    expect(diags(`stock S = 1\nd(S) = avg(1, 2)`).some(
      (x) => x.severity === "error" && /unknown function 'avg' — not a flowloom builtin — check the reference/.test(x.message),
    )).toBe(true);
  });

  it("flags wrong argument counts", () => {
    expect(diags(`stock S = 1\nd(S) = clamp(S)`).some((x) => /clamp\(\) takes 3 arguments, got 1/.test(x.message))).toBe(true);
    expect(diags(`stock S = 1\nd(S) = sin(S, S)`).some((x) => /sin\(\) takes 1 argument, got 2/.test(x.message))).toBe(true);
  });

  it("accepts real builtins, stateful functions, sum, and case-insensitive names", () => {
    const ok = `dim R = A, B\nstock P[R] = 1\nparam tau = 2\naux total = sum(P)\naux sm = smooth(total, tau)\naux mixed = SIN(total) + Max(1, 2) + clamp(total, 0, 5)\nchange(P[R]) = 0 * sm * mixed`;
    expect(diags(ok).filter((x) => x.severity === "error")).toEqual([]);
  });
});
