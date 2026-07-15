export const VIDEO_FILE_EXTENSIONS = new Set([
    "mp4", "m4v", "webm", "mov", "ogv", "ogg", "avi", "mkv",
]);

export const MAX_VIDEO_POSE_SAMPLES = 600;

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
