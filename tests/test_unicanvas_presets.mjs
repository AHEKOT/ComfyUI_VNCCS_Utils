import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    forceUniCanvasPresetModelSettings,
    getUniCanvasPresetModelAsset,
    getUniCanvasPresetModelName,
} from "../web/vnccs_unicanvas_presets.mjs";


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
    assert.match(source, /vnccs-uc-model-card-model">Model: \$\{this\._escape\(modelName\)\}/);
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
