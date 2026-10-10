import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { applyCanvasDocument, createCanvasDocument, deleteCanvasDocument, ensureCanvasDocument, installCanvasDocuments, openCanvasDocument, openCanvasManager } from '../web/unicanvas/documents.mjs';
import { normalizePanorama } from '../web/unicanvas/panorama.mjs';
import { normalizeTransformMode } from '../web/unicanvas/transform.mjs';
import { serializePose } from '../web/unicanvas/pose_state.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const ROOT = '/vnccs/unicanvas/documents';
function setup() {
    const states = new Map(), documents = new Map(), calls = [];
    let next = 0, active = null;
    const state = (id, pixels, extra = {}) => ({ version: 2, state_id: id, storage: 'server_cache',
        origin: { x: 1, y: 2 }, size: { width: 32, height: 32 }, bbox: { x: 3, y: 4, width: 8, height: 8 },
        settings: { positive: pixels, edit_reference_images: [pixels + '-ref'] },
        layers: [{ id: id + '-layer', type: 'raster', dataURL: pixels }], ...extra });
    const register = (id, name) => {
        const canvas_id = String(++next).padStart(32, '0');
        const doc = { canvas_id, state_id: id, name, layer_count: states.get(id).layers.length };
        documents.set(canvas_id, doc); return doc;
    };
    states.set('a', state('a', 'A'));
    states.set('b', state('b', 'B', { panorama: { width: 4096, yaw: 90 } }));
    const a = register('a', 'Canvas A'), b = register('b', 'Canvas B');
    const respond = (data, status = 200) => ({ ok: status < 400, status, json: async () => clone(data) });
    globalThis.fetch = async (url, options = {}) => {
        const method = options.method || 'GET', body = options.body && JSON.parse(options.body);
        calls.push({ url, method, body });
        if (url.startsWith('/vnccs/unicanvas_state/')) {
            const saved = states.get(url.split('/').at(-1));
            return saved ? respond({ state: saved, revision: 10 }) : respond({ error: 'missing' }, 404);
        }
        if (url === '/vnccs/unicanvas_state_upload') { states.set(body.state_id, clone(body.state)); return respond({ status: 'ok' }); }
        if (url === ROOT && method === 'GET') return respond({ documents: [...documents.values()], active_canvas_id: active });
        if (url === ROOT && method === 'POST') {
            const doc = [...documents.values()].find(doc => doc.state_id === body.state_id) || register(body.state_id, body.name || 'Untitled canvas');
            return respond({ document: doc });
        }
        if (url === ROOT + '/active') { active = body.canvas_id; return respond({ active_canvas_id: active }); }
        const id = url.slice(ROOT.length + 1), doc = documents.get(id);
        if (!doc) return respond({ error: 'missing document' }, 404);
        if (method === 'DELETE') { documents.delete(id); return respond({ status: 'ok' }); }
        if (method === 'PATCH') {
            if (body.expected_state_id !== doc.state_id) return respond({ error: 'stale canvas' }, 409);
            doc.name = body.name;
        }
        return respond({ document: doc });
    };
    const w = {
        canvasId: a.canvas_id, _canvasPublishedStateId: 'a', stateCacheId: 'a', _stateLoadRevision: 1,
        ...clone(states.get('a')), view: { x: 10, y: 20, scale: 2 }, undoStack: [{ id: 'undo-a' }], redoStack: [],
        stagingItems: [], standalone: true, _disposed: false,
        get editingBlocked() { return Boolean(this._generationLocked || this._canvasOperation); },
        getStateCacheId() { return this.stateCacheId; }, syncInteractionLock() {},
        async flushStateUpload() { calls.push({ save: this.stateCacheId }); states.set(this.stateCacheId, this.snapshot()); return true; },
        snapshot() { return { ...state(this.stateCacheId, ''), settings: clone(this.settings), layers: clone(this.layers), panorama: this.panorama }; },
        async applySerializedState(value, options) { assert.equal(options.replaceDocument, true); Object.assign(this, clone(value)); return true; },
        stateHasMissingLayerPixels(value) { return value.layers.some(layer => layer.cached && !layer.dataURL); },
        syncToNode() { this.workflow = this.snapshot(); }, persistCanvasPointer() { this.pointer = this.canvasId; },
        setStatus(message, error) { this.status = { textContent: message }; this.error = error; },
        promptInWidget: async () => 'New document', confirmInWidget: async () => true,
        fitInitialView() { this.view = { x: 0, y: 0, scale: 1 }; },
        createEmptyCanvasState() { return state('new-' + next, null, { layers: [], settings: { positive: '', edit_reference_images: [] } }); },
    };
    return { w, a, b, states, documents, calls };
}

function mountControls(t, w) {
    const previousDocument = globalThis.document;
    t.after(() => { globalThis.document = previousDocument; });
    class Element {
        constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.scrollTop = 0;
            this.classList = { toggle() {} }; }
        append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
        replaceChildren(...children) { this.children = []; this.append(...children); }
        remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
        setAttribute(name, value) { this.attributes[name] = value; }
        addEventListener() {}
        focus() { globalThis.document.activeElement = this; }
        get isConnected() { return this.root || Boolean(this.parent?.isConnected); }
    }
    const head = new Element('head'); head.root = true;
    globalThis.document = { createElement: tag => new Element(tag), head, getElementById: id => head.children.find(child => child.id === id) };
    w.container = new Element('div'); w.container.root = true;
    w.settingsBar = new Element('div'); w.container.append(w.settingsBar);
    w._button = (label, className, click, title) => Object.assign(new Element('button'), { label, className, click, title });
    const elements = root => [root, ...root.children.flatMap(elements)];
    return { find: className => elements(w.container).find(element => element.className?.split(' ').includes(className)) };
}

test('the centered toolbar contains the manager followed by one accessible New icon, and creates a named canvas', async t => {
    const { w, documents, calls } = setup();
    const { find } = mountControls(t, w);
    installCanvasDocuments(w);
    const actions = find('vnccs-uc-canvas-actions');
    assert.equal(actions.parent, w.settingsBar);
    assert.equal(actions.children[0].label, 'Canvases');
    const create = actions.children[1];
    assert.match(create.label, /^<svg.*aria-hidden="true"/);
    assert.equal(create.attributes['aria-label'], 'New canvas');
    assert.equal(create.title, 'New canvas');
    w.promptInWidget = async (title, label, initial) => {
        assert.deepEqual([title, label, initial], ['New canvas', 'Canvas name', 'Untitled canvas']);
        return 'My drawing';
    };
    assert.equal(await create.click(), true);
    assert.equal(documents.get(w.canvasId).name, 'My drawing');
    const before = calls.length;
    w._generationLocked = true;
    w.promptInWidget = () => assert.fail('No naming dialog during generation');
    assert.equal(await create.click(), false);
    await actions.children[0].click();
    assert.equal(calls.length, before);
    assert.equal(find('vnccs-uc-canvas-manager'), undefined);
});

test('manager displays disk usage and renames a canvas without losing its identity or list position', async t => {
    const { w, a, documents } = setup();
    Object.assign(a, { cache_bytes: 5 * 1024 ** 2, current_cache_bytes: 1024, snapshot_count: 3 });
    const { find } = mountControls(t, w);
    await openCanvasManager(w);
    const list = find('vnccs-uc-canvas-list');
    const row = list.children[0], details = row.children[0].children[1];
    assert.match(details.textContent, /Cache: 5\.0 MiB/);
    assert.match(details.title, /Current snapshot: 1\.0 KiB\. Saved snapshots: 3\./);
    list.scrollTop = 63;
    w.promptInWidget = async (title, label, initial) => {
        assert.deepEqual([title, label, initial], ['Rename canvas', 'Canvas name', 'Canvas A']);
        return 'Landscape';
    };
    await row.children.find(button => button.label === 'Rename').click();
    assert.equal(documents.get(a.canvas_id).name, 'Landscape');
    assert.equal(list.children[0].children[0].children[0].textContent, 'Landscape');
    assert.equal(w.canvasId, a.canvas_id);
    assert.equal(w.stateCacheId, 'a');
    assert.equal(list.scrollTop, 63);
});

test('manager formats byte sizes and does not present unavailable metadata as an empty cache', async t => {
    const { w, a } = setup();
    const { find } = mountControls(t, w);
    for (const [bytes, label] of [[0, '0 B'], [128, '128 B'], [1024, '1.0 KiB'], [1024 ** 3, '1.0 GiB'], [undefined, 'Unavailable'], [-1, 'Unavailable']]) {
        a.cache_bytes = bytes;
        await openCanvasManager(w);
        const list = find('vnccs-uc-canvas-list');
        assert.ok(list.children[0].children[0].children[1].textContent.includes(`Cache: ${label}`));
        find('vnccs-uc-modal-overlay').remove();
    }
});

test('A/B/A preserves pixels, references, panorama, independent history and viewport', async () => {
    const { w, a, b, states } = setup();
    w.layers[0].dataURL = 'edited A';
    assert.equal(await openCanvasDocument(w, b), true);
    assert.equal(w.stateCacheId, 'b');
    assert.equal(w.layers[0].dataURL, 'B');
    assert.equal(w.panorama.yaw, 90);
    assert.deepEqual(w.settings.edit_reference_images, ['B-ref']);
    assert.deepEqual(w.undoStack, []);
    w.undoStack.push({ id: 'undo-b' }); w.view = { x: 50, y: 60, scale: .5 };
    assert.equal(await openCanvasDocument(w, a), true);
    assert.equal(w.layers[0].dataURL, 'edited A');
    assert.deepEqual(w.settings.edit_reference_images, ['A-ref']);
    assert.deepEqual(w.undoStack, [{ id: 'undo-a' }]);
    assert.deepEqual(w.view, { x: 10, y: 20, scale: 2 });
    assert.equal(await openCanvasDocument(w, b), true);
    assert.deepEqual(w.undoStack, [{ id: 'undo-b' }]);
    assert.deepEqual(w.view, { x: 50, y: 60, scale: .5 });
    assert.equal(states.get('a').layers[0].dataURL, 'edited A');
});

test('New canvas saves the previous document and creates an independent empty cache', async () => {
    const { w, states, documents, calls } = setup();
    w.layers[0].dataURL = 'last edit';
    assert.equal(await createCanvasDocument(w), true);
    assert.notEqual(w.stateCacheId, 'a');
    assert.equal(w.layers.length, 0);
    assert.equal(states.get('a').layers[0].dataURL, 'last edit');
    assert.equal(documents.size, 3);
    assert.deepEqual(w.undoStack, []);
    assert.equal(calls.some(call => call.url === '/vnccs/unicanvas_state_delete'), false);
    assert.ok(calls.findIndex(call => call.save === 'a') < calls.findIndex(call => call.url === '/vnccs/unicanvas_state_upload'));
});

test('staging needs explicit discard confirmation and never enters durable state', async () => {
    const { w, b, states } = setup();
    w.stagingItems = [{ image: 'unaccepted' }]; w.activeStagingIndex = 0;
    let confirmations = 0;
    w.confirmInWidget = async () => { confirmations++; return false; };
    assert.equal(await openCanvasDocument(w, b), false);
    assert.equal(w.stateCacheId, 'a');
    assert.equal(w.stagingItems.length, 1);
    assert.equal(confirmations, 1);
    w.confirmInWidget = async () => true;
    assert.equal(await openCanvasDocument(w, b), true);
    assert.equal(w.stagingItems.length, 0);
    assert.equal(JSON.stringify(states.get('a')).includes('unaccepted'), false);
});

test('failed save, target fetch or restoration retain the current document and history', async () => {
    for (const failure of ['save', 'fetch', 'restore']) {
        const { w, b, states } = setup();
        const layers = w.layers, history = w.undoStack;
        if (failure === 'save') w.flushStateUpload = async () => false;
        if (failure === 'fetch') states.delete('b');
        if (failure === 'restore') w.applySerializedState = async () => false;
        assert.equal(await openCanvasDocument(w, b), false, failure);
        assert.equal(w.stateCacheId, 'a', failure);
        assert.equal(w.canvasId, '00000000000000000000000000000001', failure);
        assert.equal(w.layers, layers, failure);
        assert.equal(w.undoStack, history, failure);
        assert.equal(w._canvasOperation, false);
        assert.equal(w.error, true);
    }
});

test('generation blocks create/open/delete before prompts and any requests', async () => {
    const { w, b, calls } = setup();
    w._generationLocked = true;
    w.promptInWidget = w.confirmInWidget = () => assert.fail('A locked editor cannot open a dialog');
    assert.equal(await createCanvasDocument(w), false);
    assert.equal(await openCanvasDocument(w, b), false);
    assert.equal(await deleteCanvasDocument(w, b), false);
    assert.deepEqual(calls, []);
});

test('deleting the active canvas opens another and retains both workflow snapshot caches', async () => {
    const { w, a, b, states, documents, calls } = setup();
    assert.equal(await deleteCanvasDocument(w, a), true);
    assert.equal(w.canvasId, b.canvas_id);
    assert.equal(documents.has(a.canvas_id), false);
    assert.equal(states.get('a').layers[0].dataURL, 'A');
    assert.equal(states.get('b').layers[0].dataURL, 'B');
    const deleted = calls.find(call => call.method === 'DELETE');
    assert.equal(deleted.body.expected_state_id, 'a');
});

test('a late target fetch cannot replace a newly configured canvas', async () => {
    const { w, b } = setup();
    let finish;
    globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
    const pending = applyCanvasDocument(w, b);
    w._stateLoadRevision++;
    w.stateCacheId = 'configured';
    finish({ ok: true, json: async () => ({ state: { version: 2, layers: [] } }) });
    assert.equal(await pending, false);
    assert.equal(w.stateCacheId, 'configured');
});

test('a stale registration cannot publish into another configured document', async () => {
    const { w } = setup();
    w.canvasId = null;
    let finish;
    globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
    const pending = ensureCanvasDocument(w);
    await new Promise(resolve => setImmediate(resolve));
    w._stateLoadRevision++; w.canvasId = 'configured';
    finish({ ok: true, json: async () => ({ document: { canvas_id: 'stale', state_id: 'a' } }) });
    await assert.rejects(pending, /changed while saving/);
    assert.equal(w.canvasId, 'configured');
});

const source = readFileSync(new URL('../web/vnccs_unicanvas.js', import.meta.url), 'utf8');
let nextLayerId = 0;
const context = { console, clearTimeout, normalizePanorama, normalizeTransformMode, serializePose,
    uid: () => `layer-${++nextLayerId}`, HISTORY_LIMIT: 20, DEFAULT_SEED_MODE: 'randomize',
    STAGE_SCALE_FACTOR: 0.999, STAGE_MIN_SCALE: 0.1, STAGE_MAX_SCALE: 20,
    STAGE_SNAP_POINTS: [0.5, 1, 2], STAGE_SNAP_TOLERANCE: 0.02,
    window: { performance, setTimeout, clearTimeout },
    makeDefaultUniCanvasSettings: () => ({ positive: '', seed_mode: 'randomize', edit_reference_images: [] }) };
const prototype = vm.runInNewContext(source.slice(source.indexOf('class UniCanvasWidget {'), source.indexOf('\napp.registerExtension(')) + '\nUniCanvasWidget.prototype', context);

function interactionWidget() {
    const setupResult = setup(), { w, states } = setupResult;
    class Canvas {
        constructor(pixels = null) { this.width = this.height = 32; this.pixels = pixels; }
        getContext() { return { clearRect: () => { this.pixels = null; }, drawImage: image => { this.pixels = image.pixels; } }; }
    }
    Object.setPrototypeOf(w, prototype);
    delete w.applySerializedState;
    w.layers = w.layers.map(layer => ({ ...layer, canvas: new Canvas(layer.dataURL) }));
    w.activeLayerId = w.layers[0].id;
    Object.assign(w, { tool: 'move', undoStack: [], intendedScale: w.view.scale, activeSnapPoint: null,
        snapTimeout: null, lastScrollEventTimestamp: null,
        _createCanvas: () => new Canvas(), loadImage: async pixels => ({ pixels }),
        cloneCanvasCrop: surface => new Canvas(surface.pixels), configureImageContext: value => value,
        getLayerAlphaBounds: layer => layer.canvas.pixels ? { x: 0, y: 0, width: 32, height: 32 } : null,
        loadLocalStateBackup: () => null,
        canvasPointFromEvent: () => ({ x: 40, y: 40 }), getStageViewportSize: () => ({ width: 100, height: 100 }),
        fitInitialView() { this.view = { x: 0, y: 0, scale: 0.5 }; this.intendedScale = 0.5; },
        setTool(tool) { this.tool = tool; },
        snapshot() { return { version: 2, origin: this.origin, size: this.size, bbox: this.bbox, settings: clone(this.settings),
            activeLayerId: this.activeLayerId, layers: this.layers.map(layer => ({ id: layer.id, type: layer.type,
                dataURL: layer.canvas.pixels, crop: this.getLayerAlphaBounds(layer), cached: false })) }; },
    });
    for (const name of ['cancelDeferredCanvasCommit', 'sanitizeMaskLayer', 'saveLocalStateBackup', 'clearSamPrompt',
        'syncPromptControls', 'updateSnapButton', 'updatePanoramaControls', 'renderLayerList', 'updateHistoryButtons',
        'syncActiveLayerControls', 'syncPoseToolToActiveLayer', 'requestRender', 'syncLightStateToWidget', 'scheduleFullSync']) w[name] = () => {};
    w.normalizeLayerOrder();
    states.get('b').panorama = null;
    return setupResult;
}

for (const kind of ['addLayer', 'acceptStaging']) {
    for (const undone of [false, true]) {
        test(`A/B/A preserves ${kind} pixels through Undo/Redo (${undone ? 'already undone' : 'painted'})`, async () => {
            const { w, a, b } = interactionWidget();
            const previousActiveLayerId = w.activeLayerId;
            const layer = w.addLayer('raster', 'New layer', kind === 'addLayer', true);
            const originalPixels = kind === 'acceptStaging' ? 'accepted result' : null;
            layer.canvas.pixels = originalPixels;
            if (kind === 'acceptStaging') w.pushHistoryEntry({ kind, layer, previousActiveLayerId, stagingItems: [] });
            const before = w.createLayerPixelSnapshot(layer);
            layer.canvas.pixels = 'painted'; w.invalidateLayerCaches(layer);
            w.pushHistoryEntry({ kind: 'layerPixels', layerId: layer.id, before, after: w.createLayerPixelSnapshot(layer) });
            if (undone) { w.undo(); w.undo(); }
            assert.equal(await openCanvasDocument(w, b), true);
            assert.equal(await openCanvasDocument(w, a), true);
            if (!undone) {
                assert.notEqual(w.layers.find(item => item.id === layer.id), layer, 'restoration creates a fresh layer object');
                w.undo();
                assert.equal(w.layers.find(item => item.id === layer.id).canvas.pixels, originalPixels);
                w.undo();
            }
            assert.equal(w.layers.some(item => item.id === layer.id), false);
            w.redo();
            assert.equal(w.layers.find(item => item.id === layer.id).canvas.pixels, originalPixels, 'Redo addition cannot redo painting');
            w.redo();
            assert.equal(w.layers.find(item => item.id === layer.id).canvas.pixels, 'painted');
        });
    }
}

test('A/B/A restores the wheel zoom origin and clears the previous document snap state', async t => {
    const { w, a, b } = interactionWidget();
    t.after(() => clearTimeout(w.snapTimeout));
    assert.equal(await openCanvasDocument(w, b), true);
    w.activeSnapPoint = 0.5;
    w.snapTimeout = setTimeout(() => assert.fail('The previous document zoom timer must be cancelled'), 50);
    assert.equal(await openCanvasDocument(w, a), true);
    assert.equal(w.view.scale, 2);
    assert.equal(w.intendedScale, 2);
    assert.equal(w.activeSnapPoint, null);
    assert.equal(w.snapTimeout, null);
    w.onWheel({ deltaY: -100, preventDefault() {}, stopPropagation() {} });
    assert.ok(w.view.scale > 2 && w.view.scale < 2.2, 'zoom-in must start from the restored 200% view');
    assert.ok(w.view.x < 10 && w.view.y < 20, 'zoom stays anchored to the wheel pointer');
});

test('document replacement clears empty layers and settings from the previous canvas', async () => {
    const w = Object.assign(Object.create(prototype), { layers: [{ id: 'old' }], settings: { positive: 'old', edit_reference_images: ['old-ref'] },
        origin: {}, size: {}, bbox: {}, loadLocalStateBackup: () => null, setStatus() {},
        getLayerAlphaBounds: () => null });
    for (const name of ['normalizeLayerOrder', 'applySeedModeDefault', 'saveLocalStateBackup', 'syncPromptControls', 'updateSnapButton', 'updatePanoramaControls', 'renderLayerList']) w[name] = () => {};
    assert.equal(await w.applySerializedState({ version: 2, layers: [], settings: { positive: 'new' } }, { replaceDocument: true }), true);
    assert.equal(w.layers.length, 0);
    assert.equal(w.activeLayerId, null);
    assert.equal(w.settings.positive, 'new');
    assert.deepEqual(clone(w.settings.edit_reference_images), []);
});

test('production serialization excludes transient staging and history', () => {
    const w = Object.assign(Object.create(prototype), { stateCacheId: 'doc', canvasId: 'owned',
        layers: [{ id: 'accepted' }], serializeLayer: layer => clone(layer), settings: { positive: 'saved' },
        stagingItems: [{ image: 'unaccepted' }], activeStagingIndex: 0, undoStack: [{ staging: 'undo-only' }], redoStack: [], view: { x: 99 } });
    const saved = w.buildSerializedState(true);
    assert.equal(saved.canvas_id, 'owned');
    assert.equal(saved.state_id, 'doc');
    assert.equal(saved.output_id, 'doc_out');
    assert.equal(JSON.stringify(saved).includes('unaccepted'), false);
    for (const field of ['stagingItems', 'activeStagingIndex', 'undoStack', 'redoStack', 'view']) assert.equal(field in saved, false);
});

test('a fully serialized empty base layer replaces painted pixels without metadata fallback', async () => {
    const w = Object.assign(Object.create(prototype), { layers: [{ id: 'painted' }], settings: {}, origin: {}, size: { width: 4, height: 4 }, bbox: {},
        loadLocalStateBackup: () => null, getLayerAlphaBounds: () => ({ width: 4, height: 4 }),
        _createCanvas: () => ({ blank: true }), setStatus() {} });
    for (const name of ['sanitizeMaskLayer', 'normalizeLayerOrder', 'applySeedModeDefault', 'saveLocalStateBackup', 'syncPromptControls', 'updateSnapButton', 'updatePanoramaControls', 'renderLayerList']) w[name] = () => {};
    const saved = { version: 2, layers: [{ id: 'base', type: 'raster', dataURL: null, crop: null }], settings: { positive: '' } };
    assert.equal(await w.applySerializedState(saved, { replaceDocument: true }), true);
    assert.equal(w.layers[0].id, 'base');
    assert.equal(w.layers[0].canvas.blank, true);
});

test('managed standalone saves fork changed pixels and keep workflow snapshots immutable', async () => {
    const original = { version: 2, state_id: 'snapshot-a', output_id: 'snapshot-a_out', canvas_id: 'owned', layers: [{ id: 'layer', dataURL: 'A' }] };
    const states = new Map([['snapshot-a', clone(original)]]), sent = [];
    context.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body);
        sent.push(payload); states.set(payload.state_id, clone(payload.state));
        return { ok: true, json: async () => ({ status: 'ok' }) };
    };
    const w = Object.assign(Object.create(prototype), { standalone: true, stateCacheId: 'snapshot-a', canvasId: 'owned',
        _canvasPublishedStateId: 'snapshot-a', _stateLoadRevision: 1, stateCacheRevision: 10,
        _frozenStateJSON: JSON.stringify(original), createStateCacheId: () => 'snapshot-b',
        syncToNode() {}, setStatus() {}, saveLocalStateBackup() {}, confirmLocalStateBackup() {} });
    const edited = { ...clone(original), layers: [{ id: 'layer', dataURL: 'B' }] };
    assert.equal(await w.uploadStatePayload(edited), true);
    assert.equal(states.get('snapshot-a').layers[0].dataURL, 'A');
    assert.equal(states.get('snapshot-b').layers[0].dataURL, 'B');
    assert.equal(sent[0].canvas_base_state_id, 'snapshot-a');
    assert.equal(sent[0].base_revision, -1);
    assert.equal(w._canvasPublishedStateId, 'snapshot-b');
    assert.equal(w._pendingStateCacheId, null);
    assert.equal(JSON.parse(w._frozenStateJSON).state_id, 'snapshot-b');
});

test('rapid managed saves capture separate snapshots and advance one document in order', async () => {
    const original = { version: 2, state_id: 'a', output_id: 'a_out', canvas_id: 'owned', layers: [] };
    let finish, serial = 0;
    const sent = [];
    context.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body); sent.push(payload);
        if (sent.length === 1) await new Promise(resolve => { finish = resolve; });
        return { ok: true, json: async () => ({ status: 'ok' }) };
    };
    const w = Object.assign(Object.create(prototype), { standalone: true, stateCacheId: 'a', canvasId: 'owned',
        _canvasPublishedStateId: 'a', _stateLoadRevision: 1, stateCacheRevision: 10,
        _frozenStateJSON: JSON.stringify(original), createStateCacheId: () => 'copy-' + ++serial,
        syncToNode() {}, setStatus() {}, saveLocalStateBackup() {}, confirmLocalStateBackup() {} });
    const first = w.uploadStatePayload({ ...original, layers: [{ dataURL: 'first' }] });
    const second = w.uploadStatePayload({ ...original, state_id: w.stateCacheId, output_id: w.getOutputCacheId(), layers: [{ dataURL: 'second' }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, 1);
    finish();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.deepEqual(sent.map(item => item.state_id), ['copy-1', 'copy-2']);
    assert.deepEqual(sent.map(item => item.canvas_base_state_id), ['a', 'copy-1']);
    assert.equal(w.canvasId, 'owned');
    assert.equal(w._canvasPublishedStateId, 'copy-2');
});

test('explicit New canvas can recover from a failed restore without rewriting the damaged cache', async () => {
    const { w, states, calls } = setup();
    w._stateRestoreFailed = true;
    w.flushStateUpload = () => assert.fail('Failed restoration cannot upload blank pixels');
    const before = clone(states.get('a'));
    assert.equal(await createCanvasDocument(w), true);
    assert.deepEqual(states.get('a'), before);
    assert.equal(w._stateRestoreFailed, false);
    assert.equal(calls.some(call => call.save === 'a'), false);
});

test('an unchanged conflict recovery does not create another document on its next autosave', async () => {
    const state = { version: 2, state_id: 'a', output_id: 'a_out', canvas_id: 'old-doc', layers: [{ dataURL: 'edit' }] };
    let uploads = 0, registrations = 0;
    context.canvasRequest = async (path, method, body) => {
        if (!path) { registrations++; return { document: { canvas_id: 'recovered', state_id: body.state_id } }; }
        return {};
    };
    context.fetch = async () => {
        uploads++;
        return uploads === 1 ? { ok: false, status: 409 } : { ok: true, json: async () => ({ status: 'ok' }) };
    };
    const w = Object.assign(Object.create(prototype), { standalone: true, stateCacheId: 'a', canvasId: 'old-doc',
        _canvasPublishedStateId: 'a', _stateLoadRevision: 1, stateCacheRevision: 10,
        createStateCacheId: () => 'recovered-state', syncToNode() {}, setStatus() {}, saveLocalStateBackup() {}, confirmLocalStateBackup() {} });
    assert.equal(await w.uploadStatePayload(state), true);
    const recovered = JSON.parse(w._capturedStateJSON);
    assert.equal(recovered.canvas_id, 'recovered');
    assert.equal(await w.uploadStatePayload(recovered), true);
    assert.equal(uploads, 2, 'the identical acknowledged document is deduplicated');
    assert.equal(registrations, 1);
});

test('opening a remotely changed document keeps its new pixels and drops stale local history', async () => {
    const { w, a, b, states, documents } = setup();
    assert.equal(await openCanvasDocument(w, b), true);
    const remote = { ...clone(states.get('a')), state_id: 'a-remote', layers: [{ id: 'remote', dataURL: 'new remote pixels' }] };
    states.set('a-remote', remote);
    documents.set(a.canvas_id, { ...a, state_id: 'a-remote' });
    assert.equal(await openCanvasDocument(w, a), true);
    assert.equal(w.layers[0].dataURL, 'new remote pixels');
    assert.deepEqual(w.undoStack, []);
    assert.deepEqual(w.redoStack, []);
    assert.deepEqual(w.view, { x: 10, y: 20, scale: 2 });
});

for (const browserPointer of [{ server_selection: true }, { canvas_id: 'owned', state_id: 'retired' }]) {
    test(`standalone reload follows the latest durable canvas pointer (${browserPointer.server_selection ? 'no browser storage' : 'stale browser storage'})`, async () => {
        const cached = { version: 2, state_id: 'latest', layers: [{ dataURL: 'durable latest pixels' }] };
        context.canvasRequest = async path => path ? { document: { canvas_id: 'owned', state_id: 'latest' } }
            : { documents: [{ canvas_id: 'owned', state_id: 'latest' }], active_canvas_id: 'owned' };
        const reads = [];
        context.fetch = async url => { reads.push(url); return { ok: true, json: async () => ({ state: cached, revision: 7 }) }; };
        const w = Object.assign(Object.create(prototype), { standalone: true,
            node: { widgets: [{ name: 'unicanvas_state', value: JSON.stringify({ version: 2, storage: 'server_cache', layers: [], state_id: 'legacy', ...browserPointer }) }] },
            loadLocalStateBackup: () => null, setStatus() {},
            applySerializedState: async function (state) { this.restored = clone(state); return true; } });
        await w._loadFromNode();
        assert.deepEqual(reads, ['/vnccs/unicanvas_state/latest']);
        assert.equal(w.canvasId, 'owned');
        assert.equal(w.stateCacheId, 'latest');
        assert.equal(w.restored.layers[0].dataURL, 'durable latest pixels');
    });
}

for (const gesture of ['pointer', 'transform', 'pose']) {
    test(`document management cannot interrupt an unfinished ${gesture} edit`, async () => {
        const { w, b, calls } = setup();
        if (gesture === 'pointer') w.isPointerDown = true;
        if (gesture === 'transform') w.transformDraft = {};
        if (gesture === 'pose') w.poseEditor = { isGestureActive: () => true };
        w.promptInWidget = w.confirmInWidget = () => assert.fail('Finish the edit before opening dialogs');
        assert.equal(await createCanvasDocument(w), false);
        assert.equal(await openCanvasDocument(w, b), false);
        assert.equal(await deleteCanvasDocument(w, b), false);
        assert.deepEqual(calls, []);
        assert.equal(w.stateCacheId, 'a');
        assert.match(w.status.textContent, /Finish the current edit/);
    });
}

test('the manager can reopen the latest snapshot of a canvas changed remotely while active', async () => {
    const { w, a, states, documents } = setup();
    states.set('remote-latest', { ...clone(states.get('a')), state_id: 'remote-latest', layers: [{ dataURL: 'remote pixels' }] });
    const latest = { ...a, state_id: 'remote-latest' };
    documents.set(a.canvas_id, latest);
    assert.equal(await openCanvasDocument(w, latest), true);
    assert.equal(w.canvasId, a.canvas_id);
    assert.equal(w.layers[0].dataURL, 'remote pixels');
    assert.deepEqual(w.undoStack, []);
});
