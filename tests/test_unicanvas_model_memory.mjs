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
import { INFERENCE_SCALE_MAX, INFERENCE_SCALE_MIN, editInferenceScale, parseInferenceScale } from "../web/unicanvas/scale_edit.mjs";

const custom = { model_loader: "diffusion", generation_mode: "anima", diffusion_model_name: "anima.safetensors", clip_name: "qwen.safetensors", vae_name: "vae.safetensors", clip_type: "stable_diffusion", lora_stack: [{ name: "style.safetensors", strength: 0.7 }, { name: "", strength: 1 }] };

test("inference scale labels update both tab panels immediately and preserve the node size preview", () => {
    const source = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
    const methods = source.slice(source.indexOf("  syncInferenceControls(source = null) {"), source.indexOf("  getDenoiseControlSetting() {"));
    const widget = runInNewContext(`(class { ${methods} }).prototype`);
    const slider = { value: "1" }, customSlider = { value: "1" };
    const labels = [{ textContent: "" }, { textContent: "" }];
    Object.assign(widget, { standalone:true, settings:{ inference_scale:1 },
        getInferenceSize:() => ({ width:1280, height:1280 }),
        formatSettingNumber:value => String(value),
        container:{ querySelectorAll:selector => selector === "[data-inference-size]" ? labels : [slider, customSlider] } });
    for (const scale of [0.5, 1, 1.25, 3]) {
        widget.settings.inference_scale = scale;
        slider.value = String(scale);
        widget.syncInferenceControls(slider);
        assert.equal(customSlider.value, String(scale));
        assert.deepEqual(labels.map(label => label.textContent), [`${scale}×`, `${scale}×`]);
    }
    widget.standalone = false;
    widget.syncInferenceControls();
    assert.deepEqual(labels.map(label => label.textContent), ["1280×1280", "1280×1280"]);
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
    assert.equal(patch.vae_name, "vae.safetensors", "an empty (not loaded) list keeps the remembered file");
    assert.equal(patch.lora_stack.length, 1);
    assert.equal(patchFromEntry(entry, { loras: ["x.safetensors"] }).lora_stack, undefined);
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
