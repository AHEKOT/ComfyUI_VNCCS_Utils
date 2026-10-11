import assert from "node:assert/strict";
import test from "node:test";
import { createScene } from "./helpers/pose_studio_scene.mjs";
import { createPoseStudioCharacter } from "../web/pose_studio/characters.mjs";
import {
    createDefaultAnimationState, evaluateAnimationFrame, setTrackKeyframeFromEuler,
} from "../web/pose_studio/animation.mjs";

const noop = () => {};
const sync = w => w.syncToNode(false, { skipCapture: true, skipCaptureUpload: true });
const angle = state => Math.round(evaluateAnimationFrame(state, 0).bones.head[0]);

function animatedScene() {
    const scene = createScene({ skinned: true });
    const { w, viewer, context } = scene;
    w.showMessage = noop;
    w.setInterfaceMode = noop;
    w.hydrateCharacterSceneModels = async () => true;
    viewer.setSkinMode = noop;
    w.captureAnimationEdits = noop;
    w.exportParams.editor_mode = "animation";
    w._animationInitialized = true;
    w.animationState = createDefaultAnimationState({ bones: { head: [0, 0, 0] } });
    setTrackKeyframeFromEuler(w.animationState, "head", 0, [25, 0, 0]);
    w.getActiveCharacter().animationState = w.animationState;
    context.console = { ...console, warn: noop, error: noop };
    return scene;
}

async function importJSON(scene, payload) {
    let reader;
    scene.context.FileReader = class { constructor() { reader = this; } readAsText() {} };
    const input = { files: [{ name: "clip.json", type: "application/json" }], value: "clip.json" };
    scene.w.handleFileImport({ target: input });
    await reader.onload({ target: { result: JSON.stringify(payload) } });
    assert.equal(input.value, "");
}

test("animation JSON export and import preserve every character and its own keys", async () => {
    const source = animatedScene();
    const second = createPoseStudioCharacter({ id: "character-2", mesh: source.w.meshParams,
        transform: { x: 1, y: 0, z: 0, zoom: 0.75 }, poses: [{}] });
    second.animationState = createDefaultAnimationState({ bones: { head: [0, 0, 0] } });
    setTrackKeyframeFromEuler(second.animationState, "head", 0, [70, 0, 0]);
    source.w.characters.push(second);
    let blob;
    source.context.URL = { createObjectURL: value => { blob = value; return "blob:clip"; }, revokeObjectURL: noop };
    source.document.body.removeChild = noop;
    source.w.exportPose("animation", "scene");
    const exported = JSON.parse(await blob.text());
    assert.equal(exported.characters.length, 2);
    assert.equal(angle(exported.animation), 25, "legacy singleton mirror remains usable");

    const target = animatedScene();
    target.w._poseDataRestoreError = "previous corrupt workflow";
    await importJSON(target, exported);
    assert.equal(target.w._poseDataRestoreError, null);
    assert.equal(target.w.characters.length, 2);
    assert.deepEqual(target.w.characters.map(character => angle(character.animationState)), [25, 70]);
    assert.equal(target.w.characters[1].transform.x, 1);
    assert.equal(JSON.parse(target.node.widgets[0].value).characters.length, 2);
});

for (const failure of [false, true]) {
    test(`workflow tracks survive immediate reload while cache upload is ${failure ? "offline" : "pending"}`, async () => {
        const source = animatedScene();
        const secondary = createPoseStudioCharacter({ id: "character-2", mesh: source.w.meshParams, poses: [{}] });
        secondary.animationState = createDefaultAnimationState({ bones: { head: [0, 0, 0] } });
        setTrackKeyframeFromEuler(secondary.animationState, "head", 0, [70, 0, 0]);
        source.w.characters.push(secondary);
        let finish;
        source.context.fetch = () => failure ? Promise.reject(new Error("offline"))
            : new Promise(resolve => { finish = resolve; });
        sync(source.w);
        const uploading = source.w.flushAnimationCacheUpload();
        if (failure) assert.equal(await uploading, false);
        const workflow = JSON.parse(source.node.widgets[0].value);
        assert.equal(angle(workflow.animation.pendingAnimation), 25);
        const target = animatedScene();
        target.context.fetch = () => assert.fail("Unacknowledged tracks must restore from the workflow");
        target.node.widgets[0].value = source.node.widgets[0].value;
        target.w.loadFromNode();
        assert.equal(await target.w._animationCacheRestorePromise, true);
        assert.equal(angle(target.w.animationState), 25);
        assert.deepEqual(target.w.characters.map(character => angle(character.animationState)), [25, 70]);
        assert.equal(target.w._lastUploadedAnimationCacheId, null);
        sync(target.w);
        assert.equal(angle(JSON.parse(target.node.widgets[0].value).animation.pendingAnimation), 25);
        if (!failure) {
            finish({ ok: true });
            assert.equal(await uploading, true);
            sync(source.w);
            assert.equal(JSON.parse(source.node.widgets[0].value).animation.pendingAnimation, undefined);
        }
    });
}

test("an older upload acknowledgement cannot discard a newer pending workflow snapshot", async () => {
    const { w, node, context } = animatedScene();
    let finish;
    context.fetch = () => new Promise(resolve => { finish = resolve; });
    sync(w);
    const first = w.flushAnimationCacheUpload();
    setTrackKeyframeFromEuler(w.animationState, "head", 0, [85, 0, 0]);
    sync(w);
    const newerId = JSON.parse(node.widgets[0].value).animation.cacheId;
    finish({ ok: true });
    await first;
    sync(w);
    const latest = JSON.parse(node.widgets[0].value).animation;
    assert.equal(latest.cacheId, newerId);
    assert.equal(angle(latest.pendingAnimation), 85);
});

for (const unavailable of ["pending", "missing"]) {
    test(`animation ${unavailable} tracks cannot be replaced by an empty exported or library clip`, async () => {
        const { w, context } = animatedScene();
        const messages = [];
        w.showMessage = message => messages.push(message);
        if (unavailable === "pending") w._animationCacheRestorePending = true;
        else w._deferredAnimationReference = { storage: "server_cache", cacheId: "missing" };
        context.URL = { createObjectURL: () => assert.fail("Unavailable tracks cannot be exported") };
        w.saveLibraryPoseRecord = () => assert.fail("Unavailable tracks cannot overwrite a library item");
        assert.equal(w.exportPose("animation", "clip"), false);
        assert.equal(await w.saveToLibrary("clip", false), false);
        assert.equal(messages.length, 2);
        assert.ok(messages.every(message => /tracks are not loaded/i.test(message)));
    });
}

test("a failed worker rejects all pending model requests and blocks stale captures", async () => {
    const { w, context } = createScene();
    context.console = { ...console, warn: noop };
    w.showMessage = noop;
    let messages = 0;
    w._morphWorker = { postMessage: () => { messages++; } };
    const first = w.requestStaticMorphModel();
    const second = w.requestStaticMorphModel();
    w._morphSolveInFlight = true;
    w._pendingMorphSolve = { seq: 999 };
    w.handleMorphWorkerMessage({ type: "error", seq: w._morphSeq - 1, message: "asset unavailable" });
    await assert.rejects(first, /asset unavailable/);
    await assert.rejects(second, /asset unavailable/);
    assert.equal(w.ensureMorphWorker(), null);
    assert.equal(w.requestLiveMorph("weight"), false);
    assert.equal(messages, 2);
    assert.equal(w._morphSeqCharacterIds.size, 0);
    assert.equal(w._morphLoadTasks.size, 0);
    await assert.rejects(w.awaitReadyForCompositeCapture(), /body update failed/i);
    w.queueFullMeshUpdate = () => assert.fail("A failed worker must not queue another timed-out model load");
    w.onMeshParamsChanged("weight");
});
