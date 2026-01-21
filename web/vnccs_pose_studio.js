/**
 * VNCCS Pose Studio - Combined mesh editor and multi-pose generator
 * 
 * Combines Character Studio sliders, dynamic pose tabs, and Debug3 gizmo controls.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// === Three.js Module Loader (from Debug3) ===
const THREE_VERSION = "0.160.0";
const THREE_SOURCES = {
    core: `https://esm.sh/three@${THREE_VERSION}?dev`,
    orbit: `https://esm.sh/three@${THREE_VERSION}/examples/jsm/controls/OrbitControls?dev`,
    transform: `https://esm.sh/three@${THREE_VERSION}/examples/jsm/controls/TransformControls?dev`
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

// === Styles ===
const STYLES = `
/* ===== VNCCS Pose Studio Theme ===== */
:root {
    --ps-bg: #1e1e1e;
    --ps-panel: #252525;
    --ps-border: #333;
    --ps-accent: #3558c7;
    --ps-accent-hover: #4264d9;
    --ps-success: #2e7d32;
    --ps-danger: #d32f2f;
    --ps-text: #e0e0e0;
    --ps-text-muted: #888;
    --ps-input-bg: #151515;
}

/* Main Container */
.vnccs-pose-studio {
    display: flex;
    flex-direction: row;
    width: 100%;
    height: 100%;
    background: var(--ps-bg);
    font-family: 'Consolas', 'Monaco', monospace;
    font-size: 12px;
    color: var(--ps-text);
    overflow: hidden;
    box-sizing: border-box;
    zoom: 0.67;
    pointer-events: none;
    position: relative;
}

/* === Left Panel (25%) === */
.vnccs-ps-left {
    width: 25%;
    min-width: 200px;
    max-width: 280px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    overflow-y: auto;
    border-right: 1px solid var(--ps-border);
    pointer-events: auto;
}

/* Scrollbar */
.vnccs-ps-left::-webkit-scrollbar { width: 6px; }
.vnccs-ps-left::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }

/* === Right Panel (75%) === */
.vnccs-ps-right {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    pointer-events: auto;
}

/* === Section Component === */
.vnccs-ps-section {
    background: var(--ps-panel);
    border: 1px solid var(--ps-border);
    border-radius: 6px;
    overflow: hidden;
}

.vnccs-ps-section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px;
    background: #1a1a1a;
    border-bottom: 1px solid var(--ps-border);
    cursor: pointer;
    user-select: none;
}

.vnccs-ps-section-title {
    font-size: 11px;
    font-weight: bold;
    color: #fff;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.vnccs-ps-section-toggle {
    font-size: 10px;
    color: var(--ps-text-muted);
    transition: transform 0.2s;
}

.vnccs-ps-section.collapsed .vnccs-ps-section-toggle {
    transform: rotate(-90deg);
}

.vnccs-ps-section-content {
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    pointer-events: auto;
}

.vnccs-ps-section.collapsed .vnccs-ps-section-content {
    display: none;
}

/* === Form Fields === */
.vnccs-ps-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    pointer-events: auto;
}

.vnccs-ps-label {
    font-size: 10px;
    color: var(--ps-text-muted);
    text-transform: uppercase;
    font-weight: 600;
}

.vnccs-ps-value {
    font-size: 10px;
    color: var(--ps-accent);
    margin-left: auto;
}

.vnccs-ps-label-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
}

/* Slider */
.vnccs-ps-slider-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--ps-input-bg);
    border: 1px solid var(--ps-border);
    border-radius: 4px;
    padding: 4px 8px;
    pointer-events: auto;
}

.vnccs-ps-slider {
    flex: 1;
    -webkit-appearance: none;
    appearance: none;
    height: 4px;
    background: #333;
    border-radius: 2px;
    cursor: pointer;
    pointer-events: auto;
}

.vnccs-ps-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 12px;
    height: 12px;
    background: var(--ps-accent);
    border-radius: 50%;
    cursor: pointer;
}

.vnccs-ps-slider::-moz-range-thumb {
    width: 12px;
    height: 12px;
    background: var(--ps-accent);
    border-radius: 50%;
    cursor: pointer;
    border: none;
}

.vnccs-ps-slider-val {
    width: 40px;
    text-align: right;
    font-size: 11px;
    color: #fff;
    background: transparent;
    border: none;
    font-family: inherit;
}

/* Input */
.vnccs-ps-input {
    background: var(--ps-input-bg);
    border: 1px solid var(--ps-border);
    color: #fff;
    border-radius: 4px;
    padding: 6px 8px;
    font-family: inherit;
    font-size: 11px;
    width: 100%;
    box-sizing: border-box;
}

.vnccs-ps-input:focus {
    outline: none;
    border-color: var(--ps-accent);
}

/* Select */
.vnccs-ps-select {
    background: var(--ps-input-bg);
    border: 1px solid var(--ps-border);
    color: #fff;
    border-radius: 4px;
    padding: 6px 8px;
    font-family: inherit;
    font-size: 11px;
    width: 100%;
    cursor: pointer;
}

/* Gender Toggle */
.vnccs-ps-toggle {
    display: flex;
    gap: 2px;
    background: var(--ps-input-bg);
    border-radius: 4px;
    padding: 2px;
    border: 1px solid var(--ps-border);
}

.vnccs-ps-toggle-btn {
    flex: 1;
    border: none;
    padding: 6px 12px;
    cursor: pointer;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 600;
    font-family: inherit;
    transition: all 0.15s;
    background: transparent;
    color: var(--ps-text-muted);
}

.vnccs-ps-toggle-btn.active {
    color: white;
}

.vnccs-ps-toggle-btn.male.active {
    background: #4a90e2;
}

.vnccs-ps-toggle-btn.female.active {
    background: #e24a90;
}

/* Input Row */
.vnccs-ps-row {
    display: flex;
    gap: 8px;
}

.vnccs-ps-row > * {
    flex: 1;
}

/* Color Picker */
.vnccs-ps-color {
    width: 100%;
    height: 28px;
    border: 1px solid var(--ps-border);
    border-radius: 4px;
    cursor: pointer;
    padding: 0;
    background: none;
}

/* === Tab Bar === */
.vnccs-ps-tabs {
    display: flex;
    align-items: center;
    padding: 6px 10px;
    background: #1a1a1a;
    gap: 4px;
    border-bottom: 1px solid var(--ps-border);
    overflow-x: auto;
    flex-shrink: 0;
}

.vnccs-ps-tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: #2a2a2a;
    border: 1px solid var(--ps-border);
    border-bottom: none;
    border-radius: 4px 4px 0 0;
    color: var(--ps-text-muted);
    cursor: pointer;
    font-size: 11px;
    font-family: inherit;
    white-space: nowrap;
    transition: all 0.15s;
}

.vnccs-ps-tab:hover {
    background: #333;
    color: #ccc;
}

.vnccs-ps-tab.active {
    background: var(--ps-panel);
    color: var(--ps-accent);
    border-color: var(--ps-accent);
    border-bottom: 1px solid var(--ps-panel);
    margin-bottom: -1px;
}

.vnccs-ps-tab-close {
    font-size: 14px;
    line-height: 1;
    color: var(--ps-text-muted);
    cursor: pointer;
    opacity: 0.6;
    transition: all 0.15s;
}

.vnccs-ps-tab-close:hover {
    color: var(--ps-danger);
    opacity: 1;
}

.vnccs-ps-tab-add {
    padding: 6px 10px;
    background: transparent;
    border: 1px dashed #444;
    border-radius: 4px;
    color: var(--ps-text-muted);
    cursor: pointer;
    font-size: 14px;
    font-family: inherit;
    transition: all 0.15s;
}

.vnccs-ps-tab-add:hover {
    background: #2a2a2a;
    border-color: var(--ps-accent);
    color: var(--ps-accent);
}

/* === 3D Canvas === */
.vnccs-ps-canvas-wrap {
    flex: 1;
    position: relative;
    overflow: hidden;
    background: #1a1a2e;
}

.vnccs-ps-canvas-wrap canvas {
    width: 100% !important;
    height: 100% !important;
    display: block;
}

/* === Action Bar === */
.vnccs-ps-actions {
    display: flex;
    gap: 8px;
    padding: 8px 10px;
    background: #1a1a1a;
    border-top: 1px solid var(--ps-border);
    flex-shrink: 0;
}

.vnccs-ps-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 8px 14px;
    background: #333;
    border: 1px solid #444;
    border-radius: 4px;
    color: var(--ps-text);
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    font-family: inherit;
    transition: all 0.15s;
}

.vnccs-ps-btn:hover {
    background: #444;
    border-color: #555;
}

.vnccs-ps-btn.primary {
    background: var(--ps-accent);
    border-color: var(--ps-accent);
    color: white;
}

.vnccs-ps-btn.primary:hover {
    background: var(--ps-accent-hover);
}

.vnccs-ps-btn.danger {
    background: var(--ps-danger);
    border-color: var(--ps-danger);
    color: white;
}

.vnccs-ps-btn-icon {
    font-size: 14px;
}

/* === Modal Dialog === */
.vnccs-ps-modal-overlay {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
    pointer-events: auto;
}

.vnccs-ps-modal {
    background: var(--ps-panel);
    border: 1px solid var(--ps-border);
    border-radius: 6px;
    padding: 20px;
    width: 300px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    display: flex;
    flex-direction: column;
    gap: 15px;
}

.vnccs-ps-modal-title {
    font-size: 16px;
    font-weight: bold;
    color: var(--ps-text);
    text-align: center;
    margin-bottom: 5px;
}

.vnccs-ps-modal-content {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.vnccs-ps-modal-btn {
    padding: 10px;
    border: 1px solid var(--ps-border);
    background: #333;
    color: var(--ps-text);
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    gap: 10px;
}

.vnccs-ps-modal-btn:hover {
    background: #444;
    border-color: var(--ps-accent);
}

.vnccs-ps-modal-btn.cancel {
    justify-content: center;
    text-align: center;
    margin-top: 5px;
    background: transparent;
    border-color: transparent;
    color: var(--ps-text-muted);
}

.vnccs-ps-modal-btn.cancel:hover {
    color: var(--ps-text);
    background: #333;
}
`;

// Inject styles
const styleEl = document.createElement("style");
styleEl.textContent = STYLES;
document.head.appendChild(styleEl);


// === 3D Viewer (from Debug3) ===
class PoseViewer {
    constructor(canvas) {
        this.canvas = canvas;
        this.width = 500;
        this.height = 500;

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

        // Pose state
        this.modelRotation = { x: 0, y: 0, z: 0 };

        this.syncCallback = null;

        this.initialized = false;

        // Undo/Redo History
        this.history = [];
        this.future = [];
        this.maxHistory = 10;
    }

    async init() {
        try {
            const modules = await ThreeModuleLoader.load();
            this.THREE = modules.THREE;
            this.OrbitControls = modules.OrbitControls;
            this.TransformControls = modules.TransformControls;

            this.setupScene();
            this.initialized = true;
            console.log('Pose Studio: 3D Viewer initialized');

            this.animate();
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

        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
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
                // Drag Ended: Sync to node
                if (this.syncCallback) {
                    this.syncCallback();
                }
            }
        });

        // Render on demand: transform change triggers render
        this.transform.addEventListener('change', () => this.requestRender());

        // Lights
        const light = new THREE.DirectionalLight(0xffffff, 2);
        light.position.set(10, 20, 30);
        this.scene.add(light);
        this.scene.add(new THREE.AmbientLight(0x505050));

        this.gridHelper = new THREE.GridHelper(20, 20, 0x0f3460, 0x0f3460);
        this.scene.add(this.gridHelper);

        // Events
        this.canvas.addEventListener("pointerdown", (e) => this.handlePointerDown(e));
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

        if (this.transform.dragging) return;
        if (this.transform.axis) return;

        const rect = this.canvas.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        const raycaster = new this.THREE.Raycaster();
        raycaster.setFromCamera(new this.THREE.Vector2(x, y), this.camera);

        const intersects = raycaster.intersectObject(this.skinnedMesh, true);

        if (intersects.length > 0) {
            const point = intersects[0].point;
            let nearest = null;
            let minD = Infinity;

            const wPos = new this.THREE.Vector3();
            for (const b of this.boneList) {
                b.getWorldPosition(wPos);
                const d = point.distanceTo(wPos);
                if (d < minD) { minD = d; nearest = b; }
            }

            if (nearest && minD < 2.0) {
                this.selectBone(nearest);
            }
        } else {
            this.deselectBone();
        }
    }

    selectBone(bone) {
        if (this.selectedBone === bone) return;
        this.selectedBone = bone;
        this.transform.attach(bone);
        this.updateMarkers();
    }

    deselectBone() {
        if (!this.selectedBone) return;
        this.selectedBone = null;
        this.transform.detach();
        this.updateMarkers();
    }

    updateMarkers() {
        const boneIdx = this.selectedBone ? this.boneList.indexOf(this.selectedBone) : -1;
        for (let i = 0; i < this.jointMarkers.length; i++) {
            const marker = this.jointMarkers[i];
            if (i === boneIdx) {
                marker.material.color.setHex(0x00ffff);
                marker.scale.setScalar(1.8);
            } else {
                marker.material.color.setHex(0xffaa00);
                marker.scale.setScalar(1.0);
            }
        }
    }

    resize(w, h) {
        this.width = w;
        this.height = h;
        if (this.renderer) this.renderer.setSize(w, h);
        if (this.camera) {
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
        }
        this.requestRender();
    }

    loadData(data, keepCamera = false) {
        if (!this.initialized || !data || !data.vertices || !data.bones) return;
        const THREE = this.THREE;

        // Clean previous
        if (this.skinnedMesh) {
            this.scene.remove(this.skinnedMesh);
            this.skinnedMesh.geometry.dispose();
            this.skinnedMesh.material.dispose();
            if (this.skeletonHelper) this.scene.remove(this.skeletonHelper);
        }
        this.jointMarkers.forEach(m => m.parent?.remove(m));
        this.jointMarkers = [];

        // Geometry
        const vertices = new Float32Array(data.vertices);
        const indices = new Uint32Array(data.indices);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        geometry.computeVertexNormals();

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

        // Bones
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

        this.skeleton = new THREE.Skeleton(this.boneList);

        // Weights
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
                    // Orphan vertex: find nearest bone
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

        // Skin material
        const material = new THREE.MeshPhongMaterial({
            color: 0xd4a574,
            specular: 0x332211,
            shininess: 15,
            side: THREE.DoubleSide
        });

        this.skinnedMesh = new THREE.SkinnedMesh(geometry, material);
        rootBones.forEach(b => this.skinnedMesh.add(b));
        this.skinnedMesh.bind(this.skeleton);
        this.scene.add(this.skinnedMesh);

        this.skeletonHelper = new THREE.SkeletonHelper(this.skinnedMesh);
        this.scene.add(this.skeletonHelper);

        // Joint Markers
        const sphereGeoNormal = new THREE.SphereGeometry(0.12, 8, 6);
        const sphereGeoFinger = new THREE.SphereGeometry(0.06, 6, 4);
        const fingerPatterns = ['finger', 'thumb', 'index', 'middle', 'ring', 'pinky', 'f_'];

        for (let i = 0; i < this.boneList.length; i++) {
            const bone = this.boneList[i];
            const boneName = bone.name.toLowerCase();
            const isFinger = fingerPatterns.some(p => boneName.includes(p));
            const geo = isFinger ? sphereGeoFinger : sphereGeoNormal;

            const mat = new THREE.MeshBasicMaterial({
                color: 0xffaa00,
                transparent: true,
                opacity: 0.9,
                depthTest: false
            });
            const sphere = new THREE.Mesh(geo, mat);
            sphere.userData.boneIndex = i;
            sphere.renderOrder = 999;
            bone.add(sphere);
            sphere.position.set(0, 0, 0);
            this.jointMarkers.push(sphere);
        }

        this.requestRender();
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
        return {
            bones,
            modelRotation: [this.modelRotation.x, this.modelRotation.y, this.modelRotation.z]
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

    setPose(pose) {
        if (!pose) return;

        const bones = pose.bones || {};
        const modelRot = pose.modelRotation || [0, 0, 0];

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

        // Apply global rotation to root node (skinnedMesh)
        if (this.skinnedMesh) {
            this.skinnedMesh.rotation.set(
                this.modelRotation.x * Math.PI / 180,
                this.modelRotation.y * Math.PI / 180,
                this.modelRotation.z * Math.PI / 180
            );
        }
        this.requestRender();
    }

    resetPose() {
        for (const b of this.boneList) {
            b.rotation.set(0, 0, 0);
        }
        this.modelRotation = { x: 0, y: 0, z: 0 };
        if (this.skinnedMesh) {
            this.skinnedMesh.rotation.set(0, 0, 0);
        }
        this.requestRender();
    }

    loadReferenceImage(url) {
        if (!this.initialized || !this.captureCamera) return;
        const THREE = this.THREE;

        // Create plane if needed
        if (!this.refPlane) {
            const geo = new THREE.PlaneGeometry(1, 1);
            const mat = new THREE.MeshBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.5,
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
            this.refPlane.material.map = tex;
            this.refPlane.material.needsUpdate = true;
            this.refPlane.visible = true;

            // Force update dimensions
            // We need to trigger an update from the widget usually, 
            // but here we can just ensure it's visible. 
            // The next resize/update will fix the aspect if needed, 
            // but actually we want it to fill the frame, so aspect of texture 
            // doesn't matter (it will stretch). Or do we want fit?
            // "Stand in the camera square" usually means fill.
        });
    }

    updateCaptureCamera(width, height, zoom = 1.0) {
        const target = this.meshCenter || new this.THREE.Vector3(0, 10, 0);
        const dist = 45;

        if (!this.captureCamera) {
            this.captureCamera = new this.THREE.PerspectiveCamera(30, width / height, 0.1, 100);
            this.scene.add(this.captureCamera);

            // Visual Helper
            this.captureHelper = new this.THREE.CameraHelper(this.captureCamera);
            this.scene.add(this.captureHelper);
        }

        // Positioning relative to mesh center
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

        if (this.captureHelper) {
            this.captureHelper.update();
            this.captureHelper.visible = true;
        }
    }

    snapToCaptureCamera(width, height, zoom = 1.0) {
        this.updateCaptureCamera(width, height, zoom);

        // Disable damping for hard reset
        const prevDamping = this.orbit.enableDamping;
        this.orbit.enableDamping = false;

        // Copy capture camera to viewport camera
        this.camera.position.copy(this.captureCamera.position);
        this.camera.zoom = zoom;
        this.camera.updateProjectionMatrix();

        const target = this.meshCenter || new this.THREE.Vector3(0, 10, 0);
        this.orbit.target.copy(target);
        this.orbit.update();

        this.orbit.enableDamping = prevDamping;
    }

    capture(width, height, zoom, bgColor) {
        if (!this.initialized) return null;

        // Ensure camera is setup
        this.updateCaptureCamera(width, height, zoom);

        // Hide UI elements
        const markersVisible = this.jointMarkers[0]?.visible ?? true;
        const transformVisible = this.transform ? this.transform.visible : true;

        // Hide Helpers
        if (this.transform) this.transform.visible = false;
        if (this.skeletonHelper) this.skeletonHelper.visible = false;
        if (this.gridHelper) this.gridHelper.visible = false;
        if (this.captureHelper) this.captureHelper.visible = false; // Hide frame from capture
        this.jointMarkers.forEach(m => m.visible = false);

        // Background Override
        const oldBg = this.scene.background;
        if (bgColor && Array.isArray(bgColor) && bgColor.length === 3) {
            this.scene.background = new this.THREE.Color(
                bgColor[0] / 255, bgColor[1] / 255, bgColor[2] / 255
            );
        }

        let dataURL = null;
        try {
            // Resize renderer to output size
            const originalSize = new this.THREE.Vector2();
            this.renderer.getSize(originalSize);

            this.renderer.setSize(width, height);

            // Render with Fixed Camera
            this.renderer.render(this.scene, this.captureCamera);
            dataURL = this.canvas.toDataURL("image/png");

            // Restore renderer
            this.renderer.setSize(originalSize.x, originalSize.y);

        } catch (e) {
            console.error("Capture failed:", e);
        } finally {
            // Restore state
            this.scene.background = oldBg;

            this.jointMarkers.forEach(m => m.visible = true);
            if (this.transform) this.transform.visible = transformVisible;
            if (this.skeletonHelper) this.skeletonHelper.visible = true;
            if (this.gridHelper) this.gridHelper.visible = true;
            if (this.captureHelper) this.captureHelper.visible = true; // Show frame in editor

            // Re-render viewport
            this.renderer.render(this.scene, this.camera);
        }
        return dataURL;
    }
}


// === Pose Studio Widget ===
class PoseStudioWidget {
    constructor(node) {
        this.node = node;
        this.container = null;
        this.viewer = null;

        this.poses = [{}];  // Array of pose data
        this.activeTab = 0;
        this.poseCaptures = []; // Cache for captured images

        // Slider values
        this.meshParams = {
            age: 25, gender: 0.5, weight: 0.5,
            muscle: 0.5, height: 0.5,
            // Female-specific
            breast_size: 0.5, firmness: 0.5,
            // Male-specific
            penis_len: 0.5, penis_circ: 0.5, penis_test: 0.5
        };

        // Export settings
        this.exportParams = {
            view_width: 512,
            view_height: 512,
            cam_zoom: 1.0,
            output_mode: "LIST",
            grid_columns: 2,
            bg_color: [40, 40, 40]
        };

        this.sliders = {};
        this.exportWidgets = {};
        this.tabsContainer = null;
        this.canvasContainer = null;

        this.createUI();
    }

    createUI() {
        // Main container
        this.container = document.createElement("div");
        this.container.className = "vnccs-pose-studio";

        // === LEFT PANEL ===
        const leftPanel = document.createElement("div");
        leftPanel.className = "vnccs-ps-left";

        // --- MESH PARAMS SECTION ---
        const meshSection = this.createSection("Mesh Parameters", true);

        // Gender Toggle
        const genderField = document.createElement("div");
        genderField.className = "vnccs-ps-field";

        const genderLabel = document.createElement("div");
        genderLabel.className = "vnccs-ps-label";
        genderLabel.innerText = "Gender";
        genderField.appendChild(genderLabel);

        const genderToggle = document.createElement("div");
        genderToggle.className = "vnccs-ps-toggle";

        const btnMale = document.createElement("button");
        btnMale.className = "vnccs-ps-toggle-btn male";
        btnMale.innerText = "Male";

        const btnFemale = document.createElement("button");
        btnFemale.className = "vnccs-ps-toggle-btn female";
        btnFemale.innerText = "Female";

        this.updateGenderUI = () => {
            const isFemale = this.meshParams.gender < 0.5;
            btnMale.classList.toggle("active", !isFemale);
            btnFemale.classList.toggle("active", isFemale);
        };

        btnMale.addEventListener("click", () => {
            this.meshParams.gender = 1.0;
            this.updateGenderUI();
            this.updateGenderVisibility();
            this.onMeshParamsChanged();
        });

        btnFemale.addEventListener("click", () => {
            this.meshParams.gender = 0.0;
            this.updateGenderUI();
            this.updateGenderVisibility();
            this.onMeshParamsChanged();
        });

        this.updateGenderUI();

        genderToggle.appendChild(btnMale);
        genderToggle.appendChild(btnFemale);
        genderField.appendChild(genderToggle);
        meshSection.content.appendChild(genderField);

        // Base Mesh Sliders (gender-neutral)
        const baseSliderDefs = [
            { key: "age", label: "Age", min: 1, max: 90, step: 1 },
            { key: "weight", label: "Weight", min: 0, max: 1, step: 0.01 },
            { key: "muscle", label: "Muscle", min: 0, max: 1, step: 0.01 },
            { key: "height", label: "Height", min: 0, max: 2, step: 0.01 }
        ];

        for (const s of baseSliderDefs) {
            const field = this.createSliderField(s.label, s.key, s.min, s.max, s.step, this.meshParams);
            meshSection.content.appendChild(field);
        }

        leftPanel.appendChild(meshSection.el);

        // --- GENDER SETTINGS SECTION ---
        const genderSection = this.createSection("Gender Settings", true);

        this.genderFields = {}; // Store gender-specific fields for visibility toggle

        // Female-specific sliders
        const femaleSliders = [
            { key: "breast_size", label: "Breast Size", min: 0, max: 2, step: 0.01 },
            { key: "firmness", label: "Firmness", min: 0, max: 1, step: 0.01 }
        ];

        for (const s of femaleSliders) {
            const field = this.createSliderField(s.label, s.key, s.min, s.max, s.step, this.meshParams);
            genderSection.content.appendChild(field);
            this.genderFields[s.key] = { field, gender: "female" };
        }

        // Male-specific sliders
        const maleSliders = [
            { key: "penis_len", label: "Length", min: 0, max: 1, step: 0.01 },
            { key: "penis_circ", label: "Girth", min: 0, max: 1, step: 0.01 },
            { key: "penis_test", label: "Testicles", min: 0, max: 1, step: 0.01 }
        ];

        for (const s of maleSliders) {
            const field = this.createSliderField(s.label, s.key, s.min, s.max, s.step, this.meshParams);
            genderSection.content.appendChild(field);
            this.genderFields[s.key] = { field, gender: "male" };
        }

        // Update visibility based on initial gender
        this.updateGenderVisibility();

        leftPanel.appendChild(genderSection.el);

        // --- MODEL ROTATION SECTION ---
        const rotSection = this.createSection("Model Rotation", false);

        ['x', 'y', 'z'].forEach(axis => {
            const field = document.createElement("div");
            field.className = "vnccs-ps-field";

            const labelRow = document.createElement("div");
            labelRow.className = "vnccs-ps-label-row";
            labelRow.innerHTML = `<span class="vnccs-ps-label">${axis.toUpperCase()}</span><span class="vnccs-ps-value">0°</span>`;
            const valueSpan = labelRow.querySelector(".vnccs-ps-value");

            const wrap = document.createElement("div");
            wrap.className = "vnccs-ps-slider-wrap";

            const slider = document.createElement("input");
            slider.type = "range";
            slider.className = "vnccs-ps-slider";
            slider.min = -180;
            slider.max = 180;
            slider.step = 1;
            slider.value = 0;

            slider.addEventListener("input", () => {
                const val = parseFloat(slider.value);
                valueSpan.innerText = `${val}°`;
                if (this.viewer) {
                    this.viewer.modelRotation[axis] = val;
                    if (this.viewer.skinnedMesh) {
                        const r = this.viewer.modelRotation;
                        this.viewer.skinnedMesh.rotation.set(
                            r.x * Math.PI / 180,
                            r.y * Math.PI / 180,
                            r.z * Math.PI / 180
                        );
                    }
                    this.syncToNode();
                }
            });

            this.sliders[`rot_${axis}`] = { slider, label: valueSpan };

            wrap.appendChild(slider);
            field.appendChild(labelRow);
            field.appendChild(wrap);
            rotSection.content.appendChild(field);
        });

        leftPanel.appendChild(rotSection.el);

        // --- EXPORT SETTINGS SECTION ---
        const exportSection = this.createSection("Export Settings", true);

        // Dimensions Row
        const dimRow = document.createElement("div");
        dimRow.className = "vnccs-ps-row";

        dimRow.appendChild(this.createInputField("Width", "view_width", "number", 64, 4096, 8));
        dimRow.appendChild(this.createInputField("Height", "view_height", "number", 64, 4096, 8));
        exportSection.content.appendChild(dimRow);

        // Zoom
        const zoomField = this.createSliderField("Zoom", "cam_zoom", 0.1, 5.0, 0.01, this.exportParams, true);
        exportSection.content.appendChild(zoomField);

        // Output Mode
        const modeField = this.createSelectField("Output Mode", "output_mode", ["LIST", "GRID"]);
        exportSection.content.appendChild(modeField);

        // Grid Columns
        const colsField = this.createInputField("Grid Columns", "grid_columns", "number", 1, 6, 1);
        exportSection.content.appendChild(colsField);

        // BG Color
        const colorField = this.createColorField("Background", "bg_color");
        exportSection.content.appendChild(colorField);

        leftPanel.appendChild(exportSection.el);

        this.container.appendChild(leftPanel);

        // === RIGHT PANEL ===
        const rightPanel = document.createElement("div");
        rightPanel.className = "vnccs-ps-right";

        // Tab Bar
        this.tabsContainer = document.createElement("div");
        this.tabsContainer.className = "vnccs-ps-tabs";
        this.updateTabs();
        rightPanel.appendChild(this.tabsContainer);

        // Canvas Container
        this.canvasContainer = document.createElement("div");
        this.canvasContainer.className = "vnccs-ps-canvas-wrap";

        const canvas = document.createElement("canvas");
        this.canvasContainer.appendChild(canvas);
        rightPanel.appendChild(this.canvasContainer);

        // Action Bar
        const actions = document.createElement("div");
        actions.className = "vnccs-ps-actions";

        const undoBtn = document.createElement("button");
        undoBtn.className = "vnccs-ps-btn";
        undoBtn.innerHTML = '<span class="vnccs-ps-btn-icon">↩</span> Undo';
        undoBtn.onclick = () => this.viewer && this.viewer.undo();

        const redoBtn = document.createElement("button");
        redoBtn.className = "vnccs-ps-btn";
        redoBtn.innerHTML = '<span class="vnccs-ps-btn-icon">↪</span> Redo';
        redoBtn.onclick = () => this.viewer && this.viewer.redo();

        actions.appendChild(undoBtn);
        actions.appendChild(redoBtn);

        const resetBtn = document.createElement("button");
        resetBtn.className = "vnccs-ps-btn";
        resetBtn.innerHTML = '<span class="vnccs-ps-btn-icon">↺</span> Reset';
        resetBtn.addEventListener("click", () => this.resetCurrentPose());

        const snapBtn = document.createElement("button");
        snapBtn.className = "vnccs-ps-btn primary";
        snapBtn.innerHTML = '<span class="vnccs-ps-btn-icon">👁</span> Preview';
        snapBtn.title = "Snap viewport camera to output camera";
        snapBtn.addEventListener("click", () => {
            if (this.viewer) this.viewer.snapToCaptureCamera(
                this.exportParams.view_width,
                this.exportParams.view_height,
                this.exportParams.cam_zoom || 1.0
            );
        });

        const copyBtn = document.createElement("button");
        copyBtn.className = "vnccs-ps-btn";
        copyBtn.innerHTML = '<span class="vnccs-ps-btn-icon">📋</span> Copy';
        copyBtn.addEventListener("click", () => this.copyPose());

        const pasteBtn = document.createElement("button");
        pasteBtn.className = "vnccs-ps-btn";
        pasteBtn.innerHTML = '<span class="vnccs-ps-btn-icon">📋</span> Paste';
        pasteBtn.addEventListener("click", () => this.pastePose());

        const exportBtn = document.createElement("button");
        exportBtn.className = "vnccs-ps-btn";
        exportBtn.innerHTML = '<span class="vnccs-ps-btn-icon">📥</span> Export';
        exportBtn.addEventListener("click", () => this.showExportModal());

        const importBtn = document.createElement("button");
        importBtn.className = "vnccs-ps-btn";
        importBtn.innerHTML = '<span class="vnccs-ps-btn-icon">📤</span> Import';
        importBtn.addEventListener("click", () => this.importPose());

        const refBtn = document.createElement("button");
        refBtn.className = "vnccs-ps-btn";
        refBtn.innerHTML = '<span class="vnccs-ps-btn-icon">🖼️</span> Ref';
        refBtn.title = "Load Reference Image into Camera Frame";
        refBtn.addEventListener("click", () => this.loadReference());

        // Hidden file input for import
        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = ".json";
        fileInput.style.display = "none";
        fileInput.addEventListener("change", (e) => this.handleFileImport(e));
        this.fileImportInput = fileInput;
        this.container.appendChild(fileInput);

        // Hidden file input for reference image
        const refInput = document.createElement("input");
        refInput.type = "file";
        refInput.accept = "image/*";
        refInput.style.display = "none";
        refInput.addEventListener("change", (e) => this.handleRefImport(e));
        this.fileRefInput = refInput;
        this.container.appendChild(refInput);

        actions.appendChild(resetBtn);
        actions.appendChild(snapBtn);
        actions.appendChild(copyBtn);
        actions.appendChild(pasteBtn);
        actions.appendChild(exportBtn);
        actions.appendChild(importBtn);
        actions.appendChild(refBtn);

        rightPanel.appendChild(actions);

        this.container.appendChild(rightPanel);

        // Initialize viewer
        this.viewer = new PoseViewer(canvas);
        this.viewer.syncCallback = () => this.syncToNode();
        this.viewer.init();
    }

    // === UI Helper Methods ===

    createSection(title, expanded = true) {
        const section = document.createElement("div");
        section.className = "vnccs-ps-section" + (expanded ? "" : " collapsed");

        const header = document.createElement("div");
        header.className = "vnccs-ps-section-header";
        header.innerHTML = `
            <span class="vnccs-ps-section-title">${title}</span>
            <span class="vnccs-ps-section-toggle">▼</span>
        `;
        header.addEventListener("click", () => {
            section.classList.toggle("collapsed");
        });

        const content = document.createElement("div");
        content.className = "vnccs-ps-section-content";

        section.appendChild(header);
        section.appendChild(content);

        return { el: section, content };
    }

    createSliderField(label, key, min, max, step, target, isExport = false) {
        const field = document.createElement("div");
        field.className = "vnccs-ps-field";

        const labelRow = document.createElement("div");
        labelRow.className = "vnccs-ps-label-row";

        const value = target[key];
        const displayVal = key === 'age' ? Math.round(value) : value.toFixed(2);
        labelRow.innerHTML = `<span class="vnccs-ps-label">${label}</span><span class="vnccs-ps-value">${displayVal}</span>`;
        const valueSpan = labelRow.querySelector(".vnccs-ps-value");

        const wrap = document.createElement("div");
        wrap.className = "vnccs-ps-slider-wrap";

        const slider = document.createElement("input");
        slider.type = "range";
        slider.className = "vnccs-ps-slider";
        slider.min = min;
        slider.max = max;
        slider.step = step;
        slider.value = value;

        slider.addEventListener("input", () => {
            const val = parseFloat(slider.value);
            valueSpan.innerText = key === 'age' ? Math.round(val) : val.toFixed(2);

            if (isExport) {
                this.exportParams[key] = val;
                // Live preview for zoom
                if (key === 'cam_zoom' && this.viewer) {
                    this.viewer.updateCaptureCamera(
                        this.exportParams.view_width,
                        this.exportParams.view_height,
                        val
                    );
                }
            } else {
                // Directly update meshParams and trigger mesh rebuild
                this.meshParams[key] = val;
                this.onMeshParamsChanged();
            }
        });

        slider.addEventListener("change", () => {
            if (isExport) {
                const needsFull = ['view_width', 'view_height', 'cam_zoom', 'bg_color'].includes(key);
                this.syncToNode(needsFull);
            }
        });

        if (!isExport) {
            this.sliders[key] = { slider, label: valueSpan, def: { key, label, min, max, step } };
        } else {
            this.exportWidgets[key] = slider;
        }

        wrap.appendChild(slider);
        field.appendChild(labelRow);
        field.appendChild(wrap);
        return field;
    }

    createInputField(label, key, type, min, max, step) {
        const field = document.createElement("div");
        field.className = "vnccs-ps-field";

        const labelEl = document.createElement("div");
        labelEl.className = "vnccs-ps-label";
        labelEl.innerText = label;

        const input = document.createElement("input");
        input.type = type;
        input.className = "vnccs-ps-input";
        input.min = min;
        input.max = max;
        input.step = step;
        input.value = this.exportParams[key];

        const isDimension = (key === 'view_width' || key === 'view_height');
        const eventType = isDimension ? 'change' : 'input';

        input.addEventListener(eventType, () => {
            let val = parseFloat(input.value);
            if (isNaN(val)) val = this.exportParams[key];
            val = Math.max(min, Math.min(max, val));

            // For grid columns, integer only
            if (key === 'grid_columns') val = Math.round(val);

            input.value = val;
            this.exportParams[key] = val;
            this.syncToNode(isDimension);
        });

        this.exportWidgets[key] = input;

        field.appendChild(labelEl);
        field.appendChild(input);
        return field;
    }

    createSelectField(label, key, options) {
        const field = document.createElement("div");
        field.className = "vnccs-ps-field";

        const labelEl = document.createElement("div");
        labelEl.className = "vnccs-ps-label";
        labelEl.innerText = label;

        const select = document.createElement("select");
        select.className = "vnccs-ps-select";

        options.forEach(opt => {
            const el = document.createElement("option");
            el.value = opt;
            el.innerText = opt;
            el.selected = this.exportParams[key] === opt;
            select.appendChild(el);
        });

        select.addEventListener("change", () => {
            this.exportParams[key] = select.value;
            this.syncToNode();
        });

        this.exportWidgets[key] = select;

        field.appendChild(labelEl);
        field.appendChild(select);
        return field;
    }

    createColorField(label, key) {
        const field = document.createElement("div");
        field.className = "vnccs-ps-field";

        const labelEl = document.createElement("div");
        labelEl.className = "vnccs-ps-label";
        labelEl.innerText = label;

        const input = document.createElement("input");
        input.type = "color";
        input.className = "vnccs-ps-color";

        // Convert RGB to Hex
        const rgb = this.exportParams[key];
        const hex = "#" + ((1 << 24) + (rgb[0] << 16) + (rgb[1] << 8) + rgb[2]).toString(16).slice(1);
        input.value = hex;

        input.addEventListener("input", () => {
            const hex = input.value;
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            this.exportParams[key] = [r, g, b];
        });

        input.addEventListener("change", () => {
            this.syncToNode(true);
        });

        this.exportWidgets[key] = input;

        field.appendChild(labelEl);
        field.appendChild(input);
        return field;
    }

    updateTabs() {
        this.tabsContainer.innerHTML = "";

        for (let i = 0; i < this.poses.length; i++) {
            const tab = document.createElement("button");
            tab.className = "vnccs-ps-tab" + (i === this.activeTab ? " active" : "");

            const text = document.createElement("span");
            text.innerText = `Pose ${i + 1}`;
            tab.appendChild(text);

            if (this.poses.length > 1) {
                const close = document.createElement("span");
                close.className = "vnccs-ps-tab-close";
                close.innerText = "×";

                close.onclick = (e) => {
                    e.stopPropagation();
                    this.deleteTab(i);
                };
                tab.appendChild(close);
            }

            tab.addEventListener("click", () => this.switchTab(i));
            this.tabsContainer.appendChild(tab);
        }

        // Add button (max 12)
        if (this.poses.length < 12) {
            const addBtn = document.createElement("button");
            addBtn.className = "vnccs-ps-tab-add";
            addBtn.innerText = "+";
            addBtn.addEventListener("click", () => this.addTab());
            this.tabsContainer.appendChild(addBtn);
        }
    }

    switchTab(index) {
        if (index === this.activeTab) return;

        // Save current pose & capture
        if (this.viewer && this.viewer.initialized) {
            this.poses[this.activeTab] = this.viewer.getPose();
            this.syncToNode(false);
        }

        this.activeTab = index;
        this.updateTabs();

        // Load new pose
        if (this.viewer && this.viewer.initialized) {
            this.viewer.setPose(this.poses[this.activeTab] || {});
            this.updateRotationSliders();
        }

        this.syncToNode(false);
    }

    addTab() {
        if (this.poses.length >= 12) return;

        // Save current & capture
        if (this.viewer && this.viewer.initialized) {
            this.poses[this.activeTab] = this.viewer.getPose();
            this.syncToNode(false);
        }

        this.poses.push({});
        this.activeTab = this.poses.length - 1;
        this.updateTabs();

        if (this.viewer && this.viewer.initialized) {
            this.viewer.resetPose();
        }

        this.syncToNode(false);
    }

    deleteTab(targetIndex = -1) {
        if (this.poses.length <= 1) return;
        const idx = targetIndex === -1 ? this.activeTab : targetIndex;

        // Remove capture
        if (this.poseCaptures && this.poseCaptures.length > idx) {
            this.poseCaptures.splice(idx, 1);
        }

        this.poses.splice(idx, 1);

        // Adjust active tab logic
        if (idx < this.activeTab) {
            this.activeTab--;
        } else if (idx === this.activeTab) {
            if (this.activeTab >= this.poses.length) {
                this.activeTab = this.poses.length - 1;
            }
            // Load new pose since active was deleted
            if (this.viewer && this.viewer.initialized) {
                this.viewer.setPose(this.poses[this.activeTab] || {});
                this.updateRotationSliders();
            }
        }

        this.updateTabs();
        this.syncToNode(false);
    }



    resetCurrentPose() {
        if (this.viewer) {
            this.viewer.resetPose();
            this.updateRotationSliders();
        }
        this.poses[this.activeTab] = {};
        this.syncToNode(false);
    }

    copyPose() {
        if (this.viewer && this.viewer.initialized) {
            this.poses[this.activeTab] = this.viewer.getPose();
        }
        this._clipboard = JSON.parse(JSON.stringify(this.poses[this.activeTab]));
    }

    pastePose() {
        if (!this._clipboard) return;
        this.poses[this.activeTab] = JSON.parse(JSON.stringify(this._clipboard));
        if (this.viewer && this.viewer.initialized) {
            this.viewer.setPose(this.poses[this.activeTab]);
        }
        this.syncToNode();
    }

    showExportModal() {
        // Create modal structure
        const overlay = document.createElement("div");
        overlay.className = "vnccs-ps-modal-overlay";

        const modal = document.createElement("div");
        modal.className = "vnccs-ps-modal";

        const title = document.createElement("div");
        title.className = "vnccs-ps-modal-title";
        title.innerText = "Export Pose Data";

        const content = document.createElement("div");
        content.className = "vnccs-ps-modal-content";

        const inputRow = document.createElement("div");
        inputRow.style.marginBottom = "10px";

        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.placeholder = "Filename (optional)";
        nameInput.className = "vnccs-ps-input";
        nameInput.style.width = "100%";
        nameInput.style.marginBottom = "5px";

        inputRow.appendChild(nameInput);

        const btnSingle = document.createElement("button");
        btnSingle.className = "vnccs-ps-modal-btn";
        btnSingle.innerText = "Current Pose Only";
        btnSingle.onclick = () => {
            this.exportPose('single', nameInput.value);
            this.container.removeChild(overlay);
        };

        const btnSet = document.createElement("button");
        btnSet.className = "vnccs-ps-modal-btn";
        btnSet.innerText = "All Poses (Set)";
        btnSet.onclick = () => {
            this.exportPose('set', nameInput.value);
            this.container.removeChild(overlay);
        };

        const btnCancel = document.createElement("button");
        btnCancel.className = "vnccs-ps-modal-btn cancel";
        btnCancel.innerText = "Cancel";
        btnCancel.onclick = () => {
            this.container.removeChild(overlay);
        };

        content.appendChild(inputRow);
        content.appendChild(btnSingle);
        content.appendChild(btnSet);
        content.appendChild(btnCancel);

        modal.appendChild(title);
        modal.appendChild(content);
        overlay.appendChild(modal);

        this.container.appendChild(overlay);
    }

    exportPose(type, customName) {
        let data, filename;
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const name = (customName && customName.trim()) ? customName.trim().replace(/[^a-z0-9_\-\.]/gi, '_') : timestamp;

        if (type === 'set') {
            // Ensure current active pose is saved to array
            if (this.viewer) this.poses[this.activeTab] = this.viewer.getPose();

            data = {
                type: "pose_set",
                version: "1.0",
                poses: this.poses
            };
            filename = `pose_set_${name}.json`;
        } else {
            // Single pose
            if (this.viewer) this.poses[this.activeTab] = this.viewer.getPose();

            data = {
                type: "single_pose",
                version: "1.0",
                bones: this.poses[this.activeTab].bones,
                modelRotation: this.poses[this.activeTab].modelRotation
            };
            filename = `pose_${name}.json`;
        }

        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    importPose() {
        if (this.fileImportInput) {
            this.fileImportInput.click();
        }
    }

    handleFileImport(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const data = JSON.parse(event.target.result);

                if (data.type === "pose_set" || Array.isArray(data.poses)) {
                    // Import Set
                    const newPoses = data.poses || (Array.isArray(data) ? data : null);
                    if (newPoses && Array.isArray(newPoses)) {
                        this.poses = newPoses;
                        this.activeTab = 0;
                        this.updateTabs();
                        // Load first pose
                        if (this.viewer && this.viewer.initialized) {
                            this.viewer.setPose(this.poses[0]);
                            this.updateRotationSliders();
                        }
                    }
                    this.syncToNode(true);
                } else if (data.type === "single_pose" || data.bones) {
                    // Import Single to current tab
                    // Strip metadata if present
                    const poseData = data.bones ? data : data;

                    this.poses[this.activeTab] = poseData;
                    if (this.viewer && this.viewer.initialized) {
                        this.viewer.setPose(poseData);
                        this.updateRotationSliders();
                    }
                    this.syncToNode(false);
                }

            } catch (err) {
                console.error("Error importing pose:", err);
                alert("Failed to load pose file. invalid JSON.");
            }

            // Reset input so same file can be selected again
            e.target.value = '';
        };
        reader.readAsText(file);
    }

    loadReference() {
        if (this.fileRefInput) {
            this.fileRefInput.click();
        }
    }

    handleRefImport(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            if (this.viewer) {
                this.viewer.loadReferenceImage(event.target.result);
                // Also force camera update to set plane size
                this.viewer.updateCaptureCamera(
                    this.exportParams.view_width,
                    this.exportParams.view_height,
                    this.exportParams.cam_zoom || 1.0
                );
            }
            e.target.value = '';
        };
        reader.readAsDataURL(file);
    }

    loadModel() {
        return api.fetchApi("/vnccs/character_studio/update_preview", {
            method: "POST",
            body: JSON.stringify(this.meshParams)
        }).then(r => r.json()).then(d => {
            if (this.viewer) {
                // Keep camera during updates
                this.viewer.loadData(d, true);

                // Apply pose immediately (no timeout/flicker)
                if (this.viewer.initialized) {
                    this.viewer.setPose(this.poses[this.activeTab] || {});
                    this.updateRotationSliders();
                    // Full recapture needed because mesh changed
                    this.syncToNode(true);
                }
            }
        });
    }

    processMeshUpdate() {
        if (this.isMeshUpdating) return;
        this.isMeshUpdating = true;
        this.pendingMeshUpdate = false;

        this.loadModel().finally(() => {
            this.isMeshUpdating = false;
            if (this.pendingMeshUpdate) {
                this.processMeshUpdate();
            }
        });
    }

    updateRotationSliders() {
        if (!this.viewer) return;
        const r = this.viewer.modelRotation;
        ['x', 'y', 'z'].forEach(axis => {
            const info = this.sliders[`rot_${axis}`];
            if (info) {
                info.slider.value = r[axis];
                info.label.innerText = `${r[axis]}°`;
            }
        });
    }

    updateGenderVisibility() {
        if (!this.genderFields) return;
        const isFemale = this.meshParams.gender < 0.5;

        for (const [key, info] of Object.entries(this.genderFields)) {
            if (info.gender === "female") {
                info.field.style.display = isFemale ? "" : "none";
            } else if (info.gender === "male") {
                info.field.style.display = isFemale ? "none" : "";
            }
        }
    }

    onMeshParamsChanged() {
        // Update node widgets
        for (const [key, value] of Object.entries(this.meshParams)) {
            const widget = this.node.widgets?.find(w => w.name === key);
            if (widget) {
                widget.value = value;
            }
        }

        // Async Queue update
        this.pendingMeshUpdate = true;
        this.processMeshUpdate();
    }

    resize(w, h) {
        if (this.viewer && this.canvasContainer) {
            // Account for zoom: 0.67 scaling
            const rect = this.canvasContainer.getBoundingClientRect();
            const zoomFactor = 0.67;
            const actualW = rect.width / zoomFactor || 500;
            const actualH = rect.height / zoomFactor || 500;
            this.viewer.resize(actualW, actualH);
        }
    }

    syncToNode(fullCapture = false) {
        // Save current pose before syncing
        if (this.viewer && this.viewer.initialized) {
            this.poses[this.activeTab] = this.viewer.getPose();
        }

        // Cache Handling
        if (!this.poseCaptures) this.poseCaptures = [];
        // Ensure size
        while (this.poseCaptures.length < this.poses.length) this.poseCaptures.push(null);
        while (this.poseCaptures.length > this.poses.length) this.poseCaptures.pop();

        // Capture Image (CSR)
        if (this.viewer && this.viewer.initialized) {
            const w = this.exportParams.view_width || 512;
            const h = this.exportParams.view_height || 512;
            const z = this.exportParams.cam_zoom || 1.0;
            const bg = this.exportParams.bg_color || [40, 40, 40];

            if (fullCapture) {
                // Determine original pose index to restore
                const originalTab = this.activeTab;

                // Capture ALL
                for (let i = 0; i < this.poses.length; i++) {
                    this.viewer.setPose(this.poses[i]);
                    this.poseCaptures[i] = this.viewer.capture(w, h, z, bg);
                }

                // Restore active pose
                if (this.activeTab !== originalTab) { // Just in case
                    this.activeTab = originalTab;
                }
                this.viewer.setPose(this.poses[this.activeTab]);

            } else {
                // Capture only ACTIVE
                this.poseCaptures[this.activeTab] = this.viewer.capture(w, h, z, bg);
            }
        }

        // Update hidden pose_data widget
        const data = {
            mesh: this.meshParams,
            export: this.exportParams,
            poses: this.poses,
            activeTab: this.activeTab,
            captured_images: this.poseCaptures
        };

        const widget = this.node.widgets?.find(w => w.name === "pose_data");
        if (widget) {
            widget.value = JSON.stringify(data);
        }
    }

    loadFromNode() {
        // Load from pose_data widget
        const widget = this.node.widgets?.find(w => w.name === "pose_data");
        if (!widget || !widget.value) return;

        try {
            const data = JSON.parse(widget.value);

            if (data.mesh) {
                this.meshParams = { ...this.meshParams, ...data.mesh };
                // Update sliders
                for (const [key, info] of Object.entries(this.sliders)) {
                    if (key.startsWith('rot_')) continue; // Skip rotation sliders here
                    if (info.def && this.meshParams[key] !== undefined) {
                        info.slider.value = this.meshParams[key];
                        const val = this.meshParams[key];
                        info.label.innerText = key === 'age' ? Math.round(val) : val.toFixed(2);
                    }
                }
                // Update gender switch
                if (this.updateGenderUI) this.updateGenderUI();
                this.updateGenderVisibility();
            }

            if (data.export) {
                this.exportParams = { ...this.exportParams, ...data.export };
                // Update export widgets
                for (const [key, widget] of Object.entries(this.exportWidgets)) {
                    if (key === 'bg_color') {
                        const rgb = this.exportParams.bg_color;
                        const hex = "#" + ((1 << 24) + (rgb[0] << 16) + (rgb[1] << 8) + rgb[2]).toString(16).slice(1);
                        widget.value = hex;
                    } else if (this.exportParams[key] !== undefined) {
                        widget.value = this.exportParams[key];
                    }
                }
            }

            if (data.poses && Array.isArray(data.poses)) {
                this.poses = data.poses;
            }

            if (typeof data.activeTab === 'number') {
                this.activeTab = Math.min(data.activeTab, this.poses.length - 1);
            }

            if (data.captured_images && Array.isArray(data.captured_images)) {
                this.poseCaptures = data.captured_images;
            }

            this.updateTabs();

            // Auto-load model
            this.loadModel();

        } catch (e) {
            console.error("Failed to parse pose_data:", e);
        }
    }


}


// === ComfyUI Extension Registration ===
app.registerExtension({
    name: "VNCCS.PoseStudio",

    async beforeRegisterNodeDef(nodeType, nodeData, _app) {
        if (nodeData.name !== "VNCCS_PoseStudio") return;

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onCreated) onCreated.apply(this, arguments);

            this.setSize([900, 700]);

            // Create widget
            this.studioWidget = new PoseStudioWidget(this);

            this.addDOMWidget("pose_studio_ui", "ui", this.studioWidget.container, {
                serialize: false,
                hideOnZoom: false
            });

            // Hide pose_data widget
            const poseWidget = this.widgets?.find(w => w.name === "pose_data");
            if (poseWidget) {
                poseWidget.type = "hidden";
                poseWidget.computeSize = () => [0, -4];
            }

            // Load model after initialization
            setTimeout(() => {
                this.studioWidget.loadFromNode();
                this.studioWidget.loadModel().then(() => {
                    // Auto-center camera on initialization
                    if (this.studioWidget.viewer) {
                        this.studioWidget.viewer.snapToCaptureCamera(
                            this.studioWidget.exportParams.view_width,
                            this.studioWidget.exportParams.view_height,
                            this.studioWidget.exportParams.cam_zoom || 1.0
                        );
                    }
                });
            }, 500);
        };

        nodeType.prototype.onResize = function (size) {
            if (this.studioWidget) {
                // Container has zoom: 0.67, so we need larger CSS dimensions
                const zoomFactor = 0.67;
                const w = Math.max(600, (size[0] - 20) / zoomFactor);
                const h = Math.max(400, (size[1] - 40) / zoomFactor); // Reduced offset for less empty space
                this.studioWidget.container.style.width = w + "px";
                this.studioWidget.container.style.height = h + "px";

                setTimeout(() => this.studioWidget.resize(w, h), 50);
            }
        };

        // Save state on configure
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            if (onConfigure) onConfigure.apply(this, arguments);

            if (this.studioWidget) {
                setTimeout(() => {
                    this.studioWidget.loadFromNode();
                    this.studioWidget.loadModel();
                }, 200);
            }
        };
    }
});
