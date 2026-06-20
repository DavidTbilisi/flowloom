import { describe, it, expect } from "vitest";
import { extractFlow } from "../../src/ui/ai-draft.js";

// CONTRACT: the AI is told to emit bare .flow text, but models sometimes wrap it
// in ```fences``` or add a stray sentence. extractFlow must recover the model
// source so it can be parsed and run. (Pure string function — DOM-free.)

describe("extractFlow", () => {
  it("returns bare text unchanged (the happy path)", () => {
    const src = "stock S = 1\nchange(S) = 0\nsim dt=1 to=5";
    expect(extractFlow(src)).toBe(src);
  });

  it("unwraps a ```flow fenced block", () => {
    const out = extractFlow("Here is your model:\n```flow\nstock S = 1\nchange(S) = 0\n```\nEnjoy!");
    expect(out).toBe("stock S = 1\nchange(S) = 0");
  });

  it("unwraps a plain ``` fence and a ```text fence", () => {
    expect(extractFlow("```\nstock S = 1\n```")).toBe("stock S = 1");
    expect(extractFlow("```text\nstock S = 1\n```")).toBe("stock S = 1");
  });

  it("trims surrounding whitespace", () => {
    expect(extractFlow("\n\n  stock S = 1\n\n  ")).toBe("stock S = 1");
  });
});
