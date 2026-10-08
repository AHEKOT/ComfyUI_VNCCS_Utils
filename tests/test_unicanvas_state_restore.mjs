import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { mergePoseCache } from "../web/unicanvas/pose_state.mjs";
import { normalizePanorama } from "../web/unicanvas/panorama.mjs";
import { normalizeTransformMode } from "../web/unicanvas/transform.mjs";

const source = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
let nextId = 0;
const context = { mergePoseCache, normalizePanorama, normalizeTransformMode, uid: () => `copy${++nextId}`, console };
const prototype = vm.runInNewContext(source.slice(source.indexOf("class UniCanvasWidget {"), source.indexOf("\napp.registerExtension(")) + "\nUniCanvasWidget.prototype", context);
const plain = value => JSON.parse(JSON.stringify(value));
const base = { version: 2, storage: "server_cache", state_id: "vnccs_unicanvas_1_original", layers: [] };
function widget(state, id = 1) {
    const w = Object.assign(Object.create(prototype), {
        node: { id, widgets: [{ name: "unicanvas_state", value: JSON.stringify(state) }] },
        stateCacheId: state.state_id, setStatus() {}, loadLocalStateBackup: () => null,
        async applySerializedState(value) { this.restored = plain(value); return true; },
        async uploadStatePayload(value) { this.uploaded = plain(value); return true; },
    });
    w.node.uniCanvasWidget = w;
    return w;
}
function cache(state) {
    const reads = [];
    context.fetch = async url => { reads.push(url); return { ok: true, json: async () => ({ state, revision: 12 }) }; };
    return reads;
}

test("flat restore keeps workflow metadata and borrows pixels by surviving layer ID", async () => {
    const saved = { ...base, bbox: { x: 10 }, activeLayerId: "live", settings: { model: "workflow" }, layers: [
        { id: "live", opacity: .2, visible: false, cached: true, hiresRect: { x: 5 } },
        { id: "cleared", cached: false, crop: null },
        { id: "embedded", dataURL: "workflow-pixels" },
    ] };
    cache({ ...base, bbox: { x: 0 }, settings: { model: "cached", sampler: "fallback" }, layers: [
        { id: "live", opacity: 1, visible: true, dataURL: "cached-pixels", crop: { x: 4 }, hiresDataURL: "hires" },
        { id: "cleared", dataURL: "old-pixels" },
        { id: "embedded", dataURL: "old-pixels", crop: { x: 99 } },
        { id: "deleted", dataURL: "deleted-pixels" },
    ] });
    const w = widget(saved);
    await w._loadFromNode();
    assert.deepEqual(w.restored.layers.map(l => l.id), ["live", "cleared", "embedded"]);
    assert.equal(w.restored.bbox.x, 10);
    assert.equal(w.restored.activeLayerId, "live");
    assert.deepEqual(w.restored.settings, { model: "workflow", sampler: "fallback" });
    assert.deepEqual(w.restored.layers[0], { ...saved.layers[0], dataURL: "cached-pixels", crop: { x: 4 }, hiresDataURL: "hires" });
    assert.equal(w.restored.layers[1].dataURL, undefined);
    assert.equal(w.restored.layers[2].dataURL, "workflow-pixels");
    assert.equal(w.restored.layers[2].crop, undefined);
    assert.equal(w.stateCacheId, base.state_id, "reopening a workflow preserves its cache reference");
});

test("a copied node reads original pixels then persists an independent writable cache", async () => {
    const saved = { ...base, layers: [{ id: "image", cached: true }] };
    const reads = cache({ ...saved, layers: [{ id: "image", dataURL: "original-pixels" }] });
    const original = widget(saved), copy = widget(saved, 2);
    original.node.graph = copy.node.graph = { _nodes: [original.node, copy.node] };
    copy.uploadStatePayload = async value => {
        assert.equal(JSON.parse(copy.node.widgets[0].value).state_id, original.stateCacheId);
        copy.uploaded = plain(value);
        return true;
    };
    await copy._loadFromNode();
    assert.deepEqual(reads, [`/vnccs/unicanvas_state/${base.state_id}`]);
    assert.notEqual(copy.stateCacheId, original.stateCacheId);
    assert.equal(copy.uploaded.layers[0].dataURL, "original-pixels");
    assert.equal(copy.uploaded.state_id, copy.stateCacheId);
    assert.equal(JSON.parse(copy.node.widgets[0].value).state_id, copy.stateCacheId);
    assert.notEqual(copy.getOutputCacheId(), original.getOutputCacheId());
    await copy._loadFromNode();
    assert.equal(reads[1], `/vnccs/unicanvas_state/${copy.stateCacheId}`);
});

test("restoring a cleared document cannot resurrect deleted backup layers", async () => {
    const saved = { ...base, layers: [{ id: "cleared", cached: false, type: "raster" }] };
    const w = widget(saved);
    delete w.applySerializedState;
    Object.assign(w, {
        layers: [{ id: "deleted" }], size: { width: 10, height: 10 }, settings: {},
        loadLocalStateBackup: () => ({ ...base, layers: [{ id: "deleted", dataURL: "old-pixels" }] }),
        getLayerAlphaBounds: () => ({ width: 10, height: 10 }), _createCanvas: () => ({}),
        loadImage: () => assert.fail("deleted pixels must not be loaded"),
    });
    for (const method of ["sanitizeMaskLayer", "applySeedModeDefault", "normalizeLayerOrder", "saveLocalStateBackup", "syncPromptControls", "updateSnapButton", "updatePanoramaControls", "renderLayerList"]) w[method] = () => {};
    assert.equal(await w.applySerializedState(saved), true);
    assert.deepEqual(plain(w.layers.map(l => l.id)), ["cleared"]);
});

test("disposing during restoration never uploads a blank replacement over the source cache", () => {
    const w = widget(base);
    let uploads = 0;
    Object.assign(w, { _isRestoring: true, flushStateUpload() { uploads++; }, closeEditReferenceImages() {}, stopDrawProgressPolling() {} });
    context.teardownUniCanvasWidgetModes = () => {};
    context.window = { clearTimeout() {} };
    w.dispose();
    assert.equal(uploads, 0);
    assert.equal(w._disposed, true);
});

test("the constructor's stale restore cannot unlock a newer configure restore", async () => {
    const start = source.indexOf("    const initialRestore = this._loadFromNode();");
    const end = source.indexOf("    this._loadAssets();", start);
    assert.ok(start >= 0 && end > start);
    const methods = vm.runInNewContext(`({ start() { ${source.slice(start, end)} return initialRestore; } })`);
    let finish;
    const w = Object.assign(methods, { _isRestoring: true,
        _loadFromNode() { this._stateLoadRevision = (this._stateLoadRevision || 0) + 1; return new Promise(resolve => { finish = resolve; }); },
    });
    const initial = w.start();
    w._stateLoadRevision++;
    finish();
    await initial;
    assert.equal(w._isRestoring, true);
});

test("failed copy upload keeps the durable workflow reference readable", async () => {
    const saved = { ...base, layers: [{ id: "image", cached: true }] };
    cache({ ...saved, layers: [{ id: "image", dataURL: "pixels" }] });
    const original = widget(saved), copy = widget(saved, 2);
    copy.node.graph = { _nodes: [original.node, copy.node] };
    copy.uploadStatePayload = async () => false;
    await copy._loadFromNode();
    assert.notEqual(copy.stateCacheId, original.stateCacheId);
    assert.equal(JSON.parse(copy.node.widgets[0].value).state_id, original.stateCacheId);
    assert.equal(copy.restored.layers[0].dataURL, "pixels");
});

test("local backup supplies pixels without undoing newer workflow metadata", async () => {
    const saved = { ...base, storage: "inline", bbox: { x: 17 }, layers: [{ id: "image", opacity: .3, cached: true }] };
    const w = widget(saved);
    w.loadLocalStateBackup = () => ({ ...saved, bbox: { x: 0 }, layers: [{ id: "image", opacity: 1, dataURL: "backup" }] });
    await w._loadFromNode();
    assert.equal(w.restored.bbox.x, 17);
    assert.equal(w.restored.layers[0].opacity, .3);
    assert.equal(w.restored.layers[0].dataURL, "backup");
});

test("pose assets restore even when the pose layer has no cached raster pixels", () => {
    const live = { ...base, layers: [{ id: "pose", type: "pose", cached: false, pose: { backgroundCached: true, studio: { angle: 9 } } }] };
    const stored = { ...base, layers: [{ id: "pose", pose: { studio: { background_url: "background", angle: 0 } } }] };
    const restored = widget(live).mergeCachedState(live, stored);
    assert.deepEqual(plain(restored.layers[0].pose), { studio: { angle: 9, background_url: "background" } });
    assert.equal(restored.layers[0].dataURL, undefined);
});
