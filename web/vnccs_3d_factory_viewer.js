import * as THREE from "./vendor/spark/three.module.js";
import { OrbitControls } from "./vendor/spark/OrbitControls.js";
import { TransformControls } from "./vendor/spark/TransformControls.js";
import { SparkRenderer, SplatMesh } from "./vendor/spark/spark.module.js";


const EMPTY = () => {};
const LOD_MIN_GAUSSIANS = 262_145;
export const FACTORY_VIEWER_BUILD = "20260724.16";

function finiteVector(values, fallback = [0, 0, 0]) {
    return fallback.map((item, index) => {
        const value = Number(values?.[index]);
        return Number.isFinite(value) ? value : item;
    });
}

function normalizedTransform(value = {}) {
    const scale = Number(value.scale);
    return {
        position: finiteVector(value.position),
        rotation: finiteVector(value.rotation),
        scale: Number.isFinite(scale) ? Math.max(0.001, Math.min(1000, scale)) : 1,
    };
}

export function effectiveVisibleObjectIds(sceneData = {}) {
    const objects = new Map(
        (Array.isArray(sceneData.objects) ? sceneData.objects : [])
            .filter(item => item?.object_id)
            .map(item => [item.object_id, item]),
    );
    const visible = new Set();
    const layers = Array.isArray(sceneData.layers) ? sceneData.layers : [];
    const assigned = new Set();
    for (const layer of layers) {
        if (layer?.type === "object" && objects.has(layer.object_id)) {
            assigned.add(layer.object_id);
            if (objects.get(layer.object_id).visible !== false) visible.add(layer.object_id);
            continue;
        }
        if (layer?.type !== "group" || !Array.isArray(layer.children)) continue;
        for (const objectId of layer.children) {
            if (!objects.has(objectId) || assigned.has(objectId)) continue;
            assigned.add(objectId);
            if (layer.visible !== false && objects.get(objectId).visible !== false) {
                visible.add(objectId);
            }
        }
    }
    for (const [objectId, item] of objects) {
        if (!assigned.has(objectId) && item.visible !== false) visible.add(objectId);
    }
    return visible;
}

/**
 * TripoSplat's official viewer applies these two rotations after loading the
 * exported Gaussian: child yaw +90° around Y, then parent flip 180° around X.
 * Keep this separate from the editable scene transform so a new object still
 * has position/rotation 0 and scale 1.
 */
export function triposplatCanonicalMatrix() {
    return new THREE.Matrix4()
        .makeRotationX(Math.PI)
        .multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2));
}

function degrees(value) {
    return value * 180 / Math.PI;
}

function radians(value) {
    return value * Math.PI / 180;
}

export function validateSplatBuffer(buffer, label = "SPLAT asset") {
    if (!(buffer instanceof ArrayBuffer)) {
        throw new TypeError(`${label} did not return an ArrayBuffer`);
    }
    if (!buffer.byteLength) {
        throw new Error(`${label} is empty`);
    }
    if (buffer.byteLength % 32 !== 0) {
        throw new Error(
            `${label} contains ${buffer.byteLength.toLocaleString()} bytes; `
            + "a compact SPLAT must contain exactly 32 bytes per Gaussian",
        );
    }
    return buffer;
}

export function prepareSplatBuffer(buffer, label = "SPLAT asset") {
    validateSplatBuffer(buffer, label);
    const count = buffer.byteLength / 32;
    const source = new DataView(buffer);
    let output = null;
    let target = source;
    let invalid = 0;
    let visible = 0;
    const makeWritable = () => {
        if (!output) {
            output = buffer.slice(0);
            target = new DataView(output);
        }
    };
    for (let index = 0; index < count; index += 1) {
        const offset = index * 32;
        const values = [
            source.getFloat32(offset, true),
            source.getFloat32(offset + 4, true),
            source.getFloat32(offset + 8, true),
            source.getFloat32(offset + 12, true),
            source.getFloat32(offset + 16, true),
            source.getFloat32(offset + 20, true),
        ];
        const valid = values.every(Number.isFinite)
            && values.slice(0, 3).every(value => Math.abs(value) <= 1_000_000)
            && values.slice(3).every(value => value > 0 && value <= 1_000_000);
        if (!valid) {
            makeWritable();
            invalid += 1;
            target.setFloat32(offset, 0, true);
            target.setFloat32(offset + 4, 0, true);
            target.setFloat32(offset + 8, 0, true);
            target.setFloat32(offset + 12, 0.000001, true);
            target.setFloat32(offset + 16, 0.000001, true);
            target.setFloat32(offset + 20, 0.000001, true);
            target.setUint8(offset + 27, 0);
            target.setUint8(offset + 28, 255);
            target.setUint8(offset + 29, 128);
            target.setUint8(offset + 30, 128);
            target.setUint8(offset + 31, 128);
            continue;
        }
        if (source.getUint8(offset + 27) > 0) visible += 1;
    }
    if (!visible) {
        throw new Error(
            `${label} contains ${count.toLocaleString()} records but no finite visible Gaussians`
            + (invalid ? ` (${invalid.toLocaleString()} invalid records)` : ""),
        );
    }
    return {
        buffer: output || buffer,
        diagnostics: {
            gaussians: count,
            visible,
            invalid,
            repaired: Boolean(output),
        },
    };
}

function paddedBounds(box) {
    if (!box || box.isEmpty()) return new THREE.Box3();
    const size = box.getSize(new THREE.Vector3());
    const largest = Math.max(size.x, size.y, size.z);
    box.expandByScalar(Math.max(largest * 0.025, 0.00001));
    return box;
}

function hasFiniteBounds(box) {
    return Boolean(
        box
        && !box.isEmpty()
        && [
            box.min.x,
            box.min.y,
            box.min.z,
            box.max.x,
            box.max.y,
            box.max.z,
        ].every(Number.isFinite),
    );
}

/**
 * Build interaction bounds from visible Gaussian centers instead of their
 * covariance radii. A single nearly transparent Gaussian with a very large
 * scale must not make selection, framing, and transform controls unusable.
 */
export function computeRobustSplatBounds(mesh, options = {}) {
    const maxSamples = Math.max(256, Number(options.maxSamples) || 16384);
    const opacityThreshold = Math.max(0, Number(options.opacityThreshold) || 0.01);
    const trimFraction = Math.max(0, Math.min(0.02, Number(options.trimFraction) || 0.002));
    const splatCount = Math.max(0, Number(mesh?.numSplats) || 0);
    const stride = Math.max(1, Math.ceil(splatCount / maxSamples));
    const coordinates = [[], [], []];

    try {
        mesh.forEachSplat((index, center, _scales, _quaternion, opacity) => {
            if (index % stride !== 0) return;
            if (Number.isFinite(opacity) && opacity < opacityThreshold) return;
            const values = [Number(center?.x), Number(center?.y), Number(center?.z)];
            if (!values.every(Number.isFinite)) return;
            coordinates[0].push(values[0]);
            coordinates[1].push(values[1]);
            coordinates[2].push(values[2]);
        });
    } catch (_) {}

    const sampleCount = coordinates[0].length;
    if (sampleCount >= 8) {
        for (const axis of coordinates) axis.sort((left, right) => left - right);
        const trim = sampleCount >= 128
            ? Math.min(
                Math.floor(sampleCount * trimFraction),
                Math.floor((sampleCount - 2) / 2),
            )
            : 0;
        const last = sampleCount - 1 - trim;
        const box = new THREE.Box3(
            new THREE.Vector3(
                coordinates[0][trim],
                coordinates[1][trim],
                coordinates[2][trim],
            ),
            new THREE.Vector3(
                coordinates[0][last],
                coordinates[1][last],
                coordinates[2][last],
            ),
        );
        if (!box.isEmpty()) return paddedBounds(box);
    }

    try {
        const box = paddedBounds(mesh.getBoundingBox(true).clone());
        return hasFiniteBounds(box) ? box : new THREE.Box3();
    } catch (_) {
        return new THREE.Box3(
            new THREE.Vector3(-0.5, -0.5, -0.5),
            new THREE.Vector3(0.5, 0.5, 0.5),
        );
    }
}

export function boundedObjectHit(ray, entries) {
    let nearest = null;
    const point = new THREE.Vector3();
    for (const [objectId, entry] of entries) {
        if (
            !entry?.mesh
            || entry.mesh.visible === false
            || !entry?.localBounds
            || entry.localBounds.isEmpty()
        ) continue;
        entry.mesh.updateMatrixWorld(true);
        const worldBounds = entry.localBounds.clone().applyMatrix4(entry.mesh.matrixWorld);
        if (!ray.intersectBox(worldBounds, point)) continue;
        const distance = ray.origin.distanceTo(point);
        if (!nearest || distance < nearest.distance) nearest = { objectId, distance };
    }
    return nearest;
}

export class Factory3DViewer {
    constructor(host, options = {}) {
        if (!host?.appendChild) throw new TypeError("Factory3DViewer requires a host element");
        this.host = host;
        this.options = {
            onSelectionChange: options.onSelectionChange || EMPTY,
            onTransformChange: options.onTransformChange || EMPTY,
            onStateChange: options.onStateChange || EMPTY,
            onLoadingChange: options.onLoadingChange || EMPTY,
            onError: options.onError || EMPTY,
            resolveAssetURL: options.resolveAssetURL || (value => value),
        };
        this.objects = new Map();
        this.sceneData = null;
        this.selectedId = "";
        this.selectedGroupId = "";
        this.selectedGroupObjectIds = [];
        this._groupTransformStart = null;
        this.mode = "translate";
        this.gridVisible = false;
        this.captureWidth = 1024;
        this.captureHeight = 1024;
        this.captureFov = 42;
        this.cameraFrameVisible = false;
        this._capturing = false;
        this._disposed = false;
        this._loadingToken = 0;
        this._loadController = null;
        this._suppressTransform = false;
        this._frame = 0;
        this._resizeObserver = null;
        this._interactionReasons = new Set();
        this._lodQueue = Promise.resolve();
        this._pendingLodCandidates = [];
        this._setup();
    }

    _setup() {
        this.canvas = document.createElement("canvas");
        this.canvas.className = "vnccs-i3s__factory-canvas";
        this.canvas.tabIndex = 0;
        this.canvas.setAttribute(
            "aria-label",
            "3D scene. Click an object to select it, then drag the transform gizmo.",
        );
        Object.assign(this.canvas.style, {
            width: "100%",
            height: "100%",
            display: "block",
            touchAction: "none",
            outline: "none",
        });
        this.host.appendChild(this.canvas);
        this.cameraFrame = document.createElement("div");
        this.cameraFrame.className = "vnccs-i3s__camera-frame";
        this.cameraFrame.setAttribute("aria-hidden", "true");
        this.cameraFrameLabel = document.createElement("span");
        this.cameraFrame.appendChild(this.cameraFrameLabel);
        this.host.appendChild(this.cameraFrame);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color("#171b25");
        this.camera = new THREE.PerspectiveCamera(42, 1, 0.0001, 100000);
        this.camera.position.set(2.8, 2.1, 4.2);
        this.captureCamera = new THREE.PerspectiveCamera(42, 1, 0.0001, 100000);

        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: false,
            alpha: false,
            powerPreference: "high-performance",
        });
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this._nativePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        this.renderer.setPixelRatio(this._nativePixelRatio);

        // Spark 2.x keeps sorting, frustum selection, and LoD traversal in
        // workers. Do not impose a fixed aggregate splat cap here: Spark's
        // platform-aware budget and screen-space tree traversal distribute
        // detail by projected importance across every object in the scene.
        // Every original Gaussian remains in the object and scene exports.
        this.spark = new SparkRenderer({
            renderer: this.renderer,
            maxStdDev: Math.sqrt(5),
            minSortIntervalMs: 16,
            lodRenderScale: 1.25,
            behindFoveate: 0.1,
            coneFov0: 100,
            coneFov: 145,
            coneFoveate: 0.35,
        });
        this.scene.add(this.spark);

        this.controls = new OrbitControls(this.camera, this.canvas);
        this.controls.target.set(0, 0, 0);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.enablePan = true;
        this.controls.enableZoom = true;
        this.controls.minDistance = 0.0001;
        this.controls.maxDistance = 1_000_000;
        this.controls.mouseButtons = {
            LEFT: THREE.MOUSE.ROTATE,
            MIDDLE: THREE.MOUSE.PAN,
            RIGHT: THREE.MOUSE.ROTATE,
        };
        this.controls.addEventListener("change", () => {
            this._updateClipPlanes();
            this._emitState();
        });
        this.controls.addEventListener("start", () => this._setInteractive("orbit", true));
        this.controls.addEventListener("end", () => this._setInteractive("orbit", false));

        this.grid = new THREE.GridHelper(20, 40, 0x826f9e, 0x343140);
        this.grid.material.transparent = true;
        this.grid.material.opacity = 0.28;
        this.grid.visible = this.gridVisible;
        this.scene.add(this.grid);

        this.transform = new TransformControls(this.camera, this.canvas);
        this.transformHelper = this.transform.getHelper();
        this.transformHelper.renderOrder = 10_000;
        this.transformHelper.traverse(child => {
            child.renderOrder = 10_000;
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            for (const material of materials) {
                if (!material) continue;
                material.depthTest = false;
                material.depthWrite = false;
            }
        });
        this.scene.add(this.transformHelper);
        this.transform.setMode(this.mode);
        this.transform.setSpace("world");
        this.transform.setSize(0.9);

        this.selectionBounds = new THREE.Box3Helper(new THREE.Box3(), 0xff8fa3);
        this.selectionBounds.visible = false;
        this.selectionBounds.renderOrder = 9_999;
        this.selectionBounds.material.depthTest = false;
        this.selectionBounds.material.depthWrite = false;
        this.selectionBounds.material.transparent = true;
        this.selectionBounds.material.opacity = 0.72;
        this.scene.add(this.selectionBounds);
        this.groupPivot = new THREE.Group();
        this.groupPivot.name = "VNCCS Factory group transform pivot";
        this.scene.add(this.groupPivot);
        this.transform.addEventListener("dragging-changed", event => {
            this.controls.enabled = !event.value;
            this._setInteractive("transform", Boolean(event.value));
            if (event.value && this.selectedGroupId) this._beginGroupTransform();
            if (!event.value) {
                if (this.selectedGroupId) {
                    this._applyGroupTransform(true);
                    this._configureGroupPivot();
                } else {
                    const entry = this.selectedId ? this.objects.get(this.selectedId) : null;
                    if (entry) {
                        const transform = this._meshTransform(entry.mesh);
                        entry.data.transform = transform;
                        this.options.onTransformChange(this.selectedId, transform, { final: true });
                    }
                }
                this._emitState();
            }
        });
        this.transform.addEventListener("mouseDown", () => {
            if (this.selectedGroupId) {
                this._beginGroupTransform();
                this._scaleDragStart = 1;
            } else {
                const mesh = this.selectedId ? this.objects.get(this.selectedId)?.mesh : null;
                this._scaleDragStart = mesh ? mesh.scale.x : 1;
            }
        });
        this.transform.addEventListener("objectChange", () => this._onTransformObjectChange());

        this.raycaster = new THREE.Raycaster();
        this.pointer = new THREE.Vector2();
        this._pointerDown = null;
        this.canvas.addEventListener("pointerdown", event => {
            try { this.canvas.focus({ preventScroll: true }); }
            catch (_) { this.canvas.focus(); }
            this._pointerDown = [event.clientX, event.clientY];
        });
        this.canvas.addEventListener("pointerup", event => {
            if (!this._pointerDown || this.transform.dragging) return;
            const distance = Math.hypot(
                event.clientX - this._pointerDown[0],
                event.clientY - this._pointerDown[1],
            );
            this._pointerDown = null;
            if (distance > 4 || event.button !== 0) return;
            this._pick(event);
        });
        this.canvas.addEventListener("keydown", event => {
            const mode = { w: "translate", e: "rotate", r: "scale" }[event.key.toLowerCase()];
            if (mode) {
                event.preventDefault();
                this.setMode(mode);
                return;
            }
            if (event.key.toLowerCase() === "f") {
                event.preventDefault();
                this.fit(this.selectedId);
            } else if (event.key === "Escape") {
                event.preventDefault();
                this.select("");
            }
        });

        this._resizeObserver = new ResizeObserver(() => this.resize());
        this._resizeObserver.observe(this.host);
        this.resize();
        this._animate();
    }

    _animate() {
        if (this._disposed) return;
        this._frame = requestAnimationFrame(() => this._animate());
        if (this._capturing) return;
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }

    _setInteractive(reason, active) {
        if (active) this._interactionReasons.add(reason);
        else this._interactionReasons.delete(reason);
        const ratio = this._interactionReasons.size
            ? Math.min(this._nativePixelRatio, 1)
            : this._nativePixelRatio;
        if (Math.abs(this.renderer.getPixelRatio() - ratio) < 1e-6) return;
        this.renderer.setPixelRatio(ratio);
        this.resize();
    }

    resize() {
        if (this._disposed) return;
        const rect = this.host.getBoundingClientRect();
        const width = Math.max(1, Math.floor(rect.width));
        const height = Math.max(1, Math.floor(rect.height));
        this._updateCameraProjection(width, height);
        this.renderer.setSize(width, height, false);
        this._updateCameraFrame(width, height);
    }

    _updateCameraProjection(width = 0, height = 0) {
        const viewWidth = Math.max(1, Number(width) || this.host.clientWidth || 1);
        const viewHeight = Math.max(1, Number(height) || this.host.clientHeight || 1);
        const viewAspect = viewWidth / viewHeight;
        const captureAspect = this.captureWidth / Math.max(1, this.captureHeight);
        let editorFov = this.captureFov;
        if (this.cameraFrameVisible && captureAspect > viewAspect) {
            editorFov = degrees(
                2 * Math.atan(
                    Math.tan(radians(this.captureFov) * 0.5) * captureAspect / viewAspect,
                ),
            );
        }
        this.camera.aspect = viewAspect;
        this.camera.fov = Math.max(5, Math.min(150, editorFov));
        this.camera.updateProjectionMatrix();
    }

    _updateCameraFrame(width = 0, height = 0) {
        if (!this.cameraFrame) return;
        const viewWidth = Math.max(1, Number(width) || this.host.clientWidth || 1);
        const viewHeight = Math.max(1, Number(height) || this.host.clientHeight || 1);
        const viewAspect = viewWidth / viewHeight;
        const captureAspect = this.captureWidth / Math.max(1, this.captureHeight);
        let frameWidth = viewWidth;
        let frameHeight = viewHeight;
        if (captureAspect < viewAspect) frameWidth = viewHeight * captureAspect;
        else if (captureAspect > viewAspect) frameHeight = viewWidth / captureAspect;
        Object.assign(this.cameraFrame.style, {
            display: this.cameraFrameVisible ? "block" : "none",
            left: `${Math.max(0, (viewWidth - frameWidth) * 0.5)}px`,
            top: `${Math.max(0, (viewHeight - frameHeight) * 0.5)}px`,
            width: `${Math.max(1, frameWidth)}px`,
            height: `${Math.max(1, frameHeight)}px`,
        });
        this.cameraFrameLabel.textContent = `${this.captureWidth} × ${this.captureHeight}`;
    }

    _pick(event) {
        const rect = this.canvas.getBoundingClientRect();
        this.pointer.set(
            ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
            -((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
        );
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const meshes = Array.from(this.objects.values(), entry => entry.splat || entry.mesh);
        let hits = [];
        try {
            hits = this.raycaster.intersectObjects(meshes, false);
        } catch (error) {
            this.options.onError(error);
        }
        if (hits[0]) {
            const objectId = hits[0].object?.userData?.factoryObjectId;
            if (objectId && this.objects.has(objectId)) {
                this.select(objectId, { additive: event.shiftKey });
                return;
            }
        }
        const fallback = boundedObjectHit(this.raycaster.ray, this.objects);
        this.select(fallback?.objectId || "", { additive: event.shiftKey });
    }

    _applyTransform(mesh, value) {
        const transform = normalizedTransform(value);
        this._suppressTransform = true;
        mesh.position.fromArray(transform.position);
        mesh.rotation.set(
            radians(transform.rotation[0]),
            radians(transform.rotation[1]),
            radians(transform.rotation[2]),
            "XYZ",
        );
        mesh.scale.setScalar(transform.scale);
        mesh.updateMatrixWorld(true);
        this._suppressTransform = false;
        if (mesh === this.objects.get(this.selectedId)?.mesh) this._refreshSelectionBounds();
    }

    _meshTransform(mesh) {
        const scalar = Math.max(0.001, Math.min(1000, (mesh.scale.x + mesh.scale.y + mesh.scale.z) / 3));
        return {
            position: mesh.position.toArray().map(value => Number(value.toFixed(6))),
            rotation: [
                degrees(mesh.rotation.x),
                degrees(mesh.rotation.y),
                degrees(mesh.rotation.z),
            ].map(value => Number(value.toFixed(4))),
            scale: Number(scalar.toFixed(6)),
        };
    }

    _onTransformObjectChange() {
        if (this._suppressTransform) return;
        if (this.selectedGroupId) {
            if (this.mode === "scale") {
                const values = [this.groupPivot.scale.x, this.groupPivot.scale.y, this.groupPivot.scale.z];
                const scalar = Math.max(0.001, Math.min(1000, values.reduce(
                    (chosen, value) => Math.abs(value - 1) > Math.abs(chosen - 1) ? value : chosen,
                    values[0],
                )));
                this._suppressTransform = true;
                this.groupPivot.scale.setScalar(scalar);
                this._suppressTransform = false;
            }
            this._applyGroupTransform(!this.transform.dragging);
            return;
        }
        if (!this.selectedId) return;
        const entry = this.objects.get(this.selectedId);
        if (!entry) return;
        if (this.mode === "scale") {
            const values = [entry.mesh.scale.x, entry.mesh.scale.y, entry.mesh.scale.z];
            const origin = Number(this._scaleDragStart) || 1;
            const scalar = Math.max(0.001, Math.min(1000, values.reduce(
                (chosen, value) => Math.abs(value - origin) > Math.abs(chosen - origin) ? value : chosen,
                values[0],
            )));
            this._suppressTransform = true;
            entry.mesh.scale.setScalar(scalar);
            this._suppressTransform = false;
        }
        const transform = this._meshTransform(entry.mesh);
        entry.data.transform = transform;
        this._refreshSelectionBounds();
        this.options.onTransformChange(this.selectedId, transform, { final: !this.transform.dragging });
    }

    _groupEntries() {
        return this.selectedGroupObjectIds
            .map(objectId => [objectId, this.objects.get(objectId)])
            .filter(([, entry]) => Boolean(entry));
    }

    _groupWorldBounds() {
        const box = new THREE.Box3();
        for (const [, entry] of this._groupEntries()) {
            try {
                entry.mesh.updateMatrixWorld(true);
                box.union(entry.localBounds.clone().applyMatrix4(entry.mesh.matrixWorld));
            } catch (_) {}
        }
        return box;
    }

    _configureGroupPivot() {
        if (!this.selectedGroupId) return;
        const box = this._groupWorldBounds();
        if (box.isEmpty()) {
            this.transform.detach();
            this.selectionBounds.visible = false;
            return;
        }
        this._suppressTransform = true;
        this.groupPivot.position.copy(box.getCenter(new THREE.Vector3()));
        this.groupPivot.quaternion.identity();
        this.groupPivot.scale.setScalar(1);
        this.groupPivot.updateMatrixWorld(true);
        this._suppressTransform = false;
        this._groupTransformStart = null;
        this.transform.attach(this.groupPivot);
        this._refreshSelectionBounds();
    }

    _beginGroupTransform() {
        if (!this.selectedGroupId || this._groupTransformStart) return;
        this.groupPivot.updateMatrixWorld(true);
        const pivotMatrix = this.groupPivot.matrixWorld.clone();
        const inversePivot = pivotMatrix.clone().invert();
        const objects = new Map();
        for (const [objectId, entry] of this._groupEntries()) {
            entry.mesh.updateMatrixWorld(true);
            objects.set(objectId, entry.mesh.matrixWorld.clone());
        }
        this._groupTransformStart = { pivotMatrix, inversePivot, objects };
    }

    _applyGroupTransform(final = false) {
        if (!this.selectedGroupId) return;
        this._beginGroupTransform();
        const baseline = this._groupTransformStart;
        if (!baseline) return;
        this.groupPivot.updateMatrixWorld(true);
        const delta = this.groupPivot.matrixWorld.clone().multiply(baseline.inversePivot);
        const position = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        for (const [objectId, original] of baseline.objects) {
            const entry = this.objects.get(objectId);
            if (!entry) continue;
            const matrix = delta.clone().multiply(original);
            matrix.decompose(position, quaternion, scale);
            const scalar = Math.max(
                0.001,
                Math.min(1000, (Math.abs(scale.x) + Math.abs(scale.y) + Math.abs(scale.z)) / 3),
            );
            this._suppressTransform = true;
            entry.mesh.position.copy(position);
            entry.mesh.quaternion.copy(quaternion).normalize();
            entry.mesh.scale.setScalar(scalar);
            entry.mesh.updateMatrixWorld(true);
            this._suppressTransform = false;
            const transform = this._meshTransform(entry.mesh);
            entry.data.transform = transform;
            this.options.onTransformChange(objectId, transform, {
                final,
                group_id: this.selectedGroupId,
            });
        }
        this._refreshSelectionBounds();
        this.spark.setDirty?.();
        if (final) this._groupTransformStart = null;
    }

    _refreshSelectionBounds() {
        if (this.selectedGroupId) {
            const box = this._groupWorldBounds();
            if (box.isEmpty()) {
                this.selectionBounds.visible = false;
                this.selectionBounds.box.makeEmpty();
                return;
            }
            this.selectionBounds.box.copy(box);
            this.selectionBounds.visible = true;
            this.selectionBounds.updateMatrixWorld(true);
            return;
        }
        const entry = this.selectedId ? this.objects.get(this.selectedId) : null;
        if (!entry?.localBounds || entry.localBounds.isEmpty()) {
            this.selectionBounds.visible = false;
            this.selectionBounds.box.makeEmpty();
            return;
        }
        entry.mesh.updateMatrixWorld(true);
        this.selectionBounds.box.copy(entry.localBounds).applyMatrix4(entry.mesh.matrixWorld);
        this.selectionBounds.visible = true;
        this.selectionBounds.updateMatrixWorld(true);
    }

    async setScene(sceneData, { incremental = false } = {}) {
        const previousCount = this.objects.size;
        const token = incremental
            ? (this._loadingToken || ++this._loadingToken)
            : ++this._loadingToken;
        if (!incremental) this._loadController?.abort();
        const loadController = new AbortController();
        this._loadController = loadController;
        this.sceneData = sceneData || { objects: [] };
        const source = Array.isArray(sceneData?.objects) ? sceneData.objects : [];
        const needsAssetLoading = !incremental || source.some(item => {
            const entry = this.objects.get(item.object_id);
            return !entry || entry.assetPath !== item.urls?.splat;
        });
        this._pendingLodCandidates = [];
        this.options.onLoadingChange(needsAssetLoading);
        if (!incremental) {
            this.transform.detach();
            this.selectionBounds.visible = false;
            this.selectedGroupId = "";
            this.selectedGroupObjectIds = [];
            for (const entry of this.objects.values()) {
                this.scene.remove(entry.mesh);
                entry.splat?.dispose?.();
            }
            this.objects.clear();
        }

        const sourceIds = new Set(source.map(item => item.object_id));
        if (incremental) {
            for (const [objectId, entry] of this.objects) {
                if (sourceIds.has(objectId)) continue;
                if (objectId === this.selectedId) this.selectedId = "";
                this.selectedGroupObjectIds = this.selectedGroupObjectIds.filter(id => id !== objectId);
                this.scene.remove(entry.mesh);
                entry.splat?.dispose?.();
                this.objects.delete(objectId);
            }
        }
        const visibleIds = effectiveVisibleObjectIds(sceneData);
        const failures = [];
        const lodCandidates = [];
        for (const item of source) {
            if (token !== this._loadingToken || this._disposed) return;
            let mesh = null;
            let objectRoot = null;
            try {
                const assetPath = item.urls?.splat;
                if (!assetPath) throw new Error(`Object ${item.object_id} has no SPLAT asset URL`);
                const existing = this.objects.get(item.object_id);
                if (existing?.assetPath === assetPath) {
                    existing.data = item;
                    existing.mesh.name = item.name || item.object_id;
                    existing.splat.name = item.name || item.object_id;
                    existing.mesh.visible = visibleIds.has(item.object_id);
                    this._applyTransform(existing.mesh, item.transform);
                    continue;
                }
                if (existing) {
                    this.scene.remove(existing.mesh);
                    existing.splat?.dispose?.();
                    this.objects.delete(item.object_id);
                }
                const assetURL = this.options.resolveAssetURL(assetPath);
                const loadStarted = performance.now();
                console.info("[VNCCS 3D Factory][viewport] Fetching SPLAT", {
                    build: FACTORY_VIEWER_BUILD,
                    objectId: item.object_id,
                    url: assetURL,
                });
                const response = await fetch(assetURL, {
                    signal: loadController.signal,
                    credentials: "same-origin",
                    cache: "no-store",
                });
                if (!response.ok) {
                    let detail = "";
                    try { detail = (await response.text()).slice(0, 500); }
                    catch (_) {}
                    throw new Error(
                        `SPLAT download failed for ${item.object_id}: HTTP ${response.status}`
                        + (detail ? ` — ${detail}` : ""),
                    );
                }
                const preparedAsset = prepareSplatBuffer(
                    await response.arrayBuffer(),
                    `SPLAT object ${item.object_id}`,
                );
                const fileBytes = preparedAsset.buffer;
                const gaussianCount = fileBytes.byteLength / 32;
                const usesLod = gaussianCount >= LOD_MIN_GAUSSIANS;
                const createMesh = lod => {
                    const value = new SplatMesh({
                        fileBytes: lod ? fileBytes.slice(0) : fileBytes,
                        fileType: "splat",
                        fileName: `${item.object_id}.splat`,
                        lod: lod ? "quality" : false,
                        lodAbove: LOD_MIN_GAUSSIANS,
                        nonLod: lod,
                        raycastable: true,
                    });
                    value.name = item.name || item.object_id;
                    value.userData.factoryObjectId = item.object_id;
                    value.setRotationFromMatrix(triposplatCanonicalMatrix());
                    value.updateMatrix();
                    return value;
                };
                // Decode the original SPLAT first. It becomes visible as soon as
                // this promise resolves; expensive quality-LoD construction is
                // queued only after the complete object is already usable.
                mesh = createMesh(false);
                objectRoot = new THREE.Group();
                objectRoot.name = item.name || item.object_id;
                objectRoot.userData.factoryObjectId = item.object_id;
                objectRoot.add(mesh);
                this.scene.add(objectRoot);
                await mesh.initialized;
                if (!Number.isFinite(mesh.numSplats) || mesh.numSplats < 1) {
                    throw new Error(`SPLAT object ${item.object_id} decoded to zero Gaussians`);
                }
                if (token !== this._loadingToken || this._disposed) {
                    this.scene.remove(objectRoot);
                    mesh.dispose?.();
                    return;
                }
                this._applyTransform(objectRoot, item.transform);
                objectRoot.visible = visibleIds.has(item.object_id);
                const localBounds = computeRobustSplatBounds(mesh).applyMatrix4(mesh.matrix);
                if (!hasFiniteBounds(localBounds)) {
                    throw new Error(
                        `SPLAT object ${item.object_id} has no finite interaction bounds after decoding`,
                    );
                }
                this.objects.set(item.object_id, {
                    mesh: objectRoot,
                    splat: mesh,
                    data: item,
                    localBounds,
                    assetPath,
                });
                console.info("[VNCCS 3D Factory][viewport] SPLAT ready", {
                    build: FACTORY_VIEWER_BUILD,
                    objectId: item.object_id,
                    bytes: fileBytes.byteLength,
                    gaussians: gaussianCount,
                    payload: preparedAsset.diagnostics,
                    lod: usesLod
                        ? {
                            enabled: false,
                            builder: "quality",
                            aggregateBudget: "platform-adaptive",
                            allocation: "screen-space",
                            workerGenerated: true,
                            state: "full-splat-visible; quality-lod-queued",
                        }
                        : { enabled: false },
                    interactionBounds: {
                        min: localBounds.min.toArray(),
                        max: localBounds.max.toArray(),
                    },
                    elapsedMs: Math.round(performance.now() - loadStarted),
                });
                if (usesLod) {
                    lodCandidates.push({
                        token,
                        item,
                        objectRoot,
                        baseMesh: mesh,
                        fileBytes,
                    });
                }
            } catch (error) {
                if (error?.name === "AbortError") return;
                if (objectRoot) this.scene.remove(objectRoot);
                mesh?.dispose?.();
                failures.push({ objectId: item.object_id, error });
                this.options.onError(error);
            }
        }
        if (token === this._loadingToken) {
            if (needsAssetLoading) this.options.onLoadingChange(false);
            if (this._loadController === loadController) this._loadController = null;
        }
        if (this.selectedGroupId && this.selectedGroupObjectIds.some(id => this.objects.has(id))) {
            this.selectGroup(this.selectedGroupId, this.selectedGroupObjectIds);
        } else if (this.selectedId && this.objects.has(this.selectedId)) this.select(this.selectedId);
        else {
            const firstVisible = source.find(item => visibleIds.has(item.object_id));
            if (firstVisible && this.objects.has(firstVisible.object_id)) this.select(firstVisible.object_id);
            else this.select("");
        }
        if (this.objects.size && (!incremental || previousCount === 0)) this.fit();
        // The widget starts these only after it has captured the mandatory
        // current-revision preview. This keeps quality-LoD workers from
        // starving either initial object decoding or the export render.
        this._pendingLodCandidates = lodCandidates;
        return { loaded: this.objects.size, failures };
    }

    startPendingLodUpgrades() {
        const candidates = this._pendingLodCandidates;
        this._pendingLodCandidates = [];
        for (const candidate of candidates) this._queueLodUpgrade(candidate);
    }

    _queueLodUpgrade({ token, item, objectRoot, baseMesh, fileBytes }) {
        const upgrade = async () => {
            if (token !== this._loadingToken || this._disposed) return;
            const started = performance.now();
            let lodMesh = null;
            try {
                console.info("[VNCCS 3D Factory][viewport] Building background quality LOD", {
                    build: FACTORY_VIEWER_BUILD,
                    objectId: item.object_id,
                    gaussians: fileBytes.byteLength / 32,
                });
                lodMesh = new SplatMesh({
                    fileBytes: fileBytes.slice(0),
                    fileType: "splat",
                    fileName: `${item.object_id}.splat`,
                    lod: "quality",
                    lodAbove: LOD_MIN_GAUSSIANS,
                    nonLod: true,
                    raycastable: true,
                });
                lodMesh.name = item.name || item.object_id;
                lodMesh.userData.factoryObjectId = item.object_id;
                lodMesh.setRotationFromMatrix(triposplatCanonicalMatrix());
                lodMesh.updateMatrix();
                await lodMesh.initialized;
                if (!Number.isFinite(lodMesh.numSplats) || lodMesh.numSplats < 1) {
                    throw new Error(`quality LOD decoded to zero Gaussians`);
                }
                const entry = this.objects.get(item.object_id);
                if (
                    token !== this._loadingToken
                    || this._disposed
                    || !entry
                    || entry.mesh !== objectRoot
                    || entry.splat !== baseMesh
                ) {
                    lodMesh.dispose?.();
                    return;
                }
                const localBounds = computeRobustSplatBounds(lodMesh).applyMatrix4(lodMesh.matrix);
                if (!hasFiniteBounds(localBounds)) {
                    throw new Error("quality LOD produced no finite interaction bounds");
                }
                objectRoot.remove(baseMesh);
                objectRoot.add(lodMesh);
                entry.splat = lodMesh;
                entry.localBounds = localBounds;
                baseMesh.dispose?.();
                if (this.selectedId === item.object_id) this._refreshSelectionBounds();
                this.spark.setDirty?.();
                console.info("[VNCCS 3D Factory][viewport] Background quality LOD ready", {
                    build: FACTORY_VIEWER_BUILD,
                    objectId: item.object_id,
                    gaussians: lodMesh.numSplats,
                    elapsedMs: Math.round(performance.now() - started),
                });
            } catch (error) {
                lodMesh?.dispose?.();
                // The complete non-LoD mesh stays active. LOD is an optional
                // viewport optimization and must never make an object disappear.
                console.warn("[VNCCS 3D Factory][viewport] Quality LOD unavailable; keeping full SPLAT", {
                    build: FACTORY_VIEWER_BUILD,
                    objectId: item.object_id,
                    error,
                });
            }
        };
        this._lodQueue = this._lodQueue.catch(() => null).then(upgrade);
    }

    updateObject(objectId, value) {
        const entry = this.objects.get(objectId);
        if (!entry) return;
        entry.data = { ...entry.data, ...value };
        if ("name" in value) {
            entry.mesh.name = value.name || objectId;
            entry.splat.name = value.name || objectId;
        }
        if ("visible" in value) entry.mesh.visible = value.visible !== false;
        if (value.transform) this._applyTransform(entry.mesh, value.transform);
        if (objectId === this.selectedId || this.selectedGroupObjectIds.includes(objectId)) {
            this._refreshSelectionBounds();
        }
        this.spark.setDirty?.();
    }

    applySceneVisibility(sceneData = this.sceneData) {
        this.sceneData = sceneData || this.sceneData;
        const visibleIds = effectiveVisibleObjectIds(this.sceneData || {});
        for (const [objectId, entry] of this.objects) {
            entry.mesh.visible = visibleIds.has(objectId);
        }
        this._refreshSelectionBounds();
        this.spark.setDirty?.();
    }

    select(objectId, { additive = false } = {}) {
        const id = this.objects.has(objectId) ? objectId : "";
        this.selectedId = id;
        this.selectedGroupId = "";
        this.selectedGroupObjectIds = [];
        this._groupTransformStart = null;
        if (id) this.transform.attach(this.objects.get(id).mesh);
        else this.transform.detach();
        this._refreshSelectionBounds();
        this.options.onSelectionChange(id, { additive });
        this._emitState();
    }

    selectGroup(groupId, objectIds = []) {
        const ids = Array.from(new Set(objectIds)).filter(objectId => this.objects.has(objectId));
        this.selectedId = "";
        this.selectedGroupId = ids.length ? String(groupId || "") : "";
        this.selectedGroupObjectIds = ids;
        this._groupTransformStart = null;
        if (this.selectedGroupId) this._configureGroupPivot();
        else this.transform.detach();
        this._refreshSelectionBounds();
        this._emitState();
    }

    setMode(mode) {
        if (!["translate", "rotate", "scale"].includes(mode)) return;
        this.mode = mode;
        this.transform.setMode(mode);
        this.transform.showX = true;
        this.transform.showY = true;
        this.transform.showZ = true;
        this._emitState();
    }

    setGrid(visible) {
        this.gridVisible = Boolean(visible);
        this.grid.visible = this.gridVisible;
        this._emitState();
    }

    setCaptureSettings(value = {}) {
        const width = Math.round(Number(value.width));
        const height = Math.round(Number(value.height));
        if (Number.isFinite(width)) this.captureWidth = Math.max(64, Math.min(4096, width));
        if (Number.isFinite(height)) this.captureHeight = Math.max(64, Math.min(4096, height));
        if ("show_camera_frame" in value) {
            this.cameraFrameVisible = Boolean(value.show_camera_frame);
        }
        this._updateCameraProjection();
        this._updateCameraFrame();
        this.spark.setDirty?.();
    }

    getCaptureSettings() {
        return {
            width: this.captureWidth,
            height: this.captureHeight,
            show_camera_frame: this.cameraFrameVisible,
        };
    }

    fit(objectId = "") {
        const box = new THREE.Box3();
        const entries = objectId && this.objects.has(objectId)
            ? [this.objects.get(objectId)]
            : this.selectedGroupId
                ? this._groupEntries().map(([, entry]) => entry)
                : Array.from(this.objects.values()).filter(entry => entry.mesh.visible !== false);
        for (const entry of entries) {
            try {
                entry.mesh.updateMatrixWorld(true);
                box.union(entry.localBounds.clone().applyMatrix4(entry.mesh.matrixWorld));
            } catch (_) {}
        }
        if (box.isEmpty()) return;
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const radius = Math.max(sphere.radius, 0.001);
        // Fit against the export camera, not the editor canvas. Portrait
        // frames can be much narrower than the viewport, while a wide frame
        // can temporarily expand the editor FOV to show the complete crop.
        const verticalHalfFov = THREE.MathUtils.degToRad(this.captureFov * 0.5);
        const captureAspect = this.captureWidth / Math.max(1, this.captureHeight);
        const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * captureAspect);
        const limitingHalfFov = Math.max(
            THREE.MathUtils.degToRad(2.5),
            Math.min(verticalHalfFov, horizontalHalfFov),
        );
        const distance = radius / Math.sin(limitingHalfFov) * 1.16;
        const direction = this.camera.position.clone().sub(this.controls.target);
        if (direction.lengthSq() < 1e-12) direction.set(0.7, 0.5, 1);
        direction.normalize();
        this.controls.target.copy(sphere.center);
        this.camera.position.copy(sphere.center).addScaledVector(direction, distance);
        this.controls.minDistance = radius * 0.001;
        this.controls.maxDistance = radius * 10000;
        this.controls.update();
        this._updateClipPlanes(radius);
        this._emitState();
    }

    _updateClipPlanes(radiusHint = 0) {
        const distance = Math.max(this.camera.position.distanceTo(this.controls.target), radiusHint, 0.001);
        this.camera.near = Math.max(0.000001, distance / 100000);
        this.camera.far = Math.max(1000, distance * 100000);
        this.camera.updateProjectionMatrix();
    }

    getState() {
        return {
            selected_object_id: this.selectedId,
            selected_group_id: this.selectedGroupId,
            mode: this.mode,
            grid: this.gridVisible,
            camera: {
                position: this.camera.position.toArray(),
                target: this.controls.target.toArray(),
                fov: this.captureFov,
            },
        };
    }

    setState(value = {}) {
        if (value.mode) this.setMode(value.mode);
        if ("grid" in value) this.setGrid(value.grid);
        const position = finiteVector(value.camera?.position, this.camera.position.toArray());
        const target = finiteVector(value.camera?.target, this.controls.target.toArray());
        const fov = Number(value.camera?.fov);
        if (Number.isFinite(fov)) this.captureFov = Math.max(5, Math.min(120, fov));
        this.camera.position.fromArray(position);
        this.controls.target.fromArray(target);
        this.controls.update();
        this._updateCameraProjection();
        this._updateCameraFrame();
        this._updateClipPlanes();
    }

    _emitState() {
        if (!this._disposed) this.options.onStateChange(this.getState());
    }

    async _waitForRenderable(timeoutMs = 15000) {
        const started = performance.now();
        let frames = 0;
        this.spark.setDirty?.();
        while (!this._disposed && performance.now() - started < timeoutMs) {
            await new Promise(resolve => setTimeout(resolve, 32));
            this.renderer.render(this.scene, this.camera);
            frames += 1;
            if (frames >= 2 && Number(this.spark.activeSplats) > 0) {
                return Number(this.spark.activeSplats);
            }
        }
        throw new Error(
            `3D viewport did not produce renderable splats within ${Math.round(timeoutMs / 1000)} seconds`,
        );
    }

    async capturePreview({
        width = this.captureWidth,
        height = this.captureHeight,
    } = {}) {
        if (this._disposed) throw new Error("3D viewport has been disposed");
        if (!this.objects.size) return null;
        const targetWidth = Math.max(64, Math.min(4096, Math.round(Number(width) || 1024)));
        const targetHeight = Math.max(64, Math.min(4096, Math.round(Number(height) || 1024)));
        const hasVisibleObjects = Array.from(this.objects.values()).some(
            entry => entry.mesh?.visible !== false,
        );
        if (hasVisibleObjects) await this._waitForRenderable();

        let target = null;
        const originalSize = this.renderer.getSize(new THREE.Vector2());
        const originalPixelRatio = this.renderer.getPixelRatio();
        const overlayVisibility = {
            grid: this.grid.visible,
            transform: this.transformHelper.visible,
            bounds: this.selectionBounds.visible,
        };
        this.grid.visible = false;
        this.transformHelper.visible = false;
        this.selectionBounds.visible = false;
        this._capturing = true;

        try {
            this.captureCamera.position.copy(this.camera.position);
            this.captureCamera.quaternion.copy(this.camera.quaternion);
            this.captureCamera.up.copy(this.camera.up);
            this.captureCamera.aspect = targetWidth / targetHeight;
            this.captureCamera.fov = this.captureFov;
            this.captureCamera.near = this.camera.near;
            this.captureCamera.far = this.camera.far;
            this.captureCamera.updateProjectionMatrix();
            this.captureCamera.updateMatrixWorld(true);

            // Render into an exact, device-pixel-ratio-independent drawing
            // buffer. The node output no longer inherits the widget's DOM size.
            this.renderer.setPixelRatio(1);
            this.renderer.setSize(targetWidth, targetHeight, false);
            this.spark.setDirty?.();
            this.renderer.render(this.scene, this.captureCamera);
            target = document.createElement("canvas");
            target.width = targetWidth;
            target.height = targetHeight;
            const context = target.getContext("2d", { alpha: false });
            if (!context) throw new Error("Could not create the 3D preview canvas");
            context.drawImage(this.canvas, 0, 0, targetWidth, targetHeight);
        } finally {
            this.renderer.setPixelRatio(originalPixelRatio);
            this.renderer.setSize(originalSize.x, originalSize.y, false);
            this.grid.visible = overlayVisibility.grid;
            this.transformHelper.visible = overlayVisibility.transform;
            this.selectionBounds.visible = overlayVisibility.bounds;
            this._capturing = false;
            this._updateCameraProjection(originalSize.x, originalSize.y);
            this._updateCameraFrame(originalSize.x, originalSize.y);
            this.renderer.render(this.scene, this.camera);
        }
        return await new Promise((resolve, reject) => {
            target.toBlob(
                blob => blob
                    ? resolve(blob)
                    : reject(new Error("Could not encode the 3D scene preview")),
                "image/png",
            );
        });
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this._loadingToken += 1;
        this._pendingLodCandidates = [];
        this._loadController?.abort();
        this._loadController = null;
        cancelAnimationFrame(this._frame);
        this._resizeObserver?.disconnect();
        this.transform.detach();
        this.transform.dispose();
        this.scene.remove(this.transformHelper);
        this.scene.remove(this.selectionBounds);
        this.selectionBounds.geometry.dispose();
        this.selectionBounds.material.dispose();
        this.controls.dispose();
        for (const entry of this.objects.values()) entry.splat?.dispose?.();
        this.objects.clear();
        this.scene.remove(this.spark);
        this.spark?.dispose?.();
        this.grid.geometry.dispose();
        this.grid.material.dispose();
        this.renderer.dispose();
        this.cameraFrame?.remove();
        this.canvas.remove();
    }
}

export default Factory3DViewer;
