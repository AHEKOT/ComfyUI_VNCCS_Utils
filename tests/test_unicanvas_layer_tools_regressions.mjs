import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { writePsd, readPsd, initializeCanvas } from "../web/vendor/ag-psd.bundle.mjs";

const source = readFileSync(new URL("../web/unicanvas/layer_tools.mjs", import.meta.url), "utf8");
const widgetSource = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const prototype = vm.runInNewContext(widgetSource.slice(widgetSource.indexOf("class UniCanvasWidget {"), widgetSource.indexOf("\napp.registerExtension(")) + "\nUniCanvasWidget.prototype");

function tools(context = {}) {
    return vm.runInNewContext(source.replace(/^import .*;$/gm, "").replace(/^export \{.*\};$/gm, "").replace(/^export /gm, "")
        + "\nrequestColorMatch = matchRequest; ({collectPsdRasterLayers, importPSDFile, buildColorMatchReference, openColorMatchPopover, loadColorMatchMethod, scheduleColorMatchPreview, commitColorMatchPreview, closeColorMatchPreview});",
    { clamp: (n, min, max) => Math.max(min, Math.min(max, n)), matchRequest: async () => "match", ...context });
}

function previewHarness(context = {}) {
    const frames = new Map();
    let nextFrame = 0;
    let finish;
    let fail;
    const api = tools({
        matchRequest: () => new Promise((resolve, reject) => { finish = resolve; fail = reject; }),
        requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
        cancelAnimationFrame: id => frames.delete(id),
        ...context,
    });
    const blends = [];
    const ctx = { save() {}, restore() {}, clearRect() {}, drawImage(image) {
        image = image?.image ?? image;
        layer.pixels = image;
        if (image !== "original") blends.push({ image, alpha: this.globalAlpha });
    } };
    const layer = { id: "A", canvas: { width: 10, height: 10, getContext: () => ctx }, _pixelRevision: 0, pixels: "original" };
    const uc = Object.assign(Object.create(prototype), {
        origin: { x: 0, y: 0 }, layers: [layer], histories: [],
        loadImage: async image => image, configureImageContext: value => value,
        materializeRasterLayerForEditing() {},
        cloneCanvas(image) { return { image, width: 1, height: 1, getContext: () => ({
            getImageData: () => ({ data: new Uint8ClampedArray(0) }), putImageData() {},
        }) }; },
        markLayerPixelsChanged(value) { value._pixelRevision++; },
        createLayerPixelSnapshot: value => ({ pixels: value.pixels }),
        restoreLayerPixelSnapshot(value, snapshot) { value.pixels = snapshot.pixels; value._pixelRevision++; },
        pushHistoryEntry(entry) { this.histories.push(entry); },
        refreshLayerRow() {}, requestRender() {}, syncLightStateToWidget() {}, scheduleFullSync() {}, setStatus() {},
    });
    const preview = uc._vnccsColorMatch = {
        layer, crop: { x: 0, y: 0, width: 10, height: 10 }, targetBase: "original", referenceBase: "reference",
        matched: new Map(), method: "local_lab", strength: 10, seq: 0, commits: 0, rafId: 0,
        strengthInput: { disabled: false },
        setNote() {}, openedBefore: uc.createLayerPixelSnapshot(layer), editState: uc.captureLayerEditState(layer),
        element: { remove() { preview.removed = true; } },
    };
    return { api, uc, layer, preview, blends, finish: image => finish(image), fail: error => fail(error), frame() {
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

function pixelCanvas(pixel = [0, 0, 0, 0]) {
    const canvas = { width: 1, height: 1, pixels: [...pixel] }, stack = [];
    const ctx = {
        globalAlpha: 1, globalCompositeOperation: "source-over",
        save() { stack.push([this.globalAlpha, this.globalCompositeOperation]); },
        restore() { [this.globalAlpha, this.globalCompositeOperation] = stack.pop(); },
        clearRect() { canvas.pixels = [0, 0, 0, 0]; },
        drawImage(image) {
            const source = image.pixels, backdrop = canvas.pixels;
            const sourceAlpha = source[3] / 255 * this.globalAlpha, backdropAlpha = backdrop[3] / 255;
            if (this.globalCompositeOperation === "source-atop") {
                canvas.pixels = source.slice(0, 3).map((value, i) => value * sourceAlpha + backdrop[i] * (1 - sourceAlpha));
                canvas.pixels.push(backdrop[3]);
            } else {
                const alpha = sourceAlpha + backdropAlpha * (1 - sourceAlpha);
                canvas.pixels = source.slice(0, 3).map((value, i) => alpha ?
                    (value * sourceAlpha + backdrop[i] * backdropAlpha * (1 - sourceAlpha)) / alpha : 0);
                canvas.pixels.push(alpha * 255);
            }
        },
        getImageData: () => ({ data: new Uint8ClampedArray(canvas.pixels) }),
        putImageData(image) { canvas.pixels = [...image.data]; },
    };
    canvas.getContext = () => ctx;
    return canvas;
}

for (const alpha of [64, 128, 255]) {
    test(`color match Strength blends RGB once and preserves alpha ${alpha}`, async () => {
        const h = previewHarness(), original = [200, 40, 20, alpha], matched = [20, 60, 220, alpha];
        h.layer.canvas = pixelCanvas(original);
        h.preview.targetBase = pixelCanvas(original);
        h.preview.editState = h.uc.captureLayerEditState(h.layer);
        h.preview.dragging = true;
        h.uc.cloneCanvas = image => { const copy = pixelCanvas(); copy.getContext().drawImage(image); return copy; };
        const pending = h.api.loadColorMatchMethod(h.uc, h.preview, "local_lab");
        h.finish(pixelCanvas(matched));
        await pending;
        for (const strength of [0, 5, 10]) {
            h.preview.strength = strength;
            h.api.scheduleColorMatchPreview(h.uc, h.preview); h.frame();
            assert.deepEqual(h.layer.canvas.pixels.map(Math.round), original.map((value, i) =>
                i === 3 ? alpha : Math.round(value + (matched[i] - value) * strength / 10)));
            assert.equal(h.uc.histories.length, 0, "held slider values update before the gesture commits");
        }
        h.api.commitColorMatchPreview(h.uc, h.preview);
        assert.equal(h.uc.histories.length, 1);
    });
}

test("color match keeps its crop in world coordinates after native backing expansion", () => {
    const h = previewHarness(), draws = [];
    h.preview.crop = { x: -4, y: -3, width: 14, height: 13 };
    h.layer.canvas.getContext = () => ({ save() {}, restore() {}, clearRect() {}, drawImage: (...args) => draws.push(args) });
    h.uc.materializeRasterLayerForEditing = () => { h.uc.origin = { x: -4, y: -3 }; };
    h.preview.matched.set("local_lab", "match");
    h.api.scheduleColorMatchPreview(h.uc, h.preview);
    h.api.commitColorMatchPreview(h.uc, h.preview);
    assert.deepEqual(draws.map(args => args.slice(1)), [[0, 0, 14, 13], [0, 0, 14, 13]]);
    assert.equal(h.uc.histories.length, 1);
    h.api.scheduleColorMatchPreview(h.uc, h.preview); h.frame();
    assert.deepEqual(draws.at(-1).slice(1), [0, 0, 14, 13], "later frames retain the same placement");
});

test("color match cannot record a pixel edit when native backing expansion fails", () => {
    const h = previewHarness();
    h.uc.materializeRasterLayerForEditing = () => false;
    h.preview.matched.set("local_lab", "match");
    h.api.scheduleColorMatchPreview(h.uc, h.preview);
    h.api.commitColorMatchPreview(h.uc, h.preview);
    assert.equal(h.layer.pixels, "original");
    assert.equal(h.uc.histories.length, 0);
    assert.equal(h.preview.closed, true);
});

test("color match prepares complete native pixels and the same world rectangle for its reference", async () => {
    const controls = new Map(), references = [];
    const element = { style: {}, remove() {}, querySelector(selector) {
        if (!controls.has(selector)) controls.set(selector, { style: {}, addEventListener() {} });
        return controls.get(selector);
    } };
    const h = previewHarness({ document: { createElement: tag => tag === "div" ? element : { getContext: () => ({ save() {}, restore() {} }) } },
        installCustomSelects() {} });
    h.uc._vnccsColorMatch = null;
    h.layer.type = "raster"; h.layer.hiresCanvas = {}; h.layer.hiresRect = { x: -4, y: -3, width: 14, height: 13 };
    h.uc.layers.push({ id: "below", type: "raster", visible: true });
    Object.assign(h.uc, { container: { appendChild() {} }, getLayerAlphaBounds: () => h.preview.crop,
        cloneCanvas: source => { assert.equal(source, h.layer.hiresCanvas); return "complete native pixels"; },
        drawRasterLayerToWorldRect: (_ctx, _layer, rect) => references.push({ ...rect }),
    });
    h.api.openColorMatchPopover(h.uc, h.layer);
    assert.equal(h.uc._vnccsColorMatch.targetBase, "complete native pixels");
    assert.deepEqual({ ...h.uc._vnccsColorMatch.crop }, h.layer.hiresRect);
    assert.deepEqual(references, [h.layer.hiresRect]);
    h.api.closeColorMatchPreview(h.uc, false);
    h.finish("stale match"); await new Promise(resolve => setImmediate(resolve));
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
    assert.equal(h.preview.strengthInput.disabled, false, "cached methods immediately restore continuous control");
    assert.equal(h.uc.histories.length, 1);
});

test("Color Match only enables Strength when the selected method can preview every input", async () => {
    const controls = new Map();
    const control = selector => {
        if (!controls.has(selector)) controls.set(selector, { style: {}, disabled: false, listeners: {},
            addEventListener(type, handler) { this.listeners[type] = handler; },
            emit(type) { if (!this.disabled) this.listeners[type]?.(); },
        });
        return controls.get(selector);
    };
    const element = { style: {}, querySelector: control, remove() {} };
    const h = previewHarness({
        document: { createElement: tag => tag === "div" ? element : { getContext: () => ({ save() {}, restore() {} }) } },
        installCustomSelects() {},
    });
    h.uc._vnccsColorMatch = null;
    h.layer.type = "raster";
    h.uc.layers.push({ id: "below", type: "raster", visible: true });
    Object.assign(h.uc, { container: { appendChild() {} }, getLayerAlphaBounds: () => h.preview.crop,
        cloneCanvasCrop: () => "original", drawRasterLayerToWorldRect() {} });
    h.api.openColorMatchPopover(h.uc, h.layer);
    const preview = h.uc._vnccsColorMatch;
    const strength = control('[data-control="colorMatchStrength"]');
    const method = control('[data-control="colorMatchMethod"]');
    assert.equal(strength.disabled, true, "the initial server calculation cannot expose an inert slider");
    strength.value = "3"; strength.emit("input"); h.frame();
    assert.equal(preview.strength, 10);
    assert.equal(h.blends.length, 0);
    h.finish("first match");
    await new Promise(resolve => setImmediate(resolve));
    h.frame();
    assert.equal(strength.disabled, false);
    const historyBefore = h.uc.histories.length;
    strength.emit("pointerdown");
    for (const value of [8, 6, 3]) {
        strength.value = String(value); strength.emit("input"); h.frame();
        assert.equal(h.blends.at(-1).alpha, value / 10, "held input blends the newest strength each frame");
        assert.equal(h.uc.histories.length, historyBefore);
    }
    strength.emit("pointerup"); strength.emit("change");
    assert.equal(h.uc.histories.length, historyBefore + 1, "one completed gesture creates one undo command");
    method.value = "reinhard_lab_gpu"; method.emit("change");
    assert.equal(strength.disabled, true);
    const lastValid = h.layer.pixels;
    strength.value = "1"; strength.emit("input"); h.frame();
    assert.equal(h.layer.pixels, lastValid, "the last valid frame stays visible during method preparation");
    assert.equal(preview.strength, 3);
    method.value = "local_lab"; method.emit("change");
    assert.equal(strength.disabled, false, "switching back to a cached method never waits for the pending one");
    h.finish("stale match");
    await new Promise(resolve => setImmediate(resolve)); h.frame();
    assert.equal(h.layer.pixels, "first match");
    assert.equal(strength.disabled, false);
    method.value = "reinhard_lab_gpu"; method.emit("change");
    h.fail(Error("calculation failed"));
    await new Promise(resolve => setImmediate(resolve)); h.frame();
    assert.equal(strength.disabled, true, "a failed method must not re-enable an inert slider");
    assert.equal(h.layer.pixels, "first match");
    method.value = "local_lab"; method.emit("change");
    assert.equal(strength.disabled, false, "a ready method remains available after a failure");
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

for (const group of [false, true]) {
    test(`PSD import reports and skips a masked ${group ? "group" : "raster layer"}`, async () => {
        initializeCanvas(undefined, undefined, (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }));
        const imageData = { width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255]) };
        const mask = { left: 0, top: 0, right: 1, bottom: 1, defaultColor: 0,
            imageData: { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) } };
        const layer = { name: "Red", left: 0, top: 0, right: 1, bottom: 1, imageData };
        const entry = group ? { name: "Masked", blendMode: "pass through", mask, children: [layer] } : { ...layer, name: "Masked", mask };
        const bytes = writePsd({ width: 1, height: 1, imageData, children: [entry] });
        const parsed = readPsd(bytes, { useImageData: true });
        assert.ok(parsed.children[0].mask);
        assert.equal((group ? parsed.children[0].children[0] : parsed.children[0]).imageData.data[3], 255,
            "ag-psd keeps the hidden pixel opaque and returns its mask separately");
        const created = [];
        let status;
        const uc = {
            bbox: { x: 0, y: 0 }, origin: { x: 0, y: 0 }, loadAgPsd: async () => ({ readPsd }),
            ensureWorldRectBounds: () => true, configureImageContext: value => value,
            addLayer(type, name) { const result = { name, canvas: pixelCanvas() }; created.push(result); return result; },
            invalidateLayerCaches() {}, renderLayerList() {}, requestRender() {}, syncLightStateToWidget() {}, scheduleFullSync() {},
            setStatus(value) { status = value; },
        };
        const api = tools({ document: { createElement: () => pixelCanvas() },
            ImageData: class { constructor(data) { this.data = data; } } });
        await api.importPSDFile(uc, { arrayBuffer: async () => bytes });
        assert.deepEqual(created, []);
        assert.match(status, /PSD imported 0 raster layers; skipped 1: layer\/group mask "Masked"/);
    });
}

test("PSD disabled masks leave layer and group pixels importable", () => {
    for (const mask of [{ mask: { disabled: true } }, { realMask: { disabled: true } }, { vectorMask: { disable: true } }]) {
        const child = { name: "Unmasked", canvas: {} }, imported = [], skipped = [];
        tools().collectPsdRasterLayers([{ ...child, ...mask }, { ...mask, children: [child] }], imported, skipped);
        assert.equal(imported.length, 2);
        assert.equal(skipped.length, 0);
    }
    for (const mask of [{ realMask: {} }, { vectorMask: {} }]) {
        const imported = [], skipped = [];
        tools().collectPsdRasterLayers([{ name: "Masked", canvas: {}, ...mask }], imported, skipped);
        assert.equal(imported.length, 0);
        assert.match(skipped[0].reason, /mask/);
    }
});

test("current PSD imports preserve stacking and inherited visibility", async () => {
    const created = [];
    let status;
    const uc = { _documentRevision: 0, bbox: { x: 0, y: 0 }, origin: { x: 0, y: 0 },
        loadAgPsd: async () => ({ readPsd: () => ({ children: [
            { name: "top", canvas: { width: 10, height: 10 } },
            { name: "hidden", hidden: true, opacity: .5, children: [{ name: "bottom", canvas: { width: 10, height: 10 } }] },
        ] }) }),
        ensureWorldRectBounds: () => true, configureImageContext: value => value,
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

test("PSD import reports failed expansion without adding an empty layer", async () => {
    let status;
    const uc = { _documentRevision: 0, bbox: { x: 0, y: 0 },
        loadAgPsd: async () => ({ readPsd: () => ({ children: [
            { name: "too far", left: 500000, canvas: { width: 10, height: 10 } },
        ] }) }),
        ensureWorldRectBounds: () => false,
        addLayer: () => assert.fail("failed expansion must not create a layer"),
        setStatus(value) { status = value; },
    };
    await tools().importPSDFile(uc, { arrayBuffer: async () => new ArrayBuffer(0) });
    assert.match(status, /PSD import failed:.*too far/);
});

test("color match ignores masks both below the target and in the fallback", () => {
    const drawn = [];
    const api = tools({ document: { createElement: () => ({ getContext: () => ({ save() {}, restore() {} }) }) } });
    const target = { id: "target", type: "raster", visible: true };
    const mask = { id: "mask", type: "mask", visible: true };
    const image = { id: "image", type: "pose", visible: true };
    const uc = { origin: { x: 0, y: 0 }, configureImageContext: value => value,
        drawRasterLayerToWorldRect(_ctx, layer) { drawn.push(layer.id); } };
    const crop = { x: 0, y: 0, width: 10, height: 10 };
    for (const layers of [[target, mask], [mask, target]]) {
        uc.layers = layers;
        assert.equal(api.buildColorMatchReference(uc, target, crop), null);
    }
    for (const layers of [[target, mask, image], [mask, image, target]]) {
        uc.layers = layers;
        assert.ok(api.buildColorMatchReference(uc, target, crop));
    }
    assert.deepEqual(drawn, ["image", "image"]);
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
