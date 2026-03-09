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
        iterations: 5,
        threshold: 0.01
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

        // Check if pole target is enabled for this chain
        if (this.isPoleTargetEnabled(chainKey) && this.poleTargets[chainKey]) {
            poleTarget = this.poleTargets[chainKey].position.clone();
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
        this.orbit.update();

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
        const markerIntersects = raycaster.intersectObjects(this.jointMarkers, false);

        if (markerIntersects.length > 0) {
            // Sort by distance and pick the closest one
            markerIntersects.sort((a, b) => a.distance - b.distance);
            const hitMarker = markerIntersects[0].object;
            const boneIdx = this.jointMarkers.indexOf(hitMarker);
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
                            this.selectBone(bone); // Show selection visually (and fallback to Rotate FK after release)

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
                            this.selectBone(nearest);

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
            if (this.hoveredBoneName) {
                this.hoveredBoneName = null;
                this.updateMarkers();
            }
            return;
        }

        let hitBone = null;

        const markerIntersects = raycaster.intersectObjects(this.jointMarkers, false);
        if (markerIntersects.length > 0) {
            markerIntersects.sort((a, b) => a.distance - b.distance);
            const hitMarker = markerIntersects[0].object;
            const boneIdx = this.jointMarkers.indexOf(hitMarker);
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
                    hitBone = nearest;
                }
            }
        }

        const newHoveredName = hitBone ? hitBone.name : null;
        if (this.hoveredBoneName !== newHoveredName) {
            this.hoveredBoneName = newHoveredName;
            this.updateMarkers();
            this.requestRender();
        }
    }

    handlePointerUp(e) {
        if (!this.initialized || !this.skinnedMesh) return;

        if (this.directDrag && this.directDrag.active) {
            this.directDrag.active = false;
            this.directDrag.effector = null;
            this.directDrag.chainKey = null;
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

            // Allow TransformControls back for the selected bone (FK) mode now that drag is done
            if (this.selectedBone) {
                // Completely detach and reattach to flush out any bad matrix internal states
                this.transform.detach();
                this.transform.setMode("rotate");
                this.transform.attach(this.selectedBone);
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

    updateMarkers() {
        if (!this.markerMatNormal || !this.markerMatSelected) return;

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

        // Apply cached head scale
        if (this.headScale !== 1.0) {
            this.updateHeadScale(this.headScale);
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

        const fingerPatterns = ['finger', 'thumb', 'index', 'middle', 'ring', 'pinky', 'f_'];
        for (let i = 0; i < this.boneList.length; i++) {
            const bone = this.boneList[i];
            const isFinger = fingerPatterns.some(p => bone.name.toLowerCase().includes(p));
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
        // Find head bone if not cached or verify
        const headBone = this.boneList.find(b => b.name.toLowerCase().includes('head'));
        if (headBone) {
            headBone.scale.set(scale, scale, scale);
            this.requestRender();
        }
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

            this.jointMarkers.forEach(m => m.visible = true);
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
}


// === Pose Studio Widget ===


export { IK_CHAINS };
