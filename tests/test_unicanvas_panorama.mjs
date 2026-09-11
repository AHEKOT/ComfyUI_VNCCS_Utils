import { isImageLayer, serializePose, poseGenerationLayer, mergePoseCache } from "../web/vnccs_unicanvas_pose_state.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { normalizePanorama, isPanoramaCandidate, viewToSphere, sphereToView, PanoramaDocument, trimPanoramaHistory } from "../web/vnccs_unicanvas_panorama.mjs";

const settings = (extra = {}) => normalizePanorama({ projection: "equirectangular", width: 4096, height: 2048, ...extra });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test("panorama detection only suggests wide images; settings are bounded", () => {
  assert.equal(isPanoramaCandidate(2048, 1024), true);
  assert.equal(isPanoramaCandidate(1920, 1080), false);
  assert.equal(isPanoramaCandidate(1024, 2048), false);
  assert.equal(isPanoramaCandidate(10, 0), false);
  assert.equal(normalizePanorama(null), null);
  assert.equal(settings({ yaw: 720 }).yaw, 0);
  assert.equal(settings({ pitch: 180 }).pitch, 90);
  assert.equal(settings({ roll: 450 }).roll, 90);
  assert.equal(settings({ roll: undefined }).roll, 0);
  assert.equal(settings({ fov: 180 }).fov, 120);
  assert.throws(() => settings({ width: 16384 }), /dimensions/);
  assert.throws(() => settings({ height: 8192, width: 8192 }), /dimensions/);
  assert.throws(() => settings({ projection: "cubemap" }), /Unsupported/);
});

test("screen/sphere round trip covers seam, poles, and wide/narrow FOV", () => {
  for (const yaw of [-180, -90, 0, 90, 179.9]) for (const pitch of [-90, -60, 0, 60, 90]) for (const fov of [25, 90, 120]) {
    const camera = settings({ yaw, pitch, fov });
    for (const u of [.01, .2, .5, .8, .99]) for (const v of [.01, .2, .5, .8, .99]) {
      const sphere = viewToSphere(u, v, camera);
      const view = sphereToView(sphere.u, sphere.v, camera);
      assert.ok(view, JSON.stringify({ camera, u, v, sphere }));
      close(view.u, u); close(view.v, v);
    }
  }
  assert.equal(sphereToView(0, .5, settings()), null, "back hemisphere must not receive edits");
});

test("a full turn returns the same surface and opposite seam edges are adjacent", () => {
  const camera = settings({ yaw: 180 });
  const left = viewToSphere(.49, .5, camera), right = viewToSphere(.51, .5, camera);
  assert.ok(left.u > .99 && right.u < .01);
  const a = viewToSphere(.2, .3, { ...camera, yaw: 540 }), b = viewToSphere(.2, .3, camera);
  close(a.u, b.u); close(a.v, b.v);
});

class Element {
  constructor() { this.children = []; this.events = {}; this.style = {}; this.dataset = {}; this.value = ""; this.classList = { add() {}, toggle() {} }; }
  append(...children) { this.children.push(...children); }
  prepend(child) { this.children.unshift(child); }
  insertBefore(child) { this.children.push(child); }
  setAttribute() {}
  addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
  fire(name) { for (const callback of this.events[name] || []) callback({ preventDefault() {}, stopPropagation() {} }); }
  querySelector() { return null; }
}
const source = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const context = {
  isImageLayer, serializePose, poseGenerationLayer, mergePoseCache,
  normalizePanorama, isPanoramaCandidate, PanoramaDocument, trimPanoramaHistory,
  document: { createElement: () => new Element() },
  window: { setTimeout: () => 0 }, clearTimeout, URLSearchParams,
  uid: () => "new-layer", HISTORY_LIMIT: 20,
};
const prototype = vm.runInNewContext(source.slice(source.indexOf("class UniCanvasWidget {"), source.indexOf("\napp.registerExtension(")) + "\nUniCanvasWidget.prototype", context);
const widget = (values = {}) => Object.assign(Object.create(prototype), {
  layers: [], panorama: null, bbox: { x: 0, y: 0, width: 1024, height: 1024 }, origin: { x: 0, y: 0 }, size: { width: 1024, height: 1024 },
  setStatus() {}, requestRender() {}, syncLightStateToWidget() {}, scheduleFullSync() {}, ...values,
});

test("panorama panel contains only the orbit widget, with no extra buttons or text", () => {
  let received;
  context.PanoramaOrbitControl = class {
    constructor(canvas) { this.canvas = canvas; }
    update(doc, camera) { received = { doc, camera }; }
  };
  const doc = { settings: settings({ roll: 30 }) };
  const w = widget({ panorama: doc, side: new Element(), tools: new Element() });
  w.buildPanoramaControls();
  assert.equal(w.panoramaPanel.children.length, 1);
  assert.equal(w.panoramaPanel.children[0], w.panoramaOrbit.canvas);
  assert.equal(w.panoramaPanel.hidden, false);
  assert.equal(received.doc, doc); assert.equal(received.camera.roll, 30);
  const panelSource = source.slice(source.indexOf("  buildPanoramaControls()"), source.indexOf("  choosePanoramaImport("));
  assert.doesNotMatch(panelSource, /_button|_section|createElement\("(?:button|input|label)"\)|textContent/);
  assert.doesNotMatch(source, /Export panorama PNG|Rotate panorama|Square = editing view/);
  w.panorama = null; w.updatePanoramaControls();
  assert.equal(w.panoramaPanel.hidden, true); assert.equal(received.doc, null);
});

test("rotation coalesces pointer updates and renders the newest value before release", () => {
  const oldRAF = globalThis.requestAnimationFrame, oldCancel = globalThis.cancelAnimationFrame;
  const frames = new Map(); let frameId = 0;
  globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  try {
    const projected = [], rendered = [];
    const doc = Object.assign(Object.create(PanoramaDocument.prototype), {
      settings: settings(), frame: null, pendingCamera: null,
      widget: { updatePanoramaControls() {}, requestRender: () => rendered.push(true), syncLightStateToWidget() {}, scheduleFullSync() {} },
      project: preview => projected.push([doc.settings.yaw, preview]),
    });
    doc.setCamera({ yaw: 10 }); doc.setCamera({ yaw: 25 });
    assert.equal(frames.size, 1);
    const [id, callback] = frames.entries().next().value; frames.delete(id); callback();
    assert.deepEqual(projected, [[25, true]]); assert.equal(rendered.length, 1);
    doc.setCamera({ yaw: 45 }); doc.endCamera();
    assert.equal(doc.settings.yaw, 45); assert.equal(frames.size, 0);
    assert.deepEqual(projected.at(-1), [45, undefined]);
  } finally { globalThis.requestAnimationFrame = oldRAF; globalThis.cancelAnimationFrame = oldCancel; }
});

test("canvas dragging changes camera on pointermove", () => {
  const turns = [];
  const w = widget({ panorama: { setCamera: value => turns.push(value) }, isPointerDown: true, pointerMode: "panorama",
    dragStart: { screen: { x: 100, y: 100 }, camera: { yaw: 0, pitch: 0, fov: 90 } }, view: { scale: 1 },
    canvasPointFromEvent: () => ({ x: 612, y: 356 }),
  });
  w.onPointerMove({ preventDefault() {}, stopPropagation() {} });
  assert.equal(turns.length, 1); assert.equal(turns[0].yaw, -45); assert.equal(turns[0].pitch, 22.5);
});

test("base layer ordering is enforced while panorama mode is active", () => {
  const base = { id: "base", type: "raster" }, edit = { id: "edit", type: "raster" }, mask = { id: "mask", type: "mask" };
  const w = widget({ panorama: { settings: settings({ baseLayerId: "base" }) }, layers: [base, edit, mask] });
  w.normalizeLayerOrder(); assert.deepEqual(Array.from(w.layers, layer => layer.id), ["mask", "edit", "base"]);
});

test("pixel undo restores the spherical source at the current camera", () => {
  let committed = 0, projected = 0;
  const layer = { id: "edit", panoramaCanvas: { pixels: "before" }, canvas: { pixels: "perspective" } };
  const w = widget({ panorama: { settings: settings({ yaw: 90 }), commitLayer() { committed++; }, projectLayer() { projected++; } },
    cloneCanvas: c => ({ ...c }), cloneCanvasCrop: c => ({ ...c }), getLayerAlphaBounds: () => ({ x: 0, y: 0, width: 16, height: 16 }),
  });
  const snapshot = w.createLayerPixelSnapshot(layer);
  assert.equal(committed, 1);
  layer.panoramaCanvas.pixels = "after";
  w.restoreLayerPixelSnapshot(layer, snapshot);
  assert.equal(layer.panoramaCanvas.pixels, "before"); assert.equal(projected, 1);
  assert.equal(w.panorama.settings.yaw, 90);
  assert.notEqual(layer.panoramaCanvas, snapshot.panoramaCanvas);
});

test("serialization contains full panorama pixels and leaves legacy workflows in v2", () => {
  const layer = { id: "base", type: "raster", panoramaCanvas: { toDataURL: () => "FULL-PANORAMA" } };
  const w = widget({ panorama: { settings: settings(), commit() {}, commitLayer() {} }, layers: [layer], getStateCacheId: () => "cache", settings: {} });
  const state = w.buildSerializedState(true);
  assert.equal(state.version, 3); assert.equal(state.layers[0].dataURL, "FULL-PANORAMA");
  assert.equal(state.layers[0].crop.width, 4096); assert.equal(state.layers[0].crop.height, 2048);
  assert.equal(state.bbox.width, 1024);
  w.panorama = null; w.layers = [];
  assert.equal(w.buildSerializedState(true).version, 2);
});

test("queue synchronization commits pixels before projecting and awaits successful storage", async () => {
  const order = [];
  const w = widget({ panorama: { commit: () => order.push("commit"), endCamera: () => order.push("view") },
    syncToNode: () => order.push("metadata"), flushStateUpload: async () => { order.push("upload"); return true; },
  });
  await w.preparePanoramaForQueue(); assert.deepEqual(order, ["commit", "view", "metadata", "upload"]);
  w.flushStateUpload = async () => false;
  await assert.rejects(w.preparePanoramaForQueue(), /queue stopped/);
  w.isPointerDown = true;
  await assert.rejects(w.preparePanoramaForQueue(), /Finish/);
});

test("panorama uploads cannot overwrite newer state by finishing out of order", async () => {
  const started = []; let release;
  const w = widget({ performStateUpload: async state => {
    started.push(state.revision);
    if (state.revision === 1) await new Promise(resolve => { release = resolve; });
    return true;
  } });
  const first = w.uploadStatePayload({ panorama: {}, revision: 1 });
  const second = w.uploadStatePayload({ panorama: {}, revision: 2 });
  await Promise.resolve(); assert.deepEqual(started, [1]);
  release(); await Promise.all([first, second]); assert.deepEqual(started, [1, 2]);
});

test("generation retains its request camera when the user rotates while waiting", async () => {
  let release;
  context.fetch = () => new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ images: [{ filename: "result.png" }] }) }); });
  const doc = { settings: settings({ yaw: 10, pitch: 20 }), commit() {} };
  const w = widget({ panorama: doc, settings: { batch_size: 1, steps: 1 }, stagingItems: [], drawBtn: {},
    flushSettingsToWidget() {}, normalizeGenerationSettings: () => ({ loader: {} }),
    getInferenceSize: () => ({ width: 1024, height: 1024 }),
    getRasterContentInBboxStats: () => ({ nonzeroAlphaPixels: 1024 * 1024 }),
    getMaskContentInBboxStats: () => ({ nonzeroAlphaPixels: 1 }),
    makeExportCanvas: () => ({ toDataURL: () => "request-view" }), makeSettingsPayload: () => ({}),
    updateGenerationProgress() {}, startDrawProgressPolling() {}, stopDrawProgressPolling() {},
    imageResultToURL: () => "result", loadImage: async () => ({}), render() {},
  });
  const pending = w.draw();
  doc.settings.yaw = 120; doc.settings.pitch = -30;
  release(); await pending;
  assert.equal(w.stagingItems.length, 1);
  assert.equal(w.stagingItems[0].panoramaCamera.yaw, 10);
  assert.equal(w.stagingItems[0].panoramaCamera.pitch, 20);
});

test("pixel history is bounded by memory and keeps the latest gesture", () => {
  const pixelCanvas = () => ({ width: 16, height: 16, getContext() {} });
  const shared = pixelCanvas();
  const undo = [{ panoramaCanvas: pixelCanvas() }, { before: { panoramaCanvas: shared }, after: { panoramaCanvas: pixelCanvas() } }];
  const redo = [{ panoramaCanvas: shared }];
  trimPanoramaHistory(undo, redo, 2048);
  assert.equal(undo.length, 1); assert.equal(redo.length, 1);
  assert.equal(undo[0].before.panoramaCanvas, shared, "shared surfaces count once");
});

function restorationWidget(overrides = {}) {
  return widget({
    settings: {}, layers: [{ id: "original", canvas: {} }],
    _createCanvas: (width, height) => ({ width, height, getContext: () => ({ drawImage() {} }) }),
    loadImage: async () => ({ width: 4096, height: 2048 }), getLayerAlphaBounds: () => null,
    saveLocalStateBackup() {}, syncPromptControls() {}, updateSnapButton() {}, renderLayerList() {}, ...overrides,
  });
}

test("panorama restoration is transactional and rejects incomplete cached pixels", async () => {
  const realDocument = context.PanoramaDocument;
  const created = [];
  class RestoredDocument {
    constructor(w, data) { this.widget = w; this.settings = data; this.disposed = false; created.push(this); }
    ensureLayer(layer) {
      return layer.panoramaCanvas ||= { width: 4096, height: 2048, getContext: () => ({ drawImage() {} }) };
    }
    project() { this.projected = true; }
    dispose() { this.disposed = true; }
  }
  context.PanoramaDocument = RestoredDocument;
  try {
    const old = { dispose() { this.disposed = true; } };
    const w = restorationWidget({ panorama: old });
    const original = w.layers;
    const state = { version: 3, panorama: settings({ baseLayerId: "base", yaw: 45 }), layers: [
      { id: "base", type: "raster", dataURL: "base-image" }, { id: "edit", type: "raster" },
    ] };
    await w.applySerializedState(state);
    assert.equal(w.layers, original); assert.equal(w.panorama, old); assert.equal(old.disposed, undefined);
    assert.equal(created[0].disposed, true);
    state.layers[1].dataURL = "edit-image";
    await w.applySerializedState(state);
    assert.equal(w.panorama.settings.yaw, 45); assert.equal(w.panorama.projected, true);
    assert.equal(w.layers.at(-1).id, "base"); assert.equal(old.disposed, true);
    assert.equal(w.bbox.width, 1024); assert.equal(w.layers[0].panoramaCanvas.width, 4096);
  } finally { context.PanoramaDocument = realDocument; }
});

test("an older asynchronous panorama restore cannot replace a newer document", async () => {
  const realDocument = context.PanoramaDocument;
  const created = [];
  context.PanoramaDocument = class {
    constructor(w, data) { this.widget = w; this.settings = data; created.push(this); }
    ensureLayer(layer) { return layer.panoramaCanvas ||= { width: 4096, height: 2048, getContext: () => ({ drawImage() {} }) }; }
    project() {}
    dispose() { this.disposed = true; }
  };
  try {
    let release;
    const w = restorationWidget({ loadImage: url => url === "old" ? new Promise(resolve => { release = () => resolve({ width: 4096, height: 2048 }); }) : Promise.resolve({ width: 4096, height: 2048 }) });
    const state = name => ({ version: 3, panorama: settings({ baseLayerId: name }), layers: [{ id: name, type: "raster", dataURL: name }] });
    const pending = w.applySerializedState(state("old"));
    await w.applySerializedState(state("new")); release(); await pending;
    assert.equal(w.layers[0].id, "new"); assert.equal(w.panorama.settings.baseLayerId, "new");
    assert.equal(created[0].disposed, true); assert.equal(created[1].disposed, undefined);
  } finally { context.PanoramaDocument = realDocument; }
});


const pixelCanvas = pixels => ({ width: 8, height: 8, pixels, getContext() { return {}; } });
class ExitDocument {
  constructor(w, data = settings({ width: 16, height: 8, baseLayerId: "base", yaw: 45 })) {
    this.widget = w; this.settings = data;
    this.renderer = { render: surface => pixelCanvas(`view:${surface.pixels}`) };
  }
  commit() { this.committed = true; }
  commitLayer() {}
  project() {
    this.projected = true;
    for (const layer of this.widget.layers) layer.canvas = pixelCanvas(`view:${layer.panoramaCanvas.pixels}`);
  }
  dispose() { this.disposed = true; }
}
function exitWidget(overrides = {}) {
  const base = { id: "base", type: "raster", locked: true, visible: true, opacity: 1, canvas: pixelCanvas("preview"), panoramaCanvas: pixelCanvas("whole-base") };
  const edit = { id: "edit", type: "raster", locked: false, visible: false, opacity: .5, blendMode: "multiply", canvas: pixelCanvas("preview"), panoramaCanvas: pixelCanvas("whole-edit") };
  const w = widget({ layers: [edit, base], settings: {}, tool: "panorama", activeLayerId: "base",
    undoStack: [], redoStack: [], stagingItems: [], activeStagingIndex: -1,
    _createCanvas: () => pixelCanvas("empty"), cloneCanvas: c => c ? { ...c } : null,
    cancelDeferredCanvasCommit() {}, clearSamPrompt() { this.samCleared = true; },
    setTool(tool) { this.tool = tool; }, syncActiveLayerControls() {}, renderLayerList() {},
    updateSnapButton() {}, syncPromptControls() {}, getStateCacheId: () => "exit-state",
    confirmInWidget: async () => true, syncToNode() {}, flushStateUpload: async () => true,
    syncInferenceControls() {}, fitView() {}, getLayerAlphaBounds: () => null,
    ...overrides,
  });
  w.panorama = new ExitDocument(w);
  return w;
}

test("there is no separate exit panorama button", () => {
  assert.doesNotMatch(source, /_button\("Exit panorama/);
  assert.equal(prototype.exitPanorama, undefined);
});

test("deleting the base asks before irreversibly clearing the panorama workspace", async () => {
  let confirm, question;
  const w = exitWidget({ confirmInWidget: (...args) => { question = args; return new Promise(resolve => { confirm = resolve; }); } });
  const doc = w.panorama, layers = w.layers;
  w.undoStack = [{ panorama: doc.settings }]; w.redoStack = [{ previous: true }];
  w.stagingItems = [{ img: pixelCanvas("result") }]; w.activeStagingIndex = 0;
  const pending = w.deleteLayer("base");
  assert.equal(w.panorama, doc); assert.equal(w.layers, layers); assert.equal(doc.disposed, undefined);
  assert.match(question[1], /entire panorama workspace/); assert.match(question[1], /cannot be undone/);
  assert.equal(question[2], "Delete panorama");
  confirm(true); assert.equal(await pending, true);
  assert.equal(doc.disposed, true); assert.equal(w.panorama, null); assert.equal(w.tool, "move");
  assert.deepEqual(Array.from(w.layers, layer => layer.type), ["mask", "raster"]);
  assert.ok(w.layers.every(layer => layer.canvas.pixels === "empty" && !layer.panoramaCanvas));
  assert.equal(w.stagingItems.length, 0); assert.equal(w.activeStagingIndex, -1);
  assert.equal(w.undoStack.length, 0); assert.equal(w.redoStack.length, 0);
  w.undo(); w.redo(); assert.equal(w.panorama, null);
  assert.equal(w.samCleared, true);
  const state = w.buildSerializedState(false);
  assert.equal(state.version, 2); assert.equal(state.panorama, null);
});

test("canceling deletion keeps the complete workspace and history unchanged", async () => {
  const w = exitWidget({ confirmInWidget: async () => false }), doc = w.panorama, layers = w.layers;
  const undo = w.undoStack = [{ before: true }], redo = w.redoStack = [{ after: true }];
  const staging = w.stagingItems = [{ img: pixelCanvas("result") }];
  assert.equal(await w.deleteLayer("base"), false);
  assert.equal(w.panorama, doc); assert.equal(w.layers, layers); assert.equal(doc.disposed, undefined);
  assert.equal(w.undoStack, undo); assert.equal(w.redoStack, redo); assert.equal(w.stagingItems, staging);
  assert.equal(w._panoramaDeletePending, false);
});

test("deleting the only panorama layer leaves a blank drawable document", async () => {
  const w = exitWidget();
  w.layers = w.layers.filter(layer => layer.id === "base");
  await w.deleteLayer("base");
  assert.equal(w.panorama, null); assert.equal(w.layers.length, 2);
  assert.equal(w.layers.find(layer => layer.type === "raster").canvas.pixels, "empty");
  assert.equal(w.activeLayerId, w.layers.find(layer => layer.type === "raster").id);
});

test("deleting an overlay does not close panorama mode or prompt for workspace deletion", () => {
  const w = exitWidget({ confirmInWidget() { assert.fail("not a panorama deletion"); } }), doc = w.panorama;
  w.deleteLayer("edit");
  assert.equal(w.panorama, doc); assert.equal(w.layers.length, 1); assert.equal(w.layers[0].id, "base");
});

test("deletion restores bbox controls and panorama import", async () => {
  const w = exitWidget(), bbox = {};
  w.panoramaPanel = {};
  w.tools = { querySelector: () => bbox };
  w.updatePanoramaControls();
  assert.equal(bbox.hidden, true);
  await w.deleteLayer("base");
  assert.equal(bbox.hidden, false); assert.equal(w.panoramaPanel.hidden, true);
});

test("an active edit or failed blank-canvas allocation leaves the panorama intact", async () => {
  const w = exitWidget({ transformDraft: {} }), doc = w.panorama;
  assert.equal(await w.deleteLayer("base"), false); assert.equal(w.panorama, doc);
  w.transformDraft = null;
  w._createCanvas = () => { throw new Error("allocation failed"); };
  assert.equal(await w.deleteLayer("base"), false); assert.equal(w.panorama, doc); assert.equal(doc.disposed, undefined);
  assert.equal(w.undoStack.length, 0);
});

test("only one deletion dialog opens and its approval cannot delete a replacement panorama", async () => {
  let confirm, count = 0;
  const w = exitWidget({ confirmInWidget: () => { count++; return new Promise(resolve => { confirm = resolve; }); } });
  const pending = w.deleteLayer("base");
  assert.equal(await w.deleteLayer("base"), false); assert.equal(count, 1);
  const replacement = w.panorama = new ExitDocument(w);
  confirm(true); assert.equal(await pending, false);
  assert.equal(w.panorama, replacement); assert.equal(replacement.disposed, undefined); assert.equal(w.layers.length, 2);
});

test("deletion clears old local backups after pending panorama uploads finish", async () => {
  const removed = [];
  const previousStorage = context.window.localStorage;
  context.window.localStorage = { removeItem: key => removed.push(key) };
  try {
    let finish, started;
    const uploading = new Promise(resolve => { started = resolve; });
    const w = exitWidget({ flushStateUpload: () => new Promise(resolve => { finish = resolve; started(); }) });
    const pending = w.deleteLayer("base");
    await uploading;
    assert.equal(w.panorama, null); assert.equal(removed.length, 2);
    finish(true); await pending;
    assert.equal(removed.length, 4);
    assert.equal(removed[0], removed[2]); assert.equal(removed[1], removed[3]);
  } finally { context.window.localStorage = previousStorage; }
});

test("the flat state after exit waits for older panorama cache writes", async () => {
  const writes = []; let release;
  const w = widget({ performStateUpload: async state => {
    writes.push(state.panorama ? "panorama" : "flat");
    if (state.panorama) await new Promise(resolve => { release = resolve; });
  } });
  const old = w.uploadStatePayload({ panorama: {} });
  const flat = w.uploadStatePayload({ panorama: null });
  await Promise.resolve(); assert.deepEqual(writes, ["panorama"]);
  release(); await Promise.all([old, flat]); assert.deepEqual(writes, ["panorama", "flat"]);
});

test("confirmation respects keyboard Cancel and blocks underlying canvas shortcuts", async () => {
  const oldDocument = context.document, oldRAF = context.requestAnimationFrame;
  class DialogElement extends Element {
    appendChild(child) { this.children.push(child); }
    focus() {}
    remove() {}
  }
  context.document = { createElement: () => new DialogElement() };
  context.requestAnimationFrame = callback => callback();
  try {
    for (const [key, buttonIndex, expected] of [["Enter", 0, false], ["Escape", 1, false], ["Enter", 1, true]]) {
      const w = widget({ container: new DialogElement() });
      const result = w.confirmInWidget("Delete panorama?", "Cannot be undone", "Delete panorama");
      const overlay = w.container.children[0], buttons = overlay.children[0].children[2].children;
      let stopped = false, prevented = false;
      overlay.events.keydown[0]({ key, target: buttons[buttonIndex],
        stopPropagation() { stopped = true; }, preventDefault() { prevented = true; } });
      assert.equal(await result, expected); assert.equal(stopped, true); assert.equal(prevented, true);
    }
  } finally { context.document = oldDocument; context.requestAnimationFrame = oldRAF; }
});


test("rolled screen/sphere round trips preserve editing coordinates at seam and poles", () => {
  for (const yaw of [-180, -90, 0, 179]) for (const pitch of [-90, -45, 0, 45, 90]) for (const roll of [-180, -90, -30, 45, 120]) {
    const camera = settings({ yaw, pitch, roll });
    for (const [u, v] of [[.01, .25], [.3, .98], [.5, .5], [.7, .1], [.98, .75]]) {
      const sphere = viewToSphere(u, v, camera), view = sphereToView(sphere.u, sphere.v, camera);
      assert.ok(view); close(view.u, u); close(view.v, v);
    }
  }
});

test("standard PSD export keeps all spherical pixels regardless of roll or viewport", async () => {
  let result, downloaded;
  const previousBlob = context.Blob; context.Blob = Blob;
  try {
    const base = { id: "base", name: "Base", type: "raster", visible: true, opacity: 1, panoramaCanvas: { pixels: "complete base" } };
    const edit = { id: "edit", name: "Edit", type: "raster", visible: true, opacity: .5, panoramaCanvas: { pixels: "complete edit" } };
    const w = widget({ layers: [edit, base], panorama: { settings: settings({ roll: 75, yaw: 123 }), commit() {} },
      loadAgPsd: async () => ({ writePsd: data => { result = data; return new Uint8Array(); } }),
      downloadBlob: (blob, filename) => { downloaded = filename; },
    });
    await w.exportPSD();
    assert.equal(result.width, 4096); assert.equal(result.height, 2048);
    assert.deepEqual(Array.from(result.children, layer => layer.canvas.pixels), ["complete base", "complete edit"]);
    assert.equal(downloaded, "unicanvas-panorama.psd");
  } finally { context.Blob = previousBlob; }
});
