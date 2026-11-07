import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";

// Pose Studio capture lens on a real ComfyUI graph node: standard slider and value-label
// behaviour, the Camera Angle controls, editor camera Undo, and geometry at three depths
// measured in the viewport cameras and in real RUN output. RUN uses only Pose Studio's CPU
// capture path; nothing downloads models.

test.use({ viewport: { width: 1600, height: 1000 } });

async function openPoseStudio(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window.comfyAPI?.app?.app ?? window.app)?.graph && window.LiteGraph, null, { timeout: 120_000 });
  // Extensions register after the graph exists; a node created earlier never gets its widget.
  await page.waitForTimeout(5000);
  for (let i = 0; i < 3; i += 1) { await page.keyboard.press("Escape"); await page.waitForTimeout(150); }
  await page.evaluate(async () => {
    const app = window.comfyAPI?.app?.app ?? window.app;
    await app.extensionManager?.setting?.set?.("Comfy.Minimap.Visible", false)?.catch?.(() => {});
    app.graph.clear();
    const studio = window.LiteGraph.createNode("VNCCS_PoseStudio");
    studio.pos = [0, 0];
    app.graph.add(studio);
    const save = window.LiteGraph.createNode("SaveImage");
    save.pos = [1520, 0];
    app.graph.add(save);
    studio.connectByType(0, save, "IMAGE");
    studio.setSize([1420, 900]);
    app.canvas.ds.scale = 1;
    app.canvas.ds.offset = [60, 60];
    app.canvas.setDirty(true, true);
    window.__node = studio;
  });
  await page.waitForFunction(() => window.__node?.studioWidget?.viewer?.skinnedMesh, null, { timeout: 120_000 });
  await page.waitForTimeout(800);
}

/** Open Camera Angle and return the element handles' ids used by the tests. */
async function openCameraAngle(page) {
  await page.evaluate(() => {
    const w = window.__node.studioWidget;
    const slider = w.exportWidgets.cam_fov_deg;
    const section = slider.closest(".vnccs-ps-section");
    if (!section.classList.contains("open")) section.querySelector(".vnccs-ps-section-title, .vnccs-ps-section-header")?.click();
    slider.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(200);
}

const lens = page => page.evaluate(() => {
  const w = window.__node.studioWidget, v = w.viewer;
  const rows = ["cam_fov_deg", "cam_distance"].map(key => {
    const slider = w.exportWidgets[key];
    const field = slider.closest(".vnccs-ps-field");
    return {
      key,
      param: w.exportParams[key],
      slider: slider.value,
      labelValue: slider._vnccsValueSpan.innerText,
      numberInputs: field.querySelectorAll('input[type="number"]').length,
      readOnlyValues: field.querySelectorAll(".vnccs-ps-value").length,
      sliderStep: slider.step,
    };
  });
  return {
    rows,
    captureFov: v.captureCamera.fov,
    editorFov: v.camera.fov,
    editorZoom: v.camera.zoom,
    editorDistance: v.camera.position.distanceTo(v.orbit.target),
    captureDistance: v.captureCamera.position.distanceTo(v.sceneCameraTarget),
  };
});

const clickCenter = async (page, locator) => {
  const box = await locator.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

test("capture lens: standard camera sliders and value labels stay in sync", async ({ page }) => {
  test.setTimeout(180_000);
  await openPoseStudio(page);
  await openCameraAngle(page);
  const before = await lens(page);
  for (const row of before.rows) {
    expect(row.numberInputs, `${row.key} uses the standard value label`).toBe(0);
    expect(row.readOnlyValues, `${row.key} has one value label`).toBe(1);
    expect(Number(row.sliderStep)).toBe(0.1);
  }

  // Same row and aligned: label, value and reset button.
  const geometry = await page.evaluate(() => ["cam_fov_deg", "cam_distance"].map(key => {
    const w = window.__node.studioWidget, slider = w.exportWidgets[key], value = slider._vnccsValueSpan;
    const field = slider.closest(".vnccs-ps-field");
    const rect = element => element.getBoundingClientRect();
    const reset = field.querySelector(".vnccs-ps-reset-btn");
    const center = element => rect(element).top + rect(element).height / 2;
    return {
      valueCenter: center(value), resetCenter: center(reset),
      valueRight: rect(value).right, resetLeft: rect(reset).left,
      valueWidth: rect(value).width, fieldWidth: rect(field).width,
      sliderBottom: rect(slider).bottom, fieldBottom: rect(field).bottom,
    };
  }));
  for (const row of geometry) {
    expect(Math.abs(row.valueCenter - row.resetCenter)).toBeLessThan(2);
    expect(row.valueRight).toBeLessThanOrEqual(row.resetLeft);
    expect(row.valueWidth).toBeLessThan(row.fieldWidth / 2);
    expect(row.sliderBottom).toBeLessThanOrEqual(row.fieldBottom + 1);
  }

  // The standard range also supports the same keyboard controls as Yaw/Pitch.
  await page.evaluate(() => window.__node.studioWidget.exportWidgets.cam_distance.focus());
  for (const [key, expected] of [["End", 250], ["Home", 10], ["ArrowRight", 10.1]]) {
    await page.keyboard.press(key);
    const live = await lens(page);
    expect(live.rows[1].param).toBe(expected);
    expect(live.rows[1].labelValue).toBe(expected.toFixed(2));
    expect(live.captureDistance).toBeCloseTo(expected, 5);
  }

  // A real slider drag updates the value label on every step.
  const box = await page.evaluate(() => {
    const rect = window.__node.studioWidget.exportWidgets.cam_fov_deg.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.down();
  const seen = [];
  for (let i = 1; i <= 6; i += 1) {
    await page.mouse.move(box.x + box.width * (0.2 + i * 0.1), box.y + box.height / 2);
    const state = await lens(page);
    expect(state.rows[0].labelValue).toBe(state.rows[0].param.toFixed(2));
    expect(state.captureFov).toBe(state.rows[0].param);
    seen.push(state.rows[0].param);
  }
  await page.mouse.up();
  for (let i = 1; i < seen.length; i += 1) expect(seen[i]).toBeGreaterThan(seen[i - 1]);

  await page.screenshot({ path: test.info().outputPath("camera-angle.png") });
});

test("capture lens: Undo and Redo restore the editor camera", async ({ page }) => {
  test.setTimeout(180_000);
  await openPoseStudio(page);
  await openCameraAngle(page);
  const start = await lens(page);
  expect(start.captureFov).toBe(30);
  expect(start.editorFov).toBeCloseTo(45, 5);
  await page.evaluate(() => {
    const slider = window.__node.studioWidget.exportWidgets.cam_fov_deg;
    slider.value = "62";
    slider.dispatchEvent(new Event("input"));
    slider.dispatchEvent(new Event("change"));
  });
  const wide = await lens(page);
  expect(wide.captureFov).toBe(62);
  expect(wide.editorFov).toBeCloseTo(85.77, 1);

  await page.evaluate(() => window.__node.studioWidget.viewer.undo());
  const undone = await lens(page);
  expect(undone.captureFov).toBe(30);
  expect(undone.editorFov).toBeCloseTo(start.editorFov, 5);
  expect(undone.editorZoom).toBeCloseTo(start.editorZoom, 5);
  expect(undone.editorDistance).toBeCloseTo(start.editorDistance, 5);
  expect(undone.rows[0].labelValue).toBe("30.00");
  expect(Number(undone.rows[0].slider)).toBe(30);

  await page.evaluate(() => window.__node.studioWidget.viewer.redo());
  const redone = await lens(page);
  expect(redone.captureFov).toBe(62);
  expect(redone.editorFov).toBeCloseTo(wide.editorFov, 5);
});

// Three mannequins side by side at different depths, on a black background.
async function buildDepthScene(page) {
  await page.evaluate(async () => {
    const w = window.__node.studioWidget;
    await w.addCharacter();
    await w.addCharacter();
    const placements = [{ x: -10, z: 5 }, { x: 0, z: 0 }, { x: 10, z: -5 }];
    Object.assign(w.exportParams, { view_width: 1536, view_height: 1024, bg_color: [0, 0, 0] });
    for (let i = 0; i < w.characters.length; i += 1) {
      await w.selectCharacter(w.characters[i].id);
      const character = w.getActiveCharacter();
      character.transform = { ...character.transform, ...placements[i], y: 0, zoom: 1 };
      w.viewer.setActiveCharacterAppearance({ color: character.color, transform: character.transform });
      w.exportParams.cam_offset_x = placements[i].x;
      w.exportParams.cam_offset_y = 0;
      w.persistActivePoseCameraParams();
    }
    w.applyCameraToViewer(true);
    w.syncToNode(true);
  });
  await page.waitForFunction(() => !window.__node.studioWidget._switchingCharacter, null, { timeout: 60_000 });
  await page.waitForTimeout(500);
}

const setLens = (page, { fov, distance = null, maintain = false }) => page.evaluate(({ fov, distance, maintain }) => {
  const w = window.__node.studioWidget;
  const maintainBox = w.exportWidgets.cam_maintain_subject_size;
  if (maintainBox.checked !== maintain) {
    maintainBox.checked = maintain;
    maintainBox.dispatchEvent(new Event("change"));
  }
  const apply = (key, value) => {
    const slider = w.exportWidgets[key];
    slider.value = String(value);
    slider.dispatchEvent(new Event("input"));
    slider.dispatchEvent(new Event("change"));
  };
  apply("cam_fov_deg", fov);
  if (distance !== null) apply("cam_distance", distance);
}, { fov, distance, maintain });

/** Each figure's height through the capture and viewport cameras, nearest figure first. */
const projectedFigures = page => page.evaluate(() => {
  const w = window.__node.studioWidget, v = w.viewer, T = v.THREE;
  const meshes = [v.skinnedMesh, ...Array.from(v.passiveCharacters.values(), entry => entry.mesh)];
  v.scene.updateMatrixWorld(true);
  const figures = meshes.map(mesh => {
    const box = new T.Box3().setFromObject(mesh);
    const center = box.getCenter(new T.Vector3());
    const project = camera => {
      camera.updateMatrixWorld(true);
      const top = new T.Vector3(center.x, box.max.y, center.z).project(camera);
      const bottom = new T.Vector3(center.x, box.min.y, center.z).project(camera);
      return { height: Math.abs(top.y - bottom.y), x: (top.x + 1) / 2 };
    };
    const capture = project(v.captureCamera);
    const side = new T.Vector3(center.x + 1.2, center.y, center.z).project(v.captureCamera);
    const middle = new T.Vector3(center.x, center.y, center.z).project(v.captureCamera);
    return { z: center.z, capture: capture.height, viewport: project(v.camera).height, x: capture.x, band: Math.abs(side.x - middle.x) / 2 };
  }).sort((a, b) => b.z - a.z);
  return {
    figures,
    fov: w.exportParams.cam_fov_deg,
    distance: w.exportParams.cam_distance,
    cameraPosition: v.captureCamera.position.toArray(),
  };
});

/** Queue the graph and measure each figure's height in the real output PNG. */
async function runAndMeasure(page, outputName, figures) {
  const known = new Set(Object.keys(await page.evaluate(async () => (await (await fetch("/history?max_items=200")).json()))));
  await page.evaluate(() => (window.comfyAPI?.app?.app ?? window.app).queuePrompt(0, 1));
  let image = null;
  for (let i = 0; i < 90 && !image; i += 1) {
    const history = await page.evaluate(async () => (await (await fetch("/history?max_items=200")).json()));
    const fresh = Object.entries(history).find(([id]) => !known.has(id));
    if (fresh?.[1].status?.status_str === "error") throw new Error(JSON.stringify(fresh[1].status));
    if (fresh?.[1].status?.completed) image = Object.values(fresh[1].outputs).flatMap(output => output.images || [])[0];
    else await page.waitForTimeout(1000);
  }
  expect(image, `${outputName} finished`).toBeTruthy();
  const measured = await page.evaluate(async ({ image, figures }) => {
    const url = `/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder)}&type=${image.type}`;
    const blob = await (await fetch(url)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const heights = figures.map(figure => {
      const left = Math.max(0, Math.round((figure.x - figure.band) * width));
      const right = Math.min(width - 1, Math.round((figure.x + figure.band) * width));
      let top = -1, bottom = -1;
      for (let y = 0; y < height; y += 1) {
        for (let x = left; x <= right; x += 1) {
          const i = (y * width + x) * 4;
          if (Math.max(data[i], data[i + 1], data[i + 2]) < 12) continue;
          if (top < 0) top = y;
          bottom = y;
          break;
        }
      }
      return top < 0 ? 0 : bottom - top + 1;
    });
    return { width, height, heights, dataUrl: canvas.toDataURL("image/png") };
  }, { image, figures });
  await writeFile(test.info().outputPath(`${outputName}.png`), Buffer.from(measured.dataUrl.split(",")[1], "base64"));
  delete measured.dataUrl;
  return measured;
}

test("capture lens: geometry at different depths in the viewport and in RUN output", async ({ page }) => {
  test.setTimeout(420_000);
  const errors = [];
  page.on("pageerror", error => errors.push(String(error).split("\n")[0]));
  await openPoseStudio(page);
  await buildDepthScene(page);

  const cases = [
    { name: "base-fov30-d45", fov: 30, distance: 45 },
    { name: "fov45-d45", fov: 45, distance: 45 },
    { name: "maintain-fov15", fov: 15, maintain: true },
    { name: "maintain-fov60", fov: 60, maintain: true },
  ];
  const results = {};
  for (const item of cases) {
    await setLens(page, { fov: 30, distance: 45, maintain: false });
    await setLens(page, { fov: item.fov, distance: item.maintain ? null : item.distance, maintain: !!item.maintain });
    await page.waitForTimeout(400);
    const viewport = await page.evaluate(() => {
      const rect = window.__node.studioWidget.viewer.canvas.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    await page.screenshot({ path: test.info().outputPath(`${item.name}-viewport.png`), clip: viewport });
    const projected = await projectedFigures(page);
    const output = await runAndMeasure(page, `${item.name}-run`, projected.figures);
    results[item.name] = { projected, output };
  }
  await writeFile(test.info().outputPath("lens-measurements.json"), JSON.stringify(results, null, 2));
  const summary = Object.fromEntries(Object.entries(results).map(([name, { projected, output }]) => [name, {
    fov: projected.fov,
    distance: Number(projected.distance.toFixed(2)),
    runHeightsPx: output.heights,
    runNearFar: Number((output.heights[0] / output.heights[2]).toFixed(3)),
    captureNearFar: Number((projected.figures[0].capture / projected.figures[2].capture).toFixed(3)),
    viewportNearFar: Number((projected.figures[0].viewport / projected.figures[2].viewport).toFixed(3)),
  }]));
  console.log(JSON.stringify(summary));

  const base = results["base-fov30-d45"], fov45 = results["fov45-d45"];
  const wide = results["maintain-fov60"], tele = results["maintain-fov15"];
  const nearFar = (value, key) => value.projected.figures[0][key] / value.projected.figures[2][key];
  const pixelNearFar = value => value.output.heights[0] / value.output.heights[2];

  // FOV at a fixed camera position changes the framing; proportions stay.
  expect(fov45.projected.cameraPosition).toEqual(base.projected.cameraPosition);
  expect(fov45.projected.figures[1].capture).toBeLessThan(base.projected.figures[1].capture * 0.75);
  expect(fov45.output.heights[1]).toBeLessThan(base.output.heights[1] * 0.75);
  expect(nearFar(fov45, "capture")).toBeCloseTo(nearFar(base, "capture"), 3);
  expect(nearFar(fov45, "viewport")).toBeCloseTo(nearFar(base, "viewport"), 3);
  expect(Math.abs(pixelNearFar(fov45) - pixelNearFar(base)) / pixelNearFar(base)).toBeLessThan(0.05);

  // Maintain Subject Size: the middle figure keeps its size; near and far proportions change.
  for (const lensCase of [wide, tele]) {
    expect(lensCase.projected.figures[1].capture).toBeCloseTo(base.projected.figures[1].capture, 3);
    expect(lensCase.projected.figures[1].viewport).toBeCloseTo(base.projected.figures[1].viewport, 3);
    expect(nearFar(lensCase, "viewport")).toBeCloseTo(nearFar(lensCase, "capture"), 3);
    expect(Math.abs(lensCase.output.heights[1] - base.output.heights[1]) / base.output.heights[1]).toBeLessThan(0.05);
  }
  expect(nearFar(wide, "capture")).toBeGreaterThan(nearFar(base, "capture") * 1.2);
  expect(nearFar(tele, "capture")).toBeLessThan(nearFar(base, "capture") * 0.95);
  expect(pixelNearFar(wide)).toBeGreaterThan(pixelNearFar(base) * 1.15);
  expect(pixelNearFar(tele)).toBeLessThan(pixelNearFar(base) * 0.95);
  expect(errors).toEqual([]);
});
