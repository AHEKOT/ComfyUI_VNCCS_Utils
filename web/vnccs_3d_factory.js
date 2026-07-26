import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { installCustomSelects } from "./vnccs_custom_select.mjs";
import { Factory3DViewer } from "./vnccs_3d_factory_viewer.js?v=20260726.17";


const VNCCS_DONATE_BANNER_URL = new URL("./assets/VNCCS_Donate_Button.png", import.meta.url).href;
const API_BASE = "/vnccs/3d-factory";
const LIBRARY_BASE = `${API_BASE}/library`;
const GAUSSIAN_LIBRARY_SCHEMA = "vnccs-3d-factory-library/v1";
const ENDPOINTS = Object.freeze({
    capabilities: `${API_BASE}/capabilities`,
    splatCache: `${API_BASE}/splat-cache`,
    splatCacheSettings: `${API_BASE}/splat-cache/settings`,
    splatCacheClear: `${API_BASE}/splat-cache/clear`,
    weightsDownload: `${API_BASE}/weights/download`,
    scenes: `${API_BASE}/scenes`,
    scene: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}`,
    reference: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/reference`,
    skydome: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/skydome`,
    preview: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/preview`,
    captureSet: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/capture-set`,
    previewError: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/preview/error`,
    generate: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/generate`,
    importObject: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/objects/import`,
    exportScene: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/export`,
    job: jobId => `${API_BASE}/jobs/${encodeURIComponent(jobId)}`,
    cancelJob: jobId => `${API_BASE}/jobs/${encodeURIComponent(jobId)}/cancel`,
    jobLog: jobId => `${API_BASE}/jobs/${encodeURIComponent(jobId)}/log`,
    libraryItems: `${LIBRARY_BASE}/items`,
    libraryItem: assetId => `${LIBRARY_BASE}/items/${encodeURIComponent(assetId)}`,
    libraryLoad: assetId => `${LIBRARY_BASE}/items/${encodeURIComponent(assetId)}/load`,
    libraryRepositories: `${LIBRARY_BASE}/repositories`,
    libraryRepositoryAdd: `${LIBRARY_BASE}/repositories/add`,
    libraryRepositoryToggle: `${LIBRARY_BASE}/repositories/toggle`,
    libraryRepositoryRefresh: `${LIBRARY_BASE}/repositories/refresh`,
    libraryRepositoryAutoRefresh: `${LIBRARY_BASE}/repositories/auto_refresh`,
    libraryRepositoryPublish: `${LIBRARY_BASE}/repositories/publish`,
    libraryRepositoryProgress: taskId => `${LIBRARY_BASE}/repositories/progress/${encodeURIComponent(taskId)}`,
});
const DEFAULT_NODE_SIZE = Object.freeze([1100, 760]);
const STATE_VERSION = 10;
const FRONTEND_BUILD = "20260726.3";
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_PLY_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SKYDOME_BYTES = 64 * 1024 * 1024;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const DEFAULT_SETTINGS = Object.freeze({
    name: "",
    steps: 20,
    guidance_scale: 3,
    num_gaussians: 131072,
    conditioning_resolution: 1024,
    prevent_upscale: false,
    remove_background: true,
    splat_cache_limit_gb: 32,
    seed: 0,
    seed_mode: "randomize",
});
const DEFAULT_EXPORT_SETTINGS = Object.freeze({
    width: 1024,
    height: 1024,
    aspect: "1:1",
    show_camera_frame: false,
});
const DEFAULT_LIGHTING = Object.freeze({
    preset: "day",
    intensity: 0.72,
    color: "#fff1d6",
    azimuth: 325,
    elevation: 42,
    ambient: 0.5,
    background: "#171b25",
});
const DEFAULT_SKYDOME = Object.freeze({
    visible: true,
    yaw: 0,
    pitch: 0,
    roll: 0,
    exposure: 0,
    blur: 0,
});
const LIGHTING_PRESETS = Object.freeze({
    off: Object.freeze({
        label: "Off",
        intensity: 0,
        color: "#ffffff",
        azimuth: 325,
        elevation: 42,
        ambient: 1,
        background: "#171b25",
    }),
    day: Object.freeze({
        label: "Day",
        intensity: 0.72,
        color: "#fff1d6",
        azimuth: 325,
        elevation: 42,
        ambient: 0.5,
        background: "#171b25",
    }),
    night: Object.freeze({
        label: "Night",
        intensity: 0.64,
        color: "#8eaaff",
        azimuth: 38,
        elevation: 24,
        ambient: 0.22,
        background: "#090d1a",
    }),
    dawn: Object.freeze({
        label: "Dawn",
        intensity: 0.76,
        color: "#ffb38d",
        azimuth: 302,
        elevation: 14,
        ambient: 0.34,
        background: "#211722",
    }),
    sunset: Object.freeze({
        label: "Sunset",
        intensity: 0.84,
        color: "#ff865f",
        azimuth: 58,
        elevation: 11,
        ambient: 0.28,
        background: "#25141b",
    }),
});
const ASPECT_RATIOS = Object.freeze({
    "1:1": 1,
    "4:3": 4 / 3,
    "3:4": 3 / 4,
    "3:2": 3 / 2,
    "2:3": 2 / 3,
    "16:9": 16 / 9,
    "9:16": 9 / 16,
    "21:9": 21 / 9,
});
const ICONS = Object.freeze({
    cube: `<svg viewBox="0 0 24 24"><path d="m12 2 8 4.5v9L12 20l-8-4.5v-9L12 2Z"/><path d="m4.4 6.7 7.6 4.2 7.6-4.2M12 11v9"/></svg>`,
    upload: `<svg viewBox="0 0 24 24"><path d="M12 16V4m0 0 4.5 4.5M12 4 7.5 8.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></svg>`,
    play: `<svg viewBox="0 0 24 24"><path d="m8 5 11 7-11 7V5Z"/></svg>`,
    fit: `<svg viewBox="0 0 24 24"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5m13 5h5v-5"/></svg>`,
    move: `<svg viewBox="0 0 24 24"><path d="M12 2v20m0-20-3 3m3-3 3 3M2 12h20M2 12l3-3m-3 3 3 3m17-3-3-3m3 3-3 3"/></svg>`,
    rotate: `<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 6M20 4v7h-7"/></svg>`,
    scale: `<svg viewBox="0 0 24 24"><path d="M4 10V4h6M20 14v6h-6M4 4l6 6m10 10-6-6"/></svg>`,
    grid: `<svg viewBox="0 0 24 24"><path d="M4 5h16M3 10h18M2 15h20M1 20h22M7 3 5 21m6-18-1 18m7-18 2 18m-6-18 1 18"/></svg>`,
    sun: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9 7 7m10 10 2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/></svg>`,
    image: `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 3.5 3.5 2.5-2.5 5 5"/></svg>`,
    stop: `<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`,
    search: `<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>`,
    settings: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-2.91 1.22V21h-4v-.08A1.7 1.7 0 0 0 7.1 19.7l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.3 7.1l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 10 3.08V3h4v.08a1.7 1.7 0 0 0 2.9 1.2l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z"/></svg>`,
    download: `<svg viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16"/></svg>`,
    trash: `<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7m4 4v6m4-6v6"/></svg>`,
    close: `<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>`,
    check: `<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>`,
    warning: `<svg viewBox="0 0 24 24"><path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5m0 3v.01"/></svg>`,
    scenes: `<svg viewBox="0 0 24 24"><path d="M4 6h16v12H4zM7 3h10M7 21h10"/></svg>`,
    library: `<svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v17H6.5A2.5 2.5 0 0 0 4 22V5.5ZM20 5.5A2.5 2.5 0 0 0 17.5 3H13v17h4.5A2.5 2.5 0 0 1 20 22V5.5Z"/></svg>`,
    duplicate: `<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>`,
    eye: `<svg viewBox="0 0 24 24"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>`,
    eyeOff: `<svg viewBox="0 0 24 24"><path d="m3 3 18 18M10.6 6.2A10.8 10.8 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-2.2 2.8M6.4 6.5C3.9 8.3 2.5 12 2.5 12s3.5 6 9.5 6c1.4 0 2.7-.3 3.8-.8M9.9 9.8a3 3 0 0 0 4.2 4.3"/></svg>`,
    folder: `<svg viewBox="0 0 24 24"><path d="M3 6h7l2 2h9v10H3V6Z"/></svg>`,
    ungroup: `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="8" height="8" rx="1"/><rect x="13" y="11" width="8" height="8" rx="1"/><path d="M8 16H5v-3m11-5h3v3"/></svg>`,
    chevron: `<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>`,
    dice: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="8.5" cy="8.5" r="1.4" class="fill"/><circle cx="15.5" cy="8.5" r="1.4" class="fill"/><circle cx="12" cy="12" r="1.4" class="fill"/><circle cx="8.5" cy="15.5" r="1.4" class="fill"/><circle cx="15.5" cy="15.5" r="1.4" class="fill"/></svg>`,
    camera: `<svg viewBox="0 0 24 24"><path d="M4 7.5h3l1.4-2h7.2l1.4 2h3v11H4v-11Z"/><circle cx="12" cy="13" r="3.5"/></svg>`,
    cameraAdd: `<svg viewBox="0 0 24 24"><path d="M3 8h3l1.5-2h7L16 8h2v4"/><path d="M12 19H3V8m16 7v6m-3-3h6"/><circle cx="10" cy="13" r="3"/></svg>`,
    rollLeft: `<svg viewBox="0 0 24 24"><path d="M5 8v5h5"/><path d="M6 13a7 7 0 1 0 2-7"/></svg>`,
    rollRight: `<svg viewBox="0 0 24 24"><path d="M19 8v5h-5"/><path d="M18 13a7 7 0 1 1-2-7"/></svg>`,
});


function installStyles() {
    if (document.getElementById("vnccs-3d-factory-styles")) return;
    const link = document.createElement("link");
    link.id = "vnccs-3d-factory-styles";
    link.rel = "stylesheet";
    link.href = new URL("./vnccs_3d_factory.css?v=20260726.2", import.meta.url).href;
    document.head.appendChild(link);
}

function element(tag, className = "", text = "") {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text) value.textContent = text;
    return value;
}

function escapeHTML(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function button(className, label = "", icon = "") {
    const value = element("button", className);
    value.type = "button";
    if (icon && ICONS[icon]) {
        const holder = element("span");
        holder.innerHTML = ICONS[icon];
        value.appendChild(holder);
    }
    if (label) value.appendChild(element("span", "", label));
    return value;
}

function apiUrl(path) {
    if (typeof api.apiURL === "function") return api.apiURL(path);
    return `/api${path.startsWith("/") ? path : `/${path}`}`;
}

function clamp(value, minimum, maximum) {
    const number = Number(value);
    return Math.min(maximum, Math.max(minimum, Number.isFinite(number) ? number : minimum));
}

function formatBytes(value) {
    const size = Number(value) || 0;
    if (!size) return "missing";
    if (size < 1024 ** 2) return `${Math.round(size / 1024)} KB`;
    if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
    return `${(size / 1024 ** 3).toFixed(2)} GB`;
}

function formatCacheBytes(value) {
    return Number(value) > 0 ? formatBytes(value) : "0 B";
}

function errorText(error, fallback = "The operation could not be completed.") {
    if (error instanceof Error) return error.message || fallback;
    if (typeof error === "string") return error || fallback;
    try { return JSON.stringify(error, null, 2); } catch (_) { return fallback; }
}

function safeObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function numericArraysEqual(left, right, epsilon = 1e-6) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
        return false;
    }
    return left.every((value, index) => (
        Number.isFinite(Number(value))
        && Math.abs(Number(value) - Number(right[index])) <= epsilon
    ));
}

function cameraStatesEqual(left = {}, right = {}) {
    return numericArraysEqual(left.position, right.position)
        && numericArraysEqual(left.target, right.target)
        && numericArraysEqual(left.up || [0, 1, 0], right.up || [0, 1, 0])
        && Math.abs(Number(left.fov || 0) - Number(right.fov || 0)) <= 1e-6;
}

function objectNameFromFileName(value) {
    const raw = String(value || "").replace(/\\/g, "/").split("/").pop() || "";
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch (_) {}
    const stem = decoded.replace(/\.(?:png|jpe?g|webp|avif|gif|bmp|tiff?)$/i, "");
    return stem
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, 80)
        || "Object";
}

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function randomLayerId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

function generateRandomSeed() {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return values[0] & 0x7fffffff;
}

function download(url) {
    const link = document.createElement("a");
    link.href = apiUrl(url);
    link.rel = "noopener";
    link.download = "";
    document.body.appendChild(link);
    link.click();
    link.remove();
}

function downloadBlob(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.rel = "noopener";
    link.download = filename || "vnccs-3d-factory-export";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("Could not read preview image"));
        reader.readAsDataURL(blob);
    });
}


class Factory3DWidget {
    constructor(node) {
        installStyles();
        if (window.__vnccs3DFactoryBuild !== FRONTEND_BUILD) {
            window.__vnccs3DFactoryBuild = FRONTEND_BUILD;
            console.info(`[VNCCS 3D Factory] Frontend build ${FRONTEND_BUILD}`);
        }
        this.node = node;
        this.destroyed = false;
        this.sceneId = "";
        this.scene = null;
        this.sourceFile = null;
        this.sourceURL = "";
        this.sourceAsset = null;
        this.selectedObjectId = "";
        this.selectedObjectIds = new Set();
        this.selectedGroupId = "";
        this.selectedSkydome = false;
        this.selectedCameraId = "";
        this._cameraReturnState = null;
        this._cameraSelectionTransition = false;
        this._cameraPadPointer = null;
        this.collapsedGroupIds = new Set();
        this.dragLayer = null;
        this.viewportFailures = new Map();
        this.settings = { ...DEFAULT_SETTINGS };
        this.exportSettings = { ...DEFAULT_EXPORT_SETTINGS };
        this.lighting = { ...DEFAULT_LIGHTING };
        this.viewerState = { mode: "translate", grid: false };
        this.capabilities = null;
        this.currentJobId = "";
        this.currentJobToken = 0;
        this.importingPly = false;
        this._listeners = [];
        this._timers = new Set();
        this._saveTimer = 0;
        this._sceneSaveTimer = 0;
        this._previewSaveTimer = 0;
        this._previewIdleHandle = 0;
        this._lightingApplyTimer = 0;
        this._searchRenderFrame = 0;
        this._sceneSaveSerial = Promise.resolve();
        this._previewSaveSerial = Promise.resolve();
        this._restoreSerial = Promise.resolve();
        this._resizeFrame = 0;
        this._uiScaleValue = "";
        this._modalCleanup = null;
        this._previousFocus = null;
        this.skipSceneDeleteConfirmation = false;
        this.libraryItems = [];
        this.libraryQuery = "";
        this.libraryActiveCategory = "All";
        this.librarySelectedId = "";
        this.libraryThumbSizeStorageKey = "vnccs3DFactoryLibraryPreviewSize";
        this.libraryThumbSize = this.loadLibraryThumbnailSize();
        this.librarySettingsMode = false;
        this.libraryModal = null;
        this.libraryGrid = null;
        this.libraryInspector = null;
        this.libraryWorkspace = null;
        this.libraryResizeObserver = null;
        this._libraryAutoRefreshStarted = false;
        this._suppressViewerStatePersistence = false;
        // Keep callbacks read-only until the serialized ComfyUI widget state has
        // been applied. Viewer setup emits state changes during construction.
        this._isRestoring = true;
        this._createLayout();
        this._cache();
        this._bind();
        this.viewer = new Factory3DViewer(this.els.viewerHost, {
            onSelectionChange: (id, options) => this._selectObject(id, {
                fromViewer: true,
                additive: Boolean(options?.additive),
            }),
            onTransformChange: (id, transform, options) => this._onViewerTransform(id, transform, options),
            onStateChange: state => {
                const previousState = this.viewerState;
                const cameraChanged = !cameraStatesEqual(
                    previousState.camera || {},
                    state.camera || {},
                );
                const toolbarChanged = previousState.mode !== state.mode
                    || previousState.grid !== state.grid;
                this.viewerState = { ...this.viewerState, ...state };
                if (toolbarChanged) this._syncToolbar();
                this._scheduleStateSave();
                if (
                    cameraChanged
                    && !this._isRestoring
                    && !this._suppressViewerStatePersistence
                    && !this.selectedCameraId
                    && this.scene
                ) {
                    this.scene.camera = { ...state.camera };
                    this._scheduleSceneSave(220);
                    this._scheduleScenePreview(1000);
                }
            },
            onLoadingChange: loading => this.els.viewerHost.classList.toggle("is-loading", loading),
            onError: error => this._showError("Viewport error", error),
            resolveAssetURL: apiUrl,
        });
        this._customSelects = installCustomSelects(this.container, { theme: "pose-studio" });
        this._resizeObserver = new ResizeObserver(() => this.resize());
        this._resizeObserver.observe(this.container);
        this._navigationCleanup = enableCanvasNavigationForwarding(this.container);
        this._renderObjects();
        this._renderCameras();
        this._syncSettings();
        this._syncExportSettings();
        this._syncLighting();
        this._syncSkydome();
        this._setStatus("Ready", "idle");
    }

    _createLayout() {
        const root = element("div", "vnccs-i3s");
        root.style.containerType = "inline-size";
        root.setAttribute("aria-label", "VNCCS 3D Factory");
        root.innerHTML = `
            <aside class="vnccs-i3s__side vnccs-i3s__side--left" aria-label="Reference and generation settings">
                <section class="vnccs-i3s__section">
                    <div class="vnccs-i3s__section-head"><span>Reference</span></div>
                    <div class="vnccs-i3s__section-body">
                        <div class="vnccs-i3s__dropzone" role="button" tabindex="0">
                            <input class="vnccs-i3s__file-input vnccs-i3s__source-input" type="file" accept="image/png,image/jpeg,image/webp" tabindex="-1" />
                            <div class="vnccs-i3s__drop-empty">
                                <span class="vnccs-i3s__drop-icon">${ICONS.upload}</span>
                                <span class="vnccs-i3s__drop-title">Drop a reference image</span>
                                <span class="vnccs-i3s__drop-meta">PNG, JPEG or WebP · up to 32 MB</span>
                            </div>
                            <img class="vnccs-i3s__source-preview" alt="Selected reference" decoding="async" />
                            <div class="vnccs-i3s__source-overlay">
                                <span class="vnccs-i3s__source-name"></span>
                                <button class="vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__source-change" type="button">Replace</button>
                            </div>
                        </div>
                    </div>
                </section>
                <section class="vnccs-i3s__section">
                    <div class="vnccs-i3s__section-head"><span>TripoSplat</span></div>
                    <div class="vnccs-i3s__section-body">
                        <div class="vnccs-i3s__provider-card">
                            <span class="vnccs-i3s__provider-dot vnccs-i3s__weights-dot"></span>
                            <div class="vnccs-i3s__provider-copy">
                                <div class="vnccs-i3s__provider-name">Official model</div>
                                <div class="vnccs-i3s__provider-model vnccs-i3s__weights-summary">Checking weights…</div>
                            </div>
                            <button class="vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__icon-button vnccs-i3s__model-setup" type="button" title="Model setup">${ICONS.settings}</button>
                        </div>
                        <label class="vnccs-i3s__field">
                            <span class="vnccs-i3s__label">Object name</span>
                            <input class="vnccs-i3s__input vnccs-i3s__object-name-input" maxlength="80" placeholder="Generated object" />
                        </label>
                        <div class="vnccs-i3s__field-row">
                            <label class="vnccs-i3s__field">
                                <span class="vnccs-i3s__label">Gaussians</span>
                                <select class="vnccs-i3s__select vnccs-i3s__density">
                                    <option value="32768">32K · Draft</option>
                                    <option value="65536">65K · Fast</option>
                                    <option value="131072">131K · Quality</option>
                                    <option value="262144">262K · Maximum</option>
                                    <option value="524288">524K · Experimental</option>
                                    <option value="1048576">1.05M · Extreme</option>
                                </select>
                            </label>
                            <label class="vnccs-i3s__field">
                                <span class="vnccs-i3s__label">Steps</span>
                                <input class="vnccs-i3s__input vnccs-i3s__steps" type="number" min="1" max="100" step="1" />
                            </label>
                        </div>
                        <div class="vnccs-i3s__density-note" hidden>
                            Experimental 2× density. Requires substantially more VRAM and decode time.
                        </div>
                        <label class="vnccs-i3s__field">
                            <span class="vnccs-i3s__label"><span>Guidance</span><span class="vnccs-i3s__guidance-value">3.0</span></span>
                            <input class="vnccs-i3s__range vnccs-i3s__guidance" type="range" min="1" max="10" step=".1" />
                        </label>
                        <div class="vnccs-i3s__switch-row vnccs-i3s__background-row">
                            <span class="vnccs-i3s__background-title">Remove background</span>
                            <button class="vnccs-i3s__switch vnccs-i3s__remove-background" type="button" role="switch" aria-checked="true" aria-label="Remove image background"></button>
                        </div>
                        <label class="vnccs-i3s__field">
                            <span class="vnccs-i3s__label">Seed</span>
                            <span class="vnccs-i3s__seed-row">
                                <input class="vnccs-i3s__input vnccs-i3s__seed" type="number" min="0" max="2147483647" step="1" />
                                <button class="vnccs-i3s__button vnccs-i3s__seed-dice" type="button" title="Random seed" aria-label="Toggle random seed" aria-pressed="true">${ICONS.dice}</button>
                            </span>
                        </label>
                        <button class="vnccs-i3s__button vnccs-i3s__button--primary vnccs-i3s__button--block vnccs-i3s__generate" type="button">${ICONS.play}<span>Generate object</span></button>
                    </div>
                </section>
                <section class="vnccs-i3s__section vnccs-i3s__camera-section">
                    <div class="vnccs-i3s__section-head">
                        <span>Camera</span>
                        <span class="vnccs-i3s__camera-count">0</span>
                    </div>
                    <div class="vnccs-i3s__section-body">
                        <div class="vnccs-i3s__camera-look" role="slider" tabindex="0"
                            aria-label="First-person camera look control"
                            aria-valuetext="Drag to look left, right, up or down">
                            <span class="vnccs-i3s__camera-look-axis vnccs-i3s__camera-look-axis--x"></span>
                            <span class="vnccs-i3s__camera-look-axis vnccs-i3s__camera-look-axis--y"></span>
                            <span class="vnccs-i3s__camera-look-arrow vnccs-i3s__camera-look-arrow--up">⌃</span>
                            <span class="vnccs-i3s__camera-look-arrow vnccs-i3s__camera-look-arrow--right">›</span>
                            <span class="vnccs-i3s__camera-look-arrow vnccs-i3s__camera-look-arrow--down">⌄</span>
                            <span class="vnccs-i3s__camera-look-arrow vnccs-i3s__camera-look-arrow--left">‹</span>
                            <span class="vnccs-i3s__camera-look-reticle" aria-hidden="true"></span>
                        </div>
                        <div class="vnccs-i3s__camera-roll" title="Camera roll">
                            <span class="vnccs-i3s__camera-roll-icon">${ICONS.rollLeft}</span>
                            <input class="vnccs-i3s__range vnccs-i3s__camera-roll-range"
                                type="range" min="-30" max="30" step=".25" value="0"
                                aria-label="Roll camera" />
                            <span class="vnccs-i3s__camera-roll-icon">${ICONS.rollRight}</span>
                        </div>
                        <div class="vnccs-i3s__camera-help">Drag to look · slider to roll</div>
                        <button class="vnccs-i3s__button vnccs-i3s__button--primary vnccs-i3s__button--block vnccs-i3s__camera-add" type="button">
                            ${ICONS.cameraAdd}<span>Add camera</span>
                        </button>
                        <div class="vnccs-i3s__camera-manager" aria-label="Saved cameras">
                            <div class="vnccs-i3s__camera-group-head">
                                <span>${ICONS.camera}</span>
                                <strong>Cameras</strong>
                                <span class="vnccs-i3s__camera-group-count">0</span>
                            </div>
                            <div class="vnccs-i3s__camera-list"></div>
                        </div>
                    </div>
                </section>
                <a class="vnccs-i3s__donate-link" href="https://www.buymeacoffee.com/MIUProject" target="_blank" rel="noopener noreferrer" title="Support MIUProject">
                    <img src="${VNCCS_DONATE_BANNER_URL}" alt="Support MIUProject" width="1859" height="525" decoding="async" />
                </a>
            </aside>
            <main class="vnccs-i3s__center">
                <header class="vnccs-i3s__topbar">
                    <div class="vnccs-i3s__crumb">
                        <span class="vnccs-i3s__crumb-icon">${ICONS.cube}</span>
                        <input class="vnccs-i3s__scene-name-input" value="Untitled scene" maxlength="96" aria-label="Scene name" />
                        <span class="vnccs-i3s__project-id"></span>
                    </div>
                    <div class="vnccs-i3s__status-group">
                        <button class="vnccs-i3s__button vnccs-i3s__top-action vnccs-i3s__scene-manager" type="button">${ICONS.scenes}<span>Scenes</span></button>
                        <div class="vnccs-i3s__status-pill" data-tone="idle">Ready</div>
                    </div>
                </header>
                <div class="vnccs-i3s__viewport">
                    <div class="vnccs-i3s__viewer-host" aria-label="Gaussian scene viewport"></div>
                    <div class="vnccs-i3s__empty-view">
                        <div class="vnccs-i3s__empty-view-icon">${ICONS.cube}</div>
                        <div class="vnccs-i3s__empty-view-title">Your scene will appear here</div>
                        <div>Load a reference and generate the first Gaussian object.</div>
                    </div>
                    <div class="vnccs-i3s__toolbar" role="toolbar">
                        <button class="vnccs-i3s__tool vnccs-i3s__fit" type="button" title="Fit scene">${ICONS.fit}</button>
                        <span class="vnccs-i3s__tool-separator"></span>
                        <button class="vnccs-i3s__tool vnccs-i3s__mode-move" type="button" title="Move" aria-pressed="true">${ICONS.move}</button>
                        <button class="vnccs-i3s__tool vnccs-i3s__mode-rotate" type="button" title="Rotate" aria-pressed="false">${ICONS.rotate}</button>
                        <button class="vnccs-i3s__tool vnccs-i3s__mode-scale" type="button" title="Scale uniformly" aria-pressed="false">${ICONS.scale}</button>
                        <span class="vnccs-i3s__tool-separator"></span>
                        <button class="vnccs-i3s__tool vnccs-i3s__skydome-open" type="button" title="Skydome" aria-pressed="false">${ICONS.image}</button>
                        <button class="vnccs-i3s__tool vnccs-i3s__lighting-open" type="button" title="Scene lighting" aria-pressed="false">${ICONS.sun}</button>
                        <button class="vnccs-i3s__tool vnccs-i3s__grid" type="button" title="Grid" aria-pressed="false">${ICONS.grid}</button>
                    </div>
                    <section class="vnccs-i3s__skydome-panel" aria-label="Skydome controls" hidden>
                        <div class="vnccs-i3s__lighting-head">
                            <div>
                                <div class="vnccs-i3s__lighting-title">Skydome</div>
                                <div class="vnccs-i3s__lighting-subtitle">Equirectangular environment background</div>
                            </div>
                            <button class="vnccs-i3s__skydome-close vnccs-i3s__lighting-close" type="button" title="Close skydome controls">${ICONS.close}</button>
                        </div>
                        <input class="vnccs-i3s__skydome-input" type="file" accept="image/jpeg,image/png,image/webp" hidden />
                        <div class="vnccs-i3s__skydome-source">
                            <div class="vnccs-i3s__skydome-preview">${ICONS.image}</div>
                            <div class="vnccs-i3s__skydome-source-copy">
                                <b class="vnccs-i3s__skydome-name">No skydome loaded</b>
                                <span class="vnccs-i3s__skydome-meta">JPEG, PNG or WebP · equirectangular</span>
                            </div>
                            <button class="vnccs-i3s__button vnccs-i3s__button--primary vnccs-i3s__skydome-upload" type="button">${ICONS.upload}<span>Load</span></button>
                        </div>
                        <div class="vnccs-i3s__skydome-settings" hidden>
                            <div class="vnccs-i3s__switch-row vnccs-i3s__skydome-visible-row">
                                <div>
                                    <div class="vnccs-i3s__scene-frame-title">Visible in background</div>
                                    <div class="vnccs-i3s__scene-frame-copy">Keeps the skydome available without rendering it.</div>
                                </div>
                                <button class="vnccs-i3s__switch vnccs-i3s__skydome-visible" type="button" role="switch" aria-checked="true" aria-label="Show skydome"></button>
                            </div>
                            <label class="vnccs-i3s__lighting-control">
                                <span><b>Horizontal rotation</b><output class="vnccs-i3s__skydome-yaw-value">0°</output></span>
                                <input class="vnccs-i3s__range vnccs-i3s__skydome-yaw" type="range" min="-180" max="180" step="1" value="0" />
                            </label>
                            <div class="vnccs-i3s__skydome-angle-grid">
                                <label class="vnccs-i3s__lighting-control">
                                    <span><b>Horizon tilt</b><output class="vnccs-i3s__skydome-pitch-value">0°</output></span>
                                    <input class="vnccs-i3s__range vnccs-i3s__skydome-pitch" type="range" min="-90" max="90" step="1" value="0" />
                                </label>
                                <label class="vnccs-i3s__lighting-control">
                                    <span><b>Horizon roll</b><output class="vnccs-i3s__skydome-roll-value">0°</output></span>
                                    <input class="vnccs-i3s__range vnccs-i3s__skydome-roll" type="range" min="-180" max="180" step="1" value="0" />
                                </label>
                            </div>
                            <label class="vnccs-i3s__lighting-control">
                                <span><b>Exposure</b><output class="vnccs-i3s__skydome-exposure-value">0.0 EV</output></span>
                                <input class="vnccs-i3s__range vnccs-i3s__skydome-exposure" type="range" min="-4" max="4" step="0.1" value="0" />
                            </label>
                            <label class="vnccs-i3s__lighting-control">
                                <span><b>Background blur</b><output class="vnccs-i3s__skydome-blur-value">0%</output></span>
                                <input class="vnccs-i3s__range vnccs-i3s__skydome-blur" type="range" min="0" max="1" step="0.01" value="0" />
                            </label>
                            <div class="vnccs-i3s__skydome-actions">
                                <button class="vnccs-i3s__button vnccs-i3s__skydome-level" type="button">Level horizon</button>
                                <button class="vnccs-i3s__button vnccs-i3s__skydome-reset" type="button">Reset alignment</button>
                                <button class="vnccs-i3s__button vnccs-i3s__button--danger vnccs-i3s__skydome-remove" type="button">${ICONS.trash}<span>Remove</span></button>
                            </div>
                        </div>
                    </section>
                    <section class="vnccs-i3s__lighting-panel" aria-label="Scene lighting" hidden>
                        <div class="vnccs-i3s__lighting-head">
                            <div>
                                <div class="vnccs-i3s__lighting-title">Scene lighting</div>
                                <div class="vnccs-i3s__lighting-subtitle">Realtime Gaussian illumination</div>
                            </div>
                            <button class="vnccs-i3s__lighting-close" type="button" title="Close lighting">${ICONS.close}</button>
                        </div>
                        <div class="vnccs-i3s__lighting-presets" role="group" aria-label="Lighting presets">
                            ${Object.entries(LIGHTING_PRESETS).map(([key, preset]) => `
                                <button class="vnccs-i3s__lighting-preset" type="button" data-preset="${key}" aria-pressed="false">${preset.label}</button>
                            `).join("")}
                        </div>
                        <label class="vnccs-i3s__lighting-control">
                            <span><b>Strength</b><output class="vnccs-i3s__light-intensity-value">0.72</output></span>
                            <input class="vnccs-i3s__range vnccs-i3s__light-intensity" type="range" min="0" max="2.5" step="0.01" value="0.72" />
                        </label>
                        <label class="vnccs-i3s__lighting-color-row">
                            <span>
                                <b>Light color</b>
                                <small>Directional tint</small>
                            </span>
                            <span class="vnccs-i3s__lighting-color-control">
                                <input class="vnccs-i3s__light-color" type="color" value="#fff1d6" aria-label="Light color" />
                                <output class="vnccs-i3s__light-color-value">#FFF1D6</output>
                            </span>
                        </label>
                        <div class="vnccs-i3s__lighting-direction">
                            <div class="vnccs-i3s__lighting-direction-head">
                                <b>Direction</b>
                                <span><output class="vnccs-i3s__light-azimuth-value">325°</output> · <output class="vnccs-i3s__light-elevation-value">42°</output></span>
                            </div>
                            <div class="vnccs-i3s__lighting-radar-row">
                                <canvas class="vnccs-i3s__lighting-radar" width="144" height="144" aria-label="Light azimuth control"></canvas>
                                <label class="vnccs-i3s__lighting-elevation">
                                    <span>HIGH</span>
                                    <input class="vnccs-i3s__light-elevation" type="range" orient="vertical" min="-10" max="90" step="1" value="42" aria-label="Light elevation" />
                                    <span>LOW</span>
                                </label>
                            </div>
                        </div>
                    </section>
                    <div class="vnccs-i3s__viewport-help">Click: select · Shift-click: multi-select · Drag gizmo: transform · Drag empty space: orbit · W/E/R: move/rotate/scale · F: frame</div>
                    <div class="vnccs-i3s__progress">
                        <div class="vnccs-i3s__progress-copy">
                            <div class="vnccs-i3s__progress-head">
                                <span class="vnccs-i3s__progress-stage">Preparing</span>
                                <span class="vnccs-i3s__progress-percent">0%</span>
                            </div>
                            <div class="vnccs-i3s__progress-track"><div class="vnccs-i3s__progress-bar"></div></div>
                            <div class="vnccs-i3s__job-detail"></div>
                        </div>
                        <button class="vnccs-i3s__button vnccs-i3s__button--danger vnccs-i3s__cancel-job" type="button">${ICONS.stop}<span>Cancel</span></button>
                    </div>
                </div>
            </main>
            <aside class="vnccs-i3s__side vnccs-i3s__side--right" aria-label="Scene objects and export">
                <div class="vnccs-i3s__library-launcher-wrap">
                    <button class="vnccs-ps-btn primary vnccs-i3s__library-open" type="button">
                        <span class="vnccs-ps-btn-icon">📚</span> Model Library
                    </button>
                    <button class="vnccs-i3s__button vnccs-i3s__ply-import" type="button" title="Import a Gaussian PLY into the active scene">
                        ${ICONS.upload}<span>Import PLY</span>
                    </button>
                    <input class="vnccs-i3s__file-input vnccs-i3s__ply-input" type="file" accept=".ply,application/octet-stream" tabindex="-1" />
                </div>
                <section class="vnccs-i3s__section vnccs-i3s__object-section">
                    <div class="vnccs-i3s__section-head"><span>Scene objects</span><span class="vnccs-i3s__object-count">0</span></div>
                    <div class="vnccs-i3s__section-body">
                        <label class="vnccs-i3s__search">${ICONS.search}<input class="vnccs-i3s__input vnccs-i3s__object-search" type="search" placeholder="Filter objects" /></label>
                        <div class="vnccs-i3s__layer-tools">
                            <button class="vnccs-i3s__button vnccs-i3s__group-selected" type="button" disabled>${ICONS.folder}<span>Group</span></button>
                            <span class="vnccs-i3s__selection-count">Shift-click to select multiple</span>
                        </div>
                        <div class="vnccs-i3s__object-list"></div>
                    </div>
                </section>
                <section class="vnccs-i3s__section">
                    <div class="vnccs-i3s__section-head"><span>Scene export</span></div>
                    <div class="vnccs-i3s__section-body">
                        <div class="vnccs-i3s__hint vnccs-i3s__scene-summary">No objects in this scene.</div>
                        <div class="vnccs-i3s__scene-render-settings">
                            <label class="vnccs-i3s__field">
                                <span class="vnccs-i3s__label">Aspect ratio</span>
                                <select class="vnccs-i3s__select vnccs-i3s__scene-aspect">
                                    <option value="1:1">1:1 · Square</option>
                                    <option value="4:3">4:3 · Landscape</option>
                                    <option value="3:4">3:4 · Portrait</option>
                                    <option value="3:2">3:2 · Photo</option>
                                    <option value="2:3">2:3 · Portrait photo</option>
                                    <option value="16:9">16:9 · Widescreen</option>
                                    <option value="9:16">9:16 · Vertical</option>
                                    <option value="21:9">21:9 · Ultrawide</option>
                                    <option value="custom">Custom</option>
                                </select>
                            </label>
                            <div class="vnccs-i3s__scene-size-grid">
                                <label class="vnccs-i3s__field">
                                    <span class="vnccs-i3s__label">Width</span>
                                    <input class="vnccs-i3s__input vnccs-i3s__scene-width" type="number" min="64" max="4096" step="64" value="1024" />
                                </label>
                                <label class="vnccs-i3s__field">
                                    <span class="vnccs-i3s__label">Height</span>
                                    <input class="vnccs-i3s__input vnccs-i3s__scene-height" type="number" min="64" max="4096" step="64" value="1024" />
                                </label>
                            </div>
                            <div class="vnccs-i3s__switch-row">
                                <div>
                                    <div class="vnccs-i3s__scene-frame-title">Camera frame</div>
                                    <div class="vnccs-i3s__scene-frame-copy">Show the exact exported crop in the 3D editor.</div>
                                </div>
                                <button class="vnccs-i3s__switch vnccs-i3s__scene-frame" type="button" role="switch" aria-checked="false" aria-label="Show camera frame"></button>
                            </div>
                            <div class="vnccs-i3s__scene-render-summary">1024 × 1024 px · Camera follows the current 3D view</div>
                        </div>
                        <div class="vnccs-i3s__export-grid">
                            <button class="vnccs-i3s__button vnccs-i3s__scene-export" type="button">${ICONS.download}<span>Scene PLY</span></button>
                        </div>
                    </div>
                </section>
            </aside>
            <div class="vnccs-i3s__toasts" aria-live="polite"></div>
            <div class="vnccs-i3s__modal-layer"></div>
        `;
        this.container = root;
    }

    _cache() {
        const $ = selector => this.container.querySelector(selector);
        this.els = {
            sourceDrop: $(".vnccs-i3s__dropzone"),
            sourceInput: $(".vnccs-i3s__source-input"),
            sourcePreview: $(".vnccs-i3s__source-preview"),
            sourceName: $(".vnccs-i3s__source-name"),
            sourceChange: $(".vnccs-i3s__source-change"),
            weightsDot: $(".vnccs-i3s__weights-dot"),
            weightsSummary: $(".vnccs-i3s__weights-summary"),
            modelSetup: $(".vnccs-i3s__model-setup"),
            objectName: $(".vnccs-i3s__object-name-input"),
            density: $(".vnccs-i3s__density"),
            densityNote: $(".vnccs-i3s__density-note"),
            steps: $(".vnccs-i3s__steps"),
            guidance: $(".vnccs-i3s__guidance"),
            guidanceValue: $(".vnccs-i3s__guidance-value"),
            removeBackground: $(".vnccs-i3s__remove-background"),
            seed: $(".vnccs-i3s__seed"),
            seedDice: $(".vnccs-i3s__seed-dice"),
            generate: $(".vnccs-i3s__generate"),
            cameraLook: $(".vnccs-i3s__camera-look"),
            cameraReticle: $(".vnccs-i3s__camera-look-reticle"),
            cameraRoll: $(".vnccs-i3s__camera-roll-range"),
            cameraAdd: $(".vnccs-i3s__camera-add"),
            cameraCount: $(".vnccs-i3s__camera-count"),
            cameraGroupCount: $(".vnccs-i3s__camera-group-count"),
            cameraList: $(".vnccs-i3s__camera-list"),
            donateLink: $(".vnccs-i3s__donate-link"),
            sceneName: $(".vnccs-i3s__scene-name-input"),
            sceneId: $(".vnccs-i3s__project-id"),
            sceneManager: $(".vnccs-i3s__scene-manager"),
            libraryOpen: $(".vnccs-i3s__library-open"),
            plyImport: $(".vnccs-i3s__ply-import"),
            plyInput: $(".vnccs-i3s__ply-input"),
            status: $(".vnccs-i3s__status-pill"),
            viewerHost: $(".vnccs-i3s__viewer-host"),
            fit: $(".vnccs-i3s__fit"),
            modeMove: $(".vnccs-i3s__mode-move"),
            modeRotate: $(".vnccs-i3s__mode-rotate"),
            modeScale: $(".vnccs-i3s__mode-scale"),
            skydomeOpen: $(".vnccs-i3s__skydome-open"),
            skydomePanel: $(".vnccs-i3s__skydome-panel"),
            skydomeClose: $(".vnccs-i3s__skydome-close"),
            skydomeInput: $(".vnccs-i3s__skydome-input"),
            skydomeUpload: $(".vnccs-i3s__skydome-upload"),
            skydomePreview: $(".vnccs-i3s__skydome-preview"),
            skydomeName: $(".vnccs-i3s__skydome-name"),
            skydomeMeta: $(".vnccs-i3s__skydome-meta"),
            skydomeSettings: $(".vnccs-i3s__skydome-settings"),
            skydomeVisible: $(".vnccs-i3s__skydome-visible"),
            skydomeYaw: $(".vnccs-i3s__skydome-yaw"),
            skydomeYawValue: $(".vnccs-i3s__skydome-yaw-value"),
            skydomePitch: $(".vnccs-i3s__skydome-pitch"),
            skydomePitchValue: $(".vnccs-i3s__skydome-pitch-value"),
            skydomeRoll: $(".vnccs-i3s__skydome-roll"),
            skydomeRollValue: $(".vnccs-i3s__skydome-roll-value"),
            skydomeExposure: $(".vnccs-i3s__skydome-exposure"),
            skydomeExposureValue: $(".vnccs-i3s__skydome-exposure-value"),
            skydomeBlur: $(".vnccs-i3s__skydome-blur"),
            skydomeBlurValue: $(".vnccs-i3s__skydome-blur-value"),
            skydomeLevel: $(".vnccs-i3s__skydome-level"),
            skydomeReset: $(".vnccs-i3s__skydome-reset"),
            skydomeRemove: $(".vnccs-i3s__skydome-remove"),
            lightingOpen: $(".vnccs-i3s__lighting-open"),
            lightingPanel: $(".vnccs-i3s__lighting-panel"),
            lightingClose: $(".vnccs-i3s__lighting-panel .vnccs-i3s__lighting-close"),
            lightingPresets: Array.from(this.container.querySelectorAll(".vnccs-i3s__lighting-preset")),
            lightIntensity: $(".vnccs-i3s__light-intensity"),
            lightIntensityValue: $(".vnccs-i3s__light-intensity-value"),
            lightColor: $(".vnccs-i3s__light-color"),
            lightColorValue: $(".vnccs-i3s__light-color-value"),
            lightRadar: $(".vnccs-i3s__lighting-radar"),
            lightElevation: $(".vnccs-i3s__light-elevation"),
            lightAzimuthValue: $(".vnccs-i3s__light-azimuth-value"),
            lightElevationValue: $(".vnccs-i3s__light-elevation-value"),
            grid: $(".vnccs-i3s__grid"),
            progress: $(".vnccs-i3s__progress"),
            progressStage: $(".vnccs-i3s__progress-stage"),
            progressPercent: $(".vnccs-i3s__progress-percent"),
            progressBar: $(".vnccs-i3s__progress-bar"),
            jobDetail: $(".vnccs-i3s__job-detail"),
            cancelJob: $(".vnccs-i3s__cancel-job"),
            objectSearch: $(".vnccs-i3s__object-search"),
            groupSelected: $(".vnccs-i3s__group-selected"),
            selectionCount: $(".vnccs-i3s__selection-count"),
            objectList: $(".vnccs-i3s__object-list"),
            objectCount: $(".vnccs-i3s__object-count"),
            sceneSummary: $(".vnccs-i3s__scene-summary"),
            sceneAspect: $(".vnccs-i3s__scene-aspect"),
            sceneWidth: $(".vnccs-i3s__scene-width"),
            sceneHeight: $(".vnccs-i3s__scene-height"),
            sceneFrame: $(".vnccs-i3s__scene-frame"),
            sceneRenderSummary: $(".vnccs-i3s__scene-render-summary"),
            sceneExport: $(".vnccs-i3s__scene-export"),
            toasts: $(".vnccs-i3s__toasts"),
            modalLayer: $(".vnccs-i3s__modal-layer"),
        };
    }

    _listen(target, type, handler, options) {
        target?.addEventListener(type, handler, options);
        this._listeners.push(() => target?.removeEventListener(type, handler, options));
    }

    _bind() {
        this._listen(api, "vnccs_req_3d_factory_preview", event => {
            const detail = safeObject(event?.detail);
            if (String(detail.node_id ?? "") !== String(this.node?.id ?? "")) return;
            void this._captureExecutionPreview(detail);
        });
        const pick = () => !this.currentJobId && this.els.sourceInput.click();
        this._listen(this.els.sourceDrop, "click", event => {
            if (!event.target.closest(".vnccs-i3s__source-change")) pick();
        });
        this._listen(this.els.sourceDrop, "keydown", event => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                pick();
            }
        });
        this._listen(this.els.sourceChange, "click", event => {
            event.preventDefault();
            event.stopPropagation();
            pick();
        });
        this._listen(this.els.sourceInput, "change", () => {
            const file = this.els.sourceInput.files?.[0];
            if (file) void this._acceptSource(file);
            this.els.sourceInput.value = "";
        });
        for (const name of ["dragenter", "dragover", "dragleave", "drop"]) {
            this._listen(this.els.sourceDrop, name, event => {
                event.preventDefault();
                event.stopPropagation();
                this.els.sourceDrop.classList.toggle("is-dragging", ["dragenter", "dragover"].includes(name));
                if (name === "drop" && !this.currentJobId) {
                    const file = Array.from(event.dataTransfer?.files || []).find(item => item.type.startsWith("image/"));
                    if (file) void this._acceptSource(file);
                }
            });
        }

        const settings = [
            [this.els.objectName, "name", "string"],
            [this.els.density, "num_gaussians", "integer"],
            [this.els.steps, "steps", "integer"],
            [this.els.guidance, "guidance_scale", "number"],
            [this.els.seed, "seed", "integer"],
        ];
        for (const [control, key, kind] of settings) {
            const update = () => {
                const value = control.value;
                this.settings[key] = kind === "string" ? value : kind === "integer" ? Math.round(Number(value)) : Number(value);
                this.els.guidanceValue.textContent = Number(this.settings.guidance_scale).toFixed(1);
                if (key === "num_gaussians") this._syncDensityMode();
                this._scheduleStateSave();
            };
            this._listen(control, "input", update);
            this._listen(control, "change", update);
        }
        this._listen(this.els.removeBackground, "click", () => {
            this.settings.remove_background = !this.settings.remove_background;
            this._syncBackgroundRemoval();
            this._scheduleStateSave();
        });
        this._listen(this.els.seedDice, "click", () => {
            this.settings.seed_mode = this.settings.seed_mode === "randomize" ? "fixed" : "randomize";
            this._syncSeedMode();
            this._scheduleStateSave();
        });
        this._listen(this.els.donateLink, "pointerdown", event => event.stopPropagation());
        this._listen(this.els.donateLink, "click", event => event.stopPropagation());
        this._listen(this.els.modelSetup, "click", () => this.openModelSetup());
        this._listen(this.els.generate, "click", () => void this.generate());
        this._bindCameraControls();
        this._listen(this.els.cameraAdd, "click", () => void this.addCamera());
        this._listen(this.els.libraryOpen, "click", () => void this.openLibrary());
        this._listen(this.els.plyImport, "click", () => {
            if (this.currentJobId || this.importingPly) {
                this.toast("Wait for the active Factory job to finish.", "error");
                return;
            }
            this.els.plyInput.click();
        });
        this._listen(this.els.plyInput, "change", () => {
            const file = this.els.plyInput.files?.[0];
            this.els.plyInput.value = "";
            if (file) void this.importPly(file);
        });
        this._listen(this.els.sceneManager, "click", () => void this.openSceneManager());
        this._listen(this.els.sceneName, "change", () => {
            if (!this.scene) return;
            this.scene.name = this.els.sceneName.value.trim() || "Untitled scene";
            this._scheduleStateSave(0);
            void this._saveSceneNow();
        });
        this._listen(this.els.fit, "click", () => this.viewer.fit());
        this._listen(this.els.modeMove, "click", () => this.viewer.setMode("translate"));
        this._listen(this.els.modeRotate, "click", () => this.viewer.setMode("rotate"));
        this._listen(this.els.modeScale, "click", () => this.viewer.setMode("scale"));
        this._listen(this.els.skydomeOpen, "click", event => {
            event.stopPropagation();
            this._setSkydomePanelOpen(this.els.skydomePanel.hidden);
        });
        this._listen(this.els.skydomeClose, "click", () => this._setSkydomePanelOpen(false));
        this._listen(this.els.skydomeUpload, "click", () => this.els.skydomeInput.click());
        this._listen(this.els.skydomeInput, "change", () => {
            const file = this.els.skydomeInput.files?.[0];
            this.els.skydomeInput.value = "";
            if (file) void this.uploadSkydome(file);
        });
        this._listen(this.els.skydomeVisible, "click", () => {
            if (!this.scene?.skydome) return;
            this.scene.skydome.visible = this.scene.skydome.visible === false;
            this._syncSkydome();
            this._commitSkydome({ final: true });
            this._updateSceneSummary();
            this._renderObjects();
        });
        for (const [control, key] of [
            [this.els.skydomeYaw, "yaw"],
            [this.els.skydomePitch, "pitch"],
            [this.els.skydomeRoll, "roll"],
            [this.els.skydomeExposure, "exposure"],
            [this.els.skydomeBlur, "blur"],
        ]) {
            this._listen(control, "input", () => {
                if (!this.scene?.skydome) return;
                this.scene.skydome[key] = Number(control.value);
                this._syncSkydome();
                this._commitSkydome();
            });
            this._listen(control, "change", () => this._commitSkydome({ final: true }));
        }
        this._listen(this.els.skydomeLevel, "click", () => {
            if (!this.scene?.skydome) return;
            this.scene.skydome.pitch = 0;
            this.scene.skydome.roll = 0;
            this._syncSkydome();
            this._commitSkydome({ final: true });
        });
        this._listen(this.els.skydomeReset, "click", () => {
            if (!this.scene?.skydome) return;
            Object.assign(this.scene.skydome, { yaw: 0, pitch: 0, roll: 0 });
            this._syncSkydome();
            this._commitSkydome({ final: true });
        });
        this._listen(this.els.skydomeRemove, "click", () => void this.removeSkydome());
        this._listen(this.els.lightingOpen, "click", event => {
            event.stopPropagation();
            this._setLightingPanelOpen(this.els.lightingPanel.hidden);
        });
        this._listen(this.els.lightingClose, "click", () => this._setLightingPanelOpen(false));
        this._listen(document, "pointerdown", event => {
            if (
                !this.els.lightingPanel.hidden
                && !this.els.lightingPanel.contains(event.target)
                && !this.els.lightingOpen.contains(event.target)
            ) this._setLightingPanelOpen(false);
            if (
                !this.els.skydomePanel.hidden
                && !this.els.skydomePanel.contains(event.target)
                && !this.els.skydomeOpen.contains(event.target)
            ) this._setSkydomePanelOpen(false);
        });
        this._listen(document, "keydown", event => {
            if (event.key === "Escape" && !this.els.lightingPanel.hidden) {
                this._setLightingPanelOpen(false);
            }
            if (event.key === "Escape" && !this.els.skydomePanel.hidden) {
                this._setSkydomePanelOpen(false);
            }
        });
        for (const presetButton of this.els.lightingPresets) {
            this._listen(presetButton, "click", () => {
                const key = presetButton.dataset.preset;
                const preset = LIGHTING_PRESETS[key];
                if (!preset) return;
                this.lighting = { preset: key, ...preset };
                delete this.lighting.label;
                this._syncLighting();
                this._commitLighting({ final: true });
            });
        }
        this._listen(this.els.lightIntensity, "input", () => {
            this.lighting.intensity = Number(this.els.lightIntensity.value);
            this.lighting.preset = "custom";
            this._syncLighting();
            this._commitLighting();
        });
        this._listen(this.els.lightIntensity, "change", () => {
            this._commitLighting({ final: true });
        });
        this._listen(this.els.lightColor, "input", () => {
            this.lighting.color = this.els.lightColor.value;
            this.lighting.preset = "custom";
            this._syncLighting();
            this._commitLighting();
        });
        this._listen(this.els.lightColor, "change", () => {
            this._commitLighting({ final: true });
        });
        this._listen(this.els.lightElevation, "input", () => {
            this.lighting.elevation = Number(this.els.lightElevation.value);
            this.lighting.preset = "custom";
            this._syncLighting();
            this._commitLighting();
        });
        this._listen(this.els.lightElevation, "change", () => {
            this._commitLighting({ final: true });
        });
        this._bindLightingRadar();
        this._listen(this.els.grid, "click", () => this.viewer.setGrid(!this.viewerState.grid));
        this._listen(this.els.cancelJob, "click", () => void this.cancelJob());
        this._listen(this.els.objectSearch, "input", () => {
            if (this._searchRenderFrame) return;
            this._searchRenderFrame = requestAnimationFrame(() => {
                this._searchRenderFrame = 0;
                if (!this.destroyed) this._renderObjects();
            });
        });
        this._listen(this.els.groupSelected, "click", () => void this.groupSelectedObjects());
        this._listen(this.els.sceneAspect, "change", () => {
            const aspect = this.els.sceneAspect.value;
            const ratio = ASPECT_RATIOS[aspect];
            this.exportSettings.aspect = aspect;
            if (ratio) {
                const size = this._sizeForAspect(
                    Number(this.els.sceneWidth.value) || this.exportSettings.width,
                    ratio,
                    "width",
                );
                this.exportSettings.width = size.width;
                this.exportSettings.height = size.height;
            }
            this._commitExportSettings();
        });
        const updateExportSide = anchor => {
            const control = anchor === "width" ? this.els.sceneWidth : this.els.sceneHeight;
            const value = Number(control.value);
            if (!Number.isFinite(value) || value < 64) return;
            const ratio = ASPECT_RATIOS[this.exportSettings.aspect];
            if (ratio) {
                Object.assign(this.exportSettings, this._sizeForAspect(value, ratio, anchor));
            } else {
                this.exportSettings[anchor] = Math.max(64, Math.min(4096, Math.round(value)));
            }
            this._commitExportSettings();
        };
        for (const anchor of ["width", "height"]) {
            const control = anchor === "width" ? this.els.sceneWidth : this.els.sceneHeight;
            this._listen(control, "change", () => updateExportSide(anchor));
            this._listen(control, "keydown", event => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    updateExportSide(anchor);
                    control.blur();
                }
            });
        }
        this._listen(this.els.sceneFrame, "click", () => {
            this.exportSettings.show_camera_frame = !this.exportSettings.show_camera_frame;
            this._commitExportSettings({ previewChanged: false });
        });
        this._listen(this.els.objectList, "dragover", event => {
            if (!this.dragLayer || event.target !== this.els.objectList) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
        });
        this._listen(this.els.objectList, "drop", event => {
            if (!this.dragLayer || event.target !== this.els.objectList) return;
            event.preventDefault();
            this._moveLayer(this.dragLayer, null, "end");
        });
        this._listen(this.els.sceneExport, "click", () => void this.exportScene());
    }

    _normalizeCameraState(value = {}, fallback = {}) {
        const source = safeObject(value);
        const previous = safeObject(fallback);
        const vector = (key, defaultValue) => {
            const raw = Array.isArray(source[key]) ? source[key] : previous[key];
            return Array.isArray(raw) && raw.length === 3 && raw.every(item => Number.isFinite(Number(item)))
                ? raw.map(Number)
                : [...defaultValue];
        };
        return {
            position: vector("position", [2.8, 2.1, 4.2]),
            target: vector("target", [0, 0, 0]),
            up: vector("up", [0, 1, 0]),
            fov: clamp(source.fov ?? previous.fov ?? 42, 5, 120),
        };
    }

    _normalizeSceneCameras(value) {
        const output = [];
        const seen = new Set();
        for (const [index, raw] of (Array.isArray(value) ? value : []).slice(0, 32).entries()) {
            const camera = safeObject(raw);
            const cameraId = String(camera.camera_id || "");
            if (!/^[a-f0-9]{32}$/.test(cameraId) || seen.has(cameraId)) continue;
            seen.add(cameraId);
            output.push({
                camera_id: cameraId,
                name: String(camera.name || `Camera ${index + 1}`).slice(0, 80),
                created_at: Number.isFinite(Number(camera.created_at))
                    ? Number(camera.created_at)
                    : 0,
                ...this._normalizeCameraState(camera),
            });
        }
        return output;
    }

    _bindCameraControls() {
        const rotate = delta => {
            this.viewer?.rotateCameraFPV?.(delta);
            if (this.selectedCameraId && this.scene) {
                const camera = this.scene.cameras?.find(
                    item => item.camera_id === this.selectedCameraId,
                );
                if (camera) {
                    Object.assign(camera, this.viewer.getCameraState());
                    this._scheduleSceneSave(140);
                    this._scheduleStateSave(140);
                }
            }
        };
        const resetPad = () => {
            this._cameraPadPointer = null;
            this.els.cameraLook.classList.remove("is-active");
            this.els.cameraReticle.style.transform = "";
        };
        this._listen(this.els.cameraLook, "pointerdown", event => {
            if (event.button !== 0) return;
            event.preventDefault();
            this.els.cameraLook.setPointerCapture?.(event.pointerId);
            this._cameraPadPointer = {
                id: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                offsetX: 0,
                offsetY: 0,
            };
            this.els.cameraLook.classList.add("is-active");
        });
        this._listen(this.els.cameraLook, "pointermove", event => {
            const pointer = this._cameraPadPointer;
            if (!pointer || pointer.id !== event.pointerId) return;
            event.preventDefault();
            const deltaX = event.clientX - pointer.x;
            const deltaY = event.clientY - pointer.y;
            pointer.x = event.clientX;
            pointer.y = event.clientY;
            pointer.offsetX = clamp(pointer.offsetX + deltaX, -34, 34);
            pointer.offsetY = clamp(pointer.offsetY + deltaY, -34, 34);
            this.els.cameraReticle.style.transform = (
                `translate(${pointer.offsetX}px, ${pointer.offsetY}px)`
            );
            rotate({ yaw: -deltaX * 0.18, pitch: -deltaY * 0.18 });
        });
        for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
            this._listen(this.els.cameraLook, type, resetPad);
        }
        this._listen(this.els.cameraLook, "keydown", event => {
            const delta = {
                ArrowLeft: { yaw: 2 },
                ArrowRight: { yaw: -2 },
                ArrowUp: { pitch: 2 },
                ArrowDown: { pitch: -2 },
            }[event.key];
            if (!delta) return;
            event.preventDefault();
            rotate(delta);
        });

        let previousRoll = 0;
        const startRoll = () => {
            previousRoll = Number(this.els.cameraRoll.value) || 0;
        };
        this._listen(this.els.cameraRoll, "pointerdown", startRoll);
        this._listen(this.els.cameraRoll, "focus", startRoll);
        this._listen(this.els.cameraRoll, "input", () => {
            const value = Number(this.els.cameraRoll.value) || 0;
            rotate({ roll: value - previousRoll });
            previousRoll = value;
        });
        const resetRoll = () => {
            previousRoll = 0;
            this.els.cameraRoll.value = "0";
        };
        this._listen(this.els.cameraRoll, "change", resetRoll);
        this._listen(this.els.cameraRoll, "pointerup", resetRoll);
    }

    async addCamera() {
        if (!this.sceneId) await this.ensureScene();
        if (!this.scene) return;
        this.scene.cameras = this._normalizeSceneCameras(this.scene.cameras);
        if (this.scene.cameras.length >= 32) {
            this.toast("A scene can contain up to 32 cameras.", "error");
            return;
        }
        const camera = {
            camera_id: randomLayerId(),
            name: `Camera ${this.scene.cameras.length + 1}`,
            created_at: Date.now() / 1000,
            ...this._normalizeCameraState(this.viewer.getCameraState()),
        };
        this.scene.cameras.push(camera);
        this._renderCameras();
        this._updateSceneSummary();
        await this._saveSceneNow();
        this.toast(`${camera.name} added.`, "success");
    }

    _selectCamera(cameraId) {
        const camera = this.scene?.cameras?.find(item => item.camera_id === cameraId);
        if (!camera) return;
        if (this.selectedCameraId === cameraId) {
            this._exitCameraView({ restore: true });
            return;
        }
        if (!this.selectedCameraId) {
            this._cameraReturnState = this._normalizeCameraState(
                this.viewer.getCameraState(),
                this.scene?.camera,
            );
        }
        this._cameraSelectionTransition = true;
        try {
            this.selectedObjectId = "";
            this.selectedObjectIds.clear();
            this.selectedGroupId = "";
            this.selectedSkydome = false;
            this.viewer.select("");
            this.selectedCameraId = cameraId;
            this.viewer.setCameraState(camera, { emit: false });
        } finally {
            this._cameraSelectionTransition = false;
        }
        this._syncSelectionPresentation();
        this._renderCameras();
        this._scheduleStateSave();
    }

    _exitCameraView({ restore = true } = {}) {
        if (!this.selectedCameraId && !this._cameraReturnState) return;
        const returnState = this._cameraReturnState;
        this._cameraSelectionTransition = true;
        try {
            this.selectedCameraId = "";
            this._cameraReturnState = null;
            if (restore && returnState) {
                this.viewer.setCameraState(returnState, { emit: false });
                this.viewerState = {
                    ...this.viewerState,
                    camera: this._normalizeCameraState(returnState),
                };
            }
        } finally {
            this._cameraSelectionTransition = false;
        }
        this._renderCameras();
        this._scheduleStateSave();
    }

    async _deleteCamera(cameraId) {
        if (!this.scene) return;
        const camera = this.scene.cameras?.find(item => item.camera_id === cameraId);
        if (!camera) return;
        if (this.selectedCameraId === cameraId) this._exitCameraView({ restore: true });
        this.scene.cameras = this.scene.cameras.filter(
            item => item.camera_id !== cameraId,
        );
        this._renderCameras();
        this._updateSceneSummary();
        await this._saveSceneNow();
        this.toast(`${camera.name} removed.`, "success");
    }

    _renderCameras() {
        const cameras = this._normalizeSceneCameras(this.scene?.cameras);
        if (this.scene) this.scene.cameras = cameras;
        this.els.cameraCount.textContent = String(cameras.length);
        this.els.cameraGroupCount.textContent = String(cameras.length);
        this.els.cameraAdd.disabled = !this.scene || cameras.length >= 32;
        this.els.cameraList.replaceChildren();
        if (!cameras.length) {
            this.els.cameraList.appendChild(
                element("div", "vnccs-i3s__camera-empty", "No saved cameras"),
            );
            return;
        }
        const fragment = document.createDocumentFragment();
        for (const [index, camera] of cameras.entries()) {
            const card = element(
                "div",
                `vnccs-i3s__camera-item${
                    camera.camera_id === this.selectedCameraId ? " is-selected" : ""
                }`,
            );
            card.dataset.cameraId = camera.camera_id;
            card.tabIndex = 0;
            card.setAttribute("role", "button");
            card.setAttribute("aria-pressed", String(camera.camera_id === this.selectedCameraId));
            card.innerHTML = `
                <span class="vnccs-i3s__camera-index">${index + 1}</span>
                <span class="vnccs-i3s__camera-item-icon">${ICONS.camera}</span>
                <span class="vnccs-i3s__camera-item-name"></span>
                <button class="vnccs-i3s__camera-delete" type="button"
                    title="Delete camera" aria-label="Delete camera">${ICONS.trash}</button>
            `;
            card.querySelector(".vnccs-i3s__camera-item-name").textContent = camera.name;
            card.querySelector(".vnccs-i3s__camera-delete").setAttribute(
                "aria-label",
                `Delete ${camera.name}`,
            );
            this._listen(card, "click", event => {
                if (event.target.closest(".vnccs-i3s__camera-delete")) return;
                this._selectCamera(camera.camera_id);
            });
            this._listen(card, "keydown", event => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                this._selectCamera(camera.camera_id);
            });
            this._listen(card.querySelector(".vnccs-i3s__camera-delete"), "click", event => {
                event.stopPropagation();
                void this._deleteCamera(camera.camera_id);
            });
            fragment.appendChild(card);
        }
        this.els.cameraList.appendChild(fragment);
    }

    _normalizeLighting(value = {}) {
        const data = { ...DEFAULT_LIGHTING, ...safeObject(value) };
        const validColor = color => /^#[0-9a-f]{6}$/i.test(String(color || ""));
        return {
            preset: Object.hasOwn(LIGHTING_PRESETS, data.preset) || data.preset === "custom"
                ? data.preset
                : "day",
            intensity: clamp(data.intensity, 0, 3),
            color: validColor(data.color) ? String(data.color).toLowerCase() : DEFAULT_LIGHTING.color,
            azimuth: ((Number(data.azimuth) || 0) % 360 + 360) % 360,
            elevation: clamp(data.elevation, -10, 90),
            ambient: clamp(data.ambient, 0, 1.5),
            background: validColor(data.background)
                ? String(data.background).toLowerCase()
                : DEFAULT_LIGHTING.background,
        };
    }

    _normalizeSkydome(value = {}) {
        const source = safeObject(value);
        const data = { ...DEFAULT_SKYDOME, ...source };
        return {
            ...source,
            type: "skydome",
            projection: "equirectangular",
            visible: data.visible !== false,
            yaw: clamp(data.yaw, -180, 180),
            pitch: clamp(data.pitch, -90, 90),
            roll: clamp(data.roll, -180, 180),
            exposure: clamp(data.exposure, -4, 4),
            blur: clamp(data.blur, 0, 1),
        };
    }

    _setSkydomePanelOpen(open) {
        this.els.skydomePanel.hidden = !open;
        this.els.skydomeOpen.setAttribute("aria-pressed", String(open));
        if (open) {
            this._setLightingPanelOpen(false);
            this._syncSkydome();
        } else {
            this.viewer?.setEditorInteraction("skydome", false);
        }
    }

    _syncSkydome() {
        const skydome = this.scene?.skydome
            ? this._normalizeSkydome(this.scene.skydome)
            : null;
        if (skydome) this.scene.skydome = skydome;
        this.els.skydomeSettings.hidden = !skydome;
        this.els.skydomeUpload.querySelector("span:last-child").textContent = skydome
            ? "Replace"
            : "Load";
        this.els.skydomeName.textContent = skydome?.name || "No skydome loaded";
        this.els.skydomeMeta.textContent = skydome
            ? `${Number(skydome.width || 0).toLocaleString()} × ${Number(skydome.height || 0).toLocaleString()} · ${formatBytes(skydome.size)} · equirectangular`
            : "JPEG, PNG or WebP · equirectangular";
        const previewURL = skydome?.url ? apiUrl(skydome.url) : "";
        if (this.els.skydomePreview.dataset.url !== previewURL) {
            this.els.skydomePreview.dataset.url = previewURL;
            if (previewURL) {
                const image = element("img");
                image.src = previewURL;
                image.alt = "";
                image.loading = "lazy";
                image.decoding = "async";
                this.els.skydomePreview.replaceChildren(image);
            } else {
                this.els.skydomePreview.innerHTML = ICONS.image;
            }
        }
        const disabled = !skydome;
        for (const control of [
            this.els.skydomeVisible,
            this.els.skydomeYaw,
            this.els.skydomePitch,
            this.els.skydomeRoll,
            this.els.skydomeExposure,
            this.els.skydomeBlur,
            this.els.skydomeLevel,
            this.els.skydomeReset,
            this.els.skydomeRemove,
        ]) control.disabled = disabled;
        if (!skydome) return;
        this.els.skydomeVisible.setAttribute("aria-checked", String(skydome.visible));
        this.els.skydomeYaw.value = String(skydome.yaw);
        this.els.skydomePitch.value = String(skydome.pitch);
        this.els.skydomeRoll.value = String(skydome.roll);
        this.els.skydomeExposure.value = String(skydome.exposure);
        this.els.skydomeBlur.value = String(skydome.blur);
        const setOutput = (output, value) => {
            output.value = value;
            output.textContent = value;
        };
        setOutput(this.els.skydomeYawValue, `${Math.round(skydome.yaw)}°`);
        setOutput(this.els.skydomePitchValue, `${Math.round(skydome.pitch)}°`);
        setOutput(this.els.skydomeRollValue, `${Math.round(skydome.roll)}°`);
        setOutput(this.els.skydomeExposureValue, `${skydome.exposure.toFixed(1)} EV`);
        setOutput(this.els.skydomeBlurValue, `${Math.round(skydome.blur * 100)}%`);
    }

    _commitSkydome({ final = false } = {}) {
        if (!this.scene?.skydome) return;
        this.scene.skydome = this._normalizeSkydome(this.scene.skydome);
        this.viewer?.setEditorInteraction("skydome", !final);
        this.viewer?.updateSkydome(this.scene.skydome);
        this._scheduleStateSave(final ? 0 : 100);
        this._scheduleSceneSave(final ? 0 : 180);
        this._scheduleScenePreview(final ? 140 : 480);
    }

    async uploadSkydome(file) {
        if (!this.sceneId || !this.scene) return;
        if (
            !["image/jpeg", "image/png", "image/webp"].includes(file.type)
            || file.size > MAX_SKYDOME_BYTES
        ) {
            this.toast("Skydome must be a JPEG, PNG or WebP image smaller than 64 MB.", "error");
            return;
        }
        this.els.skydomeUpload.disabled = true;
        this._setStatus("Uploading skydome", "working");
        try {
            const body = new FormData();
            body.append("image", file, file.name || "skydome");
            const scene = await this._fetchJSON(ENDPOINTS.skydome(this.sceneId), {
                method: "POST",
                body,
            });
            this.selectedSkydome = true;
            await this._applyScene(scene, { preserveSource: true });
            this._selectSkydome();
            this._setSkydomePanelOpen(true);
            this.toast("Skydome loaded.", "success");
        } catch (error) {
            this._setStatus("Skydome upload failed", "error");
            this._showError("Skydome could not be loaded", error);
        } finally {
            this.els.skydomeUpload.disabled = false;
        }
    }

    removeSkydome() {
        if (!this.scene?.skydome || !this.sceneId) return;
        const body = element("div");
        body.append(
            element(
                "div",
                "vnccs-i3s__failure-summary",
                `Remove skydome “${this.scene.skydome.name || "Skydome"}” from this scene?`,
            ),
            element(
                "div",
                "vnccs-i3s__hint",
                "The source image and its scene-specific settings will be deleted. Library copies are not affected.",
            ),
        );
        const cancel = button("vnccs-i3s__button", "Cancel");
        const remove = button(
            "vnccs-i3s__button vnccs-i3s__button--danger",
            "Remove skydome",
            "trash",
        );
        cancel.addEventListener("click", () => this.closeModal());
        remove.addEventListener("click", () => void this._deleteSkydomeNow(remove));
        this.openModal({
            title: "Remove skydome",
            body,
            actions: [cancel, remove],
            initialFocus: cancel,
        });
    }

    async _deleteSkydomeNow(control = null) {
        if (!this.scene?.skydome || !this.sceneId) return;
        if (control) control.disabled = true;
        this.els.skydomeRemove.disabled = true;
        try {
            const scene = await this._fetchJSON(ENDPOINTS.skydome(this.sceneId), {
                method: "DELETE",
            });
            this.closeModal();
            this.selectedSkydome = false;
            await this._applyScene(scene, { preserveSource: true });
            this._setSkydomePanelOpen(true);
            this.toast("Skydome removed.", "success");
        } catch (error) {
            if (control?.isConnected) control.disabled = false;
            this._showError("Skydome could not be removed", error);
        } finally {
            this.els.skydomeRemove.disabled = false;
        }
    }

    _setLightingPanelOpen(open) {
        this.els.lightingPanel.hidden = !open;
        this.els.lightingOpen.setAttribute("aria-pressed", String(open));
        if (open) {
            this._setSkydomePanelOpen(false);
            this._drawLightingRadar();
        } else {
            this.viewer?.setEditorInteraction("lighting", false);
        }
    }

    _syncLighting() {
        this.lighting = this._normalizeLighting(this.lighting);
        this.els.lightIntensity.value = String(this.lighting.intensity);
        this.els.lightIntensityValue.value = this.lighting.intensity.toFixed(2);
        this.els.lightIntensityValue.textContent = this.lighting.intensity.toFixed(2);
        this.els.lightColor.value = this.lighting.color;
        this.els.lightColorValue.value = this.lighting.color.toUpperCase();
        this.els.lightColorValue.textContent = this.lighting.color.toUpperCase();
        this.els.lightElevation.value = String(this.lighting.elevation);
        const azimuth = Math.round(this.lighting.azimuth);
        const elevation = Math.round(this.lighting.elevation);
        this.els.lightAzimuthValue.value = `${azimuth}°`;
        this.els.lightAzimuthValue.textContent = `${azimuth}°`;
        this.els.lightElevationValue.value = `${elevation}°`;
        this.els.lightElevationValue.textContent = `${elevation}°`;
        for (const presetButton of this.els.lightingPresets) {
            presetButton.setAttribute(
                "aria-pressed",
                String(presetButton.dataset.preset === this.lighting.preset),
            );
        }
        this._drawLightingRadar();
    }

    _commitLighting({ final = false } = {}) {
        this.lighting = this._normalizeLighting(this.lighting);
        if (this.scene) this.scene.lighting = { ...this.lighting };
        this.viewer?.setEditorInteraction("lighting", !final);
        if (final) {
            clearTimeout(this._lightingApplyTimer);
            this._lightingApplyTimer = 0;
            this.viewer?.setLighting(this.lighting);
        } else if (!this._lightingApplyTimer) {
            // Recoloring a Gaussian generator touches every splat. Coalesce
            // high-frequency range/radar pointer events so controls remain
            // responsive while still providing a live ~15 fps light preview.
            this._lightingApplyTimer = setTimeout(() => {
                this._lightingApplyTimer = 0;
                if (!this.destroyed) this.viewer?.setLighting(this.lighting);
            }, 1000 / 15);
        }
        this._scheduleStateSave(final ? 0 : 100);
        if (this.sceneId && this.scene) {
            this._scheduleSceneSave(final ? 0 : 180);
            this._scheduleScenePreview(final ? 140 : 480);
        }
    }

    _bindLightingRadar() {
        const canvas = this.els.lightRadar;
        if (!canvas) return;
        let dragging = false;
        const update = event => {
            const bounds = canvas.getBoundingClientRect();
            if (!bounds.width || !bounds.height) return;
            const x = (event.clientX - bounds.left) / bounds.width * canvas.width;
            const y = (event.clientY - bounds.top) / bounds.height * canvas.height;
            const centerX = canvas.width / 2;
            const centerY = canvas.height / 2;
            const dx = x - centerX;
            const dy = y - centerY;
            if (Math.hypot(dx, dy) < 2) return;
            this.lighting.azimuth = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
            this.lighting.preset = "custom";
            this._syncLighting();
            this._commitLighting();
        };
        this._listen(canvas, "pointerdown", event => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            dragging = true;
            canvas.setPointerCapture?.(event.pointerId);
            update(event);
        });
        this._listen(canvas, "pointermove", event => {
            if (dragging) update(event);
        });
        const finish = event => {
            if (!dragging) return;
            dragging = false;
            if (canvas.hasPointerCapture?.(event.pointerId)) {
                canvas.releasePointerCapture(event.pointerId);
            }
            this._commitLighting({ final: true });
        };
        this._listen(canvas, "pointerup", finish);
        this._listen(canvas, "pointercancel", finish);
    }

    _drawLightingRadar() {
        const canvas = this.els.lightRadar;
        const context = canvas?.getContext?.("2d");
        if (!context) return;
        const width = canvas.width;
        const height = canvas.height;
        const centerX = width / 2;
        const centerY = height / 2;
        const radius = Math.min(width, height) / 2 - 8;
        context.clearRect(0, 0, width, height);

        const backdrop = context.createRadialGradient(
            centerX,
            centerY,
            2,
            centerX,
            centerY,
            radius,
        );
        backdrop.addColorStop(0, "rgba(62, 55, 77, .74)");
        backdrop.addColorStop(1, "rgba(10, 9, 15, .96)");
        context.fillStyle = backdrop;
        context.beginPath();
        context.arc(centerX, centerY, radius, 0, Math.PI * 2);
        context.fill();

        context.strokeStyle = "rgba(184, 169, 232, .18)";
        context.lineWidth = 1;
        for (const factor of [0.34, 0.67, 1]) {
            context.beginPath();
            context.arc(centerX, centerY, radius * factor, 0, Math.PI * 2);
            context.stroke();
        }
        context.beginPath();
        context.moveTo(centerX, centerY - radius);
        context.lineTo(centerX, centerY + radius);
        context.moveTo(centerX - radius, centerY);
        context.lineTo(centerX + radius, centerY);
        context.stroke();

        const angle = this.lighting.azimuth * Math.PI / 180;
        const elevationFactor = 0.42 + (90 - this.lighting.elevation) / 100 * 0.5;
        const dotRadius = radius * clamp(elevationFactor, 0.38, 0.92);
        const dotX = centerX + Math.sin(angle) * dotRadius;
        const dotY = centerY - Math.cos(angle) * dotRadius;
        const glow = context.createRadialGradient(dotX, dotY, 1, dotX, dotY, 18);
        glow.addColorStop(0, `${this.lighting.color}aa`);
        glow.addColorStop(1, `${this.lighting.color}00`);
        context.fillStyle = glow;
        context.beginPath();
        context.arc(dotX, dotY, 18, 0, Math.PI * 2);
        context.fill();
        context.strokeStyle = "rgba(255,255,255,.54)";
        context.lineWidth = 1.5;
        context.beginPath();
        context.moveTo(centerX, centerY);
        context.lineTo(dotX, dotY);
        context.stroke();
        context.fillStyle = this.lighting.color;
        context.beginPath();
        context.arc(dotX, dotY, 5.5, 0, Math.PI * 2);
        context.fill();
        context.strokeStyle = "#ffffff";
        context.stroke();

        context.fillStyle = "rgba(201, 196, 215, .48)";
        context.font = "700 8px ui-monospace, monospace";
        context.textAlign = "center";
        context.fillText("BACK", centerX, 13);
        context.fillText("FRONT", centerX, height - 7);
    }

    _showSource({ url, name }) {
        if (this.sourceURL?.startsWith("blob:")) URL.revokeObjectURL(this.sourceURL);
        this.sourceURL = url || "";
        if (this.sourceURL) {
            this.els.sourcePreview.src = this.sourceURL;
            this.els.sourceName.textContent = name || "reference.png";
            this.els.sourceDrop.classList.add("has-image");
        } else {
            this.els.sourceDrop.classList.remove("has-image");
            this.els.sourcePreview.removeAttribute("src");
            this.els.sourceName.textContent = "";
        }
    }

    _restoreSourceAsset(asset) {
        const value = safeObject(asset);
        const assetSceneId = String(value.scene_id || this.sceneId || "");
        const expectedURL = assetSceneId ? ENDPOINTS.reference(assetSceneId) : "";
        const expectedPreviewURL = expectedURL ? `${expectedURL}/preview` : "";
        if (!value.url || value.url !== expectedURL || assetSceneId !== this.sceneId) {
            this.sourceAsset = null;
            this.sourceFile = null;
            this._showSource({ url: "", name: "" });
            return;
        }
        const previewURL = String(value.preview_url || "");
        this.sourceAsset = {
            url: String(value.url),
            preview_url: (
                previewURL === expectedPreviewURL
                || previewURL.startsWith(`${expectedPreviewURL}?`)
            ) ? previewURL : "",
            name: String(value.name || "reference.png"),
            mime: String(value.mime || "image/png"),
            width: Number(value.width) || 0,
            height: Number(value.height) || 0,
            size: Number(value.size) || 0,
            updated_at: Number(value.updated_at) || 0,
            scene_id: assetSceneId,
        };
        this.sourceFile = null;
        this._showSource({
            url: apiUrl(this.sourceAsset.preview_url || this.sourceAsset.url),
            name: this.sourceAsset.name,
        });
    }

    async _acceptSource(file) {
        if (!file.type.startsWith("image/")) {
            this.toast("Choose a PNG, JPEG, or WebP image.", "error");
            return;
        }
        if (file.size > MAX_IMAGE_BYTES) {
            this.toast("The image is larger than 32 MB.", "error");
            return;
        }
        this.sourceFile = file;
        this.sourceAsset = null;
        this._showSource({ url: URL.createObjectURL(file), name: file.name });
        // Replacing the reference starts a new object brief. Always derive
        // its default name from the newly selected image, never from the
        // previous reference.
        this.settings.name = objectNameFromFileName(file.name);
        this.els.objectName.value = this.settings.name;
        this._scheduleStateSave();
        this._setStatus("Reference ready", "idle");
        try {
            if (!this.sceneId) await this.ensureScene(null, { preserveSource: true });
            const form = new FormData();
            form.append("image", file, file.name);
            const asset = await this._fetchJSON(ENDPOINTS.reference(this.sceneId), {
                method: "POST",
                body: form,
            });
            if (this.sourceFile === file) {
                this.sourceAsset = { ...asset, scene_id: this.sceneId };
                if (this.scene) this.scene.reference = { ...asset };
                this._showSource({
                    url: apiUrl(asset.preview_url || asset.url),
                    name: asset.name || file.name,
                });
                this._scheduleStateSave(0);
                this._setStatus("Reference saved", "success");
            }
        } catch (error) {
            console.error("[VNCCS 3D Factory] Reference persistence failed", error);
            this._showError("Reference save failed", error);
        }
    }

    async _fetchJSON(path, options = {}) {
        const response = await api.fetchApi(path, options);
        const text = await response.text();
        let payload = {};
        if (text) {
            try { payload = JSON.parse(text); } catch (_) { payload = { error: text }; }
        }
        if (!response.ok) {
            const error = new Error(payload.error || payload.message || `HTTP ${response.status}`);
            error.status = response.status;
            error.payload = payload;
            throw error;
        }
        return payload;
    }

    async loadCapabilities() {
        try {
            this.capabilities = await this._fetchJSON(ENDPOINTS.capabilities);
            const ready = Boolean(this.capabilities.weights?.ready);
            this.els.weightsDot.classList.toggle("is-ready", ready);
            this._syncTripoSummary();
            return this.capabilities;
        } catch (error) {
            this.els.weightsSummary.textContent = "Backend unavailable";
            console.error("[VNCCS 3D Factory] Capability check failed", error);
            return null;
        }
    }

    _syncTripoSummary() {
        const ready = Boolean(this.capabilities?.weights?.ready);
        this.els.weightsDot.classList.toggle("is-ready", ready);
        this.els.weightsSummary.textContent = ready
            ? [
                this.capabilities.device || "device",
                formatBytes(this.capabilities.weights.installed_bytes),
                `${Number(this.settings.conditioning_resolution) || 1024}²`,
                this.settings.prevent_upscale ? "native cap" : "",
            ].filter(Boolean).join(" · ")
            : "Weights are not installed";
    }

    async ensureScene(snapshot = null, { preserveSource = false } = {}) {
        if (this.sceneId) {
            try {
                if (snapshot && Array.isArray(snapshot.objects)) {
                    try {
                        const scene = await this._fetchJSON(ENDPOINTS.scene(this.sceneId), {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(snapshot),
                        });
                        await this._applyScene(scene, { preserveSource });
                    } catch (error) {
                        console.warn(
                            "[VNCCS 3D Factory] Scene snapshot could not be replayed; loading host scene",
                            error,
                        );
                        await this.loadScene(this.sceneId, { preserveSource });
                    }
                } else {
                    await this.loadScene(this.sceneId, { preserveSource });
                }
                return;
            } catch (error) {
                console.warn("[VNCCS 3D Factory] Saved scene could not be restored", error);
            }
        }
        await this.createScene("Untitled scene", { preserveSource });
    }

    async createScene(name, { preserveSource = false } = {}) {
        const scene = await this._fetchJSON(ENDPOINTS.scenes, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
        });
        this.closeModal();
        await this._applyScene(scene, { preserveSource });
        this.toast("New scene created.", "success");
    }

    async loadScene(sceneId, { preserveSource = false } = {}) {
        const scene = await this._fetchJSON(ENDPOINTS.scene(sceneId));
        await this._applyScene(scene, { preserveSource });
    }

    async _applyScene(scene, { preserveSource = false } = {}) {
        const incremental = Boolean(
            this.scene
            && this.sceneId
            && this.sceneId === scene?.scene_id,
        );
        const desiredGroupId = this.selectedGroupId;
        const desiredObjectIds = new Set(this.selectedObjectIds);
        const desiredSkydome = incremental && this.selectedSkydome;
        const desiredCameraId = incremental ? this.selectedCameraId : "";
        this.selectedCameraId = "";
        this._cameraReturnState = null;
        if (this.selectedObjectId) desiredObjectIds.add(this.selectedObjectId);
        this.scene = scene;
        this.sceneId = scene.scene_id;
        this.scene.cameras = this._normalizeSceneCameras(scene.cameras);
        if (this.scene.skydome) {
            this.scene.skydome = this._normalizeSkydome(this.scene.skydome);
        }
        this._normalizeSceneLayers();
        this.exportSettings = this._normalizeExportSettings(
            scene.render || this.exportSettings,
        );
        this.scene.render = { ...this.exportSettings };
        this.lighting = this._normalizeLighting(scene.lighting || this.lighting);
        this.scene.lighting = { ...this.lighting };
        const desiredViewerState = {
            ...this.viewerState,
            camera: Object.keys(safeObject(scene.camera)).length
                ? { ...scene.camera }
                : this.viewerState.camera,
        };
        this.scene.camera = desiredViewerState.camera
            ? { ...desiredViewerState.camera }
            : this.scene.camera;
        this._syncExportSettings();
        this._syncLighting();
        this._syncSkydome();
        if (!preserveSource) {
            this.sourceFile = null;
            if (scene.reference?.url) {
                this._restoreSourceAsset({ ...scene.reference, scene_id: scene.scene_id });
            } else {
                this._restoreSourceAsset(null);
            }
        } else if (!this.sourceAsset && scene.reference?.url) {
            this.sourceAsset = { ...scene.reference, scene_id: scene.scene_id };
        }
        this.els.sceneName.value = scene.name || "Untitled scene";
        this.els.sceneId.textContent = `#${this.sceneId.slice(0, 8)}`;
        const visibleIds = this._effectiveVisibleObjectIds();
        this._updateSceneSummary();
        this.viewportFailures.clear();
        this._renderObjects();
        this._setStatus(incremental ? "Updating scene" : "Loading viewport", "working");
        this._suppressViewerStatePersistence = true;
        let viewportResult;
        try {
            viewportResult = await this.viewer.setScene(scene, { incremental })
                || { loaded: 0, failures: [] };
            this.viewerState = desiredViewerState;
            this.viewer.setState(desiredViewerState);
            this.viewerState = { ...this.viewerState, ...this.viewer.getState() };
        } finally {
            this._suppressViewerStatePersistence = false;
        }
        const viewportFailures = Array.isArray(viewportResult.failures)
            ? viewportResult.failures
            : [];
        this.viewportFailures = new Map(
            viewportFailures.map(item => [item.objectId, errorText(item.error)]),
        );
        const desiredGroup = this._groupById(desiredGroupId);
        if (desiredSkydome && scene.skydome) {
            this._selectSkydome();
        } else if (desiredGroup) {
            this.selectedSkydome = false;
            this.selectedGroupId = desiredGroup.group_id;
            this.selectedObjectIds.clear();
            this.selectedObjectId = "";
            this.viewer.selectGroup(desiredGroup.group_id, desiredGroup.children);
        } else {
            this.selectedSkydome = false;
            this.selectedGroupId = "";
            this.selectedObjectIds = new Set(
                Array.from(desiredObjectIds).filter(
                    objectId => scene.objects?.some(item => item.object_id === objectId),
                ),
            );
            if (!this.selectedObjectIds.size) {
                const firstVisible = scene.objects?.find(item => visibleIds.has(item.object_id));
                if (firstVisible) this.selectedObjectIds.add(firstVisible.object_id);
            }
            this.selectedObjectId = (
                this.selectedObjectIds.has(this.selectedObjectId)
                    ? this.selectedObjectId
                    : Array.from(this.selectedObjectIds).at(-1) || ""
            );
            this.viewer.select(this.selectedObjectId, {
                additive: this.selectedObjectIds.size > 1,
            });
        }
        if (this.scene.cameras.some(camera => camera.camera_id === desiredCameraId)) {
            this._selectCamera(desiredCameraId);
        }
        this._renderObjects();
        this._renderCameras();
        this._scheduleStateSave();
        this.syncToNode();
        const loaded = Number(viewportResult.loaded) || 0;
        if (
            (loaded > 0 || this.viewer.hasVisibleSkydome())
            && !scene.preview?.url
        ) {
            // The graph execution handshake always requests an exact current
            // render. An ordinary scene open should not block LCP/INP on a
            // 1024–4096 px PNG encode and upload; refresh the convenience
            // preview only after the editor has gone idle.
            this._scheduleScenePreview(1800);
        }
        if (viewportFailures.length) {
            const failureDetails = viewportFailures.map(item => ({
                objectId: item.objectId,
                error: errorText(item.error),
                stack: item.error?.stack || "",
            }));
            console.error("[VNCCS 3D Factory] Viewport scene load incomplete", {
                build: FRONTEND_BUILD,
                sceneId: this.sceneId,
                requested: scene.objects?.length || 0,
                loaded,
                failures: failureDetails,
            });
            this._setStatus(loaded ? "Scene partially loaded" : "Viewport failed", "error");
        } else {
            this._setStatus("Scene ready", "success");
        }
    }

    _selected() {
        return this.scene?.objects?.find(item => item.object_id === this.selectedObjectId) || null;
    }

    _normalizeSceneLayers() {
        if (!this.scene) return [];
        const objects = Array.isArray(this.scene.objects) ? this.scene.objects : [];
        const objectIds = new Set(objects.map(item => item.object_id));
        const seenObjects = new Set();
        const seenGroups = new Set();
        const layers = [];
        for (const item of objects) item.visible = item.visible !== false;
        for (const layer of Array.isArray(this.scene.layers) ? this.scene.layers : []) {
            if (
                layer?.type === "object"
                && objectIds.has(layer.object_id)
                && !seenObjects.has(layer.object_id)
            ) {
                layers.push({ type: "object", object_id: layer.object_id });
                seenObjects.add(layer.object_id);
                continue;
            }
            if (
                layer?.type !== "group"
                || !/^[a-f0-9]{32}$/.test(String(layer.group_id || ""))
                || seenGroups.has(layer.group_id)
            ) continue;
            const children = [];
            for (const objectId of Array.isArray(layer.children) ? layer.children : []) {
                if (!objectIds.has(objectId) || seenObjects.has(objectId)) continue;
                children.push(objectId);
                seenObjects.add(objectId);
            }
            layers.push({
                type: "group",
                group_id: layer.group_id,
                name: String(layer.name || "Group").slice(0, 80),
                visible: layer.visible !== false,
                children,
            });
            seenGroups.add(layer.group_id);
        }
        for (const item of objects) {
            if (!seenObjects.has(item.object_id)) {
                layers.push({ type: "object", object_id: item.object_id });
            }
        }
        this.scene.layers = layers;
        return layers;
    }

    _objectById(objectId) {
        return this.scene?.objects?.find(item => item.object_id === objectId) || null;
    }

    _groupById(groupId) {
        return this._normalizeSceneLayers().find(
            layer => layer.type === "group" && layer.group_id === groupId,
        ) || null;
    }

    _effectiveVisibleObjectIds() {
        const visible = new Set();
        for (const layer of this._normalizeSceneLayers()) {
            if (layer.type === "object") {
                if (this._objectById(layer.object_id)?.visible !== false) visible.add(layer.object_id);
                continue;
            }
            if (layer.visible === false) continue;
            for (const objectId of layer.children) {
                if (this._objectById(objectId)?.visible !== false) visible.add(objectId);
            }
        }
        return visible;
    }

    _normalizeExportSettings(value = {}) {
        const data = safeObject(value);
        const width = Math.max(
            64,
            Math.min(4096, Math.round(Number(data.width) || DEFAULT_EXPORT_SETTINGS.width)),
        );
        const height = Math.max(
            64,
            Math.min(4096, Math.round(Number(data.height) || DEFAULT_EXPORT_SETTINGS.height)),
        );
        const aspect = data.aspect === "custom" || ASPECT_RATIOS[data.aspect]
            ? data.aspect
            : DEFAULT_EXPORT_SETTINGS.aspect;
        return {
            width,
            height,
            aspect,
            show_camera_frame: data.show_camera_frame === true,
        };
    }

    _sizeForAspect(value, ratio, anchor = "width") {
        let width;
        let height;
        if (anchor === "height") {
            height = Math.max(64, Math.min(4096, Math.round(Number(value) || 1024)));
            width = Math.round(height * ratio);
            if (width > 4096) {
                width = 4096;
                height = Math.round(width / ratio);
            } else if (width < 64) {
                width = 64;
                height = Math.round(width / ratio);
            }
        } else {
            width = Math.max(64, Math.min(4096, Math.round(Number(value) || 1024)));
            height = Math.round(width / ratio);
            if (height > 4096) {
                height = 4096;
                width = Math.round(height * ratio);
            } else if (height < 64) {
                height = 64;
                width = Math.round(height * ratio);
            }
        }
        return {
            width: Math.max(64, Math.min(4096, width)),
            height: Math.max(64, Math.min(4096, height)),
        };
    }

    _syncExportSettings() {
        const settings = this._normalizeExportSettings(this.exportSettings);
        this.exportSettings = settings;
        this.els.sceneAspect.value = settings.aspect;
        this.els.sceneWidth.value = String(settings.width);
        this.els.sceneHeight.value = String(settings.height);
        this.els.sceneFrame.setAttribute(
            "aria-checked",
            String(settings.show_camera_frame),
        );
        this.els.sceneRenderSummary.textContent = (
            `${settings.width} × ${settings.height} px`
            + ` · ${settings.aspect === "custom" ? "Custom ratio" : settings.aspect}`
            + " · Camera follows the current 3D view"
        );
        this.viewer?.setCaptureSettings(settings);
        this._customSelects?.refresh?.();
    }

    _commitExportSettings({ previewChanged = true } = {}) {
        this.exportSettings = this._normalizeExportSettings(this.exportSettings);
        if (this.scene) this.scene.render = { ...this.exportSettings };
        this._syncExportSettings();
        this._scheduleSceneSave(120);
        this._scheduleStateSave(0);
        if (previewChanged) this._scheduleScenePreview(260);
    }

    _updateSceneSummary() {
        const objects = this.scene?.objects || [];
        const skydome = this.scene?.skydome || null;
        const cameraCount = this.scene?.cameras?.length || 0;
        const visibleIds = this._effectiveVisibleObjectIds();
        this.container.classList.toggle("has-scene", Boolean(objects.length || skydome));
        this.els.objectCount.textContent = String(objects.length + (skydome ? 1 : 0));
        const gaussianSummary = objects.length
            ? `${visibleIds.size}/${objects.length} models visible · ${objects.reduce(
                (sum, item) => sum + (visibleIds.has(item.object_id) ? Number(item.gaussians) || 0 : 0),
                0,
            ).toLocaleString()} Gaussians`
            : "No Gaussian models";
        const contentSummary = skydome
            ? `${gaussianSummary} · Skydome ${skydome.visible === false ? "hidden" : "visible"}`
            : objects.length
                ? gaussianSummary
                : "No objects in this scene.";
        this.els.sceneSummary.textContent = cameraCount
            ? `${contentSummary} · ${cameraCount} camera${cameraCount === 1 ? "" : "s"}`
            : contentSummary;
    }

    _hasRenderableScene() {
        return Boolean(
            this.scene?.objects?.length
            || (this.scene?.skydome && this.scene.skydome.visible !== false),
        );
    }

    _selectSkydome() {
        if (this.selectedCameraId && !this._cameraSelectionTransition) {
            this._exitCameraView({ restore: true });
        }
        if (!this.scene?.skydome) {
            this.selectedSkydome = false;
            return;
        }
        this.selectedGroupId = "";
        this.selectedObjectIds.clear();
        this.selectedObjectId = "";
        this.viewer.select("");
        this.selectedSkydome = true;
        this._syncSelectionPresentation();
        this._scheduleStateSave();
    }

    _selectObject(objectId, { fromViewer = false, additive = false } = {}) {
        if (this.selectedCameraId && !this._cameraSelectionTransition) {
            this._exitCameraView({ restore: true });
        }
        const valid = this.scene?.objects?.some(item => item.object_id === objectId)
            ? objectId
            : "";
        this.selectedSkydome = false;
        this.selectedGroupId = "";
        if (!additive) {
            this.selectedObjectIds = new Set(valid ? [valid] : []);
        } else if (valid) {
            if (!fromViewer && this.selectedObjectIds.has(valid)) this.selectedObjectIds.delete(valid);
            else this.selectedObjectIds.add(valid);
        }
        this.selectedObjectId = valid && this.selectedObjectIds.has(valid)
            ? valid
            : Array.from(this.selectedObjectIds).at(-1) || "";
        if (!fromViewer) this.viewer.select(this.selectedObjectId, { additive });
        this._syncSelectionPresentation();
        this._scheduleStateSave();
    }

    _selectGroup(groupId) {
        if (this.selectedCameraId && !this._cameraSelectionTransition) {
            this._exitCameraView({ restore: true });
        }
        const group = this._groupById(groupId);
        this.selectedSkydome = false;
        this.selectedGroupId = group?.group_id || "";
        this.selectedObjectIds.clear();
        this.selectedObjectId = "";
        if (group) this.viewer.selectGroup(group.group_id, group.children);
        else this.viewer.select("");
        this._syncSelectionPresentation();
        this._scheduleStateSave();
    }

    _syncSelectionControls() {
        const count = this.selectedObjectIds.size;
        this.els.groupSelected.disabled = count < 2;
        this.els.selectionCount.textContent = count
            ? `${count} selected`
            : this.selectedSkydome
                ? "Skydome selected"
            : this.selectedGroupId
                ? "Group selected"
                : "Shift-click to select multiple";
    }

    _syncSelectionPresentation() {
        for (const card of this.els.objectList.querySelectorAll(".vnccs-i3s__object")) {
            const objectId = card.dataset.objectId || "";
            card.classList.toggle(
                "is-selected",
                Boolean(objectId && this.selectedObjectIds.has(objectId)),
            );
            card.classList.toggle(
                "is-primary",
                Boolean(objectId && objectId === this.selectedObjectId),
            );
        }
        for (const card of this.els.objectList.querySelectorAll(".vnccs-i3s__group-card")) {
            const groupId = card.dataset.groupId
                || card.closest(".vnccs-i3s__group")?.dataset.groupId
                || "";
            card.classList.toggle("is-selected", groupId === this.selectedGroupId);
        }
        const skydomeCard = this.els.objectList.querySelector(".vnccs-i3s__skydome-object");
        skydomeCard?.classList.toggle("is-selected", this.selectedSkydome);
        skydomeCard?.classList.toggle("is-primary", this.selectedSkydome);
        this._syncSelectionControls();
    }

    _renderObjects() {
        const query = this.els.objectSearch.value.trim().toLowerCase();
        const objects = new Map((this.scene?.objects || []).map(item => [item.object_id, item]));
        const skydome = this.scene?.skydome || null;
        const layers = this._normalizeSceneLayers();
        this.els.objectList.replaceChildren();
        const fragment = document.createDocumentFragment();
        this._syncSelectionControls();
        let rendered = 0;
        if (skydome && (!query || skydome.name.toLowerCase().includes(query) || "skydome background environment".includes(query))) {
            fragment.appendChild(this._createSkydomeCard(skydome));
            rendered += 1;
        }
        if (!objects.size && !skydome) {
            fragment.appendChild(element("div", "vnccs-i3s__tree-empty", query ? "No matching objects." : "Generated objects will appear here."));
            this.els.objectList.appendChild(fragment);
            return;
        }
        for (const layer of layers) {
            if (layer.type === "object") {
                const item = objects.get(layer.object_id);
                if (!item || (query && !item.name.toLowerCase().includes(query))) continue;
                fragment.appendChild(this._createObjectCard(item, ""));
                rendered += 1;
                continue;
            }
            const children = layer.children.map(id => objects.get(id)).filter(Boolean);
            const matchingChildren = children.filter(
                item => !query || item.name.toLowerCase().includes(query),
            );
            const groupMatches = !query || layer.name.toLowerCase().includes(query);
            if (!groupMatches && !matchingChildren.length) continue;
            const wrapper = element(
                "div",
                `vnccs-i3s__group${layer.visible === false ? " is-hidden" : ""}`,
            );
            wrapper.dataset.groupId = layer.group_id;
            const groupCard = this._createGroupCard(layer);
            const childList = element("div", "vnccs-i3s__group-children");
            const collapsed = this.collapsedGroupIds.has(layer.group_id) && !query;
            wrapper.classList.toggle("is-collapsed", collapsed);
            for (const item of groupMatches ? children : matchingChildren) {
                childList.appendChild(this._createObjectCard(item, layer.group_id));
            }
            if (!children.length) {
                childList.appendChild(element("div", "vnccs-i3s__group-empty", "Drop objects here"));
            }
            wrapper.append(groupCard, childList);
            fragment.appendChild(wrapper);
            rendered += 1;
        }
        if (!rendered) {
            fragment.appendChild(element("div", "vnccs-i3s__tree-empty", "No matching objects."));
        }
        this.els.objectList.appendChild(fragment);
    }

    _createSkydomeCard(skydome) {
        const card = element(
            "div",
            `vnccs-i3s__object vnccs-i3s__skydome-object`
                + `${this.selectedSkydome ? " is-selected is-primary" : ""}`
                + `${skydome.visible === false ? " is-hidden" : ""}`,
        );
        card.tabIndex = 0;
        card.dataset.skydomeId = skydome.skydome_id || "";
        const thumbnail = element("img", "vnccs-i3s__object-thumb");
        thumbnail.src = apiUrl(skydome.url);
        thumbnail.alt = "";
        thumbnail.loading = "lazy";
        thumbnail.decoding = "async";
        thumbnail.width = 36;
        thumbnail.height = 36;
        const copy = element("div", "vnccs-i3s__object-copy");
        const name = element("div", "vnccs-i3s__object-name", skydome.name || "Skydome");
        name.title = "Double-click to rename";
        name.tabIndex = 0;
        name.setAttribute("role", "button");
        const beginRename = event => {
            event.stopPropagation();
            this._beginInlineRename(name, skydome.name || "Skydome", next => {
                skydome.name = next;
                this._syncSkydome();
                this._renderObjects();
                this._commitSkydome({ final: true });
            });
        };
        name.addEventListener("dblclick", beginRename);
        name.addEventListener("keydown", event => {
            if (event.key === "Enter" || event.key === "F2") {
                event.preventDefault();
                beginRename(event);
            }
        });
        copy.append(
            name,
            element(
                "div",
                "vnccs-i3s__object-meta",
                `Skydome · ${Number(skydome.width || 0).toLocaleString()} × ${Number(skydome.height || 0).toLocaleString()}`,
            ),
        );
        const actions = element("div", "vnccs-i3s__object-actions");
        const visibility = button(
            "vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__icon-button",
            "",
            skydome.visible === false ? "eyeOff" : "eye",
        );
        visibility.title = skydome.visible === false ? "Show skydome" : "Hide skydome";
        visibility.addEventListener("click", event => {
            event.stopPropagation();
            skydome.visible = skydome.visible === false;
            this._syncSkydome();
            this._commitSkydome({ final: true });
            this._updateSceneSummary();
            this._renderObjects();
        });
        const save = button(
            "vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__icon-button",
            "",
            "library",
        );
        save.title = "Save skydome to library";
        save.addEventListener("click", event => {
            event.stopPropagation();
            this.openSaveLibraryModal("skydome", "");
        });
        const remove = button(
            "vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__button--danger vnccs-i3s__icon-button",
            "",
            "trash",
        );
        remove.title = "Remove skydome";
        remove.addEventListener("click", event => {
            event.stopPropagation();
            void this.removeSkydome();
        });
        for (const control of [visibility, save, remove]) {
            control.setAttribute("aria-label", control.title);
            control.addEventListener("dblclick", event => event.stopPropagation());
        }
        actions.append(visibility, save, remove);
        card.append(thumbnail, copy, actions);
        card.addEventListener("click", event => {
            if (event.target.closest("button,input")) return;
            this._selectSkydome();
            this._setSkydomePanelOpen(true);
        });
        card.addEventListener("keydown", event => {
            if (event.target === card && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                this._selectSkydome();
                this._setSkydomePanelOpen(true);
            }
        });
        return card;
    }

    _createObjectCard(item, groupId) {
        const viewportFailure = this.viewportFailures.get(item.object_id) || "";
        const selected = this.selectedObjectIds.has(item.object_id);
        const card = element(
            "div",
            `vnccs-i3s__object`
                + `${selected ? " is-selected" : ""}`
                + `${item.object_id === this.selectedObjectId ? " is-primary" : ""}`
                + `${item.visible === false ? " is-hidden" : ""}`
                + `${viewportFailure ? " has-viewport-error" : ""}`,
        );
        card.tabIndex = 0;
        card.draggable = true;
        card.dataset.objectId = item.object_id;
        card.dataset.groupId = groupId;
        if (viewportFailure) card.title = `Viewport failed: ${viewportFailure}`;
        const thumbnail = element("img", "vnccs-i3s__object-thumb");
        thumbnail.src = apiUrl(item.urls.thumbnail);
        thumbnail.alt = "";
        thumbnail.loading = "lazy";
        thumbnail.decoding = "async";
        thumbnail.width = 36;
        thumbnail.height = 36;
        const copy = element("div", "vnccs-i3s__object-copy");
        const name = element("div", "vnccs-i3s__object-name", item.name);
        name.title = "Double-click to rename";
        name.tabIndex = 0;
        name.setAttribute("role", "button");
        name.setAttribute("aria-label", `Rename ${item.name}`);
        const beginRename = event => {
            event.stopPropagation();
            this._beginInlineRename(name, item.name, next => {
                item.name = next;
                this.viewer.updateObject(item.object_id, { name: next });
                this._renderObjects();
                this._scheduleSceneSave(0);
                this._scheduleStateSave(0);
            });
        };
        name.addEventListener("dblclick", beginRename);
        name.addEventListener("keydown", event => {
            if (event.key === "Enter" || event.key === "F2") {
                event.preventDefault();
                beginRename(event);
            }
        });
        const conditioning = Number(
            item.settings?.effective_conditioning_resolution
            || item.settings?.conditioning_resolution,
        );
        const importedPly = item.source?.type === "ply_import"
            || item.settings?.source === "ply_import";
        copy.append(
            name,
            element(
                "div",
                "vnccs-i3s__object-meta",
                [
                    viewportFailure ? "Viewport failed" : "",
                    `${Number(item.gaussians || 0).toLocaleString()} splats`,
                    importedPly ? "Imported PLY" : "",
                    conditioning ? `${conditioning}² input` : "",
                    !importedPly && item.seed !== undefined ? `seed ${item.seed}` : "",
                ].filter(Boolean).join(" · "),
            ),
        );
        const actions = element("div", "vnccs-i3s__object-actions");
        const visibility = button(
            "vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__icon-button",
            "",
            item.visible === false ? "eyeOff" : "eye",
        );
        visibility.title = item.visible === false ? "Show object" : "Hide object";
        visibility.addEventListener("click", event => {
            event.stopPropagation();
            item.visible = item.visible === false;
            this.viewer.applySceneVisibility(this.scene);
            this._updateSceneSummary();
            this._renderObjects();
            this._scheduleSceneSave(0);
            this._scheduleStateSave(0);
            this._scheduleScenePreview(120);
        });
        const exportObject = button(
            "vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__icon-button",
            "",
            "download",
        );
        exportObject.title = "Export transformed PLY";
        exportObject.addEventListener("click", event => {
            event.stopPropagation();
            void this.exportObject(item, exportObject);
        });
        const duplicate = button("vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__icon-button", "", "duplicate");
        duplicate.title = "Duplicate object";
        duplicate.addEventListener("click", event => {
            event.stopPropagation();
            void this.duplicateObject(item.object_id, duplicate);
        });
        const remove = button(
            "vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__button--danger vnccs-i3s__icon-button",
            "",
            "trash",
        );
        remove.title = "Remove object";
        remove.addEventListener("click", event => {
            event.stopPropagation();
            this.confirmDeleteObject(item.object_id);
        });
        for (const control of [visibility, exportObject, duplicate, remove]) {
            control.setAttribute("aria-label", control.title);
            control.addEventListener("dblclick", event => event.stopPropagation());
        }
        actions.append(visibility, exportObject, duplicate, remove);
        card.append(thumbnail, copy, actions);
        card.addEventListener("click", event => {
            if (event.target.closest("button,input")) return;
            this._selectObject(item.object_id, { additive: event.shiftKey });
        });
        card.addEventListener("keydown", event => {
            if (event.target === card && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                this._selectObject(item.object_id, { additive: event.shiftKey });
            }
        });
        this._attachLayerDrag(card, { type: "object", id: item.object_id }, {
            type: "object",
            id: item.object_id,
            groupId,
        });
        return card;
    }

    _createGroupCard(group) {
        const card = element(
            "div",
            `vnccs-i3s__group-card${group.group_id === this.selectedGroupId ? " is-selected" : ""}`,
        );
        card.tabIndex = 0;
        card.draggable = true;
        card.dataset.groupId = group.group_id;
        const chevron = button("vnccs-i3s__group-toggle", "", "chevron");
        const collapsed = this.collapsedGroupIds.has(group.group_id);
        chevron.title = collapsed ? "Expand group" : "Collapse group";
        chevron.setAttribute("aria-expanded", String(!collapsed));
        chevron.addEventListener("click", event => {
            event.stopPropagation();
            if (this.collapsedGroupIds.has(group.group_id)) this.collapsedGroupIds.delete(group.group_id);
            else this.collapsedGroupIds.add(group.group_id);
            this._renderObjects();
            this._scheduleStateSave();
        });
        const folder = element("span", "vnccs-i3s__group-icon");
        folder.innerHTML = ICONS.folder;
        const copy = element("div", "vnccs-i3s__object-copy");
        const name = element("div", "vnccs-i3s__object-name", group.name);
        name.title = "Double-click to rename";
        name.tabIndex = 0;
        name.setAttribute("role", "button");
        name.setAttribute("aria-label", `Rename ${group.name}`);
        const beginRename = event => {
            event.stopPropagation();
            this._beginInlineRename(name, group.name, next => {
                group.name = next;
                this._renderObjects();
                this._scheduleSceneSave(0);
                this._scheduleStateSave(0);
            });
        };
        name.addEventListener("dblclick", beginRename);
        name.addEventListener("keydown", event => {
            if (event.key === "Enter" || event.key === "F2") {
                event.preventDefault();
                beginRename(event);
            }
        });
        copy.append(
            name,
            element(
                "div",
                "vnccs-i3s__object-meta",
                `${group.children.length} object${group.children.length === 1 ? "" : "s"}`,
            ),
        );
        const actions = element("div", "vnccs-i3s__object-actions");
        const visibility = button(
            "vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__icon-button",
            "",
            group.visible === false ? "eyeOff" : "eye",
        );
        visibility.title = group.visible === false ? "Show group" : "Hide group";
        visibility.addEventListener("click", event => {
            event.stopPropagation();
            const nextVisible = group.visible === false;
            group.visible = nextVisible;
            this.viewer.setGroupVisibility(
                group.group_id,
                group.children,
                nextVisible,
                this.scene,
            );
            this._updateSceneSummary();
            this._renderObjects();
            this._scheduleSceneSave(0);
            this._scheduleStateSave(0);
            this._scheduleScenePreview(120);
        });
        const ungroup = button(
            "vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__icon-button",
            "",
            "ungroup",
        );
        ungroup.title = "Ungroup objects";
        ungroup.addEventListener("click", event => {
            event.stopPropagation();
            this.ungroupObjects(group.group_id);
        });
        for (const control of [chevron, visibility, ungroup]) {
            control.setAttribute("aria-label", control.title);
            control.addEventListener("dblclick", event => event.stopPropagation());
        }
        actions.append(visibility, ungroup);
        card.append(chevron, folder, copy, actions);
        card.addEventListener("click", event => {
            if (!event.target.closest("button,input")) this._selectGroup(group.group_id);
        });
        card.addEventListener("keydown", event => {
            if (event.target === card && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                this._selectGroup(group.group_id);
            }
        });
        this._attachLayerDrag(card, { type: "group", id: group.group_id }, {
            type: "group",
            id: group.group_id,
        });
        return card;
    }

    _beginInlineRename(label, current, commit) {
        if (label.querySelector("input")) return;
        const card = label.closest(".vnccs-i3s__object, .vnccs-i3s__group-card");
        if (card) card.draggable = false;
        const input = element("input", "vnccs-i3s__inline-name");
        input.value = current;
        input.maxLength = 80;
        label.replaceChildren(input);
        input.focus();
        input.select();
        let finished = false;
        const finish = cancel => {
            if (finished) return;
            finished = true;
            if (card) card.draggable = true;
            const next = input.value.trim();
            if (!cancel && next && next !== current) commit(next);
            else this._renderObjects();
        };
        input.addEventListener("keydown", event => {
            event.stopPropagation();
            if (event.key === "Enter") {
                event.preventDefault();
                finish(false);
            } else if (event.key === "Escape") {
                event.preventDefault();
                finish(true);
            }
        });
        input.addEventListener("click", event => event.stopPropagation());
        input.addEventListener("dblclick", event => event.stopPropagation());
        input.addEventListener("blur", () => finish(false), { once: true });
    }

    _attachLayerDrag(card, source, target) {
        card.addEventListener("dragstart", event => {
            if (event.target.closest("button,input")) {
                event.preventDefault();
                return;
            }
            this.dragLayer = source;
            card.classList.add("is-dragging");
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", `${source.type}:${source.id}`);
        });
        card.addEventListener("dragend", () => {
            this.dragLayer = null;
            card.classList.remove("is-dragging");
            this._clearLayerDropMarkers();
        });
        card.addEventListener("dragover", event => {
            if (!this.dragLayer || (
                this.dragLayer.type === target.type && this.dragLayer.id === target.id
            )) return;
            const placement = this._layerDropPlacement(card, event, target);
            if (!placement) return;
            event.preventDefault();
            event.stopPropagation();
            this._markLayerDrop(card, placement);
            event.dataTransfer.dropEffect = "move";
        });
        card.addEventListener("dragleave", event => {
            if (!card.contains(event.relatedTarget)) {
                card.classList.remove("drop-before", "drop-after", "drop-inside");
            }
        });
        card.addEventListener("drop", event => {
            if (!this.dragLayer) return;
            const placement = this._layerDropPlacement(card, event, target);
            if (!placement) return;
            event.preventDefault();
            event.stopPropagation();
            this._moveLayer(this.dragLayer, target, placement);
        });
    }

    _layerDropPlacement(card, event, target) {
        const source = this.dragLayer;
        if (!source) return "";
        const rect = card.getBoundingClientRect();
        const ratio = (event.clientY - rect.top) / Math.max(1, rect.height);
        if (target.type === "group") {
            if (source.type === "object" && ratio >= 0.25 && ratio <= 0.75) return "inside";
            return ratio < 0.5 ? "before" : "after";
        }
        if (source.type === "group" && target.groupId) return "";
        return ratio < 0.5 ? "before" : "after";
    }

    _clearLayerDropMarkers() {
        this.els.objectList.querySelectorAll(
            ".drop-before,.drop-after,.drop-inside",
        ).forEach(node => node.classList.remove(
            "drop-before",
            "drop-after",
            "drop-inside",
        ));
    }

    _markLayerDrop(card, placement) {
        this._clearLayerDropMarkers();
        card.classList.add(`drop-${placement}`);
    }

    _removeLayerSource(source, layers = this.scene?.layers || []) {
        if (source.type === "group") {
            const index = layers.findIndex(
                layer => layer.type === "group" && layer.group_id === source.id,
            );
            return index >= 0 ? layers.splice(index, 1)[0] : null;
        }
        for (let index = 0; index < layers.length; index += 1) {
            const layer = layers[index];
            if (layer.type === "object" && layer.object_id === source.id) {
                layers.splice(index, 1);
                return { type: "object", object_id: source.id };
            }
            if (layer.type === "group") {
                const childIndex = layer.children.indexOf(source.id);
                if (childIndex >= 0) {
                    layer.children.splice(childIndex, 1);
                    return { type: "object", object_id: source.id };
                }
            }
        }
        return null;
    }

    _moveLayer(source, target, placement) {
        if (!source || (target && source.type === target.type && source.id === target.id)) return;
        const visibleBefore = this._effectiveVisibleObjectIds();
        const layers = this._normalizeSceneLayers();
        const node = this._removeLayerSource(source, layers);
        if (!node) return;
        if (!target || placement === "end") {
            layers.push(node);
        } else if (target.type === "group") {
            const index = layers.findIndex(
                layer => layer.type === "group" && layer.group_id === target.id,
            );
            if (index < 0) {
                layers.push(node);
            } else if (placement === "inside" && node.type === "object") {
                layers[index].children.push(node.object_id);
                this.collapsedGroupIds.delete(target.id);
            } else {
                layers.splice(index + (placement === "after" ? 1 : 0), 0, node);
            }
        } else {
            const group = target.groupId
                ? layers.find(
                    layer => layer.type === "group" && layer.group_id === target.groupId,
                )
                : null;
            if (group) {
                if (node.type !== "object") {
                    layers.push(node);
                } else {
                    const index = group.children.indexOf(target.id);
                    if (index < 0) layers.push(node);
                    else group.children.splice(
                        index + (placement === "after" ? 1 : 0),
                        0,
                        node.object_id,
                    );
                }
            } else {
                const index = layers.findIndex(
                    layer => layer.type === "object" && layer.object_id === target.id,
                );
                if (index < 0) layers.push(node);
                else layers.splice(index + (placement === "after" ? 1 : 0), 0, node);
            }
        }
        this.dragLayer = null;
        this._normalizeSceneLayers();
        const visibleAfter = this._effectiveVisibleObjectIds();
        const visibilityChanged = (
            visibleBefore.size !== visibleAfter.size
            || Array.from(visibleBefore).some(id => !visibleAfter.has(id))
        );
        if (visibilityChanged) {
            this.viewer.applySceneVisibility(this.scene);
            this._scheduleScenePreview(120);
        }
        this._updateSceneSummary();
        this._renderObjects();
        this._scheduleSceneSave(0);
        this._scheduleStateSave(0);
    }

    async groupSelectedObjects() {
        if (this.selectedObjectIds.size < 2 || !this.scene) return;
        const visibleBefore = this._effectiveVisibleObjectIds();
        const selected = new Set(this.selectedObjectIds);
        const ordered = [];
        const layers = this._normalizeSceneLayers();
        let insertion = layers.length;
        layers.forEach((layer, index) => {
            if (layer.type === "object" && selected.has(layer.object_id)) {
                ordered.push(layer.object_id);
                insertion = Math.min(insertion, index);
            } else if (layer.type === "group") {
                for (const objectId of layer.children) {
                    if (selected.has(objectId)) ordered.push(objectId);
                }
                if (layer.children.some(id => selected.has(id))) insertion = Math.min(insertion, index);
            }
        });
        for (const objectId of ordered) {
            this._removeLayerSource({ type: "object", id: objectId }, layers);
        }
        const group = {
            type: "group",
            group_id: randomLayerId(),
            name: `Group ${this.scene.layers.filter(layer => layer.type === "group").length + 1}`,
            visible: true,
            children: ordered,
        };
        layers.splice(Math.min(insertion, layers.length), 0, group);
        this.selectedObjectIds.clear();
        this.selectedObjectId = "";
        this.selectedSkydome = false;
        this.selectedGroupId = group.group_id;
        this.collapsedGroupIds.delete(group.group_id);
        const visibleAfter = this._effectiveVisibleObjectIds();
        const visibilityChanged = (
            visibleBefore.size !== visibleAfter.size
            || Array.from(visibleBefore).some(id => !visibleAfter.has(id))
        );
        if (visibilityChanged) {
            this.viewer.applySceneVisibility(this.scene);
            this._scheduleScenePreview(120);
        }
        this.viewer.selectGroup(group.group_id, group.children);
        this._updateSceneSummary();
        this._renderObjects();
        this._scheduleSceneSave(0);
        this._scheduleStateSave(0);
    }

    ungroupObjects(groupId) {
        const layers = this._normalizeSceneLayers();
        const index = layers.findIndex(
            layer => layer.type === "group" && layer.group_id === groupId,
        );
        if (index < 0) return;
        const visibleBefore = this._effectiveVisibleObjectIds();
        const [group] = layers.splice(index, 1);
        layers.splice(
            index,
            0,
            ...group.children.map(objectId => ({ type: "object", object_id: objectId })),
        );
        this.collapsedGroupIds.delete(groupId);
        this.selectedGroupId = "";
        this.selectedObjectIds = new Set(group.children);
        this.selectedObjectId = group.children[0] || "";
        this.selectedSkydome = false;
        const visibleAfter = this._effectiveVisibleObjectIds();
        const visibilityChanged = (
            visibleBefore.size !== visibleAfter.size
            || Array.from(visibleBefore).some(id => !visibleAfter.has(id))
        );
        if (visibilityChanged) {
            this.viewer.applySceneVisibility(this.scene);
            this._scheduleScenePreview(120);
        }
        this.viewer.select(this.selectedObjectId, { additive: true });
        this._updateSceneSummary();
        this._renderObjects();
        this._scheduleSceneSave(0);
        this._scheduleStateSave(0);
    }

    _onViewerTransform(objectId, transform, options = {}) {
        const item = this.scene?.objects?.find(value => value.object_id === objectId);
        if (!item) return;
        item.transform = transform;
        this._scheduleSceneSave(options.final ? 0 : 160);
        this._scheduleStateSave(options.final ? 0 : 160);
        this._scheduleScenePreview(options.final ? 120 : 420);
    }

    _scenePayload() {
        const camera = this.selectedCameraId
            ? this.scene?.camera
            : this.viewer?.getCameraState?.() || this.viewerState.camera;
        return {
            name: this.els.sceneName.value.trim() || this.scene?.name || "Untitled scene",
            render: { ...this.exportSettings },
            lighting: { ...this.lighting },
            skydome: this.scene?.skydome
                ? {
                    name: this.scene.skydome.name,
                    visible: this.scene.skydome.visible !== false,
                    yaw: this.scene.skydome.yaw,
                    pitch: this.scene.skydome.pitch,
                    roll: this.scene.skydome.roll,
                    exposure: this.scene.skydome.exposure,
                    blur: this.scene.skydome.blur,
                }
                : undefined,
            camera: camera ? { ...camera } : undefined,
            cameras: this._normalizeSceneCameras(this.scene?.cameras).map(saved => ({
                ...saved,
                position: [...saved.position],
                target: [...saved.target],
                up: [...saved.up],
            })),
            objects: (this.scene?.objects || []).map(item => ({
                object_id: item.object_id,
                name: item.name,
                transform: item.transform,
                visible: item.visible !== false,
            })),
            layers: this._normalizeSceneLayers().map(layer => ({
                ...layer,
                children: layer.type === "group" ? [...layer.children] : undefined,
            })),
        };
    }

    _scheduleSceneSave(delay = 180) {
        clearTimeout(this._sceneSaveTimer);
        this._sceneSaveTimer = setTimeout(
            () => void this._saveSceneNow().catch(() => {}),
            delay,
        );
    }

    async _saveSceneNow({ showError = true } = {}) {
        clearTimeout(this._sceneSaveTimer);
        this._sceneSaveTimer = 0;
        if (!this.sceneId || !this.scene) return;
        this.scene.name = this.els.sceneName.value.trim() || this.scene.name || "Untitled scene";
        const sceneId = this.sceneId;
        const payload = this._scenePayload();
        const operation = this._sceneSaveSerial.then(async () => {
            const updated = await this._fetchJSON(ENDPOINTS.scene(sceneId), {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            if (this.sceneId === sceneId && this.scene) {
                this.scene.revision = updated.revision;
                this.scene.render_revision = updated.render_revision;
                this.scene.updated_at = updated.updated_at;
                this.scene.exports = updated.exports;
                this.scene.render = updated.render || this.scene.render;
                this.scene.camera = updated.camera || this.scene.camera;
                this.scene.cameras = this._normalizeSceneCameras(
                    updated.cameras || this.scene.cameras,
                );
                this.scene.lighting = updated.lighting || this.scene.lighting;
                this.scene.skydome = updated.skydome || this.scene.skydome;
            }
            this._scheduleStateSave(0);
            return updated;
        });
        // Always keep the internal queue usable after a failed request while
        // still returning the original rejection to the current caller.
        this._sceneSaveSerial = operation.catch(() => null);
        try {
            return await operation;
        } catch (error) {
            if (showError) this._showError("Scene save failed", error);
            throw error;
        }
    }

    _scheduleScenePreview(delay = 480) {
        if (this._isRestoring || this.destroyed || !this.sceneId || !this._hasRenderableScene()) return;
        clearTimeout(this._previewSaveTimer);
        if (this._previewIdleHandle && typeof cancelIdleCallback === "function") {
            cancelIdleCallback(this._previewIdleHandle);
        }
        this._previewIdleHandle = 0;
        const idleDelay = Math.max(1000, Number(delay) || 0);
        this._previewSaveTimer = setTimeout(
            () => {
                this._previewSaveTimer = 0;
                if (
                    document.visibilityState === "hidden"
                    || !this.viewer?.isViewportVisible?.()
                ) {
                    return;
                }
                const save = () => {
                    this._previewIdleHandle = 0;
                    void this._saveScenePreviewNow({ automatic: true }).catch(() => {});
                };
                if (typeof requestIdleCallback === "function") {
                    this._previewIdleHandle = requestIdleCallback(save, { timeout: 8000 });
                } else {
                    save();
                }
            },
            idleDelay,
        );
    }

    async _saveScenePreviewNow({ captureToken = "", automatic = false } = {}) {
        clearTimeout(this._previewSaveTimer);
        this._previewSaveTimer = 0;
        if (this._previewIdleHandle && typeof cancelIdleCallback === "function") {
            cancelIdleCallback(this._previewIdleHandle);
        }
        this._previewIdleHandle = 0;
        if (this.destroyed || !this.sceneId || !this._hasRenderableScene()) return null;
        if (
            automatic
            && this.exportSettings.width * this.exportSettings.height > 2_200_000
        ) {
            // Exact large renders remain available through the execution
            // handshake, but should never appear as a surprise multi-megapixel
            // PNG encode during ordinary editing.
            return null;
        }
        const sceneId = this.sceneId;
        const operation = this._previewSaveSerial.then(async () => {
            if (this.destroyed || this.sceneId !== sceneId || !this._hasRenderableScene()) return null;
            // Commit transforms first so the preview revision always describes
            // the same scene state that the graph will export.
            const savedScene = await this._saveSceneNow({ showError: false });
            if (this.destroyed || this.sceneId !== sceneId) return null;
            const blob = await this.viewer.capturePreview({
                width: this.exportSettings.width,
                height: this.exportSettings.height,
            });
            if (!blob || this.destroyed || this.sceneId !== sceneId) return null;
            const form = new FormData();
            form.append("image", blob, "scene-preview.png");
            form.append("revision", String(savedScene.revision));
            form.append("render_revision", String(savedScene.render_revision));
            if (captureToken) form.append("capture_token", captureToken);
            const preview = await this._fetchJSON(ENDPOINTS.preview(sceneId), {
                method: "POST",
                body: form,
            });
            if (this.sceneId === sceneId && this.scene) this.scene.preview = preview;
            console.info("[VNCCS 3D Factory][viewport] Scene preview saved", {
                sceneId,
                revision: preview.revision,
                width: preview.width,
                height: preview.height,
                bytes: preview.size,
            });
            return preview;
        });
        this._previewSaveSerial = operation.catch(() => null);
        try {
            return await operation;
        } catch (error) {
            console.error("[VNCCS 3D Factory] 3D scene preview save failed", error);
            throw error;
        }
    }

    async _saveExecutionCaptureSet(captureToken) {
        clearTimeout(this._previewSaveTimer);
        this._previewSaveTimer = 0;
        const sceneId = this.sceneId;
        const operation = this._previewSaveSerial.then(async () => {
            if (this.destroyed || !sceneId || this.sceneId !== sceneId) return null;
            const savedScene = await this._saveSceneNow({ showError: false });
            if (this.destroyed || this.sceneId !== sceneId) return null;
            const cameras = this._normalizeSceneCameras(savedScene.cameras);
            const dimensions = {
                width: Number(savedScene.render?.width) || this.exportSettings.width,
                height: Number(savedScene.render?.height) || this.exportSettings.height,
            };
            const current = await this.viewer.capturePreview({
                ...dimensions,
                cameraState: this.viewer.getCameraState(),
            });
            if (!current) throw new Error("The current 3D view could not be captured.");
            const form = new FormData();
            form.append("current", current, "current.png");
            form.append(
                "camera_ids",
                JSON.stringify(cameras.map(camera => camera.camera_id)),
            );
            for (const camera of cameras) {
                const blob = await this.viewer.capturePreview({
                    ...dimensions,
                    cameraState: camera,
                });
                if (!blob) throw new Error(`${camera.name} could not be captured.`);
                form.append(`camera_${camera.camera_id}`, blob, `${camera.camera_id}.png`);
            }
            form.append("revision", String(savedScene.revision));
            form.append("render_revision", String(savedScene.render_revision));
            form.append("capture_token", captureToken);
            const result = await this._fetchJSON(ENDPOINTS.captureSet(sceneId), {
                method: "POST",
                body: form,
            });
            if (this.sceneId === sceneId && this.scene && result.preview) {
                this.scene.preview = result.preview;
            }
            return result;
        });
        this._previewSaveSerial = operation.catch(() => null);
        return await operation;
    }

    async _reportExecutionPreviewFailure(sceneId, captureToken, error) {
        if (!sceneId || !captureToken) return;
        try {
            await this._fetchJSON(ENDPOINTS.previewError(sceneId), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    capture_token: captureToken,
                    error: errorText(error, "3D viewport capture failed").slice(0, 2048),
                }),
            });
        } catch (reportError) {
            console.error("[VNCCS 3D Factory] Could not report preview sync failure", reportError);
        }
    }

    async _captureExecutionPreview(detail) {
        const sceneId = String(detail.scene_id || "");
        const captureToken = String(detail.capture_token || "");
        try {
            if (!/^[a-f0-9]{32}$/.test(sceneId) || !/^[a-f0-9]{32}$/.test(captureToken)) {
                throw new Error("Execution preview request has invalid identifiers.");
            }
            await this._restoreSerial;
            if (this.destroyed) throw new Error("3D Factory widget was disposed before capture.");
            if (this.sceneId !== sceneId) {
                throw new Error(
                    `The widget has scene ${this.sceneId || "none"} open; execution requested ${sceneId}.`,
                );
            }
            console.info("[VNCCS 3D Factory][viewport] Execution preview requested", {
                sceneId,
                captureToken,
                sceneRevision: detail.scene_revision,
                renderRevision: detail.render_revision,
                documentVisible: document.visibilityState,
            });
            const captureSet = await this._saveExecutionCaptureSet(captureToken);
            if (!captureSet) throw new Error("The 3D viewport returned no execution captures.");
            console.info("[VNCCS 3D Factory][viewport] Execution preview completed", {
                sceneId,
                captureToken,
                cameraCount: captureSet.camera_count,
                width: captureSet.preview?.width,
                height: captureSet.preview?.height,
            });
        } catch (error) {
            console.error("[VNCCS 3D Factory] Execution preview failed", {
                sceneId,
                captureToken,
                error,
                stack: error?.stack || "",
            });
            await this._reportExecutionPreviewFailure(sceneId, captureToken, error);
        }
    }

    async generate() {
        if (this.currentJobId) return;
        if (!this.sourceFile && !this.sourceAsset) {
            this.toast("Choose a reference image first.", "error");
            return;
        }
        const capabilities = this.capabilities || await this.loadCapabilities();
        if (!capabilities?.weights?.ready) {
            this.openModelSetup();
            return;
        }
        if (!this.sceneId) await this.ensureScene();
        if (this.settings.seed_mode === "randomize") {
            this.settings.seed = generateRandomSeed();
            this.els.seed.value = String(this.settings.seed);
            this._scheduleStateSave(0);
        }
        const form = new FormData();
        if (this.sourceFile) form.append("image", this.sourceFile, this.sourceFile.name);
        else form.append("use_scene_reference", "1");
        const sourceName = this.sourceFile?.name || this.sourceAsset?.name || "Object";
        form.append("name", this.settings.name || sourceName.replace(/\.[^.]+$/, ""));
        for (const key of [
            "steps",
            "guidance_scale",
            "num_gaussians",
            "conditioning_resolution",
            "seed",
        ]) {
            form.append(key, String(this.settings[key]));
        }
        form.append("prevent_upscale", this.settings.prevent_upscale ? "1" : "0");
        form.append("remove_background", this.settings.remove_background ? "1" : "0");
        try {
            const job = await this._fetchJSON(ENDPOINTS.generate(this.sceneId), { method: "POST", body: form });
            await this._monitorJob(job.job_id);
        } catch (error) {
            if (!error?.factoryErrorShown) this._showError("Generation failed", error);
        }
    }

    async importPly(file) {
        if (!file || this.currentJobId || this.importingPly) return;
        if (!/\.ply$/i.test(String(file.name || ""))) {
            this.toast("Choose a .ply Gaussian file.", "error");
            return;
        }
        if (!file.size || file.size > MAX_PLY_BYTES) {
            this.toast(`PLY files must be between 1 byte and ${formatBytes(MAX_PLY_BYTES)}.`, "error");
            return;
        }
        this.importingPly = true;
        this.els.plyImport.disabled = true;
        this._setStatus("Importing PLY", "working");
        try {
            if (!this.sceneId) await this.ensureScene();
            const sceneId = this.sceneId;
            const form = new FormData();
            form.append("ply", file, file.name || "model.ply");
            form.append("name", objectNameFromFileName(file.name));
            const result = await this._fetchJSON(ENDPOINTS.importObject(sceneId), {
                method: "POST",
                body: form,
            });
            if (this.sceneId !== sceneId) {
                this._setStatus("PLY imported", "success");
                this.toast("PLY was added to the scene where the import started.", "success");
                return;
            }
            await this._applyScene(result.scene, { preserveSource: true });
            this._selectObject(result.object_id);
            if (this.viewportFailures.has(result.object_id)) {
                this._setStatus("Imported; preview failed", "error");
                this.toast("PLY was added, but the viewport could not render it.", "error");
                return;
            }
            this.viewer.fit(result.object_id);
            this._scheduleScenePreview(120);
            this._scheduleStateSave(0);
            this._setStatus("PLY imported", "success");
            this.toast("PLY added to the active scene.", "success");
        } catch (error) {
            this._setStatus("PLY import failed", "error");
            this._showError("PLY could not be imported", error);
        } finally {
            this.importingPly = false;
            if (this.els.plyImport.isConnected) this.els.plyImport.disabled = false;
        }
    }

    async _monitorJob(jobId, { modal = false } = {}) {
        const token = ++this.currentJobToken;
        this.currentJobId = jobId;
        this._setProgress(true, 0, "Queued", "");
        this._setStatus("Working", "working");
        let previous = "";
        try {
            while (!this.destroyed && token === this.currentJobToken) {
                const job = await this._fetchJSON(ENDPOINTS.job(jobId));
                const signature = `${job.stage}|${job.progress}|${job.message}|${job.detail}`;
                if (signature !== previous) {
                    previous = signature;
                    console.info(`[VNCCS 3D Factory][${jobId.slice(0, 8)}]`, {
                        stage: job.stage,
                        progress: job.progress,
                        message: job.message,
                        detail: job.detail,
                    });
                }
                this._setProgress(true, job.progress, job.message || job.stage, job.detail);
                if (TERMINAL.has(job.status)) {
                    if (job.status === "completed") {
                        if (job.kind === "generation") {
                            const generatedObjectId = job.result?.object_id || "";
                            const generatedScene = safeObject(job.result?.scene);
                            const generatedSceneId = generatedScene.scene_id
                                || job.result?.scene_id
                                || this.sceneId;
                            this.selectedObjectId = generatedObjectId;
                            this.selectedObjectIds = new Set(
                                generatedObjectId ? [generatedObjectId] : [],
                            );
                            this.selectedGroupId = "";
                            this.selectedSkydome = false;
                            this._setStatus("Loading result", "working");
                            this._setProgress(
                                true,
                                100,
                                "Loading generated object",
                                "Backend generation completed · decoding SPLAT for the viewport",
                            );
                            const scene = generatedScene.scene_id
                                ? generatedScene
                                : await this._fetchJSON(ENDPOINTS.scene(generatedSceneId));
                            await this._applyScene(scene, { preserveSource: true });
                            this._scheduleStateSave(0);
                            this.toast("Object added to the scene.", "success");
                        } else if (job.kind === "weights") {
                            this._setStatus("Complete", "success");
                            await this.loadCapabilities();
                            this.closeModal();
                            this.toast("TripoSplat weights installed.", "success");
                        }
                        return job;
                    }
                    if (job.status === "cancelled") {
                        this._setStatus("Cancelled", "idle");
                        return job;
                    }
                    const error = new Error(job.error || "Factory job failed");
                    error.job = job;
                    throw error;
                }
                await sleep(600);
            }
        } catch (error) {
            this._setStatus("Failed", "error");
            this._showError(modal ? "Model installation failed" : "Generation failed", error, jobId);
            if (error && typeof error === "object") error.factoryErrorShown = true;
            throw error;
        } finally {
            if (token === this.currentJobToken) {
                this.currentJobId = "";
                this._setProgress(false);
            }
        }
    }

    async cancelJob() {
        if (!this.currentJobId) return;
        try {
            await this._fetchJSON(ENDPOINTS.cancelJob(this.currentJobId), { method: "POST" });
            this._setStatus("Cancelling", "working");
        } catch (error) {
            this._showError("Cancellation failed", error);
        }
    }

    async exportScene() {
        if (!this._effectiveVisibleObjectIds().size) {
            this.toast("Show at least one object before exporting the scene.", "error");
            return;
        }
        try {
            await this._saveSceneNow({ showError: false });
        } catch (error) {
            this._setStatus("Export failed", "error");
            this._showError("Scene export failed", error);
            return;
        }
        this._setStatus("Exporting scene", "working");
        try {
            const scene = await this._fetchJSON(ENDPOINTS.exportScene(this.sceneId), {
                method: "POST",
            });
            this.scene.exports = scene.exports;
            download(scene.exports.urls.ply);
            this._setStatus("Scene exported", "success");
        } catch (error) {
            this._setStatus("Export failed", "error");
            this._showError("Scene export failed", error);
        }
    }

    async exportObject(item, control = null) {
        const url = item?.urls?.export_ply;
        if (!url) {
            this.toast("PLY export is not available.", "error");
            return;
        }
        if (control) control.disabled = true;
        this._setStatus("Exporting PLY", "working");
        try {
            const response = await fetch(apiUrl(url), { credentials: "same-origin" });
            if (!response.ok) {
                let message = `${response.status} ${response.statusText}`;
                try {
                    const payload = await response.json();
                    message = payload.error || message;
                } catch (_) {}
                throw new Error(message);
            }
            const disposition = response.headers.get("Content-Disposition") || "";
            const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
            const plainName = disposition.match(/filename="?([^";]+)"?/i)?.[1];
            const filename = encodedName
                ? decodeURIComponent(encodedName)
                : plainName || `${item.name || "object"}.ply`;
            downloadBlob(await response.blob(), filename);
            this._setStatus("Object exported", "success");
        } catch (error) {
            this._setStatus("Export failed", "error");
            this._showError("Object export failed", error);
        } finally {
            if (control) control.disabled = false;
        }
    }

    async duplicateObject(objectId, control = null) {
        if (!this.sceneId || !objectId) return;
        if (control) control.disabled = true;
        this._setStatus("Duplicating object", "working");
        try {
            const result = await this._fetchJSON(
                `${ENDPOINTS.scene(this.sceneId)}/objects/${encodeURIComponent(objectId)}/duplicate`,
                { method: "POST" },
            );
            await this._applyScene(result.scene, { preserveSource: true });
            this._selectObject(result.object_id);
            this._setStatus("Object duplicated", "success");
            this.toast("Object duplicated.", "success");
        } catch (error) {
            if (control?.isConnected) control.disabled = false;
            this._setStatus("Duplicate failed", "error");
            this._showError("Object duplication failed", error);
        }
    }

    confirmDeleteObject(objectId = this.selectedObjectId) {
        const item = this.scene?.objects?.find(value => value.object_id === objectId);
        if (!item) return;
        const body = element("div");
        body.append(
            element("div", "vnccs-i3s__failure-summary", `Remove “${item.name}” from this scene?`),
            element("div", "vnccs-i3s__hint", "Its generated PLY, reference, and scene-specific exports will be deleted from the Factory scene."),
        );
        const cancel = button("vnccs-i3s__button", "Cancel");
        const remove = button("vnccs-i3s__button vnccs-i3s__button--danger", "Remove", "trash");
        cancel.addEventListener("click", () => this.closeModal());
        remove.addEventListener("click", async () => {
            remove.disabled = true;
            try {
                const scene = await this._fetchJSON(
                    `${ENDPOINTS.scene(this.sceneId)}/objects/${encodeURIComponent(item.object_id)}`,
                    { method: "DELETE" },
                );
                this.closeModal();
                await this._applyScene(scene);
            } catch (error) {
                remove.disabled = false;
                this._showError("Object removal failed", error);
            }
        });
        this.openModal({ title: "Remove object", body, actions: [cancel, remove], initialFocus: cancel });
    }

    async openSceneManager() {
        const body = element("div");
        const note = element("div", "vnccs-i3s__modal-note");
        note.innerHTML = `${ICONS.scenes}<span>Each scene keeps its own generated objects, transforms, and combined exports.</span>`;
        const cards = element("div", "vnccs-i3s__scene-cards");
        cards.appendChild(element("div", "vnccs-i3s__tree-empty", "Loading scenes…"));
        body.append(note, cards);
        const close = button("vnccs-i3s__button", "Close");
        const create = button("vnccs-i3s__button vnccs-i3s__button--primary", "New scene", "cube");
        close.addEventListener("click", () => this.closeModal());
        create.addEventListener("click", () => this.promptNewScene());
        this.openModal({ title: "Scene manager", body, actions: [close, create], wide: true });
        try {
            const data = await this._fetchJSON(ENDPOINTS.scenes);
            cards.replaceChildren();
            for (const scene of data.scenes || []) {
                const card = element("div", `vnccs-i3s__scene-card${scene.scene_id === this.sceneId ? " is-current" : ""}`);
                const copy = element("div");
                copy.append(
                    element("div", "vnccs-i3s__scene-card-name", scene.name),
                    element("div", "vnccs-i3s__scene-card-meta", `${scene.object_count} objects · #${scene.scene_id.slice(0, 8)}`),
                );
                const open = button("vnccs-i3s__button", scene.scene_id === this.sceneId ? "Current" : "Open");
                open.disabled = scene.scene_id === this.sceneId;
                open.addEventListener("click", async () => {
                    open.disabled = true;
                    try {
                        await this.loadScene(scene.scene_id);
                        this.closeModal();
                    } catch (error) {
                        open.disabled = false;
                        this._showError("Scene could not be opened", error);
                    }
                });
                const remove = button(
                    "vnccs-i3s__button vnccs-i3s__button--danger vnccs-i3s__icon-button",
                    "",
                    "trash",
                );
                remove.title = `Delete ${scene.name}`;
                remove.setAttribute("aria-label", `Delete ${scene.name}`);
                remove.addEventListener("click", () => {
                    if (this.skipSceneDeleteConfirmation) {
                        void this.deleteScene(scene, remove);
                    } else {
                        this.confirmDeleteScene(scene);
                    }
                });
                const actions = element("div", "vnccs-i3s__scene-card-actions");
                actions.append(open, remove);
                card.append(copy, actions);
                cards.appendChild(card);
            }
            if (!cards.children.length) cards.appendChild(element("div", "vnccs-i3s__tree-empty", "No saved scenes."));
        } catch (error) {
            cards.replaceChildren(element("div", "vnccs-i3s__tree-empty", errorText(error)));
        }
    }

    confirmDeleteScene(scene) {
        if (!scene?.scene_id) return;
        const body = element("div", "vnccs-i3s__delete-confirm");
        body.append(
            element(
                "div",
                "vnccs-i3s__failure-summary",
                `Permanently delete “${scene.name || "Untitled scene"}”?`,
            ),
            element(
                "div",
                "vnccs-i3s__hint",
                `${scene.object_count || 0} objects and all scene-specific references and exports will be deleted.`,
            ),
        );
        const option = element("label", "vnccs-i3s__delete-confirm-option");
        const skip = element("input");
        skip.type = "checkbox";
        option.append(
            skip,
            element("span", "", "Don’t ask again for scene deletions during this session"),
        );
        body.appendChild(option);
        const cancel = button("vnccs-i3s__button", "Cancel");
        const remove = button(
            "vnccs-i3s__button vnccs-i3s__button--danger",
            "Delete scene",
            "trash",
        );
        cancel.addEventListener("click", () => void this.openSceneManager());
        remove.addEventListener("click", async () => {
            remove.disabled = true;
            this.skipSceneDeleteConfirmation = skip.checked;
            await this.deleteScene(scene, remove);
        });
        this.openModal({
            title: "Delete scene",
            body,
            actions: [cancel, remove],
            initialFocus: cancel,
        });
    }

    async deleteScene(scene, control = null) {
        const sceneId = String(scene?.scene_id || "");
        if (!sceneId) return;
        if (control) control.disabled = true;
        const deletingCurrent = sceneId === this.sceneId;
        try {
            if (deletingCurrent) {
                clearTimeout(this._sceneSaveTimer);
                clearTimeout(this._previewSaveTimer);
                this._sceneSaveTimer = 0;
                this._previewSaveTimer = 0;
                await Promise.all([this._sceneSaveSerial, this._previewSaveSerial]);
            }
            await this._fetchJSON(ENDPOINTS.scene(sceneId), { method: "DELETE" });
        } catch (error) {
            if (control?.isConnected) control.disabled = false;
            this._showError("Scene deletion failed", error);
            return;
        }

        this.toast(`Scene “${scene?.name || "Untitled scene"}” deleted.`, "success");
        if (deletingCurrent) {
            clearTimeout(this._saveTimer);
            this._saveTimer = 0;
            this.sceneId = "";
            this.scene = null;
            this.selectedObjectId = "";
            this.selectedObjectIds.clear();
            this.selectedGroupId = "";
            this.selectedSkydome = false;
            this.collapsedGroupIds.clear();
            try {
                const data = await this._fetchJSON(ENDPOINTS.scenes);
                const nextScene = data.scenes?.[0];
                if (nextScene?.scene_id) {
                    await this.loadScene(nextScene.scene_id);
                } else {
                    await this.createScene("Untitled scene");
                }
            } catch (error) {
                await this.viewer.setScene({ objects: [], lighting: this.lighting });
                this._restoreSourceAsset(null);
                this.els.sceneName.value = "Untitled scene";
                this.els.sceneId.textContent = "";
                this._updateSceneSummary();
                this._renderObjects();
                this.syncToNode();
                this._showError("Scene deleted, but a replacement scene could not be opened", error);
                return;
            }
        }
        await this.openSceneManager();
    }

    _libraryItemQuery(item) {
        const query = new URLSearchParams({
            repository: item.repository || "",
            category: item.category || "",
        });
        return query.toString();
    }

    getLibraryThumbnailBounds() {
        return { min: 160, max: 520, defaultSize: 320 };
    }

    loadLibraryThumbnailSize() {
        const bounds = this.getLibraryThumbnailBounds();
        try {
            const stored = Number(localStorage.getItem(this.libraryThumbSizeStorageKey));
            if (Number.isFinite(stored)) return Math.max(bounds.min, Math.min(bounds.max, stored));
        } catch (_error) {}
        return bounds.defaultSize;
    }

    saveLibraryThumbnailSize(size) {
        const bounds = this.getLibraryThumbnailBounds();
        this.libraryThumbSize = Math.max(bounds.min, Math.min(bounds.max, Number(size) || bounds.defaultSize));
        try { localStorage.setItem(this.libraryThumbSizeStorageKey, String(this.libraryThumbSize)); } catch (_error) {}
        this.applyLibraryThumbnailSize();
    }

    applyLibraryThumbnailSize() {
        const target = this.libraryWorkspace || this.libraryGrid;
        if (!target) return;
        target.style.setProperty("--vnccs-ps-library-thumb-size", `${this.libraryThumbSize}px`);
        target.style.setProperty("--vnccs-ps-library-thumb-height", `${Math.round(this.libraryThumbSize * 1.3125)}px`);
        if (this.librarySizeValue) this.librarySizeValue.textContent = `${Math.round(this.libraryThumbSize)}`;
    }

    async openLibrary() {
        this.closeFactoryLibrary();
        const overlay = element("div", "vnccs-ps-modal-overlay vnccs-ps-library-overlay");
        const modal = element("div", "vnccs-ps-library-modal");
        modal.innerHTML = `
            <div class="vnccs-ps-library-modal-header">
                <div class="vnccs-ps-library-modal-title">📚 Model Library</div>
                <div class="vnccs-ps-library-header-actions">
                    <button class="vnccs-ps-btn primary vnccs-ps-library-save-current">
                        <span class="vnccs-ps-btn-icon">💾</span> Save Current Asset
                    </button>
                </div>
                <button class="vnccs-ps-modal-close" aria-label="Close">✕</button>
            </div>
            <div class="vnccs-ps-library-toolbar">
                <input class="vnccs-ps-library-search" type="search" placeholder="Search models, scenes, and tags...">
                <label class="vnccs-ps-library-size-control" title="Preview size">
                    <span>Preview</span>
                    <input class="vnccs-ps-library-size-slider" type="range" min="160" max="520" step="10">
                    <span class="vnccs-ps-library-size-value"></span>
                </label>
                <button class="vnccs-ps-library-menu-btn" title="Model library settings">⚙️</button>
            </div>
            <div class="vnccs-ps-library-categories"></div>
            <div class="vnccs-ps-library-workspace">
                <div class="vnccs-ps-library-modal-grid"></div>
                <aside class="vnccs-ps-library-inspector"></aside>
                <section class="vnccs-ps-library-settings"></section>
            </div>
        `;
        this.libraryModal = modal;
        this.libraryOverlay = overlay;
        this.libraryGrid = modal.querySelector(".vnccs-ps-library-modal-grid");
        this.libraryInspector = modal.querySelector(".vnccs-ps-library-inspector");
        this.libraryWorkspace = modal.querySelector(".vnccs-ps-library-workspace");
        this.librarySearchInput = modal.querySelector(".vnccs-ps-library-search");
        this.librarySizeInput = modal.querySelector(".vnccs-ps-library-size-slider");
        this.librarySizeValue = modal.querySelector(".vnccs-ps-library-size-value");
        this.libraryCategoriesEl = modal.querySelector(".vnccs-ps-library-categories");
        this.librarySettingsEl = modal.querySelector(".vnccs-ps-library-settings");
        this.librarySettingsMode = false;
        this.librarySearchInput.value = this.libraryQuery;
        this.librarySizeInput.value = String(this.libraryThumbSize);
        this.librarySizeInput.oninput = () => this.saveLibraryThumbnailSize(this.librarySizeInput.value);
        this.librarySearchInput.oninput = () => {
            this.libraryQuery = this.librarySearchInput.value;
            this.renderLibrary();
        };
        modal.querySelector(".vnccs-ps-modal-close").onclick = () => this.closeFactoryLibrary();
        modal.querySelector(".vnccs-ps-library-save-current").onclick = () => {
            const selectedObjectId = this.selectedObjectId;
            this.openSaveLibraryModal(
                this.selectedSkydome ? "skydome" : selectedObjectId ? "object" : "scene",
                selectedObjectId,
            );
        };
        modal.querySelector(".vnccs-ps-library-menu-btn").onclick = () => void this.toggleLibrarySettings();
        overlay.onclick = event => { if (event.target === overlay) this.closeFactoryLibrary(); };
        overlay.appendChild(modal);
        this.container.appendChild(overlay);
        this.applyLibraryThumbnailSize();
        this.startLibraryResizeObserver();
        this.libraryGrid.innerHTML = '<div class="vnccs-ps-library-empty">Loading library...</div>';
        await this.refreshLibrary();
    }

    closeFactoryLibrary() {
        this.libraryResizeObserver?.disconnect();
        this.libraryResizeObserver = null;
        this.libraryOverlay?.remove();
        this.libraryOverlay = null;
        this.libraryModal = null;
        this.libraryGrid = null;
        this.libraryInspector = null;
        this.libraryWorkspace = null;
    }

    startLibraryResizeObserver() {
        const update = () => {
            if (!this.libraryModal || !this.libraryWorkspace) return;
            const width = this.libraryModal.clientWidth || 1600;
            this.libraryModal.style.setProperty("--vnccs-ps-library-ui-scale", Math.max(.5, Math.min(1.4, width / 1600)).toFixed(3));
            const workspaceWidth = this.libraryWorkspace.clientWidth || 510;
            const workspaceHeight = this.libraryWorkspace.clientHeight || 900;
            const scale = Math.max(.45, Math.min(1, Math.min(510, workspaceWidth * .38) / 510, Math.max(420, workspaceHeight - 2) / 900));
            this.libraryWorkspace.style.setProperty("--vnccs-ps-library-inspector-scale", scale.toFixed(3));
        };
        if (typeof ResizeObserver !== "undefined") {
            this.libraryResizeObserver = new ResizeObserver(update);
            this.libraryResizeObserver.observe(this.libraryModal);
            this.libraryResizeObserver.observe(this.libraryWorkspace);
        }
        update();
    }

    async refreshLibrary() {
        try {
            const result = await this._fetchJSON(ENDPOINTS.libraryItems);
            if (result.schema !== GAUSSIAN_LIBRARY_SCHEMA) {
                throw new Error(
                    "The server returned a non-Gaussian library. Restart ComfyUI to load the 3D Factory library routes.",
                );
            }
            const received = Array.isArray(result.items) ? result.items : [];
            const rejected = received.filter(item => (
                !item
                || item.schema !== GAUSSIAN_LIBRARY_SCHEMA
                || !["object", "scene", "skydome"].includes(item.asset_type)
                || !/^[a-f0-9]{24}$/.test(String(item.asset_id || ""))
            ));
            if (rejected.length) {
                console.error("[VNCCS 3D Factory] Rejected non-Gaussian library records", {
                    rejected: rejected.length,
                    total: received.length,
                });
            }
            this.libraryItems = received.filter(item => (
                item
                && item.schema === GAUSSIAN_LIBRARY_SCHEMA
                && ["object", "scene", "skydome"].includes(item.asset_type)
                && /^[a-f0-9]{24}$/.test(String(item.asset_id || ""))
            ));
            this.renderLibrary();
            this.autoRefreshLibraryRepositories();
        } catch (error) {
            if (this.libraryGrid) this.libraryGrid.innerHTML = `<div class="vnccs-ps-library-empty">Failed to load library.<br>${escapeHTML(errorText(error))}</div>`;
        }
    }

    autoRefreshLibraryRepositories() {
        if (this._libraryAutoRefreshStarted) return;
        this._libraryAutoRefreshStarted = true;
        void (async () => {
            try {
                const result = await this._fetchJSON(ENDPOINTS.libraryRepositoryAutoRefresh, { method: "POST" });
                if (!result.task_id) return;
                await this._waitLibraryRepositoryTask(result.task_id);
                await this.refreshLibrary();
                if (this.librarySettingsMode) await this.renderLibraryRepositorySettings();
            } catch (error) {
                console.info("[VNCCS 3D Factory] Library repository refresh skipped", errorText(error));
            }
        })();
    }

    getFilteredLibraryItems() {
        const query = this.libraryQuery.trim().toLowerCase();
        return this.libraryItems.filter(item => {
            if (this.libraryActiveCategory !== "All" && (item.category || "Uncategorized") !== this.libraryActiveCategory) return false;
            if (!query) return true;
            return [item.name, item.asset_type, item.category, item.repository, ...(item.tags || [])]
                .join(" ").toLowerCase().includes(query);
        });
    }

    renderLibraryCategories() {
        if (!this.libraryCategoriesEl) return;
        const categories = Array.from(new Set(this.libraryItems.map(item => item.category || "Uncategorized"))).sort();
        const fragment = document.createDocumentFragment();
        for (const category of ["All", ...categories]) {
            const chip = element("button", `vnccs-ps-library-category-chip${category === this.libraryActiveCategory ? " active" : ""}`, category);
            chip.onclick = () => {
                this.libraryActiveCategory = category;
                this.renderLibrary();
            };
            fragment.appendChild(chip);
        }
        this.libraryCategoriesEl.replaceChildren(fragment);
    }

    renderLibrary() {
        if (!this.libraryGrid || this.librarySettingsMode) return;
        this.renderLibraryCategories();
        const items = this.getFilteredLibraryItems();
        this.libraryGrid.replaceChildren();
        if (!items.length) {
            this.libraryGrid.innerHTML = `<div class="vnccs-ps-library-empty">${this.libraryItems.length ? "No library items match this search." : "No saved assets.<br>Use Save Current Asset to add one."}</div>`;
            this.renderLibraryInspector(null);
            return;
        }
        const fragment = document.createDocumentFragment();
        for (const item of items) {
            const card = element("div", `vnccs-ps-library-item${item.asset_id === this.librarySelectedId ? " selected" : ""}`);
            card.dataset.assetId = item.asset_id;
            const preview = element("div", "vnccs-ps-library-item-preview");
            if (item.has_preview) {
                const image = element("img");
                image.src = apiUrl(item.preview_url);
                image.alt = item.name;
                image.loading = "lazy";
                image.decoding = "async";
                preview.appendChild(image);
            } else {
                preview.innerHTML = item.asset_type === "scene"
                    ? "<span>🎬</span>"
                    : item.asset_type === "skydome"
                        ? "<span>🌐</span>"
                        : "<span>🧊</span>";
            }
            const name = element("div", "vnccs-ps-library-item-name", item.name);
            card.append(preview);
            if (item.asset_type !== "object") {
                card.appendChild(element(
                    "div",
                    "vnccs-ps-library-item-type",
                    item.asset_type === "scene" ? "Scene" : "Skydome",
                ));
            }
            card.appendChild(name);
            card.onclick = () => {
                this.librarySelectedId = item.asset_id;
                this.renderLibrary();
                this.renderLibraryInspector(item);
            };
            card.ondblclick = () => void this.loadLibraryItem(item, card);
            fragment.appendChild(card);
        }
        this.libraryGrid.appendChild(fragment);
        this.renderLibraryInspector(items.find(item => item.asset_id === this.librarySelectedId) || null);
    }

    renderLibraryInspector(item) {
        if (!this.libraryInspector || !this.libraryWorkspace) return;
        if (!item) {
            this.libraryInspector.classList.remove("visible");
            this.libraryWorkspace.classList.remove("has-inspector");
            this.libraryInspector.innerHTML = '<div class="vnccs-ps-library-inspector-empty">Select an asset to inspect and load it.</div>';
            return;
        }
        this.libraryInspector.classList.add("visible");
        this.libraryWorkspace.classList.add("has-inspector");
        const preview = item.has_preview
            ? `<img src="${apiUrl(item.preview_url)}" alt="${escapeHTML(item.name)}" decoding="async">`
            : (
                item.asset_type === "scene"
                    ? "<span>🎬</span>"
                    : item.asset_type === "skydome"
                        ? "<span>🌐</span>"
                        : "<span>🧊</span>"
            );
        const applyLabel = item.asset_type === "scene"
            ? "Open Scene"
            : item.asset_type === "skydome"
                ? "Use Skydome"
                : "Add Model";
        const assetLabel = item.asset_type === "scene"
            ? "Scene"
            : item.asset_type === "skydome"
                ? "Skydome"
                : "Gaussian model";
        const local = item.repository === "local_user_models";
        const disabled = local ? "" : "disabled";
        this.libraryInspector.innerHTML = `
            <div class="vnccs-ps-library-inspector-inner">
                <div class="vnccs-ps-library-inspector-preview">${preview}</div>
                <div class="vnccs-ps-library-inspector-actions">
                    <button class="vnccs-ps-btn primary vnccs-ps-library-apply">${applyLabel}</button>
                    <button class="vnccs-ps-btn vnccs-ps-library-download">Download</button>
                </div>
                <label class="vnccs-ps-library-field"><span>Name</span><input class="vnccs-ps-input vnccs-ps-library-edit-name" type="text" value="${escapeHTML(item.name)}" ${disabled}></label>
                <label class="vnccs-ps-library-field"><span>Category</span><input class="vnccs-ps-input vnccs-ps-library-edit-category" type="text" value="${escapeHTML(item.category || "Uncategorized")}" ${disabled}></label>
                <label class="vnccs-ps-library-field"><span>Repository</span><input class="vnccs-ps-input" type="text" value="${escapeHTML(item.repository)}" disabled></label>
                <label class="vnccs-ps-library-field"><span>Tags</span><input class="vnccs-ps-input vnccs-ps-library-edit-tags" type="text" value="${escapeHTML((item.tags || []).join(", "))}" ${disabled}></label>
                <label class="vnccs-ps-library-field"><span>Description</span><textarea class="vnccs-ps-textarea vnccs-ps-library-edit-description" ${disabled}>${escapeHTML(item.description || "")}</textarea></label>
                <div class="vnccs-ps-library-system-tag">${assetLabel}${item.asset_type === "skydome" ? "" : ` · ${Number(item.gaussians || 0).toLocaleString()} splats`} · ${formatBytes(item.bytes)}</div>
                ${local ? `
                    <label class="vnccs-ps-library-field"><span>Custom Image</span><input class="vnccs-ps-library-preview-input" type="file" accept="image/*"></label>
                    <button class="vnccs-ps-btn primary vnccs-ps-library-save-edit">Save Changes</button>
                    <button class="vnccs-ps-btn danger vnccs-ps-library-delete">Delete</button>
                ` : ""}
            </div>
        `;
        this.libraryInspector.querySelector(".vnccs-ps-library-apply").onclick = event => void this.loadLibraryItem(item, event.currentTarget);
        this.libraryInspector.querySelector(".vnccs-ps-library-download").onclick = () => download(item.download_url);
        this.libraryInspector.querySelector(".vnccs-ps-library-delete")?.addEventListener("click", () => this.confirmDeleteLibraryItem(item));
        if (local) {
            let pendingPreview = "";
            const input = this.libraryInspector.querySelector(".vnccs-ps-library-preview-input");
            input.onchange = async event => {
                const file = event.target.files?.[0];
                if (!file) return;
                if (!file.type.startsWith("image/") || file.size > 16 * 1024 * 1024) {
                    this.toast("Preview must be an image smaller than 16 MB.", "error");
                    event.target.value = "";
                    return;
                }
                pendingPreview = await blobToDataURL(file);
                this.libraryInspector.querySelector(".vnccs-ps-library-inspector-preview").innerHTML =
                    `<img src="${pendingPreview}" alt="${escapeHTML(item.name)}">`;
            };
            this.libraryInspector.querySelector(".vnccs-ps-library-save-edit").onclick = async event => {
                const control = event.currentTarget;
                const name = this.libraryInspector.querySelector(".vnccs-ps-library-edit-name").value.trim();
                if (!name) return this.libraryInspector.querySelector(".vnccs-ps-library-edit-name").focus();
                control.disabled = true;
                try {
                    const result = await this._fetchJSON(
                        `${ENDPOINTS.libraryItem(item.asset_id)}?${this._libraryItemQuery(item)}`,
                        {
                            method: "PUT",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                repository: item.repository,
                                old_category: item.category,
                                name,
                                category: this.libraryInspector.querySelector(".vnccs-ps-library-edit-category").value.trim(),
                                tags: this.libraryInspector.querySelector(".vnccs-ps-library-edit-tags").value
                                    .split(",").map(value => value.trim()).filter(Boolean),
                                description: this.libraryInspector.querySelector(".vnccs-ps-library-edit-description").value.trim(),
                                preview: pendingPreview,
                            }),
                        },
                    );
                    this.libraryItems = this.libraryItems.map(value => value.asset_id === item.asset_id ? result.item : value);
                    this.librarySelectedId = result.item.asset_id;
                    this.renderLibrary();
                    this.toast("Library asset updated.", "success");
                } catch (error) {
                    control.disabled = false;
                    this._showError("Library asset could not be updated", error);
                }
            };
        }
    }

    async toggleLibrarySettings(force = null) {
        this.librarySettingsMode = force === null ? !this.librarySettingsMode : Boolean(force);
        this.libraryWorkspace?.classList.toggle("settings-mode", this.librarySettingsMode);
        if (this.librarySettingsMode) this.libraryWorkspace?.classList.remove("has-inspector");
        if (this.libraryCategoriesEl) this.libraryCategoriesEl.style.display = this.librarySettingsMode ? "none" : "";
        if (this.librarySearchInput) {
            this.librarySearchInput.disabled = this.librarySettingsMode;
            this.librarySearchInput.placeholder = this.librarySettingsMode
                ? "Repository settings"
                : "Search models, scenes, and tags...";
        }
        if (this.librarySettingsMode) await this.renderLibraryRepositorySettings();
        else this.renderLibrary();
    }

    async renderLibraryRepositorySettings() {
        if (!this.librarySettingsEl) return;
        this.librarySettingsEl.innerHTML = '<div class="vnccs-ps-library-empty">Loading repositories...</div>';
        try {
            const data = await this._fetchJSON(ENDPOINTS.libraryRepositories);
            const repos = Array.isArray(data.repositories) ? data.repositories : [];
            this.librarySettingsEl.innerHTML = `
                <div class="vnccs-ps-library-settings-head">
                    <div>
                        <div class="vnccs-ps-library-settings-title">Library Repositories</div>
                        <div class="vnccs-ps-library-settings-subtitle">Gaussian model and scene libraries on Hugging Face can be enabled, disabled, refreshed, or removed.</div>
                    </div>
                    <button class="vnccs-ps-btn vnccs-ps-library-settings-back">Back to library</button>
                </div>
                <div class="vnccs-ps-library-local-repo"></div>
                <div class="vnccs-ps-library-repo-notice"></div>
                <div class="vnccs-ps-library-repo-add">
                    <input class="vnccs-ps-input vnccs-ps-library-repo-input" type="text" placeholder="owner/repository">
                    <button class="vnccs-ps-btn primary vnccs-ps-library-repo-add-btn">Add Repository</button>
                </div>
                <div class="vnccs-ps-library-repo-list"></div>
            `;
            this.librarySettingsEl.querySelector(".vnccs-ps-library-settings-back").onclick = () => void this.toggleLibrarySettings(false);
            const notice = this.librarySettingsEl.querySelector(".vnccs-ps-library-repo-notice");
            const showNotice = (message, error = false) => {
                notice.textContent = message;
                notice.classList.toggle("error", error);
                notice.classList.add("visible");
            };
            const local = data.local || {};
            const localHolder = this.librarySettingsEl.querySelector(".vnccs-ps-library-local-repo");
            localHolder.innerHTML = `
                <div class="vnccs-ps-library-repo-card">
                    <div>
                        <div class="vnccs-ps-library-repo-title">Local Model Library</div>
                        <div class="vnccs-ps-library-repo-id">local_user_models → ${escapeHTML(local.publish_repo_id || "Not linked")}</div>
                        <div class="vnccs-ps-library-repo-meta">${Number(local.asset_count || 0)} models and scenes</div>
                    </div>
                    <div class="vnccs-ps-library-repo-actions">
                        <button class="vnccs-ps-library-repo-action primary publish">Publish</button>
                    </div>
                    ${this.libraryRepositoryProgressMarkup()}
                </div>
            `;
            localHolder.querySelector(".publish").onclick = async event => {
                const publishConfig = await this.requestLibraryPublishRepository(local);
                if (!publishConfig) return;
                event.currentTarget.disabled = true;
                try {
                    const result = await this._fetchJSON(ENDPOINTS.libraryRepositoryPublish, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(publishConfig),
                    });
                    await this._waitLibraryRepositoryTask(result.task_id, localHolder.querySelector(".vnccs-ps-library-repo-progress"));
                    showNotice(`Published local library to ${publishConfig.repo_id}.`);
                    await this.renderLibraryRepositorySettings();
                } catch (error) {
                    event.currentTarget.disabled = false;
                    showNotice(errorText(error), true);
                }
            };
            const list = this.librarySettingsEl.querySelector(".vnccs-ps-library-repo-list");
            if (!repos.length) list.innerHTML = '<div class="vnccs-ps-library-empty">No repositories configured.</div>';
            for (const repo of repos) {
                const card = element("div", "vnccs-ps-library-repo-card");
                card.innerHTML = `
                    <div>
                        <div class="vnccs-ps-library-repo-title">${escapeHTML(repo.title || repo.repo_id)}</div>
                        <div class="vnccs-ps-library-repo-id">${escapeHTML(repo.repo_id)}</div>
                        <div class="vnccs-ps-library-repo-meta">${Number(repo.asset_count || 0)} models and scenes · ${repo.enabled ? "enabled" : "disabled"}</div>
                    </div>
                    <div class="vnccs-ps-library-repo-actions">
                        <button class="vnccs-ps-library-repo-action toggle">${repo.enabled ? "Disable" : "Enable"}</button>
                        <button class="vnccs-ps-library-repo-action refresh">Refresh</button>
                        <button class="vnccs-ps-library-repo-action danger remove" ${repo.builtin ? "disabled" : ""}>Remove</button>
                    </div>
                    ${this.libraryRepositoryProgressMarkup()}
                `;
                card.querySelector(".toggle").onclick = async () => {
                    await this._fetchJSON(ENDPOINTS.libraryRepositoryToggle, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ repo_id: repo.repo_id, enabled: !repo.enabled }),
                    });
                    await this.renderLibraryRepositorySettings();
                };
                card.querySelector(".refresh").onclick = async () => {
                    const result = await this._fetchJSON(ENDPOINTS.libraryRepositoryRefresh, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ repo_ids: [repo.repo_id] }),
                    });
                    await this._waitLibraryRepositoryTask(result.task_id, card.querySelector(".vnccs-ps-library-repo-progress"));
                    await this.refreshLibrary();
                    await this.renderLibraryRepositorySettings();
                };
                card.querySelector(".remove").onclick = async () => {
                    await this._fetchJSON(`${ENDPOINTS.libraryRepositories}/${encodeURIComponent(repo.repo_id)}`, { method: "DELETE" });
                    await this.refreshLibrary();
                    await this.renderLibraryRepositorySettings();
                };
                list.appendChild(card);
            }
            const addInput = this.librarySettingsEl.querySelector(".vnccs-ps-library-repo-input");
            const addRepository = async () => {
                const repoId = addInput.value.trim();
                if (!repoId) return addInput.focus();
                try {
                    const result = await this._fetchJSON(ENDPOINTS.libraryRepositoryAdd, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ repo_id: repoId }),
                    });
                    await this._waitLibraryRepositoryTask(result.task_id);
                    await this.refreshLibrary();
                    await this.renderLibraryRepositorySettings();
                } catch (error) {
                    showNotice(errorText(error), true);
                }
            };
            this.librarySettingsEl.querySelector(".vnccs-ps-library-repo-add-btn").onclick = addRepository;
            addInput.onkeydown = event => { if (event.key === "Enter") void addRepository(); };
        } catch (error) {
            this.librarySettingsEl.innerHTML = `<div class="vnccs-ps-library-empty">Failed to load repositories.<br>${escapeHTML(errorText(error))}</div>`;
        }
    }

    libraryRepositoryProgressMarkup() {
        return `
            <div class="vnccs-ps-library-repo-progress">
                <div class="vnccs-ps-library-repo-progress-head">
                    <span class="vnccs-ps-library-repo-progress-message">Preparing...</span>
                    <span class="vnccs-ps-library-repo-progress-percent">0%</span>
                </div>
                <div class="vnccs-ps-library-repo-progress-track">
                    <div class="vnccs-ps-library-repo-progress-fill"></div>
                </div>
            </div>
        `;
    }

    requestLibraryPublishRepository(current = {}) {
        return new Promise(resolve => {
            const overlay = element("div", "vnccs-ps-modal-overlay");
            const modal = element("div", "vnccs-ps-modal");
            modal.style.maxWidth = "420px";
            modal.innerHTML = `
                <div class="vnccs-ps-modal-title">Publish Local Model Repository</div>
                <div class="vnccs-ps-modal-content">
                    <label class="vnccs-ps-library-field">
                        <span>Target</span>
                        <select class="vnccs-ps-input vnccs-ps-publish-mode">
                            <option value="create">Create new repository</option>
                            <option value="existing">Use existing repository</option>
                        </select>
                    </label>
                    <label class="vnccs-ps-library-field">
                        <span>Hugging Face repository</span>
                        <input class="vnccs-ps-input vnccs-ps-publish-repo" type="text" placeholder="owner/repository" value="${escapeHTML(current.publish_repo_id || "")}">
                    </label>
                    <label class="vnccs-ps-library-field vnccs-ps-publish-private-row">
                        <span>Visibility</span>
                        <label style="display:flex;align-items:center;gap:8px;color:var(--ps-text-muted);font-size:12px;">
                            <input class="vnccs-ps-publish-private" type="checkbox"> Private repository
                        </label>
                    </label>
                    <label class="vnccs-ps-library-field">
                        <span>HF token ${current.has_hf_token ? "(saved)" : ""}</span>
                        <input class="vnccs-ps-input vnccs-ps-publish-token" type="password" placeholder="${current.has_hf_token ? "Leave empty to use saved token" : "hf_..."}">
                    </label>
                </div>
                <button class="vnccs-ps-modal-btn primary" style="justify-content:center;">Publish</button>
                <button class="vnccs-ps-modal-btn cancel">Cancel</button>
            `;
            const mode = modal.querySelector(".vnccs-ps-publish-mode");
            const input = modal.querySelector(".vnccs-ps-publish-repo");
            const privateRow = modal.querySelector(".vnccs-ps-publish-private-row");
            mode.value = current.publish_repo_id ? "existing" : "create";
            const syncMode = () => { privateRow.style.display = mode.value === "create" ? "" : "none"; };
            mode.onchange = syncMode;
            syncMode();
            const close = value => {
                overlay.remove();
                resolve(value);
            };
            modal.querySelector(".primary").onclick = () => {
                const value = input.value.trim();
                if (!value) return input.focus();
                close({
                    repo_id: value,
                    hf_token: modal.querySelector(".vnccs-ps-publish-token").value.trim(),
                    create: mode.value === "create",
                    private: modal.querySelector(".vnccs-ps-publish-private").checked,
                });
            };
            modal.querySelector(".cancel").onclick = () => close(null);
            overlay.onclick = event => { if (event.target === overlay) close(null); };
            input.onkeydown = event => {
                if (event.key === "Enter") modal.querySelector(".primary").click();
                if (event.key === "Escape") close(null);
            };
            overlay.appendChild(modal);
            this.container.appendChild(overlay);
            requestAnimationFrame(() => input.focus());
        });
    }

    async loadLibraryItem(item, control) {
        if (!this.sceneId) return;
        control.disabled = true;
        this._setStatus("Loading library asset", "working");
        try {
            const result = await this._fetchJSON(ENDPOINTS.libraryLoad(item.asset_id), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    scene_id: this.sceneId,
                    repository: item.repository,
                    category: item.category,
                }),
            });
            this.closeFactoryLibrary();
            await this._applyScene(result.scene);
            if (result.skydome_id) {
                this._selectSkydome();
                this._setSkydomePanelOpen(true);
            } else if (result.object_id) {
                this._selectObject(result.object_id);
            }
            this.toast(
                result.created_scene
                    ? "Library scene opened."
                    : result.skydome_id
                        ? "Library skydome applied to scene."
                        : "Gaussian object added to scene.",
                "success",
            );
        } catch (error) {
            control.disabled = false;
            this._setStatus("Library load failed", "error");
            this._showError("Library asset could not be loaded", error);
        }
    }

    confirmDeleteLibraryItem(item) {
        const overlay = element("div", "vnccs-ps-modal-overlay");
        const modal = element("div", "vnccs-ps-modal");
        modal.innerHTML = `
            <div class="vnccs-ps-modal-title">Delete Library Asset</div>
            <div class="vnccs-ps-modal-content">
                <div>Delete “${escapeHTML(item.name)}” from the local model library?</div>
                <div style="color:var(--ps-text-muted)">The stored package and preview will be removed. Copies already loaded into scenes are not affected.</div>
            </div>
            <button class="vnccs-ps-modal-btn danger">Delete Asset</button>
            <button class="vnccs-ps-modal-btn cancel">Cancel</button>
        `;
        const cancel = modal.querySelector(".cancel");
        const remove = modal.querySelector(".danger");
        const close = () => overlay.remove();
        cancel.onclick = close;
        overlay.onclick = event => { if (event.target === overlay) close(); };
        remove.addEventListener("click", async () => {
            remove.disabled = true;
            cancel.disabled = true;
            try {
                await this._fetchJSON(
                    `${ENDPOINTS.libraryItem(item.asset_id)}?${this._libraryItemQuery(item)}`,
                    { method: "DELETE" },
                );
                close();
                this.toast("Library asset deleted.", "success");
                this.libraryItems = this.libraryItems.filter(value => value.asset_id !== item.asset_id);
                this.librarySelectedId = "";
                this.renderLibrary();
            } catch (error) {
                remove.disabled = false;
                cancel.disabled = false;
                this._showError("Library asset could not be deleted", error);
            }
        });
        overlay.appendChild(modal);
        this.container.appendChild(overlay);
    }

    openSaveLibraryModal(preferredType = "", requestedObjectId = this.selectedObjectId) {
        if (!this.scene?.objects?.length && !this.scene?.skydome) {
            this.toast("The current scene has no assets to save.", "error");
            return;
        }
        const selectedObjectId = String(requestedObjectId || "");
        const selected = this.scene.objects.find(
            item => item.object_id === selectedObjectId,
        ) || null;
        const initialType = preferredType === "skydome" && this.scene?.skydome
            ? "skydome"
            : preferredType === "scene" || !selected
                ? "scene"
                : "object";
        const overlay = element("div", "vnccs-ps-modal-overlay");
        const modal = element("div", "vnccs-ps-modal vnccs-ps-save-library-modal");
        modal.innerHTML = `
            <div class="vnccs-ps-modal-title">Save Model Library Asset</div>
            <div class="vnccs-ps-modal-content">
                <label class="vnccs-ps-save-library-field">
                    <span>Asset type</span>
                    <select data-role="type" class="vnccs-ps-input">
                        <option value="object" ${selected ? "" : "disabled"}>Selected model</option>
                        <option value="skydome" ${this.scene?.skydome ? "" : "disabled"}>Skydome</option>
                        <option value="scene">Complete scene</option>
                    </select>
                </label>
                <label class="vnccs-ps-save-library-field vnccs-ps-save-library-name-field">
                    <span>Name</span>
                    <input data-role="name" type="text" class="vnccs-ps-input" maxlength="96" autocomplete="off">
                    <span class="vnccs-ps-save-library-error" hidden>Name is required.</span>
                </label>
                <div class="vnccs-ps-save-library-meta">
                    <label class="vnccs-ps-save-library-field">
                        <span>Category</span>
                        <input data-role="category" type="text" class="vnccs-ps-input" value="Uncategorized" autocomplete="off">
                    </label>
                    <label class="vnccs-ps-save-library-field">
                        <span>Tags</span>
                        <input data-role="tags" type="text" placeholder="Comma separated" class="vnccs-ps-input" autocomplete="off">
                    </label>
                </div>
                <label class="vnccs-ps-save-library-field">
                    <span>Description</span>
                    <textarea data-role="description" class="vnccs-ps-textarea vnccs-ps-save-prompt" placeholder="Optional notes about this library asset"></textarea>
                </label>
                <label class="vnccs-ps-save-library-check">
                    <input data-role="preview" type="checkbox" checked> Include automatically rendered preview
                </label>
            </div>
            <div class="vnccs-ps-save-library-actions">
                <button type="button" class="vnccs-ps-modal-btn cancel">Cancel</button>
                <button type="button" class="vnccs-ps-modal-btn primary">Save to Library</button>
            </div>
        `;
        const type = modal.querySelector('[data-role="type"]');
        const name = modal.querySelector('[data-role="name"]');
        const category = modal.querySelector('[data-role="category"]');
        const tags = modal.querySelector('[data-role="tags"]');
        const description = modal.querySelector('[data-role="description"]');
        const includePreview = modal.querySelector('[data-role="preview"]');
        const save = modal.querySelector(".primary");
        const cancel = modal.querySelector(".cancel");
        const syncType = () => {
            name.value = type.value === "object"
                ? (selected?.name || "")
                : type.value === "skydome"
                    ? (this.scene?.skydome?.name || "Skydome")
                    : (this.scene?.name || "Untitled scene");
            modal.querySelector(".vnccs-ps-modal-title").textContent = type.value === "object"
                ? "Save Model"
                : type.value === "skydome"
                    ? "Save Skydome"
                    : "Save Scene";
        };
        type.value = initialType;
        type.onchange = syncType;
        syncType();
        const close = () => overlay.remove();
        cancel.onclick = close;
        overlay.onclick = event => { if (event.target === overlay) close(); };
        const submit = async () => {
            const assetType = type.value;
            const isObject = assetType === "object";
            const isSkydome = assetType === "skydome";
            if (!name.value.trim()) {
                modal.querySelector(".vnccs-ps-save-library-name-field").classList.add("invalid");
                modal.querySelector(".vnccs-ps-save-library-error").hidden = false;
                name.focus();
                return;
            }
            save.disabled = true;
            cancel.disabled = true;
            this._setStatus("Rendering library preview", "working");
            try {
                let preview = "";
                if (includePreview.checked) {
                    const blob = isObject
                        ? await this.viewer.captureObjectPreview(selectedObjectId, { width: 640, height: 640 })
                        : isSkydome
                            ? await this.viewer.captureSkydomePreview({ width: 640, height: 640 })
                            : await this.viewer.capturePreview({ width: 640, height: 640 });
                    preview = blob ? await blobToDataURL(blob) : "";
                }
                const result = await this._fetchJSON(ENDPOINTS.libraryItems, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        scene_id: this.sceneId,
                        object_id: isObject ? selectedObjectId : "",
                        asset_type: assetType,
                        name: name.value.trim(),
                        category: category.value.trim() || "Uncategorized",
                        description: description.value.trim(),
                        tags: tags.value.split(",").map(value => value.trim()).filter(Boolean),
                        preview,
                    }),
                });
                close();
                this.libraryItems.unshift(result.item);
                this.librarySelectedId = result.item.asset_id;
                this.renderLibrary();
                this.toast(
                    `${isObject ? "Model" : isSkydome ? "Skydome" : "Scene"} saved to library.`,
                    "success",
                );
                this._setStatus("Scene ready", "success");
            } catch (error) {
                save.disabled = false;
                cancel.disabled = false;
                this._setStatus("Library save failed", "error");
                this._showError("Could not save library asset", error);
            }
        };
        save.onclick = () => void submit();
        name.onkeydown = event => { if (event.key === "Enter") void submit(); };
        overlay.appendChild(modal);
        this.container.appendChild(overlay);
        requestAnimationFrame(() => {
            name.focus();
            name.select();
        });
    }

    async _waitLibraryRepositoryTask(taskId, progressEl) {
        while (!this.destroyed) {
            const status = await this._fetchJSON(ENDPOINTS.libraryRepositoryProgress(taskId));
            if (progressEl) {
                const percent = Math.round(Number(status.progress) || 0);
                progressEl.classList.add("visible");
                progressEl.classList.toggle("error", status.status === "error");
                progressEl.classList.toggle("success", status.status === "success");
                const message = progressEl.querySelector(".vnccs-ps-library-repo-progress-message");
                const percentEl = progressEl.querySelector(".vnccs-ps-library-repo-progress-percent");
                const fill = progressEl.querySelector(".vnccs-ps-library-repo-progress-fill");
                if (message) message.textContent = status.message || "Working...";
                if (percentEl) percentEl.textContent = `${percent}%`;
                if (fill) fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
            }
            if (status.status === "success") return status;
            if (status.status === "error") throw new Error(status.message || "Repository operation failed");
            await new Promise(resolve => setTimeout(resolve, 700));
        }
        throw new Error("Widget was closed");
    }

    async openLibraryRepositories() {
        return this.toggleLibrarySettings(true);
        /* Legacy implementation retained below only for workflow source compatibility. */
        const body = element("div", "vnccs-i3s__library-repositories");
        const progress = element("div", "vnccs-i3s__library-repo-progress", "Loading repositories…");
        body.appendChild(progress);
        const back = button("vnccs-i3s__button", "Back to library", "library");
        const close = button("vnccs-i3s__button", "Close");
        back.addEventListener("click", () => void this.openLibrary());
        close.addEventListener("click", () => this.closeModal());
        this.openModal({
            title: "Gaussian library repositories",
            body,
            actions: [back, close],
            wide: true,
        });
        try {
            const data = await this._fetchJSON(ENDPOINTS.libraryRepositories);
            body.replaceChildren();
            const local = element("section", "vnccs-i3s__library-repo is-local");
            const localCopy = element("div", "vnccs-i3s__library-repo-copy");
            localCopy.append(
                element("strong", "", "Local Gaussian Library"),
                element("span", "", `${Number(data.local?.asset_count || 0)} saved assets`),
            );
            const publishRow = element("div", "vnccs-i3s__library-repo-publish");
            const publishId = element("input", "vnccs-i3s__input");
            publishId.placeholder = "HuggingFace owner/repository";
            publishId.value = data.local?.publish_repo_id || "";
            const publish = button("vnccs-i3s__button vnccs-i3s__button--primary", "Publish", "upload");
            publish.disabled = !data.local?.has_hf_token;
            publish.title = data.local?.has_hf_token
                ? "Upload local packages, previews, and manifest"
                : "Configure the Hugging Face token in VNCCS settings first";
            publish.addEventListener("click", async () => {
                publish.disabled = true;
                try {
                    const result = await this._fetchJSON(ENDPOINTS.libraryRepositoryPublish, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ repo_id: publishId.value.trim() }),
                    });
                    await this._waitLibraryRepositoryTask(result.task_id, progress);
                    this.toast("Gaussian library published to Hugging Face.", "success");
                    await this.openLibraryRepositories();
                } catch (error) {
                    publish.disabled = false;
                    this._showError("Library publish failed", error);
                }
            });
            publishRow.append(publishId, publish);
            local.append(localCopy, publishRow);
            body.appendChild(local);

            const list = element("div", "vnccs-i3s__library-repo-list");
            for (const repo of data.repositories || []) {
                const card = element("section", "vnccs-i3s__library-repo");
                const copy = element("div", "vnccs-i3s__library-repo-copy");
                copy.append(
                    element("strong", "", repo.title || repo.repo_id),
                    element("span", "", `${repo.repo_id} · ${Number(repo.asset_count || 0)} assets`),
                    element("small", "", repo.description || "Hugging Face Gaussian asset repository"),
                );
                const actions = element("div", "vnccs-i3s__library-repo-actions");
                const toggle = button(
                    "vnccs-i3s__button",
                    repo.enabled ? "Enabled" : "Disabled",
                    repo.enabled ? "check" : "",
                );
                const refresh = button("vnccs-i3s__button", "Sync", "download");
                toggle.addEventListener("click", async () => {
                    await this._fetchJSON(ENDPOINTS.libraryRepositoryToggle, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ repo_id: repo.repo_id, enabled: !repo.enabled }),
                    });
                    await this.openLibraryRepositories();
                });
                refresh.addEventListener("click", async () => {
                    refresh.disabled = true;
                    try {
                        const result = await this._fetchJSON(ENDPOINTS.libraryRepositoryRefresh, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ repo_ids: [repo.repo_id] }),
                        });
                        await this._waitLibraryRepositoryTask(result.task_id, progress);
                        await this.openLibraryRepositories();
                    } catch (error) {
                        refresh.disabled = false;
                        this._showError("Repository sync failed", error);
                    }
                });
                actions.append(toggle, refresh);
                if (!repo.builtin) {
                    const remove = button("vnccs-i3s__button vnccs-i3s__button--danger", "", "trash");
                    remove.title = "Remove repository and downloaded assets";
                    remove.addEventListener("click", async () => {
                        await this._fetchJSON(
                            `${ENDPOINTS.libraryRepositories}/${encodeURIComponent(repo.repo_id)}`,
                            { method: "DELETE" },
                        );
                        await this.openLibraryRepositories();
                    });
                    actions.appendChild(remove);
                }
                card.append(copy, actions);
                list.appendChild(card);
            }
            body.appendChild(list);
            const add = element("section", "vnccs-i3s__library-repo-add");
            const addId = element("input", "vnccs-i3s__input");
            addId.placeholder = "owner/repository";
            const addButton = button("vnccs-i3s__button", "Add repository", "library");
            addButton.addEventListener("click", async () => {
                addButton.disabled = true;
                try {
                    const result = await this._fetchJSON(ENDPOINTS.libraryRepositoryAdd, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ repo_id: addId.value.trim() }),
                    });
                    await this._waitLibraryRepositoryTask(result.task_id, progress);
                    await this.openLibraryRepositories();
                } catch (error) {
                    addButton.disabled = false;
                    this._showError("Repository could not be added", error);
                }
            });
            add.append(addId, addButton);
            body.append(progress, add);
            progress.textContent = "Repository packages are synchronized by manifest and SHA256.";
        } catch (error) {
            body.replaceChildren(element("div", "vnccs-i3s__library-empty", errorText(error)));
        }
    }

    promptNewScene() {
        const body = element("label", "vnccs-i3s__field");
        body.appendChild(element("span", "vnccs-i3s__label", "Scene name"));
        const input = element("input", "vnccs-i3s__input");
        input.value = "Untitled scene";
        input.maxLength = 96;
        body.appendChild(input);
        const cancel = button("vnccs-i3s__button", "Cancel");
        const create = button("vnccs-i3s__button vnccs-i3s__button--primary", "Create", "check");
        cancel.addEventListener("click", () => this.closeModal());
        const submit = async () => {
            create.disabled = true;
            try { await this.createScene(input.value); }
            catch (error) {
                create.disabled = false;
                this._showError("Scene creation failed", error);
            }
        };
        create.addEventListener("click", submit);
        input.addEventListener("keydown", event => {
            if (event.key === "Enter") void submit();
        });
        this.openModal({ title: "New scene", body, actions: [cancel, create], initialFocus: input });
    }

    async openModelSetup(draftSettings = null) {
        const capabilities = await this.loadCapabilities();
        const weights = capabilities?.weights || { files: [] };
        const allowedResolutions = Array.isArray(capabilities?.conditioning_resolutions)
            ? capabilities.conditioning_resolutions.map(Number)
            : [1024, 1536, 2048];
        const initialResolution = allowedResolutions.includes(Number(
            draftSettings?.conditioning_resolution ?? this.settings.conditioning_resolution,
        ))
            ? Number(draftSettings?.conditioning_resolution ?? this.settings.conditioning_resolution)
            : 1024;
        let preventUpscale = Boolean(
            draftSettings?.prevent_upscale ?? this.settings.prevent_upscale,
        );
        let cacheStatus = safeObject(capabilities?.splat_cache);
        let cacheLimitGB = Math.round(clamp(
            draftSettings?.splat_cache_limit_gb
                ?? cacheStatus.limit_gb
                ?? this.settings.splat_cache_limit_gb
                ?? 32,
            1,
            1024,
        ));
        const body = element("div", "vnccs-i3s__setup-grid");

        const models = element("section", "vnccs-i3s__setup-block vnccs-i3s__setup-block--models");
        const modelsHead = element("div", "vnccs-i3s__setup-head");
        const modelsTitle = element("div");
        modelsTitle.append(
            element("div", "vnccs-i3s__setup-title", "Models"),
            element(
                "div",
                "vnccs-i3s__setup-subtitle",
                "Official weights in the ComfyUI model library.",
            ),
        );
        const modelAction = button(
            "vnccs-i3s__button vnccs-i3s__setup-action",
            weights.ready ? "Recheck" : "Download weights",
            weights.ready ? "check" : "download",
        );
        modelsHead.append(modelsTitle, modelAction);
        const root = element("div", "vnccs-i3s__failure-context", weights.root || "");
        const list = element("div", "vnccs-i3s__weight-list");
        for (const file of weights.files || []) {
            const row = element("div", "vnccs-i3s__weight");
            row.append(
                element("span", `vnccs-i3s__weight-dot${file.ready ? " is-ready" : ""}`),
                element("span", "vnccs-i3s__weight-path", file.path),
                element("span", "vnccs-i3s__object-meta", formatBytes(file.size)),
            );
            list.appendChild(row);
        }
        models.append(modelsHead, root, list);

        const inference = element("section", "vnccs-i3s__setup-block vnccs-i3s__setup-block--settings");
        const inferenceHead = element("div", "vnccs-i3s__setup-head");
        const inferenceTitle = element("div");
        inferenceTitle.append(
            element("div", "vnccs-i3s__setup-title", "Inference settings"),
            element(
                "div",
                "vnccs-i3s__setup-subtitle",
                "Image evidence supplied to DINOv3 and Flux VAE.",
            ),
        );
        inferenceHead.appendChild(inferenceTitle);

        const resolutionLabel = element("div", "vnccs-i3s__label", "Conditioning resolution");
        const resolutionList = element("div", "vnccs-i3s__resolution-list");
        const resolutionOptions = [
            {
                value: 1024,
                title: "1024 × 1024",
                badge: "Official",
                description: "Released and trained TripoSplat resolution.",
            },
            {
                value: 1536,
                title: "1536 × 1536",
                badge: "Experimental",
                description: "2.25× image tokens; higher compute and VRAM.",
            },
            {
                value: 2048,
                title: "2048 × 2048",
                badge: "Extreme",
                description: "4× image tokens; substantially slower attention.",
            },
        ];
        for (const option of resolutionOptions) {
            const choice = element("label", "vnccs-i3s__resolution-option");
            const input = element("input");
            input.type = "radio";
            input.name = "vnccs-triposplat-conditioning-resolution";
            input.value = String(option.value);
            input.checked = option.value === initialResolution;
            input.disabled = !allowedResolutions.includes(option.value);
            const copy = element("span", "vnccs-i3s__resolution-copy");
            const title = element("span", "vnccs-i3s__resolution-title");
            title.append(
                element("span", "", option.title),
                element(
                    "span",
                    `vnccs-i3s__resolution-badge${option.value > 1024 ? " is-experimental" : ""}`,
                    option.badge,
                ),
            );
            copy.append(
                title,
                element("span", "vnccs-i3s__resolution-description", option.description),
            );
            choice.append(input, element("span", "vnccs-i3s__resolution-radio"), copy);
            resolutionList.appendChild(choice);
        }

        const upscaleControl = element("div", "vnccs-i3s__setup-switch-card");
        const upscaleCopy = element("div");
        upscaleCopy.append(
            element("div", "vnccs-i3s__setup-switch-title", "Do not upscale smaller sources"),
            element(
                "div",
                "vnccs-i3s__setup-switch-description",
                "Cap conditioning to the source image’s native short side.",
            ),
        );
        const upscaleSwitch = button("vnccs-i3s__switch");
        upscaleSwitch.setAttribute("role", "switch");
        upscaleSwitch.setAttribute("aria-label", "Do not upscale smaller source images");
        upscaleSwitch.setAttribute("aria-checked", String(preventUpscale));
        upscaleControl.append(upscaleCopy, upscaleSwitch);
        const effective = element("div", "vnccs-i3s__conditioning-summary");
        const cache = element(
            "section",
            "vnccs-i3s__setup-block vnccs-i3s__setup-block--cache",
        );
        const cacheHead = element("div", "vnccs-i3s__setup-head");
        const cacheTitle = element("div");
        cacheTitle.append(
            element("div", "vnccs-i3s__setup-title", "SPLAT cache"),
            element(
                "div",
                "vnccs-i3s__setup-subtitle",
                "Realtime derivatives shared by identical PLY models.",
            ),
        );
        const clearCache = button(
            "vnccs-i3s__button vnccs-i3s__button--danger vnccs-i3s__setup-action",
            "Clear cache",
            "trash",
        );
        cacheHead.append(cacheTitle, clearCache);

        const cacheStats = element("div", "vnccs-i3s__cache-stats");
        const usedValue = element("strong", "", "0 B");
        const filesValue = element("strong", "", "0");
        const freeValue = element("strong", "", "—");
        for (const [label, value] of [
            ["Used", usedValue],
            ["Cached files", filesValue],
            ["Disk available", freeValue],
        ]) {
            const metric = element("div", "vnccs-i3s__cache-stat");
            metric.append(
                element("span", "", label),
                value,
            );
            cacheStats.appendChild(metric);
        }

        const cacheUsage = element("div", "vnccs-i3s__cache-usage");
        const cacheUsageBar = element("span", "vnccs-i3s__cache-usage-bar");
        cacheUsage.appendChild(cacheUsageBar);

        const cacheLimitLabel = element("div", "vnccs-i3s__label");
        cacheLimitLabel.append(
            element("span", "", "Cache limit"),
            element("span", "vnccs-i3s__cache-limit-caption", `${cacheLimitGB} GiB`),
        );
        const cacheLimitControls = element("div", "vnccs-i3s__cache-limit-controls");
        const cacheLimitRange = element("input", "vnccs-i3s__range");
        cacheLimitRange.type = "range";
        cacheLimitRange.min = "1";
        cacheLimitRange.max = "1024";
        cacheLimitRange.step = "1";
        cacheLimitRange.value = String(cacheLimitGB);
        cacheLimitRange.setAttribute("aria-label", "SPLAT cache limit in GiB");
        const cacheLimitInput = element("input", "vnccs-i3s__input");
        cacheLimitInput.type = "number";
        cacheLimitInput.min = "1";
        cacheLimitInput.max = "1024";
        cacheLimitInput.step = "1";
        cacheLimitInput.value = String(cacheLimitGB);
        cacheLimitControls.append(
            cacheLimitRange,
            cacheLimitInput,
            element("span", "vnccs-i3s__cache-unit", "GiB"),
        );
        const cacheHint = element(
            "div",
            "vnccs-i3s__cache-hint",
            "The cache is rebuilt from PLY when needed. Clearing it never removes models or scenes.",
        );

        const updateCacheStatus = value => {
            cacheStatus = safeObject(value);
            const used = Math.max(0, Number(cacheStatus.used_bytes) || 0);
            const limit = Math.max(1, Number(cacheStatus.limit_bytes) || cacheLimitGB * 1024 ** 3);
            usedValue.textContent = formatCacheBytes(used);
            filesValue.textContent = String(Math.max(0, Number(cacheStatus.file_count) || 0));
            freeValue.textContent = Number(cacheStatus.disk_free_bytes) > 0
                ? formatCacheBytes(cacheStatus.disk_free_bytes)
                : "—";
            cacheUsageBar.style.width = `${clamp(used / limit * 100, 0, 100)}%`;
            cacheUsage.title = `${formatCacheBytes(used)} of ${formatCacheBytes(limit)}`;
        };
        const syncCacheLimit = (value, source) => {
            cacheLimitGB = Math.round(clamp(value, 1, 1024));
            cacheLimitRange.value = String(cacheLimitGB);
            cacheLimitInput.value = String(cacheLimitGB);
            cacheLimitLabel.querySelector(".vnccs-i3s__cache-limit-caption").textContent =
                `${cacheLimitGB} GiB`;
            if (source === cacheLimitInput) cacheLimitInput.value = String(cacheLimitGB);
        };
        cacheLimitRange.addEventListener("input", () => {
            syncCacheLimit(cacheLimitRange.value, cacheLimitRange);
        });
        cacheLimitInput.addEventListener("change", () => {
            syncCacheLimit(cacheLimitInput.value, cacheLimitInput);
        });
        cache.append(
            cacheHead,
            cacheStats,
            cacheUsage,
            cacheLimitLabel,
            cacheLimitControls,
            cacheHint,
        );
        updateCacheStatus(cacheStatus);

        const selectedResolution = () => Number(
            resolutionList.querySelector("input:checked")?.value || 1024,
        );
        const currentDraft = () => ({
            conditioning_resolution: selectedResolution(),
            prevent_upscale: preventUpscale,
            splat_cache_limit_gb: cacheLimitGB,
        });
        const updateSummary = () => {
            const requested = selectedResolution();
            const sourceWidth = Number(this.sourceAsset?.width) || 0;
            const sourceHeight = Number(this.sourceAsset?.height) || 0;
            let effectiveResolution = requested;
            if (preventUpscale && sourceWidth && sourceHeight) {
                const native = Math.min(sourceWidth, sourceHeight);
                effectiveResolution = native < requested
                    ? Math.max(16, Math.floor(native / 16) * 16)
                    : requested;
            }
            effective.textContent = preventUpscale
                ? sourceWidth && sourceHeight
                    ? `Current source: ${sourceWidth}×${sourceHeight} · effective conditioning: ${effectiveResolution}×${effectiveResolution}.`
                    : "Smaller sources will use their native short-side resolution on a 16-pixel patch grid."
                : `Every source will be framed at ${requested}×${requested}, including smaller images.`;
            effective.dataset.tone = requested === 2048
                ? "extreme"
                : requested === 1536
                    ? "experimental"
                    : "official";
        };
        upscaleSwitch.addEventListener("click", () => {
            preventUpscale = !preventUpscale;
            upscaleSwitch.setAttribute("aria-checked", String(preventUpscale));
            updateSummary();
        });
        resolutionList.addEventListener("change", updateSummary);
        inference.append(
            inferenceHead,
            resolutionLabel,
            resolutionList,
            upscaleControl,
            effective,
        );
        body.append(models, inference, cache);

        const close = button("vnccs-i3s__button", "Close");
        const apply = button(
            "vnccs-i3s__button vnccs-i3s__button--primary",
            "Apply settings",
            "check",
        );
        close.addEventListener("click", () => this.closeModal());
        clearCache.addEventListener("click", async () => {
            clearCache.disabled = true;
            const label = clearCache.querySelector("span:last-child");
            if (label) label.textContent = "Clearing…";
            try {
                const result = await this._fetchJSON(
                    ENDPOINTS.splatCacheClear,
                    { method: "POST" },
                );
                updateCacheStatus(result);
                if (this.capabilities) this.capabilities.splat_cache = result;
                this.toast(
                    `SPLAT cache cleared · ${Number(result.deleted_files) || 0} files removed.`,
                    "success",
                );
            } catch (error) {
                this._showError("SPLAT cache cleanup failed", error);
            } finally {
                clearCache.disabled = false;
                if (label) label.textContent = "Clear cache";
            }
        });
        apply.addEventListener("click", async () => {
            const draft = currentDraft();
            apply.disabled = true;
            close.disabled = true;
            clearCache.disabled = true;
            try {
                const cacheResult = await this._fetchJSON(
                    ENDPOINTS.splatCacheSettings,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            limit_gb: draft.splat_cache_limit_gb,
                        }),
                    },
                );
                if (this.capabilities) this.capabilities.splat_cache = cacheResult;
                this.settings.conditioning_resolution = draft.conditioning_resolution;
                this.settings.prevent_upscale = draft.prevent_upscale;
                this.settings.splat_cache_limit_gb = draft.splat_cache_limit_gb;
                this._syncTripoSummary();
                this._syncSettings();
                this._renderObjects();
                this._scheduleStateSave(0);
                this.closeModal();
                this.toast(
                    `TripoSplat settings applied · ${draft.splat_cache_limit_gb} GiB cache.`,
                    "success",
                );
            } catch (error) {
                apply.disabled = false;
                close.disabled = false;
                clearCache.disabled = false;
                this._showError("TripoSplat settings failed", error);
            }
        });
        modelAction.addEventListener("click", async () => {
            if (weights.ready) {
                await this.openModelSetup(currentDraft());
                return;
            }
            modelAction.disabled = true;
            close.disabled = true;
            apply.disabled = true;
            try {
                const job = await this._fetchJSON(ENDPOINTS.weightsDownload, { method: "POST" });
                await this._monitorJob(job.job_id, { modal: true });
            } catch (_) {
                modelAction.disabled = false;
                close.disabled = false;
                apply.disabled = false;
            }
        });
        updateSummary();
        this.openModal({
            title: "TripoSplat setup",
            body,
            actions: [close, apply],
            wide: true,
            initialFocus: apply,
        });
    }

    _showError(title, error, jobId = "") {
        const job = error?.job;
        const details = [
            errorText(error),
            job?.traceback || "",
            ...(Array.isArray(job?.logs)
                ? job.logs.slice(-80).map(entry => `[${entry.stage} ${Number(entry.progress).toFixed(1)}%] ${entry.message}${entry.detail ? ` — ${entry.detail}` : ""}`)
                : []),
        ].filter(Boolean).join("\n\n");
        console.error(`[VNCCS 3D Factory] ${title}`, { error, jobId, details });
        const body = element("div");
        body.append(
            element("div", "vnccs-i3s__failure-summary", errorText(error)),
            element("pre", "vnccs-i3s__diagnostics", details),
        );
        const close = button("vnccs-i3s__button", "Close");
        close.addEventListener("click", () => this.closeModal());
        const actions = [close];
        const resolvedJobId = jobId || job?.job_id;
        if (resolvedJobId) {
            const log = button("vnccs-i3s__button vnccs-i3s__button--primary", "Download full log", "download");
            log.addEventListener("click", () => download(ENDPOINTS.jobLog(resolvedJobId)));
            actions.push(log);
        }
        this.openModal({ title, body, actions, wide: true, initialFocus: close });
    }

    toast(message, tone = "info", timeout = 3600) {
        const item = element("div", "vnccs-i3s__toast");
        item.dataset.tone = tone;
        const icon = element("span", "vnccs-i3s__toast-icon");
        icon.innerHTML = tone === "success" ? ICONS.check : tone === "error" ? ICONS.warning : ICONS.cube;
        item.append(icon, element("span", "vnccs-i3s__toast-message", message));
        this.els.toasts.appendChild(item);
        const timer = setTimeout(() => item.remove(), timeout);
        this._timers.add(timer);
        item.addEventListener("click", () => {
            clearTimeout(timer);
            this._timers.delete(timer);
            item.remove();
        });
    }

    openModal({ title, body, actions = [], wide = false, initialFocus = null }) {
        this.closeModal();
        const modal = element("section", `vnccs-i3s__modal${wide ? " is-wide" : ""}`);
        modal.setAttribute("role", "dialog");
        modal.setAttribute("aria-modal", "true");
        const head = element("header", "vnccs-i3s__modal-head");
        const heading = element("div", "vnccs-i3s__modal-title", title);
        const close = button("vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__icon-button", "", "close");
        close.setAttribute("aria-label", "Close");
        head.append(heading, close);
        const content = element("div", "vnccs-i3s__modal-body");
        content.appendChild(body instanceof Node ? body : element("div", "", String(body || "")));
        modal.append(head, content);
        if (actions.length) {
            const footer = element("footer", "vnccs-i3s__modal-actions");
            for (const action of actions) footer.appendChild(action);
            modal.appendChild(footer);
        }
        this.els.modalLayer.replaceChildren(modal);
        this.els.modalLayer.classList.add("is-open");
        this._previousFocus = document.activeElement;
        const onKey = event => {
            if (event.key === "Escape") this.closeModal();
        };
        const onBackdrop = event => {
            if (event.target === this.els.modalLayer) this.closeModal();
        };
        close.addEventListener("click", () => this.closeModal());
        document.addEventListener("keydown", onKey, true);
        this.els.modalLayer.addEventListener("pointerdown", onBackdrop);
        this._modalCleanup = () => {
            document.removeEventListener("keydown", onKey, true);
            this.els.modalLayer.removeEventListener("pointerdown", onBackdrop);
        };
        requestAnimationFrame(() => initialFocus?.focus?.() || modal.querySelector("button,input")?.focus?.());
    }

    closeModal() {
        this._modalCleanup?.();
        this._modalCleanup = null;
        this.els.modalLayer.classList.remove("is-open");
        this.els.modalLayer.replaceChildren();
        this._previousFocus?.focus?.({ preventScroll: true });
        this._previousFocus = null;
    }

    _setStatus(text, tone = "idle") {
        this.els.status.textContent = text;
        this.els.status.dataset.tone = tone;
    }

    _setProgress(visible, progress = 0, stage = "", detail = "") {
        const value = clamp(progress, 0, 100);
        this.els.progress.classList.toggle("is-visible", visible);
        this.els.progressStage.textContent = stage;
        this.els.progressPercent.textContent = `${Math.round(value)}%`;
        this.els.progressBar.style.width = `${value}%`;
        this.els.jobDetail.textContent = detail || "";
        this.els.cancelJob.disabled = !visible || !this.currentJobId || value >= 100;
    }

    _syncSettings() {
        this.els.objectName.value = this.settings.name || "";
        this.els.density.value = String(this.settings.num_gaussians);
        this.els.steps.value = String(this.settings.steps);
        this.els.guidance.value = String(this.settings.guidance_scale);
        this.els.guidanceValue.textContent = Number(this.settings.guidance_scale).toFixed(1);
        this.els.seed.value = String(this.settings.seed);
        this._syncBackgroundRemoval();
        this._syncSeedMode();
        this._syncDensityMode();
        const exportLabel = this.els.sceneExport?.querySelector("span:last-child");
        if (exportLabel) exportLabel.textContent = "Scene PLY";
        if (this.els.sceneExport) {
            this.els.sceneExport.title = "Export visible scene as PLY";
        }
        this._customSelects?.refresh?.();
    }

    _syncBackgroundRemoval() {
        this.els.removeBackground.setAttribute(
            "aria-checked",
            String(this.settings.remove_background !== false),
        );
    }

    _syncSeedMode() {
        const randomMode = this.settings.seed_mode === "randomize";
        this.els.seedDice.classList.toggle("active", randomMode);
        this.els.seedDice.title = randomMode ? "Random seed" : "Fixed seed";
        this.els.seedDice.setAttribute("aria-pressed", String(randomMode));
    }

    _syncDensityMode() {
        const count = Number(this.settings.num_gaussians);
        const experimental = count >= 524288;
        const extreme = count >= 1048576;
        this.els.densityNote.hidden = !experimental;
        this.els.densityNote.textContent = extreme
            ? "Extreme 4× density. Full-attention decode may exhaust even high-VRAM GPUs."
            : "Experimental 2× density. Requires substantially more VRAM and decode time.";
        this.els.density.closest(".vnccs-i3s__field")?.classList.toggle("is-experimental", experimental);
        this.els.density.closest(".vnccs-i3s__field")?.classList.toggle("is-extreme", extreme);
    }

    _syncToolbar() {
        const mode = this.viewerState.mode || "translate";
        this.els.modeMove.setAttribute("aria-pressed", String(mode === "translate"));
        this.els.modeRotate.setAttribute("aria-pressed", String(mode === "rotate"));
        this.els.modeScale.setAttribute("aria-pressed", String(mode === "scale"));
        this.els.grid.setAttribute("aria-pressed", String(Boolean(this.viewerState.grid)));
    }

    serializeState() {
        return {
            schema_version: STATE_VERSION,
            scene_id: this.sceneId,
            selected_object_id: this.selectedObjectId,
            selected_object_ids: Array.from(this.selectedObjectIds),
            selected_group_id: this.selectedGroupId,
            selected_skydome: this.selectedSkydome,
            collapsed_group_ids: Array.from(this.collapsedGroupIds),
            settings: { ...this.settings },
            render_settings: { ...this.exportSettings },
            lighting_settings: { ...this.lighting },
            viewer_state: this.viewer?.getState?.() || this.viewerState,
            scene_snapshot: this.scene ? this._scenePayload() : null,
            source: this.sourceAsset
                ? { ...this.sourceAsset, scene_id: this.sceneId }
                : null,
        };
    }

    _scheduleStateSave(delay = 100) {
        if (this._isRestoring) return;
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this.syncToNode(), delay);
    }

    syncToNode() {
        if (this._isRestoring) return;
        clearTimeout(this._saveTimer);
        this._saveTimer = 0;
        const widget = this.node?.widgets?.find(item => item.name === "factory_data");
        if (!widget) return;
        const value = JSON.stringify(this.serializeState());
        if (widget.value !== value) {
            widget.value = value;
            widget.callback?.(value);
        }
    }

    async _restoreFromNodeNow() {
        this._isRestoring = true;
        const widget = this.node?.widgets?.find(item => item.name === "factory_data");
        let state = {};
        try {
            try { state = safeObject(JSON.parse(String(widget?.value || "{}"))); }
            catch (error) { this._showError("Saved state is invalid", error); }
            this.sceneId = String(state.scene_id || "");
            this.selectedObjectId = String(state.selected_object_id || "");
            this.selectedObjectIds = new Set(
                Array.isArray(state.selected_object_ids)
                    ? state.selected_object_ids.map(String)
                    : this.selectedObjectId
                        ? [this.selectedObjectId]
                        : [],
            );
            if (this.selectedObjectId) this.selectedObjectIds.add(this.selectedObjectId);
            this.selectedGroupId = String(state.selected_group_id || "");
            this.selectedSkydome = state.selected_skydome === true;
            this.collapsedGroupIds = new Set(
                Array.isArray(state.collapsed_group_ids)
                    ? state.collapsed_group_ids.map(String)
                    : [],
            );
            const savedSettings = safeObject(state.settings);
            this.settings = { ...DEFAULT_SETTINGS, ...savedSettings };
            if (!Object.hasOwn(savedSettings, "seed_mode")) {
                this.settings.seed_mode = Number(savedSettings.seed) < 0 ? "randomize" : "fixed";
            }
            this.settings.seed_mode = this.settings.seed_mode === "randomize" ? "randomize" : "fixed";
            this.settings.seed = clamp(
                Number(this.settings.seed) < 0 ? 0 : Math.round(Number(this.settings.seed)),
                0,
                2**31 - 1,
            );
            this.settings.remove_background = this.settings.remove_background !== false;
            delete this.settings.erode_radius;
            if (![1024, 1536, 2048].includes(Number(this.settings.conditioning_resolution))) {
                this.settings.conditioning_resolution = 1024;
            } else {
                this.settings.conditioning_resolution = Number(this.settings.conditioning_resolution);
            }
            this.settings.prevent_upscale = this.settings.prevent_upscale === true;
            delete this.settings.export_format;
            this.settings.splat_cache_limit_gb = Math.round(clamp(
                this.settings.splat_cache_limit_gb,
                1,
                1024,
            ));
            this.exportSettings = this._normalizeExportSettings(
                state.render_settings || safeObject(state.scene_snapshot).render,
            );
            this.lighting = this._normalizeLighting(
                state.lighting_settings || safeObject(state.scene_snapshot).lighting,
            );
            this.viewerState = { ...this.viewerState, ...safeObject(state.viewer_state) };
            this._syncSettings();
            this._syncExportSettings();
            this._syncLighting();
            this.viewer.setLighting(this.lighting);
            this.viewer.setState(this.viewerState);
            await Promise.all([
                this.loadCapabilities(),
                this.ensureScene(safeObject(state.scene_snapshot)),
            ]);
            const savedSource = safeObject(state.source);
            if (
                !this.sourceAsset
                && savedSource.url
                && (!savedSource.scene_id || savedSource.scene_id === this.sceneId)
            ) {
                this._restoreSourceAsset(savedSource);
            }
        } finally {
            this._isRestoring = false;
            this.syncToNode();
        }
    }

    restoreFromNode() {
        const operation = this._restoreSerial.then(() => this._restoreFromNodeNow());
        this._restoreSerial = operation.catch(() => null);
        return operation;
    }

    resize() {
        const width = this.container.clientWidth || DEFAULT_NODE_SIZE[0];
        const height = this.container.clientHeight || DEFAULT_NODE_SIZE[1];
        const scale = clamp(Math.min(width / 1100, height / 720), 0.72, 1.08);
        const scaleValue = scale.toFixed(3);
        if (scaleValue !== this._uiScaleValue) {
            this._uiScaleValue = scaleValue;
            this.container.style.setProperty("--i3-scale", scaleValue);
            this.container.style.setProperty("--vnccs-ps-ui-scale", scaleValue);
            this.container.style.setProperty("--vnccs-ps-relative-ui-scale", scaleValue);
        }
        this.viewer?.resize();
    }

    dispose() {
        if (this.destroyed) return;
        if (this._sceneSaveTimer) {
            void this._saveSceneNow({ showError: false }).catch(error => {
                console.error("[VNCCS 3D Factory] Final scene save failed", error);
            });
        }
        this.destroyed = true;
        clearTimeout(this._saveTimer);
        clearTimeout(this._sceneSaveTimer);
        clearTimeout(this._previewSaveTimer);
        clearTimeout(this._lightingApplyTimer);
        if (this._previewIdleHandle && typeof cancelIdleCallback === "function") {
            cancelIdleCallback(this._previewIdleHandle);
        }
        if (this._searchRenderFrame) cancelAnimationFrame(this._searchRenderFrame);
        for (const timer of this._timers) clearTimeout(timer);
        this._timers.clear();
        for (const remove of this._listeners) remove();
        this._listeners.length = 0;
        this._resizeObserver?.disconnect();
        this._navigationCleanup?.();
        this._customSelects?.destroy?.();
        this.viewer?.dispose();
        if (this.sourceURL?.startsWith("blob:")) URL.revokeObjectURL(this.sourceURL);
        this.closeFactoryLibrary();
        this.closeModal();
        this.container.remove();
    }
}


function enableCanvasNavigationForwarding(root) {
    if (!root) return () => {};
    const graphCanvas = () => app.canvasEl || app.canvas?.canvas || document.querySelector("canvas.litegraph");
    let panning = false;

    const markForwarded = event => {
        Object.defineProperty(event, "_vnccsFactoryForwardedCanvasInput", { value: true });
        return event;
    };

    const cloneMouseEvent = (type, source, buttons = source.buttons) => markForwarded(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        detail: source.detail,
        screenX: source.screenX,
        screenY: source.screenY,
        clientX: source.clientX,
        clientY: source.clientY,
        ctrlKey: source.ctrlKey,
        altKey: source.altKey,
        shiftKey: source.shiftKey,
        metaKey: source.metaKey,
        button: source.button,
        buttons,
    }));

    const clonePointerEvent = (type, source, buttons = source.buttons) => {
        const EventCtor = window.PointerEvent || window.MouseEvent;
        return markForwarded(new EventCtor(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            detail: source.detail,
            screenX: source.screenX,
            screenY: source.screenY,
            clientX: source.clientX,
            clientY: source.clientY,
            ctrlKey: source.ctrlKey,
            altKey: source.altKey,
            shiftKey: source.shiftKey,
            metaKey: source.metaKey,
            button: 1,
            buttons,
            pointerId: source.pointerId || 1,
            pointerType: source.pointerType || "mouse",
            isPrimary: source.isPrimary !== false,
        }));
    };

    const cloneWheelEvent = source => markForwarded(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        view: window,
        detail: source.detail,
        screenX: source.screenX,
        screenY: source.screenY,
        clientX: source.clientX,
        clientY: source.clientY,
        ctrlKey: source.ctrlKey,
        altKey: source.altKey,
        shiftKey: source.shiftKey,
        metaKey: source.metaKey,
        deltaX: source.deltaX,
        deltaY: source.deltaY,
        deltaZ: source.deltaZ,
        deltaMode: source.deltaMode,
    }));

    const forwardMouse = (type, event, buttons) => {
        const canvas = graphCanvas();
        if (!canvas) return false;
        const pointerType = type === "mousedown"
            ? "pointerdown"
            : type === "mousemove"
                ? "pointermove"
                : "pointerup";
        canvas.dispatchEvent(clonePointerEvent(pointerType, event, buttons));
        canvas.dispatchEvent(cloneMouseEvent(type, event, buttons));
        return true;
    };

    const forwardWheel = event => {
        const canvas = graphCanvas();
        if (!canvas) return false;
        canvas.dispatchEvent(cloneWheelEvent(event));
        return true;
    };

    const hasOwnWheelHandler = target => {
        for (let element = target; element && element !== root; element = element.parentElement) {
            if (typeof element.onwheel === "function") return true;
        }
        return false;
    };

    const hasScrollableAncestor = target => {
        for (let element = target; element && element !== root; element = element.parentElement) {
            if (!(element instanceof HTMLElement)) continue;
            const style = getComputedStyle(element);
            const scrollY = /(auto|scroll|overlay)/.test(style.overflowY)
                && element.scrollHeight > element.clientHeight + 1;
            const scrollX = /(auto|scroll|overlay)/.test(style.overflowX)
                && element.scrollWidth > element.clientWidth + 1;
            if (scrollY || scrollX) return true;
        }
        return false;
    };

    const hasInteractiveTarget = target => {
        if (!(target instanceof Element)) return true;
        return Boolean(target.closest([
            "button",
            "input",
            "textarea",
            "select",
            "label",
            "a",
            "canvas",
            "[contenteditable='true']",
            "[role='button']",
            ".vnccs-i3s__viewer-host",
            ".vnccs-custom-select-menu",
            ".vnccs-i3s__modal-layer",
        ].join(",")));
    };

    const canForwardFrom = target => {
        if (hasInteractiveTarget(target)) return false;
        if (hasOwnWheelHandler(target)) return false;
        if (hasScrollableAncestor(target)) return false;
        return true;
    };

    const finishPan = event => {
        if (event._vnccsFactoryForwardedCanvasInput || !panning) return;
        panning = false;
        event.preventDefault();
        event.stopPropagation();
        forwardMouse("mouseup", event, 0);
        window.removeEventListener("mousemove", movePan, true);
        window.removeEventListener("mouseup", finishPan, true);
    };

    const movePan = event => {
        if (event._vnccsFactoryForwardedCanvasInput || !panning) return;
        event.preventDefault();
        event.stopPropagation();
        forwardMouse("mousemove", event, event.buttons || 4);
    };

    const startPan = event => {
        if (event._vnccsFactoryForwardedCanvasInput || event.button !== 1) return;
        if (!canForwardFrom(event.target)) return;
        if (!forwardMouse("mousedown", event, 4)) return;
        panning = true;
        event.preventDefault();
        event.stopPropagation();
        window.addEventListener("mousemove", movePan, true);
        window.addEventListener("mouseup", finishPan, true);
    };

    const suppressAuxClick = event => {
        if (event.button !== 1 || !canForwardFrom(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
    };

    const forwardWheelFromInterface = event => {
        if (event._vnccsFactoryForwardedCanvasInput) return;
        if (!canForwardFrom(event.target)) return;
        if (!forwardWheel(event)) return;
        event.preventDefault();
        event.stopPropagation();
    };

    root.addEventListener("mousedown", startPan, true);
    root.addEventListener("auxclick", suppressAuxClick, true);
    root.addEventListener("wheel", forwardWheelFromInterface, { capture: true, passive: false });

    return () => {
        panning = false;
        root.removeEventListener("mousedown", startPan, true);
        root.removeEventListener("auxclick", suppressAuxClick, true);
        root.removeEventListener("wheel", forwardWheelFromInterface, true);
        window.removeEventListener("mousemove", movePan, true);
        window.removeEventListener("mouseup", finishPan, true);
    };
}

function hideFactoryDataWidget(node) {
    const widget = node?.widgets?.find(item => item.name === "factory_data");
    if (!widget) return;
    widget.type = "hidden";
    widget.hidden = true;
    widget.computeSize = () => [0, -4];
    widget.draw = () => {};
    if (widget.element) widget.element.style.display = "none";
    if (widget.inputEl) {
        widget.inputEl.hidden = true;
        widget.inputEl.style.display = "none";
    }
}

function syncDOMWidgetWidth(node) {
    const widget = node?.widgets?.find(item => item.name === "factory_ui");
    const nodeWidth = Number(node?.size?.[0]);
    if (!widget || !Number.isFinite(nodeWidth) || nodeWidth <= 0) return;
    if (!widget._vnccsFactoryWidthBound) {
        try {
            Object.defineProperty(widget, "width", {
                configurable: true,
                get() {
                    const width = Number(this._node?.size?.[0] ?? node?.size?.[0]);
                    return Number.isFinite(width) && width > 0 ? width : undefined;
                },
                set() {
                    // ComfyUI may restore a stale width from an older layout.
                    // Keep the DOM widget tied to the live LiteGraph node.
                },
            });
            widget._vnccsFactoryWidthBound = true;
        } catch (_) {}
    }
    widget.triggerDraw?.();
}

function scheduleDOMWidgetWidth(node) {
    if (!node || node._vnccsFactoryWidthFrame) return;
    node._vnccsFactoryWidthFrame = requestAnimationFrame(() => {
        node._vnccsFactoryWidthFrame = 0;
        syncDOMWidgetWidth(node);
    });
}


app.registerExtension({
    name: "VNCCS.3DFactory",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "VNCCS_3DFactory") return;
        const originalCreated = nodeType.prototype.onNodeCreated;
        const originalResize = nodeType.prototype.onResize;
        const originalConfigure = nodeType.prototype.onConfigure;
        const originalSerialize = nodeType.prototype.onSerialize;
        const originalRemoved = nodeType.prototype.onRemoved;

        nodeType.prototype.onNodeCreated = function () {
            originalCreated?.apply(this, arguments);
            if (this.vnccs3DFactory) return;
            this._vnccsFactoryConfigured = false;
            this.setSize?.([...DEFAULT_NODE_SIZE]);
            hideFactoryDataWidget(this);
            const factory = new Factory3DWidget(this);
            this.vnccs3DFactory = factory;
            this.vnccs3DFactoryDOMWidget = this.addDOMWidget(
                "factory_ui",
                "ui",
                factory.container,
                { serialize: false, hideOnZoom: false },
            );
            syncDOMWidgetWidth(this);
            requestAnimationFrame(() => syncDOMWidgetWidth(this));
            this._vnccsFactoryInit = setTimeout(() => {
                this._vnccsFactoryInit = 0;
                if (this._vnccsFactoryConfigured) return;
                hideFactoryDataWidget(this);
                void factory.restoreFromNode().finally(() => this.onResize?.(this.size));
            }, 400);
        };
        nodeType.prototype.onResize = function () {
            originalResize?.apply(this, arguments);
            if (!this.vnccs3DFactory) return;
            // Match Pose Studio: let the DOM widget fill its wrapper and ask
            // ComfyUI to redraw that wrapper at most once per display frame.
            scheduleDOMWidgetWidth(this);
            clearTimeout(this._vnccsFactoryResizeTimer);
            this._vnccsFactoryResizeTimer = setTimeout(() => {
                syncDOMWidgetWidth(this);
                this.vnccs3DFactory?.resize();
            }, 50);
        };
        nodeType.prototype.onConfigure = function () {
            this._vnccsFactoryConfigured = true;
            clearTimeout(this._vnccsFactoryInit);
            this._vnccsFactoryInit = 0;
            originalConfigure?.apply(this, arguments);
            hideFactoryDataWidget(this);
            syncDOMWidgetWidth(this);
            clearTimeout(this._vnccsFactoryConfigure);
            this._vnccsFactoryConfigure = setTimeout(() => {
                this._vnccsFactoryConfigure = 0;
                hideFactoryDataWidget(this);
                void this.vnccs3DFactory?.restoreFromNode().finally(() => this.onResize?.(this.size));
            }, 40);
        };
        nodeType.prototype.onSerialize = function () {
            this.vnccs3DFactory?.syncToNode();
            return originalSerialize?.apply(this, arguments);
        };
        nodeType.prototype.onRemoved = function () {
            clearTimeout(this._vnccsFactoryInit);
            clearTimeout(this._vnccsFactoryConfigure);
            clearTimeout(this._vnccsFactoryResizeTimer);
            if (this._vnccsFactoryWidthFrame) {
                cancelAnimationFrame(this._vnccsFactoryWidthFrame);
                this._vnccsFactoryWidthFrame = 0;
            }
            this.vnccs3DFactory?.dispose();
            this.vnccs3DFactory = null;
            this.vnccs3DFactoryDOMWidget = null;
            return originalRemoved?.apply(this, arguments);
        };
    },
});
