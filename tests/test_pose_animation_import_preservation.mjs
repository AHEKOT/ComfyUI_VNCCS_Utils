import assert from "node:assert/strict";
import test from "node:test";
import { createScene } from "./helpers/pose_studio_scene.mjs";
import { createDefaultAnimationState } from "../web/pose_studio/animation.mjs";
import { createPoseStudioCharacter } from "../web/pose_studio/characters.mjs";

const noop = () => {};
const invalidClips = [
    ["transform", { baseTransform: { x: 0, y: 0, z: 0, zoom: 0 } }],
    ["track keys", { tracks: { head: { keys: {} } } }],
];

function authoredScene() {
    const scene = createScene();
    const { w, viewer, context } = scene;
    const frame = { fov: 35, cameraPosition: { x: 0, y: 10, z: 40 } };
    viewer.setSAMProjectionCameraFrame(frame);
    w._samCamStoredProjectionFrame = frame;
    w._samCameraModeActive = true;
    viewer.history = ["authored undo"];
    viewer.future = ["authored redo"];
    w.animationState.basePose.prompt = "authored clip";
    w.showMessage = noop;
    w.hydrateCharacterSceneModels = async () => assert.fail("Invalid animation must fail before hydration");
    context.console = { ...console, warn: noop, error: noop };
    return { ...scene, frame };
}

function snapshot(scene) {
    return {
        characters: scene.w.characters,
        scene: JSON.stringify(scene.w.characters),
        animation: scene.w.animationState,
        pose: JSON.stringify(scene.viewer.getPose()),
    };
}

function assertPreserved(scene, before) {
    assert.equal(scene.w.characters, before.characters);
    assert.equal(JSON.stringify(scene.w.characters), before.scene);
    assert.equal(scene.w.animationState, before.animation);
    assert.equal(JSON.stringify(scene.viewer.getPose()), before.pose);
    assert.equal(scene.viewer._samProjectionCameraFrame, scene.frame);
    assert.equal(scene.w._samCamStoredProjectionFrame, scene.frame);
    assert.equal(scene.w._samCameraModeActive, true);
    assert.deepEqual(scene.viewer.history, ["authored undo"]);
    assert.deepEqual(scene.viewer.future, ["authored redo"]);
}

for (const [name, invalid] of invalidClips) {
    for (const boundary of ["single animation", "character scene", "workflow", "pending workflow cache", "pending secondary workflow cache"]) {
        test(`${boundary} rejects invalid animation ${name} before changing the authored scene`, async () => {
            const scene = authoredScene();
            const { w, node } = scene;
            const before = snapshot(scene);
            const data = JSON.parse(node.widgets[0].value);
            const clip = { ...createDefaultAnimationState({}), ...invalid };
            if (boundary === "single animation") {
                assert.throws(() => w.loadAnimationLibraryAsset({ animation: clip }), /supported range|iterable/);
            } else if (boundary === "character scene") {
                data.characters.push(createPoseStudioCharacter({ id: "character-2", animation: clip }));
                await assert.rejects(w.loadCharacterSceneLibraryAsset(data, { animation: true }), /supported range|iterable/);
            } else {
                if (boundary === "workflow") data.characters.push(createPoseStudioCharacter({ id: "character-2", animation: clip }));
                else data.animation = {
                    storage: "server_cache", cacheId: "invalid-animation",
                    pendingAnimation: boundary === "pending workflow cache" ? clip : {
                        ...createDefaultAnimationState({}),
                        characterAnimations: [{ id: "character-2", animation: clip }],
                    },
                };
                const raw = node.widgets[0].value = JSON.stringify(data);
                w.loadFromNode();
                w.syncToNode(false, { skipCapture: true, skipCaptureUpload: true });
                assert.equal(node.widgets[0].value, raw);
                assert.ok(w._poseDataRestoreError);
                assert.throws(() => w.syncToNode(true, { executionCapture: true }), /restor/i);
            }
            assertPreserved(scene, before);
        });
    }

    test(`a secondary cached animation with invalid ${name} cannot partially replace the primary clip`, async () => {
        const scene = authoredScene();
        const { w, node, context } = scene;
        const character = createPoseStudioCharacter({ id: "character-2" });
        character.animationState = createDefaultAnimationState({ prompt: "authored secondary clip" });
        w.characters.push(character);
        const before = snapshot(scene);
        const raw = node.widgets[0].value;
        const reference = { cacheId: "invalid-animation" };
        const animation = {
            ...createDefaultAnimationState({ prompt: "replacement primary clip" }),
            primaryCharacterId: "character-1",
            characterAnimations: [{ id: "character-2", animation: { ...createDefaultAnimationState({}), ...invalid } }],
        };
        context.fetch = async () => ({ ok: true, json: async () => ({ animation }) });
        assert.equal(await w.restoreAnimationFromCache(reference), false);
        assertPreserved(scene, before);
        assert.equal(w._deferredAnimationReference, reference);
        assert.equal(node.widgets[0].value, raw);
    });
}
