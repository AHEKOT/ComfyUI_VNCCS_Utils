import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


const panelSource = await readFile(new URL("../web/unicanvas/qwen21.mjs", import.meta.url), "utf8");
const mainSource = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");


test("engine picker exposes the QwenImage21 family tab", () => {
    assert.match(panelSource, /label:\s*"Qwen Edit 2.1"/, "family tab label 'QwenImage21' missing from the Qwen-Image-2.1 module");
    assert.match(panelSource, /key:\s*QWEN21_MODULE_KEY/, "family module key wiring missing");
    assert.match(panelSource, /base:\s*QWEN21_MODULE_KEY/, "family module base wiring missing");
    // The node widget and the standalone host share this one registry entry.
    assert.match(mainSource, /import \{[^}]*UNICANVAS_QWEN21_MODULE[^}]*\} from "\.\/unicanvas\/qwen21\.mjs(\?v=\d+)?"/, "main widget must import the QwenImage21 module");
    assert.match(mainSource, /\.\.\.UNICANVAS_QWEN21_MODULE/, "QwenImage21 must be spread into the shared UNICANVAS_MODEL_MODULES registry");
});


test("Spectrum acceleration is gone from the frontend", () => {
    assert.doesNotMatch(panelSource, /spectrum/i);
    assert.doesNotMatch(mainSource, /spectrum/i);
});


test("Qwen-Image-2.1 has no transparency switch or panel", () => {
    assert.doesNotMatch(panelSource, /qwen21_opaque_output|transparent output|data-qwen21-panel|type=.?checkbox/);
    assert.doesNotMatch(mainSource, /syncQwen21Panel|vnccs-uc-qwen21-panel/);
});

test("edit families show a full-width Steps field with a hint and hide the generic one", () => {
    assert.match(mainSource, /data-edit-steps-panel/, "an edit-steps panel must exist");
    assert.match(mainSource, /data-edit-steps-help/, "the panel needs a help button carrying the hint");
    assert.match(mainSource, /data-generic-steps/, "the generic Steps field must be toggleable");
    assert.ok(mainSource.includes("<image1>"), "the QI2.1 hint must name the image1 convention");
});

test("QI2.1 Turbo LoRA uses the shared preset turbo card, not a bespoke switch", async () => {
  assert.doesNotMatch(panelSource, /qwen21TurboToggle|qwen21TurboDownload/, "the panel must not render its own turbo controls");
  const presets = JSON.parse(await readFile(new URL("../config/unicanvas_presets.json", import.meta.url), "utf8")).presets;
  const qi = presets.find((preset) => preset.id === "qwen_image21");
  assert.ok(qi, "the qwen_image21 preset is missing");
  assert.equal(qi.settings.generation_mode, "qwen_image21");
  assert.equal(qi.turbo.setting, "qwen_lora_name");
  assert.equal(qi.turbo.strength_setting, "qwen_lora_strength");
  assert.equal(qi.turbo.enable_setting, "qwen21_turbo_enabled");
  assert.deepEqual(qi.turbo.turbo_settings, { steps: 6, cfg: 1 });
  assert.equal(qi.turbo.asset.local_path, "models/loras/QI2/Viggle/Qwen-Image-2.1-viggle-turbo-v0.2.1-6step-lora-r128.safetensors");
  assert.match(qi.turbo.asset.hf_revision, /^[0-9a-f]{40}$/);
});

test("edit model reference images upload exists in the main widget", () => {
  assert.match(mainSource, /data-edit-refs-badge/, "the cards icon must carry a count badge");
  assert.ok(mainSource.includes('data-action="edit-refs"'), "the cards icon button must exist");
  assert.ok(mainSource.includes('remove_bg_model: "birefnet"'), "BiRefNet must be the default remove bg backend");
});
