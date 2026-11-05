import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";

// Pose Studio additional outputs on a real ComfyUI graph: hidden by default, enabled in
// Settings, links kept when the socket list changes or a workflow is restored, and the
// right image on every link in real RUN output. RUN uses only Pose Studio's CPU capture
// path; nothing downloads models.

test.use({ viewport: { width: 1600, height: 1000 } });

const BASE = ["images", "lighting_prompt"];
const ALL = ["depth", "normal", "outline", "silhouette", "mask", "character_id"];

async function openPoseStudio(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window.comfyAPI?.app?.app ?? window.app)?.graph && window.LiteGraph, null, { timeout: 120_000 });
  // Extensions register after the graph exists; a node created earlier never gets its widget.
  await page.waitForTimeout(5000);
  for (let i = 0; i < 3; i += 1) { await page.keyboard.press("Escape"); await page.waitForTimeout(150); }
  await page.evaluate(() => {
    const app = window.comfyAPI?.app?.app ?? window.app;
    app.graph.clear();
    const studio = window.LiteGraph.createNode("VNCCS_PoseStudio");
    studio.pos = [0, 0];
    app.graph.add(studio);
    studio.setSize([1000, 760]);
    app.canvas.ds.scale = 0.8;
    app.canvas.ds.offset = [90, 70];
    app.canvas.setDirty(true, true);
    window.__node = studio;
    window.__app = app;
    window.__saves = {};
    window.__addSave = (name, slotName) => {
      const node = window.__node;
      const save = window.LiteGraph.createNode("SaveImage");
      save.pos = [1080, Object.keys(window.__saves).length * 330];
      app.graph.add(save);
      const slot = node.outputs.findIndex(output => output.name === slotName);
      if (node.outputs[slot].type === "MASK") {
        const convert = window.LiteGraph.createNode("MaskToImage");
        convert.pos = [830, 800];
        app.graph.add(convert);
        node.connectByType(slot, convert, "MASK");
        convert.connectByType(0, save, "IMAGE");
      } else {
        node.connectByType(slot, save, "IMAGE");
      }
      window.__saves[name] = save.id;
    };
  });
  await page.waitForFunction(() => window.__node?.studioWidget?.viewer?.skinnedMesh, null, { timeout: 120_000 });
  await page.waitForTimeout(800);
}

const outputNames = page => page.evaluate(() => window.__node.outputs.map(output => output.name));

/** Socket state with the origin slot of every link, as a real graph records it. */
const sockets = page => page.evaluate(() => window.__node.outputs.map((output, slot) => ({
  name: output.name,
  slot,
  type: output.type,
  linkSlots: (output.links || []).map(id => window.__app.graph.links[id]?.origin_slot),
})));

const savedList = page => page.evaluate(() => JSON.parse(
  window.__node.widgets.find(widget => widget.name === "pose_data").value || "{}",
).export?.additional_outputs ?? []);

const openSettings = async page => {
  await page.evaluate(() => {
    document.querySelectorAll(".vnccs-ps-settings-panel").forEach(panel => panel.remove());
    window.__node.studioWidget.showSettingsModal();
  });
  await page.waitForSelector(".vnccs-ps-settings-panel");
};

const toggle = (page, name) => page.locator(`.vnccs-ps-settings-panel input[name="additional_output_${name}"]`).click();

/** Queue the graph; decoded output PNGs land in window.__images by SaveImage name. */
async function run(page) {
  const known = new Set(Object.keys(await page.evaluate(async () => (await (await fetch("/history?max_items=200")).json()))));
  await page.evaluate(() => window.__app.queuePrompt(0, 1));
  let outputs = null;
  for (let i = 0; i < 90 && !outputs; i += 1) {
    const history = await page.evaluate(async () => (await (await fetch("/history?max_items=200")).json()));
    const fresh = Object.entries(history).find(([id]) => !known.has(id));
    if (fresh?.[1].status?.status_str === "error") throw new Error(JSON.stringify(fresh[1].status).slice(0, 1500));
    if (fresh?.[1].status?.completed) outputs = fresh[1].outputs;
    else await page.waitForTimeout(1000);
  }
  expect(outputs, "RUN finished").toBeTruthy();
  await page.evaluate(async outputs => {
    window.__images = {};
    for (const [name, id] of Object.entries(window.__saves)) {
      const image = outputs[String(id)]?.images?.[0];
      if (!image) continue;
      const url = `/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder)}&type=${image.type}`;
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
      window.__images[name] = context.getImageData(0, 0, bitmap.width, bitmap.height);
    }
  }, outputs);
}

/** Classify an output by its pixels, so a wrong image on a link cannot pass. */
const classify = (page, name) => page.evaluate(name => {
  const image = window.__images[name];
  if (!image) return null;
  const { data, width, height } = image;
  let covered = 0, binary = 0, gray = 0, palette = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    if (r || g || b) covered += 1;
    if ((r === 0 || r === 255) && r === g && g === b) binary += 1;
    if (r === g && g === b) gray += 1;
    if ([[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 0, 0]].some(c => c[0] === r && c[1] === g && c[2] === b)) palette += 1;
  }
  const total = width * height;
  return {
    width, height,
    covered: covered / total,
    allBinary: binary === total,
    allGray: gray === total,
    allPalette: palette === total,
  };
}, name);

const coveredSame = (page, a, b) => page.evaluate(([a, b]) => {
  const [x, y] = [window.__images[a].data, window.__images[b].data];
  let mismatch = 0;
  for (let i = 0; i < x.length; i += 4) {
    if (Boolean(x[i] || x[i + 1] || x[i + 2]) !== Boolean(y[i] || y[i + 1] || y[i + 2])) mismatch += 1;
  }
  return mismatch;
}, [a, b]);

/** One labelled image per link, for the PR evidence. */
async function saveOutputSheet(page, path) {
  const url = await page.evaluate(() => {
    const entries = Object.entries(window.__images);
    const cell = 360;
    const canvas = document.createElement("canvas");
    canvas.width = cell * entries.length;
    canvas.height = cell + 28;
    const context = canvas.getContext("2d");
    context.fillStyle = "#18181e";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = "16px sans-serif";
    entries.forEach(([name, image], index) => {
      const source = document.createElement("canvas");
      source.width = image.width;
      source.height = image.height;
      source.getContext("2d").putImageData(image, 0, 0);
      const scale = Math.min((cell - 8) / image.width, (cell - 8) / image.height);
      context.drawImage(source, cell * index + 4, 28, image.width * scale, image.height * scale);
      context.fillStyle = "#e6e6f0";
      context.fillText(name, cell * index + 8, 20);
    });
    return canvas.toDataURL("image/png");
  });
  await writeFile(path, Buffer.from(url.split(",")[1], "base64"));
}

test("a new node has two outputs, RUN does no extra work, and Settings lists the outputs", async ({ page }) => {
  await openPoseStudio(page);
  expect(await outputNames(page)).toEqual(BASE);
  expect(await savedList(page)).toEqual([]);

  await openSettings(page);
  const section = page.locator(".vnccs-ps-settings-panel .vnccs-ps-section", { hasText: "Additional Outputs" });
  await expect(section).toBeVisible();
  await expect(section).toContainText("Conditioning");
  for (const name of ALL) {
    await expect(section.locator(`input[name="additional_output_${name}"]`)).not.toBeChecked();
  }

  // Disabled outputs: no pass rendered or encoded, nothing extra uploaded.
  await page.evaluate(() => {
    const { viewer } = window.__node.studioWidget;
    const capture = viewer.captureConditioning;
    window.__passCaptures = 0;
    viewer.captureConditioning = (...args) => { window.__passCaptures += 1; return capture.apply(viewer, args); };
    const upload = window.fetch;
    window.__uploads = 0;
    window.fetch = (url, options) => {
      if (typeof options?.body === "string" && options.body.includes("captured_conditioning")) window.__uploads += 1;
      return upload(url, options);
    };
    window.__addSave("rgb", "images");
  });
  await run(page);
  expect(await page.evaluate(() => [window.__passCaptures, window.__uploads])).toEqual([0, 0]);
  expect((await classify(page, "rgb")).covered).toBeGreaterThan(0);
  expect(await outputNames(page)).toEqual(BASE);

  // Enabled without a link: the socket exists, and RUN still does no extra work.
  await toggle(page, "silhouette");
  expect(await outputNames(page)).toEqual([...BASE, "silhouette"]);
  await run(page);
  expect(await page.evaluate(() => [window.__passCaptures, window.__uploads])).toEqual([0, 0]);

  // Adding the link saves it at once, and the next RUN renders that output.
  await page.evaluate(() => window.__addSave("silhouette", "silhouette"));
  expect(await page.evaluate(() => JSON.parse(
    window.__node.widgets.find(widget => widget.name === "pose_data").value,
  ).export.linked_additional_outputs)).toEqual(["silhouette"]);
  await run(page);
  expect(await page.evaluate(() => window.__passCaptures)).toBeGreaterThan(0);
  expect((await classify(page, "silhouette")).allBinary).toBe(true);
});

test("enabled outputs carry the right image, and disabling one keeps the other links", async ({ page }, testInfo) => {
  await openPoseStudio(page);
  await openSettings(page);

  // Sockets change on the click, with the panel still open.
  await toggle(page, "mask");
  expect(await outputNames(page)).toEqual([...BASE, "mask"]);
  await toggle(page, "depth");
  await toggle(page, "outline");
  expect(await outputNames(page)).toEqual([...BASE, "mask", "depth", "outline"]);
  expect(await savedList(page)).toEqual(["mask", "depth", "outline"]);

  await page.evaluate(() => {
    window.__addSave("rgb", "images");
    window.__addSave("mask", "mask");
    window.__addSave("depth", "depth");
    window.__addSave("outline", "outline");
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: testInfo.outputPath("additional-outputs-settings.png") });

  await run(page);
  await saveOutputSheet(page, testInfo.outputPath("additional-outputs-run.png"));
  const mask = await classify(page, "mask");
  expect(mask.allBinary, "mask link receives a binary image").toBe(true);
  expect(mask.covered).toBeGreaterThan(0.01);
  const depth = await classify(page, "depth");
  expect(depth.allGray, "depth link receives a gray image").toBe(true);
  expect(depth.allBinary, "depth link is not the mask").toBe(false);
  const outline = await classify(page, "outline");
  expect(outline.allBinary).toBe(true);
  expect(outline.covered).toBeLessThan(mask.covered / 2);
  expect(await coveredSame(page, "mask", "depth"), "mask and depth cover the same pixels").toBe(0);

  // Remove the middle socket: its link goes, later links shift with their output.
  await page.evaluate(() => {
    const app = window.__app;
    app.graph.remove(app.graph.getNodeById(window.__saves.depth));
    delete window.__saves.depth;
  });
  await toggle(page, "depth");
  expect(await sockets(page)).toEqual([
    { name: "images", slot: 0, type: "IMAGE", linkSlots: [0] },
    { name: "lighting_prompt", slot: 1, type: "STRING", linkSlots: [] },
    { name: "mask", slot: 2, type: "MASK", linkSlots: [2] },
    { name: "outline", slot: 3, type: "IMAGE", linkSlots: [3] },
  ]);
  expect(await savedList(page)).toEqual(["mask", "outline"]);
  await run(page);
  expect((await classify(page, "mask")).covered).toBeCloseTo(mask.covered, 5);
  expect((await classify(page, "outline")).covered).toBeCloseTo(outline.covered, 5);

  // An enabled output without a link and all links survive a save and reload.
  await toggle(page, "character_id");
  const saved = await sockets(page);
  await page.evaluate(async () => {
    const app = window.__app;
    const nodeId = window.__node.id;
    await app.loadGraphData(app.graph.serialize());
    window.__node = app.graph.getNodeById(nodeId);
  });
  await page.waitForFunction(() => window.__node?.studioWidget?.viewer?.skinnedMesh, null, { timeout: 120_000 });
  await page.waitForTimeout(800);
  expect(await sockets(page)).toEqual(saved);
  await openSettings(page);
  await expect(page.locator('.vnccs-ps-settings-panel input[name="additional_output_character_id"]')).toBeChecked();
  await expect(page.locator('.vnccs-ps-settings-panel input[name="additional_output_depth"]')).not.toBeChecked();
  await run(page);
  expect((await classify(page, "outline")).covered).toBeCloseTo(outline.covered, 5);
});

test("a workflow saved with all eight sockets keeps its link on the right output", async ({ page }) => {
  await openPoseStudio(page);
  await openSettings(page);
  await toggle(page, "character_id");
  await page.evaluate(() => {
    window.__addSave("rgb", "images");
    window.__addSave("ids", "character_id");
  });
  // Rewrite the workflow to the earlier shape: eight sockets, a link on slot 7, no saved list.
  await page.evaluate(async () => {
    const app = window.__app;
    const data = JSON.parse(JSON.stringify(app.graph.serialize()));
    const nodeId = window.__node.id;
    const node = data.nodes.find(entry => String(entry.id) === String(nodeId));
    if (!node) throw new Error(`node ${nodeId} missing from ${JSON.stringify(data.nodes.map(entry => entry.id))}`);
    const old = node.outputs.find(output => output.name === "character_id");
    const list = ["depth", "normal", "outline", "silhouette", "mask", "character_id"];
    node.outputs = [
      ...node.outputs.slice(0, 2),
      ...list.map((name, index) => ({
        name,
        type: name === "mask" ? "MASK" : "IMAGE",
        shape: 6,
        slot_index: index + 2,
        links: name === "character_id" ? old.links : [],
      })),
    ];
    for (const link of data.links) if (old.links.includes(link[0])) link[2] = 7;
    const index = node.widgets_values.findIndex(value => typeof value === "string" && value.includes("additional_outputs"));
    const pose = JSON.parse(node.widgets_values[index]);
    delete pose.export.additional_outputs;
    pose.export.conditioning_outputs = ["character_id"];
    node.widgets_values[index] = JSON.stringify(pose);
    await app.loadGraphData(data);
    window.__node = app.graph.getNodeById(nodeId);
  });
  await page.waitForFunction(() => window.__node?.studioWidget?.viewer?.skinnedMesh, null, { timeout: 120_000 });
  await page.waitForTimeout(800);
  expect(await sockets(page)).toEqual([
    { name: "images", slot: 0, type: "IMAGE", linkSlots: [0] },
    { name: "lighting_prompt", slot: 1, type: "STRING", linkSlots: [] },
    { name: "character_id", slot: 2, type: "IMAGE", linkSlots: [2] },
  ]);
  await run(page);
  const ids = await classify(page, "ids");
  expect(ids.allPalette, "the link receives Character ID colours").toBe(true);
  expect(ids.covered).toBeGreaterThan(0.01);
  expect(await savedList(page)).toEqual(["character_id"]);
});

test("crop outputs: enabled in their group, and crop_image has the size of the guide", async ({ page }, testInfo) => {
  await openPoseStudio(page);
  await openSettings(page);
  const section = page.locator(".vnccs-ps-settings-panel .vnccs-ps-section", { hasText: "Additional Outputs" });
  await expect(section).toContainText("Crop Guide");
  await toggle(page, "crop_json");
  await toggle(page, "crop_image");
  await toggle(page, "crop_preview");
  expect(await outputNames(page)).toEqual([...BASE, "crop_json", "crop_image", "crop_preview"]);
  await page.evaluate(() => {
    const w = window.__node.studioWidget;
    w.setCropGuide(0, { schema_version: 1, enabled: true, x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
    window.__addSave("rgb", "images");
    window.__addSave("crop", "crop_image");
    window.__addSave("preview", "crop_preview");
  });
  await run(page);
  await saveOutputSheet(page, testInfo.outputPath("crop-outputs.png"));
  const [rgb, crop] = [await classify(page, "rgb"), await classify(page, "crop")];
  expect(crop.width).toBe(Math.ceil(rgb.width * 0.5));
  expect(crop.height).toBe(Math.ceil(rgb.height * 0.5));
  expect(rgb.width).toBeGreaterThan(crop.width);
});

test("a two-output workflow stays as it is", async ({ page }) => {
  await openPoseStudio(page);
  await page.evaluate(async () => {
    window.__addSave("rgb", "images");
    const app = window.__app;
    const nodeId = window.__node.id;
    await app.loadGraphData(app.graph.serialize());
    window.__node = app.graph.getNodeById(nodeId);
  });
  await page.waitForFunction(() => window.__node?.studioWidget?.viewer?.skinnedMesh, null, { timeout: 120_000 });
  await page.waitForTimeout(800);
  expect(await sockets(page)).toEqual([
    { name: "images", slot: 0, type: "IMAGE", linkSlots: [0] },
    { name: "lighting_prompt", slot: 1, type: "STRING", linkSlots: [] },
  ]);
  await run(page);
  expect((await classify(page, "rgb")).covered).toBeGreaterThan(0);
});
