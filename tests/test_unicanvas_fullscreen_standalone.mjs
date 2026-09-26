import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import test from "node:test";

// All regexes avoid literal line breaks so the suite stays CRLF-tolerant on
// Windows checkouts (see tests/test_unicanvas_frontend.mjs for the contrast).
const modesSource = await readFile(new URL("../web/vnccs_unicanvas_modes.mjs", import.meta.url), "utf8");
const widgetSource = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");

// Handler-region scoping: assertions run against the named region only, so they
// cannot pass on unrelated code elsewhere in the file.
function region(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, `region start not found: ${startMarker}`);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(end > start, `region end not found: ${endMarker}`);
    return source.slice(start, end);
}

function isolationHandler(name) {
    const body = modesSource.match(new RegExp(`const ${name} = \\(event\\) => \\{[\\s\\S]*?\\};`));
    assert.ok(body, `${name} isolation handler not found`);
    return body[0];
}

test("fullscreen installs window capture-phase keyboard isolation", () => {
    for (const type of ["keydown", "keyup", "keypress"]) {
        const pattern = new RegExp(`window\\.addEventListener\\("${type}",\\s*[^,]+,\\s*true\\)`);
        assert.ok(pattern.test(modesSource), `window ${type} listener must be capture-phase`);
    }

    for (const handler of ["onKeyDown", "onKeyUp", "onKeyPress"]) {
        const body = isolationHandler(handler);
        assert.ok(body.includes("stopImmediatePropagation()"), `${handler} must stop immediate propagation`);
        assert.ok(body.includes("preventDefault()"), `${handler} must prevent the default action`);
        assert.ok(body.includes("isUniCanvasTextTarget(event)"), `${handler} must spare text fields`);
        assert.ok(body.includes("modalOwnsKey(event)"), `${handler} must defer Enter/Escape to an open modal`);
    }

    assert.ok(modesSource.includes("input, textarea, select, [contenteditable]"),
        "text targets are input/textarea/select/[contenteditable] per spec 5");
    for (const type of ["keydown", "keyup", "keypress"]) {
        const removal = new RegExp(`window\\.removeEventListener\\("${type}",\\s*state\\.onKey[^,]*,\\s*true\\)`);
        assert.ok(removal.test(modesSource), `window ${type} listener must be removed on exit`);
    }
});

test("UniCanvas shortcut map covers tools, history, brush size, panels and Esc", () => {
    for (const [key, tool] of [["b", "brush"], ["v", "move"], ["e", "eraser"], ["m", "mask"], ["l", "lasso"], ["s", "rect"]]) {
        const pattern = new RegExp(`${key}:\\s*"${tool}"`);
        assert.ok(pattern.test(modesSource), `shortcut ${key} must select the ${tool} tool`);
    }

    const shortcuts = region(modesSource, "export function handleUniCanvasShortcut", "function installUniCanvasShortcuts");
    assert.ok(/lower === "z"/.test(shortcuts), "history shortcut must be Z");
    assert.ok(shortcuts.includes("event.ctrlKey || event.metaKey"), "history shortcut must use Ctrl/Cmd");
    assert.ok(shortcuts.includes("widget.undo()") && shortcuts.includes("widget.redo()"), "undo/redo must be wired");
    assert.ok(shortcuts.includes("event.shiftKey"), "Ctrl+Shift+Z must redo");
    assert.ok(shortcuts.includes('key === "["') && shortcuts.includes('key === "]"'), "brush size keys [ and ]");
    assert.ok(shortcuts.includes('key === "Tab"'), "Tab toggles panel visibility");
    assert.ok(shortcuts.includes('key === "Escape"'), "Esc exits fullscreen");
    assert.ok(shortcuts.includes("exitUniCanvasFullscreen(widget)"), "Esc must reach the fullscreen exit");
    assert.ok(shortcuts.includes("TOOL_SHORTCUTS[lower]"), "tool keys must route through the shortcut map");
    assert.ok(shortcuts.includes("isUniCanvasCanvasFocused(widget, event)"),
        "the map (minus Esc) must be scoped to canvas focus");
    assert.ok(widgetSource.includes("installUniCanvasWidgetModes(this.uniCanvasWidget)"),
        "vnccs_unicanvas.js must install the modes on every widget");
});

test("open widget modals keep their Enter/Escape keyboard contract in fullscreen", () => {
    assert.ok(modesSource.includes('const modalOwnsKey = (event) => isUniCanvasModalOpen(widget) && (event.key === "Enter" || event.key === "Escape")'),
        "Enter/Escape must be deferred to the modal while one is open");
    assert.ok(modesSource.includes(".vnccs-uc-modal-overlay"), "the modal overlay must be detected");
    const shortcuts = region(modesSource, "export function handleUniCanvasShortcut", "function installUniCanvasShortcuts");
    assert.ok(shortcuts.includes("isUniCanvasModalOpen(widget)"), "an open modal must keep the keyboard");
    assert.ok(shortcuts.indexOf("isUniCanvasModalOpen(widget)") < shortcuts.indexOf('key === "Escape"'),
        "the modal check must precede the Esc fullscreen exit");
});

test("Esc leaves the active tool before it leaves fullscreen", () => {
    const shortcuts = region(modesSource, "export function handleUniCanvasShortcut", "function installUniCanvasShortcuts");
    const toolExit = shortcuts.indexOf('key === "Escape" && widget.tool !== "move" && widget.tool !== "pan"');
    const fullscreenExit = shortcuts.indexOf('key === "Escape" && widget._vnccsFullscreen');
    const poseExit = shortcuts.indexOf('(key === "Escape" || key === "Enter") && widget.tool === "pose"');
    const draftExit = shortcuts.indexOf('(key === "Escape" || key === "Enter") && widget.transformDraft');
    assert.ok(toolExit >= 0, "the tool-exit Esc branch must exist");
    assert.ok(poseExit >= 0 && poseExit < toolExit, "the pose-session branch must precede the tool exit");
    assert.ok(draftExit >= 0 && draftExit < toolExit, "the transform-draft branch must precede the tool exit");
    assert.ok(fullscreenExit > toolExit, "the tool exit must precede the fullscreen exit");
    assert.ok(/widget\.setTool\("move"\)/.test(shortcuts), "the first Esc must return to Move layer");
    assert.ok(shortcuts.indexOf("isUniCanvasModalOpen(widget)") < toolExit, "the modal guard must precede the tool exit");
});

test("history keys bypass the canvas-focus gate in fullscreen and standalone", () => {
    const shortcuts = region(modesSource, "export function handleUniCanvasShortcut", "function installUniCanvasShortcuts");
    const historyBranch = shortcuts.indexOf('(lower === "z" || lower === "y")');
    const focusGate = shortcuts.indexOf("if (!isUniCanvasCanvasFocused(widget, event)) return false;");
    assert.ok(historyBranch >= 0 && focusGate > historyBranch,
        "the history branch must run before the canvas-focus gate");
    assert.ok(shortcuts.includes("const historyFocusBypass = Boolean(widget._vnccsFullscreen)"),
        "fullscreen must bypass the focus requirement");
    assert.ok(shortcuts.includes("(Boolean(widget.standalone) && Boolean(widget.container?.isConnected))"),
        "the standalone tab must bypass the focus requirement while connected");
    assert.ok(/modifier && !event\.altKey && \(lower === "z" \|\| lower === "y"\)/.test(shortcuts),
        "history still requires Ctrl/Cmd without Alt");
});

test("standalone sidebar tab registers Unicanvas with a visible icon", () => {
    assert.ok(modesSource.includes("registerSidebarTab.call(extensionManager, {"), "app.extensionManager.registerSidebarTab must be used");
    assert.ok(modesSource.includes("const extensionManager = app?.extensionManager;"), "extensionManager must be probed safely");
    assert.ok(/title:\s*"Unicanvas"/.test(modesSource), 'the tab must be labeled exactly "Unicanvas"');
    assert.ok(/tooltip:\s*"Unicanvas"/.test(modesSource), 'the tab tooltip must be "Unicanvas"');
    assert.ok(/icon:\s*UNICANVAS_SIDEBAR_ICON_CLASS/.test(modesSource), "the tab must register an icon");
    assert.ok(modesSource.includes('const UNICANVAS_SIDEBAR_ICON_CLASS = "vnccs-unicanvas-sidebar-icon";'),
        "the icon class must be a stable marker");
    assert.ok(modesSource.includes('new URL("./assets/unicanvas_icon.svg", import.meta.url).href'),
        "the icon is the shipped UniCanvas SVG asset");
    const icon = readFileSync(new URL("../web/assets/unicanvas_icon.svg", import.meta.url), "utf8");
    assert.ok(icon.startsWith("<svg") && icon.includes('viewBox="0 0 32 32"') && icon.includes("stroke-dasharray"),
        "a layer stack with a dashed selection marquee");
    assert.ok(modesSource.includes('background: url("${UNICANVAS_SIDEBAR_ICON_SVG}") center / contain no-repeat'),
        "the icon must render from CSS on the sidebar tab <i>");
    assert.ok(modesSource.includes('type: "custom"'), "the tab renders a custom DOM container");
    assert.ok(/widget\.standalone = true/.test(modesSource), "the tab opens UniCanvasWidget with standalone: true");
    assert.ok(widgetSource.includes("syncUniCanvasStandaloneSidebarTab(UniCanvasWidget, readUniCanvasStandaloneSetting())"),
        "vnccs_unicanvas.js must register the sidebar tab from the stored setting");
});

test("standalone sidebar tab is a ComfyUI setting, on by default", () => {
    assert.ok(modesSource.includes('export const UNICANVAS_STANDALONE_SETTING_ID = "VNCCS.UniCanvas.StandaloneSidebar";'));
    const settings = region(widgetSource, "  settings: [", "  setup() {");
    assert.ok(settings.includes("id: UNICANVAS_STANDALONE_SETTING_ID"), "the setting is registered by the extension");
    assert.ok(/type:\s*"boolean"/.test(settings) && /defaultValue:\s*true/.test(settings), "boolean, default on");
    assert.ok(settings.includes("syncUniCanvasStandaloneSidebarTab(UniCanvasWidget, value === true)"),
        "toggling the setting adds or removes the tab without a reload");
    const sync = region(modesSource, "export function syncUniCanvasStandaloneSidebarTab", "export function registerUniCanvasStandaloneSidebarTab");
    assert.ok(sync.includes("handle.dispose()"), "disabling removes the registered tab");
    assert.ok(modesSource.includes("unregisterSidebarTab?.(UNICANVAS_STANDALONE_TAB_ID)"));
});

test("standalone state persists to the vnccs-unicanvas-standalone key", () => {
    assert.ok(modesSource.includes('const UNICANVAS_STANDALONE_STORAGE_KEY = "vnccs-unicanvas-standalone";'),
        "localStorage key must be exactly vnccs-unicanvas-standalone");
    assert.ok(modesSource.includes("window.localStorage?.setItem(UNICANVAS_STANDALONE_STORAGE_KEY"),
        "state must be written to that localStorage key");
    assert.ok(modesSource.includes("window.localStorage?.getItem(UNICANVAS_STANDALONE_STORAGE_KEY"),
        "state must be restored from that localStorage key");
});

test("New canvas lives in the top bar, asks Are you sure? and clears layers and images", () => {
    const newDocument = region(modesSource, "export async function newUniCanvasDocument", "function installUniCanvasOutputActions");
    assert.ok(newDocument.includes('"New canvas"'), 'the confirm modal must be titled "New canvas"');
    assert.ok(newDocument.includes('"Are you sure?\\nConfirmation will delete <b>all layers</b> in canvas."'),
        'the copy must warn that the confirmation deletes all layers');
    assert.ok(newDocument.includes("confirmInWidget("), "the confirmation must use the widget modal");
    assert.ok(newDocument.includes("widget.stagingItems = []"), "staged images must be cleared");
    assert.ok(newDocument.includes("widget.layers = []"), "layers must be cleared");
    assert.ok(newDocument.includes('widget.addLayer("raster", "Base Layer", false)'), "a fresh base layer must be created");
    const outputActions = region(modesSource, "function installUniCanvasOutputActions", "export function installUniCanvasWidgetModes");
    assert.ok(outputActions.includes('widget._button(\n    "New canvas", "vnccs-uc-btn vnccs-uc-new-canvas"')
        || outputActions.includes('"New canvas", "vnccs-uc-btn vnccs-uc-new-canvas"'),
        "New canvas must be a top-bar widget button with the centering class");
    assert.ok(outputActions.includes("widget.settingsBar?.appendChild(newCanvasButton)"),
        "New canvas must be appended to the top toolbar, not the left column");
    assert.ok(!modesSource.includes("vnccs-uc2-output-actions"), "the old New row above GENERATE must be gone");
    assert.ok(!modesSource.includes("_vnccsOutputActions"), "no dead output-actions handle may remain");
    assert.ok(modesSource.includes('widget._button("Save to output", "vnccs-uc-btn"'), "Save to output must be a widget button");
    assert.ok(widgetSource.includes(".vnccs-uc-bottom .vnccs-uc-new-canvas { position:absolute; left:50%; transform:translateX(-50%); }"),
        "the top bar CSS must center the New canvas button between the clusters");
});

test("confirmInWidget renders the message as pre-line HTML copy", () => {
    const confirm = region(widgetSource, '  confirmInWidget(title, message, confirmLabel = "OK") {', "  _toolButton(tool, title) {");
    assert.ok(confirm.includes("messageEl.innerHTML = message"),
        "the message renders as HTML (callers pass our own literal copy only)");
    assert.ok(confirm.includes('messageEl.style.whiteSpace = "pre-line"'),
        "the literal newline in the New canvas copy must become a line break");
});

test("Save to output flattens through the shared helper and keeps the layer-menu call shape", () => {
    const composite = region(modesSource, "export function buildUniCanvasCompositeCanvas", "export async function saveUniCanvasOutput");
    assert.ok(composite.includes("widget.drawFlattenedLayers(ctx)"),
        "the composite must reuse the shared flatten draw");
    const sharedDraw = region(widgetSource, "  drawFlattenedLayers(ctx, layers = this.layers) {", "  flattenLayersToMaster() {");
    assert.ok(sharedDraw.includes("layer.hiresCanvas && layer.hiresRect"),
        "the shared draw must keep the hi-res layer branch");
    const flattenCall = region(widgetSource, "  flattenLayersToMaster() {", "  async importFile(");
    assert.ok(flattenCall.includes("this.drawFlattenedLayers(ctx)"),
        "flattenLayersToMaster must use the shared draw");
    assert.ok(!flattenCall.includes("drawImage(layer.canvas"),
        "flattenLayersToMaster must not keep its own compositing loop");

    const save = region(modesSource, "export async function saveUniCanvasOutput", "export async function newUniCanvasDocument");
    assert.ok(save.includes('widget.setStatus("[VNCCS UniCanvas] Saving to output...")'),
        "the status message must carry the [VNCCS UniCanvas] prefix");
    assert.ok(save.includes("layer-context-menu call shape"),
        "the layerId argument must be documented as the layer-menu call shape");
    assert.ok(save.includes("widget.serializeLayer(layer, true)"),
        "a layer save must send only that layer's pixels");
    assert.ok(save.includes('"/vnccs/unicanvas/save_output"'), "Save to output must call the save_output route");
    assert.ok(!modesSource.includes("_vnccsStandalonePersist"),
        "no dead standalone persistence hooks may remain");
});

test("fullscreen and standalone teardown run on disposal and tab destroy", () => {
    const dispose = region(widgetSource, "  dispose() {", "app.registerExtension({");
    assert.ok(dispose.includes("teardownUniCanvasWidgetModes(this)"), "dispose() must tear the modes down");
    const onRemoved = widgetSource.slice(widgetSource.indexOf("const onRemoved = nodeType.prototype.onRemoved;"));
    assert.ok(onRemoved.includes("teardownUniCanvasWidgetModes(this.uniCanvasWidget)"),
        "onRemoved must tear the modes down");

    const exit = region(modesSource, "export function exitUniCanvasFullscreen", "function installUniCanvasFullscreenButton");
    assert.ok(exit.includes("if (!widget._disposed)"), "the exit path must not touch a disposed widget");
    assert.ok(exit.includes("sibling.parentNode === state.restoreParent"),
        "fullscreen restore must guard a stale sibling anchor");

    const destroy = region(modesSource, "    destroy() {", "  });");
    assert.ok(destroy.includes("teardown()"), "the tab destroy() must run the shared teardown");
    const teardown = region(modesSource, "  const teardown = () => {", "  registerSidebarTab.call(");
    assert.ok(teardown.includes("teardownUniCanvasWidgetModes(widget)"),
        "the tab destroy() must flush/clear the pending persistence timer");
    assert.ok(modesSource.includes("localStateBackupDisabled") && modesSource.includes("4_000_000"),
        "standalone persistence must mirror the local backup degradation");
});

test("standalone mode hides ComfyUI chrome with explicit markers", () => {
    assert.ok(modesSource.includes('const UNICANVAS_STANDALONE_BODY_CLASS = "vnccs-unicanvas-standalone-mode";'),
        "the body class marker must exist");
    assert.ok(modesSource.includes("document.body.classList.add(UNICANVAS_STANDALONE_BODY_CLASS)"),
        "entering the tab must add the chrome-hiding class");
    assert.ok(modesSource.includes("document.body.classList.remove(UNICANVAS_STANDALONE_BODY_CLASS)"),
        "leaving the tab must restore the standard chrome");
    for (const selector of ["#comfyui-body-top", ".comfyui-body-top", "#comfy-menu", "#comfyui-body-bottom"]) {
        assert.ok(modesSource.includes(selector), `chrome-hiding CSS must cover ${selector}`);
    }
    assert.ok(modesSource.includes("vnccs-uc2-standalone-shell"), "the standalone app surface must exist");
    assert.ok(modesSource.includes("side-tool-bar-container"), "the icon sidebar rail must stay visible");
});

test("graph navigation forwarding is suspended during fullscreen", () => {
    assert.ok(widgetSource.includes("root._vnccsUniCanvasGraphNavigationSuspended"),
        "enableUniCanvasGraphNavigationForwarding must honor the suspend flag");
    assert.ok(modesSource.includes("container._vnccsUniCanvasGraphNavigationSuspended = true"),
        "entering fullscreen must suspend graph navigation forwarding");
    assert.ok(modesSource.includes("container._vnccsUniCanvasGraphNavigationSuspended = false"),
        "exiting fullscreen must restore graph navigation forwarding");
});

test("modal keydown stops propagation so Esc cannot exit fullscreen behind a modal", () => {
    const modal = region(widgetSource, "overlay.addEventListener(\"keydown\", (e) =>", "this.container.appendChild(overlay)");
    assert.ok(/e\.key === "Escape"[\s\S]{0,160}?e\.stopPropagation\(\)/.test(modal),
        "Escape in the modal keydown handler must stopPropagation before close");
    assert.ok(/e\.key === "Enter"[\s\S]{0,160}?e\.stopPropagation\(\)/.test(modal),
        "Enter in the modal keydown handler must stopPropagation before close");
});

test("Save to output saves the bbox crop and reports the result in a toast", () => {
    const crop = region(modesSource, "export function uniCanvasBboxPixelRect", "export function buildUniCanvasCompositeCanvas");
    assert.ok(crop.includes("bbox?.x || 0) - Number(origin?.x || 0)"), "the crop must convert the world bbox to canvas pixels");
    assert.ok(crop.includes("out.width = rect.width") && crop.includes("out.height = rect.height"),
        "the saved image must have the generation bbox size");
    assert.ok(crop.includes("buildUniCanvasCompositeCanvas(widget)"), "the crop must start from the flattened composite");
    const save = region(modesSource, "export async function saveUniCanvasOutput", "export async function newUniCanvasDocument");
    assert.ok(save.includes("buildUniCanvasBboxCompositeCanvas(widget).toDataURL"), "Save to output must send the bbox crop");
    assert.ok(save.includes('showUniCanvasToast(widget, "Saved to output"'), "success must show a toast with the file name");
    assert.ok(save.includes('showUniCanvasToast(widget, "Save to output failed", message, "error")'),
        "failure must show an error toast with the message");
});

test("the standalone tab has no fullscreen toggle", () => {
    const install = region(modesSource, "function installUniCanvasFullscreenButton", "export function showUniCanvasToast");
    assert.ok(install.includes("if (widget.standalone) return;"), "standalone must skip the fullscreen button");
});

test("UniCanvas owns history keys (and the whole keyboard in fullscreen/standalone)", () => {
    const isolation = region(modesSource,
        "History isolation: Ctrl+Z / Ctrl+Y never reach ComfyUI's graph undo/redo",
        "// Belt and braces for the non-keyboard paths");
    // Registered at module import in capture phase: it runs before ComfyUI's
    // bubble-phase keybind handler (useEventListener in GraphView.vue).
    for (const [type, handler] of [["keydown", "handleUniCanvasHistoryKeyDown"], ["keyup", "handleUniCanvasHistoryKeyUp"], ["keypress", "handleUniCanvasHistoryKeyPress"]]) {
        assert.ok(isolation.includes(`window.addEventListener("${type}", ${handler}, true)`),
            `${type} must be captured on window`);
    }
    assert.ok(/typeof window !== "undefined"/.test(isolation),
        "the registration must be guarded for non-browser environments");
    // Ownership: standalone gate, then any fullscreen widget, then node-mode
    // interaction (pointer inside the widget or canvas focused).
    assert.ok(isolation.includes("classList.contains(UNICANVAS_STANDALONE_BODY_CLASS)"),
        "the standalone gate must use the body class");
    assert.ok(/for \(const widget of uniCanvasModeWidgets\) \{\s*if \(widget\._vnccsFullscreen\) return widget;/.test(isolation),
        "a fullscreen widget must own the keys");
    assert.ok(/widget\._vnccsPointerInside \|\| isUniCanvasCanvasFocused\(widget, event\)/.test(isolation),
        "node mode must own the keys while the pointer or focus is inside the widget");
    // Fullscreen/standalone swallow every key, not only the history combo.
    assert.ok(/uniCanvasOwnsFullKeyboard\(widget\)/.test(isolation),
        "fullscreen/standalone must claim the whole keyboard");
    assert.ok(/_vnccsFullscreen[\s\S]{0,80}UNICANVAS_STANDALONE_BODY_CLASS/.test(isolation),
        "full-keyboard ownership covers fullscreen and the standalone shell");
    assert.ok(isolation.includes("isUniCanvasHistoryCombo(event)")
        && /key === "z" \|\| key === "y"/.test(isolation)
        && isolation.includes("event.altKey"),
        "node mode claims only Ctrl/Cmd+Z/Y (no Alt)");
    // A focused text field keeps native editing (no preventDefault) but is still stopped.
    assert.ok(/isUniCanvasTextTarget\(event\)[\s\S]{0,200}?stopImmediatePropagation\(\);[\s\S]{0,60}?return;/.test(isolation),
        "text targets must keep native editing and only stop propagation");
    // The widget map runs first with a history bypass; the key is then swallowed
    // even when the map declines, and unhandled Tab keeps focus traversal.
    assert.ok(isolation.includes("handleUniCanvasShortcut(widget, event, { historyBypass: true })"),
        "the widget shortcut map must run first with the history bypass");
    assert.ok(/stopImmediatePropagation\(\);[\s\S]{0,60}event\.key !== "Tab"\) event\.preventDefault\(\)/.test(isolation),
        "non-Tab keys must be preventDefault-ed; unhandled Tab keeps its default");
    assert.ok(/!handled && event\.key !== "Tab"/.test(isolation),
        "preventDefault must be skipped when the map handled the key or Tab moves focus");
});

test("history isolation binds live widgets, clears them, and gates Comfy.Undo/Redo", () => {
    assert.ok(/const uniCanvasModeWidgets = new Set\(\);/.test(modesSource),
        "the live widget registry must exist");
    const install = region(modesSource, "export function installUniCanvasWidgetModes", "export function teardownUniCanvasWidgetModes");
    assert.ok(install.includes("uniCanvasModeWidgets.add(widget)"), "install must register the widget");
    assert.ok(install.includes("installUniCanvasGraphUndoGate()"), "install must arm the Comfy.Undo/Redo gate");
    const teardown = region(modesSource, "export function teardownUniCanvasWidgetModes", "function readStandalonePersistedStateValue");
    assert.ok(teardown.includes("uniCanvasModeWidgets.delete(widget)"), "teardown must unregister the widget");
    const render = region(modesSource, "render(container) {", "globalThis.__VNCCS_UC_E2E__");
    assert.ok(render.includes("standaloneHistoryWidget = widget;"),
        "the isolation must bind the standalone widget when the tab renders");
    const teardownFn = region(modesSource, "const teardown = () => {", "widget?.dispose?.();");
    assert.ok(teardownFn.includes("standaloneHistoryWidget = null;"),
        "teardown must clear the standalone widget reference before disposal");
    const gate = region(modesSource, "function installUniCanvasGraphUndoGate", "function toggleUniCanvasTrueFullscreen");
    assert.ok(gate.includes('"Comfy.Undo"') && gate.includes('"Comfy.Redo"'),
        "the gate must wrap Comfy.Undo and Comfy.Redo");
    assert.ok(gate.includes("uniCanvasOwnsHistorySession()"),
        "the gate must be conditional on a UniCanvas session owning the history");
});

test("ComfyUI dialogs and their scrim open above the standalone shell and fullscreen portal", () => {
    const styles = region(modesSource, "const UNICANVAS_MODE_STYLES = `", "ensureUniCanvasModeStyles");
    for (const marker of [".vnccs-uc2-standalone-shell", ".vnccs-uc2-fullscreen-portal"]) {
        assert.ok(styles.includes(`body:has(${marker}) .p-dialog-mask`),
            `PrimeVue dialog masks must lift above ${marker}`);
        assert.ok(styles.includes(`body:has(${marker}) [role="dialog"]`),
            `generic dialogs must lift above ${marker}`);
        assert.ok(styles.includes(`body:has(${marker}) .comfy-modal`),
            `legacy modals must lift above ${marker}`);
    }
    assert.ok(/z-index:\s*2147484000 !important/.test(styles),
        "the lifted z-index must beat the shell (2147481000) and portal (2147482000) with !important");
});
