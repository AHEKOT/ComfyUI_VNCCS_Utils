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
import { detectAndParseJSON } from "./imports/openpose.js";
import * as F from "./pose_fitting2d.mjs";

const SIDE_COLORS = { l: "#4fd1ff", r: "#ff9f43", c: "#ffe066" };
const SKELETON = [
    ["head", "neck"], ["neck", "r_shoulder"], ["r_shoulder", "r_elbow"], ["r_elbow", "r_wrist"],
    ["neck", "l_shoulder"], ["l_shoulder", "l_elbow"], ["l_elbow", "l_wrist"],
    ["r_shoulder", "r_hip"], ["r_hip", "r_knee"], ["r_knee", "r_ankle"],
    ["l_shoulder", "l_hip"], ["l_hip", "l_knee"], ["l_knee", "l_ankle"], ["r_hip", "l_hip"],
];
const HIT_RADIUS = 11;
export const POSE_FITTING_FRAME_BUDGET = Object.freeze({ iterations: 8, timeMs: 6 });
export const POSE_FITTING_FINAL_BUDGET = Object.freeze({ iterations: 80, timeMs: 80 });
const MARKER_DEFS = new Map(F.POSE_FITTING_MARKERS.map(def => [def.id, def]));

const now = () => (typeof performance !== "undefined" && performance?.now ? performance.now() : Date.now());

export class PoseFitting2DController {
    constructor(host, env = {}) {
        this.host = host;
        this.document = env.document || globalThis.document;
        this.requestFrame = env.requestAnimationFrame || (callback => globalThis.requestAnimationFrame(callback));
        this.cancelFrame = env.cancelAnimationFrame || (id => globalThis.cancelAnimationFrame(id));
        this.active = false;
        this.selectedId = null;
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

    buildModel() {
        const offset = this.noseOffset();
        const snapshot = F.snapshotViewerRig(this.viewer, offset ? { head: offset } : {});
        return snapshot ? F.buildFittingModel(snapshot) : null;
    }

    projector() {
        const frame = this.frameSize();
        return F.captureCameraProjector(this.viewer?.captureCamera, frame.width, frame.height);
    }

    solverOptions(extra = {}) {
        const settings = this.settings();
        return {
            scope: settings.scope,
            moveRoot: settings.moveRoot,
            poseStiffness: F.POSE_FITTING_DEFAULTS.poseStiffness * (settings.stiffness || 1),
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
        return { model, projector, anchor, state: anchor };
    }

    runSolve(context, budget) {
        const started = now();
        const result = F.solvePoseFitting(context.model, context.projector, this.solverMarkers(), this.solverOptions({
            anchor: context.anchor,
            initialState: context.state,
            maxIterations: budget.iterations,
            timeBudgetMs: budget.timeMs,
            tolerance: 1e-7,
        }));
        this.recordTiming(now() - started);
        // Reject broken results and keep the last valid pose visible.
        const broken = !result.valid || !Number.isFinite(result.energy)
            || result.energy > result.initialEnergy * 1.5 + 1e-6
            || result.maxLimitViolation > 25;
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
        this.message = next ? "Drag markers in the viewport. Bones stay selectable elsewhere." : "";
        this.redraw();
        this.refreshPanel();
    }

    targetsFromPose(state, options) {
        const model = this.buildModel();
        const projector = this.projector();
        if (!model || !projector) return state;
        return F.resetFittingTargets(state, F.projectFittingJoints(model, projector), this.frameSize(), options);
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

    flipDepth(id) {
        const marker = this.state?.markers?.[id];
        if (!marker || !this.isAvailable()) return;
        this.endInteraction();
        const model = this.buildModel();
        const projector = this.projector();
        const flipped = model && projector ? F.flipMarkerDepth(model, projector, id) : null;
        if (!flipped) {
            this.message = MARKER_DEFS.get(id)?.flip
                ? "Flip refused: the mirrored segment would break joint limits (e.g. a twisted shoulder or hyperextended elbow/knee)."
                : "This marker has no single segment to flip.";
            this.refreshPanel();
            return;
        }
        this.beginUndoStep();
        F.applyFittingStateToViewer(this.viewer, model, flipped);
        marker.depth = F.markerDepthRelation(model, projector, id, flipped);
        const context = this.createContext();
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
        const imported = F.fittingStateFromOpenPose(parsed, { frame, previous: this.state });
        if (!imported) throw new Error("The JSON has no usable body keypoints.");
        // Missing keypoints get the current joint position but stay disabled.
        const filled = this.targetsFromPose(F.createFittingState(), { keepPinned: false, enable: false });
        for (const id of F.POSE_FITTING_MARKER_IDS) {
            const marker = imported.state.markers[id];
            if (marker.u === null && filled?.markers?.[id]?.u !== null) {
                Object.assign(marker, { u: filled.markers[id].u, v: filled.markers[id].v, enabled: false, confidence: 0 });
            }
        }
        this.endInteraction();
        this.beginUndoStep();
        this.state = imported.state;
        this.setActive(true);
        this.message = `Loaded ${imported.found} keypoints (${parsed.format || parsed.source || "pose"}). Press Fit Pose.`
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
        if (!(distance > camera.near)) distance = 45;
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
        const rect = this.canvas.getBoundingClientRect();
        const x = clientX - rect.left, y = clientY - rect.top;
        const framePlane = this.framePlane();
        let best = null;
        for (const id of F.POSE_FITTING_MARKER_IDS) {
            const marker = this.state.markers[id];
            if (!marker || marker.u === null) continue;
            const position = this.frameToOverlay(marker.u, marker.v, framePlane);
            if (!position) continue;
            const distance = Math.hypot(position.x - x, position.y - y);
            if (distance <= HIT_RADIUS && (!best || distance < best.distance)) best = { id, distance };
        }
        return best;
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
        const targets = {};
        for (const id of F.POSE_FITTING_MARKER_IDS) {
            const marker = state.markers[id];
            if (marker?.u === null || marker?.u === undefined) continue;
            targets[id] = this.frameToOverlay(marker.u, marker.v, framePlane);
        }
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(255,255,255,0.28)";
        for (const [a, b] of SKELETON) {
            if (!targets[a] || !targets[b] || !state.markers[a].enabled || !state.markers[b].enabled) continue;
            ctx.beginPath();
            ctx.moveTo(targets[a].x, targets[a].y);
            ctx.lineTo(targets[b].x, targets[b].y);
            ctx.stroke();
        }
        for (const id of F.POSE_FITTING_MARKER_IDS) {
            const marker = state.markers[id];
            const target = targets[id];
            if (!target) continue;
            const def = MARKER_DEFS.get(id);
            const joint = projected[id];
            const actual = joint?.valid ? this.frameToOverlay(joint.x / frame.width, joint.y / frame.height, framePlane) : null;
            const error = joint?.valid ? Math.hypot(joint.x - marker.u * frame.width, joint.y - marker.v * frame.height) : Infinity;
            const color = SIDE_COLORS[def.side] || "#ffffff";
            if (actual && marker.enabled) {
                ctx.strokeStyle = error > F.POSE_FITTING_DEFAULTS.unreachedPx ? "rgba(255,80,80,0.95)" : "rgba(255,255,255,0.6)";
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(actual.x, actual.y);
                ctx.lineTo(target.x, target.y);
                ctx.stroke();
                ctx.fillStyle = "rgba(255,255,255,0.85)";
                ctx.beginPath();
                ctx.arc(actual.x, actual.y, 2.5, 0, Math.PI * 2);
                ctx.fill();
            }
            const selected = id === this.selectedId;
            const radius = (selected ? 7 : 5.5) + Math.min(3, Math.max(0, (marker.weight || 1) - 1));
            ctx.lineWidth = marker.pinned ? 3 : 2;
            ctx.strokeStyle = marker.enabled ? color : "rgba(160,160,160,0.7)";
            ctx.fillStyle = marker.enabled ? `${color}55` : "rgba(0,0,0,0.25)";
            ctx.beginPath();
            if (marker.pinned) ctx.rect(target.x - radius, target.y - radius, radius * 2, radius * 2);
            else ctx.arc(target.x, target.y, radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            if (selected || (marker.enabled && error > F.POSE_FITTING_DEFAULTS.unreachedPx)) {
                ctx.font = "11px sans-serif";
                ctx.fillStyle = "#ffffff";
                const label = Number.isFinite(error) ? `${def.label} ${error.toFixed(1)}px` : `${def.label} (behind camera)`;
                ctx.fillText(label, target.x + radius + 4, target.y - radius - 2);
            }
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
        const load = button("Load OpenPose JSON", "Create markers from OpenPose COCO-18 / BODY_25 JSON (keypoints are mapped onto the output frame like the background image)", () => this.openFilePicker());
        const fit = button("Fit Pose", "Optimize joint angles so projected joints match the enabled markers", () => this.fitPose(), "primary");
        const reset = button("Reset Targets", "Move unpinned markers onto the current joints (creates markers when none exist)", () => this.resetTargets());
        const clear = button("Clear Constraints", "Remove all 2D markers from this pose", () => this.clearConstraints());
        content.appendChild(toggle);
        content.appendChild(row(load, fit));
        content.appendChild(row(reset, clear));

        const show = checkbox("Show markers", "Show the marker overlay", value => this.updateSettings({ showMarkers: value }));
        const moveRoot = checkbox("Move root", "Whole body only: allow the pelvis to translate (camera never moves)", value => this.updateSettings({ moveRoot: value }));
        const autoRefit = checkbox("Refit after FK/IK edits", "Run Fit Pose automatically when an FK/IK drag ends", value => this.updateSettings({ autoRefit: value }));
        const scope = make("select", "vnccs-ps-fit-select");
        for (const [value, label] of [["limbs", "Limbs + head"], ["body", "Whole body"]]) {
            const option = make("option", "", label);
            option.value = value;
            scope.appendChild(option);
        }
        scope.title = "Limbs + head keeps the pelvis and spine fixed; Whole body also rotates them";
        scope.addEventListener("change", () => this.updateSettings({ scope: scope.value }));
        content.appendChild(row(make("span", "vnccs-ps-label", "Optimize"), scope));
        content.appendChild(row(show.wrap, moveRoot.wrap));
        content.appendChild(row(autoRefit.wrap));

        const stiffnessLabel = make("span", "vnccs-ps-value", "1.00");
        const stiffness = make("input", "vnccs-ps-slider");
        stiffness.type = "range"; stiffness.min = "-2"; stiffness.max = "2"; stiffness.step = "0.05"; stiffness.value = "0";
        stiffness.title = "Pose prior: higher keeps the current 3D pose (depth) more, lower matches markers more freely";
        stiffness.addEventListener("input", () => {
            const value = Math.pow(4, Number(stiffness.value));
            stiffnessLabel.textContent = value.toFixed(2);
            if (this.state) this.state.settings.stiffness = value;
        });
        stiffness.addEventListener("change", () => this.updateSettings({ stiffness: Math.pow(4, Number(stiffness.value)) }));
        content.appendChild(row(make("span", "vnccs-ps-label", "Stiffness"), stiffness, stiffnessLabel));

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
        const depth = make("select", "vnccs-ps-fit-select");
        for (const [value, label] of [["auto", "Auto"], ["near", "Near"], ["far", "Far"]]) {
            const option = make("option", "", label);
            option.value = value;
            depth.appendChild(option);
        }
        depth.title = "Depth / bend hint: Near = this joint is closer to the camera than its parent joint, Far = farther";
        depth.addEventListener("change", () => this.editMarker(this.selectedId, { depth: depth.value }));
        const flip = button("Flip", "Mirror this segment's depth across the camera ray (keeps the 2D position), then refit", () => this.flipDepth(this.selectedId));
        const markerError = make("span", "vnccs-ps-value", "");
        editor.appendChild(row(editorTitle, markerError));
        editor.appendChild(row(enabled.wrap, pinned.wrap));
        editor.appendChild(row(make("span", "vnccs-ps-label", "Weight"), weight, weightLabel));
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
            toggle, load, fit, reset, clear, scope, show: show.input, moveRoot: moveRoot.input, autoRefit: autoRefit.input,
            stiffness, stiffnessLabel, status, list, editor, editorTitle, enabled: enabled.input, pinned: pinned.input,
            weight, weightLabel, depth, flip, markerError, fileInput, listRows: new Map(),
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
        for (const id of F.POSE_FITTING_MARKER_IDS) {
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
        let summary = available ? "" : "Available in image mode once the model is loaded.";
        if (available && state && residuals) {
            const values = F.POSE_FITTING_MARKER_IDS
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

        // Marker list: enable, pin, residual
        e.list.style.display = state ? "" : "none";
        if (state) {
            for (const def of F.POSE_FITTING_MARKERS) {
                let item = e.listRows.get(def.id);
                if (!item) {
                    const rowElement = this.document.createElement("div");
                    rowElement.className = "vnccs-ps-fit-item";
                    const name = this.document.createElement("span");
                    name.textContent = def.label;
                    const value = this.document.createElement("span");
                    value.className = "vnccs-ps-fit-error";
                    rowElement.appendChild(name);
                    rowElement.appendChild(value);
                    rowElement.addEventListener("click", () => this.select(def.id));
                    e.list.appendChild(rowElement);
                    item = { row: rowElement, name, value };
                    e.listRows.set(def.id, item);
                }
                const marker = state.markers[def.id];
                const residual = residuals?.[def.id];
                const flags = `${marker.pinned ? "📌 " : ""}${marker.enabled ? "" : "(off) "}`;
                item.name.textContent = `${flags}${def.label}`;
                item.value.textContent = marker.u === null ? "—" : Number.isFinite(residual) ? `${residual.toFixed(1)}px` : (residual === Infinity ? "behind" : "");
                item.row.classList?.toggle?.("selected", def.id === this.selectedId);
                item.row.classList?.toggle?.("unreached", marker.enabled && residual > F.POSE_FITTING_DEFAULTS.unreachedPx);
            }
        }

        const marker = state?.markers?.[this.selectedId];
        e.editor.style.display = marker ? "" : "none";
        if (marker) {
            const def = MARKER_DEFS.get(this.selectedId);
            e.editorTitle.textContent = def.label;
            const residual = residuals?.[this.selectedId];
            e.markerError.textContent = Number.isFinite(residual) ? `${residual.toFixed(1)}px` : "";
            e.enabled.checked = !!marker.enabled;
            e.pinned.checked = !!marker.pinned;
            if (!this.live) {
                e.weight.value = String(marker.weight);
                e.weightLabel.textContent = Number(marker.weight).toFixed(1);
            }
            e.depth.value = marker.depth;
            e.depth.disabled = !def.parent;
            e.flip.disabled = !def.flip || !available;
        }
    }

    dispose() {
        this.endInteraction();
        for (const remove of this._removeListeners.splice(0)) remove();
        this.overlay?.remove?.();
        this.overlay = null;
        this.host = null;
    }
}
