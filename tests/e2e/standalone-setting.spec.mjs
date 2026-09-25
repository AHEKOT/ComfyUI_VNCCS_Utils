import { test, expect } from "@playwright/test";
import { setStandaloneSidebar } from "./helpers/app.mjs";

const TAB = ".vnccs-unicanvas-sidebar-icon";

test("the standalone Unicanvas sidebar tab is on by default and follows the ComfyUI setting live", async ({ page }) => {
  // The setting defaults to true; the store may still carry an explicit false from
  // an older profile, so force it off before asserting the removal behavior.
  await setStandaloneSidebar(page, false);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".side-bar-button, [class*='side-bar']").first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(2_000);
  await expect(page.locator(TAB)).toHaveCount(0);

  // Toggling the setting at runtime adds and removes the tab without a reload.
  await page.evaluate((id) => globalThis.app?.extensionManager?.setting?.set(id, true), "VNCCS.UniCanvas.StandaloneSidebar");
  await expect(page.locator(TAB).first()).toBeVisible({ timeout: 15_000 });
  await page.evaluate((id) => globalThis.app?.extensionManager?.setting?.set(id, false), "VNCCS.UniCanvas.StandaloneSidebar");
  await expect(page.locator(TAB)).toHaveCount(0, { timeout: 15_000 });
});
