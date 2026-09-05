import { test, expect } from "@playwright/test";

// E2E for the parts of the studio that let work *leave* it, plus the shell
// behaviours the appendix found missing entirely: exporting results and
// pictures, cancelling a run, keyboard-navigable tabs, and a layout that
// survives a phone.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).flowloom?.run?.ok === true);
});

test("CSV export downloads the visible series, time first", async ({ page }) => {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#csvBtn").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.csv$/);
  const stream = await download.createReadStream();
  const text = await new Promise<string>((resolve, reject) => {
    let buf = "";
    stream.on("data", (c: Buffer) => { buf += c.toString(); });
    stream.on("end", () => resolve(buf));
    stream.on("error", reject);
  });
  const [header, first] = text.split("\n");
  expect(header!.split(",")[0]).toBe("t");
  // the columns are the visible series, and there is a row per recorded step
  const visible = await page.evaluate(() => [...(window as any).flowloom.visible]);
  for (const name of visible) expect(header!.split(",")).toContain(name);
  expect(first!.split(",").length).toBe(header!.split(",").length);
  expect(text.trim().split("\n").length).toBeGreaterThan(2);
});

test("PNG export saves the plot as drawn", async ({ page }) => {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#pngBtn").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/-plot\.png$/);
});

test("SVG export saves a standalone diagram with its background", async ({ page }) => {
  await page.getByRole("tab", { name: "Diagram" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator('[data-cv="svg"]').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/-diagram\.svg$/);
  const stream = await download.createReadStream();
  const svg = await new Promise<string>((resolve, reject) => {
    let buf = "";
    stream.on("data", (c: Buffer) => { buf += c.toString(); });
    stream.on("end", () => resolve(buf));
    stream.on("error", reject);
  });
  expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  // the page background travels with it, or the file opens dark-on-dark
  expect(svg).toMatch(/style="background: /);
  expect(svg).toMatch(/<(rect|circle|path|text)/);
});

test("tabs are a keyboard-navigable tablist", async ({ page }) => {
  const plot = page.getByRole("tab", { name: "Plot" });
  await expect(plot).toHaveAttribute("aria-selected", "true");
  await plot.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Diagram" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Diagram" })).toBeVisible();
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Format" })).toHaveAttribute("aria-selected", "true");
  // a tablist is one tab stop: only the selected tab is reachable by Tab
  const focusable = await page.evaluate(() =>
    [...document.querySelectorAll('.tabs button')].filter((b) => (b as HTMLElement).tabIndex === 0).length);
  expect(focusable).toBe(1);
});

test("the layout stacks rather than crushing the right pane on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 750 });
  const cols = await page.evaluate(() => getComputedStyle(document.querySelector("main")!).gridTemplateColumns);
  expect(cols.split(" ").length).toBe(1);            // one column, stacked
  const right = await page.locator("section.right").boundingBox();
  expect(right!.width).toBeGreaterThan(300);         // not the old ~35px sliver
});

test("a run in a worker can be cancelled", async ({ page }) => {
  // A model big enough to go to the worker, long enough to still be running.
  await page.evaluate(() => {
    const n = 400;
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
      lines.push(`stock S${i} = ${i === 0 ? 100 : 0}`);
      lines.push(`change(S${i}) = ${i === 0 ? `-0.5 * S0` : `0.5 * S${i - 1} - 0.5 * S${i}`}`);
    }
    lines.push("sim dt=0.001 to=400 method=rk4");
    (window as any).flowloom.build(lines.join("\n"));
  });
  await expect(page.locator("#busy")).toBeVisible();
  await expect(page.evaluate(() => (window as any).flowloom.cancellable)).resolves.toBe(true);
  await page.locator("#cancelRun").click();
  await expect(page.locator("#busy")).toBeHidden();
  await expect(page.evaluate(() => (window as any).flowloom.cancellable)).resolves.toBe(false);
  await expect(page.evaluate(() => (window as any).flowloom.run.note)).resolves.toMatch(/cancelled/);
});
