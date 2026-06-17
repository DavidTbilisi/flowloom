import { defineConfig } from "vitest/config";

// Contract tests run in Node against the pure-TS engine — no DOM needed.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    globals: false,
  },
});
