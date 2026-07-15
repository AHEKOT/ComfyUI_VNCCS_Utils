import {
    eulerDegreesToQuaternion,
    quaternionToEulerDegrees,
    slerpQuaternion,
} from "./vnccs_pose_animation.mjs";

export const VIDEO_FILE_EXTENSIONS = new Set([
    "mp4", "m4v", "webm", "mov", "ogv", "ogg", "avi", "mkv",
]);

export const MAX_VIDEO_POSE_SAMPLES = 600;

export const VIDEO_STABILIZATION_PRESETS = Object.freeze({
    off: Object.freeze({ radius: 0, strength: 0, thresholdDegrees: Infinity }),
    light: Object.freeze({ radius: 1, strength: 0.5, thresholdDegrees: 4 }),
    medium: Object.freeze({ radius: 2, strength: 0.75, thresholdDegrees: 2 }),
    strong: Object.freeze({ radius: 3, strength: 0.9, thresholdDegrees: 0.75 }),
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

export function countVideoKeyedFrames(frameCountValue, keyframeStepValue = 2) {
    const frameCount = Math.max(0, Math.floor(finiteNumber(frameCountValue)));
    if (!frameCount) return 0;
    const step = Math.max(1, Math.floor(finiteNumber(keyframeStepValue, 2)));
    const regularKeys = Math.floor((frameCount - 1) / step) + 1;
    return (frameCount - 1) % step === 0 ? regularKeys : regularKeys + 1;
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

function stabilizeEulerRotationSeries(values, preset) {
    const source = values.map(value => Array.isArray(value) ? value.slice(0, 3) : [0, 0, 0]);
    const quaternions = source.map(eulerDegreesToQuaternion);
    if (source.length < 3 || preset.radius < 1 || preset.strength <= 0) return source;
    return source.map((value, index) => {
        // Keep the selected segment boundaries exact.
        if (index === 0 || index === source.length - 1) return value;
        const localRadius = Math.min(preset.radius, index, source.length - 1 - index);
        const neighborhood = quaternions.slice(index - localRadius, index + localRadius + 1);
        const medoid = quaternionMedoid(neighborhood);
        const residual = quaternionAngularDistanceDegrees(quaternions[index], medoid);
        if (residual <= preset.thresholdDegrees) return value;

        // A one-frame quarter/full turn is never normal capture jitter. Replace
        // catastrophic flips completely; use the selected strength for smaller
        // deviations so legitimate fast motion is not flattened.
        const correction = residual >= 60 ? 1 : preset.strength;
        return quaternionToEulerDegrees(slerpQuaternion(quaternions[index], medoid, correction));
    });
}

/**
 * Suppress isolated pose-estimation jitter without averaging away steady
 * motion. Rotations are compared and blended as quaternions, so Euler axis
 * ambiguity cannot synthesize a flipped orientation.
 */
export function stabilizeVideoPoseSequence(poses, presetName = "medium") {
    const frames = Array.isArray(poses)
        ? poses.filter(pose => pose && typeof pose === "object").map(pose => JSON.parse(JSON.stringify(pose)))
        : [];
    const preset = VIDEO_STABILIZATION_PRESETS[presetName] || VIDEO_STABILIZATION_PRESETS.medium;
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
