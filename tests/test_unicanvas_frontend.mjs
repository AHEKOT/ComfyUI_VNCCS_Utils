import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


const source = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");


test("imported UniCanvas images immediately refresh the layer list", () => {
    const method = source.match(/async importFile\(file\) \{[\s\S]*?\n  \}\n\n  loadImage\(src\)/);
    assert.ok(method, "UniCanvas importFile method not found");

    const addLayerIndex = method[0].indexOf('this.addLayer("raster"');
    const invalidateIndex = method[0].indexOf("this.invalidateLayerCaches(layer)");
    const listRenderIndex = method[0].indexOf("this.renderLayerList()");
    const canvasRenderIndex = method[0].indexOf("this.requestRender()");

    assert.ok(addLayerIndex >= 0, "image import must create a raster layer");
    assert.ok(invalidateIndex > addLayerIndex, "imported pixels must invalidate layer caches");
    assert.ok(listRenderIndex > invalidateIndex, "layer list must refresh after imported pixels are ready");
    assert.ok(canvasRenderIndex > listRenderIndex, "canvas redraw must follow the layer-list refresh");
});
