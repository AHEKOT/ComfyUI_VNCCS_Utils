import { test, expect } from "@playwright/test";

// Pose Studio whole-character Move / Rotate gizmo on a real ComfyUI graph node: real mouse
// drags at three canvas zoom levels, two characters, undo, Pose-mode bone drags, workflow
// reload and a RUN whose output matches the viewport composition. RUN uses only Pose
// Studio's CPU capture path; nothing downloads models.

test.use({ viewport: { width: 1600, height: 1000 } });

const LAYOUTS = {
  0.6: { size: [2300, 1560], offset: [40, 50] },
  1: { size: [1420, 900], offset: [60, 60] },
  1.4: { size: [1080, 680], offset: [30, 40] },
};

async function openPoseStudio(page, zoom = 1) {
  const layout = LAYOUTS[zoom];
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window.comfyAPI?.app?.app ?? window.app)?.graph && window.LiteGraph, null, { timeout: 120_000 });
  // Extensions register after the graph exists; a node created earlier never gets its widget.
  await page.waitForTimeout(5000);
  for (let i = 0; i < 3; i += 1) { await page.keyboard.press("Escape"); await page.waitForTimeout(150); }
  await page.evaluate(async ({ zoom, size, offset }) => {
    const app = window.comfyAPI?.app?.app ?? window.app;
    await app.extensionManager?.setting?.set?.("Comfy.Minimap.Visible", false)?.catch?.(() => {});
    app.graph.clear();
    const studio = window.LiteGraph.createNode("VNCCS_PoseStudio");
    studio.pos = [0, 0];
    app.graph.add(studio);
    const save = window.LiteGraph.createNode("SaveImage");
    save.pos = [size[0] + 100, 0];
    app.graph.add(save);
    studio.connectByType(0, save, "IMAGE");
    studio.setSize(size);
    app.canvas.ds.scale = zoom;
    app.canvas.ds.offset = [offset[0] / zoom, offset[1] / zoom];
    app.canvas.setDirty(true, true);
    window.__node = studio;
  }, { zoom, ...layout });
  await page.waitForFunction(() => window.__node?.studioWidget?.viewer?.skinnedMesh
    && window.__node.studioWidget.characterTransform?.gizmo, null, { timeout: 120_000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const viewer = window.__node.studioWidget.viewer, record = viewer.recordState;
    viewer.__records = 0;
    viewer.recordState = (...args) => { viewer.__records += 1; return record.apply(viewer, args); };
  });
}

// Pose Studio panels use CSS zoom, which Playwright's actionability check misreads as
// "outside of the viewport"; click real mouse coordinates instead.
async function clickAt(page, locator) {
  await locator.evaluate(element => element.scrollIntoView({ block: "center" }));
  const box = await locator.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function openCharacters(page) {
  const open = await page.evaluate(() => {
    const section = window.__node.studioWidget.charactersSection;
    return section.classList.contains("open") || getComputedStyle(window.__node.studioWidget.charactersContent).display !== "none";
  });
  if (!open) await clickAt(page, page.locator(".vnccs-ps-characters-section .vnccs-ps-section-title").first());
}

async function addSecondCharacter(page) {
  await openCharacters(page);
  await clickAt(page, page.locator(".vnccs-ps-character-slot.empty").first());
  await page.waitForFunction(() => {
    const w = window.__node.studioWidget;
    return w.characters.length === 2 && !w._switchingCharacter && w.viewer.passiveCharacters.size === 1;
  }, null, { timeout: 60_000 });
  await page.waitForTimeout(300);
}

const toolbarButton = (page, label) => page.locator(".vnccs-ps-transform-toolbar button", { hasText: label }).first();

/** Live state read after the next rendered frame. */
const state = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
  const w = window.__node.studioWidget, v = w.viewer, c = w.characterTransform;
  const rect = v.canvas.getBoundingClientRect();
  const pelvis = c.pivotWorldPosition().project(v.camera);
  const inputs = c.fields?.inputs;
  resolve({
    active: w.getActiveCharacter().id,
    transform: { ...w.getActiveCharacter().transform },
    rotation: { ...v.modelRotation },
    fields: inputs && ["position", "rotation"].flatMap(kind => ["x", "y", "z"].map(axis => Number(inputs[kind][axis].value))),
    orbitEnabled: v.orbit.enabled,
    camera: v.camera.position.toArray(),
    records: v.__records,
    pelvis: { x: rect.left + (pelvis.x + 1) / 2 * rect.width, y: rect.top + (1 - pelvis.y) / 2 * rect.height },
    mode: c.mode,
    space: c.space,
    bones: JSON.stringify(v.getPose().bones),
  });
})));

/** Client point over a gizmo handle, found with TransformControls' own picking. */
const handle = (page, axis) => page.evaluate(name => {
  const w = window.__node.studioWidget, v = w.viewer, g = w.characterTransform.gizmo;
  v.scene.updateMatrixWorld(true);
  const rect = v.canvas.getBoundingClientRect();
  const hits = [];
  const steps = 160;
  for (let i = 0; i <= steps; i += 1) {
    for (let j = 0; j <= steps; j += 1) {
      const pointer = { x: -1 + 2 * i / steps, y: -1 + 2 * j / steps, button: 0 };
      g.pointerHover(pointer);
      if (g.axis === name) hits.push(pointer);
    }
  }
  g.pointerHover({ x: 9, y: 9, button: 0 });
  if (!hits.length) return null;
  const cx = hits.reduce((sum, p) => sum + p.x, 0) / hits.length;
  const cy = hits.reduce((sum, p) => sum + p.y, 0) / hits.length;
  const best = hits.reduce((a, b) => (Math.hypot(a.x - cx, a.y - cy) <= Math.hypot(b.x - cx, b.y - cy) ? a : b));
  return { x: rect.left + (best.x + 1) / 2 * rect.width, y: rect.top + (1 - best.y) / 2 * rect.height };
}, axis);

async function gizmoDrag(page, axis, delta, { steps = 6 } = {}) {
  const start = await handle(page, axis);
  expect(start, `${axis} handle on screen`).toBeTruthy();
  await page.mouse.move(start.x, start.y);
  expect(await page.evaluate(() => window.__node.studioWidget.characterTransform.gizmo.axis)).toBe(axis);
  await page.mouse.down();
  const samples = [];
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(start.x + delta.x * i / steps, start.y + delta.y * i / steps);
    samples.push(await state(page));
  }
  await page.mouse.up();
  return samples;
}

const close = (actual, expected, tolerance, message) =>
  expect(Math.abs(actual - expected), `${message}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);

for (const zoom of [0.6, 1, 1.4]) {
  test(`character gizmo: real Move / Rotate drags at canvas zoom ${zoom}`, async ({ page }) => {
    test.setTimeout(300_000);
    const errors = [];
    page.on("pageerror", error => errors.push(String(error).split("\n")[0]));
    page.on("console", message => {
      if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text().split("\n")[0]);
    });
    await openPoseStudio(page, zoom);
    expect((await state(page)).mode).toBe("pose");
    await addSecondCharacter(page);
    const second = (await state(page)).active;

    // Move: X axis follows the pointer 1:1 on screen, fields update during the drag.
    await clickAt(page, toolbarButton(page, "Move"));
    const start = await state(page);
    expect(start.mode).toBe("move");
    const dx = Math.round(70 * zoom);
    const xs = await gizmoDrag(page, "X", { x: dx, y: 0 });
    for (const [index, sample] of xs.entries()) {
      expect(sample.orbitEnabled, "orbit is suppressed during the gizmo drag").toBe(false);
      expect(sample.camera).toEqual(start.camera);
      close(sample.fields[0], Number(sample.transform.x.toFixed(2)), 0.0051, "Position X field during drag");
      close(sample.pelvis.x - start.pelvis.x, dx * (index + 1) / xs.length, 2, "pelvis follows the pointer");
      close(sample.pelvis.y, start.pelvis.y, 1, "X drag keeps screen Y");
      if (index) expect(sample.transform.x).toBeGreaterThan(xs[index - 1].transform.x);
    }
    let now = await state(page);
    expect(now.orbitEnabled).toBe(true);
    expect(now.records - start.records, "one undo step per drag").toBe(1);
    close(now.pelvis.x, xs.at(-1).pelvis.x, 0.5, "no jump after release");
    expect(now.bones).toBe(start.bones);

    // Plane and free drags.
    const beforePlane = now;
    await gizmoDrag(page, "XY", { x: -30 * zoom, y: -40 * zoom });
    now = await state(page);
    expect(now.transform.y).toBeGreaterThan(beforePlane.transform.y);
    close(now.transform.z, beforePlane.transform.z, 1e-6, "XY plane keeps depth");
    const afterPlane = now;
    await gizmoDrag(page, "XYZ", { x: -40 * zoom, y: 20 * zoom });
    const afterFree = await state(page);
    expect(afterFree.transform.x).toBeLessThan(afterPlane.transform.x);
    expect(afterFree.records - start.records).toBe(3);

    // Undo button: one step back per drag.
    await clickAt(page, page.locator(".vnccs-ps-actions .vnccs-ps-btn", { hasText: "Undo" }).first());
    now = await state(page);
    for (const axis of ["x", "y", "z"]) close(now.transform[axis], afterPlane.transform[axis], 1e-9, `undo ${axis}`);
    expect(now.fields.slice(0, 3)).toEqual(["x", "y", "z"].map(axis => Number(afterPlane.transform[axis].toFixed(2))));

    // Numeric field (real typing) drives the character; the gizmo follows.
    const fieldZ = page.locator('.vnccs-ps-character-transform input[data-transform="position.z"]');
    await clickAt(page, fieldZ);
    await page.keyboard.press("Control+A");
    await page.keyboard.type("-6");
    await page.keyboard.press("Enter");
    now = await state(page);
    close(now.transform.z, -6, 1e-9, "Z field");
    const gizmoAtPelvis = await page.evaluate(() => {
      const c = window.__node.studioWidget.characterTransform;
      c.viewer.scene.updateMatrixWorld(true);
      return c.proxy.position.distanceTo(c.pivotWorldPosition());
    });
    close(gizmoAtPelvis, 0, 1e-6, "gizmo follows the field");

    // Rotate: Y ring keeps the pelvis fixed on screen; World / Local toggle.
    await clickAt(page, toolbarButton(page, "Rotate"));
    const beforeRotate = await state(page);
    const ys = await gizmoDrag(page, "Y", { x: 60 * zoom, y: 0 });
    for (const [index, sample] of ys.entries()) {
      close(sample.pelvis.x, beforeRotate.pelvis.x, 1, "pelvis stays during rotation");
      close(sample.pelvis.y, beforeRotate.pelvis.y, 1, "pelvis stays during rotation");
      close(sample.fields[4], Number(sample.rotation.y.toFixed(1)), 0.051, "Rotation Y field during drag");
      if (index) expect(Math.abs(sample.rotation.y)).toBeGreaterThan(Math.abs(ys[index - 1].rotation.y));
      expect(sample.bones).toBe(beforeRotate.bones);
    }
    expect((await state(page)).records - beforeRotate.records).toBe(1);
    await clickAt(page, page.locator(".vnccs-ps-transform-space"));
    expect((await state(page)).space).toBe("local");
    const beforeLocal = await state(page);
    await gizmoDrag(page, "X", { x: 0, y: -40 * zoom });
    now = await state(page);
    expect(Math.abs(now.rotation.x - beforeLocal.rotation.x) + Math.abs(now.rotation.z - beforeLocal.rotation.z)).toBeGreaterThan(1);
    close(now.pelvis.x, beforeLocal.pelvis.x, 1, "pelvis stays in Local space");
    close(now.pelvis.y, beforeLocal.pelvis.y, 1, "pelvis stays in Local space");
    await clickAt(page, page.locator(".vnccs-ps-transform-space"));

    // Pose mode: an ordinary IK bone drag still edits the pose and not the placement.
    await clickAt(page, toolbarButton(page, "Pose"));
    const beforePose = await state(page);
    const hand = await page.evaluate(() => {
      const v = window.__node.studioWidget.viewer;
      const bone = v.bones.hand_l || v.boneList.find(item => /hand.*l|wrist.*l/i.test(item.name));
      const point = bone.getWorldPosition(new v.THREE.Vector3()).project(v.camera);
      const rect = v.canvas.getBoundingClientRect();
      return { x: rect.left + (point.x + 1) / 2 * rect.width, y: rect.top + (1 - point.y) / 2 * rect.height };
    });
    await page.mouse.move(hand.x, hand.y);
    await page.waitForTimeout(100);
    await page.mouse.down();
    for (let i = 1; i <= 6; i += 1) await page.mouse.move(hand.x + 6 * i * zoom, hand.y - 8 * i * zoom);
    await page.mouse.up();
    now = await state(page);
    expect(now.bones).not.toBe(beforePose.bones);
    expect(now.transform).toEqual(beforePose.transform);
    expect(now.rotation).toEqual(beforePose.rotation);
    expect(now.records - beforePose.records).toBe(1);

    // Click the other character in the viewport (Move mode) to select it.
    await clickAt(page, toolbarButton(page, "Move"));
    // Aim at a point of the other character that is not covered by the gizmo handles.
    const other = await page.evaluate(() => {
      const w = window.__node.studioWidget, v = w.viewer, c = w.characterTransform;
      const [id, entry] = [...v.passiveCharacters.entries()][0];
      const rect = v.canvas.getBoundingClientRect();
      v.scene.updateMatrixWorld(true);
      for (const y of [5, 4, 3, -5, -6, 1, 0, 2]) {
        const ndc = entry.mesh.localToWorld(new v.THREE.Vector3(0, y, 0.3)).project(v.camera);
        c.gizmo.pointerHover({ x: ndc.x, y: ndc.y, button: 0 });
        const point = { x: rect.left + (ndc.x + 1) / 2 * rect.width, y: rect.top + (1 - ndc.y) / 2 * rect.height };
        if (!c.gizmo.axis && c.characterIdAt({ clientX: point.x, clientY: point.y }) === id) return { id, ...point };
      }
      return null;
    });
    expect(other).toBeTruthy();
    await page.mouse.move(other.x, other.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForFunction(id => window.__node.studioWidget.getActiveCharacter().id === id
      && !window.__node.studioWidget._switchingCharacter, other.id, { timeout: 30_000 });
    now = await state(page);
    expect(now.active).not.toBe(second);
    expect(now.mode).toBe("move");
    expect(errors).toEqual([]);
  });
}

test("character gizmo: workflow reload and a RUN that matches the viewport composition", async ({ page }) => {
  test.setTimeout(420_000);
  await openPoseStudio(page, 1);
  await addSecondCharacter(page);
  // Facing each other: character 1 left turned right, character 2 right turned left and deeper.
  const placements = await page.evaluate(async () => {
    const w = window.__node.studioWidget, c = w.characterTransform;
    c.setMode("rotate");
    const second = w.getActiveCharacter().id;
    c.applyPlacement({ position: { x: 6, y: -0.5, z: -4 }, rotation: { x: 0, y: -60, z: 0 } });
    c.commit();
    const first = w.characters.find(character => character.id !== second).id;
    await w.selectCharacter(first);
    c.applyPlacement({ position: { x: -6, y: 0.5, z: 2 }, rotation: { x: 0, y: 60, z: 5 } });
    c.commit();
    w.exportParams.bg_color = [0, 0, 0];
    w.syncToNode(false);
    return Object.fromEntries(w.characters.map(character => [character.id, {
      transform: { ...character.transform },
      rotation: [...(character.id === w.activeCharacterId ? w.viewer.getPose().modelRotation : character.poses[w.activeTab].modelRotation)],
    }]));
  });

  // Viewport and capture camera agree, and the RUN output puts each character there.
  const predicted = await page.evaluate(() => {
    const w = window.__node.studioWidget, v = w.viewer;
    const width = w.exportParams.view_width, height = w.exportParams.view_height;
    v.updateCaptureCamera(width, height, 1, 0, 0, w.exportParams.cam_yaw_deg || 0, w.exportParams.cam_pitch_deg || 0);
    v.snapToCaptureCamera(width, height, 1, 0, 0, w.exportParams.cam_yaw_deg || 0, w.exportParams.cam_pitch_deg || 0);
    v.captureCamera.updateMatrixWorld(true); v.camera.updateMatrixWorld(true);
    const meshes = [[w.activeCharacterId, v.skinnedMesh], ...[...v.passiveCharacters.entries()].map(([id, entry]) => [id, entry.mesh])];
    // The capture frame as seen by the viewport camera (normalized to the frame rectangle).
    const corners = [[-1, 1], [1, -1]].map(([x, y]) => new v.THREE.Vector3(x, y, 0).applyMatrix4(v.captureFrame.matrixWorld).project(v.camera));
    const result = {};
    for (const [id, mesh] of meshes) {
      mesh.updateMatrixWorld(true); mesh.skeleton.update();
      const positions = mesh.geometry.attributes.position, index = mesh.geometry.index;
      const capture = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      const view = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      const point = new v.THREE.Vector3(), seen = new Set();
      for (let i = 0; i < index.count; i += 1) {
        const vertex = index.getX(i);
        if (seen.has(vertex)) continue;
        seen.add(vertex);
        point.fromBufferAttribute(positions, vertex);
        mesh.applyBoneTransform(vertex, point);
        point.applyMatrix4(mesh.matrixWorld);
        const a = point.clone().project(v.captureCamera);
        const b = point.clone().project(v.camera);
        const px = (a.x + 1) / 2 * width, py = (1 - a.y) / 2 * height;
        const fx = (b.x - corners[0].x) / (corners[1].x - corners[0].x) * width;
        const fy = (b.y - corners[0].y) / (corners[1].y - corners[0].y) * height;
        capture.minX = Math.min(capture.minX, px); capture.maxX = Math.max(capture.maxX, px);
        capture.minY = Math.min(capture.minY, py); capture.maxY = Math.max(capture.maxY, py);
        view.minX = Math.min(view.minX, fx); view.maxX = Math.max(view.maxX, fx);
        view.minY = Math.min(view.minY, fy); view.maxY = Math.max(view.maxY, fy);
      }
      result[id] = { capture, view };
    }
    return result;
  });
  for (const { capture, view } of Object.values(predicted)) {
    for (const key of ["minX", "maxX", "minY", "maxY"]) close(view[key], capture[key], 1, `viewport frame ${key}`);
  }

  const known = new Set(Object.keys(await page.evaluate(async () => (await (await fetch("/history?max_items=200")).json()))));
  await page.evaluate(() => (window.comfyAPI?.app?.app ?? window.app).queuePrompt(0, 1));
  let image = null;
  for (let i = 0; i < 180 && !image; i += 1) {
    const history = await page.evaluate(async () => (await (await fetch("/history?max_items=200")).json()));
    const fresh = Object.entries(history).find(([id]) => !known.has(id));
    if (fresh?.[1].status?.status_str === "error") throw new Error(JSON.stringify(fresh[1].status));
    if (fresh?.[1].status?.completed) image = Object.values(fresh[1].outputs).flatMap(output => output.images || [])[0];
    else await page.waitForTimeout(1000);
  }
  expect(image).toBeTruthy();
  const measured = await page.evaluate(async ({ image, predicted }) => {
    const url = `/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder)}&type=${image.type}`;
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const boxes = Object.fromEntries(Object.keys(predicted).map(id => [id, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }]));
    const entries = Object.entries(predicted);
    for (let y = 0; y < bitmap.height; y += 1) {
      for (let x = 0; x < bitmap.width; x += 1) {
        const offset = (y * bitmap.width + x) * 4;
        if (Math.max(data[offset], data[offset + 1], data[offset + 2]) < 12) continue;
        // Assign the pixel to the character whose predicted box contains it (they do not overlap).
        const owner = entries.find(([, box]) => x >= box.capture.minX - 3 && x <= box.capture.maxX + 3
          && y >= box.capture.minY - 3 && y <= box.capture.maxY + 3);
        if (!owner) { boxes.outside = (boxes.outside || 0) + 1; continue; }
        const box = boxes[owner[0]];
        box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x);
        box.minY = Math.min(box.minY, y); box.maxY = Math.max(box.maxY, y);
      }
    }
    return { width: bitmap.width, height: bitmap.height, boxes };
  }, { image, predicted });
  expect(measured.boxes.outside || 0, "no character pixels outside the predicted boxes").toBeLessThan(20);
  let worst = 0;
  for (const [id, { capture }] of Object.entries(predicted)) {
    for (const key of ["minX", "maxX", "minY", "maxY"]) {
      close(measured.boxes[id][key], capture[key], 3, `${id} output ${key}`);
      worst = Math.max(worst, Math.abs(measured.boxes[id][key] - capture[key]));
    }
  }
  console.log(`RUN output vs viewport: worst bbox edge difference ${worst.toFixed(2)} px`, JSON.stringify({ predicted, measured: measured.boxes }));

  // Workflow reload restores both characters' placement and rotation.
  await page.evaluate(async () => {
    const app = window.comfyAPI?.app?.app ?? window.app;
    const workflow = JSON.parse(JSON.stringify(app.graph.serialize()));
    window.__node = null;
    await app.loadGraphData(workflow);
    window.__node = app.graph._nodes.find(node => node.type === "VNCCS_PoseStudio");
  });
  await page.waitForFunction(() => {
    const w = window.__node?.studioWidget;
    return w?.viewer?.skinnedMesh && w.characters?.length === 2 && !w._sceneModelHydrationPromise
      && w.viewer.passiveCharacters.size === 1;
  }, null, { timeout: 120_000 });
  const restored = await page.evaluate(() => {
    const w = window.__node.studioWidget;
    return Object.fromEntries(w.characters.map(character => [character.id, {
      transform: { ...character.transform },
      rotation: [...(character.id === w.activeCharacterId ? w.viewer.getPose().modelRotation : character.poses[w.activeTab].modelRotation)],
      mode: w.characterTransform.mode,
    }]));
  });
  for (const [id, saved] of Object.entries(placements)) {
    for (const axis of ["x", "y", "z", "zoom"]) close(restored[id].transform[axis], saved.transform[axis], 1e-6, `${id} ${axis}`);
    saved.rotation.forEach((value, index) => close(restored[id].rotation[index], value, 1e-6, `${id} rotation ${index}`));
    expect(restored[id].mode).toBe("pose");
  }
});
