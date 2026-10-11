import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createScene } from "./helpers/pose_studio_scene.mjs";

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
