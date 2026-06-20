import { test, expect } from "@playwright/test";

// Plot overlays: Monte Carlo bands, observed-data overlay + calibration, and a
// model-comparison overlay — all driven through the real studio.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).flowloom?.run?.ok === true);
});

test("Monte Carlo shades percentile bands over the plot", async ({ page }) => {
  await page.locator("#src").fill("stock W = 0\nflow s = random_normal(0, 1)\nchange(W) = s\nsim dt=1 to=20 seed=1\nplot W");
  await page.locator("#run").click();
  await page.waitForFunction(() => (window as any).flowloom.run.ok === true);

  await page.locator("#mcRuns").fill("50");
  await page.locator("#mcBtn").click();
  await page.waitForFunction(() => !!(window as any).flowloom.overlay.bands);
  const runs = await page.evaluate(() => (window as any).flowloom.overlay.bands.runs);
  expect(runs).toBe(50);

  // re-running the model clears the (now stale) bands
  await page.locator("#run").click();
  await page.waitForFunction(() => !(window as any).flowloom.overlay.bands);
});

test("loading data enables calibrate, which fits params and writes them back", async ({ page }) => {
  await page.locator("#src").fill("stock Pop = 10\nparam rate = 0.2\nflow g = rate*Pop\nchange(Pop) = g\nsim dt=1 to=10\nplot Pop");
  await page.locator("#run").click();
  await page.waitForFunction(() => (window as any).flowloom.run.ok === true);

  // synthetic observations generated from the true rate ≈ 0.08 (10·e^{0.08 t})
  const csv = "t,Pop\n0,10\n2,11.73\n4,13.77\n6,16.16\n8,18.96\n10,22.26";
  await page.locator("#dataInput").setInputFiles({ name: "obs.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.waitForFunction(() => !!(window as any).flowloom.overlay.data);
  await expect(page.locator("#calBtn")).toBeEnabled();

  await page.locator("#calBtn").click();
  // the calibrated rate is written back into the canonical text and re-run
  await expect.poll(() => page.evaluate(() => (window as any).flowloom.run.model.varIndex.get("rate").expr.value)).toBeLessThan(0.15);
  await expect(page.locator("#src")).not.toHaveValue(/rate = 0\.2\b/);
});

test("calibrate fits only the checked params", async ({ page }) => {
  await page.locator("#src").fill("stock S = 5\nparam a = 0.1\nparam b = 7\nflow f = a*S + b\nchange(S) = f\nsim dt=1 to=10\nplot S");
  await page.locator("#run").click();
  await page.waitForFunction(() => (window as any).flowloom.run.ok === true);

  const csv = "t,S\n0,5\n2,12\n4,25\n6,45\n8,75\n10,120";
  await page.locator("#dataInput").setInputFiles({ name: "obs.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.waitForFunction(() => !!(window as any).flowloom.overlay.data);

  // exclude `b` from the fit, then calibrate
  await page.locator('#calParams input[data-p="b"]').uncheck();
  await page.locator("#calBtn").click();

  // b stays exactly 7 (excluded); a moves off its 0.1 start
  await expect.poll(() => page.evaluate(() => (window as any).flowloom.run.model.varIndex.get("b").expr.value)).toBe(7);
  const a = await page.evaluate(() => (window as any).flowloom.run.model.varIndex.get("a").expr.value);
  expect(a).not.toBe(0.1);
});

test("Compare overlays a second model and Clear removes overlays", async ({ page }) => {
  const other = "stock Population = 5\nparam r = 0.3\nflow g = r*Population\nchange(Population) = g\nsim dt=0.1 to=25\nplot Population";
  await page.locator("#cmpInput").setInputFiles({ name: "other.flow", mimeType: "text/plain", buffer: Buffer.from(other) });
  await page.waitForFunction(() => !!(window as any).flowloom.overlay.compare);

  await expect(page.locator("#clearOvBtn")).toBeVisible();
  await page.locator("#clearOvBtn").click();
  await page.waitForFunction(() => !(window as any).flowloom.overlay.compare);
});
