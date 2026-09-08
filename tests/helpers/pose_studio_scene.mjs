import fs from "node:fs/promises";
import vm from "node:vm";
import { gunzipSync } from "node:zlib";
import * as THREE from "../../web/three.module.js";
import { PoseViewerCore } from "../../web/vnccs_pose_studio_core.js";
import * as characters from "../../web/vnccs_pose_characters.mjs";
import * as animation from "../../web/vnccs_pose_animation.mjs";
import { HAND_PRESETS } from "../../web/vnccs_hand_presets.js";
import * as openpose from "../../web/vnccs_openpose_import.js";
import { isLikelyVideoFile } from "../../web/vnccs_video_import.mjs";
import { parseMorphPack, solveMorph, buildStaticModelData } from "../../web/vnccs_pose_morph_runtime.mjs";

const source = await fs.readFile(new URL("../../web/vnccs_pose_studio.js", import.meta.url), "utf8");
const raw = gunzipSync(await fs.readFile(new URL("../../web/assets/pose_studio_makehuman.v2.bin.gz", import.meta.url)));
const pack = parseMorphPack(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const noop = () => {};
export class Element {
    constructor(tag = "div") {
        this.tagName = tag.toUpperCase(); this.style = {}; this.children = []; this.events = {};
        this.dataset = {}; this.value = ""; this.width = 140; this.height = 140;
        this.offsetWidth = 140; this.offsetHeight = 140; this.clientWidth = 140; this.clientHeight = 140;
        this.classList = { add: noop, remove: noop, toggle: noop, contains: () => false };
    }
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    addEventListener(type, fn) { (this.events[type] ||= []).push(fn); }
    removeEventListener() {}
    dispatchEvent(event) { for (const fn of this.events[event.type] || []) fn(event); this[`on${event.type}`]?.(event); }
    emit(type, values = {}) { this.dispatchEvent({ type, target: this, button: 0, pointerId: 1, stopPropagation: noop, preventDefault: noop, ...values }); }
    getContext() {
        this.drawCommands = [];
        return new Proxy({}, {
            get: (state, key) => state[key] ?? ((...args) => {
                this.drawCommands.push({ method: key, args, ...state });
                return { addColorStop: noop };
            }),
            set: (state, key, value) => { state[key] = value; return true; },
        });
    }
    getBoundingClientRect() { return { left: 0, top: 0, width: 140, height: 140 }; }
    setPointerCapture(id) { this.capture = id; }
    hasPointerCapture(id) { return this.capture === id; }
    releasePointerCapture() { this.capture = null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    setAttribute() {}
    remove() {}
    removeChild(child) { this.children = this.children.filter(item => item !== child); }
    click() { this.emit("click"); }
}
export function createScene({ skinned = false } = {}) {
    const frames = new Map(), timers = new Map(); let id = 0;
    const document = { createElement: tag => new Element(tag), createDocumentFragment: () => new Element(), body: new Element(), activeElement: null };
    const context = { ...characters, ...animation, ...openpose, isLikelyVideoFile, HAND_PRESETS, console, document, window: {}, Blob,
        getComputedStyle: element => ({ width: `${element.width}px`, height: `${element.height}px` }),
        localStorage: { getItem: () => null, setItem: noop },
        requestAnimationFrame: fn => { frames.set(++id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id),
        setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: id => timers.delete(id),
        app: { graph: { setDirtyCanvas: noop } }, Event: class { constructor(type) { this.type = type; } },
    };
    const constants = source.slice(source.indexOf("const DEFAULT_POSE_STUDIO_MESH_PROPORTIONS"), source.indexOf("function getVNCCSSharedMorphWorker"));
    const Widget = vm.runInNewContext(constants + source.slice(source.indexOf("class PoseStudioWidget {"), source.indexOf("// === ComfyUI Extension Registration ===")) + "\nPoseStudioWidget", context);
    Widget.prototype.createUI = noop;
    const node = { id: 1, widgets: [{ name: "pose_data", value: "{}" }] };
    const w = new Widget(node);
    w.container = new Element();
    w.tabsContainer = new Element();
    const viewer = new PoseViewerCore(new Element("canvas"));
    w.viewer = viewer; w.canvas = viewer.canvas;
    viewer.THREE = THREE;
    viewer.scene = new THREE.Scene();
    viewer.scene.background = new THREE.Color(0x1a1a2e);
    viewer.captureCamera = new THREE.PerspectiveCamera(30, 1, 0.1, 1000);
    viewer.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
    viewer.orbit = { target: new THREE.Vector3(), update() { viewer.camera.lookAt(this.target); viewer.camera.updateMatrixWorld(true); } };
    viewer.requestRender = noop;
    let geometry = new THREE.BufferGeometry();
    viewer.skinnedMesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    viewer.scene.add(viewer.skinnedMesh);
    viewer.initialized = true;
    function morph(patch = {}) {
        Object.assign(w.meshParams, patch);
        const model = solveMorph(pack, w.meshParams);
        if (skinned && viewer.skeleton) {
            viewer.updateBodyVertices(model.vertices, model.bonePositions, model.landmarks, model.landmarkIndices,
                buildStaticModelData(pack, model.includeGenitals).indices);
        } else if (skinned) {
            viewer.scene.remove(viewer.skinnedMesh);
            if (viewer.skeletonHelper) viewer.scene.remove(viewer.skeletonHelper);
            viewer.options.enableTextureSkinning = false;
            const data = w.modelDataFromMorphMessage({ ...model, staticData: buildStaticModelData(pack, model.includeGenitals) });
            const initialized = viewer._initMeshGeometry(data);
            geometry = initialized.geometry;
            viewer._initSkeleton(data, geometry, initialized.vertices);
        } else geometry.setAttribute("position", new THREE.BufferAttribute(model.vertices, 3));
        geometry.computeBoundingBox();
        viewer.meshCenter = geometry.boundingBox.getCenter(new THREE.Vector3());
        if (!viewer.sceneCameraTarget) viewer.sceneCameraTarget = viewer.meshCenter.clone();
        return model;
    }
    morph();
    viewer.options.onViewportRender = () => w.radarRedraw?.();
    viewer.options.captureHistoryContext = () => ({ mesh: { ...w.meshParams }, transform: { ...w.getActiveCharacter().transform }, cameraParams: w.currentCameraParams(), prompt: w.getPosePrompt() });
    viewer.options.onHistoryRestore = pose => w.restoreImageHistory(pose);
    viewer.options.onPoseChange = () => { w.updateRotationSliders(); w.syncToNode(); };
    w.createSliderField("Zoom", "cam_zoom", 0.1, 7, 0.01, 1, w.exportParams, true);
    for (const key of ["cam_yaw_deg", "cam_pitch_deg"]) w.createSliderField(key, key, -180, 180, 1, 0, w.exportParams, true);
    const pan = new Element(); w.createCameraRadar({ content: pan });
    const pad = pan.children[0].children.find(child => child.tagName === "CANVAS");
    w.applyCameraToViewer(true);
    w.syncToNode(false);
    const assertable = () => ({ transform: { ...w.getActiveCharacter().transform }, runtime: { ...viewer.activeCharacterAppearance.transform }, controls: w.currentCameraParams(), saved: JSON.parse(node.widgets[0].value) });
    const projection = () => {
        viewer.skinnedMesh.updateMatrixWorld(true); viewer.captureCamera.updateMatrixWorld(true);
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        const point = new THREE.Vector3(), positions = geometry.attributes.position;
        const visible = skinned ? new Set(geometry.index.array) : Array.from({ length: positions.count }, (_, i) => i);
        viewer.skeleton?.update();
        for (const i of visible) {
            point.fromBufferAttribute(positions, i);
            if (skinned) viewer.skinnedMesh.applyBoneTransform(i, point);
            point.applyMatrix4(viewer.skinnedMesh.matrixWorld).project(viewer.captureCamera);
            minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
            minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
        }
        return { minX, maxX, minY, maxY };
    };
    return { w, viewer, node, morph, pad, frames, timers, context, document, assertable, projection, THREE };
}
