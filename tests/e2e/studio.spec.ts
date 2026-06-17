import { test, expect } from "@playwright/test";

// E2E = the behavioural contract for the studio. These drive the real app in a
// real browser: load → run → inspect → animate → switch models.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // wait for the store to mount and the default model to have run
  await page.waitForFunction(() => (window as any).flowloom?.run?.ok === true);
});

test("boots with the logistic example simulated", async ({ page }) => {
  await expect(page.locator("#src")).toHaveValue(/stock Population/);
  const ok = await page.evaluate(() => {
    const s = (window as any).flowloom;
    return { ok: s.run.ok, frames: s.run.result.t.length, names: s.run.result.names };
  });
  expect(ok.ok).toBe(true);
  expect(ok.frames).toBeGreaterThan(10);
  expect(ok.names).toContain("Population");
});

test("editing the model re-runs it (text is the source of truth)", async ({ page }) => {
  await page.locator("#src").fill(
    "stock X = 0\nparam r = 2\nflow f = r\nd(X) = f\nsim dt=1 to=10 method=euler",
  );
  await page.locator("#run").click();
  const finalX = await page.evaluate(() => {
    const s = (window as any).flowloom.run.result;
    const arr = s.series.get("X");
    return arr[arr.length - 1];
  });
  expect(finalX).toBeCloseTo(20, 6); // dX/dt = 2 over 10 ⇒ 20
});

test("reports a clear error for a broken model", async ({ page }) => {
  await page.locator("#src").fill("stock X = 1\nd(X) = doesNotExist");
  await page.locator("#run").click();
  await expect(page.locator("#err.error")).toBeVisible();
  await expect(page.locator("#err")).toContainText("unknown name");
});

test("diagram tab renders nodes and loop chips", async ({ page }) => {
  await page.getByRole("button", { name: "Diagram" }).click();
  await expect(page.locator("#diagram rect").first()).toBeVisible();
  // logistic growth has exactly one feedback loop ⇒ one chip
  await expect(page.locator("#loopChips .chip")).toHaveCount(1);
  await expect(page.locator("#loopChips .chip .badge")).toHaveText("R");
});

test("loops tab classifies the cooling model as balancing", async ({ page }) => {
  await page.locator("#src").fill(
    "stock Temp = 90\nparam room = 20\nparam k = 0.3\nflow cooling = k*(Temp-room)\nd(Temp) = -cooling\nsim to=20",
  );
  await page.locator("#run").click();
  await page.getByRole("button", { name: "Loops" }).click();
  await expect(page.locator("#loopsWrap .loop")).toHaveCount(1);
  await expect(page.locator("#loopsWrap .loop .badge")).toHaveText("B");
});

test("playback advances the animation clock", async ({ page }) => {
  // jump to start, play, and confirm the frame index advances
  await page.locator("#transport-plot [data-act='start']").click();
  const startFrame = await page.evaluate(() => (window as any).flowloom.frame);
  expect(startFrame).toBe(0);

  await page.locator("#transport-plot [data-act='play']").click();
  await page.waitForTimeout(800);
  const laterFrame = await page.evaluate(() => (window as any).flowloom.frame);
  expect(laterFrame).toBeGreaterThan(0);
});

test("scrubber sets the frame and the clock label", async ({ page }) => {
  await page.locator("#transport-plot [data-act='end']").click();
  const t = await page.locator("#transport-plot .clock").textContent();
  expect(t).toMatch(/t = /);
  const atEnd = await page.evaluate(() => {
    const s = (window as any).flowloom;
    return s.frame === s.run.result.t.length - 1;
  });
  expect(atEnd).toBe(true);
});

test("switching examples loads a different model", async ({ page }) => {
  await page.locator("#example").selectOption("SIR epidemic");
  await expect(page.locator("#src")).toHaveValue(/stock S/);
  const names = await page.evaluate(() => (window as any).flowloom.run.result.names);
  expect(names).toEqual(expect.arrayContaining(["S", "I", "R"]));
});

test("a shared URL hash reconstructs the exact model", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  // author a distinctive model, then copy the share link
  await page.locator("#src").fill("stock Widget = 3\nparam g = 1\nd(Widget) = g\nsim to=5");
  await page.locator("#run").click();
  await page.locator("#share").click();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  expect(url).toContain("#m=");

  // open the link in a fresh page — the model must come back verbatim
  const fresh = await context.newPage();
  await fresh.goto(url);
  await fresh.waitForFunction(() => (window as any).flowloom?.run?.ok === true);
  await expect(fresh.locator("#src")).toHaveValue(/stock Widget = 3/);
  await fresh.close();
});

test("editing the model writes it into the URL hash", async ({ page }) => {
  await page.locator("#src").fill("stock Z = 9\nd(Z) = 0\nsim to=3");
  await page.locator("#run").click();
  await expect.poll(() => page.evaluate(() => location.hash.startsWith("#m="))).toBe(true);
});

test("table tab shows sampled series with the playback cursor", async ({ page }) => {
  await page.getByRole("button", { name: "Table" }).click();
  await expect(page.locator("#tableWrap table")).toBeVisible();
  // drive the clock via the store (the transport lives in the hidden Plot view)
  await page.evaluate(() => (window as any).flowloom.setFrame(0));
  await expect(page.locator("#tableWrap tr.cursor")).toHaveCount(1);
});
