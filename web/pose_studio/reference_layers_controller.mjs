/**
 * Pose Studio reference image layers: viewport rendering, direct manipulation
 * and the side-panel UI. The data model and math live in reference_layers.mjs.
 *
 * Layers are textured quads parented to the capture camera at the depth of the
 * orange capture frame, so they stay aligned with it in every editor view. They
 * use an editor-only render layer that the capture camera never sees, so they
 * are never part of captures or node outputs.
 */
import {
    REFERENCE_LAYER_LIMIT,
    REFERENCE_LAYER_MAX_EDGE,
    REFERENCE_LAYER_MAX_FILE_BYTES,
    clientToNdc,
    createReferenceLayer,
    dragReferenceLayer,
    fitReferenceLayerScale,
    hitTestReferenceLayer,
    layerLocalToFrame,
    ndcToCssPixels,
    normalizeReferenceLayers,
    patchReferenceLayer,
    referenceLayerCorners,
    referenceLayerHalfSize,
    referenceLayerHistorySnapshot,
    reorderReferenceLayers,
    restoreReferenceLayerHistory,
    serializeReferenceLayers,
} from "./reference_layers.mjs";

const STYLE_ID = "vnccs-ps-reflayer-style";
// Circular arrow with a dark outline, readable on light and dark images.
const ROTATE_CURSOR_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>"
    + "<g fill='none' stroke-linecap='round' stroke-linejoin='round' transform='translate(1.5 2) scale(0.85)'>"
    + "<path d='M20.5 15a9 9 0 1 1-2.1-9.4L23 10M23 4v6h-6' stroke='#000' stroke-width='4.5'/>"
    + "<path d='M20.5 15a9 9 0 1 1-2.1-9.4L23 10M23 4v6h-6' stroke='#fff' stroke-width='2'/></g></svg>";
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(ROTATE_CURSOR_SVG)}") 12 12, grab`;

/** Resize cursor along the on-screen direction from the layer centre to a corner. */
export function referenceLayerResizeCursor(center, corner) {
    const angle = ((Math.atan2(corner.y - center.y, corner.x - center.x) * 180 / Math.PI) % 180 + 180) % 180;
    if (angle < 22.5 || angle >= 157.5) return "ew-resize";
    if (angle < 67.5) return "nwse-resize";
    if (angle < 112.5) return "ns-resize";
    return "nesw-resize";
}
const HANDLE_RADIUS = 9;
const ROTATE_HANDLE_OFFSET = 24;
const ACCENT = "#4fc3f7";

const STYLE = `
.vnccs-ps-reflayer-tools { display: flex; gap: 4px; margin-bottom: 6px; }
.vnccs-ps-reflayer-tools .vnccs-ps-btn { flex: 1; padding: 4px 6px; font-size: 10px; }
.vnccs-ps-reflayer-tools .vnccs-ps-btn.active { border-color: ${ACCENT}; color: ${ACCENT}; }
.vnccs-ps-reflayer-hint { font-size: 9px; color: var(--ps-text-muted); margin-bottom: 6px; line-height: 1.35; }
.vnccs-ps-reflayer-list { display: flex; flex-direction: column; gap: 3px; margin-bottom: 6px; }
.vnccs-ps-reflayer-row { display: flex; align-items: center; gap: 2px; padding: 3px; border: 1px solid var(--ps-border); border-radius: 5px; cursor: pointer; }
.vnccs-ps-reflayer-row.selected { border-color: ${ACCENT}; background: rgba(79, 195, 247, 0.08); }
.vnccs-ps-reflayer-row.hidden-layer { opacity: 0.5; }
.vnccs-ps-reflayer-thumb { width: 22px; height: 22px; object-fit: contain; flex-shrink: 0; background: #0006; border-radius: 3px; margin-right: 2px; }
.vnccs-ps-reflayer-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }
input.vnccs-ps-reflayer-name { padding: 1px 3px; border: 1px solid ${ACCENT}; border-radius: 3px; background: #0008; color: var(--ps-text); font-family: inherit; }
.vnccs-ps-reflayer-icon { width: 14px; height: 18px; padding: 0; font-size: 10px; line-height: 1; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--ps-text-muted); cursor: pointer; flex-shrink: 0; }
.vnccs-ps-reflayer-icon:hover { border-color: var(--ps-border); color: var(--ps-text); }
.vnccs-ps-reflayer-icon.on { color: ${ACCENT}; }
.vnccs-ps-reflayer-props .vnccs-ps-field { margin-bottom: 5px; }
.vnccs-ps-reflayer-num { width: 58px !important; padding: 2px 4px !important; text-align: right; }
.vnccs-ps-reflayer-pair { display: flex; gap: 4px; align-items: center; }
.vnccs-ps-reflayer-pair label { font-size: 9px; color: var(--ps-text-muted); }
.vnccs-ps-reflayer-overlay { position: absolute; pointer-events: none; z-index: 1; left: 0; top: 0; }
`;

function ensureStyle(doc) {
    if (!doc?.head || doc.getElementById?.(STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE;
    doc.head.appendChild(style);
}

function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error("Failed to read the image."));
        reader.readAsDataURL(file);
    });
}

/** Decodes an image file once and stores it downscaled (WebP keeps alpha). */
export async function decodeReferenceImageFile(file, maxEdge = REFERENCE_LAYER_MAX_EDGE) {
    const source = await readFileAsDataURL(file);
    const image = new Image();
    image.decoding = "async";
    image.src = source;
    await image.decode();
    const naturalWidth = image.naturalWidth || image.width;
    const naturalHeight = image.naturalHeight || image.height;
    if (!naturalWidth || !naturalHeight) throw new Error("The image has no pixels.");
    const factor = Math.min(1, maxEdge / Math.max(naturalWidth, naturalHeight));
    const width = Math.max(1, Math.round(naturalWidth * factor));
    const height = Math.max(1, Math.round(naturalHeight * factor));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(image, 0, 0, width, height);
    let src = canvas.toDataURL("image/webp", 0.9);
    if (!src.startsWith("data:image/webp")) src = canvas.toDataURL("image/png");
    return { src, width, height };
}

export class PoseReferenceLayerController {
    constructor(host, {
        decodeImageFile = decodeReferenceImageFile,
        document: doc = globalThis.document,
        // POSE_STUDIO_EDITOR_ONLY_LAYER from core.js, passed in so this module
        // never loads core.js under a second URL.
        editorOnlyLayer = 1,
        loadTexture = null,
    } = {}) {
        this.host = host;
        this.editorOnlyLayer = editorOnlyLayer;
        this.loadTexture = loadTexture;
        this.doc = doc;
        this.decodeImageFile = decodeImageFile;
        this.layers = [];
        // Image data by layer id. Undo snapshots refer to it, so it outlives deletes.
        this.images = new Map();
        this.selectedId = null;
        this.editMode = false;
        this.viewer = null;
        this.group = null;
        this.entries = new Map();
        this.drag = null;
        this.hoverMode = null;
        this.hoverCursor = null;
        this.loadToken = 0;
        this.ui = {};
        this._listeners = [];
        this._tmp = null;
    }

    get enabled() {
        return this.host?.host?.embedded !== true;
    }

    selectedLayer() {
        return this.layers.find(layer => layer.id === this.selectedId) || null;
    }

    frameSize() {
        const params = this.host?.exportParams || {};
        return { width: Number(params.view_width) || 1024, height: Number(params.view_height) || 1024 };
    }

    // === Persistence and history ===

    serialize() {
        return this.enabled ? serializeReferenceLayers(this.layers) : undefined;
    }

    load(raw) {
        this.loadToken++;
        this.cancelDrag();
        this.images.clear();
        this.layers = this.enabled ? normalizeReferenceLayers(raw) : [];
        for (const layer of this.layers) this.images.set(layer.id, layer.src);
        this.selectedId = this.layers.at(-1)?.id || null;
        this.refresh();
    }

    historySnapshot() {
        return this.enabled ? referenceLayerHistorySnapshot(this.layers) : undefined;
    }

    restoreHistory(snapshot) {
        if (!this.enabled || !Array.isArray(snapshot)) return;
        this.cancelDrag();
        this.layers = restoreReferenceLayerHistory(snapshot, this.images);
        if (!this.selectedLayer()) this.selectedId = this.layers.at(-1)?.id || null;
        this.refresh();
    }

    /** Records one undo step before an edit; the edit is saved by commit(). */
    recordHistory() {
        this.host?._finishPoseGesture?.();
        if (!this.host?.isAnimationMode?.()) this.host?.viewer?.recordState?.();
    }

    commit() {
        this.host?.syncToNode?.(false);
    }

    // === Editing ===

    async addFiles(files) {
        const images = Array.from(files || []).filter(file => /^image\//.test(file?.type || ""));
        if (!images.length || !this.enabled) return [];
        const room = REFERENCE_LAYER_LIMIT - this.layers.length;
        if (room <= 0) {
            this.host?.showMessage?.(`Up to ${REFERENCE_LAYER_LIMIT} reference layers are supported.`, true);
            return [];
        }
        if (images.length > room) {
            this.host?.showMessage?.(`Only ${room} more reference layer(s) can be added.`, true);
        }
        const token = this.loadToken;
        const decoded = [];
        for (const file of images.slice(0, room)) {
            if (file.size > REFERENCE_LAYER_MAX_FILE_BYTES) {
                this.host?.showMessage?.(`${file.name} is too large for a reference layer.`, true);
                continue;
            }
            try {
                decoded.push({ name: file.name, ...(await this.decodeImageFile(file)) });
            } catch (error) {
                this.host?.showMessage?.(`Failed to load ${file.name || "the image"} as a reference layer.`, true);
            }
            if (token !== this.loadToken || this._disposed) return [];
        }
        if (!decoded.length) return [];
        const { width, height } = this.frameSize();
        const added = [];
        // Another import may have finished while this one was decoding.
        for (const image of decoded.slice(0, Math.max(0, REFERENCE_LAYER_LIMIT - this.layers.length))) {
            const ids = [...this.layers, ...added].map(item => item.id);
            const layer = createReferenceLayer(image, width / height, ids);
            if (layer) added.push(layer);
        }
        if (!added.length) return [];
        this.recordHistory();
        for (const layer of added) this.images.set(layer.id, layer.src);
        this.layers = [...this.layers, ...added];
        this.selectedId = added.at(-1).id;
        this.editMode = true;
        this.refresh();
        this.commit();
        return added;
    }

    /** One complete edit (button, reset): undo step, change, save. */
    edit(id, patch) {
        const layer = this.layers.find(item => item.id === id);
        if (!layer) return;
        this.recordHistory();
        this.updateLayer(id, patch);
        // Row buttons capture the layer state, so rebuild them after Show/Hide and Lock.
        this.renderList();
        this.commit();
    }

    /** Live update during a gesture; history and saving belong to the gesture. */
    updateLayer(id, patch, { source = null } = {}) {
        const index = this.layers.findIndex(item => item.id === id);
        if (index < 0) return null;
        const next = patchReferenceLayer(this.layers[index], patch);
        this.layers = this.layers.map((item, i) => (i === index ? next : item));
        this.applyLayerToMesh(next, index);
        if (id === this.selectedId) this.syncFields(source);
        this.requestRender();
        return next;
    }

    removeLayer(id) {
        if (!this.layers.some(layer => layer.id === id)) return;
        this.recordHistory();
        const index = this.layers.findIndex(layer => layer.id === id);
        this.layers = this.layers.filter(layer => layer.id !== id);
        if (this.selectedId === id) this.selectedId = this.layers[Math.min(index, this.layers.length - 1)]?.id || null;
        this.refresh();
        this.commit();
    }

    moveLayer(id, direction) {
        const next = reorderReferenceLayers(this.layers, id, direction);
        if (next === this.layers) return;
        this.recordHistory();
        this.layers = next;
        this.refresh();
        this.commit();
    }

    select(id) {
        this.selectedId = this.layers.some(layer => layer.id === id) ? id : null;
        // Update the rows in place so a double click lands on the same name element.
        for (const row of this.ui.list?.children || []) {
            const layer = this.layers.find(item => item.id === row.dataset.layerId);
            if (layer) row.className = this.rowClass(layer);
        }
        this.syncFields();
        this.requestRender();
    }

    startRename(id) {
        if (!this.layers.some(layer => layer.id === id)) return;
        this.renamingId = id;
        this.renderList();
    }

    finishRename(id, value) {
        if (this.renamingId !== id) return;
        this.renamingId = null;
        const layer = this.layers.find(item => item.id === id);
        const name = String(value ?? "").trim();
        if (layer && name && name !== layer.name) this.edit(id, { name });
        else this.renderList();
    }

    setEditMode(enabled) {
        this.editMode = !!enabled;
        if (!this.editMode) this.cancelDrag();
        this.syncToolbar();
        this.setHoverMode(null);
        this.requestRender();
    }

    resetTransform(kind) {
        const layer = this.selectedLayer();
        if (!layer) return;
        const { width, height } = this.frameSize();
        const patch = {
            position: { x: 0, y: 0 },
            scale: { scale: fitReferenceLayerScale(layer.width, layer.height, width / height) },
            rotation: { rotation: 0 },
            opacity: { opacity: 0.5 },
        }[kind];
        if (patch) this.edit(layer.id, patch);
    }

    // === Viewport ===

    attachViewer(viewer, container) {
        this.viewer = viewer;
        this.container = container;
        if (!this.enabled || !viewer?.canvas) return;
        this.installHistoryContext(viewer);
        const canvas = viewer.canvas;
        const listen = (target, type, handler, options) => {
            target.addEventListener(type, handler, options);
            this._listeners.push(() => target.removeEventListener(type, handler, options));
        };
        // Capture phase on the canvas runs before OrbitControls, TransformControls
        // and bone picking, so a layer gesture never reaches them.
        listen(canvas, "pointerdown", event => this.onPointerDown(event), true);
        listen(canvas, "pointermove", event => this.onPointerMove(event), true);
        listen(canvas, "pointerup", event => this.onPointerUp(event), true);
        listen(canvas, "pointercancel", event => this.onPointerUp(event, true), true);
        listen(canvas, "lostpointercapture", event => this.onPointerUp(event, true), true);
        listen(canvas, "pointerleave", () => { if (!this.drag) this.setHoverMode(null); });
        if (container && this.doc?.createElement) {
            const overlay = this.doc.createElement("canvas");
            overlay.className = "vnccs-ps-reflayer-overlay";
            container.appendChild(overlay);
            this.overlay = overlay;
            // Only image files are taken; workflow files still reach ComfyUI.
            const hasImage = event => Array.from(event.dataTransfer?.items || [])
                .some(item => item.kind === "file" && /^image\//.test(item.type));
            listen(container, "dragover", event => {
                if (!hasImage(event)) return;
                event.preventDefault();
                event.stopPropagation();
                if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
            });
            listen(container, "drop", event => {
                const files = Array.from(event.dataTransfer?.files || []).filter(file => /^image\//.test(file.type));
                if (!files.length) return;
                // Keep ComfyUI from treating the drop as a workflow or LoadImage drop.
                event.preventDefault();
                event.stopPropagation();
                void this.addFiles(files);
            });
        }
        this.requestRender();
    }

    /**
     * Pose undo snapshots (viewer.recordState) also carry the layer stack, so
     * Undo/Redo restore layer edits through the widget's restoreImageHistory.
     */
    installHistoryContext(viewer) {
        if (!viewer?.options) return;
        const capture = viewer.options.captureHistoryContext;
        viewer.options.captureHistoryContext = () => ({ ...capture?.(), referenceLayers: this.historySnapshot() });
    }

    requestRender() {
        this.viewer?.requestRender?.();
    }

    ensureScene() {
        const viewer = this.viewer;
        if (this.group || !this.enabled || !viewer?.THREE || !viewer.captureCamera) return !!this.group;
        const THREE = viewer.THREE;
        this.group = new THREE.Group();
        this.group.name = "VNCCSReferenceLayers";
        viewer.captureCamera.add(this.group);
        this._tmp = {
            vector: new THREE.Vector3(),
            normal: new THREE.Vector3(),
            plane: new THREE.Plane(),
            ndc: new THREE.Vector2(),
            raycaster: new THREE.Raycaster(),
            quaternion: new THREE.Quaternion(),
        };
        this.syncMeshes();
        return true;
    }

    /** Called before each viewport render: follow the capture frame. */
    syncFrame() {
        if (!this.ensureScene()) return;
        const viewer = this.viewer;
        const frame = viewer.captureFrame;
        const camera = viewer.captureCamera;
        camera.updateMatrixWorld();
        if (frame) {
            const local = camera.worldToLocal(this._tmp.vector.copy(frame.position));
            const height = Math.abs(frame.scale.y) * 2;
            this.group.position.set(local.x, local.y, local.z);
            this.group.scale.setScalar(height > 1e-6 ? height : 1);
        }
        this.group.updateMatrixWorld(true);
    }

    createEntry(layer) {
        const THREE = this.viewer.THREE;
        const material = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: layer.opacity,
            side: THREE.DoubleSide,
            depthTest: false,
            depthWrite: false,
            toneMapped: false,
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
        mesh.name = `VNCCSReferenceLayer:${layer.id}`;
        mesh.layers.set(this.editorOnlyLayer);
        mesh.visible = false;
        const entry = { mesh, src: layer.src, texture: null, ready: false };
        this.entries.set(layer.id, entry);
        this.group.add(mesh);
        // Decoded and uploaded once; later transforms only touch the matrix.
        const load = this.loadTexture || ((src, onLoad, onError) => new THREE.TextureLoader().load(src, onLoad, undefined, onError));
        load(layer.src, texture => {
            if (this.entries.get(layer.id) !== entry) {
                texture.dispose();
                return;
            }
            if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
            entry.texture = texture;
            entry.ready = true;
            material.map = texture;
            material.needsUpdate = true;
            const current = this.layers.findIndex(item => item.id === layer.id);
            if (current >= 0) this.applyLayerToMesh(this.layers[current], current);
            this.requestRender();
        }, () => {
            if (this.entries.get(layer.id) === entry) this.host?.showMessage?.(`Failed to display reference layer ${layer.name}.`, true);
        });
        return entry;
    }

    disposeEntry(entry) {
        this.group?.remove(entry.mesh);
        entry.mesh.geometry?.dispose();
        entry.texture?.dispose();
        entry.mesh.material?.dispose();
    }

    syncMeshes() {
        if (!this.group) return;
        const ids = new Set(this.layers.map(layer => layer.id));
        for (const [id, entry] of this.entries) {
            if (!ids.has(id) || entry.src !== this.layers.find(layer => layer.id === id)?.src) {
                this.disposeEntry(entry);
                this.entries.delete(id);
            }
        }
        this.layers.forEach((layer, index) => {
            if (!this.entries.has(layer.id)) this.createEntry(layer);
            this.applyLayerToMesh(layer, index);
        });
    }

    applyLayerToMesh(layer, index) {
        const entry = this.entries.get(layer.id);
        if (!entry) return;
        const { mesh } = entry;
        const { hx, hy } = referenceLayerHalfSize(layer);
        mesh.position.set(layer.x, layer.y, 0);
        mesh.rotation.set(0, 0, -layer.rotation * Math.PI / 180);
        mesh.scale.set(hx * 2 * (layer.flipX ? -1 : 1), hy * 2, 1);
        mesh.material.opacity = layer.opacity;
        // Over the model, under joint markers (renderOrder >= 1) and gizmos.
        mesh.renderOrder = 0.1 + index * 0.01;
        mesh.visible = entry.ready && layer.visible;
    }

    frameToCss(point) {
        const viewer = this.viewer, canvas = viewer.canvas;
        const vector = this._tmp.vector.set(point.x, point.y, 0);
        this.group.localToWorld(vector);
        vector.project(viewer.camera);
        if (!Number.isFinite(vector.x) || vector.z > 1) return null;
        return ndcToCssPixels(vector, canvas.clientWidth, canvas.clientHeight);
    }

    ndcToFrame(ndc) {
        const viewer = this.viewer, tmp = this._tmp;
        viewer.camera.updateMatrixWorld();
        tmp.raycaster.setFromCamera(tmp.ndc.set(ndc.x, ndc.y), viewer.camera);
        this.group.getWorldQuaternion(tmp.quaternion);
        tmp.normal.set(0, 0, 1).applyQuaternion(tmp.quaternion);
        tmp.plane.setFromNormalAndCoplanarPoint(tmp.normal, this.group.getWorldPosition(tmp.vector));
        const hit = tmp.raycaster.ray.intersectPlane(tmp.plane, tmp.vector);
        if (!hit) return null;
        const local = this.group.worldToLocal(hit);
        return { x: local.x, y: local.y };
    }

    handleGeometry(layer) {
        const corners = referenceLayerCorners(layer).map(point => this.frameToCss(point));
        if (corners.some(point => !point)) return null;
        const { hy } = referenceLayerHalfSize(layer);
        const center = this.frameToCss(layer);
        const top = this.frameToCss(layerLocalToFrame(layer, { x: 0, y: hy }));
        if (!center || !top) return null;
        let dx = top.x - center.x, dy = top.y - center.y;
        const length = Math.hypot(dx, dy) || 1;
        dx /= length; dy /= length;
        return { corners, center, top, rotate: { x: top.x + dx * ROTATE_HANDLE_OFFSET, y: top.y + dy * ROTATE_HANDLE_OFFSET } };
    }

    pointerFrame(event) {
        const canvas = this.viewer.canvas;
        const rect = canvas.getBoundingClientRect();
        const ndc = clientToNdc(event.clientX, event.clientY, rect);
        return { ndc, css: ndcToCssPixels(ndc, canvas.clientWidth, canvas.clientHeight), point: this.ndcToFrame(ndc) };
    }

    canManipulate() {
        const layer = this.selectedLayer();
        return this.enabled && this.editMode && !!this.group && !!layer && layer.visible && !layer.locked
            && !this.host?.container?.inert ? layer : null;
    }

    hitTest(event) {
        const layer = this.canManipulate();
        if (!layer) return null;
        this.syncFrame();
        const pointer = this.pointerFrame(event);
        const handles = this.handleGeometry(layer);
        const near = point => point && Math.hypot(point.x - pointer.css.x, point.y - pointer.css.y) <= HANDLE_RADIUS;
        let mode = null, cursor = null;
        const corner = handles?.corners.find(near);
        if (handles && near(handles.rotate)) mode = "rotate";
        else if (corner) {
            mode = "scale";
            cursor = referenceLayerResizeCursor(handles.center, corner);
        } else if (pointer.point && hitTestReferenceLayer(layer, pointer.point)) {
            // Modifiers reach scale and rotation when the handles are off screen.
            mode = event.ctrlKey || event.metaKey ? "rotate" : event.altKey ? "scale" : "move";
        }
        return mode ? { mode, cursor, layer, pointer } : null;
    }

    onPointerDown(event) {
        if (this.drag || event.button !== 0) return;
        const hit = this.hitTest(event);
        if (!hit || !hit.pointer.point) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.drag = {
            mode: hit.mode,
            pointerId: event.pointerId,
            start: { ...hit.layer },
            startPoint: hit.pointer.point,
            recorded: false,
        };
        try { this.viewer.canvas.setPointerCapture?.(event.pointerId); } catch { /* synthetic pointer */ }
        this.setHoverMode(hit.mode, hit.cursor);
    }

    onPointerMove(event) {
        const drag = this.drag;
        if (!drag) {
            if (this.editMode && event.buttons === 0) {
                const hit = this.hitTest(event);
                this.setHoverMode(hit?.mode || null, hit?.cursor);
            }
            return;
        }
        if (event.pointerId !== drag.pointerId) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.syncFrame();
        const point = this.pointerFrame(event).point;
        if (!point) return;
        const patch = dragReferenceLayer(drag.mode, drag.start, drag.startPoint, point, { snap: event.shiftKey });
        const current = this.selectedLayer();
        if (!current || current.id !== drag.start.id) return;
        if (!drag.recorded) {
            if (Object.entries(patch).every(([key, value]) => Math.abs(value - current[key]) < 1e-9)) return;
            // The undo step is taken on the first real change, so a click records nothing.
            this.recordHistory();
            drag.recorded = true;
        }
        this.updateLayer(drag.start.id, patch);
    }

    onPointerUp(event, cancelled = false) {
        const drag = this.drag;
        if (!drag || event.pointerId !== drag.pointerId) return;
        event.stopImmediatePropagation();
        this.drag = null;
        try {
            if (this.viewer.canvas.hasPointerCapture?.(event.pointerId)) this.viewer.canvas.releasePointerCapture(event.pointerId);
        } catch { /* already released */ }
        if (drag.recorded) this.commit();
        if (cancelled && !drag.recorded) this.setHoverMode(null);
    }

    cancelDrag() {
        const drag = this.drag;
        if (!drag) return;
        this.drag = null;
        if (drag.recorded) this.commit();
    }

    setHoverMode(mode, cursor = null) {
        const next = mode === null ? null
            : cursor || (mode === "move" ? "move" : mode === "scale" ? "nwse-resize" : ROTATE_CURSOR);
        if ((this.hoverMode === mode && this.hoverCursor === next) || !this.viewer?.canvas) return;
        const canvas = this.viewer.canvas;
        if (this.hoverMode === null) this._cursorBeforeHover = canvas.style.cursor || "";
        this.hoverMode = mode;
        this.hoverCursor = next;
        canvas.style.cursor = next ?? (this._cursorBeforeHover || "");
    }

    /** Called after each viewport render: selection outline and handles. */
    drawOverlay() {
        const overlay = this.overlay, canvas = this.viewer?.canvas;
        if (!overlay || !canvas) return;
        const width = canvas.clientWidth, height = canvas.clientHeight;
        const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
        const left = `${canvas.offsetLeft || 0}px`, top = `${canvas.offsetTop || 0}px`;
        if (overlay.style.left !== left) overlay.style.left = left;
        if (overlay.style.top !== top) overlay.style.top = top;
        if (overlay.style.width !== `${width}px`) overlay.style.width = `${width}px`;
        if (overlay.style.height !== `${height}px`) overlay.style.height = `${height}px`;
        const pixelWidth = Math.max(1, Math.round(width * ratio)), pixelHeight = Math.max(1, Math.round(height * ratio));
        if (overlay.width !== pixelWidth) overlay.width = pixelWidth;
        if (overlay.height !== pixelHeight) overlay.height = pixelHeight;
        const ctx = overlay.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        const layer = this.selectedLayer();
        if (!this.enabled || !this.editMode || !this.group || !layer || !layer.visible) return;
        this.syncFrame();
        const handles = this.handleGeometry(layer);
        if (!handles) return;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = layer.locked ? "rgba(255,255,255,0.45)" : ACCENT;
        ctx.setLineDash(layer.locked ? [4, 4] : []);
        ctx.beginPath();
        handles.corners.forEach((point, index) => (index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
        if (layer.locked) return;
        ctx.beginPath();
        ctx.moveTo(handles.top.x, handles.top.y);
        ctx.lineTo(handles.rotate.x, handles.rotate.y);
        ctx.stroke();
        ctx.fillStyle = "#10141c";
        for (const point of handles.corners) {
            ctx.fillRect(point.x - 4.5, point.y - 4.5, 9, 9);
            ctx.strokeRect(point.x - 4.5, point.y - 4.5, 9, 9);
        }
        ctx.beginPath();
        ctx.arc(handles.rotate.x, handles.rotate.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    }

    // === Panel ===

    createSection() {
        ensureStyle(this.doc);
        const section = this.host.createSection("Reference Layers", false);
        this.section = section;
        const tools = this.doc.createElement("div");
        tools.className = "vnccs-ps-reflayer-tools";
        const addBtn = this.doc.createElement("button");
        addBtn.className = "vnccs-ps-btn";
        addBtn.type = "button";
        addBtn.textContent = "+ Add Image";
        addBtn.title = "Add reference images (or drop image files on the viewport)";
        addBtn.addEventListener("click", () => this.ui.fileInput?.click());
        const editBtn = this.doc.createElement("button");
        editBtn.className = "vnccs-ps-btn";
        editBtn.type = "button";
        editBtn.textContent = "✥ Edit in View";
        editBtn.title = "Drag the selected layer in the viewport: inside moves, corners (or Alt+drag) scale, "
            + "the round handle (or Ctrl+drag) rotates; Shift snaps rotation to 15°";
        editBtn.addEventListener("click", () => this.setEditMode(!this.editMode));
        tools.append(addBtn, editBtn);

        const hint = this.doc.createElement("div");
        hint.className = "vnccs-ps-reflayer-hint";
        hint.textContent = "Editor-only tracing images. They are never part of the output images.";

        const list = this.doc.createElement("div");
        list.className = "vnccs-ps-reflayer-list";
        const props = this.doc.createElement("div");
        props.className = "vnccs-ps-reflayer-props";

        const fileInput = this.doc.createElement("input");
        fileInput.type = "file";
        fileInput.className = "vnccs-ps-reflayer-file";
        fileInput.accept = "image/*";
        fileInput.multiple = true;
        fileInput.style.display = "none";
        fileInput.addEventListener("change", event => {
            const files = Array.from(event.target.files || []);
            event.target.value = "";
            void this.addFiles(files);
        });

        section.content.append(tools, hint, list, props, fileInput);
        Object.assign(this.ui, { addBtn, editBtn, list, props, fileInput });
        this.buildFields(props);
        this.refresh();
        return section;
    }

    numberField(label, { min, max, step, slider = false, reset, title }) {
        const field = this.doc.createElement("div");
        field.className = "vnccs-ps-field";
        const labelRow = this.doc.createElement("div");
        labelRow.className = "vnccs-ps-label-row";
        const labelEl = this.doc.createElement("span");
        labelEl.className = "vnccs-ps-label";
        labelEl.textContent = label;
        if (title) labelEl.title = title;
        const valueRow = this.doc.createElement("div");
        valueRow.className = "vnccs-ps-reflayer-pair";
        const input = this.doc.createElement("input");
        input.type = "number";
        input.className = "vnccs-ps-input vnccs-ps-reflayer-num";
        Object.assign(input, { min, max, step });
        const resetBtn = this.doc.createElement("button");
        resetBtn.className = "vnccs-ps-reset-btn";
        resetBtn.type = "button";
        resetBtn.textContent = "↺";
        resetBtn.title = `Reset ${label.toLowerCase()}`;
        resetBtn.addEventListener("click", event => {
            event.stopPropagation();
            reset();
        });
        valueRow.append(input, resetBtn);
        labelRow.append(labelEl, valueRow);
        field.appendChild(labelRow);
        let range = null;
        if (slider) {
            const wrap = this.doc.createElement("div");
            wrap.className = "vnccs-ps-slider-wrap";
            range = this.doc.createElement("input");
            range.type = "range";
            range.className = "vnccs-ps-slider";
            Object.assign(range, { min, max, step });
            wrap.appendChild(range);
            field.appendChild(wrap);
        }
        return { field, input, range, resetBtn };
    }

    bindValue(control, apply) {
        // Same gesture contract as every Pose Studio slider: one undo step per
        // gesture, visible update on every input event, save on gesture end.
        this.host.trackPoseGesture?.(control, { recordPose: true });
        control.addEventListener("input", () => {
            if (control.value === "" || !Number.isFinite(Number(control.value))) return;
            const layer = this.selectedLayer();
            if (layer) this.updateLayer(layer.id, apply(Number(control.value), layer), { source: control });
        });
    }

    buildFields(props) {
        const opacity = this.numberField("Opacity %", {
            min: 0, max: 100, step: 1, slider: true, reset: () => this.resetTransform("opacity"),
        });
        const position = this.doc.createElement("div");
        position.className = "vnccs-ps-field";
        const positionRow = this.doc.createElement("div");
        positionRow.className = "vnccs-ps-label-row";
        const positionLabel = this.doc.createElement("span");
        positionLabel.className = "vnccs-ps-label";
        positionLabel.textContent = "Position px";
        positionLabel.title = "Offset of the layer centre from the frame centre, in output pixels (Y down)";
        const pair = this.doc.createElement("div");
        pair.className = "vnccs-ps-reflayer-pair";
        const makeAxis = axis => {
            const label = this.doc.createElement("label");
            label.textContent = axis.toUpperCase();
            const input = this.doc.createElement("input");
            input.type = "number";
            input.className = "vnccs-ps-input vnccs-ps-reflayer-num";
            Object.assign(input, { min: -16384, max: 16384, step: 1 });
            pair.append(label, input);
            return input;
        };
        const posX = makeAxis("x"), posY = makeAxis("y");
        const posReset = this.doc.createElement("button");
        posReset.className = "vnccs-ps-reset-btn";
        posReset.type = "button";
        posReset.textContent = "↺";
        posReset.title = "Reset position to the frame centre";
        posReset.addEventListener("click", event => {
            event.stopPropagation();
            this.resetTransform("position");
        });
        pair.appendChild(posReset);
        positionRow.append(positionLabel);
        position.append(positionRow, pair);

        const scale = this.numberField("Scale %", {
            min: 1, max: 400, step: 1, slider: true, reset: () => this.resetTransform("scale"),
            title: "Layer height relative to the frame height",
        });
        const rotation = this.numberField("Rotation °", {
            min: -180, max: 180, step: 1, slider: true, reset: () => this.resetTransform("rotation"),
        });

        const flip = this.doc.createElement("button");
        flip.className = "vnccs-ps-btn";
        flip.type = "button";
        flip.textContent = "⇋ Flip Horizontal";
        flip.addEventListener("click", () => {
            const layer = this.selectedLayer();
            if (layer) this.edit(layer.id, { flipX: !layer.flipX });
        });

        for (const control of [opacity.input, opacity.range]) this.bindValue(control, value => ({ opacity: value / 100 }));
        for (const control of [scale.input, scale.range]) this.bindValue(control, value => ({ scale: value / 100 }));
        for (const control of [rotation.input, rotation.range]) this.bindValue(control, value => ({ rotation: value }));
        this.bindValue(posX, value => ({ x: value / this.frameSize().height }));
        this.bindValue(posY, value => ({ y: -value / this.frameSize().height }));

        props.append(opacity.field, position, scale.field, rotation.field, flip);
        Object.assign(this.ui, { opacity, posX, posY, scale, rotation, flip });
    }

    syncFields(source = null) {
        const ui = this.ui;
        if (!ui.props) return;
        const layer = this.selectedLayer();
        ui.props.style.display = layer ? "" : "none";
        if (!layer) return;
        const height = this.frameSize().height;
        const set = (control, value) => {
            if (control && control !== source) control.value = String(value);
        };
        const opacity = Math.round(layer.opacity * 100);
        set(ui.opacity.input, opacity); set(ui.opacity.range, opacity);
        set(ui.posX, Math.round(layer.x * height));
        set(ui.posY, Math.round(-layer.y * height) || 0);
        const scale = Math.round(layer.scale * 1000) / 10;
        set(ui.scale.input, scale); set(ui.scale.range, scale);
        const rotation = Math.round(layer.rotation * 10) / 10;
        set(ui.rotation.input, rotation); set(ui.rotation.range, rotation);
        ui.flip.classList?.toggle?.("active", layer.flipX);
        const disabled = layer.locked;
        for (const control of [ui.opacity.input, ui.opacity.range, ui.posX, ui.posY, ui.scale.input, ui.scale.range,
            ui.rotation.input, ui.rotation.range, ui.flip]) control.disabled = disabled;
    }

    syncToolbar() {
        const { editBtn, addBtn } = this.ui;
        editBtn?.classList?.toggle?.("active", this.editMode);
        if (editBtn) editBtn.setAttribute?.("aria-pressed", String(this.editMode));
        if (addBtn) addBtn.disabled = this.layers.length >= REFERENCE_LAYER_LIMIT;
    }

    renderList() {
        const list = this.ui.list;
        if (!list) return;
        const rows = [...this.layers].reverse().map((layer, displayIndex) => {
            const row = this.doc.createElement("div");
            row.className = this.rowClass(layer);
            row.dataset.layerId = layer.id;
            row.addEventListener("click", () => this.select(layer.id));
            const thumb = this.doc.createElement("img");
            thumb.className = "vnccs-ps-reflayer-thumb";
            thumb.src = layer.src;
            thumb.alt = "";
            const name = layer.id === this.renamingId ? this.renameInput(layer) : this.doc.createElement("span");
            name.className = "vnccs-ps-reflayer-name";
            if (layer.id !== this.renamingId) {
                name.textContent = layer.name;
                name.title = `${layer.name} (double-click to rename)`;
                name.addEventListener("dblclick", event => {
                    event.stopPropagation();
                    this.startRename(layer.id);
                });
            }
            const button = (text, title, action, on = false) => {
                const element = this.doc.createElement("button");
                element.type = "button";
                element.className = "vnccs-ps-reflayer-icon" + (on ? " on" : "");
                element.textContent = text;
                element.title = title;
                element.dataset.action = title;
                element.addEventListener("click", event => {
                    event.stopPropagation();
                    action();
                });
                return element;
            };
            const top = displayIndex === 0, bottom = displayIndex === this.layers.length - 1;
            const up = button("▲", "Move up", () => this.moveLayer(layer.id, 1));
            const down = button("▼", "Move down", () => this.moveLayer(layer.id, -1));
            up.disabled = top;
            down.disabled = bottom;
            row.append(
                thumb,
                name,
                button(layer.visible ? "◉" : "○", layer.visible ? "Hide" : "Show",
                    () => this.edit(layer.id, { visible: !layer.visible }), layer.visible),
                button(layer.locked ? "🔒" : "🔓", layer.locked ? "Unlock" : "Lock",
                    () => this.edit(layer.id, { locked: !layer.locked }), layer.locked),
                up,
                down,
                button("✕", "Delete", () => this.removeLayer(layer.id)),
            );
            return row;
        });
        list.replaceChildren(...rows);
        list.style.display = rows.length ? "" : "none";
        const input = this.ui.renameInput;
        this.ui.renameInput = null;
        input?.focus?.();
        input?.select?.();
    }

    rowClass(layer) {
        return "vnccs-ps-reflayer-row"
            + (layer.id === this.selectedId ? " selected" : "") + (layer.visible ? "" : " hidden-layer");
    }

    /** Inline name editor: Enter or leaving the field saves, Escape cancels. */
    renameInput(layer) {
        const input = this.doc.createElement("input");
        input.type = "text";
        input.value = layer.name;
        input.addEventListener("click", event => event.stopPropagation());
        input.addEventListener("dblclick", event => event.stopPropagation());
        input.addEventListener("pointerdown", event => event.stopPropagation());
        input.addEventListener("keydown", event => {
            // Keep typing away from Pose Studio and ComfyUI shortcuts.
            event.stopPropagation();
            if (event.key === "Enter") this.finishRename(layer.id, input.value);
            else if (event.key === "Escape") this.finishRename(layer.id, layer.name);
        });
        input.addEventListener("blur", () => this.finishRename(layer.id, input.value));
        this.ui.renameInput = input;
        return input;
    }

    refresh() {
        this.syncMeshes();
        this.renderList();
        this.syncFields();
        this.syncToolbar();
        this.requestRender();
    }

    dispose() {
        this._disposed = true;
        this.loadToken++;
        this.drag = null;
        this._listeners.splice(0).forEach(remove => remove());
        for (const entry of this.entries.values()) this.disposeEntry(entry);
        this.entries.clear();
        this.group?.parent?.remove(this.group);
        this.group = null;
        this.overlay?.remove?.();
        this.overlay = null;
    }
}
