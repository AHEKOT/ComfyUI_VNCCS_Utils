/**
 * VNCCS Pose Studio - 2D Pose Fitting mode (UI controller).
 *
 * Owns the "2D Pose Fitting" sidebar section, the marker overlay drawn over
 * the viewport, marker dragging, and the incremental solve loop. The solver
 * itself lives in `pose_fitting2d.mjs`.
 *
 * Coordinate spaces:
 * - Markers are stored in normalized output-frame coordinates (u, v; top-left
 *   origin) of the CAPTURE camera, never of the editor camera.
 * - For display, a frame point is placed on the plane of the orange capture
 *   frame (through the capture camera's projection) and that 3D point is then
 *   projected with the editor camera, so markers stay glued to the frame while
 *   the editor view orbits.
 */
import { detectAndParseJSON } from "./imports/openpose.js?v=1791754604000";
import * as F from "./pose_fitting2d.mjs?v=20261102.5";

const SIDE_COLORS = { l: "#4fd1ff", r: "#ff9f43", c: "#ffe066" };
const SKELETON = [
    ["head", "neck"], ["neck", "r_shoulder"], ["r_shoulder", "r_elbow"], ["r_elbow", "r_wrist"],
    ["neck", "l_shoulder"], ["l_shoulder", "l_elbow"], ["l_elbow", "l_wrist"], ["r_wrist", "r_hand"], ["l_wrist", "l_hand"],
    ["r_shoulder", "r_hip"], ["r_hip", "r_knee"], ["r_knee", "r_ankle"],
    ["l_shoulder", "l_hip"], ["l_hip", "l_knee"], ["l_knee", "l_ankle"], ["r_hip", "l_hip"],
];
const HAND_SKELETON = F.POSE_FITTING_MARKERS.filter(def => def.group === "hand").map(def => [def.parent, def.id]);
const HIT_RADIUS = 11;
/**
 * Fingertips sit a few pixels apart: smaller hit area and drawing. A fingertip
 * wins inside its own small radius, so the middle tip can be grabbed where it
 * overlaps the L/R Hand marker; the Hand marker's larger ring outside that
 * radius still grabs the hand.
 */
const HAND_HIT_RADIUS = 6;
/** L/R Hand markers are drawn as a wider ring so they stay grabbable around a fingertip. */
const HAND_POINT_RADIUS = 8;
/** Locked markers are drawn in red. */
const LOCKED_COLOR = "#ff4d4d";
const svgIcon = body => `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">${body}</svg>`;
const LOCK_ICONS = {
    on: svgIcon('<rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor"/><path d="M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7" fill="none" stroke="currentColor" stroke-width="1.6"/>'),
    off: svgIcon('<rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.2 7V5.2a2.8 2.8 0 0 1 5.4-1" fill="none" stroke="currentColor" stroke-width="1.3"/>'),
};
const EYE_ICONS = {
    on: svgIcon('<path d="M1 8s2.6-4.6 7-4.6S15 8 15 8s-2.6 4.6-7 4.6S1 8 1 8z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2.1" fill="currentColor"/>'),
    off: svgIcon('<path d="M1 8s2.6-4.6 7-4.6S15 8 15 8s-2.6 4.6-7 4.6S1 8 1 8z" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.6"/><path d="M2.5 13.5l11-11" stroke="currentColor" stroke-width="1.6"/>'),
};
export const POSE_FITTING_FRAME_BUDGET = Object.freeze({ iterations: 8, timeMs: 6 });
export const POSE_FITTING_FINAL_BUDGET = Object.freeze({ iterations: 80, timeMs: 80 });
const MARKER_DEFS = new Map(F.POSE_FITTING_MARKERS.map(def => [def.id, def]));
const FLIP_TITLE = "Mirror this segment's depth across the camera ray (keeps the 2D position), then refit. L/R Hand: the other wrist direction on the same ray";

const now = () => (typeof performance !== "undefined" && performance?.now ? performance.now() : Date.now());

export class PoseFitting2DController {
    constructor(host, env = {}) {
        this.host = host;
        this.document = env.document || globalThis.document;
        this.requestFrame = env.requestAnimationFrame || (callback => globalThis.requestAnimationFrame(callback));
        this.cancelFrame = env.cancelAnimationFrame || (id => globalThis.cancelAnimationFrame(id));
        this.active = false;
        this.selectedId = null;
        /** Collapsed marker-tree nodes (panel view state, not saved). */
        this.collapsed = new Set();
        this.drag = null;
        this.live = null;
        this.frameRequest = null;
        this.lastResult = null;
        this.timings = [];
        this.message = "";
        this.elements = {};
        this.container = null;
        this.canvas = null;
        this.overlay = null;
        this._applying = false;
        this._noseCache = null;
        this._removeListeners = [];
    }

    get viewer() { return this.host?.viewer || null; }
    get state() { return this.viewer?.fitting2d || null; }
    set state(value) { if (this.viewer) this.viewer.fitting2d = value; }

    frameSize() {
        const params = this.host?.exportParams || {};
        return {
            width: Math.max(1, Math.round(Number(params.view_width) || 1024)),
            height: Math.max(1, Math.round(Number(params.view_height) || 1024)),
        };
    }

    isAvailable() {
        return !!this.viewer?.isInitialized?.() && !!this.viewer.captureCamera && !this.host?.isAnimationMode?.();
    }

    settings() {
        return this.state?.settings || F.defaultFittingSettings();
    }

    /** Markers shown, draggable and solved (body markers, plus fingertips with Fingertips on). */
    visibleIds() {
        return F.visibleFittingMarkerIds(this.settings());
    }

    // ------------------------------------------------------------------
    // Solver plumbing
    // ------------------------------------------------------------------

    /** Head marker point: the nose tip of the current mannequin, in head-bone space. */
    noseOffset() {
        const viewer = this.viewer;
        const THREE = viewer?.THREE;
        const geometry = viewer?.skinnedMesh?.geometry;
        const positions = geometry?.attributes?.position;
        const skeleton = viewer?.skeleton;
        const head = viewer?.bones?.head;
        if (!THREE || !positions || !skeleton || !head) return null;
        if (this._noseCache?.geometry === geometry && this._noseCache.version === positions.version) return this._noseCache.offset;
        const headIndex = skeleton.bones?.indexOf(head) ?? -1;
        const inverse = skeleton.boneInverses?.[headIndex];
        if (!inverse) return null;
        const bind = inverse.clone().invert().elements;
        const [hx, hy] = [bind[12], bind[13]];
        const reach = Math.max(0.1, head.position.length());
        const point = new THREE.Vector3();
        let best = null;
        const indices = geometry.index?.array;
        const count = indices ? indices.length : positions.count;
        for (let i = 0; i < count; i++) {
            const vertex = indices ? indices[i] : i;
            point.fromBufferAttribute(positions, vertex);
            if (point.y < hy || point.y > hy + 3 * reach || Math.abs(point.x - hx) > 0.35 * reach) continue;
            if (!best || point.z > best.z) best = point.clone();
        }
        const offset = best ? best.applyMatrix4(inverse).toArray() : null;
        this._noseCache = { geometry, version: positions.version, offset };
        return offset;
    }

    buildModel(fingertips = this.settings().fingertips === true) {
        const offset = this.noseOffset();
        const offsets = {
            ...F.viewerHandPointOffsets(this.viewer),
            ...(fingertips ? F.viewerFingerTipOffsets(this.viewer) : {}),
            ...(offset ? { head: offset } : {}),
        };
        const snapshot = F.snapshotViewerRig(this.viewer, offsets, { fingertips });
        return snapshot ? F.buildFittingModel(snapshot) : null;
    }

    projector() {
        const frame = this.frameSize();
        return F.captureCameraProjector(this.viewer?.captureCamera, frame.width, frame.height);
    }

    solverOptions(extra = {}, context = null) {
        const settings = this.settings();
        // The prior is in radians and the markers in pixels: rescale the prior by
        // the figure's on-screen size so the same Stiffness feels the same for
        // every lens, distance, zoom and output size.
        const scale = Number.isFinite(context?.priorScale) ? context.priorScale : 1;
        return {
            scope: settings.scope,
            moveRoot: settings.moveRoot,
            poseStiffness: F.POSE_FITTING_DEFAULTS.poseStiffness * (settings.stiffness || 1) * scale,
            ...extra,
        };
    }

    solverMarkers() {
        return F.fittingStateToSolverMarkers(this.state, this.frameSize(), { dragging: this.drag?.moved ? this.drag.id : null });
    }

    /** Start an incremental solve context (drag or live constraint edit). */
    createContext() {
        const model = this.buildModel();
        const projector = this.projector();
        if (!model || !projector) return null;
        const anchor = F.captureFittingState(model);
        // Figure size in the frame, fixed for the whole gesture.
        const priorScale = F.projectionPriorScale(model, projector, anchor);
        return { model, projector, anchor, state: anchor, priorScale };
    }

    runSolve(context, budget) {
        const started = now();
        const markers = context.exclude ? this.solverMarkers().filter(marker => !context.exclude.has(marker.id)) : this.solverMarkers();
        const result = F.solvePoseFitting(context.model, context.projector, markers, this.solverOptions({
            anchor: context.anchor,
            initialState: context.state,
            maxIterations: budget.iterations,
            timeBudgetMs: budget.timeMs,
            tolerance: 1e-7,
        }, context));
        this.recordTiming(now() - started);
        // Reject broken results and keep the last valid pose visible. A pose that
        // already broke a limit (e.g. a hand set by FK) is not rejected for it.
        const broken = !result.valid || !Number.isFinite(result.energy)
            || result.energy > result.initialEnergy * 1.5 + 1e-6
            || result.maxLimitViolation > Math.max(25, (result.initialLimitViolation || 0) + 1);
        if (broken) {
            this.message = "Solver rejected an invalid step; the last valid pose is kept.";
            return null;
        }
        context.state = result.state;
        this._applying = true;
        try {
            F.applyFittingStateToViewer(this.viewer, context.model, result.state);
            this.viewer.updateIKEffectorPositions?.();
            this.viewer.updateMarkers?.();
            this.viewer.requestRender?.();
        } finally {
            this._applying = false;
        }
        this.lastResult = result;
        return result;
    }

    recordTiming(ms) {
        this.timings.push(ms);
        if (this.timings.length > 120) this.timings.shift();
    }

    timingSummary() {
        if (!this.timings.length) return null;
        const sorted = [...this.timings].sort((a, b) => a - b);
        return { last: this.timings.at(-1), p95: sorted[Math.floor((sorted.length - 1) * 0.95)], max: sorted.at(-1) };
    }

    requestSolveFrame() {
        if (this.frameRequest) return;
        this.frameRequest = this.requestFrame(() => this.solveFrame());
    }

    cancelSolveFrame() {
        if (!this.frameRequest) return;
        this.cancelFrame(this.frameRequest);
        this.frameRequest = null;
    }

    solveFrame() {
        this.frameRequest = null;
        const context = this.drag?.moved ? this.drag.context : this.live;
        if (!context || !this.isAvailable()) return;
        const result = this.runSolve(context, POSE_FITTING_FRAME_BUDGET);
        // Keep refining while the pointer is held still.
        if (result && !result.converged) this.requestSolveFrame();
        this.redraw();
        this.refreshPanel();
    }

    commitPose() {
        this.viewer?.dispatchPoseChange?.();
        this.redraw();
        this.refreshPanel();
    }

    beginUndoStep() {
        this.host?._finishPoseGesture?.();
        if (!this.host?.isAnimationMode?.()) this.viewer?.recordState?.();
    }

    // ------------------------------------------------------------------
    // Commands
    // ------------------------------------------------------------------

    setActive(active) {
        const next = !!active && this.isAvailable();
        if (next === this.active) { this.refreshPanel(); return; }
        this.endInteraction();
        this.active = next;
        if (next && !this.state) {
            this.state = this.targetsFromPose(null, { keepPinned: false });
            this.host?.syncToNode?.(false);
        }
        if (next) this.fillUnplacedMarkers();
        this.message = next ? "Drag markers in the viewport. Bones stay selectable elsewhere." : "";
        this.applyBoneHandles();
        this.redraw();
        this.refreshPanel();
    }

    targetsFromPose(state, options) {
        const model = this.buildModel((state?.settings ?? this.settings()).fingertips === true);
        const projector = this.projector();
        if (!model || !projector) return state;
        return F.resetFittingTargets(state, F.projectFittingJoints(model, projector), this.frameSize(), options);
    }

    /**
     * Visible markers without a position (fingertips just switched on, or L/R
     * Hand in data saved before they existed) appear disabled on the current
     * joints: they constrain nothing until dragged or enabled. Not an undo step.
     */
    fillUnplacedMarkers() {
        const state = this.state;
        if (!state?.markers || !this.isAvailable()) return false;
        const missing = this.visibleIds().filter(id => state.markers[id] && state.markers[id].u === null);
        if (!missing.length) return false;
        const model = this.buildModel(state.settings?.fingertips === true);
        const projector = model ? this.projector() : null;
        if (!model || !projector) return false;
        const projected = F.projectFittingJoints(model, projector);
        const frame = this.frameSize();
        let changed = false;
        for (const id of missing) {
            const point = projected[id];
            if (!point?.valid) continue;
            Object.assign(state.markers[id], { u: point.x / frame.width, v: point.y / frame.height, enabled: false, confidence: 1 });
            changed = true;
        }
        return changed;
    }

    /** Fingertips setting (per pose): shows the ten fingertip markers and solves the finger chains. */
    setFingertips(on) {
        if (!this.state) this.state = this.targetsFromPose(null, { keepPinned: false });
        if (!this.state) return;
        this.state.settings = { ...F.defaultFittingSettings(), ...this.state.settings, fingertips: on === true };
        this.fillUnplacedMarkers();
        if (this.selectedId && !this.visibleIds().includes(this.selectedId)) this.selectedId = null;
        this.redraw();
        this.refreshPanel();
        this.host?.syncToNode?.(false);
    }

    // ------------------------------------------------------------------
    // Bone handles (editor setting of the widget, applied while the mode is on)
    // ------------------------------------------------------------------

    hideBoneHandlesSetting() {
        return this.host?.exportParams?.fit_hide_bone_handles === true;
    }

    setHideBoneHandles(hidden) {
        if (this.host?.exportParams) this.host.exportParams.fit_hide_bone_handles = hidden === true;
        this.applyBoneHandles();
        this.refreshPanel();
        this.host?.syncToNode?.(false);
    }

    /** Pose Studio's bone drag points are hidden and unpickable only while Fitting Mode is on. */
    applyBoneHandles() {
        this.viewer?.setBoneHandlesHidden?.(this.active && this.hideBoneHandlesSetting());
    }

    fitPose() {
        if (!this.isAvailable() || !this.state) return null;
        this.endInteraction();
        this.beginUndoStep();
        const context = this.createContext();
        if (!context) return null;
        const result = this.runSolve(context, POSE_FITTING_FINAL_BUDGET);
        if (result) {
            const unreached = result.unreached.map(id => MARKER_DEFS.get(id)?.label || id);
            this.message = `Fit: ${result.iterations} iterations, ${result.converged ? "converged" : "stopped"}`
                + (unreached.length ? `; residual over ${F.POSE_FITTING_DEFAULTS.unreachedPx}px: ${unreached.join(", ")}` : "");
        }
        this.commitPose();
        return result;
    }

    resetTargets() {
        if (!this.isAvailable()) return;
        this.endInteraction();
        this.beginUndoStep();
        this.state = this.targetsFromPose(this.state, { keepPinned: true });
        this.message = "Unpinned targets moved to the current joints.";
        this.commitPose();
    }

    clearConstraints() {
        if (!this.viewer) return;
        this.endInteraction();
        this.beginUndoStep();
        this.state = null;
        this.selectedId = null;
        this.message = "Constraints cleared. Reset Targets creates markers from the current pose.";
        this.commitPose();
    }

    updateSettings(patch) {
        if (!this.state) this.state = this.targetsFromPose(null, { keepPinned: false });
        if (!this.state) return;
        this.state.settings = { ...F.defaultFittingSettings(), ...this.state.settings, ...patch };
        this.redraw();
        this.refreshPanel();
        this.host?.syncToNode?.(false);
    }

    /**
     * Panel Lock / Hide toggle on a tree node: applies to the node and every
     * marker below it (one Undo step); children can be toggled on their own
     * afterwards. A marker row flips its own flag; the Body row turns the flag
     * on unless every shown marker already has it. Neither changes the solve.
     */
    toggleMarkerFlag(nodeId, key) {
        const state = this.state;
        if (!state?.markers || (key !== "locked" && key !== "hidden")) return;
        const ids = F.fittingTreeDescendants(nodeId).filter(id => state.markers[id]);
        if (!ids.length) return;
        const visible = new Set(this.visibleIds());
        const own = state.markers[nodeId];
        const current = own ? own[key] === true : ids.filter(id => visible.has(id)).every(id => state.markers[id][key] === true);
        this.endInteraction();
        this.beginUndoStep();
        for (const id of ids) state.markers[id][key] = !current;
        const label = MARKER_DEFS.get(nodeId)?.label || "Body";
        const what = key === "locked" ? (current ? "unlocked" : "locked") : (current ? "shown" : "hidden");
        this.message = `${label}${ids.length > 1 ? ` and ${ids.length - 1} below` : ""}: ${what}.`;
        this.commitPose();
    }

    toggleCollapsed(nodeId) {
        if (this.collapsed.has(nodeId)) this.collapsed.delete(nodeId);
        else this.collapsed.add(nodeId);
        this.refreshPanel();
    }

    /** Edit one marker as an undoable constraint change, then refit. */
    editMarker(id, patch, { refit = true } = {}) {
        const marker = this.state?.markers?.[id];
        if (!marker) return;
        this.endInteraction();
        this.beginUndoStep();
        Object.assign(marker, patch);
        if (refit && this.active && this.isAvailable()) {
            const context = this.createContext();
            if (context) this.runSolve(context, POSE_FITTING_FINAL_BUDGET);
        }
        this.commitPose();
    }

    /** Dry-run Flip for the current pose: the mirrored state, or why it is refused. */
    flipCheck(id) {
        const def = MARKER_DEFS.get(id);
        if (!def?.flip) return { flipped: null, reason: "This marker has no single segment to flip." };
        const model = this.buildModel();
        const projector = this.projector();
        const report = {};
        const flipped = model && projector ? F.flipMarkerDepth(model, projector, id, null, { report }) : null;
        if (flipped) return { flipped, model, projector, reason: null };
        return {
            flipped: null,
            reason: report.reason === "same" ? `${def.label}: nothing to flip, the hand points across the view (both depths give the same hand).`
                : def.handPoint ? "Flip refused: the mirrored hand would break the wrist limits."
                    : "Flip refused: the mirrored segment would break joint limits (e.g. a twisted shoulder or hyperextended elbow/knee).",
        };
    }

    flipDepth(id) {
        const marker = this.state?.markers?.[id];
        if (!marker || !this.isAvailable()) return;
        this.endInteraction();
        const { flipped, model, projector, reason } = this.flipCheck(id);
        if (!flipped) {
            this.message = reason;
            this.refreshPanel();
            return;
        }
        this.beginUndoStep();
        F.applyFittingStateToViewer(this.viewer, model, flipped);
        marker.depth = F.markerDepthRelation(model, projector, id, flipped);
        const context = this.createContext();
        // A hand Flip turns only the wrist: the refit leaves the finger chains alone.
        if (context && MARKER_DEFS.get(id)?.handPoint) context.exclude = new Set(F.POSE_FITTING_MARKERS.filter(def => def.group === "hand").map(def => def.id));
        if (context) this.runSolve(context, POSE_FITTING_FINAL_BUDGET);
        this.message = `${MARKER_DEFS.get(id)?.label || id}: depth flipped (${marker.depth === "near" ? "toward" : "away from"} camera).`;
        this.commitPose();
    }

    /** Weight slider: live refit while dragging, one undo step per gesture. */
    beginLiveEdit() {
        if (this.live || !this.isAvailable()) return;
        this.live = this.createContext();
    }

    liveEdit(id, patch) {
        const marker = this.state?.markers?.[id];
        if (!marker) return;
        Object.assign(marker, patch);
        if (this.active && this.live) this.requestSolveFrame();
        this.redraw();
        this.refreshPanel();
    }

    endLiveEdit() {
        if (!this.live) return;
        this.cancelSolveFrame();
        const context = this.live;
        this.live = null;
        if (this.active && this.isAvailable()) this.runSolve(context, POSE_FITTING_FINAL_BUDGET);
        this.commitPose();
    }

    loadOpenPoseData(data) {
        const parsed = detectAndParseJSON(data);
        if (!parsed?.joints) throw new Error("No OpenPose / pose keypoints were found in this JSON.");
        if (Array.isArray(data?.people) && data.people[0]?.pose_keypoints_2d) {
            const count = Math.floor(data.people[0].pose_keypoints_2d.length / 3);
            parsed.format = count >= 19 ? "BODY_25" : "COCO-18";
        }
        const frame = this.frameSize();
        // L/R Hand from hand keypoints 0 (wrist) and 9 (middle knuckle), rigid on the hand,
        // with the current pose's image relation between the knuckle line and the hand point.
        const model = this.isAvailable() ? this.buildModel(false) : null;
        const projector = model ? this.projector() : null;
        const handRelations = model && projector ? F.handPointImageRelation(model, projector) : null;
        const imported = F.fittingStateFromOpenPose(parsed, { frame, previous: this.state, handRelations });
        if (!imported) throw new Error("The JSON has no usable body keypoints.");
        // Missing keypoints get the current joint position but stay disabled.
        const blank = F.createFittingState();
        blank.settings.fingertips = imported.state.settings.fingertips === true;
        const filled = this.targetsFromPose(blank, { keepPinned: false, enable: false });
        for (const id of F.POSE_FITTING_MARKER_IDS) {
            const marker = imported.state.markers[id];
            const fill = filled?.markers?.[id];
            if (marker.u === null && fill && fill.u !== null) {
                Object.assign(marker, { u: filled.markers[id].u, v: filled.markers[id].v, enabled: false, confidence: 0 });
            }
        }
        this.endInteraction();
        this.beginUndoStep();
        this.state = imported.state;
        this.setActive(true);
        this.message = `Loaded ${imported.found} keypoints${imported.handFound ? ` and ${imported.handFound} fingertips` : ""}${imported.handPointFound ? `, ${imported.handPointFound} hand directions` : ""} (${parsed.format || parsed.source || "pose"}). Press Fit Pose.`
            + (imported.warnings.length ? ` ${imported.warnings.join(" ")}` : "");
        this.commitPose();
        return imported;
    }

    openFilePicker() {
        this.elements.fileInput?.click?.();
    }

    handleFile(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = event => {
            try {
                this.loadOpenPoseData(JSON.parse(event.target.result));
            } catch (error) {
                this.message = `OpenPose load failed: ${error?.message || error}`;
                this.refreshPanel();
            }
        };
        reader.readAsText(file);
    }

    endInteraction() {
        this.cancelSolveFrame();
        if (this.drag?.pointerId !== undefined) this.container?.releasePointerCapture?.(this.drag.pointerId);
        this.drag = null;
        this.live = null;
    }

    /** Called after FK/IK edits end in the viewer. */
    onViewerInteractionEnd() {
        if (!this.active || !this.settings().autoRefit || this._applying || !this.state) return;
        const context = this.createContext();
        if (context) this.runSolve(context, POSE_FITTING_FINAL_BUDGET);
    }

    onPoseChanged() {
        if (this._applying) return;
        if (!this.isAvailable() && this.active) this.setActive(false);
        if (this.active) this.fillUnplacedMarkers();
        this.applyBoneHandles();
        this.redraw();
        this.refreshPanel();
    }

    select(id) {
        this.selectedId = id;
        this.redraw();
        this.refreshPanel();
    }

    // ------------------------------------------------------------------
    // Viewport mapping
    // ------------------------------------------------------------------

    /** Distance of the orange capture frame plane along the capture camera's forward axis. */
    framePlane() {
        const viewer = this.viewer;
        const THREE = viewer?.THREE;
        const camera = viewer?.captureCamera;
        if (!THREE || !camera) return null;
        camera.updateMatrixWorld(true);
        const origin = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        const anchor = viewer.captureFrame?.position || viewer.meshCenter || viewer.orbit?.target;
        let distance = anchor ? anchor.clone().sub(origin).dot(forward) : 0;
        if (!(distance > camera.near)) distance = Number(viewer.captureLens?.distance) || 45;
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(forward, origin.clone().addScaledVector(forward, distance));
        return { plane, origin, forward, distance };
    }

    frameToWorld(u, v, framePlane = this.framePlane()) {
        const THREE = this.viewer?.THREE;
        const camera = this.viewer?.captureCamera;
        if (!THREE || !camera || !framePlane) return null;
        const nx = u * 2 - 1, ny = 1 - v * 2;
        const near = new THREE.Vector3(nx, ny, -1).unproject(camera);
        const far = new THREE.Vector3(nx, ny, 1).unproject(camera);
        const ray = new THREE.Ray(near, far.sub(near).normalize());
        return ray.intersectPlane(framePlane.plane, new THREE.Vector3());
    }

    worldToFrame(point) {
        const camera = this.viewer?.captureCamera;
        if (!camera || !point) return null;
        const ndc = point.clone().project(camera);
        return { u: (ndc.x + 1) / 2, v: (1 - ndc.y) / 2 };
    }

    viewportSize() {
        const canvas = this.canvas;
        return { width: canvas?.clientWidth || 1, height: canvas?.clientHeight || 1 };
    }

    /** Overlay (CSS px) position of a frame point as seen through the editor camera. */
    frameToOverlay(u, v, framePlane) {
        const camera = this.viewer?.camera;
        const world = this.frameToWorld(u, v, framePlane);
        if (!camera || !world) return null;
        camera.updateMatrixWorld(true);
        const ndc = world.project(camera);
        if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y) || ndc.z < -1 || ndc.z > 1) return null;
        const size = this.viewportSize();
        return { x: (ndc.x + 1) / 2 * size.width, y: (1 - ndc.y) / 2 * size.height };
    }

    pointerToFrame(clientX, clientY, framePlane = this.framePlane()) {
        const viewer = this.viewer;
        const THREE = viewer?.THREE;
        if (!THREE || !viewer.camera || !this.canvas || !framePlane) return null;
        const rect = this.canvas.getBoundingClientRect();
        const pointer = new THREE.Vector2(
            ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
            -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
        );
        viewer.camera.updateMatrixWorld(true);
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(pointer, viewer.camera);
        const hit = raycaster.ray.intersectPlane(framePlane.plane, new THREE.Vector3());
        return hit ? this.worldToFrame(hit) : null;
    }

    hitTest(clientX, clientY) {
        if (!this.state || !this.canvas) return null;
        // Overlay positions are in CSS layout px; the client rect is scaled by the ComfyUI canvas zoom.
        const rect = this.canvas.getBoundingClientRect();
        const size = this.viewportSize();
        const x = (clientX - rect.left) * size.width / Math.max(1, rect.width);
        const y = (clientY - rect.top) * size.height / Math.max(1, rect.height);
        const framePlane = this.framePlane();
        let tip = null, body = null;
        for (const id of this.visibleIds()) {
            const marker = this.state.markers[id];
            // Locked and hidden markers are skipped, so an overlapping one below can be grabbed.
            if (!marker || marker.u === null || marker.locked || marker.hidden) continue;
            const position = this.frameToOverlay(marker.u, marker.v, framePlane);
            if (!position) continue;
            const distance = Math.hypot(position.x - x, position.y - y);
            if (MARKER_DEFS.get(id).group === "hand") {
                if (distance <= HAND_HIT_RADIUS && (!tip || distance < tip.distance)) tip = { id, distance };
            } else if (distance <= HIT_RADIUS && (!body || distance < body.distance)) {
                body = { id, distance };
            }
        }
        // A fingertip wins inside its small radius over the L/R Hand marker it may
        // overlap; against any other body marker the nearer one wins.
        if (tip && (!body || MARKER_DEFS.get(body.id).handPoint || tip.distance <= body.distance)) return tip;
        return body;
    }

    // ------------------------------------------------------------------
    // Pointer handling (capture phase on the viewport container)
    // ------------------------------------------------------------------

    attachViewport(container, canvas) {
        if (!container || !canvas) return;
        this.container = container;
        this.canvas = canvas;
        const overlay = this.document.createElement("canvas");
        overlay.className = "vnccs-ps-fit-overlay";
        container.appendChild(overlay);
        this.overlay = overlay;
        const listen = (type, handler) => {
            container.addEventListener(type, handler, { capture: true });
            this._removeListeners.push(() => container.removeEventListener(type, handler, { capture: true }));
        };
        listen("pointerdown", event => this.onPointerDown(event));
        listen("pointermove", event => this.onPointerMove(event));
        listen("pointerup", event => this.onPointerUp(event));
        listen("pointercancel", event => this.onPointerUp(event, true));
        listen("lostpointercapture", event => this.onPointerUp(event, true));
    }

    onPointerDown(event) {
        if (!this.active || event.button !== 0 || !this.isAvailable() || !this.settings().showMarkers) return;
        const hit = this.hitTest(event.clientX, event.clientY);
        if (!hit) return;
        event.stopPropagation();
        event.preventDefault?.();
        this.endInteraction();
        const marker = this.state.markers[hit.id];
        const framePlane = this.framePlane();
        const start = this.pointerToFrame(event.clientX, event.clientY, framePlane);
        this.drag = {
            id: hit.id,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            offset: start ? { u: marker.u - start.u, v: marker.v - start.v } : { u: 0, v: 0 },
            framePlane,
            moved: false,
            context: null,
        };
        this.container?.setPointerCapture?.(event.pointerId);
        this.select(hit.id);
    }

    onPointerMove(event) {
        const drag = this.drag;
        if (!drag || event.pointerId !== drag.pointerId) return;
        event.stopPropagation();
        event.preventDefault?.();
        if (!drag.moved) {
            if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 2) return;
            drag.context = this.createContext();
            if (!drag.context) return;
            this.beginUndoStep();
            drag.moved = true;
        }
        const point = this.pointerToFrame(event.clientX, event.clientY, drag.framePlane);
        if (!point) return;
        const marker = this.state?.markers?.[drag.id];
        if (!marker) return;
        marker.u = point.u + drag.offset.u;
        marker.v = point.v + drag.offset.v;
        marker.enabled = true;
        marker.confidence = 1;
        this.requestSolveFrame();
        this.redraw();
    }

    onPointerUp(event, cancelled = false) {
        const drag = this.drag;
        if (!drag || (event.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
        event.stopPropagation?.();
        this.cancelSolveFrame();
        this.drag = null;
        if (this.container?.hasPointerCapture?.(drag.pointerId)) this.container.releasePointerCapture(drag.pointerId);
        if (!drag.moved) { this.redraw(); return; }
        // The final pass converges from the last visible pose; no jump on release.
        this.runSolve(drag.context, POSE_FITTING_FINAL_BUDGET);
        if (cancelled) this.message = "Drag ended by the browser; the last pose was kept.";
        else if (/_hip$/.test(drag.id)) {
            // One hip can only turn the rigid pelvis; sliding it needs the root.
            const settings = this.settings();
            const error = this.lastResult?.markers?.find(item => item.id === drag.id)?.error;
            if (!(settings.scope === "body" && settings.moveRoot) && error > F.POSE_FITTING_DEFAULTS.unreachedPx) {
                this.message = `${MARKER_DEFS.get(drag.id)?.label || drag.id}: the pelvis is rigid, so a hip only turns it. Turn on Move root (Whole body) to slide the pelvis.`;
            }
        }
        this.commitPose();
    }

    // ------------------------------------------------------------------
    // Drawing
    // ------------------------------------------------------------------

    redraw() {
        const overlay = this.overlay;
        if (!overlay?.getContext) return;
        const size = this.viewportSize();
        const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
        const width = Math.max(1, Math.round(size.width * ratio));
        const height = Math.max(1, Math.round(size.height * ratio));
        if (overlay.width !== width) overlay.width = width;
        if (overlay.height !== height) overlay.height = height;
        const ctx = overlay.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, width, height);
        const state = this.state;
        if (!this.active || !state || !state.settings?.showMarkers || !this.isAvailable()) return;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        const frame = this.frameSize();
        const framePlane = this.framePlane();
        const model = this.buildModel();
        const projector = this.projector();
        if (!model || !projector || !framePlane) return;
        const projected = F.projectFittingJoints(model, projector);
        const visible = this.visibleIds();
        const targets = {};
        for (const id of visible) {
            const marker = state.markers[id];
            if (marker?.u === null || marker?.u === undefined || marker.hidden) continue;
            targets[id] = this.frameToOverlay(marker.u, marker.v, framePlane);
        }
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(255,255,255,0.28)";
        for (const [a, b] of [...SKELETON, ...HAND_SKELETON]) {
            if (!targets[a] || !targets[b] || !state.markers[a].enabled || !state.markers[b].enabled) continue;
            ctx.beginPath();
            ctx.moveTo(targets[a].x, targets[a].y);
            ctx.lineTo(targets[b].x, targets[b].y);
            ctx.stroke();
        }
        for (const id of visible) {
            const marker = state.markers[id];
            const target = targets[id];
            if (!target) continue;
            const def = MARKER_DEFS.get(id);
            const hand = def.group === "hand";
            const handPoint = def.handPoint === true;
            const joint = projected[id];
            const actual = joint?.valid ? this.frameToOverlay(joint.x / frame.width, joint.y / frame.height, framePlane) : null;
            const error = joint?.valid ? Math.hypot(joint.x - marker.u * frame.width, joint.y - marker.v * frame.height) : Infinity;
            const color = marker.locked ? LOCKED_COLOR : (SIDE_COLORS[def.side] || "#ffffff");
            if (actual && marker.enabled) {
                ctx.strokeStyle = error > F.POSE_FITTING_DEFAULTS.unreachedPx ? "rgba(255,80,80,0.95)" : "rgba(255,255,255,0.6)";
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(actual.x, actual.y);
                ctx.lineTo(target.x, target.y);
                ctx.stroke();
                ctx.fillStyle = "rgba(255,255,255,0.85)";
                ctx.beginPath();
                ctx.arc(actual.x, actual.y, hand ? 1.5 : 2.5, 0, Math.PI * 2);
                ctx.fill();
            }
            const selected = id === this.selectedId;
            const weightGrow = Math.max(0, (marker.weight || 1) - 1);
            const radius = hand
                ? (selected ? 4.5 : 3.5) + Math.min(1.5, weightGrow / 2)
                : handPoint
                    ? (selected ? HAND_POINT_RADIUS + 1.5 : HAND_POINT_RADIUS) + Math.min(3, weightGrow)
                    : (selected ? 7 : 5.5) + Math.min(3, weightGrow);
            ctx.lineWidth = hand ? (marker.pinned ? 2 : 1.5) : (marker.pinned ? 3 : 2);
            ctx.strokeStyle = marker.enabled || marker.locked ? color : "rgba(160,160,160,0.7)";
            // The Hand ring stays almost hollow so a fingertip inside it remains visible.
            ctx.fillStyle = marker.enabled ? (handPoint ? `${color}22` : `${color}55`) : "rgba(0,0,0,0.25)";
            ctx.beginPath();
            if (marker.pinned) ctx.rect(target.x - radius, target.y - radius, radius * 2, radius * 2);
            else ctx.arc(target.x, target.y, radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
    }

    // ------------------------------------------------------------------
    // Panel
    // ------------------------------------------------------------------

    buildSection(content) {
        const doc = this.document;
        const make = (tag, className, text) => {
            const element = doc.createElement(tag);
            if (className) element.className = className;
            if (text !== undefined) element.textContent = text;
            return element;
        };
        const button = (text, title, onClick, extra = "") => {
            const element = make("button", `vnccs-ps-btn ${extra}`.trim(), text);
            element.type = "button";
            element.title = title;
            element.addEventListener("click", onClick);
            return element;
        };
        const row = (...children) => {
            const element = make("div", "vnccs-ps-fit-row");
            children.forEach(child => element.appendChild(child));
            return element;
        };
        // Same reset control as the other Pose Studio sliders (Camera Angle, FOV, ...):
        // set the default and replay input + change, so a reset is one ordinary gesture.
        const resetButton = (slider, value, title) => {
            const element = make("button", "vnccs-ps-reset-btn");
            element.type = "button";
            element.innerHTML = "↺";
            element.title = title;
            element.addEventListener("click", event => {
                event?.stopPropagation?.();
                slider.value = String(value);
                slider.dispatchEvent(new Event("input"));
                slider.dispatchEvent(new Event("change"));
            });
            return element;
        };
        const checkbox = (label, title, onChange) => {
            const wrap = make("label", "vnccs-ps-fit-check");
            wrap.title = title;
            const input = make("input");
            input.type = "checkbox";
            input.addEventListener("change", () => onChange(input.checked));
            wrap.appendChild(input);
            wrap.appendChild(make("span", "", label));
            return { wrap, input };
        };

        const toggle = button("Fitting Mode: Off", "Show and drag 2D markers that pull joints toward reference positions in the output frame", () => this.setActive(!this.active), "vnccs-ps-fit-toggle");
        const load = button("Load OpenPose JSON", "Create markers from OpenPose COCO-18 / BODY_25 JSON, with fingertips from hand keypoints when present (keypoints are mapped onto the output frame like the background image)", () => this.openFilePicker());
        const fit = button("Fit Pose", "Optimize joint angles so projected joints match the enabled markers", () => this.fitPose(), "primary");
        const reset = button("Reset Targets", "Move unpinned markers onto the current joints (creates markers when none exist)", () => this.resetTargets());
        const clear = button("Clear Constraints", "Remove all 2D markers from this pose", () => this.clearConstraints());
        content.appendChild(toggle);
        content.appendChild(row(load, fit));
        content.appendChild(row(reset, clear));

        const show = checkbox("Show markers", "Show the marker overlay", value => this.updateSettings({ showMarkers: value }));
        const moveRoot = checkbox("Move root", "Whole body only: allow the pelvis to translate (camera never moves)", value => this.updateSettings({ moveRoot: value }));
        const autoRefit = checkbox("Refit after FK/IK edits", "Run Fit Pose automatically when an FK/IK drag ends", value => this.updateSettings({ autoRefit: value }));
        const scope = make("select", "vnccs-ps-select vnccs-ps-fit-select");
        for (const [value, label] of [["limbs", "Limbs + head"], ["body", "Whole body"]]) {
            const option = make("option", "", label);
            option.value = value;
            scope.appendChild(option);
        }
        scope.title = "Limbs + head keeps the pelvis and spine fixed; Whole body also rotates them";
        scope.addEventListener("change", () => this.updateSettings({ scope: scope.value }));
        const fingertips = checkbox("Fingertips", "Show the ten fingertip markers; each bends its own finger. The L/R Hand markers turn the hands either way. Saved with the pose.", value => this.setFingertips(value));
        const hideHandles = checkbox("Hide bone handles", "While Fitting Mode is on, hide Pose Studio's bone drag points, IK helpers and rotation gizmo and ignore bone clicks in the viewport. Orbit, pan and zoom keep working. Saved with this node.", value => this.setHideBoneHandles(value));
        content.appendChild(row(make("span", "vnccs-ps-label", "Optimize"), scope));
        content.appendChild(row(show.wrap, moveRoot.wrap));
        content.appendChild(row(fingertips.wrap));
        content.appendChild(row(autoRefit.wrap));
        content.appendChild(row(hideHandles.wrap));

        const stiffnessLabel = make("span", "vnccs-ps-value", "1.00");
        const stiffness = make("input", "vnccs-ps-slider");
        stiffness.type = "range"; stiffness.min = "-2"; stiffness.max = "2"; stiffness.step = "0.05"; stiffness.value = "0";
        stiffness.title = "Pose prior: higher keeps the current 3D pose (depth) more, lower matches markers more freely";
        // One undo step per gesture (pointer drag, keys or reset); the value applies to the next solve.
        let stiffnessGesture = false;
        const beginStiffness = () => {
            if (stiffnessGesture) return;
            stiffnessGesture = true;
            this.endInteraction();
            this.beginUndoStep();
        };
        const finishStiffness = () => {
            if (!stiffnessGesture) return;
            stiffnessGesture = false;
            this.updateSettings({ stiffness: Math.pow(4, Number(stiffness.value)) });
        };
        stiffness.addEventListener("pointerdown", beginStiffness);
        stiffness.addEventListener("input", () => {
            beginStiffness();
            const value = Math.pow(4, Number(stiffness.value));
            stiffnessLabel.textContent = value.toFixed(2);
            if (this.state) this.state.settings.stiffness = value;
        });
        stiffness.addEventListener("change", finishStiffness);
        stiffness.addEventListener("pointerup", finishStiffness);
        stiffness.addEventListener("pointercancel", finishStiffness);
        stiffness.addEventListener("blur", finishStiffness);
        const stiffnessReset = resetButton(stiffness, 0, "Reset to 1.00");
        content.appendChild(row(make("span", "vnccs-ps-label", "Stiffness"), stiffness, stiffnessLabel, stiffnessReset));

        const status = make("div", "vnccs-ps-fit-status", "");
        content.appendChild(status);
        const list = make("div", "vnccs-ps-fit-list");
        content.appendChild(list);

        // Selected marker editor
        const editor = make("div", "vnccs-ps-fit-editor");
        const editorTitle = make("div", "vnccs-ps-label", "");
        const enabled = checkbox("Enabled", "Use this marker as a constraint", value => this.editMarker(this.selectedId, { enabled: value }));
        const pinned = checkbox("Pinned", `Hold this target with ${F.POSE_FITTING_DEFAULTS.pinFactor}x priority`, value => this.editMarker(this.selectedId, { pinned: value }));
        const weightLabel = make("span", "vnccs-ps-value", "1.0");
        const weight = make("input", "vnccs-ps-slider");
        weight.type = "range"; weight.min = "0"; weight.max = "5"; weight.step = "0.1"; weight.value = "1";
        weight.title = "Marker weight (priority when constraints conflict)";
        let weightGesture = false;
        const finishWeight = () => {
            if (!weightGesture) return;
            weightGesture = false;
            this.endLiveEdit();
        };
        weight.addEventListener("pointerdown", () => {
            if (weightGesture || !this.selectedId) return;
            weightGesture = true;
            this.endInteraction();
            this.beginUndoStep();
            this.beginLiveEdit();
        });
        weight.addEventListener("input", () => {
            if (!this.selectedId) return;
            if (!weightGesture) {
                weightGesture = true;
                this.endInteraction();
                this.beginUndoStep();
                this.beginLiveEdit();
            }
            weightLabel.textContent = Number(weight.value).toFixed(1);
            this.liveEdit(this.selectedId, { weight: Number(weight.value) });
        });
        weight.addEventListener("change", finishWeight);
        weight.addEventListener("pointerup", finishWeight);
        weight.addEventListener("pointercancel", finishWeight);
        weight.addEventListener("blur", finishWeight);
        const depth = make("select", "vnccs-ps-select vnccs-ps-fit-select");
        for (const [value, label] of [["auto", "Auto"], ["near", "Near"], ["far", "Far"]]) {
            const option = make("option", "", label);
            option.value = value;
            depth.appendChild(option);
        }
        depth.title = "Depth / bend hint: Near = this joint is closer to the camera than its parent joint, Far = farther";
        depth.addEventListener("change", () => this.editMarker(this.selectedId, { depth: depth.value }));
        const flip = button("Flip", FLIP_TITLE, () => this.flipDepth(this.selectedId));
        editor.appendChild(row(editorTitle));
        editor.appendChild(row(enabled.wrap, pinned.wrap));
        const weightReset = resetButton(weight, 1, "Reset to 1.0");
        editor.appendChild(row(make("span", "vnccs-ps-label", "Weight"), weight, weightLabel, weightReset));
        editor.appendChild(row(make("span", "vnccs-ps-label", "Depth"), depth, flip));
        content.appendChild(editor);

        const fileInput = make("input");
        fileInput.type = "file";
        fileInput.accept = ".json,application/json";
        fileInput.style.display = "none";
        fileInput.addEventListener("change", event => {
            this.handleFile(event.target.files?.[0]);
            event.target.value = "";
        });
        content.appendChild(fileInput);

        this.elements = {
            toggle, load, fit, reset, clear, scope, fingertips: fingertips.input, hideHandles: hideHandles.input, show: show.input, moveRoot: moveRoot.input, autoRefit: autoRefit.input,
            stiffness, stiffnessLabel, stiffnessReset, status, list, editor, editorTitle, enabled: enabled.input, pinned: pinned.input,
            weight, weightLabel, weightReset, depth, flip, fileInput, listRows: new Map(),
        };
        this.refreshPanel();
    }

    residuals() {
        const state = this.state;
        if (!state || !this.isAvailable()) return null;
        const model = this.buildModel();
        const projector = this.projector();
        if (!model || !projector) return null;
        const frame = this.frameSize();
        const projected = F.projectFittingJoints(model, projector);
        const out = {};
        for (const id of this.visibleIds()) {
            const marker = state.markers[id];
            const joint = projected[id];
            if (!marker || marker.u === null || !joint) continue;
            out[id] = joint.valid ? Math.hypot(joint.x - marker.u * frame.width, joint.y - marker.v * frame.height) : Infinity;
        }
        return out;
    }

    refreshPanel() {
        const e = this.elements;
        if (!e.toggle) return;
        const available = this.isAvailable();
        const state = this.state;
        const settings = this.settings();
        e.toggle.textContent = `Fitting Mode: ${this.active ? "On" : "Off"}`;
        e.toggle.classList?.toggle?.("active", this.active);
        for (const control of [e.load, e.reset, e.fit, e.clear]) control.disabled = !available;
        e.fit.disabled = !available || !state;
        e.clear.disabled = !state;
        e.scope.value = settings.scope;
        e.fingertips.checked = settings.fingertips === true;
        e.hideHandles.checked = this.hideBoneHandlesSetting();
        e.show.checked = settings.showMarkers !== false;
        e.moveRoot.checked = !!settings.moveRoot;
        e.moveRoot.disabled = settings.scope !== "body";
        e.autoRefit.checked = !!settings.autoRefit;
        const stiffness = settings.stiffness || 1;
        if (!this.live) {
            e.stiffness.value = String(Math.log(stiffness) / Math.log(4));
            e.stiffnessLabel.textContent = stiffness.toFixed(2);
        }

        const residuals = this.active ? this.residuals() : null;
        const visible = this.visibleIds();
        let summary = available ? "" : "Available in image mode once the model is loaded.";
        if (available && state && residuals) {
            const values = visible
                .filter(id => state.markers[id]?.enabled && Number.isFinite(residuals[id]))
                .map(id => [id, residuals[id]]);
            if (values.length) {
                const mean = values.reduce((sum, [, value]) => sum + value, 0) / values.length;
                const [worstId, worst] = values.reduce((best, item) => (item[1] > best[1] ? item : best));
                summary = `${values.length} markers · mean ${mean.toFixed(1)}px · max ${worst.toFixed(1)}px (${MARKER_DEFS.get(worstId).label})`;
            } else summary = "No enabled markers.";
            const timing = this.timingSummary();
            if (timing) summary += ` · solve ${timing.last.toFixed(1)}ms (p95 ${timing.p95.toFixed(1)})`;
        } else if (available && !state) {
            summary = "No markers. Load OpenPose JSON or Reset Targets.";
        }
        e.status.textContent = this.message ? `${summary}\n${this.message}` : summary;

        // Marker list: an outliner tree following the skeleton (Body > Neck > Head,
        // shoulders > elbows > wrists > hands > fingertips; hips > knees > ankles),
        // with collapse arrows and per-row Lock / Hide toggles that cascade down.
        e.list.style.display = state ? "" : "none";
        if (state) {
            const ordered = [];
            const walk = (nodes, depth, hiddenByParent) => {
                for (const node of nodes) {
                    ordered.push({ node, depth, shown: !hiddenByParent });
                    walk(node.children, depth + 1, hiddenByParent || this.collapsed.has(node.id));
                }
            };
            walk(F.fittingMarkerTree(settings), 0, false);
            const inTree = new Set(ordered.map(item => item.node.id));
            for (const { node, depth, shown } of ordered) {
                const item = e.listRows.get(node.id) || this.createListRow(node);
                item.row.style.display = shown ? "" : "none";
                item.row.style.paddingLeft = `${depth * 10}px`;
                const hasChildren = node.children.length > 0;
                const collapsed = this.collapsed.has(node.id);
                item.arrow.textContent = hasChildren ? (collapsed ? "\u25B8" : "\u25BE") : "";
                item.arrow.disabled = !hasChildren;
                item.arrow.title = hasChildren ? (collapsed ? "Expand" : "Collapse") : "";
                let locked, hidden;
                if (node.group) {
                    const ids = F.fittingTreeDescendants(node.id).filter(id => inTree.has(id) && state.markers[id]);
                    locked = ids.length > 0 && ids.every(id => state.markers[id].locked === true);
                    hidden = ids.length > 0 && ids.every(id => state.markers[id].hidden === true);
                    item.name.textContent = node.label;
                } else {
                    const marker = state.markers[node.id];
                    locked = marker.locked === true;
                    hidden = marker.hidden === true;
                    item.name.textContent = `${marker.pinned ? "\uD83D\uDCCC " : ""}${marker.enabled ? "" : "(off) "}${node.label}`;
                }
                this.setIconToggle(item.lock, locked, LOCK_ICONS);
                this.setIconToggle(item.eye, !hidden, EYE_ICONS);
                item.row.classList?.toggle?.("selected", node.id === this.selectedId);
                item.row.classList?.toggle?.("locked", locked);
                item.row.classList?.toggle?.("hidden-marker", hidden);
                item.row.dataset.locked = locked ? "1" : "0";
                item.row.dataset.hidden = hidden ? "1" : "0";
            }
            for (const [id, item] of e.listRows) if (!inTree.has(id)) item.row.style.display = "none";
            e.list.replaceChildren(...ordered.map(({ node }) => e.listRows.get(node.id).row),
                ...[...e.listRows].filter(([id]) => !inTree.has(id)).map(([, item]) => item.row));
        }

        const marker = visible.includes(this.selectedId) ? state?.markers?.[this.selectedId] : null;
        e.editor.style.display = marker ? "" : "none";
        if (marker) {
            const def = MARKER_DEFS.get(this.selectedId);
            e.editorTitle.textContent = def.label;
            e.enabled.checked = !!marker.enabled;
            e.pinned.checked = !!marker.pinned;
            if (!this.live) {
                e.weight.value = String(marker.weight);
                e.weightLabel.textContent = Number(marker.weight).toFixed(1);
            }
            e.depth.value = marker.depth;
            e.depth.disabled = !def.parent;
            // Grey out Flip when it would be refused; keep the last answer while a drag or slider is live.
            if (!this.live && !this.drag) {
                const reason = !def.flip || !available ? null : this.flipCheck(this.selectedId).reason;
                e.flip.disabled = !def.flip || !available || !!reason;
                e.flip.title = reason || FLIP_TITLE;
            }
        }
    }

    /** One outliner row: collapse arrow, name, Lock and Hide (eye) toggles. */
    createListRow(node) {
        const doc = this.document;
        const make = (tag, className) => {
            const element = doc.createElement(tag);
            element.className = className;
            return element;
        };
        const row = make("div", node.group ? "vnccs-ps-fit-node group" : "vnccs-ps-fit-node");
        row.dataset.id = node.id;
        const arrow = make("button", "vnccs-ps-fit-twisty");
        arrow.type = "button";
        arrow.addEventListener("click", event => { event.stopPropagation?.(); this.toggleCollapsed(node.id); });
        const name = make("span", "vnccs-ps-fit-name");
        const lock = make("button", "vnccs-ps-fit-icon lock");
        lock.type = "button";
        lock.title = "Lock: the marker (and the ones below it) cannot be grabbed in the viewport, and Reset Targets / OpenPose import leave it in place. It still constrains the solve.";
        lock.addEventListener("click", event => { event.stopPropagation?.(); this.toggleMarkerFlag(node.id, "locked"); });
        const eye = make("button", "vnccs-ps-fit-icon eye");
        eye.type = "button";
        eye.title = "Hide: the marker (and the ones below it) is not drawn and cannot be grabbed. Display only: it still constrains the solve (use Enabled to turn a constraint off).";
        eye.addEventListener("click", event => { event.stopPropagation?.(); this.toggleMarkerFlag(node.id, "hidden"); });
        row.appendChild(arrow);
        row.appendChild(name);
        row.appendChild(lock);
        row.appendChild(eye);
        if (!node.group) row.addEventListener("click", () => this.select(node.id));
        const item = { row, arrow, name, lock, eye };
        this.elements.listRows.set(node.id, item);
        return item;
    }

    setIconToggle(button, on, icons) {
        const state = on ? "1" : "0";
        if (button.dataset.on === state) return;
        button.dataset.on = state;
        button.innerHTML = on ? icons.on : icons.off;
        button.setAttribute?.("aria-pressed", on ? "true" : "false");
    }

    dispose() {
        this.endInteraction();
        this.viewer?.setBoneHandlesHidden?.(false);
        for (const remove of this._removeListeners.splice(0)) remove();
        this.overlay?.remove?.();
        this.overlay = null;
        this.host = null;
    }
}
