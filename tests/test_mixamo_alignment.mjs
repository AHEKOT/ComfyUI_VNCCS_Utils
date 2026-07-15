import assert from "node:assert/strict";
import test from "node:test";

import * as THREE from "../web/three.module.js";
import { buildMixamoWorldKeypoints } from "../web/vnccs_mixamo_import.js";
import { PoseViewerCore } from "../web/vnccs_pose_studio_core.js";

const pointBone = (position) => ({
    position: new THREE.Vector3(...position),
    getWorldPosition(target) {
        return target.copy(this.position);
    },
});

const sourcePositions = {
    Hips: [0, 1, 0], Neck: [0, 2, 0], Head: [0, 2.3, 0],
    LeftArm: [0.3, 1.9, 0], LeftForeArm: [0.8, 1.7, 0], LeftHand: [1.2, 1.6, 0],
    RightArm: [-0.3, 1.9, 0], RightForeArm: [-0.8, 1.7, 0], RightHand: [-1.2, 1.6, 0],
    LeftUpLeg: [0.2, 1, 0], LeftLeg: [0.2, 0.55, 0.05], LeftFoot: [0.2, 0.1, 0.05], LeftToeBase: [0.2, 0.05, 0.35],
    RightUpLeg: [-0.2, 1, 0], RightLeg: [-0.2, 0.55, 0.05], RightFoot: [-0.2, 0.1, 0.05], RightToeBase: [-0.2, 0.05, 0.35],
};

for (const [side, sign] of [["Left", 1], ["Right", -1]]) {
    for (const [fingerIndex, finger] of ["Thumb", "Index", "Middle", "Ring", "Pinky"].entries()) {
        for (let joint = 1; joint <= 3; joint++) {
            sourcePositions[`${side}Hand${finger}${joint}`] = [
                sign * (1.2 + joint * 0.08),
                1.55 + (2 - fingerIndex) * 0.015,
                fingerIndex * 0.025,
            ];
        }
    }
}

const restPositions = {
    pelvis: [0, 1, 0], neck_01: [0, 2, 0], head: [0, 2.3, 0],
    upperarm_l: [0.3, 1.9, 0], lowerarm_l: [0.8, 1.7, 0], hand_l: [1.2, 1.6, 0],
    upperarm_r: [-0.3, 1.9, 0], lowerarm_r: [-0.8, 1.7, 0], hand_r: [-1.2, 1.6, 0],
    thigh_l: [0.2, 1, 0], calf_l: [0.2, 0.55, 0], foot_l: [0.2, 0.1, 0], ball_l: [0.2, 0.05, 0.3],
    thigh_r: [-0.2, 1, 0], calf_r: [-0.2, 0.55, 0], foot_r: [-0.2, 0.1, 0], ball_r: [-0.2, 0.05, 0.3],
};

for (const side of ["l", "r"]) {
    const sign = side === "l" ? 1 : -1;
    for (const [fingerIndex, finger] of ["thumb", "index", "middle", "ring", "pinky"].entries()) {
        for (let joint = 1; joint <= 3; joint++) {
            restPositions[`${finger}_0${joint}_${side}`] = [
                sign * (1.2 + joint * 0.08),
                1.55 + (2 - fingerIndex) * 0.015,
                fingerIndex * 0.025,
            ];
        }
    }
}

test("Mixamo landmarks cover limbs, fingers, and toe bases", () => {
    const bones = Object.fromEntries(Object.entries(sourcePositions).map(([name, point]) => [name, pointBone(point)]));
    const viewer = {
        THREE,
        _getBoneWorldPositionForImport(name) {
            const point = restPositions[name];
            return point ? new THREE.Vector3(...point) : null;
        },
        _relaxSAM3DShoulderTargets() {},
    };

    const result = buildMixamoWorldKeypoints({ bones, normalizedBones: {} }, viewer);
    assert.ok(result?.worldKps);
    for (const name of [
        "pelvis", "neck", "left_shoulder", "right_shoulder",
        "left_elbow", "right_elbow", "left_wrist", "right_wrist",
        "left_hip", "right_hip", "left_knee", "right_knee",
        "left_ankle", "right_ankle", "left_big_toe", "right_big_toe",
    ]) assert.ok(result.worldKps[name], `missing ${name}`);

    const fingerPoints = Object.keys(result.worldKps).filter(name => /^(thumb|index|middle|ring|pinky)_0[1-3]_[lr]$/.test(name));
    assert.equal(fingerPoints.length, 30);
});

test("world-keypoint import uses the shared image alignment stages", () => {
    const calls = [];
    const viewer = Object.create(PoseViewerCore.prototype);
    viewer.bones = {};
    viewer.skinnedMesh = { updateMatrixWorld: () => calls.push("mesh") };
    viewer.ikController = {};
    viewer.skeleton = { update: () => calls.push("skeleton") };
    viewer._buildSAM3DImportTargetsFromWorldKps = worldKps => ({ worldKps });
    viewer._applyImportPelvisAndTorso = () => calls.push("torso");
    viewer._applySAM3DTargetIK = (_targets, options) => calls.push(`ik:${options.includeSpine}:${options.normalizeLimbs}`);
    viewer._applySAM3DHeadLineRetarget = () => calls.push("head");
    viewer._applySAM3DHandPointRetarget = () => calls.push("hands");
    viewer._applySAM3DFootPointRetarget = () => calls.push("feet");
    viewer.updateIKEffectorPositions = () => calls.push("effectors");
    viewer.updateMarkers = () => calls.push("markers");
    viewer.requestRender = () => calls.push("render");
    viewer.dispatchPoseChange = () => calls.push("dispatch");

    const applied = viewer.applyWorldKeypointImport({ pelvis: {} }, {
        includeSpine: false,
        normalizeLimbs: true,
        drawFigure: false,
        updateMarkers: false,
        dispatchPoseChange: false,
    });

    assert.equal(applied, true);
    assert.deepEqual(calls.slice(0, 5), ["torso", "ik:false:true", "head", "hands", "feet"]);
    assert.ok(calls.includes("effectors"));
    assert.ok(calls.includes("render"));
    assert.ok(!calls.includes("markers"));
    assert.ok(!calls.includes("dispatch"));
});
