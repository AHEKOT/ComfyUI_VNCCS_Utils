import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { importImageLayer, openPoseTool, openUnicanvas, poseLayer } from "./helpers/app.mjs";
import { measureAlphaBBoxInPage } from "./helpers/measure.mjs";

const BACKDROP_IMAGE = fileURLToPath(new URL("./fixtures/backdrop.png", import.meta.url));
const probe = (page) => page.evaluate(() => globalThis.__VNCCS_UC_E2E__.getPoseBackdrop());

async function layerAlphaBBox(page, id) {
  const pixels = await page.evaluate((layerId) => globalThis.__VNCCS_UC_E2E__.getLayerPixels(layerId), id);
  return { ...(await measureAlphaBBoxInPage(page, pixels.dataURL)), width: pixels.width, height: pixels.height };
}

// The pose layer is a 2D image over the layers below: the editor shows only the mannequin, the
// layers below act as a flat backdrop and the mannequin can never sink behind it.
test("pose editor: mannequin only over a flat backdrop it cannot sink behind", async ({ page }) => {
  await openUnicanvas(page);
  await importImageLayer(page, BACKDROP_IMAGE);
  await openPoseTool(page);

  const rest = await probe(page);
  expect(rest.characters.length).toBeGreaterThan(0);
  for (const character of rest.characters) expect(character.farEdge).toBeLessThanOrEqual(rest.distance + 1e-6);

  // No skydome sphere even when Pose Studio's own option asks for one: the layer pixels keep
  // transparent surroundings, so the image below stays visible around the mannequin.
  await page.locator(".vnccs-uc-pose-tabs button", { hasText: "Scene" }).click();
  const skydome = page.locator(".vnccs-uc-pose-side label", { hasText: "Directional Skydome" }).locator('input[type="checkbox"]');
  if (await skydome.count()) await skydome.first().check({ force: true });
  const pose = await poseLayer(page);
  await expect
    .poll(async () => {
      const bbox = await layerAlphaBBox(page, pose.id);
      return bbox.area > 0 && bbox.area < bbox.width * bbox.height * 0.6;
    }, { timeout: 20_000 })
    .toBe(true);

  // Pose Studio Zoom scales the character; the backdrop moves back with it (no forced push).
  await page.locator(".vnccs-uc-pose-tabs button", { hasText: "Body" }).click();
  const zoomed = await page.evaluate(() => {
    const labels = [...document.querySelectorAll(".vnccs-uc-pose-side *")].filter(
      (el) => el.childElementCount === 0 && /^\s*zoom\s*$/i.test(el.textContent || ""),
    );
    for (const label of labels) {
      let node = label.parentElement;
      for (let depth = 0; node && depth < 3; depth += 1, node = node.parentElement) {
        const range = node.querySelector('input[type="range"]');
        if (!range) continue;
        range.value = "3";
        range.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      }
    }
    return false;
  });
  expect(zoomed).toBe(true);
  await expect.poll(async () => (await probe(page)).distance, { timeout: 10_000 }).toBeGreaterThan(rest.distance);
  const after = await probe(page);
  for (const character of after.characters) expect(character.farEdge).toBeLessThanOrEqual(after.distance + 1e-6);
});
