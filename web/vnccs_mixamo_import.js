import { IK_CHAINS } from "./vnccs_pose_studio_core.js";

const THREE_VERSION = "0.160.0";

const MIXAMO_TO_MH_BONE_MAP = {
    Hips: 'pelvis',
    Spine: 'spine_01',
    Spine1: 'spine_02',
    Spine2: 'spine_03',
    Neck: 'neck_01',
    Head: 'head',
    LeftShoulder: 'clavicle_l',
    LeftArm: 'upperarm_l',
    LeftForeArm: 'lowerarm_l',
    LeftHand: 'hand_l',
    LeftHandThumb1: 'thumb_01_l',
    LeftHandThumb2: 'thumb_02_l',
    LeftHandThumb3: 'thumb_03_l',
    LeftHandIndex1: 'index_01_l',
    LeftHandIndex2: 'index_02_l',
    LeftHandIndex3: 'index_03_l',
    LeftHandMiddle1: 'middle_01_l',
    LeftHandMiddle2: 'middle_02_l',
    LeftHandMiddle3: 'middle_03_l',
    LeftHandRing1: 'ring_01_l',
    LeftHandRing2: 'ring_02_l',
    LeftHandRing3: 'ring_03_l',
    LeftHandPinky1: 'pinky_01_l',
    LeftHandPinky2: 'pinky_02_l',
    LeftHandPinky3: 'pinky_03_l',
    RightShoulder: 'clavicle_r',
    RightArm: 'upperarm_r',
    RightForeArm: 'lowerarm_r',
    RightHand: 'hand_r',
    RightHandThumb1: 'thumb_01_r',
    RightHandThumb2: 'thumb_02_r',
    RightHandThumb3: 'thumb_03_r',
    RightHandIndex1: 'index_01_r',
    RightHandIndex2: 'index_02_r',
    RightHandIndex3: 'index_03_r',
    RightHandMiddle1: 'middle_01_r',
    RightHandMiddle2: 'middle_02_r',
    RightHandMiddle3: 'middle_03_r',
    RightHandRing1: 'ring_01_r',
    RightHandRing2: 'ring_02_r',
    RightHandRing3: 'ring_03_r',
    RightHandPinky1: 'pinky_01_r',
    RightHandPinky2: 'pinky_02_r',
    RightHandPinky3: 'pinky_03_r',
    LeftUpLeg: 'thigh_l',
    LeftLeg: 'calf_l',
    LeftFoot: 'foot_l',
    LeftToeBase: 'ball_l',
    RightUpLeg: 'thigh_r',
    RightLeg: 'calf_r',
    RightFoot: 'foot_r',
    RightToeBase: 'ball_r',
};

const MIXAMO_RETARGET_PARENTS = {
    pelvis: null,
    spine_01: 'pelvis',
    spine_02: 'spine_01',
    spine_03: 'spine_02',
    neck_01: 'spine_03',
    head: 'neck_01',
    clavicle_l: 'spine_03',
    upperarm_l: 'clavicle_l',
    lowerarm_l: 'upperarm_l',
    hand_l: 'lowerarm_l',
    thumb_01_l: 'hand_l',
    thumb_02_l: 'thumb_01_l',
    thumb_03_l: 'thumb_02_l',
    index_01_l: 'hand_l',
    index_02_l: 'index_01_l',
    index_03_l: 'index_02_l',
    middle_01_l: 'hand_l',
    middle_02_l: 'middle_01_l',
    middle_03_l: 'middle_02_l',
    ring_01_l: 'hand_l',
    ring_02_l: 'ring_01_l',
    ring_03_l: 'ring_02_l',
    pinky_01_l: 'hand_l',
    pinky_02_l: 'pinky_01_l',
    pinky_03_l: 'pinky_02_l',
    clavicle_r: 'spine_03',
    upperarm_r: 'clavicle_r',
    lowerarm_r: 'upperarm_r',
    hand_r: 'lowerarm_r',
    thumb_01_r: 'hand_r',
    thumb_02_r: 'thumb_01_r',
    thumb_03_r: 'thumb_02_r',
    index_01_r: 'hand_r',
    index_02_r: 'index_01_r',
    index_03_r: 'index_02_r',
    middle_01_r: 'hand_r',
    middle_02_r: 'middle_01_r',
    middle_03_r: 'middle_02_r',
    ring_01_r: 'hand_r',
    ring_02_r: 'ring_01_r',
    ring_03_r: 'ring_02_r',
    pinky_01_r: 'hand_r',
    pinky_02_r: 'pinky_01_r',
    pinky_03_r: 'pinky_02_r',
    thigh_l: 'pelvis',
    calf_l: 'thigh_l',
    foot_l: 'calf_l',
    ball_l: 'foot_l',
    thigh_r: 'pelvis',
    calf_r: 'thigh_r',
    foot_r: 'calf_r',
    ball_r: 'foot_r',
};

const MIXAMO_RETARGET_ORDER = [
    'pelvis',
    'spine_01', 'spine_02', 'spine_03',
    'neck_01', 'head',
    'clavicle_l', 'upperarm_l', 'lowerarm_l', 'hand_l',
    'thumb_01_l', 'thumb_02_l', 'thumb_03_l',
    'index_01_l', 'index_02_l', 'index_03_l',
    'middle_01_l', 'middle_02_l', 'middle_03_l',
    'ring_01_l', 'ring_02_l', 'ring_03_l',
    'pinky_01_l', 'pinky_02_l', 'pinky_03_l',
    'clavicle_r', 'upperarm_r', 'lowerarm_r', 'hand_r',
    'thumb_01_r', 'thumb_02_r', 'thumb_03_r',
    'index_01_r', 'index_02_r', 'index_03_r',
    'middle_01_r', 'middle_02_r', 'middle_03_r',
    'ring_01_r', 'ring_02_r', 'ring_03_r',
    'pinky_01_r', 'pinky_02_r', 'pinky_03_r',
    'thigh_l', 'calf_l', 'foot_l', 'ball_l',
    'thigh_r', 'calf_r', 'foot_r', 'ball_r',
];

const MIXAMO_DEBUG_BONES = [
    'pelvis', 'spine_01', 'spine_03',
    'upperarm_l', 'lowerarm_l', 'hand_l',
    'upperarm_r', 'lowerarm_r', 'hand_r',
    'thigh_l', 'calf_l', 'foot_l',
    'thigh_r', 'calf_r', 'foot_r',
];

const MIXAMO_KEYPOINT_ROTATION_LAYER_BONES = [
    'neck_01', 'head',
    'hand_l',
    'thumb_01_l', 'thumb_02_l', 'thumb_03_l',
    'index_01_l', 'index_02_l', 'index_03_l',
    'middle_01_l', 'middle_02_l', 'middle_03_l',
    'ring_01_l', 'ring_02_l', 'ring_03_l',
    'pinky_01_l', 'pinky_02_l', 'pinky_03_l',
    'hand_r',
    'thumb_01_r', 'thumb_02_r', 'thumb_03_r',
    'index_01_r', 'index_02_r', 'index_03_r',
    'middle_01_r', 'middle_02_r', 'middle_03_r',
    'ring_01_r', 'ring_02_r', 'ring_03_r',
    'pinky_01_r', 'pinky_02_r', 'pinky_03_r',
    'foot_l', 'ball_l',
    'foot_r', 'ball_r',
];

let loaderPromise = null;

function normalizeBoneName(name) {
    if (!name) return '';
    const shortName = name.includes(':') ? name.split(':').pop() : name;
    return shortName.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

async function loadMixamoModules() {
    if (!loaderPromise) {
        loaderPromise = Promise.all([
            import(`https://esm.sh/three@${THREE_VERSION}`),
            import(`https://esm.sh/three@${THREE_VERSION}/examples/jsm/loaders/FBXLoader.js`),
        ]).then(([threeModule, loaderModule]) => ({
            THREE: threeModule,
            FBXLoader: loaderModule.FBXLoader,
        }));
    }
    return loaderPromise;
}

function collectSourceBones(root) {
    const bones = {};
    const normalizedBones = {};

    const registerBone = (object) => {
        if (!object?.name) return;
        bones[object.name] = object;
        const shortName = object.name.includes(':') ? object.name.split(':').pop() : object.name;
        if (!bones[shortName]) bones[shortName] = object;

        const normalizedName = normalizeBoneName(object.name);
        if (normalizedName && !normalizedBones[normalizedName]) {
            normalizedBones[normalizedName] = object;
        }
    };

    root.traverse((object) => {
        if (object?.isBone) {
            registerBone(object);
        }

        if (object?.isSkinnedMesh && Array.isArray(object.skeleton?.bones)) {
            for (const bone of object.skeleton.bones) {
                registerBone(bone);
            }
        }
    });

    return { bones, normalizedBones };
}

function hasMixamoSignature(sourceBones) {
    const requiredNames = ['hips', 'spine', 'leftupleg', 'rightupleg'];
    return requiredNames.every((name) => sourceBones.normalizedBones[name]);
}

function buildFrameRotationMap(sourceBones, targetTHREE) {
    const sourceWorldRotations = {};
    for (const [mixamoName, mhName] of Object.entries(MIXAMO_TO_MH_BONE_MAP)) {
        // Try several name variants to find the source bone:
        // exact, prefixed with mixamorig:, concatenated mixamorig, normalized forms
        const candidates = [
            mixamoName,
            `mixamorig:${mixamoName}`,
            `mixamorig${mixamoName}`,
        ];

        let sourceBone = null;
        for (const c of candidates) {
            if (sourceBones.bones && sourceBones.bones[c]) { sourceBone = sourceBones.bones[c]; break; }
        }
        if (!sourceBone && sourceBones.normalizedBones) {
            const tryNames = [
                normalizeBoneName(mixamoName),
                normalizeBoneName(`mixamorig${mixamoName}`),
                normalizeBoneName(`mixamorig:${mixamoName}`),
            ];
            for (const tn of tryNames) {
                if (sourceBones.normalizedBones[tn]) { sourceBone = sourceBones.normalizedBones[tn]; break; }
            }
        }
        if (!sourceBone) {
            // debug: log which candidates were tried for this bone name
            // console.debug(`[vnccs_mixamo_import] no source bone for ${mixamoName}, tried:`, candidates);
        }
        if (!sourceBone) continue;

        const worldQuaternion = sourceBone.getWorldQuaternion(new sourceBone.quaternion.constructor());
        sourceWorldRotations[mhName] = new targetTHREE.Quaternion(
            worldQuaternion.x,
            worldQuaternion.y,
            worldQuaternion.z,
            worldQuaternion.w,
        );
    }
    // If pelvis missing, try common fallbacks in normalized bones (hips/hip/pelvis/root)
    if (!sourceWorldRotations.pelvis && sourceBones.normalizedBones) {
        const fallbackKeys = ['hips', 'hip', 'pelvis', 'root'];
        for (const k of fallbackKeys) {
            const b = sourceBones.normalizedBones[k];
            if (b) {
                const q = b.getWorldQuaternion(new b.quaternion.constructor());
                sourceWorldRotations.pelvis = new targetTHREE.Quaternion(q.x, q.y, q.z, q.w);
                break;
            }
        }
    }
    return sourceWorldRotations;
}

function findSourceBone(sourceBones, mixamoName) {
    const candidates = [
        mixamoName,
        `mixamorig:${mixamoName}`,
        `mixamorig${mixamoName}`,
    ];

    for (const candidate of candidates) {
        if (sourceBones?.bones?.[candidate]) return sourceBones.bones[candidate];
    }

    const normalizedCandidates = [
        normalizeBoneName(mixamoName),
        normalizeBoneName(`mixamorig:${mixamoName}`),
        normalizeBoneName(`mixamorig${mixamoName}`),
    ];

    for (const normalizedName of normalizedCandidates) {
        if (sourceBones?.normalizedBones?.[normalizedName]) return sourceBones.normalizedBones[normalizedName];
    }

    return null;
}

function getSourceBonePoint(sourceBones, mixamoName) {
    const bone = findSourceBone(sourceBones, mixamoName);
    if (!bone) return null;

    const position = bone.getWorldPosition(new bone.position.constructor());
    return [position.x, position.y, position.z];
}

function pointToVector3(point, THREE) {
    if (!point || point.length < 3 || !THREE) return null;
    return new THREE.Vector3(point[0], point[1], point[2]);
}

function midpoint(a, b, THREE) {
    if (!a || !b) return null;
    return pointToVector3(a, THREE).add(pointToVector3(b, THREE)).multiplyScalar(0.5);
}

function buildMixamoWorldKeypoints(sourceBones, viewer) {
    if (!viewer?.THREE || !viewer?._getBoneWorldPositionForImport) return null;

    const THREE = viewer.THREE;
    const source = {
        pelvis: getSourceBonePoint(sourceBones, 'Hips'),
        neck: getSourceBonePoint(sourceBones, 'Neck'),
        head: getSourceBonePoint(sourceBones, 'Head'),
        leftShoulder: getSourceBonePoint(sourceBones, 'LeftArm'),
        rightShoulder: getSourceBonePoint(sourceBones, 'RightArm'),
        leftElbow: getSourceBonePoint(sourceBones, 'LeftForeArm'),
        rightElbow: getSourceBonePoint(sourceBones, 'RightForeArm'),
        leftWrist: getSourceBonePoint(sourceBones, 'LeftHand'),
        rightWrist: getSourceBonePoint(sourceBones, 'RightHand'),
        leftHip: getSourceBonePoint(sourceBones, 'LeftUpLeg'),
        rightHip: getSourceBonePoint(sourceBones, 'RightUpLeg'),
        leftKnee: getSourceBonePoint(sourceBones, 'LeftLeg'),
        rightKnee: getSourceBonePoint(sourceBones, 'RightLeg'),
        leftAnkle: getSourceBonePoint(sourceBones, 'LeftFoot'),
        rightAnkle: getSourceBonePoint(sourceBones, 'RightFoot'),
    };

    if (!source.pelvis) return null;
    if (!source.neck && source.leftShoulder && source.rightShoulder) {
        const neck = midpoint(source.leftShoulder, source.rightShoulder, THREE);
        if (neck) source.neck = [neck.x, neck.y, neck.z];
    }

    const rest = {
        pelvis: viewer._getBoneWorldPositionForImport('pelvis') || viewer._getBoneWorldPositionForImport('spine_01'),
        neck: viewer._getBoneWorldPositionForImport('neck_01'),
        head: viewer._getBoneWorldPositionForImport('head'),
        leftShoulder: viewer._getBoneWorldPositionForImport('upperarm_l'),
        rightShoulder: viewer._getBoneWorldPositionForImport('upperarm_r'),
        leftElbow: viewer._getBoneWorldPositionForImport('lowerarm_l'),
        rightElbow: viewer._getBoneWorldPositionForImport('lowerarm_r'),
        leftWrist: viewer._getBoneWorldPositionForImport('hand_l'),
        rightWrist: viewer._getBoneWorldPositionForImport('hand_r'),
        leftHip: viewer._getBoneWorldPositionForImport('thigh_l'),
        rightHip: viewer._getBoneWorldPositionForImport('thigh_r'),
        leftKnee: viewer._getBoneWorldPositionForImport('calf_l'),
        rightKnee: viewer._getBoneWorldPositionForImport('calf_r'),
        leftAnkle: viewer._getBoneWorldPositionForImport('foot_l'),
        rightAnkle: viewer._getBoneWorldPositionForImport('foot_r'),
    };
    if (!rest.pelvis) return null;

    const sourceVector = (from, to) => {
        if (!from || !to) return null;
        return [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    };
    const vectorLength = (vector) => (vector ? Math.hypot(vector[0], vector[1], vector[2]) : 0);
    const worldDistance = (from, to) => (from && to ? from.distanceTo(to) : 0);
    const transformedOffset = (vector, scale) => new THREE.Vector3(vector[0] * scale, vector[1] * scale, vector[2] * scale);
    const scaledWorldPoint = (worldAnchor, sourceAnchor, sourcePoint, scale) => {
        const vector = sourceVector(sourceAnchor, sourcePoint);
        if (!worldAnchor || !vector) return null;
        return worldAnchor.clone().add(transformedOffset(vector, scale));
    };
    const segmentWorldPoint = (worldAnchor, sourceAnchor, sourcePoint, targetLength) => {
        const vector = sourceVector(sourceAnchor, sourcePoint);
        const length = vectorLength(vector);
        if (!worldAnchor || !vector || length <= 1e-5 || targetLength <= 1e-5) return null;
        return worldAnchor.clone().add(transformedOffset(vector, targetLength / length));
    };
    const scaleBetween = (sourceAnchor, sourcePoint, worldAnchor, worldPoint, fallback) => {
        const sourceLen = vectorLength(sourceVector(sourceAnchor, sourcePoint));
        const worldLen = worldDistance(worldAnchor, worldPoint);
        if (sourceLen > 1e-5 && worldLen > 1e-5) return worldLen / sourceLen;
        return fallback;
    };

    const torsoScale = scaleBetween(source.pelvis, source.neck || source.head, rest.pelvis, rest.neck || rest.head, 1.0);
    const headScale = scaleBetween(source.neck || source.pelvis, source.head, rest.neck || rest.pelvis, rest.head, torsoScale);
    const leftArmScale = scaleBetween(source.leftShoulder || source.pelvis, source.leftWrist, rest.leftShoulder || rest.pelvis, rest.leftWrist, torsoScale);
    const rightArmScale = scaleBetween(source.rightShoulder || source.pelvis, source.rightWrist, rest.rightShoulder || rest.pelvis, rest.rightWrist, torsoScale);
    const leftLegScale = scaleBetween(source.leftHip || source.pelvis, source.leftAnkle, rest.leftHip || rest.pelvis, rest.leftAnkle, torsoScale);
    const rightLegScale = scaleBetween(source.rightHip || source.pelvis, source.rightAnkle, rest.rightHip || rest.pelvis, rest.rightAnkle, torsoScale);

    const worldKps = {
        pelvis: rest.pelvis.clone(),
        neck: scaledWorldPoint(rest.pelvis, source.pelvis, source.neck, torsoScale),
        head: scaledWorldPoint(rest.neck || rest.pelvis, source.neck || source.pelvis, source.head, headScale),
        left_shoulder: scaledWorldPoint(rest.pelvis, source.pelvis, source.leftShoulder, torsoScale),
        right_shoulder: scaledWorldPoint(rest.pelvis, source.pelvis, source.rightShoulder, torsoScale),
        left_hip: scaledWorldPoint(rest.pelvis, source.pelvis, source.leftHip, torsoScale),
        right_hip: scaledWorldPoint(rest.pelvis, source.pelvis, source.rightHip, torsoScale),
    };

    const leftUpperArmLen = worldDistance(rest.leftShoulder, rest.leftElbow);
    const rightUpperArmLen = worldDistance(rest.rightShoulder, rest.rightElbow);
    const leftLowerArmLen = worldDistance(rest.leftElbow, rest.leftWrist);
    const rightLowerArmLen = worldDistance(rest.rightElbow, rest.rightWrist);
    const leftThighLen = worldDistance(rest.leftHip, rest.leftKnee);
    const rightThighLen = worldDistance(rest.rightHip, rest.rightKnee);
    const leftCalfLen = worldDistance(rest.leftKnee, rest.leftAnkle);
    const rightCalfLen = worldDistance(rest.rightKnee, rest.rightAnkle);

    worldKps.left_elbow = segmentWorldPoint(worldKps.left_shoulder || rest.leftShoulder, source.leftShoulder || source.pelvis, source.leftElbow, leftUpperArmLen)
        || scaledWorldPoint(worldKps.left_shoulder || rest.leftShoulder, source.leftShoulder || source.pelvis, source.leftElbow, leftArmScale);
    worldKps.right_elbow = segmentWorldPoint(worldKps.right_shoulder || rest.rightShoulder, source.rightShoulder || source.pelvis, source.rightElbow, rightUpperArmLen)
        || scaledWorldPoint(worldKps.right_shoulder || rest.rightShoulder, source.rightShoulder || source.pelvis, source.rightElbow, rightArmScale);
    worldKps.left_wrist = segmentWorldPoint(worldKps.left_elbow || worldKps.left_shoulder || rest.leftShoulder, source.leftElbow || source.leftShoulder || source.pelvis, source.leftWrist, leftLowerArmLen)
        || scaledWorldPoint(worldKps.left_elbow || worldKps.left_shoulder || rest.leftShoulder, source.leftElbow || source.leftShoulder || source.pelvis, source.leftWrist, leftArmScale);
    worldKps.right_wrist = segmentWorldPoint(worldKps.right_elbow || worldKps.right_shoulder || rest.rightShoulder, source.rightElbow || source.rightShoulder || source.pelvis, source.rightWrist, rightLowerArmLen)
        || scaledWorldPoint(worldKps.right_elbow || worldKps.right_shoulder || rest.rightShoulder, source.rightElbow || source.rightShoulder || source.pelvis, source.rightWrist, rightArmScale);
    worldKps.left_knee = segmentWorldPoint(worldKps.left_hip || rest.leftHip, source.leftHip || source.pelvis, source.leftKnee, leftThighLen)
        || scaledWorldPoint(worldKps.left_hip || rest.leftHip, source.leftHip || source.pelvis, source.leftKnee, leftLegScale);
    worldKps.right_knee = segmentWorldPoint(worldKps.right_hip || rest.rightHip, source.rightHip || source.pelvis, source.rightKnee, rightThighLen)
        || scaledWorldPoint(worldKps.right_hip || rest.rightHip, source.rightHip || source.pelvis, source.rightKnee, rightLegScale);
    worldKps.left_ankle = segmentWorldPoint(worldKps.left_knee || worldKps.left_hip || rest.leftHip, source.leftKnee || source.leftHip || source.pelvis, source.leftAnkle, leftCalfLen)
        || scaledWorldPoint(worldKps.left_knee || worldKps.left_hip || rest.leftHip, source.leftKnee || source.leftHip || source.pelvis, source.leftAnkle, leftLegScale);
    worldKps.right_ankle = segmentWorldPoint(worldKps.right_knee || worldKps.right_hip || rest.rightHip, source.rightKnee || source.rightHip || source.pelvis, source.rightAnkle, rightCalfLen)
        || scaledWorldPoint(worldKps.right_knee || worldKps.right_hip || rest.rightHip, source.rightKnee || source.rightHip || source.pelvis, source.rightAnkle, rightLegScale);

    if (!worldKps.neck && worldKps.left_shoulder && worldKps.right_shoulder) {
        worldKps.neck = worldKps.left_shoulder.clone().add(worldKps.right_shoulder).multiplyScalar(0.5);
    }

    const required = [
        'pelvis', 'neck',
        'left_shoulder', 'right_shoulder',
        'left_elbow', 'right_elbow',
        'left_wrist', 'right_wrist',
        'left_hip', 'right_hip',
        'left_knee', 'right_knee',
        'left_ankle', 'right_ankle',
    ];
    if (!required.every((key) => !!worldKps[key])) return null;

    return {
        worldKps,
        debug: {
            torsoScale,
            leftArmScale,
            rightArmScale,
            leftLegScale,
            rightLegScale,
            source,
        },
    };
}

function applyExplicitMixamoBendTargets(viewer, worldKps) {
    if (!viewer?.ikController?.ccdSolver || !viewer?.bones || !viewer?.skinnedMesh || !worldKps) return false;

    const targets = [
        { chainKey: 'rightArm', effector: worldKps.right_wrist, pole: worldKps.right_elbow },
        { chainKey: 'leftArm', effector: worldKps.left_wrist, pole: worldKps.left_elbow },
        { chainKey: 'rightLeg', effector: worldKps.right_ankle, pole: worldKps.right_knee },
        { chainKey: 'leftLeg', effector: worldKps.left_ankle, pole: worldKps.left_knee },
    ];

    let applied = false;
    for (const { chainKey, effector, pole } of targets) {
        const chainDef = IK_CHAINS[chainKey];
        if (!chainDef || !effector || !pole) continue;

        const poleHelper = viewer.ikController.poleTargets?.[chainKey];
        if (poleHelper) poleHelper.position.copy(pole);

        viewer.ikController.ccdSolver.solve(chainDef, viewer.bones, effector, pole);
        viewer.skinnedMesh.updateMatrixWorld(true);
        applied = true;
    }

    if (applied) {
        if (viewer.skeleton) viewer.skeleton.update();
        viewer.skinnedMesh.updateMatrixWorld(true);
        if (viewer.updateIKEffectorPositions) viewer.updateIKEffectorPositions();
    }

    return applied;
}

function applyMixamoRotationLayer(viewer, sourceWorldRotations, sourceRestWorldRotations, boneNames = MIXAMO_KEYPOINT_ROTATION_LAYER_BONES) {
    if (!viewer?.THREE || !viewer?.bones || !sourceWorldRotations || !sourceRestWorldRotations) return false;

    let applied = false;
    for (const boneName of boneNames) {
        const bone = viewer.bones[boneName];
        const sourceWorld = sourceWorldRotations[boneName];
        const sourceRest = sourceRestWorldRotations[boneName];
        if (!bone || !sourceWorld || !sourceRest) continue;

        const parentName = MIXAMO_RETARGET_PARENTS[boneName];
        const sourceParentWorld = parentName ? sourceWorldRotations[parentName] : null;
        const sourceRestParentWorld = parentName ? sourceRestWorldRotations[parentName] : null;

        const sourceAnimatedLocal = sourceParentWorld
            ? sourceParentWorld.clone().invert().multiply(sourceWorld.clone()).normalize()
            : sourceWorld.clone().normalize();
        const sourceRestLocal = sourceRestParentWorld
            ? sourceRestParentWorld.clone().invert().multiply(sourceRest.clone()).normalize()
            : sourceRest.clone().normalize();

        const sourceLocalDelta = sourceRestLocal.clone().invert().multiply(sourceAnimatedLocal).normalize();
        const targetRestLocal = bone.quaternion.clone().normalize();
        const basisDelta = targetRestLocal.clone().invert().multiply(sourceRestLocal.clone()).normalize();
        const retargetedLocalDelta = basisDelta.clone()
            .multiply(sourceLocalDelta)
            .multiply(basisDelta.clone().invert())
            .normalize();

        bone.quaternion.copy(targetRestLocal.multiply(retargetedLocalDelta).normalize());
        bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
        bone.updateMatrixWorld(true);
        applied = true;
    }

    if (applied) {
        if (viewer.skeleton) viewer.skeleton.update();
        if (viewer.skinnedMesh) viewer.skinnedMesh.updateMatrixWorld(true);
        if (viewer.updateIKEffectorPositions) viewer.updateIKEffectorPositions();
    }

    return applied;
}

function clearImportedDebugFigures(viewer) {
    if (!viewer?._clearImportedFigureGroup) return;
    viewer._clearImportedFigureGroup('_hmr2FigureGroup');
    viewer._clearImportedFigureGroup('_rtmwFigureGroup');
    viewer._clearImportedFigureGroup('_kpFigureGroup');
}

function buildMixamoLegTargets(sourceBones, viewer) {
    const pelvisSource = getSourceBonePoint(sourceBones, 'Hips');
    const leftHipSource = getSourceBonePoint(sourceBones, 'LeftUpLeg');
    const rightHipSource = getSourceBonePoint(sourceBones, 'RightUpLeg');
    const leftKneeSource = getSourceBonePoint(sourceBones, 'LeftLeg');
    const rightKneeSource = getSourceBonePoint(sourceBones, 'RightLeg');
    const leftAnkleSource = getSourceBonePoint(sourceBones, 'LeftFoot');
    const rightAnkleSource = getSourceBonePoint(sourceBones, 'RightFoot');

    if (!pelvisSource || !viewer?._getBoneWorldPositionForImport) return null;

    const rest = {
        pelvis: viewer._getBoneWorldPositionForImport('pelvis') || viewer._getBoneWorldPositionForImport('spine_01'),
        leftHip: viewer._getBoneWorldPositionForImport('thigh_l'),
        rightHip: viewer._getBoneWorldPositionForImport('thigh_r'),
        leftFoot: viewer._getBoneWorldPositionForImport('foot_l'),
        rightFoot: viewer._getBoneWorldPositionForImport('foot_r'),
    };

    if (!rest.pelvis) return null;

    const sourceVector = (from, to) => {
        if (!from || !to) return null;
        return [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    };
    const vectorLength = (vector) => (vector ? Math.hypot(vector[0], vector[1], vector[2]) : 0);
    const worldDistance = (from, to) => (from && to ? from.distanceTo(to) : 0);
    const transformedOffset = (vector, scale) => new viewer.THREE.Vector3(vector[0] * scale, vector[1] * scale, vector[2] * scale);
    const scaledWorldPoint = (worldAnchor, sourceAnchor, sourcePoint, scale) => {
        if (!worldAnchor || !sourceAnchor || !sourcePoint) return null;
        return worldAnchor.clone().add(transformedOffset(sourceVector(sourceAnchor, sourcePoint), scale));
    };
    const scaleBetween = (sourceAnchor, sourcePoint, worldAnchor, worldPoint, fallback) => {
        const sourceLen = vectorLength(sourceVector(sourceAnchor, sourcePoint));
        const worldLen = worldDistance(worldAnchor, worldPoint);
        if (sourceLen > 1e-5 && worldLen > 1e-5) return worldLen / sourceLen;
        return fallback;
    };

    const leftLegScale = scaleBetween(leftHipSource || pelvisSource, leftAnkleSource, rest.leftHip || rest.pelvis, rest.leftFoot, 1.0);
    const rightLegScale = scaleBetween(rightHipSource || pelvisSource, rightAnkleSource, rest.rightHip || rest.pelvis, rest.rightFoot, 1.0);
    const worldLeftHip = scaledWorldPoint(rest.pelvis, pelvisSource, leftHipSource, 1.0) || rest.leftHip;
    const worldRightHip = scaledWorldPoint(rest.pelvis, pelvisSource, rightHipSource, 1.0) || rest.rightHip;

    return {
        leftLeg: {
            kneeTarget: scaledWorldPoint(worldLeftHip || rest.leftHip, leftHipSource || pelvisSource, leftKneeSource, leftLegScale),
            ankleTarget: scaledWorldPoint(worldLeftHip || rest.leftHip, leftHipSource || pelvisSource, leftAnkleSource, leftLegScale),
        },
        rightLeg: {
            kneeTarget: scaledWorldPoint(worldRightHip || rest.rightHip, rightHipSource || pelvisSource, rightKneeSource, rightLegScale),
            ankleTarget: scaledWorldPoint(worldRightHip || rest.rightHip, rightHipSource || pelvisSource, rightAnkleSource, rightLegScale),
        },
        rawSources: {
            pelvisSource,
            leftHipSource,
            rightHipSource,
            leftKneeSource,
            rightKneeSource,
            leftAnkleSource,
            rightAnkleSource,
            leftLegScale,
            rightLegScale,
        }
    };
}

function buildSampleTimes(duration, fps, maxFrames) {
    const safeDuration = Math.max(0, Number(duration) || 0);
    if (safeDuration <= 0) return [0];

    const requestedStep = 1 / Math.max(1, fps || 12);
    const cappedStep = safeDuration / Math.max(1, maxFrames || 48);
    const step = Math.max(requestedStep, cappedStep);

    const times = [];
    for (let t = 0; t < safeDuration && times.length < maxFrames; t += step) {
        times.push(t);
    }
    if (!times.length || Math.abs(times[times.length - 1] - safeDuration) > 1e-5) {
        times.push(safeDuration);
    }
    return times;
}

export async function importMixamoFBXAsPoses(file, viewer, options = {}) {
    if (!file) throw new Error('No FBX file was selected.');
    if (!viewer?.isInitialized?.() || !viewer.THREE) throw new Error('Pose viewer is not ready.');

    const { THREE, FBXLoader } = await loadMixamoModules();
    const loader = new FBXLoader();
    const fileUrl = URL.createObjectURL(file);

    try {
        const root = await loader.loadAsync(fileUrl);
        const clip = root?.animations?.[0];
        if (!clip) throw new Error('The FBX file does not contain any animation clips.');

        const sourceBones = collectSourceBones(root);
        // Debug logging: print discovered bone names to browser console to aid mapping
        try {
            console.info('[vnccs_mixamo_import] discovered bones:', Object.keys(sourceBones.bones || {}).slice(0,200));
            console.info('[vnccs_mixamo_import] discovered normalized bones:', Object.keys(sourceBones.normalizedBones || {}).slice(0,200));
        } catch (e) {
            // ignore logging failures
        }
        // Accept any FBX that provides bones (either Bone objects or SkinnedMesh.skeleton.bones).
        const hasAnyBones = sourceBones && (
            (sourceBones.bones && Object.keys(sourceBones.bones).length > 0) ||
            (sourceBones.normalizedBones && Object.keys(sourceBones.normalizedBones).length > 0)
        );
        if (!hasAnyBones) {
            throw new Error('FBX file contains no skeleton bones or skinned meshes.');
        }

        root.updateMatrixWorld(true);
        const sourceRestWorldRotations = buildFrameRotationMap(sourceBones, viewer.THREE);

        const sampleTimes = buildSampleTimes(clip.duration, options.fps ?? 12, options.maxFrames ?? 48);
        const mixer = new THREE.AnimationMixer(root);
        const action = mixer.clipAction(clip);
        action.reset();
        action.play();

        const originalPose = viewer.getPose();
        const poses = [];
        const debugFrames = [];

        for (const sampleTime of sampleTimes) {
            mixer.setTime(sampleTime);
            root.updateMatrixWorld(true);

            viewer.resetPose();
            const mixamoKeypoints = buildMixamoWorldKeypoints(sourceBones, viewer);
            if (mixamoKeypoints?.worldKps && viewer.fitMannequinToHMR2) {
                const historySnapshot = Array.isArray(viewer.history) ? viewer.history.slice() : null;
                const futureSnapshot = Array.isArray(viewer.future) ? viewer.future.slice() : null;
                const sourceWorldRotations = buildFrameRotationMap(sourceBones, viewer.THREE);
                clearImportedDebugFigures(viewer);
                viewer._hmr2WorldKps = mixamoKeypoints.worldKps;
                viewer.fitMannequinToHMR2(0);
                applyExplicitMixamoBendTargets(viewer, mixamoKeypoints.worldKps);
                applyMixamoRotationLayer(viewer, sourceWorldRotations, sourceRestWorldRotations);
                clearImportedDebugFigures(viewer);
                if (historySnapshot) viewer.history = historySnapshot;
                if (futureSnapshot) viewer.future = futureSnapshot;
                poses.push(viewer.getPose());

                if (debugFrames.length < 3) {
                    debugFrames.push({
                        sampleTime,
                        method: 'mixamo_keypoints_fk_ik',
                        keypoints: Object.fromEntries(Object.entries(mixamoKeypoints.worldKps).map(([name, value]) => [
                            name,
                            value ? [value.x, value.y, value.z] : null,
                        ])),
                        scales: {
                            torsoScale: mixamoKeypoints.debug.torsoScale,
                            leftArmScale: mixamoKeypoints.debug.leftArmScale,
                            rightArmScale: mixamoKeypoints.debug.rightArmScale,
                            leftLegScale: mixamoKeypoints.debug.leftLegScale,
                            rightLegScale: mixamoKeypoints.debug.rightLegScale,
                        },
                    });
                }
                continue;
            }

            const sourceWorldRotations = buildFrameRotationMap(sourceBones, viewer.THREE);
            const legTargets = buildMixamoLegTargets(sourceBones, viewer);
            try {
                console.info('[vnccs_mixamo_import] sourceWorldRotations keys:', Object.keys(sourceWorldRotations || {}));
            } catch (e) {}
            const debugCollector = debugFrames.length < 3 ? {} : null;
            const applied = viewer.applyWorldRotationImport(
                sourceWorldRotations,
                MIXAMO_RETARGET_PARENTS,
                MIXAMO_RETARGET_ORDER,
                {
                    sourceRestWorldRotations,
                    debugBones: MIXAMO_DEBUG_BONES,
                    debugFrame: debugFrames.length,
                    debugCollector,
                },
            );
            if (!applied) continue;

            // Attach raw Mixamo source world rotations to the pose exported to the node
            // so server-side converters can use exact source quaternions when retargeting.
            const poseObj = viewer.getPose();
            try {
                poseObj._mixamo_sourceWorldRotations = {};
                for (const [k, q] of Object.entries(sourceWorldRotations || {})) {
                    if (!q) continue;
                    poseObj._mixamo_sourceWorldRotations[k] = [q.x, q.y, q.z, q.w];
                }
                // Also include legTargets raw numeric sources for improved IK handling server-side
                if (legTargets && legTargets.rawSources) poseObj._mixamo_legTargets = legTargets.rawSources;
            } catch (e) {
                // ignore any serialization errors
            }

            viewer.applyImportedLegTargets(legTargets);
            // Augment debug collector with leg target numeric values for first frames
            if (debugCollector) {
                try {
                    debugCollector.legTargets = {
                        left: legTargets && legTargets.leftLeg ? {
                            knee: legTargets.leftLeg.kneeTarget ? [legTargets.leftLeg.kneeTarget.x, legTargets.leftLeg.kneeTarget.y, legTargets.leftLeg.kneeTarget.z] : null,
                            ankle: legTargets.leftLeg.ankleTarget ? [legTargets.leftLeg.ankleTarget.x, legTargets.leftLeg.ankleTarget.y, legTargets.leftLeg.ankleTarget.z] : null,
                        } : null,
                        right: legTargets && legTargets.rightLeg ? {
                            knee: legTargets.rightLeg.kneeTarget ? [legTargets.rightLeg.kneeTarget.x, legTargets.rightLeg.kneeTarget.y, legTargets.rightLeg.kneeTarget.z] : null,
                            ankle: legTargets.rightLeg.ankleTarget ? [legTargets.rightLeg.ankleTarget.x, legTargets.rightLeg.ankleTarget.y, legTargets.rightLeg.ankleTarget.z] : null,
                        } : null,
                        rawSources: legTargets?.rawSources ? {
                            pelvisSource: legTargets.rawSources.pelvisSource,
                            leftHipSource: legTargets.rawSources.leftHipSource,
                            rightHipSource: legTargets.rawSources.rightHipSource,
                            leftKneeSource: legTargets.rawSources.leftKneeSource,
                            rightKneeSource: legTargets.rawSources.rightKneeSource,
                            leftAnkleSource: legTargets.rawSources.leftAnkleSource,
                            rightAnkleSource: legTargets.rawSources.rightAnkleSource,
                            leftLegScale: legTargets.rawSources.leftLegScale,
                            rightLegScale: legTargets.rawSources.rightLegScale,
                        } : null,
                    };
                } catch (e) {
                    // ignore debug augmentation failures
                }
            }

            if (debugCollector) {
                debugFrames.push({
                    sampleTime,
                    bones: debugCollector,
                });
            }

            poses.push(viewer.getPose());
        }

        try {
            globalThis.__vnccsMixamoDebug = {
                clipName: clip.name || file.name,
                sampleTimes: sampleTimes.slice(0, debugFrames.length),
                frames: debugFrames,
            };
            console.info('[vnccs_mixamo_import] exact debug saved to globalThis.__vnccsMixamoDebug');
            console.info('[vnccs_mixamo_import] exact debug frames:', debugFrames);
        } catch (e) {
            // ignore debug publishing failures
        }

        viewer.setPose(originalPose, true);

        if (!poses.length) {
            throw new Error('The FBX clip loaded, but no pose frames could be retargeted onto the MH rig.');
        }

        return {
            poses,
            clipName: clip.name || file.name,
        };
    } finally {
        URL.revokeObjectURL(fileUrl);
    }
}
