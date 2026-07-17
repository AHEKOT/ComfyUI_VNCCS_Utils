import assert from "node:assert/strict";
import test from "node:test";

import * as THREE from "../web/three.module.js";
import { buildMixamoWorldKeypoints } from "../web/vnccs_mixamo_import.js";
import {
    AnalyticIKSolver,
    clampTwoBoneReachDistance,
    computeSAMProjectionFrameFit,
    PoseViewerCore,
} from "../web/vnccs_pose_studio_core.js";

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

test("SAM foot retarget aims ankle-to-toe without translating the ankle or changing leg length", () => {
    const root = new THREE.Bone();
    const calf = new THREE.Bone();
    const foot = new THREE.Bone();
    const ball = new THREE.Bone();
    root.name = "root";
    calf.name = "calf_l";
    foot.name = "foot_l";
    ball.name = "ball_l";
    calf.position.set(0.2, 1, -0.1);
    foot.position.set(0, -0.5, 0.05);
    ball.position.set(0.03, -0.2, 0.8);
    root.add(calf);
    calf.add(foot);
    foot.add(ball);
    root.rotation.set(0.4, -0.3, 0.2);
    calf.rotation.set(-0.2, 0.15, 0.35);
    foot.rotation.set(0.5, -0.7, 0.9);
    root.updateMatrixWorld(true);

    const viewer = Object.create(PoseViewerCore.prototype);
    viewer.THREE = THREE;
    viewer.bones = { calf_l: calf, foot_l: foot, ball_l: ball };
    viewer.initialBoneStates = {
        foot_l: { position: foot.position.clone() },
        ball_l: { position: ball.position.clone() },
    };
    viewer.skeleton = { update() {} };
    viewer.skinnedMesh = { updateMatrixWorld: () => root.updateMatrixWorld(true) };

    const worldKps = {
        left_knee: new THREE.Vector3(2, 3, 0),
        left_ankle: new THREE.Vector3(2, 1.4, 0.2),
        left_heel: new THREE.Vector3(2, 1, 1),
        left_big_toe: new THREE.Vector3(2.5, 1, -1),
        left_small_toe: new THREE.Vector3(1.5, 1, -1),
    };
    const initialFootOffset = foot.position.clone();
    const initialAnklePivot = foot.getWorldPosition(new THREE.Vector3());
    viewer._applySAM3DFootPointRetarget(worldKps);

    const footPosition = foot.getWorldPosition(new THREE.Vector3());
    const ballPosition = ball.getWorldPosition(new THREE.Vector3());
    const actualForward = ballPosition.sub(footPosition).normalize();
    const expectedForward = worldKps.left_big_toe.clone()
        .add(worldKps.left_small_toe)
        .multiplyScalar(0.5)
        .sub(worldKps.left_ankle)
        .normalize();
    assert.ok(actualForward.distanceTo(expectedForward) < 1e-8);
    assert.ok(foot.position.distanceTo(initialFootOffset) < 1e-12, "calf-to-ankle length must not change");
    assert.ok(
        foot.getWorldPosition(new THREE.Vector3()).distanceTo(initialAnklePivot) < 1e-12,
        "rotating the foot must not translate its ankle pivot"
    );

    const initialForward = ball.position.clone().normalize();
    const initialDorsal = new THREE.Vector3(0, 1, 0);
    initialDorsal.sub(initialForward.clone().multiplyScalar(initialDorsal.dot(initialForward))).normalize();
    const footWorld = foot.getWorldQuaternion(new THREE.Quaternion());
    const actualDorsal = initialDorsal.clone().applyQuaternion(footWorld).normalize();
    const targetTowardKnee = worldKps.left_knee.clone().sub(worldKps.left_ankle);
    targetTowardKnee.sub(expectedForward.clone().multiplyScalar(targetTowardKnee.dot(expectedForward))).normalize();
    assert.ok(actualDorsal.dot(targetTowardKnee) > 0, "foot dorsal side must face the knee");

    const firstRotation = footWorld.clone();
    viewer._applySAM3DFootPointRetarget(worldKps);
    const secondRotation = foot.getWorldQuaternion(new THREE.Quaternion());
    assert.ok(firstRotation.angleTo(secondRotation) < 1e-8);

    const importedSAMRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.35, -0.6, 1.1));
    let translatedSolveCount = 0;
    viewer.ikController = {
        ccdSolver: {
            solve() {
                translatedSolveCount += 1;
            },
        },
    };
    const ankleBeforeHintedFit = foot.getWorldPosition(new THREE.Vector3());
    viewer._applySAM3DFootPointRetarget(worldKps, { foot_l: importedSAMRotation });
    assert.equal(translatedSolveCount, 0, "foot fitting must never move the leg IK target");
    assert.ok(foot.position.distanceTo(initialFootOffset) < 1e-12);
    assert.ok(foot.getWorldPosition(new THREE.Vector3()).distanceTo(ankleBeforeHintedFit) < 1e-12);

    const hintedBall = ball.getWorldPosition(new THREE.Vector3());
    const hintedAnkle = foot.getWorldPosition(new THREE.Vector3());
    assert.ok(hintedBall.sub(hintedAnkle).normalize().distanceTo(expectedForward) < 1e-8);
});

test("SAM mesh overlay fit preserves fitted limb lengths", () => {
    const worldKps = { pelvis: {} };
    const viewer = Object.create(PoseViewerCore.prototype);
    viewer._samMeshOverlayWorldKps = worldKps;
    viewer.fitSAM3DJointRootLengthsToWorldKps = receivedWorldKps => {
        assert.equal(receivedWorldKps, worldKps);
    };
    viewer.fitSAM3DLimbLengthsToWorldKps = receivedWorldKps => {
        assert.equal(receivedWorldKps, worldKps);
    };
    let applyCount = 0;
    viewer.applyWorldKeypointImport = (receivedWorldKps, options) => {
        applyCount += 1;
        assert.equal(receivedWorldKps, worldKps);
        assert.equal(options.normalizeLimbs, false);
        assert.equal(options.exactArmTargets, undefined);
        return true;
    };
    assert.equal(viewer.fitCurrentPoseToSAMMeshOverlay(0.125), true);
    assert.equal(applyCount, 6);
});

test("SAM normalization keeps a straight leg at full chain reach", () => {
    const solved = [];
    const restPositions = {
        thigh_r: new THREE.Vector3(0, 1, 0),
        calf_r: new THREE.Vector3(0, 0.5, 0),
        foot_r: new THREE.Vector3(0, 0, 0),
    };
    const viewer = Object.create(PoseViewerCore.prototype);
    viewer.THREE = THREE;
    viewer.bones = {};
    viewer.skinnedMesh = { updateMatrixWorld() {} };
    viewer._getBoneWorldPositionForImport = name => restPositions[name]?.clone() || null;
    viewer.ikController = {
        effectors: {},
        poleTargets: {},
        ccdSolver: {
            solve(_chain, _bones, target, poleTarget) {
                solved.push({
                    target: target.clone(),
                    poleTarget: poleTarget?.clone() || null,
                });
                return true;
            },
        },
    };

    viewer._applySAM3DTargetIK({
        worldKps: {
            right_hip: new THREE.Vector3(0, 1, 0),
            right_knee: new THREE.Vector3(0, 0.75, 0),
            right_ankle: new THREE.Vector3(0, 0.5, 0),
        },
        effectorTargets: {
            foot_r: new THREE.Vector3(0, 0.5, 0),
        },
        poleTargets: {
            rightLeg: new THREE.Vector3(0, 0.75, 0),
        },
    }, {
        normalizeLimbs: true,
        includeSpine: false,
        drawNormalizedFigure: false,
    });

    assert.equal(solved.length, 1);
    assert.ok(solved[0].target.distanceTo(new THREE.Vector3(0, 0, 0)) < 1e-8);
    assert.ok(solved[0].poleTarget.distanceTo(new THREE.Vector3(0, 0.5, 0)) < 1e-8);
});

test("SAM fitted arm lengths preserve both elbow and wrist mesh points", () => {
    const solved = [];
    const shoulder = new THREE.Vector3(0, 1, 0);
    const elbow = new THREE.Vector3(0.3, 0.8, 0);
    const wrist = new THREE.Vector3(0.4, 0.7, 0);
    const upperLength = shoulder.distanceTo(elbow);
    const lowerLength = elbow.distanceTo(wrist);
    const restPositions = {
        upperarm_r: shoulder.clone(),
        lowerarm_r: shoulder.clone().add(new THREE.Vector3(upperLength, 0, 0)),
        hand_r: shoulder.clone().add(new THREE.Vector3(upperLength + lowerLength, 0, 0)),
        thigh_r: new THREE.Vector3(0, 1, 0),
        calf_r: new THREE.Vector3(0, 0.5, 0),
        foot_r: new THREE.Vector3(0, 0, 0),
    };
    const viewer = Object.create(PoseViewerCore.prototype);
    viewer.THREE = THREE;
    viewer.bones = {};
    viewer.skinnedMesh = { updateMatrixWorld() {} };
    viewer._getBoneWorldPositionForImport = name => restPositions[name]?.clone() || null;
    viewer.ikController = {
        effectors: {},
        poleTargets: {},
        ccdSolver: {
            solve(chain, _bones, target, poleTarget) {
                solved.push({
                    effector: chain.effector,
                    target: target.clone(),
                    poleTarget: poleTarget?.clone() || null,
                });
                return true;
            },
        },
    };

    viewer._applySAM3DTargetIK({
        worldKps: {
            right_shoulder: shoulder.clone(),
            right_elbow: elbow.clone(),
            right_wrist: wrist.clone(),
            right_hip: new THREE.Vector3(0, 1, 0),
            right_knee: new THREE.Vector3(0, 0.75, 0),
            right_ankle: new THREE.Vector3(0, 0.5, 0),
        },
        effectorTargets: {
            hand_r: wrist.clone(),
            foot_r: new THREE.Vector3(0, 0.5, 0),
        },
        poleTargets: {
            rightArm: elbow.clone(),
            rightLeg: new THREE.Vector3(0, 0.75, 0),
        },
    }, {
        normalizeLimbs: true,
        normalizeArms: true,
        normalizeLegs: true,
        includeSpine: false,
        drawNormalizedFigure: false,
    });

    const armSolve = solved.find(item => item.effector === 'hand_r');
    const legSolve = solved.find(item => item.effector === 'foot_r');
    assert.ok(armSolve.target.distanceTo(wrist) < 1e-8);
    assert.ok(armSolve.poleTarget.distanceTo(elbow) < 1e-8);
    assert.ok(legSolve.target.distanceTo(new THREE.Vector3(0, 0, 0)) < 1e-8);
});

test("SAM overlay sets upper-arm and forearm lengths from exact mesh segments", () => {
    const root = new THREE.Bone();
    const upperarm = new THREE.Bone();
    const lowerarm = new THREE.Bone();
    const hand = new THREE.Bone();
    upperarm.name = 'upperarm_r';
    lowerarm.name = 'lowerarm_r';
    hand.name = 'hand_r';
    upperarm.position.set(0, 1, 0);
    upperarm.scale.setScalar(0.8);
    lowerarm.position.set(0.5, 0, 0);
    hand.position.set(0.4, 0, 0);
    root.add(upperarm);
    upperarm.add(lowerarm);
    lowerarm.add(hand);
    root.updateMatrixWorld(true);

    const viewer = Object.create(PoseViewerCore.prototype);
    viewer.THREE = THREE;
    viewer.bones = {
        upperarm_r: upperarm,
        lowerarm_r: lowerarm,
        hand_r: hand,
    };
    viewer.boneList = [upperarm, lowerarm, hand];
    viewer.initialBoneStates = {
        lowerarm_r: { position: lowerarm.position.clone() },
        hand_r: { position: hand.position.clone() },
    };
    viewer.boneLengthParams = {
        upper_arm_r: 0.5,
        forearm_r: 0.5,
    };
    viewer.skinnedMesh = {
        updateMatrixWorld: () => root.updateMatrixWorld(true),
    };
    viewer.updateIKEffectorPositions = () => {};
    viewer.requestRender = () => {};
    const worldKps = {
        right_shoulder: new THREE.Vector3(0, 1, 0),
        right_elbow: new THREE.Vector3(0.48, 1, 0),
        right_wrist: new THREE.Vector3(0.88, 1, 0),
    };

    const fitted = viewer.fitSAM3DArmLengthsToWorldKps(worldKps);

    assert.ok(fitted);
    assert.ok(Math.abs(fitted.upper_arm_r - 0.7) < 1e-8);
    assert.ok(Math.abs(fitted.forearm_r - 0.75) < 1e-8);

    const actualShoulder = new THREE.Vector3();
    const actualElbow = new THREE.Vector3();
    const actualWrist = new THREE.Vector3();
    upperarm.getWorldPosition(actualShoulder);
    lowerarm.getWorldPosition(actualElbow);
    hand.getWorldPosition(actualWrist);
    assert.ok(Math.abs(actualShoulder.distanceTo(actualElbow) - 0.48) < 1e-8);
    assert.ok(Math.abs(actualElbow.distanceTo(actualWrist) - 0.4) < 1e-8);
});

test("SAM automatic arm morph keeps the full source segment lengths without shortening caps", () => {
    const viewer = Object.create(PoseViewerCore.prototype);
    viewer.THREE = THREE;
    viewer.bones = {};
    viewer.skinnedMesh = {};
    viewer._buildSAM3DNamedPoints = () => ({
        left_shoulder: [1, 1, 0],
        left_elbow: [1, 0.1, 0],
        left_wrist: [1, -0.45, 0],
        right_shoulder: [-1, 1, 0],
        right_elbow: [-1, 0.1, 0],
        right_wrist: [-1, -0.45, 0],
        left_hip: [1, 0, 0],
        right_hip: [-1, 0, 0],
        left_knee: [1, -0.5, 0],
        right_knee: [-1, -0.5, 0],
        left_ankle: [1, -1, 0],
        right_ankle: [-1, -1, 0],
    });
    const bonePositions = {
        upperarm_l: new THREE.Vector3(1, 1, 0),
        lowerarm_l: new THREE.Vector3(1, 0.4, 0),
        hand_l: new THREE.Vector3(1, 0, 0),
        upperarm_r: new THREE.Vector3(-1, 1, 0),
        lowerarm_r: new THREE.Vector3(-1, 0.4, 0),
        hand_r: new THREE.Vector3(-1, 0, 0),
        thigh_l: new THREE.Vector3(1, 0, 0),
        calf_l: new THREE.Vector3(1, -0.5, 0),
        foot_l: new THREE.Vector3(1, -1, 0),
        thigh_r: new THREE.Vector3(-1, 0, 0),
        calf_r: new THREE.Vector3(-1, -0.5, 0),
        foot_r: new THREE.Vector3(-1, -1, 0),
        pelvis: new THREE.Vector3(0, 0, 0),
        spine_02: new THREE.Vector3(0, 0.5, 0),
        spine_03: new THREE.Vector3(0, 1, 0),
    };
    viewer._getBoneWorldPositionForImport = name => bonePositions[name]?.clone() || null;
    const applied = {};
    viewer.updateBoneLengthScale = (group, value) => {
        applied[group] = value;
    };

    const fitted = viewer.autoFitSAM3DBoneLengths({});

    assert.ok(fitted);
    assert.ok(Math.abs(applied.upper_arm_l - 1) < 1e-8);
    assert.ok(Math.abs(applied.upper_arm_r - 1) < 1e-8);
    assert.ok(Math.abs(applied.forearm_l - 0.875) < 1e-8);
    assert.ok(Math.abs(applied.forearm_r - 0.875) < 1e-8);
});

test("two-bone IK allows exact full extension without forced elbow bend", () => {
    assert.equal(clampTwoBoneReachDistance(1, 1), 1);
    assert.equal(clampTwoBoneReachDistance(1.2, 1), 1);
    assert.equal(clampTwoBoneReachDistance(0.7, 1), 0.7);

    const root = new THREE.Bone();
    const mid = new THREE.Bone();
    const effector = new THREE.Bone();
    mid.position.set(1, 0, 0);
    effector.position.set(1, 0, 0);
    root.add(mid);
    mid.add(effector);
    root.rotation.z = Math.PI / 4;
    mid.rotation.z = -Math.PI / 2;
    root.updateMatrixWorld(true);

    const solver = new AnalyticIKSolver(THREE);
    solver.solve2Bone(
        root,
        mid,
        effector,
        new THREE.Vector3(2, 0, 0),
        new THREE.Vector3(1, 0, 1),
        THREE,
    );

    const solvedMid = new THREE.Vector3();
    const solvedEffector = new THREE.Vector3();
    mid.getWorldPosition(solvedMid);
    effector.getWorldPosition(solvedEffector);
    assert.ok(solvedMid.distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-6);
    assert.ok(solvedEffector.distanceTo(new THREE.Vector3(2, 0, 0)) < 1e-6);
});

test("SAM import fits body proportions before building IK targets", () => {
    const calls = [];
    const viewer = Object.create(PoseViewerCore.prototype);
    viewer.THREE = {};
    viewer.bones = {};
    viewer.boneList = [];
    viewer.initialBoneStates = {};
    viewer.skinnedMesh = {
        rotation: { set: () => calls.push("rotation-reset") },
        updateMatrixWorld: () => calls.push("mesh-update"),
    };
    viewer.skeleton = { update: () => calls.push("skeleton-update") };
    viewer.recordState = () => calls.push("record");
    viewer.autoFitSAM3DBoneLengths = () => calls.push("auto-fit");
    viewer._buildSAM3DImportTargets = () => {
        calls.push("build-targets");
        return { worldKps: { pelvis: {} } };
    };
    viewer._applySAM3DRotationImport = () => {
        calls.push("rotation-import");
        return false;
    };
    viewer.applyWorldKeypointImport = () => {
        calls.push("world-import");
        return true;
    };

    assert.equal(viewer.applySAM3DImport({ joint_coords: [] }), true);
    assert.ok(calls.indexOf("auto-fit") < calls.indexOf("build-targets"));
    assert.ok(calls.indexOf("build-targets") < calls.indexOf("world-import"));
});

test("SAM projection matches mannequin head and feet to the source height", () => {
    const modelBounds = {
        width: 0.72,
        height: 2.12,
        centerX: 0.08,
        centerY: -0.12,
        depth: 8,
    };
    const desiredBounds = {
        width: 0.9,
        height: 1.8,
        centerX: 0,
        centerY: 0.02,
    };
    const fit = computeSAMProjectionFrameFit({
        modelBounds,
        desiredBounds,
        fov: 40,
        aspect: 1,
    });

    assert.ok(fit);
    assert.ok(fit.zoom < 1);

    const visibleHeight = 2 * modelBounds.depth * Math.tan(THREE.MathUtils.degToRad(20)) / fit.zoom;
    const centerShiftY = fit.offset_y * 2 / visibleHeight;
    const fittedCenterY = modelBounds.centerY * fit.zoom + centerShiftY;
    const fittedTop = fittedCenterY + modelBounds.height * fit.zoom * 0.5;
    const fittedBottom = fittedCenterY - modelBounds.height * fit.zoom * 0.5;
    const desiredTop = desiredBounds.centerY + desiredBounds.height * 0.5;
    const desiredBottom = desiredBounds.centerY - desiredBounds.height * 0.5;

    assert.ok(Math.abs(fittedTop - desiredTop) < 1e-8);
    assert.ok(Math.abs(fittedBottom - desiredBottom) < 1e-8);
});

test("SAM projection height is not reduced by a narrower source frame", () => {
    const fit = computeSAMProjectionFrameFit({
        modelBounds: {
            width: 1.2,
            height: 1.6,
            centerX: 0,
            centerY: 0,
            depth: 8,
        },
        desiredBounds: {
            width: 0.6,
            height: 1.8,
            centerX: 0,
            centerY: 0,
        },
        fov: 40,
        aspect: 1,
    });

    assert.ok(fit);
    assert.ok(Math.abs(fit.zoom - 1.125) < 1e-8);
});

test("SAM projection aligns shoulder-to-sole height instead of head height", () => {
    const modelBounds = {
        width: 0.8,
        height: 2,
        centerX: 0,
        centerY: 0,
        depth: 8,
    };
    const fit = computeSAMProjectionFrameFit({
        modelBounds,
        desiredBounds: {
            width: 0.8,
            height: 1.8,
            centerX: 0,
            centerY: 0,
        },
        modelShoulderY: 0.6,
        desiredShoulderY: 0.5,
        desiredBottomY: -0.9,
        fov: 40,
        aspect: 1,
    });

    assert.ok(fit);
    assert.ok(Math.abs(fit.zoom - 0.875) < 1e-8);

    const visibleHeight = 2 * modelBounds.depth * Math.tan(THREE.MathUtils.degToRad(20)) / fit.zoom;
    const shiftY = fit.offset_y * 2 / visibleHeight;
    const fittedShoulderY = 0.6 * fit.zoom + shiftY;
    const fittedBottomY = -1 * fit.zoom + shiftY;
    assert.ok(Math.abs(fittedShoulderY - 0.5) < 1e-8);
    assert.ok(Math.abs(fittedBottomY + 0.9) < 1e-8);
});

test("SAM standard-camera fit measures again after applying camera rotation", () => {
    const calls = [];
    const viewer = Object.create(PoseViewerCore.prototype);
    viewer.getPose = () => ({ modelRotation: [1, 2, 3] });
    viewer.setModelRotation = (x, y, z) => calls.push(["rotate", x, y, z]);
    viewer.computeSAM3DFrameCameraParams = (_data, _width, _height, _meshData, forceFallback) => {
        calls.push(["measure", forceFallback]);
        return calls.filter(call => call[0] === "measure").length === 1
            ? { zoom: 0.8, offset_x: 0, offset_y: 0, yaw_deg: 20, pitch_deg: -10 }
            : { zoom: 1.2, offset_x: 2, offset_y: 3, yaw_deg: 20, pitch_deg: -10 };
    };

    const result = viewer.fitSAM3DToStandardCamera({}, 1024, 1024, {});

    assert.deepEqual(calls, [
        ["measure", true],
        ["rotate", 11, -18, 3],
        ["measure", true],
    ]);
    assert.equal(result.zoom, 1.2);
    assert.equal(result.offset_y, 3);
});

test("SAM gaze targets move with the mannequin head without changing direction", () => {
    const viewer = Object.create(PoseViewerCore.prototype);
    viewer.THREE = THREE;
    const sourceHead = new THREE.Vector3(0, 2, 0);
    const currentHead = new THREE.Vector3(0, 1.5, 0);
    const target = {
        left: new THREE.Vector3(-0.1, 2.2, 0.3),
        right: new THREE.Vector3(0.1, 2.2, 0.3),
    };

    const relocated = viewer._relocateSAM3DEyeTargetsToHead(
        { head: sourceHead },
        target,
        currentHead,
    );
    const sourceMid = target.left.clone().add(target.right).multiplyScalar(0.5);
    const relocatedMid = relocated.left.clone().add(relocated.right).multiplyScalar(0.5);
    const sourceLook = sourceMid.sub(sourceHead).normalize();
    const relocatedLook = relocatedMid.sub(currentHead).normalize();

    assert.ok(sourceLook.distanceTo(relocatedLook) < 1e-8);
    assert.ok(relocated.left.distanceTo(new THREE.Vector3(-0.1, 1.7, 0.3)) < 1e-8);
    assert.ok(
        relocated.right.clone().sub(relocated.left).distanceTo(
            target.right.clone().sub(target.left),
        ) < 1e-8,
    );
});
