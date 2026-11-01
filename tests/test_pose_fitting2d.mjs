// 2D Pose Fitting solver: projection, coordinate conversion, synthetic inverse
// problems on the real MakeHuman rig, limits, pins, camera changes and import.
import assert from "node:assert/strict";
import test from "node:test";
import { createScene } from "./helpers/pose_studio_scene.mjs";
import { parseOpenPoseJSON } from "../web/pose_studio/imports/openpose.js";
import * as F from "../web/pose_studio/pose_fitting2d.mjs";

const FRAME = { width: 1024, height: 1024 };
const scene = createScene({ skinned: true });
const { viewer, THREE } = scene;
const quiet = fn => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };

function resetRig({ zoom = 1, modelRotation = [0, 0, 0] } = {}) {
    viewer.setPose({ bones: {}, modelRotation }, true);
    viewer.setActiveCharacterAppearance({ transform: { x: 0, y: 0, z: 0, zoom } });
    viewer.updateCaptureCamera(FRAME.width, FRAME.height, 1, 0, 0, 0, 0);
    viewer.skinnedMesh.updateMatrixWorld(true);
}
const model = () => F.buildFittingModel(F.snapshotViewerRig(viewer));
const projector = (frame = FRAME) => F.captureCameraProjector(viewer.captureCamera, frame.width, frame.height);
const hingeAxis = name => model().bones[model().index.get(name)].hingeAxis;
function setBones(rotations) {
    for (const [name, value] of Object.entries(rotations)) {
        if (typeof value === "number") viewer.bones[name].quaternion.setFromAxisAngle(new THREE.Vector3(...hingeAxis(name)), value);
        else viewer.bones[name].rotation.set(...value);
    }
    viewer.skinnedMesh.updateMatrixWorld(true);
}
const markersFrom = (points, ids = Object.keys(points)) => ids.map(id => ({ id, x: points[id].x, y: points[id].y }));
function jointDistances(m, state) {
    const world = F.forwardKinematics(m, state);
    return m.bones.filter(bone => bone.parent >= 0).map(bone => {
        const a = world[bone.parent], b = world[m.index.get(bone.name)];
        return Math.hypot(a[12] - b[12], a[13] - b[13], a[14] - b[14]);
    });
}

test("the capture projector reproduces Vector3.project for FOV, zoom, aspect and camera angles", () => {
    resetRig();
    const cases = [
        { width: 1024, height: 1024, zoom: 1, yaw: 0, pitch: 0, fov: 30 },
        { width: 768, height: 1344, zoom: 1.8, yaw: 35, pitch: -20, fov: 30 },
        { width: 1536, height: 640, zoom: 0.6, yaw: -120, pitch: 40, fov: 30 },
        { width: 1024, height: 1024, zoom: 1.2, yaw: 15, pitch: 10, fov: 55 },
    ];
    for (const item of cases) {
        viewer.updateCaptureCamera(item.width, item.height, item.zoom, 0.5, -0.3, item.yaw, item.pitch);
        viewer.captureCamera.fov = item.fov;
        viewer.captureCamera.updateProjectionMatrix();
        const p = projector(item);
        for (const name of ["head", "hand_l", "foot_r", "upperarm_r"]) {
            const world = viewer.bones[name].getWorldPosition(new THREE.Vector3());
            const ndc = world.clone().project(viewer.captureCamera);
            const mine = p.project(world.toArray());
            assert.ok(Math.abs(mine.x - (ndc.x + 1) / 2 * item.width) < 1e-6, `${name} x`);
            assert.ok(Math.abs(mine.y - (1 - ndc.y) / 2 * item.height) < 1e-6, `${name} y`);
            // The ray through a projected pixel passes through the point.
            const ray = p.ray(mine.x, mine.y);
            const toPoint = world.clone().sub(new THREE.Vector3(...ray.origin));
            const along = toPoint.dot(new THREE.Vector3(...ray.direction));
            assert.ok(toPoint.lengthSq() - along * along < 1e-8);
        }
        // Analytic Jacobian matches finite differences.
        const point = [1.2, 3.4, 0.7];
        const base = p.project(point, true);
        for (let k = 0; k < 3; k++) {
            const shifted = point.slice(); shifted[k] += 1e-6;
            const moved = p.project(shifted);
            assert.ok(Math.abs((moved.x - base.x) / 1e-6 - base.dx[k]) < 1e-3 * Math.max(1, Math.abs(base.dx[k])));
            assert.ok(Math.abs((moved.y - base.y) / 1e-6 - base.dy[k]) < 1e-3 * Math.max(1, Math.abs(base.dy[k])));
        }
    }
    viewer.captureCamera.fov = 30;
    resetRig();
});

test("source pixels map onto normalized output-frame coordinates exactly", () => {
    assert.deepEqual(F.sourcePixelToFrame(256, 384, { width: 512, height: 768 }, FRAME), { u: 0.5, v: 0.5 });
    assert.deepEqual(F.sourcePixelToFrame(0, 768, { width: 512, height: 768 }, FRAME, "stretch"), { u: 0, v: 1 });
    // contain: a 2:1 source in a square frame is letterboxed vertically.
    const contain = F.sourcePixelToFrame(0, 0, { width: 200, height: 100 }, { width: 100, height: 100 }, "contain");
    assert.deepEqual(contain, { u: 0, v: 0.25 });
    // cover: the same source is cropped horizontally.
    const cover = F.sourcePixelToFrame(100, 50, { width: 200, height: 100 }, { width: 100, height: 100 }, "cover");
    assert.deepEqual(cover, { u: 0.5, v: 0.5 });
    assert.deepEqual(F.sourcePixelToFrame(50, 0, { width: 200, height: 100 }, { width: 100, height: 100 }, "cover"), { u: 0, v: 0 });
    const pixel = F.frameToPixel(0.25, 0.75, { width: 800, height: 600 });
    assert.deepEqual(pixel, { x: 200, y: 450 });
    assert.deepEqual(F.pixelToFrame(pixel.x, pixel.y, { width: 800, height: 600 }), { u: 0.25, v: 0.75 });
});

test("forward kinematics matches the Three.js skeleton including model rotation, scale and root offset", () => {
    resetRig({ zoom: 1.7, modelRotation: [10, 35, -5] });
    setBones({ spine_02: [0.2, -0.1, 0.05], upperarm_l: [0.3, 0.2, -0.5], lowerarm_l: 0.6, thigh_r: [-0.4, 0.1, 0.1], calf_r: 0.5 });
    viewer.bones.pelvis.position.x += 0.3;
    viewer.skinnedMesh.updateMatrixWorld(true);
    const m = model();
    const world = F.forwardKinematics(m);
    for (const name of F.POSE_FITTING_RIG_BONES) {
        const expected = viewer.bones[name].getWorldPosition(new THREE.Vector3());
        const i = m.index.get(name);
        assert.ok(Math.hypot(expected.x - world[i][12], expected.y - world[i][13], expected.z - world[i][14]) < 1e-9, name);
    }
    resetRig();
});

test("hinge axes bend elbows forward and knees backward on both sides", () => {
    resetRig();
    const m = model();
    for (const [name, side] of [["lowerarm_l", 1], ["lowerarm_r", 1], ["calf_l", -1], ["calf_r", -1]]) {
        const bone = m.bones[m.index.get(name)];
        const bend = [
            bone.hingeAxis[1] * bone.upperDir[2] - bone.hingeAxis[2] * bone.upperDir[1],
            bone.hingeAxis[2] * bone.upperDir[0] - bone.hingeAxis[0] * bone.upperDir[2],
            bone.hingeAxis[0] * bone.upperDir[1] - bone.hingeAxis[1] * bone.upperDir[0],
        ];
        assert.ok(bend[2] * side > 0, `${name} flexes toward the ${side > 0 ? "front" : "back"}`);
    }
    // Left and right markers project to the correct image side for a character facing the camera.
    const points = F.projectFittingJoints(m, projector());
    for (const joint of ["shoulder", "elbow", "wrist", "hip", "knee", "ankle"]) {
        assert.ok(points[`r_${joint}`].x < FRAME.width / 2, `subject right ${joint} is on image left`);
        assert.ok(points[`l_${joint}`].x > FRAME.width / 2, `subject left ${joint} is on image right`);
    }
    assert.ok(points.head.y < points.neck.y, "head marker (nose) is above the neck");
});

test("one arm: elbow and wrist markers from a known pose are recovered together", () => {
    resetRig();
    setBones({ upperarm_l: [0.4, -0.2, 0.5], lowerarm_l: 0.7 });
    const truth = F.projectFittingJoints(model(), projector());
    resetRig();
    const start = model();
    const result = F.solvePoseFitting(start, projector(), markersFrom(truth, ["l_shoulder", "l_elbow", "l_wrist"]), { bones: ["upperarm_l", "lowerarm_l"], maxIterations: 60 });
    assert.equal(result.valid, true);
    assert.ok(result.maxError < 0.5, `max ${result.maxError}`);
    const errors = Object.fromEntries(result.markers.map(item => [item.id, item.error]));
    assert.ok(errors.l_elbow < 0.5 && errors.l_wrist < 0.5, "both joints are matched simultaneously");
    assert.deepEqual(result.dofs.map(dof => dof.bone), ["upperarm_l", "upperarm_l", "upperarm_l", "lowerarm_l"]);
    assert.ok(result.maxLimitViolation < 0.01);
});

test("whole body: markers generated from a reachable pose are recovered with valid joints and fixed bone lengths", () => {
    resetRig();
    setBones({
        spine_01: [0.12, 0.05, 0.04], spine_02: [0.1, -0.08, 0], neck_01: [0.15, 0.2, 0], head: [-0.1, 0.25, 0.05],
        upperarm_l: [0.2, -0.4, 0.7], lowerarm_l: 0.8, upperarm_r: [-0.3, 0.3, -0.2], lowerarm_r: 0.4,
        thigh_l: [-0.5, 0.1, 0.15], calf_l: 0.7, thigh_r: [0.2, -0.1, -0.05], calf_r: 0.2,
    });
    const truth = F.projectFittingJoints(model(), projector());
    resetRig();
    const start = model();
    const restLengths = jointDistances(start);
    const result = F.solvePoseFitting(start, projector(), markersFrom(truth), { scope: "body", maxIterations: 200 });
    assert.equal(result.valid, true);
    assert.ok(result.maxError < 1, `max ${result.maxError}`);
    assert.ok(result.meanError < 0.5, `mean ${result.meanError}`);
    assert.ok(result.maxLimitViolation < 0.5, `limit violation ${result.maxLimitViolation}`);
    const fittedLengths = jointDistances(start, result.state);
    restLengths.forEach((length, i) => assert.ok(Math.abs(length - fittedLengths[i]) < 1e-9, "bone lengths never change"));
    // Limbs-only scope never touches the torso.
    const limbs = F.solvePoseFitting(start, projector(), markersFrom(truth), { scope: "limbs", maxIterations: 50 });
    assert.ok(!limbs.dofs.some(dof => /^(spine|pelvis)/.test(dof.bone)));
    assert.ok(!F.changedBones(start, limbs.state).some(name => /^(spine|pelvis)/.test(name)));
});

test("unreachable targets keep a valid skeleton and report residuals", () => {
    resetRig();
    const start = model();
    const points = F.projectFittingJoints(start, projector());
    const markers = [
        { id: "l_shoulder", x: points.l_shoulder.x, y: points.l_shoulder.y, pinned: true },
        { id: "l_wrist", x: points.l_wrist.x + 400, y: points.l_wrist.y - 300 },
    ];
    const result = F.solvePoseFitting(start, projector(), markers, { maxIterations: 80 });
    assert.equal(result.valid, true);
    assert.ok(result.state.quaternions.flat().every(Number.isFinite));
    assert.ok(result.unreached.includes("l_wrist"));
    assert.ok(result.markers.find(item => item.id === "l_wrist").error > 100, "the residual is reported, not hidden");
    assert.ok(result.maxLimitViolation < 1, `limit violation ${result.maxLimitViolation}`);
    const flex = F.measureJointLimits(start, result.state).joints.lowerarm_l.flex;
    assert.ok(flex > -1 && flex < 151, `elbow stays anatomical (${flex})`);
    const lengths = jointDistances(start), fitted = jointDistances(start, result.state);
    lengths.forEach((length, i) => assert.ok(Math.abs(length - fitted[i]) < 1e-9));
});

test("random targets never hyperextend or sideways-bend elbows and knees", () => {
    resetRig();
    const start = model();
    const points = F.projectFittingJoints(start, projector());
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let trial = 0; trial < 12; trial++) {
        const markers = ["l_elbow", "l_wrist", "r_elbow", "r_wrist", "l_knee", "l_ankle", "r_knee", "r_ankle"]
            .map(id => ({ id, x: points[id].x + random() * 120, y: points[id].y + random() * 120 }));
        const result = F.solvePoseFitting(start, projector(), markers, { maxIterations: 60 });
        assert.equal(result.valid, true);
        const joints = F.measureJointLimits(start, result.state).joints;
        for (const name of ["lowerarm_l", "lowerarm_r", "calf_l", "calf_r"]) {
            assert.ok(joints[name].flex > -1 && joints[name].flex < 151, `${name} flex ${joints[name].flex}`);
        }
        assert.ok(result.maxLimitViolation < 2, `trial ${trial}: ${result.maxLimitViolation}`);
    }
});

test("pinned markers are held when another marker conflicts with them", () => {
    resetRig();
    const start = model();
    const points = F.projectFittingJoints(start, projector());
    const markers = pinned => [
        { id: "l_shoulder", x: points.l_shoulder.x, y: points.l_shoulder.y, pinned },
        { id: "l_wrist", x: points.l_wrist.x, y: points.l_wrist.y, pinned },
        { id: "l_elbow", x: points.l_elbow.x + 160, y: points.l_elbow.y - 40, dragging: true },
    ];
    const free = F.solvePoseFitting(start, projector(), markers(false), { maxIterations: 80 });
    const held = F.solvePoseFitting(start, projector(), markers(true), { maxIterations: 80 });
    const error = (result, id) => result.markers.find(item => item.id === id).error;
    assert.ok(error(held, "l_wrist") < error(free, "l_wrist"), "pinning reduces the wrist drift");
    assert.ok(error(held, "l_shoulder") <= error(free, "l_shoulder") + 1e-9);
    assert.ok(error(held, "l_shoulder") < 3, `pinned shoulder ${error(held, "l_shoulder")}`);
});

test("depth hints choose the side of the camera and flips keep the 2D position", () => {
    resetRig();
    setBones({ upperarm_l: [0, 0, -0.4], lowerarm_l: 1.0 });
    const start = model();
    const p = projector();
    const before = F.projectFittingJoints(start, p);
    // Mirroring this forearm behind the elbow needs a ~160 degree humeral twist: refused.
    assert.equal(F.flipMarkerDepth(start, p, "l_wrist"), null);
    const forced = F.flipMarkerDepth(start, p, "l_wrist", null, { allowViolation: true });
    const after = F.projectFittingJoints(start, p, forced);
    assert.ok(Math.hypot(after.l_wrist.x - before.l_wrist.x, after.l_wrist.y - before.l_wrist.y) < 0.5, "wrist stays on its 2D marker");
    assert.ok(Math.hypot(after.l_elbow.x - before.l_elbow.x, after.l_elbow.y - before.l_elbow.y) < 1e-6, "elbow does not move");
    assert.notEqual(F.markerDepthRelation(start, p, "l_wrist", forced), F.markerDepthRelation(start, p, "l_wrist"));
    const flex = F.measureJointLimits(start, forced).joints.lowerarm_l.flex;
    assert.ok(flex >= -0.5 && flex <= 150.5, `hinge stays valid (${flex})`);
    assert.equal(F.flipMarkerDepth(start, p, "l_shoulder"), null, "shoulders have no single segment to flip");

    // An upper arm pointing toward the camera has a valid mirrored twin.
    resetRig();
    setBones({ upperarm_l: [0, -0.5, 0], lowerarm_l: 0.6 });
    const arm = model();
    const armPoints = F.projectFittingJoints(arm, p);
    const relation = F.markerDepthRelation(arm, p, "l_elbow");
    const flipped = F.flipMarkerDepth(arm, p, "l_elbow");
    assert.ok(flipped, "the upper arm can be flipped");
    const flippedPoints = F.projectFittingJoints(arm, p, flipped);
    assert.ok(Math.hypot(flippedPoints.l_elbow.x - armPoints.l_elbow.x, flippedPoints.l_elbow.y - armPoints.l_elbow.y) < 0.5);
    const opposite = relation === "near" ? "far" : "near";
    assert.equal(F.markerDepthRelation(arm, p, "l_elbow", flipped), opposite);
    assert.ok(F.measureJointLimits(arm, flipped).maxViolation < 0.01);
    // With the hint, a refit from the flipped pose stays on the flipped side and matches the markers.
    const markers = depth => markersFrom(armPoints, ["l_shoulder", "l_elbow", "l_wrist"]).map(marker => (
        marker.id === "l_elbow" ? { ...marker, depth } : marker
    ));
    const kept = F.solvePoseFitting(arm, p, markers(opposite), { maxIterations: 80, bones: ["upperarm_l", "lowerarm_l"], initialState: flipped, anchor: flipped });
    assert.equal(F.markerDepthRelation(arm, p, "l_elbow", kept.state), opposite);
    assert.ok(kept.maxError < 1, `flipped fit ${kept.maxError}`);

    // An upper arm close to the image plane follows a hint in either direction.
    resetRig();
    const rest = model();
    const restPoints = F.projectFittingJoints(rest, p);
    for (const depth of ["near", "far"]) {
        const hinted = F.solvePoseFitting(rest, p, markersFrom(restPoints, ["l_shoulder", "l_elbow", "l_wrist"]).map(marker => (
            marker.id === "l_elbow" ? { ...marker, depth } : marker
        )), { maxIterations: 80, bones: ["upperarm_l", "lowerarm_l"] });
        assert.equal(F.markerDepthRelation(rest, p, "l_elbow", hinted.state), depth);
        assert.ok(hinted.maxError < 1, `${depth}: ${hinted.maxError}`);
    }
});

test("camera FOV and angle changes are evaluated with the real capture projection", () => {
    resetRig();
    viewer.updateCaptureCamera(1024, 768, 1.3, 0, 0, 30, -15);
    viewer.captureCamera.fov = 50;
    viewer.captureCamera.updateProjectionMatrix();
    const frame = { width: 1024, height: 768 };
    setBones({ upperarm_r: [0.3, 0.4, -0.3], lowerarm_r: 0.9, thigh_l: [-0.6, 0, 0.1], calf_l: 0.9 });
    const truth = F.projectFittingJoints(model(), projector(frame));
    viewer.setPose({ bones: {} }, true);
    viewer.skinnedMesh.updateMatrixWorld(true);
    const start = model();
    const result = F.solvePoseFitting(start, projector(frame), markersFrom(truth), { maxIterations: 120 });
    assert.ok(result.maxError < 1, `max ${result.maxError}`);
    // The same normalized targets read through another frame size stay attached to the frame.
    const state = F.resetFittingTargets(null, truth, frame);
    const solverMarkers = F.fittingStateToSolverMarkers(state, { width: 2048, height: 1536 });
    assert.ok(Math.abs(solverMarkers.find(item => item.id === "r_wrist").x - truth.r_wrist.x * 2) < 1e-9);
    viewer.captureCamera.fov = 30;
    resetRig();
});

test("the pose prior scales with the figure's size in the frame", () => {
    resetRig();
    const close = (actual, expected, label) => assert.ok(Math.abs(actual / expected - 1) < 0.03, `${label}: ${actual} vs ${expected}`);
    const base = F.projectionPriorScale(model(), projector());
    assert.ok(Math.abs(base - 1) < 0.1, `default capture: ${base}`);
    close(F.projectionPriorScale(model(), projector({ width: 2048, height: 2048 })), 4 * base, "twice the output size");
    viewer.setCaptureLens({ fov_deg: 50, distance: 70 });
    viewer.updateCaptureCamera(FRAME.width, FRAME.height, 1, 0, 0, 0, 0);
    const ratio = (45 * Math.tan(Math.PI / 12)) / (70 * Math.tan(25 * Math.PI / 180));
    close(F.projectionPriorScale(model(), projector()), base * ratio * ratio, "FOV 50 / distance 70");
    viewer.setCaptureLens({ fov_deg: 30, distance: 45 });
    resetRig();
});

test("missing and invalid markers are ignored and their joints stay fixed", () => {
    resetRig();
    const start = model();
    const points = F.projectFittingJoints(start, projector());
    const markers = [
        { id: "l_elbow", x: points.l_elbow.x + 20, y: points.l_elbow.y },
        { id: "l_wrist", x: NaN, y: points.l_wrist.y },
        { id: "r_wrist", x: points.r_wrist.x + 50, y: points.r_wrist.y, enabled: false },
        { id: "not_a_marker", x: 1, y: 2 },
    ];
    const result = F.solvePoseFitting(start, projector(), markers, { maxIterations: 40 });
    assert.equal(result.valid, true);
    assert.deepEqual(result.markers.map(item => item.id), ["l_elbow"]);
    assert.ok(!result.dofs.some(dof => dof.bone === "lowerarm_l" || dof.bone.endsWith("_r")));
    assert.deepEqual(F.changedBones(start, result.state).filter(name => name.endsWith("_r")), []);
    const empty = F.solvePoseFitting(start, projector(), [], {});
    assert.equal(empty.valid, true);
    assert.equal(empty.reason, "no-constraints");
});

test("solves are deterministic for identical inputs", () => {
    resetRig();
    const start = model();
    const points = F.projectFittingJoints(start, projector());
    const markers = [{ id: "r_wrist", x: points.r_wrist.x - 60, y: points.r_wrist.y + 30 }, { id: "r_elbow", x: points.r_elbow.x, y: points.r_elbow.y }];
    const a = F.solvePoseFitting(start, projector(), markers, { maxIterations: 30 });
    const b = F.solvePoseFitting(start, projector(), markers, { maxIterations: 30 });
    assert.equal(JSON.stringify(a.state), JSON.stringify(b.state));
    assert.equal(a.energy, b.energy);
});

test("stored fitting data is validated, clamped and backward compatible", () => {
    assert.equal(F.normalizeFittingState(undefined), null);
    assert.equal(F.normalizeFittingState({ markers: {} }), null, "data without points is dropped");
    assert.equal(F.normalizeFittingState([1, 2]), null);
    const state = F.normalizeFittingState({
        version: 99,
        markers: {
            l_wrist: { u: 0.5, v: "0.25", pinned: true, weight: 50, confidence: 2, depth: "sideways", extra: 1 },
            r_wrist: { u: null, v: 0.2, enabled: true },
            bogus: { u: 0.1, v: 0.1 },
        },
        settings: { scope: "galaxy", moveRoot: "yes", stiffness: 0, showMarkers: false },
        frame: { width: 1024, height: "768" },
        source: { type: "openpose", width: 512, height: 512, format: "COCO-18" },
        unknown: true,
    });
    assert.deepEqual(state.markers.l_wrist, { u: 0.5, v: 0.25, enabled: true, pinned: true, weight: 10, confidence: 1, depth: "auto" });
    assert.equal(state.markers.r_wrist.enabled, false, "a marker without coordinates cannot be enabled");
    assert.equal(state.markers.bogus, undefined);
    assert.deepEqual(state.settings, { scope: "limbs", moveRoot: false, stiffness: 0.05, showMarkers: false, autoRefit: false });
    assert.deepEqual(state.frame, { width: 1024, height: 768 });
    assert.equal(state.unknown, undefined);
    assert.deepEqual(Object.keys(state.markers), F.POSE_FITTING_MARKER_IDS);
});

test("OpenPose COCO-18 and BODY_25 keypoints become markers with subject left/right preserved", () => {
    const coco = new Array(18 * 3).fill(0);
    const set = (index, x, y, c = 0.9) => { coco[index * 3] = x; coco[index * 3 + 1] = y; coco[index * 3 + 2] = c; };
    set(0, 256, 100); set(1, 256, 160); set(2, 200, 165); set(3, 180, 240); set(4, 170, 300, 0.4);
    set(5, 312, 165); set(6, 330, 240); set(7, 0, 0, 0); // left wrist missing
    set(8, 225, 330); set(9, 220, 430); set(10, 222, 520); set(11, 287, 330); set(12, 292, 430); set(13, 290, 520, 0.02);
    const parsed = quiet(() => parseOpenPoseJSON({ people: [{ pose_keypoints_2d: coco }], canvas_width: 512, canvas_height: 768 }));
    const imported = F.fittingStateFromOpenPose(parsed, { frame: { width: 1024, height: 1536 } });
    const markers = imported.state.markers;
    assert.equal(imported.found, 12);
    assert.deepEqual([markers.r_shoulder.u, markers.r_shoulder.v], [200 / 512, 165 / 768]);
    assert.ok(markers.r_shoulder.u < markers.l_shoulder.u, "subject right is image left when facing the camera");
    assert.equal(markers.l_wrist.enabled, false, "missing (0, 0, 0) keypoint");
    assert.equal(markers.l_ankle.enabled, false, "below the confidence threshold");
    assert.equal(markers.r_wrist.confidence, 0.4);
    assert.equal(imported.warnings.length, 0, "matching aspect needs no warning");
    const stretched = F.fittingStateFromOpenPose(parsed, { frame: { width: 1024, height: 1024 } });
    assert.equal(stretched.warnings.length, 1);
    // BODY_25 uses index 8 for mid_hip; hips shift by one.
    const body25 = new Array(25 * 3).fill(0);
    for (let i = 0; i < 15; i++) { body25[i * 3] = 100 + i; body25[i * 3 + 1] = 200 + i; body25[i * 3 + 2] = 0.8; }
    const parsed25 = quiet(() => parseOpenPoseJSON({ people: [{ pose_keypoints_2d: body25 }], canvas_width: 512, canvas_height: 512 }));
    const markers25 = F.fittingStateFromOpenPose(parsed25, { frame: { width: 512, height: 512 } }).state.markers;
    assert.equal(markers25.r_hip.u, 109 / 512);
    assert.equal(markers25.l_ankle.u, 114 / 512);
    // Normalized keypoints are scaled by the canvas size.
    const normalized = F.fittingStateFromOpenPose({ joints: { neck: { x: 0.5, y: 0.25, c: 1 } }, canvasWidth: 640, canvasHeight: 480 }, { frame: { width: 640, height: 480 } });
    assert.equal(normalized.normalized, true);
    assert.deepEqual([normalized.state.markers.neck.u, normalized.state.markers.neck.v], [0.5, 0.25]);
});

test("an OpenPose figure rendered from the mannequin is fitted back on the correct limbs", () => {
    resetRig();
    setBones({ upperarm_r: [0.2, 0.3, -0.6], lowerarm_r: 0.9, upperarm_l: [0.1, -0.2, 0.9], lowerarm_l: 0.3, thigh_r: [-0.4, 0, 0], calf_r: 0.6 });
    const truth = F.projectFittingJoints(model(), projector());
    const order = ["head", "neck", "r_shoulder", "r_elbow", "r_wrist", "l_shoulder", "l_elbow", "l_wrist", "r_hip", "r_knee", "r_ankle", "l_hip", "l_knee", "l_ankle"];
    const coco = new Array(18 * 3).fill(0);
    order.forEach((id, index) => { coco[index * 3] = truth[id].x / 2; coco[index * 3 + 1] = truth[id].y / 2; coco[index * 3 + 2] = 0.95; });
    const parsed = quiet(() => parseOpenPoseJSON({ people: [{ pose_keypoints_2d: coco }], canvas_width: 512, canvas_height: 512 }));
    const state = F.fittingStateFromOpenPose(parsed, { frame: FRAME }).state;
    resetRig();
    const start = model();
    const result = F.solvePoseFitting(start, projector(), F.fittingStateToSolverMarkers(state, FRAME), { maxIterations: 120 });
    assert.ok(result.maxError < 1, `max ${result.maxError}`);
    const changed = F.changedBones(start, result.state);
    assert.ok(changed.includes("upperarm_r") && changed.includes("calf_r") && !changed.includes("calf_l"), changed.join(","));
});
