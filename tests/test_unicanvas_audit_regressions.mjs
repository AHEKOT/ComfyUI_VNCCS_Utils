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
  isImageLayer: layer => layer.type !== "mask", document: { createElement: () => canvas(1, 1) } };
const prototype = vm.runInNewContext(source.slice(source.indexOf("class UniCanvasWidget {"), source.indexOf("\napp.registerExtension(")) + "\nUniCanvasWidget.prototype", context);
const widget = props => Object.assign(Object.create(prototype), {
  panorama: null, layers: [], origin: { x: 0, y: 0 }, settings: {}, setStatus() {},
  cancelDeferredCanvasCommit() {}, syncPoseToolToActiveLayer() {}, syncActiveLayerControls() {},
  renderLayerList() {}, requestRender() {}, syncLightStateToWidget() {},
}, props);

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
