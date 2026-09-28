import { test, expect } from "@playwright/test";
import { openUnicanvas, openPoseTool, poseLayer } from "./helpers/app.mjs";

const SHELL = ".vnccs-uc2-standalone-shell";

async function sidebarState(page) {
  return page.evaluate((shell) => {
    const root = document.querySelector(`${shell} .vnccs-unicanvas`);
    return {
      editing: root.classList.contains("vnccs-uc-pose-editing"),
      layersVisible: Boolean(root.querySelector(".vnccs-uc-layers-section")?.offsetParent),
      poseSideVisible: Boolean(root.querySelector(".vnccs-uc-pose-side")?.offsetParent),
      characterInSidebar: Boolean(root.querySelector(".vnccs-uc-side .vnccs-uc-pose-character")?.offsetParent),
    };
  }, SHELL);
}

// Pose layers are edited in an explicit session: entering it swaps the right sidebar for the
// Pose Studio settings, leaving it brings the layers back; outside the session the pose layer
// moves with the Move tool, a right click on its layer row opens its layer menu and a right
// click on the canvas does not.
test("pose layers: explicit edit session, move outside it, layer-row right-click menu", async ({ page }) => {
  await openUnicanvas(page);
  await openPoseTool(page);
  expect(await sidebarState(page)).toEqual({ editing: true, layersVisible: false, poseSideVisible: true, characterInSidebar: true });

  await page.locator(".vnccs-uc-pose-editbar button", { hasText: "Save pose" }).click();
  expect(await sidebarState(page)).toMatchObject({ editing: false, layersVisible: true, poseSideVisible: false });
  const pose = await poseLayer(page);
  const rect = () => page.evaluate((id) => globalThis.__VNCCS_UC_E2E__.getLayerPose(id).rect, pose.id);

  const stage = await page.locator(`${SHELL} .vnccs-uc-stage-wrap canvas`).first().boundingBox();
  const cx = stage.x + stage.width / 2, cy = stage.y + stage.height / 2;

  // Right click (no drag) over the mannequin on the canvas: no layer menu.
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  const menu = page.locator(".vnccs-uc-layer-menu");
  await expect(menu).toBeHidden();

  // Right click on the pose layer's row: the layer menu, with Edit pose.
  await page.locator(`${SHELL} .vnccs-uc-layer[data-layer-id="${pose.id}"]`).click({ button: "right" });
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Edit pose");
  await expect(menu).toContainText("Rasterize");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  // Move tool drags the posed layer without entering the editor.
  await page.locator('.vnccs-uc-tools [data-tool="move"]').click();
  const before = await rect();
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy + 30, { steps: 6 });
  await page.mouse.up();
  const moved = await rect();
  expect(moved.x).toBeGreaterThan(before.x + 20);
  expect(moved.y).toBeGreaterThan(before.y + 10);
  expect((await sidebarState(page)).editing).toBe(false);

  // Double-click enters the editor again; Cancel leaves it and keeps the moved placement.
  await page.mouse.dblclick(cx + 60, cy + 30);
  await expect.poll(async () => (await sidebarState(page)).editing, { timeout: 30_000 }).toBe(true);
  await page.locator(".vnccs-uc-pose-editbar button", { hasText: "Cancel" }).click();
  expect(await sidebarState(page)).toMatchObject({ editing: false, layersVisible: true });
  expect(await rect()).toEqual(moved);
});

// Navigation inside the edit session is inspection-only: the framing stays pinned to the wall.
test("pose editor: orbit and wheel inspect without rewriting the framing", async ({ page }) => {
  await openUnicanvas(page);
  await openPoseTool(page);
  const pose = await poseLayer(page);
  const before = await page.evaluate((id) => globalThis.__VNCCS_UC_E2E__.getLayerPose(id), pose.id);
  expect(before.viewport).toBeTruthy();

  const stage = await page.locator(`${SHELL} .vnccs-uc-stage-wrap canvas`).first().boundingBox();
  const cx = stage.x + stage.width / 2, cy = stage.y + stage.height / 2;

  await page.mouse.move(cx, cy);
  for (let tick = 0; tick < 3; tick += 1) await page.mouse.wheel(0, -120);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(cx - 90, cy - 24, { steps: 6 });
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(600);

  const after = await page.evaluate((id) => globalThis.__VNCCS_UC_E2E__.getLayerPose(id), pose.id);
  expect(after.viewport).toEqual(before.viewport);

  // The hand popover mounts into the visible embedded viewport (which hosts the canvas),
  // not the hidden Pose Studio center panel, so hands stay editable in UniCanvas.
  const popover = await page.evaluate(() => {
    const element = document.querySelector(".vnccs-uc-pose-root .vnccs-ps-hand-popover");
    const wrap = element?.parentElement;
    return wrap ? { hostsCanvas: Boolean(wrap.querySelector("canvas")), visible: !wrap.hidden && wrap.offsetParent !== null } : null;
  });
  expect(popover).toEqual({ hostsCanvas: true, visible: true });
});
