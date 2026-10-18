import assert from "node:assert/strict";
import test from "node:test";
import { createScene } from "./helpers/pose_studio_scene.mjs";

const cameraParams = { zoom: 2.72, offset_x: 4, offset_y: -2, yaw_deg: 25, pitch_deg: -10 };
const legacyPose = { bones: { head: [20, 0, 0] }, modelRotation: [0, 15, 0], cameraParams };
const scenePose = {
    type: "scene_pose", schema_version: 3, active_character_id: "saved-character", activeTab: 1,
    camera: { yaw_deg: 40, pitch_deg: 12 },
    characters: [{
        id: "saved-character", transform: { x: 5, y: -12, z: 3, zoom: 2.72 },
        poses: [{ bones: { head: [-30, 0, 0] } }, { bones: legacyPose.bones, modelRotation: legacyPose.modelRotation }],
    }],
};
const samProjection = { fov: 35, cameraPosition: { x: 0, y: 10, z: 50 }, projection_zoom: 1.3 };

function harness() {
    const scene = createScene({ skinned: true });
    const { w, viewer } = scene;
    const captures = [];
    Object.assign(w.exportParams, {
        cam_zoom: 1.2, cam_offset_x: -3, cam_offset_y: 4, cam_yaw_deg: -15, cam_pitch_deg: 5,
        debugKeepLighting: true,
    });
    w.persistActivePoseCameraParams();
    w.applyCameraToViewer(true);
    w.queueCaptureUpload = () => {};
    w.showMessage = message => assert.fail(message);
    viewer.capture = (width, height, zoom, _background, x, y, yaw, pitch) => {
        viewer.updateCaptureCamera(width, height, zoom, x, y, yaw, pitch);
        captures.push({
            bounds: scene.projection(),
            transform: { ...viewer.activeCharacterAppearance.transform },
            modelRotation: { ...viewer.modelRotation },
            head: viewer.bones.head.rotation.toArray(),
            camera: viewer.captureCamera.matrixWorld.toArray(),
            projection: viewer.captureCamera.projectionMatrix.toArray(),
        });
        return `capture-${captures.length}`;
    };
    w.syncToNode(false);
    return { ...scene, captures };
}

function editorState({ w, viewer }) {
    return JSON.stringify({
        characters: w.characters, poses: w.poses, export: w.exportParams,
        cameraParams: viewer.cameraParams, appearance: viewer.activeCharacterAppearance,
        projection: viewer._samProjectionCameraFrame,
        history: viewer.history, future: viewer.future,
    });
}

for (const [name, asset] of [
    ["legacy camera framing", legacyPose],
    ["v3 character framing and nested pose", scenePose],
    ["v3 per-pose camera angles", {
        ...scenePose, characters: [{ ...scenePose.characters[0], poses: [legacyPose] }], activeTab: 0,
    }],
    ["saved SAM projection", { ...legacyPose, sam_projection: samProjection }],
    ["pose without saved framing", { bones: legacyPose.bones }],
]) {
    test(`debug capture matches manual library loading: ${name}`, async () => {
        const manual = harness();
        manual.context.fetch = async () => ({ ok: true, json: async () => ({ pose: structuredClone(asset) }) });
        await manual.w.loadFromLibrary("saved");
        manual.w.syncToNode(true, { executionCapture: true, skipCaptureUpload: true });
        assert.equal(manual.captures.length, 1);

        const debug = harness();
        debug.w.exportParams.debugMode = true;
        debug.w.libraryPoses = [{ data: structuredClone(asset) }];
        // An unrelated SAM camera in the editor must not affect the selected pose.
        debug.viewer.setSAMProjectionCameraFrame({ ...samProjection, fov: 50 });
        debug.w.updateCaptureCameraPreview();
        debug.w.poseCaptures = ["previous-capture"];
        const before = editorState(debug);
        const libraryBefore = JSON.stringify(debug.w.libraryPoses);
        debug.w.syncToNode(true, { executionCapture: true, skipCaptureUpload: true });

        assert.equal(debug.captures.length, 1);
        assert.deepEqual(debug.captures[0], manual.captures[0]);
        assert.equal(editorState(debug), before, "capture must restore the authored editor state");
        assert.equal(JSON.stringify(debug.w.libraryPoses), libraryBefore, "library records must stay unchanged");
        assert.deepEqual(Array.from(debug.w.poseCaptures), ["capture-1"]);
    });
}

test("failed debug capture restores the editor camera, placement and previous output", () => {
    const scene = harness();
    scene.w.exportParams.debugMode = true;
    scene.w.libraryPoses = [{ data: structuredClone(scenePose) }];
    scene.viewer.setSAMProjectionCameraFrame(samProjection);
    scene.w.updateCaptureCameraPreview();
    scene.w.poseCaptures = ["previous-capture"];
    scene.w.lightingPrompts = ["previous-prompt"];
    const before = editorState(scene);
    const bounds = scene.projection();
    scene.viewer.capture = () => { throw new Error("Capture failed"); };

    assert.throws(() => scene.w.syncToNode(true, { executionCapture: true, skipCaptureUpload: true }), /Capture failed/);
    assert.equal(editorState(scene), before);
    assert.deepEqual(scene.projection(), bounds);
    assert.deepEqual(Array.from(scene.w.poseCaptures), ["previous-capture"]);
    assert.deepEqual(Array.from(scene.w.lightingPrompts), ["previous-prompt"]);
    assert.equal(scene.w._isSyncing, false);
});
