import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


const panelSource = await readFile(new URL("../web/vnccs_unicanvas_qwen21.mjs", import.meta.url), "utf8");
const mainSource = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");


test("engine picker exposes the QwenImage21 family tab", () => {
    assert.match(panelSource, /label:\s*"QwenImage21"/, "family tab label 'QwenImage21' missing from the Qwen-Image-2.1 module");
    assert.match(panelSource, /key:\s*QWEN21_MODULE_KEY/, "family module key wiring missing");
    assert.match(panelSource, /base:\s*QWEN21_MODULE_KEY/, "family module base wiring missing");
    // The node widget and the standalone host share this one registry entry.
    assert.match(mainSource, /import \{[^}]*UNICANVAS_QWEN21_MODULE[^}]*\} from "\.\/vnccs_unicanvas_qwen21\.mjs(\?v=\d+)?"/, "main widget must import the QwenImage21 module");
    assert.match(mainSource, /\.\.\.UNICANVAS_QWEN21_MODULE/, "QwenImage21 must be spread into the shared UNICANVAS_MODEL_MODULES registry");
});


test("Spectrum panel declares every parameter", () => {
    const params = [
        "warmup_steps",
        "tail_actual_steps",
        "window_size",
        "flex_window",
        "max_consecutive_forecasts",
        "history_points",
        "chebyshev_degree",
        "ridge_lambda",
        "blend_weight",
        "cache_device",
        "force_actual_on_control",
    ];
    assert.doesNotMatch(panelSource, /name:\s*"debug"/, "Spectrum debug follows the global UniCanvas debug mode");
    for (const name of params) {
        assert.match(panelSource, new RegExp('name:\\s*"' + name + '"'), "missing Spectrum parameter: " + name);
    }
    assert.match(panelSource, /data-spectrum-toggle/, "Spectrum enable toggle missing");
    assert.match(panelSource, /"Spectrum acceleration"/, "Spectrum panel title (tooltip) missing");
});


test("Spectrum presets are moderate, aggressive and quality", () => {
    assert.match(panelSource, /QWEN21_SPECTRUM_PRESETS\s*=\s*\{/, "Spectrum preset table missing");
    assert.match(panelSource, /moderate:\s*\{/, "moderate preset missing");
    assert.match(panelSource, /aggressive:\s*\{/, "aggressive preset missing");
    assert.match(panelSource, /quality:\s*\{/, "quality preset missing");
    assert.match(panelSource, /QWEN21_SPECTRUM_PRESET_NAMES\s*=\s*\["moderate", "aggressive", "quality"\]/, "preset selector list mismatch");
    // moderate = paper default; the tunings follow the vendored upstream guide.
    const moderate = panelSource.match(/moderate:\s*\{([\s\S]*?)\n\s*\},/);
    assert.ok(moderate, "moderate preset block not found");
    assert.match(moderate[1], /warmup_steps:\s*5/);
    assert.match(moderate[1], /flex_window:\s*0\.75/);
    assert.match(moderate[1], /chebyshev_degree:\s*4/);
    const aggressive = panelSource.match(/aggressive:\s*\{([\s\S]*?)\n\s*\},/);
    assert.match(aggressive[1], /flex_window:\s*3\.0/);
    assert.match(aggressive[1], /tail_actual_steps:\s*1/);
    const quality = panelSource.match(/quality:\s*\{([\s\S]*?)\n\s*\},/);
    assert.match(quality[1], /flex_window:\s*0\.4/);
    assert.match(quality[1], /blend_weight:\s*1\.0/);
});


test("Spectrum panel is gated to the Qwen-Image-2.1 family", () => {
    const sync = panelSource.match(/export function syncQwen21SpectrumPanel\(widget\)([\s\S]*?)\n\}/);
    assert.ok(sync, "syncQwen21SpectrumPanel missing");
    assert.match(sync[1], /isQwen21Mode\(/, "gating must consult the QI2.1 family check");
    assert.match(sync[1], /\.display = active \? "" : "none"/, "panel must hide outside the QI2.1 family");
    // The shared picker re-gates on render and on every family switch.
    assert.match(mainSource, /syncQwen21SpectrumPanel\(this\)/, "main widget must sync the Spectrum panel");
    const renderHook = mainSource.match(/renderModelSelectionControls\(\) \{([\s\S]*?)\n  \}/);
    assert.match(renderHook[1], /syncQwen21SpectrumPanel\(this\)/, "panel must gate in renderModelSelectionControls");
    const modeHook = mainSource.match(/applyGenerationModeDefaults\(mode\) \{([\s\S]*?)\n  \}/);
    assert.match(modeHook[1], /syncQwen21SpectrumPanel\(this\)/, "panel must re-gate when the family changes");
});


test("Spectrum controls update visible state continuously from input events", () => {
    assert.match(panelSource, /panel\.addEventListener\("input"/, "continuous input listener missing");
    assert.match(panelSource, /panel\.addEventListener\("change"/, "commit change listener missing");
    // "input" streams the newest value into settings and mirrors it into the
    // paired slider/number controls before any "change" commit happens.
    const input = panelSource.match(/panel\.addEventListener\("input", \(event\) => \{([\s\S]*?)\n  \}\);/);
    assert.ok(input, "input listener body missing");
    assert.match(input[1], /applyControlValue\(widget, panel, target\)/, "input events must apply the control value");
    const change = panelSource.match(/panel\.addEventListener\("change", \(event\) => \{([\s\S]*?)\n  \}\);/);
    assert.ok(change, "change listener body missing");
    assert.match(change[1], /commitSettings\(widget\)/, "change events must commit persistence");
    assert.match(panelSource, /syncSettingsToWidget/, "commit must persist through syncSettingsToWidget");
});


test("Spectrum panel clamps the chebyshev/history pair", () => {
    assert.match(panelSource, /export function clampSpectrumPair\(/, "pair clamp helper missing");
    assert.match(panelSource, /history < degree \+ 1/, "cross-field constraint missing");
    const apply = panelSource.match(/function applyControlValue\(widget, panel, target\) \{([\s\S]*?)\n\}/);
    assert.ok(apply, "applyControlValue missing");
    assert.match(apply[1], /clampSpectrumPair\(spectrum, name\)/, "value updates must clamp the pair");
});


test("Qwen-Image-2.1 output switch and native 2K presets are exposed", () => {
    assert.match(panelSource, /qwen21_opaque_output/, "'opaque output' switch setting missing");
    assert.match(panelSource, /qwen21_aspect_preset/, "native 2K aspect preset setting missing");
    for (const preset of ["2048x2048", "2400x1792", "1792x2400", "2528x1696", "1696x2528", "2752x1536", "1536x2752"]) {
        assert.ok(panelSource.includes(preset), "missing native 2K aspect preset: " + preset);
    }
    assert.match(panelSource, /data-qwen21-panel/, "Qwen-Image-2.1 panel root marker missing");
});

test("QI2.1 panel matches the UniCanvas palette and ships help tooltips", () => {
    assert.ok(panelSource.includes("vnccs-uc-qwen21-styles"), "the panel must inject its UniCanvas-palette styles");
    assert.ok(panelSource.includes("buildQwen21Help"), "help tooltips must be attached");
    assert.ok(panelSource.includes("data-tip"), "tooltips must carry explanation text");
    assert.match(panelSource, /range\.className = "vnccs-uc-range"/, "spectrum sliders must use the shared range styling");
});

test("edit families show a full-width Steps field with a hint and hide the generic one", () => {
    assert.match(mainSource, /data-edit-steps-panel/, "an edit-steps panel must exist");
    assert.match(mainSource, /data-edit-steps-help/, "the panel needs a help button carrying the hint");
    assert.match(mainSource, /data-generic-steps/, "the generic Steps field must be toggleable");
    assert.ok(mainSource.includes("<image1>"), "the QI2.1 hint must name the image1 convention");
});

test("QI2.1 settings fold into an accordion with the turbo switch in the header", () => {
  const shell = panelSource.match(/function buildPanelShell\(\) \{([\s\S]*?)\n\}/);
  assert.ok(shell, "buildPanelShell missing");
  assert.match(shell[1], /qwenTitleText\.textContent = "QI2\.1"/, "the collapsed header must read QI2.1");
  assert.match(shell[1], /qwenTitleText\.title = "Qwen-Image-2\.1 \(QI2\.1\) settings"/, "the header carries the family tooltip");
  assert.match(shell[1], /dataset\.qwen21Expand/, "the header needs its expand markers");
  assert.match(shell[1], /title\.append\([\s\S]*?turboLabel\)/, "the turbo switch must live in the header row");
  assert.match(shell[1], /const qwenBody = document\.createElement\("div"\)/, "the foldable body container is missing");
  assert.match(shell[1], /qwenBody\.hidden = true/, "the body must start folded");
  assert.match(shell[1], /qwenBody\.appendChild\(spectrum\)/, "Spectrum must fold into the accordion body");
  const click = panelSource.match(/panel\.addEventListener\("click", \(event\) => \{([\s\S]*?)\n  \}\);/);
  assert.ok(click, "click listener body missing");
  assert.match(click[1], /target\.dataset\.qwen21Expand !== undefined/, "the header must toggle the folded body");
  assert.match(click[1], /closest\("\.vnccs-uc-help"\)/, "a help icon click must not toggle the control next to it");
});

test("QI2.1 Viggle turbo switch mirrors the other turbo switches", () => {
  assert.match(panelSource, /QWEN21_TURBO_LORA_NAME/, "the Viggle turbo LoRA name must be defined");
  assert.match(panelSource, /Viggle\/Qwen-Image-2\.1-viggle-turbo/, "the HuggingFace repo id must be referenced");
  assert.match(panelSource, /applyQwen21TurboProfile/, "the turbo profile swap helper must exist");
  assert.match(panelSource, /dataset\.qwen21TurboToggle/, "the turbo enable switch must exist");
  assert.match(panelSource, /dataset\.qwen21TurboDownload/, "the LoRA download button must exist");
  assert.match(panelSource, /QWEN21_TURBO_SETTINGS = \{ steps: 6, cfg: 1 \}/, "turbo must switch to the 6-step / no-CFG profile");
  assert.match(panelSource, /qwen21_turbo_previous_settings/, "the pre-turbo steps/cfg must be saved and restored");
  assert.match(panelSource, /qwen21_turbo_enabled/, "the switch state must persist in settings");
});

test("switching turbo off returns the base 45-step schedule", () => {
  assert.match(panelSource, /QWEN21_BASE_SETTINGS = \{ steps: 45 \}/, "the base (non-turbo) profile must declare 45 steps");
  const turbo = panelSource.match(/export function applyQwen21TurboProfile\(widget, enabled\) \{([\s\S]*?)\n\}/);
  assert.ok(turbo, "applyQwen21TurboProfile missing");
  assert.match(turbo[1], /settings\.steps = QWEN21_BASE_SETTINGS\.steps/, "a switch-off without a snapshot must fall back to the base steps");
  assert.match(panelSource, /returns Steps to the 45-step base schedule/, "the turbo tooltip must explain the base schedule");
  // The Steps field in the sidebar must show the swapped value immediately.
  const change = panelSource.match(/panel\.addEventListener\("change", \(event\) => \{([\s\S]*?)\n  \}\);/);
  assert.ok(change, "change listener body missing");
  const turboBranch = change[1].match(/if \(target\.dataset\.qwen21TurboToggle !== undefined\) \{([\s\S]*?)\n    \}/);
  assert.ok(turboBranch, "the turbo change branch missing");
  assert.match(turboBranch[1], /widget\.syncPromptControls\(\)/, "the swap must refresh the visible Steps/CFG fields");
});

test("edit model reference images upload exists in the main widget", () => {
  assert.match(mainSource, /data-edit-refs-badge/, "the cards icon must carry a count badge");
  assert.ok(mainSource.includes('data-action="edit-refs"'), "the cards icon button must exist");
  assert.ok(mainSource.includes('remove_bg_model: "birefnet"'), "BiRefNet must be the default remove bg backend");
});
