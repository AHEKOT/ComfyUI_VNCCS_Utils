import { test, expect } from "@playwright/test";
import { openUnicanvas } from "./helpers/app.mjs";

// Qwen-Image-2.1 settings live in a closed-by-default accordion: the header line shows
// "QI2.1 (?)" and the turbo switch, the rows (opaque output, 2K aspect preset, LoRA
// assets, Spectrum) stay folded. Turbo on = 6 steps, off = the 45-step base schedule,
// both visible in the sidebar's Steps field. Help "?" tooltips render in a body-level
// layer, so no sidebar scroll container can clip them.

async function chooseSetting(page, setting, value) {
  await page.evaluate(([key, next]) => {
    const select = document.querySelector(`.vnccs-uc2-standalone-shell select[data-setting="${key}"]`);
    select.value = next;
    select.dispatchEvent(new Event("input", { bubbles: true }));
  }, [setting, value]);
}

// A selected preset and the Checkpoint loader both pin the family, so a user picks
// Custom, then the Diffusion Model loader, then the Mode (same path as prompt-guide).
async function selectFamily(page, mode) {
  const shell = page.locator(".vnccs-uc2-standalone-shell");
  await shell.locator('[data-model-selection-mode="custom"]').first().click();
  await chooseSetting(page, "model_loader", "diffusion_model");
  await chooseSetting(page, "generation_mode", mode);
}

test("QI2.1 panel folds into a header with the turbo switch; 6/45 steps; tooltips are not clipped", async ({ page }) => {
  await openUnicanvas(page);
  const shell = page.locator(".vnccs-uc2-standalone-shell");
  await selectFamily(page, "qwen_image21");

  const panel = shell.locator("[data-qwen21-panel]").first();
  await expect(panel).toBeVisible({ timeout: 15_000 });
  const body = panel.locator("[data-qwen21-body]");
  await expect(body).toBeHidden(); // closed by default
  await expect(panel.locator(".vnccs-uc-qwen21-name")).toHaveText("QI2.1");

  // The Seed dice starts active: random draws out of the box, and a canvas saved
  // with the old "fixed" default adopts it too.
  const dice = shell.locator('[data-action="seed-mode"]').first();
  await expect(dice).toHaveAttribute("aria-pressed", "true");
  await expect(dice).toHaveClass(/active/);

  // The turbo switch sits on the header line and is on out of the box.
  const turbo = panel.locator("[data-qwen21-turbo-toggle]");
  await expect(turbo).toBeVisible();
  await expect(turbo).toBeChecked();
  const steps = shell.locator('[data-edit-steps-panel] input[data-setting="steps"]').first();
  await expect(steps).toHaveValue("6");

  // Turbo off -> the base 45-step schedule, immediately visible in the sidebar.
  await turbo.click();
  await expect(turbo).not.toBeChecked();
  await expect(steps).toHaveValue("45");
  await turbo.click();
  await expect(turbo).toBeChecked();
  await expect(steps).toHaveValue("6");

  // The arrow unfolds the details.
  await panel.locator("button[data-qwen21-expand]").click();
  await expect(body).toBeVisible();
  await expect(panel.locator('[data-qwen21-setting="qwen21_opaque_output"]')).toBeVisible();
  await expect(panel.locator('[data-qwen21-setting="qwen21_aspect_preset"]')).toBeVisible();

  // Help tooltips live in the body-level layer and stay inside the viewport.
  await panel.locator(".vnccs-uc-help").first().hover();
  const tip = page.locator("#vnccs-uc-help-tooltip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("Qwen-Image-2.1");
  const box = await tip.boundingBox();
  const viewport = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);

  // Tooltips in the Parameters panel use the same layer (the old CSS tooltip was
  // clipped by the sidebar's scroll container).
  await shell.locator('[data-edit-steps-help]').first().hover();
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("Reference edit");
});
