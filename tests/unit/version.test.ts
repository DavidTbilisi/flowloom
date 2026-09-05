import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { VERSION } from "../../src/version.js";

// CONTRACT: one version, everywhere. `flowloom --version`, the `reference`
// header and the MCP server's advertised version all read src/version.ts, and
// it must match the package. This exists because the CLI and MCP build from a
// separate tsconfig that CI did not run, so their hard-coded copy drifted to
// 0.1.0 while package.json said 0.2.0 — with nothing to catch it.

describe("version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
