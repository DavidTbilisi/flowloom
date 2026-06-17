import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildLlmsDoc } from "../../scripts/gen-llms.js";

// Contract: docs/llms.txt is generated from the REFERENCE catalog + a bundled
// example. If the catalog changes (a new builtin, a reworded summary), the
// checked-in cheatsheet must be regenerated — `npm run gen:llms`.

describe("docs/llms.txt", () => {
  it("is up to date with the generator", () => {
    const onDisk = readFileSync("docs/llms.txt", "utf8");
    expect(onDisk, "docs/llms.txt is stale — run `npm run gen:llms`").toBe(buildLlmsDoc());
  });
});
