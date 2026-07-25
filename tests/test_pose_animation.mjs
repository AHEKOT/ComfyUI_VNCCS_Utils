import assert from "node:assert/strict";
import test from "node:test";

import {
    CHARACTER_POSITION_TRACK,
    CHARACTER_ZOOM_TRACK,
    MODEL_ROTATION_TRACK,
    TIMELINE_ROW_HEIGHT,
    aggregateTimelineKeyFrames,
    buildTimelineRows,
    copyKeyframeSelection,
    createAnimationCacheReference,
    createAnimationStateFromPoses,
    createClearedAnimationState,
    createDefaultAnimationState,
    computeVirtualTrackRange,
    computeVisibleFrameRange,
    computeTimelineHorizontalScroll,
    computeTimelineLaneWidth,
    eulerDegreesToQuaternion,
    evaluateAnimationFrame,
    evaluateCharacterTransform,
    findChangedPoseTracks,
    findNearestKeyframeAtPosition,
    findKeyframesInRange,
    findKeyframesInTimelineRows,
    groupTimelineTracks,
    humanizeBoneName,
    isAnimationCacheReference,
    moveKeyframeSelection,
    normalizeAnimationState,
    playbackFrameForElapsed,
    pasteKeyframeSelection,
    resolveCaptureCameraParams,
    resolveDebugLightingMode,
    restoreAnimationStateSnapshot,
    resizeAnimationFrameCount,
    retimeAnimationFrameCount,
    retimeAnimationTiming,
    serializeAnimationStateSnapshot,
    selectRandomLibraryPoseData,
    setTrackKeyframeFromEuler,
    setCharacterTransformKeyframe,
    timelineContentPointToPosition,
    timelineFingerGroupIdForTrack,
    timelineGroupIdForTrack,
    timelineViewportToContentPoint,
} from "../web/vnccs_pose_animation.mjs";

const angleDistance = (a, b) => Math.abs(((b - a + 540) % 360) - 180);

test("debug execution selects one complete library pose", () => {
    const first = {
        bones: { head: [10, 20, 30] },
        modelRotation: [5, 15, 25],
        cameraParams: { zoom: 2.25, yaw_deg: 35 },
    };
    const second = {
        bones: { spine: [1, 2, 3] },
        modelRotation: [-5, -15, -25],
        camera: { posX: 1, posY: 2, posZ: 3 },
    };
    const library = [
        { name: "metadata-only" },
        { name: "first", data: first },
        {
            name: "animation",
            asset_type: "animation",
            data: { animation: createDefaultAnimationState({}) },
        },
        { name: "second", data: second },
    ];

    assert.equal(selectRandomLibraryPoseData(library, () => 0), first);
    assert.equal(selectRandomLibraryPoseData(library, () => 0.999999), second);
    assert.equal(selectRandomLibraryPoseData([], () => 0.5), null);
});

test("debug lighting preserves original and manual modes before random lighting", () => {
    assert.equal(resolveDebugLightingMode(), "random");
    assert.equal(
        resolveDebugLightingMode({ keepManualLighting: true }),
        "manual",
    );
    assert.equal(
        resolveDebugLightingMode({
            keepManualLighting: true,
            keepOriginalLighting: true,
        }),
        "original",
    );
    assert.equal(
        resolveDebugLightingMode({ keepOriginalLighting: true }),
        "original",
    );
});

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

test("each character animates position in frame and zoom with ordinary keyframe interpolation", () => {
    const state = createDefaultAnimationState({}, {
        frameCount: 11,
        duration: 1,
        fps: 11,
        baseTransform: { x: -2, y: 1, z: 4, zoom: 1 },
    });
    setCharacterTransformKeyframe(
        state,
        CHARACTER_POSITION_TRACK,
        10,
        { x: 8, y: -3, z: 4, zoom: 1 },
        "linear",
    );
    setCharacterTransformKeyframe(
        state,
        CHARACTER_ZOOM_TRACK,
        10,
        { x: 8, y: -3, z: 4, zoom: 3 },
        "linear",
    );

    assert.deepEqual(state.tracks[CHARACTER_POSITION_TRACK].keys.map(key => key.frame), [0, 10]);
    assert.deepEqual(state.tracks[CHARACTER_ZOOM_TRACK].keys.map(key => key.frame), [0, 10]);
    assert.deepEqual(evaluateCharacterTransform(state, 0), {
        x: -2,
        y: 1,
        z: 4,
        zoom: 1,
    });
    assert.deepEqual(evaluateCharacterTransform(state, 5), {
        x: 3,
        y: -1,
        z: 4,
        zoom: 2,
    });
    assert.deepEqual(evaluateCharacterTransform(state, 10), {
        x: 8,
        y: -3,
        z: 4,
        zoom: 3,
    });
    assert.equal(CHARACTER_POSITION_TRACK in evaluateAnimationFrame(state, 5).bones, false);
    assert.equal(CHARACTER_ZOOM_TRACK in evaluateAnimationFrame(state, 5).bones, false);
});

test("waist-up frame zero interpolates to a full-body framing on the last frame", () => {
    const state = createDefaultAnimationState({}, {
        frameCount: 24,
        duration: 2,
        fps: 12,
    });
    const waistUp = { x: -0.65, y: -2.84, z: 0, zoom: 2.72 };
    const fullBody = { x: 0, y: 0, z: 0, zoom: 1.63 };

    state.baseTransform = { ...waistUp };
    setCharacterTransformKeyframe(
        state,
        CHARACTER_POSITION_TRACK,
        0,
        waistUp,
        "linear",
    );
    setCharacterTransformKeyframe(
        state,
        CHARACTER_ZOOM_TRACK,
        0,
        waistUp,
        "linear",
    );
    setCharacterTransformKeyframe(
        state,
        CHARACTER_POSITION_TRACK,
        23,
        fullBody,
        "linear",
    );
    setCharacterTransformKeyframe(
        state,
        CHARACTER_ZOOM_TRACK,
        23,
        fullBody,
        "linear",
    );

    assert.deepEqual(evaluateCharacterTransform(state, 0), waistUp);
    assert.deepEqual(evaluateCharacterTransform(state, 23), fullBody);
    const middle = evaluateCharacterTransform(state, 11.5);
    assert.ok(middle.zoom < waistUp.zoom && middle.zoom > fullBody.zoom);
    assert.ok(middle.x > waistUp.x && middle.x < fullBody.x);
    assert.ok(middle.y > waistUp.y && middle.y < fullBody.y);
});

test("legacy character animations inherit their existing static placement", () => {
    const state = normalizeAnimationState(
        {
            schemaVersion: 2,
            frameCount: 12,
            duration: 1,
            fps: 12,
            tracks: {},
        },
        {},
        { x: 6, y: -4, z: 2, zoom: 1.75 },
    );
    assert.deepEqual(state.baseTransform, { x: 6, y: -4, z: 2, zoom: 1.75 });
    assert.deepEqual(evaluateCharacterTransform(state, 8), state.baseTransform);
});

test("position and zoom keys survive snapshots and mixed clipboard operations", () => {
    const state = createDefaultAnimationState({}, {
        duration: 2,
        fps: 12,
        baseTransform: { x: 0, y: 0, z: 0, zoom: 1 },
    });
    const positionKey = setCharacterTransformKeyframe(
        state,
        CHARACTER_POSITION_TRACK,
        4,
        { x: 5, y: -2, zoom: 1 },
        "easeInOut",
    );
    const zoomKey = setCharacterTransformKeyframe(
        state,
        CHARACTER_ZOOM_TRACK,
        7,
        { x: 5, y: -2, zoom: 2.5 },
        "smooth",
    );
    const clipboard = copyKeyframeSelection(state, [
        { trackName: CHARACTER_POSITION_TRACK, keyId: positionKey.id },
        { trackName: CHARACTER_ZOOM_TRACK, keyId: zoomKey.id },
    ]);
    pasteKeyframeSelection(state, clipboard, 12);

    const restored = restoreAnimationStateSnapshot(
        serializeAnimationStateSnapshot(state),
    );
    assert.equal(restored.tracks[CHARACTER_POSITION_TRACK].valueType, "vector2");
    assert.equal(restored.tracks[CHARACTER_ZOOM_TRACK].valueType, "scalar");
    assert.deepEqual(
        restored.tracks[CHARACTER_POSITION_TRACK].keys.map(key => key.frame),
        [0, 4, 12],
    );
    assert.deepEqual(
        restored.tracks[CHARACTER_ZOOM_TRACK].keys.map(key => key.frame),
        [0, 7, 15],
    );
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

test("extending duration preserves key and playhead frame numbers", () => {
    const state = createDefaultAnimationState({}, { frameCount: 24, duration: 2, fps: 12 });
    setTrackKeyframeFromEuler(state, "head", 0, [0, 0, 0]);
    setTrackKeyframeFromEuler(state, "head", 23, [45, 0, 0]);
    state.currentFrame = 23;

    retimeAnimationTiming(state, { duration: 20 });

    assert.equal(state.frameCount, 240);
    assert.equal(state.duration, 20);
    assert.equal(state.currentFrame, 23);
    assert.deepEqual(state.tracks.head.keys.map(key => key.frame), [0, 23]);
});

test("shrinking duration never moves or destroys keys beyond the requested end", () => {
    const state = createDefaultAnimationState({}, { frameCount: 24, duration: 2, fps: 12 });
    setTrackKeyframeFromEuler(state, "head", 0, [0, 0, 0]);
    setTrackKeyframeFromEuler(state, "head", 23, [45, 0, 0]);

    resizeAnimationFrameCount(state, 12);

    assert.equal(state.frameCount, 24);
    assert.deepEqual(state.tracks.head.keys.map(key => key.frame), [0, 23]);
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
    assert.deepEqual(topRows, { start: 0, end: 12 });

    const middleRows = computeVirtualTrackRange({ count: 100, scrollTop: 1280, viewportHeight: 200 });
    const firstVisibleRow = Math.floor((1280 - 26) / TIMELINE_ROW_HEIGHT);
    const lastVisibleRow = Math.ceil((1280 + 200 - 26) / TIMELINE_ROW_HEIGHT);
    assert.ok(middleRows.start <= firstVisibleRow);
    assert.ok(middleRows.end >= lastVisibleRow);
    assert.ok(middleRows.end - middleRows.start <= 20);

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

test("timeline groups use anatomical labels and stable body regions", () => {
    assert.equal(humanizeBoneName("mixamorigLeftArm"), "Left Upper Arm");
    assert.equal(humanizeBoneName("index_01_l"), "Left Index Finger — Base");
    assert.equal(humanizeBoneName("Spine02"), "Spine 02");
    assert.equal(humanizeBoneName(CHARACTER_POSITION_TRACK), "Position in Frame");
    assert.equal(humanizeBoneName(CHARACTER_ZOOM_TRACK), "Model Zoom");
    assert.equal(timelineGroupIdForTrack(CHARACTER_POSITION_TRACK), "scene");
    assert.equal(timelineGroupIdForTrack(CHARACTER_ZOOM_TRACK), "scene");
    assert.equal(timelineGroupIdForTrack(MODEL_ROTATION_TRACK), "scene");
    assert.equal(timelineGroupIdForTrack("upperarm_l"), "leftArm");
    assert.equal(timelineGroupIdForTrack("RightForeArm"), "rightArm");
    assert.equal(timelineGroupIdForTrack("thumb_02_l"), "leftHand");
    assert.equal(timelineGroupIdForTrack("foot_r"), "rightLeg");
    assert.equal(timelineGroupIdForTrack("pelvis"), "torso");
    assert.equal(timelineGroupIdForTrack("custom_helper"), "other");
    assert.equal(timelineFingerGroupIdForTrack("index_02_l"), "index");
    assert.equal(timelineFingerGroupIdForTrack("pinky_03_r"), "little");
    assert.equal(timelineFingerGroupIdForTrack("hand_l"), null);

    const groups = groupTimelineTracks([
        MODEL_ROTATION_TRACK, "head", "upperarm_l", "hand_l", "thigh_r", "custom_helper",
    ]);
    assert.deepEqual(groups.map(group => group.id), ["scene", "torso", "leftArm", "rightLeg", "leftHand", "other"]);
});

test("position and zoom tracks remain available before their first keyframe", () => {
    const state = createDefaultAnimationState({}, {
        baseTransform: { x: 1, y: 2, z: 0, zoom: 1.5 },
    });
    const rows = buildTimelineRows({
        state,
        trackNames: [
            CHARACTER_POSITION_TRACK,
            CHARACTER_ZOOM_TRACK,
            MODEL_ROTATION_TRACK,
        ],
        viewMode: "animated",
        activeTrack: MODEL_ROTATION_TRACK,
        expandedGroups: new Set(["scene"]),
    });
    assert.ok(rows.some(row => row.trackName === CHARACTER_POSITION_TRACK));
    assert.ok(rows.some(row => row.trackName === CHARACTER_ZOOM_TRACK));
});

test("expanded hands remain compact through collapsible per-finger groups", () => {
    const state = createDefaultAnimationState({}, { duration: 1, fps: 12 });
    for (const name of ["hand_l", "thumb_01_l", "thumb_02_l", "index_01_l", "index_02_l", "index_03_l"]) {
        setTrackKeyframeFromEuler(state, name, 4, [10, 0, 0]);
    }
    const compact = buildTimelineRows({
        state,
        trackNames: Object.keys(state.tracks),
        viewMode: "all",
        expandedGroups: new Set(["leftHand"]),
    });
    assert.ok(compact.some(row => row.trackName === "hand_l"));
    assert.ok(compact.some(row => row.id === "group:leftHand:thumb"));
    assert.ok(compact.some(row => row.id === "group:leftHand:index"));
    assert.equal(compact.some(row => row.trackName === "index_02_l"), false);

    const expandedIndex = buildTimelineRows({
        state,
        trackNames: Object.keys(state.tracks),
        viewMode: "all",
        expandedGroups: new Set(["leftHand", "leftHand:index"]),
    });
    assert.deepEqual(
        expandedIndex.filter(row => row.type === "track" && row.groupId === "leftHand").map(row => row.trackName),
        ["hand_l", "index_01_l", "index_02_l", "index_03_l"],
    );
    assert.ok(expandedIndex.filter(row => row.trackName?.startsWith("index_")).every(row => row.depth === 2));
});

test("hierarchical timeline rows aggregate keys and keep an active unkeyed track visible", () => {
    const state = createDefaultAnimationState({}, { duration: 1, fps: 12 });
    setTrackKeyframeFromEuler(state, "upperarm_l", 2, [10, 0, 0]);
    setTrackKeyframeFromEuler(state, "upperarm_l", 8, [20, 0, 0]);
    setTrackKeyframeFromEuler(state, "forearm_l", 8, [30, 0, 0]);
    const names = ["head", "upperarm_l", "forearm_l", "wrist_l"];
    const collapsed = buildTimelineRows({ state, trackNames: names, viewMode: "animated" });
    const armGroup = collapsed.find(row => row.id === "group:leftArm");
    assert.ok(armGroup);
    assert.deepEqual(armGroup.keyFrames, [0, 2, 8]);
    assert.equal(collapsed.some(row => row.type === "track"), false);
    assert.deepEqual(aggregateTimelineKeyFrames(state, ["upperarm_l", "forearm_l"]), [0, 2, 8]);

    const focused = buildTimelineRows({
        state,
        trackNames: names,
        viewMode: "animated",
        activeTrack: "wrist_l",
        expandedGroups: new Set(["leftHand"]),
    });
    assert.ok(focused.some(row => row.trackName === "wrist_l"));
    assert.equal(focused.find(row => row.trackName === "wrist_l").keyCount, 0);

    const searched = buildTimelineRows({
        state,
        trackNames: names,
        viewMode: "all",
        search: "wrist",
    });
    assert.ok(searched.some(row => row.trackName === "wrist_l"));

    const focusMode = buildTimelineRows({
        state,
        trackNames: names,
        viewMode: "focus",
        activeTrack: "upperarm_l",
        focusTrackNames: ["upperarm_l", "forearm_l"],
    });
    assert.ok(focusMode.some(row => row.trackName === "upperarm_l"));
    assert.ok(focusMode.some(row => row.trackName === "forearm_l"));
    assert.equal(focusMode.some(row => row.trackName === "wrist_l"), false);

    const selectedMode = buildTimelineRows({
        state,
        trackNames: names,
        viewMode: "selected",
        selectedTrackNames: ["forearm_l"],
    });
    assert.deepEqual(selectedMode.filter(row => row.type === "track").map(row => row.trackName), ["forearm_l"]);
});

test("collapsed and expanded group range selection resolves real keys without duplicates", () => {
    const state = createDefaultAnimationState({}, { duration: 1, fps: 12 });
    const upper = setTrackKeyframeFromEuler(state, "upperarm_l", 4, [10, 0, 0]);
    const lower = setTrackKeyframeFromEuler(state, "forearm_l", 4, [20, 0, 0]);
    setTrackKeyframeFromEuler(state, "forearm_l", 9, [30, 0, 0]);
    const collapsed = buildTimelineRows({
        state,
        trackNames: ["upperarm_l", "forearm_l"],
        viewMode: "all",
    });
    const selected = findKeyframesInTimelineRows(state, collapsed, {
        startRow: 0,
        endRow: 0,
        startFrame: 3.5,
        endFrame: 4.5,
    });
    assert.deepEqual(new Set(selected.map(item => item.keyId)), new Set([upper.id, lower.id]));

    const expanded = buildTimelineRows({
        state,
        trackNames: ["upperarm_l", "forearm_l"],
        viewMode: "all",
        expandedGroups: new Set(["leftArm"]),
    });
    const expandedSelection = findKeyframesInTimelineRows(state, expanded, {
        startRow: 0,
        endRow: 2,
        startFrame: 3.5,
        endFrame: 4.5,
    });
    assert.equal(expandedSelection.length, 2);
});

test("viewport mapping remains correct under Comfy scale and scrolling", () => {
    const viewportRect = { left: 10, top: 20, width: 500, height: 250 };
    const point = timelineViewportToContentPoint({
        clientX: 100,
        clientY: 50,
        viewportRect,
        offsetWidth: 1000,
        offsetHeight: 500,
        clientLeft: 2,
        clientTop: 2,
        scrollLeft: 100,
        scrollTop: 200,
    });
    assert.deepEqual(point, { x: 278, y: 258, scaleX: 0.5, scaleY: 0.5 });
    assert.deepEqual(timelineContentPointToPosition(point, {
        laneLeft: 168,
        laneWidth: 640,
        rulerHeight: 26,
        rowHeight: 22,
        rowCount: 40,
        frameCount: 65,
    }), { frame: 11, row: 10 });

    const afterScroll = timelineViewportToContentPoint({
        clientX: 100,
        clientY: 50,
        viewportRect,
        offsetWidth: 1000,
        offsetHeight: 500,
        clientLeft: 2,
        clientTop: 2,
        scrollLeft: 100,
        scrollTop: 244,
    });
    assert.equal(timelineContentPointToPosition(afterScroll, {
        rowCount: 40,
        rulerHeight: 26,
        rowHeight: 22,
    }).row, 12);
});

test("canvas key hit testing finds only nearby frames", () => {
    const keys = [{ id: "a", frame: 2 }, { id: "b", frame: 20 }, { id: "c", frame: 40 }];
    assert.equal(findNearestKeyframeAtPosition(keys, 200, 400, 41)?.id, "b");
    assert.equal(findNearestKeyframeAtPosition(keys, 215, 400, 41), null);
});

test("timeline lanes fill the visible area and overflow only for dense clips", () => {
    assert.equal(computeTimelineLaneWidth({ frameCount: 24, viewportWidth: 1800 }), 1590);
    assert.equal(computeTimelineLaneWidth({ frameCount: 24, viewportWidth: 700 }), 800);
    assert.equal(computeTimelineLaneWidth({ frameCount: 600, viewportWidth: 1800 }), 9000);
});

test("timeline horizontal slider mirrors and clamps native scrolling", () => {
    assert.deepEqual(computeTimelineHorizontalScroll({
        scrollWidth: 9210,
        clientWidth: 1800,
        scrollLeft: 3200,
    }), {
        maximum: 7410,
        value: 3200,
        visible: true,
    });
    assert.deepEqual(computeTimelineHorizontalScroll({
        scrollWidth: 1800,
        clientWidth: 1800,
        scrollLeft: 50,
    }), {
        maximum: 0,
        value: 0,
        visible: false,
    });
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

test("one history or library snapshot restores all keys and animation settings", () => {
    const state = createDefaultAnimationState({}, {
        duration: 2,
        fps: 12,
        loop: false,
        autoKey: false,
        snap: false,
        defaultInterpolation: "hold",
    });
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
    assert.equal(restored.duration, 2);
    assert.equal(restored.fps, 12);
    assert.equal(restored.loop, false);
    assert.equal(restored.autoKey, false);
    assert.equal(restored.snap, false);
    assert.equal(restored.defaultInterpolation, "hold");
});

test("pose diff reports changed bones and model rotation only", () => {
    const expected = { bones: { head: [0, 0, 0] }, modelRotation: [0, 0, 0] };
    const actual = { bones: { head: [0, 12, 0], arm: [0, 0, 0] }, modelRotation: [0, 5, 0] };
    assert.deepEqual(findChangedPoseTracks(expected, actual).sort(), [MODEL_ROTATION_TRACK, "head"].sort());
});

test("animation cache references keep dense keyframes out of the workflow widget", () => {
    const state = createDefaultAnimationState({}, {
        frameCount: 100,
        duration: 100 / 12,
        fps: 12,
    });
    for (let bone = 0; bone < 40; bone++) {
        for (let frame = 0; frame < 100; frame++) {
            setTrackKeyframeFromEuler(state, `bone_${bone}`, frame, [frame, bone, 0]);
        }
    }
    const fullJSON = JSON.stringify(state);
    const reference = createAnimationCacheReference(state, {
        cacheId: "vnccs_pose_animation_7_test",
        revision: 42,
    });
    const referenceJSON = JSON.stringify(reference);
    assert.equal(isAnimationCacheReference(reference), true);
    assert.equal(reference.revision, 42);
    assert.equal(reference.frameCount, 100);
    assert.equal(reference.trackCount, 40);
    assert.equal("tracks" in reference, false);
    assert.ok(referenceJSON.length < fullJSON.length * 0.02);
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

test("pose imports can key only every Nth animation frame", () => {
    const poses = Array.from({ length: 100 }, (_, frame) => ({
        bones: { wrist_l: [0, frame, 0] },
        modelRotation: [0, 0, 0],
    }));
    const state = createAnimationStateFromPoses(poses, {
        duration: 100 / 12,
        fps: 12,
        frameCount: null,
        keyframeStep: 10,
    });
    assert.equal(state.frameCount, 100);
    assert.deepEqual(state.tracks.wrist_l.keys.map(key => key.frame), [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 99]);
    assert.equal(state.tracks[MODEL_ROTATION_TRACK].keys.length, 11);
});
