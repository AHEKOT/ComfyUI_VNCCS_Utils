/**
 * OpenPose Import Module
 *
 * Parses OpenPose data (JSON or image) and converts 2D keypoints
 * to MakeHuman bone rotations for Pose Studio.
 */

// =====================================================================
// Keypoint index → internal name mappings
// =====================================================================

// COCO-18 format (used by DWPreprocessor, controlnet_aux default)
// NO mid_hip — computed from l_hip + r_hip
const COCO18_NAMES = [
    "nose",         // 0
    "neck",         // 1
    "r_shoulder",   // 2
    "r_elbow",      // 3
    "r_wrist",      // 4
    "l_shoulder",   // 5
    "l_elbow",      // 6
    "l_wrist",      // 7
    "r_hip",        // 8
    "r_knee",       // 9
    "r_ankle",      // 10
    "l_hip",        // 11
    "l_knee",       // 12
    "l_ankle",      // 13
    "r_eye",        // 14
    "l_eye",        // 15
    "r_ear",        // 16
    "l_ear",        // 17
];

// BODY_25 format (OpenPose native, has mid_hip at index 8)
const BODY25_NAMES = [
    "nose",         // 0
    "neck",         // 1
    "r_shoulder",   // 2
    "r_elbow",      // 3
    "r_wrist",      // 4
    "l_shoulder",   // 5
    "l_elbow",      // 6
    "l_wrist",      // 7
    "mid_hip",      // 8
    "r_hip",        // 9
    "r_knee",       // 10
    "r_ankle",      // 11
    "l_hip",        // 12
    "l_knee",       // 13
    "l_ankle",      // 14
    "r_eye",        // 15
    "l_eye",        // 16
    "r_ear",        // 17
    "l_ear",        // 18
    // 19-24: foot keypoints (ignored)
];

// =====================================================================
// OpenPose joint color palette (RGB) for image parsing
// Matches bone_colors.py JOINT_COLORS
// =====================================================================
const JOINT_COLORS_RGB = {
    nose:       [0, 0, 255],
    neck:       [0, 0, 255],       // Same as nose — disambiguate by Y
    r_shoulder: [255, 85, 0],
    r_elbow:    [255, 170, 0],
    r_wrist:    [255, 255, 0],
    l_shoulder: [85, 255, 0],
    l_elbow:    [0, 255, 0],
    l_wrist:    [0, 255, 85],
    r_hip:      [0, 255, 170],
    r_knee:     [85, 255, 0],      // Note: same as l_shoulder — disambiguate by Y
    r_ankle:    [0, 255, 0],       // Note: same as l_elbow — disambiguate by Y
    l_hip:      [0, 85, 255],
    l_knee:     [0, 255, 255],
    l_ankle:    [0, 170, 255],
    r_eye:      [170, 0, 255],
    l_eye:      [170, 0, 255],     // Same as r_eye — disambiguate by X
    r_ear:      [255, 0, 170],
    l_ear:      [255, 0, 170],     // Same as r_ear — disambiguate by X
};

// Unique colors for detection (group joints that share colors)
const COLOR_GROUPS = [
    { color: [0, 0, 255],     joints: ["nose", "neck"],         disambiguate: "y" },      // nose above neck
    { color: [255, 85, 0],    joints: ["r_shoulder"],           disambiguate: null },
    { color: [255, 170, 0],   joints: ["r_elbow"],              disambiguate: null },
    { color: [255, 255, 0],   joints: ["r_wrist"],              disambiguate: null },
    { color: [85, 255, 0],    joints: ["l_shoulder", "r_knee"], disambiguate: "y" },       // shoulder above knee
    { color: [0, 255, 0],     joints: ["l_elbow", "r_ankle"],   disambiguate: "y" },       // elbow above ankle
    { color: [0, 255, 85],    joints: ["l_wrist"],              disambiguate: null },
    { color: [0, 255, 170],   joints: ["r_hip"],                disambiguate: null },
    { color: [0, 85, 255],    joints: ["l_hip"],                disambiguate: null },
    { color: [0, 255, 255],   joints: ["l_knee"],               disambiguate: null },
    { color: [0, 170, 255],   joints: ["l_ankle"],              disambiguate: null },
    { color: [170, 0, 255],   joints: ["r_eye", "l_eye"],       disambiguate: "x" },       // r_eye has larger X (right side of image)
    { color: [255, 0, 170],   joints: ["r_ear", "l_ear"],       disambiguate: "x" },       // r_ear has larger X
];

// =====================================================================
// OpenPose segment → MakeHuman bone mapping
// =====================================================================
const SEGMENT_TO_BONE = [
    // { parent, child } are OpenPose joint names
    // mhBone is the MakeHuman bone whose Z-rotation we set
    // isRelative: if true, compute angle relative to parent segment
    // parentSegment: the parent segment for relative computation

    // Spine (split across 3 bones)
    { parent: "mid_hip", child: "neck", mhBones: ["spine_01", "spine_02", "spine_03"], isSpine: true },

    // Neck & Head
    { parent: "neck", child: "nose", mhBone: "neck_01", parentSegment: { parent: "mid_hip", child: "neck" } },

    // Right arm
    { parent: "neck",       child: "r_shoulder", mhBone: "clavicle_r",  parentSegment: { parent: "mid_hip", child: "neck" } },
    { parent: "r_shoulder", child: "r_elbow",    mhBone: "upperarm_r",  parentSegment: { parent: "neck", child: "r_shoulder" } },
    { parent: "r_elbow",    child: "r_wrist",    mhBone: "lowerarm_r",  parentSegment: { parent: "r_shoulder", child: "r_elbow" } },

    // Left arm
    { parent: "neck",       child: "l_shoulder", mhBone: "clavicle_l",  parentSegment: { parent: "mid_hip", child: "neck" } },
    { parent: "l_shoulder", child: "l_elbow",    mhBone: "upperarm_l",  parentSegment: { parent: "neck", child: "l_shoulder" } },
    { parent: "l_elbow",    child: "l_wrist",    mhBone: "lowerarm_l",  parentSegment: { parent: "l_shoulder", child: "l_elbow" } },

    // Right leg
    { parent: "r_hip",  child: "r_knee",  mhBone: "thigh_r",  parentSegment: { parent: "mid_hip", child: "neck" } },
    { parent: "r_knee", child: "r_ankle", mhBone: "calf_r",   parentSegment: { parent: "r_hip", child: "r_knee" } },

    // Left leg
    { parent: "l_hip",  child: "l_knee",  mhBone: "thigh_l",  parentSegment: { parent: "mid_hip", child: "neck" } },
    { parent: "l_knee", child: "l_ankle", mhBone: "calf_l",   parentSegment: { parent: "l_hip", child: "l_knee" } },
];

// MakeHuman bone → which child bone defines its "tail" direction
// Used to compute rest-pose angles
const MH_BONE_CHILD = {
    "spine_01":   "spine_02",
    "spine_02":   "spine_03",
    "spine_03":   "neck_01",
    "neck_01":    "head",
    "head":       null,           // Use tail from mhskel
    "clavicle_l": "upperarm_l",
    "upperarm_l": "lowerarm_l",
    "lowerarm_l": "hand_l",
    "hand_l":     "middle_01_l",  // Wrist→finger base for hand direction
    "clavicle_r": "upperarm_r",
    "upperarm_r": "lowerarm_r",
    "lowerarm_r": "hand_r",
    "hand_r":     "middle_01_r",
    "thigh_l":    "calf_l",
    "calf_l":     "foot_l",
    "thigh_r":    "calf_r",
    "calf_r":     "foot_r",
    // Fingers - left
    "thumb_01_l":  "thumb_02_l",
    "thumb_02_l":  "thumb_03_l",
    "thumb_03_l":  null,
    "index_01_l":  "index_02_l",
    "index_02_l":  "index_03_l",
    "index_03_l":  null,
    "middle_01_l": "middle_02_l",
    "middle_02_l": "middle_03_l",
    "middle_03_l": null,
    "ring_01_l":   "ring_02_l",
    "ring_02_l":   "ring_03_l",
    "ring_03_l":   null,
    "pinky_01_l":  "pinky_02_l",
    "pinky_02_l":  "pinky_03_l",
    "pinky_03_l":  null,
    // Fingers - right
    "thumb_01_r":  "thumb_02_r",
    "thumb_02_r":  "thumb_03_r",
    "thumb_03_r":  null,
    "index_01_r":  "index_02_r",
    "index_02_r":  "index_03_r",
    "index_03_r":  null,
    "middle_01_r": "middle_02_r",
    "middle_02_r": "middle_03_r",
    "middle_03_r": null,
    "ring_01_r":   "ring_02_r",
    "ring_02_r":   "ring_03_r",
    "ring_03_r":   null,
    "pinky_01_r":  "pinky_02_r",
    "pinky_02_r":  "pinky_03_r",
    "pinky_03_r":  null,
};


// =====================================================================
// 1. PARSERS
// =====================================================================

/**
 * Parse POSE_KEYPOINT JSON format (from DWPreprocessor / comfyui_controlnet_aux).
 * Auto-detects COCO-18 vs BODY_25 by keypoint count.
 * Input: {people: [{pose_keypoints_2d: [x0,y0,c0,...]}], canvas_width, canvas_height}
 * Returns: {joints: {name: {x, y, c}}, canvasWidth, canvasHeight}
 */
export function parseOpenPoseJSON(data) {
    const people = data.people || [];
    if (people.length === 0) return null;

    const person = people[0];
    const kp = person.pose_keypoints_2d;
    if (!kp || kp.length < 17 * 3) return null;

    const canvasWidth = data.canvas_width || 512;
    const canvasHeight = data.canvas_height || 512;

    const numKeypoints = Math.floor(kp.length / 3);

    // Auto-detect format: BODY_25 has 25 kp (or 19+ with mid_hip at index 8)
    // COCO-18 has 18 kp (no mid_hip, hips start at index 8)
    const nameMap = numKeypoints >= 25 ? BODY25_NAMES :
                    numKeypoints >= 19 ? BODY25_NAMES :  // 19+ = likely BODY_25 subset
                    COCO18_NAMES;                         // 18 or 17 = COCO

    const joints = {};
    const usableKeypoints = Math.min(numKeypoints, nameMap.length);

    for (let i = 0; i < usableKeypoints; i++) {
        const name = nameMap[i];
        joints[name] = {
            x: kp[i * 3],
            y: kp[i * 3 + 1],
            c: kp[i * 3 + 2],
        };
    }

    // Compute mid_hip from l_hip + r_hip if not present
    if (!joints.mid_hip && joints.l_hip && joints.r_hip &&
        joints.l_hip.c > 0.1 && joints.r_hip.c > 0.1) {
        joints.mid_hip = {
            x: (joints.l_hip.x + joints.r_hip.x) / 2,
            y: (joints.l_hip.y + joints.r_hip.y) / 2,
            c: Math.min(joints.l_hip.c, joints.r_hip.c),
        };
    }

    // Parse hand keypoints (21 per hand)
    const handLeft = _parseHandKeypoints(person.hand_left_keypoints_2d);
    const handRight = _parseHandKeypoints(person.hand_right_keypoints_2d);

    // Parse face keypoints (70 points)
    const face = _parseFaceKeypoints(person.face_keypoints_2d);

    console.log(`[OpenPose Import] Detected ${numKeypoints} body keypoints → ${nameMap === BODY25_NAMES ? "BODY_25" : "COCO-18"} format` +
        `${handLeft ? ", left hand" : ""}${handRight ? ", right hand" : ""}${face ? ", face" : ""}`);
    return { joints, handLeft, handRight, face, canvasWidth, canvasHeight };
}

/**
 * Parse 21-point hand keypoints.
 * Returns array of {x, y, c} indexed 0-20, or null.
 */
function _parseHandKeypoints(kp) {
    if (!kp || kp.length < 21 * 3) return null;
    const points = [];
    for (let i = 0; i < 21; i++) {
        points.push({ x: kp[i * 3], y: kp[i * 3 + 1], c: kp[i * 3 + 2] });
    }
    // Check if hand is actually detected (not all zeros)
    const hasData = points.some(p => p.c > 0.1);
    return hasData ? points : null;
}

/**
 * Parse 70-point face keypoints.
 * Returns array of {x, y, c} indexed 0-69, or null.
 */
function _parseFaceKeypoints(kp) {
    if (!kp || kp.length < 68 * 3) return null;
    const points = [];
    const numPoints = Math.floor(kp.length / 3);
    for (let i = 0; i < numPoints; i++) {
        points.push({ x: kp[i * 3], y: kp[i * 3 + 1], c: kp[i * 3 + 2] });
    }
    const hasData = points.some(p => p.c > 0.1);
    return hasData ? points : null;
}

/**
 * Parse VNCCS skeleton JSON format.
 * Input: {joints: {name: [x, y]}, canvas: {width, height}}
 */
export function parseVNCCSSkeletonJSON(data) {
    const rawJoints = data.joints || {};
    const canvas = data.canvas || { width: 512, height: 1536 };

    const joints = {};
    for (const [name, pos] of Object.entries(rawJoints)) {
        joints[name] = {
            x: pos[0],
            y: pos[1],
            c: 1.0,
        };
    }

    // Compute mid_hip if missing
    if (!joints.mid_hip && joints.l_hip && joints.r_hip) {
        joints.mid_hip = {
            x: (joints.l_hip.x + joints.r_hip.x) / 2,
            y: (joints.l_hip.y + joints.r_hip.y) / 2,
            c: 1.0,
        };
    }

    return { joints, canvasWidth: canvas.width, canvasHeight: canvas.height };
}

/**
 * Extract keypoints from an OpenPose image by color matching.
 * Returns: {joints, canvasWidth, canvasHeight} or null if detection fails.
 */
export function extractKeypointsFromImage(img) {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data; // RGBA flat array
    const w = canvas.width;
    const h = canvas.height;

    const COLOR_TOLERANCE = 30;
    const joints = {};

    for (const group of COLOR_GROUPS) {
        const [tr, tg, tb] = group.color;

        // Collect all matching pixels
        const matches = [];
        for (let i = 0; i < pixels.length; i += 4) {
            const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
            if (Math.abs(r - tr) <= COLOR_TOLERANCE &&
                Math.abs(g - tg) <= COLOR_TOLERANCE &&
                Math.abs(b - tb) <= COLOR_TOLERANCE) {
                const px = (i / 4) % w;
                const py = Math.floor((i / 4) / w);
                matches.push({ x: px, y: py });
            }
        }

        if (matches.length === 0) continue;

        if (group.joints.length === 1) {
            // Single joint — compute centroid
            const centroid = _computeCentroid(matches);
            joints[group.joints[0]] = { x: centroid.x, y: centroid.y, c: 1.0 };
        } else {
            // Multiple joints share this color — cluster and disambiguate
            const clusters = _clusterPoints(matches, Math.max(w, h) * 0.15);

            if (clusters.length === 0) continue;

            // Sort clusters by disambiguation axis
            if (group.disambiguate === "y") {
                clusters.sort((a, b) => a.y - b.y); // top first (smaller Y = higher)
            } else if (group.disambiguate === "x") {
                clusters.sort((a, b) => b.x - a.x); // right first (larger X)
            }

            for (let i = 0; i < Math.min(clusters.length, group.joints.length); i++) {
                joints[group.joints[i]] = { x: clusters[i].x, y: clusters[i].y, c: 1.0 };
            }
        }
    }

    // Need at least 5 joints to be useful
    const detectedCount = Object.keys(joints).length;
    if (detectedCount < 5) return null;

    // Compute mid_hip if missing
    if (!joints.mid_hip && joints.l_hip && joints.r_hip) {
        joints.mid_hip = {
            x: (joints.l_hip.x + joints.r_hip.x) / 2,
            y: (joints.l_hip.y + joints.r_hip.y) / 2,
            c: 1.0,
        };
    }

    return { joints, canvasWidth: canvas.width, canvasHeight: canvas.height };
}

function _computeCentroid(points) {
    let sx = 0, sy = 0;
    for (const p of points) { sx += p.x; sy += p.y; }
    return { x: sx / points.length, y: sy / points.length };
}

/**
 * Simple distance-based clustering. Returns array of centroids.
 */
function _clusterPoints(points, maxDist) {
    if (points.length === 0) return [];

    const clusters = [];
    const used = new Array(points.length).fill(false);

    for (let i = 0; i < points.length; i++) {
        if (used[i]) continue;

        const cluster = [points[i]];
        used[i] = true;

        for (let j = i + 1; j < points.length; j++) {
            if (used[j]) continue;
            // Check distance to any point in cluster (single-link)
            let close = false;
            for (const cp of cluster) {
                const dx = points[j].x - cp.x;
                const dy = points[j].y - cp.y;
                if (Math.sqrt(dx * dx + dy * dy) < maxDist) {
                    close = true;
                    break;
                }
            }
            if (close) {
                cluster.push(points[j]);
                used[j] = true;
            }
        }

        clusters.push(_computeCentroid(cluster));
    }

    return clusters;
}


// =====================================================================
// Hand keypoint → MakeHuman finger bone mapping
// Hand keypoints: 0=wrist, 1-4=thumb, 5-8=index, 9-12=middle, 13-16=ring, 17-20=pinky
// Each group: [base, MCP, PIP/DIP, tip]
// =====================================================================
const FINGER_SEGMENTS = [
    // { indices: [parent_kp, child_kp], bone_l, bone_r }
    // Thumb
    { parent: 1,  child: 2,  bone_l: "thumb_01_l", bone_r: "thumb_01_r" },
    { parent: 2,  child: 3,  bone_l: "thumb_02_l", bone_r: "thumb_02_r" },
    { parent: 3,  child: 4,  bone_l: "thumb_03_l", bone_r: "thumb_03_r" },
    // Index
    { parent: 5,  child: 6,  bone_l: "index_01_l", bone_r: "index_01_r" },
    { parent: 6,  child: 7,  bone_l: "index_02_l", bone_r: "index_02_r" },
    { parent: 7,  child: 8,  bone_l: "index_03_l", bone_r: "index_03_r" },
    // Middle
    { parent: 9,  child: 10, bone_l: "middle_01_l", bone_r: "middle_01_r" },
    { parent: 10, child: 11, bone_l: "middle_02_l", bone_r: "middle_02_r" },
    { parent: 11, child: 12, bone_l: "middle_03_l", bone_r: "middle_03_r" },
    // Ring
    { parent: 13, child: 14, bone_l: "ring_01_l", bone_r: "ring_01_r" },
    { parent: 14, child: 15, bone_l: "ring_02_l", bone_r: "ring_02_r" },
    { parent: 15, child: 16, bone_l: "ring_03_l", bone_r: "ring_03_r" },
    // Pinky
    { parent: 17, child: 18, bone_l: "pinky_01_l", bone_r: "pinky_01_r" },
    { parent: 18, child: 19, bone_l: "pinky_02_l", bone_r: "pinky_02_r" },
    { parent: 19, child: 20, bone_l: "pinky_03_l", bone_r: "pinky_03_r" },
];

// =====================================================================
// 2. ANGLE MAPPING: 2D keypoints → MakeHuman bone rotations
// =====================================================================

const CONFIDENCE_THRESHOLD = 0.1;
const RAD2DEG = 180 / Math.PI;

/**
 * Get 2D angle of an OpenPose segment in pixel coordinates.
 * Y is flipped (pixel Y↓ → MH Y↑).
 */
function _opAngle(joints, parentName, childName) {
    const p = joints[parentName];
    const c = joints[childName];
    if (!p || !c || p.c < CONFIDENCE_THRESHOLD || c.c < CONFIDENCE_THRESHOLD) return null;
    const dx = c.x - p.x;
    const dy = -(c.y - p.y); // Flip Y
    return Math.atan2(dy, dx);
}

/**
 * Get rest-pose 2D angle for a MakeHuman bone.
 * Uses bone.userData.headPos (frontal projection: X, Y components).
 */
function _restAngle(viewer, boneName) {
    const bone = viewer.bones[boneName];
    if (!bone) return null;
    const headPos = bone.userData.headPos;

    // Find child bone for tail
    const childName = MH_BONE_CHILD[boneName];
    let tailPos;
    if (childName && viewer.bones[childName]) {
        tailPos = viewer.bones[childName].userData.headPos;
    } else {
        // No known child — can't compute direction
        return null;
    }

    const dx = tailPos[0] - headPos[0]; // X
    const dy = tailPos[1] - headPos[1]; // Y (already up in MH)
    return Math.atan2(dy, dx);
}

/**
 * Normalize angle to [-PI, PI]
 */
function _normalizeAngle(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
}

/**
 * Main conversion: OpenPose keypoints → MakeHuman bone rotations.
 *
 * @param {Object} parsed - {joints: {name: {x, y, c}}, canvasWidth, canvasHeight}
 * @param {Object} viewer - PoseViewerCore instance (for rest-pose bone positions)
 * @returns {Object} - {bones: {name: [rx, ry, rz]}, modelRotation: [rx, ry, rz]}
 */
export function convertOpenPoseToPose(parsed, viewer) {
    if (!parsed || !parsed.joints || !viewer || !viewer.bones) return null;

    const joints = parsed.joints;
    const bones = {};
    const modelRotation = [0, 0, 0];

    // --- Pelvis tilt from hip line ---
    // Computes the TILT of the hip line (one hip higher than the other).
    // The hip line may point left-to-right or right-to-left depending on whether
    // the person faces camera or not — we normalize to [-90°, 90°] so that
    // a back-facing or side-facing subject doesn't produce a ~180° flip.
    if (joints.l_hip && joints.r_hip &&
        joints.l_hip.c >= CONFIDENCE_THRESHOLD && joints.r_hip.c >= CONFIDENCE_THRESHOLD) {
        const dx = joints.l_hip.x - joints.r_hip.x;
        const dy = -(joints.l_hip.y - joints.r_hip.y);
        let hipAngle = Math.atan2(dy, dx) * RAD2DEG;
        // Normalize to [-90°, 90°]: tilt only, regardless of facing direction
        if (hipAngle > 90)  hipAngle -= 180;
        if (hipAngle < -90) hipAngle += 180;
        if (Math.abs(hipAngle) > 2) {
            modelRotation[2] = hipAngle;
        }
    }

    // --- Body Y-rotation from shoulder inversion ---
    const bodyYRot = _estimateBodyYRotation(joints);
    const facingAway = Math.abs(bodyYRot) > 90;
    const bodyYRad = bodyYRot * Math.PI / 180;
    console.log("[OpenPose Import] bodyYRot:", bodyYRot, "facingAway:", facingAway);
    if (Math.abs(bodyYRot) > 3) {
        modelRotation[1] = bodyYRot;
    }

    // --- Process each segment ---
    for (const seg of SEGMENT_TO_BONE) {
        if (seg.isSpine) {
            _processSpine(joints, viewer, bones);
            continue;
        }

        const opAngle = _opAngle(joints, seg.parent, seg.child);
        if (opAngle === null) continue;

        const restAngle = _restAngle(viewer, seg.mhBone);
        if (restAngle === null) continue;

        let delta;

        if (seg.parentSegment) {
            const parentOpAngle = _opAngle(joints, seg.parentSegment.parent, seg.parentSegment.child);
            if (parentOpAngle === null) continue;

            const parentBone = _findMhBoneForSegment(seg.parentSegment);
            const parentRestAngle = parentBone ? _restAngle(viewer, parentBone) : null;
            if (parentRestAngle === null) continue;

            const relativeOp = _normalizeAngle(opAngle - parentOpAngle);
            const relativeRest = _normalizeAngle(restAngle - parentRestAngle);
            delta = _normalizeAngle(relativeOp - relativeRest);
        } else {
            delta = _normalizeAngle(opAngle - restAngle);
        }

        const deltaDeg = delta * RAD2DEG;
        // Project 2D image-plane rotation into model-local space
        // When model is rotated by bodyYRot around Y:
        //   bone Z-rotation (frontal plane) = delta * cos(bodyYRot)
        //   bone X-rotation (sagittal plane) = delta * sin(bodyYRot)
        const cosB = Math.cos(bodyYRad);
        const sinB = Math.sin(bodyYRad);
        bones[seg.mhBone] = [deltaDeg * sinB, 0, deltaDeg * cosB];
    }

    // --- Head tilt from eye line (Z-rotation) ---
    if (joints.l_eye && joints.r_eye &&
        joints.l_eye.c >= CONFIDENCE_THRESHOLD && joints.r_eye.c >= CONFIDENCE_THRESHOLD) {
        const dx = joints.l_eye.x - joints.r_eye.x;
        const dy = -(joints.l_eye.y - joints.r_eye.y);
        const eyeAngle = Math.atan2(dy, dx) * RAD2DEG;
        if (Math.abs(eyeAngle) > 2) {
            bones["head"] = [0, 0, eyeAngle];
        }
    }

    // --- Head Y-rotation ---
    if (facingAway) {
        const headRot = bones["head"] || [0, 0, 0];
        headRot[1] = -(180 - bodyYRot);
        bones["head"] = headRot;
    } else if (parsed.face) {
        const headYRot = _estimateHeadYRotation(parsed.face);
        if (Math.abs(headYRot) > 3) {
            const headRot = bones["head"] || [0, 0, 0];
            headRot[1] = headYRot;
            bones["head"] = headRot;
        }
    }

    // --- Finger bones from hand keypoints ---
    if (parsed.handLeft) {
        _processFingers(parsed.handLeft, "l", viewer, bones);
    }
    if (parsed.handRight) {
        _processFingers(parsed.handRight, "r", viewer, bones);
    }

    return { bones, modelRotation, cameraYRotation: bodyYRot };
}

/**
 * Estimate body Y-rotation from shoulder/hip inversion.
 * In OpenPose, "r" and "l" are subject's sides.
 * Facing camera: r_shoulder is LEFT in image (r_shoulder.x < l_shoulder.x).
 * Facing away:   r_shoulder is RIGHT in image (r_shoulder.x > l_shoulder.x).
 * Returns angle in degrees.
 */
function _estimateBodyYRotation(joints) {
    let facingAway = false;
    let noseOffset = 0;

    // Determine facing direction from shoulder inversion
    if (joints.l_shoulder && joints.r_shoulder &&
        joints.l_shoulder.c >= CONFIDENCE_THRESHOLD &&
        joints.r_shoulder.c >= CONFIDENCE_THRESHOLD) {
        // Normal (facing camera): r_shoulder.x < l_shoulder.x
        // Inverted (facing away):  r_shoulder.x > l_shoulder.x
        facingAway = joints.r_shoulder.x > joints.l_shoulder.x;
    }

    // Use nose offset from neck to estimate how much turn
    if (joints.nose && joints.neck &&
        joints.nose.c >= CONFIDENCE_THRESHOLD &&
        joints.neck.c >= CONFIDENCE_THRESHOLD) {
        let scale = 100;
        if (joints.l_shoulder && joints.r_shoulder &&
            joints.l_shoulder.c >= CONFIDENCE_THRESHOLD &&
            joints.r_shoulder.c >= CONFIDENCE_THRESHOLD) {
            scale = Math.abs(joints.l_shoulder.x - joints.r_shoulder.x);
        }
        if (scale > 10) {
            noseOffset = (joints.nose.x - joints.neck.x) / scale;
        }
    }

    if (facingAway) {
        // Base 180° + nose offset refines how much they turned back
        // noseOffset positive = head turned right = less than full 180
        return 180 - noseOffset * 50;
    } else {
        // Facing camera — nose offset gives partial turn
        return noseOffset * 90;
    }
}

/**
 * Estimate head Y-rotation from face keypoints.
 * Uses nose position relative to jaw contour center.
 * Face keypoints: 0-16 = jaw contour, 27-30 = nose bridge, 30 = nose tip.
 */
function _estimateHeadYRotation(face) {
    // Jaw extremes: 0 (right side of face in image) and 16 (left side)
    if (!face[0] || !face[16] || !face[30]) return 0;
    if (face[0].c < CONFIDENCE_THRESHOLD || face[16].c < CONFIDENCE_THRESHOLD || face[30].c < CONFIDENCE_THRESHOLD) return 0;

    const jawWidth = face[16].x - face[0].x;
    if (Math.abs(jawWidth) < 5) return 0;

    const jawCenter = (face[0].x + face[16].x) / 2;
    const noseTip = face[30].x;

    // Offset: how far nose is from jaw center, normalized by jaw width
    const offset = (noseTip - jawCenter) / jawWidth;

    // offset ~0 = facing forward, offset ~0.3-0.5 = 45° turn
    // In image: face[0] is right side (smaller X for subject's right jawline)
    // face[16] is left side (larger X for subject's left jawline)
    // If nose shifts toward larger X → face turned right (from camera POV)
    //   → positive Y rotation in MakeHuman
    return offset * 90;
}

/**
 * Process finger bones from hand keypoints.
 * @param {Array} handKp - 21 keypoints [{x,y,c}, ...]
 * @param {string} side - "l" or "r"
 * @param {Object} viewer - PoseViewerCore
 * @param {Object} bones - output bone rotations dict
 */
function _processFingers(handKp, side, viewer, bones) {
    for (const seg of FINGER_SEGMENTS) {
        const parentKp = handKp[seg.parent];
        const childKp = handKp[seg.child];

        if (!parentKp || !childKp ||
            parentKp.c < CONFIDENCE_THRESHOLD || childKp.c < CONFIDENCE_THRESHOLD) continue;

        const boneName = side === "l" ? seg.bone_l : seg.bone_r;
        if (!viewer.bones[boneName]) continue;

        // 2D angle of this finger segment
        const dx = childKp.x - parentKp.x;
        const dy = -(childKp.y - parentKp.y);
        const opAngle = Math.atan2(dy, dx);

        // Rest angle
        const restAng = _restAngle(viewer, boneName);
        if (restAng === null) continue;

        // For finger child segments, compute relative to parent segment
        let delta;
        if (seg.parent > 1 && seg.parent !== 5 && seg.parent !== 9 &&
            seg.parent !== 13 && seg.parent !== 17) {
            // This is a middle/tip segment — compute relative to previous segment
            const prevParent = handKp[seg.parent - 1];
            if (prevParent && prevParent.c >= CONFIDENCE_THRESHOLD) {
                const prevDx = parentKp.x - prevParent.x;
                const prevDy = -(parentKp.y - prevParent.y);
                const prevAngle = Math.atan2(prevDy, prevDx);

                // Find parent bone rest angle
                const prevBoneName = _findPrevFingerBone(boneName);
                const prevRestAng = prevBoneName ? _restAngle(viewer, prevBoneName) : null;

                if (prevRestAng !== null) {
                    const relOp = _normalizeAngle(opAngle - prevAngle);
                    const relRest = _normalizeAngle(restAng - prevRestAng);
                    delta = _normalizeAngle(relOp - relRest);
                } else {
                    delta = _normalizeAngle(opAngle - restAng);
                }
            } else {
                delta = _normalizeAngle(opAngle - restAng);
            }
        } else {
            // Base segment — use wrist direction as reference
            const wrist = handKp[0];
            if (wrist && wrist.c >= CONFIDENCE_THRESHOLD) {
                const wristDx = parentKp.x - wrist.x;
                const wristDy = -(parentKp.y - wrist.y);
                const wristAngle = Math.atan2(wristDy, wristDx);

                // Use hand bone rest angle as reference
                const handBone = side === "l" ? "hand_l" : "hand_r";
                const handRestAng = _restAngle(viewer, handBone);
                if (handRestAng !== null) {
                    const relOp = _normalizeAngle(opAngle - wristAngle);
                    const relRest = _normalizeAngle(restAng - handRestAng);
                    delta = _normalizeAngle(relOp - relRest);
                } else {
                    delta = _normalizeAngle(opAngle - restAng);
                }
            } else {
                delta = _normalizeAngle(opAngle - restAng);
            }
        }

        const degVal = delta * RAD2DEG;
        // Clamp finger rotations to reasonable range
        if (Math.abs(degVal) < 120) {
            bones[boneName] = [0, 0, degVal];
        }
    }
}

/**
 * Find the previous (parent) finger bone name.
 * e.g., index_02_l → index_01_l, index_03_l → index_02_l
 */
function _findPrevFingerBone(boneName) {
    const match = boneName.match(/^(.+)_(\d+)_([lr])$/);
    if (!match) return null;
    const [, finger, num, side] = match;
    const prevNum = parseInt(num) - 1;
    if (prevNum < 1) return null;
    return `${finger}_0${prevNum}_${side}`;
}

/**
 * Process spine: split the neck→mid_hip angle across 3 spine bones.
 */
function _processSpine(joints, viewer, bones) {
    const opAngle = _opAngle(joints, "mid_hip", "neck");
    if (opAngle === null) return;

    // Rest angle of full spine chain: from spine_01 head to neck_01 head
    const spine01 = viewer.bones["spine_01"];
    const neck01 = viewer.bones["neck_01"];
    if (!spine01 || !neck01) return;

    const s1Head = spine01.userData.headPos;
    const neckHead = neck01.userData.headPos;

    const dx = neckHead[0] - s1Head[0];
    const dy = neckHead[1] - s1Head[1];
    const restAngle = Math.atan2(dy, dx);

    const delta = _normalizeAngle(opAngle - restAngle);
    const perBone = (delta * RAD2DEG) / 3;

    bones["spine_01"] = [0, 0, perBone];
    bones["spine_02"] = [0, 0, perBone];
    bones["spine_03"] = [0, 0, perBone];
}

/**
 * Find MakeHuman bone name for a given OpenPose segment.
 */
function _findMhBoneForSegment(seg) {
    for (const s of SEGMENT_TO_BONE) {
        if (s.parent === seg.parent && s.child === seg.child) {
            if (s.isSpine) return "spine_03"; // Top of spine chain
            return s.mhBone;
        }
    }
    return null;
}


// =====================================================================
// 3. AUTO-DETECT format
// =====================================================================

/**
 * Detect and parse OpenPose data from a JSON object.
 * Handles both direct objects and arrays (DWPreprocessor wraps in array).
 * Returns parsed keypoints or null.
 */
/**
 * Round-trip angle test: for each segment, compute the angle from convertOpenPoseToPose,
 * then reconstruct child position from parent position + (restAngle + delta) + segment length.
 * Compare reconstructed position with original keypoint position.
 *
 * @param {Object} parsed - parsed keypoints from parseOpenPoseJSON
 * @param {Object} viewer - PoseViewerCore instance
 * @param {Object} poseResult - result from convertOpenPoseToPose
 */
export function roundTripTest(parsed, viewer, poseResult) {
    if (!parsed || !viewer || !poseResult) return;

    const joints = parsed.joints;
    const bones = poseResult.bones;
    let totalError = 0;
    let count = 0;

    console.log("[RoundTrip] === Angle Round-Trip Test ===");

    for (const seg of SEGMENT_TO_BONE) {
        if (seg.isSpine) continue; // spine splits across 3 bones, skip

        const parentJoint = joints[seg.parent];
        const childJoint = joints[seg.child];
        if (!parentJoint || !childJoint ||
            parentJoint.c < CONFIDENCE_THRESHOLD || childJoint.c < CONFIDENCE_THRESHOLD) continue;

        const boneName = seg.mhBone;
        const boneRot = bones[boneName];
        if (!boneRot) continue;

        const deltaZ = boneRot[2] / RAD2DEG; // back to radians
        const restAng = _restAngle(viewer, boneName);
        if (restAng === null) continue;

        // Original segment
        const origDx = childJoint.x - parentJoint.x;
        const origDy = -(childJoint.y - parentJoint.y); // flip Y
        const segLength = Math.sqrt(origDx * origDx + origDy * origDy);
        const origAngle = Math.atan2(origDy, origDx);

        // Reconstructed angle
        let reconstructedAngle;
        if (seg.parentSegment) {
            // Relative: reconstructedAngle = parentOpAngle + relativeRest + delta
            const parentOpAngle = _opAngle(joints, seg.parentSegment.parent, seg.parentSegment.child);
            const parentBone = _findMhBoneForSegment(seg.parentSegment);
            const parentRestAngle = parentBone ? _restAngle(viewer, parentBone) : null;
            if (parentOpAngle === null || parentRestAngle === null) continue;
            const relativeRest = _normalizeAngle(restAng - parentRestAngle);
            reconstructedAngle = parentOpAngle + relativeRest + deltaZ;
        } else {
            // Absolute: reconstructedAngle = restAngle + delta
            reconstructedAngle = restAng + deltaZ;
        }

        // Reconstruct child position
        const recDx = Math.cos(reconstructedAngle) * segLength;
        const recDy = Math.sin(reconstructedAngle) * segLength;
        const recX = parentJoint.x + recDx;
        const recY = parentJoint.y - recDy; // flip Y back

        const errX = recX - childJoint.x;
        const errY = recY - childJoint.y;
        const err = Math.sqrt(errX * errX + errY * errY);
        totalError += err;
        count++;

        const status = err < 1 ? "OK" : "FAIL";
        console.log(`[RoundTrip] ${status} ${boneName.padEnd(14)} origAngle=${(origAngle * RAD2DEG).toFixed(1)}° reconAngle=${(reconstructedAngle * RAD2DEG).toFixed(1)}° delta=${boneRot[2].toFixed(1)}° err=${err.toFixed(1)}px`);
    }

    if (count > 0) {
        console.log(`[RoundTrip] Average error: ${(totalError / count).toFixed(1)}px across ${count} segments`);
    }
}

export function detectAndParseJSON(data) {
    // DWPreprocessor / controlnet_aux wraps output in an array
    if (Array.isArray(data)) {
        if (data.length > 0) {
            return detectAndParseJSON(data[0]);
        }
        return null;
    }
    // POSE_KEYPOINT format
    if (data.people && Array.isArray(data.people)) {
        return parseOpenPoseJSON(data);
    }
    // VNCCS skeleton format
    if (data.joints && (data.canvas || data.canvas_width)) {
        return parseVNCCSSkeletonJSON(data);
    }
    return null;
}
