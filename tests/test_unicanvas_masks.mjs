import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { normalizePanorama } from "../web/unicanvas/panorama.mjs";
import { normalizeTransformMode } from "../web/unicanvas/transform.mjs";
import { serializePose } from "../web/unicanvas/pose_state.mjs";

const source = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
class Element {
    constructor() { this.children = []; this.events = {}; this.attributes = {}; this.scrollTop = 0; this.scrollLeft = 0; }
    append(...children) { this.children.push(...children); }
    set innerHTML(value) { this.html = value; this.children = []; }
    get innerHTML() { return this.html; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, callback) { this.events[name] = callback; }
    click() { this.events.click?.({ preventDefault() {}, stopPropagation() {} }); }
}
class Canvas {
    constructor() { this.pixels = null; }
    getContext() { return { drawImage: image => { this.pixels = image.pixels; } }; }
    toDataURL() { return this.pixels; }
}
let nextId = 0;
const icons = vm.runInNewContext(source.slice(source.indexOf("const UI_ICONS ="), source.indexOf("\n};", source.indexOf("const UI_ICONS =")) + 3) + "\nUI_ICONS");
const context = { UI_ICONS: icons, uid: () => `new-${++nextId}`, HISTORY_LIMIT: 20,
    normalizePanorama, normalizeTransformMode, serializePose, console,
    makeDefaultUniCanvasSettings: () => ({ positive: "" }),
    document: { createElement: tag => tag === "canvas" ? new Canvas() : new Element() } };
const prototype = vm.runInNewContext(source.slice(source.indexOf("class UniCanvasWidget {"), source.indexOf("\napp.registerExtension(")) + "\nUniCanvasWidget.prototype", context);

function layer(id, type, pixels = null) {
    return { id, type, name: id, visible: true, locked: false, opacity: 1, blendMode: "source-over",
        canvas: Object.assign(new Canvas(), { width: 32, height: 24, pixels }) };
}
function widget(layers = [layer("mask", "mask"), layer("image", "raster", "authored image")]) {
    return Object.assign(Object.create(prototype), {
        layers, activeLayerId: layers[0]?.id, tool: "move", layerList: new Element(),
        size: { width: 32, height: 24 }, origin: { x: 0, y: 0 }, bbox: { x: 0, y: 0, width: 32, height: 24 },
        settings: {}, undoStack: [], redoStack: [], stagingItems: [], activeStagingIndex: -1,
        createLayerRow: value => ({ layerId: value.id }),
        syncActiveLayerControls() {}, syncPoseToolToActiveLayer() {},
        requestRender() {}, syncLightStateToWidget() {}, scheduleFullSync() {}, setStatus() {},
        updateHistoryButtons() {}, cancelDeferredCanvasCommit() {}, updatePanoramaControls() {},
        syncPromptControls() {}, updateSnapButton() {}, setTool(value) { this.tool = value; },
        loadLocalStateBackup: () => null, saveLocalStateBackup() {}, applySeedModeDefault() {}, sanitizeMaskLayer() {},
        loadImage: async pixels => ({ pixels }), getLayerAlphaBounds: value => value.canvas.pixels ? { width: 32, height: 24 } : null,
    });
}
const masks = w => Array.from(w.layers).filter(value => value.type === "mask");

test("Masks replaces its counter with a small accessible plus that adds one undoable mask and preserves scrolling", () => {
    const w = widget();
    w.layerList.scrollTop = 51; w.layerList.scrollLeft = 7;
    w.renderLayerList();
    const head = w.maskLayerList.children[0], plus = head.children[0];
    assert.equal(head.innerHTML, "<span>Masks</span>");
    assert.equal(plus.type, "button");
    assert.equal(plus.innerHTML, icons.plus);
    assert.equal(plus.title, "Add mask layer");
    assert.equal(plus.attributes["aria-label"], "Add mask layer");
    assert.equal(w.rasterLayerList.children[0].children[0].textContent, 1);
    plus.click();
    assert.equal(masks(w).length, 2);
    assert.equal(w.activeLayer.type, "mask");
    assert.equal(w.activeLayer.canvas.pixels, null);
    assert.equal(w.undoStack.length, 1);
    assert.equal(w.layerList.scrollTop, 51); assert.equal(w.layerList.scrollLeft, 7);
    w.undo(); assert.equal(masks(w).length, 1);
    w.redo(); assert.equal(masks(w).length, 2);
    assert.doesNotMatch(source, /\[UI_ICONS\.mask, "Add mask"/);
    assert.doesNotMatch(source, /createLayerGroupEmpty\("No masks"\)/);
});

test("deleting the last painted mask creates a blank replacement immediately; undo restores its pixels and redo restores the replacement", () => {
    const w = widget([layer("painted", "mask", "authored mask"), layer("image", "raster", "authored image")]);
    w.deleteLayer("painted");
    const replacement = masks(w)[0];
    assert.equal(masks(w).length, 1);
    assert.notEqual(replacement.id, "painted");
    assert.equal(replacement.canvas.pixels, null);
    assert.equal(w.activeLayerId, replacement.id);
    assert.equal(w.layers.find(value => value.id === "image").canvas.pixels, "authored image");
    assert.equal(w.undoStack.length, 1, "automatic replacement belongs to the same deletion");
    w.undo();
    assert.equal(masks(w).length, 1); assert.equal(masks(w)[0].id, "painted");
    assert.equal(masks(w)[0].canvas.pixels, "authored mask");
    assert.equal(w.activeLayerId, "painted");
    w.redo();
    assert.equal(masks(w).length, 1); assert.equal(masks(w)[0].id, replacement.id);
    assert.equal(masks(w)[0].canvas.pixels, null);
});

test("a sole mask can be deleted, while deleting one of several masks preserves the other mask", () => {
    const sole = widget([layer("sole", "mask", "paint")]);
    sole.deleteLayer("sole");
    assert.equal(sole.layers.length, 1); assert.notEqual(sole.layers[0].id, "sole");
    assert.equal(sole.layers[0].type, "mask"); assert.equal(sole.layers[0].canvas.pixels, null);
    const other = layer("other", "mask", "keep");
    const w = widget([layer("remove", "mask"), other, layer("image", "raster")]);
    w.deleteLayer("remove");
    assert.deepEqual(masks(w), [other]); assert.equal(other.canvas.pixels, "keep");
});

test("initialization and repeated layer renders keep exactly one default mask and preserve the active raster", () => {
    const w = widget([]);
    w._createInitialLayers();
    assert.equal(masks(w).length, 1); assert.equal(w.activeLayer.type, "raster");
    const mask = masks(w)[0];
    for (let index = 0; index < 3; index++) w.renderLayerList();
    assert.equal(masks(w).length, 1); assert.equal(masks(w)[0], mask);
    assert.equal(mask.canvas.width, 32); assert.equal(mask.canvas.height, 24);
    w.tool = "pose"; w.layers = [layer("pose", "pose")]; w.activeLayerId = "pose";
    w.renderLayerList();
    assert.equal(masks(w).length, 1); assert.equal(w.activeLayerId, "pose"); assert.equal(w.tool, "pose");
});

test("new canvas serialization contains an empty mask and base layer, with the base selected", () => {
    const w = widget(); w.createStateCacheId = () => "new-document";
    const state = w.createEmptyCanvasState();
    assert.equal(state.layers.length, 2);
    assert.equal(state.layers[0].type, "mask"); assert.equal(state.layers[1].type, "raster");
    assert.notEqual(state.layers[0].id, state.layers[1].id);
    assert.equal(state.activeLayerId, state.layers[1].id);
    for (const value of state.layers) { assert.equal(value.dataURL, null); assert.equal(value.cached, false); }
});

test("loading a legacy canvas without masks adds one blank mask without changing its authored pixels or selection", async () => {
    const w = widget();
    const state = { version: 2, layers: [{ id: "saved", type: "raster", dataURL: "saved pixels" }], activeLayerId: "saved" };
    assert.equal(await w.applySerializedState(state, { replaceDocument: true }), true);
    assert.equal(masks(w).length, 1); assert.equal(masks(w)[0].canvas.pixels, null);
    assert.equal(w.layers.find(value => value.id === "saved").canvas.pixels, "saved pixels");
    assert.equal(w.activeLayerId, "saved"); assert.equal(w.undoStack.length, 0);
    assert.equal(state.layers.length, 1, "normalization does not mutate the source snapshot");
    w.getStateCacheId = () => "legacy"; w.getOutputCacheId = () => "legacy_out";
    const saved = w.buildSerializedState(true);
    assert.equal(saved.layers.find(value => value.id === "saved").dataURL, "saved pixels");
    const savedMask = saved.layers.find(value => value.type === "mask");
    assert.equal(savedMask.id, masks(w)[0].id); assert.equal(savedMask.dataURL, null);
});

test("Flatten creates a blank mask alongside the master and remains one undo step", () => {
    const w = widget([layer("mask", "mask", "mask pixels"), layer("image", "raster", "image pixels")]);
    w.drawFlattenedLayers = ctx => ctx.drawImage(w.layers.find(value => value.type === "raster").canvas);
    w.flattenLayersToMaster();
    assert.equal(masks(w).length, 1); assert.equal(masks(w)[0].canvas.pixels, null);
    assert.equal(w.layers.find(value => value.type === "raster").canvas.pixels, "image pixels");
    assert.equal(w.undoStack.length, 1);
    w.undo(); assert.equal(masks(w)[0].canvas.pixels, "mask pixels");
    w.redo(); assert.equal(masks(w)[0].canvas.pixels, null);
});

test("generation blocks the new plus and mask deletion before either can change layers or history", () => {
    const w = widget(); w.renderLayerList();
    const plus = w.maskLayerList.children[0].children[0], original = [...w.layers];
    w._generationLocked = true;
    plus.click(); w.deleteLayer("mask");
    assert.deepEqual(Array.from(w.layers), original); assert.equal(w.undoStack.length, 0);
});
