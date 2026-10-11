import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import {
    MODEL_MEMORY_ROUTE,
    ModelMemory,
    entryFromSettings,
    modelMemoryKey,
    patchFromEntry,
} from "../web/unicanvas/model_memory.mjs";
import { INFERENCE_SCALE_MAX, INFERENCE_SCALE_MIN, editInferenceScale, parseInferenceScale, inferenceScaleMegapixels, inferenceScaleFromMegapixels, INFERENCE_SCALE_MP_MIN, INFERENCE_SCALE_MP_MAX, INFERENCE_SCALE_MP_STEP } from "../web/unicanvas/scale_edit.mjs";

const custom = { model_loader: "diffusion", generation_mode: "anima", diffusion_model_name: "anima.safetensors", clip_name: "qwen.safetensors", vae_name: "vae.safetensors", clip_type: "stable_diffusion", lora_stack: [{ name: "style.safetensors", strength: 0.7 }, { name: "", strength: 1 }] };

test("inference scale updates both panels and the HUD immediately without rendering the canvas", () => {
    const source = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
    const methods = source.slice(source.indexOf("  getOptimalDimension() {"), source.indexOf("  getDenoiseControlSetting() {"));
    const hudMethod = source.slice(source.indexOf("  updateHud() {"), source.indexOf("  getStageViewportSize() {"));
    const captureMethod = source.slice(source.indexOf("  captureGenerationSettings() {"), source.indexOf("  async draw() {"));
    const widget = runInNewContext(`(class { ${methods}${hudMethod}${captureMethod} }).prototype`, { inferenceScaleMegapixels, inferenceScaleFromMegapixels, INFERENCE_SCALE_MP_MIN, INFERENCE_SCALE_MP_MAX, INFERENCE_SCALE_MP_STEP });
    const slider = { value: "1" }, customSlider = { value: "1" };
    const labels = [{ textContent: "" }, { textContent: "" }];
    Object.assign(widget, { standalone:true, settings:{ inference_scale:1, seed_mode:"fixed" },
        bbox:{ width:1024, height:1024 }, hud:{ innerHTML:"" }, tool:"move", view:{ scale:1 },
        getGridSize:() => 8, roundToMultiple:(value, grid) => Math.round(value/grid)*grid,
        updateZoomResetButton() {}, requestRender() { assert.fail("scale updates need only the HUD"); },
        _isConfigLinked:() => false, normalizeGenerationSettings:() => ({ loader:{ key:"diffusion_model" } }),
        flushSettingsToWidget() {}, makeSettingsPayload() { return { ...this.settings }; }, getModelBase:() => "qwen_image21",
        formatSettingNumber:value => String(value),
        container:{ querySelectorAll:selector => selector === "[data-inference-size]" ? labels : [slider, customSlider] } });
    for (const scale of [1, 1.3, 1.5, 4]) {
        slider.value = String(scale);
        widget.syncInferenceControls(slider);
        assert.equal(customSlider.value, scale.toFixed(1));
        assert.equal(widget.settings.inference_scale, inferenceScaleFromMegapixels(scale));
        assert.equal(slider.step, 0.1);
        assert.equal(slider.min, 1);
        assert.equal(slider.max, 4);
        assert.deepEqual(labels.map(label => label.textContent), [`${scale.toFixed(1)} MP`, `${scale.toFixed(1)} MP`]);
        const size = widget.getInferenceSize();
        assert.match(widget.hud.innerHTML, new RegExp(`infer ${size.width}×${size.height}`));
    }
    assert.equal(widget.getInferenceSize().width, 2048);
    assert.equal(widget.getInferenceSize().height, 2048);
    const request = widget.captureGenerationSettings();
    assert.equal(request.inferenceSize.width, 2048);
    assert.equal(request.inferenceSize.height, 2048);
    assert.equal(request.settings.inference_scale, 2);
    widget.standalone = false;
    widget.settings.inference_scale = 1.25;
    widget.syncInferenceControls();
    assert.equal(slider.step, 0.05);
    assert.equal(slider.min, 0.5);
    assert.equal(slider.max, 3);
    assert.equal(slider.value, "1.25");
    assert.deepEqual(labels.map(label => label.textContent), ["1280×1280", "1280×1280"]);
    assert.match(widget.hud.innerHTML, /infer 1280×1280/);
});

// A fake server: GET returns the stored document, POST stores one entry.
function fakeServer(initial = {}) {
    const state = { entries: { ...initial }, posts: [] };
    const fetch = async (url, options = {}) => {
        assert.equal(url, MODEL_MEMORY_ROUTE);
        if (options.method === "POST") {
            const body = JSON.parse(options.body);
            state.posts.push(body);
            state.entries[body.key] = body.entry;
            return { ok: true, json: async () => ({ schema: 1, entries: state.entries }) };
        }
        return { ok: true, json: async () => ({ schema: 1, entries: state.entries }) };
    };
    return { state, fetch };
}

test("Custom picks are saved to the server per loader + Mode and recalled by a fresh canvas", async () => {
    const server = fakeServer();
    const first = new ModelMemory(server.fetch);
    first.remember(custom);
    first.remember({ ...custom, clip_name: "newer.safetensors" });
    await first.flush();
    assert.equal(server.state.posts.length, 1, "a burst of edits is one request per key");
    assert.equal(server.state.posts[0].key, "diffusion|anima");

    const second = new ModelMemory(server.fetch);
    await second.load();
    const patch = second.recall({ model_loader: "diffusion", generation_mode: "anima" });
    assert.equal(patch.diffusion_model_name, "anima.safetensors");
    assert.equal(patch.clip_name, "newer.safetensors");
    assert.equal(patch.vae_name, "vae.safetensors");
    assert.equal(patch.clip_type, "stable_diffusion");
    assert.deepEqual(patch.lora_stack, [{ name: "style.safetensors", strength: 0.7 }], "empty LoRA rows are not remembered");
    assert.equal(patch.lora_rows, 1);
    assert.deepEqual(second.recall({ model_loader: "gguf", generation_mode: "anima" }), {}, "another loader has its own memory");
    assert.deepEqual(second.recall({ model_loader: "diffusion", generation_mode: "flux_klein" }), {}, "another Mode has its own memory");
});

test("files that are gone from the assets lists are not recalled", () => {
    const entry = entryFromSettings(custom);
    const patch = patchFromEntry(entry, {
        diffusion_models: ["other.safetensors"], text_encoders: ["qwen.safetensors"], vae_models: [], loras: ["style.safetensors"],
    });
    assert.equal(patch.diffusion_model_name, undefined, "a missing diffusion model is dropped");
    assert.equal(patch.clip_name, "qwen.safetensors");
    assert.equal(patch.vae_name, undefined, "a confirmed empty catalog drops the remembered file");
    assert.equal(patch.lora_stack.length, 1);
    assert.deepEqual(patchFromEntry(entry, { loras: ["x.safetensors"] }).lora_stack, []);
    assert.deepEqual(patchFromEntry(entry, { loras: [] }).lora_stack, [], "deleting the last installed LoRA clears the stack");
    assert.equal(patchFromEntry(entry).vae_name, "vae.safetensors", "an unavailable catalog keeps remembered files");
});

test("recalling an explicitly empty LoRA stack clears the previous model's LoRAs", () => {
    const source = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
    const memory = new ModelMemory();
    memory.entries["diffusion|anima"] = entryFromSettings({ ...custom, lora_stack: [] });
    const methods = source.slice(source.indexOf("  recallModelChoice("), source.indexOf("  changeLoraRows("));
    const widget = runInNewContext(`(class { ${methods} }).prototype`, { sharedModelMemory: () => memory });
    Object.assign(widget, { settings: { ...custom, model_selection_mode: "custom" }, assets: {}, renderLoraStackControls() {} });
    assert.equal(widget.recallModelChoice(), true);
    assert.deepEqual(widget.settings.lora_stack, []);
    assert.equal(widget.settings.diffusion_model_name, custom.diffusion_model_name);
    assert.equal(patchFromEntry({ clip_name: "legacy" }).lora_stack, undefined, "old entries without a stack do not override it");
});

test("the widget only treats empty asset lists as authoritative after a successful load", async () => {
    const source = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
    const memory = new ModelMemory();
    memory.entries["diffusion|anima"] = entryFromSettings(custom);
    const methods = source.slice(source.indexOf("  recallModelChoice("), source.indexOf("  changeLoraRows("));
    const widget = runInNewContext(`(class { ${methods} }).prototype`, { sharedModelMemory: () => memory });
    Object.assign(widget, { settings: { ...custom, model_selection_mode: "custom" },
        assets: { loras: [] }, renderLoraStackControls() {} });
    widget.recallModelChoice();
    assert.equal(widget.settings.lora_stack[0].name, "style.safetensors", "the initial empty lists are still loading");
    widget._assetsLoaded = true;
    widget.recallModelChoice();
    assert.deepEqual(widget.settings.lora_stack, []);

    const errors = [], original = { loras: [] };
    const load = source.slice(source.indexOf("  async _loadAssets("), source.indexOf("  async loadPresets("));
    const loader = runInNewContext(`(class { ${load} }).prototype`, {
        sharedModelMemory: () => memory,
        fetch: async () => ({ ok: false, status: 500, json: async () => ({ error: "Assets unavailable" }) }),
    });
    Object.assign(loader, { assets: original, setStatus: message => errors.push(message) });
    await loader._loadAssets();
    assert.equal(loader.assets, original);
    assert.equal(loader._assetsLoaded, undefined);
    assert.match(errors[0], /Assets unavailable/);
});

test("a failing server never throws and recalls nothing", async () => {
    const broken = async () => { throw new Error("offline"); };
    const memory = new ModelMemory(broken);
    await memory.load();
    memory.remember(custom);
    await memory.flush();
    assert.equal(memory.recall(custom).diffusion_model_name, "anima.safetensors", "the local copy still works this session");
    assert.deepEqual(patchFromEntry(null), {});
    assert.equal(modelMemoryKey({}), "checkpoint|sdxl");
    const notOk = new ModelMemory(async () => ({ ok: false, json: async () => ({}) }));
    await notOk.load();
    assert.deepEqual(notOk.recall(custom), {});
});

test("nothing is stored in the browser any more", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../web/unicanvas/model_memory.mjs", import.meta.url), "utf8");
    assert.ok(!source.includes("localStorage"), "the memory lives in the user's ComfyUI directory");
});

test("typed inference scales accept both decimal separators and stay in range", () => {
    assert.equal(parseInferenceScale("1.5"), 1.5);
    assert.equal(parseInferenceScale(" 1,25 "), 1.25);
    assert.equal(parseInferenceScale("10"), INFERENCE_SCALE_MAX);
    assert.equal(parseInferenceScale("0.1"), INFERENCE_SCALE_MIN);
    for (const bad of ["", "abc", "0", "-2", null]) assert.equal(parseInferenceScale(bad), null);
});

function fakeDocument() {
    const listeners = {};
    const input = {
        value: "", dataset: {}, style: {}, remove() { this.removed = true; }, focus() {}, select() {}, setAttribute() {},
        addEventListener(type, handler) { listeners[type] = handler; },
    };
    return { input, listeners, createElement: () => input };
}

test("double-clicking the size label edits the scale; Enter applies and Esc cancels", () => {
    for (const [key, expected] of [["Enter", 1.5], ["Escape", 1]]) {
        const doc = fakeDocument();
        const label = { dataset: {}, hidden: false, ownerDocument: doc, after() {} };
        const calls = [];
        const widget = { settings: { inference_scale: 1 }, syncInferenceControls: () => calls.push("sync"), syncSettingsToWidget: () => calls.push("save") };
        editInferenceScale(widget, label);
        assert.equal(label.hidden, true, "the label is replaced while editing");
        doc.input.value = "1,5";
        doc.listeners.keydown({ key, preventDefault() {}, stopPropagation() {} });
        assert.equal(label.hidden, false);
        assert.equal(widget.settings.inference_scale, expected);
        assert.deepEqual(calls, key === "Enter" ? ["sync", "save"] : []);
        assert.ok(doc.input.removed);
    }
});


test("standalone scale follows VNCCS area presets and tenth steps", () => {
    for (let tenth = 10; tenth <= 40; tenth++) {
        const mp = tenth / 10;
        const scale = inferenceScaleFromMegapixels(mp);
        assert.equal(inferenceScaleMegapixels(scale), mp);
        assert.ok(Math.abs(scale * scale - (mp === 1.3 ? 1344 / 1024 : mp)) < 1e-12);
    }
    assert.equal(parseInferenceScale("1,35", true), Math.sqrt(1.4));
    assert.equal(parseInferenceScale("0.05", true), 1);
    assert.equal(parseInferenceScale("99", true), 2);
});

test("standalone exact scale previews on input and Escape restores the previous value", () => {
    const doc = fakeDocument();
    const label = { dataset:{}, hidden:false, ownerDocument:doc, after() {} };
    let saves = 0, renders = 0;
    const widget = { standalone:true, settings:{ inference_scale:1 }, syncInferenceControls() {},
        syncSettingsToWidget() { saves++; }, requestRender() { renders++; } };
    editInferenceScale(widget, label);
    assert.equal(doc.input.value, "1.0");
    doc.input.value = "1,35";
    doc.listeners.input();
    assert.equal(widget.settings.inference_scale, Math.sqrt(1.4));
    assert.equal(renders, 1);
    doc.listeners.keydown({ key:"Escape", preventDefault() {}, stopPropagation() {} });
    assert.equal(widget.settings.inference_scale, 1);
    assert.equal(saves, 0);
    assert.equal(renders, 2);
});

test("node exact scale previews each input, skips invalid text, and Escape restores paired controls", () => {
    const doc = fakeDocument();
    const label = { dataset: {}, ownerDocument: doc, after() {} };
    const synced = [];
    let saves = 0, renders = 0;
    const widget = { standalone: false, settings: { inference_scale: 1 },
        syncInferenceControls() { synced.push(this.settings.inference_scale); },
        syncSettingsToWidget() { saves++; }, requestRender() { renders++; } };
    editInferenceScale(widget, label);
    for (const text of ["1,5", "", "2"]) {
        doc.input.value = text;
        doc.listeners.input();
    }
    assert.equal(widget.settings.inference_scale, 2);
    assert.deepEqual(synced, [1.5, 2]);
    assert.equal(saves, 0);
    doc.listeners.keydown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
    assert.equal(widget.settings.inference_scale, 1);
    assert.deepEqual(synced, [1.5, 2, 1]);
    assert.equal(renders, 3);
    doc.listeners.blur();
    assert.equal(saves, 0, "blur after Escape must not commit");
});
