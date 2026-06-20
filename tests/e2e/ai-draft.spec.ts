import { test, expect } from "@playwright/test";

// E2E for the headline AI-first feature: describe a system → AI writes .flow →
// it parses and runs. The Anthropic API is mocked (no key, no network, no spend)
// so we pin the *wiring*: panel → request → extract → validate → adopt → run.

const MODEL_TEXT =
  "```flow\n# Coffee shop: word-of-mouth growth braked by a seating cap\n" +
  "stock Customers = 5\nparam wordOfMouth = 0.4\nparam seats = 200\n" +
  "flow growth = wordOfMouth * Customers * (1 - Customers / seats)\n" +
  "change(Customers) = growth\nsim dt=0.1 to=40 method=rk4\nplot Customers\n```";

test("AI draft turns a prompt into a running model", async ({ page }) => {
  await page.route("https://api.anthropic.com/v1/messages", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: MODEL_TEXT }] }),
    }),
  );
  await page.goto("/");
  await page.waitForFunction(() => (window as any).flowloom?.run?.ok === true);

  await page.locator("#ai").click();
  await page.locator("#aiKey").fill("sk-ant-test");
  await page.locator("#aiPrompt").fill("a coffee shop where word of mouth drives growth but seating caps it");
  await page.locator("#aiGo").click();

  // the AI's model became the canonical text and was simulated
  await expect(page.locator("#src")).toHaveValue(/stock Customers = 5/);
  const run = await page.evaluate(() => {
    const s = (window as any).flowloom.run;
    return { ok: s.ok, names: s.result.names };
  });
  expect(run.ok).toBe(true);
  expect(run.names).toContain("Customers");
  // panel closed on success
  await expect(page.locator("#aiPanel")).toBeHidden();
});

test("AI draft surfaces an API error without touching the model", async ({ page }) => {
  await page.route("https://api.anthropic.com/v1/messages", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "invalid x-api-key" } }),
    }),
  );
  await page.goto("/");
  await page.waitForFunction(() => (window as any).flowloom?.run?.ok === true);
  const before = await page.locator("#src").inputValue();

  await page.locator("#ai").click();
  await page.locator("#aiKey").fill("sk-ant-bad");
  await page.locator("#aiPrompt").fill("anything");
  await page.locator("#aiGo").click();

  await expect(page.locator("#aiMsg")).toHaveText(/invalid API key/);
  // the existing model is untouched on failure
  expect(await page.locator("#src").inputValue()).toBe(before);
});
