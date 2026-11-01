import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import * as THREE from "../web/vendor/three/three.module.js";
import {
    CROP_GUIDE_MIN_PIXELS,
    POSE_CROP_GUIDE_OUTPUTS,
    buildCropJson,
    centerCropGuide,
    cropGuidePixelRect,
    defaultCropGuide,
    ensurePoseCropGuideOutputs,
    fitCropGuide,
    moveCropGuide,
    normalizeCropGuide,
    poseCropGuideOutputNames,
    resizeCropGuide,
    setCropGuideAspect,
    setCropGuidePixels,
} from "../web/pose_studio/crop_guide.mjs";
import { ensurePoseConditioningOutputs, POSE_CONDITIONING_OUTPUTS } from "../web/pose_studio/conditioning.mjs";
import { createScene, Element } from "./helpers/pose_studio_scene.mjs";
import { createRasterRenderer, topDownOwners } from "./helpers/conditioning_raster.mjs";

const CASES = JSON.parse(fs.readFileSync(new URL("./fixtures/crop_guide_cases.json", import.meta.url), "utf8"));
const rectOf = ([x, y, width, height]) => ({ x, y, width, height });
const pixels = rect => [rect.x, rect.y, rect.width, rect.height];
// Widget objects come from a vm realm; compare their JSON values.
const plain = value => JSON.parse(JSON.stringify(value));
const same = (actual, expected, message) => assert.deepEqual(plain(actual), plain(expected), message);
const enabled = (patch = {}) => normalizeCropGuide({ ...defaultCropGuide(), enabled: true, ...patch });

// --- Coordinate model -------------------------------------------------------

test("pixel rectangles follow the shared floor/ceil contract (fixture shared with Python)", () => {
    for (const item of CASES.pixel_rects) {
        assert.deepEqual(pixels(cropGuidePixelRect(rectOf(item.rect), ...item.size)), item.expected, item.name);
    }
});

test("normalization rejects garbage, clamps inside and loads old data as disabled (shared fixture)", () => {
    for (const item of CASES.normalize) {
        const guide = normalizeCropGuide(item.input);
        for (const [key, value] of Object.entries(item.expected)) assert.deepEqual(guide[key], value, `${item.name}: ${key}`);
    }
    for (const bad of [NaN, Infinity, -Infinity]) {
        for (const key of ["x", "y", "width", "height"]) {
            const guide = normalizeCropGuide({ ...enabled(), [key]: bad });
            assert.equal(guide.enabled, false, `${key}=${bad} disables the guide`);
            assert.deepEqual([guide.x, guide.y, guide.width, guide.height], [0.1, 0.1, 0.8, 0.8]);
        }
    }
    for (const garbage of [undefined, 0, "{}", [], [1, 2, 3, 4], { x: {} }]) {
        assert.equal(normalizeCropGuide(garbage).enabled, false);
    }
    const guide = enabled({ x: 0.3, y: 0.2 });
    assert.deepEqual(normalizeCropGuide(normalizeCropGuide(guide)), normalizeCropGuide(guide), "idempotent");
    assert.equal(Object.keys(normalizeCropGuide({ ...guide, extra: 1 })).includes("extra"), false);
});

test("corners and center map exactly; the whole image and single pixels round trip", () => {
    const [W, H] = [1280, 720];
    assert.deepEqual(cropGuidePixelRect({ x: 0, y: 0, width: 1, height: 1 }, W, H), { x: 0, y: 0, width: W, height: H });
    for (const [x, y] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1], [W / 2, H / 2]]) {
        const rect = { x: x / W, y: y / H, width: 1 / W, height: 1 / H };
        assert.deepEqual(cropGuidePixelRect(rect, W, H), { x, y, width: 1, height: 1 }, `pixel ${x},${y}`);
    }
    // Out-of-range input is clamped to the image and never returns an empty rectangle.
    assert.deepEqual(cropGuidePixelRect({ x: 1.2, y: -3, width: 0.5, height: 9 }, W, H), { x: W - 1, y: 0, width: 1, height: H });
    assert.throws(() => cropGuidePixelRect({ x: 0, y: 0, width: 1, height: 1 }, 0, 10), /positive integers/);
});

test("numeric pixel entry round trips through JSON save/reload without drift", () => {
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const [W, H] of [[1024, 1024], [1280, 720], [833, 1217], [64, 4096]]) {
        for (let i = 0; i < 200; i++) {
            const w = 8 + Math.floor(random() * (W - 8)), h = 8 + Math.floor(random() * (H - 8));
            const x = Math.floor(random() * (W - w + 1)), y = Math.floor(random() * (H - h + 1));
            let guide = enabled();
            guide = setCropGuidePixels(guide, "width", w, W, H);
            guide = setCropGuidePixels(guide, "height", h, W, H);
            guide = setCropGuidePixels(guide, "x", x, W, H);
            guide = setCropGuidePixels(guide, "y", y, W, H);
            const expected = { x, y, width: w, height: h };
            assert.deepEqual(cropGuidePixelRect(guide, W, H), expected, `${W}x${H} #${i}`);
            let reloaded = guide;
            for (let cycle = 0; cycle < 5; cycle++) reloaded = normalizeCropGuide(JSON.parse(JSON.stringify(reloaded)));
            assert.deepEqual(reloaded, guide, "save/reload keeps the exact normalized values");
            assert.deepEqual(buildCropJson(reloaded, W, H, 3).pixel_rect, expected, "crop_json matches the fields");
        }
    }
});

test("resolution changes keep the normalized rectangle; scaled outputs scale the crop exactly", () => {
    let guide = setCropGuidePixels(setCropGuidePixels(enabled(), "width", 300, 1000, 750), "height", 200, 1000, 750);
    guide = setCropGuidePixels(setCropGuidePixels(guide, "x", 123, 1000, 750), "y", 77, 1000, 750);
    const stored = JSON.stringify(guide);
    assert.deepEqual(cropGuidePixelRect(guide, 1000, 750), { x: 123, y: 77, width: 300, height: 200 });
    assert.deepEqual(cropGuidePixelRect(guide, 2000, 1500), { x: 246, y: 154, width: 600, height: 400 }, "2x");
    assert.deepEqual(cropGuidePixelRect(guide, 500, 375), { x: 61, y: 38, width: 151, height: 101 },
        "0.5x floors the start and ceils the end (61.5 -> 61, 211.5 -> 212)");
    assert.equal(JSON.stringify(guide), stored, "pixel conversion never writes back");
});

test("move and resize stay inside the image and keep the minimum size", () => {
    const [W, H] = [640, 480];
    const start = setCropGuidePixels(setCropGuidePixels(enabled(), "width", 200, W, H), "height", 100, W, H);
    assert.deepEqual(cropGuidePixelRect(moveCropGuide(start, 5, 5, W, H), W, H), { x: W - 200, y: H - 100, width: 200, height: 100 });
    assert.deepEqual(cropGuidePixelRect(moveCropGuide(start, -5, -5, W, H), W, H), { x: 0, y: 0, width: 200, height: 100 });
    const tiny = resizeCropGuide(start, "se", -1, -1, W, H);
    const rect = cropGuidePixelRect(tiny, W, H);
    assert.deepEqual([rect.width, rect.height], [CROP_GUIDE_MIN_PIXELS, CROP_GUIDE_MIN_PIXELS]);
    const big = cropGuidePixelRect(resizeCropGuide(start, "nw", -2, -2, W, H), W, H);
    assert.deepEqual(big, { x: 0, y: 0, width: cropGuidePixelRect(start, W, H).x + 200, height: cropGuidePixelRect(start, W, H).y + 100 },
        "the opposite corner stays while the dragged one is clamped to the image");
    for (const handle of ["n", "e", "s", "w", "ne", "sw"]) {
        const r = cropGuidePixelRect(resizeCropGuide(start, handle, 3, -3, W, H), W, H);
        assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= W && r.y + r.height <= H, handle);
        assert.ok(r.width >= CROP_GUIDE_MIN_PIXELS && r.height >= CROP_GUIDE_MIN_PIXELS, handle);
    }
    assert.throws(() => resizeCropGuide(start, "middle", 0, 0, W, H), /handle/);
});

test("aspect presets constrain the final PIXEL ratio on non-square images", () => {
    const [W, H] = [1280, 720];
    for (const [key, ratio] of [["1:1", 1], ["4:3", 4 / 3], ["3:4", 3 / 4], ["16:9", 16 / 9], ["9:16", 9 / 16]]) {
        let guide = setCropGuideAspect(enabled(), key, W, H);
        assert.equal(guide.aspect_ratio_locked, true);
        const check = (label) => {
            const r = cropGuidePixelRect(guide, W, H);
            assert.ok(Math.abs(r.width - r.height * ratio) <= Math.max(1, ratio) + 1e-9, `${key} ${label}: ${r.width}x${r.height}`);
            assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= W && r.y + r.height <= H, `${key} ${label} inside`);
        };
        check("preset");
        for (const [handle, u, v] of [["se", 0.95, 0.4], ["nw", 0.05, 0.1], ["e", 0.9, 0.5], ["n", 0.5, 0.02], ["sw", 0, 1]]) {
            guide = resizeCropGuide(guide, handle, u, v, W, H);
            check(handle);
        }
        guide = setCropGuidePixels(guide, "width", 500, W, H);
        check("numeric width");
        guide = fitCropGuide(guide, W, H);
        check("fit");
        const fitted = cropGuidePixelRect(guide, W, H);
        assert.ok(fitted.width === W || fitted.height === H, `${key} fit touches the frame`);
        assert.ok(Math.abs(fitted.x * 2 + fitted.width - W) <= 1 && Math.abs(fitted.y * 2 + fitted.height - H) <= 1, `${key} fit is centered`);
    }
    const free = fitCropGuide(enabled(), W, H);
    assert.deepEqual(cropGuidePixelRect(free, W, H), { x: 0, y: 0, width: W, height: H }, "Free fits the whole frame");
    const custom = setCropGuideAspect(enabled(), "custom", W, H, [2, 3]);
    const customRect = cropGuidePixelRect(custom, W, H);
    assert.ok(Math.abs(customRect.width / customRect.height - 2 / 3) < 0.01);
    assert.deepEqual(setCropGuideAspect(custom, "free", W, H).aspect_ratio_locked, false, "Free starts unlocked");
});

test("Free with Lock keeps the current shape; Center keeps the size", () => {
    const [W, H] = [1000, 600];
    let guide = { ...setCropGuidePixels(setCropGuidePixels(enabled(), "width", 300, W, H), "height", 150, W, H), aspect_ratio_locked: true };
    guide = resizeCropGuide(guide, "se", 0.9, 0.95, W, H);
    const r = cropGuidePixelRect(guide, W, H);
    assert.ok(Math.abs(r.width / r.height - 2) < 0.02, `locked free keeps 2:1, got ${r.width}x${r.height}`);
    const centered = cropGuidePixelRect(centerCropGuide(guide, W, H), W, H);
    assert.deepEqual([centered.width, centered.height], [r.width, r.height]);
    assert.ok(Math.abs(centered.x * 2 + centered.width - W) <= 1 && Math.abs(centered.y * 2 + centered.height - H) <= 1);
});

test("crop_json carries the source size, the normalized and the pixel rectangle", () => {
    const guide = setCropGuideAspect(enabled(), "16:9", 1920, 1080);
    const record = buildCropJson(guide, 1920, 1080, 2);
    assert.equal(record.schema_version, 1);
    assert.equal(record.coordinate_system, "top_left_normalized");
    assert.deepEqual(record.source, { width: 1920, height: 1080 });
    assert.deepEqual(record.rect, { x: guide.x, y: guide.y, width: guide.width, height: guide.height });
    assert.deepEqual(record.pixel_rect, cropGuidePixelRect(guide, 1920, 1080));
    assert.equal(record.aspect_ratio, "16:9");
    assert.equal(record.aspect_ratio_value, 16 / 9);
    assert.equal(record.aspect_ratio_locked, true);
    assert.equal(record.pose_index, 2);
    assert.equal(record.enabled, true);
});

test("legacy 2- and 8-output workflows gain the crop outputs at slots 8..10 without moving links", () => {
    const makeNode = names => ({
        outputs: names.map((name, index) => ({ name, links: index < 2 ? [100 + index] : [] })),
        addOutput(name, type) { this.outputs.push({ name, type, links: [] }); },
    });
    const legacy = makeNode(["images", "lighting_prompt"]);
    ensurePoseConditioningOutputs(legacy);
    ensurePoseCropGuideOutputs(legacy);
    const conditioned = makeNode(["images", "lighting_prompt", ...POSE_CONDITIONING_OUTPUTS.map(output => output.name)]);
    ensurePoseCropGuideOutputs(conditioned);
    for (const node of [legacy, conditioned]) {
        assert.deepEqual(node.outputs.map(output => output.name), [
            "images", "lighting_prompt", "depth", "normal", "outline", "silhouette", "mask", "character_id",
            "crop_json", "crop_image", "crop_preview",
        ]);
        assert.deepEqual(node.outputs[0].links, [100]);
        assert.deepEqual(node.outputs[1].links, [101]);
        assert.deepEqual(node.outputs.slice(8).map(output => output.type), POSE_CROP_GUIDE_OUTPUTS.map(output => output.type));
        ensurePoseCropGuideOutputs(node);
        assert.equal(node.outputs.length, 11, "idempotent");
    }
    conditioned.outputs[10].links = [5];
    assert.deepEqual(poseCropGuideOutputNames(conditioned), ["crop_preview"]);
});

// --- Editor overlay -------------------------------------------------------------

const VIEW_W = 320, VIEW_H = 240;

function cropScene({ width = 1280, height = 720 } = {}) {
    const scene = createScene({ skinned: true });
    const { w, viewer } = scene;
    const frameGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-1, 1, 0), new THREE.Vector3(1, 1, 0), new THREE.Vector3(1, -1, 0),
        new THREE.Vector3(-1, -1, 0), new THREE.Vector3(-1, 1, 0),
    ]);
    viewer.captureFrame = new THREE.Line(frameGeometry, new THREE.LineBasicMaterial());
    viewer.scene.add(viewer.captureFrame);
    const canvas = viewer.canvas;
    canvas.clientWidth = VIEW_W; canvas.clientHeight = VIEW_H;
    // ComfyUI scales DOM widgets with CSS transforms: the canvas box is twice its CSS size here.
    canvas.getBoundingClientRect = () => ({ left: 30, top: 50, width: VIEW_W * 2, height: VIEW_H * 2 });
    viewer.camera.aspect = VIEW_W / VIEW_H;
    viewer.camera.updateProjectionMatrix();
    w.exportParams.view_width = width;
    w.exportParams.view_height = height;
    w.applyCameraToViewer(true);
    scene.context.URLSearchParams = URLSearchParams;
    scene.context.fetch = async () => ({ ok: true, json: async () => ({}) });
    w.showMessage = () => {};
    const container = new Element();
    const controller = w.ensureCropGuideController();
    scene.panel = new Element();
    controller.createControls(scene.panel);
    controller.attach(container, canvas);
    w.syncToNode(false);
    Object.assign(scene, { container, controller, canvas });
    return scene;
}

function pointer(scene, type, point, extra = {}) {
    const bounds = scene.canvas.getBoundingClientRect();
    const event = {
        type, target: scene.canvas, button: 0, pointerId: 9,
        clientX: bounds.left + point.x / VIEW_W * bounds.width,
        clientY: bounds.top + point.y / VIEW_H * bounds.height,
        stopped: false, defaultPrevented: false,
        stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; },
        preventDefault() { this.defaultPrevented = true; },
        ...extra,
    };
    scene.container.dispatchEvent(event);
    return event;
}

function frameCornersOnScreen(scene) {
    const { viewer } = scene;
    viewer.captureFrame.updateMatrixWorld(true);
    viewer.camera.updateMatrixWorld(true);
    return [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([x, y]) => {
        const p = new THREE.Vector3(x, y, 0).applyMatrix4(viewer.captureFrame.matrixWorld).project(viewer.camera);
        return { x: (p.x + 1) / 2 * VIEW_W, y: (1 - p.y) / 2 * VIEW_H };
    });
}

function assertNear(actual, expected, tolerance, message) {
    assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
}

function assertGuideOnFrame(scene, message) {
    const { controller } = scene;
    const mapping = controller.frameMapping();
    const corners = frameCornersOnScreen(scene);
    [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], index) => {
        const screen = controller.imageToScreen(mapping, u, v);
        assertNear(screen.x, corners[index].x, 1e-6, `${message} corner ${index} x`);
        assertNear(screen.y, corners[index].y, 1e-6, `${message} corner ${index} y`);
        const back = controller.screenToImage(mapping, screen.x, screen.y);
        assertNear(back.u, u, 1e-9, `${message} inverse u`);
        assertNear(back.v, v, 1e-9, `${message} inverse v`);
    });
}

test("the overlay sits on the orange frame after FOV, Distance, Yaw/Pitch, Zoom, Align, resolution changes and orbiting", () => {
    const scene = cropScene();
    const { w, viewer } = scene;
    w.setCropGuide(0, enabled({ x: 0.2, y: 0.3, width: 0.4, height: 0.5 }));
    const guide = { ...w.getCropGuide() };
    assertGuideOnFrame(scene, "default lens");
    const steps = [
        ["FOV", () => { w.exportParams.cam_fov_deg = 60; w.persistActivePoseCameraParams(); w.applyCameraToViewer(true); }],
        ["Distance", () => { w.exportParams.cam_distance = 120; w.persistActivePoseCameraParams(); w.applyCameraToViewer(true); }],
        ["Yaw/Pitch", () => { w.exportParams.cam_yaw_deg = 35; w.exportParams.cam_pitch_deg = -20; w.applyCameraToViewer(true); }],
        ["Zoom", () => { w.exportParams.cam_zoom = 2.5; w.persistActivePoseCameraParams(); w.applyCameraToViewer(true); }],
        ["resolution", () => { w.exportParams.view_width = 768; w.exportParams.view_height = 1344; w.applyCameraToViewer(true); }],
        ["orbit", () => { viewer.camera.position.set(40, 30, 60); viewer.orbit.target.set(0, 8, 0); viewer.orbit.update(); }],
        ["Align Camera to View", () => { viewer.camera.position.set(-25, 18, 40); viewer.orbit.target.set(2, 9, 0); viewer.orbit.update(); w.alignCaptureCameraToView(); }],
        ["orbit after align", () => { viewer.camera.position.set(10, 40, 30); viewer.orbit.target.set(0, 5, 0); viewer.orbit.update(); }],
    ];
    for (const [label, step] of steps) {
        step();
        assertGuideOnFrame(scene, label);
        same(w.getCropGuide(), guide, `${label} keeps the normalized rectangle`);
    }
});

test("at the capture view the guide covers exactly the pixels it crops (character vertices)", () => {
    const scene = cropScene({ width: 900, height: 600 });
    const { w, viewer, controller } = scene;
    w.setCropGuide(0, enabled({ x: 0.35, y: 0.1, width: 0.3, height: 0.45 }));
    w.applyCameraToViewer(true);
    const mapping = controller.frameMapping();
    const geometry = controller.screenGeometry(mapping);
    const rect = cropGuidePixelRect(w.getCropGuide(), 900, 600);
    const mesh = viewer.skinnedMesh, positions = mesh.geometry.attributes.position;
    mesh.updateMatrixWorld(true);
    viewer.skeleton?.update();
    let inside = 0, outside = 0;
    const point = new THREE.Vector3();
    for (let i = 0; i < positions.count; i += 37) {
        point.fromBufferAttribute(positions, i);
        mesh.applyBoneTransform?.(i, point);
        point.applyMatrix4(mesh.matrixWorld);
        const image = point.clone().project(viewer.captureCamera);
        const px = (image.x + 1) / 2 * 900, py = (1 - image.y) / 2 * 600;
        const screen = point.clone().project(viewer.camera);
        const sx = (screen.x + 1) / 2 * VIEW_W, sy = (1 - screen.y) / 2 * VIEW_H;
        // Skip points within half a pixel of the crop edge.
        const margin = 0.6;
        const inCrop = px > rect.x + margin && px < rect.x + rect.width - margin && py > rect.y + margin && py < rect.y + rect.height - margin;
        const outCrop = px < rect.x - margin || px > rect.x + rect.width + margin || py < rect.y - margin || py > rect.y + rect.height + margin;
        if (!inCrop && !outCrop) continue;
        const hit = controller.hitTest(sx, sy, { ...geometry, handles: {} }) === "move";
        assert.equal(hit, inCrop, `vertex ${i} at image ${px.toFixed(1)},${py.toFixed(1)}`);
        if (inCrop) inside++; else outside++;
    }
    assert.ok(inside > 20 && outside > 20, `both sides are sampled (${inside} in, ${outside} out)`);
});

test("dragging updates the rectangle and the fields on every move and records one undo step", () => {
    const scene = cropScene();
    const { w, viewer, controller } = scene;
    w.setCropGuide(0, enabled({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }));
    controller.setEditing(true);
    const before = { ...w.getCropGuide() };
    const camera = viewer.captureCamera.matrixWorld.toArray();
    const cameraParams = JSON.stringify(w.currentCameraParams());
    const pose = JSON.stringify(viewer.getPose());
    const historyBefore = viewer.history.length;
    const writes = [];
    const widget = w.getNodeWidget("pose_data");
    const original = widget.callback;
    widget.callback = value => { writes.push(value); original?.(value); };
    const start = controller.geometry.handles.se;
    const down = pointer(scene, "pointerdown", start);
    assert.equal(down.stopped, true, "the handle drag never reaches orbit or bone picking");
    const seen = [];
    for (let step = 1; step <= 4; step++) {
        const draws = controller.stats.draws;
        const move = pointer(scene, "pointermove", { x: start.x + step * 6, y: start.y + step * 4 });
        assert.equal(move.stopped, true);
        const rect = cropGuidePixelRect(w.getCropGuide(), 1280, 720);
        assert.ok(controller.stats.draws > draws, "the overlay redraws during the gesture");
        assert.equal(scene.controller.fields.numbers.width.value, String(rect.width), "W field follows in realtime");
        assert.equal(scene.controller.fields.numbers.height.value, String(rect.height), "H field follows in realtime");
        seen.push(rect.width);
    }
    assert.ok(seen.every((value, index) => index === 0 || value > seen[index - 1]), `width grows every frame: ${seen}`);
    assert.equal(viewer.history.length, historyBefore + 1, "one undo step per gesture");
    assert.equal(writes.length, 0, "no workflow write per move");
    const last = { ...w.getCropGuide() };
    pointer(scene, "pointerup", { x: start.x + 24, y: start.y + 16 });
    same(w.getCropGuide(), last, "release keeps the last visible rectangle");
    assert.equal(viewer.history.length, historyBefore + 1);
    same(JSON.parse(widget.value).crop_guides[0], last, "the gesture end persists");
    same(viewer.captureCamera.matrixWorld.toArray(), camera, "capture camera untouched");
    assert.equal(JSON.stringify(w.currentCameraParams()), cameraParams, "camera parameters untouched");
    assert.equal(JSON.stringify(viewer.getPose()), pose, "pose untouched");
    viewer.undo();
    same(w.getCropGuide(), before, "undo restores the rectangle before the drag");
    viewer.redo();
    same(w.getCropGuide(), last, "redo restores the dragged rectangle");
    widget.callback = original;
});

test("moving by the body follows the pointer in image space and stays inside", () => {
    const scene = cropScene();
    const { w, controller } = scene;
    w.setCropGuide(0, enabled({ x: 0.25, y: 0.25, width: 0.25, height: 0.25 }));
    controller.setEditing(true);
    const center = controller.geometry.center;
    pointer(scene, "pointerdown", center);
    const mapping = controller.frameMapping();
    const target = { x: center.x + 30, y: center.y - 10 };
    pointer(scene, "pointermove", target);
    const uv0 = controller.screenToImage(mapping, center.x, center.y), uv1 = controller.screenToImage(mapping, target.x, target.y);
    const rect = cropGuidePixelRect(w.getCropGuide(), 1280, 720);
    assertNear(rect.x, Math.round(0.25 * 1280 + (uv1.u - uv0.u) * 1280), 0, "x follows the pointer");
    assertNear(rect.y, Math.round(0.25 * 720 + (uv1.v - uv0.v) * 720), 0, "y follows the pointer");
    same([rect.width, rect.height], [320, 180]);
    pointer(scene, "pointermove", { x: -500, y: -500 });
    const clamped = cropGuidePixelRect(w.getCropGuide(), 1280, 720);
    assert.ok(clamped.x >= 0 && clamped.y >= 0);
    pointer(scene, "pointerup", target);
});

test("orbit, pan and bones keep working: no interception outside edit mode or outside the rectangle", () => {
    const scene = cropScene();
    const { w, controller } = scene;
    w.setCropGuide(0, enabled({ x: 0.4, y: 0.4, width: 0.2, height: 0.2 }));
    controller.draw();
    const center = controller.geometry.center;
    assert.equal(pointer(scene, "pointerdown", center).stopped, false, "not editing: the viewport gets the event");
    pointer(scene, "pointerup", center);
    controller.setEditing(true);
    const corner = controller.geometry.frame[0];
    const outside = { x: corner.x + 2, y: corner.y + 2 };
    assert.equal(pointer(scene, "pointerdown", outside).stopped, false, "outside the rectangle orbit/bones still work");
    pointer(scene, "pointerup", outside);
    assert.equal(pointer(scene, "pointerdown", center, { button: 2 }).stopped, false, "other buttons pass through");
    const banner = new Element();
    assert.equal(pointer(scene, "pointerdown", center, { target: banner }).stopped, false, "other overlays keep their events");
    w.isAnimationMode = () => true;
    controller.refresh();
    assert.equal(controller.geometry, null, "the guide is hidden in Animation mode");
    assert.equal(pointer(scene, "pointerdown", center).stopped, false);
});

test("numeric fields update the rectangle on input and record one undo step per edit", () => {
    const scene = cropScene();
    const { w, viewer, controller } = scene;
    w.setCropGuide(0, enabled());
    const input = controller.fields.numbers.width;
    const historyBefore = viewer.history.length;
    input.emit("pointerdown");
    for (const value of [500, 640, 700]) {
        input.value = String(value);
        input.emit("input");
        assert.equal(cropGuidePixelRect(w.getCropGuide(), 1280, 720).width, value, `width ${value} applies while typing`);
    }
    input.emit("change");
    input.emit("pointerup");
    assert.equal(viewer.history.length, historyBefore + 1);
    viewer.undo();
    assert.equal(cropGuidePixelRect(w.getCropGuide(), 1280, 720).width, 1024);
});

test("each pose tab keeps its own guide; new tabs start disabled; deleting a tab removes its guide", () => {
    const scene = cropScene();
    const { w } = scene;
    w.setCropGuide(0, enabled({ x: 0, y: 0, width: 0.5, height: 0.5 }));
    w.addTab();
    assert.equal(w.activeTab, 1);
    assert.equal(w.getCropGuide().enabled, false, "a new tab starts with a disabled guide");
    w.setCropGuide(1, enabled({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 }));
    w.addTab();
    w.setCropGuide(2, enabled({ x: 0.2, y: 0.2, width: 0.1, height: 0.1 }));
    w.switchTab(0);
    assert.equal(w.getCropGuide().x, 0);
    assert.equal(scene.controller.fields.numbers.x.value, "0", "fields follow the tab");
    w.switchTab(1);
    assert.equal(scene.controller.fields.numbers.x.value, "640");
    w.deleteTab(1);
    same(w.cropGuides.map(guide => guide.x), [0, 0.2]);
    const saved = JSON.parse(scene.node.widgets[0].value);
    same(saved.crop_guides.map(guide => guide.x), [0, 0.2]);
});

test("workflow save/reload reproduces every guide; workflows without guides load disabled", async () => {
    const scene = cropScene();
    const { w, node } = scene;
    w.setCropGuide(0, setCropGuideAspect(enabled({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }), "4:3", 1280, 720));
    w.addTab();
    w.setCropGuide(1, enabled({ x: 0.6, y: 0.1, width: 0.25, height: 0.5 }));
    const saved = JSON.parse(node.widgets[0].value);
    const expected = w.cropGuides.map(guide => ({ ...guide }));
    same(saved.crop_guides, expected);
    assert.equal(JSON.stringify(saved).includes("data:image"), false, "no image data in the workflow");

    const other = cropScene();
    other.w.hydrateCharacterSceneModels = async () => {};
    other.node.widgets[0].value = JSON.stringify(saved);
    await other.w.loadFromNode();
    same(other.w.cropGuides, expected);
    other.w.syncToNode(false);
    same(JSON.parse(other.node.widgets[0].value).crop_guides, expected, "reload does not drift");

    const legacy = cropScene();
    legacy.w.hydrateCharacterSceneModels = async () => {};
    const old = { ...saved };
    delete old.crop_guides;
    legacy.node.widgets[0].value = JSON.stringify(old);
    await legacy.w.loadFromNode();
    same(legacy.w.cropGuides.map(guide => guide.enabled), [false, false]);
    const broken = cropScene();
    broken.w.hydrateCharacterSceneModels = async () => {};
    broken.node.widgets[0].value = JSON.stringify({ ...saved, crop_guides: [{ enabled: true, x: NaN }, "junk"] });
    await broken.w.loadFromNode();
    same(broken.w.cropGuides.map(guide => guide.enabled), [false, false]);
});

test("Pose Library saves the tab's guide and loading a pose applies it (old assets load disabled)", async () => {
    const scene = cropScene();
    const { w } = scene;
    const guide = setCropGuideAspect(enabled({ x: 0.15, y: 0.05, width: 0.5, height: 0.6 }), "3:4", 1280, 720);
    w.setCropGuide(0, guide);
    let record = null;
    w.saveLibraryPoseRecord = async payload => { record = payload; return { id: "local_user_poses/Uncategorized/test" }; };
    w.refreshLibrary = () => {};
    w.compressLibraryImage = async value => value;
    w.viewer.capture = () => "data:image/png;base64,AAAA";
    assert.equal(await w.saveToLibrary("test", false), true);
    same(record.pose.crop_guide, w.getCropGuide());
    assert.equal(JSON.stringify(record.pose).includes("crop_guides"), false, "a static pose stores one guide");

    const load = async (pose) => {
        scene.context.fetch = async () => ({ ok: true, json: async () => ({ pose, asset_type: "pose" }) });
        await w.loadFromLibrary("test");
    };
    w.setCropGuide(0, defaultCropGuide());
    await load(record.pose);
    same(w.getCropGuide(), normalizeCropGuide(record.pose.crop_guide), "the saved guide is restored");
    w.viewer.undo();
    assert.equal(w.getCropGuide().enabled, false, "library load is one undo step");
    w.setCropGuide(0, guide);
    const old = { ...record.pose };
    delete old.crop_guide;
    await load(old);
    assert.equal(w.getCropGuide().enabled, false, "an asset saved before the crop guide loads disabled");
});

test("execution sends one guide per captured image; Debug Mode uses the library pose's guide", () => {
    const scene = cropScene();
    const { w } = scene;
    w.setCropGuide(0, enabled({ x: 0.1, y: 0.1, width: 0.3, height: 0.3 }));
    w.addTab();
    w.setCropGuide(1, enabled({ x: 0.5, y: 0.2, width: 0.2, height: 0.6 }));
    w.viewer.capture = () => "data:image/png;base64,AAAA";
    w.syncToNode(true, { executionCapture: true, skipCaptureUpload: true });
    same(w._executionCropGuideSnapshot, w.cropGuides.map((guide, index) => ({ ...guide, pose_index: index })));
    const asset = { type: "scene_pose", crop_guide: enabled({ x: 0.3, y: 0.3, width: 0.4, height: 0.4 }) };
    same(w.cropGuidesForCapture(asset), [{ ...normalizeCropGuide(asset.crop_guide), pose_index: null }]);
    same(w.cropGuidesForCapture({ type: "scene_pose" })[0].enabled, false);
    scene.node.outputs = [
        { name: "images", links: [1] }, { name: "lighting_prompt", links: [] },
        { name: "crop_json", links: [2] }, { name: "crop_image", links: [] }, { name: "crop_preview", links: [3] },
    ];
    w.syncToNode(false);
    same(JSON.parse(scene.node.widgets[0].value).export.crop_outputs, ["crop_json", "crop_preview"]);
    w.isAnimationMode = () => true;
    assert.equal(w.cropGuidesForCapture(), null, "Animation mode sends no guides");
});

test("the guide never reaches the 3D scene or the RGB capture", () => {
    const capture = (guideOn) => {
        const scene = cropScene({ width: 96, height: 64 });
        const { w, viewer, controller } = scene;
        const renderer = createRasterRenderer({ width: 96, height: 64, rgbObjectId: mesh => (mesh === viewer.skinnedMesh ? 1 : 2) });
        viewer.renderer = renderer;
        viewer.canvas.toDataURL = () => `rgb:${renderer.rgbFrames.length - 1}`;
        const children = viewer.scene.children.length;
        if (guideOn) {
            w.setCropGuide(0, enabled({ x: 0.3, y: 0.2, width: 0.4, height: 0.5 }));
            controller.setEditing(true);
            controller.draw();
        }
        assert.equal(viewer.scene.children.length, children, "no 3D object is added for the guide");
        assert.notEqual(controller.overlay, viewer.canvas);
        w.syncToNode(true, { executionCapture: true, skipCaptureUpload: true });
        return topDownOwners(renderer.rgbFrames[Number(w.poseCaptures[0].split(":")[1])]);
    };
    same(capture(true), capture(false), "RGB capture is identical with the guide shown and edited");
});
