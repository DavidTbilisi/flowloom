import { test, expect } from "@playwright/test";

// The "Check numbers" button is the studio's only validation of the *run*
// rather than the text. It has to give both answers honestly — a settled model
// must read as settled, and a model whose answer moves must say so, on screen,
// where someone is about to believe the plot.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).flowloom?.run?.ok === true);
});

const runModel = async (page: import("@playwright/test").Page, src: string) => {
  await page.locator("#src").fill(src);
  await page.locator("#run").click();
  await page.waitForFunction(() => (window as any).flowloom.run.ok === true);
};

test("says the numbers hold when the answer has stopped moving", async ({ page }) => {
  await runModel(page, "stock X = 100\nparam k = 0.1\nchange(X) = -k * X\nsim dt=0.1 to=50 method=rk4\nplot X");
  await page.locator("#numerics").click();
  await expect(page.locator("#err")).toContainText("the numbers hold", { timeout: 15_000 });
  await expect(page.locator("#err")).toHaveClass(/ok/);
});

test("says the numbers move, and names a step where they stop", async ({ page }) => {
  await runModel(page, "stock X = 100\nparam k = 0.1\nchange(X) = -k * X\nsim dt=1 to=10 method=euler\nplot X");
  await page.locator("#numerics").click();
  await expect(page.locator("#err")).toContainText("the numbers move", { timeout: 15_000 });
  await expect(page.locator("#err")).toContainText("try dt=");
  await expect(page.locator("#err")).toHaveClass(/warn/);
});

test("the verdict belongs to the text it was computed for", async ({ page }) => {
  await runModel(page, "stock X = 100\nparam k = 0.1\nchange(X) = -k * X\nsim dt=0.1 to=50 method=rk4\nplot X");
  await page.locator("#numerics").click();
  await expect(page.locator("#err")).toContainText("the numbers hold", { timeout: 15_000 });

  // edit the model: the old verdict is about the old text, so it must go
  await runModel(page, "stock X = 100\nparam k = 0.4\nchange(X) = -k * X\nsim dt=0.1 to=50 method=rk4\nplot X");
  await expect(page.locator("#err")).not.toContainText("the numbers hold");
});

test("carries an advisory a refinement alone would miss", async ({ page }) => {
  // The run converges at every dt, but τ=0.05 against dt=0.5 means the response
  // on screen is the grid's, not the model's.
  await runModel(page, "stock L = 0\nparam target = 10\naux expected = smooth(target, 0.05)\nchange(L) = expected - L\nsim dt=0.5 to=20\nplot L");
  await page.locator("#numerics").click();
  await expect(page.locator("#err")).toContainText("the numbers hold", { timeout: 15_000 });
  await expect(page.locator("#err")).toContainText("fastest time constant");
});
