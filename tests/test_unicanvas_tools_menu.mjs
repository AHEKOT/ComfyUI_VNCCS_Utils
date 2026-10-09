import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { LAYER_MENU_ITEMS } from "../web/unicanvas/layer_tools.mjs";


const inputTools = await readFile(new URL("../web/unicanvas/input_tools.mjs", import.meta.url), "utf8");
const layerTools = await readFile(new URL("../web/unicanvas/layer_tools.mjs", import.meta.url), "utf8");
const widgetSource = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");

const MENU_LABELS = [
  "Duplicate layer",
  "Move up",
  "Move down",
  "Copy to clipboard",
  "Save image",
  "Remove background",
  "Remove background (prompt)...",
  "Color match to below",
  "Auto-name",
  "Edit pose",
  "Rasterize",
];

const MENU_GROUPS = [
  "Layer", "Layer", "Layer",
  "Content", "Content",
  "Enhance", "Enhance", "Enhance",
  "Name",
  "Pose", "Pose",
];

test("widget source installs both tool packs", () => {
  assert.match(widgetSource, /import \{ installUniCanvasInputTools \} from "\.\/unicanvas\/input_tools\.mjs(\?v=\d+)?";/);
  assert.match(widgetSource, /import \{ installUniCanvasLayerTools(?:, compositeBlendModeToPsd)? \} from "\.\/unicanvas\/layer_tools\.mjs(\?v=\d+)?";/);
  assert.match(widgetSource, /installUniCanvasInputTools\(this\);/);
  assert.match(widgetSource, /installUniCanvasLayerTools\(this\);/);
});

test("the radial HUD is the only right-button gesture (no Alt drag)", () => {
  assert.ok(!inputTools.includes("startBrushSizeGesture"), "the Alt brush-size gesture must be gone");
  assert.ok(inputTools.includes('BRUSH_FAMILY_TOOLS = new Set(["brush", "eraser", "mask"])'),
    "the brush family is exactly brush/eraser/mask");
  assert.match(inputTools, /if \(BRUSH_FAMILY_TOOLS\.has\(uc\.tool\)\) \{[\s\S]*?openRadialHud\(uc, e\);/,
    "right-button hold opens the HUD for brush-family tools only");
  assert.ok(!/if \(uc\.tool !== "sam"\) \{[\s\S]*?openRadialHud/.test(inputTools),
    "the old sam-only exclusion must be gone");
  assert.ok(inputTools.includes('kind: "hud"'), "the HUD gesture must exist");
  assert.ok(inputTools.includes("RADIAL_HUD_SIZE_SENSITIVITY = 0.5"), "HUD size sector sensitivity must stay at ~0.5 px radius per pointer px");
  assert.ok(inputTools.includes("uc.hoverPoint = uc.worldFromCanvasPoint(gesture.lastScreen)"), "the preview circle must track the cursor during the gesture");
});

test("radial HUD maps the four drag directions to parameters", () => {
  assert.ok(inputTools.includes('direction: "up", key: "size"'), "up must adjust size");
  assert.ok(inputTools.includes('direction: "right", key: "opacity"'), "right must adjust opacity");
  assert.ok(inputTools.includes('direction: "down", key: "hardness"'), "down must adjust hardness");
  assert.ok(inputTools.includes('direction: "left", key: "color"'), "left must adjust the foreground color");
});

test("brushHardness is a brush-engine setting with radial-gradient stamps", () => {
  assert.ok(inputTools.includes("brushHardness"), "brushHardness setting must exist");
  assert.ok(inputTools.includes('data-control="brushHardness"'), "brushHardness needs a tool-settings slider");
  assert.ok(inputTools.includes("createRadialGradient"), "soft edges must use radial-gradient stamps");
  assert.match(inputTools, /addEventListener\("input"/, "the hardness slider must update continuously from input events");
});

test("layer context menu groups eleven labeled entries", () => {
  for (const label of MENU_LABELS) {
    assert.ok(layerTools.includes(`"${label}"`), `missing menu entry: ${label}`);
  }
  assert.equal(LAYER_MENU_ITEMS.length, 11, "the shipped menu must define exactly eleven entries");
  assert.deepEqual(LAYER_MENU_ITEMS.map((item) => item.label), MENU_LABELS, "shipped menu labels must match the spec strings in order");
  assert.deepEqual(LAYER_MENU_ITEMS.map((item) => item.group), MENU_GROUPS, "every menu entry must carry its group label");
  assert.deepEqual(LAYER_MENU_ITEMS.filter((item) => item.poseOnly).map((item) => item.id),
    ["edit-pose", "rasterize"], "only the pose entries keep the poseOnly gate");
  assert.match(layerTools, /vnccs-uc-layer-menu-group/, "group labels must render as their own small rows");
  assert.match(layerTools, /vnccs-uc-layer-menu-item/, "menu entries must stay addressable rows");
});

test("remove background runs through the settings-chosen backend", () => {
  assert.ok(layerTools.includes("resolveRemoveBgSelection"), "the backend must resolve from the widget settings");
  assert.ok(layerTools.includes("edit_model"), "the edit-model backend must forward its model choice");
  assert.ok(!layerTools.includes("remove-bg-qi21") && !layerTools.includes("remove-bg-birefnet"),
    "the three legacy remove-bg entries must be merged into one");
});

test("pose entries guard the parallel-branch methods with a status fallback", () => {
  assert.ok(layerTools.includes('typeof uc.rasterizePoseLayer === "function"'));
  assert.ok(layerTools.includes('typeof uc.editPoseLayer === "function"'));
  assert.ok(layerTools.includes("[VNCCS UniCanvas] Pose tools are not available."));
});

test("the PSD row is built once by the widget and wired through an explicit hook", () => {
  assert.ok(widgetSource.includes("vnccs-uc-psd-row"), "the grouped PSD row must be built in the footer");
  assert.ok(widgetSource.includes("vnccs-uc-psd-label"), "the row must carry the small PSD group label");
  assert.ok(widgetSource.includes("<span>Export</span>"), "the export button keeps its Export label");
  assert.ok(widgetSource.includes("<span>Import</span>"), "the import button keeps its Import label");
  assert.match(widgetSource, /this\.psdImportInput\.accept = "\.psd,application\/octet-stream";/, "the hidden picker must accept PSD files");
  assert.match(widgetSource, /this\.wirePsdImport = \(onPickFile\) =>/, "the widget must expose the import wiring hook");
  assert.match(layerTools, /uc\.wirePsdImport\?\.\(\(file\) => importPSDFile\(uc, file\)\)/, "layer tools must wire only the import handler");
  assert.ok(!layerTools.includes("insertBefore(importButton"), "the fragile text-search placement must be gone");
});

test("duplicate and move act on the right-clicked layer through thin delegates", () => {
  assert.match(widgetSource, /duplicateActiveLayer\(\) \{\s*return this\.duplicateLayer\(this\.activeLayer\);/,
    "duplicateActiveLayer must stay a thin delegate for the header icon");
  assert.match(widgetSource, /moveActiveLayer\(direction\) \{[\s\S]{0,300}?return this\.moveLayerOrder\(layer, direction\);/,
    "moveActiveLayer must stay a thin delegate for the header icon");
  assert.ok(layerTools.includes('uc.duplicateLayer(layer)'), "the menu duplicate must target the right-clicked layer");
  assert.ok(layerTools.includes("uc.moveLayerOrder(layer, -1)") && layerTools.includes("uc.moveLayerOrder(layer, 1)"),
    "the menu move entries must target the right-clicked layer");
});

test("PSD import reports every skipped non-raster construct", () => {
  for (const reason of [
    "clipping mask",
    "adjustment layer",
    "layer effects",
    "text/vector/smart-object layer without raster data",
  ]) {
    assert.ok(layerTools.includes(reason), `missing skip reason: ${reason}`);
  }
  assert.match(layerTools, /PSD imported \$\{importedCount\} raster layers/, "the status line must report the imported count");
  assert.match(layerTools, /skipped \$\{skipped\.length\}/, "the status line must report skipped layers");
});

test("remove background with prompt appends the extra line to the universal prompt", async () => {
  const { removeBgRunSettings } = await import("../web/unicanvas/layer_tools.mjs");
  const settings = { remove_bg_edit: { qwen_image21: { prompt: "Remove the background" } } };
  assert.equal(removeBgRunSettings(settings, "qwen_image21", " keep the sword ").prompt, ["Remove the background", "keep the sword"].join("\n"));
  assert.equal(removeBgRunSettings(settings, "qwen_image21", "").prompt, "Remove the background");
  assert.equal(removeBgRunSettings({}, "qwen_image21", "keep the hat").prompt, ["Remove the background, and output a PNG image", "keep the hat"].join("\n"));
});

test("strength slider previews live and commits on release", () => {
  assert.ok(layerTools.includes('data-control="colorMatchStrength"'), "strength slider must exist");
  assert.match(layerTools, /strengthInput\.addEventListener\("input"/, "dragging must update the preview from input events");
  assert.ok(layerTools.includes("requestAnimationFrame"), "per-frame work must be coalesced");
  assert.match(layerTools, /strengthInput\.addEventListener\("pointerup"/, "release must commit");
  assert.match(layerTools, /strengthInput\.addEventListener\("change"/, "keyboard-only changes must commit too");
  assert.ok(layerTools.includes("finishColorMatchGesture"), "gesture end must route through the single commit path");
  assert.match(layerTools, /kind: "layerPixels"/, "the commit must record a layerPixels history entry");
});

test("a failed or stale dropdown menu never blocks future opens", async () => {
    const source = await readFile(new URL("../web/shared/custom_select.mjs", import.meta.url), "utf8");
    assert.match(source, /if \(state\.menu && !state\.menu\.isConnected\) state\.menu = null;/, "a detached menu must be discarded before the open guard");
    assert.ok(source.includes("[VNCCS Custom Select] open failed"), "open failures must surface in the console and self-heal");
    assert.ok(source.includes("z-index: 2147483600"), "the menu must render above the fullscreen portal");
});
