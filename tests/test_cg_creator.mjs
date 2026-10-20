import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { FactoryCommandHistory } from "../web/factory3d/editor_commands.mjs";
import { clone, readState, settingsDefaults, frameDimensions, sourceCameraView, MODEL_DEFAULTS } from "../web/cg_creator/state.mjs";

const widgetSource = fs.readFileSync(new URL("../web/cg_creator/widget.mjs", import.meta.url), "utf8");
const entrySource = fs.readFileSync(new URL("../web/vnccs_cg_creator.js", import.meta.url), "utf8");
const BASE = "/vnccs/cg-creator";
const A = "a".repeat(32), B = "b".repeat(32), MODEL = "c".repeat(32), IMAGE = "d".repeat(32), CG = "e".repeat(32);
const camera = { position: [0, 0.2, 2], target: [0, 0, 0], up: [0, 1, 0], fov: 42 };
const state = (overrides = {}) => ({ schema_version: 1, background_id: A, selected_image_id: IMAGE, model_id: MODEL,
    selected_cg_id: CG, camera: clone(camera), settings: settingsDefaults(), model_settings: clone(MODEL_DEFAULTS), ...overrides });
const background = (id = A, overrides = {}) => ({ schema_version: 2, background_id: id, name: "Evening room", revision: 3,
    cg_settings: settingsDefaults(), model_settings: clone(MODEL_DEFAULTS), selected_image_id: IMAGE,
    images: [{ image_id: IMAGE, width: 1600, height: 900, url: `${BASE}/backgrounds/${id}/images/${IMAGE}` }],
    models: [{ model_id: MODEL, source_image_id: IMAGE }], model: { model_id: MODEL, source_image_id: IMAGE },
    cgs: [{ cg_id: CG, name: "Window view", model_id: MODEL, source_image_id: IMAGE,
        width: 1600, height: 896, camera: clone(camera), url: `${BASE}/backgrounds/${id}/cg/${CG}/image` }], ...overrides });
const scene = (id = A, overrides = {}) => ({ scene_id: "f".repeat(32), model_id: MODEL, background_id: id, camera: clone(camera),
    objects: [{ object_id: B, locked: true, source_camera: clone(camera) }], ...overrides });
const configuration = () => ({ settings: settingsDefaults(), installed: true, assets: [], loras: ["environment.safetensors"], samplers: ["euler"], schedulers: ["simple"] });
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => clone(value) });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const dataKey = key => key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
const abortCallbacks = new WeakMap();

test("malformed nested profiles are retained as invalid workflow data", () => {
    for (const changes of [{ settings: { generation: null } }, { settings: { generation: [] } }, { model_settings: [] }]) {
        const raw = JSON.stringify(state(changes));
        assert.throws(() => readState(raw), /settings/i);
    }
});

// Only the DOM operations used by the widget are emulated; no browser or GPU is involved.
class Element {
    constructor(tag = "div") {
        this.tagName = tag.toUpperCase(); this.style = {}; this.dataset = {}; this.attributes = new Map();
        this.listeners = new Map(); this.children = []; this.className = ""; this.value = ""; this.type = "";
        if (["SELECT", "TEXTAREA"].includes(this.tagName)) Object.defineProperty(this, "type", { get: () => this.tagName === "SELECT" ? "select-one" : "textarea" });
        this.scrollTop = 0; this.scrollLeft = 0; this.disabled = false; this.hidden = false;
        this.classList = {
            contains: value => this.className.split(/\s+/).includes(value),
            add: value => this.classList.toggle(value, true), remove: value => this.classList.toggle(value, false),
            toggle: (value, enabled) => { const values = new Set(this.className.split(/\s+/).filter(Boolean));
                const active = enabled ?? !values.has(value); active ? values.add(value) : values.delete(value); this.className = [...values].join(" "); return active; },
        };
    }
    set innerHTML(html) {
        this.replaceChildren(); const stack = [this];
        for (const token of html.matchAll(/<\/?[a-z][^>]*>/gi)) {
            if (token[0].startsWith("</")) { stack.pop(); continue; }
            const tag = /^<(\w+)/.exec(token[0])[1], child = new Element(tag);
            for (const attribute of token[0].slice(tag.length + 1, -1).matchAll(/([\w-]+)(?:="([^"]*)")?/g)) child.setAttribute(attribute[1], attribute[2] ?? "");
            stack.at(-1).appendChild(child);
            if (!["input", "img", "link", "br", "hr", "meta"].includes(tag) && !token[0].endsWith("/>")) stack.push(child);
        }
    }
    setAttribute(name, value) {
        this.attributes.set(name, String(value));
        if (name.startsWith("data-")) this.dataset[dataKey(name.slice(5))] = String(value);
        else if (["class", "value", "type", "name", "id"].includes(name)) this[name === "class" ? "className" : name] = String(value);
        else if (["hidden", "disabled", "required"].includes(name)) this[name] = true;
    }
    hasAttribute(name) { return name.startsWith("data-") ? Object.hasOwn(this.dataset, dataKey(name.slice(5))) : this.attributes.has(name); }
    matches(selector) {
        return selector.split(",").some(part => {
            part = part.trim();
            if (part.startsWith(".")) return this.classList.contains(part.slice(1));
            const attribute = /^\[([^=\]]+)(?:=["']?([^\]"']+)["']?)?\]$/.exec(part);
            if (attribute) {
                const value = attribute[1].startsWith("data-") ? this.dataset[dataKey(attribute[1].slice(5))] : this.attributes.get(attribute[1]);
                return this.hasAttribute(attribute[1]) && (attribute[2] === undefined || value === attribute[2]);
            }
            return this.tagName.toLowerCase() === part;
        });
    }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    contains(element) { return element === this || this.children.some(child => child.contains(element)); }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    append(...children) { for (const child of children) this.appendChild(child); }
    replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...children); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; this.removed = true; }
    addEventListener(type, callback, options = {}) {
        const callbacks = this.listeners.get(type) || []; callbacks.push(callback); this.listeners.set(type, callbacks);
        if (options.signal) {
            if (!abortCallbacks.has(options.signal)) {
                const callbacks = new Set(); abortCallbacks.set(options.signal, callbacks);
                options.signal.addEventListener("abort", () => { for (const callback of callbacks) callback(); }, { once: true });
            }
            abortCallbacks.get(options.signal).add(() => this.removeEventListener(type, callback));
        }
    }
    removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== callback)); }
    fire(type, detail = {}) {
        const event = { target: this, preventDefault() {}, ...detail }, results = [];
        for (let element = this; element; element = element.parentElement) for (const callback of element.listeners.get(type) || []) results.push(callback(event));
        return Promise.all(results);
    }
    click() { return this.fire("click"); }
    showModal() { this.open = true; }
    close() { this.open = false; }
    reportValidity() { return true; }
}

function harness(raw = JSON.stringify(state({ background_id: "", selected_image_id: "", model_id: "", selected_cg_id: "", camera: null })), { nodeId = 7, drafts = new Map() } = {}) {
    const calls = [], events = new Map(), timers = new Map(), queued = [];
    let extension, timerId = 0;
    const window = new Element("window"), documents = new Map([[A, background()], [B, background(B)]]);
    class Viewer {
        constructor(host, options) { this.options = options; this.canvas = new Element("canvas"); this.controls = {}; this.camera = clone(camera); this.frames = []; this.loads = []; }
        async setScene(value) { this.scene = value; this.loads.push(value); this.camera = { ...camera, position: [99, 99, 99] }; return { failures: [] }; }
        setLighting(settings) { this.lighting = settings; }
        setCaptureSettings(settings) { this.settings = settings; }
        setCameraState(value, { emit = false } = {}) { this.camera = clone(value); this.frames.push(this.camera); if (emit) this.options.onStateChange({ camera: this.camera }); }
        getCameraState() { return clone(this.camera); }
        select() {}
        resize() { this.resized = true; }
        async capturePreview(options) { this.captureOptions = options; return new Blob(["png"]); }
        dispose() { this.disposed = true; }
    }
    const api = {
        addEventListener(name, callback) { const callbacks = events.get(name) || []; callbacks.push(callback); events.set(name, callbacks); },
        removeEventListener(name, callback) { const callbacks = (events.get(name) || []).filter(item => item !== callback); callbacks.length ? events.set(name, callbacks) : events.delete(name); },
        apiURL: value => value,
        async fetchApi(path, options = {}) {
            calls.push({ path, options });
            if (api.handle) { const result = await api.handle(path, options); if (result !== undefined) return result; }
            if (path === `${BASE}/config`) return response(configuration());
            if (path === `${BASE}/backgrounds`) return response({ backgrounds: [...documents.values()] });
            const match = new RegExp(`^${BASE}/backgrounds/([a-f0-9]{32})(/models/[a-f0-9]{32})?$`).exec(path);
            if (match && !match[2] && options.method === "PATCH") {
                const document = documents.get(match[1]), values = JSON.parse(options.body);
                if (values.revision !== document.revision) return response({ error: "Scene was modified elsewhere" }, 409);
                const saved = { ...document, revision: document.revision + 1, cg_settings: values.cg_settings, model_settings: values.model_settings };
                documents.set(match[1], saved); return response(saved);
            }
            if (match && !options.method) {
                const document = documents.get(match[1]);
                if (!match[2]) return response(document);
                const modelId = match[2].split("/").at(-1), model = (document.models || [document.model]).find(item => item?.model_id === modelId);
                return response(scene(match[1], { model_id: modelId, source_image_id: model?.source_image_id }));
            }
            throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
        },
        async queuePrompt(number, prompt, options) { queued.push({ number, prompt, options }); return { prompt_id: "import-prompt" }; },
    };
    const localStorage = { getItem: key => drafts.get(key) ?? null, setItem: (key, value) => drafts.set(key, value), removeItem: key => drafts.delete(key) };
    const context = vm.createContext({
        document: { getElementById: () => true, createElement: tag => new Element(tag), head: new Element("head"), activeElement: null },
        window, localStorage, crypto: { randomUUID: () => "01234567-89ab-cdef-0123-456789abcdef" },
        URL, AbortController, FormData, Blob, console, api, clone, readState, settingsDefaults, frameDimensions, sourceCameraView, MODEL_DEFAULTS,
        ResizeObserver: class { observe() {} disconnect() { this.disconnected = true; } },
        installCustomSelects: () => ({ refresh() {}, disconnect() { this.disconnected = true; } }),
        Factory3DViewer: Viewer, FactoryCommandHistory,
        app: { registerExtension: value => { extension = value; }, graphToPrompt: async () => { throw new Error("CG Creator must not queue the workflow"); } },
        setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
        clearTimeout: id => timers.delete(id),
    });
    vm.runInContext(widgetSource.replace(/^import .*\n/gm, "").replace("export class CGCreatorWidget", "globalThis.CGCreatorWidget = class CGCreatorWidget").replaceAll("import.meta.url", '"https://localhost/widget.mjs"'), context);
    vm.runInContext(entrySource.replace(/^import .*\n/gm, ""), context);
    class Node {
        constructor() { this.id = nodeId; this.widgets = [{ name: "cg_data", value: raw }]; this.size = [1500, 950]; this.graph = { setDirtyCanvas() {} }; }
        addDOMWidget(name, type, element, options) { const value = { name, element, options }; this.widgets.push(value); return value; }
        setSize(size) { this.size = size; }
        onNodeCreated() { this.created = true; }
        onConfigure() { this.configured = true; }
        onRemoved() { this.removed = true; }
    }
    extension.beforeRegisterNodeDef(Node, { name: "VNCCS_CGCreator" });
    const node = new Node(); node.onNodeCreated(); const widget = node.cgCreator;
    const fireTimers = delay => { const pending = [...timers].filter(([, timer]) => timer.delay === delay); for (const [id, timer] of pending) { timers.delete(id); timer.callback(); } };
    const emit = (name, detail) => { for (const callback of events.get(name) || []) callback({ detail }); };
    return { node, widget, calls, api, events, timers, drafts, queued, documents, context, window, extension, data: node.widgets[0],
        emit: detail => emit("vnccs_cg_creator", { node_id: "7", ...detail }), emitEvent: emit, fireTimers,
        ready: async () => { fireTimers(0); await widget.operations; },
        control: selector => widget.container.querySelector(selector),
    };
}

test("CG state restores nested settings without sharing mutable defaults", () => {
    const restored = readState(JSON.stringify(state({ settings: { prompt: "Keep the room", generation: { steps: 31 } } })));
    assert.equal(restored.settings.prompt, "Keep the room"); assert.equal(restored.settings.generation.steps, 31);
    assert.equal(restored.settings.generation.sampler, "euler"); assert.equal(restored.selected_cg_id, CG);
    restored.settings.generation.lora_stack.push({ name: "environment.safetensors", strength: 1 });
    assert.deepEqual(settingsDefaults().generation.lora_stack, []);
    for (const raw of ["{broken", "[]", "null", '{"schema_version":2}', JSON.stringify(state({ model_id: "../model" })), JSON.stringify(state({ camera: {} }))]) assert.throws(() => readState(raw));
});

test("source-camera calibration keeps image-plane framing while saved CG cameras stay exact", async () => {
    const native = { position: [0, 0, 3.35], target: [0, 0, 0], up: [0, 1, 0], fov: 15.17 }, calibrated = sourceCameraView(native);
    assert.equal(calibrated.fov, 60); assert.equal(native.fov, 15.17);
    assert.ok(Math.abs(calibrated.position[2] * Math.tan(Math.PI / 6) - 3.35 * Math.tan(native.fov * Math.PI / 360)) < 1e-12);
    const h = harness(JSON.stringify(state({ selected_cg_id: "", camera: null }))); h.documents.set(A, background(A, { cgs: [] }));
    h.api.handle = path => path.includes(`/models/${MODEL}`) ? response(scene(A, { source_image_id: IMAGE, camera: native, objects: [{ object_id: B, locked: true, source_camera: native }] })) : undefined;
    await h.ready(); assert.deepEqual(h.widget.viewer.camera, calibrated);
    const saved = { ...native, fov: 19, position: [0.4, 0.2, 2.6] };
    h.documents.set(A, background(A, { cgs: [{ ...background().cgs[0], camera: saved }] }));
    h.data.value = JSON.stringify(state({ camera: saved })); h.node.onConfigure(); await h.ready();
    assert.deepEqual(h.widget.viewer.camera, saved);
});

test("frame dimensions support portrait and landscape within renderer limits", () => {
    for (const [aspect, ratio] of [["16:9", 16 / 9], ["9:16", 9 / 16], ["4:3", 4 / 3], ["1:1", 1]]) {
        const size = frameDimensions(aspect, 2);
        assert.equal(size.width % 16, 0); assert.equal(size.height % 16, 0);
        assert.ok(Math.abs(size.width / size.height - ratio) < 0.03);
        assert.ok(size.width >= 64 && size.height >= 64 && size.width <= 4096 && size.height <= 4096);
    }
    assert.throws(() => frameDimensions("0:9", 2)); assert.throws(() => frameDimensions("16:9", 0));
});

test("standalone CG entry registers its new node and exposes only the model workspace", async () => {
    const h = harness(JSON.stringify(state())); await h.ready();
    class OldNode { onNodeCreated() {} }
    const original = OldNode.prototype.onNodeCreated;
    h.extension.beforeRegisterNodeDef(OldNode, { name: "VNCCS_BackgroundCreator" });
    assert.equal(OldNode.prototype.onNodeCreated, original);
    assert.equal(h.node.cgCreator, h.widget); assert.equal(h.node.cgCreatorDOM.options.serialize, false);
    assert.equal(h.node.cgCreatorDOM.name, "cg_ui"); assert.equal(h.data.hidden, true);
    assert.equal(h.control("[data-step]"), null); assert.equal(h.control("[data-upload]"), null);
    assert.equal(h.control("[data-wizard]"), null); assert.equal(h.control('[data-action="background"]'), null);
    assert.ok(h.control("[data-image]")); assert.ok(h.control('[data-action="model"]')); assert.ok(h.control("[data-settings]"));
    assert.ok(h.widget.container.classList.contains("vnccs-cg-creator")); assert.ok(h.calls.every(call => call.path.startsWith(BASE + "/")));
    assert.deepEqual(h.queued, []);
});

test("native settings and Save View dialogs open with read-only select and textarea types", async () => {
    const h = harness(JSON.stringify(state())); await h.ready();
    for (const selector of ["[data-settings]", "[data-save-view]"]) {
        const opening = h.control(selector).click(); await settle();
        const dialog = h.control("dialog"); assert.ok(dialog?.open, h.widget.status.textContent);
        assert.equal(dialog.querySelector("select").type, "select-one");
        if (selector === "[data-save-view]") assert.equal(dialog.querySelector("textarea").type, "textarea");
        dialog.querySelectorAll("button")[0].onclick(); await opening;
        assert.equal(h.control("dialog"), null);
    }
});

test("construction leaves configured bytes untouched until restoration completes", async () => {
    const h = harness(), original = h.data.value; assert.equal(h.widget.state, null); assert.equal(h.data.value, original);
    const savedCamera = { ...camera, fov: 61, position: [1, 2, 3] };
    h.data.value = JSON.stringify(state({ camera: savedCamera })); h.node.onConfigure(); await h.ready();
    assert.equal(h.node.created, true); assert.equal(h.node.configured, true);
    assert.deepEqual(h.widget.viewer.camera, savedCamera); assert.equal(h.widget.canEditCamera(), true);
    assert.equal(h.widget.viewer.scene.objects[0].locked, true); assert.equal(JSON.parse(h.data.value).camera.fov, 61);
});

test("FOV updates both fields, camera and serialized state throughout a single undo gesture", async () => {
    const h = harness(JSON.stringify(state())); await h.ready();
    for (const value of [35, 55]) {
        h.widget.fov.value = String(value); h.widget.fov.fire("input");
        assert.equal(h.widget.viewer.camera.fov, value); assert.equal(h.widget.fovNumber.value, String(value));
        assert.equal(JSON.parse(h.data.value).camera.fov, value); assert.equal(h.widget.history.undoStack.length, 0);
    }
    h.widget.fovNumber.value = "65"; h.widget.fovNumber.fire("input"); assert.equal(h.widget.fov.value, "65");
    await h.widget.fov.fire("change"); assert.equal(h.widget.history.undoStack.length, 1);
    await h.widget.container.fire("keydown", { key: "z", ctrlKey: true }); assert.equal(h.widget.viewer.camera.fov, 42);
    await h.widget.container.fire("keydown", { key: "z", ctrlKey: true, shiftKey: true }); assert.equal(h.widget.viewer.camera.fov, 65);
    await h.control("[data-recenter]").click(); assert.deepEqual(h.widget.viewer.camera, sourceCameraView(camera));
});

test("serialization replaces collected payload and queueing rejects active generation", async () => {
    const h = harness(JSON.stringify(state())); await h.ready(); h.widget.viewer.camera = { ...camera, fov: 80 };
    const info = { widgets_values: ["stale"] }; h.node.onSerialize(info); assert.equal(JSON.parse(info.widgets_values[0]).camera.fov, 80);
    h.widget.viewer.camera = { ...camera, fov: 90 }; h.data.beforeQueued(); assert.equal(JSON.parse(h.data.serializeValue()).camera.fov, 90);
    h.widget.busy = true; assert.throws(() => h.data.beforeQueued(), /running|busy|generation|operation/i);
});

test("malformed or failed restoration retains original state and blocks workflow execution", async () => {
    for (const raw of ["{broken", '{"schema_version":2}', JSON.stringify(state({ camera: {} }))]) {
        const h = harness(raw); await h.ready(); assert.equal(h.data.value, raw); assert.equal(h.widget.restoring, true);
        assert.equal(h.data.serializeValue(), raw); assert.throws(() => h.data.beforeQueued(), /restoring/i);
    }
    const raw = JSON.stringify(state()), h = harness(raw);
    h.api.handle = path => path === `${BASE}/backgrounds/${A}` ? response({ error: "Damaged document" }, 409) : undefined;
    await h.ready(); assert.equal(h.data.value, raw); assert.equal(h.widget.restoring, true);
    assert.match(h.widget.status.textContent, /Damaged document/); assert.throws(() => h.data.beforeQueued(), /restoring/i);
});

test("late restoration cannot replace a newer configured scene or camera", async () => {
    const h = harness(JSON.stringify(state())), pending = deferred(); let intercepted = false;
    h.api.handle = path => { if (path === `${BASE}/config` && !intercepted) { intercepted = true; return pending.promise; } };
    h.fireTimers(0); await settle(); assert.equal(intercepted, true);
    const savedCamera = { ...camera, fov: 72 };
    h.data.value = JSON.stringify(state({ background_id: B, camera: savedCamera })); h.node.onConfigure(); h.fireTimers(0);
    pending.resolve(response(configuration())); await h.widget.operations;
    assert.equal(h.widget.document.background_id, B); assert.equal(h.widget.scene.background_id, B);
    assert.deepEqual(h.widget.viewer.camera, savedCamera); assert.equal(JSON.parse(h.data.value).background_id, B);
});

test("library navigation locks generation before saving and until the new model finishes loading", async () => {
    const h = harness(JSON.stringify(state())); await h.ready();
    h.widget.state.settings.prompt = "Save before navigation"; h.widget.markEdited();
    const save = deferred(), load = deferred(), model = deferred();
    h.api.handle = (path, options) => {
        if (options.method === "PATCH") return save.promise;
        if (path === `${BASE}/backgrounds/${B}`) return load.promise;
        if (path === `${BASE}/backgrounds/${B}/models/${MODEL}`) return model.promise;
    };
    const library = h.control("[data-library]"); library.value = B;
    const navigation = h.widget.change({ target: library });
    const assertLocked = async () => {
        assert.equal(h.widget.busy, true); assert.equal(h.control('[data-action="model"]').disabled, true);
        assert.equal(h.control("[data-save-view]").disabled, true);
        await h.control('[data-action="model"]').click();
        assert.equal(h.calls.some(call => call.path.endsWith("/jobs")), false);
        assert.throws(() => h.data.beforeQueued(), /operation|busy|generation/i);
    };
    await assertLocked(); await settle();
    save.resolve(response(background(A, { revision: 4, cg_settings: h.widget.state.settings }))); await settle();
    assert.equal(h.calls.some(call => call.path === `${BASE}/backgrounds/${B}`), true); await assertLocked();
    load.resolve(response(background(B))); await settle();
    assert.equal(h.calls.some(call => call.path === `${BASE}/backgrounds/${B}/models/${MODEL}`), true); await assertLocked();
    model.resolve(response(scene(B, { source_image_id: IMAGE }))); await navigation;
    assert.equal(h.widget.busy, false); assert.equal(h.widget.document.background_id, B);
    assert.equal(h.control('[data-action="model"]').disabled, false);
});

test("settings edited during a pending disk save survive its acknowledgement and preserve scroll", async () => {
    const h = harness(JSON.stringify(state())); await h.ready();
    h.widget.state.settings.prompt = "First instruction"; h.widget.markEdited(); const pending = deferred();
    h.api.handle = (_path, options) => options.method === "PATCH" ? pending.promise : undefined;
    const save = h.widget.persist(); await settle();
    h.widget.state.settings.prompt = "Latest instruction"; h.widget.markEdited();
    const panel = h.control(".bg-panel"), gallery = h.control(".bg-cg-list"); panel.scrollTop = 180; gallery.scrollTop = 95;
    h.widget.render(); assert.equal(panel.scrollTop, 180); assert.equal(gallery.scrollTop, 95);
    pending.resolve(response(background(A, { revision: 4, cg_settings: settingsDefaults({ prompt: "First instruction" }) }))); await save;
    assert.equal(h.widget.state.settings.prompt, "Latest instruction"); assert.equal(h.widget.unsaved, true); assert.equal(h.widget.document.revision, 4);
    assert.equal(JSON.parse(h.drafts.get(h.widget.draftKey())).settings.prompt, "Latest instruction");
    const patch = h.calls.find(call => call.options.method === "PATCH");
    assert.equal(JSON.parse(patch.options.body).cg_settings.prompt, "First instruction");
    assert.ok(JSON.parse(patch.options.body).model_settings);
    h.api.handle = (_path, options) => options.method === "PATCH" ? response(background(A, { revision: 5, cg_settings: h.widget.state.settings })) : undefined;
    await h.widget.persist(); assert.equal(h.widget.unsaved, false); assert.equal(h.drafts.has(h.widget.draftKey()), false);
});

test("disk conflicts retain workflow edits and browser recovery", async () => {
    const h = harness(JSON.stringify(state())); await h.ready();
    h.widget.state.settings.prompt = "Retain this instruction"; h.widget.markEdited();
    h.api.handle = (_path, options) => options.method === "PATCH" ? response({ error: "Scene was modified elsewhere" }, 409) : undefined;
    await assert.rejects(h.widget.persist(), /modified elsewhere/);
    assert.equal(h.widget.document.revision, 3); assert.equal(h.widget.unsaved, true);
    assert.equal(JSON.parse(h.data.value).settings.prompt, "Retain this instruction");
    assert.equal(JSON.parse(h.drafts.get(h.widget.draftKey())).settings.prompt, "Retain this instruction");
});

test("nodes editing the same scene retain independent recovery drafts across saves and reloads", async () => {
    const drafts = new Map(), first = harness(JSON.stringify(state()), { nodeId: 7, drafts }), second = harness(JSON.stringify(state()), { nodeId: 8, drafts });
    await first.ready(); await second.ready();
    first.widget.state.settings.prompt = "First node instruction"; first.widget.markEdited();
    second.widget.state.settings.prompt = "Second node unsaved instruction"; second.widget.markEdited();
    const firstKey = first.widget.draftKey(), secondKey = second.widget.draftKey(), secondBytes = drafts.get(secondKey);
    assert.notEqual(firstKey, secondKey); await first.widget.persist();
    assert.equal(drafts.has(firstKey), false); assert.equal(drafts.get(secondKey), secondBytes);
    const reloaded = harness(JSON.stringify(state()), { nodeId: 8, drafts }); await reloaded.ready();
    assert.equal(reloaded.widget.draftKey(), secondKey); assert.equal(reloaded.widget.state.settings.prompt, "Second node unsaved instruction");
    assert.equal(reloaded.widget.unsaved, true);
    const unassignedFirst = harness(JSON.stringify(state()), { nodeId: -1, drafts }), unassignedSecond = harness(JSON.stringify(state()), { nodeId: -1, drafts });
    await unassignedFirst.ready(); await unassignedSecond.ready();
    assert.notEqual(unassignedFirst.widget.draftKey(), unassignedSecond.widget.draftKey());
});

test("a save acknowledgement cannot remove a changed recovery payload under the same key", async () => {
    const h = harness(JSON.stringify(state())); await h.ready();
    h.widget.state.settings.prompt = "Instruction being saved"; h.widget.markEdited(); const pending = deferred();
    h.api.handle = (_path, options) => options.method === "PATCH" ? pending.promise : undefined;
    const save = h.widget.persist(); await settle();
    const key = h.widget.draftKey(), replacement = JSON.stringify({ settings: settingsDefaults({ prompt: "Replacement from another editor" }), model_settings: clone(MODEL_DEFAULTS), revision: 3 });
    h.drafts.set(key, replacement);
    pending.resolve(response(background(A, { revision: 4, cg_settings: h.widget.state.settings }))); await save;
    assert.equal(h.drafts.get(key), replacement); assert.equal(h.widget.unsaved, false);
});

test("older recovery drafts restore authored settings and require review before persistence", async () => {
    const h = harness(JSON.stringify(state())); await h.ready(); const key = h.widget.draftKey();
    const draft = JSON.stringify({ settings: settingsDefaults({ prompt: "Older authored instruction" }), model_settings: { ...MODEL_DEFAULTS, steps: 35 }, revision: 1 });
    h.drafts.set(key, draft); h.node.onConfigure(); await h.ready();
    assert.equal(h.widget.state.settings.prompt, "Older authored instruction"); assert.equal(h.widget.state.model_settings.steps, 35);
    assert.equal(h.widget.unsaved, true); assert.equal(h.widget.draftConflict, true); assert.equal(h.drafts.get(key), draft);
    assert.match(h.widget.status.textContent, /conflict|review/i);
    await assert.rejects(h.widget.persist(), /review|confirm/i);
    assert.equal(h.calls.some(call => call.options.method === "PATCH"), false); assert.equal(h.drafts.get(key), draft);
    h.widget.markEdited(); assert.equal(h.widget.draftConflict, false); await h.widget.persist();
    assert.equal(h.widget.document.revision, 4); assert.equal(h.widget.unsaved, false); assert.equal(h.drafts.has(key), false);
});

test("a pending save cannot overwrite settings restored by later configuration", async () => {
    const h = harness(JSON.stringify(state())); await h.ready(); const pending = deferred();
    h.widget.state.settings.prompt = "Old pending instruction"; h.widget.markEdited();
    h.api.handle = (_path, options) => options.method === "PATCH" ? pending.promise : undefined;
    const save = h.widget.persist(); await settle();
    const replacement = state({ background_id: B, settings: settingsDefaults({ prompt: "New workflow instruction" }) });
    h.data.value = JSON.stringify(replacement); h.node.onConfigure(); await h.ready();
    pending.resolve(response(background(A, { revision: 4 }))); await save;
    assert.equal(h.widget.document.background_id, B); assert.equal(h.widget.state.settings.prompt, "New workflow instruction");
    assert.equal(JSON.parse(h.data.value).settings.prompt, "New workflow instruction");
});

test("restoring an empty workflow clears the previous scene while retaining its recovery draft", async () => {
    const h = harness(JSON.stringify(state())); await h.ready();
    h.widget.state.settings.prompt = "Retain the old scene draft"; h.widget.markEdited(); const key = h.widget.draftKey();
    h.data.value = JSON.stringify(state({ background_id: "", selected_image_id: "", model_id: "", selected_cg_id: "", camera: null }));
    h.node.onConfigure(); await h.ready();
    assert.equal(h.widget.document, null); assert.equal(h.widget.state.background_id, ""); assert.equal(h.widget.unsaved, false);
    assert.equal(h.widget.host.hidden, true); assert.equal(h.control("[data-cgs]").children.length, 0);
    assert.equal(JSON.parse(h.drafts.get(key)).settings.prompt, "Retain the old scene draft");
    await h.widget.persist(); assert.equal(h.calls.some(call => call.options.method === "PATCH"), false);
});

test("read-only backup recovery disables generation while retaining the saved CG", async () => {
    const h = harness(JSON.stringify(state())); h.documents.set(A, background(A, { _recovery: { source: "backup" } })); await h.ready();
    assert.equal(h.widget.restoring, false); assert.match(h.widget.status.textContent, /read-only|read only/i);
    assert.equal(h.control('[data-action="model"]').disabled, true); assert.equal(h.control("[data-save-view]").disabled, true);
    assert.equal(h.control("[data-cgs]").children.length, 1);
});

function variantBackground() {
    const secondImage = "4".repeat(32), latest = "5".repeat(32), secondModel = "6".repeat(32), secondCG = "7".repeat(32);
    const document = background(); document.images.push({ image_id: secondImage, width: 1024, height: 768, url: "/second-background.png" });
    document.models = [{ model_id: MODEL, source_image_id: IMAGE }, { model_id: latest, source_image_id: IMAGE }, { model_id: secondModel, source_image_id: secondImage }];
    document.model = document.models.at(-1); document.cgs[0].camera.fov = 73;
    document.cgs.push({ cg_id: secondCG, model_id: secondModel, source_image_id: secondImage, name: "Second variant view",
        width: 1024, height: 768, camera: { ...camera, fov: 56 }, url: "/second-cg.png" });
    return { document, secondImage, latest, secondModel, secondCG };
}

test("image selection binds its latest model and only its own CG gallery", async () => {
    const { document, secondImage, latest, secondModel, secondCG } = variantBackground(), h = harness(JSON.stringify(state()));
    h.documents.set(A, document); await h.ready(); const select = h.control("[data-image]");
    select.value = secondImage; await h.widget.change({ target: select });
    assert.equal(h.widget.state.model_id, secondModel); assert.equal(h.widget.state.selected_cg_id, "");
    assert.equal(h.widget.scene.source_image_id, secondImage); assert.equal(h.widget.host.hidden, false);
    assert.deepEqual(h.control("[data-cgs]").children.map(card => card.dataset.cgId), [secondCG]);
    await h.control("[data-cgs]").children[0].click(); assert.equal(h.widget.viewer.camera.fov, 56);
    select.value = IMAGE; await h.widget.change({ target: select });
    assert.equal(h.widget.state.model_id, latest); assert.equal(h.widget.state.selected_cg_id, "");
    assert.deepEqual(h.control("[data-cgs]").children.map(card => card.dataset.cgId), [CG]);
    await h.control("[data-cgs]").children[0].click();
    assert.equal(h.widget.state.model_id, MODEL); assert.equal(h.widget.viewer.camera.fov, 73); assert.equal(h.widget.state.selected_image_id, IMAGE);
});

test("model generation runs independently and starts at the calibrated source camera", async () => {
    const h = harness(JSON.stringify(state())); await h.ready(); const modelId = "2".repeat(32), completed = background(A, { revision: 4 });
    completed.models.push({ model_id: modelId, source_image_id: IMAGE }); completed.model = completed.models.at(-1);
    let payload;
    h.api.handle = (path, options) => {
        if (path === `${BASE}/backgrounds/${A}/jobs`) { payload = JSON.parse(options.body); return response({ job_id: B }); }
        if (path === `${BASE}/jobs/${B}`) return response({ status: "completed", result: { document: completed } });
        if (path === `${BASE}/backgrounds/${A}/models/${modelId}`) return response(scene(A, { model_id: modelId, source_image_id: IMAGE }));
    };
    await h.control('[data-action="model"]').click();
    assert.equal(payload.action, "model"); assert.equal(payload.image_id, IMAGE);
    assert.equal(h.widget.state.model_id, modelId); assert.equal(h.widget.viewer.camera.fov, 60);
    assert.equal(h.widget.busy, false); assert.deepEqual(h.queued, []);
});

test("late generation completion cannot replace a reconfigured scene", async () => {
    const h = harness(JSON.stringify(state())); await h.ready(); const completion = deferred();
    h.api.handle = (path, options) => {
        if (path === `${BASE}/backgrounds/${A}/jobs` && options.method === "POST") return response({ job_id: B });
        if (path === `${BASE}/jobs/${B}`) return completion.promise;
    };
    const job = h.widget.runJob("model"); await settle();
    assert.equal(h.calls.some(call => call.path === `${BASE}/jobs/${B}`), true);
    h.data.value = JSON.stringify(state({ background_id: B })); h.node.onConfigure(); await h.ready();
    completion.resolve(response({ status: "completed", result: { document: background(A, { revision: 4 }) } })); await job;
    assert.equal(h.widget.document.background_id, B); assert.equal(h.widget.state.background_id, B);
    assert.equal(JSON.parse(h.data.value).background_id, B); assert.equal(h.widget.busy, false);
});

test("a completed job for another background is rejected before changing selected assets", async () => {
    const h = harness(JSON.stringify(state())); await h.ready(); const original = h.data.value;
    h.api.handle = (path, options) => {
        if (path === `${BASE}/backgrounds/${A}/jobs` && options.method === "POST") return response({ job_id: B });
        if (path === `${BASE}/jobs/${B}`) return response({ status: "completed", result: { document: background(B, { revision: 4 }) } });
    };
    await assert.rejects(h.widget.runJob("model"), /another background/i);
    assert.equal(h.widget.document.background_id, A); assert.equal(h.widget.state.background_id, A);
    assert.equal(h.widget.state.selected_cg_id, CG); assert.equal(h.data.value, original); assert.equal(h.widget.busy, false);
});

test("saving a view captures its camera and frame then selects the finished CG", async () => {
    const h = harness(JSON.stringify(state())); await h.ready();
    const savedCamera = { ...camera, fov: 58 }, cgId = "0".repeat(32), size = frameDimensions("4:3", 2), completed = background(A, { revision: 5 });
    completed.cgs.push({ cg_id: cgId, name: "Desk", model_id: MODEL, source_image_id: IMAGE, camera: savedCamera, ...size, url: "/finished-cg.png" });
    h.widget.viewer.camera = savedCamera;
    h.widget.dialog = async () => ({ name: "Desk", aspect: "4:3", prompt: "Complete the room and retain the camera." }); let payload;
    h.api.handle = (path, options) => {
        if (options.method === "PATCH") return response(background(A, { revision: 4, cg_settings: h.widget.state.settings }));
        if (path === `${BASE}/backgrounds/${A}/jobs`) { assert.ok(options.body.get("image") instanceof Blob); payload = JSON.parse(options.body.get("data")); return response({ job_id: B }); }
        if (path === `${BASE}/jobs/${B}`) return response({ status: "completed", progress: 100, result: { document: completed } });
    };
    await h.control("[data-save-view]").click();
    assert.equal(payload.action, "cg"); assert.equal(payload.model_id, MODEL); assert.deepEqual(payload.camera, savedCamera);
    assert.equal(h.widget.viewer.captureOptions.width, size.width); assert.equal(h.widget.viewer.captureOptions.height, size.height);
    assert.deepEqual(clone(h.widget.state.frame), size); assert.equal(h.widget.state.selected_cg_id, cgId);
    assert.equal(h.widget.viewer.settings.width, size.width); assert.equal(h.widget.viewer.settings.height, size.height);
    const cards = h.control("[data-cgs]").children; assert.equal(cards.length, 2);
    assert.equal(cards.at(-1).querySelector("img").src, "/finished-cg.png"); assert.equal(cards.at(-1).classList.contains("selected"), true);
    assert.equal(JSON.parse(h.data.value).selected_cg_id, cgId); assert.deepEqual(h.queued, []);
});

test("completed CGs retain historical model and camera instead of the latest model alias", async () => {
    const historicalModel = "1".repeat(32), cgId = "0".repeat(32), size = frameDimensions("4:3", 2);
    const h = harness(JSON.stringify(state({ model_id: historicalModel }))), original = background();
    original.models.unshift({ model_id: historicalModel, source_image_id: IMAGE }); original.cgs[0].model_id = historicalModel;
    h.documents.set(A, original); await h.ready(); const savedCamera = { ...camera, fov: 66 }, completed = clone(original); completed.revision = 5;
    completed.cgs.push({ cg_id: cgId, name: "Historical view", model_id: historicalModel, source_image_id: IMAGE, camera: savedCamera, ...size, url: "/historical-cg.png" });
    h.widget.viewer.camera = savedCamera; h.widget.dialog = async () => ({ name: "Historical view", aspect: "4:3", prompt: "Retain this camera." });
    h.api.handle = (path, options) => {
        if (options.method === "PATCH") return response({ ...original, revision: 4, cg_settings: h.widget.state.settings });
        if (path === `${BASE}/backgrounds/${A}/jobs`) return response({ job_id: B });
        if (path === `${BASE}/jobs/${B}`) return response({ status: "completed", result: { document: completed } });
    };
    await h.control("[data-save-view]").click();
    assert.equal(h.widget.document.model.model_id, MODEL); assert.equal(h.widget.state.model_id, historicalModel);
    assert.equal(h.widget.scene.model_id, historicalModel); assert.equal(h.widget.viewer.camera.fov, 66);
    assert.deepEqual(clone(h.widget.state.frame), size); assert.equal(h.widget.state.selected_cg_id, cgId);
});

test("canceling Save View restores the previous frame after live aspect preview", async () => {
    const priorFrame = { width: 1024, height: 768 }, h = harness(JSON.stringify(state({ frame: priorFrame }))); await h.ready();
    h.widget.dialog = async (_title, fields) => { fields.find(field => field.key === "aspect").oninput("9:16"); assert.ok(h.widget.viewer.settings.height > h.widget.viewer.settings.width); return null; };
    await h.control("[data-save-view]").click();
    assert.equal(h.widget.viewer.settings.width, priorFrame.width); assert.equal(h.widget.viewer.settings.height, priorFrame.height);
    assert.deepEqual(clone(h.widget.state.frame), priorFrame); assert.deepEqual(h.queued, []);
});

test("removal retains pending edits and disposes timers, viewer, observer and listeners", async () => {
    const h = harness(JSON.stringify(state())); await h.ready(); const viewer = h.widget.viewer;
    h.widget.state.settings.prompt = "Retained on removal"; h.widget.markEdited(); const key = h.widget.draftKey(); h.node.onRemoved();
    assert.equal(h.node.removed, true); assert.equal(h.widget.disposed, true); assert.equal(h.widget.observer.disconnected, true);
    assert.equal(viewer.disposed, true); assert.equal(h.events.size, 0); assert.equal(h.widget.events.signal.aborted, true);
    assert.equal(h.widget.customSelects.disconnected, true); assert.equal(h.widget.container.removed, true); assert.equal(h.timers.size, 0);
    assert.equal(JSON.parse(h.drafts.get(key)).settings.prompt, "Retained on removal");
});

test("live resize retains the viewer and follows node dimensions", async () => {
    const h = harness(JSON.stringify(state())); await h.ready(); const viewer = h.widget.viewer, container = h.widget.container;
    h.node.size = [1500, 1050]; h.node.onResize();
    assert.equal(h.node.cgCreatorDOM.width, 1500); assert.equal(h.widget.viewer, viewer); assert.equal(h.widget.container, container);
    assert.equal(h.widget.container.style.height, "960px"); assert.equal(viewer.resized, true);
});
