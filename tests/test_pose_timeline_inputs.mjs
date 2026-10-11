import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import * as animation from "../web/pose_studio/animation.mjs";
import { createScene } from "./helpers/pose_studio_scene.mjs";

const source = await fs.readFile(new URL("../web/vnccs_pose_studio.js", import.meta.url), "utf8");
const noop = () => {};

function editor(t) {
    const previousDocument = globalThis.document;
    const document = { createElement: () => new Element(), defaultView: { addEventListener: noop }, activeElement: null };
    class Element {
        constructor() {
            this.events = {};
            this.style = { setProperty: noop };
            this.classList = { toggle: noop };
            this.ownerDocument = document;
            this.nodeType = 1;
            this.value = "";
            this.dataset = {};
        }
        addEventListener(type, handler) { (this.events[type] ||= []).push(handler); }
        removeEventListener(type, handler) { this.events[type] = (this.events[type] || []).filter(item => item !== handler); }
        emit(type, values = {}) {
            for (const handler of [...this.events[type] || []]) handler({ type, target: this,
                button: 0, pointerId: 1, stopPropagation: noop, ...values });
        }
        append() {}
        appendChild() {}
        focus() {}
        getBoundingClientRect() { return { left: 0, width: 230 }; }
        setPointerCapture(id) { this.pointerId = id; }
        hasPointerCapture(id) { return this.pointerId === id; }
        releasePointerCapture() { this.pointerId = null; }
        setAttribute() {}
        querySelectorAll() { return []; }
    }
    globalThis.document = document;
    t.after(() => { globalThis.document = previousDocument; });
    class Timeline extends animation.PoseAnimationTimeline {
        render() { this.updateToolbar(); }
        renderTracks() {}
        setVisible() {}
        updatePlayheads() { this.updateToolbar(); }
        _drawKeyLane() {}
        _refreshVisibleSelection() {}
        _scheduleKeyLaneDraw() {}
    }
    const Widget = vm.runInNewContext(source.slice(source.indexOf("class PoseStudioWidget {"),
        source.indexOf("// === ComfyUI Extension Registration ===")) + "\nPoseStudioWidget", {
        ...animation, PoseAnimationTimeline: Timeline, document, console,
    });
    const state = animation.createDefaultAnimationState({ bones: { head: [0, 0, 0] } });
    animation.setTrackKeyframeFromEuler(state, "head", 2, [10, 0, 0]);
    animation.setTrackKeyframeFromEuler(state, "head", 3, [20, 0, 0]);
    const other = JSON.parse(JSON.stringify(state));
    const previews = [];
    let saves = 0;
    const w = Object.assign(Object.create(Widget.prototype), {
        animationState: state, characters: [{ animationState: state }, { animationState: other }],
        _animationInitialized: true, exportParams: {},
        isAnimationMode: () => true,
        getActiveCharacter() { return this.characters[0]; },
        ensureCharacterRuntime: character => character,
        characterTransformForScene: () => ({ x: 0, y: 0, zoom: 1 }),
        viewer: { isInitialized: () => true, setPose: pose => previews.push(pose), setCameraParams: noop },
        currentCameraParams: () => ({}), syncCameraWidgets: noop,
        updateCharacterScene: noop, updateRotationSliders: noop,
        syncToNode() { saves++; this.commitAnimationHistory(); },
    });
    w.syncSharedTimelineFromActive();
    w.resetAnimationHistory();
    w._createAnimationTimeline(new Element());
    return { w, timeline: w.animationTimeline, document, other, previews, saves: () => saves };
}

test("frame input updates the pose before change and commits once", t => {
    const { w, timeline, previews, saves } = editor(t);
    timeline.frameInput.value = "5";
    timeline.frameInput.emit("input");
    assert.equal(w.animationState.currentFrame, 5);
    assert.equal(previews.length, 1);
    assert.equal(saves(), 0);
    timeline.frameInput.value = "";
    timeline.frameInput.emit("input");
    assert.equal(w.animationState.currentFrame, 5);
    timeline.frameInput.value = "5";
    timeline.frameInput.emit("change");
    assert.equal(saves(), 1);
});

test("FPS preview preserves all characters' keys and records one undo command", t => {
    const { w, timeline, document, other, previews, saves } = editor(t);
    document.activeElement = timeline.fpsInput;
    timeline.fpsInput.value = "1";
    timeline.fpsInput.emit("input");
    assert.equal(w.animationState.fps, 1);
    assert.equal(other.fps, 1);
    assert.ok(previews.length > 0);
    assert.equal(saves(), 0);
    timeline.fpsInput.value = "24";
    timeline.fpsInput.emit("input");
    assert.equal(timeline.fpsInput.value, "24");
    assert.equal(w.animationState.tracks.head.keys.length, 3);
    assert.equal(other.tracks.head.keys.length, 3);
    assert.equal(other.fps, 24);
    assert.equal(timeline.durationInput.value, "2");
    assert.equal(w._animationUndoStack.length, 0);
    timeline.fpsInput.emit("change");
    assert.equal(saves(), 1);
    assert.equal(w._animationUndoStack.length, 1);
    assert.deepEqual(JSON.parse(w._animationUndoStack[0]).tracks.head.keys.map(key => key.frame), [0, 2, 3]);
    assert.equal(timeline._timingBaseline, null);
    assert.equal(w._timelineTimingBaseline, null);
});

test("duration input updates timing continuously and ignores incomplete numbers", t => {
    const { w, timeline, document, other, saves } = editor(t);
    document.activeElement = timeline.durationInput;
    timeline.durationInput.value = "3.25";
    timeline.durationInput.emit("input");
    assert.equal(w.animationState.duration, 3.25);
    assert.equal(other.duration, 3.25);
    assert.equal(timeline.frameInput.max, "38");
    for (const invalid of ["", "NaN", "0", "-1"]) {
        timeline.durationInput.value = invalid;
        timeline.durationInput.emit("input");
        assert.equal(w.animationState.duration, 3.25);
    }
    timeline.durationInput.emit("change");
    assert.equal(saves(), 1);
    assert.equal(w._animationUndoStack.length, 1);
    document.activeElement = null;
    timeline.durationInput.emit("blur");
    assert.equal(timeline.durationInput.value, "3.25");
});

for (const control of ["frameInput", "fpsInput", "durationInput"]) {
    test(`${control} stops playback before applying the visible user value`, t => {
        const { timeline } = editor(t);
        const previousCancel = globalThis.cancelAnimationFrame;
        const cancelled = [];
        globalThis.cancelAnimationFrame = frame => cancelled.push(frame);
        t.after(() => { globalThis.cancelAnimationFrame = previousCancel; });
        timeline._playing = true;
        timeline._raf = 77;
        timeline[control].value = control === "frameInput" ? "5" : "24";
        timeline[control].emit("input");
        assert.equal(timeline._playing, false, "Playback must not overwrite the pointer's new value on the next frame");
        assert.equal(timeline._raf, null);
        assert.deepEqual(cancelled, [77]);
    });
}

test("automatic playback frames keep playback running", t => {
    const { timeline } = editor(t);
    timeline._playing = true;
    timeline._raf = 77;
    timeline.setFrame(5, { playback: true });
    assert.equal(timeline._playing, true);
    assert.equal(timeline._raf, 77);
});

function keyDrag(t) {
    const scene = editor(t);
    const { w, timeline } = scene;
    const { viewer } = createScene({ skinned: true });
    w.viewer = viewer;
    const setPose = viewer.setPose;
    viewer.setPose = function (pose, preserveCamera) {
        scene.previews.push(pose);
        setPose.call(this, pose, preserveCamera);
    };
    w.applyAnimationFrame(4, { transient: true });
    scene.previews.length = 0;
    const key = w.animationState.tracks.head.keys.at(-1);
    timeline._keyAtPointer = () => ({ frame: key.frame, members: [{ trackName: "head", key }] });
    const lane = timeline._makeLane({ type: "track", trackName: "head", trackNames: ["head"] });
    lane.emit("pointerdown", { clientX: 30 });
    return { ...scene, lane, key, viewer };
}

test("key dragging previews the affected pose continuously and release preserves that frame with one undo", t => {
    const { w, timeline, lane, key, viewer, previews, saves } = keyDrag(t);
    lane.emit("pointermove", { clientX: 80 });
    assert.equal(previews.length, 1, "The posed runtime must update before pointer release");
    const first = previews.at(-1).bones.head[0];
    assert.ok(first > 10 && first < 20);
    assert.ok(Math.abs(viewer.bones.head.rotation.x * 180 / Math.PI - first) < 1e-6);
    lane.emit("pointermove", { clientX: 60 });
    const last = previews.at(-1).bones.head[0];
    assert.notEqual(last, first, "Every held-pointer value must reach the posed runtime");
    assert.ok(Math.abs(viewer.bones.head.rotation.x * 180 / Math.PI - last) < 1e-6);
    assert.equal(saves(), 0);
    assert.equal(w._animationUndoStack.length, 0);
    lane.emit("pointerup");
    assert.equal(w.animationState.currentFrame, 4, "Release must retain the visible playhead and pose");
    assert.equal(previews.at(-1).bones.head[0], last);
    assert.ok(Math.abs(viewer.bones.head.rotation.x * 180 / Math.PI - last) < 1e-6);
    assert.equal(w.animationState.tracks.head.keys.find(item => item.id === key.id).frame, 6);
    assert.equal(saves(), 1);
    assert.equal(w._animationUndoStack.length, 1);
    assert.equal(timeline._activeKeyDragCancel, null);
});

test("key drag previews retain collided keys and cancellation restores the original pose without an undo", t => {
    const { w, lane, key, previews, saves } = keyDrag(t);
    const before = w.animationSnapshot();
    lane.emit("pointermove", { clientX: 20 });
    lane.emit("pointermove", { clientX: 60 });
    assert.deepEqual(w.animationState.tracks.head.keys.map(item => item.frame), [0, 2, 6]);
    lane.emit("pointercancel");
    assert.equal(w.animationSnapshot(), before);
    assert.equal(w.animationState.tracks.head.keys.find(item => item.id === key.id).frame, 3);
    assert.ok(Math.abs(previews.at(-1).bones.head[0] - 20) < 1e-6);
    assert.equal(saves(), 0);
    assert.equal(w._animationUndoStack.length, 0);
});

test("replacing timeline state closes the previous key drag before late pointer events", t => {
    const { timeline, lane, saves } = keyDrag(t);
    lane.emit("pointermove", { clientX: 60 });
    const replacement = JSON.parse(JSON.stringify(timeline.state));
    const before = JSON.stringify(replacement);
    timeline.setState(replacement);
    lane.emit("pointermove", { clientX: 80 });
    lane.emit("pointerup");
    assert.equal(JSON.stringify(replacement), before);
    assert.equal(timeline._activeKeyDragCancel, null);
    assert.equal(saves(), 0);
});
