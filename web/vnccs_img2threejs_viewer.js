/**
 * Isolated Three.js viewer for the VNCCS img2threejs widget.
 *
 * Only declarative Scene Spec v1 data is accepted.  Generated JavaScript or
 * TypeScript is never evaluated here.
 */

import * as THREE from "./three.module.js";
import { OrbitControls } from "./OrbitControls.js";
import {
    clamp,
    computeFitCamera,
    disposeObject3D,
    normalizeEnvironmentSpec,
    normalizeSceneSpec,
    normalizeVector3,
} from "./vnccs_img2threejs_scene.mjs";

export const IMG2THREEJS_ENVIRONMENT_PRESETS = Object.freeze({
    studio: Object.freeze({
        preset: "studio",
        background: "#171b25",
        ambientColor: "#dce7ff",
        ambientIntensity: 0.55,
        hemisphereSkyColor: "#dce7ff",
        hemisphereGroundColor: "#352c26",
        hemisphereIntensity: 0.75,
        key: { color: "#fff3de", intensity: 3.2, position: [4, 7, 5] },
        fill: { color: "#9dbdff", intensity: 1.25, position: [-5, 3, 2] },
        rim: { color: "#b9d2ff", intensity: 2.1, position: [1, 5, -6] },
        ground: { color: "#202633", roughness: 0.9 },
    }),
    neutral: Object.freeze({
        preset: "neutral",
        background: "#25272b",
        ambientColor: "#ffffff",
        ambientIntensity: 0.7,
        hemisphereSkyColor: "#ffffff",
        hemisphereGroundColor: "#555555",
        hemisphereIntensity: 0.65,
        key: { color: "#ffffff", intensity: 2.7, position: [4, 6, 5] },
        fill: { color: "#ffffff", intensity: 1.1, position: [-4, 3, 3] },
        rim: { color: "#ffffff", intensity: 1.6, position: [0, 5, -6] },
        ground: { color: "#303236", roughness: 0.92 },
    }),
    warm: Object.freeze({
        preset: "warm",
        background: "#211b1a",
        ambientColor: "#ffd9b5",
        ambientIntensity: 0.58,
        hemisphereSkyColor: "#ffd7ad",
        hemisphereGroundColor: "#412e25",
        hemisphereIntensity: 0.78,
        key: { color: "#ffd1a0", intensity: 3.35, position: [4, 7, 4] },
        fill: { color: "#ffc1a6", intensity: 1.05, position: [-5, 2, 3] },
        rim: { color: "#ffdfbd", intensity: 1.9, position: [1, 5, -6] },
        ground: { color: "#2b2321", roughness: 0.94 },
    }),
    cool: Object.freeze({
        preset: "cool",
        background: "#111b28",
        ambientColor: "#bed7ff",
        ambientIntensity: 0.62,
        hemisphereSkyColor: "#c8dcff",
        hemisphereGroundColor: "#1b2b40",
        hemisphereIntensity: 0.8,
        key: { color: "#d8e6ff", intensity: 3.1, position: [4, 7, 5] },
        fill: { color: "#80b7ff", intensity: 1.4, position: [-5, 3, 2] },
        rim: { color: "#77aaff", intensity: 2.3, position: [1, 5, -6] },
        ground: { color: "#172536", roughness: 0.9 },
    }),
    dark: Object.freeze({
        preset: "dark",
        background: "#080a0f",
        ambientColor: "#8897b0",
        ambientIntensity: 0.28,
        hemisphereSkyColor: "#8ba0c5",
        hemisphereGroundColor: "#0b0c10",
        hemisphereIntensity: 0.38,
        key: { color: "#dce8ff", intensity: 2.45, position: [4, 7, 5] },
        fill: { color: "#42689b", intensity: 0.65, position: [-5, 3, 2] },
        rim: { color: "#719ce0", intensity: 2.7, position: [1, 5, -6] },
        ground: { color: "#0d1119", roughness: 0.96 },
    }),
});

const EMPTY_CALLBACK = () => {};
const CAPTURE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_SCENE_JSON_CHARS = 2 * 1024 * 1024;

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeEnvironment(base, override) {
    const first = isObject(base) ? base : {};
    const second = isObject(override) ? override : {};
    return {
        ...first,
        ...second,
        key: { ...(first.key || {}), ...(second.key || {}) },
        fill: { ...(first.fill || {}), ...(second.fill || {}) },
        rim: { ...(first.rim || {}), ...(second.rim || {}) },
        ground: { ...(first.ground || {}), ...(second.ground || {}) },
        grid: { ...(first.grid || {}), ...(second.grid || {}) },
    };
}

function isCanvas(element) {
    return String(element?.tagName || "").toLowerCase() === "canvas";
}

function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
        if (typeof canvas.toBlob !== "function") {
            try {
                const dataUrl = canvas.toDataURL(type, quality);
                const [header, body] = dataUrl.split(",", 2);
                const mime = /data:([^;]+)/.exec(header)?.[1] || type;
                const binary = atob(body || "");
                const bytes = new Uint8Array(binary.length);
                for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
                resolve(new Blob([bytes], { type: mime }));
            } catch (error) {
                reject(error);
            }
            return;
        }
        canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error("The browser could not encode the screenshot"));
        }, type, quality);
    });
}

function finiteBox(box) {
    return box
        && !box.isEmpty()
        && [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z].every(Number.isFinite);
}

export class Img2ThreeJSViewer {
    constructor(host, options = {}) {
        if (!host || typeof host.appendChild !== "function" && !isCanvas(host)) {
            throw new TypeError("Img2ThreeJSViewer requires a canvas or a host element");
        }

        this.host = isCanvas(host) ? host.parentElement : host;
        this.canvas = isCanvas(host) ? host : document.createElement("canvas");
        this._ownsCanvas = !isCanvas(host);
        this._disposed = false;
        this._frame = 0;
        this._needsRender = false;
        this._width = 1;
        this._height = 1;
        this._pixelRatio = 1;
        this._modelRoot = null;
        this._componentObjects = new Map();
        this._materials = new Map();
        this._usedMaterials = new Set();
        this._environmentGroup = null;
        this._environmentConfig = normalizeEnvironmentSpec("studio");
        this._gridHelper = null;
        this._ground = null;
        this._selectionHelper = null;
        this._pointerStart = null;
        this.spec = null;

        this.options = {
            onHierarchyChange: typeof options.onHierarchyChange === "function" ? options.onHierarchyChange : EMPTY_CALLBACK,
            onSelectionChange: typeof options.onSelectionChange === "function" ? options.onSelectionChange : EMPTY_CALLBACK,
            onStateChange: typeof options.onStateChange === "function" ? options.onStateChange : EMPTY_CALLBACK,
            onError: typeof options.onError === "function" ? options.onError : EMPTY_CALLBACK,
        };
        this.state = {
            wireframe: false,
            grid: true,
            environment: "studio",
            environmentVisible: true,
            selectedId: null,
        };

        this._canvasStyle = {
            display: this.canvas.style.display,
            width: this.canvas.style.width,
            height: this.canvas.style.height,
            touchAction: this.canvas.style.touchAction,
        };
        this.canvas.dataset.vnccsImg2threejsCanvas = "true";
        this.canvas.style.display = "block";
        this.canvas.style.width = "100%";
        this.canvas.style.height = "100%";
        this.canvas.style.touchAction = "none";
        if (this._ownsCanvas) this.host.appendChild(this.canvas);

        try {
            this._setupThree();
            this._bindEvents();
            this._observeResize();
            this._rebuildEnvironment(this._environmentConfig);
            this.resize();
            this.requestRender();
        } catch (error) {
            this._reportError(error);
            this.dispose();
            throw error;
        }
    }

    _setupThree() {
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 5000);
        this.camera.position.set(4.5, 3.2, 6.5);
        this.camera.up.set(0, 1, 0);
        this.scene.add(this.camera);

        this.captureCamera = this.camera.clone();
        this.captureCamera.name = "VNCCS img2threejs capture camera";

        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
            alpha: true,
            powerPreference: "high-performance",
            preserveDrawingBuffer: false,
        });
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1;
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

        this.controls = new OrbitControls(this.camera, this.canvas);
        this.controls.target.set(0, 0, 0);
        this.controls.enableDamping = false;
        this.controls.enableZoom = true;
        this.controls.enablePan = true;
        this.controls.rotateSpeed = 0.92;
        this.controls.zoomSpeed = 0.85;
        this.controls.panSpeed = 0.75;
        this.controls.minDistance = 0.01;
        this.controls.maxDistance = 100000;
        this.controls.mouseButtons = {
            LEFT: THREE.MOUSE.NONE,
            MIDDLE: THREE.MOUSE.PAN,
            RIGHT: THREE.MOUSE.ROTATE,
        };
        this.controls.touches = {
            ONE: THREE.TOUCH.ROTATE,
            TWO: THREE.TOUCH.DOLLY_PAN,
        };
        this.controls.update();

        this.raycaster = new THREE.Raycaster();
        this.pointer = new THREE.Vector2();
    }

    _bindEvents() {
        this._handlers = {
            controlsChange: () => this.requestRender(),
            pointerDown: (event) => this._handlePointerDown(event),
            pointerUp: (event) => this._handlePointerUp(event),
            pointerCancel: (event) => this._handlePointerCancel(event),
            blockPointer: (event) => event.stopPropagation(),
            wheel: (event) => event.stopPropagation(),
            contextMenu: (event) => {
                event.preventDefault();
                event.stopPropagation();
            },
            auxClick: (event) => event.stopPropagation(),
        };
        this.controls.addEventListener("change", this._handlers.controlsChange);
        this.canvas.addEventListener("pointerdown", this._handlers.pointerDown);
        this.canvas.addEventListener("pointerup", this._handlers.pointerUp);
        this.canvas.addEventListener("pointercancel", this._handlers.pointerCancel);
        this.canvas.addEventListener("mousedown", this._handlers.blockPointer);
        this.canvas.addEventListener("mouseup", this._handlers.blockPointer);
        this.canvas.addEventListener("mousemove", this._handlers.blockPointer);
        this.canvas.addEventListener("wheel", this._handlers.wheel, { passive: false });
        this.canvas.addEventListener("contextmenu", this._handlers.contextMenu);
        this.canvas.addEventListener("auxclick", this._handlers.auxClick);
    }

    _observeResize() {
        const ResizeObserverClass = globalThis.ResizeObserver;
        if (typeof ResizeObserverClass !== "function") return;
        this._resizeObserver = new ResizeObserverClass((entries) => {
            if (this._disposed) return;
            const entry = entries[entries.length - 1];
            const rect = entry?.contentRect;
            this.resize(rect?.width, rect?.height);
        });
        this._resizeObserver.observe(this.host || this.canvas);
    }

    _reportError(error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        try {
            this.options?.onError?.(normalized);
        } catch (callbackError) {
            console.error("img2threejs viewer error callback failed", callbackError);
        }
    }

    _emit(callbackName, payload) {
        try {
            this.options?.[callbackName]?.(payload);
        } catch (error) {
            this._reportError(error);
        }
    }

    _emitState() {
        this._emit("onStateChange", this.getState());
    }

    requestRender() {
        if (this._disposed || !this.renderer || this._frame) return;
        this._needsRender = true;
        const request = globalThis.requestAnimationFrame || ((callback) => globalThis.setTimeout(callback, 16));
        this._frame = request(() => {
            this._frame = 0;
            if (this._disposed || !this._needsRender) return;
            this._needsRender = false;
            this.renderer.render(this.scene, this.camera);
        });
    }

    render() {
        if (this._disposed || !this.renderer) return;
        this._needsRender = false;
        this.renderer.render(this.scene, this.camera);
    }

    resize(width, height) {
        if (this._disposed || !this.renderer) return false;
        const source = this.host || this.canvas;
        const rect = source?.getBoundingClientRect?.();
        const nextWidth = Math.max(1, Math.round(Number(width) || rect?.width || source?.clientWidth || 1));
        const nextHeight = Math.max(1, Math.round(Number(height) || rect?.height || source?.clientHeight || 1));
        const dpr = clamp(globalThis.devicePixelRatio, 1, 2, 1);
        if (nextWidth === this._width && nextHeight === this._height && dpr === this._pixelRatio) return false;
        this._width = nextWidth;
        this._height = nextHeight;
        this._pixelRatio = dpr;
        this.renderer.setPixelRatio(dpr);
        this.renderer.setSize(nextWidth, nextHeight, false);
        this.camera.aspect = nextWidth / nextHeight;
        this.camera.updateProjectionMatrix();
        this.requestRender();
        return true;
    }

    _makeMaterial(spec) {
        const sides = {
            front: THREE.FrontSide,
            back: THREE.BackSide,
            double: THREE.DoubleSide,
        };
        const material = new THREE.MeshPhysicalMaterial({
            name: spec.name,
            color: new THREE.Color(spec.color),
            roughness: spec.roughness,
            metalness: spec.metalness,
            emissive: new THREE.Color(spec.emissive),
            emissiveIntensity: spec.emissiveIntensity,
            opacity: spec.opacity,
            transparent: spec.transparent,
            alphaTest: spec.alphaTest,
            clearcoat: spec.clearcoat,
            clearcoatRoughness: spec.clearcoatRoughness,
            transmission: spec.transmission,
            ior: spec.ior,
            thickness: spec.thickness,
            sheen: spec.sheen,
            sheenRoughness: spec.sheenRoughness,
            sheenColor: new THREE.Color(spec.sheenColor),
            specularIntensity: spec.specularIntensity,
            specularColor: new THREE.Color(spec.specularColor),
            iridescence: spec.iridescence,
            attenuationColor: new THREE.Color(spec.attenuationColor),
            attenuationDistance: spec.attenuationDistance || Infinity,
            flatShading: spec.flatShading,
            depthWrite: spec.depthWrite,
            side: sides[spec.side] ?? THREE.FrontSide,
            wireframe: this.state.wireframe,
        });
        material.userData.vnccsMaterialId = spec.id;
        return material;
    }

    _makeGeometry(primitive) {
        switch (primitive) {
            case "sphere":
            case "ellipsoid":
                return new THREE.SphereGeometry(0.5, 36, 24);
            case "cylinder":
                return new THREE.CylinderGeometry(0.5, 0.5, 1, 36, 1);
            case "cone":
                return new THREE.ConeGeometry(0.5, 1, 36, 1);
            case "capsule":
                return new THREE.CapsuleGeometry(0.25, 0.5, 8, 20);
            case "torus":
                return new THREE.TorusGeometry(0.36, 0.14, 16, 48);
            case "plane":
                return new THREE.PlaneGeometry(1, 1, 1, 1);
            case "box":
            default:
                return new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
        }
    }

    async loadSceneSpec(input) {
        if (this._disposed) throw new Error("The img2threejs viewer has been disposed");
        let payload = input;
        if (typeof input === "string") {
            if (input.length > MAX_SCENE_JSON_CHARS) {
                throw new Error("Scene Spec JSON exceeds the 2 MB viewer limit");
            }
            try {
                payload = JSON.parse(input);
            } catch (error) {
                const wrapped = new Error(`Scene Spec must be valid JSON: ${error.message}`);
                this._reportError(wrapped);
                throw wrapped;
            }
        }
        const hasExplicitCamera = isObject(payload) && (isObject(payload.camera) || isObject(payload.referenceCamera));
        const rawEnvironment = typeof payload?.environment === "string"
            ? { preset: payload.environment }
            : (isObject(payload?.environment) ? payload.environment : {});
        const spec = normalizeSceneSpec(payload);
        const root = new THREE.Group();
        root.name = spec.name;
        root.userData.vnccsSceneSpecVersion = spec.version;
        const materials = new Map();
        const objects = new Map();
        const usedMaterials = new Set();

        try {
            for (const materialSpec of spec.materials) materials.set(materialSpec.id, this._makeMaterial(materialSpec));
            const fallbackMaterial = materials.values().next().value;
            for (const component of spec.components) {
                const pivot = new THREE.Group();
                pivot.name = `${component.name}__pivot`;
                pivot.position.fromArray(component.position);
                pivot.rotation.fromArray(component.rotation);
                pivot.scale.fromArray(component.scale);
                pivot.visible = component.visible;
                pivot.userData.vnccsComponentId = component.id;
                pivot.userData.vnccsHierarchy = spec.hierarchy.byId[component.id] || null;

                const material = materials.get(component.materialId) || fallbackMaterial;
                const mesh = new THREE.Mesh(this._makeGeometry(component.primitive), material);
                mesh.name = component.name;
                mesh.castShadow = component.castShadow;
                mesh.receiveShadow = component.receiveShadow;
                mesh.userData.vnccsComponentId = component.id;
                mesh.userData.vnccsPrimitive = component.primitive;
                pivot.add(mesh);
                usedMaterials.add(material);
                objects.set(component.id, { pivot, mesh, component });
            }
            for (const componentId of spec.hierarchy.sourceOrder) {
                const record = objects.get(componentId);
                if (!record) continue;
                const parentId = spec.hierarchy.byId[componentId]?.parentId;
                const parent = parentId ? objects.get(parentId)?.pivot : root;
                (parent || root).add(record.pivot);
            }
        } catch (error) {
            disposeObject3D(root, { removeFromParent: false });
            for (const material of materials.values()) {
                if (!usedMaterials.has(material)) material.dispose();
            }
            this._reportError(error);
            throw error;
        }

        this._clearModel();
        this._modelRoot = root;
        this._componentObjects = objects;
        this._materials = materials;
        this._usedMaterials = usedMaterials;
        this.spec = spec;
        this.scene.add(root);
        this.scene.updateMatrixWorld(true);

        const environmentPreset = IMG2THREEJS_ENVIRONMENT_PRESETS[String(rawEnvironment.preset || spec.environment.preset || "studio").toLowerCase()]
            || IMG2THREEJS_ENVIRONMENT_PRESETS.studio;
        this._environmentConfig = normalizeEnvironmentSpec(mergeEnvironment(environmentPreset, rawEnvironment));
        spec.environment = this._environmentConfig;
        this.state.environment = this._environmentConfig.preset;
        this.state.environmentVisible = this._environmentConfig.visible;
        this.state.grid = this._environmentConfig.grid.visible;
        this._rebuildEnvironment(this._environmentConfig);
        this.setWireframe(this.state.wireframe, { silent: true });
        this.select(null, { silent: true });

        if (hasExplicitCamera) this._applyCameraSpec(spec.camera);
        else this.fit();
        this._emit("onHierarchyChange", spec.hierarchy);
        this._emit("onSelectionChange", null);
        this._emitState();
        this.requestRender();
        return spec;
    }

    setSceneSpec(input) {
        return this.loadSceneSpec(input);
    }

    setScene(input) {
        return this.loadSceneSpec(input);
    }

    _applyCameraSpec(cameraSpec) {
        this.camera.fov = cameraSpec.fov;
        this.camera.near = cameraSpec.near;
        this.camera.far = cameraSpec.far;
        this.camera.position.fromArray(cameraSpec.position);
        this.camera.up.fromArray(cameraSpec.up);
        this.controls.target.fromArray(cameraSpec.target);
        this.camera.updateProjectionMatrix();
        this.controls.update();
    }

    _clearModel() {
        this._clearSelectionHelper();
        if (this._modelRoot) disposeObject3D(this._modelRoot);
        for (const material of this._materials.values()) {
            if (!this._usedMaterials.has(material)) material.dispose();
        }
        this._modelRoot = null;
        this._componentObjects.clear();
        this._materials.clear();
        this._usedMaterials.clear();
        this.state.selectedId = null;
    }

    _clearSelectionHelper() {
        if (!this._selectionHelper) return;
        if (this._selectionHelper.parent) this._selectionHelper.parent.remove(this._selectionHelper);
        this._selectionHelper.geometry?.dispose?.();
        this._selectionHelper.material?.dispose?.();
        this._selectionHelper = null;
    }

    _handlePointerDown(event) {
        event.stopPropagation();
        if (event.button !== 0) return;
        this._pointerStart = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    }

    _handlePointerCancel(event) {
        event.stopPropagation();
        this._pointerStart = null;
    }

    _handlePointerUp(event) {
        event.stopPropagation();
        const start = this._pointerStart;
        this._pointerStart = null;
        if (!start || event.button !== 0 || start.pointerId !== event.pointerId || !this._modelRoot) return;
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
        const rect = this.canvas.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) return;
        this.pointer.set(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1,
        );
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const isPickable = object => {
            for (let current = object; current; current = current.parent) {
                if (current.visible === false) return false;
            }
            const materials = Array.isArray(object?.material) ? object.material : [object?.material];
            return materials.some(material => material && material.visible !== false && Number(material.opacity ?? 1) > 0.0001);
        };
        const hit = this.raycaster.intersectObject(this._modelRoot, true)
            .find((item) => item.object?.userData?.vnccsComponentId && isPickable(item.object));
        this.select(hit?.object?.userData?.vnccsComponentId ?? null);
    }

    select(id, { silent = false } = {}) {
        if (this._disposed) return null;
        const selectedId = id === null || id === undefined ? null : String(id);
        const record = selectedId ? this._componentObjects.get(selectedId) : null;
        this._clearSelectionHelper();
        this.state.selectedId = record ? selectedId : null;
        let selection = null;
        if (record) {
            this._selectionHelper = new THREE.BoxHelper(record.pivot, 0x56c8ff);
            this._selectionHelper.name = "VNCCS img2threejs selection";
            this._selectionHelper.material.depthTest = false;
            this._selectionHelper.material.transparent = true;
            this._selectionHelper.material.opacity = 0.9;
            this._selectionHelper.renderOrder = 1000;
            this.scene.add(this._selectionHelper);
            selection = {
                id: selectedId,
                component: record.component,
                hierarchy: this.spec?.hierarchy?.byId?.[selectedId] || null,
                object: record.pivot,
            };
        }
        if (!silent) {
            this._emit("onSelectionChange", selection);
            this._emitState();
        }
        this.requestRender();
        return selection;
    }

    getSelection() {
        if (!this.state.selectedId) return null;
        const record = this._componentObjects.get(this.state.selectedId);
        if (!record) return null;
        return {
            id: this.state.selectedId,
            component: record.component,
            hierarchy: this.spec?.hierarchy?.byId?.[this.state.selectedId] || null,
            object: record.pivot,
        };
    }

    getHierarchy() {
        return this.spec?.hierarchy || { roots: [], order: [], sourceOrder: [], byId: {}, issues: [] };
    }

    setWireframe(enabled, { silent = false } = {}) {
        this.state.wireframe = Boolean(enabled);
        for (const material of this._materials.values()) {
            material.wireframe = this.state.wireframe;
            material.needsUpdate = true;
        }
        if (!silent) this._emitState();
        this.requestRender();
        return this.state.wireframe;
    }

    setGrid(enabled, { silent = false } = {}) {
        this.state.grid = Boolean(enabled);
        if (this._gridHelper) this._gridHelper.visible = this.state.grid;
        if (!silent) this._emitState();
        this.requestRender();
        return this.state.grid;
    }

    setEnvironment(value, { silent = false } = {}) {
        if (typeof value === "boolean") {
            this.state.environmentVisible = value;
            this._environmentConfig = normalizeEnvironmentSpec({ ...this._environmentConfig, visible: value });
        } else if (typeof value === "string") {
            const name = value.toLowerCase();
            const preset = IMG2THREEJS_ENVIRONMENT_PRESETS[name] || IMG2THREEJS_ENVIRONMENT_PRESETS.studio;
            const base = this.spec?.environment || this._environmentConfig;
            this._environmentConfig = normalizeEnvironmentSpec(mergeEnvironment(base, preset));
            this.state.environment = preset.preset;
            this.state.environmentVisible = this._environmentConfig.visible;
        } else if (isObject(value)) {
            this._environmentConfig = normalizeEnvironmentSpec(mergeEnvironment(this._environmentConfig, value));
            this.state.environment = this._environmentConfig.preset || "custom";
            this.state.environmentVisible = this._environmentConfig.visible;
        }
        this._rebuildEnvironment(this._environmentConfig);
        if (!silent) this._emitState();
        this.requestRender();
        return this._environmentConfig;
    }

    setEnvironmentVisible(visible, options) {
        return this.setEnvironment(Boolean(visible), options);
    }

    _rebuildEnvironment(environment) {
        if (!this.scene) return;
        if (this._gridHelper) disposeObject3D(this._gridHelper);
        this._gridHelper = null;
        if (this._environmentGroup) disposeObject3D(this._environmentGroup);
        this._environmentGroup = new THREE.Group();
        this._environmentGroup.name = "VNCCS img2threejs environment";
        this._environmentGroup.visible = this.state.environmentVisible && environment.visible;
        this.scene.add(this._environmentGroup);

        const transparent = environment.transparent || !this.state.environmentVisible;
        this.scene.background = transparent ? null : new THREE.Color(environment.background);
        this.renderer?.setClearColor(environment.background, transparent ? 0 : 1);

        const ambient = new THREE.AmbientLight(environment.ambientColor, environment.ambientIntensity);
        const hemisphere = new THREE.HemisphereLight(
            environment.hemisphereSkyColor,
            environment.hemisphereGroundColor,
            environment.hemisphereIntensity,
        );
        this._environmentGroup.add(ambient, hemisphere);

        const addDirectional = (lightSpec, name, castShadow = false) => {
            if (!lightSpec.enabled) return;
            const light = new THREE.DirectionalLight(lightSpec.color, lightSpec.intensity);
            light.name = name;
            light.position.fromArray(lightSpec.position);
            light.castShadow = castShadow;
            if (castShadow) {
                light.shadow.mapSize.set(1024, 1024);
                light.shadow.bias = -0.00015;
                light.shadow.camera.near = 0.1;
                light.shadow.camera.far = 100;
                light.shadow.camera.left = -12;
                light.shadow.camera.right = 12;
                light.shadow.camera.top = 12;
                light.shadow.camera.bottom = -12;
            }
            this._environmentGroup.add(light, light.target);
        };
        addDirectional(environment.key, "Key light", true);
        addDirectional(environment.fill, "Fill light");
        addDirectional(environment.rim, "Rim light");

        const groundMaterial = new THREE.MeshPhysicalMaterial({
            color: environment.ground.color,
            roughness: environment.ground.roughness,
            metalness: environment.ground.metalness,
            opacity: environment.ground.opacity,
            transparent: environment.ground.opacity < 1,
            depthWrite: environment.ground.opacity >= 1,
        });
        this._ground = new THREE.Mesh(
            new THREE.PlaneGeometry(environment.ground.size, environment.ground.size),
            groundMaterial,
        );
        this._ground.name = "Ground";
        this._ground.rotation.x = -Math.PI / 2;
        this._ground.position.y = environment.ground.height;
        this._ground.receiveShadow = true;
        this._ground.visible = environment.ground.visible;
        this._environmentGroup.add(this._ground);

        this._gridHelper = new THREE.GridHelper(
            environment.grid.size,
            environment.grid.divisions,
            environment.grid.centerColor,
            environment.grid.gridColor,
        );
        this._gridHelper.name = "Grid";
        this._gridHelper.position.y = environment.ground.height + 0.002;
        const gridMaterials = Array.isArray(this._gridHelper.material)
            ? this._gridHelper.material
            : [this._gridHelper.material];
        for (const material of gridMaterials) {
            material.transparent = environment.grid.opacity < 1;
            material.opacity = environment.grid.opacity;
            material.depthWrite = false;
        }
        this._gridHelper.visible = this.state.grid;
        this.scene.add(this._gridHelper);
    }

    fit(id = null, options = {}) {
        if (this._disposed) return null;
        const targetObject = id ? this._componentObjects.get(String(id))?.pivot : this._modelRoot;
        if (!targetObject) return null;
        targetObject.updateWorldMatrix(true, true);
        const box = new THREE.Box3().setFromObject(targetObject, true);
        if (!finiteBox(box)) return null;
        const currentDirection = this.camera.position.clone().sub(this.controls.target);
        if (currentDirection.lengthSq() < 1e-8) currentDirection.set(0.65, 0.38, 1);
        currentDirection.normalize();
        const result = computeFitCamera({
            min: box.min.toArray(),
            max: box.max.toArray(),
        }, {
            fov: this.camera.fov,
            aspect: this.camera.aspect,
            padding: options.padding ?? 1.28,
            direction: options.direction ?? currentDirection.toArray(),
        });
        this.controls.target.fromArray(result.center);
        this.camera.position.fromArray(result.position);
        this.camera.near = Math.max(0.001, result.near);
        this.camera.far = Math.max(this.camera.near + 10, result.far);
        this.camera.updateProjectionMatrix();
        this.controls.minDistance = Math.max(0.001, result.radius * 0.04);
        this.controls.maxDistance = Math.max(100, result.radius * 100);
        this.controls.update();
        this.requestRender();
        return result;
    }

    fitCamera(id, options) {
        return this.fit(id, options);
    }

    async capture(options = {}) {
        if (this._disposed || !this.renderer) throw new Error("The img2threejs viewer is not available");
        const typeCandidate = options.type === "image/jpg" ? "image/jpeg" : String(options.type || "image/png").toLowerCase();
        const type = CAPTURE_TYPES.has(typeCandidate) ? typeCandidate : "image/png";
        const quality = clamp(options.quality, 0, 1, 0.92);
        let width = Math.round(clamp(options.width, 1, 4096, this.canvas.width || this._width));
        let height = Math.round(clamp(options.height, 1, 4096, this.canvas.height || this._height));
        const pixelLimit = 16_777_216;
        if (width * height > pixelLimit) {
            const scale = Math.sqrt(pixelLimit / (width * height));
            width = Math.max(1, Math.floor(width * scale));
            height = Math.max(1, Math.floor(height * scale));
        }

        const renderTarget = new THREE.WebGLRenderTarget(width, height, {
            format: THREE.RGBAFormat,
            type: THREE.UnsignedByteType,
            depthBuffer: true,
            stencilBuffer: false,
        });
        renderTarget.texture.colorSpace = THREE.SRGBColorSpace;
        const previousTarget = this.renderer.getRenderTarget();
        const pixels = new Uint8Array(width * height * 4);
        this.captureCamera.copy(this.camera, false);
        this.captureCamera.aspect = width / height;
        this.captureCamera.updateProjectionMatrix();
        this.captureCamera.updateMatrixWorld(true);
        const selectionWasVisible = this._selectionHelper?.visible ?? false;
        if (this._selectionHelper) this._selectionHelper.visible = false;

        try {
            this.renderer.setRenderTarget(renderTarget);
            this.renderer.clear(true, true, true);
            this.renderer.render(this.scene, this.captureCamera);
            this.renderer.readRenderTargetPixels(renderTarget, 0, 0, width, height, pixels);
        } catch (error) {
            this._reportError(error);
            throw error;
        } finally {
            if (this._selectionHelper) this._selectionHelper.visible = selectionWasVisible;
            this.renderer.setRenderTarget(previousTarget);
            renderTarget.dispose();
            this.requestRender();
        }

        const output = document.createElement("canvas");
        output.width = width;
        output.height = height;
        const context = output.getContext("2d", { alpha: true });
        if (!context) throw new Error("A 2D canvas is required to encode the screenshot");
        const flipped = new Uint8ClampedArray(pixels.length);
        const stride = width * 4;
        for (let y = 0; y < height; y += 1) {
            flipped.set(pixels.subarray((height - y - 1) * stride, (height - y) * stride), y * stride);
        }
        const imageData = context.createImageData(width, height);
        imageData.data.set(flipped);
        context.putImageData(imageData, 0, 0);
        if (options.as === "canvas") return output;
        if (options.as === "dataURL" || options.as === "data-url") return output.toDataURL(type, quality);
        return canvasToBlob(output, type, quality);
    }

    captureBlob(options = {}) {
        return this.capture({ ...options, as: "blob" });
    }

    captureDataURL(options = {}) {
        return this.capture({ ...options, as: "dataURL" });
    }

    getState() {
        return {
            wireframe: this.state.wireframe,
            grid: this.state.grid,
            environment: this.state.environment,
            environmentVisible: this.state.environmentVisible,
            selectedId: this.state.selectedId,
            camera: this.camera ? {
                position: this.camera.position.toArray(),
                target: this.controls.target.toArray(),
                up: this.camera.up.toArray(),
                fov: this.camera.fov,
            } : null,
        };
    }

    serializeState() {
        return this.getState();
    }

    setState(value = {}, { silent = false } = {}) {
        if (!isObject(value) || this._disposed) return this.getState();
        if ("wireframe" in value) this.setWireframe(Boolean(value.wireframe), { silent: true });
        if ("grid" in value) this.setGrid(Boolean(value.grid), { silent: true });
        if ("environment" in value) this.setEnvironment(value.environment, { silent: true });
        if ("environmentVisible" in value) this.setEnvironment(Boolean(value.environmentVisible), { silent: true });
        if (isObject(value.camera)) {
            this.camera.position.fromArray(normalizeVector3(value.camera.position, this.camera.position.toArray(), [-10000, 10000]));
            this.camera.up.set(0, 1, 0);
            this.controls.target.fromArray(normalizeVector3(value.camera.target, this.controls.target.toArray(), [-10000, 10000]));
            this.camera.fov = clamp(value.camera.fov, 10, 100, this.camera.fov);
            this.camera.updateProjectionMatrix();
            this.controls.update();
        }
        if ("selectedId" in value) this.select(value.selectedId, { silent: true });
        if (!silent) this._emitState();
        this.requestRender();
        return this.getState();
    }

    restoreState(value, options) {
        return this.setState(value, options);
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        const cancel = globalThis.cancelAnimationFrame || globalThis.clearTimeout;
        if (this._frame) cancel?.(this._frame);
        this._frame = 0;
        this._resizeObserver?.disconnect();
        this._resizeObserver = null;

        if (this.controls && this._handlers) {
            this.controls.removeEventListener("change", this._handlers.controlsChange);
            this.controls.dispose();
        }
        if (this.canvas && this._handlers) {
            this.canvas.removeEventListener("pointerdown", this._handlers.pointerDown);
            this.canvas.removeEventListener("pointerup", this._handlers.pointerUp);
            this.canvas.removeEventListener("pointercancel", this._handlers.pointerCancel);
            this.canvas.removeEventListener("mousedown", this._handlers.blockPointer);
            this.canvas.removeEventListener("mouseup", this._handlers.blockPointer);
            this.canvas.removeEventListener("mousemove", this._handlers.blockPointer);
            this.canvas.removeEventListener("wheel", this._handlers.wheel);
            this.canvas.removeEventListener("contextmenu", this._handlers.contextMenu);
            this.canvas.removeEventListener("auxclick", this._handlers.auxClick);
        }
        this._handlers = null;
        this._clearModel();
        if (this._gridHelper) disposeObject3D(this._gridHelper);
        this._gridHelper = null;
        if (this._environmentGroup) disposeObject3D(this._environmentGroup);
        this._environmentGroup = null;
        this._ground = null;
        this.scene?.remove(this.camera);
        this.renderer?.renderLists?.dispose?.();
        this.renderer?.dispose?.();
        this.renderer?.forceContextLoss?.();

        if (this.canvas) {
            if (this._ownsCanvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
            else {
                this.canvas.style.display = this._canvasStyle.display;
                this.canvas.style.width = this._canvasStyle.width;
                this.canvas.style.height = this._canvasStyle.height;
                this.canvas.style.touchAction = this._canvasStyle.touchAction;
                delete this.canvas.dataset.vnccsImg2threejsCanvas;
            }
        }
        this.scene = null;
        this.camera = null;
        this.captureCamera = null;
        this.controls = null;
        this.renderer = null;
        this.raycaster = null;
        this.pointer = null;
        this.spec = null;
        this.options = null;
        this.host = null;
        this.canvas = null;
    }
}

export const VNCCSImg2ThreeJSViewer = Img2ThreeJSViewer;
export default Img2ThreeJSViewer;
