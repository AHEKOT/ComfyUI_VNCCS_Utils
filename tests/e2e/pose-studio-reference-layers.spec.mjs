import { test, expect } from "@playwright/test";

// Pose Studio reference image layers on a real ComfyUI graph node: viewport gestures at
// several canvas zoom levels, editor-only RUN output, workflow persistence and back-compat.
// RUN uses only Pose Studio's CPU capture path; nothing downloads models.


// The Desktop Chrome device preset is 1280x720; the node is laid out for a larger window.
test.use({ viewport: { width: 1600, height: 1000 } });

async function openPoseStudio(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window.comfyAPI?.app?.app ?? window.app)?.graph && window.LiteGraph, null, { timeout: 120_000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const app = window.comfyAPI?.app?.app ?? window.app;
    app.graph.clear();
    const studio = window.LiteGraph.createNode("VNCCS_PoseStudio");
    studio.pos = [0, 0];
    app.graph.add(studio);
    const save = window.LiteGraph.createNode("SaveImage");
    save.pos = [1500, 0];
    app.graph.add(save);
    studio.connectByType(0, save, "IMAGE");
    studio.setSize([1400, 880]);
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [60, 60];
    app.canvas.setDirty(true, true);
    window.__node = studio;
  });
  await page.waitForFunction(() => window.__node?.studioWidget?.viewer?.skinnedMesh, null, { timeout: 120_000 });
  await page.waitForTimeout(800);
}

async function setCanvasZoom(page, scale) {
  await page.evaluate((value) => {
    const app = window.comfyAPI?.app?.app ?? window.app;
    app.canvas.ds.scale = value;
    app.canvas.ds.offset = [60 / value, 60 / value];
    app.canvas.setDirty(true, true);
  }, scale);
  await page.waitForTimeout(500);
}

async function makeImages(page) {
  const files = await page.evaluate(() => {
    const make = (name, width, height, draw) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      draw(canvas.getContext("2d"), width, height);
      return { name, data: canvas.toDataURL("image/png").split(",")[1] };
    };
    return [
      make("checker.png", 2048, 1280, (g, w, h) => {
        for (let y = 0; y < h; y += 128) for (let x = 0; x < w; x += 128) {
          g.fillStyle = (x + y) / 128 % 2 ? "#ff3b3b" : "#ffffff";
          g.fillRect(x, y, 128, 128);
        }
      }),
      make("gradient.png", 300, 600, (g, w, h) => {
        const gradient = g.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, "#1e88e5");
        gradient.addColorStop(1, "#00e676");
        g.fillStyle = gradient;
        g.fillRect(0, 0, w, h);
      }),
      make("triangle.png", 500, 500, (g, w, h) => {
        g.fillStyle = "#ffd600";
        g.beginPath();
        g.moveTo(w / 2, 10);
        g.lineTo(w - 10, h - 10);
        g.lineTo(10, h - 10);
        g.closePath();
        g.fill();
      }),
    ];
  });
  return files.map(file => ({ name: file.name, mimeType: "image/png", buffer: Buffer.from(file.data, "base64") }));
}

// Pose Studio panels use CSS zoom, which Playwright's actionability check misreads as
// "outside of the viewport"; click real mouse coordinates instead.
async function clickAt(page, locator) {
  const box = await locator.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function addLayers(page) {
  // Count undo steps (the viewer keeps only the last 10 entries).
  await page.evaluate(() => {
    const viewer = window.__node.studioWidget.viewer, record = viewer.recordState;
    viewer.__records = 0;
    viewer.recordState = (...args) => { viewer.__records += 1; return record.apply(viewer, args); };
  });
  await clickAt(page, page.getByText("Reference Layers", { exact: true }).first());
  await page.setInputFiles(".vnccs-ps-reflayer-file", await makeImages(page));
  await page.waitForFunction(() => {
    const c = window.__node.studioWidget.referenceLayers;
    return c.layers.length === 3 && [...c.entries.values()].every(entry => entry.ready);
  }, null, { timeout: 30_000 });
}

/** Client (screen) point of a frame-space point and the frame point under a client point. */
async function geometry(page) {
  return page.evaluate(() => {
    const w = window.__node.studioWidget, c = w.referenceLayers, canvas = w.viewer.canvas;
    c.syncFrame();
    const rect = canvas.getBoundingClientRect();
    const layer = c.selectedLayer();
    const toClient = css => css && ({ x: rect.left + css.x * rect.width / canvas.clientWidth, y: rect.top + css.y * rect.height / canvas.clientHeight });
    const handles = c.handleGeometry(layer);
    return {
      layer: { ...layer, src: undefined },
      center: toClient(c.frameToCss(layer)),
      corner: toClient(handles.corners[1]),
      rotate: toClient(handles.rotate),
      zoomRatio: rect.width / canvas.clientWidth,
      history: w.viewer.__records,
    };
  });
}

const frameAt = (page, point) => page.evaluate(({ x, y }) => {
  const w = window.__node.studioWidget, c = w.referenceLayers, canvas = w.viewer.canvas;
  c.syncFrame();
  const rect = canvas.getBoundingClientRect();
  return c.ndcToFrame({ x: (x - rect.left) / rect.width * 2 - 1, y: -((y - rect.top) / rect.height) * 2 + 1 });
}, point);

const layerState = page => page.evaluate(() => ({ ...window.__node.studioWidget.referenceLayers.selectedLayer(), src: undefined }));

async function dragMouse(page, from, to, { steps = 8, sample = null } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const samples = [];
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
    if (sample) samples.push(await sample());
  }
  await page.mouse.up();
  return samples;
}

async function runOutputPixels(page) {
  const known = new Set(Object.keys(await page.evaluate(async () => (await (await fetch("/history?max_items=200")).json()))));
  await page.evaluate(() => (window.comfyAPI?.app?.app ?? window.app).queuePrompt(0, 1));
  for (let i = 0; i < 180; i += 1) {
    const history = await page.evaluate(async () => (await (await fetch("/history?max_items=200")).json()));
    const fresh = Object.entries(history).find(([id]) => !known.has(id));
    if (fresh?.[1].status?.status_str === "error") throw new Error(JSON.stringify(fresh[1].status));
    if (fresh?.[1].status?.completed) {
      return Object.values(fresh[1].outputs).flatMap(output => output.images || [])[0];
    }
    await page.waitForTimeout(1000);
  }
  throw new Error("RUN did not finish");
}

const pixelDiff = (page, a, b) => page.evaluate(async ([first, second]) => {
  const decode = async image => {
    const url = `/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder)}&type=${image.type}`;
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, data: context.getImageData(0, 0, bitmap.width, bitmap.height).data };
  };
  const [x, y] = await Promise.all([decode(first), decode(second)]);
  if (x.width !== y.width || x.height !== y.height) return { sizeMismatch: true };
  let differing = 0;
  for (let i = 0; i < x.data.length; i += 1) if (x.data[i] !== y.data[i]) differing += 1;
  return { width: x.width, height: x.height, differing };
}, [a, b]);

test("reference layers: realtime viewport gestures at three canvas zooms, editor-only RUN, reload", async ({ page }) => {
  test.setTimeout(420_000);
  const errors = [];
  page.on("pageerror", error => errors.push(String(error).split("\n")[0]));
  page.on("console", message => {
    if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text().split("\n")[0]);
  });
  await openPoseStudio(page);
  const baseline = await runOutputPixels(page);
  await addLayers(page);
  const stored = await page.evaluate(() => window.__node.studioWidget.referenceLayers.layers
    .map(item => ({ name: item.name, width: item.width, height: item.height, webp: /^[0-9a-f]{64}\.webp$/.test(item.asset) })));
  // Downscaled to the 1024 px storage limit once, at import.
  expect(stored[0]).toEqual({ name: "checker.png", width: 1024, height: 640, webp: true });
  expect(await page.evaluate(() => window.__node.studioWidget.referenceLayers.editMode)).toBe(true);

  // List buttons with real clicks: Delete, then the Undo button brings the layer back.
  const deleteButton = page.locator('.vnccs-ps-reflayer-row button[data-action="Delete"]').nth(1);
  await clickAt(page, deleteButton);
  expect(await page.evaluate(() => window.__node.studioWidget.referenceLayers.layers.length)).toBe(2);
  await clickAt(page, page.locator(".vnccs-ps-actions .vnccs-ps-btn", { hasText: "Undo" }).first());
  expect(await page.evaluate(() => window.__node.studioWidget.referenceLayers.layers.map(item => item.name)))
    .toEqual(["checker.png", "gradient.png", "triangle.png"]);
  await page.evaluate(() => {
    const c = window.__node.studioWidget.referenceLayers;
    c.select(c.layers.at(-1).id);
  });

  // Dropping an image file on the viewport adds a layer instead of loading a workflow.
  const nodeCount = await page.evaluate(() => (window.comfyAPI?.app?.app ?? window.app).graph._nodes.length);
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 32;
    canvas.getContext("2d").fillRect(0, 0, 64, 32);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "dropped.png", { type: "image/png" }));
    const target = window.__node.studioWidget.viewer.canvas;
    target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect.poll(() => page.evaluate(() => window.__node.studioWidget.referenceLayers.layers.length)).toBe(4);
  expect(await page.evaluate(() => (window.comfyAPI?.app?.app ?? window.app).graph._nodes.length)).toBe(nodeCount);
  await page.evaluate(() => {
    const c = window.__node.studioWidget.referenceLayers;
    c.removeLayer(c.layers.at(-1).id);
    c.select(c.layers.at(-1).id);
  });

  for (const zoom of [0.6, 1, 1.4]) {
    await setCanvasZoom(page, zoom);
    // Start each zoom from a modest placement so every handle is on screen (and away
    // from the ComfyUI toolbars).
    await page.evaluate(() => {
      const c = window.__node.studioWidget.referenceLayers;
      c.edit(c.selectedId, { x: 0, y: 0, scale: 0.5, rotation: 0 });
    });
    const start = await geometry(page);
    expect(start.zoomRatio).toBeCloseTo(zoom, 2);
    const bone = await page.evaluate(() => window.__node.studioWidget.viewer.selectedBone?.name || null);

    // Move: every pointer step is visible immediately (strictly increasing x).
    const from = { x: start.center.x + 6, y: start.center.y + 4 };
    const to = { x: from.x + 70 * zoom, y: from.y + 35 * zoom };
    const samples = await dragMouse(page, from, to, { sample: async () => (await layerState(page)).x });
    for (let i = 1; i < samples.length; i += 1) expect(samples[i]).toBeGreaterThan(samples[i - 1]);
    // Ctrl+drag inside the layer rotates too (for when the handle is off screen).
    expect(await page.evaluate(p => window.__node.studioWidget.referenceLayers.hitTest({ clientX: p.x, clientY: p.y, ctrlKey: true })?.mode, to)).toBe("rotate");
    const [p0, p1] = [await frameAt(page, from), await frameAt(page, to)];
    let layer = await layerState(page);
    expect(layer.x).toBeCloseTo(start.layer.x + p1.x - p0.x, 3);
    expect(layer.y).toBeCloseTo(start.layer.y + p1.y - p0.y, 3);

    // Scale from the top-right corner handle, around the centre.
    let g = await geometry(page);
    const cornerTo = { x: g.corner.x + (g.corner.x - g.center.x) * 0.25, y: g.corner.y + (g.corner.y - g.center.y) * 0.25 };
    const [c0, c1] = [await frameAt(page, g.corner), await frameAt(page, cornerTo)];
    await dragMouse(page, g.corner, cornerTo);
    layer = await layerState(page);
    const ratio = Math.hypot(c1.x - g.layer.x, c1.y - g.layer.y) / Math.hypot(c0.x - g.layer.x, c0.y - g.layer.y);
    expect(layer.scale).toBeCloseTo(g.layer.scale * ratio, 3);

    // Rotate with the round handle.
    g = await geometry(page);
    const rotateTo = { x: g.rotate.x + 45 * zoom, y: g.rotate.y + 10 * zoom };
    const [r0, r1] = [await frameAt(page, g.rotate), await frameAt(page, rotateTo)];
    await dragMouse(page, g.rotate, rotateTo);
    layer = await layerState(page);
    const turn = (Math.atan2(r1.y - g.layer.y, r1.x - g.layer.x) - Math.atan2(r0.y - g.layer.y, r0.x - g.layer.x)) * 180 / Math.PI;
    const expected = ((g.layer.rotation - turn + 540) % 360) - 180;
    expect(Math.abs(((layer.rotation - expected + 540) % 360) - 180)).toBeLessThan(0.05);
    expect(layer.x).toBeCloseTo(g.layer.x, 6);

    // One undo step per gesture, and the gestures never reached bone picking.
    expect((await geometry(page)).history).toBe(start.history + 3);
    expect(await page.evaluate(() => window.__node.studioWidget.viewer.selectedBone?.name || null)).toBe(bone);
    // The Undo button reverts exactly the last gesture (at 1.4 the action bar is below
    // the window, so click it at zoom 1).
    await setCanvasZoom(page, 1);
    await clickAt(page, page.locator(".vnccs-ps-actions .vnccs-ps-btn", { hasText: "Undo" }).first());
    expect((await layerState(page)).rotation).toBeCloseTo(g.layer.rotation, 6);
    await clickAt(page, page.locator(".vnccs-ps-actions .vnccs-ps-btn", { hasText: "Redo" }).first());
    expect((await layerState(page)).rotation).toBeCloseTo(layer.rotation, 6);
  }

  // Right drag over the layer still orbits the editor view and leaves the layer alone.
  await setCanvasZoom(page, 1);
  let g = await geometry(page);
  const camera = await page.evaluate(() => window.__node.studioWidget.viewer.camera.position.toArray());
  await page.mouse.move(g.center.x, g.center.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(g.center.x + 90, g.center.y - 20, { steps: 8 });
  await page.mouse.up({ button: "right" });
  const orbited = await page.evaluate(() => window.__node.studioWidget.viewer.camera.position.toArray());
  expect(Math.hypot(...orbited.map((v, i) => v - camera[i]))).toBeGreaterThan(0.5);
  expect(await layerState(page)).toEqual(g.layer);
  // After the orbit a drag still lands exactly under the pointer.
  g = await geometry(page);
  const orbitFrom = { x: g.center.x + 3, y: g.center.y + 3 }, orbitTo = { x: g.center.x - 40, y: g.center.y + 25 };
  const [o0, o1] = [await frameAt(page, orbitFrom), await frameAt(page, orbitTo)];
  await dragMouse(page, orbitFrom, orbitTo);
  expect((await layerState(page)).x).toBeCloseTo(g.layer.x + o1.x - o0.x, 3);

  // Editor-only: opaque, frame-filling layers do not change a single output pixel.
  await page.evaluate(() => {
    const c = window.__node.studioWidget.referenceLayers;
    for (const item of c.layers) c.edit(item.id, { opacity: 1, scale: 1.2, visible: true });
  });
  const withLayers = await runOutputPixels(page);
  const diff = await pixelDiff(page, baseline, withLayers);
  expect(diff).toMatchObject({ differing: 0 });

  // Output size change keeps layers in frame-height space.
  const projection = await page.evaluate(() => {
    const w = window.__node.studioWidget, v = w.viewer, c = w.referenceLayers;
    const input = w.exportWidgets.view_width;
    input.value = "1536";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new Event("change"));
    v.updateCaptureCamera(1536, w.exportParams.view_height, 1, 0, 0, w.exportParams.cam_yaw_deg || 0, w.exportParams.cam_pitch_deg || 0);
    c.syncFrame();
    const layer = c.selectedLayer();
    const p = c.group.localToWorld(new v.THREE.Vector3(layer.x, layer.y, 0)).project(v.captureCamera);
    const H = w.exportParams.view_height;
    return { width: w.exportParams.view_width, px: (p.x + 1) / 2 * 1536, py: (1 - p.y) / 2 * H, ex: 768 + layer.x * H, ey: H / 2 - layer.y * H };
  });
  expect(projection.width).toBe(1536);
  expect(projection.px).toBeCloseTo(projection.ex, 1);
  expect(projection.py).toBeCloseTo(projection.ey, 1);

  // Workflow round trip restores every layer exactly; old data loads without layers.
  const saved = await page.evaluate(() => window.__node.studioWidget.referenceLayers.layers.map(item => ({ ...item })));
  const workflow = await page.evaluate(() => (window.comfyAPI?.app?.app ?? window.app).graph.serialize());
  const reload = async data => {
    await page.evaluate(async wf => {
      const app = window.comfyAPI?.app?.app ?? window.app;
      await app.loadGraphData(wf);
      window.__node = app.graph._nodes.find(node => node.type === "VNCCS_PoseStudio");
    }, data);
    await page.waitForFunction(() => window.__node?.studioWidget?.viewer?.skinnedMesh, null, { timeout: 120_000 });
    await page.waitForTimeout(800);
    return page.evaluate(() => window.__node.studioWidget.referenceLayers.layers.map(item => ({ ...item })));
  };
  expect(await reload(workflow)).toEqual(saved);
  const old = JSON.parse(JSON.stringify(workflow));
  for (const node of old.nodes.filter(item => item.type === "VNCCS_PoseStudio")) {
    const index = node.widgets_values.findIndex(value => typeof value === "string" && value.includes("reference_layers"));
    const data = JSON.parse(node.widgets_values[index]);
    delete data.reference_layers;
    node.widgets_values[index] = JSON.stringify(data);
  }
  expect(await reload(old)).toEqual([]);
  expect(errors).toEqual([]);
});

const workflowText = page => page.evaluate(() => {
  const app = window.comfyAPI?.app?.app ?? window.app;
  return JSON.stringify((app.rootGraph || app.graph).serialize());
});

async function loadWorkflow(page, data) {
  await page.evaluate(async wf => {
    const app = window.comfyAPI?.app?.app ?? window.app;
    await app.loadGraphData(wf);
    window.__node = app.graph._nodes.find(node => node.type === "VNCCS_PoseStudio");
  }, data);
  await page.waitForFunction(() => window.__node?.studioWidget?.viewer?.skinnedMesh, null, { timeout: 120_000 });
  await page.waitForFunction(() => {
    const w = window.__node.studioWidget, c = w.referenceLayers;
    return !w._poseDataRestorePending && c.group && [...c.entries.values()].every(entry => entry.ready) && c.entries.size === c.layers.length;
  }, null, { timeout: 60_000 });
}

test("reference layers: compact workflow, durable reload, inline migration and failed storage", async ({ page }) => {
  test.setTimeout(300_000);
  await openPoseStudio(page);
  await addLayers(page);
  const saved = await workflowText(page);
  const referenceChars = await page.evaluate(() => JSON.stringify(JSON.parse(window.__node.widgets[0].value).reference_layers).length);
  expect(referenceChars).toBeLessThan(3 * 450);
  // ComfyUI serializes pose_data twice; an empty Pose Studio workflow is about 11,000 characters.
  expect(saved.length).toBeLessThan(11_000 + 2 * 3 * 600);
  expect(saved).not.toContain("data:image");
  const layers = await page.evaluate(() => window.__node.studioWidget.referenceLayers.layers.map(item => ({ ...item })));

  // Reload from the workflow: same layers, images come from storage without a new upload.
  let uploads = 0;
  const countUploads = request => { if (request.method() === "POST" && request.url().includes("pose_reference_asset")) uploads += 1; };
  page.on("request", countUploads);
  await loadWorkflow(page, JSON.parse(saved));
  expect(await page.evaluate(() => window.__node.studioWidget.referenceLayers.layers.map(item => ({ ...item })))).toEqual(layers);
  expect(uploads).toBe(0);
  page.off("request", countUploads);

  // Failed storage: useful message, previous state and workflow untouched.
  await page.route("**/vnccs/pose_reference_asset", route => route.request().method() === "POST"
    ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "No space left on device" }) })
    : route.continue());
  const stateBefore = await workflowText(page);
  await page.setInputFiles(".vnccs-ps-reflayer-file", (await makeImages(page)).slice(1, 2));
  await expect(page.locator(".vnccs-ps-modal-content").filter({ hasText: "No space left on device" })).toHaveCount(1, { timeout: 30_000 });
  expect(await page.evaluate(() => window.__node.studioWidget.referenceLayers.layers.length)).toBe(3);
  expect(await workflowText(page)).toBe(stateBefore);

  // An inline image from an older workflow stays embedded while storage fails...
  const dataUrl = await page.evaluate(async asset => {
    const blob = await (await fetch(`/vnccs/pose_reference_asset/${asset}`)).blob();
    return await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  }, layers[1].asset);
  const legacy = JSON.parse(saved);
  for (const node of legacy.nodes.filter(item => item.type === "VNCCS_PoseStudio")) {
    const data = JSON.parse(node.widgets_values[0]);
    data.reference_layers[1] = { ...data.reference_layers[1], asset: undefined, src: dataUrl };
    node.widgets_values[0] = JSON.stringify(data);
    if (node.widgets_values_named?.pose_data) node.widgets_values_named.pose_data = node.widgets_values[0];
  }
  await loadWorkflow(page, legacy);
  await expect.poll(() => page.evaluate(() => document.querySelector(".vnccs-ps-modal-content")?.textContent || ""), { timeout: 30_000 }).toContain("embedded");
  expect(await page.evaluate(() => window.__node.studioWidget.referenceLayers.layers[1].src?.slice(0, 15))).toBe("data:image/webp");

  // ...and moves to storage when it works, keeping its place and asset identity.
  await page.unroute("**/vnccs/pose_reference_asset");
  await loadWorkflow(page, legacy);
  await page.waitForFunction(() => window.__node.studioWidget.referenceLayers.layers.every(item => item.asset), null, { timeout: 30_000 });
  expect(await page.evaluate(() => window.__node.studioWidget.referenceLayers.layers.map(item => ({ ...item })))).toEqual(layers);
  expect(await page.evaluate(() => window.__node.widgets[0].value.includes("data:image"))).toBe(false);
});

test("reference layers: a locked layer ignores Reset, with real clicks", async ({ page }) => {
  test.setTimeout(240_000);
  await openPoseStudio(page);
  await addLayers(page);
  await page.evaluate(() => {
    const c = window.__node.studioWidget.referenceLayers;
    c.edit(c.selectedId, { x: 0.2, y: -0.1, rotation: 30, scale: 0.4, opacity: 0.7 });
  });
  await clickAt(page, page.locator('.vnccs-ps-reflayer-row.selected button[data-action="Lock"]'));
  const locked = await layerState(page);
  expect(locked.locked).toBe(true);
  const resets = page.locator(".vnccs-ps-reflayer-props .vnccs-ps-reset-btn");
  expect(await resets.count()).toBe(4);
  for (let i = 0; i < 4; i += 1) {
    await expect(resets.nth(i)).toBeDisabled();
    await resets.nth(i).scrollIntoViewIfNeeded();
    await clickAt(page, resets.nth(i));
  }
  expect(await layerState(page)).toEqual(locked);
  // The handler refuses too, whatever calls it.
  await page.evaluate(() => {
    const c = window.__node.studioWidget.referenceLayers;
    for (const kind of ["position", "scale", "rotation", "opacity"]) c.resetTransform(kind);
    c.edit(c.selectedId, { x: 0 });
  });
  expect(await layerState(page)).toEqual(locked);
  await clickAt(page, page.locator('.vnccs-ps-reflayer-row.selected button[data-action="Unlock"]'));
  await resets.nth(1).scrollIntoViewIfNeeded();
  await expect(resets.nth(1)).toBeEnabled();
  await clickAt(page, resets.nth(1));
  const reset = await layerState(page);
  expect([reset.x, reset.y, reset.rotation]).toEqual([0, 0, 30]);
});

test("reference layers: 55 import and delete cycles release textures and sources", async ({ page }) => {
  test.setTimeout(300_000);
  await openPoseStudio(page);
  await page.waitForTimeout(1000);
  const textures = () => page.evaluate(() => window.__node.studioWidget.viewer.renderer.info.memory.textures);
  const baseline = await textures();
  const image = (await makeImages(page))[1];
  for (let cycle = 0; cycle < 55; cycle += 1) {
    await page.setInputFiles(".vnccs-ps-reflayer-file", { ...image, name: `cycle_${cycle}.png` });
    await page.waitForFunction(() => {
      const c = window.__node.studioWidget.referenceLayers;
      return c.layers.length === 1 && [...c.entries.values()].every(entry => entry.ready);
    }, null, { timeout: 30_000 });
    await page.evaluate(() => {
      const c = window.__node.studioWidget.referenceLayers;
      c.removeLayer(c.layers[0].id);
    });
  }
  await page.waitForTimeout(500);
  const state = await page.evaluate(() => {
    const w = window.__node.studioWidget, c = w.referenceLayers;
    return {
      layers: c.layers.length, entries: c.entries.size, meshes: c.group.children.length, images: c.images === undefined,
      history: w.viewer.history.length, historyChars: w.viewer.history.join("").length,
      inline: w.viewer.history.some(entry => entry.includes("data:image")),
      rows: c.ui.list.children.length,
    };
  });
  expect(state).toMatchObject({ layers: 0, entries: 0, meshes: 0, images: true, history: 10, inline: false, rows: 0 });
  expect(await textures()).toBe(baseline);
  // Undo inside the available window still restores the image from durable storage.
  await page.evaluate(() => window.__node.studioWidget.viewer.undo());
  await page.waitForFunction(() => {
    const c = window.__node.studioWidget.referenceLayers;
    return c.layers.length === 1 && [...c.entries.values()].every(entry => entry.ready);
  }, null, { timeout: 30_000 });
  expect(await textures()).toBe(baseline + 1);
  await page.evaluate(() => window.__node.studioWidget.viewer.undo());
  await page.evaluate(() => window.__node.studioWidget.clearPoseHistory());
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__node.studioWidget.viewer.history.length)).toBe(0);
  expect(await textures()).toBe(baseline);
});

test("reference layers: panel controls stay inside the section at default and narrow sizes", async ({ page }) => {
  test.setTimeout(240_000);
  await openPoseStudio(page);
  await addLayers(page);
  await page.evaluate(() => {
    const c = window.__node.studioWidget.referenceLayers;
    c.edit(c.selectedId, { flipX: true });
  });
  const audit = () => page.evaluate(() => {
    const c = window.__node.studioWidget.referenceLayers;
    const content = c.section.content.getBoundingClientRect();
    const shown = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const controls = [...c.section.content.querySelectorAll("button, input:not([type=file]), img, .vnccs-ps-label, .vnccs-ps-reflayer-name")].filter(shown);
    const problems = [];
    const describe = el => `${el.tagName} ${el.className} ${el.title || el.textContent}`;
    for (const el of controls) {
      const r = el.getBoundingClientRect();
      if (r.left < content.left - 0.5 || r.right > content.right + 0.5 || r.bottom > content.bottom + 0.5) problems.push(`outside: ${describe(el)}`);
      if (el.tagName === "BUTTON" && el.scrollWidth > el.clientWidth + 1) problems.push(`clipped: ${describe(el)}`);
    }
    controls.forEach((first, i) => controls.slice(i + 1).forEach(second => {
      if (first.contains(second) || second.contains(first)) return;
      const a = first.getBoundingClientRect(), b = second.getBoundingClientRect();
      if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) problems.push(`overlap: ${describe(first)} / ${describe(second)}`);
    }));
    const right = selector => new Set([...c.section.content.querySelectorAll(selector)].map(el => el.getBoundingClientRect().right.toFixed(1))).size;
    return { problems, resetColumns: right(".vnccs-ps-reflayer-props .vnccs-ps-reset-btn"), valueColumns: right(".vnccs-ps-label-row .vnccs-ps-reflayer-value") };
  });
  // 900x740 is the size of a new node.
  for (const size of [[1400, 880], [900, 740], [560, 740]]) {
    await page.evaluate(next => window.__node.setSize(next), size);
    await page.waitForTimeout(1000);
    expect(await audit()).toEqual({ problems: [], resetColumns: 1, valueColumns: 1 });
    await page.evaluate(() => {
      const c = window.__node.studioWidget.referenceLayers;
      c.startRename(c.selectedId);
    });
    await page.waitForTimeout(100);
    expect(await audit()).toEqual({ problems: [], resetColumns: 1, valueColumns: 1 });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    await page.evaluate(() => window.__node.studioWidget.referenceLayers.renamingId && window.__node.studioWidget.referenceLayers.finishRename(window.__node.studioWidget.referenceLayers.renamingId, ""));
  }
});
