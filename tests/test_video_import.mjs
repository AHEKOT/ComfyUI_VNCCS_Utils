import assert from "node:assert/strict";
import test from "node:test";

import {
    MAX_VIDEO_POSE_SAMPLES,
    clampVideoCaptureFps,
    clampVideoTimelineViewport,
    computeVideoCaptureSchedule,
    computeVideoSamplePlan,
    countVideoKeyedFrames,
    estimateVideoFrameRate,
    fitVideoTimelineSelection,
    isLikelyVideoFile,
    reduceVideoPoseKeyframes,
    stabilizeVideoPoseSequence,
    videoKeyedFrameIndices,
    zoomVideoTimelineViewport,
} from "../web/vnccs_video_import.mjs";
import {
    createAnimationStateFromPoses,
    eulerDegreesToQuaternion,
    evaluateAnimationFrame,
} from "../web/vnccs_pose_animation.mjs";

const quaternionDistanceDegrees = (aEuler, bEuler) => {
    const a = eulerDegreesToQuaternion(aEuler);
    const b = eulerDegreesToQuaternion(bEuler);
    const dot = Math.abs(a.reduce((sum, value, index) => sum + value * b[index], 0));
    return 2 * Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
};

test("popular browser video files are routed to video import", () => {
    for (const name of ["clip.mp4", "clip.webm", "clip.mov", "clip.m4v", "clip.ogv", "clip.mkv", "clip.avi"]) {
        assert.equal(isLikelyVideoFile({ name, type: "" }), true, name);
    }
    assert.equal(isLikelyVideoFile({ name: "capture.bin", type: "video/mp4" }), true);
    assert.equal(isLikelyVideoFile({ name: "pose.json", type: "application/json" }), false);
});

test("short segments retain requested 12 FPS sampling", () => {
    const plan = computeVideoSamplePlan({ inTime: 2, outTime: 7, targetFps: 12 });
    assert.equal(plan.duration, 5);
    assert.equal(plan.sampleCount, 60);
    assert.equal(plan.effectiveFps, 12);
    assert.equal(plan.limited, false);
    assert.equal(plan.times[0], 2);
    assert.ok(Math.abs(plan.times.at(-1) - (7 - 1 / 12)) < 1e-12);
});

test("source video FPS detection handles fractional rates and skipped callbacks", () => {
    const fractional = Array.from({ length: 12 }, (_, frame) => ({
        mediaTime: frame / 29.97,
        presentedFrames: frame + 1,
    }));
    assert.equal(estimateVideoFrameRate(fractional), 29.97);
    assert.equal(estimateVideoFrameRate([
        { mediaTime: 0, presentedFrames: 10 },
        { mediaTime: 2 / 30, presentedFrames: 12 },
        { mediaTime: 4 / 30, presentedFrames: 14 },
    ]), 30);
});

test("capture FPS never exceeds the detected source rate", () => {
    assert.equal(clampVideoCaptureFps(60, 24), 24);
    assert.equal(clampVideoCaptureFps(12, 24), 12);
    assert.equal(clampVideoCaptureFps(12, 8), 8);
    assert.equal(clampVideoCaptureFps(120, 120), 60);
});

test("two hour videos keep real duration while bounding pose work and memory", () => {
    const plan = computeVideoSamplePlan({ inTime: 0, outTime: 7200, targetFps: 12 });
    assert.equal(plan.requestedSamples, 86400);
    assert.equal(plan.sampleCount, MAX_VIDEO_POSE_SAMPLES);
    assert.equal(plan.times.length, MAX_VIDEO_POSE_SAMPLES);
    assert.equal(plan.times[0], 0);
    assert.equal(plan.times.at(-1), 7188);
    assert.equal(plan.limited, true);
    assert.ok(Math.abs(plan.effectiveFps - (600 / 7200)) < 1e-12);
});

test("a bounded two hour capture is not truncated by animation timing", () => {
    const poses = Array.from({ length: MAX_VIDEO_POSE_SAMPLES }, (_, frame) => ({
        bones: { head: [0, frame / 10, 0] },
        modelRotation: [0, 0, 0],
    }));
    const state = createAnimationStateFromPoses(poses, { duration: 7200, fps: 12 });
    assert.equal(state.frameCount, MAX_VIDEO_POSE_SAMPLES);
    assert.equal(state.duration, 7200);
    assert.ok(Math.abs(state.fps - (600 / 7200)) < 1e-12);
});

test("in and out points define the exact sample range", () => {
    const plan = computeVideoSamplePlan({ inTime: 10, outTime: 10.5, targetFps: 12 });
    assert.equal(plan.sampleCount, 6);
    assert.deepEqual(plan.times, [10, 10 + 1 / 12, 10 + 2 / 12, 10.25, 10 + 4 / 12, 10 + 5 / 12]);
});

test("video timeline zoom keeps the pointer time anchored", () => {
    const full = clampVideoTimelineViewport({ duration: 2400, start: 0, end: 2400 });
    const zoomed = zoomVideoTimelineViewport(full, 10, 450, { duration: 2400 });
    assert.equal(zoomed.duration, 240);
    assert.equal(zoomed.start, 405);
    assert.equal(zoomed.end, 645);
    assert.equal(zoomed.zoom, 10);
});

test("fit selection makes a short long-video segment fill the timeline", () => {
    const view = fitVideoTimelineSelection(2400, 448.587, 455.187);
    assert.ok(view.start < 448.587);
    assert.ok(view.end > 455.187);
    assert.ok(view.duration < 9);
    assert.ok(view.zoom > 250);
});

test("timeline pan and extreme zoom stay inside video bounds", () => {
    const rightEdge = clampVideoTimelineViewport({ duration: 100, start: 99, end: 120, minDuration: 0.25 });
    assert.deepEqual(rightEdge, { start: 79, end: 100, duration: 21, zoom: 100 / 21 });
    const maximum = zoomVideoTimelineViewport({ start: 0, end: 100 }, 10000, 0, {
        duration: 100,
        minDuration: 0.25,
    });
    assert.deepEqual(maximum, { start: 0, end: 0.25, duration: 0.25, zoom: 400 });
});

test("video keyframe interval defaults to every second frame and scales predictably", () => {
    assert.equal(countVideoKeyedFrames(100), 51);
    assert.equal(countVideoKeyedFrames(100, 4), 26);
    assert.equal(countVideoKeyedFrames(100, 10), 11);
    assert.equal(countVideoKeyedFrames(101, 10), 11);
    assert.deepEqual(videoKeyedFrameIndices(24, 4), [0, 4, 8, 12, 16, 20, 23]);
});

test("fixed video key intervals skip pose parsing but preserve the full timeline", () => {
    const plan = computeVideoSamplePlan({ inTime: 0, outTime: 2, targetFps: 12 });
    const capture = computeVideoCaptureSchedule(plan, 4);
    assert.equal(plan.sampleCount, 24);
    assert.equal(capture.sampleCount, 7);
    assert.deepEqual(capture.frameIndices, [0, 4, 8, 12, 16, 20, 23]);
    assert.deepEqual(capture.times, capture.frameIndices.map(frame => frame / 12));

    const poses = capture.frameIndices.map(frame => ({
        bones: { wrist_l: [0, frame, 0] },
        modelRotation: [0, 0, 0],
    }));
    const state = createAnimationStateFromPoses(poses, {
        duration: plan.duration,
        frameCount: capture.timelineFrameCount,
        poseFrameIndices: capture.frameIndices,
    });
    assert.equal(state.frameCount, 24);
    assert.equal(state.fps, 12);
    assert.deepEqual(state.tracks.wrist_l.keys.map(key => key.frame), capture.frameIndices);
    assert.ok(quaternionDistanceDegrees(evaluateAnimationFrame(state, 23).bones.wrist_l, [0, 23, 0]) < 1e-6);
});

test("quaternion stabilization suppresses an isolated wrist jump", () => {
    const poses = [0, 0, 80, 0, 0].map(y => ({
        bones: { wrist_l: [0, y, 0] },
        modelRotation: [0, 0, 0],
    }));
    const stabilized = stabilizeVideoPoseSequence(poses, "medium");
    assert.equal(stabilized[0].bones.wrist_l[1], 0);
    assert.ok(Math.abs(stabilized[2].bones.wrist_l[1]) < 1e-9);
    assert.equal(stabilized[4].bones.wrist_l[1], 0);
    assert.equal(poses[2].bones.wrist_l[1], 80, "source poses must not be mutated");
});

test("quaternion medoid preserves steady motion and can be disabled", () => {
    const poses = [0, 10, 20, 30, 40].map(y => ({
        bones: { wrist_l: [0, y, 0] },
        modelRotation: [0, y, 0],
    }));
    const stabilized = stabilizeVideoPoseSequence(poses, "strong");
    stabilized.forEach((pose, frame) => {
        assert.ok(Math.abs(pose.bones.wrist_l[1] - frame * 10) < 1e-9);
        assert.ok(Math.abs(pose.modelRotation[1] - frame * 10) < 1e-9);
    });
    assert.deepEqual(stabilizeVideoPoseSequence(poses, "off"), poses);
});

test("quaternion stabilization removes a one-frame body flip", () => {
    const poses = Array.from({ length: 5 }, (_, frame) => ({
        bones: {
            pelvis: frame === 2 ? [180, 0, 0] : [0, 0, 0],
            spine_01: frame === 2 ? [0, 180, 0] : [0, 0, 0],
        },
        modelRotation: frame === 2 ? [0, 0, 180] : [0, 0, 0],
    }));
    const stabilized = stabilizeVideoPoseSequence(poses, "medium");
    assert.ok(stabilized[2].bones.pelvis.every(value => Math.abs(value) < 1e-6));
    assert.ok(stabilized[2].bones.spine_01.every(value => Math.abs(value) < 1e-6));
    assert.ok(stabilized[2].modelRotation.every(value => Math.abs(value) < 1e-6));
});

test("equivalent Euler representations are not mistaken for rotation jumps", () => {
    const poses = [
        { bones: { pelvis: [0, 180, 0] }, modelRotation: [0, 0, 0] },
        { bones: { pelvis: [180, 0, 180] }, modelRotation: [0, 0, 0] },
        { bones: { pelvis: [0, 180, 0] }, modelRotation: [0, 0, 0] },
    ];
    const stabilized = stabilizeVideoPoseSequence(poses, "strong");
    assert.deepEqual(stabilized[1].bones.pelvis, [180, 0, 180]);
});

test("stabilization catches boundary and two-frame capture flips", () => {
    const boundary = [90, 0, 0, 0, 0].map(x => ({
        bones: { pelvis: [x, 0, 0] },
        modelRotation: [0, 0, 0],
    }));
    assert.ok(Math.abs(stabilizeVideoPoseSequence(boundary, "medium")[0].bones.pelvis[0]) < 1e-9);

    const doubleFlip = [0, 0, 80, 80, 0, 0].map(x => ({
        bones: { pelvis: [x, 0, 0] },
        modelRotation: [0, 0, 0],
    }));
    const stabilized = stabilizeVideoPoseSequence(doubleFlip, "medium");
    assert.ok(Math.abs(stabilized[2].bones.pelvis[0]) < 1e-9);
    assert.ok(Math.abs(stabilized[3].bones.pelvis[0]) < 1e-9);
});

test("stabilization reduces alternating parser jitter but preserves sustained fast motion", () => {
    const jitter = [0, 2, -2, 2, -2, 0].map(y => ({
        bones: { wrist_l: [0, y, 0] },
        modelRotation: [0, 0, 0],
    }));
    const stabilizedJitter = stabilizeVideoPoseSequence(jitter, "strong");
    const beforePeak = Math.max(...jitter.map(pose => Math.abs(pose.bones.wrist_l[1])));
    const afterPeak = Math.max(...stabilizedJitter.map(pose => Math.abs(pose.bones.wrist_l[1])));
    assert.ok(afterPeak < beforePeak);

    const sustained = [0, 0, 60, 60, 60].map(y => ({
        bones: { arm_l: [0, y, 0] },
        modelRotation: [0, 0, 0],
    }));
    const stabilizedMotion = stabilizeVideoPoseSequence(sustained, "medium");
    assert.ok(stabilizedMotion[2].bones.arm_l[1] > 50);
    assert.ok(stabilizedMotion[3].bones.arm_l[1] > 50);
});

test("catastrophic single sample is restored from temporal SLERP without contaminating neighbors", () => {
    const poses = [0, 10, 170, 30, 40].map(y => ({
        bones: { pelvis: [0, y, 0] },
        modelRotation: [0, 0, 0],
    }));
    const stabilized = stabilizeVideoPoseSequence(poses, "medium");
    [0, 10, 20, 30, 40].forEach((expected, frame) => {
        assert.ok(quaternionDistanceDegrees(stabilized[frame].bones.pelvis, [0, expected, 0]) < 1e-6);
    });
});

test("medium stabilization fully rejects a sharp single-frame detour", () => {
    const poses = [0, 10, 50, 30, 40].map(y => ({
        bones: { pelvis: [0, y, 0] },
        modelRotation: [0, 0, 0],
    }));
    const stabilized = stabilizeVideoPoseSequence(poses, "medium");
    [0, 10, 20, 30, 40].forEach((expected, frame) => {
        assert.ok(quaternionDistanceDegrees(stabilized[frame].bones.pelvis, [0, expected, 0]) < 1e-6);
    });
});

test("ordered parser jitter is reduced and sparse sampling does not erase real motion", () => {
    const jitter = [0, 10, 28, 30, 40].map(y => ({
        bones: { wrist_l: [0, y, 0] },
        modelRotation: [0, 0, 0],
    }));
    const stabilized = stabilizeVideoPoseSequence(jitter, "medium");
    assert.ok(Math.abs(stabilized[2].bones.wrist_l[1] - 20) < 8);

    const sparseMotion = [0, 0, 90, 0, 0].map(y => ({
        bones: { arm_l: [0, y, 0] },
        modelRotation: [0, 0, 0],
    }));
    const sparseStabilized = stabilizeVideoPoseSequence(sparseMotion, "medium", { sampleFps: 0.1 });
    assert.ok(sparseStabilized[2].bones.arm_l[1] > 80);
});

test("stabilization keeps equivalent rotations continuous across Euler wrap", () => {
    const poses = [179, -179, 179, -179, 179].map(y => ({
        bones: { head: [0, y, 0] },
        modelRotation: [0, 0, 0],
    }));
    const stabilized = stabilizeVideoPoseSequence(poses, "strong");
    stabilized.forEach((pose, frame) => {
        assert.ok(quaternionDistanceDegrees(pose.bones.head, poses[frame].bones.head) <= 2.000001);
    });
});

test("adaptive key reduction omits static joints and simplifies each moving joint independently", () => {
    const poses = Array.from({ length: 11 }, (_, frame) => ({
        bones: {
            head: [0, 0, 0],
            arm_l: [0, frame * 2, 0],
            wrist_l: [0, (frame <= 5 ? frame : 10 - frame) * 6, 0],
            finger_l: [0, frame % 2 ? 0.1 : -0.1, 0],
        },
        modelRotation: [0, 0, 0],
    }));
    const reduction = reduceVideoPoseKeyframes(poses, "balanced");
    assert.deepEqual(reduction.trackKeyframes.arm_l, [0, 10]);
    assert.deepEqual(reduction.trackKeyframes.wrist_l, [0, 5, 10]);
    assert.equal(reduction.trackKeyframes.head, undefined);
    assert.equal(reduction.trackKeyframes.finger_l, undefined);
    assert.equal(reduction.trackKeyframes["@modelRotation"], undefined);
    assert.equal(reduction.totalKeyCount, 5);

    const state = createAnimationStateFromPoses(poses, {
        duration: 11 / 12,
        trackKeyframes: reduction.trackKeyframes,
    });
    assert.deepEqual(Object.keys(state.tracks).sort(), ["arm_l", "wrist_l"]);
    for (let frame = 0; frame < poses.length; frame++) {
        const evaluated = evaluateAnimationFrame(state, frame);
        assert.ok(quaternionDistanceDegrees(evaluated.bones.arm_l, poses[frame].bones.arm_l) <= 1.000001);
        assert.ok(quaternionDistanceDegrees(evaluated.bones.wrist_l, poses[frame].bones.wrist_l) <= 1.000001);
    }
});
