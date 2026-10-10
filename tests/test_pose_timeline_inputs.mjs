import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import * as animation from "../web/pose_studio/animation.mjs";

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
        }
        addEventListener(type, handler) { (this.events[type] ||= []).push(handler); }
        emit(type) { for (const handler of this.events[type] || []) handler({ target: this }); }
        append() {}
        appendChild() {}
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
