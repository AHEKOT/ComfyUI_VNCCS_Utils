import { test, expect } from "@playwright/test";
import { openUnicanvas } from "./helpers/app.mjs";

test("settings open as one larger panel anchored under the gear", async ({ page }) => {
  await openUnicanvas(page);
  const gear = page.locator('[title="Settings"]').first();
  const left = page.locator(".vnccs-uc-left");
  await gear.click();
  const panel = page.locator(".vnccs-uc-settings-popover");
  await expect(panel).toHaveCount(1);

  const [gearBox, panelBox, leftBox] = [
    await gear.boundingBox(), await panel.boundingBox(), await left.boundingBox(),
  ];
  expect(panelBox.width).toBe(440); // hard width (item 14), not min/max clamped anymore
  expect(panelBox.height).toBeGreaterThan(0);
  expect(panelBox.height).toBeLessThanOrEqual(560); // height:min(560px, 72vh), host clamp may shrink it further
  expect(panelBox.y).toBeGreaterThanOrEqual(gearBox.y + gearBox.height - 1); // below the gear
  const overlapsLeft = panelBox.x < leftBox.x + leftBox.width && panelBox.x + panelBox.width > leftBox.x;
  expect(overlapsLeft).toBe(false); // never over the left sidebar

  await page.mouse.click(2, 2); // outside click closes
  await expect(panel).toHaveCount(0);
  await gear.click();
  await expect(panel).toHaveCount(1);
  await gear.click(); // second gear click closes
  await expect(panel).toHaveCount(0);
});

test("the settings Close button closes the panel and the gear reopens it", async ({ page }) => {
  await openUnicanvas(page);
  const gear = page.locator('[title="Settings"]').first();
  await gear.click();
  const panel = page.locator(".vnccs-uc-settings-popover");
  await expect(panel).toHaveCount(1);

  await panel.locator('button:has-text("Close")').click();
  await expect(panel).toHaveCount(0);

  await gear.click(); // the closed panel must leave no stale outside-click state behind
  await expect(panel).toHaveCount(1);
});

// Spec 4.4: a settings field commits on change. The custom selects render their
// option menu on document.body, so choosing an option must commit the value AND
// leave the panel open - otherwise every dropdown forces a reopen (and leaves an
// orphan menu floating over the canvas).
test("choosing a custom-select option commits the value and keeps the panel open", async ({ page }) => {
  await openUnicanvas(page);
  await page.locator('[title="Settings"]').first().click();
  const panel = page.locator(".vnccs-uc-settings-popover");
  await expect(panel).toHaveCount(1);

  // The panel also contains rows that are hidden until their field is picked
  // (the edit-model row only shows for the "edit model" backend), so take the
  // first VISIBLE custom select - the background-removal model.
  const select = panel.locator("select.vnccs-uc-select:visible").first();
  await expect(select).toBeVisible();
  const before = await select.inputValue();
  await select.click();
  const menu = page.locator(".vnccs-custom-select-menu");
  await expect(menu).toBeVisible();
  const option = menu.locator('.vnccs-custom-select-option:not([aria-selected="true"]):not([disabled])').first();
  const committed = await option.locator(".vnccs-custom-select-option-label").textContent();
  await option.click();

  // The handler must not treat the menu (a body child) as an outside click.
  await expect(panel).toHaveCount(1);
  await expect(menu).toBeHidden();
  const after = await select.inputValue();
  expect(after, `choosing "${committed}" must commit the new value`).not.toBe(before);
  // The committed value survives a panel toggle: it reached the widget settings.
  await panel.locator('button:has-text("Close")').click();
  await expect(panel).toHaveCount(0);
  await page.locator('[title="Settings"]').first().click();
  await expect(panel.locator("select.vnccs-uc-select:visible").first()).toHaveValue(after);
});

// Spec 4.3: the popover must never land over the left sidebar, not even on a host
// too narrow for the position anchored under the gear. 700/660px viewports really
// used to overlap; 900px documents that a mid-narrow host already clears it.
for (const width of [900, 700, 660]) {
  test(`the settings panel stays off the left sidebar on a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await openUnicanvas(page);
    await page.locator('[title="Settings"]').first().click();
    const panel = page.locator(".vnccs-uc-settings-popover");
    await expect(panel).toHaveCount(1);

    const [panelBox, leftBox] = [await panel.boundingBox(), await page.locator(".vnccs-uc-left").boundingBox()];
    const overlapsLeft = panelBox.x < leftBox.x + leftBox.width && panelBox.x + panelBox.width > leftBox.x;
    expect(overlapsLeft).toBe(false); // never over the left sidebar
  });
}
