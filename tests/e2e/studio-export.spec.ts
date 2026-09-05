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

test("the y axis can be log-scaled", async ({ page }) => {
  // A model spanning four orders of magnitude — unreadable on one linear axis.
  await page.evaluate(() => (window as any).flowloom.build(
    "stock Small = 0.01\nstock Big = 1000\nchange(Small) = 0.02 * Small\nchange(Big) = 0.02 * Big\nsim dt=0.5 to=60 method=rk4\nplot Small Big",
  ));
  await expect(page.evaluate(() => (window as any).flowloom.logY)).resolves.toBe(false);
  await page.locator("#logY").check();
  await expect(page.evaluate(() => (window as any).flowloom.logY)).resolves.toBe(true);
  // it survives a rebuild, being view state like the visible set
  await page.evaluate(() => (window as any).flowloom.build((window as any).flowloom.source + "\n# edited"));
  await expect(page.evaluate(() => (window as any).flowloom.logY)).resolves.toBe(true);
});

test("a phase portrait plots one series against another", async ({ page }) => {
  await page.evaluate(() => (window as any).flowloom.build(
    ["stock Prey = 100", "stock Pred = 20",
     "change(Prey) = 0.6 * Prey - 0.02 * Prey * Pred",
     "change(Pred) = 0.01 * Prey * Pred - 0.5 * Pred",
     "sim dt=0.02 to=40 method=rk4", "plot Prey Pred"].join("\n"),
  ));
  await page.locator("#phaseX").selectOption("Prey");
  await page.locator("#phaseY").selectOption("Pred");
  await expect(page.evaluate(() => (window as any).flowloom.phase)).resolves.toEqual({ x: "Prey", y: "Pred" });

  // an edit that removes the series drops back to the time plot rather than
  // drawing nothing
  await page.evaluate(() => (window as any).flowloom.build(
    "stock Cash = 0\nchange(Cash) = 1\nsim dt=1 to=10 method=euler",
  ));
  await expect(page.evaluate(() => (window as any).flowloom.phase)).resolves.toBeNull();
  await expect(page.locator("#phaseX")).toHaveValue("");
});

test("the working text is autosaved and survives a reload", async ({ page }) => {
  const edited = "# my own model\nstock Widgets = 7\nchange(Widgets) = 3\nsim dt=1 to=5 method=euler";
  await page.evaluate((t) => (window as any).flowloom.build(t), edited);
  await page.locator("#src").fill(edited);
  await page.locator("#src").blur();
  await page.waitForFunction(() => localStorage.getItem("flowloom.autosave")?.includes("Widgets"));

  // A real reload: changing only the fragment navigates within the same
  // document, which would leave the editor as it already is and prove nothing.
  await page.goto("/?reload=1");
  await page.waitForFunction(() => (window as any).flowloom?.run?.ok === true);
  await expect(page.locator("#src")).toHaveValue(/stock Widgets = 7/);
});

test("a shared link still wins over the autosave", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("flowloom.autosave", "stock Autosaved = 1\nchange(Autosaved) = 0\nsim dt=1 to=2"));
  const shared = "stock Shared = 42\nchange(Shared) = 0\nsim dt=1 to=2 method=euler";
  const hash = await page.evaluate((t) => "#m=" + btoa(String.fromCharCode(...new TextEncoder().encode(t))), shared);
  await page.goto(`/?reload=1${hash}`);
  await page.waitForFunction(() => (window as any).flowloom?.run?.ok === true);
  // a link is a request for *that* model, not for what this browser was doing
  await expect(page.locator("#src")).toHaveValue(/stock Shared = 42/);
});

test("opening a different model records the one you left", async ({ page }) => {
  // Start clean: with an autosave present the app opens *that* rather than the
  // default example, and "a different example" would not be different.
  await page.evaluate(() => { localStorage.removeItem("flowloom.recents"); localStorage.removeItem("flowloom.autosave"); });
  await page.goto("/?reload=1");
  await page.waitForFunction(() => (window as any).flowloom?.run?.ok === true);
  const first = await page.locator("#src").inputValue();

  // switch examples: the list gains the model we left and the one we opened
  const current = await page.locator("#example").inputValue();
  const options = await page.locator("#example option").allTextContents();
  const other = options.find((o) => o && o !== current)!;
  await page.locator("#example").selectOption({ label: other });
  await page.waitForFunction((t) => (document.querySelector("#src") as HTMLTextAreaElement).value !== t, first);

  const recents = await page.evaluate(() => JSON.parse(localStorage.getItem("flowloom.recents") ?? "[]"));
  expect(recents.length).toBeGreaterThanOrEqual(2);
  expect(recents[0].source).toBe((await page.locator("#src").inputValue()).trim());
  // and the picker offers them
  await expect(page.locator("#recent option")).not.toHaveCount(0);
});
