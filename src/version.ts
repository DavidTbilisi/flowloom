// The one place the version lives in source. `flowloom --version`, the
// `reference` header and the MCP server all read it from here, and
// tests/unit/version.test.ts pins it to package.json — because the CLI and MCP
// build from a separate tsconfig that CI did not used to run, and this constant
// silently drifted to 0.1.0 while the package said 0.2.0.
export const VERSION = "0.2.0";
