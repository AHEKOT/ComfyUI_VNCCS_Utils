import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import * as THREE from "../web/vendor/three/three.module.js";
import { POSE_STUDIO_EDITOR_ONLY_LAYER, PoseViewerCore } from "../web/pose_studio/core.js";
import {
    REFERENCE_LAYER_LIMIT,
    clientToNdc,
    createReferenceLayer,
    dragReferenceLayer,
    fitReferenceLayerScale,
    frameToLayerLocal,
    frameToOutputPixels,
    hitTestReferenceLayer,
    layerLocalToFrame,
    ndcToCssPixels,
    normalizeReferenceLayers,
    normalizeRotation,
    outputPixelsToFrame,
    referenceLayerCorners,
    referenceLayerHistorySnapshot,
    reorderReferenceLayers,
    restoreReferenceLayerHistory,
    serializeReferenceLayers,
} from "../web/pose_studio/reference_layers.mjs";
import { PoseReferenceLayerController, referenceLayerResizeCursor } from "../web/pose_studio/reference_layers_controller.mjs";
import { createScene } from "./helpers/pose_studio_scene.mjs";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const near = (a, b, eps = 1e-6, message = "") => assert.ok(Math.abs(a - b) <= eps, `${message} ${a} vs ${b}`);
const layer = (patch = {}) => ({
    id: "a", name: "A", src: PNG, width: 200, height: 100, visible: true, locked: false, flipX: false,
    opacity: 0.5, x: 0, y: 0, scale: 0.5, rotation: 0, ...patch,
});

// --- Model ---------------------------------------------------------------

test("old workflows and invalid data load with no reference layers", () => {
    for (const raw of [undefined, null, {}, "x", 3]) assert.deepEqual(normalizeReferenceLayers(raw), []);
    assert.deepEqual(normalizeReferenceLayers([null, 1, {}, { src: "https://x/y.png", width: 1, height: 1 },
        { src: PNG, width: 0, height: 4 }, { src: "data:text/html;base64,AA==", width: 1, height: 1 }]), []);
    assert.equal(serializeReferenceLayers([]), undefined);
});

test("stored layers are clamped, capped and get unique ids", () => {
    const raw = Array.from({ length: REFERENCE_LAYER_LIMIT + 3 }, (_, index) => layer({
        id: index < 3 ? "dup" : `l${index}`, opacity: 4, scale: 999, x: -1e9, rotation: 540 + index,
    }));
    const layers = normalizeReferenceLayers(raw);
    assert.equal(layers.length, REFERENCE_LAYER_LIMIT);
    assert.equal(new Set(layers.map(item => item.id)).size, layers.length);
    for (const item of layers) {
        assert.equal(item.opacity, 1);
        assert.equal(item.scale, 20);
        assert.equal(item.x, -50);
        assert.ok(item.rotation > -180 && item.rotation <= 180);
    }
});

test("persistence round trip keeps every field exactly", () => {
    const layers = normalizeReferenceLayers([
        layer({ id: "bottom", x: 0.125, y: -0.25, scale: 0.75, rotation: -33.5, opacity: 0.3, flipX: true }),
        layer({ id: "top", visible: false, locked: true, name: "Top" }),
    ]);
    const saved = JSON.parse(JSON.stringify(serializeReferenceLayers(layers)));
    assert.deepEqual(normalizeReferenceLayers(saved), layers);
    assert.deepEqual(saved.map(item => item.id), ["bottom", "top"]);
});

test("history snapshots exclude image data and restore through the image store", () => {
    const layers = normalizeReferenceLayers([layer({ id: "a" }), layer({ id: "b", x: 0.2 })]);
    const snapshot = referenceLayerHistorySnapshot(layers);
    assert.ok(snapshot.every(item => !("src" in item)));
    const images = new Map(layers.map(item => [item.id, item.src]));
    assert.deepEqual(restoreReferenceLayerHistory(snapshot, images), layers);
    images.delete("a");
    assert.deepEqual(restoreReferenceLayerHistory(snapshot, images).map(item => item.id), ["b"]);
});

test("new layers fit inside the frame for square and non-square outputs", () => {
    near(fitReferenceLayerScale(1000, 1000, 1), 1);
    near(fitReferenceLayerScale(2000, 1000, 1), 0.5);
    near(fitReferenceLayerScale(1000, 2000, 1), 1);
    near(fitReferenceLayerScale(2000, 1000, 16 / 9), 16 / 9 / 2);
    const created = createReferenceLayer({ name: "n", src: PNG, width: 400, height: 100 }, 1.5);
    const corners = referenceLayerCorners(created);
    for (const corner of corners) {
        assert.ok(Math.abs(corner.x) <= 0.75 + 1e-9 && Math.abs(corner.y) <= 0.5 + 1e-9, JSON.stringify(corner));
    }
});

// --- Transform math ------------------------------------------------------

test("frame and layer-local coordinates round trip under rotation and offset", () => {
    for (const rotation of [-170, -90, -12.5, 0, 33, 90, 180]) {
        const item = layer({ x: 0.3, y: -0.2, rotation });
        for (const point of [{ x: 0, y: 0 }, { x: 0.4, y: 0.1 }, { x: -1.2, y: 0.9 }]) {
            const back = frameToLayerLocal(item, layerLocalToFrame(item, point));
            near(back.x, point.x); near(back.y, point.y);
        }
    }
    // Clockwise on screen: the local +x axis points down-right after +90°.
    const turned = layerLocalToFrame(layer({ rotation: 90 }), { x: 1, y: 0 });
    near(turned.x, 0); near(turned.y, -1);
});

test("hit testing follows the rotated rectangle", () => {
    const item = layer({ x: 0.1, y: 0.1, rotation: 45, scale: 0.4 }); // 0.8 x 0.4
    assert.ok(hitTestReferenceLayer(item, { x: 0.1, y: 0.1 }));
    assert.ok(hitTestReferenceLayer(item, layerLocalToFrame(item, { x: 0.39, y: 0.19 })));
    assert.ok(!hitTestReferenceLayer(item, layerLocalToFrame(item, { x: 0.41, y: 0 })));
    assert.ok(!hitTestReferenceLayer(item, layerLocalToFrame(item, { x: 0, y: 0.21 })));
});

test("move, scale and rotate gestures are exact and reversible", () => {
    const start = layer({ x: 0.1, y: -0.1, scale: 0.4, rotation: 10 });
    const p0 = { x: 0.3, y: 0.05 };
    const moved = dragReferenceLayer("move", start, p0, { x: 0.55, y: -0.2 });
    near(moved.x, 0.35); near(moved.y, -0.35);
    const back = dragReferenceLayer("move", { ...start, ...moved }, { x: 0.55, y: -0.2 }, p0);
    near(back.x, start.x); near(back.y, start.y);

    const scaled = dragReferenceLayer("scale", start, { x: 0.3, y: -0.1 }, { x: 0.5, y: -0.1 });
    near(scaled.scale, 0.8);
    near(dragReferenceLayer("scale", { ...start, ...scaled }, { x: 0.5, y: -0.1 }, { x: 0.3, y: -0.1 }).scale, 0.4);

    // Pointer moves counter-clockwise by 90° around the centre: -90° on screen.
    const rotated = dragReferenceLayer("rotate", start, { x: 0.3, y: -0.1 }, { x: 0.1, y: 0.1 });
    near(rotated.rotation, -80);
    near(dragReferenceLayer("rotate", start, { x: 0.3, y: -0.1 }, { x: 0.1, y: 0.1 + 1e-3 }, { snap: true }).rotation, -75);
    near(normalizeRotation(190), -170);
    near(normalizeRotation(-180), 180);
});

test("output pixel mapping is consistent for non-square outputs", () => {
    for (const [width, height] of [[1024, 1024], [1536, 512], [512, 1536]]) {
        const point = { x: 0.2, y: -0.15 };
        const pixel = frameToOutputPixels(point, width, height);
        near(pixel.x, width / 2 + 0.2 * height);
        near(pixel.y, height / 2 + 0.15 * height);
        const back = outputPixelsToFrame(pixel, width, height);
        near(back.x, point.x); near(back.y, point.y);
    }
});

test("pointer mapping is independent of ComfyUI canvas zoom", () => {
    for (const zoom of [0.6, 1, 1.4]) {
        const rect = { left: 37, top: 12, width: 400 * zoom, height: 300 * zoom };
        const ndc = clientToNdc(rect.left + 100 * zoom, rect.top + 75 * zoom, rect);
        near(ndc.x, -0.5); near(ndc.y, 0.5);
        const css = ndcToCssPixels(ndc, 400, 300);
        near(css.x, 100); near(css.y, 75);
    }
});

test("reordering moves layers within the stack and stops at the ends", () => {
    const layers = normalizeReferenceLayers([layer({ id: "a" }), layer({ id: "b" }), layer({ id: "c" })]);
    assert.deepEqual(reorderReferenceLayers(layers, "a", 1).map(item => item.id), ["b", "a", "c"]);
    assert.deepEqual(reorderReferenceLayers(layers, "c", -1).map(item => item.id), ["a", "c", "b"]);
    assert.equal(reorderReferenceLayers(layers, "c", 1), layers);
    assert.equal(reorderReferenceLayers(layers, "a", -1), layers);
});

// --- Controller with a real viewer camera rig ----------------------------

class FakeElement {
    constructor(tag = "div") {
        this.tagName = tag.toUpperCase();
        this.style = {};
        this.dataset = {};
        this.children = [];
        this.listeners = [];
        this.classes = new Set();
        this.classList = {
            add: name => this.classes.add(name),
            remove: name => this.classes.delete(name),
            toggle: (name, force) => ((force ?? !this.classes.has(name)) ? this.classes.add(name) : this.classes.delete(name)),
            contains: name => this.classes.has(name),
        };
        this.clientWidth = 400;
        this.clientHeight = 300;
        this.rect = { left: 0, top: 0, width: 400, height: 300 };
        this.attributes = {};
    }
    set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
    get className() { return [...this.classes].join(" "); }
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    remove() {}
    setAttribute(name, value) { this.attributes[name] = value; }
    getBoundingClientRect() { return this.rect; }
    getContext() { return new Proxy({}, { get: (state, key) => state[key] ?? (() => {}), set: (state, key, value) => { state[key] = value; return true; } }); }
    setPointerCapture(id) { this.capture = id; }
    hasPointerCapture(id) { return this.capture === id; }
    releasePointerCapture() { this.capture = null; }
    addEventListener(type, fn, options) {
        this.listeners.push({ type, fn, capture: options === true || options?.capture === true });
    }
    removeEventListener(type, fn, options) {
        const capture = options === true || options?.capture === true;
        this.listeners = this.listeners.filter(item => !(item.type === type && item.fn === fn && item.capture === capture));
    }
    dispatch(type, init = {}) {
        let stopped = false;
        const event = {
            type, target: this, button: 0, buttons: 0, pointerId: 1, shiftKey: false, ...init,
            defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() {},
            stopImmediatePropagation() { stopped = true; },
        };
        const ordered = [...this.listeners.filter(item => item.capture), ...this.listeners.filter(item => !item.capture)];
        for (const item of ordered) {
            if (item.type !== type) continue;
            item.fn(event);
            if (stopped) break;
        }
        event.stopped = stopped;
        return event;
    }
    click() { this.dispatch("click"); }
}

const fakeDocument = { createElement: tag => new FakeElement(tag), head: null, getElementById: () => null };
// Synchronous stand-in for THREE.TextureLoader (no DOM image decoding in Node).
const loadTexture = (src, onLoad) => onLoad(new THREE.Texture());

function createRig({ zoom = 1, width = 1024, height = 1024 } = {}) {
    const canvas = new FakeElement("canvas");
    canvas.rect = { left: 120, top: 80, width: 400 * zoom, height: 300 * zoom };
    const viewer = new PoseViewerCore(canvas);
    viewer.THREE = THREE;
    viewer.scene = new THREE.Scene();
    viewer.camera = new THREE.PerspectiveCamera(45, 400 / 300, 0.1, 1000);
    viewer.camera.layers.enable(POSE_STUDIO_EDITOR_ONLY_LAYER);
    viewer.captureCamera = new THREE.PerspectiveCamera(30, 1, 0.1, 500);
    viewer.scene.add(viewer.camera, viewer.captureCamera);
    viewer.captureFrame = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
    viewer.scene.add(viewer.captureFrame);
    viewer.meshCenter = new THREE.Vector3(0, 10, 0);
    viewer.renders = 0;
    viewer.requestRender = () => { viewer.renders++; };
    viewer.updateCaptureCamera(width, height, 1, 0, 0, 0, 0);
    // Editor camera aligned with the capture camera, a little further back.
    viewer.camera.position.set(0, 10, 70);
    viewer.camera.lookAt(0, 10, 0);
    viewer.camera.updateMatrixWorld(true);
    const calls = { record: 0, sync: 0, messages: [] };
    viewer.recordState = () => { calls.record++; };
    const host = {
        host: {},
        exportParams: { view_width: width, view_height: height },
        viewer,
        isAnimationMode: () => false,
        syncToNode: () => { calls.sync++; },
        showMessage: message => calls.messages.push(message),
    };
    const container = new FakeElement();
    const controller = new PoseReferenceLayerController(host, {
        document: fakeDocument, editorOnlyLayer: POSE_STUDIO_EDITOR_ONLY_LAYER, loadTexture,
        decodeImageFile: async file => ({ src: PNG, width: file.width || 300, height: file.height || 150 }),
    });
    controller.attachViewer(viewer, container);
    // Bone picking / orbit stand-in registered like the viewer's own listeners.
    const passed = [];
    for (const type of ["pointerdown", "pointermove", "pointerup"]) canvas.addEventListener(type, () => passed.push(type));
    return { canvas, viewer, controller, calls, passed, host, container };
}

function clientAt(rig, point) {
    rig.controller.syncFrame();
    const css = rig.controller.frameToCss(point);
    const { rect, clientWidth, clientHeight } = rig.canvas;
    return { clientX: rect.left + css.x / clientWidth * rect.width, clientY: rect.top + css.y / clientHeight * rect.height };
}

function drag(rig, from, to, init = {}) {
    const start = clientAt(rig, from), end = clientAt(rig, to);
    const down = rig.canvas.dispatch("pointerdown", { ...start, buttons: 1, ...init });
    const steps = 4;
    for (let step = 1; step <= steps; step++) {
        rig.canvas.dispatch("pointermove", {
            clientX: start.clientX + (end.clientX - start.clientX) * step / steps,
            clientY: start.clientY + (end.clientY - start.clientY) * step / steps,
            buttons: 1, ...init,
        });
    }
    rig.canvas.dispatch("pointerup", { ...end, ...init });
    return down;
}

test("layer meshes live on the editor-only render layer and follow the capture frame", () => {
    const rig = createRig({ width: 1536, height: 1024 });
    rig.controller.load([layer({ id: "a", x: 0.25, y: 0.1 })]);
    rig.controller.syncFrame();
    const entry = rig.controller.entries.get("a");
    assert.ok(entry);
    assert.equal(entry.mesh.layers.test(rig.viewer.captureCamera.layers), false, "capture camera never sees layers");
    assert.equal(entry.mesh.layers.test(rig.viewer.camera.layers), true, "editor camera sees layers");
    assert.equal(entry.mesh.parent, rig.controller.group);
    assert.equal(rig.controller.group.parent, rig.viewer.captureCamera);
    // Frame centre and frame height in world units match the orange frame.
    const center = rig.controller.group.localToWorld(new THREE.Vector3(0, 0, 0));
    near(center.distanceTo(rig.viewer.captureFrame.position), 0, 1e-6);
    const top = rig.controller.group.localToWorld(new THREE.Vector3(0, 0.5, 0));
    near(top.y - center.y, rig.viewer.captureFrame.scale.y, 1e-6);
    // Projected through the capture camera, a frame point lands on its output pixel.
    const projected = rig.controller.group.localToWorld(new THREE.Vector3(0.25, 0.1, 0)).project(rig.viewer.captureCamera);
    const expected = frameToOutputPixels({ x: 0.25, y: 0.1 }, 1536, 1024);
    near((projected.x + 1) / 2 * 1536, expected.x, 1e-3);
    near((1 - projected.y) / 2 * 1024, expected.y, 1e-3);
});

test("output size changes keep layers attached to frame-height space", () => {
    const rig = createRig({ width: 1024, height: 1024 });
    rig.controller.load([layer({ id: "a", x: 0.2, y: 0 })]);
    rig.viewer.updateCaptureCamera(1536, 1024, 1, 0, 0, 0, 0);
    rig.controller.syncFrame();
    const world = rig.controller.group.localToWorld(new THREE.Vector3(0.2, 0, 0)).project(rig.viewer.captureCamera);
    near((world.x + 1) / 2 * 1536, 768 + 0.2 * 1024, 1e-3);
});

for (const zoom of [0.6, 1, 1.4]) {
    test(`viewport drag moves, scales and rotates the selected layer at canvas zoom ${zoom}`, () => {
        const rig = createRig({ zoom });
        rig.controller.load([layer({ id: "a", x: 0, y: 0, scale: 0.5, width: 200, height: 100 })]);
        rig.controller.setEditMode(true);

        const down = drag(rig, { x: 0.05, y: 0.02 }, { x: 0.25, y: -0.08 });
        assert.equal(down.stopped, true, "the gesture never reaches bone picking or orbit");
        assert.deepEqual(rig.passed, [], "no viewer listener ran during the layer gesture");
        let current = rig.controller.selectedLayer();
        near(current.x, 0.2, 1e-6, "x"); near(current.y, -0.1, 1e-6, "y");
        assert.equal(rig.calls.record, 1, "one undo step per gesture");
        assert.equal(rig.calls.sync, 1, "saved once at gesture end");

        // Corner handle: scale around the centre.
        const corner = referenceLayerCorners(current)[1];
        const outward = { x: current.x + (corner.x - current.x) * 1.5, y: current.y + (corner.y - current.y) * 1.5 };
        drag(rig, corner, outward);
        current = rig.controller.selectedLayer();
        near(current.scale, 0.75, 1e-4, "scale");
        assert.equal(rig.calls.record, 2);

        // Rotate handle sits outside the top edge; drag it a quarter turn clockwise.
        rig.controller.syncFrame();
        const handles = rig.controller.handleGeometry(current);
        const { rect, clientWidth, clientHeight } = rig.canvas;
        const toClient = css => ({ clientX: rect.left + css.x / clientWidth * rect.width, clientY: rect.top + css.y / clientHeight * rect.height });
        const knob = toClient(handles.rotate);
        const knobFrame = rig.controller.ndcToFrame(clientToNdc(knob.clientX, knob.clientY, rect));
        const radius = Math.hypot(knobFrame.x - current.x, knobFrame.y - current.y);
        const target = clientAt(rig, { x: current.x + radius, y: current.y });
        rig.canvas.dispatch("pointerdown", { ...knob, buttons: 1 });
        rig.canvas.dispatch("pointermove", { ...target, buttons: 1 });
        rig.canvas.dispatch("pointerup", target);
        near(rig.controller.selectedLayer().rotation, 90, 1e-3, "rotation");
        assert.equal(rig.calls.record, 3);
        assert.deepEqual(rig.passed, []);
    });
}

test("pointers pass through outside edit mode, outside the layer, and for locked or hidden layers", () => {
    const rig = createRig();
    rig.controller.load([layer({ id: "a", scale: 0.3 })]);
    const inside = clientAt(rig, { x: 0, y: 0 });
    assert.equal(rig.canvas.dispatch("pointerdown", inside).stopped, false, "edit mode off");
    rig.controller.setEditMode(true);
    assert.equal(rig.canvas.dispatch("pointerdown", clientAt(rig, { x: 0.45, y: 0.45 })).stopped, false, "outside layer");
    assert.equal(rig.canvas.dispatch("pointerdown", { ...inside, button: 2 }).stopped, false, "right button orbits");
    rig.controller.updateLayer("a", { locked: true });
    assert.equal(rig.canvas.dispatch("pointerdown", inside).stopped, false, "locked");
    rig.controller.updateLayer("a", { locked: false, visible: false });
    assert.equal(rig.canvas.dispatch("pointerdown", inside).stopped, false, "hidden");
    assert.equal(rig.calls.record, 0);
    assert.equal(rig.passed.filter(type => type === "pointerdown").length, 5);
});

test("hover cursors follow each corner's diagonal and the rotate handle", () => {
    const center = { x: 0, y: 0 };
    assert.equal(referenceLayerResizeCursor(center, { x: 10, y: 10 }), "nwse-resize");
    assert.equal(referenceLayerResizeCursor(center, { x: -10, y: -10 }), "nwse-resize");
    assert.equal(referenceLayerResizeCursor(center, { x: 10, y: -10 }), "nesw-resize");
    assert.equal(referenceLayerResizeCursor(center, { x: -10, y: 10 }), "nesw-resize");
    assert.equal(referenceLayerResizeCursor(center, { x: 0, y: 10 }), "ns-resize");
    assert.equal(referenceLayerResizeCursor(center, { x: -10, y: 1 }), "ew-resize");

    const rig = createRig();
    rig.controller.load([layer({ id: "a", scale: 0.4 })]);
    rig.controller.setEditMode(true);
    const hover = point => {
        rig.canvas.dispatch("pointermove", { ...clientAt(rig, point), buttons: 0 });
        return rig.canvas.style.cursor;
    };
    const cursors = referenceLayerCorners(rig.controller.selectedLayer()).map(hover);
    assert.equal(cursors.filter(cursor => cursor === "nwse-resize").length, 2);
    assert.equal(cursors.filter(cursor => cursor === "nesw-resize").length, 2);
    // Opposite corners share a cursor.
    assert.equal(cursors[0], cursors[2]);
    assert.equal(cursors[1], cursors[3]);
    // A 90 degree turn swaps the diagonals.
    rig.controller.updateLayer("a", { rotation: 90 });
    const turned = referenceLayerCorners(rig.controller.selectedLayer()).map(hover);
    assert.deepEqual(turned, [cursors[1], cursors[0], cursors[3], cursors[2]]);

    const handles = rig.controller.handleGeometry(rig.controller.selectedLayer());
    const { rect, clientWidth, clientHeight } = rig.canvas;
    rig.canvas.dispatch("pointermove", {
        clientX: rect.left + handles.rotate.x / clientWidth * rect.width,
        clientY: rect.top + handles.rotate.y / clientHeight * rect.height,
        buttons: 0,
    });
    assert.match(rig.canvas.style.cursor, /^url\("data:image\/svg\+xml,.*"\) 12 12, grab$/);
    assert.equal(hover({ x: 0, y: 0 }), "move");
    assert.equal(hover({ x: 0.9, y: 0.9 }), "");
});

test("a click without movement records no undo step", () => {
    const rig = createRig();
    rig.controller.load([layer({ id: "a" })]);
    rig.controller.setEditMode(true);
    const point = clientAt(rig, { x: 0, y: 0 });
    rig.canvas.dispatch("pointerdown", point);
    rig.canvas.dispatch("pointermove", point);
    rig.canvas.dispatch("pointerup", point);
    assert.equal(rig.calls.record, 0);
    assert.equal(rig.calls.sync, 0);
});

test("drags stay aligned after the editor view orbits", () => {
    const rig = createRig();
    rig.controller.load([layer({ id: "a", scale: 0.4 })]);
    rig.controller.setEditMode(true);
    rig.viewer.camera.position.set(30, 25, 55);
    rig.viewer.camera.lookAt(0, 10, 0);
    rig.viewer.camera.updateMatrixWorld(true);
    drag(rig, { x: 0, y: 0 }, { x: -0.1, y: 0.15 });
    near(rig.controller.selectedLayer().x, -0.1, 1e-6);
    near(rig.controller.selectedLayer().y, 0.15, 1e-6);
});

test("adding images creates fitted layers in one undo step, capped at the layer limit", async () => {
    const rig = createRig({ width: 1024, height: 512 });
    const files = [{ name: "a.png", type: "image/png", size: 10, width: 400, height: 400 }, { name: "notes.txt", type: "text/plain", size: 1 }];
    const added = await rig.controller.addFiles(files);
    assert.equal(added.length, 1);
    assert.equal(rig.calls.record, 1);
    assert.equal(rig.calls.sync, 1);
    assert.equal(rig.controller.editMode, true);
    assert.equal(rig.controller.selectedId, added[0].id);
    near(added[0].scale, 1, 1e-9);
    const many = Array.from({ length: REFERENCE_LAYER_LIMIT + 2 }, (_, index) => ({ name: `${index}.png`, type: "image/png", size: 1 }));
    await rig.controller.addFiles(many);
    assert.equal(rig.controller.layers.length, REFERENCE_LAYER_LIMIT);
    assert.equal(rig.calls.record, 2);
    assert.ok(rig.calls.messages.some(message => /more reference layer/.test(message)));
    assert.deepEqual(await rig.controller.addFiles(many), []);
});

test("embedded UniCanvas hosts keep reference layers disabled", () => {
    const rig = createRig();
    rig.host.host.embedded = true;
    rig.controller.load([layer()]);
    assert.deepEqual(rig.controller.layers, []);
    assert.equal(rig.controller.serialize(), undefined);
    assert.equal(rig.controller.historySnapshot(), undefined);
});

// --- Editor-only guarantee through the real capture paths -----------------

function renderSpy(viewer) {
    const frames = [];
    viewer.renderer = {
        getSize: target => target.set(400, 300),
        getPixelRatio: () => 1,
        setPixelRatio() {},
        setSize() {},
        render(scene, camera) {
            const drawn = [];
            scene.traverseVisible(object => {
                if (object.isMesh && object.layers.test(camera.layers)) drawn.push(object.name);
            });
            frames.push({ camera, drawn });
        },
    };
    return frames;
}

test("captures never draw reference layers, the editor view does", () => {
    const rig = createRig();
    rig.controller.load([layer({ id: "a" })]);
    rig.controller.syncFrame();
    const frames = renderSpy(rig.viewer);
    rig.viewer.initialized = true;
    rig.viewer.jointMarkers = [];
    rig.viewer.options.onBeforeViewportRender = () => rig.controller.syncFrame();
    rig.viewer._needsRender = true;
    rig.viewer.animate();
    const target = new FakeElement("canvas");
    rig.viewer.capture(512, 512, 1, [0, 0, 0], 0, 0, 0, 0, { targetCanvas: target });
    rig.viewer.capture(512, 512, 1, [0, 0, 0], 0, 0, 0, 0, { targetCanvas: target, viewport: true });
    rig.viewer.renderInteractionOverlay();
    const name = "VNCCSReferenceLayer:a";
    // Editor frame, then each capture followed by the viewport repaint that ends the
    // capture batch, then the interaction overlay.
    assert.deepEqual(frames.map(frame => frame.drawn.includes(name)), [true, false, true, false, true, false]);
    assert.equal(frames[1].camera, rig.viewer.captureCamera);
    assert.equal(frames[3].camera, rig.viewer.camera, "viewport capture uses the editor camera without layers");
    assert.ok(rig.viewer.camera.layers.isEnabled(POSE_STUDIO_EDITOR_ONLY_LAYER), "editor view restored after capture");
});

// --- Pose Studio widget integration ---------------------------------------

function sceneWithLayers() {
    const scene = createScene();
    const { w, viewer } = scene;
    w.hydrateCharacterSceneModels = async () => {};
    viewer.setSkinMode = () => {};
    w.referenceLayers = new PoseReferenceLayerController(w, { document: fakeDocument, editorOnlyLayer: POSE_STUDIO_EDITOR_ONLY_LAYER, loadTexture });
    w.referenceLayers.installHistoryContext(viewer);
    return scene;
}

test("the widget saves layers with the workflow and restores them exactly", () => {
    const scene = sceneWithLayers();
    const { w, node } = scene;
    w.referenceLayers.load([layer({ id: "a", x: 0.1, rotation: 12 }), layer({ id: "b", opacity: 0.25, flipX: true })]);
    w.syncToNode(false);
    const saved = JSON.parse(node.widgets[0].value);
    assert.deepEqual(saved.reference_layers, serializeReferenceLayers(w.referenceLayers.layers));

    const reloaded = sceneWithLayers();
    reloaded.node.widgets[0].value = node.widgets[0].value;
    reloaded.w.loadFromNode();
    const plain = value => JSON.parse(JSON.stringify(value)); // the widget runs in its own VM realm
    assert.deepEqual(plain(reloaded.w.referenceLayers.layers), plain(w.referenceLayers.layers));
});

test("old pose_data loads with no layers and stays byte-identical when re-saved", () => {
    const scene = sceneWithLayers();
    const { w, node } = scene;
    w.referenceLayers.load([layer()]);
    const old = JSON.parse(node.widgets[0].value);
    delete old.reference_layers;
    node.widgets[0].value = JSON.stringify(old);
    w.loadFromNode();
    assert.deepEqual(w.referenceLayers.layers, []);
    w.syncToNode(false);
    assert.equal("reference_layers" in JSON.parse(node.widgets[0].value), false);
});

test("pose Undo and Redo restore layer edits, including a deleted layer", () => {
    const scene = sceneWithLayers();
    const { w, viewer } = scene;
    w.referenceLayers.load([layer({ id: "a" }), layer({ id: "b" })]);
    w.referenceLayers.edit("a", { x: 0.3 });
    w.referenceLayers.removeLayer("b");
    assert.deepEqual(w.referenceLayers.layers.map(item => [item.id, item.x]), [["a", 0.3]]);
    viewer.undo();
    assert.deepEqual(w.referenceLayers.layers.map(item => [item.id, item.x]), [["a", 0.3], ["b", 0]]);
    viewer.undo();
    assert.deepEqual(w.referenceLayers.layers.map(item => [item.id, item.x]), [["a", 0], ["b", 0]]);
    viewer.redo();
    viewer.redo();
    assert.deepEqual(w.referenceLayers.layers.map(item => [item.id, item.x]), [["a", 0.3]]);
    assert.ok(JSON.parse(scene.node.widgets[0].value).reference_layers.every(item => item.id === "a"));
});

test("animation history snapshots carry and restore reference layers", () => {
    const scene = sceneWithLayers();
    const { w } = scene;
    w.referenceLayers.load([layer({ id: "a" })]);
    const before = w.animationHistorySnapshot();
    w.referenceLayers.updateLayer("a", { rotation: 45 });
    assert.notEqual(w.animationHistorySnapshot(), before);
    w.restoreAnimationSnapshot(before);
    assert.equal(w.referenceLayers.selectedLayer().rotation, 0);
});

test("the widget wires layers into history, rendering, persistence and the UniCanvas guard", async () => {
    const source = await fs.readFile(new URL("../web/vnccs_pose_studio.js", import.meta.url), "utf8");
    for (const pattern of [
        /this\.referenceLayers\?\.attachViewer\(this\.viewer, this\.canvasContainer\)/,
        /onBeforeViewportRender: \(\) => this\.referenceLayers\?\.syncFrame\(\)/,
        /this\.referenceLayers\?\.drawOverlay\(\)/,
        /reference_layers: this\.referenceLayers\?\.serialize\(\)/,
        /this\.referenceLayers\?\.load\(data\.reference_layers\)/,
        /this\.hideSectionInUniCanvas\(referenceSection\)/,
        /"background_url", "reference_layers",/,
    ]) assert.match(source, pattern);
});

test("panel list, sliders, numeric fields and resets edit the selected layer with one undo step each", () => {
    const scene = sceneWithLayers();
    const { w, viewer, node } = scene;
    const panel = w.referenceLayers;
    panel.createSection();
    panel.load([layer({ id: "bottom", name: "Bottom" }), layer({ id: "top", name: "Top" })]);
    const rows = panel.ui.list.children;
    assert.deepEqual(rows.map(row => row.dataset.layerId), ["top", "bottom"], "topmost layer first");
    const button = (row, action) => row.children.find(child => child.dataset?.action === action);

    // Slider gesture: live on every input, one history entry, saved at the end.
    const history = viewer.history.length;
    const slider = panel.ui.opacity.range;
    slider.dispatch("pointerdown");
    for (const value of [40, 30, 20]) {
        slider.value = String(value);
        slider.dispatch("input");
        assert.equal(panel.selectedLayer().opacity, value / 100, "visible during the gesture");
        assert.equal(panel.ui.opacity.input.value, String(value), "paired numeric field follows");
    }
    slider.dispatch("pointerup");
    assert.equal(viewer.history.length, history + 1);
    assert.equal(JSON.parse(node.widgets[0].value).reference_layers.find(item => item.id === "top").opacity, 0.2);

    // Numeric position field in output pixels (Y down).
    panel.ui.posX.value = "256";
    panel.ui.posX.dispatch("input");
    panel.ui.posY.value = "-128";
    panel.ui.posY.dispatch("input");
    near(panel.selectedLayer().x, 256 / w.exportParams.view_height);
    near(panel.selectedLayer().y, 128 / w.exportParams.view_height);

    // Viewport-style update keeps the fields in sync the other way.
    panel.updateLayer("top", { rotation: -30, scale: 0.8 });
    assert.equal(panel.ui.rotation.input.value, "-30");
    assert.equal(panel.ui.scale.range.value, "80");

    // Reset is one complete undoable edit.
    const beforeReset = viewer.history.length;
    panel.ui.rotation.resetBtn.click();
    assert.equal(panel.selectedLayer().rotation, 0);
    assert.equal(viewer.history.length, beforeReset + 1);
    viewer.undo();
    assert.equal(panel.selectedLayer().rotation, -30);

    button(panel.ui.list.children[0], "Move down").click();
    assert.deepEqual(panel.layers.map(item => item.id), ["top", "bottom"]);
    button(panel.ui.list.children[1], "Hide").click();
    assert.equal(panel.layers[0].visible, false);
    button(panel.ui.list.children[1], "Show").click();
    assert.equal(panel.layers[0].visible, true, "a hidden layer can be shown again");
    button(panel.ui.list.children[1], "Lock").click();
    assert.equal(panel.layers[0].locked, true);
    button(panel.ui.list.children[1], "Unlock").click();
    assert.equal(panel.layers[0].locked, false, "a locked layer can be unlocked again");

    // Selecting keeps the row elements, so a double click reaches the same name.
    const nameBefore = panel.ui.list.children[0].children[1];
    panel.ui.list.children[0].click();
    assert.equal(panel.ui.list.children[0].children[1], nameBefore);
    assert.ok(panel.ui.list.children[0].className.includes("selected"));

    // Double-click rename: Enter saves as one undo step, Escape and empty names keep the old name.
    const rename = (text, key) => {
        panel.ui.list.children[0].children[1].dispatch("dblclick");
        const input = panel.ui.list.children[0].children[1];
        assert.equal(input.tagName, "INPUT");
        input.value = text;
        input.dispatch("keydown", { key });
        input.dispatch("blur");
    };
    const beforeRename = viewer.history.length;
    rename("  Line art  ", "Enter");
    assert.equal(panel.layers[1].name, "Line art");
    assert.equal(panel.ui.list.children[0].children[1].textContent, "Line art");
    assert.equal(viewer.history.length, beforeRename + 1);
    assert.equal(JSON.parse(node.widgets[0].value).reference_layers[1].name, "Line art");
    rename("Discarded", "Escape");
    rename("   ", "Enter");
    assert.equal(panel.layers[1].name, "Line art");
    assert.equal(viewer.history.length, beforeRename + 1);
    viewer.undo();
    assert.equal(panel.layers[1].name, "Bottom");

    button(panel.ui.list.children[0], "Delete").click();
    assert.deepEqual(panel.layers.map(item => item.id), ["top"]);
    viewer.undo();
    assert.deepEqual(panel.layers.map(item => item.id), ["top", "bottom"]);
});

test("image drops on the viewport add layers; other drops still reach ComfyUI", async () => {
    const rig = createRig();
    const image = { kind: "file", type: "image/png" }, workflow = { kind: "file", type: "application/json" };
    assert.equal(rig.container.dispatch("dragover", { dataTransfer: { items: [image] } }).defaultPrevented, true);
    assert.equal(rig.container.dispatch("dragover", { dataTransfer: { items: [workflow] } }).defaultPrevented, false);
    const json = rig.container.dispatch("drop", { dataTransfer: { files: [{ name: "w.json", type: "application/json", size: 1 }] } });
    assert.equal(json.defaultPrevented, false);
    const drop = rig.container.dispatch("drop", { dataTransfer: { files: [{ name: "a.png", type: "image/png", size: 1 }] } });
    assert.equal(drop.defaultPrevented, true);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(rig.controller.layers.length, 1);
});
