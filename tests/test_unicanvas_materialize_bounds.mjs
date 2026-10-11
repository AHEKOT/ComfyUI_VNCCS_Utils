import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const prototype = vm.runInNewContext(source.slice(source.indexOf("class UniCanvasWidget {"), source.indexOf("\napp.registerExtension(")) + "\nUniCanvasWidget.prototype");

function editor(rect, allocation = true) {
  const mutations = [], statuses = [];
  const context = {
    clearRect: (...args) => mutations.push(["clear", ...args]),
    drawImage: (...args) => mutations.push(["draw", ...args]),
    save() {}, restore() {}, translate() {}, fill() {},
  };
  const native = { width: 80, height: 80 };
  const layer = { id: "native", type: "raster", canvas: { width: 100, height: 100, getContext: () => context },
    hiresCanvas: native, hiresRect: rect };
  const widget = Object.assign(Object.create(prototype), {
    layers: [layer], activeLayerId: layer.id, origin: { x: 0, y: 0 }, size: { width: 100, height: 100 },
    configureImageContext: value => value, sanitizeMaskLayer() {}, invalidateLayerRenderCaches() {},
    invalidateLayerCaches() {}, shapePath() {},
    setStatus: (message, error) => statuses.push({ message, error }),
  });
  widget.ensureWorldRectBounds = (bounds, padding) => {
    assert.equal(padding, 0);
    if (!allocation) { widget.setStatus("Browser refused canvas expansion", true); return false; }
    const right = Math.max(widget.origin.x + widget.size.width, bounds.x + bounds.width);
    const bottom = Math.max(widget.origin.y + widget.size.height, bounds.y + bounds.height);
    widget.origin = { x: Math.min(widget.origin.x, bounds.x), y: Math.min(widget.origin.y, bounds.y) };
    widget.size = { width: right - widget.origin.x, height: bottom - widget.origin.y };
    layer.canvas.width = widget.size.width; layer.canvas.height = widget.size.height;
    return true;
  };
  return { widget, layer, native, mutations, statuses };
}

for (const rect of [
  { x: 90, y: 10, width: 20, height: 20 },
  { x: -10, y: 10, width: 20, height: 20 },
  { x: 10, y: 90, width: 20, height: 20 },
  { x: 150, y: 10, width: 20, height: 20 },
]) {
  test(`pixel editing fits the complete native image before rasterizing at ${rect.x},${rect.y}`, () => {
    const { widget, layer, native, mutations, statuses } = editor(rect);
    widget.shapeDraft = { x: 20, y: 20, width: 10, height: 10 };
    widget.ensureWorldBounds = () => true;
    widget.commitRectShape();
    assert.equal(layer.hiresCanvas, null);
    const draw = mutations.find(entry => entry[0] === "draw");
    assert.equal(draw[1], native);
    assert.equal(draw[2] + widget.origin.x, rect.x);
    assert.equal(draw[3] + widget.origin.y, rect.y);
    assert.ok(draw[2] >= 0 && draw[3] >= 0);
    assert.ok(draw[2] + draw[4] <= layer.canvas.width && draw[3] + draw[5] <= layer.canvas.height,
      "all native pixels fit inside the backing canvas");
    assert.equal(statuses.length, 0);
  });
}

test("failed backing expansion keeps native pixels and stops the pixel operation", () => {
  const rect = { x: -10, y: 90, width: 20, height: 20 };
  const { widget, layer, native, mutations, statuses } = editor(rect, false);
  widget.shapeDraft = { x: 20, y: 20, width: 10, height: 10 };
  widget.ensureWorldBounds = () => true;
  widget.commitRectShape();
  assert.equal(layer.hiresCanvas, native);
  assert.equal(layer.hiresRect, rect);
  assert.equal(mutations.length, 0);
  assert.equal(statuses[0].error, true);
});

test("native layers inside the backing area materialize at their existing position", () => {
  const { widget, layer, native, mutations } = editor({ x: 20, y: 10, width: 20, height: 20 });
  widget.materializeRasterLayerForEditing(layer);
  assert.equal(layer.hiresCanvas, null);
  assert.equal(layer.hiresRect, null);
  assert.deepEqual(mutations, [["clear", 20, 10, 20, 20], ["draw", native, 20, 10, 20, 20]]);
  assert.deepEqual({ ...layer._boundsCache }, { x: 20, y: 10, width: 20, height: 20 });
});
