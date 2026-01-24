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
    min-width: 0;
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
    flex-shrink: 0;
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

/* Counter-zoom for select dropdown options */
.vnccs-ps-select:focus {
    transform: scale(1.49);
    transform-origin: top left;
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

.vnccs-ps-toggle-btn.list.active {
    background: #20a0a0;
}

.vnccs-ps-toggle-btn.grid.active {
    background: #e0a020;
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

.vnccs-ps-reset-btn {
    width: 20px;
    height: 20px;
    background: transparent;
    border: 1px solid var(--ps-border);
    color: var(--ps-text-muted);
    border-radius: 3px;
    cursor: pointer;
    font-size: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    transition: all 0.15s;
}

.vnccs-ps-reset-btn:hover {
    color: var(--ps-accent);
    border-color: var(--ps-accent);
    background: rgba(255, 255, 255, 0.05);
}

/* Lighting UI Styles */
.vnccs-ps-light-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 8px;
    max-height: 280px;
    overflow-y: auto;
    overflow-x: hidden;
    padding-right: 4px;
    padding-bottom: 20px;
}
.vnccs-ps-light-item { 
    background: rgba(0,0,0,0.3); 
    border-radius: 6px; 
    padding: 8px; 
    border: 1px solid rgba(255,255,255,0.1);
}
.vnccs-ps-light-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
    padding-bottom: 4px;
    border-bottom: 1px solid rgba(255,255,255,0.1);
}
.vnccs-ps-light-title { font-weight: bold; font-size: 11px; color: #ccc; }
.vnccs-ps-light-remove {
    background: #c44;
    border: none;
    border-radius: 4px;
    color: white;
    width: 20px;
    height: 20px;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
}
.vnccs-ps-light-remove:hover { background: #f55; }
.vnccs-ps-light-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
}
.vnccs-ps-light-row label {
    width: 50px;
    font-size: 10px;
    color: #999;
    flex-shrink: 0;
}
.vnccs-ps-light-row input[type="color"] {
    width: 28px;
    height: 20px;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    padding: 0;
}
.vnccs-ps-light-row input[type="range"] {
    flex: 1;
    min-width: 0;
    height: 4px;
    background: #444;
    border-radius: 2px;
}
.vnccs-ps-light-row input[type="number"] {
    width: 50px;
    background: #222;
    border: 1px solid #444;
    border-radius: 3px;
    color: white;
    font-size: 10px;
    padding: 2px 4px;
}
.vnccs-ps-light-value {
    width: 35px;
    flex-shrink: 0;
    text-align: right;
    font-size: 10px;
    color: #aaa;
}
.vnccs-ps-btn-add-light { background: #3a6; }
.vnccs-ps-btn-add-light:hover { background: #4b7; }

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
    flex-wrap: wrap;
    gap: 8px; /* Reverted from 6px */
    padding: 8px 10px; /* Reverted from 6px 8px */
    background: #1a1a1a;
    border-top: 1px solid var(--ps-border);
    flex-shrink: 0;
}

.vnccs-ps-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 8px 14px; /* Reverted from 6px 12px */
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
    background: #222;
    border: 1px solid #444;
    border-radius: 8px;
    width: 340px;
    box-shadow: 0 20px 40px rgba(0,0,0,0.5);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 0;
}

.vnccs-ps-footer {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding-top: 8px;
    border-top: 1px solid var(--ps-border);
    margin-top: 8px;
}

.vnccs-ps-footer .vnccs-ps-btn {
    flex: 1;
    min-width: 40px;
}

.vnccs-ps-actions .vnccs-ps-btn {
    flex: 1;
    min-width: 40px;
}

.vnccs-ps-modal-title {
    background: #2a2a2a;
    padding: 12px 16px;
    border-bottom: 1px solid #333;
    font-size: 14px;
    font-weight: 600;
    color: var(--ps-text);
    margin: 0;
}

.vnccs-ps-modal-content {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px;
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

.vnccs-ps-settings-panel {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: #1a1a1a;
    z-index: 100;
    display: flex;
    flex-direction: column;
}

.vnccs-ps-settings-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: #252525;
    border-bottom: 1px solid var(--ps-border);
}

.vnccs-ps-settings-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--ps-text);
    display: flex;
    align-items: center;
    gap: 8px;
}

.vnccs-ps-settings-content {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.vnccs-ps-settings-close {
    background: transparent;
    border: none;
    color: var(--ps-text-muted);
    font-size: 18px;
    cursor: pointer;
    padding: 4px 8px;
    transition: color 0.2s;
}

.vnccs-ps-settings-close:hover {
    color: var(--ps-text);
}

.vnccs-ps-msg-modal {
    background: #222;
    border: 1px solid #444;
    border-radius: 8px;
    width: 340px;
    box-shadow: 0 20px 40px rgba(0,0,0,0.5);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 0;
}

.vnccs-ps-modal-btn.cancel:hover {
    color: var(--ps-text);
    background: #333;
}

/* === Pose Library Panel === */
.vnccs-ps-library-btn {
    position: absolute;
    right: 0;
    top: 50%;
    transform: translateY(-50%);
    background: var(--ps-accent);
    color: white;
    border: none;
    border-radius: 4px 0 0 4px;
    padding: 12px 6px;
    cursor: pointer;
    font-size: 16px;
    z-index: 100;
    transition: all 0.2s;
    pointer-events: auto;
}

.vnccs-ps-library-btn:hover {
    background: #7c5cff;
    padding-right: 10px;
}

.vnccs-ps-library-panel {
    position: absolute;
    top: 0;
    right: -250px;
    width: 250px;
    height: 100%;
    background: var(--ps-panel);
    border-left: 1px solid var(--ps-border);
    display: flex;
    flex-direction: column;
    transition: right 0.25s ease;
    z-index: 99;
    pointer-events: auto;
}

.vnccs-ps-library-panel.open {
    right: 0;
}

.vnccs-ps-library-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 12px;
    border-bottom: 1px solid var(--ps-border);
    background: #1a1a1a;
}

.vnccs-ps-library-title {
    font-weight: bold;
    color: var(--ps-text);
    font-size: 13px;
}

.vnccs-ps-library-close {
    background: transparent;
    border: none;
    color: var(--ps-text-muted);
    font-size: 18px;
    cursor: pointer;
    padding: 0;
    line-height: 1;
}

.vnccs-ps-library-close:hover {
    color: var(--ps-text);
}

.vnccs-ps-library-grid {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
    align-content: start;
}

.vnccs-ps-library-item {
    background: var(--ps-input-bg);
    border: 1px solid var(--ps-border);
    border-radius: 4px;
    overflow: hidden;
    cursor: pointer;
    transition: all 0.15s;
    position: relative; /* For absolute delete button */
}

.vnccs-ps-library-item-delete {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 20px;
    height: 20px;
    background: rgba(200, 50, 50, 0.8);
    color: white;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    opacity: 0;
    transition: all 0.2s;
    z-index: 10;
}

.vnccs-ps-library-item:hover .vnccs-ps-library-item-delete {
    opacity: 1;
}

.vnccs-ps-library-item-delete:hover {
    background: rgb(220, 50, 50);
    transform: scale(1.1);
}

.vnccs-ps-library-item:hover {
    border-color: var(--ps-accent);
    transform: scale(1.02);
}

.vnccs-ps-library-item-preview {
    width: 100%;
    aspect-ratio: 1;
    background: #1a1a1a;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ps-text-muted);
    font-size: 28px;
}

.vnccs-ps-library-item-preview img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.vnccs-ps-library-item-name {
    position: absolute;
    bottom: 0;
    left: 0;
    width: 100%;
    padding: 6px 4px;
    background: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(2px);
    font-size: 11px;
    text-align: center;
    color: #fff;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    z-index: 5;
}

.vnccs-ps-library-footer {
    padding: 8px;
    border-top: 1px solid var(--ps-border);
}

.vnccs-ps-library-empty {
    grid-column: 1 / -1;
    text-align: center;
    color: var(--ps-text-muted);
    padding: 20px;
    font-size: 12px;
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
        this.headScale = 1.0;

        // Managed lights array
        this.lights = [];
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

            if (this.pendingLights) {
                this.updateLights(this.pendingLights);
                this.pendingLights = null;
            }

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

        // Lights - will be setup by updateLights() call from widget
        // (removed hardcoded lights)

        // Events
        this.canvas.addEventListener("pointerdown", (e) => this.handlePointerDown(e));
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
        for (const light of this.lights) {
            this.scene.remove(light);
            if (light.dispose) light.dispose();
        }
        this.lights = [];

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
                light = new THREE.PointLight(color, params.intensity ?? 1.0, 100);
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

        if (data.uvs && data.uvs.length > 0) {
            geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(data.uvs), 2));
        }

        let skinTex;
        if (this.cachedSkinTexture) {
            skinTex = this.cachedSkinTexture;
        } else {
            const texLoader = new THREE.TextureLoader();
            skinTex = texLoader.load(`/extensions/ComfyUI_VNCCS_Utils/textures/skin.png?v=${Date.now()}`,
                (tex) => {
                    console.log("Texture loaded successfully");
                    this.requestRender();
                },
                undefined,
                (err) => console.error("Texture failed to load", err)
            );
            this.cachedSkinTexture = skinTex;
        }

        const material = new THREE.MeshPhongMaterial({
            map: skinTex,
            color: 0xffffff,
            specular: 0x111111,
            shininess: 5,
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

        // Apply cached head scale
        if (this.headScale !== 1.0) {
            this.updateHeadScale(this.headScale);
        }

        this.requestRender();
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
            cameraParams: this.syncCallback ? this.syncCallback(true) : null // Request params return
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

    setModelRotation(x, y, z) {
        this.modelRotation.x = x;
        this.modelRotation.y = y;
        this.modelRotation.z = z;
        if (this.skinnedMesh) {
            this.skinnedMesh.rotation.set(
                x * Math.PI / 180,
                y * Math.PI / 180,
                z * Math.PI / 180
            );
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

    updateCaptureCamera(width, height, zoom = 1.0, offsetX = 0, offsetY = 0) {
        if (!this.THREE) return; // Not initialized yet
        const baseTarget = this.meshCenter || new this.THREE.Vector3(0, 10, 0);
        // Apply offset (in world units, scaled by zoom for intuitive control)
        const target = new this.THREE.Vector3(
            baseTarget.x - offsetX,
            baseTarget.y - offsetY,
            baseTarget.z
        );
        const dist = 45;

        if (!this.captureCamera) {
            this.captureCamera = new this.THREE.PerspectiveCamera(30, width / height, 0.1, 100);
            this.scene.add(this.captureCamera);

            // Visual Helper
            this.captureHelper = new this.THREE.CameraHelper(this.captureCamera);
            this.scene.add(this.captureHelper);
        }

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

        if (this.captureHelper) {
            this.captureHelper.update();
            this.captureHelper.visible = true;
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
            penis_len: 0.5, penis_circ: 0.5, penis_test: 0.5,
            // Visual modifiers
            head_size: 1.0
        };

        // Export settings
        this.exportParams = {
            view_width: 1024,
            view_height: 1024,
            cam_zoom: 1.0,
            cam_offset_x: 0,
            cam_offset_y: 0,
            output_mode: "LIST",
            grid_columns: 2,
            bg_color: [255, 255, 255],
            debugMode: false,  // Random pose rotation, camera, and lighting
            debugNoLight: false // If true, disable random lighting in debug mode
        };

        // Lighting settings (array of light configs)
        this.lightParams = [
            { type: 'directional', color: [255, 255, 255], intensity: 2.0, x: 10, y: 20, z: 30 },
            { type: 'ambient', color: [80, 80, 80], intensity: 1.0, x: 0, y: 0, z: 0 }
        ];

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

        this.genderBtns = { male: btnMale, female: btnFemale };

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
            { key: "age", label: "Age", min: 1, max: 90, step: 1, def: 25 },
            { key: "weight", label: "Weight", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "muscle", label: "Muscle", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "height", label: "Height", min: 0, max: 2, step: 0.01, def: 0.5 },
            { key: "head_size", label: "Head Size", min: 0.5, max: 2.0, step: 0.01, def: 1.0 }
        ];

        for (const s of baseSliderDefs) {
            const field = this.createSliderField(s.label, s.key, s.min, s.max, s.step, s.def, this.meshParams);
            meshSection.content.appendChild(field);
        }

        leftPanel.appendChild(meshSection.el);

        // --- GENDER SETTINGS SECTION ---
        const genderSection = this.createSection("Gender Settings", true);

        this.genderFields = {}; // Store gender-specific fields for visibility toggle

        // Female-specific sliders
        const femaleSliders = [
            { key: "breast_size", label: "Breast Size", min: 0, max: 2, step: 0.01, def: 0.5 },
            { key: "firmness", label: "Firmness", min: 0, max: 1, step: 0.01, def: 0.5 }
        ];

        for (const s of femaleSliders) {
            const field = this.createSliderField(s.label, s.key, s.min, s.max, s.step, s.def, this.meshParams);
            genderSection.content.appendChild(field);
            this.genderFields[s.key] = { field, gender: "female" };
        }

        // Male-specific sliders
        const maleSliders = [
            { key: "penis_len", label: "Length", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "penis_circ", label: "Girth", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "penis_test", label: "Testicles", min: 0, max: 1, step: 0.01, def: 0.5 }
        ];

        for (const s of maleSliders) {
            const field = this.createSliderField(s.label, s.key, s.min, s.max, s.step, s.def, this.meshParams);
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

            const labelSpan = document.createElement("span");
            labelSpan.className = "vnccs-ps-label";
            labelSpan.textContent = axis.toUpperCase();

            const valueSpan = document.createElement("span");
            valueSpan.className = "vnccs-ps-value";
            valueSpan.textContent = "0°";

            // Reset button
            const resetBtn = document.createElement("button");
            resetBtn.className = "vnccs-ps-reset-btn";
            resetBtn.innerHTML = "↺";
            resetBtn.title = "Reset to 0°";
            resetBtn.onclick = (e) => {
                e.stopPropagation();
                slider.value = 0;
                valueSpan.innerText = "0°";
                if (this.viewer) {
                    this.viewer.modelRotation[axis] = 0;
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
            };

            // Group value and reset button together on the right
            const valueRow = document.createElement("div");
            valueRow.style.display = "flex";
            valueRow.style.alignItems = "center";
            valueRow.style.gap = "6px";
            valueRow.appendChild(valueSpan);
            valueRow.appendChild(resetBtn);

            labelRow.appendChild(labelSpan);
            labelRow.appendChild(valueRow);

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

        // --- CAMERA SETTINGS SECTION ---
        const camSection = this.createSection("Camera", true);

        // Dimensions Row
        const dimRow = document.createElement("div");
        dimRow.className = "vnccs-ps-row";
        dimRow.appendChild(this.createInputField("Width", "view_width", "number", 64, 4096, 8));
        dimRow.appendChild(this.createInputField("Height", "view_height", "number", 64, 4096, 8));
        camSection.content.appendChild(dimRow);

        // Zoom (with live preview)
        // Zoom (with live preview)
        const zoomField = this.createSliderField("Zoom", "cam_zoom", 0.1, 5.0, 0.01, 1.0, this.exportParams, true);
        camSection.content.appendChild(zoomField);

        // Position X
        // Position X
        // Camera Radar Control
        this.createCameraRadar(camSection);



        leftPanel.appendChild(camSection.el);

        // --- LIGHTING SECTION ---
        const lightSection = this.createSection("Lighting", true);

        // Container for all light controls
        const lightListContainer = document.createElement("div");
        lightListContainer.className = "vnccs-ps-light-list";

        // Store reference for re-rendering
        this.lightListContainer = lightListContainer;

        // Button row for lighting controls
        const lightBtnRow = document.createElement("div");
        lightBtnRow.style.cssText = "display: flex; gap: 6px;";

        // Reset Lighting button
        const resetLightBtn = document.createElement("button");
        resetLightBtn.className = "vnccs-ps-btn";
        resetLightBtn.innerHTML = '<span class="vnccs-ps-btn-icon">↺</span> Reset';
        resetLightBtn.title = "Reset to default lighting";
        resetLightBtn.onclick = () => {
            this.lightParams = [
                { type: 'ambient', color: '#404040', intensity: 0.5 },
                { type: 'directional', color: '#ffffff', intensity: 1.0, x: 1, y: 2, z: 3 }
            ];
            this.refreshLightUI();
            this.applyLighting();
        };

        // Add Light button
        const addLightBtn = document.createElement("button");
        addLightBtn.className = "vnccs-ps-btn vnccs-ps-btn-add-light";
        addLightBtn.innerHTML = '<span class="vnccs-ps-btn-icon">+</span> Add';
        addLightBtn.onclick = () => {
            // Default new light: white point light at origin
            this.lightParams.push({
                type: 'point',
                color: '#ffffff',
                intensity: 1.0,
                x: 0,
                y: 0,
                z: 5
            });
            this.refreshLightUI();
            this.applyLighting();
        };

        lightBtnRow.appendChild(resetLightBtn);
        lightBtnRow.appendChild(addLightBtn);

        // Add buttons BEFORE the list so they're always visible
        lightSection.content.appendChild(lightBtnRow);
        lightSection.content.appendChild(lightListContainer);
        leftPanel.appendChild(lightSection.el);

        // Initialize default lights if empty
        if (this.lightParams.length === 0) {
            this.lightParams.push(
                { type: 'ambient', color: '#404040', intensity: 0.5 },
                { type: 'directional', color: '#ffffff', intensity: 1.0, x: 1, y: 2, z: 3 }
            );
        }

        // Initial render of lights
        this.refreshLightUI();

        // --- EXPORT SETTINGS SECTION ---
        const exportSection = this.createSection("Export Settings", true);

        // Output Mode
        // Output Mode (Toggle)
        const modeField = document.createElement("div");
        modeField.className = "vnccs-ps-field";
        const modeLabel = document.createElement("div");
        modeLabel.className = "vnccs-ps-label";
        modeLabel.innerText = "Output Mode";

        const modeToggle = document.createElement("div");
        modeToggle.className = "vnccs-ps-toggle";

        const btnList = document.createElement("button");
        btnList.className = "vnccs-ps-toggle-btn list";
        btnList.innerText = "List";
        const btnGrid = document.createElement("button");
        btnGrid.className = "vnccs-ps-toggle-btn grid";
        btnGrid.innerText = "Grid";

        const updateModeUI = () => {
            const isGrid = this.exportParams.output_mode === 'GRID';
            btnList.classList.toggle("active", !isGrid);
            btnGrid.classList.toggle("active", isGrid);
        };

        btnList.onclick = () => {
            this.exportParams.output_mode = 'LIST';
            updateModeUI();
            this.syncToNode(true);
        }
        btnGrid.onclick = () => {
            this.exportParams.output_mode = 'GRID';
            updateModeUI();
            this.syncToNode(true);
        }

        updateModeUI();
        modeToggle.appendChild(btnList);
        modeToggle.appendChild(btnGrid);
        modeField.appendChild(modeLabel);
        modeField.appendChild(modeToggle);

        // Cache for programmatic updates
        this.exportWidgets['output_mode'] = {
            value: this.exportParams.output_mode, // dummy
            update: (val) => {
                this.exportParams.output_mode = val;
                updateModeUI();
            }
        };

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
                this.exportParams.cam_zoom || 1.0,
                this.exportParams.cam_offset_x || 0,
                this.exportParams.cam_offset_y || 0
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
        refBtn.innerHTML = '<span class="vnccs-ps-btn-icon">🖼️</span> Background';
        refBtn.title = "Load or Remove Background Image";
        refBtn.onclick = () => {
            if (this.viewer && this.viewer.refPlane) {
                this.viewer.removeReferenceImage();
                refBtn.innerHTML = '<span class="vnccs-ps-btn-icon">🖼️</span> Background';
                refBtn.classList.remove('danger');
            } else {
                this.loadReference();
            }
        };
        this.refBtn = refBtn;

        const settingsBtn = document.createElement("button");
        settingsBtn.className = "vnccs-ps-btn";
        settingsBtn.innerHTML = '<span class="vnccs-ps-btn-icon">⚙️</span>';
        settingsBtn.title = "Settings (Debug)";
        settingsBtn.onclick = () => this.showSettingsModal();
        this.settingsBtn = settingsBtn;

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

        const footer = document.createElement("div");
        footer.className = "vnccs-ps-footer";
        footer.appendChild(exportBtn);
        footer.appendChild(importBtn);
        footer.appendChild(refBtn);
        footer.appendChild(settingsBtn);

        rightPanel.appendChild(actions);
        rightPanel.appendChild(footer);

        this.container.appendChild(rightPanel);

        // === POSE LIBRARY PANEL (sliding right) ===
        this.libraryPanel = document.createElement("div");
        this.libraryPanel.className = "vnccs-ps-library-panel";
        this.libraryPanel.innerHTML = `
            <div class="vnccs-ps-library-header">
                <span class="vnccs-ps-library-title">📚 Pose Library</span>
                <button class="vnccs-ps-library-close">✕</button>
            </div>
            <div class="vnccs-ps-library-grid"></div>
            <div class="vnccs-ps-library-footer">
                <button class="vnccs-ps-btn primary" style="width:100%">
                    <span class="vnccs-ps-btn-icon">💾</span> Save Current
                </button>
            </div>
        `;
        this.libraryGrid = this.libraryPanel.querySelector(".vnccs-ps-library-grid");
        this.libraryPanel.querySelector(".vnccs-ps-library-close").onclick = () => this.closeLibrary();
        this.libraryPanel.querySelector(".vnccs-ps-library-footer button").onclick = () => this.showSaveToLibraryModal();
        this.container.appendChild(this.libraryPanel);

        // Library toggle button (edge of canvas)
        this.libraryBtn = document.createElement("button");
        this.libraryBtn.className = "vnccs-ps-library-btn";
        this.libraryBtn.innerHTML = "📚";
        this.libraryBtn.title = "Pose Library";
        this.libraryBtn.onclick = () => this.toggleLibrary();
        this.container.appendChild(this.libraryBtn);

        // Initialize viewer
        this.viewer = new PoseViewer(canvas);
        this.viewer.syncCallback = (returnParams = false) => {
            if (returnParams) {
                return {
                    offset_x: this.exportParams.cam_offset_x,
                    offset_y: this.exportParams.cam_offset_y,
                    zoom: this.exportParams.cam_zoom
                };
            }
            this.syncToNode();
        };
        this.viewer.init();
        // Force initial lighting
        if (this.lightParams) {
            this.viewer.updateLights(this.lightParams);
        }
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

    createSliderField(label, key, min, max, step, defaultValue, target, isExport = false) {
        const field = document.createElement("div");
        field.className = "vnccs-ps-field";

        const labelRow = document.createElement("div");
        labelRow.className = "vnccs-ps-label-row";
        labelRow.style.display = "flex";
        labelRow.style.justifyContent = "space-between";
        labelRow.style.alignItems = "center";

        const value = target[key];
        const displayVal = key === 'age' ? Math.round(value) : value.toFixed(2);
        const valueRow = document.createElement("div");
        valueRow.style.display = "flex";
        valueRow.style.alignItems = "center";
        valueRow.style.gap = "6px";

        const valueSpan = document.createElement("span");
        valueSpan.className = "vnccs-ps-value";
        valueSpan.innerText = displayVal;

        const resetBtn = document.createElement("button");
        resetBtn.className = "vnccs-ps-reset-btn";
        resetBtn.innerHTML = "↺";
        resetBtn.title = `Reset to ${defaultValue}`;

        valueRow.appendChild(valueSpan);
        valueRow.appendChild(resetBtn);

        // Label Side
        const labelEl = document.createElement("span");
        labelEl.className = "vnccs-ps-label";
        labelEl.innerText = label;

        labelRow.innerHTML = '';
        labelRow.appendChild(labelEl);
        labelRow.appendChild(valueRow);

        const wrap = document.createElement("div");
        wrap.className = "vnccs-ps-slider-wrap";

        const slider = document.createElement("input");
        slider.type = "range";
        slider.className = "vnccs-ps-slider";
        slider.min = min;
        slider.max = max;
        slider.step = step;
        slider.value = value;

        // Reset logic
        resetBtn.onclick = (e) => {
            e.stopPropagation();
            slider.value = defaultValue;
            slider.dispatchEvent(new Event('input'));
            slider.dispatchEvent(new Event('change'));
        };

        slider.addEventListener("input", () => {
            const val = parseFloat(slider.value);
            valueSpan.innerText = key === 'age' ? Math.round(val) : val.toFixed(2);

            if (isExport) {
                this.exportParams[key] = val;
                // Live preview for camera params - sync viewport too
                const isCamParam = ['cam_zoom', 'cam_offset_x', 'cam_offset_y'].includes(key);
                if (isCamParam && this.viewer) {
                    this.viewer.snapToCaptureCamera(
                        this.exportParams.view_width,
                        this.exportParams.view_height,
                        this.exportParams.cam_zoom,
                        this.exportParams.cam_offset_x,
                        this.exportParams.cam_offset_y
                    );
                }
            } else {
                if (key === 'head_size') {
                    // Update head scale immediately without backend rebuild
                    if (this.viewer) this.viewer.updateHeadScale(val);
                    this.meshParams[key] = val; // Just save
                    this.syncToNode(false);
                } else {
                    // Directly update meshParams and trigger mesh rebuild
                    this.meshParams[key] = val;
                    this.onMeshParamsChanged();
                }
            }
        });

        slider.addEventListener("change", () => {
            if (isExport) {
                const needsFull = ['view_width', 'view_height', 'cam_zoom', 'bg_color', 'cam_offset_x', 'cam_offset_y'].includes(key);
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

    createCameraRadar(section) {
        const wrap = document.createElement("div");
        wrap.className = "vnccs-ps-radar-wrap";
        wrap.style.display = "flex";
        wrap.style.flexDirection = "column";
        wrap.style.alignItems = "center";
        wrap.style.marginTop = "10px";
        wrap.style.background = "#181818";
        wrap.style.border = "1px solid #333";
        wrap.style.borderRadius = "4px";
        wrap.style.padding = "10px";

        // Canvas
        const canvas = document.createElement("canvas");
        const size = 200;
        canvas.width = size;
        canvas.height = size;
        canvas.style.width = "200px";
        canvas.style.height = "200px";
        canvas.style.cursor = "crosshair";

        const ctx = canvas.getContext("2d");

        // Interaction State
        let isDragging = false;

        const range = 20.0; // Max offset range (+/- 20)

        const updateFromMouse = (e) => {
            const rect = canvas.getBoundingClientRect();
            // Scaling support
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;

            const mouseX = (e.clientX - rect.left) * scaleX;
            const mouseY = (e.clientY - rect.top) * scaleY;

            // Aspect Ratio Logic to find active area
            const viewW = this.exportParams.view_width || 1024;
            const viewH = this.exportParams.view_height || 1024;
            const ar = viewW / viewH;

            // Dynamic Range calculation based on Zoom
            const zoom = this.exportParams.cam_zoom || 1.0;
            const baseRange = 12.05;
            const rangeY = baseRange / zoom;
            const rangeX = rangeY * ar;

            // Fit box in canvas (margin 10px) (Visual Scale 0.5 for 2x Range)
            const margin = 10;
            const visualScale = 0.5;
            const maxW = (size - margin * 2) * visualScale;
            const maxH = (size - margin * 2) * visualScale;
            let drawW, drawH;

            if (ar >= 1) { // Landscape
                drawW = maxW;
                drawH = maxW / ar;
            } else { // Portrait
                drawH = maxH;
                drawW = maxH * ar;
            }

            const cx = size / 2;
            const cy = size / 2;

            // Clamping to box
            const halfW = drawW / 2;
            const halfH = drawH / 2;

            let dx = (mouseX - cx);
            let dy = (mouseY - cy);

            // Clamp to Canvas size (not frame size), so we can drag outside frame
            // Frame is drawW/drawH. Canvas is size (200).
            // Let's allow dragging to the very edge of canvas minus margin
            const maxDragX = (size / 2) - 5;
            const maxDragY = (size / 2) - 5;

            dx = Math.max(-maxDragX, Math.min(maxDragX, dx));
            dy = Math.max(-maxDragY, Math.min(maxDragY, dy));

            const normX = dx / halfW;
            const normY = dy / halfH;

            // X: Dot Right -> Model Right
            this.exportParams.cam_offset_x = normX * rangeX;

            // Y: Dot Top (neg) -> Model Top
            this.exportParams.cam_offset_y = -normY * rangeY;

            draw();

            // Sync Viewport
            if (this.viewer) {
                this.viewer.snapToCaptureCamera(
                    this.exportParams.view_width,
                    this.exportParams.view_height,
                    this.exportParams.cam_zoom,
                    this.exportParams.cam_offset_x,
                    this.exportParams.cam_offset_y
                );
            }
        };

        canvas.addEventListener("mousedown", (e) => {
            isDragging = true;
            updateFromMouse(e);
        });

        document.addEventListener("mousemove", (e) => {
            if (isDragging) updateFromMouse(e);
        });

        document.addEventListener("mouseup", () => {
            if (isDragging) {
                isDragging = false;
                this.syncToNode(false);
            }
        });

        const draw = () => {
            // Clear
            ctx.fillStyle = "#111";
            ctx.fillRect(0, 0, size, size);

            const viewW = this.exportParams.view_width || 1024;
            const viewH = this.exportParams.view_height || 1024;
            const ar = viewW / viewH;

            // Recalculate ranges for drawing
            const zoom = this.exportParams.cam_zoom || 1.0;
            const baseRange = 12.05;
            const rangeY = baseRange / zoom;
            const rangeX = rangeY * ar;

            // Fit box (Visual Scale 0.5)
            const margin = 10;
            const visualScale = 0.5;
            const maxW = (size - margin * 2) * visualScale;
            const maxH = (size - margin * 2) * visualScale;
            let drawW, drawH;

            if (ar >= 1) { // Landscape
                drawW = maxW;
                drawH = maxW / ar;
            } else { // Portrait
                drawH = maxH;
                drawW = maxH * ar;
            }

            const cx = size / 2;
            const cy = size / 2;

            // Draw Viewer Frame
            ctx.fillStyle = "#222";
            ctx.fillRect(cx - drawW / 2, cy - drawH / 2, drawW, drawH);
            ctx.strokeStyle = "#444";
            ctx.lineWidth = 1;
            ctx.strokeRect(cx - drawW / 2, cy - drawH / 2, drawW, drawH);

            // Grid
            ctx.beginPath();
            ctx.strokeStyle = "#333";
            ctx.moveTo(cx, cy - drawH / 2);
            ctx.lineTo(cx, cy + drawH / 2);
            ctx.moveTo(cx - drawW / 2, cy);
            ctx.lineTo(cx + drawW / 2, cy);
            ctx.stroke();

            // Draw Dot (Target)
            const normX = (this.exportParams.cam_offset_x || 0) / rangeX;
            const normY = -(this.exportParams.cam_offset_y || 0) / rangeY;

            const dotX = cx + normX * (drawW / 2);
            const dotY = cy + normY * (drawH / 2);

            // Dot
            ctx.beginPath();
            ctx.fillStyle = "#3584e4";
            ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
            ctx.fill();

            // Crosshair
            ctx.beginPath();
            ctx.strokeStyle = "#3584e4";
            ctx.lineWidth = 1;
            ctx.moveTo(dotX - 6, dotY);
            ctx.lineTo(dotX + 6, dotY);
            ctx.moveTo(dotX, dotY - 6);
            ctx.lineTo(dotX, dotY + 6);
            ctx.stroke();

            // Info Text
            ctx.fillStyle = "#666";
            ctx.font = "10px monospace";
            ctx.textAlign = "right";
            // ctx.fillText(`X:${(this.exportParams.cam_offset_x||0).toFixed(1)}`, size-5, 12);
        };

        // Expose redraw
        this.radarRedraw = draw;

        // Recenter Button
        const recenterBtn = document.createElement("button");
        recenterBtn.className = "vnccs-ps-btn";
        recenterBtn.style.marginTop = "8px";
        recenterBtn.style.width = "100%";
        recenterBtn.innerHTML = '<span class="vnccs-ps-btn-icon">⌖</span> Re-center';
        recenterBtn.onclick = () => {
            this.exportParams.cam_offset_x = 0;
            this.exportParams.cam_offset_y = 0;
            draw();
            if (this.viewer) {
                this.viewer.snapToCaptureCamera(
                    this.exportParams.view_width,
                    this.exportParams.view_height,
                    this.exportParams.cam_zoom,
                    0, 0
                );
            }
            this.syncToNode(false);
        };

        wrap.appendChild(canvas);
        wrap.appendChild(recenterBtn);
        section.content.appendChild(wrap);

        // Initial Draw
        requestAnimationFrame(() => draw());
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
        const newPose = this.poses[this.activeTab] || {};
        if (this.viewer && this.viewer.initialized) {
            this.viewer.setPose(newPose);
            this.updateRotationSliders();
        }

        // Restore Camera Sliders if saved
        // Restore Camera Sliders if saved
        if (newPose.cameraParams) {
            this.exportParams.cam_offset_x = newPose.cameraParams.offset_x || 0;
            this.exportParams.cam_offset_y = newPose.cameraParams.offset_y || 0;
            this.exportParams.cam_zoom = newPose.cameraParams.zoom || 1.0;
        } else {
            // Default params if new pose has none
            this.exportParams.cam_offset_x = 0;
            this.exportParams.cam_offset_y = 0;
            this.exportParams.cam_zoom = 1.0;
        }

        // Update DOM widgets
        if (this.exportWidgets.cam_offset_x) this.exportWidgets.cam_offset_x.value = this.exportParams.cam_offset_x;
        if (this.exportWidgets.cam_offset_y) this.exportWidgets.cam_offset_y.value = this.exportParams.cam_offset_y;
        if (this.exportWidgets.cam_zoom) this.exportWidgets.cam_zoom.value = this.exportParams.cam_zoom;

        // Force Camera Snap
        if (this.viewer) {
            this.viewer.snapToCaptureCamera(
                this.exportParams.view_width,
                this.exportParams.view_height,
                this.exportParams.cam_zoom,
                this.exportParams.cam_offset_x,
                this.exportParams.cam_offset_y
            );
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
            this.viewer.recordState(); // Undo support
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

                if (this.refBtn) {
                    this.refBtn.innerHTML = '<span class="vnccs-ps-btn-icon">🗑️</span> Remove Background';
                    this.refBtn.classList.add('danger');
                }
            }
            e.target.value = '';
        };
        reader.readAsDataURL(file);
    }

    // === Pose Library Methods ===

    toggleLibrary() {
        if (this.libraryPanel.classList.contains('open')) {
            this.closeLibrary();
        } else {
            this.openLibrary();
        }
    }

    openLibrary() {
        this.libraryPanel.classList.add('open');
        this.refreshLibrary();
    }

    closeLibrary() {
        this.libraryPanel.classList.remove('open');
    }

    async refreshLibrary() {
        try {
            const res = await fetch('/vnccs/pose_library/list');
            const data = await res.json();
            this.libraryPoses = data.poses || []; // Cache for random selection

            this.libraryGrid.innerHTML = '';

            if (!data.poses || data.poses.length === 0) {
                this.libraryGrid.innerHTML = '<div class="vnccs-ps-library-empty">No saved poses.<br>Click "Save Current" to add one.</div>';
                return;
            }

            for (const pose of data.poses) {
                const item = document.createElement('div');
                item.className = 'vnccs-ps-library-item';

                const preview = document.createElement('div');
                preview.className = 'vnccs-ps-library-item-preview';
                if (pose.has_preview) {
                    preview.innerHTML = `<img src="/vnccs/pose_library/preview/${encodeURIComponent(pose.name)}" alt="${pose.name}">`;
                } else {
                    preview.innerHTML = '🦴';
                }

                const name = document.createElement('div');
                name.className = 'vnccs-ps-library-item-name';
                name.innerText = pose.name;

                item.onclick = () => this.loadFromLibrary(pose.name);

                // Delete button
                const delBtn = document.createElement('div');
                delBtn.className = 'vnccs-ps-library-item-delete';
                delBtn.innerHTML = '✕';
                delBtn.onclick = (e) => {
                    e.stopPropagation(); // Prevent loading pose
                    this.showDeleteConfirmModal(pose.name);
                };

                item.appendChild(preview);
                item.appendChild(name);
                item.appendChild(delBtn);

                this.libraryGrid.appendChild(item);
            }
        } catch (err) {
            console.error("Failed to load library:", err);
            this.libraryGrid.innerHTML = '<div class="vnccs-ps-library-empty">Failed to load library.</div>';
        }
    }

    showSaveToLibraryModal() {
        const overlay = document.createElement('div');
        overlay.className = 'vnccs-ps-modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'vnccs-ps-modal';
        modal.innerHTML = `
            <div class="vnccs-ps-modal-title">Save to Library</div>
            <div class="vnccs-ps-modal-content">
                <input type="text" placeholder="Pose name..." class="vnccs-ps-input" style="width:100%;padding:8px;">
                <label style="display:flex;align-items:center;gap:8px;color:var(--ps-text-muted);font-size:11px;">
                    <input type="checkbox" checked> Include preview image
                </label>
            </div>
            <button class="vnccs-ps-modal-btn primary" style="justify-content:center;">💾 Save</button>
            <button class="vnccs-ps-modal-btn cancel">Cancel</button>
        `;

        const nameInput = modal.querySelector('input[type="text"]');
        const previewCheck = modal.querySelector('input[type="checkbox"]');

        modal.querySelector('.vnccs-ps-modal-btn.primary').onclick = () => {
            const name = nameInput.value.trim();
            if (name) {
                this.saveToLibrary(name, previewCheck.checked);
                overlay.remove();
            }
        };

        modal.querySelector('.vnccs-ps-modal-btn.cancel').onclick = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

        overlay.appendChild(modal);
        this.container.appendChild(overlay);
        nameInput.focus();
    }

    async saveToLibrary(name, includePreview = true) {
        if (!this.viewer) return;

        const pose = this.viewer.getPose();
        let preview = null;

        if (includePreview) {
            preview = this.viewer.capture(
                this.exportParams.view_width,
                this.exportParams.view_height,
                this.exportParams.cam_zoom || 1.0,
                this.exportParams.bg_color || [40, 40, 40],
                this.exportParams.cam_offset_x || 0,
                this.exportParams.cam_offset_y || 0
            );
        }

        try {
            await fetch('/vnccs/pose_library/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, pose, preview })
            });
            this.refreshLibrary();
        } catch (err) {
            console.error("Failed to save pose:", err);
        }
    }

    async loadFromLibrary(name) {
        try {
            const res = await fetch(`/vnccs/pose_library/get/${encodeURIComponent(name)}`);
            const data = await res.json();

            if (data.pose && this.viewer) {
                // Only apply bones and modelRotation from library - NOT camera settings
                // Library poses should not override user's export camera framing
                const poseWithoutCamera = {
                    bones: data.pose.bones,
                    modelRotation: data.pose.modelRotation
                    // Intentionally omit: camera
                };
                this.viewer.setPose(poseWithoutCamera, true); // preserveCamera = true
                this.updateRotationSliders();
                this.syncToNode();
            }
        } catch (err) {
            console.error("Failed to load pose:", err);
        }
    }

    showSettingsModal() {
        // Toggle behavior: check if already exists
        const existing = this.canvasContainer.querySelector('.vnccs-ps-settings-panel');
        if (existing) {
            existing.remove();
            return;
        }

        const panel = document.createElement('div');
        panel.className = 'vnccs-ps-settings-panel';

        // Header
        const header = document.createElement('div');
        header.className = 'vnccs-ps-settings-header';
        header.innerHTML = `
            <span class="vnccs-ps-settings-title">⚙️ Settings</span>
            <button class="vnccs-ps-settings-close" title="Close">✕</button>
        `;
        header.querySelector('.vnccs-ps-settings-close').onclick = () => panel.remove();

        const content = document.createElement('div');
        content.className = 'vnccs-ps-settings-content';

        // Debug Toggle
        const debugRow = document.createElement("div");
        debugRow.className = "vnccs-ps-field";

        const debugLabel = document.createElement("label");
        debugLabel.style.display = "flex";
        debugLabel.style.alignItems = "center";
        debugLabel.style.gap = "10px";
        debugLabel.style.cursor = "pointer";
        debugLabel.style.userSelect = "none";

        const debugCheckbox = document.createElement("input");
        debugCheckbox.type = "checkbox";
        debugCheckbox.checked = this.exportParams.debugMode || false;
        debugCheckbox.style.width = "16px";
        debugCheckbox.style.height = "16px";
        debugCheckbox.onchange = () => {
            this.exportParams.debugMode = debugCheckbox.checked;
            this.syncToNode(false);
        };

        const debugText = document.createElement("div");
        debugText.innerHTML = "<strong>Debug Mode (Randomize on Queue)</strong><div style='font-size:11px; color:#888; margin-top:4px;'>Automatically randomizes pose, lighting and camera for each queued run. Used for generating synthetic datasets.</div>";

        debugLabel.appendChild(debugCheckbox);
        debugLabel.appendChild(debugText);
        debugRow.appendChild(debugLabel);
        content.appendChild(debugRow);

        // No Light Random Toggle
        const noLightRow = document.createElement("div");
        noLightRow.className = "vnccs-ps-field";
        noLightRow.style.marginTop = "10px";

        const noLightLabel = document.createElement("label");
        noLightLabel.style.display = "flex";
        noLightLabel.style.alignItems = "center";
        noLightLabel.style.gap = "10px";
        noLightLabel.style.cursor = "pointer";
        noLightLabel.style.userSelect = "none";

        const noLightCheckbox = document.createElement("input");
        noLightCheckbox.type = "checkbox";
        noLightCheckbox.checked = this.exportParams.debugNoLight || false;
        noLightCheckbox.style.width = "16px";
        noLightCheckbox.style.height = "16px";
        noLightCheckbox.onchange = () => {
            this.exportParams.debugNoLight = noLightCheckbox.checked;
        };

        const noLightText = document.createElement("div");
        noLightText.innerHTML = "<strong>Keep Current Lighting</strong><div style='font-size:11px; color:#888; margin-top:4px;'>If enabled, Debug Mode will randomize poses/camera but KEEP your manually set lighting configuration.</div>";

        noLightLabel.appendChild(noLightCheckbox);
        noLightLabel.appendChild(noLightText);
        noLightRow.appendChild(noLightLabel);
        content.appendChild(noLightRow);

        panel.appendChild(header);
        panel.appendChild(content);

        this.canvasContainer.appendChild(panel);
    }

    showDeleteConfirmModal(poseName) {
        const overlay = document.createElement('div');
        overlay.className = 'vnccs-ps-modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'vnccs-ps-modal';

        const title = document.createElement('div');
        title.className = 'vnccs-ps-modal-title';
        title.textContent = '⚠️ Delete Pose';

        const content = document.createElement('div');
        content.className = 'vnccs-ps-modal-content';
        content.style.textAlign = 'center';

        const message = document.createElement('div');
        message.innerHTML = `Delete pose "<strong>${poseName}</strong>"?<br>This cannot be undone.`;
        content.appendChild(message);

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'vnccs-ps-modal-btn danger';
        deleteBtn.style.justifyContent = 'center';
        deleteBtn.textContent = '🗑️ Delete';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'vnccs-ps-modal-btn cancel';
        cancelBtn.textContent = 'Cancel';

        modal.appendChild(title);
        modal.appendChild(content);
        modal.appendChild(deleteBtn);
        modal.appendChild(cancelBtn);

        deleteBtn.onclick = () => {
            this.deleteFromLibrary(poseName);
            overlay.remove();
        };

        cancelBtn.onclick = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

        overlay.appendChild(modal);
        this.container.appendChild(overlay);
    }

    async deleteFromLibrary(name) {
        try {
            await fetch(`/vnccs/pose_library/delete/${encodeURIComponent(name)}`, { method: 'DELETE' });
            this.refreshLibrary();
        } catch (err) {
            console.error("Failed to delete pose:", err);
        }
    }

    loadModel() {
        return api.fetchApi("/vnccs/character_studio/update_preview", {
            method: "POST",
            body: JSON.stringify(this.meshParams)
        }).then(r => r.json()).then(d => {
            if (this.viewer) {
                // Keep camera during updates
                this.viewer.loadData(d, true);

                // Apply lighting configuration
                this.viewer.updateLights(this.lightParams);

                // FORCE camera sync on every model change (as requested)
                this.viewer.snapToCaptureCamera(
                    this.exportParams.view_width,
                    this.exportParams.view_height,
                    this.exportParams.cam_zoom || 1.0,
                    this.exportParams.cam_offset_x || 0,
                    this.exportParams.cam_offset_y || 0
                );

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

    refreshLightUI() {
        if (!this.lightListContainer) return;
        this.lightListContainer.innerHTML = '';

        this.lightParams.forEach((light, index) => {
            const item = document.createElement('div');
            item.className = 'vnccs-ps-light-item';

            // Header with title and remove button
            const header = document.createElement('div');
            header.className = 'vnccs-ps-light-header';

            const title = document.createElement('span');
            title.className = 'vnccs-ps-light-title';
            title.textContent = `${light.type.charAt(0).toUpperCase() + light.type.slice(1)} Light ${index + 1}`;

            const removeBtn = document.createElement('button');
            removeBtn.className = 'vnccs-ps-light-remove';
            removeBtn.innerHTML = '×';
            removeBtn.onclick = () => {
                this.lightParams.splice(index, 1);
                this.refreshLightUI();
                this.applyLighting();
            };

            header.appendChild(title);
            header.appendChild(removeBtn);
            item.appendChild(header);

            // Light Type selector
            const typeRow = document.createElement('div');
            typeRow.className = 'vnccs-ps-light-row';
            const typeLabel = document.createElement('label');
            typeLabel.textContent = 'Type';
            const typeSelect = document.createElement('select');
            typeSelect.style.cssText = 'flex:1; background:#222; border:1px solid #444; border-radius:3px; color:white; font-size:11px; padding:3px;';
            ['ambient', 'directional', 'point'].forEach(t => {
                const opt = document.createElement('option');
                opt.value = t;
                opt.textContent = t.charAt(0).toUpperCase() + t.slice(1);
                if (t === light.type) opt.selected = true;
                typeSelect.appendChild(opt);
            });
            typeSelect.onclick = (e) => e.stopPropagation();
            typeSelect.onmousedown = (e) => e.stopPropagation();
            typeSelect.onchange = () => {
                light.type = typeSelect.value;
                this.refreshLightUI();
                this.applyLighting();
            };
            typeRow.appendChild(typeLabel);
            typeRow.appendChild(typeSelect);
            item.appendChild(typeRow);

            // Color picker
            const colorRow = document.createElement('div');
            colorRow.className = 'vnccs-ps-light-row';
            const colorLabel = document.createElement('label');
            colorLabel.textContent = 'Color';
            const colorInput = document.createElement('input');
            colorInput.type = 'color';
            colorInput.value = light.color || '#ffffff';
            colorInput.onclick = (e) => e.stopPropagation(); // Stop click
            colorInput.oninput = (e) => {
                e.stopPropagation(); // Stop input
                light.color = colorInput.value;
                clearTimeout(this.colorTimeout);
                this.colorTimeout = setTimeout(() => this.applyLighting(), 50);
            };
            colorRow.appendChild(colorLabel);
            colorRow.appendChild(colorInput);
            item.appendChild(colorRow);

            // Intensity slider
            const isAmbient = light.type === 'ambient';
            const intensityRow = document.createElement('div');
            intensityRow.className = 'vnccs-ps-light-row';
            const intensityLabel = document.createElement('label');
            intensityLabel.textContent = 'Intensity';
            const intensitySlider = document.createElement('input');
            intensitySlider.type = 'range';
            intensitySlider.min = 0;
            intensitySlider.max = isAmbient ? 2 : 5;
            intensitySlider.step = isAmbient ? 0.01 : 0.1;
            intensitySlider.value = light.intensity ?? (isAmbient ? 0.5 : 1);

            // Stop propagation for slider
            intensitySlider.onmousedown = (e) => e.stopPropagation();
            intensitySlider.onpointerdown = (e) => e.stopPropagation();
            intensitySlider.onclick = (e) => e.stopPropagation();

            const intensityValue = document.createElement('span');
            intensityValue.className = 'vnccs-ps-light-value';
            intensityValue.textContent = parseFloat(intensitySlider.value).toFixed(2);
            intensitySlider.oninput = () => {
                light.intensity = parseFloat(intensitySlider.value);
                intensityValue.textContent = light.intensity.toFixed(2);
                this.applyLighting();
            };
            intensityRow.appendChild(intensityLabel);
            intensityRow.appendChild(intensitySlider);
            intensityRow.appendChild(intensityValue);
            item.appendChild(intensityRow);

            // Position controls
            if (light.type !== 'ambient') {
                const posLabels = ['X', 'Y', 'Z'];
                const posKeys = ['x', 'y', 'z'];
                posLabels.forEach((pl, pi) => {
                    const posRow = document.createElement('div');
                    posRow.className = 'vnccs-ps-light-row';
                    const posLabel = document.createElement('label');
                    posLabel.textContent = pl;
                    const posSlider = document.createElement('input');
                    posSlider.type = 'range';
                    posSlider.min = -100;
                    posSlider.max = 100;
                    posSlider.step = 1;
                    posSlider.value = light[posKeys[pi]] || 0;

                    // Stop propagation
                    posSlider.onmousedown = (e) => e.stopPropagation();
                    posSlider.onpointerdown = (e) => e.stopPropagation();

                    const posValue = document.createElement('span');
                    posValue.className = 'vnccs-ps-light-value';
                    posValue.textContent = posSlider.value;

                    posSlider.oninput = () => {
                        light[posKeys[pi]] = parseFloat(posSlider.value);
                        posValue.textContent = light[posKeys[pi]];
                        this.applyLighting();
                    };

                    posRow.appendChild(posLabel);
                    posRow.appendChild(posSlider);
                    posRow.appendChild(posValue);
                    item.appendChild(posRow);
                });
            }


            this.lightListContainer.appendChild(item);
        });
    }

    applyLighting() {
        if (this.viewer && this.viewer.initialized) {
            this.viewer.updateLights(this.lightParams);
        }
        // Lighting changes affect all previews
        this.syncToNode(true);
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

    updateGenderUI() {
        if (!this.genderBtns) return;
        const isFemale = this.meshParams.gender < 0.5;
        this.genderBtns.male.classList.toggle("active", !isFemale);
        this.genderBtns.female.classList.toggle("active", isFemale);
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

    /**
     * Generate a natural language prompt from light parameters.
     * Maps RGB colors to basic names and describes position/intensity.
     */
    generatePromptFromLights(lights) {
        if (!lights || !Array.isArray(lights)) return "";

        const getColorName = (lightColor) => {
            let color = { r: 255, g: 255, b: 255 };
            if (typeof lightColor === 'string') {
                const hex = lightColor.replace('#', '');
                color.r = parseInt(hex.substring(0, 2), 16);
                color.g = parseInt(hex.substring(2, 4), 16);
                color.b = parseInt(hex.substring(4, 6), 16);
            } else if (Array.isArray(lightColor)) {
                color = { r: lightColor[0], g: lightColor[1], b: lightColor[2] };
            }

            const r = color.r / 255, g = color.g / 255, b = color.b / 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            let h, s, l = (max + min) / 2;

            if (max === min) {
                h = s = 0;
            } else {
                const d = max - min;
                s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
                switch (max) {
                    case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                    case g: h = (b - r) / d + 2; break;
                    case b: h = (r - g) / d + 4; break;
                }
                h /= 6;
            }

            const hue = h * 360;
            const sat = s * 100;

            let baseColor = "White";

            // Hue Mapping
            if (hue >= 345 || hue < 15) baseColor = "Red";
            else if (hue >= 15 && hue < 45) baseColor = "Orange";
            else if (hue >= 45 && hue < 75) baseColor = "Yellow";
            else if (hue >= 75 && hue < 150) baseColor = "Green";
            else if (hue >= 150 && hue < 190) baseColor = "Cyan";
            else if (hue >= 190 && hue < 260) baseColor = "Blue";
            else if (hue >= 260 && hue < 290) baseColor = "Purple";
            else if (hue >= 290 && hue < 345) baseColor = "Pink";

            // Saturation Check
            if (sat < 15) {
                if (l < 0.1) return { name: "Black", sat, l };
                if (l < 0.35) return { name: "Dark Grey", sat, l };
                if (l < 0.65) return { name: "Grey", sat, l };
                return { name: "White", sat, l };
            }

            // Lightness Adjectives
            let adj = "";
            if (l < 0.25) adj = "Dark";
            else if (l < 0.40) adj = "Deep";
            else if (l > 0.75) adj = "Pale";
            else if (l > 0.60) adj = "Light";

            const name = adj ? `${adj} ${baseColor}` : baseColor;
            return { name, sat, l };
        };

        const dirPrompts = [];
        const ambPrompts = [];

        for (const light of lights) {
            const { name: colorName, sat, l } = getColorName(light.color);

            if (light.type === 'directional') {
                let posDesc = "";
                const y = light.y || 0;
                const x = light.x || 0;
                const z = light.z || 0;
                if (y > 40) posDesc += "top ";
                else if (y < 20 && y > -100) posDesc += "low ";
                if (x > 20) posDesc += "right";
                else if (x < -20) posDesc += "left";
                else if (z > 30) posDesc += "front";
                else posDesc += "side";
                posDesc = posDesc.trim();

                // 3. Determine Intensity
                const intensity = light.intensity || 1.0;
                let intDesc = "strong";
                if (intensity > 3.0) intDesc = "intense";
                else if (intensity < 1.5) intDesc = "soft";
                else if (intensity < 2.5) intDesc = "bright";

                dirPrompts.push(`${intDesc} ${colorName} lighting coming from the ${posDesc}`);
            } else if (light.type === 'ambient') {
                const intensity = light.intensity || 1.0;
                // Suppress "default" ambient (Dark Grey #505050 or similar)
                // Thresholds: Low saturation (Grey), Low Lightness (< 40%), Normal Intensity (< 1.5)
                const isNeutralDark = (sat < 10 && l < 0.4 && intensity < 1.5);

                if (intensity > 0.05 && !isNeutralDark) {
                    ambPrompts.push(`global ${colorName} ambient lighting`);
                }
            }
        }

        let finalPrompt = dirPrompts.join(". ");
        if (ambPrompts.length > 0) {
            if (finalPrompt.length > 0) finalPrompt += ". ";
            finalPrompt += "Scene filled with " + ambPrompts.join(" and ");
        } else if (finalPrompt.length === 0) {
            return "Soft global ambient lighting.";
        }

        return finalPrompt + ".";
    }

    /**
     * Generate random debug parameters for model rotation, camera, and lighting.
     * Model must remain at least ~20% visible in frame.
     */
    generateDebugParams() {
        // Random Y rotation for model (-90 to 90)
        const modelYRotation = Math.random() * 180 - 90;

        // Random zoom (1.3 to 2.0)
        const zoom = 1.3 + Math.random() * 0.7;

        // Random offset - constrained to keep model 100% visible
        // At 1.3 zoom, we have little room to move. At 2.0, even less if we want FULL body.
        // Actually, higher zoom means VIEWPORT covers LESS of world. 
        // If zoom=1 (full fit), offset must be 0 to keep full fit.
        // If zoom=2 (zoomed in), we crop the body?
        // Wait, user said "100% body must be in frame".
        // IF zoom > 1, we are zooming IN, so we inherently crop the body unless the body was small to begin with.
        // But usually zoom=1 fits the body tightly.
        // So zoom=1.3 will crop the body?
        // Let's assume user means "don't pan so far that model leaves frame".
        // Use small offsets.
        const maxOffset = 2.0 / zoom;
        const offsetX = (Math.random() * 2 - 1) * maxOffset;
        const offsetY = (Math.random() * 2 - 1) * maxOffset;

        // Random directional lighting (skipped if Keep Lighting is checked)
        let lights = null;
        let lightingPrompt = "";

        if (!this.exportParams.debugNoLight) {
            lights = [];

            // Light count probabilities:
            // 20% - 3 lights
            // 50% - 2 lights
            // 30% - 1 light
            const r = Math.random();
            const numLights = r < 0.2 ? 3 : (r < 0.7 ? 2 : 1);

            // Basic Vivid Colors
            const colorPalette = [
                { name: "Red", hex: "#ff0000" },
                { name: "Green", hex: "#00ff00" },
                { name: "Blue", hex: "#0000ff" },
                { name: "Yellow", hex: "#ffff00" },
                { name: "Cyan", hex: "#00ffff" },
                { name: "Magenta", hex: "#ff00ff" },
                { name: "Orange", hex: "#ff8000" },
                { name: "White", hex: "#ffffff" }
            ];

            const prompts = [];

            for (let i = 0; i < numLights; i++) {
                // Pick random color
                const colorObj = colorPalette[Math.floor(Math.random() * colorPalette.length)];

                // Random intensity (2.0 to 3.5)
                const intensity = 2.0 + Math.random() * 1.5;

                // Generate Position
                // Widen range to creates better shadows (side lighting)
                // -60 to 60 for X, 0 to 60 for Z, 10 to 60 for Y
                let x, y, z;
                // Distribute lights to avoid bunching if multiple
                if (numLights > 1) {
                    // Spread X based on index
                    const slice = 120 / numLights;
                    const center = -60 + slice * i + slice / 2;
                    x = center + (Math.random() * 20 - 10); // Jitter
                } else {
                    x = (Math.random() * 2 - 1) * 60;
                }

                y = 10 + Math.random() * 50;
                z = Math.random() * 60;

                // Determine position description
                let posDesc = "";
                if (y > 40) posDesc += "top ";
                else if (y < 20) posDesc += "low ";

                if (x > 20) posDesc += "right";
                else if (x < -20) posDesc += "left";
                else if (z > 30) posDesc += "front";
                else posDesc += "side"; // Fallback

                posDesc = posDesc.trim();

                // Determine intensity description
                let intDesc = "strong";
                if (intensity > 3.0) intDesc = "blinding";
                else if (intensity < 2.5) intDesc = "bright";

                prompts.push(`${intDesc} ${colorObj.name} light from the ${posDesc}`);

                lights.push({
                    type: 'directional',
                    color: colorObj.hex,
                    intensity: parseFloat(intensity.toFixed(2)),
                    x: parseFloat(x.toFixed(1)),
                    y: parseFloat(y.toFixed(1)),
                    z: parseFloat(z.toFixed(1))
                });
            }

            lightingPrompt = prompts.join(". ") + ".";

            // Random Ambient Light
            let ambColor = '#505050';
            let ambIntensity = 0.1;

            // 70% chance of varied ambient color
            if (Math.random() < 0.7) {
                const h = Math.random();
                const s = 0.3 + Math.random() * 0.7; // Colorful (30-100% sat)
                const l = 0.3 + Math.random() * 0.5; // Visible lightness (30-80%)

                // HSL to RGB
                const hue2rgb = (p, q, t) => {
                    if (t < 0) t += 1;
                    if (t > 1) t -= 1;
                    if (t < 1 / 6) return p + (q - p) * 6 * t;
                    if (t < 1 / 2) return q;
                    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                    return p;
                };
                const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
                const p = 2 * l - q;
                const r = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
                const g = Math.round(hue2rgb(p, q, h) * 255);
                const b = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);

                const toHex = c => {
                    const hex = c.toString(16);
                    return hex.length === 1 ? '0' + hex : hex;
                };
                ambColor = '#' + toHex(r) + toHex(g) + toHex(b);
                ambIntensity = 0.2 + Math.random() * 1.0; // 0.2 - 1.2
            }

            lights.push({
                type: 'ambient',
                color: ambColor,
                intensity: parseFloat(ambIntensity.toFixed(2)),
                x: 0, y: 0, z: 0
            });
        }

        // Debug background color (White)
        const bgColor = [255, 255, 255];

        return {
            modelYRotation,
            zoom: parseFloat(zoom.toFixed(2)),
            offsetX: parseFloat(offsetX.toFixed(1)),
            offsetY: parseFloat(offsetY.toFixed(1)),
            lights,
            lightingPrompt,
            bgColor
        };
    }

    syncToNode(fullCapture = false) {
        if (this.radarRedraw) this.radarRedraw();

        // Save current pose before syncing
        if (this.viewer && this.viewer.initialized) {
            this.poses[this.activeTab] = this.viewer.getPose();
        }

        // Cache Handling
        // Cache Handling
        if (!this.poseCaptures) this.poseCaptures = [];
        if (!this.lightingPrompts) this.lightingPrompts = [];

        // Ensure size
        while (this.poseCaptures.length < this.poses.length) this.poseCaptures.push(null);
        while (this.poseCaptures.length > this.poses.length) this.poseCaptures.pop();

        while (this.lightingPrompts.length < this.poses.length) this.lightingPrompts.push("");
        while (this.lightingPrompts.length > this.poses.length) this.lightingPrompts.pop();

        // Capture Image (CSR)
        if (this.viewer && this.viewer.initialized) {
            const w = this.exportParams.view_width || 1024;
            const h = this.exportParams.view_height || 1024;
            const bg = this.exportParams.bg_color || [40, 40, 40];

            // Debug Mode: apply randomized params
            const isDebug = this.exportParams.debugMode;

            if (fullCapture) {
                const originalTab = this.activeTab;
                const originalLights = [...this.lightParams]; // Save original lighting

                for (let i = 0; i < this.poses.length; i++) {

                    if (isDebug) {
                        // Generate fresh random params for each pose
                        const debugParams = this.generateDebugParams();

                        // Random Pose from Library (if available)
                        let randomPoseUsed = false;
                        if (this.libraryPoses && this.libraryPoses.length > 0) {
                            const randIdx = Math.floor(Math.random() * this.libraryPoses.length);
                            const poseItem = this.libraryPoses[randIdx];

                            if (poseItem.data) {
                                this.viewer.setPose(poseItem.data);
                                randomPoseUsed = true;
                            }
                        } else {
                            // No library poses available for random selection.
                        }

                        if (!randomPoseUsed) {
                            this.viewer.resetPose();
                        }

                        // Apply Random Model Rotation (Y) - preserve X/Z from pose
                        const currentRot = this.viewer.modelRotation;
                        this.viewer.setModelRotation(currentRot.x, debugParams.modelYRotation, currentRot.z);

                        // Apply debug lighting
                        if (debugParams.lights) {
                            this.viewer.updateLights(debugParams.lights);
                        }

                        // Capture with random camera and background
                        this.poseCaptures[i] = this.viewer.capture(w, h, debugParams.zoom, debugParams.bgColor, debugParams.offsetX, debugParams.offsetY);

                        // Generate prompt from the lights actually used (debug or original)
                        const lightsUsed = debugParams.lights || originalLights;
                        this.lightingPrompts[i] = this.generatePromptFromLights(lightsUsed);
                    } else {
                        // Normal mode
                        this.viewer.setPose(this.poses[i]);
                        const z = this.exportParams.cam_zoom || 1.0;
                        const oX = this.exportParams.cam_offset_x || 0;
                        const oY = this.exportParams.cam_offset_y || 0;
                        this.poseCaptures[i] = this.viewer.capture(w, h, z, bg, oX, oY);

                        // Generate prompt from current global lights
                        this.lightingPrompts[i] = this.generatePromptFromLights(this.lightParams);
                    }
                }

                // Restore original state
                if (isDebug && !this.exportParams.debugNoLight) {
                    this.viewer.updateLights(originalLights);
                }
                this.activeTab = originalTab;
                this.viewer.setPose(this.poses[this.activeTab]);

            } else {
                // Capture only ACTIVE
                if (isDebug) {
                    const debugParams = this.generateDebugParams();

                    // Reset to default pose, apply random Y rotation
                    this.viewer.resetPose();
                    this.viewer.setModelRotation(0, debugParams.modelYRotation, 0);

                    // Apply debug lighting
                    const originalLights = [...this.lightParams];
                    if (debugParams.lights) {
                        this.viewer.updateLights(debugParams.lights);
                    }

                    // Capture with random camera and background
                    this.poseCaptures[this.activeTab] = this.viewer.capture(w, h, debugParams.zoom, debugParams.bgColor, debugParams.offsetX, debugParams.offsetY);

                    // Generate prompt
                    const lightsUsed = debugParams.lights || originalLights;
                    this.lightingPrompts[this.activeTab] = this.generatePromptFromLights(lightsUsed);

                    // Restore lighting
                    if (debugParams.lights) {
                        this.viewer.updateLights(originalLights);
                    }

                    // Restore original pose
                    this.viewer.setPose(this.poses[this.activeTab]);
                } else {
                    const z = this.exportParams.cam_zoom || 1.0;
                    const oX = this.exportParams.cam_offset_x || 0;
                    const oY = this.exportParams.cam_offset_y || 0;
                    this.poseCaptures[this.activeTab] = this.viewer.capture(w, h, z, bg, oX, oY);

                    // Generate prompt from current global lights
                    this.lightingPrompts[this.activeTab] = this.generatePromptFromLights(this.lightParams);
                }
            }
        }

        // Update hidden pose_data widget
        const data = {
            mesh: this.meshParams,
            export: this.exportParams,
            poses: this.poses,
            lights: this.lightParams,
            activeTab: this.activeTab,
            captured_images: this.poseCaptures,
            lighting_prompts: this.lightingPrompts
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

                // Sync Head Scale
                if (this.viewer && this.meshParams.head_size !== undefined) {
                    this.viewer.updateHeadScale(this.meshParams.head_size);
                }
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
                        if (widget.update) {
                            widget.update(this.exportParams[key]);
                        } else {
                            widget.value = this.exportParams[key];
                        }
                    }
                }
            }

            if (data.poses && Array.isArray(data.poses)) {
                this.poses = data.poses;
            }

            if (data.lights && Array.isArray(data.lights)) {
                this.lightParams = data.lights;
                this.refreshLightUI();
                if (this.viewer) {
                    this.viewer.updateLights(this.lightParams);
                }
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

    setup() {
        api.addEventListener("vnccs_req_debug_capture", async (event) => {
            const nodeId = event.detail.node_id;
            const node = app.graph.getNodeById(nodeId);
            if (node && node.studioWidget && node.studioWidget.exportParams.debugMode) {
                try {
                    // 1. Force Randomize & Render
                    node.studioWidget.syncToNode(true);

                    // 2. Retrieve data
                    const poseWidget = node.widgets.find(w => w.name === "pose_data");
                    if (poseWidget) {
                        const data = JSON.parse(poseWidget.value);
                        data.node_id = nodeId;

                        // 3. Upload
                        await fetch('/vnccs/debug/upload_capture', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(data)
                        });
                    }
                } catch (e) {
                    console.error("[VNCCS] Batch Sync Error:", e);
                }
            }
        });
    },

    async beforeRegisterNodeDef(nodeType, nodeData, _app) {
        if (nodeData.name !== "VNCCS_PoseStudio") return;

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onCreated) onCreated.apply(this, arguments);

            this.setSize([900, 740]);

            // Create widget
            this.studioWidget = new PoseStudioWidget(this);

            this.addDOMWidget("pose_studio_ui", "ui", this.studioWidget.container, {
                serialize: false,
                hideOnZoom: false
            });

            // Pre-load library for random functionality
            setTimeout(() => {
                if (this.studioWidget) this.studioWidget.refreshLibrary();
            }, 1000);

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
                            this.studioWidget.exportParams.cam_zoom || 1.0,
                            this.studioWidget.exportParams.cam_offset_x || 0,
                            this.studioWidget.exportParams.cam_offset_y || 0
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
                const h = Math.max(400, (size[1] - 70) / zoomFactor); // Adjusted for new output slot
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
                    this.studioWidget.refreshLibrary(); // Pre-load library for debug
                }, 200);
            }
        };

        // Re-capture with fresh random params on each execution when Debug Mode is enabled
        const onExecutionStart = nodeType.prototype.onExecutionStart;
        nodeType.prototype.onExecutionStart = function () {
            if (onExecutionStart) onExecutionStart.apply(this, arguments);

            if (this.studioWidget && this.studioWidget.exportParams.debugMode) {
                // Force a fresh full capture with new random params
                this.studioWidget.syncToNode(true);
            }
        };
    }
});
