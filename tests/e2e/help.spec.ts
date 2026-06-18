import { test, expect } from "@playwright/test";

// The contextual-help status bar + the editor's syntax highlighting.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).flowloom?.run?.ok === true);
  // a fresh first visit may auto-open the tour overlay — dismiss it if present
  const skip = page.locator(".tour-overlay .tour-skip");
  if (await skip.count()) await skip.click();
});

test("the editor renders a syntax-highlight overlay", async ({ page }) => {
  await expect(page.locator("#hl")).toBeAttached();
  // the default logistic model has the `stock` keyword colored
  await expect(page.locator("#hl .tok-keyword").first()).toHaveText(/stock|flow|param|d/);
});

test("hovering a diagram node updates the status bar", async ({ page }) => {
  await page.getByRole("button", { name: "Diagram" }).click();
  const node = page.locator("#diagram g[data-help^='ui:node']").first();
  await expect(node).toBeVisible();
  await node.hover();
  await expect(page.locator("#statusbar")).toHaveClass(/sb-active/);
  await expect(page.locator("#statusbar .sb-text")).not.toHaveText("");
});

test("hovering a tab explains it in the status bar", async ({ page }) => {
  await page.locator(".tabs button[data-help='ui:tab-loops']").hover();
  await expect(page.locator("#statusbar .sb-title")).toContainText("Loops");
});

test("hovering an R/B badge explains loop polarity", async ({ page }) => {
  await page.getByRole("button", { name: "Loops" }).click();
  await page.locator("#loopsWrap .loop .badge").first().hover();
  await expect(page.locator("#statusbar .sb-text")).toContainText(/reinforc|balanc|indetermin/i);
});

test("a Learn more link appears and opens the Format tab", async ({ page }) => {
  // a stock node resolves to identifier help, which carries a doc anchor
  await page.getByRole("button", { name: "Diagram" }).click();
  const node = page.locator("#diagram g[data-help='ui:node-stock']").first();
  await expect(node).toBeVisible();
  await node.hover();
  const more = page.locator("#statusbar .sb-more");
  await expect(more).toBeVisible();
  await more.click();
  await expect(page.locator("#view-help")).toBeVisible();
});
