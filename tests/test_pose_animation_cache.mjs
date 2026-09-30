import test from "node:test";
import assert from "node:assert/strict";
import { createScene } from "./helpers/pose_studio_scene.mjs";
import { createAnimationCacheReference, createDefaultAnimationState } from "../web/vnccs_pose_animation.mjs";

function scene() {
    const result = createScene();
    const { w, viewer, context } = result;
    w.hydrateCharacterSceneModels = async () => {};
    w.setInterfaceMode = () => {};
    viewer.setSkinMode = () => {};
    result.messages = [];
    w.showMessage = message => result.messages.push(message);
    context.console = { ...console, warn: () => {}, error: (...args) => assert.fail(args.join(" ")) };
    return result;
}

function saveReference(s, mode = "image") {
    const data = JSON.parse(s.node.widgets[0].value);
    const reference = createAnimationCacheReference(createDefaultAnimationState({}), {
        cacheId: `${s.w.animationCacheNodePrefix()}saved`, revision: 7,
    });
    data.export.editor_mode = mode;
    data.animation = reference;
    data.characters[0].animation = { ...reference, characterId: data.characters[0].id };
    s.node.widgets[0].value = JSON.stringify(data);
    return reference;
}

test("a static pose survives repeated workflow round trips without becoming a cached animation", async () => {
    const s = scene();
    let requests = 0;
    s.context.fetch = async () => { requests++; throw new Error("No animation request expected"); };
    for (let index = 0; index < 4; index++) {
        s.w.loadFromNode(); s.w.syncToNode(false, { skipCapture: true, skipCaptureUpload: true });
        const data = JSON.parse(s.node.widgets[0].value);
        assert.equal(data.export.editor_mode, "image");
        assert.equal(data.animation, undefined);
        assert.ok(data.characters.every(character => character.animation === null));
        assert.equal(s.w._animationInitialized, false);
        assert.equal(await s.w.flushAnimationCacheUpload(), true);
    }
    assert.equal(requests, 0); assert.deepEqual(s.messages, []);
});

test("image mode preserves existing compact references without loading or uploading animation caches", async () => {
    const s = scene(), reference = saveReference(s);
    let requests = 0;
    s.context.fetch = async () => { requests++; throw new Error("No animation request expected"); };
    s.w.loadFromNode();
    for (let index = 0; index < 3; index++) {
        s.w.syncToNode(false, { skipCapture: true, skipCaptureUpload: true });
        assert.equal(await s.w.flushAnimationCacheUpload(), true);
        const data = JSON.parse(s.node.widgets[0].value);
        assert.equal(data.animation.cacheId, reference.cacheId);
        assert.equal(data.characters[0].animation.revision, 7);
        assert.equal(data.characters[0].animation.storage, reference.storage);
        s.w.loadFromNode();
    }
    assert.equal(requests, 0); assert.deepEqual(s.messages, []);
});

test("switching to animation mode restores deferred tracks exactly once", async () => {
    const s = scene(), reference = saveReference(s);
    let requests = 0;
    s.context.fetch = async url => {
        requests++; assert.ok(url.endsWith(reference.cacheId));
        return { ok: true, json: async () => ({ revision: 7, animation: createDefaultAnimationState({ spine: [0.1,0,0] }) }) };
    };
    s.w.loadFromNode(); assert.equal(requests, 0);
    s.w.setEditorMode("animation");
    s.w.ensureAnimationInitialized();
    assert.equal(await s.w._animationCacheRestorePromise, true);
    assert.equal(requests, 1); assert.equal(s.w._animationInitialized, true);
    assert.equal(s.w._deferredAnimationReference, null);
    assert.equal(s.w.animationState.basePose.spine[0], 0.1);
});

test("a genuinely missing animation warns in animation mode and keeps the original reference", async () => {
    const s = scene(), reference = saveReference(s, "animation");
    s.context.fetch = async () => ({ ok:false, status:404 });
    s.w.loadFromNode();
    assert.equal(await s.w._animationCacheRestorePromise, false);
    assert.equal(s.messages.length, 1); assert.match(s.messages[0], /Animation cache is missing/);
    assert.equal(await s.w.flushAnimationCacheUpload(), false);
    s.w.syncToNode(false, { skipCapture:true, skipCaptureUpload:true });
    assert.equal(JSON.parse(s.node.widgets[0].value).animation.cacheId, reference.cacheId);
});

test("a pending cache failure cannot interrupt image mode or a replacement static scene", async () => {
    for (const replaceScene of [false, true]) {
        const s = scene();
        const staticData = s.node.widgets[0].value;
        saveReference(s, "animation");
        let finish;
        s.context.fetch = () => new Promise(resolve => { finish = resolve; });
        s.w.loadFromNode(); const pending = s.w._animationCacheRestorePromise;
        if (replaceScene) {
            s.node.widgets[0].value = staticData;
            s.w.loadFromNode();
        } else s.w.setEditorMode("image");
        finish({ ok:false, status:404 });
        assert.equal(await pending, false);
        assert.deepEqual(s.messages, []);
        assert.equal(await s.w.flushAnimationCacheUpload(), true);
        if (replaceScene) assert.equal(s.w._deferredAnimationReference, null);
    }
});
