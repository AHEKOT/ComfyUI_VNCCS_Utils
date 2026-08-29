import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { installCustomSelects } from "./vnccs_custom_select.mjs";
import { Factory3DViewer } from "./vnccs_3d_factory_viewer.js?v=20260828.3";
import {
    FACTORY_EDITOR_SCHEMA_VERSION,
    DEFAULT_LEVEL,
    DEFAULT_ROOM,
    DEFAULT_WALL,
    factoryId,
    normalizedArchitecture,
    normalizedEditorView,
    normalizedLevels,
    normalizedObjectEditorProperties,
} from "./factory3d/editor_schema.mjs?v=20260828.1";
import {
    FactoryCommandHistory,
    preserveScrollState,
} from "./factory3d/editor_commands.mjs?v=20260824.4";
import {
    FactoryCameraPath,
    cameraPoseFromLegacy,
    legacyCameraFromPose,
    normalizedCameraPose,
} from "./factory3d/camera_path.mjs?v=20260824.4";


const VNCCS_DONATE_BANNER_URL = new URL("./assets/VNCCS_Donate_Button.png", import.meta.url).href;
const API_BASE = "/vnccs/3d-factory";
const LIBRARY_BASE = `${API_BASE}/library`;
const MODEL_LIBRARY_SCHEMA = "vnccs-3d-factory-library/v1";
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
    textures: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/textures`,
    texture: (sceneId, textureId) => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/textures/${encodeURIComponent(textureId)}`,
    preview: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/preview`,
    captureSet: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/capture-set`,
    previewError: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/preview/error`,
    generate: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/generate`,
    importObject: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/objects/import`,
    importModel: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/objects/import-model`,
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
const STATE_VERSION = FACTORY_EDITOR_SCHEMA_VERSION;
const FRONTEND_BUILD = "20260828.3";
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_PLY_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MODEL_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_SKYDOME_BYTES = 64 * 1024 * 1024;
const MAX_TEXTURE_BYTES = 32 * 1024 * 1024;
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
    shadows: Object.freeze({
        enabled: true,
        quality: "medium",
        bias: -0.0002,
        normal_bias: 0.0015,
    }),
    lights: Object.freeze([]),
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
});


function installStyles() {
    const href = new URL("./vnccs_3d_factory.css?v=20260828.2", import.meta.url).href;
    const existing = document.getElementById("vnccs-3d-factory-styles");
    if (existing) {
        if (existing.href !== href) existing.href = href;
        return;
    }
    const link = document.createElement("link");
    link.id = "vnccs-3d-factory-styles";
    link.rel = "stylesheet";
    link.href = href;
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

function reconcileIdentifiedObjects(currentValue, normalizedValue, idKey) {
    const current = Array.isArray(currentValue) ? currentValue : [];
    const normalized = Array.isArray(normalizedValue) ? normalizedValue : [];
    const byId = new Map(current.map(item => [String(item?.[idKey] || ""), item]));
    return normalized.map(next => {
        const existing = byId.get(String(next?.[idKey] || ""));
        if (!existing || typeof existing !== "object") return next;
        for (const key of Object.keys(existing)) {
            if (!(key in next)) delete existing[key];
        }
        Object.assign(existing, next);
        return existing;
    });
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

function quaternionFromEulerDegrees(rotation = [0, 0, 0]) {
    const [x, y, z] = rotation.map(value => Number(value || 0) * Math.PI / 180 / 2);
    const [sx, sy, sz] = [Math.sin(x), Math.sin(y), Math.sin(z)];
    const [cx, cy, cz] = [Math.cos(x), Math.cos(y), Math.cos(z)];
    return normalizedCameraPose({
        quaternion: [
            sx * cy * cz + cx * sy * sz,
            cx * sy * cz - sx * cy * sz,
            cx * cy * sz + sx * sy * cz,
            cx * cy * cz - sx * sy * sz,
        ],
    }).quaternion;
}

function multiplyQuaternions(left = [0, 0, 0, 1], right = [0, 0, 0, 1]) {
    const [ax, ay, az, aw] = left.map(Number);
    const [bx, by, bz, bw] = right.map(Number);
    return normalizedCameraPose({
        quaternion: [
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz,
        ],
    }).quaternion;
}

function eulerDegreesFromQuaternion(quaternion = [0, 0, 0, 1]) {
    const [x, y, z, w] = normalizedCameraPose({ quaternion }).quaternion;
    // Inverse of quaternionFromEulerDegrees' intrinsic XYZ order. Mixing this
    // with the common ZYX yaw/pitch/roll equations makes exact camera fields
    // drift as soon as more than one axis is rotated.
    const rotationX = Math.atan2(2 * (w * x - y * z), 1 - 2 * (x * x + y * y));
    const rotationY = Math.asin(Math.max(-1, Math.min(1, 2 * (x * z + w * y))));
    const rotationZ = Math.atan2(2 * (w * z - x * y), 1 - 2 * (y * y + z * z));
    return [rotationX, rotationY, rotationZ].map(value => value * 180 / Math.PI);
}


class Factory3DWidget {
    constructor(node) {
        installStyles();
        if (window.__vnccs3DFactoryBuild !== FRONTEND_BUILD) {
            window.__vnccs3DFactoryBuild = FRONTEND_BUILD;
            console.info(`[VNCCS 3D Factory] Frontend build ${FRONTEND_BUILD}`);
        }
        this.node = node;
        this._workspaceId = `vnccs-factory-${randomLayerId()}`;
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
        this.selectedCameraIds = new Set();
        this.selectedLightId = "";
        this.previewCameraId = "";
        this.selectedArchitecture = null;
        this.selectedArchitectureItems = new Map();
        this.selectionClipboard = null;
        this.editorView = normalizedEditorView();
        this.planDraft = null;
        this.planHover = null;
        this._planHoverFrame = 0;
        this._pendingPlanHover = null;
        this.activeCameraTrackId = "";
        this.selectedCameraKeyframeId = "";
        this.cameraPlayback = null;
        this._cameraReturnState = null;
        this._cameraSelectionTransition = false;
        this._cameraPadPointer = null;
        this.collapsedGroupIds = new Set();
        this.dragLayer = null;
        this.viewportFailures = new Map();
        this.settings = { ...DEFAULT_SETTINGS };
        this.exportSettings = { ...DEFAULT_EXPORT_SETTINGS };
        this.panoramaCameraId = "";
        this.panoramaWidth = 4096;
        this.exportingPanorama = false;
        this.lighting = { ...DEFAULT_LIGHTING };
        this.viewerState = { mode: "translate", grid: false, zoom_sensitivity: 0.1 };
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
        this._lightingHistoryBefore = null;
        this._lightTransformHistoryBefore = null;
        this._searchRenderFrame = 0;
        this._sceneSaveSerial = Promise.resolve();
        this._architectureCommitSerial = Promise.resolve();
        this._architecturePreviewTimer = 0;
        this._architectureGeometryFrame = 0;
        this._previewSaveSerial = Promise.resolve();
        this._restoreSerial = Promise.resolve();
        this._historyRestoreSerial = Promise.resolve();
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
        this.history = new FactoryCommandHistory({
            limit: 100,
            onRestore: snapshot => {
                const operation = this._historyRestoreSerial.then(
                    () => this._restoreEditorSnapshot(snapshot),
                );
                this._historyRestoreSerial = operation.catch(() => null);
                return operation;
            },
        });
        // Keep callbacks read-only until the serialized ComfyUI widget state has
        // been applied. Viewer setup emits state changes during construction.
        this._isRestoring = true;
        this._createLayout();
        this._cache();
        this._bind();
        this._syncWorkspace();
        this.viewer = new Factory3DViewer(this.els.viewerHost, {
            onSelectionChange: (id, options) => this._selectObject(id, {
                fromViewer: true,
                additive: Boolean(options?.additive),
            }),
            onTransformChange: (id, transform, options) => this._onViewerTransform(id, transform, options),
            onArchitectureSelection: selection => this._selectArchitecture(selection, {
                additive: Boolean(selection?.additive),
            }),
            onArchitectureEdit: change => this._onArchitectureEdit(change),
            onLightSelection: lightId => this._selectLight(lightId),
            onLightTransform: (lightId, position, options) => this._onViewerLightTransform(
                lightId,
                position,
                options,
            ),
            onPlanMarqueeSelection: (items, options) => this._selectPlanItems(items, options),
            snapPlanPoint: (point, event, context) => this._snapPlanPoint(
                point,
                event,
                context?.origin || null,
            ),
            onPlanGesture: gesture => this._onPlanGesture(gesture),
            onPlanHover: (tool, point, event) => this._queuePlanHover(tool, point, event),
            onStateChange: state => {
                const previousState = this.viewerState;
                const cameraChanged = !cameraStatesEqual(
                    previousState.camera || {},
                    state.camera || {},
                );
                const zoomSensitivityChanged = previousState.zoom_sensitivity
                    !== state.zoom_sensitivity;
                const toolbarChanged = previousState.mode !== state.mode
                    || previousState.grid !== state.grid
                    || previousState.view_mode !== state.view_mode
                    || previousState.plan_tool !== state.plan_tool
                    || previousState.active_level_id !== state.active_level_id;
                this.viewerState = { ...this.viewerState, ...state };
                if (toolbarChanged) this._syncToolbar();
                if (zoomSensitivityChanged) this._syncCameraPanelControls();
                this._scheduleStateSave();
                if (
                    cameraChanged
                    && !this._isRestoring
                    && !this._suppressViewerStatePersistence
                    && !this._cameraSelectionTransition
                    && this.previewCameraId
                    && this.scene
                ) {
                    const savedCamera = this.scene.cameras?.find(
                        camera => camera.camera_id === this.previewCameraId,
                    );
                    if (savedCamera) {
                        Object.assign(savedCamera, this._normalizeCameraState(state.camera));
                        this.viewer.setCameraMarkers(this.scene.cameras);
                        this._renderInspector();
                        this._scheduleSceneSave(180);
                    }
                }
                if (
                    cameraChanged
                    && !this._isRestoring
                    && !this._suppressViewerStatePersistence
                    && !this.previewCameraId
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
        this._renderInspector();
        this._renderCameraTracks();
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
            <aside class="vnccs-i3s__side vnccs-i3s__side--left" aria-label="Creation and camera tools">
                <div class="vnccs-i3s__workspace-tabs" role="tablist" aria-label="Creation workspace">
                    <button class="vnccs-i3s__workspace-tab" type="button" role="tab"
                        data-workspace-side="left" data-workspace-tab="generate"
                        id="${this._workspaceId}-left-generate-tab"
                        title="Generation tools"
                        aria-controls="${this._workspaceId}-left-generate" aria-selected="true">
                        <span aria-hidden="true">${ICONS.upload}</span><span>Generate</span>
                    </button>
                    <button class="vnccs-i3s__workspace-tab" type="button" role="tab"
                        data-workspace-side="left" data-workspace-tab="cameras"
                        id="${this._workspaceId}-left-cameras-tab"
                        title="Camera tools"
                        aria-controls="${this._workspaceId}-left-cameras" aria-selected="false" tabindex="-1">
                        <span aria-hidden="true">${ICONS.camera}</span><span>Cameras</span>
                    </button>
                </div>
                <div class="vnccs-i3s__workspace-panels">
                    <div class="vnccs-i3s__workspace-panel vnccs-i3s__workspace-panel--left"
                        id="${this._workspaceId}-left-generate" role="tabpanel"
                        aria-labelledby="${this._workspaceId}-left-generate-tab"
                        data-workspace-side="left" data-workspace-panel="generate"
                        data-preserve-scroll="workspace-left-generate">
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
                    </div>
                    <div class="vnccs-i3s__workspace-panel vnccs-i3s__workspace-panel--left"
                        id="${this._workspaceId}-left-cameras" role="tabpanel"
                        aria-labelledby="${this._workspaceId}-left-cameras-tab"
                        data-workspace-side="left" data-workspace-panel="cameras"
                        data-preserve-scroll="workspace-left-cameras" hidden>
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
                        <div class="vnccs-i3s__camera-help">Drag to look</div>
                        <label class="vnccs-i3s__field vnccs-i3s__camera-zoom-speed">
                            <span class="vnccs-i3s__label"><span>Wheel zoom speed</span><output class="vnccs-i3s__camera-zoom-speed-value">0.10×</output></span>
                            <input class="vnccs-i3s__range vnccs-i3s__camera-zoom-speed-range" type="range" min="-2" max="0.30103" step="0.01" value="-1" aria-label="Mouse wheel zoom speed" aria-valuetext="0.10×" />
                        </label>
                        <div class="vnccs-i3s__camera-view-presets">
                            <span class="vnccs-i3s__label">View projection</span>
                            <div class="vnccs-i3s__camera-view-preset-grid" role="group" aria-label="Camera view projections">
                                <button class="vnccs-i3s__button" type="button" data-camera-preset="perspective">Perspective</button>
                                <button class="vnccs-i3s__button" type="button" data-camera-preset="front">Front</button>
                                <button class="vnccs-i3s__button" type="button" data-camera-preset="right">Right</button>
                                <button class="vnccs-i3s__button" type="button" data-camera-preset="top">Top</button>
                            </div>
                        </div>
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
                        <div class="vnccs-i3s__camera-track-editor">
                            <div class="vnccs-i3s__camera-group-head">
                                <span>${ICONS.play}</span>
                                <strong>Camera path</strong>
                            </div>
                            <div class="vnccs-i3s__camera-track-row">
                                <select class="vnccs-i3s__select vnccs-i3s__camera-track-select" aria-label="Camera path"></select>
                                <button class="vnccs-i3s__button vnccs-i3s__camera-track-add" type="button" title="Add camera path">+</button>
                                <button class="vnccs-i3s__button vnccs-i3s__camera-track-delete" type="button" title="Delete active camera path" aria-label="Delete active camera path">${ICONS.trash}</button>
                            </div>
                            <input class="vnccs-i3s__input vnccs-i3s__camera-track-name" maxlength="80" placeholder="Camera path name" aria-label="Camera path name" />
                            <select class="vnccs-i3s__select vnccs-i3s__camera-track-building" aria-label="Camera path building"></select>
                            <div class="vnccs-i3s__camera-track-actions">
                                <button class="vnccs-i3s__button vnccs-i3s__camera-keyframe-add" type="button">Add point</button>
                                <button class="vnccs-i3s__button vnccs-i3s__camera-track-play" type="button">Play</button>
                            </div>
                            <input class="vnccs-i3s__range vnccs-i3s__camera-track-time" type="range" min="0" max="5" step="0.001" value="0" aria-label="Camera path time" />
                            <div class="vnccs-i3s__camera-track-meta">No camera path</div>
                            <div class="vnccs-i3s__camera-keyframes" data-preserve-scroll="camera-keyframes"></div>
                        </div>
                    </div>
                </section>
                    </div>
                </div>
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
                    <div class="vnccs-i3s__viewer-host" aria-label="3D scene viewport"></div>
                    <div class="vnccs-i3s__toolbar" role="toolbar">
                        <div class="vnccs-i3s__view-switch" role="group" aria-label="Viewport mode">
                            <button class="vnccs-i3s__tool-label vnccs-i3s__view-3d" type="button" aria-pressed="true">3D</button>
                            <button class="vnccs-i3s__tool-label vnccs-i3s__view-plan" type="button" aria-pressed="false">Plan</button>
                        </div>
                        <button class="vnccs-i3s__tool-label vnccs-i3s__undo" type="button" title="Undo (Ctrl/Cmd+Z)" disabled>Undo</button>
                        <button class="vnccs-i3s__tool-label vnccs-i3s__redo" type="button" title="Redo (Ctrl/Cmd+Shift+Z)" disabled>Redo</button>
                        <span class="vnccs-i3s__tool-separator"></span>
                        <button class="vnccs-i3s__tool-label vnccs-i3s__selection-copy" type="button" title="Copy selected scene objects (Ctrl/Cmd+C)" disabled>Copy</button>
                        <button class="vnccs-i3s__tool-label vnccs-i3s__selection-paste" type="button" title="Paste copied scene objects (Ctrl/Cmd+V)" disabled>Paste</button>
                        <span class="vnccs-i3s__tool-separator"></span>
                        <button class="vnccs-i3s__tool vnccs-i3s__fit" type="button" title="Fit scene" aria-label="Fit scene">${ICONS.fit}</button>
                        <button class="vnccs-i3s__tool-label vnccs-i3s__cutaway" type="button"
                            title="Interior cutaway (viewport only): hide ceilings and the nearest blocking wall"
                            aria-label="Toggle viewport-only interior cutaway for this mode"
                            aria-pressed="false">Cutaway</button>
                        <span class="vnccs-i3s__tool-separator"></span>
                        <button class="vnccs-i3s__tool vnccs-i3s__mode-move" type="button" title="Move" aria-label="Move selected objects" aria-pressed="true">${ICONS.move}</button>
                        <button class="vnccs-i3s__tool vnccs-i3s__mode-rotate" type="button" title="Rotate" aria-label="Rotate selected objects" aria-pressed="false">${ICONS.rotate}</button>
                        <button class="vnccs-i3s__tool vnccs-i3s__mode-scale" type="button" title="Scale uniformly" aria-label="Scale selected objects uniformly" aria-pressed="false">${ICONS.scale}</button>
                        <button class="vnccs-i3s__tool-label vnccs-i3s__drop-surface" type="button" title="Drop selection to the nearest surface (End)">Drop</button>
                        <span class="vnccs-i3s__tool-separator"></span>
                        <button class="vnccs-i3s__tool vnccs-i3s__skydome-open" type="button" title="Skydome" aria-label="Open skydome controls" aria-pressed="false">${ICONS.image}</button>
                        <button class="vnccs-i3s__tool vnccs-i3s__lighting-open" type="button" title="Scene lighting and point lights" aria-label="Open scene lighting and point light controls" aria-pressed="false">${ICONS.sun}</button>
                        <button class="vnccs-i3s__tool vnccs-i3s__grid" type="button" title="Grid" aria-label="Toggle 3D grid" aria-pressed="false">${ICONS.grid}</button>
                    </div>
                    <div class="vnccs-i3s__plan-tools" role="toolbar" aria-label="Floor plan tools" hidden>
                        <button type="button" data-plan-tool="select" aria-pressed="true" title="Select and edit architecture"><span>Select</span></button>
                        <button type="button" data-plan-tool="wall" aria-pressed="false" title="Press and drag to draw a wall"><span>Wall</span></button>
                        <button type="button" data-plan-tool="room" aria-pressed="false" title="Press and drag diagonally to draw a rectangular room"><span>Room</span></button>
                        <button type="button" data-plan-tool="opening" aria-pressed="false" title="Press on a wall and drag to set the opening width"><span>Opening</span></button>
                        <label class="vnccs-i3s__opening-kind-shortcut" hidden>
                            <span>Place</span>
                            <select class="vnccs-i3s__select" data-plan-setting="opening_kind" aria-label="Opening type">
                                <option value="window">Window</option><option value="door">Door</option><option value="empty">Empty</option>
                            </select>
                        </label>
                        <button type="button" data-plan-tool="camera" aria-pressed="false" title="Press and drag to place and aim a saved camera"><span>Camera</span></button>
                        <button class="vnccs-i3s__plan-grid-toggle" type="button" aria-pressed="true" title="Show plan grid">Grid</button>
                        <button class="vnccs-i3s__snap-toggle" type="button" aria-pressed="true" title="Snap drawing and edits to the plan grid">Snap</button>
                        <label class="vnccs-i3s__snap-grid">Step <input type="number" min="0.001" max="1000" step="0.01" value="0.1" inputmode="decimal" aria-label="Plan grid step in meters" /><span>m</span></label>
                        <details class="vnccs-i3s__plan-settings">
                            <summary>Options</summary>
                            <div class="vnccs-i3s__plan-settings-popover">
                                <label><span>Grid step · m</span><input class="vnccs-i3s__input" data-plan-setting="grid_step" type="number" min="0.001" max="1000" step="0.01" /></label>
                                <label><span>Major line every</span><input class="vnccs-i3s__input" data-plan-setting="major_every" type="number" min="2" max="100" step="1" /></label>
                                <label><span>Angle step</span><input class="vnccs-i3s__input" data-plan-setting="angle" type="number" min="0" max="180" step="1" /></label>
                                <label><span>Opening type</span><select class="vnccs-i3s__select" data-plan-setting="opening_kind"><option value="window">Window</option><option value="door">Door</option><option value="empty">Empty</option></select></label>
                                <label><input data-plan-setting="endpoints" type="checkbox" /> Snap to endpoints</label>
                                <label><input data-plan-setting="midpoints" type="checkbox" /> Snap to midpoints</label>
                                <label><input data-plan-setting="orthogonal" type="checkbox" /> Automatic orthogonal snap</label>
                            </div>
                        </details>
                        <span class="vnccs-i3s__plan-hint">Choose a tool, then press and drag in the plan.</span>
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
                                <div class="vnccs-i3s__lighting-subtitle">Realtime scene illumination</div>
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
                        <div class="vnccs-i3s__lighting-advanced">
                            <div class="vnccs-i3s__switch-row">
                                <div><div class="vnccs-i3s__scene-frame-title">Occlusion shadows</div><div class="vnccs-i3s__scene-frame-copy">Walls and opaque objects block direct light.</div></div>
                                <button class="vnccs-i3s__switch vnccs-i3s__shadow-enabled" type="button" role="switch" aria-checked="true" aria-label="Enable shadows"></button>
                            </div>
                            <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Shadow quality</span>
                                <select class="vnccs-i3s__select vnccs-i3s__shadow-quality">
                                    <option value="low">Low · 512</option><option value="medium">Medium · 1024</option><option value="high">High · 2048</option><option value="ultra">Ultra · 4096</option>
                                </select>
                            </label>
                            <div class="vnccs-i3s__hint">Active shadow-casting point lights: Low 2 · Medium 4 · High 6 · Ultra 8. Lights beyond the active budget stay stored but do not illuminate until the budget is available.</div>
                        </div>
                    </section>
                    <div class="vnccs-i3s__viewport-help">Click: select · Shift-click: multi-select · Drag gizmo: transform · W/E/R: move/rotate/scale · End: drop · F: frame</div>
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
            <aside class="vnccs-i3s__side vnccs-i3s__side--right" aria-label="Scene tools">
                <div class="vnccs-i3s__library-launcher-wrap">
                    <button class="vnccs-ps-btn primary vnccs-i3s__library-open" type="button">
                        <span class="vnccs-ps-btn-icon" aria-hidden="true">${ICONS.library}</span> Model Library
                    </button>
                    <button class="vnccs-i3s__button vnccs-i3s__ply-import" type="button" title="Import GLB, glTF, FBX, OBJ, STL, ZIP, or Gaussian PLY into the active scene">
                        ${ICONS.upload}<span>Import 3D</span>
                    </button>
                    <input class="vnccs-i3s__file-input vnccs-i3s__ply-input" type="file" multiple accept=".glb,.gltf,.fbx,.obj,.stl,.zip,.ply,.mtl,.bin,.png,.jpg,.jpeg,.webp,.bmp,.gif,.tga,application/octet-stream" tabindex="-1" />
                </div>
                <div class="vnccs-i3s__workspace-tabs vnccs-i3s__workspace-tabs--three" role="tablist" aria-label="Scene workspace">
                    <button class="vnccs-i3s__workspace-tab" type="button" role="tab"
                        data-workspace-side="right" data-workspace-tab="objects"
                        id="${this._workspaceId}-right-objects-tab"
                        title="Scene objects"
                        aria-controls="${this._workspaceId}-right-objects" aria-selected="true">
                        <span aria-hidden="true">${ICONS.folder}</span><span>Objects</span>
                        <span class="vnccs-i3s__workspace-tab-count vnccs-i3s__object-count">0</span>
                    </button>
                    <button class="vnccs-i3s__workspace-tab vnccs-i3s__workspace-tab--inspector" type="button" role="tab"
                        data-workspace-side="right" data-workspace-tab="inspector"
                        id="${this._workspaceId}-right-inspector-tab"
                        title="Selection inspector"
                        aria-controls="${this._workspaceId}-right-inspector" aria-selected="false" tabindex="-1">
                        <span aria-hidden="true">${ICONS.settings}</span><span>Inspector</span>
                        <span class="vnccs-i3s__workspace-tab-dot" aria-hidden="true"></span>
                    </button>
                    <button class="vnccs-i3s__workspace-tab" type="button" role="tab"
                        data-workspace-side="right" data-workspace-tab="export"
                        id="${this._workspaceId}-right-export-tab"
                        title="Export settings"
                        aria-controls="${this._workspaceId}-right-export" aria-selected="false" tabindex="-1">
                        <span aria-hidden="true">${ICONS.download}</span><span>Export</span>
                    </button>
                </div>
                <div class="vnccs-i3s__workspace-panels">
                <section class="vnccs-i3s__section vnccs-i3s__workspace-panel vnccs-i3s__object-section"
                    id="${this._workspaceId}-right-objects" role="tabpanel"
                    aria-labelledby="${this._workspaceId}-right-objects-tab"
                    data-workspace-side="right" data-workspace-panel="objects">
                    <div class="vnccs-i3s__section-head">
                        <span>Scene hierarchy</span>
                        <button class="vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__local-light-add" type="button" title="Add a point light to the scene">
                            ${ICONS.sun}<span>Add light</span>
                        </button>
                    </div>
                    <div class="vnccs-i3s__section-body">
                        <section class="vnccs-i3s__level-panel" aria-label="Floor levels" hidden>
                            <div class="vnccs-i3s__level-panel-head">
                                <div><strong>Levels</strong><small>Active drawing plane</small></div>
                                <button class="vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__level-add" type="button">Add level</button>
                            </div>
                            <div class="vnccs-i3s__level-list" role="listbox" aria-label="Floor levels"></div>
                        </section>
                        <label class="vnccs-i3s__search">${ICONS.search}<input class="vnccs-i3s__input vnccs-i3s__object-search" type="search" placeholder="Filter objects" /></label>
                        <div class="vnccs-i3s__layer-tools">
                            <button class="vnccs-i3s__button vnccs-i3s__group-selected" type="button" disabled>${ICONS.folder}<span>Group</span></button>
                            <span class="vnccs-i3s__selection-count">Shift-click to select multiple</span>
                        </div>
                        <div class="vnccs-i3s__object-list" data-preserve-scroll="scene-objects"></div>
                    </div>
                </section>
                <section class="vnccs-i3s__section vnccs-i3s__workspace-panel vnccs-i3s__inspector-section"
                    id="${this._workspaceId}-right-inspector" role="tabpanel"
                    aria-labelledby="${this._workspaceId}-right-inspector-tab"
                    data-workspace-side="right" data-workspace-panel="inspector" hidden>
                    <div class="vnccs-i3s__section-head">
                        <span>Selection</span>
                        <span class="vnccs-i3s__inspector-kind">Nothing selected</span>
                    </div>
                    <div class="vnccs-i3s__section-body vnccs-i3s__inspector" data-preserve-scroll="inspector">
                        <div class="vnccs-i3s__inspector-empty">Select an object, light, wall, room, opening, or camera.</div>
                    </div>
                </section>
                <section class="vnccs-i3s__section vnccs-i3s__workspace-panel vnccs-i3s__export-section"
                    id="${this._workspaceId}-right-export" role="tabpanel"
                    aria-labelledby="${this._workspaceId}-right-export-tab"
                    data-workspace-side="right" data-workspace-panel="export" hidden>
                    <div class="vnccs-i3s__section-head"><span>Output settings</span></div>
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
                            <button class="vnccs-i3s__button vnccs-i3s__scene-export" type="button">${ICONS.download}<span>Gaussian PLY</span></button>
                        </div>
                        <div class="vnccs-i3s__panorama-export">
                            <div class="vnccs-i3s__scene-frame-title">360° panorama</div>
                            <div class="vnccs-i3s__scene-frame-copy">Export a 2:1 equirectangular PNG from a saved camera position.</div>
                            <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Camera</span>
                                <select class="vnccs-i3s__select vnccs-i3s__panorama-camera"></select>
                            </label>
                            <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Resolution</span>
                                <select class="vnccs-i3s__select vnccs-i3s__panorama-size">
                                    <option value="2048">2048 × 1024 · Draft</option>
                                    <option value="4096">4096 × 2048 · High</option>
                                </select>
                            </label>
                            <div class="vnccs-i3s__panorama-summary">Add a saved camera before exporting.</div>
                            <button class="vnccs-i3s__button vnccs-i3s__button--primary vnccs-i3s__panorama-export-button" type="button" disabled>${ICONS.download}<span>Export 360° PNG</span></button>
                        </div>
                    </div>
                </section>
                </div>
            </aside>
            <div class="vnccs-i3s__toasts" aria-live="polite"></div>
            <div class="vnccs-i3s__modal-layer"></div>
        `;
        this.container = root;
    }

    _cache() {
        const $ = selector => this.container.querySelector(selector);
        this.els = {
            workspaceTabs: Array.from(this.container.querySelectorAll("[data-workspace-tab]")),
            workspacePanels: Array.from(this.container.querySelectorAll("[data-workspace-panel]")),
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
            cameraAdd: $(".vnccs-i3s__camera-add"),
            cameraCount: $(".vnccs-i3s__camera-count"),
            cameraGroupCount: $(".vnccs-i3s__camera-group-count"),
            cameraList: $(".vnccs-i3s__camera-list"),
            cameraTrackSelect: $(".vnccs-i3s__camera-track-select"),
            cameraTrackAdd: $(".vnccs-i3s__camera-track-add"),
            cameraTrackDelete: $(".vnccs-i3s__camera-track-delete"),
            cameraTrackName: $(".vnccs-i3s__camera-track-name"),
            cameraTrackBuilding: $(".vnccs-i3s__camera-track-building"),
            cameraKeyframeAdd: $(".vnccs-i3s__camera-keyframe-add"),
            cameraTrackPlay: $(".vnccs-i3s__camera-track-play"),
            cameraTrackTime: $(".vnccs-i3s__camera-track-time"),
            cameraTrackMeta: $(".vnccs-i3s__camera-track-meta"),
            cameraKeyframes: $(".vnccs-i3s__camera-keyframes"),
            donateLink: $(".vnccs-i3s__donate-link"),
            sceneName: $(".vnccs-i3s__scene-name-input"),
            sceneId: $(".vnccs-i3s__project-id"),
            sceneManager: $(".vnccs-i3s__scene-manager"),
            libraryOpen: $(".vnccs-i3s__library-open"),
            plyImport: $(".vnccs-i3s__ply-import"),
            plyInput: $(".vnccs-i3s__ply-input"),
            status: $(".vnccs-i3s__status-pill"),
            viewerHost: $(".vnccs-i3s__viewer-host"),
            view3d: $(".vnccs-i3s__view-3d"),
            viewPlan: $(".vnccs-i3s__view-plan"),
            levelPanel: $(".vnccs-i3s__level-panel"),
            levelList: $(".vnccs-i3s__level-list"),
            levelAdd: $(".vnccs-i3s__level-add"),
            undo: $(".vnccs-i3s__undo"),
            redo: $(".vnccs-i3s__redo"),
            selectionCopy: $(".vnccs-i3s__selection-copy"),
            selectionPaste: $(".vnccs-i3s__selection-paste"),
            planTools: $(".vnccs-i3s__plan-tools"),
            planToolButtons: Array.from(this.container.querySelectorAll("[data-plan-tool]")),
            openingKindShortcut: $(".vnccs-i3s__opening-kind-shortcut"),
            planGridToggle: $(".vnccs-i3s__plan-grid-toggle"),
            snapToggle: $(".vnccs-i3s__snap-toggle"),
            snapGrid: $(".vnccs-i3s__snap-grid input"),
            planSettings: Array.from(this.container.querySelectorAll("[data-plan-setting]")),
            planSettingsPanel: $(".vnccs-i3s__plan-settings"),
            planHint: $(".vnccs-i3s__plan-hint"),
            cameraPresets: Array.from(this.container.querySelectorAll("[data-camera-preset]")),
            cameraZoomSpeedRange: $(".vnccs-i3s__camera-zoom-speed-range"),
            cameraZoomSpeedValue: $(".vnccs-i3s__camera-zoom-speed-value"),
            fit: $(".vnccs-i3s__fit"),
            cutaway: $(".vnccs-i3s__cutaway"),
            modeMove: $(".vnccs-i3s__mode-move"),
            modeRotate: $(".vnccs-i3s__mode-rotate"),
            modeScale: $(".vnccs-i3s__mode-scale"),
            dropSurface: $(".vnccs-i3s__drop-surface"),
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
            shadowEnabled: $(".vnccs-i3s__shadow-enabled"),
            shadowQuality: $(".vnccs-i3s__shadow-quality"),
            localLightAdd: $(".vnccs-i3s__local-light-add"),
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
            inspector: $(".vnccs-i3s__inspector"),
            inspectorKind: $(".vnccs-i3s__inspector-kind"),
            sceneSummary: $(".vnccs-i3s__scene-summary"),
            sceneAspect: $(".vnccs-i3s__scene-aspect"),
            sceneWidth: $(".vnccs-i3s__scene-width"),
            sceneHeight: $(".vnccs-i3s__scene-height"),
            sceneFrame: $(".vnccs-i3s__scene-frame"),
            sceneRenderSummary: $(".vnccs-i3s__scene-render-summary"),
            sceneExport: $(".vnccs-i3s__scene-export"),
            panoramaCamera: $(".vnccs-i3s__panorama-camera"),
            panoramaSize: $(".vnccs-i3s__panorama-size"),
            panoramaSummary: $(".vnccs-i3s__panorama-summary"),
            panoramaExport: $(".vnccs-i3s__panorama-export-button"),
            toasts: $(".vnccs-i3s__toasts"),
            modalLayer: $(".vnccs-i3s__modal-layer"),
        };
    }

    _listen(target, type, handler, options) {
        target?.addEventListener(type, handler, options);
        this._listeners.push(() => target?.removeEventListener(type, handler, options));
    }

    _setWorkspaceTab(side, tab, { save = true, focus = false } = {}) {
        const allowed = side === "left"
            ? new Set(["generate", "cameras"])
            : new Set(["objects", "inspector", "export"]);
        if (!allowed.has(tab)) return;
        this.editorView.workspace = {
            left: this.editorView.workspace?.left || "generate",
            right: this.editorView.workspace?.right || "objects",
            [side]: tab,
        };
        let activeButton = null;
        for (const button of this.els.workspaceTabs) {
            if (button.dataset.workspaceSide !== side) continue;
            const active = button.dataset.workspaceTab === tab;
            button.setAttribute("aria-selected", String(active));
            button.tabIndex = active ? 0 : -1;
            if (active) activeButton = button;
        }
        for (const panel of this.els.workspacePanels) {
            if (panel.dataset.workspaceSide !== side) continue;
            panel.hidden = panel.dataset.workspacePanel !== tab;
        }
        this._customSelects?.refresh?.();
        if (focus) activeButton?.focus({ preventScroll: true });
        if (save) this._scheduleStateSave(0);
    }

    _syncWorkspace() {
        this._setWorkspaceTab("left", this.editorView.workspace?.left || "generate", { save: false });
        this._setWorkspaceTab("right", this.editorView.workspace?.right || "objects", { save: false });
    }

    _bindWorkspaceTabs() {
        for (const button of this.els.workspaceTabs) {
            this._listen(button, "click", () => {
                this._setWorkspaceTab(button.dataset.workspaceSide, button.dataset.workspaceTab);
            });
            this._listen(button, "keydown", event => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                const tabs = this.els.workspaceTabs.filter(
                    item => item.dataset.workspaceSide === button.dataset.workspaceSide,
                );
                const current = Math.max(0, tabs.indexOf(button));
                const next = event.key === "Home"
                    ? 0
                    : event.key === "End"
                        ? tabs.length - 1
                        : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
                event.preventDefault();
                this._setWorkspaceTab(
                    button.dataset.workspaceSide,
                    tabs[next].dataset.workspaceTab,
                    { focus: true },
                );
            });
        }
    }

    _bind() {
        this._bindWorkspaceTabs();
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
        this._listen(this.els.cameraTrackAdd, "click", () => this._addCameraTrack());
        this._listen(this.els.cameraTrackDelete, "click", () => this._deleteCameraTrack());
        this._listen(this.els.cameraKeyframeAdd, "click", () => this._addCameraKeyframe());
        this._listen(this.els.cameraTrackPlay, "click", () => this._toggleCameraPlayback());
        this._listen(this.els.cameraTrackSelect, "change", () => {
            if (this.cameraPlayback) this._toggleCameraPlayback();
            this.activeCameraTrackId = this.els.cameraTrackSelect.value;
            const track = this._activeCameraTrack();
            if (track) this.editorView.active_building_id = this._validBuildingId(track.building_id);
            this.selectedCameraKeyframeId = "";
            this._renderCameraTracks();
            this._renderInspector();
            this._syncToolbar();
            this._scheduleSceneSave(0);
            this._scheduleStateSave(0);
        });
        this._listen(this.els.cameraTrackName, "change", () => {
            const track = this._activeCameraTrack();
            if (!track) return;
            const before = this._captureEditorSnapshot();
            track.name = String(this.els.cameraTrackName.value || "Camera path").trim().slice(0, 80) || "Camera path";
            this.history.push("Rename camera path", before, this._captureEditorSnapshot());
            this._renderCameraTracks();
            this._scheduleSceneSave(0);
            this._syncToolbar();
        });
        this._listen(this.els.cameraTrackBuilding, "change", () => {
            const track = this._activeCameraTrack();
            if (!track) return;
            const before = this._captureEditorSnapshot();
            track.building_id = this._validBuildingId(this.els.cameraTrackBuilding.value);
            if (track.building_id) this.editorView.active_building_id = track.building_id;
            this.history.push("Assign camera path to building", before, this._captureEditorSnapshot());
            this._renderCameraTracks();
            this._scheduleSceneSave(0);
            this._scheduleStateSave(0);
            this._syncToolbar();
        });
        this._listen(this.els.cameraTrackTime, "input", () => {
            this._setCameraTrackTime(Number(this.els.cameraTrackTime.value));
        });
        this._listen(this.els.cameraTrackTime, "pointerdown", () => {
            if (this.cameraPlayback) this._toggleCameraPlayback();
        });
        this._listen(this.els.libraryOpen, "click", () => void this.openLibrary());
        this._listen(this.els.plyImport, "click", () => {
            if (this.currentJobId || this.importingPly) {
                this.toast("Wait for the active Factory job to finish.", "error");
                return;
            }
            this.els.plyInput.click();
        });
        this._listen(this.els.plyInput, "change", () => {
            const files = Array.from(this.els.plyInput.files || []);
            this.els.plyInput.value = "";
            if (files.length === 1 && /\.ply$/i.test(files[0].name || "")) {
                void this.importPly(files[0]);
            } else if (files.length) {
                void this.importModel(files);
            }
        });
        this._listen(this.els.sceneManager, "click", () => void this.openSceneManager());
        this._listen(this.els.sceneName, "change", () => {
            if (!this.scene) return;
            this.scene.name = this.els.sceneName.value.trim() || "Untitled scene";
            this._scheduleStateSave(0);
            void this._saveSceneNow();
        });
        this._listen(this.els.fit, "click", () => this.viewer.frameScene());
        // LiteGraph and ComfyUI listen to both Pointer Events and legacy mouse
        // events. Blocking only pointerdown/click lets the rest of a range
        // drag escape to the graph, which can clear selection or end the drag.
        for (const eventName of [
            "pointerdown",
            "pointermove",
            "pointerup",
            "pointercancel",
            "mousedown",
            "mousemove",
            "mouseup",
            "click",
            "dblclick",
        ]) {
            this._listen(this.els.inspector, eventName, event => event.stopPropagation());
        }
        // Exact-value typing belongs to the Inspector and must not trigger
        // ComfyUI graph shortcuts while an input is focused.
        this._listen(this.els.inspector, "keydown", event => event.stopPropagation());
        this._listen(this.els.inspector, "keyup", event => event.stopPropagation());
        this._listen(this.els.inspector, "wheel", event => event.stopPropagation(), { passive: true });
        for (const control of this.els.cameraPresets) {
            this._listen(control, "click", () => {
                if (!this.cameraPlayback) this.viewer.setViewPreset(control.dataset.cameraPreset);
            });
        }
        this._listen(this.els.cameraZoomSpeedRange, "input", () => {
            if (!this.cameraPlayback) {
                this.viewer.setZoomSensitivity(10 ** this.els.cameraZoomSpeedRange.valueAsNumber);
                this.els.cameraZoomSpeedValue.textContent = `${this.viewer.zoomSensitivity.toFixed(2)}×`;
                this.els.cameraZoomSpeedRange.setAttribute(
                    "aria-valuetext",
                    `${this.viewer.zoomSensitivity.toFixed(2)}×`,
                );
            }
        });
        this._listen(this.els.view3d, "click", () => this._setViewMode("3d"));
        this._listen(this.els.viewPlan, "click", () => this._setViewMode("plan"));
        this._listen(this.els.cutaway, "click", () => {
            const key = this.editorView.view_mode === "plan" ? "plan" : "three_d";
            this.editorView.interior_cutaway[key] = !this.editorView.interior_cutaway[key];
            this.viewer.setInteriorCutaway(this.editorView.interior_cutaway[key]);
            this._syncToolbar();
            this._scheduleStateSave(0);
        });
        this._listen(this.els.levelAdd, "click", () => {
            if (!this.scene) return;
            if (this.scene.levels.length >= 64) {
                this.toast("A scene can contain up to 64 floor levels.", "error");
                return;
            }
            this._recordEditorCommand("Add floor level", () => {
                const highest = normalizedLevels(this.scene.levels).at(-1);
                const level = {
                    ...DEFAULT_LEVEL,
                    level_id: factoryId(),
                    name: `Level ${this.scene.levels.length + 1}`,
                    elevation: Number(highest.elevation) + Number(highest.height),
                };
                this.scene.levels.push(level);
                this.editorView.active_level_id = level.level_id;
                void this._commitArchitecture();
                this.viewer.setActiveLevel(level.level_id);
                this._syncToolbar();
            });
        });
        this._listen(this.els.undo, "click", () => {
            this.history.undo();
            this._syncToolbar();
        });
        this._listen(this.els.redo, "click", () => {
            this.history.redo();
            this._syncToolbar();
        });
        this._listen(this.els.selectionCopy, "click", () => this._copySelection());
        this._listen(this.els.selectionPaste, "click", () => void this._pasteSelection());
        for (const control of this.els.planToolButtons) {
            this._listen(control, "click", () => this._setPlanTool(control.dataset.planTool));
        }
        this._listen(this.els.planGridToggle, "click", () => {
            this.editorView.plan_grid.visible = !this.editorView.plan_grid.visible;
            this._syncToolbar();
            this._scheduleStateSave(0);
        });
        this._listen(this.els.snapToggle, "click", () => {
            this.editorView.snap.enabled = !this.editorView.snap.enabled;
            this._syncToolbar();
            this._scheduleStateSave(0);
        });
        this._listen(this.els.snapGrid, "change", () => {
            const step = clamp(this.els.snapGrid.value, 0.001, 1000);
            this.editorView.plan_grid.step = step;
            // Preserve the legacy serialized alias for older frontends.
            this.editorView.snap.grid = step;
            this._syncToolbar();
            this._scheduleStateSave(0);
        });
        for (const control of this.els.planSettings) {
            this._listen(control, "change", () => {
                const key = control.dataset.planSetting;
                if (key === "opening_kind") {
                    this.editorView.opening_kind = control.value;
                } else if (key === "grid_step") {
                    const step = clamp(control.value, 0.001, 1000);
                    this.editorView.plan_grid.step = step;
                    this.editorView.snap.grid = step;
                } else if (key === "major_every") {
                    this.editorView.plan_grid.major_every = Math.round(clamp(control.value, 2, 100));
                } else if (control.type === "checkbox") {
                    this.editorView.snap[key] = control.checked;
                } else {
                    this.editorView.snap[key] = clamp(control.value, 0, 180);
                }
                this._syncToolbar();
                this._scheduleStateSave(0);
            });
        }
        this._listen(this.els.modeMove, "click", () => this.viewer.setMode("translate"));
        this._listen(this.els.modeRotate, "click", () => this.viewer.setMode("rotate"));
        this._listen(this.els.modeScale, "click", () => this.viewer.setMode("scale"));
        this._listen(this.els.dropSurface, "click", event => this._dropSelectionToSurface(event.shiftKey));
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
            const before = this._captureEditorSnapshot();
            this.scene.skydome.visible = this.scene.skydome.visible === false;
            this._syncSkydome();
            this._commitSkydome({ final: true });
            this._updateSceneSummary();
            this._renderObjects();
            this.history.push("Toggle skydome visibility", before, this._captureEditorSnapshot());
            this._syncToolbar();
        });
        for (const [control, key] of [
            [this.els.skydomeYaw, "yaw"],
            [this.els.skydomePitch, "pitch"],
            [this.els.skydomeRoll, "roll"],
            [this.els.skydomeExposure, "exposure"],
            [this.els.skydomeBlur, "blur"],
        ]) {
            let before = null;
            this._listen(control, "input", () => {
                if (!this.scene?.skydome) return;
                before ||= this._captureEditorSnapshot();
                this.scene.skydome[key] = Number(control.value);
                this._syncSkydome();
                this._commitSkydome();
            });
            this._listen(control, "change", () => {
                this._commitSkydome({ final: true });
                if (before) this.history.push("Edit skydome", before, this._captureEditorSnapshot());
                before = null;
                this._syncToolbar();
            });
        }
        this._listen(this.els.skydomeLevel, "click", () => {
            if (!this.scene?.skydome) return;
            const before = this._captureEditorSnapshot();
            this.scene.skydome.pitch = 0;
            this.scene.skydome.roll = 0;
            this._syncSkydome();
            this._commitSkydome({ final: true });
            this.history.push("Level skydome horizon", before, this._captureEditorSnapshot());
            this._syncToolbar();
        });
        this._listen(this.els.skydomeReset, "click", () => {
            if (!this.scene?.skydome) return;
            const before = this._captureEditorSnapshot();
            Object.assign(this.scene.skydome, { yaw: 0, pitch: 0, roll: 0 });
            this._syncSkydome();
            this._commitSkydome({ final: true });
            this.history.push("Reset skydome orientation", before, this._captureEditorSnapshot());
            this._syncToolbar();
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
            if (this.els.planSettingsPanel.open && !this.els.planSettingsPanel.contains(event.target)) {
                this.els.planSettingsPanel.open = false;
            }
        });
        // Match Pose Studio's timeline shortcut routing: capture the command
        // before ComfyUI's global graph handlers, but only while this Factory
        // editor owns focus and never while the user edits a form control.
        this._listen(window, "keydown", event => {
            const activeWithin = this.container.contains(event.target)
                || this.container.contains(document.activeElement);
            if (!activeWithin) return;
            if (
                this.els.modalLayer.classList.contains("is-open")
                || this.libraryOverlay?.isConnected
            ) return;
            const target = event.target;
            const editing = target instanceof HTMLInputElement
                || target instanceof HTMLTextAreaElement
                || target instanceof HTMLSelectElement
                || target?.isContentEditable;
            if (editing) return;
            if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault();
                event.stopImmediatePropagation();
                const deleteControl = this.els.inspector.querySelector(
                    '[data-inspector-action="delete"]',
                );
                if (deleteControl && !deleteControl.disabled) deleteControl.click();
                return;
            }
            const command = event.ctrlKey || event.metaKey;
            if (!command || event.altKey || event.shiftKey) return;
            const key = String(event.key || "").toLowerCase();
            if (key !== "c" && key !== "v") return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (key === "c") this._copySelection();
            else void this._pasteSelection();
        }, true);
        this._listen(document, "keydown", event => {
            const activeWithin = this.container.contains(event.target)
                || this.container.contains(document.activeElement);
            const editing = event.target instanceof HTMLInputElement
                || event.target instanceof HTMLTextAreaElement
                || event.target instanceof HTMLSelectElement
                || event.target?.isContentEditable;
            const modifier = event.ctrlKey || event.metaKey;
            if (activeWithin && !editing && modifier && event.key.toLowerCase() === "z") {
                event.preventDefault();
                if (event.shiftKey) this.history.redo();
                else this.history.undo();
                this._syncToolbar();
                return;
            }
            if (activeWithin && !editing && modifier && event.key.toLowerCase() === "y") {
                event.preventDefault();
                this.history.redo();
                this._syncToolbar();
                return;
            }
            if (activeWithin && !editing && event.key === "Escape" && this.cameraPlayback) {
                event.preventDefault();
                this._toggleCameraPlayback();
                return;
            }
            if (activeWithin && !editing && event.key === "Escape" && this.previewCameraId) {
                event.preventDefault();
                this._exitCameraView({ restore: true });
                return;
            }
            if (
                activeWithin
                && !editing
                && event.key === "Escape"
                && this.editorView.view_mode === "plan"
                && this.editorView.plan_tool !== "select"
            ) {
                event.preventDefault();
                this._setPlanTool("select");
                return;
            }
            if (activeWithin && !editing && event.key.toLowerCase() === "v") {
                event.preventDefault();
                if (this.editorView.view_mode === "plan") this._setPlanTool("select");
                else this.viewer.setMode("translate");
                return;
            }
            if (activeWithin && !editing && event.key === "End") {
                event.preventDefault();
                this._dropSelectionToSurface(event.shiftKey);
                return;
            }
            if (event.key === "Escape" && !this.els.lightingPanel.hidden) {
                this._setLightingPanelOpen(false);
                return;
            }
            if (event.key === "Escape" && !this.els.skydomePanel.hidden) {
                this._setSkydomePanelOpen(false);
                return;
            }
            if (event.key === "Escape" && this.els.planSettingsPanel.open) {
                this.els.planSettingsPanel.open = false;
                return;
            }
            if (activeWithin && !editing && event.key === "Escape") {
                event.preventDefault();
                this._clearSelection();
            }
        });
        for (const presetButton of this.els.lightingPresets) {
            this._listen(presetButton, "click", () => {
                const before = this._captureEditorSnapshot();
                const key = presetButton.dataset.preset;
                const preset = LIGHTING_PRESETS[key];
                if (!preset) return;
                this.lighting = {
                    ...this.lighting,
                    preset: key,
                    ...preset,
                    shadows: { ...this.lighting.shadows },
                    lights: [...(this.lighting.lights || [])],
                };
                delete this.lighting.label;
                this._syncLighting();
                this._commitLighting({ final: true });
                this.history.push("Change lighting preset", before, this._captureEditorSnapshot());
            });
        }
        this._listen(this.els.lightIntensity, "input", () => {
            this._beginLightingHistory();
            this.lighting.intensity = Number(this.els.lightIntensity.value);
            this.lighting.preset = "custom";
            this._syncLighting();
            this._commitLighting();
        });
        this._listen(this.els.lightIntensity, "change", () => {
            this._commitLighting({ final: true });
            this._finishLightingHistory("Edit light strength");
        });
        this._listen(this.els.lightColor, "input", () => {
            this._beginLightingHistory();
            this.lighting.color = this.els.lightColor.value;
            this.lighting.preset = "custom";
            this._syncLighting();
            this._commitLighting();
        });
        this._listen(this.els.lightColor, "change", () => {
            this._commitLighting({ final: true });
            this._finishLightingHistory("Edit light color");
        });
        this._listen(this.els.lightElevation, "input", () => {
            this._beginLightingHistory();
            this.lighting.elevation = Number(this.els.lightElevation.value);
            this.lighting.preset = "custom";
            this._syncLighting();
            this._commitLighting();
        });
        this._listen(this.els.lightElevation, "change", () => {
            this._commitLighting({ final: true });
            this._finishLightingHistory("Edit light direction");
        });
        this._listen(this.els.shadowEnabled, "click", () => {
            const before = this._captureEditorSnapshot();
            this.lighting.shadows.enabled = !this.lighting.shadows.enabled;
            this._syncLighting();
            this._commitLighting({ final: true });
            this.history.push("Toggle shadows", before, this._captureEditorSnapshot());
        });
        this._listen(this.els.shadowQuality, "change", () => {
            const before = this._captureEditorSnapshot();
            this.lighting.shadows.quality = this.els.shadowQuality.value;
            this.lighting.shadows.enabled = true;
            this._syncLighting();
            this._commitLighting({ final: true });
            this.history.push("Change shadow quality", before, this._captureEditorSnapshot());
        });
        this._listen(this.els.localLightAdd, "click", () => {
            if (this.lighting.lights.length >= 32) {
                this.toast("A scene can contain up to 32 local lights.", "error");
                return;
            }
            const shadowBudget = { low: 2, medium: 4, high: 6, ultra: 8 }[
                this.lighting.shadows?.quality
            ] || 0;
            const activeShadowLights = this.lighting.lights.filter(
                light => light.visible !== false && light.cast_shadow !== false,
            ).length;
            const shadowBudgetExhausted = Boolean(
                this.lighting.shadows?.enabled
                && this.lighting.shadows?.quality !== "off"
                && activeShadowLights >= shadowBudget
            );
            const before = this._captureEditorSnapshot();
            const level = this.scene?.levels?.find(value => value.level_id === this.editorView.active_level_id);
            const building = this._activeBuilding();
            const buildingElevation = Number(building?.position?.[1]) || 0;
            const planTarget = this.viewer?.getState?.().plan_camera?.target || [0, 0];
            const cameraTarget = this.viewer?.getCameraState?.().target || [0, 0, 0];
            const center = this.editorView.view_mode === "plan"
                ? [Number(planTarget[0]) || 0, Number(planTarget[1]) || 0]
                : [Number(cameraTarget[0]) || 0, Number(cameraTarget[2]) || 0];
            const lightId = factoryId();
            this.lighting.lights.push({
                light_id: lightId,
                name: `Light ${this.lighting.lights.length + 1}`,
                level_id: this.editorView.active_level_id,
                building_id: building?.building_id || "",
                kind: "point",
                position: [center[0], (Number(level?.elevation) || 0) + buildingElevation + 2.4, center[1]],
                target: [center[0], (Number(level?.elevation) || 0) + buildingElevation, center[1]],
                color: "#ffffff",
                intensity: 10,
                distance: 8,
                angle: 45,
                penumbra: 0.2,
                cast_shadow: !shadowBudgetExhausted,
                visible: true,
            });
            this._selectLight(lightId);
            if (before) this.history.push("Add light", before, this._captureEditorSnapshot());
            this._syncLighting();
            this._commitLighting({ final: true });
            this._renderObjects();
            this._updateSceneSummary();
            this._syncToolbar();
            if (shadowBudgetExhausted) {
                this.toast(
                    `Light added without shadows. ${this.lighting.shadows.quality} quality supports ${shadowBudget} shadow-casting point light${shadowBudget === 1 ? "" : "s"}.`,
                    "info",
                );
            }
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
        this._listen(this.els.panoramaCamera, "change", () => {
            this.panoramaCameraId = this.els.panoramaCamera.value;
            this._syncPanoramaExportControls();
            this._scheduleStateSave(0);
        });
        this._listen(this.els.panoramaSize, "change", () => {
            this.panoramaWidth = [2048, 4096].includes(Number(this.els.panoramaSize.value))
                ? Number(this.els.panoramaSize.value)
                : 4096;
            this._syncPanoramaExportControls();
            this._scheduleStateSave(0);
        });
        this._listen(this.els.panoramaExport, "click", () => void this.exportPanorama());
    }

    _captureEditorSnapshot() {
        if (!this.scene) return null;
        return JSON.parse(JSON.stringify({
            levels: this.scene.levels || [],
            architecture: this.scene.architecture || {},
            objects: (this.scene.objects || []).map(item => ({
                object_id: item.object_id,
                name: item.name,
                level_id: item.level_id,
                building_id: item.building_id,
                transform: item.transform,
                visible: item.visible !== false,
                ...normalizedObjectEditorProperties(item),
            })),
            layers: this.scene.layers || [],
            cameras: this.scene.cameras || [],
            camera_tracks: this.scene.camera_tracks || [],
            lighting: this.lighting,
            skydome: this.scene.skydome || null,
            render: this.exportSettings,
        }));
    }

    _dropSelectionToSurface(individual = false) {
        if (!this.scene || !this.viewer) return;
        const before = this._captureEditorSnapshot();
        let results = null;
        this._suppressViewerTransformHistory = true;
        try { results = this.viewer.dropSelectionToSurface({ individual }); }
        finally {
            this._suppressViewerTransformHistory = false;
            this._viewerTransformHistoryBefore = null;
        }
        if (!results?.length) {
            this.toast("Select an unlocked object to drop.", "info");
            return;
        }
        this.history.push("Drop to surface", before, this._captureEditorSnapshot());
        const support = Math.max(...results.map(result => Number(result.supportY) || 0));
        this.toast(`Placed on the nearest support at ${support.toFixed(2)} m.`, "success");
        this._renderInspector();
        this._scheduleSceneSave(0);
        this._scheduleStateSave(0);
        this._scheduleScenePreview(120);
    }

    _placeNewObjectOnActiveFloor(objectId) {
        const item = this.scene?.objects?.find(value => value.object_id === objectId);
        const targetLevel = this.scene?.levels?.find(
            value => value.level_id === this.editorView.active_level_id,
        );
        if (!item || !targetLevel) return false;
        const previousLevel = this.scene.levels.find(value => value.level_id === item.level_id);
        const before = this._captureEditorSnapshot();
        item.transform ||= { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
        item.transform.position = Array.isArray(item.transform.position)
            ? [...item.transform.position]
            : [0, 0, 0];
        const targetBuilding = this._activeBuilding()
            || this.scene.architecture?.buildings?.[0]
            || null;
        item.transform.position[0] += Number(targetBuilding?.position?.[0]) || 0;
        item.transform.position[1] += (Number(targetLevel.elevation) || 0)
            - (Number(previousLevel?.elevation) || 0)
            + (Number(targetBuilding?.position?.[1]) || 0);
        item.transform.position[2] += Number(targetBuilding?.position?.[2]) || 0;
        item.level_id = targetLevel.level_id;
        item.building_id = targetBuilding?.building_id
            || "";
        this.viewer.updateObject(item.object_id, item);
        this._selectObject(item.object_id);
        this.history.push("Place new object on active floor", before, this._captureEditorSnapshot());
        this._dropSelectionToSurface(false);
        this._renderObjects();
        this._scheduleSceneSave(0);
        return true;
    }

    _recordEditorCommand(label, operation) {
        if (!this.scene) return operation?.();
        const before = this._captureEditorSnapshot();
        const result = operation?.();
        const finish = () => {
            const after = this._captureEditorSnapshot();
            this.history.push(label, before, after);
            this._scheduleStateSave(0);
            this._syncToolbar();
        };
        if (result?.then) return result.finally(finish);
        finish();
        return result;
    }

    async _restoreEditorSnapshot(snapshot) {
        if (!this.scene || !snapshot) return;
        this.scene.levels = normalizedLevels(snapshot.levels);
        this.scene.architecture = normalizedArchitecture(snapshot.architecture, this.scene.levels);
        const byId = new Map((snapshot.objects || []).map(item => [item.object_id, item]));
        for (const item of this.scene.objects || []) {
            const restored = byId.get(item.object_id);
            if (restored) Object.assign(item, restored);
        }
        this.scene.cameras = this._normalizeSceneCameras(snapshot.cameras);
        this.scene.camera_tracks = Array.isArray(snapshot.camera_tracks)
            ? JSON.parse(JSON.stringify(snapshot.camera_tracks)).map(track => ({
                ...track,
                building_id: this._validBuildingId(track.building_id),
            }))
            : [];
        this.scene.layers = Array.isArray(snapshot.layers)
            ? JSON.parse(JSON.stringify(snapshot.layers))
            : this.scene.layers;
        this.scene.lighting = this._normalizeLighting(snapshot.lighting);
        this.lighting = { ...this.scene.lighting };
        this.scene.skydome = snapshot.skydome
            ? JSON.parse(JSON.stringify(snapshot.skydome))
            : null;
        this.exportSettings = { ...this.exportSettings, ...safeObject(snapshot.render) };
        await this.viewer.setScene(this.scene, { incremental: true });
        this.viewer.setViewMode(this.editorView.view_mode);
        this.viewer.setPlanTool(this.editorView.plan_tool);
        this.viewer.setActiveLevel(this.editorView.active_level_id);
        this.viewer.setArchitectureSelection(
            this.selectedArchitecture,
            this._selectedArchitectureRefs(),
        );
        this.viewer.applySceneVisibility(this.scene);
        this.viewer.setCameraMarkers(this.scene.cameras || []);
        this.viewer.setLighting(this.lighting);
        this._renderObjects();
        this._renderCameras();
        this._renderCameraTracks();
        this._renderInspector();
        this._syncLighting();
        this._syncSkydome();
        this._syncExportSettings();
        this._syncToolbar();
        this._scheduleSceneSave(0);
        this._scheduleScenePreview(120);
        this._scheduleStateSave(0);
    }

    _setViewMode(mode) {
        this.editorView.view_mode = mode === "plan" ? "plan" : "3d";
        if (this.editorView.view_mode !== "plan") this._cancelPlanDraft();
        this.viewer.setViewMode(this.editorView.view_mode);
        const cutawayKey = this.editorView.view_mode === "plan" ? "plan" : "three_d";
        this.viewer.setInteriorCutaway(this.editorView.interior_cutaway[cutawayKey]);
        this._syncToolbar();
        this._scheduleStateSave(0);
    }

    _syncCameraPanelControls() {
        if (!this.els?.cameraZoomSpeedRange) return;
        const zoomSensitivity = clamp(Number(this.viewerState.zoom_sensitivity) || 0.1, 0.01, 2);
        if (document.activeElement !== this.els.cameraZoomSpeedRange) {
            this.els.cameraZoomSpeedRange.value = String(Math.log10(zoomSensitivity));
        }
        const label = `${zoomSensitivity.toFixed(2)}×`;
        this.els.cameraZoomSpeedValue.textContent = label;
        this.els.cameraZoomSpeedRange.setAttribute("aria-valuetext", label);
        const disabled = Boolean(this.cameraPlayback) || this.editorView.view_mode === "plan";
        this.els.cameraZoomSpeedRange.disabled = disabled;
        for (const control of this.els.cameraPresets) control.disabled = disabled;
    }

    _setPlanTool(tool) {
        if (!["select", "wall", "room", "opening", "camera"].includes(tool)) return;
        if (this.planDraft && this.planDraft.tool !== tool) this._cancelPlanDraft();
        this._clearPlanHover();
        this.editorView.plan_tool = tool;
        this.viewer.setPlanTool(tool);
        this._renderPlanPreview();
        this._syncToolbar();
        this._scheduleStateSave(0);
    }

    _clearPlanHover() {
        if (this._planHoverFrame) cancelAnimationFrame(this._planHoverFrame);
        this._planHoverFrame = 0;
        this._pendingPlanHover = null;
        this.planHover = null;
    }

    _queuePlanHover(tool, rawPoint, event = {}) {
        this._pendingPlanHover = {
            tool,
            point: Array.isArray(rawPoint) ? [...rawPoint] : null,
            event: {
                altKey: Boolean(event.altKey),
                shiftKey: Boolean(event.shiftKey),
            },
        };
        if (this._planHoverFrame) return;
        this._planHoverFrame = requestAnimationFrame(() => {
            this._planHoverFrame = 0;
            const pending = this._pendingPlanHover;
            this._pendingPlanHover = null;
            if (!pending || this.editorView.view_mode !== "plan" || pending.tool !== this.editorView.plan_tool) {
                return;
            }
            if (!pending.point) {
                this.planHover = null;
                this._renderPlanPreview();
                return;
            }
            // Opening owns a stronger wall-projection snap. Rounding the
            // cursor to the global grid first can move it away from a thin
            // wall at high zoom and make an otherwise valid click look inert.
            const point = pending.tool === "opening"
                ? [...pending.point]
                : this._snapPlanPoint(pending.point, pending.event);
            if (pending.tool === "opening") this.planSnapHint = "Wall projection";
            const nearest = pending.tool === "opening"
                ? this._nearestWallProjection(point)
                : null;
            const openingKind = this.editorView.opening_kind || "window";
            const openingPlacement = nearest
                ? this._openingPlacement(nearest, openingKind === "door" ? 0.9 : 1.2)
                : null;
            if (openingPlacement) openingPlacement.kind = openingKind;
            this.planHover = {
                tool: pending.tool,
                point,
                opening: openingPlacement,
            };
            const previous = this.planDraft?.points?.at(-1);
            const measurement = previous
                ? ` · ${Math.hypot(point[0] - previous[0], point[1] - previous[1]).toFixed(2)} m · ${((Math.atan2(point[1] - previous[1], point[0] - previous[0]) * 180 / Math.PI + 360) % 360).toFixed(1)}°`
                : "";
            if (pending.tool === "opening") {
                this.els.planHint.textContent = openingPlacement
                    ? `Press and drag on the wall to set width · ${nearest.length.toFixed(2)} m wall`
                    : nearest
                        ? "This wall has no free span for another opening."
                        : "Move over an editable wall, then press and drag.";
            } else if (pending.tool === "camera" && previous) {
                this.els.planHint.textContent = `Aim camera${measurement}`;
            } else {
                this.els.planHint.textContent = `${this.planSnapHint || "Free"}${measurement}`;
            }
            this._renderPlanPreview();
        });
    }

    _roomRectangle(start, end) {
        if (!Array.isArray(start) || !Array.isArray(end)) return null;
        if (Math.abs(end[0] - start[0]) < 0.001 || Math.abs(end[1] - start[1]) < 0.001) return null;
        return [
            [start[0], start[1]],
            [end[0], start[1]],
            [end[0], end[1]],
            [start[0], end[1]],
        ];
    }

    _activeBuilding() {
        const buildings = this.scene?.architecture?.buildings || [];
        if (this.selectedArchitecture?.type === "building") {
            const selected = buildings.find(item => item.building_id === this.selectedArchitecture.id);
            if (selected) return selected;
        }
        const selectedItem = this._selectedArchitectureValue();
        if (selectedItem?.building_id) {
            const owner = buildings.find(item => item.building_id === selectedItem.building_id);
            if (owner) return owner;
        }
        const selectedObject = this.scene?.objects?.find(item => item.object_id === this.selectedObjectId);
        if (selectedObject?.building_id) {
            const owner = buildings.find(item => item.building_id === selectedObject.building_id);
            if (owner) return owner;
        }
        const selectedCamera = this.scene?.cameras?.find(item => item.camera_id === this.selectedCameraId);
        if (selectedCamera?.building_id) {
            const owner = buildings.find(item => item.building_id === selectedCamera.building_id);
            if (owner) return owner;
        }
        const selectedGroup = this._groupById(this.selectedGroupId);
        const groupedObject = selectedGroup?.children?.length
            ? this.scene?.objects?.find(item => item.object_id === selectedGroup.children[0])
            : null;
        if (groupedObject?.building_id) {
            const owner = buildings.find(item => item.building_id === groupedObject.building_id);
            if (owner) return owner;
        }
        if (this.selectedCameraKeyframeId) {
            const track = this._activeCameraTrack();
            const owner = buildings.find(item => item.building_id === track?.building_id);
            if (owner) return owner;
        }
        return null;
    }

    _buildingForItem(item) {
        const buildingId = String(item?.building_id || "");
        if (!buildingId) return null;
        return this.scene?.architecture?.buildings?.find(
            building => building.building_id === buildingId,
        ) || null;
    }

    _validBuildingId(value) {
        const buildings = this.scene?.architecture?.buildings || [];
        const requested = String(value || "");
        return buildings.some(building => building.building_id === requested)
            ? requested
            : "";
    }

    _buildingOptions(selectedId = "") {
        const valid = this._validBuildingId(selectedId);
        return `<option value=""${valid ? "" : " selected"}>No building</option>`
            + (this.scene?.architecture?.buildings || []).map(building => (
            `<option value="${building.building_id}"${building.building_id === valid ? " selected" : ""}>${escapeHTML(building.name || "Building")}</option>`
        )).join("");
    }

    _transformPointWithBuilding(point, previousPosition, nextPosition, deltaRotationDegrees) {
        const source = Array.isArray(point) ? point : [0, 0, 0];
        const angle = Number(deltaRotationDegrees || 0) * Math.PI / 180;
        const cosine = Math.cos(angle);
        const sine = Math.sin(angle);
        const x = (Number(source[0]) || 0) - previousPosition[0];
        const z = (Number(source[2]) || 0) - previousPosition[2];
        return [
            x * cosine + z * sine + nextPosition[0],
            (Number(source[1]) || 0) + nextPosition[1] - previousPosition[1],
            -x * sine + z * cosine + nextPosition[2],
        ];
    }

    _applyBuildingTransform(building, nextPosition, nextRotationY) {
        if (!building) return;
        const previousPosition = [0, 1, 2].map(index => Number(building.position?.[index]) || 0);
        const position = [0, 1, 2].map(index => Number(nextPosition?.[index]) || 0);
        const previousRotation = Number(building.rotation_y) || 0;
        const rotation = Number(nextRotationY) || 0;
        const deltaRotation = rotation - previousRotation;
        const hasPositionDelta = position.some((value, index) => Math.abs(value - previousPosition[index]) > 1e-12);
        if (!hasPositionDelta && Math.abs(deltaRotation) <= 1e-12) return;
        const transformPoint = point => this._transformPointWithBuilding(
            point,
            previousPosition,
            position,
            deltaRotation,
        );
        for (const object of this.scene?.objects || []) {
            if (object.building_id !== building.building_id) continue;
            object.transform ||= { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
            object.transform.position = transformPoint(object.transform.position);
            object.transform.rotation = Array.isArray(object.transform.rotation)
                ? [...object.transform.rotation]
                : [0, 0, 0];
            object.transform.rotation[1] = (Number(object.transform.rotation[1]) || 0) + deltaRotation;
            this.viewer?.updateObject(object.object_id, { transform: object.transform });
        }
        for (const camera of this.scene?.cameras || []) {
            if (camera.building_id !== building.building_id) continue;
            camera.position = transformPoint(camera.position);
            camera.target = transformPoint(camera.target);
            if (Array.isArray(camera.up) && Math.abs(deltaRotation) > 1e-12) {
                const angle = deltaRotation * Math.PI / 180;
                const cosine = Math.cos(angle);
                const sine = Math.sin(angle);
                const x = Number(camera.up[0]) || 0;
                const z = Number(camera.up[2]) || 0;
                camera.up = [x * cosine + z * sine, Number(camera.up[1]) || 0, -x * sine + z * cosine];
            }
        }
        if (Math.abs(deltaRotation) > 1e-12 || hasPositionDelta) {
            const halfYaw = deltaRotation * Math.PI / 360;
            const yaw = [0, Math.sin(halfYaw), 0, Math.cos(halfYaw)];
            for (const track of this.scene?.camera_tracks || []) {
                if (track.building_id !== building.building_id) continue;
                for (const frame of track.keyframes || []) {
                    frame.position = transformPoint(frame.position);
                    if (Math.abs(deltaRotation) > 1e-12) {
                        frame.quaternion = multiplyQuaternions(yaw, frame.quaternion);
                    }
                }
            }
        }
        for (const light of this.lighting?.lights || []) {
            if (light.building_id !== building.building_id) continue;
            light.position = transformPoint(light.position);
            light.target = transformPoint(light.target);
        }
        building.position = position;
        building.rotation_y = rotation;
        if (this.previewCameraId) {
            const preview = this.scene?.cameras?.find(camera => camera.camera_id === this.previewCameraId);
            if (preview?.building_id === building.building_id) {
                this.viewer?.setCameraState(preview, { emit: false });
            }
        }
        this.viewer?.setCameraMarkers(this.scene?.cameras || []);
        if (this.lighting) {
            this.scene.lighting = { ...this.lighting };
            this.viewer?.setLighting(this.lighting);
        }
    }

    _localToWorldPlan(point, building) {
        const angle = Number(building?.rotation_y || 0) * Math.PI / 180;
        const cosine = Math.cos(angle);
        const sine = Math.sin(angle);
        const x = Number(point?.[0]) || 0;
        const z = Number(point?.[1]) || 0;
        return [
            x * cosine + z * sine + (Number(building?.position?.[0]) || 0),
            -x * sine + z * cosine + (Number(building?.position?.[2]) || 0),
        ];
    }

    _worldToLocalPlan(point, building) {
        const angle = -Number(building?.rotation_y || 0) * Math.PI / 180;
        const cosine = Math.cos(angle);
        const sine = Math.sin(angle);
        const x = (Number(point?.[0]) || 0) - (Number(building?.position?.[0]) || 0);
        const z = (Number(point?.[1]) || 0) - (Number(building?.position?.[2]) || 0);
        return [
            Number((x * cosine + z * sine).toFixed(6)),
            Number((-x * sine + z * cosine).toFixed(6)),
        ];
    }

    _renderPlanPreview() {
        if (!this.viewer) return;
        const hover = this.planHover?.tool === this.editorView.plan_tool
            ? this.planHover
            : null;
        if (this.planDraft?.tool === "wall") {
            this.viewer.setPlanDraft({
                ...this.planDraft,
                cursor: hover?.point || null,
                thickness: DEFAULT_WALL.thickness,
            });
            return;
        }
        if (this.planDraft?.tool === "room") {
            const start = this.planDraft.points?.[0];
            this.viewer.setPlanDraft({
                ...this.planDraft,
                cursor: hover?.point || null,
                rectangle: this._roomRectangle(start, hover?.point),
                thickness: DEFAULT_WALL.thickness,
            });
            return;
        }
        if (hover?.tool === "opening") {
            this.viewer.setPlanDraft({
                tool: "opening",
                cursor: hover.point,
                opening: hover.opening,
            });
            return;
        }
        if (this.planDraft?.tool === "camera") {
            this.viewer.setPlanDraft({
                ...this.planDraft,
                cursor: hover?.point || null,
                fov: 42,
            });
            return;
        }
        if (hover && ["camera"].includes(hover.tool)) {
            this.viewer.setPlanDraft({ tool: hover.tool, cursor: hover.point, fov: 42 });
            return;
        }
        this.viewer.setPlanDraft(null);
    }

    _snapPlanPoint(point, event = {}, snapOrigin = null) {
        const pointerPoint = [...point];
        const result = [...point];
        if (event.altKey || this.editorView.snap?.enabled === false) {
            this.planSnapHint = event.altKey ? "Snap temporarily bypassed" : "Snap off";
            return result;
        }
        const grid = Math.max(
            0.001,
            Number(this.editorView.plan_grid?.step ?? this.editorView.snap?.grid) || 0.1,
        );
        result[0] = Math.round(result[0] / grid) * grid;
        result[1] = Math.round(result[1] / grid) * grid;
        this.planSnapHint = `Grid ${grid.toLocaleString()} m`;
        const previous = Array.isArray(snapOrigin)
            ? snapOrigin
            : ["wall", "camera"].includes(this.planDraft?.tool)
                ? this.planDraft.points?.at(-1)
                : null;
        if (previous && (event.shiftKey || this.editorView.snap?.orthogonal)) {
            const dx = Math.abs(result[0] - previous[0]);
            const dz = Math.abs(result[1] - previous[1]);
            if (event.shiftKey || Math.min(dx, dz) <= grid * 0.35) {
                if (dx >= dz) result[1] = previous[1];
                else result[0] = previous[0];
                this.planSnapHint = "Orthogonal";
            }
        }
        if (previous && !event.shiftKey && Number(this.editorView.snap?.angle) > 0) {
            const dx = result[0] - previous[0];
            const dz = result[1] - previous[1];
            const radius = Math.hypot(dx, dz);
            const increment = Number(this.editorView.snap.angle) * Math.PI / 180;
            const angle = Math.atan2(dz, dx);
            const snappedAngle = Math.round(angle / increment) * increment;
            const delta = Math.abs(Math.atan2(Math.sin(angle - snappedAngle), Math.cos(angle - snappedAngle)));
            if (radius > 0.001 && delta <= Math.min(increment * 0.3, 3 * Math.PI / 180)) {
                result[0] = previous[0] + Math.cos(snappedAngle) * radius;
                result[1] = previous[1] + Math.sin(snappedAngle) * radius;
                this.planSnapHint = `Angle ${this.editorView.snap.angle}°`;
            }
        }
        const threshold = 10 / Math.max(0.01, Number(this.viewerState.plan_camera?.zoom) || 24);
        let nearest = null;
        for (const wall of this.scene?.architecture?.walls || []) {
            if (wall.level_id !== this.editorView.active_level_id) continue;
            const building = this._buildingForItem(wall);
            if (wall.visible === false || building?.visible === false) continue;
            const wallStart = this._localToWorldPlan(wall.start, building);
            const wallEnd = this._localToWorldPlan(wall.end, building);
            const candidates = [];
            if (this.editorView.snap?.endpoints !== false) {
                candidates.push({ point: wallStart, kind: "Endpoint" }, { point: wallEnd, kind: "Endpoint" });
            }
            if (this.editorView.snap?.midpoints !== false) {
                candidates.push({
                    point: [
                        (wallStart[0] + wallEnd[0]) * 0.5,
                        (wallStart[1] + wallEnd[1]) * 0.5,
                    ],
                    kind: "Midpoint",
                });
            }
            for (const candidate of candidates) {
                const distance = Math.hypot(
                    pointerPoint[0] - candidate.point[0],
                    pointerPoint[1] - candidate.point[1],
                );
                if (distance <= threshold && (!nearest || distance < nearest.distance)) {
                    nearest = { point: candidate.point, distance, kind: candidate.kind };
                }
            }
        }
        if (nearest) this.planSnapHint = nearest.kind;
        return nearest ? [...nearest.point] : result.map(value => Number(value.toFixed(6)));
    }

    _wallProjection(point, wall) {
        if (!Array.isArray(point) || !wall) return null;
        const building = this._buildingForItem(wall);
        const wallStart = this._localToWorldPlan(wall.start, building);
        const wallEnd = this._localToWorldPlan(wall.end, building);
        const dx = wallEnd[0] - wallStart[0];
        const dz = wallEnd[1] - wallStart[1];
        const lengthSquared = dx * dx + dz * dz;
        if (lengthSquared < 1e-9) return null;
        const offset = clamp(
            ((point[0] - wallStart[0]) * dx + (point[1] - wallStart[1]) * dz) / lengthSquared,
            0,
            1,
        );
        const projected = [wallStart[0] + dx * offset, wallStart[1] + dz * offset];
        return {
            wall,
            offset,
            distance: Math.hypot(point[0] - projected[0], point[1] - projected[1]),
            point: projected,
            length: Math.sqrt(lengthSquared),
        };
    }

    _openingDragPlacement(startProjection, point, kind) {
        const endProjection = this._wallProjection(point, startProjection?.wall);
        if (!startProjection || !endProjection) return null;
        const width = Math.abs(endProjection.offset - startProjection.offset) * endProjection.length;
        const centerOffset = (startProjection.offset + endProjection.offset) * 0.5;
        const placement = this._openingPlacement({
            ...endProjection,
            offset: centerOffset,
        }, width);
        if (placement) placement.kind = kind;
        return placement;
    }

    _createOpeningFromPlacement(placement, kind) {
        if (!placement) return false;
        if (this.scene.architecture.openings.length >= 4096) {
            this.toast("The scene opening limit has been reached.", "error");
            return false;
        }
        const openingId = factoryId();
        this._recordEditorCommand("Create opening", () => {
            this.scene.architecture.openings.push({
                opening_id: openingId,
                wall_id: placement.wall.wall_id,
                name: kind === "door" ? "Door" : kind === "empty" ? "Opening" : "Window",
                kind,
                offset: placement.offset,
                width: placement.width,
                height: kind === "door" ? 2 : 1.2,
                sill_height: kind === "door" ? 0 : 0.9,
                material_id: "",
                visible: true,
                locked: false,
            });
            this.selectedArchitecture = { type: "opening", id: openingId };
            this.selectedArchitectureItems = new Map([[
                this._architectureSelectionKey(this.selectedArchitecture),
                this.selectedArchitecture,
            ]]);
            this.viewer.setArchitectureSelection(
                this.selectedArchitecture,
                this._selectedArchitectureRefs(),
            );
            void this._commitArchitecture();
        });
        return true;
    }

    _onPlanGesture(gesture = {}) {
        const phase = String(gesture.phase || "");
        const tool = String(gesture.tool || "");
        const event = gesture.event || {};
        const rawPoint = Array.isArray(gesture.point) ? gesture.point : null;
        if (!this.scene || !["wall", "room", "opening", "camera"].includes(tool)) return;

        if (phase === "cancel") {
            this._cancelPlanDraft();
            this._syncToolbar();
            return;
        }
        if (!rawPoint) return;

        if (phase === "start") {
            if (this._planHoverFrame) cancelAnimationFrame(this._planHoverFrame);
            this._planHoverFrame = 0;
            this._pendingPlanHover = null;
            if (["wall", "room"].includes(tool) && this._activeBuilding()?.locked) {
                this.toast("Unlock the active building before editing its plan.", "info");
                this.planDraft = null;
                return;
            }
            if (tool === "opening") {
                const projection = this._nearestWallProjection(rawPoint);
                this.planDraft = {
                    tool,
                    points: projection ? [projection.point] : [],
                    openingStart: projection,
                };
                this.planHover = { tool, point: [...rawPoint], opening: null };
                this.els.planHint.textContent = projection
                    ? "Drag along the wall to set the opening width"
                    : "Start the drag on an editable wall";
            } else {
                const point = this._snapPlanPoint(rawPoint, event);
                this.planDraft = { tool, points: [point] };
                this.planHover = { tool, point };
                this.els.planHint.textContent = tool === "wall"
                    ? "Drag to set wall length"
                    : tool === "room"
                        ? "Drag diagonally to size the room"
                        : "Drag to aim the camera";
            }
            this._renderPlanPreview();
            return;
        }

        const draft = this.planDraft;
        if (!draft || draft.tool !== tool) return;
        let point = rawPoint;
        let placement = null;
        if (tool === "opening") {
            const kind = this.editorView.opening_kind || "window";
            placement = this._openingDragPlacement(draft.openingStart, rawPoint, kind);
            const projected = this._wallProjection(rawPoint, draft.openingStart?.wall);
            point = projected?.point || rawPoint;
            this.planHover = { tool, point, opening: placement };
        } else {
            const origin = ["wall", "camera"].includes(tool) ? draft.points[0] : null;
            point = this._snapPlanPoint(rawPoint, event, origin);
            this.planHover = { tool, point, opening: null };
        }

        const start = draft.points?.[0];
        const length = start ? Math.hypot(point[0] - start[0], point[1] - start[1]) : 0;
        if (phase === "move") {
            if (tool === "opening") {
                this.els.planHint.textContent = placement
                    ? `Opening width ${placement.width.toFixed(2)} m`
                    : "Drag along a free span of the wall";
            } else if (tool === "room") {
                this.els.planHint.textContent = `${Math.abs(point[0] - start[0]).toFixed(2)} × ${Math.abs(point[1] - start[1]).toFixed(2)} m`;
            } else {
                this.els.planHint.textContent = `${length.toFixed(2)} m`;
            }
            this._renderPlanPreview();
            return;
        }

        if (phase !== "end") return;
        if (!gesture.moved) {
            this._cancelPlanDraft();
            this._syncToolbar();
            return;
        }

        if (tool === "wall" && length >= 0.001) {
            this._createWallFromDrag(start, point);
        } else if (tool === "room" && this._roomRectangle(start, point)) {
            this._createRectangularRoom(start, point);
        } else if (tool === "opening" && placement) {
            this._createOpeningFromPlacement(placement, this.editorView.opening_kind || "window");
        } else if (tool === "camera" && length >= 0.001) {
            this._createCameraFromDrag(start, point);
        }
        this._cancelPlanDraft();
        this._syncToolbar();
    }

    _createWallFromDrag(start, end) {
        if (!this.scene || !Array.isArray(start) || !Array.isArray(end)) return false;
        if (this.scene.architecture.walls.length >= 4096) {
            this.toast("The scene wall limit has been reached.", "error");
            return false;
        }
        this._recordEditorCommand("Create wall", () => {
            const building = this._activeBuilding();
            const level = this.scene.levels.find(value => value.level_id === this.editorView.active_level_id);
            this.scene.architecture.walls.push({
                ...DEFAULT_WALL,
                wall_id: factoryId(),
                level_id: this.editorView.active_level_id,
                building_id: building?.building_id || "",
                start: this._worldToLocalPlan(start, building),
                end: this._worldToLocalPlan(end, building),
                height: Number(level?.height) || DEFAULT_WALL.height,
            });
            void this._commitArchitecture();
        });
        return true;
    }

    _createCameraFromDrag(position, target) {
        if (!this.scene || !Array.isArray(position) || !Array.isArray(target)) return false;
        if ((this.scene.cameras?.length || 0) >= 32) {
            this.toast("A scene can contain up to 32 cameras.", "error");
            return false;
        }
        const cameraId = factoryId();
        this._recordEditorCommand("Place camera", () => {
            const level = this.scene.levels.find(value => value.level_id === this.editorView.active_level_id);
            const building = this._activeBuilding();
            const eyeHeight = (Number(level?.elevation) || 0)
                + (Number(building?.position?.[1]) || 0)
                + 1.6;
            const camera = {
                camera_id: cameraId,
                name: `Camera ${(this.scene.cameras?.length || 0) + 1}`,
                created_at: Date.now() / 1000,
                level_id: this.editorView.active_level_id,
                building_id: building?.building_id || "",
                position: [position[0], eyeHeight, position[1]],
                target: [target[0], eyeHeight, target[1]],
                up: [0, 1, 0],
                fov: 42,
            };
            this.scene.cameras = [...(this.scene.cameras || []), camera];
            this._selectCamera(camera.camera_id);
            this._scheduleSceneSave(0);
        });
        return true;
    }

    _nearestWallProjection(point) {
        let nearest = null;
        for (const wall of this.scene?.architecture?.walls || []) {
            if (wall.level_id !== this.editorView.active_level_id) continue;
            const building = this._buildingForItem(wall);
            if (wall.visible === false || wall.locked || building?.visible === false || building?.locked) continue;
            const wallStart = this._localToWorldPlan(wall.start, building);
            const wallEnd = this._localToWorldPlan(wall.end, building);
            const dx = wallEnd[0] - wallStart[0];
            const dz = wallEnd[1] - wallStart[1];
            const lengthSquared = dx * dx + dz * dz;
            if (lengthSquared < 1e-9) continue;
            const offset = clamp(
                ((point[0] - wallStart[0]) * dx + (point[1] - wallStart[1]) * dz)
                    / lengthSquared,
                0,
                1,
            );
            const projected = [wallStart[0] + dx * offset, wallStart[1] + dz * offset];
            const distance = Math.hypot(point[0] - projected[0], point[1] - projected[1]);
            if (!nearest || distance < nearest.distance) {
                nearest = {
                    wall,
                    offset,
                    distance,
                    point: projected,
                    length: Math.sqrt(lengthSquared),
                };
            }
        }
        const tolerance = 20 / Math.max(0.01, Number(this.viewerState.plan_camera?.zoom) || 24);
        return nearest?.distance <= tolerance ? nearest : null;
    }

    _openingPlacement(nearest, requestedWidth = 1.2) {
        const wall = nearest?.wall;
        const length = Number(nearest?.length) || 0;
        if (!wall || length < 0.05) return null;
        const fitted = this._fitOpeningOnWall(wall, nearest.offset, requestedWidth);
        if (!fitted) return null;
        const { width, offset } = fitted;
        const building = this._buildingForItem(wall);
        const wallStart = this._localToWorldPlan(wall.start, building);
        const wallEnd = this._localToWorldPlan(wall.end, building);
        const dx = (wallEnd[0] - wallStart[0]) / length;
        const dz = (wallEnd[1] - wallStart[1]) / length;
        const center = [
            wallStart[0] + (wallEnd[0] - wallStart[0]) * offset,
            wallStart[1] + (wallEnd[1] - wallStart[1]) * offset,
        ];
        return {
            wall,
            offset,
            width,
            thickness: Number(wall.thickness) || DEFAULT_WALL.thickness,
            center,
            start: [center[0] - dx * width / 2, center[1] - dz * width / 2],
            end: [center[0] + dx * width / 2, center[1] + dz * width / 2],
        };
    }

    _fitOpeningOnWall(wall, requestedOffset, requestedWidth, ignoreOpeningId = "") {
        const length = Math.hypot(
            Number(wall?.end?.[0]) - Number(wall?.start?.[0]),
            Number(wall?.end?.[1]) - Number(wall?.start?.[1]),
        );
        if (!(length >= 0.05)) return null;
        const numericWidth = Number(requestedWidth);
        const width = Math.min(
            Math.max(0.05, Number.isFinite(numericWidth) ? numericWidth : 1.2),
            length,
        );
        const half = width / 2;
        const occupied = (this.scene?.architecture?.openings || [])
            .filter(opening => opening.wall_id === wall.wall_id && opening.opening_id !== ignoreOpeningId)
            .map(opening => {
                const otherHalf = Math.min(length, Math.max(0.05, Number(opening.width) || 0.05)) / 2;
                const center = clamp(Number(opening.offset) || 0, 0, 1) * length;
                return [Math.max(0, center - otherHalf), Math.min(length, center + otherHalf)];
            })
            .sort((left, right) => left[0] - right[0]);
        const free = [];
        let cursor = 0;
        for (const interval of occupied) {
            if (interval[0] > cursor) free.push([cursor, interval[0]]);
            cursor = Math.max(cursor, interval[1]);
        }
        if (cursor < length) free.push([cursor, length]);
        const requestedCenter = clamp(Number(requestedOffset) || 0, 0, 1) * length;
        let best = null;
        for (const interval of free) {
            const minimum = interval[0] + half;
            const maximum = interval[1] - half;
            if (minimum > maximum + 1e-6) continue;
            const center = clamp(requestedCenter, minimum, maximum);
            const distance = Math.abs(center - requestedCenter);
            if (!best || distance < best.distance) best = { center, distance };
        }
        return best ? { offset: best.center / length, width } : null;
    }

    _openingControlLimits(opening, wall) {
        const wallLength = Math.max(0.05, Math.hypot(
            Number(wall?.end?.[0]) - Number(wall?.start?.[0]),
            Number(wall?.end?.[1]) - Number(wall?.start?.[1]),
        ) || 0.05);
        const wallHeight = Math.max(0.05, Number(wall?.height) || DEFAULT_WALL.height);
        const center = clamp(Number(opening?.offset) || 0, 0, 1) * wallLength;
        const occupied = (this.scene?.architecture?.openings || [])
            .filter(item => item.wall_id === wall?.wall_id && item.opening_id !== opening?.opening_id)
            .map(item => {
                const half = Math.min(wallLength, Math.max(0.05, Number(item.width) || 0.05)) / 2;
                const otherCenter = clamp(Number(item.offset) || 0, 0, 1) * wallLength;
                return [Math.max(0, otherCenter - half), Math.min(wallLength, otherCenter + half)];
            })
            .sort((left, right) => left[0] - right[0]);
        const free = [];
        let cursor = 0;
        for (const interval of occupied) {
            if (interval[0] > cursor) free.push([cursor, interval[0]]);
            cursor = Math.max(cursor, interval[1]);
        }
        if (cursor < wallLength) free.push([cursor, wallLength]);
        const span = free.find(interval => center >= interval[0] - 1e-6 && center <= interval[1] + 1e-6)
            || free.reduce((nearest, interval) => {
                const distance = center < interval[0]
                    ? interval[0] - center
                    : center > interval[1]
                        ? center - interval[1]
                        : 0;
                return !nearest || distance < nearest.distance ? { interval, distance } : nearest;
            }, null)?.interval
            || [0, wallLength];
        const currentWidth = Math.min(wallLength, Math.max(0.05, Number(opening?.width) || 0.05));
        const symmetricWidth = Math.max(0.05, 2 * Math.min(
            Math.max(0, center - span[0]),
            Math.max(0, span[1] - center),
        ));
        const widthMaximum = Math.min(
            span[1] - span[0],
            Math.max(currentWidth, symmetricWidth),
        );
        const halfWidth = currentWidth / 2;
        const centerMinimum = span[0] + halfWidth;
        const centerMaximum = span[1] - halfWidth;
        return {
            wallLength,
            wallHeight,
            widthMaximum: Math.max(0.05, widthMaximum),
            centerMinimum: centerMinimum <= centerMaximum ? centerMinimum : center,
            centerMaximum: centerMinimum <= centerMaximum ? centerMaximum : center,
            sillMaximum: Math.max(0, wallHeight - Math.max(0.05, Number(opening?.height) || 0.05)),
        };
    }

    _createRectangularRoom(start, end) {
        const rectangle = this._roomRectangle(start, end);
        if (!rectangle) {
            this.toast("Choose an opposite corner with both width and depth.", "error");
            return false;
        }
        if (this.scene.architecture.rooms.length >= 1024) {
            this.toast("The scene room limit has been reached.", "error");
            return false;
        }
        if (this.scene.architecture.walls.length > 4092) {
            this.toast("Four free wall slots are required to create a room.", "error");
            return false;
        }
        const roomId = factoryId();
        this.planDraft = null;
        this.planHover = { tool: "room", point: [...end] };
        this._renderPlanPreview();
        this._recordEditorCommand("Create room", () => {
            const building = this._activeBuilding();
            const level = this.scene.levels.find(value => value.level_id === this.editorView.active_level_id);
            const localRectangle = rectangle.map(point => this._worldToLocalPlan(point, building));
            const wallIds = [];
            for (let index = 0; index < rectangle.length; index += 1) {
                const wallId = factoryId();
                wallIds.push(wallId);
                this.scene.architecture.walls.push({
                    ...DEFAULT_WALL,
                    wall_id: wallId,
                    level_id: this.editorView.active_level_id,
                    building_id: building?.building_id || "",
                    start: [...localRectangle[index]],
                    end: [...localRectangle[(index + 1) % localRectangle.length]],
                    height: Number(level?.height) || DEFAULT_WALL.height,
                });
            }
            this.scene.architecture.rooms.push({
                ...DEFAULT_ROOM,
                floor: {
                    ...DEFAULT_ROOM.floor,
                    thickness: Math.max(0, Number(level?.slab_thickness) || DEFAULT_ROOM.floor.thickness),
                },
                ceiling: {
                    ...DEFAULT_ROOM.ceiling,
                    height: Number(level?.height) || DEFAULT_ROOM.ceiling.height,
                },
                room_id: roomId,
                level_id: this.editorView.active_level_id,
                building_id: building?.building_id || "",
                polygon: localRectangle.map(point => [...point]),
                wall_ids: wallIds,
            });
            this.selectedArchitecture = { type: "room", id: roomId };
            this.selectedArchitectureItems = new Map([[
                this._architectureSelectionKey(this.selectedArchitecture),
                this.selectedArchitecture,
            ]]);
            this.viewer.setArchitectureSelection(
                this.selectedArchitecture,
                this._selectedArchitectureRefs(),
            );
            void this._commitArchitecture();
        });
        return true;
    }

    _cancelPlanDraft() {
        this._clearPlanHover();
        this.planDraft = null;
        this.viewer?.setPlanDraft(null);
    }

    _commitArchitecture({ save = true, targeted = false } = {}) {
        const sceneId = this.sceneId;
        const operation = this._architectureCommitSerial.then(
            () => this._commitArchitectureNow(sceneId, { save, targeted }),
        );
        this._architectureCommitSerial = operation.catch(() => null);
        return operation;
    }

    async _commitArchitectureNow(sceneId, { save = true, targeted = false } = {}) {
        if (!this.scene || !sceneId || this.sceneId !== sceneId) return;
        this.scene.levels = reconcileIdentifiedObjects(
            this.scene.levels,
            normalizedLevels(this.scene.levels),
            "level_id",
        );
        const currentArchitecture = this.scene.architecture || {};
        const nextArchitecture = normalizedArchitecture(currentArchitecture, this.scene.levels);
        this.scene.architecture = {
            ...nextArchitecture,
            materials: reconcileIdentifiedObjects(
                currentArchitecture.materials,
                nextArchitecture.materials,
                "material_id",
            ),
            buildings: reconcileIdentifiedObjects(
                currentArchitecture.buildings,
                nextArchitecture.buildings,
                "building_id",
            ),
            walls: reconcileIdentifiedObjects(
                currentArchitecture.walls,
                nextArchitecture.walls,
                "wall_id",
            ),
            rooms: reconcileIdentifiedObjects(
                currentArchitecture.rooms,
                nextArchitecture.rooms,
                "room_id",
            ),
            openings: reconcileIdentifiedObjects(
                currentArchitecture.openings,
                nextArchitecture.openings,
                "opening_id",
            ),
        };
        if (!this.scene.levels.some(level => level.level_id === this.editorView.active_level_id)) {
            this.editorView.active_level_id = this.scene.levels[0]?.level_id || "";
        }
        const selectedType = ["floor", "ceiling"].includes(this.selectedArchitecture?.type)
            ? "room"
            : this.selectedArchitecture?.type;
        const updated = targeted && this.selectedArchitecture?.id
            ? this.viewer.updateArchitectureItem(
                selectedType,
                this.selectedArchitecture.id,
                this.scene,
            )
            : false;
        if (!updated) await this.viewer.refreshArchitecture(this.scene);
        if (!this.scene || this.sceneId !== sceneId) return;
        // Rebuilding procedural geometry must not replay a stale editor camera.
        // The viewer already owns the live camera; only architecture-specific
        // mode and floor state need to be reaffirmed after a refresh.
        this.viewer.setViewMode(this.editorView.view_mode);
        this.viewer.setPlanTool(this.editorView.plan_tool);
        this.viewer.setActiveLevel(this.editorView.active_level_id);
        this.viewer.setArchitectureSelection(
            this.selectedArchitecture,
            this._selectedArchitectureRefs(),
        );
        if (!targeted) this._renderInspector();
        if (this.selectedArchitecture) this._setWorkspaceTab("right", "inspector");
        this._updateSceneSummary();
        this._syncToolbar();
        if (save) {
            this._scheduleSceneSave(80);
            this._scheduleScenePreview(240);
            this._scheduleStateSave(0);
        }
    }

    _previewSelectedArchitecture({ persist = true } = {}) {
        if (!this.selectedArchitecture?.id || !this.scene) return;
        const type = ["floor", "ceiling"].includes(this.selectedArchitecture.type)
            ? "room"
            : this.selectedArchitecture.type;
        if (type === "level") {
            this._previewArchitectureMaterials();
            this.viewer.setActiveLevel(this.editorView.active_level_id);
            this.viewer.setCameraMarkers(this.scene.cameras || []);
            return;
        }
        this.viewer.updateArchitectureItem(type, this.selectedArchitecture.id, this.scene);
        if (type === "wall") {
            for (const room of this.scene.architecture.rooms || []) {
                if (room.wall_ids?.includes(this.selectedArchitecture.id)) {
                    this.viewer.updateArchitectureItem("room", room.room_id, this.scene);
                }
            }
        } else if (type === "room") {
            const room = this.scene.architecture.rooms?.find(value => value.room_id === this.selectedArchitecture.id);
            const linked = new Set(room?.wall_ids || []);
            for (const wall of this.scene.architecture.walls || []) {
                if (linked.has(wall.wall_id)) this.viewer.updateArchitectureItem("wall", wall.wall_id, this.scene);
            }
        }
        this.viewer.setCameraMarkers(this.scene.cameras || []);
        if (persist) {
            this._scheduleSceneSave(220);
            this._scheduleStateSave(220);
        }
    }

    _queueSelectedArchitecturePreview({ flush = false, persist = true } = {}) {
        if (flush && this._architectureGeometryFrame) {
            cancelAnimationFrame(this._architectureGeometryFrame);
            this._architectureGeometryFrame = 0;
        }
        if (flush) {
            this._previewSelectedArchitecture({ persist });
            return;
        }
        if (this._architectureGeometryFrame) return;
        this._architectureGeometryFrame = requestAnimationFrame(() => {
            this._architectureGeometryFrame = 0;
            this._previewSelectedArchitecture({ persist });
        });
    }

    _syncRoomsForWall(wall) {
        if (!wall) return;
        for (const room of this.scene?.architecture?.rooms || []) {
            if (!Array.isArray(room.wall_ids) || room.wall_ids.length !== room.polygon?.length) continue;
            const index = room.wall_ids.indexOf(wall.wall_id);
            if (index < 0) continue;
            room.polygon[index] = [...wall.start];
            room.polygon[(index + 1) % room.polygon.length] = [...wall.end];
        }
    }

    _previewArchitectureMaterials() {
        clearTimeout(this._architecturePreviewTimer);
        this._architecturePreviewTimer = setTimeout(() => {
            this._architecturePreviewTimer = 0;
            void this.viewer.refreshArchitecture(this.scene);
        }, 50);
        this._scheduleSceneSave(220);
        this._scheduleStateSave(220);
    }

    _architectureSelectionKey(selection) {
        return selection?.id ? `${selection.type}:${selection.id}` : "";
    }

    _selectedArchitectureRefs() {
        if (this.selectedArchitectureItems?.size) {
            return Array.from(this.selectedArchitectureItems.values());
        }
        return this.selectedArchitecture?.id ? [{ ...this.selectedArchitecture }] : [];
    }

    _isArchitectureSelected(type, id) {
        const key = this._architectureSelectionKey({ type, id });
        return Boolean(
            this.selectedArchitectureItems?.has(key)
            || (!this.selectedArchitectureItems?.size
                && this.selectedArchitecture?.type === type
                && this.selectedArchitecture?.id === id),
        );
    }

    _selectArchitecture(selection, { additive = false } = {}) {
        if (selection?.type === "camera") {
            this._selectCamera(selection.id);
            return;
        }
        this.selectedLightId = "";
        this.viewer.selectLightMarker("");
        const normalizedSelection = this._normalizeArchitectureSelection(selection);
        const selectionKey = this._architectureSelectionKey(normalizedSelection);
        if (!additive) {
            this.selectedArchitectureItems.clear();
            this.selectedObjectIds.clear();
            this.selectedObjectId = "";
            this.selectedCameraIds.clear();
        }
        if (selectionKey) {
            if (additive && this.selectedArchitectureItems.has(selectionKey)) {
                this.selectedArchitectureItems.delete(selectionKey);
            } else {
                this.selectedArchitectureItems.set(selectionKey, normalizedSelection);
            }
        }
        this.selectedArchitecture = this.selectedArchitectureItems.has(selectionKey)
            ? normalizedSelection
            : Array.from(this.selectedArchitectureItems.values()).at(-1) || null;
        const selected = this._selectedArchitectureValue();
        const owner = this.selectedArchitecture?.type === "building"
            ? this.scene?.architecture?.buildings?.find(
                item => item.building_id === this.selectedArchitecture.id,
            )
            : this._buildingForItem(selected);
        if (owner) this.editorView.active_building_id = owner.building_id;
        if (!additive) this.selectedCameraId = "";
        this.selectedCameraKeyframeId = "";
        this.selectedGroupId = "";
        this.selectedSkydome = false;
        this.viewer.select(this.selectedObjectId, { additive: true, emit: false });
        this.viewer.setArchitectureSelection(
            this.selectedArchitecture,
            this._selectedArchitectureRefs(),
        );
        this._renderObjects();
        this._renderCameras();
        this._renderInspector();
        this._syncToolbar();
        if (this.selectedArchitecture) this._setWorkspaceTab("right", "inspector");
        this._scheduleStateSave(0);
    }

    _selectPlanItems(items = [], { additive = false, emptyClick = false } = {}) {
        if (!this.scene) return;
        this.selectedLightId = "";
        this.viewer.selectLightMarker("");
        if (!additive) {
            this.selectedObjectIds.clear();
            this.selectedArchitectureItems.clear();
            this.selectedCameraIds.clear();
        }
        for (const item of items) {
            if (item?.kind === "object" && this.scene.objects?.some(value => value.object_id === item.id)) {
                this.selectedObjectIds.add(item.id);
                continue;
            }
            if (item?.kind !== "architecture") continue;
            const normalized = this._normalizeArchitectureSelection(item);
            const key = this._architectureSelectionKey(normalized);
            if (key) this.selectedArchitectureItems.set(key, normalized);
        }
        for (const item of items) {
            if (item?.kind === "camera" && this.scene.cameras?.some(camera => camera.camera_id === item.id)) {
                this.selectedCameraIds.add(item.id);
            }
        }
        if (emptyClick && !additive) {
            this.selectedObjectIds.clear();
            this.selectedArchitectureItems.clear();
            this.selectedCameraIds.clear();
        }
        this.selectedObjectId = Array.from(this.selectedObjectIds).at(-1) || "";
        this.selectedArchitecture = Array.from(this.selectedArchitectureItems.values()).at(-1) || null;
        this.selectedGroupId = "";
        this.selectedSkydome = false;
        this.selectedCameraId = Array.from(this.selectedCameraIds).at(-1) || "";
        this.selectedCameraKeyframeId = "";
        this.viewer.select(this.selectedObjectId, { additive: true, emit: false });
        this.viewer.setArchitectureSelection(
            this.selectedArchitecture,
            this._selectedArchitectureRefs(),
        );
        this._renderObjects();
        this._renderCameras();
        this._renderInspector();
        this._syncToolbar();
        this._scheduleStateSave(0);
    }

    _onArchitectureEdit(change) {
        if (!change?.type || !change.id) return;
        if (change.type === "building") {
            const building = this.scene?.architecture?.buildings?.find(item => item.building_id === change.id);
            if (!building || building.locked) return this.viewer.setArchitectureSelection(this.selectedArchitecture);
            const point = this._snapPlanPoint(change.point, change.event || {});
            const before = this._captureEditorSnapshot();
            this._applyBuildingTransform(
                building,
                [point[0], Number(building.position?.[1]) || 0, point[1]],
                building.rotation_y,
            );
            this.history.push("Move building", before, this._captureEditorSnapshot());
            void this._commitArchitecture({ targeted: true });
            return;
        }
        if (change.type === "room") {
            const room = this.scene?.architecture?.rooms?.find(item => item.room_id === change.id);
            const linkedWalls = new Set(room?.wall_ids || []);
            const phase = ["start", "move", "end", "cancel"].includes(change.phase)
                ? change.phase
                : "end";
            const activeDrag = this._roomPlanDrag?.id === change.id
                ? this._roomPlanDrag
                : null;
            if (phase === "cancel") {
                if (room && activeDrag) {
                    room.polygon = activeDrag.polygon.map(point => [...point]);
                    for (const original of activeDrag.walls) {
                        const wall = this.scene.architecture.walls?.find(item => item.wall_id === original.wall_id);
                        if (!wall) continue;
                        wall.start = [...original.start];
                        wall.end = [...original.end];
                    }
                    this._roomPlanDrag = null;
                    this._queueSelectedArchitecturePreview({ flush: true, persist: false });
                }
                return;
            }
            if (
                !room?.polygon?.length
                || room.locked
                || this.scene.architecture.walls?.some(wall => linkedWalls.has(wall.wall_id) && wall.locked)
            ) return this.viewer.setArchitectureSelection(this.selectedArchitecture);
            const building = this._buildingForItem(room);
            if (building?.locked) return this.viewer.setArchitectureSelection(this.selectedArchitecture);
            if (phase === "start") {
                if (this._architectureGeometryFrame) {
                    cancelAnimationFrame(this._architectureGeometryFrame);
                    this._architectureGeometryFrame = 0;
                }
                this._roomPlanDrag = {
                    id: room.room_id,
                    before: this._captureEditorSnapshot(),
                    polygon: room.polygon.map(point => [...point]),
                    walls: (this.scene.architecture.walls || [])
                        .filter(wall => linkedWalls.has(wall.wall_id))
                        .map(wall => ({
                            wall_id: wall.wall_id,
                            start: [...wall.start],
                            end: [...wall.end],
                        })),
                };
                return;
            }
            if (!Array.isArray(change.point)) return;
            const localPoint = this._worldToLocalPlan(
                this._snapPlanPoint(change.point, change.event || {}),
                building,
            );
            const center = room.polygon.reduce(
                (sum, point) => [sum[0] + point[0], sum[1] + point[1]],
                [0, 0],
            ).map(value => value / room.polygon.length);
            const delta = [localPoint[0] - center[0], localPoint[1] - center[1]];
            const before = activeDrag?.before || this._captureEditorSnapshot();
            room.polygon = room.polygon.map(point => [point[0] + delta[0], point[1] + delta[1]]);
            const linked = new Set(room.wall_ids || []);
            for (const wall of this.scene.architecture.walls || []) {
                if (!linked.has(wall.wall_id)) continue;
                wall.start = [wall.start[0] + delta[0], wall.start[1] + delta[1]];
                wall.end = [wall.end[0] + delta[0], wall.end[1] + delta[1]];
            }
            if (phase === "move") {
                this._queueSelectedArchitecturePreview({ persist: false });
                return;
            }
            this._roomPlanDrag = null;
            this._queueSelectedArchitecturePreview({ flush: true, persist: false });
            this.history.push("Move room", before, this._captureEditorSnapshot());
            void this._commitArchitecture();
            return;
        }
        if (change.type === "opening") {
            const opening = this.scene?.architecture?.openings?.find(item => item.opening_id === change.id);
            const wall = this.scene?.architecture?.walls?.find(item => item.wall_id === opening?.wall_id);
            const building = this._buildingForItem(wall);
            if (!opening || !wall || opening.locked || wall.locked || building?.locked) {
                return this.viewer.setArchitectureSelection(this.selectedArchitecture);
            }
            const point = this._worldToLocalPlan(
                this._snapPlanPoint(change.point, change.event || {}),
                building,
            );
            const dx = wall.end[0] - wall.start[0];
            const dz = wall.end[1] - wall.start[1];
            const lengthSquared = dx * dx + dz * dz;
            if (lengthSquared < 1e-9) return this.viewer.setArchitectureSelection(this.selectedArchitecture);
            const requestedOffset = ((point[0] - wall.start[0]) * dx + (point[1] - wall.start[1]) * dz) / lengthSquared;
            const fitted = this._fitOpeningOnWall(wall, requestedOffset, opening.width, opening.opening_id);
            if (!fitted) return this.viewer.setArchitectureSelection(this.selectedArchitecture);
            const before = this._captureEditorSnapshot();
            opening.offset = fitted.offset;
            opening.width = fitted.width;
            this.history.push("Move opening", before, this._captureEditorSnapshot());
            void this._commitArchitecture({ targeted: true });
            return;
        }
        if (change.type !== "wall" || !["start", "end"].includes(change.endpoint)) return;
        const linkedRoom = this._roomForWallId(change.id);
        if (linkedRoom) {
            this._selectArchitecture({ type: "room", id: linkedRoom.room_id });
            return;
        }
        const wall = this.scene?.architecture?.walls?.find(item => item.wall_id === change.id);
        if (!wall || wall.locked || this._buildingForItem(wall)?.locked) {
            this.viewer.setArchitectureSelection(this.selectedArchitecture);
            return;
        }
        const worldPoint = this._snapPlanPoint(change.point, change.event || {});
        const building = this._buildingForItem(wall);
        const point = this._worldToLocalPlan(worldPoint, building);
        if (Math.hypot(
            point[0] - wall[change.endpoint === "start" ? "end" : "start"][0],
            point[1] - wall[change.endpoint === "start" ? "end" : "start"][1],
        ) < 0.001) {
            this.viewer.setArchitectureSelection(this.selectedArchitecture);
            return;
        }
        const before = this._captureEditorSnapshot();
        wall[change.endpoint] = point;
        for (const room of this.scene.architecture.rooms || []) {
            const index = room.wall_ids?.indexOf(wall.wall_id) ?? -1;
            if (index < 0 || room.wall_ids.length !== room.polygon.length) continue;
            const endpointIndex = change.endpoint === "start"
                ? index
                : (index + 1) % room.polygon.length;
            room.polygon[endpointIndex] = [...point];
        }
        this.history.push("Move wall endpoint", before, this._captureEditorSnapshot());
        void this._commitArchitecture();
        this._syncToolbar();
    }

    _selectedArchitectureValue() {
        if (!this.selectedArchitecture || !this.scene?.architecture) return null;
        const { type, id } = this.selectedArchitecture;
        if (type === "building") return this.scene.architecture.buildings?.find(item => item.building_id === id);
        if (type === "level") return this.scene.levels.find(item => item.level_id === id);
        if (type === "wall") return this.scene.architecture.walls.find(item => item.wall_id === id);
        if (type === "room" || type === "floor" || type === "ceiling") {
            return this.scene.architecture.rooms.find(item => item.room_id === id);
        }
        if (type === "opening") return this.scene.architecture.openings.find(item => item.opening_id === id);
        return null;
    }

    _roomForWallId(wallId) {
        return this.scene?.architecture?.rooms?.find(
            room => room.wall_ids?.includes(wallId),
        ) || null;
    }

    _normalizeArchitectureSelection(selection) {
        if (!selection?.id) return null;
        if (["room", "floor", "ceiling"].includes(selection.type)) {
            return { type: "room", id: selection.id };
        }
        if (selection.type === "wall") {
            const room = this._roomForWallId(selection.id);
            if (room) return { type: "room", id: room.room_id };
        }
        return { type: selection.type, id: selection.id };
    }

    _roomBounds(room) {
        const polygon = Array.isArray(room?.polygon) ? room.polygon : [];
        if (!polygon.length) return { center: [0, 0], size: [0, 0] };
        const xs = polygon.map(point => Number(point?.[0]) || 0);
        const zs = polygon.map(point => Number(point?.[1]) || 0);
        const minimum = [Math.min(...xs), Math.min(...zs)];
        const maximum = [Math.max(...xs), Math.max(...zs)];
        return {
            center: [(minimum[0] + maximum[0]) / 2, (minimum[1] + maximum[1]) / 2],
            size: [maximum[0] - minimum[0], maximum[1] - minimum[1]],
        };
    }

    _syncRoomPerimeter(room) {
        if (!room?.polygon?.length || room.wall_ids?.length !== room.polygon.length) return;
        const wallsById = new Map(
            (this.scene?.architecture?.walls || []).map(wall => [wall.wall_id, wall]),
        );
        room.wall_ids.forEach((wallId, index) => {
            const wall = wallsById.get(wallId);
            if (!wall) return;
            wall.start = [...room.polygon[index]];
            wall.end = [...room.polygon[(index + 1) % room.polygon.length]];
            wall.level_id = room.level_id;
            wall.building_id = room.building_id;
            wall.height = Math.max(0.05, Number(room.ceiling?.height) || wall.height || 2.8);
            wall.visible = room.visible !== false;
            wall.locked = room.locked === true;
        });
    }

    _formatControlNumber(value, step = 0.01) {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue)) return "0";
        const numericStep = Math.abs(Number(step));
        if (!Number.isFinite(numericStep) || numericStep <= 0) {
            return String(Number(numericValue.toFixed(6)));
        }
        const stepText = numericStep.toString().toLowerCase();
        const exponent = stepText.includes("e-") ? Number(stepText.split("e-")[1]) : 0;
        const decimals = exponent || (stepText.split(".")[1]?.length || 0);
        return String(Number(numericValue.toFixed(Math.min(8, decimals))));
    }

    _numericControl(label, path, value, {
        minimum,
        maximum,
        step,
        range = true,
        sliderMinimum,
        sliderMaximum,
        disabled = false,
    } = {}) {
        const numericValue = Number(value);
        const safeValue = Number.isFinite(numericValue) ? numericValue : 0;
        const disabledAttribute = disabled ? " disabled" : "";
        let rangeMinimum = Number.isFinite(sliderMinimum) ? sliderMinimum : minimum;
        let rangeMaximum = Number.isFinite(sliderMaximum) ? sliderMaximum : maximum;
        if (range && Number.isFinite(minimum) && Number.isFinite(maximum)) {
            const span = maximum - minimum;
            if (!Number.isFinite(sliderMinimum) && !Number.isFinite(sliderMaximum) && span > 720) {
                const windowSize = path.includes("rotation")
                    ? 45
                    : path.includes("focus")
                        ? Math.max(1, Math.abs(safeValue))
                        : path.includes("scale")
                            ? Math.max(1, Math.abs(safeValue) * 2)
                            : 5;
                rangeMinimum = Math.max(minimum, safeValue - windowSize);
                rangeMaximum = Math.min(maximum, safeValue + windowSize);
            }
        }
        rangeMinimum = Math.min(rangeMinimum, safeValue);
        rangeMaximum = Math.max(rangeMaximum, safeValue);
        const controlValue = this._formatControlNumber(safeValue, step);
        const controlMinimum = this._formatControlNumber(minimum, step);
        const controlMaximum = this._formatControlNumber(maximum, step);
        const rangeMinimumValue = this._formatControlNumber(rangeMinimum, step);
        const rangeMaximumValue = this._formatControlNumber(rangeMaximum, step);
        return `
            <div class="vnccs-i3s__precision-row">
                <span>${escapeHTML(label)}</span>
                ${range ? `<input type="range" aria-label="${escapeHTML(label)} slider" data-editor-path="${path}" min="${rangeMinimumValue}" max="${rangeMaximumValue}" step="${step}" value="${controlValue}"${disabledAttribute} />` : ""}
                <input class="vnccs-i3s__input" aria-label="${escapeHTML(label)} exact value" type="number" data-editor-path="${path}" min="${controlMinimum}" max="${controlMaximum}" step="${step}" value="${controlValue}"${disabledAttribute} />
            </div>`;
    }

    _renderInspector() {
        if (!this.els?.inspector) return;
        preserveScrollState(this.container, () => {
            const item = this.scene?.objects?.find(value => value.object_id === this.selectedObjectId);
            const architecture = this._selectedArchitectureValue();
            const camera = this.scene?.cameras?.find(value => value.camera_id === this.selectedCameraId);
            const light = this.lighting?.lights?.find(value => value.light_id === this.selectedLightId);
            const group = this._groupById(this.selectedGroupId);
            const track = this._activeCameraTrack();
            const keyframe = track?.keyframes?.find(value => value.keyframe_id === this.selectedCameraKeyframeId);
            const architectureSelectionCount = this._selectedArchitectureRefs().length;
            const cameraSelectionCount = this.selectedCameraIds.size;
            const directSelectionCount = this.selectedObjectIds.size
                + architectureSelectionCount
                + cameraSelectionCount
                + (light ? 1 : 0);
            const hasSelection = Boolean(item || architecture || camera || light || keyframe || group);
            this.container.classList.toggle("has-inspector-selection", hasSelection);
            const inspectorTab = this.els.workspaceTabs.find(
                button => button.dataset.workspaceSide === "right"
                    && button.dataset.workspaceTab === "inspector",
            );
            inspectorTab?.setAttribute(
                "aria-label",
                hasSelection ? "Inspector, selection available" : "Inspector",
            );
            if (!item && !architecture && !camera && !light && !keyframe && !group) {
                this.els.inspectorKind.textContent = "Nothing selected";
                this.els.inspector.innerHTML = '<div class="vnccs-i3s__inspector-empty">Select an object, light, wall, room, opening, or camera.</div>';
                return;
            }
            if (directSelectionCount > 1) {
                const modelCount = this.selectedObjectIds.size;
                this.els.inspectorKind.textContent = "Multiple selection";
                this.els.inspector.innerHTML = `
                    <section class="vnccs-i3s__inspector-section">
                        <div class="vnccs-i3s__inspector-title">${directSelectionCount} objects selected</div>
                        <div class="vnccs-i3s__hint">${modelCount} model${modelCount === 1 ? "" : "s"} · ${architectureSelectionCount} architecture object${architectureSelectionCount === 1 ? "" : "s"} · ${cameraSelectionCount} camera${cameraSelectionCount === 1 ? "" : "s"}</div>
                        <div class="vnccs-i3s__hint">Use Copy to place this complete selection in the Factory clipboard.</div>
                    </section>`;
                return;
            }
            if (light) this._renderLightInspector(light);
            else if (item) this._renderObjectInspector(item);
            else if (group) this._renderGroupInspector(group);
            else if (camera) this._renderCameraInspector(camera);
            else if (keyframe) this._renderKeyframeInspector(track, keyframe);
            else this._renderArchitectureInspector(architecture);
        });
    }

    _renderLightInspector(light) {
        const lightId = light.light_id;
        const currentLight = () => this.lighting?.lights?.find(
            item => item.light_id === lightId,
        );
        this.els.inspectorKind.textContent = "Point light";
        this.els.inspector.innerHTML = `
            <div class="vnccs-i3s__inspector-title">${escapeHTML(light.name || "Point light")}</div>
            <div class="vnccs-i3s__hint">Scene object · editor sphere is excluded from camera exports.</div>
            <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Name</span><input class="vnccs-i3s__input" data-light-property="name" value="${escapeHTML(light.name || "Point light")}" maxlength="80" /></label>
            <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Floor level</span><select class="vnccs-i3s__select" data-light-property="level_id">
                ${(this.scene?.levels || []).map(level => `<option value="${level.level_id}"${light.level_id === level.level_id ? " selected" : ""}>${escapeHTML(level.name)}</option>`).join("")}
            </select></label>
            <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Building</span><select class="vnccs-i3s__select" data-light-property="building_id">${this._buildingOptions(light.building_id)}</select></label>
            <div class="vnccs-i3s__inspector-group"><b>Position · m</b>
                ${["X", "Y", "Z"].map((axis, index) => this._numericControl(axis, `light.position.${index}`, light.position[index], { minimum: -10000, maximum: 10000, step: 0.01 })).join("")}
            </div>
            <div class="vnccs-i3s__inspector-group"><b>Emission</b>
                <label class="vnccs-i3s__lighting-color-row"><span><b>Color</b></span><span class="vnccs-i3s__lighting-color-control"><input type="color" data-light-property="color" value="${light.color}" aria-label="Point light color" /><output>${escapeHTML(light.color.toUpperCase())}</output></span></label>
                ${this._numericControl("Strength", "light.intensity", light.intensity, { minimum: 0, maximum: 100000, sliderMinimum: 0, sliderMaximum: 50, step: 0.1 })}
                ${this._numericControl("Range", "light.distance", light.distance, { minimum: 0, maximum: 1000000, sliderMinimum: 0, sliderMaximum: 100, step: 0.1 })}
            </div>
            <label class="vnccs-i3s__inspector-check"><input type="checkbox" data-light-property="visible"${light.visible !== false ? " checked" : ""} /> Light visible</label>
            <label class="vnccs-i3s__inspector-check"><input type="checkbox" data-light-property="cast_shadow"${light.cast_shadow !== false ? " checked" : ""} /> Cast shadow</label>
            <button class="vnccs-i3s__button vnccs-i3s__button--danger" type="button" data-inspector-action="delete" title="Delete light (Delete/Backspace)">Delete light</button>`;
        let before = null;
        const begin = () => { before ||= this._captureEditorSnapshot(); };
        const apply = () => {
            this._commitLighting();
            this.viewer?.selectLightMarker?.(lightId);
        };
        for (const control of this.els.inspector.querySelectorAll("[data-editor-path]")) {
            control.addEventListener("pointerdown", begin);
            control.addEventListener("focus", begin);
            control.addEventListener("input", () => {
                const [, key, rawIndex] = control.dataset.editorPath.split(".");
                const value = Number(control.value);
                const target = currentLight();
                if (!target || !Number.isFinite(value)) return;
                if (rawIndex !== undefined) target[key][Number(rawIndex)] = value;
                else target[key] = value;
                for (const peer of this.els.inspector.querySelectorAll(`[data-editor-path="${control.dataset.editorPath}"]`)) {
                    if (peer !== control) peer.value = String(value);
                }
                apply();
            });
            control.addEventListener("change", () => {
                if (before) this.history.push("Edit light", before, this._captureEditorSnapshot());
                before = null;
                this._commitLighting({ final: true });
                this._renderObjects();
                this._syncToolbar();
            });
        }
        for (const control of this.els.inspector.querySelectorAll("[data-light-property]")) {
            control.addEventListener("pointerdown", begin);
            control.addEventListener("focus", begin);
            const applyProperty = () => {
                const key = control.dataset.lightProperty;
                const value = control.type === "checkbox" ? control.checked : control.value;
                const target = currentLight();
                if (!target) return;
                if (key === "level_id") {
                    const previous = this.scene?.levels?.find(level => level.level_id === target.level_id);
                    const next = this.scene?.levels?.find(level => level.level_id === value);
                    const delta = (Number(next?.elevation) || 0) - (Number(previous?.elevation) || 0);
                    target.position[1] += delta;
                    target.target[1] += delta;
                    target.level_id = value;
                } else if (key === "building_id") {
                    target.building_id = this._validBuildingId(value);
                    if (target.building_id) this.editorView.active_building_id = target.building_id;
                } else {
                    target[key] = value;
                }
                if (key === "color") {
                    control.closest(".vnccs-i3s__lighting-color-control")?.querySelector("output")?.replaceChildren(target.color.toUpperCase());
                }
                apply();
            };
            control.addEventListener("input", applyProperty);
            control.addEventListener("change", () => {
                applyProperty();
                if (before) this.history.push("Edit light", before, this._captureEditorSnapshot());
                before = null;
                this._commitLighting({ final: true });
                this._renderObjects();
                this._renderInspector();
                this._syncToolbar();
            });
        }
        this.els.inspector.querySelector('[data-inspector-action="delete"]')?.addEventListener("click", () => {
            this._deleteLight(lightId);
        });
        this._customSelects?.refresh?.();
    }

    _renderGroupInspector(group) {
        const center = this.viewer?.getGroupPivotPosition?.() || [0, 0, 0];
        this.els.inspectorKind.textContent = "Object group";
        this.els.inspector.innerHTML = `
            <div class="vnccs-i3s__inspector-title">${escapeHTML(group.name || "Group")}</div>
            <div class="vnccs-i3s__hint">Position is absolute. Rotation and scale are applied as a precise delta around the group center.</div>
            <div class="vnccs-i3s__inspector-group"><b>Position · m</b>
                ${["X", "Y", "Z"].map((axis, index) => this._numericControl(axis, `group.position.${index}`, center[index], { minimum: -10000, maximum: 10000, step: 0.01 })).join("")}
            </div>
            <div class="vnccs-i3s__inspector-group"><b>Rotation delta · degrees</b>
                ${["X", "Y", "Z"].map((axis, index) => this._numericControl(axis, `group.rotation.${index}`, 0, { minimum: -360, maximum: 360, step: 0.01 })).join("")}
            </div>
            <div class="vnccs-i3s__inspector-group"><b>Scale factor</b>
                ${this._numericControl("Scale", "group.scale", 1, { minimum: 0.001, maximum: 100, step: 0.001 })}
            </div>
            <div class="vnccs-i3s__inspector-actions"><button class="vnccs-i3s__button vnccs-i3s__button--primary" type="button" data-group-apply>Apply to ${group.children.length} objects</button></div>`;
        const staged = { position: [...center], rotation: [0, 0, 0], scale: 1 };
        for (const control of this.els.inspector.querySelectorAll("[data-editor-path]")) {
            control.addEventListener("input", () => {
                const [, key, rawIndex] = control.dataset.editorPath.split(".");
                const value = Number(control.value);
                if (!Number.isFinite(value)) return;
                if (rawIndex !== undefined) staged[key][Number(rawIndex)] = value;
                else staged[key] = value;
                for (const peer of this.els.inspector.querySelectorAll(`[data-editor-path="${control.dataset.editorPath}"]`)) {
                    if (peer !== control) peer.value = String(value);
                }
            });
        }
        this.els.inspector.querySelector("[data-group-apply]")?.addEventListener("click", () => {
            this._recordEditorCommand("Transform group", () => {
                this._suppressViewerTransformHistory = true;
                try { this.viewer.applyGroupDelta(staged); }
                finally {
                    this._suppressViewerTransformHistory = false;
                    this._viewerTransformHistoryBefore = null;
                }
                this._renderInspector();
                this._scheduleSceneSave(0);
            });
        });
    }

    _renderCameraInspector(camera) {
        const pose = cameraPoseFromLegacy(camera);
        const rotation = eulerDegreesFromQuaternion(pose.quaternion);
        this.els.inspectorKind.textContent = "Saved camera";
        this.els.inspector.innerHTML = `
            <div class="vnccs-i3s__inspector-title">${escapeHTML(camera.name || "Camera")}</div>
            <div class="vnccs-i3s__hint">${this.previewCameraId === camera.camera_id
                ? "Camera View is live: exact fields update the viewport immediately."
                : "Exact fields update the saved Plan marker. Enter Camera View to preview rotation and lens."}</div>
            <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Name</span><input class="vnccs-i3s__input" data-camera-property="name" value="${escapeHTML(camera.name || "Camera")}" maxlength="80" /></label>
            <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Floor level</span><select class="vnccs-i3s__select" data-camera-property="level_id">
                ${(this.scene?.levels || []).map(level => `<option value="${level.level_id}"${camera.level_id === level.level_id ? " selected" : ""}>${escapeHTML(level.name)}</option>`).join("")}
            </select></label>
            <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Building</span><select class="vnccs-i3s__select" data-camera-property="building_id">
                ${this._buildingOptions(camera.building_id)}
            </select></label>
            <div class="vnccs-i3s__inspector-group"><b>Position · m</b>
                ${["X", "Y", "Z"].map((axis, index) => this._numericControl(axis, `camera.position.${index}`, pose.position[index], { minimum: -10000, maximum: 10000, step: 0.01 })).join("")}
            </div>
            <div class="vnccs-i3s__inspector-group"><b>Rotation · degrees</b>
                ${["X", "Y", "Z"].map((axis, index) => this._numericControl(axis, `camera.rotation.${index}`, rotation[index], { minimum: -36000, maximum: 36000, step: 0.01 })).join("")}
            </div>
            <div class="vnccs-i3s__inspector-group"><b>Lens</b>
                ${this._numericControl("FOV", "camera.fov", pose.fov, { minimum: 5, maximum: 120, step: 0.01 })}
                ${this._numericControl("Focus distance", "camera.focus_distance", pose.focus_distance, { minimum: 0.001, maximum: 100000, step: 0.001 })}
            </div>
            <div class="vnccs-i3s__inspector-actions">
                <button class="vnccs-i3s__button" type="button" data-inspector-action="preview-camera">${this.previewCameraId === camera.camera_id ? "Exit camera view" : "Enter camera view"}</button>
                <button class="vnccs-i3s__button" type="button" data-inspector-action="update-camera">Update from current view</button>
                <button class="vnccs-i3s__button" type="button" data-inspector-action="keyframe">Add camera as path point</button>
            </div>`;
        let before = null;
        const edited = {
            position: [...pose.position],
            rotation: [...rotation],
            fov: pose.fov,
            focus_distance: pose.focus_distance,
        };
        const begin = () => { before ||= this._captureEditorSnapshot(); };
        const apply = () => {
            const legacy = legacyCameraFromPose({
                position: edited.position,
                quaternion: quaternionFromEulerDegrees(edited.rotation),
                fov: edited.fov,
                focus_distance: edited.focus_distance,
            });
            Object.assign(camera, legacy);
            // Precise edits in 3D enter the saved camera non-destructively so
            // every slider and exact value has an immediate viewport result.
            // Plan mode keeps showing the saved marker and its FOV wedge.
            if (this.editorView.view_mode === "3d" && this.previewCameraId !== camera.camera_id) {
                if (!this.previewCameraId) {
                    this._cameraReturnState = this._normalizeCameraState(
                        this.viewer.getCameraState(),
                        this.scene?.camera,
                    );
                }
                this.previewCameraId = camera.camera_id;
                if (this.scene.levels?.some(level => level.level_id === camera.level_id)) {
                    this.editorView.active_level_id = camera.level_id;
                    this.viewer.setActiveLevel(camera.level_id);
                }
                this._renderCameras();
                const previewAction = this.els.inspector.querySelector(
                    '[data-inspector-action="preview-camera"]',
                );
                if (previewAction) previewAction.textContent = "Exit camera view";
                const hint = this.els.inspector.querySelector(".vnccs-i3s__hint");
                if (hint) {
                    hint.textContent = "Camera View is live: exact fields update the viewport immediately.";
                }
            }
            if (this.previewCameraId === camera.camera_id) {
                this.viewer.setCameraState(camera, { emit: false });
            }
            this.viewer.setCameraMarkers(this.scene.cameras);
            this._scheduleSceneSave(180);
            this._scheduleStateSave(180);
        };
        for (const control of this.els.inspector.querySelectorAll("[data-editor-path]")) {
            control.addEventListener("pointerdown", begin);
            control.addEventListener("focus", begin);
            control.addEventListener("input", () => {
                const [, key, rawIndex] = control.dataset.editorPath.split(".");
                const value = Number(control.value);
                if (!Number.isFinite(value)) return;
                if (rawIndex !== undefined) edited[key][Number(rawIndex)] = value;
                else edited[key] = value;
                for (const peer of this.els.inspector.querySelectorAll(`[data-editor-path="${control.dataset.editorPath}"]`)) {
                    if (peer !== control) peer.value = String(value);
                }
                apply();
            });
            control.addEventListener("change", () => {
                if (before) this.history.push("Edit camera", before, this._captureEditorSnapshot());
                before = null;
                this._syncToolbar();
                this._scheduleSceneSave(0);
            });
        }
        this.els.inspector.querySelector('[data-camera-property="name"]')?.addEventListener("change", event => {
            const original = this._captureEditorSnapshot();
            camera.name = String(event.currentTarget.value || "Camera").trim().slice(0, 80) || "Camera";
            this.history.push("Rename camera", original, this._captureEditorSnapshot());
            this._renderCameras();
            this._renderInspector();
            this._scheduleSceneSave(0);
        });
        this.els.inspector.querySelector('[data-camera-property="level_id"]')?.addEventListener("change", event => {
            const original = this._captureEditorSnapshot();
            const previousLevel = this.scene.levels.find(level => level.level_id === camera.level_id);
            const nextLevel = this.scene.levels.find(level => level.level_id === event.currentTarget.value);
            const elevationDelta = (Number(nextLevel?.elevation) || 0)
                - (Number(previousLevel?.elevation) || 0);
            camera.position[1] += elevationDelta;
            camera.target[1] += elevationDelta;
            camera.level_id = event.currentTarget.value;
            if (this.previewCameraId === camera.camera_id) {
                this.editorView.active_level_id = camera.level_id;
                this.viewer.setActiveLevel(camera.level_id);
                this.viewer.setCameraState(camera, { emit: false });
                this._syncToolbar();
            }
            this.history.push("Move camera to floor", original, this._captureEditorSnapshot());
            this.viewer.setCameraMarkers(this.scene.cameras);
            this._renderCameras();
            this._scheduleSceneSave(0);
        });
        this.els.inspector.querySelector('[data-camera-property="building_id"]')?.addEventListener("change", event => {
            const original = this._captureEditorSnapshot();
            camera.building_id = this._validBuildingId(event.currentTarget.value);
            if (camera.building_id) this.editorView.active_building_id = camera.building_id;
            this.history.push("Assign camera to building", original, this._captureEditorSnapshot());
            this.viewer.setCameraMarkers(this.scene.cameras);
            this._renderCameras();
            this._syncToolbar();
            this._scheduleSceneSave(0);
            this._scheduleStateSave(0);
        });
        this.els.inspector.querySelector('[data-inspector-action="preview-camera"]')?.addEventListener("click", () => {
            if (this.previewCameraId === camera.camera_id) this._exitCameraView({ restore: true });
            else this._enterCameraView(camera.camera_id);
        });
        this.els.inspector.querySelector('[data-inspector-action="update-camera"]')?.addEventListener("click", () => {
            const original = this._captureEditorSnapshot();
            Object.assign(camera, this._normalizeCameraState(this.viewer.getCameraState()));
            this.history.push("Update camera from view", original, this._captureEditorSnapshot());
            this.viewer.setCameraMarkers(this.scene.cameras);
            this._renderInspector();
            this._renderCameras();
            this._scheduleSceneSave(0);
            this._syncToolbar();
        });
        this.els.inspector.querySelector('[data-inspector-action="keyframe"]')?.addEventListener("click", () => {
            this._addCameraKeyframe(camera);
        });
    }

    _renderKeyframeInspector(track, frame) {
        const pose = normalizedCameraPose(frame);
        const rotation = eulerDegreesFromQuaternion(pose.quaternion);
        this.els.inspectorKind.textContent = "Camera path point";
        this.els.inspector.innerHTML = `
            <div class="vnccs-i3s__inspector-title">${escapeHTML(track.name || "Camera path")}</div>
            <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Building</span><select class="vnccs-i3s__select" data-track-property="building_id">${this._buildingOptions(track.building_id)}</select></label>
            <div class="vnccs-i3s__inspector-group"><b>Timeline</b>
                ${this._numericControl("Time", "keyframe.time", frame.time, { minimum: 0, maximum: track.duration, step: 0.001 })}
                ${this._numericControl("Duration", "track.duration", track.duration, { minimum: 0.1, maximum: 86400, step: 0.01 })}
                ${this._numericControl("FPS", "track.fps", track.fps, { minimum: 1, maximum: 120, step: 1 })}
            </div>
            <div class="vnccs-i3s__inspector-group"><b>Position · m</b>
                ${["X", "Y", "Z"].map((axis, index) => this._numericControl(axis, `keyframe.position.${index}`, pose.position[index], { minimum: -10000, maximum: 10000, step: 0.01 })).join("")}
            </div>
            <div class="vnccs-i3s__inspector-group"><b>Rotation · degrees</b>
                ${["X", "Y", "Z"].map((axis, index) => this._numericControl(axis, `keyframe.rotation.${index}`, rotation[index], { minimum: -36000, maximum: 36000, step: 0.01 })).join("")}
            </div>
            <div class="vnccs-i3s__inspector-group"><b>Lens</b>
                ${this._numericControl("FOV", "keyframe.fov", pose.fov, { minimum: 5, maximum: 120, step: 0.01 })}
                ${this._numericControl("Focus", "keyframe.focus_distance", pose.focus_distance, { minimum: 0.001, maximum: 1000000, step: 0.001 })}
            </div>
            <div class="vnccs-i3s__inspector-grid">
                <label><span>Interpolation</span><select class="vnccs-i3s__select" data-track-property="interpolation"><option value="linear"${track.interpolation === "linear" ? " selected" : ""}>Linear</option><option value="catmullrom"${track.interpolation === "catmullrom" ? " selected" : ""}>Smooth path</option></select></label>
                <label><span>Easing</span><select class="vnccs-i3s__select" data-keyframe-property="easing"><option value="linear"${frame.easing === "linear" ? " selected" : ""}>Linear</option><option value="smooth"${frame.easing === "smooth" ? " selected" : ""}>Smooth</option><option value="ease_in"${frame.easing === "ease_in" ? " selected" : ""}>Ease in</option><option value="ease_out"${frame.easing === "ease_out" ? " selected" : ""}>Ease out</option><option value="ease_in_out"${frame.easing === "ease_in_out" ? " selected" : ""}>Ease in/out</option></select></label>
            </div>
            <label class="vnccs-i3s__inspector-check"><input type="checkbox" data-track-property="constant_speed"${track.constant_speed ? " checked" : ""} /> Constant position speed</label>
            <label class="vnccs-i3s__inspector-check"><input type="checkbox" data-track-property="loop"${track.loop ? " checked" : ""} /> Loop playback</label>
            <div class="vnccs-i3s__inspector-actions"><button class="vnccs-i3s__button" type="button" data-keyframe-action="update">Update from view</button><button class="vnccs-i3s__button vnccs-i3s__button--danger" type="button" data-keyframe-action="delete">Delete point</button></div>`;
        const edited = {
            position: [...pose.position],
            rotation: [...rotation],
            fov: pose.fov,
            focus_distance: pose.focus_distance,
        };
        let before = null;
        const begin = () => { before ||= this._captureEditorSnapshot(); };
        const applyPose = () => {
            Object.assign(frame, normalizedCameraPose({
                position: edited.position,
                quaternion: quaternionFromEulerDegrees(edited.rotation),
                fov: edited.fov,
                focus_distance: edited.focus_distance,
            }));
            this.viewer.setCameraState(legacyCameraFromPose(frame), { emit: false });
            this._scheduleSceneSave(180);
        };
        for (const control of this.els.inspector.querySelectorAll("[data-editor-path]")) {
            control.addEventListener("pointerdown", begin);
            control.addEventListener("focus", begin);
            control.addEventListener("input", () => {
                const [scope, key, rawIndex] = control.dataset.editorPath.split(".");
                const value = Number(control.value);
                if (!Number.isFinite(value)) return;
                if (scope === "track") {
                    if (key === "fps") track[key] = Math.round(value);
                    else if (key === "duration") {
                        const lastTime = Math.max(0, ...track.keyframes.map(item => Number(item.time) || 0));
                        track.duration = Math.max(value, lastTime, 0.1);
                    } else track[key] = value;
                }
                else if (key === "time") frame.time = Math.max(0, Math.min(track.duration, value));
                else {
                    if (rawIndex !== undefined) edited[key][Number(rawIndex)] = value;
                    else edited[key] = value;
                    applyPose();
                }
                const appliedValue = scope === "track"
                    ? track[key]
                    : key === "time"
                        ? frame.time
                        : rawIndex !== undefined
                            ? edited[key][Number(rawIndex)]
                            : edited[key];
                control.value = String(appliedValue);
                for (const peer of this.els.inspector.querySelectorAll(`[data-editor-path="${control.dataset.editorPath}"]`)) {
                    if (peer !== control) peer.value = String(appliedValue);
                }
            });
            control.addEventListener("change", () => {
                track.keyframes.sort((left, right) => left.time - right.time);
                if (before) this.history.push("Edit camera point", before, this._captureEditorSnapshot());
                before = null;
                this._renderCameraTracks();
                this._scheduleSceneSave(0);
                this._syncToolbar();
            });
        }
        for (const control of this.els.inspector.querySelectorAll("[data-track-property],[data-keyframe-property]")) {
            control.addEventListener("change", () => {
                const original = this._captureEditorSnapshot();
                const target = control.dataset.trackProperty ? track : frame;
                const key = control.dataset.trackProperty || control.dataset.keyframeProperty;
                target[key] = control.type === "checkbox" ? control.checked : control.value;
                if (control.dataset.trackProperty === "building_id") {
                    track.building_id = this._validBuildingId(control.value);
                    this.editorView.active_building_id = track.building_id;
                }
                this.history.push("Edit camera path", original, this._captureEditorSnapshot());
                this._renderCameraTracks();
                this._scheduleSceneSave(0);
                this._syncToolbar();
            });
        }
        this.els.inspector.querySelector('[data-keyframe-action="update"]')?.addEventListener("click", () => {
            const original = this._captureEditorSnapshot();
            Object.assign(frame, cameraPoseFromLegacy(this.viewer.getCameraState()));
            this.history.push("Update camera point", original, this._captureEditorSnapshot());
            this._renderCameraTracks();
            this._renderInspector();
            this._scheduleSceneSave(0);
        });
        this.els.inspector.querySelector('[data-keyframe-action="delete"]')?.addEventListener("click", () => {
            const original = this._captureEditorSnapshot();
            track.keyframes = track.keyframes.filter(value => value.keyframe_id !== frame.keyframe_id);
            this.selectedCameraKeyframeId = "";
            this.history.push("Delete camera point", original, this._captureEditorSnapshot());
            this._renderCameraTracks();
            this._renderInspector();
            this._scheduleSceneSave(0);
        });
    }

    _renderObjectInspector(item) {
        const transform = item.transform || { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
        item.transform = {
            position: Array.isArray(transform.position) ? [...transform.position] : [0, 0, 0],
            rotation: Array.isArray(transform.rotation) ? [...transform.rotation] : [0, 0, 0],
            scale: Math.max(0.001, Number(transform.scale) || 1),
        };
        const editor = normalizedObjectEditorProperties(item);
        this.els.inspectorKind.textContent = item.asset_kind === "mesh"
            ? `${String(item.source?.format || "3D").toUpperCase()} model`
            : "Gaussian object";
        this.els.inspector.innerHTML = `
            <div class="vnccs-i3s__inspector-title">${escapeHTML(item.name || "Object")}</div>
            <div class="vnccs-i3s__inspector-group"><b>Position · m</b>
                ${["X", "Y", "Z"].map((axis, index) => this._numericControl(axis, `position.${index}`, transform.position?.[index], { minimum: -1000, maximum: 1000, step: 0.01, disabled: editor.locked })).join("")}
            </div>
            <div class="vnccs-i3s__inspector-group"><b>Rotation · degrees</b>
                ${["X", "Y", "Z"].map((axis, index) => this._numericControl(axis, `rotation.${index}`, transform.rotation?.[index], { minimum: -180, maximum: 180, step: 0.01, disabled: editor.locked })).join("")}
            </div>
            <div class="vnccs-i3s__inspector-group"><b>Uniform scale</b>
                ${this._numericControl("Scale", "scale", transform.scale, { minimum: 0.001, maximum: 1000, step: 0.001, disabled: editor.locked })}
            </div>
            <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Floor level</span><select class="vnccs-i3s__select" data-object-property="level_id"${editor.locked ? " disabled" : ""}>
                ${(this.scene?.levels || []).map(level => `<option value="${level.level_id}"${item.level_id === level.level_id ? " selected" : ""}>${escapeHTML(level.name)}</option>`).join("")}
            </select></label>
            <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Building</span><select class="vnccs-i3s__select" data-object-property="building_id"${editor.locked ? " disabled" : ""}>
                ${this._buildingOptions(item.building_id)}
            </select></label>
            <div class="vnccs-i3s__inspector-grid">
                <label><span>Collision</span><select class="vnccs-i3s__select" data-object-property="collision_proxy.mode">
                    <option value="auto_box"${editor.collision_proxy.mode === "auto_box" ? " selected" : ""}>Automatic box</option>
                    <option value="box"${editor.collision_proxy.mode === "box" ? " selected" : ""}>Custom box</option>
                    <option value="off"${editor.collision_proxy.mode === "off" ? " selected" : ""}>Disabled</option>
                </select></label>
                <label><span>Light behavior</span><select class="vnccs-i3s__select" data-object-property="light_transport">
                    <option value="opaque"${editor.light_transport === "opaque" ? " selected" : ""}>Opaque</option>
                    <option value="cutout"${editor.light_transport === "cutout" ? " selected" : ""}>Cutout</option>
                    <option value="transmissive"${editor.light_transport === "transmissive" ? " selected" : ""}>Glass / transmissive</option>
                </select></label>
            </div>
            ${editor.collision_proxy.mode === "box" ? `
                <div class="vnccs-i3s__inspector-group"><b>Custom collision box · local m</b>
                    ${["X", "Y", "Z"].map((axis, index) => `<label class="vnccs-i3s__precision-row"><span>C${axis}</span><input class="vnccs-i3s__input" type="number" step="0.01" data-proxy-path="center.${index}" value="${editor.collision_proxy.center[index]}" /></label>`).join("")}
                    ${["X", "Y", "Z"].map((axis, index) => `<label class="vnccs-i3s__precision-row"><span>S${axis}</span><input class="vnccs-i3s__input" type="number" min="0.001" step="0.01" data-proxy-path="size.${index}" value="${editor.collision_proxy.size[index]}" /></label>`).join("")}
                </div>` : ""}
            ${editor.light_transport === "transmissive" ? this._numericControl("Transmission", "object.transmission", editor.transmission, { minimum: 0, maximum: 1, step: 0.01 }) : ""}
            <label class="vnccs-i3s__inspector-check"><input type="checkbox" data-object-property="collision_proxy.supports_objects"${editor.collision_proxy.supports_objects ? " checked" : ""} /> Can support other objects</label>
            <label class="vnccs-i3s__inspector-check"><input type="checkbox" data-object-property="locked"${editor.locked ? " checked" : ""} /> Lock transform</label>
            <div class="vnccs-i3s__inspector-actions">
                <button class="vnccs-i3s__button" type="button" data-inspector-action="drop"${editor.locked ? " disabled" : ""}>Drop to surface</button>
                <button class="vnccs-i3s__button" type="button" data-inspector-action="reset"${editor.locked ? " disabled" : ""}>Reset transform</button>
            </div>`;
        this._bindObjectInspector(item);
    }

    _bindObjectInspector(item) {
        let before = null;
        const begin = () => { before ||= this._captureEditorSnapshot(); };
        const finish = label => {
            if (!before) return;
            this.history.push(label, before, this._captureEditorSnapshot());
            before = null;
            this._scheduleSceneSave(0);
            this._scheduleStateSave(0);
            this._scheduleScenePreview(160);
        };
        for (const control of this.els.inspector.querySelectorAll("[data-editor-path]")) {
            control.addEventListener("pointerdown", begin);
            control.addEventListener("focus", begin);
            control.addEventListener("input", () => {
                const [key, rawIndex] = control.dataset.editorPath.split(".");
                const value = Number(control.value);
                if (!Number.isFinite(value)) return;
                if (key === "object" && rawIndex === "transmission") item.transmission = clamp(value, 0, 1);
                else if (key === "scale") item.transform.scale = clamp(value, 0.001, 1000);
                else item.transform[key][Number(rawIndex)] = value;
                for (const peer of this.els.inspector.querySelectorAll(`[data-editor-path="${control.dataset.editorPath}"]`)) {
                    if (peer !== control) peer.value = String(value);
                }
                this.viewer.updateObject(item.object_id, key === "object"
                    ? { transmission: item.transmission }
                    : { transform: item.transform });
                this._scheduleSceneSave(180);
                this._scheduleStateSave(180);
            });
            control.addEventListener("change", () => finish("Edit transform"));
        }
        for (const control of this.els.inspector.querySelectorAll("[data-proxy-path]")) {
            control.addEventListener("focus", begin);
            control.addEventListener("input", () => {
                const [key, rawIndex] = control.dataset.proxyPath.split(".");
                const value = Number(control.value);
                if (!Number.isFinite(value)) return;
                item.collision_proxy = normalizedObjectEditorProperties(item).collision_proxy;
                item.collision_proxy[key][Number(rawIndex)] = key === "size"
                    ? Math.max(0.001, value)
                    : value;
                this.viewer.updateObject(item.object_id, { collision_proxy: item.collision_proxy });
                this._scheduleSceneSave(180);
            });
            control.addEventListener("change", () => finish("Edit collision box"));
        }
        for (const control of this.els.inspector.querySelectorAll("[data-object-property]")) {
            control.addEventListener("change", () => {
                const original = this._captureEditorSnapshot();
                const key = control.dataset.objectProperty;
                if (key === "collision_proxy.mode") {
                    item.collision_proxy = normalizedObjectEditorProperties(item).collision_proxy;
                    item.collision_proxy.mode = control.value;
                } else if (key === "collision_proxy.supports_objects") {
                    item.collision_proxy = normalizedObjectEditorProperties(item).collision_proxy;
                    item.collision_proxy.supports_objects = control.checked;
                } else if (key === "locked") item.locked = control.checked;
                else if (key === "level_id") {
                    const previousLevel = this.scene.levels.find(level => level.level_id === item.level_id);
                    const nextLevel = this.scene.levels.find(level => level.level_id === control.value);
                    item.transform.position[1] += (Number(nextLevel?.elevation) || 0)
                        - (Number(previousLevel?.elevation) || 0);
                    item.level_id = control.value;
                }
                else if (key === "building_id") {
                    item.building_id = this._validBuildingId(control.value);
                    if (item.building_id) this.editorView.active_building_id = item.building_id;
                }
                else {
                    item[key] = control.value;
                    if (key === "light_transport" && control.value === "transmissive" && !item.transmission) {
                        item.transmission = 1;
                    }
                }
                this.viewer.updateObject(item.object_id, item);
                this.history.push("Edit object properties", original, this._captureEditorSnapshot());
                this._scheduleSceneSave(0);
                this._scheduleStateSave(0);
                if (key === "building_id") this._syncToolbar();
                if (["collision_proxy.mode", "light_transport", "locked"].includes(key)) this._renderInspector();
            });
        }
        this.els.inspector.querySelector('[data-inspector-action="drop"]')?.addEventListener("click", () => {
            this._dropSelectionToSurface(false);
        });
        this.els.inspector.querySelector('[data-inspector-action="reset"]')?.addEventListener("click", () => {
            this._recordEditorCommand("Reset transform", () => {
                const level = this.scene.levels.find(value => value.level_id === item.level_id);
                const building = this.scene.architecture?.buildings?.find(
                    value => value.building_id === item.building_id,
                );
                item.transform = {
                    position: [
                        Number(building?.position?.[0]) || 0,
                        (Number(level?.elevation) || 0) + (Number(building?.position?.[1]) || 0),
                        Number(building?.position?.[2]) || 0,
                    ],
                    rotation: [0, 0, 0],
                    scale: 1,
                };
                this.viewer.updateObject(item.object_id, { transform: item.transform });
                this._renderInspector();
                this._scheduleSceneSave(0);
            });
        });
    }

    _materialOptions(selectedId = "") {
        const materials = this.scene?.architecture?.materials || [];
        return [
            `<option value=""${selectedId ? "" : " selected"}>Default material</option>`,
            ...materials.map(material => (
                `<option value="${material.material_id}"${material.material_id === selectedId ? " selected" : ""}>${escapeHTML(material.name || "Material")}</option>`
            )),
        ].join("");
    }

    _materialControls(targetPath, selectedId = "", label = "Material") {
        const material = this.scene?.architecture?.materials?.find(value => value.material_id === selectedId);
        return `
            <div class="vnccs-i3s__material-control">
                <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">${escapeHTML(label)}</span>
                    <select class="vnccs-i3s__select" data-architecture-property="${targetPath}">${this._materialOptions(selectedId)}</select>
                </label>
                ${material ? `
                    <details class="vnccs-i3s__material-details"><summary>Edit ${escapeHTML(material.name || "material")}</summary>
                    <div class="vnccs-i3s__material-inline" data-material-id="${material.material_id}">
                        <input type="color" data-material-property="color" value="${material.color || "#d7d2ca"}" aria-label="Material color" />
                        <input class="vnccs-i3s__input" type="text" data-material-property="name" value="${escapeHTML(material.name || "Material")}" maxlength="80" aria-label="Material name" />
                        <select class="vnccs-i3s__select" data-material-property="kind" aria-label="Material type"><option value="standard"${material.kind !== "glass" ? " selected" : ""}>Standard</option><option value="glass"${material.kind === "glass" ? " selected" : ""}>Glass</option></select>
                        <label>Rough<input class="vnccs-i3s__input" type="number" min="0" max="1" step="0.01" data-material-property="roughness" value="${material.roughness ?? 0.78}" /></label>
                        <label>Metal<input class="vnccs-i3s__input" type="number" min="0" max="1" step="0.01" data-material-property="metalness" value="${material.metalness ?? 0}" /></label>
                        <label>Opacity<input class="vnccs-i3s__input" type="number" min="0" max="1" step="0.01" data-material-property="opacity" value="${material.opacity ?? 1}" /></label>
                        <label>UV X<input class="vnccs-i3s__input" type="number" min="0.001" max="1000" step="0.01" data-material-property="uv_scale.0" value="${material.uv_scale?.[0] ?? 1}" /></label>
                        <label>UV Y<input class="vnccs-i3s__input" type="number" min="0.001" max="1000" step="0.01" data-material-property="uv_scale.1" value="${material.uv_scale?.[1] ?? 1}" /></label>
                        <label>UV °<input class="vnccs-i3s__input" type="number" step="0.01" data-material-property="uv_rotation" value="${material.uv_rotation ?? 0}" /></label>
                        ${material.kind === "glass" ? `<label>Transmit<input class="vnccs-i3s__input" type="number" min="0" max="1" step="0.01" data-material-property="transmission" value="${material.transmission ?? 1}" /></label><label>IOR<input class="vnccs-i3s__input" type="number" min="1" max="2.5" step="0.01" data-material-property="ior" value="${material.ior ?? 1.5}" /></label>` : ""}
                    </div></details>` : ""}
            </div>`;
    }

    _materialActions(defaultTarget) {
        return `
            <input data-material-upload-input type="file" accept="image/jpeg,image/png,image/webp" hidden />
            <div class="vnccs-i3s__inspector-actions">
                <button class="vnccs-i3s__button" type="button" data-material-action="solid" data-material-target="${defaultTarget}">New solid material</button>
                <button class="vnccs-i3s__button" type="button" data-material-action="upload" data-material-target="${defaultTarget}">Upload texture</button>
            </div>`;
    }

    _newArchitectureMaterial(name = "Material") {
        return {
            material_id: factoryId(),
            name: String(name || "Material").slice(0, 80),
            kind: "standard",
            color: "#d7d2ca",
            roughness: 0.78,
            metalness: 0,
            opacity: 1,
            transmission: 0,
            ior: 1.5,
            uv_scale: [1, 1],
            uv_offset: [0, 0],
            uv_rotation: 0,
            normal_strength: 1,
        };
    }

    async _uploadSceneTexture(file, { flushScene = true } = {}) {
        if (!this.sceneId || !file) return null;
        const sceneId = this.sceneId;
        if (
            !["image/jpeg", "image/png", "image/webp"].includes(file.type)
            || file.size > MAX_TEXTURE_BYTES
        ) {
            throw new Error("Texture must be a JPEG, PNG, or WebP image up to 32 MB.");
        }
        // Resolve any queued metadata edit first so the texture mutation and
        // its following material PATCH share a current optimistic revision.
        if (flushScene) await this._saveSceneNow({ showError: false });
        if (!this.scene || this.sceneId !== sceneId) {
            throw new Error("The active scene changed before the texture upload started.");
        }
        const form = new FormData();
        form.append("image", file, file.name);
        const result = await this._fetchJSON(ENDPOINTS.textures(sceneId), {
            method: "POST",
            body: form,
        });
        if (!this.scene || this.sceneId !== sceneId) {
            throw new Error("The active scene changed while the texture was uploading.");
        }
        this.scene.textures = result.scene?.textures || this.scene.textures || [];
        this.scene.edit_revision = result.scene?.edit_revision ?? this.scene.edit_revision;
        return result.texture;
    }

    async _uploadTextureMaterial(file) {
        if ((this.scene?.architecture?.materials?.length || 0) >= 512) {
            throw new Error("The scene material limit has been reached.");
        }
        const texture = await this._uploadSceneTexture(file);
        if (!texture) return null;
        const material = this._newArchitectureMaterial(
            String(file.name || "Texture").replace(/\.[^.]+$/, ""),
        );
        material.color = "#ffffff";
        material.texture_id = texture.texture_id;
        this.scene.architecture.materials.push(material);
        return material;
    }

    _roomMaterialSummary(room, wallMaterialId = "") {
        const names = new Map(
            (this.scene?.architecture?.materials || []).map(material => [
                material.material_id,
                material.name || "Material",
            ]),
        );
        const summary = [
            ["Walls", wallMaterialId],
            ["Floor", room.floor?.material_id],
            ["Ceiling", room.ceiling?.material_id],
        ].map(([label, materialId]) => `
            <div class="vnccs-i3s__room-surface-row">
                <span>${label}</span><b>${escapeHTML(names.get(materialId) || "Default")}</b>
            </div>`).join("");
        return `
            <div class="vnccs-i3s__inspector-group vnccs-i3s__room-materials-summary">
                <b>Room surfaces</b>${summary}
                <button class="vnccs-i3s__button" type="button" data-room-materials>Manage textures and mapping</button>
            </div>`;
    }

    _openRoomMaterialManager(room) {
        if (!room || !this.scene?.architecture) return;
        const architecture = this.scene.architecture;
        const linkedWalls = architecture.walls.filter(wall => room.wall_ids?.includes(wall.wall_id));
        const materials = JSON.parse(JSON.stringify(architecture.materials || []));
        const assignments = {
            walls: linkedWalls[0]?.material_left || "",
            floor: room.floor?.material_id || "",
            ceiling: room.ceiling?.material_id || "",
        };
        const surfaceLabels = { walls: "Walls", floor: "Floor", ceiling: "Ceiling" };
        const pendingFiles = new Map();
        let activeSurface = "walls";
        let advancedOpen = false;
        const body = element("div", "vnccs-i3s__material-manager");
        const cancel = button("vnccs-i3s__button", "Cancel");
        const apply = button("vnccs-i3s__button vnccs-i3s__button--primary", "Apply to room");

        const activeMaterial = () => materials.find(
            material => material.material_id === assignments[activeSurface],
        ) || null;
        const textureName = textureId => (
            this.scene.textures?.find(texture => texture.texture_id === textureId)?.name || "Assigned texture"
        );
        const options = selectedId => [
            `<option value=""${selectedId ? "" : " selected"}>Default material</option>`,
            ...materials.map(material => `
                <option value="${material.material_id}"${material.material_id === selectedId ? " selected" : ""}>${escapeHTML(material.name || "Material")}</option>`),
        ].join("");
        const textureRow = (material, field, label, description) => {
            const pending = pendingFiles.get(`${material.material_id}:${field}`);
            const current = pending?.name || (material[field] ? textureName(material[field]) : "Not assigned");
            return `
                <div class="vnccs-i3s__material-map-row">
                    <div><b>${label}</b><span>${escapeHTML(current)}</span><small>${description}</small></div>
                    <input type="file" accept="image/jpeg,image/png,image/webp" data-material-map-file="${field}" hidden />
                    <button class="vnccs-i3s__button" type="button" data-material-map-pick="${field}">Choose</button>
                    <button class="vnccs-i3s__button vnccs-i3s__button--quiet" type="button" data-material-map-clear="${field}"${!pending && !material[field] ? " disabled" : ""}>Clear</button>
                </div>`;
        };

        const render = () => {
            const material = activeMaterial();
            body.innerHTML = `
                <div class="vnccs-i3s__material-surface-tabs" role="tablist" aria-label="Room surface">
                    ${Object.entries(surfaceLabels).map(([key, label]) => `
                        <button type="button" role="tab" data-material-surface="${key}" aria-selected="${key === activeSurface}">
                            <span>${label}</span><small>${escapeHTML(materials.find(value => value.material_id === assignments[key])?.name || "Default")}</small>
                        </button>`).join("")}
                </div>
                <div class="vnccs-i3s__material-toolbar">
                    <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">${surfaceLabels[activeSurface]} material</span>
                        <select class="vnccs-i3s__select" data-material-assignment>${options(assignments[activeSurface])}</select>
                    </label>
                    <button class="vnccs-i3s__button" type="button" data-material-create>New</button>
                    <button class="vnccs-i3s__button" type="button" data-material-duplicate${material ? "" : " disabled"}>Duplicate</button>
                </div>
                ${material ? `
                    <div class="vnccs-i3s__material-section">
                        <div class="vnccs-i3s__material-section-title"><b>Base surface</b><span>Changes to this material affect every surface that uses it.</span></div>
                        <div class="vnccs-i3s__material-fields">
                            <label class="vnccs-i3s__field is-wide"><span class="vnccs-i3s__label">Name</span><input class="vnccs-i3s__input" data-material-draft="name" maxlength="80" value="${escapeHTML(material.name || "Material")}" /></label>
                            <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Color</span><input class="vnccs-i3s__material-color" type="color" data-material-draft="color" value="${material.color || "#d7d2ca"}" /></label>
                            <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Type</span><select class="vnccs-i3s__select" data-material-draft="kind"><option value="standard"${material.kind !== "glass" ? " selected" : ""}>Standard PBR</option><option value="glass"${material.kind === "glass" ? " selected" : ""}>Glass</option></select></label>
                            <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Roughness</span><input class="vnccs-i3s__input" type="number" min="0" max="1" step="0.01" data-material-draft="roughness" value="${material.roughness ?? 0.78}" /></label>
                            <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Metalness</span><input class="vnccs-i3s__input" type="number" min="0" max="1" step="0.01" data-material-draft="metalness" value="${material.metalness ?? 0}" /></label>
                            <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Opacity</span><input class="vnccs-i3s__input" type="number" min="0" max="1" step="0.01" data-material-draft="opacity" value="${material.opacity ?? 1}" /></label>
                            ${material.kind === "glass" ? `<label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Transmission</span><input class="vnccs-i3s__input" type="number" min="0" max="1" step="0.01" data-material-draft="transmission" value="${material.transmission ?? 1}" /></label><label class="vnccs-i3s__field"><span class="vnccs-i3s__label">IOR</span><input class="vnccs-i3s__input" type="number" min="1" max="2.5" step="0.01" data-material-draft="ior" value="${material.ior ?? 1.5}" /></label>` : ""}
                        </div>
                        ${textureRow(material, "texture_id", "Color / albedo map", "sRGB color texture")}
                    </div>
                    <div class="vnccs-i3s__material-section">
                        <div class="vnccs-i3s__material-section-title"><b>Mapping</b><span>Shared by all maps in this material.</span></div>
                        <div class="vnccs-i3s__material-fields">
                            <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Scale X</span><input class="vnccs-i3s__input" type="number" min="0.001" max="1000" step="0.01" data-material-draft="uv_scale.0" value="${material.uv_scale?.[0] ?? 1}" /></label>
                            <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Scale Y</span><input class="vnccs-i3s__input" type="number" min="0.001" max="1000" step="0.01" data-material-draft="uv_scale.1" value="${material.uv_scale?.[1] ?? 1}" /></label>
                            <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Offset X</span><input class="vnccs-i3s__input" type="number" step="0.01" data-material-draft="uv_offset.0" value="${material.uv_offset?.[0] ?? 0}" /></label>
                            <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Offset Y</span><input class="vnccs-i3s__input" type="number" step="0.01" data-material-draft="uv_offset.1" value="${material.uv_offset?.[1] ?? 0}" /></label>
                            <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Rotation °</span><input class="vnccs-i3s__input" type="number" step="0.1" data-material-draft="uv_rotation" value="${material.uv_rotation ?? 0}" /></label>
                        </div>
                    </div>
                    <details class="vnccs-i3s__material-advanced"${advancedOpen ? " open" : ""}>
                        <summary>Surface detail <span>optional · adds GPU texture samples</span></summary>
                        <div class="vnccs-i3s__material-advanced-body">
                            ${textureRow(material, "normal_texture_id", "Normal map", "Adds lighting detail without extra geometry")}
                            <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Normal strength</span><input class="vnccs-i3s__input" type="number" min="0" max="4" step="0.05" data-material-draft="normal_strength" value="${material.normal_strength ?? 1}" /></label>
                            ${textureRow(material, "roughness_texture_id", "Roughness map", "Green channel controls local roughness")}
                        </div>
                    </details>` : `
                    <div class="vnccs-i3s__modal-note">This surface uses the lightweight built-in material. Select an existing material or create a new one to assign textures.</div>`}
                <div class="vnccs-i3s__material-budget-note">Only materials assigned to architecture are loaded. Identical texture and UV settings are reused; normal and roughness maps remain optional.</div>`;

            body.querySelectorAll("[data-material-surface]").forEach(control => {
                control.addEventListener("click", () => {
                    activeSurface = control.dataset.materialSurface;
                    render();
                });
            });
            body.querySelector(".vnccs-i3s__material-advanced")?.addEventListener(
                "toggle",
                event => { advancedOpen = event.currentTarget.open; },
            );
            body.querySelector("[data-material-assignment]")?.addEventListener("change", event => {
                assignments[activeSurface] = event.currentTarget.value;
                render();
            });
            body.querySelector("[data-material-create]")?.addEventListener("click", () => {
                if (materials.length >= 512) return this.toast("The scene material limit has been reached.", "error");
                const created = this._newArchitectureMaterial(`${surfaceLabels[activeSurface]} material`);
                materials.push(created);
                assignments[activeSurface] = created.material_id;
                render();
            });
            body.querySelector("[data-material-duplicate]")?.addEventListener("click", () => {
                const source = activeMaterial();
                if (!source || materials.length >= 512) return;
                const copy = JSON.parse(JSON.stringify(source));
                copy.material_id = factoryId();
                copy.name = `${source.name || "Material"} copy`.slice(0, 80);
                materials.push(copy);
                assignments[activeSurface] = copy.material_id;
                render();
            });
            body.querySelectorAll("[data-material-draft]").forEach(control => {
                control.addEventListener("change", () => {
                    const target = activeMaterial();
                    if (!target) return;
                    const parts = control.dataset.materialDraft.split(".");
                    let owner = target;
                    while (parts.length > 1) owner = owner[parts.shift()];
                    owner[parts[0]] = control.type === "number" ? Number(control.value) : control.value;
                    if (control.dataset.materialDraft === "kind") {
                        if (control.value === "glass" && !(Number(target.transmission) > 0)) target.transmission = 1;
                        render();
                    }
                });
            });
            body.querySelectorAll("[data-material-map-pick]").forEach(control => {
                control.addEventListener("click", () => body.querySelector(
                    `[data-material-map-file="${control.dataset.materialMapPick}"]`,
                )?.click());
            });
            body.querySelectorAll("[data-material-map-file]").forEach(control => {
                control.addEventListener("change", () => {
                    const target = activeMaterial();
                    const file = control.files?.[0];
                    if (!target || !file) return;
                    pendingFiles.set(`${target.material_id}:${control.dataset.materialMapFile}`, file);
                    render();
                });
            });
            body.querySelectorAll("[data-material-map-clear]").forEach(control => {
                control.addEventListener("click", () => {
                    const target = activeMaterial();
                    if (!target) return;
                    const field = control.dataset.materialMapClear;
                    delete target[field];
                    pendingFiles.delete(`${target.material_id}:${field}`);
                    render();
                });
            });
        };

        cancel.addEventListener("click", () => this.closeModal());
        apply.addEventListener("click", async () => {
            const before = this._captureEditorSnapshot();
            apply.disabled = true;
            apply.querySelector("span").textContent = pendingFiles.size ? "Uploading…" : "Applying…";
            try {
                if (pendingFiles.size) await this._saveSceneNow({ showError: false });
                for (const [key, file] of pendingFiles) {
                    const separator = key.indexOf(":");
                    const materialId = key.slice(0, separator);
                    const field = key.slice(separator + 1);
                    const target = materials.find(material => material.material_id === materialId);
                    if (!target) continue;
                    const texture = await this._uploadSceneTexture(file, { flushScene: false });
                    if (texture) target[field] = texture.texture_id;
                }
                architecture.materials = materials;
                room.floor = { ...(room.floor || {}), material_id: assignments.floor };
                room.ceiling = { ...(room.ceiling || {}), material_id: assignments.ceiling };
                for (const wall of linkedWalls) {
                    wall.material_left = assignments.walls;
                    wall.material_right = assignments.walls;
                    wall.material_caps = assignments.walls;
                }
                this.history.push("Edit room materials", before, this._captureEditorSnapshot());
                await this._commitArchitecture();
                this.closeModal();
                this.toast("Room materials updated.", "success");
            } catch (error) {
                apply.disabled = false;
                apply.querySelector("span").textContent = "Apply to room";
                this._showError("Room material update failed", error);
            }
        });
        render();
        this.openModal({
            title: `Room materials · ${room.name || "Room"}`,
            body,
            actions: [cancel, apply],
            wide: true,
        });
    }

    _renderArchitectureInspector(item) {
        const type = this.selectedArchitecture?.type || "architecture";
        const linkedRoom = type === "wall"
            ? this.scene.architecture.rooms.find(room => room.wall_ids?.includes(item.wall_id))
            : null;
        this.els.inspectorKind.textContent = type[0].toUpperCase() + type.slice(1);
        if (type === "building") {
            const onlyBuilding = this.scene.architecture.buildings.length <= 1;
            this.els.inspector.innerHTML = `
                <div class="vnccs-i3s__inspector-title">${escapeHTML(item.name || "Building")}</div>
                <div class="vnccs-i3s__hint">Moves and rotates the structure together with every assigned 3D object, saved camera, and local light.</div>
                <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Name</span><input class="vnccs-i3s__input" data-architecture-property="name" value="${escapeHTML(item.name || "Building")}" maxlength="80" /></label>
                <div class="vnccs-i3s__inspector-group"><b>Building transform</b>
                    ${this._numericControl("X", "position.0", item.position?.[0], { minimum: -10000, maximum: 10000, step: 0.01 })}
                    ${this._numericControl("Y", "position.1", item.position?.[1], { minimum: -10000, maximum: 10000, step: 0.01 })}
                    ${this._numericControl("Z", "position.2", item.position?.[2], { minimum: -10000, maximum: 10000, step: 0.01 })}
                    ${this._numericControl("Rotation Y", "rotation_y", item.rotation_y, { minimum: -36000, maximum: 36000, step: 0.01 })}
                </div>
                <label class="vnccs-i3s__inspector-check"><input type="checkbox" data-architecture-property="visible"${item.visible !== false ? " checked" : ""} /> Building visible</label>
                <label class="vnccs-i3s__inspector-check"><input type="checkbox" data-architecture-property="locked"${item.locked ? " checked" : ""} /> Lock building transform</label>
                <div class="vnccs-i3s__hint">${onlyBuilding
                    ? "Delete this Building and its architecture. Assigned models, cameras, paths, and lights will remain in the scene without a Building assignment."
                    : "Delete this Building and its architecture. Assigned models, cameras, paths, and lights will move to another Building."}</div>
                <button class="vnccs-i3s__button vnccs-i3s__button--danger" type="button" data-inspector-action="delete">Delete building</button>`;
        } else if (type === "level") {
            this.els.inspector.innerHTML = `
                <div class="vnccs-i3s__inspector-title">${escapeHTML(item.name || "Floor level")}</div>
                <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Name</span><input class="vnccs-i3s__input" data-architecture-property="name" value="${escapeHTML(item.name || "Floor level")}" maxlength="80" /></label>
                <div class="vnccs-i3s__inspector-group"><b>Level geometry · m</b>
                    ${this._numericControl("Elevation", "elevation", item.elevation, { minimum: -10000, maximum: 10000, step: 0.01 })}
                    ${this._numericControl("Height", "height", item.height, { minimum: 0.1, maximum: 1000, step: 0.01 })}
                    ${this._numericControl("Slab", "slab_thickness", item.slab_thickness, { minimum: 0, maximum: 100, step: 0.01 })}
                </div>
                <label class="vnccs-i3s__inspector-check"><input type="checkbox" data-architecture-property="visible"${item.visible !== false ? " checked" : ""} /> Level visible</label>
                <button class="vnccs-i3s__button vnccs-i3s__button--danger" type="button" data-inspector-action="delete"${this.scene.levels.length <= 1 ? " disabled" : ""}>Delete level and its contents</button>`;
        } else if (type === "wall") {
            this.els.inspector.innerHTML = `
                <div class="vnccs-i3s__inspector-title">${escapeHTML(item.name || "Wall")}</div>
                <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Name</span><input class="vnccs-i3s__input" data-architecture-property="name" value="${escapeHTML(item.name || "Wall")}" maxlength="80" /></label>
                <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Floor level${linkedRoom ? " · inherited from room" : ""}</span><select class="vnccs-i3s__select" data-architecture-property="level_id"${linkedRoom ? " disabled" : ""}>
                    ${(this.scene?.levels || []).map(level => `<option value="${level.level_id}"${item.level_id === level.level_id ? " selected" : ""}>${escapeHTML(level.name)}</option>`).join("")}
                </select></label>
                <div class="vnccs-i3s__inspector-group"><b>Geometry · building-local m</b>
                    ${this._numericControl("Start X", "start.0", item.start[0], { minimum: -10000, maximum: 10000, step: 0.01, range: false })}
                    ${this._numericControl("Start Z", "start.1", item.start[1], { minimum: -10000, maximum: 10000, step: 0.01, range: false })}
                    ${this._numericControl("End X", "end.0", item.end[0], { minimum: -10000, maximum: 10000, step: 0.01, range: false })}
                    ${this._numericControl("End Z", "end.1", item.end[1], { minimum: -10000, maximum: 10000, step: 0.01, range: false })}
                    ${this._numericControl("Height", "height", item.height, {
                        minimum: 0.05,
                        maximum: 1000,
                        sliderMinimum: 0.05,
                        sliderMaximum: 10,
                        step: 0.01,
                    })}
                    ${this._numericControl("Thickness", "thickness", item.thickness, {
                        minimum: 0.01,
                        maximum: 10,
                        sliderMinimum: 0.01,
                        sliderMaximum: 1,
                        step: 0.01,
                    })}
                    ${this._numericControl("Base offset", "elevation_offset", item.elevation_offset, {
                        minimum: -1000,
                        maximum: 1000,
                        sliderMinimum: -5,
                        sliderMaximum: 5,
                        step: 0.01,
                    })}
                </div>
                <div class="vnccs-i3s__inspector-group"><b>Surfaces</b>
                    ${this._materialControls("material_left", item.material_left, "Left side")}
                    ${this._materialControls("material_right", item.material_right, "Right side")}
                    ${this._materialControls("material_caps", item.material_caps, "Edges")}
                    ${this._materialActions("material_left")}
                </div>
                <label class="vnccs-i3s__inspector-check"><input type="checkbox" data-architecture-property="visible"${item.visible !== false ? " checked" : ""} /> Wall visible</label>
                <label class="vnccs-i3s__inspector-check"><input type="checkbox" data-architecture-property="locked"${item.locked ? " checked" : ""} /> Lock wall</label>
                <button class="vnccs-i3s__button vnccs-i3s__button--danger" type="button" data-inspector-action="delete">Delete wall</button>`;
        } else if (type === "opening") {
            const hostWall = this.scene.architecture.walls.find(wall => wall.wall_id === item.wall_id);
            const limits = this._openingControlLimits(item, hostWall);
            const hostLength = limits.wallLength;
            this.els.inspector.innerHTML = `
                <div class="vnccs-i3s__inspector-title">${escapeHTML(item.name || "Opening")}</div>
                <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Name</span><input class="vnccs-i3s__input" data-architecture-property="name" value="${escapeHTML(item.name || "Opening")}" maxlength="80" /></label>
                <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Type</span><select class="vnccs-i3s__select" data-architecture-property="kind">
                    <option value="empty"${item.kind === "empty" ? " selected" : ""}>Empty opening</option>
                    <option value="door"${item.kind === "door" ? " selected" : ""}>Door</option>
                    <option value="window"${item.kind === "window" ? " selected" : ""}>Window / glass</option>
                </select></label>
                <div class="vnccs-i3s__hint">Host wall · ${this._formatControlNumber(limits.wallLength, 0.01)} m long · ${this._formatControlNumber(limits.wallHeight, 0.01)} m high</div>
                ${this._numericControl("Center from wall start · m", "opening_offset_m", Number(item.offset) * hostLength, {
                    minimum: limits.centerMinimum,
                    maximum: limits.centerMaximum,
                    step: 0.01,
                    disabled: Math.abs(limits.centerMaximum - limits.centerMinimum) < 0.01,
                })}
                ${this._numericControl("Width", "width", item.width, { minimum: 0.05, maximum: limits.widthMaximum, step: 0.01 })}
                ${this._numericControl("Height", "height", item.height, { minimum: 0.05, maximum: limits.wallHeight, step: 0.01 })}
                ${item.kind === "door"
                    ? this._numericControl("Sill", "sill_height", 0, { minimum: 0, maximum: 0, step: 0.01, range: false, disabled: true })
                    : this._numericControl("Sill", "sill_height", item.sill_height, { minimum: 0, maximum: limits.sillMaximum, step: 0.01 })}
                ${this._materialControls("material_id", item.material_id, "Glass / frame")}
                ${this._materialActions("material_id")}
                <label class="vnccs-i3s__inspector-check"><input type="checkbox" data-architecture-property="visible"${item.visible !== false ? " checked" : ""} /> Opening visible</label>
                <label class="vnccs-i3s__inspector-check"><input type="checkbox" data-architecture-property="locked"${item.locked ? " checked" : ""} /> Lock opening</label>
                <button class="vnccs-i3s__button vnccs-i3s__button--danger" type="button" data-inspector-action="delete">Delete opening</button>`;
        } else {
            const roomBounds = this._roomBounds(item);
            const linkedRoomWalls = (this.scene.architecture.walls || []).filter(
                wall => item.wall_ids?.includes(wall.wall_id),
            );
            const wallThickness = linkedRoomWalls.length
                ? linkedRoomWalls.reduce(
                    (total, wall) => total + (Number(wall.thickness) || 0.12),
                    0,
                ) / linkedRoomWalls.length
                : 0.12;
            const wallMaterial = linkedRoomWalls[0]?.material_left || "";
            this.els.inspector.innerHTML = `
                <div class="vnccs-i3s__inspector-title">${escapeHTML(item.name || "Room")}</div>
                <div class="vnccs-i3s__hint">The room is one object. Walls, floor, and ceiling move and resize together.</div>
                <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Name</span><input class="vnccs-i3s__input" data-architecture-property="name" value="${escapeHTML(item.name || "Room")}" maxlength="80" /></label>
                <label class="vnccs-i3s__field"><span class="vnccs-i3s__label">Floor level</span><select class="vnccs-i3s__select" data-architecture-property="level_id">
                    ${(this.scene?.levels || []).map(level => `<option value="${level.level_id}"${item.level_id === level.level_id ? " selected" : ""}>${escapeHTML(level.name)}</option>`).join("")}
                </select></label>
                <div class="vnccs-i3s__inspector-group"><b>Room envelope · building-local m</b>
                    ${this._numericControl("Position X", "room_origin.0", roomBounds.center[0], { minimum: -10000, maximum: 10000, step: 0.01 })}
                    ${this._numericControl("Position Z", "room_origin.1", roomBounds.center[1], { minimum: -10000, maximum: 10000, step: 0.01 })}
                    ${this._numericControl("Width", "room_size.0", roomBounds.size[0], { minimum: 0.05, maximum: 10000, sliderMinimum: 0.05, sliderMaximum: Math.max(20, roomBounds.size[0]), step: 0.01 })}
                    ${this._numericControl("Depth", "room_size.1", roomBounds.size[1], { minimum: 0.05, maximum: 10000, sliderMinimum: 0.05, sliderMaximum: Math.max(20, roomBounds.size[1]), step: 0.01 })}
                    ${this._numericControl("Height", "ceiling.height", item.ceiling?.height, { minimum: 0.05, maximum: 1000, sliderMinimum: 0.05, sliderMaximum: 10, step: 0.01 })}
                    ${this._numericControl("Wall thickness", "room_wall_thickness", wallThickness, { minimum: 0.01, maximum: 10, sliderMinimum: 0.01, sliderMaximum: 1, step: 0.01 })}
                    ${this._numericControl("Floor slab", "floor.thickness", item.floor?.thickness, { minimum: 0, maximum: 10, sliderMinimum: 0, sliderMaximum: 1, step: 0.01 })}
                    ${this._numericControl("Ceiling slab", "ceiling.thickness", item.ceiling?.thickness, { minimum: 0, maximum: 10, sliderMinimum: 0, sliderMaximum: 1, step: 0.01 })}
                </div>
                ${this._roomMaterialSummary(item, wallMaterial)}
                <label class="vnccs-i3s__inspector-check"><input type="checkbox" data-architecture-property="visible"${item.visible !== false ? " checked" : ""} /> Room visible</label>
                <label class="vnccs-i3s__inspector-check"><input type="checkbox" data-architecture-property="locked"${item.locked ? " checked" : ""} /> Lock room</label>
                <button class="vnccs-i3s__button vnccs-i3s__button--danger" type="button" data-inspector-action="delete" title="Delete room (Delete/Backspace)">Delete room and perimeter walls</button>`;
        }
        const ownerBuilding = type === "opening"
            ? this._buildingForItem(this.scene.architecture.walls.find(wall => wall.wall_id === item.wall_id))
            : this._buildingForItem(item);
        const linkedWallLocked = type === "room" && this.scene.architecture.walls.some(
            wall => item.wall_ids?.includes(wall.wall_id) && wall.locked,
        );
        if ((item.locked || ownerBuilding?.locked || linkedWallLocked) && type !== "level") {
            for (const control of this.els.inspector.querySelectorAll("[data-editor-path]")) {
                control.disabled = true;
            }
            for (const control of this.els.inspector.querySelectorAll("[data-architecture-property]")) {
                if (!["locked", "visible", "name"].includes(control.dataset.architectureProperty)) {
                    control.disabled = true;
                }
            }
            const roomMaterials = this.els.inspector.querySelector("[data-room-materials]");
            if (roomMaterials) roomMaterials.disabled = true;
        }
        this._bindArchitectureInspector(item, type);
    }

    _bindArchitectureInspector(item, type) {
        let before = null;
        const begin = () => { before ||= this._captureEditorSnapshot(); };
        const applyPath = (path, value) => {
            if (type === "room" && path === "room_wall_material") {
                const linked = new Set(item.wall_ids || []);
                for (const wall of this.scene.architecture.walls || []) {
                    if (!linked.has(wall.wall_id)) continue;
                    wall.material_left = value;
                    wall.material_right = value;
                    wall.material_caps = value;
                }
                return;
            }
            const parts = path.split(".");
            let target = item;
            while (parts.length > 1) target = target[parts.shift()];
            target[parts[0]] = value;
        };
        this.els.inspector.querySelector("[data-room-materials]")?.addEventListener(
            "click",
            () => this._openRoomMaterialManager(item),
        );
        for (const control of this.els.inspector.querySelectorAll("[data-editor-path]")) {
            control.addEventListener("pointerdown", begin);
            control.addEventListener("focus", begin);
            control.addEventListener("input", () => {
                const value = Number(control.value);
                if (!Number.isFinite(value)) return;
                const path = control.dataset.editorPath;
                if (type === "building" && (path.startsWith("position.") || path === "rotation_y")) {
                    const nextPosition = [...item.position];
                    if (path.startsWith("position.")) nextPosition[Number(path.split(".")[1])] = value;
                    this._applyBuildingTransform(
                        item,
                        nextPosition,
                        path === "rotation_y" ? value : item.rotation_y,
                    );
                } else if (type === "opening" && path === "opening_offset_m") {
                    const wall = this.scene.architecture.walls.find(value => value.wall_id === item.wall_id);
                    const length = Math.hypot(
                        Number(wall?.end?.[0]) - Number(wall?.start?.[0]),
                        Number(wall?.end?.[1]) - Number(wall?.start?.[1]),
                    );
                    if (length > 1e-9) item.offset = clamp(value / length, 0, 1);
                } else if (type === "level" && path === "elevation") {
                    const delta = value - (Number(item.elevation) || 0);
                    item.elevation = value;
                    if (Math.abs(delta) > 1e-12) {
                        for (const object of this.scene.objects || []) {
                            if (object.level_id !== item.level_id) continue;
                            object.transform.position[1] += delta;
                            this.viewer.updateObject(object.object_id, { transform: object.transform });
                        }
                        for (const camera of this.scene.cameras || []) {
                            if (camera.level_id !== item.level_id) continue;
                            camera.position[1] += delta;
                            camera.target[1] += delta;
                        }
                        for (const light of this.lighting.lights || []) {
                            if (light.level_id !== item.level_id) continue;
                            light.position[1] += delta;
                            light.target[1] += delta;
                        }
                        this.viewer.setCameraMarkers(this.scene.cameras || []);
                        this._commitLighting();
                    }
                } else if (type === "room" && path.startsWith("room_origin.")) {
                    const axis = Number(path.split(".")[1]);
                    const center = this._roomBounds(item).center;
                    const delta = [0, 0];
                    delta[axis] = value - center[axis];
                    item.polygon = item.polygon.map(point => [point[0] + delta[0], point[1] + delta[1]]);
                    this._syncRoomPerimeter(item);
                } else if (type === "room" && path.startsWith("room_size.")) {
                    const axis = Number(path.split(".")[1]);
                    const bounds = this._roomBounds(item);
                    const currentSize = Math.max(0.001, bounds.size[axis]);
                    const targetSize = Math.max(0.05, value);
                    const scale = targetSize / currentSize;
                    item.polygon = item.polygon.map(point => {
                        const next = [...point];
                        next[axis] = bounds.center[axis] + (next[axis] - bounds.center[axis]) * scale;
                        return next;
                    });
                    this._syncRoomPerimeter(item);
                } else if (type === "room" && path === "room_wall_thickness") {
                    const thickness = clamp(value, 0.01, 10);
                    const linked = new Set(item.wall_ids || []);
                    for (const wall of this.scene.architecture.walls || []) {
                        if (linked.has(wall.wall_id)) wall.thickness = thickness;
                    }
                } else {
                    applyPath(path, value);
                }
                if (type === "room") this._syncRoomPerimeter(item);
                if (type === "wall" && /^(start|end)\./.test(control.dataset.editorPath)) {
                    this._syncRoomsForWall(item);
                }
                if (type === "opening") {
                    const wall = this.scene.architecture.walls.find(value => value.wall_id === item.wall_id);
                    if (wall) {
                        item.height = clamp(Number(item.height) || 0.05, 0.05, wall.height);
                        item.sill_height = clamp(Number(item.sill_height) || 0, 0, Math.max(0, wall.height - item.height));
                    }
                    const fitted = wall && this._fitOpeningOnWall(wall, item.offset, item.width, item.opening_id);
                    const fallback = fitted || (wall && this._fitOpeningOnWall(wall, item.offset, 0.05, item.opening_id));
                    if (fallback) {
                        item.offset = fallback.offset;
                        item.width = fallback.width;
                    }
                }
                const appliedValue = type === "room" && path.startsWith("room_origin.")
                    ? this._roomBounds(item).center[Number(path.split(".")[1])]
                    : type === "room" && path.startsWith("room_size.")
                        ? this._roomBounds(item).size[Number(path.split(".")[1])]
                        : type === "room" && path === "room_wall_thickness"
                            ? this.scene.architecture.walls.find(
                                wall => item.wall_ids?.includes(wall.wall_id),
                            )?.thickness
                            : type === "opening" && path === "opening_offset_m"
                    ? (() => {
                        const wall = this.scene.architecture.walls.find(value => value.wall_id === item.wall_id);
                        const length = Math.hypot(
                            Number(wall?.end?.[0]) - Number(wall?.start?.[0]),
                            Number(wall?.end?.[1]) - Number(wall?.start?.[1]),
                        );
                        return item.offset * length;
                    })()
                                : control.dataset.editorPath.split(".").reduce(
                                    (target, key) => target?.[key],
                                    item,
                                );
                for (const peer of this.els.inspector.querySelectorAll(`[data-editor-path="${control.dataset.editorPath}"]`)) {
                    const peerValue = Number.isFinite(Number(appliedValue)) ? appliedValue : value;
                    peer.value = this._formatControlNumber(peerValue, peer.step);
                }
                this._queueSelectedArchitecturePreview();
            });
            control.addEventListener("change", () => {
                this._queueSelectedArchitecturePreview({ flush: true });
                if (before) this.history.push("Edit architecture", before, this._captureEditorSnapshot());
                before = null;
                void this._commitArchitecture({ targeted: type !== "room" });
                if (type === "opening") this._renderInspector();
            });
        }
        for (const control of this.els.inspector.querySelectorAll("[data-architecture-property]")) {
            control.addEventListener("change", () => {
                const original = this._captureEditorSnapshot();
                const property = control.dataset.architectureProperty;
                const propertyValue = control.type === "checkbox" ? control.checked : control.value;
                const previousValue = property.split(".").reduce(
                    (target, key) => target?.[key],
                    item,
                );
                applyPath(property, propertyValue);
                if (property === "kind" && type === "opening" && previousValue !== propertyValue) {
                    const wall = this.scene.architecture.walls.find(value => value.wall_id === item.wall_id);
                    if (propertyValue === "door") {
                        item.sill_height = 0;
                        item.height = Math.min(2, Number(wall?.height) || 2);
                    } else if (propertyValue === "window" && previousValue === "door") {
                        item.height = Math.min(1.2, Number(wall?.height) || 1.2);
                        item.sill_height = Math.min(0.9, Math.max(0, (Number(wall?.height) || 2.8) - item.height));
                    }
                }
                if (property === "level_id" && type === "room") {
                    this._syncRoomPerimeter(item);
                }
                if (type === "room" && property === "visible") {
                    item.floor = { ...(item.floor || {}), enabled: propertyValue };
                    item.ceiling = { ...(item.ceiling || {}), enabled: propertyValue };
                }
                if (type === "room" && ["visible", "locked"].includes(property)) {
                    this._syncRoomPerimeter(item);
                }
                this.history.push("Edit architecture", original, this._captureEditorSnapshot());
                void this._commitArchitecture({ targeted: type !== "room" });
                if (property === "level_id") {
                    this.editorView.active_level_id = propertyValue;
                    this.viewer.setActiveLevel(propertyValue);
                    this._syncToolbar();
                }
                if (["locked", "kind"].includes(property)) this._renderInspector();
            });
        }
        let materialBefore = null;
        for (const control of this.els.inspector.querySelectorAll("[data-material-property]")) {
            const materialId = control.closest("[data-material-id]")?.dataset.materialId;
            const material = this.scene.architecture.materials.find(value => value.material_id === materialId);
            if (!material) continue;
            const beginMaterial = () => { materialBefore ||= this._captureEditorSnapshot(); };
            control.addEventListener("pointerdown", beginMaterial);
            control.addEventListener("focus", beginMaterial);
            control.addEventListener("input", () => {
                const parts = control.dataset.materialProperty.split(".");
                let target = material;
                while (parts.length > 1) target = target[parts.shift()];
                target[parts[0]] = control.type === "number" ? Number(control.value) : control.value;
                if (
                    control.dataset.materialProperty === "kind"
                    && control.value === "glass"
                    && !(Number(material.transmission) > 0)
                ) material.transmission = 1;
                this._previewArchitectureMaterials();
            });
            control.addEventListener("change", () => {
                if (materialBefore) {
                    this.history.push("Edit material", materialBefore, this._captureEditorSnapshot());
                    materialBefore = null;
                }
                void this._commitArchitecture();
                if (control.dataset.materialProperty === "kind") this._renderInspector();
            });
        }
        const uploadInput = this.els.inspector.querySelector("[data-material-upload-input]");
        let uploadTarget = "";
        for (const control of this.els.inspector.querySelectorAll("[data-material-action]")) {
            control.addEventListener("click", () => {
                const target = control.dataset.materialTarget;
                if (control.dataset.materialAction === "upload") {
                    uploadTarget = target;
                    uploadInput?.click();
                    return;
                }
                this._recordEditorCommand("Add material", () => {
                    if (this.scene.architecture.materials.length >= 512) {
                        this.toast("The scene material limit has been reached.", "error");
                        return;
                    }
                    const material = this._newArchitectureMaterial(
                        `Material ${this.scene.architecture.materials.length + 1}`,
                    );
                    this.scene.architecture.materials.push(material);
                    applyPath(target, material.material_id);
                    void this._commitArchitecture();
                    this._renderInspector();
                });
            });
        }
        uploadInput?.addEventListener("change", async () => {
            const file = uploadInput.files?.[0];
            uploadInput.value = "";
            if (!file || !uploadTarget) return;
            const beforeUpload = this._captureEditorSnapshot();
            try {
                const material = await this._uploadTextureMaterial(file);
                if (!material) return;
                applyPath(uploadTarget, material.material_id);
                this.history.push("Add textured material", beforeUpload, this._captureEditorSnapshot());
                await this._commitArchitecture();
                this._renderInspector();
                this.toast("Texture material added.", "success");
            } catch (error) {
                this._showError("Texture upload failed", error);
            }
        });
        this.els.inspector.querySelector('[data-inspector-action="delete"]')?.addEventListener("click", () => {
            const performDeletion = () => this._recordEditorCommand("Delete architecture", () => {
                const architecture = this.scene.architecture;
                if (type === "level") {
                    if (this.scene.levels.length <= 1) return;
                    const removedElevation = Number(item.elevation) || 0;
                    const wallIds = new Set(architecture.walls.filter(value => value.level_id === item.level_id).map(value => value.wall_id));
                    architecture.walls = architecture.walls.filter(value => value.level_id !== item.level_id);
                    architecture.rooms = architecture.rooms.filter(value => value.level_id !== item.level_id);
                    architecture.openings = architecture.openings.filter(value => !wallIds.has(value.wall_id));
                    this.scene.levels = this.scene.levels.filter(value => value.level_id !== item.level_id);
                    this.editorView.active_level_id = this.scene.levels[0].level_id;
                    const fallbackElevation = Number(this.scene.levels[0].elevation) || 0;
                    const elevationDelta = fallbackElevation - removedElevation;
                    for (const object of this.scene.objects || []) {
                        if (object.level_id !== item.level_id) continue;
                        object.level_id = this.editorView.active_level_id;
                        object.transform.position[1] += elevationDelta;
                    }
                    for (const camera of this.scene.cameras || []) {
                        if (camera.level_id !== item.level_id) continue;
                        camera.level_id = this.editorView.active_level_id;
                        camera.position[1] += elevationDelta;
                        camera.target[1] += elevationDelta;
                    }
                    for (const light of this.lighting.lights || []) {
                        if (light.level_id !== item.level_id) continue;
                        light.level_id = this.editorView.active_level_id;
                        light.position[1] += elevationDelta;
                        light.target[1] += elevationDelta;
                    }
                } else if (type === "building") {
                    const wallIds = new Set(architecture.walls
                        .filter(value => value.building_id === item.building_id)
                        .map(value => value.wall_id));
                    architecture.walls = architecture.walls.filter(value => value.building_id !== item.building_id);
                    architecture.rooms = architecture.rooms.filter(value => value.building_id !== item.building_id);
                    architecture.openings = architecture.openings.filter(value => !wallIds.has(value.wall_id));
                    architecture.buildings = architecture.buildings.filter(value => value.building_id !== item.building_id);
                    const fallbackBuildingId = architecture.buildings[0]?.building_id || "";
                    this.editorView.active_building_id = fallbackBuildingId;
                    for (const object of this.scene.objects || []) {
                        if (object.building_id === item.building_id) object.building_id = fallbackBuildingId;
                    }
                    for (const camera of this.scene.cameras || []) {
                        if (camera.building_id === item.building_id) camera.building_id = fallbackBuildingId;
                    }
                    for (const light of this.lighting.lights || []) {
                        if (light.building_id === item.building_id) light.building_id = fallbackBuildingId;
                    }
                    for (const track of this.scene.camera_tracks || []) {
                        if (track.building_id === item.building_id) track.building_id = fallbackBuildingId;
                    }
                } else if (type === "wall") {
                    architecture.walls = architecture.walls.filter(value => value.wall_id !== item.wall_id);
                    architecture.openings = architecture.openings.filter(value => value.wall_id !== item.wall_id);
                    architecture.rooms = architecture.rooms.filter(
                        room => !room.wall_ids?.includes(item.wall_id),
                    );
                } else if (type === "opening") {
                    architecture.openings = architecture.openings.filter(value => value.opening_id !== item.opening_id);
                } else {
                    const perimeter = new Set(item.wall_ids || []);
                    architecture.walls = architecture.walls.filter(value => !perimeter.has(value.wall_id));
                    architecture.openings = architecture.openings.filter(value => !perimeter.has(value.wall_id));
                    architecture.rooms = architecture.rooms.filter(value => value.room_id !== item.room_id);
                }
                this.selectedArchitecture = null;
                this.selectedArchitectureItems.clear();
                void this._commitArchitecture();
            });
            if (type === "building") {
                this._confirmBuildingDeletion(item, performDeletion);
            } else {
                performDeletion();
            }
        });
    }

    _confirmBuildingDeletion(building, onConfirm) {
        if (!building?.building_id || typeof onConfirm !== "function") return;
        const architecture = this.scene?.architecture;
        if (!architecture) return;
        const onlyBuilding = architecture.buildings.length <= 1;
        const wallIds = new Set(architecture.walls
            .filter(value => value.building_id === building.building_id)
            .map(value => value.wall_id));
        const wallCount = wallIds.size;
        const roomCount = architecture.rooms.filter(
            value => value.building_id === building.building_id,
        ).length;
        const openingCount = architecture.openings.filter(
            value => wallIds.has(value.wall_id),
        ).length;
        const fallback = !onlyBuilding
            ? architecture.buildings.find(value => value.building_id !== building.building_id)
            : null;
        const body = element("div");
        body.append(
            element(
                "div",
                "vnccs-i3s__failure-summary",
                `Delete “${building.name || "Building"}”?`,
            ),
            element(
                "div",
                "vnccs-i3s__hint",
                `${wallCount} wall${wallCount === 1 ? "" : "s"}, ${roomCount} room${roomCount === 1 ? "" : "s"}, and ${openingCount} opening${openingCount === 1 ? "" : "s"} will be removed.`,
            ),
            element(
                "div",
                "vnccs-i3s__hint",
                onlyBuilding
                    ? "Assigned models, cameras, paths, and lights will remain in the scene without a Building assignment. No replacement Building will be created. You can undo this action."
                    : `Assigned models, cameras, paths, and lights will move to “${fallback?.name || "another Building"}”. You can undo this action.`,
            ),
        );
        const cancel = button("vnccs-i3s__button", "Cancel");
        const remove = button(
            "vnccs-i3s__button vnccs-i3s__button--danger",
            "Delete building",
            "trash",
        );
        cancel.addEventListener("click", () => this.closeModal());
        remove.addEventListener("click", () => {
            this.closeModal();
            onConfirm();
            this.toast("Building deleted.", "success");
        });
        this.openModal({
            title: "Delete building",
            body,
            actions: [cancel, remove],
            initialFocus: cancel,
        });
    }

    _activeCameraTrack() {
        return (this.scene?.camera_tracks || []).find(track => track.track_id === this.activeCameraTrackId)
            || this.scene?.camera_tracks?.[0]
            || null;
    }

    _addCameraTrack() {
        if (!this.scene) return;
        if ((this.scene.camera_tracks?.length || 0) >= 16) {
            this.toast("A scene can contain up to 16 camera paths.", "error");
            return;
        }
        this._recordEditorCommand("Add camera path", () => {
            const track = {
                track_id: factoryId(),
                name: `Path ${(this.scene.camera_tracks?.length || 0) + 1}`,
                building_id: this._activeBuilding()?.building_id || "",
                duration: 5,
                fps: 30,
                interpolation: "catmullrom",
                constant_speed: true,
                loop: false,
                keyframes: [],
            };
            this.scene.camera_tracks = [...(this.scene.camera_tracks || []), track];
            this.activeCameraTrackId = track.track_id;
            this._renderCameraTracks();
            this._scheduleSceneSave(0);
        });
    }

    _deleteCameraTrack() {
        const track = this._activeCameraTrack();
        if (!track) return;
        const before = this._captureEditorSnapshot();
        if (this.cameraPlayback) this._toggleCameraPlayback();
        this.scene.camera_tracks = (this.scene.camera_tracks || []).filter(
            value => value.track_id !== track.track_id,
        );
        this.activeCameraTrackId = this.scene.camera_tracks[0]?.track_id || "";
        this.selectedCameraKeyframeId = "";
        this.history.push("Delete camera path", before, this._captureEditorSnapshot());
        this._renderCameraTracks();
        this._renderInspector();
        this._scheduleSceneSave(0);
        this._syncToolbar();
    }

    _addCameraKeyframe(cameraState = null) {
        const track = this._activeCameraTrack();
        if (!track || !this.viewer) return;
        const total = (this.scene?.camera_tracks || []).reduce(
            (count, value) => count + (value.keyframes?.length || 0),
            0,
        );
        if (total >= 1000) {
            this.toast("The scene camera-point limit has been reached.", "error");
            return;
        }
        this._recordEditorCommand("Add camera point", () => {
            let time = track.keyframes.length
                ? Number(track.keyframes.at(-1).time) + 1
                : 0;
            if (time > track.duration && time <= 86400) track.duration = time;
            time = Math.min(track.duration, time);
            track.keyframes.push({
                keyframe_id: factoryId(),
                time,
                ...cameraPoseFromLegacy(cameraState || this.viewer.getCameraState()),
                easing: "smooth",
            });
            track.keyframes.sort((left, right) => left.time - right.time);
            this._renderCameraTracks();
            this._scheduleSceneSave(0);
        });
    }

    _renderCameraTracks() {
        if (!this.els?.cameraTrackSelect) return;
        const tracks = Array.isArray(this.scene?.camera_tracks) ? this.scene.camera_tracks : [];
        if (!tracks.some(track => track.track_id === this.activeCameraTrackId)) {
            this.activeCameraTrackId = tracks[0]?.track_id || "";
        }
        this.els.cameraTrackSelect.replaceChildren();
        if (!tracks.length) {
            const option = element("option", "", "No paths");
            option.value = "";
            this.els.cameraTrackSelect.appendChild(option);
        } else {
            for (const track of tracks) {
                const option = element("option", "", track.name || "Camera path");
                option.value = track.track_id;
                option.selected = track.track_id === this.activeCameraTrackId;
                this.els.cameraTrackSelect.appendChild(option);
            }
        }
        const active = this._activeCameraTrack();
        this.els.cameraTrackDelete.disabled = !active;
        this.els.cameraTrackName.disabled = !active;
        this.els.cameraTrackName.value = active?.name || "";
        this.els.cameraTrackBuilding.disabled = !active;
        const unassignedBuilding = element("option", "", "No building");
        unassignedBuilding.value = "";
        unassignedBuilding.selected = !this._validBuildingId(active?.building_id);
        this.els.cameraTrackBuilding.replaceChildren(unassignedBuilding, ...(this.scene?.architecture?.buildings || []).map(building => {
            const option = element("option", "", building.name || "Building");
            option.value = building.building_id;
            option.selected = building.building_id === this._validBuildingId(active?.building_id);
            return option;
        }));
        this.els.cameraKeyframeAdd.disabled = !active;
        this.els.cameraTrackPlay.disabled = !active || active.keyframes.length < 2;
        this.els.cameraTrackTime.max = String(active?.duration || 5);
        this.els.cameraTrackMeta.textContent = active
            ? `${active.keyframes.length} points · ${active.duration}s · ${active.fps} fps`
            : "No camera path";
        this.els.cameraKeyframes.replaceChildren();
        if (!active?.keyframes?.length) {
            this.els.cameraKeyframes.appendChild(element("div", "vnccs-i3s__camera-keyframe-empty", "Add at least two points."));
            return;
        }
        if (!active.keyframes.some(frame => frame.keyframe_id === this.selectedCameraKeyframeId)) {
            this.selectedCameraKeyframeId = "";
        }
        for (const [index, frame] of active.keyframes.entries()) {
            const row = element(
                "button",
                `vnccs-i3s__camera-keyframe${frame.keyframe_id === this.selectedCameraKeyframeId ? " is-selected" : ""}`,
            );
            row.type = "button";
            row.innerHTML = `<span>${index + 1}</span><b>Point ${index + 1}</b><time>${Number(frame.time).toFixed(2)}s</time>`;
            row.addEventListener("click", () => {
                this.editorView.active_building_id = this._validBuildingId(active.building_id);
                this.selectedCameraKeyframeId = frame.keyframe_id;
                this.selectedCameraId = "";
                this.selectedCameraIds.clear();
                this.selectedArchitecture = null;
                this.selectedArchitectureItems.clear();
                this.viewer.setArchitectureSelection(null);
                this.selectedObjectId = "";
                this.selectedObjectIds.clear();
                this.viewer.select("");
                this.viewer.setCameraState(legacyCameraFromPose(frame), { emit: false });
                this.els.cameraTrackTime.value = String(frame.time);
                this._renderCameraTracks();
                this._renderInspector();
                this._setWorkspaceTab("right", "inspector");
                this._syncToolbar();
                this._scheduleStateSave(0);
            });
            this.els.cameraKeyframes.appendChild(row);
        }
    }

    _setCameraTrackTime(time, evaluator = null) {
        const track = this._activeCameraTrack();
        if (!track || track.keyframes.length < 1) return;
        const pose = (evaluator || new FactoryCameraPath(track)).evaluate(time);
        this.viewer.setCameraState(legacyCameraFromPose(pose), { emit: false });
        this.els.cameraTrackTime.value = String(time);
        this.els.cameraTrackMeta.textContent = `${Number(time).toFixed(2)}s · ${track.keyframes.length} points`;
    }

    _toggleCameraPlayback() {
        if (this.cameraPlayback) {
            cancelAnimationFrame(this.cameraPlayback.frame);
            this.cameraPlayback = null;
            this.viewer.setCameraPlayback(false);
            this.els.cameraTrackPlay.textContent = "Play";
            this._syncCameraPanelControls();
            return;
        }
        const track = this._activeCameraTrack();
        if (!track || track.keyframes.length < 2) return;
        if (this.editorView.view_mode !== "3d") this._setViewMode("3d");
        let startTime = Math.max(0, Number(this.els.cameraTrackTime.value) || 0);
        if (!track.loop && startTime >= track.duration) startTime = 0;
        const started = performance.now() - startTime * 1000;
        const path = new FactoryCameraPath(track);
        this.els.cameraTrackPlay.textContent = "Pause";
        this.viewer.setCameraPlayback(true);
        this.cameraPlayback = { frame: 0, started };
        this._syncCameraPanelControls();
        const step = now => {
            if (!this.cameraPlayback) return;
            let time = (now - started) / 1000;
            if (time > track.duration) {
                if (track.loop) time %= track.duration;
                else {
                    this._setCameraTrackTime(track.duration);
                    this._toggleCameraPlayback();
                    return;
                }
            }
            this._setCameraTrackTime(time, path);
            this.cameraPlayback.frame = requestAnimationFrame(step);
        };
        this.cameraPlayback.frame = requestAnimationFrame(step);
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
                level_id: String(camera.level_id || ""),
                building_id: this._validBuildingId(camera.building_id),
                ...this._normalizeCameraState(camera),
            });
        }
        return output;
    }

    _bindCameraControls() {
        const rotate = delta => {
            this.viewer?.rotateCameraFPV?.(delta);
            if (this.previewCameraId && this.scene) {
                const camera = this.scene.cameras?.find(
                    item => item.camera_id === this.previewCameraId,
                );
                if (camera) {
                    Object.assign(camera, this.viewer.getCameraState());
                    this.viewer.setCameraMarkers(this.scene.cameras);
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
    }

    async addCamera() {
        if (!this.sceneId) await this.ensureScene();
        if (!this.scene) return;
        this.scene.cameras = this._normalizeSceneCameras(this.scene.cameras);
        if (this.scene.cameras.length >= 32) {
            this.toast("A scene can contain up to 32 cameras.", "error");
            return;
        }
        const before = this._captureEditorSnapshot();
        const camera = {
            camera_id: randomLayerId(),
            name: `Camera ${this.scene.cameras.length + 1}`,
            created_at: Date.now() / 1000,
            level_id: this.editorView.active_level_id || this.scene.levels?.[0]?.level_id || "",
            building_id: this._activeBuilding()?.building_id || "",
            ...this._normalizeCameraState(this.viewer.getCameraState()),
        };
        this.scene.cameras.push(camera);
        this.history.push("Add camera", before, this._captureEditorSnapshot());
        this._selectCamera(camera.camera_id);
        this._renderCameras();
        this._updateSceneSummary();
        await this._saveSceneNow();
        this.toast(`${camera.name} added.`, "success");
    }

    _selectCamera(cameraId) {
        const camera = this.scene?.cameras?.find(item => item.camera_id === cameraId);
        if (!camera) return;
        this.panoramaCameraId = cameraId;
        const selectedBuildingId = this._validBuildingId(camera.building_id);
        if (selectedBuildingId) this.editorView.active_building_id = selectedBuildingId;
        if (this.cameraPlayback) this._toggleCameraPlayback();
        this.selectedCameraKeyframeId = "";
        this._cameraSelectionTransition = true;
        try {
            this.selectedObjectId = "";
            this.selectedObjectIds.clear();
            this.selectedGroupId = "";
            this.selectedSkydome = false;
            this.selectedArchitecture = null;
            this.selectedArchitectureItems.clear();
            this.selectedLightId = "";
            this.viewer.selectLightMarker("");
            this.viewer.setArchitectureSelection(null);
            this.viewer.select("");
            this.selectedCameraId = cameraId;
            this.selectedCameraIds = new Set([cameraId]);
        } finally {
            this._cameraSelectionTransition = false;
        }
        this._syncSelectionPresentation();
        this._renderCameras();
        this._renderInspector();
        this._syncToolbar();
        this._syncPanoramaExportControls();
        this._setWorkspaceTab("right", "inspector");
        this._scheduleStateSave();
    }

    _enterCameraView(cameraId = this.selectedCameraId) {
        const camera = this.scene?.cameras?.find(item => item.camera_id === cameraId);
        if (!camera) return;
        if (!this.previewCameraId) {
            this._cameraReturnState = this._normalizeCameraState(
                this.viewer.getCameraState(),
                this.scene?.camera,
            );
        }
        this.previewCameraId = cameraId;
        if (this.scene.levels?.some(level => level.level_id === camera.level_id)) {
            this.editorView.active_level_id = camera.level_id;
            this.viewer.setActiveLevel(camera.level_id);
        }
        if (this.editorView.view_mode !== "3d") {
            this.editorView.view_mode = "3d";
            this.viewer.setViewMode("3d");
        }
        this.viewer.setCameraState(camera, { emit: false });
        this._syncToolbar();
        this._renderCameras();
        this._renderInspector();
        this._scheduleStateSave(0);
    }

    _exitCameraView({ restore = true } = {}) {
        if (!this.previewCameraId && !this._cameraReturnState) return;
        const returnState = this._cameraReturnState;
        this._cameraSelectionTransition = true;
        try {
            this.previewCameraId = "";
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
        this._renderInspector();
        this._scheduleStateSave();
    }

    async _deleteCamera(cameraId) {
        if (!this.scene) return;
        const camera = this.scene.cameras?.find(item => item.camera_id === cameraId);
        if (!camera) return;
        const before = this._captureEditorSnapshot();
        if (this.previewCameraId === cameraId) this._exitCameraView({ restore: true });
        if (this.selectedCameraId === cameraId) this.selectedCameraId = "";
        this.selectedCameraIds.delete(cameraId);
        if (this.panoramaCameraId === cameraId) this.panoramaCameraId = "";
        this.scene.cameras = this.scene.cameras.filter(
            item => item.camera_id !== cameraId,
        );
        this.history.push("Delete camera", before, this._captureEditorSnapshot());
        this._renderCameras();
        this._renderInspector();
        this._syncSelectionPresentation();
        this._syncToolbar();
        this._updateSceneSummary();
        this._scheduleStateSave(0);
        await this._saveSceneNow();
        this.toast(`${camera.name} removed.`, "success");
    }

    _renderCameras() {
        const cameras = this._normalizeSceneCameras(this.scene?.cameras);
        if (this.scene) this.scene.cameras = cameras;
        this.viewer?.setCameraMarkers?.(cameras, this.selectedCameraIds);
        this.els.cameraCount.textContent = String(cameras.length);
        this.els.cameraGroupCount.textContent = String(cameras.length);
        this.els.cameraAdd.disabled = !this.scene || cameras.length >= 32;
        this._syncPanoramaExportControls();
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
                    this.selectedCameraIds.has(camera.camera_id) ? " is-selected" : ""
                }${camera.camera_id === this.previewCameraId ? " is-previewing" : ""}`,
            );
            card.dataset.cameraId = camera.camera_id;
            card.title = `${camera.name} · ${this.scene?.levels?.find(level => level.level_id === camera.level_id)?.name || "Unassigned floor"}`;
            card.tabIndex = 0;
            card.setAttribute("role", "button");
            card.setAttribute("aria-pressed", String(this.selectedCameraIds.has(camera.camera_id)));
            card.innerHTML = `
                <span class="vnccs-i3s__camera-index">${index + 1}</span>
                <span class="vnccs-i3s__camera-item-icon">${ICONS.camera}</span>
                <span class="vnccs-i3s__camera-item-name"></span>
                <button class="vnccs-i3s__camera-preview" type="button"
                    title="${camera.camera_id === this.previewCameraId ? "Exit camera view" : "Enter camera view"}"
                    aria-label="${camera.camera_id === this.previewCameraId ? "Exit camera view" : "Enter camera view"}">${ICONS.eye}</button>
                <button class="vnccs-i3s__camera-delete" type="button"
                    title="Delete camera" aria-label="Delete camera">${ICONS.trash}</button>
            `;
            card.querySelector(".vnccs-i3s__camera-item-name").textContent = camera.name;
            card.querySelector(".vnccs-i3s__camera-delete").setAttribute(
                "aria-label",
                `Delete ${camera.name}`,
            );
            this._listen(card, "click", event => {
                if (event.target.closest(".vnccs-i3s__camera-delete, .vnccs-i3s__camera-preview")) return;
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
            this._listen(card.querySelector(".vnccs-i3s__camera-preview"), "click", event => {
                event.stopPropagation();
                this._selectCamera(camera.camera_id);
                if (this.previewCameraId === camera.camera_id) this._exitCameraView({ restore: true });
                else this._enterCameraView(camera.camera_id);
            });
            fragment.appendChild(card);
        }
        this.els.cameraList.appendChild(fragment);
    }

    _normalizeLighting(value = {}) {
        const data = { ...DEFAULT_LIGHTING, ...safeObject(value) };
        const shadowSource = { ...DEFAULT_LIGHTING.shadows, ...safeObject(data.shadows) };
        const validColor = color => /^#[0-9a-f]{6}$/i.test(String(color || ""));
        const requestedNormalBias = Number(shadowSource.normal_bias);
        const normalBias = !Number.isFinite(requestedNormalBias)
            || [0.015, 0.02].some(legacy => Math.abs(requestedNormalBias - legacy) < 1e-9)
            ? DEFAULT_LIGHTING.shadows.normal_bias
            : requestedNormalBias;
        const lights = (Array.isArray(data.lights) ? data.lights : []).slice(0, 32).map((raw, index) => {
            const light = safeObject(raw);
            const vector = (key, fallback) => Array.isArray(light[key]) && light[key].length === 3
                ? light[key].map((component, axis) => {
                    const number = Number(component);
                    return Number.isFinite(number) ? clamp(number, -10000, 10000) : fallback[axis];
                })
                : [...fallback];
            return {
                light_id: /^[a-f0-9]{32}$/.test(String(light.light_id || ""))
                    ? String(light.light_id)
                    : factoryId(),
                name: String(light.name || `Light ${index + 1}`).slice(0, 80),
                level_id: String(light.level_id || this.editorView.active_level_id || ""),
                building_id: this._validBuildingId(light.building_id),
                kind: ["point", "spot", "directional"].includes(light.kind) ? light.kind : "point",
                color: validColor(light.color) ? String(light.color).toLowerCase() : "#ffffff",
                intensity: clamp(light.intensity, 0, 100000),
                position: vector("position", [0, 2.4, 0]),
                target: vector("target", [0, 0, 0]),
                distance: clamp(light.distance, 0, 1000000),
                angle: clamp(light.angle, 1, 179),
                penumbra: clamp(light.penumbra, 0, 1),
                cast_shadow: light.cast_shadow !== false,
                visible: light.visible !== false,
            };
        });
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
            shadows: {
                enabled: shadowSource.enabled !== false,
                quality: ["off", "low", "medium", "high", "ultra"].includes(shadowSource.quality)
                    ? shadowSource.quality
                    : "medium",
                bias: clamp(shadowSource.bias, -0.05, 0.05),
                normal_bias: clamp(normalBias, 0, 1),
            },
            lights,
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
            // Asset replacement is a persistence boundary: older snapshots
            // can reference a background file that no longer exists.
            this.history.clear();
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
            this.history.clear();
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

    _selectLight(lightId) {
        const light = this.lighting?.lights?.find(item => item.light_id === lightId);
        if (!light) return;
        this.selectedLightId = light.light_id;
        this.selectedObjectId = "";
        this.selectedObjectIds.clear();
        this.selectedGroupId = "";
        this.selectedSkydome = false;
        this.selectedArchitecture = null;
        this.selectedArchitectureItems.clear();
        this.selectedCameraId = "";
        this.selectedCameraIds.clear();
        this.selectedCameraKeyframeId = "";
        this.viewer?.select?.("");
        this.viewer?.setArchitectureSelection?.(null);
        this.viewer?.selectLightMarker?.(light.light_id);
        this._renderObjects();
        this._renderCameras();
        this._renderInspector();
        this._syncToolbar();
        this._setWorkspaceTab("right", "inspector");
        this._scheduleStateSave(0);
    }

    _duplicateLight(lightId) {
        const source = this.lighting?.lights?.find(item => item.light_id === lightId);
        if (!source || this.lighting.lights.length >= 32) return;
        const before = this._captureEditorSnapshot();
        const light = JSON.parse(JSON.stringify(source));
        light.light_id = factoryId();
        light.name = `${source.name || "Point light"} copy`;
        light.position[0] = (Number(light.position[0]) || 0) + 0.5;
        light.position[2] = (Number(light.position[2]) || 0) + 0.5;
        light.target[0] = (Number(light.target[0]) || 0) + 0.5;
        light.target[2] = (Number(light.target[2]) || 0) + 0.5;
        this.lighting.lights.push(light);
        this.history.push("Duplicate light", before, this._captureEditorSnapshot());
        this._commitLighting({ final: true });
        this._renderObjects();
        this._updateSceneSummary();
        this._selectLight(light.light_id);
    }

    _deleteLight(lightId) {
        const light = this.lighting?.lights?.find(item => item.light_id === lightId);
        if (!light) return;
        const before = this._captureEditorSnapshot();
        this.lighting.lights = this.lighting.lights.filter(item => item.light_id !== lightId);
        if (this.selectedLightId === lightId) this.selectedLightId = "";
        this.viewer?.selectLightMarker?.("");
        this.history.push("Delete light", before, this._captureEditorSnapshot());
        this._commitLighting({ final: true });
        this._renderObjects();
        this._renderInspector();
        this._updateSceneSummary();
        this._syncToolbar();
        this._scheduleStateSave(0);
    }

    _onViewerLightTransform(lightId, position, { final = false } = {}) {
        const light = this.lighting?.lights?.find(item => item.light_id === lightId);
        if (!light || !Array.isArray(position) || position.length !== 3) return;
        this._lightTransformHistoryBefore ||= this._captureEditorSnapshot();
        light.position = position.map(value => Number(value) || 0);
        this.viewer?.previewLightPosition?.(lightId, light.position);
        if (!final) {
            this._scheduleStateSave(100);
            return;
        }
        this._commitLighting({ final: true });
        if (this._lightTransformHistoryBefore) {
            this.history.push(
                "Move light",
                this._lightTransformHistoryBefore,
                this._captureEditorSnapshot(),
            );
        }
        this._lightTransformHistoryBefore = null;
        this._renderObjects();
        this._renderInspector();
        this._syncToolbar();
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
        this.els.shadowEnabled.setAttribute(
            "aria-checked",
            String(this.lighting.shadows.enabled),
        );
        this.els.shadowQuality.value = this.lighting.shadows.quality === "off"
            ? "medium"
            : this.lighting.shadows.quality;
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

    _beginLightingHistory() {
        this._lightingHistoryBefore ||= this._captureEditorSnapshot();
    }

    _finishLightingHistory(label) {
        if (!this._lightingHistoryBefore) return;
        this.history.push(label, this._lightingHistoryBefore, this._captureEditorSnapshot());
        this._lightingHistoryBefore = null;
        this._syncToolbar();
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
            this._beginLightingHistory();
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
            this._finishLightingHistory("Edit light direction");
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
                if (this.scene) {
                    this.scene.reference = { ...asset };
                    this.scene.edit_revision = asset.edit_revision ?? this.scene.edit_revision;
                }
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
        const reopeningCurrentScene = Boolean(
            this.sceneId && this.sceneId === scene?.scene_id,
        );
        const incremental = Boolean(
            this.scene
            && this.sceneId
            && this.sceneId === scene?.scene_id,
        );
        if (!incremental) this.history.clear();
        const desiredGroupId = this.selectedGroupId;
        const desiredObjectIds = new Set(this.selectedObjectIds);
        const desiredSkydome = reopeningCurrentScene && this.selectedSkydome;
        const desiredCameraId = this.selectedCameraId;
        const desiredPanoramaCameraId = reopeningCurrentScene ? this.panoramaCameraId : "";
        const desiredCameraIds = new Set(this.selectedCameraIds);
        const desiredLightId = this.selectedLightId;
        if (desiredCameraId) desiredCameraIds.add(desiredCameraId);
        const desiredArchitectures = this._selectedArchitectureRefs().map(item => ({ ...item }));
        const desiredArchitecture = this.selectedArchitecture?.id
            ? { ...this.selectedArchitecture }
            : null;
        const desiredKeyframeId = this.selectedCameraKeyframeId;
        this.selectedGroupId = "";
        this.selectedCameraId = "";
        this.selectedCameraIds.clear();
        this.selectedLightId = "";
        this.selectedCameraKeyframeId = "";
        this.previewCameraId = "";
        this._cameraReturnState = null;
        if (this.selectedObjectId) desiredObjectIds.add(this.selectedObjectId);
        this.scene = scene;
        this.sceneId = scene.scene_id;
        this.scene.edit_revision = Math.max(0, Number(scene.edit_revision) || 0);
        this.scene.levels = normalizedLevels(scene.levels);
        this.scene.architecture = normalizedArchitecture(scene.architecture, this.scene.levels);
        this.scene.objects = (Array.isArray(scene.objects) ? scene.objects : []).map(item => ({
            ...item,
            level_id: this.scene.levels.some(level => level.level_id === item.level_id)
                ? item.level_id
                : this.scene.levels[0]?.level_id || "",
            ...normalizedObjectEditorProperties(item),
            building_id: this._validBuildingId(item.building_id),
        }));
        this.scene.camera_tracks = Array.isArray(scene.camera_tracks)
            ? JSON.parse(JSON.stringify(scene.camera_tracks)).map(track => ({
                ...track,
                building_id: this._validBuildingId(track.building_id),
            }))
            : [];
        this.editorView = normalizedEditorView(
            this.editorView,
            this.scene.levels[0]?.level_id,
        );
        if (!this.scene.levels.some(level => level.level_id === this.editorView.active_level_id)) {
            this.editorView.active_level_id = this.scene.levels[0]?.level_id || "";
        }
        this.selectedArchitecture = null;
        this.selectedArchitectureItems.clear();
        this.scene.cameras = this._normalizeSceneCameras(scene.cameras);
        for (const camera of this.scene.cameras) {
            if (!this.scene.levels.some(level => level.level_id === camera.level_id)) {
                camera.level_id = this.scene.levels[0]?.level_id || "";
            }
        }
        this.panoramaCameraId = this.scene.cameras.some(
            camera => camera.camera_id === desiredPanoramaCameraId,
        ) ? desiredPanoramaCameraId : this.scene.cameras[0]?.camera_id || "";
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
            this.viewer.setViewMode(this.editorView.view_mode);
            this.viewer.setPlanTool(this.editorView.plan_tool);
            this.viewer.setActiveLevel(this.editorView.active_level_id);
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
        const normalizedDesiredArchitecture = this._normalizeArchitectureSelection(desiredArchitecture);
        const architectureSelectionValid = selection => Boolean(selection && (
            (selection.type === "building" && this.scene.architecture.buildings.some(item => item.building_id === selection.id))
            || (selection.type === "level" && this.scene.levels.some(item => item.level_id === selection.id))
            || (selection.type === "wall" && this.scene.architecture.walls.some(item => item.wall_id === selection.id))
            || (selection.type === "room" && this.scene.architecture.rooms.some(item => item.room_id === selection.id))
            || (selection.type === "opening" && this.scene.architecture.openings.some(item => item.opening_id === selection.id))
        ));
        const desiredArchitectureValid = architectureSelectionValid(normalizedDesiredArchitecture);
        const normalizedDesiredArchitectures = desiredArchitectures
            .map(selection => this._normalizeArchitectureSelection(selection))
            .filter(architectureSelectionValid);
        const desiredCameraValid = this.scene.cameras.some(
            camera => camera.camera_id === desiredCameraId,
        );
        const desiredLightValid = this.lighting.lights.some(
            light => light.light_id === desiredLightId,
        );
        const normalizedDesiredCameraIds = new Set(Array.from(desiredCameraIds).filter(
            cameraId => this.scene.cameras.some(camera => camera.camera_id === cameraId),
        ));
        const desiredKeyframeTrack = this.scene.camera_tracks.find(
            track => track.keyframes?.some(frame => frame.keyframe_id === desiredKeyframeId),
        );
        if (desiredSkydome && scene.skydome) {
            this._selectSkydome();
        } else if (desiredLightValid) {
            this._selectLight(desiredLightId);
        } else if (desiredGroup) {
            this.selectedSkydome = false;
            this.selectedGroupId = desiredGroup.group_id;
            this.selectedObjectIds.clear();
            this.selectedObjectId = "";
            this.viewer.selectGroup(desiredGroup.group_id, desiredGroup.children);
        } else if (desiredArchitectureValid) {
            this.selectedSkydome = false;
            this.selectedGroupId = "";
            this.selectedObjectIds = new Set(Array.from(desiredObjectIds).filter(
                objectId => scene.objects?.some(item => item.object_id === objectId),
            ));
            this.selectedObjectId = Array.from(this.selectedObjectIds).at(-1) || "";
            this.selectedArchitecture = normalizedDesiredArchitecture;
            this.selectedArchitectureItems = new Map(normalizedDesiredArchitectures.map(selection => [
                this._architectureSelectionKey(selection),
                selection,
            ]));
            this.selectedCameraIds = normalizedDesiredCameraIds;
            this.selectedCameraId = Array.from(this.selectedCameraIds).at(-1) || "";
            this.viewer.select(this.selectedObjectId, { additive: true, emit: false });
            this.viewer.setArchitectureSelection(
                normalizedDesiredArchitecture,
                normalizedDesiredArchitectures,
            );
        } else if (desiredCameraValid && !desiredObjectIds.size && !normalizedDesiredArchitectures.length) {
            this._selectCamera(desiredCameraId);
        } else if (desiredKeyframeTrack) {
            this.selectedSkydome = false;
            this.selectedGroupId = "";
            this.selectedObjectIds.clear();
            this.selectedObjectId = "";
            this.activeCameraTrackId = desiredKeyframeTrack.track_id;
            this.selectedCameraKeyframeId = desiredKeyframeId;
            this.viewer.select("");
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
            this.selectedCameraIds = normalizedDesiredCameraIds;
            this.selectedCameraId = Array.from(this.selectedCameraIds).at(-1) || "";
            this.viewer.select(this.selectedObjectId, {
                additive: this.selectedObjectIds.size > 1,
            });
        }
        const selectionBuilding = this._activeBuilding();
        if (selectionBuilding) this.editorView.active_building_id = selectionBuilding.building_id;
        this._renderObjects();
        this._renderCameras();
        this._renderCameraTracks();
        this._renderInspector();
        this._syncToolbar();
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
        this._syncPanoramaExportControls();
        this._customSelects?.refresh?.();
    }

    _syncPanoramaExportControls() {
        if (!this.els?.panoramaCamera) return;
        const cameras = this.scene?.cameras || [];
        if (!cameras.some(camera => camera.camera_id === this.panoramaCameraId)) {
            this.panoramaCameraId = cameras.some(camera => camera.camera_id === this.selectedCameraId)
                ? this.selectedCameraId
                : cameras[0]?.camera_id || "";
        }
        const signature = cameras.map(camera => `${camera.camera_id}:${camera.name}`).join("|");
        if (this.els.panoramaCamera.dataset.signature !== signature) {
            this.els.panoramaCamera.replaceChildren(...(
                cameras.length
                    ? cameras.map(camera => {
                        const option = document.createElement("option");
                        option.value = camera.camera_id;
                        option.textContent = camera.name || "Camera";
                        return option;
                    })
                    : [(() => {
                        const option = document.createElement("option");
                        option.value = "";
                        option.textContent = "No saved cameras";
                        return option;
                    })()]
            ));
            this.els.panoramaCamera.dataset.signature = signature;
        }
        this.els.panoramaCamera.value = this.panoramaCameraId;
        this.panoramaWidth = [2048, 4096].includes(Number(this.panoramaWidth))
            ? Number(this.panoramaWidth)
            : 4096;
        this.els.panoramaSize.value = String(this.panoramaWidth);
        const camera = cameras.find(value => value.camera_id === this.panoramaCameraId);
        const disabled = !camera || this.exportingPanorama;
        this.els.panoramaCamera.disabled = this.exportingPanorama || !cameras.length;
        this.els.panoramaSize.disabled = this.exportingPanorama;
        this.els.panoramaExport.disabled = disabled;
        this.els.sceneExport.disabled = this.exportingPanorama;
        this.els.panoramaExport.setAttribute("aria-busy", String(this.exportingPanorama));
        const label = this.els.panoramaExport.querySelector("span:last-child");
        if (label) label.textContent = this.exportingPanorama ? "Rendering panorama…" : "Export 360° PNG";
        this.els.panoramaSummary.textContent = camera
            ? `${camera.name || "Camera"} · ${this.panoramaWidth} × ${this.panoramaWidth / 2} px · 2:1 equirectangular`
            : "Add a saved camera before exporting.";
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
        const rooms = this.scene?.architecture?.rooms || [];
        const roomWallIds = new Set(rooms.flatMap(room => room.wall_ids || []));
        const wallCount = (this.scene?.architecture?.walls || []).filter(
            wall => !roomWallIds.has(wall.wall_id),
        ).length;
        const roomCount = rooms.length;
        const skydome = this.scene?.skydome || null;
        const cameraCount = this.scene?.cameras?.length || 0;
        const lightCount = this.lighting?.lights?.length || 0;
        const visibleIds = this._effectiveVisibleObjectIds();
        this.els.objectCount.textContent = String(
            objects.length + lightCount + (skydome ? 1 : 0) + wallCount + roomCount,
        );
        const meshCount = objects.filter(item => item.asset_kind === "mesh").length;
        const gaussianCount = objects.length - meshCount;
        const gaussianSummary = objects.length
            ? `${visibleIds.size}/${objects.length} models visible`
                + `${gaussianCount ? ` · ${objects.reduce(
                (sum, item) => sum + (visibleIds.has(item.object_id) ? Number(item.gaussians) || 0 : 0),
                0,
            ).toLocaleString()} Gaussians` : ""}`
                + `${meshCount ? ` · ${meshCount} mesh${meshCount === 1 ? "" : "es"}` : ""}`
            : "No 3D models";
        const contentSummary = skydome
            ? `${gaussianSummary} · Skydome ${skydome.visible === false ? "hidden" : "visible"}`
            : objects.length
                ? gaussianSummary
                : "No objects in this scene.";
        const architectureSummary = wallCount || roomCount
            ? `${contentSummary} · ${wallCount} standalone walls · ${roomCount} rooms`
            : contentSummary;
        this.els.sceneSummary.textContent = [
            architectureSummary,
            cameraCount ? `${cameraCount} camera${cameraCount === 1 ? "" : "s"}` : "",
            lightCount ? `${lightCount} light${lightCount === 1 ? "" : "s"}` : "",
        ].filter(Boolean).join(" · ");
    }

    _hasRenderableScene() {
        return Boolean(
            this.scene?.objects?.length
            || this.scene?.architecture?.walls?.length
            || this.scene?.architecture?.rooms?.length
            || (this.scene?.skydome && this.scene.skydome.visible !== false),
        );
    }

    _selectSkydome() {
        if (!this.scene?.skydome) {
            this.selectedSkydome = false;
            return;
        }
        this.selectedGroupId = "";
        this.selectedObjectIds.clear();
        this.selectedObjectId = "";
        this.selectedArchitecture = null;
        this.selectedArchitectureItems.clear();
        this.selectedCameraKeyframeId = "";
        this.selectedCameraId = "";
        this.selectedCameraIds.clear();
        this.selectedLightId = "";
        this.viewer.selectLightMarker("");
        this.viewer.setArchitectureSelection(null);
        this.viewer.select("");
        this.selectedSkydome = true;
        this._syncSelectionPresentation();
        this._renderInspector();
        this._syncToolbar();
        this._scheduleStateSave();
    }

    _clearSelection() {
        this.selectedObjectId = "";
        this.selectedObjectIds.clear();
        this.selectedGroupId = "";
        this.selectedSkydome = false;
        this.selectedArchitecture = null;
        this.selectedArchitectureItems.clear();
        this.selectedCameraId = "";
        this.selectedCameraIds.clear();
        this.selectedLightId = "";
        this.selectedCameraKeyframeId = "";
        this.viewer.setArchitectureSelection(null);
        this.viewer.select("");
        this.viewer.selectLightMarker("");
        this._syncSelectionPresentation();
        this._renderCameras();
        this._renderCameraTracks();
        this._renderInspector();
        this._syncToolbar();
        this._scheduleStateSave(0);
    }

    _selectObject(objectId, { fromViewer = false, additive = false } = {}) {
        const valid = this.scene?.objects?.some(item => item.object_id === objectId)
            ? objectId
            : "";
        if (fromViewer && !valid && !additive) return;
        this.selectedSkydome = false;
        this.selectedLightId = "";
        this.viewer.selectLightMarker("");
        const selectedItem = this.scene?.objects?.find(item => item.object_id === valid);
        const selectedBuildingId = this._validBuildingId(selectedItem?.building_id);
        if (selectedBuildingId) this.editorView.active_building_id = selectedBuildingId;
        this.selectedGroupId = "";
        this.selectedCameraKeyframeId = "";
        if (!additive) {
            this.selectedCameraId = "";
            this.selectedCameraIds.clear();
        }
        if (!additive) {
            this.selectedArchitectureItems.clear();
            this.selectedArchitecture = null;
            this.selectedObjectIds = new Set(valid ? [valid] : []);
        } else if (valid) {
            if (!fromViewer && this.selectedObjectIds.has(valid)) this.selectedObjectIds.delete(valid);
            else this.selectedObjectIds.add(valid);
        }
        this.selectedObjectId = valid && this.selectedObjectIds.has(valid)
            ? valid
            : Array.from(this.selectedObjectIds).at(-1) || "";
        if (!fromViewer) this.viewer.select(this.selectedObjectId, { additive });
        this.viewer.setArchitectureSelection(
            this.selectedArchitecture,
            this._selectedArchitectureRefs(),
        );
        this._syncSelectionPresentation();
        this._renderInspector();
        this._syncToolbar();
        if (valid && fromViewer && !additive) this._setWorkspaceTab("right", "inspector");
        this._scheduleStateSave();
    }

    _selectGroup(groupId) {
        const group = this._groupById(groupId);
        this.selectedSkydome = false;
        this.selectedArchitecture = null;
        this.selectedArchitectureItems.clear();
        this.selectedCameraKeyframeId = "";
        this.selectedCameraId = "";
        this.selectedCameraIds.clear();
        this.selectedLightId = "";
        this.viewer.selectLightMarker("");
        this.viewer.setArchitectureSelection(null);
        this.selectedGroupId = group?.group_id || "";
        const firstObject = group?.children?.length
            ? this.scene?.objects?.find(item => item.object_id === group.children[0])
            : null;
        const selectedBuildingId = this._validBuildingId(firstObject?.building_id);
        if (selectedBuildingId) this.editorView.active_building_id = selectedBuildingId;
        this.selectedObjectIds.clear();
        this.selectedObjectId = "";
        if (group) this.viewer.selectGroup(group.group_id, group.children);
        else this.viewer.select("");
        this._syncSelectionPresentation();
        this._renderInspector();
        this._syncToolbar();
        this._scheduleStateSave();
    }

    _syncSelectionControls() {
        const modelCount = this.selectedObjectIds.size;
        const count = modelCount
            + this._selectedArchitectureRefs().length
            + this.selectedCameraIds.size
            + (this.selectedLightId ? 1 : 0);
        this.els.groupSelected.disabled = modelCount < 2 || count !== modelCount;
        this.els.selectionCount.textContent = count
            ? `${count} selected`
            : this.selectedSkydome
                ? "Skydome selected"
            : this.selectedGroupId
                ? "Group selected"
                : this.selectedLightId
                    ? "Light selected"
                    : "Shift-click to select multiple";
    }

    _syncSelectionPresentation() {
        this.viewer?.setObjectSelectionHighlights?.(
            Array.from(this.selectedObjectIds),
            this.selectedObjectId,
        );
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
        for (const card of this.els.objectList.querySelectorAll("[data-light-id]")) {
            const selected = card.dataset.lightId === this.selectedLightId;
            card.classList.toggle("is-selected", selected);
            card.classList.toggle("is-primary", selected);
        }
        this._syncSelectionControls();
    }

    _renderObjects() {
        this.viewer?.setObjectSelectionHighlights?.(
            Array.from(this.selectedObjectIds),
            this.selectedObjectId,
        );
        const previousScrollTop = this.els.objectList.scrollTop;
        const previousScrollLeft = this.els.objectList.scrollLeft;
        const query = this.els.objectSearch.value.trim().toLowerCase();
        const objects = new Map((this.scene?.objects || []).map(item => [item.object_id, item]));
        const lights = this.lighting?.lights || [];
        const skydome = this.scene?.skydome || null;
        const layers = this._normalizeSceneLayers();
        this.els.objectList.replaceChildren();
        const fragment = document.createDocumentFragment();
        this._syncSelectionControls();
        let rendered = 0;
        for (const entry of this._createArchitectureTree(query)) {
            fragment.appendChild(entry);
            rendered += 1;
        }
        for (const light of lights) {
            const searchable = `${light.name || "Point light"} point light ${light.color || ""}`.toLowerCase();
            if (query && !searchable.includes(query)) continue;
            fragment.appendChild(this._createLightCard(light));
            rendered += 1;
        }
        if (skydome && (!query || skydome.name.toLowerCase().includes(query) || "skydome background environment".includes(query))) {
            fragment.appendChild(this._createSkydomeCard(skydome));
            rendered += 1;
        }
        if (!objects.size && !lights.length && !skydome && !rendered) {
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
        this.els.objectList.scrollTop = previousScrollTop;
        this.els.objectList.scrollLeft = previousScrollLeft;
    }

    _createArchitectureTree(query = "") {
        const architecture = this.scene?.architecture;
        if (!architecture) return [];
        const output = [];
        const activeLevelId = this.editorView.active_level_id;
        const openingsByWall = new Map();
        for (const opening of architecture.openings || []) {
            if (!openingsByWall.has(opening.wall_id)) openingsByWall.set(opening.wall_id, []);
            openingsByWall.get(opening.wall_id).push(opening);
        }
        const createRow = (type, id, name, meta) => {
            const row = element(
                "button",
                `vnccs-i3s__architecture-row${
                    this._isArchitectureSelected(type, id)
                        ? " is-selected"
                        : ""
                }`,
            );
            row.type = "button";
            row.dataset.architectureType = type;
            row.dataset.architectureId = id;
            row.innerHTML = `<span class="vnccs-i3s__architecture-kind">${escapeHTML(type.slice(0, 1).toUpperCase())}</span><span class="vnccs-i3s__architecture-copy"><b></b><small></small></span>`;
            row.querySelector("b").textContent = name;
            row.querySelector("small").textContent = meta;
            row.addEventListener("click", event => this._selectArchitecture(
                { type, id },
                { additive: event.shiftKey },
            ));
            return row;
        };
        const rootWalls = (architecture.walls || []).filter(
            item => !item.building_id && item.level_id === activeLevelId,
        );
        const rootRooms = (architecture.rooms || []).filter(
            item => !item.building_id && item.level_id === activeLevelId,
        );
        const rootRoomWallIds = new Set(rootRooms.flatMap(room => room.wall_ids || []));
        const rootStandaloneWalls = rootWalls.filter(wall => !rootRoomWallIds.has(wall.wall_id));
        const rootEntries = [
            ...rootRooms.map(item => ({
                type: "room",
                id: item.room_id,
                name: item.name || "Room",
                meta: `Complete room · walls, floor and ceiling${item.locked ? " · Locked" : ""}${item.visible === false ? " · Hidden" : ""}`,
            })),
            ...rootStandaloneWalls.map(item => ({
                type: "wall",
                id: item.wall_id,
                name: item.name || "Wall",
                meta: `${Math.hypot(item.end[0] - item.start[0], item.end[1] - item.start[1]).toFixed(2)} m${item.locked ? " · Locked" : ""}${item.visible === false ? " · Hidden" : ""}`,
            })),
            ...rootWalls.flatMap(wall => openingsByWall.get(wall.wall_id) || []).map(item => ({
                type: "opening",
                id: item.opening_id,
                name: item.name || "Opening",
                meta: `${item.kind} · ${Number(item.width).toFixed(2)} m${item.locked ? " · Locked" : ""}${item.visible === false ? " · Hidden" : ""}`,
            })),
        ].filter(item => !query || `${item.name} ${item.type} ${item.meta}`.toLowerCase().includes(query));
        if (rootEntries.length) {
            const wrapper = element("section", "vnccs-i3s__architecture-group");
            const heading = element("div", "vnccs-i3s__architecture-row is-building is-root");
            heading.innerHTML = `<span class="vnccs-i3s__architecture-kind">A</span><span class="vnccs-i3s__architecture-copy"><b></b><small></small></span>`;
            heading.querySelector("b").textContent = "Architecture";
            heading.querySelector("small").textContent = `${rootRooms.length} rooms · ${rootStandaloneWalls.length} standalone walls`;
            const children = element("div", "vnccs-i3s__architecture-children");
            for (const entry of rootEntries) {
                children.appendChild(createRow(entry.type, entry.id, entry.name, entry.meta));
            }
            wrapper.append(heading, children);
            output.push(wrapper);
        }
        for (const building of architecture.buildings || []) {
            const walls = (architecture.walls || []).filter(
                item => item.building_id === building.building_id && item.level_id === activeLevelId,
            );
            const rooms = (architecture.rooms || []).filter(
                item => item.building_id === building.building_id && item.level_id === activeLevelId,
            );
            const roomWallIds = new Set(rooms.flatMap(room => room.wall_ids || []));
            const standaloneWalls = walls.filter(wall => !roomWallIds.has(wall.wall_id));
            const openings = walls.flatMap(wall => openingsByWall.get(wall.wall_id) || []);
            const assignedObjects = (this.scene?.objects || []).filter(
                item => item.building_id === building.building_id,
            ).length;
            const assignedCameras = (this.scene?.cameras || []).filter(
                item => item.building_id === building.building_id,
            ).length;
            const assignedLights = (this.lighting?.lights || []).filter(
                item => item.building_id === building.building_id,
            ).length;
            const assignedPaths = (this.scene?.camera_tracks || []).filter(
                item => item.building_id === building.building_id,
            ).length;
            const entries = [
                ...rooms.map(item => ({ type: "room", id: item.room_id, name: item.name || "Room", meta: `Complete room · walls, floor and ceiling${item.locked ? " · Locked" : ""}${item.visible === false ? " · Hidden" : ""}` })),
                ...standaloneWalls.map(item => ({ type: "wall", id: item.wall_id, name: item.name || "Wall", meta: `${Math.hypot(item.end[0] - item.start[0], item.end[1] - item.start[1]).toFixed(2)} m${item.locked ? " · Locked" : ""}${item.visible === false ? " · Hidden" : ""}` })),
                ...openings.map(item => ({ type: "opening", id: item.opening_id, name: item.name || "Opening", meta: `${item.kind} · ${Number(item.width).toFixed(2)} m${item.locked ? " · Locked" : ""}${item.visible === false ? " · Hidden" : ""}` })),
            ].filter(item => !query || `${item.name} ${item.type} ${item.meta}`.toLowerCase().includes(query));
            if (query && !building.name.toLowerCase().includes(query) && !entries.length) continue;
            const wrapper = element("section", "vnccs-i3s__architecture-group");
            const heading = createRow(
                "building",
                building.building_id,
                building.name || "Building",
                `${standaloneWalls.length} standalone walls · ${rooms.length} rooms · ${assignedObjects} objects · ${assignedCameras} cameras · ${assignedPaths} paths · ${assignedLights} lights${building.locked ? " · Locked" : ""}${building.visible === false ? " · Hidden" : ""}`,
            );
            heading.classList.add("is-building");
            const children = element("div", "vnccs-i3s__architecture-children");
            for (const entry of entries) {
                children.appendChild(createRow(entry.type, entry.id, entry.name, entry.meta));
            }
            if (!entries.length && !query) {
                children.appendChild(element("div", "vnccs-i3s__group-empty", "Draw walls or a room in Plan view"));
            }
            wrapper.append(heading, children);
            output.push(wrapper);
        }
        return output;
    }

    _createLightCard(light) {
        const selected = light.light_id === this.selectedLightId;
        const card = element(
            "div",
            `vnccs-i3s__object vnccs-i3s__light-object`
                + `${selected ? " is-selected is-primary" : ""}`
                + `${light.visible === false ? " is-hidden" : ""}`,
        );
        card.tabIndex = 0;
        card.dataset.lightId = light.light_id;
        const thumbnail = element("span", "vnccs-i3s__object-thumb vnccs-i3s__light-thumb");
        thumbnail.innerHTML = ICONS.sun;
        thumbnail.style.color = light.color || "#ffffff";
        const copy = element("div", "vnccs-i3s__object-copy");
        copy.append(
            element("div", "vnccs-i3s__object-name", light.name || "Point light"),
            element(
                "div",
                "vnccs-i3s__object-meta",
                `Point light · ${Number(light.intensity).toFixed(2)} strength`
                    + `${light.visible === false ? " · Hidden" : ""}`,
            ),
        );
        const actions = element("div", "vnccs-i3s__object-actions");
        const visibility = button(
            "vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__icon-button",
            "",
            light.visible === false ? "eyeOff" : "eye",
        );
        visibility.title = light.visible === false ? "Show light" : "Hide light";
        visibility.addEventListener("click", event => {
            event.stopPropagation();
            const before = this._captureEditorSnapshot();
            light.visible = light.visible === false;
            this.history.push("Toggle light visibility", before, this._captureEditorSnapshot());
            this._commitLighting({ final: true });
            this._renderObjects();
            this._renderInspector();
            this._updateSceneSummary();
        });
        const duplicate = button(
            "vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__icon-button",
            "",
            "duplicate",
        );
        duplicate.title = "Duplicate light";
        duplicate.addEventListener("click", event => {
            event.stopPropagation();
            this._duplicateLight(light.light_id);
        });
        const remove = button(
            "vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__button--danger vnccs-i3s__icon-button",
            "",
            "trash",
        );
        remove.title = "Delete light";
        remove.addEventListener("click", event => {
            event.stopPropagation();
            this._deleteLight(light.light_id);
        });
        for (const control of [visibility, duplicate, remove]) {
            control.setAttribute("aria-label", control.title);
            control.addEventListener("dblclick", event => event.stopPropagation());
        }
        actions.append(visibility, duplicate, remove);
        card.append(thumbnail, copy, actions);
        const select = () => this._selectLight(light.light_id);
        card.addEventListener("click", event => {
            if (!event.target.closest("button,input")) select();
        });
        card.addEventListener("keydown", event => {
            if (event.target === card && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                select();
            }
        });
        return card;
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
                const before = this._captureEditorSnapshot();
                skydome.name = next;
                this._syncSkydome();
                this._renderObjects();
                this._commitSkydome({ final: true });
                this.history.push("Rename skydome", before, this._captureEditorSnapshot());
                this._syncToolbar();
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
            const before = this._captureEditorSnapshot();
            skydome.visible = skydome.visible === false;
            this._syncSkydome();
            this._commitSkydome({ final: true });
            this._updateSceneSummary();
            this._renderObjects();
            this.history.push("Toggle skydome visibility", before, this._captureEditorSnapshot());
            this._syncToolbar();
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
                const before = this._captureEditorSnapshot();
                item.name = next;
                this.viewer.updateObject(item.object_id, { name: next });
                this.history.push("Rename object", before, this._captureEditorSnapshot());
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
        const importedModel = item.asset_kind === "mesh";
        const levelName = this.scene?.levels?.find(level => level.level_id === item.level_id)?.name || "";
        const buildingName = this.scene?.architecture?.buildings?.find(
            building => building.building_id === item.building_id,
        )?.name || "";
        copy.append(
            name,
            element(
                "div",
                "vnccs-i3s__object-meta",
                [
                    viewportFailure ? "Viewport failed" : "",
                    importedModel
                        ? `${String(item.source?.format || "3D").toUpperCase()} model`
                        : `${Number(item.gaussians || 0).toLocaleString()} splats`,
                    importedPly ? "Imported PLY" : "",
                    buildingName,
                    levelName,
                    item.locked ? "Locked" : "",
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
            const before = this._captureEditorSnapshot();
            item.visible = item.visible === false;
            this.viewer.applySceneVisibility(this.scene);
            this.history.push("Toggle object visibility", before, this._captureEditorSnapshot());
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
        exportObject.title = importedModel ? "Download source model" : "Export transformed PLY";
        exportObject.addEventListener("click", event => {
            event.stopPropagation();
            if (importedModel) download(item.urls.model);
            else void this.exportObject(item, exportObject);
        });
        const saveModel = button(
            "vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__icon-button",
            "",
            "library",
        );
        saveModel.title = "Save model to library";
        saveModel.addEventListener("click", event => {
            event.stopPropagation();
            this.openSaveLibraryModal("object", item.object_id);
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
        for (const control of [visibility, exportObject, saveModel, duplicate, remove]) {
            control.setAttribute("aria-label", control.title);
            control.addEventListener("dblclick", event => event.stopPropagation());
        }
        actions.append(visibility, exportObject, saveModel, duplicate, remove);
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
                const before = this._captureEditorSnapshot();
                group.name = next;
                this.history.push("Rename group", before, this._captureEditorSnapshot());
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
            const before = this._captureEditorSnapshot();
            const nextVisible = group.visible === false;
            group.visible = nextVisible;
            this.viewer.setGroupVisibility(
                group.group_id,
                group.children,
                nextVisible,
                this.scene,
            );
            this.history.push("Toggle group visibility", before, this._captureEditorSnapshot());
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
        const before = this._captureEditorSnapshot();
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
        this.history.push("Reorder scene hierarchy", before, this._captureEditorSnapshot());
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
        const selectedBuildings = new Set(
            this.scene.objects
                .filter(item => this.selectedObjectIds.has(item.object_id))
                .map(item => this._validBuildingId(item.building_id)),
        );
        if (selectedBuildings.size > 1) {
            this.toast("Assign selected objects to one building before grouping them.", "info");
            return;
        }
        const before = this._captureEditorSnapshot();
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
        this.editorView.active_building_id = selectedBuildings.values().next().value
            || this.editorView.active_building_id;
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
        this.history.push("Group objects", before, this._captureEditorSnapshot());
        this._updateSceneSummary();
        this._renderObjects();
        this._renderInspector();
        this._syncToolbar();
        this._scheduleSceneSave(0);
        this._scheduleStateSave(0);
    }

    ungroupObjects(groupId) {
        const before = this._captureEditorSnapshot();
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
        this.history.push("Ungroup objects", before, this._captureEditorSnapshot());
        this._updateSceneSummary();
        this._renderObjects();
        this._syncSelectionPresentation();
        this._renderInspector();
        this._syncToolbar();
        this._scheduleSceneSave(0);
        this._scheduleStateSave(0);
    }

    _onViewerTransform(objectId, transform, options = {}) {
        const item = this.scene?.objects?.find(value => value.object_id === objectId);
        if (!item) return;
        if (options.cancelled) {
            item.transform = transform;
            if (options.command_last !== false) {
                this._viewerTransformHistoryBefore = null;
                this._renderInspector();
            }
            this._scheduleSceneSave(0);
            this._scheduleStateSave(0);
            this._scheduleScenePreview(120);
            return;
        }
        if (!this._suppressViewerTransformHistory && !this._viewerTransformHistoryBefore) {
            this._viewerTransformHistoryBefore = this._captureEditorSnapshot();
            for (const [previousId, previousTransform] of Object.entries(options.previous_transforms || {})) {
                const previousItem = this._viewerTransformHistoryBefore?.objects?.find(value => value.object_id === previousId);
                if (previousItem && previousTransform) previousItem.transform = previousTransform;
            }
        }
        item.transform = transform;
        if (!this._suppressViewerTransformHistory && options.final && options.command_last !== false) {
            this.history.push(
                "Transform object",
                this._viewerTransformHistoryBefore,
                this._captureEditorSnapshot(),
            );
            this._viewerTransformHistoryBefore = null;
            this._renderInspector();
        }
        this._scheduleSceneSave(options.final ? 0 : 160);
        this._scheduleStateSave(options.final ? 0 : 160);
        this._scheduleScenePreview(options.final ? 120 : 420);
    }

    _scenePayload() {
        const camera = this.selectedCameraId
            ? this.scene?.camera
            : this.viewer?.getCameraState?.() || this.viewerState.camera;
        return {
            base_edit_revision: Math.max(0, Number(this.scene?.edit_revision) || 0),
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
            camera_tracks: JSON.parse(JSON.stringify(this.scene?.camera_tracks || [])),
            levels: normalizedLevels(this.scene?.levels).map(level => ({ ...level })),
            architecture: JSON.parse(JSON.stringify(normalizedArchitecture(
                this.scene?.architecture,
                normalizedLevels(this.scene?.levels),
            ))),
            objects: (this.scene?.objects || []).map(item => ({
                object_id: item.object_id,
                name: item.name,
                level_id: item.level_id,
                transform: item.transform,
                visible: item.visible !== false,
                ...normalizedObjectEditorProperties(item),
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
        const operation = this._sceneSaveSerial.then(async () => {
            const payload = this._scenePayload();
            const updated = await this._fetchJSON(ENDPOINTS.scene(sceneId), {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            if (this.sceneId === sceneId && this.scene) {
                this.scene.revision = updated.revision;
                this.scene.render_revision = updated.render_revision;
                this.scene.edit_revision = updated.edit_revision;
                this.scene.updated_at = updated.updated_at;
                this.scene.exports = updated.exports;
                // The PATCH payload was captured before awaiting the server.
                // Replacing live editor collections here invalidates every
                // Inspector closure and can also overwrite input made while
                // the request was in flight. The client already normalizes
                // these values when building the payload; only server-owned
                // revision/export metadata is merged into the live scene.
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
            if (showError) {
                if (error.status === 409) {
                    this._showError(
                        "Scene changed elsewhere",
                        new Error("Reload the scene before saving to avoid overwriting newer edits."),
                    );
                } else {
                    this._showError("Scene save failed", error);
                }
            }
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

    async importModel(files) {
        if (!Array.isArray(files) || !files.length || this.currentJobId || this.importingPly) return;
        const modelPattern = /\.(glb|gltf|fbx|obj|stl)$/i;
        const resourcePattern = /\.(mtl|bin|png|jpe?g|webp|bmp|gif|tga)$/i;
        const archives = files.filter(file => /\.zip$/i.test(String(file.name || "")));
        const modelFiles = files.filter(file => modelPattern.test(String(file.name || "")));
        if (archives.length) {
            if (files.length !== 1) {
                this.toast("Import a ZIP model package by itself.", "error");
                return;
            }
        } else if (!modelFiles.length) {
            this.toast("Choose a GLB, glTF, FBX, OBJ, or STL model.", "error");
            return;
        }
        if (!archives.length && files.some(file => !modelPattern.test(file.name || "") && !resourcePattern.test(file.name || ""))) {
            this.toast("The selection contains an unsupported model resource.", "error");
            return;
        }
        const totalBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
        if (!totalBytes || totalBytes > MAX_MODEL_TOTAL_BYTES || files.some(file => file.size > MAX_PLY_BYTES)) {
            this.toast(`Model packages must be smaller than ${formatBytes(MAX_MODEL_TOTAL_BYTES)}.`, "error");
            return;
        }
        const priority = ["glb", "gltf", "fbx", "obj", "stl"];
        const main = modelFiles.sort((left, right) => {
            const leftFormat = String(left.name).split(".").at(-1).toLowerCase();
            const rightFormat = String(right.name).split(".").at(-1).toLowerCase();
            return priority.indexOf(leftFormat) - priority.indexOf(rightFormat);
        })[0] || archives[0];
        this.importingPly = true;
        this.els.plyImport.disabled = true;
        this._setStatus("Importing 3D model", "working");
        try {
            if (!this.sceneId) await this.ensureScene();
            const sceneId = this.sceneId;
            const form = new FormData();
            const paths = [];
            for (const file of files) {
                const path = String(file.webkitRelativePath || file.name || "asset").replace(/\\/g, "/");
                paths.push(path);
                form.append("files", file, file.name || "asset");
            }
            form.append("paths", JSON.stringify(paths));
            form.append("main_path", String(main?.webkitRelativePath || main?.name || ""));
            form.append("name", objectNameFromFileName(main?.name || "Imported model"));
            const result = await this._fetchJSON(ENDPOINTS.importModel(sceneId), {
                method: "POST",
                body: form,
            });
            if (this.sceneId !== sceneId) {
                this._setStatus("3D model imported", "success");
                this.toast("The model was added to the scene where the import started.", "success");
                return;
            }
            await this._applyScene(result.scene, { preserveSource: true });
            this._selectObject(result.object_id);
            if (this.viewportFailures.has(result.object_id)) {
                this._setStatus("Imported; preview failed", "error");
                this.toast("The model was saved, but the viewport could not render it.", "error");
                return;
            }
            this.viewer.fit(result.object_id);
            this._scheduleScenePreview(120);
            this._scheduleStateSave(0);
            this._setStatus("3D model imported", "success");
            this.toast("Model and textures added to the active scene.", "success");
        } catch (error) {
            this._setStatus("3D model import failed", "error");
            this._showError("3D model could not be imported", error);
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
                            this._placeNewObjectOnActiveFloor(generatedObjectId);
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
        const visibleIds = this._effectiveVisibleObjectIds();
        const hasGaussian = (this.scene?.objects || []).some(
            item => item.asset_kind !== "mesh" && visibleIds.has(item.object_id),
        );
        if (!hasGaussian) {
            this.toast("Show at least one Gaussian object before exporting PLY.", "error");
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

    async exportPanorama() {
        if (this.exportingPanorama) return;
        if (this.currentJobId) {
            this.toast("Wait for the current 3D Factory job before exporting a panorama.", "info");
            return;
        }
        const camera = this.scene?.cameras?.find(
            value => value.camera_id === this.panoramaCameraId,
        );
        if (!camera) {
            this.toast("Choose a saved camera for the 360° panorama.", "error");
            return;
        }
        this.exportingPanorama = true;
        this._syncPanoramaExportControls();
        this._setStatus("Rendering 360° panorama", "working");
        this._setProgress(true, 2, "Preparing panorama", camera.name || "Saved camera");
        try {
            const blob = await this.viewer.capturePanorama({
                width: this.panoramaWidth,
                cameraState: camera,
                onProgress: ({ stage, progress, detail }) => {
                    this._setProgress(true, progress, stage, detail);
                },
            });
            const baseName = `${this.scene?.name || "scene"}-${camera.name || "camera"}-360`
                .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]+/g, "-")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 140)
                || "vnccs-3d-factory-360";
            downloadBlob(blob, `${baseName}.png`);
            this._setStatus("360° panorama exported", "success");
            this.toast(`360° panorama exported from ${camera.name || "saved camera"}.`, "success");
        } catch (error) {
            this._setStatus("Panorama export failed", "error");
            this._showError("360° panorama export failed", error);
        } finally {
            this.exportingPanorama = false;
            this._setProgress(false);
            this._syncPanoramaExportControls();
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

    _copySelection() {
        if (!this.scene) return;
        const clone = value => JSON.parse(JSON.stringify(value));
        const objectIds = new Set(this.selectedObjectIds);
        const selectedGroup = this._groupById(this.selectedGroupId);
        for (const objectId of selectedGroup?.children || []) objectIds.add(objectId);
        const architecture = this.scene.architecture || {};
        const buildings = new Map();
        const rooms = new Map();
        const walls = new Map();
        const openings = new Map();
        const addWall = wall => {
            if (!wall || walls.has(wall.wall_id)) return;
            walls.set(wall.wall_id, clone(wall));
            for (const opening of architecture.openings || []) {
                if (opening.wall_id === wall.wall_id) openings.set(opening.opening_id, clone(opening));
            }
        };
        const addRoom = room => {
            if (!room || rooms.has(room.room_id)) return;
            rooms.set(room.room_id, clone(room));
            for (const wallId of room.wall_ids || []) {
                addWall(architecture.walls?.find(wall => wall.wall_id === wallId));
            }
        };
        const architectureSelection = this._selectedArchitectureRefs();
        for (const selection of architectureSelection) {
            if (selection.type === "building") {
                const building = architecture.buildings?.find(item => item.building_id === selection.id);
                if (!building) continue;
                buildings.set(building.building_id, clone(building));
                for (const room of architecture.rooms || []) {
                    if (room.building_id === building.building_id) addRoom(room);
                }
                for (const wall of architecture.walls || []) {
                    if (wall.building_id === building.building_id) addWall(wall);
                }
            } else if (selection.type === "room") {
                addRoom(architecture.rooms?.find(item => item.room_id === selection.id));
            } else if (selection.type === "wall") {
                addWall(architecture.walls?.find(item => item.wall_id === selection.id));
            } else if (selection.type === "opening") {
                const opening = architecture.openings?.find(item => item.opening_id === selection.id);
                if (opening) openings.set(opening.opening_id, clone(opening));
            }
        }
        const objects = (this.scene.objects || [])
            .filter(item => objectIds.has(item.object_id))
            .map(item => ({
                object_id: item.object_id,
                name: item.name,
                level_id: item.level_id,
                building_id: item.building_id,
                transform: clone(item.transform || {
                    position: [0, 0, 0],
                    rotation: [0, 0, 0],
                    scale: 1,
                }),
            }));
        const cameraIds = this.selectedCameraIds.size
            ? this.selectedCameraIds
            : new Set(this.selectedCameraId ? [this.selectedCameraId] : []);
        const cameras = (this.scene.cameras || [])
            .filter(item => cameraIds.has(item.camera_id))
            .map(clone);
        const lights = (this.lighting?.lights || [])
            .filter(item => item.light_id === this.selectedLightId)
            .map(clone);
        const total = objects.length + architectureSelection.length + cameras.length + lights.length;
        if (!total) {
            this.toast("Select at least one scene object to copy.", "info");
            return;
        }
        this.selectionClipboard = {
            scene_id: this.sceneId,
            paste_count: 0,
            objects,
            buildings: Array.from(buildings.values()),
            rooms: Array.from(rooms.values()),
            walls: Array.from(walls.values()),
            openings: Array.from(openings.values()),
            cameras,
            lights,
            architecture_selection: clone(architectureSelection),
        };
        this._syncToolbar();
        this.toast(`${total} scene object${total === 1 ? "" : "s"} copied.`, "success");
    }

    async _pasteSelection() {
        const clipboard = this.selectionClipboard;
        if (!this.scene || !clipboard) return;
        if (clipboard.scene_id !== this.sceneId) {
            this.toast("The Factory clipboard currently belongs to another scene.", "error");
            return;
        }
        const plannedWalls = clipboard.walls?.length || 0;
        const plannedRooms = clipboard.rooms?.length || 0;
        const plannedOpenings = clipboard.openings?.length || 0;
        const plannedCameras = clipboard.cameras?.length || 0;
        const plannedLights = clipboard.lights?.length || 0;
        if ((this.scene.architecture?.walls?.length || 0) + plannedWalls > 4096) {
            this.toast("There is not enough room in the scene wall limit for this paste.", "error");
            return;
        }
        if ((this.scene.architecture?.rooms?.length || 0) + plannedRooms > 1024) {
            this.toast("There is not enough room in the scene room limit for this paste.", "error");
            return;
        }
        if ((this.scene.architecture?.openings?.length || 0) + plannedOpenings > 4096) {
            this.toast("There is not enough room in the scene opening limit for this paste.", "error");
            return;
        }
        if ((this.scene.cameras?.length || 0) + plannedCameras > 32) {
            this.toast("There is not enough room in the 32-camera limit for this paste.", "error");
            return;
        }
        if ((this.lighting?.lights?.length || 0) + plannedLights > 32) {
            this.toast("There is not enough room in the 32-light limit for this paste.", "error");
            return;
        }
        const pasteIndex = Math.max(1, Number(clipboard.paste_count) + 1);
        clipboard.paste_count = pasteIndex;
        const step = Math.max(0.5, Number(this.editorView.plan_grid?.step) || 0.1);
        const offset = step * pasteIndex;
        const pastedObjectIds = [];
        const pastedObjectSources = [];
        this.els.selectionPaste.disabled = true;
        this._setStatus("Pasting selection", "working");
        try {
            for (const source of clipboard.objects || []) {
                const result = await this._fetchJSON(
                    `${ENDPOINTS.scene(this.sceneId)}/objects/${encodeURIComponent(source.object_id)}/duplicate`,
                    { method: "POST" },
                );
                await this._applyScene(result.scene, { preserveSource: true });
                const pasted = this.scene.objects?.find(item => item.object_id === result.object_id);
                if (!pasted) continue;
                pastedObjectIds.push(pasted.object_id);
                pastedObjectSources.push({ object_id: pasted.object_id, source });
            }
            for (const entry of pastedObjectSources) {
                const pasted = this.scene.objects?.find(item => item.object_id === entry.object_id);
                if (!pasted) continue;
                pasted.transform = JSON.parse(JSON.stringify(entry.source.transform));
                pasted.transform.position = Array.isArray(pasted.transform?.position)
                    ? [...pasted.transform.position]
                    : [0, 0, 0];
                pasted.transform.position[0] += offset;
                pasted.transform.position[2] += offset;
                pasted.level_id = entry.source.level_id;
                pasted.building_id = this._validBuildingId(entry.source.building_id);
                this.viewer.updateObject(pasted.object_id, pasted);
            }

            const beforeArchitecture = this._captureEditorSnapshot();
            const buildingIds = new Map();
            const wallIds = new Map();
            const roomIds = new Map();
            const openingIds = new Map();
            for (const source of clipboard.buildings || []) buildingIds.set(source.building_id, factoryId());
            for (const source of clipboard.walls || []) wallIds.set(source.wall_id, factoryId());
            for (const source of clipboard.rooms || []) roomIds.set(source.room_id, factoryId());
            for (const source of clipboard.openings || []) openingIds.set(source.opening_id, factoryId());
            for (const source of clipboard.buildings || []) {
                this.scene.architecture.buildings.push({
                    ...JSON.parse(JSON.stringify(source)),
                    building_id: buildingIds.get(source.building_id),
                    name: `${source.name || "Building"} copy`,
                    position: [
                        (Number(source.position?.[0]) || 0) + offset,
                        Number(source.position?.[1]) || 0,
                        (Number(source.position?.[2]) || 0) + offset,
                    ],
                });
            }
            for (const source of clipboard.walls || []) {
                const buildingCopied = buildingIds.has(source.building_id);
                const shift = buildingCopied ? 0 : offset;
                this.scene.architecture.walls.push({
                    ...JSON.parse(JSON.stringify(source)),
                    wall_id: wallIds.get(source.wall_id),
                    building_id: buildingIds.get(source.building_id) || source.building_id || "",
                    name: `${source.name || "Wall"} copy`,
                    start: [source.start[0] + shift, source.start[1] + shift],
                    end: [source.end[0] + shift, source.end[1] + shift],
                });
            }
            for (const source of clipboard.rooms || []) {
                const buildingCopied = buildingIds.has(source.building_id);
                const shift = buildingCopied ? 0 : offset;
                this.scene.architecture.rooms.push({
                    ...JSON.parse(JSON.stringify(source)),
                    room_id: roomIds.get(source.room_id),
                    building_id: buildingIds.get(source.building_id) || source.building_id || "",
                    name: `${source.name || "Room"} copy`,
                    wall_ids: (source.wall_ids || []).map(id => wallIds.get(id) || id),
                    polygon: (source.polygon || []).map(point => [point[0] + shift, point[1] + shift]),
                });
            }
            for (const source of clipboard.openings || []) {
                const pastedWallId = wallIds.get(source.wall_id);
                const opening = {
                    ...JSON.parse(JSON.stringify(source)),
                    opening_id: openingIds.get(source.opening_id),
                    wall_id: pastedWallId || source.wall_id,
                    name: `${source.name || "Opening"} copy`,
                };
                if (!pastedWallId) {
                    const wall = this.scene.architecture.walls?.find(item => item.wall_id === source.wall_id);
                    const length = wall ? Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]) : 0;
                    const fitted = length > 0.001
                        ? this._fitOpeningOnWall(
                            wall,
                            Math.min(0.99, Number(opening.offset) + offset / length),
                            opening.width,
                            opening.opening_id,
                        )
                        : null;
                    if (!fitted) {
                        openingIds.delete(source.opening_id);
                        continue;
                    }
                    opening.offset = fitted.offset;
                    opening.width = fitted.width;
                }
                this.scene.architecture.openings.push(opening);
            }
            const pastedCameraIds = [];
            for (const source of clipboard.cameras || []) {
                const camera = {
                    ...JSON.parse(JSON.stringify(source)),
                    camera_id: factoryId(),
                    name: `${source.name || "Camera"} copy`,
                    created_at: Date.now() / 1000,
                    building_id: buildingIds.get(source.building_id) || source.building_id || "",
                    position: [source.position[0] + offset, source.position[1], source.position[2] + offset],
                    target: [source.target[0] + offset, source.target[1], source.target[2] + offset],
                };
                this.scene.cameras.push(camera);
                pastedCameraIds.push(camera.camera_id);
            }
            const pastedLightIds = [];
            for (const source of clipboard.lights || []) {
                const light = {
                    ...JSON.parse(JSON.stringify(source)),
                    light_id: factoryId(),
                    name: `${source.name || "Point light"} copy`,
                    building_id: buildingIds.get(source.building_id) || source.building_id || "",
                    position: [source.position[0] + offset, source.position[1], source.position[2] + offset],
                    target: [source.target[0] + offset, source.target[1], source.target[2] + offset],
                };
                this.lighting.lights.push(light);
                pastedLightIds.push(light.light_id);
            }

            const pastedArchitecture = [];
            for (const selection of clipboard.architecture_selection || []) {
                const id = selection.type === "building"
                    ? buildingIds.get(selection.id)
                    : selection.type === "room"
                        ? roomIds.get(selection.id)
                        : selection.type === "wall"
                            ? wallIds.get(selection.id)
                            : selection.type === "opening"
                                ? openingIds.get(selection.id)
                                : null;
                if (id) pastedArchitecture.push({ type: selection.type, id });
            }
            const architectureAdded = buildingIds.size
                + roomIds.size
                + wallIds.size
                + openingIds.size;
            if (!architectureAdded && !pastedCameraIds.length && !pastedLightIds.length && !pastedObjectIds.length) {
                this._setStatus("Nothing pasted", "idle");
                this.toast("The copied selection could not be placed in the current scene.", "info");
                return;
            }
            if (pastedLightIds.length) this._commitLighting({ final: true });
            if (architectureAdded) {
                this.history.push("Paste architecture", beforeArchitecture, this._captureEditorSnapshot());
                await this._commitArchitecture();
            } else if (pastedCameraIds.length || pastedLightIds.length || pastedObjectIds.length) {
                this.history.push("Paste selection", beforeArchitecture, this._captureEditorSnapshot());
                this.viewer.setCameraMarkers(this.scene.cameras || []);
                await this._saveSceneNow({ showError: false });
            }
            this.selectedObjectIds = new Set(pastedObjectIds);
            this.selectedObjectId = pastedObjectIds.at(-1) || "";
            this.selectedArchitectureItems = new Map(pastedArchitecture.map(item => [
                this._architectureSelectionKey(item),
                item,
            ]));
            this.selectedArchitecture = pastedArchitecture.at(-1) || null;
            this.selectedCameraId = !pastedObjectIds.length && !pastedArchitecture.length
                ? pastedCameraIds.at(-1) || ""
                : "";
            this.selectedCameraIds = new Set(pastedCameraIds);
            this.selectedLightId = !pastedObjectIds.length && !pastedArchitecture.length && !pastedCameraIds.length
                ? pastedLightIds.at(-1) || ""
                : "";
            this.selectedGroupId = "";
            this.selectedSkydome = false;
            this.viewer.select(this.selectedObjectId, { additive: true, emit: false });
            this.viewer.setArchitectureSelection(
                this.selectedArchitecture,
                this._selectedArchitectureRefs(),
            );
            this.viewer.selectLightMarker(this.selectedLightId);
            this._renderObjects();
            this._renderCameras();
            this._renderInspector();
            this._syncToolbar();
            this._scheduleSceneSave(0);
            this._scheduleStateSave(0);
            const pastedCount = pastedObjectIds.length + pastedArchitecture.length + pastedCameraIds.length + pastedLightIds.length;
            this._setStatus("Selection pasted", "success");
            this.toast(`${pastedCount} object${pastedCount === 1 ? "" : "s"} pasted.`, "success");
        } catch (error) {
            this._setStatus("Paste failed", "error");
            this._showError("Selection paste failed", error);
        } finally {
            this._syncToolbar();
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
            this._placeNewObjectOnActiveFloor(result.object_id);
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
            if (result.schema !== MODEL_LIBRARY_SCHEMA) {
                throw new Error(
                    "The server returned an incompatible model library. Restart ComfyUI to load the 3D Factory library routes.",
                );
            }
            const received = Array.isArray(result.items) ? result.items : [];
            const rejected = received.filter(item => (
                !item
                || item.schema !== MODEL_LIBRARY_SCHEMA
                || !["object", "scene", "skydome"].includes(item.asset_type)
                || !/^[a-f0-9]{24}$/.test(String(item.asset_id || ""))
            ));
            if (rejected.length) {
                console.error("[VNCCS 3D Factory] Rejected incompatible library records", {
                    rejected: rejected.length,
                    total: received.length,
                });
            }
            this.libraryItems = received.filter(item => (
                item
                && item.schema === MODEL_LIBRARY_SCHEMA
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
            return [
                item.name, item.asset_type, item.model_kind, item.model_format,
                item.category, item.repository, ...(item.tags || []),
            ]
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
                : item.model_kind === "mesh"
                    ? `${String(item.model_format || "3D").toUpperCase()} model`
                    : "Gaussian model";
        const modelStats = item.asset_type === "skydome"
            ? ""
            : item.model_kind === "mesh"
                ? ""
                : ` · ${Number(item.gaussians || 0).toLocaleString()} splats`;
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
                <div class="vnccs-ps-library-system-tag">${assetLabel}${modelStats} · ${formatBytes(item.bytes)}</div>
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
                        <div class="vnccs-ps-library-settings-subtitle">3D model and scene libraries on Hugging Face can be enabled, disabled, refreshed, or removed.</div>
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
                    <p class="vnccs-ps-library-field">Remote publishing is disabled by the VNCCS security policy.</p>
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
                if (result.created_scene) this._selectObject(result.object_id);
                else this._placeNewObjectOnActiveFloor(result.object_id);
            }
            this.toast(
                result.created_scene
                    ? "Library scene opened."
                    : result.skydome_id
                        ? "Library skydome applied to scene."
                        : "3D object added to scene.",
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
            title: "3D model library repositories",
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
                element("strong", "", "Local 3D Model Library"),
                element("span", "", `${Number(data.local?.asset_count || 0)} saved assets`),
            );
            const publishRow = element("div", "vnccs-i3s__library-repo-publish");
            const publishId = element("input", "vnccs-i3s__input");
            publishId.placeholder = "HuggingFace owner/repository";
            publishId.value = data.local?.publish_repo_id || "";
            const publish = button("vnccs-i3s__button vnccs-i3s__button--primary", "Publish", "upload");
            publish.disabled = true;
            publish.title = "Remote publishing is disabled by the VNCCS security policy";
            publish.addEventListener("click", async () => {
                publish.disabled = true;
                try {
                    const result = await this._fetchJSON(ENDPOINTS.libraryRepositoryPublish, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ repo_id: publishId.value.trim() }),
                    });
                    await this._waitLibraryRepositoryTask(result.task_id, progress);
                    this.toast("3D model library published to Hugging Face.", "success");
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
                    element("small", "", repo.description || "Hugging Face 3D asset repository"),
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
        if (exportLabel) exportLabel.textContent = "Gaussian PLY";
        if (this.els.sceneExport) {
            this.els.sceneExport.title = "Export visible Gaussian models as PLY; architecture is stored in the scene";
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
        this._syncWorkspace();
        const mode = this.viewerState.mode || "translate";
        this.els.modeMove.setAttribute("aria-pressed", String(mode === "translate"));
        this.els.modeRotate.setAttribute("aria-pressed", String(mode === "rotate"));
        this.els.modeScale.setAttribute("aria-pressed", String(mode === "scale"));
        this.els.grid.setAttribute("aria-pressed", String(Boolean(this.viewerState.grid)));
        const plan = this.editorView.view_mode === "plan";
        this.els.fit.disabled = plan;
        this.els.fit.title = plan ? "Available in 3D view" : "Frame complete 3D scene";
        this._syncCameraPanelControls();
        this.els.view3d.setAttribute("aria-pressed", String(!plan));
        this.els.viewPlan.setAttribute("aria-pressed", String(plan));
        const cutawayKey = plan ? "plan" : "three_d";
        const cutawayEnabled = Boolean(this.editorView.interior_cutaway?.[cutawayKey]);
        this.els.cutaway.setAttribute("aria-pressed", String(cutawayEnabled));
        this.els.cutaway.title = cutawayEnabled
            ? "Disable cutaway and show complete architecture in this viewport mode"
            : "Interior cutaway (viewport only): hide ceilings and the nearest blocking wall";
        this.viewer?.setInteriorCutaway?.(cutawayEnabled);
        this.els.planTools.hidden = !plan;
        this.els.openingKindShortcut.hidden = !plan || this.editorView.plan_tool !== "opening";
        this.els.modeMove.disabled = plan && this.editorView.plan_tool !== "select";
        this.els.modeRotate.disabled = plan || Boolean(this.selectedLightId);
        this.els.modeScale.disabled = plan || Boolean(this.selectedLightId);
        const planToolTitles = {
            select: "Select and edit architecture",
            wall: "Press and drag to draw a wall",
            room: "Press and drag diagonally to draw a rectangular room",
            opening: "Press on a wall and drag to set the opening width",
            camera: "Press and drag to place and aim a saved camera",
        };
        for (const control of this.els.planToolButtons) {
            control.disabled = false;
            control.title = planToolTitles[control.dataset.planTool] || "";
            control.setAttribute(
                "aria-pressed",
                String(control.dataset.planTool === this.editorView.plan_tool),
            );
        }
        const planHints = {
            select: "Click an object · Drag empty space for box selection",
            wall: "Press and drag to draw a wall",
            room: "Press and drag diagonally to draw a room",
            opening: "Press on a wall and drag to set width",
            camera: "Press and drag to place and aim",
        };
        this.els.planHint.textContent = planHints[this.editorView.plan_tool] || planHints.select;
        this.els.planGridToggle.setAttribute(
            "aria-pressed",
            String(this.editorView.plan_grid.visible),
        );
        this.els.snapToggle.setAttribute("aria-pressed", String(this.editorView.snap.enabled));
        this.els.snapGrid.value = String(this.editorView.plan_grid.step);
        for (const control of this.els.planSettings) {
            const key = control.dataset.planSetting;
            const value = key === "major_every"
                ? this.editorView.plan_grid.major_every
                : key === "grid_step"
                    ? this.editorView.plan_grid.step
                    : key === "opening_kind"
                        ? this.editorView.opening_kind
                        : this.editorView.snap[key];
            if (control.type === "checkbox") control.checked = value !== false;
            else control.value = String(value ?? 0);
        }
        this.viewer?.setPlanGrid?.({
            visible: this.editorView.plan_grid.visible,
            step: this.editorView.plan_grid.step,
            majorEvery: this.editorView.plan_grid.major_every,
        });
        const levels = this.scene ? normalizedLevels(this.scene.levels) : [];
        const selectedLevelId = levels.some(level => level.level_id === this.editorView.active_level_id)
            ? this.editorView.active_level_id
            : levels[0]?.level_id || "";
        this.editorView.active_level_id = selectedLevelId;
        const activeLevel = levels.find(level => level.level_id === selectedLevelId);
        const architectureToolActive = plan
            && ["wall", "room", "opening"].includes(this.editorView.plan_tool);
        this.els.levelPanel.hidden = !architectureToolActive;
        this.els.levelPanel.setAttribute(
            "aria-label",
            activeLevel
                ? `Floor levels, ${activeLevel.name} active`
                : "Floor levels",
        );
        const levelSignature = levels.map(
            level => `${level.level_id}:${level.name}:${level.elevation}:${level.height}:${level.visible}`,
        ).join("|");
        if (this.els.levelList.dataset.signature !== levelSignature) {
            this.els.levelList.replaceChildren(...levels.map(level => {
                const control = button(
                    "vnccs-i3s__level-card",
                    "",
                );
                control.type = "button";
                control.dataset.levelId = level.level_id;
                control.setAttribute("role", "option");
                const copy = element("span", "vnccs-i3s__level-card-copy");
                copy.append(
                    element("b", "", level.name || "Level"),
                    element(
                        "small",
                        "",
                        `${Number(level.elevation).toFixed(2)} m · height ${Number(level.height).toFixed(2)} m`,
                    ),
                );
                control.appendChild(copy);
                control.addEventListener("click", () => {
                    this.editorView.active_level_id = level.level_id;
                    this.viewer.setActiveLevel(level.level_id);
                    this._renderObjects();
                    this._syncToolbar();
                    this._scheduleStateSave(0);
                });
                return control;
            }));
            this.els.levelList.dataset.signature = levelSignature;
        }
        for (const control of this.els.levelList.querySelectorAll("[data-level-id]")) {
            const selected = control.dataset.levelId === selectedLevelId;
            control.classList.toggle("is-active", selected);
            control.setAttribute("aria-selected", String(selected));
        }
        this.els.levelAdd.disabled = !this.scene || levels.length >= 64;
        if (this.els.undo) this.els.undo.disabled = !this.history.canUndo;
        if (this.els.redo) this.els.redo.disabled = !this.history.canRedo;
        if (this.els.selectionCopy) {
            const copyableCount = this.selectedObjectIds.size
                + this._selectedArchitectureRefs().length
                + (this.selectedGroupId ? 1 : 0)
                + this.selectedCameraIds.size
                + (this.selectedLightId ? 1 : 0);
            this.els.selectionCopy.disabled = !this.scene || copyableCount === 0;
        }
        if (this.els.selectionPaste) {
            this.els.selectionPaste.disabled = !this.scene || !this.selectionClipboard;
        }
    }

    serializeState() {
        return {
            schema_version: STATE_VERSION,
            scene_id: this.sceneId,
            selected_object_id: this.selectedObjectId,
            selected_object_ids: Array.from(this.selectedObjectIds),
            selected_group_id: this.selectedGroupId,
            selected_skydome: this.selectedSkydome,
            selected_architecture: this.selectedArchitecture,
            selected_architectures: this._selectedArchitectureRefs(),
            selected_camera_id: this.selectedCameraId,
            selected_camera_ids: Array.from(this.selectedCameraIds),
            selected_light_id: this.selectedLightId,
            collapsed_group_ids: Array.from(this.collapsedGroupIds),
            settings: { ...this.settings },
            render_settings: { ...this.exportSettings },
            panorama_camera_id: this.panoramaCameraId,
            panorama_width: this.panoramaWidth,
            lighting_settings: { ...this.lighting },
            viewer_state: this.viewer?.getState?.() || this.viewerState,
            editor_view: {
                ...this.editorView,
                plan_camera: this.viewer?.getState?.().plan_camera || this.editorView.plan_camera,
            },
            active_camera_track_id: this.activeCameraTrackId,
            selected_camera_keyframe_id: this.selectedCameraKeyframeId,
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
            this.selectedArchitecture = safeObject(state.selected_architecture);
            if (!this.selectedArchitecture.type || !this.selectedArchitecture.id) {
                this.selectedArchitecture = null;
            }
            const savedArchitectureSelections = Array.isArray(state.selected_architectures)
                ? state.selected_architectures
                : this.selectedArchitecture
                    ? [this.selectedArchitecture]
                    : [];
            this.selectedArchitectureItems = new Map(savedArchitectureSelections
                .map(selection => this._normalizeArchitectureSelection(selection))
                .filter(selection => selection?.id)
                .map(selection => [this._architectureSelectionKey(selection), selection]));
            this.selectedArchitecture = this.selectedArchitectureItems.has(
                this._architectureSelectionKey(this.selectedArchitecture),
            )
                ? this.selectedArchitecture
                : Array.from(this.selectedArchitectureItems.values()).at(-1) || null;
            this.selectedCameraId = String(state.selected_camera_id || "");
            this.selectedCameraIds = new Set(
                Array.isArray(state.selected_camera_ids)
                    ? state.selected_camera_ids.map(String)
                    : this.selectedCameraId
                        ? [this.selectedCameraId]
                        : [],
            );
            if (this.selectedCameraId) this.selectedCameraIds.add(this.selectedCameraId);
            this.panoramaCameraId = String(state.panorama_camera_id || this.selectedCameraId || "");
            this.panoramaWidth = [2048, 4096].includes(Number(state.panorama_width))
                ? Number(state.panorama_width)
                : 4096;
            this.selectedLightId = String(state.selected_light_id || "");
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
            this.editorView = normalizedEditorView(
                state.editor_view || state.viewer_state,
                safeObject(state.scene_snapshot).levels?.[0]?.level_id,
            );
            this.activeCameraTrackId = String(state.active_camera_track_id || "");
            this.selectedCameraKeyframeId = String(state.selected_camera_keyframe_id || "");
            this._syncSettings();
            this._syncExportSettings();
            this._syncLighting();
            this.viewer.setLighting(this.lighting);
            this.viewer.setState(this.viewerState);
            this.viewer.setViewMode(this.editorView.view_mode);
            this.viewer.setPlanTool(this.editorView.plan_tool);
            this.viewer.setActiveLevel(this.editorView.active_level_id);
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
        this.container.classList.toggle("is-compact", width < 980);
        this.container.classList.toggle("is-narrow", width < 760);
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
        clearTimeout(this._architecturePreviewTimer);
        if (this._architectureGeometryFrame) cancelAnimationFrame(this._architectureGeometryFrame);
        this._architectureGeometryFrame = 0;
        if (this.cameraPlayback?.frame) cancelAnimationFrame(this.cameraPlayback.frame);
        this.cameraPlayback = null;
        if (this._planHoverFrame) cancelAnimationFrame(this._planHoverFrame);
        this._planHoverFrame = 0;
        this._pendingPlanHover = null;
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
