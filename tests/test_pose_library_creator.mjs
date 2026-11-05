import assert from "node:assert/strict";
import test from "node:test";
import { createScene } from "./helpers/pose_studio_scene.mjs";

test("creator and manual save share the editable scene format without adding a prompt", async () => {
    const { w, viewer } = createScene({ skinned: true });
    viewer.setPose({ bones: { head: [15, 0, 0] } }, true);
    w.posePrompts = ["authored prompt"];
    w.commitViewerPoseToCurrentEditor({ fullCapture: false, syncOptions: { skipCapture: true } });
    const asset = w.buildLibraryAsset("");
    assert.equal(asset.type, "scene_pose");
    assert.equal(asset.prompt, "");
    assert.deepEqual([...asset.pose_prompts], [""]);
    assert.equal(asset.characters.length, 1);
    assert.equal(asset.characters[0].poses.length, 1);
    assert.equal(asset.characters[0].poses[0].prompt, "");
    assert.equal(asset.characters[0].animation.basePose.prompt, "");
    assert.equal(asset.cameraParams.zoom, w.currentCameraParams().zoom);
    assert.ok(Math.abs(asset.bones.head[0] - 15) < 0.001);
    assert.equal(w.posePrompts[0], "authored prompt", "building an asset must not change authored prompts");
    let saved;
    w.saveLibraryPoseRecord = async payload => { saved = payload; return { id: "saved" }; };
    w.refreshLibrary = () => {};
    assert.equal(await w.saveToLibrary("Created pose", false, { prompt: "" }), true);
    assert.equal(JSON.stringify(saved.pose), JSON.stringify(asset));
});

test("SAM capture helper refuses a stale result before changing the live pose", async () => {
    const { w, viewer } = createScene({ skinned: true });
    const before = JSON.stringify(viewer.getPose());
    let finish;
    w.prepareSAM3DRenderFit = () => new Promise(resolve => { finish = resolve; });
    let current = true;
    const work = w.applySAM3DPoseForCapture({}, () => {
        if (!current) throw new Error("obsolete");
    });
    current = false;
    finish({ poseData: { joint_names: ["pelvis"], joint_rotations: [[[1, 0, 0], [0, 1, 0], [0, 0, 1]]] } });
    await assert.rejects(work, /obsolete/);
    assert.equal(JSON.stringify(viewer.getPose()), before);
});
