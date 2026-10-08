import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const tools = readFileSync(new URL("../web/unicanvas/layer_tools.mjs", import.meta.url), "utf8");
const removeSource = tools.slice(tools.indexOf("async function removeLayerBackground("), tools.indexOf("\nfunction buildColorMatchReference("));
const rect = { x: 0, y: 0, width: 8, height: 8 };

function harness() {
  let resolve;
  const canvas = () => ({ width: 8, height: 8, pixels: "original", getContext() {
    return { save() {}, restore() {}, drawImage: () => { this.pixels += ":masked"; } };
  } });
  const context = {
    console, performance, setInterval, clearInterval,
    fetch: () => new Promise((done) => { resolve = done; }),
    document: { createElement: canvas },
    resolveRemoveBgSelection: () => ({ method: "rembg" }), REMOVE_BG_ROUTE: "/unused",
  };
  const prototype = vm.runInNewContext(source.slice(source.indexOf("class UniCanvasWidget {"), source.indexOf("\napp.registerExtension(")) + "\nUniCanvasWidget.prototype", context);
  const remove = vm.runInNewContext(removeSource + "\nremoveLayerBackground", context);
  const a = { id: "A", type: "raster", canvas: canvas() };
  const b = { id: "B", type: "raster", canvas: canvas() };
  const history = [];
  let snapshots = 0;
  const uc = Object.assign(Object.create(prototype), {
    panorama: null, layers: [a, b], activeLayerId: "A", origin: { x: 0, y: 0 }, settings: {},
    sam: { points: [{ x: 2, y: 2, label: 1 }], model: "sam2_large" },
    getLayerAlphaBounds: () => rect, expandCanvasCrop: () => rect,
    cloneCanvasCrop: () => ({ toDataURL: () => "source" }),
    renderSamPanel() {}, setStatus() {}, updateToolPreviewOverlay() {}, updateGenerationProgress() {},
    loadImage: async () => ({ width: 8, height: 8 }), configureImageContext: (ctx) => ctx,
    refreshLayerRow() {}, recordHistoryBefore() {}, renderLayerList() {}, requestRender() {},
    syncLightStateToWidget() {}, scheduleFullSync() {}, syncPoseToolToActiveLayer() {},
    createLayerPixelSnapshot(layer) { snapshots++; return { pixels: layer.canvas.pixels }; },
    materializeRasterLayerForEditing() {}, clampCanvasBounds: () => rect,
    boundsAfterLocalChange: () => undefined,
    getSamMaskCanvasForCurrentMode: () => ({ width: 8, height: 8 }),
    pushHistoryEntry: (entry) => history.push(entry),
  });
  return { uc, a, b, history, remove, snapshots: () => snapshots,
    resolve: () => resolve({ ok: true, json: async () => ({ mask: "mask", alpha: "alpha" }) }),
  };
}

const changes = {
  delete: ({ uc }) => uc.deleteLayer("A"),
  paint: ({ uc, a }) => { a.canvas.pixels = "brush edit"; uc.markLayerPixelsChanged(a); },
  move: ({ uc, a }) => uc.invalidateLayerRenderCaches(a),
  undo: ({ uc, a }) => uc.invalidateLayerCaches(a),
  resize: ({ a }) => { a.canvas.width++; },
  origin: ({ uc }) => { uc.origin.x++; },
  lock: ({ a }) => { a.locked = true; },
  dispose: ({ uc }) => { uc._disposed = true; },
  gesture: ({ uc }) => { uc.dragStart = { layerId: "A" }; },
  transform: ({ uc }) => { uc.transformDraft = { layerId: "A" }; },
};

for (const [name, change] of Object.entries(changes)) {
  test(`SAM rejects a response after ${name}, without masking another layer`, async () => {
    const h = harness();
    const pending = h.uc.segmentSamMask();
    change(h);
    h.resolve();
    await pending;
    h.uc.applySamMask();
    assert.equal(h.history.length, 0);
    assert.equal(h.b.canvas.pixels, "original");
    assert.equal(h.uc.sam.maskCanvas, null);
  });
  test(`background removal rejects a response after ${name}, preserving edits and history`, async () => {
    const h = harness();
    const pending = h.remove(h.uc, h.a);
    change(h);
    const pixels = h.a.canvas.pixels;
    h.resolve();
    await pending;
    assert.equal(h.a.canvas.pixels, pixels);
    assert.equal(h.history.length, 0);
    assert.equal(h.snapshots(), 0);
  });
}

test("clearing SAM prompts invalidates an in-flight request", async () => {
  const h = harness();
  const pending = h.uc.segmentSamMask();
  h.uc.clearSamPrompt();
  h.resolve();
  await pending;
  assert.equal(h.uc.sam.maskCanvas, null);
  assert.equal(h.uc.sam.busy, false);
});

test("SAM applies only to its original unchanged layer, even after selecting another", async () => {
  const h = harness();
  const pending = h.uc.segmentSamMask();
  h.uc.activeLayerId = "B";
  h.resolve();
  await pending;
  h.uc.applySamMask();
  assert.equal(h.a.canvas.pixels, "original:masked");
  assert.equal(h.b.canvas.pixels, "original");
  assert.equal(h.history.length, 1);
  assert.equal(h.history[0].before.pixels, "original");
  assert.equal(h.uc.sam.maskCanvas, null);
});

test("editing after SAM is ready invalidates Apply", async () => {
  const h = harness();
  const pending = h.uc.segmentSamMask();
  h.resolve();
  await pending;
  changes.paint(h);
  h.uc.applySamMask();
  assert.equal(h.a.canvas.pixels, "brush edit");
  assert.equal(h.history.length, 0);
  assert.equal(h.uc.sam.maskCanvas, null);
});

test("background removal captures undo only when the unchanged result is applied", async () => {
  const h = harness();
  const pending = h.remove(h.uc, h.a);
  assert.equal(h.snapshots(), 0);
  h.uc.activeLayerId = "B";
  h.resolve();
  await pending;
  assert.equal(h.history.length, 1);
  assert.equal(h.history[0].before.pixels, "original");
  assert.equal(h.history[0].after.pixels, "original:masked");
  assert.equal(h.b.canvas.pixels, "original");
});
