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
export const MIN_FRAME_COUNT = 2;
export const MAX_FRAME_COUNT = 600;
export const MIN_ANIMATION_FPS = 1;
export const MAX_ANIMATION_FPS = 120;
export const DEFAULT_ANIMATION_FPS = 12;

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

    let rightIndex = 1;
    while (rightIndex < keys.length && keys[rightIndex].frame < frame) rightIndex++;
    const left = keys[rightIndex - 1];
    const right = keys[rightIndex];
    const span = Math.max(1, right.frame - left.frame);
    const t = applyInterpolation((frame - left.frame) / span, left.interpolation);
    return slerpQuaternion(left.value, right.value, t);
}

export function evaluateAnimationFrame(state, frameValue) {
    const normalizedFrame = clamp(Math.round(finiteNumber(frameValue)), 0, Math.max(0, state.frameCount - 1));
    const pose = normalizePose(state.basePose || {});
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

    const frameCount = Math.min(MAX_FRAME_COUNT, frames.length);
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

    const boneNames = new Set();
    for (const pose of frames.slice(0, frameCount)) {
        for (const boneName of Object.keys(pose.bones || {})) boneNames.add(boneName);
    }
    for (let frame = 0; frame < frameCount; frame++) {
        const pose = frames[frame];
        for (const boneName of boneNames) {
            setTrackKeyframeFromEuler(
                state,
                boneName,
                frame,
                getPoseTrackEuler(pose, boneName),
                state.defaultInterpolation,
            );
        }
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

export function humanizeBoneName(name) {
    if (name === MODEL_ROTATION_TRACK) return "Model Rotation";
    return String(name || "")
        .replace(/_/g, " ")
        .replace(/\b(l|r)\b/g, token => token === "l" ? "Left" : "Right")
        .replace(/\b\w/g, character => character.toUpperCase());
}

function niceTickStep(frameCount) {
    const target = Math.max(1, frameCount / 12);
    const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
    const residual = target / magnitude;
    const nice = residual >= 5 ? 5 : residual >= 2 ? 2 : 1;
    return Math.max(1, nice * magnitude);
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
        this.getPreferredTrack = options.getPreferredTrack || (() => null);
        this.search = "";
        this.keyedOnly = false;
        this.selectedKey = null;
        this._raf = null;
        this._playing = false;
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
        this.deleteKeyButton = this._button("⌫", "Delete selected key", () => this.deleteSelectedKey());

        this.interpolationSelect = document.createElement("select");
        this.interpolationSelect.className = "vnccs-ps-tl-select";
        this.interpolationSelect.title = "Outgoing interpolation of the selected key";
        for (const preset of INTERPOLATION_PRESETS) {
            const option = document.createElement("option");
            option.value = preset.value;
            option.textContent = preset.label;
            this.interpolationSelect.appendChild(option);
        }
        this.interpolationSelect.addEventListener("change", () => {
            const value = this.interpolationSelect.value;
            this.state.defaultInterpolation = value;
            if (this.selectedKey && setKeyframeInterpolation(this.state, this.selectedKey.trackName, this.selectedKey.frame, value)) {
                this.onStateChange({ type: "interpolation", ...this.selectedKey });
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
            this.selectedKey = null;
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
            this.selectedKey = null;
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
            this.renderTracks();
        });
        this.keyedButton = this._button("KEYED", "Show animated tracks only", () => {
            this.keyedOnly = !this.keyedOnly;
            this.keyedButton.classList.toggle("active", this.keyedOnly);
            this.renderTracks();
        }, "toggle");

        this.toolbar.append(
            this.firstButton, this.previousButton, this.playButton, this.nextButton, this.lastButton,
            this.frameInput, this.status,
            this.addKeyButton, this.deleteKeyButton, this.interpolationSelect,
            this.autoKeyButton, this.loopButton,
            fpsLabel, durationLabel,
            this.searchInput, this.keyedButton,
        );

        this.body = document.createElement("div");
        this.body.className = "vnccs-ps-tl-body";
        this.content = document.createElement("div");
        this.content.className = "vnccs-ps-tl-content";
        this.body.appendChild(this.content);
        this.element.append(this.toolbar, this.body);

        this.element.addEventListener("keydown", event => {
            if ((event.key === "Delete" || event.key === "Backspace") && this.selectedKey) {
                event.preventDefault();
                this.deleteSelectedKey();
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

    setState(state) {
        this.stopPlayback();
        this.state = state;
        this.selectedKey = null;
        this.render();
    }

    setBoneNames(names) {
        const unique = Array.from(new Set((names || []).filter(Boolean)));
        if (unique.join("\u0000") === this.boneNames.join("\u0000")) return;
        this.boneNames = unique;
        this.renderTracks();
    }

    setVisible(visible) {
        this.element.classList.toggle("visible", !!visible);
        if (!visible) this.stopPlayback();
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
        if (!this.selectedKey) return;
        const selection = { ...this.selectedKey };
        if (deleteTrackKeyframe(this.state, selection.trackName, selection.frame)) {
            this.selectedKey = null;
            this.onStateChange({ type: "deleteKey", ...selection });
            this.renderTracks();
        }
    }

    render() {
        this.updateToolbar();
        this.renderTracks();
    }

    updateToolbar() {
        if (!this.state) return;
        const fps = getAnimationFPS(this.state);
        this.frameInput.max = String(this.state.frameCount - 1);
        this.frameInput.value = String(this.state.currentFrame);
        this.fpsInput.value = String(Number(fps.toFixed(3)));
        this.durationInput.min = String(MIN_FRAME_COUNT / fps);
        this.durationInput.max = String(MAX_FRAME_COUNT / fps);
        this.durationInput.value = String(Number(this.state.duration.toFixed(3)));
        this.status.textContent = `Frame ${this.state.currentFrame} · ${(this.state.currentFrame / fps).toFixed(2)}s`;
        this.playButton.textContent = this._playing ? "❚❚" : "▶";
        this.playButton.classList.toggle("active", this._playing);
        this.autoKeyButton.classList.toggle("active", !!this.state.autoKey);
        this.loopButton.classList.toggle("active", !!this.state.loop);
        const selected = this.selectedKey
            ? this.state.tracks?.[this.selectedKey.trackName]?.keys?.find(key => key.frame === this.selectedKey.frame)
            : null;
        this.interpolationSelect.value = selected?.interpolation || this.state.defaultInterpolation;
    }

    _allTrackNames() {
        const names = [MODEL_ROTATION_TRACK, ...this.boneNames];
        for (const name of Object.keys(this.state.tracks || {})) {
            if (!names.includes(name)) names.push(name);
        }
        return names.filter(name => {
            if (this.keyedOnly && !this.state.tracks?.[name]?.keys?.length) return false;
            if (this.search && !humanizeBoneName(name).toLowerCase().includes(this.search) && !name.toLowerCase().includes(this.search)) return false;
            return true;
        });
    }

    _frameFromPointer(event, lane) {
        const rect = lane.getBoundingClientRect();
        const ratio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        return Math.round(ratio * (this.state.frameCount - 1));
    }

    _bindScrub(lane) {
        lane.addEventListener("pointerdown", event => {
            if (event.button !== 0 || event.target.closest(".vnccs-ps-tl-key")) return;
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

    _makeLane(trackName = null, ruler = false) {
        const lane = document.createElement("div");
        lane.className = `vnccs-ps-tl-lane${ruler ? " ruler" : ""}`;
        const playhead = document.createElement("div");
        playhead.className = "vnccs-ps-tl-playhead";
        lane.appendChild(playhead);
        this._bindScrub(lane);

        if (ruler) {
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

        const keys = this.state.tracks?.[trackName]?.keys || [];
        for (const key of keys) {
            const marker = document.createElement("button");
            marker.type = "button";
            marker.className = "vnccs-ps-tl-key";
            marker.style.left = `${(key.frame / (this.state.frameCount - 1)) * 100}%`;
            marker.title = `Frame ${key.frame} · ${INTERPOLATION_PRESETS.find(item => item.value === key.interpolation)?.label || key.interpolation}`;
            marker.dataset.track = trackName;
            marker.dataset.frame = String(key.frame);
            if (this.selectedKey?.trackName === trackName && this.selectedKey?.frame === key.frame) marker.classList.add("selected");

            marker.addEventListener("click", event => {
                event.stopPropagation();
                this.selectedKey = { trackName, frame: key.frame };
                this.setFrame(key.frame);
                this.updateToolbar();
                this.renderTracks();
            });
            marker.addEventListener("contextmenu", event => {
                event.preventDefault();
                event.stopPropagation();
                deleteTrackKeyframe(this.state, trackName, key.frame);
                this.selectedKey = null;
                this.onStateChange({ type: "deleteKey", trackName, frame: key.frame });
                this.renderTracks();
            });
            marker.addEventListener("pointerdown", event => {
                if (event.button !== 0) return;
                event.stopPropagation();
                const originalFrame = key.frame;
                let destinationFrame = originalFrame;
                marker.setPointerCapture?.(event.pointerId);
                const move = moveEvent => {
                    destinationFrame = this._frameFromPointer(moveEvent, lane);
                    marker.style.left = `${(destinationFrame / (this.state.frameCount - 1)) * 100}%`;
                    marker.title = `Move to frame ${destinationFrame}`;
                };
                const end = endEvent => {
                    marker.removeEventListener("pointermove", move);
                    marker.removeEventListener("pointerup", end);
                    marker.removeEventListener("pointercancel", end);
                    if (marker.hasPointerCapture?.(endEvent.pointerId)) marker.releasePointerCapture(endEvent.pointerId);
                    if (destinationFrame !== originalFrame) {
                        moveTrackKeyframe(this.state, trackName, originalFrame, destinationFrame);
                        this.selectedKey = { trackName, frame: destinationFrame };
                        this.setFrame(destinationFrame);
                        this.onStateChange({ type: "moveKey", trackName, fromFrame: originalFrame, frame: destinationFrame });
                    } else {
                        this.selectedKey = { trackName, frame: originalFrame };
                    }
                    this.renderTracks();
                    this.updateToolbar();
                };
                marker.addEventListener("pointermove", move);
                marker.addEventListener("pointerup", end);
                marker.addEventListener("pointercancel", end);
            });
            lane.appendChild(marker);
        }
        lane.addEventListener("dblclick", event => {
            if (event.target.closest(".vnccs-ps-tl-key")) return;
            const frame = this._frameFromPointer(event, lane);
            this.setFrame(frame);
            this.onRequestKey(trackName, frame);
        });
        return lane;
    }

    renderTracks() {
        if (!this.content || !this.state) return;
        this.content.innerHTML = "";
        const width = Math.max(640, this.state.frameCount * 12);
        this.content.style.setProperty("--vnccs-tl-lane-width", `${width}px`);

        const rulerRow = document.createElement("div");
        rulerRow.className = "vnccs-ps-tl-row ruler";
        const rulerLabel = document.createElement("div");
        rulerLabel.className = "vnccs-ps-tl-track-label ruler";
        rulerLabel.textContent = "Dope Sheet · Frames";
        rulerRow.append(rulerLabel, this._makeLane(null, true));
        this.content.appendChild(rulerRow);

        const names = this._allTrackNames();
        for (const trackName of names) {
            const row = document.createElement("div");
            row.className = "vnccs-ps-tl-row";
            row.dataset.track = trackName;
            const label = document.createElement("div");
            label.className = "vnccs-ps-tl-track-label";
            if (this.state.tracks?.[trackName]?.keys?.length) label.classList.add("animated");

            const indicator = document.createElement("span");
            indicator.className = "vnccs-ps-tl-track-dot";
            const text = document.createElement("span");
            text.className = "vnccs-ps-tl-track-name";
            text.textContent = humanizeBoneName(trackName);
            text.title = trackName;
            const add = this._button("◇", `Add/update key at frame ${this.state.currentFrame}`, event => {
                event.stopPropagation();
                this.onRequestKey(trackName, this.state.currentFrame);
            }, "row-key");
            label.append(indicator, text, add);
            row.append(label, this._makeLane(trackName));
            this.content.appendChild(row);
        }

        if (!names.length) {
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
        for (const playhead of this.content.querySelectorAll(".vnccs-ps-tl-playhead")) playhead.style.left = left;
        this.updateToolbar();
    }
}
