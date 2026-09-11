import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import * as state from "../web/vnccs_unicanvas_pose_state.mjs";
import { createScene } from "./helpers/pose_studio_scene.mjs";

const noop = () => {};
class Element {
    constructor(tag = "div") {
        this.tagName = tag.toUpperCase(); this.children = []; this.events = {}; this.style = { setProperty(key, value) { this[key] = value; } };
        this.attrs = {}; this.classList = { add: noop, remove: noop, toggle: noop };
        this.scrollTop = 0; this.scrollLeft = 0; this.clientWidth = 1000; this.clientHeight = 800;
    }
    appendChild(child) { child.parentElement?.removeChild(child); this.children.push(child); child.parentElement = this; return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    removeChild(child) { this.children = this.children.filter(c => c !== child); child.parentElement = null; }
    remove() { this.parentElement?.removeChild(this); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    add(child) { this.appendChild(child); }
    setAttribute(k, v) { this.attrs[k] = v; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(event, callback) { (this.events[event] ||= []).push(callback); }
    fire(name, extra = {}) { for (const callback of this.events[name] || []) callback({ preventDefault: noop, stopPropagation: noop, ...extra }); }
    contains(target) { return this === target || this.children.some(child => child.contains(target)); }
    focus() { this.focused = true; }
    getContext() { return this.ctx ||= { calls: [], save: noop, restore: noop,
        clearRect: (...args) => this.ctx.calls.push(["clear", ...args]),
        fillRect: (...args) => this.ctx.calls.push(["fill", ...args]),
        drawImage: (...args) => this.ctx.calls.push(["draw", ...args]),
    }; }
    toDataURL() { return `image:${this.name || "canvas"}`; }
}
const source = fs.readFileSync(new URL("../web/vnccs_unicanvas_pose.mjs", import.meta.url), "utf8");
const ucSource = fs.readFileSync(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
function harness(studioClass = class {}) {
    const document = Object.assign(new Element("document"), { createElement: tag => new Element(tag), head: new Element(), getElementById: () => true });
    const context = { ...state, document, AbortController, console, JSON, Option: class extends Element {
        constructor(name, value) { super("option"); this.textContent = name; this.value = value; }
    }, PoseStudioWidget: studioClass, installCustomSelects: () => ({ disconnect: noop }) };
    const Editor = vm.runInNewContext(source.replace(/^import .*;\n/gm, "").replace("export class", "class") + "\nUniCanvasPoseEditor", context);
    const layer = { id: "pose", type: "pose", visible: true, opacity: 1, blendMode: "source-over",
        canvas: new Element("canvas"), pose: { rect: { x: 10, y: 20, width: 400, height: 600 }, studio: {}, character: null } };
    const host = { node: { id: 5, size: [1400, 900] }, tool: "pose", layers: [layer], activeLayer: layer,
        container: new Element(), origin: { x: -100, y: -100 }, bbox: { ...layer.pose.rect },
        stageWrap: { offsetLeft: 320, offsetTop: 40, clientWidth: 1000, clientHeight: 800 }, view: { x: 0, y: 0, scale: 1 },
        _createCanvas: (width, height) => Object.assign(new Element("canvas"), { width, height }),
        _button: (label, cls, callback) => { const b = new Element("button"); b.textContent = label; b.addEventListener("click", callback); return b; },
        getLayerWorldBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
        ensureWorldRectBounds: () => true, requestRender: noop, syncLightStateToWidget: noop, scheduleFullSync: noop, markLayerPixelsChanged: noop,
        recordHistoryBefore: noop, syncToNode: noop, setStatus: noop, hasOpenStagingPanel: () => false, settings: { positive: "Additional instruction" },
    };
    return { editor: new Editor(host), host, layer, context, Editor };
}

function fakeStudio() {
    const studio = { container: new Element(), leftPanel: new Element(), centerPanel: new Element(),
        rightSidebar: new Element(), canvasContainer: new Element(), animationTimeline: { stopPlayback: noop },
        hideHandControlPopover: noop, performViewerResize: noop,
    };
    studio.centerPanel.appendChild(studio.canvasContainer);
    studio.container.append(studio.leftPanel, studio.centerPanel, studio.rightSidebar);
    return studio;
}

function selectionHarness() {
    const { host, layer, context } = harness();
    const prototype = vm.runInNewContext(ucSource.slice(ucSource.indexOf("class UniCanvasWidget {"), ucSource.indexOf("\napp.registerExtension("))
        + "\nUniCanvasWidget.prototype", context);
    delete host.activeLayer;
    Object.setPrototypeOf(host, prototype);
    host.activeLayerId = "image"; host.tool = "brush";
    const raster = { id:"image", type:"raster", name:"Character", visible:true };
    host.layers.push(raster);
    host.container.querySelectorAll = () => [];
    for (const name of ["syncCursorStyle", "renderToolSettings", "renderSamPanel", "updateSamControls", "updateHud", "updateContextCursor",
        "updateToolPreviewOverlay", "updateLayerListActiveState", "syncActiveLayerControls", "renderLayerList"]) host[name] = noop;
    host.toolNeedsCanvasRender = () => false;
    host.getModelBase = () => "qwen_image_edit"; host.getInferenceSize = () => ({ width:512, height:512 });
    host.drawBtn = { disabled:false };
    const calls = [];
    host.setStatus = message => calls.push(["status", message]);
    host.poseEditor = {
        commit: () => calls.push(["commit"]),
        setVisible: show => calls.push(["visible", show]),
        activate: async (selected, options) => calls.push(["activate", selected.id, options.show]),
        setCharacterOpen: open => calls.push(["character", open]),
        generation: async selected => { calls.push(["generation", selected.id]); throw new Error("Capture stopped by test"); },
    };
    return { host, layer, raster, calls };
}

test("selecting a pose from another tool opens its editor and the missing character picker", () => {
    const { host, layer, calls } = selectionHarness();
    host.setActiveLayer(layer.id);
    assert.equal(host.tool, "pose"); assert.equal(host.activeLayerId, layer.id);
    assert.deepEqual(calls.filter(call => call[0] === "activate"), [["activate", layer.id, true]]);
    assert.ok(calls.some(call => call[0] === "character" && call[1] === true));
    host.setTool("move"); calls.length = 0;
    host.setActiveLayer(layer.id);
    assert.equal(host.tool, "pose", "clicking the same selected pose must reopen its editor");
    assert.ok(calls.some(call => call[0] === "activate"));
});

test("selecting a raster layer leaves pose editing and keeps its character selection", () => {
    const { host, layer, raster, calls } = selectionHarness();
    layer.pose.character = { source:"layer", layerId:raster.id };
    host.setActiveLayer(layer.id);
    assert.ok(!calls.some(call => call[0] === "character"), "a ready reference must not force the popup open");
    host.setActiveLayer(raster.id);
    assert.equal(host.tool, "move"); assert.equal(host.activeLayerId, raster.id);
    assert.ok(calls.some(call => call[0] === "visible" && call[1] === false));
    assert.equal(layer.pose.character.layerId, raster.id);
});

test("invalid selection and an unfinished transform cannot change the current tool or layer", () => {
    const { host, layer, calls } = selectionHarness();
    host.setActiveLayer("missing");
    host.transformDraft = { layerId:"image" }; host.setActiveLayer(layer.id);
    assert.equal(host.tool, "brush"); assert.equal(host.activeLayerId, "image");
    assert.ok(!calls.some(call => call[0] === "activate"));
});

test("Generate redirects a missing character to the pose picker without starting inference", async () => {
    const { host, layer, calls } = selectionHarness();
    await host.draw();
    assert.equal(host.tool, "pose"); assert.equal(host.activeLayerId, layer.id);
    assert.ok(calls.some(call => call[0] === "character" && call[1]));
    assert.match(calls.find(call => call[0] === "status")[1], /Choose a character image/);
    assert.ok(!calls.some(call => call[0] === "generation"));
    assert.equal(host.drawBtn.disabled, false);
});

test("Generate reaches pose capture while the Pose tool is active and a character is selected", async () => {
    const { host, layer, raster, calls } = selectionHarness();
    layer.pose.character = { source:"layer", layerId:raster.id };
    host.setActiveLayer(layer.id); await host.draw();
    assert.equal(host.tool, "pose");
    assert.ok(calls.some(call => call[0] === "generation" && call[1] === layer.id));
    assert.equal(host.drawInProgress, false); assert.equal(host.drawBtn.disabled, false);
});

test("deleted and uncached character references reopen selection instead of sending an empty image2", async () => {
    const { host, layer, calls } = selectionHarness();
    for (const character of [{ source:"layer", layerId:"missing" }, { source:"upload", name:"Missing.png" }]) {
        layer.pose.character = character; calls.length = 0;
        await host.draw();
        assert.ok(calls.some(call => call[0] === "character" && call[1]));
        assert.ok(!calls.some(call => call[0] === "generation"));
    }
    layer.pose.character = { source:"upload", name:"Saved.png", dataURL:"data:image/png;base64,cGl4ZWxz" };
    assert.equal(state.poseCharacterIssue(host, layer), null);
});

test("the host reuses Body and Scene on the canvas with no Poses or Character tab", () => {
    const { editor, layer } = harness();
    editor.layer = layer; editor.studio = fakeStudio();
    const original = [editor.studio.leftPanel, editor.studio.rightSidebar];
    editor.buildDock();
    const pages = editor.dock.children.slice(1);
    assert.equal(pages.length, 2);
    assert.equal(editor.studio.centerPanel.hidden, true);
    assert.equal(editor.characterAnchor.parentElement, editor.controls);
    assert.equal(editor.dock.parentElement, editor.controls);
    original.forEach((element, index) => assert.equal(pages[index].children[0], element));
    assert.equal(editor.studio.canvasContainer.parentElement, editor.studio.container);
    assert.equal(pages.filter(page => !page.hidden).length, 1);
    assert.match(source, /new PoseStudioWidget\(node,/);
    assert.doesNotMatch(source, /new PoseViewerCore|HAND_PRESETS|IK_CHAINS/);
});

test("tool visibility, tab changes and keyboard navigation retain settings and both scroll axes", () => {
    const { editor, layer } = harness(); editor.layer = layer; editor.studio = fakeStudio(); editor.buildDock();
    const [tabs, ...pages] = editor.dock.children;
    pages[0].scrollTop = 187; pages[0].scrollLeft = 9;
    tabs.children[1].fire("click"); pages[1].scrollTop = 321;
    editor.setVisible(false); assert.equal(editor.studio.container.hidden, true);
    editor.setVisible(true); assert.equal(pages[1].scrollTop, 321);
    tabs.children[0].fire("click");
    assert.equal(pages[0].scrollTop, 187); assert.equal(pages[0].scrollLeft, 9);
    tabs.children[0].fire("keydown", { key: "End" });
    assert.equal(pages[1].hidden, false); assert.equal(tabs.children[1].focused, true);
});

test("bbox editor geometry follows pan and zoom and clips outside the canvas", () => {
    const { editor, host, layer } = harness(); editor.layer = layer; editor.studio = fakeStudio(); editor.buildDock();
    for (const scale of [.25, .7, 1, 2.5]) {
        host.view = { x: -120, y: 50, scale };
        editor.layout();
        const style = editor.studio.canvasContainer.style;
        assert.equal(parseFloat(style.left), 320-120+10*scale);
        assert.equal(parseFloat(style.top), 40+50+20*scale);
        assert.equal(parseFloat(style.width), 400*scale);
        assert.equal(parseFloat(style.height), 600*scale);
        assert.match(style.clipPath, /^inset\(/);
    }
    layer.locked = true; editor.layout(); assert.equal(editor.dock.inert, true);
});

test("pose controls stay inside the resized stage and never replace the generation panel", () => {
    const { editor, host, layer } = harness(); editor.layer = layer; editor.studio = fakeStudio(); editor.buildDock();
    const generationPanel = new Element(), generate = new Element("button");
    generationPanel.append(generate); host.container.append(generationPanel, editor.studio.container);
    for (const [left, top, width, height] of [[320,40,1000,800], [480,90,540,480], [320,60,1600,1000]]) {
        Object.assign(host.stageWrap, { offsetLeft:left, offsetTop:top, clientWidth:width, clientHeight:height });
        editor.setVisible(true);
        assert.equal(editor.controls.style.left, `${left}px`);
        assert.equal(editor.controls.style.top, `${top}px`);
        assert.equal(editor.controls.style.width, `${width}px`);
        assert.equal(editor.controls.style.height, `${height}px`);
        assert.equal(generate.parentElement, generationPanel);
        assert.ok(!generationPanel.hidden && !generationPanel.inert);
        assert.ok(!generationPanel.contains(editor.dock));
    }
    assert.doesNotMatch(source, /\.vnccs-uc-left\s*\{/);
    host.hasOpenStagingPanel = () => true; editor.layout();
    assert.equal(editor.controls.inert, true);
});

test("shared modal overlays lift their stacking context above the toolbox only while open", () => {
    const css = source.match(/const styles = `([\s\S]*?)`;/)[1];
    const base = css.match(/\.vnccs-unicanvas \.vnccs-uc-pose-root \{([^}]+)\}/)[1];
    const modal = css.match(/\.vnccs-unicanvas \.vnccs-uc-pose-root:has\(> \.vnccs-ps-modal-overlay\) \{([^}]+)\}/)[1];
    const toolbox = ucSource.match(/\.vnccs-uc-tools \{([^}]+)\}/)[1];
    const z = rule => Number(rule.match(/z-index:\s*(\d+)/)[1]);
    assert.ok(z(base) < z(toolbox), "viewport handles stay under the toolbox");
    assert.ok(z(modal) > z(toolbox), "the library must escape the viewport stacking order");
});

test("collapsing pose settings preserves the active page and scroll when reopened", () => {
    const { editor, layer } = harness(); editor.layer = layer; editor.studio = fakeStudio(); editor.buildDock();
    editor.pages[1].button.fire("click"); editor.pages[1].page.scrollTop = 240;
    editor.collapseButton.fire("click");
    assert.ok(editor.pages.every(entry => entry.page.hidden));
    editor.saveUI(); assert.equal(layer.pose.ui.collapsed, true);
    editor.collapseButton.fire("click");
    assert.equal(editor.pages[1].page.hidden, false); assert.equal(editor.pages[1].page.scrollTop, 240);
    editor.collapseButton.fire("click"); editor.pages[0].button.fire("click");
    assert.equal(editor.pages[0].page.hidden, false); assert.equal(editor.dockCollapsed, false);
});

test("the character popup previews layer references, clears them, and dismisses without losing selection", () => {
    const { editor, host, layer, context } = harness();
    const character = { id: "character", name: "Alice", type: "raster", visible: true };
    host.layers.push(character); host.getLayerThumbnailCanvas = () => Object.assign(new Element("canvas"), { name:"Alice" });
    editor.layer = layer; editor.studio = fakeStudio(); editor.buildDock();
    assert.equal(editor.characterMenu.hidden, true);
    editor.characterTrigger.fire("click");
    assert.equal(editor.characterMenu.hidden, false); assert.equal(editor.characterClose.focused, true);
    editor.characterSelect.value = character.id; editor.characterSelect.fire("change");
    assert.equal(layer.pose.character.layerId, character.id);
    assert.equal(editor.characterSummary.textContent, "Alice"); assert.equal(editor.characterPreview.src, "image:Alice");
    context.document.fire("pointerdown", { target: editor.characterPreview });
    assert.equal(editor.characterMenu.hidden, false);
    context.document.fire("pointerdown", { target: host.container });
    assert.equal(editor.characterMenu.hidden, true); assert.equal(layer.pose.character.layerId, character.id);
    editor.characterTrigger.fire("click"); editor.characterMenu.fire("keydown", { key: "Escape" });
    assert.equal(editor.characterMenu.hidden, true); assert.equal(editor.characterTrigger.focused, true);
    editor.characterTrigger.fire("click"); editor.setVisible(false);
    assert.equal(editor.characterMenu.hidden, true);
    editor.setVisible(true); editor.characterTrigger.fire("click"); editor.characterClear.fire("click");
    assert.equal(layer.pose.character, null); assert.equal(editor.characterThumb.hidden, true);
    assert.equal(editor.characterSummary.textContent, "Character"); assert.equal(editor.characterClear.disabled, true);
});

test("image2 contains only lower visible image layers plus the selected character exactly once", async () => {
    const { host, layer } = harness();
    const img = (id, visible = true, type = "raster") => ({ id, visible, type, opacity: 1 });
    const bottom = img("bottom"), lower = img("lower"), hidden = img("hidden", false), upper = img("upper"), mask = img("mask", true, "mask");
    host.layers = [mask, upper, layer, lower, hidden, bottom];
    const calls = []; host.drawRasterLayerToWorldRect = (_ctx, item) => calls.push(item.id);
    layer.pose.character = { source: "layer", layerId: lower.id };
    await state.composePoseReference(host, layer, { width: 128, height: 128 });
    assert.deepEqual(calls, ["bottom", "lower"]);
    calls.length = 0; layer.pose.character.layerId = upper.id;
    await state.composePoseReference(host, layer, { width: 128, height: 128 });
    assert.deepEqual(calls, ["bottom", "lower", "upper"]);
    host.layers = host.layers.filter(item => item !== upper);
    await assert.rejects(state.composePoseReference(host, layer, { width: 128, height: 128 }), /no longer exists/);
});

test("uploaded character is fitted into image2 and workflow metadata excludes its pixels", async () => {
    const { host, layer } = harness(); host.loadImage = async () => ({ width: 200, height: 400 });
    layer.pose.character = { source: "upload", dataURL: "data:image/png;base64,abc", name: "Reference" };
    const out = await state.composePoseReference(host, layer, { width: 100, height: 100 });
    assert.deepEqual(out.ctx.calls.at(-1).slice(2), [25, 0, 50, 100]);
    const metadata = state.serializePose(layer.pose, false), full = state.serializePose(layer.pose, true);
    assert.equal(metadata.character.dataURL, undefined);
    assert.equal(full.character.dataURL, layer.pose.character.dataURL);
    full.rect.x += 100; assert.equal(layer.pose.rect.x, 10);
});

test("live viewport changes refresh layer pixels before a gesture commits without PNG encoding", () => {
    const { editor, host, layer } = harness(); editor.layer = layer; editor.studio = fakeStudio();
    editor.initialized = true; editor.visible = true;
    let captures = 0, overlays = 0, commits = 0;
    editor.studio.viewer = { renderInteractionOverlay: () => overlays++, capture: (...args) => {
        captures++; assert.equal(args[8].transparent, true); assert.equal(args[8].viewport, true);
        return args[8].targetCanvas;
    } };
    editor.studio.exportParams = { bg_color: [255,255,255] };
    editor.studio.syncToNode = () => commits++;
    editor.capturePreview(); editor.capturePreview();
    assert.equal(captures, 2); assert.equal(overlays, 2); assert.equal(commits, 0);
    assert.equal(layer.canvas.ctx.calls.filter(call => call[0] === "draw").length, 2);
    assert.equal(layer.hiresRect.x, 10);
    assert.doesNotMatch(source.slice(source.indexOf("    capturePreview("), source.indexOf("    saveViewport(")), /toDataURL/);
});

test("shared capture returns transparent pixels and hides helpers while restoring renderer state", () => {
    const { viewer } = createScene();
    let captureRender;
    viewer.canvas.toDataURL = () => { throw new Error("No PNG encoding during interaction"); };
    viewer.beginCaptureBatch = noop; viewer.endCaptureBatch = noop;
    viewer.renderer = { render: (_scene, camera) => { captureRender = { camera, background: viewer.scene.background,
        markers: viewer.jointMarkers.map(m => m.visible), grid: viewer.gridHelper?.visible }; } };
    viewer.gridHelper = { visible: false }; viewer.refPlane = { visible: true };
    const originalBackground = viewer.scene.background;
    const target = new Element("canvas"); target.width = 400; target.height = 600;
    assert.equal(viewer.capture(400,600,1,[255,255,255],0,0,0,0,{ targetCanvas: target, transparent: true, viewport: true, hideReference: true }), target);
    assert.equal(captureRender.camera, viewer.camera); assert.equal(captureRender.background, null);
    assert.equal(viewer.scene.background, originalBackground);
    assert.equal(viewer.gridHelper.visible, false); assert.equal(viewer.refPlane.visible, true);
    assert.ok(captureRender.markers.every(v => v === false));
});

test("interaction overlay hides only rendered bodies and restores them even after renderer failure", () => {
    const { viewer } = createScene();
    let visibleDuring;
    viewer.renderer = { render: () => { visibleDuring = viewer.skinnedMesh.visible; throw new Error("GPU lost"); } };
    const background = viewer.scene.background;
    assert.throws(() => viewer.renderInteractionOverlay(), /GPU lost/);
    assert.equal(visibleDuring, false); assert.equal(viewer.skinnedMesh.visible, true);
    assert.equal(viewer.scene.background, background);
});

test("serialized pose, move history, node output and PSD use the same dedicated layer contract", () => {
    assert.match(ucSource, /pose: serializePose\(layer.pose, includeData\)/);
    assert.match(ucSource, /pose: item.type === "pose" \? serializePose\(item.pose\)/);
    assert.match(ucSource, /if \(snapshot.pose\) layer.pose = serializePose\(snapshot.pose\)/);
    assert.match(ucSource, /if \(layer.pose\) \{ layer.pose.rect.x \+= dx; layer.pose.rect.y \+= dy;/);
    assert.match(ucSource, /async exportPSD\(\) \{\s*try \{\s*await this.poseEditor\?\.flush\(\)/);
    assert.match(ucSource, /isImageLayer\(layer\) && layer.visible/);
    assert.match(ucSource, /pose_edit: poseRequest\?\.pose_edit/);
    assert.match(ucSource, /positive: poseRequest.positive, denoise: 1/);
});

function controlledStudio(load = async () => true) {
    const instances = [];
    class Studio {
        constructor(node, host) {
            Object.assign(this, fakeStudio()); this.node = node; this.host = host;
            this.exportParams = { bg_color: [255,255,255], view_width: 400, view_height: 600 };
            this._viewerInitPromise = Promise.resolve();
            const vector = values => ({ toArray: () => values.slice(), fromArray: v => { values = v.slice(); } });
            this.viewer = { scene: { background: null }, camera: { position: vector([1,2,3]), fov: 40, zoom: 1, updateProjectionMatrix: noop },
                orbit: { target: vector([0,0,0]), update: noop, addEventListener: noop },
                capture: (...args) => args[8].targetCanvas, renderInteractionOverlay: noop };
            this.loadModel = load; this.awaitReadyForCompositeCapture = async () => true;
            this.loadFromNode = noop; this.applyCameraToViewer = noop; this.refreshLibrary = async () => true;
            this.flushAnimationCacheUpload = async () => true;
            this.syncToNode = () => host.onStateChange({ export: { ...this.exportParams }, poses: [{}] });
            this.dispose = () => { this.disposed = true; };
            instances.push(this);
        }
    }
    return { Studio, instances };
}

test("deleting or switching a loading pose ignores old initialization and releases its editor", async () => {
    let finish;
    const controlled = controlledStudio(() => new Promise(resolve => { finish = resolve; }));
    const { editor, host, layer } = harness(controlled.Studio);
    const loading = editor.activate(layer);
    await new Promise(setImmediate);
    assert.equal(typeof finish, "function");
    host.layers = []; editor.release(); finish(); await loading;
    assert.equal(controlled.instances[0].disposed, true);
    assert.equal(editor.initialized, false); assert.equal(editor.studio, null);
});

test("a hidden pose keeps its scene without rebuilding and unchanged commits never reschedule saves", async () => {
    const controlled = controlledStudio();
    const { editor, host, layer } = harness(controlled.Studio);
    let saves = 0; host.scheduleFullSync = () => saves++;
    await editor.activate(layer);
    editor.commit(); const before = saves;
    editor.setVisible(false); editor.commit(); editor.commit();
    assert.equal(saves, before);
    await editor.activate(layer);
    assert.equal(controlled.instances.length, 1);
    assert.equal(editor.studio.container.hidden, false);
    const pixels = layer.canvas.ctx.calls.length;
    editor.setVisible(false); controlled.instances[0].host.onViewportRender();
    assert.equal(layer.canvas.ctx.calls.length, pixels, "hidden editors must not overwrite cached pixels");
    editor.release();
});

test("queue synchronization rejects a pose changed during asynchronous capture readiness", async () => {
    const controlled = controlledStudio();
    const { editor, host, layer } = harness(controlled.Studio);
    await editor.activate(layer);
    let finish;
    editor.studio.awaitReadyForCompositeCapture = () => new Promise(resolve => { finish = resolve; });
    const flush = editor.flush(); await Promise.resolve();
    host.layers = []; editor.release(); finish();
    await assert.rejects(flush, /changed while preparing/);
});

test("panorama cache hydration restores only the matching uploaded character pixels", () => {
    const cached = { rect: {x: 10}, character: { source: "upload", name: "A", dataURL: "pixels" } };
    const live = { rect: {x: 20}, character: { source: "upload", name: "A" } };
    assert.equal(state.mergePoseCache(live,cached).character.dataURL, "pixels");
    assert.equal(state.mergePoseCache(live,cached).rect.x, 20);
    live.character = null; assert.equal(state.mergePoseCache(live,cached).character, null);
    assert.equal(cached.character.dataURL, "pixels");
});

test("Pose Studio dimension inputs immediately resize the live bbox surface", () => {
    const { editor, host, layer } = harness(); editor.layer = layer; editor.studio = fakeStudio(); editor.buildDock();
    layer.pose.studio.export = { view_width: 400, view_height: 600 };
    let seen;
    editor.studio.performViewerResize = (width, height) => { seen = [width, height]; };
    editor.applyDimensions({ view_width: 640, view_height: 480 });
    assert.equal(layer.pose.rect.width, 640); assert.equal(host.bbox.height, 480);
    assert.deepEqual(seen, [640, 480]);
    assert.equal(editor.studio.canvasContainer.style.width, "640px");
});

test("generation reuses the Pose Studio prompt and leaves a rotated panorama camera untouched", async () => {
    const { w } = createScene();
    const { editor, host, layer } = harness(w.constructor);
    layer.pose.panoramaCamera = { yaw: 0, pitch: 0, roll: 0, fov: 90 };
    host.panorama = { settings: { yaw: 30, pitch: 0, roll: 0, fov: 90 } };
    layer.pose.studio = { export: { bg_color: [32,64,96], keepOriginalLighting: true,
        prompt_template: "Draw character from image2\n<lighting>\n<user_prompt>" }, pose_prompts: ["Keep the pose from image1"], lights: [] };
    const rendered = [];
    host.drawRasterLayerToWorldRect = (_ctx, item) => rendered.push(item.id);
    editor.activate = () => { throw new Error("Must not open the original pose view"); };
    const result = await editor.generation(layer, { width: 128, height: 128 });
    assert.equal(host.panorama.settings.yaw, 30);
    assert.equal(result.positive, "Draw character from image2\nKeep the pose from image1\nAdditional instruction");
    assert.deepEqual(Object.keys(result.pose_edit), ["image1", "image2"]);
    assert.deepEqual(rendered, ["pose"]);
});

test("switching between pose layers restores each sidebar tab and scroll position", () => {
    const { editor, host, layer } = harness(); editor.layer = layer; editor.studio = fakeStudio(); editor.buildDock();
    editor.studio.dispose = noop;
    const [tabs, ...pages] = editor.dock.children;
    pages[0].scrollTop = 123; pages[0].scrollLeft = 7;
    tabs.children[1].fire("click"); pages[1].scrollTop = 456;
    editor.release();
    editor.layer = layer; editor.studio = fakeStudio(); editor.buildDock();
    assert.equal(editor.pages[1].page.hidden, false);
    assert.equal(editor.pages[1].page.scrollTop, 456);
    editor.pages[0].button.fire("click");
    assert.equal(editor.pages[0].page.scrollTop, 123);
    assert.equal(editor.pages[0].page.scrollLeft, 7);
});
