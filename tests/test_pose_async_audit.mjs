import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createScene } from "./helpers/pose_studio_scene.mjs";
import { createPoseStudioCharacter } from "../web/pose_studio/characters.mjs";

const noop = () => {};
const source = await fs.readFile(new URL("../web/vnccs_pose_studio.js", import.meta.url), "utf8");
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

for (const outcome of ["network error", "HTTP error", "empty response", "invalid pose", "invalid animation", "invalid framing"]) {
    test(`library ${outcome} preserves the current SAM camera and mesh`, async () => {
        const { w, viewer, node, context } = createScene({ skinned: true });
        viewer.setPose({ bones: { head: [20, 0, 0] } }, true);
        w.syncToNode(false, { skipCaptureUpload: true });
        const frame = { fov: 35, cameraPosition: { x: 0, y: 10, z: 40 } };
        const poseData = { source: "current SAM pose" };
        const meshData = { source: "current SAM mesh" };
        viewer.setSAMProjectionCameraFrame(frame);
        w._samCamStoredProjectionFrame = frame;
        w._samCameraModeActive = true;
        w._samCamBannerVisible = true;
        w._lastSAM3DPoseData = poseData;
        w._lastSAM3DMeshData = meshData;
        w.showMessage = noop;
        context.console = { ...console, error: noop };
        let finish, fail;
        context.fetch = () => new Promise((resolve, reject) => { finish = resolve; fail = reject; });
        const saved = node.widgets[0].value;
        const pose = JSON.stringify(viewer.getPose());
        const animation = JSON.stringify(w.animationState);
        const history = viewer.history.length;
        const loading = w.loadFromLibrary("Unavailable pose");
        assert.equal(viewer._samProjectionCameraFrame, frame, "pending load keeps the current view visible");
        if (outcome === "network error") fail(new Error("network failure"));
        else finish({ ok: outcome !== "HTTP error", status: 404,
            json: async () => outcome === "invalid pose" ? { pose: "invalid" }
                : outcome === "invalid animation" ? { pose: { animation: [] } }
                : outcome === "invalid framing" ? { pose: { bones: {}, cameraParams: { zoom: 3, offset_x: "bad", offset_y: 0 } } }
                : outcome === "empty response" ? {} : { error: "Pose not found" } });
        await loading;
        assert.equal(viewer._samProjectionCameraFrame, frame);
        assert.equal(w._samCamStoredProjectionFrame, frame);
        assert.equal(w._samCameraModeActive, true);
        assert.equal(w._samCamBannerVisible, true);
        assert.equal(w._lastSAM3DPoseData, poseData);
        assert.equal(w._lastSAM3DMeshData, meshData);
        assert.equal(JSON.stringify(viewer.getPose()), pose);
        assert.equal(JSON.stringify(w.animationState), animation);
        assert.equal(viewer.history.length, history);
        assert.equal(node.widgets[0].value, saved);
    });
}

test("a successfully loaded library pose clears the previous SAM camera", async () => {
    const { w, viewer, context } = createScene();
    const frame = { fov: 35, cameraPosition: { x: 0, y: 10, z: 40 } };
    viewer.setSAMProjectionCameraFrame(frame);
    w._samCamStoredProjectionFrame = frame;
    w._samCameraModeActive = true;
    context.fetch = async () => ({ ok: true, json: async () => ({ pose: { bones: {}, prompt: "loaded pose" } }) });
    await w.loadFromLibrary("Available pose");
    assert.equal(viewer._samProjectionCameraFrame, null);
    assert.equal(w._samCamStoredProjectionFrame, null);
    assert.equal(w._samCameraModeActive, false);
    assert.equal(w.getPosePrompt(), "loaded pose");
});

for (const format of ["FBX", "HMR2", "OpenPose"]) {
    test(`failed ${format} file import preserves SAM view and character placement`, async () => {
        const { w, viewer, node, context } = createScene();
        w.exportParams.cam_zoom = 2;
        w.exportParams.cam_offset_x = 5;
        w.persistActivePoseCameraParams();
        w.syncToNode(false, { skipCaptureUpload: true });
        const frame = { fov: 35, cameraPosition: { x: 0, y: 10, z: 40 } };
        viewer.setSAMProjectionCameraFrame(frame);
        w._samCamStoredProjectionFrame = frame;
        w._samCameraModeActive = true;
        w.showMessage = noop;
        context.console = { ...console, error: noop };
        const transform = JSON.stringify(w.getActiveCharacter().transform);
        const saved = node.widgets[0].value;
        let reader, fail;
        context.FileReader = class { constructor() { reader = this; } readAsText() {} };
        context.importMixamoFBXAnimation = () => new Promise((_resolve, reject) => { fail = reject; });
        context.detectAndParseJSON = () => ({ joints: {} });
        context.convertOpenPoseToPose = () => null;
        const input = { files: [{ name: format === "FBX" ? "bad.fbx" : "bad.json", type: "application/json" }], value: "bad" };
        w.handleFileImport({ target: input });
        if (format === "FBX") {
            assert.equal(JSON.stringify(w.getActiveCharacter().transform), transform, "pending parsing keeps the current placement");
            fail(new Error("The FBX file does not contain any animation clips."));
            await settle();
        } else await reader.onload({ target: { result: JSON.stringify(format === "HMR2"
            ? { version: "hmr2_3d_v1", people: [] } : { people: [] }) } });
        assert.equal(viewer._samProjectionCameraFrame, frame);
        assert.equal(w._samCamStoredProjectionFrame, frame);
        assert.equal(w._samCameraModeActive, true);
        assert.equal(JSON.stringify(w.getActiveCharacter().transform), transform);
        assert.equal(node.widgets[0].value, saved);
        assert.equal(input.value, "");
    });
}

function restorableScene() {
    const scene = createScene();
    scene.w.hydrateCharacterSceneModels = async () => true;
    scene.w.setInterfaceMode = noop;
    scene.viewer.setSkinMode = noop;
    scene.w.showMessage = () => assert.fail("Obsolete requests must not show messages");
    return scene;
}

function restoreReplacement({ w, node }) {
    const replacement = JSON.parse(node.widgets[0].value);
    replacement.characters[0].poses[0].prompt = "replacement workflow";
    replacement.pose_prompts = ["replacement workflow"];
    node.widgets[0].value = JSON.stringify(replacement);
    w.loadFromNode();
    return node.widgets[0].value;
}

for (const waitingAt of ["model", "morph"]) {
    for (const action of ["workflow", "remove"]) {
        test(`character switch stops after ${action} while waiting for ${waitingAt}`, async () => {
            const scene = restorableScene();
            const { w, node } = scene;
            w.characters.push(createPoseStudioCharacter({ id: "character-2", mesh: w.meshParams, poses: [{}] }));
            let finish;
            const pending = new Promise(resolve => { finish = resolve; });
            if (waitingAt === "model") w._modelLoadPromise = pending;
            else w.waitForMorphIdle = () => pending;
            const switching = w.selectCharacter("character-2");
            const before = action === "workflow" ? restoreReplacement(scene) : node.widgets[0].value;
            if (action === "remove") w._disposed = true;
            finish(true);
            assert.equal(await switching, false);
            await settle();
            assert.equal(w.activeCharacterId, "character-1");
            assert.equal(node.widgets[0].value, before);
        });
    }
}

for (const action of ["workflow", "remove"]) {
    test(`library request cannot change state after ${action}`, async () => {
        const scene = restorableScene();
        const { w, node, viewer, context } = scene;
        let finish;
        context.fetch = () => new Promise(resolve => { finish = resolve; });
        const pending = w.loadFromLibrary("Old pose");
        const before = action === "workflow" ? restoreReplacement(scene) : node.widgets[0].value;
        if (action === "remove") w._disposed = true;
        let applied = 0;
        viewer.setPose = () => { applied++; };
        finish({ ok: true, json: async () => ({ pose: { bones: {}, prompt: "obsolete library pose" } }) });
        await pending;
        assert.equal(applied, 0);
        assert.equal(node.widgets[0].value, before);
    });
}

for (const action of ["workflow", "remove", "new request"]) {
    test(`scene library load stops after ${action} during preceding hydration`, async () => {
        const scene = restorableScene();
        const { w, node } = scene;
        let finish;
        w._sceneModelHydrationPromise = new Promise(resolve => { finish = resolve; });
        const asset = JSON.parse(node.widgets[0].value);
        asset.characters[0].id = "obsolete-character";
        asset.active_character_id = "obsolete-character";
        const pending = w.loadCharacterSceneLibraryAsset(asset, { animation: true });
        const before = action === "workflow" ? restoreReplacement(scene) : node.widgets[0].value;
        if (action === "remove") w._disposed = true;
        if (action === "new request") w._libraryLoadToken = (w._libraryLoadToken || 0) + 1;
        finish(true);
        await pending;
        assert.equal(w.activeCharacterId, "character-1");
        assert.equal(node.widgets[0].value, before);
    });
}

for (const action of ["workflow", "remove", "new request"]) {
    test(`scene library completion cannot serialize after ${action}`, async () => {
        const scene = restorableScene();
        const { w, node } = scene;
        const asset = JSON.parse(node.widgets[0].value);
        let finish;
        w.hydrateCharacterSceneModels = () => new Promise(resolve => { finish = resolve; });
        const pending = w.loadCharacterSceneLibraryAsset(asset, { animation: true });
        const oldFinish = finish;
        const before = action === "workflow" ? restoreReplacement(scene) : node.widgets[0].value;
        if (action === "remove") w._disposed = true;
        if (action === "new request") w._libraryLoadToken = (w._libraryLoadToken || 0) + 1;
        w.syncToNode = () => assert.fail("Obsolete scene completion cannot serialize state");
        oldFinish(true);
        await pending;
        assert.equal(node.widgets[0].value, before);
    });
}

for (const action of ["workflow", "remove", "new request"]) {
    test(`library fetch error is ignored after ${action}`, async () => {
        const scene = restorableScene();
        let fail;
        scene.context.fetch = () => new Promise((_resolve, reject) => { fail = reject; });
        const pending = scene.w.loadFromLibrary("Old pose");
        if (action === "workflow") restoreReplacement(scene);
        if (action === "remove") scene.w._disposed = true;
        if (action === "new request") scene.w._libraryLoadToken++;
        fail(new Error("old network failure"));
        await pending;
    });
}

test("multi-character library hydration keeps its request current and restores every character", async () => {
    const scene = createScene({ skinned: true });
    const { w, node, viewer } = scene;
    w.setInterfaceMode = noop;
    w.loadModel = async () => true;
    viewer.waitForCaptureReady = async () => {};
    const asset = JSON.parse(node.widgets[0].value);
    asset.characters.push(JSON.parse(JSON.stringify(asset.characters[0])));
    asset.characters[1].id = "character-2";
    asset.characters[1].slot = 1;
    asset.characters[1].poses[0].prompt = "second character";
    w._libraryLoadToken = 41;
    await w.loadCharacterSceneLibraryAsset(asset, { animation: true });
    assert.equal(w._libraryLoadToken, 41);
    assert.equal(w.activeCharacterId, "character-1");
    assert.equal(w.characters.length, 2);
    assert.ok(viewer.passiveCharacters.has("character-2"));
    assert.equal(JSON.parse(node.widgets[0].value).characters.length, 2);
    assert.equal(w._hydratingCharacterScene, false);
    assert.equal(w._switchingCharacter, false);
});

test("prompt template edits persist before the focused field loses focus", () => {
    const { w, node, context } = createScene();
    const start = source.indexOf("        const createTemplateField = (label, key) => {");
    const end = source.indexOf("        content.appendChild(createTemplateField", start);
    const field = vm.runInNewContext(`(function () { ${source.slice(start, end)}\nreturn createTemplateField("Template", "prompt_template"); }).call(widget)`, {
        ...context, widget: w,
    });
    const textarea = field.children[1];
    for (const template of ["<user_prompt>", "<user_prompt>\n<lighting>"]) {
        textarea.value = template;
        textarea.emit("input");
        assert.equal(w.exportParams.prompt_template, template);
        assert.equal(JSON.parse(node.widgets[0].value).export.prompt_template, template);
    }
});

for (const activity of ["_switchingCharacter", "_hydratingCharacterScene"]) {
    test(`model completion cannot recapture while ${activity} owns the scene`, async () => {
        const { w, viewer } = createScene();
        viewer.setSkinMode = noop;
        viewer.loadData = noop;
        w.modelDataFromMorphMessage = () => ({});
        w.updateAnimationTimelineBones = noop;
        w.scheduleAllManagerPreviewRefresh = noop;
        let finish;
        w.requestStaticMorphModel = () => new Promise(resolve => { finish = resolve; });
        let captures = 0;
        w.syncToNode = () => { captures++; };
        const loading = w.loadModel(false, false);
        w[activity] = true;
        finish({});
        assert.equal(await loading, true);
        assert.equal(captures, 0);
    });
}

test("cancelled switch cannot let a replacement scene's model recapture during hydration", async () => {
    const { w, node, viewer } = createScene({ skinned: true });
    w.characters.push(createPoseStudioCharacter({ id: "character-2", mesh: w.meshParams, poses: [{}] }));
    w.syncToNode(false, { skipCapture: true, skipCaptureUpload: true });
    w.setInterfaceMode = noop;
    w.showMessage = () => assert.fail("Replacement scene must restore successfully");
    viewer.setSkinMode = noop;
    viewer.loadData = noop;
    viewer.waitForCaptureReady = async () => {};
    w.modelDataFromMorphMessage = () => ({});
    w.updateAnimationTimelineBones = noop;
    w.scheduleAllManagerPreviewRefresh = noop;
    let finishSwitch, finishModel;
    const waiting = new Promise(resolve => { finishSwitch = resolve; });
    w.waitForMorphIdle = () => waiting;
    w.requestStaticMorphModel = () => new Promise(resolve => { finishModel = resolve; });
    const switching = w.selectCharacter("character-2");
    const authored = node.widgets[0].value;
    w.loadFromNode();
    assert.equal(w._hydratingCharacterScene, true);
    finishSwitch(true);
    assert.equal(await switching, false);
    assert.equal(w._switchingCharacter, false);
    assert.equal(w._hydratingCharacterScene, true);
    const sync = w.syncToNode;
    w.syncToNode = function (fullCapture, ...args) {
        assert.equal(fullCapture && this._hydratingCharacterScene, false, "Hydration still owns the scene");
        return sync.call(this, fullCapture, ...args);
    };
    finishModel({});
    await w._sceneModelHydrationPromise;
    await settle();
    assert.equal(w._poseDataRestoreError, null);
    assert.equal(w._hydratingCharacterScene, false);
    assert.equal(w.activeCharacterId, "character-1");
    assert.equal(node.widgets[0].value, authored);
});
