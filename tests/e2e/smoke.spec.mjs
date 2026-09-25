import { test, expect } from "@playwright/test";
import { openUnicanvas, openPoseTool, poseLayer } from "./helpers/app.mjs";
import { measureAlphaBBoxInPage } from "./helpers/measure.mjs";

test("standalone Unicanvas: the Pose Studio tool creates a live pose layer that really renders", async ({ page }) => {
  await openUnicanvas(page);
  await openPoseTool(page);
  const pose = await poseLayer(page);
  expect(pose).toBeTruthy();
  await expect
    .poll(async () => {
      const pixels = await page.evaluate((id) => globalThis.__VNCCS_UC_E2E__.getLayerPixels(id), pose.id);
      return (await measureAlphaBBoxInPage(page, pixels.dataURL)).area;
    }, { timeout: 30_000 })
    .toBeGreaterThan(0); // the mannequin really rendered into the layer
  expect(await page.evaluate((id) => globalThis.__VNCCS_UC_E2E__.getLayerPose(id), pose.id)).toMatchObject({
    version: 1,
    // Activation seeds the persisted capture framing the pixels are rendered with.
    viewport: { position: expect.any(Array), target: expect.any(Array) },
  });
});
