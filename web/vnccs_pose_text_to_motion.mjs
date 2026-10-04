// Pose Studio text-to-motion (ARDY, Kimodo, HY-Motion, UniMate, and any model in config/motion_models).
//
// The panel sends the mannequin's current pose and a prompt to the backend
// (api/text_to_motion), which generates a motion with the selected model.
// Every generated frame is retargeted onto the mannequin once, so scrubbing the
// timeline only swaps precomputed poses. In Pose Studio the clip becomes the
// animation (OK replaces it from the current frame on); in a pose-only host such as
// the UniCanvas pose editor OK keeps the selected frame as the pose. Cancel restores
// what the panel was opened with. Models that are not installed show a card with
// their setup steps (vnccs_pose_motion_setup.mjs).

import {
    MODEL_ROTATION_TRACK,
    bonePositionTrackName,
    deleteTrackKeyframe,
    getAnimationFPS,
    getPoseTrackEuler,
    retimeAnimationTiming,
    setTrackKeyframeFromEuler,
} from "./vnccs_pose_animation.mjs";
import {
    MOTION_SETUP_API,
    SETUP_STYLES,
    describeManagerDenial,
    installPipPackages,
    modelOptionLabel,
    renderModelCard,
    restartComfyUI,
    waitForServer,
} from "./vnccs_pose_motion_setup.mjs";

const MOTION_ANIMATION_MAX_FRAMES = 600;
const MOTION_ANIMATION_MAX_KEYS = 120;

export const MOTION_API = "/vnccs/pose_studio/motion";

// Fallback limits for a model whose description leaves them out.
export const MOTION_DEFAULTS = Object.freeze({
    duration: 4,
    minDuration: 1,
    maxDuration: 10,
    steps: 100,
    minSteps: 10,
    maxSteps: 200,
    maxPromptChars: 400,
});

const FINGERS = ["thumb", "index", "middle", "ring", "pinky"];

// Mannequin bones whose world positions describe the start pose to the backend.
export const MOTION_LANDMARK_BONES = Object.freeze([
    "pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "head",
    ...["l", "r"].flatMap((side) => [
        `clavicle_${side}`, `upperarm_${side}`, `lowerarm_${side}`, `hand_${side}`,
        `thigh_${side}`, `calf_${side}`, `foot_${side}`, `ball_${side}`,
        ...FINGERS.flatMap((finger) => [1, 2, 3].map((index) => `${finger}_0${index}_${side}`)),
    ]),
]);

// Bones that follow the motion's world rotation as a delta from frame 0.
export const MOTION_ROTATION_BONES = Object.freeze(["head", "hand_l", "hand_r", "foot_l", "foot_r"]);

const toArray = (vector) => [vector.x, vector.y, vector.z];

/**
 * Snapshot of the pose the panel was opened with. Every generation starts
 * from it, and Cancel restores it.
 */
export function captureMotionStartPose(viewer) {
    if (!viewer?.THREE || !viewer.bones) throw new Error("Pose viewer is not ready.");
    const THREE = viewer.THREE;
    const pose = viewer.getPose();

    const keypoints = {};
    for (const name of MOTION_LANDMARK_BONES) {
        const position = viewer._getBoneWorldPositionForImport(name);
        if (position) keypoints[name] = toArray(position);
    }
    const worldRotations = {};
    for (const name of MOTION_ROTATION_BONES) {
        const rotation = viewer._getBoneWorldQuaternionForImport(name);
        if (rotation) worldRotations[name] = rotation;
    }

    // Head orientation relative to the mannequin's rest pose, which faces +Z like
    // the motion models' rest poses. resetPose() also clears the model rotation, so the axes
    // stay in world space.
    let headAxes = null;
    const restKeypoints = {};
    const history = Array.isArray(viewer.history) ? viewer.history.slice() : null;
    const future = Array.isArray(viewer.future) ? viewer.future.slice() : null;
    try {
        viewer.resetPose();
        // The backend measures torso bends against the mannequin's own rest pose.
        for (const name of MOTION_LANDMARK_BONES) {
            const position = viewer._getBoneWorldPositionForImport(name);
            if (position) restKeypoints[name] = toArray(position);
        }
        const restHead = viewer._getBoneWorldQuaternionForImport("head");
        if (restHead && worldRotations.head) {
            const delta = worldRotations.head.clone().multiply(restHead.clone().invert()).normalize();
            headAxes = {
                up: toArray(new THREE.Vector3(0, 1, 0).applyQuaternion(delta)),
                forward: toArray(new THREE.Vector3(0, 0, 1).applyQuaternion(delta)),
            };
        }
    } finally {
        viewer.setPose(pose, true);
        if (history) viewer.history = history;
        if (future) viewer.future = future;
    }

    return { pose, keypoints, restKeypoints, worldRotations, headAxes };
}

/**
 * Duration / steps / guidance ranges of a model from the models endpoint.
 * ``steps`` and ``guidance`` are null when the model has no such setting.
 */
export function motionModelLimits(model = null) {
    const caps = model?.capabilities || {};
    const range = (value, fallback) => {
        if (!value || typeof value !== "object") return fallback;
        const min = Number(value.min);
        const max = Number(value.max);
        const initial = Number(value.default);
        if (![min, max, initial].every(Number.isFinite) || min > max) return fallback;
        return { min, max, default: Math.min(max, Math.max(min, initial)) };
    };
    return {
        duration: range(caps.duration, {
            min: MOTION_DEFAULTS.minDuration, max: MOTION_DEFAULTS.maxDuration, default: MOTION_DEFAULTS.duration,
        }),
        steps: range(caps.steps, model ? null : {
            min: MOTION_DEFAULTS.minSteps, max: MOTION_DEFAULTS.maxSteps, default: MOTION_DEFAULTS.steps,
        }),
        guidance: range(caps.guidance, null),
        startPoseConstraint: model ? caps.start_pose_constraint === true : true,
        maxCharacters: Math.max(1, Math.round(Number(caps.max_characters)) || 1),
    };
}

/** Warning text for a model whose license excludes some territories, else "". */
export function motionLicenseWarning(model) {
    const territories = (model?.license?.restricted_territories || []).filter((name) => typeof name === "string" && name);
    if (!territories.length) return "";
    const list = territories.length > 1
        ? `${territories.slice(0, -1).join(", ")} and ${territories[territories.length - 1]}`
        : territories[0];
    const license = model.license?.name || "The license";
    return `${license} does not apply in the ${list}. Using ${model.name || "this model"} or its output there is not permitted.`;
}

export function clampMotionSettings(settings = {}, model = null) {
    const limits = motionModelLimits(model);
    const number = (value, range) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.min(range.max, Math.max(range.min, parsed)) : range.default;
    };
    const seed = Number.parseInt(settings.seed, 10);
    return {
        prompt: String(settings.prompt || "").replace(/\s+/g, " ").trim().slice(0, MOTION_DEFAULTS.maxPromptChars),
        duration: number(settings.duration, limits.duration),
        steps: limits.steps ? Math.round(number(settings.steps, limits.steps)) : null,
        guidance: limits.guidance ? number(settings.guidance, limits.guidance) : null,
        seed: settings.randomSeed || !Number.isFinite(seed) || seed < 0 ? null : seed,
        useStartPose: settings.useStartPose !== false,
        keepInPlace: settings.keepInPlace !== false,
    };
}

export function buildMotionRequest(settings, start, taskId = "", model = null) {
    const clean = clampMotionSettings(settings, model);
    const request = {
        task_id: taskId,
        prompt: clean.prompt,
        duration: clean.duration,
        seed: clean.seed,
        use_start_pose: clean.useStartPose,
        keypoints: start.keypoints,
        rest_keypoints: start.restKeypoints,
        head_axes: start.headAxes,
    };
    if (model?.id) request.model = model.id;
    if (clean.steps !== null) request.steps = clean.steps;
    if (clean.guidance !== null) request.guidance = clean.guidance;
    return request;
}

function motionPoint(motion, name, frame) {
    const point = motion?.joints?.[name]?.[frame];
    return Array.isArray(point) && point.length >= 3 ? point : null;
}

function motionQuaternion(THREE, motion, bone, frame) {
    const value = motion?.rotations?.[bone]?.[frame];
    if (!Array.isArray(value) || value.length < 4) return null;
    return new THREE.Quaternion(value[0], value[1], value[2], value[3]).normalize();
}

function motionVector(THREE, motion, from, to, frame) {
    const a = motionPoint(motion, from, frame);
    const b = motionPoint(motion, to, frame);
    return a && b ? new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]) : null;
}

function basisQuaternion(THREE, primary, secondary) {
    if (!primary || !secondary || primary.lengthSq() < 1e-12) return null;
    const x = primary.clone().normalize();
    const y = secondary.clone().sub(x.clone().multiplyScalar(secondary.dot(x)));
    if (y.lengthSq() < 1e-12) return null;
    y.normalize();
    const z = new THREE.Vector3().crossVectors(x, y);
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/**
 * World rotation that turns a motion frame-0 body part into frame ``frame``:
 * two direction pairs give a full rotation, one pair the smallest rotation.
 */
function motionDelta(THREE, motion, frame, primary, secondary = null) {
    const p0 = motionVector(THREE, motion, primary[0], primary[1], 0);
    const pt = motionVector(THREE, motion, primary[0], primary[1], frame);
    if (!p0 || !pt || p0.lengthSq() < 1e-12 || pt.lengthSq() < 1e-12) return new THREE.Quaternion();
    if (secondary) {
        const b0 = basisQuaternion(THREE, p0, motionVector(THREE, motion, secondary[0], secondary[1], 0));
        const bt = basisQuaternion(THREE, pt, motionVector(THREE, motion, secondary[0], secondary[1], frame));
        if (b0 && bt) return bt.multiply(b0.invert()).normalize();
    }
    return new THREE.Quaternion().setFromUnitVectors(p0.normalize(), pt.normalize());
}

/**
 * World landmarks for motion frame ``frame`` built on the start pose: every
 * mannequin segment turns by the world rotation its source counterpart made
 * since frame 0. Frame 0 reproduces the start pose exactly, and the
 * mannequin keeps its own proportions and rest geometry.
 */
export function buildMotionWorldKeypoints(THREE, motion, frame, start, { keepInPlace = true } = {}) {
    const at = (name) => {
        const point = start.keypoints?.[name];
        return Array.isArray(point) ? new THREE.Vector3(point[0], point[1], point[2]) : null;
    };
    const segment = (from, to) => {
        const a = at(from);
        const b = at(to);
        return a && b ? b.sub(a) : null;
    };
    const rotated = (anchor, offset, delta) => (anchor && offset ? anchor.clone().add(offset.applyQuaternion(delta)) : null);

    const pelvisStart = at("pelvis");
    const rootNow = motionPoint(motion, "Hips", frame);
    const rootStart = motionPoint(motion, "Hips", 0);
    if (!pelvisStart || !rootNow || !rootStart) return null;
    const pelvis = pelvisStart.clone().add(new THREE.Vector3(
        keepInPlace ? 0 : rootNow[0] - rootStart[0],
        rootNow[1] - rootStart[1],
        keepInPlace ? 0 : rootNow[2] - rootStart[2],
    ));

    const hipsDelta = motionDelta(THREE, motion, frame, ["RightUpLeg", "LeftUpLeg"], ["Hips", "Spine"]);
    const trunkDelta = motionDelta(THREE, motion, frame, ["Hips", "Neck"]);
    const chestDelta = motionDelta(THREE, motion, frame, ["RightArm", "LeftArm"], ["Spine2", "Neck"]);
    const neck = rotated(pelvis, segment("pelvis", "neck_01"), trunkDelta);
    const worldKps = {
        pelvis,
        neck,
        head: rotated(neck, segment("neck_01", "head"), motionDelta(THREE, motion, frame, ["Neck", "Head"])),
    };

    for (const [side, prefix, source] of [["l", "left", "Left"], ["r", "right", "Right"]]) {
        const limb = (anchor, from, to, sourceFrom, sourceTo) => rotated(
            anchor, segment(from, to), motionDelta(THREE, motion, frame, [sourceFrom, sourceTo]),
        );
        const shoulder = rotated(neck, segment("neck_01", `upperarm_${side}`), chestDelta);
        const elbow = limb(shoulder, `upperarm_${side}`, `lowerarm_${side}`, `${source}Arm`, `${source}ForeArm`);
        const wrist = limb(elbow, `lowerarm_${side}`, `hand_${side}`, `${source}ForeArm`, `${source}Hand`);
        const hip = rotated(pelvis, segment("pelvis", `thigh_${side}`), hipsDelta);
        const knee = limb(hip, `thigh_${side}`, `calf_${side}`, `${source}UpLeg`, `${source}Leg`);
        const ankle = limb(knee, `calf_${side}`, `foot_${side}`, `${source}Leg`, `${source}Foot`);
        const toe = limb(ankle, `foot_${side}`, `ball_${side}`, `${source}Foot`, `${source}ToeBase`);
        Object.assign(worldKps, {
            [`${prefix}_shoulder`]: shoulder,
            [`${prefix}_elbow`]: elbow,
            [`${prefix}_wrist`]: wrist,
            [`${prefix}_hip`]: hip,
            [`${prefix}_knee`]: knee,
            [`${prefix}_ankle`]: ankle,
            [`${prefix}_big_toe`]: toe,
            [`${prefix}_small_toe`]: toe?.clone() || null,
        });
    }
    const required = ["pelvis", "neck", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
        "left_wrist", "right_wrist", "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle"];
    return required.every((name) => worldKps[name]) ? worldKps : null;
}

/**
 * Pose the mannequin like motion frame ``frame`` and return ``viewer.getPose()``.
 * Landmarks go through the viewer's world-keypoint import; head, hands and feet
 * turn by the motion's world rotation change since frame 0.
 */
export function retargetMotionFrame(viewer, motion, frame, start, { keepInPlace = true } = {}) {
    const THREE = viewer.THREE;
    viewer.setPose(start.pose, true);
    viewer.skinnedMesh?.updateMatrixWorld?.(true);

    // Every model is applied as its change since frame 0 on top of the start pose:
    // frame 0 is always the pose being edited, and joints a model does not have keep it.
    const worldKps = buildMotionWorldKeypoints(THREE, motion, frame, start, { keepInPlace });
    if (!worldKps) return null;

    const history = Array.isArray(viewer.history) ? viewer.history.slice() : null;
    const future = Array.isArray(viewer.future) ? viewer.future.slice() : null;
    const applied = viewer.applyWorldKeypointImport(worldKps, {
        includeSpine: true,
        normalizeLimbs: true,
        alignHead: false,
        alignHands: false,
        alignFeet: false,
        drawFigure: false,
        updateMarkers: false,
        dispatchPoseChange: false,
    });
    if (history) viewer.history = history;
    if (future) viewer.future = future;
    if (!applied) return null;

    viewer.skinnedMesh?.updateMatrixWorld?.(true);
    for (const bone of MOTION_ROTATION_BONES) {
        const target = viewer.bones?.[bone];
        const startWorld = start.worldRotations?.[bone];
        const now = motionQuaternion(THREE, motion, bone, frame);
        const first = motionQuaternion(THREE, motion, bone, 0);
        if (!target || !startWorld || !now || !first) continue;
        const delta = now.multiply(first.invert()).normalize();
        viewer._setBoneWorldQuaternion(target, delta.multiply(startWorld).normalize());
        viewer.skinnedMesh?.updateMatrixWorld?.(true);
    }
    viewer.skeleton?.update?.();
    viewer.updateIKEffectorPositions?.();
    return viewer.getPose();
}

/** Retarget every frame once; yields to the browser between chunks. */
export async function retargetMotion(viewer, motion, start, options = {}, onProgress = null) {
    const frameCount = Math.max(0, Number(motion?.frame_count) || 0);
    const poses = [];
    let lastPose = start.pose;
    try {
        for (let frame = 0; frame < frameCount; frame++) {
            const pose = retargetMotionFrame(viewer, motion, frame, start, options) || lastPose;
            poses.push(pose);
            lastPose = pose;
            if (frame % 12 === 11) {
                onProgress?.((frame + 1) / frameCount);
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        }
    } finally {
        viewer.setPose(start.pose, true);
    }
    onProgress?.(1);
    return poses;
}

const PANEL_STYLES = `
.vnccs-ps-t2m {
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: 8px;
    z-index: 900;
    pointer-events: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
    background: rgba(18, 14, 28, 0.94);
    border: 1px solid var(--ps-accent-border, rgba(255, 143, 163, 0.35));
    border-radius: var(--ps-radius-md, 12px);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
    font-size: 11px;
    color: var(--ps-text, #eee);
    zoom: var(--vnccs-ps-ui-scale, 1);
}
.vnccs-ps-t2m-title { display: flex; align-items: center; justify-content: space-between; font-weight: 700; }
.vnccs-ps-t2m-title small { font-weight: 400; opacity: 0.6; }
.vnccs-ps-t2m textarea.vnccs-ps-textarea { min-height: 44px; overflow-y: auto; }
.vnccs-ps-t2m-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.vnccs-ps-t2m-row label { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
.vnccs-ps-t2m-row input[type="number"] { width: 72px; }
.vnccs-ps-t2m-row .vnccs-ps-t2m-spacer { flex: 1; }
.vnccs-ps-t2m-timeline { display: flex; align-items: center; gap: 8px; }
.vnccs-ps-t2m-timeline input[type="range"] { flex: 1; accent-color: var(--ps-accent, #ff8fa3); }
.vnccs-ps-t2m-frame { min-width: 96px; text-align: right; font-variant-numeric: tabular-nums; opacity: 0.8; }
.vnccs-ps-t2m-status { min-height: 14px; opacity: 0.8; }
.vnccs-ps-t2m-status.is-error { color: var(--ps-error, #ff4757); opacity: 1; }
.vnccs-ps-t2m-progress { height: 3px; border-radius: 2px; background: rgba(255, 255, 255, 0.08); overflow: hidden; }
.vnccs-ps-t2m-progress > div { height: 100%; width: 0; background: var(--ps-accent, #ff8fa3); transition: width 0.2s ease; }
.vnccs-ps-t2m-title select { max-width: 60%; }
.vnccs-ps-t2m-license {
    display: none;
    padding: 6px 8px;
    border-radius: 8px;
    border: 1px solid var(--ps-warning, #ffaa00);
    background: rgba(255, 170, 0, 0.14);
    color: var(--ps-warning, #ffaa00);
    line-height: 1.35;
}
.vnccs-ps-t2m-note { opacity: 0.75; line-height: 1.35; }
.vnccs-ps-t2m-license.is-visible { display: block; }
.vnccs-ps-t2m-license a { color: inherit; text-decoration: underline; margin-left: 4px; }
.vnccs-ps-t2m button:disabled, .vnccs-ps-t2m input:disabled { opacity: 0.45; cursor: default; }
/* Compact: one row (prompt, Generate, play, timeline, OK) so the character stays visible. */
.vnccs-ps-t2m.is-compact { flex-flow: row nowrap; align-items: center; padding: 6px 8px; }
.vnccs-ps-t2m.is-compact .vnccs-ps-t2m-title,
.vnccs-ps-t2m.is-compact .vnccs-ps-t2m-options,
.vnccs-ps-t2m.is-compact .vnccs-ps-t2m-timeline,
.vnccs-ps-t2m.is-compact .vnccs-ps-t2m-actions { display: contents; }
.vnccs-ps-t2m.is-compact .vnccs-ps-t2m-title > :not(.vnccs-ps-t2m-compact),
.vnccs-ps-t2m.is-compact .vnccs-ps-t2m-options > :not(button),
.vnccs-ps-t2m.is-compact .vnccs-ps-t2m-actions > .vnccs-ps-t2m-spacer,
.vnccs-ps-t2m.is-compact .vnccs-ps-t2m-card,
.vnccs-ps-t2m.is-compact .vnccs-ps-t2m-license,
.vnccs-ps-t2m.is-compact .vnccs-ps-t2m-note,
.vnccs-ps-t2m.is-compact .vnccs-ps-t2m-settings,
.vnccs-ps-t2m.is-compact .vnccs-ps-t2m-frame,
.vnccs-ps-t2m.is-compact .vnccs-ps-t2m-status:not(.is-error) { display: none; }
.vnccs-ps-t2m.is-compact button { flex: none; }
.vnccs-ps-t2m.is-compact .vnccs-ps-t2m-progress { position: absolute; left: 8px; right: 8px; top: 1px; }
.vnccs-ps-t2m.is-compact textarea.vnccs-ps-textarea { order: 1; flex: 2 1 0; min-width: 60px; min-height: 0; height: 26px; resize: none; }
.vnccs-ps-t2m.is-compact .vnccs-ps-t2m-options > button { order: 2; }
.vnccs-ps-t2m.is-compact .vnccs-ps-t2m-timeline > button { order: 3; }
.vnccs-ps-t2m.is-compact .vnccs-ps-t2m-timeline > input { order: 4; flex: 3 1 0; min-width: 60px; }
.vnccs-ps-t2m.is-compact .vnccs-ps-t2m-actions > button { order: 6; }
.vnccs-ps-t2m.is-compact .vnccs-ps-t2m-compact { order: 7; }
/* Errors float above the row instead of adding a second one. */
.vnccs-ps-t2m.is-compact .vnccs-ps-t2m-status.is-error {
    position: absolute; left: 0; right: 0; bottom: calc(100% + 4px);
    padding: 6px 8px; border-radius: 8px; background: rgba(18, 14, 28, 0.94);
}
`;

function ensurePanelStyles(doc) {
    if (!doc?.head || doc.getElementById?.("vnccs-ps-t2m-styles")) return;
    const style = doc.createElement("style");
    style.id = "vnccs-ps-t2m-styles";
    style.textContent = PANEL_STYLES + SETUP_STYLES;
    doc.head.appendChild(style);
}

const COMPACT_KEY = "vnccs.poseStudio.motionCompact";

/** Per-browser preference; the panel works without storage. */
function storedCompact() {
    try {
        return globalThis.localStorage?.getItem(COMPACT_KEY) === "1";
    } catch {
        return false;
    }
}

function newTaskId() {
    return globalThis.crypto?.randomUUID?.() || `motion-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Floating panel over the Pose Studio viewport: prompt, generation settings,
 * a frame timeline for the generated motion, and OK / Cancel.
 */
/**
 * Keyframe spacing for a generated clip: one animation frame per motion frame at the model's
 * frame rate, keyed sparsely (linear interpolation in between) so long clips stay editable.
 */
export function motionAnimationOptions(frameCount, fps) {
    const count = Math.max(2, Math.min(MOTION_ANIMATION_MAX_FRAMES, Math.round(Number(frameCount)) || 2));
    const rate = Number(fps) > 0 ? Number(fps) : 30;
    return {
        frameCount: count,
        duration: count / rate,
        keyframeStep: Math.max(1, Math.ceil(count / MOTION_ANIMATION_MAX_KEYS)),
    };
}

/**
 * Replace the animation from `startFrame` onward with a generated motion: every key at or after
 * that frame (all tracks) is deleted, the timeline ends where the clip ends, and frames before
 * `startFrame` stay untouched. The motion's frame rate is converted to the animation's.
 * Returns the first and last timeline frame written.
 */
export function insertMotionIntoAnimation(state, poses, { startFrame = 0, motionFps = 30, keyframeStep = 1 } = {}) {
    if (!state || !Array.isArray(poses) || !poses.length) throw new Error("There is no motion to insert.");
    const fps = getAnimationFPS(state);
    const rate = Number(motionFps) > 0 ? Number(motionFps) : 30;
    const start = Math.max(0, Math.min(state.frameCount - 1, Math.round(Number(startFrame)) || 0));
    const toFrame = (index) => start + Math.round((index * fps) / rate);

    for (const [name, track] of Object.entries(state.tracks || {})) {
        for (const key of [...(track.keys || [])]) {
            if (key.frame >= start) deleteTrackKeyframe(state, name, key.frame);
        }
    }
    retimeAnimationTiming(state, { duration: (toFrame(poses.length - 1) + 1) / fps });
    const end = Math.min(toFrame(poses.length - 1), state.frameCount - 1);

    const step = Math.max(1, Math.round(Number(keyframeStep)) || 1);
    const indices = [];
    for (let index = 0; index < poses.length; index += step) {
        if (toFrame(index) <= end) indices.push(index);
    }
    if (indices.at(-1) !== poses.length - 1 && toFrame(poses.length - 1) <= end) indices.push(poses.length - 1);

    const tracks = new Set([MODEL_ROTATION_TRACK]);
    for (const pose of poses) {
        for (const name of Object.keys(pose?.bones || {})) tracks.add(name);
        for (const name of Object.keys(pose?.bonePositions || {})) tracks.add(bonePositionTrackName(name));
    }
    for (const track of tracks) {
        for (const index of indices) {
            setTrackKeyframeFromEuler(state, track, toFrame(index), getPoseTrackEuler(poses[index], track), state.defaultInterpolation);
        }
    }
    return { start, end };
}

export class TextToMotionPanel {
    constructor(widget, { fetchApi, document: doc = globalThis.document } = {}) {
        this.widget = widget;
        this.fetchApi = fetchApi;
        this.document = doc;
        this.root = null;
        this.start = null;
        this.motion = null;
        this.poses = [];
        this.frame = 0;
        this.busy = false;
        this.animation = false;
        this.playing = false;
        this.playHandle = null;
        this.session = 0;
        this.models = [];
        this.modelsPromise = null;
        this.modelApplied = false;
        this.poseOnly = false;
        this.setup = { message: "", error: false, restartPending: false, busy: false };
        this.settings = {
            model: "",
            prompt: "",
            duration: MOTION_DEFAULTS.duration,
            steps: MOTION_DEFAULTS.steps,
            guidance: "",
            seed: "",
            randomSeed: true,
            useStartPose: true,
            keepInPlace: true,
        };
        this.compact = storedCompact();
    }

    get viewer() {
        return this.widget?.viewer;
    }

    get model() {
        return this.models.find((model) => model.id === this.settings.model) || null;
    }

    /** Preview poses must not be captured as animation keyframes. */
    setViewerPose(pose) {
        const widget = this.widget;
        const guard = this.animation && widget;
        if (guard) widget._applyingAnimationPose = true;
        try {
            this.viewer.setPose(pose, true);
        } finally {
            if (guard) widget._applyingAnimationPose = false;
        }
        this.viewer.requestRender?.();
    }

    /** Models from config/motion_models, fetched once per page. */
    loadModels() {
        if (!this.modelsPromise) {
            this.modelsPromise = (async () => {
                const response = await this.fetchApi(`${MOTION_API}/models`);
                const result = await response.json().catch(() => ({}));
                if (!response.ok || !Array.isArray(result?.models)) throw new Error(result?.error || `HTTP ${response.status}`);
                this.models = result.models.filter((model) => model && typeof model.id === "string");
                // Start on a model that is ready to use, so a fresh install is not greeted by a setup card.
                if (!this.model) {
                    const ready = this.models.find((model) => model.available !== false);
                    this.settings.model = ready?.id || result.default || this.models[0]?.id || "";
                }
                return this.models;
            })().catch((error) => {
                this.modelsPromise = null;
                throw error;
            });
        }
        return this.modelsPromise;
    }

    /** Fetch the model list again (after installing something). */
    async reloadModels() {
        this.modelsPromise = null;
        await this.loadModels();
        if (this.root) this.applyModel();
    }

    isOpen() {
        return !!this.root;
    }

    /**
     * `poseOnly`: the host edits a single pose (UniCanvas), so OK uses one frame of the clip.
     * Otherwise the clip becomes the animation, which needs the host in Animation mode.
     */
    open({ poseOnly = false } = {}) {
        if (this.root) return;
        if (!this.viewer?.isInitialized?.()) {
            this.widget?.showMessage?.("Pose viewer is not ready yet.", true);
            return;
        }
        this.poseOnly = poseOnly;
        this.animation = !poseOnly && this.widget?.isAnimationMode?.() === true;
        this.startFrame = this.animation ? Math.max(0, Math.round(Number(this.widget.animationState?.currentFrame)) || 0) : 0;
        if (this.animation) this.widget._applyingAnimationPose = true;
        try {
            this.start = captureMotionStartPose(this.viewer);
        } finally {
            if (this.animation) this.widget._applyingAnimationPose = false;
        }
        this.session += 1;
        this.motion = null;
        this.poses = [];
        this.frame = 0;
        this.build();
        const session = this.session;
        this.loadModels()
            .then(() => {
                if (!this.root || this.session !== session) return;
                if (!this.modelApplied) {
                    this.settings.steps = "";
                    this.settings.guidance = "";
                    this.modelApplied = true;
                }
                this.applyModel();
            })
            .catch((error) => {
                if (this.root && this.session === session) {
                    this.setStatus(`Could not list motion models: ${error?.message || error}`, { error: true });
                }
            });
    }

    element(tag, className = "", text = "") {
        const node = this.document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
    }

    option(value, text) {
        const node = this.element("option", "", text);
        node.value = value;
        return node;
    }

    numberInput(value, min, max, step) {
        const input = this.element("input", "vnccs-ps-input");
        input.type = "number";
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        input.value = String(value);
        return input;
    }

    checkbox(labelText, checked, title = "") {
        const label = this.element("label");
        const input = this.element("input");
        input.type = "checkbox";
        input.checked = checked;
        if (title) label.title = title;
        label.append(input, this.element("span", "", labelText));
        return { label, input };
    }

    build() {
        ensurePanelStyles(this.document);
        const root = this.element("div", "vnccs-ps-t2m");
        root.addEventListener("keydown", (event) => {
            event.stopPropagation();
            if (event.key === "Escape") this.cancel();
        });
        root.addEventListener("pointerdown", (event) => event.stopPropagation());

        const title = this.element("div", "vnccs-ps-t2m-title");
        const modelSelect = this.element("select", "vnccs-ps-select");
        modelSelect.title = "Motion model";
        modelSelect.appendChild(this.option("", "Loading models..."));
        modelSelect.disabled = true;
        modelSelect.addEventListener("change", () => {
            this.settings.model = modelSelect.value;
            // Steps and guidance mean different things per model: start from its defaults.
            this.settings.steps = "";
            this.settings.guidance = "";
            this.applyModel();
        });
        modelSelect.title = "Motion model: the card below says what each one is good at and what it needs";
        const compact = this.element("button", "vnccs-ps-btn vnccs-ps-t2m-compact");
        compact.addEventListener("click", () => this.setCompact(!this.compact));
        title.append(this.element("span", "", "Text to Motion"), modelSelect, compact);
        const card = this.element("div", "vnccs-ps-t2m-card");

        // Shown for models whose license excludes some countries or regions.
        const license = this.element("div", "vnccs-ps-t2m-license");
        const note = this.element("div", "vnccs-ps-t2m-note");
        license.setAttribute("role", "alert");

        const prompt = this.element("textarea", "vnccs-ps-textarea");
        prompt.placeholder = "Describe the motion, e.g. \"A person jumps and lands on both feet.\"";
        prompt.maxLength = MOTION_DEFAULTS.maxPromptChars;
        prompt.value = this.settings.prompt;
        prompt.addEventListener("input", () => { this.settings.prompt = prompt.value; this.updateButtons(); });

        const settingsRow = this.element("div", "vnccs-ps-t2m-row vnccs-ps-t2m-settings");
        const duration = this.numberInput(this.settings.duration, MOTION_DEFAULTS.minDuration, MOTION_DEFAULTS.maxDuration, 0.5);
        duration.addEventListener("input", () => { this.settings.duration = duration.value; });
        const steps = this.numberInput(this.settings.steps, MOTION_DEFAULTS.minSteps, MOTION_DEFAULTS.maxSteps, 10);
        steps.title = "Diffusion steps: more steps are slower and usually cleaner.";
        steps.addEventListener("input", () => { this.settings.steps = steps.value; });
        const guidance = this.numberInput(this.settings.guidance, 1, 10, 0.5);
        guidance.title = "Guidance: how strictly the motion follows the prompt.";
        guidance.addEventListener("input", () => { this.settings.guidance = guidance.value; });
        const seed = this.numberInput(this.settings.seed, 0, 2147483647, 1);
        seed.placeholder = "random";
        seed.disabled = this.settings.randomSeed;
        seed.addEventListener("input", () => { this.settings.seed = seed.value; });
        const randomSeed = this.checkbox("Random", this.settings.randomSeed, "Pick a new seed on every generation.");
        randomSeed.input.addEventListener("change", () => {
            this.settings.randomSeed = randomSeed.input.checked;
            seed.disabled = randomSeed.input.checked;
        });
        const durationLabel = this.element("label", "", "Seconds");
        durationLabel.appendChild(duration);
        const stepsLabel = this.element("label", "", "Steps");
        stepsLabel.appendChild(steps);
        const guidanceLabel = this.element("label", "", "Guidance");
        guidanceLabel.appendChild(guidance);
        const seedLabel = this.element("label", "", "Seed");
        seedLabel.appendChild(seed);
        settingsRow.append(durationLabel, stepsLabel, guidanceLabel, seedLabel, randomSeed.label);

        const optionsRow = this.element("div", "vnccs-ps-t2m-row vnccs-ps-t2m-options");
        const useStartPose = this.checkbox("Start from current pose", this.settings.useStartPose);
        useStartPose.input.addEventListener("change", () => { this.settings.useStartPose = useStartPose.input.checked; });
        const keepInPlace = this.checkbox("Keep in place", this.settings.keepInPlace,
            "Ignore horizontal root travel so the character stays where it stands.");
        keepInPlace.input.addEventListener("change", () => {
            this.settings.keepInPlace = keepInPlace.input.checked;
            if (this.motion && !this.busy) this.retarget();
        });
        const generate = this.element("button", "vnccs-ps-btn primary", "Generate");
        generate.addEventListener("click", () => this.generate());
        optionsRow.append(useStartPose.label, keepInPlace.label, this.element("span", "vnccs-ps-t2m-spacer"), generate);

        const progress = this.element("div", "vnccs-ps-t2m-progress");
        const progressFill = this.element("div");
        progress.appendChild(progressFill);
        const status = this.element("div", "vnccs-ps-t2m-status", this.introText());

        const timeline = this.element("div", "vnccs-ps-t2m-timeline");
        const play = this.element("button", "vnccs-ps-btn", "▶");
        play.title = "Play / pause";
        play.addEventListener("click", () => this.togglePlay());
        const scrub = this.element("input");
        scrub.type = "range";
        scrub.min = "0";
        scrub.max = "0";
        scrub.step = "1";
        scrub.value = "0";
        // Realtime: every input event shows its frame immediately.
        scrub.addEventListener("input", () => { this.stopPlay(); this.showFrame(Number(scrub.value)); });
        const frameLabel = this.element("span", "vnccs-ps-t2m-frame", "no motion yet");
        timeline.append(play, scrub, frameLabel);

        const actions = this.element("div", "vnccs-ps-t2m-row vnccs-ps-t2m-actions");
        const cancel = this.element("button", "vnccs-ps-btn", "Cancel");
        cancel.title = "Close and restore the pose you started from";
        cancel.addEventListener("click", () => this.cancel());
        const ok = this.element("button", "vnccs-ps-btn primary", this.animation ? "Use as animation" : "Use this frame");
        ok.title = this.animation
            ? "Replace the animation from the frame the panel was opened on with this clip"
            : "Use the frame shown on the slider as the pose";
        ok.addEventListener("click", () => this.accept());
        actions.append(this.element("span", "vnccs-ps-t2m-spacer"), cancel, ok);

        root.append(title, card, license, note, prompt, settingsRow, optionsRow, progress, status, timeline, actions);
        this.controls = {
            modelSelect, card, license, note, prompt, duration, steps, stepsLabel, guidance, guidanceLabel, seed,
            useStartPose: useStartPose.label, generate, progressFill, status, play, scrub, frameLabel, ok, compact,
        };
        this.root = root;
        this.setCompact(this.compact);
        this.widget.canvasContainer.appendChild(root);
        this.updateButtons();
        prompt.focus?.();
    }

    /** Compact: prompt, Generate, play, timeline and OK in one row; the model card and settings are hidden. */
    setCompact(compact) {
        this.compact = !!compact;
        try {
            globalThis.localStorage?.setItem(COMPACT_KEY, this.compact ? "1" : "0");
        } catch {
            // Storage is optional.
        }
        if (!this.root) return;
        this.root.classList?.toggle("is-compact", this.compact);
        const button = this.controls.compact;
        button.textContent = this.compact ? "▴" : "▾";
        button.title = this.compact
            ? "Show the model, its setup and the generation settings"
            : "Shrink the panel to one row so it does not cover the character";
    }

    /** Sync the controls with the selected model: limits, hints and the license warning. */
    applyModel() {
        if (!this.controls) return;
        const { modelSelect, license, duration, steps, stepsLabel, guidance, guidanceLabel, useStartPose } = this.controls;
        if (this.models.length) {
            modelSelect.replaceChildren(...this.models.map((model) => {
                const option = this.option(model.id, modelOptionLabel(model));
                option.title = model.guide?.summary || model.description || "";
                return option;
            }));
            modelSelect.disabled = false;
            modelSelect.value = this.settings.model;
        }
        const model = this.model;
        const limits = motionModelLimits(model);

        const setRange = (input, range, key) => {
            input.min = String(range.min);
            input.max = String(range.max);
            const value = Number(this.settings[key]);
            const clamped = Number.isFinite(value) && this.settings[key] !== ""
                ? Math.min(range.max, Math.max(range.min, value))
                : range.default;
            this.settings[key] = clamped;
            input.value = String(clamped);
        };
        setRange(duration, limits.duration, "duration");
        stepsLabel.style.display = limits.steps ? "" : "none";
        if (limits.steps) setRange(steps, limits.steps, "steps");
        guidanceLabel.style.display = limits.guidance ? "" : "none";
        if (limits.guidance) setRange(guidance, limits.guidance, "guidance");
        // Only a model that can start from a given pose has the choice; the card says what the others do.
        useStartPose.style.display = limits.startPoseConstraint ? "" : "none";
        useStartPose.title = limits.startPoseConstraint
            ? "The motion starts exactly from the pose you are editing. Unchecked, the model generates freely and its movement is applied on top of your pose."
            : "This model cannot start from a given pose: its movement is applied on top of the pose you are editing.";

        const sceneCharacters = Math.max(1, this.widget?.characters?.length || 1);
        this.controls.note.textContent = sceneCharacters > limits.maxCharacters
            ? `${model.name} generates one character at a time: the motion goes to the selected character. Motions between characters (a handshake, a hug) need a multi-person model.`
            : "";
        this.controls.note.style.display = this.controls.note.textContent ? "" : "none";

        const warning = motionLicenseWarning(model);
        license.replaceChildren();
        license.classList.toggle("is-visible", !!warning);
        if (warning) {
            license.append(this.element("span", "", `⚠ ${warning}`));
            if (/^https:\/\//i.test(model.license?.url || "")) {
                const link = this.element("a", "", "Read the license");
                link.href = model.license.url;
                link.target = "_blank";
                link.rel = "noopener noreferrer";
                license.appendChild(link);
            }
            license.title = model.license?.territory_notice || "";
        }

        this.renderCard();
        this.updateButtons();
    }

    introText() {
        return this.animation
            ? "Describe a motion and press Generate. It plays here first; \"Use as animation\" puts it on the timeline from the current frame, Cancel keeps your animation."
            : "Describe a motion and press Generate, then drag the slider to the frame you like and press \"Use this frame\".";
    }

    renderCard() {
        if (!this.controls) return;
        const actions = {
            installPip: (step, button) => this.installPackages([step], button),
            installAll: (steps, button) => this.installPackages(steps, button),
            download: (step, button) => this.runDownload(step, button),
            copy: (text, button) => this.copyText(text, button),
            restart: (button) => this.restartServer(button),
            recheck: (button) => this.recheck(button),
        };
        const card = renderModelCard(this.document, this.model, actions, this.setup);
        this.controls.card.replaceChildren(card);
    }

    setSetupMessage(message, error = false) {
        this.setup.message = message;
        this.setup.error = error;
        this.renderCard();
    }

    async managerPolicy() {
        try {
            const response = await this.fetchApi(`${MOTION_SETUP_API}/policy`);
            return response.ok ? await response.json() : null;
        } catch {
            return null;
        }
    }

    async installPackages(steps, button) {
        if (this.setup.busy) return;
        this.setup.busy = true;
        if (button) { button.disabled = true; button.textContent = "Installing..."; }
        const packages = [...new Set(steps.flatMap((step) => step.packages || []))];
        try {
            const result = await installPipPackages(this.fetchApi, packages);
            if (result.ok) {
                this.setup.restartPending = true;
                this.setSetupMessage("ComfyUI-Manager will install the packages when ComfyUI restarts. Press \"Restart ComfyUI\".");
            } else {
                this.setSetupMessage(describeManagerDenial(result, await this.managerPolicy(), packages), true);
            }
        } catch (error) {
            this.setSetupMessage(`Could not reach ComfyUI-Manager: ${error?.message || error}`, true);
        } finally {
            this.setup.busy = false;
        }
    }

    async runDownload(step, button) {
        if (this.setup.busy || !this.model) return;
        this.setup.busy = true;
        if (button) { button.disabled = true; button.textContent = "Downloading..."; }
        const taskId = newTaskId();
        const poll = setInterval(async () => {
            try {
                const response = await this.fetchApi(`${MOTION_API}/status/${encodeURIComponent(taskId)}`);
                const status = response.ok ? await response.json() : null;
                if (status?.status === "running") this.setStatus(status.message || "Downloading...", { progress: status.progress });
            } catch (_error) {
                // Best-effort progress; the POST result below decides.
            }
        }, 1000);
        try {
            const response = await this.fetchApi(`${MOTION_SETUP_API}/download`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-VNCCS-CSRF": "1" },
                body: JSON.stringify({ model: this.model.id, step: step.id, task_id: taskId }),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result?.error || `HTTP ${response.status}`);
            this.setStatus("Download finished.", { progress: 100 });
            this.setup.message = "";
            await this.reloadModels();
        } catch (error) {
            this.setSetupMessage(`Download failed: ${error?.message || error}`, true);
        } finally {
            clearInterval(poll);
            this.setup.busy = false;
            this.renderCard();
        }
    }

    async copyText(text, button) {
        try {
            await globalThis.navigator?.clipboard?.writeText?.(text);
            if (button) button.textContent = "Copied";
        } catch {
            this.setSetupMessage(`Copy this command: ${text}`);
        }
    }

    async restartServer(button) {
        if (button) { button.disabled = true; button.textContent = "Restarting..."; }
        const accepted = await restartComfyUI(this.fetchApi);
        if (!accepted) {
            this.setSetupMessage("ComfyUI-Manager could not restart ComfyUI. Restart it yourself, then press \"Check again\".", true);
            return;
        }
        this.setSetupMessage("Restarting ComfyUI and installing... this can take a few minutes.");
        const back = await waitForServer(async () => (await this.fetchApi(`${MOTION_API}/models`)).ok);
        this.setup.restartPending = false;
        if (!back) {
            this.setSetupMessage("ComfyUI did not come back yet. When it is running again, press \"Check again\".", true);
            return;
        }
        this.setup.message = "";
        await this.reloadModels().catch((error) => this.setSetupMessage(`Could not list motion models: ${error?.message || error}`, true));
    }

    async recheck(button) {
        if (button) { button.disabled = true; button.textContent = "Checking..."; }
        this.setup.message = "";
        try {
            await this.reloadModels();
        } catch (error) {
            this.setSetupMessage(`Could not list motion models: ${error?.message || error}`, true);
        }
    }

    setStatus(text, { error = false, progress = null } = {}) {
        if (!this.controls) return;
        this.controls.status.textContent = text;
        this.controls.status.classList.toggle("is-error", !!error);
        if (progress !== null) this.controls.progressFill.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    }

    updateButtons() {
        if (!this.controls) return;
        const { generate, play, scrub, ok, prompt, modelSelect } = this.controls;
        const hasMotion = this.poses.length > 0;
        const model = this.model;
        generate.textContent = hasMotion ? "Regenerate" : "Generate";
        generate.disabled = this.busy || !model || model.available === false || !clampMotionSettings(this.settings, model).prompt;
        generate.title = model?.available === false ? "Finish this model's setup first, or pick a model marked ready" : "";
        prompt.disabled = this.busy;
        modelSelect.disabled = this.busy || !this.models.length;
        play.disabled = this.busy || this.poses.length < 2;
        scrub.disabled = this.busy || !hasMotion;
        ok.disabled = this.busy || !hasMotion;
    }

    async generate() {
        if (this.busy || !this.start) return;
        const session = this.session;
        const isCurrent = () => this.root && this.session === session;
        const taskId = newTaskId();
        const model = this.model;
        if (!model || model.available === false) return;
        const request = buildMotionRequest(this.settings, this.start, taskId, model);
        if (!request.prompt) return;

        this.stopPlay();
        this.busy = true;
        this.updateButtons();
        // Regeneration always starts from the pose the panel was opened with.
        this.setViewerPose(this.start.pose);
        this.setStatus(`Sending the pose to ${model.name}...`, { progress: 1 });

        const poll = setInterval(async () => {
            try {
                const response = await this.fetchApi(`${MOTION_API}/status/${encodeURIComponent(taskId)}`);
                if (!response.ok) return;
                const status = await response.json();
                if (isCurrent() && this.busy && status?.status === "running") {
                    this.setStatus(status.message || "Generating...", { progress: status.progress });
                }
            } catch (_error) {
                // Status polling is best-effort; the POST below is the source of truth.
            }
        }, 700);

        try {
            const response = await this.fetchApi(`${MOTION_API}/generate`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result?.motion) {
                const reason = [result?.error, result?.install_hint].filter(Boolean).join(" ");
                throw new Error(reason || `HTTP ${response.status}`);
            }
            clearInterval(poll);
            if (!isCurrent()) return;

            this.motion = result.motion;
            if (this.settings.randomSeed) {
                this.controls.seed.value = String(this.motion.seed);
                this.settings.seed = String(this.motion.seed);
            }
            await this.retarget();
        } catch (error) {
            if (isCurrent()) this.setStatus(`${model.name} failed: ${error?.message || error}`, { error: true, progress: 0 });
        } finally {
            clearInterval(poll);
            if (isCurrent()) {
                this.busy = false;
                this.updateButtons();
            }
        }
    }

    async retarget() {
        if (!this.motion || !this.root) return;
        const busyBefore = this.busy;
        this.busy = true;
        this.updateButtons();
        this.setStatus("Applying the motion to the mannequin...", { progress: 97 });
        // Retargeting drives the mannequin frame by frame; none of that may become keyframes.
        const guard = this.animation && this.widget;
        if (guard) this.widget._applyingAnimationPose = true;
        try {
            const options = { keepInPlace: this.settings.keepInPlace };
            this.poses = await retargetMotion(this.viewer, this.motion, this.start, options, (fraction) => {
                this.setStatus("Applying the motion to the mannequin...", { progress: 97 + 3 * fraction });
            });
        } finally {
            if (guard) this.widget._applyingAnimationPose = false;
            this.busy = busyBefore;
        }
        if (!this.root) return;
        const { scrub } = this.controls;
        scrub.max = String(Math.max(0, this.poses.length - 1));
        const frame = Math.min(this.frame, this.poses.length - 1);
        this.setStatus(`Seed ${this.motion.seed} · ${this.poses.length} frames at ${this.motion.fps} FPS. ${this.animation ? `Press "Use as animation" to put it on the timeline from frame ${this.startFrame}.` : "Drag the slider to a frame and press \"Use this frame\"."}`,
            { progress: 100 });
        this.updateButtons();
        this.showFrame(Math.max(0, frame));
    }

    showFrame(frame) {
        if (!this.poses.length || !this.controls) return;
        const index = Math.max(0, Math.min(this.poses.length - 1, Math.round(frame) || 0));
        this.frame = index;
        this.setViewerPose(this.poses[index]);
        const fps = Number(this.motion?.fps) || 30;
        this.controls.scrub.value = String(index);
        this.controls.frameLabel.textContent = `${index + 1} / ${this.poses.length} · ${(index / fps).toFixed(2)} s`;
    }

    togglePlay() {
        if (this.playing) this.stopPlay();
        else this.startPlay();
    }

    startPlay() {
        if (this.poses.length < 2 || this.busy) return;
        this.playing = true;
        this.controls.play.textContent = "❚❚";
        const fps = Number(this.motion?.fps) || 30;
        let startedAt = null;
        let startFrame = this.frame >= this.poses.length - 1 ? 0 : this.frame;
        const tick = (now) => {
            if (!this.playing) return;
            if (startedAt === null) startedAt = now;
            const frame = startFrame + Math.floor(((now - startedAt) / 1000) * fps);
            if (frame >= this.poses.length) {
                this.showFrame(this.poses.length - 1);
                this.stopPlay();
                return;
            }
            if (frame !== this.frame) this.showFrame(frame);
            this.playHandle = requestAnimationFrame(tick);
        };
        this.playHandle = requestAnimationFrame(tick);
    }

    stopPlay() {
        this.playing = false;
        if (this.playHandle !== null) cancelAnimationFrame(this.playHandle);
        this.playHandle = null;
        if (this.controls) this.controls.play.textContent = "▶";
    }

    accept() {
        if (this.animation) {
            this.acceptAnimation();
            return;
        }
        const pose = this.poses[this.frame];
        if (!pose || this.busy) return;
        const viewer = this.viewer;
        // One undo step back to the starting pose.
        viewer.setPose(this.start.pose, true);
        viewer.recordState?.();
        viewer.setPose(pose, true);
        this.close();
        this.widget.updateRotationSliders?.();
        this.widget.commitViewerPoseToCurrentEditor?.({ fullCapture: true });
        viewer.requestRender?.();
    }

    /** Replace the animation with the generated clip (the same path the Mixamo import uses). */
    acceptAnimation() {
        if (!this.poses.length || this.busy) return;
        const poses = this.poses;
        const fps = Number(this.motion?.fps) || 30;
        const startFrame = this.startFrame;
        this.stopPlay();
        this.close();
        const widget = this.widget;
        // One undo step: everything from the chosen frame on is replaced by the clip.
        widget.commitAnimationHistory?.();
        const state = widget.animationState;
        const previousFrameCount = state.frameCount;
        const { keyframeStep } = motionAnimationOptions(poses.length, fps);
        insertMotionIntoAnimation(state, poses, { startFrame, motionFps: fps, keyframeStep });
        if (state.frameCount !== previousFrameCount) {
            widget.retimeAllCharacterAnimations?.({
                fps: state.fps, duration: state.duration, loop: state.loop, currentFrame: startFrame,
            });
        }
        widget.animationTimeline?.setState(state);
        widget.commitAnimationHistory?.();
        widget.applyAnimationFrame?.(startFrame, { transient: true });
        widget.syncToNode?.(false, { skipCapture: true });
    }

    cancel() {
        // A running request keeps going on the server; its result is ignored once closed.
        if (this.start && this.viewer) this.setViewerPose(this.start.pose);
        const startFrame = this.startFrame;
        const animation = this.animation;
        this.close();
        // The animation itself was never touched; show the frame the panel was opened on again.
        if (animation) this.widget.applyAnimationFrame?.(startFrame, { transient: true });
    }

    /** Closing the panel frees the motion model and its text encoder (RAM and VRAM). */
    releaseModel() {
        Promise.resolve()
            .then(() => this.fetchApi(`${MOTION_API}/unload`, { method: "POST" }))
            .catch(() => {});
    }

    close() {
        if (this.root) this.releaseModel();
        this.stopPlay();
        this.root?.remove();
        this.root = null;
        this.controls = null;
        this.start = null;
        this.motion = null;
        this.poses = [];
        this.busy = false;
    }
}
