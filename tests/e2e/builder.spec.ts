import { test, expect } from "@playwright/test";

// Visual builder: editing the model by clicking the diagram must rewrite the
// canonical text (the #src textarea), never hold separate state.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).flowloom?.run?.ok === true);
  const skip = page.locator(".tour-overlay .tour-skip");
  if (await skip.count()) await skip.click();
  await page.locator('.tabs [data-tab="diagram"]').click();
  await page.locator('.canvas-ctrls [data-cv="edit"]').click();
  await expect(page.locator("#buildBar")).toBeVisible();
});

test("add a stock and edit it via the inline popover", async ({ page }) => {
  await page.locator('#buildBar [data-bt="stock"]').click();
  await expect(page.locator("#buildPop")).toBeVisible();

  await page.locator("#buildPop .bp-name").fill("Reservoir");
  await page.locator("#buildPop .bp-eq").fill("100");
  await page.locator("#buildPop .bp-save").click();

  await expect(page.locator("#src")).toHaveValue(/stock Reservoir = 100/);
  await expect(page.locator("#buildPop")).toBeHidden();
});

test("wire a flow into a stock by clicking two nodes", async ({ page }) => {
  // a stock to receive the flow
  await page.locator('#buildBar [data-bt="stock"]').click();
  await page.locator("#buildPop .bp-name").fill("Tank");
  await page.locator("#buildPop .bp-eq").fill("50");
  await page.locator("#buildPop .bp-save").click();
  await expect(page.locator("#src")).toHaveValue(/stock Tank = 50/);

  // a flow to wire in
  await page.locator('#buildBar [data-bt="flow"]').click();
  await page.locator("#buildPop .bp-name").fill("inflow");
  await page.locator("#buildPop .bp-eq").fill("5");
  await page.locator("#buildPop .bp-save").click();
  await expect(page.locator("#src")).toHaveValue(/flow inflow = 5/);

  // Connect tool: click the flow, then the target stock
  await page.locator('#buildBar [data-tool="connect"]').click();
  await page.locator('#diagram [data-name="inflow"]').click();
  await expect(page.locator("#buildHint")).toContainText("Wiring inflow");
  await page.locator('#diagram [data-name="Tank"]').click();

  await expect(page.locator("#src")).toHaveValue(/change\(Tank\) = inflow/);
});

test("pipe between two stocks creates a draining/filling flow", async ({ page }) => {
  await page.locator('#buildBar [data-bt="stock"]').click();
  await page.locator("#buildPop .bp-name").fill("Source");
  await page.locator("#buildPop .bp-eq").fill("100");
  await page.locator("#buildPop .bp-save").click();
  await page.locator('#buildBar [data-bt="stock"]').click();
  await page.locator("#buildPop .bp-name").fill("Sink");
  await page.locator("#buildPop .bp-eq").fill("0");
  await page.locator("#buildPop .bp-save").click();

  await page.locator('#buildBar [data-tool="connect"]').click();
  await page.locator('#diagram [data-name="Source"]').click();
  await expect(page.locator("#buildHint")).toContainText("Draining Source");
  await page.locator('#diagram [data-name="Sink"]').click();

  // a new flow drains Source and fills Sink; the popover opens to name its rate
  await expect(page.locator("#buildPop")).toBeVisible();
  await expect(page.locator("#src")).toHaveValue(/change\(Source\) = -flow/);
  await expect(page.locator("#src")).toHaveValue(/change\(Sink\) = flow/);
});

test("a connect sign toggle wires a negative term", async ({ page }) => {
  await page.locator('#buildBar [data-bt="stock"]').click();
  await page.locator("#buildPop .bp-name").fill("Tank");
  await page.locator("#buildPop .bp-eq").fill("50");
  await page.locator("#buildPop .bp-save").click();
  await page.locator('#buildBar [data-bt="flow"]').click();
  await page.locator("#buildPop .bp-name").fill("drain");
  await page.locator("#buildPop .bp-eq").fill("2");
  await page.locator("#buildPop .bp-save").click();

  await page.locator('#buildBar [data-tool="connect"]').click();
  await page.locator("#signToggle").click(); // flip to −
  await page.locator('#diagram [data-name="drain"]').click();
  await page.locator('#diagram [data-name="Tank"]').click();
  await expect(page.locator("#src")).toHaveValue(/change\(Tank\) = -drain/);
});

test("edit mode keeps the canvas when an edit makes the model invalid", async ({ page }) => {
  // delete a referenced symbol so the model errors, then confirm the diagram
  // still shows nodes (last good layout) rather than blanking
  await page.locator('#diagram [data-name="growth"]').click();
  const del = page.locator("#buildPop .bp-del");
  await del.click(); // warns (referenced)
  await del.click(); // remove anyway → change(Population) now references missing growth
  await expect(page.locator("#err.show")).toBeVisible();
  // canvas retained: the Population node is still clickable
  await expect(page.locator('#diagram [data-name="Population"]')).toBeVisible();
});

test("dragging a node persists its position as a # @pos comment", async ({ page }) => {
  const node = page.locator('#diagram [data-name="Population"]');
  const box = await node.boundingBox();
  if (!box) throw new Error("Population node not found");
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  // drag the node well clear of its starting point
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 90, cy + 60, { steps: 8 });
  await page.mouse.up();

  await expect(page.locator("#src")).toHaveValue(/# @pos Population -?\d+ -?\d+/);
  // and the position survives a reload via the shared hash
  await page.reload();
  await page.waitForFunction(() => (window as any).flowloom?.run?.ok === true);
  await expect(page.locator("#src")).toHaveValue(/# @pos Population/);
});

test("delete warns about references before removing", async ({ page }) => {
  // select the growth flow (present in the default Logistic example)
  await page.locator('#diagram [data-name="growth"]').click();
  await expect(page.locator("#buildPop")).toBeVisible();
  const del = page.locator("#buildPop .bp-del");
  await del.click(); // growth is referenced by change(Population) → first click warns
  await expect(page.locator("#bpWarn")).toContainText("Used on line");
  await del.click(); // confirm
  await expect(page.locator("#src")).not.toHaveValue(/flow growth/);
});
