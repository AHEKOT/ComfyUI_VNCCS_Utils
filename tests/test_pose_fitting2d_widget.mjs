// 2D Pose Fitting in the real Pose Studio widget: marker drags through the viewport
// container, realtime updates before release, undo/redo, persistence and library.
import assert from "node:assert/strict";
import test from "node:test";
import { createScene, Element } from "./helpers/pose_studio_scene.mjs";
import { PoseFitting2DController, POSE_FITTING_FRAME_BUDGET } from "../web/pose_studio/pose_fitting2d_ui.mjs";
import * as F from "../web/pose_studio/pose_fitting2d.mjs";
import { createPoseStudioCharacter } from "../web/pose_studio/characters.mjs";

const VIEW = 700;

function fittingScene() {
    const scene = createScene({ skinned: true });
    const { w, viewer, document, THREE } = scene;
    w.hydrateCharacterSceneModels = async () => {};
    w.setInterfaceMode = () => {};
    const container = new Element("div");
    const canvas = viewer.canvas;
    canvas.clientWidth = canvas.clientHeight = VIEW;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: VIEW, height: VIEW });
    container.appendChild(canvas);
    viewer.camera.aspect = 1;
    viewer.camera.updateProjectionMatrix();
    const queue = [];
    const controller = new PoseFitting2DController(w, {
        document,
        requestAnimationFrame: callback => { queue.push(callback); return queue.length; },
        cancelAnimationFrame: () => {},
    });
    controller.buildSection(new Element("div"));
    controller.attachViewport(container, canvas);
    w.poseFitting2D = controller;
    const runFrames = (limit = 20) => {
        let count = 0;
        while (queue.length && count < limit) { queue.shift()(); count++; }
        return count;
    };
    const handWorld = () => viewer.bones.hand_l.getWorldPosition(new THREE.Vector3());
    const projected = id => {
        const model = controller.buildModel();
        return F.projectFittingJoints(model, controller.projector())[id];
    };
    const pointer = (type, x, y, extra = {}) => {
        const event = { type, clientX: x, clientY: y, button: 0, pointerId: 7, stopped: false, ...extra };
        event.stopPropagation = () => { event.stopped = true; };
        event.preventDefault = () => {};
        container.dispatchEvent(event);
        return event;
    };
    return { ...scene, container, controller, runFrames, handWorld, projected, pointer, queue };
}

test("dragging a marker moves the mannequin on every frame before release and records one undo step", () => {
    const s = fittingScene();
    const { controller, viewer, pointer, runFrames, handWorld, projected, node } = s;
    controller.setActive(true);
    assert.equal(controller.active, true);
    const marker = controller.state.markers.l_wrist;
    const original = { u: marker.u, v: marker.v };
    const startHand = handWorld();
    const start = controller.frameToOverlay(marker.u, marker.v);
    const historyBefore = viewer.history.length;
    const down = pointer("pointerdown", start.x, start.y);
    assert.equal(down.stopped, true, "the marker owns the pointer; bone selection and orbit do not see it");
    assert.equal(controller.drag.id, "l_wrist");
    let previous = handWorld();
    const frame = controller.frameSize();
    for (let step = 1; step <= 3; step++) {
        const move = pointer("pointermove", start.x - 4 * step, start.y - 3 * step);
        assert.equal(move.stopped, true);
        assert.ok(runFrames() >= 1, "a solve frame is scheduled from pointermove");
        const now = handWorld();
        assert.ok(now.distanceTo(previous) > 1e-4, `step ${step}: the arm moved before release`);
        previous = now;
        const joint = projected("l_wrist");
        const target = controller.state.markers.l_wrist;
        assert.ok(Math.hypot(joint.x - target.u * frame.width, joint.y - target.v * frame.height) < 2, `step ${step}: wrist follows the marker`);
        assert.equal(viewer.history.length, historyBefore + 1, "one undo entry for the whole gesture");
    }
    const releasedHand = handWorld();
    pointer("pointerup", start.x - 12, start.y - 9);
    assert.equal(controller.drag, null);
    assert.ok(handWorld().distanceTo(releasedHand) < 0.05, "release refines without a visible jump");
    assert.equal(viewer.history.length, historyBefore + 1);
    const saved = JSON.parse(node.widgets[0].value);
    const savedPose = saved.characters[0].poses[0];
    assert.ok(savedPose.fitting2d, "constraints are synchronized to the workflow");
    assert.ok(Math.abs(savedPose.fitting2d.markers.l_wrist.u - controller.state.markers.l_wrist.u) < 1e-12);

    viewer.undo();
    assert.ok(handWorld().distanceTo(startHand) < 1e-9, "undo restores the pose");
    assert.ok(Math.abs(viewer.fitting2d.markers.l_wrist.u - original.u) < 1e-12, "undo restores the marker");
    viewer.redo();
    assert.ok(handWorld().distanceTo(releasedHand) < 0.05);
    assert.ok(Math.abs(viewer.fitting2d.markers.l_wrist.u - original.u) > 1e-4);
});

test("clicks away from markers, inactive mode and other buttons are left to the viewer", () => {
    const s = fittingScene();
    const { controller, pointer } = s;
    const marker = () => controller.state.markers.r_elbow;
    let event = pointer("pointerdown", 5, 5);
    assert.equal(event.stopped, false, "inactive mode never intercepts");
    controller.setActive(true);
    event = pointer("pointerdown", 5, 5);
    assert.equal(event.stopped, false, "empty space keeps bone selection / orbit");
    assert.equal(controller.drag, null);
    const position = controller.frameToOverlay(marker().u, marker().v);
    event = pointer("pointerdown", position.x, position.y, { button: 2 });
    assert.equal(event.stopped, false, "right button keeps orbiting");
    controller.updateSettings({ showMarkers: false });
    event = pointer("pointerdown", position.x, position.y);
    assert.equal(event.stopped, false, "hidden markers are not draggable");
    // A click without movement selects the marker without changing the pose or history.
    controller.updateSettings({ showMarkers: true });
    const history = s.viewer.history.length;
    pointer("pointerdown", position.x, position.y);
    pointer("pointerup", position.x, position.y);
    assert.equal(controller.selectedId, "r_elbow");
    assert.equal(s.viewer.history.length, history);
});

test("overlay markers stay on the capture frame when the editor camera orbits", () => {
    const s = fittingScene();
    const { controller, viewer, THREE } = s;
    // Same center of projection and lens: overlay pixels equal frame pixels.
    viewer.camera.position.copy(viewer.captureCamera.position);
    viewer.camera.quaternion.copy(viewer.captureCamera.quaternion);
    viewer.camera.fov = viewer.captureCamera.fov;
    viewer.camera.zoom = viewer.captureCamera.zoom;
    viewer.camera.updateProjectionMatrix();
    viewer.camera.updateMatrixWorld(true);
    for (const [u, v] of [[0, 0], [1, 1], [0.25, 0.8], [0.5, 0.5]]) {
        const overlay = controller.frameToOverlay(u, v);
        assert.ok(Math.abs(overlay.x - u * VIEW) < 1e-6 && Math.abs(overlay.y - v * VIEW) < 1e-6);
    }
    // Orbit: frame corners stay on the capture frame plane and pointer mapping round-trips.
    const target = viewer.orbit.target.clone();
    viewer.camera.position.sub(target).applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.6).add(target);
    viewer.camera.lookAt(target);
    viewer.camera.updateMatrixWorld(true);
    const plane = controller.framePlane();
    for (const [u, v] of [[0.1, 0.2], [0.7, 0.4], [0.5, 0.95]]) {
        const world = controller.frameToWorld(u, v, plane);
        assert.ok(Math.abs(plane.plane.distanceToPoint(world)) < 1e-6);
        const back = controller.worldToFrame(world);
        assert.ok(Math.abs(back.u - u) < 1e-9 && Math.abs(back.v - v) < 1e-9);
        const overlay = controller.frameToOverlay(u, v, plane);
        const picked = controller.pointerToFrame(overlay.x, overlay.y, plane);
        assert.ok(Math.abs(picked.u - u) < 1e-6 && Math.abs(picked.v - v) < 1e-6, "pointer picks the same frame point");
    }
});

test("Fit Pose, Reset Targets, pins and Clear Constraints are undoable constraint commands", () => {
    const s = fittingScene();
    const { controller, viewer, handWorld } = s;
    controller.setActive(true);
    const markers = controller.state.markers;
    markers.l_wrist.u += 0.03;
    markers.l_wrist.v -= 0.04;
    markers.l_shoulder.pinned = true;
    const before = handWorld();
    const history = viewer.history.length;
    const result = controller.fitPose();
    assert.ok(result.maxError < 1, `fit ${result.maxError}`);
    assert.ok(handWorld().distanceTo(before) > 0.05);
    assert.equal(viewer.history.length, history + 1);
    // Reset Targets keeps pinned markers and snaps the others to the joints.
    markers.l_shoulder.u += 0.05;
    const pinnedU = controller.state.markers.l_shoulder.u;
    controller.resetTargets();
    assert.equal(controller.state.markers.l_shoulder.u, pinnedU);
    const joint = s.projected("l_elbow");
    assert.ok(Math.abs(controller.state.markers.l_elbow.u * 1024 - joint.x) < 1e-6);
    assert.equal(viewer.history.length, history + 2);
    controller.clearConstraints();
    assert.equal(viewer.fitting2d, null);
    assert.equal(viewer.getPose().fitting2d, undefined, "cleared poses keep the legacy format");
    viewer.undo();
    assert.equal(controller.state.markers.l_shoulder.u, pinnedU, "undo restores the constraints");
    // Toggling a marker is a single undoable edit that refits.
    controller.select("l_wrist");
    controller.editMarker("l_wrist", { enabled: false });
    assert.equal(controller.state.markers.l_wrist.enabled, false);
    viewer.undo();
    assert.equal(controller.state.markers.l_wrist.enabled, true);
});

test("weight slider edits refit live and commit one undo step on release", () => {
    const s = fittingScene();
    const { controller, viewer, runFrames } = s;
    controller.setActive(true);
    controller.state.markers.l_wrist.u += 0.05;
    controller.select("l_wrist");
    const weight = controller.elements.weight;
    const history = viewer.history.length;
    weight.emit("pointerdown");
    weight.value = "3";
    weight.emit("input");
    assert.ok(runFrames() >= 1, "weight input schedules a solve frame");
    assert.equal(controller.state.markers.l_wrist.weight, 3);
    weight.value = "4";
    weight.emit("input");
    runFrames();
    weight.emit("change");
    assert.equal(viewer.history.length, history + 1);
    assert.equal(controller.live, null);
});

test("constraint data survives workflow reload and Pose Library save/restore", async () => {
    const s = fittingScene();
    const { controller, viewer, w, node, handWorld } = s;
    controller.setActive(true);
    const markers = controller.state.markers;
    markers.r_wrist.u -= 0.04;
    markers.r_wrist.pinned = true;
    markers.r_wrist.weight = 2.5;
    markers.r_elbow.depth = "near";
    controller.updateSettings({ scope: "body", stiffness: 2 });
    controller.fitPose();
    const fittedHand = viewer.bones.hand_r.getWorldPosition(new s.THREE.Vector3());
    const expected = JSON.parse(JSON.stringify(viewer.fitting2d));
    w.syncToNode(false, { skipCapture: true, skipCaptureUpload: true });
    const workflow = node.widgets[0].value;

    // Library save -> load into a reset scene.
    let record = null;
    w.saveLibraryPoseRecord = async payload => { record = payload; return { id: "local_user_poses/test/fit" }; };
    w.refreshLibrary = () => {};
    assert.equal(await w.saveToLibrary("fit", false), true);
    assert.deepEqual(record.pose.characters[0].poses[0].fitting2d, expected);
    viewer.setPose({ bones: {} }, true);
    assert.equal(viewer.fitting2d, null);
    await w.loadCharacterSceneLibraryAsset(JSON.parse(JSON.stringify(record.pose)));
    assert.deepEqual(viewer.fitting2d, expected, "markers, pins, weights, hints and settings return");
    assert.ok(viewer.bones.hand_r.getWorldPosition(new s.THREE.Vector3()).distanceTo(fittedHand) < 1e-6, "the fitted pose returns");

    // Workflow JSON in another widget restores the same pose and markers.
    const other = fittingScene();
    other.node.widgets[0].value = workflow;
    other.w.loadFromNode();
    assert.deepEqual(other.viewer.fitting2d, expected);
    assert.ok(other.viewer.bones.hand_r.getWorldPosition(new other.THREE.Vector3()).distanceTo(fittedHand) < 1e-6);
    assert.ok(handWorld());
});

test("old poses without constraints still load and fitting stays per character pose", () => {
    const s = fittingScene();
    const { controller, viewer, w } = s;
    viewer.setPose({ bones: { head: [10, 0, 0] } }, true);
    assert.equal(viewer.fitting2d, null);
    assert.equal(viewer.getPose().fitting2d, undefined);
    controller.setActive(true);
    assert.ok(viewer.getPose().fitting2d, "entering the mode creates markers for this pose only");
    // Another pose tab keeps its own (absent) constraints.
    w.addTab();
    assert.equal(viewer.fitting2d, null);
    w.switchTab(0);
    assert.ok(viewer.fitting2d?.markers?.l_wrist?.u !== null);
    // Animation mode disables the fitting mode.
    w.isAnimationMode = () => true;
    controller.onPoseChanged();
    assert.equal(controller.active, false);
});

test("OpenPose JSON loads as markers through the existing parser", () => {
    const s = fittingScene();
    const { controller, viewer } = s;
    const truth = F.projectFittingJoints(controller.buildModel(), controller.projector());
    const order = ["head", "neck", "r_shoulder", "r_elbow", "r_wrist", "l_shoulder", "l_elbow", "l_wrist", "r_hip", "r_knee", "r_ankle", "l_hip", "l_knee", "l_ankle"];
    const keypoints = new Array(18 * 3).fill(0);
    order.forEach((id, index) => {
        keypoints[index * 3] = (truth[id].x + (id === "l_wrist" ? 30 : 0)) / 2;
        keypoints[index * 3 + 1] = truth[id].y / 2;
        keypoints[index * 3 + 2] = id === "r_ankle" ? 0 : 0.9;
    });
    const log = console.log; console.log = () => {};
    let imported;
    try { imported = controller.loadOpenPoseData({ people: [{ pose_keypoints_2d: keypoints }], canvas_width: 512, canvas_height: 512 }); }
    finally { console.log = log; }
    assert.equal(imported.found, 13);
    assert.equal(controller.active, true);
    assert.equal(viewer.fitting2d.source.format, "COCO-18");
    assert.equal(viewer.fitting2d.markers.r_ankle.enabled, false);
    assert.ok(viewer.fitting2d.markers.r_ankle.u !== null, "missing keypoints keep a position at the joint");
    const result = controller.fitPose();
    const wrist = result.markers.find(item => item.id === "l_wrist");
    assert.ok(wrist.error < 3, `wrist pulled 30px -> ${wrist.error}px (pose prior keeps a small residual)`);
    assert.ok(result.maxError < 3);
    assert.ok(!result.markers.some(item => item.id === "r_ankle"));
});

test("a frame budget bounds per-frame solve work", () => {
    assert.ok(POSE_FITTING_FRAME_BUDGET.iterations <= 10);
    assert.ok(POSE_FITTING_FRAME_BUDGET.timeMs <= 8);
    const s = fittingScene();
    const { controller, pointer, runFrames } = s;
    controller.setActive(true);
    const marker = controller.state.markers.r_wrist;
    const start = controller.frameToOverlay(marker.u, marker.v);
    pointer("pointerdown", start.x, start.y);
    for (let step = 1; step <= 10; step++) {
        pointer("pointermove", start.x + 3 * step, start.y + 2 * step);
        runFrames(1);
    }
    pointer("pointerup", start.x + 30, start.y + 20);
    const timing = controller.timingSummary();
    assert.ok(timing.max < 50, `frame solve ${timing.max}ms`);
    assert.ok(controller.lastResult.iterations <= 80);
});

test("each character keeps its own constraints for the same pose tab", async () => {
    const s = fittingScene();
    const { controller, viewer, w } = s;
    const second = createPoseStudioCharacter({ id: "character-2", mesh: w.meshParams, poses: [{}] });
    w.characters.push(second);
    controller.setActive(true);
    controller.state.markers.l_wrist.u = 0.71;
    w.syncToNode(false, { skipCapture: true, skipCaptureUpload: true });
    await w.selectCharacter("character-2");
    assert.equal(w.getActiveCharacter().id, "character-2");
    assert.equal(viewer.fitting2d, null, "the second character has no markers");
    controller.setActive(false);
    controller.setActive(true);
    controller.state.markers.l_wrist.u = 0.29;
    await w.selectCharacter(w.characters[0].id);
    assert.equal(viewer.fitting2d.markers.l_wrist.u, 0.71);
    await w.selectCharacter("character-2");
    assert.equal(viewer.fitting2d.markers.l_wrist.u, 0.29);
    const saved = JSON.parse(s.node.widgets[0].value);
    assert.deepEqual(saved.characters.map(item => item.poses[0].fitting2d?.markers.l_wrist.u), [0.71, 0.29]);
});

test("fitting follows an edited capture lens and an aligned view and never moves the camera", () => {
    const s = fittingScene();
    const { controller, viewer, w, THREE } = s;
    const section = { content: new Element("div") };
    w.createCaptureLensControls(section);
    const slide = (key, value) => {
        const slider = w.exportWidgets[key];
        slider.emit("pointerdown"); slider.value = String(value); slider.emit("input"); slider.emit("change"); slider.emit("pointerup");
    };
    const walk = node => node.children?.flatMap(child => [child, ...walk(child)]) || [];
    const camera = () => { viewer.captureCamera.updateMatrixWorld(true); return [...viewer.captureCamera.matrixWorld.toArray(), ...viewer.captureCamera.projectionMatrix.toArray()]; };
    const check = label => {
        // Markers from a known arm pose, then fit from the rest arm.
        const arm = viewer.bones.upperarm_l;
        arm.rotation.set(0.35, -0.2, 0.45);
        arm.updateMatrixWorld(true);
        controller.setActive(true);
        controller.resetTargets();
        arm.rotation.set(0, 0, 0);
        arm.updateMatrixWorld(true);
        const marker = controller.state.markers.l_wrist;
        const before = camera();
        const result = controller.fitPose();
        assert.ok(result.maxError < 1, `${label}: ${JSON.stringify(result.markers.map(m => [m.id, +m.error.toFixed(2)]))} ${result.reason} ${result.iterations}`);
        assert.deepEqual(camera(), before, `${label}: the capture camera never moves`);
        // Independent check with three.js projection through the real capture camera.
        const world = viewer.bones.hand_l.getWorldPosition(new THREE.Vector3());
        const ndc = world.project(viewer.captureCamera);
        const x = (ndc.x + 1) / 2, y = (1 - ndc.y) / 2;
        assert.ok(Math.hypot((x - marker.u) * 1024, (y - marker.v) * 1024) < 1, `${label}: three.js projection matches the marker`);
    };
    slide("cam_fov_deg", 50);
    slide("cam_distance", 70);
    assert.equal(viewer.captureCamera.fov, 50);
    check("FOV 50 / distance 70");
    viewer.camera.position.set(17, 23, 29);
    viewer.orbit.target.set(2, 9, -3);
    viewer.orbit.update();
    viewer.camera.updateMatrixWorld(true);
    walk(section.content).find(element => element.tagName === "BUTTON" && element.innerText === "Align Camera to View").click();
    assert.ok(w.exportParams.cam_view, "aligned view stored");
    check("aligned view");
});
