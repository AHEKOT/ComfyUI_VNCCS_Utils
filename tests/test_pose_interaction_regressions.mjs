import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import * as animation from "../web/vnccs_pose_animation.mjs";
import * as characters from "../web/vnccs_pose_characters.mjs";
import * as THREE from "../web/three.module.js";
import { PoseViewerCore as Core } from "../web/vnccs_pose_studio_core.js";

const source = await fs.readFile(new URL("../web/vnccs_pose_studio.js", import.meta.url), "utf8");
const noop = () => {};
const plain = value => JSON.parse(JSON.stringify(value));
class Element {
    constructor() { this.style = {}; this.children = []; this.events = {}; }
    appendChild(child) { this.children.push(child); }
    addEventListener(type, handler) { (this.events[type] ||= []).push(handler); }
    emit(type, details = {}) { for (const fn of this.events[type] || []) fn({ type, button: 0, ...details }); }
}
function harness() {
    const frames = new Map();
    let nextFrame = 0;
    const document = { createElement: () => new Element(), activeElement: null };
    const context = { ...animation, ...characters, document, console, setTimeout, clearTimeout,
        requestAnimationFrame: fn => { frames.set(++nextFrame, fn); return nextFrame; },
        cancelAnimationFrame: id => frames.delete(id), app: { graph: {} }, Blob, URL,
    };
    const Widget = vm.runInNewContext(source.slice(source.indexOf("class PoseStudioWidget {"),
        source.indexOf("// === ComfyUI Extension Registration ===")) + "\nPoseStudioWidget", context);
    return { Widget, Core, document, frames, context };
}
function animationWidget(Widget) {
    let pose = { bones: { head: [0, 0, 0] }, modelRotation: [0, 0, 0] };
    const w = Object.assign(Object.create(Widget.prototype), {
        animationState: animation.createDefaultAnimationState(pose), _animationInitialized: true,
        _applyingAnimationPose: false, _animationUndoStack: [], _animationRedoStack: [],
        isAnimationMode: () => true,
        viewer: { isInitialized: () => true, getPose: () => pose, boneList: [] },
        animationTimeline: { renderTracks: noop },
        syncToNode() { this.captureAnimationEdits(); this.commitAnimationHistory(); },
    });
    w.resetAnimationHistory();
    return { w, setPose: next => { pose = next; } };
}

test("Undo and Redo synchronize through the viewer's configured callback", () => {
    const { Core } = harness();
    let pose = { bones: { head: [30, 0, 0] } };
    let saved = pose;
    let notifications = 0;
    const v = Object.assign(Object.create(Core.prototype), {
        history: [JSON.stringify({ bones: { head: [0, 0, 0] } })], future: [],
        getPose: () => pose, setPose: next => { pose = next; },
        options: { onPoseChange: next => { saved = next; notifications++; }, syncMode: "end" },
    });
    v.undo();
    assert.equal(saved.bones.head[0], 0);
    v.redo();
    assert.equal(saved.bones.head[0], 30);
    assert.equal(notifications, 2);
});

test("switching tabs clears both image history stacks before another pose becomes editable", () => {
    const { Widget, Core } = harness();
    const v = Object.assign(Object.create(Core.prototype), {
        history: [JSON.stringify({ bones: { head: [10, 0, 0] } })], future: ["{}"],
        visible: { bones: { head: [20, 0, 0] } },
        getPose() { return this.visible; }, setPose(p) { this.visible = p; }, isInitialized: () => true,
    });
    const w = Object.assign(Object.create(Widget.prototype), {
        viewer: v, activeTab: 0, poses: [v.visible, { bones: { head: [90, 0, 0] } }],
        stripSceneCameraFromPose: p => p, currentCameraParams: () => ({}), getPosePrompt: () => "",
        syncToNode: noop, refreshTabActiveState: noop, clearSAMCameraMode: noop, hideHandControlPopover: noop,
        syncPromptFieldToActiveTab: noop, restoreActivePoseCameraParams: noop,
        updateCharacterScene: noop, updateRotationSliders: noop, updateCaptureCameraPreview: noop,
    });
    w.switchTab(1);
    v.undo();
    assert.equal(v.visible.bones.head[0], 90);
    assert.equal(v.history.length, 0);
    assert.equal(v.future.length, 0);
});

test("pelvis translation keys interpolate, return to rest, and survive snapshot restoration", () => {
    const { Widget } = harness();
    const { w, setPose } = animationWidget(Widget);
    w.viewer.boneList = [{ name: "root" }];
    w.viewer.shapedBoneRestPositions = { root: { x: 0, y: 1, z: 0 } };
    w.animationState.currentFrame = 12;
    w.animationState.defaultInterpolation = "linear";
    setPose({ bones: {}, bonePositions: { root: [0, 0.5, 0] } });
    w.syncToNode();
    const track = animation.bonePositionTrackName("root");
    assert.deepEqual(plain(w.animationState.tracks[track].keys.map(key => key.frame)), [0, 12]);
    assert.deepEqual(plain(animation.evaluateAnimationFrame(w.animationState, 6).bonePositions.root), [0, 0.75, 0]);
    w.animationState.currentFrame = 23;
    setPose({ bones: {}, bonePositions: {} });
    w.syncToNode();
    const restored = animation.restoreAnimationStateSnapshot(animation.serializeAnimationStateSnapshot(w.animationState));
    assert.deepEqual(animation.evaluateAnimationFrame(restored, 12).bonePositions.root, [0, 0.5, 0]);
    assert.deepEqual(animation.evaluateAnimationFrame(restored, 23).bonePositions.root, [0, 1, 0]);
    assert.equal(restored.tracks[track].valueType, "vector3");
    assert.match(animation.humanizeBoneName(track), /Position$/);
});

test("position channels support key copy, paste, retiming and sampled animation import", () => {
    const state = animation.createAnimationStateFromPoses([
        { bones: {}, bonePositions: { root: [0, 1, 0] } },
        { bones: {}, bonePositions: { root: [0, 0.5, 0] } },
        { bones: {}, bonePositions: { root: [0, 1, 0] } },
    ], { fps: 12 });
    const track = animation.bonePositionTrackName("root");
    const key = state.tracks[track].keys[1];
    const copied = animation.copyKeyframeSelection(state, [{ trackName: track, keyId: key.id }]);
    animation.pasteKeyframeSelection(state, copied, 2);
    assert.deepEqual(animation.evaluateAnimationFrame(state, 2).bonePositions.root, [0, 0.5, 0]);
    animation.retimeAnimationTiming(state, { fps: 24 });
    const restored = animation.normalizeAnimationState(plain(state));
    assert.equal(restored.tracks[track].valueType, "vector3");
    assert.ok(restored.tracks[track].keys.every(key => key.value.length === 3));
});

test("continuous morphing displays intermediate results but rejects older and foreign results", () => {
    const { Widget } = harness();
    const displayed = [], sent = [];
    const worker = { postMessage: message => sent.push(message) };
    const w = Object.assign(Object.create(Widget.prototype), {
        activeCharacterId: "character-1", meshParams: { weight: 0.5 },
        _morphSeq: 0, _lastAppliedMorphSeq: 0, _morphSeqCharacterIds: new Map(), _morphLoadTasks: new Map(),
        _morphWorker: worker, _morphSolveInFlight: false, _pendingMorphSolve: null,
        ensureMorphWorker: () => worker, isLiveMorphKey: () => true,
        viewer: { isInitialized: () => true, updateBodyVertices: vertices => { displayed.push(vertices); return true; } },
        scheduleAllManagerPreviewRefresh: noop,
    });
    w.requestLiveMorph("weight");
    for (let i = 0; i < 12; i++) {
        w.meshParams.weight += 0.01;
        w.requestLiveMorph("weight");
        w.handleMorphWorkerMessage({ type: "result", seq: sent[i].seq, vertices: sent[i].params.weight });
    }
    assert.equal(displayed.length, 12);
    w.handleMorphWorkerMessage({ type: "result", seq: sent.at(-1).seq, vertices: sent.at(-1).params.weight });
    assert.equal(displayed.at(-1), w.meshParams.weight);
    w.handleMorphWorkerMessage({ type: "result", seq: 1, vertices: -1 });
    w._morphSeqCharacterIds.set(100, "character-2");
    w.handleMorphWorkerMessage({ type: "result", seq: 100, vertices: -2 });
    assert.equal(displayed.length, 13);
});

for (const kind of ["pointer", "keyboard"]) {
    test(`${kind} slider gesture updates live with exactly one animation Undo entry`, () => {
        const { Widget } = harness();
        const { w, setPose } = animationWidget(Widget);
        const control = new Element();
        w.trackPoseGesture(control);
        control.emit(kind === "pointer" ? "pointerdown" : "keydown", { key: "ArrowRight" });
        for (let angle = 1; angle <= 60; angle++) {
            setPose({ bones: {}, modelRotation: [angle, 0, 0] });
            control.emit("input");
            w.syncToNode();
            control.emit("change");
            assert.equal(w._animationUndoStack.length, 0);
            assert.ok(Math.abs(animation.evaluateAnimationFrame(w.animationState, 0).modelRotation[0] - angle) < 1e-6);
        }
        control.emit(kind === "pointer" ? "pointerup" : "keyup", { key: "ArrowRight" });
        assert.equal(w._animationUndoStack.length, 1);
        const restored = animation.restoreAnimationStateSnapshot(w._animationUndoStack[0]);
        assert.deepEqual(animation.evaluateAnimationFrame(restored, 0).modelRotation, [0, 0, 0]);
        control.emit("change");
        assert.equal(w._animationUndoStack.length, 1);
    });
}

test("gesture cancellation commits the visible edit once and releases history suppression", () => {
    const { Widget } = harness();
    const { w, setPose } = animationWidget(Widget);
    const control = new Element();
    w.trackPoseGesture(control);
    control.emit("pointerdown");
    setPose({ bones: { head: [20, 0, 0] } });
    w.syncToNode();
    w._handleDocumentPointerCancel();
    assert.equal(w._animationUndoStack.length, 1);
    assert.equal(w._poseGestureActive, false);
});

test("both Width controls update previews on input and synchronize the peer", () => {
    const { Widget, document } = harness();
    let previews = 0;
    const w = Object.assign(Object.create(Widget.prototype), {
        exportParams: { view_width: 1024 }, meshParams: {}, exportWidgets: {}, managerControls: {},
        resize: noop, updateCaptureCameraPreview: () => previews++, syncToNode: noop,
        schedulePoseManagerGridLayout: noop,
    });
    w.createInputField("Width", "view_width", "number", 64, 4096, 8);
    w.createManagerInput({ key: "view_width", min: 64, max: 4096, step: 8 });
    const main = w.exportWidgets.view_width;
    document.activeElement = main;
    main.value = "2048";
    main.emit("input");
    assert.equal(w.exportParams.view_width, 2048);
    assert.equal(w.managerControls.view_width.input.value, 2048);
    const manager = w.managerControls.view_width.input;
    document.activeElement = manager;
    manager.value = "1536";
    manager.emit("input");
    assert.equal(w.exportParams.view_width, 1536);
    assert.equal(main.value, 1536);
    assert.equal(previews, 2);
    manager.value = "";
    manager.emit("input");
    assert.equal(w.exportParams.view_width, 1536);
});

test("Manager Detail refreshes changed cards and RUN waits for that generation", async () => {
    const { Widget, frames } = harness();
    let pose = { bones: { head: [0, 0, 0] } };
    const w = Object.assign(Object.create(Widget.prototype), {
        node: { id: 1 }, activeTab: 0, poses: [pose], poseCaptures: ["OLD"],
        lightingPrompts: [""], posePrompts: [""], characters: [], sharedTimeline: {},
        exportParams: {}, interfaceMode: "managerDetail", _animationInitialized: false,
        viewer: { isInitialized: () => true, getPose: () => pose },
        isAnimationMode: () => false, captureActiveCharacterRuntime() { this.poses[0] = pose; },
        syncSharedTimelineFromActive: noop, stripSceneCameraFromPose: p => p,
        currentCameraParams: () => ({}), getPosePrompt: () => "", ensurePosePrompts: noop,
        queueCaptureUpload: noop, getNodeWidget: () => null, renderPoseManagerDetailStrip: noop,
        refreshAllManagerPreviews(generation) {
            this.poseCaptures[0] = `HEAD_${this.poses[0].bones.head[0]}`;
            this._managerPreviewRefreshCompletedGeneration = generation;
        },
    });
    pose = { bones: { head: [80, 0, 0] } };
    w.syncToNode(false);
    assert.equal(w.poseCaptures[0], "OLD");
    assert.throws(() => w.syncToNode(true, { executionCapture: true }), /still refreshing/);
    const ready = w.awaitCurrentManagerPreviews();
    for (const callback of frames.values()) callback();
    await ready;
    w.syncToNode(true, { executionCapture: true });
    assert.deepEqual(plain(w._executionCaptureSnapshot), ["HEAD_80"]);
    const generation = w._managerPreviewRefreshGeneration;
    w.syncToNode(false);
    assert.equal(w._managerPreviewRefreshGeneration, generation);
    w.lightParams = [{ intensity: 2 }];
    w.syncToNode(false);
    assert.ok(w._managerPreviewRefreshGeneration > generation);
});

test("single pose export preserves translated joints and other pose metadata", async () => {
    const { Widget, document, context } = harness();
    let exported;
    context.URL = { createObjectURL: blob => { exported = blob; return "blob:test"; }, revokeObjectURL: noop };
    document.createElement = () => ({ click: noop });
    document.body = { appendChild: noop, removeChild: noop };
    const pose = { bones: { root: [0, 0, 0] }, bonePositions: { root: [0, 0.5, 0] }, hipBonePosition: { hips: [0, 0.5, 0] } };
    const w = Object.assign(Object.create(Widget.prototype), {
        poses: [pose], activeTab: 0, viewer: { isInitialized: () => true, getPose: () => pose },
        stripSceneCameraFromPose: p => p, currentCameraParams: () => ({}), getPosePrompt: () => "pose prompt",
    });
    w.exportPose("single", "test");
    const data = JSON.parse(await exported.text());
    assert.equal(data.type, "single_pose");
    assert.deepEqual(data.bonePositions, pose.bonePositions);
    assert.deepEqual(data.hipBonePosition, pose.hipBonePosition);
    assert.equal(data.prompt, "pose prompt");
});

test("evaluated position channels restore the actual skeleton and neutral root survives export", () => {
    const root = new THREE.Bone();
    root.name = "root";
    root.position.set(0, 1, 0);
    root.userData.parentName = null;
    const child = new THREE.Bone();
    child.name = "spine";
    child.position.set(0, 0.2, 0);
    child.userData.parentName = "root";
    root.add(child);
    const mesh = new THREE.Object3D();
    mesh.add(root);
    const v = Object.assign(Object.create(Core.prototype), {
        bones: { root, spine: child }, boneList: [root, child], skinnedMesh: mesh,
        shapedBoneRestPositions: { root: root.position.clone(), spine: child.position.clone() },
        modelRotation: { x: 0, y: 0, z: 0 }, camera: new THREE.PerspectiveCamera(),
        orbit: { target: new THREE.Vector3(), update: noop }, requestRender: noop,
    });
    const base = v.getPose();
    assert.deepEqual(base.bonePositions.root, [0, 1, 0]);
    const state = animation.createDefaultAnimationState(base);
    const name = animation.bonePositionTrackName("root");
    animation.setTrackKeyframeFromEuler(state, name, 12, [0, 0.5, 0], "linear");
    v.setPose(animation.evaluateAnimationFrame(state, 6), true);
    assert.equal(root.position.y, 0.75);
    assert.equal(child.getWorldPosition(new THREE.Vector3()).y, 0.95);
    v.setPose(animation.evaluateAnimationFrame(state, 0), true);
    assert.equal(root.position.y, 1);
    assert.equal(v.getPose().bonePositions.root[1], 1);
});

test("age fitting updates intermediate shapes and waits for the latest shape before finishing", () => {
    const { Widget } = harness();
    let fits = 0, previews = 0;
    const w = Object.assign(Object.create(Widget.prototype), {
        activeCharacterId: "character-1", _morphSeq: 2, _lastAppliedMorphSeq: 0,
        _morphSeqCharacterIds: new Map([[1, "character-1"], [2, "character-1"]]),
        _morphLoadTasks: new Map(), pendingAgeCameraFit: true,
        viewer: { updateBodyVertices: () => { previews++; return true; } },
        applyAgeCameraFit: () => { fits++; return false; },
        flushPendingMorphSolve: noop, scheduleAllManagerPreviewRefresh: noop,
    });
    w.handleMorphWorkerMessage({ type: "result", seq: 1 });
    assert.equal(previews, 1);
    assert.equal(fits, 1);
    assert.equal(w.pendingAgeCameraFit, true);
    w.handleMorphWorkerMessage({ type: "result", seq: 2 });
    assert.equal(previews, 2);
    assert.equal(fits, 2);
    assert.equal(w.pendingAgeCameraFit, false);
});

test("manual root keys retain translation with Auto Key disabled", () => {
    const { Widget } = harness();
    const { w, setPose } = animationWidget(Widget);
    w.animationState.autoKey = false;
    w.viewer.boneList = [{ name: "root", userData: { parentName: null } }];
    w.viewer.shapedBoneRestPositions = { root: { x: 0, y: 1, z: 0 } };
    w.animationTimeline.updatePlayheads = noop;
    setPose({ bones: {}, bonePositions: { root: [0, 0.4, 0] } });
    w.addAnimationKey("root", 12);
    const pose = animation.evaluateAnimationFrame(w.animationState, 12);
    assert.deepEqual(plain(pose.bonePositions.root), [0, 0.4, 0]);
    assert.deepEqual(plain(animation.evaluateAnimationFrame(w.animationState, 0).bonePositions.root), [0, 1, 0]);
});
