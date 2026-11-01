// Phase 1 PoC for 2D Pose Fitting: one arm, shoulder fixed, elbow + wrist markers.
// Runs on the real MakeHuman rig and capture camera through the Pose Studio scene
// harness. `node tests/helpers/pose_fitting2d_poc.mjs` prints the metric tables.
import { pathToFileURL } from "node:url";
import { createScene } from "./pose_studio_scene.mjs";
import { AnalyticIKSolver } from "../../web/pose_studio/core.js";
import * as F from "../../web/pose_studio/pose_fitting2d.mjs";

const FRAME = { width: 1024, height: 1024 };
const ARM_BONES = ["upperarm_l", "lowerarm_l"];

/** Ground-truth arm configurations (left arm, upper-arm Euler XYZ rad, extra elbow flex deg). */
export const POC_CONFIGS = [
    { name: "in-plane", upper: [0, 0, 0.3], flex: 30 },
    { name: "elbow toward camera", upper: [0, -0.9, 0], flex: 20 },
    { name: "elbow away from camera", upper: [0, 0.7, 0], flex: 20 },
    { name: "forearm toward camera", upper: [0, 0, -0.4], flex: 70 },
    { name: "arm raised", upper: [0, -0.3, 1.6], flex: 60 },
];

export function createPoCScene() {
    const scene = createScene({ skinned: true });
    const { viewer } = scene;
    viewer.setPose({ bones: {} }, true);
    const restModel = F.buildFittingModel(F.snapshotViewerRig(viewer));
    const hinge = restModel.bones[restModel.index.get("lowerarm_l")].hingeAxis;
    const projector = F.captureCameraProjector(viewer.captureCamera, FRAME.width, FRAME.height);
    return { ...scene, hinge, projector };
}

export function setArm(scene, upper = [0, 0, 0], flexDeg = 0) {
    const { viewer, THREE, hinge } = scene;
    viewer.setPose({ bones: {} }, true);
    viewer.bones.upperarm_l.rotation.set(upper[0], upper[1], upper[2]);
    viewer.bones.lowerarm_l.quaternion.setFromAxisAngle(new THREE.Vector3(...hinge), flexDeg * Math.PI / 180);
    viewer.skinnedMesh.updateMatrixWorld(true);
}

const model = scene => F.buildFittingModel(F.snapshotViewerRig(scene.viewer));
const project = (scene, m = model(scene)) => F.projectFittingJoints(m, scene.projector);
const pick = (points, ids) => ids.map(id => ({ id, x: points[id].x, y: points[id].y }));

function percentile(values, q) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))] ?? 0;
}

/** Static inverse problem: recover markers generated from a known reachable pose. */
export function runStaticFits(scene, { methods = ["lm", "dls", "jt"], maxIterations = 100 } = {}) {
    const rows = [];
    for (const config of POC_CONFIGS) {
        setArm(scene, config.upper, config.flex);
        const truthModel = model(scene);
        const truth = project(scene, truthModel);
        const truthDepth = F.markerDepthRelation(truthModel, scene.projector, "l_wrist");
        const markers = pick(truth, ["l_shoulder", "l_elbow", "l_wrist"]);
        setArm(scene, [0, 0, 0], 0);
        const start = model(scene);
        for (const method of methods) {
            const result = F.solvePoseFitting(start, scene.projector, markers, { method, maxIterations, bones: ARM_BONES });
            // Iterations needed to reach 0.5 px (re-run with growing budgets).
            let toHalfPixel = null;
            for (let budget = 1; budget <= maxIterations; budget++) {
                const partial = F.solvePoseFitting(start, scene.projector, markers, { method, maxIterations: budget, bones: ARM_BONES });
                if (partial.maxError < 0.5) { toHalfPixel = budget; break; }
                if (partial.iterations < budget) break;
            }
            const limits = F.measureJointLimits(start, result.state);
            const world = F.forwardKinematics(start, result.state);
            const truthWorld = F.forwardKinematics(truthModel);
            const wrist = start.index.get("hand_l");
            const jointError3D = Math.hypot(...[12, 13, 14].map(k => world[wrist][k] - truthWorld[wrist][k]));
            rows.push({
                config: config.name,
                method,
                maxErrorPx: result.maxError,
                meanErrorPx: result.meanError,
                iterations: result.iterations,
                iterationsTo05px: toHalfPixel,
                reason: result.reason,
                timeMs: result.durationMs,
                maxLimitViolationDeg: limits.maxViolation,
                elbowFlexDeg: limits.joints.lowerarm_l.flex,
                wristDepth: F.markerDepthRelation(start, scene.projector, "l_wrist", result.state),
                truthWristDepth: truthDepth,
                wrist3DErrorUnits: jointError3D,
            });
        }
    }
    return rows;
}

/** Drag simulation with a per-frame iteration budget, warm-started like the UI. */
export function runDrag(scene, { dragged = "l_wrist", delta = [-50, 10], frames = 30, method = "lm", budget = 6, pinned = ["l_shoulder"], start = { upper: [0, 0, 0], flex: 0 } } = {}) {
    setArm(scene, start.upper, start.flex);
    const startModel = model(scene);
    const startPoints = project(scene, startModel);
    const anchor = F.captureFittingState(startModel);
    let state = anchor;
    const fixed = ["l_shoulder", "l_elbow", "l_wrist"].filter(id => id !== dragged);
    const perFrame = [];
    let previousWorld = F.forwardKinematics(startModel, state);
    for (let frame = 1; frame <= frames; frame++) {
        const t = frame / frames;
        const target = { x: startPoints[dragged].x + delta[0] * t, y: startPoints[dragged].y + delta[1] * t };
        const markers = [
            ...fixed.map(id => ({ id, x: startPoints[id].x, y: startPoints[id].y, pinned: pinned.includes(id) })),
            { id: dragged, x: target.x, y: target.y, dragging: true },
        ];
        const result = F.solvePoseFitting(startModel, scene.projector, markers, { method, maxIterations: budget, bones: ARM_BONES, anchor, initialState: state });
        state = result.state;
        const world = F.forwardKinematics(startModel, state);
        const jump = Math.max(...["lowerarm_l", "hand_l"].map(name => {
            const i = startModel.index.get(name);
            const a = scene.projector.project([world[i][12], world[i][13], world[i][14]]);
            const b = scene.projector.project([previousWorld[i][12], previousWorld[i][13], previousWorld[i][14]]);
            return Math.hypot(a.x - b.x, a.y - b.y);
        }));
        previousWorld = world;
        const byId = Object.fromEntries(result.markers.map(item => [item.id, item.error]));
        perFrame.push({
            frame,
            draggedErrorPx: byId[dragged],
            maxFixedErrorPx: Math.max(...fixed.map(id => byId[id])),
            timeMs: result.durationMs,
            jumpPx: jump,
            flexDeg: F.measureJointLimits(startModel, state).joints.lowerarm_l.flex,
            violationDeg: result.maxLimitViolation,
        });
    }
    // A converged final solve after release (the UI runs this on pointerup).
    const finalMarkers = [
        ...fixed.map(id => ({ id, x: startPoints[id].x, y: startPoints[id].y, pinned: pinned.includes(id) })),
        { id: dragged, x: startPoints[dragged].x + delta[0], y: startPoints[dragged].y + delta[1] },
    ];
    const final = F.solvePoseFitting(startModel, scene.projector, finalMarkers, { method, maxIterations: 100, bones: ARM_BONES, anchor, initialState: state });
    const lastFrame = perFrame.at(-1);
    return {
        dragged, method, budget,
        meanDraggedErrorPx: perFrame.reduce((sum, item) => sum + item.draggedErrorPx, 0) / perFrame.length,
        lastDraggedErrorPx: lastFrame.draggedErrorPx,
        maxFixedErrorPx: Math.max(...perFrame.map(item => item.maxFixedErrorPx)),
        p95TimeMs: percentile(perFrame.map(item => item.timeMs), 0.95),
        maxTimeMs: Math.max(...perFrame.map(item => item.timeMs)),
        maxJumpPx: Math.max(...perFrame.map(item => item.jumpPx)),
        targetStepPx: Math.hypot(...delta) / frames,
        minFlexDeg: Math.min(...perFrame.map(item => item.flexDeg)),
        maxViolationDeg: Math.max(...perFrame.map(item => item.violationDeg)),
        final: { draggedErrorPx: final.markers.find(item => item.id === dragged).error, maxErrorPx: final.maxError, iterations: final.iterations, timeMs: final.durationMs, unreached: final.unreached },
        finalState: final.state,
        perFrame,
    };
}

/** Existing Pose Studio IK on the same drags (3D target = marker ray at the current joint depth). */
export function runExistingIKDrag(scene, { dragged = "l_wrist", delta = [-50, 10], frames = 30, start = { upper: [0, 0, 0], flex: 0 } } = {}) {
    const { viewer, THREE } = scene;
    setArm(scene, start.upper, start.flex);
    const startPoints = project(scene);
    const solver = new AnalyticIKSolver(THREE);
    const camera = viewer.captureCamera;
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const perFrame = [];
    for (let frame = 1; frame <= frames; frame++) {
        const t = frame / frames;
        const target = { x: startPoints[dragged].x + delta[0] * t, y: startPoints[dragged].y + delta[1] * t };
        const ndc = new THREE.Vector2(target.x / FRAME.width * 2 - 1, 1 - target.y / FRAME.height * 2);
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(ndc, camera);
        const jointBone = dragged === "l_wrist" ? viewer.bones.hand_l : viewer.bones.lowerarm_l;
        const jointWorld = jointBone.getWorldPosition(new THREE.Vector3());
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(forward, jointWorld);
        const point = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
        if (dragged === "l_wrist") {
            solver.solve2Bone(viewer.bones.upperarm_l, viewer.bones.lowerarm_l, viewer.bones.hand_l, point, null, THREE);
        } else {
            solver.rotateBoneToPoint(viewer.bones.upperarm_l, jointWorld, point, THREE);
        }
        viewer.skinnedMesh.updateMatrixWorld(true);
        const points = project(scene);
        const fixed = ["l_shoulder", "l_elbow", "l_wrist"].filter(id => id !== dragged);
        perFrame.push({
            draggedErrorPx: Math.hypot(points[dragged].x - target.x, points[dragged].y - target.y),
            maxFixedErrorPx: Math.max(...fixed.map(id => Math.hypot(points[id].x - startPoints[id].x, points[id].y - startPoints[id].y))),
        });
    }
    return {
        dragged, method: "existing-ik",
        meanDraggedErrorPx: perFrame.reduce((sum, item) => sum + item.draggedErrorPx, 0) / perFrame.length,
        lastDraggedErrorPx: perFrame.at(-1).draggedErrorPx,
        maxFixedErrorPx: Math.max(...perFrame.map(item => item.maxFixedErrorPx)),
    };
}

/** Drag scenarios from the rest A-pose (deltas in output pixels). */
export const POC_DRAGS = [
    { name: "elbow, reachable", dragged: "l_elbow", delta: [-20, -5] },
    { name: "wrist, reachable", dragged: "l_wrist", delta: [-50, 10] },
    { name: "wrist, far reach", dragged: "l_wrist", delta: [40, 60] },
    { name: "elbow, unreachable", dragged: "l_elbow", delta: [90, -60] },
];

const fmt = value => (typeof value === "number" ? (Number.isInteger(value) ? String(value) : value.toFixed(3)) : String(value));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const scene = createPoCScene();
    console.log("Static fits (markers from known poses, shoulder fixed, DOF = upperarm 3 + elbow hinge 1)");
    console.table(runStaticFits(scene).map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, fmt(v)]))));
    const drags = [];
    for (const scenario of POC_DRAGS) {
        for (const method of ["lm", "dls", "jt"]) {
            const { perFrame, finalState, final, ...summary } = runDrag(scene, { ...scenario, method });
            drags.push({ scenario: scenario.name, ...summary, finalDraggedPx: final.draggedErrorPx, finalMaxPx: final.maxErrorPx });
        }
        drags.push({ scenario: scenario.name, ...runExistingIKDrag(scene, scenario) });
    }
    console.log("Drag simulation (30 frames, 6 iterations per frame, shoulder pinned, other joint target kept)");
    console.table(drags.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, fmt(v)]))));
    const a = runDrag(scene, POC_DRAGS[1]), b = runDrag(scene, POC_DRAGS[1]);
    console.log("Deterministic:", JSON.stringify(a.finalState) === JSON.stringify(b.finalState));
}
