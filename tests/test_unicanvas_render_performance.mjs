import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { homographyFromUnitSquare, rectToQuad, transformDraftBounds } from "../web/unicanvas/transform.mjs";

// An alpha-only canvas: getImageData returns the requested region and records every readback.
class AlphaCanvas {
  static encodes = 0;
  constructor(width, height) { this.width = width; this.height = height; this.alpha = new Uint8Array(width * height); this.reads = []; }
  paint(x, y, width, height, value = 255) {
    for (let row = y; row < y + height; row += 1) for (let col = x; col < x + width; col += 1) this.alpha[row * this.width + col] = value;
  }
  toDataURL() { this.encodes = (this.encodes || 0) + 1; return `data:image/png;${this.width}x${this.height};${++AlphaCanvas.encodes}`; }
  getContext() {
    const canvas = this;
    return {
      getImageData(x, y, width, height) {
        canvas.reads.push({ x, y, width, height });
        const data = new Uint8ClampedArray(width * height * 4);
        for (let row = 0; row < height; row += 1) {
          for (let col = 0; col < width; col += 1) data[(row * width + col) * 4 + 3] = canvas.alpha[(y + row) * canvas.width + x + col];
        }
        return { data };
      },
      drawImage(source, dx, dy) { canvas.drawn = { source, dx, dy }; },
    };
  }
}

class Element {
  constructor() { this.style = {}; this.classList = { add() {}, remove() {}, toggle() {} }; this.htmlWrites = 0; this._html = ""; }
  get innerHTML() { return this._html; }
  set innerHTML(value) { this.htmlWrites += 1; this._html = value; }
}

const source = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const context = {
  document: { createElement: () => new AlphaCanvas(0, 0) },
  window: { performance: { now: () => 1000 }, setTimeout: () => 1, clearTimeout() {}, devicePixelRatio: 1 },
  console,
  getComputedStyle: (canvas) => canvas.theme,
  STAGE_SCALE_FACTOR: 0.999, STAGE_MIN_SCALE: 0.1, STAGE_MAX_SCALE: 20, STAGE_SNAP_POINTS: [], STAGE_SNAP_TOLERANCE: 0.02,
  STAGING_ICONS: { show: "<svg>show</svg>", hide: "<svg>hide</svg>" },
  MASK_OVERLAY_COLOR: "rgba(255,0,0,0.5)",
  serializePose: () => null,
  homographyFromUnitSquare, transformDraftBounds,
};
const prototype = vm.runInNewContext(source.slice(source.indexOf("class UniCanvasWidget {"), source.indexOf("\napp.registerExtension(")) + "\nUniCanvasWidget.prototype", context);
const widget = (values = {}) => Object.assign(Object.create(prototype), {
  layers: [], panorama: null, origin: { x: 0, y: 0 }, size: { width: 100, height: 100 }, setStatus() {}, ...values,
});

// Objects made inside the vm context have another Object prototype.
const plain = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function bruteBounds(canvas) {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
    if (!canvas.alpha[y * canvas.width + x]) continue;
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

test("alpha bounds match an exhaustive scan, whole canvas or inside a region", () => {
  const w = widget();
  let seed = 7;
  const random = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let round = 0; round < 60; round += 1) {
    const canvas = new AlphaCanvas(1 + random(40), 1 + random(40));
    for (let i = random(4); i > 0; i -= 1) canvas.paint(random(canvas.width), random(canvas.height), 1, 1, 1 + random(255));
    assert.deepEqual(plain(w.getCanvasAlphaBounds(canvas)), bruteBounds(canvas));
    const expected = bruteBounds(canvas);
    if (expected) assert.deepEqual(plain(w.getCanvasAlphaBounds(canvas, { x: expected.x - 1, y: expected.y, width: expected.width + 2, height: expected.height })), expected);
  }
  const canvas = new AlphaCanvas(10, 10);
  assert.equal(w.getCanvasAlphaBounds(canvas), null);
  assert.equal(w.getCanvasAlphaBounds(canvas, { x: 20, y: 20, width: 5, height: 5 }), null, "a region off the canvas is empty");
});

test("an eraser stroke re-measures only the old bounds plus the stroke, not the whole layer", () => {
  const w = widget();
  const canvas = new AlphaCanvas(400, 400);
  canvas.paint(100, 100, 50, 50);
  const layer = { canvas, _boundsCache: { x: 100, y: 100, width: 50, height: 50 } };
  canvas.paint(100, 100, 50, 10, 0);
  w.markLayerPixelsChanged(layer, { x: 95, y: 95, width: 60, height: 20 }, false);
  assert.equal(layer._boundsCache, undefined, "the bounds are measured again");
  assert.deepEqual(plain(w.getLayerAlphaBounds(layer)), { x: 100, y: 110, width: 50, height: 40 });
  assert.deepEqual(canvas.reads, [{ x: 95, y: 95, width: 60, height: 55 }], "one readback of old bounds + stroke");
});

test("strokes after an eraser stroke grow the pending search region", () => {
  const w = widget();
  const canvas = new AlphaCanvas(400, 400);
  canvas.paint(10, 10, 5, 5);
  const layer = { canvas, _boundsCache: { x: 10, y: 10, width: 5, height: 5 } };
  canvas.paint(10, 10, 5, 2, 0);
  w.markLayerPixelsChanged(layer, { x: 10, y: 10, width: 5, height: 2 }, false);
  canvas.paint(300, 200, 4, 4);
  w.markLayerPixelsChanged(layer, { x: 300, y: 200, width: 4, height: 4 }, true);
  assert.deepEqual(plain(w.getLayerAlphaBounds(layer)), { x: 10, y: 12, width: 294, height: 192 }, "the brush pixels are not missed");
  assert.deepEqual(canvas.reads, [{ x: 10, y: 10, width: 294, height: 194 }]);
});

test("unknown or wholesale changes still scan the whole layer; an untouched empty layer stays empty", () => {
  const w = widget();
  const canvas = new AlphaCanvas(50, 40);
  canvas.paint(5, 6, 2, 2);
  const layer = { canvas, _boundsCache: { x: 5, y: 6, width: 2, height: 2 } };
  w.markLayerPixelsChanged(layer);
  assert.deepEqual(plain(w.getLayerAlphaBounds(layer)), { x: 5, y: 6, width: 2, height: 2 });
  assert.deepEqual(canvas.reads, [{ x: 0, y: 0, width: 50, height: 40 }]);
  const empty = { canvas: new AlphaCanvas(50, 40), _boundsCache: null };
  w.markLayerPixelsChanged(empty, { x: 100, y: 100, width: 5, height: 5 }, false);
  assert.equal(empty._boundsCache, null);
  const stale = { canvas, _boundsCache: undefined, _boundsHint: { canvas: new AlphaCanvas(1, 1), rect: { x: 0, y: 0, width: 1, height: 1 } } };
  canvas.reads = [];
  assert.deepEqual(plain(w.getLayerAlphaBounds(stale)), { x: 5, y: 6, width: 2, height: 2 }, "a region for another canvas is ignored");
  assert.deepEqual(canvas.reads, [{ x: 0, y: 0, width: 50, height: 40 }]);
});

test("growing the canvas keeps every layer's bounds, shifted, without rescanning", () => {
  const w = widget({ origin: { x: 0, y: 0 }, size: { width: 100, height: 100 } });
  const known = { canvas: new AlphaCanvas(100, 100), _boundsCache: { x: 10, y: 20, width: 5, height: 6 } };
  const empty = { canvas: new AlphaCanvas(100, 100), _boundsCache: null };
  const pending = { canvas: new AlphaCanvas(100, 100), _boundsCache: undefined };
  pending._boundsHint = { canvas: pending.canvas, rect: { x: 1, y: 2, width: 3, height: 4 } };
  const unknown = { canvas: new AlphaCanvas(100, 100), _boundsCache: undefined };
  w.layers = [known, empty, pending, unknown];
  assert.equal(w.ensureWorldBounds(-50, 20, 10), true);
  assert.deepEqual(plain(w.origin), { x: -60, y: 0 });
  assert.deepEqual(plain(known._boundsCache), { x: 70, y: 20, width: 5, height: 6 });
  assert.equal(empty._boundsCache, null);
  assert.equal(pending._boundsCache, undefined);
  assert.equal(pending._boundsHint.canvas, pending.canvas, "the search region follows the new canvas");
  assert.deepEqual(plain(pending._boundsHint.rect), { x: 61, y: 2, width: 3, height: 4 });
  assert.equal(unknown._boundsCache, undefined);
  assert.equal(unknown._boundsHint, undefined);
  assert.equal(known.canvas.drawn.dx, 60, "the pixels moved by the same offset");
});

test("wheel zoom draws once per frame instead of on every wheel event", () => {
  let renders = 0, requests = 0;
  const w = widget({
    view: { x: 0, y: 0, scale: 1 }, intendedScale: 1, lastScrollEventTimestamp: null, snapTimeout: null, activeSnapPoint: null,
    canvasPointFromEvent: () => ({ x: 10, y: 10 }), applyStageScale(scale) { this.view.scale = scale; },
    render: () => { renders += 1; }, requestRender: () => { requests += 1; },
  });
  for (let i = 0; i < 4; i += 1) w.onWheel({ deltaY: -40, preventDefault() {}, stopPropagation() {} });
  assert.equal(renders, 0);
  assert.equal(requests, 4, "requestRender coalesces them into one frame");
  assert.ok(w.view.scale > 1, "the zoom itself still follows every event");
});

for (const deltaY of [-5, 5]) test(`small wheel inputs accumulate through zoom snaps (${deltaY})`, () => {
  let now = 1000;
  const frames = [];
  context.STAGE_SNAP_POINTS = [0.5, 1, 2];
  context.window.performance.now = () => now;
  context.window.requestAnimationFrame = callback => frames.push(callback);
  const rendered = [];
  const w = widget({
    view: { x: 0, y: 0, scale: 1 }, intendedScale: 1, activeSnapPoint: 1,
    lastScrollEventTimestamp: null, snapTimeout: null,
    getStageViewportSize: () => ({ width: 100, height: 100 }),
    canvasPointFromEvent: () => ({ x: 50, y: 50 }), render() { rendered.push(this.view.scale); },
  });
  try {
    for (let i = 0; i < 60; i++) {
      now += 16;
      w.onWheel({ deltaY, preventDefault() {}, stopPropagation() {} });
      assert.equal(frames.length, 1);
      frames.shift()();
      assert.equal(rendered.at(-1), w.view.scale, "each frame uses the newest wheel value");
    }
    assert.ok(deltaY > 0 ? w.view.scale < .8 : w.view.scale > 1.2,
      "small trackpad deltas must escape the snap while scrolling");
    assert.ok(Math.abs((50 - w.view.x) / w.view.scale - 50) < 1e-9, "zoom stays under the pointer");
  } finally {
    context.STAGE_SNAP_POINTS = [];
    context.window.performance.now = () => 1000;
  }
});

test("the background grid is stroked as one path", () => {
  const calls = [];
  const ctx = new Proxy({}, { get: (target, key) => key in target ? target[key] : (...args) => calls.push(key), set: (target, key, value) => { target[key] = value; return true; } });
  widget({ view: { x: 3, y: 5, scale: 0.125 } }).drawBackground(ctx, 1600, 900);
  assert.equal(calls.filter((name) => name === "stroke").length, 1);
  assert.equal(calls.filter((name) => name === "beginPath").length, 1);
  assert.ok(calls.filter((name) => name === "moveTo").length > 300, "every grid line is still drawn");
});

test("standalone background follows the current theme; node background stays unchanged", () => {
  const ctx = { fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} };
  const canvas = { theme: { backgroundColor: "rgb(240, 240, 240)", color: "rgba(0, 0, 0, 0.08)" } };
  const w = widget({ standalone: true, canvas, view: { x: 0, y: 0, scale: 1 } });
  w.drawBackground(ctx, 100, 100);
  assert.equal(ctx.fillStyle, canvas.theme.backgroundColor);
  assert.equal(ctx.strokeStyle, canvas.theme.color);
  canvas.theme = { backgroundColor: "rgb(24, 24, 24)", color: "rgba(255, 255, 255, 0.08)" };
  w.drawBackground(ctx, 100, 100);
  assert.equal(ctx.fillStyle, canvas.theme.backgroundColor);
  assert.equal(ctx.strokeStyle, canvas.theme.color);
  w.standalone = false;
  w.drawBackground(ctx, 100, 100);
  assert.equal(ctx.fillStyle, "#07070c");
  assert.equal(ctx.strokeStyle, "rgba(255,255,255,.045)");
});

test("per-render panel updates rebuild their HTML only when it changes", () => {
  const toggle = new Element();
  const w = widget({
    stagingControls: new Element(), stagingToggleBtn: toggle, stagingItems: [{ img: {}, visible: true }, { img: {} }], activeStagingIndex: 0,
  });
  for (let i = 0; i < 5; i += 1) w.updateStagingControls();
  assert.equal(toggle.htmlWrites, 1);
  w.stagingItems[0].visible = false; w.updateStagingControls();
  assert.equal(toggle.htmlWrites, 2); assert.equal(toggle.innerHTML, "<svg>hide</svg>");

  const label = new Element();
  const button = () => ({ disabled: false, classList: { toggle() {} } });
  const sam = widget({
    samPanel: new Element(), samPointsLabel: label, samModelSelect: {}, samStatus: {},
    samUndoBtn: button(), samRedoBtn: button(), samInvertBtn: button(), samSegmentBtn: button(), samApplyBtn: button(), samClearBtn: button(),
    sam: { points: [{ label: 1 }], redoPoints: [], model: "sam", busy: false, invert: false, maskCanvas: null, status: "" },
  });
  for (let i = 0; i < 5; i += 1) sam.renderSamPanel();
  assert.equal(label.htmlWrites, 1);
  sam.sam.points.push({ label: 0 }); sam.renderSamPanel();
  assert.equal(label.htmlWrites, 2);
});

test("middle-button pan and zoom update the view without saving document pixels on release", () => {
  for (const zoom of [false, true]) {
    let saves = 0, frames = 0;
    const w = widget({ tool: "mask", bbox: {}, view: { x: 10, y: 20, scale: 1 }, canvas: {},
      canvasPointFromEvent: e => ({ x: e.clientX, y: e.clientY }),
      clearToolPreviewOverlay() {}, updateToolPreviewOverlay() {}, updateContextCursor() {},
      syncSettingsToWidget: () => saves++, requestRender: () => frames++,
      setStageScale(scale) { this.view.scale = scale; },
    });
    context.ZOOM_DRAG_PIXELS_PER_DOUBLING = 200;
    const event = { button: 1, pointerId: 1, clientX: 50, clientY: 60, ctrlKey: zoom,
      preventDefault() {}, stopPropagation() {} };
    w.onPointerDown(event);
    w.onPointerMove({ ...event, clientX: 80, clientY: 90 });
    assert.ok(frames > 0, "the held gesture updates before pointerup");
    if (zoom) assert.ok(w.view.scale < 1);
    else assert.deepEqual(plain(w.view), { x: 40, y: 50, scale: 1 });
    w.onPointerUp(event);
    assert.equal(saves, 0, "navigation must not schedule an upload of every layer");
  }
  let saves = 0;
  const w = widget({ isPointerDown: true, pointerMode: "bbox-move", dragStart: {},
    requestRender() {}, updateContextCursor() {}, updateToolPreviewOverlay() {},
    syncSettingsToWidget: () => saves++,
  });
  w.onPointerUp();
  assert.equal(saves, 1, "document changes still persist");
});

for (const type of ["mask", "raster", "hires"]) for (const startsOutside of [false, true]) for (const zoom of [1, 20]) {
  test(`${type} movement at ${zoom}x renders each held frame${startsOutside ? " when entering the viewport" : ""} and commits once without a jump`, () => {
    const frames = [], draws = [], history = [], stack = [];
    let tx = 0, ty = 0, pixelWrites = 0;
    context.window.requestAnimationFrame = callback => frames.push(callback);
    const ctx = {
      setTransform() { tx = 0; ty = 0; }, clearRect() { draws.length = 0; },
      save() { stack.push([tx, ty]); }, restore() { [tx, ty] = stack.pop(); },
      translate(x, y) { tx += x; ty += y; }, scale() {},
      drawImage(image, sx, sy, sw, sh, x, y, width, height) {
        draws.push({ x: tx + x, y: ty + y, width, height });
      },
    };
    const bounds = { x: 20, y: 30, width: 20, height: 20 };
    const layer = { id: "moving", type: type === "hires" ? "raster" : type, visible: true, opacity: 1,
      canvas: new AlphaCanvas(200, 200), _boundsCache: { ...bounds } };
    if (type === "hires") {
      layer.hiresCanvas = new AlphaCanvas(40, 40);
      layer.hiresRect = { x: 10.2, y: 25.2, width: 20, height: 20 };
    }
    layer.canvas.getContext = () => ({ clearRect() {}, drawImage() { pixelWrites++; } });
    const tintCtx = { clearRect() {}, drawImage() {}, fillRect() {} };
    const tint = { width: 20, height: 20, getContext: () => tintCtx };
    const w = widget({ layers: [layer], activeLayerId: layer.id, tool: "move",
      origin: { x: -10, y: -5 }, view: { x: 0, y: 0, scale: zoom },
      bbox: { width: 100, height: 100 }, canvas: { width: 200, height: 100, getContext: () => ctx }, hud: {},
      visibleWorldRect: () => ({ x: startsOutside ? 80 : 0, y: 0, width: 200, height: 100 }),
      isPointerDown: true, pointerMode: "layer-move", lastPoint: { x: 0, y: 0 }, lassoPoints: [],
      dragStart: { pointerId: 1, point: { x: 0, y: 0 }, layerId: layer.id, layerBefore: { crop: { ...bounds } },
        layerBounds: bounds, layerCanvas: new AlphaCanvas(20, 20), layerOrigin: { x: -10, y: -5 },
        hiresRect: layer.hiresRect ? { ...layer.hiresRect } : null },
      canvasPointFromEvent: e => ({ x: e.clientX, y: e.clientY }),
      configureImageContext: value => value, ensureWorldBounds: () => true,
      hasOpenStagingPanel: () => false, getMaskTintScratch: () => tint,
      getInferenceSize: () => ({ width: 100, height: 100 }),
      createLayerPixelSnapshot: value => ({ crop: { ...value._boundsCache } }),
      pushHistoryEntry: entry => history.push(entry),
    });
    for (const name of ["drawBackground", "drawStagingOverlay", "drawShapeDraft", "drawLassoDraft",
      "drawResizeOverlay", "drawBbox", "updateInferenceSizeLabels", "updateZoomResetButton", "updateStagingControls",
      "updateTransformControls", "updateSamControls", "updateToolPreviewOverlay", "updateContextCursor",
      "refreshLayerRow", "syncLightStateToWidget", "scheduleFullSync"]) w[name] = () => {};
    const frame = () => { assert.equal(frames.length, 1); frames.shift()(); };
    const move = (x, y) => w.onPointerMove({ clientX: x, clientY: y, pointerId: 1,
      preventDefault() {}, stopPropagation() {} });
    w.render();
    assert.equal(draws.length, startsOutside ? 0 : 1);
    const positions = zoom === 1 ? [[80, 25], [95, 40]] : [[80.25, 25.2], [95.75, 40.7], [84.25, -.75]];
    for (const [dx, dy] of positions) {
      move((dx - 1) * zoom, (dy - 1) * zoom); move(dx * zoom, dy * zoom); frame();
      assert.deepEqual(draws, [{ x: 10 + Math.round(dx), y: 25 + Math.round(dy), width: 20, height: 20 }],
        "the newest held position must reach the rendered mask or image");
      assert.deepEqual(layer._boundsCache, bounds, "preview preserves authored pixels");
      assert.equal(pixelWrites, 0); assert.equal(history.length, 0);
      assert.equal(w._visibleWorldRectForRender, null, "preview clipping must not leak to other layers");
    }
    const held = { ...draws[0] };
    w.onPointerUp(); frame();
    assert.deepEqual(draws, [held], "release must keep the last preview position");
    assert.equal(pixelWrites, 1); assert.equal(history.length, 1);
    assert.equal(history[0].kind, "layerPixels");
    const [dx, dy] = positions.at(-1);
    assert.deepEqual(plain(history[0].after.crop), { x: 20 + Math.round(dx), y: 30 + Math.round(dy), width: 20, height: 20 });
    assert.equal(w.pointerMode, null);
  });
}

test("the initiating pointer owns the gesture until its release or cancellation", () => {
  const captures = [], history = [], frames = [];
  const layer = { id: "A", type: "mask", opacity: 1, canvas: new AlphaCanvas(200, 200),
    _boundsCache: { x: 20, y: 30, width: 20, height: 20 } };
  layer.canvas.getContext = () => ({ clearRect() {}, drawImage() {} });
  const w = widget({ layers: [layer], activeLayerId: layer.id, tool: "move",
    canvas: { setPointerCapture: id => captures.push(id) }, view: { x: 0, y: 0, scale: 1 },
    bbox: { x: 0, y: 0, width: 100, height: 100 }, lassoPoints: [],
    canvasPointFromEvent: e => ({ x: e.clientX, y: e.clientY }),
    createLayerPixelSnapshot: value => ({ crop: { ...value._boundsCache } }),
    cloneCanvasCrop: () => new AlphaCanvas(20, 20), configureImageContext: value => value,
    ensureWorldBounds: () => true, pushHistoryEntry: entry => history.push(entry), requestRender: () => frames.push(1),
    clearToolPreviewOverlay() {}, updateToolPreviewOverlay() {}, updateContextCursor() {},
    refreshLayerRow() {}, syncLightStateToWidget() {}, scheduleFullSync() {},
  });
  const event = (pointerId, clientX, type = "pointermove") => ({ pointerId, clientX, clientY: 0, button: 0, type,
    preventDefault() {}, stopPropagation() {} });
  w.onPointerDown(event(1, 100, "pointerdown"));
  w.onPointerMove(event(1, 110));
  const start = w.dragStart;
  for (const mode of ["layer-move", "brush", "bbox-move", "layer-transform", "pan", "panorama"]) {
    w.pointerMode = mode;
    w.onPointerDown(event(2, 300, "pointerdown"));
    w.onPointerMove(event(2, 300));
    w.onPointerUp(event(2, 300, "pointerup"));
    w.onPointerUp(event(2, 300, "pointercancel"));
    assert.equal(w.dragStart, start, `${mode}: a second pointer must not replace the gesture`);
    assert.equal(w.pointerMode, mode);
    assert.equal(w.isPointerDown, true);
    assert.equal(start.previewDx, 10);
  }
  assert.deepEqual(captures, [1]);
  assert.equal(frames.length, 1, "foreign events never schedule a document frame");
  assert.equal(history.length, 0);
  w.pointerMode = "layer-move";
  w.onPointerMove(event(1, 125));
  assert.equal(start.previewDx, 25, "the original pointer continues to update while held");
  w.onPointerUp(event(1, 125, "pointercancel"));
  assert.equal(history.length, 1);
  assert.equal(w.isPointerDown, false);
  w.onPointerUp(event(1, 125));
  assert.equal(history.length, 1, "cancellation and a later pointerup cannot commit twice");
  w.onPointerDown(event(2, 300, "pointerdown"));
  w.onPointerMove(event(2, 310));
  assert.equal(w.dragStart.previewDx, 10, "the next gesture starts from its own pointer");
  w.onPointerUp(event(2, 310));
  assert.equal(history.length, 2);
});

test("panorama rotation also retains its initiating pointer", () => {
  const views = [];
  let ended = 0;
  const w = widget({ tool: "panorama", view: { x: 0, y: 0, scale: 1 }, bbox: { width: 100 },
    panorama: { settings: { yaw: 0, pitch: 0, fov: 100 }, flushCamera() {}, beginCamera: () => true,
      setCamera: value => views.push(value), endCamera() { ended++; } },
    canvas: { setPointerCapture() {} }, canvasPointFromEvent: e => ({ x: e.clientX, y: e.clientY }),
  });
  const event = (pointerId, x) => ({ pointerId, clientX: x, clientY: 0, button: 0, altKey: true,
    preventDefault() {}, stopPropagation() {} });
  w.onPointerDown(event(1, 0));
  w.onPointerMove(event(1, 10));
  w.onPointerDown(event(2, 100)); w.onPointerMove(event(2, 200)); w.onPointerUp(event(2, 200));
  assert.equal(ended, 0);
  w.onPointerMove(event(1, 20));
  assert.deepEqual(views.map(value => value.yaw), [-10, -20], "held camera frames follow only the original pointer");
  w.onPointerUp(event(1, 20));
  assert.equal(ended, 1);
  assert.equal(w.dragStart, null);
});

test("hi-res layer move metadata keeps its original offset and matches the rendered preview", () => {
  const layer = { id: "hires", type: "raster", hiresCanvas: {}, hiresRect: { x: 20.2, y: 30.4, width: 20, height: 20 },
    canvas: new AlphaCanvas(200, 200) };
  layer.canvas.getContext = () => ({ clearRect() {}, drawImage() {} });
  const w = widget({ layers: [layer], activeLayerId: layer.id, view: { scale: 20 },
    pointerMode: "layer-move", dragStart: { point: { x: 0, y: 0 }, layerId: layer.id,
      layerCanvas: new AlphaCanvas(20, 20), layerBounds: { x: 20, y: 30, width: 20, height: 20 },
      hiresRect: { ...layer.hiresRect }, layerOrigin: { x: 0, y: 0 } },
    configureImageContext: ctx => ctx, ensureWorldBounds: () => true,
  });
  w.updateLayerMovePreview({ x: .75, y: -.75 });
  const held = w.getLayerMovePreview(layer);
  const original = w.normalizeLayerWorldRect(layer.hiresRect);
  w.moveActiveLayerPixels(held.dx, held.dy);
  assert.equal(layer.hiresRect.x, 21.2); assert.equal(layer.hiresRect.y, 29.4);
  const committed = w.normalizeLayerWorldRect(layer.hiresRect);
  assert.equal(original.x + held.dx, committed.x);
  assert.equal(original.y + held.dy, committed.y);
});

test("mask transform keeps opacity in held frames and after Apply", () => {
  const draws = [], frames = [], history = [];
  const fakeContext = () => {
    const stack = [];
    return { globalAlpha: 1, save() { stack.push(this.globalAlpha); }, restore() { this.globalAlpha = stack.pop(); },
      setTransform() {}, translate() {}, scale() {}, transform() {}, clearRect() {}, fillRect() {},
      drawImage() { draws.push(this.globalAlpha); } };
  };
  const ctx = fakeContext(), scratch = { width: 20, height: 20, getContext: () => fakeContext() };
  const layer = { id: "mask", type: "mask", visible: true, opacity: .25, canvas: new AlphaCanvas(200, 200),
    _boundsCache: { x: 20, y: 30, width: 20, height: 20 } };
  layer.canvas.getContext = fakeContext;
  const w = widget({ layers: [layer], activeLayerId: layer.id, view: { x: 0, y: 0, scale: 1 },
    canvas: { width: 200, height: 200, getContext: () => ctx }, hud: {}, _maskDraftScratch: scratch,
    bbox: { width: 100, height: 100 }, visibleWorldRect: () => ({ x: 0, y: 0, width: 200, height: 200 }),
    hasOpenStagingPanel: () => false, getMaskTintScratch: () => scratch,
    getInferenceSize: () => ({ width: 100, height: 100 }), configureImageContext: ctx => ctx,
    ensureWorldBounds: () => true, createLayerPixelSnapshot: () => ({}), pushHistoryEntry: entry => history.push(entry),
  });
  for (const name of ["drawBackground", "drawStagingOverlay", "drawShapeDraft", "drawLassoDraft", "drawResizeOverlay",
    "drawBbox", "updateInferenceSizeLabels", "updateZoomResetButton", "updateStagingControls", "updateTransformControls",
    "updateSamControls", "updateToolPreviewOverlay", "refreshLayerRow", "renderToolSettings", "syncLightStateToWidget", "scheduleFullSync"]) w[name] = () => {};
  context.window.requestAnimationFrame = callback => frames.push(callback);
  w.render(); assert.equal(draws.at(-1), .25);
  const draft = w.transformDraft = { layerId: layer.id, sourceCanvas: new AlphaCanvas(20, 20), before: {},
    quad: rectToQuad({ x: 20, y: 30, width: 20, height: 20 }), bounds: { x: 20, y: 30, width: 20, height: 20 } };
  for (const x of [40, 60]) {
    draft.quad = rectToQuad({ x, y: 30, width: 20, height: 20 });
    draft.bounds.x = x;
    w.requestRender(); frames.shift()();
    assert.equal(draws.at(-1), .25, "a transformed mask retains its opacity before release");
    assert.equal(history.length, 0);
  }
  w.applyTransformDraft(); frames.shift()();
  assert.equal(draws.at(-1), .25, "Apply cannot change the preview opacity");
  assert.equal(history.length, 1);
});

test("resize ignores unchanged backing sizes and coalesces actual size changes", () => {
  let renders = 0, frames = 0;
  const canvas = () => ({ width: 100, height: 60, style: {} });
  const w = widget({ canvas: canvas(), previewCanvas: canvas(), didInitialCenter: true,
    updateMainUIScale() {}, getStageViewportSize: () => ({ width: 100, height: 60 }),
    render: () => renders++, requestRender: () => frames++,
  });
  for (let i = 0; i < 10; i++) w.resize();
  assert.equal(renders, 0);
  assert.equal(frames, 0, "unrelated DOM mutations do not redraw the whole document");
  w.getStageViewportSize = () => ({ width: 120, height: 80 });
  w.resize();
  assert.equal(frames, 1);
  assert.equal(renders, 0, "resize must leave painting to the next animation frame");
  assert.equal(w.previewCanvas.width, 120);
  assert.equal(w.canvas.height, 80);
  w.resize();
  assert.equal(frames, 1);
  w.didInitialCenter = false;
  w.fitInitialView = () => { w.didInitialCenter = true; };
  w.resize();
  assert.equal(frames, 2, "initial centering still needs a frame");
});

test("unchanged pixels are encoded once while settings, metadata and snapshots stay current", () => {
  const w = widget();
  const layer = { id: "a", name: "A", canvas: new AlphaCanvas(20, 20), opacity: 1, visible: true };
  layer.canvas.paint(2, 3, 8, 7);
  const first = w.serializeLayer(layer, true);
  const encodes = AlphaCanvas.encodes;
  assert.ok(first.dataURL);
  for (let i = 0; i < 5; i++) {
    layer.name = `A ${i}`;
    layer.visible = !layer.visible;
    const next = w.serializeLayer(layer, true);
    assert.equal(next.name, layer.name);
    assert.equal(next.visible, layer.visible);
    assert.equal(next.dataURL, first.dataURL);
  }
  assert.equal(AlphaCanvas.encodes, encodes, "metadata changes never re-encode layer pixels");
  assert.equal(layer._serializedPixels.canvas.encodes, undefined, "the source canvas is never encoded directly");
  const cache = layer._serializedPixels;
  w.serializeLayer(layer, false);
  assert.equal(layer._serializedPixels, cache);
  w.markLayerPixelsChanged(layer, { x: 2, y: 3, width: 1, height: 1 });
  const edited = w.serializeLayer(layer, true);
  assert.notEqual(edited.dataURL, first.dataURL, "changed pixels are encoded again");
  assert.notEqual(layer._serializedPixels, cache, "pixel edits discard the old PNG");
  assert.equal(first.dataURL, cache.dataURL, "a previous snapshot remains immutable");
  assert.ok(edited.dataURL);
  const editedCache = layer._serializedPixels;
  layer.canvas = new AlphaCanvas(30, 20);
  layer.canvas.paint(2, 3, 8, 7);
  w.serializeLayer(layer, true);
  assert.notEqual(layer._serializedPixels, editedCache, "replacing the source never reuses stale pixels");
});

test("hires PNGs refresh only for pixel changes or replaced backing images", () => {
  const w = widget();
  const layer = { id: "hires", canvas: new AlphaCanvas(20, 20), _boundsCache: { x: 0, y: 0, width: 20, height: 20 },
    hiresCanvas: new AlphaCanvas(80, 80), hiresRect: { x: 0, y: 0, width: 20, height: 20 } };
  const first = w.serializeLayer(layer);
  layer.hiresRect.x = 5;
  const moved = w.serializeLayer(layer);
  assert.equal(layer.hiresCanvas.encodes, 1);
  assert.equal(moved.hiresDataURL, first.hiresDataURL);
  assert.equal(moved.hiresRect.x, 5);
  assert.equal(first.hiresRect.x, 0);
  layer.hiresCanvas.width = 100;
  w.serializeLayer(layer);
  assert.equal(layer.hiresCanvas.encodes, 2, "resized backing invalidates its PNG");
  w.invalidateLayerRenderCaches(layer);
  w.serializeLayer(layer);
  assert.equal(layer.hiresCanvas.encodes, 3);
});

test("unchanged sidebar selection does not force repeated standalone paints", () => {
  const modes = readFileSync(new URL("../web/unicanvas/modes.mjs", import.meta.url), "utf8");
  const setActive = modes.slice(modes.indexOf("  const setActive = (next) => {"), modes.indexOf("  const teardown = () => {", modes.indexOf("  const setActive = (next) => {")));
  let paints = 0;
  const select = vm.runInNewContext(`let active = false; ${setActive}; setActive`, { syncStandaloneChrome: () => paints++ });
  select(true);
  for (let i = 0; i < 10; i++) select(true);
  assert.equal(paints, 1);
  select(false);
  assert.equal(paints, 2, "actual tab changes still update the chrome");
});
