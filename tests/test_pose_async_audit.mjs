import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createScene } from "./helpers/pose_studio_scene.mjs";
import { createPoseStudioCharacter } from "../web/pose_studio/characters.mjs";

const noop = () => {};
const source = await fs.readFile(new URL("../web/vnccs_pose_studio.js", import.meta.url), "utf8");
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

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
