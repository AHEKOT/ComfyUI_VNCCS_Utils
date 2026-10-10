import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { mergePoseCache, serializePose } from "../web/unicanvas/pose_state.mjs";
import { normalizePanorama } from "../web/unicanvas/panorama.mjs";
import { normalizeTransformMode } from "../web/unicanvas/transform.mjs";
import { disposeModelDependencies } from "../web/unicanvas/model_dependencies.mjs";

const source = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
let nextId = 0;
const context = { mergePoseCache, serializePose, widgetSettings: value => value,
    app: { graph: { setDirtyCanvas() {} } }, normalizePanorama, normalizeTransformMode,
    disposeModelDependencies, uid: () => `copy${++nextId}`, console, clearTimeout };
context.buildUniCanvasBboxCompositeCanvas = widget => ({ width: 1, height: 1, toDataURL: () => widget.pixels });
const prototype = vm.runInNewContext(source.slice(source.indexOf("class UniCanvasWidget {"), source.indexOf("\napp.registerExtension(")) + "\nUniCanvasWidget.prototype", context);
const plain = value => JSON.parse(JSON.stringify(value));
const base = { version: 2, storage: "server_cache", state_id: "vnccs_unicanvas_1_original", layers: [] };
function widget(state, id = 1) {
    const w = Object.assign(Object.create(prototype), {
        node: { id, widgets: [{ name: "unicanvas_state", value: JSON.stringify(state) }] },
        stateCacheId: state.state_id, setStatus() {}, scheduleStateUpload() {}, loadLocalStateBackup: () => null,
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
    let closed = false;
    Object.assign(w, { _isRestoring: true, flushStateUpload() { uploads++; }, closeColorMatchPreview(commit) { closed = commit; }, closeEditReferenceImages() {}, stopDrawProgressPolling() {} });
    context.teardownUniCanvasWidgetModes = () => {};
    context.window = { clearTimeout() {} };
    w.dispose();
    assert.equal(uploads, 0);
    assert.equal(w._disposed, true);
    assert.equal(closed, true);
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

test("partial server cache borrows only missing pixels from the local backup", async () => {
    const saved = { ...base, layers: [{ id: "A", cached: true }, { id: "B", cached: true, opacity: .3 }] };
    cache({ ...base, layers: [{ id: "A", dataURL: "new-server-A" }] });
    const w = widget(saved);
    w.loadLocalStateBackup = () => ({ ...base, layers: [{ id: "A", dataURL: "old-A" }, { id: "B", dataURL: "backup-B" }] });
    await w._loadFromNode();
    assert.equal(w.restored.layers[0].dataURL, "new-server-A");
    assert.equal(w.restored.layers[1].dataURL, "backup-B");
    assert.equal(w.restored.layers[1].opacity, .3);
});

test("unrecoverable partial caches block restore and subsequent saving", async () => {
    for (const missing of [{ id: "B", cached: true }, { id: "B", dataURL: "preview", hiresRect: { x: 1 } }]) {
        const saved = { ...base, layers: [{ id: "A", dataURL: "A" }, missing] };
        cache(saved);
        const w = widget(saved);
        w.layers = [{ id: "existing" }];
        let backups = 0;
        w.saveLocalStateBackup = () => backups++;
        await w._loadFromNode();
        assert.equal(w._stateRestoreFailed, true);
        assert.equal(w.restored, undefined);
        assert.equal(await w.flushStateUpload(), false);
        assert.equal(backups, 0);
        assert.equal(w.layers[0].id, "existing");
    }
});

test("direct partial-state restore also protects existing pixels and backup", async () => {
    const saved = { ...base, layers: [{ id: "A", dataURL: "A" }, { id: "B", cached: true }] };
    const w = widget(saved);
    delete w.applySerializedState;
    w.layers = [{ id: "existing" }];
    w.updatePanoramaControls = () => {};
    w.saveLocalStateBackup = () => assert.fail("incomplete state must not overwrite the backup");
    await w.applySerializedState(saved);
    assert.equal(w._stateRestoreFailed, true);
    assert.equal(w.layers[0].id, "existing");
});

test("hires-only and explicitly cleared layers do not require missing raster pixels", () => {
    const w = widget(base);
    assert.equal(w.stateHasMissingLayerPixels({ layers: [
        { cached: true, hiresRect: { x: 1 }, hiresDataURL: "hires" },
        { cached: false }, { type: "pose", cached: false, pose: {} },
    ] }), false);
    assert.equal(w.stateHasMissingLayerPixels({ layers: [{ crop: { x: 1 }, dataURL: null }] }), true);
    assert.equal(w.stateHasMissingLayerPixels({ layers: [{ cached: true, hiresDataURL: "unusable without rect" }] }), true);
});

test("a full empty-layer snapshot resolves the provisional cached flag from light sync", async () => {
    const saved = { ...base, layers: [{ id: "empty", crop: null, cached: true }] };
    cache({ ...base, layers: [{ id: "empty", crop: null, dataURL: null, hiresRect: null }] });
    const w = widget(saved);
    await w._loadFromNode();
    assert.equal(w.restored.layers[0].cached, false);
    assert.equal(w._stateRestoreFailed, false);
});

test("standalone pointer restores the full server document, including panorama and settings", async () => {
    const pointer = { ...base, state_id: "vnccs_unicanvas_standalone_tab" };
    const saved = { ...pointer, panorama: { projection: "equirectangular", width: 2048, height: 1024 },
        settings: { prompt: "saved" }, layers: [{ id: "A", dataURL: "large saved pixels" }] };
    cache(saved);
    const w = widget(pointer);
    w.standalone = true;
    await w._loadFromNode();
    assert.deepEqual(w.restored, saved);
    assert.equal(w.stateCacheRevision, 12);
});

test("failed restore cannot overwrite saved pixels with the initial blank document on disposal", async () => {
    const saved = { ...base, layers: [{ id: "A", cached: true }] };
    context.fetch = async () => { throw new Error("offline"); };
    const w = widget(saved);
    w.layers = [];
    await w._loadFromNode();
    assert.equal(w._stateRestoreFailed, true);
    assert.equal(await w.flushStateUpload(), false);
    assert.equal(w.uploaded, undefined);
});

test("an invalid successful cache response cannot replace saved pixels with a blank document", async () => {
    for (const state of [null, { version: 99, layers: [] }, { version: 2, layers: "invalid" }]) {
        context.fetch = async () => ({ ok: true, json: async () => ({ state }) });
        const w = widget({ ...base, layers: [{ id: "A", cached: true }] });
        await w._loadFromNode();
        assert.equal(w._stateRestoreFailed, true);
        assert.equal(w.restored, undefined);
        assert.equal(await w.flushStateUpload(), false);
        assert.equal(w.uploaded, undefined);
    }
});

function writableWidget(pixels = "red") {
    const w = widget({ ...base, layers: [{ id: "image", cached: true }] });
    delete w.uploadStatePayload;
    Object.assign(w, {
        pixels, settings: {}, bbox: { x: 0 }, saveLocalStateBackup() {},
        buildSerializedState() {
            return { ...base, state_id: this.getStateCacheId(), output_id: this.getOutputCacheId(),
                bbox: this.bbox, settings: this.settings, layers: [{ id: "image", dataURL: this.pixels }] };
        },
        scheduleStateUpload() {},
    });
    return w;
}

function backupStorage() {
    const values = new Map();
    context.LOCAL_STATE_BACKUP_MAX_CHARS = 10000;
    context.window = { localStorage: {
        get length() { return values.size; }, key: index => [...values.keys()][index],
        getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key),
    } };
    return values;
}

test("failed uploads preserve every canvas draft, including legacy backups", async () => {
    const values = backupStorage();
    const legacy = "vnccs_unicanvas_backup_legacy";
    values.set(legacy, JSON.stringify({ state: { layers: [{ dataURL: "legacy" }] } }));
    context.fetch = async () => { throw new Error("offline"); };
    const a = writableWidget("A"), b = writableWidget("B");
    b.stateCacheId = "canvas_B";
    delete a.saveLocalStateBackup;
    delete b.saveLocalStateBackup;
    assert.equal(await a.flushStateUpload(), false);
    assert.equal(await b.flushStateUpload(), false);
    assert.equal(JSON.parse(values.get(a.getStateBackupKey())).state.layers[0].dataURL, "A");
    assert.equal(JSON.parse(values.get(b.getStateBackupKey())).state.layers[0].dataURL, "B");
    assert.ok(values.has(legacy));
});

test("only acknowledged backups are pruned; oversize and quota failures retain drafts", async () => {
    const values = backupStorage();
    const a = writableWidget("A"), b = writableWidget("B");
    b.stateCacheId = "canvas_B";
    delete a.saveLocalStateBackup;
    delete b.saveLocalStateBackup;
    context.fetch = async () => ({ ok: true, json: async () => ({ status: "ok" }) });
    await a.flushStateUpload();
    assert.equal(JSON.parse(values.get(a.getStateBackupKey())).confirmed, true);
    b.saveLocalStateBackup(b.buildSerializedState());
    assert.equal(values.has(a.getStateBackupKey()), false);
    const draft = values.get(b.getStateBackupKey());
    context.LOCAL_STATE_BACKUP_MAX_CHARS = 1;
    b.saveLocalStateBackup(b.buildSerializedState());
    assert.equal(values.get(b.getStateBackupKey()), draft);
    b.localStateBackupDisabled = false;
    context.LOCAL_STATE_BACKUP_MAX_CHARS = 10000;
    context.window.localStorage.setItem = () => { throw new Error("quota"); };
    b.saveLocalStateBackup({ ...b.buildSerializedState(), bbox: { x: 99 } });
    assert.equal(values.get(b.getStateBackupKey()), draft);
});

test("an old upload acknowledgement cannot confirm a newer local draft", async () => {
    const values = backupStorage();
    const w = writableWidget("A");
    delete w.saveLocalStateBackup;
    let finish;
    context.fetch = async () => new Promise(resolve => { finish = resolve; });
    const pending = w.flushStateUpload();
    await Promise.resolve();
    w.pixels = "B";
    w.saveLocalStateBackup(w.buildSerializedState());
    finish({ ok: true, json: async () => ({ status: "ok" }) });
    await pending;
    const backup = JSON.parse(values.get(w.getStateBackupKey()));
    assert.equal(backup.state.layers[0].dataURL, "B");
    assert.equal(backup.confirmed, false);
});

test("two standalone tabs keep both edits by saving a conflicting tab as a durable draft", async () => {
    const id = "vnccs_unicanvas_standalone_tab";
    const stored = new Map([[id, { revision: 12, state: { ...base, state_id: id, layers: [] } }]]);
    context.fetch = async (_url, request) => {
        const entry = JSON.parse(request.body), previous = stored.get(entry.state_id);
        if (entry.base_revision !== (previous?.revision ?? -1)) {
            return { ok: false, status: 409, json: async () => ({ error: "Canvas changed in another tab" }) };
        }
        stored.set(entry.state_id, entry);
        return { ok: true, json: async () => ({ status: "ok" }) };
    };
    const a = writableWidget("A"), b = writableWidget("B");
    for (const w of [a, b]) Object.assign(w, { standalone: true, stateCacheId: id, stateCacheRevision: 12 });
    assert.equal(await a.flushStateUpload(), true);
    assert.equal(await b.flushStateUpload(), true);
    assert.equal(stored.get(id).state.layers[0].dataURL, "A");
    assert.notEqual(b.getStateCacheId(), id);
    assert.equal(stored.get(b.getStateCacheId()).state.layers[0].dataURL, "B");
    b.pixels = "B2";
    assert.equal(await b.flushStateUpload(), true);
    assert.equal(stored.get(b.getStateCacheId()).state.layers[0].dataURL, "B2");
    assert.equal(stored.get(id).state.layers[0].dataURL, "A");
});

test("queued standalone saves use each acknowledgement, including the closing save", async () => {
    const w = writableWidget("A");
    Object.assign(w, { standalone: true, stateCacheId: "vnccs_unicanvas_standalone_tab", stateCacheRevision: 12 });
    const sent = [];
    let finish;
    context.fetch = async (_url, request) => {
        sent.push(JSON.parse(request.body));
        if (sent.length === 1) await new Promise(resolve => { finish = resolve; });
        return { ok: true, json: async () => ({ status: "ok" }) };
    };
    const first = w.flushStateUpload();
    await Promise.resolve();
    w.pixels = "B";
    const closing = w.flushStateUpload(true);
    assert.equal(sent.length, 1);
    finish();
    assert.deepEqual(await Promise.all([first, closing]), [true, true]);
    assert.equal(sent[0].base_revision, 12);
    assert.equal(sent[1].base_revision, sent[0].revision);
    assert.equal(sent[1].state.layers[0].dataURL, "B");
});

test("a conflict draft acknowledgement cannot replace a reconfigured standalone document", async () => {
    const w = writableWidget("A");
    Object.assign(w, { standalone: true, stateCacheId: "vnccs_unicanvas_standalone_tab", stateCacheRevision: 12 });
    let finish, sent = 0;
    context.fetch = async () => {
        if (++sent === 1) return { ok: false, status: 409 };
        return new Promise(resolve => { finish = resolve; });
    };
    const pending = w.flushStateUpload();
    while (!finish) await Promise.resolve();
    w._stateLoadRevision = 1;
    w.stateCacheId = "vnccs_unicanvas_standalone_replacement";
    const replacement = JSON.stringify({ ...base, state_id: w.stateCacheId });
    w.node.widgets[0].value = replacement;
    finish({ ok: true, json: async () => ({ status: "ok" }) });
    assert.equal(await pending, true);
    assert.equal(w.node.widgets[0].value, replacement);
});

test("failed frozen uploads retain the confirmed workflow and retry the same draft ID", async () => {
    context.fetch = async () => ({ ok: true });
    const w = writableWidget();
    await w.snapshotForWorkflow();
    const confirmed = w.node.widgets[0].value;
    w.pixels = "blue";
    w.bbox = { x: 42 };
    w.syncToNode();
    assert.notEqual(w.node.widgets[0].value, confirmed, "live metadata changed before the cache was forked");
    context.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: "disk full" }) });
    assert.equal(await w.snapshotForWorkflow(), false);
    const draftId = w.stateCacheId;
    assert.notEqual(draftId, JSON.parse(confirmed).state_id);
    w.syncToNode();
    w.writeLightStateToWidget();
    assert.equal(w.node.widgets[0].value, confirmed);
    context.fetch = async () => ({ ok: true });
    assert.equal(await w.snapshotForWorkflow(), true);
    assert.equal(w.stateCacheId, draftId);
    assert.equal(JSON.parse(w.node.widgets[0].value).state_id, draftId);
    assert.equal(JSON.parse(w.node.widgets[0].value).layers[0].dataURL, null);
});

test("invalid JSON and unsupported schemas preserve original workflow bytes and block saving", async () => {
    for (const raw of ['{"version":2,"layers":[', JSON.stringify({ version: 99, layers: [{ id: "authored" }] })]) {
        const w = writableWidget();
        w.node.widgets[0].value = raw;
        await w._loadFromNode();
        assert.equal(w._stateRestoreFailed, true);
        w.syncToNode();
        w.writeLightStateToWidget();
        assert.equal(await w.snapshotForWorkflow(), false);
        assert.equal(w.node.widgets[0].value, raw);
    }
});

test("a pending upload cannot publish into a reconfigured widget", async () => {
    const w = writableWidget();
    context.fetch = async () => ({ ok: true });
    await w.snapshotForWorkflow();
    w.pixels = "blue";
    let finish;
    context.fetch = async () => new Promise(resolve => { finish = resolve; });
    const pending = w.flushStateUpload();
    await Promise.resolve();
    w._stateLoadRevision = (w._stateLoadRevision || 0) + 1;
    const replacement = JSON.stringify({ ...base, state_id: "another-workflow", layers: [] });
    w.node.widgets[0].value = replacement;
    finish({ ok: true });
    assert.equal(await pending, true);
    assert.equal(w.node.widgets[0].value, replacement);
});

test("stale server acknowledgements cannot publish a pending cache or clear a newer canvas", async () => {
    const w = writableWidget();
    context.fetch = async () => ({ ok: true });
    await w.snapshotForWorkflow();
    const confirmed = w.node.widgets[0].value;
    w.pixels = "blue";
    context.fetch = async () => ({ ok: true, json: async () => ({ status: "stale_ignored" }) });
    assert.equal(await w.flushStateUpload(), false);
    assert.equal(w.node.widgets[0].value, confirmed);
    await assert.rejects(w.clearStateCache(), /newer canvas/);
    assert.equal(w.node.widgets[0].value, confirmed);
});

test("saved workflows keep their pixels after later autosaves and reopening in another tab", async () => {
    const stored = new Map();
    context.fetch = async (url, request) => {
        if (request) {
            const entry = JSON.parse(request.body);
            stored.set(entry.state_id, entry.state);
            return { ok: true };
        }
        return { ok: true, json: async () => ({ state: stored.get(url.split("/").at(-1)) }) };
    };
    const w = writableWidget();
    await w.snapshotForWorkflow();
    const savedA = w.node.widgets[0].value;
    await w.snapshotForWorkflow();
    assert.equal(w.node.widgets[0].value, savedA, "unchanged saves reuse the snapshot");
    assert.equal(stored.size, 2, "unchanged saves keep one layer snapshot and one bbox snapshot");
    w.pixels = "blue";
    await w.flushStateUpload();
    await w.snapshotForWorkflow();
    const savedB = w.node.widgets[0].value;
    assert.notEqual(JSON.parse(savedA).state_id, JSON.parse(savedB).state_id);
    assert.equal(stored.get(JSON.parse(savedA).state_id).layers[0].dataURL, "red");
    assert.equal(stored.get(JSON.parse(savedB).state_id).layers[0].dataURL, "blue");
    assert.equal(stored.get(JSON.parse(savedA).output_id).layers[0].dataURL, "red");
    assert.equal(stored.get(JSON.parse(savedB).output_id).layers[0].dataURL, "blue");
    const otherTab = widget(JSON.parse(savedA));
    await otherTab._loadFromNode();
    assert.equal(otherTab.restored.layers[0].dataURL, "red");
    delete otherTab.uploadStatePayload;
    otherTab.saveLocalStateBackup = () => {};
    await otherTab.uploadStatePayload({ ...otherTab.restored, layers: [{ id: "image", dataURL: "green" }] });
    assert.notEqual(otherTab.stateCacheId, JSON.parse(savedA).state_id);
    assert.equal(stored.get(JSON.parse(savedA).state_id).layers[0].dataURL, "red");
});

test("queued uploads capture the cache ID and geometry before later edits fork it", async () => {
    const sent = [];
    let finish;
    context.fetch = async (_url, request) => {
        sent.push(JSON.parse(request.body));
        if (sent.length === 1) await new Promise(resolve => { finish = resolve; });
        return { ok: true };
    };
    const w = writableWidget();
    const first = w.snapshotForWorkflow();
    const firstId = JSON.parse(w.node.widgets[0].value).state_id;
    w.pixels = "blue";
    w.bbox.x = 42;
    const second = w.snapshotForWorkflow();
    const secondId = w.stateCacheId;
    assert.notEqual(firstId, secondId);
    assert.equal(JSON.parse(w.node.widgets[0].value).state_id, firstId, "pending copies keep the confirmed workflow pointer");
    await Promise.resolve();
    finish();
    await Promise.all([first, second]);
    assert.deepEqual(sent.filter(entry => !entry.state_id.endsWith("_out")).map(entry => [entry.state_id, entry.state.bbox.x, entry.state.layers[0].dataURL]),
        [[firstId, 0, "red"], [secondId, 42, "blue"]]);
    assert.deepEqual(sent.filter(entry => entry.state_id.endsWith("_out")).map(entry => [entry.state_id, entry.state.layers[0].dataURL]),
        [[`${firstId}_out`, "red"], [`${secondId}_out`, "blue"]]);
});

test("the serialize hook keeps a confirmed snapshot until acknowledgement and preserves the previous callback", async () => {
    const w = writableWidget();
    context.fetch = async () => ({ ok: true });
    await w.snapshotForWorkflow();
    const stale = w.node.widgets[0].value;
    w.pixels = "blue";
    let previousCalled = false;
    const nodeType = { prototype: { onSerialize(output) {
        previousCalled = true;
        assert.equal(this, w.node);
        assert.equal(output.widgets_values[0], stale);
    } } };
    const start = source.indexOf("    const onSerialize = nodeType.prototype.onSerialize;");
    const end = source.indexOf("    const onRemoved =", start);
    vm.runInNewContext(source.slice(start, end), { nodeType });
    const output = { widgets_values: [stale, "unrelated"] };
    nodeType.prototype.onSerialize.call(w.node, output);
    assert.equal(previousCalled, true);
    assert.equal(output.widgets_values[1], "unrelated");
    assert.equal(JSON.parse(output.widgets_values[0]).layers[0].dataURL, null, "saved workflow stays compact");
    await w.stateUploadPromise;
    assert.notEqual(JSON.parse(w.node.widgets[0].value).state_id, JSON.parse(stale).state_id);
    assert.equal(JSON.parse(w.node.widgets[0].value).layers[0].dataURL, null);
});

test("a stale output acknowledgement stops queueing and never suppresses a retry", async () => {
    const w = writableWidget();
    let uploads = 0;
    context.fetch = async () => { uploads++; return { ok: true, json: async () => ({ status: "stale_ignored" }) }; };
    const statuses = [];
    Object.assign(w, { setStatus: message => statuses.push(message), flushStateUpload: async () => true,
                      syncToNode() {}, layers: [] });
    await assert.rejects(w.preparePanoramaForQueue(), /output could not be sent/);
    assert.equal(w.lastUploadedOutputJSON, undefined);
    assert.equal(w.outputUploadsPending, 0);
    assert.match(statuses.at(-1), /newer canvas/);
    context.fetch = async () => { uploads++; return { ok: true, json: async () => ({ status: "ok" }) }; };
    assert.equal(await w.uploadOutputSnapshot(), true);
    assert.equal(uploads, 2);
    assert.ok(w.lastUploadedOutputJSON);
});

test("unchanged bbox output is deduplicated only after pending writes have settled", async () => {
    const sent = [];
    let finish;
    context.fetch = async (_url, request) => {
        const entry = JSON.parse(request.body);
        sent.push(entry.state.layers[0].dataURL);
        if (entry.state.layers[0].dataURL === "blue") await new Promise(resolve => { finish = resolve; });
        return { ok: true };
    };
    const w = writableWidget();
    await w.uploadOutputSnapshot();
    await w.uploadOutputSnapshot();
    assert.deepEqual(sent, ["red"]);
    w.pixels = "blue";
    const pending = w.uploadOutputSnapshot();
    w.pixels = "red";
    await w.uploadOutputSnapshot();
    assert.deepEqual(sent, ["red", "blue", "red"], "an earlier acknowledged output cannot hide an outstanding different write");
    finish(); await pending;
    await w.uploadOutputSnapshot();
    assert.deepEqual(sent, ["red", "blue", "red"]);
    assert.equal(w.outputUploadsPending, 0);
});
