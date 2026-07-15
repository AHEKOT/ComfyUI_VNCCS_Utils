import assert from "node:assert/strict";
import test from "node:test";

import {
    MODEL_ROTATION_TRACK,
    copyKeyframeSelection,
    createAnimationStateFromPoses,
    createClearedAnimationState,
    createDefaultAnimationState,
    computeVirtualTrackRange,
    computeVisibleFrameRange,
    eulerDegreesToQuaternion,
    evaluateAnimationFrame,
    findChangedPoseTracks,
    findNearestKeyframeAtPosition,
    findKeyframesInRange,
    moveKeyframeSelection,
    normalizeAnimationState,
    playbackFrameForElapsed,
    pasteKeyframeSelection,
    resolveCaptureCameraParams,
    restoreAnimationStateSnapshot,
    retimeAnimationFrameCount,
    retimeAnimationTiming,
    serializeAnimationStateSnapshot,
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
    const state = createDefaultAnimationState({}, { frameCount: 11, duration: 1, fps: 11 });
    setTrackKeyframeFromEuler(state, "head", 0, [0, 0, 0]);
    setTrackKeyframeFromEuler(state, "head", 5, [45, 0, 0]);
    setTrackKeyframeFromEuler(state, "head", 10, [90, 0, 0]);
    retimeAnimationFrameCount(state, 21);
    assert.deepEqual(state.tracks.head.keys.map(key => key.frame), [0, 10, 20]);
    assert.equal(state.duration, 1);
});

test("seconds and FPS always retime the internal frame count together", () => {
    const state = createDefaultAnimationState({}, { frameCount: 24, duration: 2 });
    retimeAnimationTiming(state, { duration: 25 });
    assert.equal(state.fps, 12);
    assert.equal(state.frameCount, 300);
    assert.equal(state.duration, 25);

    retimeAnimationTiming(state, { duration: 2.082 });
    assert.equal(state.fps, 12);
    assert.equal(state.frameCount, 25);
    assert.equal(state.duration, 2.082);

    retimeAnimationTiming(state, { duration: 10 });
    retimeAnimationTiming(state, { fps: 30 });
    assert.equal(state.fps, 30);
    assert.equal(state.frameCount, 300);
    assert.equal(state.duration, 10);
});

test("playback advances exactly FPS timeline frames per second", () => {
    assert.equal(playbackFrameForElapsed(0, 12), 0);
    assert.equal(playbackFrameForElapsed(250, 12), 3);
    assert.equal(playbackFrameForElapsed(1000, 12), 12);
    assert.equal(playbackFrameForElapsed(2082, 12), 24);
});

test("animation capture always uses the current yellow-frame camera", () => {
    const stalePoseCamera = { zoom: 4.5, offset_x: 3, offset_y: -2, yaw_deg: 30 };
    const yellowFrameCamera = { zoom: 1, offset_x: 0, offset_y: 0, yaw_deg: 0, pitch_deg: 0 };
    assert.deepEqual(
        resolveCaptureCameraParams(stalePoseCamera, yellowFrameCamera, true),
        yellowFrameCamera,
    );
    assert.equal(resolveCaptureCameraParams(stalePoseCamera, yellowFrameCamera, false).zoom, 4.5);
});

test("legacy derived FPS is migrated to the 12 FPS default", () => {
    const state = normalizeAnimationState({
        schemaVersion: 1,
        frameCount: 5,
        duration: 2.082,
        fps: 2.401,
        currentFrame: 3,
        tracks: {
            head: {
                keys: [
                    { frame: 0, rotation: [0, 0, 0] },
                    { frame: 4, rotation: [0, 45, 0] },
                ],
            },
        },
    });

    assert.equal(state.fps, 12);
    assert.equal(state.duration, 2.082);
    assert.equal(state.frameCount, 25);
    assert.equal(state.currentFrame, 18);
    assert.deepEqual(state.tracks.head.keys.map(key => key.frame), [0, 24]);
});

test("dense timelines virtualize rows and offscreen frame markers", () => {
    const topRows = computeVirtualTrackRange({ count: 100, scrollTop: 0, viewportHeight: 200 });
    assert.deepEqual(topRows, { start: 0, end: 18 });

    const middleRows = computeVirtualTrackRange({ count: 100, scrollTop: 1280, viewportHeight: 200 });
    assert.ok(middleRows.start > 0);
    assert.ok(middleRows.end - middleRows.start <= 18);

    const firstFrames = computeVisibleFrameRange({
        frameCount: 600,
        laneWidth: 7200,
        scrollLeft: 0,
        viewportWidth: 1200,
    });
    assert.equal(firstFrames.start, 0);
    assert.ok(firstFrames.end < 200);

    const laterFrames = computeVisibleFrameRange({
        frameCount: 600,
        laneWidth: 7200,
        scrollLeft: 3600,
        viewportWidth: 1200,
    });
    assert.ok(laterFrames.start > 200);
    assert.ok(laterFrames.end < 500);
});

test("canvas key hit testing finds only nearby frames", () => {
    const keys = [{ id: "a", frame: 2 }, { id: "b", frame: 20 }, { id: "c", frame: 40 }];
    assert.equal(findNearestKeyframeAtPosition(keys, 200, 400, 41)?.id, "b");
    assert.equal(findNearestKeyframeAtPosition(keys, 215, 400, 41), null);
});

test("marquee selection supports grouped moves without collapsing key spacing", () => {
    const state = createDefaultAnimationState({}, { duration: 1, fps: 12 });
    const headA = setTrackKeyframeFromEuler(state, "head", 1, [0, 0, 0], "linear");
    const headB = setTrackKeyframeFromEuler(state, "head", 4, [0, 20, 0], "easeIn");
    setTrackKeyframeFromEuler(state, "head", 6, [0, 40, 0], "linear");
    setTrackKeyframeFromEuler(state, "arm", 2, [10, 0, 0], "linear");

    const selected = findKeyframesInRange(state, ["head", "arm"], {
        startTrack: 0,
        endTrack: 0,
        startFrame: 0.5,
        endFrame: 4.5,
    });
    assert.deepEqual(selected.map(item => item.keyId), [headA.id, headB.id]);

    const moved = moveKeyframeSelection(state, selected, 2);
    assert.equal(moved.delta, 2);
    assert.deepEqual(state.tracks.head.keys.map(key => key.frame), [0, 3, 6]);
    assert.deepEqual(moved.selections.map(item => item.frame), [3, 6]);
});

test("copied key groups paste at the playhead with values and interpolation", () => {
    const state = createDefaultAnimationState({}, { duration: 1, fps: 12 });
    const first = setTrackKeyframeFromEuler(state, "head", 1, [0, 10, 0], "easeIn");
    const second = setTrackKeyframeFromEuler(state, "arm", 4, [20, 0, 0], "easeOut");
    const clipboard = copyKeyframeSelection(state, [
        { trackName: "head", keyId: first.id },
        { trackName: "arm", keyId: second.id },
    ]);
    const pasted = pasteKeyframeSelection(state, clipboard, 7);

    assert.deepEqual(pasted.map(item => item.frame), [7, 10]);
    assert.equal(state.tracks.head.keys.find(key => key.frame === 7).interpolation, "easeIn");
    assert.equal(state.tracks.arm.keys.find(key => key.frame === 10).interpolation, "easeOut");
});

test("animation reset clears every track while preserving timeline settings", () => {
    const state = createDefaultAnimationState({ bones: { head: [5, 0, 0] }, prompt: "keep" }, {
        duration: 4,
        fps: 12,
        loop: false,
        autoKey: false,
    });
    setTrackKeyframeFromEuler(state, "head", 0, [5, 0, 0], "linear");
    setTrackKeyframeFromEuler(state, "head", 20, [30, 0, 0], "easeIn");
    setTrackKeyframeFromEuler(state, "arm", 10, [0, 15, 0], "easeOut");

    const cleared = createClearedAnimationState(state, {
        bones: {},
        modelRotation: [0, 0, 0],
        prompt: "keep",
    });
    assert.deepEqual(cleared.tracks, {});
    assert.deepEqual(cleared.basePose.bones, {});
    assert.deepEqual(cleared.basePose.modelRotation, [0, 0, 0]);
    assert.equal(cleared.currentFrame, 0);
    assert.equal(cleared.frameCount, state.frameCount);
    assert.equal(cleared.duration, state.duration);
    assert.equal(cleared.fps, state.fps);
    assert.equal(cleared.loop, false);
    assert.equal(cleared.autoKey, false);
});

test("one history snapshot restores all keys removed by a grouped delete or reset", () => {
    const state = createDefaultAnimationState({}, { duration: 2, fps: 12 });
    setTrackKeyframeFromEuler(state, "head", 0, [0, 0, 0], "linear");
    setTrackKeyframeFromEuler(state, "head", 12, [0, 30, 0], "easeIn");
    setTrackKeyframeFromEuler(state, "arm", 3, [15, 0, 0], "easeOut");
    setTrackKeyframeFromEuler(state, "arm", 18, [45, 0, 0], "hold");
    setTrackKeyframeFromEuler(state, MODEL_ROTATION_TRACK, 6, [0, 20, 0], "smooth");
    const expectedTracks = JSON.parse(JSON.stringify(state.tracks));
    const snapshot = serializeAnimationStateSnapshot(state);

    state.tracks = {};
    const restored = restoreAnimationStateSnapshot(snapshot, { currentFrame: 7 });
    assert.deepEqual(restored.tracks, expectedTracks);
    assert.equal(restored.currentFrame, 7);
    assert.equal(Object.values(restored.tracks).reduce((sum, track) => sum + track.keys.length, 0), 7);
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
    assert.equal(state.fps, 12);
    assert.equal(state.frameCount, 24);
    assert.deepEqual(state.tracks.head.keys.map(key => key.frame), [0, 23]);
    assert.equal(state.tracks.head.keys[0].id, "new");
});

test("Mixamo-style pose samples become one keyed animation clip", () => {
    const poses = [
        { bones: { head: [0, 0, 0] }, modelRotation: [0, 0, 0] },
        { bones: { head: [0, 20, 0], upperarm_l: [10, 0, 0] }, modelRotation: [0, 5, 0] },
        { bones: { head: [0, 0, 0] }, modelRotation: [0, 10, 0] },
    ];
    const state = createAnimationStateFromPoses(poses, { duration: 0.25, fps: 12 });

    assert.equal(state.frameCount, 3);
    assert.equal(state.duration, 0.25);
    assert.deepEqual(state.tracks.head.keys.map(key => key.frame), [0, 1, 2]);
    assert.deepEqual(state.tracks.upperarm_l.keys.map(key => key.frame), [0, 1, 2]);
    assert.deepEqual(state.tracks[MODEL_ROTATION_TRACK].keys.map(key => key.frame), [0, 1, 2]);

    const lastFrame = evaluateAnimationFrame(state, 2);
    assert.ok(angleDistance(lastFrame.bones.head[1], 0) < 1e-6);
    assert.ok(angleDistance(lastFrame.bones.upperarm_l[0], 0) < 1e-6);
    assert.ok(angleDistance(lastFrame.modelRotation[1], 10) < 1e-6);
});
