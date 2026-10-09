import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../web/unicanvas/layer_tools.mjs", import.meta.url), "utf8");
const widgetSource = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const prototype = vm.runInNewContext(widgetSource.slice(widgetSource.indexOf("class UniCanvasWidget {"), widgetSource.indexOf("\napp.registerExtension(")) + "\nUniCanvasWidget.prototype");

function tools(context = {}) {
    return vm.runInNewContext(source.replace(/^import .*;$/gm, "").replace(/^export \{.*\};$/gm, "").replace(/^export /gm, "")
        + "\nrequestColorMatch = matchRequest; ({collectPsdRasterLayers, importPSDFile, loadColorMatchMethod, scheduleColorMatchPreview, commitColorMatchPreview, closeColorMatchPreview});",
    { clamp: (n, min, max) => Math.max(min, Math.min(max, n)), matchRequest: async () => "match", ...context });
}

function previewHarness() {
    const frames = new Map();
    let nextFrame = 0;
    let finish;
    const api = tools({
        matchRequest: () => new Promise(resolve => { finish = resolve; }),
        requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
        cancelAnimationFrame: id => frames.delete(id),
    });
    const ctx = { save() {}, restore() {}, clearRect() {}, drawImage(image) { layer.pixels = image; } };
    const layer = { id: "A", canvas: { width: 10, height: 10, getContext: () => ctx }, _pixelRevision: 0, pixels: "original" };
    const uc = Object.assign(Object.create(prototype), {
        origin: { x: 0, y: 0 }, layers: [layer], histories: [],
        loadImage: async image => image, configureImageContext: value => value,
        materializeRasterLayerForEditing() {},
        markLayerPixelsChanged(value) { value._pixelRevision++; },
        createLayerPixelSnapshot: value => ({ pixels: value.pixels }),
        restoreLayerPixelSnapshot(value, snapshot) { value.pixels = snapshot.pixels; value._pixelRevision++; },
        pushHistoryEntry(entry) { this.histories.push(entry); },
        refreshLayerRow() {}, requestRender() {}, syncLightStateToWidget() {}, scheduleFullSync() {}, setStatus() {},
    });
    const preview = uc._vnccsColorMatch = {
        layer, crop: { x: 0, y: 0, width: 10, height: 10 }, targetBase: "original", referenceBase: "reference",
        matched: new Map(), method: "local_lab", strength: 10, seq: 0, commits: 0, rafId: 0,
        setNote() {}, openedBefore: uc.createLayerPixelSnapshot(layer), editState: uc.captureLayerEditState(layer),
        element: { remove() { preview.removed = true; } },
    };
    return { api, uc, layer, preview, finish: image => finish(image), frame() {
        const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback());
    } };
}

const foreignChanges = {
    paint: ({ layer }) => { layer.pixels = "stroke"; layer._pixelRevision++; },
    undo: ({ layer }) => { layer.pixels = "undo"; layer._pixelRevision++; },
    lock: ({ layer }) => { layer.locked = true; },
    delete: ({ uc }) => { uc.layers = []; },
    resize: ({ layer }) => { layer.canvas.width++; },
    move: ({ uc, layer }) => { uc.dragStart = { layerId: layer.id }; },
    reset: ({ uc }) => { uc.layers = []; uc._documentRevision = 1; },
    dispose: ({ uc }) => { uc._disposed = true; },
};

for (const [name, change] of Object.entries(foreignChanges)) {
    test(`late color match cannot overwrite ${name}`, async () => {
        const h = previewHarness();
        const pending = h.api.loadColorMatchMethod(h.uc, h.preview, "local_lab");
        change(h);
        const pixels = h.layer.pixels;
        h.finish("match");
        await pending;
        h.frame();
        assert.equal(h.layer.pixels, pixels);
        assert.equal(h.uc.histories.length, 0);
        assert.equal(h.preview.removed, true);
    });

    test(`color match Cancel preserves foreign ${name}`, () => {
        const h = previewHarness();
        h.preview.matched.set("local_lab", "match");
        h.api.scheduleColorMatchPreview(h.uc, h.preview);
        h.frame();
        change(h);
        const pixels = h.layer.pixels;
        h.api.closeColorMatchPreview(h.uc, false);
        assert.equal(h.layer.pixels, pixels);
        assert.equal(h.uc.histories.length, 0);
    });
}

test("color match previews each frame and commits once per gesture, then Cancel restores the original", () => {
    const h = previewHarness();
    h.preview.matched.set("local_lab", "match");
    h.api.scheduleColorMatchPreview(h.uc, h.preview);
    h.frame();
    assert.equal(h.layer.pixels, "match");
    assert.equal(h.uc.histories.length, 0, "visible feedback precedes gesture completion");
    h.api.scheduleColorMatchPreview(h.uc, h.preview);
    h.api.scheduleColorMatchPreview(h.uc, h.preview);
    h.frame();
    h.api.commitColorMatchPreview(h.uc, h.preview);
    h.api.commitColorMatchPreview(h.uc, h.preview);
    assert.equal(h.uc.histories.length, 1);
    h.api.closeColorMatchPreview(h.uc, false);
    assert.equal(h.layer.pixels, "original");
    assert.equal(h.uc.histories.length, 2, "cancellation is undoable");
});

test("returning to a cached color method invalidates an older request", async () => {
    const h = previewHarness();
    const pending = h.api.loadColorMatchMethod(h.uc, h.preview, "mkl");
    h.preview.matched.set("local_lab", "cached match");
    await h.api.loadColorMatchMethod(h.uc, h.preview, "local_lab");
    h.finish("late match");
    await pending;
    assert.equal(h.layer.pixels, "cached match");
    assert.equal(h.preview.loading, false);
    assert.equal(h.uc.histories.length, 1);
});

test("PSD children inherit hidden ancestors and unsupported group appearance is reported", () => {
    const imported = [], skipped = [];
    const child = { name: "child", canvas: {} };
    tools().collectPsdRasterLayers([{ name: "hidden group", hidden: true, opacity: .5, effects: { shadow: {} }, children: [
        { name: "nested", children: [child] },
    ] }], imported, skipped);
    assert.equal(imported.length, 1);
    assert.equal(imported[0].hidden, true);
    assert.equal(child.hidden, undefined, "the parsed PSD is not mutated");
    assert.equal(skipped[0].name, "hidden group");
    assert.match(skipped[0].reason, /group appearance/);
    for (const appearance of [{ opacity: .5 }, { effects: { shadow: {} } }, { blendMode: "multiply" }, { blendMode: "normal" }, { clipped: true }]) {
        const warnings = [];
        tools().collectPsdRasterLayers([{ ...appearance, children: [child] }], [], warnings);
        assert.equal(warnings.length, 1, JSON.stringify(appearance));
    }
    const warnings = [];
    tools().collectPsdRasterLayers([{ blendMode: "pass through", children: [child] }], [], warnings);
    assert.equal(warnings.length, 0);
});

test("current PSD imports preserve stacking and inherited visibility", async () => {
    const created = [];
    let status;
    const uc = { _documentRevision: 0, bbox: { x: 0, y: 0 }, origin: { x: 0, y: 0 },
        loadAgPsd: async () => ({ readPsd: () => ({ children: [
            { name: "top", canvas: { width: 10, height: 10 } },
            { name: "hidden", hidden: true, opacity: .5, children: [{ name: "bottom", canvas: { width: 10, height: 10 } }] },
        ] }) }),
        ensureWorldBounds() {}, configureImageContext: value => value,
        addLayer(type, name) {
            const layer = { name, canvas: { getContext: () => ({ drawImage() {} }) } };
            created.push(layer);
            return layer;
        },
        invalidateLayerCaches() {}, renderLayerList() {}, requestRender() {}, syncLightStateToWidget() {}, scheduleFullSync() {},
        setStatus(value) { status = value; },
    };
    await tools().importPSDFile(uc, { arrayBuffer: async () => new ArrayBuffer(0) });
    assert.deepEqual(created.map(layer => layer.name), ["bottom", "top"]);
    assert.equal(created[0].visible, false);
    assert.equal(created[1].visible, true);
    assert.match(status, /PSD imported 2 raster layers/);
    assert.match(status, /unsupported group appearance "hidden"/);
});

for (const change of ["reset", "dispose", "new import"]) {
    for (const phase of ["library", "buffer"]) {
        test(`PSD import discards a stale ${phase} read after ${change}`, async () => {
            let finish;
            const pending = new Promise(resolve => { finish = resolve; });
            const api = tools();
            const uc = { _documentRevision: 0, setStatus() {},
                loadAgPsd: () => phase === "library" ? pending : Promise.resolve({ readPsd: () => assert.fail("stale PSD must not be parsed") }),
                addLayer: () => assert.fail("stale PSD must not add layers"),
            };
            const importing = api.importPSDFile(uc, { arrayBuffer: () => pending });
            await new Promise(setImmediate);
            if (change === "reset") uc._documentRevision++;
            if (change === "dispose") uc._disposed = true;
            if (change === "new import") uc._importRevision++;
            finish(phase === "library" ? { readPsd: () => assert.fail("stale PSD must not be parsed") } : new ArrayBuffer(0));
            await importing;
        });
    }
}

test("queued pose payload includes its prompt without persistent generation settings", () => {
    const poseRequest = { pose_edit: { image1: "pose", image2: "background" }, positive: "edited pose and light" };
    const queued = prototype._buildDrawPayload({ poseRequest, mode: "img2img", bbox: {}, inferenceSize: {}, outputSize: {} });
    assert.equal(queued.positive, poseRequest.positive);
    assert.deepEqual(queued.pose_edit, poseRequest.pose_edit);
    assert.equal(queued.settings, undefined);
    const http = prototype._buildDrawPayload.call({ makeSettingsPayload: () => ({ positive: "old" }) }, {
        poseRequest, includeDebugId: true, mode: "img2img", bbox: {}, inferenceSize: {}, outputSize: {},
    });
    assert.equal(http.settings.positive, queued.positive);
});
