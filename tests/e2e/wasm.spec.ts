import { test, expect } from "@playwright/test";

// Large models are simulated off the main thread (worker + WASM backend). This
// drives that whole path in a real browser and confirms a correct result lands.

test.beforeEach(async ({ page }) => {
  // suppress the first-run tour so its centered modal can't intercept clicks
  await page.addInitScript(() => localStorage.setItem("flowloom.toured", "1"));
  await page.goto("/");
  await page.waitForFunction(() => (window as any).flowloom?.run?.ok === true);
});

function largeModel(n: number): string {
  const L: string[] = [];
  for (let i = 0; i < n; i++) L.push(`stock S${i} = ${10 + (i % 5)}`);
  L.push("param k = 0.05");
  for (let i = 0; i < n; i++) {
    L.push(`flow f${i} = k * (S${(i + 1) % n} - S${i})`);
    L.push(`d(S${i}) = f${i}`);
  }
  // n=400, steps=5000 ⇒ 2M state-derivs ⇒ over the worker/WASM threshold
  L.push("sim dt=0.1 to=500 method=rk4");
  L.push("plot S0 S1 S2");
  return L.join("\n");
}

test("a large model simulates in the worker and returns a result", async ({ page }) => {
  const src = largeModel(400);
  await page.evaluate((text) => {
    const ta = document.querySelector("#src") as HTMLTextAreaElement;
    ta.value = text;
  }, src);
  await page.locator("#run").click();

  // it should hand off to the worker (computing flag set, busy banner shown)
  await page.waitForFunction(() => (window as any).flowloom.computing === true, { timeout: 5000 });
  await expect(page.locator("#busy")).toBeVisible();

  // …and then deliver a finished run, clearing the busy state
  await page.waitForFunction(
    () => {
      const s = (window as any).flowloom;
      return s.computing === false && s.run.result && s.run.result.t.length > 100;
    },
    { timeout: 20000 },
  );
  await expect(page.locator("#busy")).toBeHidden();

  const info = await page.evaluate(() => {
    const r = (window as any).flowloom.run.result;
    return { steps: r.t.length, nseries: r.names.length, s0: r.series.get("S0").at(-1) };
  });
  expect(info.steps).toBe(5001);
  expect(info.nseries).toBeGreaterThan(400);
  expect(Number.isFinite(info.s0)).toBe(true);
});
