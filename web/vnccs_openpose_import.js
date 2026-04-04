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
    { parent: "neck",       child: "r_shoulder", mhBone: "clavicle_r" },
    { parent: "r_shoulder", child: "r_elbow",    mhBone: "upperarm_r", parentSegment: { parent: "neck", child: "r_shoulder" } },
    { parent: "r_elbow",    child: "r_wrist",    mhBone: "lowerarm_r", parentSegment: { parent: "r_shoulder", child: "r_elbow" } },

    // Left arm
    { parent: "neck",       child: "l_shoulder", mhBone: "clavicle_l" },
    { parent: "l_shoulder", child: "l_elbow",    mhBone: "upperarm_l", parentSegment: { parent: "neck", child: "l_shoulder" } },
    { parent: "l_elbow",    child: "l_wrist",    mhBone: "lowerarm_l", parentSegment: { parent: "l_shoulder", child: "l_elbow" } },

    // Right leg
    { parent: "r_hip",  child: "r_knee",  mhBone: "thigh_r" },
    { parent: "r_knee", child: "r_ankle", mhBone: "calf_r", parentSegment: { parent: "r_hip", child: "r_knee" } },

    // Left leg
    { parent: "l_hip",  child: "l_knee",  mhBone: "thigh_l" },
    { parent: "l_knee", child: "l_ankle", mhBone: "calf_l", parentSegment: { parent: "l_hip", child: "l_knee" } },
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
    "clavicle_r": "upperarm_r",
    "upperarm_r": "lowerarm_r",
    "lowerarm_r": "hand_r",
    "thigh_l":    "calf_l",
    "calf_l":     "foot_l",
    "thigh_r":    "calf_r",
    "calf_r":     "foot_r",
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

    console.log(`[OpenPose Import] Detected ${numKeypoints} keypoints → ${nameMap === BODY25_NAMES ? "BODY_25" : "COCO-18"} format`);
    return { joints, canvasWidth, canvasHeight };
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
    // In OpenPose image: r_hip is on the LEFT side of image (mirrored).
    // In MakeHuman: X+ is right. So l_hip→r_hip goes left-to-right in MH space,
    // which is right-to-left in image space (l_hip has LARGER x in image).
    // We measure tilt as deviation from horizontal.
    if (joints.l_hip && joints.r_hip &&
        joints.l_hip.c >= CONFIDENCE_THRESHOLD && joints.r_hip.c >= CONFIDENCE_THRESHOLD) {
        // l_hip→r_hip in image, with Y-flip
        const dx = joints.l_hip.x - joints.r_hip.x; // positive when level (l_hip.x > r_hip.x in image)
        const dy = -(joints.l_hip.y - joints.r_hip.y);
        const hipAngle = Math.atan2(dy, dx) * RAD2DEG;
        // Rest pose hip line is at 0° (horizontal). Only apply if significant.
        if (Math.abs(hipAngle) > 2) {
            modelRotation[2] = hipAngle;
        }
    }

    // --- Process each segment ---
    for (const seg of SEGMENT_TO_BONE) {
        // Spine is handled separately
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
            // Relative angle: compute delta relative to parent segment
            const parentOpAngle = _opAngle(joints, seg.parentSegment.parent, seg.parentSegment.child);
            if (parentOpAngle === null) continue;

            // Find parent MH bone for rest angle
            // The parent segment maps to a bone — find it
            const parentBone = _findMhBoneForSegment(seg.parentSegment);
            const parentRestAngle = parentBone ? _restAngle(viewer, parentBone) : null;
            if (parentRestAngle === null) continue;

            const relativeOp = _normalizeAngle(opAngle - parentOpAngle);
            const relativeRest = _normalizeAngle(restAngle - parentRestAngle);
            delta = _normalizeAngle(relativeOp - relativeRest);
        } else {
            // Absolute angle
            delta = _normalizeAngle(opAngle - restAngle);
        }

        bones[seg.mhBone] = [0, 0, delta * RAD2DEG];
    }

    // --- Head tilt from eye line ---
    // In OpenPose image: r_eye (subject's right) has SMALLER x than l_eye.
    // For a level head we need angle ≈ 0°.
    // Measure l_eye → r_eye direction: since l_eye.x > r_eye.x in image,
    // going from larger X to smaller X gives negative dx → ~180°.
    // So we use r_eye → l_eye (smaller to larger X) → positive dx → ~0° for level.
    if (joints.l_eye && joints.r_eye &&
        joints.l_eye.c >= CONFIDENCE_THRESHOLD && joints.r_eye.c >= CONFIDENCE_THRESHOLD) {
        const dx = joints.l_eye.x - joints.r_eye.x;   // positive when level
        const dy = -(joints.l_eye.y - joints.r_eye.y); // Y-flip
        const eyeAngle = Math.atan2(dy, dx) * RAD2DEG;
        // Rest pose: eyes are horizontal (0°). Only apply if significant tilt.
        if (Math.abs(eyeAngle) > 2) {
            bones["head"] = [0, 0, eyeAngle];
        }
    }

    return { bones, modelRotation };
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
