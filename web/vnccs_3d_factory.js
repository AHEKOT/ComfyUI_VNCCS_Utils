import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { installCustomSelects } from "./vnccs_custom_select.mjs";
import { Factory3DViewer } from "./vnccs_3d_factory_viewer.js?v=20260724.13";


const API_BASE = "/vnccs/3d-factory";
const ENDPOINTS = Object.freeze({
    capabilities: `${API_BASE}/capabilities`,
    weightsDownload: `${API_BASE}/weights/download`,
    scenes: `${API_BASE}/scenes`,
    scene: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}`,
    reference: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/reference`,
    preview: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/preview`,
    generate: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/generate`,
    exportScene: sceneId => `${API_BASE}/scenes/${encodeURIComponent(sceneId)}/export`,
    job: jobId => `${API_BASE}/jobs/${encodeURIComponent(jobId)}`,
    cancelJob: jobId => `${API_BASE}/jobs/${encodeURIComponent(jobId)}/cancel`,
    jobLog: jobId => `${API_BASE}/jobs/${encodeURIComponent(jobId)}/log`,
});
const DEFAULT_NODE_SIZE = Object.freeze([1100, 760]);
const STATE_VERSION = 2;
const FRONTEND_BUILD = "20260724.13";
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const DEFAULT_SETTINGS = Object.freeze({
    name: "",
    steps: 20,
    guidance_scale: 3,
    num_gaussians: 131072,
    conditioning_resolution: 1024,
    prevent_upscale: false,
    erode_radius: 1,
    seed: -1,
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
});


function installStyles() {
    if (document.getElementById("vnccs-3d-factory-styles")) return;
    const link = document.createElement("link");
    link.id = "vnccs-3d-factory-styles";
    link.rel = "stylesheet";
    link.href = new URL("./vnccs_3d_factory.css?v=20260724.11", import.meta.url).href;
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

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
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
        this.viewportFailures = new Map();
        this.settings = { ...DEFAULT_SETTINGS };
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
        // Keep callbacks read-only until the serialized ComfyUI widget state has
        // been applied. Viewer setup emits state changes during construction.
        this._isRestoring = true;
        this._createLayout();
        this._cache();
        this._bind();
        this.viewer = new Factory3DViewer(this.els.viewerHost, {
            onSelectionChange: id => this._selectObject(id, { fromViewer: true }),
            onTransformChange: (id, transform, options) => this._onViewerTransform(id, transform, options),
            onStateChange: state => {
                this.viewerState = { ...this.viewerState, ...state };
                this._syncToolbar();
                this._scheduleStateSave();
                this._scheduleScenePreview();
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
                    <div class="vnccs-i3s__viewport-help">Click object: select · Drag gizmo: transform · Drag empty space: orbit · W/E/R: move/rotate/scale · F: frame</div>
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
                        <div class="vnccs-i3s__object-list"></div>
                    </div>
                </section>
                <section class="vnccs-i3s__section">
                    <div class="vnccs-i3s__section-head"><span>Scene export</span></div>
                    <div class="vnccs-i3s__section-body">
                        <div class="vnccs-i3s__hint vnccs-i3s__scene-summary">No objects in this scene.</div>
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
            objectList: $(".vnccs-i3s__object-list"),
            objectCount: $(".vnccs-i3s__object-count"),
            sceneSummary: $(".vnccs-i3s__scene-summary"),
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
        if (!this.settings.name) {
            this.settings.name = file.name.replace(/\.[^.]+$/, "");
            this.els.objectName.value = this.settings.name;
        }
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
        this.scene = scene;
        this.sceneId = scene.scene_id;
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
        this.container.classList.toggle("has-scene", Boolean(scene.objects?.length));
        this.els.objectCount.textContent = String(scene.objects?.length || 0);
        this.els.sceneSummary.textContent = scene.objects?.length
            ? `${scene.objects.length} object${scene.objects.length === 1 ? "" : "s"} · ${scene.objects.reduce((sum, item) => sum + (Number(item.gaussians) || 0), 0).toLocaleString()} Gaussians`
            : "No objects in this scene.";
        this.viewportFailures.clear();
        this._renderObjects();
        this._setStatus("Loading viewport", "working");
        const viewportResult = await this.viewer.setScene(scene) || { loaded: 0, failures: [] };
        const viewportFailures = Array.isArray(viewportResult.failures)
            ? viewportResult.failures
            : [];
        this.viewportFailures = new Map(
            viewportFailures.map(item => [item.objectId, errorText(item.error)]),
        );
        this.viewer.setState(this.viewerState);
        const selected = this.selectedObjectId && scene.objects?.some(item => item.object_id === this.selectedObjectId)
            ? this.selectedObjectId
            : scene.objects?.[0]?.object_id || "";
        this._selectObject(selected);
        this.syncToNode();
        if (viewportFailures.length) {
            const failureDetails = viewportFailures.map(item => ({
                objectId: item.objectId,
                error: errorText(item.error),
                stack: item.error?.stack || "",
            }));
            const loaded = Number(viewportResult.loaded) || 0;
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
        if (Number(viewportResult.loaded) > 0) this._scheduleScenePreview(240);
    }

    _selected() {
        return this.scene?.objects?.find(item => item.object_id === this.selectedObjectId) || null;
    }

    _selectObject(objectId, { fromViewer = false } = {}) {
        this.selectedObjectId = this.scene?.objects?.some(item => item.object_id === objectId) ? objectId : "";
        if (!fromViewer) this.viewer.select(this.selectedObjectId);
        this._renderObjects();
        this._scheduleStateSave();
    }

    _renderObjects() {
        const query = this.els.objectSearch.value.trim().toLowerCase();
        const objects = (this.scene?.objects || []).filter(item => !query || item.name.toLowerCase().includes(query));
        this.els.objectList.replaceChildren();
        if (!objects.length) {
            this.els.objectList.appendChild(element("div", "vnccs-i3s__tree-empty", query ? "No matching objects." : "Generated objects will appear here."));
            return;
        }
        for (const item of objects) {
            const viewportFailure = this.viewportFailures.get(item.object_id) || "";
            const card = element(
                "div",
                `vnccs-i3s__object`
                    + `${item.object_id === this.selectedObjectId ? " is-selected" : ""}`
                    + `${viewportFailure ? " has-viewport-error" : ""}`,
            );
            card.tabIndex = 0;
            card.dataset.objectId = item.object_id;
            if (viewportFailure) card.title = `Viewport failed: ${viewportFailure}`;
            const thumbnail = element("img", "vnccs-i3s__object-thumb");
            thumbnail.src = apiUrl(item.urls.thumbnail);
            thumbnail.alt = "";
            const copy = element("div", "vnccs-i3s__object-copy");
            const conditioning = Number(
                item.settings?.effective_conditioning_resolution
                || item.settings?.conditioning_resolution,
            );
            copy.append(
                element("div", "vnccs-i3s__object-name", item.name),
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
            const ply = button("vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__icon-button", "", "download");
            ply.title = "Export transformed PLY";
            ply.addEventListener("click", event => {
                event.stopPropagation();
                download(item.urls.export_ply);
            });
            const splat = button("vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__icon-button", "", "cube");
            splat.title = "Export transformed SPLAT";
            splat.setAttribute("aria-label", splat.title);
            splat.addEventListener("click", event => {
                event.stopPropagation();
                download(item.urls.export_splat);
            });
            ply.setAttribute("aria-label", ply.title);
            const duplicate = button("vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__icon-button", "", "duplicate");
            duplicate.title = "Duplicate object";
            duplicate.setAttribute("aria-label", duplicate.title);
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
            remove.setAttribute("aria-label", remove.title);
            remove.addEventListener("click", event => {
                event.stopPropagation();
                this.confirmDeleteObject(item.object_id);
            });
            actions.append(ply, splat, duplicate, remove);
            card.append(thumbnail, copy, actions);
            card.addEventListener("click", () => this._selectObject(item.object_id));
            card.addEventListener("keydown", event => {
                if (
                    event.target === card
                    && (event.key === "Enter" || event.key === " ")
                ) {
                    event.preventDefault();
                    this._selectObject(item.object_id);
                }
            });
            this.els.objectList.appendChild(card);
        }
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
        return {
            name: this.els.sceneName.value.trim() || this.scene?.name || "Untitled scene",
            objects: (this.scene?.objects || []).map(item => ({
                object_id: item.object_id,
                name: item.name,
                transform: item.transform,
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
                this.scene.updated_at = updated.updated_at;
                this.scene.exports = updated.exports;
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

    async _saveScenePreviewNow() {
        clearTimeout(this._previewSaveTimer);
        this._previewSaveTimer = 0;
        if (this.destroyed || !this.sceneId || !this.scene?.objects?.length) return null;
        const sceneId = this.sceneId;
        const operation = this._previewSaveSerial.then(async () => {
            if (this.destroyed || this.sceneId !== sceneId || !this.scene?.objects?.length) return null;
            // Commit transforms first so the preview revision always describes
            // the same scene state that the graph will export.
            await this._saveSceneNow({ showError: false });
            if (this.destroyed || this.sceneId !== sceneId) return null;
            const blob = await this.viewer.capturePreview({ maxSide: 1280 });
            if (!blob || this.destroyed || this.sceneId !== sceneId) return null;
            const form = new FormData();
            form.append("image", blob, "scene-preview.png");
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
        if (!this.scene?.objects?.length) {
            this.toast("Add at least one object to the scene.", "error");
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
            settings: { ...this.settings },
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
            this.settings = { ...DEFAULT_SETTINGS, ...safeObject(state.settings) };
            if (![1024, 1536, 2048].includes(Number(this.settings.conditioning_resolution))) {
                this.settings.conditioning_resolution = 1024;
            } else {
                this.settings.conditioning_resolution = Number(this.settings.conditioning_resolution);
            }
            this.settings.prevent_upscale = this.settings.prevent_upscale === true;
            this.viewerState = { ...this.viewerState, ...safeObject(state.viewer_state) };
            this._syncSettings();
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
