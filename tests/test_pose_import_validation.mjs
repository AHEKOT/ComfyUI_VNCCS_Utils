import assert from "node:assert/strict";
import test from "node:test";
import { createScene } from "./helpers/pose_studio_scene.mjs";
import { convertOpenPoseToPose } from "../web/pose_studio/imports/openpose.js";

const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const validSAM = { joint_coords: [[0, 0, 0]], joint_names: ["pelvis"] };
const validJoints = { mid_hip: { x: 100, y: 100, c: 1 }, neck: { x: 100, y: 0, c: 1 } };

function authoredScene() {
    const scene = createScene({ skinned: true });
    scene.viewer._initIKHelpers();
    scene.viewer.setPose({ bones: { head: [35, 0, 0] }, modelRotation: [0, 25, 0] }, true);
    scene.w.syncToNode(false, { skipCapture: true, skipCaptureUpload: true });
    scene.viewer.history = ["previous pose"];
    scene.viewer.future = ["next pose"];
    return scene;
}

for (const [name, data] of [
    ["empty", { body_pose_params: [], keypoints_3d: [], global_rot: [] }],
    ["nonfinite point", { ...validSAM, joint_coords: [[NaN, 0, 0]] }],
    ["nonfinite matrix", { ...validSAM, joint_rotations: [[[Infinity, 0, 0], [0, 1, 0], [0, 0, 1]]] }],
    ["invalid rest matrix", { ...validSAM, joint_rotations: [identity], rest_joint_rotations: [[[null, 0, 0], [0, 1, 0], [0, 0, 1]]] }],
    ["unmapped rotations", { joint_names: ["unknown"], joint_rotations: [identity] }],
]) {
    test(`rejected SAM ${name} preserves pose, model rotation and undo/redo`, () => {
        const { viewer } = authoredScene();
        const before = JSON.stringify(viewer.getPose());
        assert.equal(viewer.applySAM3DImport(data), false);
        assert.equal(JSON.stringify(viewer.getPose()), before);
        assert.deepEqual(viewer.history, ["previous pose"]);
        assert.deepEqual(viewer.future, ["next pose"]);
    });
}

for (const points of [{}, [], { unknown_joint: [0, 0, 0] }, { neck: [0, 0, 0] }, { pelvis: [NaN, 0, 0] }, { pelvis: [0, 0, 0], neck: [0, Infinity, 0] }]) {
    test(`rejected HMR2 coordinates ${JSON.stringify(points)} preserve authored state`, () => {
        const { viewer } = authoredScene();
        const before = JSON.stringify(viewer.getPose());
        assert.equal(viewer.applyHMR2v1Import({ people: [{ keypoints_3d: points }] }), false);
        assert.equal(JSON.stringify(viewer.getPose()), before);
        assert.deepEqual(viewer.history, ["previous pose"]);
        assert.deepEqual(viewer.future, ["next pose"]);
    });
}

for (const parsed of [
    { joints: {} },
    { joints: { neck: { x: 0, y: 0, c: 0 }, mid_hip: { x: 0, y: 0, c: 0 } } },
    { joints: { ...validJoints, neck: { x: NaN, y: 0, c: 1 } } },
    { joints: validJoints, handLeft: [{ x: Infinity, y: 0, c: 1 }] },
    { joints: validJoints, face: [{ x: 0, y: 0, c: NaN }] },
]) {
    test(`OpenPose rejects unusable points ${JSON.stringify(parsed)} before applying a pose`, () => {
        const { viewer } = authoredScene();
        const before = JSON.stringify(viewer.getPose());
        assert.equal(convertOpenPoseToPose(parsed, viewer), null);
        assert.equal(JSON.stringify(viewer.getPose()), before);
        assert.deepEqual(viewer.history, ["previous pose"]);
        assert.deepEqual(viewer.future, ["next pose"]);
    });
}

test("valid rotation-only SAM, HMR2 and neutral OpenPose still import", () => {
    const { viewer } = authoredScene();
    assert.equal(viewer.applySAM3DImport({ joint_names: ["pelvis"], joint_rotations: [identity] }), true);
    assert.equal(viewer.history.length, 2);
    assert.deepEqual(viewer.future, []);
    assert.equal(viewer.applyHMR2v1Import({ people: [{ keypoints_3d: { pelvis: [0, 0, 0], neck: [0, -0.4, 0] } }] }), true);
    assert.equal(viewer.history.length, 3);
    assert.ok(Object.values(viewer.getPose().bones).every(rotation => rotation.every(Number.isFinite)));
    const pose = convertOpenPoseToPose({ joints: validJoints }, viewer);
    assert.ok(pose);
    assert.equal(Object.keys(pose.bones).length, 3, "a neutral pose is valid even when its rotations are zero");
});

for (const data of [
    { body_pose_params: [], keypoints_3d: [], global_rot: [] },
    { version: "hmr2_3d_v1", people: [{ keypoints_3d: {} }] },
    { version: "hmr2_3d_v1", people: [{ keypoints_3d: { unknown_joint: [0, 0, 0] } }] },
    { people: [{ pose_keypoints_2d: Array(54).fill(0) }] },
    { people: [{ keypoints_2d_norm: { mid_hip: [0.5, 0.5], neck: [null, 0] } }] },
]) {
    test(`failed JSON import keeps authored pose and workflow for ${JSON.stringify(data)}`, async () => {
        const { w, viewer, node, context } = authoredScene();
        const before = JSON.stringify(viewer.getPose());
        const workflow = node.widgets[0].value;
        const messages = [];
        w.showMessage = (...args) => messages.push(args);
        w.prepareSAM3DRenderFit = async () => null;
        let reader;
        context.FileReader = class { constructor() { reader = this; } readAsText() {} };
        const input = { files: [{ name: "pose.json", type: "application/json" }], value: "pose.json" };
        w.handleFileImport({ target: input });
        await reader.onload({ target: { result: JSON.stringify(data) } });
        assert.equal(JSON.stringify(viewer.getPose()), before);
        assert.equal(node.widgets[0].value, workflow);
        assert.deepEqual(viewer.history, ["previous pose"]);
        assert.deepEqual(viewer.future, ["next pose"]);
        assert.ok(messages.some(([_message, error]) => error === true));
        assert.equal(input.value, "");
    });
}

for (const invalid of [
    { bones: "invalid" },
    { bones: { head: ["invalid", 0, 0] } },
    { bones: { head: [0, 0] } },
    { modelRotation: [0, null, 0] },
    { bonePositions: { head: [0, "invalid", 0] } },
    { ikEffectorPositions: { left_hand: [0, 0, null] } },
    { poleTargetPositions: { left_arm: [0, 0] } },
    { hipBonePosition: { left_leg: "invalid" } },
]) {
    for (const boundary of ["file", "library"]) {
        test(`native ${boundary} rejects invalid pose geometry ${JSON.stringify(invalid)} without changing authored state`, async () => {
            const { w, viewer, node, context } = authoredScene();
            const frame = { fov: 35, cameraPosition: { x: 0, y: 10, z: 40 } };
            viewer.setSAMProjectionCameraFrame(frame);
            w._samCamStoredProjectionFrame = frame;
            w._samCameraModeActive = true;
            const before = JSON.stringify(viewer.getPose());
            const workflow = node.widgets[0].value;
            const messages = [];
            w.showMessage = (...args) => messages.push(args);
            context.console = { ...console, error: () => {} };
            const pose = { type: "single_pose", ...invalid };
            if (boundary === "file") {
                let reader;
                context.FileReader = class { constructor() { reader = this; } readAsText() {} };
                const input = { files: [{ name: "pose.json", type: "application/json" }], value: "pose.json" };
                w.handleFileImport({ target: input });
                await reader.onload({ target: { result: JSON.stringify(pose) } });
                assert.equal(input.value, "");
            } else {
                context.fetch = async () => ({ ok: true, json: async () => ({ pose }) });
                await w.loadFromLibrary("Invalid pose");
            }
            assert.equal(JSON.stringify(viewer.getPose()), before);
            assert.equal(node.widgets[0].value, workflow);
            assert.equal(viewer._samProjectionCameraFrame, frame);
            assert.equal(w._samCamStoredProjectionFrame, frame);
            assert.equal(w._samCameraModeActive, true);
            assert.deepEqual(viewer.history, ["previous pose"]);
            assert.deepEqual(viewer.future, ["next pose"]);
            assert.ok(messages.some(([_message, error]) => error === true));
        });
    }
}

for (const boundary of ["pose set", "character scene", "character scene structure", "animation"]) {
    test(`${boundary} validates every imported pose before replacing the editor`, async () => {
        const { w, viewer, node } = authoredScene();
        const before = JSON.stringify(viewer.getPose());
        const workflow = node.widgets[0].value;
        const invalidPose = { bones: { head: ["invalid", 0, 0] } };
        if (boundary === "pose set") {
            assert.throws(() => w.loadPoseSetAsset({ poses: [{ bones: {} }, invalidPose] }), /Invalid pose/);
        } else if (boundary.startsWith("character scene")) {
            const asset = JSON.parse(workflow);
            if (boundary === "character scene structure") asset.characters[0].poses = "invalid";
            else asset.characters[0].poses.push(invalidPose);
            await assert.rejects(w.loadCharacterSceneLibraryAsset(asset), /Invalid pose/);
        } else {
            assert.throws(() => w.loadAnimationLibraryAsset({ animation: { basePose: invalidPose } }), /Invalid pose/);
        }
        assert.equal(JSON.stringify(viewer.getPose()), before);
        assert.equal(node.widgets[0].value, workflow);
        assert.deepEqual(viewer.history, ["previous pose"]);
        assert.deepEqual(viewer.future, ["next pose"]);
    });
}

test("native import validation preserves legacy partial poses and numeric strings", () => {
    const { w } = authoredScene();
    for (const pose of [{}, { prompt: "rest" }, { modelRotation: [0, 25, 0] }, { bones: { head: ["35", 0, 0] } }]) {
        assert.doesNotThrow(() => w.validateImportedPose(pose));
    }
});

for (const weight of [null, {}, false, "damaged"]) {
    test(`a character scene with invalid mesh weight ${JSON.stringify(weight)} cannot replace the authored scene`, async () => {
        const { w, viewer, node } = authoredScene();
        const before = JSON.stringify({ characters: w.characters, pose: viewer.getPose() });
        const characters = w.characters, mesh = w.meshParams, animation = w.animationState;
        const workflow = node.widgets[0].value;
        const frame = { fov: 35, cameraPosition: { x: 0, y: 10, z: 40 } };
        viewer.setSAMProjectionCameraFrame(frame);
        w._samCamStoredProjectionFrame = frame;
        w._samCameraModeActive = true;
        w.hydrateCharacterSceneModels = () => assert.fail("Invalid mesh must fail before hydration");
        const data = JSON.parse(workflow);
        data.characters[0].mesh.weight = weight;
        await assert.rejects(w.loadCharacterSceneLibraryAsset(data), /Invalid pose mesh/);
        assert.equal(w.characters, characters);
        assert.equal(w.meshParams, mesh);
        assert.equal(w.animationState, animation);
        assert.equal(JSON.stringify({ characters: w.characters, pose: viewer.getPose() }), before);
        assert.equal(node.widgets[0].value, workflow);
        assert.equal(viewer._samProjectionCameraFrame, frame);
        assert.equal(w._samCamStoredProjectionFrame, frame);
        assert.equal(w._samCameraModeActive, true);
        assert.deepEqual(viewer.history, ["previous pose"]);
        assert.deepEqual(viewer.future, ["next pose"]);
    });
}

test("character scene imports normalize finite legacy mesh strings without changing unknown metadata", async () => {
    const { w, node } = authoredScene();
    const data = JSON.parse(node.widgets[0].value);
    data.characters[0].mesh.weight = "0.8";
    data.characters[0].mesh.arm_length = "0.6";
    data.characters[0].mesh.future_setting = { retained: true };
    w.hydrateCharacterSceneModels = async () => {};
    w.setInterfaceMode = () => {};
    await w.loadCharacterSceneLibraryAsset(data);
    assert.equal(w.meshParams.weight, 0.8);
    assert.equal(w.meshParams.arm_length, 0.6);
    assert.equal(JSON.stringify(w.meshParams.future_setting), '{"retained":true}');
    assert.equal(data.characters[0].mesh.weight, "0.8", "Import does not mutate the cached library response");
});
