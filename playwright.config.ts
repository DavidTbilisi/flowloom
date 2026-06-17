import { defineConfig, devices } from "@playwright/test";

// E2E tests drive the real built app in a real browser. They are the
// behavioural contract for the UI: load → edit → run → animate → inspect.
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:4317",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev -- --port 4317 --strictPort",
    url: "http://localhost:4317",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
