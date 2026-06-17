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
    expect(messages(`stock X = 1\nstock Frozen = 5\nd(X) = 1`)).toContain("stock 'Frozen' has no d(Frozen) rate — it never changes");
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
