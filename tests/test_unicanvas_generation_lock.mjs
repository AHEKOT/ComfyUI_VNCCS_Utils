import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const modes = readFileSync(new URL("../web/unicanvas/modes.mjs", import.meta.url), "utf8");

class Element {
  constructor() { this.children = []; this.events = {}; this.inert = false; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  contains(target) { return this === target || this.children.some(child => child.contains(target)); }
  setAttribute() {}
  addEventListener(type, callback) { (this.events[type] ||= []).push(callback); }
  focus() { this.focused = true; }
  get firstChild() { return this.children[0]; }
  get lastChild() { return this.children.at(-1); }
}

const prototype = vm.runInNewContext(source.slice(source.indexOf("class UniCanvasWidget {"), source.indexOf("\napp.registerExtension("))
  + "\nUniCanvasWidget.prototype", { clearTimeout, console, document: { createElement: () => new Element() } });

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

function widget(values = {}) {
  const statuses = [];
  const w = Object.assign(Object.create(prototype), {
    container: new Element(), panorama: null, drawInProgress: false,
    _documentRevision: 4, _importRevision: 7,
    _assetsReady: Promise.resolve(), stateUploadPromise: Promise.resolve(),
    setStatus(message, error = false) { statuses.push({ message, error }); },
    runGeneration: async () => {},
  }, values);
  return { w, statuses };
}

test("Generate freezes edits immediately and waits for pending saves and assets before making a request", async () => {
  const save = deferred(), assets = deferred(), result = deferred();
  let runs = 0;
  const { w } = widget({ stateUploadPromise: save.promise, _assetsReady: assets.promise,
    runGeneration: () => { runs++; return result.promise; } });
  const pending = w.draw();
  assert.equal(w.editingBlocked, true);
  assert.equal(w.drawInProgress, false, "preparation is locked before the backend request exists");
  assert.equal(w._documentRevision, 5);
  assert.equal(w._importRevision, 8);
  await w.draw();
  assert.equal(runs, 0);

  assets.resolve();
  await settle();
  assert.equal(runs, 0, "an old upload must finish before request preparation");
  assert.equal(w.editingBlocked, true);
  save.resolve();
  await settle();
  assert.equal(runs, 1);
  assert.equal(w.editingBlocked, true);
  assert.equal(w.drawInProgress, false, "the wrapper keeps preparation stages locked even without drawInProgress");
  await w.draw();
  assert.equal(runs, 1, "a second click cannot start another request");
  result.resolve();
  await pending;
  assert.equal(w.editingBlocked, false);
  assert.equal(w.drawInProgress, false);
  assert.equal(w._interactionOverlay, null);
});

test("assets still loading keep the editor frozen after existing saves settle", async () => {
  const assets = deferred();
  let runs = 0;
  const { w } = widget({ _assetsReady: assets.promise, runGeneration: async () => { runs++; } });
  const pending = w.draw();
  await settle();
  assert.equal(w.editingBlocked, true);
  assert.equal(runs, 0);
  assets.resolve();
  await pending;
  assert.equal(runs, 1);
  assert.equal(w.editingBlocked, false);
});

test("Stop during request preparation cancels the draw without launching generation", async () => {
  const assets = deferred();
  let runs = 0;
  const { w, statuses } = widget({ _assetsReady: assets.promise, runGeneration: async () => { runs++; } });
  const pending = w.draw();
  await w.stopDraw();
  assert.equal(w._stopRequested, true);
  assert.equal(w.editingBlocked, true, "Stop cannot unlock while preparation is still running");
  assert.ok(statuses.some(item => /stop/i.test(item.message)));
  assets.resolve();
  await pending;
  assert.equal(runs, 0);
  assert.equal(w.editingBlocked, false);
});

for (const phase of ["save", "assets", "generation"]) {
  test(`a ${phase} failure reports the error and restores editing`, async () => {
    const failure = deferred();
    const values = phase === "save" ? { stateUploadPromise: failure.promise }
      : phase === "assets" ? { _assetsReady: failure.promise }
        : { runGeneration: () => failure.promise };
    const { w, statuses } = widget(values);
    const pending = w.draw();
    await settle();
    assert.equal(w.editingBlocked, true);
    failure.reject(new Error(`${phase} unavailable`));
    await pending;
    assert.equal(w.editingBlocked, false);
    assert.equal(w.drawInProgress, false);
    assert.equal(w._interactionOverlay, null);
    assert.ok(statuses.some(item => item.error && item.message.includes(`${phase} unavailable`)), "the failed operation must not look saved or complete");
  });
}

test("starting generation invalidates a pending embedded pose library response", async () => {
  const assets = deferred();
  const studio = { _libraryLoadToken: 12, animationTimeline: { stopPlayback() {} } };
  const { w } = widget({ _assetsReady: assets.promise,
    poseEditor: { studio, commit() {}, flushBackdropSync() {}, isGestureActive: () => false } });
  const token = studio._libraryLoadToken;
  const pending = w.draw();
  assert.notEqual(studio._libraryLoadToken, token);
  assets.resolve();
  await pending;
});

for (const gesture of ["pointer", "transform", "pose"]) {
  test(`an unfinished ${gesture} edit must finish before Generate locks the document`, async () => {
    let runs = 0;
    const values = gesture === "pointer" ? { isPointerDown: true }
      : gesture === "transform" ? { transformDraft: {} }
        : { poseEditor: { isGestureActive: () => true } };
    const { w, statuses } = widget({ ...values, runGeneration: async () => { runs++; } });
    await w.draw();
    assert.equal(runs, 0);
    assert.equal(w.editingBlocked, false);
    assert.equal(w._documentRevision, 4);
    assert.ok(statuses.some(item => item.error));
  });
}

for (const flag of ["_generationPreparing", "_generationLocked", "drawInProgress", "_canvasOperation"]) {
  test(`${flag} prevents pointer changes, Undo, Redo and late layer edits`, () => {
    let edits = 0;
    const { w } = widget({ [flag]: true, tool: "sam", layers: [], origin: { x: 0, y: 0 },
      undoSamPoint() { edits++; return true; }, redoSamPoint() { edits++; return true; },
      canvasPointFromEvent() { edits++; return { x: 0, y: 0 }; },
      panorama: { flushCamera() { edits++; }, endCamera() { edits++; } },
      isPointerDown: true, pointerMode: "panorama", hoverPoint: null,
    });
    const layer = { id: "layer", canvas: { width: 8, height: 8 }, _pixelRevision: 1 };
    w.layers.push(layer);
    const state = w.captureLayerEditState(layer);
    const event = { button: 1, preventDefault() {}, stopPropagation() {} };
    w.onPointerDown(event); w.onPointerMove(event); w.onPointerUp(event);
    w.onPointerHover(event); w.onPointerLeave(event); w.onWheel(event);
    w.undo(); w.redo();
    assert.equal(edits, 0);
    assert.equal(w.hoverPoint, null);
    assert.equal(w.isLayerEditStateCurrent(state), false);
    w[flag] = false;
    assert.equal(w.isLayerEditStateCurrent(state), true, "the same unchanged layer is editable after unlocking");
  });

  test(`${flag} leaves automatic saving pending without serializing the document`, async () => {
    let serialized = 0, scheduled = 0, uploaded = 0;
    const { w } = widget({ [flag]: true, pendingStateUpload: true,
      buildSerializedState() { serialized++; return {}; },
      scheduleStateUpload() { scheduled++; },
      uploadStatePayload() { uploaded++; },
    });
    await w.uploadStateSnapshot();
    assert.equal(serialized, 0);
    assert.equal(uploaded, 0);
    assert.equal(scheduled, 1);
    assert.equal(w.pendingStateUpload, true);
  });
}

test("locking preserves existing inert state and leaves only the overlay Stop usable", async () => {
  const result = deferred();
  const { w } = widget({ runGeneration: () => result.promise });
  const editable = new Element(), previouslyInert = new Element();
  previouslyInert.inert = true;
  w.container.append(editable, previouslyInert);
  const pending = w.draw();
  assert.equal(editable.inert, true);
  assert.equal(previouslyInert.inert, true);
  assert.equal(w._interactionOverlay.inert, false);
  let stops = 0;
  w.stopDraw = async () => { stops++; };
  w._interactionOverlay.lastChild.events.click[0]({ preventDefault() {}, stopPropagation() {} });
  assert.equal(stops, 1);
  result.resolve();
  await pending;
  assert.equal(editable.inert, false);
  assert.equal(previouslyInert.inert, true);
  assert.equal(w.container.children.length, 2);
});

test("the keyboard can reach Stop in node mode after focus returned from outside the widget", () => {
  let stops = 0, prevented = 0, stopped = 0;
  const { w } = widget({ _generationLocked: true, stopDraw: () => { stops++; } });
  w.syncInteractionLock();
  const target = w._interactionOverlay.lastChild;
  const start = modes.indexOf("function uniCanvasHistoryOwner(");
  const end = modes.indexOf("\nfunction handleUniCanvasHistoryKeyUp(", start);
  const onKey = vm.runInNewContext(modes.slice(start, end) + "\nhandleUniCanvasHistoryKeyDown", {
    document: { body: { classList: { contains: () => false } } },
    UNICANVAS_STANDALONE_BODY_CLASS: "standalone", standaloneHistoryWidget: null,
    uniCanvasModeWidgets: new Set([w]),
    isUniCanvasCanvasFocused: () => false, installUniCanvasChangeTrackerGate() {},
  });
  onKey({ key: "Enter", target, preventDefault() { prevented++; }, stopImmediatePropagation() { stopped++; } });
  assert.equal(stops, 1);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
});
