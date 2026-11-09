import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../web/factory3d/generation_preview.mjs", import.meta.url), "utf8");
const studio = fs.readFileSync(new URL("../web/vnccs_3d_factory.js", import.meta.url), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function fixture() {
    const model = deferred();
    const requests = [];
    const material = { map: texture("original"), normalMap: texture("normal") };
    const root = { traverse: callback => callback({ isMesh: true, material }) };
    const disposed = [];
    let loads = 0;
    const Preview = vm.runInNewContext(`${source.replace(/^import .*;\n/gm, "").replace("export class", "class")}\nFactoryGenerationPreview`, {
        THREE: { SRGBColorSpace: "srgb", NoColorSpace: "linear", TextureLoader: class {
            loadAsync(url) { const request = deferred(); requests.push({ url, ...request }); return request.promise; }
        } },
        loadFactoryModel: () => { loads++; return model.promise; },
        disposeFactoryModel: value => disposed.push(value),
    });
    const scene = new Set();
    const viewer = { scene: { add: value => scene.add(value), remove: value => scene.delete(value) },
        options: { resolveAssetURL: value => value }, invalidate() {}, _frameBounds() {} };
    const preview = new Preview(viewer);
    return { preview, model, requests, root, material, disposed, scene, loads: () => loads };
}
function texture(name) { return { name, disposed: 0, dispose() { this.disposed++; } }; }
const snapshot = (id, atlas = {}) => ({ object_id: id, preview_url: `${id}.glb`, atlas });

test("A preview finishing after cancellation is disposed without appearing", async () => {
    const f = fixture();
    const pending = f.preview.update(snapshot("job"));
    f.preview.clear();
    f.model.resolve({ root: f.root, bounds: {} });
    await pending;
    assert.equal(f.scene.size, 0);
    assert.deepEqual(f.disposed, [f.root]);
});

test("Only the newest atlas is applied and mesh loads once", async () => {
    const f = fixture();
    const pending = f.preview.update(snapshot("job", { base_color: "old.png" }));
    f.model.resolve({ root: f.root, bounds: {} });
    await tick();
    await f.preview.update(snapshot("job", { base_color: "new.png", roughness: "rough.png", metallic: "metal.png" }));
    const stale = texture("stale");
    f.requests[0].resolve(stale);
    await tick();
    assert.equal(stale.disposed, 1);
    const fresh = f.requests.slice(1).map(request => {
        const map = texture(request.url); request.resolve(map); return map;
    });
    await pending;
    assert.equal(f.loads(), 1);
    assert.equal(f.scene.size, 1);
    assert.equal(f.material.map.name, "new.png");
    assert.equal(f.material.map.flipY, false);
    assert.equal(f.material.map.colorSpace, "srgb");
    assert.equal(f.material.roughnessMap.colorSpace, "linear");
    assert.equal(f.material.normalMap.name, "normal");
    assert.equal(f.material.roughness, 1);
    assert.equal(f.material.metalness, 1);
    assert.ok(fresh.every(map => map.disposed === 0));
    f.preview.clear();
    assert.equal(f.scene.size, 0);
});

test("Failed map load retains the last frame and can retry", async () => {
    const f = fixture();
    const state = snapshot("job", { base_color: "color.png", roughness: "rough.png" });
    const pending = f.preview.update(state);
    f.model.resolve({ root: f.root, bounds: {} });
    await tick();
    const partial = texture("partial");
    f.requests[0].resolve(partial);
    f.requests[1].reject(new Error("offline"));
    await assert.rejects(pending, /offline/);
    assert.equal(f.material.map.name, "original");
    assert.equal(partial.disposed, 1);
    const retry = f.preview.update(state);
    await tick();
    f.requests.slice(2).forEach(request => request.resolve(texture(request.url)));
    await retry;
    assert.equal(f.material.map.name, "color.png");
    assert.equal(f.loads(), 1);
});

class Element {
    constructor(tag) {
        this.tag = tag; this.children = []; this.scrollLeft = 0;
        this.classList = { toggle: (name, value) => { this[name] = value; } };
    }
    appendChild(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    setAttribute(name, value) { this[name] = value; }
    addEventListener() {}
    querySelector(selector) { return this.children.find(child => child.className === selector.slice(1)); }
}
test("The view strip shows real images, active stage, and clears between jobs", () => {
    const start = studio.indexOf("    _renderTexturingViews(");
    const end = studio.indexOf("    _syncSeedMode()", start);
    const methods = vm.runInNewContext(`({${studio.slice(start, end)}})`, {
        document: { createElement: tag => new Element(tag) }, apiUrl: value => `/api${value}`,
    });
    const strip = new Element("div");
    const widget = { els: { texturingViews: strip } };
    methods._renderTexturingViews.call(widget, { phase: "views", coverage: .25, active_view: 0,
        views: [{ label: "front", state: "generating", base_url: "/front.png" }, { label: "back", state: "pending" }] });
    assert.equal(strip.hidden, false);
    assert.match(strip.children[0].textContent, /25%/);
    const cards = strip.children[1];
    assert.equal(cards.children[0]["is-active"], true);
    assert.equal(cards.children[0].children[1].children[0].src, "/api/front.png");
    assert.equal(cards.children[0].children[1].children[1].tag, "span");
    assert.equal(cards.children[1].children[2].textContent, "Queued");
    methods._renderTexturingViews.call(widget, null);
    assert.equal(strip.hidden, true);
    assert.equal(strip.children.length, 0);
});

test("Refinement switch updates immediately, persists, and selects its own model requirements", () => {
    const start = studio.indexOf("    _generatorCapability(");
    const end = studio.indexOf("    _syncGeneratorUI()", start);
    const syncStart = studio.indexOf("    _syncRefineTextures()");
    const syncEnd = studio.indexOf("    _renderTexturingViews(", syncStart);
    const methods = vm.runInNewContext(`({${studio.slice(start, end)},${studio.slice(syncStart, syncEnd)}})`, {
        safeObject: value => value && typeof value === "object" ? value : {},
        clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
    });
    const control = new Element("button");
    const basic = { weights: { ready: true }, runtime: { ready: true }, refinement: {
        weights: { ready: false }, runtime: { ready: false, missing_nodes: ["TextEncodeQwenImage21"] },
    } };
    let saved = 0, synced = 0;
    const widget = { ...methods, settings: { generator: "trellis2", mesh_refine_textures: false },
        els: { refineTextures: control, refineResolutionField: new Element("label"),
            refineResolution: new Element("input"), refineResolutionValue: new Element("span"),
            guidanceValue: new Element("span") }, capabilities: { generators: { trellis2: basic, triposplat: basic } },
        _syncGeneratorUI() { synced++; }, _scheduleStateSave() { saved++; } };
    widget._syncRefineTextures();
    assert.equal(widget.els.refineResolutionField.hidden, true);
    assert.equal(widget.els.refineResolutionValue.textContent, "4.0 MP");
    assert.equal(widget._generatorCapability().weights.ready, true);
    const bindingStart = studio.indexOf('        this._listen(this.els.refineTextures, "click", () => {');
    const bindingEnd = studio.indexOf("        });", bindingStart) + "        });".length;
    let click;
    widget._listen = (_control, event, callback) => { assert.equal(event, "click"); click = callback; };
    vm.runInNewContext(`(function() {${studio.slice(bindingStart, bindingEnd)}})`).call(widget);
    click();
    assert.equal(control["aria-checked"], "true");
    assert.equal(widget.els.refineResolutionField.hidden, false);
    assert.equal(widget._generatorCapability().weights.ready, false);
    assert.equal(widget._generatorCapability("triposplat").weights.ready, true);
    assert.equal(JSON.parse(JSON.stringify(widget.settings)).mesh_refine_textures, true);
    const settingsStart = studio.indexOf("        const settings = [");
    const settingsEnd = studio.indexOf('        this._listen(this.els.removeBackground, "click"', settingsStart);
    let input;
    widget._listen = (element, event, callback) => {
        if (element === widget.els.refineResolution && event === "input") input = callback;
    };
    vm.runInNewContext(`(function() {${studio.slice(settingsStart, settingsEnd)}})`).call(widget);
    widget.els.refineResolution.value = "2";
    input();
    assert.equal(widget.els.refineResolutionValue.textContent, "2.0 MP");
    assert.equal(widget.els.refineResolution["aria-valuetext"], "2.0 megapixels");
    assert.equal(JSON.parse(JSON.stringify(widget.settings)).mesh_refine_resolution_mp, 2);
    click();
    assert.equal(control["aria-checked"], "false");
    assert.equal(widget.els.refineResolutionField.hidden, true);
    assert.equal(widget.settings.mesh_refine_resolution_mp, 2);
    assert.equal(widget._generatorCapability().weights.ready, true);
    assert.equal(saved, 3);
    assert.equal(synced, 2);
});
