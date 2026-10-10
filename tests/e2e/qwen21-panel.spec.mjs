import { test, expect } from "@playwright/test";
import { openUnicanvas } from "./helpers/app.mjs";

// Qwen-Image-2.1 keeps decoded alpha without a transparency switch.
// Turbo LoRA uses the shared card and updates the visible Steps field immediately.

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

test("QI2.1 has no transparency switch; shared Turbo LoRA card uses 6/25 steps", async ({ page }) => {
  await openUnicanvas(page);
  const shell = page.locator(".vnccs-uc2-standalone-shell");
  await selectFamily(page, "qwen_image21");

  await expect(shell.locator("[data-qwen21-panel]")).toHaveCount(0);

  // The Seed dice starts active: random draws out of the box, and a canvas saved
  // with the old "fixed" default adopts it too.
  const dice = shell.locator('[data-action="seed-mode"]').first();
  await expect(dice).toHaveAttribute("aria-pressed", "true");
  await expect(dice).toHaveClass(/active/);

  // The Turbo LoRA is the same card every other family uses; it is on out of the box.
  const turbo = shell.locator('[data-turbo-panel] [data-turbo-toggle="qwen_image21"]');
  await expect(turbo).toBeVisible();
  await expect(turbo).toHaveClass(/selected/);
  const steps = shell.locator('[data-generic-steps] input[data-setting="steps"]').first();
  await expect(steps).toHaveValue("6");

  // Turbo off -> the base 25-step schedule, immediately visible in the sidebar.
  await turbo.click();
  await expect(turbo).not.toHaveClass(/selected/);
  await expect(steps).toHaveValue("25");
  await turbo.click();
  await expect(turbo).toHaveClass(/selected/);
  await expect(steps).toHaveValue("6");

});
