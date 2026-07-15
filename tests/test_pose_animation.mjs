import assert from "node:assert/strict";
import test from "node:test";

import {
    MODEL_ROTATION_TRACK,
    createDefaultAnimationState,
    eulerDegreesToQuaternion,
    evaluateAnimationFrame,
    findChangedPoseTracks,
    normalizeAnimationState,
    retimeAnimationFrameCount,
    setTrackKeyframeFromEuler,
} from "../web/vnccs_pose_animation.mjs";

const angleDistance = (a, b) => Math.abs(((b - a + 540) % 360) - 180);

test("quaternion animation follows the shortest path across 180 degrees", () => {
    const state = createDefaultAnimationState({}, { frameCount: 11, duration: 1 });
    setTrackKeyframeFromEuler(state, "upperarm_l", 0, [170, 0, 0], "linear");
    setTrackKeyframeFromEuler(state, "upperarm_l", 10, [-170, 0, 0], "linear");
    const midpoint = evaluateAnimationFrame(state, 5).bones.upperarm_l[0];
    assert.ok(angleDistance(midpoint, 180) < 1e-6);
    assert.ok(angleDistance(midpoint, 0) > 170);
});

test("hold keys retain their outgoing value", () => {
    const state = createDefaultAnimationState({}, { frameCount: 11 });
    setTrackKeyframeFromEuler(state, "head", 0, [15, 0, 0], "hold");
    setTrackKeyframeFromEuler(state, "head", 10, [75, 0, 0], "linear");
    assert.ok(angleDistance(evaluateAnimationFrame(state, 9).bones.head[0], 15) < 1e-6);
    assert.ok(angleDistance(evaluateAnimationFrame(state, 10).bones.head[0], 75) < 1e-6);
});

test("first late key creates an implicit frame-zero baseline", () => {
    const state = createDefaultAnimationState({ bones: { head: [5, 0, 0] } }, { frameCount: 20 });
    setTrackKeyframeFromEuler(state, "head", 10, [30, 0, 0], "linear");
    assert.deepEqual(state.tracks.head.keys.map(key => key.frame), [0, 10]);
    assert.ok(angleDistance(evaluateAnimationFrame(state, 0).bones.head[0], 5) < 1e-6);
});

test("retiming preserves normalized key positions", () => {
    const state = createDefaultAnimationState({}, { frameCount: 11 });
    setTrackKeyframeFromEuler(state, "head", 0, [0, 0, 0]);
    setTrackKeyframeFromEuler(state, "head", 5, [45, 0, 0]);
    setTrackKeyframeFromEuler(state, "head", 10, [90, 0, 0]);
    retimeAnimationFrameCount(state, 21);
    assert.deepEqual(state.tracks.head.keys.map(key => key.frame), [0, 10, 20]);
});

test("pose diff reports changed bones and model rotation only", () => {
    const expected = { bones: { head: [0, 0, 0] }, modelRotation: [0, 0, 0] };
    const actual = { bones: { head: [0, 12, 0], arm: [0, 0, 0] }, modelRotation: [0, 5, 0] };
    assert.deepEqual(findChangedPoseTracks(expected, actual).sort(), [MODEL_ROTATION_TRACK, "head"].sort());
});

test("normalization accepts snake_case and drops invalid duplicate data", () => {
    const state = normalizeAnimationState({
        frame_count: 5,
        duration_seconds: 2,
        base_pose: {},
        tracks: {
            head: {
                keys: [
                    { id: "old", frame: -2, rotation: [0, 0, 0] },
                    { id: "new", frame: 0, value: eulerDegreesToQuaternion([10, 0, 0]) },
                    { id: "end", frame: 99, rotation: [20, 0, 0], interpolation: "hold" },
                ],
            },
        },
    });
    assert.equal(state.frameCount, 5);
    assert.deepEqual(state.tracks.head.keys.map(key => key.frame), [0, 4]);
    assert.equal(state.tracks.head.keys[0].id, "new");
});

