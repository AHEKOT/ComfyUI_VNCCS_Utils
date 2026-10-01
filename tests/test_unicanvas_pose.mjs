import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import * as THREE from "../web/three.module.js";
import { POSE_HELP_CSS, buildPoseHelp } from "../web/vnccs_unicanvas_pose_help.mjs";
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
    const context = { ...state, document, AbortController, console, JSON, setTimeout, clearTimeout,
        requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
        window: { devicePixelRatio: 1 },
        // refreshCharacterMenu probes /vnccs/context_lists; tests stub the list directly.
        fetch: () => Promise.resolve({ ok: false }),
        Option: class extends Element {
        constructor(name, value) { super("option"); this.textContent = name; this.value = value; }
    }, PoseStudioWidget: studioClass, installCustomSelects: () => ({ disconnect: noop }),
    // The backdrop needs a real three.js viewer; tests/test_unicanvas_pose_backdrop.mjs covers it.
    POSE_HELP_CSS, buildPoseHelp,
    applyTorsoFraming: noop, installBodyDrag: () => noop, UniCanvasPoseWall: class { constructor() { this.mesh = { visible: false }; } update() {} dispose() {} },
    UniCanvasPoseBackdrop: class { invalidate() {} dispose() {} measure() { return null; } characterMeshes() { return []; } } };
    // CRLF-tolerant: the strip must also match `import ...;\r\n` on Windows checkouts.
    const Editor = vm.runInNewContext(source.replace(/^import .*?;\r?\n/gm, "").replace("export class", "class") + "\nUniCanvasPoseEditor", context);
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
        side: new Element(),
    };
    return { editor: new Editor(host), host, layer, context, Editor };
}

function fakeStudio() {
    const studio = { container: new Element(), leftPanel: new Element(), centerPanel: new Element(),
        rightSidebar: new Element(), canvasContainer: new Element(), animationTimeline: { stopPlayback: noop },
        hideHandControlPopover: noop, performViewerResize: noop,
        canvas: new Element(), _handPopover: new Element("div"), applyCameraToViewer: noop,
    };
    studio.centerPanel.appendChild(studio.canvasContainer);
    studio.centerPanel.appendChild(studio._handPopover);
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
    host.createLayerPixelSnapshot = item => ({ id: item.id, pose: JSON.parse(JSON.stringify(item.pose || null)) });
    host.restoreLayerPixelSnapshot = (item, snapshot) => { item.pose = JSON.parse(JSON.stringify(snapshot.pose)); calls.push(["restore", item.id]); };
    host.centerBbox = noop; host.refreshLayerRow = noop; host.updateHistoryButtons = noop;
    host.undoStack = []; host.redoStack = []; host.view = { x: 0, y: 0, scale: 1 };
    host.pushHistoryEntry = entry => host.undoStack.push(entry);
    const calls = [];
    host.setStatus = message => calls.push(["status", message]);
    host.poseEditor = {
        commit: () => calls.push(["commit"]),
        setVisible: show => calls.push(["visible", show]), layout: noop,
        activate: async (selected, options) => calls.push(["activate", selected.id, options.show]),
        setCharacterOpen: open => calls.push(["character", open]),
        generation: async selected => { calls.push(["generation", selected.id]); throw new Error("Capture stopped by test"); },
    };
    return { host, layer, raster, calls };
}

test("selecting a pose layer only selects it; Edit pose enters and Save pose leaves the editor", () => {
    const { host, layer, calls } = selectionHarness();
    host.setActiveLayer(layer.id);
    assert.equal(host.tool, "brush", "selection alone never opens the pose editor");
    assert.equal(host.activeLayerId, layer.id);
    assert.ok(!calls.some(call => call[0] === "activate"));
    host.editPoseLayer(layer);
    assert.equal(host.tool, "pose"); assert.equal(host.poseEditSession.layerId, layer.id);
    assert.deepEqual(calls.filter(call => call[0] === "activate"), [["activate", layer.id, true]]);
    host.finishPoseEdit(true);
    assert.equal(host.tool, "move"); assert.equal(host.poseEditSession, null);
    assert.ok(calls.some(call => call[0] === "visible" && call[1] === false));
    assert.equal(host.undoStack.length, 0, "an unchanged session adds no undo step");
});

test("selecting a raster layer leaves pose editing and keeps its character selection", () => {
    const { host, layer, raster, calls } = selectionHarness();
    layer.pose.character = { source:"layer", layerId:raster.id };
    host.editPoseLayer(layer);
    assert.ok(!calls.some(call => call[0] === "character"), "entering the editor never forces the character section");
    host.setActiveLayer(raster.id);
    assert.equal(host.tool, "move"); assert.equal(host.activeLayerId, raster.id);
    assert.ok(calls.some(call => call[0] === "visible" && call[1] === false));
    assert.equal(layer.pose.character.layerId, raster.id);
});

test("a pose edit session is one undo step on Save and fully restored on Cancel", () => {
    const { host, layer, calls } = selectionHarness();
    host.editPoseLayer(layer);
    layer.pose.studio = { changed: 1 };
    host.finishPoseEdit(true);
    assert.equal(host.undoStack.length, 1);
    assert.equal(host.undoStack[0].kind, "layerPixels");
    assert.deepEqual(host.undoStack[0].before.pose.studio, {});
    host.editPoseLayer(layer);
    layer.pose.studio = { changed: 2 };
    host.finishPoseEdit(false);
    assert.equal(host.tool, "move");
    assert.deepEqual(layer.pose.studio, { changed: 1 }, "Cancel restores the pose from before the session");
    assert.ok(calls.some(call => call[0] === "restore"));
    assert.equal(host.undoStack.length, 1, "a canceled session adds no undo step");
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
    assert.match(calls.filter(call => call[0] === "status").at(-1)[1], /Choose a character image/);
    assert.ok(!calls.some(call => call[0] === "generation"));
    assert.equal(host.drawBtn.disabled, false);
});

test("Generate reaches pose capture while the Pose tool is active and a character is selected", async () => {
    const { host, layer, raster, calls } = selectionHarness();
    layer.pose.character = { source:"layer", layerId:raster.id };
    host.editPoseLayer(layer); await host.draw();
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

test("the editor puts Body, Scene and the character reference in the right sidebar while shown", () => {
    const { editor, host, layer } = harness();
    editor.layer = layer; editor.studio = fakeStudio();
    const original = [editor.studio.leftPanel, editor.studio.rightSidebar];
    editor.buildDock();
    const pages = editor.dock.children.slice(1);
    assert.equal(pages.length, 2);
    assert.equal(editor.studio.centerPanel.hidden, true);
    // Hands stay editable in the embedded editor: the popover moves out of the hidden
    // center panel into the visible viewport container, which becomes its positioning host.
    assert.equal(editor.studio.handPopoverHost, editor.studio.canvasContainer);
    assert.equal(editor.studio._handPopover.parentElement, editor.studio.canvasContainer);
    assert.equal(editor.characterMenu.parentElement, editor.sidePanel);
    assert.equal(editor.dock.parentElement, editor.sidePanel);
    assert.equal(editor.editBar.parentElement, editor.controls);
    editor.setVisible(true); assert.equal(editor.sidePanel.parentElement, host.side);
    editor.setVisible(false); assert.equal(editor.sidePanel.parentElement, null);
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

test("the editor surface always covers the whole stage, whatever the pan and zoom", () => {
    const { editor, host, layer } = harness(); editor.layer = layer; editor.studio = fakeStudio(); editor.buildDock();
    for (const scale of [.25, .7, 1, 2.5]) {
        host.view = { x: -120, y: 50, scale };
        editor.layout();
        const style = editor.studio.canvasContainer.style;
        assert.deepEqual([style.left, style.top, style.width, style.height], ["320px", "40px", "1000px", "800px"]);
        assert.equal(style.clipPath, undefined);
    }
    layer.locked = true; editor.layout(); assert.equal(editor.sidePanel.inert, true);
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

test("the character reference section previews layer references and clears them", () => {
    const { editor, host, layer } = harness();
    const character = { id: "character", name: "Alice", type: "raster", visible: true };
    host.layers.push(character); host.getLayerThumbnailCanvas = () => Object.assign(new Element("canvas"), { name:"Alice" });
    editor.layer = layer; editor.studio = fakeStudio(); editor.buildDock();
    assert.match(editor.characterIssue.textContent, /Needed to generate/);
    editor.characterSelect.value = character.id; editor.characterSelect.fire("change");
    assert.equal(layer.pose.character.layerId, character.id);
    assert.equal(editor.characterPreview.src, "image:Alice"); assert.equal(editor.characterIssue.textContent, "");
    editor.setVisible(false); editor.setVisible(true);
    assert.equal(layer.pose.character.layerId, character.id);
    editor.characterClear.fire("click");
    assert.equal(layer.pose.character, null); assert.equal(editor.characterPreview.hidden, true);
    assert.equal(editor.characterClear.disabled, true);
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
    layer.pose.viewport = { position: [0, 10, 45], target: [0, 0, 0], fov: 40, zoom: 1 };
    let captures = 0, commits = 0;
    let position = [5, 6, 7], target = [0, 0, 0];
    editor.studio.viewer = {
        camera: { position: { toArray: () => position.slice(), fromArray: v => { position = v.slice(); } }, fov: 40, zoom: 1, aspect: 1, setViewOffset: noop, clearViewOffset: noop, updateProjectionMatrix: noop },
        orbit: { target: { toArray: () => target.slice(), fromArray: v => { target = v.slice(); } }, update: noop },
        renderer: { render: noop },
        capture: (...args) => {
            captures++; assert.equal(args[8].transparent, true); assert.equal(args[8].viewport, true);
            // The capture borrows the live camera: it must run on the stored framing...
            assert.deepEqual(editor.studio.viewer.camera.position.toArray(), [0, 10, 45]);
            return args[8].targetCanvas;
        },
    };
    editor.studio.exportParams = { bg_color: [255,255,255] };
    editor.studio.syncToNode = () => commits++;
    editor.capturePreview(); editor.capturePreview();
    assert.equal(captures, 2); assert.equal(commits, 0);
    assert.deepEqual(position, [5, 6, 7], "the inspection camera is put back after the capture");
    assert.equal(layer.canvas.ctx.calls.filter(call => call[0] === "draw").length, 2);
    assert.equal(layer.hiresRect.x, 10);
    assert.doesNotMatch(source.slice(source.indexOf("    capturePreview("), source.indexOf("    hidesLayerPixels(")), /toDataURL/);
});

test("navigation only inspects: no capture, no persisted viewport, the framing stays pinned", async () => {
    const controlled = controlledStudio();
    const { editor, host, layer } = harness(controlled.Studio);
    let layerCommits = 0; host.panorama = { commitLayer: () => layerCommits++ };
    await editor.activate(layer);
    const studio = controlled.instances[0];
    const framing = { ...layer.pose.viewport };
    assert.ok(framing, "activation seeds the persisted capture framing");
    const draws = () => layer.canvas.ctx.calls.filter(call => call[0] === "draw").length;
    const drawsBeforeNavigation = draws();

    // Orbit gesture: move the inspection camera and fire orbit start/end. Nothing may bake.
    const orbit = studio.viewer.orbit;
    orbit.fire("start");
    studio.viewer.camera.position.fromArray([90, 80, 70]);
    orbit.fire("end");
    assert.equal(editor.inspecting, false, "orbit end ends the inspection gesture");
    // JSON comparison: the vm harness creates objects in another realm.
    const framingJSON = camera => JSON.stringify(camera);
    assert.equal(framingJSON(layer.pose.viewport), framingJSON(framing), "orbiting never rewrites the capture framing");
    assert.equal(layerCommits, 0, "orbit end no longer commits pixels");

    // A wheel tick holds the inspection flag briefly: its render frames must not re-capture.
    studio.canvas.fire("wheel", { deltaY: -100 });
    assert.equal(editor.inspecting, true);
    studio.host.onViewportRender();
    assert.equal(draws(), drawsBeforeNavigation, "navigation frames never overwrite the stored-framing pixels");
    assert.equal(framingJSON(layer.pose.viewport), framingJSON(framing));
    assert.equal(layerCommits, 0, "navigation still has not committed");
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(editor.inspecting, false, "the wheel inspection window settles by itself");

    // A real edit still bakes through the stored framing with one trailing commit.
    studio.exportParams = { ...studio.exportParams, bg_color: [10, 20, 30] };
    studio.syncToNode();
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.ok(layerCommits >= 1, "an edit gesture commits once it settles");
    editor.release();
});

test("the session viewport spans the stage and the view offset lands the framing exactly on the pose rect", () => {
    const { editor, host, layer } = harness();
    let args = null;
    const camera = { aspect: 2, setViewOffset: (...a) => { args = a; }, updateProjectionMatrix: noop };
    editor.studio = { viewer: { camera }, canvasContainer: { clientWidth: 1000, clientHeight: 800 } };
    editor.layer = layer; editor.initialized = true; editor.visible = true;
    host.view = { x: 30, y: 50, scale: 0.5 };
    editor.syncSessionViewOffset();
    const [fullWidth, fullHeight, offsetX, offsetY, width, height] = args;
    assert.deepEqual([width, height], [1000, 800], "the window is the whole stage");
    // Screen rect of the layer: 400x600 at (10,20) -> x 35..235, y 60..360.
    const rx = 35, ry = 60, rw = 200, rh = 300;
    const frustumU = x => (x + offsetX) / fullWidth, frustumV = y => (y + offsetY) / fullHeight;
    assert.equal(frustumV(ry), 0, "rect top is the frustum top");
    assert.equal(frustumV(ry + rh), 1, "rect bottom is the frustum bottom");
    const half = rw / rh / camera.aspect / 2; // framing width as a fraction of the camera frustum
    assert.ok(Math.abs(frustumU(rx) - (0.5 - half)) < 1e-9 && Math.abs(frustumU(rx + rw) - (0.5 + half)) < 1e-9,
        "rect left/right are the framing edges, centred");
    assert.ok(source.includes("clipPath") === false, "the surface is no longer clipped to the generation box");
});

test("the baked pixels grow past the generation box to hold the whole mannequin", () => {
    const { editor, host, layer } = harness(); editor.layer = layer;
    layer.pose.rect = { x: 0, y: 0, width: 400, height: 400 };
    layer.pose.viewport = { position: [0, 0, 40], target: [0, 0, 0], fov: 40, zoom: 1 };
    const body = new THREE.Mesh(new THREE.BoxGeometry(4, 40, 4), new THREE.MeshBasicMaterial());
    editor.studio = { viewer: { THREE, camera: new THREE.PerspectiveCamera(40, 1, 0.1, 1000) } };
    editor.backdrop = { characterMeshes: () => [{ mesh: body }] };
    const region = editor.bakeRegion();
    assert.ok(region.y < 0 && region.height > 400, "a figure taller than the framing is not cut at the box");
    assert.ok(region.y >= -400 && region.y + region.height <= 800, "growth stays within one box size");
    body.scale.set(0.1, 0.1, 0.1);
    assert.equal(JSON.stringify(editor.bakeRegion()), JSON.stringify({ x: 0, y: 0, width: 400, height: 400 }), "a small figure keeps the box");
});

test("a capture leaves the session view offset and aspect exactly as they were", () => {
    const { editor, host, layer } = harness(); editor.layer = layer; editor.initialized = true; editor.visible = true;
    layer.pose.viewport = { position: [0, 0, 40], target: [0, 0, 0], fov: 40, zoom: 1 };
    const camera = new THREE.PerspectiveCamera(40, 1.7, 0.1, 1000);
    camera.position.set(3, 2, 30); camera.lookAt(0, 0, 0);
    const seen = [];
    editor.studio = { exportParams: {}, canvasContainer: { clientWidth: 1000, clientHeight: 800 },
        viewer: { THREE, camera, orbit: { target: new THREE.Vector3(), update() {} }, renderer: null,
            capture: (...args) => { seen.push([camera.aspect, camera.view.fullWidth, camera.view.width]); return args[8].targetCanvas; } } };
    host.view = { x: 30, y: 50, scale: 0.5 };
    editor.syncSessionViewOffset();
    const before = JSON.stringify([camera.aspect, camera.view]);
    for (const scale of [0.5, 1, 0.25]) editor.captureSurface(scale, true);
    assert.equal(JSON.stringify([camera.aspect, camera.view]), before, "no drift however many captures run at whatever scale");
    assert.equal(seen[0][0], 400 / 600, "the capture uses the pose rect aspect");
});

test("Reset camera and leaving the session put the inspection camera back on the framing", () => {
    const { editor, layer } = harness(); editor.layer = layer; editor.initialized = true;
    layer.pose.viewport = { position: [0, 0, 40], target: [0, 1, 0], fov: 40, zoom: 1 };
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
    const orbit = { target: new THREE.Vector3(), update() {} };
    editor.studio = { container: new Element(), viewer: { camera, orbit, requestRender: noop }, hideHandControlPopover: noop,
        animationTimeline: { stopPlayback: noop }, performViewerResize: noop };
    editor.sidePanel = null; editor.layout = noop;
    camera.position.set(9, 9, 9);
    editor.resetCamera();
    assert.deepEqual(camera.position.toArray(), [0, 0, 40]);
    assert.deepEqual(orbit.target.toArray(), [0, 1, 0]);
    camera.position.set(5, 5, 5);
    editor.setVisible(false);
    assert.deepEqual(camera.position.toArray(), [0, 0, 40], "Save pose and Cancel both end on the framing view");
});

test("undo and redo revert the mannequin only, never the inspection view, framing or camera sliders", () => {
    const { editor, layer } = harness(); editor.layer = layer; editor.initialized = true;
    layer.pose.viewport = { position: [0, 0, 40], target: [0, 0, 0], fov: 40, zoom: 1 };
    let position = [7, 8, 9], target = [1, 2, 3], undone = 0, redone = 0, persisted = 0;
    const camera = { position: { toArray: () => position.slice(), fromArray: v => { position = v.slice(); } }, fov: 40, zoom: 1, updateProjectionMatrix: noop };
    const viewer = { camera, cameraParams: { zoom: 1.5 }, requestRender: noop,
        orbit: { target: { toArray: () => target.slice(), fromArray: v => { target = v.slice(); } }, update: noop },
        // What a history snapshot does: put back the camera state recorded with it.
        undo() { undone++; position = [0, 0, 5]; viewer.cameraParams = { zoom: 1, yaw_deg: 0 }; layer.pose.viewport = { position: [1, 1, 1], target: [0, 0, 0], fov: 40, zoom: 1 }; },
        redo() { redone++; position = [0, 0, 6]; } };
    editor.studio = { viewer, exportParams: { cam_zoom: 1.5, cam_yaw_deg: 10 }, isAnimationMode: () => false, persistActivePoseCameraParams: () => persisted++ };
    const framing = JSON.stringify(layer.pose.viewport);
    // The history restore re-applies the slider camera, which reseeds the framing unless kept.
    viewer.undo = ((undo) => () => { undo(); editor.studio.exportParams.cam_zoom = 1; editor.studio.exportParams.cam_yaw_deg = 0; })(viewer.undo);
    assert.equal(editor.undo(), true);
    assert.equal(undone, 1);
    assert.deepEqual(position, [7, 8, 9], "the inspection camera is where the user left it");
    assert.equal(JSON.stringify(layer.pose.viewport), framing, "the capture framing (and so the wall) does not move");
    assert.deepEqual(JSON.parse(JSON.stringify(editor.studio.exportParams)), { cam_zoom: 1, cam_yaw_deg: 10 }, "the mannequin's own zoom undoes, the view angle does not");
    assert.equal(viewer.cameraParams.yaw_deg, 10);
    editor.redo();
    assert.equal(redone, 1); assert.deepEqual(position, [7, 8, 9]);
    assert.equal(editor.keepingCamera, false);
});

test("the eye button hides the wall for good: a capture must not bring it back", () => {
    const { editor, layer } = harness(); editor.layer = layer; editor.initialized = true;
    layer.pose.viewport = { position: [0, 0, 40], target: [0, 0, 0], fov: 40, zoom: 1 };
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
    const wall = { mesh: { visible: true } };
    editor.wall = wall;
    editor.eyeButton = Object.assign(new Element("button"), { innerHTML: "eye" });
    editor.studio = { exportParams: {}, viewer: { THREE, camera, orbit: { target: new THREE.Vector3(), update() {} },
        capture: (...args) => { assert.equal(wall.mesh.visible, false, "the wall is never in a capture"); return args[8].targetCanvas; } } };
    editor.toggleWall();
    assert.equal(wall.mesh.visible, false);
    assert.notEqual(editor.eyeButton.innerHTML, "eye");
    const closedIcon = editor.eyeButton.innerHTML;
    editor.captureSurface(1, true);
    assert.equal(wall.mesh.visible, false, "still hidden after a capture");
    editor.toggleWall();
    assert.equal(wall.mesh.visible, true);
    editor.captureSurface(1, true);
    assert.equal(wall.mesh.visible, true);
    assert.notEqual(editor.eyeButton.innerHTML, closedIcon, "the open eye is back");
});

test("the rotation gizmo shrinks with the character's zoom", () => {
    const { editor } = harness();
    const sizes = [];
    const control = { size: 0.8, setSize(value) { this.size = value; sizes.push(value); } };
    const viewer = { transform: control, skinnedMesh: { scale: { x: 1 } }, requestRender: noop };
    editor.studio = { viewer };
    editor.syncGizmoSize();
    assert.deepEqual(sizes, [], "full size stays at Pose Studio's own size");
    viewer.skinnedMesh.scale.x = 0.25; editor.syncGizmoSize();
    assert.ok(Math.abs(control.size - 0.2) < 1e-9);
    editor.syncGizmoSize();
    assert.equal(sizes.length, 1, "no redundant updates");
    viewer.skinnedMesh.scale.x = 0.01; editor.syncGizmoSize();
    assert.ok(Math.abs(control.size - 0.12) < 1e-9, "never vanishes");
});

test("the ? button opens an illustrated help popup that Esc closes without leaving the editor", () => {
    const { editor, host, layer } = harness(); editor.layer = layer; editor.studio = fakeStudio(); editor.buildDock();
    const bar = editor.editBar, labels = bar.children.map(child => child.textContent);
    assert.deepEqual(labels.filter(Boolean), ["Editing pose", "?", "Motion", "Reset camera", "Cancel", "Save pose"]);
    assert.ok(!bar.children.some(child => /Pose Library/.test(child.textContent)), "Pose Library lives in Scene only");
    const help = editor.help, question = bar.children.find(child => child.textContent === "?");
    assert.equal(help.open, false);
    question.fire("click");
    assert.equal(help.open, true);
    assert.equal(question.attrs["aria-expanded"], "true");
    assert.ok(editor.controls.children.includes(help.overlay), "the popup lives in the stage overlay");
    let leftEditor = 0; host.finishPoseEdit = () => leftEditor++;
    help.overlay.fire("keydown", { key: "Escape" });
    assert.equal(help.open, false);
    assert.equal(question.attrs["aria-expanded"], "false");
    assert.equal(leftEditor, 0);
});

test("the help popup illustrates every control it documents", () => {
    const html = [];
    const doc = { createElement: () => { const el = { children: [], attrs: {}, events: {}, style: {}, append(...c) { this.children.push(...c); },
        setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {}, set innerHTML(v) { html.push(v); }, get innerHTML() { return ""; } }; return el; } };
    buildPoseHelp(doc);
    const text = html.join(" ");
    for (const heading of ["Rotate a joint", "Move the body", "Move in depth (Z)", "Look around", "Camera mouse controls", "Buttons"]) assert.ok(text.includes(heading), heading);
    assert.equal((text.match(/<svg/g) || []).length >= 8, true, "drawings for each control and for the mouse buttons");
    for (const label of ["Reset camera", "Cancel", "Save pose", "Shift"]) assert.ok(text.includes(label), label);
});

test("the generation box outline is hidden exactly while the editing view is shown", () => {
    const { editor, host, layer } = harness(); editor.layer = layer;
    assert.equal(editor.hidesBbox(), false, "not initialized");
    editor.initialized = true; editor.visible = true;
    assert.equal(editor.hidesBbox(), true);
    layer.locked = true; assert.equal(editor.hidesBbox(), false); layer.locked = false;
    editor.visible = false; assert.equal(editor.hidesBbox(), false, "back on the normal canvas");
    editor.visible = true; host.hasOpenStagingPanel = () => true; assert.equal(editor.hidesBbox(), false);
    assert.match(ucSource, /if \(!this\.poseEditor\?\.hidesBbox\(\)\) this\.drawBbox\(ctx\)/);
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
    assert.match(ucSource, /positive: poseRequest\.positive, denoise: 1/);
});

test("captures run on the persisted framing; existing layers keep their saved framing", async () => {
    const controlled = controlledStudio();
    const { editor, layer } = harness(controlled.Studio);
    // Migration: a layer saved by the pre-split version stores the framing of its pixels;
    // activation must keep it verbatim (the look of previously saved layers is preserved).
    const saved = { position: [3, 9, 42], target: [0, 5, 0], fov: 33, zoom: 1.25 };
    layer.pose.viewport = JSON.parse(JSON.stringify(saved));
    await editor.activate(layer);
    assert.deepEqual(layer.pose.viewport, saved, "an existing capture framing is never replaced");
    assert.deepEqual(controlled.instances[0].viewer.camera.position.toArray(), saved.position,
        "the inspection view starts on the persisted framing");
    // Framing edits (Scene camera sliders) re-seed it through the wrapped applyCameraToViewer.
    const studio = controlled.instances[0];
    editor.initialized = true;
    studio.viewer.camera.position.fromArray([7, 8, 9]);
    editor.saveCaptureFraming();
    assert.deepEqual(layer.pose.viewport.position, [7, 8, 9]);
    editor.release();
});

test("the shared studio mounts the hand popover into an embedded host when one is set", async () => {
    const psSource = fs.readFileSync(new URL("../web/vnccs_pose_studio.js", import.meta.url), "utf8");
    assert.match(psSource, /_handPopoverHost\(\) \{\s*return this\.handPopoverHost \|\| this\.centerPanel \|\| this\.canvasContainer;/,
        "standalone keeps the center panel, an embedded host overrides it");
    assert.match(psSource, /this\._handPopoverHost\(\)\.appendChild\(panel\)/);
    const embedded = psSource.indexOf("const embeddedHost = host === this.canvasContainer;");
    assert.ok(embedded > psSource.indexOf("positionHandControlPopover("),
        "positioning clamps against the host box, with zero canvas offset in the embedded host");
});

function controlledStudio(load = async () => true) {
    const instances = [];
    class Studio {
        constructor(node, host) {
            Object.assign(this, fakeStudio()); this.node = node; this.host = host;
            this.exportParams = { bg_color: [255,255,255], view_width: 400, view_height: 600 };
            this._viewerInitPromise = Promise.resolve();
            const vector = values => ({ toArray: () => values.slice(), fromArray: v => { values = v.slice(); } });
            const orbitEvents = {};
            this.viewer = { scene: { background: null }, camera: { position: vector([1,2,3]), fov: 40, zoom: 1, aspect: 1, setViewOffset: noop, clearViewOffset: noop, updateProjectionMatrix: noop },
                orbit: {
                    target: vector([0,0,0]), update: noop,
                    addEventListener: (name, callback) => (orbitEvents[name] ||= []).push(callback),
                    fire: name => orbitEvents[name]?.forEach(callback => callback()),
                },
                renderer: { render: noop },
                capture: (...args) => args[8].targetCanvas, renderInteractionOverlay: noop };
            this.applyCameraToViewer = noop;
            this.loadModel = load; this.awaitReadyForCompositeCapture = async () => true;
            this.loadFromNode = noop; this.refreshLibrary = async () => true;
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

test("Pose Studio dimension inputs immediately resize the live pose rect", () => {
    const { editor, host, layer } = harness(); editor.layer = layer; editor.studio = fakeStudio(); editor.buildDock();
    layer.pose.studio.export = { view_width: 400, view_height: 600 };
    let seen;
    editor.studio.performViewerResize = (width, height) => { seen = [width, height]; };
    editor.applyDimensions({ view_width: 640, view_height: 480 });
    assert.equal(layer.pose.rect.width, 640); assert.equal(host.bbox.height, 480);
    assert.deepEqual(seen, [640, 480]);
    assert.equal(editor.studio.canvasContainer.style.width, "1000px", "the surface stays stage-sized");
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

test("viewport frames behind the live pose view never capture; edits bake once when they settle", async () => {
    const controlled = controlledStudio();
    const { editor, host, layer } = harness(controlled.Studio);
    await editor.activate(layer);
    const studio = controlled.instances[0];
    let captures = 0;
    const capture = studio.viewer.capture;
    studio.viewer.capture = (...args) => { captures += 1; return capture(...args); };
    assert.equal(editor.hidesLayerPixels(layer), true, "the editing view hides the baked pixels");
    for (let i = 0; i < 5; i += 1) studio.host.onViewportRender();
    assert.equal(captures, 0, "no per-frame capture (buffer resize, extra renders, stage repaint) during a drag");
    assert.equal(editor.previewStale, true);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(captures, 0, "frames alone (hover, orbit) bake nothing once they stop");
    studio.syncToNode();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(captures, 1, "the finished edit bakes once through the settle commit");
    assert.equal(editor.previewStale, false);
    editor.release();
});

test("stale pose pixels are re-captured through one viewport frame when they become visible", async () => {
    const controlled = controlledStudio();
    const { editor, layer } = harness(controlled.Studio);
    await editor.activate(layer);
    const studio = controlled.instances[0];
    let renders = 0;
    studio.viewer.requestRender = () => { renders += 1; };
    studio.host.onViewportRender();
    editor.layout();
    assert.equal(renders, 0, "hidden pixels request nothing");
    layer.locked = true;
    editor.layout();
    assert.equal(renders, 1, "the pixels are shown again: one frame refreshes them");
    const draws = layer.canvas.ctx.calls.filter(call => call[0] === "draw").length;
    studio.host.onViewportRender();
    assert.equal(layer.canvas.ctx.calls.filter(call => call[0] === "draw").length, draws + 1);
    assert.equal(editor.previewStale, false);
    editor.layout();
    assert.equal(renders, 1);
    editor.release();
});

test("torso moves persist once after the movement instead of on every drag frame", async () => {
    const controlled = controlledStudio();
    const { editor, layer } = harness(controlled.Studio);
    await editor.activate(layer);
    const studio = controlled.instances[0];
    let syncs = 0;
    const sync = studio.syncToNode;
    studio.syncToNode = (...args) => { syncs += 1; return sync(...args); };
    for (let i = 0; i < 10; i += 1) editor.scheduleBackdropSync();
    assert.equal(syncs, 0, "no serialization while the character keeps moving");
    editor.flushBackdropSync();
    assert.equal(syncs, 1, "the drag end persists the move at once");
    editor.flushBackdropSync();
    assert.equal(syncs, 1, "nothing pending, nothing to persist");
    editor.scheduleBackdropSync(); editor.scheduleBackdropSync();
    await new Promise(resolve => setTimeout(resolve, 160));
    assert.equal(syncs, 2, "a clamp without a drag end persists after the movement");
    editor.scheduleBackdropSync();
    editor.release();
    const released = syncs;
    await new Promise(resolve => setTimeout(resolve, 160));
    assert.equal(syncs, released, "a released editor has no pending sync");
});

test("UniCanvas skips its stage hover work for pointer moves over the open pose editor", () => {
    const { host } = selectionHarness();
    const surface = new Element("canvas");
    host.poseEditor = { visible: true, studio: { container: { contains: target => target === surface } } };
    let reads = 0;
    host.canvasPointFromEvent = () => { reads += 1; return { x: 0, y: 0 }; };
    host.isPointerDown = false;
    host.onPointerMove({ target: surface, clientX: 1, clientY: 1 });
    assert.equal(reads, 0, "a pose drag must not read the stage layout per event");
    host.onPointerMove({ target: new Element("canvas"), clientX: 1, clientY: 1 });
    assert.equal(reads, 1, "moves elsewhere keep the stage hover");
    host.poseEditor.visible = false;
    host.onPointerMove({ target: surface, clientX: 1, clientY: 1 });
    assert.equal(reads, 2);
});

test("a held pointer in the pose editor is a gesture until any pointer is released", async () => {
    const controlled = controlledStudio();
    const { editor, layer, context } = harness(controlled.Studio);
    const windowEvents = {};
    context.addEventListener = (type, callback, options) => {
        (windowEvents[type] ||= []).push(callback);
        options?.signal?.addEventListener?.("abort", () => { windowEvents[type] = windowEvents[type].filter(item => item !== callback); });
    };
    await editor.activate(layer);
    const studio = controlled.instances[0];
    assert.equal(editor.isGestureActive(), false);
    studio.canvasContainer.fire("pointerdown");
    assert.equal(editor.isGestureActive(), true, "a joint, gizmo or torso drag is under way");
    windowEvents.pointerup.forEach(callback => callback({}));
    assert.equal(editor.isGestureActive(), false);
    editor.sidePanel.fire("pointerdown");
    assert.equal(editor.isGestureActive(), true, "sidebar sliders count too");
    editor.setVisible(false);
    assert.equal(editor.isGestureActive(), false, "a hidden editor never holds UniCanvas syncs");
    editor.release();
    assert.equal(windowEvents.pointerup.length, 0, "window listeners are removed with the editor");
});

test("UniCanvas defers its state upload while a pose gesture is in progress", async () => {
    const { host } = selectionHarness();
    let rescheduled = 0, built = 0;
    host.scheduleStateUpload = () => { rescheduled += 1; };
    host.buildSerializedState = () => { built += 1; return { layers: [] }; };
    host.uploadStatePayload = async () => true;
    host.pendingStateUpload = true;
    host.poseEditor.isGestureActive = () => true;
    await host.uploadStateSnapshot();
    assert.equal(built, 0, "no capture or PNG encoding in the middle of a drag");
    assert.equal(rescheduled, 1);
    host.poseEditor.isGestureActive = () => false;
    await host.uploadStateSnapshot();
    assert.equal(built, 1);
});
