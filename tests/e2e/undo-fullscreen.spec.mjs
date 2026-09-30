import { test, expect } from "@playwright/test";

// The reviewer's regression, reproduced exactly: in node mode open fullscreen,
// press "Add mask" (new inpaint layers appear), then press Ctrl+Z without
// changing focus. ComfyUI must NEVER run its graph undo (which reverts the
// workflow and collapses fullscreen); the key belongs to UniCanvas.
//
// The graph is checked through node count and node geometry, and the ComfyUI
// command dispatcher is wrapped so a leaked Comfy.Undo / Comfy.Redo is caught
// even if it happens to be a no-op visually.

async function bootGraphWithUniCanvas(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.app?.graph && window.LiteGraph, null, { timeout: 60_000 });
  for (let i = 0; i < 3; i += 1) await page.keyboard.press("Escape");
  await page.evaluate(() => {
    window.__ucUndoLeaks = [];
    const commandStore = window.app.extensionManager.command;
    const originalExecute = commandStore.execute;
    commandStore.execute = function (commandId, ...rest) {
      const id = String(commandId || "");
      if (id === "Comfy.Undo" || id === "Comfy.Redo") window.__ucUndoLeaks.push(id);
      return originalExecute.call(this, commandId, ...rest);
    };
    window.app.graph.clear();
    const node = window.LiteGraph.createNode("VNCCS_UniCanvas");
    node.pos = [120, 60];
    window.app.graph.add(node);
    // Zoom out and park the widget in the upper-left area of the canvas: the
    // system-monitor overlay sits over the top-right and would swallow the
    // clicks aimed at the widget chrome.
    const canvas = window.app.canvas;
    canvas.ds.scale = 0.5;
    canvas.ds.offset = [80, 240];
    canvas.setDirty?.(true, true);
    window.__ucUndoTest = { node };
  });
  await expect(page.locator(".vnccs-unicanvas").first()).toBeVisible({ timeout: 30_000 });
}

async function graphFingerprint(page) {
  return page.evaluate(() => {
    const graph = window.app.graph;
    return {
      count: graph._nodes.length,
      nodes: graph._nodes.map((node) => ({
        id: node.id,
        type: node.type,
        pos: [Math.round(node.pos[0]), Math.round(node.pos[1])],
        size: [Math.round(node.size[0]), Math.round(node.size[1])],
      })),
    };
  });
}

async function openFullscreen(page) {
  const root = page.locator(".vnccs-unicanvas").first();
  await root.locator(".vnccs-uc2-fullscreen-btn").click();
  await expect(page.locator(".vnccs-uc2-fullscreen-portal")).toBeVisible({ timeout: 15_000 });
}

const portalLayers = (page) => page.locator(".vnccs-uc2-fullscreen-portal .vnccs-uc-layer");

test("Ctrl+Z in node fullscreen undoes UniCanvas masks and never touches the graph", async ({ page }) => {
  await bootGraphWithUniCanvas(page);
  expect(await page.evaluate(() => window.app.extensionManager.command._vnccsGate === true)).toBe(true);

  const graphBefore = await graphFingerprint(page);
  await openFullscreen(page);

  // The reviewer's steps: add inpaint (mask) layers with real clicks; the focus
  // stays on the "Add mask" button, exactly like a user's mouse flow.
  const addMask = page.locator('.vnccs-uc2-fullscreen-portal button[title="Add mask"]');
  const before = await portalLayers(page).count();
  await addMask.click();
  await addMask.click();
  await expect(portalLayers(page)).toHaveCount(before + 2);

  // Ctrl+Z WITHOUT changing focus: the trusted key must be consumed by UniCanvas.
  await page.keyboard.press("Control+z");
  await expect(portalLayers(page)).toHaveCount(before + 1, { timeout: 5_000 });
  await expect(page.locator(".vnccs-uc2-fullscreen-portal")).toBeVisible();

  // Ctrl+Y redoes it; Ctrl+Z again undoes it. Fullscreen and graph stay intact.
  await page.keyboard.press("Control+y");
  await expect(portalLayers(page)).toHaveCount(before + 2, { timeout: 5_000 });
  await page.keyboard.press("Control+z");
  await expect(portalLayers(page)).toHaveCount(before + 1, { timeout: 5_000 });
  await expect(page.locator(".vnccs-uc2-fullscreen-portal")).toBeVisible();

  const graphAfter = await graphFingerprint(page);
  expect(graphAfter).toEqual(graphBefore);
  expect(await page.evaluate(() => window.__ucUndoLeaks)).toEqual([]);
});

test("Ctrl+Z / Ctrl+Y with an empty UniCanvas history stay inside fullscreen", async ({ page }) => {
  await bootGraphWithUniCanvas(page);
  const graphBefore = await graphFingerprint(page);
  await openFullscreen(page);

  const addMask = page.locator('.vnccs-uc2-fullscreen-portal button[title="Add mask"]');
  const before = await portalLayers(page).count();
  await addMask.click();
  await expect(portalLayers(page)).toHaveCount(before + 1);

  // Walk the history to the end, then keep pressing: nothing may leak out.
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(120);
  }
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("Control+y");
    await page.waitForTimeout(120);
  }

  await expect(page.locator(".vnccs-uc2-fullscreen-portal")).toBeVisible();
  expect(await page.evaluate(() => window.__ucUndoLeaks)).toEqual([]);
  expect(await graphFingerprint(page)).toEqual(graphBefore);
});

test("Ctrl+Z while a canvas text field is focused keeps native editing", async ({ page }) => {
  await bootGraphWithUniCanvas(page);
  const graphBefore = await graphFingerprint(page);
  await openFullscreen(page);

  const root = page.locator(".vnccs-uc2-fullscreen-portal .vnccs-unicanvas");
  const textarea = root.locator("textarea").first();
  await textarea.click();
  await page.keyboard.type("first ");
  await page.keyboard.type("second");
  const typed = await textarea.inputValue();
  expect(typed).toBe("first second");
  // Ctrl+Z belongs to the text field (native undo), never to the graph.
  await page.keyboard.press("Control+z");
  await expect.poll(() => textarea.inputValue(), { timeout: 5_000 }).not.toBe(typed);
  await expect(page.locator(".vnccs-uc2-fullscreen-portal")).toBeVisible();
  expect(await page.evaluate(() => window.__ucUndoLeaks)).toEqual([]);
  expect(await graphFingerprint(page)).toEqual(graphBefore);
});

test("adding and deleting layers are undoable inside fullscreen", async ({ page }) => {
  await bootGraphWithUniCanvas(page);
  const graphBefore = await graphFingerprint(page);
  await openFullscreen(page);

  const addMask = page.locator('.vnccs-uc2-fullscreen-portal button[title="Add mask"]');
  const before = await portalLayers(page).count();
  await addMask.click();
  await expect(portalLayers(page)).toHaveCount(before + 1);

  // Delete the newly added mask through its row button, then undo the delete.
  const deleteBtn = page
    .locator(".vnccs-uc2-fullscreen-portal .vnccs-uc-layer", { hasText: "Mask" })
    .last()
    .locator('button[title="Delete layer"]');
  await deleteBtn.click();
  await expect(portalLayers(page)).toHaveCount(before);
  await page.keyboard.press("Control+z");
  await expect(portalLayers(page)).toHaveCount(before + 1, { timeout: 5_000 });

  await expect(page.locator(".vnccs-uc2-fullscreen-portal")).toBeVisible();
  expect(await page.evaluate(() => window.__ucUndoLeaks)).toEqual([]);
  expect(await graphFingerprint(page)).toEqual(graphBefore);
});
