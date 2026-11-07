/**
 * Pose Studio whole-character transform: viewport Pose / Move / Rotate modes,
 * a TransformControls gizmo on the selected character, and Position / Rotation
 * fields in the Characters panel.
 *
 * Data model (no duplicate state):
 * - Position X / Y are the character placement the Positioning Radar edits
 *   (`exportParams.cam_offset_x / y`, stored per pose tab in `cameraParams`).
 * - Position Z is `character.transform.z` (one depth per character).
 * - Rotation is the existing per-pose `modelRotation` (Euler XYZ, degrees).
 * Every edit goes through `persistActivePoseCameraParams()` and
 * `viewer.setModelRotation()`, the same paths the Radar and the Model Rotation
 * sliders use, so saved data, Radar and sliders stay consistent.
 */
import {
    CHARACTER_POSITION_LIMITS,
    MODEL_ROTATION_ORDER,
    clampCharacterPosition,
    normalizeCharacterTransformMode,
    normalizeCharacterTransformSpace,
    rotateCharacterAboutPivot,
    setCharacterRotationAboutPivot,
    translateCharacterPosition,
    wrapDegrees,
} from "./character_transform.mjs?v=20261102.2";

// Render layer seen only by the editor camera: the gizmo never reaches a capture.
export const CHARACTER_GIZMO_EDITOR_LAYER = 2;

const STYLE_ID = "vnccs-ps-character-transform-style";
const STYLE = `
.vnccs-ps-transform-toolbar {
    --vnccs-ps-toolbar-scale: calc(0.7 * var(--vnccs-ps-ui-scale, 1));
    position: absolute; top: 12px; left: 50%; z-index: 40;
    zoom: var(--vnccs-ps-toolbar-scale);
    transform: translateX(-50%);
    width: max-content; max-width: calc(100% - 24px); box-sizing: border-box;
    display: flex; flex-direction: column; align-items: center; gap: 4px;
    padding: 6px; border-radius: var(--ps-radius-sm, 8px);
    background: rgba(10, 10, 16, 0.78); border: 1px solid var(--ps-border, rgba(255,255,255,0.06));
    backdrop-filter: blur(6px);
}
.vnccs-ps-sam-cam-banner.vnccs-sam-visible ~ .vnccs-ps-transform-toolbar {
    top: calc(40px / var(--vnccs-ps-toolbar-scale) + 12px);
}
.vnccs-ps-transform-toolbar .vnccs-ps-toggle {
    --vnccs-ps-mode-gap: 4px;
    position: relative; isolation: isolate;
    display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
    max-width: 100%; gap: var(--vnccs-ps-mode-gap);
    background: transparent; border: none; padding: 0;
}
.vnccs-ps-transform-toolbar .vnccs-ps-toggle:has(> [data-mode="move"][aria-pressed="true"]) {
    --vnccs-ps-mode-index: 1;
}
.vnccs-ps-transform-toolbar .vnccs-ps-toggle:has(> [data-mode="rotate"][aria-pressed="true"]) {
    --vnccs-ps-mode-index: 2;
}
.vnccs-ps-transform-toolbar .vnccs-ps-toggle::before {
    content: ""; position: absolute; inset: 0 auto 0 0; z-index: -1;
    width: calc((100% - 2 * var(--vnccs-ps-mode-gap)) / 3);
    border-radius: 12px;
    background: linear-gradient(135deg, var(--ps-accent), var(--ps-accent-hover));
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12), 0 2px 8px var(--ps-accent-glow);
    pointer-events: none;
    transform: translateX(calc(var(--vnccs-ps-mode-index, 0) * (100% + var(--vnccs-ps-mode-gap))));
    transition: transform 280ms cubic-bezier(0.22, 1, 0.36, 1);
}
.vnccs-ps-transform-toolbar .vnccs-ps-toggle-btn {
    flex: 0 0 auto; min-width: 92px; padding: 8px 18px; font-size: 20px; border-radius: 12px;
}
.vnccs-ps-transform-toolbar .vnccs-ps-toggle .vnccs-ps-toggle-btn {
    transition: color 180ms ease;
}
.vnccs-ps-transform-toolbar .vnccs-ps-toggle-btn.active {
    background: transparent; box-shadow: none;
}
@media (prefers-reduced-motion: reduce) {
    .vnccs-ps-transform-toolbar .vnccs-ps-toggle::before,
    .vnccs-ps-transform-toolbar .vnccs-ps-toggle .vnccs-ps-toggle-btn {
        transition: none;
    }
}
.vnccs-ps-transform-toolbar .vnccs-ps-toggle-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.vnccs-ps-transform-toolbar .vnccs-ps-transform-space { min-width: 96px; }
.vnccs-ps-transform-space[hidden] { display: none; }
.vnccs-ps-character-transform { margin-top: 8px; display: flex; flex-direction: column; gap: 5px; }
.vnccs-ps-character-transform-title {
    display: flex; justify-content: space-between; align-items: baseline;
    font-size: 10px; font-weight: 600; color: var(--ps-text, #e8e8f0);
}
.vnccs-ps-character-transform-title small { font-weight: 400; color: var(--ps-text-muted, #9898a8); }
.vnccs-ps-character-transform-row { display: flex; flex-direction: column; gap: 3px; }
.vnccs-ps-character-transform-row > span { font-size: 9px; color: var(--ps-text-muted, #9898a8); line-height: 1.2; }
.vnccs-ps-character-transform-axes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
.vnccs-ps-character-transform-axes label { position: relative; display: block; min-width: 0; }
.vnccs-ps-character-transform-axes label b {
    position: absolute; left: 5px; top: 50%; transform: translateY(-50%);
    font-size: 8px; color: var(--ps-text-dim, #5e5e70); pointer-events: none;
}
.vnccs-ps-character-transform-axes input.vnccs-ps-input {
    padding: 4px 3px 4px 13px; font-family: var(--ps-font-mono, monospace); appearance: textfield; -moz-appearance: textfield;
}
.vnccs-ps-character-transform-axes input.vnccs-ps-input::-webkit-inner-spin-button,
.vnccs-ps-character-transform-axes input.vnccs-ps-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.vnccs-ps-character-transform-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.vnccs-ps-character-transform-actions .vnccs-ps-btn { justify-content: center; font-size: 9px; padding: 4px 6px; }
.vnccs-ps-character-transform-note { font-size: 9px; color: var(--ps-warning, #ffaa00); }
.vnccs-ps-character-transform-note[hidden] { display: none; }
`;

const AXES = ["x", "y", "z"];
const POINTER_EVENTS = ["pointerdown", "pointermove", "pointerup"];
const MODE_LABELS = { pose: "Pose", move: "Move", rotate: "Rotate" };
const MODE_TITLES = {
    pose: "Pose: edit joints with FK / IK",
    move: "Move: drag the gizmo to move the selected character (axis, plane or center)",
    rotate: "Rotate: drag a ring to rotate the selected character about its pelvis",
};
const CLICK_TOLERANCE_PX = 4;
const NO_CHANGE_EPSILON = 1e-9;
// acos near 1 resolves about 1e-8 rad, so a zero rotation can read slightly above zero.
const NO_ROTATION_RADIANS = 1e-6;

const format = (value, digits) => String(Number(Number(value || 0).toFixed(digits)));
const samePosition = (a, b) => AXES.every(axis => Math.abs(a[axis] - b[axis]) < NO_CHANGE_EPSILON);

export class PoseCharacterTransformController {
    constructor(widget, { document: doc = globalThis.document } = {}) {
        this.widget = widget;
        this.document = doc;
        this.mode = "pose";
        this.space = "world";
        this.viewer = null;
        this.gizmo = null;
        this.proxy = null;
        this.toolbar = null;
        this.modeButtons = {};
        this.spaceButton = null;
        this.fields = null;
        this._drag = null;
        this._pick = null;
        this._fieldSignature = "";
        this._fieldEditActive = false;
        this._finishFieldEditHook = () => this.finishFieldEdit();
        this._finishDragHook = event => {
            if (!event || event.pointerId === this._pointerId) this.finishDrag();
        };
        this._toolbarSignature = "";
        this._pivotBone = null;
        this._pivotMesh = null;
        this._pointerId = null;
        this._clearedCharacterId = null;
        this._onCanvasPointerCapture = event => this.handleCanvasPointerCapture(event);
        this._onCanvasPointerUp = event => this.handleCanvasPointerUp(event);
        this._onPointerInterrupted = event => this.handlePointerInterrupted(event);
    }

    get enabled() {
        // Inside UniCanvas the mannequin is already placed in the image layer.
        return this.widget?.host?.embedded !== true;
    }

    isAvailable() {
        const widget = this.widget;
        return this.enabled
            && !widget.isAnimationMode?.()
            && !widget._switchingCharacter
            && !widget._hydratingCharacterScene
            && !!this.viewer?.isInitialized?.()
            && !!this.viewer.skinnedMesh;
    }

    unavailableReason() {
        if (this.widget.isAnimationMode?.()) {
            return "Move and Rotate are available in Image mode. Animation keys are never changed here.";
        }
        return "";
    }

    // --- Setup ---------------------------------------------------------------

    attach(viewer, container) {
        if (!this.enabled || !viewer) return;
        this.viewer = viewer;
        viewer.characterGizmo = this;
        if (container && this.document) {
            this.installStyle();
            this.toolbar = this.createToolbar();
            container.appendChild(this.toolbar);
        }
        this.syncToolbar(true);
    }

    installStyle() {
        const doc = this.document;
        if (!doc?.head || doc.getElementById?.(STYLE_ID)) return;
        const style = doc.createElement("style");
        style.id = STYLE_ID;
        style.textContent = STYLE;
        doc.head.appendChild(style);
    }

    /** Create the TransformControls gizmo once the viewer has Three.js. */
    onViewerReady() {
        const viewer = this.viewer;
        if (!viewer || this.gizmo || !viewer.THREE || !viewer.TransformControls || !viewer.scene) return false;
        const THREE = viewer.THREE;
        const proxy = new THREE.Object3D();
        proxy.name = "VNCCS Character Transform Pivot";
        const updateProxyMatrix = proxy.updateMatrixWorld;
        // TransformControls reads the attached object's matrix while the scene
        // updates. Follow the character there so the gizmo never trails it.
        proxy.updateMatrixWorld = force => {
            if (!this._drag) this.syncProxyToCharacter();
            updateProxyMatrix.call(proxy, force);
        };
        viewer.scene.add(proxy);
        this.proxy = proxy;

        // Filter other pointers before TransformControls can move or end our drag.
        for (const type of POINTER_EVENTS) {
            viewer.canvas?.addEventListener?.(type, this._onCanvasPointerCapture, true);
        }
        const gizmo = new viewer.TransformControls(viewer.camera, viewer.canvas);
        gizmo.name = "VNCCS Character Transform Gizmo";
        gizmo.setSize(0.8);
        gizmo.setSpace(this.space);
        const visual = [gizmo._gizmo?.gizmo, gizmo._gizmo?.helper];
        for (const group of visual) {
            for (const handles of Object.values(group || {})) {
                handles?.traverse?.(object => object.layers.set(CHARACTER_GIZMO_EDITOR_LAYER));
            }
        }
        viewer.camera?.layers?.enable(CHARACTER_GIZMO_EDITOR_LAYER);
        gizmo.enabled = false;
        viewer.scene.add(gizmo);
        gizmo.addEventListener("dragging-changed", event => this.handleDraggingChanged(event.value));
        gizmo.addEventListener("objectChange", () => this.handleObjectChange());
        gizmo.addEventListener("change", () => viewer.requestRender?.());
        this.gizmo = gizmo;
        viewer.canvas?.addEventListener?.("pointerup", this._onCanvasPointerUp);
        viewer.canvas?.addEventListener?.("pointercancel", this._onPointerInterrupted);
        viewer.canvas?.addEventListener?.("lostpointercapture", this._onPointerInterrupted);
        this.applyGizmoMode();
        return true;
    }

    dispose() {
        this.finishDrag();
        for (const type of POINTER_EVENTS) {
            this.viewer?.canvas?.removeEventListener?.(type, this._onCanvasPointerCapture, true);
        }
        this.viewer?.canvas?.removeEventListener?.("pointerup", this._onCanvasPointerUp);
        this.viewer?.canvas?.removeEventListener?.("pointercancel", this._onPointerInterrupted);
        this.viewer?.canvas?.removeEventListener?.("lostpointercapture", this._onPointerInterrupted);
        if (this.gizmo) {
            this.gizmo.detach();
            this.gizmo.parent?.remove(this.gizmo);
            this.gizmo.dispose();
        }
        this.proxy?.parent?.remove(this.proxy);
        this.toolbar?.remove?.();
        if (this.viewer?.characterGizmo === this) this.viewer.characterGizmo = null;
        this.gizmo = null;
        this.proxy = null;
        this.viewer = null;
    }

    // --- Mode ----------------------------------------------------------------

    /** Returns true when the requested mode is in effect afterwards. */
    setMode(mode) {
        const requested = normalizeCharacterTransformMode(mode);
        const next = requested !== "pose" && !this.isAvailable() ? "pose" : requested;
        if (!this._drag) this._clearedCharacterId = null;
        if (this._drag || next === this.mode) {
            if (!this._drag) this.applyGizmoMode();
            this.syncToolbar(true);
            return this.mode === requested;
        }
        this.mode = next;
        if (next !== "pose") this.releaseBoneInput();
        this.applyGizmoMode();
        this.syncToolbar(true);
        this.viewer?.requestRender?.();
        return this.mode === requested;
    }

    setSpace(space) {
        this.space = normalizeCharacterTransformSpace(space);
        this.gizmo?.setSpace(this.space);
        this.syncToolbar(true);
        this.viewer?.requestRender?.();
    }

    suppressesBoneInput() {
        return this.mode !== "pose";
    }

    releaseBoneInput() {
        const viewer = this.viewer;
        if (!viewer) return;
        if (viewer.selectedIKEffector) viewer.deselectIKEffector?.();
        if (viewer.selectedPoleTarget) viewer.deselectPoleTarget?.();
        viewer.deselectBone?.({ source: "viewer" });
        viewer.transform?.detach?.();
        if (viewer.hoveredBoneName || viewer._hoveredHandSide) {
            viewer.hoveredBoneName = null;
            viewer._updateHoveredHand?.(null);
            viewer.updateMarkers?.();
        }
        this.widget.hideHandControlPopover?.();
    }

    applyGizmoMode() {
        const gizmo = this.gizmo;
        if (!gizmo) return;
        if (this.mode === "pose") {
            gizmo.detach();
            gizmo.enabled = false;
            return;
        }
        gizmo.setMode(this.mode === "move" ? "translate" : "rotate");
        gizmo.setSpace(this.space);
        if (this.isSelectionCleared()) {
            if (gizmo.object) gizmo.detach();
        } else if (gizmo.object !== this.proxy) {
            gizmo.attach(this.proxy);
        }
        gizmo.enabled = this.isAvailable();
    }

    isSelectionCleared() {
        return this._clearedCharacterId !== null && this._clearedCharacterId === this.activeCharacter()?.id;
    }

    /** Hide the gizmo until a character is clicked or selected again. */
    clearSelection() {
        this._clearedCharacterId = this.activeCharacter()?.id ?? null;
        this.applyGizmoMode();
        this.viewer?.requestRender?.();
    }

    // --- Character placement --------------------------------------------------

    activeCharacter() {
        return this.widget.getActiveCharacter?.() || null;
    }

    currentPosition() {
        const character = this.activeCharacter();
        const transform = character?.transform || {};
        return clampCharacterPosition({
            x: this.widget.exportParams?.cam_offset_x ?? transform.x,
            y: this.widget.exportParams?.cam_offset_y ?? transform.y,
            z: transform.z,
        });
    }

    currentRotation() {
        const rotation = this.viewer?.modelRotation || {};
        return { x: Number(rotation.x) || 0, y: Number(rotation.y) || 0, z: Number(rotation.z) || 0 };
    }

    pivotBone() {
        const viewer = this.viewer;
        const mesh = viewer?.skinnedMesh;
        if (!mesh) return null;
        if (this._pivotMesh === mesh && this._pivotBone?.parent) return this._pivotBone;
        // Same choice as the Hips IK effector: the first child of the root bone.
        const root = (viewer.boneList || []).find(bone => !bone.parent?.isBone);
        this._pivotBone = root?.children?.find(child => child.isBone) || root || null;
        this._pivotMesh = mesh;
        return this._pivotBone;
    }

    /** World-space pelvis position: the rotate pivot and the gizmo origin. */
    pivotWorldPosition(target = new this.viewer.THREE.Vector3()) {
        const mesh = this.viewer?.skinnedMesh;
        const bone = this.pivotBone();
        if (bone) return bone.getWorldPosition(target);
        if (mesh) return mesh.getWorldPosition(target);
        return target.set(0, 0, 0);
    }

    syncProxyToCharacter() {
        const proxy = this.proxy;
        const mesh = this.viewer?.skinnedMesh;
        if (!proxy || !mesh) return;
        this.pivotWorldPosition(proxy.position);
        mesh.getWorldQuaternion(proxy.quaternion);
    }

    poleTargets() {
        return Object.values(this.viewer?.ikController?.poleTargets || {});
    }

    /**
     * Apply a new placement through the existing Radar / Model Rotation paths.
     * IK pole targets live in world space, so they follow the character's
     * rigid motion; IK effectors and joint markers follow the bones.
     */
    applyPlacement({ position = null, rotation = null } = {}, { poleBase = null } = {}) {
        const widget = this.widget;
        const viewer = this.viewer;
        const mesh = viewer?.skinnedMesh;
        const character = this.activeCharacter();
        if (!viewer || !mesh || !character) return false;
        const THREE = viewer.THREE;
        mesh.updateMatrixWorld(true);
        const base = poleBase || {
            matrix: mesh.matrixWorld.clone(),
            poles: this.poleTargets().map(pole => [pole, pole.position.clone()]),
        };
        if (rotation) {
            viewer.setModelRotation(rotation.x, rotation.y, rotation.z);
            widget.updateRotationSliders?.();
        }
        if (position) {
            widget.applyCharacterPosition(position, { link: !rotation });
        }
        mesh.updateMatrixWorld(true);
        const rigid = mesh.matrixWorld.clone().multiply(new THREE.Matrix4().copy(base.matrix).invert());
        for (const [pole, start] of base.poles) {
            pole.position.copy(start).applyMatrix4(rigid);
            pole.updateMatrixWorld?.(true);
        }
        this.syncFields(true);
        viewer.requestRender?.();
        return true;
    }

    commit() {
        this.widget.syncToNode?.(false);
    }

    // --- Gizmo drag -------------------------------------------------------------

    handleDraggingChanged(dragging) {
        const viewer = this.viewer;
        if (viewer?.orbit) viewer.orbit.enabled = !dragging;
        this._pick = null;
        if (dragging) {
            if (!this.isAvailable()) {
                this.gizmo.dragging = false;
                return;
            }
            this.widget._finishPoseGesture?.();
            viewer.isInteractionActive = true;
            const mesh = viewer.skinnedMesh;
            mesh.updateMatrixWorld(true);
            this._drag = {
                changed: false,
                mode: this.mode,
                character: this.activeCharacter(),
                tab: this.widget.activeTab,
                poses: this.widget.poses,
                restoreToken: this.widget._poseDataRestoreToken,
                position: this.currentPosition(),
                rotation: this.currentRotation(),
                pivot: this.proxy.position.clone(),
                quaternion: this.proxy.quaternion.clone(),
                poleBase: {
                    matrix: mesh.matrixWorld.clone(),
                    poles: this.poleTargets().map(pole => [pole, pole.position.clone()]),
                },
            };
            this.widget._finishPoseGesture = this._finishDragHook;
            return;
        }
        const drag = this._drag;
        if (!drag) return;
        this._drag = null;
        if (this.widget._finishPoseGesture === this._finishDragHook) this.widget._finishPoseGesture = null;
        if (viewer) viewer.isInteractionActive = false;
        this.syncProxyToCharacter();
        if (drag.changed && this.ownsDrag(drag)) this.commit();
        viewer?.requestRender?.();
    }

    ownsDrag(drag) {
        return this.isAvailable() && drag.character === this.activeCharacter()
            && drag.tab === this.widget.activeTab && drag.poses === this.widget.poses
            && drag.restoreToken === this.widget._poseDataRestoreToken;
    }

    /** The undo entry of a drag is taken on its first real change, so a plain click leaves history alone. */
    beginDragEdit(drag) {
        if (drag.changed) return;
        drag.changed = true;
        const widget = this.widget;
        widget._libraryLoadToken = (widget._libraryLoadToken || 0) + 1;
        this.viewer.recordState?.();
    }

    handleObjectChange() {
        const drag = this._drag;
        if (!drag || !this.proxy) return;
        if (!this.ownsDrag(drag)) {
            this.finishDrag();
            return;
        }
        const THREE = this.viewer.THREE;
        if (drag.mode === "move") {
            const delta = this.proxy.position.clone().sub(drag.pivot);
            const position = this.widget.constrainCharacterPosition(translateCharacterPosition(drag.position, delta));
            if (drag.changed || !samePosition(position, drag.position)) {
                this.beginDragEdit(drag);
                this.applyPlacement({ position }, { poleBase: drag.poleBase });
            }
            // Keep the gizmo on the character when a range limit clamps it.
            this.proxy.position.set(
                drag.pivot.x + position.x - drag.position.x,
                drag.pivot.y + position.y - drag.position.y,
                drag.pivot.z + position.z - drag.position.z,
            );
            return;
        }
        const delta = this.proxy.quaternion.clone().multiply(drag.quaternion.clone().invert());
        if (!drag.changed && delta.angleTo(new THREE.Quaternion()) < NO_ROTATION_RADIANS) return;
        const result = rotateCharacterAboutPivot(THREE, {
            position: drag.position,
            rotation: drag.rotation,
            pivot: drag.pivot,
            delta,
        });
        if (!result) {
            this.syncProxyToCharacter();
            return;
        }
        this.beginDragEdit(drag);
        this.applyPlacement(result, { poleBase: drag.poleBase });
    }

    // --- Viewport picking -------------------------------------------------------

    /** Called by PoseViewerCore before bone picking; true consumes the event. */
    handleViewerPointerDown(event) {
        if (this.mode === "pose") return false;
        this._pick = this.gizmo?.axis
            ? null
            : { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
        return true;
    }

    handleCanvasPointerCapture(event) {
        if (this._drag && event.pointerId !== this._pointerId) {
            event.stopImmediatePropagation();
        } else if (event.type === "pointerdown") {
            this._pointerId = event.pointerId;
        }
    }

    handleCanvasPointerUp(event) {
        const pick = this._pick;
        if (!pick || pick.pointerId !== event.pointerId) return;
        this._pick = null;
        if (this._drag || this.mode === "pose") return;
        if (Math.hypot(event.clientX - pick.x, event.clientY - pick.y) > CLICK_TOLERANCE_PX) return;
        const id = this.characterIdAt(event);
        if (!id) {
            this.clearSelection();
            return;
        }
        this._clearedCharacterId = null;
        this.applyGizmoMode();
        this.viewer?.requestRender?.();
        const active = this.activeCharacter();
        if (active && id !== active.id) void this.widget.selectCharacter?.(id);
    }

    /**
     * pointercancel / lostpointercapture: TransformControls only ends a drag on
     * pointerup, so end it here. The character stays where the user last saw it,
     * and the gesture commits like a normal release (one undo step).
     */
    handlePointerInterrupted(event) {
        if (event.pointerId !== this._pointerId) return;
        this._pick = null;
        this.finishDrag();
    }

    finishDrag() {
        const gizmo = this.gizmo;
        if (!gizmo?.dragging) return;
        this.viewer?.canvas?.removeEventListener?.("pointermove", gizmo._onPointerMove);
        gizmo.pointerUp({ x: 0, y: 0, button: 0 });
    }

    /** Nearest character mesh under the pointer, or null. */
    characterIdAt(event) {
        const viewer = this.viewer;
        if (!viewer?.THREE || !viewer.camera || !viewer.canvas) return null;
        const THREE = viewer.THREE;
        // getBoundingClientRect includes ComfyUI's CSS canvas zoom.
        const rect = viewer.canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const pointer = new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1,
        );
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(pointer, viewer.camera);
        const active = this.activeCharacter();
        const candidates = [[active?.id, viewer.skinnedMesh]];
        for (const [id, entry] of viewer.passiveCharacters || []) candidates.push([id, entry.mesh]);
        let best = null;
        for (const [id, mesh] of candidates) {
            if (!id || !mesh?.visible) continue;
            // Posed skinned bounds are cached by Three.js; refresh them per pick.
            mesh.boundingSphere = null;
            mesh.boundingBox = null;
            const hit = raycaster.intersectObject(mesh, false)[0];
            if (hit && (!best || hit.distance < best.distance)) best = { id: String(id), distance: hit.distance };
        }
        return best?.id || null;
    }

    // --- Toolbar ---------------------------------------------------------------

    createToolbar() {
        const doc = this.document;
        const toolbar = doc.createElement("div");
        toolbar.className = "vnccs-ps-transform-toolbar";
        toolbar.setAttribute("role", "toolbar");
        toolbar.setAttribute("aria-label", "Viewport edit mode");
        const modes = doc.createElement("div");
        modes.className = "vnccs-ps-toggle";
        for (const mode of ["pose", "move", "rotate"]) {
            const button = doc.createElement("button");
            button.type = "button";
            button.className = "vnccs-ps-toggle-btn";
            button.textContent = MODE_LABELS[mode];
            button.dataset.mode = mode;
            button.addEventListener("click", () => this.setMode(mode));
            this.modeButtons[mode] = button;
            modes.appendChild(button);
        }
        const space = doc.createElement("button");
        space.type = "button";
        space.className = "vnccs-ps-toggle-btn vnccs-ps-transform-space";
        space.addEventListener("click", () => this.setSpace(this.space === "world" ? "local" : "world"));
        this.spaceButton = space;
        toolbar.append(modes, space);
        return toolbar;
    }

    syncToolbar(force = false) {
        const available = this.isAvailable();
        const signature = `${this.mode}|${this.space}|${available}|${this.unavailableReason()}`;
        if (!force && signature === this._toolbarSignature) return;
        this._toolbarSignature = signature;
        const reason = this.unavailableReason();
        for (const [mode, button] of Object.entries(this.modeButtons)) {
            const active = mode === this.mode;
            button.classList.toggle("active", active);
            button.setAttribute("aria-pressed", String(active));
            button.disabled = mode !== "pose" && !available;
            button.title = button.disabled && reason ? reason : MODE_TITLES[mode];
        }
        if (this.spaceButton) {
            this.spaceButton.textContent = this.space === "world" ? "World" : "Local";
            this.spaceButton.title = this.space === "world"
                ? "Gizmo axes: World (click for the character's Local axes)"
                : "Gizmo axes: Local to the character (click for World axes)";
            this.spaceButton.hidden = this.mode === "pose";
        }
    }

    // --- Characters panel fields -------------------------------------------------

    renderPanel(content) {
        if (!this.enabled || !content || !this.document) return;
        const doc = this.document;
        const section = doc.createElement("div");
        section.className = "vnccs-ps-character-transform";
        const title = doc.createElement("div");
        title.className = "vnccs-ps-character-transform-title";
        const name = doc.createElement("span");
        name.textContent = "Transform";
        const hint = doc.createElement("small");
        hint.textContent = "selected character";
        title.append(name, hint);
        section.appendChild(title);

        const inputs = { position: {}, rotation: {} };
        const rows = [
            ["position", "Position", "Position in world units. X / Y match the Positioning Radar; Z is depth."],
            ["rotation", "Rotation", `Model Rotation in degrees, Euler order ${MODEL_ROTATION_ORDER}, about the pelvis.`],
        ];
        for (const [kind, label, help] of rows) {
            const row = doc.createElement("div");
            row.className = "vnccs-ps-character-transform-row";
            row.title = help;
            const caption = doc.createElement("span");
            caption.textContent = kind === "position" ? `${label} (units)` : `${label} (°, ${MODEL_ROTATION_ORDER})`;
            const axes = doc.createElement("div");
            axes.className = "vnccs-ps-character-transform-axes";
            row.append(caption, axes);
            for (const axis of AXES) {
                const field = doc.createElement("label");
                const axisLabel = doc.createElement("b");
                axisLabel.textContent = axis.toUpperCase();
                const input = doc.createElement("input");
                input.type = "number";
                input.className = "vnccs-ps-input";
                input.dataset.transform = `${kind}.${axis}`;
                if (kind === "position") {
                    input.min = String(CHARACTER_POSITION_LIMITS[axis][0]);
                    input.max = String(CHARACTER_POSITION_LIMITS[axis][1]);
                    input.step = "0.1";
                } else {
                    input.min = "-180";
                    input.max = "180";
                    input.step = "1";
                }
                input.setAttribute("aria-label", `${label} ${axis.toUpperCase()}`);
                input.addEventListener("input", () => this.handleFieldInput(kind, axis, input.value));
                input.addEventListener("change", () => this.finishFieldEdit());
                input.addEventListener("blur", () => this.finishFieldEdit());
                field.append(axisLabel, input);
                axes.appendChild(field);
                inputs[kind][axis] = input;
            }
            section.appendChild(row);
        }

        const actions = doc.createElement("div");
        actions.className = "vnccs-ps-character-transform-actions";
        const resetPosition = doc.createElement("button");
        resetPosition.type = "button";
        resetPosition.className = "vnccs-ps-btn";
        resetPosition.textContent = "Reset Position";
        resetPosition.title = "Move the selected character to X 0, Y 0, Z 0";
        resetPosition.addEventListener("click", () => this.resetPosition());
        const resetRotation = doc.createElement("button");
        resetRotation.type = "button";
        resetRotation.className = "vnccs-ps-btn";
        resetRotation.textContent = "Reset Rotation";
        resetRotation.title = "Set Model Rotation to 0° (the pelvis stays in place)";
        resetRotation.addEventListener("click", () => this.resetRotation());
        actions.append(resetPosition, resetRotation);
        section.appendChild(actions);

        const note = doc.createElement("div");
        note.className = "vnccs-ps-character-transform-note";
        section.appendChild(note);

        content.appendChild(section);
        this.fields = { section, inputs, resetPosition, resetRotation, note };
        this.syncFields(true);
    }

    /** One field edit (typing until Enter / blur, or one spinner step) is one undo step. */
    beginFieldEdit() {
        if (this._fieldEditActive) return;
        const widget = this.widget;
        widget._finishPoseGesture?.();
        widget._libraryLoadToken = (widget._libraryLoadToken || 0) + 1;
        this.viewer.recordState?.();
        this._fieldEditActive = true;
        widget._finishPoseGesture = this._finishFieldEditHook;
    }

    finishFieldEdit() {
        if (!this._fieldEditActive) {
            this.syncFields(true);
            return;
        }
        this._fieldEditActive = false;
        if (this.widget._finishPoseGesture === this._finishFieldEditHook) this.widget._finishPoseGesture = null;
        this.commit();
        this.syncFields(true);
    }

    handleFieldInput(kind, axis, rawValue) {
        if (!this.isAvailable() || this._drag) return;
        const value = Number(rawValue);
        if (rawValue === "" || !Number.isFinite(value)) return;
        const position = this.currentPosition();
        if (kind === "position") {
            const next = this.widget.constrainCharacterPosition({ ...position, [axis]: value });
            if (samePosition(next, position)) return;
            this.beginFieldEdit();
            this.applyPlacement({ position: next });
            return;
        }
        const rotation = this.currentRotation();
        const angle = wrapDegrees(value);
        if (Math.abs(wrapDegrees(angle - rotation[axis])) < NO_CHANGE_EPSILON) return;
        const result = setCharacterRotationAboutPivot(this.viewer.THREE, {
            position,
            rotation,
            pivot: this.pivotWorldPosition(),
            nextRotation: { ...rotation, [axis]: angle },
        });
        if (!result) return;
        this.beginFieldEdit();
        this.applyPlacement(result);
    }

    resetPosition() {
        if (!this.isAvailable() || this._drag) return false;
        const position = this.widget.constrainCharacterPosition({ x: 0, y: 0, z: 0 });
        if (samePosition(this.currentPosition(), position)) return false;
        this.widget._finishPoseGesture?.();
        this.viewer.recordState?.();
        this.applyPlacement({ position });
        this.commit();
        return true;
    }

    resetRotation() {
        if (!this.isAvailable() || this._drag) return false;
        if (samePosition(this.currentRotation(), { x: 0, y: 0, z: 0 })) return false;
        const result = setCharacterRotationAboutPivot(this.viewer.THREE, {
            position: this.currentPosition(),
            rotation: this.currentRotation(),
            pivot: this.pivotWorldPosition(),
            nextRotation: { x: 0, y: 0, z: 0 },
        });
        if (!result) return false;
        this.widget._finishPoseGesture?.();
        this.viewer.recordState?.();
        this.applyPlacement(result);
        this.commit();
        return true;
    }

    syncFields(force = false) {
        const fields = this.fields;
        if (!fields) return;
        const available = this.isAvailable();
        const position = this.currentPosition();
        const rotation = this.currentRotation();
        const reason = this.unavailableReason();
        const signature = JSON.stringify([position, rotation, available, reason, this.activeCharacter()?.id]);
        if (!force && signature === this._fieldSignature) return;
        this._fieldSignature = signature;
        const focused = this.document?.activeElement;
        for (const axis of AXES) {
            for (const [kind, values, digits] of [["position", position, 2], ["rotation", rotation, 1]]) {
                const input = fields.inputs[kind][axis];
                input.disabled = !available;
                // Never overwrite the number the user is typing.
                if (input !== focused) input.value = format(values[axis], digits);
            }
        }
        fields.resetPosition.disabled = !available;
        fields.resetRotation.disabled = !available;
        fields.note.textContent = reason;
        fields.note.hidden = !reason;
    }

    /** Render-loop sync: other controls (Radar, sliders, undo, tabs) changed state. */
    onViewportRender() {
        if (!this.viewer) return;
        if (!this.gizmo && this.viewer.isInitialized?.()) this.onViewerReady();
        const available = this.isAvailable();
        if (this._clearedCharacterId !== null && !this._drag && !this.isSelectionCleared()) {
            // Another control selected a different character: show the gizmo on it.
            this._clearedCharacterId = null;
            this.applyGizmoMode();
        }
        if (this.mode !== "pose" && !this._drag) {
            if (!this.enabled || this.widget.isAnimationMode?.()) {
                this.setMode("pose");
            } else if (this.viewer.transform?.object) {
                // A bone was selected from another control: hand input back to FK / IK.
                this.setMode("pose");
            }
        }
        if (this.gizmo && this.mode !== "pose" && !this._drag) this.gizmo.enabled = available;
        this.syncToolbar();
        this.syncFields();
    }
}
