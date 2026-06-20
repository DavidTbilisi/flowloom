import { test, expect } from "@playwright/test";

// Guided learning: the UI tour and an interactive lesson.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).flowloom?.run?.ok === true);
  const skip = page.locator(".tour-overlay .tour-skip");
  if (await skip.count()) await skip.click();
});

async function openLearn(page: import("@playwright/test").Page) {
  await page.locator("#learn").click();
  await expect(page.locator("#learnMenu.open")).toBeVisible();
}

test("Take the tour shows the overlay and advances", async ({ page }) => {
  await openLearn(page);
  await page.locator(".lm-item[data-kind='tour']").click();
  await expect(page.locator(".tour-overlay")).toBeVisible();
  await expect(page.locator(".tour-progress")).toHaveText("1 / 9");
  await page.locator(".tour-next").click();
  await expect(page.locator(".tour-progress")).toHaveText("2 / 9");
});

test("Skip closes the tour", async ({ page }) => {
  await openLearn(page);
  await page.locator(".lm-item[data-kind='tour']").click();
  await expect(page.locator(".tour-overlay")).toBeVisible();
  await page.locator(".tour-skip").click();
  await expect(page.locator(".tour-overlay")).toHaveCount(0);
});

test("an interactive lesson gates Next until the model is edited correctly", async ({ page }) => {
  await openLearn(page);
  await page.locator(".lm-item[data-kind='lesson']").first().click();
  await expect(page.locator(".tour-overlay")).toBeVisible();

  // step 1 seeds the starter model; advance to the gated "add the flow" step
  await page.locator(".tour-next").click();
  const next = page.locator(".tour-next");
  await expect(next).toBeDisabled();

  // add the growth flow the lesson asks for — Next should enable
  await page.locator("#src").press("End");
  await page.locator("#src").fill(
    "stock Population = 5\nparam birthRate = 0.7\nparam carrying = 1000\nflow growth = birthRate * Population * (1 - Population / carrying)\nsim dt=0.1 to=25 method=rk4",
  );
  await page.locator("#run").click();
  await expect(next).toBeEnabled();
});

test("a gated lesson explains why Next is disabled when the model errors", async ({ page }) => {
  await openLearn(page);
  await page.locator(".lm-item[data-kind='lesson']").first().click();
  await page.locator(".tour-next").click(); // step 1 → gated "add the flow" step

  // a flow referencing an undefined name keeps the model invalid: the hint
  // surfaces the error instead of leaving a silently dead Next button
  await page.locator("#src").fill(
    "stock Population = 5\nflow growth = fertility * Population\nsim dt=0.1 to=25 method=rk4",
  );
  await page.locator("#run").click();
  const hint = page.locator(".tour-hint");
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("fertility");
  await expect(page.locator(".tour-next")).toBeDisabled();

  // fixing it clears the hint and enables Next
  await page.locator("#src").fill(
    "stock Population = 5\nparam birthRate = 0.7\nparam carrying = 1000\nflow growth = birthRate * Population * (1 - Population / carrying)\nsim dt=0.1 to=25 method=rk4",
  );
  await page.locator("#run").click();
  await expect(hint).toBeHidden();
  await expect(page.locator(".tour-next")).toBeEnabled();
});

test("the build-visually lesson drives the real builder", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 }); // realistic height: card clears the build UI
  await openLearn(page);
  await page.locator(".lm-item", { hasText: "Build visually" }).click();
  await expect(page.locator(".tour-overlay")).toBeVisible();

  await page.locator(".tour-next").click(); // → "Turn on Edit"
  await page.locator('.canvas-ctrls [data-cv="edit"]').click();
  await page.locator(".tour-next").click(); // → gated "Add a flow"
  const next = page.locator(".tour-next");
  await expect(next).toBeDisabled();

  // add a flow through the builder, as the lesson instructs
  await page.locator('#buildBar [data-bt="flow"]').click();
  await page.locator("#buildPop .bp-name").fill("drain");
  await page.locator("#buildPop .bp-eq").fill("0.1 * Water");
  await page.locator("#buildPop .bp-save").click();

  await expect(next).toBeEnabled(); // the lesson's gate sees the new flow
});

test("an example walkthrough loads that model", async ({ page }) => {
  await openLearn(page);
  await page.locator(".lm-item[data-kind='walk']", { hasText: "SIR epidemic" }).click();
  await expect(page.locator(".tour-overlay")).toBeVisible();
  await expect(page.locator("#src")).toHaveValue(/stock S/);
});
