// 2D Pose Fitting fingertip markers: hand frames and limits on the real MakeHuman
// rig, finger chain recovery, hand orientation from the middle fingertip, stage
// independence from the body solve, schema back-compatibility and OpenPose hands.
import assert from "node:assert/strict";
import test from "node:test";
import { createScene } from "./helpers/pose_studio_scene.mjs";
import { parseOpenPoseJSON } from "../web/pose_studio/imports/openpose.js";
import { HAND_PRESETS } from "../web/pose_studio/hand_presets.js";
import * as F from "../web/pose_studio/pose_fitting2d.mjs";

const FRAME = { width: 1024, height: 1024 };
const scene = createScene({ skinned: true });
const { viewer, THREE } = scene;
const quiet = fn => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };
const FINGER_BONES = F.POSE_FITTING_FINGER_BONES;
const LEFT_TIPS = F.POSE_FITTING_FINGERS.map(finger => `l_${finger}_tip`);

function resetRig({ zoom = 2.5, yaw = 0, pitch = 0 } = {}) {
    viewer.setPose({ bones: {} }, true);
    viewer.updateCaptureCamera(FRAME.width, FRAME.height, zoom, 0, 0, yaw, pitch);
    viewer.skinnedMesh.updateMatrixWorld(true);
}
const model = (handMarkers = "all") => F.buildFittingModel(F.snapshotViewerRig(viewer, F.viewerFingerTipOffsets(viewer), { handMarkers }));
const projector = () => F.captureCameraProjector(viewer.captureCamera, FRAME.width, FRAME.height);
const boneOf = (m, name) => m.bones[m.index.get(name)];
function applyPreset(preset, side, amount = 1) {
    const data = side === "r" ? preset.preset_r : preset.preset_l;
    for (const [name, q] of Object.entries(data)) {
        const bone = viewer.bones[`${name}_${side}`];
        if (bone) bone.quaternion.slerp(new THREE.Quaternion(...q), amount);
    }
    viewer.skinnedMesh.updateMatrixWorld(true);
}
const markersFrom = (points, ids) => ids.map(id => ({ id, x: points[id].x, y: points[id].y }));
const angleBetween = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180 / Math.PI;

test("fingertips are the distal bone tails and hands get mirrored anatomical frames", () => {
    resetRig();
    const tips = F.viewerFingerTipOffsets(viewer);
    assert.deepEqual(Object.keys(tips).sort(), F.POSE_FITTING_MARKERS.filter(def => def.group === "hand").map(def => def.id).sort());
    const m = model();
    const joints = F.projectFittingJoints(m, projector());
    for (const def of F.POSE_FITTING_MARKERS.filter(item => item.group === "hand")) {
        // At rest the tip sits exactly on the MakeHuman `<finger>_03____tail` joint.
        const tail = new THREE.Vector3(...viewer.bones[def.bone].userData.tailPos).applyMatrix4(viewer.skinnedMesh.matrixWorld);
        assert.ok(tail.distanceTo(new THREE.Vector3(...joints[def.id].world)) < 1e-6, def.id);
    }
    // The tip follows the distal bone when the finger bends.
    viewer.bones.index_03_l.rotation.set(0.7, 0, 0);
    viewer.skinnedMesh.updateMatrixWorld(true);
    const bent = F.projectFittingJoints(model(), projector()).l_index_tip.world;
    const expected = new THREE.Vector3(...tips.l_index_tip).applyMatrix4(viewer.bones.index_03_l.matrixWorld);
    assert.ok(expected.distanceTo(new THREE.Vector3(...bent)) < 1e-6);
    resetRig();
    // Left and right frames are mirror images (x flipped) and finger hinges bend toward the palm.
    for (const finger of F.POSE_FITTING_FINGERS) {
        for (const segment of ["02", "03"]) {
            const l = boneOf(m, `${finger}_${segment}_l`).hingeAxis, r = boneOf(m, `${finger}_${segment}_r`).hingeAxis;
            assert.ok(Math.abs(l[0] - r[0]) < 1e-6 && Math.abs(l[1] + r[1]) < 1e-6 && Math.abs(l[2] + r[2]) < 1e-6, `${finger}_${segment} mirrored`);
        }
    }
    // The rest pose and the built-in hand presets (open, chop, fist) are inside the limits.
    assert.ok(F.measureJointLimits(m).maxViolation < 1e-6, "rest pose");
    for (const [name, preset] of Object.entries(HAND_PRESETS)) {
        resetRig();
        applyPreset(preset, "l");
        applyPreset(preset, "r");
        const report = F.measureJointLimits(model());
        assert.ok(report.maxViolation < 0.5, `${name}: ${report.maxViolation}`);
        if (name === "FIST") {
            for (const finger of ["index", "middle", "ring", "pinky"]) {
                assert.ok(report.joints[`${finger}_02_l`].flex > 40 && report.joints[`${finger}_01_l`].flex > 30, `${name} ${finger} flexes toward the palm`);
            }
        }
    }
    resetRig();
});

test("hand markers off keeps the original body-only rig and solve exactly", () => {
    resetRig({ zoom: 1 });
    const bodyModel = model("off");
    assert.deepEqual(bodyModel.bones.map(bone => bone.name), F.POSE_FITTING_RIG_BONES.filter(name => viewer.bones[name]));
    const handModel = model("all");
    assert.equal(handModel.bones.length, bodyModel.bones.length + FINGER_BONES.length);
    viewer.bones.upperarm_l.rotation.set(0.3, -0.2, 0.5);
    viewer.bones.lowerarm_r.rotation.set(0, 0.6, 0);
    viewer.skinnedMesh.updateMatrixWorld(true);
    const truth = F.projectFittingJoints(model("off"), projector());
    resetRig({ zoom: 1 });
    const ids = ["l_elbow", "l_wrist", "r_elbow", "r_wrist", "neck"];
    const a = F.solvePoseFitting(model("off"), projector(), markersFrom(truth, ids), { maxIterations: 40 });
    const fingersModel = model("all");
    const b = F.solvePoseFitting(fingersModel, projector(), markersFrom(truth, ids), { maxIterations: 40 });
    assert.ok(a.maxError < 1);
    for (const [i, bone] of model("off").bones.entries()) {
        const j = fingersModel.index.get(bone.name);
        assert.ok(a.state.quaternions[i].every((value, k) => Math.abs(value - b.state.quaternions[j][k]) < 1e-12), `${bone.name} identical`);
    }
    assert.ok(F.changedBones(fingersModel, b.state).every(name => !FINGER_BONES.includes(name) && !/^hand_/.test(name)), "body markers never move fingers or hands");
    // Hidden fingertip markers keep their data but never reach the solver.
    const state = F.createFittingState();
    state.markers.l_index_tip = { ...F.defaultFittingMarker(), u: 0.5, v: 0.5, enabled: true };
    state.markers.l_wrist = { ...F.defaultFittingMarker(), u: 0.4, v: 0.5, enabled: true };
    assert.deepEqual(F.fittingStateToSolverMarkers(state, FRAME).map(item => item.id), ["l_wrist"]);
    state.settings.handMarkers = "middle";
    assert.deepEqual(F.fittingStateToSolverMarkers(state, FRAME).map(item => item.id), ["l_wrist"]);
    state.settings.handMarkers = "all";
    assert.deepEqual(F.fittingStateToSolverMarkers(state, FRAME).map(item => item.id), ["l_wrist", "l_index_tip"]);
    assert.deepEqual(F.visibleFittingMarkerIds({ handMarkers: "middle" }).slice(14), ["l_middle_tip", "r_middle_tip"]);
    resetRig();
});

test("fingertip markers recover curled finger chains with limits respected and the wrist fixed", () => {
    for (const [label, setup] of [
        ["half fist", () => applyPreset(HAND_PRESETS.FIST, "l", 0.6)],
        ["middle fist", () => { for (const name of ["middle_01", "middle_02", "middle_03"]) viewer.bones[`${name}_l`].quaternion.set(...HAND_PRESETS.FIST.preset_l[name]); }],
        ["chop", () => applyPreset(HAND_PRESETS.CHOP, "l")],
    ]) {
        resetRig({ yaw: 20 });
        setup();
        viewer.skinnedMesh.updateMatrixWorld(true);
        const truth = F.projectFittingJoints(model(), projector());
        resetRig({ yaw: 20 });
        const start = model();
        const wristBefore = F.projectFittingJoints(start, projector()).l_wrist;
        const result = F.solvePoseFitting(start, projector(), markersFrom(truth, ["l_wrist", ...LEFT_TIPS]), { maxIterations: 120 });
        assert.ok(result.valid);
        const errors = Object.fromEntries(result.markers.map(item => [item.id, item.error]));
        const moved = LEFT_TIPS.filter(id => Math.hypot(truth[id].x - wristBefore.x, truth[id].y - wristBefore.y) > 0);
        // A stiff sideways MCP prior keeps fingers from splaying; a wide chop splay keeps up to ~3 px.
        assert.ok(moved.every(id => errors[id] < 3), `${label}: ${JSON.stringify(errors)}`);
        const limits = F.measureJointLimits(start, result.state);
        assert.ok(limits.maxViolation < 1, `${label}: limit violation ${limits.maxViolation}`);
        const after = F.projectFittingJoints(start, projector(), result.state).l_wrist;
        assert.ok(Math.hypot(after.x - wristBefore.x, after.y - wristBefore.y) < 1e-9, `${label}: fingertips never move the wrist`);
        assert.ok(F.changedBones(start, result.state).every(name => FINGER_BONES.includes(name) || name === "hand_l"), `${label}: only the hand changes`);
    }
    resetRig();
});

test("random fingertip targets never bend fingers backwards or sideways past their limits", () => {
    resetRig({ yaw: -25, pitch: 10 });
    const start = model();
    const p = projector();
    const rest = F.projectFittingJoints(start, p);
    let seed = 11;
    const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    for (let trial = 0; trial < 8; trial++) {
        const markers = LEFT_TIPS.map(id => ({ id, x: rest[id].x + random() * 120, y: rest[id].y + random() * 120 }));
        const result = F.solvePoseFitting(start, p, markers, { maxIterations: 60 });
        assert.ok(result.valid);
        const report = F.measureJointLimits(start, result.state);
        for (const finger of F.POSE_FITTING_FINGERS) {
            const [mcp, pip, dip] = ["01", "02", "03"].map(segment => report.joints[`${finger}_${segment}_l`]);
            const spec = segment => F.POSE_FITTING_JOINTS[`${finger}_${segment}_l`];
            assert.ok(pip.flex >= spec("02").flex[0] - 1e-6 && pip.flex <= spec("02").flex[1] + 1e-6, `${finger} PIP ${pip.flex}`);
            assert.ok(dip.flex >= spec("03").flex[0] - 1e-6 && dip.flex <= spec("03").flex[1] + 1e-6, `${finger} DIP ${dip.flex}`);
            assert.ok(Math.abs(mcp.side) <= spec("01").limits.side[1] + 3, `${finger} MCP sideways ${mcp.side}`);
            assert.ok(mcp.flex >= spec("01").limits.flex[0] - 3, `${finger} MCP hyperextension ${mcp.flex}`);
        }
    }
    resetRig();
});

test("the middle fingertip turns the hand toward it within wrist limits; curled tips leave the hand alone", () => {
    resetRig();
    const restModel = model();
    const hand = boneOf(restModel, "hand_l");
    // A wrist extension seen from the front: the hand turns in the image plane.
    viewer.bones.hand_l.quaternion.setFromAxisAngle(new THREE.Vector3(...hand.limitAxes.flex), -0.4);
    viewer.skinnedMesh.updateMatrixWorld(true);
    const truth = F.projectFittingJoints(model(), projector());
    resetRig();
    const start = model();
    const result = F.solvePoseFitting(start, projector(), markersFrom(truth, ["l_wrist", "l_middle_tip"]), { maxIterations: 80 });
    assert.ok(result.markers.find(item => item.id === "l_middle_tip").error < 1.5, JSON.stringify(result.markers));
    const report = F.measureJointLimits(start, result.state);
    assert.ok(Math.abs(report.joints.hand_l.flex + 0.4 * 180 / Math.PI) < 5, `hand flex ${report.joints.hand_l.flex}`);
    for (const segment of ["02", "03"]) assert.ok(Math.abs(report.joints[`middle_${segment}_l`].flex - F.measureJointLimits(start).joints[`middle_${segment}_l`].flex) < 8, "the finger stays almost straight");
    assert.ok(result.stages.length === 3, "body, hand aim and finger stages run in order");

    // A target far behind the back of the hand: the wrist stops at its extension limit.
    const tip = F.projectFittingJoints(start, projector()).l_middle_tip;
    const wrist = F.projectFittingJoints(start, projector()).l_wrist;
    const extreme = { x: wrist.x - (tip.x - wrist.x) * 0.2 + (tip.y - wrist.y), y: wrist.y - (tip.y - wrist.y) * 0.2 - (tip.x - wrist.x) };
    const limited = F.solvePoseFitting(start, projector(), [{ id: "l_wrist", x: wrist.x, y: wrist.y }, { id: "l_middle_tip", ...extreme }], { maxIterations: 80 });
    const limitedReport = F.measureJointLimits(start, limited.state);
    assert.ok(limited.valid && limitedReport.joints.hand_l.violation < 1.5, JSON.stringify(limitedReport.joints.hand_l));

    // A tip curled back toward the wrist says nothing about the hand direction: the finger curls instead.
    resetRig();
    for (const name of ["middle_01", "middle_02", "middle_03"]) viewer.bones[`${name}_l`].quaternion.set(...HAND_PRESETS.FIST.preset_l[name]);
    viewer.skinnedMesh.updateMatrixWorld(true);
    const curled = F.projectFittingJoints(model(), projector());
    resetRig();
    const fist = F.solvePoseFitting(start, projector(), markersFrom(curled, ["l_wrist", "l_middle_tip"]), { maxIterations: 120 });
    assert.ok(angleBetween(fist.state.quaternions[start.index.get("hand_l")], start.bones[start.index.get("hand_l")].quaternion) < 2, "the hand keeps its rotation");
    assert.ok(fist.markers.find(item => item.id === "l_middle_tip").error < 1.5);
    resetRig();
});

test("version 1 fitting data loads unchanged and version 2 hand data round-trips", () => {
    // Exactly what the 14-marker version saved.
    const v1 = {
        version: 1,
        markers: Object.fromEntries(F.POSE_FITTING_BODY_MARKER_IDS.map((id, i) => [id, { u: 0.1 + i * 0.05, v: 0.2 + i * 0.03, enabled: i !== 3, pinned: i === 5, weight: 1 + i / 10, confidence: 0.9, depth: i === 4 ? "near" : "auto" }])),
        settings: { scope: "body", moveRoot: true, stiffness: 2, showMarkers: true, autoRefit: true },
        frame: { width: 1024, height: 768 },
        source: { type: "openpose", width: 512, height: 384, format: "COCO-18" },
    };
    const state = F.normalizeFittingState(JSON.parse(JSON.stringify(v1)));
    for (const id of F.POSE_FITTING_BODY_MARKER_IDS) assert.deepEqual(state.markers[id], v1.markers[id], id);
    assert.deepEqual(state.settings, { ...v1.settings, handMarkers: "off" }, "old data keeps the 14-marker workflow");
    assert.deepEqual(state.frame, v1.frame);
    assert.deepEqual(state.source, v1.source);
    assert.equal(state.version, F.POSE_FITTING_VERSION);
    for (const id of F.POSE_FITTING_MARKER_IDS.slice(14)) assert.deepEqual(state.markers[id], F.defaultFittingMarker());
    assert.deepEqual(F.fittingStateToSolverMarkers(state, FRAME).map(item => item.id), F.POSE_FITTING_BODY_MARKER_IDS);
    // Version 2: fingertips and the hand mode survive a save / load cycle.
    state.settings.handMarkers = "middle";
    state.markers.r_middle_tip = { u: 0.61, v: 0.42, enabled: true, pinned: true, weight: 2, confidence: 0.8, depth: "far" };
    const again = F.normalizeFittingState(JSON.parse(JSON.stringify(state)));
    assert.deepEqual(again, state);
    assert.equal(F.normalizeFittingState({ settings: { handMarkers: "toes" }, markers: { l_wrist: { u: 0.5, v: 0.5 } } }).settings.handMarkers, "off");
    // Data with only fingertip points is still usable.
    assert.ok(F.normalizeFittingState({ markers: { l_thumb_tip: { u: 0.3, v: 0.3 } } }));
});

test("OpenPose hand keypoints map onto fingertip markers; body-only files are unchanged", () => {
    const body = new Array(18 * 3).fill(0);
    const set = (index, x, y, c = 0.9) => { body[index * 3] = x; body[index * 3 + 1] = y; body[index * 3 + 2] = c; };
    set(0, 256, 100); set(1, 256, 160); set(2, 200, 165); set(4, 170, 300); set(5, 312, 165); set(7, 340, 300);
    const hand = (x0, y0, missing = -1) => {
        const points = new Array(21 * 3).fill(0);
        for (let i = 0; i < 21; i++) {
            points[i * 3] = x0 + i; points[i * 3 + 1] = y0 + 2 * i; points[i * 3 + 2] = i === missing ? 0 : 0.8;
        }
        return points;
    };
    const parsed = quiet(() => parseOpenPoseJSON({
        people: [{ pose_keypoints_2d: body, hand_left_keypoints_2d: hand(340, 300), hand_right_keypoints_2d: hand(170, 300, 16) }],
        canvas_width: 512, canvas_height: 512,
    }));
    const imported = F.fittingStateFromOpenPose(parsed, { frame: FRAME });
    const markers = imported.state.markers;
    assert.equal(imported.handFound, 9, "the right ring tip (index 16) is missing");
    assert.equal(imported.state.settings.handMarkers, "all", "hand keypoints switch the fingertip markers on");
    const tips = { thumb: 4, index: 8, middle: 12, ring: 16, pinky: 20 };
    for (const [finger, index] of Object.entries(tips)) {
        // OpenPose hand_left is the subject's left hand, like the `_l` bones.
        assert.deepEqual([markers[`l_${finger}_tip`].u, markers[`l_${finger}_tip`].v], [(340 + index) / 512, (300 + 2 * index) / 512]);
        assert.equal(markers[`l_${finger}_tip`].confidence, 0.8);
        if (finger !== "ring") assert.deepEqual([markers[`r_${finger}_tip`].u, markers[`r_${finger}_tip`].v], [(170 + index) / 512, (300 + 2 * index) / 512]);
    }
    assert.equal(markers.r_ring_tip.u, null);
    assert.equal(markers.r_ring_tip.enabled, false);
    assert.ok(F.fittingStateToSolverMarkers(imported.state, FRAME).some(item => item.id === "l_index_tip"));
    // Body-only: no fingertips, the mode stays as it was.
    const bodyOnly = F.fittingStateFromOpenPose(quiet(() => parseOpenPoseJSON({ people: [{ pose_keypoints_2d: body }], canvas_width: 512, canvas_height: 512 })), { frame: FRAME });
    assert.equal(bodyOnly.handFound, 0);
    assert.equal(bodyOnly.found, 6);
    assert.equal(bodyOnly.state.settings.handMarkers, "off");
    assert.ok(F.POSE_FITTING_MARKER_IDS.slice(14).every(id => bodyOnly.state.markers[id].u === null));
});
