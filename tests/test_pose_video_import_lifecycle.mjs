import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createScene, Element } from "./helpers/pose_studio_scene.mjs";
import { createPoseStudioCharacter } from "../web/pose_studio/characters.mjs";
import * as videoImports from "../web/pose_studio/imports/video.mjs";

const noop = () => {};
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const plan = videoImports.computeVideoSamplePlan({ inTime: 0, outTime: 0.25, targetFps: 12 });

function videoScene() {
    const scene = createScene();
    const { w, viewer, context } = scene;
    Object.assign(context, videoImports, { DOMException });
    w.container.isConnected = true;
    w.hydrateCharacterSceneModels = async () => true;
    w.setInterfaceMode = noop;
    w.showMessage = noop;
    viewer.setSkinMode = noop;
    viewer.setCameraParams(w.currentCameraParams());
    w.captureVideoFrameBlob = async () => new Blob();
    w.requestSAM3DPoseForImage = async () => ({ source: "old video" });
    w.prepareSAM3DRenderFit = async poseData => ({ poseData });
    return scene;
}

async function replaceScene(scene, action) {
    const { w, viewer, node } = scene;
    if (action === "workflow") {
        const replacement = JSON.parse(node.widgets[0].value);
        replacement.characters[0].poses[0].prompt = "replacement workflow";
        replacement.pose_prompts = ["replacement workflow"];
        node.widgets[0].value = JSON.stringify(replacement);
        w.loadFromNode();
        await settle();
    } else if (action === "character") {
        w.characters.push(createPoseStudioCharacter({
            id: "character-2", mesh: w.meshParams, poses: [{ bones: { head: [70, 0, 0] } }],
        }));
        assert.equal(await w.selectCharacter("character-2"), true);
    } else if (action === "tab") {
        w.poses.push({ bones: { head: [55, 0, 0] } });
        w.activeTab = 1;
        viewer.setPose(w.poses[1], true);
    } else if (action === "new request") w._libraryLoadToken++;
    else if (action === "remove") w._disposed = true;
}

for (const stage of ["captureVideoFrameBlob", "requestSAM3DPoseForImage", "prepareSAM3DRenderFit"]) {
    for (const action of ["workflow", "character", "tab", "new request", "remove"]) {
        test(`video import cannot mutate ${action} after waiting for ${stage}`, async () => {
            const scene = videoScene();
            const { w, viewer, node } = scene;
            let finish;
            w[stage] = () => new Promise(resolve => { finish = resolve; });
            const importing = w.importVideoPoseSegment({ pause: noop }, plan);
            await settle();
            assert.equal(typeof finish, "function");
            await replaceScene(scene, action);
            const saved = node.widgets[0].value;
            const pose = JSON.stringify(viewer.getPose());
            const animation = JSON.stringify(w.animationState);
            let applied = 0;
            let rolledBack = 0;
            viewer.applySAM3DImport = () => { applied++; return true; };
            viewer.setPose = () => { rolledBack++; };
            finish({ poseData: { source: "old video" } });
            await assert.rejects(importing, error => error.name === "AbortError");
            assert.equal(applied, 0, "obsolete SAM results must not reach the replacement rig");
            assert.equal(rolledBack, 0, "obsolete failure must not restore the old character pose");
            assert.equal(JSON.stringify(viewer.getPose()), pose);
            assert.equal(JSON.stringify(w.animationState), animation);
            assert.equal(node.widgets[0].value, saved);
        });
    }
}

test("video cancellation during mesh fitting restores the current scene without applying the late result", async () => {
    const { w, viewer } = videoScene();
    const controller = new AbortController();
    const original = JSON.stringify(viewer.getPose());
    let finish;
    w.prepareSAM3DRenderFit = () => new Promise(resolve => { finish = resolve; });
    let applied = 0;
    viewer.applySAM3DImport = () => { applied++; return true; };
    const importing = w.importVideoPoseSegment({ pause: noop }, plan, { signal: controller.signal });
    await settle();
    controller.abort();
    finish({ poseData: { source: "cancelled video" } });
    await assert.rejects(importing, error => error.name === "AbortError");
    assert.equal(applied, 0);
    assert.equal(JSON.stringify(viewer.getPose()), original);
});

for (const action of ["workflow", "character"]) {
    test(`failed video request cannot roll back ${action} to the old pose`, async () => {
        const scene = videoScene();
        const { w, viewer, node } = scene;
        let fail;
        w.captureVideoFrameBlob = () => new Promise((_resolve, reject) => { fail = reject; });
        const importing = w.importVideoPoseSegment({ pause: noop }, plan);
        await replaceScene(scene, action);
        const saved = node.widgets[0].value;
        viewer.setPose = () => assert.fail("obsolete error must not restore the old pose");
        fail(new Error("old decoder error"));
        await assert.rejects(importing, error => error.name === "AbortError");
        assert.equal(node.widgets[0].value, saved);
    });
}

test("a current video failure still restores the original pose", async () => {
    const { w, viewer } = videoScene();
    const original = JSON.stringify(viewer.getPose());
    w.captureVideoFrameBlob = async () => { throw new Error("decoder error"); };
    let restored = 0;
    const restore = viewer.setPose;
    viewer.setPose = function (...args) { restored++; return restore.apply(this, args); };
    await assert.rejects(w.importVideoPoseSegment({ pause: noop }, plan), /decoder error/);
    assert.equal(restored, 1);
    assert.equal(JSON.stringify(viewer.getPose()), original);
});

test("workflow restoration closes the previous video modal", () => {
    const { w } = videoScene();
    let closed = 0;
    w._activeVideoImportClose = () => { closed++; };
    w.loadFromNode();
    assert.equal(closed, 1);
});

const source = await fs.readFile(new URL("../web/vnccs_pose_studio.js", import.meta.url), "utf8");
for (const handle of ["playhead", "in", "out"]) {
    test(`video ${handle} stops at the latest preview after pointer capture is lost`, () => {
        const start = source.indexOf("        let dragging = null;", source.indexOf("async showVideoImportModal("));
        const end = source.indexOf('        for (const [which, input] of [["in", inInput]', start);
        const timeline = new Element();
        const inHandle = new Element();
        const outHandle = new Element();
        const preview = { currentTime: 0, pause: noop };
        const boundaries = [];
        vm.runInNewContext(source.slice(start, end), {
            timeline, inHandle, outHandle, preview, processing: false, duration: 10,
            updatePlayhead: noop, timeFromPointer: event => event.clientX,
            setBoundary: (which, value) => boundaries.push([which, value]),
        });
        const target = handle === "in" ? inHandle : handle === "out" ? outHandle : timeline;
        target.emit("pointerdown", { clientX: 2 });
        timeline.emit("pointermove", { clientX: 4 });
        assert.equal(handle === "playhead" ? preview.currentTime : boundaries.at(-1)[1], 4);
        timeline.emit("lostpointercapture");
        timeline.emit("pointermove", { clientX: 8 });
        assert.equal(handle === "playhead" ? preview.currentTime : boundaries.at(-1)[1], 4);
    });
}
