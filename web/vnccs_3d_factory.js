import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { installCustomSelects } from "./vnccs_custom_select.mjs";
import { Factory3DViewer } from "./vnccs_3d_factory_viewer.js?v=20260724.18";


const API_BASE = "/vnccs/3d-factory";
const ENDPOINTS = Object.freeze({
    capabilities: `${API_BASE}/capabilities`,
    weightsDownload: `${API_BASE}/weights/download`,
    scenes: `${API_BASE}/scenes`,
    scene: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}`,
    reference: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/reference`,
    preview: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/preview`,
    previewError: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/preview/error`,
    generate: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/generate`,
    exportScene: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/export`,
    job: jobId => `${API_BASE}/jobs/${encodeURIComponent(jobId)}`,
    cancelJob: jobId => `${API_BASE}/jobs/${encodeURIComponent(jobId)}/cancel`,
    jobLog: jobId => `${API_BASE}/jobs/${encodeURIComponent(jobId)}/log`,
});
const DEFAULT_NODE_SIZE = Object.freeze([1100, 760]);
const STATE_VERSION = 4;
const FRONTEND_BUILD = "20260724.21";
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const DEFAULT_SETTINGS = Object.freeze({
    name: "",
    steps: 20,
    guidance_scale: 3,
    num_gaussians: 131072,
    conditioning_resolution: 1024,
    prevent_upscale: false,
    erode_radius: 0,
    seed: -1,
});
const DEFAULT_EXPORT_SETTINGS = Object.freeze({
    width: 1024,
    height: 1024,
    aspect: "1:1",
    show_camera_frame: false,
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
    stop: `<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`,
    search: `<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>`,
    settings: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-2.91 1.22V21h-4v-.08A1.7 1.7 0 0 0 7.1 19.7l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.3 7.1l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 10 3.08V3h4v.08a1.7 1.7 0 0 0 2.9 1.2l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z"/></svg>`,
    download: `<svg viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16"/></svg>`,
    trash: `<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7m4 4v6m4-6v6"/></svg>`,
    close: `<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>`,
    check: `<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>`,
    warning: `<svg viewBox="0 0 24 24"><path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5m0 3v.01"/></svg>`,
    scenes: `<svg viewBox="0 0 24 24"><path d="M4 6h16v12H4zM7 3h10M7 21h10"/></svg>`,
    duplicate: `<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>`,
    eye: `<svg viewBox="0 0 24 24"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>`,
    eyeOff: `<svg viewBox="0 0 24 24"><path d="m3 3 18 18M10.6 6.2A10.8 10.8 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-2.2 2.8M6.4 6.5C3.9 8.3 2.5 12 2.5 12s3.5 6 9.5 6c1.4 0 2.7-.3 3.8-.8M9.9 9.8a3 3 0 0 0 4.2 4.3"/></svg>`,
    folder: `<svg viewBox="0 0 24 24"><path d="M3 6h7l2 2h9v10H3V6Z"/></svg>`,
    ungroup: `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="8" height="8" rx="1"/><rect x="13" y="11" width="8" height="8" rx="1"/><path d="M8 16H5v-3m11-5h3v3"/></svg>`,
    chevron: `<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>`,
});


function installStyles() {
    if (document.getElementById("vnccs-3d-factory-styles")) return;
    const link = document.createElement("link");
    link.id = "vnccs-3d-factory-styles";
    link.rel = "stylesheet";
    link.href = new URL("./vnccs_3d_factory.css?v=20260724.14", import.meta.url).href;
    document.head.appendChild(link);
}

function element(tag, className = "", text = "") {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text) value.textContent = text;
    return value;
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

function errorText(error, fallback = "The operation could not be completed.") {
    if (error instanceof Error) return error.message || fallback;
    if (typeof error === "string") return error || fallback;
    try { return JSON.stringify(error, null, 2); } catch (_) { return fallback; }
}

function safeObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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

function download(url) {
    const link = document.createElement("a");
    link.href = apiUrl(url);
    link.rel = "noopener";
    link.download = "";
    document.body.appendChild(link);
    link.click();
    link.remove();
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
        this.collapsedGroupIds = new Set();
        this.dragLayer = null;
        this.viewportFailures = new Map();
        this.settings = { ...DEFAULT_SETTINGS };
        this.exportSettings = { ...DEFAULT_EXPORT_SETTINGS };
        this.viewerState = { mode: "translate", grid: false };
        this.capabilities = null;
        this.currentJobId = "";
        this.currentJobToken = 0;
        this._listeners = [];
        this._timers = new Set();
        this._saveTimer = 0;
        this._sceneSaveTimer = 0;
        this._previewSaveTimer = 0;
        this._sceneSaveSerial = Promise.resolve();
        this._previewSaveSerial = Promise.resolve();
        this._restoreSerial = Promise.resolve();
        this._resizeFrame = 0;
        this._modalCleanup = null;
        this._previousFocus = null;
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
                const previousCamera = JSON.stringify(this.viewerState.camera || {});
                this.viewerState = { ...this.viewerState, ...state };
                this._syncToolbar();
                this._scheduleStateSave();
                const cameraChanged = previousCamera !== JSON.stringify(state.camera || {});
                if (
                    cameraChanged
                    && !this._isRestoring
                    && !this._suppressViewerStatePersistence
                    && this.scene
                ) {
                    this.scene.camera = { ...state.camera };
                    this._scheduleSceneSave(220);
                    this._scheduleScenePreview(420);
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
        this._syncSettings();
        this._syncExportSettings();
        this._setStatus("Ready", "idle");
    }

    _createLayout() {
        const root = element("div", "vnccs-i3s");
        root.style.containerType = "inline-size";
        root.setAttribute("aria-label", "VNCCS 3D Factory");
        root.innerHTML = `
            <aside class="vnccs-i3s__side vnccs-i3s__side--left" aria-label="Reference and generation settings">
                <div class="vnccs-i3s__brand">
                    <div class="vnccs-i3s__brand-mark">${ICONS.cube}</div>
                    <div class="vnccs-i3s__brand-copy">
                        <div class="vnccs-i3s__brand-title">VNCCS 3D Factory</div>
                        <div class="vnccs-i3s__brand-subtitle">Image to Gaussian scene</div>
                    </div>
                </div>
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
                            <img class="vnccs-i3s__source-preview" alt="Selected reference" />
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
                        <div class="vnccs-i3s__field-row">
                            <label class="vnccs-i3s__field">
                                <span class="vnccs-i3s__label">Mask erosion</span>
                                <input class="vnccs-i3s__input vnccs-i3s__erosion" type="number" min="0" max="8" step="1" />
                            </label>
                            <label class="vnccs-i3s__field">
                                <span class="vnccs-i3s__label">Seed</span>
                                <input class="vnccs-i3s__input vnccs-i3s__seed" type="number" min="-1" max="2147483647" step="1" />
                            </label>
                        </div>
                        <button class="vnccs-i3s__button vnccs-i3s__button--primary vnccs-i3s__button--block vnccs-i3s__generate" type="button">${ICONS.play}<span>Generate object</span></button>
                    </div>
                </section>
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
                        <button class="vnccs-i3s__tool vnccs-i3s__grid" type="button" title="Grid" aria-pressed="false">${ICONS.grid}</button>
                    </div>
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
                            <button class="vnccs-i3s__button vnccs-i3s__scene-ply" type="button">${ICONS.download}<span>Scene PLY</span></button>
                            <button class="vnccs-i3s__button vnccs-i3s__scene-splat" type="button">${ICONS.download}<span>Scene SPLAT</span></button>
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
            erosion: $(".vnccs-i3s__erosion"),
            seed: $(".vnccs-i3s__seed"),
            generate: $(".vnccs-i3s__generate"),
            sceneName: $(".vnccs-i3s__scene-name-input"),
            sceneId: $(".vnccs-i3s__project-id"),
            sceneManager: $(".vnccs-i3s__scene-manager"),
            status: $(".vnccs-i3s__status-pill"),
            viewerHost: $(".vnccs-i3s__viewer-host"),
            fit: $(".vnccs-i3s__fit"),
            modeMove: $(".vnccs-i3s__mode-move"),
            modeRotate: $(".vnccs-i3s__mode-rotate"),
            modeScale: $(".vnccs-i3s__mode-scale"),
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
            scenePly: $(".vnccs-i3s__scene-ply"),
            sceneSplat: $(".vnccs-i3s__scene-splat"),
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
            [this.els.erosion, "erode_radius", "integer"],
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
        this._listen(this.els.modelSetup, "click", () => this.openModelSetup());
        this._listen(this.els.generate, "click", () => void this.generate());
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
        this._listen(this.els.grid, "click", () => this.viewer.setGrid(!this.viewerState.grid));
        this._listen(this.els.cancelJob, "click", () => void this.cancelJob());
        this._listen(this.els.objectSearch, "input", () => this._renderObjects());
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
        this._listen(this.els.scenePly, "click", () => void this.exportScene("ply"));
        this._listen(this.els.sceneSplat, "click", () => void this.exportScene("splat"));
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
        if (!value.url || value.url !== expectedURL || assetSceneId !== this.sceneId) {
            this.sourceAsset = null;
            this.sourceFile = null;
            this._showSource({ url: "", name: "" });
            return;
        }
        this.sourceAsset = {
            url: String(value.url),
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
            url: apiUrl(this.sourceAsset.url),
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
        if (this.selectedObjectId) desiredObjectIds.add(this.selectedObjectId);
        this.scene = scene;
        this.sceneId = scene.scene_id;
        this._normalizeSceneLayers();
        this.exportSettings = this._normalizeExportSettings(
            scene.render || this.exportSettings,
        );
        this.scene.render = { ...this.exportSettings };
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
        if (desiredGroup) {
            this.selectedGroupId = desiredGroup.group_id;
            this.selectedObjectIds.clear();
            this.selectedObjectId = "";
            this.viewer.selectGroup(desiredGroup.group_id, desiredGroup.children);
        } else {
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
        this._renderObjects();
        this._scheduleStateSave();
        this.syncToNode();
        let previewError = null;
        const loaded = Number(viewportResult.loaded) || 0;
        if (loaded > 0) {
            this._setStatus("Saving scene preview", "working");
            try {
                const preview = await this._saveScenePreviewNow();
                if (!preview) throw new Error("The viewport did not produce a scene preview");
            } catch (error) {
                previewError = error;
                console.error("[VNCCS 3D Factory] Mandatory scene preview export failed", {
                    build: FRONTEND_BUILD,
                    sceneId: this.sceneId,
                    error,
                });
            } finally {
                this.viewer.startPendingLodUpgrades();
            }
        } else {
            this.viewer.startPendingLodUpgrades();
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
        } else if (previewError) {
            this._setStatus("Preview export failed", "error");
            this._showError("Scene preview export failed", previewError);
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
        const visibleIds = this._effectiveVisibleObjectIds();
        this.container.classList.toggle("has-scene", Boolean(objects.length));
        this.els.objectCount.textContent = String(objects.length);
        this.els.sceneSummary.textContent = objects.length
            ? `${visibleIds.size}/${objects.length} visible · ${objects.reduce(
                (sum, item) => sum + (visibleIds.has(item.object_id) ? Number(item.gaussians) || 0 : 0),
                0,
            ).toLocaleString()} Gaussians`
            : "No objects in this scene.";
    }

    _selectObject(objectId, { fromViewer = false, additive = false } = {}) {
        const valid = this.scene?.objects?.some(item => item.object_id === objectId)
            ? objectId
            : "";
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
        const group = this._groupById(groupId);
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
            : this.selectedGroupId
                ? "Group selected"
                : "Shift-click to select multiple";
    }

    _syncSelectionPresentation() {
        for (const card of this.els.objectList.querySelectorAll(".vnccs-i3s__object")) {
            const objectId = card.dataset.objectId || "";
            card.classList.toggle("is-selected", this.selectedObjectIds.has(objectId));
            card.classList.toggle("is-primary", objectId === this.selectedObjectId);
        }
        for (const card of this.els.objectList.querySelectorAll(".vnccs-i3s__group-card")) {
            const groupId = card.dataset.groupId
                || card.closest(".vnccs-i3s__group")?.dataset.groupId
                || "";
            card.classList.toggle("is-selected", groupId === this.selectedGroupId);
        }
        this._syncSelectionControls();
    }

    _renderObjects() {
        const query = this.els.objectSearch.value.trim().toLowerCase();
        const objects = new Map((this.scene?.objects || []).map(item => [item.object_id, item]));
        const layers = this._normalizeSceneLayers();
        this.els.objectList.replaceChildren();
        this._syncSelectionControls();
        if (!objects.size) {
            this.els.objectList.appendChild(element("div", "vnccs-i3s__tree-empty", query ? "No matching objects." : "Generated objects will appear here."));
            return;
        }
        let rendered = 0;
        for (const layer of layers) {
            if (layer.type === "object") {
                const item = objects.get(layer.object_id);
                if (!item || (query && !item.name.toLowerCase().includes(query))) continue;
                this.els.objectList.appendChild(this._createObjectCard(item, ""));
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
            this.els.objectList.appendChild(wrapper);
            rendered += 1;
        }
        if (!rendered) {
            this.els.objectList.appendChild(element("div", "vnccs-i3s__tree-empty", "No matching objects."));
        }
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
        copy.append(
            name,
            element(
                "div",
                "vnccs-i3s__object-meta",
                [
                    viewportFailure ? "Viewport failed" : "",
                    `${Number(item.gaussians || 0).toLocaleString()} splats`,
                    conditioning ? `${conditioning}² input` : "",
                    `seed ${item.seed}`,
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
        const ply = button("vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__icon-button", "", "download");
        ply.title = "Export transformed PLY";
        ply.addEventListener("click", event => {
            event.stopPropagation();
            download(item.urls.export_ply);
        });
        const splat = button("vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__icon-button", "", "cube");
        splat.title = "Export transformed SPLAT";
        splat.addEventListener("click", event => {
            event.stopPropagation();
            download(item.urls.export_splat);
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
        for (const control of [visibility, ply, splat, duplicate, remove]) {
            control.setAttribute("aria-label", control.title);
            control.addEventListener("dblclick", event => event.stopPropagation());
        }
        actions.append(visibility, ply, splat, duplicate, remove);
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
            group.visible = group.visible === false;
            this.viewer.applySceneVisibility(this.scene);
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
        const camera = this.viewer?.getState?.().camera || this.viewerState.camera;
        return {
            name: this.els.sceneName.value.trim() || this.scene?.name || "Untitled scene",
            render: { ...this.exportSettings },
            camera: camera ? { ...camera } : undefined,
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
        if (this._isRestoring || this.destroyed || !this.sceneId || !this.scene?.objects?.length) return;
        clearTimeout(this._previewSaveTimer);
        this._previewSaveTimer = setTimeout(
            () => void this._saveScenePreviewNow().catch(() => {}),
            delay,
        );
    }

    async _saveScenePreviewNow({ captureToken = "" } = {}) {
        clearTimeout(this._previewSaveTimer);
        this._previewSaveTimer = 0;
        if (this.destroyed || !this.sceneId || !this.scene?.objects?.length) return null;
        const sceneId = this.sceneId;
        const operation = this._previewSaveSerial.then(async () => {
            if (this.destroyed || this.sceneId !== sceneId || !this.scene?.objects?.length) return null;
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
            if (!this.scene?.objects?.length) {
                throw new Error("The requested scene has no loaded Gaussian objects.");
            }
            console.info("[VNCCS 3D Factory][viewport] Execution preview requested", {
                sceneId,
                captureToken,
                sceneRevision: detail.scene_revision,
                renderRevision: detail.render_revision,
                documentVisible: document.visibilityState,
            });
            const preview = await this._saveScenePreviewNow({ captureToken });
            if (!preview) throw new Error("The 3D viewport returned no execution preview.");
            console.info("[VNCCS 3D Factory][viewport] Execution preview completed", {
                sceneId,
                captureToken,
                width: preview.width,
                height: preview.height,
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
            "erode_radius",
            "seed",
        ]) {
            form.append(key, String(this.settings[key]));
        }
        form.append("prevent_upscale", this.settings.prevent_upscale ? "1" : "0");
        try {
            const job = await this._fetchJSON(ENDPOINTS.generate(this.sceneId), { method: "POST", body: form });
            await this._monitorJob(job.job_id);
        } catch (error) {
            if (!error?.factoryErrorShown) this._showError("Generation failed", error);
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

    async exportScene(format) {
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
            const scene = await this._fetchJSON(ENDPOINTS.exportScene(this.sceneId), { method: "POST" });
            this.scene.exports = scene.exports;
            download(scene.exports.urls[format]);
            this._setStatus("Scene exported", "success");
        } catch (error) {
            this._setStatus("Export failed", "error");
            this._showError("Scene export failed", error);
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
            element("div", "vnccs-i3s__hint", "Its generated PLY, SPLAT, reference, and cached exports will be deleted from the Factory scene."),
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
                card.append(copy, open);
                cards.appendChild(card);
            }
            if (!cards.children.length) cards.appendChild(element("div", "vnccs-i3s__tree-empty", "No saved scenes."));
        } catch (error) {
            cards.replaceChildren(element("div", "vnccs-i3s__tree-empty", errorText(error)));
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
        const selectedResolution = () => Number(
            resolutionList.querySelector("input:checked")?.value || 1024,
        );
        const currentDraft = () => ({
            conditioning_resolution: selectedResolution(),
            prevent_upscale: preventUpscale,
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
        body.append(models, inference);

        const close = button("vnccs-i3s__button", "Close");
        const apply = button(
            "vnccs-i3s__button vnccs-i3s__button--primary",
            "Apply settings",
            "check",
        );
        close.addEventListener("click", () => this.closeModal());
        apply.addEventListener("click", () => {
            const draft = currentDraft();
            this.settings.conditioning_resolution = draft.conditioning_resolution;
            this.settings.prevent_upscale = draft.prevent_upscale;
            this._syncTripoSummary();
            this._scheduleStateSave(0);
            this.closeModal();
            this.toast(
                `TripoSplat conditioning set to ${draft.conditioning_resolution}×${draft.conditioning_resolution}.`,
                "success",
            );
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
        this.els.erosion.value = String(this.settings.erode_radius);
        this.els.seed.value = String(this.settings.seed);
        this._syncDensityMode();
        this._customSelects?.refresh?.();
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
            collapsed_group_ids: Array.from(this.collapsedGroupIds),
            settings: { ...this.settings },
            render_settings: { ...this.exportSettings },
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
            this.node.setDirtyCanvas?.(true, true);
            app.graph?.setDirtyCanvas?.(true, true);
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
            this.collapsedGroupIds = new Set(
                Array.isArray(state.collapsed_group_ids)
                    ? state.collapsed_group_ids.map(String)
                    : [],
            );
            this.settings = { ...DEFAULT_SETTINGS, ...safeObject(state.settings) };
            if (![1024, 1536, 2048].includes(Number(this.settings.conditioning_resolution))) {
                this.settings.conditioning_resolution = 1024;
            } else {
                this.settings.conditioning_resolution = Number(this.settings.conditioning_resolution);
            }
            this.settings.prevent_upscale = this.settings.prevent_upscale === true;
            this.exportSettings = this._normalizeExportSettings(
                state.render_settings || safeObject(state.scene_snapshot).render,
            );
            this.viewerState = { ...this.viewerState, ...safeObject(state.viewer_state) };
            this._syncSettings();
            this._syncExportSettings();
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
            this._scheduleScenePreview(160);
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
        this.container.style.setProperty("--i3-scale", scale.toFixed(3));
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
        for (const timer of this._timers) clearTimeout(timer);
        this._timers.clear();
        for (const remove of this._listeners) remove();
        this._listeners.length = 0;
        this._resizeObserver?.disconnect();
        this._navigationCleanup?.();
        this._customSelects?.destroy?.();
        this.viewer?.dispose();
        if (this.sourceURL?.startsWith("blob:")) URL.revokeObjectURL(this.sourceURL);
        this.closeModal();
        this.container.remove();
    }
}


function enableCanvasNavigationForwarding(root) {
    const forward = event => {
        if (event.defaultPrevented || event.target.closest("input,textarea,select,button,[contenteditable='true']")) return;
        const canvas = app.canvas?.canvas;
        if (!canvas || event.target.closest(".vnccs-i3s__viewer-host")) return;
        canvas.dispatchEvent(new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            clientX: event.clientX,
            clientY: event.clientY,
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            deltaZ: event.deltaZ,
            deltaMode: event.deltaMode,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            metaKey: event.metaKey,
        }));
    };
    root.addEventListener("wheel", forward, { passive: true });
    return () => root.removeEventListener("wheel", forward);
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
    if (!widget || widget._vnccsFactoryWidthBound) return;
    try {
        Object.defineProperty(widget, "width", {
            configurable: true,
            get() {
                const width = Number(this._node?.size?.[0] ?? node?.size?.[0]);
                return Number.isFinite(width) && width > 0 ? width : undefined;
            },
            set() {},
        });
        widget._vnccsFactoryWidthBound = true;
    } catch (_) {}
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
            this._vnccsFactoryInit = setTimeout(() => {
                this._vnccsFactoryInit = 0;
                if (this._vnccsFactoryConfigured) return;
                hideFactoryDataWidget(this);
                void factory.restoreFromNode().finally(() => factory.resize());
            }, 400);
        };
        nodeType.prototype.onResize = function () {
            originalResize?.apply(this, arguments);
            if (!this.vnccs3DFactory) return;
            cancelAnimationFrame(this._vnccsFactoryResize);
            this._vnccsFactoryResize = requestAnimationFrame(() => {
                syncDOMWidgetWidth(this);
                this.vnccs3DFactory?.resize();
            });
        };
        nodeType.prototype.onConfigure = function () {
            this._vnccsFactoryConfigured = true;
            clearTimeout(this._vnccsFactoryInit);
            this._vnccsFactoryInit = 0;
            originalConfigure?.apply(this, arguments);
            hideFactoryDataWidget(this);
            clearTimeout(this._vnccsFactoryConfigure);
            this._vnccsFactoryConfigure = setTimeout(() => {
                this._vnccsFactoryConfigure = 0;
                hideFactoryDataWidget(this);
                void this.vnccs3DFactory?.restoreFromNode().finally(() => this.vnccs3DFactory?.resize());
            }, 40);
        };
        nodeType.prototype.onSerialize = function () {
            this.vnccs3DFactory?.syncToNode();
            return originalSerialize?.apply(this, arguments);
        };
        nodeType.prototype.onRemoved = function () {
            clearTimeout(this._vnccsFactoryInit);
            clearTimeout(this._vnccsFactoryConfigure);
            cancelAnimationFrame(this._vnccsFactoryResize);
            this.vnccs3DFactory?.dispose();
            this.vnccs3DFactory = null;
            this.vnccs3DFactoryDOMWidget = null;
            return originalRemoved?.apply(this, arguments);
        };
    },
});
