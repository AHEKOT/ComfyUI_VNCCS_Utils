import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const modes = readFileSync(new URL("../web/unicanvas/modes.mjs", import.meta.url), "utf8");

class Element {
  constructor(tag = "div") { this.tag = tag; this.children = []; this.events = {}; this.inert = false; this.classList = { toggle() {} }; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  contains(target) { return this === target || this.children.some(child => child.contains(target)); }
  setAttribute() {}
  addEventListener(type, callback) { (this.events[type] ||= []).push(callback); }
  matches(selector) { return selector.split(", ").includes(this.tag); }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(selector.includes("vnccs-") ? child.editControl ? [child] : [] : child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  closest(selector) {
    if (selector === '.vnccs-uc-pose-root, .vnccs-uc-panorama-controls') return null;
    return this.editControl ? this : this.parent?.closest(selector) || null;
  }
  focus(options) { this.focused = true; this.focusOptions = options; domDocument.activeElement = this; }
  get firstChild() { return this.children[0]; }
  get lastChild() { return this.children.at(-1); }
}

const domDocument = { createElement: tag => new Element(tag), activeElement: null };
const context = { clearTimeout, console, document: domDocument, DEFAULT_SEED_MODE: "randomize",
  poseGenerationLayer: () => null, window: { setTimeout() {} },
  resolveConfigDrawSettings: () => ({ unsupported: "external model tensors" }) };
const prototype = vm.runInNewContext(source.slice(source.indexOf("class UniCanvasWidget {"), source.indexOf("\napp.registerExtension("))
  + "\nUniCanvasWidget.prototype", context);

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
    left: new Element(), drawControl: new Element(), drawBtn: new Element("button"), batchInput: new Element("input"),
    captureGenerationSettings: () => ({}),
    _documentRevision: 4, _importRevision: 7,
    _assetsReady: Promise.resolve(), stateUploadPromise: Promise.resolve(),
    setStatus(message, error = false) { statuses.push({ message, error }); },
    runGeneration: async () => {},
  }, values);
  w.stopBtn = w._button("STOP", "vnccs-uc-btn stop", () => void w.stopDraw());
  w.stopBtn.hidden = true;
  w.drawControl.append(w.drawBtn, w.stopBtn, w.batchInput);
  w.left.append(w.drawControl);
  w.container.append(w.left);
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
  assert.equal(w.stopBtn.hidden, true);
  assert.equal(w._lockedChildren.size, 0);
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
  assert.equal(w.stopBtn.hidden, false);
  w.stopBtn.events.click[0]({ preventDefault() {}, stopPropagation() {} });
  assert.equal(w._stopRequested, true);
  assert.equal(w.editingBlocked, true, "Stop cannot unlock while preparation is still running");
  assert.ok(statuses.some(item => /stop/i.test(item.message)));
  assets.resolve();
  await pending;
  assert.equal(runs, 0);
  assert.equal(w.editingBlocked, false);
});

for (const pendingImage of ["result", "mask"]) {
  test(`Stop during ${pendingImage} decoding cancels staging instead of publishing late results`, async () => {
    const image = deferred();
    let staged = 0, masks = 0;
    const { w } = widget({ _documentRevision: 4,
      resultImageURL: value => value, loadImage: () => image.promise,
      addStagingItem: () => { staged++; },
      makeAlphaMaskCanvasFromImage: () => { masks++; return {}; },
    });
    const pending = w._stageGeneratedImages({ images: ["result"], ...(pendingImage === "mask" ? { mask: "mask" } : {}) },
      null, "inpaint", { requestPanorama: null, requestDocumentRevision: 4, bbox: {}, inferenceSize: {}, outputSize: {} });
    w._stopRequested = true;
    image.resolve({});
    await assert.rejects(pending, error => error.cancelled === true);
    assert.equal(staged, 0);
    assert.equal(masks, 0, "cancelled decoding does not allocate a result mask");
  });
}

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
    assert.equal(w.stopBtn.hidden, true);
    assert.equal(w._lockedChildren.size, 0);
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
    const event = { button: 0, ctrlKey: true, preventDefault() {}, stopPropagation() {} };
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

test("generation locks edit controls while leaving settings, pan and scrolling available", async () => {
  const result = deferred();
  const { w } = widget({ runGeneration: () => result.promise });
  const editable = new Element("button"), previouslyInert = new Element("button"), settings = new Element("input");
  editable.editControl = previouslyInert.editControl = true;
  previouslyInert.inert = true;
  w.container.append(editable, previouslyInert, settings);
  const originalChildren = [...w.container.children];
  editable.isConnected = true;
  editable.focus();
  const pending = w.draw();
  w.syncInteractionLock();
  assert.deepEqual(w.container.children, originalChildren);
  assert.equal(editable.inert, true);
  assert.equal(previouslyInert.inert, true);
  assert.equal(w.left.inert, false);
  assert.equal(w.drawControl.inert, false);
  assert.equal(w.drawBtn.inert, true);
  assert.equal(w.batchInput.inert, false);
  assert.equal(settings.inert, false);
  assert.equal(w.stopBtn.inert, false);
  assert.equal(w.stopBtn.hidden, false);
  assert.equal(domDocument.activeElement, w.stopBtn);
  assert.equal(w.stopBtn.focusOptions.preventScroll, true);
  let stops = 0;
  w.stopDraw = async () => { stops++; };
  w.stopBtn.events.click[0]({ preventDefault() {}, stopPropagation() {} });
  assert.equal(stops, 1);
  result.resolve();
  await pending;
  assert.equal(editable.inert, false);
  assert.equal(previouslyInert.inert, true);
  assert.equal(w.drawBtn.inert, false);
  assert.equal(w.batchInput.inert, false);
  assert.equal(w.stopBtn.hidden, true);
  assert.equal(domDocument.activeElement, editable);
  assert.equal(editable.focusOptions.preventScroll, true);
  assert.deepEqual(w.container.children, originalChildren);
});

test("canvas operations block all controls without adding a banner or showing Stop", () => {
  const { w } = widget({ _canvasOperation: true });
  const originalChildren = [...w.container.children];
  w.syncInteractionLock();
  assert.deepEqual(w.container.children, originalChildren);
  assert.equal(w.left.inert, true);
  assert.equal(w.stopBtn.hidden, true);
  w._canvasOperation = false;
  w.syncInteractionLock();
  assert.equal(w.left.inert, false);
  assert.deepEqual(w.container.children, originalChildren);
});

test("the event gate blocks document edits and allows safe UI events during generation", () => {
  const { w } = widget({ _generationLocked: true });
  const icon = new Element();
  w.stopBtn.append(icon);
  const start = source.indexOf("    const blockEditing = event => {");
  const end = source.indexOf("    for (const type of [", start);
  const blockEditing = vm.runInNewContext(`(function() { ${source.slice(start, end)} return blockEditing; }).call(widget)`, { widget: w });
  const edit = new Element("button"); edit.editControl = true;
  for (const [target, blocked] of [[w.stopBtn, false], [icon, false], [w.drawBtn, true], [w.batchInput, false], [w.left, false], [edit, true]]) {
    let prevented = 0, stopped = 0;
    blockEditing({ target, preventDefault() { prevented++; }, stopImmediatePropagation() { stopped++; } });
    assert.equal(prevented, Number(blocked));
    assert.equal(stopped, Number(blocked));
  }
  let prevented = 0;
  blockEditing({ type: "wheel", target: edit, preventDefault() { prevented++; }, stopImmediatePropagation() {} });
  assert.equal(prevented, 0, "layer panels must still scroll");
  blockEditing({ type: "pointerdown", button: 1, target: edit, preventDefault() { prevented++; }, stopImmediatePropagation() {} });
  assert.equal(prevented, 0, "middle-button graph navigation remains available over panels");
  w._canvasOperation = true;
  let stopped = 0;
  blockEditing({ target: icon, preventDefault() {}, stopImmediatePropagation() { stopped++; } });
  assert.equal(stopped, 1);
});

test("the keyboard can reach the existing Stop in node mode after focus returned from outside the widget", () => {
  let stops = 0, prevented = 0, stopped = 0;
  const { w } = widget({ _generationLocked: true, stopDraw: () => { stops++; } });
  w.syncInteractionLock();
  const target = w.stopBtn;
  const start = modes.indexOf("function uniCanvasHistoryOwner(");
  const end = modes.indexOf("\nfunction handleUniCanvasHistoryKeyUp(", start);
  const onKey = vm.runInNewContext(modes.slice(start, end) + "\nhandleUniCanvasHistoryKeyDown", {
    document: { body: { classList: { contains: () => false } } },
    UNICANVAS_STANDALONE_BODY_CLASS: "standalone", standaloneHistoryWidget: null,
    uniCanvasModeWidgets: new Set([w]),
    isUniCanvasCanvasFocused: () => false, isUniCanvasTextTarget: () => false,
    isUniCanvasHistoryCombo: () => false, installUniCanvasChangeTrackerGate() {},
  });
  for (const key of ["Enter", " "]) {
    onKey({ key, target, preventDefault() { prevented++; }, stopImmediatePropagation() { stopped++; } });
  }
  assert.equal(stops, 2);
  assert.equal(prevented, 2);
  assert.equal(stopped, 2);
  w._canvasOperation = true;
  onKey({ key: "Enter", target, preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(stops, 2);
});

test("generation keeps focus in settings and never restores an old focus over a new draft", async () => {
  const result = deferred(), input = new Element("input"), otherInput = new Element("input");
  input.isConnected = true;
  const { w } = widget({ runGeneration: () => result.promise });
  w.container.append(input, otherInput);
  input.focus();
  const pending = w.draw();
  assert.equal(domDocument.activeElement, input);
  otherInput.focus();
  w.syncInteractionLock();
  assert.equal(domDocument.activeElement, otherInput);
  result.resolve(); await pending;
  assert.equal(domDocument.activeElement, otherInput);
});

test("generation preserves native prompt editing, numeric keys, menus and focus traversal", () => {
  const { w } = widget({ _generationLocked: true, _vnccsFullscreen: true });
  const start = modes.indexOf("function uniCanvasHistoryOwner(");
  const end = modes.indexOf("\nfunction handleUniCanvasHistoryKeyUp(", start);
  const onKey = vm.runInNewContext(modes.slice(start, end) + "\nhandleUniCanvasHistoryKeyDown", {
    document: { body: { classList: { contains: () => false } } },
    UNICANVAS_STANDALONE_BODY_CLASS: "standalone", standaloneHistoryWidget: null,
    uniCanvasModeWidgets: new Set([w]), installUniCanvasChangeTrackerGate() {},
    isUniCanvasCanvasFocused: () => false,
    isUniCanvasTextTarget: e => ["input", "textarea"].includes(e.target.tag),
    isUniCanvasHistoryCombo: e => (e.ctrlKey || e.metaKey) && ["z", "y"].includes(e.key.toLowerCase()),
  });
  const input = new Element("input"), prompt = new Element("textarea"), menu = new Element("button");
  w.container.append(input, prompt, menu);
  for (const [target, key, ctrlKey] of [[input, "ArrowUp"], [input, "Tab"], [prompt, "a"], [prompt, "Enter"], [prompt, "z", true], [menu, "ArrowDown"], [menu, "Enter"]]) {
    let prevented = 0;
    onKey({ type: "keydown", target, key, ctrlKey, preventDefault() { prevented++; }, stopImmediatePropagation() {} });
    assert.equal(prevented, 0, `${target.tag} ${key} keeps its native action`);
  }
});

test("generation keyboard shortcuts keep panel navigation, fullscreen exit and pan available", () => {
  const start = modes.indexOf("export function handleUniCanvasShortcut(");
  const end = modes.indexOf("\nfunction ", start);
  let panels = 0, exits = 0;
  const onKey = vm.runInNewContext(modes.slice(start, end).replace("export ", "") + "\nhandleUniCanvasShortcut", {
    isUniCanvasTextTarget: () => false, isUniCanvasModalOpen: () => false, isUniCanvasCanvasFocused: () => true,
    consumeUniCanvasShortcut: e => e.preventDefault(), toggleUniCanvasPanels: () => { panels++; }, exitUniCanvasFullscreen: () => { exits++; },
    TOOL_SHORTCUTS: { b: "brush" },
    BRUSH_SIZE_STEP: 1, setUniCanvasBrushSize: (widget, value) => { widget.brushSize = value; },
  });
  const tools = [], w = { editingBlocked: true, _vnccsFullscreen: true, brushSize: 48, setTool: tool => tools.push(tool) };
  for (const key of ["Tab", "Escape", " ", "b", "z", "[", "]"]) {
    let prevented = 0;
    assert.equal(onKey(w, { key, preventDefault() { prevented++; } }), true);
    assert.equal(prevented, 1);
    if (key === "[") assert.equal(w.brushSize, 47);
    if (key === "]") assert.equal(w.brushSize, 48);
  }
  assert.equal(panels, 1); assert.equal(exits, 1); assert.deepEqual(tools, ["pan", "brush"]);
});

test("generation allows future pixel-tool selection but prevents entering a pose edit", () => {
  const { w } = widget({ _generationLocked: true, tool: "move", layers: [{ id: "original" }],
    syncCursorStyle() {}, renderToolSettings() {}, renderSamPanel() {}, updateSamControls() {}, updateHud() {},
    updateContextCursor() {}, updateToolPreviewOverlay() {}, toolNeedsCanvasRender: () => false,
  });
  const before = JSON.stringify(w.layers);
  for (const tool of ["brush", "eraser", "mask", "rect", "lasso", "resize", "bbox", "pan", "move"]) {
    w.setTool(tool); assert.equal(w.tool, tool);
    assert.equal(JSON.stringify(w.layers), before);
  }
  w.setTool("pose"); assert.equal(w.tool, "move");
  w._canvasOperation = true; w.setTool("pan"); assert.equal(w.tool, "move");
});

test("generation allows browsing result previews while accepting a result as a layer stays locked", () => {
  const { w } = widget({ _generationLocked: true, stagingAcceptBtn: new Element("button") });
  const previewControls = new Element(), previous = new Element("button"), toggle = new Element("button");
  previewControls.append(previous, toggle, w.stagingAcceptBtn); w.container.append(previewControls);
  w.syncInteractionLock();
  assert.equal(previous.inert, false); assert.equal(toggle.inert, false); assert.equal(w.stagingAcceptBtn.inert, true);
  assert.equal(w.isInteractionBlocked({ target: previous }), false);
  assert.equal(w.isInteractionBlocked({ target: toggle }), false);
  assert.equal(w.isInteractionBlocked({ target: w.stagingAcceptBtn }), true);
});

test("fullscreen capture listeners let safe controls receive key events during generation", () => {
  const { w } = widget({ _generationLocked: true, canvas: new Element("canvas") });
  const helper = modes.slice(modes.indexOf("function uniCanvasGenerationControlOwnsKey("), modes.indexOf("\nfunction handleUniCanvasHistoryKeyDown("));
  const start = modes.indexOf("  const modalOwnsKey =");
  const end = modes.indexOf('  window.addEventListener("keydown", onKeyDown', start);
  const handlers = vm.runInNewContext(helper + modes.slice(start, end) + "\n[onKeyDown, onKeyUp, onKeyPress]", {
    widget: w, isUniCanvasTextTarget: e => e.target.tag === "input", isUniCanvasModalOpen: () => false,
    isUniCanvasCanvasFocused: (widget, e) => e.target === widget.canvas,
    isUniCanvasHistoryCombo: () => false, handleUniCanvasShortcut() {},
  });
  const menu = new Element("button"), input = new Element("input"); w.container.append(menu, input);
  for (const handler of handlers) {
    for (const target of [menu, input]) {
      let prevented = 0, stopped = 0;
      handler({ target, key: "Enter", preventDefault() { prevented++; }, stopImmediatePropagation() { stopped++; } });
      assert.equal(prevented, 0); assert.equal(stopped, 0);
    }
    let prevented = 0;
    handler({ target: w.canvas, key: "b", preventDefault() { prevented++; }, stopImmediatePropagation() {} });
    assert.equal(prevented, 1, "canvas keys must still stay inside UniCanvas");
  }
});

for (const flag of ["_generationPreparing", "_generationLocked", "drawInProgress"]) {
  for (const gesture of ["middle", "pan-tool", "alt-move", "zoom-drag"]) {
    test(`${flag} permits ${gesture} navigation without changing layers or bbox`, () => {
      const { w } = widget({ [flag]: true, tool: gesture === "pan-tool" ? "pan" : gesture === "alt-move" ? "move" : "brush",
        canvas: new Element("canvas"), layers: [{ id: "original" }], bbox: { x: 1, y: 2, width: 64, height: 64 },
        view: { x: 0, y: 0, scale: 1 }, canvasPointFromEvent: e => ({ x: e.clientX, y: e.clientY }),
        clearToolPreviewOverlay() {}, updateContextCursor() {}, updateToolPreviewOverlay() {}, requestRender() {}, syncSettingsToWidget() {},
        setStageScale(value) { this.view.scale = value; },
      });
      context.ZOOM_DRAG_PIXELS_PER_DOUBLING = 100;
      const before = JSON.stringify([w.layers, w.bbox]);
      const e = { type: "pointerdown", target: w.canvas, pointerId: 1, button: ["middle", "zoom-drag"].includes(gesture) ? 1 : 0,
        altKey: gesture === "alt-move", ctrlKey: gesture === "zoom-drag", clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} };
      assert.equal(w.isInteractionBlocked(e), false);
      w.onPointerDown(e);
      w.onPointerMove({ ...e, clientX: 25, clientY: -100 });
      if (gesture === "zoom-drag") assert.equal(w.view.scale, 2);
      else { assert.equal(w.view.x, 25); assert.equal(w.view.y, -100); }
      w.onPointerUp(e);
      assert.equal(w.isPointerDown, false);
      assert.equal(w.pointerMode, null);
      assert.equal(JSON.stringify([w.layers, w.bbox]), before);
    });
  }
}

test("wheel zoom remains available during generation while a document operation blocks it", () => {
  context.STAGE_SCALE_FACTOR = .99; context.STAGE_MIN_SCALE = .01; context.STAGE_MAX_SCALE = 10;
  context.window.performance = { now: () => 1000 }; context.window.clearTimeout = () => {};
  const { w } = widget({ _generationLocked: true, view: { scale: 1 }, intendedScale: 1, lastScrollEventTimestamp: null, snapTimeout: null,
    canvasPointFromEvent: () => ({ x: 0, y: 0 }), updateScaleWithSnapping() { this.view.scale = this.intendedScale; }, requestRender() {},
  });
  const e = { deltaY: -20, preventDefault() {}, stopPropagation() {} };
  w.onWheel(e);
  assert.ok(w.view.scale > 1);
  const scale = w.view.scale;
  w._canvasOperation = true; w.onWheel(e);
  assert.equal(w.view.scale, scale);
});

for (const queued of [false, true]) {
  test(`${queued ? "queued" : "HTTP"} draw uses captured parameters while preparation and generation allow next-run edits`, async () => {
    const assets = deferred(), result = deferred();
    let sent, staged;
    const { w } = widget({ _assetsReady: assets.promise, settings: { positive: "original", seed_mode: "fixed", seed: 7, steps: 6, batch_size: 1,
        inference_scale: 1, generation_mode: "flux_klein", lora_stack: [{ name: "original", strength: 1 }], edit_reference_images: ["original-ref"] },
      bbox: { x: 0, y: 0, width: 1024, height: 1024 }, stagingItems: [],
      captureGenerationSettings: prototype.captureGenerationSettings, runGeneration: prototype.runGeneration,
      _isConfigLinked: () => queued, syncConfigFamily() {}, normalizeGenerationSettings: () => ({ loader: {} }),
      makeSettingsPayload() { return JSON.parse(JSON.stringify(this.settings)); },
      getModelBase: () => "flux_klein", getInferenceSize() { return { width: 1024 * this.settings.inference_scale, height: 1024 }; },
      flushSettingsToWidget() {}, getRasterContentInBboxStats: () => ({ nonzeroAlphaPixels: 0 }),
      getMaskContentInBboxStats: () => ({ nonzeroAlphaPixels: 0 }), makeExportCanvas: () => ({ toDataURL: () => "pixels" }),
      updateGenerationProgress() {}, startDrawProgressPolling() {}, stopDrawProgressPolling() {}, render() {},
      _stageGeneratedImages(data, mask, mode, drawContext) { staged = drawContext; },
      editReferenceImages() { return this.settings.edit_reference_images; },
      _pollForResult: async () => ({ images: ["result"] }),
    });
    context.fetch = (url, options) => { sent = JSON.parse(options.body); return result.promise; };
    context.app = { queuePrompt: () => result.promise };
    const pending = w.draw();
    w.settings.positive = "next"; w.settings.seed = 99; w.settings.steps = 12; w.settings.batch_size = 3;
    w.settings.inference_scale = 2; w.settings.generation_mode = "sdxl";
    w.settings.lora_stack[0].strength = .25; w.settings.edit_reference_images[0] = "next-ref";
    assets.resolve(); await settle();
    assert.equal(w.drawInProgress, true);
    if (queued) {
      sent = JSON.parse(w.serializeStateForPrompt(JSON.stringify({ settings: w.settings }))).settings;
      assert.ok(sent.queued_draw);
      result.resolve({ prompt_id: "prompt" });
    } else {
      assert.equal(sent.inference_size.width, 1024);
      sent = sent.settings;
      result.resolve({ ok: true, json: async () => ({ images: ["result"] }) });
    }
    assert.equal(sent.positive, "original"); assert.equal(sent.seed, 7); assert.equal(sent.steps, 6); assert.equal(sent.batch_size, 1);
    assert.equal(sent.generation_mode, "flux_klein"); assert.equal(sent.lora_stack[0].strength, 1);
    assert.equal(sent.edit_reference_images[0], "original-ref");
    await pending;
    assert.equal(staged.inferenceSize.width, 1024);
    assert.equal(w.settings.positive, "next"); assert.equal(w.settings.seed, 99); assert.equal(w.settings.batch_size, 3);
    assert.equal(w.settings.lora_stack[0].strength, .25); assert.equal(w.settings.edit_reference_images[0], "next-ref");
    assert.equal(w.batchInput.disabled, undefined);
    assert.equal(w.editingBlocked, false);
    assert.equal(w._queuedDrawSettings ?? null, null);
  });
}
