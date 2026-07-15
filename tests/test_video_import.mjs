import assert from "node:assert/strict";
import test from "node:test";

import {
    MAX_VIDEO_POSE_SAMPLES,
    clampVideoTimelineViewport,
    computeVideoSamplePlan,
    fitVideoTimelineSelection,
    isLikelyVideoFile,
    zoomVideoTimelineViewport,
} from "../web/vnccs_video_import.mjs";
import { createAnimationStateFromPoses } from "../web/vnccs_pose_animation.mjs";

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
