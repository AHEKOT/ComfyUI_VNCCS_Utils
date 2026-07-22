/**
 * VNCCS Img2ThreeJS Studio
 *
 * A node-bound, fully graphical ComfyUI studio for the img2threejs pipeline.
 * The viewer consumes declarative scene specifications only. Generated source
 * code is treated as a downloadable artifact and is never executed here.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { installCustomSelects } from "./vnccs_custom_select.mjs";
import {
    VNCCSImg2ThreeJSViewer as Img2ThreeJSViewer,
} from "./vnccs_img2threejs_viewer.js";

const API_BASE = "/vnccs/img2threejs";

// Keep every backend route here. The backend contract can be adapted without
// touching UI/event code below.
export const IMG2THREEJS_ENDPOINTS = Object.freeze({
    capabilities: `${API_BASE}/capabilities`,
    models: provider => `${API_BASE}/models?provider=${encodeURIComponent(provider || "")}`,
    uploadModel: `${API_BASE}/models/upload`,
    generate: `${API_BASE}/generate`,
    refine: projectId => `${API_BASE}/projects/${encodeURIComponent(projectId)}/refine`,
    project: projectId => `${API_BASE}/projects/${encodeURIComponent(projectId)}`,
    preview: projectId => `${API_BASE}/projects/${encodeURIComponent(projectId)}/preview`,
    job: jobId => `${API_BASE}/jobs/${encodeURIComponent(jobId)}`,
    cancelJob: jobId => `${API_BASE}/jobs/${encodeURIComponent(jobId)}/cancel`,
    artifact: artifactId => `${API_BASE}/artifacts/${encodeURIComponent(artifactId)}/download`,
});

const STUDIO_SCHEMA_VERSION = 1;
const DEFAULT_NODE_SIZE = Object.freeze([1100, 760]);
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_MODEL_BYTES = 64 * 1024 * 1024 * 1024;
const POLL_INTERVAL_MS = 900;
const TERMINAL_SUCCESS = new Set(["success", "succeeded", "complete", "completed", "done"]);
const TERMINAL_FAILURE = new Set(["failed", "error", "cancelled", "canceled"]);

const PROVIDERS = Object.freeze({
    codex_cli: {
        label: "Codex CLI",
        description: "Use the authenticated Codex command-line session on this machine.",
        models: [{ value: "", label: "CLI default" }],
    },
    claude_api: {
        label: "Claude API",
        description: "Connect directly to Anthropic with a session-only API key.",
        models: [{ value: "", label: "API default" }],
    },
    claude_cli: {
        label: "Claude CLI",
        description: "Use the authenticated Claude Code command-line session.",
        models: [{ value: "", label: "CLI default" }],
    },
    openai: {
        label: "OpenAI API",
        description: "Use OpenAI Responses or a server-approved endpoint.",
        models: [{ value: "", label: "API default" }],
    },
    azure_openai: {
        label: "Azure OpenAI",
        description: "Use an Azure deployment and API version.",
        models: [{ value: "", label: "Deployment default" }],
    },
    local_gguf: {
        label: "Local GGUF",
        description: "Run a vision-capable GGUF and mmproj through llama.cpp.",
        models: [{ value: "", label: "Select a local model" }],
    },
});

const DEFAULT_PROVIDER_CONFIGS = Object.freeze({
    codex_cli: { model: "", custom_model: "" },
    claude_api: { model: "", base_url: "", max_tokens: 16384, api_key: "" },
    claude_cli: { model: "", custom_model: "" },
    openai: { model: "", base_url: "https://api.openai.com/v1", api_key: "" },
    azure_openai: { model: "", endpoint: "", deployment: "", api_version: "", api_key: "" },
    local_gguf: {
        model: "",
        mmproj: "",
        context_size: 32768,
        gpu_layers: -1,
        threads: 0,
    },
});

const PUBLIC_PROVIDER_FIELDS = Object.freeze({
    codex_cli: ["model", "custom_model"],
    claude_api: ["model", "custom_model", "base_url", "max_tokens"],
    claude_cli: ["model", "custom_model"],
    openai: ["model", "custom_model", "base_url"],
    azure_openai: ["model", "endpoint", "deployment", "api_version"],
    local_gguf: ["model", "mmproj", "context_size", "gpu_layers", "threads"],
});

const DEFAULT_REQUEST = Object.freeze({
    prompt: "Rebuild the subject faithfully as a procedural, animation-ready Three.js model.",
    negative_prompt: "",
    subject_type: "auto",
    quality_profile: "strict",
    review_cycles: 4,
    quality_threshold: 0.86,
    texture_projection: false,
    output_format: "both",
    seed: -1,
});

const ICONS = Object.freeze({
    upload: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0 4.5 4.5M12 4 7.5 8.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></svg>`,
    image: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 3.5 3.5 2-2L20 19"/></svg>`,
    cube: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 8 4.5v9L12 20l-8-4.5v-9L12 2Z"/><path d="m4.4 6.7 7.6 4.2 7.6-4.2M12 11v9"/></svg>`,
    fit: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5m13 5h5v-5"/></svg>`,
    wire: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 8 4.5v9L12 20l-8-4.5v-9L12 2Z"/><path d="m4 6.5 8 4.5 8-4.5M12 11v9M8 4.2l8 13.6m0-13.6L8 17.8"/></svg>`,
    grid: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16M3 10h18M2 15h20M1 20h22M7 3 5 21m6-18-1 18m7-18 2 18m-6-18 1 18"/></svg>`,
    camera: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h3l1.4-2h7.2L17 7h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="4"/></svg>`,
    settings: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 9 19.37a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63 1.7 1.7 0 0 0 10 3.08V3h4v.08A1.7 1.7 0 0 0 15 4.63a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9 1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z"/></svg>`,
    play: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7V5Z"/></svg>`,
    refine: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 8.5 6M21 3v6h-6"/><path d="m9 12 2 2 4-5"/></svg>`,
    stop: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`,
    download: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16"/></svg>`,
    close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>`,
    search: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>`,
    chevron: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`,
    check: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>`,
    warning: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5m0 3v.01"/></svg>`,
});

const STYLES = `
/* ===== VNCCS Img2ThreeJS Studio — scoped Sakura UI ===== */
.vnccs-i3s {
    --i3-bg: #09090e;
    --i3-panel: rgba(16, 14, 24, .94);
    --i3-raised: #1a1925;
    --i3-surface: rgba(255, 255, 255, .045);
    --i3-hover: rgba(255, 255, 255, .075);
    --i3-line: rgba(255, 255, 255, .075);
    --i3-line-strong: rgba(255, 255, 255, .14);
    --i3-pink: #ff8fa3;
    --i3-pink-hi: #ffc1cf;
    --i3-pink-soft: rgba(255, 143, 163, .11);
    --i3-pink-line: rgba(255, 143, 163, .27);
    --i3-lavender: #b8a9e8;
    --i3-green: #00d68f;
    --i3-amber: #ffaa00;
    --i3-red: #ff5b6b;
    --i3-text: #e9e8f1;
    --i3-muted: #9a98aa;
    --i3-dim: #626073;
    --i3-font: 'Sora', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --i3-mono: 'JetBrains Mono', 'SFMono-Regular', Consolas, monospace;
    --i3-scale: 1;
    --i3-radius-sm: calc(7px * var(--i3-scale));
    --i3-radius: calc(11px * var(--i3-scale));
    --i3-radius-lg: calc(15px * var(--i3-scale));
    position: relative;
    display: grid;
    grid-template-columns: minmax(205px, 23fr) minmax(330px, 52fr) minmax(220px, 25fr);
    width: 100%;
    height: 100%;
    min-height: 610px;
    overflow: hidden;
    box-sizing: border-box;
    border: 1px solid rgba(255, 143, 163, .1);
    border-radius: 11px;
    background:
        radial-gradient(circle at 50% -20%, rgba(184,169,232,.1), transparent 42%),
        var(--i3-bg);
    color: var(--i3-text);
    font: calc(11px * var(--i3-scale))/1.42 var(--i3-font);
    isolation: isolate;
    pointer-events: auto;
    user-select: none;
}
.vnccs-i3s *, .vnccs-i3s *::before, .vnccs-i3s *::after { box-sizing: border-box; }
.vnccs-i3s button, .vnccs-i3s input, .vnccs-i3s textarea, .vnccs-i3s select { font: inherit; }
.vnccs-i3s button, .vnccs-i3s [role="button"] { -webkit-tap-highlight-color: transparent; }
.vnccs-i3s svg { display: block; width: 1.3em; height: 1.3em; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.vnccs-i3s :focus-visible { outline: 2px solid var(--i3-pink); outline-offset: 2px; }
.vnccs-i3s ::-webkit-scrollbar { width: 5px; height: 5px; }
.vnccs-i3s ::-webkit-scrollbar-track { background: transparent; }
.vnccs-i3s ::-webkit-scrollbar-thumb { border-radius: 8px; background: rgba(255,143,163,.24); }

.vnccs-i3s__side {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: calc(8px * var(--i3-scale));
    padding: calc(10px * var(--i3-scale));
    overflow: hidden auto;
    background: linear-gradient(180deg, rgba(19,16,29,.96), rgba(10,9,15,.94));
}
.vnccs-i3s__side--left { border-right: 1px solid var(--i3-line); }
.vnccs-i3s__side--right { border-left: 1px solid rgba(184,169,232,.16); }
.vnccs-i3s__center { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; position: relative; }

.vnccs-i3s__brand { display: flex; align-items: center; gap: 9px; min-height: 34px; padding: 2px 2px 7px; }
.vnccs-i3s__brand-mark { width: 29px; height: 29px; display: grid; place-items: center; flex: none; border: 1px solid var(--i3-pink-line); border-radius: 9px; background: linear-gradient(145deg, rgba(255,143,163,.17), rgba(184,169,232,.08)); color: var(--i3-pink-hi); box-shadow: 0 0 20px rgba(255,143,163,.09); }
.vnccs-i3s__brand-mark svg { width: 17px; height: 17px; }
.vnccs-i3s__brand-copy { min-width: 0; }
.vnccs-i3s__brand-title { font-weight: 750; letter-spacing: .02em; font-size: 1.12em; color: #f7f3fa; }
.vnccs-i3s__brand-subtitle { color: var(--i3-dim); font-size: .82em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.vnccs-i3s__section { flex: none; border: 1px solid var(--i3-line); border-radius: var(--i3-radius); background: rgba(255,255,255,.018); overflow: visible; }
.vnccs-i3s__section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: calc(8px * var(--i3-scale)) calc(9px * var(--i3-scale)); color: var(--i3-muted); text-transform: uppercase; letter-spacing: .11em; font-weight: 750; font-size: .77em; }
.vnccs-i3s__section-head::before { content: ""; width: 3px; height: 12px; border-radius: 3px; background: linear-gradient(var(--i3-pink), var(--i3-lavender)); box-shadow: 0 0 9px rgba(255,143,163,.25); }
.vnccs-i3s__section-head > span:first-of-type { flex: 1; }
.vnccs-i3s__section-body { display: flex; flex-direction: column; gap: calc(8px * var(--i3-scale)); padding: 0 calc(9px * var(--i3-scale)) calc(9px * var(--i3-scale)); }
.vnccs-i3s__hint { color: var(--i3-dim); font-size: .83em; line-height: 1.45; }

.vnccs-i3s__dropzone { position: relative; display: grid; min-height: calc(146px * var(--i3-scale)); place-items: center; overflow: hidden; border: 1px dashed var(--i3-pink-line); border-radius: var(--i3-radius); background: radial-gradient(circle at 50% 30%, rgba(255,143,163,.08), transparent 65%), #0b0a11; cursor: pointer; transition: border-color .18s ease, background .18s ease, transform .18s ease; }
.vnccs-i3s__dropzone:hover, .vnccs-i3s__dropzone.is-dragging { border-color: rgba(255,143,163,.65); background-color: #100d17; }
.vnccs-i3s__dropzone.is-dragging { transform: scale(.985); }
.vnccs-i3s__drop-empty { display: flex; flex-direction: column; align-items: center; gap: 7px; max-width: 180px; padding: 16px; text-align: center; color: var(--i3-muted); }
.vnccs-i3s__drop-icon { display: grid; place-items: center; width: 37px; height: 37px; border-radius: 12px; background: var(--i3-pink-soft); color: var(--i3-pink-hi); }
.vnccs-i3s__drop-title { color: var(--i3-text); font-weight: 700; }
.vnccs-i3s__drop-meta { color: var(--i3-dim); font-size: .8em; }
.vnccs-i3s__source-preview { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #08070c; display: none; }
.vnccs-i3s__dropzone.has-image .vnccs-i3s__source-preview { display: block; }
.vnccs-i3s__dropzone.has-image .vnccs-i3s__drop-empty { display: none; }
.vnccs-i3s__source-overlay { position: absolute; left: 7px; right: 7px; bottom: 7px; display: none; align-items: center; justify-content: space-between; gap: 6px; padding: 6px 7px; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; background: rgba(8,7,12,.82); backdrop-filter: blur(8px); }
.vnccs-i3s__dropzone.has-image:hover .vnccs-i3s__source-overlay, .vnccs-i3s__dropzone.has-image:focus-within .vnccs-i3s__source-overlay { display: flex; }
.vnccs-i3s__source-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--i3-muted); font-size: .79em; }
.vnccs-i3s__file-input { position: absolute !important; width: 1px !important; height: 1px !important; opacity: 0 !important; pointer-events: none !important; }

.vnccs-i3s__field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.vnccs-i3s__field-row { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 7px; }
.vnccs-i3s__label { display: flex; align-items: center; justify-content: space-between; gap: 6px; color: var(--i3-muted); font-weight: 650; font-size: .78em; text-transform: uppercase; letter-spacing: .07em; }
.vnccs-i3s__input, .vnccs-i3s__select, .vnccs-i3s__textarea { width: 100%; min-width: 0; border: 1px solid var(--i3-line); border-radius: var(--i3-radius-sm); background: var(--i3-surface); color: var(--i3-text); transition: border-color .16s ease, box-shadow .16s ease, background .16s ease; color-scheme: dark; user-select: text; }
.vnccs-i3s__input, .vnccs-i3s__select { min-height: calc(31px * var(--i3-scale)); padding: 5px 8px; }
.vnccs-i3s__textarea { min-height: calc(72px * var(--i3-scale)); max-height: 170px; resize: vertical; padding: 8px; line-height: 1.45; }
.vnccs-i3s__input:hover, .vnccs-i3s__select:hover, .vnccs-i3s__textarea:hover { border-color: var(--i3-line-strong); }
.vnccs-i3s__input:focus, .vnccs-i3s__select:focus, .vnccs-i3s__textarea:focus { outline: none; border-color: var(--i3-pink-line); background: rgba(255,143,163,.045); box-shadow: 0 0 0 3px rgba(255,143,163,.06); }
.vnccs-i3s__input::placeholder, .vnccs-i3s__textarea::placeholder { color: var(--i3-dim); }
.vnccs-i3s__select option { background: #17141f; color: var(--i3-text); }
.vnccs-i3s__range-row { display: grid; grid-template-columns: minmax(0,1fr) 44px; gap: 7px; align-items: center; }
.vnccs-i3s__range { width: 100%; accent-color: var(--i3-pink); }
.vnccs-i3s__range-value { font: .87em var(--i3-mono); color: var(--i3-pink-hi); text-align: right; }
.vnccs-i3s__switch-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 0; color: var(--i3-muted); }
.vnccs-i3s__switch { width: 31px; height: 17px; flex: none; padding: 2px; border: 1px solid var(--i3-line-strong); border-radius: 99px; background: rgba(255,255,255,.045); cursor: pointer; transition: .18s ease; }
.vnccs-i3s__switch::after { content: ""; display: block; width: 11px; height: 11px; border-radius: 50%; background: var(--i3-muted); transition: transform .18s ease, background .18s ease; }
.vnccs-i3s__switch[aria-checked="true"] { border-color: var(--i3-pink-line); background: var(--i3-pink-soft); }
.vnccs-i3s__switch[aria-checked="true"]::after { transform: translateX(14px); background: var(--i3-pink); box-shadow: 0 0 8px rgba(255,143,163,.42); }

.vnccs-i3s__button { min-height: calc(31px * var(--i3-scale)); display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 6px 10px; border: 1px solid var(--i3-line-strong); border-radius: var(--i3-radius-sm); background: var(--i3-surface); color: var(--i3-text); font-weight: 700; cursor: pointer; transition: transform .14s ease, border-color .14s ease, background .14s ease, color .14s ease; }
.vnccs-i3s__button:hover:not(:disabled) { border-color: var(--i3-pink-line); background: var(--i3-hover); color: var(--i3-pink-hi); }
.vnccs-i3s__button:active:not(:disabled) { transform: translateY(1px); }
.vnccs-i3s__button:disabled { opacity: .38; cursor: not-allowed; }
.vnccs-i3s__button--primary { border-color: transparent; background: linear-gradient(135deg, #ff8299, #ffb6c8); color: #21151c; box-shadow: 0 5px 18px rgba(255,143,163,.18); }
.vnccs-i3s__button--primary:hover:not(:disabled) { border-color: transparent; background: linear-gradient(135deg, #ff95a8, #ffd0da); color: #21151c; }
.vnccs-i3s__button--danger { border-color: rgba(255,91,107,.28); color: #ff9ba6; background: rgba(255,91,107,.08); }
.vnccs-i3s__button--quiet { border-color: transparent; background: transparent; color: var(--i3-muted); box-shadow: none; }
.vnccs-i3s__button--block { width: 100%; }
.vnccs-i3s__button svg { flex: none; }
.vnccs-i3s__actions { display: grid; grid-template-columns: minmax(0,1.35fr) minmax(0,1fr); gap: 7px; }

.vnccs-i3s__provider-card { display: flex; align-items: center; gap: 8px; padding: 8px; border: 1px solid var(--i3-line); border-radius: var(--i3-radius-sm); background: rgba(255,255,255,.025); }
.vnccs-i3s__provider-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--i3-dim); box-shadow: 0 0 0 3px rgba(98,96,115,.12); }
.vnccs-i3s__provider-dot.is-ready { background: var(--i3-green); box-shadow: 0 0 0 3px rgba(0,214,143,.11); }
.vnccs-i3s__provider-copy { flex: 1; min-width: 0; }
.vnccs-i3s__provider-name { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vnccs-i3s__provider-model { color: var(--i3-dim); font: .77em var(--i3-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vnccs-i3s__icon-button { width: calc(30px * var(--i3-scale)); min-width: calc(30px * var(--i3-scale)); height: calc(30px * var(--i3-scale)); min-height: 0; padding: 0; }

.vnccs-i3s__topbar { height: calc(43px * var(--i3-scale)); min-height: 38px; display: flex; align-items: center; gap: 9px; padding: 0 calc(10px * var(--i3-scale)); border-bottom: 1px solid var(--i3-line); background: rgba(12,10,17,.86); }
.vnccs-i3s__crumb { min-width: 0; flex: 1; display: flex; align-items: center; gap: 7px; color: var(--i3-muted); }
.vnccs-i3s__crumb-icon { color: var(--i3-lavender); }
.vnccs-i3s__project-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--i3-text); font-weight: 700; }
.vnccs-i3s__project-id { flex: none; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: .76em var(--i3-mono); color: var(--i3-dim); }
.vnccs-i3s__status-group { flex: none; display: flex; align-items: center; gap: 6px; }
.vnccs-i3s__diagnostics-open[hidden] { display: none; }
.vnccs-i3s__status-pill { flex: none; display: inline-flex; align-items: center; gap: 6px; min-height: 23px; padding: 3px 8px; border: 1px solid var(--i3-line); border-radius: 99px; color: var(--i3-muted); background: rgba(255,255,255,.025); font-size: .78em; font-weight: 700; }
.vnccs-i3s__status-pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--i3-dim); }
.vnccs-i3s__status-pill[data-tone="working"]::before { background: var(--i3-pink); box-shadow: 0 0 8px var(--i3-pink); animation: vnccs-i3s-pulse 1.2s ease infinite; }
.vnccs-i3s__status-pill[data-tone="success"]::before { background: var(--i3-green); }
.vnccs-i3s__status-pill[data-tone="error"]::before { background: var(--i3-red); }

.vnccs-i3s__viewport { position: relative; flex: 1; min-height: 0; overflow: hidden; background: radial-gradient(circle at 50% 42%, rgba(184,169,232,.08), transparent 42%), #08080d; }
.vnccs-i3s__viewer-host { position: absolute; inset: 0; overflow: hidden; }
.vnccs-i3s__viewer-host > canvas { display: block; width: 100%; height: 100%; }
.vnccs-i3s__empty-view { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 28px; text-align: center; color: var(--i3-dim); pointer-events: none; }
.vnccs-i3s__empty-view-icon { width: 54px; height: 54px; display: grid; place-items: center; border: 1px solid rgba(184,169,232,.16); border-radius: 18px; background: rgba(184,169,232,.055); color: rgba(184,169,232,.6); }
.vnccs-i3s__empty-view-icon svg { width: 27px; height: 27px; }
.vnccs-i3s__empty-view-title { color: var(--i3-muted); font-weight: 700; }
.vnccs-i3s.has-scene .vnccs-i3s__empty-view { display: none; }
.vnccs-i3s__toolbar { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); z-index: 4; display: flex; align-items: center; gap: 4px; max-width: calc(100% - 20px); padding: 4px; border: 1px solid rgba(255,255,255,.1); border-radius: 10px; background: rgba(15,13,21,.78); box-shadow: 0 8px 28px rgba(0,0,0,.3); backdrop-filter: blur(9px); }
.vnccs-i3s__tool { width: 29px; height: 27px; display: grid; place-items: center; flex: none; padding: 0; border: 0; border-radius: 7px; background: transparent; color: var(--i3-muted); cursor: pointer; }
.vnccs-i3s__tool:hover { color: var(--i3-text); background: rgba(255,255,255,.08); }
.vnccs-i3s__tool[aria-pressed="true"] { color: var(--i3-pink-hi); background: var(--i3-pink-soft); }
.vnccs-i3s__tool-separator { width: 1px; height: 17px; flex: none; background: var(--i3-line-strong); margin: 0 2px; }
.vnccs-i3s__toolbar .vnccs-i3s__select { width: 94px; min-height: 27px; height: 27px; padding: 2px 6px; border: 0; background: transparent; color: var(--i3-muted); font-size: .82em; }
.vnccs-i3s__viewport-help { position: absolute; left: 10px; bottom: 9px; z-index: 3; color: rgba(154,152,170,.55); font-size: .74em; pointer-events: none; }

.vnccs-i3s__progress { position: absolute; left: 12px; right: 12px; bottom: 12px; z-index: 5; display: none; align-items: center; gap: 10px; padding: 9px 10px; border: 1px solid var(--i3-pink-line); border-radius: 10px; background: rgba(16,13,23,.91); box-shadow: 0 12px 32px rgba(0,0,0,.4); backdrop-filter: blur(10px); }
.vnccs-i3s__progress.is-visible { display: flex; }
.vnccs-i3s__progress-copy { flex: 1; min-width: 0; }
.vnccs-i3s__progress-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 5px; }
.vnccs-i3s__progress-stage { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--i3-text); font-weight: 700; }
.vnccs-i3s__progress-percent { flex: none; color: var(--i3-pink-hi); font: .8em var(--i3-mono); }
.vnccs-i3s__progress-track { height: 5px; overflow: hidden; border-radius: 8px; background: rgba(255,255,255,.08); }
.vnccs-i3s__progress-bar { width: 0%; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--i3-pink), var(--i3-lavender)); box-shadow: 0 0 12px rgba(255,143,163,.35); transition: width .25s ease; }

.vnccs-i3s__search { position: relative; }
.vnccs-i3s__search svg { position: absolute; left: 8px; top: 50%; width: 13px; height: 13px; transform: translateY(-50%); color: var(--i3-dim); pointer-events: none; }
.vnccs-i3s__search .vnccs-i3s__input { padding-left: 27px; }
.vnccs-i3s__hierarchy { min-height: 90px; max-height: 220px; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.vnccs-i3s__tree-empty { padding: 12px 7px; color: var(--i3-dim); text-align: center; font-size: .84em; }
.vnccs-i3s__tree-row { width: 100%; min-height: 27px; display: flex; align-items: center; gap: 5px; padding: 4px 7px 4px calc(7px + var(--tree-depth, 0) * 12px); border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--i3-muted); text-align: left; cursor: pointer; }
.vnccs-i3s__tree-row:hover { background: rgba(255,255,255,.045); color: var(--i3-text); }
.vnccs-i3s__tree-row.is-selected { border-color: var(--i3-pink-line); background: var(--i3-pink-soft); color: var(--i3-pink-hi); }
.vnccs-i3s__tree-row svg { width: 11px; height: 11px; color: var(--i3-dim); }
.vnccs-i3s__tree-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vnccs-i3s__tree-type { color: var(--i3-dim); font: .68em var(--i3-mono); text-transform: uppercase; }

.vnccs-i3s__quality-summary { display: grid; grid-template-columns: 54px minmax(0,1fr); gap: 9px; align-items: center; }
.vnccs-i3s__quality-ring { --score: 0deg; width: 52px; height: 52px; display: grid; place-items: center; border-radius: 50%; background: conic-gradient(var(--i3-pink) var(--score), rgba(255,255,255,.07) 0); position: relative; }
.vnccs-i3s__quality-ring::before { content: ""; position: absolute; inset: 5px; border-radius: inherit; background: #13111b; }
.vnccs-i3s__quality-value { z-index: 1; font: 700 .86em var(--i3-mono); color: var(--i3-text); }
.vnccs-i3s__quality-title { font-weight: 750; }
.vnccs-i3s__quality-note { color: var(--i3-dim); font-size: .8em; }
.vnccs-i3s__metric-list { display: flex; flex-direction: column; gap: 5px; }
.vnccs-i3s__metric { display: grid; grid-template-columns: minmax(0,1fr) 38px; gap: 7px; align-items: center; }
.vnccs-i3s__metric-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--i3-muted); font-size: .82em; }
.vnccs-i3s__metric-value { text-align: right; color: var(--i3-text); font: .75em var(--i3-mono); }

.vnccs-i3s__artifacts { display: flex; flex-direction: column; gap: 6px; }
.vnccs-i3s__artifact { display: grid; grid-template-columns: 28px minmax(0,1fr) 28px; gap: 7px; align-items: center; min-height: 39px; padding: 5px 5px 5px 7px; border: 1px solid var(--i3-line); border-radius: 8px; background: rgba(255,255,255,.025); }
.vnccs-i3s__artifact-icon { color: var(--i3-lavender); }
.vnccs-i3s__artifact-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; }
.vnccs-i3s__artifact-meta { color: var(--i3-dim); font: .7em var(--i3-mono); text-transform: uppercase; }
.vnccs-i3s__artifact .vnccs-i3s__icon-button { width: 27px; min-width: 27px; height: 27px; }

.vnccs-i3s__busy { position: absolute; inset: 0; z-index: 20; display: none; align-items: center; justify-content: center; background: rgba(7,6,10,.38); backdrop-filter: blur(1px); pointer-events: auto; }
.vnccs-i3s__busy.is-visible { display: flex; }
.vnccs-i3s__busy-card { display: flex; align-items: center; gap: 10px; max-width: 75%; padding: 10px 13px; border: 1px solid var(--i3-pink-line); border-radius: 10px; background: rgba(20,17,28,.94); box-shadow: 0 14px 42px rgba(0,0,0,.45); color: var(--i3-text); font-weight: 650; }
.vnccs-i3s__spinner { width: 17px; height: 17px; flex: none; border: 2px solid rgba(255,143,163,.2); border-top-color: var(--i3-pink); border-radius: 50%; animation: vnccs-i3s-spin .72s linear infinite; }

.vnccs-i3s__toasts { position: absolute; top: 49px; right: 10px; z-index: 70; width: min(310px, calc(100% - 20px)); display: flex; flex-direction: column; align-items: flex-end; gap: 7px; pointer-events: none; }
.vnccs-i3s__toast { width: max-content; max-width: 100%; display: grid; grid-template-columns: 18px minmax(0,1fr); gap: 8px; padding: 9px 11px; border: 1px solid var(--i3-line-strong); border-radius: 9px; background: rgba(25,22,33,.97); box-shadow: 0 12px 34px rgba(0,0,0,.42); color: var(--i3-text); animation: vnccs-i3s-toast-in .18s ease both; pointer-events: auto; }
.vnccs-i3s__toast[data-tone="success"] { border-color: rgba(0,214,143,.28); }
.vnccs-i3s__toast[data-tone="error"] { border-color: rgba(255,91,107,.34); }
.vnccs-i3s__toast-icon { color: var(--i3-pink); }
.vnccs-i3s__toast[data-tone="success"] .vnccs-i3s__toast-icon { color: var(--i3-green); }
.vnccs-i3s__toast[data-tone="error"] .vnccs-i3s__toast-icon { color: var(--i3-red); }
.vnccs-i3s__toast-message { min-width: 0; overflow-wrap: anywhere; font-size: .86em; }

.vnccs-i3s__modal-layer { position: absolute; inset: 0; z-index: 80; display: none; align-items: center; justify-content: center; padding: 18px; background: rgba(6,5,9,.72); backdrop-filter: blur(5px); pointer-events: auto; }
.vnccs-i3s__modal-layer.is-open { display: flex; }
.vnccs-i3s__modal { width: min(560px, 96%); max-height: 92%; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--i3-pink-line); border-radius: 14px; background: linear-gradient(180deg, rgba(28,24,38,.99), rgba(15,13,21,.99)); box-shadow: 0 24px 80px rgba(0,0,0,.65); }
.vnccs-i3s__modal.is-wide { width: min(690px, 98%); }
.vnccs-i3s__modal-head { display: flex; align-items: center; gap: 9px; min-height: 49px; padding: 9px 12px 9px 15px; border-bottom: 1px solid var(--i3-line); }
.vnccs-i3s__modal-title { flex: 1; font-size: 1.08em; font-weight: 760; }
.vnccs-i3s__modal-body { min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 11px; padding: 14px 15px; user-select: text; }
.vnccs-i3s__modal-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 15px; border-top: 1px solid var(--i3-line); }
.vnccs-i3s__modal-note { display: flex; gap: 8px; padding: 8px 9px; border: 1px solid rgba(184,169,232,.16); border-radius: 8px; background: rgba(184,169,232,.055); color: var(--i3-muted); font-size: .83em; }
.vnccs-i3s__modal-note svg { flex: none; color: var(--i3-lavender); }
.vnccs-i3s__failure-summary { color: var(--i3-text); line-height: 1.5; }
.vnccs-i3s__failure-context { color: var(--i3-dim); font: .75em var(--i3-mono); overflow-wrap: anywhere; }
.vnccs-i3s__diagnostics { max-height: 310px; margin: 0; padding: 11px 12px; overflow: auto; border: 1px solid rgba(255,91,107,.24); border-radius: 9px; background: rgba(5,4,8,.72); color: #f4dce2; font: .76em/1.55 var(--i3-mono); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
.vnccs-i3s__provider-tabs { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 6px; }
.vnccs-i3s__provider-tab { min-height: 38px; padding: 6px 7px; border: 1px solid var(--i3-line); border-radius: 8px; background: rgba(255,255,255,.025); color: var(--i3-muted); font-weight: 700; cursor: pointer; }
.vnccs-i3s__provider-tab:hover { border-color: var(--i3-line-strong); color: var(--i3-text); }
.vnccs-i3s__provider-tab[aria-selected="true"] { border-color: var(--i3-pink-line); background: var(--i3-pink-soft); color: var(--i3-pink-hi); }
.vnccs-i3s__provider-description { color: var(--i3-muted); font-size: .86em; line-height: 1.5; }
.vnccs-i3s__provider-fields { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 9px; }
.vnccs-i3s__provider-fields .is-full { grid-column: 1 / -1; }
.vnccs-i3s__secret-wrap { position: relative; }
.vnccs-i3s__secret-wrap .vnccs-i3s__input { padding-right: 76px; }
.vnccs-i3s__secret-clear { position: absolute; right: 5px; top: 50%; min-height: 22px; padding: 2px 7px; transform: translateY(-50%); border: 0; border-radius: 6px; background: rgba(0,214,143,.1); color: var(--i3-green); font-size: .7em; font-weight: 750; text-transform: uppercase; letter-spacing: .05em; cursor: pointer; }
.vnccs-i3s__secret-clear:hover { background: rgba(255,91,107,.12); color: #ff9ba6; }
.vnccs-i3s__upload-row { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 7px; align-items: end; }
.vnccs-i3s__upload-progress { display: none; gap: 7px; align-items: center; color: var(--i3-muted); font-size: .82em; }
.vnccs-i3s__upload-progress.is-visible { display: flex; }

@keyframes vnccs-i3s-spin { to { transform: rotate(360deg); } }
@keyframes vnccs-i3s-pulse { 50% { opacity: .45; } }
@keyframes vnccs-i3s-toast-in { from { opacity: 0; transform: translateY(-5px); } }

@container (max-width: 880px) {
    .vnccs-i3s { grid-template-columns: minmax(180px, 25fr) minmax(290px, 50fr) minmax(190px, 25fr); }
    .vnccs-i3s__project-id, .vnccs-i3s__viewport-help { display: none; }
}
`;

function installStudioStyles() {
    const id = "vnccs-img2threejs-studio-styles";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = STYLES;
    document.head.appendChild(style);
}

function createElement(tag, className = "", text = "") {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null && text !== "") element.textContent = String(text);
    return element;
}

function button(className, label, icon = "") {
    const element = createElement("button", className);
    element.type = "button";
    if (icon && ICONS[icon]) element.insertAdjacentHTML("beforeend", ICONS[icon]);
    if (label) element.appendChild(createElement("span", "", label));
    return element;
}

function normalizeError(error, fallback = "The request could not be completed.") {
    const text = diagnosticText(error, fallback);
    return text.length > 800 ? `${text.slice(0, 797)}…` : text;
}

function diagnosticText(error, fallback = "The request could not be completed.") {
    const value = error?.error || error?.detail || error?.message || error;
    let text = "";
    if (typeof value === "string" || typeof value === "number") text = String(value);
    else if (value) {
        try { text = JSON.stringify(value, null, 2); } catch (_) { text = String(value); }
    }
    text = String(text || fallback).trim();
    return text.length > 6000 ? `${text.slice(0, 5997)}…` : text;
}

function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeClone(value, fallback = {}) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (_) {
        return fallback;
    }
}

function publicProviderConfig(type, value) {
    const source = isRecord(value) ? value : {};
    const output = {};
    for (const key of PUBLIC_PROVIDER_FIELDS[type] || []) {
        if (source[key] !== undefined && source[key] !== null) output[key] = safeClone(source[key], source[key]);
    }
    return output;
}

function clamp(value, minimum, maximum) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : minimum;
}

function formatBytes(value) {
    const size = Number(value);
    if (!Number.isFinite(size) || size <= 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let amount = size;
    let index = 0;
    while (amount >= 1024 && index < units.length - 1) {
        amount /= 1024;
        index += 1;
    }
    return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function normalizeStatus(value) {
    return String(value || "").trim().toLowerCase();
}

function responseJobId(data) {
    return data?.job_id || data?.jobId || data?.job?.id || (typeof data?.job === "string" ? data.job : "") || "";
}

function responseProjectId(data) {
    return data?.project_id || data?.projectId || data?.project?.project_id || data?.project?.id || data?.result?.project_id || "";
}

function responseSceneSpec(data) {
    return data?.scene_spec || data?.sceneSpec || data?.project?.scene_spec || data?.project?.sceneSpec || data?.result?.scene_spec || data?.result?.sceneSpec || null;
}

function normalizeModelEntries(values) {
    if (!Array.isArray(values)) return [];
    const seen = new Set();
    const result = [];
    for (const item of values) {
        const value = typeof item === "string"
            ? item
            : item?.value ?? item?.id ?? item?.path ?? item?.name ?? "";
        const key = String(value || "").trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push({
            value: key,
            label: String(typeof item === "string" ? item : item?.label || item?.name || item?.id || key),
            disabled: Boolean(typeof item === "object" && item?.available === false),
        });
    }
    return result;
}

function normalizeArtifacts(value) {
    let list = [];
    if (Array.isArray(value)) list = value;
    else if (isRecord(value)) {
        for (const [kind, entry] of Object.entries(value)) {
            if (Array.isArray(entry)) list.push(...entry.map(item => isRecord(item) ? { kind, ...item } : { kind, url: item }));
            else list.push(isRecord(entry) ? { kind, ...entry } : { kind, url: entry });
        }
    }
    return list.map((entry, index) => {
        const item = isRecord(entry) ? entry : { url: entry };
        const url = item.download_url || item.downloadUrl || item.url || "";
        const name = item.label || item.name || item.filename || String(url).split("/").pop() || `Artifact ${index + 1}`;
        return {
            id: item.id || item.artifact_id || "",
            kind: item.kind || item.type || String(name).split(".").pop() || "file",
            name: String(name),
            url: String(url || ""),
            size: item.size || item.bytes || 0,
        };
    }).filter(item => item.id || item.url);
}

function apiUrl(path) {
    if (!path) return "";
    if (/^(?:https?:|blob:|data:)/i.test(path)) return path;
    return typeof api.apiURL === "function" ? api.apiURL(path) : path;
}

function setSelectOptions(select, entries, selectedValue = "", emptyLabel = "No options available") {
    select.replaceChildren();
    const normalized = normalizeModelEntries(entries);
    if (!normalized.length) {
        const option = createElement("option", "", emptyLabel);
        option.value = "";
        select.appendChild(option);
    } else {
        for (const entry of normalized) {
            const option = createElement("option", "", entry.label);
            option.value = entry.value;
            option.disabled = entry.disabled;
            select.appendChild(option);
        }
    }
    const desired = String(selectedValue || "");
    if (desired && !Array.from(select.options).some(option => option.value === desired)) {
        const option = createElement("option", "", desired);
        option.value = desired;
        select.appendChild(option);
    }
    select.value = desired && Array.from(select.options).some(option => option.value === desired)
        ? desired
        : select.options[0]?.value || "";
    select.dispatchEvent(new Event("input", { bubbles: true }));
}

installStudioStyles();

class Img2ThreeJSStudioWidget {
    constructor(node) {
        this.node = node;
        this.destroyed = false;
        this.sourceFile = null;
        this.sourceObjectUrl = "";
        this.projectId = "";
        this.currentJobId = "";
        this.currentJobToken = 0;
        this.lastFailure = null;
        this.artifacts = [];
        this.hierarchy = null;
        this.selectedComponentId = "";
        this.quality = null;
        this.capabilities = null;
        this.hasScene = false;
        this.request = { ...DEFAULT_REQUEST };
        this.provider = { type: "codex_cli", model: "" };
        this.providerConfigs = Object.fromEntries(
            Object.entries(DEFAULT_PROVIDER_CONFIGS).map(([key, value]) => [key, { ...value }]),
        );
        this.viewerState = { grid: true, wireframe: false, environment: "studio" };
        this._pendingViewerState = null;
        this._providerModalType = this.provider.type;
        this._providerFormFields = new Map();
        this._providerModelRequestToken = 0;
        this._listeners = [];
        this._timers = new Set();
        this._abortControllers = new Set();
        this._saveTimer = null;
        this._pollTimer = null;
        this._resizeFrame = null;
        this._modalCleanup = null;
        this._previousModalFocus = null;
        this._busyCount = 0;
        this.viewer = null;

        this._createLayout();
        this._cacheElements();
        this._bindUI();
        this._customSelectController = installCustomSelects(this.container, { theme: "pose-studio" });
        this._createViewer();
        this._startResizeObserver();
        this._syncAllControls();
        this._setStatus("Ready", "idle");
        this._renderHierarchy();
        this._renderQuality();
        this._renderArtifacts();
        this._navigationCleanup = enableCanvasNavigationForwarding(this.container);
        void this._loadCapabilities();
    }

    _createLayout() {
        const root = createElement("div", "vnccs-i3s");
        root.style.containerType = "inline-size";
        root.setAttribute("aria-label", "VNCCS Img2ThreeJS Studio");
        root.innerHTML = `
            <aside class="vnccs-i3s__side vnccs-i3s__side--left" aria-label="Source and reconstruction settings">
                <div class="vnccs-i3s__brand">
                    <div class="vnccs-i3s__brand-mark">${ICONS.cube}</div>
                    <div class="vnccs-i3s__brand-copy">
                        <div class="vnccs-i3s__brand-title">Img2ThreeJS Studio</div>
                        <div class="vnccs-i3s__brand-subtitle">Procedural reconstruction</div>
                    </div>
                </div>

                <section class="vnccs-i3s__section">
                    <div class="vnccs-i3s__section-head"><span>Reference</span></div>
                    <div class="vnccs-i3s__section-body">
                        <div class="vnccs-i3s__dropzone" role="button" tabindex="0" aria-label="Choose or drop a reference image">
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
                    <div class="vnccs-i3s__section-head"><span>Agent</span></div>
                    <div class="vnccs-i3s__section-body">
                        <div class="vnccs-i3s__provider-card">
                            <span class="vnccs-i3s__provider-dot"></span>
                            <div class="vnccs-i3s__provider-copy">
                                <div class="vnccs-i3s__provider-name"></div>
                                <div class="vnccs-i3s__provider-model"></div>
                            </div>
                            <button class="vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__icon-button vnccs-i3s__provider-open" type="button" aria-label="Configure model provider" title="Configure provider">${ICONS.settings}</button>
                        </div>
                    </div>
                </section>

                <section class="vnccs-i3s__section">
                    <div class="vnccs-i3s__section-head"><span>Build brief</span></div>
                    <div class="vnccs-i3s__section-body">
                        <label class="vnccs-i3s__field">
                            <span class="vnccs-i3s__label">Instructions</span>
                            <textarea class="vnccs-i3s__textarea vnccs-i3s__prompt" spellcheck="true" maxlength="8000"></textarea>
                        </label>
                        <label class="vnccs-i3s__field">
                            <span class="vnccs-i3s__label">Avoid</span>
                            <textarea class="vnccs-i3s__textarea vnccs-i3s__negative" spellcheck="true" maxlength="4000" placeholder="Optional geometry, material, or style exclusions"></textarea>
                        </label>
                        <div class="vnccs-i3s__field-row">
                            <label class="vnccs-i3s__field">
                                <span class="vnccs-i3s__label">Subject</span>
                                <select class="vnccs-i3s__select vnccs-i3s__subject" aria-label="Subject type">
                                    <option value="auto">Auto detect</option>
                                    <option value="object">Object</option>
                                    <option value="character">Character</option>
                                    <option value="hybrid">Hybrid</option>
                                </select>
                            </label>
                            <label class="vnccs-i3s__field">
                                <span class="vnccs-i3s__label">Quality</span>
                                <select class="vnccs-i3s__select vnccs-i3s__quality-profile" aria-label="Quality profile">
                                    <option value="balanced">Balanced</option>
                                    <option value="strict">Strict</option>
                                    <option value="max">Maximum</option>
                                </select>
                            </label>
                        </div>
                        <label class="vnccs-i3s__field">
                            <span class="vnccs-i3s__label"><span>Review cycles</span><span class="vnccs-i3s__cycles-value">4</span></span>
                            <input class="vnccs-i3s__range vnccs-i3s__cycles" type="range" min="1" max="8" step="1" />
                        </label>
                        <label class="vnccs-i3s__field">
                            <span class="vnccs-i3s__label"><span>Acceptance score</span><span class="vnccs-i3s__threshold-value">86%</span></span>
                            <input class="vnccs-i3s__range vnccs-i3s__threshold" type="range" min="0.7" max="0.98" step="0.01" />
                        </label>
                        <div class="vnccs-i3s__switch-row">
                            <span>Projection-assisted texture</span>
                            <button class="vnccs-i3s__switch vnccs-i3s__texture-toggle" type="button" role="switch" aria-checked="false" aria-label="Projection-assisted texture"></button>
                        </div>
                        <label class="vnccs-i3s__field">
                            <span class="vnccs-i3s__label">Seed</span>
                            <input class="vnccs-i3s__input vnccs-i3s__seed" type="number" min="-1" max="2147483647" step="1" />
                        </label>
                        <div class="vnccs-i3s__actions">
                            <button class="vnccs-i3s__button vnccs-i3s__button--primary vnccs-i3s__generate" type="button">${ICONS.play}<span>Generate</span></button>
                            <button class="vnccs-i3s__button vnccs-i3s__refine" type="button">${ICONS.refine}<span>Refine</span></button>
                        </div>
                    </div>
                </section>
            </aside>

            <main class="vnccs-i3s__center">
                <header class="vnccs-i3s__topbar">
                    <div class="vnccs-i3s__crumb">
                        <span class="vnccs-i3s__crumb-icon">${ICONS.cube}</span>
                        <span class="vnccs-i3s__project-name">Untitled reconstruction</span>
                        <span class="vnccs-i3s__project-id"></span>
                    </div>
                    <div class="vnccs-i3s__status-group">
                        <button class="vnccs-i3s__button vnccs-i3s__button--danger vnccs-i3s__diagnostics-open" type="button" hidden>Diagnostics</button>
                        <div class="vnccs-i3s__status-pill" data-tone="idle" role="status" aria-live="polite">Ready</div>
                    </div>
                </header>
                <div class="vnccs-i3s__viewport">
                    <div class="vnccs-i3s__viewer-host" aria-label="3D model viewport"></div>
                    <div class="vnccs-i3s__empty-view">
                        <div class="vnccs-i3s__empty-view-icon">${ICONS.cube}</div>
                        <div class="vnccs-i3s__empty-view-title">Your procedural model will appear here</div>
                        <div>Choose a reference, configure an agent, then generate.</div>
                    </div>
                    <div class="vnccs-i3s__toolbar" role="toolbar" aria-label="Viewport controls">
                        <button class="vnccs-i3s__tool vnccs-i3s__fit" type="button" aria-label="Fit model" title="Fit model">${ICONS.fit}</button>
                        <button class="vnccs-i3s__tool vnccs-i3s__wireframe" type="button" aria-label="Toggle wireframe" aria-pressed="false" title="Wireframe">${ICONS.wire}</button>
                        <button class="vnccs-i3s__tool vnccs-i3s__grid" type="button" aria-label="Toggle grid" aria-pressed="true" title="Grid">${ICONS.grid}</button>
                        <span class="vnccs-i3s__tool-separator"></span>
                        <select class="vnccs-i3s__select vnccs-i3s__environment" aria-label="Viewport environment" title="Environment">
                            <option value="studio">Studio</option>
                            <option value="neutral">Neutral</option>
                            <option value="warm">Warm</option>
                            <option value="dark">Dark</option>
                        </select>
                        <span class="vnccs-i3s__tool-separator"></span>
                        <button class="vnccs-i3s__tool vnccs-i3s__preview-upload" type="button" aria-label="Upload viewport preview" title="Upload viewport preview">${ICONS.camera}</button>
                    </div>
                    <div class="vnccs-i3s__viewport-help">Select: left click · Orbit: right drag · Pan: middle drag · Zoom: wheel</div>
                    <div class="vnccs-i3s__progress" role="status" aria-live="polite">
                        <div class="vnccs-i3s__progress-copy">
                            <div class="vnccs-i3s__progress-head">
                                <span class="vnccs-i3s__progress-stage">Preparing pipeline</span>
                                <span class="vnccs-i3s__progress-percent">0%</span>
                            </div>
                            <div class="vnccs-i3s__progress-track"><div class="vnccs-i3s__progress-bar"></div></div>
                        </div>
                        <button class="vnccs-i3s__button vnccs-i3s__button--danger vnccs-i3s__cancel-job" type="button">${ICONS.stop}<span>Cancel</span></button>
                    </div>
                </div>
            </main>

            <aside class="vnccs-i3s__side vnccs-i3s__side--right" aria-label="Hierarchy, quality, and output">
                <section class="vnccs-i3s__section">
                    <div class="vnccs-i3s__section-head"><span>Hierarchy</span><span class="vnccs-i3s__hierarchy-count">0</span></div>
                    <div class="vnccs-i3s__section-body">
                        <label class="vnccs-i3s__search">
                            ${ICONS.search}
                            <input class="vnccs-i3s__input vnccs-i3s__hierarchy-search" type="search" placeholder="Filter components" aria-label="Filter hierarchy" />
                        </label>
                        <div class="vnccs-i3s__hierarchy" role="tree" aria-label="Model component hierarchy"></div>
                    </div>
                </section>

                <section class="vnccs-i3s__section">
                    <div class="vnccs-i3s__section-head"><span>Quality gate</span></div>
                    <div class="vnccs-i3s__section-body">
                        <div class="vnccs-i3s__quality-summary">
                            <div class="vnccs-i3s__quality-ring"><span class="vnccs-i3s__quality-value">—</span></div>
                            <div><div class="vnccs-i3s__quality-title">Not evaluated</div><div class="vnccs-i3s__quality-note">Scores arrive after visual review.</div></div>
                        </div>
                        <div class="vnccs-i3s__metric-list"></div>
                    </div>
                </section>

                <section class="vnccs-i3s__section">
                    <div class="vnccs-i3s__section-head"><span>Output</span><span class="vnccs-i3s__artifact-count">0</span></div>
                    <div class="vnccs-i3s__section-body">
                        <div class="vnccs-i3s__artifacts"></div>
                        <div class="vnccs-i3s__hint vnccs-i3s__artifact-empty">Generated scene specs, source, renders, and packages will appear here.</div>
                    </div>
                </section>
            </aside>

            <div class="vnccs-i3s__busy" aria-hidden="true">
                <div class="vnccs-i3s__busy-card" role="status"><span class="vnccs-i3s__spinner"></span><span class="vnccs-i3s__busy-message">Working…</span></div>
            </div>
            <div class="vnccs-i3s__toasts" aria-live="polite" aria-atomic="false"></div>
            <div class="vnccs-i3s__modal-layer"></div>
        `;
        this.container = root;
    }

    _cacheElements() {
        const $ = selector => this.container.querySelector(selector);
        this.els = {
            sourceDrop: $(".vnccs-i3s__dropzone"),
            sourceInput: $(".vnccs-i3s__source-input"),
            sourcePreview: $(".vnccs-i3s__source-preview"),
            sourceName: $(".vnccs-i3s__source-name"),
            sourceChange: $(".vnccs-i3s__source-change"),
            providerDot: $(".vnccs-i3s__provider-dot"),
            providerName: $(".vnccs-i3s__provider-name"),
            providerModel: $(".vnccs-i3s__provider-model"),
            providerOpen: $(".vnccs-i3s__provider-open"),
            prompt: $(".vnccs-i3s__prompt"),
            negative: $(".vnccs-i3s__negative"),
            subject: $(".vnccs-i3s__subject"),
            qualityProfile: $(".vnccs-i3s__quality-profile"),
            cycles: $(".vnccs-i3s__cycles"),
            cyclesValue: $(".vnccs-i3s__cycles-value"),
            threshold: $(".vnccs-i3s__threshold"),
            thresholdValue: $(".vnccs-i3s__threshold-value"),
            textureToggle: $(".vnccs-i3s__texture-toggle"),
            seed: $(".vnccs-i3s__seed"),
            generate: $(".vnccs-i3s__generate"),
            refine: $(".vnccs-i3s__refine"),
            projectName: $(".vnccs-i3s__project-name"),
            projectId: $(".vnccs-i3s__project-id"),
            status: $(".vnccs-i3s__status-pill"),
            diagnosticsOpen: $(".vnccs-i3s__diagnostics-open"),
            viewerHost: $(".vnccs-i3s__viewer-host"),
            fit: $(".vnccs-i3s__fit"),
            wireframe: $(".vnccs-i3s__wireframe"),
            grid: $(".vnccs-i3s__grid"),
            environment: $(".vnccs-i3s__environment"),
            previewUpload: $(".vnccs-i3s__preview-upload"),
            progress: $(".vnccs-i3s__progress"),
            progressStage: $(".vnccs-i3s__progress-stage"),
            progressPercent: $(".vnccs-i3s__progress-percent"),
            progressBar: $(".vnccs-i3s__progress-bar"),
            cancelJob: $(".vnccs-i3s__cancel-job"),
            hierarchySearch: $(".vnccs-i3s__hierarchy-search"),
            hierarchy: $(".vnccs-i3s__hierarchy"),
            hierarchyCount: $(".vnccs-i3s__hierarchy-count"),
            qualityRing: $(".vnccs-i3s__quality-ring"),
            qualityValue: $(".vnccs-i3s__quality-value"),
            qualityTitle: $(".vnccs-i3s__quality-title"),
            qualityNote: $(".vnccs-i3s__quality-note"),
            metrics: $(".vnccs-i3s__metric-list"),
            artifacts: $(".vnccs-i3s__artifacts"),
            artifactCount: $(".vnccs-i3s__artifact-count"),
            artifactEmpty: $(".vnccs-i3s__artifact-empty"),
            busy: $(".vnccs-i3s__busy"),
            busyMessage: $(".vnccs-i3s__busy-message"),
            toasts: $(".vnccs-i3s__toasts"),
            modalLayer: $(".vnccs-i3s__modal-layer"),
        };
    }

    _listen(target, type, handler, options) {
        target?.addEventListener?.(type, handler, options);
        this._listeners.push(() => target?.removeEventListener?.(type, handler, options));
        return handler;
    }

    _setTimer(callback, delay) {
        const timer = setTimeout(() => {
            this._timers.delete(timer);
            if (!this.destroyed) callback();
        }, delay);
        this._timers.add(timer);
        return timer;
    }

    _clearTimer(timer) {
        if (!timer) return;
        clearTimeout(timer);
        this._timers.delete(timer);
    }

    _bindUI() {
        const openSourcePicker = () => {
            if (!this.currentJobId) this.els.sourceInput.click();
        };
        this._listen(this.els.sourceDrop, "click", event => {
            if (event.target.closest(".vnccs-i3s__source-change")) return;
            openSourcePicker();
        });
        this._listen(this.els.sourceDrop, "keydown", event => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openSourcePicker();
            }
        });
        this._listen(this.els.sourceChange, "click", event => {
            event.preventDefault();
            event.stopPropagation();
            openSourcePicker();
        });
        this._listen(this.els.sourceInput, "change", () => {
            const file = this.els.sourceInput.files?.[0];
            if (file) this._acceptSourceFile(file);
            this.els.sourceInput.value = "";
        });
        for (const type of ["dragenter", "dragover"]) {
            this._listen(this.els.sourceDrop, type, event => {
                event.preventDefault();
                event.stopPropagation();
                if (!this.currentJobId) this.els.sourceDrop.classList.add("is-dragging");
            });
        }
        for (const type of ["dragleave", "drop"]) {
            this._listen(this.els.sourceDrop, type, event => {
                event.preventDefault();
                event.stopPropagation();
                this.els.sourceDrop.classList.remove("is-dragging");
            });
        }
        this._listen(this.els.sourceDrop, "drop", event => {
            if (this.currentJobId) return;
            const file = Array.from(event.dataTransfer?.files || []).find(item => item.type.startsWith("image/"));
            if (file) this._acceptSourceFile(file);
            else this.toast("Drop a PNG, JPEG, or WebP image.", "error");
        });

        this._listen(this.els.providerOpen, "click", () => this.openProviderModal());
        this._listen(this.els.generate, "click", () => void this.generate());
        this._listen(this.els.refine, "click", () => void this.refine());
        this._listen(this.els.cancelJob, "click", () => void this.cancelJob());
        this._listen(this.els.diagnosticsOpen, "click", () => {
            if (this.lastFailure) this._showFailureModal(this.lastFailure.details, this.lastFailure.context);
        });
        this._listen(this.els.previewUpload, "click", () => void this.uploadPreview());
        this._listen(this.els.fit, "click", () => this.viewer?.fit?.());
        this._listen(this.els.wireframe, "click", () => this._toggleViewerSetting("wireframe"));
        this._listen(this.els.grid, "click", () => this._toggleViewerSetting("grid"));
        this._listen(this.els.environment, "change", () => {
            this.viewerState.environment = this.els.environment.value;
            this.viewer?.setEnvironment?.(this.viewerState.environment);
            this._scheduleSave();
        });
        this._listen(this.els.textureToggle, "click", () => {
            this.request.texture_projection = !this.request.texture_projection;
            this.els.textureToggle.setAttribute("aria-checked", String(this.request.texture_projection));
            this._scheduleSave();
        });

        const requestBindings = [
            [this.els.prompt, "prompt", "string"],
            [this.els.negative, "negative_prompt", "string"],
            [this.els.subject, "subject_type", "string"],
            [this.els.qualityProfile, "quality_profile", "string"],
            [this.els.cycles, "review_cycles", "integer"],
            [this.els.threshold, "quality_threshold", "number"],
            [this.els.seed, "seed", "integer"],
        ];
        for (const [element, key, kind] of requestBindings) {
            const update = () => {
                const raw = element.value;
                this.request[key] = kind === "integer" ? Math.round(Number(raw)) : kind === "number" ? Number(raw) : raw;
                this._syncRangeLabels();
                this._scheduleSave();
            };
            this._listen(element, "input", update);
            this._listen(element, "change", update);
        }
        this._listen(this.els.hierarchySearch, "input", () => this._renderHierarchy());
    }

    _createViewer() {
        try {
            this.viewer = new Img2ThreeJSViewer(this.els.viewerHost, {
                onHierarchyChange: hierarchy => {
                    if (this.destroyed) return;
                    this.hierarchy = hierarchy;
                    this._renderHierarchy();
                },
                onSelectionChange: selection => {
                    if (this.destroyed) return;
                    this.selectedComponentId = String(selection?.id || "");
                    this._renderHierarchy();
                },
                onStateChange: state => {
                    if (this.destroyed || !isRecord(state)) return;
                    this.viewerState = { ...this.viewerState, ...safeClone(state) };
                    this._syncViewerButtons();
                    this._scheduleSave();
                },
                onError: error => {
                    if (!this.destroyed) this.toast(normalizeError(error, "The scene could not be displayed."), "error", 6500);
                },
            });
            if (this._pendingViewerState) this.viewer.setState?.(this._pendingViewerState);
        } catch (error) {
            this.viewer = null;
            this.toast(normalizeError(error, "The 3D viewer could not be initialized."), "error", 7000);
        }
    }

    _startResizeObserver() {
        if (typeof ResizeObserver === "undefined") return;
        this._resizeObserver = new ResizeObserver(() => {
            if (this._resizeFrame) cancelAnimationFrame(this._resizeFrame);
            this._resizeFrame = requestAnimationFrame(() => {
                this._resizeFrame = null;
                this.resize();
            });
        });
        this._resizeObserver.observe(this.container);
        this._resizeObserver.observe(this.els.viewerHost);
    }

    resize() {
        if (this.destroyed) return;
        const width = this.container.clientWidth || DEFAULT_NODE_SIZE[0];
        const height = this.container.clientHeight || DEFAULT_NODE_SIZE[1];
        const scale = clamp(Math.min(width / 1100, height / 720), 0.72, 1.08);
        this.container.style.setProperty("--i3-scale", scale.toFixed(3));
        const rect = this.els.viewerHost.getBoundingClientRect();
        this.viewer?.resize?.(rect.width, rect.height);
    }

    _syncAllControls() {
        this.els.prompt.value = String(this.request.prompt || "");
        this.els.negative.value = String(this.request.negative_prompt || "");
        this.els.subject.value = String(this.request.subject_type || "auto");
        this.els.qualityProfile.value = String(this.request.quality_profile || "strict");
        this.els.cycles.value = String(clamp(this.request.review_cycles, 1, 8));
        this.els.threshold.value = String(clamp(this.request.quality_threshold, 0.7, 0.98));
        this.els.seed.value = String(Number.isFinite(Number(this.request.seed)) ? Math.round(Number(this.request.seed)) : -1);
        this.els.textureToggle.setAttribute("aria-checked", String(Boolean(this.request.texture_projection)));
        this._syncRangeLabels();
        this._syncProviderSummary();
        this._syncViewerButtons();
        this.els.refine.disabled = !this.projectId || !this.hasScene || Boolean(this.currentJobId);
        this.els.previewUpload.disabled = !this.projectId || !this.hasScene || Boolean(this.currentJobId);
        this.els.generate.disabled = Boolean(this.currentJobId);
        this.els.sourceDrop.setAttribute("aria-disabled", String(Boolean(this.currentJobId)));
        this.els.projectId.textContent = this.projectId ? `#${this.projectId}` : "";
    }

    _syncRangeLabels() {
        this.els.cyclesValue.textContent = String(Math.round(clamp(this.request.review_cycles, 1, 8)));
        this.els.thresholdValue.textContent = `${Math.round(clamp(this.request.quality_threshold, 0.7, 0.98) * 100)}%`;
    }

    _syncProviderSummary() {
        const definition = PROVIDERS[this.provider.type] || PROVIDERS.codex_cli;
        const runtime = this.providerConfigs[this.provider.type] || {};
        const model = this.provider.model || runtime.model || runtime.deployment || "Default model";
        this.els.providerName.textContent = definition.label;
        this.els.providerModel.textContent = model;
        const capability = this._providerCapability(this.provider.type);
        const explicitlyUnavailable = capability && (capability.available === false || capability.enabled === false);
        let configuredInSession = Boolean(runtime.api_key);
        let configured = configuredInSession || capability?.configured === true
            || (capability && capability.configured === undefined && capability.available === true);
        if (this.provider.type === "local_gguf") {
            configuredInSession = Boolean(runtime.model && runtime.mmproj);
            configured = configuredInSession;
        } else if (this.provider.type === "azure_openai") {
            const hasCredential = Boolean(runtime.api_key) || capability?.credential_configured === true;
            configuredInSession = hasCredential && Boolean(runtime.endpoint && (runtime.deployment || runtime.model));
            configured = configuredInSession || capability?.configured === true;
        }
        const ready = Boolean(capability) && !explicitlyUnavailable && configured;
        this.els.providerDot.classList.toggle("is-ready", ready);
        this.els.providerDot.title = explicitlyUnavailable
            ? String(capability.reason || capability.message || "Provider unavailable")
            : ready ? "Provider ready" : "Provider needs configuration";
    }

    _syncViewerButtons() {
        const state = this.viewer?.getState?.() || this.viewerState || {};
        this.viewerState = { ...this.viewerState, ...safeClone(state) };
        const wireframe = Boolean(this.viewerState.wireframe);
        const grid = this.viewerState.grid !== false;
        this.els.wireframe.setAttribute("aria-pressed", String(wireframe));
        this.els.grid.setAttribute("aria-pressed", String(grid));
        const environment = typeof this.viewerState.environment === "string" ? this.viewerState.environment : "studio";
        if (Array.from(this.els.environment.options).some(option => option.value === environment)) {
            this.els.environment.value = environment;
        }
    }

    _toggleViewerSetting(key) {
        if (key === "wireframe") {
            this.viewerState.wireframe = !Boolean(this.viewerState.wireframe);
            this.viewer?.setWireframe?.(this.viewerState.wireframe);
        } else if (key === "grid") {
            this.viewerState.grid = this.viewerState.grid === false;
            this.viewer?.setGrid?.(this.viewerState.grid);
        }
        this._syncViewerButtons();
        this._scheduleSave();
    }

    _acceptSourceFile(file) {
        const allowed = /^(?:image\/png|image\/jpeg|image\/webp)$/i.test(file?.type || "")
            || /\.(?:png|jpe?g|webp)$/i.test(file?.name || "");
        if (!file || !allowed) {
            this.toast("Choose a PNG, JPEG, or WebP reference image.", "error");
            return false;
        }
        if (file.size > MAX_IMAGE_BYTES) {
            this.toast("The reference image is larger than 32 MB.", "error");
            return false;
        }
        const replacesProject = Boolean(this.projectId || this.hasScene || this.artifacts.length || this.quality);
        if (replacesProject) {
            this.projectId = "";
            this.currentJobId = "";
            this.currentJobToken += 1;
            this.hasScene = false;
            this.hierarchy = null;
            this.selectedComponentId = "";
            this.quality = null;
            this.artifacts = [];
            this.container.classList.remove("has-scene");
            void this.viewer?.loadSceneSpec?.({ name: "Empty scene", materials: [], components: [] });
            this._renderHierarchy();
            this._renderQuality();
            this._renderArtifacts();
        }
        if (this.sourceObjectUrl) URL.revokeObjectURL(this.sourceObjectUrl);
        this._clearFailure();
        this.sourceFile = file;
        this.sourceObjectUrl = URL.createObjectURL(file);
        this.els.sourcePreview.src = this.sourceObjectUrl;
        this.els.sourceName.textContent = `${file.name} · ${formatBytes(file.size)}`;
        this.els.sourceDrop.classList.add("has-image");
        this.els.projectName.textContent = file.name.replace(/\.[^.]+$/, "") || "Untitled reconstruction";
        this.els.projectId.textContent = "";
        this._setStatus("Reference ready", "idle");
        this._syncAllControls();
        this._scheduleSave(0);
        this.toast("Reference image ready.", "success", 2600);
        return true;
    }

    _setRemoteSource(url, label = "Project reference") {
        if (!url) return;
        if (this.sourceObjectUrl) {
            URL.revokeObjectURL(this.sourceObjectUrl);
            this.sourceObjectUrl = "";
        }
        this.sourceFile = null;
        this.els.sourcePreview.src = apiUrl(String(url));
        this.els.sourceName.textContent = label;
        this.els.sourceDrop.classList.add("has-image");
    }

    _providerCapability(type) {
        const providers = this.capabilities?.providers;
        if (Array.isArray(providers)) {
            return providers.find(item => (item?.id || item?.type || item?.name) === type) || null;
        }
        return isRecord(providers) ? providers[type] || null : null;
    }

    async _loadCapabilities() {
        try {
            const data = await this._fetchJSON(IMG2THREEJS_ENDPOINTS.capabilities, {}, { quiet: true });
            if (this.destroyed) return;
            this.capabilities = isRecord(data) ? data : {};
            this._syncProviderSummary();
        } catch (_) {
            // Capabilities are advisory. The generate endpoint remains the
            // source of truth and will return an actionable graphical error.
        }
    }

    _setStatus(text, tone = "idle") {
        this.els.status.textContent = String(text || "Ready");
        this.els.status.dataset.tone = tone;
    }

    _setProgress(visible, progress = 0, stage = "Working") {
        const normalized = clamp(Number(progress) > 1 ? Number(progress) / 100 : progress, 0, 1);
        this.els.progress.classList.toggle("is-visible", Boolean(visible));
        this.els.progressStage.textContent = String(stage || "Working");
        this.els.progressPercent.textContent = `${Math.round(normalized * 100)}%`;
        this.els.progressBar.style.width = `${Math.round(normalized * 1000) / 10}%`;
    }

    _setBusy(active, message = "Working…") {
        if (active) this._busyCount += 1;
        else this._busyCount = Math.max(0, this._busyCount - 1);
        const visible = this._busyCount > 0;
        this.els.busy.classList.toggle("is-visible", visible);
        this.els.busy.setAttribute("aria-hidden", String(!visible));
        if (message) this.els.busyMessage.textContent = String(message);
    }

    toast(message, tone = "info", duration = 4400) {
        if (this.destroyed || !message) return;
        const toast = createElement("div", "vnccs-i3s__toast");
        toast.dataset.tone = tone;
        toast.setAttribute("role", tone === "error" ? "alert" : "status");
        const icon = createElement("span", "vnccs-i3s__toast-icon");
        icon.innerHTML = tone === "success" ? ICONS.check : tone === "error" ? ICONS.warning : ICONS.cube;
        toast.append(icon, createElement("span", "vnccs-i3s__toast-message", message));
        this.els.toasts.appendChild(toast);
        const remove = () => toast.remove();
        toast.addEventListener("click", remove, { once: true });
        this._setTimer(remove, Math.max(1400, duration));
    }

    _showFailureModal(error, context = {}) {
        if (this.destroyed) return;
        const details = diagnosticText(error, "Generation failed without diagnostic output.");
        const providerLabel = PROVIDERS[this.provider.type]?.label || this.provider.type || "Provider";
        const projectId = String(context.projectId || this.projectId || "");
        const jobId = String(context.jobId || "");
        const body = createElement("div");
        body.appendChild(createElement(
            "div",
            "vnccs-i3s__failure-summary",
            `${providerLabel} could not complete the reconstruction. The diagnostic output is preserved below.`,
        ));
        const identifiers = [projectId ? `Project ${projectId}` : "", jobId ? `Job ${jobId}` : ""].filter(Boolean).join(" · ");
        if (identifiers) body.appendChild(createElement("div", "vnccs-i3s__failure-context", identifiers));
        const diagnostics = createElement("pre", "vnccs-i3s__diagnostics", details);
        body.appendChild(diagnostics);
        const close = button("vnccs-i3s__button", "Close");
        const copy = button("vnccs-i3s__button vnccs-i3s__button--primary", navigator.clipboard?.writeText ? "Copy diagnostics" : "Select diagnostics");
        const actions = [close];
        if (projectId) {
            const downloadLog = button("vnccs-i3s__button", "Download full log", "download");
            downloadLog.addEventListener("click", () => this._downloadArtifact({
                id: `${projectId}.provider-log`,
                name: `img2threejs-${projectId}-provider.log`,
            }));
            actions.push(downloadLog);
        }
        actions.push(copy);
        close.addEventListener("click", () => this.closeModal());
        copy.addEventListener("click", async () => {
            try {
                if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
                await navigator.clipboard.writeText(details);
                this.toast("Diagnostics copied.", "success", 2600);
            } catch (_) {
                const selection = window.getSelection?.();
                const range = document.createRange?.();
                if (selection && range) {
                    range.selectNodeContents(diagnostics);
                    selection.removeAllRanges();
                    selection.addRange(range);
                    this.toast("Diagnostics selected. Use Ctrl+C to copy.", "info", 3600);
                }
            }
        });
        this.lastFailure = { details, context: { projectId, jobId } };
        this.els.diagnosticsOpen.hidden = false;
        console.error("[VNCCS Img2ThreeJS] Generation failed", { provider: this.provider.type, projectId, jobId, error: details });
        this.openModal({ title: "Generation failed", body, actions, wide: true, initialFocus: copy });
    }

    _clearFailure() {
        this.lastFailure = null;
        this.els.diagnosticsOpen.hidden = true;
    }

    _scheduleSave(delay = 120) {
        this._clearTimer(this._saveTimer);
        this._saveTimer = this._setTimer(() => {
            this._saveTimer = null;
            this.syncToNode();
        }, delay);
    }

    serializeState() {
        const runtime = this.providerConfigs[this.provider.type] || {};
        const viewerState = this.viewer?.getState?.() || this.viewerState || {};
        return {
            schema_version: STUDIO_SCHEMA_VERSION,
            project_id: String(this.projectId || ""),
            provider: {
                type: String(this.provider.type || "codex_cli"),
                model: String(this.provider.model || runtime.model || runtime.deployment || ""),
                config: publicProviderConfig(this.provider.type, runtime),
            },
            request: safeClone(this.request, { ...DEFAULT_REQUEST }),
            viewer_state: safeClone(viewerState, {}),
        };
    }

    syncToNode() {
        if (this.destroyed) return;
        const widget = this.node?.widgets?.find(item => item.name === "studio_data");
        if (!widget) return;
        const serialized = JSON.stringify(this.serializeState());
        if (widget.value !== serialized) {
            widget.value = serialized;
            this.node?.setDirtyCanvas?.(true, true);
        }
    }

    async restoreFromNode({ restoreProject = true } = {}) {
        if (this.destroyed) return;
        const widget = this.node?.widgets?.find(item => item.name === "studio_data");
        let parsed = null;
        try {
            parsed = widget?.value ? JSON.parse(String(widget.value)) : null;
        } catch (_) {
            this.toast("Saved Img2ThreeJS state is invalid; defaults were restored.", "error", 6000);
        }
        if (!isRecord(parsed)) {
            this._syncAllControls();
            return;
        }
        this.projectId = String(parsed.project_id || "");
        if (isRecord(parsed.provider) && PROVIDERS[parsed.provider.type]) {
            this.provider.type = parsed.provider.type;
            this.provider.model = String(parsed.provider.model || "");
            const restoredConfig = publicProviderConfig(this.provider.type, parsed.provider.config);
            this.providerConfigs[this.provider.type] = {
                ...this.providerConfigs[this.provider.type],
                ...restoredConfig,
                model: String(restoredConfig.model || this.provider.model || ""),
            };
            if (this.provider.type === "azure_openai" && !this.providerConfigs.azure_openai.deployment) {
                this.providerConfigs.azure_openai.deployment = this.provider.model;
            }
        }
        if (isRecord(parsed.request)) {
            this.request = {
                ...DEFAULT_REQUEST,
                ...safeClone(parsed.request),
                review_cycles: Math.round(clamp(parsed.request.review_cycles ?? DEFAULT_REQUEST.review_cycles, 1, 8)),
                quality_threshold: clamp(parsed.request.quality_threshold ?? DEFAULT_REQUEST.quality_threshold, 0.7, 0.98),
            };
        }
        if (isRecord(parsed.viewer_state)) {
            this.viewerState = { ...this.viewerState, ...safeClone(parsed.viewer_state) };
            this._pendingViewerState = safeClone(this.viewerState);
            this.viewer?.setState?.(this.viewerState);
        }
        this._syncAllControls();
        if (restoreProject && this.projectId) await this.restoreProject(this.projectId);
    }

    _createAbortController() {
        const controller = new AbortController();
        this._abortControllers.add(controller);
        return controller;
    }

    async _fetchJSON(path, options = {}, { quiet = false } = {}) {
        const controller = this._createAbortController();
        const externalSignal = options.signal;
        const abortFromExternal = () => controller.abort();
        externalSignal?.addEventListener?.("abort", abortFromExternal, { once: true });
        try {
            const response = await api.fetchApi(path, { ...options, signal: controller.signal });
            if (!response?.ok) {
                let payload = null;
                try {
                    const responseText = await response.text();
                    try { payload = JSON.parse(responseText); } catch (_) { payload = responseText; }
                } catch (_) {}
                const message = diagnosticText(payload, `Request failed (HTTP ${response?.status || "unknown"}).`);
                const error = new Error(message);
                error.status = response?.status;
                throw error;
            }
            if (response.status === 204) return {};
            const contentType = response.headers?.get?.("content-type") || "";
            if (contentType.includes("application/json")) return await response.json();
            const text = await response.text();
            if (!text) return {};
            try { return JSON.parse(text); } catch (_) { return { message: text }; }
        } catch (error) {
            if (error?.name === "AbortError" || controller.signal.aborted) throw error;
            if (!quiet) this.toast(normalizeError(error), "error", 6500);
            throw error;
        } finally {
            externalSignal?.removeEventListener?.("abort", abortFromExternal);
            this._abortControllers.delete(controller);
        }
    }

    openModal({ title, body, actions = [], wide = false, initialFocus = null }) {
        this.closeModal();
        const layer = this.els.modalLayer;
        const modal = createElement("section", `vnccs-i3s__modal${wide ? " is-wide" : ""}`);
        modal.setAttribute("role", "dialog");
        modal.setAttribute("aria-modal", "true");
        const titleId = `vnccs-i3s-modal-${this.node?.id || "new"}-${Date.now()}`;
        modal.setAttribute("aria-labelledby", titleId);
        const head = createElement("header", "vnccs-i3s__modal-head");
        const heading = createElement("div", "vnccs-i3s__modal-title", title);
        heading.id = titleId;
        const closeButton = button("vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__icon-button", "", "close");
        closeButton.setAttribute("aria-label", "Close dialog");
        head.append(heading, closeButton);
        const bodyElement = createElement("div", "vnccs-i3s__modal-body");
        if (body instanceof Node) bodyElement.appendChild(body);
        else bodyElement.textContent = String(body || "");
        modal.append(head, bodyElement);
        if (actions.length) {
            const footer = createElement("footer", "vnccs-i3s__modal-actions");
            for (const action of actions) footer.appendChild(action);
            modal.appendChild(footer);
        }
        layer.replaceChildren(modal);
        layer.classList.add("is-open");
        this._previousModalFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

        const focusableSelector = "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])";
        const onKeyDown = event => {
            if (event.key === "Escape") {
                event.preventDefault();
                this.closeModal();
                return;
            }
            if (event.key !== "Tab") return;
            const focusable = Array.from(modal.querySelectorAll(focusableSelector)).filter(element => element.offsetParent !== null);
            if (!focusable.length) {
                event.preventDefault();
                modal.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        const onBackdrop = event => {
            if (event.target === layer) this.closeModal();
        };
        closeButton.addEventListener("click", () => this.closeModal());
        layer.addEventListener("pointerdown", onBackdrop);
        document.addEventListener("keydown", onKeyDown, true);
        this._modalCleanup = () => {
            layer.removeEventListener("pointerdown", onBackdrop);
            document.removeEventListener("keydown", onKeyDown, true);
        };
        requestAnimationFrame(() => {
            const target = initialFocus?.isConnected ? initialFocus : modal.querySelector(focusableSelector);
            target?.focus?.({ preventScroll: true });
        });
        return { layer, modal, body: bodyElement, close: () => this.closeModal() };
    }

    closeModal() {
        const rollbackProvider = this._providerModalRollback;
        this._providerModalRollback = null;
        rollbackProvider?.();
        this._modalCleanup?.();
        this._modalCleanup = null;
        this.els.modalLayer.classList.remove("is-open");
        this.els.modalLayer.replaceChildren();
        const previous = this._previousModalFocus;
        this._previousModalFocus = null;
        if (previous?.isConnected) requestAnimationFrame(() => previous.focus?.({ preventScroll: true }));
    }

    openProviderModal() {
        const providerSnapshot = safeClone(this.providerConfigs, {});
        this._providerModalType = PROVIDERS[this.provider.type] ? this.provider.type : "codex_cli";
        this._providerFormFields = new Map();

        const content = createElement("div");
        const note = createElement("div", "vnccs-i3s__modal-note");
        const noteIcon = createElement("span");
        noteIcon.innerHTML = ICONS.settings;
        note.append(noteIcon, createElement("span", "", "Credentials stay in memory for this studio session. They are never written to the workflow or browser storage."));
        const tabs = createElement("div", "vnccs-i3s__provider-tabs");
        tabs.setAttribute("role", "tablist");
        const description = createElement("div", "vnccs-i3s__provider-description");
        const fields = createElement("div", "vnccs-i3s__provider-fields");
        const uploadStatus = createElement("div", "vnccs-i3s__upload-progress");
        uploadStatus.append(createElement("span", "vnccs-i3s__spinner"), createElement("span", "vnccs-i3s__upload-progress-text", "Importing model…"));
        content.append(note, tabs, description, fields, uploadStatus);

        const cancel = button("vnccs-i3s__button", "Cancel");
        const save = button("vnccs-i3s__button vnccs-i3s__button--primary", "Use provider", "check");
        const modal = this.openModal({ title: "Model provider", body: content, actions: [cancel, save], wide: true });
        this._providerModalRollback = () => {
            this.providerConfigs = Object.fromEntries(
                Object.entries(DEFAULT_PROVIDER_CONFIGS).map(([key, defaults]) => [
                    key,
                    { ...defaults, ...(isRecord(providerSnapshot[key]) ? providerSnapshot[key] : {}) },
                ]),
            );
        };
        cancel.addEventListener("click", () => this.closeModal());
        save.addEventListener("click", () => {
            this._stashProviderForm();
            const type = this._providerModalType;
            const config = this.providerConfigs[type] || {};
            this.provider = {
                type,
                model: String(config.custom_model || config.model || (type === "azure_openai" ? config.deployment : "") || ""),
            };
            this._providerModalRollback = null;
            this._syncProviderSummary();
            this._scheduleSave(0);
            this.closeModal();
            this.toast(`${PROVIDERS[type].label} selected.`, "success", 2800);
        });

        const render = type => {
            this._stashProviderForm();
            this._providerModalType = type;
            for (const tab of tabs.querySelectorAll("button")) {
                tab.setAttribute("aria-selected", String(tab.dataset.provider === type));
            }
            description.textContent = PROVIDERS[type].description;
            this._renderProviderFields(fields, uploadStatus, type);
            this._customSelectController?.refresh?.();
        };
        for (const [type, definition] of Object.entries(PROVIDERS)) {
            const tab = button("vnccs-i3s__provider-tab", definition.label);
            tab.dataset.provider = type;
            tab.setAttribute("role", "tab");
            tab.setAttribute("aria-selected", String(type === this._providerModalType));
            tab.addEventListener("click", () => render(type));
            tabs.appendChild(tab);
        }
        render(this._providerModalType);
        requestAnimationFrame(() => modal.modal.querySelector(".vnccs-i3s__provider-tab[aria-selected='true']")?.focus?.());
    }

    _stashProviderForm() {
        const type = this._providerModalType;
        const config = this.providerConfigs[type];
        if (!config || !this._providerFormFields.size) return;
        for (const [key, spec] of this._providerFormFields) {
            const { element, kind, secret } = spec;
            let value;
            if (kind === "boolean") value = element.getAttribute("aria-checked") === "true";
            else if (kind === "integer") value = Math.round(Number(element.value));
            else if (kind === "number") value = Number(element.value);
            else value = String(element.value || "").trim();
            if (secret && !value) continue;
            if (Number.isNaN(value)) continue;
            config[key] = value;
            if (secret) element.value = "";
        }
    }

    _renderProviderFields(host, uploadStatus, type) {
        host.replaceChildren();
        this._providerFormFields = new Map();
        const config = this.providerConfigs[type] || (this.providerConfigs[type] = {});

        const addText = (label, key, options = {}) => {
            const field = createElement("label", `vnccs-i3s__field${options.full ? " is-full" : ""}`);
            field.appendChild(createElement("span", "vnccs-i3s__label", label));
            const input = createElement("input", "vnccs-i3s__input");
            input.type = options.secret ? "password" : options.type || "text";
            input.autocomplete = options.secret ? "new-password" : "off";
            input.placeholder = options.placeholder || "";
            if (options.min !== undefined) input.min = String(options.min);
            if (options.max !== undefined) input.max = String(options.max);
            if (options.step !== undefined) input.step = String(options.step);
            if (!options.secret) input.value = String(config[key] ?? options.value ?? "");
            if (options.secret) {
                const wrap = createElement("div", "vnccs-i3s__secret-wrap");
                wrap.appendChild(input);
                if (config[key]) {
                    const clearSecret = button("vnccs-i3s__secret-clear", "Clear");
                    clearSecret.setAttribute("aria-label", `Clear ${label}`);
                    clearSecret.addEventListener("click", () => {
                        config[key] = "";
                        input.value = "";
                        clearSecret.remove();
                    });
                    wrap.appendChild(clearSecret);
                }
                field.appendChild(wrap);
            } else {
                field.appendChild(input);
            }
            this._providerFormFields.set(key, {
                element: input,
                kind: options.kind || (input.type === "number" ? "number" : "string"),
                secret: Boolean(options.secret),
            });
            host.appendChild(field);
            return input;
        };

        const addSelect = (label, key, entries, options = {}) => {
            const field = createElement("label", `vnccs-i3s__field${options.full ? " is-full" : ""}`);
            field.appendChild(createElement("span", "vnccs-i3s__label", label));
            const select = createElement("select", "vnccs-i3s__select");
            select.setAttribute("aria-label", label);
            setSelectOptions(select, entries, config[key], options.emptyLabel || "No models found");
            field.appendChild(select);
            this._providerFormFields.set(key, { element: select, kind: "string", secret: false });
            host.appendChild(field);
            return select;
        };

        const initialModels = this._modelsFromCapabilities(type);
        const modelSelect = addSelect(
            type === "azure_openai" ? "Model / deployment" : "Model",
            "model",
            initialModels.length ? initialModels : PROVIDERS[type].models,
            { full: true, emptyLabel: type === "local_gguf" ? "No local GGUF models" : "Provider default" },
        );

        if (type !== "local_gguf" && type !== "azure_openai") {
            addText("Custom model override", "custom_model", {
                full: true,
                placeholder: "Optional exact model id",
            });
        }

        if (type === "codex_cli" || type === "claude_cli") {
            const capability = this._providerCapability(type);
            const diagnostic = createElement("div", "vnccs-i3s__hint is-full");
            if (capability?.available) {
                const executable = String(capability.executable || (type === "codex_cli" ? "codex" : "claude"));
                const discovery = String(capability.discovery || "server PATH");
                const version = capability.version ? ` · ${capability.version}` : "";
                diagnostic.textContent = `Detected by ComfyUI: ${executable} · ${discovery}${version}`;
            } else {
                diagnostic.textContent = String(
                    capability?.reason
                    || `${PROVIDERS[type].label} is not visible to the ComfyUI server process. Restart ComfyUI after changing its PATH.`,
                );
            }
            host.appendChild(diagnostic);
            if (type === "codex_cli" && capability?.available) {
                const auth = capability.authenticated
                    ? String(capability.auth_diagnostic || "Authenticated for the ComfyUI process")
                    : `Authentication unavailable: ${String(capability.auth_diagnostic || capability.reason || "codex login status failed")}`;
                host.appendChild(createElement("div", "vnccs-i3s__hint is-full", auth));
            }
        }

        if (type === "claude_api") {
            addText("Anthropic API key", "api_key", { secret: true, full: true, placeholder: config.api_key ? "Leave blank to keep current session key" : "sk-ant-…" });
            addText("Base URL", "base_url", { placeholder: "Anthropic default" });
            addText("Max output tokens", "max_tokens", { type: "number", kind: "integer", min: 256, max: 131072, step: 256 });
        } else if (type === "openai") {
            addText("OpenAI API key", "api_key", { secret: true, full: true, placeholder: config.api_key ? "Leave blank to keep current session key" : "sk-…" });
            addText("Base URL", "base_url", { full: true, placeholder: "https://api.openai.com/v1" });
        } else if (type === "azure_openai") {
            addText("Azure API key", "api_key", { secret: true, full: true, placeholder: config.api_key ? "Leave blank to keep current session key" : "Session-only key" });
            addText("Endpoint", "endpoint", { full: true, placeholder: "https://resource.openai.azure.com" });
            const deployment = addText("Deployment", "deployment", { placeholder: "Deployment name" });
            addText("API version", "api_version", { placeholder: "Configured server default" });
            if (!modelSelect.value && deployment.value) modelSelect.value = deployment.value;
        } else if (type === "local_gguf") {
            const mmprojEntries = this._mmprojFromCapabilities();
            const mmprojSelect = addSelect("Vision projector (mmproj)", "mmproj", mmprojEntries, { full: true, emptyLabel: "No mmproj files found" });
            addText("Context size", "context_size", { type: "number", kind: "integer", min: 2048, max: 262144, step: 1024 });
            addText("GPU layers (-1 = auto)", "gpu_layers", { type: "number", kind: "integer", min: -1, max: 999, step: 1 });
            addText("CPU threads (0 = auto)", "threads", { type: "number", kind: "integer", min: 0, max: 256, step: 1 });

            const capability = this._providerCapability("local_gguf");
            if (capability) {
                const summary = createElement(
                    "div",
                    "vnccs-i3s__hint is-full",
                    `ComfyUI catalog: ${Number(capability.model_count || 0)} model(s) · ${Number(capability.mmproj_count || 0)} projector(s)`,
                );
                host.appendChild(summary);
                const engine = capability.available
                    ? `${capability.engine || "native llama.cpp/libmtmd"}${capability.version ? ` · ${capability.version}` : ""}${capability.discovery ? ` · detected via ${capability.discovery}` : ""}`
                    : String(capability.reason || "Native llama-server is not available to ComfyUI.");
                host.appendChild(createElement("div", "vnccs-i3s__hint is-full", `Engine: ${engine}`));
                host.appendChild(createElement(
                    "div",
                    "vnccs-i3s__hint is-full",
                    "Architecture and chat template are detected by the installed llama.cpp/libmtmd build from GGUF metadata and the matching mmproj. Studio does not use a model-family whitelist.",
                ));
            }

            const uploadWrap = createElement("div", "vnccs-i3s__field is-full");
            uploadWrap.appendChild(createElement("span", "vnccs-i3s__label", "Import local files"));
            const row = createElement("div", "vnccs-i3s__field-row");
            const modelUpload = button("vnccs-i3s__button", "Import model GGUF", "upload");
            const mmprojUpload = button("vnccs-i3s__button", "Import mmproj", "upload");
            const modelInput = createElement("input", "vnccs-i3s__file-input");
            const mmprojInput = createElement("input", "vnccs-i3s__file-input");
            modelInput.type = mmprojInput.type = "file";
            modelInput.accept = mmprojInput.accept = ".gguf,application/octet-stream";
            modelUpload.addEventListener("click", () => modelInput.click());
            mmprojUpload.addEventListener("click", () => mmprojInput.click());
            modelInput.addEventListener("change", () => {
                const file = modelInput.files?.[0];
                modelInput.value = "";
                if (file) void this._uploadLocalModel(file, "model", uploadStatus, modelSelect, mmprojSelect);
            });
            mmprojInput.addEventListener("change", () => {
                const file = mmprojInput.files?.[0];
                mmprojInput.value = "";
                if (file) void this._uploadLocalModel(file, "mmproj", uploadStatus, modelSelect, mmprojSelect);
            });
            row.append(modelUpload, mmprojUpload, modelInput, mmprojInput);
            uploadWrap.appendChild(row);
            host.appendChild(uploadWrap);
        }

        void this._refreshProviderModels(type, modelSelect, this._providerFormFields.get("mmproj")?.element || null);
    }

    _modelsFromCapabilities(type) {
        const capability = this._providerCapability(type);
        const direct = capability?.models || this.capabilities?.models?.[type];
        return normalizeModelEntries(direct);
    }

    _mmprojFromCapabilities() {
        const capability = this._providerCapability("local_gguf");
        return normalizeModelEntries(
            capability?.mmprojs || capability?.mmproj_models || this.capabilities?.mmprojs || this.capabilities?.mmproj_models,
        );
    }

    async _refreshProviderModels(type, modelSelect, mmprojSelect = null) {
        const token = ++this._providerModelRequestToken;
        try {
            const data = await this._fetchJSON(IMG2THREEJS_ENDPOINTS.models(type), {}, { quiet: true });
            if (this.destroyed || token !== this._providerModelRequestToken || this._providerModalType !== type) return;
            const currentModel = this.providerConfigs[type]?.model || modelSelect?.value || "";
            const models = normalizeModelEntries(data?.models || data?.items || data?.data || []);
            if (models.length && modelSelect?.isConnected) setSelectOptions(modelSelect, models, currentModel);
            if (mmprojSelect?.isConnected) {
                const currentMmproj = this.providerConfigs[type]?.mmproj || mmprojSelect.value || "";
                const mmprojs = normalizeModelEntries(data?.mmprojs || data?.mmproj_models || data?.vision_projectors || []);
                if (mmprojs.length) setSelectOptions(mmprojSelect, mmprojs, currentMmproj);
            }
            this._customSelectController?.refresh?.();
        } catch (_) {
            // Manual/model defaults remain usable when discovery is unavailable.
        }
    }

    async _uploadLocalModel(file, kind, status, modelSelect, mmprojSelect) {
        if (!/\.gguf$/i.test(file?.name || "")) {
            this.toast("Local llama.cpp files must use the .gguf extension.", "error");
            return;
        }
        if (file.size > MAX_MODEL_BYTES) {
            this.toast("The selected GGUF exceeds the 64 GB upload limit.", "error");
            return;
        }
        status.classList.add("is-visible");
        status.querySelector(".vnccs-i3s__upload-progress-text").textContent = `Importing ${file.name}…`;
        const form = new FormData();
        form.append("file", file, file.name);
        form.append("kind", kind);
        try {
            const data = await this._fetchJSON(
                IMG2THREEJS_ENDPOINTS.uploadModel,
                { method: "POST", body: form },
                { quiet: true },
            );
            const value = String(data?.path || data?.model || data?.name || file.name);
            await this._refreshProviderModels("local_gguf", modelSelect, mmprojSelect);
            const target = kind === "mmproj" ? mmprojSelect : modelSelect;
            if (target && value) {
                if (!Array.from(target.options).some(option => option.value === value)) {
                    const option = createElement("option", "", value);
                    option.value = value;
                    target.appendChild(option);
                }
                target.value = value;
            }
            this.toast(`${file.name} imported.`, "success", 3200);
        } catch (error) {
            if (error?.name !== "AbortError") this.toast(normalizeError(error, "The GGUF import failed."), "error", 6500);
        } finally {
            status.classList.remove("is-visible");
        }
    }

    _providerPayload() {
        const type = this.provider.type;
        const config = { ...(this.providerConfigs[type] || {}) };
        const model = config.custom_model || this.provider.model || config.model
            || (type === "azure_openai" ? config.deployment : "") || "";
        delete config.custom_model;
        return { type, ...config, model };
    }

    _requestPayload() {
        return {
            ...safeClone(this.request, { ...DEFAULT_REQUEST }),
            prompt: String(this.els.prompt.value || "").trim(),
            negative_prompt: String(this.els.negative.value || "").trim(),
            subject_type: this.els.subject.value,
            quality_profile: this.els.qualityProfile.value,
            review_cycles: Math.round(clamp(this.els.cycles.value, 1, 8)),
            quality_threshold: clamp(this.els.threshold.value, 0.7, 0.98),
            texture_projection: this.els.textureToggle.getAttribute("aria-checked") === "true",
            output_format: "both",
            seed: Math.round(clamp(this.els.seed.value, -1, 2147483647)),
        };
    }

    _networkPayload() {
        this.request = this._requestPayload();
        return {
            schema_version: STUDIO_SCHEMA_VERSION,
            project_id: this.projectId || null,
            node_id: this.node?.id ?? null,
            provider: this._providerPayload(),
            request: safeClone(this.request),
            viewer_state: safeClone(this.viewer?.getState?.() || this.viewerState || {}),
        };
    }

    async generate() {
        if (this.currentJobId) return;
        if (!this.sourceFile && !this.projectId) {
            this.toast("Choose a reference image before starting a reconstruction.", "error", 5200);
            this.els.sourceDrop.focus({ preventScroll: true });
            return;
        }
        await this._submitPipeline("generate");
    }

    async refine() {
        if (this.currentJobId) return;
        if (!this.projectId) {
            this.toast("Generate or restore a project before refining it.", "error");
            return;
        }
        if (!this.hasScene || !this.viewer) {
            this.toast("A rendered scene is required before visual refinement.", "error");
            return;
        }
        await this._submitPipeline("refine");
    }

    async _capturePreviewBlob() {
        if (!this.viewer || !this.hasScene) return null;
        try {
            const result = await this.viewer.capture?.({ type: "image/png", quality: 0.94, as: "blob" });
            if (result instanceof Blob) return result;
            if (result instanceof HTMLCanvasElement) {
                return await new Promise(resolve => result.toBlob(resolve, "image/png", 0.94));
            }
        } catch (error) {
            this.toast(normalizeError(error, "Viewport preview could not be captured."), "error");
        }
        return null;
    }

    async _submitPipeline(kind) {
        const isRefine = kind === "refine";
        this._clearFailure();
        this._setBusy(true, isRefine ? "Preparing refinement…" : "Uploading reference…");
        this._setStatus(isRefine ? "Refining" : "Starting", "working");
        const form = new FormData();
        if (this.sourceFile) form.append("image", this.sourceFile, this.sourceFile.name);
        if (isRefine) {
            const preview = await this._capturePreviewBlob();
            if (!preview) {
                this._setBusy(false);
                this._setStatus("Preview required", "error");
                this._syncAllControls();
                return;
            }
            form.append("preview", preview, "viewport-preview.png");
        }
        form.append("payload", JSON.stringify(this._networkPayload()));
        try {
            const endpoint = isRefine
                ? IMG2THREEJS_ENDPOINTS.refine(this.projectId)
                : IMG2THREEJS_ENDPOINTS.generate;
            const data = await this._fetchJSON(endpoint, { method: "POST", body: form });
            if (this.destroyed) return;
            const projectId = responseProjectId(data);
            if (projectId) this.projectId = String(projectId);
            const jobId = responseJobId(data);
            if (jobId) {
                this._beginJob(jobId, data);
            } else {
                await this._applyProjectData(data);
                this._setStatus("Complete", "success");
                this._setProgress(false);
                this.toast(isRefine ? "Refinement complete." : "Reconstruction complete.", "success");
            }
        } catch (error) {
            if (error?.name !== "AbortError") {
                this._setStatus("Failed", "error");
                this._setProgress(false);
                this._showFailureModal(error, { projectId: this.projectId });
            }
        } finally {
            this._setBusy(false);
            this._syncAllControls();
            this._scheduleSave(0);
        }
    }

    _beginJob(jobId, initial = {}) {
        this.currentJobId = String(jobId);
        this.currentJobToken += 1;
        this._pollFailures = 0;
        const progress = initial.progress ?? initial.job?.progress ?? 0.02;
        const stage = initial.stage || initial.message || initial.job?.stage || "Pipeline queued";
        this._setProgress(true, progress, stage);
        this._setStatus("Generating", "working");
        this._syncAllControls();
        void this._pollJob(this.currentJobId, this.currentJobToken);
    }

    async _pollJob(jobId, token) {
        if (this.destroyed || token !== this.currentJobToken || jobId !== this.currentJobId) return;
        try {
            const data = await this._fetchJSON(IMG2THREEJS_ENDPOINTS.job(jobId), {}, { quiet: true });
            if (this.destroyed || token !== this.currentJobToken || jobId !== this.currentJobId) return;
            this._pollFailures = 0;
            const status = normalizeStatus(data?.status || data?.job?.status || data?.state);
            const progress = data?.progress ?? data?.job?.progress ?? 0;
            const stage = data?.stage || data?.message || data?.job?.stage || "Building procedural model";
            this._setProgress(true, progress, stage);
            if (TERMINAL_SUCCESS.has(status)) {
                await this._applyProjectData(data);
                this._finishJob("Complete", "success");
                this.toast("Reconstruction finished successfully.", "success");
                return;
            }
            if (TERMINAL_FAILURE.has(status)) {
                const cancelled = status === "cancelled" || status === "canceled";
                const message = normalizeError(data?.error || data?.message, cancelled ? "Generation cancelled." : "Generation failed.");
                if (Array.isArray(data?.artifacts)) {
                    this.artifacts = normalizeArtifacts(data.artifacts);
                    this._renderArtifacts();
                }
                this._finishJob(cancelled ? "Cancelled" : "Failed", cancelled ? "idle" : "error");
                this.toast(message, cancelled ? "info" : "error", 6500);
                if (!cancelled) {
                    this._showFailureModal(data?.error || data?.message, {
                        projectId: responseProjectId(data) || this.projectId,
                        jobId,
                    });
                }
                return;
            }
            const projectId = responseProjectId(data);
            if (projectId) this.projectId = String(projectId);
            this._pollTimer = this._setTimer(() => void this._pollJob(jobId, token), POLL_INTERVAL_MS);
        } catch (error) {
            if (error?.name === "AbortError" || this.destroyed || token !== this.currentJobToken) return;
            this._pollFailures = (this._pollFailures || 0) + 1;
            if (this._pollFailures >= 4) {
                this._setStatus("Reconnecting", "working");
                this._setProgress(true, 0, "Connection interrupted; retrying safely…");
                this._pollTimer = this._setTimer(() => void this._pollJob(jobId, token), 10000);
                if (this._pollFailures === 4) {
                    this.toast("Job status is temporarily unreachable. The studio will keep retrying.", "error", 7200);
                }
                return;
            }
            this._setProgress(true, 0, `Reconnecting (${this._pollFailures}/4)…`);
            this._pollTimer = this._setTimer(() => void this._pollJob(jobId, token), 1500 * this._pollFailures);
        }
    }

    _finishJob(label, tone) {
        this._clearTimer(this._pollTimer);
        this._pollTimer = null;
        this.currentJobId = "";
        this.currentJobToken += 1;
        this._setProgress(false);
        this._setStatus(label, tone);
        if (tone === "success") this._clearFailure();
        this._syncAllControls();
        this._scheduleSave(0);
    }

    async cancelJob() {
        const jobId = this.currentJobId;
        if (!jobId) return;
        this._clearTimer(this._pollTimer);
        this._pollTimer = null;
        this.currentJobToken += 1;
        this._setProgress(false);
        this._setStatus("Cancelling", "working");
        this._syncAllControls();
        try {
            await this._fetchJSON(IMG2THREEJS_ENDPOINTS.cancelJob(jobId), { method: "POST" });
            this._finishJob("Cancelled", "idle");
            this.toast("Generation cancelled.", "info");
        } catch (error) {
            if (error?.name !== "AbortError") {
                this._setStatus("Cancel not confirmed", "error");
                const token = ++this.currentJobToken;
                this._pollTimer = this._setTimer(() => void this._pollJob(jobId, token), 1800);
            }
        }
    }

    async restoreProject(projectId = this.projectId) {
        const id = String(projectId || "").trim();
        if (!id || this.destroyed) return;
        const token = (this._restoreToken || 0) + 1;
        this._restoreToken = token;
        this._setBusy(true, "Restoring project…");
        this._setStatus("Restoring", "working");
        try {
            const data = await this._fetchJSON(IMG2THREEJS_ENDPOINTS.project(id));
            if (this.destroyed || token !== this._restoreToken) return;
            this.projectId = id;
            await this._applyProjectData(data, { restoring: true });
            const jobId = responseJobId(data);
            const status = normalizeStatus(data?.status || data?.job?.status);
            if (jobId && !TERMINAL_SUCCESS.has(status) && !TERMINAL_FAILURE.has(status)) {
                this._beginJob(jobId, data);
            } else if (TERMINAL_FAILURE.has(status) && data?.error) {
                this._setStatus("Failed", "error");
                this._showFailureModal(data.error, { projectId: this.projectId, jobId });
            } else {
                this._setStatus("Restored", "success");
            }
        } catch (error) {
            if (error?.name !== "AbortError") this._setStatus("Restore failed", "error");
        } finally {
            this._setBusy(false);
            this._syncAllControls();
        }
    }

    async _applyProjectData(data, { restoring = false } = {}) {
        const project = isRecord(data?.project) ? data.project : isRecord(data?.result?.project) ? data.result.project : data;
        const projectId = responseProjectId(data) || project?.project_id || project?.id;
        if (projectId) this.projectId = String(projectId);
        const name = project?.name || project?.title || data?.name;
        if (name) this.els.projectName.textContent = String(name);
        this.els.projectId.textContent = this.projectId ? `#${this.projectId}` : "";

        if (restoring && isRecord(project?.request)) {
            this.request = { ...DEFAULT_REQUEST, ...safeClone(project.request) };
            this._syncAllControls();
        }
        const sourceUrl = project?.source_image_url || project?.sourceImageUrl || project?.reference_url || data?.source_image_url;
        if (sourceUrl) this._setRemoteSource(sourceUrl, project?.source_filename || "Project reference");

        const quality = data?.quality || data?.quality_report || project?.quality || project?.quality_report || data?.result?.quality;
        if (quality) {
            this.quality = quality;
            this._renderQuality();
        }
        const artifactsValue = data?.artifacts || project?.artifacts || data?.result?.artifacts;
        if (artifactsValue) {
            this.artifacts = normalizeArtifacts(artifactsValue);
            this._renderArtifacts();
        }

        const sceneSpec = responseSceneSpec(data);
        if (sceneSpec && this.viewer) {
            try {
                await this.viewer?.loadSceneSpec?.(sceneSpec);
                this.hasScene = true;
                this.container.classList.add("has-scene");
                const desiredState = restoring && isRecord(project?.viewer_state)
                    ? project.viewer_state
                    : this._pendingViewerState || this.viewerState;
                if (desiredState) this.viewer?.setState?.(desiredState);
                this._pendingViewerState = null;
                if (!restoring || !desiredState?.camera) this.viewer.fit?.();
            } catch (error) {
                this.hasScene = false;
                this.container.classList.remove("has-scene");
                this.toast(normalizeError(error, "The declarative scene could not be loaded."), "error", 7000);
            }
        } else if (sceneSpec && !this.viewer) {
            this.hasScene = false;
            this.container.classList.remove("has-scene");
            this.toast("The project contains a scene, but WebGL preview is unavailable.", "error", 7000);
        } else if (TERMINAL_SUCCESS.has(normalizeStatus(data?.status || project?.status))) {
            this.toast("The project completed without a declarative Scene Spec preview. Generated files remain available under Output.", "info", 6500);
        }
        this._syncAllControls();
        this._scheduleSave(0);
    }

    async uploadPreview() {
        if (!this.projectId || !this.hasScene || this.currentJobId) return;
        this._setBusy(true, "Capturing viewport preview…");
        try {
            const preview = await this._capturePreviewBlob();
            if (!preview) throw new Error("The viewport did not produce a preview image.");
            const form = new FormData();
            form.append("preview", preview, "viewport-preview.png");
            const data = await this._fetchJSON(
                IMG2THREEJS_ENDPOINTS.preview(this.projectId),
                { method: "POST", body: form },
                { quiet: true },
            );
            const artifacts = data?.artifacts || data?.project?.artifacts;
            if (artifacts) {
                this.artifacts = normalizeArtifacts(artifacts);
                this._renderArtifacts();
            }
            this.toast("Viewport preview uploaded.", "success", 3000);
        } catch (error) {
            if (error?.name !== "AbortError") this.toast(normalizeError(error, "Preview upload failed."), "error");
        } finally {
            this._setBusy(false);
        }
    }

    _hierarchyComponents() {
        const hierarchy = this.hierarchy;
        if (!hierarchy) return [];
        const byId = hierarchy.byId;
        const lookup = id => byId instanceof Map ? byId.get(id) : byId?.[id];
        const output = [];
        const visited = new Set();
        const visit = (value, depth = 0) => {
            const component = typeof value === "string" ? lookup(value) || { id: value, name: value } : value;
            if (!component) return;
            const id = String(component.id || component.name || `component-${output.length}`);
            if (visited.has(id)) return;
            visited.add(id);
            output.push({ ...component, id, depth });
            const children = component.childrenIds || component.children || [];
            for (const child of children) visit(child, depth + 1);
        };
        for (const root of hierarchy.roots || []) visit(root, 0);
        if (!output.length) for (const item of hierarchy.order || []) visit(item, 0);
        if (!output.length && byId) {
            const values = byId instanceof Map ? byId.values() : Object.values(byId);
            for (const item of values) visit(item, 0);
        }
        return output;
    }

    _renderHierarchy() {
        const components = this._hierarchyComponents();
        const query = String(this.els?.hierarchySearch?.value || "").trim().toLowerCase();
        const filtered = query
            ? components.filter(item => `${item.name || ""} ${item.id} ${item.type || ""}`.toLowerCase().includes(query))
            : components;
        this.els.hierarchyCount.textContent = String(components.length);
        this.els.hierarchy.replaceChildren();
        if (!filtered.length) {
            this.els.hierarchy.appendChild(createElement("div", "vnccs-i3s__tree-empty", components.length ? "No matching components." : "No scene hierarchy yet."));
            return;
        }
        for (const item of filtered) {
            const row = createElement("button", "vnccs-i3s__tree-row");
            row.type = "button";
            row.setAttribute("role", "treeitem");
            row.style.setProperty("--tree-depth", String(query ? 0 : clamp(item.depth, 0, 12)));
            row.dataset.componentId = item.id;
            row.classList.toggle("is-selected", item.id === this.selectedComponentId);
            const chevron = createElement("span");
            chevron.innerHTML = ICONS.chevron;
            const name = createElement("span", "vnccs-i3s__tree-name", item.label || item.name || item.id);
            const type = createElement("span", "vnccs-i3s__tree-type", item.type || item.kind || item.primitive || "node");
            row.append(chevron, name, type);
            row.addEventListener("click", () => {
                this.selectedComponentId = item.id;
                this.viewer?.select?.(item.id);
                this._renderHierarchy();
            });
            this.els.hierarchy.appendChild(row);
        }
    }

    _renderQuality() {
        const report = isRecord(this.quality) ? this.quality : {};
        let score = Number(report.score ?? report.overall ?? report.overall_score ?? report.similarity);
        if (score > 1) score /= 100;
        const hasScore = Number.isFinite(score);
        score = hasScore ? clamp(score, 0, 1) : 0;
        const threshold = clamp(report.threshold ?? this.request.quality_threshold, 0, 1);
        const passed = report.passed ?? report.pass ?? (hasScore && score >= threshold);
        this.els.qualityRing.style.setProperty("--score", `${Math.round(score * 360)}deg`);
        this.els.qualityValue.textContent = hasScore ? `${Math.round(score * 100)}%` : "—";
        this.els.qualityTitle.textContent = hasScore ? (passed ? "Quality gate passed" : "Refinement recommended") : "Not evaluated";
        this.els.qualityNote.textContent = hasScore
            ? `Target ${Math.round(threshold * 100)}% · ${report.stage || report.profile || this.request.quality_profile}`
            : "Scores arrive after visual review.";
        this.els.metrics.replaceChildren();
        const metrics = isRecord(report.metrics) ? report.metrics : isRecord(report.scores) ? report.scores : {};
        for (const [name, raw] of Object.entries(metrics).slice(0, 8)) {
            const value = Number(isRecord(raw) ? raw.score ?? raw.value : raw);
            if (!Number.isFinite(value)) continue;
            const normalized = value > 1 ? value : value * 100;
            const row = createElement("div", "vnccs-i3s__metric");
            row.append(
                createElement("span", "vnccs-i3s__metric-name", name.replace(/[_-]+/g, " ")),
                createElement("span", "vnccs-i3s__metric-value", `${Math.round(normalized)}%`),
            );
            this.els.metrics.appendChild(row);
        }
    }

    _renderArtifacts() {
        this.els.artifacts.replaceChildren();
        this.els.artifactCount.textContent = String(this.artifacts.length);
        this.els.artifactEmpty.style.display = this.artifacts.length ? "none" : "";
        for (const artifact of this.artifacts) {
            const row = createElement("div", "vnccs-i3s__artifact");
            const icon = createElement("span", "vnccs-i3s__artifact-icon");
            icon.innerHTML = ICONS.cube;
            const copy = createElement("div");
            copy.append(
                createElement("div", "vnccs-i3s__artifact-name", artifact.name),
                createElement("div", "vnccs-i3s__artifact-meta", [artifact.kind, formatBytes(artifact.size)].filter(Boolean).join(" · ")),
            );
            const download = button("vnccs-i3s__button vnccs-i3s__button--quiet vnccs-i3s__icon-button", "", "download");
            download.setAttribute("aria-label", `Download ${artifact.name}`);
            download.title = `Download ${artifact.name}`;
            download.addEventListener("click", () => this._downloadArtifact(artifact));
            row.append(icon, copy, download);
            this.els.artifacts.appendChild(row);
        }
    }

    _downloadArtifact(artifact) {
        const path = artifact.url || (artifact.id ? IMG2THREEJS_ENDPOINTS.artifact(artifact.id) : "");
        if (!path) {
            this.toast("This artifact does not have a download URL.", "error");
            return;
        }
        const anchor = createElement("a");
        anchor.href = apiUrl(path);
        anchor.download = artifact.name || "";
        anchor.rel = "noopener";
        anchor.style.display = "none";
        this.container.appendChild(anchor);
        anchor.click();
        anchor.remove();
    }

    dispose() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.currentJobToken += 1;
        const activeJobId = this.currentJobId;
        this.currentJobId = "";
        if (activeJobId) {
            void api.fetchApi(IMG2THREEJS_ENDPOINTS.cancelJob(activeJobId), {
                method: "POST",
                keepalive: true,
            }).catch(() => {});
        }
        this._restoreToken = (this._restoreToken || 0) + 1;
        for (const timer of this._timers) clearTimeout(timer);
        this._timers.clear();
        if (this._resizeFrame) cancelAnimationFrame(this._resizeFrame);
        this._resizeFrame = null;
        for (const controller of this._abortControllers) controller.abort();
        this._abortControllers.clear();
        for (const cleanup of this._listeners.splice(0)) {
            try { cleanup(); } catch (_) {}
        }
        this._navigationCleanup?.();
        this._navigationCleanup = null;
        this._modalCleanup?.();
        this._modalCleanup = null;
        this._resizeObserver?.disconnect?.();
        this._resizeObserver = null;
        this._customSelectController?.disconnect?.();
        this._customSelectController = null;
        this.viewer?.dispose?.();
        this.viewer = null;
        if (this.sourceObjectUrl) URL.revokeObjectURL(this.sourceObjectUrl);
        this.sourceObjectUrl = "";
        this.container.remove();
    }
}

function enableCanvasNavigationForwarding(root) {
    if (!root) return () => {};
    const graphCanvas = () => app.canvasEl || app.canvas?.canvas || document.querySelector("canvas.litegraph");
    let panning = false;

    const isInteractive = target => {
        if (!(target instanceof Element)) return true;
        if (target.closest("button,input,textarea,select,label,a,canvas,[role='button'],[role='treeitem'],.vnccs-i3s__modal-layer,.vnccs-i3s__toolbar")) return true;
        for (let element = target; element && element !== root; element = element.parentElement) {
            const style = getComputedStyle(element);
            const scrollY = /(auto|scroll|overlay)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
            const scrollX = /(auto|scroll|overlay)/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1;
            if (scrollY || scrollX || typeof element.onwheel === "function") return true;
        }
        return false;
    };
    const mark = event => {
        Object.defineProperty(event, "_vnccsI3SForwarded", { value: true });
        return event;
    };
    const mouse = (type, source, buttons) => mark(new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window,
        screenX: source.screenX, screenY: source.screenY, clientX: source.clientX, clientY: source.clientY,
        ctrlKey: source.ctrlKey, altKey: source.altKey, shiftKey: source.shiftKey, metaKey: source.metaKey,
        button: 1, buttons,
    }));
    const pointer = (type, source, buttons) => {
        const Constructor = window.PointerEvent || window.MouseEvent;
        return mark(new Constructor(type, {
            bubbles: true, cancelable: true, view: window,
            screenX: source.screenX, screenY: source.screenY, clientX: source.clientX, clientY: source.clientY,
            ctrlKey: source.ctrlKey, altKey: source.altKey, shiftKey: source.shiftKey, metaKey: source.metaKey,
            button: 1, buttons, pointerId: source.pointerId || 1, pointerType: "mouse", isPrimary: true,
        }));
    };
    const sendMouse = (type, source, buttons) => {
        const canvas = graphCanvas();
        if (!canvas) return false;
        const pointerType = type === "mousedown" ? "pointerdown" : type === "mousemove" ? "pointermove" : "pointerup";
        canvas.dispatchEvent(pointer(pointerType, source, buttons));
        canvas.dispatchEvent(mouse(type, source, buttons));
        return true;
    };
    const onMove = event => {
        if (!panning || event._vnccsI3SForwarded) return;
        event.preventDefault();
        event.stopPropagation();
        sendMouse("mousemove", event, event.buttons || 4);
    };
    const onUp = event => {
        if (!panning || event._vnccsI3SForwarded) return;
        panning = false;
        event.preventDefault();
        event.stopPropagation();
        sendMouse("mouseup", event, 0);
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
    };
    const onDown = event => {
        if (event._vnccsI3SForwarded || event.button !== 1 || isInteractive(event.target)) return;
        if (!sendMouse("mousedown", event, 4)) return;
        panning = true;
        event.preventDefault();
        event.stopPropagation();
        window.addEventListener("mousemove", onMove, true);
        window.addEventListener("mouseup", onUp, true);
    };
    const onAuxClick = event => {
        if (event.button === 1 && !isInteractive(event.target)) {
            event.preventDefault();
            event.stopPropagation();
        }
    };
    const onWheel = event => {
        if (event._vnccsI3SForwarded || isInteractive(event.target)) return;
        const canvas = graphCanvas();
        if (!canvas) return;
        canvas.dispatchEvent(mark(new WheelEvent("wheel", {
            bubbles: true, cancelable: true, view: window,
            screenX: event.screenX, screenY: event.screenY, clientX: event.clientX, clientY: event.clientY,
            ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey,
            deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ, deltaMode: event.deltaMode,
        })));
        event.preventDefault();
        event.stopPropagation();
    };
    root.addEventListener("mousedown", onDown, true);
    root.addEventListener("auxclick", onAuxClick, true);
    root.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
        panning = false;
        root.removeEventListener("mousedown", onDown, true);
        root.removeEventListener("auxclick", onAuxClick, true);
        root.removeEventListener("wheel", onWheel, true);
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
    };
}

function hideStudioDataWidget(node) {
    const widget = node?.widgets?.find(item => item.name === "studio_data");
    if (!widget) return;
    widget.type = "hidden";
    widget.hidden = true;
    widget.computeSize = () => [0, -4];
    if (widget.element) widget.element.style.display = "none";
}

function syncDOMWidgetWidth(node) {
    const widget = node?.widgets?.find(item => item.name === "img2threejs_ui");
    if (!widget) return;
    if (!widget._vnccsI3SWidthBound) {
        try {
            Object.defineProperty(widget, "width", {
                configurable: true,
                get() {
                    const width = Number(this._node?.size?.[0] ?? node?.size?.[0]);
                    return Number.isFinite(width) && width > 0 ? width : undefined;
                },
                set(_value) {},
            });
            widget._vnccsI3SWidthBound = true;
        } catch (_) {}
    }
    widget.triggerDraw?.();
}

app.registerExtension({
    name: "VNCCS.Img2ThreeJSStudio",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "VNCCS_Img2ThreeJSStudio") return;

        const originalCreated = nodeType.prototype.onNodeCreated;
        const originalResize = nodeType.prototype.onResize;
        const originalConfigure = nodeType.prototype.onConfigure;
        const originalRemoved = nodeType.prototype.onRemoved;
        const originalSerialize = nodeType.prototype.onSerialize;

        nodeType.prototype.onNodeCreated = function () {
            originalCreated?.apply(this, arguments);
            if (this.img2threejsStudio) return;
            this.setSize?.([...DEFAULT_NODE_SIZE]);
            hideStudioDataWidget(this);

            const studio = new Img2ThreeJSStudioWidget(this);
            this.img2threejsStudio = studio;
            this.img2threejsDOMWidget = this.addDOMWidget(
                "img2threejs_ui",
                "ui",
                studio.container,
                { serialize: false, hideOnZoom: false },
            );
            syncDOMWidgetWidth(this);
            this._vnccsI3SInitTimer = setTimeout(() => {
                this._vnccsI3SInitTimer = null;
                if (!this.img2threejsStudio) return;
                hideStudioDataWidget(this);
                syncDOMWidgetWidth(this);
                void this.img2threejsStudio.restoreFromNode({ restoreProject: true });
                this.img2threejsStudio.resize();
            }, 80);
        };

        nodeType.prototype.onResize = function (size) {
            originalResize?.apply(this, arguments);
            if (!this.img2threejsStudio) return;
            if (this._vnccsI3SResizeFrame) cancelAnimationFrame(this._vnccsI3SResizeFrame);
            this._vnccsI3SResizeFrame = requestAnimationFrame(() => {
                this._vnccsI3SResizeFrame = null;
                syncDOMWidgetWidth(this);
                this.img2threejsStudio?.resize();
            });
        };

        nodeType.prototype.onConfigure = function (info) {
            originalConfigure?.apply(this, arguments);
            hideStudioDataWidget(this);
            clearTimeout(this._vnccsI3SConfigureTimer);
            this._vnccsI3SConfigureTimer = setTimeout(() => {
                this._vnccsI3SConfigureTimer = null;
                if (!this.img2threejsStudio) return;
                hideStudioDataWidget(this);
                syncDOMWidgetWidth(this);
                void this.img2threejsStudio.restoreFromNode({ restoreProject: true });
                this.img2threejsStudio.resize();
            }, 120);
        };

        nodeType.prototype.onSerialize = function (info) {
            this.img2threejsStudio?.syncToNode();
            return originalSerialize?.apply(this, arguments);
        };

        nodeType.prototype.onRemoved = function () {
            clearTimeout(this._vnccsI3SInitTimer);
            clearTimeout(this._vnccsI3SConfigureTimer);
            if (this._vnccsI3SResizeFrame) cancelAnimationFrame(this._vnccsI3SResizeFrame);
            this._vnccsI3SResizeFrame = null;
            this.img2threejsStudio?.dispose();
            this.img2threejsStudio = null;
            this.img2threejsDOMWidget = null;
            return originalRemoved?.apply(this, arguments);
        };
    },
});
