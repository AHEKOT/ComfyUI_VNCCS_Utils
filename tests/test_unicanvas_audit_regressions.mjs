import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { autoNameLayers } from "../web/unicanvas/naming.mjs";
import { compositeBlendModeToPsd } from "../web/unicanvas/layer_tools.mjs";
import { trimPanoramaHistory } from "../web/unicanvas/panorama.mjs";
import { writePsd, readPsd } from "../web/vendor/ag-psd.bundle.mjs";

const source = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const modes = readFileSync(new URL("../web/unicanvas/modes.mjs", import.meta.url), "utf8");
const canvas = (width = 4096, height = 4096) => ({ width, height, getContext: () => ({ drawImage() {} }) });
const context = { console, clearTimeout, trimPanoramaHistory, compositeBlendModeToPsd, Blob,
  HISTORY_LIMIT: 80,
  isImageLayer: layer => layer.type !== "mask", document: { createElement: () => canvas(1, 1) } };
const prototype = vm.runInNewContext(source.slice(source.indexOf("class UniCanvasWidget {"), source.indexOf("\napp.registerExtension(")) + "\nUniCanvasWidget.prototype", context);
const widget = props => Object.assign(Object.create(prototype), {
  captureGenerationSettings: () => ({}),
  panorama: null, layers: [], origin: { x: 0, y: 0 }, settings: {}, setStatus() {},
  cancelDeferredCanvasCommit() {}, syncPoseToolToActiveLayer() {}, syncActiveLayerControls() {},
  renderLayerList() {}, requestRender() {}, syncLightStateToWidget() {},
}, props);

for (const mode of ["move", "resize"]) for (const release of ["pointerup", "pointercancel"]) {
  test(`bbox ${mode} previews continuously and ${release} records one geometry-only undo command`, () => {
    const original = { x: 0, y: 0, width: 128, height: 128 };
    const layer = { id: "layer", canvas: canvas() }, settings = { positive: "current prompt" }, staged = [{}];
    const frames = [];
    let inferenceSyncs = 0;
    const w = widget({ tool: "bbox", bbox: { ...original }, view: { x: 0, y: 0, scale: 1 },
      layers: [layer], settings, stagingItems: staged, undoStack: [], redoStack: [],
      canvas: { setPointerCapture() {} }, canvasPointFromEvent: e => ({ x: e.clientX, y: e.clientY }),
      isStagingActive: () => false, getGridSize: () => 8,
      clearToolPreviewOverlay() {}, updateContextCursor() {}, updateToolPreviewOverlay() {},
      syncSettingsToWidget() {}, scheduleFullSync() {}, syncInferenceControls() { inferenceSyncs++; },
      requestRender() { frames.push({ ...this.bbox }); },
      createHistorySnapshot() { throw Error("BBox history must not clone the document"); },
    });
    const event = (x, y, type = "pointermove") => ({ pointerId: 1, button: 0, clientX: x, clientY: y, type,
      preventDefault() {}, stopPropagation() {} });
    const start = mode === "move" ? [64, 64] : [128, 64];
    w.onPointerDown(event(...start, "pointerdown"));
    assert.deepEqual({ ...w.dragStart.bbox }, original);
    for (const distance of [16, 32]) {
      w.onPointerMove(event(start[0] + distance, start[1] + distance / 2));
      const expected = mode === "move" ? { ...original, x: distance, y: distance / 2 }
        : { ...original, width: original.width + distance };
      assert.deepEqual(frames.at(-1), expected);
      assert.equal(w.undoStack.length, 0, "held frames do not commit history");
    }
    const final = frames.at(-1);
    w.onPointerUp(event(start[0] + 32, start[1] + 16, release));
    w.onPointerUp(event(start[0] + 32, start[1] + 16, "pointerup"));
    assert.deepEqual({ ...w.bbox }, final, "release preserves the last held geometry");
    assert.equal(w.undoStack.length, 1);
    assert.equal(w.undoStack[0].kind, "bbox");
    assert.deepEqual({ ...w.undoStack[0].before }, original);
    assert.deepEqual({ ...w.undoStack[0].after }, final);
    const committedInferenceSyncs = inferenceSyncs;
    w.undo();
    assert.deepEqual({ ...w.bbox }, original);
    w.redo();
    assert.deepEqual({ ...w.bbox }, final);
    assert.equal(inferenceSyncs, committedInferenceSyncs + 2);
    assert.equal(w.layers[0], layer); assert.equal(w.settings, settings); assert.equal(w.stagingItems, staged);
  });
}

test("bbox release without a geometry change records no history and generation blocks late bbox callbacks", () => {
  const original = { x: 0, y: 0, width: 128, height: 128 };
  const w = widget({ tool: "bbox", bbox: { ...original }, view: { x: 0, y: 0, scale: 1 },
    undoStack: [], redoStack: [], canvas: { setPointerCapture() {} },
    canvasPointFromEvent: e => ({ x: e.clientX, y: e.clientY }),
    isStagingActive: () => false, getGridSize: () => 8,
    clearToolPreviewOverlay() {}, updateContextCursor() {}, updateToolPreviewOverlay() {},
    syncSettingsToWidget() {}, syncInferenceControls() {},
  });
  const e = { pointerId: 1, button: 0, clientX: 64, clientY: 64, preventDefault() {}, stopPropagation() {} };
  w.onPointerDown(e); w.onPointerUp(e);
  assert.equal(w.undoStack.length, 0);
  w.onPointerDown(e);
  w.onPointerMove({ ...e, clientX: 96 }); w.onPointerMove(e); w.onPointerUp(e);
  assert.equal(w.undoStack.length, 0, "returning to the initial geometry is a no-op");
  w.onPointerDown(e);
  w._generationLocked = true;
  w.onPointerMove({ ...e, clientX: 96 }); w.onPointerUp(e);
  assert.deepEqual({ ...w.bbox }, original);
  assert.equal(w.undoStack.length, 0);
  w._generationLocked = false;
  w.onPointerUp(e);
  assert.equal(w.undoStack.length, 0);
});

test("layer controls update live and record one undo snapshot per gesture", () => {
  class Input {}
  class Select {}
  const listeners = {}, snapshots = [];
  const layer = { id: "A", opacity: 1, blendMode: "source-over" };
  const w = widget({ layers: [layer], activeLayerId: layer.id,
    layerSubhead: { addEventListener: (type, listener) => { listeners[type] = listener; } },
    layerList: { querySelector: () => null }, invalidateLayerThumbnail() {},
    recordHistoryBefore() { snapshots.push({ opacity: layer.opacity, blendMode: layer.blendMode }); },
  });
  const start = source.indexOf("    const onLayerSubheadChange =");
  const end = source.indexOf('    this.toolSettings.addEventListener("input"', start);
  vm.runInNewContext(`(function () { ${source.slice(start, end)} }).call(w)`, {
    w, HTMLInputElement: Input, HTMLSelectElement: Select,
  });
  const input = Object.assign(new Input(), { dataset: { layerControl: "opacity" }, value: "0.5" });
  listeners.input({ target: input });
  assert.equal(layer.opacity, .5);
  input.value = "0.2";
  listeners.input({ target: input });
  listeners.change({ target: input });
  assert.deepEqual(snapshots, [{ opacity: 1, blendMode: "source-over" }]);
  const select = Object.assign(new Select(), { dataset: { layerControl: "blendMode" }, value: "multiply" });
  listeners.input({ target: select });
  listeners.change({ target: select });
  assert.equal(layer.blendMode, "multiply");
  assert.deepEqual(snapshots[1], { opacity: .2, blendMode: "source-over" });
  input.value = "0.8";
  listeners.input({ target: input });
  listeners.change({ target: input });
  assert.equal(snapshots.length, 3);
});

for (const failed of [false, true]) {
  test(`config reference preparation blocks repeat GENERATE and unlocks (${failed ? "failed" : "loaded"})`, async () => {
    let finish, calls = 0;
    const ctx = { clearTimeout, poseGenerationLayer: () => null,
      resolveConfigDrawSettings: () => ({ settings: {}, references: [] }),
      loadConfigReferences: () => { calls++; return new Promise((resolve, reject) => { finish = () => failed ? reject(Error("read failed")) : resolve([]); }); },
    };
    const proto = vm.runInNewContext(source.slice(source.indexOf("class UniCanvasWidget {"), source.indexOf("\napp.registerExtension(")) + "\nUniCanvasWidget.prototype", ctx);
    const w = Object.assign(Object.create(proto), { node: { graph: {} }, panorama: null,
      drawBtn: {}, _documentRevision: 0, settings: {}, _isConfigLinked: () => true,
      syncConfigFamily() {}, flushSettingsToWidget() {}, setStatus() {},
      captureGenerationSettings: () => ({ settings: {}, loader: {}, config: { settings: {}, references: [] } }),
    });
    const first = w.draw();
    assert.equal(w.editingBlocked, true);
    await w.draw();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(w.drawInProgress, true);
    assert.equal(w.drawBtn.disabled, true);
    await w.draw();
    assert.equal(calls, 1);
    w._documentRevision++;
    finish(); await first;
    assert.equal(w.editingBlocked, false);
    assert.equal(w.drawInProgress, false);
    assert.equal(w.drawBtn.disabled, false);
  });
}

test("standalone saves large documents on the server and survives browser quota errors", async () => {
  let raw = null, quota = false, saved = true;
  const snapshots = [];
  const ctx = { console, UNICANVAS_STANDALONE_STORAGE_KEY: "standalone", window: {
    localStorage: { setItem(_key, value) { if (quota) throw Error("quota"); raw = value; }, getItem: () => raw },
  } };
  const persistence = vm.runInNewContext(modes.slice(modes.indexOf("function writeStandaloneState("), modes.indexOf("\nexport function teardownUniCanvasWidgetModes")).replace("export function", "function") +
    modes.slice(modes.indexOf("function readStandalonePersistedStateValue()"), modes.indexOf("\nfunction createStandaloneWidget")) +
    "\n({installStandalonePersistence, readStandalonePersistedStateValue, flushStandalonePersistence})", ctx);
  const w = { getStateCacheId: () => "vnccs_unicanvas_standalone_tab",
    uploadStatePayload: async state => { snapshots.push(state); return saved; },
    writeLightStateToWidget() {}, scheduleStateUpload() { this.scheduled = true; }, flushStateUpload() { this.flushed = true; } };
  persistence.installStandalonePersistence(w);
  const huge = { layers: [{ dataURL: "x".repeat(1_600_000) }] };
  assert.equal(await w.uploadStatePayload(huge), true);
  assert.equal(snapshots[0], huge);
  assert.ok(raw.length < 300, "browser state holds only a pointer");
  assert.equal(JSON.parse(persistence.readStandalonePersistedStateValue()).storage, "server_cache");
  quota = true;
  assert.equal(await w.uploadStatePayload(huge), true);
  assert.equal(await w.uploadStatePayload({ layers: [] }), true);
  assert.equal(snapshots.length, 3, "quota failure never disables server saves");
  saved = false;
  const previous = raw;
  assert.equal(await w.uploadStatePayload(huge), false);
  assert.equal(raw, previous, "a failed upload never replaces the saved pointer");
  w.writeLightStateToWidget();
  assert.equal(w.scheduled, true);
  persistence.flushStandalonePersistence(w);
  assert.equal(w.flushed, true);
  raw = JSON.stringify({ state: { version: 2, storage: "local", layers: [{ dataURL: "old pixels" }] } });
  assert.equal(JSON.parse(persistence.readStandalonePersistedStateValue()).layers[0].dataURL, "old pixels");
});

test("flat Undo and Redo upload their restored pixels", () => {
  const layer = { id: "A", canvas: canvas() };
  let saves = 0;
  const w = widget({ layers: [layer], restoreLayerPixelSnapshot(_layer, state) { layer.pixels = state; }, scheduleFullSync() { saves++; } });
  const entry = { kind: "layerPixels", layerId: "A", before: "before", after: "after" };
  w.applyHistoryEntry(entry, "undo");
  assert.equal(layer.pixels, "before");
  w.applyHistoryEntry(entry, "redo");
  assert.equal(layer.pixels, "after");
  assert.equal(saves, 2);
});

test("flat history fits the same byte budget as panorama history", () => {
  const entries = Array.from({ length: 20 }, () => ({ kind: "layerPixels", before: { canvas: canvas() }, after: { canvas: canvas() } }));
  const w = widget({ undoStack: entries, redoStack: [] });
  w.updateHistoryButtons();
  assert.equal(w.undoStack.length, 3);
});

for (const panorama of [null, { settings: { width: 1, height: 1 }, commit() {} }]) for (const visible of [true, false]) {
  test(`PSD export preserves opacity, blend modes and visibility (${panorama ? "panorama" : "flat"}, ${visible ? "visible" : "hidden"})`, async () => {
    const layers = ["color-dodge", "color-burn", "hard-light", "soft-light", "multiply"].map(blendMode => ({
      name: blendMode, type: "raster", visible, opacity: 0.5, blendMode, canvas: canvas(1, 1), panoramaCanvas: canvas(1, 1),
    }));
    let roundtrip;
    const imageData = { width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255]) };
    const w = widget({ panorama, layers, getCanvasAlphaBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }),
      getLayersVisibleWorldRect: () => ({ x: 0, y: 0, width: 1, height: 1 }), configureImageContext: ctx => ctx,
      downloadBlob() {}, loadAgPsd: async () => ({ writePsd(psd) {
        const children = psd.children.map(({ canvas, ...layer }) => ({ ...layer, imageData }));
        const result = writePsd({ ...psd, imageData, children });
        roundtrip = readPsd(result, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
        return result;
      } }) });
    await w.exportPSD();
    assert.equal(roundtrip.children.length, layers.length);
    for (const layer of roundtrip.children) {
      assert.ok(Math.abs(layer.opacity - 0.5) < 0.005);
      assert.equal(layer.blendMode, layer.name.replace(/-/g, " "));
      assert.equal(Boolean(layer.hidden), !visible);
    }
  });
}

test("New canvas waits for generation output staging and preserves its completed result", async () => {
  let finishImage;
  const staged = []; let switches = 0;
  const w = widget({ stagingItems: [], _documentRevision: 0,
    loadImage: () => new Promise(done => { finishImage = done; }), resultImageURL: image => image,
    addStagingItem: item => staged.push(item),
    createCanvasDocument: async () => { switches++; w._documentRevision++; return true; },
    runGeneration: () => w._stageGeneratedImages({ images: ["result"] }, null, "txt2img", {
      requestPanorama: null, requestDocumentRevision: w._documentRevision, bbox: {}, inferenceSize: {}, outputSize: {},
    }),
  });
  const pending = w.draw();
  await new Promise(resolve => setImmediate(resolve));
  const newDocument = vm.runInNewContext(modes.slice(modes.indexOf("export async function newUniCanvasDocument"), modes.indexOf("\nfunction installUniCanvasOutputActions")).replace("export ", "") + "\nnewUniCanvasDocument");
  const generationRevision = w._documentRevision;
  assert.equal(await newDocument(w), false);
  assert.equal(switches, 0);
  assert.equal(w._documentRevision, generationRevision);
  assert.equal(staged.length, 0);
  finishImage({});
  await pending;
  assert.equal(staged.length, 1);
  assert.equal(staged[0].url, "result");
  assert.equal(await newDocument(w), true);
  assert.equal(switches, 1);
  assert.equal(w._documentRevision, generationRevision + 1);
});

for (const edit of ["paint", "rename", "delete", "dispose", "unchanged"]) {
  test(`layer naming handles ${edit} while inference runs`, async () => {
    const originalFetch = globalThis.fetch;
    let resolve;
    globalThis.fetch = () => new Promise(done => { resolve = done; });
    try {
      const layer = { id: "A", name: "Layer", type: "raster", canvas: canvas(8, 8) };
      const w = widget({ layers: [layer], getLayerAlphaBounds: () => ({}), cloneCanvasCrop: () => ({ toDataURL: () => "pixels" }) });
      const pending = autoNameLayers(w, [layer]);
      if (edit === "paint") w.invalidateLayerRenderCaches(layer);
      if (edit === "rename") layer.name = "My name";
      if (edit === "delete") w.layers = [];
      if (edit === "dispose") w._disposed = true;
      resolve({ ok: true, json: async () => ({ names: [{ id: "A", name: "Subject" }] }) });
      await pending;
      assert.equal(layer.name, edit === "unchanged" ? "Subject" : edit === "rename" ? "My name" : "Layer");
      assert.equal(w._vnccsNameTokens.size, 0);
    } finally { globalThis.fetch = originalFetch; }
  });
}

for (const crop of [null, { x: 0, y: 0, width: 2, height: 8 }]) {
  for (const edit of ["unchanged", "generation"]) {
    test(`native layer naming sends complete pixels with ${crop ? "partial" : "no"} backing overlap (${edit})`, async () => {
      const originalFetch = globalThis.fetch;
      let uploaded, finish;
      globalThis.fetch = (_url, options) => {
        uploaded = JSON.parse(options.body);
        return new Promise(resolve => { finish = resolve; });
      };
      try {
        const layer = { id: "native", name: "Layer", type: "raster", canvas: canvas(8, 8),
          hiresCanvas: { toDataURL: () => "complete native pixels" },
          hiresRect: { x: -10, y: 0, width: 12, height: 8 } };
        const w = widget({ layers: [layer], getLayerAlphaBounds: () => crop,
          cloneCanvasCrop: () => ({ toDataURL: () => "clipped backing" }) });
        const pending = autoNameLayers(w, [layer]);
        if (edit === "generation") w._generationPreparing = true;
        finish?.({ ok: true, json: async () => ({ names: [{ id: layer.id, name: "Subject" }] }) });
        await pending;
        assert.equal(uploaded?.layers[0].image, "complete native pixels");
        assert.equal(layer.name, edit === "unchanged" ? "Subject" : "Layer");
        assert.equal(w._vnccsNameTokens.size, 0);
      } finally { globalThis.fetch = originalFetch; }
    });
  }

  test(`native thumbnails draw complete pixels with ${crop ? "partial" : "no"} backing overlap`, () => {
    const originalDocument = context.document, draws = [];
    context.document = { createElement: () => ({ getContext: () => ({
      drawImage: (...args) => draws.push(args), beginPath() {}, arc() {}, fill() {}, save() {}, restore() {},
    }) }) };
    try {
      const native = canvas(240, 100);
      const layer = { type: "raster", canvas: canvas(8, 8), opacity: 1,
        hiresCanvas: native, hiresRect: { x: -10, y: 0, width: 12, height: 8 } };
      const w = widget({ getLayerAlphaBounds: () => crop, drawCheckerboard() {}, configureImageContext: value => value });
      const thumb = w.getLayerThumbnailCanvas(layer, 68);
      assert.equal(draws[0]?.[0], native);
      assert.deepEqual(draws[0].slice(1, 5), [0, 0, 240, 100]);
      assert.equal(draws[0][7] / draws[0][8], 12 / 8, "the thumbnail keeps the displayed layer's aspect ratio");
      assert.equal(thumb.width, 68);
      assert.equal(thumb.height, 68);
      assert.equal(w.getLayerThumbnailCanvas(layer, 68), thumb, "unchanged thumbnails reuse their cached canvas");
      assert.equal(draws.length, 1);
    } finally { context.document = originalDocument; }
  });
}

test("staging masks count toward the retained history budget", () => {
  const undo = Array.from({ length: 20 }, () => ({ stagingItems: [{
    maskCanvas: canvas(), userMaskCanvas: canvas(), resultMaskCanvas: canvas(),
  }] }));
  trimPanoramaHistory(undo, []);
  assert.equal(undo.length, 2);
});

test("prompt enhancement cannot rewrite the prompt of a replaced document", async () => {
  const enhance = readFileSync(new URL("../web/unicanvas/prompt_enhance.mjs", import.meta.url), "utf8");
  let finish, rewritten = false;
  const ctx = { text: value => String(value).trim(), activeEnhanceEntry: () => ({}),
    flowGradient() {}, canvasImage: () => null, systemFor: () => "system", enhanceModel: () => "model", flash() {},
    setTextareaValue: () => { rewritten = true; }, fetch: () => new Promise(done => { finish = done; }) };
  const run = vm.runInNewContext(enhance.slice(enhance.indexOf("async function runEnhance("), enhance.indexOf("\nfunction flash(")) + "\nrunEnhance", ctx);
  const textarea = { value: "same prompt" };
  const button = { dataset: { enhance: "positive" }, parentElement: { querySelector: () => textarea },
    classList: { contains: () => false, add() {}, remove() {} }, setAttribute() {}, removeAttribute() {} };
  const w = { _documentRevision: 0, makeSettingsPayload: () => ({}), setStatus() {} };
  const pending = run(w, button);
  w._documentRevision++;
  finish({ ok: true, json: async () => ({ prompt: "old image enhancement" }) });
  await pending;
  assert.equal(rewritten, false);
});
