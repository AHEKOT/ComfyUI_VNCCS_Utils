import { test, expect } from "@playwright/test";

// A linked VNCSS Config overrides the UniCanvas model, CLIP, VAE, LoRAs and references:
// those controls are greyed out and inert while the link exists, Mode stays editable.
test("linking a VNCSS Config greys out the UniCanvas controls it overrides", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.app?.graph && window.LiteGraph, null, { timeout: 60_000 });
  for (let i = 0; i < 3; i += 1) await page.keyboard.press("Escape");
  await page.evaluate(() => {
    window.app.graph.clear();
    const config = window.LiteGraph.createNode("VNCCS_Config");
    config.pos = [40, 80];
    window.app.graph.add(config);
    const canvas = window.LiteGraph.createNode("VNCCS_UniCanvas");
    canvas.pos = [420, 40];
    window.app.graph.add(canvas);
    window.__ucConfigTest = { config, canvas };
  });
  const root = page.locator(".vnccs-unicanvas").first();
  await expect(root).toBeVisible({ timeout: 30_000 });
  await expect(root).not.toHaveClass(/vnccs-uc-config-linked/);

  await page.evaluate(() => {
    const { config, canvas } = window.__ucConfigTest;
    config.connectByType(0, canvas, "VNCSS_CONFIG");
  });
  await expect(root).toHaveClass(/vnccs-uc-config-linked/);
  await expect(root.locator("[data-config-banner]")).toBeVisible();
  const state = await root.evaluate((el) => ({
    overridden: [...el.querySelectorAll("[data-config-override]")].every((node) => node.inert),
    mode: el.querySelector('[data-setting="generation_mode"]')?.closest("[inert]") === null,
  }));
  expect(state.overridden).toBe(true);
  expect(state.mode).toBe(true);

  await page.evaluate(() => {
    const { canvas } = window.__ucConfigTest;
    canvas.disconnectInput(canvas.inputs.findIndex((input) => input.name === "config"));
  });
  await expect(root).not.toHaveClass(/vnccs-uc-config-linked/);
  expect(await root.evaluate((el) => [...el.querySelectorAll("[data-config-override]")].some((node) => node.inert))).toBe(false);
});
