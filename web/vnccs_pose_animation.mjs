/**
 * Sparse skeletal animation model and the Pose Studio dope-sheet UI.
 *
 * Rotations are stored as local-space quaternions.  The existing Pose Studio
 * viewer still consumes Euler XYZ degrees, so conversion happens only at the
 * evaluator boundary.  Keeping the canonical animation data quaternion based
 * avoids the common +179 -> -179 full-spin interpolation bug.
 */

export const POSE_ANIMATION_SCHEMA_VERSION = 2;
export const MODEL_ROTATION_TRACK = "@modelRotation";
export const POSE_ANIMATION_CACHE_STORAGE = "server_cache";
export const MIN_FRAME_COUNT = 2;
export const MAX_FRAME_COUNT = 600;
// Long video imports may be intentionally sampled below one pose per second.
// Keeping a small positive minimum lets a 600-key timeline retain the real
// duration of multi-hour source clips instead of silently truncating it.
export const MIN_ANIMATION_FPS = 0.001;
export const MAX_ANIMATION_FPS = 120;
export const DEFAULT_ANIMATION_FPS = 12;
export const TIMELINE_ROW_HEIGHT = 28;
export const TIMELINE_RULER_HEIGHT = 33;
const TIMELINE_LABEL_WIDTH = 210;
const TIMELINE_MIN_LANE_WIDTH = 800;
const TIMELINE_FRAME_WIDTH = 15;
const TIMELINE_MIN_PANEL_HEIGHT = 120;
const TIMELINE_MAX_PANEL_HEIGHT = 650;

export const TIMELINE_TRACK_GROUPS = Object.freeze([
    { id: "scene", label: "Scene" },
    { id: "torso", label: "Torso & Head" },
    { id: "leftArm", label: "Left Arm" },
    { id: "rightArm", label: "Right Arm" },
    { id: "leftLeg", label: "Left Leg" },
    { id: "rightLeg", label: "Right Leg" },
    { id: "leftHand", label: "Left Hand" },
    { id: "rightHand", label: "Right Hand" },
    { id: "other", label: "Other" },
]);

export const TIMELINE_FINGER_GROUPS = Object.freeze([
    { id: "thumb", label: "Thumb" },
    { id: "index", label: "Index Finger" },
    { id: "middle", label: "Middle Finger" },
    { id: "ring", label: "Ring Finger" },
    { id: "little", label: "Little Finger" },
]);

export const INTERPOLATION_PRESETS = Object.freeze([
    { value: "hold", label: "Hold / Step" },
    { value: "linear", label: "Linear" },
    { value: "easeIn", label: "Ease In" },
    { value: "easeOut", label: "Ease Out" },
    { value: "easeInOut", label: "Easy Ease" },
    { value: "smooth", label: "Smooth" },
]);

const INTERPOLATION_NAMES = new Set(INTERPOLATION_PRESETS.map(item => item.value));
let fallbackKeyId = 1;
let timelineKeyClipboard = null;
let hoveredTimeline = null;
let timelineShortcutDocument = null;

const finiteNumber = (value, fallback = 0) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const cloneJSON = (value, fallback = {}) => {
    try {
        return JSON.parse(JSON.stringify(value ?? fallback));
    } catch (_) {
        return JSON.parse(JSON.stringify(fallback));
    }
};

const createKeyId = () => {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `key_${Date.now().toString(36)}_${(fallbackKeyId++).toString(36)}`;
};

export function normalizeQuaternion(value) {
    const q = Array.isArray(value) && value.length >= 4
        ? value.slice(0, 4).map(component => finiteNumber(component, 0))
        : [0, 0, 0, 1];
    const length = Math.hypot(q[0], q[1], q[2], q[3]);
    if (length < 1e-10) return [0, 0, 0, 1];
    return q.map(component => component / length);
}

export function eulerDegreesToQuaternion(value) {
    const euler = Array.isArray(value) ? value : [0, 0, 0];
    const x = finiteNumber(euler[0]) * Math.PI / 360;
    const y = finiteNumber(euler[1]) * Math.PI / 360;
    const z = finiteNumber(euler[2]) * Math.PI / 360;
    const c1 = Math.cos(x), c2 = Math.cos(y), c3 = Math.cos(z);
    const s1 = Math.sin(x), s2 = Math.sin(y), s3 = Math.sin(z);

    // THREE.Euler default order is XYZ.
    return normalizeQuaternion([
        s1 * c2 * c3 + c1 * s2 * s3,
        c1 * s2 * c3 - s1 * c2 * s3,
        c1 * c2 * s3 + s1 * s2 * c3,
        c1 * c2 * c3 - s1 * s2 * s3,
    ]);
}

export function quaternionToEulerDegrees(value) {
    const [x, y, z, w] = normalizeQuaternion(value);
    const xx = x * x, yy = y * y, zz = z * z;
    const xy = x * y, xz = x * z, yz = y * z;
    const wx = w * x, wy = w * y, wz = w * z;

    const m11 = 1 - 2 * (yy + zz);
    const m12 = 2 * (xy - wz);
    const m13 = 2 * (xz + wy);
    const m22 = 1 - 2 * (xx + zz);
    const m23 = 2 * (yz - wx);
    const m32 = 2 * (yz + wx);
    const m33 = 1 - 2 * (xx + yy);

    const ey = Math.asin(clamp(m13, -1, 1));
    let ex;
    let ez;
    if (Math.abs(m13) < 0.9999999) {
        ex = Math.atan2(-m23, m33);
        ez = Math.atan2(-m12, m11);
    } else {
        ex = Math.atan2(m32, m22);
        ez = 0;
    }

    const scale = 180 / Math.PI;
    return [ex * scale, ey * scale, ez * scale].map(value => Math.abs(value) < 1e-10 ? 0 : value);
}

export function slerpQuaternion(aValue, bValue, tValue) {
    const a = normalizeQuaternion(aValue);
    let b = normalizeQuaternion(bValue);
    let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

    // q and -q encode the same orientation. Flip to take the shortest arc.
    if (dot < 0) {
        b = b.map(component => -component);
        dot = -dot;
    }

    const t = clamp(finiteNumber(tValue), 0, 1);
    if (dot > 0.9995) {
        return normalizeQuaternion(a.map((component, index) => component + (b[index] - component) * t));
    }

    const theta0 = Math.acos(clamp(dot, -1, 1));
    const sinTheta0 = Math.sin(theta0);
    if (Math.abs(sinTheta0) < 1e-8) return a;
    const theta = theta0 * t;
    const s0 = Math.sin(theta0 - theta) / sinTheta0;
    const s1 = Math.sin(theta) / sinTheta0;
    return normalizeQuaternion(a.map((component, index) => component * s0 + b[index] * s1));
}

export function applyInterpolation(tValue, interpolation = "linear") {
    const t = clamp(finiteNumber(tValue), 0, 1);
    switch (interpolation) {
        case "hold": return 0;
        case "easeIn": return t * t * t;
        case "easeOut": return 1 - Math.pow(1 - t, 3);
        case "easeInOut": return t < 0.5
            ? 4 * t * t * t
            : 1 - Math.pow(-2 * t + 2, 3) / 2;
        case "smooth": return t * t * t * (t * (t * 6 - 15) + 10);
        default: return t;
    }
}

function normalizePose(pose) {
    const normalized = cloneJSON(pose, {});
    if (!normalized.bones || typeof normalized.bones !== "object" || Array.isArray(normalized.bones)) {
        normalized.bones = {};
    }
    if (!Array.isArray(normalized.modelRotation)) normalized.modelRotation = [0, 0, 0];
    normalized.modelRotation = normalized.modelRotation.slice(0, 3).map(value => finiteNumber(value));
    return normalized;
}

export function getPoseTrackEuler(pose, trackName) {
    if (trackName === MODEL_ROTATION_TRACK) {
        return (pose?.modelRotation || [0, 0, 0]).slice(0, 3).map(value => finiteNumber(value));
    }
    return (pose?.bones?.[trackName] || [0, 0, 0]).slice(0, 3).map(value => finiteNumber(value));
}

function normalizeKeyframe(key, lastFrame, sourceLastFrame = lastFrame) {
    if (!key || typeof key !== "object") return null;
    const rawFrame = Number(key.frame);
    if (!Number.isFinite(rawFrame)) return null;
    let value = key.value ?? key.rotation;
    if (Array.isArray(value) && value.length === 3) value = eulerDegreesToQuaternion(value);
    if (!Array.isArray(value) || value.length < 4) return null;
    return {
        id: String(key.id || createKeyId()),
        frame: clamp(
            Math.round((rawFrame / Math.max(1, sourceLastFrame)) * Math.max(1, lastFrame)),
            0,
            lastFrame,
        ),
        value: normalizeQuaternion(value),
        interpolation: INTERPOLATION_NAMES.has(key.interpolation) ? key.interpolation : "linear",
    };
}

function normalizeTrack(track, lastFrame, sourceLastFrame = lastFrame) {
    const sourceKeys = Array.isArray(track) ? track : (track?.keys || track?.keyframes || []);
    const byFrame = new Map();
    for (const sourceKey of sourceKeys) {
        const key = normalizeKeyframe(sourceKey, lastFrame, sourceLastFrame);
        if (key) byFrame.set(key.frame, key);
    }
    return {
        valueType: "quaternion",
        keys: Array.from(byFrame.values()).sort((a, b) => a.frame - b.frame),
    };
}

export function createDefaultAnimationState(basePose = {}, overrides = {}) {
    return normalizeAnimationState({
        schemaVersion: POSE_ANIMATION_SCHEMA_VERSION,
        frameCount: 24,
        duration: 2,
        fps: DEFAULT_ANIMATION_FPS,
        currentFrame: 0,
        loop: true,
        autoKey: true,
        snap: true,
        defaultInterpolation: "easeInOut",
        basePose,
        tracks: {},
        ...overrides,
    }, basePose);
}

export function createClearedAnimationState(previousState, neutralPose = {}) {
    const previous = previousState || {};
    return createDefaultAnimationState(neutralPose, {
        frameCount: previous.frameCount,
        duration: previous.duration,
        fps: getAnimationFPS(previous),
        currentFrame: 0,
        loop: previous.loop,
        autoKey: previous.autoKey,
        snap: previous.snap,
        defaultInterpolation: previous.defaultInterpolation,
        tracks: {},
    });
}

export function serializeAnimationStateSnapshot(state) {
    const snapshot = cloneJSON(state, {});
    delete snapshot.currentFrame;
    delete snapshot.current_frame;
    return JSON.stringify(snapshot);
}

export function isAnimationCacheReference(value) {
    return !!value
        && typeof value === "object"
        && value.storage === POSE_ANIMATION_CACHE_STORAGE
        && typeof value.cacheId === "string"
        && value.cacheId.length > 0;
}

export function createAnimationCacheReference(state, {
    cacheId,
    revision = 0,
} = {}) {
    const source = state && typeof state === "object" ? state : {};
    return {
        schemaVersion: POSE_ANIMATION_SCHEMA_VERSION,
        storage: POSE_ANIMATION_CACHE_STORAGE,
        cacheId: String(cacheId || ""),
        revision: Math.max(0, Math.floor(finiteNumber(revision))),
        frameCount: clamp(Math.round(finiteNumber(source.frameCount, 24)), MIN_FRAME_COUNT, MAX_FRAME_COUNT),
        duration: Math.max(0.001, finiteNumber(source.duration, 2)),
        fps: getAnimationFPS(source),
        currentFrame: Math.max(0, Math.round(finiteNumber(source.currentFrame))),
        loop: !!source.loop,
        autoKey: !!source.autoKey,
        snap: source.snap !== false,
        defaultInterpolation: INTERPOLATION_NAMES.has(source.defaultInterpolation)
            ? source.defaultInterpolation
            : "linear",
        basePose: cloneJSON(source.basePose, {}),
        trackCount: Object.keys(source.tracks || {}).length,
    };
}

export function restoreAnimationStateSnapshot(snapshot, { currentFrame = 0, fallbackPose = {} } = {}) {
    const restored = typeof snapshot === "string" ? JSON.parse(snapshot) : cloneJSON(snapshot, {});
    restored.currentFrame = currentFrame;
    return normalizeAnimationState(restored, fallbackPose);
}

export function normalizeAnimationState(source = {}, fallbackPose = {}) {
    const raw = source && typeof source === "object" ? source : {};
    const sourceFrameCount = clamp(Math.round(finiteNumber(raw.frameCount ?? raw.frame_count, 24)), MIN_FRAME_COUNT, MAX_FRAME_COUNT);
    const schemaVersion = Math.round(finiteNumber(raw.schemaVersion ?? raw.schema_version, 1));
    const rawFps = Number(raw.fps ?? raw.frame_rate);
    const hasCurrentTiming = schemaVersion >= POSE_ANIMATION_SCHEMA_VERSION
        && Number.isFinite(rawFps)
        && rawFps >= MIN_ANIMATION_FPS;
    const fps = hasCurrentTiming
        ? clamp(rawFps, MIN_ANIMATION_FPS, MAX_ANIMATION_FPS)
        : DEFAULT_ANIMATION_FPS;
    const minDuration = MIN_FRAME_COUNT / fps;
    const maxDuration = MAX_FRAME_COUNT / fps;
    const duration = clamp(finiteNumber(raw.duration ?? raw.duration_seconds, 2), minDuration, maxDuration);
    const frameCount = clamp(Math.round(duration * fps), MIN_FRAME_COUNT, MAX_FRAME_COUNT);
    const sourceLastFrame = hasCurrentTiming ? frameCount - 1 : sourceFrameCount - 1;
    const currentFrame = hasCurrentTiming
        ? clamp(Math.round(finiteNumber(raw.currentFrame ?? raw.current_frame, 0)), 0, frameCount - 1)
        : clamp(
            Math.round(
                (finiteNumber(raw.currentFrame ?? raw.current_frame, 0) / Math.max(1, sourceLastFrame))
                * Math.max(1, frameCount - 1),
            ),
            0,
            frameCount - 1,
        );
    const state = {
        schemaVersion: POSE_ANIMATION_SCHEMA_VERSION,
        frameCount,
        duration,
        fps,
        currentFrame,
        loop: raw.loop !== false && raw.loop_mode !== "once",
        autoKey: raw.autoKey !== false && raw.auto_key !== false,
        snap: raw.snap !== false,
        defaultInterpolation: INTERPOLATION_NAMES.has(raw.defaultInterpolation)
            ? raw.defaultInterpolation
            : "easeInOut",
        basePose: normalizePose(raw.basePose ?? raw.base_pose ?? fallbackPose),
        tracks: {},
    };

    const sourceTracks = raw.tracks?.bones && typeof raw.tracks.bones === "object"
        ? { ...raw.tracks.bones, ...(raw.tracks.model || {}) }
        : (raw.tracks || {});
    if (sourceTracks && typeof sourceTracks === "object") {
        for (const [trackName, track] of Object.entries(sourceTracks)) {
            const normalized = normalizeTrack(track, frameCount - 1, sourceLastFrame);
            if (normalized.keys.length) state.tracks[trackName] = normalized;
        }
    }
    return state;
}

export function isAnimationEmpty(state) {
    return !state?.tracks || Object.values(state.tracks).every(track => !track?.keys?.length);
}

function baseQuaternionForTrack(state, trackName) {
    return eulerDegreesToQuaternion(getPoseTrackEuler(state?.basePose || {}, trackName));
}

export function evaluateTrackQuaternion(state, trackName, frameValue) {
    const track = state?.tracks?.[trackName];
    const keys = track?.keys || [];
    if (!keys.length) return baseQuaternionForTrack(state, trackName);
    const frame = clamp(finiteNumber(frameValue), 0, Math.max(0, state.frameCount - 1));
    if (frame <= keys[0].frame) return normalizeQuaternion(keys[0].value);
    if (frame >= keys[keys.length - 1].frame) return normalizeQuaternion(keys[keys.length - 1].value);

    let low = 1;
    let high = keys.length - 1;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (keys[middle].frame < frame) low = middle + 1;
        else high = middle;
    }
    const rightIndex = low;
    const left = keys[rightIndex - 1];
    const right = keys[rightIndex];
    const span = Math.max(1, right.frame - left.frame);
    const t = applyInterpolation((frame - left.frame) / span, left.interpolation);
    return slerpQuaternion(left.value, right.value, t);
}

export function evaluateAnimationFrame(state, frameValue) {
    const normalizedFrame = clamp(Math.round(finiteNumber(frameValue)), 0, Math.max(0, state.frameCount - 1));
    const basePose = state.basePose || {};
    const pose = {
        ...basePose,
        bones: Object.fromEntries(
            Object.entries(basePose.bones || {}).map(([name, rotation]) => [
                name,
                Array.isArray(rotation) ? rotation.slice(0, 3) : [0, 0, 0],
            ]),
        ),
        modelRotation: Array.isArray(basePose.modelRotation)
            ? basePose.modelRotation.slice(0, 3)
            : [0, 0, 0],
    };
    for (const trackName of Object.keys(state.tracks || {})) {
        const value = quaternionToEulerDegrees(evaluateTrackQuaternion(state, trackName, normalizedFrame));
        if (trackName === MODEL_ROTATION_TRACK) pose.modelRotation = value;
        else pose.bones[trackName] = value;
    }

    // These are editor/solver hints from a single pose, not authoritative
    // animation channels. Baked local rotations above are deterministic.
    delete pose.ikEffectorPositions;
    delete pose.poleTargetPositions;
    delete pose.hipBonePosition;
    return pose;
}

export function sampleAnimationFrames(state) {
    const frames = [];
    for (let frame = 0; frame < state.frameCount; frame++) {
        frames.push(evaluateAnimationFrame(state, frame));
    }
    return frames;
}

/**
 * Convert a sampled pose sequence (for example a retargeted Mixamo clip) into
 * one animation clip. Missing sparse Euler values are keyed as zero so a bone
 * can also return to its rest rotation later in the animation.
 */
export function createAnimationStateFromPoses(poses, options = {}) {
    const frames = Array.isArray(poses)
        ? poses.filter(pose => pose && typeof pose === "object").map(pose => normalizePose(pose))
        : [];
    if (!frames.length) throw new Error("Animation contains no pose frames.");
    if (frames.length === 1) frames.push(normalizePose(frames[0]));

    const explicitPoseFrameIndices = Array.isArray(options.poseFrameIndices)
        && options.poseFrameIndices.length === frames.length
        ? options.poseFrameIndices.map(frame => Math.max(0, Math.round(finiteNumber(frame))))
        : null;
    const inferredFrameCount = explicitPoseFrameIndices?.length
        ? Math.max(...explicitPoseFrameIndices) + 1
        : frames.length;
    const requestedFrameCount = options.frameCount === null || options.frameCount === undefined || options.frameCount === ""
        ? NaN
        : Number(options.frameCount);
    const frameCount = clamp(
        Number.isFinite(requestedFrameCount) ? Math.round(requestedFrameCount) : inferredFrameCount,
        MIN_FRAME_COUNT,
        MAX_FRAME_COUNT,
    );
    const requestedDuration = Number(options.duration);
    const fallbackFps = Math.max(1, finiteNumber(options.fps, 12));
    const duration = Number.isFinite(requestedDuration) && requestedDuration > 0
        ? requestedDuration
        : frameCount / fallbackFps;
    const state = createDefaultAnimationState(frames[0], {
        frameCount,
        duration,
        fps: frameCount / duration,
        currentFrame: 0,
        defaultInterpolation: options.interpolation || "linear",
    });
    const keyframeStep = Math.max(1, Math.floor(finiteNumber(options.keyframeStep, 1)));
    const keyedFrames = explicitPoseFrameIndices
        ? Array.from(new Set(explicitPoseFrameIndices.map(frame => clamp(frame, 0, frameCount - 1)))).sort((a, b) => a - b)
        : [];
    if (!explicitPoseFrameIndices) {
        for (let frame = 0; frame < frameCount; frame += keyframeStep) keyedFrames.push(frame);
        if (keyedFrames.at(-1) !== frameCount - 1) keyedFrames.push(frameCount - 1);
    }
    const poseByTimelineFrame = explicitPoseFrameIndices
        ? new Map(explicitPoseFrameIndices.map((frame, index) => [clamp(frame, 0, frameCount - 1), frames[index]]))
        : null;
    const poseAtFrame = frame => (
        poseByTimelineFrame ? poseByTimelineFrame.get(frame) : frames[frame]
    );
    const perTrackKeyframes = options.trackKeyframes && typeof options.trackKeyframes === "object"
        ? options.trackKeyframes
        : null;
    const framesForTrack = trackName => {
        if (!perTrackKeyframes) return keyedFrames;
        const source = perTrackKeyframes[trackName];
        if (!Array.isArray(source)) return [];
        return Array.from(new Set(source.map(frame => (
            clamp(Math.round(finiteNumber(frame)), 0, frameCount - 1)
        )))).sort((a, b) => a - b);
    };

    const boneNames = new Set();
    for (const pose of frames.slice(0, frameCount)) {
        for (const boneName of Object.keys(pose.bones || {})) boneNames.add(boneName);
    }
    for (const boneName of boneNames) {
        for (const frame of framesForTrack(boneName)) {
            const pose = poseAtFrame(frame);
            if (!pose) continue;
            setTrackKeyframeFromEuler(
                state,
                boneName,
                frame,
                getPoseTrackEuler(pose, boneName),
                state.defaultInterpolation,
            );
        }
    }
    for (const frame of framesForTrack(MODEL_ROTATION_TRACK)) {
        const pose = poseAtFrame(frame);
        if (!pose) continue;
        setTrackKeyframeFromEuler(
            state,
            MODEL_ROTATION_TRACK,
            frame,
            getPoseTrackEuler(pose, MODEL_ROTATION_TRACK),
            state.defaultInterpolation,
        );
    }
    return state;
}

export function setTrackKeyframe(state, trackName, frameValue, quaternionValue, interpolation) {
    if (!state || !trackName) return null;
    const frame = clamp(Math.round(finiteNumber(frameValue)), 0, state.frameCount - 1);
    const type = INTERPOLATION_NAMES.has(interpolation) ? interpolation : state.defaultInterpolation;
    let track = state.tracks[trackName];
    if (!track) {
        track = state.tracks[trackName] = { valueType: "quaternion", keys: [] };
    }

    // A first key later than frame zero gets an implicit baseline key, so the
    // animation does not unexpectedly change all earlier frames.
    if (!track.keys.length && frame > 0) {
        track.keys.push({
            id: createKeyId(),
            frame: 0,
            value: baseQuaternionForTrack(state, trackName),
            interpolation: type,
        });
    }

    let key = track.keys.find(item => item.frame === frame);
    if (key) {
        key.value = normalizeQuaternion(quaternionValue);
    } else {
        key = {
            id: createKeyId(),
            frame,
            value: normalizeQuaternion(quaternionValue),
            interpolation: type,
        };
        track.keys.push(key);
        track.keys.sort((a, b) => a.frame - b.frame);
    }
    return key;
}

export function setTrackKeyframeFromEuler(state, trackName, frame, eulerValue, interpolation) {
    return setTrackKeyframe(state, trackName, frame, eulerDegreesToQuaternion(eulerValue), interpolation);
}

export function deleteTrackKeyframe(state, trackName, frameValue) {
    const track = state?.tracks?.[trackName];
    if (!track) return false;
    const frame = Math.round(finiteNumber(frameValue));
    const previousLength = track.keys.length;
    track.keys = track.keys.filter(key => key.frame !== frame);
    if (!track.keys.length) delete state.tracks[trackName];
    return track.keys?.length !== previousLength || (!state.tracks[trackName] && previousLength > 0);
}

export function moveTrackKeyframe(state, trackName, fromFrameValue, toFrameValue) {
    const track = state?.tracks?.[trackName];
    if (!track) return null;
    const fromFrame = Math.round(finiteNumber(fromFrameValue));
    const toFrame = clamp(Math.round(finiteNumber(toFrameValue)), 0, state.frameCount - 1);
    const key = track.keys.find(item => item.frame === fromFrame);
    if (!key) return null;
    track.keys = track.keys.filter(item => item === key || item.frame !== toFrame);
    key.frame = toFrame;
    track.keys.sort((a, b) => a.frame - b.frame);
    return key;
}

export function setKeyframeInterpolation(state, trackName, frameValue, interpolation) {
    if (!INTERPOLATION_NAMES.has(interpolation)) return false;
    const key = state?.tracks?.[trackName]?.keys?.find(item => item.frame === Math.round(finiteNumber(frameValue)));
    if (!key) return false;
    key.interpolation = interpolation;
    return true;
}

function resolveKeyframeSelections(state, selections = []) {
    const resolved = [];
    const seen = new Set();
    const lookups = new Map();
    for (const selection of selections || []) {
        const trackName = selection?.trackName;
        const track = state?.tracks?.[trackName];
        if (!track) continue;
        if (!lookups.has(trackName)) {
            lookups.set(trackName, {
                byId: new Map(track.keys.map(key => [key.id, key])),
                byFrame: new Map(track.keys.map(key => [key.frame, key])),
            });
        }
        const lookup = lookups.get(trackName);
        const key = selection.keyId
            ? lookup.byId.get(selection.keyId)
            : lookup.byFrame.get(Math.round(finiteNumber(selection?.frame)));
        if (!key || seen.has(key.id)) continue;
        seen.add(key.id);
        resolved.push({ trackName, key });
    }
    return resolved;
}

export function findKeyframesInRange(state, trackNames, range = {}) {
    const names = Array.isArray(trackNames) ? trackNames : [];
    const firstTrack = clamp(Math.floor(finiteNumber(range.startTrack)), 0, Math.max(0, names.length - 1));
    const lastTrack = clamp(Math.floor(finiteNumber(range.endTrack)), 0, Math.max(0, names.length - 1));
    const startTrack = Math.min(firstTrack, lastTrack);
    const endTrack = Math.max(firstTrack, lastTrack);
    const startFrame = Math.min(finiteNumber(range.startFrame), finiteNumber(range.endFrame));
    const endFrame = Math.max(finiteNumber(range.startFrame), finiteNumber(range.endFrame));
    const selections = [];
    for (let index = startTrack; index <= endTrack; index++) {
        const trackName = names[index];
        for (const key of state?.tracks?.[trackName]?.keys || []) {
            if (key.frame >= startFrame && key.frame <= endFrame) {
                selections.push({ trackName, keyId: key.id, frame: key.frame });
            }
        }
    }
    return selections;
}

export function moveKeyframeSelection(state, selections, deltaFrameValue) {
    const resolved = resolveKeyframeSelections(state, selections);
    if (!resolved.length) return { delta: 0, selections: [] };
    const requestedDelta = Math.round(finiteNumber(deltaFrameValue));
    const minimumFrame = Math.min(...resolved.map(item => item.key.frame));
    const maximumFrame = Math.max(...resolved.map(item => item.key.frame));
    const delta = clamp(requestedDelta, -minimumFrame, state.frameCount - 1 - maximumFrame);
    if (!delta) {
        return {
            delta: 0,
            selections: resolved.map(({ trackName, key }) => ({ trackName, keyId: key.id, frame: key.frame })),
        };
    }

    const byTrack = new Map();
    for (const item of resolved) {
        if (!byTrack.has(item.trackName)) byTrack.set(item.trackName, []);
        byTrack.get(item.trackName).push(item.key);
    }
    for (const [trackName, movingKeys] of byTrack) {
        const track = state.tracks[trackName];
        const movingIds = new Set(movingKeys.map(key => key.id));
        const destinationFrames = new Set(movingKeys.map(key => key.frame + delta));
        const stationary = track.keys.filter(key => !movingIds.has(key.id) && !destinationFrames.has(key.frame));
        for (const key of movingKeys) key.frame += delta;
        track.keys = [...stationary, ...movingKeys].sort((a, b) => a.frame - b.frame);
    }
    return {
        delta,
        selections: resolved.map(({ trackName, key }) => ({ trackName, keyId: key.id, frame: key.frame })),
    };
}

export function copyKeyframeSelection(state, selections) {
    const resolved = resolveKeyframeSelections(state, selections);
    if (!resolved.length) return null;
    const firstFrame = Math.min(...resolved.map(item => item.key.frame));
    return {
        schema: "vnccs.pose-studio.keyframes.v1",
        frameSpan: Math.max(...resolved.map(item => item.key.frame)) - firstFrame,
        keys: resolved.map(({ trackName, key }) => ({
            trackName,
            offset: key.frame - firstFrame,
            value: normalizeQuaternion(key.value),
            interpolation: INTERPOLATION_NAMES.has(key.interpolation) ? key.interpolation : "linear",
        })),
    };
}

export function pasteKeyframeSelection(state, clipboard, startFrameValue) {
    if (clipboard?.schema !== "vnccs.pose-studio.keyframes.v1" || !Array.isArray(clipboard.keys)) return [];
    const validKeys = clipboard.keys.filter(item => item?.trackName && Array.isArray(item.value));
    if (!validKeys.length) return [];
    const maximumOffset = Math.max(0, ...validKeys.map(item => Math.max(0, Math.round(finiteNumber(item.offset)))));
    const startFrame = clamp(
        Math.round(finiteNumber(startFrameValue)),
        0,
        Math.max(0, state.frameCount - 1 - maximumOffset),
    );
    const pasted = [];
    for (const item of validKeys) {
        const frame = clamp(startFrame + Math.max(0, Math.round(finiteNumber(item.offset))), 0, state.frameCount - 1);
        let track = state.tracks[item.trackName];
        if (!track) track = state.tracks[item.trackName] = { valueType: "quaternion", keys: [] };
        track.keys = track.keys.filter(key => key.frame !== frame);
        const key = {
            id: createKeyId(),
            frame,
            value: normalizeQuaternion(item.value),
            interpolation: INTERPOLATION_NAMES.has(item.interpolation) ? item.interpolation : state.defaultInterpolation,
        };
        track.keys.push(key);
        track.keys.sort((a, b) => a.frame - b.frame);
        pasted.push({ trackName: item.trackName, keyId: key.id, frame });
    }
    return pasted;
}

export function retimeAnimationFrameCount(state, nextFrameCountValue) {
    const nextFrameCount = clamp(Math.round(finiteNumber(nextFrameCountValue, state.frameCount)), MIN_FRAME_COUNT, MAX_FRAME_COUNT);
    const previousFrameCount = state.frameCount;
    if (previousFrameCount === nextFrameCount) return state;
    const previousLast = Math.max(1, previousFrameCount - 1);
    const nextLast = nextFrameCount - 1;
    for (const track of Object.values(state.tracks || {})) {
        const byFrame = new Map();
        for (const key of track.keys || []) {
            key.frame = clamp(Math.round((key.frame / previousLast) * nextLast), 0, nextLast);
            byFrame.set(key.frame, key);
        }
        track.keys = Array.from(byFrame.values()).sort((a, b) => a.frame - b.frame);
    }
    state.frameCount = nextFrameCount;
    state.currentFrame = clamp(Math.round((state.currentFrame / previousLast) * nextLast), 0, nextLast);
    return state;
}

export function getAnimationFPS(state) {
    return clamp(
        finiteNumber(state?.fps, DEFAULT_ANIMATION_FPS),
        MIN_ANIMATION_FPS,
        MAX_ANIMATION_FPS,
    );
}

export function playbackFrameForElapsed(elapsedMilliseconds, fpsValue) {
    const fps = clamp(
        finiteNumber(fpsValue, DEFAULT_ANIMATION_FPS),
        MIN_ANIMATION_FPS,
        MAX_ANIMATION_FPS,
    );
    return Math.floor((Math.max(0, finiteNumber(elapsedMilliseconds)) / 1000) * fps);
}

export function resolveCaptureCameraParams(poseParams = {}, currentParams = {}, animationMode = false) {
    const source = animationMode
        ? currentParams
        : { ...currentParams, ...(poseParams || {}) };
    const number = (value, fallback) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    };
    return {
        zoom: number(source.zoom, 1),
        offset_x: number(source.offset_x, 0),
        offset_y: number(source.offset_y, 0),
        yaw_deg: number(source.yaw_deg, 0),
        pitch_deg: number(source.pitch_deg, 0),
    };
}

export function selectRandomLibraryPoseData(libraryPoses = [], random = Math.random) {
    const candidates = (Array.isArray(libraryPoses) ? libraryPoses : []).filter(item => (
        item?.data
        && typeof item.data === "object"
        && item?.asset_type !== "animation"
        && item?.data?._library?.asset_type !== "animation"
        && !item?.data?.animation
    ));
    if (!candidates.length) return null;
    const raw = Number(random());
    const normalized = Number.isFinite(raw)
        ? Math.min(0.9999999999999999, Math.max(0, raw))
        : 0;
    return candidates[Math.floor(normalized * candidates.length)].data;
}

export function resolveDebugLightingMode({
    keepManualLighting = false,
    keepOriginalLighting = false,
} = {}) {
    if (keepOriginalLighting) return "original";
    if (keepManualLighting) return "manual";
    return "random";
}

/**
 * Keep duration, frame rate, and the internal integer frame count in sync.
 * Duration is quantized to a whole frame so the three values can never
 * describe different timelines.
 */
export function retimeAnimationTiming(state, { duration, fps } = {}) {
    if (!state) return state;
    const previousFps = getAnimationFPS(state);
    const requestedFps = fps === undefined
        ? previousFps
        : clamp(finiteNumber(fps, previousFps), MIN_ANIMATION_FPS, MAX_ANIMATION_FPS);
    const minDuration = MIN_FRAME_COUNT / requestedFps;
    const maxDuration = MAX_FRAME_COUNT / requestedFps;
    const requestedDuration = duration === undefined
        ? clamp(finiteNumber(state.duration, 2), minDuration, maxDuration)
        : clamp(finiteNumber(duration, state.duration), minDuration, maxDuration);
    const nextFrameCount = clamp(
        Math.round(requestedDuration * requestedFps),
        MIN_FRAME_COUNT,
        MAX_FRAME_COUNT,
    );
    retimeAnimationFrameCount(state, nextFrameCount);
    state.fps = requestedFps;
    state.duration = requestedDuration;
    state.schemaVersion = POSE_ANIMATION_SCHEMA_VERSION;
    return state;
}

function shortestAngleDelta(a, b) {
    return ((b - a + 540) % 360) - 180;
}

export function findChangedPoseTracks(expectedPose, actualPose, epsilon = 0.01) {
    const changed = [];
    const names = new Set([
        ...Object.keys(expectedPose?.bones || {}),
        ...Object.keys(actualPose?.bones || {}),
    ]);
    for (const name of names) {
        const expected = getPoseTrackEuler(expectedPose, name);
        const actual = getPoseTrackEuler(actualPose, name);
        if (actual.some((value, index) => Math.abs(shortestAngleDelta(expected[index], value)) > epsilon)) {
            changed.push(name);
        }
    }
    const expectedModel = getPoseTrackEuler(expectedPose, MODEL_ROTATION_TRACK);
    const actualModel = getPoseTrackEuler(actualPose, MODEL_ROTATION_TRACK);
    if (actualModel.some((value, index) => Math.abs(shortestAngleDelta(expectedModel[index], value)) > epsilon)) {
        changed.push(MODEL_ROTATION_TRACK);
    }
    return changed;
}

const TIMELINE_GROUP_BY_ID = new Map(TIMELINE_TRACK_GROUPS.map(group => [group.id, group]));

function cleanBoneName(name) {
    return String(name || "")
        .replace(/^.*[|:]/, "")
        .replace(/^mixamorig/i, "")
        .replace(/([a-z\d])([A-Z])/g, "$1 $2")
        .replace(/[.\-]+/g, "_")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "");
}

function trackSide(name) {
    const clean = cleanBoneName(name).toLowerCase();
    if (/(^|_)left($|_)/.test(clean) || /(^|_)l($|_)/.test(clean) || /_l\d*$/.test(clean)) return "left";
    if (/(^|_)right($|_)/.test(clean) || /(^|_)r($|_)/.test(clean) || /_r\d*$/.test(clean)) return "right";
    return null;
}

export function timelineGroupIdForTrack(name) {
    if (name === MODEL_ROTATION_TRACK) return "scene";
    const clean = cleanBoneName(name).toLowerCase();
    const side = trackSide(clean);
    const isHand = /(hand|wrist|thumb|index|middle|ring|pinky|little|finger|digit)/.test(clean);
    const isArm = /(clavicle|collar|shoulder|upper_?arm|lower_?arm|forearm|elbow|arm)/.test(clean);
    const isLeg = /(upper_?leg|lower_?leg|thigh|calf|shin|knee|ankle|foot|toe|leg)/.test(clean);
    const isTorso = /(root|hips?|pelvis|spine|chest|torso|neck|head|jaw|eye)/.test(clean);
    if (isHand && side) return side === "left" ? "leftHand" : "rightHand";
    if (isArm && side) return side === "left" ? "leftArm" : "rightArm";
    if (isLeg && side) return side === "left" ? "leftLeg" : "rightLeg";
    if (isTorso) return "torso";
    return "other";
}

export function timelineFingerGroupIdForTrack(name) {
    const clean = cleanBoneName(name).toLowerCase();
    if (/thumb/.test(clean)) return "thumb";
    if (/(^|_)index(?:_|\d|$)/.test(clean)) return "index";
    if (/middle/.test(clean)) return "middle";
    if (/(^|_)ring(?:_|\d|$)/.test(clean)) return "ring";
    if (/(pinky|little)/.test(clean)) return "little";
    return null;
}

function timelineExpansionIdsForTrack(trackName) {
    const groupId = timelineGroupIdForTrack(trackName);
    const ids = [groupId];
    const fingerId = timelineFingerGroupIdForTrack(trackName);
    if (fingerId && (groupId === "leftHand" || groupId === "rightHand")) {
        ids.push(`${groupId}:${fingerId}`);
    }
    return ids;
}

function sidePrefix(name) {
    const side = trackSide(name);
    return side === "left" ? "Left " : side === "right" ? "Right " : "";
}

function numberedPartLabel(base, number) {
    if (!number) return base;
    const normalized = Number(number);
    if (normalized === 1) return `${base} — Base`;
    if (normalized === 2) return `${base} — Middle`;
    if (normalized === 3) return `${base} — Tip`;
    return `${base} ${String(number).padStart(2, "0")}`;
}

export function humanizeBoneName(name) {
    if (name === MODEL_ROTATION_TRACK) return "Model Rotation";
    const raw = cleanBoneName(name);
    const lower = raw.toLowerCase();
    const side = sidePrefix(raw);
    const withoutSide = lower
        .replace(/(^|_)(left|right|l|r)(?=_|$)/g, "_")
        .replace(/_(left|right|l|r)$/g, "")
        .replace(/^_|_$/g, "");

    const finger = withoutSide.match(/(thumb|index|middle|ring|pinky|little|finger)[_ ]?(\d+)?/);
    if (finger) {
        const fingerName = finger[1] === "pinky" || finger[1] === "little"
            ? "Little Finger"
            : `${finger[1][0].toUpperCase()}${finger[1].slice(1)}${finger[1] === "thumb" ? "" : " Finger"}`;
        return `${side}${numberedPartLabel(fingerName, finger[2])}`;
    }

    const compact = withoutSide.replace(/_/g, "");
    const exact = {
        root: "Root",
        hips: "Pelvis",
        hip: "Pelvis",
        pelvis: "Pelvis",
        neck: "Neck",
        head: "Head",
        jaw: "Jaw",
        eye: "Eye",
        clavicle: "Clavicle",
        collar: "Clavicle",
        shoulder: "Shoulder",
        arm: "Upper Arm",
        upperarm: "Upper Arm",
        lowerarm: "Forearm",
        forearm: "Forearm",
        elbow: "Elbow",
        wrist: "Wrist",
        hand: "Hand",
        upperleg: "Thigh",
        thigh: "Thigh",
        lowerleg: "Lower Leg",
        calf: "Lower Leg",
        shin: "Lower Leg",
        knee: "Knee",
        ankle: "Ankle",
        foot: "Foot",
        toe: "Toes",
        toebase: "Toes",
    };
    if (exact[compact]) return `${side}${exact[compact]}`;

    const spine = compact.match(/^(spine|chest)(\d+)$/);
    if (spine) return `${spine[1] === "chest" ? "Chest" : "Spine"} ${String(Number(spine[2])).padStart(2, "0")}`;
    const generic = withoutSide
        .replace(/_/g, " ")
        .replace(/\bupperarm\b/gi, "Upper Arm")
        .replace(/\blowerarm\b/gi, "Forearm")
        .replace(/\bupperleg\b/gi, "Thigh")
        .replace(/\blowerleg\b/gi, "Lower Leg")
        .replace(/\b\w/g, character => character.toUpperCase());
    return `${side}${generic}`.trim();
}

export function groupTimelineTracks(trackNames = []) {
    const uniqueNames = Array.from(new Set((trackNames || []).filter(Boolean)));
    const grouped = new Map(TIMELINE_TRACK_GROUPS.map(group => [group.id, []]));
    for (const trackName of uniqueNames) grouped.get(timelineGroupIdForTrack(trackName)).push(trackName);
    return TIMELINE_TRACK_GROUPS.map(group => ({
        ...group,
        trackNames: grouped.get(group.id),
    })).filter(group => group.trackNames.length);
}

function timelineTrackHasKeys(state, trackName) {
    return !!state?.tracks?.[trackName]?.keys?.length;
}

export function aggregateTimelineKeyFrames(state, trackNames = []) {
    const frames = new Set();
    for (const trackName of trackNames) {
        for (const key of state?.tracks?.[trackName]?.keys || []) frames.add(key.frame);
    }
    return Array.from(frames).sort((a, b) => a - b);
}

/**
 * Build the flat row projection used by the virtual list. Group rows retain
 * their descendant track names so selections never depend on mounted DOM rows.
 */
export function buildTimelineRows({
    state,
    trackNames = [],
    expandedGroups = new Set(),
    viewMode = "animated",
    activeTrack = null,
    focusTrackNames = [],
    selectedTrackNames = [],
    search = "",
} = {}) {
    const query = String(search || "").trim().toLowerCase();
    const selected = new Set(selectedTrackNames || []);
    const focused = new Set(focusTrackNames || []);
    const activeGroup = activeTrack ? timelineGroupIdForTrack(activeTrack) : null;
    const groups = groupTimelineTracks(trackNames);
    const rows = [];
    for (const group of groups) {
        const groupMatchesSearch = !query || group.label.toLowerCase().includes(query);
        let candidates = group.trackNames.filter(trackName => {
            if (trackName === activeTrack) return true;
            if (viewMode === "animated" && !timelineTrackHasKeys(state, trackName)) return false;
            if (
                viewMode === "focus"
                && (focused.size ? !focused.has(trackName) : group.id !== activeGroup)
            ) return false;
            if (viewMode === "selected" && !selected.has(trackName)) return false;
            return true;
        });
        if (query && !groupMatchesSearch) {
            candidates = candidates.filter(trackName => (
                trackName.toLowerCase().includes(query)
                || humanizeBoneName(trackName).toLowerCase().includes(query)
            ));
        }
        if (activeTrack && group.trackNames.includes(activeTrack) && !candidates.includes(activeTrack)) {
            candidates.push(activeTrack);
        }
        if (!candidates.length) continue;
        const forcedExpanded = !!query || viewMode === "focus" || viewMode === "selected";
        const projectedExpanded = expandedGroups.has(group.id) || forcedExpanded;
        const keyFrames = aggregateTimelineKeyFrames(state, candidates);
        rows.push({
            type: "group",
            id: `group:${group.id}`,
            groupId: group.id,
            depth: 0,
            label: group.label,
            trackNames: candidates,
            keyFrames,
            keyCount: candidates.reduce((sum, name) => sum + (state?.tracks?.[name]?.keys?.length || 0), 0),
            expanded: projectedExpanded,
            forcedExpanded,
        });
        if (projectedExpanded) {
            const appendTrack = (trackName, depth = 1) => {
                rows.push({
                    type: "track",
                    id: `track:${trackName}`,
                    groupId: group.id,
                    depth,
                    trackName,
                    trackNames: [trackName],
                    label: humanizeBoneName(trackName),
                    rawName: trackName,
                    keyFrames: (state?.tracks?.[trackName]?.keys || []).map(key => key.frame),
                    keyCount: state?.tracks?.[trackName]?.keys?.length || 0,
                    active: trackName === activeTrack,
                });
            };
            if (group.id === "leftHand" || group.id === "rightHand") {
                const fingerTracks = new Map(TIMELINE_FINGER_GROUPS.map(finger => [finger.id, []]));
                const directTracks = [];
                for (const trackName of candidates) {
                    const fingerId = timelineFingerGroupIdForTrack(trackName);
                    if (fingerId) fingerTracks.get(fingerId)?.push(trackName);
                    else directTracks.push(trackName);
                }
                for (const trackName of directTracks) appendTrack(trackName, 1);
                for (const finger of TIMELINE_FINGER_GROUPS) {
                    const tracks = fingerTracks.get(finger.id) || [];
                    if (!tracks.length) continue;
                    const subgroupId = `${group.id}:${finger.id}`;
                    const subgroupForcedExpanded = !!query || viewMode === "focus" || viewMode === "selected";
                    const subgroupExpanded = expandedGroups.has(subgroupId) || subgroupForcedExpanded;
                    rows.push({
                        type: "group",
                        id: `group:${subgroupId}`,
                        groupId: subgroupId,
                        parentGroupId: group.id,
                        depth: 1,
                        label: finger.label,
                        trackNames: tracks,
                        keyFrames: aggregateTimelineKeyFrames(state, tracks),
                        keyCount: tracks.reduce((sum, name) => sum + (state?.tracks?.[name]?.keys?.length || 0), 0),
                        expanded: subgroupExpanded,
                        forcedExpanded: subgroupForcedExpanded,
                    });
                    if (subgroupExpanded) {
                        for (const trackName of tracks) appendTrack(trackName, 2);
                    }
                }
            } else {
                for (const trackName of candidates) appendTrack(trackName, 1);
            }
        }
    }
    return rows;
}

export function findKeyframesInTimelineRows(state, rows, range = {}) {
    const firstRow = clamp(Math.floor(finiteNumber(range.startRow)), 0, Math.max(0, rows.length - 1));
    const lastRow = clamp(Math.floor(finiteNumber(range.endRow)), 0, Math.max(0, rows.length - 1));
    const startRow = Math.min(firstRow, lastRow);
    const endRow = Math.max(firstRow, lastRow);
    const startFrame = Math.min(finiteNumber(range.startFrame), finiteNumber(range.endFrame));
    const endFrame = Math.max(finiteNumber(range.startFrame), finiteNumber(range.endFrame));
    const selections = [];
    const seen = new Set();
    for (let rowIndex = startRow; rowIndex <= endRow; rowIndex++) {
        for (const trackName of rows[rowIndex]?.trackNames || []) {
            for (const key of state?.tracks?.[trackName]?.keys || []) {
                const id = `${trackName}\u0000${key.id}`;
                if (seen.has(id) || key.frame < startFrame || key.frame > endFrame) continue;
                seen.add(id);
                selections.push({ trackName, keyId: key.id, frame: key.frame });
            }
        }
    }
    return selections;
}

export function timelineViewportToContentPoint({
    clientX,
    clientY,
    viewportRect,
    offsetWidth,
    offsetHeight,
    clientLeft = 0,
    clientTop = 0,
    scrollLeft = 0,
    scrollTop = 0,
} = {}) {
    const rect = viewportRect || { left: 0, top: 0, width: 1, height: 1 };
    const scaleX = Math.max(1e-6, finiteNumber(rect.width, 1) / Math.max(1, finiteNumber(offsetWidth, rect.width)));
    const scaleY = Math.max(1e-6, finiteNumber(rect.height, 1) / Math.max(1, finiteNumber(offsetHeight, rect.height)));
    return {
        x: Math.max(0, finiteNumber(scrollLeft) + ((finiteNumber(clientX) - finiteNumber(rect.left) - finiteNumber(clientLeft) * scaleX) / scaleX)),
        y: Math.max(0, finiteNumber(scrollTop) + ((finiteNumber(clientY) - finiteNumber(rect.top) - finiteNumber(clientTop) * scaleY) / scaleY)),
        scaleX,
        scaleY,
    };
}

export function timelineContentPointToPosition(point, {
    laneLeft = 168,
    laneWidth = 640,
    rulerHeight = TIMELINE_RULER_HEIGHT,
    rowHeight = TIMELINE_ROW_HEIGHT,
    rowCount = 0,
    frameCount = MIN_FRAME_COUNT,
} = {}) {
    const frame = clamp(
        ((finiteNumber(point?.x) - laneLeft) / Math.max(1, finiteNumber(laneWidth, 640))) * Math.max(1, frameCount - 1),
        0,
        Math.max(1, frameCount - 1),
    );
    const row = clamp(
        Math.floor((finiteNumber(point?.y) - rulerHeight) / Math.max(1, finiteNumber(rowHeight, TIMELINE_ROW_HEIGHT))),
        0,
        Math.max(0, Math.floor(finiteNumber(rowCount)) - 1),
    );
    return { frame, row };
}

function niceTickStep(frameCount) {
    const target = Math.max(1, frameCount / 12);
    const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
    const residual = target / magnitude;
    const nice = residual >= 5 ? 5 : residual >= 2 ? 2 : 1;
    return Math.max(1, nice * magnitude);
}

export function computeVirtualTrackRange({
    count,
    scrollTop,
    viewportHeight,
    rowHeight = TIMELINE_ROW_HEIGHT,
    rulerHeight = TIMELINE_RULER_HEIGHT,
    overscan = 3,
    chunkSize = 4,
} = {}) {
    const total = Math.max(0, Math.floor(finiteNumber(count)));
    if (!total) return { start: 0, end: 0 };
    const height = Math.max(rowHeight, finiteNumber(viewportHeight, 238));
    const top = Math.max(0, finiteNumber(scrollTop) - rulerHeight);
    const bottom = Math.max(0, finiteNumber(scrollTop) + height - rulerHeight);
    const firstVisible = Math.floor(top / rowHeight);
    const lastVisibleExclusive = Math.ceil(bottom / rowHeight);
    const rawStart = Math.max(0, firstVisible - overscan);
    const rawEnd = Math.min(total, lastVisibleExclusive + overscan);
    const start = Math.max(0, Math.floor(rawStart / chunkSize) * chunkSize);
    const end = Math.min(total, Math.ceil(rawEnd / chunkSize) * chunkSize);
    return { start, end };
}

export function computeVisibleFrameRange({
    frameCount,
    laneWidth,
    scrollLeft,
    viewportWidth,
    labelWidth = TIMELINE_LABEL_WIDTH,
    overscanPixels = 320,
    chunkSize = 20,
} = {}) {
    const count = Math.max(MIN_FRAME_COUNT, Math.round(finiteNumber(frameCount, 24)));
    const width = Math.max(1, finiteNumber(laneWidth, 640));
    const viewport = Math.max(1, finiteNumber(viewportWidth, 1000));
    const left = Math.max(0, finiteNumber(scrollLeft) - labelWidth - overscanPixels);
    const right = Math.min(width, finiteNumber(scrollLeft) + viewport - labelWidth + overscanPixels);
    const lastFrame = count - 1;
    const rawStart = clamp(Math.floor((left / width) * lastFrame), 0, lastFrame);
    const rawEnd = clamp(Math.ceil((Math.max(left, right) / width) * lastFrame), 0, lastFrame);
    const start = Math.max(0, Math.floor(rawStart / chunkSize) * chunkSize);
    const end = Math.min(lastFrame, Math.ceil(rawEnd / chunkSize) * chunkSize);
    return { start, end };
}

export function findNearestKeyframeAtPosition(keys, pointerX, laneWidth, frameCount, threshold = 9) {
    if (!Array.isArray(keys) || !keys.length) return null;
    const width = Math.max(1, finiteNumber(laneWidth, 1));
    const lastFrame = Math.max(1, Math.round(finiteNumber(frameCount, 2)) - 1);
    const targetFrame = clamp((finiteNumber(pointerX) / width) * lastFrame, 0, lastFrame);
    let low = 0;
    let high = keys.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (keys[middle].frame < targetFrame) low = middle + 1;
        else high = middle;
    }
    let nearest = null;
    let nearestDistance = Infinity;
    for (const index of [low - 1, low]) {
        const key = keys[index];
        if (!key) continue;
        const x = (key.frame / lastFrame) * width;
        const distance = Math.abs(x - pointerX);
        if (distance < nearestDistance) {
            nearest = key;
            nearestDistance = distance;
        }
    }
    return nearestDistance <= Math.max(1, finiteNumber(threshold, 9)) ? nearest : null;
}

function installTimelineShortcuts(doc) {
    if (!doc || timelineShortcutDocument === doc) return;
    timelineShortcutDocument = doc;
    doc.defaultView?.addEventListener("keydown", event => {
        const timeline = hoveredTimeline;
        if (!timeline?._pointerInside || !timeline.element?.isConnected) return;
        const target = event.target;
        if (target?.matches?.("input, select, textarea, [contenteditable='true']")) return;
        if (event.key === "Delete" || event.key === "Backspace") {
            event.preventDefault();
            event.stopImmediatePropagation();
            timeline.deleteSelectedKeys();
            return;
        }
        const command = event.ctrlKey || event.metaKey;
        if (!command || event.altKey || event.shiftKey) return;
        const key = String(event.key || "").toLowerCase();
        if (key !== "c" && key !== "v") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (key === "c") timeline.copySelectedKeys();
        else timeline.pasteCopiedKeys();
    }, true);
}

/**
 * Lightweight dope-sheet.  It deliberately owns only transient UI state;
 * all durable data lives in the plain animation state object above.
 */
export class PoseAnimationTimeline {
    constructor(options = {}) {
        this.state = options.state;
        this.boneNames = Array.isArray(options.boneNames) ? options.boneNames : [];
        this.onFrameChange = options.onFrameChange || (() => {});
        this.onStateChange = options.onStateChange || (() => {});
        this.onRequestKey = options.onRequestKey || (() => {});
        this.onTrackSelect = options.onTrackSelect || (() => {});
        this.onTrackHover = options.onTrackHover || (() => {});
        this.getPreferredTrack = options.getPreferredTrack || (() => null);
        this.getFocusTracks = options.getFocusTracks || (() => []);
        this.search = "";
        this.viewMode = "animated";
        this.activeTrack = options.activeTrack || this.getPreferredTrack() || null;
        this.expandedGroups = new Set();
        if (this.activeTrack) {
            for (const id of timelineExpansionIdsForTrack(this.activeTrack)) this.expandedGroups.add(id);
        }
        this.collapsed = false;
        this.selectedKey = null;
        this.selectedKeys = new Map();
        this._raf = null;
        this._playing = false;
        this._virtualRange = { start: -1, end: -1 };
        this._virtualFrameRange = { start: -1, end: -1 };
        this._virtualNames = [];
        this._virtualRows = [];
        this._laneContentLeft = TIMELINE_LABEL_WIDTH;
        this._virtualScrollRaf = null;
        this._visiblePlayheads = [];
        this._visibleKeyLanes = [];
        this._rulerPlayhead = null;
        this._dragPreview = null;
        this._pointerInside = false;
        this._suppressKeyClick = false;
        this._keyDrawRaf = null;
        this._keyDrawToolbar = false;
        this._rowKeyCache = new WeakMap();
        this._marquee = null;
        this._marqueeRaf = null;
        this._activeResizeCancel = null;
        this._activeKeyDragCancel = null;
        this._build();
        this.render();
    }

    _button(text, title, handler, className = "") {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `vnccs-ps-tl-btn ${className}`.trim();
        button.textContent = text;
        button.title = title;
        button.addEventListener("click", handler);
        return button;
    }

    _build() {
        this.element = document.createElement("section");
        this.element.className = "vnccs-ps-timeline";
        this.element.tabIndex = 0;

        this.toolbar = document.createElement("div");
        this.toolbar.className = "vnccs-ps-tl-toolbar";
        this.firstButton = this._button("|◀", "First frame", () => this.setFrame(0));
        this.previousButton = this._button("◀", "Previous frame", () => this.setFrame(this.state.currentFrame - 1));
        this.playButton = this._button("▶", "Play / Pause (Space)", () => this.togglePlayback(), "play");
        this.nextButton = this._button("▶", "Next frame", () => this.setFrame(this.state.currentFrame + 1));
        this.lastButton = this._button("▶|", "Last frame", () => this.setFrame(this.state.frameCount - 1));

        this.frameInput = document.createElement("input");
        this.frameInput.className = "vnccs-ps-tl-number current-frame";
        this.frameInput.type = "number";
        this.frameInput.min = "0";
        this.frameInput.title = "Current frame number";
        this.frameInput.addEventListener("change", () => this.setFrame(this.frameInput.value));

        this.status = document.createElement("span");
        this.status.className = "vnccs-ps-tl-status";

        this.addKeyButton = this._button("◆", "Add/update key for the selected bone", () => {
            const trackName = this.getPreferredTrack();
            if (trackName) this.onRequestKey(trackName, this.state.currentFrame);
        }, "key");
        this.deleteKeyButton = this._button("⌫", "Delete selected keys", () => this.deleteSelectedKeys());

        this.interpolationSelect = document.createElement("select");
        this.interpolationSelect.className = "vnccs-ps-tl-select";
        this.interpolationSelect.title = "Outgoing interpolation of the selected keys";
        for (const preset of INTERPOLATION_PRESETS) {
            const option = document.createElement("option");
            option.value = preset.value;
            option.textContent = preset.label;
            this.interpolationSelect.appendChild(option);
        }
        this.interpolationSelect.addEventListener("change", () => {
            const value = this.interpolationSelect.value;
            this.state.defaultInterpolation = value;
            const selected = this._selectedKeyframes();
            let changed = 0;
            for (const { trackName, key } of selected) {
                if (setKeyframeInterpolation(this.state, trackName, key.frame, value)) changed++;
            }
            if (changed) {
                this.onStateChange({ type: "interpolation", count: changed, interpolation: value });
                this.renderTracks();
            } else {
                this.onStateChange({ type: "defaultInterpolation" });
            }
        });

        this.autoKeyButton = this._button("AUTO", "Auto-Key", () => {
            this.state.autoKey = !this.state.autoKey;
            this.updateToolbar();
            this.onStateChange({ type: "autoKey" });
        }, "toggle");
        this.loopButton = this._button("↻", "Loop playback", () => {
            this.state.loop = !this.state.loop;
            this.updateToolbar();
            this.onStateChange({ type: "loop" });
        }, "toggle");

        this.fpsInput = document.createElement("input");
        this.fpsInput.type = "number";
        this.fpsInput.className = "vnccs-ps-tl-number config";
        this.fpsInput.min = String(MIN_ANIMATION_FPS);
        this.fpsInput.max = String(MAX_ANIMATION_FPS);
        this.fpsInput.step = "0.001";
        this.fpsInput.title = "Animation frame rate";
        this.fpsInput.addEventListener("change", () => {
            retimeAnimationTiming(this.state, { fps: this.fpsInput.value });
            this._clearSelection();
            this.render();
            this.onFrameChange(this.state.currentFrame, { settings: true });
            this.onStateChange({ type: "timing" });
        });

        this.durationInput = document.createElement("input");
        this.durationInput.type = "number";
        this.durationInput.className = "vnccs-ps-tl-number config";
        this.durationInput.min = "0.1";
        this.durationInput.max = "600";
        this.durationInput.step = "0.001";
        this.durationInput.title = "Animation duration in seconds";
        this.durationInput.addEventListener("change", () => {
            retimeAnimationTiming(this.state, { duration: this.durationInput.value });
            this._clearSelection();
            this.render();
            this.onFrameChange(this.state.currentFrame, { settings: true });
            this.onStateChange({ type: "timing" });
        });

        const fpsLabel = document.createElement("label");
        fpsLabel.className = "vnccs-ps-tl-compact-label";
        fpsLabel.append("FPS ", this.fpsInput);
        const durationLabel = document.createElement("label");
        durationLabel.className = "vnccs-ps-tl-compact-label";
        durationLabel.append("Seconds ", this.durationInput);

        this.searchInput = document.createElement("input");
        this.searchInput.type = "search";
        this.searchInput.className = "vnccs-ps-tl-search";
        this.searchInput.placeholder = "Find bone…";
        this.searchInput.addEventListener("input", () => {
            this.search = this.searchInput.value.trim().toLowerCase();
            this.body.scrollTop = 0;
            this.renderTracks();
        });

        this.viewSelect = document.createElement("select");
        this.viewSelect.className = "vnccs-ps-tl-select vnccs-ps-tl-view-select";
        this.viewSelect.title = "Track view";
        for (const [value, label] of [
            ["animated", "Animated"],
            ["focus", "Focus"],
            ["selected", "Selected"],
            ["all", "All"],
        ]) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = label;
            this.viewSelect.appendChild(option);
        }
        this.viewSelect.value = this.viewMode;
        this.viewSelect.addEventListener("change", () => {
            this.viewMode = this.viewSelect.value;
            this.body.scrollTop = 0;
            this.renderTracks();
        });
        this.collapseButton = this._button("▾", "Collapse timeline", () => {
            this.collapsed = !this.collapsed;
            this.element.classList.toggle("collapsed", this.collapsed);
            this.collapseButton.textContent = this.collapsed ? "▴" : "▾";
            this.collapseButton.title = this.collapsed ? "Expand timeline" : "Collapse timeline";
            if (this.collapsed) this.stopPlayback();
            else this._renderVisibleTrackRows(true);
        }, "vnccs-ps-tl-collapse");

        this.toolbar.append(
            this.firstButton, this.previousButton, this.playButton, this.nextButton, this.lastButton,
            this.frameInput, this.status,
            this.addKeyButton, this.deleteKeyButton, this.interpolationSelect,
            this.autoKeyButton, this.loopButton,
            fpsLabel, durationLabel,
            this.viewSelect, this.searchInput,
        );

        this.resizer = document.createElement("div");
        this.resizer.className = "vnccs-ps-tl-resizer";
        this.resizer.title = "Drag to resize timeline";
        this.body = document.createElement("div");
        this.body.className = "vnccs-ps-tl-body";
        this.content = document.createElement("div");
        this.content.className = "vnccs-ps-tl-content";
        this.body.appendChild(this.content);
        this.element.append(this.resizer, this.toolbar, this.collapseButton, this.body);
        try {
            const savedHeight = Number(globalThis.localStorage?.getItem("vnccsPoseStudioTimelineHeightV3"));
            if (Number.isFinite(savedHeight) && savedHeight >= TIMELINE_MIN_PANEL_HEIGHT) {
                this.element.style.setProperty("--vnccs-tl-panel-height", `${savedHeight}px`);
            }
        } catch (_) {}
        this.resizer.addEventListener("pointerdown", event => this._beginResize(event));
        installTimelineShortcuts(this.element.ownerDocument);
        this.element.addEventListener("pointerenter", () => {
            this._pointerInside = true;
            hoveredTimeline = this;
        });
        this.element.addEventListener("pointerleave", () => {
            this._pointerInside = false;
            if (hoveredTimeline === this) hoveredTimeline = null;
        });
        this.body.addEventListener("pointerdown", event => this._beginMarqueeSelection(event), true);

        this.body.addEventListener("scroll", () => {
            if (this._virtualScrollRaf) return;
            this._virtualScrollRaf = requestAnimationFrame(() => {
                this._virtualScrollRaf = null;
                this._renderVisibleTrackRows();
            });
        }, { passive: true });
        if (globalThis.ResizeObserver) {
            this._timelineResizeObserver = new globalThis.ResizeObserver(() => this._renderVisibleTrackRows(true));
            this._timelineResizeObserver.observe(this.body);
        }

        this.element.addEventListener("keydown", event => {
            if ((event.key === "Delete" || event.key === "Backspace") && this.selectedKeys.size) {
                event.preventDefault();
                this.deleteSelectedKeys();
            } else if (event.key === " " && !event.target.matches("input,select,textarea")) {
                event.preventDefault();
                this.togglePlayback();
            } else if (event.key === "ArrowLeft" && !event.target.matches("input")) {
                event.preventDefault();
                this.setFrame(this.state.currentFrame - 1);
            } else if (event.key === "ArrowRight" && !event.target.matches("input")) {
                event.preventDefault();
                this.setFrame(this.state.currentFrame + 1);
            }
        });
    }

    _selectionId(trackName, keyId) {
        return `${trackName}\u0000${keyId}`;
    }

    _selectedKeyframes() {
        return resolveKeyframeSelections(this.state, Array.from(this.selectedKeys.values()));
    }

    _setSelection(selections, primary = null) {
        this.selectedKeys.clear();
        for (const { trackName, key } of resolveKeyframeSelections(this.state, selections)) {
            const reference = { trackName, keyId: key.id, frame: key.frame };
            this.selectedKeys.set(this._selectionId(trackName, key.id), reference);
        }
        const preferred = primary || Array.from(this.selectedKeys.values()).at(-1) || null;
        this.selectedKey = preferred ? { ...preferred } : null;
    }

    _clearSelection() {
        this.selectedKeys.clear();
        this.selectedKey = null;
    }

    _isSelected(trackName, keyId) {
        return this.selectedKeys.has(this._selectionId(trackName, keyId));
    }

    _selectedTrackNames() {
        return new Set(Array.from(this.selectedKeys.values(), selection => selection.trackName));
    }

    _selectKey(trackName, key, { additive = false, toggle = false } = {}) {
        const id = this._selectionId(trackName, key.id);
        if (!additive) this.selectedKeys.clear();
        if (toggle && this.selectedKeys.has(id)) {
            this.selectedKeys.delete(id);
        } else {
            this.selectedKeys.set(id, { trackName, keyId: key.id, frame: key.frame });
        }
        const last = Array.from(this.selectedKeys.values()).at(-1) || null;
        this.selectedKey = this.selectedKeys.has(id)
            ? { trackName, keyId: key.id, frame: key.frame }
            : (last ? { ...last } : null);
    }

    _refreshVisibleSelection() {
        const selectedTrackNames = this._selectedTrackNames();
        for (const rowElement of this.virtualTracks?.children || []) {
            const rowData = this._virtualRows[Number(rowElement.dataset.rowIndex)];
            rowElement.classList.toggle(
                "selected",
                (rowData?.trackNames || []).some(trackName => selectedTrackNames.has(trackName)),
            );
        }
        this._drawVisibleKeyLanes();
        this.updateToolbar();
    }

    _scheduleKeyLaneDraw(updateToolbar = false) {
        this._keyDrawToolbar ||= updateToolbar;
        if (this._keyDrawRaf) return;
        this._keyDrawRaf = requestAnimationFrame(() => {
            this._keyDrawRaf = null;
            this._drawVisibleKeyLanes();
            if (this._keyDrawToolbar) this.updateToolbar();
            this._keyDrawToolbar = false;
        });
    }

    _viewportPoint(clientX, clientY) {
        return timelineViewportToContentPoint({
            clientX,
            clientY,
            viewportRect: this.body.getBoundingClientRect(),
            offsetWidth: this.body.offsetWidth || this.body.clientWidth,
            offsetHeight: this.body.offsetHeight || this.body.clientHeight,
            clientLeft: this.body.clientLeft,
            clientTop: this.body.clientTop,
            scrollLeft: this.body.scrollLeft,
            scrollTop: this.body.scrollTop,
        });
    }

    _contentPosition(point) {
        return timelineContentPointToPosition(point, {
            laneLeft: this._laneContentLeft,
            laneWidth: this._laneWidth,
            rulerHeight: TIMELINE_RULER_HEIGHT,
            rowHeight: TIMELINE_ROW_HEIGHT,
            rowCount: this._virtualRows.length,
            frameCount: this.state.frameCount,
        });
    }

    _beginMarqueeSelection(event) {
        if (event.button !== 0 || this._marquee) return;
        const lane = event.target.closest(".vnccs-ps-tl-lane:not(.ruler)");
        if (!lane || !this.virtualTracks?.contains(lane)) return;
        const row = this._virtualRows[Number(lane.dataset.rowIndex)];
        if (!row || this._keyAtPointer(event, lane, row)) return;
        event.preventDefault();
        event.stopPropagation();
        this.element.focus({ preventScroll: true });

        const doc = this.element.ownerDocument;
        const layer = doc.createElement("div");
        layer.className = "vnccs-ps-tl-selection-layer";
        const box = doc.createElement("div");
        box.className = "vnccs-ps-tl-selection-box";
        layer.appendChild(box);
        doc.body.appendChild(layer);
        const additive = event.ctrlKey || event.metaKey || event.shiftKey;
        // Cancellation must restore the selection that existed before the
        // gesture. A non-additive drag still starts its live result from an
        // empty base, but Escape/pointercancel must not erase prior keys.
        const previousSelection = new Map(this.selectedKeys);
        const baseSelection = additive ? new Map(previousSelection) : new Map();
        const anchorPoint = this._viewportPoint(event.clientX, event.clientY);
        this._marquee = {
            pointerId: event.pointerId,
            lane,
            row,
            additive,
            previousSelection,
            baseSelection,
            anchorPoint,
            anchorPosition: this._contentPosition(anchorPoint),
            startClientX: event.clientX,
            startClientY: event.clientY,
            clientX: event.clientX,
            clientY: event.clientY,
            dragged: false,
            layer,
            box,
        };
        this.body.setPointerCapture?.(event.pointerId);
        const move = moveEvent => {
            if (!this._marquee || moveEvent.pointerId !== this._marquee.pointerId) return;
            this._marquee.clientX = moveEvent.clientX;
            this._marquee.clientY = moveEvent.clientY;
            if (Math.hypot(
                moveEvent.clientX - this._marquee.startClientX,
                moveEvent.clientY - this._marquee.startClientY,
            ) >= 4) this._marquee.dragged = true;
        };
        const end = endEvent => this._finishMarqueeSelection(endEvent.type === "pointercancel", endEvent);
        const escape = keyEvent => {
            if (keyEvent.key !== "Escape") return;
            keyEvent.preventDefault();
            this._finishMarqueeSelection(true, keyEvent);
        };
        this._marquee.move = move;
        this._marquee.end = end;
        this._marquee.escape = escape;
        this.body.addEventListener("pointermove", move);
        this.body.addEventListener("pointerup", end);
        this.body.addEventListener("pointercancel", end);
        doc.defaultView?.addEventListener("keydown", escape, true);
        this._marqueeRaf = requestAnimationFrame(() => this._updateMarqueeSelection());
    }

    _updateMarqueeSelection() {
        const drag = this._marquee;
        if (!drag) return;
        const rect = this.body.getBoundingClientRect();
        const scale = this._viewportPoint(drag.clientX, drag.clientY);
        const minimumDimension = Math.max(1, Math.min(rect.width, rect.height));
        // Keep opposite edge zones disjoint even under an extreme Comfy scale.
        const edge = Math.max(1, Math.min(
            42,
            Math.max(4, minimumDimension * 0.15),
            minimumDimension / 2 - 0.5,
        ));
        const edgeVelocity = (position, low, high) => {
            if (position < low + edge) return -Math.pow(clamp((low + edge - position) / edge, 0, 1), 2) * 22;
            if (position > high - edge) return Math.pow(clamp((position - (high - edge)) / edge, 0, 1), 2) * 22;
            return 0;
        };
        if (drag.dragged) {
            const dx = edgeVelocity(drag.clientX, rect.left, rect.right) / scale.scaleX;
            const dy = edgeVelocity(drag.clientY, rect.top, rect.bottom) / scale.scaleY;
            if (dx) this.body.scrollLeft += dx;
            if (dy) this.body.scrollTop += dy;
        }

        const currentPoint = this._viewportPoint(drag.clientX, drag.clientY);
        const currentPosition = this._contentPosition(currentPoint);
        if (drag.dragged) {
            const matches = findKeyframesInTimelineRows(this.state, this._virtualRows, {
                startRow: drag.anchorPosition.row,
                endRow: currentPosition.row,
                startFrame: drag.anchorPosition.frame,
                endFrame: currentPosition.frame,
            });
            this.selectedKeys = new Map(drag.baseSelection);
            for (const match of matches) {
                this.selectedKeys.set(this._selectionId(match.trackName, match.keyId), match);
            }
            const last = Array.from(this.selectedKeys.values()).at(-1) || null;
            this.selectedKey = last ? { ...last } : null;
            this._scheduleKeyLaneDraw(true);

            const bodyPointToClient = point => ({
                x: rect.left + this.body.clientLeft * scale.scaleX + (point.x - this.body.scrollLeft) * scale.scaleX,
                y: rect.top + this.body.clientTop * scale.scaleY + (point.y - this.body.scrollTop) * scale.scaleY,
            });
            const anchorClient = bodyPointToClient(drag.anchorPoint);
            const currentClient = bodyPointToClient(currentPoint);
            const left = Math.min(anchorClient.x, currentClient.x);
            const top = Math.min(anchorClient.y, currentClient.y);
            const laneViewportLeft = Math.min(rect.right, rect.left + this._laneContentLeft * scale.scaleX);
            const laneViewportTop = Math.min(rect.bottom, rect.top + TIMELINE_RULER_HEIGHT * scale.scaleY);
            Object.assign(drag.layer.style, {
                clipPath: `inset(${Math.max(0, laneViewportTop)}px ${Math.max(0, globalThis.innerWidth - rect.right)}px ${Math.max(0, globalThis.innerHeight - rect.bottom)}px ${Math.max(0, laneViewportLeft)}px)`,
            });
            Object.assign(drag.box.style, {
                display: "block",
                left: `${left}px`,
                top: `${top}px`,
                width: `${Math.abs(currentClient.x - anchorClient.x)}px`,
                height: `${Math.abs(currentClient.y - anchorClient.y)}px`,
            });
        }
        this._marqueeRaf = requestAnimationFrame(() => this._updateMarqueeSelection());
    }

    _finishMarqueeSelection(cancelled, event = {}) {
        const drag = this._marquee;
        if (!drag) return;
        this._marquee = null;
        if (this._marqueeRaf) cancelAnimationFrame(this._marqueeRaf);
        this._marqueeRaf = null;
        this.body.removeEventListener("pointermove", drag.move);
        this.body.removeEventListener("pointerup", drag.end);
        this.body.removeEventListener("pointercancel", drag.end);
        this.element.ownerDocument.defaultView?.removeEventListener("keydown", drag.escape, true);
        if (this.body.hasPointerCapture?.(drag.pointerId)) this.body.releasePointerCapture(drag.pointerId);
        drag.layer.remove();
        if (cancelled) {
            this.selectedKeys = new Map(drag.previousSelection);
            const last = Array.from(this.selectedKeys.values()).at(-1) || null;
            this.selectedKey = last ? { ...last } : null;
        } else if (!drag.dragged) {
            if (!drag.additive) this._clearSelection();
            const point = this._viewportPoint(event.clientX ?? drag.clientX, event.clientY ?? drag.clientY);
            this.setFrame(Math.round(this._contentPosition(point).frame), { scrub: true });
        }
        if (this.viewMode === "selected") this.renderTracks();
        else this._refreshVisibleSelection();
    }

    _beginResize(event) {
        if (event.button !== 0) return;
        this._activeResizeCancel?.();
        event.preventDefault();
        const startY = event.clientY;
        const startRect = this.element.getBoundingClientRect();
        const scale = startRect.height / Math.max(1, this.element.offsetHeight);
        const startHeight = this.element.offsetHeight;
        this.element.classList.add("resizing");
        this.resizer.setPointerCapture?.(event.pointerId);
        const move = moveEvent => {
            const maximum = Math.max(
                TIMELINE_MIN_PANEL_HEIGHT,
                Math.min(TIMELINE_MAX_PANEL_HEIGHT, (this.element.parentElement?.clientHeight || 800) * 0.6),
            );
            const height = clamp(
                startHeight + (startY - moveEvent.clientY) / Math.max(1e-6, scale),
                TIMELINE_MIN_PANEL_HEIGHT,
                maximum,
            );
            this.element.style.setProperty("--vnccs-tl-panel-height", `${height}px`);
            this._renderVisibleTrackRows(true);
        };
        const end = endEvent => {
            this.resizer.removeEventListener("pointermove", move);
            this.resizer.removeEventListener("pointerup", end);
            this.resizer.removeEventListener("pointercancel", end);
            if (this.resizer.hasPointerCapture?.(endEvent.pointerId)) this.resizer.releasePointerCapture(endEvent.pointerId);
            if (this._activeResizeCancel === cancel) this._activeResizeCancel = null;
            this.element.classList.remove("resizing");
            try {
                globalThis.localStorage?.setItem("vnccsPoseStudioTimelineHeightV3", String(this.element.offsetHeight));
            } catch (_) {}
        };
        const cancel = () => end({ type: "pointercancel", pointerId: event.pointerId });
        this._activeResizeCancel = cancel;
        this.resizer.addEventListener("pointermove", move);
        this.resizer.addEventListener("pointerup", end);
        this.resizer.addEventListener("pointercancel", end);
    }

    copySelectedKeys() {
        const clipboard = copyKeyframeSelection(this.state, Array.from(this.selectedKeys.values()));
        if (!clipboard) return false;
        timelineKeyClipboard = clipboard;
        globalThis.navigator?.clipboard?.writeText(JSON.stringify(clipboard)).catch?.(() => {});
        return true;
    }

    pasteCopiedKeys() {
        if (!timelineKeyClipboard) return false;
        const pasted = pasteKeyframeSelection(this.state, timelineKeyClipboard, this.state.currentFrame);
        if (!pasted.length) return false;
        this._setSelection(pasted, pasted[0]);
        this.onStateChange({ type: "pasteKeys", count: pasted.length, frame: this.state.currentFrame });
        this.renderTracks();
        return true;
    }

    setState(state) {
        this.stopPlayback();
        this.state = state;
        this._clearSelection();
        this.render();
    }

    setBoneNames(names) {
        const unique = Array.from(new Set((names || []).filter(Boolean)));
        if (unique.join("\u0000") === this.boneNames.join("\u0000")) return;
        this.boneNames = unique;
        this.renderTracks();
    }

    setActiveTrack(trackName, { reveal = true, notify = false } = {}) {
        const next = trackName || null;
        const changed = next !== this.activeTrack;
        this.activeTrack = next;
        if (next && reveal) {
            for (const id of timelineExpansionIdsForTrack(next)) this.expandedGroups.add(id);
        }
        if (notify && next) this.onTrackSelect(next);
        if (changed || reveal) {
            this.renderTracks();
            if (next && reveal) this._scrollTrackIntoView(next);
        }
    }

    notifyActiveTrack(trackName, options = {}) {
        this.setActiveTrack(trackName, { reveal: options.reveal !== false, notify: false });
    }

    setPreferredTrack(trackName, options = {}) {
        this.notifyActiveTrack(trackName, options);
    }

    _scrollTrackIntoView(trackName) {
        const index = this._virtualRows.findIndex(row => row.type === "track" && row.trackName === trackName);
        if (index < 0 || !this.body) return false;
        const rowTop = TIMELINE_RULER_HEIGHT + index * TIMELINE_ROW_HEIGHT;
        const rowBottom = rowTop + TIMELINE_ROW_HEIGHT;
        const viewportTop = this.body.scrollTop;
        const viewportBottom = viewportTop + Math.max(TIMELINE_ROW_HEIGHT, this.body.clientHeight);
        if (rowTop < viewportTop + TIMELINE_RULER_HEIGHT) {
            this.body.scrollTop = Math.max(0, rowTop - TIMELINE_RULER_HEIGHT);
        } else if (rowBottom > viewportBottom) {
            this.body.scrollTop = Math.max(0, rowBottom - Math.max(TIMELINE_ROW_HEIGHT, this.body.clientHeight));
        }
        this._renderVisibleTrackRows(true);
        return true;
    }

    setVisible(visible) {
        this.element.classList.toggle("visible", !!visible);
        if (!visible) {
            this.stopPlayback();
            this._finishMarqueeSelection(true);
            this.onTrackHover(null);
        }
    }

    destroy() {
        this.stopPlayback();
        this._finishMarqueeSelection(true);
        this._activeResizeCancel?.();
        this._activeKeyDragCancel?.();
        if (this._virtualScrollRaf) cancelAnimationFrame(this._virtualScrollRaf);
        if (this._keyDrawRaf) cancelAnimationFrame(this._keyDrawRaf);
        this._timelineResizeObserver?.disconnect?.();
        this.onTrackHover(null);
        if (hoveredTimeline === this) hoveredTimeline = null;
        this.element?.remove();
    }

    setFrame(frameValue, options = {}) {
        const frame = clamp(Math.round(finiteNumber(frameValue)), 0, this.state.frameCount - 1);
        if (frame === this.state.currentFrame && !options.force) return;
        this.state.currentFrame = frame;
        this.updatePlayheads();
        this.onFrameChange(frame, options);
    }

    togglePlayback() {
        if (this._playing) this.stopPlayback();
        else this.startPlayback();
    }

    startPlayback() {
        if (this._playing) return;
        if (finiteNumber(this.state?.schemaVersion, 1) < POSE_ANIMATION_SCHEMA_VERSION) {
            retimeAnimationTiming(this.state, { fps: DEFAULT_ANIMATION_FPS });
            this.render();
            this.onStateChange({ type: "timingMigration" });
        }
        this._playing = true;
        const fps = getAnimationFPS(this.state);
        const startFrame = this.state.currentFrame >= this.state.frameCount - 1 ? 0 : this.state.currentFrame;
        const startedAt = performance.now() - (startFrame / fps) * 1000;
        const tick = now => {
            if (!this._playing) return;
            const absoluteFrame = playbackFrameForElapsed(now - startedAt, fps);
            let nextFrame = absoluteFrame;
            if (this.state.loop) nextFrame %= this.state.frameCount;
            else if (nextFrame >= this.state.frameCount) {
                this.setFrame(this.state.frameCount - 1, { playback: true });
                this.stopPlayback();
                return;
            }
            this.setFrame(nextFrame, { playback: true });
            this._raf = requestAnimationFrame(tick);
        };
        this.updateToolbar();
        this._raf = requestAnimationFrame(tick);
    }

    stopPlayback() {
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = null;
        if (!this._playing) return;
        this._playing = false;
        this.updateToolbar();
        this.onStateChange({ type: "playbackStop", transient: true });
    }

    deleteSelectedKey() {
        this.deleteSelectedKeys();
    }

    deleteSelectedKeys() {
        const selected = this._selectedKeyframes();
        if (!selected.length) return;
        let deleted = 0;
        for (const { trackName, key } of selected) {
            if (deleteTrackKeyframe(this.state, trackName, key.frame)) deleted++;
        }
        if (!deleted) return;
        this._clearSelection();
        this.onStateChange({ type: "deleteKeys", count: deleted });
        this.renderTracks();
    }

    render() {
        this.updateToolbar();
        this.renderTracks();
    }

    updateToolbar() {
        if (!this.state) return;
        const fps = getAnimationFPS(this.state);
        const frameValue = String(this.state.currentFrame);
        if (this.frameInput.value !== frameValue) this.frameInput.value = frameValue;
        const selectionStatus = this.selectedKeys.size ? ` · ${this.selectedKeys.size} key${this.selectedKeys.size === 1 ? "" : "s"}` : "";
        const status = `Frame ${this.state.currentFrame} · ${(this.state.currentFrame / fps).toFixed(2)}s${selectionStatus}`;
        if (this.status.textContent !== status) this.status.textContent = status;

        const timingSignature = `${this.state.frameCount}|${fps}|${this.state.duration}`;
        if (this._toolbarTimingSignature !== timingSignature) {
            this._toolbarTimingSignature = timingSignature;
            this.frameInput.max = String(this.state.frameCount - 1);
            this.fpsInput.value = String(Number(fps.toFixed(3)));
            this.durationInput.min = String(MIN_FRAME_COUNT / fps);
            this.durationInput.max = String(MAX_FRAME_COUNT / fps);
            this.durationInput.value = String(Number(this.state.duration.toFixed(3)));
        }

        const flagsSignature = `${this._playing}|${!!this.state.autoKey}|${!!this.state.loop}`;
        if (this._toolbarFlagsSignature !== flagsSignature) {
            this._toolbarFlagsSignature = flagsSignature;
            this.playButton.textContent = this._playing ? "❚❚" : "▶";
            this.playButton.classList.toggle("active", this._playing);
            this.autoKeyButton.classList.toggle("active", !!this.state.autoKey);
            this.loopButton.classList.toggle("active", !!this.state.loop);
        }
        const selected = this.selectedKey
            ? this.state.tracks?.[this.selectedKey.trackName]?.keys?.find(key => (
                this.selectedKey.keyId ? key.id === this.selectedKey.keyId : key.frame === this.selectedKey.frame
            ))
            : null;
        const interpolation = selected?.interpolation || this.state.defaultInterpolation;
        if (this.interpolationSelect.value !== interpolation) this.interpolationSelect.value = interpolation;
    }

    _allTrackNames() {
        const names = [MODEL_ROTATION_TRACK, ...this.boneNames];
        for (const name of Object.keys(this.state.tracks || {})) {
            if (!names.includes(name)) names.push(name);
        }
        return names;
    }

    _timelineRows() {
        const preferred = this.getPreferredTrack?.() || this.activeTrack;
        if (preferred && preferred !== this.activeTrack) {
            this.activeTrack = preferred;
            for (const id of timelineExpansionIdsForTrack(preferred)) this.expandedGroups.add(id);
        }
        return buildTimelineRows({
            state: this.state,
            trackNames: this._allTrackNames(),
            expandedGroups: this.expandedGroups,
            viewMode: this.viewMode,
            activeTrack: this.activeTrack,
            focusTrackNames: this.viewMode === "focus" ? this.getFocusTracks(this.activeTrack) : [],
            selectedTrackNames: Array.from(new Set(Array.from(this.selectedKeys.values()).map(item => item.trackName))),
            search: this.search,
        });
    }

    _frameFromPointer(event, lane) {
        const rect = lane.getBoundingClientRect();
        const ratio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        return Math.round(ratio * (this.state.frameCount - 1));
    }

    _keysForRow(row) {
        if (!row) return [];
        const cached = this._rowKeyCache.get(row);
        if (cached) return cached;
        let result;
        if (row.type === "track") {
            result = (this.state.tracks?.[row.trackName]?.keys || []).map(key => ({
                frame: key.frame,
                members: [{ trackName: row.trackName, key }],
            }));
        } else {
            const byFrame = new Map();
            for (const trackName of row.trackNames || []) {
                for (const key of this.state.tracks?.[trackName]?.keys || []) {
                    if (!byFrame.has(key.frame)) byFrame.set(key.frame, []);
                    byFrame.get(key.frame).push({ trackName, key });
                }
            }
            result = Array.from(byFrame, ([frame, members]) => ({ frame, members })).sort((a, b) => a.frame - b.frame);
        }
        this._rowKeyCache.set(row, result);
        return result;
    }

    _keyAtPointer(event, lane, row) {
        if (!row) return null;
        const rect = lane.getBoundingClientRect();
        return findNearestKeyframeAtPosition(
            this._keysForRow(row),
            event.clientX - rect.left,
            rect.width,
            this.state.frameCount,
        );
    }

    _drawKeyLane(canvas, row) {
        const context = canvas.getContext("2d");
        if (!context) return;
        const width = canvas.width;
        const height = canvas.height;
        const lastFrame = Math.max(1, this.state.frameCount - 1);
        context.clearRect(0, 0, width, height);
        const positions = new Map();
        for (const aggregate of this._keysForRow(row)) {
            for (const { trackName, key } of aggregate.members) {
                const previewFrame = this._dragPreview?.frames?.get(this._selectionId(trackName, key.id));
                const frame = previewFrame === undefined ? key.frame : previewFrame + this._dragPreview.delta;
                const selected = this._isSelected(trackName, key.id);
                positions.set(frame, (positions.get(frame) || false) || selected);
            }
        }
        const regular = [];
        const selected = [];
        for (const [frame, isSelected] of positions) {
            (isSelected ? selected : regular).push((frame / lastFrame) * width);
        }
        const drawDiamonds = (positions, fill, stroke, shadow = false) => {
            if (!positions.length) return;
            context.beginPath();
            for (const x of positions) {
                context.moveTo(x, height / 2 - 6);
                context.lineTo(x + 6, height / 2);
                context.lineTo(x, height / 2 + 6);
                context.lineTo(x - 6, height / 2);
                context.closePath();
            }
            context.fillStyle = fill;
            context.strokeStyle = stroke;
            context.lineWidth = 1;
            context.shadowColor = shadow ? "rgba(255,73,107,.55)" : "transparent";
            context.shadowBlur = shadow ? 4 : 0;
            context.fill();
            context.stroke();
        };
        drawDiamonds(regular, "#c5b7ef", "rgba(255,255,255,.42)");
        drawDiamonds(selected, "#ff8fa3", "#ffffff", true);
    }

    _drawVisibleKeyLanes() {
        for (const { canvas, row } of this._visibleKeyLanes) this._drawKeyLane(canvas, row);
    }

    _bindScrub(lane) {
        lane.addEventListener("pointerdown", event => {
            if (event.button !== 0) return;
            const scrub = pointerEvent => this.setFrame(this._frameFromPointer(pointerEvent, lane), { scrub: true });
            lane.setPointerCapture?.(event.pointerId);
            scrub(event);
            const move = moveEvent => scrub(moveEvent);
            const end = endEvent => {
                lane.removeEventListener("pointermove", move);
                lane.removeEventListener("pointerup", end);
                lane.removeEventListener("pointercancel", end);
                if (lane.hasPointerCapture?.(endEvent.pointerId)) lane.releasePointerCapture(endEvent.pointerId);
            };
            lane.addEventListener("pointermove", move);
            lane.addEventListener("pointerup", end);
            lane.addEventListener("pointercancel", end);
        });
    }

    _makeLane(row = null, ruler = false, rowIndex = -1) {
        const lane = document.createElement("div");
        lane.className = `vnccs-ps-tl-lane${ruler ? " ruler" : ""}`;
        const playhead = document.createElement("div");
        playhead.className = "vnccs-ps-tl-playhead";
        playhead.style.left = `${(this.state.currentFrame / (this.state.frameCount - 1)) * 100}%`;
        if (ruler) this._rulerPlayhead = playhead;
        else this._visiblePlayheads.push(playhead);
        lane.appendChild(playhead);

        if (ruler) {
            this._bindScrub(lane);
            const step = niceTickStep(this.state.frameCount);
            for (let frame = 0; frame < this.state.frameCount; frame += step) {
                const tick = document.createElement("span");
                tick.className = "vnccs-ps-tl-tick";
                tick.style.left = `${(frame / (this.state.frameCount - 1)) * 100}%`;
                tick.textContent = String(frame);
                lane.appendChild(tick);
            }
            if ((this.state.frameCount - 1) % step !== 0) {
                const tick = document.createElement("span");
                tick.className = "vnccs-ps-tl-tick end";
                tick.style.left = "100%";
                tick.textContent = String(this.state.frameCount - 1);
                lane.appendChild(tick);
            }
            return lane;
        }

        lane.dataset.rowIndex = String(rowIndex);
        if (row?.trackName) lane.dataset.track = row.trackName;
        const canvas = document.createElement("canvas");
        canvas.className = "vnccs-ps-tl-keys-canvas";
        canvas.width = Math.max(1, Math.round(this._laneWidth));
        canvas.height = TIMELINE_ROW_HEIGHT;
        lane.appendChild(canvas);
        this._visibleKeyLanes.push({ canvas, row });
        this._drawKeyLane(canvas, row);

        lane.addEventListener("click", event => {
            const aggregate = this._keyAtPointer(event, lane, row);
            if (!aggregate) return;
            event.stopPropagation();
            if (this._suppressKeyClick) {
                this._suppressKeyClick = false;
                return;
            }
            const additive = event.ctrlKey || event.metaKey || event.shiftKey;
            const allSelected = aggregate.members.every(({ trackName, key }) => this._isSelected(trackName, key.id));
            if (!additive) this._clearSelection();
            for (const { trackName, key } of aggregate.members) {
                this._selectKey(trackName, key, { additive: true, toggle: additive && allSelected });
            }
            this.setFrame(aggregate.frame);
            this._refreshVisibleSelection();
            if (this.viewMode === "selected") this.renderTracks();
        });
        lane.addEventListener("contextmenu", event => {
            const aggregate = this._keyAtPointer(event, lane, row);
            if (!aggregate) return;
            event.preventDefault();
            event.stopPropagation();
            if (aggregate.members.every(({ trackName, key }) => this._isSelected(trackName, key.id))) {
                this.deleteSelectedKeys();
            } else {
                let deleted = 0;
                for (const { trackName, key } of aggregate.members) {
                    if (deleteTrackKeyframe(this.state, trackName, key.frame)) deleted++;
                }
                if (!deleted) return;
                this._clearSelection();
                this.onStateChange({ type: "deleteKeys", count: deleted, frame: aggregate.frame });
                this.renderTracks();
            }
        });
        lane.addEventListener("pointerdown", event => {
            const aggregate = this._keyAtPointer(event, lane, row);
            if (!aggregate || event.button !== 0) return;
            this._activeKeyDragCancel?.();
            event.stopPropagation();
            this.element.focus({ preventScroll: true });
            const originalFrame = aggregate.frame;
            if (event.ctrlKey || event.metaKey || event.shiftKey) return;
            const anySelected = aggregate.members.some(({ trackName, key }) => this._isSelected(trackName, key.id));
            if (!anySelected) {
                this._clearSelection();
            }
            for (const { trackName, key } of aggregate.members) {
                if (!this._isSelected(trackName, key.id)) this._selectKey(trackName, key, { additive: true });
            }
            this._refreshVisibleSelection();
            const originalSelections = this._selectedKeyframes().map(item => ({
                trackName: item.trackName,
                keyId: item.key.id,
                frame: item.key.frame,
            }));
            const originalFrames = new Map(originalSelections.map(item => [this._selectionId(item.trackName, item.keyId), item.frame]));
            const minimumFrame = Math.min(...originalSelections.map(item => item.frame));
            const maximumFrame = Math.max(...originalSelections.map(item => item.frame));
            let deltaFrame = 0;
            let dragged = false;
            lane.setPointerCapture?.(event.pointerId);
            const move = moveEvent => {
                const destinationFrame = this._frameFromPointer(moveEvent, lane);
                deltaFrame = clamp(destinationFrame - originalFrame, -minimumFrame, this.state.frameCount - 1 - maximumFrame);
                if (deltaFrame) dragged = true;
                this._dragPreview = { frames: originalFrames, delta: deltaFrame };
                this._scheduleKeyLaneDraw();
                lane.title = `Move ${originalSelections.length} key${originalSelections.length === 1 ? "" : "s"} by ${deltaFrame} frame${Math.abs(deltaFrame) === 1 ? "" : "s"}`;
            };
            const end = endEvent => {
                lane.removeEventListener("pointermove", move);
                lane.removeEventListener("pointerup", end);
                lane.removeEventListener("pointercancel", end);
                if (lane.hasPointerCapture?.(endEvent.pointerId)) lane.releasePointerCapture(endEvent.pointerId);
                if (this._activeKeyDragCancel === cancel) this._activeKeyDragCancel = null;
                this._dragPreview = null;
                const cancelled = endEvent.type === "pointercancel";
                if (!cancelled && dragged && deltaFrame) {
                    const result = moveKeyframeSelection(this.state, originalSelections, deltaFrame);
                    const primaryId = aggregate.members[0]?.key.id;
                    this._setSelection(result.selections, result.selections.find(item => item.keyId === primaryId));
                    const movedPrimary = result.selections.find(item => item.keyId === primaryId);
                    if (movedPrimary) this.setFrame(movedPrimary.frame);
                    this.onStateChange({ type: "moveKeys", count: result.selections.length, delta: result.delta });
                    this._suppressKeyClick = true;
                    setTimeout(() => { this._suppressKeyClick = false; }, 0);
                } else if (!cancelled && dragged) {
                    this._suppressKeyClick = true;
                    setTimeout(() => { this._suppressKeyClick = false; }, 0);
                }
                this.renderTracks();
                this.updateToolbar();
            };
            const cancel = () => end({ type: "pointercancel", pointerId: event.pointerId });
            this._activeKeyDragCancel = cancel;
            lane.addEventListener("pointermove", move);
            lane.addEventListener("pointerup", end);
            lane.addEventListener("pointercancel", end);
        });
        lane.addEventListener("pointermove", event => {
            if (this._dragPreview) return;
            const aggregate = this._keyAtPointer(event, lane, row);
            const interpolation = aggregate?.members[0]?.key?.interpolation;
            lane.title = aggregate
                ? `Frame ${aggregate.frame} · ${aggregate.members.length} key${aggregate.members.length === 1 ? "" : "s"} · ${INTERPOLATION_PRESETS.find(item => item.value === interpolation)?.label || interpolation}`
                : "";
        });
        lane.addEventListener("dblclick", event => {
            if (this._keyAtPointer(event, lane, row) || row.type !== "track") return;
            const frame = this._frameFromPointer(event, lane);
            this.setFrame(frame);
            this.onRequestKey(row.trackName, frame);
        });
        return lane;
    }

    _makeTrackRow(rowData, index, selectedTrackNames = new Set()) {
        const row = document.createElement("div");
        row.className = `vnccs-ps-tl-row virtual${rowData.type === "group" ? " group" : ""}${rowData.active ? " focused" : ""}`;
        if ((rowData.trackNames || []).some(trackName => selectedTrackNames.has(trackName))) row.classList.add("selected");
        row.dataset.rowIndex = String(index);
        row.dataset.depth = String(rowData.depth || 0);
        if (rowData.trackName) row.dataset.track = rowData.trackName;
        row.style.top = `${index * TIMELINE_ROW_HEIGHT}px`;
        const label = document.createElement("div");
        label.className = "vnccs-ps-tl-track-label";
        label.dataset.depth = String(rowData.depth || 0);
        if (rowData.keyCount) label.classList.add("animated");

        if (rowData.type === "group") {
            const toggle = document.createElement("button");
            toggle.type = "button";
            toggle.className = "vnccs-ps-tl-track-toggle";
            toggle.textContent = rowData.expanded ? "▾" : "▸";
            toggle.disabled = !!rowData.forcedExpanded;
            toggle.title = rowData.forcedExpanded
                ? "Expanded by the current search or track view"
                : (rowData.expanded ? `Collapse ${rowData.label}` : `Expand ${rowData.label}`);
            const toggleGroup = event => {
                event.stopPropagation();
                if (rowData.forcedExpanded) return;
                if (this.expandedGroups.has(rowData.groupId)) this.expandedGroups.delete(rowData.groupId);
                else this.expandedGroups.add(rowData.groupId);
                this.renderTracks();
            };
            toggle.addEventListener("click", toggleGroup);
            label.addEventListener("dblclick", toggleGroup);
            label.appendChild(toggle);
        } else {
            const indicator = document.createElement("span");
            indicator.className = "vnccs-ps-tl-track-dot";
            label.appendChild(indicator);
        }
        const text = document.createElement("span");
        text.className = "vnccs-ps-tl-track-name";
        text.textContent = rowData.label;
        text.title = rowData.rawName || `${rowData.label} · ${rowData.trackNames.length} track${rowData.trackNames.length === 1 ? "" : "s"}`;
        label.appendChild(text);
        const count = document.createElement("span");
        count.className = "vnccs-ps-tl-track-count";
        count.textContent = String(rowData.keyCount || 0);
        count.title = `${rowData.keyCount || 0} keyframes`;
        label.appendChild(count);
        if (rowData.type === "track") {
            const add = this._button("◇", `Add/update key at frame ${this.state.currentFrame}`, event => {
                event.stopPropagation();
                this.onRequestKey(rowData.trackName, this.state.currentFrame);
            }, "row-key");
            label.appendChild(add);
            label.addEventListener("click", () => this.setActiveTrack(rowData.trackName, { reveal: false, notify: true }));
            row.addEventListener("pointerenter", () => this.onTrackHover(rowData.trackName));
            row.addEventListener("pointerleave", () => this.onTrackHover(null));
        }
        row.append(label, this._makeLane(rowData, false, index));
        return row;
    }

    _renderVisibleTrackRows(force = false) {
        if (!this.virtualTracks || !this.state) return;
        const range = computeVirtualTrackRange({
            count: this._virtualRows.length,
            scrollTop: this.body.scrollTop,
            viewportHeight: this.body.clientHeight || 298,
            rowHeight: TIMELINE_ROW_HEIGHT,
            rulerHeight: TIMELINE_RULER_HEIGHT,
        });
        if (
            !force
            && range.start === this._virtualRange.start
            && range.end === this._virtualRange.end
        ) return;
        this._virtualRange = range;
        this.onTrackHover(null);
        this.virtualTracks.replaceChildren();
        this._visiblePlayheads = [];
        this._visibleKeyLanes = [];
        const fragment = document.createDocumentFragment();
        const selectedTrackNames = this._selectedTrackNames();
        for (let index = range.start; index < range.end; index++) {
            fragment.appendChild(this._makeTrackRow(this._virtualRows[index], index, selectedTrackNames));
        }
        this.virtualTracks.appendChild(fragment);
    }

    renderTracks() {
        if (!this.content || !this.state) return;
        this.onTrackHover(null);
        this.content.innerHTML = "";
        this._rulerPlayhead = null;
        this._visiblePlayheads = [];
        this._visibleKeyLanes = [];
        const width = Math.max(TIMELINE_MIN_LANE_WIDTH, this.state.frameCount * TIMELINE_FRAME_WIDTH);
        this._laneWidth = width;
        this.content.style.setProperty("--vnccs-tl-lane-width", `${width}px`);

        const rulerRow = document.createElement("div");
        rulerRow.className = "vnccs-ps-tl-row ruler";
        const rulerLabel = document.createElement("div");
        rulerLabel.className = "vnccs-ps-tl-track-label ruler";
        rulerLabel.textContent = "Dope Sheet · Frames";
        const rulerLane = this._makeLane(null, true);
        rulerRow.append(rulerLabel, rulerLane);
        this.content.appendChild(rulerRow);
        this._laneContentLeft = rulerLane.offsetLeft || TIMELINE_LABEL_WIDTH;

        const rows = this._timelineRows();
        this._rowKeyCache = new WeakMap();
        this._virtualRows = rows;
        this._virtualNames = rows.map(row => row.trackName || row.id);
        this._virtualRange = { start: -1, end: -1 };
        this._virtualFrameRange = { start: -1, end: -1 };
        this.virtualTracks = document.createElement("div");
        this.virtualTracks.className = "vnccs-ps-tl-virtual-tracks";
        this.virtualTracks.style.height = `${rows.length * TIMELINE_ROW_HEIGHT}px`;
        this.content.appendChild(this.virtualTracks);
        this._renderVisibleTrackRows(true);

        if (!rows.length) {
            const empty = document.createElement("div");
            empty.className = "vnccs-ps-tl-empty";
            empty.textContent = "No matching bone tracks";
            this.content.appendChild(empty);
        }
        this.updatePlayheads();
    }

    updatePlayheads() {
        if (!this.state) return;
        const left = `${(this.state.currentFrame / (this.state.frameCount - 1)) * 100}%`;
        if (this._rulerPlayhead) this._rulerPlayhead.style.left = left;
        for (const playhead of this._visiblePlayheads) playhead.style.left = left;
        this.updateToolbar();
    }
}
