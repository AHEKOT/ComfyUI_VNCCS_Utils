import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { forceUniCanvasPresetModelSettings } from "../web/vnccs_unicanvas_presets.mjs";

const source = readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const presets = JSON.parse(readFileSync(new URL("../config/unicanvas_presets.json", import.meta.url), "utf8")).presets;
const preset = presets.find(p => p.id === "krea2_edit");
class Input {
  constructor(type = "number") { this.type = type; this.value = ""; this.attributes = {}; }
  setAttribute(name, value) { this.attributes[name] = value; }
}
const context = { HTMLInputElement: Input, forceUniCanvasPresetModelSettings };
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf("const NUMERIC_SETTINGS"), source.indexOf("const TOOL_ICONS")), context);
const prototype = vm.runInContext(source.slice(source.indexOf("class UniCanvasWidget {"), source.indexOf("\napp.registerExtension(")) + "\nUniCanvasWidget.prototype", context);
function widget() {
  const slider = new Input("range"), number = new Input(), label = {};
  const w = Object.assign(Object.create(prototype), {
    settings: { ...preset.settings },
    denoiseControl: { querySelector: () => label, querySelectorAll: () => [slider, number] },
    syncInferenceControls() {},
    getModelBase() { return this.settings.generation_mode; },
  });
  return { w, slider, number, label };
}

test("Krea2 Edit frontend module matches the card and backend workflow defaults", () => {
  const module = vm.runInContext('getUniCanvasModelModule("krea2-edit")', context);
  assert.equal(module.isEditModel, true);
  assert.deepEqual(JSON.parse(JSON.stringify(module.defaults)), preset.settings);
  for (const name of ["krea2_turbo_fp8_scaled.safetensors", "krea2_raw_bf16.safetensors"]) {
    assert.ok(module.detect.some(token => name.includes(token)));
  }
});

test("likeness input changes the paired control immediately and keeps numeric drafts", () => {
  const { w, slider, number, label } = widget();
  w.syncDenoiseControls();
  assert.equal(label.textContent, "Likeness");
  assert.equal(slider.max, "10");
  assert.equal(slider.value, "4");
  assert.equal(number.attributes["aria-label"], "Likeness");
  slider.value = "6.3";
  w.updateDenoiseControlInput(slider);
  assert.equal(w.settings.krea2_likeness, 6.3);
  assert.equal(number.value, "6.3");
  number.value = "3.";
  w.updateDenoiseControlInput(number);
  assert.equal(slider.value, "3");
  assert.equal(number.value, "3.");
  number.value = "0";
  w.updateDenoiseControlInput(number);
  assert.equal(w.settings.krea2_likeness, 0);
  assert.equal(slider.value, "0");
  assert.match(source, /denoiseControl\.addEventListener\("input",[\s\S]*?this\.updateDenoiseControlInput\(target\)/);
});

test("switching model restores denoise and ControlNet ranges and keeps likeness", () => {
  const { w, slider, label } = widget();
  w.settings.krea2_likeness = 7;
  for (const mode of ["sdxl", "z_image", "anima", "krea2_edit"]) {
    w.settings.generation_mode = mode;
    w.syncDenoiseControls();
    assert.equal(slider.max, mode === "krea2_edit" ? "10" : "1");
    assert.equal(label.textContent, mode === "krea2_edit" ? "Likeness" : mode === "sdxl" ? "Denoise" : "ControlNet strength");
  }
  assert.equal(slider.value, "7");
});

test("preset switches and serialized settings preserve likeness while pinning mandatory LoRA", () => {
  const { w } = widget();
  w.settings.krea2_likeness = 5.7;
  w.snapshotPresetRuntimeSettings(preset);
  w.applyPresetSettings(presets.find(p => p.id === "sdxl"));
  w.settings.krea2_likeness = 1;
  w.applyPresetSettings(preset);
  assert.equal(w.settings.krea2_likeness, 5.7);
  w.settings.krea2_edit_lora_name = "wrong.safetensors";
  forceUniCanvasPresetModelSettings(w.settings, preset);
  assert.equal(w.settings.krea2_edit_lora_name, preset.settings.krea2_edit_lora_name);
  const restored = JSON.parse(JSON.stringify(w.settings));
  assert.equal(restored.krea2_likeness, 5.7);
  assert.equal(restored.preset_runtime_settings.krea2_edit.krea2_likeness, 5.7);
});
