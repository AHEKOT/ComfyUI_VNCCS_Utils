import {
    MODEL_ROTATION_TRACK,
    eulerDegreesToQuaternion,
    quaternionToEulerDegrees,
    slerpQuaternion,
} from "./vnccs_pose_animation.mjs";

export const VIDEO_FILE_EXTENSIONS = new Set([
    "mp4", "m4v", "webm", "mov", "ogv", "ogg", "avi", "mkv",
]);

export const MAX_VIDEO_POSE_SAMPLES = 600;

export const VIDEO_STABILIZATION_PRESETS = Object.freeze({
    off: Object.freeze({ radius: 0, strength: 0, thresholdDegrees: Infinity, jerkLimitDegrees: Infinity }),
    light: Object.freeze({ radius: 1, strength: 0.18, thresholdDegrees: 2, jerkLimitDegrees: 12 }),
    medium: Object.freeze({ radius: 2, strength: 0.32, thresholdDegrees: 1, jerkLimitDegrees: 6 }),
    strong: Object.freeze({ radius: 3, strength: 0.48, thresholdDegrees: 0.35, jerkLimitDegrees: 3 }),
});

export const VIDEO_KEY_REDUCTION_PRESETS = Object.freeze({
    off: null,
    conservative: Object.freeze({ toleranceDegrees: 0.35, staticThresholdDegrees: 0.2 }),
    balanced: Object.freeze({ toleranceDegrees: 1.0, staticThresholdDegrees: 0.5 }),
    aggressive: Object.freeze({ toleranceDegrees: 2.5, staticThresholdDegrees: 1.0 }),
});

function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export function isLikelyVideoFile(file) {
    if (!file) return false;
    if (String(file.type || "").toLowerCase().startsWith("video/")) return true;
    const name = String(file.name || "").toLowerCase();
    const extension = name.includes(".") ? name.split(".").pop() : "";
    return VIDEO_FILE_EXTENSIONS.has(extension);
}

/**
 * Keep animation/keyframe count bounded even when the selected source is hours
 * long. The selected duration is preserved; only the capture sampling rate is
 * reduced when MAX_VIDEO_POSE_SAMPLES would be exceeded.
 */
export function computeVideoSamplePlan({
    inTime = 0,
    outTime = 0,
    targetFps = 12,
    maxSamples = MAX_VIDEO_POSE_SAMPLES,
} = {}) {
    const start = Math.max(0, finiteNumber(inTime));
    const end = Math.max(start, finiteNumber(outTime, start));
    const duration = end - start;
    const requestedFps = Math.min(60, Math.max(0.01, finiteNumber(targetFps, 12)));
    const limit = Math.max(2, Math.floor(finiteNumber(maxSamples, MAX_VIDEO_POSE_SAMPLES)));
    const requestedSamples = Math.max(2, Math.round(duration * requestedFps));
    const sampleCount = Math.min(limit, requestedSamples);
    const effectiveFps = duration > 0 ? sampleCount / duration : requestedFps;
    // OUT is an exclusive boundary, matching frameCount = duration * FPS.
    // The last sampled pose is held until OUT during playback.
    const times = Array.from({ length: sampleCount }, (_, index) => (
        start + (duration * index) / sampleCount
    ));
    return {
        inTime: start,
        outTime: end,
        duration,
        targetFps: requestedFps,
        requestedSamples,
        sampleCount,
        effectiveFps,
        limited: requestedSamples > sampleCount,
        times,
    };
}

export function videoKeyedFrameIndices(frameCountValue, keyframeStepValue = 2) {
    const frameCount = Math.max(0, Math.floor(finiteNumber(frameCountValue)));
    if (!frameCount) return [];
    const step = Math.max(1, Math.floor(finiteNumber(keyframeStepValue, 2)));
    const indices = [];
    for (let frame = 0; frame < frameCount; frame += step) indices.push(frame);
    if (indices.at(-1) !== frameCount - 1) indices.push(frameCount - 1);
    return indices;
}

export function countVideoKeyedFrames(frameCountValue, keyframeStepValue = 2) {
    return videoKeyedFrameIndices(frameCountValue, keyframeStepValue).length;
}

/**
 * Select only the source frames that will become fixed timeline keys. The
 * animation keeps the original timeline frame count/FPS; this schedule merely
 * prevents the expensive pose parser from processing frames that interpolation
 * will replace anyway.
 */
export function computeVideoCaptureSchedule(plan, keyframeStepValue = 1) {
    const sourceTimes = Array.isArray(plan?.times) ? plan.times : [];
    const timelineFrameCount = Math.min(
        Math.max(0, Math.floor(finiteNumber(plan?.sampleCount, sourceTimes.length))),
        sourceTimes.length,
    );
    const frameIndices = videoKeyedFrameIndices(timelineFrameCount, keyframeStepValue);
    const times = frameIndices.map(frame => sourceTimes[frame]);
    const elapsed = times.length > 1 ? times.at(-1) - times[0] : 0;
    const effectiveFps = elapsed > 0
        ? (times.length - 1) / elapsed
        : Math.max(0.001, finiteNumber(plan?.effectiveFps, 12));
    return {
        timelineFrameCount,
        frameIndices,
        times,
        sampleCount: times.length,
        effectiveFps,
    };
}

const COMMON_VIDEO_FRAME_RATES = Object.freeze([
    1, 2, 5, 8, 10, 12, 15, 18, 20,
    23.976, 24, 25, 29.97, 30,
    48, 50, 59.94, 60,
]);

export function estimateVideoFrameRate(samples = []) {
    const rates = [];
    for (let index = 1; index < samples.length; index++) {
        const previous = samples[index - 1] || {};
        const current = samples[index] || {};
        const elapsed = finiteNumber(current.mediaTime) - finiteNumber(previous.mediaTime);
        if (elapsed <= 1 / 300 || elapsed > 2) continue;
        const previousFrames = finiteNumber(previous.presentedFrames, NaN);
        const currentFrames = finiteNumber(current.presentedFrames, NaN);
        const frameDelta = Number.isFinite(previousFrames)
            && Number.isFinite(currentFrames)
            && currentFrames > previousFrames
            ? currentFrames - previousFrames
            : 1;
        const rate = frameDelta / elapsed;
        if (rate >= 0.5 && rate <= 240) rates.push(rate);
    }
    if (!rates.length) return null;
    rates.sort((a, b) => a - b);
    const middle = Math.floor(rates.length / 2);
    const median = rates.length % 2
        ? rates[middle]
        : (rates[middle - 1] + rates[middle]) / 2;
    const common = COMMON_VIDEO_FRAME_RATES.reduce((nearest, candidate) => (
        Math.abs(candidate - median) < Math.abs(nearest - median) ? candidate : nearest
    ), COMMON_VIDEO_FRAME_RATES[0]);
    const estimated = Math.abs(common - median) / Math.max(1, common) <= 0.02
        ? Math.min(common, median)
        : median;
    // Be conservative: measurement rounding must never produce a limit above
    // the rate actually observed in the source.
    return Number(estimated.toFixed(3));
}

export function clampVideoCaptureFps(requestedFps, sourceFps = null) {
    const detectedLimit = finiteNumber(sourceFps, NaN);
    const maximum = Number.isFinite(detectedLimit) && detectedLimit > 0
        ? Math.min(60, detectedLimit)
        : 60;
    return Math.min(maximum, Math.max(0.01, finiteNumber(requestedFps, Math.min(12, maximum))));
}

function quaternionAngularDistanceDegrees(a, b) {
    const dot = Math.abs(
        a[0] * b[0]
        + a[1] * b[1]
        + a[2] * b[2]
        + a[3] * b[3]
    );
    return 2 * Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
}

function quaternionMedoid(quaternions) {
    if (!quaternions.length) return [0, 0, 0, 1];
    let best = quaternions[0];
    let bestCost = Infinity;
    for (const candidate of quaternions) {
        let cost = 0;
        for (const other of quaternions) cost += quaternionAngularDistanceDegrees(candidate, other);
        if (cost < bestCost) {
            best = candidate;
            bestCost = cost;
        }
    }
    return best;
}

function simplifyQuaternionFrames(quaternions, toleranceDegrees) {
    const frameCount = quaternions.length;
    if (!frameCount) return [];
    if (frameCount === 1) return [0];
    const keep = new Set([0, frameCount - 1]);
    const segments = [[0, frameCount - 1]];
    while (segments.length) {
        const [start, end] = segments.pop();
        if (end - start <= 1) continue;
        let maximumError = -1;
        let maximumFrame = -1;
        for (let frame = start + 1; frame < end; frame++) {
            const t = (frame - start) / (end - start);
            const interpolated = slerpQuaternion(quaternions[start], quaternions[end], t);
            const error = quaternionAngularDistanceDegrees(quaternions[frame], interpolated);
            if (error > maximumError) {
                maximumError = error;
                maximumFrame = frame;
            }
        }
        if (maximumFrame > start && maximumError > toleranceDegrees) {
            keep.add(maximumFrame);
            segments.push([start, maximumFrame], [maximumFrame, end]);
        }
    }
    return Array.from(keep).sort((a, b) => a - b);
}

/**
 * Build independent per-bone key lists. A track is omitted entirely when it
 * stays within the static threshold; moving tracks retain only the keys needed
 * for quaternion interpolation to reproduce every sampled pose within the
 * selected angular tolerance.
 */
export function reduceVideoPoseKeyframes(poses, presetName = "balanced") {
    const frames = Array.isArray(poses) ? poses.filter(pose => pose && typeof pose === "object") : [];
    const preset = VIDEO_KEY_REDUCTION_PRESETS[presetName];
    if (!preset || !frames.length) return null;
    const trackKeyframes = {};
    const boneNames = new Set();
    for (const pose of frames) {
        for (const boneName of Object.keys(pose.bones || {})) boneNames.add(boneName);
    }

    const reduceTrack = (trackName, rotations) => {
        const quaternions = rotations.map(eulerDegreesToQuaternion);
        const first = quaternions[0];
        const maximumMotion = quaternions.reduce(
            (maximum, quaternion) => Math.max(maximum, quaternionAngularDistanceDegrees(first, quaternion)),
            0,
        );
        if (maximumMotion <= preset.staticThresholdDegrees) return false;
        trackKeyframes[trackName] = simplifyQuaternionFrames(quaternions, preset.toleranceDegrees);
        return true;
    };

    for (const boneName of boneNames) {
        reduceTrack(boneName, frames.map(pose => pose.bones?.[boneName] || [0, 0, 0]));
    }
    reduceTrack(MODEL_ROTATION_TRACK, frames.map(pose => pose.modelRotation || [0, 0, 0]));

    const totalKeyCount = Object.values(trackKeyframes).reduce((sum, keyedFrames) => sum + keyedFrames.length, 0);
    return {
        trackKeyframes,
        totalKeyCount,
        keyedTrackCount: Object.keys(trackKeyframes).length,
        omittedTrackCount: boneNames.size + 1 - Object.keys(trackKeyframes).length,
        denseKeyCount: (boneNames.size + 1) * frames.length,
        preset: presetName,
    };
}

function rejectQuaternionOutliers(source, preset) {
    const output = source.map(quaternion => quaternion.slice());
    if (source.length < 3) return output;
    const hardRadius = Math.max(2, preset.radius);
    const hardFlipDegrees = preset.hardFlipDegrees || 45;

    // A bad first/last sample has no two-sided predictor, but it is still
    // unambiguous when the following/preceding pair agrees closely.
    const firstJump = quaternionAngularDistanceDegrees(source[0], source[1]);
    const firstContinuation = quaternionAngularDistanceDegrees(source[1], source[2]);
    if (firstJump >= hardFlipDegrees && firstContinuation <= Math.max(6, firstJump * 0.2)) {
        output[0] = source[1].slice();
    }
    const last = source.length - 1;
    const lastJump = quaternionAngularDistanceDegrees(source[last], source[last - 1]);
    const lastContinuation = quaternionAngularDistanceDegrees(source[last - 1], source[last - 2]);
    if (lastJump >= hardFlipDegrees && lastContinuation <= Math.max(6, lastJump * 0.2)) {
        output[last] = source[last - 1].slice();
    }

    for (let index = 1; index < last; index++) {
        const previous = source[index - 1];
        const current = source[index];
        const next = source[index + 1];
        const distanceToPrevious = quaternionAngularDistanceDegrees(current, previous);
        const distanceToNext = quaternionAngularDistanceDegrees(current, next);
        const neighborDistance = quaternionAngularDistanceDegrees(previous, next);
        const predicted = slerpQuaternion(previous, next, 0.5);
        const predictionError = quaternionAngularDistanceDegrees(current, predicted);
        const pathExcess = Math.max(
            0,
            distanceToPrevious + distanceToNext - neighborDistance,
        );
        const localRadius = Math.min(hardRadius, index, last - index);
        const neighborhood = source.slice(index - localRadius, index + localRadius + 1);
        const medoid = quaternionMedoid(neighborhood);
        const medoidError = quaternionAngularDistanceDegrees(current, medoid);

        const anchoredToNeighbor = Math.min(distanceToPrevious, distanceToNext) <= Math.max(
            preset.thresholdDegrees * 2,
            preset.jerkLimitDegrees * 2,
        );
        const sharpDetour = !anchoredToNeighbor && pathExcess >= Math.max(
            preset.thresholdDegrees * 4,
            preset.jerkLimitDegrees * 2,
        );
        const isolatedDetour = (
            distanceToPrevious > preset.thresholdDegrees
            && distanceToNext > preset.thresholdDegrees
            && (
                sharpDetour
                || neighborDistance <= Math.max(
                    preset.thresholdDegrees * 2,
                    Math.min(distanceToPrevious, distanceToNext) * 0.85,
                )
            )
            && predictionError > preset.thresholdDegrees
        );
        const catastrophicWindowFlip = medoidError >= hardFlipDegrees;
        if (catastrophicWindowFlip) {
            const currentMatchesOneNeighbor = Math.min(distanceToPrevious, distanceToNext) <= preset.thresholdDegrees * 2;
            output[index] = currentMatchesOneNeighbor ? medoid.slice() : predicted;
        }
        else if (isolatedDetour) output[index] = predicted;
    }
    return output;
}

function smoothQuaternionJitter(source, preset) {
    if (source.length < 3 || preset.strength <= 0) return source.map(quaternion => quaternion.slice());
    return source.map((current, index) => {
        if (index === 0 || index === source.length - 1) return current.slice();
        const previous = source[index - 1];
        const next = source[index + 1];
        const distanceToPrevious = quaternionAngularDistanceDegrees(current, previous);
        const distanceToNext = quaternionAngularDistanceDegrees(current, next);

        // Preserve a sustained fast transition: one neighbor already shares the
        // new pose while the other is far away. Jitter has no such stable side.
        if (
            Math.max(distanceToPrevious, distanceToNext) >= 30
            && Math.min(distanceToPrevious, distanceToNext) <= preset.thresholdDegrees * 2
        ) {
            return current.slice();
        }

        const predicted = slerpQuaternion(previous, next, 0.5);
        const predictionError = quaternionAngularDistanceDegrees(current, predicted);
        if (predictionError <= preset.thresholdDegrees) return current.slice();
        return slerpQuaternion(current, predicted, preset.strength);
    });
}

function limitQuaternionJerk(source, preset) {
    const baseLimit = preset.jerkLimitDegrees;
    if (source.length < 3 || !Number.isFinite(baseLimit)) {
        return source.map(quaternion => quaternion.slice());
    }

    // Two bounded passes remove residual one-frame acceleration left by the
    // soft filter. Each pass is synchronous, so a corrected key cannot drag
    // its neighbours during that same pass.
    let output = source.map(quaternion => quaternion.slice());
    for (let pass = 0; pass < 2; pass++) {
        const input = output;
        output = input.map((current, index) => {
            if (index === 0 || index === input.length - 1) return current.slice();
            const previous = input[index - 1];
            const next = input[index + 1];
            const distanceToPrevious = quaternionAngularDistanceDegrees(current, previous);
            const distanceToNext = quaternionAngularDistanceDegrees(current, next);

            // A new pose that remains on the following frame (or the inverse
            // transition on the preceding frame) is animation, not a spike.
            if (
                Math.max(distanceToPrevious, distanceToNext) >= 30
                && Math.min(distanceToPrevious, distanceToNext) <= preset.thresholdDegrees * 2
            ) {
                return current.slice();
            }

            const predicted = slerpQuaternion(previous, next, 0.5);
            const predictionError = quaternionAngularDistanceDegrees(current, predicted);
            // Allow a little extra curvature when the neighbouring samples are
            // themselves moving, while still putting a hard ceiling on an
            // isolated local detour.
            const neighborDistance = quaternionAngularDistanceDegrees(previous, next);
            const allowedError = baseLimit + Math.min(baseLimit, neighborDistance * 0.1);
            if (predictionError <= allowedError) return current.slice();
            return slerpQuaternion(current, predicted, 1 - allowedError / predictionError);
        });
    }
    return output;
}

function stabilizeEulerRotationSeries(values, preset) {
    const source = values.map(value => Array.isArray(value) ? value.slice(0, 3) : [0, 0, 0]);
    if (source.length < 3 || preset.radius < 1 || preset.strength <= 0) return source;
    const quaternions = source.map(eulerDegreesToQuaternion);
    const withoutSpikes = rejectQuaternionOutliers(quaternions, preset);
    const smoothed = smoothQuaternionJitter(withoutSpikes, preset);
    const safetyChecked = rejectQuaternionOutliers(smoothed, preset);
    const jerkLimited = limitQuaternionJerk(safetyChecked, preset);
    return jerkLimited.map(quaternionToEulerDegrees);
}

/**
 * Suppress isolated pose-estimation jitter without averaging away steady
 * motion. Rotations are compared and blended as quaternions, so Euler axis
 * ambiguity cannot synthesize a flipped orientation.
 */
export function stabilizeVideoPoseSequence(poses, presetName = "medium", { sampleFps = 12 } = {}) {
    const frames = Array.isArray(poses)
        ? poses.filter(pose => pose && typeof pose === "object").map(pose => JSON.parse(JSON.stringify(pose)))
        : [];
    const basePreset = VIDEO_STABILIZATION_PRESETS[presetName] || VIDEO_STABILIZATION_PRESETS.medium;
    const fps = Math.max(0.001, finiteNumber(sampleFps, 12));
    const sparseScale = Math.min(1, fps / 6);
    const timeScale = Math.max(1, 12 / fps);
    const preset = {
        ...basePreset,
        strength: basePreset.strength * sparseScale,
        thresholdDegrees: basePreset.thresholdDegrees * timeScale,
        jerkLimitDegrees: basePreset.jerkLimitDegrees * timeScale,
        hardFlipDegrees: Math.min(170, 45 * Math.sqrt(timeScale)),
    };
    if (frames.length < 3 || preset.strength <= 0 || preset.radius <= 0) return frames;

    const boneNames = new Set();
    for (const pose of frames) {
        for (const boneName of Object.keys(pose.bones || {})) boneNames.add(boneName);
    }
    for (const boneName of boneNames) {
        const stabilized = stabilizeEulerRotationSeries(
            frames.map(pose => pose.bones?.[boneName] || [0, 0, 0]),
            preset,
        );
        for (let frame = 0; frame < frames.length; frame++) {
            frames[frame].bones ||= {};
            frames[frame].bones[boneName] = stabilized[frame];
        }
    }

    const stabilizedModelRotation = stabilizeEulerRotationSeries(
        frames.map(pose => pose.modelRotation || [0, 0, 0]),
        preset,
    );
    for (let frame = 0; frame < frames.length; frame++) {
        frames[frame].modelRotation = stabilizedModelRotation[frame];
    }
    return frames;
}

export function clampVideoTimelineViewport({
    duration = 0,
    start = 0,
    end = duration,
    minDuration = 0.25,
} = {}) {
    const fullDuration = Math.max(0, finiteNumber(duration));
    if (fullDuration <= 0) return { start: 0, end: 0, duration: 0, zoom: 1 };
    const minimum = Math.min(fullDuration, Math.max(0.01, finiteNumber(minDuration, 0.25)));
    const requestedStart = finiteNumber(start);
    const requestedEnd = finiteNumber(end, fullDuration);
    const span = Math.max(minimum, Math.min(fullDuration, requestedEnd - requestedStart));
    const clampedStart = Math.max(0, Math.min(fullDuration - span, requestedStart));
    return {
        start: clampedStart,
        end: clampedStart + span,
        duration: span,
        zoom: fullDuration / span,
    };
}

export function zoomVideoTimelineViewport(viewport, factor, centerTime, options = {}) {
    const fullDuration = Math.max(0, finiteNumber(options.duration, viewport?.end || 0));
    const current = clampVideoTimelineViewport({
        duration: fullDuration,
        start: viewport?.start,
        end: viewport?.end,
        minDuration: options.minDuration,
    });
    if (fullDuration <= 0) return current;
    const center = Math.max(current.start, Math.min(current.end, finiteNumber(centerTime, (current.start + current.end) / 2)));
    const anchor = current.duration > 0 ? (center - current.start) / current.duration : 0.5;
    const safeFactor = Math.max(0.01, finiteNumber(factor, 1));
    const nextDuration = current.duration / safeFactor;
    return clampVideoTimelineViewport({
        duration: fullDuration,
        start: center - nextDuration * anchor,
        end: center + nextDuration * (1 - anchor),
        minDuration: options.minDuration,
    });
}

export function fitVideoTimelineSelection(duration, inTime, outTime, { padding = 0.12, minDuration = 0.25 } = {}) {
    const fullDuration = Math.max(0, finiteNumber(duration));
    const start = Math.max(0, Math.min(fullDuration, finiteNumber(inTime)));
    const end = Math.max(start, Math.min(fullDuration, finiteNumber(outTime, start)));
    const selectionDuration = Math.max(0, end - start);
    const paddedDuration = Math.max(minDuration, selectionDuration * (1 + Math.max(0, padding) * 2));
    const center = (start + end) / 2;
    return clampVideoTimelineViewport({
        duration: fullDuration,
        start: center - paddedDuration / 2,
        end: center + paddedDuration / 2,
        minDuration,
    });
}

function abortError() {
    return new DOMException("Video import cancelled.", "AbortError");
}

export function waitForVideoMetadata(video, signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (video.readyState >= 1 && Number.isFinite(video.duration)) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            video.removeEventListener("loadedmetadata", onLoaded);
            video.removeEventListener("error", onError);
            signal?.removeEventListener("abort", onAbort);
        };
        const onLoaded = () => { cleanup(); resolve(); };
        const onError = () => {
            cleanup();
            reject(new Error("The browser cannot decode this video container or codec."));
        };
        const onAbort = () => { cleanup(); reject(abortError()); };
        video.addEventListener("loadedmetadata", onLoaded, { once: true });
        video.addEventListener("error", onError, { once: true });
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

export async function seekVideo(video, time, signal) {
    if (signal?.aborted) throw abortError();
    const duration = Number.isFinite(video.duration) ? video.duration : Math.max(0, time);
    const safeTime = Math.min(Math.max(0, finiteNumber(time)), Math.max(0, duration - 0.001));
    if (Math.abs(video.currentTime - safeTime) < 0.001 && video.readyState >= 2) return;
    if (Math.abs(video.currentTime - safeTime) < 0.001 && video.readyState < 2) {
        await new Promise((resolve, reject) => {
            const cleanup = () => {
                video.removeEventListener("loadeddata", onLoaded);
                video.removeEventListener("error", onError);
                signal?.removeEventListener("abort", onAbort);
            };
            const onLoaded = () => { cleanup(); resolve(); };
            const onError = () => { cleanup(); reject(new Error("Failed to decode a video frame.")); };
            const onAbort = () => { cleanup(); reject(abortError()); };
            video.addEventListener("loadeddata", onLoaded, { once: true });
            video.addEventListener("error", onError, { once: true });
            signal?.addEventListener("abort", onAbort, { once: true });
        });
        return;
    }
    await new Promise((resolve, reject) => {
        const cleanup = () => {
            video.removeEventListener("seeked", onSeeked);
            video.removeEventListener("error", onError);
            signal?.removeEventListener("abort", onAbort);
        };
        const onSeeked = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error("Failed to decode a video frame.")); };
        const onAbort = () => { cleanup(); reject(abortError()); };
        video.addEventListener("seeked", onSeeked, { once: true });
        video.addEventListener("error", onError, { once: true });
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
            video.currentTime = safeTime;
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
}

/**
 * Measure decoded source frames rather than trusting a nominal UI value.
 * presentedFrames compensates for callbacks skipped by a busy compositor.
 */
export async function detectVideoFrameRate(video, {
    signal = null,
    maxFrames = 20,
    timeoutMs = 1800,
} = {}) {
    if (!video || signal?.aborted) {
        if (signal?.aborted) throw abortError();
        return null;
    }
    await waitForVideoMetadata(video, signal);

    const saved = {
        currentTime: finiteNumber(video.currentTime),
        muted: !!video.muted,
        playbackRate: finiteNumber(video.playbackRate, 1),
        loop: !!video.loop,
    };
    const duration = Math.max(0, finiteNumber(video.duration));
    const sampleWindow = Math.min(1.5, duration);
    const sampleStart = duration > sampleWindow
        ? Math.min(duration - sampleWindow, duration * 0.1)
        : 0;
    await seekVideo(video, sampleStart, signal);

    const qualityStart = video.getVideoPlaybackQuality?.();
    const qualityFrameStart = finiteNumber(qualityStart?.totalVideoFrames, NaN);
    const mediaTimeStart = finiteNumber(video.currentTime);
    const samples = [];

    return new Promise((resolve, reject) => {
        let callbackId = null;
        let timeoutId = null;
        let settled = false;

        const cleanup = () => {
            if (callbackId !== null) video.cancelVideoFrameCallback?.(callbackId);
            if (timeoutId !== null) clearTimeout(timeoutId);
            video.removeEventListener("ended", onEnded);
            signal?.removeEventListener("abort", onAbort);
            video.pause();
            video.muted = saved.muted;
            video.playbackRate = saved.playbackRate;
            video.loop = saved.loop;
            try {
                video.currentTime = Math.min(saved.currentTime, Math.max(0, duration - 0.001));
            } catch (_) {}
        };
        const finish = error => {
            if (settled) return;
            settled = true;
            const qualityEnd = video.getVideoPlaybackQuality?.();
            const decodedFrames = finiteNumber(qualityEnd?.totalVideoFrames, NaN) - qualityFrameStart;
            const decodedDuration = finiteNumber(video.currentTime) - mediaTimeStart;
            cleanup();
            if (error) {
                reject(error);
                return;
            }
            let frameRate = estimateVideoFrameRate(samples);
            if (
                !frameRate
                && Number.isFinite(decodedFrames)
                && decodedFrames > 0
                && decodedDuration > 0
            ) {
                frameRate = estimateVideoFrameRate([
                    { mediaTime: 0, presentedFrames: 0 },
                    { mediaTime: decodedDuration, presentedFrames: decodedFrames },
                ]);
            }
            resolve(frameRate);
        };
        const onAbort = () => finish(abortError());
        const onEnded = () => finish();
        const onFrame = (_now, metadata = {}) => {
            samples.push({
                mediaTime: finiteNumber(metadata.mediaTime, video.currentTime),
                presentedFrames: finiteNumber(metadata.presentedFrames, NaN),
            });
            if (samples.length >= Math.max(2, Math.floor(finiteNumber(maxFrames, 20)))) {
                finish();
                return;
            }
            callbackId = video.requestVideoFrameCallback(onFrame);
        };

        signal?.addEventListener("abort", onAbort, { once: true });
        video.addEventListener("ended", onEnded, { once: true });
        video.muted = true;
        video.loop = false;
        video.playbackRate = 1;
        if (typeof video.requestVideoFrameCallback === "function") {
            callbackId = video.requestVideoFrameCallback(onFrame);
        }
        timeoutId = setTimeout(() => finish(), Math.max(300, finiteNumber(timeoutMs, 1800)));
        Promise.resolve(video.play()).catch(() => finish());
    });
}

export function drawVideoCover(context, source, x, y, width, height) {
    const sourceWidth = source.videoWidth || source.width || 1;
    const sourceHeight = source.videoHeight || source.height || 1;
    const scale = Math.max(width / sourceWidth, height / sourceHeight);
    const cropWidth = width / scale;
    const cropHeight = height / scale;
    const sx = (sourceWidth - cropWidth) / 2;
    const sy = (sourceHeight - cropHeight) / 2;
    context.drawImage(source, sx, sy, cropWidth, cropHeight, x, y, width, height);
}

export function canvasToBlob(canvas, type = "image/jpeg", quality = 0.9) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
            if (blob) resolve(blob);
            else reject(new Error("Failed to encode the captured video frame."));
        }, type, quality);
    });
}
