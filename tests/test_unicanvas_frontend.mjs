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
    const removeBg = await readFile(new URL("../web/unicanvas/remove_bg.mjs", import.meta.url), "utf8");
    assert.ok(source.includes("buildRemoveBgSettings(s, {"), "the settings popover builds the remove bg rows from the module");
    for (const marker of ['["edit", "Edit model"]', '["birefnet", "BiRefNet"]', '["rembg", "rembg"]', '["sam3", "SAM 3']) {
        assert.ok(removeBg.includes(marker), "missing remove bg backend option: " + marker);
    }
    assert.ok(removeBg.includes('["qwen_image21", "Qwen Edit 2.1"]'), "the edit-model backend needs the QI2.1 choice");
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
    assert.match(source, /\.vnccs-uc-settings-popover\s*\{[^}]*max-height:\s*min\(560px,\s*72vh\)/,
        "the settings popover must grow with its content up to 560px/72vh");
    assert.match(source, /\.vnccs-uc-settings-popover\s*\{[^}]*overflow-y:\s*auto/,
        "the settings popover content must scroll inside the hard size");
    assert.match(source, /\.vnccs-uc-settings-popover\s*\{[^}]*font-size:\s*13px/,
        "the settings popover must use the larger 13px type");
    assert.match(source, /anchorPopoverTo\(panel,\s*this\.gearBtn,\s*this\.container\)/,
        "the settings popover must be anchored under the gear inside the widget");
});

test("the Seed dice starts active on a fresh canvas", () => {
    assert.match(source, /const DEFAULT_SEED_MODE = "randomize"/,
        "the random seed mode must be the declared default");
    assert.match(source, /seed_mode: DEFAULT_SEED_MODE/,
        "fresh settings must default to the random seed mode");
    const sync = source.match(/syncSeedModeControl\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(sync, "syncSeedModeControl missing");
    assert.match(sync[1], /DEFAULT_SEED_MODE/,
        "the dice highlight must read the same default");
    assert.match(source, /if \(\(this\.settings\.seed_mode \|\| DEFAULT_SEED_MODE\) === "randomize"\) \{/,
        "GENERATE must draw a fresh seed while the random mode is on");
    assert.match(source, /=== "randomize" \? "fixed" : "randomize"/,
        "the dice must still toggle back to a fixed seed");
    assert.match(source, /seed_mode_user_set = true/,
        "clicking the dice must record the explicit choice");
    const migrate = source.match(/applySeedModeDefault\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(migrate, "applySeedModeDefault missing");
    assert.match(migrate[1], /seed_mode_user_set === true/,
        "an explicit dice choice must survive restores");
    assert.match(migrate[1], /= DEFAULT_SEED_MODE/,
        "states saved with the old default adopt the random dice");
    const restoreCalls = (source.match(/this\.applySeedModeDefault\(\);/g) || []).length;
    assert.ok(restoreCalls >= 2, "both restore paths (state and workflow settings) must migrate");
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
    assert.ok(!/data-mode-control[^>]*data-config-override/.test(source), "Mode is hidden by CSS, not by the override marker");
    assert.ok(source.includes("[data-config-override] { opacity:.38; filter:grayscale(1)"), "overridden controls read as greyed out");
});

test("sidebar polish: denoise field fits 0.65, preset picker shows a chevron, LoRA stack grows with +/-", async () => {
    assert.match(source, /\.vnccs-uc-denoise-control\s*\{[^}]*grid-template-columns:auto minmax\(0,1fr\) 58px/, "the denoise number field must be wide enough for 0.65");
    assert.match(source, /\.vnccs-uc-denoise-control \.vnccs-uc-input\s*\{[^}]*width:58px/);
    assert.ok(source.includes("${head ? PRESET_CHEVRON_ICON : \"\"}"), "the selected preset card must carry a dropdown chevron");
    assert.ok(source.includes('card.title = "Choose another preset"'), "the preset card explains that it opens a list");
    assert.match(source, /const LORA_STACK_MAX = 10/);
    assert.ok(source.includes('data-action="lora-add"') && source.includes('data-action="lora-remove"'), "the LoRA stack needs + and - buttons");
    assert.match(source, /\.vnccs-uc-lora-rows\s*\{[^}]*max-height:186px[^}]*overflow-y:auto/, "more than three LoRA rows scroll inside the list");
    const normalize = source.match(/normalizeLoraStack\(\) \{([\s\S]*?)\n  \}/)[1];
    assert.ok(!normalize.includes("< 5"), "the stack must not be padded to five rows any more");
    assert.ok(normalize.includes("Math.max(1,"), "the stack starts with a single row");
    assert.ok(/index > 0 \? `<button[^`]*lora-remove/.test(source), "the first row cannot be removed");
});

test("the generation box moves freely unless Snap to grid is on", () => {
    const step = source.match(/bboxGridStep\(event, moving\) \{([\s\S]*?)\n  \}/)[1];
    assert.ok(step.includes("if (this.snapToGrid)") && step.includes("moving ? 1 :"), "snap off: pixel-exact moves, 8 px multiple for sizes");
    assert.ok(source.includes("this.bboxGridStep(e, true)") && source.includes("this.bboxGridStep(event, false)"), "move and resize both use the step");
    assert.ok(!/const grid = e\.ctrlKey \|\| e\.metaKey \? 8 : 64/.test(source), "no hard-coded 64 px snapping may remain");
});

test("the settings popover is an accordion that fits its content", () => {
    assert.match(source, /\.vnccs-uc-settings-section > summary::after/, "each section header has a chevron");
    assert.match(source, /\.vnccs-uc-settings-section > summary::-webkit-details-marker\s*\{\s*display:none/, "the raw disclosure marker is hidden");
    assert.match(source, /\.vnccs-uc-settings-section\[open\] > summary::after/, "the chevron turns when the section is open");
});

test("the resize tool offers Crop and remembers Custom model picks", () => {
    assert.ok(source.includes('mode === "crop"') && source.includes("cropQuadFromHandle("), "crop mode edits the frame through the crop math");
    assert.ok(source.includes("setDraftCrop(draft, { ...EMPTY_CROP })"), "Reset restores the uncropped image");
    assert.ok(source.includes("this.recallModelChoice({ onlyEmpty: true })"), "a restored canvas keeps its own picks");
    assert.ok(source.includes("this.rememberModelChoice()"), "Custom picks are remembered");
    assert.ok(source.includes("installInferenceScaleEdit(this)"), "the size label is editable by double click");
});

test("inside UniCanvas Pose Studio hides its camera/export sections and clones the active mannequin", async () => {
    const { readFile } = await import("node:fs/promises");
    const pose = await readFile(new URL("../web/vnccs_pose_studio.js", import.meta.url), "utf8");
    for (const name of ["camAngleSection", "exportSection"]) {
        assert.ok(pose.includes(`this.hideSectionInUniCanvas(${name})`), `${name} must be hidden when embedded`);
    }
    assert.ok(pose.includes('if (this.host?.embedded === true && section?.el) section.el.style.display = "none"'));
    const add = pose.slice(pose.indexOf("async addCharacter("), pose.indexOf("async deleteCharacter("));
    assert.ok(add.includes("this.host?.embedded === true ? this.getActiveCharacter() : null"), "only the embedded editor clones");
    assert.ok(add.includes("JSON.parse(JSON.stringify(this.poses[index]"), "the pose (bones, rotation) is copied");
    assert.ok(add.includes("zoom: clone.transform?.zoom ?? 1"), "the zoom is inherited");
});

test("preset dropdown: compact header card, one-line menu rows, chevron drawn with a stroke", () => {
    assert.match(source, /\.vnccs-uc-model-card-chevron\s*\{[^}]*stroke:currentColor/, "the chevron needs an explicit stroke to be visible");
    assert.match(source, /\.vnccs-uc-model-picker-menu\s*\{[^}]*max-height:260px[^}]*overflow-y:auto/, "a long preset list scrolls inside the menu");
    assert.ok(source.includes("const row = !turbo && !head;"), "menu entries use the compact row variant");
    assert.ok(source.includes("turbo || row || status.installed"), "rows carry no inline Download button");
});

test("a linked VNCSS Config hides model, family, turbo and LoRA controls and drives the family", () => {
    assert.match(source, /\.vnccs-uc-config-linked \[data-mode-control\][^}]*display:none !important/, "Mode is hidden");
    for (const part of [".vnccs-uc-model-tabs", ".vnccs-uc-turbo-section", ".vnccs-uc-lora-stack", ".vnccs-uc-refs-btn", ".vnccs-uc-qwen21-panel"]) {
        assert.ok(source.includes(`.vnccs-uc-config-linked ${part}`), `${part} must be hidden while linked`);
    }
    assert.ok(source.includes('panel.style.display = configLinked ? (panelMode === "custom" ? "" : "none")'), "only the cut-down Custom panel (inference scale) stays");
    assert.match(source, /\.vnccs-uc-model-panel\.vnccs-uc-mode-only > :not\(\.vnccs-uc-infer-scale\)\s*\{ display:none; \}/);
    const family = source.slice(source.indexOf("  syncConfigFamily() {"), source.indexOf("  syncConfigOverride() {"));
    assert.ok(family.includes("resolveConfigDrawSettings(") && family.includes("detectModuleForModelName("), "the family follows the config's model file");
    assert.ok(family.includes("forcedMode"), "a checkpoint config stays SDXL");
    assert.match(source, /this\.syncConfigFamily\(\);\s*try \{\s*const refs = await loadConfigReferences/, "GENERATE re-detects the family before drawing");
});

test("family detection reads the file name only, prefers the most specific pattern and keeps the loader", async () => {
    const { runInNewContext } = await import("node:vm");
    const matcher = source.slice(source.indexOf("function uniCanvasModelDetectMatches"), source.indexOf("function getUniCanvasModelModule"));
    const method = source.slice(source.indexOf("  detectModuleForModelName(name) {"), source.indexOf("  // A linked config decides the model"));
    const detect = runInNewContext(`${matcher}
        const UNICANVAS_MODEL_MODULES = {
            generic: { key: "generic", detect: ["qwen"] },
            qwen_image21: { key: "qwen_image21", detect: ["qwen-image-2.1", "qwen_image_2.1"] },
            sdxl: { key: "sdxl", detect: ["sdxl", "xl"] },
        };
        const holder = { ${method.trim().replace(/^detectModuleForModelName/, "detect")} };
        (name) => holder.detect(name)?.key ?? null;`);
    assert.equal(detect("qwen\Qwen-Image-2.1-int8.safetensors"), "qwen_image21", "a qwen/ folder must not select the edit family");
    assert.equal(detect("qwen_image_2.1_int8.safetensors"), "qwen_image21");
    assert.equal(detect("qwen/qwen-image-edit-2511.safetensors"), "generic");
    assert.equal(detect("sdxl\\model.safetensors"), null, "the folder alone never picks a family");
    const auto = source.slice(source.indexOf("  autoDetectGenerationModeFromModel() {"), source.indexOf("  getModelBase() {"));
    assert.ok(auto.includes("if (modelLoader) this.settings.model_loader = modelLoader"), "picking a file never switches the loader");
    assert.ok(auto.includes("module.key === getUniCanvasModelModule(this.settings.generation_mode).key"), "no switch when the family already matches");
});

test("cancelling a never-saved new pose layer removes it and its undo step", async () => {
    const { runInNewContext } = await import("node:vm");
    assert.ok(source.includes("this.newPoseLayerId = layer.id;"), "addPoseLayer marks the layer as new");
    const finish = source.slice(source.indexOf("  finishPoseEdit(keep = true) {"), source.indexOf("  discardNewPoseLayer("));
    assert.ok(finish.includes("session.isNew") && finish.includes("this.discardNewPoseLayer(layer, session)"), "Cancel discards a new layer");
    assert.ok(finish.indexOf("session.isNew") < finish.indexOf("restoreLayerPixelSnapshot"), "the new-layer check comes before the normal restore");
    const method = source.slice(source.indexOf("  discardNewPoseLayer("), source.indexOf("  // Topmost visible image layer with content under a world point"));
    const holder = runInNewContext(`({ ${method.trim()} })`);
    const keep = { id: "a" }, fresh = { id: "b" };
    const calls = [];
    const widget = {
        layers: [keep, fresh], activeLayerId: "b", undoStack: [{ kind: "addLayer", layer: fresh, previousActiveLayerId: "a" }],
        poseEditor: { release: () => calls.push("release") },
        syncPoseToolToActiveLayer: () => calls.push("tool"), restorePoseEditView: () => calls.push("view"), renderLayerList() {},
        updateHistoryButtons() {}, requestRender() {}, syncLightStateToWidget() {}, scheduleFullSync() {}, setStatus: (text) => calls.push(text),
    };
    holder.discardNewPoseLayer.call(widget, fresh, {});
    assert.deepEqual(widget.layers.map((layer) => layer.id), ["a"]);
    assert.equal(widget.activeLayerId, "a", "the previously active layer is selected again");
    assert.equal(widget.undoStack.length, 0, "no undo step is left for a layer that never existed");
    assert.ok(calls.includes("release") && calls.includes("view"));
});

test("reference images stay out of the widget value (workflow draft) but reach the prompt", () => {
    assert.match(source, /const WIDGET_HEAVY_SETTINGS = \["edit_reference_images"\]/);
    assert.ok(source.includes("settings: widgetSettings(state.settings)"), "syncToNode must strip heavy settings");
    assert.ok(source.includes("state.settings = widgetSettings(this.settings)"), "the light widget write must strip heavy settings");
    assert.ok(source.includes("state.settings.edit_reference_images = refs"), "the queued prompt must carry the reference images");
    const setter = source.match(/setEditReferenceImages\(list\) \{[\s\S]*?\n  \}/);
    assert.ok(setter && setter[0].includes("this.scheduleStateUpload()"), "reference changes must persist through the server state cache");
});
