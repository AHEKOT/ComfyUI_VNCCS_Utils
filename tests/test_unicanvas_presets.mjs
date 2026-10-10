import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { UNICANVAS_QWEN21_MODULE } from "../web/unicanvas/qwen21.mjs";

import {
    forceUniCanvasPresetModelSettings,
    getUniCanvasPresetModelAsset,
    getUniCanvasPresetModelName,
} from "../web/unicanvas/presets.mjs";


const sdxlPreset = {
    id: "sdxl",
    title: "Illustrious SDXL",
    settings: {
        generation_mode: "sdxl",
        model_loader: "checkpoint",
        ckpt_name: "Illustrious/ILFlatMix.safetensors",
    },
    assets: [
        { role: "checkpoint", name: "ILFlatMix" },
        { role: "vae", name: "Unrelated VAE" },
    ],
};


test("UniCanvas preset card resolves the concrete primary model name", () => {
    assert.equal(getUniCanvasPresetModelAsset(sdxlPreset), sdxlPreset.assets[0]);
    assert.equal(getUniCanvasPresetModelName(sdxlPreset), "ILFlatMix");
    assert.equal(getUniCanvasPresetModelName({
        settings: { ckpt_name: String.raw`Illustrious\FallbackModel.safetensors` },
    }), "FallbackModel");
});


test("UniCanvas preset card renders the resolved model name", async () => {
    const source = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");

    assert.match(source, /const modelName = turbo \? "" : getUniCanvasPresetModelName\(preset\)/);
    assert.ok(source.includes('vnccs-uc-model-card-model">${row ? "" : "Model: "}${this._escape(modelName)}'));
});


test("selected UniCanvas preset forces model identity but preserves runtime settings", () => {
    const settings = {
        model_selection_mode: "presets",
        selected_preset_id: "sdxl",
        generation_mode: "sdxl",
        model_loader: "checkpoint",
        ckpt_name: String.raw`3d\hunyuan3d-dit-v2-mv-turbo_fp16.safetensors`,
        steps: 31,
    };

    forceUniCanvasPresetModelSettings(settings, sdxlPreset);

    assert.equal(settings.ckpt_name, "Illustrious/ILFlatMix.safetensors");
    assert.equal(settings.selected_preset_id, "sdxl");
    assert.equal(settings.steps, 31);
});


test("Qwen Edit 2.1 shares the VNCCS model filenames and restores turbo across folders", async () => {
    const source = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
    const presets = JSON.parse(await readFile(new URL("../config/unicanvas_presets.json", import.meta.url), "utf8")).presets;
    const preset = presets.find((entry) => entry.id === "qwen_image21");
    assert.equal(preset.title, "Qwen Edit 2.1");
    assert.equal(UNICANVAS_QWEN21_MODULE.qwen_image21.label, preset.title);
    for (const key of ["diffusion_model_name", "clip_name", "vae_name"]) {
        assert.equal(UNICANVAS_QWEN21_MODULE.qwen_image21.defaults[key], preset.settings[key]);
    }
    assert.ok(!presets.some((entry) => entry.id === "qwen_image_edit"));
    assert.ok(!source.includes("qwen_image_edit"));

    const method = source.slice(source.indexOf("  isPresetTurboEnabled(preset) {"), source.indexOf("  getPresetTurboPreviousKey(preset) {"));
    const widget = runInNewContext(`({ ${method.trim()} })`);
    const filename = preset.turbo.asset.local_path.split("/").pop();
    preset.turbo.asset.relative_name = `QI2/Viggle/${filename}`;
    widget.normalizeRelName = (value) => String(value || "").replaceAll("\\", "/").toLowerCase();
    widget.settings = { qwen21_turbo_enabled: true, qwen_lora_name: `viggle\\${filename}`, qwen_lora_strength: 1 };
    assert.equal(widget.isPresetTurboEnabled(preset), true);
    widget.settings.qwen21_turbo_enabled = false;
    assert.equal(widget.isPresetTurboEnabled(preset), false);
    widget.settings.qwen21_turbo_enabled = true;
    widget.settings.qwen_lora_name = "another.safetensors";
    assert.equal(widget.isPresetTurboEnabled(preset), false);
});

test("standalone hides the complete negative field only while its family's Turbo is active", async () => {
    const source = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
    const presets = JSON.parse(await readFile(new URL("../config/unicanvas_presets.json", import.meta.url), "utf8")).presets;
    const prototype = runInNewContext(source.slice(source.indexOf("class UniCanvasWidget {"), source.indexOf("\napp.registerExtension("))
        + "\nUniCanvasWidget.prototype", { getUniCanvasModelModule: key => ({ key }) });
    const field = { hidden:false };
    const input = { value:"Keep this negative prompt", closest: selector => selector === ".vnccs-uc-field" ? field : null };
    const widget = Object.create(prototype);
    widget.standalone = true; widget.presets = presets;
    widget.container = {
        querySelector: selector => selector === '[data-setting="negative"]' ? input : null,
        querySelectorAll: () => [],
    };
    widget.normalizeGenerationSettings = () => ({ loader:{ key:"diffusion_model" } });
    widget.getModelBase = () => widget.settings.generation_mode;
    for (const name of ["syncInferenceControls", "syncDenoiseControls", "syncSeedModeControl", "renderModelSelectionControls",
        "renderLoraStackControls", "syncPromptGuide", "autoResizePromptTextareas", "syncSettingsToWidget"]) widget[name] = () => {};
    widget.presetAssetStatus = () => ({ installed:true });
    for (const mode of ["presets", "custom"]) {
        for (const preset of presets.filter(item => item.turbo)) {
            preset.turbo.asset.relative_name = preset.turbo.asset.local_path.replace("models/loras/", "");
            widget.settings = { ...preset.settings, model_selection_mode:mode, selected_preset_id:preset.id, negative:input.value };
            widget.syncPromptControls(); assert.equal(field.hidden, false, `${preset.id}: base`);
            widget.togglePresetTurbo(preset.id); assert.equal(field.hidden, true, `${preset.id}: Turbo`);
            widget.togglePresetTurbo(preset.id); assert.equal(field.hidden, false, `${preset.id}: restored`);
            assert.equal(widget.settings.negative, input.value, "toggling keeps the user's text");
            widget.togglePresetTurbo(preset.id);
            widget.standalone = false; widget.syncPromptControls();
            assert.equal(field.hidden, false, "node UI keeps its original negative field");
            widget.standalone = true;
            widget.settings.generation_mode = "flux_klein"; widget.settings.model_selection_mode = "custom";
            widget.syncPromptControls(); assert.equal(field.hidden, false, "a different family ignores stale Turbo settings");
        }
    }
});


test("MiniMax H3 preset pins the family and ships its three model assets", async () => {
  const presets = JSON.parse(await readFile(new URL("../config/unicanvas_presets.json", import.meta.url), "utf8")).presets;
  const h3 = presets.find((preset) => preset.id === "minimax_h3");
  assert.ok(h3, "the minimax_h3 preset is missing");
  assert.equal(h3.settings.generation_mode, "minimax_h3");
  assert.equal(h3.settings.clip_type, "minimax");
  assert.equal(h3.settings.minimax_h3_steps, h3.settings.steps);
  assert.deepEqual(h3.assets.map((asset) => asset.role), ["diffusion_model", "clip", "vae"]);
  for (const asset of h3.assets) assert.match(asset.local_path, /^models\/[a-z_]+\/[^/]+\.safetensors$/);
});


test("MiniMax H3 preset ships the 3-step TaoMate Turbo LoRA on the shared turbo card", async () => {
  const presets = JSON.parse(await readFile(new URL("../config/unicanvas_presets.json", import.meta.url), "utf8")).presets;
  const { turbo } = presets.find((preset) => preset.id === "minimax_h3");
  assert.equal(turbo.setting, "minimax_h3_lora_name");
  assert.equal(turbo.strength_setting, "minimax_h3_lora_strength");
  assert.equal(turbo.turbo_settings.steps, 3);
  assert.equal(turbo.turbo_settings.minimax_h3_steps, 3);
  assert.equal(turbo.asset.hf_repo, "Robert1212star/TaoMate-H3-3Step-ComfyUI");
  assert.equal(turbo.asset.hf_path, "taomate_h3_3step_comfy.safetensors");
});


test("rendered model menu pins Qwen second and Krea2 Turbo third even with an old server catalog", async () => {
    const source = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
    const presets = JSON.parse(await readFile(new URL("../config/unicanvas_presets.json", import.meta.url), "utf8")).presets;
    const prototype = runInNewContext(source.slice(source.indexOf("class UniCanvasWidget {"), source.indexOf("\napp.registerExtension("))
        + "\nUniCanvasWidget.prototype");
    const widget = Object.create(prototype);
    const oldOrder = ["sdxl", "anima", "flux_klein", "z_image", "qwen_image21", "minimax_h3", "krea2_edit_raw", "krea2_edit"];
    const oldCatalog = oldOrder.map(id => presets.find(preset => preset.id === id));
    const snapshot = JSON.stringify(oldCatalog);
    for (const catalog of [oldCatalog, presets]) {
        widget.presets = catalog;
        const rows = [...widget.groupPresetsByType().values()].flat();
        assert.deepEqual(rows.slice(0, 3).map(preset => preset.id), ["sdxl", "qwen_image21", "krea2_edit"]);
        assert.equal(rows[3].id, "krea2_edit_raw", "Raw stays beside its Turbo family");
        assert.deepEqual(rows.slice(4).map(preset => preset.id), ["anima", "flux_klein", "z_image", "minimax_h3"]);
    }
    assert.equal(JSON.stringify(oldCatalog), snapshot, "rendering never mutates the server catalog");
    widget.presets = presets.filter(preset => !["sdxl", "qwen_image21", "krea2_edit"].includes(preset.id));
    assert.deepEqual([...widget.groupPresetsByType().values()].flat().map(preset => preset.id), widget.presets.map(preset => preset.id));
});
