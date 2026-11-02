// 2D Pose Fitting hands: the L/R Hand markers (a point rigid on the hand that only
// turns the wrist), fingertip markers and their finger chains on the real MakeHuman
// rig, stage independence from the body solve, schema back-compatibility and
// OpenPose hands.
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
const OLD_BODY_IDS = F.POSE_FITTING_BODY_MARKER_IDS.filter(id => !F.POSE_FITTING_HAND_POINT_IDS.includes(id));

function resetRig({ zoom = 2.5, yaw = 0, pitch = 0 } = {}) {
    viewer.setPose({ bones: {} }, true);
    viewer.updateCaptureCamera(FRAME.width, FRAME.height, zoom, 0, 0, yaw, pitch);
    viewer.skinnedMesh.updateMatrixWorld(true);
}
/** The controller's model: hand points always, fingertip offsets and finger bones with Fingertips on. */
const model = (fingertips = true) => F.buildFittingModel(F.snapshotViewerRig(viewer, {
    ...F.viewerHandPointOffsets(viewer),
    ...(fingertips ? F.viewerFingerTipOffsets(viewer) : {}),
}, { fingertips }));
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
const curlMiddle = () => {
    for (const name of ["middle_01", "middle_02", "middle_03"]) viewer.bones[`${name}_l`].quaternion.set(...HAND_PRESETS.FIST.preset_l[name]);
    viewer.skinnedMesh.updateMatrixWorld(true);
};
const markersFrom = (points, ids) => ids.map(id => ({ id, x: points[id].x, y: points[id].y }));
const angleBetween = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180 / Math.PI;
const world = (m, id) => new THREE.Vector3(...F.projectFittingJoints(m, projector())[id].world);

test("fingertips are the distal bone tails; L/R Hand is the rest middle fingertip, rigid on the hand", () => {
    resetRig();
    const tips = F.viewerFingerTipOffsets(viewer);
    assert.deepEqual(Object.keys(tips).sort(), F.POSE_FITTING_MARKERS.filter(def => def.group === "hand").map(def => def.id).sort());
    const m = model();
    const joints = F.projectFittingJoints(m, projector());
    const tailOf = name => new THREE.Vector3(...viewer.bones[name].userData.tailPos).applyMatrix4(viewer.skinnedMesh.matrixWorld);
    for (const def of F.POSE_FITTING_MARKERS.filter(item => item.group === "hand")) {
        // At rest the tip sits exactly on the MakeHuman `<finger>_03____tail` joint.
        assert.ok(tailOf(def.bone).distanceTo(new THREE.Vector3(...joints[def.id].world)) < 1e-6, def.id);
    }
    // At rest the L/R Hand point is the middle fingertip too, with or without finger bones in the rig.
    for (const side of ["l", "r"]) {
        assert.ok(tailOf(`middle_03_${side}`).distanceTo(world(m, `${side}_hand`)) < 1e-6, `${side}_hand at rest`);
        assert.ok(tailOf(`middle_03_${side}`).distanceTo(world(model(false), `${side}_hand`)) < 1e-6, `${side}_hand without finger bones`);
    }
    // Curling the middle finger moves its tip but not the Hand point; turning the hand moves both.
    curlMiddle();
    assert.ok(world(model(), "l_middle_tip").distanceTo(world(m, "l_middle_tip")) > 0.3);
    assert.ok(world(model(), "l_hand").distanceTo(world(m, "l_hand")) < 1e-9, "the Hand point ignores the fingers");
    viewer.bones.hand_l.rotation.set(0.4, 0, 0);
    viewer.skinnedMesh.updateMatrixWorld(true);
    const expected = new THREE.Vector3(...F.viewerHandPointOffsets(viewer).l_hand).applyMatrix4(viewer.bones.hand_l.matrixWorld);
    assert.ok(expected.distanceTo(world(model(), "l_hand")) < 1e-6, "the Hand point is rigid in hand-bone space");
    resetRig();
    // The wrist gets the same anatomical frame without finger bones (knuckles come from the snapshot).
    const withFingers = boneOf(m, "hand_l"), bodyOnly = boneOf(model(false), "hand_l");
    for (const key of ["flex", "side"]) assert.ok(withFingers.limitAxes[key].every((value, k) => Math.abs(value - bodyOnly.limitAxes[key][k]) < 1e-12), key);
    assert.ok(withFingers.restDir.every((value, k) => Math.abs(value - bodyOnly.restDir[k]) < 1e-12));
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

test("Fingertips off keeps the original body-only rig; disabled Hand markers keep the solve exactly", () => {
    resetRig({ zoom: 1 });
    assert.deepEqual(F.POSE_FITTING_BODY_MARKER_IDS.length, 16);
    assert.ok(F.POSE_FITTING_HAND_POINT_IDS.every(id => F.POSE_FITTING_BODY_MARKER_IDS.includes(id)));
    const bodyModel = model(false);
    assert.deepEqual(bodyModel.bones.map(bone => bone.name), F.POSE_FITTING_RIG_BONES.filter(name => viewer.bones[name]));
    const handModel = model(true);
    assert.equal(handModel.bones.length, bodyModel.bones.length + FINGER_BONES.length);
    viewer.bones.upperarm_l.rotation.set(0.3, -0.2, 0.5);
    viewer.bones.lowerarm_r.rotation.set(0, 0.6, 0);
    viewer.skinnedMesh.updateMatrixWorld(true);
    const truth = F.projectFittingJoints(model(false), projector());
    resetRig({ zoom: 1 });
    const ids = ["l_elbow", "l_wrist", "r_elbow", "r_wrist", "neck"];
    const plain = F.solvePoseFitting(model(false), projector(), markersFrom(truth, ids), { maxIterations: 40 });
    // Data saved before the Hand markers existed gets them disabled at the current hand point.
    const current = F.projectFittingJoints(model(false), projector());
    const withDisabled = [...markersFrom(truth, ids), ...F.POSE_FITTING_HAND_POINT_IDS.map(id => ({ id, x: current[id].x, y: current[id].y, enabled: false }))];
    const same = F.solvePoseFitting(model(false), projector(), withDisabled, { maxIterations: 40 });
    const fingersModel = model(true);
    const withFingers = F.solvePoseFitting(fingersModel, projector(), markersFrom(truth, ids), { maxIterations: 40 });
    assert.ok(plain.maxError < 1);
    assert.deepEqual(same.state, plain.state, "disabled Hand markers change nothing");
    assert.equal(same.iterations, plain.iterations);
    for (const [i, bone] of model(false).bones.entries()) {
        const j = fingersModel.index.get(bone.name);
        assert.ok(plain.state.quaternions[i].every((value, k) => Math.abs(value - withFingers.state.quaternions[j][k]) < 1e-12), `${bone.name} identical`);
    }
    assert.ok(F.changedBones(fingersModel, withFingers.state).every(name => !FINGER_BONES.includes(name) && !/^hand_/.test(name)), "body markers never move fingers or hands");
    // Hidden fingertip markers keep their data but never reach the solver; L/R Hand always does.
    const state = F.createFittingState();
    state.markers.l_index_tip = { ...F.defaultFittingMarker(), u: 0.5, v: 0.5, enabled: true };
    state.markers.l_wrist = { ...F.defaultFittingMarker(), u: 0.4, v: 0.5, enabled: true };
    state.markers.l_hand = { ...F.defaultFittingMarker(), u: 0.45, v: 0.5, enabled: true };
    assert.deepEqual(F.fittingStateToSolverMarkers(state, FRAME).map(item => item.id), ["l_wrist", "l_hand"]);
    state.settings.fingertips = true;
    assert.deepEqual(F.fittingStateToSolverMarkers(state, FRAME).map(item => item.id), ["l_wrist", "l_hand", "l_index_tip"]);
    assert.deepEqual(F.visibleFittingMarkerIds({ fingertips: false }), F.POSE_FITTING_BODY_MARKER_IDS);
    assert.equal(F.visibleFittingMarkerIds({ fingertips: true }).length, 26);
    resetRig();
});

test("the L/R Hand marker turns only the hand, within wrist limits, with Fingertips off", () => {
    resetRig();
    const restModel = model(false);
    const hand = boneOf(restModel, "hand_l");
    // A wrist extension seen from the front: the hand turns in the image plane.
    viewer.bones.hand_l.quaternion.setFromAxisAngle(new THREE.Vector3(...hand.limitAxes.flex), -0.4);
    viewer.skinnedMesh.updateMatrixWorld(true);
    const truth = F.projectFittingJoints(model(false), projector());
    resetRig();
    const start = model(false);
    const result = F.solvePoseFitting(start, projector(), markersFrom(truth, ["l_elbow", "l_wrist", "l_hand"]), { maxIterations: 80 });
    assert.ok(result.markers.find(item => item.id === "l_hand").error < 1, JSON.stringify(result.markers));
    const report = F.measureJointLimits(start, result.state);
    assert.ok(Math.abs(report.joints.hand_l.flex + 0.4 * 180 / Math.PI) < 5, `hand flex ${report.joints.hand_l.flex}`);
    assert.deepEqual(F.changedBones(start, result.state), ["hand_l"], "only the wrist turns");
    assert.equal(result.stages.length, 2, "body stage, then the hand stage");

    // A target far behind the back of the hand: the wrist stops at its extension limit, the arm stays.
    const joints = F.projectFittingJoints(start, projector());
    const tip = joints.l_hand, wrist = joints.l_wrist;
    const extreme = { x: wrist.x - (tip.x - wrist.x) * 0.2 + (tip.y - wrist.y), y: wrist.y - (tip.y - wrist.y) * 0.2 - (tip.x - wrist.x) };
    const limited = F.solvePoseFitting(start, projector(), [...markersFrom(joints, ["l_elbow", "l_wrist"]), { id: "l_hand", ...extreme }], { maxIterations: 80 });
    const limitedReport = F.measureJointLimits(start, limited.state);
    assert.ok(limited.valid && limitedReport.joints.hand_l.violation < 1.5, JSON.stringify(limitedReport.joints.hand_l));
    assert.deepEqual(F.changedBones(start, limited.state), ["hand_l"], "the wrist marker keeps the arm");
    resetRig();
});

test("with Fingertips on the Hand marker turns the hand and the middle tip only bends its finger", () => {
    // Truth: wrist flexed and the middle finger curled.
    resetRig({ yaw: 15 });
    const restHand = boneOf(model(), "hand_l");
    viewer.bones.hand_l.quaternion.setFromAxisAngle(new THREE.Vector3(...restHand.limitAxes.flex), 0.3);
    curlMiddle();
    const truth = F.projectFittingJoints(model(), projector());
    const truthHand = viewer.bones.hand_l.quaternion.toArray();
    resetRig({ yaw: 15 });
    const start = model();
    const result = F.solvePoseFitting(start, projector(), markersFrom(truth, ["l_elbow", "l_wrist", "l_hand", "l_middle_tip"]), { maxIterations: 120 });
    const errors = Object.fromEntries(result.markers.map(item => [item.id, item.error]));
    assert.ok(errors.l_hand < 1.5 && errors.l_middle_tip < 2, JSON.stringify(errors));
    assert.ok(angleBetween(result.state.quaternions[start.index.get("hand_l")], truthHand) < 6, "the hand follows the Hand marker");
    assert.ok(F.changedBones(start, result.state).every(name => name === "hand_l" || /^middle_0[123]_l$/.test(name)), F.changedBones(start, result.state).join());
    assert.equal(result.stages.length, 3, "body, hand and finger stages run in order");

    // The middle tip alone never turns the hand: a curled tip just curls the finger.
    resetRig();
    curlMiddle();
    const curled = F.projectFittingJoints(model(), projector());
    resetRig();
    const fist = F.solvePoseFitting(start, projector(), markersFrom(curled, ["l_wrist", "l_middle_tip"]), { maxIterations: 120 });
    assert.ok(F.changedBones(start, fist.state).every(name => FINGER_BONES.includes(name)), "fingertips never move the hand");
    assert.ok(fist.markers.find(item => item.id === "l_middle_tip").error < 1.5);
    resetRig();
});

test("fingertip markers recover curled finger chains with limits respected and the wrist fixed", () => {
    for (const [label, setup] of [
        ["half fist", () => applyPreset(HAND_PRESETS.FIST, "l", 0.6)],
        ["middle fist", curlMiddle],
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
        // A stiff sideways MCP prior keeps fingers from splaying; a wide chop splay keeps up to ~3 px.
        assert.ok(LEFT_TIPS.every(id => errors[id] < 3), `${label}: ${JSON.stringify(errors)}`);
        const limits = F.measureJointLimits(start, result.state);
        assert.ok(limits.maxViolation < 1, `${label}: limit violation ${limits.maxViolation}`);
        const after = F.projectFittingJoints(start, projector(), result.state).l_wrist;
        assert.ok(Math.hypot(after.x - wristBefore.x, after.y - wristBefore.y) < 1e-9, `${label}: fingertips never move the wrist`);
        assert.ok(F.changedBones(start, result.state).every(name => FINGER_BONES.includes(name)), `${label}: only fingers change`);
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

test("version 1 and 2 fitting data load: old marker sets stay as saved, only \"all\" turns Fingertips on", () => {
    // Exactly what the 14-marker version saved.
    const v1 = {
        version: 1,
        markers: Object.fromEntries(OLD_BODY_IDS.map((id, i) => [id, { u: 0.1 + i * 0.05, v: 0.2 + i * 0.03, enabled: i !== 3, pinned: i === 5, weight: 1 + i / 10, confidence: 0.9, depth: i === 4 ? "near" : "auto" }])),
        settings: { scope: "body", moveRoot: true, stiffness: 2, showMarkers: true, autoRefit: true },
        frame: { width: 1024, height: 768 },
        source: { type: "openpose", width: 512, height: 384, format: "COCO-18" },
    };
    const state = F.normalizeFittingState(JSON.parse(JSON.stringify(v1)));
    for (const id of OLD_BODY_IDS) assert.deepEqual(state.markers[id], v1.markers[id], id);
    assert.deepEqual(state.settings, { ...v1.settings, fingertips: false });
    assert.deepEqual(state.frame, v1.frame);
    assert.deepEqual(state.source, v1.source);
    assert.equal(state.version, F.POSE_FITTING_VERSION);
    // Hand markers are unplaced (the controller fills them disabled at the hand point); nothing new is solved.
    for (const id of [...F.POSE_FITTING_HAND_POINT_IDS, ...F.POSE_FITTING_MARKER_IDS.filter(id => id.endsWith("_tip"))]) {
        assert.deepEqual(state.markers[id], F.defaultFittingMarker(), id);
    }
    assert.deepEqual(F.fittingStateToSolverMarkers(state, FRAME).map(item => item.id), OLD_BODY_IDS);
    // Version 2 hand modes: "all" showed every fingertip; "middle" and "off" become Fingertips off.
    for (const [mode, fingertips] of [["all", true], ["middle", false], ["off", false], ["toes", false]]) {
        const v2 = { version: 2, markers: { l_wrist: { u: 0.5, v: 0.5 }, l_middle_tip: { u: 0.52, v: 0.6 } }, settings: { handMarkers: mode } };
        const loaded = F.normalizeFittingState(v2);
        assert.equal(loaded.settings.fingertips, fingertips, mode);
        assert.equal(loaded.settings.handMarkers, undefined);
        assert.deepEqual([loaded.markers.l_middle_tip.u, loaded.markers.l_middle_tip.v], [0.52, 0.6], "fingertip data is kept");
    }
    // Version 3 round-trips.
    state.settings.fingertips = true;
    state.markers.r_middle_tip = { u: 0.61, v: 0.42, enabled: true, pinned: true, weight: 2, confidence: 0.8, depth: "far" };
    state.markers.l_hand = { u: 0.55, v: 0.47, enabled: true, pinned: false, weight: 1.5, confidence: 1, depth: "near" };
    assert.deepEqual(F.normalizeFittingState(JSON.parse(JSON.stringify(state))), state);
    // Data with only fingertip points is still usable.
    assert.ok(F.normalizeFittingState({ markers: { l_thumb_tip: { u: 0.3, v: 0.3 } } }));
});

test("OpenPose hands: fingertips from 4/8/12/16/20, L/R Hand along the wrist -> middle knuckle line", () => {
    const body = new Array(18 * 3).fill(0);
    const set = (index, x, y, c = 0.9) => { body[index * 3] = x; body[index * 3 + 1] = y; body[index * 3 + 2] = c; };
    set(0, 256, 100); set(1, 256, 160); set(2, 200, 165); set(4, 170, 300); set(5, 312, 165); set(7, 340, 300);
    const hand = (x0, y0, missing = -1) => {
        const points = new Array(21 * 3).fill(0);
        for (let i = 0; i < 21; i++) {
            points[i * 3] = x0 + i; points[i * 3 + 1] = y0 + 2 * i; points[i * 3 + 2] = i === missing ? 0 : (i === 9 ? 0.7 : 0.8);
        }
        return points;
    };
    const json = { people: [{ pose_keypoints_2d: body, hand_left_keypoints_2d: hand(340, 300), hand_right_keypoints_2d: hand(170, 300, 16) }], canvas_width: 512, canvas_height: 512 };
    const imported = F.fittingStateFromOpenPose(quiet(() => parseOpenPoseJSON(json)), { frame: FRAME });
    const markers = imported.state.markers;
    assert.equal(imported.handFound, 9, "the right ring tip (index 16) is missing");
    assert.equal(imported.state.settings.fingertips, true, "hand keypoints switch Fingertips on");
    const tips = { thumb: 4, index: 8, middle: 12, ring: 16, pinky: 20 };
    for (const [finger, index] of Object.entries(tips)) {
        // OpenPose hand_left is the subject's left hand, like the `_l` bones.
        assert.deepEqual([markers[`l_${finger}_tip`].u, markers[`l_${finger}_tip`].v], [(340 + index) / 512, (300 + 2 * index) / 512]);
        assert.equal(markers[`l_${finger}_tip`].confidence, 0.8);
        if (finger !== "ring") assert.deepEqual([markers[`r_${finger}_tip`].u, markers[`r_${finger}_tip`].v], [(170 + index) / 512, (300 + 2 * index) / 512]);
    }
    assert.equal(markers.r_ring_tip.u, null);
    assert.equal(markers.r_ring_tip.enabled, false);
    // L Hand: never keypoint 12 (a curled middle finger would tilt the hand); wrist 0 + 1.8 x (knuckle 9 - wrist 0) by default.
    assert.equal(imported.handPointFound, 2);
    assert.ok(Math.abs(markers.l_hand.u - (340 + 1.8 * 9) / 512) < 1e-12 && Math.abs(markers.l_hand.v - (300 + 1.8 * 18) / 512) < 1e-12);
    assert.equal(markers.l_hand.enabled, true);
    assert.equal(markers.l_hand.confidence, 0.7, "the weaker of the two keypoints");
    // With the current pose's image relation the hand point lands exactly where the rig would put it.
    resetRig({ yaw: 30, pitch: -10 });
    viewer.bones.hand_l.rotation.set(0.3, 0.2, -0.4);
    viewer.skinnedMesh.updateMatrixWorld(true);
    const m = model(false);
    const relations = F.handPointImageRelation(m, projector());
    const worldMatrix = F.forwardKinematics(m);
    const e = worldMatrix[m.index.get("hand_l")];
    const knuckle = m.markers[m.markerIndex.get("l_knuckle")].offset;
    const w = projector().project([e[12], e[13], e[14]]);
    const k = projector().project([0, 1, 2].map(r => e[r] * knuckle[0] + e[r + 4] * knuckle[1] + e[r + 8] * knuckle[2] + e[r + 12]));
    const keypoints = new Array(21 * 3).fill(0);
    Object.assign(keypoints, { 0: w.x, 1: w.y, 2: 0.9, 27: k.x, 28: k.y, 29: 0.9 });
    const exact = F.fittingStateFromOpenPose(quiet(() => parseOpenPoseJSON({ people: [{ pose_keypoints_2d: body, hand_left_keypoints_2d: keypoints }], canvas_width: 1024, canvas_height: 1024 })), { frame: FRAME, handRelations: relations });
    const truth = F.projectFittingJoints(m, projector()).l_hand;
    assert.ok(Math.hypot(exact.state.markers.l_hand.u * 1024 - truth.x, exact.state.markers.l_hand.v * 1024 - truth.y) < 1e-6);
    resetRig();
    // Body-only: no hand markers placed, Fingertips stays off.
    const bodyOnly = F.fittingStateFromOpenPose(quiet(() => parseOpenPoseJSON({ people: [{ pose_keypoints_2d: body }], canvas_width: 512, canvas_height: 512 })), { frame: FRAME });
    assert.equal(bodyOnly.handFound, 0);
    assert.equal(bodyOnly.handPointFound, 0);
    assert.equal(bodyOnly.found, 6);
    assert.equal(bodyOnly.state.settings.fingertips, false);
    assert.ok([...F.POSE_FITTING_HAND_POINT_IDS, ...LEFT_TIPS].every(id => bodyOnly.state.markers[id].u === null));
});
