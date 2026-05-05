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
        threshold: 0.001
    }
};

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

        if (this.isPoleTargetEnabled(chainKey) && this.poleTargets[chainKey]) {
            poleTarget = this.poleTargets[chainKey].position.clone();
        }

        // For leg chains: always use current knee world position as pole target to prevent knee flip
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
        this._resizeObserver = null;

        // Default constraints based on standard UI Embedding requirements
        this.options = {
            onPoseChange: null,
            onError: console.error,
            onInteractionStart: null,
            onInteractionEnd: null,

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
    }






////////////////////////////////////
syncResolutionIfNeeded() {
    if (!this.renderer || !this.canvas) return;

    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const dpr = window.devicePixelRatio || 1;

    if (this._lastW === rect.width &&
        this._lastH === rect.height &&
        this._lastDPR === dpr) {
        return;
    }

    this._lastW = rect.width;
    this._lastH = rect.height;
    this._lastDPR = dpr;

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(rect.width, rect.height, false);

    if (this.camera) {
        this.camera.aspect = rect.width / rect.height;
        this.camera.updateProjectionMatrix();
    }

    // ★ここが重要（これが無いと黒くなる）
    this.requestRender();
}
//////////////////////////////////





 updateRendererResolution() {
    if (!this.renderer || !this.canvas) return;

    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const dpr = window.devicePixelRatio || 1;

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(rect.width, rect.height, false);

    if (this.camera) {
        this.camera.aspect = rect.width / rect.height;
        this.camera.updateProjectionMatrix();
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

        // ★ 初期ボケ対策（確定版）
        requestAnimationFrame(() => {
            this.updateRendererResolution();
            this.requestRender();
        });

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
        this.scene.add(this.camera); // Required for camera children (refPlane) to render

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
        this.orbit.enableDamping = true;
        this.orbit.dampingFactor = 0.12;
        this.orbit.rotateSpeed = 0.95;
        // VaM-style mouse buttons: Right=Rotate, Middle=Pan, Left=Select/IK
        this.orbit.mouseButtons = {
            LEFT: this.THREE.MOUSE.NONE,
            MIDDLE: this.THREE.MOUSE.PAN,
            RIGHT: this.THREE.MOUSE.ROTATE
        };
        // No inertia - instant response like VaM
        this.orbit.enableDamping = false;
        // Disable built-in zoom; handled below with non-linear scaling
        this.orbit.enableZoom = false;
        this.orbit.update();

        // Non-linear zoom: small delta = fine, large delta = fast
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const delta = e.deltaY;
            const absDelta = Math.abs(delta);
            // Scale factor: grows slowly for small input, faster for large input
            const scale = 1.0 + Math.sign(delta) * Math.min(0.004 * absDelta, 0.075);
            this.camera.position.sub(this.orbit.target)
                .multiplyScalar(scale)
                .add(this.orbit.target);
            this.orbit.update();
            this.requestRender();
        }, { passive: false });


////////////////////////////////////
        // Render on demand: orbit change triggers render
        //this.orbit.addEventListener('change', () => this.requestRender());






this.orbit.addEventListener('change', () => {

    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) {
        this.requestRender();
        return;
    }

    const dpr = window.devicePixelRatio || 1;

    // 差分チェック
    if (this._lastW !== rect.width || this._lastH !== rect.height) {

        this._lastW = rect.width;
        this._lastH = rect.height;

        this.renderer.setPixelRatio(dpr);
        this.renderer.setSize(rect.width, rect.height, false);

        if (this.camera) {
            this.camera.aspect = rect.width / rect.height;
            this.camera.updateProjectionMatrix();
        }
    }

    this.requestRender();
});








////////////////////////////////////




        // Dispatch pose change when camera orbit ends (so output updates on view change)
        this.orbit.addEventListener('end', () => this.dispatchPoseChange());

        // ResizeObserver: update overlay whenever canvas size changes in DOM
if (typeof ResizeObserver !== 'undefined') {
    this._resizeObserver = new ResizeObserver(() => {
        this.updateRendererResolution();
        if (this.outputAspect) this.updateCaptureFrameOverlay();
        this.requestRender();
    });
    this._resizeObserver.observe(this.canvas);
}



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

        // Orange frame replaced by CSS overlay (captureFrameOverlay)

        // Events
        this.canvas.addEventListener("pointerdown", (e) => this.handlePointerDown(e));
        this.canvas.addEventListener("pointermove", (e) => this.handlePointerMove(e));
        this.canvas.addEventListener("keydown", (e) => this.handleKeyDown(e));
        this.canvas.setAttribute("tabindex", "0"); // Make canvas focusable
        this.canvas.addEventListener("pointerup", (e) => this.handlePointerUp(e));

        this.hoveredBoneName = null;
        this.boneRotateDrag = null;
        this.directDrag = { active: false, chainKey: null, effector: null, plane: null, offset: null };
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



///////////////////////////////////////////
animate() {
    if (!this.initialized) return;

    // ★解像度を最初に同期
    this.syncResolutionIfNeeded();

    // Orbit damping
    if (this.orbit.enableDamping) {
        this.orbit.update();
    }

    if (this._needsRender) {
        this._needsRender = false;
        if (this.renderer) this.renderer.render(this.scene, this.camera);
    }

    requestAnimationFrame(() => this.animate());
}


///////////////////////////////////////////

    requestRender() {
        this._needsRender = true;
    }

    handleKeyDown(e) {
        if (e.code === 'KeyF') {
            // Focus orbit target on selected or hovered bone
            const bone = this.selectedBone ||
                (this.hoveredBoneName ? this.boneList.find(b => b.name === this.hoveredBoneName) : null);
            if (bone) {
                const worldPos = new this.THREE.Vector3();
                bone.getWorldPosition(worldPos);
                this.orbit.target.copy(worldPos);
                this.orbit.update();
                this.requestRender();
                return;
            }
            // Focus on selected or hovered RTMW joint
            const rtmwJoint = this._selectedRTMWJoint || this._hoveredRTMWJoint;
            if (rtmwJoint) {
                const worldPos = new this.THREE.Vector3();
                rtmwJoint.getWorldPosition(worldPos);
                this.orbit.target.copy(worldPos);
                this.orbit.update();
                this.requestRender();
            }
        }
    }

    _setRTMWJointHighlight(mesh, mode) {
        if (!mesh) return;
        if (mode === 'hover')        mesh.scale.setScalar(1.5);
        else if (mode === 'select')  mesh.scale.setScalar(2.0);
        else                         mesh.scale.setScalar(1.0);
    }

    _getRTMWKpName(idx) {
        const NAMES = [
            // Body 0–16 (matches BODY_NAMES in debug log)
            'nose','l_eye','r_eye','l_ear','r_ear',
            'l_shldr','r_shldr','l_elbow','r_elbow',
            'l_wrist','r_wrist','l_hip','r_hip',
            'l_knee','r_knee','l_ankle','r_ankle',
            // Feet 17–22
            'l_big_toe','l_sml_toe','l_heel',
            'r_big_toe','r_sml_toe','r_heel',
        ];
        if (idx >= 0 && idx < NAMES.length) return NAMES[idx];
        if (idx >= 23 && idx <= 90)  return `face_${String(idx - 23).padStart(2, '0')}`;
        if (idx >= 91 && idx <= 111) return `lhand_${String(idx - 91).padStart(2, '0')}`;
        if (idx >= 112 && idx <= 132) return `rhand_${String(idx - 112).padStart(2, '0')}`;
        return `kp_${idx}`;
    }

    handlePointerDown(e) {
        if (!this.initialized || !this.skinnedMesh) return;

        if (e.button !== 0) return;

        // Shift or Ctrl + left drag: bone rotation mode - skip IK entirely
        if (e.ctrlKey || e.shiftKey) {
            // Hovered bone takes priority over selected bone
            const targetBone = (this.hoveredBoneName
                ? this.boneList.find(b => b.name === this.hoveredBoneName)
                : null) || this.selectedBone;
            if (targetBone) {
                this.recordState();
                this.directDrag.active = true;
                this.directDrag.rotMode = true;
                this.directDrag.rotBone = targetBone;
                this.directDrag.lastRotX = e.clientX;
                this.directDrag.lastRotY = e.clientY;
                // Save pre-drag selection state, restore on mouseUp
                this.directDrag.savedSelectedBone = this.selectedBone;
                this.orbit.enabled = false;
                this.transform.enabled = false; // suppress gizmo highlight during rot drag
                this.canvas.style.cursor = 'none';
                this.canvas.setPointerCapture(e.pointerId);
                // Highlight only, no gizmo, no selectBone
                this.hoveredBoneName = targetBone.name;
                this.updateMarkers();
                this.requestRender();
                return;
            }
        }

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
        const markerIntersects = this._mannequinVisible !== false
            ? raycaster.intersectObjects(this.jointMarkers, false)
            : [];

        if (markerIntersects.length > 0) {
            // Sort by distance and pick the closest one
            markerIntersects.sort((a, b) => a.distance - b.distance);
            const hitMarker = markerIntersects[0].object;
            const boneIdx = this.jointMarkers.indexOf(hitMarker);
            if (boneIdx !== -1 && this.boneList[boneIdx]) {
                const bone = this.boneList[boneIdx];

                // Shoulder drag: upperarm → rotate clavicle (1-bone IK)
                if (this.ikMode && this.shoulderIKEnabled !== false && (bone.name === 'upperarm_l' || bone.name === 'upperarm_r')) {
                    const shoulderKey = bone.name === 'upperarm_l' ? 'leftShoulder' : 'rightShoulder';
                    const clavName = bone.name === 'upperarm_l' ? 'clavicle_l' : 'clavicle_r';
                    const clavBone = this.boneList.find(b => b.name === clavName);
                    if (clavBone) {
                        this.recordState();
                        const cameraDir = new this.THREE.Vector3();
                        this.camera.getWorldDirection(cameraDir);
                        const boneWorld = new this.THREE.Vector3();
                        bone.getWorldPosition(boneWorld);
                        const plane = new this.THREE.Plane();
                        plane.setFromNormalAndCoplanarPoint(cameraDir, boneWorld);
                        const intersectPoint = new this.THREE.Vector3();
                        raycaster.ray.intersectPlane(plane, intersectPoint);

                        this.directDrag.active = true;
                        this.directDrag.chainKey = shoulderKey;
                        this.directDrag.targetType = 'shoulder';
                        this.directDrag.shoulderClavicle = clavBone;
                        this.directDrag.shoulderUpperarm = bone;
                        this.directDrag.plane = plane;
                        this.directDrag.offset = intersectPoint
                            ? boneWorld.clone().sub(intersectPoint)
                            : new this.THREE.Vector3();
                        this.directDrag.effector = null;
                        this.directDrag.hasDragged = false;
                        this.directDrag.savedSelectedBone = this.selectedBone;
                        this.directDrag.clickedBone = bone;
                        this.orbit.enabled = false;
                        this.canvas.style.cursor = 'none';
                        this.transform.detach();
                        this.canvas.setPointerCapture(e.pointerId);
                        return;
                    }
                }

                // Spine bend: drag spine_01/02/03 to rotate that bone only, neck/head stay in place
                if (this.ikMode && ['spine_01', 'spine_02', 'spine_03'].includes(bone.name)) {
                    this.recordState();
                    this.directDrag.active = true;
                    this.directDrag.targetType = 'spine_bend';
                    this.directDrag.spineBone = bone;
                    this.directDrag.rotMode = true;
                    this.directDrag.rotBone = bone;
                    this.directDrag.lastRotX = e.clientX;
                    this.directDrag.lastRotY = e.clientY;
                    this.directDrag.hasDragged = false;
                    this.directDrag.savedSelectedBone = this.selectedBone;
                    this.directDrag.clickedBone = bone;
                    this.orbit.enabled = false;
                    this.transform.enabled = false;
                    this.canvas.style.cursor = 'none';
                    this.canvas.setPointerCapture(e.pointerId);
                    return;
                }

                // Finger bones: plain drag → rotMode (no gizmo, trackball style)
                const FINGER_BONE_NAMES = new Set([
                    'thumb_01_l','thumb_02_l','thumb_03_l','index_01_l','index_02_l','index_03_l',
                    'middle_01_l','middle_02_l','middle_03_l','ring_01_l','ring_02_l','ring_03_l',
                    'pinky_01_l','pinky_02_l','pinky_03_l',
                    'thumb_01_r','thumb_02_r','thumb_03_r','index_01_r','index_02_r','index_03_r',
                    'middle_01_r','middle_02_r','middle_03_r','ring_01_r','ring_02_r','ring_03_r',
                    'pinky_01_r','pinky_02_r','pinky_03_r',
                ]);
                const isFinger = FINGER_BONE_NAMES.has(bone.name);
                if (isFinger && !e.ctrlKey && !e.shiftKey) {
                    this.recordState();
                    this.directDrag.active = true;
                    this.directDrag.rotMode = true;
                    this.directDrag.rotBone = bone;
                    this.directDrag.lastRotX = e.clientX;
                    this.directDrag.lastRotY = e.clientY;
                    this.directDrag.hasDragged = false;
                    this.directDrag.savedSelectedBone = this.selectedBone;
                    this.directDrag.clickedBone = bone;
                    this.orbit.enabled = false;
                    this.transform.enabled = false;
                    this.canvas.style.cursor = 'none';
                    this.canvas.setPointerCapture(e.pointerId);
                    this.hoveredBoneName = bone.name;
                    this.updateMarkers();
                    this.requestRender();
                    return;
                }

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
                            this.directDrag.hasDragged = false;
                            this.directDrag.savedSelectedBone = this.selectedBone;
                            this.directDrag.clickedBone = bone; // remember for click selection
                            this.canvas.style.cursor = 'none';

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
        const meshIntersects = this._mannequinVisible !== false
            ? raycaster.intersectObject(this.skinnedMesh, true)
            : [];

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
                // Skip upperarm in PASS 2: shoulder IK should only trigger from PASS 1 (marker hit)
                if (nearest.name === 'upperarm_l' || nearest.name === 'upperarm_r') nearest = null;
            }
            if (nearest && minD < 1.5) {
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
                            this.directDrag.hasDragged = false;
                            this.directDrag.savedSelectedBone = this.selectedBone;
                            this.directDrag.clickedBone = nearest; // remember for click selection
                            this.canvas.style.cursor = 'none';

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

        // If nothing hit on mannequin - check RTMW joint hover
        if (this._hoveredRTMWJoint) {
            // Select this RTMW joint
            if (this._selectedRTMWJoint !== this._hoveredRTMWJoint) {
                if (this._selectedRTMWJoint)
                    this._setRTMWJointHighlight(this._selectedRTMWJoint,
                        this._selectedRTMWJoint === this._hoveredRTMWJoint ? 'hover' : 'none');
                this._selectedRTMWJoint = this._hoveredRTMWJoint;
                this._setRTMWJointHighlight(this._selectedRTMWJoint, 'select');
                const kpIdx = this._selectedRTMWJoint.userData.rtmwKpIndex;
                if (this.options.onBoneSelect)
                    this.options.onBoneSelect(this._getRTMWKpName(kpIdx));
                this.requestRender();
            }
            return;
        }

        // If nothing hit - deselect both bone and IK effector
        this.deselectBone();
        if (this.selectedIKEffector) {
            this.deselectIKEffector();
        }
        // Also deselect RTMW joint
        if (this._selectedRTMWJoint) {
            this._setRTMWJointHighlight(this._selectedRTMWJoint,
                this._selectedRTMWJoint === this._hoveredRTMWJoint ? 'hover' : 'none');
            this._selectedRTMWJoint = null;
            this.requestRender();
        }
    }

    handlePointerMove(e) {
        if (!this.initialized || !this.skinnedMesh) return;

        const rect = this.canvas.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        const raycaster = new this.THREE.Raycaster();
        raycaster.setFromCamera(new this.THREE.Vector2(x, y), this.camera);

        // Left-drag + Ctrl/Shift: bone rotation in camera space (VaM-style)
        // Ctrl = pitch/yaw (left-right / up-down),  Shift = roll (twist)
        // Only active during IK drag (no gizmo)
        if (this.directDrag && this.directDrag.active && (e.ctrlKey || e.shiftKey)) {
            // Detect mode entry: reset last position to avoid jump on first frame
            if (!this.directDrag.rotMode) {
                this.directDrag.rotMode = true;
                this.directDrag.lastRotX = e.clientX;
                this.directDrag.lastRotY = e.clientY;
            }
            const dx = e.clientX - this.directDrag.lastRotX;
            const dy = e.clientY - this.directDrag.lastRotY;
            this.directDrag.lastRotX = e.clientX;
            this.directDrag.lastRotY = e.clientY;

            const chainDef = this.directDrag.chainKey ? IK_CHAINS[this.directDrag.chainKey] : null;
            const bone = this.directDrag.rotBone || this.selectedBone ||
                (chainDef ? this.boneList.find(b => b.name === chainDef.effector) : null);

            if (bone) {
                const sensitivity = 0.01;
                const boneWorldInv = new this.THREE.Matrix4().copy(bone.matrixWorld).invert();

                // Both Ctrl and Shift: trackball-style rotation
                // Left-right drag = camera up axis (north/south pole), up-down drag = camera right axis
                const camRight = new this.THREE.Vector3();
                const camUp = new this.THREE.Vector3();
                camRight.setFromMatrixColumn(this.camera.matrixWorld, 0);
                camUp.setFromMatrixColumn(this.camera.matrixWorld, 1);

                // Vertical drag: pitch around camRight (same for both Ctrl and Shift)
                // Horizontal drag: Shift=yaw around camUp, Ctrl=roll around camForward
                let worldDelta;
                if (e.shiftKey) {
                    // Shift: trackball - horizontal=yaw, vertical=pitch
                    const qX = new this.THREE.Quaternion().setFromAxisAngle(camUp, dx * sensitivity);
                    const qY = new this.THREE.Quaternion().setFromAxisAngle(camRight, dy * sensitivity);
                    worldDelta = qX.multiply(qY);
                } else {
                    // Ctrl: horizontal=roll (camera forward axis, right-drag=clockwise), vertical=pitch
                    const camForward = new this.THREE.Vector3();
                    this.camera.getWorldDirection(camForward);
                    const qZ = new this.THREE.Quaternion().setFromAxisAngle(camForward, dx * sensitivity);
                    const qY = new this.THREE.Quaternion().setFromAxisAngle(camRight, dy * sensitivity);
                    worldDelta = qZ.multiply(qY);
                }

                // Convert world-space delta to bone's parent space
                // bone.quaternion lives in parent space, so: localDelta = inv(parentWorld) * worldDelta * parentWorld
                const parentWorldQuat = new this.THREE.Quaternion();
                if (bone.parent) {
                    bone.parent.getWorldQuaternion(parentWorldQuat);
                }
                const localDelta = parentWorldQuat.clone().invert().multiply(worldDelta).multiply(parentWorldQuat);
                bone.quaternion.premultiply(localDelta);

                // CRITICAL: sync Euler rotation from quaternion so setPose/getPose stays consistent
                bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
                bone.updateMatrixWorld(true);
                if (this.skeleton) this.skeleton.update();

                // Spine bend: counter-rotate neck_01 to keep head in place
                if (this.directDrag && this.directDrag.targetType === 'spine_bend') {
                    const neck = this.bones['neck_01'];
                    if (neck) {
                        // Apply inverse of worldDelta to neck_01 to cancel propagation
                        const neckParentQ = new this.THREE.Quaternion();
                        if (neck.parent) neck.parent.getWorldQuaternion(neckParentQ);
                        const invDelta = worldDelta.clone().invert();
                        const neckLocalDelta = neckParentQ.clone().invert().multiply(invDelta).multiply(neckParentQ);
                        neck.quaternion.premultiply(neckLocalDelta);
                        neck.rotation.setFromQuaternion(neck.quaternion, neck.rotation.order);
                        neck.updateMatrixWorld(true);
                        if (this.skeleton) this.skeleton.update();
                    }
                }

                this.updateMarkers();
                this.requestRender();
            }
            return;
        }
        // Modifier released mid-drag: exit rot mode and recalculate IK offset from current state
        if (this.directDrag && this.directDrag.active && this.directDrag.rotMode) {
            this.directDrag.rotMode = false;
            this.transform.enabled = true;

            // Recalculate plane and offset from current effector/bone position
            // so IK drag resumes from where the mouse currently is, no jump
            const raycasterReset = new this.THREE.Raycaster();
            const rectReset = this.canvas.getBoundingClientRect();
            const xr = ((e.clientX - rectReset.left) / rectReset.width) * 2 - 1;
            const yr = -((e.clientY - rectReset.top) / rectReset.height) * 2 + 1;
            raycasterReset.setFromCamera(new this.THREE.Vector2(xr, yr), this.camera);

            const cameraDir = new this.THREE.Vector3();
            this.camera.getWorldDirection(cameraDir);

            if (this.directDrag.effector) {
                // Rebase plane on current effector position
                this.directDrag.plane.setFromNormalAndCoplanarPoint(cameraDir, this.directDrag.effector.position);
                const newIntersect = new this.THREE.Vector3();
                raycasterReset.ray.intersectPlane(this.directDrag.plane, newIntersect);
                if (newIntersect) {
                    this.directDrag.offset.copy(this.directDrag.effector.position).sub(newIntersect);
                }
            } else if (this.directDrag.rotBone) {
                // FK bone drag: rebase plane on bone world position
                const boneWorld = new this.THREE.Vector3();
                this.directDrag.rotBone.getWorldPosition(boneWorld);
                this.directDrag.plane.setFromNormalAndCoplanarPoint(cameraDir, boneWorld);
                const newIntersect = new this.THREE.Vector3();
                raycasterReset.ray.intersectPlane(this.directDrag.plane, newIntersect);
                if (newIntersect) {
                    this.directDrag.offset.copy(boneWorld).sub(newIntersect);
                }
            }
        }

        // Process Direct Limb Dragging updates IK effector seamlessly in screen space
        if (this.directDrag && this.directDrag.active) {
            this.directDrag.hasDragged = true;

            // Shoulder drag: point clavicle toward dragged upperarm position
            if (this.directDrag.targetType === 'shoulder') {
                const intersectPoint = new this.THREE.Vector3();
                raycaster.ray.intersectPlane(this.directDrag.plane, intersectPoint);
                if (intersectPoint) {
                    const targetPos = intersectPoint.clone().add(this.directDrag.offset);
                    const clavBone = this.directDrag.shoulderClavicle;
                    const upperarmBone = this.directDrag.shoulderUpperarm;

                    // Get upperarm world pos BEFORE rotation
                    const upperarmBefore = new this.THREE.Vector3();
                    upperarmBone.getWorldPosition(upperarmBefore);

                    // Rotate clavicle to point upperarm toward target
                    const analytic = this.ikController
                        ? this.ikController.ccdSolver.analyticSolver
                        : new AnalyticIKSolver(this.THREE);
                    analytic.rotateBoneToPoint(clavBone, upperarmBefore, targetPos, this.THREE);
                    clavBone.rotation.setFromQuaternion(clavBone.quaternion, clavBone.rotation.order);
                    clavBone.updateMatrixWorld(true);
                    if (this.skeleton) this.skeleton.update();

                    // Get upperarm world pos AFTER rotation → compute delta
                    const upperarmAfter = new this.THREE.Vector3();
                    upperarmBone.getWorldPosition(upperarmAfter);
                    const delta = upperarmAfter.clone().sub(upperarmBefore);

                    // Move hand IK effector by same delta (arm moves as a unit)
                    const handEffectorName = upperarmBone.name === 'upperarm_l' ? 'hand_l' : 'hand_r';
                    const handEffector = this.ikController && this.ikController.effectors[handEffectorName];
                    if (handEffector) {
                        handEffector.position.add(delta);
                        const armChainKey = upperarmBone.name === 'upperarm_l' ? 'leftArm' : 'rightArm';
                        this.ikController.solveWithPole(IK_CHAINS[armChainKey], this.bones, handEffector.position, armChainKey);
                        if (this.skeleton) this.skeleton.update();
                    }

                    this.updateMarkers();
                    this.requestRender();
                }
                return;
            }

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

                        // Arm & Leg: keep effector fixed, re-solve IK so elbow/knee acts as pole target
                        if (this.directDrag.effector) {
                            this.ikController.solveWithPole(chainDef, this.bones, this.directDrag.effector.position, this.directDrag.chainKey);
                            if (this.skeleton) this.skeleton.update();
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
            if (this.hoveredBoneName) {
                this.hoveredBoneName = null;
                this.updateMarkers();
            }
            return;
        }

        let hitBone = null;

        const markerIntersects = this._mannequinVisible !== false
            ? raycaster.intersectObjects(this.jointMarkers, false)
            : [];
        if (markerIntersects.length > 0) {
            markerIntersects.sort((a, b) => a.distance - b.distance);
            const hitMarker = markerIntersects[0].object;
            const boneIdx = this.jointMarkers.indexOf(hitMarker);
            if (boneIdx !== -1 && this.boneList[boneIdx]) {
                hitBone = this.boneList[boneIdx];
            }
        } else {
            const meshIntersects = this._mannequinVisible !== false
                ? raycaster.intersectObject(this.skinnedMesh, true)
                : [];
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
                    // Skip upperarm in mesh fallback hover (matches PASS2 interaction behavior)
                    if (nearest.name !== 'upperarm_l' && nearest.name !== 'upperarm_r') {
                        hitBone = nearest;
                    }
                }
            }
        }

        const newHoveredName = hitBone ? hitBone.name : null;
        if (this.hoveredBoneName !== newHoveredName) {
            this.hoveredBoneName = newHoveredName;
            this.updateMarkers();
            this.requestRender();
        }

        // RTMW joint hover
        if (this._rtmwFigureGroup && this._rtmwFigureGroup.visible) {
            const rtmwHits = raycaster.intersectObject(this._rtmwFigureGroup, true);
            const newHit = rtmwHits.find(h => h.object.userData.isRTMWJoint)?.object ?? null;
            if (newHit !== this._hoveredRTMWJoint) {
                if (this._hoveredRTMWJoint)
                    this._setRTMWJointHighlight(this._hoveredRTMWJoint,
                        this._hoveredRTMWJoint === this._selectedRTMWJoint ? 'select' : 'none');
                this._hoveredRTMWJoint = newHit;
                if (this._hoveredRTMWJoint)
                    this._setRTMWJointHighlight(this._hoveredRTMWJoint,
                        this._hoveredRTMWJoint === this._selectedRTMWJoint ? 'select' : 'hover');
                this.requestRender();
            }
        }
    }

    handlePointerUp(e) {
        if (!this.initialized || !this.skinnedMesh) return;

        if (this.directDrag && this.directDrag.active) {
            this.directDrag.active = false;
            this.directDrag.effector = null;
            this.directDrag.chainKey = null;

            // Restore pre-drag selection state
            if (this.directDrag.rotMode) {
                this.transform.detach();
                this.selectedBone = this.directDrag.savedSelectedBone || null;
                if (this.selectedBone) {
                    this.transform.setMode("rotate");
                    this.transform.attach(this.selectedBone);
                }
                this.hoveredBoneName = null;
                this.updateMarkers();
                this.requestRender();
            }

            this.directDrag.rotMode = false;
            this.directDrag.rotBone = null;
            this.directDrag.savedSelectedBone = null;
            this.transform.enabled = true; // restore gizmo
            this.orbit.enabled = true; // Restore orbit
            this.canvas.style.cursor = '';

            if (this.canvas.hasPointerCapture(e.pointerId)) {
                this.canvas.releasePointerCapture(e.pointerId);
            }

            // The solver temporarily set selectedIKEffector, clear it now that drag is done
            if (this.selectedIKEffector) {
                this.selectedIKEffector = null;
            }

            // Restore cursor
            this.canvas.style.cursor = '';
            // Trigger sync to update node output after IK drag
            this.isInteractionActive = false;

            if (this.options.onInteractionEnd) {
                this.options.onInteractionEnd({ type: 'ik' });
            }
            this.dispatchPoseChange();

            // If just a click (no drag): select the clicked bone
            // If actually dragged: restore pre-drag selection
            if (this.directDrag.hasDragged) {
                this.selectedBone = this.directDrag.savedSelectedBone || null;
                this.transform.detach();
                if (this.selectedBone) {
                    this.transform.setMode("rotate");
                    this.transform.attach(this.selectedBone);
                }
            } else if (this.directDrag.clickedBone) {
                // Pure click - select the clicked bone
                this.selectBone(this.directDrag.clickedBone);
            }
            this.directDrag.hasDragged = false;
            this.directDrag.savedSelectedBone = null;
            this.directDrag.clickedBone = null;

            return;
        }
    }

    selectBone(bone) {
        if (this.selectedBone === bone) return;
        this.selectedBone = bone;

        // Root bone: translate only (no rotation gizmo)
        const isRoot = bone.name === 'Root' || (!bone.userData.parentName || !this.bones[bone.userData.parentName]);
        this.transform.setMode(isRoot ? "translate" : "rotate");
        this.transform.attach(bone);
        this.updateMarkers();

        if (this.selectedIKEffector) {
            this.selectedIKEffector = null;
        }

        if (this.options.onBoneSelect) {
            this.options.onBoneSelect(bone.name);
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
                if (chainDef.affectedLegs && this.ikController.ccdSolver) {
                    // Root Y as floor: clamp foot Y when moving hip
                    const rootBone = this.boneList.find(b => !b.userData.parentName || !this.bones[b.userData.parentName]);
                    const rootY = rootBone ? (() => { const p = new this.THREE.Vector3(); rootBone.getWorldPosition(p); return p.y; })() : 0;

                    for (const legKey of chainDef.affectedLegs) {
                        const footTarget = footPositions[legKey];
                        if (!footTarget) continue;
                        footTarget.y = Math.max(rootY, footTarget.y);
                    }

                    for (let pass = 0; pass < 3; pass++) {
                        for (const legKey of chainDef.affectedLegs) {
                            const legDef = IK_CHAINS[legKey];
                            const footTarget = footPositions[legKey];
                            if (legDef && footTarget && this.ikController.getMode(legKey) === 'ik') {
                                this.ikController.solveWithPole(legDef, this.bones, footTarget, legKey);
                            }
                        }
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
    }

    updateIKEffectorVisibility() {
        if (!this.ikController) return;

        for (const [name, effector] of Object.entries(this.ikController.effectors)) {
            // Only show effector if IK mode is on AND the chain is active
            const chainKey = this.ikController.getChainForEffector(name);
            const chainActive = chainKey && this.ikController.getMode(chainKey) === 'ik';
            effector.visible = this.ikMode && chainActive;
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



/////////////////////////////////////////////////////////////
    updateMarkers() {
        if (!this.markerMatNormal || !this.markerMatSelected) return;

        let highlightedBones = new Set();

        // Selected bone only - no chain expansion
        if (this.selectedBone) {
            highlightedBones.add(this.selectedBone.name);
        }

        // Hover: highlight only the single hovered bone (no chain expansion)
        // Chain expansion only happens on click/select to avoid confusing whole-arm highlights
        let hoveredBones = new Set();
        if (this.hoveredBoneName) {
            hoveredBones.add(this.hoveredBoneName);
        }

        for (let i = 0; i < this.jointMarkers.length; i++) {
            const marker = this.jointMarkers[i];



            //if (this._mannequinVisible === false) {
            //    marker.visible = false;
            //    continue;
            //}




            const bone = this.boneList[i];
            const isSelected = bone && highlightedBones.has(bone.name);
            const isHovered = bone && hoveredBones.has(bone.name);

            // Give precedence to selected over hovered
            marker.material = (isSelected || isHovered) ? this.markerMatSelected : this.markerMatNormal;

            if (isSelected) {
                marker.scale.setScalar(1.5);
                marker.renderOrder = 999;
            } else if (isHovered) {
                marker.scale.setScalar(1.25);
                marker.renderOrder = 500;
            } else {
                marker.scale.setScalar(1.0);
                marker.renderOrder = 1;
            }
        }
    }

//////////////////////////////////////////////////////////////////



    resize(w, h) {
        this.width = w;
        this.height = h;
        if (this.renderer) this.renderer.setSize(w, h, false);
        if (this.camera) {
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
        }
        this.updateRefPlaneSize();
        this.requestRender();
    }

    loadData(data, keepCamera = true) { // Slimy_VNCCS: default keepCamera=true
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

        // Tポーズ時の身長をキャッシュ（drawHMR2v1Figureのスケール計算用）
        // ボーンが確定したこのタイミングでのみ計算し、以後ポーズが変わっても不変
        {
            const headBone = this.bones['head'];
            const footBone = this.bones['foot_l'] || this.bones['foot_r'];
            if (headBone && footBone) {
                const hp = new THREE.Vector3(), fp = new THREE.Vector3();
                headBone.getWorldPosition(hp);
                footBone.getWorldPosition(fp);
                const h = Math.abs(hp.y - fp.y);
                this._tposeHeight = h > 0.1 ? h : 1.7;
            } else {
                this._tposeHeight = 1.7;
            }
            // デフォルトマネキンの身長を最初の1回だけ記録
            if (!this._defaultTposeHeight) {
                this._defaultTposeHeight = this._tposeHeight;
            }
        }

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
        if (!this.markerGeoFinger) this.markerGeoFinger = new THREE.SphereGeometry(0.03, 6, 6);

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

        const FINGER_BONES = new Set([
            'thumb_01_l','thumb_02_l','thumb_03_l',
            'index_01_l','index_02_l','index_03_l',
            'middle_01_l','middle_02_l','middle_03_l',
            'ring_01_l','ring_02_l','ring_03_l',
            'pinky_01_l','pinky_02_l','pinky_03_l',
            'thumb_01_r','thumb_02_r','thumb_03_r',
            'index_01_r','index_02_r','index_03_r',
            'middle_01_r','middle_02_r','middle_03_r',
            'ring_01_r','ring_02_r','ring_03_r',
            'pinky_01_r','pinky_02_r','pinky_03_r',
        ]);
        for (let i = 0; i < this.boneList.length; i++) {
            const bone = this.boneList[i];
            const isFinger = FINGER_BONES.has(bone.name);
            const sphere = new THREE.Mesh(isFinger ? this.markerGeoFinger : this.markerGeoNormal, this.markerMatNormal);
            sphere.userData.boneIndex = i;
            sphere.userData.sharedMaterial = true;
            sphere.renderOrder = 999;
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
                fov: this.camera.fov,
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

        // Camera handling - DISABLED (Slimy_VNCCS: camera is user-controlled)
        // if (!preserveCamera) {
        //     if (pose.camera) {
        //         if (pose.camera.fov) {
        //             this.camera.fov = pose.camera.fov;
        //             this.camera.updateProjectionMatrix();
        //         }
        //         this.camera.position.set(
        //             pose.camera.posX,
        //             pose.camera.posY,
        //             pose.camera.posZ
        //         );
        //         this.orbit.target.set(
        //             pose.camera.targetX,
        //             pose.camera.targetY,
        //             pose.camera.targetZ
        //         );
        //     } else {
        //         // Default view if no camera data (prevents inheriting from previous tab)
        //         this.camera.position.set(0, 0.5, 4);
        //         this.orbit.target.set(0, 1, 0);
        //     }
        //     this.orbit.update();
        // }

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
            this.camera.add(this.refPlane);

            // Position plane in front of camera, size calculated from FOV
            this.refPlane.position.set(0, 0, -50);
            this.refPlane.rotation.set(0, 0, 0);
            this.updateRefPlaneSize();
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
                // Store image aspect for correct scaling
                this._refImageAspect = tex.image.width / tex.image.height;
                this.updateRefPlaneSize();
                this.requestRender();
            }
        });
    }

    updateRefPlaneSize() {
        if (!this.refPlane || !this.camera) return;
        const dist = 50;
        const vFOV = this.camera.fov * Math.PI / 180;
        const viewH = 2 * dist * Math.tan(vFOV / 2);
        const viewW = viewH * this.camera.aspect;

        // Same algorithm as orange frame: height-based, width may exceed view (clipped by camera)
        const imgAspect = this._refImageAspect || 1.0;
        const h = viewH;
        const w = h * imgAspect;
        this.refPlane.scale.set(w, h, 1);
    }

    removeReferenceImage() {
        if (!this.refPlane) return;
        this.camera.remove(this.refPlane);
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

    setRefPlaneOverlay(enabled) {
        if (!this.refPlane) return;
        this.refPlane.renderOrder = enabled ? 999 : -1;
        this.refPlane.material.depthTest = !enabled;
        this.requestRender();
    }

    setRefPlaneOpacity(opacity) {
        if (!this.refPlane) return;
        this.refPlane.material.opacity = opacity;
        this.refPlane.material.needsUpdate = true;
        this.requestRender();
    }

    updateCaptureCamera(width, height, zoom = 1.0, offsetX = 0, offsetY = 0) {
        if (!this.THREE) return;
        // Store output aspect for capture and 2D frame overlay
        this.outputAspect = width / height;
        this.updateCaptureFrameOverlay();
        this.requestRender();
    }

    updateCaptureFrameOverlay() {
        const aspect = this.outputAspect || (this.width / this.height);

        // Use canvas's own rect as the reference - overlay sits directly on top of canvas
        const rect = this.canvas.getBoundingClientRect();
        const vw = rect.width;
        const vh = rect.height;

        if (!this.captureFrameOverlay) {
            // Create a container div that sits exactly on top of the canvas
            this.captureFrameContainer = document.createElement('div');
            this.captureFrameContainer.style.cssText = `
                position: fixed; pointer-events: none; overflow: hidden;
                box-sizing: border-box;
            `;
            // The orange frame inside the container
            this.captureFrameOverlay = document.createElement('div');
            this.captureFrameOverlay.style.cssText = `
                position: absolute; pointer-events: none; box-sizing: border-box;
                border: 2px solid #ffa500;
            `;
            this.captureFrameContainer.appendChild(this.captureFrameOverlay);
            document.body.appendChild(this.captureFrameContainer);
        }

        // Position container exactly over canvas using fixed positioning
        this.captureFrameContainer.style.left = rect.left + 'px';
        this.captureFrameContainer.style.top = rect.top + 'px';
        this.captureFrameContainer.style.width = vw + 'px';
        this.captureFrameContainer.style.height = vh + 'px';

        // Hide if aspect matches viewport
        if (Math.abs(aspect - vw / vh) < 0.01) {
            this.captureFrameContainer.style.display = 'none';
            return;
        }
        this.captureFrameContainer.style.display = 'block';

        // Liquid layout based on output aspect vs viewport aspect
        // Output wider than viewport → width-based (left/right edges flush, top/bottom clip)
        // Output taller than viewport → height-based (top/bottom edges flush, left/right clip)
        // Three.js PerspectiveCamera uses fixed vertical FOV
        // so height is always the reference axis - frame height = viewport height
        const fh = vh;
        const fw = fh * aspect;
        const left = (vw - fw) / 2;
        const top = 0;

        this.captureFrameOverlay.style.width = fw + 'px';
        this.captureFrameOverlay.style.height = fh + 'px';
        this.captureFrameOverlay.style.left = left + 'px';
        this.captureFrameOverlay.style.top = top + 'px';
    }

    snapToCaptureCamera(width, height, zoom = 1.0, offsetX = 0, offsetY = 0) {
        // Just update the output aspect overlay - viewport camera is used directly
        this.updateCaptureCamera(width, height, zoom, offsetX, offsetY);
    }

    // fov_deg: vertical field of view in degrees (15-70)
    // Lower = narrower = less distortion, Higher = wider = more distortion
    setFocalLength(fov_deg) {
        this.camera.fov = fov_deg;
        this.camera.updateProjectionMatrix();
        this.updateRefPlaneSize();
        // Redraw RTMW figure: re-estimates camera distance for the new FOV
        if (this._rtmwLastKpts) {
            this.drawRTMW3DFigure(this._rtmwLastKpts, this._rtmwLastImageW, this._rtmwLastImageH);
        }
        this.requestRender();
        this.dispatchPoseChange();
    }

    getFocalLength() {
        return this.camera.fov;
    }

    // Mirror pose: copy one side to the other with X-axis reflection
    // Spine bones are straightened (X and Z rotation zeroed)
    // Apply pose from COCO-18 keypoints (from DWPose/OpenPose)
    applyPoseKeypoints(kp2d, canvasWidth, canvasHeight, scaleMultiplier = 1.0, zVariant = null, kp3d = null) {
        // zVariant: optional {elbowZ, kneeZ, wristZ} overrides for depth ambiguity variants
        // kp3d: optional flat array [x0,y0,z0,conf0, x1,y1,z1,conf1, ...] in VNCCS world coords
        if (!kp2d || kp2d.length < 36) return;
        this.recordState();

        const THREE = this.THREE;

        // Parse flat array [x0,y0,conf0, x1,y1,conf1, ...]
        const kps = [];
        if (Array.isArray(kp2d[0])) {
            for (const k of kp2d) kps.push({ x: k[0], y: k[1], c: k[2] });
        } else {
            for (let i = 0; i < kp2d.length; i += 3) {
                kps.push({ x: kp2d[i], y: kp2d[i+1], c: kp2d[i+2] });
            }
        }

        // Parse 3D coords if provided [x0,y0,z0,conf0, ...]
        const kps3d = [];
        if (kp3d && kp3d.length >= 4) {
            for (let i = 0; i < kp3d.length; i += 4) {
                kps3d.push({ x: kp3d[i], y: kp3d[i+1], z: kp3d[i+2], c: kp3d[i+3] });
            }
        }

        const KP = {
            nose:0, neck:1,
            rShoulder:2, rElbow:3, rWrist:4,
            lShoulder:5, lElbow:6, lWrist:7,
            rHip:8, rKnee:9, rAnkle:10,
            lHip:11, lKnee:12, lAnkle:13,
            rEye:14, lEye:15, rEar:16, lEar:17
        };

        const get = (idx) => kps[idx] && kps[idx].c > 0.1 ? kps[idx] : null;

        // Step 1: Reset to T-pose
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
        this.skinnedMesh.updateMatrixWorld(true);

        // Tポーズ時のボーン長テーブルを計算
        const getBoneLength = (boneNameA, boneNameB) => {
            const bA = this.bones[boneNameA];
            const bB = this.bones[boneNameB];
            if (!bA || !bB) return null;
            const pA = new THREE.Vector3(); bA.getWorldPosition(pA);
            const pB = new THREE.Vector3(); bB.getWorldPosition(pB);
            return pA.distanceTo(pB);
        };
        const BONE_LENGTHS = {
            upperarm_r: getBoneLength('upperarm_r', 'lowerarm_r'),
            upperarm_l: getBoneLength('upperarm_l', 'lowerarm_l'),
            lowerarm_r: getBoneLength('lowerarm_r', 'hand_r'),
            lowerarm_l: getBoneLength('lowerarm_l', 'hand_l'),
            thigh_r:    getBoneLength('thigh_r', 'calf_r'),
            thigh_l:    getBoneLength('thigh_l', 'calf_l'),
            calf_r:     getBoneLength('calf_r', 'foot_r'),
            calf_l:     getBoneLength('calf_l', 'foot_l'),
        };
        console.log('[VNCCS] BONE_LENGTHS:', JSON.stringify(Object.fromEntries(Object.entries(BONE_LENGTHS).map(([k,v]) => [k, v?.toFixed(3)]))));

        // 三平方の定理でZ座標を計算
        // XY距離とボーン長からZ距離を求め、Depthの符号（+1/-1）で方向を決める
        if (kps3d.length > 0) {
            const inferZ = (parentIdx, childIdx, boneLength) => {
                if (!boneLength) return;
                const parent = kps3d[parentIdx];
                const child  = kps3d[childIdx];
                if (!parent || !child || parent.c < 0.1 || child.c < 0.1) return;

                // キャンバス端近く（90%以上）の関節はZ計算をスキップして親のZを引き継ぐ
                // DWPoseが画像外を推測で出してくる場合の対策
                const kp2dChild = kps[childIdx];
                if (kp2dChild) {
                    const xRatio = kp2dChild.x / canvasWidth;
                    const yRatio = kp2dChild.y / canvasHeight;
                    if (xRatio < 0.05 || xRatio > 0.95 || yRatio < 0.05 || yRatio > 0.95) {
                        child.z = parent.z;
                        return;
                    }
                }

                const dx = child.x - parent.x;
                const dy = child.y - parent.y;
                const xyDist2 = dx*dx + dy*dy;
                const zDist2 = boneLength*boneLength - xyDist2;

                if (zDist2 <= 0) {
                    // XY距離がボーン長より長い場合はZ=親と同じ
                    child.z = parent.z;
                    return;
                }

                // XY距離がボーン長の85%以上の場合はZ成分が小さいので信頼性が低い
                // その場合はZ距離を実際より小さく抑える
                const xyRatio = Math.sqrt(xyDist2) / boneLength;
                const zDist = xyRatio > 0.85
                    ? Math.sqrt(zDist2) * (1.0 - xyRatio) * 2.0  // 抑制
                    : Math.sqrt(zDist2);

                // Depth正規化値の大小で前後判定（child.z > parent.z なら手前）
                const sign = child.z >= parent.z ? 1 : -1;
                child.z = parent.z + sign * zDist;
            };
            // 腕
            inferZ(KP.rShoulder, KP.rElbow,  BONE_LENGTHS.upperarm_r);
            inferZ(KP.rElbow,    KP.rWrist,   BONE_LENGTHS.lowerarm_r);
            inferZ(KP.lShoulder, KP.lElbow,   BONE_LENGTHS.upperarm_l);
            inferZ(KP.lElbow,    KP.lWrist,   BONE_LENGTHS.lowerarm_l);
            // 脚
            inferZ(KP.rHip,  KP.rKnee,  BONE_LENGTHS.thigh_r);
            inferZ(KP.rKnee, KP.rAnkle, BONE_LENGTHS.calf_r);
            inferZ(KP.lHip,  KP.lKnee,  BONE_LENGTHS.thigh_l);
            inferZ(KP.lKnee, KP.lAnkle, BONE_LENGTHS.calf_l);
        }

        // =====================================================================
        // Step 2: カメラ逆投影によるワールド座標計算
        // 棒人形サイズは固定（マネキンと同スケール）。
        // カメラのFOVと既知ボーン長からカメラ距離を逆算し、
        // 各キーポイントをそのカメラ距離の平面に投影する。
        // =====================================================================

        const fovY   = this.camera.fov * Math.PI / 180;
        const aspect = this.camera.aspect;

        // ピクセル → カメラ空間方向ベクトル
        const tanHalfFovY = Math.tan(fovY / 2);
        const pixelToRay  = (px, py) => {
            const ndcX =  (px / canvasWidth)  * 2 - 1;
            const ndcY = -(py / canvasHeight) * 2 + 1; // Y反転
            return new THREE.Vector3(
                ndcX * tanHalfFovY * aspect,
                ndcY * tanHalfFovY,
                -1
            ).normalize().transformDirection(this.camera.matrixWorld);
        };

        // 2点の視線ベクトルのなす角θ → カメラ距離逆算
        // chord ≈ 2 * D * sin(θ/2)  →  D = worldLen / (2 * sin(θ/2))
        const estimateCamDist = (pxA, pyA, pxB, pyB, worldLen) => {
            const rA  = pixelToRay(pxA, pyA);
            const rB  = pixelToRay(pxB, pyB);
            const dot = Math.max(-1, Math.min(1, rA.dot(rB)));
            const halfAngle = Math.acos(dot) / 2;
            if (halfAngle < 1e-6) return null;
            const d = worldLen / (2 * Math.sin(halfAngle));
            return (d > 0.1 && d < 300) ? d : null;
        };

        // 優先度付きで距離推定
        const neckKp  = get(KP.neck);
        const rSh     = get(KP.rShoulder), lSh = get(KP.lShoulder);
        const rHip    = get(KP.rHip),     lHip = get(KP.lHip);
        const rElbow  = get(KP.rElbow),   lElbow = get(KP.lElbow);

        const distEstimates = [];
        const tryDist = (kpA, kpB, boneA, boneB, weight) => {
            if (!kpA || !kpB) return;
            const len = getBoneLength(boneA, boneB);
            if (!len) return;
            const d = estimateCamDist(kpA.x, kpA.y, kpB.x, kpB.y, len);
            if (d) distEstimates.push({ d, weight });
        };

        tryDist(rSh,    lSh,    'upperarm_r', 'upperarm_l', 3); // 肩幅（最信頼）
        tryDist(rHip,   lHip,   'thigh_r',    'thigh_l',    2); // 腰幅
        tryDist(neckKp, rSh,    'neck_01',    'upperarm_r', 2); // 首→右肩
        tryDist(neckKp, lSh,    'neck_01',    'upperarm_l', 2); // 首→左肩
        tryDist(rSh,    rElbow, 'upperarm_r', 'lowerarm_r', 1); // 右上腕
        tryDist(lSh,    lElbow, 'upperarm_l', 'lowerarm_l', 1); // 左上腕
        const rKnee = get(KP.rKnee);
        tryDist(rHip,   rKnee,  'thigh_r',    'calf_r',     1); // 右大腿

        let camDistance = 8.0; // デフォルト（全身標準距離）
        if (distEstimates.length > 0) {
            const totalW = distEstimates.reduce((s, e) => s + e.weight, 0);
            camDistance  = distEstimates.reduce((s, e) => s + e.d * e.weight, 0) / totalW;
        }
        console.log('[VNCCS] camDist:', camDistance.toFixed(3),
            ' from', distEstimates.length, 'estimates:',
            distEstimates.map(e => e.d.toFixed(2)).join(', '));

        // カメラ原点
        const camPos = new THREE.Vector3().setFromMatrixPosition(this.camera.matrixWorld);

        // ピクセル → ワールド座標（カメラからcamDistance離れた平面上）
        const kpToWorld = (kp, zOffset = 0) => {
            const pt = camPos.clone().addScaledVector(pixelToRay(kp.x, kp.y), camDistance);
            pt.z += zOffset;
            return pt;
        };

        // 体の前後幅スケール（肩幅の約0.4倍が解剖学的比率）
        const shPixelLen = (rSh && lSh)
            ? Math.sqrt((rSh.x-lSh.x)**2 + (rSh.y-lSh.y)**2) : 0;
        const shWorldLen = (rSh && lSh)
            ? (getBoneLength('upperarm_r','upperarm_l') || 2.5) : 2.5;
        const kps3dZScale = shWorldLen * 0.4;

        // ダミー（デバッグログ表示用）
        const scale   = 1 / camDistance;
        const offsetX = 0;
        const offsetY = 0;

        const getWorld3D = (idx, fallbackKp, fallbackZ = 0) => {
            if (kps3d.length > idx && kps3d[idx] && kps3d[idx].c > 0.1) {
                const k   = kps3d[idx];
                const pt  = camPos.clone().addScaledVector(pixelToRay(k.x, k.y), camDistance);
                pt.z += (k.z - 0.5) * kps3dZScale;
                return pt;
            }
            if (!fallbackKp) return null;
            return kpToWorld(fallbackKp, fallbackZ);
        };

        const HEAD_Z_OFFSET = 0.5; // noseは首より前方にある

        // Step 2.5: FK事前計算 - ボーン間ベクトルから直接回転を求める
        // kps3dが利用可能な場合、各ボーンセグメントのワールド方向ベクトルを計算し
        // Tポーズの方向からの回転として適用する
        if (kps3d.length > 0) {
            const applyBoneDirectionFK = (boneName, parentIdx, childIdx) => {
                const parentRaw = kps3d[parentIdx];
                const childRaw  = kps3d[childIdx];
                if (!parentRaw || !childRaw || parentRaw.c < 0.1 || childRaw.c < 0.1) return;
                const bone = this.bones[boneName];
                if (!bone) return;

                // getWorld3D でピクセル→ワールド変換済み座標を取得
                const parentW = getWorld3D(parentIdx, kps[parentIdx], 0);
                const childW  = getWorld3D(childIdx,  kps[childIdx],  0);
                if (!parentW || !childW) return;

                // 目標方向ベクトル（ワールド空間）
                const targetDir = new THREE.Vector3(
                    childW.x - parentW.x,
                    childW.y - parentW.y,
                    childW.z - parentW.z
                ).normalize();

                // Tポーズ時のボーン方向（ワールド空間）
                const tposeDir = new THREE.Vector3();
                bone.getWorldDirection(tposeDir);

                // 2ベクトル間の回転クォータニオン
                const q = new THREE.Quaternion().setFromUnitVectors(tposeDir, targetDir);

                // ワールド回転をローカル回転に変換
                const parentWorldQ = new THREE.Quaternion();
                if (bone.parent) {
                    bone.parent.getWorldQuaternion(parentWorldQ);
                }
                const parentWorldQInv = parentWorldQ.clone().invert();
                const localQ = parentWorldQInv.multiply(q).multiply(parentWorldQ).multiply(bone.quaternion);
                bone.quaternion.copy(localQ);
                this.skinnedMesh.updateMatrixWorld(true);
            };

            // 腕のFK適用
            applyBoneDirectionFK('upperarm_r', KP.rShoulder, KP.rElbow);
            applyBoneDirectionFK('lowerarm_r', KP.rElbow,    KP.rWrist);
            applyBoneDirectionFK('upperarm_l', KP.lShoulder, KP.lElbow);
            applyBoneDirectionFK('lowerarm_l', KP.lElbow,    KP.lWrist);
            // 脚のFK適用
            applyBoneDirectionFK('thigh_r', KP.rHip,  KP.rKnee);
            applyBoneDirectionFK('calf_r',  KP.rKnee, KP.rAnkle);
            applyBoneDirectionFK('thigh_l', KP.lHip,  KP.lKnee);
            applyBoneDirectionFK('calf_l',  KP.lKnee, KP.lAnkle);
        }

        // Step 3: Set IK effector positions directly from world coords
        if (!this.ikController) {
            console.warn('[VNCCS] IK controller not available');
            return;
        }

        const setEffector = (effectorName, kp, zOffset = 0) => {
            if (!kp) return;
            const effector = this.ikController.effectors[effectorName];
            if (!effector) return;
            const wp = kpToWorld(kp, zOffset);
            effector.position.copy(wp);
        };

        const setEffector3D = (effectorName, idx, fallbackKp, fallbackZ = 0) => {
            const effector = this.ikController.effectors[effectorName];
            if (!effector) return;
            const wp = getWorld3D(idx, fallbackKp, fallbackZ);
            if (wp) effector.position.copy(wp);
        };

        // Set effector positions
        const rWrist  = get(KP.rWrist);
        const lWrist  = get(KP.lWrist);
        const rAnkle  = get(KP.rAnkle);
        const lAnkle  = get(KP.lAnkle);
        const nose    = get(KP.nose);
        const neck    = get(KP.neck);

        // Estimate face direction from ear/eye asymmetry
        // rEar/lEar width ratio tells us yaw, nose position tells us pitch
        const rEar = get(KP.rEar);
        const lEar = get(KP.lEar);
        const rEye = get(KP.rEye);
        const lEye = get(KP.lEye);

        let noseZOffset = HEAD_Z_OFFSET; // default: facing forward
        let noseXOffset = 0;

        if (rEar && lEar && nose && neck) {
            // Ear midpoint X vs nose X → yaw estimation
            const earMidX = (rEar.x + lEar.x) / 2;
            const earWidth = Math.abs(lEar.x - rEar.x);
            const noseOffsetFromEarMid = nose.x - earMidX;
            const yawRatio = earWidth > 1 ? Math.max(-1, Math.min(1, noseOffsetFromEarMid / (earWidth * 0.5))) : 0;
            // Z only: X補正はspineIKのtargetをずらすのでなし
            noseZOffset = HEAD_Z_OFFSET * Math.cos(yawRatio * Math.PI / 2);
            noseXOffset = 0;
        }

        if (nose) {
            const effector = this.ikController.effectors['head'];
            if (effector) {
                const wp = kps3d.length > 0
                    ? getWorld3D(0, nose, noseZOffset)
                    : kpToWorld(nose);
                if (!kps3d.length) { wp.z += noseZOffset; wp.x += noseXOffset; }
                effector.position.copy(wp);
            }
        } else {
            setEffector('hand_r',  rWrist);
        }

        // Z offset variants for depth ambiguity (2Dフォールバック時のみ使用)
        const KNEE_Z_OFFSET  = zVariant ? zVariant.kneeZ  :  0.8;
        const ELBOW_Z_OFFSET = zVariant ? zVariant.elbowZ : -0.5;
        const WRIST_Z_OFFSET = zVariant ? zVariant.wristZ :  0.0;

        // 3D座標があれば直接使用、なければ2D+Zオフセット
        // 手首・足首が見切れている場合は上位関節の延長線上に推定
        const estimateAnkle = (hipIdx, kneeIdx, calfBoneName) => {
            const hipRaw  = kps3d.length > hipIdx  ? kps3d[hipIdx]  : null;
            const kneeRaw = kps3d.length > kneeIdx ? kps3d[kneeIdx] : null;
            if (!hipRaw || !kneeRaw || hipRaw.c < 0.1 || kneeRaw.c < 0.1) return null;

            const hipW  = getWorld3D(hipIdx,  kps[hipIdx],  0);
            const kneeW = getWorld3D(kneeIdx, kps[kneeIdx], 0);
            if (!hipW || !kneeW) return null;

            // スケルトンの実際のcalfボーン長を取得
            const calfBone = this.bones[calfBoneName];
            const footBoneName = calfBoneName.replace('calf', 'foot');
            const footBone = this.bones[footBoneName];
            let calfLength = 3.5; // デフォルト値
            if (calfBone && footBone) {
                const calfPos = new THREE.Vector3();
                const footPos = new THREE.Vector3();
                calfBone.getWorldPosition(calfPos);
                footBone.getWorldPosition(footPos);
                calfLength = calfPos.distanceTo(footPos);
            }

            // 大腿方向ベクトルを正規化して、calfの長さ分だけ膝から延長
            const dx = kneeW.x - hipW.x;
            const dy = kneeW.y - hipW.y;
            const dz = kneeW.z - hipW.z;
            const len = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
            return new THREE.Vector3(
                kneeW.x + (dx / len) * calfLength,
                kneeW.y + (dy / len) * calfLength,
                kneeW.z + (dz / len) * calfLength
            );
        };

        const estimateWrist = (shoulderIdx, elbowIdx) => {
            const shoulderRaw = kps3d.length > shoulderIdx ? kps3d[shoulderIdx] : null;
            const elbowRaw    = kps3d.length > elbowIdx    ? kps3d[elbowIdx]    : null;
            if (!shoulderRaw || !elbowRaw || shoulderRaw.c < 0.1 || elbowRaw.c < 0.1) return null;

            const shoulderW = getWorld3D(shoulderIdx, kps[shoulderIdx], 0);
            const elbowW    = getWorld3D(elbowIdx,    kps[elbowIdx],    0);
            if (!shoulderW || !elbowW) return null;

            return new THREE.Vector3(
                elbowW.x + (elbowW.x - shoulderW.x),
                elbowW.y + (elbowW.y - shoulderW.y),
                elbowW.z + (elbowW.z - shoulderW.z)
            );
        };

        // 手首: 検出済みなら使用、見切れていたら肩→肘の延長で推定
        const rWristCheck = get(KP.rWrist);
        const lWristCheck = get(KP.lWrist);

        if (rWristCheck) {
            setEffector3D('hand_r', 4, rWristCheck, WRIST_Z_OFFSET);
        } else {
            const est = estimateWrist(2, 3); // r_shoulder=2, r_elbow=3
            if (est) {
                const effector = this.ikController.effectors['hand_r'];
                if (effector) effector.position.copy(est);
            }
        }

        if (lWristCheck) {
            setEffector3D('hand_l', 7, lWristCheck, -WRIST_Z_OFFSET);
        } else {
            const est = estimateWrist(5, 6); // l_shoulder=5, l_elbow=6
            if (est) {
                const effector = this.ikController.effectors['hand_l'];
                if (effector) effector.position.copy(est);
            }
        }

        // 足首: 検出済みなら使用、見切れていたら股関節→膝の延長で推定
        const rAnkleKpCheck = get(KP.rAnkle);
        const lAnkleKpCheck = get(KP.lAnkle);

        if (rAnkleKpCheck) {
            setEffector3D('foot_r', 10, rAnkleKpCheck, 0);
        } else {
            const est = estimateAnkle(8, 9, 'calf_r');
            if (est) {
                const effector = this.ikController.effectors['foot_r'];
                if (effector) effector.position.copy(est);
            }
        }

        if (lAnkleKpCheck) {
            setEffector3D('foot_l', 13, lAnkleKpCheck, 0);
        } else {
            const est = estimateAnkle(11, 12, 'calf_l');
            if (est) {
                const effector = this.ikController.effectors['foot_l'];
                if (effector) effector.position.copy(est);
            }
        }

        // Set pole targets from elbow/knee keypoints
        const setPole = (chainKey, kp, zOffset = 0, kp3dIdx = -1) => {
            if (!kp) return;
            const pole = this.ikController.poleTargets[chainKey];
            if (!pole) return;
            this.ikController.modes[chainKey] = 'ik';
            this.ikController.poleModes[chainKey] = 'on';
            const wp = kp3dIdx >= 0
                ? getWorld3D(kp3dIdx, kp, zOffset)
                : kpToWorld(kp);
            if (!kps3d.length || kp3dIdx < 0) wp.z += zOffset;
            pole.position.copy(wp);
        };

        setPole('rightArm', get(KP.rElbow), ELBOW_Z_OFFSET, 3);
        setPole('leftArm',  get(KP.lElbow), ELBOW_Z_OFFSET, 6);
        setPole('rightLeg', get(KP.rKnee),  KNEE_Z_OFFSET,  9);
        setPole('leftLeg',  get(KP.lKnee),  KNEE_Z_OFFSET,  12);

        // Step 4: Solve IK for each chain
        // depthのZ値（手前=大）でチェーンをソートして手前から解く
        // エフェクターの現在のZ位置で順番を決める
        const COCO18_NAMES = ['nose','neck','r_shoulder','r_elbow','r_wrist','l_shoulder','l_elbow','l_wrist','r_hip','r_knee','r_ankle','l_hip','l_knee','l_ankle','r_eye','l_eye','r_ear','l_ear'];
        const debugLines = [`Scale: ${scale.toFixed(5)}  offset=(${offsetX.toFixed(3)}, ${offsetY.toFixed(3)})`];
        debugLines.push('');
        debugLines.push('=== KeyPoint → World ===');
        for (let i = 0; i < 18; i++) {
            const kp = kps[i];
            if (!kp || kp.c < 0.1) continue;
            const wp = getWorld3D(i, kp, 0);
            debugLines.push(`${COCO18_NAMES[i]}: px=(${kp.x.toFixed(0)},${kp.y.toFixed(0)}) → world=(${wp.x.toFixed(3)},${wp.y.toFixed(3)},${wp.z.toFixed(3)})${kps3d.length > i ? ' [3D]' : ''}`);        }
        debugLines.push('');
        debugLines.push('=== IK Effector Targets ===');

        const allChainKeys = ['spine', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'];

        // エフェクターのZ値（手前=大）でソート
        const sortedChainKeys = [...allChainKeys].sort((a, b) => {
            const defA = IK_CHAINS[a];
            const defB = IK_CHAINS[b];
            const effA = defA ? this.ikController.effectors[defA.effector] : null;
            const effB = defB ? this.ikController.effectors[defB.effector] : null;
            const zA = effA ? effA.position.z : 0;
            const zB = effB ? effB.position.z : 0;
            return zB - zA; // 手前（Z大）から順
        });

        // 4周: 全チェーンを解く
        const SOLVE_ITERATIONS = 4;
        for (let iter = 0; iter < SOLVE_ITERATIONS; iter++) {
            for (const chainKey of sortedChainKeys) {
                const chainDef = IK_CHAINS[chainKey];
                if (!chainDef) continue;
                const effector = this.ikController.effectors[chainDef.effector];
                if (!effector) continue;
                const target = effector.position.clone();

                if (iter === 0) {
                    debugLines.push(`${chainKey}: target=(${target.x.toFixed(3)}, ${target.y.toFixed(3)}, ${target.z.toFixed(3)})`);
                    if (chainDef.bones && chainDef.bones.length > 0) {
                        const rootBone = this.bones[chainDef.bones[0]];
                        if (rootBone) {
                            const rp = new this.THREE.Vector3();
                            rootBone.getWorldPosition(rp);
                            debugLines.push(`  rootBone(${chainDef.bones[0]}) world=(${rp.x.toFixed(3)}, ${rp.y.toFixed(3)}, ${rp.z.toFixed(3)})`);
                        }
                    }
                }

                const solved = this.ikController.solveWithPole(chainDef, this.bones, target, chainKey);
                this.skinnedMesh.updateMatrixWorld(true);

                if (iter === 0) {
                    const effectorBone = this.bones[chainDef.effector];
                    if (effectorBone) {
                        const wp = new this.THREE.Vector3();
                        effectorBone.getWorldPosition(wp);
                        debugLines.push(`  solved=${solved} result=(${wp.x.toFixed(3)}, ${wp.y.toFixed(3)}, ${wp.z.toFixed(3)})`);
                    }
                }
            }
        }

        // 最終周: 肘・膝のポールターゲットだけ再適用（手首・足首は動かさない）
        // 前の周回で決まった姿勢を維持しつつ肘・膝の方向だけ合わせる
        for (const chainKey of ['rightArm', 'leftArm', 'rightLeg', 'leftLeg']) {
            const chainDef = IK_CHAINS[chainKey];
            if (!chainDef) continue;
            const pole = this.ikController.poleTargets[chainKey];
            if (!pole) continue;
            // エフェクターは現在のボーン位置を使う（引っ張らない）
            const effectorBone = this.bones[chainDef.effector];
            if (!effectorBone) continue;
            const currentPos = new this.THREE.Vector3();
            effectorBone.getWorldPosition(currentPos);
            this.ikController.solveWithPole(chainDef, this.bones, currentPos, chainKey);
            this.skinnedMesh.updateMatrixWorld(true);
        }
        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
        this.updateMarkers();
        this.requestRender();
        this.dispatchPoseChange();

        // 18点のワールド座標を収集してdrawKeypointFigureで使えるように返す
        const worldKpsForFigure = [];
        for (let i = 0; i < 18; i++) {
            const kp = kps[i];
            if (!kp || kp.c < 0.1) { worldKpsForFigure.push(null); continue; }
            const wp = getWorld3D(i, kp, 0);
            worldKpsForFigure.push({ x: wp.x, y: wp.y, z: wp.z, c: kp.c });
        }

        return { scale, offsetX, offsetY, debugLines, worldKps: worldKpsForFigure };
    }


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
            // Move bone to specified world position
    drawKeypointFigure(kp2d, kp3d, canvasWidth, canvasHeight, scaleIn = null, offsetXIn = null, offsetYIn = null) {
        const THREE = this.THREE;

        // COCO-18 インデックス
        const KP = {
            nose:0, neck:1,
            rShoulder:2, rElbow:3, rWrist:4,
            lShoulder:5, lElbow:6, lWrist:7,
            rHip:8, rKnee:9, rAnkle:10,
            lHip:11, lKnee:12, lAnkle:13,
            rEye:14, lEye:15, rEar:16, lEar:17
        };

        // Tポーズリセットは行わない: applyPoseKeypointsで既にポーズが適用済み

        // JSON読み込み時のカメラ状態を記録
        this._kpCameraSnapshot = {
            position: this.camera.position.clone(),
            quaternion: this.camera.quaternion.clone(),
            fov: this.camera.fov,
            aspect: this.camera.aspect,
        };

        // kp3d をパース (x,y=ピクセル座標, z=depth 0〜1, c=confidence)
        const kps3d = [];
        for (let i = 0; i < kp3d.length; i += 4) {
            kps3d.push({ x: kp3d[i], y: kp3d[i+1], z: kp3d[i+2], c: kp3d[i+3] });
        }

        // === Step1: 現在のスケルトンからTポーズ参照座標を取得 ===
        // COCO18名 → VNCCSボーン名の対応
        const COCO18_TO_BONE = {
            neck:       'neck_01',
            r_shoulder: 'upperarm_r',
            r_elbow:    'lowerarm_r',
            r_wrist:    'hand_r',
            l_shoulder: 'upperarm_l',
            l_elbow:    'lowerarm_l',
            l_wrist:    'hand_l',
            r_hip:      'thigh_r',
            r_knee:     'calf_r',
            r_ankle:    'foot_r',
            l_hip:      'thigh_l',
            l_knee:     'calf_l',
            l_ankle:    'foot_l',
            r_eye:      'head',
            l_eye:      'head',
        };
        const COCO18_NAMES = ['nose','neck','r_shoulder','r_elbow','r_wrist',
                               'l_shoulder','l_elbow','l_wrist','r_hip','r_knee',
                               'r_ankle','l_hip','l_knee','l_ankle',
                               'r_eye','l_eye','r_ear','l_ear'];

        // スケルトンからワールド座標を取得
        const getTposeWorld = (boneName) => {
            const bone = this.bones[boneName];
            if (!bone) return null;
            const p = new THREE.Vector3();
            bone.getWorldPosition(p);
            return p;
        };

        // COCO18インデックスごとのTポーズワールド座標
        const tposeWorld = [];
        for (let i = 0; i < 18; i++) {
            const name = COCO18_NAMES[i];
            const boneName = COCO18_TO_BONE[name];
            tposeWorld.push(boneName ? getTposeWorld(boneName) : null);
        }

        // === Step1.5: 頭部5点のTポーズ参照ブロック（neck→head距離で正規化した固定オフセット）===
        // Tポーズ実測値から計算（headボーンからの相対オフセット / neck→head距離）
        // 耳の中点を原点とした5点の相対オフセット（neck→head距離で正規化）
        // HEAD_REF_VECSとして後で定義（Step5.5内）
        // headCenter（headボーン位置）の耳中点からのオフセット
        const HEAD_CENTER_FROM_EAR = { x: 0.000, y: -0.013, z: 0.130 };

        // === Step3: ボーン両端を明示的に定義して長さを取得 ===
        const BONE_PAIR_DEFS = [
            ['upperarm_r', 'lowerarm_r', 'upperarm_r'],
            ['lowerarm_r', 'hand_r',     'lowerarm_r'],
            ['upperarm_l', 'lowerarm_l', 'upperarm_l'],
            ['lowerarm_l', 'hand_l',     'lowerarm_l'],
            ['thigh_r',    'calf_r',     'thigh_r'],
            ['calf_r',     'foot_r',     'calf_r'],
            ['thigh_l',    'calf_l',     'thigh_l'],
            ['calf_l',     'foot_l',     'calf_l'],
        ];

        const getBoneLen = (nameA, nameB) => {
            const bA = this.bones[nameA];
            const bB = this.bones[nameB];
            if (!bA || !bB) return null;
            const pA = new THREE.Vector3();
            const pB = new THREE.Vector3();
            bA.getWorldPosition(pA);
            bB.getWorldPosition(pB);
            return pA.distanceTo(pB);
        };

        const BONE_LENGTHS = {};
        const allBoneLengthDebug = ['=== ボーン長一覧 (根本 → 先端) ==='];
        for (const [nameA, nameB, label] of BONE_PAIR_DEFS) {
            const len = getBoneLen(nameA, nameB);
            BONE_LENGTHS[label] = len;
            allBoneLengthDebug.push(`${nameA.padEnd(16)} → ${nameB.padEnd(16)}: ${len?.toFixed(4) ?? 'null'}`);
        }

        // 頭部ボーンの情報をデバッグ出力
        const headBone  = this.bones['head'];
        const neckBone  = this.bones['neck_01'];
        const headPos   = new THREE.Vector3();
        const neckPos   = new THREE.Vector3();
        if (headBone) headBone.getWorldPosition(headPos);
        if (neckBone) neckBone.getWorldPosition(neckPos);
        const headScale = headBone ? headBone.scale.x : 1.0;
        const neckToHead = headBone && neckBone ? neckPos.distanceTo(headPos) : null;
        allBoneLengthDebug.push('');
        allBoneLengthDebug.push('=== 頭部情報 ===');
        allBoneLengthDebug.push(`head world pos : (${headPos.x.toFixed(3)}, ${headPos.y.toFixed(3)}, ${headPos.z.toFixed(3)})`);
        allBoneLengthDebug.push(`neck world pos : (${neckPos.x.toFixed(3)}, ${neckPos.y.toFixed(3)}, ${neckPos.z.toFixed(3)})`);
        allBoneLengthDebug.push(`neck → head    : ${neckToHead?.toFixed(4) ?? 'null'}`);
        allBoneLengthDebug.push(`head scale     : ${headScale.toFixed(4)}`);

        // === Step4: ピクセル座標 → ワールド座標変換 ===
        // applyPoseKeypointsと同じカメラunproject方式を使う
        // scaleIn/offsetXIn/offsetYIn はデバッグログ用の値として受け取るが、
        // 実際の変換はcamDistanceを使ったunprojectで行う。
        // camDistanceがnullの場合はデフォルト距離8.0を使う。
        const _camDistFig = scaleIn != null ? (1.0 / scaleIn) : 8.0;
        const _fovYFig    = this.camera.fov * Math.PI / 180;
        const _aspectFig  = this.camera.aspect;
        const _tanHalfFig = Math.tan(_fovYFig / 2);
        const _camPosFig  = new THREE.Vector3().setFromMatrixPosition(this.camera.matrixWorld);
        const _pixelToRayFig = (px, py) => {
            const ndcX =  (px / canvasWidth)  * 2 - 1;
            const ndcY = -(py / canvasHeight) * 2 + 1;
            return new THREE.Vector3(
                ndcX * _tanHalfFig * _aspectFig,
                ndcY * _tanHalfFig,
                -1
            ).normalize().transformDirection(this.camera.matrixWorld);
        };
        // 肩幅からZスケールを推定
        const _rShFig = kps3d[2], _lShFig = kps3d[5];
        let _kps3dZScaleFig = 1.0;
        if (_rShFig && _lShFig && _rShFig.c > 0.1 && _lShFig.c > 0.1) {
            const _rA = _pixelToRayFig(_rShFig.x, _rShFig.y);
            const _rB = _pixelToRayFig(_lShFig.x, _lShFig.y);
            const _dot = Math.max(-1, Math.min(1, _rA.dot(_rB)));
            const _shWorld = _camDistFig * 2 * Math.sin(Math.acos(_dot) / 2);
            _kps3dZScaleFig = _shWorld * 0.4;
        } else {
            _kps3dZScaleFig = _camDistFig * 0.05;
        }
        const worldKps = kps3d.map(kp => {
            if (!kp || kp.c < 0.1) return null;
            const pt = _camPosFig.clone().addScaledVector(_pixelToRayFig(kp.x, kp.y), _camDistFig);
            return {
                x: pt.x,
                y: pt.y,
                z: pt.z + (kp.z - 0.5) * _kps3dZScaleFig,
                c: kp.c
            };
        });

        // === Step5: ピタゴラスでZを確定（worldKps_argがない場合のみ）===
        // child.c < 0.6 (=0.5、画像端付近) → Zは親から継承
        const inferZ = (parentIdx, childIdx, boneLength) => {
            if (!boneLength) return;
            const parent = worldKps[parentIdx];
            const child  = worldKps[childIdx];
            if (!parent || !child || parent.c < 0.1 || child.c < 0.1) return;

            // 画像端付近（c=0.5）: Zは親を継承
            if (child.c < 0.6) {
                child.z = parent.z;
                return;
            }

            const dx = child.x - parent.x;
            const dy = child.y - parent.y;
            const xyDist2 = dx*dx + dy*dy;
            const zDist2  = boneLength*boneLength - xyDist2;

            if (zDist2 <= 0) {
                // XY>BONE: 元画像の体型がマネキンより大きい場合。
                // ベクトル方向は正しいので、親→子のXYZベクトルを正規化して
                // ボーン長分だけ進んだ地点のZを計算する。
                const dz = child.z - parent.z;
                const fullDist = Math.sqrt(xyDist2 + dz*dz);
                if (fullDist < 1e-6) return;
                // 正規化ベクトル × ボーン長 → ボーン長分だけ進んだZ
                child.z = parent.z + (dz / fullDist) * boneLength;
                return;
            }

            const xyRatio = Math.sqrt(xyDist2) / boneLength;
            const zDist = xyRatio > 0.85
                ? Math.sqrt(zDist2) * (1.0 - xyRatio) * 2.0
                : Math.sqrt(zDist2);

            const sign = child.z >= parent.z ? 1 : -1;
            child.z = parent.z + sign * zDist;
        };

        inferZ(KP.rShoulder, KP.rElbow,  BONE_LENGTHS.upperarm_r);
        inferZ(KP.rElbow,    KP.rWrist,   BONE_LENGTHS.lowerarm_r);
        inferZ(KP.lShoulder, KP.lElbow,   BONE_LENGTHS.upperarm_l);
        inferZ(KP.lElbow,    KP.lWrist,   BONE_LENGTHS.lowerarm_l);
        inferZ(KP.rHip,  KP.rKnee,  BONE_LENGTHS.thigh_r);
        inferZ(KP.rKnee, KP.rAnkle, BONE_LENGTHS.calf_r);
        inferZ(KP.lHip,  KP.lKnee,  BONE_LENGTHS.thigh_l);
        inferZ(KP.lKnee, KP.lAnkle, BONE_LENGTHS.calf_l);

        // === Step6: 棒人形描画 ===
        // worldKpsをVector3に変換
        const worldPos = worldKps.map(kp => {
            if (!kp) return null;
            return new THREE.Vector3(kp.x, kp.y, kp.z);
        });

        // デバッグ: 棒人形の座標をコンソールに出力
        const COCO18_NAMES_DBG = ['nose','neck','r_shoulder','r_elbow','r_wrist','l_shoulder','l_elbow','l_wrist','r_hip','r_knee','r_ankle','l_hip','l_knee','l_ankle','r_eye','l_eye','r_ear','l_ear'];
        console.log('[KpFigure] camDist=', _camDistFig?.toFixed(3), 'scaleIn=', scaleIn?.toFixed(5));
        for (let i = 0; i < 18; i++) {
            const wp = worldPos[i];
            if (wp) console.log(`[KpFigure] ${COCO18_NAMES_DBG[i]}: (${wp.x.toFixed(3)}, ${wp.y.toFixed(3)}, ${wp.z.toFixed(3)})`);
        }

        const KP_COLORS = [
            0x0000ff, 0x0000ff, 0xff5500, 0xffaa00, 0xffff00,
            0x55ff00, 0x00ff00, 0x00ff55, 0x00ffaa, 0x55ff00,
            0x00ff00, 0x0055ff, 0x00ffff, 0x00aaff,
            0xaa00ff, 0xaa00ff, 0xff00aa, 0xff00aa,
        ];
        const LIMBS = [
            [1, 0], [1, 2], [2, 3], [3, 4],
            [1, 5], [5, 6], [6, 7],
            [1, 8], [8, 9], [9, 10],
            [1, 11], [11, 12], [12, 13],
            [0, 14], [0, 15], [14, 16], [15, 17],
        ];

        if (this._kpFigureGroup) {
            this.scene.remove(this._kpFigureGroup);
            this._kpFigureGroup.traverse(obj => {
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) obj.material.dispose();
            });
        }
        // Clear RTMW figure when loading OpenPose data
        if (this._rtmwFigureGroup) {
            const mats = new Set();
            this._rtmwFigureGroup.traverse(obj => {
                if (obj.isMesh) { if (obj.geometry) obj.geometry.dispose(); if (obj.material) mats.add(obj.material); }
            });
            mats.forEach(m => m.dispose());
            (this._rtmwFigureGroup.parent || this.scene).remove(this._rtmwFigureGroup);
            this._rtmwFigureGroup = null;
        }
        if (this._rtmwFrustumGroup) {
            this.scene.remove(this._rtmwFrustumGroup);
            this._rtmwFrustumGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
            this._rtmwFrustumGroup = null;
        }
        this._kpFigureGroup = new THREE.Group();
        this._kpFigureGroup.name = 'kpFigure';
        this.scene.add(this._kpFigureGroup);

        // 頭部5点（nose/r_eye/l_eye/r_ear/l_ear）は固定ブロックで再描画するのでスキップ
        const HEAD_SKIP = new Set([KP.nose, KP.rEye, KP.lEye, KP.rEar, KP.lEar]);
        // 首→鼻の接続もスキップ（固定ブロック側で描画）
        for (let i = 0; i < 18; i++) {
            if (HEAD_SKIP.has(i)) continue;
            const wp = worldPos[i];
            if (!wp) continue;
            const geo = new THREE.SphereGeometry(0.1, 8, 8);
            const mat = new THREE.MeshBasicMaterial({ color: KP_COLORS[i], depthTest: false });
            const sphere = new THREE.Mesh(geo, mat);
            sphere.position.copy(wp);
            sphere.renderOrder = 998;
            this._kpFigureGroup.add(sphere);
        }

        for (const [i, j] of LIMBS) {
            if (HEAD_SKIP.has(i) || HEAD_SKIP.has(j)) continue;
            const a = worldPos[i];
            const b = worldPos[j];
            if (!a || !b) continue;
            const geo = new THREE.BufferGeometry().setFromPoints([a.clone(), b.clone()]);
            const mat = new THREE.LineBasicMaterial({ color: KP_COLORS[i], depthTest: false });
            const line = new THREE.Line(geo, mat);
            line.renderOrder = 997;
            this._kpFigureGroup.add(line);
        }

        // === デバッグログ ===
        const boneLengthDebug = ['=== ボーン長 vs XY距離 ==='];
        const checkXY = (parentIdx, childIdx, label, boneLength) => {
            const p = worldKps[parentIdx];
            const c = worldKps[childIdx];
            if (!p || !c || p.c < 0.1 || c.c < 0.1) {
                boneLengthDebug.push(`${label.padEnd(12)}: skipped`);
                return;
            }
            const dx = c.x - p.x;
            const dy = c.y - p.y;
            const xyDist = Math.sqrt(dx*dx + dy*dy);
            const ok = boneLength && xyDist <= boneLength ? 'OK' : 'XY>BONE!';
            boneLengthDebug.push(`${label.padEnd(12)}: boneLen=${boneLength?.toFixed(3) ?? 'null'}  xyDist=${xyDist.toFixed(3)}  ${ok}`);
        };
        checkXY(KP.rShoulder, KP.rElbow,  'upperarm_r', BONE_LENGTHS.upperarm_r);
        checkXY(KP.rElbow,    KP.rWrist,   'lowerarm_r', BONE_LENGTHS.lowerarm_r);
        checkXY(KP.lShoulder, KP.lElbow,   'upperarm_l', BONE_LENGTHS.upperarm_l);
        checkXY(KP.lElbow,    KP.lWrist,   'lowerarm_l', BONE_LENGTHS.lowerarm_l);
        checkXY(KP.rHip,  KP.rKnee,  'thigh_r',    BONE_LENGTHS.thigh_r);
        checkXY(KP.rKnee, KP.rAnkle, 'calf_r',     BONE_LENGTHS.calf_r);
        checkXY(KP.lHip,  KP.lKnee,  'thigh_l',    BONE_LENGTHS.thigh_l);
        checkXY(KP.lKnee, KP.lAnkle, 'calf_l',     BONE_LENGTHS.calf_l);

        const inputDebug = ['=== 3D KeyPoint Input (pixel) ==='];
        for (let i = 0; i < 18; i++) {
            const kp = kps3d[i];
            if (!kp || kp.c < 0.1) { inputDebug.push(`${COCO18_NAMES[i].padEnd(12)}: not detected`); continue; }
            const edge = kp.c < 0.6 ? ' [EDGE]' : '';
            inputDebug.push(`${COCO18_NAMES[i].padEnd(12)}: px=(${kp.x.toFixed(0)},${kp.y.toFixed(0)}) z(depth)=${kp.z.toFixed(3)} c=${kp.c.toFixed(1)}${edge}`);
        }

        const resultDebug = ['=== 棒人形 3D座標 (カメラ空間変換) ==='];
        for (let i = 0; i < 18; i++) {
            const wp = worldPos[i];
            if (!wp) { resultDebug.push(`${COCO18_NAMES[i].padEnd(12)}: not detected`); continue; }
            resultDebug.push(`${COCO18_NAMES[i].padEnd(12)}: x=${wp.x.toFixed(3)} y=${wp.y.toFixed(3)} z=${wp.z.toFixed(3)}`);
        }

        const debugLines = [
            ...allBoneLengthDebug, '',
            ...boneLengthDebug, '',
            ...inputDebug, '',
            ...resultDebug,
        ];

        // 頭部ピボット点（headボーン相当）を棒人形上に描画
        // 両耳の中点から推測（耳が検出されている場合）
        {
            const rEarKp = worldKps[KP.rEar];
            const lEarKp = worldKps[KP.lEar];
            if (rEarKp && lEarKp && rEarKp.c >= 0.1 && lEarKp.c >= 0.1) {
                // 耳の間隔をスケール基準とする
                const earSpan = new THREE.Vector3(
                    lEarKp.x - rEarKp.x,
                    lEarKp.y - rEarKp.y,
                    lEarKp.z - rEarKp.z
                ).length();
                // headボーンは耳の中点から少し上・後方
                // 耳の間隔に対する比率で固定（解剖学的比率）
                const earMid = new THREE.Vector3(
                    (rEarKp.x + lEarKp.x) / 2,
                    (rEarKp.y + lEarKp.y) / 2,
                    (rEarKp.z + lEarKp.z) / 2
                );
                // headピボット = 耳の中点から上方向に earSpan * 0.1、後方に earSpan * 0.18
                const headPivot = earMid.clone().add(new THREE.Vector3(0, earSpan * 0.1, -earSpan * 0.18));
                const geo = new THREE.SphereGeometry(0.12, 8, 8);
                const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
                const sphere = new THREE.Mesh(geo, mat);
                sphere.position.copy(headPivot);
                sphere.renderOrder = 999;
                this._kpFigureGroup.add(sphere);

                // 前向きベクトルの計算（耳の左右ベクトルとupから決定）
                const rightVec = new THREE.Vector3(
                    lEarKp.x - rEarKp.x,
                    lEarKp.y - rEarKp.y,
                    lEarKp.z - rEarKp.z
                ).normalize();
                const upVec = new THREE.Vector3(0, 1, 0);
                const forwardVec = new THREE.Vector3().crossVectors(rightVec, upVec).normalize();
                // upVecを直交化
                const upFixed = new THREE.Vector3().crossVectors(forwardVec, rightVec).normalize();
                if (upFixed.y < 0) upFixed.negate();

                // 矢印で前向きベクトルを表示
                const arrowLen = earSpan * 0.8;
                const arrow = new THREE.ArrowHelper(forwardVec, headPivot, arrowLen, 0xffffff, arrowLen * 0.3, arrowLen * 0.15);
                arrow.renderOrder = 999;
                arrow.line.material.depthTest = false;
                arrow.line.renderOrder = 999;
                arrow.cone.material.depthTest = false;
                arrow.cone.renderOrder = 999;
                this._kpFigureGroup.add(arrow);

                // 解剖学的固定ブロックで5点を再配置（対称性を保証）
                // HEAD_REF: headPivotを原点、earSpan/1.42を単位とした固定オフセット
                const headScale = earSpan / 1.42; // 耳の間隔からスケールを算出
                const HEAD_SYMMETRIC = {
                    nose:  new THREE.Vector3( 0.000, -0.050,  0.600),
                    r_eye: new THREE.Vector3(-0.290,  0.200,  0.450),
                    l_eye: new THREE.Vector3( 0.290,  0.200,  0.450),
                    r_ear: new THREE.Vector3(-0.710,  0.000,  0.000),
                    l_ear: new THREE.Vector3( 0.710,  0.000,  0.000),
                };
                const HEAD_COLORS = {
                    nose: 0x0000ff, r_eye: 0xaa00ff, l_eye: 0xaa00ff,
                    r_ear: 0xff00aa, l_ear: 0xff00aa
                };
                const HEAD_KP_IDX = { nose: KP.nose, r_eye: KP.rEye, l_eye: KP.lEye, r_ear: KP.rEar, l_ear: KP.lEar };

                for (const [name, offset] of Object.entries(HEAD_SYMMETRIC)) {
                    // ローカル座標をワールド座標に変換
                    const localVec = new THREE.Vector3(
                        offset.x * headScale,
                        offset.y * headScale,
                        offset.z * headScale
                    );
                    // 座標系変換: X=right, Y=up, Z=forward
                    const worldOffset = new THREE.Vector3(
                        rightVec.x * localVec.x + upFixed.x * localVec.y + forwardVec.x * localVec.z,
                        rightVec.y * localVec.x + upFixed.y * localVec.y + forwardVec.y * localVec.z,
                        rightVec.z * localVec.x + upFixed.z * localVec.y + forwardVec.z * localVec.z
                    );
                    const pt = headPivot.clone().add(worldOffset);

                    // 球を描画
                    const geo2 = new THREE.SphereGeometry(0.09, 8, 8);
                    const mat2 = new THREE.MeshBasicMaterial({ color: HEAD_COLORS[name], depthTest: false });
                    const sp2 = new THREE.Mesh(geo2, mat2);
                    sp2.position.copy(pt);
                    sp2.renderOrder = 998;
                    this._kpFigureGroup.add(sp2);

                    // worldKpsも更新（FK適用時に使う）
                    const idx = HEAD_KP_IDX[name];
                    if (worldKps[idx]) {
                        worldKps[idx].x = pt.x;
                        worldKps[idx].y = pt.y;
                        worldKps[idx].z = pt.z;
                    }
                }

                // OpenPoseスタイルの顔接続線
                const faceConnections = [
                    [KP.rEar,  KP.rEye,  0xff00aa],
                    [KP.rEye,  KP.nose,  0xaa00ff],
                    [KP.nose,  KP.lEye,  0xaa00ff],
                    [KP.lEye,  KP.lEar,  0xff00aa],
                    [KP.neck,  KP.nose,  0x0000ff],
                ];
                for (const [idxA, idxB, color] of faceConnections) {
                    const kpA = worldKps[idxA];
                    const kpB = worldKps[idxB];
                    if (!kpA || !kpB || kpA.c < 0.1 || kpB.c < 0.1) continue;
                    const ptA = new THREE.Vector3(kpA.x, kpA.y, kpA.z);
                    const ptB = new THREE.Vector3(kpB.x, kpB.y, kpB.z);
                    const geo2 = new THREE.BufferGeometry().setFromPoints([ptA, ptB]);
                    const mat2 = new THREE.LineBasicMaterial({ color, depthTest: false });
                    const line2 = new THREE.Line(geo2, mat2);
                    line2.renderOrder = 997;
                    this._kpFigureGroup.add(line2);
                }
            }
        }

        // Step7: FK適用はapplyPoseKeypointsで既に完了しているため、ここでは棒人形描画のみ

        this.requestRender();
        return { debugLines };
    }

    // worldKpsからFKでマネキンのボーン角度を設定する
    _applyFKFromWorldKps(worldKps, KP) {
        const THREE = this.THREE;

        // 現在のIKモードを保存
        const wasIKMode = this.ikMode;

        // FKモードに切り替え
        this.setIKMode(false);

        // マネキンのrootボーン（pelvis）をhip中点に移動
        const rHip = worldKps[KP.rHip];
        const lHip = worldKps[KP.lHip];
        const neck = worldKps[KP.neck];
        if (rHip && lHip && rHip.c >= 0.1 && lHip.c >= 0.1) {
            const hipCenter = new THREE.Vector3(
                (rHip.x + lHip.x) / 2,
                (rHip.y + lHip.y) / 2,
                (rHip.z + lHip.z) / 2
            );
            // pelvisボーンをhip中点に移動（ワールド座標）
            const pelvisBone = this.bones['pelvis'] || this.boneList.find(b => !b.parent || b.parent.name === 'Root');
            if (pelvisBone) {
                // ワールド座標をローカル座標に変換
                const parentWorldInv = new THREE.Matrix4();
                if (pelvisBone.parent) {
                    parentWorldInv.copy(pelvisBone.parent.matrixWorld).invert();
                }
                const localPos = hipCenter.clone().applyMatrix4(parentWorldInv);
                pelvisBone.position.copy(localPos);
                this.skinnedMesh.updateMatrixWorld(true);
            }
        }

        // ボーン方向ベクトルからクォータニオンを計算して適用
        // ボーンの「先端ボーン名」テーブル（Tポーズ時の向きを求めるため）
        const BONE_CHILD = {
            'upperarm_r': 'lowerarm_r',
            'lowerarm_r': 'hand_r',
            'upperarm_l': 'lowerarm_l',
            'lowerarm_l': 'hand_l',
            'thigh_r':    'calf_r',
            'calf_r':     'foot_r',
            'thigh_l':    'calf_l',
            'calf_l':     'foot_l',
            'head':       '_neck_to_head', // 特殊: neck_01→headのベクトルを使用
        };

        const applyBoneFK = (boneName, parentKp, childKp) => {
            if (!parentKp || !childKp || parentKp.c < 0.1 || childKp.c < 0.1) return;
            const bone = this.bones[boneName];
            if (!bone) return;

            // 目標方向ベクトル（ワールド空間）
            const targetDir = new THREE.Vector3(
                childKp.x - parentKp.x,
                childKp.y - parentKp.y,
                childKp.z - parentKp.z
            ).normalize();
            if (targetDir.lengthSq() < 0.001) return;

            // 現在のボーン方向 = Tポーズ時の このボーン原点 → 子ボーン原点 のベクトル
            const childBoneName = BONE_CHILD[boneName];
            let currentDir;
            if (childBoneName === '_neck_to_head') {
                // headの特殊ケース: neck_01→headのベクトルをTポーズ向きとして使用
                const neckBone = this.bones['neck_01'];
                const bonePos = new THREE.Vector3();
                const neckPos = new THREE.Vector3();
                bone.getWorldPosition(bonePos);
                if (neckBone) {
                    neckBone.getWorldPosition(neckPos);
                    currentDir = bonePos.clone().sub(neckPos).normalize();
                } else {
                    currentDir = new THREE.Vector3(0, 1, 0);
                }
            } else {
                const childBone = childBoneName ? this.bones[childBoneName] : null;
                if (childBone) {
                    const bonePos = new THREE.Vector3();
                    const childPos = new THREE.Vector3();
                    bone.getWorldPosition(bonePos);
                    childBone.getWorldPosition(childPos);
                    currentDir = childPos.clone().sub(bonePos).normalize();
                } else {
                    // 子ボーンがない場合はgetWorldDirectionにフォールバック
                    currentDir = new THREE.Vector3();
                    bone.getWorldDirection(currentDir);
                }
            }
            if (currentDir.lengthSq() < 0.001) return;

            // 現在のボーンのワールドクォータニオン
            const boneWorldQ = new THREE.Quaternion();
            bone.getWorldQuaternion(boneWorldQ);

            // currentDir → targetDir への回転（ワールド空間）
            const deltaQ = new THREE.Quaternion().setFromUnitVectors(currentDir, targetDir);

            // 新しいワールドクォータニオン = deltaQ * 現在のワールドQ
            const newWorldQ = deltaQ.multiply(boneWorldQ);

            // ワールドQをローカルQに変換: localQ = parentWorldQ.inv * newWorldQ
            const parentWorldQ = new THREE.Quaternion();
            if (bone.parent) bone.parent.getWorldQuaternion(parentWorldQ);
            const localQ = parentWorldQ.clone().invert().multiply(newWorldQ);
            bone.quaternion.copy(localQ);
            bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
            this.skinnedMesh.updateMatrixWorld(true);
        };

        // 体幹から末端の順で適用
        // 脊椎（neck→shoulderの中点方向）
        const rSh = worldKps[KP.rShoulder];
        const lSh = worldKps[KP.lShoulder];

        // 腕
        applyBoneFK('upperarm_r', worldKps[KP.rShoulder], worldKps[KP.rElbow]);
        applyBoneFK('lowerarm_r', worldKps[KP.rElbow],    worldKps[KP.rWrist]);
        applyBoneFK('upperarm_l', worldKps[KP.lShoulder], worldKps[KP.lElbow]);
        applyBoneFK('lowerarm_l', worldKps[KP.lElbow],    worldKps[KP.lWrist]);

        // 脚
        applyBoneFK('thigh_r', worldKps[KP.rHip],  worldKps[KP.rKnee]);
        applyBoneFK('calf_r',  worldKps[KP.rKnee], worldKps[KP.rAnkle]);
        applyBoneFK('thigh_l', worldKps[KP.lHip],  worldKps[KP.lKnee]);
        applyBoneFK('calf_l',  worldKps[KP.lKnee], worldKps[KP.lAnkle]);




        this.skinnedMesh.updateMatrixWorld(true);
        if (this.skeleton) this.skeleton.update();
        this.updateMarkers();

        // 元のモードに戻す
        if (wasIKMode) {
            this.updateIKEffectorPositions();
            this.setIKMode(true);
        }
    }
///////////////////////////////////////////////////////////////////////////////////////////////////
    drawHMR2v1Figure(people, sourceImageSize, smplRefHeight = 1.5, shoulderYOffset = 0) {
        const THREE = this.THREE;
        const log = ['=== HMR2 v1 3D Figure ==='];

        // ── Clear previous HMR2 figure ───────────────────────────────────────
        if (this._hmr2FigureGroup) {
            this._hmr2FigureGroup.traverse(obj => {
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) obj.material.dispose();
            });
            this.scene.remove(this._hmr2FigureGroup);
            this._hmr2FigureGroup = null;
        }
        // Also clear RTMW figure if present
        if (this._rtmwFigureGroup) {
            this._rtmwFigureGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
            this.scene.remove(this._rtmwFigureGroup);
            this._rtmwFigureGroup = null;
        }
        if (this._kpFigureGroup) {
            this.scene.remove(this._kpFigureGroup);
            this._kpFigureGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
            this._kpFigureGroup = null;
        }

        if (!people || !people.length) return '人物データなし';
        const person = people[0];
        const kp3d = person.keypoints_3d;
        if (!kp3d) return 'keypoints_3d なし';

        // ── OpenPose 25点の接続定義 ───────────────────────────────────────────
        // CLAUDE.mdのJOINT_NAMES順に準拠
        // OpenPose配色: [nameA, nameB, hexColor]
        const BONES = [
            ['nose',           'neck',           0xff0000],
            ['neck',           'right_shoulder', 0xff7700],
            ['neck',           'left_shoulder',  0x00aa00],
            ['neck',           'pelvis',         0xffff00],
            ['pelvis',         'right_hip',      0xff7700],
            ['pelvis',         'left_hip',       0x00aa00],
            ['right_shoulder', 'right_elbow',    0xff7700],
            ['right_elbow',    'right_wrist',    0xffaa00],
            ['left_shoulder',  'left_elbow',     0x00aa00],
            ['left_elbow',     'left_wrist',     0x00dd00],
            ['right_hip',      'right_knee',     0xff00ff],
            ['right_knee',     'right_ankle',    0xaa00ff],
            ['left_hip',       'left_knee',      0x00ffff],
            ['left_knee',      'left_ankle',     0x0088ff],
            ['nose',           'right_eye',      0xff4444],
            ['nose',           'left_eye',       0x44ff44],
            ['right_eye',      'right_ear',      0xff8888],
            ['left_eye',       'left_ear',       0x88ff88],
            ['right_ankle',    'right_big_toe',  0xaa00ff],
            ['right_ankle',    'right_heel',     0xaa00ff],
            ['left_ankle',     'left_big_toe',   0x0088ff],
            ['left_ankle',     'left_heel',      0x0088ff],
        ];

        // ── Mannequin参照 (pelvisのワールド座標を原点として使用) ──────────────
        let mannequinPelvis = new THREE.Vector3(0, 0, 0);
        if (this.bones) {
            const pelvisBone = this.bones['pelvis'] || this.bones['spine_01'];
            if (pelvisBone) pelvisBone.getWorldPosition(mannequinPelvis);
        }
        // Tポーズ身長キャッシュ（モデルロード時に確定、AGE変更で更新される）
        const targetHeight = this._tposeHeight || 1.7;

        const SMPL_REFERENCE_HEIGHT = smplRefHeight;
        const smplScale = targetHeight / SMPL_REFERENCE_HEIGHT;
        log.push(`smplScale: ${smplScale.toFixed(4)}`);

        // ── SMPL root-relative座標 → Three.jsワールド座標 ────────────────────
        // SMPL: Y上向き, X右向き, Z前向き（カメラ方向）
        // Three.js: Y上向き, X右向き, Z前向き（カメラ方向）
        // → 軸変換不要。pelvisをmannequinPelvisにアンカー
        const smplPelvis = kp3d['pelvis'] || [0, 0, 0];
        const toWorld = (xyz) => {
            if (!xyz) return null;
            return new THREE.Vector3(
                mannequinPelvis.x + (xyz[0] - smplPelvis[0]) * smplScale,
                mannequinPelvis.y - (xyz[1] - smplPelvis[1]) * smplScale,  // SMPL Y上向き → Three.js Y反転
                mannequinPelvis.z - (xyz[2] - smplPelvis[2]) * smplScale,  // SMPL Z反転
            );
        };

        // 全関節のワールド座標を計算
        const worldKps = {};
        for (const [name, xyz] of Object.entries(kp3d)) {
            worldKps[name] = toWorld(xyz);
        }

        // ── 棒人形グループ作成 ────────────────────────────────────────────────
        const group = new THREE.Group();
        group.name = 'hmr2v1_figure';

        // 関節球のマテリアル
        const jointMat  = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
        const pelvisMat = new THREE.MeshBasicMaterial({ color: 0xffaa00, depthTest: false });

        const jointGeo = new THREE.SphereGeometry(0.025, 8, 8);
        const pelvisGeo = new THREE.SphereGeometry(0.04, 8, 8);

        // 関節球を配置
        for (const [name, wpos] of Object.entries(worldKps)) {
            if (!wpos) continue;
            const geo = name === 'pelvis' ? pelvisGeo : jointGeo;
            const mat = name === 'pelvis' ? pelvisMat : jointMat;
            const sphere = new THREE.Mesh(geo, mat);
            sphere.position.copy(wpos);
            sphere.renderOrder = 999;
            group.add(sphere);
        }

        // ボーン（ライン）を色付きで描画
        for (const [nameA, nameB, color] of BONES) {
            const pA = worldKps[nameA];
            const pB = worldKps[nameB];
            if (!pA || !pB) continue;
            const mat = new THREE.LineBasicMaterial({ color, depthTest: false });
            const geom = new THREE.BufferGeometry().setFromPoints([pA, pB]);
            const line = new THREE.Line(geom, mat);
            line.renderOrder = 998;
            group.add(line);
        }

        this.scene.add(group);
        this._hmr2FigureGroup = group;

        // ── キャンバスBBOXをワールド座標で描画 ───────────────────────────────
        // keypoints_2d_norm は [0,1] 正規化座標。
        // 任意の基準点の 2d_norm と worldKps の対応から
        // 「正規化座標1単位 = 何ワールド単位か」を求め、四隅を計算する。
        const kp2dNorm = person.keypoints_2d_norm || {};
        const [imageW, imageH] = sourceImageSize;

        // 基準点ペアからnorm→worldスケールを求める
        // nose と pelvis を使う（垂直方向に離れていて安定）
        const noseNorm   = kp2dNorm['nose'];
        const pelvisNorm = kp2dNorm['pelvis'];
        const noseW2     = worldKps['nose'];
        const pelvisW2   = worldKps['pelvis'] || mannequinPelvis;

        let normScale = 1.0; // 正規化座標1単位 = 何ワールド単位か
        if (noseNorm && pelvisNorm && noseW2) {
            const normDist  = Math.sqrt(
                Math.pow((noseNorm[0]  - pelvisNorm[0]) * imageW,  2) +
                Math.pow((noseNorm[1]  - pelvisNorm[1]) * imageH,  2)
            ) / imageH; // 正規化距離
            const worldDist = noseW2.distanceTo(pelvisW2);
            if (normDist > 0.001) normScale = worldDist / normDist;
        }

        // pelvisを基準にキャンバス四隅のワールド座標を計算
        // pelvisNorm が (px, py) のとき、キャンバス左上は (0,0)、右下は (1,1)
        const anchor2d = pelvisNorm || [0.5, 0.5];
        const anchorW  = pelvisW2;

        const normToWorld = (nx, ny) => new THREE.Vector3(
            anchorW.x + (nx - anchor2d[0]) * imageW / imageH * normScale,
            anchorW.y - (ny - anchor2d[1]) * normScale,
            anchorW.z
        );

        const cTL = normToWorld(0, 0);
        const cTR = normToWorld(1, 0);
        const cBR = normToWorld(1, 1);
        const cBL = normToWorld(0, 1);

        log.push('canvas TL: (' + cTL.x.toFixed(3) + ', ' + cTL.y.toFixed(3) + ', ' + cTL.z.toFixed(3) + ')');
        log.push('canvas BR: (' + cBR.x.toFixed(3) + ', ' + cBR.y.toFixed(3) + ', ' + cBR.z.toFixed(3) + ')');
        log.push('normScale: ' + normScale.toFixed(5));

        // ── カメラをキャンバス四角に合わせて配置 ─────────────────────────────
        // 四角の中心と大きさが分かっているので、現在のFOVで全体が収まる距離を計算する
        const canvasCenterW = new THREE.Vector3(
            (cTL.x + cBR.x) / 2,
            (cTL.y + cBR.y) / 2,
            cTL.z
        );
        const canvasHalfH = (cTL.y - cBR.y) / 2; // world単位での高さ半分
        const canvasHalfW = (cBR.x - cTL.x) / 2; // world単位での幅半分

        const fovYRad = this.camera.fov * Math.PI / 180;
        const tanH    = Math.tan(fovYRad / 2);
        const camAsp  = imageW / imageH;  // ソース画像のARを使う（ビューポートARではない）

        // 高さ・幅それぞれで必要な距離を計算し、大きい方を採用
        const distForH = Math.abs(canvasHalfH) / tanH;
        const distForW = Math.abs(canvasHalfW) / (tanH * camAsp);
        const camDist  = Math.max(distForH, distForW);

        this.camera.position.set(canvasCenterW.x, canvasCenterW.y, canvasCenterW.z + camDist);
        this.orbit.target.copy(canvasCenterW);
        this.orbit.update();

        this.saveRTMWCameraState();
        this.requestRender();

        // デバッグログ
        log.push(`joints: ${Object.keys(worldKps).length}`);
        log.push('pelvis world: (' + pelvisW2.x.toFixed(3) + ', ' + pelvisW2.y.toFixed(3) + ', ' + pelvisW2.z.toFixed(3) + ')');
        const noseW = worldKps['nose'];
        if (noseW) log.push(`nose world:   (${noseW.x.toFixed(3)}, ${noseW.y.toFixed(3)}, ${noseW.z.toFixed(3)})`);

        // fitMannequinToHMR2() で使うためにキャッシュ
        this._hmr2WorldKps = worldKps;

        return log.join('\n');
    }

    drawRTMW3DFigure(kpts, imageW, imageH) {
        const THREE = this.THREE;

        // Cache params so FOV changes can trigger a redraw
        const isFirstLoad = !this._rtmwLastKpts;
        this._rtmwLastKpts   = kpts;
        this._rtmwLastImageW = imageW;
        this._rtmwLastImageH = imageH;

        // Clear previous RTMW figure
        if (this._rtmwFigureGroup) {
            const mats = new Set();
            this._rtmwFigureGroup.traverse(obj => {
                if (obj.isMesh) {
                    if (obj.geometry) obj.geometry.dispose();
                    if (obj.material) mats.add(obj.material);
                }
            });
            mats.forEach(m => m.dispose());
            (this._rtmwFigureGroup.parent || this.scene).remove(this._rtmwFigureGroup);
            this._rtmwFigureGroup = null;
        }
        if (this._rtmwFrustumGroup) {
            this.scene.remove(this._rtmwFrustumGroup);
            this._rtmwFrustumGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
            this._rtmwFrustumGroup = null;
        }
        this._hoveredRTMWJoint = null;
        this._selectedRTMWJoint = null;
        if (this._kpFigureGroup) {
            this.scene.remove(this._kpFigureGroup);
            this._kpFigureGroup.traverse(obj => {
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) obj.material.dispose();
            });
            this._kpFigureGroup = null;
        }

        if (!kpts || kpts.length < 17) return;

        const valid = (i) => i < kpts.length && kpts[i] && kpts[i].valid;

        // ── Mannequin reference (full 3D pelvis position) ─────────────────────
        const targetHeight = this._tposeHeight || 1.7;
        let mannequinPelvis = new THREE.Vector3(0, 0, 0);
        if (this.bones) {
            const pelvisBone = this.bones['pelvis'] || this.bones['spine_01'];
            if (pelvisBone) pelvisBone.getWorldPosition(mannequinPelvis);
        }

        // ── Multi-reference scale estimation (P1–P7) ──────────────────────────
        const vpy = (i) => (valid(i) ? kpts[i].py : null);
        const vpx = (i) => (valid(i) ? kpts[i].px : null);
        const avg2 = (a, b) => (a != null && b != null) ? (a+b)/2 : (a ?? b);

        const nPy   = vpy(0);
        const ankPy = avg2(vpy(15), vpy(16));
        const shPy  = avg2(vpy(5),  vpy(6));
        const hipPy = avg2(vpy(11), vpy(12));
        const shW   = (valid(5) && valid(6)) ? Math.abs(kpts[5].px - kpts[6].px) : null;
        const earW  = (valid(3) && valid(4)) ? Math.abs(kpts[3].px - kpts[4].px) : null;

        let scale = 1.0, scaleRef = 'P7:fallback';
        if      (nPy != null  && ankPy != null && ankPy - nPy   > 50) { scale = targetHeight * 0.91 / (ankPy - nPy);   scaleRef = 'P1:nose-ankle'; }
        else if (shPy != null && ankPy != null && ankPy - shPy  > 50) { scale = targetHeight * 0.81 / (ankPy - shPy);  scaleRef = 'P2:shldr-ankle'; }
        else if (nPy != null  && hipPy != null && hipPy - nPy   > 20) { scale = targetHeight * 0.38 / (hipPy - nPy);   scaleRef = 'P3:nose-hip'; }
        else if (shPy != null && hipPy != null && hipPy - shPy  > 10) { scale = targetHeight * 0.28 / (hipPy - shPy);  scaleRef = 'P4:shldr-hip'; }
        else if (shW != null  && shW > 20)                             { scale = targetHeight * 0.25 / shW;             scaleRef = 'P5:shldr-width'; }
        else if (earW != null && earW > 10)                            { scale = targetHeight * 0.09 / earW;            scaleRef = 'P6:ear-width'; }
        else {
            const pys = kpts.slice(0, 17).filter(k => k?.valid).map(k => k.py);
            if (pys.length >= 2) { const r = Math.max(...pys) - Math.min(...pys); if (r > 0) scale = targetHeight / r; }
        }

        const bhPx = targetHeight / scale;

        // ── Hip anchor pixel position ──────────────────────────────────────────
        let cx, cy, hipSrcNote;
        if (hipPy != null) {
            cx = avg2(vpx(11), vpx(12)) ?? imageW / 2;
            cy = hipPy;
            hipSrcNote = 'direct';
        } else if (shPy != null) {
            cy = shPy + 0.28 * bhPx;
            cx = avg2(vpx(5), vpx(6)) ?? imageW / 2;
            hipSrcNote = 'est.from-shoulder';
        } else if (nPy != null) {
            cy = nPy + 0.38 * bhPx;
            cx = avg2(vpx(3), vpx(4)) ?? vpx(0) ?? imageW / 2;
            hipSrcNote = 'est.from-nose';
        } else {
            cx = imageW / 2; cy = imageH / 2;
            hipSrcNote = 'fallback-centre';
        }

        const noseY = nPy, ankY = ankPy;

        // ── Camera intrinsics ──────────────────────────────────────────────────
        const fovYRad = this.camera.fov * Math.PI / 180;
        const tanH    = Math.tan(fovYRad / 2);
        const camAsp  = this.camera.aspect;

        // ── Camera position estimation (must precede W array for ray placement) ─
        const d_est    = scale * imageH / (2 * tanH);
        const ndcHipX  = 2*cx/imageW - 1;
        const ndcHipY  = 1 - 2*cy/imageH;
        const estCamPos = new THREE.Vector3(
            mannequinPelvis.x - ndcHipX * d_est * tanH * camAsp,
            mannequinPelvis.y - ndcHipY * d_est * tanH,
            mannequinPelvis.z + d_est
        );

        // ── Z normalisation (world-space, anchored at hip) ────────────────────
        // RTMW3D Z: negative = toward camera; Three.js Z: positive = toward camera
        // Z-span mapped to 40% of targetHeight in world units.
        const bodyZvals = kpts.slice(0, 23).filter(k => k?.valid).map(k => k.z);
        let zMin_r = 0, zMax_r = 0, zMid_r = 0, zNS = 0;
        if (bodyZvals.length >= 2) {
            zMin_r = Math.min(...bodyZvals);
            zMax_r = Math.max(...bodyZvals);
            const rawSpan = zMax_r - zMin_r;
            zMid_r = (zMin_r + zMax_r) / 2;
            if (rawSpan > 0.01) zNS = (targetHeight * 0.4) / rawSpan;
        }

        // Hip Z anchor in RTMW data (maps to mannequinPelvis.z in world space)
        const hipZs = [];
        if (valid(11)) hipZs.push(kpts[11].z);
        if (valid(12)) hipZs.push(kpts[12].z);
        const hipZCenter = hipZs.length ? hipZs.reduce((a, b) => a+b, 0) / hipZs.length : zMid_r;

        // ── Bone length constants (all as targetHeight ratio) ─────────────────
        // Fixed proportions — independent of which mannequin bones are loaded.
        // Ratios based on standard human body proportions (height-normalized).
        const mLen = {
            // Body
            spineH:          targetHeight * 0.271, // pelvis → mid-shoulder
            shdrHalf:        targetHeight * 0.107, // mid-shoulder → shoulder joint
            shdrWidth:       targetHeight * 0.224, // both shoulders full width (measured from frontal data)
            upperArm:        targetHeight * 0.169, // shoulder → elbow
            foreArm:         targetHeight * 0.162, // elbow → wrist
            neck:            targetHeight * 0.142, // mid-shoulder → nose
            hipHalf:         targetHeight * 0.075, // pelvis center → hip joint
            hipWidth:        targetHeight * 0.158, // both hips full width (measured from frontal data)
            thigh:           targetHeight * 0.282, // hip → knee
            calf:            targetHeight * 0.285, // knee → ankle
            // Face
            noseToEye:       targetHeight * 0.028, // nose → eye
            noseToEar:       targetHeight * 0.060, // nose → ear
            faceRadius:      targetHeight * 0.060, // face mesh spread (= noseToEar)
            // Hand/finger
            thumbMeta:       targetHeight * 0.025, // wrist → thumb CMC
            thumbProx:       targetHeight * 0.022, // CMC  → MCP
            thumbMid:        targetHeight * 0.018, // MCP  → IP
            thumbDist:       targetHeight * 0.015, // IP   → TIP
            handMeta:        targetHeight * 0.048, // wrist → finger MCP (palm)
            fingerProx:      targetHeight * 0.022, // MCP  → PIP
            fingerMid:       targetHeight * 0.016, // PIP  → DIP
            fingerDist:      targetHeight * 0.012, // DIP  → TIP
            // Foot secondary joints
            ankleToToe:      targetHeight * 0.105, // ankle → big toe
            ankleToSmallToe: targetHeight * 0.095, // ankle → small toe
            ankleToHeel:     targetHeight * 0.038, // ankle → heel
        };

        this._rtmwCalLog = [];  // reset each render

        // ── Joint placement helpers ───────────────────────────────────────────
        const kpx = (i) => valid(i) ? kpts[i].px : null;
        const kpy = (i) => valid(i) ? kpts[i].py : null;
        const kpz = (i) => valid(i) ? kpts[i].z  : null;

        const rayPlaceFrom = (pxPix, pyPix, parentW, boneLen, childZRaw, parentZRaw) => {
            // XY fixed to canvas projection
            const wx = mannequinPelvis.x + (pxPix - cx) * scale;
            const wy = mannequinPelvis.y + (cy - pyPix) * scale;
            // Z magnitude from Pythagorean; z_raw gives front/back sign
            const dx = wx - parentW.x;
            const dy = wy - parentW.y;
            const dzSq = boneLen * boneLen - (dx*dx + dy*dy);
            const dz = dzSq > 0 ? Math.sqrt(dzSq) : 0;
            const sign = (childZRaw <= parentZRaw) ? +1 : -1;
            return new THREE.Vector3(wx, wy, parentW.z + sign * dz);
        };

        // ── Face yaw estimation ───────────────────────────────────────────────
        // yaw = (nose_px - ear_mid_px) / ear_width_px
        // yaw < -0.1 → 左向き（left side toward camera → left is +Z）
        // yaw > +0.1 → 右向き（right side toward camera → right is +Z）
        // |yaw| ≤ 0.1 → 正面（dz=0）
        let faceYaw = 0;
        {
            const nosePx  = valid(0) ? kpts[0].px : null;
            const lEarPx  = valid(3) ? kpts[3].px : null;
            const rEarPx  = valid(4) ? kpts[4].px : null;
            const lEyePx  = valid(1) ? kpts[1].px : null;
            const rEyePx  = valid(2) ? kpts[2].px : null;
            const refPx   = nosePx ?? avg2(lEyePx, rEyePx);
            const midPx   = avg2(lEarPx, rEarPx) ?? avg2(lEyePx, rEyePx);
            const widthPx = (lEarPx != null && rEarPx != null) ? Math.abs(lEarPx - rEarPx)
                          : (lEyePx != null && rEyePx != null) ? Math.abs(lEyePx - rEyePx) * 2.5
                          : null;
            if (refPx != null && midPx != null && widthPx != null && widthPx > 1) {
                faceYaw = (refPx - midPx) / widthPx;
            }
        }
        // leftFront: 左側がカメラ寄り(+Z) のとき true
        const leftFront  = faceYaw < -0.1;
        const rightFront = faceYaw > +0.1;
        this._rtmwCalLog.push(`faceYaw=${faceYaw.toFixed(3)}  ${leftFront ? '→ 左向き' : rightFront ? '→ 右向き' : '→ 正面'}`);

        // ── Symmetric pair placement (replaces pairPlaceZ) ───────────────────
        // fullWidth: mLen.shdrWidth or mLen.hipWidth (world units, from frontal data)
        // |faceYaw| > YAW_SIDE → 体がほぼ真横 → dxyが信頼できないのでfullWidth/2を直接使う
        const YAW_SIDE = 0.3;
        const pairPlace = (px1, py1, px2, py2, label, fullWidth, midZ) => {
            // px1/py1 = left joint,  px2/py2 = right joint
            const wx1 = mannequinPelvis.x + (px1 - cx) * scale;
            const wy1 = mannequinPelvis.y + (cy - py1) * scale;
            const wx2 = mannequinPelvis.x + (px2 - cx) * scale;
            const wy2 = mannequinPelvis.y + (cy - py2) * scale;
            const dxy = Math.sqrt((wx1-wx2)**2 + (wy1-wy2)**2);
            let dzHalf, mode;
            if (Math.abs(faceYaw) > YAW_SIDE) {
                // 真横に近い → dxyが信頼できない → fullWidth/2を直接使用
                dzHalf = fullWidth / 2;
                mode = 'side';
            } else {
                const dzSq = fullWidth * fullWidth - dxy * dxy;
                dzHalf = dzSq > 0 ? Math.sqrt(dzSq) / 2 : 0;
                mode = 'dxy';
            }
            // 左がカメラ寄り → 左(wx1)が +dz
            const lSign = leftFront ? +1 : rightFront ? -1 : 0;
            this._rtmwCalLog.push(`[${label}] dxy=${dxy.toFixed(3)} fullWidth=${fullWidth.toFixed(3)} dzHalf=${dzHalf.toFixed(3)} lSign=${lSign} mode=${mode}`);
            return [
                new THREE.Vector3(wx1, wy1, midZ + lSign * dzHalf),
                new THREE.Vector3(wx2, wy2, midZ - lSign * dzHalf),
            ];
        };

        // Mid-shoulder virtual pixel (average of kpts[5] and kpts[6])
        const midShPx = avg2(kpx(5), kpx(6)) ?? cx;
        const midShPy = avg2(kpy(5), kpy(6)) ?? cy;
        const midShZ  = avg2(kpz(5), kpz(6)) ?? hipZCenter;

        // ── Build W array: ray hierarchy from hip_center ─────────────────────
        const W = new Array(kpts.length).fill(null);

        const W_hipC  = mannequinPelvis.clone();
        const W_midSh = rayPlaceFrom(midShPx, midShPy, W_hipC,  mLen.spineH,  midShZ,      hipZCenter);

        if (valid(11) && valid(12)) {
            // kpts[11]=l_hip, kpts[12]=r_hip
            [W[11], W[12]] = pairPlace(kpts[11].px, kpts[11].py, kpts[12].px, kpts[12].py, 'hip', mLen.hipWidth, mannequinPelvis.z);
        } else if (valid(11)) {
            W[11] = rayPlaceFrom(kpts[11].px, kpts[11].py, W_hipC, mLen.hipHalf, kpts[11].z, hipZCenter);
        } else if (valid(12)) {
            W[12] = rayPlaceFrom(kpts[12].px, kpts[12].py, W_hipC, mLen.hipHalf, kpts[12].z, hipZCenter);
        }

        if (valid(5) && valid(6)) {
            // kpts[5]=l_shldr, kpts[6]=r_shldr
            [W[5], W[6]] = pairPlace(kpts[5].px, kpts[5].py, kpts[6].px, kpts[6].py, 'shldr', mLen.shdrWidth, W_midSh.z);
        } else if (valid(5)) {
            W[5] = rayPlaceFrom(kpts[5].px, kpts[5].py, W_midSh, mLen.shdrHalf, kpts[5].z, midShZ);
        } else if (valid(6)) {
            W[6] = rayPlaceFrom(kpts[6].px, kpts[6].py, W_midSh, mLen.shdrHalf, kpts[6].z, midShZ);
        }
        if (valid(7) && W[5]) W[7]  = rayPlaceFrom(kpts[7].px,  kpts[7].py,  W[5],    mLen.upperArm, kpts[7].z,  kpts[5].z);
        if (valid(8) && W[6]) W[8]  = rayPlaceFrom(kpts[8].px,  kpts[8].py,  W[6],    mLen.upperArm, kpts[8].z,  kpts[6].z);

        const lwZRaw = valid(91)  ? kpts[91].z  : (valid(9)  ? kpts[9].z  : null);
        const rwZRaw = valid(112) ? kpts[112].z : (valid(10) ? kpts[10].z : null);
        if (valid(9)  && W[7] && lwZRaw != null) W[9]  = rayPlaceFrom(kpts[9].px,  kpts[9].py,  W[7], mLen.foreArm, lwZRaw,  kpts[7].z);
        if (valid(10) && W[8] && rwZRaw != null) W[10] = rayPlaceFrom(kpts[10].px, kpts[10].py, W[8], mLen.foreArm, rwZRaw,  kpts[8].z);

        if (valid(0))         W[0]  = rayPlaceFrom(kpts[0].px,  kpts[0].py,  W_midSh, mLen.neck,     kpts[0].z,  midShZ);
        if (valid(1) && W[0]) W[1]  = rayPlaceFrom(kpts[1].px,  kpts[1].py,  W[0],    mLen.noseToEye, kpts[1].z, kpts[0].z);
        if (valid(2) && W[0]) W[2]  = rayPlaceFrom(kpts[2].px,  kpts[2].py,  W[0],    mLen.noseToEye, kpts[2].z, kpts[0].z);
        if (valid(3) && W[0]) W[3]  = rayPlaceFrom(kpts[3].px,  kpts[3].py,  W[0],    mLen.noseToEar, kpts[3].z, kpts[0].z);
        if (valid(4) && W[0]) W[4]  = rayPlaceFrom(kpts[4].px,  kpts[4].py,  W[0],    mLen.noseToEar, kpts[4].z, kpts[0].z);

        if (valid(13) && W[11]) W[13] = rayPlaceFrom(kpts[13].px, kpts[13].py, W[11], mLen.thigh, kpts[13].z, kpts[11].z);
        if (valid(14) && W[12]) W[14] = rayPlaceFrom(kpts[14].px, kpts[14].py, W[12], mLen.thigh, kpts[14].z, kpts[12].z);
        if (valid(15) && W[13]) W[15] = rayPlaceFrom(kpts[15].px, kpts[15].py, W[13], mLen.calf,  kpts[15].z, kpts[13].z);
        if (valid(16) && W[14]) W[16] = rayPlaceFrom(kpts[16].px, kpts[16].py, W[14], mLen.calf,  kpts[16].z, kpts[14].z);

        // Face mesh [23-90] — from nose, bone = faceRadius
        for (let i = 23; i <= 90; i++) {
            if (valid(i) && W[0]) W[i] = rayPlaceFrom(kpts[i].px, kpts[i].py, W[0], mLen.faceRadius, kpts[i].z, kpts[0].z);
        }

        // Hand wrist joints — root of finger chains (W[91]=lh_wrist, W[112]=rh_wrist)
        if (valid(91)  && W[7])  W[91]  = rayPlaceFrom(kpts[91].px,  kpts[91].py,  W[7],  mLen.foreArm, kpts[91].z,  kpts[7].z);
        else if (W[9])           W[91]  = W[9].clone();
        if (valid(112) && W[8])  W[112] = rayPlaceFrom(kpts[112].px, kpts[112].py, W[8],  mLen.foreArm, kpts[112].z, kpts[8].z);
        else if (W[10])          W[112] = W[10].clone();

        // Hand finger chains — per segment, per finger
        const HAND_CHAINS = [
            [0,  1,  2,  3,  4],
            [0,  5,  6,  7,  8],
            [0,  9, 10, 11, 12],
            [0, 13, 14, 15, 16],
            [0, 17, 18, 19, 20],
        ];
        const HAND_SEG_LENS = [
            [mLen.thumbMeta, mLen.thumbProx, mLen.thumbMid,  mLen.thumbDist],
            [mLen.handMeta,  mLen.fingerProx, mLen.fingerMid, mLen.fingerDist],
            [mLen.handMeta,  mLen.fingerProx, mLen.fingerMid, mLen.fingerDist],
            [mLen.handMeta,  mLen.fingerProx, mLen.fingerMid, mLen.fingerDist],
            [mLen.handMeta,  mLen.fingerProx, mLen.fingerMid, mLen.fingerDist],
        ];
        for (const base of [91, 112]) {
            for (let fi = 0; fi < HAND_CHAINS.length; fi++) {
                const offsets = HAND_CHAINS[fi];
                const lens    = HAND_SEG_LENS[fi];
                for (let j = 1; j < offsets.length; j++) {
                    const pIdx = base + offsets[j-1];
                    const cIdx = base + offsets[j];
                    if (!W[pIdx] || !valid(cIdx)) continue;
                    W[cIdx] = rayPlaceFrom(kpts[cIdx].px, kpts[cIdx].py, W[pIdx], lens[j-1], kpts[cIdx].z, kpts[pIdx].z);
                }
            }
        }

        // Feet [17-22] — from ankle
        const FOOT_JOINTS = [
            [15, 17, mLen.ankleToToe],      [15, 18, mLen.ankleToSmallToe], [15, 19, mLen.ankleToHeel],
            [16, 20, mLen.ankleToToe],      [16, 21, mLen.ankleToSmallToe], [16, 22, mLen.ankleToHeel],
        ];
        for (const [aIdx, tIdx, bLen] of FOOT_JOINTS) {
            if (!W[aIdx] || !valid(tIdx)) continue;
            W[tIdx] = rayPlaceFrom(kpts[tIdx].px, kpts[tIdx].py, W[aIdx], bLen, kpts[tIdx].z, kpts[aIdx].z);
        }

        // ── Bone radii (world-space, proportional to figure height) ───────────
        const bR = {
            body:  Math.max(0.001, targetHeight * 0.005),
            feet:  Math.max(0.002, targetHeight * 0.008),
            face:  Math.max(0.0003, targetHeight * 0.001),
            hand:  Math.max(0.002, targetHeight * 0.005),
            jBody: Math.max(0.001, targetHeight * 0.006),
            jFeet: Math.max(0.002, targetHeight * 0.010),
            jHand: Math.max(0.002, targetHeight * 0.007),
        };

        // ── Debug log ─────────────────────────────────────────────────────────
        const dbg = [];
        const f3  = (v) => (v != null ? Number(v).toFixed(3) : 'null');
        const fv  = (v) => v ? `(${f3(v.x)}, ${f3(v.y)}, ${f3(v.z)})` : '(invalid)';

        dbg.push('=== RTMW3D Import (world-space architecture) ===');
        dbg.push(`Image       : ${imageW} × ${imageH}`);
        dbg.push(`Valid body  : ${kpts.slice(0,17).filter(k=>k?.valid).length} / 17`);
        dbg.push('');
        dbg.push('--- Scale ---');
        dbg.push(`Mannequin height   : ${f3(targetHeight)}`);
        dbg.push(`Mannequin pelvis   : ${fv(mannequinPelvis)}`);
        dbg.push(`Scale reference    : ${scaleRef}`);
        dbg.push(`Hip source         : ${hipSrcNote}`);
        dbg.push(`Hip centre (px,py) : (${f3(cx)}, ${f3(cy)})`);
        const bodyPxSpan = (noseY != null && ankY != null) ? ankY - noseY : null;
        dbg.push(`nose-ankle px span : ${bodyPxSpan != null ? f3(bodyPxSpan) : 'n/a'}  [nose py=${f3(noseY)}, ank py=${f3(ankY)}]`);
        dbg.push(`shldr-hip px span  : ${(shPy != null && hipPy != null) ? f3(hipPy - shPy) : 'n/a'}`);
        dbg.push(`shldr width (px)   : ${shW != null ? f3(shW) : 'n/a'}   ear width (px): ${earW != null ? f3(earW) : 'n/a'}`);
        dbg.push(`px → world scale   : ${scale.toFixed(6)} u/px  (body height px: ${f3(bhPx)})`);
        dbg.push('');
        dbg.push('--- Camera Estimation ---');
        dbg.push(`cam FOV/aspect     : ${f3(this.camera.fov)}° / ${f3(camAsp)}`);
        dbg.push(`tanH               : ${f3(tanH)}`);
        dbg.push(`d_est (cam dist)   : ${f3(d_est)}  world units from pelvis`);
        dbg.push(`hip NDC            : (${f3(ndcHipX)}, ${f3(ndcHipY)})`);
        dbg.push(`estimated cam pos  : ${fv(estCamPos)}`);
        dbg.push('');
        dbg.push('--- Z (Pythagoras from bone lengths) ---');
        dbg.push(`Body Z raw range   : ${f3(zMin_r)} → ${f3(zMax_r)}  (span ${f3(zMax_r - zMin_r)})`);
        dbg.push(`Hip Z center       : ${f3(hipZCenter)}`);
        dbg.push(`zNS (secondary)    : ${f3(zNS)}  (face/hands/feet only)`);
        dbg.push(`mid-shoulder world : ${fv(W_midSh)}`);
        dbg.push('');
        dbg.push('--- Pair placement ---');
        if (this._rtmwCalLog && this._rtmwCalLog.length) {
            this._rtmwCalLog.forEach(l => dbg.push(l));
        }
        dbg.push('');

        const BODY_NAMES = ['nose','l_eye','r_eye','l_ear','r_ear',
                            'l_shldr','r_shldr','l_elbow','r_elbow',
                            'l_wrist','r_wrist','l_hip','r_hip',
                            'l_knee','r_knee','l_ankle','r_ankle'];
        dbg.push('--- Mannequin Bone Lengths ---');
        dbg.push(`spineH (pelvis→mid-shldr): ${f3(mLen.spineH)}`);
        dbg.push(`shdrHalf (mid→upperarm)  : ${f3(mLen.shdrHalf)}  shdrWidth (full): ${f3(mLen.shdrWidth)}`);
        dbg.push(`upperArm                 : ${f3(mLen.upperArm)}`);
        dbg.push(`foreArm                  : ${f3(mLen.foreArm)}`);
        dbg.push(`neck (mid-shldr→head)    : ${f3(mLen.neck)}`);
        dbg.push(`hipHalf (pelvis→thigh)   : ${f3(mLen.hipHalf)}  hipWidth (full):  ${f3(mLen.hipWidth)}`);
        dbg.push(`thigh                    : ${f3(mLen.thigh)}`);
        dbg.push(`calf                     : ${f3(mLen.calf)}`);
        dbg.push('');
        dbg.push('--- Body Keypoints (px / py / z_raw → World XYZ) ---');
        for (let i = 0; i < 17; i++) {
            const k = kpts[i];
            const tag = k?.valid ? '' : ' ✗';
            const raw = k ? `px=${f3(k.px)} py=${f3(k.py)} z=${f3(k.z)}` : 'no data';
            dbg.push(`[${String(i).padStart(2)}] ${BODY_NAMES[i].padEnd(10)} ${raw}  →  ${fv(W[i])}${tag}`);
        }
        dbg.push('');

        const FITTING_BONES = [
            'head','neck_01','spine_01','spine_02','spine_03',
            'upperarm_l','lowerarm_l','hand_l',
            'upperarm_r','lowerarm_r','hand_r',
            'thigh_l','calf_l','foot_l',
            'thigh_r','calf_r','foot_r',
        ];
        dbg.push('--- Mannequin Bones (World XYZ) ---');
        if (this.bones) {
            for (const bn of FITTING_BONES) {
                const b = this.bones[bn];
                if (b) {
                    const p = new THREE.Vector3();
                    b.getWorldPosition(p);
                    dbg.push(`${bn.padEnd(14)}: ${fv(p)}`);
                } else {
                    dbg.push(`${bn.padEnd(14)}: [not found]`);
                }
            }
        } else {
            dbg.push('(no bones loaded)');
        }
        const _rtmwDebugStr = dbg.join('\n');
        // ── End debug log ─────────────────────────────────────────────────────

        // ── Build figure geometry ─────────────────────────────────────────────
        const group = new THREE.Group();
        group.name = 'rtmwFigure';

        const M = {
            body:  new THREE.MeshLambertMaterial({ color: 0xcccccc }),
            left:  new THREE.MeshLambertMaterial({ color: 0x4488ff }),
            right: new THREE.MeshLambertMaterial({ color: 0xff4444 }),
            face:  new THREE.MeshLambertMaterial({ color: 0xffdd00 }),
            feet:  new THREE.MeshLambertMaterial({ color: 0xff8800 }),
            lhand: new THREE.MeshLambertMaterial({ color: 0x66bbff }),
            rhand: new THREE.MeshLambertMaterial({ color: 0xff6666 }),
        };

        const addBone = (a, b, mat, r = 0.02) => {
            if (!a || !b) return;
            const dir = new THREE.Vector3().subVectors(b, a);
            const len = dir.length();
            if (len < 1e-4) return;
            const geo = new THREE.CylinderGeometry(r, r, len, 6);
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.addVectors(a, b).multiplyScalar(0.5);
            mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.divideScalar(len));
            group.add(mesh);
        };

        const addJoint = (pos, mat, r = 0.025, kpIdx = -1) => {
            if (!pos) return;
            const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), mat);
            mesh.position.copy(pos);
            mesh.userData.isRTMWJoint = true;
            mesh.userData.rtmwKpIndex = kpIdx;
            group.add(mesh);
        };

        // Body (0–16)
        [[0,1,M.body],[0,2,M.body],[1,3,M.left],[2,4,M.right],
         [5,6,M.body],[5,7,M.left],[7,9,M.left],[6,8,M.right],[8,10,M.right],
         [5,11,M.left],[6,12,M.right],[11,12,M.body],
         [11,13,M.left],[13,15,M.left],[12,14,M.right],[14,16,M.right]]
            .forEach(([a,b,m]) => addBone(W[a], W[b], m, bR.body));

        // Feet (17–22)
        [[15,17,M.left],[15,18,M.left],[17,19,M.feet],[18,19,M.feet],
         [16,20,M.right],[16,21,M.right],[20,22,M.feet],[21,22,M.feet]]
            .forEach(([a,b,m]) => addBone(W[a], W[b], m, bR.feet));

        // Face (23–90) — skip entirely if face data is insufficient
        const validFaceCount = kpts.slice(23, 91).filter(k => k?.valid).length;
        if (validFaceCount >= 20) {
            for (let i = 0; i < 16; i++) addBone(W[23+i], W[24+i], M.face, bR.face);
            for (let i = 0; i < 4;  i++) addBone(W[40+i], W[41+i], M.face, bR.face);
            for (let i = 0; i < 4;  i++) addBone(W[45+i], W[46+i], M.face, bR.face);
            for (let i = 0; i < 3;  i++) addBone(W[50+i], W[51+i], M.face, bR.face);
            for (let i = 0; i < 4;  i++) addBone(W[54+i], W[55+i], M.face, bR.face);
            addBone(W[53], W[56], M.face, bR.face);
            for (let i = 0; i < 5;  i++) addBone(W[59+i], W[60+i], M.face, bR.face);
            addBone(W[64], W[59], M.face, bR.face);
            for (let i = 0; i < 5;  i++) addBone(W[65+i], W[66+i], M.face, bR.face);
            addBone(W[70], W[65], M.face, bR.face);
            for (let i = 0; i < 11; i++) addBone(W[71+i], W[72+i], M.face, bR.face);
            addBone(W[82], W[71], M.face, bR.face);
        }

        // Left hand (91–111)
        [[9,91],[91,92],[92,93],[93,94],[94,95],
         [91,96],[96,97],[97,98],[98,99],
         [91,100],[100,101],[101,102],[102,103],
         [91,104],[104,105],[105,106],[106,107],
         [91,108],[108,109],[109,110],[110,111]]
            .forEach(([a,b]) => addBone(W[a], W[b], M.lhand, bR.hand));

        // Right hand (112–132)
        [[10,112],[112,113],[113,114],[114,115],[115,116],
         [112,117],[117,118],[118,119],[119,120],
         [112,121],[121,122],[122,123],[123,124],
         [112,125],[125,126],[126,127],[127,128],
         [112,129],[129,130],[130,131],[131,132]]
            .forEach(([a,b]) => addBone(W[a], W[b], M.rhand, bR.hand));

        // Joint spheres
        const BM = [M.body,M.left,M.right,M.left,M.right,
                    M.left,M.right,M.left,M.right,M.left,M.right,
                    M.left,M.right,M.left,M.right,M.left,M.right];
        for (let i = 0;   i <= 16;  i++) addJoint(W[i], BM[i],   bR.jBody, i);
        for (let i = 17;  i <= 19;  i++) addJoint(W[i], M.left,  bR.jFeet, i);
        for (let i = 20;  i <= 22;  i++) addJoint(W[i], M.right, bR.jFeet, i);
        for (let i = 91;  i <= 111; i++) addJoint(W[i], M.lhand, bR.jHand, i);
        for (let i = 112; i <= 132; i++) addJoint(W[i], M.rhand, bR.jHand, i);

        // ── Step 1: place figure in world space ───────────────────────────────
        this.scene.add(group);
        this._rtmwFigureGroup = group;

        // Save W[] and key positions for fitMannequinToRTMW()
        this._rtmwW       = W;
        this._rtmwWHipC   = W_hipC.clone();
        this._rtmwWMidSh  = W_midSh.clone();

        // ── Step 2: move camera to estimated position ─────────────────────────
        // orbit.target = world position of the image center (not pelvis).
        // This makes the camera look straight forward so the 2D canvas maps
        // correctly to the viewport — no tilt introduced by pelvis offset.
        const imageCenterWorld = new THREE.Vector3(
            mannequinPelvis.x + (imageW / 2 - cx) * scale,
            mannequinPelvis.y + (cy - imageH / 2) * scale,
            mannequinPelvis.z
        );
        this.camera.position.copy(estCamPos);
        this.orbit.target.copy(imageCenterWorld);
        this.orbit.update();

        // ── Step 2b: frustum wireframe — js側の _updateFrustumToCurrentCamera() に一本化 ──
        if (this._rtmwFrustumGroup) {
            this.scene.remove(this._rtmwFrustumGroup);
            this._rtmwFrustumGroup.traverse(o => {
                if (o.geometry) o.geometry.dispose();
                if (o.material) o.material.dispose();
            });
            this._rtmwFrustumGroup = null;
        }

        // ── Step 3: save camera state (first load only) ───────────────────────
        if (isFirstLoad) this.saveRTMWCameraState();

        // ── Step 4: optionally parent figure to camera ────────────────────────
        // camera.attach() preserves world transform when re-parenting.
        if (this._rtmwCameraParented !== false) {
            this.camera.attach(group);
        }

        this.requestRender();
        return _rtmwDebugStr;
    }
///////////////////////////////////////////////////////////////////////////////////////////////////
    /**
     * HMR2 v1 棒人形（drawHMR2v1Figureで描画済み）にマネキンをフィットさせる。
     *
     * アプローチ：
     *  1. Tポーズにリセット
     *  2. pelvisボーンをHMR2 pelvisワールド座標に平行移動
     *  3. spine → 四肢 の順でFK適用（ボーン方向ベクトル一致）
     *  4. IKエフェクターを更新
     *
     * 「少し動く」原因だった fitMannequinToRTMW の _rtmwW 依存を解消し、
     * HMR2専用 worldKps (_hmr2WorldKps) を使う。
     */
    fitMannequinToHMR2(shoulderYOffset = 0) {
        if (!this._hmr2WorldKps || !this.bones) {
            console.warn('[VNCCS] fitMannequinToHMR2: no HMR2 data. drawHMR2v1Figure を先に呼ぶ必要があります');
            return;
        }

        const THREE = this.THREE;
        const W = this._hmr2WorldKps;  // { 'nose': Vector3, 'neck': Vector3, ... }

        // ── Tポーズにリセット ─────────────────────────────────────────────────
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

        // ── pelvis: 位置 + 回転を設定 ────────────────────────────────────────
        // 位置: HMR2のpelvisワールド座標に移動
        // 回転: right_hip→left_hip（骨盤横軸）と pelvis→neck（縦軸）の2軸から決定
        const pelvisBone = this.bones['pelvis'] || this.bones['spine_01'];
        if (pelvisBone && W['pelvis']) {
            // --- 位置 ---
            const localTarget = W['pelvis'].clone();
            if (pelvisBone.parent) {
                pelvisBone.parent.worldToLocal(localTarget);
            }
            pelvisBone.position.copy(localTarget);
            this.skinnedMesh.updateMatrixWorld(true);

            // --- 回転 ---
            // 骨盤の座標系を3軸で定義:
            //   right:   right_hip → left_hip (骨盤横軸)
            //   up:      pelvis と neck の差から「上」方向を決定
            //   forward: right × up の外積 (前方)
            //
            // NOTE: toWorld()のY反転の結果、Three.js空間でneck.y と pelvis.y の
            // 大小関係がSMPL生座標と逆になる場合がある。
            // 「マネキンのpelvisより高い側が上」という事実から自動判定する。
            const rHip = W['right_hip'];
            const lHip = W['left_hip'];
            const neck = W['neck'];
            if (rHip && lHip && neck) {
                // 骨盤横軸: right_hip → left_hip
                const pelvisRight = new THREE.Vector3()
                    .subVectors(lHip, rHip).normalize();

                // 縦軸: neckとpelvisのどちらがThree.js Y空間で「上」か実測して決定
                // mannequinPelvisより上にあるのがneckのはずなので：
                // neck.y > pelvis.y なら pelvis→neck が上、逆なら neck→pelvis が上
                const neckTowardUp = new THREE.Vector3().subVectors(neck, W['pelvis']);
                // もしY成分が負なら反転（棒人形がちゃんと立っている方向に合わせる）
                if (neckTowardUp.y < 0) neckTowardUp.negate();
                const pelvisUp = neckTowardUp.normalize();
                // right成分を除去してorthogonal化
                pelvisUp.sub(
                    pelvisRight.clone().multiplyScalar(pelvisUp.dot(pelvisRight))
                ).normalize();

                // forward = right × up
                const pelvisForward = new THREE.Vector3()
                    .crossVectors(pelvisRight, pelvisUp).normalize();

                // 3軸から回転行列 → クォータニオン
                const rotMat = new THREE.Matrix4().makeBasis(pelvisRight, pelvisUp, pelvisForward);
                const worldQ = new THREE.Quaternion().setFromRotationMatrix(rotMat);

                // ワールドQ → ローカルQ
                const parentWorldQ = new THREE.Quaternion();
                if (pelvisBone.parent) pelvisBone.parent.getWorldQuaternion(parentWorldQ);
                pelvisBone.quaternion.copy(parentWorldQ.clone().invert().multiply(worldQ));
                pelvisBone.rotation.setFromQuaternion(pelvisBone.quaternion, pelvisBone.rotation.order);
                this.skinnedMesh.updateMatrixWorld(true);
            }
        }

        // ── FKヘルパー: ボーン方向を parent→child ベクトルに合わせる ─────────
        // currentDir = Tポーズ時の「このボーン → 子ボーン」ワールドベクトル
        // targetDir  = HMR2 worldKps の parent→child ワールドベクトル
        // deltaQ で worldQ を回転 → parentQ の逆行列でローカルQに変換
        const BONE_CHILD_BONE = {
            'spine_01':  'spine_02',
            'spine_02':  'spine_03',
            'spine_03':  'neck_01',
            'neck_01':   'head',
            'clavicle_r':'upperarm_r',
            'clavicle_l':'upperarm_l',
            'upperarm_r':'lowerarm_r',
            'lowerarm_r':'hand_r',
            'upperarm_l':'lowerarm_l',
            'lowerarm_l':'hand_l',
            'thigh_r':   'calf_r',
            'calf_r':    'foot_r',
            'thigh_l':   'calf_l',
            'calf_l':    'foot_l',
        };

        const applyFK = (boneName, parentKpName, childKpName) => {
            const pW = W[parentKpName];
            const cW = W[childKpName];
            if (!pW || !cW) return;

            const bone = this.bones[boneName];
            if (!bone) return;

            // 目標方向ベクトル
            const targetDir = new THREE.Vector3().subVectors(cW, pW).normalize();
            if (targetDir.lengthSq() < 0.001) return;

            // 現在のボーン方向（Tポーズ時: このボーン→子ボーンのワールドベクトル）
            const childBoneName = BONE_CHILD_BONE[boneName];
            const childBone = childBoneName ? this.bones[childBoneName] : null;
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

            // currentDir → targetDir の最短回転クォータニオン（ワールド空間）
            const boneWorldQ = new THREE.Quaternion();
            bone.getWorldQuaternion(boneWorldQ);
            const deltaQ = new THREE.Quaternion().setFromUnitVectors(currentDir, targetDir);
            const newWorldQ = deltaQ.multiply(boneWorldQ);

            // ワールドQ → ローカルQ
            const parentWorldQ = new THREE.Quaternion();
            if (bone.parent) bone.parent.getWorldQuaternion(parentWorldQ);
            bone.quaternion.copy(parentWorldQ.clone().invert().multiply(newWorldQ));
            bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
            this.skinnedMesh.updateMatrixWorld(true);
        };

        // ── FK適用順: 体幹から末端へ ─────────────────────────────────────────
        // OpenPose25点名: pelvis=8相当, neck=1, nose=0
        // right_shoulder=2, right_elbow=3, right_wrist=4
        // left_shoulder=5,  left_elbow=6,  left_wrist=7
        // right_hip=9,  right_knee=10, right_ankle=11
        // left_hip=12, left_knee=13,  left_ankle=14

        // 体幹 (pelvis → neck の3分割でspine_01〜03を向かせる)
        if (W['pelvis'] && W['neck']) {
            const p = W['pelvis'];
            const n = W['neck'];
            W['_s1'] = p.clone().lerp(n, 1/3);  // spine_01の先端
            W['_s2'] = p.clone().lerp(n, 2/3);  // spine_02の先端
            applyFK('spine_01', 'pelvis', '_s1');
            applyFK('spine_02', '_s1',    '_s2');
            applyFK('spine_03', '_s2',    'neck');
        }

        // 首・頭
        // neck_01: neck → 両耳の中間
        // head:    両耳の中間 → nose
        const rEar = W['right_ear'];
        const lEar = W['left_ear'];
        if (rEar && lEar) {
            W['_earMid'] = new THREE.Vector3(
                (rEar.x + lEar.x) / 2,
                (rEar.y + lEar.y) / 2,
                (rEar.z + lEar.z) / 2
            );
        }
        if (W['_earMid']) {
            applyFK('neck_01', 'neck', '_earMid');
            if (W['nose']) {
                applyFK('head', '_earMid', 'nose');
            }
        } else {
            // 耳が見えない場合はnoseにフォールバック
            applyFK('neck_01', 'neck', 'nose');
        }

        // 肩Y補正: マネキンフィット時のみ適用（棒人形には影響しない）
        if (shoulderYOffset !== 0) {
            if (W['right_shoulder']) W['right_shoulder'] = W['right_shoulder'].clone().setY(W['right_shoulder'].y + shoulderYOffset);
            if (W['left_shoulder'])  W['left_shoulder']  = W['left_shoulder'].clone().setY(W['left_shoulder'].y  + shoulderYOffset);
        }

        // 肩（鎖骨）: neck → shoulder
        applyFK('clavicle_r', 'neck', 'right_shoulder');
        applyFK('clavicle_l', 'neck', 'left_shoulder');

        // 腕
        applyFK('upperarm_r', 'right_shoulder', 'right_elbow');
        applyFK('lowerarm_r', 'right_elbow',    'right_wrist');
        applyFK('upperarm_l', 'left_shoulder',  'left_elbow');
        applyFK('lowerarm_l', 'left_elbow',     'left_wrist');

        // 脚
        applyFK('thigh_r', 'right_hip',  'right_knee');
        applyFK('calf_r',  'right_knee', 'right_ankle');
        applyFK('thigh_l', 'left_hip',   'left_knee');
        applyFK('calf_l',  'left_knee',  'left_ankle');

        // ── IK仕上げ: hand/foot を HMR2 wrist/ankle に引き寄せる ────────────
        const ikFinish = [
            { chainKey: 'rightArm', target: W['right_wrist'] },
            { chainKey: 'leftArm',  target: W['left_wrist']  },
            { chainKey: 'rightLeg', target: W['right_ankle'] },
            { chainKey: 'leftLeg',  target: W['left_ankle']  },
        ];
        for (const { chainKey, target } of ikFinish) {
            if (!target) continue;
            const chainDef = IK_CHAINS[chainKey];
            if (!chainDef) continue;
            this.ikController.solveWithPole(chainDef, this.bones, target, chainKey);
            this.skinnedMesh.updateMatrixWorld(true);
        }

        // ── 後処理 ────────────────────────────────────────────────────────────
        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
        this.updateMarkers();
        this.updateIKEffectorPositions();
        this.requestRender();
        this.dispatchPoseChange();
    }

///////////////////////////////////////////////////////////////////////////////////////////////////
    fitMannequinToRTMW() {
        if (!this._rtmwW || !this.bones || !this.ikController) return;

        const THREE = this.THREE;
        const W = this._rtmwW;

        // ── Helper: IKチェーンをポール直接指定で解く ─────────────────────────
        // solveWithPoleはpoleModes/modesの状態に依存するため、
        // ccdSolver.solveに直接poleTargetを渡す
        const solveChain = (chainKey, targetPos, polePos = null) => {
            const chainDef = IK_CHAINS[chainKey];
            if (!chainDef || !this.ikController.ccdSolver) return;
            this.ikController.ccdSolver.solve(chainDef, this.bones, targetPos, polePos);
        };

        // ── 1. Hips (root translate) ──────────────────────────────────────────
        const hipBone = this.bones['pelvis'] || this.bones['spine_01'];
        if (hipBone && this._rtmwWHipC) {
            const localTarget = this._rtmwWHipC.clone();
            if (hipBone.parent) hipBone.parent.worldToLocal(localTarget);
            hipBone.position.copy(localTarget);
            hipBone.updateMatrixWorld(true);
        }

        // ── 2. Spine → head ──────────────────────────────────────────────────
        if (W[0]) {
            solveChain('spine', W[0]);
        }

        // ── 3. Left arm (shoulder → elbow → wrist) ───────────────────────────
        if (W[9]) {
            solveChain('leftArm',  W[9],  W[7]);   // hand_l target, elbow pole
        }

        // ── 4. Right arm ──────────────────────────────────────────────────────
        if (W[10]) {
            solveChain('rightArm', W[10], W[8]);   // hand_r target, elbow pole
        }

        // ── 5. Left leg (hip → knee → ankle) ─────────────────────────────────
        if (W[15]) {
            solveChain('leftLeg',  W[15], W[13]);  // foot_l target, knee pole
        }

        // ── 6. Right leg ──────────────────────────────────────────────────────
        if (W[16]) {
            solveChain('rightLeg', W[16], W[14]);  // foot_r target, knee pole
        }

        // ── Update skeleton and render ────────────────────────────────────────
        if (this.skeleton) this.skeleton.update();
        if (this.skinnedMesh) this.skinnedMesh.updateMatrixWorld(true);
        this.updateIKEffectorPositions();
        this.requestRender();
    }

///////////////////////////////////////////////////////////////////////////////////////////////////
    saveRTMWCameraState() {
        if (!this.camera || !this.orbit) return;
        this._rtmwSavedCamera = {
            position: this.camera.position.clone(),
            quaternion: this.camera.quaternion.clone(),
            target:   this.orbit.target.clone(),
            fov:      this.camera.fov,
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
///////////////////////////////////////////////////////////////////////////////////////////////////
    setRTMWFigureCameraParented(parented) {
        this._rtmwCameraParented = parented;
        if (!this._rtmwFigureGroup) return;
        if (parented) {
            // Re-attach to camera, preserving world transform
            this.camera.attach(this._rtmwFigureGroup);
        } else {
            // Move to world space, preserving world transform
            this.scene.attach(this._rtmwFigureGroup);
        }
        this.requestRender();
    }
///////////////////////////////////////////////////////////////////////////////////////////////////
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

    setMannequinVisible(visible) {
        this._mannequinVisible = visible;
        if (this.skinnedMesh) this.skinnedMesh.visible = visible;
        if (this.skeletonHelper) this.skeletonHelper.visible = visible;
        if (this.jointMarkers) this.jointMarkers.forEach(m => { m.visible = visible; });
        this.requestRender();
    }

    moveBoneToPosition(boneName, x, y, z) {
        const bone = this.boneList.find(b => b.name === boneName);
        if (!bone) {
            console.warn('[VNCCS] Bone not found:', boneName);
            return false;
        }
        // Convert world position to parent local position
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
        this._rtmwFigureGroup.traverse(obj => {
            if (!found && obj.userData.isRTMWJoint &&
                this._getRTMWKpName(obj.userData.rtmwKpIndex) === kpName)
                found = obj;
        });
        return found;
    }

    getRTMWJointWorldPos(kpName) {
        const mesh = this._findRTMWJointMesh(kpName);
        if (!mesh) return null;
        const wp = new this.THREE.Vector3();
        mesh.getWorldPosition(wp);
        return wp;
    }

    moveRTMWJoint(kpName, x, y, z) {
        const mesh = this._findRTMWJointMesh(kpName);
        if (!mesh) return false;
        const worldPos = new this.THREE.Vector3(x, y, z);
        if (mesh.parent) {
            const parentWorldInv = new this.THREE.Matrix4()
                .copy(mesh.parent.matrixWorld).invert();
            worldPos.applyMatrix4(parentWorldInv);
        }
        mesh.position.copy(worldPos);
        this.requestRender();
        return true;
    }

    getBoneDebugInfo() {
        if (!this._lastBoneDebug) return "{}";
        const result = {};
        for (const [bname, dirs] of Object.entries(this._lastBoneDebug)) {
            result[bname] = {};
            for (const [axis, v] of Object.entries(dirs)) {
                result[bname][axis] = [
                    parseFloat(v.x.toFixed(3)),
                    parseFloat(v.y.toFixed(3)),
                    parseFloat(v.z.toFixed(3))
                ];
            }
        }
        return JSON.stringify(result, null, 2);
    }

    /**
     * Apply a hand pose preset to left, right, or both hands.
     * @param {string} side - 'l', 'r', or 'both'
     * @param {Object} presetData - { bone_suffix: [x, y, z, w] quaternion }
     */
    interpolateFingerPoseOffset(poseA, poseB, t, side, fingerPrefix) {
        // Apply the rotation delta (poseA→poseB at t) on top of current bone rotation
        if (!this.boneList) return;
        const dataA = side === 'r' ? poseA.preset_r : poseA.preset_l;
        const dataB = side === 'r' ? poseB.preset_r : poseB.preset_l;
        if (!dataA || !dataB) return;

        const THREE = this.THREE;
        const qa = new THREE.Quaternion();
        const qb = new THREE.Quaternion();
        const qTarget = new THREE.Quaternion();
        const qDelta = new THREE.Quaternion();

        for (const seg of ['01', '02', '03']) {
            const bone = this.bones[`${fingerPrefix}_${seg}_${side}`];
            if (!bone) continue;
            const a = dataA[`${fingerPrefix}_${seg}`];
            const b = dataB[`${fingerPrefix}_${seg}`];
            if (!a || !b) continue;

            // Compute target rotation at t
            qa.set(a[0], a[1], a[2], a[3]);
            qb.set(b[0], b[1], b[2], b[3]);
            qTarget.slerpQuaternions(qa, qb, t);

            // Delta = inv(poseA) * target
            qDelta.copy(qa).invert().multiply(qTarget);

            // Apply delta on top of current rotation
            bone.quaternion.multiply(qDelta);
            bone.quaternion.normalize();
            bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
            bone.updateMatrixWorld(true);
        }

        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
        this.updateMarkers();
        this.requestRender();
    }

    interpolateHandSpread(poseA, poseB, t, side) {
        // Only interpolate _01 bones (base joints) for spread control
        if (!this.boneList) return;
        const dataA = side === 'r' ? poseA.preset_r : poseA.preset_l;
        const dataB = side === 'r' ? poseB.preset_r : poseB.preset_l;
        if (!dataA || !dataB) return;

        const THREE = this.THREE;
        const qa = new THREE.Quaternion();
        const qb = new THREE.Quaternion();
        const FINGER_PREFIXES = ['thumb', 'index', 'middle', 'ring', 'pinky'];

        for (const prefix of FINGER_PREFIXES) {
            const bone = this.bones[`${prefix}_01_${side}`];
            if (!bone) continue;
            const a = dataA[`${prefix}_01`];
            const b = dataB[`${prefix}_01`];
            if (!a || !b) continue;
            qa.set(a[0], a[1], a[2], a[3]);
            qb.set(b[0], b[1], b[2], b[3]);
            bone.quaternion.slerpQuaternions(qa, qb, t);
            bone.quaternion.normalize();
            bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
            bone.updateMatrixWorld(true);
        }

        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
        this.updateMarkers();
        this.requestRender();
    }

    interpolateFingerPose(poseA, poseB, t, side, fingerPrefix, bias = [1, 1, 1]) {
        if (!this.boneList) return;
        const dataA = side === 'r' ? poseA.preset_r : poseA.preset_l;
        const dataB = side === 'r' ? poseB.preset_r : poseB.preset_l;
        if (!dataA || !dataB) return;

        const THREE = this.THREE;
        const qa = new THREE.Quaternion();
        const qb = new THREE.Quaternion();

        for (const [i, seg] of ['01', '02', '03'].entries()) {
            const bone = this.bones[`${fingerPrefix}_${seg}_${side}`];
            if (!bone) continue;
            const a = dataA[`${fingerPrefix}_${seg}`];
            const b = dataB[`${fingerPrefix}_${seg}`];
            if (!a || !b) continue;
            qa.set(a[0], a[1], a[2], a[3]);
            qb.set(b[0], b[1], b[2], b[3]);
            bone.quaternion.slerpQuaternions(qa, qb, Math.min(1.2, Math.max(-0.2, t * bias[i])));
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
        // Slerp between two hand presets (t: 0=poseA, 1=poseB)
        if (!this.boneList) return;

        const dataA = side === 'r' ? poseA.preset_r : poseA.preset_l;
        const dataB = side === 'r' ? poseB.preset_r : poseB.preset_l;
        if (!dataA || !dataB) return;

        const FINGER_PREFIXES = ['thumb', 'index', 'middle', 'ring', 'pinky'];
        const SEGMENTS = ['01', '02', '03'];
        const THREE = this.THREE;

        const qa = new THREE.Quaternion();
        const qb = new THREE.Quaternion();

        for (const prefix of FINGER_PREFIXES) {
            for (const seg of SEGMENTS) {
                const bone = this.bones[`${prefix}_${seg}_${side}`];
                if (!bone) continue;
                const a = dataA[`${prefix}_${seg}`];
                const b = dataB[`${prefix}_${seg}`];
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

        const FINGER_PREFIXES = ['thumb', 'index', 'middle', 'ring', 'pinky'];
        const SEGMENTS = ['01', '02', '03'];

        const applySide = (s, data) => {
            if (!data) return;
            for (const prefix of FINGER_PREFIXES) {
                for (const seg of SEGMENTS) {
                    const bone = this.bones[`${prefix}_${seg}_${s}`];
                    if (!bone) continue;
                    const q = data[`${prefix}_${seg}`];
                    if (!q) continue;
                    if (q.length === 3) {
                        bone.rotation.set(q[0] * Math.PI / 180, q[1] * Math.PI / 180, q[2] * Math.PI / 180);
                        bone.quaternion.setFromEuler(bone.rotation);
                    } else {
                        bone.quaternion.set(q[0], q[1], q[2], q[3]);
                        bone.quaternion.normalize();
                        bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
                    }
                    bone.updateMatrixWorld(true);
                }
            }
        };

        if (presetData.preset_l || presetData.preset_r) {
            if (side === 'both') { applySide('l', presetData.preset_l); applySide('r', presetData.preset_r); }
            else if (side === 'l') applySide('l', presetData.preset_l);
            else if (side === 'r') applySide('r', presetData.preset_r);
        } else {
            if (side === 'both') { applySide('l', presetData); applySide('r', presetData); }
            else if (side === 'l') applySide('l', presetData);
            else if (side === 'r') applySide('r', presetData);
        }

        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
        this.updateMarkers();
        this.requestRender();
    }

    saveHandSnapshot() {
        // Save only finger bone Euler rotations for lightweight snapshot
        const FINGER_PREFIXES = ['thumb', 'index', 'middle', 'ring', 'pinky'];
        const SEGMENTS = ['01', '02', '03'];
        const snap = {};
        for (const side of ['l', 'r']) {
            for (const prefix of FINGER_PREFIXES) {
                for (const seg of SEGMENTS) {
                    const bone = this.bones[`${prefix}_${seg}_${side}`];
                    if (!bone) continue;
                    snap[`${prefix}_${seg}_${side}`] = [bone.rotation.x, bone.rotation.y, bone.rotation.z];
                }
            }
        }
        this._handSnapshot = snap;
    }

    restoreHandSnapshot() {
        if (!this._handSnapshot) return;
        for (const [boneName, rot] of Object.entries(this._handSnapshot)) {
            const bone = this.bones[boneName];
            if (!bone) continue;
            bone.rotation.set(rot[0], rot[1], rot[2]);
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

        const FINGER_PREFIXES = ['thumb', 'index', 'middle', 'ring', 'pinky'];
        const SEGMENTS = ['01', '02', '03'];

        const applySide = (s, data) => {
            if (!data) return;
            for (const prefix of FINGER_PREFIXES) {
                for (const seg of SEGMENTS) {
                    const bone = this.bones[`${prefix}_${seg}_${s}`];
                    if (!bone) continue;
                    const q = data[`${prefix}_${seg}`];
                    if (!q) continue;
                    if (q.length === 3) {
                        bone.rotation.set(q[0] * Math.PI / 180, q[1] * Math.PI / 180, q[2] * Math.PI / 180);
                        bone.quaternion.setFromEuler(bone.rotation);
                    } else {
                        bone.quaternion.set(q[0], q[1], q[2], q[3]);
                        bone.quaternion.normalize();
                        bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
                    }
                    bone.updateMatrixWorld(true);
                }
            }
        };

        // New format: { preset_l, preset_r }
        // Old format: flat dict (backward compat - apply to target side directly)
        if (presetData.preset_l || presetData.preset_r) {
            if (side === 'both') { applySide('l', presetData.preset_l); applySide('r', presetData.preset_r); }
            else if (side === 'l') applySide('l', presetData.preset_l);
            else if (side === 'r') applySide('r', presetData.preset_r);
        } else {
            // Old format fallback
            if (side === 'both') { applySide('l', presetData); applySide('r', presetData); }
            else if (side === 'l') applySide('l', presetData);
            else if (side === 'r') applySide('r', presetData);
        }

        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
        this.updateMarkers();
        this.requestRender();
        this.dispatchPoseChange();
    }

    /**
     * Capture current hand pose as preset data (quaternion format).
     * Always captures from right hand as the canonical source.
     * @param {string} side - 'l' or 'r'
     * @returns {Object} presetData
     */
    captureHandPreset(side) {
        // Always capture both sides and store separately
        const captureSide = (s) => {
            const data = {};
            const FINGER_PREFIXES = ['thumb', 'index', 'middle', 'ring', 'pinky'];
            const SEGMENTS = ['01', '02', '03'];
            for (const prefix of FINGER_PREFIXES) {
                for (const seg of SEGMENTS) {
                    const bone = this.bones[`${prefix}_${seg}_${s}`];
                    if (!bone) continue;
                    const q = bone.quaternion;
                    data[`${prefix}_${seg}`] = [q.x, q.y, q.z, q.w];
                }
            }
            return data;
        };

        // Capture the requested side as canonical, mirror for the other side
        const canonical = captureSide(side);
        const mirrorData = {};
        for (const [key, q] of Object.entries(canonical)) {
            mirrorData[key] = [-q[0], q[1], q[2], -q[3]];
        }

        return {
            source_side: side,
            preset_l: side === 'l' ? canonical : mirrorData,
            preset_r: side === 'r' ? canonical : mirrorData,
        };
    }


    _getHandMarkers(side) {
        const NAMES = new Set([
            'hand_l','thumb_01_l','thumb_02_l','thumb_03_l','index_01_l','index_02_l','index_03_l',
            'middle_01_l','middle_02_l','middle_03_l','ring_01_l','ring_02_l','ring_03_l',
            'pinky_01_l','pinky_02_l','pinky_03_l',
            'hand_r','thumb_01_r','thumb_02_r','thumb_03_r','index_01_r','index_02_r','index_03_r',
            'middle_01_r','middle_02_r','middle_03_r','ring_01_r','ring_02_r','ring_03_r',
            'pinky_01_r','pinky_02_r','pinky_03_r',
        ]);
        return this.jointMarkers.filter(m => {
            const bone = this.boneList[m.userData.boneIndex];
            if (!bone || !NAMES.has(bone.name)) return false;
            if (side === 'both') return true;
            return bone.name.endsWith('_' + side);
        });
    }

    showHandHighlightRing(side) {
        this.hideHandHighlightRing();
        const THREE = this.THREE;

        const sides = side === 'both' ? ['l', 'r'] : [side];
        this._handRings = [];

        for (const s of sides) {
            const handBone = this.bones['hand_' + s];
            if (!handBone) continue;

            const centerBone = this.bones['middle_01_' + s] || handBone;
            const handPos = new THREE.Vector3();
            centerBone.getWorldPosition(handPos);

            // Find max distance from hand to fingertips
            const fingerTips = ['thumb_03', 'index_03', 'middle_03', 'ring_03', 'pinky_03'];
            let maxDist = 0.1;
            for (const tip of fingerTips) {
                const bone = this.bones[tip + '_' + s];
                if (!bone) continue;
                const p = new THREE.Vector3();
                bone.getWorldPosition(p);
                maxDist = Math.max(maxDist, handPos.distanceTo(p));
            }
            const radius = maxDist * 1.3;

            const geo = new THREE.SphereGeometry(radius, 16, 12);
            const mat = new THREE.MeshBasicMaterial({
                color: 0xff2222,
                transparent: true,
                opacity: 0.15,
                depthTest: false,
                side: THREE.FrontSide,
            });
            const sphere = new THREE.Mesh(geo, mat);
            sphere.position.copy(handPos);
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
        this._highlightedMarkers.forEach(m => {
            m.material = m.material.clone();
            m.material.color.setHex(0x00ffff);
        });
        this.requestRender();
    }

    unhighlightHandMarkers() {
        if (!this._highlightedMarkers) return;
        this._highlightedMarkers.forEach(m => {
            m.material.dispose();
            m.material = this.markerMatNormal;
        });
        this._highlightedMarkers = null;
        this.updateMarkers();
        this.requestRender();
    }

    flashHandMarkers(side) {
        this.highlightHandMarkers(side);
        setTimeout(() => this.unhighlightHandMarkers(), 400);
    }

    mirrorPose(fromSide) {
        if (!this.boneList) return;
        this.recordState();

        const SPINE_BONES = ['pelvis', 'spine_01', 'spine_02', 'spine_03'];
        const CENTER_BONES = ['neck_01', 'head'];

        // Spine: zero out Z (lateral tilt), keep X and Y
        for (const boneName of SPINE_BONES) {
            const bone = this.boneList.find(b => b.name === boneName);
            if (!bone) continue;
            const euler = new this.THREE.Euler().setFromQuaternion(bone.quaternion, 'YXZ');
            euler.z = 0;
            bone.quaternion.setFromEuler(euler);
            bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
        }

        // Neck/Head: zero out Y and Z (keep X = forward/backward tilt), position X = 0
        for (const boneName of CENTER_BONES) {
            const bone = this.boneList.find(b => b.name === boneName);
            if (!bone) continue;
            const euler = new this.THREE.Euler().setFromQuaternion(bone.quaternion, 'YXZ');
            euler.y = 0;
            euler.z = 0;
            bone.quaternion.setFromEuler(euler);
            bone.rotation.setFromQuaternion(bone.quaternion, bone.rotation.order);
            bone.position.x = 0;
        }

        // Mirror left/right bones
        for (const bone of this.boneList) {
            const name = bone.name;
            let sourceName, targetName;

            if (fromSide === 'right_to_left') {
                if (name.endsWith('_r')) {
                    sourceName = name;
                    targetName = name.slice(0, -2) + '_l';
                } else continue;
            } else {
                if (name.endsWith('_l')) {
                    sourceName = name;
                    targetName = name.slice(0, -2) + '_r';
                } else continue;
            }

            const sourceBone = this.boneList.find(b => b.name === sourceName);
            const targetBone = this.boneList.find(b => b.name === targetName);
            if (!sourceBone || !targetBone) continue;

            // Mirror quaternion across YZ plane: negate X and W signs for reflection
            const q = sourceBone.quaternion.clone();
            targetBone.quaternion.set(-q.x, q.y, q.z, -q.w);
            // Normalize to avoid drift
            targetBone.quaternion.normalize();
            targetBone.rotation.setFromQuaternion(targetBone.quaternion, targetBone.rotation.order);
        }

        if (this.skeleton) this.skeleton.update();
        this.skinnedMesh.updateMatrixWorld(true);
        this.updateMarkers();
        this.requestRender();
        this.dispatchPoseChange();
    }

    resetToTPose() {
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
        this.updateMarkers();
        this.requestRender();
        this.dispatchPoseChange();
        return this.getBonePositionLog();
    }

    getBonePositionLog() {
        const labels = {
            'head': '頭', 'neck_01': '首',
            'spine_01': '背骨1', 'spine_02': '背骨2', 'spine_03': '背骨3',
            'clavicle_r': '右鎖骨', 'clavicle_l': '左鎖骨',
            'upperarm_r': '右上腕', 'upperarm_l': '左上腕',
            'lowerarm_r': '右前腕', 'lowerarm_l': '左前腕',
            'hand_r': '右手', 'hand_l': '左手',
            'pelvis': '骨盤',
            'thigh_r': '右大腿', 'thigh_l': '左大腿',
            'calf_r': '右下腿', 'calf_l': '左下腿',
            'foot_r': '右足', 'foot_l': '左足',
        };
        const lines = ['=== ボーン座標 (World) ==='];
        for (const [name, label] of Object.entries(labels)) {
            const bone = this.boneList.find(b => b.name === name);
            if (!bone) continue;
            const wp = new this.THREE.Vector3();
            bone.getWorldPosition(wp);
            const rx = (bone.rotation.x * 180 / Math.PI).toFixed(1);
            const ry = (bone.rotation.y * 180 / Math.PI).toFixed(1);
            const rz = (bone.rotation.z * 180 / Math.PI).toFixed(1);
            lines.push(`${label}(${name}): X=${wp.x.toFixed(3)} Y=${wp.y.toFixed(3)} Z=${wp.z.toFixed(3)} rot=[${rx},${ry},${rz}]`);
        }
        return lines.join('\n');
    }

    resetCamera() {
        // Use pelvis bone as orbit target
        const pelvisBone = this.boneList.find(b => b.name === 'pelvis') ||
                           this.boneList.find(b => b.name === 'spine_01');

        let target = new this.THREE.Vector3(0, 0, 0);
        if (pelvisBone) {
            pelvisBone.getWorldPosition(target);
        }
        // Position camera in front at a reasonable distance
        const dist = 30;
        this.camera.position.set(target.x, target.y, target.z + dist);
        this.camera.fov = 30;
        this.camera.updateProjectionMatrix();
        this.orbit.target.copy(target);
        this.orbit.update();
        this.requestRender();
        this.dispatchPoseChange();
    }

    capture(width, height, zoom, bgColor, offsetX = 0, offsetY = 0) {
        if (!this.initialized) return null;

        // Ensure camera is setup
        this.updateCaptureCamera(width, height, zoom, offsetX, offsetY);

        // Hide UI elements
        const markersVisible = this.jointMarkers[0]?.visible ?? true;
        const transformVisible = this.transform ? this.transform.visible : true;
        const skeletonHelperVisible = this.skeletonHelper?.visible ?? true;
        const frustumVisible = this._rtmwFrustumGroup ? this._rtmwFrustumGroup.visible : false;

        // Hide Helpers
        if (this.transform) this.transform.visible = false;
        if (this.skeletonHelper) this.skeletonHelper.visible = false;
        if (this.gridHelper) this.gridHelper.visible = false;
        if (this._rtmwFrustumGroup) this._rtmwFrustumGroup.visible = false;
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

            // Snap viewport camera aspect to output aspect for correct framing
            const oldAspect = this.camera.aspect;
            this.camera.aspect = width / height;
            this.camera.updateProjectionMatrix();

            this.renderer.setPixelRatio(1); // Force 1:1 pixel ratio for capture
            this.renderer.setSize(width, height, false); // false = don't update style to avoid layout thrashing

            // Render directly with viewport camera - what you see is what you get
            this.renderer.render(this.scene, this.camera);
            dataURL = this.canvas.toDataURL("image/png");

            // Restore aspect
            this.camera.aspect = oldAspect;
            this.camera.updateProjectionMatrix();

            // Restore renderer
            this.renderer.setPixelRatio(oldPixelRatio);
            this.renderer.setSize(originalSize.x, originalSize.y, true); // Update style back

        } catch (e) {
            console.error("Capture failed:", e);
        } finally {
            // Restore state
            if (this.renderer.getPixelRatio() !== oldPixelRatio) this.renderer.setPixelRatio(oldPixelRatio);
            this.scene.background = oldBg;

            this.jointMarkers.forEach(m => m.visible = markersVisible);
            if (this.transform) this.transform.visible = transformVisible;
            if (this.skeletonHelper) this.skeletonHelper.visible = skeletonHelperVisible;
            if (this.gridHelper) this.gridHelper.visible = true;

            // Restore IK effectors and pole targets visibility
            if (this.ikController) {
                for (const [name, effector] of Object.entries(this.ikController.effectors)) {
                    effector.visible = effectorVisibility[name] ?? false;
                }
                for (const [key, pole] of Object.entries(this.ikController.poleTargets)) {
                    pole.visible = poleVisibility[key] ?? false;
                }
            }

            if (this._rtmwFrustumGroup) this._rtmwFrustumGroup.visible = frustumVisible;

            // Re-render viewport
            this.renderer.render(this.scene, this.camera);
        }
        return dataURL;
    }
}


// === Pose Studio Widget ===


export { IK_CHAINS };
