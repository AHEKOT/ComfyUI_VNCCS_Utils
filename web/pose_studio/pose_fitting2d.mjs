/**
 * VNCCS Pose Studio - 2D Pose Fitting solver.
 *
 * Optimizes mannequin joint rotations so that joints projected through the
 * capture camera land on user-placed 2D markers. This module is pure: it never
 * imports Three.js and never touches the DOM. Viewer bones and the capture
 * camera are read through small duck-typed snapshot helpers, and the solver
 * works on plain arrays so it can be unit tested and benchmarked in Node.
 *
 * Energy (all terms are squared residuals measured in output-frame pixels):
 *   E = E_reprojection + lambda * E_pose + mu * E_joint_limits + nu * E_bend
 *
 * - E_reprojection: weighted pixel distance between each enabled marker and
 *   its joint projected with the real capture camera matrices.
 * - E_pose: deviation from the anchor pose (the pose at the start of the fit
 *   or drag gesture). It resolves depth ambiguity in favour of the current pose.
 * - E_joint_limits: anatomical swing/twist ranges and one-axis elbow/knee
 *   hinges that cannot hyperextend or bend sideways.
 * - E_bend: optional per-marker depth hints (joint toward / away from the
 *   camera relative to its parent joint).
 *
 * Optimized degrees of freedom are local bone rotations (and, only when the
 * user enables it, the pelvis translation). Bone lengths and body proportions
 * are never changed, the camera is never moved.
 */

export const POSE_FITTING_VERSION = 1;

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/**
 * Marker definitions. `openpose` names follow the subject's own left/right
 * (OpenPose convention), which matches the VNCCS `_l`/`_r` bone suffixes.
 * `parent` names the marker one rigid segment closer to the torso; it defines
 * what a depth hint compares against.
 */
export const POSE_FITTING_MARKERS = Object.freeze([
    { id: "head", label: "Head", bone: "head", openpose: "nose", parent: "neck", side: "c", flip: "neck_01" },
    { id: "neck", label: "Neck", bone: "neck_01", openpose: "neck", parent: null, side: "c" },
    { id: "r_shoulder", label: "R Shoulder", bone: "upperarm_r", openpose: "r_shoulder", parent: "neck", side: "r" },
    { id: "r_elbow", label: "R Elbow", bone: "lowerarm_r", openpose: "r_elbow", parent: "r_shoulder", side: "r", flip: "upperarm_r" },
    { id: "r_wrist", label: "R Wrist", bone: "hand_r", openpose: "r_wrist", parent: "r_elbow", side: "r", flip: "lowerarm_r" },
    { id: "l_shoulder", label: "L Shoulder", bone: "upperarm_l", openpose: "l_shoulder", parent: "neck", side: "l" },
    { id: "l_elbow", label: "L Elbow", bone: "lowerarm_l", openpose: "l_elbow", parent: "l_shoulder", side: "l", flip: "upperarm_l" },
    { id: "l_wrist", label: "L Wrist", bone: "hand_l", openpose: "l_wrist", parent: "l_elbow", side: "l", flip: "lowerarm_l" },
    { id: "r_hip", label: "R Hip", bone: "thigh_r", openpose: "r_hip", parent: null, side: "r" },
    { id: "r_knee", label: "R Knee", bone: "calf_r", openpose: "r_knee", parent: "r_hip", side: "r", flip: "thigh_r" },
    { id: "r_ankle", label: "R Ankle", bone: "foot_r", openpose: "r_ankle", parent: "r_knee", side: "r", flip: "calf_r" },
    { id: "l_hip", label: "L Hip", bone: "thigh_l", openpose: "l_hip", parent: null, side: "l" },
    { id: "l_knee", label: "L Knee", bone: "calf_l", openpose: "l_knee", parent: "l_hip", side: "l", flip: "thigh_l" },
    { id: "l_ankle", label: "L Ankle", bone: "foot_l", openpose: "l_ankle", parent: "l_knee", side: "l", flip: "calf_l" },
].map(marker => Object.freeze(marker)));

export const POSE_FITTING_MARKER_IDS = Object.freeze(POSE_FITTING_MARKERS.map(marker => marker.id));
const MARKER_INDEX = new Map(POSE_FITTING_MARKERS.map((marker, index) => [marker.id, index]));

/** Bones that take part in forward kinematics, parents first. */
export const POSE_FITTING_RIG_BONES = Object.freeze([
    "pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "head",
    "clavicle_l", "upperarm_l", "lowerarm_l", "hand_l",
    "clavicle_r", "upperarm_r", "lowerarm_r", "hand_r",
    "thigh_l", "calf_l", "foot_l",
    "thigh_r", "calf_r", "foot_r",
]);

/**
 * Joint model. Ball-joint limits are swing components (degrees, rotation
 * vector components in the parent rest frame, left side; the right side is
 * mirrored) plus twist about the rest bone direction. Hinges rotate about one
 * axis fixed in the parent frame; `flex` is the signed bend angle where 0 is a
 * straight limb and positive bends toward `flexSide` (body front or back).
 * `prior` multiplies the pose-prior stiffness: torso joints are stiffer so
 * limbs move first.
 */
export const POSE_FITTING_JOINTS = Object.freeze({
    pelvis: { type: "ball", scope: "body", prior: 6, axis: [0, 1, 0], limits: null, translation: true },
    spine_01: { type: "ball", scope: "body", prior: 4, child: "spine_02", limits: { x: [-20, 35], z: [-20, 20], twist: [-20, 20] } },
    spine_02: { type: "ball", scope: "body", prior: 4, child: "spine_03", limits: { x: [-20, 35], z: [-20, 20], twist: [-20, 20] } },
    spine_03: { type: "ball", scope: "body", prior: 4, child: "neck_01", limits: { x: [-20, 35], z: [-20, 20], twist: [-20, 20] } },
    neck_01: { type: "ball", scope: "limbs", prior: 2, child: "head", limits: { x: [-35, 45], z: [-30, 30], twist: [-45, 45] } },
    head: { type: "ball", scope: "limbs", prior: 2, axis: [0, 1, 0], limits: { x: [-30, 35], z: [-30, 30], twist: [-50, 50] } },
    clavicle_l: { type: "ball", scope: "limbs", prior: 3, child: "upperarm_l", limits: { x: [-20, 20], y: [-25, 15], z: [-10, 30], twist: [-10, 10] } },
    clavicle_r: { type: "ball", scope: "limbs", prior: 3, child: "upperarm_r", limits: { x: [-20, 20], y: [-25, 15], z: [-10, 30], twist: [-10, 10] } },
    upperarm_l: { type: "ball", scope: "limbs", prior: 1, child: "lowerarm_l", limits: { x: [-90, 90], y: [-135, 50], z: [-60, 140], twist: [-90, 90] } },
    upperarm_r: { type: "ball", scope: "limbs", prior: 1, child: "lowerarm_r", limits: { x: [-90, 90], y: [-135, 50], z: [-60, 140], twist: [-90, 90] } },
    lowerarm_l: { type: "hinge", scope: "limbs", prior: 1, child: "hand_l", flex: [0, 150], flexSide: "front" },
    lowerarm_r: { type: "hinge", scope: "limbs", prior: 1, child: "hand_r", flex: [0, 150], flexSide: "front" },
    thigh_l: { type: "ball", scope: "limbs", prior: 1.5, child: "calf_l", limits: { x: [-130, 30], y: [-90, 90], z: [-30, 60], twist: [-45, 45] } },
    thigh_r: { type: "ball", scope: "limbs", prior: 1.5, child: "calf_r", limits: { x: [-130, 30], y: [-90, 90], z: [-30, 60], twist: [-45, 45] } },
    calf_l: { type: "hinge", scope: "limbs", prior: 1, child: "foot_l", flex: [0, 150], flexSide: "back" },
    calf_r: { type: "hinge", scope: "limbs", prior: 1, child: "foot_r", flex: [0, 150], flexSide: "back" },
});

export const POSE_FITTING_DEFAULTS = Object.freeze({
    /** Pose-prior stiffness in px^2 per rad^2 (multiplied by joint.prior). */
    poseStiffness: 4,
    /** Joint-limit penalty in px^2 per degree^2 of violation. */
    limitWeight: 400,
    /** Depth-hint penalty in px^2 per world unit^2 of violation. */
    depthWeight: 2500,
    /** Root translation prior: px^2 per world unit^2 (image plane / depth). */
    rootStiffness: 25,
    rootDepthStiffness: 400,
    pinFactor: 10,
    dragFactor: 4,
    maxRotationStep: 0.35,
    maxTranslationStep: 1.0,
    unreachedPx: 6,
});

export const POSE_FITTING_DEPTH_HINTS = Object.freeze(["auto", "near", "far"]);
export const POSE_FITTING_SCOPES = Object.freeze(["limbs", "body"]);

// =====================================================================
// Small vector / quaternion / matrix helpers (plain arrays, column-major 4x4)
// =====================================================================

const finite = value => typeof value === "number" && Number.isFinite(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = a => Math.hypot(a[0], a[1], a[2]);
function normalize(a) {
    const l = len(a);
    return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

function qmul(a, b) {
    return [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
}
const qconj = q => [-q[0], -q[1], -q[2], q[3]];
function qnormalize(q) {
    const l = Math.hypot(q[0], q[1], q[2], q[3]);
    return l > 1e-12 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [0, 0, 0, 1];
}
/** Rotation vector (axis * angle) to quaternion. */
function qexp(v) {
    const angle = len(v);
    if (angle < 1e-12) return [v[0] / 2, v[1] / 2, v[2] / 2, 1];
    const s = Math.sin(angle / 2) / angle;
    return [v[0] * s, v[1] * s, v[2] * s, Math.cos(angle / 2)];
}
/** Quaternion to rotation vector (shortest arc). */
function qlog(q) {
    let [x, y, z, w] = q;
    if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
    const s = Math.hypot(x, y, z);
    if (s < 1e-12) return [2 * x, 2 * y, 2 * z];
    const angle = 2 * Math.atan2(s, w);
    return [x / s * angle, y / s * angle, z / s * angle];
}
function qrotate(q, v) {
    const u = [q[0], q[1], q[2]];
    const t = cross(u, v).map(value => value * 2);
    const c = cross(u, t);
    return [v[0] + q[3] * t[0] + c[0], v[1] + q[3] * t[1] + c[1], v[2] + q[3] * t[2] + c[2]];
}
/** Three.js Euler order XYZ (degrees or radians) to quaternion. */
export function eulerXYZToQuaternion(x, y, z) {
    const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
    const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
    return [
        s1 * c2 * c3 + c1 * s2 * s3,
        c1 * s2 * c3 - s1 * c2 * s3,
        c1 * c2 * s3 + s1 * s2 * c3,
        c1 * c2 * c3 - s1 * s2 * s3,
    ];
}

function composeMatrix(p, q, s) {
    const [x, y, z, w] = q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    return [
        (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
        (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
        (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
        p[0], p[1], p[2], 1,
    ];
}
function multiplyMatrices(a, b) {
    const out = new Array(16);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
        }
    }
    return out;
}
function transformPoint(m, p) {
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    const iw = Math.abs(w) > 1e-15 ? 1 / w : 1;
    return [
        (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) * iw,
        (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) * iw,
        (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]) * iw,
    ];
}
const linearMul = (m, v) => [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
];
/** Inverse of the upper-left 3x3 block, returned as a column-major 4x4 linear map. */
function linearInverse(m) {
    const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (!finite(det) || Math.abs(det) < 1e-18) return null;
    const inv = 1 / det;
    return [
        A * inv, B * inv, C * inv, 0,
        -(b * i - c * h) * inv, (a * i - c * g) * inv, -(a * h - b * g) * inv, 0,
        (b * f - c * e) * inv, -(a * f - c * d) * inv, (a * e - b * d) * inv, 0,
        0, 0, 0, 1,
    ];
}
function invertMatrix(m) {
    const inv = new Array(16);
    inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
    inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
    inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
    inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
    inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
    inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
    inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
    inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
    inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
    inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
    inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
    inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
    inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
    inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
    inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
    inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
    const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
    if (!finite(det) || Math.abs(det) < 1e-24) return null;
    return inv.map(value => value / det);
}

// =====================================================================
// Frame coordinates and the capture-camera projector
// =====================================================================

/**
 * Convert a pixel of a source image (OpenPose canvas, reference image) into
 * normalized output-frame coordinates (u, v in [0, 1], top-left origin).
 * `stretch` matches how the Pose Studio background plane fills the capture
 * frame; `contain` letterboxes and `cover` crops the source around the center.
 */
export function sourcePixelToFrame(x, y, source, frame, fit = "stretch") {
    const sw = Math.max(1e-9, Number(source?.width) || 0);
    const sh = Math.max(1e-9, Number(source?.height) || 0);
    if (fit !== "contain" && fit !== "cover") return { u: x / sw, v: y / sh };
    const fw = Math.max(1e-9, Number(frame?.width) || sw);
    const fh = Math.max(1e-9, Number(frame?.height) || sh);
    const scale = fit === "contain" ? Math.min(fw / sw, fh / sh) : Math.max(fw / sw, fh / sh);
    return {
        u: (x * scale + (fw - sw * scale) / 2) / fw,
        v: (y * scale + (fh - sh * scale) / 2) / fh,
    };
}

export function frameToPixel(u, v, frame) {
    return { x: u * frame.width, y: v * frame.height };
}

export function pixelToFrame(x, y, frame) {
    return { u: x / frame.width, v: y / frame.height };
}

/**
 * Build a projector from camera matrices (Three.js column-major `.elements`).
 * The projector reproduces `Vector3.project(camera)` followed by the output
 * frame pixel mapping, and provides the analytic derivative d(pixel)/d(world).
 */
export function createFrameProjector({ viewMatrix, projectionMatrix, cameraMatrixWorld = null, width, height }) {
    if (!Array.isArray(viewMatrix) && !ArrayBuffer.isView(viewMatrix)) throw new TypeError("viewMatrix is required");
    if (!Array.isArray(projectionMatrix) && !ArrayBuffer.isView(projectionMatrix)) throw new TypeError("projectionMatrix is required");
    const m = multiplyMatrices(Array.from(projectionMatrix), Array.from(viewMatrix));
    const W = Math.max(1, Number(width) || 1);
    const H = Math.max(1, Number(height) || 1);
    const world = cameraMatrixWorld ? Array.from(cameraMatrixWorld) : invertMatrix(Array.from(viewMatrix));
    const position = world ? [world[12], world[13], world[14]] : [0, 0, 0];
    const forward = world ? normalize([-world[8], -world[9], -world[10]]) : [0, 0, -1];
    const inverse = invertMatrix(m);
    const project = (p, withJacobian = false) => {
        const cx = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
        const cy = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
        const cw = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
        const valid = finite(cw) && cw > 1e-9;
        const iw = valid ? 1 / cw : 0;
        const result = {
            x: (cx * iw + 1) * 0.5 * W,
            y: (1 - cy * iw) * 0.5 * H,
            depth: dot(sub(p, position), forward),
            valid,
        };
        if (withJacobian && valid) {
            const iw2 = iw * iw;
            result.dx = [0, 1, 2].map(k => 0.5 * W * (m[k * 4] * cw - cx * m[k * 4 + 3]) * iw2);
            result.dy = [0, 1, 2].map(k => -0.5 * H * (m[k * 4 + 1] * cw - cy * m[k * 4 + 3]) * iw2);
        }
        return result;
    };
    /** World-space ray through an output-frame pixel. */
    const ray = (x, y) => {
        if (!inverse) return null;
        const nx = x / W * 2 - 1, ny = 1 - y / H * 2;
        const near = transformPoint(inverse, [nx, ny, -1]);
        const far = transformPoint(inverse, [nx, ny, 1]);
        return { origin: near, direction: normalize(sub(far, near)) };
    };
    return { width: W, height: H, position, forward, project, ray };
}

// =====================================================================
// Rig model and forward kinematics
// =====================================================================

function jointSpecFor(name) {
    return POSE_FITTING_JOINTS[name] || null;
}

const mirrorVector = v => [-v[0], v[1], v[2]];

/**
 * Build the fitting model from a rig snapshot.
 * snapshot = { base: number[16], bones: [{ name, parent, position, quaternion, scale, restQuaternion }],
 *              pointOffsets: { [markerId]: [x, y, z] } }
 */
export function buildFittingModel(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.bones) || !snapshot.bones.length) throw new TypeError("Rig snapshot has no bones");
    const base = Array.from(snapshot.base || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const index = new Map();
    const bones = snapshot.bones.map((source, i) => {
        index.set(source.name, i);
        return {
            name: source.name,
            parentName: source.parent || null,
            position: [0, 1, 2].map(k => Number(source.position?.[k]) || 0),
            quaternion: qnormalize([0, 1, 2, 3].map(k => Number(source.quaternion?.[k] ?? (k === 3 ? 1 : 0)))),
            scale: [0, 1, 2].map(k => finite(Number(source.scale?.[k])) ? Number(source.scale[k]) : 1),
            rest: qnormalize([0, 1, 2, 3].map(k => Number(source.restQuaternion?.[k] ?? (k === 3 ? 1 : 0)))),
        };
    });
    for (const bone of bones) {
        bone.parent = index.has(bone.parentName) ? index.get(bone.parentName) : -1;
        if (bone.parent >= index.get(bone.name)) throw new TypeError(`Rig bones must be ordered parents first (${bone.name})`);
        bone.mirror = /_r$/.test(bone.name);
        bone.children = [];
    }
    bones.forEach((bone, i) => { if (bone.parent >= 0) bones[bone.parent].children.push(i); });
    // Joint geometry derived from the rig's own rest offsets.
    for (const bone of bones) {
        const spec = jointSpecFor(bone.name);
        bone.spec = spec;
        if (!spec) continue;
        const child = spec.child && index.has(spec.child) ? bones[index.get(spec.child)] : null;
        const childDir = child ? normalize(qrotate(bone.rest, child.position)) : null;
        if (spec.type === "ball") {
            bone.restDir = childDir && len(childDir) > 0 ? childDir : normalize(spec.axis || [0, 1, 0]);
        } else if (spec.type === "hinge") {
            const upper = normalize(bone.position);
            const lower = childDir || upper;
            const side = spec.flexSide === "back" ? [0, 0, -1] : [0, 0, 1];
            let axis = cross(upper, lower);
            if (len(axis) < 0.05) axis = spec.flexSide === "back" ? [1, 0, 0] : cross(upper, side);
            axis = normalize(axis);
            if (dot(cross(axis, upper), side) < 0) axis = axis.map(value => -value);
            bone.upperDir = upper;
            bone.childRest = child ? child.position.slice() : upper.slice();
            bone.hingeAxis = axis;
        }
    }
    const pointOffsets = snapshot.pointOffsets || {};
    const markers = POSE_FITTING_MARKERS.map(def => {
        const boneIndex = index.has(def.bone) ? index.get(def.bone) : -1;
        const offset = Array.isArray(pointOffsets[def.id]) ? pointOffsets[def.id].slice(0, 3).map(Number) : null;
        let fallback = [0, 0, 0];
        if (def.id === "head" && boneIndex >= 0) {
            const neckLength = len(bones[boneIndex].position) || 1;
            fallback = [0, neckLength, 1.1 * neckLength];
        }
        return {
            id: def.id,
            bone: boneIndex,
            offset: offset && offset.every(finite) ? offset : fallback,
            parent: def.parent ? MARKER_INDEX.get(def.parent) : -1,
        };
    });
    return { base, bones, index, markers };
}

/** Clone the mutable part of a model (local rotations and positions). */
function stateFromModel(model) {
    return {
        quaternions: model.bones.map(bone => bone.quaternion.slice()),
        positions: model.bones.map(bone => bone.position.slice()),
        hinge: model.bones.map(() => 0),
    };
}
function cloneState(state) {
    return {
        quaternions: state.quaternions.map(q => q.slice()),
        positions: state.positions.map(p => p.slice()),
        hinge: state.hinge.slice(),
    };
}

/** Forward kinematics: world matrices for every model bone. */
export function forwardKinematics(model, state = null) {
    const quaternions = state ? state.quaternions : model.bones.map(bone => bone.quaternion);
    const positions = state ? state.positions : model.bones.map(bone => bone.position);
    const world = new Array(model.bones.length);
    for (let i = 0; i < model.bones.length; i++) {
        const bone = model.bones[i];
        const local = composeMatrix(positions[i], quaternions[i], bone.scale);
        world[i] = multiplyMatrices(bone.parent >= 0 ? world[bone.parent] : model.base, local);
    }
    return world;
}

function markerPoints(model, world) {
    return model.markers.map(marker => marker.bone >= 0 ? transformPoint(world[marker.bone], marker.offset) : null);
}

/** Project every marker joint of the current (or given) rig state. */
export function projectFittingJoints(model, projector, state = null) {
    const world = forwardKinematics(model, state);
    const points = markerPoints(model, world);
    const out = {};
    POSE_FITTING_MARKERS.forEach((def, i) => {
        if (!points[i]) return;
        const projected = projector.project(points[i]);
        out[def.id] = { x: projected.x, y: projected.y, depth: projected.depth, valid: projected.valid, world: points[i] };
    });
    return out;
}

// =====================================================================
// Joint limits
// =====================================================================

function ballLimitValues(bone, q) {
    let qrel = qmul(q, qconj(bone.rest));
    let d = bone.restDir;
    if (bone.mirror) {
        qrel = [qrel[0], -qrel[1], -qrel[2], qrel[3]];
        d = mirrorVector(d);
    }
    if (qrel[3] < 0) qrel = qrel.map(value => -value);
    const projection = qrel[0] * d[0] + qrel[1] * d[1] + qrel[2] * d[2];
    const twist = qnormalize([d[0] * projection, d[1] * projection, d[2] * projection, qrel[3]]);
    let twistAngle = 2 * Math.atan2(projection, qrel[3]);
    if (twistAngle > Math.PI) twistAngle -= 2 * Math.PI;
    const swing = qlog(qmul(qrel, qconj(twist)));
    return { x: swing[0] * RAD, y: swing[1] * RAD, z: swing[2] * RAD, twist: twistAngle * RAD };
}

function hingeFlex(bone, q) {
    const c = qrotate(q, bone.childRest);
    return Math.atan2(dot(cross(bone.upperDir, c), bone.hingeAxis), dot(bone.upperDir, c)) * RAD;
}

const LIMIT_KEYS = ["x", "y", "z", "twist"];

/** Violations (degrees beyond range) for one joint, fixed length per joint type. */
function jointViolations(bone, q) {
    const spec = bone.spec;
    if (!spec) return [];
    if (spec.type === "hinge") {
        const flex = hingeFlex(bone, q);
        return [Math.max(0, spec.flex[0] - flex) + Math.max(0, flex - spec.flex[1])];
    }
    if (!spec.limits) return [];
    const values = ballLimitValues(bone, q);
    return LIMIT_KEYS.map(key => {
        const range = spec.limits[key];
        if (!range) return 0;
        return Math.max(0, range[0] - values[key]) + Math.max(0, values[key] - range[1]);
    });
}

/** Report joint angles and limit violations for diagnostics and tests. */
export function measureJointLimits(model, state = null) {
    const report = {};
    let maxViolation = 0;
    model.bones.forEach((bone, i) => {
        if (!bone.spec) return;
        const q = state ? state.quaternions[i] : bone.quaternion;
        const violations = jointViolations(bone, q);
        const violation = violations.reduce((max, value) => Math.max(max, value), 0);
        maxViolation = Math.max(maxViolation, violation);
        report[bone.name] = bone.spec.type === "hinge"
            ? { flex: hingeFlex(bone, q), violation }
            : { ...ballLimitValues(bone, q), violation };
    });
    return { joints: report, maxViolation };
}

// =====================================================================
// Degrees of freedom
// =====================================================================

/**
 * Choose optimized DOFs. Only joints that move at least one enabled marker are
 * optimized; everything else is fixed. Returns [{ bone, kind, axis }].
 */
function buildDofs(model, activeMarkers, settings) {
    const scope = settings.scope === "body" ? "body" : "limbs";
    const allowed = settings.bones ? new Set(settings.bones) : null;
    const relevant = new Set();
    for (const marker of activeMarkers) {
        let bone = model.markers[marker.index].bone;
        // A joint position depends on its ancestors; the head marker (nose
        // offset) also depends on the head bone itself.
        const includeSelf = len(model.markers[marker.index].offset) > 1e-9;
        if (!includeSelf && bone >= 0) bone = model.bones[bone].parent;
        while (bone >= 0) { relevant.add(bone); bone = model.bones[bone].parent; }
    }
    const dofs = [];
    model.bones.forEach((bone, i) => {
        const spec = bone.spec;
        if (!spec || !relevant.has(i)) return;
        if (allowed ? !allowed.has(bone.name) : (spec.scope === "body" && scope !== "body")) return;
        if (spec.type === "hinge") {
            dofs.push({ bone: i, kind: "hinge", axis: bone.hingeAxis });
        } else {
            for (let c = 0; c < 3; c++) dofs.push({ bone: i, kind: "rot", axis: [0, 1, 2].map(k => (k === c ? 1 : 0)), component: c });
        }
        if (spec.translation && settings.moveRoot && (allowed ? allowed.has(bone.name) : scope === "body")) {
            for (let c = 0; c < 3; c++) dofs.push({ bone: i, kind: "trans", axis: [0, 1, 2].map(k => (k === c ? 1 : 0)), component: c });
        }
    });
    return dofs;
}

function isAncestorOrSelf(model, ancestor, bone) {
    while (bone >= 0) {
        if (bone === ancestor) return true;
        bone = model.bones[bone].parent;
    }
    return false;
}

function applyStep(model, dofs, state, delta) {
    const next = cloneState(state);
    const rotations = new Map();
    dofs.forEach((dof, k) => {
        const value = delta[k];
        if (!value) return;
        if (dof.kind === "trans") {
            next.positions[dof.bone][dof.component] += value;
        } else if (dof.kind === "hinge") {
            next.quaternions[dof.bone] = qnormalize(qmul(qexp(dof.axis.map(a => a * value)), next.quaternions[dof.bone]));
            next.hinge[dof.bone] += value;
        } else {
            const vector = rotations.get(dof.bone) || [0, 0, 0];
            vector[dof.component] += value;
            rotations.set(dof.bone, vector);
        }
    });
    for (const [bone, vector] of rotations) {
        next.quaternions[bone] = qnormalize(qmul(qexp(vector), next.quaternions[bone]));
    }
    return next;
}

// =====================================================================
// Residuals and Jacobian
// =====================================================================

function buildProblem(model, projector, markers, options) {
    const settings = { ...POSE_FITTING_DEFAULTS, ...options };
    const active = [];
    for (const marker of markers || []) {
        const index = MARKER_INDEX.get(marker.id);
        if (index === undefined || model.markers[index].bone < 0) continue;
        if (marker.enabled === false) continue;
        const x = Number(marker.x), y = Number(marker.y);
        if (!finite(x) || !finite(y)) continue;
        let weight = finite(Number(marker.weight)) ? Math.max(0, Number(marker.weight)) : 1;
        const confidence = finite(Number(marker.confidence)) ? clamp(Number(marker.confidence), 0, 1) : 1;
        weight *= confidence;
        if (marker.pinned) weight *= settings.pinFactor;
        if (marker.dragging) weight *= settings.dragFactor;
        if (weight <= 0) continue;
        active.push({ id: marker.id, index, x, y, weight, depth: POSE_FITTING_DEPTH_HINTS.includes(marker.depth) ? marker.depth : "auto" });
    }
    const dofs = buildDofs(model, active, settings);
    return { settings, active, dofs };
}

function evaluate(model, projector, problem, state, anchor, wantJacobian) {
    const { settings, active, dofs } = problem;
    const n = dofs.length;
    const world = forwardKinematics(model, state);
    const points = markerPoints(model, world);
    const rows = [];
    const residual = [];
    const push = (value, row) => { residual.push(value); if (wantJacobian) rows.push(row || new Float64Array(n)); };

    // dP/d(dof) for every marker point, computed lazily.
    const derivative = new Map();
    const pointDerivative = (markerIndex) => {
        if (derivative.has(markerIndex)) return derivative.get(markerIndex);
        const markerBone = model.markers[markerIndex].bone;
        const point = points[markerIndex];
        const columns = dofs.map(dof => {
            if (!isAncestorOrSelf(model, dof.bone, markerBone)) return null;
            const bone = model.bones[dof.bone];
            const parentWorld = bone.parent >= 0 ? world[bone.parent] : model.base;
            if (dof.kind === "trans") return linearMul(parentWorld, dof.axis);
            const boneWorld = world[dof.bone];
            const pivot = [boneWorld[12], boneWorld[13], boneWorld[14]];
            const inverse = linearInverse(parentWorld);
            if (!inverse) return null;
            const local = linearMul(inverse, sub(point, pivot));
            return linearMul(parentWorld, cross(dof.axis, local));
        });
        derivative.set(markerIndex, columns);
        return columns;
    };

    const markerResults = [];
    for (const marker of active) {
        const point = points[marker.index];
        const projected = projector.project(point, wantJacobian);
        const sw = Math.sqrt(marker.weight);
        if (!projected.valid) {
            markerResults.push({ id: marker.id, valid: false });
            continue;
        }
        markerResults.push({ id: marker.id, valid: true, x: projected.x, y: projected.y, depth: projected.depth });
        let rowX = null, rowY = null;
        if (wantJacobian) {
            rowX = new Float64Array(n); rowY = new Float64Array(n);
            const columns = pointDerivative(marker.index);
            columns.forEach((g, k) => {
                if (!g) return;
                rowX[k] = sw * dot(projected.dx, g);
                rowY[k] = sw * dot(projected.dy, g);
            });
        }
        push(sw * (projected.x - marker.x), rowX);
        push(sw * (projected.y - marker.y), rowY);
    }

    // Depth / bend hints: joint nearer ("near") or farther ("far") than its parent joint.
    const sqrtDepth = Math.sqrt(settings.depthWeight);
    for (const marker of active) {
        if (marker.depth === "auto") continue;
        const parentIndex = model.markers[marker.index].parent;
        if (parentIndex < 0 || !points[parentIndex]) continue;
        const forward = projector.forward;
        const delta = dot(sub(points[marker.index], points[parentIndex]), forward);
        const margin = 0.1 * len(sub(points[marker.index], points[parentIndex]));
        const sign = marker.depth === "near" ? 1 : -1;
        const violation = Math.max(0, sign * delta + margin);
        let row = null;
        if (wantJacobian) {
            row = new Float64Array(n);
            if (violation > 0) {
                const a = pointDerivative(marker.index), b = pointDerivative(parentIndex);
                for (let k = 0; k < n; k++) {
                    const ga = a[k] ? dot(forward, a[k]) : 0;
                    const gb = b[k] ? dot(forward, b[k]) : 0;
                    row[k] = sqrtDepth * sign * (ga - gb);
                }
            }
        }
        push(sqrtDepth * violation, row);
    }

    // Pose prior relative to the anchor pose.
    const stiffness = Math.max(0, settings.poseStiffness);
    const seenBones = new Set();
    dofs.forEach((dof, k) => {
        const bone = model.bones[dof.bone];
        if (dof.kind === "trans") {
            const s = Math.sqrt(settings.rootStiffness);
            const row = wantJacobian ? new Float64Array(n) : null;
            if (row) row[k] = s;
            push(s * (state.positions[dof.bone][dof.component] - anchor.positions[dof.bone][dof.component]), row);
            return;
        }
        const s = Math.sqrt(stiffness * (bone.spec.prior || 1));
        if (dof.kind === "hinge") {
            const row = wantJacobian ? new Float64Array(n) : null;
            if (row) row[k] = s;
            push(s * (state.hinge[dof.bone] - anchor.hinge[dof.bone]), row);
            return;
        }
        if (seenBones.has(dof.bone)) return;
        seenBones.add(dof.bone);
        const deviation = qlog(qmul(state.quaternions[dof.bone], qconj(anchor.quaternions[dof.bone])));
        for (let c = 0; c < 3; c++) {
            const row = wantJacobian ? new Float64Array(n) : null;
            if (row) row[k + c] = s;
            push(s * deviation[c], row);
        }
    });
    // Root depth is weakly observable from 2D markers: keep it close to the anchor.
    const translationDofs = dofs.map((dof, k) => [dof, k]).filter(([dof]) => dof.kind === "trans");
    if (translationDofs.length) {
        const bone = translationDofs[0][0].bone;
        const parentWorld = model.bones[bone].parent >= 0 ? world[model.bones[bone].parent] : model.base;
        const s = Math.sqrt(settings.rootDepthStiffness);
        const shift = sub(state.positions[bone], anchor.positions[bone]);
        const row = wantJacobian ? new Float64Array(n) : null;
        if (row) for (const [dof, k] of translationDofs) row[k] = s * dot(projector.forward, linearMul(parentWorld, dof.axis));
        push(s * dot(projector.forward, linearMul(parentWorld, shift)), row);
    }

    // Joint limits (soft but strong). Derivatives by forward differences.
    const sqrtLimit = Math.sqrt(settings.limitWeight);
    const limitBones = [...new Set(dofs.filter(dof => dof.kind !== "trans").map(dof => dof.bone))];
    let maxViolation = 0;
    for (const boneIndex of limitBones) {
        const bone = model.bones[boneIndex];
        const q = state.quaternions[boneIndex];
        const base = jointViolations(bone, q);
        if (!base.length) continue;
        base.forEach(value => { maxViolation = Math.max(maxViolation, value); });
        let derivatives = null;
        if (wantJacobian && base.some(value => value > 0)) {
            const eps = 1e-5;
            derivatives = dofs.map((dof, k) => {
                if (dof.bone !== boneIndex || dof.kind === "trans") return null;
                const perturbed = jointViolations(bone, qnormalize(qmul(qexp(dof.axis.map(a => a * eps)), q)));
                return { k, values: perturbed.map((value, c) => (value - base[c]) / eps) };
            }).filter(Boolean);
        }
        base.forEach((value, c) => {
            let row = null;
            if (wantJacobian) {
                row = new Float64Array(n);
                if (derivatives && value > 0) for (const entry of derivatives) row[entry.k] = sqrtLimit * entry.values[c];
            }
            push(sqrtLimit * value, row);
        });
    }

    let energy = 0;
    for (const value of residual) energy += value * value;
    return { residual, rows, energy, markerResults, maxViolation, points };
}

/** Solve a symmetric positive (semi)definite system with Cholesky + jitter. */
function solveSymmetric(A, b, n) {
    for (let attempt = 0; attempt < 6; attempt++) {
        const jitter = attempt === 0 ? 0 : 1e-9 * Math.pow(100, attempt);
        const L = new Float64Array(n * n);
        let ok = true;
        for (let i = 0; i < n && ok; i++) {
            for (let j = 0; j <= i; j++) {
                let sum = A[i * n + j] + (i === j ? jitter : 0);
                for (let k = 0; k < j; k++) sum -= L[i * n + k] * L[j * n + k];
                if (i === j) {
                    if (!(sum > 1e-300) || !finite(sum)) { ok = false; break; }
                    L[i * n + i] = Math.sqrt(sum);
                } else {
                    L[i * n + j] = sum / L[j * n + j];
                }
            }
        }
        if (!ok) continue;
        const y = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            let sum = b[i];
            for (let k = 0; k < i; k++) sum -= L[i * n + k] * y[k];
            y[i] = sum / L[i * n + i];
        }
        const x = new Float64Array(n);
        for (let i = n - 1; i >= 0; i--) {
            let sum = y[i];
            for (let k = i + 1; k < n; k++) sum -= L[k * n + i] * x[k];
            x[i] = sum / L[i * n + i];
        }
        if (x.every(finite)) return x;
    }
    return null;
}

function normalEquations(rows, residual, n) {
    const A = new Float64Array(n * n);
    const g = new Float64Array(n);
    for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        const value = residual[r];
        for (let i = 0; i < n; i++) {
            const ri = row[i];
            if (!ri) continue;
            g[i] += ri * value;
            for (let j = 0; j <= i; j++) A[i * n + j] += ri * row[j];
        }
    }
    for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) A[j * n + i] = A[i * n + j];
    return { A, g };
}

function clampStep(dofs, delta, settings) {
    let scale = 1;
    dofs.forEach((dof, k) => {
        const limit = dof.kind === "trans" ? settings.maxTranslationStep : settings.maxRotationStep;
        const magnitude = Math.abs(delta[k]);
        if (magnitude > limit) scale = Math.min(scale, limit / magnitude);
    });
    if (scale < 1) for (let k = 0; k < delta.length; k++) delta[k] *= scale;
    return delta;
}

const now = () => (typeof performance !== "undefined" && performance?.now ? performance.now() : Date.now());

function stateIsValid(state) {
    return state.quaternions.every(q => q.every(finite) && Math.abs(Math.hypot(...q) - 1) < 1e-6)
        && state.positions.every(p => p.every(finite));
}

/**
 * Fit the rig to the markers.
 *
 * markers: [{ id, x, y (output pixels), enabled, pinned, weight, confidence, depth, dragging }]
 * options: { method: "lm" | "dls" | "jt", maxIterations, scope, moveRoot, bones, anchor,
 *            poseStiffness, damping, tolerance, timeBudgetMs }
 * Returns a result with the optimized state (not applied), per-marker residuals,
 * and convergence statistics. The input model is never mutated.
 */
export function solvePoseFitting(model, projector, markers, options = {}) {
    const started = now();
    const problem = buildProblem(model, projector, markers, options);
    const { settings, dofs } = problem;
    const method = ["lm", "dls", "jt"].includes(options.method) ? options.method : "lm";
    const maxIterations = Math.max(0, Math.floor(options.maxIterations ?? 30));
    const tolerance = options.tolerance ?? 1e-9;
    const timeBudget = finite(options.timeBudgetMs) ? options.timeBudgetMs : Infinity;
    const initial = options.initialState ? cloneState(options.initialState) : stateFromModel(model);
    const anchor = options.anchor ? options.anchor : stateFromModel(model);
    let state = initial;
    let current = evaluate(model, projector, problem, state, anchor, true);
    const initialEnergy = current.energy;
    const history = [current.energy];
    let mu = finite(options.damping) ? options.damping : 1e-3;
    let iterations = 0;
    let converged = dofs.length === 0 || problem.active.length === 0;
    let reason = converged ? "no-constraints" : "max-iterations";
    const n = dofs.length;

    while (!converged && iterations < maxIterations) {
        if (now() - started > timeBudget) { reason = "time-budget"; break; }
        iterations++;
        const { A, g } = normalEquations(current.rows, current.residual, n);
        let accepted = false;
        let candidate = null;
        let step = null;
        if (method === "jt") {
            // Jacobian transpose with the Buss step length: alpha = |g|^2 / |J g|^2.
            let gg = 0, jgjg = 0;
            for (let i = 0; i < n; i++) gg += g[i] * g[i];
            for (const row of current.rows) {
                let value = 0;
                for (let i = 0; i < n; i++) value += row[i] * g[i];
                jgjg += value * value;
            }
            const alpha = jgjg > 1e-30 ? gg / jgjg : 0;
            step = clampStep(dofs, Array.from(g, value => -alpha * value), settings);
            candidate = evaluate(model, projector, problem, applyStep(model, dofs, state, step), anchor, true);
            accepted = finite(candidate.energy);
        } else if (method === "dls") {
            const lambda2 = finite(options.damping) ? options.damping : 1;
            const M = A.slice();
            for (let i = 0; i < n; i++) M[i * n + i] += lambda2;
            const solved = solveSymmetric(M, Array.from(g, value => -value), n);
            if (!solved) { reason = "singular"; break; }
            step = clampStep(dofs, Array.from(solved), settings);
            candidate = evaluate(model, projector, problem, applyStep(model, dofs, state, step), anchor, true);
            accepted = finite(candidate.energy);
        } else {
            let maxDiagonal = 0;
            for (let i = 0; i < n; i++) maxDiagonal = Math.max(maxDiagonal, A[i * n + i]);
            const floor = Math.max(1e-9, maxDiagonal * 1e-9);
            for (let attempt = 0; attempt < 12; attempt++) {
                const M = A.slice();
                for (let i = 0; i < n; i++) M[i * n + i] += mu * Math.max(A[i * n + i], floor);
                const solved = solveSymmetric(M, Array.from(g, value => -value), n);
                if (solved) {
                    step = clampStep(dofs, Array.from(solved), settings);
                    candidate = evaluate(model, projector, problem, applyStep(model, dofs, state, step), anchor, true);
                    if (finite(candidate.energy) && candidate.energy <= current.energy) {
                        accepted = true;
                        mu = Math.max(1e-9, mu / 3);
                        break;
                    }
                }
                mu = Math.min(1e10, mu * 5);
            }
            if (!accepted) { converged = true; reason = "stationary"; break; }
        }
        if (!accepted || !candidate) { reason = "invalid-step"; break; }
        const previousEnergy = current.energy;
        state = applyStep(model, dofs, state, step);
        current = candidate;
        history.push(current.energy);
        const maxStep = step.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
        if (maxStep < 1e-7) { converged = true; reason = "small-step"; }
        else if (Math.abs(previousEnergy - current.energy) <= tolerance * Math.max(1, previousEnergy)) { converged = true; reason = "small-decrease"; }
    }

    // Hinges are hard limits: soft penalties may leave a fraction of a degree
    // of hyperextension, which is projected back onto the valid range here.
    const projected = projectHingeLimits(model, state);
    if (projected !== state) {
        state = projected;
        current = evaluate(model, projector, problem, state, anchor, false);
    }
    const valid = stateIsValid(state) && finite(current.energy);
    const final = valid ? current : evaluate(model, projector, problem, initial, anchor, false);
    const errors = final.markerResults.map(result => {
        const target = problem.active.find(marker => marker.id === result.id);
        if (!result.valid) return { id: result.id, valid: false, error: Infinity, target: { x: target.x, y: target.y } };
        return {
            id: result.id,
            valid: true,
            error: Math.hypot(result.x - target.x, result.y - target.y),
            projected: { x: result.x, y: result.y },
            target: { x: target.x, y: target.y },
            weight: target.weight,
        };
    });
    const finiteErrors = errors.filter(item => item.valid).map(item => item.error);
    return {
        valid,
        method,
        state: valid ? state : initial,
        iterations,
        converged,
        reason: valid ? reason : "invalid-result",
        energy: final.energy,
        initialEnergy,
        energyHistory: history,
        markers: errors,
        maxError: finiteErrors.length ? Math.max(...finiteErrors) : 0,
        meanError: finiteErrors.length ? finiteErrors.reduce((sum, value) => sum + value, 0) / finiteErrors.length : 0,
        unreached: errors.filter(item => !item.valid || item.error > settings.unreachedPx).map(item => item.id),
        maxLimitViolation: final.maxViolation,
        dofs: dofs.map(dof => ({ bone: model.bones[dof.bone].name, kind: dof.kind, component: dof.component ?? null })),
        durationMs: now() - started,
    };
}

function projectHingeLimits(model, state) {
    let next = state;
    model.bones.forEach((bone, i) => {
        if (bone.spec?.type !== "hinge") return;
        const flex = hingeFlex(bone, next.quaternions[i]);
        const target = clamp(flex, bone.spec.flex[0], bone.spec.flex[1]);
        if (Math.abs(target - flex) < 1e-9) return;
        if (next === state) next = cloneState(state);
        const angle = (target - flex) * DEG;
        next.quaternions[i] = qnormalize(qmul(qexp(bone.hingeAxis.map(value => value * angle)), next.quaternions[i]));
        next.hinge[i] += angle;
    });
    return next;
}

/** Bones whose local rotation or position differs between two states. */
export function changedBones(model, state, reference = null) {
    const base = reference || stateFromModel(model);
    const changed = [];
    model.bones.forEach((bone, i) => {
        const q = state.quaternions[i], r = base.quaternions[i];
        const p = state.positions[i], s = base.positions[i];
        const dq = Math.abs(q[0] * r[0] + q[1] * r[1] + q[2] * r[2] + q[3] * r[3]);
        if (dq < 1 - 1e-14 || p.some((value, k) => Math.abs(value - s[k]) > 1e-12)) changed.push(bone.name);
    });
    return changed;
}

/** Current model state, usable as an explicit anchor or warm start. */
export function captureFittingState(model) {
    return stateFromModel(model);
}

// =====================================================================
// Depth flip: mirror one rigid segment across the camera ray
// =====================================================================

function rotateBoneWorld(model, state, world, boneIndex, worldRotation) {
    const bone = model.bones[boneIndex];
    const parentWorld = bone.parent >= 0 ? world[bone.parent] : model.base;
    const inverse = linearInverse(parentWorld);
    if (!inverse) return false;
    // Express the world rotation axis in the parent frame (similarity transforms).
    const vector = qlog(worldRotation);
    const angle = len(vector);
    if (angle < 1e-12) return true;
    const axis = normalize(linearMul(inverse, vector.map(value => value / angle)));
    state.quaternions[boneIndex] = qnormalize(qmul(qexp(axis.map(value => value * angle)), state.quaternions[boneIndex]));
    return true;
}

function arcBetween(from, to) {
    const a = normalize(from), b = normalize(to);
    const axis = cross(a, b);
    const s = len(axis);
    const angle = Math.atan2(s, dot(a, b));
    if (s < 1e-12) return [0, 0, 0, 1];
    return qexp(axis.map(value => value / s * angle));
}

/**
 * Flip the depth of a marker's segment while keeping its 2D projection: the
 * joint moves to the other intersection of its camera ray with the sphere
 * around the parent joint. Ball segments rotate directly; hinge segments
 * (forearm, shin) twist the parent bone about its own axis and re-bend the
 * hinge so the limb stays anatomically valid. Returns a new state, or null
 * when there is no single segment or the mirrored pose would break joint
 * limits (for example a forearm that could only point backwards through a
 * ~180 degree humeral twist) unless `allowViolation` is set.
 */
export function flipMarkerDepth(model, projector, markerId, state = null, { allowViolation = false, toleranceDeg = 5 } = {}) {
    const markerIndex = MARKER_INDEX.get(markerId);
    const def = POSE_FITTING_MARKERS[markerIndex];
    if (!def?.flip || !model.index.has(def.flip)) return null;
    const next = state ? cloneState(state) : stateFromModel(model);
    const segmentBone = model.index.get(def.flip);
    const world = forwardKinematics(model, next);
    const points = markerPoints(model, world);
    const joint = points[markerIndex];
    const pivotWorld = world[segmentBone];
    const pivot = [pivotWorld[12], pivotWorld[13], pivotWorld[14]];
    const projected = projector.project(joint);
    const ray = projected.valid ? projector.ray(projected.x, projected.y) : null;
    if (!ray) return null;
    const radius = len(sub(joint, pivot));
    const oc = sub(ray.origin, pivot);
    const b = dot(oc, ray.direction);
    const c = dot(oc, oc) - radius * radius;
    const discriminant = b * b - c;
    if (discriminant < 0) return null;
    const root = Math.sqrt(discriminant);
    const t1 = -b - root, t2 = -b + root;
    const p1 = ray.origin.map((value, k) => value + ray.direction[k] * t1);
    const p2 = ray.origin.map((value, k) => value + ray.direction[k] * t2);
    const target = len(sub(p1, joint)) > len(sub(p2, joint)) ? p1 : p2;
    if (len(sub(target, joint)) < 1e-6 * Math.max(1, radius)) return null;
    const bone = model.bones[segmentBone];
    if (bone.spec?.type === "hinge") {
        // Twist the parent (upper arm / thigh) about its axis, then re-bend.
        const parentIndex = bone.parent;
        if (parentIndex < 0) return null;
        const parentPivot = [world[parentIndex][12], world[parentIndex][13], world[parentIndex][14]];
        const upper = normalize(sub(pivot, parentPivot));
        const currentDir = normalize(sub(joint, pivot));
        const targetDir = normalize(sub(target, pivot));
        const project = v => normalize(sub(v, upper.map(value => value * dot(v, upper))));
        const a = project(currentDir), t = project(targetDir);
        const twistAngle = Math.atan2(dot(cross(a, t), upper), dot(a, t));
        if (len(a) > 1e-6 && len(t) > 1e-6) {
            rotateBoneWorld(model, next, world, parentIndex, qexp(upper.map(value => value * twistAngle)));
        }
        const flexBefore = Math.acos(clamp(dot(upper, currentDir), -1, 1));
        const flexAfter = Math.acos(clamp(dot(upper, targetDir), -1, 1));
        const deltaFlex = flexAfter - flexBefore;
        next.quaternions[segmentBone] = qnormalize(qmul(qexp(bone.hingeAxis.map(value => value * deltaFlex)), next.quaternions[segmentBone]));
        next.hinge[segmentBone] += deltaFlex;
    } else {
        rotateBoneWorld(model, next, world, segmentBone, arcBetween(sub(joint, pivot), sub(target, pivot)));
    }
    if (!stateIsValid(next)) return null;
    if (!allowViolation) {
        const before = measureJointLimits(model, state).maxViolation;
        if (measureJointLimits(model, next).maxViolation > before + toleranceDeg) return null;
    }
    return next;
}

/** Depth relation of a marker's joint to its parent joint in the given state. */
export function markerDepthRelation(model, projector, markerId, state = null) {
    const index = MARKER_INDEX.get(markerId);
    const parent = index === undefined ? -1 : model.markers[index].parent;
    if (parent < 0) return "auto";
    const points = markerPoints(model, forwardKinematics(model, state));
    return dot(sub(points[index], points[parent]), projector.forward) < 0 ? "near" : "far";
}

// =====================================================================
// Persistent constraint state (per character, per pose)
// =====================================================================

export function defaultFittingSettings() {
    return { scope: "limbs", moveRoot: false, stiffness: 1, showMarkers: true, autoRefit: false };
}

export function defaultFittingMarker() {
    return { u: null, v: null, enabled: false, pinned: false, weight: 1, confidence: 1, depth: "auto" };
}

export function createFittingState() {
    const markers = {};
    for (const id of POSE_FITTING_MARKER_IDS) markers[id] = defaultFittingMarker();
    return { version: POSE_FITTING_VERSION, markers, settings: defaultFittingSettings(), frame: null, source: null };
}

function normalizeNumber(value, fallback, min, max) {
    const number = Number(value);
    return value !== null && value !== "" && Number.isFinite(number) ? clamp(number, min, max) : fallback;
}

/**
 * Validate stored fitting data. Unknown keys are dropped, numbers are clamped,
 * and missing markers get defaults. Returns null when nothing usable remains.
 */
export function normalizeFittingState(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const state = createFittingState();
    const markers = raw.markers && typeof raw.markers === "object" ? raw.markers : {};
    let usable = false;
    for (const id of POSE_FITTING_MARKER_IDS) {
        const source = markers[id];
        if (!source || typeof source !== "object") continue;
        const u = normalizeNumber(source.u, null, -2, 3);
        const v = normalizeNumber(source.v, null, -2, 3);
        const hasPoint = u !== null && v !== null;
        state.markers[id] = {
            u: hasPoint ? u : null,
            v: hasPoint ? v : null,
            enabled: hasPoint && source.enabled !== false,
            pinned: source.pinned === true,
            weight: normalizeNumber(source.weight, 1, 0, 10),
            confidence: normalizeNumber(source.confidence, 1, 0, 1),
            depth: POSE_FITTING_DEPTH_HINTS.includes(source.depth) ? source.depth : "auto",
        };
        if (hasPoint) usable = true;
    }
    const settings = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
    state.settings = {
        scope: POSE_FITTING_SCOPES.includes(settings.scope) ? settings.scope : "limbs",
        moveRoot: settings.moveRoot === true,
        stiffness: normalizeNumber(settings.stiffness, 1, 0.05, 20),
        showMarkers: settings.showMarkers !== false,
        autoRefit: settings.autoRefit === true,
    };
    const frame = raw.frame;
    if (frame && Number(frame.width) > 0 && Number(frame.height) > 0) {
        state.frame = { width: Math.round(Number(frame.width)), height: Math.round(Number(frame.height)) };
    }
    const source = raw.source;
    if (source && typeof source === "object") {
        state.source = {
            type: String(source.type || "manual").slice(0, 32),
            width: normalizeNumber(source.width, null, 1, 65536),
            height: normalizeNumber(source.height, null, 1, 65536),
            format: source.format ? String(source.format).slice(0, 32) : null,
        };
    }
    return usable ? state : null;
}

export function cloneFittingState(state) {
    return state ? JSON.parse(JSON.stringify(state)) : null;
}

/** Solver marker list from stored state (normalized coordinates -> frame pixels). */
export function fittingStateToSolverMarkers(state, frame, extra = {}) {
    if (!state?.markers) return [];
    return POSE_FITTING_MARKER_IDS.map(id => {
        const marker = state.markers[id];
        if (!marker || marker.u === null || marker.v === null) return null;
        return {
            id,
            x: marker.u * frame.width,
            y: marker.v * frame.height,
            enabled: marker.enabled,
            pinned: marker.pinned,
            weight: marker.weight,
            confidence: marker.confidence,
            depth: marker.depth,
            dragging: extra.dragging === id,
        };
    }).filter(Boolean);
}

/** Set marker targets from projected joints (all markers, or only unpinned). */
export function resetFittingTargets(state, projected, frame, { keepPinned = true, enable = true } = {}) {
    const next = cloneFittingState(state) || createFittingState();
    for (const id of POSE_FITTING_MARKER_IDS) {
        const point = projected[id];
        const marker = next.markers[id];
        if (!point || !point.valid || (keepPinned && marker.pinned && marker.u !== null)) continue;
        marker.u = point.x / frame.width;
        marker.v = point.y / frame.height;
        marker.confidence = 1;
        if (enable) marker.enabled = true;
    }
    next.frame = { width: Math.round(frame.width), height: Math.round(frame.height) };
    return next;
}

// =====================================================================
// OpenPose import
// =====================================================================

/**
 * Create marker targets from parsed OpenPose keypoints (`detectAndParseJSON`
 * output: { joints: { name: { x, y, c } }, canvasWidth, canvasHeight }).
 * Missing (c <= minConfidence or a 0,0 placeholder) keypoints stay disabled
 * without coordinates; the caller may fill them from the current projection.
 */
export function fittingStateFromOpenPose(parsed, { frame, fit = "stretch", minConfidence = 0.05, previous = null } = {}) {
    if (!parsed?.joints || typeof parsed.joints !== "object") return null;
    const canvas = { width: Number(parsed.canvasWidth) || 512, height: Number(parsed.canvasHeight) || 512 };
    const joints = parsed.joints;
    const points = Object.values(joints).filter(point => point && finite(point.x) && finite(point.y) && (point.c ?? 1) > minConfidence);
    const normalized = points.length > 0 && points.every(point => Math.abs(point.x) <= 1.5 && Math.abs(point.y) <= 1.5)
        && canvas.width > 2 && canvas.height > 2;
    const next = createFittingState();
    if (previous?.settings) next.settings = { ...next.settings, ...previous.settings };
    const warnings = [];
    let found = 0;
    for (const def of POSE_FITTING_MARKERS) {
        let point = joints[def.openpose];
        if ((!point || !(point.c > minConfidence)) && def.id === "neck"
            && joints.l_shoulder?.c > minConfidence && joints.r_shoulder?.c > minConfidence) {
            point = {
                x: (joints.l_shoulder.x + joints.r_shoulder.x) / 2,
                y: (joints.l_shoulder.y + joints.r_shoulder.y) / 2,
                c: Math.min(joints.l_shoulder.c, joints.r_shoulder.c),
            };
        }
        const confidence = point && finite(point.c) ? point.c : (point ? 1 : 0);
        const missing = !point || !finite(point.x) || !finite(point.y) || confidence <= minConfidence
            || (point.x === 0 && point.y === 0);
        if (missing) continue;
        const x = normalized ? point.x * canvas.width : point.x;
        const y = normalized ? point.y * canvas.height : point.y;
        const { u, v } = sourcePixelToFrame(x, y, canvas, frame, fit);
        next.markers[def.id] = { ...defaultFittingMarker(), u, v, enabled: true, confidence: clamp(confidence, 0, 1) };
        found++;
    }
    if (!found) return null;
    const sourceAspect = canvas.width / canvas.height;
    const frameAspect = frame ? frame.width / frame.height : sourceAspect;
    if (fit === "stretch" && Math.abs(sourceAspect - frameAspect) > 0.01 * frameAspect) {
        warnings.push(`OpenPose canvas ${canvas.width}x${canvas.height} has a different aspect than the output frame ${frame.width}x${frame.height}; markers are stretched like the background image.`);
    }
    next.frame = frame ? { width: Math.round(frame.width), height: Math.round(frame.height) } : null;
    next.source = {
        type: String(parsed.source || "openpose"),
        width: canvas.width,
        height: canvas.height,
        format: parsed.format || null,
    };
    return { state: next, found, warnings, normalized };
}

// =====================================================================
// Viewer bridge (duck-typed Three.js objects, no import)
// =====================================================================

/** Snapshot the active viewer rig for the solver. */
export function snapshotViewerRig(viewer, pointOffsets = {}) {
    const bones = viewer?.bones;
    if (!bones?.pelvis) return null;
    viewer.skinnedMesh?.updateMatrixWorld?.(true);
    const base = bones.pelvis.parent?.matrixWorld?.elements || viewer.skinnedMesh?.matrixWorld?.elements;
    if (!base) return null;
    const snapshot = { base: Array.from(base), bones: [], pointOffsets };
    for (const name of POSE_FITTING_RIG_BONES) {
        const bone = bones[name];
        if (!bone) continue;
        const parentName = bone.parent?.name && POSE_FITTING_RIG_BONES.includes(bone.parent.name) ? bone.parent.name : null;
        const rest = viewer.initialBoneStates?.[name]?.rotation;
        snapshot.bones.push({
            name,
            parent: parentName,
            position: [bone.position.x, bone.position.y, bone.position.z],
            quaternion: [bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w],
            scale: [bone.scale.x, bone.scale.y, bone.scale.z],
            restQuaternion: rest ? eulerXYZToQuaternion(rest.x || 0, rest.y || 0, rest.z || 0) : [0, 0, 0, 1],
        });
    }
    return snapshot;
}

/** Projector for the viewer's capture camera and output frame size. */
export function captureCameraProjector(camera, width, height) {
    if (!camera?.matrixWorldInverse || !camera.projectionMatrix) return null;
    camera.updateMatrixWorld?.(true);
    return createFrameProjector({
        viewMatrix: camera.matrixWorldInverse.elements,
        projectionMatrix: camera.projectionMatrix.elements,
        cameraMatrixWorld: camera.matrixWorld?.elements || null,
        width,
        height,
    });
}

/** Write an optimized state back to the viewer bones. */
export function applyFittingStateToViewer(viewer, model, state) {
    if (!viewer?.bones || !stateIsValid(state)) return false;
    model.bones.forEach((source, i) => {
        const bone = viewer.bones[source.name];
        if (!bone) return;
        const q = state.quaternions[i];
        bone.quaternion.set(q[0], q[1], q[2], q[3]);
        const p = state.positions[i];
        bone.position.set(p[0], p[1], p[2]);
    });
    viewer.skinnedMesh?.updateMatrixWorld?.(true);
    viewer.skeleton?.update?.();
    return true;
}
