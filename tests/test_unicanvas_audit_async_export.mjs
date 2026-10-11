import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { compositeBlendModeToPsd } from "../web/unicanvas/layer_tools.mjs";
import { writePsd, readPsd, initializeCanvas } from "../web/vendor/ag-psd.bundle.mjs";

const source = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const context = { console, clearTimeout, compositeBlendModeToPsd, Blob, isImageLayer: layer => layer.type !== "mask" };
const prototype = vm.runInNewContext(source.slice(source.indexOf("class UniCanvasWidget {"), source.indexOf("\napp.registerExtension(")) + "\nUniCanvasWidget.prototype", context);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("outpaint overlap uses the captured generation settings", () => {
  const width = 64, height = 64;
  const raster = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 1; x < width; x++) raster[(y * width + x) * 4 + 3] = 255;
  let mask;
  context.document = { createElement: () => ({ getContext: () => ({
    getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4) }), putImageData: value => { mask = value.data; },
  }) }) };
  const w = Object.assign(Object.create(prototype), {
    settings: { mask_blur: 40, canvas_coherence_edge_size: 40 }, sanitizeMaskCanvas() {},
    makeRasterAlphaCanvas: () => ({ getContext: () => ({ getImageData: () => ({ data: raster }) }) }),
    getReadbackContext: canvas => canvas.getContext("2d"),
  });
  w.makeOutpaintMaskCanvas(null, { width, height }, { mask_blur: 16, canvas_coherence_edge_size: 16 });
  assert.equal(mask[(20 * width + 32) * 4 + 3], 255);
  assert.equal(mask[(20 * width + 33) * 4 + 3], 0, "next-run values must not expand the current mask");
});

test("Generate hands the captured outpaint settings to mask construction after asynchronous preparation", async () => {
  const assets = deferred(); let maskSettings, payload;
  context.poseGenerationLayer = () => null;
  context.window = { setTimeout() {} };
  context.fetch = async (_url, options) => { payload = JSON.parse(options.body); return { ok: true, json: async () => ({ images: ["result"] }) }; };
  const image = () => ({ toDataURL: () => "pixels" });
  const w = Object.assign(Object.create(prototype), {
    _assetsReady: assets.promise, bbox: { x: 0, y: 0, width: 64, height: 64 }, settings: { seed_mode: "fixed", mask_blur: 16, canvas_coherence_edge_size: 16 },
    stagingItems: [], drawBtn: {}, _isConfigLinked: () => false, normalizeGenerationSettings: () => ({ loader: {} }),
    flushSettingsToWidget() {}, makeSettingsPayload() { return { ...this.settings }; }, getModelBase: () => "sdxl",
    getInferenceSize: () => ({ width: 64, height: 64 }), setStatus() {},
    getRasterContentInBboxStats: () => ({ nonzeroAlphaPixels: 100 }), getMaskContentInBboxStats: () => ({ nonzeroAlphaPixels: 0 }),
    makeExportCanvas: image, makeOutpaintMaskCanvas(_mask, _size, settings) { maskSettings = settings; return image(); },
    updateGenerationProgress() {}, startDrawProgressPolling() {}, stopDrawProgressPolling() {}, _stageGeneratedImages() {}, render() {},
  });
  const pending = w.draw();
  w.settings.mask_blur = w.settings.canvas_coherence_edge_size = 40;
  assets.resolve(); await pending;
  assert.equal(payload.mode, "outpaint");
  assert.equal(maskSettings.mask_blur, 16); assert.equal(maskSettings.canvas_coherence_edge_size, 16);
  assert.equal(payload.settings.mask_blur, 16); assert.equal(w.settings.mask_blur, 40);
});

for (const pendingPreparation of ["_assetsReady", "stateUploadPromise"]) {
  test(`Stop immediately unlocks a preparation blocked by ${pendingPreparation}`, async () => {
    const blocked = deferred(); let requests = 0;
    const w = Object.assign(Object.create(prototype), { [pendingPreparation]: blocked.promise,
      drawBtn: {}, captureGenerationSettings: () => ({}), setStatus() {},
      runGeneration: async () => { requests++; },
    });
    const first = w.draw();
    assert.equal(w.editingBlocked, true);
    await w.stopDraw();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(w.editingBlocked, false, "Stop must not wait for assets or a server acknowledgement");
    await first;
    assert.equal(requests, 0);
    w[pendingPreparation] = Promise.resolve();
    await w.draw();
    assert.equal(requests, 1);
    blocked.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 1, "the cancelled preparation cannot launch a second request later");
  });
}

for (const stage of ["pose capture", "Config references"]) {
  test(`Stop cancels a stalled ${stage} without changing the next generation`, async () => {
    const blocked = deferred(), next = deferred();
    const pose = { id: "pose" };
    context.poseGenerationLayer = () => stage === "pose capture" ? pose : null;
    context.poseCharacterIssue = () => null;
    context.loadConfigReferences = () => blocked.promise;
    const w = Object.assign(Object.create(prototype), {
      drawBtn: {}, bbox: {}, panorama: null, settings: {}, setStatus() {},
      captureGenerationSettings: () => ({ settings: {}, loader: {}, modelBase: "flux_klein", inferenceSize: {},
        config: stage === "Config references" ? { references: [], settings: {} } : null }),
      poseEditor: { commit() {}, generation: () => blocked.promise },
    });
    const first = w.draw();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(w.drawInProgress, true);
    await w.stopDraw();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(w.editingBlocked, false, "cancellation must finish without resolving the stalled work");
    await first;
    w.runGeneration = () => { w.drawInProgress = true; return next.promise; };
    const second = w.draw();
    await new Promise(resolve => setImmediate(resolve));
    blocked.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(w.editingBlocked, true, "late completion cannot release the next generation lock");
    assert.equal(w.drawInProgress, true);
    assert.equal(w._stopRequested, false);
    next.resolve(); await second;
    assert.equal(w.editingBlocked, false);
  });
}

for (const retire of ["stop", "new draw", "dispose"]) {
  test(`progress responses are ignored after ${retire}`, async () => {
    const requests = [], rendered = [];
    context.fetch = () => { const request = deferred(); requests.push(request); return request.promise; };
    context.window = { setInterval: callback => callback, clearInterval() {} };
    const w = Object.assign(Object.create(prototype), { updateGenerationProgress: value => rendered.push(value.message) });
    w.startDrawProgressPolling("old");
    const oldTimer = w.drawProgressTimer;
    if (retire === "new draw") w.startDrawProgressPolling("new");
    else { w.stopDrawProgressPolling(); if (retire === "dispose") w._disposed = true; }
    requests[0].resolve({ ok: true, json: async () => ({ message: "obsolete" }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(rendered, []);
    await oldTimer();
    assert.equal(requests.length, retire === "new draw" ? 2 : 1, "retired intervals cannot launch new polls");
    if (retire === "new draw") {
      requests[1].resolve({ ok: true, json: async () => ({ message: "current" }) });
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(rendered, ["current"]);
    }
  });
}

test("slow progress responses never overlap requests or reverse sampling steps", async () => {
  const request = deferred(); let calls = 0;
  context.fetch = () => { calls++; return request.promise; };
  context.window = { setInterval: callback => callback, clearInterval() {} };
  const rendered = [], w = Object.assign(Object.create(prototype), { updateGenerationProgress: value => rendered.push(value.step) });
  w.startDrawProgressPolling("draw");
  w.drawProgressTimer();
  w.drawProgressTimer();
  assert.equal(calls, 1);
  request.resolve({ ok: true, json: async () => ({ step: 7 }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(rendered, [7]);
});

test("PSD export draws the same hires source and world bounds as the viewport", async () => {
  initializeCanvas(undefined, undefined, (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }));
  const draws = [];
  const hires = { width: 400, height: 200 }, proxy = { width: 16, height: 16 };
  context.document = { createElement: () => {
    const canvas = {};
    canvas.getContext = () => ({ save() {}, restore() {}, drawImage: (...args) => {
      draws.push(args);
      const data = new Uint8ClampedArray(canvas.width * canvas.height * 4);
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const offset = (y * canvas.width + x) * 4;
        data[offset + (args[0] === hires && x % 2 ? 2 : 0)] = 255;
        data[offset + 3] = 255;
      }
      canvas.imageData = { width: canvas.width, height: canvas.height, data };
    } });
    return canvas;
  } };
  let psd, roundtrip;
  const layer = { type: "raster", name: "Image", visible: true, opacity: 1, canvas: proxy,
    hiresCanvas: hires, hiresRect: { x: 30, y: 40, width: 40, height: 20 } };
  const w = Object.assign(Object.create(prototype), { panorama: null, layers: [layer], origin: { x: 0, y: 0 },
    setStatus(message, error) { if (error) throw Error(message); }, getCanvasAlphaBounds: () => ({ x: 0, y: 0, width: 16, height: 16 }),
    configureImageContext: value => value, downloadBlob() {}, loadAgPsd: async () => ({ writePsd(value) {
      psd = value;
      const children = value.children.map(({ canvas, ...layer }) => ({ ...layer, imageData: canvas.imageData }));
      const buffer = writePsd({ ...value, imageData: children[0].imageData, children });
      roundtrip = readPsd(buffer, { useImageData: true, skipCompositeImageData: true, skipThumbnail: true });
      return buffer;
    } }),
  });
  await w.exportPSD();
  assert.equal(psd.width, 40); assert.equal(psd.height, 20);
  assert.equal(psd.children[0].right, 40); assert.equal(psd.children[0].bottom, 20);
  assert.equal(draws[0][0], hires, "export must render the original pixels rather than the canvas proxy");
  assert.deepEqual(draws[0].slice(1), [0, 0, 400, 200, 0, 0, 40, 20]);
  assert.deepEqual([...roundtrip.children[0].imageData.data.slice(0, 8)], [255, 0, 0, 255, 0, 0, 255, 255]);
});

function exitHandler(w) {
  const start = source.indexOf("    this._flushStateBeforeUnload = (event)");
  const end = source.indexOf('    window.addEventListener("pagehide"', start);
  vm.runInNewContext(`(function () { ${source.slice(start, end)} }).call(w)`, { w });
  return (type = "beforeunload") => {
    let prevented = false;
    const event = { type, preventDefault() { prevented = true; } };
    w._flushStateBeforeUnload(event);
    return prevented;
  };
}

for (const field of ["pendingStateUpload", "stateUploadsPending", "settingsSyncTimer", "fullSyncTimer", "_pendingStateCacheId", "isPointerDown", "transformDraft"]) {
  test(`page exit protects ${field} before the upload is acknowledged`, () => {
    let flushed = false;
    const w = { [field]: true, flushStateUpload: keepalive => { flushed = keepalive; } };
    const exit = exitHandler(w);
    assert.equal(exit(), true);
    assert.equal(flushed, true);
    assert.equal(exit("pagehide"), false);
  });
}

test("page exit protects failed unbacked saves, and a successful retry clears the guard", async () => {
  let fail = true;
  context.fetch = async () => { if (fail) throw Error("offline"); return { ok: true, json: async () => ({ status: "ok" }) }; };
  const w = Object.assign(Object.create(prototype), { stateUploadRevision: 2, _stateLoadRevision: 1, stateCacheId: "current",
    saveLocalStateBackup: () => null, confirmLocalStateBackup() {}, setStatus() {}, flushStateUpload() {},
  });
  const state = { state_id: "current", layers: [] }, exit = exitHandler(w);
  assert.equal(await w.performStateUpload(state, false, 2), false);
  assert.equal(exit(), true);
  fail = false;
  assert.equal(await w.performStateUpload(state, false, 2), true);
  assert.equal(exit(), false);
});

test("page exit leaves unchanged and restoring documents alone", () => {
  for (const extra of [{}, { _isRestoring: true, _stateSaveFailed: true }, { _stateRestoreFailed: true, _stateSaveFailed: true }, { _disposed: true, _stateSaveFailed: true }]) {
    assert.equal(exitHandler({ ...extra, flushStateUpload() {} })(), false);
  }
});

for (const protectedBy of ["browser backup", "server acknowledgement"]) {
  test(`page exit does not warn when ${protectedBy} covers the pending snapshot`, async () => {
    const state = { state_id: "current", layers: [{ dataURL: "saved" }] }, request = deferred();
    context.fetch = () => request.promise;
    const w = Object.assign(Object.create(prototype), { stateUploadRevision: 2, _stateLoadRevision: 1, stateCacheId: "current",
      stateUploadsPending: 1, fullSyncTimer: 7, buildSerializedState: () => state,
      saveLocalStateBackup: () => protectedBy === "browser backup" ? { key: "backup", payload: "saved" } : null,
      confirmLocalStateBackup() {}, flushStateUpload() {},
    });
    const pending = w.performStateUpload(state, false, 2);
    if (protectedBy === "server acknowledgement") request.resolve({ ok: true, json: async () => ({ status: "ok" }) });
    else request.resolve({ ok: false, status: 500, json: async () => ({ error: "offline" }) });
    w.setStatus = () => {};
    await pending;
    const exit = exitHandler(w);
    assert.equal(exit(), false);
    state.layers[0].dataURL = "later edit";
    assert.equal(exit(), true, "a newer edit must not be covered by the previous protected snapshot");
  });
}

test("a failed upload cannot put the exit guard onto a replacement document", async () => {
  const request = deferred();
  context.fetch = () => request.promise;
  const w = Object.assign(Object.create(prototype), { stateUploadRevision: 2, _stateLoadRevision: 1, stateCacheId: "current",
    saveLocalStateBackup: () => null, setStatus() {}, flushStateUpload() {},
  });
  const pending = w.performStateUpload({ state_id: "current", layers: [] }, false, 2);
  w._stateLoadRevision++;
  request.resolve({ ok: false, status: 500, json: async () => ({ error: "offline" }) });
  await pending;
  assert.equal(exitHandler(w)(), false);
});
