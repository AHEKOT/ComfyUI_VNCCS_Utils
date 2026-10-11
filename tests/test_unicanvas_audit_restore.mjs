import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { normalizePanorama } from "../web/unicanvas/panorama.mjs";
import { serializePose } from "../web/unicanvas/pose_state.mjs";

const source = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const context = { console: { warn() {} }, clearTimeout, normalizePanorama, serializePose,
    normalizeTransformMode: value => value || "free", makeDefaultUniCanvasSettings: () => ({}),
    URL: { createObjectURL: () => "blob:import", revokeObjectURL() {} } };
const prototype = vm.runInNewContext(source.slice(source.indexOf("class UniCanvasWidget {"), source.indexOf("\napp.registerExtension("))
    + "\nUniCanvasWidget.prototype", context);
const clone = value => JSON.parse(JSON.stringify(value));
const saved = { version: 2, state_id: "replacement", storage: "inline", layers: [], settings: {},
    origin: { x: 0, y: 0 }, size: { width: 16, height: 16 }, bbox: { x: 0, y: 0, width: 8, height: 8 } };

function widget(state = saved) {
    const layer = { id: "old", canvas: { width: 16, height: 16 }, type: "raster" };
    const w = Object.assign(Object.create(prototype), {
        node: { widgets: [{ name: "unicanvas_state", value: JSON.stringify(state) }] },
        layers: [layer], activeLayerId: layer.id, origin: { x: 0, y: 0 }, size: { width: 16, height: 16 },
        bbox: { ...saved.bbox }, settings: {}, panorama: null, _documentRevision: 1, _importRevision: 1,
        undoStack: [{ kind: "addLayer", layer }], redoStack: [{ kind: "addLayer", layer }],
        stagingItems: [{ url: "old-result" }], activeStagingIndex: 0,
        transformDraft: { layerId: "old" }, shapeDraft: {}, lassoPoints: [{ x: 1, y: 2 }],
        poseEditSession: { layerId: "old" }, newPoseLayerId: "old", tool: "move",
        isPointerDown: true, pointerMode: "brush", lastPoint: { x: 1, y: 2 }, dragStart: { pointerId: 1 },
        zoomDragStart: {}, lastDrawPointByTool: { brush: { x: 1, y: 2 } },
        loadLocalStateBackup: () => null, _createCanvas: () => ({ getContext: () => ({ drawImage() {} }) }),
        configureImageContext: value => value, getLayerAlphaBounds: () => null,
        setStatus() {}, saveLocalStateBackup() {}, applySeedModeDefault() {}, sanitizeMaskLayer() {},
        normalizeLayerOrder() {}, syncPromptControls() {}, updateSnapButton() {}, updatePanoramaControls() {},
        renderLayerList() {}, updateHistoryButtons() {}, clearSamPrompt() {}, setTool() {},
        syncActiveLayerControls() {}, cancelDeferredCanvasCommit() {},
    });
    return w;
}

test("workflow replacement restores an empty document and retires the previous editor session", async () => {
    const w = widget();
    await w._loadFromNode();
    assert.equal(w._stateRestoreFailed, false);
    for (const field of ["layers", "undoStack", "redoStack", "stagingItems", "lassoPoints"]) {
        assert.deepEqual(clone(w[field]), [], field);
    }
    assert.equal(w.activeLayerId, null);
    assert.equal(w.activeStagingIndex, -1);
    assert.equal(w.isPointerDown, false);
    for (const field of ["transformDraft", "shapeDraft", "poseEditSession", "newPoseLayerId", "pointerMode", "lastPoint", "dragStart", "zoomDragStart"]) {
        assert.equal(w[field], null, field);
    }
    assert.deepEqual(clone(w.lastDrawPointByTool), { brush: null, eraser: null, mask: null });
});

for (const failure of ["invalid JSON", "image decode"]) {
    test(`failed workflow replacement (${failure}) preserves pixels, history, staging and original workflow bytes`, async () => {
        const w = widget({ ...saved, layers: [{ id: "new", dataURL: "new-pixels" }] });
        if (failure === "invalid JSON") w.node.widgets[0].value = "{authored workflow";
        else w.loadImage = async () => { throw new Error("damaged image"); };
        const original = { layers: w.layers, undoStack: w.undoStack, redoStack: w.redoStack, stagingItems: w.stagingItems };
        const bytes = w.node.widgets[0].value;
        await w._loadFromNode();
        assert.equal(w._stateRestoreFailed, true);
        for (const [field, value] of Object.entries(original)) assert.equal(w[field], value, field);
        assert.equal(w.node.widgets[0].value, bytes);
    });
}

test("an image decoded after workflow replacement cannot import into the new document", async () => {
    const w = widget();
    let finish;
    w.loadImage = () => new Promise(resolve => { finish = resolve; });
    w.fileInput = { value: "file" };
    w.transformDraft = null;
    w.addLayer = () => assert.fail("the old import must not add a layer");
    w.ensureWorldBounds = () => true;
    context.isPanoramaCandidate = () => false;
    const pending = w.importFile({ name: "old.png" });
    await w._loadFromNode();
    finish({ width: 8, height: 8 });
    await pending;
});

test("a Flatten confirmation opened for another workflow cannot flatten the replacement", async () => {
    const w = widget();
    let finish;
    w.layers.push({ id: "other" });
    w.transformDraft = null;
    w.confirmInWidget = () => new Promise(resolve => { finish = resolve; });
    w.flattenLayersToMaster = () => assert.fail("the confirmation belongs to the old document");
    const pending = w.confirmFlattenLayers();
    await w._loadFromNode();
    finish(true);
    await pending;
});

test("restoration blocks control events and asynchronous layer edits until decoding completes", () => {
    const w = widget();
    w.transformDraft = null; w.dragStart = null;
    const edit = w.captureLayerEditState(w.layers[0]);
    assert.equal(w.isLayerEditStateCurrent(edit), true);
    w._isRestoring = true;
    assert.equal(w.isInteractionBlocked({ type: "input", target: {} }), true);
    assert.equal(w.isLayerEditStateCurrent(edit), false);
});

test("onConfigure blocks saving before its delayed restore and invalidates the constructor restore", async () => {
    const w = widget();
    w._stateLoadRevision = 3; w._stateRestoreRevision = 4;
    const nodeType = { prototype: { onConfigure() { assert.equal(this, node); } } };
    const node = { uniCanvasWidget: w };
    let delayed;
    const start = source.indexOf("    const onConfigure = nodeType.prototype.onConfigure;");
    const end = source.indexOf("    const onConnectionsChange =", start);
    vm.runInNewContext(source.slice(start, end), { nodeType, clearTimeout,
        setTimeout: callback => { delayed = callback; return 1; }, syncUniCanvasDOMWidgetWidth() {} });
    nodeType.prototype.onConfigure.call(node);
    assert.equal(w._isRestoring, true);
    assert.ok(w._stateLoadRevision > 3);
    assert.ok(w._stateRestoreRevision > 4);
    for (const method of ["resize", "fitInitialView", "syncPoseToolToActiveLayer", "render"]) w[method] = () => {};
    await delayed();
    assert.equal(w._isRestoring, false);
});

test("workflow restoration reads only the new snapshot's browser backup", async () => {
    const state = { ...saved, layers: [{ id: "same-layer", cached: true }] };
    const w = widget(state);
    w.stateCacheId = "previous";
    w.stateBackupKey = "vnccs_unicanvas_backup_previous";
    delete w.loadLocalStateBackup;
    const loaded = [];
    w.loadImage = async url => { loaded.push(url); return {}; };
    context.window = { localStorage: { getItem: key => JSON.stringify({ state: {
        ...state, layers: [{ id: "same-layer", dataURL: key.endsWith("previous") ? "old-pixels" : "new-pixels" }],
    } }) } };
    await w._loadFromNode();
    assert.deepEqual(loaded, ["new-pixels"]);
});

for (const stage of ["cache fetch", "image decode"]) {
    test(`a stale ${stage} rejection cannot replace the latest workflow status or controls`, async () => {
        const state = { ...saved, storage: stage === "cache fetch" ? "server_cache" : "inline",
            layers: [{ id: "new", dataURL: "new-pixels" }] };
        const w = widget(state);
        let reject;
        if (stage === "cache fetch") context.fetch = () => new Promise((resolve, fail) => { reject = fail; });
        else w.loadImage = () => new Promise((resolve, fail) => { reject = fail; });
        const pending = w._loadFromNode();
        w.node.widgets[0].value = JSON.stringify(saved);
        await w._loadFromNode();
        const statuses = []; let controls = 0;
        w.setStatus = message => statuses.push(message);
        w.updatePanoramaControls = () => { controls++; };
        reject(new Error("old request failed"));
        await pending;
        assert.deepEqual(statuses, []);
        assert.equal(controls, 0);
        assert.equal(w._stateRestoreFailed, false);
        assert.deepEqual(clone(w.layers), []);
    });
}

for (const stale of ["reconfigure", "remove"]) {
    test(`a late image import rejection after ${stale} leaves the current status alone`, async () => {
        const w = widget();
        let reject;
        w.fileInput = { value: "file" }; w.transformDraft = null;
        w.loadImage = () => new Promise((resolve, fail) => { reject = fail; });
        const pending = w.importFile({ name: "old.png" });
        if (stale === "reconfigure") await w._loadFromNode();
        else w._disposed = true;
        w.setStatus = () => assert.fail("the old import must not write status");
        reject(new Error("old image failed"));
        await pending;
    });
}

test("reading a valid saved workflow cannot overwrite an unacknowledged browser draft", async () => {
    const id = "vnccs_unicanvas_1_saved";
    const workflow = { ...saved, state_id: id, storage: "server_cache", layers: [{ id: "image", cached: true }] };
    const values = new Map();
    context.LOCAL_STATE_BACKUP_MAX_CHARS = 10000;
    context.window = { localStorage: {
        get length() { return values.size; }, key: index => [...values.keys()][index],
        getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key),
    } };
    const w = widget(workflow);
    delete w.saveLocalStateBackup;
    w.stateCacheId = id;
    w.buildSerializedState = () => ({ ...workflow, layers: [{ id: "image", dataURL: w.pixels }] });
    let server;
    context.fetch = async (_url, options) => {
        const upload = JSON.parse(options.body);
        if (upload.state.layers[0].dataURL === "unsaved-blue") throw new Error("offline");
        server = clone(upload.state);
        return { ok: true, json: async () => ({ status: "ok" }) };
    };
    w.pixels = "saved-red";
    assert.equal(await w.flushStateUpload(), true);
    w.pixels = "unsaved-blue";
    assert.equal(await w.flushStateUpload(), false);
    const key = w.getStateBackupKey(), draft = values.get(key);
    assert.equal(JSON.parse(draft).confirmed, false);
    assert.equal(JSON.parse(draft).state.layers[0].dataURL, "unsaved-blue");

    const restored = widget(workflow), decoded = [];
    delete restored.saveLocalStateBackup;
    delete restored.loadLocalStateBackup;
    restored.loadImage = async url => { decoded.push(url); return {}; };
    context.fetch = async () => ({ ok: true, json: async () => ({ state: server, revision: 10 }) });
    await restored._loadFromNode();
    assert.equal(restored._stateRestoreFailed, false);
    assert.deepEqual(decoded, ["saved-red"], "the workflow still opens its saved snapshot");
    assert.equal(values.get(key), draft, "reading a saved snapshot must preserve the recoverable draft bytes");
});
