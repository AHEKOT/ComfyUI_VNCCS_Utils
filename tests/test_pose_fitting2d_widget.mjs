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

test("markers can be grabbed and dragged when the ComfyUI canvas is zoomed", () => {
    for (const zoom of [0.6, 1.5]) {
        const s = fittingScene();
        const { controller, pointer, runFrames, handWorld, viewer } = s;
        // ComfyUI scales the node DOM with a CSS transform: the client rect changes, layout px do not.
        const left = 40, top = 25;
        viewer.canvas.getBoundingClientRect = () => ({ left, top, width: VIEW * zoom, height: VIEW * zoom });
        controller.setActive(true);
        const marker = controller.state.markers.l_wrist;
        const original = { u: marker.u, v: marker.v };
        const layout = controller.frameToOverlay(marker.u, marker.v);
        const screen = { x: left + layout.x * zoom, y: top + layout.y * zoom };
        const startHand = handWorld();
        const down = pointer("pointerdown", screen.x, screen.y);
        assert.equal(down.stopped, true, `zoom ${zoom}: the drawn marker is hit`);
        assert.equal(controller.drag?.id, "l_wrist");
        pointer("pointermove", screen.x - 20, screen.y - 15);
        runFrames();
        assert.ok(handWorld().distanceTo(startHand) > 1e-4, `zoom ${zoom}: the arm follows before release`);
        pointer("pointerup", screen.x - 20, screen.y - 15);
        const moved = controller.frameToOverlay(controller.state.markers.l_wrist.u, controller.state.markers.l_wrist.v);
        assert.ok(Math.abs(moved.x - (layout.x - 20 / zoom)) < 0.5, `zoom ${zoom}: the marker stays under the cursor (x)`);
        assert.ok(Math.abs(moved.y - (layout.y - 15 / zoom)) < 0.5, `zoom ${zoom}: the marker stays under the cursor (y)`);
        assert.ok(Math.hypot(controller.state.markers.l_wrist.u - original.u, controller.state.markers.l_wrist.v - original.v) > 1e-4);
    }
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
    // The L Hand marker is a joint like the others: move it with the wrist.
    markers.l_hand.u += 0.03;
    markers.l_hand.v -= 0.04;
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

/** Put the editor camera close to the left hand so fingertip markers are far enough apart to grab. */
function lookAtLeftHand(s, distance = 5) {
    const { viewer, THREE } = s;
    const hand = viewer.bones.middle_01_l.getWorldPosition(new THREE.Vector3());
    viewer.camera.position.copy(hand).add(new THREE.Vector3(0, 0, distance));
    viewer.camera.lookAt(hand);
    viewer.camera.updateMatrixWorld(true);
    viewer.orbit.target.copy(hand);
}

test("L/R Hand markers are part of the body markers; the Fingertips checkbox adds the tips and groups the list", () => {
    const s = fittingScene();
    const { controller, viewer } = s;
    controller.setActive(true);
    const e = controller.elements;
    assert.equal(e.fingertips.checked, false, "Fingertips is off by default");
    assert.deepEqual(controller.visibleIds(), F.POSE_FITTING_BODY_MARKER_IDS);
    assert.equal(controller.visibleIds().length, 16);
    const frame = controller.frameSize();
    for (const id of ["l_hand", "r_hand"]) {
        const marker = controller.state.markers[id];
        const joint = s.projected(id);
        assert.equal(marker.enabled, true, `${id}: a new marker set includes it enabled, like the other joints`);
        assert.ok(Math.hypot(marker.u * frame.width - joint.x, marker.v * frame.height - joint.y) < 1e-6, `${id} sits on the hand point`);
        assert.equal(e.listRows.get(id).row.style.display, "", `${id} is listed with the body markers`);
    }
    assert.ok(F.POSE_FITTING_MARKER_IDS.filter(id => id.endsWith("_tip")).every(id => controller.state.markers[id].u === null));
    assert.ok([...e.listGroups.values()].every(header => header.style.display === "none"), "no group headers for body-only lists");
    const history = viewer.history.length;
    e.fingertips.checked = true;
    e.fingertips.emit("change");
    assert.equal(controller.visibleIds().length, 26);
    for (const id of ["l_middle_tip", "r_index_tip"]) {
        const marker = controller.state.markers[id];
        const joint = s.projected(id);
        assert.equal(marker.enabled, false, `${id} starts disabled: it constrains nothing until dragged`);
        assert.ok(Math.hypot(marker.u * frame.width - joint.x, marker.v * frame.height - joint.y) < 1e-6, `${id} sits on the fingertip`);
    }
    assert.equal(viewer.history.length, history, "the checkbox is a setting, not a pose edit");
    assert.equal(e.listGroups.get("l").style.display, "");
    assert.equal(e.listRows.get("r_pinky_tip").row.style.display, "");
    assert.equal(JSON.parse(s.node.widgets[0].value).characters[0].poses[0].fitting2d.settings.fingertips, true, "saved with the pose");
    // Off again: tips keep their data but leave the overlay, list and solver; the Hand markers stay.
    e.fingertips.checked = false;
    e.fingertips.emit("change");
    assert.ok(controller.state.markers.l_index_tip.u !== null);
    assert.equal(e.listRows.get("l_index_tip").row.style.display, "none");
    const solved = F.fittingStateToSolverMarkers(controller.state, frame).map(item => item.id);
    assert.ok(solved.includes("l_hand") && solved.every(id => !id.endsWith("_tip")));
});

test("dragging a fingertip marker bends the finger on every frame with one undo step at any canvas zoom", () => {
    for (const zoom of [0.6, 1, 1.4]) {
        const s = fittingScene();
        const { controller, viewer, pointer, runFrames, THREE } = s;
        const left = 30, top = 20;
        viewer.canvas.getBoundingClientRect = () => ({ left, top, width: VIEW * zoom, height: VIEW * zoom });
        lookAtLeftHand(s);
        controller.setActive(true);
        controller.setFingertips(true);
        const toScreen = id => {
            const marker = controller.state.markers[id];
            const layout = controller.frameToOverlay(marker.u, marker.v);
            return { x: left + layout.x * zoom, y: top + layout.y * zoom, layout };
        };
        const tipWorld = () => viewer.bones.index_03_l.getWorldPosition(new THREE.Vector3());
        const start = toScreen("l_index_tip");
        const history = viewer.history.length;
        const down = pointer("pointerdown", start.x, start.y);
        assert.equal(down.stopped, true, `zoom ${zoom}: the fingertip marker is hit`);
        assert.equal(controller.drag.id, "l_index_tip", `zoom ${zoom}: the nearest marker wins`);
        const startTip = tipWorld();
        let previous = startTip;
        const frame = controller.frameSize();
        for (let step = 1; step <= 3; step++) {
            pointer("pointermove", start.x + 5 * step * zoom, start.y + 4 * step * zoom);
            assert.ok(runFrames() >= 1);
            const now = tipWorld();
            assert.ok(now.distanceTo(previous) > 1e-5, `zoom ${zoom} step ${step}: the finger moved before release`);
            previous = now;
            const joint = s.projected("l_index_tip");
            const target = controller.state.markers.l_index_tip;
            assert.ok(Math.hypot(joint.x - target.u * frame.width, joint.y - target.v * frame.height) < 2, `zoom ${zoom} step ${step}: the tip follows`);
            assert.equal(viewer.history.length, history + 1);
        }
        pointer("pointerup", start.x + 15 * zoom, start.y + 12 * zoom);
        assert.equal(viewer.history.length, history + 1, "one undo step per gesture");
        const releasedJoint = s.projected("l_index_tip");
        const releasedTarget = controller.state.markers.l_index_tip;
        assert.ok(Math.hypot(releasedJoint.x - releasedTarget.u * frame.width, releasedJoint.y - releasedTarget.v * frame.height) < 1, `zoom ${zoom}: the fingertip does not spring back on release`);
        assert.ok(tipWorld().distanceTo(previous) < 0.2 * previous.distanceTo(startTip), `zoom ${zoom}: release refines without a visible jump`);
        assert.equal(controller.state.markers.l_index_tip.enabled, true, "dragging enables the tip");
        const moved = toScreen("l_index_tip");
        assert.ok(Math.abs(moved.layout.x - (start.layout.x + 15)) < 0.5 && Math.abs(moved.layout.y - (start.layout.y + 12)) < 0.5, "the marker stays under the cursor");
        const report = F.measureJointLimits(controller.buildModel());
        assert.ok(report.joints.index_02_l.violation < 1 && report.joints.index_03_l.violation < 1);
        viewer.undo();
        assert.equal(controller.state.markers.l_index_tip.enabled, false, "undo restores the marker");
    }
});

test("dragging the L Hand marker turns only the hand on every frame, with Fingertips off", () => {
    const s = fittingScene();
    const { controller, viewer, pointer, runFrames, THREE } = s;
    lookAtLeftHand(s, 7);
    controller.setActive(true);
    assert.equal(controller.settings().fingertips, false);
    const marker = controller.state.markers.l_hand;
    const start = controller.frameToOverlay(marker.u, marker.v);
    const wrist = controller.frameToOverlay(controller.state.markers.l_wrist.u, controller.state.markers.l_wrist.v);
    const before = Object.fromEntries(Object.entries(viewer.bones).map(([name, bone]) => [name, bone.quaternion.clone()]));
    const wristWorld = viewer.bones.hand_l.getWorldPosition(new THREE.Vector3());
    const history = viewer.history.length;
    assert.equal(pointer("pointerdown", start.x, start.y).stopped, true);
    assert.equal(controller.drag.id, "l_hand");
    // Swing the hand point sideways around the wrist in the image.
    const dx = start.x - wrist.x, dy = start.y - wrist.y;
    const at = angle => [wrist.x + dx * Math.cos(angle) - dy * Math.sin(angle), wrist.y + dx * Math.sin(angle) + dy * Math.cos(angle)];
    let previous = viewer.bones.hand_l.quaternion.clone();
    for (let step = 1; step <= 4; step++) {
        pointer("pointermove", ...at(0.06 * step));
        runFrames();
        assert.ok(viewer.bones.hand_l.quaternion.angleTo(previous) > 1e-4, `step ${step}: the hand turns while dragging`);
        previous = viewer.bones.hand_l.quaternion.clone();
        assert.equal(viewer.history.length, history + 1);
    }
    pointer("pointerup", ...at(0.24));
    assert.equal(viewer.history.length, history + 1, "one undo step per gesture");
    assert.ok(viewer.bones.hand_l.getWorldPosition(new THREE.Vector3()).distanceTo(wristWorld) < 1e-9, "the wrist stays where the wrist marker holds it");
    const changed = Object.keys(before).filter(name => viewer.bones[name].quaternion.angleTo(before[name]) > 1e-9);
    assert.deepEqual(changed, ["hand_l"], "no finger bends and the arm stays");
    assert.ok(controller.lastResult.markers.find(item => item.id === "l_hand").error < 2, JSON.stringify(controller.lastResult.markers));
    assert.ok(F.measureJointLimits(controller.buildModel()).joints.hand_l.violation < 1);
    viewer.undo();
    assert.ok(viewer.bones.hand_l.quaternion.angleTo(before.hand_l) < 1e-9, "undo restores the hand");
});

test("where the middle fingertip overlaps L Hand, the tip wins inside its small radius and the Hand ring outside it", () => {
    const s = fittingScene();
    const { controller, pointer } = s;
    lookAtLeftHand(s, 7);
    controller.setActive(true);
    controller.setFingertips(true);
    const markers = controller.state.markers;
    const hand = controller.frameToOverlay(markers.l_hand.u, markers.l_hand.v);
    const tip = controller.frameToOverlay(markers.l_middle_tip.u, markers.l_middle_tip.v);
    assert.ok(Math.hypot(hand.x - tip.x, hand.y - tip.y) < 0.5, "at rest both sit on the middle fingertip");
    assert.equal(controller.hitTest(tip.x, tip.y).id, "l_middle_tip", "the centre grabs the finger");
    // Outside the fingertip radius (6 px) but on the Hand ring (8 px, hit 11 px): the hand.
    const away = (angle, distance) => [hand.x + Math.cos(angle) * distance, hand.y + Math.sin(angle) * distance];
    const neighbours = ["l_thumb_tip", "l_index_tip", "l_ring_tip", "l_pinky_tip"].map(id => controller.frameToOverlay(markers[id].u, markers[id].v));
    const angle = [0, 1, 2, 3, 4, 5, 6, 7].map(k => k * Math.PI / 4)
        .find(a => neighbours.every(p => Math.hypot(p.x - away(a, 8)[0], p.y - away(a, 8)[1]) > 6));
    assert.ok(angle !== undefined);
    assert.equal(controller.hitTest(...away(angle, 8)).id, "l_hand", "the ring grabs the hand");
    pointer("pointerdown", ...away(angle, 8));
    assert.equal(controller.drag.id, "l_hand");
    pointer("pointerup", ...away(angle, 8));
    // Against a regular body marker the nearer one wins.
    const wrist = controller.frameToOverlay(markers.l_wrist.u, markers.l_wrist.v);
    assert.equal(controller.hitTest(wrist.x, wrist.y).id, "l_wrist");
});

test("poses saved before L/R Hand existed get them disabled at the hand point and solve as before", () => {
    const s = fittingScene();
    const { controller, viewer, w } = s;
    // Reference: today's solve with the Hand markers disabled.
    controller.setActive(true);
    const legacy = F.cloneFittingState(controller.state);
    legacy.markers.l_wrist.u += 0.03;
    legacy.markers.l_wrist.v -= 0.02;
    delete legacy.markers.l_hand;
    delete legacy.markers.r_hand;
    delete legacy.settings.fingertips;
    legacy.version = 1;
    controller.setActive(false);
    viewer.setPose({ bones: {}, fitting2d: legacy }, true);
    assert.equal(viewer.fitting2d.markers.l_hand.u, null, "loaded data has no Hand markers yet");
    controller.setActive(true);
    const frame = controller.frameSize();
    for (const id of ["l_hand", "r_hand"]) {
        const marker = viewer.fitting2d.markers[id];
        const joint = s.projected(id);
        assert.equal(marker.enabled, false, `${id} is added disabled`);
        assert.ok(Math.hypot(marker.u * frame.width - joint.x, marker.v * frame.height - joint.y) < 1e-6, `${id} at the current hand point`);
    }
    const result = controller.fitPose();
    const handBefore = viewer.bones.hand_l.quaternion.clone();
    assert.ok(result.maxError < 1, `${result.maxError}`);
    assert.ok(!result.markers.some(item => item.id === "l_hand"), "disabled Hand markers are not solved");
    assert.equal(result.stages, undefined, "the plain body solve");
    assert.ok(viewer.bones.hand_l.quaternion.angleTo(handBefore) < 1e-12);
    // Reset Targets creates them enabled, like the other joints.
    controller.resetTargets();
    assert.equal(viewer.fitting2d.markers.l_hand.enabled, true);
    assert.ok(w);
});

test("reset buttons restore Stiffness and Weight as one undo step; the Weight reset refits", () => {
    const s = fittingScene();
    const { controller, viewer, runFrames, handWorld } = s;
    controller.setActive(true);
    const e = controller.elements;
    for (const button of [e.stiffnessReset, e.weightReset]) {
        assert.equal(button.className, "vnccs-ps-reset-btn", "the Pose Studio slider reset control");
        assert.equal(button.innerHTML, "↺");
    }
    assert.equal(e.stiffnessReset.title, "Reset to 1.00");
    assert.equal(e.weightReset.title, "Reset to 1.0");
    let history = viewer.history.length;
    e.stiffness.emit("pointerdown");
    e.stiffness.value = "1";
    e.stiffness.emit("input");
    e.stiffness.emit("change");
    e.stiffness.emit("pointerup");
    assert.equal(controller.state.settings.stiffness, 4);
    assert.equal(viewer.history.length, history + 1, "a Stiffness gesture is one undo step");
    history = viewer.history.length;
    e.stiffnessReset.click();
    assert.equal(controller.state.settings.stiffness, 1);
    assert.equal(e.stiffness.value, "0");
    assert.equal(e.stiffnessLabel.textContent, "1.00");
    assert.equal(viewer.history.length, history + 1, "the reset is one undo step");
    viewer.undo();
    assert.equal(controller.state.settings.stiffness, 4, "undo restores the stiffness");

    controller.state.markers.l_wrist.u += 0.05;
    controller.state.markers.l_elbow.pinned = true;
    controller.select("l_wrist");
    e.weight.emit("pointerdown");
    e.weight.value = "4";
    e.weight.emit("input");
    runFrames();
    e.weight.emit("change");
    const weighted = handWorld();
    history = viewer.history.length;
    e.weightReset.click();
    assert.equal(controller.state.markers.l_wrist.weight, 1);
    assert.equal(e.weight.value, "1");
    assert.equal(viewer.history.length, history + 1, "the reset is one undo step");
    assert.equal(controller.live, null, "the live edit is closed");
    assert.ok(handWorld().distanceTo(weighted) > 1e-5, "the reset refits the pose");
    viewer.undo();
    assert.equal(controller.state.markers.l_wrist.weight, 4);
});

test("Hide bone handles hides and disables bone picking while Fitting Mode is on and restores it", () => {
    const s = fittingScene();
    const { controller, viewer, THREE, node } = s;
    viewer._createJointMarkers();
    const transform = {
        dragging: false, axis: null, enabled: true, visible: false, object: null,
        attach(object) { this.object = object; this.visible = true; }, detach() { this.object = null; this.visible = false; }, setMode() {},
    };
    viewer.transform = transform;
    const effector = { visible: false }, pole = { visible: false };
    const ik = { effectors: { hand_l: effector }, poleTargets: { leftArm: pole }, getChainForEffector: () => "leftArm", getMode: () => "ik", getPoleMode: () => "on" };
    const withIK = fn => { viewer.ikController = ik; viewer.ikMode = true; try { fn(); } finally { viewer.ikController = null; viewer.ikMode = false; } };
    const click = name => {
        const point = viewer.bones[name].getWorldPosition(new THREE.Vector3()).project(viewer.camera);
        viewer.handlePointerDown({ button: 0, clientX: (point.x + 1) / 2 * VIEW, clientY: (1 - point.y) / 2 * VIEW, pointerId: 3 });
    };
    const bodyMarkers = () => viewer.jointMarkers.filter(marker => !viewer._isFingerHandBoneName(viewer.boneList[marker.userData.boneIndex].name));
    click("lowerarm_l");
    assert.equal(viewer.selectedBone?.name, "lowerarm_l", "normal mode: the elbow handle selects the bone");
    assert.equal(transform.visible, true);
    withIK(() => { viewer.updateIKEffectorVisibility(); viewer.updatePoleTargetVisibility(); assert.ok(effector.visible && pole.visible); });

    // The setting alone does nothing until Fitting Mode is on.
    controller.elements.hideHandles.checked = true;
    controller.elements.hideHandles.emit("change");
    assert.equal(s.w.exportParams.fit_hide_bone_handles, true);
    assert.equal(viewer.areBoneHandlesHidden(), false);
    controller.setActive(true);
    assert.equal(viewer.areBoneHandlesHidden(), true);
    assert.ok(viewer.jointMarkers.every(marker => marker.visible === false), "every bone drag point is hidden");
    assert.equal(viewer.selectedBone, null, "the selected bone and its gizmo are released");
    assert.equal(transform.visible, false);
    assert.equal(transform.enabled, false, "the gizmo cannot be grabbed");
    withIK(() => { viewer.updateIKEffectorVisibility(); viewer.updatePoleTargetVisibility(); assert.ok(!effector.visible && !pole.visible, "IK helpers are hidden"); });
    click("lowerarm_l");
    click("head");
    assert.equal(viewer.selectedBone, null, "clicks in the viewport select no bone");
    viewer.handlePointerMove({ clientX: 10, clientY: 10, buttons: 0 });
    assert.equal(viewer.hoveredBoneName, null);
    // External selection (bone list / timeline) keeps the gizmo hidden and inert.
    viewer.selectBoneByName("upperarm_l");
    assert.equal(transform.visible, false);
    viewer.deselectBone();
    // 2D markers keep working.
    const marker = controller.state.markers.l_wrist;
    const position = controller.frameToOverlay(marker.u, marker.v);
    assert.equal(s.pointer("pointerdown", position.x, position.y).stopped, true);
    s.pointer("pointerup", position.x, position.y);
    assert.equal(JSON.parse(node.widgets[0].value).export.fit_hide_bone_handles, true, "saved with the node, not with the pose");
    assert.equal(viewer.getPose().fitting2d.settings.hideBoneHandles, undefined);

    // Leaving Fitting Mode restores normal editing; entering it hides them again.
    controller.setActive(false);
    assert.equal(viewer.areBoneHandlesHidden(), false);
    assert.ok(bodyMarkers().every(marker => marker.visible), "bone drag points are back");
    assert.equal(transform.enabled, true);
    click("lowerarm_l");
    assert.equal(viewer.selectedBone?.name, "lowerarm_l");
    controller.setActive(true);
    assert.equal(viewer.areBoneHandlesHidden(), true);
    controller.elements.hideHandles.checked = false;
    controller.elements.hideHandles.emit("change");
    assert.equal(viewer.areBoneHandlesHidden(), false, "turning the toggle off restores the handles");
    assert.ok(bodyMarkers().every(marker => marker.visible));
    click("head");
    assert.equal(viewer.selectedBone?.name, "head");
    withIK(() => { viewer.updateIKEffectorVisibility(); assert.ok(effector.visible); });
});

test("Flip on a selected L Hand marker mirrors the wrist direction as one undo step; fingers stay; refusals explain why", () => {
    const s = fittingScene();
    const { controller, viewer, THREE } = s;
    controller.setActive(true);
    controller.setFingertips(true);
    // A wrist flexed toward the camera, so the mirrored direction is inside the limits.
    const hand = controller.buildModel().bones[controller.buildModel().index.get("hand_l")];
    viewer.bones.hand_l.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...hand.limitAxes.flex), 60 * Math.PI / 180))
        .premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...hand.limitAxes.side), 10 * Math.PI / 180));
    viewer.skinnedMesh.updateMatrixWorld(true);
    controller.resetTargets();
    controller.select("l_hand");
    const e = controller.elements;
    assert.equal(e.flip.disabled, false, "Flip is available for L Hand");
    const fingers = Object.fromEntries(F.POSE_FITTING_FINGER_BONES.filter(name => name.endsWith("_l")).map(name => [name, viewer.bones[name].quaternion.clone()]));
    const handBefore = viewer.bones.hand_l.quaternion.clone();
    const before = s.projected("l_hand");
    const history = viewer.history.length;
    e.flip.emit("click");
    assert.equal(viewer.history.length, history + 1, "one undo step");
    assert.ok(viewer.bones.hand_l.quaternion.angleTo(handBefore) > 0.2, "the wrist turned");
    const after = s.projected("l_hand");
    // The mirror lands ~2 degrees past the wrist limit here; the refit settles it inside within a pixel or two.
    assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 2, "the Hand point keeps its 2D position");
    for (const [name, q] of Object.entries(fingers)) assert.ok(viewer.bones[name].quaternion.angleTo(q) < 1e-9, `${name} untouched`);
    assert.ok(["near", "far"].includes(controller.state.markers.l_hand.depth), "the Depth hint holds the new side");
    assert.equal(e.depth.value, controller.state.markers.l_hand.depth);
    assert.match(controller.message, /L Hand: depth flipped/);
    viewer.undo();
    assert.ok(viewer.bones.hand_l.quaternion.angleTo(handBefore) < 1e-9, "undo restores the wrist");
    // At rest the mirrored hand would need more side bend than the wrist has.
    viewer.setPose({ bones: {} }, true);
    controller.resetTargets();
    controller.select("l_hand");
    const restHistory = viewer.history.length;
    controller.elements.flip.emit("click");
    assert.match(controller.message, /mirrored hand would break the wrist limits/);
    assert.equal(viewer.history.length, restHistory, "a refused Flip records nothing");
});

test("Optimize defaults to Whole body: a hip marker turns the pelvis on every frame; saved Limbs + head is kept", () => {
    const s = fittingScene();
    const { controller, viewer, pointer, runFrames } = s;
    controller.setActive(true);
    assert.equal(controller.settings().scope, "body");
    assert.equal(controller.elements.scope.value, "body");
    assert.equal(controller.settings().moveRoot, false, "Move root stays off by default");
    const marker = controller.state.markers.l_hip;
    const start = controller.frameToOverlay(marker.u, marker.v);
    const other = controller.frameToOverlay(controller.state.markers.r_hip.u, controller.state.markers.r_hip.v);
    const inward = Math.sign(other.x - start.x);
    let previous = s.projected("l_hip");
    pointer("pointerdown", start.x, start.y);
    assert.equal(controller.drag.id, "l_hip");
    for (let step = 1; step <= 3; step++) {
        pointer("pointermove", start.x + inward * 3 * step, start.y);
        runFrames();
        const now = s.projected("l_hip");
        assert.ok(Math.hypot(now.x - previous.x, now.y - previous.y) > 0.5, `step ${step}: the hip moves while dragging`);
        previous = now;
    }
    pointer("pointerup", start.x + inward * 9, start.y);
    assert.ok(viewer.bones.pelvis.quaternion.angleTo(new s.THREE.Quaternion()) > 1e-4 || viewer.bones.spine_01.quaternion.angleTo(new s.THREE.Quaternion()) > 1e-4, "the pelvis turned");
    // Outward past the hip width a rigid pelvis cannot follow: the panel says to use Move root.
    const now = controller.frameToOverlay(controller.state.markers.l_hip.u, controller.state.markers.l_hip.v);
    pointer("pointerdown", now.x, now.y);
    pointer("pointermove", now.x - inward * 40, now.y);
    runFrames();
    pointer("pointerup", now.x - inward * 40, now.y);
    assert.match(controller.message, /Move root/);
    // Saved data that stored Limbs + head keeps it.
    const saved = F.cloneFittingState(controller.state);
    saved.settings.scope = "limbs";
    controller.setActive(false);
    viewer.setPose({ bones: {}, fitting2d: saved }, true);
    controller.setActive(true);
    assert.equal(controller.settings().scope, "limbs");
    assert.equal(controller.elements.scope.value, "limbs");
});
