import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


const source = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");


test("imported UniCanvas images immediately refresh the layer list", () => {
    const method = source.match(/async importFile\(file\) \{[\s\S]*?\n  \}\n\n  loadImage\(src\)/);
    assert.ok(method, "UniCanvas importFile method not found");

    const addLayerIndex = method[0].indexOf('this.addLayer("raster"');
    const invalidateIndex = method[0].indexOf("this.invalidateLayerCaches(layer)");
    const listRenderIndex = method[0].indexOf("this.renderLayerList()");
    const canvasRenderIndex = method[0].indexOf("this.requestRender()");

    assert.ok(addLayerIndex >= 0, "image import must create a raster layer");
    assert.ok(invalidateIndex > addLayerIndex, "imported pixels must invalidate layer caches");
    assert.ok(listRenderIndex > invalidateIndex, "layer list must refresh after imported pixels are ready");
    assert.ok(canvasRenderIndex > listRenderIndex, "canvas redraw must follow the layer-list refresh");
});

test("re-importing the same image file works after its layer was deleted", () => {
    assert.match(source, /this\.fileInput\.addEventListener\("change"[\s\S]{0,260}?this\.fileInput\.value = "";/,
        "the file input must reset so picking the same file re-fires change");
});

test("settings gear drives remove bg; the mannequin character recipe is gone", () => {
    assert.match(source, /openUniCanvasSettings\(\)/, "a settings entry must exist");
    assert.ok(source.includes("remove_bg_model"), "the settings choose the remove-bg model");
    assert.ok(!source.includes("generateCharacterFromPoseLayer") && !source.includes("char_gen_"),
        "live Pose Studio layers generate through the pose layer itself, not a separate character recipe");
});

test("the settings gear sits next to the snap-to-grid icon", () => {
    assert.match(source, /this\.gearBtn = this\._button\(UI_ICONS\.gear, "vnccs-uc-icon vnccs-uc-gear", \(\) => this\.openUniCanvasSettings\(\), "UniCanvas settings"\);/,
        "a gear button must be created for the corner bar");
    assert.match(source, /this\.settingsBar\.append\(this\.undoBtn, this\.redoBtn, this\.fitBtn, this\.zoomResetBtn, settingsSpacer, this\.snapBtn, this\.gearBtn\);/,
        "the gear must sit in the corner bar right after Snap to grid");
    assert.ok(!/\["\\u2699", "Settings"/.test(source), "the old Layers-section gear entry must be gone");
});

test("remove bg offers edit model / birefnet / rembg / sam 3 with BiRefNet default", async () => {
    assert.ok(source.includes('remove_bg_model: "birefnet"'), "BiRefNet must be the default backend");
    const removeBg = await readFile(new URL("../web/vnccs_unicanvas_remove_bg.mjs", import.meta.url), "utf8");
    assert.ok(source.includes("buildRemoveBgSettings(s, {"), "the settings popover builds the remove bg rows from the module");
    for (const marker of ['["edit", "Edit model"]', '["birefnet", "BiRefNet"]', '["rembg", "rembg"]', '["sam3", "SAM 3']) {
        assert.ok(removeBg.includes(marker), "missing remove bg backend option: " + marker);
    }
    assert.ok(removeBg.includes('["qwen_image21", "Qwen Image 2.1"]'), "the edit-model backend needs the QI2.1 choice");
    assert.ok(!removeBg.includes('"minimax_h3"'), "MiniMax H3 decodes RGB only: it is not a remove bg edit model");
    assert.ok(removeBg.includes("REMOVE_BG_DEFAULT_PROMPT"), "the universal remove bg prompt is editable");
    for (const key of ["model_loader", "gguf_arch", "clip_name", "vae_name", "steps", "cfg", "sampler_name", "scheduler", "lora_name", "prompt"]) {
        assert.ok(removeBg.includes(`"${key}"`), "the edit-model backend exposes " + key);
    }
    assert.ok(!removeBg.includes('"seed"'), "the seed is not user-facing (random per run)");
    assert.ok(!removeBg.includes('"lora_strength"'), "the remove bg LoRA always runs at strength 1");
});

test("edit model reference images upload next to Steps with per-family slot markers", () => {
    assert.ok(source.includes('data-action="edit-refs"'), "the cards icon button must exist");
    assert.ok(source.includes("data-edit-refs-badge"), "the icon must carry a count badge");
    assert.ok(source.includes("referenceSlotName(this.modelDescriptors, this.settings.generation_mode, index + 2)"), "uploaded images are marked with the active family's slot 2.. name");
    assert.ok(source.includes("edit_reference_images"), "the uploads must persist in the widget settings");
    assert.match(source, /openEditReferenceImages\(\)/, "the popover entry point must exist");
});

test("settings popover carries the anchored class and size contract", () => {
    assert.match(source, /\.vnccs-uc-settings-popover\s*\{[^}]*width:\s*440px/,
        "the settings popover must have the hard 440px width");
    assert.match(source, /\.vnccs-uc-settings-popover\s*\{[^}]*height:\s*min\(560px,\s*72vh\)/,
        "the settings popover must use the hard 560px/72vh height");
    assert.match(source, /\.vnccs-uc-settings-popover\s*\{[^}]*overflow-y:\s*auto/,
        "the settings popover content must scroll inside the hard size");
    assert.match(source, /\.vnccs-uc-settings-popover\s*\{[^}]*font-size:\s*13px/,
        "the settings popover must use the larger 13px type");
    assert.match(source, /anchorPopoverTo\(panel,\s*this\.gearBtn,\s*this\.container\)/,
        "the settings popover must be anchored under the gear inside the widget");
});

test("tool settings dock above the Layers section in the right sidebar", () => {
    assert.match(source, /this\.side\.insertBefore\(this\.toolSettingsSection, layersSection\)/,
        "tool settings must dock as a sidebar section above Layers");
    assert.match(source, /vnccs-uc-tool-settings-section/,
        "the docked tool settings must be styled as a sidebar section");
    assert.match(source, /if \(this\.toolSettingsSection\) this\.toolSettingsSection\.hidden = true;/,
        "tools without settings (move/pan/sam/bbox) must collapse the whole section");
    assert.match(source, /if \(this\.toolSettingsTitle\) this\.toolSettingsTitle\.textContent = `\$\{title\} Settings`;/,
        "the section head must carry the active tool's title");
    assert.ok(!/\.vnccs-uc-tool-settings \{ position:absolute/.test(source),
        "the old stage-overlay positioning must be gone");
});

test("a linked VNCSS Config greys out every UniCanvas control it overrides", () => {
    for (const marker of [
        'data-preset-card-list data-config-override',
        'data-turbo-panel data-config-override',
        'data-lora-stack data-config-override',
        'class="vnccs-uc-model-tabs" data-config-override',
        'data-action="edit-refs" data-config-override',
        'data-config-override>Loader<select',
    ]) {
        assert.ok(source.includes(marker), "missing override marker: " + marker);
    }
    const sync = source.slice(source.indexOf("  syncConfigOverride() {"), source.indexOf("  _isConfigLinked() {"));
    assert.ok(sync.includes('classList.toggle("vnccs-uc-config-linked", linked)'));
    assert.ok(sync.includes("el.inert = linked"), "overridden controls must be inert, not just dimmed");
    assert.ok(sync.includes("VNCSS Config linked"), "a banner explains where the values come from");
    assert.ok(!/data-mode-control[^>]*data-config-override/.test(source), "Mode (model family) stays editable");
    assert.ok(source.includes("[data-config-override] { opacity:.38; filter:grayscale(1)"), "overridden controls read as greyed out");
});
