import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createScene, Element } from "./helpers/pose_studio_scene.mjs";
import { createDefaultAnimationState } from "../web/pose_studio/animation.mjs";

const noop = () => {};
const source = await fs.readFile(new URL("../web/vnccs_pose_studio.js", import.meta.url), "utf8");
function restoreScene() {
    const scene = createScene();
    scene.w.hydrateCharacterSceneModels = async () => {};
    scene.w.setInterfaceMode = noop;
    scene.viewer.setSkinMode = noop;
    scene.messages = [];
    scene.w.showMessage = (message, error) => scene.messages.push({ message, error });
    scene.context.console = { ...console, error: noop };
    return scene;
}

for (const raw of ['{"poses": [', 'null', '[]', '{"poses":"damaged"}', '{"mesh":[25]}', '{"schema_version":4,"poses":[{"prompt":"future authored state"}]}']) {
    test(`failed workflow restoration retains the original state: ${raw}`, async () => {
        const { w, node, messages } = restoreScene();
        const valid = node.widgets[0].value;
        node.widgets[0].value = raw;
        w.loadFromNode();
        w.applyEditorMode();
        w.exportParams.cam_yaw_deg = 45;
        w.syncToNode(false, { skipCaptureUpload: true });
        assert.equal(node.widgets[0].value, raw, "ordinary updates cannot replace the failed restore");
        assert.throws(() => w.syncToNode(true, { executionCapture: true }), /restor/i);
        assert.ok(messages.some(item => item.error && /preserved/i.test(item.message)));
        node.widgets[0].value = valid;
        w.loadFromNode();
        await Promise.resolve();
        w.exportParams.cam_yaw_deg = 30;
        w.syncToNode(false, { skipCaptureUpload: true });
        assert.equal(JSON.parse(node.widgets[0].value).export.cam_yaw_deg, 30);
    });
}

for (const boundary of ["legacy pose", "character pose", "character pose set", "animation base pose", "pending animation base pose"]) {
    test(`invalid workflow ${boundary} retains the authored scene before model hydration`, async () => {
        const { w, viewer, node, messages } = restoreScene();
        const authored = JSON.stringify(w.characters);
        const invalid = { bones: { head: ["damaged", 0, 0] } };
        const data = JSON.parse(node.widgets[0].value);
        if (boundary === "legacy pose") {
            delete data.characters;
            delete data.image_poses;
            data.poses = [invalid];
        } else if (boundary === "character pose") data.characters[0].poses.push(invalid);
        else if (boundary === "character pose set") data.characters[0].poses = "damaged";
        else if (boundary === "animation base pose") data.characters[0].animation = { basePose: invalid };
        else data.animation = { storage: "server_cache", cacheId: "saved-animation", pendingAnimation: { basePose: invalid } };
        const raw = node.widgets[0].value = JSON.stringify(data);
        viewer.history = ["authored undo"];
        viewer.future = ["authored redo"];
        let hydrations = 0;
        w.hydrateCharacterSceneModels = async () => { hydrations++; };
        w.loadFromNode();
        await Promise.resolve();
        w.syncToNode(false, { skipCaptureUpload: true });
        assert.equal(node.widgets[0].value, raw);
        assert.equal(JSON.stringify(w.characters), authored);
        assert.deepEqual(viewer.history, ["authored undo"]);
        assert.deepEqual(viewer.future, ["authored redo"]);
        assert.equal(hydrations, 0);
        assert.ok(messages.some(item => item.error && /Invalid pose/i.test(item.message)));
        assert.throws(() => w.syncToNode(true, { executionCapture: true }), /restor/i);
    });
}

test("malformed workflow JSON preserves undo/redo and the active SAM camera", () => {
    const { w, viewer, node } = restoreScene();
    const frame = { fov: 35, cameraPosition: { x: 0, y: 10, z: 40 } };
    viewer.setSAMProjectionCameraFrame(frame);
    w._samCamStoredProjectionFrame = frame;
    w._samCameraModeActive = true;
    viewer.history = ["authored undo"];
    viewer.future = ["authored redo"];
    node.widgets[0].value = "invalid";
    w.loadFromNode();
    assert.deepEqual(viewer.history, ["authored undo"]);
    assert.deepEqual(viewer.future, ["authored redo"]);
    assert.equal(viewer._samProjectionCameraFrame, frame);
    assert.equal(w._samCamStoredProjectionFrame, frame);
    assert.equal(w._samCameraModeActive, true);
});

for (const [name, invalid] of [
    ["mesh null", { mesh: { weight: null } }],
    ["mesh object", { mesh: { weight: {} } }],
    ["mesh boolean", { mesh: { weight: false } }],
    ["mesh nonnumeric string", { mesh: { weight: "damaged" } }],
    ["character mesh", { characters: [{ id: "replacement", mesh: { weight: null } }] }],
    ["background color", { export: { bg_color: null } }],
    ["light object", { lights: [null] }],
    ["light scalar", { lights: [{ type: "point", x: "damaged" }] }],
]) {
    test(`invalid workflow ${name} preserves the authored controls, scene, history and SAM camera`, () => {
        const { w, viewer, node, messages } = restoreScene();
        w.createSliderField("Weight", "weight", 0, 1, 0.01, 0.5, w.meshParams);
        w.exportWidgets.bg_color = new Element();
        w.lightListContainer = new Element();
        const mesh = w.meshParams, settings = w.exportParams, lights = w.lightParams, characters = w.characters;
        const before = JSON.stringify({ mesh, settings, lights, characters, pose: viewer.getPose() });
        const frame = { fov: 35, cameraPosition: { x: 0, y: 10, z: 40 } };
        viewer.setSAMProjectionCameraFrame(frame);
        w._samCamStoredProjectionFrame = frame;
        w._samCameraModeActive = true;
        viewer.history = ["authored undo"];
        viewer.future = ["authored redo"];
        w.hydrateCharacterSceneModels = () => assert.fail("Invalid controls must fail before hydration");
        const raw = node.widgets[0].value = JSON.stringify({ ...JSON.parse(node.widgets[0].value), ...invalid });
        w.loadFromNode();
        w.syncToNode(false, { skipCaptureUpload: true });
        assert.equal(node.widgets[0].value, raw);
        assert.equal(w.meshParams, mesh);
        assert.equal(w.exportParams, settings);
        assert.equal(w.lightParams, lights);
        assert.equal(w.characters, characters);
        assert.equal(JSON.stringify({ mesh, settings, lights, characters, pose: viewer.getPose() }), before);
        assert.deepEqual(viewer.history, ["authored undo"]);
        assert.deepEqual(viewer.future, ["authored redo"]);
        assert.equal(viewer._samProjectionCameraFrame, frame);
        assert.equal(w._samCamStoredProjectionFrame, frame);
        assert.equal(w._samCameraModeActive, true);
        assert.ok(messages.some(item => item.error && /Invalid pose/i.test(item.message)));
    });
}

test("finite legacy mesh, background and light strings restore as numbers while unknown metadata remains intact", async () => {
    const { w, node, messages } = restoreScene();
    w.createSliderField("Weight", "weight", 0, 1, 0.01, 0.5, w.meshParams);
    w.exportWidgets.bg_color = new Element();
    const data = JSON.parse(node.widgets[0].value);
    delete data.characters;
    data.mesh.weight = "0.8";
    data.mesh.arm_length = "0.6";
    data.mesh.future_setting = { retained: true };
    data.export.bg_color = ["40", "50", "60"];
    data.lights = [{ type: "ambient", intensity: "0.7", future_setting: { retained: true } }];
    node.widgets[0].value = JSON.stringify(data);
    w.loadFromNode();
    await Promise.resolve();
    assert.equal(w._poseDataRestoreError, null);
    assert.equal(w.meshParams.weight, 0.8);
    assert.equal(w.meshParams.arm_length, 0.6);
    assert.equal(w.sliders.weight.label.innerText, "0.80");
    assert.equal(JSON.stringify(w.meshParams.future_setting), '{"retained":true}');
    assert.equal(JSON.stringify(w.exportParams.bg_color), "[40,50,60]");
    assert.equal(w.lightParams[0].intensity, 0.7);
    assert.equal(JSON.stringify(w.lightParams[0].future_setting), '{"retained":true}');
    w.loadFromNode();
    await Promise.resolve();
    assert.equal(w._poseDataRestoreError, null);
    assert.deepEqual(messages, []);
});

for (const fails of [false, true]) {
    test(`an older animation cache ${fails ? "failure" : "completion"} cannot mutate a failed workflow restoration`, async () => {
        const { w, node, context, messages } = restoreScene();
        const before = w.animationSnapshot();
        let finish;
        context.fetch = () => new Promise(resolve => { finish = resolve; });
        context.console = { ...console, warn: noop, error: noop };
        const pending = w.restoreAnimationFromCache({ cacheId: "older-animation" });
        node.widgets[0].value = "invalid";
        w.loadFromNode();
        const errors = messages.slice();
        finish({ ok: !fails, status: 404, json: async () => ({ animation: createDefaultAnimationState({ bones: { head: [45, 0, 0] } }) }) });
        assert.equal(await pending, false);
        assert.equal(w.animationSnapshot(), before);
        assert.equal(w._animationCacheRestorePending, false);
        assert.equal(w._deferredAnimationReference, null);
        assert.equal(node.widgets[0].value, "invalid");
        assert.deepEqual(messages, errors);
    });
}

for (const nested of [false, true]) {
    test(`invalid ${nested ? "secondary character" : "primary"} animation cache preserves the authored timeline`, async () => {
        const { w, node, context } = restoreScene();
        const before = w.animationSnapshot();
        const characterState = w.getActiveCharacter().animationState;
        const raw = node.widgets[0].value;
        const reference = { cacheId: "invalid-animation" };
        const invalid = createDefaultAnimationState({ bones: { head: ["damaged", 0, 0] } });
        const animation = nested ? {
            ...createDefaultAnimationState({}),
            primaryCharacterId: "character-2",
            characterAnimations: [{ id: "character-1", animation: invalid }],
        } : invalid;
        context.fetch = async () => ({ ok: true, json: async () => ({ animation }) });
        context.console = { ...console, warn: noop, error: noop };
        assert.equal(await w.restoreAnimationFromCache(reference), false);
        assert.equal(w.animationSnapshot(), before);
        assert.equal(w.getActiveCharacter().animationState, characterState);
        assert.equal(w._deferredAnimationReference, reference);
        assert.equal(node.widgets[0].value, raw);
    });
}

test("workflow restoration accepts partial legacy poses and numeric rotation strings", async () => {
    const { w, node, messages } = restoreScene();
    const poses = [{ prompt: "rest" }, { bones: { head: ["35", 0, 0] } }];
    node.widgets[0].value = JSON.stringify({ schema_version: 1, poses });
    w.loadFromNode();
    await Promise.resolve();
    assert.deepEqual(JSON.parse(JSON.stringify(w.poses[1].bones)), poses[1].bones);
    assert.equal(w._poseDataRestoreError, null);
    assert.deepEqual(messages, []);
});

test("an empty new workflow clears a failed restore guard and remains editable", () => {
    const { w, node } = restoreScene();
    node.widgets[0].value = "invalid";
    w.loadFromNode();
    node.widgets[0].value = "";
    w.loadFromNode();
    w.setPosePrompt(0, "new pose");
    w.syncToNode(false, { skipCaptureUpload: true });
    assert.equal(JSON.parse(node.widgets[0].value).poses[0].prompt, "new pose");
});

test("saving during character restoration cannot capture the previous viewer pose into the workflow", async () => {
    const { w, node, viewer, context } = createScene({ skinned: true });
    w.setInterfaceMode = noop;
    viewer.setSkinMode = noop;
    viewer.waitForCaptureReady = async () => {};
    w.showMessage = noop;
    context.console = { ...console, error: noop };
    let rejectModel;
    w.loadModel = () => new Promise((_resolve, reject) => { rejectModel = reject; });
    const data = JSON.parse(node.widgets[0].value);
    data.characters[0].poses[0].bones.head = [45, 0, 0];
    const raw = node.widgets[0].value = JSON.stringify(data);
    w.loadFromNode();
    w.syncToNode(false, { skipCaptureUpload: true });
    assert.equal(node.widgets[0].value, raw);
    assert.equal(w.container.inert, true);
    rejectModel(new Error("model unavailable"));
    await w._sceneModelHydrationPromise.catch(noop);
    w.syncToNode(false, { skipCaptureUpload: true });
    assert.equal(node.widgets[0].value, raw);
    assert.equal(w.container.inert, false, "Import and Reset remain available after failure");
});

test("serialization writes the visible transient frame into an already collected workflow payload without notifications", () => {
    const { w, node, context, viewer } = createScene();
    w.exportParams.editor_mode = "animation";
    w.ensureAnimationInitialized();
    w.syncToNode(false, { skipCapture: true, skipCaptureUpload: true });
    const previous = node.widgets[0].value;
    w.applyAnimationFrame(5, { transient: true });
    assert.equal(node.widgets[0].value, previous);
    let hooks = 0;
    const nodeType = { prototype: { onSerialize(value) { hooks++; value.originalHook = true; } } };
    node.studioWidget = w;
    const start = source.indexOf("        const onSerialize = nodeType.prototype.onSerialize;");
    if (start >= 0) vm.runInNewContext(source.slice(start, source.indexOf("        const onRemoved =", start)), { nodeType });
    context.app.graph.setDirtyCanvas = () => assert.fail("Serialization cannot notify the graph");
    node.widgets[0].callback = () => assert.fail("Serialization cannot notify the hidden widget");
    viewer.capture = () => assert.fail("Serialization cannot capture PNG frames");
    const payload = { widgets_values: [previous] };
    nodeType.prototype.onSerialize.call(node, payload);
    assert.equal(JSON.parse(payload.widgets_values[0]).animation.currentFrame, 5);
    assert.equal(payload.widgets_values[0], node.widgets[0].value);
    assert.equal(hooks, 1);
    assert.equal(payload.originalHook, true);
    assert.equal(w._animationUndoStack.length, 0);
});

test("failed character hydration preserves the authored workflow", async () => {
    const { w, node, messages } = restoreScene();
    const authored = node.widgets[0].value;
    const failures = [];
    w.hydrateCharacterSceneModels = () => new Promise((_resolve, reject) => failures.push(reject));
    w.loadFromNode();
    failures[0](new Error("missing model"));
    await Promise.resolve();
    await Promise.resolve();
    w.syncToNode(false, { skipCaptureUpload: true });
    assert.equal(node.widgets[0].value, authored);
    assert.throws(() => w.syncToNode(true, { executionCapture: true }), /restor/i);
    assert.equal(messages.length, 1);
});

test("a replacement workflow retries its own character hydration after an older in-flight load fails", async () => {
    const { w, node, viewer, context } = createScene();
    w.setInterfaceMode = noop;
    viewer.setSkinMode = noop;
    viewer.waitForCaptureReady = async () => {};
    const messages = [], loads = [];
    w.showMessage = message => messages.push(message);
    context.console = { ...console, error: noop };
    w.loadModel = () => new Promise((resolve, reject) => loads.push({ character: w.activeCharacterId, resolve, reject }));
    w.loadFromNode();
    const replacement = JSON.parse(node.widgets[0].value);
    replacement.characters[0].id = "replacement-character";
    replacement.active_character_id = "replacement-character";
    node.widgets[0].value = JSON.stringify(replacement);
    w.loadFromNode();
    loads[0].reject(new Error("old missing model"));
    for (let index = 0; index < 20; index++) await Promise.resolve();
    assert.deepEqual(loads.map(load => load.character), ["character-1", "replacement-character"]);
    loads[1].resolve(true);
    await w._sceneModelHydrationPromise;
    assert.equal(w.activeCharacterId, "replacement-character");
    assert.equal(w._poseDataRestoreError, null);
    assert.deepEqual(messages, []);
});

test("camera sliders persist the visible value while the pointer remains down", () => {
    const { w, node } = createScene();
    const slider = w.exportWidgets.cam_yaw_deg;
    slider.emit("pointerdown");
    slider.value = "65";
    slider.emit("input");
    assert.equal(w._poseGestureActive, true);
    assert.equal(JSON.parse(node.widgets[0].value).export.cam_yaw_deg, 65);
    slider.emit("pointerup");
});

test("pending live body morphs persist the newest settings before worker completion", () => {
    const { w, node } = createScene();
    w.requestLiveMorph = () => true;
    w.meshParams.weight = 0.8;
    w.onMeshParamsChanged("weight", { liveOnly: true });
    assert.equal(JSON.parse(node.widgets[0].value).mesh.weight, 0.8);
});

test("single-pose JSON import retains the exported prompt in UI and workflow state", async () => {
    const { w, node, context } = createScene({ skinned: true });
    let reader;
    context.FileReader = class { constructor() { reader = this; } readAsText() {} };
    w.showMessage = noop;
    w._poseDataRestoreError = "An older state failed to restore";
    w.setPosePrompt(0, "old prompt");
    const payload = { type: "single_pose", bones: { head: [20, 0, 0] }, prompt: "saved {red|blue} portrait" };
    w.handleFileImport({ target: { files: [{ name: "pose.json", type: "application/json" }], value: "" } });
    await reader.onload({ target: { result: JSON.stringify(payload) } });
    assert.equal(w.getPosePrompt(), payload.prompt);
    assert.equal(w.exportParams.user_prompt, payload.prompt);
    assert.equal(JSON.parse(node.widgets[0].value).characters[0].poses[0].prompt, payload.prompt);
});

test("removing a widget while repository refresh starts cannot recreate its polling interval", async () => {
    const { w, context } = createScene();
    let finish, intervals = 0;
    context.fetch = () => new Promise(resolve => { finish = resolve; });
    context.setInterval = () => { intervals++; return 1; };
    const pending = w.autoRefreshEnabledPoseRepositories();
    w._disposed = true;
    finish({ json: async () => ({ task_id: "refresh", started: true }) });
    await pending;
    assert.equal(intervals, 0);
    assert.equal(w._autoRepoRefreshTimer, null);
});
