import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { installUniCanvasInputTools } from "../web/unicanvas/input_tools.mjs";

const source = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const modes = readFileSync(new URL("../web/unicanvas/modes.mjs", import.meta.url), "utf8");
const shortcuts = vm.runInNewContext(modes.match(/export const TOOL_SHORTCUTS = (Object\.freeze\(\{[\s\S]*?\}\));/)[1]);
const plain = value => JSON.parse(JSON.stringify(value));
const maskColor = "rgba(255, 143, 163, 0.48)";

class Element {
  constructor() {
    this.style = {}; this.attributes = {}; this.events = {}; this.classes = new Set();
    this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name), add() {}, remove() {}, contains: name => this.classes.has(name) };
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, callback) { this.events[type] = callback; }
  querySelectorAll() { return []; }
}

class Path {
  constructor() { this.commands = []; }
  moveTo(...values) { this.commands.push(["moveTo", ...values]); }
  lineTo(...values) { this.commands.push(["lineTo", ...values]); }
}

class Canvas {
  constructor(width = 16, height = 16) {
    this.width = width; this.height = height; this.pixels = "original"; this.fills = []; this.strokes = []; this.path = []; this.reads = 0;
    const state = [];
    this.ctx = {
      save: () => state.push({ fillStyle: this.ctx.fillStyle, strokeStyle: this.ctx.strokeStyle, globalCompositeOperation: this.ctx.globalCompositeOperation, globalAlpha: this.ctx.globalAlpha }),
      restore: () => Object.assign(this.ctx, state.pop()),
      translate() {}, scale() {}, setTransform() {}, clearRect() {},
      beginPath: () => { this.path = []; },
      rect: (...values) => this.path.push(["rect", ...values]),
      ellipse: (...values) => this.path.push(["ellipse", ...values]),
      arc: (...values) => this.path.push(["arc", ...values]),
      moveTo: (...values) => this.path.push(["moveTo", ...values]),
      lineTo: (...values) => this.path.push(["lineTo", ...values]),
      closePath: () => this.path.push(["closePath"]),
      fill: () => this.fills.push({ path: plain(this.path), color: this.ctx.fillStyle, composite: this.ctx.globalCompositeOperation }),
      fillRect: () => { this.tint = this.ctx.fillStyle; },
      stroke: path => this.strokes.push({ path, color: this.ctx.strokeStyle, width: this.ctx.lineWidth }),
      drawImage: image => {
        this.alpha = image.alpha;
        if (this.ctx.globalCompositeOperation === "destination-in") this.pixels = "cut";
      },
      getImageData: () => {
        this.reads++;
        const data = new Uint8ClampedArray(this.width * this.height * 4);
        this.alpha?.forEach((value, index) => { data[index * 4 + 3] = value; });
        return { data };
      },
      createRadialGradient: () => ({ addColorStop: (_offset, color) => { this.gradientColor = color; } }),
    };
  }
  getContext() { return this.ctx; }
}

const context = { console, clearTimeout, Path2D: Path, MASK_OVERLAY_COLOR: maskColor, HISTORY_LIMIT: 20,
  trimPanoramaHistory() {}, document: { createElement: () => new Canvas() }, window: { devicePixelRatio: 1 },
};
const prototype = vm.runInNewContext(source.slice(source.indexOf("class UniCanvasWidget {"), source.indexOf("\napp.registerExtension(")) + "\nUniCanvasWidget.prototype", context);

function widget(values = {}) {
  const layer = { id: "image", type: "raster", visible: true, canvas: new Canvas() };
  return Object.assign(Object.create(prototype), {
    layers: [layer], activeLayerId: layer.id, panorama: null, container: new Element(), canvas: Object.assign(new Element(), { style: {} }),
    tool: "brush", shapeType: "square", brushSize: 20, fg: "#336699", opacity: 1,
    origin: { x: 0, y: 0 }, view: { x: 0, y: 0, scale: 1 }, bbox: {}, lassoPoints: [], undoStack: [], redoStack: [],
    lastDrawPointByTool: { brush: null, eraser: null }, hoverPointerType: "mouse",
    sam: { model: "sam3", mode: "add", points: [], redoPoints: [], maskCanvas: null, invert: false, status: "", busy: false },
    samPanel: new Element(), samPointsLabel: new Element(), samModelSelect: new Element(), samStatus: new Element(),
    samAddBtn: new Element(), samSubtractBtn: new Element(), samUndoBtn: new Element(), samRedoBtn: new Element(),
    samInvertBtn: new Element(), samSegmentBtn: new Element(), samApplyBtn: new Element(), samClearBtn: new Element(),
    undoBtn: new Element(), redoBtn: new Element(),
    setStatus() {}, renderToolSettings() {}, updateHud() {}, updateToolPreviewOverlay() {}, clearToolPreviewOverlay() {},
    requestRender() {}, syncLightStateToWidget() {}, scheduleFullSync() {}, refreshLayerRow() {},
    cancelDeferredCanvasCommit() {}, syncPoseToolToActiveLayer() {}, syncActiveLayerControls() {}, renderLayerList() {},
    canvasPointFromEvent: e => ({ x: e.clientX, y: e.clientY }), getLayerWorldBounds: () => ({ x: 0, y: 0, width: 16, height: 16 }),
    ensureVisibleWorldBounds: () => true, ensureStrokeWorldBounds: () => true, ensureWorldBounds: () => true,
    materializeRasterLayerForEditing() {}, markLayerPixelsChanged() {}, invalidateLayerCaches() {},
    createLayerPixelSnapshot: value => ({ pixels: value.canvas.pixels }),
    restoreLayerPixelSnapshot: (value, snapshot) => { value.canvas.pixels = snapshot.pixels; },
    alignCoordForTool: point => point, getStrokeCanvasBounds: () => ({}),
  }, values);
}

const event = (x = 2, y = 3) => ({ clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: "mouse", preventDefault() {}, stopPropagation() {} });

test("Mask Brush is absent from the toolbar; old tool selections and M choose Brush", () => {
  const toolbar = source.slice(source.indexOf('      ["move", "Move layer"]'), source.indexOf("].forEach(([tool, title])"));
  assert.doesNotMatch(toolbar, /\["mask",/);
  assert.match(toolbar, /\["rect", "Shape"\]/);
  assert.match(source, /this\.sam = \{\s*model: "sam3"/);
  const w = widget(); w.setTool("mask");
  assert.equal(w.tool, "brush"); assert.equal(shortcuts.m, "brush");
});

for (const flag of ["_generationPreparing", "_generationLocked", "drawInProgress"]) {
  test(`${flag}: cursor follows held mouse movement, canvas pixels and history stay unchanged`, () => {
    const frames = [];
    const w = widget({ [flag]: true, previewCanvas: new Canvas(), updateToolPreviewOverlay() { frames.push(plain(this.hoverPoint)); } });
    const before = w.activeLayer.canvas.pixels;
    for (const [x, y] of [[5, 6], [11, 12]]) {
      const e = { ...event(x, y), target: w.canvas, type: "pointermove" };
      assert.equal(w.isInteractionBlocked(e), false);
      w.onPointerDown(e); w.onPointerMove(e);
      assert.deepEqual(plain(w.hoverPoint), { x, y });
      assert.equal(w.activeLayer.canvas.pixels, before); assert.equal(w.undoStack.length, 0);
    }
    assert.equal(frames.length, 2);
    w.onPointerLeave(event()); assert.equal(w.hoverPoint, null);
    w.onPointerHover(event(7, 8)); assert.deepEqual(plain(w.hoverPoint), { x: 7, y: 8 });
  });
}

for (const type of ["raster", "mask"]) {
  test(`Brush uses the active ${type} layer's paint and cursor for hard and soft strokes`, () => {
    const w = widget({ hoverPoint: { x: 4, y: 5 }, toolSettings: new Element() });
    w.activeLayer.type = type;
    w.drawStroke({ x: 4, y: 5 }, { x: 6, y: 5 });
    assert.equal(w.activeLayer.canvas.strokes[0].color, type === "mask" ? "rgba(255,255,255,1)" : w.fg);
    assert.equal(w.activeLayer.canvas.ctx.strokeStyle, undefined, "context state is restored");
    const preview = new Canvas(); w.drawToolPreview(preview.ctx);
    assert.equal(preview.fills[0].color, type === "mask" ? "#ff8fa3" : w.fg);
    assert.equal(w.getToolSettingControls().includes("fg"), type === "raster");
    installUniCanvasInputTools(w); w.brushHardness = .5;
    w.drawStroke({ x: 4, y: 5 }, { x: 6, y: 5 });
    assert.equal(w.activeLayer.canvas.gradientColor, type === "mask" ? "rgba(255,255,255,0)" : "rgba(51,102,153,0)");
    w.drawToolPreview(preview.ctx);
    assert.equal(preview.gradientColor, type === "mask" ? "rgba(255,143,163,0)" : "rgba(51,102,153,0)");
  });
}

for (const shapeType of ["square", "circle", "triangle"]) for (const type of ["raster", "mask"]) {
  test(`${shapeType} previews successive drag values on ${type}, commits matching geometry once, and supports Undo/Redo`, () => {
    const w = widget({ tool: "rect", shapeType, shapeComposite: "source-over" });
    w.activeLayer.type = type;
    w.onPointerDown(event(2, 3));
    const preview = new Canvas();
    for (const [x, y] of [[8, 7], [12, 9]]) {
      w.onPointerMove(event(x, y)); w.drawShapeDraft(preview.ctx);
      assert.equal(w.undoStack.length, 0);
      assert.equal(w.shapeDraft.width, x - 2);
      if (shapeType !== "triangle") assert.equal(w.shapeDraft.width, w.shapeDraft.height);
    }
    assert.notDeepEqual(preview.fills[0].path, preview.fills[1].path);
    const visiblePath = preview.fills.at(-1).path;
    w.onPointerUp(event(12, 9));
    assert.equal(w.undoStack.length, 1);
    assert.deepEqual(w.activeLayer.canvas.fills.at(-1).path, visiblePath);
    assert.equal(w.activeLayer.canvas.fills.at(-1).color, type === "mask" ? "#fff" : w.fg);
    w.undo(); assert.equal(w.redoStack.length, 1); w.redo(); assert.equal(w.undoStack.length, 1);
    w.onPointerDown({ ...event(2, 3), ctrlKey: true }); w.onPointerMove(event(8, 7)); w.onPointerUp(event(8, 7));
    assert.equal(w.activeLayer.canvas.fills.at(-1).composite, "destination-out");
  });
}

test("SAM panel explains the missing raster layer locally and exposes explicit Add/Subtract modes", () => {
  const w = widget({ tool: "sam" }); w.activeLayer.type = "mask";
  w.renderSamPanel();
  assert.match(w.samStatus.textContent, /Select a raster layer in Layers/);
  assert.equal(w.samStatus.classes.has("error"), true);
  assert.equal(w.samSegmentBtn.disabled, true);
  w.addSamPoint({ x: 2, y: 3 }, event()); assert.equal(w.sam.points.length, 0);
  w.activeLayer.type = "raster";
  w.setSamPointMode("subtract"); w.addSamPoint({ x: 2, y: 3 }, event());
  assert.equal(w.sam.points[0].label, 0); assert.equal(w.samSubtractBtn.attributes["aria-pressed"], "true");
  w.setSamPointMode("add"); w.addSamPoint({ x: 4, y: 5 }, event()); assert.equal(w.sam.points[1].label, 1);
  w.activeLayer.locked = true; w.renderSamPanel(); assert.match(w.samStatus.textContent, /Unlock/);
  assert.match(source, /this\.samStatus\.setAttribute\("aria-live", "polite"\)/);
  const setStatus = source.slice(source.indexOf("  setSamStatus("), source.indexOf("  clearSamMask("));
  assert.doesNotMatch(setStatus, /updateGenerationProgress/);
});

test("selecting a raster layer clears an obsolete SAM selection error", () => {
  const w = widget({ tool: "sam", updateLayerListActiveState() {} });
  w.activeLayer.type = "mask";
  w.addSamPoint({ x: 2, y: 3 }, event());
  const image = { id: "new-image", type: "raster", canvas: new Canvas() }; w.layers.push(image);
  w.setActiveLayer(image.id); w.renderSamPanel();
  assert.equal(w.samStatus.classes.has("error"), false);
  assert.doesNotMatch(w.samStatus.textContent, /Select a raster/);
  assert.equal(w.samAddBtn.disabled, false);
});

test("Shape Settings exposes three choices and changes the live preview from input", () => {
  class Select {}
  class Input {}
  let frames = 0;
  const w = widget({ tool: "rect", toolSettings: new Element(), requestRender: () => { frames++; } });
  prototype.renderToolSettings.call(w);
  for (const label of ["Square", "Circle", "Triangle"]) assert.ok(w.toolSettings.innerHTML.includes(label));
  const start = source.indexOf('    this.toolSettings.addEventListener("input", (e) => {');
  const end = source.indexOf('    this.toolSettings.addEventListener("click",', start);
  vm.runInNewContext(`(function() { ${source.slice(start, end)} }).call(w)`, { w, HTMLSelectElement: Select, HTMLInputElement: Input });
  for (const value of ["circle", "triangle"]) {
    w.toolSettings.events.input({ target: Object.assign(new Select(), { dataset: { control: "shapeType" }, value }) });
    assert.equal(w.shapeType, value);
  }
  assert.equal(frames, 2);
});

test("SAM preview Undo/Redo keeps points, and Apply gives pixel history immediate priority", () => {
  const w = widget({ tool: "sam", clampCanvasBounds: crop => crop });
  const mask = new Canvas();
  Object.assign(w.sam, { points: [{ x: 2, y: 3, label: 1 }], maskCanvas: mask,
    crop: { x: 0, y: 0, width: 16, height: 16 }, layerId: w.activeLayer.id, layerState: w.captureLayerEditState(w.activeLayer) });
  w.renderSamPanel(); assert.equal(w.undoBtn.disabled, false);
  w.undo(); assert.equal(w.sam.maskCanvas, null); assert.equal(w.sam.points.length, 1); assert.equal(w.redoBtn.disabled, false);
  w.redo(); assert.equal(w.sam.maskCanvas, mask);
  w.applySamMask(); assert.equal(w.activeLayer.canvas.pixels, "cut"); assert.equal(w.sam.points.length, 0);
  assert.equal(w.samUndoBtn.disabled, false, "the panel and main toolbar both expose pixel undo after Apply");
  assert.equal(w.undoStack.length, 1);
  w.undo(); assert.equal(w.activeLayer.canvas.pixels, "original");
  w.redo(); assert.equal(w.activeLayer.canvas.pixels, "cut");
});

test("SAM preview redo rejects changed input, and editing points invalidates the preview redo", () => {
  const w = widget({ tool: "sam" });
  Object.assign(w.sam, { points: [{ x: 2, y: 3, label: 1 }], maskCanvas: new Canvas(), layerState: w.captureLayerEditState(w.activeLayer) });
  w.undo(); w.activeLayer.locked = true; w.redo(); assert.equal(w.sam.maskCanvas, null);
  w.activeLayer.locked = false;
  Object.assign(w.sam, { maskCanvas: new Canvas(), layerState: w.captureLayerEditState(w.activeLayer) });
  w.undo(); w.addSamPoint({ x: 5, y: 5 }, event()); assert.equal(w.sam.redoMask, null);
});

test("SAM outlines exact alpha edges including holes and crop edges, caches readback, and preserves pink fill", () => {
  const w = widget({ tool: "sam" });
  const mask = new Canvas(3, 3); mask.alpha = [255, 255, 255, 255, 0, 255, 255, 255, 255];
  Object.assign(w.sam, { maskCanvas: mask, crop: { x: 0, y: 0, width: 3, height: 3 } });
  const preview = w.getSamMaskPreview(mask);
  assert.equal(preview.canvas.tint, maskColor);
  assert.equal(preview.outline.commands.length, 32, "12 exterior edges and 4 edges around the hole");
  assert.equal(w.getSamMaskPreview(mask), preview); assert.equal(preview.canvas.reads, 1);
  const stage = new Canvas();
  for (const scale of [.25, 1, 4]) {
    w.view.scale = scale; w.drawSamPreview(stage.ctx);
    assert.deepEqual(stage.strokes.slice(-2).map(({ color, width }) => [color, width * scale]), [["#000", 4], ["#fff", 2]]);
    assert.equal(stage.ctx.globalCompositeOperation, undefined, "tint compositing never alters the stage");
  }
  w.sam.invert = true; const inverted = w.getSamMaskPreview(mask); assert.notEqual(inverted, preview);
  w.clearSamMask(); assert.equal(w._samMaskPreview, null);
});
