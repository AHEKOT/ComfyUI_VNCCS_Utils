/**
 * VNCCS Pose Studio Core
 * 
 * Extracted reusable 3D viewer logic.
 */

// Determine the extension's base URL dynamically to support varied directory names
const EXTENSION_URL = new URL(".", import.meta.url).toString();

// === Three.js Module Loader (from Debug3) ===
const THREE_VERSION = "0.160.0";
const THREE_SOURCES = {
    core: `${EXTENSION_URL}three.module.js`,
    orbit: `${EXTENSION_URL}OrbitControls.js`,
    transform: `${EXTENSION_URL}TransformControls.js`
};

const ThreeModuleLoader = {
    promise: null,
    async load() {
        if (!this.promise) {
            this.promise = Promise.all([
                import(THREE_SOURCES.core),
                import(THREE_SOURCES.orbit),
                import(THREE_SOURCES.transform)
            ]).then(([core, orbit, transform]) => ({
                THREE: core,
                OrbitControls: orbit.OrbitControls,
                TransformControls: transform.TransformControls
            }));
        }
        return this.promise;
    }
};


// === IK Chain Definitions ===
const IK_CHAINS = {
    hips: {
        name: "Hips",
        isRoot: true, // Special flag - this is a root effector (translate mode)
        isRootBone: true, // Find the root bone dynamically (bone without parent)
        affectedLegs: ['leftLeg', 'rightLeg'], // Legs affected by hip movement
        iterations: 1,
        threshold: 0.01
    },
    leftArm: {
        name: "Left Arm",
        bones: ['clavicle_l', 'upperarm_l', 'lowerarm_l'],
        effector: 'hand_l',
        poleBone: 'lowerarm_l', // Bone that should point towards pole target (elbow)
        iterations: 10,
        threshold: 0.001
    },
    rightArm: {
        name: "Right Arm",
        bones: ['clavicle_r', 'upperarm_r', 'lowerarm_r'],
        effector: 'hand_r',
        poleBone: 'lowerarm_r', // Elbow
        iterations: 10,
        threshold: 0.001
    },
    leftLeg: {
        name: "Left Leg",
        bones: ['thigh_l', 'calf_l'],
        effector: 'foot_l',
        poleBone: 'calf_l', // Knee
        iterations: 30, // Increased for better accuracy
        threshold: 0.0001 // Smaller threshold
    },
    rightLeg: {
        name: "Right Leg",
        bones: ['thigh_r', 'calf_r'],
        effector: 'foot_r',
        poleBone: 'calf_r', // Knee
        iterations: 30, // Increased for better accuracy
        threshold: 0.0001 // Smaller threshold
    },
    spine: {
        name: "Spine",
        bones: ['spine_01', 'spine_02', 'spine_03', 'neck_01'],
        effector: 'head',
        iterations: 20,
        threshold: 0.01
    },
    leftShoulder: {
        name: "Left Shoulder",
        isShoulder: true,
        bones: ['clavicle_l'],
        effector: 'upperarm_l',
        iterations: 1,
        threshold: 0.001
    },
    rightShoulder: {
        name: "Right Shoulder",
        isShoulder: true,
        bones: ['clavicle_r'],
        effector: 'upperarm_r',
        iterations: 1,
        threshold: 0.01
    }
};

const SAM3D_KEYPOINT_NAMES = [
    'nose',
    'left_eye',
    'right_eye',
    'left_ear',
    'right_ear',
    'left_shoulder',
    'right_shoulder',
    'left_elbow',
    'right_elbow',
    'left_wrist',
    'right_wrist',
    'left_hip',
    'right_hip',
    'left_knee',
    'right_knee',
    'left_ankle',
    'right_ankle',
    'left_big_toe',
    'left_small_toe',
    'left_heel',
    'right_big_toe',
    'right_small_toe',
    'right_heel',
    'left_thumb4',
    'left_thumb3',
    'left_thumb2',
    'left_thumb_third_joint',
    'left_forefinger4',
    'left_forefinger3',
    'left_forefinger2',
    'left_forefinger_third_joint',
    'left_middle_finger4',
    'left_middle_finger3',
    'left_middle_finger2',
    'left_middle_finger_third_joint',
    'left_ring_finger4',
    'left_ring_finger3',
    'left_ring_finger2',
    'left_ring_finger_third_joint',
    'left_pinky_finger4',
    'left_pinky_finger3',
    'left_pinky_finger2',
    'left_pinky_finger_third_joint',
    'right_thumb4',
    'right_thumb3',
    'right_thumb2',
    'right_thumb_third_joint',
    'right_forefinger4',
    'right_forefinger3',
    'right_forefinger2',
    'right_forefinger_third_joint',
    'right_middle_finger4',
    'right_middle_finger3',
    'right_middle_finger2',
    'right_middle_finger_third_joint',
    'right_ring_finger4',
    'right_ring_finger3',
    'right_ring_finger2',
    'right_ring_finger_third_joint',
    'right_pinky_finger4',
    'right_pinky_finger3',
    'right_pinky_finger2',
    'right_pinky_finger_third_joint',
    'neck',
    'left_olecranon',
    'right_olecranon',
    'left_cubital_fossa',
    'right_cubital_fossa',
    'left_acromion',
    'right_acromion',
];

const SAM3D_JOINT_COORD_NAMES = {
    1: 'pelvis',
    2: 'thigh_l',
    3: 'calf_l',
    4: 'foot_l',
    18: 'thigh_r',
    19: 'calf_r',
    20: 'foot_r',
    35: 'spine_01',
    36: 'spine_02',
    37: 'spine_03',
    38: 'clavicle_r',
    39: 'upperarm_r',
    40: 'lowerarm_r',
    42: 'hand_r',
    74: 'clavicle_l',
    75: 'upperarm_l',
    76: 'lowerarm_l',
    78: 'hand_l',
    110: 'neck_01',
    113: 'head',
};

const SAM3D_ROTATION_PARENTS = {
    pelvis: null,
    thigh_l: 'pelvis',
    calf_l: 'thigh_l',
    foot_l: 'calf_l',
    thigh_r: 'pelvis',
    calf_r: 'thigh_r',
    foot_r: 'calf_r',
    spine_01: 'pelvis',
    spine_02: 'spine_01',
    spine_03: 'spine_02',
    clavicle_r: 'spine_03',
    upperarm_r: 'clavicle_r',
    lowerarm_r: 'upperarm_r',
    hand_r: 'lowerarm_r',
    clavicle_l: 'spine_03',
    upperarm_l: 'clavicle_l',
    lowerarm_l: 'upperarm_l',
    hand_l: 'lowerarm_l',
    neck_01: 'spine_03',
    head: 'neck_01',
};

const SAM3D_ROTATION_ORDER = [
    'pelvis',
    'spine_01', 'spine_02', 'spine_03',
    'neck_01', 'head',
    'clavicle_l', 'upperarm_l', 'lowerarm_l', 'hand_l',
    'clavicle_r', 'upperarm_r', 'lowerarm_r', 'hand_r',
    'thigh_l', 'calf_l', 'foot_l',
    'thigh_r', 'calf_r', 'foot_r',
];

const DEFAULT_WORLD_ROTATION_PARENT_MAP = SAM3D_ROTATION_PARENTS;

const DEFAULT_WORLD_ROTATION_ORDER = SAM3D_ROTATION_ORDER;

// === Analytic 2-Bone IK Solver ===
class AnalyticIKSolver {
    constructor(THREE) {
        this.THREE = THREE;
    }

    // Solve 2-bone chain analytically (100% accurate)
    solve2Bone(rootBone, midBone, effectorBone, targetPos, poleTarget, THREE) {
        // Get bone lengths from actual bone positions
        const rootPos = new THREE.Vector3();
        const midPos = new THREE.Vector3();
        const effPos = new THREE.Vector3();

        rootBone.getWorldPosition(rootPos);
        midBone.getWorldPosition(midPos);
        effectorBone.getWorldPosition(effPos);

        const upperLen = rootPos.distanceTo(midPos);
        const lowerLen = midPos.distanceTo(effPos);

        // Distance from root to target
        const targetDist = rootPos.distanceTo(targetPos);

        // Clamp to reachable range
        const totalLen = upperLen + lowerLen;
        const reachDist = Math.min(targetDist, totalLen * 0.999);

        // Law of cosines to find the bend angle at the middle joint
        // cos(A) = (a² + b² - c²) / (2ab)
        let bendAngle = 0;
        if (reachDist > 0.001 && upperLen > 0.001 && lowerLen > 0.001) {
            const cosAngle = (upperLen * upperLen + lowerLen * lowerLen - reachDist * reachDist) / (2 * upperLen * lowerLen);
            bendAngle = Math.acos(Math.max(-1, Math.min(1, cosAngle)));
        }

        // Direction from root to target
        const dirToTarget = new THREE.Vector3().subVectors(targetPos, rootPos).normalize();

        // Calculate bend direction (perpendicular to dirToTarget, towards pole)
        // Use the parent's world orientation (usually Hips) to derive a stable "local-forward" fallback.
        // This prevents the knee from snapping to world-front when the character is rotated.
        const refBone = rootBone.parent || rootBone;
        const refQuat = new THREE.Quaternion();
        refBone.getWorldQuaternion(refQuat);
        let bendDir = new THREE.Vector3(0, 0, 1).applyQuaternion(refQuat);

        if (poleTarget) {
            // Project pole position onto plane perpendicular to dirToTarget
            const toPole = new THREE.Vector3().subVectors(poleTarget, rootPos);
            const poleProj = toPole.clone().sub(dirToTarget.clone().multiplyScalar(toPole.dot(dirToTarget)));
            if (poleProj.lengthSq() > 0.001) {
                bendDir = poleProj.normalize();
            }
        } else {
            // Default: bend forward (for knees) or backward (for elbows)
            // Use a hint based on the current mid bone position
            const toMid = new THREE.Vector3().subVectors(midPos, rootPos);
            const midProj = toMid.clone().sub(dirToTarget.clone().multiplyScalar(toMid.dot(dirToTarget)));
            if (midProj.lengthSq() > 0.001) {
                bendDir = midProj.normalize();
            }
        }

        // Calculate the angle at root joint
        // Distance from root to the middle point
        const reachRatio = reachDist / totalLen;
        const midDist = upperLen;

        // Angle at root: angle between dirToTarget and the upper bone direction
        // Using law of cosines again
        let rootAngle = 0;
        if (reachDist > 0.001) {
            const cosRoot = (upperLen * upperLen + reachDist * reachDist - lowerLen * lowerLen) / (2 * upperLen * reachDist);
            rootAngle = Math.acos(Math.max(-1, Math.min(1, cosRoot)));
        }

        // Calculate upper bone direction
        // The rotation axis should be perpendicular to both dirToTarget and the bend plane (bendDir)
        let axis = new THREE.Vector3().crossVectors(dirToTarget, bendDir);

        let upperDir;
        if (axis.lengthSq() < 0.0001) {
            // Singularity fallback: if target is perfectly aligned with bendDir, pick any arbitrary perpendicular axis
            axis = new THREE.Vector3(1, 0, 0);
            if (Math.abs(dirToTarget.x) > 0.9) axis.set(0, 1, 0);
            axis.cross(dirToTarget).normalize();
        } else {
            axis.normalize();
        }

        // Rotate target direction towards the bend direction
        const rotQuat = new THREE.Quaternion().setFromAxisAngle(axis, rootAngle);
        upperDir = dirToTarget.clone().applyQuaternion(rotQuat);

        // Calculate target mid position
        const targetMidPos = rootPos.clone().add(upperDir.clone().multiplyScalar(upperLen));

        // Now we need to rotate rootBone so its child (midBone) is at targetMidPos
        // And rotate midBone so its child (effectorBone) is at targetPos

        // === Rotate root bone ===
        this.rotateBoneToPoint(rootBone, midPos, targetMidPos, THREE);

        // Update matrices after root rotation
        rootBone.updateMatrixWorld(true);

        // Get new mid position after root rotation
        midBone.getWorldPosition(midPos);

        // === Rotate mid bone ===
        // IMPORTANT: Must refresh effector world position because it moved with its parent!
        effectorBone.getWorldPosition(effPos);
        this.rotateBoneToPoint(midBone, effPos, targetPos, THREE);

        // Update matrices
        midBone.updateMatrixWorld(true);

        return true;
    }

    rotateBoneToPoint(bone, currentChildPos, targetChildPos, THREE) {
        // Get bone world position
        const bonePos = new THREE.Vector3();
        bone.getWorldPosition(bonePos);

        // Direction from bone to current child position
        const currentDir = new THREE.Vector3().subVectors(currentChildPos, bonePos).normalize();

        // Direction from bone to target child position
        const targetDir = new THREE.Vector3().subVectors(targetChildPos, bonePos).normalize();

        // Calculate rotation
        const dot = currentDir.dot(targetDir);
        if (dot > 0.9999) return; // Already aligned

        const axis = new THREE.Vector3().crossVectors(currentDir, targetDir);
        let angle = Math.acos(Math.max(-1, Math.min(1, dot)));

        if (axis.lengthSq() < 0.0001) {
            // Singularity: 180 degree rotation. Pick any perpendicular axis.
            if (dot < 0) {
                const perp = new THREE.Vector3(1, 0, 0);
                if (Math.abs(currentDir.x) > 0.9) perp.set(0, 1, 0);
                axis.crossVectors(currentDir, perp).normalize();
            } else {
                return; // Already aligned (0 degrees)
            }
        } else {
            axis.normalize();
        }

        // Create rotation quaternion in world space
        const worldRotQuat = new THREE.Quaternion().setFromAxisAngle(axis, angle);

        // Get current world quaternion
        const currentWorldQuat = new THREE.Quaternion();
        bone.getWorldQuaternion(currentWorldQuat);

        // Apply rotation in world space
        const newWorldQuat = worldRotQuat.multiply(currentWorldQuat);

        // Convert to local quaternion
        if (bone.parent) {
            const parentWorldQuat = new THREE.Quaternion();
            bone.parent.getWorldQuaternion(parentWorldQuat);
            const invParentQuat = parentWorldQuat.clone().invert();
            newWorldQuat.premultiply(invParentQuat);
        }

        bone.quaternion.copy(newWorldQuat);
    }
}

// === CCD IK Solver ===
class CCDIKSolver {
    constructor(THREE) {
        this.THREE = THREE;
        this.analyticSolver = new AnalyticIKSolver(THREE);
    }

    solve(chainDef, bones, target, poleTarget = null) {
        const THREE = this.THREE;

        const chainBones = chainDef.bones.map(name => bones[name]).filter(b => b);
        const effectorBone = bones[chainDef.effector];
        const poleBone = chainDef.poleBone ? bones[chainDef.poleBone] : null;

        if (!effectorBone || chainBones.length === 0) {
            return false;
        }

        // Use analytic solver for 2-bone chains (much more accurate)
        if (chainBones.length === 2) {
            return this.analyticSolver.solve2Bone(
                chainBones[0],
                chainBones[1],
                effectorBone,
                target,
                poleTarget,
                THREE
            );
        }

        // For 3-bone chains (arms with clavicle), use analytic solver for last 2 bones
        // This gives accurate pole target behavior like legs
        if (chainBones.length === 3) {
            // chainBones[0] = clavicle (skip for IK)
            // chainBones[1] = upperarm
            // chainBones[2] = lowerarm
            return this.analyticSolver.solve2Bone(
                chainBones[1], // upperarm
                chainBones[2], // lowerarm
                effectorBone,  // hand
                target,
                poleTarget,
                THREE
            );
        }

        // Fall back to CCD for longer chains
        const effectorWorldPos = new THREE.Vector3();
        effectorBone.getWorldPosition(effectorWorldPos);

        const initialDist = effectorWorldPos.distanceTo(target);
        if (initialDist < chainDef.threshold) {
            return true;
        }

        for (let iter = 0; iter < chainDef.iterations; iter++) {
            for (let i = chainBones.length - 1; i >= 0; i--) {
                const bone = chainBones[i];

                effectorBone.getWorldPosition(effectorWorldPos);

                const dist = effectorWorldPos.distanceTo(target);
                if (dist < chainDef.threshold) {
                    return true;
                }

                const boneWorldPos = new THREE.Vector3();
                bone.getWorldPosition(boneWorldPos);

                const toEffector = effectorWorldPos.clone().sub(boneWorldPos).normalize();
                const toTarget = target.clone().sub(boneWorldPos).normalize();

                const dot = toEffector.dot(toTarget);

                if (dot > 0.9999) continue;

                const clampedDot = Math.max(-1, Math.min(1, dot));
                const angle = Math.acos(clampedDot);

                if (angle < 0.0001) continue;

                const axis = new THREE.Vector3().crossVectors(toEffector, toTarget).normalize();

                if (axis.lengthSq() < 0.0001) continue;

                const maxAngle = Math.PI / 4;
                const limitedAngle = Math.min(angle, maxAngle);

                const boneWorldQuat = new THREE.Quaternion();
                bone.getWorldQuaternion(boneWorldQuat);

                const worldRotQuat = new THREE.Quaternion().setFromAxisAngle(axis, limitedAngle);
                const newWorldQuat = worldRotQuat.multiply(boneWorldQuat);

                if (bone.parent) {
                    const parentWorldQuat = new THREE.Quaternion();
                    bone.parent.getWorldQuaternion(parentWorldQuat);
                    const invParentQuat = parentWorldQuat.clone().invert();
                    newWorldQuat.premultiply(invParentQuat);
                }

                bone.quaternion.copy(newWorldQuat);
                bone.updateMatrixWorld(true);
            }
        }

        // Apply pole target constraint ONCE at the end (not every iteration to avoid accumulation)
        if (poleTarget && poleBone && chainBones.length >= 2) {
            this.applyPoleConstraint(chainBones, poleBone, target, poleTarget, THREE);
        }

        effectorBone.getWorldPosition(effectorWorldPos);
        return effectorWorldPos.distanceTo(target) < chainDef.threshold;
    }

    applyPoleConstraint(chainBones, poleBone, effectorTarget, poleTarget, THREE) {
        // For 2-bone chains (legs): chainBones[0]=thigh, chainBones[1]=calf
        // For 3-bone chains (arms): chainBones[0]=clavicle, chainBones[1]=upperarm, chainBones[2]=lowerarm

        // Use poleBone for elbow/knee position (passed as parameter)
        if (!poleBone) return;

        // For 3-bone chains, we need to rotate upperarm (index 1), not clavicle (index 0)
        // For 2-bone chains, we rotate the first bone (thigh)
        const boneToRotate = chainBones.length >= 3 ? chainBones[1] : chainBones[0];
        if (!boneToRotate) return;

        // Get positions - use boneToRotate position as root for calculations
        const rootPos = new THREE.Vector3();
        const polePos = new THREE.Vector3();

        boneToRotate.getWorldPosition(rootPos); // Position of upperarm/thigh
        poleBone.getWorldPosition(polePos); // Position of elbow/knee

        // Calculate the bend plane
        const rootToTarget = effectorTarget.clone().sub(rootPos).normalize();
        const rootToPole = poleTarget.clone().sub(rootPos).normalize();

        // Calculate the desired bend direction (perpendicular to root->target, towards pole)
        const bendAxis = new THREE.Vector3().crossVectors(rootToTarget, rootToPole).normalize();

        if (bendAxis.lengthSq() < 0.0001) return;

        // Get current bend direction from boneToRotate to poleBone (elbow/knee)
        const currentBend = polePos.clone().sub(rootPos).normalize();

        // Project current bend onto plane perpendicular to root->target
        const projectedCurrent = currentBend.clone().sub(
            rootToTarget.clone().multiplyScalar(currentBend.dot(rootToTarget))
        ).normalize();

        // Project desired bend (towards pole) onto same plane
        const projectedDesired = rootToPole.clone().sub(
            rootToTarget.clone().multiplyScalar(rootToPole.dot(rootToTarget))
        ).normalize();

        // Calculate rotation angle to align with pole
        const dot = projectedCurrent.dot(projectedDesired);
        if (Math.abs(dot) > 0.9999) return;

        const clampedDot = Math.max(-1, Math.min(1, dot));
        let rotationAngle = Math.acos(clampedDot);

        // Check rotation direction
        const cross = new THREE.Vector3().crossVectors(projectedCurrent, projectedDesired);
        if (cross.dot(rootToTarget) < 0) {
            rotationAngle = -rotationAngle;
        }

        // Apply rotation to the correct bone (upperarm for arms, thigh for legs)
        const boneWorldQuat = new THREE.Quaternion();
        boneToRotate.getWorldQuaternion(boneWorldQuat);

        // Create rotation around the target direction axis
        const poleRotationQuat = new THREE.Quaternion().setFromAxisAngle(rootToTarget, rotationAngle * 0.5);
        const newWorldQuat = poleRotationQuat.multiply(boneWorldQuat);

        if (boneToRotate.parent) {
            const parentWorldQuat = new THREE.Quaternion();
            boneToRotate.parent.getWorldQuaternion(parentWorldQuat);
            const invParentQuat = parentWorldQuat.clone().invert();
            newWorldQuat.premultiply(invParentQuat);
        }

        boneToRotate.quaternion.copy(newWorldQuat);
        boneToRotate.updateMatrixWorld(true);
    }
}

// === IK Controller ===
class IKController {
    constructor(THREE) {
        this.THREE = THREE;
        this.ccdSolver = new CCDIKSolver(THREE);
        this.activeChains = new Set();
        this.effectors = {};
        this.poleTargets = {}; // Pole target meshes
        this.poleModes = {}; // 'on' or 'off' for each chain
        this.modes = {};

        Object.keys(IK_CHAINS).forEach(key => {
            this.modes[key] = 'ik';
            this.activeChains.add(key);
            this.poleModes[key] = 'off'; // Disabled by default, solves the target passing twist issue
        });
    }

    setMode(chainKey, mode) {
        this.modes[chainKey] = mode;
        if (mode === 'ik') {
            this.activeChains.add(chainKey);
        } else {
            this.activeChains.delete(chainKey);
        }
    }

    getMode(chainKey) {
        return this.modes[chainKey] || 'fk';
    }

    setPoleMode(chainKey, mode) {
        this.poleModes[chainKey] = mode;
    }

    getPoleMode(chainKey) {
        return this.poleModes[chainKey] || 'off';
    }

    isPoleTargetEnabled(chainKey) {
        return this.poleModes[chainKey] === 'on' && this.modes[chainKey] === 'ik';
    }

    isEffector(boneName) {
        for (const key in IK_CHAINS) {
            if (IK_CHAINS[key].effector === boneName && this.modes[key] === 'ik') {
                return true;
            }
        }
        return false;
    }

    getChainForEffector(boneName) {
        for (const key in IK_CHAINS) {
            if (IK_CHAINS[key].effector === boneName) {
                return key;
            }
        }
        return null;
    }

    getChainForBone(boneName) {
        for (const key in IK_CHAINS) {
            const chain = IK_CHAINS[key];
            if (chain.effector === boneName || (chain.bones && chain.bones.includes(boneName))) {
                return key;
            }
        }
        return null;
    }

    getChainForPoleTarget(meshName) {
        for (const key in IK_CHAINS) {
            if (`pole_${key}` === meshName) {
                return key;
            }
        }
        return null;
    }

    solve(bones, effectorTargets) {
        for (const chainKey of this.activeChains) {
            const chainDef = IK_CHAINS[chainKey];
            const target = effectorTargets.get(chainDef.effector);

            if (target) {
                this.ccdSolver.solve(chainDef, bones, target);
            }
        }
    }

    solveWithPole(chainDef, bones, effectorTarget, chainKey) {
        let poleTarget = null;

        // Check if pole target is enabled for this chain
        if (this.isPoleTargetEnabled(chainKey) && this.poleTargets[chainKey]) {
            poleTarget = this.poleTargets[chainKey].position.clone();
        }

        // Keep leg bend direction stable even when no explicit pole target is active.
        if (!poleTarget && (chainKey === 'leftLeg' || chainKey === 'rightLeg')) {
            const poleBoneName = chainDef.poleBone;
            const poleBone = poleBoneName ? bones[poleBoneName] : null;
            if (poleBone) {
                const THREE = this.ccdSolver.THREE;
                poleTarget = new THREE.Vector3();
                poleBone.getWorldPosition(poleTarget);
            }
        }

        return this.ccdSolver.solve(chainDef, bones, effectorTarget, poleTarget);
    }

    createEffectorHelper(effectorName, bone, THREE, isRoot = false) {
        // Use an empty Object3D instead of a mesh so it remains invisible
        // but still holds position and rotation for the IK solver.
        const helper = new THREE.Object3D();


        helper.name = `ik_effector_${effectorName}`;
        helper.userData.effectorName = effectorName;
        helper.userData.type = 'effector';
        helper.userData.isRoot = isRoot;


        // Don't set position here - it will be set by createIKEffectorHelpers

        this.effectors[effectorName] = helper;

        return helper;
    }

    createPoleTargetHelper(chainKey, poleBone, THREE) {
        // Use an empty Object3D instead of a mesh
        const helper = new THREE.Object3D();

        helper.name = `pole_${chainKey}`;
        helper.userData.chainKey = chainKey;
        helper.userData.type = 'poleTarget';

        this.poleTargets[chainKey] = helper;

        return helper;
    }

    updateEffectorPosition(effectorName, bone) {
        const helper = this.effectors[effectorName];
        if (helper && bone) {
            const bonePos = new this.THREE.Vector3();
            bone.getWorldPosition(bonePos);
            helper.position.copy(bonePos);
        }
    }
}


export class PoseViewerCore {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.width = canvas.width || 500;
        this.height = canvas.height || 500;
        this.shoulderIKEnabled = true;
        this._rtmwSavedCamera = null;
        this._rtmwCameraParented = true;
        this._mannequinVisible = true;

        // Default constraints based on standard UI Embedding requirements
        this.options = {
            onPoseChange: null,
            onError: console.error,
            onInteractionStart: null,
            onInteractionEnd: null,
            onHandHover: null,
            onHandActivate: null,

            syncMode: 'end',
            skinMode: 'flat_color',

            showSkeletonHelper: true,
            showCaptureFrame: true,
            showReferenceImage: true,

            enableLighting: true,
            enableMultiPass: true,
            enableTextureSkinning: true,

            orbitEnabled: true,
            ikEnabled: true,
            ...options
        };

        this.THREE = null;
        this.OrbitControls = null;
        this.TransformControls = null;

        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.orbit = null;
        this.transform = null;

        this.skinnedMesh = null;
        this.skeleton = null;
        this.boneList = [];
        this.bones = {};
        this.selectedBone = null;

        this.jointMarkers = [];

        // Pose state
        this.modelRotation = { x: 0, y: 0, z: 0 };

        this.initialized = false;

        // Undo/Redo History
        this.history = [];
        this.future = [];
        this.maxHistory = 10;
        this.headScale = 1.0;
        this.armScale = 1.0;
        this.handScale = 1.0;

        // Managed lights array
        this.lights = [];
        this.pendingData = null;
        this.pendingLights = null;
        this.pendingBackgroundUrl = null;

        // IK State
        this.ikController = null;
        this.ikMode = this.options.ikEnabled;
        this.ikEffectorTargets = new Map();
        this.selectedIKEffector = null; // Currently selected IK effector mesh
        this.selectedPoleTarget = null; // Currently selected pole target mesh

        // Throttling state for setPose sync
        this.isDispatching = false;
        this.queuedSyncFrame = null;
        this.cameraParams = null; // Store widget camera params explicitly
        this.isInteractionActive = null;
        this._hoveredHandSide = null;
    }

    _getHandSideFromBoneName(name) {
        if (!name) return null;
        const lower = name.toLowerCase();
        if (!lower.endsWith('_l') && !lower.endsWith('_r')) return null;
        if (!/(hand|thumb|index|middle|ring|pinky)/.test(lower)) return null;
        return lower.endsWith('_l') ? 'l' : 'r';
    }

    _isFingerHandBoneName(name) {
        if (!name) return false;
        const lower = name.toLowerCase();
        return /^(thumb|index|middle|ring|pinky)(?:_|$)|\bfinger\b/.test(lower);
    }

    _shouldMarkerBeVisible(marker) {
        const bone = this.boneList?.[marker?.userData?.boneIndex];
        if (!bone) return false;
        return !this._isFingerHandBoneName(bone.name);
    }

    _getRaycastableJointMarkers() {
        return (this.jointMarkers || []).filter((marker) => marker?.visible);
    }

    _resolveHandBone(bone) {
        const side = this._getHandSideFromBoneName(bone?.name);
        if (!side) return bone;
        return this.bones?.[`hand_${side}`] || bone;
    }

    _isHandSurfaceActivation(side, point) {
        if (!side || !point || !this.THREE) return false;

        const wrist = this.bones?.[`hand_${side}`];
        const middleBase = this.bones?.[`middle_01_${side}`];
        const indexBase = this.bones?.[`index_01_${side}`] || middleBase;
        const ringBase = this.bones?.[`ring_01_${side}`] || middleBase;
        if (!wrist || !middleBase) return false;

        const wristPos = new this.THREE.Vector3();
        const middlePos = new this.THREE.Vector3();
        const indexPos = new this.THREE.Vector3();
        const ringPos = new this.THREE.Vector3();
        wrist.getWorldPosition(wristPos);
        middleBase.getWorldPosition(middlePos);
        indexBase.getWorldPosition(indexPos);
        ringBase.getWorldPosition(ringPos);

        const palmCenter = new this.THREE.Vector3()
            .add(middlePos)
            .add(indexPos)
            .add(ringPos)
            .multiplyScalar(1 / 3);

        const handDir = palmCenter.clone().sub(wristPos);
        const handLength = handDir.length();
        if (handLength < 1e-4) return false;

        handDir.normalize();
        const clickOffset = point.clone().sub(wristPos);
        const alongHand = clickOffset.dot(handDir);
        const wristDeadZone = Math.max(0.12, handLength * 0.32);

        return alongHand > wristDeadZone;
    }

    _updateHoveredHand(side) {
        if (this._hoveredHandSide === side) return;
        this._hoveredHandSide = side;

        if (side) {
            this.showHandHighlightRing(side);
        } else {
            this.hideHandHighlightRing();
        }

        if (this.options.onHandHover) {
            this.options.onHandHover({ side });
        }
    }

    dispatchPoseChange() {
        if (!this.options.onPoseChange) return;

        if (this.options.syncMode === 'raf') {
            if (!this.queuedSyncFrame) {
                this.queuedSyncFrame = requestAnimationFrame(() => {
                    this.options.onPoseChange(this.getPose());
                    this.queuedSyncFrame = null;
                });
            }
        } else if (this.options.syncMode === 'end') {
            // If we are currently interacting, 'end' mode means suppress until interaction finishes.
            if (!this.isInteractionActive) {
                this.options.onPoseChange(this.getPose());
            }
        }
    }

    // === Public API Lifecycle ===

    isInitialized() {
        return this.initialized && this.skinnedMesh !== null;
    }

    dispose() {
        this.initialized = false;

        if (this.queuedSyncFrame) {
            cancelAnimationFrame(this.queuedSyncFrame);
            this.queuedSyncFrame = null;
        }

        if (this.transform) {
            this.transform.detach();
            if (this.transform.parent) this.transform.parent.remove(this.transform);
            this.transform.dispose();
            this.transform = null;
        }

        if (this.orbit) {
            this.orbit.dispose();
            this.orbit = null;
        }

        // Clean up lights
        if (this.lights) {
            this.lights.forEach(l => {
                if (l.parent) l.parent.remove(l);
                if (l.dispose) l.dispose();
            });
            this.lights = [];
        }

        if (this.renderer) {
            this.renderer.dispose();
            if (this.renderer.domElement && this.renderer.domElement.parentNode) {
                // Don't modify the shell's DOM, just clean up WebGL
            }
            this.renderer = null;
        }

        if (this.scene) {
            // Traverse and dispose materials/geometries
            this.scene.traverse((object) => {
                if (!object.isMesh) return;

                if (object.geometry) {
                    object.geometry.dispose();
                }

                if (object.material) {
                    if (Array.isArray(object.material)) {
                        object.material.forEach(material => material.dispose());
                    } else {
                        object.material.dispose();
                    }
                }
            });
            this.scene = null;
        }

        // Drop references
        this.skinnedMesh = null;
        this.skeleton = null;
        this.bones = {};
        this.boneList = [];
        this.ikController = null;
        this.options = null;
    }

    async init() {
        try {
            const modules = await ThreeModuleLoader.load();
            this.THREE = modules.THREE;
            this.OrbitControls = modules.OrbitControls;
            this.TransformControls = modules.TransformControls;

            this.setupScene();

            this.initialized = true;


            this.animate();

            // Apply buffered data after initialized=true
            if (this.pendingData) {
                this.loadData(this.pendingData.data, this.pendingData.keepCamera);
                this.pendingData = null;
            }

            if (this.pendingLights) {
                this.updateLights(this.pendingLights);
                this.pendingLights = null;
            }

            if (this.pendingBackgroundUrl) {
                this.loadReferenceImage(this.pendingBackgroundUrl);
                this.pendingBackgroundUrl = null;
            }

            this.requestRender(); // Initial render
        } catch (e) {
            console.error('Pose Studio: Init failed', e);
        }
    }

    setupScene() {
        const THREE = this.THREE;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x1a1a2e);

        this.camera = new THREE.PerspectiveCamera(45, this.width / this.height, 0.1, 1000);
        this.camera.position.set(0, 10, 30);
        this.scene.add(this.camera);

        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
            preserveDrawingBuffer: true
        });
        this.renderer.setSize(this.width, this.height);
        this.renderer.setPixelRatio(window.devicePixelRatio);

        // Orbit Controls
        this.orbit = new this.OrbitControls(this.camera, this.canvas);
        this.orbit.target.set(0, 10, 0);
        this.orbit.enableDamping = false;
        this.orbit.rotateSpeed = 0.95;
        this.orbit.enableZoom = false;
        this.orbit.mouseButtons = {
            LEFT: this.THREE.MOUSE.NONE,
            MIDDLE: this.THREE.MOUSE.PAN,
            RIGHT: this.THREE.MOUSE.ROTATE,
        };
        this.orbit.update();

        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const delta = e.deltaY;
            const absDelta = Math.abs(delta);
            const scale = 1.0 + Math.sign(delta) * Math.min(0.004 * absDelta, 0.075);
            this.camera.position.sub(this.orbit.target)
                .multiplyScalar(scale)
                .add(this.orbit.target);
            this.orbit.update();
            this.requestRender();
        }, { passive: false });

        // Render on demand: orbit change triggers render
        this.orbit.addEventListener('change', () => this.requestRender());

        // Transform Controls (Gizmo)
        this.transform = new this.TransformControls(this.camera, this.canvas);
        this.transform.setMode("rotate");
        this.transform.setSpace("local");
        this.transform.setSize(0.8);
        this.scene.add(this.transform);

        this.transform.addEventListener("dragging-changed", (e) => {
            this.orbit.enabled = !e.value;

            if (e.value) {
                // Drag Started: Record state for Undo
                this.recordState();
            } else {
                // Drag Ended
                // If dragging an IK effector, do final IK solve
                if (this.selectedIKEffector && this.transform.mode === 'translate') {
                    this.solveIKForEffector();
                }

                // If FK manipulation ended, update effector positions to follow bones
                if (this.transform.mode === 'rotate' && !this.selectedIKEffector) {
                    this.updateIKEffectorPositions();
                }

                // Sync to node
                this.isInteractionActive = false;
                if (this.options.onInteractionEnd) {
                    this.options.onInteractionEnd({ type: this.selectedIKEffector ? 'ik' : 'fk' });
                }
                this.dispatchPoseChange();
            }
        });

        // Real-time IK solving during drag - use 'objectChange' event
        this.transform.addEventListener('objectChange', () => {
            // Real-time IK solving during effector drag
            if (this.selectedIKEffector) {
                this.solveIKForEffector();
                // Update other (non-selected) effectors to follow their bones during IK
                this.updateIKEffectorPositions('nonSelected');
            } else if (this.selectedPoleTarget) {
                // Pole target moved - solve IK for this chain
                this.solveIKForPoleTarget();
            } else if (this.selectedBone) {
                // FK rotation - update all effector positions to follow bones
                this.updateIKEffectorPositions();
            }
            this.requestRender();
        });

        // Render on demand: transform change triggers render
        this.transform.addEventListener('change', () => this.requestRender());

        // Lights - will be setup by updateLights() call from widget
        // Added default ambient light as a failsafe until widget lights load
        const defaultLight = new THREE.AmbientLight(0xffffff, 0.5);
        this.scene.add(defaultLight);
        this.lights = [defaultLight];

        // Capture Camera (Independent of Orbit camera)
        this.captureCamera = new THREE.PerspectiveCamera(30, this.width / this.height, 0.1, 100);
        this.scene.add(this.captureCamera);

        // Visual Helper - Orange Frame
        const frameGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(-1, 1, 0), new THREE.Vector3(1, 1, 0),
            new THREE.Vector3(1, -1, 0), new THREE.Vector3(-1, -1, 0),
            new THREE.Vector3(-1, 1, 0)
        ]);
        this.captureFrame = new THREE.Line(frameGeo, new THREE.LineBasicMaterial({ color: 0xffa500, linewidth: 2 }));
        this.scene.add(this.captureFrame);
        this.captureFrame.visible = false;

        // Events
        this.canvas.addEventListener("pointerdown", (e) => this.handlePointerDown(e));
        this.canvas.addEventListener("pointermove", (e) => this.handlePointerMove(e));
        this.canvas.addEventListener("pointerup", (e) => this.handlePointerUp(e));

        this.hoveredBoneName = null;
        this.directDrag = { active: false, chainKey: null, effector: null, plane: null, offset: null, hasDragged: false, clickedBone: null, startClientX: 0, startClientY: 0 };
    }

    // === Light Management ===
    updateLights(lightParams) {
        if (!this.initialized || !this.THREE || !this.scene) {
            this.pendingLights = lightParams;
            return;
        }

        const THREE = this.THREE;
        if (!lightParams) return;

        // Remove existing managed lights
        if (this.lights && this.lights.length > 0) {
            for (const light of this.lights) {
                this.scene.remove(light);
                if (light.dispose) light.dispose();
            }
        }
        this.lights = [];

        // Failsafe: if no lights are provided, or all were removed, add a default ambient light
        // to prevent black silhouettes. 
        if (!lightParams || lightParams.length === 0) {
            const defaultLight = new THREE.AmbientLight(0xffffff, 0.5);
            this.scene.add(defaultLight);
            this.lights.push(defaultLight);
            return;
        }

        // Create new lights from params
        for (const params of lightParams) {
            // Handle both hex string (#ffffff) and legacy RGB array formats
            let color;
            if (typeof params.color === 'string') {
                color = new THREE.Color(params.color);
            } else if (Array.isArray(params.color)) {
                color = new THREE.Color(
                    params.color[0] / 255,
                    params.color[1] / 255,
                    params.color[2] / 255
                );
            } else {
                color = new THREE.Color(0xffffff);
            }

            let light;
            if (params.type === 'ambient') {
                light = new THREE.AmbientLight(color, params.intensity ?? 0.5);
            } else if (params.type === 'directional') {
                light = new THREE.DirectionalLight(color, params.intensity ?? 1.0);
                light.position.set(params.x ?? 1, params.y ?? 2, params.z ?? 3);
            } else if (params.type === 'point') {
                light = new THREE.PointLight(color, params.intensity ?? 1.0, params.radius ?? 100);
                light.position.set(params.x ?? 0, params.y ?? 0, params.z ?? 5);
            }

            if (light) {
                this.scene.add(light);
                this.lights.push(light);
            }
        }

        this.requestRender();
    }

    animate() {
        if (!this.initialized) return;

        // Damping requires continuous updates while active
        if (this.orbit.enableDamping) {
            this.orbit.update();
        }

        if (this._needsRender) {
            this._needsRender = false;
            if (this.renderer) this.renderer.render(this.scene, this.camera);
        }

        requestAnimationFrame(() => this.animate());
    }

    requestRender() {
        this._needsRender = true;
    }

    handlePointerDown(e) {
        if (!this.initialized || !this.skinnedMesh) return;
        if (e.button !== 0) return;

        // CRITICAL: Force world matrices to update before capturing positions for IK
        this.skinnedMesh.updateMatrixWorld(true);
        if (this.skeleton) this.skeleton.update();
        if (this.ikController) this.updateIKEffectorPositions();

        if (this.transform.dragging) return;
        if (this.transform.axis) return;

        const rect = this.canvas.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        const raycaster = new this.THREE.Raycaster();
        raycaster.setFromCamera(new this.THREE.Vector2(x, y), this.camera);

        // --- IK MODE: Check for pole target hit ---
        if (this.ikMode && this.ikController) {
            const poleMeshes = Object.values(this.ikController.poleTargets).filter(p => p.visible);
            if (poleMeshes.length > 0) {
                const poleIntersects = raycaster.intersectObjects(poleMeshes, false);
                if (poleIntersects.length > 0) {
                    const hitPole = poleIntersects[0].object;
                    this.selectPoleTarget(hitPole);
                    return;
                }
            }
        }

        // --- PASS 1: Raycast against Joint Markers directly ---
        // Markers are spheres, very reliable targets.
        // recursive=false because markers are direct children of the scene (or in a flat array)
        const markerIntersects = raycaster.intersectObjects(this._getRaycastableJointMarkers(), false);

        if (markerIntersects.length > 0) {
            // Sort by distance and pick the closest one
            markerIntersects.sort((a, b) => a.distance - b.distance);
            const hitMarker = markerIntersects[0].object;
            const boneIdx = hitMarker.userData?.boneIndex;
            if (boneIdx !== -1 && this.boneList[boneIdx]) {
                const bone = this.boneList[boneIdx];

                // Check if this bone is part of an active IK chain
                if (this.ikMode && this.ikController) {
                    const chainKey = this.ikController.getChainForBone(bone.name);
                    if (chainKey && this.ikController.getMode(chainKey) === 'ik') {
                        const chainDef = IK_CHAINS[chainKey];
                        const effectorObj = this.ikController.effectors[chainDef.effector];
                        if (effectorObj) {
                            // Record state for undo before starting the drag
                            this.recordState();

                            // Setup screen-space direct dragging for IK
                            this.directDrag.active = true;
                            this.directDrag.chainKey = chainKey;
                            this.directDrag.effector = effectorObj;
                            this.directDrag.plane = new this.THREE.Plane();
                            this.directDrag.offset = new this.THREE.Vector3();
                            this.directDrag.hasDragged = false;
                            this.directDrag.clickedBone = bone;
                            this.directDrag.startClientX = e.clientX;
                            this.directDrag.startClientY = e.clientY;

                            const isMidJoint = (bone.name === chainDef.poleBone);
                            this.directDrag.targetType = isMidJoint ? 'midJoint' : 'effector';

                            if (isMidJoint) {
                                this.directDrag.midBone = bone;
                                this.directDrag.rootBone = this.boneList.find(b => b.name === chainDef.bones[chainDef.bones.indexOf(bone.name) - 1]);
                            }

                            // Create interaction plane facing camera
                            const cameraDir = new this.THREE.Vector3();
                            this.camera.getWorldDirection(cameraDir);
                            // Base the plane on the clicked bone depth (e.g. knee) to prevent wild parallax errors
                            const clickedBoneWorld = new this.THREE.Vector3();
                            bone.getWorldPosition(clickedBoneWorld);
                            this.directDrag.plane.setFromNormalAndCoplanarPoint(cameraDir, clickedBoneWorld);

                            const intersectPoint = new this.THREE.Vector3();
                            raycaster.ray.intersectPlane(this.directDrag.plane, intersectPoint);
                            if (intersectPoint) {
                                if (isMidJoint) {
                                    this.directDrag.offset.copy(clickedBoneWorld).sub(intersectPoint);
                                } else {
                                    this.directDrag.offset.copy(effectorObj.position).sub(intersectPoint);
                                }
                            }

                            this.orbit.enabled = false; // Disable orbit while direct dragging
                            this.hoveredBoneName = bone.name;
                            this.updateMarkers();

                            // Detach transform immediately so the gizmo doesn't glitch during IK solve
                            this.transform.detach();

                            this.canvas.setPointerCapture(e.pointerId);

                            // Important: don't attach TransformControls here, we handle movement in pointermove
                            if (this.selectedIKEffector) this.deselectIKEffector();
                            if (this.selectedPoleTarget) this.deselectPoleTarget();

                            return;
                        }
                    }
                }

                // Default: select bone for normal FK rotation
                this.selectBone(bone);
                return;
            }
        }

        // --- PASS 2: Fallback to Mesh Intersect ---
        // Useful if user clicks on the body near a joint but misses the sphere.
        const meshIntersects = raycaster.intersectObject(this.skinnedMesh, true);

        if (meshIntersects.length > 0) {
            const point = meshIntersects[0].point;
            let nearest = null;
            let minD = Infinity;

            const wPos = new this.THREE.Vector3();
            for (const b of this.boneList) {
                b.getWorldPosition(wPos);
                const d = point.distanceTo(wPos);
                if (d < minD) { minD = d; nearest = b; }
            }

            // Tighter threshold for mesh-based selection to avoid accidental jumps
            if (nearest && minD < 1.5) {
                nearest = this._resolveHandBone(nearest);
                const handSide = this._getHandSideFromBoneName(nearest?.name);
                if (handSide) {
                    if (this._isHandSurfaceActivation(handSide, point) && this.options.onHandActivate) {
                        this.options.onHandActivate({ side: handSide, boneName: nearest.name, clientX: e.clientX, clientY: e.clientY });
                    } else {
                        this.selectBone(nearest);
                    }
                    return;
                }

                if (this.ikMode && this.ikController) {
                    const chainKey = this.ikController.getChainForBone(nearest.name);
                    if (chainKey && this.ikController.getMode(chainKey) === 'ik') {
                        const chainDef = IK_CHAINS[chainKey];
                        const effectorObj = this.ikController.effectors[chainDef.effector];
                        if (effectorObj) {
                            // Record state for undo before starting the drag
                            this.recordState();

                            // Setup screen-space direct dragging for IK
                            this.directDrag.active = true;
                            this.directDrag.chainKey = chainKey;
                            this.directDrag.effector = effectorObj;
                            this.directDrag.plane = new this.THREE.Plane();
                            this.directDrag.offset = new this.THREE.Vector3();
                            this.directDrag.hasDragged = false;
                            this.directDrag.clickedBone = nearest;
                            this.directDrag.startClientX = e.clientX;
                            this.directDrag.startClientY = e.clientY;

                            const isMidJoint = (nearest.name === chainDef.poleBone);
                            this.directDrag.targetType = isMidJoint ? 'midJoint' : 'effector';

                            if (isMidJoint) {
                                this.directDrag.midBone = nearest;
                                this.directDrag.rootBone = this.boneList.find(b => b.name === chainDef.bones[chainDef.bones.indexOf(nearest.name) - 1]);
                            }

                            const cameraDir = new this.THREE.Vector3();
                            this.camera.getWorldDirection(cameraDir);

                            // Base the plane on the clicked bone depth (e.g. knee) to prevent wild parallax errors
                            const clickedBoneWorld = new this.THREE.Vector3();
                            nearest.getWorldPosition(clickedBoneWorld);
                            this.directDrag.plane.setFromNormalAndCoplanarPoint(cameraDir, clickedBoneWorld);

                            const intersectPoint = new this.THREE.Vector3();
                            raycaster.ray.intersectPlane(this.directDrag.plane, intersectPoint);
                            if (intersectPoint) {
                                if (isMidJoint) {
                                    this.directDrag.offset.copy(clickedBoneWorld).sub(intersectPoint);
                                } else {
                                    this.directDrag.offset.copy(effectorObj.position).sub(intersectPoint);
                                }
                            }

                            this.orbit.enabled = false;
                            this.hoveredBoneName = nearest.name;
                            this.updateMarkers();

                            // Detach transform immediately so the gizmo doesn't glitch during IK solve
                            this.transform.detach();

                            this.canvas.setPointerCapture(e.pointerId);

                            if (this.selectedIKEffector) this.deselectIKEffector();
                            if (this.selectedPoleTarget) this.deselectPoleTarget();
                            return;
                        }
                    }
                }

                // Default: select bone for normal FK rotation
                this.selectBone(nearest);
                return;
            }
        }

        // If nothing hit - deselect both bone and IK effector
        this.deselectBone();
        if (this.selectedIKEffector) {
            this.deselectIKEffector();
        }
    }

    handlePointerMove(e) {
        if (!this.initialized || !this.skinnedMesh) return;

        if (this.directDrag?.active && !this.directDrag.hasDragged) {
            const movedX = e.clientX - this.directDrag.startClientX;
            const movedY = e.clientY - this.directDrag.startClientY;
            if ((movedX * movedX + movedY * movedY) > 9) {
                this.directDrag.hasDragged = true;
            }
        }

        const rect = this.canvas.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        const raycaster = new this.THREE.Raycaster();
        raycaster.setFromCamera(new this.THREE.Vector2(x, y), this.camera);

        // Process Direct Limb Dragging updates IK effector seamlessly in screen space
        if (this.directDrag && this.directDrag.active) {
            const intersectPoint = new this.THREE.Vector3();
            raycaster.ray.intersectPlane(this.directDrag.plane, intersectPoint);

            if (intersectPoint) {
                if (this.directDrag.targetType === 'midJoint') {
                    // Dragging knee/elbow swivels the parent hip/shoulder directly
                    const targetPos = intersectPoint.add(this.directDrag.offset);
                    const rootBone = this.directDrag.rootBone;
                    const midBone = this.directDrag.midBone;

                    if (rootBone && midBone) {


                        const midWorld = new this.THREE.Vector3();
                        midBone.getWorldPosition(midWorld);



                        // Pivot parent to place midBone perfectly on mouse cursor
                        const analytic = this.ikController.ccdSolver.analyticSolver;
                        analytic.rotateBoneToPoint(rootBone, midWorld, targetPos, this.THREE);
                        rootBone.updateMatrixWorld(true);
                        if (this.skeleton) this.skeleton.update();

                        // Snap true IK foot/hand effector target to its new dragged-along position
                        const chainDef = IK_CHAINS[this.directDrag.chainKey];
                        const trueEffectorBone = this.boneList.find(b => b.name === chainDef.effector);
                        if (trueEffectorBone && this.directDrag.effector) {
                            trueEffectorBone.getWorldPosition(this.directDrag.effector.position);
                        }

                        // Vital to manually request redraw in ThreeJS when modifying transform directly outside solver
                        this.updateMarkers();
                        this.requestRender();
                    }
                } else {
                    // Standard Hand/Foot Effector Drag
                    const effectorTargetPos = intersectPoint.add(this.directDrag.offset);
                    this.directDrag.effector.position.copy(effectorTargetPos);

                    this.selectedIKEffector = this.directDrag.effector;
                    this.solveIKForEffector();
                }
            }
            return;
        }

        // --- HOVER LOGIC ---
        // Stop expensive raycasting if the user is holding ANY button (like right-click panning)
        if (e.buttons !== 0) return;

        // Skip hover if we are dragging via TransformControls
        if (this.transform.dragging) {
            if (this.hoveredBoneName || this._hoveredHandSide) {
                this.hoveredBoneName = null;
                this._updateHoveredHand(null);
                this.updateMarkers();
            }
            return;
        }

        let hitBone = null;
        let hoveredHandSide = null;

        const markerIntersects = raycaster.intersectObjects(this._getRaycastableJointMarkers(), false);
        if (markerIntersects.length > 0) {
            markerIntersects.sort((a, b) => a.distance - b.distance);
            const hitMarker = markerIntersects[0].object;
            const boneIdx = hitMarker.userData?.boneIndex;
            if (boneIdx !== -1 && this.boneList[boneIdx]) {
                hitBone = this.boneList[boneIdx];
            }
        } else {
            const meshIntersects = raycaster.intersectObject(this.skinnedMesh, true);
            if (meshIntersects.length > 0) {
                const point = meshIntersects[0].point;
                let nearest = null;
                let minD = Infinity;

                const wPos = new this.THREE.Vector3();
                for (const b of this.boneList) {
                    b.getWorldPosition(wPos);
                    const d = point.distanceTo(wPos);
                    if (d < minD) { minD = d; nearest = b; }
                }

                if (nearest && minD < 1.5) {
                    const resolvedBone = this._resolveHandBone(nearest);
                    const handSide = this._getHandSideFromBoneName(resolvedBone?.name);
                    if (handSide && this._isHandSurfaceActivation(handSide, point)) {
                        hoveredHandSide = handSide;
                    } else {
                        hitBone = nearest;
                    }
                }
            }
        }

        const newHoveredName = hitBone ? hitBone.name : null;
        if (this.hoveredBoneName !== newHoveredName || this._hoveredHandSide !== hoveredHandSide) {
            this.hoveredBoneName = newHoveredName;
            this._updateHoveredHand(hoveredHandSide);
            this.updateMarkers();
            this.requestRender();
        }
    }

    handlePointerUp(e) {
        if (!this.initialized || !this.skinnedMesh) return;

        if (this.directDrag && this.directDrag.active) {
            const dragged = !!this.directDrag.hasDragged;
            const clickedBone = this.directDrag.clickedBone || null;
            this.directDrag.active = false;
            this.directDrag.effector = null;
            this.directDrag.chainKey = null;
            this.directDrag.clickedBone = null;
            this.directDrag.hasDragged = false;
            this.directDrag.startClientX = 0;
            this.directDrag.startClientY = 0;
            this.orbit.enabled = true; // Restore orbit

            if (this.canvas.hasPointerCapture(e.pointerId)) {
                this.canvas.releasePointerCapture(e.pointerId);
            }

            // The solver temporarily set selectedIKEffector, clear it now that drag is done
            if (this.selectedIKEffector) {
                this.selectedIKEffector = null;
            }

            // Trigger sync to update node output after IK drag
            this.isInteractionActive = false;

            if (this.options.onInteractionEnd) {
                this.options.onInteractionEnd({ type: 'ik' });
            }
            this.dispatchPoseChange();

            this.transform.detach();
            if (dragged) {
                this.selectedBone = null;
                this.hoveredBoneName = null;
                this.updateMarkers();
            } else if (clickedBone) {
                this.selectBone(clickedBone);
            }

            return;
        }
    }

    selectBone(bone) {
        if (this.selectedBone === bone) return;
        this.selectedBone = bone;

        // Attach transform for rotation (FK)
        this.transform.setMode("rotate");
        this.transform.attach(bone);
        this.updateMarkers();

        // Ensure IK effector is deselected if we just want FK bone rotation
        if (this.selectedIKEffector) {
            this.selectedIKEffector = null;
        }
    }

    deselectBone() {
        if (!this.selectedBone) return;
        this.selectedBone = null;
        this.transform.detach();
        this.updateMarkers();
    }

    // === IK Methods ===
    initIK() {
        if (!this.THREE) return;
        this.ikController = new IKController(this.THREE);

    }

    selectIKEffector(effectorMesh) {
        // Select the object and attach translation gizmo (IK)
        this.selectedIKEffector = effectorMesh;

        this.selectedPoleTarget = null;

        // Attach transform to the effector mesh (translate mode)
        this.transform.setMode("translate");
        this.transform.attach(effectorMesh);

        // Update markers to show chain selection
        this.updateMarkers();


    }

    deselectIKEffector() {
        if (this.selectedIKEffector) {
            this.selectedIKEffector = null;
        }
        this.transform.detach();
        this.transform.setMode("rotate");
        this.updateMarkers();
    }

    selectPoleTarget(poleMesh) {
        this.selectedPoleTarget = poleMesh;

        // Deselect effector if selected
        if (this.selectedIKEffector) {
            this.selectedIKEffector = null;
        }

        this.selectedPoleTarget = poleMesh;
        poleMesh.material.color.setHex(0xffff00); // Yellow when selected

        // Attach transform to the pole mesh (translate mode)
        this.transform.setMode("translate");
        this.transform.attach(poleMesh);
        const chainKey = poleMesh.userData.chainKey;
        if (chainKey) {
            const chainDef = IK_CHAINS[chainKey];
            if (chainDef && chainDef.effector) {
                const effectorBone = this.bones[chainDef.effector];
                const effector = this.ikController.effectors[chainDef.effector];
                if (effectorBone && effector) {
                    const bonePos = new this.THREE.Vector3();
                    effectorBone.getWorldPosition(bonePos);
                    effector.position.copy(bonePos);
                }
            }
        }

        // Attach transform to the pole target mesh (translate mode)
        this.transform.setMode("translate");
        this.transform.attach(poleMesh);

        // Deselect any bone and update markers
        if (this.selectedBone) {
            this.selectedBone = null;
            this.updateMarkers();
        }


    }

    deselectPoleTarget() {
        if (this.selectedPoleTarget) {
            this.selectedPoleTarget.material.color.setHex(0xff8800);
            this.selectedPoleTarget = null;
        }
        this.transform.detach();
        this.transform.setMode("rotate");
        this.updateMarkers();
    }

    solveIKForEffector() {
        if (!this.ikController || !this.selectedIKEffector || !this.THREE) return;

        const effectorName = this.selectedIKEffector.userData.effectorName;
        const chainKey = this.selectedIKEffector.userData.chainKey;

        if (!effectorName || !chainKey) return;

        // Check if this chain is active for IK
        if (this.ikController.getMode(chainKey) !== 'ik') {

            return;
        }

        // Get target position from effector mesh
        const targetPos = this.selectedIKEffector.position.clone();

        // Solve IK with pole target support
        const chainDef = IK_CHAINS[chainKey];
        if (!chainDef) return;

        // Special handling for root effectors (hips) - translate and solve leg IK
        if (chainDef.isRoot) {
            const effectorBone = this.bones[chainDef.effector];
            if (effectorBone) {
                // Store foot positions BEFORE moving hip (for leg IK solving)
                const footPositions = {};
                if (chainDef.affectedLegs) {
                    for (const legKey of chainDef.affectedLegs) {
                        const legDef = IK_CHAINS[legKey];
                        if (legDef && this.ikController.getMode(legKey) === 'ik') {
                            const footBone = this.bones[legDef.effector];
                            if (footBone) {
                                const footPos = new this.THREE.Vector3();
                                footBone.getWorldPosition(footPos);
                                footPositions[legKey] = footPos;
                            }
                        }
                    }
                }

                // Get the difference
                const bonePos = new this.THREE.Vector3();
                effectorBone.getWorldPosition(bonePos);

                // Apply target world position to bone by converting to parent-local space
                const localTarget = targetPos.clone();
                if (effectorBone.parent) {
                    effectorBone.parent.worldToLocal(localTarget);
                }
                effectorBone.position.copy(localTarget);
                effectorBone.updateMatrixWorld(true);

                // Solve IK for affected legs to keep feet in place
                // Multiple passes for better accuracy
                if (chainDef.affectedLegs && this.ikController.ccdSolver) {
                    const rootBone = this.boneList.find(b => !b.userData.parentName || !this.bones[b.userData.parentName]);
                    const rootY = rootBone ? (() => {
                        const position = new this.THREE.Vector3();
                        rootBone.getWorldPosition(position);
                        return position.y;
                    })() : 0;

                    for (const legKey of chainDef.affectedLegs) {
                        const footTarget = footPositions[legKey];
                        if (footTarget) {
                            footTarget.y = Math.max(rootY, footTarget.y);
                        }
                    }

                    for (let pass = 0; pass < 3; pass++) { // Multiple passes
                        for (const legKey of chainDef.affectedLegs) {
                            const legDef = IK_CHAINS[legKey];
                            const footTarget = footPositions[legKey];

                            if (legDef && footTarget && this.ikController.getMode(legKey) === 'ik') {
                                // Solve leg IK to keep foot at original position
                                this.ikController.solveWithPole(legDef, this.bones, footTarget, legKey);
                            }
                        }
                        // Update matrix world between passes
                        for (const bone of this.boneList) {
                            bone.updateMatrixWorld(true);
                        }
                    }
                }

                // Update skeleton and mesh
                if (this.skeleton) {
                    this.skeleton.update();
                }
                if (this.skinnedMesh) {
                    this.skinnedMesh.updateMatrixWorld(true);
                }

                // Update all other IK effector positions since root moved
                this.updateIKEffectorPositions();

                // Update hip effector position to match new hip position
                const newHipPos = new this.THREE.Vector3();
                effectorBone.getWorldPosition(newHipPos);
                this.selectedIKEffector.position.copy(newHipPos);
            }

            // Don't update pole target positions - they should stay where user placed them
        } else if (this.ikController.ccdSolver) {
            // Standard IK solve for limbs
            this.ikController.solveWithPole(chainDef, this.bones, targetPos, chainKey);

            // Update skeleton after IK solve
            if (this.skeleton) {
                this.skeleton.update();
            }

            // Update skinnedMesh matrix
            if (this.skinnedMesh) {
                this.skinnedMesh.updateMatrixWorld(true);
            }

            // Don't update pole target positions - they should stay where user placed them
        }

        this.requestRender();
    }

    solveIKForPoleTarget() {
        // Called when pole target is moved - re-solve IK for the chain
        if (!this.ikController || !this.selectedPoleTarget || !this.THREE) return;

        const chainKey = this.selectedPoleTarget.userData.chainKey;
        if (!chainKey) return;

        const chainDef = IK_CHAINS[chainKey];
        if (!chainDef) return;

        // Get effector position from the effector mesh
        const effector = this.ikController.effectors[chainDef.effector];
        if (!effector) return;

        const targetPos = effector.position.clone();

        // Solve IK with the moved pole target
        if (this.ikController.ccdSolver) {
            this.ikController.solveWithPole(chainDef, this.bones, targetPos, chainKey);

            // Update skeleton after IK solve
            if (this.skeleton) {
                this.skeleton.update();
            }

            // Update skinnedMesh matrix
            if (this.skinnedMesh) {
                this.skinnedMesh.updateMatrixWorld(true);
            }

            this.requestRender();
        }
    }

    setIKMode(enabled) {
        this.ikMode = enabled;

        // Deselect any IK effector when switching modes
        if (!enabled && this.selectedIKEffector) {
            this.deselectIKEffector();
        }

        // Deselect any pole target when switching modes
        if (!enabled && this.selectedPoleTarget) {
            this.deselectPoleTarget();
        }

        // Ensure transform is in rotate mode for FK
        if (!enabled && this.transform) {
            this.transform.setMode("rotate");
        }

        // Update effector visibility
        this.updateIKEffectorVisibility();
        // Update pole target visibility
        this.updatePoleTargetVisibility();

        // Force immediate render
        if (this.renderer && this.scene && this.camera) {
            this.renderer.render(this.scene, this.camera);
        }
    }

    setShoulderIKEnabled(enabled) {
        this.shoulderIKEnabled = enabled;
        this.updateIKEffectorVisibility();
        this.requestRender();
    }

    updateIKEffectorVisibility() {
        if (!this.ikController) return;

        for (const [name, effector] of Object.entries(this.ikController.effectors)) {
            // Only show effector if IK mode is on AND the chain is active
            const chainKey = this.ikController.getChainForEffector(name);
            const chainActive = chainKey && this.ikController.getMode(chainKey) === 'ik';
            const shoulderVisible = !chainKey || !IK_CHAINS[chainKey]?.isShoulder || this.shoulderIKEnabled;
            effector.visible = this.ikMode && chainActive && shoulderVisible;
        }
    }

    updatePoleTargetVisibility() {
        if (!this.ikController) return;

        for (const [chainKey, poleTarget] of Object.entries(this.ikController.poleTargets)) {
            // Only show pole target if IK mode is on, chain is active, and pole is enabled
            const chainActive = this.ikController.getMode(chainKey) === 'ik';
            const poleEnabled = this.ikController.getPoleMode(chainKey) === 'on';
            poleTarget.visible = this.ikMode && chainActive && poleEnabled;
        }
    }

    ensurePoleTargetsCreated() {
        if (!this.ikController || !this.THREE || !this.scene || !this.bones) return;

        for (const [chainKey, chainDef] of Object.entries(IK_CHAINS)) {
            if (chainDef.poleBone && !this.ikController.poleTargets[chainKey]) {
                this.createPoleTargetForChain(chainKey, chainDef);
            }
        }
        this.requestRender();
    }

    _calculatePolePosition(chainKey, chainDef) {
        const poleBone = this.bones[chainDef.poleBone];
        if (!poleBone) return null;

        const polePos = new this.THREE.Vector3();
        poleBone.getWorldPosition(polePos);

        const isArm = chainKey.includes('Arm');
        const isLeft = chainKey.includes('left');

        const rootBoneName = chainDef.bones[0];
        const rootBone = this.bones[rootBoneName];

        if (rootBone) {
            const rootPos = new this.THREE.Vector3();
            rootBone.getWorldPosition(rootPos);
            const limbDir = polePos.clone().sub(rootPos).normalize();
            const worldUp = new this.THREE.Vector3(0, 1, 0);

            let outDir = new this.THREE.Vector3().crossVectors(limbDir, worldUp);
            if (outDir.lengthSq() < 0.001) {
                outDir = new this.THREE.Vector3(isLeft ? 1 : -1, 0, 0);
            }
            outDir.normalize();

            const sideOffset = isLeft ? 1 : -1;
            if (isArm) {
                const outwardOffset = outDir.clone().multiplyScalar(sideOffset * 1.0);
                const forwardOffset = new this.THREE.Vector3(0, 0, -0.8);
                polePos.add(outwardOffset).add(forwardOffset);
            } else {
                const outwardOffset = outDir.clone().multiplyScalar(sideOffset * 0.3);
                const forwardOffset = new this.THREE.Vector3(0, 0, 0.5);
                polePos.add(outwardOffset).add(forwardOffset);
            }
        }
        return polePos;
    }

    updatePoleTargetPositions() {
        if (!this.ikController || !this.THREE || !this.bones) return;

        for (const [chainKey, chainDef] of Object.entries(IK_CHAINS)) {
            if (!chainDef.poleBone) continue;
            const poleTarget = this.ikController.poleTargets[chainKey];
            if (!poleTarget || poleTarget === this.selectedPoleTarget) continue;
            if (this.ikController.isPoleTargetEnabled(chainKey)) continue;

            const polePos = this._calculatePolePosition(chainKey, chainDef);
            if (polePos) poleTarget.position.copy(polePos);
        }
    }

    createPoleTargetForChain(chainKey, chainDef) {
        const polePos = this._calculatePolePosition(chainKey, chainDef);
        if (!polePos) return;

        const poleBone = this.bones[chainDef.poleBone];
        const poleHelper = this.ikController.createPoleTargetHelper(chainKey, poleBone, this.THREE);
        poleHelper.position.copy(polePos);

        const chainActive = this.ikController.getMode(chainKey) === 'ik';
        const poleEnabled = this.ikController.getPoleMode(chainKey) === 'on';
        poleHelper.visible = this.ikMode && chainActive && poleEnabled;

        this.scene.add(poleHelper);

    }

    createIKEffectorHelpers() {
        if (!this.ikController || !this.THREE || !this.scene) return;

        // Clean up old effectors
        for (const [name, effector] of Object.entries(this.ikController.effectors)) {
            this.scene.remove(effector);
        }
        this.ikController.effectors = {};

        // Clean up old pole targets
        for (const [key, poleTarget] of Object.entries(this.ikController.poleTargets)) {
            this.scene.remove(poleTarget);
        }
        this.ikController.poleTargets = {};

        // Find the root bone (bone without parent) for hips IK
        // Then use its FIRST CHILD as the hips effector (pelvis/hip bone)
        let rootBoneName = null;
        let rootBone = null;

        // Debug: log all bones and their parents


        // Find the root bone (no parent)
        for (const bone of this.boneList) {
            const pName = bone.userData.parentName;
            if (!pName || !this.bones[pName]) {
                rootBone = bone;
                rootBoneName = bone.name;

                break;
            }
        }

        // Now find the FIRST CHILD of root bone - this is the hips/pelvis
        let hipsBone = null;
        let hipsBoneName = null;

        if (rootBone) {
            for (const bone of this.boneList) {
                if (bone.userData.parentName === rootBoneName) {
                    hipsBone = bone;
                    hipsBoneName = bone.name;

                    break;
                }
            }
        }

        // Fallback to root if no child found
        if (!hipsBone && rootBone) {
            hipsBone = rootBone;
            hipsBoneName = rootBoneName;

        }

        let createdCount = 0;
        for (const [chainKey, chainDef] of Object.entries(IK_CHAINS)) {
            // Special handling for hips - use dynamically found hips bone (child of root)
            let effectorBone;
            let effectorName;

            if (chainDef.isRootBone) {
                effectorBone = hipsBone;
                effectorName = hipsBoneName;
                // Store the found effector name in chainDef for later use
                chainDef.effector = effectorName;
                chainDef.bones = [effectorName];
            } else {
                effectorName = chainDef.effector;
                effectorBone = this.bones[effectorName];
            }

            if (effectorBone) {
                // Create effector at bone position
                const bonePos = new this.THREE.Vector3();
                effectorBone.getWorldPosition(bonePos);

                const isRoot = chainDef.isRoot || false;
                const helper = this.ikController.createEffectorHelper(effectorName, effectorBone, this.THREE, isRoot);
                helper.userData.effectorName = effectorName;
                helper.userData.chainKey = chainKey;

                // Check if this chain is active for IK
                const chainActive = this.ikController.getMode(chainKey) === 'ik';
                helper.visible = this.ikMode && chainActive;

                // Position in world space (not attached to bone)
                helper.position.copy(bonePos);

                this.scene.add(helper);
                createdCount++;
            }

            // Create pole target for chains that have poleBone defined
            if (chainDef.poleBone && !this.ikController.poleTargets[chainKey]) {
                this.createPoleTargetForChain(chainKey, chainDef);
            }
        }

    }

    updateIKEffectorPositions(mode = 'nonSelected') {
        if (!this.ikController || !this.THREE) return;

        for (const [chainKey, chainDef] of Object.entries(IK_CHAINS)) {
            const effector = this.ikController.effectors[chainDef.effector];
            if (!effector) continue;

            const isSelected = (effector === this.selectedIKEffector);
            if (mode === 'nonSelected' && isSelected) continue;
            if (mode === 'selectedOnly' && !isSelected) continue;

            const effectorBone = this.bones[chainDef.effector];
            if (effectorBone) {
                const bonePos = new this.THREE.Vector3();
                effectorBone.getWorldPosition(bonePos);
                effector.position.copy(bonePos);
            }
        }
    }

    updateMarkers() {
        if (!this.markerMatNormal || !this.markerMatSelected || !this.markerMatHandHover) return;

        let highlightedBones = new Set();

        // Add selected bone and its chain
        if (this.selectedBone) {
            highlightedBones.add(this.selectedBone.name);
            if (this.ikMode && this.ikController) {
                const chainKey = this.ikController.getChainForBone(this.selectedBone.name);
                if (chainKey && this.ikController.getMode(chainKey) === 'ik') {
                    const chainDef = IK_CHAINS[chainKey];
                    if (chainDef.bones) chainDef.bones.forEach(b => highlightedBones.add(b));
                    highlightedBones.add(chainDef.effector);
                }
            }
        }

        // Add hovered bone and its chain (if it doesn't overlap with selection)
        let hoveredBones = new Set();
        if (this.hoveredBoneName) {
            hoveredBones.add(this.hoveredBoneName);
            if (this.ikMode && this.ikController) {
                const chainKey = this.ikController.getChainForBone(this.hoveredBoneName);
                if (chainKey && this.ikController.getMode(chainKey) === 'ik') {
                    const chainDef = IK_CHAINS[chainKey];
                    if (chainDef.bones) chainDef.bones.forEach(b => hoveredBones.add(b));
                    hoveredBones.add(chainDef.effector);
                }
            }
        }

        for (let i = 0; i < this.jointMarkers.length; i++) {
            const marker = this.jointMarkers[i];
            const bone = this.boneList[marker.userData?.boneIndex];
            const isSelected = bone && highlightedBones.has(bone.name);
            const isHovered = bone && hoveredBones.has(bone.name);
            const isHandHovered = bone && this._getHandSideFromBoneName(bone.name) && this._hoveredHandSide === this._getHandSideFromBoneName(bone.name);

            // Give precedence to selected over hovered
            marker.material = isSelected
                ? this.markerMatSelected
                : isHandHovered
                    ? this.markerMatHandHover
                    : isHovered
                        ? this.markerMatSelected
                        : this.markerMatNormal;

            if (isSelected) {
                marker.scale.setScalar(1.5);
                marker.renderOrder = 999;
            } else if (isHandHovered) {
                marker.scale.setScalar(1.4);
                marker.renderOrder = 700;
            } else if (isHovered) {
                marker.scale.setScalar(1.25);
                marker.renderOrder = 500;
            } else {
                marker.scale.setScalar(1.0);
                marker.renderOrder = 1;
            }
        }
    }

    resize(w, h) {
        this.width = w;
        this.height = h;
        // Pass false to NOT update canvas CSS style (CSS 100% rule handles that).
        // This prevents layout thrashing in ComfyUI node2.0 mode.
        if (this.renderer) this.renderer.setSize(w, h, false);
        if (this.camera) {
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
        }
        this.requestRender();
    }

    loadData(data, keepCamera = false) {
        if (!this.initialized || !this.THREE || !this.scene) {
            this.pendingData = { data, keepCamera };
            return;
        }
        if (!data || !data.vertices || !data.bones) return;

        this._cleanupPrevious();

        const { geometry, vertices, indices } = this._initMeshGeometry(data);
        const THREE = this.THREE;

        // Center camera
        geometry.computeBoundingBox();
        const center = geometry.boundingBox.getCenter(new THREE.Vector3());
        this.meshCenter = center.clone();
        const size = geometry.boundingBox.getSize(new THREE.Vector3());
        if (!keepCamera && size.length() > 0.1 && this.orbit) {
            this.orbit.target.copy(center);
            const dist = size.length() * 1.5;
            const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
            if (dir.lengthSq() < 0.001) dir.set(0, 0, 1);
            this.camera.position.copy(this.orbit.target).add(dir.multiplyScalar(dist));
            this.orbit.update();
        }

        this._initSkeleton(data, geometry, vertices);
        this._createJointMarkers();

        // Apply cached bone scales
        if (this.headScale !== 1.0) {
            this.updateHeadScale(this.headScale);
        }
        if (this.armScale !== 1.0) {
            this.updateArmScale(this.armScale);
        }
        if (this.handScale !== 1.0) {
            this.updateHandScale(this.handScale);
        }

        this._initIKHelpers();
        this.requestRender();
    }

    _cleanupPrevious() {
        if (this.skinnedMesh) {
            this.scene.remove(this.skinnedMesh);
            this.skinnedMesh.geometry.dispose();
            this.skinnedMesh.material.dispose();
            if (this.skeletonHelper) this.scene.remove(this.skeletonHelper);
        }
        if (this.jointMarkers) {
            this.jointMarkers.forEach(m => {
                if (m.parent) m.parent.remove(m);
                // Geometries are shared, but material might need disposal if unique
                if (m.material && m.material.dispose && !m.userData.sharedMaterial) m.material.dispose();
            });
        }
        this.jointMarkers = [];
    }

    _initMeshGeometry(data) {
        const vertices = new Float32Array(data.vertices);
        const indices = new Uint32Array(data.indices);
        const geometry = new this.THREE.BufferGeometry();
        geometry.setAttribute('position', new this.THREE.BufferAttribute(vertices, 3));
        geometry.setIndex(new this.THREE.BufferAttribute(indices, 1));
        geometry.computeVertexNormals();
        return { geometry, vertices, indices };
    }

    _initSkeleton(data, geometry, vertices) {
        const THREE = this.THREE;
        this.bones = {};
        this.boneList = [];
        const rootBones = [];

        for (const bData of data.bones) {
            const bone = new THREE.Bone();
            bone.name = bData.name;
            bone.userData = { headPos: bData.headPos, parentName: bData.parent };
            bone.position.set(bData.headPos[0], bData.headPos[1], bData.headPos[2]);
            this.bones[bone.name] = bone;
            this.boneList.push(bone);
        }

        for (const bone of this.boneList) {
            const pName = bone.userData.parentName;
            if (pName && this.bones[pName]) {
                const parent = this.bones[pName];
                parent.add(bone);
                const pHead = parent.userData.headPos;
                const cHead = bone.userData.headPos;
                bone.position.set(cHead[0] - pHead[0], cHead[1] - pHead[1], cHead[2] - pHead[2]);
            } else {
                rootBones.push(bone);
            }
        }

        this.initialBoneStates = {};
        for (const bone of this.boneList) {
            this.initialBoneStates[bone.name] = {
                position: bone.position.clone(),
                rotation: bone.rotation.clone()
            };
        }

        this.skeleton = new THREE.Skeleton(this.boneList);

        const vCount = vertices.length / 3;
        const skinInds = new Float32Array(vCount * 4);
        const skinWgts = new Float32Array(vCount * 4);
        const boneHeads = this.boneList.map(b => b.userData.headPos);

        if (data.weights) {
            const vWeights = new Array(vCount).fill(null).map(() => []);
            const boneMap = {};
            this.boneList.forEach((b, i) => boneMap[b.name] = i);

            for (const [bName, wData] of Object.entries(data.weights)) {
                if (boneMap[bName] === undefined) continue;
                const bIdx = boneMap[bName];
                const wInds = wData.indices;
                const wVals = wData.weights;
                for (let i = 0; i < wInds.length; i++) {
                    const vi = wInds[i];
                    if (vi < vCount) vWeights[vi].push({ b: bIdx, w: wVals[i] });
                }
            }

            for (let v = 0; v < vCount; v++) {
                const vw = vWeights[v];
                vw.sort((a, b) => b.w - a.w);
                let tot = 0;
                for (let i = 0; i < 4 && i < vw.length; i++) {
                    skinInds[v * 4 + i] = vw[i].b;
                    skinWgts[v * 4 + i] = vw[i].w;
                    tot += vw[i].w;
                }
                if (tot > 0) {
                    for (let i = 0; i < 4; i++) skinWgts[v * 4 + i] /= tot;
                } else {
                    const vx = vertices[v * 3];
                    const vy = vertices[v * 3 + 1];
                    const vz = vertices[v * 3 + 2];
                    let nearestIdx = 0;
                    let minDistSq = Infinity;
                    for (let bi = 0; bi < boneHeads.length; bi++) {
                        const h = boneHeads[bi];
                        const dx = vx - h[0], dy = vy - h[1], dz = vz - h[2];
                        const dSq = dx * dx + dy * dy + dz * dz;
                        if (dSq < minDistSq) { minDistSq = dSq; nearestIdx = bi; }
                    }
                    skinInds[v * 4] = nearestIdx;
                    skinWgts[v * 4] = 1;
                }
            }
        }

        geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinInds, 4));
        geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWgts, 4));

        if (data.uvs && data.uvs.length > 0) {
            geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(data.uvs), 2));
        }

        const skinType = this.currentSkinType || "dummy_white";
        const skinFile = {
            "naked": "skin.png",
            "naked_marks": "skin_marks.png",
            "dummy_white": "skin_dummy.png"
        }[skinType] || "skin_dummy.png";

        let skinTex;
        if (this.cachedSkinTexture && this.cachedSkinType === skinType) {
            skinTex = this.cachedSkinTexture;
        } else {
            const texLoader = new THREE.TextureLoader();
            skinTex = texLoader.load(`${EXTENSION_URL}textures/${skinFile}?v=${Date.now()}`,
                (tex) => this.requestRender(),
                undefined,
                (err) => console.error("Texture failed to load", err)
            );
            this.cachedSkinTexture = skinTex;
            this.cachedSkinType = skinType;
        }

        const material = new THREE.MeshPhongMaterial({
            map: skinTex, color: 0xffffff, specular: 0x111111, shininess: 5, side: THREE.DoubleSide
        });

        material.onBeforeCompile = (shader) => {
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <dithering_fragment>',
                `
                #include <dithering_fragment>
                float rim = 1.0 - abs(vNormal.z);
                gl_FragColor.rgb *= (1.0 - pow(rim, 3.0) * 0.4);
                `
            );
        };

        this.skinnedMesh = new THREE.SkinnedMesh(geometry, material);
        rootBones.forEach(b => this.skinnedMesh.add(b));
        this.skinnedMesh.bind(this.skeleton);
        this.scene.add(this.skinnedMesh);

        this.skeletonHelper = new THREE.SkeletonHelper(this.skinnedMesh);
        this.scene.add(this.skeletonHelper);
    }

    _createJointMarkers() {
        if (!this.boneList) return;
        const THREE = this.THREE;
        if (!this.markerGeoNormal) this.markerGeoNormal = new THREE.SphereGeometry(0.12, 8, 8);
        if (!this.markerGeoFinger) this.markerGeoFinger = new THREE.SphereGeometry(0.06, 6, 6);

        if (!this.markerMatNormal) {
            this.markerMatNormal = new THREE.MeshBasicMaterial({
                color: 0xffaa00, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false
            });
        }
        if (!this.markerMatSelected) {
            this.markerMatSelected = new THREE.MeshBasicMaterial({
                color: 0x00ffff, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false
            });
        }
        if (!this.markerMatHandHover) {
            this.markerMatHandHover = new THREE.MeshBasicMaterial({
                color: 0xffd666, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false
            });
        }

        for (let i = 0; i < this.boneList.length; i++) {
            const bone = this.boneList[i];
            const isFinger = this._isFingerHandBoneName(bone.name);
            const sphere = new THREE.Mesh(isFinger ? this.markerGeoFinger : this.markerGeoNormal, this.markerMatNormal);
            sphere.userData.boneIndex = i;
            sphere.userData.sharedMaterial = true;
            sphere.renderOrder = 999;
            sphere.visible = this._shouldMarkerBeVisible(sphere);
            bone.add(sphere);
            sphere.position.set(0, 0, 0);
            this.jointMarkers.push(sphere);
        }
    }

    _initIKHelpers() {
        if (!this.ikController) this.initIK();
        if (this.ikController) this.createIKEffectorHelpers();

    }

    updateHeadScale(scale) {
        this.headScale = scale;
        const headBone = this.boneList.find(b => b.name.toLowerCase().includes('head'));
        if (headBone) {
            headBone.scale.set(scale, scale, scale);
            this.requestRender();
        }
    }

    updateArmScale(scale) {
        this.armScale = scale;
        for (const bone of this.boneList) {
            const n = bone.name.toLowerCase();
            if (n === 'upperarm_l' || n === 'upperarm_r') {
                bone.scale.set(scale, scale, scale);
            }
        }
        this.requestRender();
    }

    updateHandScale(scale) {
        this.handScale = scale;
        for (const bone of this.boneList) {
            const n = bone.name.toLowerCase();
            if (n === 'hand_l' || n === 'hand_r') {
                bone.scale.set(scale, scale, scale);
            }
        }
        this.requestRender();
    }

    setSkinTexture(skinType) {
        this.currentSkinType = skinType;
        if (!this.skinnedMesh) return;

        // Check configuration bypass flags to protect embedding apps (e.g WebGL Error Contexts)
        if (!this.options.enableTextureSkinning || this.options.skinMode === 'flat_color') {
            if (this.skinnedMesh.material.map) {
                this.skinnedMesh.material.map.dispose();
                this.skinnedMesh.material.map = null;
            }
            this.skinnedMesh.material.color.setHex(0xaaaaaa);
            this.skinnedMesh.material.needsUpdate = true;
            this.requestRender();
            return;
        }

        const skinFile = {
            "naked": "skin.png",
            "naked_marks": "skin_marks.png",
            "dummy_white": "skin_dummy.png"
        }[skinType] || "skin_dummy.png";

        const THREE = this.THREE;
        const texLoader = new THREE.TextureLoader();
        texLoader.load(`${EXTENSION_URL}textures/${skinFile}?v=${Date.now()}`,
            (tex) => {
                // Dispose old texture to prevent memory leaks
                if (this.skinnedMesh.material.map) {
                    this.skinnedMesh.material.map.dispose();
                }
                this.skinnedMesh.material.map = tex;
                this.skinnedMesh.material.needsUpdate = true;
                this.cachedSkinTexture = tex;
                this.cachedSkinType = skinType;

                this.requestRender();
            },
            undefined,
            (err) => console.error(`Failed to load skin texture: ${skinFile}`, err)
        );
    }

    // === Pose State Management ===

    getPose() {
        const bones = {};
        for (const b of this.boneList) {
            const rot = b.rotation;
            if (Math.abs(rot.x) > 1e-4 || Math.abs(rot.y) > 1e-4 || Math.abs(rot.z) > 1e-4) {
                bones[b.name] = [
                    rot.x * 180 / Math.PI,
                    rot.y * 180 / Math.PI,
                    rot.z * 180 / Math.PI
                ];
            }
        }

        // Save IK effector positions
        const ikEffectorPositions = {};
        if (this.ikController) {
            for (const [name, effector] of Object.entries(this.ikController.effectors)) {
                ikEffectorPositions[name] = [effector.position.x, effector.position.y, effector.position.z];
            }
        }

        // Save pole target positions
        const poleTargetPositions = {};
        if (this.ikController) {
            for (const [chainKey, pole] of Object.entries(this.ikController.poleTargets)) {
                poleTargetPositions[chainKey] = [pole.position.x, pole.position.y, pole.position.z];
            }
        }

        // Save hip bone position (for hips IK)
        const hipBonePosition = {};
        if (this.initialBoneStates) {
            for (const chainKey of Object.keys(IK_CHAINS)) {
                const chainDef = IK_CHAINS[chainKey];
                if (chainDef.isRoot && chainDef.effector) {
                    const hipBone = this.bones[chainDef.effector];
                    if (hipBone) {
                        hipBonePosition[chainKey] = [hipBone.position.x, hipBone.position.y, hipBone.position.z];
                    }
                }
            }
        }

        return {
            bones,
            modelRotation: [this.modelRotation.x, this.modelRotation.y, this.modelRotation.z],
            camera: {
                posX: this.camera.position.x,
                posY: this.camera.position.y,
                posZ: this.camera.position.z,
                targetX: this.orbit.target.x,
                targetY: this.orbit.target.y,
                targetZ: this.orbit.target.z
            },
            // Store widget-side camera params too!
            cameraParams: this.cameraParams,
            // IK effector positions
            ikEffectorPositions,
            // Pole target positions
            poleTargetPositions,
            // Hip bone positions (for undo)
            hipBonePosition
        };
    }

    recordState() {
        const state = this.getPose();
        // Avoid duplicate states if possible, but for drag start it's fine
        this.history.push(JSON.stringify(state));
        if (this.history.length > this.maxHistory) {
            this.history.shift();
        }
        this.future = []; // Clear redo stack on new action
    }

    undo() {
        if (this.history.length === 0) return;

        const current = JSON.stringify(this.getPose());
        this.future.push(current);

        const prev = JSON.parse(this.history.pop());
        this.setPose(prev);

        // Sync after undo
        if (this.syncCallback) this.syncCallback();
    }

    redo() {
        if (this.future.length === 0) return;

        const current = JSON.stringify(this.getPose());
        this.history.push(current);

        const next = JSON.parse(this.future.pop());
        this.setPose(next);

        // Sync after redo
        if (this.syncCallback) this.syncCallback();
    }

    setPose(pose, preserveCamera = false) {
        if (!pose) return;

        const bones = pose.bones || {};
        const modelRot = pose.modelRotation || [0, 0, 0];
        const ikPositions = pose.ikEffectorPositions || {};

        // Reset all bones
        for (const b of this.boneList) {
            b.rotation.set(0, 0, 0);
        }

        // Apply bone rotations
        for (const [bName, rot] of Object.entries(bones)) {
            const bone = this.bones[bName];
            if (bone && Array.isArray(rot) && rot.length >= 3) {
                bone.rotation.set(
                    rot[0] * Math.PI / 180,
                    rot[1] * Math.PI / 180,
                    rot[2] * Math.PI / 180
                );
            }
        }

        // Apply model rotation
        this.modelRotation.x = modelRot[0] || 0;
        this.modelRotation.y = modelRot[1] || 0;
        this.modelRotation.z = modelRot[2] || 0;

        if (this.skinnedMesh) {
            this.skinnedMesh.rotation.set(
                this.modelRotation.x * Math.PI / 180,
                this.modelRotation.y * Math.PI / 180,
                this.modelRotation.z * Math.PI / 180
            );
        }

        // Camera handling - skip if preserveCamera is true (e.g. library loading)
        if (!preserveCamera) {
            if (pose.camera) {
                this.camera.position.set(
                    pose.camera.posX,
                    pose.camera.posY,
                    pose.camera.posZ
                );
                this.orbit.target.set(
                    pose.camera.targetX,
                    pose.camera.targetY,
                    pose.camera.targetZ
                );
            } else {
                // Default view if no camera data (prevents inheriting from previous tab)
                this.camera.position.set(0, 0.5, 4);
                this.orbit.target.set(0, 1, 0);
            }
            this.orbit.update();
        }

        if (this.cameraParams) {
            this.cameraParams = { ...this.cameraParams, ...pose.cameraParams };
        } else {
            this.cameraParams = pose.cameraParams;
        }

        // Restore IK effector positions
        if (this.ikController && ikPositions) {
            for (const [name, pos] of Object.entries(ikPositions)) {
                const effector = this.ikController.effectors[name];
                if (effector && Array.isArray(pos) && pos.length >= 3) {
                    effector.position.set(pos[0], pos[1], pos[2]);
                }
            }
        }

        // Restore pole target positions
        const polePositions = pose.poleTargetPositions || {};
        if (this.ikController && polePositions) {
            for (const [chainKey, pos] of Object.entries(polePositions)) {
                const pole = this.ikController.poleTargets[chainKey];
                if (pole && Array.isArray(pos) && pos.length >= 3) {
                    pole.position.set(pos[0], pos[1], pos[2]);
                }
            }
        }

        // Restore hip bone positions
        const hipPositions = pose.hipBonePosition || {};
        for (const [chainKey, pos] of Object.entries(hipPositions)) {
            const chainDef = IK_CHAINS[chainKey];
            if (chainDef && chainDef.effector && Array.isArray(pos) && pos.length >= 3) {
                const hipBone = this.bones[chainDef.effector];
                if (hipBone) {
                    hipBone.position.set(pos[0], pos[1], pos[2]);
                    hipBone.updateMatrixWorld(true);
                }
            }
        }

        // Update skeleton after all changes
        if (this.skeleton) {
            this.skeleton.update();
        }

        this.requestRender();
    }

    setCameraParams(params) {
        if (!params) return;
        if (this.cameraParams) {
            this.cameraParams = { ...this.cameraParams, ...params };
        } else {
            this.cameraParams = params;
        }
    }

    resetPose() {
        for (const b of this.boneList) {
            b.rotation.set(0, 0, 0);

            // Reset bone position to initial state (important for hips IK)
            if (this.initialBoneStates && this.initialBoneStates[b.name]) {
                const initialState = this.initialBoneStates[b.name];
                b.position.copy(initialState.position);
            }
        }

        // Update matrix world after position/rotation changes
        for (const b of this.boneList) {
            b.updateMatrixWorld(true);
        }

        this.modelRotation = { x: 0, y: 0, z: 0 };
        if (this.skinnedMesh) {
            this.skinnedMesh.rotation.set(0, 0, 0);
        }

        // Update skeleton
        if (this.skeleton) {
            this.skeleton.update();
        }

        // Reset IK effector positions to match bones
        this.updateIKEffectorPositions();

        this.requestRender();
    }

    resetSelectedBone() {
        if (!this.selectedBone) return;

        this.recordState();

        // Reset the selected bone's rotation
        this.selectedBone.rotation.set(0, 0, 0);

        // Reset position to initial state (important for hips IK)
        if (this.initialBoneStates && this.initialBoneStates[this.selectedBone.name]) {
            const initialState = this.initialBoneStates[this.selectedBone.name];
            this.selectedBone.position.copy(initialState.position);
        }

        this.selectedBone.updateMatrixWorld(true);

        // Update skeleton
        if (this.skeleton) {
            this.skeleton.update();
        }

        // Update IK effector positions since bone changed
        this.updateIKEffectorPositions();

        this.requestRender();
    }

    interpolateFingerPose(poseA, poseB, t, side, fingerPrefix, bias = [1, 1, 1]) {
        if (!this.boneList) return;
        const dataA = side === "r" ? poseA.preset_r : poseA.preset_l;
        const dataB = side === "r" ? poseB.preset_r : poseB.preset_l;
        if (!dataA || !dataB) return;

        const THREE = this.THREE;
        const qa = new THREE.Quaternion();
        const qb = new THREE.Quaternion();

        for (const [index, segment] of ["01", "02", "03"].entries()) {
            const bone = this.bones[`${fingerPrefix}_${segment}_${side}`];
            if (!bone) continue;
            const a = dataA[`${fingerPrefix}_${segment}`];
            const b = dataB[`${fingerPrefix}_${segment}`];
            if (!a || !b) continue;
            qa.set(a[0], a[1], a[2], a[3]);
            qb.set(b[0], b[1], b[2], b[3]);
            bone.quaternion.slerpQuaternions(qa, qb, Math.min(1.2, Math.max(-0.2, t * bias[index])));
            bone.quaternion.normalize();
            bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
            bone.updateMatrixWorld(true);
        }

        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
        this.updateMarkers();
        this.requestRender();
    }

    interpolateHandPose(poseA, poseB, t, side) {
        if (!this.boneList) return;

        const dataA = side === "r" ? poseA.preset_r : poseA.preset_l;
        const dataB = side === "r" ? poseB.preset_r : poseB.preset_l;
        if (!dataA || !dataB) return;

        const THREE = this.THREE;
        const qa = new THREE.Quaternion();
        const qb = new THREE.Quaternion();

        for (const prefix of ["thumb", "index", "middle", "ring", "pinky"]) {
            for (const segment of ["01", "02", "03"]) {
                const bone = this.bones[`${prefix}_${segment}_${side}`];
                if (!bone) continue;
                const a = dataA[`${prefix}_${segment}`];
                const b = dataB[`${prefix}_${segment}`];
                if (!a || !b) continue;
                qa.set(a[0], a[1], a[2], a[3]);
                qb.set(b[0], b[1], b[2], b[3]);
                bone.quaternion.slerpQuaternions(qa, qb, t);
                bone.quaternion.normalize();
                bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
                bone.updateMatrixWorld(true);
            }
        }

        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
        this.updateMarkers();
        this.requestRender();
    }

    applyHandPresetPreview(presetData, side) {
        if (!this.boneList || !presetData) return;

        const applySide = (targetSide, data) => {
            if (!data) return;
            for (const prefix of ["thumb", "index", "middle", "ring", "pinky"]) {
                for (const segment of ["01", "02", "03"]) {
                    const bone = this.bones[`${prefix}_${segment}_${targetSide}`];
                    if (!bone) continue;
                    const quaternion = data[`${prefix}_${segment}`];
                    if (!quaternion) continue;
                    bone.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
                    bone.quaternion.normalize();
                    bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
                    bone.updateMatrixWorld(true);
                }
            }
        };

        if (presetData.preset_l || presetData.preset_r) {
            if (side === "both") {
                applySide("l", presetData.preset_l);
                applySide("r", presetData.preset_r);
            } else if (side === "l") {
                applySide("l", presetData.preset_l);
            } else if (side === "r") {
                applySide("r", presetData.preset_r);
            }
        } else if (side === "both") {
            applySide("l", presetData);
            applySide("r", presetData);
        } else {
            applySide(side, presetData);
        }

        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
        this.updateMarkers();
        this.requestRender();
    }

    saveHandSnapshot() {
        const snapshot = {};
        for (const side of ["l", "r"]) {
            for (const prefix of ["thumb", "index", "middle", "ring", "pinky"]) {
                for (const segment of ["01", "02", "03"]) {
                    const bone = this.bones[`${prefix}_${segment}_${side}`];
                    if (!bone) continue;
                    snapshot[`${prefix}_${segment}_${side}`] = [bone.rotation.x, bone.rotation.y, bone.rotation.z];
                }
            }
        }
        this._handSnapshot = snapshot;
    }

    restoreHandSnapshot() {
        if (!this._handSnapshot) return;
        for (const [boneName, rotation] of Object.entries(this._handSnapshot)) {
            const bone = this.bones[boneName];
            if (!bone) continue;
            bone.rotation.set(rotation[0], rotation[1], rotation[2]);
            bone.quaternion.setFromEuler(bone.rotation);
            bone.updateMatrixWorld(true);
        }
        this._handSnapshot = null;
        if (this.skeleton) this.skeleton.update();
        this.updateMarkers();
        this.requestRender();
    }

    applyHandPreset(side, presetData) {
        if (!this.boneList || !presetData) return;
        this.recordState();

        const applySide = (targetSide, data) => {
            if (!data) return;
            for (const prefix of ["thumb", "index", "middle", "ring", "pinky"]) {
                for (const segment of ["01", "02", "03"]) {
                    const bone = this.bones[`${prefix}_${segment}_${targetSide}`];
                    if (!bone) continue;
                    const quaternion = data[`${prefix}_${segment}`];
                    if (!quaternion) continue;
                    bone.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
                    bone.quaternion.normalize();
                    bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
                    bone.updateMatrixWorld(true);
                }
            }
        };

        if (presetData.preset_l || presetData.preset_r) {
            if (side === "both") {
                applySide("l", presetData.preset_l);
                applySide("r", presetData.preset_r);
            } else if (side === "l") {
                applySide("l", presetData.preset_l);
            } else if (side === "r") {
                applySide("r", presetData.preset_r);
            }
        } else if (side === "both") {
            applySide("l", presetData);
            applySide("r", presetData);
        } else {
            applySide(side, presetData);
        }

        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
        this.updateMarkers();
        this.requestRender();
        this.dispatchPoseChange();
    }

    captureHandPreset(side) {
        const captureSide = (targetSide) => {
            const data = {};
            for (const prefix of ["thumb", "index", "middle", "ring", "pinky"]) {
                for (const segment of ["01", "02", "03"]) {
                    const bone = this.bones[`${prefix}_${segment}_${targetSide}`];
                    if (!bone) continue;
                    const quaternion = bone.quaternion;
                    data[`${prefix}_${segment}`] = [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
                }
            }
            return data;
        };

        const canonical = captureSide(side);
        const mirrored = {};
        for (const [key, quaternion] of Object.entries(canonical)) {
            mirrored[key] = [-quaternion[0], quaternion[1], quaternion[2], -quaternion[3]];
        }

        return {
            source_side: side,
            preset_l: side === "l" ? canonical : mirrored,
            preset_r: side === "r" ? canonical : mirrored,
        };
    }

    _getHandMarkers(side) {
        const handBoneNames = new Set([
            "hand_l", "thumb_01_l", "thumb_02_l", "thumb_03_l", "index_01_l", "index_02_l", "index_03_l",
            "middle_01_l", "middle_02_l", "middle_03_l", "ring_01_l", "ring_02_l", "ring_03_l",
            "pinky_01_l", "pinky_02_l", "pinky_03_l",
            "hand_r", "thumb_01_r", "thumb_02_r", "thumb_03_r", "index_01_r", "index_02_r", "index_03_r",
            "middle_01_r", "middle_02_r", "middle_03_r", "ring_01_r", "ring_02_r", "ring_03_r",
            "pinky_01_r", "pinky_02_r", "pinky_03_r",
        ]);

        return this.jointMarkers.filter((marker) => {
            const bone = this.boneList[marker.userData.boneIndex];
            if (!bone || !handBoneNames.has(bone.name)) return false;
            if (side === "both") return true;
            return bone.name.endsWith(`_${side}`);
        });
    }

    showHandHighlightRing(side) {
        this.hideHandHighlightRing();
        const THREE = this.THREE;
        const sides = side === "both" ? ["l", "r"] : [side];
        this._handRings = [];

        for (const currentSide of sides) {
            const handBone = this.bones[`hand_${currentSide}`];
            if (!handBone) continue;

            const centerBone = this.bones[`middle_01_${currentSide}`] || handBone;
            const handPosition = new THREE.Vector3();
            centerBone.getWorldPosition(handPosition);

            let maxDistance = 0.1;
            for (const tip of ["thumb_03", "index_03", "middle_03", "ring_03", "pinky_03"]) {
                const bone = this.bones[`${tip}_${currentSide}`];
                if (!bone) continue;
                const position = new THREE.Vector3();
                bone.getWorldPosition(position);
                maxDistance = Math.max(maxDistance, handPosition.distanceTo(position));
            }

            const sphere = new THREE.Mesh(
                new THREE.SphereGeometry(maxDistance * 1.3, 16, 12),
                new THREE.MeshBasicMaterial({
                    color: 0xffd666,
                    transparent: true,
                    opacity: 0.18,
                    depthTest: false,
                    side: THREE.FrontSide,
                })
            );
            sphere.position.copy(handPosition);
            sphere.renderOrder = 998;
            sphere.onBeforeRender = () => {
                centerBone.getWorldPosition(sphere.position);
            };

            this.scene.add(sphere);
            this._handRings.push(sphere);
        }

        this.requestRender();
    }

    hideHandHighlightRing() {
        if (!this._handRings) return;
        for (const ring of this._handRings) {
            ring.geometry.dispose();
            ring.material.dispose();
            this.scene.remove(ring);
        }
        this._handRings = null;
        this.requestRender();
    }

    highlightHandMarkers(side) {
        this.unhighlightHandMarkers();
        this._highlightedMarkers = this._getHandMarkers(side);
        this._highlightedMarkers.forEach((marker) => {
            marker.material = marker.material.clone();
            marker.material.color.setHex(0x00ffff);
        });
        this.requestRender();
    }

    unhighlightHandMarkers() {
        if (!this._highlightedMarkers) return;
        this._highlightedMarkers.forEach((marker) => {
            marker.material.dispose();
            marker.material = this.markerMatNormal;
        });
        this._highlightedMarkers = null;
        this.updateMarkers();
        this.requestRender();
    }

    flashHandMarkers(side) {
        this.highlightHandMarkers(side);
        setTimeout(() => this.unhighlightHandMarkers(), 400);
    }

    setModelRotation(x, y, z) {
        this.modelRotation.x = x !== undefined ? x : this.modelRotation.x;
        this.modelRotation.y = y !== undefined ? y : this.modelRotation.y;
        this.modelRotation.z = z !== undefined ? z : this.modelRotation.z;

        if (this.skinnedMesh) {
            this.skinnedMesh.rotation.set(
                this.modelRotation.x * Math.PI / 180,
                this.modelRotation.y * Math.PI / 180,
                this.modelRotation.z * Math.PI / 180
            );
        }

        // Changing model rotation changes effector world positions
        if (this.ikController) {
            this.updateIKEffectorPositions();
        }

        this.requestRender();
    }


    setSkinMode(mode) {
        if (!this.options) return;
        this.options.skinMode = mode;
        this.setSkinTexture(mode);
    }

    loadReferenceImage(url) {
        if (!this.initialized || !this.captureCamera) {
            this.pendingBackgroundUrl = url;
            return;
        }
        const THREE = this.THREE;

        // Create plane if needed
        if (!this.refPlane) {
            const geo = new THREE.PlaneGeometry(1, 1);
            const mat = new THREE.MeshBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 1.0,
                side: THREE.DoubleSide,
                depthWrite: false
            });
            this.refPlane = new THREE.Mesh(geo, mat);
            // Render first (background)
            this.refPlane.renderOrder = -1;
            // Attach to camera so it moves with it
            this.captureCamera.add(this.refPlane);

            // Initial positioning (will be fixed in updateCaptureCamera)
            this.refPlane.position.set(0, 0, -50);
            this.refPlane.rotation.set(0, 0, 0);
        }

        // Load texture
        new THREE.TextureLoader().load(url, (tex) => {
            // Ensure sRGB for real colors
            if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
            else if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;

            if (this.refPlane) {
                this.refPlane.material.map = tex;
                this.refPlane.material.needsUpdate = true;
                this.refPlane.visible = true;
                this.requestRender();
            }
        });
    }

    removeReferenceImage() {
        if (!this.refPlane) return;
        this.captureCamera.remove(this.refPlane);
        if (this.refPlane.geometry) this.refPlane.geometry.dispose();
        if (this.refPlane.material) {
            if (this.refPlane.material.map) this.refPlane.material.map.dispose();
            this.refPlane.material.dispose();
        }
        this.refPlane = null;
        this.requestRender();
    }

    hasReferenceImage() {
        return this.refPlane !== null && this.refPlane !== undefined;
    }

    updateCaptureCamera(width, height, zoom = 1.0, offsetX = 0, offsetY = 0) {
        if (!this.THREE || !this.captureCamera) return; // Not initialized yet
        const baseTarget = this.meshCenter || new this.THREE.Vector3(0, 10, 0);
        // Apply offset (in world units, scaled by zoom for intuitive control)
        const target = new this.THREE.Vector3(
            baseTarget.x - offsetX,
            baseTarget.y - offsetY,
            baseTarget.z
        );
        const dist = 45;

        // Positioning relative to offset target
        this.captureCamera.aspect = width / height;
        this.captureCamera.zoom = zoom;
        this.captureCamera.updateProjectionMatrix();
        this.captureCamera.position.set(target.x, target.y, target.z + dist);
        this.captureCamera.lookAt(target);

        // Update Reference Plane
        if (this.refPlane) {
            // Distance from camera to plane (near far clip)
            const planeDist = 95;

            // Calculate height at that distance
            // h = 2 * dist * tan(fov/2). 
            // Effective FOV is scaled by zoom? 
            // THREE.js zoom divides the frustum size. 
            // So visible height = height / zoom.

            const vFOV = (this.captureCamera.fov * Math.PI) / 180;
            const h = 2 * planeDist * Math.tan(vFOV / 2) / Math.max(0.1, zoom);
            const w = h * this.captureCamera.aspect;

            this.refPlane.position.set(0, 0, -planeDist);
            this.refPlane.scale.set(w, h, 1);
            this.refPlane.rotation.set(0, 0, 0); // Ensure it faces camera (camera looks down -Z, plane is XY)
        }

        if (this.captureFrame) {
            const vFOV = (this.captureCamera.fov * Math.PI) / 180;
            // Frame at target distance (dist = 45)
            const h = 2 * dist * Math.tan(vFOV / 2) / Math.max(0.1, zoom);
            const w = h * this.captureCamera.aspect;

            this.captureFrame.position.copy(target);
            this.captureFrame.scale.set(w / 2, h / 2, 1);
            this.captureFrame.lookAt(this.captureCamera.position);
            this.captureFrame.visible = true;
        }

        if (this.captureHelper) {
            this.captureHelper.update();
            this.captureHelper.visible = false;
        }
        this.requestRender();
    }

    snapToCaptureCamera(width, height, zoom = 1.0, offsetX = 0, offsetY = 0) {
        this.updateCaptureCamera(width, height, zoom, offsetX, offsetY);

        // Disable damping for hard reset
        const prevDamping = this.orbit.enableDamping;
        this.orbit.enableDamping = false;

        // Copy capture camera to viewport camera
        this.camera.position.copy(this.captureCamera.position);
        this.camera.zoom = zoom;
        this.camera.updateProjectionMatrix();

        const baseTarget = this.meshCenter || new this.THREE.Vector3(0, 10, 0);
        const target = new this.THREE.Vector3(
            baseTarget.x - offsetX,
            baseTarget.y - offsetY,
            baseTarget.z
        );
        this.orbit.target.copy(target);
        this.orbit.update();

        this.orbit.enableDamping = prevDamping;
    }

    capture(width, height, zoom, bgColor, offsetX = 0, offsetY = 0) {
        if (!this.initialized) return null;

        // Ensure camera is setup
        this.updateCaptureCamera(width, height, zoom, offsetX, offsetY);

        // Hide UI elements
        const markersVisible = this.jointMarkers[0]?.visible ?? true;
        const transformVisible = this.transform ? this.transform.visible : true;

        // Hide Helpers
        if (this.transform) this.transform.visible = false;
        if (this.skeletonHelper) this.skeletonHelper.visible = false;
        if (this.gridHelper) this.gridHelper.visible = false;
        if (this.captureFrame) this.captureFrame.visible = false;
        this.jointMarkers.forEach(m => m.visible = false);

        // Hide IK effectors and pole targets
        const effectorVisibility = {};
        const poleVisibility = {};
        if (this.ikController) {
            for (const [name, effector] of Object.entries(this.ikController.effectors)) {
                effectorVisibility[name] = effector.visible;
                effector.visible = false;
            }
            for (const [key, pole] of Object.entries(this.ikController.poleTargets)) {
                poleVisibility[key] = pole.visible;
                pole.visible = false;
            }
        }

        // Background Override
        const oldBg = this.scene.background;
        if (bgColor && Array.isArray(bgColor) && bgColor.length === 3) {
            this.scene.background = new this.THREE.Color(
                bgColor[0] / 255, bgColor[1] / 255, bgColor[2] / 255
            );
        }

        let dataURL = null;
        const oldPixelRatio = this.renderer.getPixelRatio();

        try {
            // Resize renderer to output size
            const originalSize = new this.THREE.Vector2();
            this.renderer.getSize(originalSize);

            this.renderer.setPixelRatio(1); // Force 1:1 pixel ratio for capture
            this.renderer.setSize(width, height, false); // false = don't update style to avoid layout thrashing

            // Render with Fixed Camera
            this.renderer.render(this.scene, this.captureCamera);
            dataURL = this.canvas.toDataURL("image/png");

            // Restore renderer
            this.renderer.setPixelRatio(oldPixelRatio);
            this.renderer.setSize(originalSize.x, originalSize.y, true); // Update style back

        } catch (e) {
            console.error("Capture failed:", e);
        } finally {
            // Restore state
            if (this.renderer.getPixelRatio() !== oldPixelRatio) this.renderer.setPixelRatio(oldPixelRatio);
            this.scene.background = oldBg;

            this.jointMarkers.forEach(m => m.visible = markersVisible && this._shouldMarkerBeVisible(m));
            if (this.transform) this.transform.visible = transformVisible;
            if (this.skeletonHelper) this.skeletonHelper.visible = true;
            if (this.gridHelper) this.gridHelper.visible = true;
            if (this.captureFrame) this.captureFrame.visible = true;

            // Restore IK effectors and pole targets visibility
            if (this.ikController) {
                for (const [name, effector] of Object.entries(this.ikController.effectors)) {
                    effector.visible = effectorVisibility[name] ?? false;
                }
                for (const [key, pole] of Object.entries(this.ikController.poleTargets)) {
                    pole.visible = poleVisibility[key] ?? false;
                }
            }

            // Re-render viewport
            this.renderer.render(this.scene, this.camera);
        }
        return dataURL;
    }

    _clearImportedFigureGroup(groupName) {
        const group = this[groupName];
        if (!group) return;
        group.traverse((object) => {
            if (object.geometry) object.geometry.dispose();
            if (object.material) {
                if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
                else object.material.dispose();
            }
        });
        if (group.parent) group.parent.remove(group);
        this[groupName] = null;
    }

    _estimateCurrentModelHeight() {
        if (!this.skinnedMesh || !this.THREE) return 1.7;
        const bounds = new this.THREE.Box3().setFromObject(this.skinnedMesh);
        const size = new this.THREE.Vector3();
        bounds.getSize(size);
        return size.y > 0.5 ? size.y : 1.7;
    }

    _drawHMR2Figure(worldKps) {
        if (!this.scene || !this.THREE || !worldKps) return;

        this._clearImportedFigureGroup('_hmr2FigureGroup');
        this._clearImportedFigureGroup('_rtmwFigureGroup');
        this._clearImportedFigureGroup('_kpFigureGroup');

        const bones = [
            ['nose', 'neck', 0xff0000],
            ['neck', 'right_shoulder', 0xff7700],
            ['neck', 'left_shoulder', 0x00aa00],
            ['neck', 'pelvis', 0xffff00],
            ['pelvis', 'right_hip', 0xff7700],
            ['pelvis', 'left_hip', 0x00aa00],
            ['right_shoulder', 'right_elbow', 0xff7700],
            ['right_elbow', 'right_wrist', 0xffaa00],
            ['left_shoulder', 'left_elbow', 0x00aa00],
            ['left_elbow', 'left_wrist', 0x00dd00],
            ['right_hip', 'right_knee', 0xff00ff],
            ['right_knee', 'right_ankle', 0xaa00ff],
            ['left_hip', 'left_knee', 0x00ffff],
            ['left_knee', 'left_ankle', 0x0088ff],
        ];

        const group = new this.THREE.Group();
        group.name = 'hmr2v1_figure';

        const jointGeo = new this.THREE.SphereGeometry(0.025, 8, 8);
        const jointMat = new this.THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });

        for (const point of Object.values(worldKps)) {
            if (!point) continue;
            const mesh = new this.THREE.Mesh(jointGeo, jointMat.clone());
            mesh.position.copy(point);
            mesh.renderOrder = 999;
            group.add(mesh);
        }

        for (const [fromName, toName, color] of bones) {
            const from = worldKps[fromName];
            const to = worldKps[toName];
            if (!from || !to) continue;
            const geometry = new this.THREE.BufferGeometry().setFromPoints([from, to]);
            const material = new this.THREE.LineBasicMaterial({ color, depthTest: false });
            const line = new this.THREE.Line(geometry, material);
            line.renderOrder = 998;
            group.add(line);
        }

        this.scene.add(group);
        this._hmr2FigureGroup = group;
    }

    _buildSAM3DNamedPoints(data) {
        const namedPoints = {};

        if (Array.isArray(data?.keypoints_3d)) {
            for (let index = 0; index < Math.min(data.keypoints_3d.length, SAM3D_KEYPOINT_NAMES.length); index++) {
                const point = data.keypoints_3d[index];
                const name = SAM3D_KEYPOINT_NAMES[index];
                if (!Array.isArray(point) || point.length < 3 || !name) continue;
                namedPoints[name] = point;
            }
        }

        if (Array.isArray(data?.joint_coords)) {
            for (const [indexString, name] of Object.entries(SAM3D_JOINT_COORD_NAMES)) {
                const index = Number(indexString);
                const point = data.joint_coords[index];
                if (!Array.isArray(point) || point.length < 3) continue;
                namedPoints[name] = point;
            }
        }

        return namedPoints;
    }

    _averageSAM3DPoint(namedPoints, names) {
        const valid = names
            .map((name) => namedPoints[name])
            .filter((point) => Array.isArray(point) && point.length >= 3);
        if (!valid.length) return null;
        const sum = [0, 0, 0];
        for (const point of valid) {
            sum[0] += point[0];
            sum[1] += point[1];
            sum[2] += point[2];
        }
        return sum.map((value) => value / valid.length);
    }

    _getBoneWorldPositionForImport(boneName) {
        if (!this.THREE || !this.bones?.[boneName]) return null;
        const position = new this.THREE.Vector3();
        this.bones[boneName].getWorldPosition(position);
        return position;
    }

    _getBoneWorldQuaternionForImport(boneName) {
        if (!this.THREE || !this.bones?.[boneName]) return null;
        const quaternion = new this.THREE.Quaternion();
        this.bones[boneName].getWorldQuaternion(quaternion);
        return quaternion;
    }

    _convertSAM3DRotationMatrix(matrixRows) {
        if (!this.THREE || !Array.isArray(matrixRows) || matrixRows.length < 3) return null;

        const rows = matrixRows.map((row) => Array.isArray(row) ? row : null);
        if (rows.some((row) => !row || row.length < 3)) return null;

        const THREE = this.THREE;
        const source = new THREE.Matrix4().set(
            Number(rows[0][0]), Number(rows[0][1]), Number(rows[0][2]), 0,
            Number(rows[1][0]), Number(rows[1][1]), Number(rows[1][2]), 0,
            Number(rows[2][0]), Number(rows[2][1]), Number(rows[2][2]), 0,
            0, 0, 0, 1,
        );
        const axisFlip = new THREE.Matrix4().set(
            1, 0, 0, 0,
            0, -1, 0, 0,
            0, 0, -1, 0,
            0, 0, 0, 1,
        );
        return axisFlip.clone().multiply(source).multiply(axisFlip);
    }

    _buildSAM3DWorldRotationMap(data) {
        if (!Array.isArray(data?.joint_rotations)) return null;

        const worldRotations = {};
        for (const [indexString, boneName] of Object.entries(SAM3D_JOINT_COORD_NAMES)) {
            const matrixRows = data.joint_rotations[Number(indexString)];
            const matrix = this._convertSAM3DRotationMatrix(matrixRows);
            if (!matrix || !boneName) continue;
            worldRotations[boneName] = new this.THREE.Quaternion().setFromRotationMatrix(matrix);
        }
        return Object.keys(worldRotations).length ? worldRotations : null;
    }

    applyWorldRotationImport(sourceWorldRotations, parentMap = DEFAULT_WORLD_ROTATION_PARENT_MAP, rotationOrder = DEFAULT_WORLD_ROTATION_ORDER, options = {}) {
        if (!this.THREE || !this.bones || !this.skinnedMesh || !sourceWorldRotations) return false;

        const sourceRestWorldRotations = options?.sourceRestWorldRotations || null;
        const debugBones = new Set(options?.debugBones || []);
        const debugFrame = options?.debugFrame ?? null;
        const debugCollector = options?.debugCollector || null;

        const quatToArray = (quat) => quat ? [quat.x, quat.y, quat.z, quat.w] : null;
        const quatToEulerDegrees = (quat) => {
            if (!quat) return null;
            const euler = new this.THREE.Euler().setFromQuaternion(quat, 'XYZ');
            return [
                euler.x * 180 / Math.PI,
                euler.y * 180 / Math.PI,
                euler.z * 180 / Math.PI,
            ];
        };

        const targetRestWorldRotations = {};
        for (const boneName of rotationOrder) {
            const quaternion = this._getBoneWorldQuaternionForImport(boneName);
            if (quaternion) targetRestWorldRotations[boneName] = quaternion;
        }

        const appliedTargetWorldRotations = {};

        for (const boneName of rotationOrder) {
            const bone = this.bones[boneName];
            const sourceWorld = sourceWorldRotations[boneName];
            const targetRest = targetRestWorldRotations[boneName];
            if (!bone || !sourceWorld || !targetRest) continue;

            const parentName = parentMap[boneName];
            const targetAppliedParentWorld = parentName
                ? (appliedTargetWorldRotations[parentName] || targetRestWorldRotations[parentName] || null)
                : null;
            let desiredTargetWorld;
            let sourceAnimatedLocal = null;
            let sourceRestLocal = null;
            let sourceLocalDelta = null;
            let targetRestLocal = null;
            let basisDelta = null;
            let retargetedLocalDelta = null;
            let desiredTargetLocal = null;
            if (sourceRestWorldRotations?.[boneName]) {
                const sourceRest = sourceRestWorldRotations[boneName];
                const sourceParentWorld = parentName ? sourceWorldRotations[parentName] : null;
                const sourceRestParentWorld = parentName ? sourceRestWorldRotations[parentName] : null;

                sourceAnimatedLocal = sourceParentWorld
                    ? sourceParentWorld.clone().invert().multiply(sourceWorld.clone()).normalize()
                    : sourceWorld.clone().normalize();
                sourceRestLocal = sourceRestParentWorld
                    ? sourceRestParentWorld.clone().invert().multiply(sourceRest.clone()).normalize()
                    : sourceRest.clone().normalize();

                sourceLocalDelta = sourceRestLocal.clone().invert().multiply(sourceAnimatedLocal).normalize();

                const targetRestParentWorld = parentName ? (targetRestWorldRotations[parentName] || null) : null;
                targetRestLocal = targetRestParentWorld
                    ? targetRestParentWorld.clone().invert().multiply(targetRest.clone()).normalize()
                    : targetRest.clone().normalize();

                // Re-express the source local delta in the target local basis.
                basisDelta = targetRestLocal.clone().invert().multiply(sourceRestLocal.clone()).normalize();
                retargetedLocalDelta = basisDelta.clone()
                    .multiply(sourceLocalDelta)
                    .multiply(basisDelta.clone().invert())
                    .normalize();

                desiredTargetLocal = targetRestLocal.clone().multiply(retargetedLocalDelta).normalize();
                desiredTargetWorld = parentName
                    ? targetAppliedParentWorld.clone().multiply(desiredTargetLocal).normalize()
                    : desiredTargetLocal;
            } else {
                desiredTargetWorld = sourceWorld.clone();
            }

            let parentTargetWorld = null;
            if (parentName) {
                parentTargetWorld = targetAppliedParentWorld;
            }

            const localQuat = parentTargetWorld
                ? parentTargetWorld.clone().invert().multiply(desiredTargetWorld.clone()).normalize()
                : desiredTargetWorld.clone().normalize();

            bone.quaternion.copy(localQuat);
            bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
            bone.updateMatrixWorld(true);

            const appliedWorld = new this.THREE.Quaternion();
            bone.getWorldQuaternion(appliedWorld);
            appliedTargetWorldRotations[boneName] = appliedWorld;

            if (debugCollector && debugBones.has(boneName)) {
                debugCollector[boneName] = {
                    frame: debugFrame,
                    parentName,
                    sourceWorld: quatToArray(sourceWorld),
                    sourceWorldEuler: quatToEulerDegrees(sourceWorld),
                    sourceRestWorld: quatToArray(sourceRestWorldRotations?.[boneName] || null),
                    sourceRestWorldEuler: quatToEulerDegrees(sourceRestWorldRotations?.[boneName] || null),
                    sourceAnimatedLocal: quatToArray(sourceAnimatedLocal),
                    sourceAnimatedLocalEuler: quatToEulerDegrees(sourceAnimatedLocal),
                    sourceRestLocal: quatToArray(sourceRestLocal),
                    sourceRestLocalEuler: quatToEulerDegrees(sourceRestLocal),
                    sourceLocalDelta: quatToArray(sourceLocalDelta),
                    sourceLocalDeltaEuler: quatToEulerDegrees(sourceLocalDelta),
                    targetRestWorld: quatToArray(targetRest),
                    targetRestWorldEuler: quatToEulerDegrees(targetRest),
                    targetRestLocal: quatToArray(targetRestLocal),
                    targetRestLocalEuler: quatToEulerDegrees(targetRestLocal),
                    basisDelta: quatToArray(basisDelta),
                    basisDeltaEuler: quatToEulerDegrees(basisDelta),
                    retargetedLocalDelta: quatToArray(retargetedLocalDelta),
                    retargetedLocalDeltaEuler: quatToEulerDegrees(retargetedLocalDelta),
                    desiredTargetLocal: quatToArray(desiredTargetLocal),
                    desiredTargetLocalEuler: quatToEulerDegrees(desiredTargetLocal),
                    appliedLocal: quatToArray(localQuat),
                    appliedLocalEuler: quatToEulerDegrees(localQuat),
                    appliedWorld: quatToArray(appliedWorld),
                    appliedWorldEuler: quatToEulerDegrees(appliedWorld),
                };
            }
        }

        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
        this.updateIKEffectorPositions();
        return true;
    }

    applyImportedLegTargets(legTargets = {}) {
        if (!this.THREE || !this.bones || !this.skinnedMesh || !this.ikController?.ccdSolver) return false;

        const applyChain = (chainKey, targetDef) => {
            if (!targetDef?.ankleTarget) return false;
            const chainDef = IK_CHAINS[chainKey];
            if (!chainDef) return false;

            const poleHelper = this.ikController?.poleTargets?.[chainKey] || null;
            if (poleHelper && targetDef.kneeTarget) {
                poleHelper.position.copy(targetDef.kneeTarget);
            }

            this.ikController.solveWithPole(chainDef, this.bones, targetDef.ankleTarget, chainKey);
            this.skinnedMesh.updateMatrixWorld(true);
            return true;
        };

        let applied = false;
        for (let pass = 0; pass < 3; pass++) {
            const leftApplied = applyChain('leftLeg', legTargets.leftLeg);
            const rightApplied = applyChain('rightLeg', legTargets.rightLeg);
            applied = leftApplied || rightApplied || applied;
        }

        if (!applied) return false;

        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
        this.updateIKEffectorPositions();
        return true;
    }

    _applySAM3DRotationImport(data) {
        const sourceWorldRotations = this._buildSAM3DWorldRotationMap(data);
        return this.applyWorldRotationImport(sourceWorldRotations);
    }

    _buildSAM3DImportTargets(data) {
        if (!this.THREE || !this.bones || !this.ikController) return null;

        const THREE = this.THREE;
        const namedPoints = this._buildSAM3DNamedPoints(data);
        const pelvisSource = this._averageSAM3DPoint(namedPoints, ['left_hip', 'right_hip']) || namedPoints.pelvis;
        if (!pelvisSource) return null;

        const pelvisWorld = this._getBoneWorldPositionForImport('pelvis') || this._getBoneWorldPositionForImport('spine_01');
        if (!pelvisWorld) return null;

        const rest = {
            pelvis: pelvisWorld.clone(),
            neck: this._getBoneWorldPositionForImport('neck_01'),
            head: this._getBoneWorldPositionForImport('head'),
            leftShoulder: this._getBoneWorldPositionForImport('upperarm_l'),
            rightShoulder: this._getBoneWorldPositionForImport('upperarm_r'),
            leftHand: this._getBoneWorldPositionForImport('hand_l'),
            rightHand: this._getBoneWorldPositionForImport('hand_r'),
            leftHip: this._getBoneWorldPositionForImport('thigh_l'),
            rightHip: this._getBoneWorldPositionForImport('thigh_r'),
            leftFoot: this._getBoneWorldPositionForImport('foot_l'),
            rightFoot: this._getBoneWorldPositionForImport('foot_r'),
        };

        const source = {
            neck: namedPoints.neck || namedPoints.neck_01 || this._averageSAM3DPoint(namedPoints, ['left_shoulder', 'right_shoulder']),
            head: this._averageSAM3DPoint(namedPoints, ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear']) || namedPoints.nose,
            leftShoulder: namedPoints.left_acromion || namedPoints.left_shoulder,
            rightShoulder: namedPoints.right_acromion || namedPoints.right_shoulder,
            leftElbow: namedPoints.left_elbow || namedPoints.left_olecranon || namedPoints.left_cubital_fossa,
            rightElbow: namedPoints.right_elbow || namedPoints.right_olecranon || namedPoints.right_cubital_fossa,
            leftHand: namedPoints.left_wrist || namedPoints.hand_l,
            rightHand: namedPoints.right_wrist || namedPoints.hand_r,
            leftHip: namedPoints.left_hip || namedPoints.thigh_l,
            rightHip: namedPoints.right_hip || namedPoints.thigh_r,
            leftKnee: namedPoints.left_knee || namedPoints.calf_l,
            rightKnee: namedPoints.right_knee || namedPoints.calf_r,
            leftFoot: namedPoints.left_ankle || namedPoints.foot_l,
            rightFoot: namedPoints.right_ankle || namedPoints.foot_r,
            leftEar: namedPoints.left_ear,
            rightEar: namedPoints.right_ear,
            nose: namedPoints.nose,
        };

        const sourceVector = (from, to) => {
            if (!from || !to) return null;
            return [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
        };
        const vectorLength = (vector) => {
            if (!vector) return 0;
            return Math.hypot(vector[0], vector[1], vector[2]);
        };
        const worldDistance = (from, to) => (from && to ? from.distanceTo(to) : 0);
        const transformedOffset = (vector, scale) => new THREE.Vector3(vector[0] * scale, -vector[1] * scale, -vector[2] * scale);
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

        const torsoScale = scaleBetween(pelvisSource, source.neck || source.head, rest.pelvis, rest.neck || rest.head, 1.0);
        const headScale = scaleBetween(source.neck || pelvisSource, source.head, rest.neck || rest.pelvis, rest.head, torsoScale);
        const leftArmScale = scaleBetween(source.leftShoulder || pelvisSource, source.leftHand, rest.leftShoulder || rest.pelvis, rest.leftHand, torsoScale);
        const rightArmScale = scaleBetween(source.rightShoulder || pelvisSource, source.rightHand, rest.rightShoulder || rest.pelvis, rest.rightHand, torsoScale);
        const leftLegScale = scaleBetween(source.leftHip || pelvisSource, source.leftFoot, rest.leftHip || rest.pelvis, rest.leftFoot, torsoScale);
        const rightLegScale = scaleBetween(source.rightHip || pelvisSource, source.rightFoot, rest.rightHip || rest.pelvis, rest.rightFoot, torsoScale);

        const worldKps = {
            pelvis: rest.pelvis.clone(),
            neck: scaledWorldPoint(rest.pelvis, pelvisSource, source.neck, torsoScale),
            left_shoulder: scaledWorldPoint(rest.pelvis, pelvisSource, source.leftShoulder, torsoScale),
            right_shoulder: scaledWorldPoint(rest.pelvis, pelvisSource, source.rightShoulder, torsoScale),
            left_hip: scaledWorldPoint(rest.pelvis, pelvisSource, source.leftHip, torsoScale),
            right_hip: scaledWorldPoint(rest.pelvis, pelvisSource, source.rightHip, torsoScale),
            left_ear: scaledWorldPoint(rest.pelvis, pelvisSource, source.leftEar, torsoScale),
            right_ear: scaledWorldPoint(rest.pelvis, pelvisSource, source.rightEar, torsoScale),
            nose: scaledWorldPoint(rest.neck || rest.pelvis, source.neck || pelvisSource, source.nose, headScale),
        };

        worldKps.head = scaledWorldPoint(rest.neck || rest.pelvis, source.neck || pelvisSource, source.head, headScale);
        worldKps.left_elbow = scaledWorldPoint(worldKps.left_shoulder || rest.leftShoulder, source.leftShoulder || pelvisSource, source.leftElbow, leftArmScale);
        worldKps.right_elbow = scaledWorldPoint(worldKps.right_shoulder || rest.rightShoulder, source.rightShoulder || pelvisSource, source.rightElbow, rightArmScale);
        worldKps.left_wrist = scaledWorldPoint(worldKps.left_shoulder || rest.leftShoulder, source.leftShoulder || pelvisSource, source.leftHand, leftArmScale);
        worldKps.right_wrist = scaledWorldPoint(worldKps.right_shoulder || rest.rightShoulder, source.rightShoulder || pelvisSource, source.rightHand, rightArmScale);
        worldKps.left_knee = scaledWorldPoint(worldKps.left_hip || rest.leftHip, source.leftHip || pelvisSource, source.leftKnee, leftLegScale);
        worldKps.right_knee = scaledWorldPoint(worldKps.right_hip || rest.rightHip, source.rightHip || pelvisSource, source.rightKnee, rightLegScale);
        worldKps.left_ankle = scaledWorldPoint(worldKps.left_hip || rest.leftHip, source.leftHip || pelvisSource, source.leftFoot, leftLegScale);
        worldKps.right_ankle = scaledWorldPoint(worldKps.right_hip || rest.rightHip, source.rightHip || pelvisSource, source.rightFoot, rightLegScale);

        if (!worldKps.neck && worldKps.left_shoulder && worldKps.right_shoulder) {
            worldKps.neck = new THREE.Vector3(
                (worldKps.left_shoulder.x + worldKps.right_shoulder.x) / 2,
                (worldKps.left_shoulder.y + worldKps.right_shoulder.y) / 2,
                (worldKps.left_shoulder.z + worldKps.right_shoulder.z) / 2,
            );
        }
        if (!worldKps.head && worldKps.neck && worldKps.nose) {
            worldKps.head = worldKps.nose.clone();
        }

        return {
            worldKps,
            effectorTargets: {
                pelvis: rest.pelvis.clone(),
                head: worldKps.head || worldKps.nose || rest.head,
                hand_l: worldKps.left_wrist || rest.leftHand,
                hand_r: worldKps.right_wrist || rest.rightHand,
                foot_l: worldKps.left_ankle || rest.leftFoot,
                foot_r: worldKps.right_ankle || rest.rightFoot,
                upperarm_l: worldKps.left_shoulder || rest.leftShoulder,
                upperarm_r: worldKps.right_shoulder || rest.rightShoulder,
            },
            poleTargets: {
                leftArm: worldKps.left_elbow || null,
                rightArm: worldKps.right_elbow || null,
                leftLeg: worldKps.left_knee || null,
                rightLeg: worldKps.right_knee || null,
            },
        };
    }

    _applyImportPelvisAndTorso(worldKps, shoulderYOffset = 0) {
        if (!worldKps || !this.THREE || !this.bones || !this.skinnedMesh) return;

        const THREE = this.THREE;
        const pelvisBone = this.bones.pelvis || this.bones.spine_01;
        if (pelvisBone && worldKps.pelvis) {
            const localTarget = worldKps.pelvis.clone();
            if (pelvisBone.parent) pelvisBone.parent.worldToLocal(localTarget);
            pelvisBone.position.copy(localTarget);
            this.skinnedMesh.updateMatrixWorld(true);

            const rightHip = worldKps.right_hip;
            const leftHip = worldKps.left_hip;
            const neck = worldKps.neck;
            if (rightHip && leftHip && neck) {
                const pelvisRight = new THREE.Vector3().subVectors(leftHip, rightHip).normalize();
                const pelvisUp = new THREE.Vector3().subVectors(neck, worldKps.pelvis);
                if (pelvisUp.y < 0) pelvisUp.negate();
                pelvisUp.sub(pelvisRight.clone().multiplyScalar(pelvisUp.dot(pelvisRight))).normalize();
                const pelvisForward = new THREE.Vector3().crossVectors(pelvisRight, pelvisUp).normalize();
                const rotationMatrix = new THREE.Matrix4().makeBasis(pelvisRight, pelvisUp, pelvisForward);
                const worldQuat = new THREE.Quaternion().setFromRotationMatrix(rotationMatrix);
                const parentWorldQuat = new THREE.Quaternion();
                if (pelvisBone.parent) pelvisBone.parent.getWorldQuaternion(parentWorldQuat);
                pelvisBone.quaternion.copy(parentWorldQuat.clone().invert().multiply(worldQuat));
                pelvisBone.rotation.setFromQuaternion(pelvisBone.quaternion, pelvisBone.rotation.order);
                this.skinnedMesh.updateMatrixWorld(true);
            }
        }

        const childBoneMap = {
            spine_01: 'spine_02',
            spine_02: 'spine_03',
            spine_03: 'neck_01',
            neck_01: 'head',
            clavicle_r: 'upperarm_r',
            clavicle_l: 'upperarm_l',
        };

        const applyFK = (boneName, parentKpName, childKpName) => {
            const parentPoint = worldKps[parentKpName];
            const childPoint = worldKps[childKpName];
            const bone = this.bones[boneName];
            if (!parentPoint || !childPoint || !bone) return;

            const targetDir = new THREE.Vector3().subVectors(childPoint, parentPoint).normalize();
            if (targetDir.lengthSq() < 0.001) return;

            const childBone = childBoneMap[boneName] ? this.bones[childBoneMap[boneName]] : null;
            const currentDir = new THREE.Vector3();
            if (childBone) {
                const bonePos = new THREE.Vector3();
                const childPos = new THREE.Vector3();
                bone.getWorldPosition(bonePos);
                childBone.getWorldPosition(childPos);
                currentDir.copy(childPos.clone().sub(bonePos).normalize());
            } else {
                bone.getWorldDirection(currentDir);
            }
            if (currentDir.lengthSq() < 0.001) return;

            const boneWorldQuat = new THREE.Quaternion();
            bone.getWorldQuaternion(boneWorldQuat);
            const deltaQuat = new THREE.Quaternion().setFromUnitVectors(currentDir, targetDir);
            const newWorldQuat = deltaQuat.multiply(boneWorldQuat);
            const parentWorldQuat = new THREE.Quaternion();
            if (bone.parent) bone.parent.getWorldQuaternion(parentWorldQuat);
            bone.quaternion.copy(parentWorldQuat.clone().invert().multiply(newWorldQuat));
            bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
            this.skinnedMesh.updateMatrixWorld(true);
        };

        if (worldKps.pelvis && worldKps.neck) {
            worldKps._s1 = worldKps.pelvis.clone().lerp(worldKps.neck, 1 / 3);
            worldKps._s2 = worldKps.pelvis.clone().lerp(worldKps.neck, 2 / 3);
            applyFK('spine_01', 'pelvis', '_s1');
            applyFK('spine_02', '_s1', '_s2');
            applyFK('spine_03', '_s2', 'neck');
        }

        if (shoulderYOffset !== 0) {
            if (worldKps.right_shoulder) worldKps.right_shoulder = worldKps.right_shoulder.clone().setY(worldKps.right_shoulder.y + shoulderYOffset);
            if (worldKps.left_shoulder) worldKps.left_shoulder = worldKps.left_shoulder.clone().setY(worldKps.left_shoulder.y + shoulderYOffset);
        }

        applyFK('clavicle_r', 'neck', 'right_shoulder');
        applyFK('clavicle_l', 'neck', 'left_shoulder');
    }

    _buildWorldKeypointsFromSAM3D(data) {
        const namedPoints = this._buildSAM3DNamedPoints(data);
        const leftHip = namedPoints.left_hip;
        const rightHip = namedPoints.right_hip;
        const pelvisSource = leftHip && rightHip
            ? [
                (leftHip[0] + rightHip[0]) / 2,
                (leftHip[1] + rightHip[1]) / 2,
                (leftHip[2] + rightHip[2]) / 2,
            ]
            : (namedPoints.pelvis || null);

        if (!pelvisSource) return null;

        let mannequinPelvis = new this.THREE.Vector3(0, 0, 0);
        const pelvisBone = this.bones.pelvis || this.bones.spine_01;
        if (pelvisBone) pelvisBone.getWorldPosition(mannequinPelvis);

        const sourceHeightKeys = [
            'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear', 'neck',
            'left_shoulder', 'right_shoulder', 'left_hip', 'right_hip',
            'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
            'left_big_toe', 'right_big_toe', 'left_heel', 'right_heel',
        ];
        const sourceHeights = sourceHeightKeys
            .map((name) => namedPoints[name])
            .filter((point) => Array.isArray(point))
            .map((point) => point[1]);

        const sourceHeight = sourceHeights.length >= 2
            ? Math.max(...sourceHeights) - Math.min(...sourceHeights)
            : 0;
        const targetHeight = this._estimateCurrentModelHeight();
        const scale = sourceHeight > 1e-4 ? targetHeight / sourceHeight : 1.0;

        const toWorld = (point) => {
            if (!Array.isArray(point) || point.length < 3) return null;
            return new this.THREE.Vector3(
                mannequinPelvis.x + (point[0] - pelvisSource[0]) * scale,
                mannequinPelvis.y - (point[1] - pelvisSource[1]) * scale,
                mannequinPelvis.z - (point[2] - pelvisSource[2]) * scale,
            );
        };

        const worldKps = {
            pelvis: toWorld(pelvisSource),
            nose: toWorld(namedPoints.nose),
            neck: toWorld(namedPoints.neck || (namedPoints.neck_01 || null)),
            left_shoulder: toWorld(namedPoints.left_acromion || namedPoints.left_shoulder),
            right_shoulder: toWorld(namedPoints.right_acromion || namedPoints.right_shoulder),
            left_elbow: toWorld(namedPoints.left_elbow || namedPoints.left_olecranon || namedPoints.left_cubital_fossa),
            right_elbow: toWorld(namedPoints.right_elbow || namedPoints.right_olecranon || namedPoints.right_cubital_fossa),
            left_wrist: toWorld(namedPoints.left_wrist || namedPoints.hand_l),
            right_wrist: toWorld(namedPoints.right_wrist || namedPoints.hand_r),
            left_hip: toWorld(namedPoints.left_hip || namedPoints.thigh_l),
            right_hip: toWorld(namedPoints.right_hip || namedPoints.thigh_r),
            left_knee: toWorld(namedPoints.left_knee || namedPoints.calf_l),
            right_knee: toWorld(namedPoints.right_knee || namedPoints.calf_r),
            left_ankle: toWorld(namedPoints.left_ankle || namedPoints.foot_l),
            right_ankle: toWorld(namedPoints.right_ankle || namedPoints.foot_r),
            left_ear: toWorld(namedPoints.left_ear),
            right_ear: toWorld(namedPoints.right_ear),
            left_eye: toWorld(namedPoints.left_eye),
            right_eye: toWorld(namedPoints.right_eye),
        };

        if (!worldKps.neck && worldKps.left_shoulder && worldKps.right_shoulder) {
            worldKps.neck = new this.THREE.Vector3(
                (worldKps.left_shoulder.x + worldKps.right_shoulder.x) / 2,
                (worldKps.left_shoulder.y + worldKps.right_shoulder.y) / 2,
                (worldKps.left_shoulder.z + worldKps.right_shoulder.z) / 2,
            );
        }

        return worldKps;
    }

    applySAM3DImport(data, shoulderYOffset = 0) {
        if (!this.THREE || !this.bones || !this.skinnedMesh) return false;

        this.recordState();
        for (const bone of this.boneList) {
            if (bone.name === 'Root') continue;
            bone.quaternion.set(0, 0, 0, 1);
            bone.rotation.set(0, 0, 0);
            if (this.initialBoneStates && this.initialBoneStates[bone.name]) {
                bone.position.copy(this.initialBoneStates[bone.name].position);
            }
        }
        this.skinnedMesh.updateMatrixWorld(true);
        if (this.skeleton) this.skeleton.update();

        const usedRotationImport = this._applySAM3DRotationImport(data);

        const importTargets = this._buildSAM3DImportTargets(data);
        const worldKps = importTargets?.worldKps;
        if (worldKps?.pelvis) {
            this._hmr2WorldKps = worldKps;
            this._drawHMR2Figure(worldKps);
        }

        if (usedRotationImport) {
            this.updateMarkers();
            this.requestRender();
            this.dispatchPoseChange();
            return true;
        }
        if (!worldKps || !worldKps.pelvis) return false;

        this._hmr2WorldKps = worldKps;
        this._drawHMR2Figure(worldKps);
        this._applyImportPelvisAndTorso(worldKps, shoulderYOffset);

        const setEffectorTarget = (name, target) => {
            const effector = this.ikController?.effectors?.[name];
            if (effector && target) effector.position.copy(target);
        };
        for (const [name, target] of Object.entries(importTargets.effectorTargets || {})) {
            setEffectorTarget(name, target);
        }
        for (const [chainKey, poleTarget] of Object.entries(importTargets.poleTargets || {})) {
            const helper = this.ikController?.poleTargets?.[chainKey];
            if (helper && poleTarget) helper.position.copy(poleTarget);
        }

        if (importTargets.effectorTargets.upperarm_r) {
            this.ikController.ccdSolver.solve(IK_CHAINS.rightShoulder, this.bones, importTargets.effectorTargets.upperarm_r);
            this.skinnedMesh.updateMatrixWorld(true);
        }
        if (importTargets.effectorTargets.upperarm_l) {
            this.ikController.ccdSolver.solve(IK_CHAINS.leftShoulder, this.bones, importTargets.effectorTargets.upperarm_l);
            this.skinnedMesh.updateMatrixWorld(true);
        }
        if (importTargets.effectorTargets.head) {
            this.ikController.ccdSolver.solve(IK_CHAINS.spine, this.bones, importTargets.effectorTargets.head);
            this.skinnedMesh.updateMatrixWorld(true);
        }

        const ikFinishing = [
            { chainKey: 'rightArm', effectorName: 'hand_r' },
            { chainKey: 'leftArm', effectorName: 'hand_l' },
            { chainKey: 'rightLeg', effectorName: 'foot_r' },
            { chainKey: 'leftLeg', effectorName: 'foot_l' },
        ];
        for (const { chainKey, effectorName } of ikFinishing) {
            const chainDef = IK_CHAINS[chainKey];
            const target = importTargets.effectorTargets[effectorName];
            const poleTarget = importTargets.poleTargets[chainKey] || null;
            if (!chainDef || !target) continue;
            this.ikController.ccdSolver.solve(chainDef, this.bones, target, poleTarget);
            this.skinnedMesh.updateMatrixWorld(true);
        }

        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
        this.updateMarkers();
        this.requestRender();
        this.dispatchPoseChange();
        return true;
    }

    applyHMR2v1Import(data, smplRefHeight = 1.45, shoulderYOffset = 0) {
        if (!this.THREE || !this.bones || !this.skinnedMesh) return false;

        const people = data?.people || [];
        const person = people[0];
        const kp3d = person?.keypoints_3d;
        if (!kp3d) return false;

        let mannequinPelvis = new this.THREE.Vector3(0, 0, 0);
        const pelvisBone = this.bones.pelvis || this.bones.spine_01;
        if (pelvisBone) pelvisBone.getWorldPosition(mannequinPelvis);

        const targetHeight = this._estimateCurrentModelHeight();
        const smplScale = targetHeight / Math.max(0.1, smplRefHeight || 1.45);
        const smplPelvis = kp3d.pelvis || [0, 0, 0];

        const worldKps = {};
        for (const [name, xyz] of Object.entries(kp3d)) {
            if (!Array.isArray(xyz) || xyz.length < 3) continue;
            worldKps[name] = new this.THREE.Vector3(
                mannequinPelvis.x + (xyz[0] - smplPelvis[0]) * smplScale,
                mannequinPelvis.y - (xyz[1] - smplPelvis[1]) * smplScale,
                mannequinPelvis.z - (xyz[2] - smplPelvis[2]) * smplScale,
            );
        }

        this._hmr2WorldKps = worldKps;
        this._drawHMR2Figure(worldKps);
        this.fitMannequinToHMR2(shoulderYOffset);
        return true;
    }

    fitMannequinToHMR2(shoulderYOffset = 0) {
        if (!this._hmr2WorldKps || !this.bones || !this.ikController || !this.skinnedMesh) return;

        const THREE = this.THREE;
        const worldKps = this._hmr2WorldKps;

        this.recordState();
        for (const bone of this.boneList) {
            if (bone.name === 'Root') continue;
            bone.quaternion.set(0, 0, 0, 1);
            bone.rotation.set(0, 0, 0);
            if (this.initialBoneStates && this.initialBoneStates[bone.name]) {
                bone.position.copy(this.initialBoneStates[bone.name].position);
            }
        }
        this.skinnedMesh.updateMatrixWorld(true);
        if (this.skeleton) this.skeleton.update();

        const pelvisBone = this.bones.pelvis || this.bones.spine_01;
        if (pelvisBone && worldKps.pelvis) {
            const localTarget = worldKps.pelvis.clone();
            if (pelvisBone.parent) pelvisBone.parent.worldToLocal(localTarget);
            pelvisBone.position.copy(localTarget);
            this.skinnedMesh.updateMatrixWorld(true);

            const rightHip = worldKps.right_hip;
            const leftHip = worldKps.left_hip;
            const neck = worldKps.neck;
            if (rightHip && leftHip && neck) {
                const pelvisRight = new THREE.Vector3().subVectors(leftHip, rightHip).normalize();
                const pelvisUp = new THREE.Vector3().subVectors(neck, worldKps.pelvis);
                if (pelvisUp.y < 0) pelvisUp.negate();
                pelvisUp.sub(pelvisRight.clone().multiplyScalar(pelvisUp.dot(pelvisRight))).normalize();
                const pelvisForward = new THREE.Vector3().crossVectors(pelvisRight, pelvisUp).normalize();
                const rotationMatrix = new THREE.Matrix4().makeBasis(pelvisRight, pelvisUp, pelvisForward);
                const worldQuat = new THREE.Quaternion().setFromRotationMatrix(rotationMatrix);
                const parentWorldQuat = new THREE.Quaternion();
                if (pelvisBone.parent) pelvisBone.parent.getWorldQuaternion(parentWorldQuat);
                pelvisBone.quaternion.copy(parentWorldQuat.clone().invert().multiply(worldQuat));
                pelvisBone.rotation.setFromQuaternion(pelvisBone.quaternion, pelvisBone.rotation.order);
                this.skinnedMesh.updateMatrixWorld(true);
            }
        }

        const childBoneMap = {
            spine_01: 'spine_02',
            spine_02: 'spine_03',
            spine_03: 'neck_01',
            neck_01: 'head',
            clavicle_r: 'upperarm_r',
            clavicle_l: 'upperarm_l',
            upperarm_r: 'lowerarm_r',
            lowerarm_r: 'hand_r',
            upperarm_l: 'lowerarm_l',
            lowerarm_l: 'hand_l',
            thigh_r: 'calf_r',
            calf_r: 'foot_r',
            thigh_l: 'calf_l',
            calf_l: 'foot_l',
        };

        const applyFK = (boneName, parentKpName, childKpName) => {
            const parentPoint = worldKps[parentKpName];
            const childPoint = worldKps[childKpName];
            const bone = this.bones[boneName];
            if (!parentPoint || !childPoint || !bone) return;

            const targetDir = new THREE.Vector3().subVectors(childPoint, parentPoint).normalize();
            if (targetDir.lengthSq() < 0.001) return;

            const childBone = childBoneMap[boneName] ? this.bones[childBoneMap[boneName]] : null;
            let currentDir = new THREE.Vector3();
            if (childBone) {
                const bonePos = new THREE.Vector3();
                const childPos = new THREE.Vector3();
                bone.getWorldPosition(bonePos);
                childBone.getWorldPosition(childPos);
                currentDir = childPos.clone().sub(bonePos).normalize();
            } else {
                bone.getWorldDirection(currentDir);
            }
            if (currentDir.lengthSq() < 0.001) return;

            const boneWorldQuat = new THREE.Quaternion();
            bone.getWorldQuaternion(boneWorldQuat);
            const deltaQuat = new THREE.Quaternion().setFromUnitVectors(currentDir, targetDir);
            const newWorldQuat = deltaQuat.multiply(boneWorldQuat);
            const parentWorldQuat = new THREE.Quaternion();
            if (bone.parent) bone.parent.getWorldQuaternion(parentWorldQuat);
            bone.quaternion.copy(parentWorldQuat.clone().invert().multiply(newWorldQuat));
            bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
            this.skinnedMesh.updateMatrixWorld(true);
        };

        if (worldKps.pelvis && worldKps.neck) {
            worldKps._s1 = worldKps.pelvis.clone().lerp(worldKps.neck, 1 / 3);
            worldKps._s2 = worldKps.pelvis.clone().lerp(worldKps.neck, 2 / 3);
            applyFK('spine_01', 'pelvis', '_s1');
            applyFK('spine_02', '_s1', '_s2');
            applyFK('spine_03', '_s2', 'neck');
        }

        const rightEar = worldKps.right_ear;
        const leftEar = worldKps.left_ear;
        if (rightEar && leftEar) {
            worldKps._earMid = new THREE.Vector3(
                (rightEar.x + leftEar.x) / 2,
                (rightEar.y + leftEar.y) / 2,
                (rightEar.z + leftEar.z) / 2,
            );
        }
        if (worldKps._earMid) {
            applyFK('neck_01', 'neck', '_earMid');
            if (worldKps.nose) applyFK('head', '_earMid', 'nose');
        } else {
            applyFK('neck_01', 'neck', 'nose');
        }

        if (shoulderYOffset !== 0) {
            if (worldKps.right_shoulder) worldKps.right_shoulder = worldKps.right_shoulder.clone().setY(worldKps.right_shoulder.y + shoulderYOffset);
            if (worldKps.left_shoulder) worldKps.left_shoulder = worldKps.left_shoulder.clone().setY(worldKps.left_shoulder.y + shoulderYOffset);
        }

        applyFK('clavicle_r', 'neck', 'right_shoulder');
        applyFK('clavicle_l', 'neck', 'left_shoulder');
        applyFK('upperarm_r', 'right_shoulder', 'right_elbow');
        applyFK('lowerarm_r', 'right_elbow', 'right_wrist');
        applyFK('upperarm_l', 'left_shoulder', 'left_elbow');
        applyFK('lowerarm_l', 'left_elbow', 'left_wrist');
        applyFK('thigh_r', 'right_hip', 'right_knee');
        applyFK('calf_r', 'right_knee', 'right_ankle');
        applyFK('thigh_l', 'left_hip', 'left_knee');
        applyFK('calf_l', 'left_knee', 'left_ankle');

        const ikFinishing = [
            { chainKey: 'rightArm', target: worldKps.right_wrist },
            { chainKey: 'leftArm', target: worldKps.left_wrist },
            { chainKey: 'rightLeg', target: worldKps.right_ankle },
            { chainKey: 'leftLeg', target: worldKps.left_ankle },
        ];
        for (const { chainKey, target } of ikFinishing) {
            if (!target) continue;
            const chainDef = IK_CHAINS[chainKey];
            if (!chainDef) continue;
            this.ikController.solveWithPole(chainDef, this.bones, target, chainKey);
            this.skinnedMesh.updateMatrixWorld(true);
        }

        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
        this.updateMarkers();
        this.updateIKEffectorPositions();
        this.requestRender();
        this.dispatchPoseChange();
    }

    setMannequinVisible(visible) {
        this._mannequinVisible = visible;
        if (this.skinnedMesh) this.skinnedMesh.visible = visible;
        if (this.skeletonHelper) this.skeletonHelper.visible = visible;
        if (this.jointMarkers) this.jointMarkers.forEach(marker => { marker.visible = visible && this._shouldMarkerBeVisible(marker); });
        this.requestRender();
    }

    saveRTMWCameraState() {
        if (!this.camera || !this.orbit) return;
        this._rtmwSavedCamera = {
            position: this.camera.position.clone(),
            quaternion: this.camera.quaternion.clone(),
            target: this.orbit.target.clone(),
            fov: this.camera.fov,
        };
    }

    restoreRTMWCameraState() {
        if (!this._rtmwSavedCamera) return false;
        this.camera.position.copy(this._rtmwSavedCamera.position);
        this.camera.quaternion.copy(this._rtmwSavedCamera.quaternion);
        this.orbit.target.copy(this._rtmwSavedCamera.target);
        this.camera.fov = this._rtmwSavedCamera.fov;
        this.camera.updateProjectionMatrix();
        this.orbit.update();
        this.requestRender();
        this.dispatchPoseChange();
        return true;
    }

    setRTMWFigureCameraParented(parented) {
        this._rtmwCameraParented = parented;
        if (!this._rtmwFigureGroup) return;
        if (parented) {
            this.camera.attach(this._rtmwFigureGroup);
        } else {
            this.scene.attach(this._rtmwFigureGroup);
        }
        this.requestRender();
    }

    setKpFigureVisible(visible) {
        if (this._kpFigureGroup) {
            this._kpFigureGroup.visible = visible;
            this.requestRender();
        }
        if (this._rtmwFigureGroup) {
            this._rtmwFigureGroup.visible = visible;
            this.requestRender();
        }
        if (this._hmr2FigureGroup) {
            this._hmr2FigureGroup.visible = visible;
            this.requestRender();
        }
        if (this._hmr2CanvasGroup) {
            this._hmr2CanvasGroup.visible = visible;
            this.requestRender();
        }
    }

    moveBoneToPosition(boneName, x, y, z) {
        const bone = this.boneList.find(item => item.name === boneName);
        if (!bone) {
            return false;
        }

        const worldPos = new this.THREE.Vector3(x, y, z);
        if (bone.parent) {
            const parentWorldInv = new this.THREE.Matrix4().copy(bone.parent.matrixWorld).invert();
            worldPos.applyMatrix4(parentWorldInv);
        }

        bone.position.copy(worldPos);
        bone.updateMatrixWorld(true);
        if (this.skeleton) this.skeleton.update();
        this.updateMarkers();
        this.requestRender();
        return true;
    }

    _findRTMWJointMesh(kpName) {
        if (!this._rtmwFigureGroup) return null;
        let found = null;
        this._rtmwFigureGroup.traverse((obj) => {
            if (!found && obj.userData.isRTMWJoint && typeof this._getRTMWKpName === 'function' && this._getRTMWKpName(obj.userData.rtmwKpIndex) === kpName) {
                found = obj;
            }
        });
        return found;
    }

    getRTMWJointWorldPos(kpName) {
        const mesh = this._findRTMWJointMesh(kpName);
        if (!mesh) return null;
        const worldPos = new this.THREE.Vector3();
        mesh.getWorldPosition(worldPos);
        return worldPos;
    }

    moveRTMWJoint(kpName, x, y, z) {
        const mesh = this._findRTMWJointMesh(kpName);
        if (!mesh) return false;
        const worldPos = new this.THREE.Vector3(x, y, z);
        if (mesh.parent) {
            const parentWorldInv = new this.THREE.Matrix4().copy(mesh.parent.matrixWorld).invert();
            worldPos.applyMatrix4(parentWorldInv);
        }
        mesh.position.copy(worldPos);
        this.requestRender();
        return true;
    }
}


// === Pose Studio Widget ===


export { IK_CHAINS };
