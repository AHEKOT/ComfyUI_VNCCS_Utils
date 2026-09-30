import { test, expect } from "@playwright/test";
import { openUnicanvas } from "./helpers/app.mjs";

// The prompt "?" shows the active model family's own guide, served by the backend
// (/vnccs/unicanvas/assets model_modules), and follows a family switch live.
async function chooseSetting(page, setting, value) {
  await page.evaluate(([key, next]) => {
    const select = document.querySelector(`.vnccs-uc2-standalone-shell select[data-setting="${key}"]`);
    select.value = next;
    select.dispatchEvent(new Event("input", { bubbles: true }));
  }, [setting, value]);
}

// A selected preset and the Checkpoint loader both pin the family (SDXL), so a user picks
// Custom, then the Diffusion Model loader, then the Mode.
async function selectFamily(page, mode) {
  await page.locator('.vnccs-uc2-standalone-shell [data-model-selection-mode="custom"]').first().click();
  await chooseSetting(page, "model_loader", "diffusion_model");
  await chooseSetting(page, "generation_mode", mode);
}

test("the prompt '?' shows the active model family's prompt guide and follows the family live", async ({ page }) => {
  await openUnicanvas(page);
  const shell = page.locator(".vnccs-uc2-standalone-shell");
  const help = shell.locator("[data-prompt-help]").first();
  const prompt = shell.locator('textarea[data-setting="positive"]').first();
  const panel = shell.locator("[data-prompt-guide]").first();
  await expect(help).toBeVisible({ timeout: 30_000 });
  await expect(panel).toBeHidden();

  await selectFamily(page, "qwen_image21");
  // The placeholder is the family's one-line hint.
  await expect(prompt).toHaveAttribute("placeholder", /double quotes/);
  await help.click();
  await expect(panel).toBeVisible();
  await expect(help).toHaveAttribute("aria-expanded", "true");
  await expect(panel).toContainText("Qwen Image 2.1 - how to prompt");
  await expect(panel).toContainText("<image1> is the working area");
  await expect(panel).toContainText("kjranyone/qwen-image-2.1-prompt-guide");

  // Switching the family while the panel is open re-renders it immediately.
  await selectFamily(page, "krea2_edit");
  await expect(panel).toContainText("Krea2 Edit - how to prompt");
  await expect(panel).toContainText("does not use the negative prompt");
  await expect(prompt).toHaveAttribute("placeholder", /recolor the car/i);

  await help.click();
  await expect(panel).toBeHidden();
  await expect(help).toHaveAttribute("aria-expanded", "false");
});
