import { describe, it, expect } from "vitest";
import { ARITY, STATEFUL, REFERENCE, REFERENCE_BY_NAME } from "../../src/engine/index.js";

// Contract: the language reference catalog must cover every callable the engine
// knows about, and its arity must match the validator's. Adding a builtin in
// builtins.ts without a catalog entry fails here (mirrors help.test.ts).

describe("language reference catalog", () => {
  it("covers every stateless builtin with a matching arity", () => {
    for (const [name, arity] of Object.entries(ARITY)) {
      const e = REFERENCE_BY_NAME.get(name);
      expect(e, `missing reference entry for builtin '${name}'`).toBeTruthy();
      expect(e!.arity, `missing arity for '${name}'`).toEqual(arity);
    }
  });

  it("covers every stateful builtin", () => {
    for (const name of STATEFUL) {
      const e = REFERENCE_BY_NAME.get(name);
      expect(e, `missing reference entry for stateful builtin '${name}'`).toBeTruthy();
      expect(e!.kind).toBe("stateful");
    }
  });

  it("every entry has a signature and a summary", () => {
    for (const e of REFERENCE) {
      expect(e.signature, `entry '${e.name}' needs a signature`).toBeTruthy();
      expect(e.summary, `entry '${e.name}' needs a summary`).toBeTruthy();
    }
  });

  it("names are unique", () => {
    expect(REFERENCE_BY_NAME.size).toBe(REFERENCE.length);
  });
});
