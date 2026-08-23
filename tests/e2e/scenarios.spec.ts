import { test, expect } from "@playwright/test";

// Switches, scenarios, the scenarios table, rung-grouped knobs, and the loops
// tab's inactive section — driven through the real studio. The text stays
// canonical: every knob move must show up in #src.

const MODEL = `stock Cash = 1000
param pay = 500            # @rung 12
switch save = off          # @rung 10 pay savings first
const yearLen = 12
param target = 2000        # @rung 3
aux spend = if(save, 300, 450) + if(t % yearLen == 11, 100, 0)
flow net = pay - spend
change(Cash) = net
scenario thrifty save=on
scenario rich pay=900 Cash=2000 save=on
sim dt=1 to=24 method=euler
plot Cash`;

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).flowloom?.run?.ok === true);
  const skip = page.locator(".tour-overlay .tour-skip");
  if (await skip.count()) await skip.click();
  await page.locator("#src").fill(MODEL);
  await page.locator("#run").click();
  await page.waitForFunction(() => (window as any).flowloom.run.ok === true && (window as any).flowloom.run.model.scenarios.size === 2);
});

test("the scenario picker lists the model's scenarios and overlays base when one is chosen", async ({ page }) => {
  const sel = page.locator("#scenarioSel");
  await expect(page.locator("#scenarioWrap")).toBeVisible();
  await expect(sel.locator("option")).toHaveText(["base", "thrifty", "rich"]);

  await sel.selectOption("rich");
  await page.waitForFunction(() => (window as any).flowloom.scenario === "rich");
  const final = await page.evaluate(() => (window as any).flowloom.run.result.series.get("Cash").at(-1));
  expect(final).toBeGreaterThan(2000 + 24 * 500); // pay 900, spend 300
  await expect.poll(() => page.evaluate(() => (window as any).flowloom.overlay.compare?.label)).toBe("base");
  await expect(page.locator("#ovMsg")).toContainText("dashed: base (scenario rich)");

  // the text is untouched by picking a scenario — it is view state
  await expect(page.locator("#src")).toHaveValue(/^switch save = off/m);

  await sel.selectOption("base");
  await expect.poll(() => page.evaluate(() => (window as any).flowloom.overlay.compare ?? null)).toBeNull();
});

test("a switch is a toggle in Tune and writes on/off into the text", async ({ page }) => {
  const toggle = page.locator('#tuneWrap input[data-tune="save"][data-sw]');
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(page.locator("#src")).toHaveValue(/^switch save = on\s+# @rung 10 pay savings first/m);
  await expect(page.locator('#tuneWrap [data-tuneval="save"]')).toHaveText("on");
  // a const gets no slider; knobs are grouped under their rung, untagged last
  await expect(page.locator('#tuneWrap input[data-tune="yearLen"]')).toHaveCount(0);
  await expect(page.locator("#tuneWrap .tune-rung")).toHaveText(["12 · constants, parameters, numbers", "10 · stock-and-flow structure", "3 · goals"]);
});

test("under an active scenario, a knob the scenario binds edits the scenario line", async ({ page }) => {
  await page.locator("#scenarioSel").selectOption("rich");
  await page.waitForFunction(() => (window as any).flowloom.scenario === "rich");
  await expect(page.locator(".tune-hint")).toContainText("scenario rich is active");
  // save is bound by `rich` (on) — flipping it off edits the scenario, not the switch line
  const toggle = page.locator('#tuneWrap input[data-tune="save"][data-sw]');
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(page.locator("#src")).toHaveValue(/^scenario rich pay=900 Cash=2000 save=off/m);
  await expect(page.locator("#src")).toHaveValue(/^switch save = off/m);
});

test("the scenarios table tabulates base vs every scenario on the visible series", async ({ page }) => {
  await page.locator("#scTableBtn").click();
  const table = page.locator("#scTable table");
  await expect(table).toBeVisible();
  await expect(table.locator("tr td.name")).toHaveText(["base", "thrifty", "rich"]);
  await expect(table.locator("th.ser")).toHaveText(["Cash"]);
  // the rich row shows a positive delta on final Cash
  await expect(table.locator("tr", { hasText: "rich" }).locator(".d.up").first()).toBeVisible();
});

test("the loops tab reads polarity along the run and folds never-engaging loops away", async ({ page }) => {
  await page.locator("#src").fill(`stock S = 1
switch brake = off
flow g = 0.1 * S
flow b = if(brake, 0.2 * S, 0)
d(S) = g - b
sim dt=1 to=10 method=euler`);
  await page.locator("#run").click();
  await page.waitForFunction(() => (window as any).flowloom.run.ok === true && (window as any).flowloom.run.loops?.loops.length === 2);
  await page.locator('.tabs [data-tab="loops"]').click();
  await expect(page.locator("#loopsWrap .loop:not(.inactive)")).toHaveCount(1);
  await expect(page.locator("#loopsWrap .deadloops .loop.inactive")).toHaveCount(1);
  await expect(page.locator("#loopsWrap .deadloops summary")).toContainText("never engages in this run");
  await expect(page.locator("#loopsWrap .loopcount")).toContainText("1 inactive");
});

test("method=map is in the toolbar picker and steps stock += change with no dt factor", async ({ page }) => {
  await page.locator("#src").fill(`stock S = 100
flow inc = 30
change(S) = inc
sim dt=0.5 to=2 method=rk4`);
  await page.locator("#run").click();
  await page.waitForFunction(() => (window as any).flowloom.run.ok === true);
  await page.locator("#method").selectOption("map");
  await expect(page.locator("#src")).toHaveValue(/method=map/);
  await page.waitForFunction(() => (window as any).flowloom.run.ok === true && (window as any).flowloom.run.model.settings.method === "map");
  expect(await page.evaluate(() => (window as any).flowloom.run.result.series.get("S").at(-1))).toBe(220); // 4 steps × 30, no dt factor
  await expect(page.locator("#method")).toHaveValue("map");
});

test("a links-only sketch draws, has loops, and shows a note instead of a run", async ({ page }) => {
  await page.locator("#src").fill(`link population -> births +
link births -> population +
link population -> deaths +
link deaths -> population -`);
  await page.locator("#run").click();
  await page.waitForFunction(() => (window as any).flowloom.run.ok === true && (window as any).flowloom.run.loops?.loops.length === 2);
  await expect(page.locator("#err")).toContainText("qualitative sketch"); // a note, not an error
  await page.locator('.tabs [data-tab="loops"]').click();
  await expect(page.locator("#loopsWrap .loopcount")).toContainText("signs as declared");
  await expect(page.locator("#loopsWrap .loop .badge")).toHaveText(["R", "B"]);
  await page.locator('.tabs [data-tab="diagram"]').click();
  await expect(page.locator('#diagram [data-name="population"]')).toBeVisible();
  await expect(page.locator('#diagram [data-name="deaths"]')).toBeVisible();
});
