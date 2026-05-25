/**
 * VNCCS Pose Studio - Combined mesh editor and multi-pose generator
 * 
 * Combines Character Studio sliders, dynamic pose tabs, and Debug3 gizmo controls.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { PoseViewerCore, IK_CHAINS } from "./vnccs_pose_studio_core.js";
import { HAND_PRESETS } from "./vnccs_hand_presets.js";
import { importMixamoFBXAsPoses } from "./vnccs_mixamo_import.js";
import { detectAndParseJSON, extractKeypointsFromImage, convertOpenPoseToPose, roundTripTest } from "./vnccs_openpose_import.js";

// Determine the extension's base URL dynamically to support varied directory names (e.g. ComfyUI_VNCCS_Utils or vnccs-utils)
const EXTENSION_URL = new URL(".", import.meta.url).toString();

// === Styles ===
const STYLES = `
/* ===== VNCCS Pose Studio — Sakura Theme ===== */
/* Variables scoped to the node container — won't leak to other ComfyUI tabs */
.vnccs-pose-studio {
    --ps-bg:            #0a0a0f;
    --ps-panel:         rgba(16, 14, 24, 0.92);
    --ps-elevated:      #1a1a26;
    --ps-surface:       rgba(30, 28, 44, 0.85);
    --ps-hover:         rgba(42, 40, 60, 0.9);
    --ps-border:        rgba(255, 255, 255, 0.06);
    --ps-border-hover:  rgba(255, 255, 255, 0.14);
    --ps-accent:        #ff8fa3;
    --ps-accent-hover:  #ffb6c8;
    --ps-accent-glow:   rgba(255, 143, 163, 0.3);
    --ps-accent-subtle: rgba(255, 143, 163, 0.1);
    --ps-accent-border: rgba(255, 143, 163, 0.22);
    --ps-accent-lavender: #b8a9e8;
    --ps-success: #00d68f;
    --ps-danger:  #ff4757;
    --ps-warning: #ffaa00;
    --ps-text:       #e8e8f0;
    --ps-text-muted: #9898a8;
    --ps-text-dim:   #5e5e70;
    --ps-input-bg:   rgba(255, 255, 255, 0.04);
    --ps-font:       'Sora', -apple-system, BlinkMacSystemFont, sans-serif;
    --ps-font-mono:  'JetBrains Mono', 'Fira Code', monospace;
    --ps-radius-sm:  8px;
    --ps-radius-md:  12px;
    --ps-radius-lg:  16px;
    --ps-transition: 0.2s ease;
    --vnccs-ps-ui-scale: 1;
}

/* Main Container */
.vnccs-pose-studio {
    display: flex;
    flex-direction: row;
    width: 100%;
    height: 100%;
    background: var(--ps-bg);
    font-family: var(--ps-font);
    font-size: 11px;
    color: var(--ps-text);
    overflow: hidden;
    box-sizing: border-box;
    pointer-events: none;
    position: relative;
}

/* === Left Panel === */
.vnccs-ps-left {
    width: 220px;
    zoom: var(--vnccs-ps-ui-scale);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    overflow-y: auto;
    border-right: 1px solid var(--ps-border);
    background: rgba(6, 5, 12, 0.7);
    pointer-events: auto;
}

.vnccs-ps-left::-webkit-scrollbar { width: 4px; }
.vnccs-ps-left::-webkit-scrollbar-thumb { background: var(--ps-accent-border); border-radius: 2px; }

/* === Center Panel (Canvas) === */
.vnccs-ps-center {
    flex: 1;
    min-width: 0;      /* prevent flex auto-expansion beyond node width */
    min-height: 0;     /* allow shrinking in nested flex column */
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
    z-index: 2;
    pointer-events: auto;
}

/* === Right Sidebar (Lighting) === */
.vnccs-ps-right-sidebar {
    width: 220px;
    zoom: var(--vnccs-ps-ui-scale);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    overflow-y: auto;
    border-left: 1px solid var(--ps-border);
    pointer-events: auto;
    background: rgba(6, 5, 12, 0.7);
    position: relative;
    z-index: 1;
}

.vnccs-ps-right-sidebar::-webkit-scrollbar { width: 4px; }
.vnccs-ps-right-sidebar::-webkit-scrollbar-thumb { background: var(--ps-accent-border); border-radius: 2px; }

/* === Section Component — Glassmorphic === */
.vnccs-ps-section {
    background: rgba(20, 16, 30, 0.72);
    border: 1px solid var(--ps-accent-border);
    border-radius: var(--ps-radius-md);
    overflow: visible;
    flex-shrink: 0;
    position: relative;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}

/* Luminous top highlight */
.vnccs-ps-section::before {
    content: '';
    position: absolute;
    top: 0; left: 14%; right: 14%;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(255, 143, 163, 0.55), transparent);
    border-radius: 1px;
    pointer-events: none;
    z-index: 1;
}

.vnccs-ps-section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 7px 10px;
    background: rgba(0, 0, 0, 0.22);
    border-bottom: 1px solid var(--ps-border);
    cursor: pointer;
    user-select: none;
    border-radius: var(--ps-radius-md) var(--ps-radius-md) 0 0;
    overflow: hidden;
}

.vnccs-ps-section-title {
    font-size: 9px;
    font-weight: 700;
    color: var(--ps-accent);
    text-transform: uppercase;
    letter-spacing: 1.2px;
    display: flex;
    align-items: center;
    gap: 7px;
}

.vnccs-ps-section-title::before {
    content: '';
    width: 3px;
    height: 10px;
    background: linear-gradient(180deg, var(--ps-accent), var(--ps-accent-lavender));
    border-radius: 2px;
    box-shadow: 0 0 6px var(--ps-accent-glow);
    flex-shrink: 0;
}

.vnccs-ps-section-toggle {
    font-size: 10px;
    color: var(--ps-text-muted);
    transition: transform var(--ps-transition);
}

.vnccs-ps-section.collapsed .vnccs-ps-section-toggle {
    transform: rotate(-90deg);
}

.vnccs-ps-section-content {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    pointer-events: auto;
}

.vnccs-ps-section.collapsed .vnccs-ps-section-content {
    display: none;
}

/* === Form Fields === */
.vnccs-ps-field {
    display: flex;
    flex-direction: column;
    gap: 3px;
    pointer-events: auto;
}

.vnccs-ps-label {
    font-size: 9px;
    color: var(--ps-text-muted);
    text-transform: uppercase;
    font-weight: 700;
    letter-spacing: 0.8px;
}

.vnccs-ps-value {
    font-size: 9px;
    color: var(--ps-accent);
    margin-left: auto;
    font-family: var(--ps-font-mono);
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
    gap: 6px;
    background: var(--ps-input-bg);
    border: 1px solid var(--ps-border);
    border-radius: var(--ps-radius-sm);
    padding: 4px 8px;
    pointer-events: auto;
    transition: border-color var(--ps-transition);
}

.vnccs-ps-slider-wrap:hover {
    border-color: var(--ps-border-hover);
}

.vnccs-ps-slider {
    flex: 1;
    -webkit-appearance: none;
    appearance: none;
    height: 3px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    cursor: pointer;
    pointer-events: auto;
}

.vnccs-ps-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 13px;
    height: 13px;
    background: var(--ps-accent);
    border-radius: 50%;
    cursor: pointer;
    box-shadow: 0 0 6px var(--ps-accent-glow);
    transition: box-shadow var(--ps-transition);
}

.vnccs-ps-slider::-webkit-slider-thumb:hover {
    box-shadow: 0 0 12px var(--ps-accent-glow);
}

.vnccs-ps-slider::-moz-range-thumb {
    width: 13px;
    height: 13px;
    background: var(--ps-accent);
    border-radius: 50%;
    cursor: pointer;
    border: none;
    box-shadow: 0 0 6px var(--ps-accent-glow);
}

.vnccs-ps-slider-val {
    width: 35px;
    text-align: right;
    font-size: 10px;
    color: var(--ps-accent);
    background: transparent;
    border: none;
    font-family: var(--ps-font-mono);
}

/* Input */
.vnccs-ps-input {
    background: var(--ps-input-bg);
    border: 1px solid var(--ps-border);
    color: var(--ps-text);
    border-radius: var(--ps-radius-sm);
    padding: 5px 8px;
    font-family: var(--ps-font);
    font-size: 10px;
    width: 100%;
    box-sizing: border-box;
    transition: all var(--ps-transition);
}

.vnccs-ps-input:focus {
    outline: none;
    border-color: var(--ps-accent-border);
    background: rgba(255, 143, 163, 0.03);
    box-shadow: 0 0 0 2px rgba(255, 143, 163, 0.06);
}

.vnccs-ps-textarea {
    background: var(--ps-input-bg);
    border: 1px solid var(--ps-border);
    color: var(--ps-text);
    border-radius: var(--ps-radius-sm);
    padding: 8px 10px;
    font-family: var(--ps-font);
    font-size: 11px;
    width: 100%;
    box-sizing: border-box;
    resize: none;
    overflow-y: hidden;
    line-height: 1.5;
    min-height: 60px;
    pointer-events: auto;
    transition: all var(--ps-transition);
}

.vnccs-ps-textarea:focus {
    outline: none;
    border-color: var(--ps-accent-border);
    background: rgba(255, 143, 163, 0.03);
    box-shadow: 0 0 0 2px rgba(255, 143, 163, 0.06);
}

/* Select */
.vnccs-ps-select {
    background: var(--ps-input-bg);
    border: 1px solid var(--ps-border);
    color: var(--ps-text);
    border-radius: var(--ps-radius-sm);
    padding: 5px 8px;
    font-family: var(--ps-font);
    font-size: 10px;
    width: 100%;
    cursor: pointer;
    transition: all var(--ps-transition);
}

/* Counter-zoom removed as zoom is now 1.0 */
.vnccs-ps-select:focus {
    outline: none;
    border-color: var(--ps-accent-border);
    transform: none;
    transform-origin: top left;
}

/* Toggle */
.vnccs-ps-toggle {
    display: flex;
    gap: 2px;
    background: rgba(0, 0, 0, 0.3);
    border-radius: var(--ps-radius-sm);
    padding: 2px;
    border: 1px solid var(--ps-border);
}

.vnccs-ps-toggle-btn {
    flex: 1;
    border: none;
    padding: 4px 8px;
    cursor: pointer;
    border-radius: 6px;
    font-size: 10px;
    font-weight: 600;
    font-family: var(--ps-font);
    transition: all var(--ps-transition);
    background: transparent;
    color: var(--ps-text-muted);
}

.vnccs-ps-toggle-btn.active {
    color: #1a1525;
}

.vnccs-ps-toggle-btn.male.active {
    background: linear-gradient(135deg, #6ab0f5, #a3d0ff);
    box-shadow: 0 2px 8px rgba(106, 176, 245, 0.3);
}

.vnccs-ps-toggle-btn.female.active {
    background: linear-gradient(135deg, var(--ps-accent), var(--ps-accent-hover));
    box-shadow: 0 2px 8px var(--ps-accent-glow);
}

.vnccs-ps-toggle-btn.list.active {
    background: linear-gradient(135deg, #64d8cb, #a0ede6);
    box-shadow: 0 2px 8px rgba(100, 216, 203, 0.3);
}

.vnccs-ps-toggle-btn.grid.active {
    background: linear-gradient(135deg, #ffb347, #ffd580);
    box-shadow: 0 2px 8px rgba(255, 179, 71, 0.3);
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
    height: 26px;
    border: 1px solid var(--ps-border);
    border-radius: var(--ps-radius-sm);
    cursor: pointer;
    padding: 2px;
    background: var(--ps-input-bg);
    transition: border-color var(--ps-transition);
}

.vnccs-ps-color:hover {
    border-color: var(--ps-accent-border);
}

/* === Tab Bar === */
.vnccs-ps-tabs-shell {
    position: relative;
    display: flex;
    align-items: stretch;
    zoom: var(--vnccs-ps-ui-scale);
    background: rgba(0, 0, 0, 0.35);
    border-bottom: 1px solid var(--ps-border);
    flex-shrink: 0;
    min-width: 0;
}

.vnccs-ps-tabs {
    display: flex;
    align-items: flex-end;
    padding: 8px 10px 0;
    gap: 3px;
    overflow-x: auto;
    overflow-y: hidden;
    flex: 1;
    min-width: 0;
    scroll-behavior: smooth;
    scrollbar-width: none;
    -ms-overflow-style: none;
}

.vnccs-ps-tabs::-webkit-scrollbar {
    width: 0;
    height: 0;
    display: none;
}

.vnccs-ps-tab-scroll {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 30px;
    border: none;
    background: transparent;
    color: var(--ps-accent);
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    display: none;
    align-items: center;
    justify-content: center;
    transition: all var(--ps-transition);
    z-index: 4;
    box-shadow: none;
}

.vnccs-ps-tab-scroll.left {
    left: 0;
}

.vnccs-ps-tab-scroll.right {
    right: 0;
}

.vnccs-ps-tab-scroll.visible {
    display: flex;
}

.vnccs-ps-tab-scroll:disabled {
    opacity: 0.28;
    cursor: default;
    pointer-events: none;
}

.vnccs-ps-tab-scroll:hover {
    color: var(--ps-accent);
    background: transparent;
}

.vnccs-ps-tab {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 5px 12px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid var(--ps-border);
    border-bottom: none;
    border-radius: 8px 8px 0 0;
    color: var(--ps-text-muted);
    cursor: pointer;
    font-size: 10px;
    font-family: var(--ps-font);
    font-weight: 600;
    white-space: nowrap;
    transition: all var(--ps-transition);
}

.vnccs-ps-tab:hover {
    background: rgba(255, 143, 163, 0.08);
    color: var(--ps-text);
    border-color: var(--ps-accent-border);
}

.vnccs-ps-reset-btn {
    width: 20px;
    height: 20px;
    background: transparent;
    border: 1px solid var(--ps-border);
    color: var(--ps-text-muted);
    border-radius: 5px;
    cursor: pointer;
    font-size: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    transition: all var(--ps-transition);
}

.vnccs-ps-reset-btn:hover {
    color: var(--ps-accent);
    border-color: var(--ps-accent-border);
    background: var(--ps-accent-subtle);
}

/* Lighting UI Styles */
.vnccs-ps-light-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 15px;
    padding-right: 4px;
    padding-bottom: 8px;
}

/* Light Card */
.vnccs-ps-light-card {
    background: rgba(20, 16, 30, 0.7);
    border: 1px solid var(--ps-border);
    border-radius: var(--ps-radius-sm);
    overflow: hidden;
    box-shadow: 0 4px 14px rgba(0,0,0,0.25);
    transition: all var(--ps-transition);
}
.vnccs-ps-light-card:hover {
    border-color: var(--ps-border-hover);
    box-shadow: 0 6px 20px rgba(0,0,0,0.35);
    transform: translateY(-1px);
}

/* Header */
.vnccs-ps-light-header {
    background: rgba(0,0,0,0.2);
    padding: 6px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--ps-border);
}
.vnccs-ps-light-title {
    font-weight: 600;
    font-size: 10px;
    color: var(--ps-text);
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--ps-font);
}
.vnccs-ps-light-icon {
    font-size: 14px;
    opacity: 0.8;
}

/* Remove Button */
.vnccs-ps-light-remove {
    width: 20px; height: 20px;
    border-radius: 5px;
    background: transparent;
    color: var(--ps-text-dim);
    border: 1px solid transparent;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    transition: all var(--ps-transition);
    padding: 0;
}
.vnccs-ps-light-remove:hover {
    background: rgba(255, 71, 87, 0.12);
    color: #ff4757;
    border-color: rgba(255, 71, 87, 0.3);
}

/* Body */
.vnccs-ps-light-body {
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

/* Controls Grid */
.vnccs-ps-light-grid {
    display: grid;
    grid-template-columns: minmax(116px, 1.35fr) minmax(72px, 0.75fr);
    gap: 8px;
    align-items: center;
    min-width: 0;
}

/* Input Styles */
.vnccs-ps-light-select {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    background: var(--ps-input-bg);
    border: 1px solid var(--ps-border);
    border-radius: 6px;
    color: var(--ps-text);
    font-size: 10px;
    padding: 4px 22px 4px 7px;
    font-family: var(--ps-font);
    cursor: pointer;
    transition: border-color var(--ps-transition);
    text-overflow: ellipsis;
}
.vnccs-ps-light-select:focus { border-color: var(--ps-accent-border); outline: none; }

.vnccs-ps-light-color {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    height: 22px;
    border: 1px solid var(--ps-border);
    border-radius: 6px;
    padding: 2px;
    cursor: pointer;
    background: var(--ps-input-bg);
    transition: border-color var(--ps-transition);
}

.vnccs-ps-light-color:hover { border-color: var(--ps-accent-border); }

/* Sliders */
.vnccs-ps-light-slider-row {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) 42px;
    align-items: center;
    gap: 8px;
    min-width: 0;
}
.vnccs-ps-light-slider {
    width: 100%;
    min-width: 0;
    height: 3px;
    background: rgba(255,255,255,0.1);
    border-radius: 2px;
    -webkit-appearance: none;
}
.vnccs-ps-light-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 12px; height: 12px;
    border-radius: 50%;
    background: var(--ps-accent);
    cursor: pointer;
    box-shadow: 0 0 5px var(--ps-accent-glow);
}

/* Position Grid */
.vnccs-ps-light-pos-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 10px;
    align-items: center;
    background: rgba(0,0,0,0.25);
    padding: 8px;
    border-radius: var(--ps-radius-sm);
    border: 1px solid var(--ps-border);
}
.vnccs-ps-light-pos-label {
    font-size: 9px;
    color: var(--ps-text-muted);
    font-weight: 700;
    width: 10px;
}
.vnccs-ps-light-value {
    width: 42px;
    min-width: 42px;
    box-sizing: border-box;
    text-align: right;
    font-size: 9px;
    color: var(--ps-accent);
    font-family: var(--ps-font-mono);
}

/* Light Radar */
.vnccs-ps-light-radar-wrap {
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: rgba(0,0,0,0.35);
    padding: 10px;
    border-radius: var(--ps-radius-sm);
    border: 1px solid var(--ps-border);
}
.vnccs-ps-light-radar-main {
    display: flex;
    align-items: center;
    gap: 12px;
    justify-content: center;
    width: 100%;
}
.vnccs-ps-light-radar-canvas {
    border-radius: 50%;
    border: 1px solid var(--ps-border);
    cursor: crosshair;
    background: rgba(8, 6, 14, 0.9);
    box-shadow: inset 0 0 12px rgba(0,0,0,0.6), 0 0 8px rgba(255,143,163,0.05);
    flex-shrink: 0;
}
.vnccs-ps-light-slider-vert-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    height: 100px;
    width: 35px;
    flex-shrink: 0;
}
.vnccs-ps-light-slider-vert {
    -webkit-appearance: slider-vertical;
    appearance: slider-vertical;
    writing-mode: vertical-lr;
    direction: rtl;
    width: 6px;
    height: 70px;
    cursor: pointer;
    background: rgba(255,255,255,0.1);
    margin: 0;
}
.vnccs-ps-light-slider-vert::-webkit-slider-runnable-track {
    background: transparent;
}
.vnccs-ps-light-slider-vert::-webkit-slider-thumb {
    width: 12px; height: 12px;
}
.vnccs-ps-light-h-val {
    font-size: 10px;
    color: var(--ps-accent);
    height: 12px;
    line-height: 12px;
    font-family: var(--ps-font-mono);
}
.vnccs-ps-light-h-label {
    font-size: 9px;
    color: var(--ps-text-dim);
    font-weight: 700;
    height: 12px;
    line-height: 12px;
}



/* Large Add Btn */
.vnccs-ps-btn-add-large {
    width: 100%;
    padding: 8px;
    background: rgba(255, 143, 163, 0.04);
    border: 1px dashed var(--ps-accent-border);
    border-radius: var(--ps-radius-sm);
    color: var(--ps-text-dim);
    cursor: pointer;
    font-size: 11px;
    font-family: var(--ps-font);
    transition: all var(--ps-transition);
    margin-top: 5px;
}
.vnccs-ps-btn-add-large:hover {
    border-color: var(--ps-accent);
    color: var(--ps-accent);
    background: var(--ps-accent-subtle);
}

.vnccs-ps-tab.active {
    background: rgba(255, 143, 163, 0.12);
    color: var(--ps-accent);
    border-color: var(--ps-accent-border);
    border-bottom: 1px solid rgba(16, 14, 24, 0.92);
    margin-bottom: -1px;
    box-shadow: 0 -3px 10px rgba(255, 143, 163, 0.1);
}

.vnccs-ps-tab-close {
    font-size: 14px;
    line-height: 1;
    color: var(--ps-text-muted);
    cursor: pointer;
    opacity: 0.6;
    transition: all var(--ps-transition);
}

.vnccs-ps-tab-close:hover {
    color: var(--ps-danger);
    opacity: 1;
}

.vnccs-ps-tab-add {
    padding: 5px 10px;
    background: transparent;
    border: 1px dashed rgba(255, 255, 255, 0.12);
    border-radius: 8px 8px 0 0;
    color: var(--ps-text-muted);
    cursor: pointer;
    font-size: 16px;
    font-family: var(--ps-font);
    transition: all var(--ps-transition);
    line-height: 1;
}

.vnccs-ps-tab-add:hover {
    background: var(--ps-accent-subtle);
    border-color: var(--ps-accent-border);
    color: var(--ps-accent);
}

/* === SAM Camera Banner === */
.vnccs-ps-sam-cam-banner {
    display: none;
    position: absolute;
    top: 8px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 50;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 6px 18px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.02em;
    user-select: none;
    background: rgba(20, 16, 30, 0.92);
    color: #ffaa33;
    border: 1px solid rgba(255, 150, 40, 0.55);
    border-radius: 6px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.55);
    backdrop-filter: blur(6px);
    transition: color 0.15s, border-color 0.15s;
    white-space: nowrap;
    pointer-events: auto;
}
.vnccs-ps-sam-cam-banner.vnccs-sam-visible { display: flex; }
.vnccs-ps-sam-cam-banner.vnccs-sam-paused {
    color: rgba(160, 140, 120, 0.6);
    border-color: rgba(120, 100, 80, 0.35);
}
.vnccs-ps-sam-cam-banner .vnccs-sam-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #ffaa33;
    flex-shrink: 0;
    box-shadow: 0 0 6px #ffaa33;
}
.vnccs-ps-sam-cam-banner.vnccs-sam-paused .vnccs-sam-dot {
    background: #555;
    box-shadow: none;
}

/* === 3D Canvas === */
.vnccs-ps-canvas-wrap {
    flex: 1;
    position: relative;
    overflow: hidden;
    /* NOTE: no flex centering here — canvas must fill 100% of container, not be letterboxed */
    background:
        radial-gradient(circle, rgba(255, 143, 163, 0.04) 1px, transparent 1px),
        linear-gradient(180deg, #080810 0%, #0d0b18 100%);
    background-size: 22px 22px, 100% 100%;
}

.vnccs-ps-canvas-wrap canvas {
    /* NOTE: must be 100% not max-width/max-height — viewer fills full container */
    width: 100% !important;
    height: 100% !important;
    display: block;
}

/* === Action Bar === */
.vnccs-ps-actions {
    display: flex;
    flex-wrap: wrap;
    zoom: var(--vnccs-ps-ui-scale);
    gap: 5px;
    padding: 7px 8px;
    background: rgba(0, 0, 0, 0.3);
    border-top: 1px solid var(--ps-border);
    flex-shrink: 0;
}

.vnccs-ps-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 6px 12px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--ps-border);
    border-radius: var(--ps-radius-sm);
    color: var(--ps-text);
    cursor: pointer;
    font-size: 10px;
    font-weight: 600;
    font-family: var(--ps-font);
    transition: all var(--ps-transition);
}

.vnccs-ps-btn:hover {
    background: rgba(255, 255, 255, 0.09);
    border-color: var(--ps-border-hover);
    transform: translateY(-1px);
}

.vnccs-ps-btn.primary {
    background: linear-gradient(135deg, var(--ps-accent) 0%, var(--ps-accent-hover) 100%);
    border-color: var(--ps-accent);
    color: #1a1525;
    font-weight: 700;
    box-shadow: 0 3px 12px var(--ps-accent-glow);
    position: relative;
    overflow: hidden;
}

.vnccs-ps-btn.primary::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.18) 45%, rgba(255,255,255,0.28) 50%, rgba(255,255,255,0.18) 55%, transparent 100%);
    transform: translateX(-120%) skewX(-15deg);
    animation: ps-btn-shimmer 3.5s ease-in-out infinite;
    pointer-events: none;
}

@keyframes ps-btn-shimmer {
    0%  { transform: translateX(-120%) skewX(-15deg); opacity: 1; }
    35% { transform: translateX(120%) skewX(-15deg); opacity: 1; }
    100%{ transform: translateX(120%) skewX(-15deg); opacity: 0; }
}

.vnccs-ps-btn.primary:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 20px var(--ps-accent-glow);
}

.vnccs-ps-btn.danger {
    background: rgba(255, 71, 87, 0.12);
    border-color: rgba(255, 71, 87, 0.3);
    color: #ff4757;
}

.vnccs-ps-btn.danger:hover {
    background: #ff4757;
    border-color: #ff4757;
    color: white;
}

.vnccs-ps-btn--sync-tabs {
    background: rgba(80, 120, 200, 0.18);
    border-color: rgba(100, 150, 255, 0.35);
    color: #8ab4ff;
}

.vnccs-ps-btn--sync-tabs:hover {
    background: rgba(80, 120, 200, 0.32);
    border-color: rgba(100, 150, 255, 0.6);
    color: #b8d0ff;
}

.vnccs-ps-btn-icon {
    font-size: 14px;
    line-height: 1;
}

/* === Modal Dialog === */
.vnccs-ps-modal-overlay {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(8px);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
    pointer-events: auto;
}

.vnccs-ps-modal {
    background: rgba(18, 14, 28, 0.95);
    border: 1px solid var(--ps-accent-border);
    border-radius: var(--ps-radius-lg);
    width: 340px;
    box-shadow: 0 24px 60px rgba(0,0,0,0.7), 0 0 0 1px rgba(255, 143, 163, 0.05);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 0;
    position: relative;
}

.vnccs-ps-modal::before {
    content: '';
    position: absolute;
    top: 0; left: 15%; right: 15%;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(255, 143, 163, 0.6), transparent);
    pointer-events: none;
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

/* === Pose Manager === */
.vnccs-pose-studio.vnccs-ps-mode-manager > .vnccs-ps-left,
.vnccs-pose-studio.vnccs-ps-mode-manager > .vnccs-ps-center,
.vnccs-pose-studio.vnccs-ps-mode-manager > .vnccs-ps-right-sidebar {
    display: none;
}

.vnccs-pose-studio.vnccs-ps-mode-manager-detail .vnccs-ps-tabs-shell {
    display: none;
}

.vnccs-pose-studio.vnccs-ps-mode-manager-detail .vnccs-ps-main-moved-manager,
.vnccs-pose-studio.vnccs-ps-mode-manager-detail .vnccs-ps-camera-dim-row {
    display: none;
}

.vnccs-pose-studio.vnccs-ps-mode-manager .vnccs-ps-btn.primary::after,
.vnccs-pose-studio.vnccs-ps-mode-manager-detail .vnccs-ps-btn.primary::after {
    display: none;
    animation: none;
}

.vnccs-pose-studio.vnccs-ps-mode-manager-detail {
    padding-top: 130px;
}

.vnccs-pose-studio.vnccs-ps-mode-manager-detail .vnccs-ps-manager,
.vnccs-pose-studio:not(.vnccs-ps-mode-manager) .vnccs-ps-manager {
    display: none;
}

.vnccs-ps-manager-detail-strip {
    display: none;
}

.vnccs-pose-studio.vnccs-ps-mode-manager-detail .vnccs-ps-manager-detail-strip {
    --pm-detail-card-w: 96px;
    display: flex;
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 75;
    height: 130px;
    box-sizing: border-box;
    align-items: stretch;
    gap: 8px;
    padding: 8px 10px;
    overflow-x: auto;
    overflow-y: hidden;
    background: rgba(0, 0, 0, 0.35);
    border-bottom: 1px solid var(--ps-accent-border);
    pointer-events: auto;
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 143, 163, 0.45) transparent;
}

.vnccs-pose-studio.vnccs-ps-mode-manager-detail .vnccs-ps-manager-detail-strip::-webkit-scrollbar {
    height: 6px;
}

.vnccs-pose-studio.vnccs-ps-mode-manager-detail .vnccs-ps-manager-detail-strip::-webkit-scrollbar-thumb {
    background: rgba(255, 143, 163, 0.45);
    border-radius: 999px;
}

.vnccs-ps-detail-card {
    width: var(--pm-detail-card-w);
    height: 106px;
    flex: 0 0 var(--pm-detail-card-w);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-radius: 6px;
    border: 1px solid rgba(255, 143, 163, 0.24);
    background: #101017;
    color: var(--ps-text);
    cursor: pointer;
    box-sizing: border-box;
}

.vnccs-ps-detail-card.active {
    border-color: rgba(255, 143, 163, 0.85);
    box-shadow: 0 0 0 1px rgba(255, 143, 163, 0.12);
}

.vnccs-ps-detail-card-preview {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #5b586b;
    overflow: hidden;
}

.vnccs-ps-detail-card-preview img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
}

.vnccs-ps-detail-card-bottom {
    height: 28px;
    flex-shrink: 0;
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 4px;
    padding: 4px 5px;
    background: rgba(7, 7, 13, 0.98);
    border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.vnccs-ps-detail-card-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 9px;
    font-weight: 800;
}

.vnccs-ps-detail-card-delete {
    width: 18px;
    height: 18px;
    padding: 0;
    border-radius: 5px;
    font-size: 10px;
}

.vnccs-ps-manager {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: #080810;
    pointer-events: auto;
}

.vnccs-ps-manager-header {
    height: 50px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 0 12px;
    border-bottom: 1px solid var(--ps-accent-border);
    background: rgba(12, 11, 18, 0.96);
}

.vnccs-ps-manager-title {
    font-size: 12px;
    line-height: 1;
    font-weight: 800;
    letter-spacing: 1px;
    color: var(--ps-text);
    text-transform: uppercase;
    white-space: nowrap;
}

.vnccs-ps-manager-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-shrink: 0;
}

.vnccs-ps-manager-body {
    flex: 1;
    min-height: 0;
    display: flex;
    overflow: hidden;
}

.vnccs-ps-manager-sidebar {
    width: 220px;
    zoom: var(--vnccs-ps-ui-scale);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    overflow-y: auto;
    border-right: 1px solid var(--ps-border);
    background: rgba(6, 5, 12, 0.7);
    pointer-events: auto;
}

.vnccs-ps-manager-sidebar::-webkit-scrollbar { width: 4px; }
.vnccs-ps-manager-sidebar::-webkit-scrollbar-thumb { background: var(--ps-accent-border); border-radius: 2px; }

.vnccs-ps-manager-stage {
    --pm-card-w: 260px;
    --pm-card-h: 370px;
    --pm-card-footer-h: 52px;
    flex: 1;
    min-height: 0;
    padding: 14px 18px 18px;
    overflow: hidden;
}

.vnccs-ps-manager-grid {
    height: 100%;
    display: grid;
    grid-template-columns: repeat(var(--pm-cols, 1), minmax(0, 1fr));
    align-content: flex-start;
    gap: 14px;
}

.vnccs-ps-pose-card {
    width: 100%;
    height: var(--pm-card-h);
    min-width: 28px;
    min-height: 40px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-radius: 8px;
    border: 1px solid rgba(255, 143, 163, 0.28);
    background: #111119;
    color: var(--ps-text);
    cursor: pointer;
    box-shadow: 0 10px 26px rgba(0, 0, 0, 0.34);
    transition: border-color var(--ps-transition), transform var(--ps-transition), box-shadow var(--ps-transition);
    box-sizing: border-box;
}

.vnccs-ps-pose-card:hover,
.vnccs-ps-pose-card.active {
    border-color: rgba(255, 143, 163, 0.72);
    box-shadow: 0 14px 36px rgba(0, 0, 0, 0.46), 0 0 0 1px rgba(255, 143, 163, 0.1);
    transform: translateY(-1px);
}

.vnccs-ps-pose-preview {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #5b586b;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    overflow: hidden;
}

.vnccs-ps-pose-preview img {
    width: calc(100% - 10px);
    height: calc(100% - 10px);
    object-fit: contain;
    display: block;
}

.vnccs-ps-pose-preview-empty {
    width: 38%;
    aspect-ratio: 1 / 2.15;
    border-radius: 999px 999px 12px 12px;
    background: linear-gradient(180deg, rgba(238, 226, 214, 0.72), rgba(188, 176, 166, 0.72));
    opacity: 0.8;
    position: relative;
}

.vnccs-ps-pose-preview-empty::before {
    content: '';
    position: absolute;
    width: 34%;
    aspect-ratio: 1;
    border-radius: 50%;
    left: 33%;
    top: -18%;
    background: rgba(238, 226, 214, 0.84);
}

.vnccs-ps-pose-card-bottom {
    flex-shrink: 0;
    height: var(--pm-card-footer-h);
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: clamp(2px, calc(var(--pm-card-w) * 0.035), 10px);
    padding: 6px clamp(7px, calc(var(--pm-card-w) * 0.045), 14px);
    box-sizing: border-box;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(7, 7, 13, 0.98);
}

.vnccs-ps-pose-card-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: clamp(7px, calc(var(--pm-card-w) * 0.075), 20px);
    font-weight: 800;
    min-width: 0;
}

.vnccs-ps-pose-card-delete {
    min-width: clamp(14px, calc(var(--pm-card-w) * 0.24), 76px);
    height: clamp(20px, calc(var(--pm-card-footer-h) - 12px), 48px);
    padding: 0 clamp(2px, calc(var(--pm-card-w) * 0.04), 14px);
    border-radius: clamp(4px, calc(var(--pm-card-w) * 0.03), 8px);
    font-size: clamp(6px, calc(var(--pm-card-w) * 0.065), 18px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.vnccs-ps-pose-card-delete {
    min-width: clamp(14px, calc(var(--pm-card-w) * 0.16), 52px);
    color: #ff6474;
}

.vnccs-ps-manager-empty {
    margin: auto;
    color: var(--ps-text-muted);
    font-size: 12px;
    font-weight: 700;
}

.vnccs-ps-manager-back {
    display: none;
}

.vnccs-pose-studio.vnccs-ps-mode-manager-detail .vnccs-ps-manager-back {
    display: flex;
    width: 100%;
    position: static !important;
    transform: none;
    align-items: center;
    justify-content: center;
    padding: 10px;
    border-radius: 8px;
    text-align: center;
    line-height: 1.25;
    font-size: 12px;
    font-weight: 800;
    box-shadow: 0 8px 26px var(--ps-accent-glow);
    pointer-events: auto;
}

.vnccs-ps-modal-title {
    background: rgba(0, 0, 0, 0.3);
    padding: 12px 16px;
    border-bottom: 1px solid var(--ps-border);
    font-size: 13px;
    font-weight: 700;
    color: var(--ps-accent);
    margin: 0;
    font-family: var(--ps-font);
    letter-spacing: 0.5px;
}

.vnccs-ps-modal-content {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px;
}

.vnccs-ps-modal-btn {
    padding: 10px 12px;
    border: 1px solid var(--ps-border);
    background: rgba(255, 255, 255, 0.04);
    color: var(--ps-text);
    border-radius: var(--ps-radius-sm);
    cursor: pointer;
    text-align: left;
    transition: all var(--ps-transition);
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: var(--ps-font);
    font-size: 11px;
}

.vnccs-ps-modal-btn:hover {
    background: var(--ps-accent-subtle);
    border-color: var(--ps-accent-border);
    color: var(--ps-accent-hover);
}

.vnccs-ps-save-library-modal {
    width: min(680px, calc(100% - 32px));
    border-radius: 32px;
}

.vnccs-ps-save-library-modal .vnccs-ps-modal-title {
    padding: 24px 32px;
    font-size: 26px;
}

.vnccs-ps-save-library-modal .vnccs-ps-modal-content {
    gap: 16px;
    padding: 28px;
}

.vnccs-ps-save-library-modal .vnccs-ps-input,
.vnccs-ps-save-library-modal .vnccs-ps-textarea {
    width: 100%;
    min-height: 56px;
    padding: 16px 20px;
    font-size: 22px;
    border-radius: 16px;
}

.vnccs-ps-save-library-modal .vnccs-ps-save-prompt {
    min-height: 120px;
    resize: vertical;
}

.vnccs-ps-save-library-label {
    display: block;
    color: var(--ps-text-muted);
    font-size: 22px;
    margin-top: 8px;
}

.vnccs-ps-save-library-check {
    display: flex;
    align-items: center;
    gap: 16px;
    color: var(--ps-text-muted);
    font-size: 22px;
}

.vnccs-ps-save-library-check input[type="checkbox"] {
    width: 26px;
    height: 26px;
}

.vnccs-ps-save-library-modal .vnccs-ps-modal-btn {
    min-height: 72px;
    padding: 20px 24px;
    font-size: 22px;
    border-radius: 16px;
    justify-content: center;
}

.vnccs-ps-settings-panel {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(8, 6, 16, 0.97);
    backdrop-filter: blur(12px);
    z-index: 100;
    display: flex;
    flex-direction: column;
}

.vnccs-ps-hand-popover {
    position: absolute;
    width: 240px;
    max-width: calc(100% - 20px);
    box-sizing: border-box;
    padding: 12px;
    border-radius: 12px;
    border: 1px solid rgba(255, 214, 102, 0.4);
    background: rgba(12, 10, 20, 0.94);
    box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 214, 102, 0.06);
    backdrop-filter: blur(12px);
    z-index: 110;
    display: none;
    gap: 10px;
}

.vnccs-ps-hand-popover.visible {
    display: flex;
    flex-direction: column;
}

.vnccs-ps-hand-popover-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
}

.vnccs-ps-hand-popover-title {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #ffd666;
}

.vnccs-ps-hand-popover-close {
    width: 24px;
    height: 24px;
    border: 1px solid var(--ps-border);
    border-radius: 999px;
    background: rgba(255,255,255,0.04);
    color: var(--ps-text-muted);
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
}

.vnccs-ps-hand-popover-close:hover {
    border-color: rgba(255, 214, 102, 0.45);
    color: #ffd666;
}

.vnccs-ps-settings-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px;
    background: rgba(0, 0, 0, 0.3);
    border-bottom: 1px solid var(--ps-border);
}

.vnccs-ps-settings-title {
    font-size: 13px;
    font-weight: 700;
    color: var(--ps-accent);
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--ps-font);
    letter-spacing: 0.5px;
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
    transition: color var(--ps-transition);
}

.vnccs-ps-settings-close:hover {
    color: var(--ps-accent);
}

.vnccs-ps-msg-modal {
    background: rgba(18, 14, 28, 0.95);
    border: 1px solid var(--ps-accent-border);
    border-radius: var(--ps-radius-lg);
    width: 340px;
    box-shadow: 0 24px 60px rgba(0,0,0,0.7);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 0;
}

.vnccs-ps-modal-btn.cancel:hover {
    color: var(--ps-text);
    background: rgba(255, 255, 255, 0.06);
}

/* === Pose Library Panel === */
.vnccs-ps-library-btn {
    position: absolute;
    right: 0;
    top: 50%;
    transform: translateY(-50%);
    background: linear-gradient(180deg, var(--ps-accent), var(--ps-accent-lavender));
    color: #1a1525;
    border: none;
    border-radius: 8px 0 0 8px;
    padding: 14px 7px;
    cursor: pointer;
    font-size: 16px;
    z-index: 100;
    transition: all var(--ps-transition);
    pointer-events: auto;
    box-shadow: -4px 0 20px var(--ps-accent-glow);
}

.vnccs-ps-library-btn:hover {
    padding-right: 12px;
    box-shadow: -6px 0 28px var(--ps-accent-glow);
}

/* Library Modal Overlay */
.vnccs-ps-modal-overlay {
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    background: rgba(0, 0, 0, 0.85);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    pointer-events: auto;
    backdrop-filter: blur(10px);
}

.vnccs-ps-library-modal {
    --vnccs-ps-library-ui-scale: 1;
    width: calc(100% - 24px);
    max-width: none;
    height: calc(100% - 24px);
    max-height: none;
    background: rgba(14, 11, 22, 0.96);
    border: 1px solid var(--ps-accent-border);
    border-radius: var(--ps-radius-lg);
    display: flex;
    flex-direction: column;
    box-shadow: 0 32px 80px rgba(0,0,0,0.85), 0 0 0 1px rgba(255,143,163,0.05);
    overflow: hidden;
    flex-shrink: 0;
    position: relative;
}

.vnccs-ps-library-modal::before {
    content: '';
    position: absolute;
    top: 0; left: 15%; right: 15%;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(255, 143, 163, 0.7), transparent);
    pointer-events: none;
}

.vnccs-ps-library-modal-header {
    display: flex;
    align-items: center;
    gap: calc(24px * var(--vnccs-ps-library-ui-scale));
    padding: calc(32px * var(--vnccs-ps-library-ui-scale)) calc(44px * var(--vnccs-ps-library-ui-scale));
    background: rgba(0, 0, 0, 0.3);
    border-bottom: 1px solid var(--ps-border);
}

.vnccs-ps-library-modal-title {
    font-size: calc(32px * var(--vnccs-ps-library-ui-scale));
    font-weight: 700;
    color: var(--ps-accent);
    display: flex;
    align-items: center;
    gap: calc(20px * var(--vnccs-ps-library-ui-scale));
    font-family: var(--ps-font);
    letter-spacing: calc(1px * var(--vnccs-ps-library-ui-scale));
    margin-right: auto;
}

.vnccs-ps-library-header-actions {
    display: flex;
    align-items: center;
    gap: calc(20px * var(--vnccs-ps-library-ui-scale));
    min-width: 0;
}

.vnccs-ps-library-save-current {
    width: auto;
    min-width: calc(300px * var(--vnccs-ps-library-ui-scale));
    padding: calc(18px * var(--vnccs-ps-library-ui-scale)) calc(28px * var(--vnccs-ps-library-ui-scale));
    justify-content: center;
}

.vnccs-ps-library-modal-header .vnccs-ps-btn,
.vnccs-ps-library-settings .vnccs-ps-btn {
    gap: calc(10px * var(--vnccs-ps-library-ui-scale));
    padding: calc(12px * var(--vnccs-ps-library-ui-scale)) calc(24px * var(--vnccs-ps-library-ui-scale));
    font-size: calc(20px * var(--vnccs-ps-library-ui-scale));
}

.vnccs-ps-library-modal-header .vnccs-ps-btn-icon,
.vnccs-ps-library-settings .vnccs-ps-btn-icon {
    font-size: calc(28px * var(--vnccs-ps-library-ui-scale));
}

.vnccs-ps-library-menu-btn {
    width: calc(76px * var(--vnccs-ps-library-ui-scale));
    height: calc(76px * var(--vnccs-ps-library-ui-scale));
    border-radius: calc(8px * var(--vnccs-ps-library-ui-scale));
    border: 1px solid var(--ps-border);
    background: var(--ps-input-bg);
    color: var(--ps-text);
    cursor: pointer;
    font-size: calc(32px * var(--vnccs-ps-library-ui-scale));
    transition: all var(--ps-transition);
}

.vnccs-ps-library-menu-btn:hover {
    border-color: var(--ps-accent-border);
    color: var(--ps-accent);
}

.vnccs-ps-library-toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: calc(20px * var(--vnccs-ps-library-ui-scale));
    padding: calc(28px * var(--vnccs-ps-library-ui-scale)) calc(44px * var(--vnccs-ps-library-ui-scale)) calc(16px * var(--vnccs-ps-library-ui-scale));
    background: rgba(0, 0, 0, 0.16);
}

.vnccs-ps-library-search {
    flex: 1 1 calc(420px * var(--vnccs-ps-library-ui-scale));
    min-width: calc(260px * var(--vnccs-ps-library-ui-scale));
    height: calc(76px * var(--vnccs-ps-library-ui-scale));
    border-radius: calc(8px * var(--vnccs-ps-library-ui-scale));
    border: 1px solid var(--ps-border);
    background: rgba(255,255,255,0.055);
    color: var(--ps-text);
    padding: 0 calc(28px * var(--vnccs-ps-library-ui-scale));
    font-family: var(--ps-font);
    font-size: calc(26px * var(--vnccs-ps-library-ui-scale));
    outline: none;
}

.vnccs-ps-library-search:focus {
    border-color: var(--ps-accent-border);
    box-shadow: 0 0 0 2px rgba(255,143,163,0.12);
}

.vnccs-ps-library-size-control {
    width: calc(380px * var(--vnccs-ps-library-ui-scale));
    flex: 0 0 calc(380px * var(--vnccs-ps-library-ui-scale));
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: calc(16px * var(--vnccs-ps-library-ui-scale));
    color: var(--ps-text-muted);
    font-size: calc(20px * var(--vnccs-ps-library-ui-scale));
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: calc(1.4px * var(--vnccs-ps-library-ui-scale));
    font-family: var(--ps-font);
}

.vnccs-ps-library-size-control input {
    width: 100%;
    height: calc(28px * var(--vnccs-ps-library-ui-scale));
    accent-color: var(--ps-accent);
}

.vnccs-ps-library-size-value {
    width: calc(68px * var(--vnccs-ps-library-ui-scale));
    text-align: right;
    color: var(--ps-accent);
}

.vnccs-ps-library-categories {
    display: flex;
    gap: calc(16px * var(--vnccs-ps-library-ui-scale));
    padding: calc(8px * var(--vnccs-ps-library-ui-scale)) calc(44px * var(--vnccs-ps-library-ui-scale)) calc(24px * var(--vnccs-ps-library-ui-scale));
    overflow-x: auto;
    border-bottom: 1px solid var(--ps-border);
}

.vnccs-ps-library-category-chip {
    height: calc(60px * var(--vnccs-ps-library-ui-scale));
    padding: 0 calc(24px * var(--vnccs-ps-library-ui-scale));
    border-radius: 999px;
    border: 1px solid var(--ps-border);
    background: rgba(255,255,255,0.04);
    color: var(--ps-text-muted);
    font-family: var(--ps-font);
    font-size: calc(22px * var(--vnccs-ps-library-ui-scale));
    white-space: nowrap;
    cursor: pointer;
}

.vnccs-ps-library-category-chip.active,
.vnccs-ps-library-category-chip:hover {
    color: var(--ps-accent);
    border-color: var(--ps-accent-border);
    background: var(--ps-accent-subtle);
}

.vnccs-ps-library-workspace {
    --vnccs-ps-library-inspector-base-width: 510px;
    --vnccs-ps-library-inspector-scale: 1;
    --vnccs-ps-library-inspector-width: calc(
        var(--vnccs-ps-library-inspector-base-width) * var(--vnccs-ps-library-inspector-scale)
    );
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
}

.vnccs-ps-library-workspace.has-inspector {
    grid-template-columns: minmax(0, 1fr) var(--vnccs-ps-library-inspector-width);
}

.vnccs-ps-library-workspace.settings-mode {
    grid-template-columns: minmax(0, 1fr);
}

.vnccs-ps-library-workspace.settings-mode .vnccs-ps-library-modal-grid,
.vnccs-ps-library-workspace.settings-mode .vnccs-ps-library-inspector {
    display: none;
}

.vnccs-ps-library-settings {
    min-height: 0;
    overflow-y: auto;
    padding: 40px 44px;
    display: none;
    flex-direction: column;
    gap: 28px;
}

.vnccs-ps-library-workspace.settings-mode .vnccs-ps-library-settings {
    display: flex;
}

.vnccs-ps-library-settings-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
}

.vnccs-ps-library-settings-title {
    color: var(--ps-text);
    font-size: 30px;
    font-weight: 700;
    font-family: var(--ps-font);
}

.vnccs-ps-library-settings-subtitle {
    color: var(--ps-text-muted);
    font-size: 22px;
    margin-top: 8px;
}

.vnccs-ps-library-repo-add {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 16px;
}

.vnccs-ps-library-repo-notice {
    display: none;
    padding: 14px 18px;
    border: 1px solid var(--ps-accent-border);
    border-radius: 8px;
    background: var(--ps-accent-subtle);
    color: var(--ps-accent);
    font-size: 20px;
    line-height: 1.35;
}

.vnccs-ps-library-repo-notice.visible {
    display: block;
}

.vnccs-ps-library-repo-notice.error {
    border-color: rgba(255,71,87,0.45);
    background: rgba(255,71,87,0.1);
    color: var(--ps-danger);
}

.vnccs-ps-library-settings .vnccs-ps-input {
    padding: 10px 16px;
    font-size: 20px;
}

.vnccs-ps-library-repo-list {
    display: flex;
    flex-direction: column;
    gap: 20px;
}

.vnccs-ps-library-local-repo {
    margin-bottom: 20px;
}

.vnccs-ps-library-repo-card {
    border: 1px solid var(--ps-border);
    border-radius: 8px;
    background: rgba(255,255,255,0.035);
    padding: 24px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 24px;
    align-items: center;
}

.vnccs-ps-library-repo-title {
    color: var(--ps-text);
    font-weight: 700;
    font-size: 24px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.vnccs-ps-library-repo-id,
.vnccs-ps-library-repo-meta {
    color: var(--ps-text-muted);
    font-size: 20px;
    margin-top: 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.vnccs-ps-library-repo-actions {
    display: flex;
    gap: 12px;
    align-items: center;
}

.vnccs-ps-library-repo-action {
    height: 60px;
    padding: 0 20px;
    border-radius: 7px;
    border: 1px solid var(--ps-border);
    background: var(--ps-input-bg);
    color: var(--ps-text-muted);
    font-size: 22px;
    cursor: pointer;
}

.vnccs-ps-library-repo-action:hover {
    color: var(--ps-accent);
    border-color: var(--ps-accent-border);
}

.vnccs-ps-library-repo-action.primary {
    background: var(--ps-accent);
    color: var(--ps-bg);
    border-color: var(--ps-accent-border);
    font-weight: 700;
}

.vnccs-ps-library-repo-action.primary:hover {
    color: var(--ps-bg);
    filter: brightness(1.05);
}

.vnccs-ps-library-repo-action.danger:hover {
    color: var(--ps-danger);
    border-color: rgba(255,71,87,0.45);
}

.vnccs-ps-library-repo-card.is-running .vnccs-ps-library-repo-action {
    opacity: 0.55;
    pointer-events: none;
}

.vnccs-ps-library-repo-progress {
    grid-column: 1 / -1;
    display: none;
    margin-top: 4px;
}

.vnccs-ps-library-repo-progress.visible {
    display: block;
}

.vnccs-ps-library-repo-progress-head {
    display: flex;
    justify-content: space-between;
    gap: 20px;
    color: var(--ps-text-muted);
    font-size: 20px;
    line-height: 1.35;
    margin-bottom: 12px;
}

.vnccs-ps-library-repo-progress-message {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.vnccs-ps-library-repo-progress-percent {
    flex: 0 0 auto;
    color: var(--ps-accent);
    font-weight: 700;
}

.vnccs-ps-library-repo-progress-track {
    height: 16px;
    border-radius: 999px;
    overflow: hidden;
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.1);
}

.vnccs-ps-library-repo-progress-fill {
    width: 0%;
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, var(--ps-accent), #8fe3ff);
    box-shadow: 0 0 14px rgba(255, 143, 163, 0.35);
    transition: width 0.25s ease;
}

.vnccs-ps-library-repo-progress.error .vnccs-ps-library-repo-progress-fill {
    background: var(--ps-danger);
}

.vnccs-ps-library-repo-progress.success .vnccs-ps-library-repo-progress-fill {
    background: linear-gradient(90deg, #64d8cb, #8fe3ff);
}

.vnccs-ps-modal-close {
    background: transparent;
    border: none;
    color: var(--ps-text-muted);
    font-size: 44px;
    cursor: pointer;
    transition: color var(--ps-transition);
    padding: 4px 12px;
}

.vnccs-ps-modal-close:hover { color: var(--ps-accent); }

.vnccs-ps-library-modal .vnccs-ps-modal-close {
    font-size: calc(44px * var(--vnccs-ps-library-ui-scale));
    padding: calc(4px * var(--vnccs-ps-library-ui-scale)) calc(12px * var(--vnccs-ps-library-ui-scale));
}

.vnccs-ps-library-modal-grid {
    min-height: 0;
    overflow-y: auto;
    padding: calc(20px * var(--vnccs-ps-library-ui-scale));
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--vnccs-ps-library-thumb-size, 320px), 1fr));
    gap: calc(16px * var(--vnccs-ps-library-ui-scale));
    align-content: start;
}
.vnccs-ps-library-modal-grid::-webkit-scrollbar { width: 6px; }
.vnccs-ps-library-modal-grid::-webkit-scrollbar-track { background: rgba(0,0,0,0.2); }
.vnccs-ps-library-modal-grid::-webkit-scrollbar-thumb { background: var(--ps-accent-border); border-radius: 3px; }
.vnccs-ps-library-modal-grid::-webkit-scrollbar-thumb:hover { background: var(--ps-accent); }

.vnccs-ps-library-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 12px;
    border-bottom: 1px solid var(--ps-border);
    background: rgba(0, 0, 0, 0.25);
}

.vnccs-ps-library-title {
    font-weight: 700;
    color: var(--ps-accent);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    font-family: var(--ps-font);
}

.vnccs-ps-library-close {
    background: transparent;
    border: none;
    color: var(--ps-text-muted);
    font-size: 18px;
    cursor: pointer;
    padding: 0;
    line-height: 1;
    transition: color var(--ps-transition);
}

.vnccs-ps-library-close:hover {
    color: var(--ps-accent);
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
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--ps-border);
    border-radius: 9px;
    overflow: hidden;
    cursor: pointer;
    transition: all var(--ps-transition);
    position: relative;
    min-height: var(--vnccs-ps-library-thumb-height, 420px);
    display: flex;
    flex-direction: column;
}

.vnccs-ps-library-item.selected {
    border-color: var(--ps-accent);
    box-shadow: 0 0 0 1px var(--ps-accent-border), 0 10px 28px rgba(0,0,0,0.35);
}

.vnccs-ps-library-item-delete {
    position: absolute;
    top: calc(6px * var(--vnccs-ps-library-ui-scale));
    right: calc(6px * var(--vnccs-ps-library-ui-scale));
    width: calc(22px * var(--vnccs-ps-library-ui-scale));
    height: calc(22px * var(--vnccs-ps-library-ui-scale));
    background: rgba(255, 71, 87, 0.75);
    color: white;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: calc(14px * var(--vnccs-ps-library-ui-scale));
    line-height: 1;
    cursor: pointer;
    opacity: 0;
    transition: all var(--ps-transition);
    z-index: 10;
}

.vnccs-ps-library-item:hover .vnccs-ps-library-item-delete {
    opacity: 1;
}

.vnccs-ps-library-item-delete:hover {
    background: #ff4757;
    transform: scale(1.15);
}

.vnccs-ps-library-item:hover {
    border-color: var(--ps-accent-border);
    transform: translateY(-3px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.3), 0 0 12px var(--ps-accent-subtle);
}

.vnccs-ps-library-item-preview {
    width: 100%;
    flex: 1;
    min-height: 0;
    background: rgba(8, 6, 16, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ps-text-muted);
    font-size: calc(28px * var(--vnccs-ps-library-ui-scale));
    overflow: hidden;
    border-radius: inherit;
}

.vnccs-ps-library-item-preview img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    border-radius: inherit;
}

.vnccs-ps-library-item-name {
    position: absolute;
    bottom: 0; left: 0; right: 0;
    width: 100%;
    box-sizing: border-box;
    padding: calc(9px * var(--vnccs-ps-library-ui-scale)) calc(8px * var(--vnccs-ps-library-ui-scale)) calc(10px * var(--vnccs-ps-library-ui-scale));
    background: rgba(0, 0, 0, 0.82);
    backdrop-filter: blur(4px);
    font-size: calc(11px * var(--vnccs-ps-library-ui-scale));
    text-align: center;
    color: var(--ps-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    z-index: 5;
    font-family: var(--ps-font);
    border-radius: 0 0 calc(8px * var(--vnccs-ps-library-ui-scale)) calc(8px * var(--vnccs-ps-library-ui-scale));
}

.vnccs-ps-library-item-meta {
    display: none;
}

.vnccs-ps-library-inspector {
    min-height: 0;
    overflow: hidden;
    padding: 0;
    border-left: 1px solid var(--ps-border);
    background: rgba(0,0,0,0.2);
    display: none;
    position: relative;
}

.vnccs-ps-library-inspector.visible {
    display: block;
}

.vnccs-ps-library-inspector-inner {
    width: var(--vnccs-ps-library-inspector-base-width);
    height: calc(100% / var(--vnccs-ps-library-inspector-scale));
    box-sizing: border-box;
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow-y: auto;
    transform: scale(var(--vnccs-ps-library-inspector-scale));
    transform-origin: top left;
}

.vnccs-ps-library-inspector-empty {
    color: var(--ps-text-muted);
    font-size: 12px;
    line-height: 1.5;
    padding: 24px 4px;
}

.vnccs-ps-library-inspector-preview {
    width: 100%;
    aspect-ratio: 1 / 1.25;
    border-radius: var(--ps-radius-sm);
    border: 1px solid var(--ps-border);
    overflow: hidden;
    background: rgba(8, 6, 16, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ps-text-muted);
    font-size: 34px;
}

.vnccs-ps-library-inspector-preview img {
    width: 100%;
    height: 100%;
    object-fit: contain;
}

.vnccs-ps-library-inspector-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
}

.vnccs-ps-library-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: var(--ps-text-muted);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.7px;
}

.vnccs-ps-library-field input[type="text"],
.vnccs-ps-library-field input[type="file"] {
    width: 100%;
    box-sizing: border-box;
}

.vnccs-ps-library-image-input {
    color: var(--ps-text-muted);
    font-size: 11px;
}

.vnccs-ps-library-save-edit {
    justify-content: center;
    margin-top: 4px;
}

.vnccs-ps-library-footer {
    padding: 8px;
    border-top: 1px solid var(--ps-border);
}

.vnccs-ps-library-empty {
    grid-column: 1 / -1;
    text-align: center;
    color: var(--ps-text-muted);
    padding: 24px;
    font-size: 12px;
    font-family: var(--ps-font);
}

/* === Loading Overlay === */
.vnccs-ps-loading-overlay {
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    background: rgba(6, 4, 12, 0.88);
    backdrop-filter: blur(12px);
    display: none;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 20px;
    z-index: 2000;
    color: var(--ps-text);
    cursor: wait;
}

/* Dual-ring sakura spinner */
.vnccs-ps-loading-spinner {
    width: 50px;
    height: 50px;
    position: relative;
}

.vnccs-ps-loading-spinner::before,
.vnccs-ps-loading-spinner::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 3px solid transparent;
}

.vnccs-ps-loading-spinner::before {
    border-top-color: var(--ps-accent);
    border-right-color: rgba(255, 143, 163, 0.3);
    animation: ps-spin 1s linear infinite;
    box-shadow: 0 0 18px var(--ps-accent-glow);
}

.vnccs-ps-import-progress {
    width: 100%;
    height: 8px;
    border-radius: 999px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.12);
    margin: 8px 0 2px;
}

.vnccs-ps-import-progress-fill {
    height: 100%;
    width: 0%;
    border-radius: inherit;
    background: linear-gradient(90deg, var(--ps-accent), #8fe3ff);
    box-shadow: 0 0 14px rgba(255, 143, 163, 0.45);
    transition: width 0.25s ease;
}

.vnccs-ps-import-progress-percent {
    min-height: 16px;
    font-size: 11px;
    color: var(--ps-text-muted);
    text-align: center;
}

.vnccs-ps-loading-spinner::after {
    inset: 8px;
    border-bottom-color: var(--ps-accent-lavender);
    border-left-color: rgba(184, 169, 232, 0.25);
    animation: ps-spin 1.5s linear infinite reverse;
}

@keyframes ps-spin {
    0%   { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
}

.vnccs-ps-loading-text {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 2px;
    color: var(--ps-accent);
    text-transform: uppercase;
    font-family: var(--ps-font);
}
`;

// Inject styles
const styleEl = document.createElement("style");
styleEl.textContent = STYLES;
document.head.appendChild(styleEl);


// === 3D Viewer (from Debug3) ===
class PoseStudioWidget {
    constructor(node) {
        this.node = node;
        this.container = null;
        this.canvas = null;
        this.viewer = null;

        this.poses = [{}];  // Array of pose data
        this.posePrompts = [""]; // User prompt per pose tab
        this.activeTab = 0;
        this.poseCaptures = []; // Cache for captured images
        this.ikMode = true; // IK mode toggle (false = FK, true = IK)
        this.interfaceMode = "studio"; // studio | manager | managerDetail
        this.pendingAgeCameraFit = false;

        // Slider values
        this.meshParams = {
            age: 25, gender: 0.5, weight: 0.5,
            muscle: 0.5, height: 0.5,
            // Female-specific
            breast_size: 0.5, firmness: 0.5,
            // Male-specific
            penis_len: 0.5, penis_circ: 0.5, penis_test: 0.5,
            // Visual modifiers (client-side bone scaling)
            head_size: 1.0,
            arm_size: 1.0,
            hand_size: 1.0,
            upper_arm_l_length: 0.5,
            upper_arm_r_length: 0.5,
            forearm_l_length: 0.5,
            forearm_r_length: 0.5,
            thigh_l_length: 0.5,
            thigh_r_length: 0.5,
            shin_l_length: 0.5,
            shin_r_length: 0.5,
            spine_length: 0.5
        };

        // Export settings
        this.exportParams = {
            view_width: 1024,
            view_height: 1024,
            cam_zoom: 1.0,
            cam_offset_x: 0,
            cam_offset_y: 0,
            cam_yaw_deg: 0,
            cam_pitch_deg: 0,
            output_mode: "LIST",
            grid_columns: 2,
            bg_color: [255, 255, 255],
            debugMode: false,
            debugPortraitMode: false, // Focus on upper body in debug mode
            debugKeepLighting: false, // Use manual lighting in debug mode
            debugShowSAMHelper: false, // Show imported SAM skeleton overlay in the viewer
            debugShowSAMMeshOverlay: false, // Show postprocessed SAM render mesh overlay
            samApplyCamera: false, // Allow SAM import to override camera yaw/pitch
            keepOriginalLighting: false, // Override to clean white lighting, no prompts
            user_prompt: "",
            prompt_template: "Draw character from image2\n<lighting>\n<user_prompt>",
            skin_type: "naked", // naked | naked_marks | dummy_white
            background_url: null,
            interface_mode: "studio"
        };

        // Lighting settings (array of light configs)
        this.lightParams = [
            { type: 'directional', color: '#ffffff', intensity: 2.0, x: 10, y: 20, z: 30 },
            { type: 'ambient', color: '#505050', intensity: 1.0, x: 0, y: 0, z: 0 }
        ];

        this.sliders = {};
        this.exportWidgets = {};
        this.tabsContainer = null;
        this.tabsShell = null;
        this.tabScrollLeft = null;
        this.tabScrollRight = null;
        this._tabResizeObserver = null;
        this.canvasContainer = null;
        this.managerPanel = null;
        this.managerGrid = null;
        this.managerStage = null;
        this.managerBody = null;
        this.managerSidebar = null;
        this.managerControls = {};
        this.managerGenderBtns = null;
        this.managerGenderFields = {};
        this.managerDetailStrip = null;
        this.managerResizeObserver = null;
        this.managerBackBtn = null;
        this._defaultHandPresets = HAND_PRESETS;
        this._handSliderValues = { spread: 0, grasp: 0, thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 };
        this._handSliderDefaults = { spread: 0, grasp: 0, thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 };
        this._handSliderRefs = {};
        this._handSliderValRefs = {};
        this._handBiasValues = [1.0, 1.0, 1.0];
        this._activeHandSide = null;
        this._lastSAM3DPoseData = null;
        this._lastSAM3DMeshData = null;
        this._samCameraModeActive = false;
        this._samCamBannerVisible = false;
        this._samCamDisplayActive = true;
        this._samCamPreParams = null;
        this._samCamStoredParams = null;
        this._samCamStoredProjectionFrame = null;
        this._hoveredHandSide = null;
        this._handPopover = null;
        this._handPopoverTitle = null;
        this._pendingHandPopoverOutsideClick = null;
        this._boundHandleDocumentPointerDown = (event) => this._handleDocumentPointerDown(event);
        this._boundHandleDocumentPointerUp = (event) => this._handleDocumentPointerUp(event);
        this._boundHandleDocumentPointerCancel = (event) => this._handleDocumentPointerCancel(event);
        this.libraryThumbSizeStorageKey = "vnccsPoseLibraryPreviewSize";
        this.libraryThumbSize = this.loadLibraryThumbnailSize();
        this.libraryResizeObserver = null;
        this.repositoryProgressStates = {};

        this.createUI();
    }

    createUI() {
        this._createLayout();
        this._createLeftPanel();
        this._createCenterPanel();
        this._createRightSidebar();
        this._createPoseManager();
        this._setupFinalUI();
        this.applyInterfaceMode();
    }

    _createLayout() {
        this.container = document.createElement("div");
        this.container.className = "vnccs-pose-studio";

        this.leftPanel = document.createElement("div");
        this.leftPanel.className = "vnccs-ps-left";
        this.container.appendChild(this.leftPanel);

        this.centerPanel = document.createElement("div");
        this.centerPanel.className = "vnccs-ps-center";
        this.container.appendChild(this.centerPanel);

        this.rightSidebar = document.createElement("div");
        this.rightSidebar.className = "vnccs-ps-right-sidebar";
        this.container.appendChild(this.rightSidebar);
    }

    _createPoseManager() {
        this.managerPanel = document.createElement("div");
        this.managerPanel.className = "vnccs-ps-manager";

        const header = document.createElement("div");
        header.className = "vnccs-ps-manager-header";

        const title = document.createElement("div");
        title.className = "vnccs-ps-manager-title";
        title.textContent = "VNCCS Pose Manager";

        const actions = document.createElement("div");
        actions.className = "vnccs-ps-manager-actions";

        const addBtn = document.createElement("button");
        addBtn.className = "vnccs-ps-btn primary";
        addBtn.type = "button";
        addBtn.textContent = "Add Pose";
        addBtn.addEventListener("click", () => {
            this.addTab({ capturePreview: true });
            this.setInterfaceMode("manager");
        });

        actions.appendChild(addBtn);
        header.appendChild(title);
        header.appendChild(actions);

        this.managerBody = document.createElement("div");
        this.managerBody.className = "vnccs-ps-manager-body";
        this.managerSidebar = this._createPoseManagerSidebar();

        this.managerStage = document.createElement("div");
        this.managerStage.className = "vnccs-ps-manager-stage";
        this.managerGrid = document.createElement("div");
        this.managerGrid.className = "vnccs-ps-manager-grid";
        this.managerStage.appendChild(this.managerGrid);
        this.managerBody.appendChild(this.managerSidebar);
        this.managerBody.appendChild(this.managerStage);

        this.managerPanel.appendChild(header);
        this.managerPanel.appendChild(this.managerBody);
        this.container.appendChild(this.managerPanel);

        if (typeof ResizeObserver !== "undefined") {
            this.managerResizeObserver = new ResizeObserver(() => this.layoutPoseManager());
            this.managerResizeObserver.observe(this.managerStage);
        }
        this.renderPoseManager();
    }

    _createPoseManagerSidebar() {
        const sidebar = document.createElement("div");
        sidebar.className = "vnccs-ps-manager-sidebar";

        const meshSection = this.createSection("Mesh Parameters", true);

        const genderField = document.createElement("div");
        genderField.className = "vnccs-ps-field";
        const genderLabel = document.createElement("div");
        genderLabel.className = "vnccs-ps-label";
        genderLabel.innerText = "Gender";
        const genderToggle = document.createElement("div");
        genderToggle.className = "vnccs-ps-toggle";

        const btnMale = document.createElement("button");
        btnMale.className = "vnccs-ps-toggle-btn male";
        btnMale.type = "button";
        btnMale.innerText = "Male";
        const btnFemale = document.createElement("button");
        btnFemale.className = "vnccs-ps-toggle-btn female";
        btnFemale.type = "button";
        btnFemale.innerText = "Female";
        this.managerGenderBtns = { male: btnMale, female: btnFemale };

        btnMale.addEventListener("click", () => this.setManagerGender(1.0));
        btnFemale.addEventListener("click", () => this.setManagerGender(0.0));
        genderToggle.appendChild(btnMale);
        genderToggle.appendChild(btnFemale);
        genderField.appendChild(genderLabel);
        genderField.appendChild(genderToggle);
        meshSection.content.appendChild(genderField);

        [
            { key: "age", label: "Age", min: 1, max: 90, step: 1 },
            { key: "weight", label: "Weight", min: 0, max: 1, step: 0.01 },
            { key: "muscle", label: "Muscle", min: 0, max: 1, step: 0.01 },
            { key: "height", label: "Height", min: 0, max: 2, step: 0.01 }
        ].forEach((def) => {
            meshSection.content.appendChild(this.createManagerSlider(def, "mesh"));
        });
        sidebar.appendChild(meshSection.el);

        const genderSection = this.createSection("Gender Settings", true);
        [
            { key: "breast_size", label: "Breast Size", min: 0, max: 2, step: 0.01, gender: "female" },
            { key: "firmness", label: "Firmness", min: 0, max: 1, step: 0.01, gender: "female" },
            { key: "penis_len", label: "Length", min: 0, max: 1, step: 0.01, gender: "male" },
            { key: "penis_circ", label: "Girth", min: 0, max: 1, step: 0.01, gender: "male" },
            { key: "penis_test", label: "Testicles", min: 0, max: 1, step: 0.01, gender: "male" }
        ].forEach((def) => {
            const field = this.createManagerSlider(def, "mesh");
            this.managerGenderFields[def.key] = { field, gender: def.gender };
            genderSection.content.appendChild(field);
        });
        sidebar.appendChild(genderSection.el);

        const cameraSection = this.createSection("Camera", true);
        const dimRow = document.createElement("div");
        dimRow.className = "vnccs-ps-row";
        dimRow.appendChild(this.createManagerInput({ key: "view_width", label: "Width", min: 64, max: 4096, step: 8 }));
        dimRow.appendChild(this.createManagerInput({ key: "view_height", label: "Height", min: 64, max: 4096, step: 8 }));
        cameraSection.content.appendChild(dimRow);
        sidebar.appendChild(cameraSection.el);

        this.refreshPoseManagerControls();
        return sidebar;
    }

    createManagerSlider(def, group) {
        const field = document.createElement("div");
        field.className = "vnccs-ps-field";

        const labelRow = document.createElement("div");
        labelRow.className = "vnccs-ps-label-row";
        labelRow.style.display = "flex";
        labelRow.style.justifyContent = "space-between";
        labelRow.style.alignItems = "center";

        const label = document.createElement("span");
        label.className = "vnccs-ps-label";
        label.innerText = def.label;

        const value = document.createElement("span");
        value.className = "vnccs-ps-value";

        const wrap = document.createElement("div");
        wrap.className = "vnccs-ps-slider-wrap";

        const slider = document.createElement("input");
        slider.type = "range";
        slider.className = "vnccs-ps-slider";
        slider.min = def.min;
        slider.max = def.max;
        slider.step = def.step;

        slider.addEventListener("input", () => {
            const next = this.normalizeManagerNumber(slider.value, def);
            slider.value = next;
            this.applyManagerMeshValue(def.key, next);
        });

        labelRow.appendChild(label);
        labelRow.appendChild(value);
        wrap.appendChild(slider);
        field.appendChild(labelRow);
        field.appendChild(wrap);

        this.managerControls[def.key] = { input: slider, value, group, def };
        return field;
    }

    createManagerInput(def) {
        const field = document.createElement("div");
        field.className = "vnccs-ps-field";

        const label = document.createElement("div");
        label.className = "vnccs-ps-label";
        label.innerText = def.label;

        const input = document.createElement("input");
        input.type = "number";
        input.className = "vnccs-ps-input";
        input.min = def.min;
        input.max = def.max;
        input.step = def.step;

        input.addEventListener("change", () => {
            const next = this.normalizeManagerNumber(input.value, def);
            input.value = next;
            this.applyManagerExportValue(def.key, next);
        });

        field.appendChild(label);
        field.appendChild(input);
        this.managerControls[def.key] = { input, group: "export", def };
        return field;
    }

    normalizeManagerNumber(value, def) {
        let next = Number(value);
        if (!Number.isFinite(next)) {
            const source = def.key in this.meshParams ? this.meshParams : this.exportParams;
            next = Number(source[def.key] ?? def.min ?? 0);
        }
        next = Math.max(def.min, Math.min(def.max, next));
        if (def.step >= 1) next = Math.round(next);
        return next;
    }

    formatManagerValue(key, value) {
        return key === "age" || key === "view_width" || key === "view_height"
            ? String(Math.round(Number(value) || 0))
            : Number(value || 0).toFixed(2);
    }

    applyManagerMeshValue(key, value) {
        this.meshParams[key] = value;
        const main = this.sliders?.[key];
        if (main) {
            main.slider.value = value;
            main.label.innerText = this.formatManagerValue(key, value);
        }
        this.refreshPoseManagerControls();
        this.onMeshParamsChanged(key);
        this.syncToNode(false, { skipCapture: true });
    }

    applyExternalCharacterCreatorValues(values, { initial = false } = {}) {
        if (!values) return false;
        let changed = false;
        const sourceKeys = [];

        if (Number.isFinite(values.age)) {
            const age = Math.max(1, Math.min(90, Math.round(values.age)));
            if (this.meshParams.age !== age) {
                this.meshParams.age = age;
                sourceKeys.push("age");
                changed = true;
            }
        }

        if (Number.isFinite(values.gender)) {
            const gender = Math.max(0, Math.min(1, values.gender));
            if (this.meshParams.gender !== gender) {
                this.meshParams.gender = gender;
                sourceKeys.push("gender");
                changed = true;
            }
        }

        if (!changed) return false;

        for (const key of sourceKeys) {
            const main = this.sliders?.[key];
            if (main) {
                main.slider.value = this.meshParams[key];
                main.label.innerText = this.formatManagerValue(key, this.meshParams[key]);
            }
        }

        this.updateGenderUI();
        this.updateGenderVisibility();
        this.refreshPoseManagerControls();
        if (initial) {
            this._suppressNextAgeFitSync = true;
        }
        this.onMeshParamsChanged(sourceKeys.includes("age") ? "age" : sourceKeys[0]);
        if (!initial) {
            this.syncToNode(false, { skipCapture: this.interfaceMode === "manager" });
        }
        return true;
    }

    setManagerGender(value) {
        this.meshParams.gender = value;
        this.updateGenderUI();
        this.updateGenderVisibility();
        this.refreshPoseManagerControls();
        this.onMeshParamsChanged("gender");
        this.syncToNode(false, { skipCapture: true });
    }

    applyManagerExportValue(key, value) {
        this.exportParams[key] = value;
        const main = this.exportWidgets?.[key];
        if (main) main.value = value;
        const isDimension = key === "view_width" || key === "view_height";
        if (isDimension) {
            this._lastResizeW = 0;
            this._lastResizeH = 0;
            this.resize();
            this.updateCaptureCameraPreview();
            this.layoutPoseManager();
        }
        this.refreshPoseManagerControls();
        if (isDimension) {
            this.syncToNode(true);
            return;
        }
        this.syncToNode(false, { skipCapture: true });
    }

    refreshPoseManagerControls() {
        if (this.managerGenderBtns) {
            const isFemale = this.meshParams.gender < 0.5;
            this.managerGenderBtns.male.classList.toggle("active", !isFemale);
            this.managerGenderBtns.female.classList.toggle("active", isFemale);
        }

        for (const [key, info] of Object.entries(this.managerControls || {})) {
            const source = info.group === "export" ? this.exportParams : this.meshParams;
            const value = source[key];
            if (info.input && value !== undefined) info.input.value = value;
            if (info.value) info.value.innerText = this.formatManagerValue(key, value);
        }

        const isFemale = this.meshParams.gender < 0.5;
        for (const info of Object.values(this.managerGenderFields || {})) {
            if (info.gender === "female") info.field.style.display = isFemale ? "" : "none";
            else if (info.gender === "male") info.field.style.display = isFemale ? "none" : "";
        }
    }

    _createLeftPanel() {
        const leftPanel = this.leftPanel;

        const managerBackWrap = document.createElement("div");
        managerBackWrap.style.paddingBottom = "5px";
        this.managerBackBtn = document.createElement("button");
        this.managerBackBtn.className = "vnccs-ps-btn primary vnccs-ps-manager-back";
        this.managerBackBtn.type = "button";
        this.managerBackBtn.textContent = "Back to Pose Manager";
        this.managerBackBtn.addEventListener("click", () => this.setInterfaceMode("manager"));
        managerBackWrap.appendChild(this.managerBackBtn);
        leftPanel.appendChild(managerBackWrap);

        // --- MESH PARAMS SECTION ---
        const meshSection = this.createSection("Mesh Parameters", true);
        meshSection.el.classList.add("vnccs-ps-main-moved-manager");

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
            this.onMeshParamsChanged("gender");
        });

        btnFemale.addEventListener("click", () => {
            this.meshParams.gender = 0.0;
            this.updateGenderUI();
            this.updateGenderVisibility();
            this.onMeshParamsChanged("gender");
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
            { key: "height", label: "Height", min: 0, max: 2, step: 0.01, def: 0.5 }
        ];

        for (const s of baseSliderDefs) {
            const field = this.createSliderField(s.label, s.key, s.min, s.max, s.step, s.def, this.meshParams);
            meshSection.content.appendChild(field);
        }

        leftPanel.appendChild(meshSection.el);

        // --- MESH PROPORTIONS SECTION ---
        const proportionsSection = this.createSection("Mesh Proportions", false);
        const proportionSliderDefs = [
            { key: "head_size", label: "Head Size", min: 0.5, max: 2.0, step: 0.01, def: 1.0 },
            { key: "arm_size",  label: "Arm Size",  min: 0.5, max: 2.0, step: 0.01, def: 1.0 },
            { key: "hand_size", label: "Hand Size", min: 0.5, max: 2.0, step: 0.01, def: 1.0 },
            { key: "upper_arm_l_length", label: "Left Upper Arm Length", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "upper_arm_r_length", label: "Right Upper Arm Length", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "forearm_l_length", label: "Left Forearm Length", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "forearm_r_length", label: "Right Forearm Length", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "thigh_l_length", label: "Left Thigh Length", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "thigh_r_length", label: "Right Thigh Length", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "shin_l_length", label: "Left Shin Length", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "shin_r_length", label: "Right Shin Length", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "spine_length", label: "Spine Length", min: 0, max: 1, step: 0.01, def: 0.5 }
        ];

        for (const s of proportionSliderDefs) {
            const field = this.createSliderField(s.label, s.key, s.min, s.max, s.step, s.def, this.meshParams);
            proportionsSection.content.appendChild(field);
        }

        leftPanel.appendChild(proportionsSection.el);

        // --- GENDER SETTINGS SECTION ---
        const genderSection = this.createSection("Gender Settings", true);
        genderSection.el.classList.add("vnccs-ps-main-moved-manager");
        this.genderFields = {};

        const femaleSliders = [
            { key: "breast_size", label: "Breast Size", min: 0, max: 2, step: 0.01, def: 0.5 },
            { key: "firmness", label: "Firmness", min: 0, max: 1, step: 0.01, def: 0.5 }
        ];

        for (const s of femaleSliders) {
            const field = this.createSliderField(s.label, s.key, s.min, s.max, s.step, s.def, this.meshParams);
            genderSection.content.appendChild(field);
            this.genderFields[s.key] = { field, gender: "female" };
        }

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

            const resetBtn = document.createElement("button");
            resetBtn.className = "vnccs-ps-reset-btn";
            resetBtn.innerHTML = "↺";
            resetBtn.title = "Reset to 0°";
            resetBtn.onclick = (e) => {
                e.stopPropagation();
                slider.value = 0;
                valueSpan.innerText = "0°";
                if (this.viewer) {
                    this.viewer.setModelRotation(axis === 'x' ? 0 : undefined, axis === 'y' ? 0 : undefined, axis === 'z' ? 0 : undefined);
                    this.syncToNode();
                }
            };

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
                    this.viewer.setModelRotation(axis === 'x' ? val : undefined, axis === 'y' ? val : undefined, axis === 'z' ? val : undefined);
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
        const dimRow = document.createElement("div");
        dimRow.className = "vnccs-ps-row vnccs-ps-camera-dim-row";
        dimRow.appendChild(this.createInputField("Width", "view_width", "number", 64, 4096, 8));
        dimRow.appendChild(this.createInputField("Height", "view_height", "number", 64, 4096, 8));
        camSection.content.appendChild(dimRow);

        const zoomField = this.createSliderField("Zoom", "cam_zoom", 0.1, 7.0, 0.01, 1.0, this.exportParams, true);
        camSection.content.appendChild(zoomField);

        this.createCameraRadar(camSection);
        leftPanel.appendChild(camSection.el);

        // --- CAMERA ANGLE SECTION ---
        const camAngleSection = this.createSection("Camera Angle", false);
        camAngleSection.content.appendChild(this.createSliderField("Yaw", "cam_yaw_deg", -180, 180, 1, 0, this.exportParams, true));
        camAngleSection.content.appendChild(this.createSliderField("Pitch", "cam_pitch_deg", -89, 89, 1, 0, this.exportParams, true));
        leftPanel.appendChild(camAngleSection.el);

        // --- EXPORT SETTINGS SECTION ---
        const exportSection = this.createSection("Export Settings", true);

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

        this.exportWidgets['output_mode'] = {
            value: this.exportParams.output_mode,
            update: (val) => {
                this.exportParams.output_mode = val;
                updateModeUI();
            }
        };

        exportSection.content.appendChild(modeField);

        const colsField = this.createInputField("Grid Columns", "grid_columns", "number", 1, 6, 1);
        exportSection.content.appendChild(colsField);

        const colorField = this.createColorField("Background", "bg_color");
        exportSection.content.appendChild(colorField);

        leftPanel.appendChild(exportSection.el);
    }

    _createCenterPanel() {
        const centerPanel = this.centerPanel;

        // Tab Bar
        this.tabsShell = document.createElement("div");
        this.tabsShell.className = "vnccs-ps-tabs-shell";

        this.tabScrollLeft = document.createElement("button");
        this.tabScrollLeft.className = "vnccs-ps-tab-scroll left";
        this.tabScrollLeft.type = "button";
        this.tabScrollLeft.title = "Scroll tabs left";
        this.tabScrollLeft.textContent = "<";
        this.tabScrollLeft.addEventListener("click", () => this.scrollTabs(-1));

        this.tabsContainer = document.createElement("div");
        this.tabsContainer.className = "vnccs-ps-tabs";
        this.tabsContainer.addEventListener("scroll", () => this.updateTabScrollButtons());

        this.tabScrollRight = document.createElement("button");
        this.tabScrollRight.className = "vnccs-ps-tab-scroll right";
        this.tabScrollRight.type = "button";
        this.tabScrollRight.title = "Scroll tabs right";
        this.tabScrollRight.textContent = ">";
        this.tabScrollRight.addEventListener("click", () => this.scrollTabs(1));

        this.tabsShell.appendChild(this.tabScrollLeft);
        this.tabsShell.appendChild(this.tabsContainer);
        this.tabsShell.appendChild(this.tabScrollRight);
        centerPanel.appendChild(this.tabsShell);
        if (typeof ResizeObserver !== "undefined") {
            this._tabResizeObserver = new ResizeObserver(() => this.updateTabScrollButtons());
            this._tabResizeObserver.observe(this.tabsContainer);
        }
        this.updateTabs();

        this.managerDetailStrip = document.createElement("div");
        this.managerDetailStrip.className = "vnccs-ps-manager-detail-strip";
        this.container.appendChild(this.managerDetailStrip);

        // Canvas Container
        this.canvasContainer = document.createElement("div");
        this.canvasContainer.className = "vnccs-ps-canvas-wrap";

        // SAM camera banner (top of viewport, toggle on click)
        this._samCamBanner = document.createElement('div');
        this._samCamBanner.className = 'vnccs-ps-sam-cam-banner';
        this._samCamBanner.innerHTML =
            '<span class="vnccs-sam-dot"></span>' +
            '<span class="vnccs-sam-label">SAM Camera Applied</span>' +
            '<small style="opacity:0.65;font-weight:400">· click to toggle</small>';
        this._samCamBanner.addEventListener('click', () => this._toggleSAMCameraDisplay());
        this.canvasContainer.appendChild(this._samCamBanner);

        this.canvas = document.createElement("canvas");
        this.canvasContainer.appendChild(this.canvas);
        this._createHandPopover();
        centerPanel.appendChild(this.canvasContainer);

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

        const resetBtn = document.createElement("button");
        resetBtn.className = "vnccs-ps-btn";
        resetBtn.innerHTML = '<span class="vnccs-ps-btn-icon">↺</span> Reset';
        resetBtn.addEventListener("click", () => this.resetCurrentPose());

        const snapBtn = document.createElement("button");
        snapBtn.className = "vnccs-ps-btn primary";
        snapBtn.innerHTML = '<span class="vnccs-ps-btn-icon">👁</span> Preview';
        snapBtn.title = "Snap viewport camera to output camera";
        snapBtn.addEventListener("click", () => {
            this.applyCameraToViewer(true);
        });

        const copyBtn = document.createElement("button");
        copyBtn.className = "vnccs-ps-btn";
        copyBtn.innerHTML = '<span class="vnccs-ps-btn-icon">📋</span> Copy';
        copyBtn.addEventListener("click", () => this.copyPose());

        const pasteBtn = document.createElement("button");
        pasteBtn.className = "vnccs-ps-btn";
        pasteBtn.innerHTML = '<span class="vnccs-ps-btn-icon">📋</span> Paste';
        pasteBtn.addEventListener("click", () => this.pastePose());

        actions.appendChild(undoBtn);
        actions.appendChild(redoBtn);
        actions.appendChild(resetBtn);
        actions.appendChild(snapBtn);
        actions.appendChild(copyBtn);
        actions.appendChild(pasteBtn);

        // Footer
        const footer = document.createElement("div");
        footer.className = "vnccs-ps-footer";

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
            if (this.viewer && this.viewer.hasReferenceImage()) {
                this.viewer.removeReferenceImage();
                this.exportParams.background_url = null;
                this.syncToNode(false);
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

        footer.appendChild(exportBtn);
        footer.appendChild(importBtn);
        footer.appendChild(refBtn);
        footer.appendChild(settingsBtn);

        centerPanel.appendChild(actions);
        centerPanel.appendChild(footer);

        // Hidden file inputs
        const fileInput = document.createElement("input");
        fileInput.type = "file"; fileInput.accept = ".json,.fbx,.png,.jpg,.jpeg,.webp,image/*"; fileInput.style.display = "none";
        fileInput.addEventListener("change", (e) => this.handleFileImport(e));
        this.fileImportInput = fileInput;
        this.container.appendChild(fileInput);

        const refInput = document.createElement("input");
        refInput.type = "file"; refInput.accept = "image/*"; refInput.style.display = "none";
        refInput.addEventListener("change", (e) => this.handleRefImport(e));
        this.fileRefInput = refInput;
        this.container.appendChild(refInput);
    }

    _createRightSidebar() {
        const rightSidebar = this.rightSidebar;

        // Pose Library Button
        const libBtnWrap = document.createElement("div");
        libBtnWrap.style.paddingBottom = "5px";
        const libBtn = document.createElement("button");
        libBtn.className = "vnccs-ps-btn primary";
        libBtn.style.width = "100%";
        libBtn.style.padding = "10px";
        libBtn.innerHTML = '<span class="vnccs-ps-btn-icon">📚</span> Pose Library Gallery';
        libBtn.onclick = () => this.showLibraryModal();
        libBtnWrap.appendChild(libBtn);
        rightSidebar.appendChild(libBtnWrap);

        // Lighting Section
        const lightSection = this.createSection("Lighting", true);
        this.lightListContainer = document.createElement("div");
        this.lightListContainer.className = "vnccs-ps-light-list";

        const overrideBtn = document.createElement("button");
        overrideBtn.className = "vnccs-ps-btn full";
        overrideBtn.style.marginBottom = "12px";
        overrideBtn.style.height = "36px";
        overrideBtn.style.fontSize = "11px";
        overrideBtn.style.textTransform = "uppercase";
        overrideBtn.style.fontWeight = "bold";

        this.updateOverrideBtn = () => {
            const active = this.exportParams.keepOriginalLighting;
            overrideBtn.innerHTML = active ?
                '<span style="margin-right:8px;">🧼</span> KEEPING ORIGINAL LIGHTING' :
                '<span style="margin-right:8px;">💡</span> KEEP ORIGINAL LIGHTING';

            if (active) {
                overrideBtn.style.background = "#2ea043";
                overrideBtn.style.color = "#fff";
            } else {
                overrideBtn.style.background = "var(--ps-panel)";
                overrideBtn.style.color = "var(--ps-text-muted)";
            }
        };

        overrideBtn.onclick = () => {
            this.exportParams.keepOriginalLighting = !this.exportParams.keepOriginalLighting;
            this.updateOverrideBtn();
            this.applyLighting();
            this.refreshLightUI();
            this.syncToNode(false);
        };
        this.updateOverrideBtn();
        lightSection.content.appendChild(overrideBtn);

        const lightToolbar = document.createElement("div");
        lightToolbar.className = "vnccs-ps-light-header";
        lightToolbar.style.padding = "0 0 8px 0";

        const lightLabel = document.createElement("span");
        lightLabel.className = "vnccs-ps-label";
        lightLabel.innerText = "Scene Lights";

        const resetLightBtn = document.createElement("button");
        resetLightBtn.className = "vnccs-ps-reset-btn";
        resetLightBtn.innerHTML = "↺";
        resetLightBtn.onclick = () => {
            this.lightParams = [
                { type: 'ambient', color: '#404040', intensity: 0.5 },
                { type: 'directional', color: '#ffffff', intensity: 1.0, x: 1, y: 2, z: 3 }
            ];
            this.refreshLightUI();
            this.applyLighting();
        };

        lightToolbar.appendChild(lightLabel);
        lightToolbar.appendChild(resetLightBtn);
        lightSection.content.appendChild(lightToolbar);
        lightSection.content.appendChild(this.lightListContainer);
        rightSidebar.appendChild(lightSection.el);

        // Prompt Section
        const promptSection = this.createSection("Prompt", true);
        const promptArea = document.createElement("textarea");
        promptArea.className = "vnccs-ps-textarea";
        promptArea.placeholder = "Describe your scene/character details...";
        promptArea.value = this.getPosePrompt(this.activeTab);

        const autoExpand = () => {
            promptArea.style.height = 'auto';
            promptArea.style.height = (promptArea.scrollHeight) + 'px';
        };

        promptArea.addEventListener('input', () => {
            this.setPosePrompt(this.activeTab, promptArea.value);
            autoExpand();
            this.syncToNode(false);
        });

        setTimeout(autoExpand, 0);
        this.userPromptArea = promptArea;
        promptSection.content.appendChild(promptArea);
        rightSidebar.appendChild(promptSection.el);

    }

    _setupFinalUI() {
        // Loading Overlay
        this.loadingOverlay = document.createElement("div");
        this.loadingOverlay.className = "vnccs-ps-loading-overlay";
        this.loadingOverlay.innerHTML = `
            <div class="vnccs-ps-loading-spinner"></div>
            <div class="vnccs-ps-loading-text">Loading Model...</div>
        `;
        this.container.appendChild(this.loadingOverlay);

        this.refreshLightUI();

        // Initialize viewer
        this.viewer = new PoseViewerCore(this.canvas, {
            skinMode: 'naked',
            enableTextureSkinning: true,
            enableMultiPass: true,
            showSkeletonHelper: true,
            showCaptureFrame: true,
            syncMode: 'end',
            onHandHover: ({ side }) => {
                this._hoveredHandSide = side;
                if (!side && !this._activeHandSide) {
                    this.hideHandControlPopover();
                }
            },
            onHandActivate: ({ side }) => {
                this.showHandControlPopover(side);
            },
            onPoseChange: (pose) => {
                // Return params request logic mapped into direct assignment beforehand 
                this.viewer.setCameraParams({
                    ...this.currentCameraParams()
                });
                this.syncToNode();
            }
        });

        this.viewer.init();
        if (this.lightParams) {
            this.viewer.updateLights(this.lightParams);
        }

        this.startResizeObserver();
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

    persistActivePoseCameraParams() {
        if (!this.poses || this.activeTab == null) return;

        const currentPose = this.poses[this.activeTab] || {};
        currentPose.cameraParams = this.currentCameraParams();
        this.poses[this.activeTab] = currentPose;
    }

    currentCameraParams() {
        return {
            offset_x: this.exportParams.cam_offset_x,
            offset_y: this.exportParams.cam_offset_y,
            zoom: this.exportParams.cam_zoom,
            yaw_deg: this.exportParams.cam_yaw_deg || 0,
            pitch_deg: this.exportParams.cam_pitch_deg || 0
        };
    }

    ensurePosePrompts() {
        if (!Array.isArray(this.posePrompts)) this.posePrompts = [];
        while (this.posePrompts.length < this.poses.length) {
            const pose = this.poses[this.posePrompts.length] || {};
            this.posePrompts.push(String(pose.prompt ?? pose._library?.prompt ?? this.exportParams.user_prompt ?? ""));
        }
        while (this.posePrompts.length > this.poses.length) this.posePrompts.pop();
    }

    getPosePrompt(index = this.activeTab) {
        this.ensurePosePrompts();
        return String(this.posePrompts[index] ?? this.poses[index]?.prompt ?? "");
    }

    setPosePrompt(index, value) {
        this.ensurePosePrompts();
        const prompt = String(value ?? "");
        this.posePrompts[index] = prompt;
        if (this.poses[index]) this.poses[index].prompt = prompt;
        if (index === this.activeTab) this.exportParams.user_prompt = prompt;
    }

    syncPromptFieldToActiveTab() {
        const prompt = this.getPosePrompt(this.activeTab);
        this.exportParams.user_prompt = prompt;
        if (this.userPromptArea) {
            this.userPromptArea.value = prompt;
            this.userPromptArea.style.height = 'auto';
            this.userPromptArea.style.height = `${this.userPromptArea.scrollHeight}px`;
        }
    }

    setInterfaceMode(mode, { sync = true } = {}) {
        const normalized = mode === "manager" || mode === "managerDetail" ? mode : "studio";
        this.interfaceMode = normalized;
        this.exportParams.interface_mode = normalized === "studio" ? "studio" : "manager";
        this.applyInterfaceMode();
        if (normalized === "manager") {
            this.refreshPoseManagerControls();
            this.renderPoseManager();
            requestAnimationFrame(() => this.layoutPoseManager());
        } else {
            requestAnimationFrame(() => this.resize());
        }
        if (sync) this.syncToNode(false, { skipCapture: normalized === "manager" });
    }

    applyInterfaceMode() {
        if (!this.container) return;
        this.container.classList.toggle("vnccs-ps-mode-manager", this.interfaceMode === "manager");
        this.container.classList.toggle("vnccs-ps-mode-manager-detail", this.interfaceMode === "managerDetail");
        if (this.interfaceMode === "managerDetail") {
            this.renderPoseManagerDetailStrip();
        }
        if (this.interfaceMode !== "manager") {
            requestAnimationFrame(() => this.resize());
        }
    }

    openPoseFromManager(index) {
        if (index < 0 || index >= this.poses.length) return;
        if (index !== this.activeTab) {
            this.switchTab(index);
        }
        this.setInterfaceMode("managerDetail");
    }

    renderPoseManager() {
        if (!this.managerGrid) return;
        this.refreshPoseManagerControls();
        this.ensurePosePrompts();
        this.managerGrid.innerHTML = "";

        if (!this.poses.length) {
            const empty = document.createElement("div");
            empty.className = "vnccs-ps-manager-empty";
            empty.textContent = "No poses";
            this.managerGrid.appendChild(empty);
            return;
        }

        for (let i = 0; i < this.poses.length; i++) {
            const card = document.createElement("div");
            card.className = "vnccs-ps-pose-card" + (i === this.activeTab ? " active" : "");
            card.tabIndex = 0;
            card.role = "button";
            card.title = `Open Pose ${i + 1}`;

            const preview = document.createElement("div");
            preview.className = "vnccs-ps-pose-preview";
            const capture = this.poseCaptures?.[i];
            if (capture) {
                const img = document.createElement("img");
                img.src = capture;
                img.alt = `Pose ${i + 1}`;
                preview.appendChild(img);
            } else {
                const placeholder = document.createElement("div");
                placeholder.className = "vnccs-ps-pose-preview-empty";
                preview.appendChild(placeholder);
            }

            const bottom = document.createElement("div");
            bottom.className = "vnccs-ps-pose-card-bottom";

            const name = document.createElement("div");
            name.className = "vnccs-ps-pose-card-name";
            name.textContent = `Pose ${i + 1}`;

            const del = document.createElement("button");
            del.className = "vnccs-ps-btn danger vnccs-ps-pose-card-delete";
            del.type = "button";
            del.textContent = "X";
            del.title = `Delete Pose ${i + 1}`;
            del.disabled = this.poses.length <= 1;
            del.addEventListener("click", (event) => {
                event.stopPropagation();
                this.deleteTab(i);
                this.setInterfaceMode("manager");
            });

            bottom.appendChild(name);
            bottom.appendChild(del);
            card.appendChild(preview);
            card.appendChild(bottom);
            card.addEventListener("click", () => this.openPoseFromManager(i));
            card.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    this.openPoseFromManager(i);
                }
            });
            this.managerGrid.appendChild(card);
        }

        this.layoutPoseManager();
    }

    layoutPoseManager() {
        if (!this.managerStage || !this.managerGrid) return;
        const count = Math.max(1, this.poses?.length || 1);
        const stageStyle = getComputedStyle(this.managerStage);
        const padX = (parseFloat(stageStyle.paddingLeft) || 0) + (parseFloat(stageStyle.paddingRight) || 0);
        const padY = (parseFloat(stageStyle.paddingTop) || 0) + (parseFloat(stageStyle.paddingBottom) || 0);
        const width = Math.max(1, this.managerStage.clientWidth - padX - 2);
        const height = Math.max(1, this.managerStage.clientHeight - padY - 18);
        const gap = 14;
        const preferredRows = count <= 6 ? 1 : (count <= 12 ? 2 : Math.ceil(count / 6));
        const minCardW = count <= 6 ? 130 : 80;
        const minCardH = 130;
        const previewAspect = Math.max(0.35, Math.min(4, (Number(this.exportParams.view_height) || 1024) / (Number(this.exportParams.view_width) || 1024)));
        let best = null;

        for (let rows = 1; rows <= count; rows++) {
            const cols = Math.ceil(count / rows);
            const cardW = (width - gap * (cols - 1)) / cols;
            const rowH = (height - gap * (rows - 1)) / rows;
            if (cardW <= 0) continue;
            if (rowH <= 0) continue;

            const footerH = Math.max(44, Math.min(60, cardW * 0.18));
            const previewH = Math.max(40, Math.min(cardW * previewAspect, rowH - footerH));
            const cardH = previewH + footerH;
            if ((cardW < minCardW || cardH < minCardH) && count > 1) continue;

            const emptySlots = rows * cols - count;
            const rowPenalty = Math.abs(rows - preferredRows) * 100000;
            const aspect = previewH / Math.max(1, cardW);
            const aspectPenalty = Math.abs(aspect - Math.min(previewAspect, 1.8)) * 80;
            const unusedRowH = Math.max(0, rowH - cardH);
            const sizeScore = Math.min(cardW, previewH / Math.min(previewAspect, 1.8)) * 100;
            const fillBonus = previewAspect > 1.6 ? -unusedRowH * 0.2 : -unusedRowH * 0.02;
            const score = sizeScore - rowPenalty - emptySlots * 80 - aspectPenalty;

            if (!best || score > best.score) {
                best = { cols, rows, cardW, cardH, footerH, score: score + fillBonus };
            }
        }

        if (!best) {
            const rows = Math.min(count, Math.max(1, preferredRows));
            const cols = Math.ceil(count / rows);
            const cardW = Math.max(28, (width - gap * (cols - 1)) / cols);
            const rowH = Math.max(40, (height - gap * (rows - 1)) / rows);
            const footerH = Math.max(44, Math.min(60, cardW * 0.18));
            const cardH = Math.max(40, Math.min(rowH, cardW * previewAspect + footerH));
            best = { cols, rows, cardW, cardH, footerH, score: 0 };
        }

        const cardWidth = Math.max(28, Math.floor(best.cardW));
        const cardHeight = Math.max(40, Math.floor(best.cardH));
        const footerHeight = Math.max(44, Math.floor(best.footerH));
        this.managerStage.style.setProperty("--pm-card-w", `${cardWidth}px`);
        this.managerStage.style.setProperty("--pm-card-h", `${cardHeight}px`);
        this.managerStage.style.setProperty("--pm-card-footer-h", `${footerHeight}px`);
        this.managerGrid.style.setProperty("--pm-cols", String(best.cols));
    }

    renderPoseManagerDetailStrip() {
        if (!this.managerDetailStrip) return;
        if (this.interfaceMode !== "managerDetail") return;
        this.ensurePosePrompts();
        this.managerDetailStrip.innerHTML = "";

        for (let i = 0; i < this.poses.length; i++) {
            const card = document.createElement("div");
            card.className = "vnccs-ps-detail-card" + (i === this.activeTab ? " active" : "");
            card.tabIndex = 0;
            card.role = "button";
            card.title = `Open Pose ${i + 1}`;

            const preview = document.createElement("div");
            preview.className = "vnccs-ps-detail-card-preview";
            const capture = this.poseCaptures?.[i];
            if (capture) {
                const img = document.createElement("img");
                img.src = capture;
                img.alt = `Pose ${i + 1}`;
                preview.appendChild(img);
            } else {
                const placeholder = document.createElement("div");
                placeholder.className = "vnccs-ps-pose-preview-empty";
                preview.appendChild(placeholder);
            }

            const bottom = document.createElement("div");
            bottom.className = "vnccs-ps-detail-card-bottom";

            const name = document.createElement("div");
            name.className = "vnccs-ps-detail-card-name";
            name.textContent = `Pose ${i + 1}`;

            const del = document.createElement("button");
            del.className = "vnccs-ps-btn danger vnccs-ps-detail-card-delete";
            del.type = "button";
            del.textContent = "X";
            del.title = `Delete Pose ${i + 1}`;
            del.disabled = this.poses.length <= 1;
            del.addEventListener("click", (event) => {
                event.stopPropagation();
                this.deleteTab(i);
                this.setInterfaceMode("managerDetail");
            });

            const open = () => {
                if (i !== this.activeTab) this.switchTab(i);
                this.setInterfaceMode("managerDetail");
            };

            bottom.appendChild(name);
            bottom.appendChild(del);
            card.appendChild(preview);
            card.appendChild(bottom);
            card.addEventListener("click", open);
            card.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    open();
                }
            });
            this.managerDetailStrip.appendChild(card);
        }

        requestAnimationFrame(() => {
            const active = this.managerDetailStrip?.querySelector(".vnccs-ps-detail-card.active");
            active?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
        });
    }

    applyCameraToViewer(snap = true) {
        if (!this.viewer) return;
        const args = [
            this.exportParams.view_width,
            this.exportParams.view_height,
            this.exportParams.cam_zoom || 1.0,
            this.exportParams.cam_offset_x || 0,
            this.exportParams.cam_offset_y || 0,
            this.exportParams.cam_yaw_deg || 0,
            this.exportParams.cam_pitch_deg || 0
        ];
        if (snap && this.viewer.snapToCaptureCamera) this.viewer.snapToCaptureCamera(...args);
        else if (this.viewer.updateCaptureCamera) this.viewer.updateCaptureCamera(...args);
    }

    syncCameraWidgets() {
        for (const key of ['cam_zoom', 'cam_offset_x', 'cam_offset_y', 'cam_yaw_deg', 'cam_pitch_deg']) {
            const widget = this.exportWidgets[key];
            if (widget) {
                widget.value = this.exportParams[key];
                if (widget._vnccsValueSpan) {
                    widget._vnccsValueSpan.innerText = Number(this.exportParams[key] || 0).toFixed(2);
                }
            }
        }
        if (this.radarRedraw) this.radarRedraw();
    }

    clearSAMCameraMode() {
        this.viewer?.clearSAMProjectionCameraFrame?.();
        this.viewer?.clearSAMMeshOverlay?.();
        this._lastSAM3DMeshData = null;
        this._lastSAM3DPoseData = null;
        this._samCameraModeActive = false;
        this._samCamBannerVisible = false;
        this._samCamDisplayActive = true;
        this._samCamPreParams = null;
        this._samCamStoredParams = null;
        this._samCamStoredProjectionFrame = null;
        this._updateSAMCameraBanner();
    }

    _updateSAMCameraBanner() {
        if (!this._samCamBanner) return;
        const show = this.exportParams.samApplyCamera && this._samCamBannerVisible;
        if (!show) {
            this._samCamBanner.classList.remove('vnccs-sam-visible', 'vnccs-sam-paused');
            return;
        }
        this._samCamBanner.classList.add('vnccs-sam-visible');
        const label = this._samCamBanner.querySelector('.vnccs-sam-label');
        if (this._samCamDisplayActive) {
            this._samCamBanner.classList.remove('vnccs-sam-paused');
            if (label) label.textContent = 'SAM Camera Applied';
        } else {
            this._samCamBanner.classList.add('vnccs-sam-paused');
            if (label) label.textContent = 'SAM Camera (paused)';
        }
    }

    _toggleSAMCameraDisplay() {
        if (!this._samCamBannerVisible) return;
        this._samCamDisplayActive = !this._samCamDisplayActive;
        if (this._samCamDisplayActive) {
            this.viewer?.setSAMProjectionCameraFrame?.(this._samCamStoredProjectionFrame || null);
            this._samCameraModeActive = !!this._samCamStoredProjectionFrame;
            if (this._samCamStoredParams) {
                Object.assign(this.exportParams, this._samCamStoredParams);
                this.syncCameraWidgets();
                this.applyCameraToViewer(true);
                this.viewer?.setCameraParams(this.currentCameraParams());
            }
        } else {
            this.viewer?.setSAMProjectionCameraFrame?.(null);
            this._samCameraModeActive = false;
            if (this._samCamPreParams) {
                Object.assign(this.exportParams, this._samCamPreParams);
                this.syncCameraWidgets();
                this.applyCameraToViewer(true);
                this.viewer?.setCameraParams(this.currentCameraParams());
            }
        }
        this._updateSAMCameraBanner();
    }

    resetCameraParams({ keepAngles = false } = {}) {
        this.exportParams.cam_zoom = 1.0;
        this.exportParams.cam_offset_x = 0;
        this.exportParams.cam_offset_y = 0;
        if (!keepAngles) {
            this.exportParams.cam_yaw_deg = 0;
            this.exportParams.cam_pitch_deg = 0;
        }
        this.syncCameraWidgets();
    }

    updateCaptureCameraPreview() {
        this.applyCameraToViewer(false);
    }

    applyAgeCameraFit() {
        if (!this.viewer?.computeModelFitZoom) return false;
        if (!this.viewer?.isInitialized?.()) return false;

        const originalTab = this.activeTab;
        let changed = false;

        for (let i = 0; i < this.poses.length; i++) {
            const pose = this.poses[i] || {};
            const camera = pose.cameraParams || {};

            this.viewer.setPose(pose, true);
            const zoom = this.viewer.computeModelFitZoom(
                this.exportParams.view_width || 1024,
                this.exportParams.view_height || 1024,
                camera.offset_x ?? this.exportParams.cam_offset_x ?? 0,
                camera.offset_y ?? this.exportParams.cam_offset_y ?? 0,
                camera.yaw_deg ?? this.exportParams.cam_yaw_deg ?? 0,
                camera.pitch_deg ?? this.exportParams.cam_pitch_deg ?? 0,
                0.08
            );
            if (!Number.isFinite(zoom)) continue;

            this.poses[i] = {
                ...pose,
                cameraParams: {
                    offset_x: camera.offset_x ?? this.exportParams.cam_offset_x ?? 0,
                    offset_y: camera.offset_y ?? this.exportParams.cam_offset_y ?? 0,
                    yaw_deg: camera.yaw_deg ?? this.exportParams.cam_yaw_deg ?? 0,
                    pitch_deg: camera.pitch_deg ?? this.exportParams.cam_pitch_deg ?? 0,
                    zoom: Math.max(0.1, Math.min(7.0, zoom))
                }
            };
            changed = true;
        }

        this.activeTab = originalTab;
        this.viewer.setPose(this.poses[this.activeTab] || {}, true);
        const activeCamera = this.poses[this.activeTab]?.cameraParams;
        if (activeCamera) {
            this.exportParams.cam_zoom = activeCamera.zoom ?? this.exportParams.cam_zoom;
            this.exportParams.cam_offset_x = activeCamera.offset_x ?? this.exportParams.cam_offset_x;
            this.exportParams.cam_offset_y = activeCamera.offset_y ?? this.exportParams.cam_offset_y;
            this.exportParams.cam_yaw_deg = activeCamera.yaw_deg ?? this.exportParams.cam_yaw_deg;
            this.exportParams.cam_pitch_deg = activeCamera.pitch_deg ?? this.exportParams.cam_pitch_deg;
        }
        this.syncCameraWidgets();
        this.refreshPoseManagerControls();
        this.applyCameraToViewer(true);
        this.updateRotationSliders();
        return changed;
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
        slider._vnccsValueSpan = valueSpan;

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
                const isCamParam = ['cam_zoom', 'cam_offset_x', 'cam_offset_y', 'cam_yaw_deg', 'cam_pitch_deg'].includes(key);
                if (isCamParam) {
                    this.persistActivePoseCameraParams();
                }
                if (isCamParam && this.viewer) {
                    this.applyCameraToViewer(true);
                }
            } else {
                if (key === 'head_size') {
                    if (this.viewer) this.viewer.updateHeadScale(val);
                    this.meshParams[key] = val;
                    this.syncToNode(false);
                } else if (key === 'arm_size') {
                    if (this.viewer) this.viewer.updateArmScale(val);
                    this.meshParams[key] = val;
                    this.syncToNode(false);
                } else if (key === 'hand_size') {
                    if (this.viewer) this.viewer.updateHandScale(val);
                    this.meshParams[key] = val;
                    this.syncToNode(false);
                } else if (key.endsWith('_length')) {
                    const group = key.replace('_length', '');
                    if (this.viewer) this.viewer.updateBoneLengthScale(group, val);
                    this.meshParams[key] = val;
                    this.syncToNode(false);
                } else {
                    // Directly update meshParams and trigger mesh rebuild
                    this.meshParams[key] = val;
                    this.onMeshParamsChanged(key);
                }
            }
        });

        slider.addEventListener("change", () => {
            if (isExport) {
                const needsFull = ['view_width', 'view_height', 'cam_zoom', 'bg_color', 'cam_offset_x', 'cam_offset_y', 'cam_yaw_deg', 'cam_pitch_deg'].includes(key);
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
            if (isDimension) {
                this._lastResizeW = 0;
                this._lastResizeH = 0;
                this.resize();
                this.updateCaptureCameraPreview();
            }
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
        wrap.style.padding = "4px";

        // Canvas
        const canvas = document.createElement("canvas");
        const size = 140;
        canvas.width = size;
        canvas.height = size;
        canvas.style.width = "140px";
        canvas.style.height = "140px";
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
            this.applyCameraToViewer(true);
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
            this.clearSAMCameraMode();
            this.exportParams.cam_offset_x = 0;
            this.exportParams.cam_offset_y = 0;
            this.persistActivePoseCameraParams();
            this.syncCameraWidgets();
            this.applyCameraToViewer(true);
            this.syncToNode(false);
        };

        // Sync Tabs Button
        const syncTabsBtn = document.createElement("button");
        syncTabsBtn.className = "vnccs-ps-btn vnccs-ps-btn--sync-tabs";
        syncTabsBtn.style.marginTop = "6px";
        syncTabsBtn.style.width = "100%";
        syncTabsBtn.innerHTML = '<span class="vnccs-ps-btn-icon">⇄</span> Sync Zoom to All Tabs';
        syncTabsBtn.style.display = "none"; // Hidden by default
        syncTabsBtn.onclick = () => {
            const currentZoom = this.exportParams.cam_zoom;
            // Save current pose first
            if (this.viewer && this.viewer.isInitialized()) {
                const currentPose = this.viewer.getPose();
                currentPose.cameraParams = this.currentCameraParams();
                this.poses[this.activeTab] = currentPose;
            }
            // Apply zoom to all tabs
            for (let i = 0; i < this.poses.length; i++) {
                if (!this.poses[i].cameraParams) {
                    this.poses[i].cameraParams = { offset_x: 0, offset_y: 0 };
                }
                this.poses[i].cameraParams.zoom = currentZoom;
            }
            // Re-render all tabs
            this.syncToNode(true);
        };
        this.syncTabsBtn = syncTabsBtn;

        wrap.appendChild(canvas);
        wrap.appendChild(recenterBtn);
        wrap.appendChild(syncTabsBtn);
        section.content.appendChild(wrap);

        // Initial Draw
        requestAnimationFrame(() => draw());
    }

    createLightRadar(light) {
        const size = 100;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        canvas.className = "vnccs-ps-light-radar-canvas";
        const ctx = canvas.getContext("2d");

        let isDragging = false;
        const range = (light.type === 'point') ? 10.0 : 100;

        const draw = () => {
            ctx.fillStyle = "#111";
            ctx.fillRect(0, 0, size, size);

            const cx = size / 2;
            const cy = size / 2;

            // Grid
            ctx.beginPath();
            ctx.strokeStyle = "#222";
            ctx.lineWidth = 1;
            ctx.moveTo(cx, 0); ctx.lineTo(cx, size);
            ctx.moveTo(0, cy); ctx.lineTo(size, cy);
            ctx.stroke();

            // Circles
            ctx.beginPath();
            ctx.strokeStyle = "#1a1a1a";
            ctx.arc(cx, cy, size / 4, 0, Math.PI * 2);
            ctx.arc(cx, cy, size / 2 - 2, 0, Math.PI * 2);
            ctx.stroke();

            // Dot (X and Z)
            const dotX = cx + (light.x / range) * (size / 2);
            const dotY = cy + (light.z / range) * (size / 2);
            const hex = this.parseColorToHex(light.color);

            // Shadow/Glow
            const grad = ctx.createRadialGradient(dotX, dotY, 2, dotX, dotY, 12);
            grad.addColorStop(0, hex + "66");
            grad.addColorStop(1, "transparent");
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(dotX, dotY, 12, 0, Math.PI * 2);
            ctx.fill();

            // Core
            ctx.beginPath();
            ctx.fillStyle = hex;
            ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 1;
            ctx.stroke();

            // Labels
            ctx.fillStyle = "#444";
            ctx.font = "8px monospace";
            ctx.textAlign = "center";
            ctx.fillText("BACK", cx, 10);
            ctx.fillText("FRONT", cx, size - 4);
        };

        const updateFromMouse = (e) => {
            const rect = canvas.getBoundingClientRect();
            // Scaling support (accounts for CSS zoom)
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;
            const mouseX = (e.clientX - rect.left) * scaleX;
            const mouseY = (e.clientY - rect.top) * scaleY;
            const cx = size / 2;
            const cy = size / 2;

            let dx = (mouseX - cx);
            let dy = (mouseY - cy);

            const maxDrag = (size / 2) - 2;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > maxDrag) {
                dx *= maxDrag / dist;
                dy *= maxDrag / dist;
            }

            light.x = (dx / (size / 2)) * range;
            light.z = (dy / (size / 2)) * range;

            draw();
            this.applyLighting();
        };

        canvas.addEventListener("pointerdown", (e) => {
            canvas.setPointerCapture(e.pointerId);
            isDragging = true;
            updateFromMouse(e);
        });

        canvas.addEventListener("pointermove", (e) => {
            if (isDragging) updateFromMouse(e);
        });

        canvas.addEventListener("pointerup", (e) => {
            if (isDragging) {
                if (canvas.hasPointerCapture(e.pointerId)) {
                    canvas.releasePointerCapture(e.pointerId);
                }
                isDragging = false;
                this.syncToNode(false);
            }
        });

        draw();
        return canvas;
    }


    parseColorToHex(c) {
        if (!c) return "#ffffff";
        if (typeof c === 'string') return c.startsWith('#') ? c : "#ffffff";
        if (Array.isArray(c)) {
            const r = Math.round(c[0]).toString(16).padStart(2, '0');
            const g = Math.round(c[1]).toString(16).padStart(2, '0');
            const b = Math.round(c[2]).toString(16).padStart(2, '0');
            return `#${r}${g}${b}`;
        }
        return "#ffffff";
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

    resetHandSliders() {
        if (!this._handSliderValues) return;

        const defaults = this._handSliderDefaults || { spread: 0, grasp: 0, thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 };
        for (const [key, value] of Object.entries(defaults)) {
            this._handSliderValues[key] = value;
            if (this._handSliderRefs[key]) this._handSliderRefs[key].value = String(value);
            if (this._handSliderValRefs[key]) this._handSliderValRefs[key].textContent = value.toFixed(2);
        }
    }

    _getPresetDataForSide(preset, side) {
        return side === "r" ? preset?.preset_r : preset?.preset_l;
    }

    _lerpHandPresetData(poseA, poseB, t, side) {
        const dataA = this._getPresetDataForSide(poseA, side);
        const dataB = this._getPresetDataForSide(poseB, side);
        const result = {};
        if (!dataA || !dataB) return result;

        for (const key of Object.keys(dataA)) {
            const a = dataA[key];
            const b = dataB[key];
            if (!a || !b) continue;
            const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
            const bFlip = dot < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b;
            const r = [
                a[0] * (1 - t) + bFlip[0] * t,
                a[1] * (1 - t) + bFlip[1] * t,
                a[2] * (1 - t) + bFlip[2] * t,
                a[3] * (1 - t) + bFlip[3] * t,
            ];
            const len = Math.hypot(r[0], r[1], r[2], r[3]) || 1;
            result[key] = [r[0] / len, r[1] / len, r[2] / len, r[3] / len];
        }

        return result;
    }

    _sampleCurrentHandPose(side) {
        if (!this.viewer?.bones || !this.viewer?.THREE) return null;
        const result = {};
        for (const prefix of ["thumb", "index", "middle", "ring", "pinky"]) {
            for (const segment of ["01", "02", "03"]) {
                const bone = this.viewer.bones[`${prefix}_${segment}_${side}`];
                if (!bone) continue;
                result[`${prefix}_${segment}`] = [bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w];
            }
        }
        return result;
    }

    _quatAngularDistance(a, b) {
        const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
        const clamped = Math.max(-1, Math.min(1, dot));
        return 2 * Math.acos(clamped);
    }

    _estimateHandInterpolationValue(currentData, startData, endData, keys) {
        let bestT = 0;
        let bestScore = Number.POSITIVE_INFINITY;

        for (let step = 0; step <= 100; step++) {
            const t = step / 100;
            const sampled = this._lerpHandPresetData({ preset_l: startData, preset_r: startData }, { preset_l: endData, preset_r: endData }, t, "l");
            let score = 0;
            for (const key of keys) {
                const current = currentData[key];
                const target = sampled[key];
                if (!current || !target) continue;
                score += this._quatAngularDistance(current, target);
            }
            if (score < bestScore) {
                bestScore = score;
                bestT = t;
            }
        }

        return bestT;
    }

    calibrateHandSliderDefaults(side) {
        if (!this.viewer || !this._defaultHandPresets || !side) return;
        const { OPEN, CHOP, FIST } = this._defaultHandPresets;
        if (!OPEN || !CHOP || !FIST) return;

        const currentData = this._sampleCurrentHandPose(side);
        if (!currentData) return;

        const allKeys = Object.keys(currentData);
        const spread = this._estimateHandInterpolationValue(
            currentData,
            this._getPresetDataForSide(CHOP, side),
            this._getPresetDataForSide(OPEN, side),
            allKeys,
        );

        const spreadBaseData = this._lerpHandPresetData(CHOP, OPEN, spread, side);
        const fistData = this._getPresetDataForSide(FIST, side);
        const perFinger = {};
        for (const prefix of ["thumb", "index", "middle", "ring", "pinky"]) {
            const keys = ["01", "02", "03"].map((segment) => `${prefix}_${segment}`);
            perFinger[prefix] = this._estimateHandInterpolationValue(currentData, spreadBaseData, fistData, keys);
        }

        const grasp = (perFinger.thumb + perFinger.index + perFinger.middle + perFinger.ring + perFinger.pinky) / 5;
        this._handSliderDefaults = {
            spread,
            grasp,
            thumb: perFinger.thumb,
            index: perFinger.index,
            middle: perFinger.middle,
            ring: perFinger.ring,
            pinky: perFinger.pinky,
        };

        this.resetHandSliders();
    }

    _createHandPopover() {
        const panel = document.createElement("div");
        panel.className = "vnccs-ps-hand-popover";

        const header = document.createElement("div");
        header.className = "vnccs-ps-hand-popover-header";

        const title = document.createElement("div");
        title.className = "vnccs-ps-hand-popover-title";
        title.textContent = "Hand Control";

        const closeBtn = document.createElement("button");
        closeBtn.className = "vnccs-ps-hand-popover-close";
        closeBtn.type = "button";
        closeBtn.textContent = "✕";
        closeBtn.addEventListener("click", () => this.hideHandControlPopover());

        header.append(title, closeBtn);
        panel.appendChild(header);

        const mkSliderRow = (label, onInput) => {
            const row = document.createElement("div");
            row.style.cssText = "display:grid;grid-template-columns:44px 1fr 34px;gap:6px;align-items:center;margin-bottom:6px;";

            const lbl = document.createElement("span");
            lbl.style.cssText = "font-size:10px;color:var(--ps-text-muted);";
            lbl.textContent = label;

            const slider = document.createElement("input");
            slider.type = "range";
            slider.min = "0";
            slider.max = "1";
            slider.step = "0.01";
            slider.value = "0";
            slider.className = "vnccs-ps-slider";

            const value = document.createElement("span");
            value.style.cssText = "font-size:10px;color:var(--ps-accent);text-align:right;font-family:var(--ps-font-mono);";
            value.textContent = "0.00";

            slider.addEventListener("input", () => {
                const numericValue = parseFloat(slider.value);
                value.textContent = numericValue.toFixed(2);
                onInput(numericValue);
            });

            row.append(lbl, slider, value);
            return { row, slider, value };
        };

        const mkTrackedHandSlider = (label, key, initialValue) => {
            const { row, slider, value } = mkSliderRow(label, (numericValue) => {
                if (key === "grasp") {
                    const oldGrasp = this._handSliderValues.grasp;
                    this._handSliderValues.grasp = numericValue;
                    const epsilon = 1e-9;
                    for (const prefix of ["thumb", "index", "middle", "ring", "pinky"]) {
                        const current = this._handSliderValues[prefix];
                        let nextValue;
                        if (numericValue >= oldGrasp) {
                            const denom = 1 - oldGrasp;
                            nextValue = denom < epsilon ? 1 : current + (numericValue - oldGrasp) * (1 - current) / denom;
                        } else {
                            nextValue = oldGrasp < epsilon ? 0 : current * (numericValue / oldGrasp);
                        }
                        nextValue = Math.max(0, Math.min(1, nextValue));
                        this._handSliderValues[prefix] = nextValue;
                        if (this._handSliderRefs[prefix]) this._handSliderRefs[prefix].value = String(nextValue);
                        if (this._handSliderValRefs[prefix]) this._handSliderValRefs[prefix].textContent = nextValue.toFixed(2);
                    }
                } else {
                    this._handSliderValues[key] = numericValue;
                }
                this.applyActiveHandSliders();
            });

            slider.value = String(initialValue);
            value.textContent = initialValue.toFixed(2);
            this._handSliderRefs[key] = slider;
            this._handSliderValRefs[key] = value;
            return row;
        };

        panel.appendChild(mkTrackedHandSlider("Spread", "spread", 0));
        panel.appendChild(mkTrackedHandSlider("Grasp", "grasp", 0));
        for (const [label, key] of [["Thumb", "thumb"], ["Index", "index"], ["Middle", "middle"], ["Ring", "ring"], ["Pinky", "pinky"]]) {
            panel.appendChild(mkTrackedHandSlider(label, key, 1));
        }

        const resetBtn = document.createElement("button");
        resetBtn.className = "vnccs-ps-btn";
        resetBtn.style.width = "100%";
        resetBtn.textContent = "Reset Hand Sliders";
        resetBtn.addEventListener("click", () => {
            this.resetHandSliders();
            this._handBiasValues = [1.0, 1.0, 1.0];
            this.applyActiveHandSliders();
        });
        panel.appendChild(resetBtn);

        this._handPopover = panel;
        this._handPopoverTitle = title;
        (this.centerPanel || this.canvasContainer).appendChild(panel);
        document.addEventListener("pointerdown", this._boundHandleDocumentPointerDown);
        document.addEventListener("pointerup", this._boundHandleDocumentPointerUp);
        document.addEventListener("pointercancel", this._boundHandleDocumentPointerCancel);
    }

    _handleDocumentPointerDown(event) {
        if (!this._handPopover || !this._handPopover.classList.contains("visible")) return;
        if (event.button !== 0) {
            this._pendingHandPopoverOutsideClick = null;
            return;
        }
        if (this._handPopover.contains(event.target)) {
            this._pendingHandPopoverOutsideClick = null;
            return;
        }

        this._pendingHandPopoverOutsideClick = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            clickedCanvas: this.canvas ? event.target === this.canvas : false,
            activeHandSide: this._activeHandSide,
        };
    }

    _handleDocumentPointerUp(event) {
        const pending = this._pendingHandPopoverOutsideClick;
        this._pendingHandPopoverOutsideClick = null;

        if (!pending || !this._handPopover || !this._handPopover.classList.contains("visible")) return;
        if (event.button !== 0 || event.pointerId !== pending.pointerId) return;
        if (this._handPopover.contains(event.target)) return;

        const movedX = event.clientX - pending.startX;
        const movedY = event.clientY - pending.startY;
        if ((movedX * movedX + movedY * movedY) > 9) return;

        if (pending.clickedCanvas && (this._hoveredHandSide || this._activeHandSide !== pending.activeHandSide)) {
            return;
        }

        this.hideHandControlPopover();
    }

    _handleDocumentPointerCancel() {
        this._pendingHandPopoverOutsideClick = null;
    }

    applyActiveHandSliders() {
        if (!this.viewer || !this._defaultHandPresets || !this._activeHandSide) return;
        const { OPEN, CHOP, FIST } = this._defaultHandPresets;
        if (!OPEN || !CHOP || !FIST) return;

        const side = this._activeHandSide;

        this.viewer.interpolateHandPose(CHOP, OPEN, this._handSliderValues.spread, side);
        for (const prefix of ["thumb", "index", "middle", "ring", "pinky"]) {
            const spreadBaseData = this._lerpHandPresetData(CHOP, OPEN, this._handSliderValues.spread, side);
            const fistData = side === "r" ? FIST.preset_r : FIST.preset_l;
            const startPose = { preset_l: spreadBaseData, preset_r: spreadBaseData };
            const endPose = { preset_l: fistData, preset_r: fistData };
            this.viewer.interpolateFingerPose(startPose, endPose, this._handSliderValues[prefix], side, prefix, this._handBiasValues);
        }

        this.syncToNode(false);
    }

    showHandControlPopover(side) {
        if (!side || !this._handPopover) return;
        this._activeHandSide = side;
        this.calibrateHandSliderDefaults(side);
        if (this._handPopoverTitle) {
            this._handPopoverTitle.textContent = side === "l" ? "Left Hand" : "Right Hand";
        }
        this._handPopover.classList.add("visible");
        this.positionHandControlPopover(side);
        requestAnimationFrame(() => {
            if (this._activeHandSide === side) {
                this.positionHandControlPopover(side, true);
            }
        });
    }

    hideHandControlPopover() {
        if (!this._handPopover) return;
        this._activeHandSide = null;
        this._pendingHandPopoverOutsideClick = null;
        this._handPopover.classList.remove("visible");
    }

    _projectWorldToCenterPanel(worldVector, centerWidth, centerHeight, canvasLeft, canvasTop, canvasWidth, canvasHeight) {
        const projected = worldVector.clone().project(this.viewer.camera);
        return {
            x: canvasLeft + (projected.x * 0.5 + 0.5) * canvasWidth,
            y: canvasTop + (-projected.y * 0.5 + 0.5) * canvasHeight,
        };
    }

    _getHandScreenMetrics(side, centerWidth, centerHeight, canvasLeft, canvasTop, canvasWidth, canvasHeight) {
        const handBone = this.viewer.bones?.[`hand_${side}`];
        const centerBone = this.viewer.bones?.[`middle_01_${side}`] || handBone;
        if (!handBone || !centerBone) return null;

        const points = [];
        const centerPos = new this.viewer.THREE.Vector3();
        centerBone.getWorldPosition(centerPos);
        const centerPoint = this._projectWorldToCenterPanel(centerPos, centerWidth, centerHeight, canvasLeft, canvasTop, canvasWidth, canvasHeight);
        points.push(centerPoint);

        const wristPos = new this.viewer.THREE.Vector3();
        handBone.getWorldPosition(wristPos);
        points.push(this._projectWorldToCenterPanel(wristPos, centerWidth, centerHeight, canvasLeft, canvasTop, canvasWidth, canvasHeight));

        for (const name of ["thumb_03", "index_03", "middle_03", "ring_03", "pinky_03"]) {
            const bone = this.viewer.bones?.[`${name}_${side}`];
            if (!bone) continue;
            const pos = new this.viewer.THREE.Vector3();
            bone.getWorldPosition(pos);
            points.push(this._projectWorldToCenterPanel(pos, centerWidth, centerHeight, canvasLeft, canvasTop, canvasWidth, canvasHeight));
        }

        let radius = 0;
        for (const point of points) {
            const dx = point.x - centerPoint.x;
            const dy = point.y - centerPoint.y;
            radius = Math.max(radius, Math.hypot(dx, dy));
        }

        return {
            x: centerPoint.x,
            y: centerPoint.y,
            radius: Math.max(36, radius + 18),
        };
    }

    positionHandControlPopover(side, useMeasuredBounds = false) {
        if (!this.viewer || !this._handPopover || !this.canvasContainer || !this.centerPanel || !side) return;
        if (!this.viewer.camera || !this.viewer.THREE) return;

        const centerWidth = this.centerPanel.clientWidth;
        const centerHeight = this.centerPanel.clientHeight;
        const canvasLeft = this.canvasContainer.offsetLeft;
        const canvasTop = this.canvasContainer.offsetTop;
        const canvasWidth = this.canvasContainer.clientWidth;
        const canvasHeight = this.canvasContainer.clientHeight;

        const measuredRect = useMeasuredBounds ? this._handPopover.getBoundingClientRect() : null;
        const panelWidth = Math.min(centerWidth - 20, measuredRect?.width || this._handPopover.offsetWidth || 240);
        const panelHeight = Math.min(centerHeight - 20, measuredRect?.height || this._handPopover.offsetHeight || 280);
        const minLeft = 10;
        const minTop = 10;
        const maxLeft = centerWidth - panelWidth - 10;
        const maxTop = centerHeight - panelHeight - 10;
        const gap = 18;

        const handMetrics = this._getHandScreenMetrics(side, centerWidth, centerHeight, canvasLeft, canvasTop, canvasWidth, canvasHeight);
        if (!handMetrics) return;

        const candidates = [
            { left: handMetrics.x + handMetrics.radius + gap, top: handMetrics.y - panelHeight * 0.5 },
            { left: handMetrics.x - handMetrics.radius - gap - panelWidth, top: handMetrics.y - panelHeight * 0.5 },
            { left: handMetrics.x - panelWidth * 0.5, top: handMetrics.y - handMetrics.radius - gap - panelHeight },
            { left: handMetrics.x - panelWidth * 0.5, top: handMetrics.y + handMetrics.radius + gap },
        ];

        const preferredOrder = side === "l" ? [0, 1, 2, 3] : [1, 0, 2, 3];
        let chosen = null;

        for (const index of preferredOrder) {
            const candidate = candidates[index];
            const fitsHorizontally = candidate.left >= minLeft && candidate.left <= maxLeft;
            const fitsVertically = candidate.top >= minTop && candidate.top <= maxTop;
            if (fitsHorizontally && fitsVertically) {
                chosen = candidate;
                break;
            }
        }

        if (!chosen) {
            let bestScore = -Infinity;
            for (const candidate of candidates) {
                const clampedLeft = Math.max(minLeft, Math.min(maxLeft, candidate.left));
                const clampedTop = Math.max(minTop, Math.min(maxTop, candidate.top));
                const dx = Math.abs(clampedLeft - candidate.left);
                const dy = Math.abs(clampedTop - candidate.top);
                const overlapPenalty = dx + dy;
                const distanceFromHand = Math.hypot((clampedLeft + panelWidth * 0.5) - handMetrics.x, (clampedTop + panelHeight * 0.5) - handMetrics.y);
                const score = distanceFromHand - overlapPenalty * 4;
                if (score > bestScore) {
                    bestScore = score;
                    chosen = { left: clampedLeft, top: clampedTop };
                }
            }
        }

        const left = Math.max(minLeft, Math.min(maxLeft, chosen.left));
        const top = Math.max(minTop, Math.min(maxTop, chosen.top));

        this._handPopover.style.left = `${left}px`;
        this._handPopover.style.top = `${top}px`;
    }

    updateTabs() {
        this.tabsContainer.innerHTML = "";

        // Show/hide Sync Tabs button based on tab count
        if (this.syncTabsBtn) {
            this.syncTabsBtn.style.display = this.poses.length > 1 ? "flex" : "none";
        }

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

        const addBtn = document.createElement("button");
        addBtn.className = "vnccs-ps-tab-add";
        addBtn.innerText = "+";
        addBtn.addEventListener("click", () => this.addTab());
        this.tabsContainer.appendChild(addBtn);

        requestAnimationFrame(() => {
            this.updateTabScrollButtons();
            this.scrollActiveTabIntoView();
        });
        this.renderPoseManager();
        this.renderPoseManagerDetailStrip();
    }

    updateTabScrollButtons() {
        if (!this.tabsContainer || !this.tabScrollLeft || !this.tabScrollRight) return;
        const tabsRect = this.tabsContainer.getBoundingClientRect();
        const viewportRight = tabsRect.right;
        const children = Array.from(this.tabsContainer.children);
        const lastChild = children[children.length - 1];
        const lastRight = lastChild?.getBoundingClientRect().right || viewportRight;
        const maxScroll = Math.max(0, lastRight - viewportRight + this.tabsContainer.scrollLeft);
        const overflow = maxScroll > 1;
        const atStart = this.tabsContainer.scrollLeft <= 1;
        const atEnd = this.tabsContainer.scrollLeft >= maxScroll - 1;
        this.tabScrollLeft.classList.toggle("visible", overflow);
        this.tabScrollRight.classList.toggle("visible", overflow);
        this.tabScrollLeft.disabled = !overflow || atStart;
        this.tabScrollRight.disabled = !overflow || atEnd;
    }

    scrollTabs(direction) {
        if (!this.tabsContainer) return;
        const amount = Math.max(120, Math.round(this.tabsContainer.clientWidth * 0.72));
        this.tabsContainer.scrollBy({ left: amount * direction, behavior: "smooth" });
        requestAnimationFrame(() => this.updateTabScrollButtons());
        setTimeout(() => this.updateTabScrollButtons(), 260);
        setTimeout(() => this.updateTabScrollButtons(), 520);
    }

    scrollActiveTabIntoView() {
        if (!this.tabsContainer) return;
        const active = this.tabsContainer.querySelector('.vnccs-ps-tab.active');
        if (!active) return;
        active.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }

    switchTab(index) {
        if (index === this.activeTab) return;

        const wasSAMCameraMode = this._samCameraModeActive;
        // Save current pose & capture
        if (this.viewer && this.viewer.isInitialized()) {
            const savedPose = this.viewer.getPose();
            if (!wasSAMCameraMode) {
                savedPose.cameraParams = this.currentCameraParams();
            } else {
                delete savedPose.cameraParams;
            }
            savedPose.prompt = this.getPosePrompt(this.activeTab);
            this.poses[this.activeTab] = savedPose;
            this.syncToNode(false);
        }

        this.activeTab = index;
        this.updateTabs();
        this.clearSAMCameraMode();
        this.syncPromptFieldToActiveTab();

        // Load new pose
        const newPose = this.poses[this.activeTab] || {};
        if (this.viewer && this.viewer.isInitialized()) {
            this.viewer.setPose(newPose);
            this.updateRotationSliders();
        }

        // Restore Camera Sliders if saved
        // Restore Camera Sliders if saved
        if (newPose.cameraParams) {
            this.exportParams.cam_offset_x = newPose.cameraParams.offset_x || 0;
            this.exportParams.cam_offset_y = newPose.cameraParams.offset_y || 0;
            this.exportParams.cam_zoom = newPose.cameraParams.zoom || 1.0;
            this.exportParams.cam_yaw_deg = newPose.cameraParams.yaw_deg || 0;
            this.exportParams.cam_pitch_deg = newPose.cameraParams.pitch_deg || 0;
        } else {
            // Default params if new pose has none
            this.exportParams.cam_offset_x = 0;
            this.exportParams.cam_offset_y = 0;
            this.exportParams.cam_zoom = 1.0;
            this.exportParams.cam_yaw_deg = 0;
            this.exportParams.cam_pitch_deg = 0;
        }

        // Update DOM widgets
        this.syncCameraWidgets();

        // Force Camera Snap
        if (this.viewer) {
            this.updateCaptureCameraPreview();
        }

        this.syncToNode(false);
    }

    addTab(options = {}) {
        // Save current & capture
        if (this.viewer && this.viewer.isInitialized()) {
            const savedPose = this.viewer.getPose();
            if (!this._samCameraModeActive) {
                savedPose.cameraParams = this.currentCameraParams();
            } else {
                delete savedPose.cameraParams;
            }
            savedPose.prompt = this.getPosePrompt(this.activeTab);
            this.poses[this.activeTab] = savedPose;
            this.syncToNode(false);
        }

        this.poses.push({});
        this.posePrompts.push("");
        this.activeTab = this.poses.length - 1;
        this.updateTabs();
        this.clearSAMCameraMode();
        this.resetCameraParams();
        this.syncPromptFieldToActiveTab();

        if (this.viewer && this.viewer.isInitialized()) {
            this.viewer.resetPose();
        }
        this.updateCaptureCameraPreview();

        this.syncToNode(false, { skipCapture: options.capturePreview ? false : undefined });
    }

    deleteTab(targetIndex = -1) {
        if (this.poses.length <= 1) return;
        const idx = targetIndex === -1 ? this.activeTab : targetIndex;

        // Remove capture
        if (this.poseCaptures && this.poseCaptures.length > idx) {
            this.poseCaptures.splice(idx, 1);
        }

        this.poses.splice(idx, 1);
        if (this.posePrompts && this.posePrompts.length > idx) {
            this.posePrompts.splice(idx, 1);
        }

        // Adjust active tab logic
        if (idx < this.activeTab) {
            this.activeTab--;
        } else if (idx === this.activeTab) {
            if (this.activeTab >= this.poses.length) {
                this.activeTab = this.poses.length - 1;
            }
            // Load new pose since active was deleted
            if (this.viewer && this.viewer.isInitialized()) {
                this.viewer.setPose(this.poses[this.activeTab] || {});
                this.updateRotationSliders();
            }
        }

        this.updateTabs();
        this.syncPromptFieldToActiveTab();
        this.syncToNode(false);
    }



    resetCurrentPose() {
        this.clearSAMCameraMode();
        this.resetCameraParams();
        if (this.viewer) {
            this.viewer.recordState(); // Undo support
            this.viewer.resetPose();
            this.updateRotationSliders();
            this.applyCameraToViewer(true);
        }
        this.poses[this.activeTab] = {};
        this.setPosePrompt(this.activeTab, "");
        this.syncToNode(false);
    }

    resetSelectedBone() {
        if (this.viewer && this.viewer.isInitialized()) {
            this.viewer.resetSelectedBone();
            this.syncToNode(false);
        }
    }

    copyPose() {
        if (this.viewer && this.viewer.isInitialized()) {
            const pose = this.viewer.getPose();
            if (!this._samCameraModeActive) {
                pose.cameraParams = this.currentCameraParams();
            } else {
                delete pose.cameraParams;
            }
            pose.prompt = this.getPosePrompt(this.activeTab);
            this.poses[this.activeTab] = pose;
        }
        this._clipboard = JSON.parse(JSON.stringify(this.poses[this.activeTab]));
    }

    pastePose() {
        if (!this._clipboard) return;
        this.clearSAMCameraMode();
        this.poses[this.activeTab] = JSON.parse(JSON.stringify(this._clipboard));
        this.setPosePrompt(this.activeTab, this.poses[this.activeTab].prompt || "");
        if (this.viewer && this.viewer.isInitialized()) {
            this.viewer.setPose(this.poses[this.activeTab]);
        }
        if (this._clipboard.cameraParams) {
            this.exportParams.cam_offset_x = this._clipboard.cameraParams.offset_x || 0;
            this.exportParams.cam_offset_y = this._clipboard.cameraParams.offset_y || 0;
            this.exportParams.cam_zoom = this._clipboard.cameraParams.zoom || 1.0;
            this.exportParams.cam_yaw_deg = this._clipboard.cameraParams.yaw_deg || 0;
            this.exportParams.cam_pitch_deg = this._clipboard.cameraParams.pitch_deg || 0;
            this.syncCameraWidgets();
            this.updateCaptureCameraPreview();
        } else {
            this.resetCameraParams();
            this.updateCaptureCameraPreview();
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

    showImportProgressModal(titleText = "SAM 3D Body") {
        const overlay = document.createElement('div');
        overlay.className = 'vnccs-ps-modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'vnccs-ps-modal';
        modal.style.maxWidth = "420px";
        modal.style.alignItems = "center";

        const title = document.createElement('div');
        title.className = 'vnccs-ps-modal-title';
        title.textContent = titleText;

        const spinner = document.createElement('div');
        spinner.className = 'vnccs-ps-loading-spinner';
        spinner.style.position = 'relative';
        spinner.style.margin = '8px auto 14px';

        const content = document.createElement('div');
        content.className = 'vnccs-ps-modal-content';
        content.style.textAlign = 'center';
        content.textContent = 'Preparing image...';

        const progressTrack = document.createElement('div');
        progressTrack.className = 'vnccs-ps-import-progress';

        const progressFill = document.createElement('div');
        progressFill.className = 'vnccs-ps-import-progress-fill';
        progressTrack.appendChild(progressFill);

        const progressPercent = document.createElement('div');
        progressPercent.className = 'vnccs-ps-import-progress-percent';
        progressPercent.textContent = '0%';

        modal.appendChild(title);
        modal.appendChild(spinner);
        modal.appendChild(content);
        modal.appendChild(progressTrack);
        modal.appendChild(progressPercent);
        overlay.appendChild(modal);
        this.canvasContainer.appendChild(overlay);

        const setProgress = (value) => {
            const percent = Math.max(0, Math.min(100, Number(value) || 0));
            progressFill.style.width = `${percent}%`;
            progressPercent.textContent = `${Math.round(percent)}%`;
        };

        return {
            setText: (text) => { content.textContent = text; },
            setProgress,
            update: (status) => {
                if (!status) return;
                if (status.message) content.textContent = status.message;
                if (status.progress !== undefined) setProgress(status.progress);
                if (status.message && /download/i.test(status.message) && !/repository/i.test(titleText)) {
                    title.textContent = "Downloading SAM 3D Body Models";
                } else {
                    title.textContent = titleText;
                }
            },
            close: () => overlay.remove(),
        };
    }

    async importSAM3DImageAsPose(file) {
        if (!this.viewer || !this.viewer.isInitialized()) {
            throw new Error("Pose viewer is not ready.");
        }

        const progress = this.showImportProgressModal("SAM 3D Body Import");
        const taskId = (
            globalThis.crypto?.randomUUID?.()
            || `sam3d-${Date.now()}-${Math.random().toString(16).slice(2)}`
        );
        let pollTimer = null;
        const pollStatus = async () => {
            try {
                const statusResponse = await api.fetchApi(`/vnccs/sam3d/import_status/${encodeURIComponent(taskId)}`);
                if (!statusResponse.ok) return;
                progress.update(await statusResponse.json());
            } catch (_err) {
                // The long-running POST is the source of truth; status polling is best-effort UI.
            }
        };
        try {
            progress.setProgress(1);
            progress.setText("Step 1/6: Uploading image to SAM 3D Body...");
            const form = new FormData();
            form.append("task_id", taskId);
            form.append("image", file, file.name || "pose_image.png");

            progress.setText("Step 1/6: Waiting for SAM 3D Body to start processing...");
            pollTimer = setInterval(pollStatus, 700);
            const response = await api.fetchApi("/vnccs/sam3d/process_image_to_pose_json", {
                method: "POST",
                body: form,
            });
            await pollStatus();

            const result = await response.json();
            if (!response.ok) {
                throw new Error(result?.error || `HTTP ${response.status}`);
            }

            progress.setProgress(92);
            progress.setText("Step 6/6: Building SAM render fit...");
            const poseData = result.pose_data || (result.pose_json ? JSON.parse(result.pose_json) : null);
            if (!poseData) {
                throw new Error("SAM 3D Body returned empty pose JSON.");
            }

            const fitData = await this.prepareSAM3DRenderFit(poseData);
            const poseForImport = fitData?.poseData || poseData;

            progress.setProgress(96);
            progress.setText("Step 6/6: Applying fitted pose to MakeHuman skeleton...");
            const ok = this.viewer.applySAM3DImport(
                poseForImport,
                this._shoulderYOffset || 0
            );
            if (!ok) {
                throw new Error("Failed to apply SAM 3D Body pose to Pose Studio.");
            }
            this.syncMeshProportionSlidersFromViewer();

            this._lastSAM3DPoseData = poseForImport;
            this._lastSAM3DMeshData = fitData?.meshData || null;
            if (fitData?.meshData) {
                this.applySAM3DMeshOverlayFit(fitData.meshData, poseForImport);
            } else {
                await this.refreshSAMMeshOverlay(poseForImport);
            }
            this.syncMeshProportionSlidersFromViewer();
            this.applySAM3DFrameCameraParams(poseForImport, fitData?.meshData || null);
            this.poses[this.activeTab] = this.viewer.getPose();
            this.updateRotationSliders();
            this.syncToNode(true);
            progress.setProgress(100);
            progress.setText("Step 6/6: Pose applied to Pose Studio.");
            this.showMessage("SAM 3D Body image imported successfully.");
        } finally {
            if (pollTimer) clearInterval(pollTimer);
            progress.close();
        }
    }

    async refreshSAMMeshOverlay(poseData = null) {
        const activePose = poseData || this._lastSAM3DPoseData;
        if (!this.viewer?.setSAMMeshOverlayData || !activePose) return false;
        const showMeshOverlay = !!this.exportParams.debugShowSAMMeshOverlay;
        const showHelperSkeleton = this.exportParams.debugShowSAMHelper !== false;
        if (!showMeshOverlay && !showHelperSkeleton) {
            this.viewer.setSAMMeshOverlayVisible?.(false);
            return false;
        }
        try {
            const meshData = await this.fetchSAM3DRenderMesh(activePose);
            this._lastSAM3DMeshData = meshData;
            const ok = this.viewer.setSAMMeshOverlayData(meshData, activePose);
            this.viewer.setSAMMeshOverlayVisible?.(showMeshOverlay);
            return ok;
        } catch (err) {
            console.error("[VNCCS] Failed to build SAM mesh overlay:", err);
            this.showMessage?.(`Failed to build SAM mesh overlay: ${err?.message || err}`, true);
            return false;
        }
    }

    async fetchSAM3DRenderMesh(poseData) {
        const response = await api.fetchApi("/vnccs/sam3d/render_mesh_overlay", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                pose_data: poseData,
                body_preset: {},
                pose_adjust: 0.0,
            }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result?.error || `HTTP ${response.status}`);
        return result.mesh;
    }

    buildSAM3DFittedPoseData(poseData, meshData) {
        const fittedJointCoords = meshData?.fitted_joint_coords;
        if (!poseData || !Array.isArray(fittedJointCoords)) return poseData;
        return {
            ...poseData,
            joint_coords: fittedJointCoords,
            sam3d_pose_fit_source: "render_mesh_overlay",
        };
    }

    async prepareSAM3DRenderFit(poseData) {
        try {
            const meshData = await this.fetchSAM3DRenderMesh(poseData);
            return {
                meshData,
                poseData: this.buildSAM3DFittedPoseData(poseData, meshData),
            };
        } catch (err) {
            console.error("[VNCCS] Failed to build SAM render fit:", err);
            this.showMessage?.(`Failed to build SAM render fit: ${err?.message || err}`, true);
            return null;
        }
    }

    applySAM3DMeshOverlayFit(meshData, poseData) {
        if (!meshData || !this.viewer?.setSAMMeshOverlayData) return false;
        const ok = this.viewer.setSAMMeshOverlayData(meshData, poseData);
        this.viewer.setSAMMeshOverlayVisible?.(!!this.exportParams.debugShowSAMMeshOverlay);
        if (ok && this.viewer.fitCurrentPoseToSAMMeshOverlay) {
            return this.viewer.fitCurrentPoseToSAMMeshOverlay();
        }
        return ok;
    }

    applySAM3DFrameCameraParams(poseData, meshData = null) {
        const frameParams = this.viewer?.computeSAM3DFrameCameraParams?.(
            poseData,
            this.exportParams.view_width || 1024,
            this.exportParams.view_height || 1024,
            meshData
        );
        if (!frameParams) {
            this.viewer?.setSAMProjectionCameraFrame?.(null);
            this._samCameraModeActive = false;
            return false;
        }
        // When SAM camera override is disabled: use forceFallback to get proper bbox-based
        // zoom/offset. Also apply inverse SAM camera angles to the model rotation so the
        // pose looks correct from the standard front-facing camera without moving the camera.
        if (!this.exportParams.samApplyCamera) {
            this.viewer?.setSAMProjectionCameraFrame?.(null);
            this._samCameraModeActive = false;
            const fallbackParams = this.viewer?.computeSAM3DFrameCameraParams?.(
                poseData,
                this.exportParams.view_width || 1024,
                this.exportParams.view_height || 1024,
                meshData,
                true // forceFallback: skip sam_projection, compute bbox zoom/offset + camera angles
            );
            if (fallbackParams) {
                this.exportParams.cam_zoom = fallbackParams.zoom;
                this.exportParams.cam_offset_x = fallbackParams.offset_x;
                this.exportParams.cam_offset_y = fallbackParams.offset_y;
                // Apply inverse SAM camera angles as model rotation
                const yaw = fallbackParams.yaw_deg || 0;
                const pitch = fallbackParams.pitch_deg || 0;
                if (Math.abs(yaw) > 0.5 || Math.abs(pitch) > 0.5) {
                    const curRot = this.viewer.getPose?.()?.modelRotation || [0, 0, 0];
                    this.viewer.setModelRotation(
                        curRot[0] - pitch,
                        curRot[1] - yaw,
                        curRot[2]
                    );
                    this.updateRotationSliders();
                }
            }
            this.syncCameraWidgets();
            this.applyCameraToViewer(true);
            this.viewer.setCameraParams(this.currentCameraParams());
            return true;
        }
        this.viewer?.setSAMProjectionCameraFrame?.(frameParams.sam_projection || null);
        this._samCameraModeActive = !!frameParams.sam_projection;

        // Save pre-SAM params for toggle (first application only)
        if (!this._samCamBannerVisible) {
            this._samCamPreParams = {
                cam_zoom: this.exportParams.cam_zoom,
                cam_offset_x: this.exportParams.cam_offset_x,
                cam_offset_y: this.exportParams.cam_offset_y,
                cam_yaw_deg: this.exportParams.cam_yaw_deg,
                cam_pitch_deg: this.exportParams.cam_pitch_deg,
            };
        }

        this.exportParams.cam_zoom = frameParams.zoom;
        this.exportParams.cam_offset_x = frameParams.offset_x;
        this.exportParams.cam_offset_y = frameParams.offset_y;
        this.exportParams.cam_yaw_deg = frameParams.yaw_deg ?? 0;
        this.exportParams.cam_pitch_deg = frameParams.pitch_deg ?? 0;
        this.syncCameraWidgets();
        this.applyCameraToViewer(true);
        this.viewer.setCameraParams(this.currentCameraParams());

        this._samCamStoredParams = {
            cam_zoom: this.exportParams.cam_zoom,
            cam_offset_x: this.exportParams.cam_offset_x,
            cam_offset_y: this.exportParams.cam_offset_y,
            cam_yaw_deg: this.exportParams.cam_yaw_deg,
            cam_pitch_deg: this.exportParams.cam_pitch_deg,
        };
        this._samCamStoredProjectionFrame = frameParams.sam_projection || null;
        this._samCamBannerVisible = true;
        this._samCamDisplayActive = true;
        this._updateSAMCameraBanner();
        return true;
    }

    clearImportedDebugFigures() {
        if (!this.viewer?._clearImportedFigureGroup) return;
        this.viewer._clearImportedFigureGroup('_hmr2FigureGroup');
        this.viewer._clearImportedFigureGroup('_rtmwFigureGroup');
        this.viewer._clearImportedFigureGroup('_kpFigureGroup');
    }

    handleFileImport(e) {
        const file = e.target.files[0];
        if (!file) return;
        const input = e.target;
        const lowerName = (file.name || '').toLowerCase();

        if (lowerName.endsWith('.fbx')) {
            (async () => {
                try {
                    this.clearSAMCameraMode();
                    this.resetCameraParams();
                    const result = await importMixamoFBXAsPoses(file, this.viewer, {
                        fps: 12,
                        maxFrames: 48,
                    });

                    this.poses = result.poses;
                    this.activeTab = 0;
                    this.updateTabs();

                    if (this.viewer && this.viewer.isInitialized()) {
                        this.viewer.setPose(this.poses[0], true);
                        this.updateRotationSliders();
                    }
                    this.updateCaptureCameraPreview();

                    this.syncToNode(true);
                    this.showMessage(`Mixamo FBX imported successfully: ${this.poses.length} poses from ${result.clipName}.`);
                } catch (err) {
                    console.error('Error importing Mixamo FBX:', err);
                    this.showMessage(`Failed to import FBX animation: ${err?.message || err}`, true);
                } finally {
                    input.value = '';
                }
            })();
            return;
        }

        // Image files → run SAM 3D Body and import the resulting pose JSON
        if (file.type.startsWith("image/")) {
            (async () => {
                try {
                    await this.importSAM3DImageAsPose(file);
                } catch (err) {
                    console.error("Error importing SAM 3D Body image:", err);
                    this.showMessage(`Failed to import image with SAM 3D Body: ${err?.message || err}`, true);
                } finally {
                    input.value = '';
                }
            })();
            return;
        }

        // JSON files
        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                const data = JSON.parse(event.target.result);

                const isSAM3DJson = Array.isArray(data?.body_pose_params)
                    && (Array.isArray(data?.keypoints_3d) || Array.isArray(data?.joint_coords))
                    && (Array.isArray(data?.global_rot) || Array.isArray(data?.joint_rotations));

                if (isSAM3DJson) {
                    if (this.viewer && this.viewer.isInitialized()) {
                        const fitData = await this.prepareSAM3DRenderFit(data);
                        const poseForImport = fitData?.poseData || data;
                        const ok = this.viewer.applySAM3DImport(
                            poseForImport,
                            this._shoulderYOffset || 0
                        );
                        if (ok) {
                            this._lastSAM3DPoseData = poseForImport;
                            this._lastSAM3DMeshData = fitData?.meshData || null;
                            if (fitData?.meshData) {
                                this.applySAM3DMeshOverlayFit(fitData.meshData, poseForImport);
                            } else {
                                this.refreshSAMMeshOverlay(poseForImport);
                            }
                            this.syncMeshProportionSlidersFromViewer();
                            this.applySAM3DFrameCameraParams(poseForImport, fitData?.meshData || null);
                            this.poses[this.activeTab] = this.viewer.getPose();
                            this.updateRotationSliders();
                            this.syncToNode(false);
                            this.showMessage("SAM3D JSON imported successfully.");
                        } else {
                            this.showMessage("Failed to apply SAM3D JSON.", true);
                        }
                    }
                    input.value = '';
                    return;
                }

                if (data?.version === 'hmr2_3d_v1') {
                    if (this.viewer && this.viewer.isInitialized()) {
                        this.clearSAMCameraMode();
                        this.resetCameraParams();
                        const ok = this.viewer.applyHMR2v1Import(
                            data,
                            this._smplRefHeight || 1.45,
                            this._shoulderYOffset || 0
                        );
                        if (ok) {
                            this.poses[this.activeTab] = this.viewer.getPose();
                            this.updateRotationSliders();
                            this.applyCameraToViewer(true);
                            this.syncToNode(false);
                            this.showMessage("HMR2/pose3d JSON imported successfully.");
                        } else {
                            this.showMessage("Failed to apply HMR2/pose3d JSON.", true);
                        }
                    }
                    input.value = '';
                    return;
                }

                // Try pose JSON formats (HMR2 / OpenPose / VNCCS)
                const openPoseKeypoints = detectAndParseJSON(data);
                if (openPoseKeypoints) {
                    if (this.viewer && this.viewer.isInitialized()) {
                        this.clearSAMCameraMode();
                        this.resetCameraParams();
                        const poseData = convertOpenPoseToPose(openPoseKeypoints, this.viewer);
                        if (poseData) {
                            this.poses[this.activeTab] = poseData;
                            this.viewer.setPose(poseData);
                            this.updateRotationSliders();
                            this.applyCameraToViewer(true);
                            this.syncToNode(false);

                            let msg = "OpenPose JSON imported successfully.";
                            if (openPoseKeypoints.source === 'hmr2') msg = "HMR2/pose3d JSON imported successfully.";
                            else if (openPoseKeypoints.source === 'rtmw') msg = "RTMW JSON imported successfully.";
                            else if (openPoseKeypoints.source === 'metrabs') msg = "MeTRAbs JSON imported successfully.";
                            else if (openPoseKeypoints.source === 'vnccs') msg = "VNCCS skeleton JSON imported successfully.";
                            this.showMessage(msg);

                            // Debug: round-trip angle test
                            roundTripTest(openPoseKeypoints, this.viewer, poseData);
                        } else {
                            this.showMessage("Failed to convert OpenPose data to pose.", true);
                        }
                    }
                } else if (data.type === "pose_set" || Array.isArray(data.poses)) {
                    // Import Set
                    const newPoses = data.poses || (Array.isArray(data) ? data : null);
                    if (newPoses && Array.isArray(newPoses)) {
                        this.clearSAMCameraMode();
                        this.resetCameraParams();
                        this.poses = newPoses;
                        this.activeTab = 0;
                        this.updateTabs();
                        // Load first pose
                        if (this.viewer && this.viewer.isInitialized()) {
                            this.viewer.setPose(this.poses[0]);
                            this.updateRotationSliders();
                        }
                        this.updateCaptureCameraPreview();
                    }
                    this.syncToNode(true);
                } else if (data.type === "single_pose" || data.bones) {
                    // Import Single to current tab
                    this.clearSAMCameraMode();
                    this.resetCameraParams();
                    const poseData = data.bones ? data : data;

                    this.poses[this.activeTab] = poseData;
                    if (this.viewer && this.viewer.isInitialized()) {
                        this.viewer.setPose(poseData);
                        this.updateRotationSliders();
                    }
                    this.updateCaptureCameraPreview();
                    this.syncToNode(false);
                }

            } catch (err) {
                console.error("Error importing pose:", err);
                this.showMessage("Failed to load pose file. Invalid JSON.", true);
            }

            // Reset input so same file can be selected again
            input.value = '';
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
            const dataUrl = event.target.result;
            if (this.viewer) {
                this.viewer.loadReferenceImage(dataUrl);
                this.exportParams.background_url = dataUrl;
                this.syncToNode(false);

                this.loadModel(false, false);

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

    getLibraryThumbnailBounds() {
        return { min: 160, max: 520, defaultSize: 320 };
    }

    loadLibraryThumbnailSize() {
        const bounds = this.getLibraryThumbnailBounds();
        try {
            const stored = Number(localStorage.getItem(this.libraryThumbSizeStorageKey));
            if (Number.isFinite(stored)) {
                return Math.max(bounds.min, Math.min(bounds.max, stored));
            }
        } catch (_err) {
            // localStorage can be unavailable in restricted browser contexts.
        }
        return bounds.defaultSize;
    }

    saveLibraryThumbnailSize(size) {
        const bounds = this.getLibraryThumbnailBounds();
        const value = Math.max(bounds.min, Math.min(bounds.max, Number(size) || bounds.defaultSize));
        this.libraryThumbSize = value;
        try {
            localStorage.setItem(this.libraryThumbSizeStorageKey, String(value));
        } catch (_err) {}
        this.applyLibraryThumbnailSize();
        return value;
    }

    applyLibraryThumbnailSize(root = null) {
        const target = root || this.libraryWorkspace || this.libraryGrid;
        if (!target) return;
        const size = this.libraryThumbSize || this.getLibraryThumbnailBounds().defaultSize;
        target.style.setProperty("--vnccs-ps-library-thumb-size", `${size}px`);
        target.style.setProperty("--vnccs-ps-library-thumb-height", `${Math.round(size * 1.3125)}px`);
        if (this.librarySizeValue) this.librarySizeValue.textContent = `${Math.round(size)}`;
    }

    showLibraryModal() {
        const overlay = document.createElement('div');
        overlay.className = 'vnccs-ps-modal-overlay vnccs-ps-library-overlay';

        const modal = document.createElement('div');
        modal.className = 'vnccs-ps-library-modal';
        modal.innerHTML = `
            <div class="vnccs-ps-library-modal-header">
                <div class="vnccs-ps-library-modal-title">📚 Pose Library</div>
                <div class="vnccs-ps-library-header-actions">
                    <button class="vnccs-ps-btn primary vnccs-ps-library-save-current">
                        <span class="vnccs-ps-btn-icon">💾</span> Save Current Pose
                    </button>
                </div>
                <button class="vnccs-ps-modal-close">✕</button>
            </div>
            <div class="vnccs-ps-library-toolbar">
                <input class="vnccs-ps-library-search" type="search" placeholder="Search poses and tags...">
                <label class="vnccs-ps-library-size-control" title="Preview size">
                    <span>Preview</span>
                    <input class="vnccs-ps-library-size-slider" type="range" min="160" max="520" step="10">
                    <span class="vnccs-ps-library-size-value"></span>
                </label>
                <button class="vnccs-ps-library-menu-btn" title="Pose library settings">⚙️</button>
            </div>
            <div class="vnccs-ps-library-categories"></div>
            <div class="vnccs-ps-library-workspace">
                <div class="vnccs-ps-library-modal-grid"></div>
                <aside class="vnccs-ps-library-inspector"></aside>
                <section class="vnccs-ps-library-settings"></section>
            </div>
        `;

        this.libraryModal = modal;
        this.libraryGrid = modal.querySelector('.vnccs-ps-library-modal-grid');
        this.libraryInspector = modal.querySelector('.vnccs-ps-library-inspector');
        this.libraryWorkspace = modal.querySelector('.vnccs-ps-library-workspace');
        this.librarySearchInput = modal.querySelector('.vnccs-ps-library-search');
        this.librarySizeInput = modal.querySelector('.vnccs-ps-library-size-slider');
        this.librarySizeValue = modal.querySelector('.vnccs-ps-library-size-value');
        this.libraryCategoriesEl = modal.querySelector('.vnccs-ps-library-categories');
        this.librarySettingsEl = modal.querySelector('.vnccs-ps-library-settings');
        this.librarySettingsMode = false;
        this.librarySelectedName = null;
        this.libraryActiveCategory = "All";
        if (this.librarySizeInput) {
            this.librarySizeInput.value = String(this.libraryThumbSize);
            this.librarySizeInput.addEventListener('input', () => this.saveLibraryThumbnailSize(this.librarySizeInput.value));
        }
        this.applyLibraryThumbnailSize(this.libraryWorkspace);

        const closeLibraryModal = () => {
            if (this.libraryResizeObserver) {
                this.libraryResizeObserver.disconnect();
                this.libraryResizeObserver = null;
            }
            this.libraryModal = null;
            overlay.remove();
        };
        modal.querySelector('.vnccs-ps-modal-close').onclick = closeLibraryModal;
        modal.querySelector('.vnccs-ps-library-save-current').onclick = () => this.showSaveToLibraryModal();
        modal.querySelector('.vnccs-ps-library-menu-btn').onclick = () => this.toggleLibrarySettings();
        this.librarySearchInput.addEventListener('input', () => this.renderLibrary());
        overlay.onclick = (e) => { if (e.target === overlay) closeLibraryModal(); };

        overlay.appendChild(modal);
        this.container.appendChild(overlay);
        this.startLibraryResizeObserver();

        this.refreshLibrary(true);
    }

    startLibraryResizeObserver() {
        if (!this.libraryWorkspace || this.libraryResizeObserver) {
            this.updateLibraryLayoutScale();
            return;
        }
        if (typeof ResizeObserver !== "undefined") {
            this.libraryResizeObserver = new ResizeObserver(() => this.updateLibraryLayoutScale());
            if (this.libraryModal) this.libraryResizeObserver.observe(this.libraryModal);
            this.libraryResizeObserver.observe(this.libraryWorkspace);
        }
        this.updateLibraryLayoutScale();
    }

    updateLibraryLayoutScale() {
        if (this.libraryModal) {
            const modalWidth = this.libraryModal.clientWidth || this.libraryModal.getBoundingClientRect().width || 1600;
            const scale = Math.max(0.5, Math.min(1.4, modalWidth / 1600));
            this.libraryModal.style.setProperty("--vnccs-ps-library-ui-scale", scale.toFixed(3));
        }
        this.updateLibraryInspectorScale();
    }

    updateLibraryInspectorScale() {
        if (!this.libraryWorkspace) return;
        const baseWidth = 510;
        const baseHeight = 900;
        const workspaceWidth = this.libraryWorkspace.clientWidth || baseWidth;
        const workspaceHeight = this.libraryWorkspace.clientHeight || baseHeight;
        const availableWidth = Math.max(260, Math.min(baseWidth, workspaceWidth * 0.38));
        const availableHeight = Math.max(420, workspaceHeight - 2);
        const scale = Math.max(0.45, Math.min(1, availableWidth / baseWidth, availableHeight / baseHeight));
        this.libraryWorkspace.style.setProperty("--vnccs-ps-library-inspector-scale", scale.toFixed(3));
    }

    async refreshLibrary(forceFull = false) {
        try {
            const res = await fetch('/vnccs/pose_library/list?full=true');
            const data = await res.json();
            this.libraryPoses = data.poses || []; // Cache for random selection
            this.renderLibrary();
        } catch (err) {
            console.error("Failed to load library:", err);
            if (this.libraryGrid) {
                this.libraryGrid.innerHTML = '<div class="vnccs-ps-library-empty">Failed to load library.</div>';
            }
        }
    }

    async autoRefreshEnabledPoseRepositories() {
        if (this._autoRepoRefreshStarted) return;
        this._autoRepoRefreshStarted = true;
        try {
            const res = await fetch('/vnccs/pose_library/repositories/auto_refresh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason: 'pose_studio_initial_load', force: true }),
            });
            const data = await res.json().catch(() => ({}));
            const taskId = data.task_id;
            if (!taskId || (!data.started && !data.running)) return;

            const startedAt = Date.now();
            const poll = async () => {
                try {
                    const statusRes = await fetch(`/vnccs/pose_library/repositories/progress/${encodeURIComponent(taskId)}`);
                    if (!statusRes.ok) return false;
                    const status = await statusRes.json();
                    if (status.status === 'success') {
                        await this.refreshLibrary(true);
                        if (this.librarySettingsMode) await this.refreshPoseRepositories();
                        return true;
                    }
                    if (status.status === 'error') {
                        console.warn("[VNCCS PoseStudio] Background pose repository refresh failed:", status.message);
                        return true;
                    }
                    return false;
                } catch (err) {
                    console.warn("[VNCCS PoseStudio] Background pose repository refresh poll failed:", err);
                    return true;
                }
            };

            const timer = setInterval(async () => {
                if (Date.now() - startedAt > 10 * 60 * 1000 || await poll()) {
                    clearInterval(timer);
                }
            }, 2500);
        } catch (err) {
            console.warn("[VNCCS PoseStudio] Failed to start background pose repository refresh:", err);
        }
    }

    async toggleLibrarySettings(force = null) {
        this.librarySettingsMode = force === null ? !this.librarySettingsMode : !!force;
        if (this.libraryWorkspace) {
            this.libraryWorkspace.classList.toggle('settings-mode', this.librarySettingsMode);
            if (this.librarySettingsMode) this.libraryWorkspace.classList.remove('has-inspector');
        }
        if (this.libraryCategoriesEl) this.libraryCategoriesEl.style.display = this.librarySettingsMode ? 'none' : '';
        if (this.librarySearchInput) {
            this.librarySearchInput.disabled = this.librarySettingsMode;
            this.librarySearchInput.placeholder = this.librarySettingsMode ? "Repository settings" : "Search poses and tags...";
        }
        if (this.librarySettingsMode) {
            await this.refreshPoseRepositories();
        } else {
            this.renderLibrary();
        }
    }

    async refreshPoseRepositories(forceRepoId = "") {
        if (!this.librarySettingsEl) return;
        this.librarySettingsEl.innerHTML = '<div class="vnccs-ps-library-empty">Loading repositories...</div>';
        try {
            const url = '/vnccs/pose_library/repositories';
            const res = await fetch(url);
            const data = await res.json();
            this.localPoseRepository = data.local_repository || null;
            this.poseRepositories = data.repositories || [];
            this.renderPoseRepositorySettings();
            if (forceRepoId) await this.refreshSinglePoseRepository(forceRepoId);
        } catch (err) {
            this.librarySettingsEl.innerHTML = `<div class="vnccs-ps-library-empty">Failed to load repositories.<br>${this.escapeHtml(err?.message || err)}</div>`;
        }
    }

    renderPoseRepositorySettings() {
        if (!this.librarySettingsEl) return;
        const repos = this.poseRepositories || [];
        this.librarySettingsEl.innerHTML = `
            <div class="vnccs-ps-library-settings-head">
                <div>
                    <div class="vnccs-ps-library-settings-title">Pose Repositories</div>
                    <div class="vnccs-ps-library-settings-subtitle">Hugging Face libraries can be enabled, disabled, refreshed, or removed.</div>
                </div>
                <button class="vnccs-ps-btn vnccs-ps-library-settings-back">Back to poses</button>
            </div>
            <div class="vnccs-ps-library-local-repo"></div>
            <div class="vnccs-ps-library-repo-notice"></div>
            <div class="vnccs-ps-library-repo-add">
                <input class="vnccs-ps-input vnccs-ps-library-repo-input" type="text" placeholder="owner/repository">
                <button class="vnccs-ps-btn primary vnccs-ps-library-repo-add-btn">Add Repository</button>
            </div>
            <div class="vnccs-ps-library-repo-list"></div>
        `;
        this.librarySettingsEl.querySelector('.vnccs-ps-library-settings-back').onclick = () => this.toggleLibrarySettings(false);
        this.librarySettingsEl.querySelector('.vnccs-ps-library-repo-add-btn').onclick = () => this.addPoseRepository();
        const input = this.librarySettingsEl.querySelector('.vnccs-ps-library-repo-input');
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') this.addPoseRepository();
        });
        this.renderLocalPoseRepositorySettings();

        const list = this.librarySettingsEl.querySelector('.vnccs-ps-library-repo-list');
        if (repos.length === 0) {
            list.innerHTML = '<div class="vnccs-ps-library-empty">No repositories configured.</div>';
            return;
        }
        for (const repo of repos) {
            const card = document.createElement('div');
            card.className = 'vnccs-ps-library-repo-card';
            const progressKey = `repo:${repo.repo_id}`;
            card.dataset.repoProgressKey = progressKey;
            const status = repo.status === 'error' ? `Error: ${repo.last_error || 'refresh failed'}` : (repo.status || 'not checked');
            const checked = repo.last_checked ? new Date(repo.last_checked * 1000).toLocaleString() : 'never';
            const syncMeta = repo.downloaded_count !== undefined
                ? ` · ${Number(repo.downloaded_count || 0)} downloaded · ${Number(repo.skipped_count || 0)} unchanged · ${Number(repo.removed_count || 0)} removed`
                : '';
            card.innerHTML = `
                <div>
                    <div class="vnccs-ps-library-repo-title">${this.escapeHtml(repo.title || repo.repo_id)}</div>
                    <div class="vnccs-ps-library-repo-id">${this.escapeHtml(repo.repo_id)}</div>
                    <div class="vnccs-ps-library-repo-meta">${Number(repo.pose_count || 0)} poses · ${repo.enabled ? 'enabled' : 'disabled'} · ${this.escapeHtml(status)} · checked ${this.escapeHtml(checked)}${this.escapeHtml(syncMeta)}</div>
                </div>
                <div class="vnccs-ps-library-repo-actions">
                    <button class="vnccs-ps-library-repo-action toggle">${repo.enabled ? 'Disable' : 'Enable'}</button>
                    <button class="vnccs-ps-library-repo-action refresh">Refresh</button>
                    <button class="vnccs-ps-library-repo-action danger remove" ${repo.builtin ? 'disabled title="Default repositories can be disabled, not deleted"' : ''}>Remove</button>
                </div>
                ${this.repositoryProgressMarkup()}
            `;
            card.querySelector('.toggle').onclick = () => this.togglePoseRepository(repo.repo_id, !repo.enabled);
            card.querySelector('.refresh').onclick = () => this.refreshSinglePoseRepository(repo.repo_id);
            card.querySelector('.remove').onclick = () => this.removePoseRepository(repo.repo_id);
            list.appendChild(card);
            this.updateRepositoryProgressUi(progressKey);
        }
    }

    renderLocalPoseRepositorySettings() {
        const holder = this.librarySettingsEl?.querySelector('.vnccs-ps-library-local-repo');
        if (!holder) return;
        const repo = this.localPoseRepository || {};
        const publishRepo = repo.publish_repo_id || "Not linked";
        const lastPublish = repo.last_publish ? new Date(repo.last_publish * 1000).toLocaleString() : "never";
        const lastResult = repo.last_publish_result
            ? `${Number(repo.last_publish_result.uploaded_count || 0)} uploaded · ${Number(repo.last_publish_result.deleted_count || 0)} deleted · ${Number(repo.last_publish_result.skipped_count || 0)} unchanged`
            : "not published yet";
        holder.innerHTML = `
            <div class="vnccs-ps-library-repo-card" data-repo-progress-key="local:publish">
                <div>
                    <div class="vnccs-ps-library-repo-title">Local User Poses</div>
                    <div class="vnccs-ps-library-repo-id">local_user_poses → ${this.escapeHtml(publishRepo)}</div>
                    <div class="vnccs-ps-library-repo-meta">${Number(repo.pose_count || 0)} poses · last publish ${this.escapeHtml(lastPublish)} · ${this.escapeHtml(lastResult)}</div>
                </div>
                <div class="vnccs-ps-library-repo-actions">
                    <button class="vnccs-ps-library-repo-action primary publish">Publish</button>
                    ${repo.publish_repo_id ? '<button class="vnccs-ps-library-repo-action relink">Change target</button>' : ''}
                </div>
                ${this.repositoryProgressMarkup()}
            </div>
        `;
        holder.querySelector('.publish').onclick = () => this.publishLocalPoseRepository(false);
        holder.querySelector('.relink')?.addEventListener('click', () => this.showPublishLocalRepositoryModal(true));
        this.updateRepositoryProgressUi("local:publish");
    }

    showRepositoryNotice(message, isError = false) {
        const notice = this.librarySettingsEl?.querySelector('.vnccs-ps-library-repo-notice');
        if (!notice) return;
        notice.textContent = message;
        notice.classList.toggle('error', !!isError);
        notice.classList.add('visible');
    }

    clearRepositoryNotice() {
        const notice = this.librarySettingsEl?.querySelector('.vnccs-ps-library-repo-notice');
        if (!notice) return;
        notice.textContent = "";
        notice.classList.remove('visible', 'error');
    }

    async publishLocalPoseRepository(forceConfigure = false) {
        const repo = this.localPoseRepository || {};
        if (forceConfigure || !repo.publish_repo_id || !repo.has_hf_token) {
            this.showPublishLocalRepositoryModal(forceConfigure);
            return;
        }
        await this.runLocalPoseRepositoryPublish({
            repo_id: repo.publish_repo_id,
            create: false,
        });
    }

    showPublishLocalRepositoryModal(forceConfigure = false) {
        const current = this.localPoseRepository || {};
        const overlay = document.createElement('div');
        overlay.className = 'vnccs-ps-modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'vnccs-ps-modal';
        modal.style.maxWidth = "420px";
        modal.innerHTML = `
            <div class="vnccs-ps-modal-title">Publish Local Pose Repository</div>
            <div class="vnccs-ps-modal-content">
                <label class="vnccs-ps-library-field">
                    <span>Target</span>
                    <select class="vnccs-ps-input vnccs-ps-publish-mode">
                        <option value="create">Create new repository</option>
                        <option value="existing">Use existing repository</option>
                    </select>
                </label>
                <label class="vnccs-ps-library-field">
                    <span>Hugging Face repo</span>
                    <input class="vnccs-ps-input vnccs-ps-publish-repo" type="text" placeholder="owner/repository" value="${this.escapeHtml(current.publish_repo_id || "")}">
                </label>
                <label class="vnccs-ps-library-field vnccs-ps-publish-private-row">
                    <span>Visibility</span>
                    <label style="display:flex;align-items:center;gap:8px;color:var(--ps-text-muted);font-size:12px;">
                        <input class="vnccs-ps-publish-private" type="checkbox"> Private repository
                    </label>
                </label>
                <label class="vnccs-ps-library-field">
                    <span>HF token ${current.has_hf_token ? '(saved)' : ''}</span>
                    <input class="vnccs-ps-input vnccs-ps-publish-token" type="password" placeholder="${current.has_hf_token ? 'Leave empty to use saved token' : 'hf_...'}">
                </label>
            </div>
            <button class="vnccs-ps-modal-btn primary" style="justify-content:center;">Publish</button>
            <button class="vnccs-ps-modal-btn cancel">Cancel</button>
        `;

        const modeEl = modal.querySelector('.vnccs-ps-publish-mode');
        const privateRow = modal.querySelector('.vnccs-ps-publish-private-row');
        const syncMode = () => {
            privateRow.style.display = modeEl.value === "create" ? "" : "none";
        };
        modeEl.value = current.publish_repo_id ? "existing" : "create";
        modeEl.onchange = syncMode;
        syncMode();

        modal.querySelector('.vnccs-ps-modal-btn.primary').onclick = async () => {
            const repoId = modal.querySelector('.vnccs-ps-publish-repo').value.trim();
            const token = modal.querySelector('.vnccs-ps-publish-token').value.trim();
            if (!repoId) {
                const repoInput = modal.querySelector('.vnccs-ps-publish-repo');
                repoInput.style.borderColor = "rgba(255,71,87,0.7)";
                repoInput.placeholder = "Repository id is required";
                repoInput.focus();
                return;
            }
            overlay.remove();
            await this.runLocalPoseRepositoryPublish({
                repo_id: repoId,
                hf_token: token,
                create: modeEl.value === "create",
                private: modal.querySelector('.vnccs-ps-publish-private').checked,
            });
        };
        modal.querySelector('.vnccs-ps-modal-btn.cancel').onclick = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
        overlay.appendChild(modal);
        this.container.appendChild(overlay);
        modal.querySelector('.vnccs-ps-publish-repo').focus();
    }

    async runLocalPoseRepositoryPublish(payload) {
        const progressKey = "local:publish";
        const taskId = this.createRepositoryTaskId("repo-publish");
        const progress = this.createInlineRepositoryProgress(progressKey, "Publishing local poses to Hugging Face...");
        let pollTimer = null;
        try {
            pollTimer = setInterval(() => this.pollRepositoryProgress(taskId, progress), 350);
            const res = await fetch('/vnccs/pose_library/repositories/local/publish', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payload, task_id: taskId }),
            });
            await this.pollRepositoryProgress(taskId, progress);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
            this.localPoseRepository = data.local_repository || this.localPoseRepository;
            this.renderPoseRepositorySettings();
            const result = data.result || {};
            progress.update({
                status: "success",
                progress: 100,
                message: `Published ${Number(result.uploaded_count || 0)} files. Deleted ${Number(result.deleted_count || 0)} stale files. ${Number(result.skipped_count || 0)} poses unchanged.`,
            });
        } catch (err) {
            progress.update({
                status: "error",
                progress: 100,
                message: `Failed to publish local poses: ${err?.message || err}`,
            });
            this.renderPoseRepositorySettings();
        } finally {
            if (pollTimer) clearInterval(pollTimer);
            progress.close();
        }
    }

    async addPoseRepository() {
        const input = this.librarySettingsEl?.querySelector('.vnccs-ps-library-repo-input');
        const repoId = input?.value.trim();
        if (!repoId) return;
        try {
            const res = await fetch('/vnccs/pose_library/repositories/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repo_id: repoId }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
            input.value = '';
            this.poseRepositories = data.repositories || [];
            this.renderPoseRepositorySettings();
        } catch (err) {
            this.showRepositoryNotice(`Failed to add repository: ${err?.message || err}`, true);
        }
    }

    createRepositoryTaskId(prefix = "repo") {
        return (
            globalThis.crypto?.randomUUID?.()
            || `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
        );
    }

    repositoryProgressMarkup() {
        return `
            <div class="vnccs-ps-library-repo-progress">
                <div class="vnccs-ps-library-repo-progress-head">
                    <span class="vnccs-ps-library-repo-progress-message"></span>
                    <span class="vnccs-ps-library-repo-progress-percent">0%</span>
                </div>
                <div class="vnccs-ps-library-repo-progress-track">
                    <div class="vnccs-ps-library-repo-progress-fill"></div>
                </div>
            </div>
        `;
    }

    findRepositoryProgressCard(key) {
        const cards = this.librarySettingsEl?.querySelectorAll('[data-repo-progress-key]') || [];
        return Array.from(cards).find((card) => card.dataset.repoProgressKey === key) || null;
    }

    setRepositoryProgressState(key, patch) {
        this.repositoryProgressStates[key] = {
            ...(this.repositoryProgressStates[key] || {}),
            ...patch,
        };
        this.updateRepositoryProgressUi(key);
    }

    updateRepositoryProgressUi(key) {
        const card = this.findRepositoryProgressCard(key);
        if (!card) return;
        const state = this.repositoryProgressStates[key];
        const progress = card.querySelector('.vnccs-ps-library-repo-progress');
        if (!progress || !state) {
            card.classList.remove('is-running');
            progress?.classList.remove('visible', 'error', 'success');
            return;
        }
        const percent = Math.max(0, Math.min(100, Number(state.progress) || 0));
        progress.classList.add('visible');
        progress.classList.toggle('error', state.status === 'error');
        progress.classList.toggle('success', state.status === 'success');
        card.classList.toggle('is-running', state.status === 'running');
        const messageEl = progress.querySelector('.vnccs-ps-library-repo-progress-message');
        const percentEl = progress.querySelector('.vnccs-ps-library-repo-progress-percent');
        const fillEl = progress.querySelector('.vnccs-ps-library-repo-progress-fill');
        if (messageEl) messageEl.textContent = state.message || "Working...";
        if (percentEl) percentEl.textContent = `${Math.round(percent)}%`;
        if (fillEl) fillEl.style.width = `${percent}%`;
    }

    createInlineRepositoryProgress(key, initialText = "Starting...") {
        const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        this.setRepositoryProgressState(key, {
            token,
            status: "running",
            message: initialText,
            progress: 1,
        });
        return {
            setText: (message) => this.setRepositoryProgressState(key, { message }),
            setProgress: (progress) => this.setRepositoryProgressState(key, { progress }),
            update: (status) => {
                if (!status) return;
                const patch = {};
                if (status.status) patch.status = status.status;
                if (status.message) patch.message = status.message;
                if (status.progress !== undefined) patch.progress = status.progress;
                this.setRepositoryProgressState(key, patch);
            },
            close: (delay = 1600) => {
                setTimeout(() => {
                    if (this.repositoryProgressStates[key]?.token !== token) return;
                    delete this.repositoryProgressStates[key];
                    this.updateRepositoryProgressUi(key);
                }, delay);
            },
        };
    }

    async pollRepositoryProgress(taskId, progress, titleText) {
        if (!taskId || !progress) return;
        try {
            const res = await fetch(`/vnccs/pose_library/repositories/progress/${encodeURIComponent(taskId)}`);
            if (!res.ok) return;
            const status = await res.json();
            if (status.current_file && status.file_index && status.total_files) {
                status.message = `${status.message || status.current_file} · file ${status.file_index}/${status.total_files}`;
            }
            progress.update(status);
            if (status.status === "success" || status.status === "error") {
                progress.setProgress(status.progress ?? 100);
            }
        } catch (_err) {
            // Progress polling is best-effort; the POST response remains authoritative.
        }
    }

    async togglePoseRepository(repoId, enabled) {
        const taskId = this.createRepositoryTaskId("repo-toggle");
        const progressKey = `repo:${repoId}`;
        const progress = this.createInlineRepositoryProgress(progressKey, `${enabled ? "Enabling" : "Disabling"} ${repoId}...`);
        let pollTimer = null;
        try {
            progress.setText(`${enabled ? "Enabling" : "Disabling"} ${repoId}...`);
            progress.setProgress(1);
            pollTimer = setInterval(() => this.pollRepositoryProgress(taskId, progress), 350);
            const res = await fetch('/vnccs/pose_library/repositories/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repo_id: repoId, enabled, task_id: taskId }),
            });
            await this.pollRepositoryProgress(taskId, progress);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                progress.update({ status: "error", progress: 100, message: data?.error || `Failed to update ${repoId}` });
                return;
            }
            this.poseRepositories = data.repositories || [];
            this.renderPoseRepositorySettings();
            progress.update({
                status: "success",
                progress: 100,
                message: `${repoId} ${enabled ? "enabled" : "disabled"}.`,
            });
            await this.refreshLibrary(true);
            if (enabled) {
                if (pollTimer) {
                    clearInterval(pollTimer);
                    pollTimer = null;
                }
                await this.refreshSinglePoseRepository(repoId);
            }
        } finally {
            if (pollTimer) clearInterval(pollTimer);
            progress.close();
        }
    }

    async refreshSinglePoseRepository(repoId) {
        const taskId = this.createRepositoryTaskId("repo-refresh");
        const progressKey = `repo:${repoId}`;
        const progress = this.createInlineRepositoryProgress(progressKey, `Checking ${repoId}...`);
        let pollTimer = null;
        try {
            progress.setText(`Checking ${repoId}...`);
            progress.setProgress(1);
            pollTimer = setInterval(() => this.pollRepositoryProgress(taskId, progress), 350);
            const res = await fetch('/vnccs/pose_library/repositories/refresh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repo_id: repoId, task_id: taskId }),
            });
            await this.pollRepositoryProgress(taskId, progress);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                progress.update({ status: "error", progress: 100, message: data?.error || `Failed to refresh ${repoId}` });
                return;
            }
            this.poseRepositories = data.repositories || [];
            this.renderPoseRepositorySettings();
            const refreshed = data.refreshed?.[0] || {};
            progress.update({
                status: refreshed.status === "error" ? "error" : "success",
                progress: 100,
                message: refreshed.status === "error"
                    ? `Error: ${refreshed.last_error || "refresh failed"}`
                    : `Repository sync complete: ${Number(refreshed.downloaded_count || 0)} downloaded, ${Number(refreshed.skipped_count || 0)} unchanged, ${Number(refreshed.removed_count || 0)} removed.`,
            });
            await this.refreshLibrary(true);
        } finally {
            if (pollTimer) clearInterval(pollTimer);
            progress.close();
        }
    }

    async removePoseRepository(repoId) {
        const res = await fetch(`/vnccs/pose_library/repositories/delete/${encodeURIComponent(repoId)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            this.showRepositoryNotice(data?.error || `Failed to remove ${repoId}`, true);
            return;
        }
        this.poseRepositories = data.repositories || [];
        this.renderPoseRepositorySettings();
        this.clearRepositoryNotice();
        this.showRepositoryNotice(`Removed ${repoId}. Deleted ${Number(data.removed_count || 0)} cached files.`);
        await this.refreshLibrary(true);
    }

    getLibraryPoseMeta(pose) {
        const dataMeta = pose?.data?._library || {};
        const category = (pose?.category || dataMeta.category || "Uncategorized").trim() || "Uncategorized";
        const tags = Array.isArray(pose?.tags) ? pose.tags : (Array.isArray(dataMeta.tags) ? dataMeta.tags : []);
        const repository = (pose?.repository || dataMeta.repository || "local_user_poses").trim() || "local_user_poses";
        return {
            repository,
            category,
            tags: tags.map(tag => String(tag).trim()).filter(Boolean),
        };
    }

    getLibraryPoseName(poseOrName) {
        return typeof poseOrName === 'string' ? poseOrName : (poseOrName?.name || "");
    }

    getLibraryPoseId(pose) {
        if (!pose) return "";
        const meta = this.getLibraryPoseMeta(pose);
        return pose.id || `${meta.repository}/${meta.category}/${pose.name}`;
    }

    getLibraryPoseQuery(poseOrName) {
        if (!poseOrName || typeof poseOrName === 'string') return "";
        const meta = this.getLibraryPoseMeta(poseOrName);
        const params = new URLSearchParams();
        params.set("repository", meta.repository);
        params.set("category", meta.category);
        return `?${params.toString()}`;
    }

    getLibraryPreviewUrl(pose) {
        if (!pose?.has_preview) return "";
        const meta = this.getLibraryPoseMeta(pose);
        const params = new URLSearchParams();
        params.set("repository", meta.repository);
        params.set("category", meta.category);
        if (pose.preview_mtime) params.set("v", String(pose.preview_mtime));
        return `/vnccs/pose_library/preview/${encodeURIComponent(pose.name)}?${params.toString()}`;
    }

    getFilteredLibraryPoses() {
        const poses = this.libraryPoses || [];
        const query = (this.librarySearchInput?.value || "").trim().toLowerCase();
        return poses.filter((pose) => {
            const meta = this.getLibraryPoseMeta(pose);
            if (this.libraryActiveCategory && this.libraryActiveCategory !== "All" && meta.category !== this.libraryActiveCategory) {
                return false;
            }
            if (!query) return true;
            const haystack = [
                pose.name,
                meta.repository,
                meta.category,
                ...meta.tags,
            ].join(" ").toLowerCase();
            return haystack.includes(query);
        });
    }

    renderLibraryCategories() {
        if (!this.libraryCategoriesEl) return;
        const categories = Array.from(new Set((this.libraryPoses || []).map((pose) => this.getLibraryPoseMeta(pose).category))).sort();
        const all = ["All", ...categories];
        if (!all.includes(this.libraryActiveCategory)) this.libraryActiveCategory = "All";
        this.libraryCategoriesEl.innerHTML = '';
        for (const category of all) {
            const btn = document.createElement('button');
            btn.className = 'vnccs-ps-library-category-chip';
            if (category === this.libraryActiveCategory) btn.classList.add('active');
            btn.textContent = category;
            btn.onclick = () => {
                this.libraryActiveCategory = category;
                this.renderLibrary();
            };
            this.libraryCategoriesEl.appendChild(btn);
        }
    }

    renderLibrary() {
        if (!this.libraryGrid) {
            this.libraryGrid = document.querySelector('.vnccs-ps-library-modal-grid');
        }
        if (!this.libraryGrid) return;

        this.renderLibraryCategories();
        this.libraryGrid.innerHTML = '';
        const filtered = this.getFilteredLibraryPoses();

        if ((this.libraryPoses || []).length === 0) {
            this.libraryGrid.innerHTML = '<div class="vnccs-ps-library-empty">No saved poses.<br>Use Save Current Pose to add one.</div>';
            this.renderLibraryInspector(null);
            return;
        }
        if (filtered.length === 0) {
            this.libraryGrid.innerHTML = '<div class="vnccs-ps-library-empty">No poses match this search.</div>';
            this.renderLibraryInspector(null);
            return;
        }

        if (this.librarySelectedName && !filtered.some(pose => this.getLibraryPoseId(pose) === this.librarySelectedName)) {
            this.librarySelectedName = null;
        }

        for (const pose of filtered) {
            const item = document.createElement('div');
            item.className = 'vnccs-ps-library-item';
            item.dataset.poseId = this.getLibraryPoseId(pose);
            if (this.getLibraryPoseId(pose) === this.librarySelectedName) item.classList.add('selected');

            const preview = document.createElement('div');
            preview.className = 'vnccs-ps-library-item-preview';
            if (pose.has_preview) {
                preview.innerHTML = `<img src="${this.getLibraryPreviewUrl(pose)}" alt="${pose.name}">`;
            } else {
                preview.innerHTML = '<span>🦴</span>';
            }

            const name = document.createElement('div');
            name.className = 'vnccs-ps-library-item-name';
            name.innerText = pose.name;

            item.onclick = () => this.selectLibraryPose(pose);

            item.appendChild(preview);
            item.appendChild(name);
            this.libraryGrid.appendChild(item);
        }

        const selected = (this.libraryPoses || []).find(pose => this.getLibraryPoseId(pose) === this.librarySelectedName) || null;
        this.renderLibraryInspector(selected);
    }

    selectLibraryPose(pose) {
        this.librarySelectedName = this.getLibraryPoseId(pose);
        this.libraryGrid?.querySelectorAll('.vnccs-ps-library-item').forEach((item) => {
            item.classList.toggle('selected', item.dataset.poseId === this.librarySelectedName);
        });
        this.renderLibraryInspector(pose);
    }

    renderLibraryInspector(pose) {
        if (!this.libraryInspector) return;
        if (!pose) {
            this.libraryInspector.classList.remove('visible');
            if (this.libraryWorkspace) this.libraryWorkspace.classList.remove('has-inspector');
            this.libraryInspector.innerHTML = '<div class="vnccs-ps-library-inspector-empty">Select a pose to preview and edit it.</div>';
            this.updateLibraryInspectorScale();
            return;
        }
        this.libraryInspector.classList.add('visible');
        if (this.libraryWorkspace) this.libraryWorkspace.classList.add('has-inspector');
        const meta = this.getLibraryPoseMeta(pose);
        const previewSrc = this.getLibraryPreviewUrl(pose);
        this.libraryInspector.innerHTML = `
            <div class="vnccs-ps-library-inspector-inner">
                <div class="vnccs-ps-library-inspector-preview">
                    ${previewSrc ? `<img src="${previewSrc}" alt="${pose.name}">` : '<span>🦴</span>'}
                </div>
                <div class="vnccs-ps-library-inspector-actions">
                    <button class="vnccs-ps-btn primary vnccs-ps-library-apply">Apply Pose</button>
                    <button class="vnccs-ps-btn danger vnccs-ps-library-delete">Delete</button>
                </div>
                <label class="vnccs-ps-library-field">
                    <span>Name</span>
                    <input class="vnccs-ps-input vnccs-ps-library-edit-name" type="text" value="${this.escapeHtml(pose.name)}">
                </label>
                <label class="vnccs-ps-library-field">
                    <span>Category</span>
                    <input class="vnccs-ps-input vnccs-ps-library-edit-category" type="text" value="${this.escapeHtml(meta.category)}">
                </label>
                <label class="vnccs-ps-library-field">
                    <span>Repository</span>
                    <input class="vnccs-ps-input" type="text" value="${this.escapeHtml(meta.repository)}" disabled>
                </label>
                <label class="vnccs-ps-library-field">
                    <span>Tags</span>
                    <input class="vnccs-ps-input vnccs-ps-library-edit-tags" type="text" value="${this.escapeHtml(meta.tags.join(', '))}" placeholder="standing, hands, portrait">
                </label>
                <label class="vnccs-ps-library-field">
                    <span>Prompt</span>
                    <textarea class="vnccs-ps-textarea vnccs-ps-library-edit-prompt" placeholder="Pose prompt..." style="width:100%;min-height:60px;resize:vertical;">${this.escapeHtml(pose.data?.prompt ?? "")}</textarea>
                </label>
                <label class="vnccs-ps-library-field">
                    <span>Custom Image</span>
                    <input class="vnccs-ps-library-image-input" type="file" accept="image/*">
                </label>
                <button class="vnccs-ps-btn primary vnccs-ps-library-save-edit">Save Changes</button>
            </div>
        `;
        requestAnimationFrame(() => this.updateLibraryInspectorScale());

        let pendingPreview = null;
        const previewBox = this.libraryInspector.querySelector('.vnccs-ps-library-inspector-preview');
        this.libraryInspector.querySelector('.vnccs-ps-library-apply').onclick = async () => {
            await this.loadFromLibrary(pose);
            this.libraryInspector.closest('.vnccs-ps-modal-overlay')?.remove();
        };
        this.libraryInspector.querySelector('.vnccs-ps-library-delete').onclick = () => this.showDeleteConfirmModal(pose);
        this.libraryInspector.querySelector('.vnccs-ps-library-image-input').onchange = async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            pendingPreview = await this.compressLibraryImage(file);
            previewBox.innerHTML = `<img src="${pendingPreview}" alt="${pose.name}">`;
        };
        this.libraryInspector.querySelector('.vnccs-ps-library-save-edit').onclick = async () => {
            const newName = this.libraryInspector.querySelector('.vnccs-ps-library-edit-name').value.trim();
            const category = this.libraryInspector.querySelector('.vnccs-ps-library-edit-category').value.trim() || "Uncategorized";
            const tags = this.libraryInspector.querySelector('.vnccs-ps-library-edit-tags').value
                .split(',')
                .map(tag => tag.trim())
                .filter(Boolean);
            if (!newName) {
                this.showMessage("Pose name is required.", true);
                return;
            }
            const posePromptValue = this.libraryInspector.querySelector('.vnccs-ps-library-edit-prompt').value;
            const updatedPoseData = Object.assign({}, pose.data || {}, { prompt: posePromptValue });
            const result = await this.saveLibraryPoseRecord({
                oldName: pose.name,
                oldRepository: meta.repository,
                oldCategory: meta.category,
                name: newName,
                pose: updatedPoseData,
                repository: meta.repository,
                category,
                tags,
                preview: pendingPreview,
            });
            this.librarySelectedName = result.id || `${meta.repository}/${category}/${newName}`;
            await this.refreshLibrary(true);
        };
    }

    escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    compressLibraryImage(fileOrDataUrl) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const maxSide = 768;
                const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(img.width * scale));
                canvas.height = Math.max(1, Math.round(img.height * scale));
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                let dataUrl;
                try {
                    dataUrl = canvas.toDataURL('image/webp', 0.76);
                } catch (_err) {
                    dataUrl = canvas.toDataURL('image/jpeg', 0.78);
                }
                if (!dataUrl || dataUrl === 'data:,') dataUrl = canvas.toDataURL('image/jpeg', 0.78);
                resolve(dataUrl);
            };
            img.onerror = reject;
            if (typeof fileOrDataUrl === 'string') {
                img.src = fileOrDataUrl;
            } else {
                const reader = new FileReader();
                reader.onload = () => { img.src = reader.result; };
                reader.onerror = reject;
                reader.readAsDataURL(fileOrDataUrl);
            }
        });
    }

    showSaveToLibraryModal() {
        const overlay = document.createElement('div');
        overlay.className = 'vnccs-ps-modal-overlay';

        const currentPrompt = this.getPosePrompt(this.activeTab);

        const modal = document.createElement('div');
        modal.className = 'vnccs-ps-modal vnccs-ps-save-library-modal';
        modal.innerHTML = `
            <div class="vnccs-ps-modal-title">Save to Library</div>
            <div class="vnccs-ps-modal-content">
                <input type="text" placeholder="Pose name..." class="vnccs-ps-input">
                <input type="text" placeholder="Category..." class="vnccs-ps-input" value="Uncategorized">
                <input type="text" placeholder="Tags, comma separated..." class="vnccs-ps-input">
                <label class="vnccs-ps-save-library-label">Prompt</label>
                <textarea class="vnccs-ps-textarea vnccs-ps-save-prompt" placeholder="Pose prompt...">${this.escapeHtml(currentPrompt)}</textarea>
                <label class="vnccs-ps-save-library-check">
                    <input type="checkbox" checked> Include preview image
                </label>
            </div>
            <button class="vnccs-ps-modal-btn primary">💾 Save</button>
            <button class="vnccs-ps-modal-btn cancel">Cancel</button>
        `;

        const textInputs = modal.querySelectorAll('input[type="text"]');
        const nameInput = textInputs[0];
        const categoryInput = textInputs[1];
        const tagsInput = textInputs[2];
        const promptInput = modal.querySelector('.vnccs-ps-save-prompt');
        const previewCheck = modal.querySelector('input[type="checkbox"]');

        modal.querySelector('.vnccs-ps-modal-btn.primary').onclick = async () => {
            const name = nameInput.value.trim();
            if (name) {
                await this.saveToLibrary(name, previewCheck.checked, {
                    category: categoryInput.value.trim() || "Uncategorized",
                    tags: tagsInput.value.split(',').map(tag => tag.trim()).filter(Boolean),
                    prompt: promptInput.value,
                });
                overlay.remove();
            }
        };

        modal.querySelector('.vnccs-ps-modal-btn.cancel').onclick = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

        overlay.appendChild(modal);
        this.container.appendChild(overlay);
        nameInput.focus();
    }

    async saveLibraryPoseRecord({ oldName = "", oldRepository = "", oldCategory = "", name, pose, repository = "local_user_poses", category = "Uncategorized", tags = [], preview = null }) {
        const response = await fetch('/vnccs/pose_library/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                old_name: oldName,
                old_repository: oldRepository,
                old_category: oldCategory,
                name,
                pose,
                repository,
                preview,
                category,
                tags,
            })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(result?.error || `HTTP ${response.status}`);
        }
        return result;
    }

    async saveToLibrary(name, includePreview = true, metadata = {}) {
        if (!this.viewer) return;

        const pose = this.viewer.getPose();
        if (this._samCameraModeActive) {
            delete pose.cameraParams;
        } else {
            pose.cameraParams = this.currentCameraParams();
        }
        pose.prompt = metadata.prompt ?? this.getPosePrompt(this.activeTab);
        let preview = null;

        if (includePreview) {
            preview = this.viewer.capture(
                this.exportParams.view_width,
                this.exportParams.view_height,
                this.exportParams.cam_zoom || 1.0,
                this.exportParams.bg_color || [40, 40, 40],
                this.exportParams.cam_offset_x || 0,
                this.exportParams.cam_offset_y || 0,
                this.exportParams.cam_yaw_deg || 0,
                this.exportParams.cam_pitch_deg || 0
            );
            preview = await this.compressLibraryImage(preview);
        }

        try {
            const result = await this.saveLibraryPoseRecord({
                name,
                pose,
                preview,
                repository: "local_user_poses",
                category: metadata.category || "Uncategorized",
                tags: metadata.tags || [],
            });
            this.librarySelectedName = result.id || `local_user_poses/${metadata.category || "Uncategorized"}/${name}`;
            this.refreshLibrary(true);
        } catch (err) {
            console.error("Failed to save pose:", err);
            this.showMessage(`Failed to save pose: ${err?.message || err}`, true);
        }
    }

    restorePoseCameraParams(pose) {
        const params = pose?.cameraParams;
        if (!params) return false;

        this.exportParams.cam_offset_x = Number(params.offset_x ?? 0);
        this.exportParams.cam_offset_y = Number(params.offset_y ?? 0);
        this.exportParams.cam_zoom = Number(params.zoom ?? 1.0);
        this.exportParams.cam_yaw_deg = Number(params.yaw_deg ?? 0);
        this.exportParams.cam_pitch_deg = Number(params.pitch_deg ?? 0);
        this.syncCameraWidgets();
        this.applyCameraToViewer(true);
        this.viewer?.setCameraParams?.(this.currentCameraParams());
        return true;
    }

    async loadFromLibrary(poseOrName) {
        const name = this.getLibraryPoseName(poseOrName);
        try {
            this.clearSAMCameraMode();
            const res = await fetch(`/vnccs/pose_library/get/${encodeURIComponent(name)}${this.getLibraryPoseQuery(poseOrName)}`);
            const data = await res.json();

            if (data.pose && this.viewer) {
                this.viewer.setPose(data.pose, false);
                this.restorePoseCameraParams(data.pose);
                this.poses[this.activeTab] = this.viewer.getPose();
                this.setPosePrompt(this.activeTab, data.pose.prompt ?? "");
                this.syncPromptFieldToActiveTab();
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

        const interfaceHeader = document.createElement("div");
        interfaceHeader.className = "vnccs-ps-settings-title";
        interfaceHeader.style.padding = "4px 0 10px";
        interfaceHeader.innerText = "Interface";
        content.appendChild(interfaceHeader);

        const interfaceRow = document.createElement("div");
        interfaceRow.className = "vnccs-ps-field";
        interfaceRow.style.marginBottom = "14px";

        const interfaceToggle = document.createElement("div");
        interfaceToggle.className = "vnccs-ps-toggle";
        interfaceToggle.style.width = "100%";

        const studioBtn = document.createElement("button");
        studioBtn.className = "vnccs-ps-toggle-btn";
        studioBtn.type = "button";
        studioBtn.innerText = "PoseStudio";
        studioBtn.style.flex = "1";

        const managerBtn = document.createElement("button");
        managerBtn.className = "vnccs-ps-toggle-btn";
        managerBtn.type = "button";
        managerBtn.innerText = "Pose Manager";
        managerBtn.style.flex = "1";

        const updateInterfaceUI = () => {
            const isManager = this.exportParams.interface_mode === "manager" || this.interfaceMode !== "studio";
            studioBtn.classList.toggle("active", !isManager);
            managerBtn.classList.toggle("active", isManager);
        };

        studioBtn.onclick = () => {
            this.setInterfaceMode("studio");
            updateInterfaceUI();
            panel.remove();
        };
        managerBtn.onclick = () => {
            this.setInterfaceMode("manager");
            updateInterfaceUI();
            panel.remove();
        };

        updateInterfaceUI();
        interfaceToggle.appendChild(studioBtn);
        interfaceToggle.appendChild(managerBtn);
        interfaceRow.appendChild(interfaceToggle);
        content.appendChild(interfaceRow);

        const debugSection = this.createSection("Debug", false);

        // SAM Camera Override Toggle
        const samCamRow = document.createElement("div");
        samCamRow.className = "vnccs-ps-field";

        const samCamLabel = document.createElement("label");
        samCamLabel.style.display = "flex";
        samCamLabel.style.alignItems = "center";
        samCamLabel.style.gap = "10px";
        samCamLabel.style.cursor = "pointer";

        const samCamCheckbox = document.createElement("input");
        samCamCheckbox.type = "checkbox";
        samCamCheckbox.checked = !!this.exportParams.samApplyCamera;
        samCamCheckbox.onchange = () => {
            this.exportParams.samApplyCamera = samCamCheckbox.checked;
            this._updateSAMCameraBanner();
            this.syncToNode(false);
        };

        const samCamText = document.createElement("div");
        samCamText.innerHTML = "<strong>SAM Import: Apply Camera Angle</strong><div style='font-size:11px; color:#888; margin-top:4px;'>When enabled, importing a SAM3D pose will override the camera yaw/pitch to match the detected angle. Disable to keep your current camera settings after import.</div>";

        samCamLabel.appendChild(samCamCheckbox);
        samCamLabel.appendChild(samCamText);
        samCamRow.appendChild(samCamLabel);
        content.appendChild(samCamRow);

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
            // If debug mode (randomization) is enabled, we need to load full library data
            if (this.exportParams.debugMode) {
                this.refreshLibrary(true);
            }
            this.syncToNode(false);
        };

        const debugText = document.createElement("div");
        debugText.innerHTML = "<strong>Debug Mode (Randomize on Queue)</strong><div style='font-size:11px; color:#888; margin-top:4px;'>Automatically randomizes pose, lighting and camera for each queued run. Used for generating synthetic datasets.</div>";

        debugLabel.appendChild(debugCheckbox);
        debugLabel.appendChild(debugText);
        debugRow.appendChild(debugLabel);
        debugSection.content.appendChild(debugRow);

        // Portrait Mode Toggle
        const portraitRow = document.createElement("div");
        portraitRow.className = "vnccs-ps-field";
        portraitRow.style.marginTop = "10px";

        const portraitLabel = document.createElement("label");
        portraitLabel.style.display = "flex";
        portraitLabel.style.alignItems = "center";
        portraitLabel.style.gap = "10px";
        portraitLabel.style.cursor = "pointer";

        const portraitCheckbox = document.createElement("input");
        portraitCheckbox.type = "checkbox";
        portraitCheckbox.checked = this.exportParams.debugPortraitMode || false;
        portraitCheckbox.onchange = () => {
            this.exportParams.debugPortraitMode = portraitCheckbox.checked;
            this.syncToNode(false);
        };

        const portraitText = document.createElement("div");
        portraitText.innerHTML = "<strong>Portrait Mode</strong><div style='font-size:11px; color:#888; margin-top:4px;'>If enabled, Debug Mode will focus framing on the head and upper torso.</div>";

        portraitLabel.appendChild(portraitCheckbox);
        portraitLabel.appendChild(portraitText);
        portraitRow.appendChild(portraitLabel);
        debugSection.content.appendChild(portraitRow);

        // Keep Lighting Toggle
        const keepLightRow = document.createElement("div");
        keepLightRow.className = "vnccs-ps-field";
        keepLightRow.style.marginTop = "10px";

        const keepLightLabel = document.createElement("label");
        keepLightLabel.style.display = "flex";
        keepLightLabel.style.alignItems = "center";
        keepLightLabel.style.gap = "10px";
        keepLightLabel.style.cursor = "pointer";

        const keepLightCheckbox = document.createElement("input");
        keepLightCheckbox.type = "checkbox";
        keepLightCheckbox.checked = this.exportParams.debugKeepLighting || false;
        keepLightCheckbox.onchange = () => {
            this.exportParams.debugKeepLighting = keepLightCheckbox.checked;
            this.syncToNode(false);
        };

        const keepLightText = document.createElement("div");
        keepLightText.innerHTML = "<strong>Keep Manual Lighting</strong><div style='font-size:11px; color:#888; margin-top:4px;'>If enabled, Debug Mode will use your current lighting settings instead of randomizing them.</div>";

        keepLightLabel.appendChild(keepLightCheckbox);
        keepLightLabel.appendChild(keepLightText);
        keepLightRow.appendChild(keepLightLabel);
        debugSection.content.appendChild(keepLightRow);

        // SAM Helper Skeleton Toggle
        const samHelperRow = document.createElement("div");
        samHelperRow.className = "vnccs-ps-field";
        samHelperRow.style.marginTop = "10px";

        const samHelperLabel = document.createElement("label");
        samHelperLabel.style.display = "flex";
        samHelperLabel.style.alignItems = "center";
        samHelperLabel.style.gap = "10px";
        samHelperLabel.style.cursor = "pointer";

        const samHelperCheckbox = document.createElement("input");
        samHelperCheckbox.type = "checkbox";
        samHelperCheckbox.checked = this.exportParams.debugShowSAMHelper !== false;
        samHelperCheckbox.onchange = () => {
            this.exportParams.debugShowSAMHelper = samHelperCheckbox.checked;
            if (this.viewer?.setKpFigureVisible) {
                this.viewer.setKpFigureVisible(samHelperCheckbox.checked);
            }
            if (samHelperCheckbox.checked) {
                this.refreshSAMMeshOverlay();
            }
            this.syncToNode(false);
        };

        const samHelperText = document.createElement("div");
        samHelperText.innerHTML = "<strong>Show SAM Helper Skeleton</strong><div style='font-size:11px; color:#888; margin-top:4px;'>Displays the imported SAM3D reference skeleton in the viewer for alignment debugging. It is hidden during final capture.</div>";

        samHelperLabel.appendChild(samHelperCheckbox);
        samHelperLabel.appendChild(samHelperText);
        samHelperRow.appendChild(samHelperLabel);
        debugSection.content.appendChild(samHelperRow);

        const samMeshRow = document.createElement("div");
        samMeshRow.className = "vnccs-ps-field";
        samMeshRow.style.marginTop = "10px";

        const samMeshLabel = document.createElement("label");
        samMeshLabel.style.display = "flex";
        samMeshLabel.style.alignItems = "center";
        samMeshLabel.style.gap = "10px";
        samMeshLabel.style.cursor = "pointer";

        const samMeshCheckbox = document.createElement("input");
        samMeshCheckbox.type = "checkbox";
        samMeshCheckbox.checked = !!this.exportParams.debugShowSAMMeshOverlay;
        samMeshCheckbox.onchange = () => {
            this.exportParams.debugShowSAMMeshOverlay = samMeshCheckbox.checked;
            if (this.viewer?.setSAMMeshOverlayVisible) {
                this.viewer.setSAMMeshOverlayVisible(samMeshCheckbox.checked);
            }
            if (samMeshCheckbox.checked) {
                this.refreshSAMMeshOverlay();
            }
            this.syncToNode(false);
        };

        const samMeshText = document.createElement("div");
        samMeshText.innerHTML = "<strong>Show SAM Render Mesh Overlay</strong><div style='font-size:11px; color:#888; margin-top:4px;'>Displays the postprocessed SAM3D Body render mesh as a translucent overlay for direct skeleton/model comparison. It is hidden during final capture.</div>";

        samMeshLabel.appendChild(samMeshCheckbox);
        samMeshLabel.appendChild(samMeshText);
        samMeshRow.appendChild(samMeshLabel);
        debugSection.content.appendChild(samMeshRow);
        content.appendChild(debugSection.el);

        // Skin Texture Section
        const skinHeader = document.createElement("div");
        skinHeader.className = "vnccs-ps-settings-title";
        skinHeader.style.marginTop = "20px";
        skinHeader.style.padding = "10px 0";
        skinHeader.style.borderTop = "1px solid var(--ps-border)";
        skinHeader.innerText = "Skin";
        content.appendChild(skinHeader);

        const skinRow = document.createElement("div");
        skinRow.className = "vnccs-ps-field";
        skinRow.style.marginTop = "5px";

        const skinToggle = document.createElement("div");
        skinToggle.className = "vnccs-ps-toggle";
        skinToggle.style.width = "100%";

        const skinOptions = [
            { key: "dummy_white", label: "Dummy White" },
            { key: "naked", label: "Naked" },
            { key: "naked_marks", label: "Marked" }
        ];

        const skinButtons = {};
        const updateSkinUI = () => {
            const current = this.exportParams.skin_type || "naked";
            for (const opt of skinOptions) {
                skinButtons[opt.key].classList.toggle("active", current === opt.key);
            }
        };

        for (const opt of skinOptions) {
            const btn = document.createElement("button");
            btn.className = "vnccs-ps-toggle-btn";
            btn.innerText = opt.label;
            btn.style.flex = "1";
            btn.onclick = () => {
                this.exportParams.skin_type = opt.key;
                updateSkinUI();
                if (this.viewer && this.viewer.isInitialized()) {
                    this.viewer.setSkinMode(opt.key);
                }
                this.syncToNode(false);
            };
            skinButtons[opt.key] = btn;
            skinToggle.appendChild(btn);
        }

        updateSkinUI();
        skinRow.appendChild(skinToggle);
        content.appendChild(skinRow);

        // Prompt Templates Section
        const templateHeader = document.createElement("div");
        templateHeader.className = "vnccs-ps-settings-title";
        templateHeader.style.marginTop = "20px";
        templateHeader.style.padding = "10px 0";
        templateHeader.style.borderTop = "1px solid var(--ps-border)";
        templateHeader.innerText = "Prompt Templates";
        content.appendChild(templateHeader);

        const createTemplateField = (label, key) => {
            const field = document.createElement("div");
            field.className = "vnccs-ps-field";
            field.style.flexDirection = "column";
            field.style.alignItems = "stretch";

            const l = document.createElement("div");
            l.className = "vnccs-ps-label";
            l.innerText = label;
            l.style.marginBottom = "5px";

            const area = document.createElement("textarea");
            area.style.width = "100%";
            area.style.height = "60px";
            area.style.background = "var(--ps-input-bg)";
            area.style.color = "var(--ps-text)";
            area.style.border = "1px solid var(--ps-border)";
            area.style.borderRadius = "4px";
            area.style.padding = "8px";
            area.style.fontSize = "12px";
            area.style.resize = "vertical";
            area.style.fontFamily = "monospace";
            area.value = this.exportParams[key] || "";

            area.onchange = () => {
                this.exportParams[key] = area.value;
                this.syncToNode(false);
            };

            field.appendChild(l);
            field.appendChild(area);
            return field;
        };

        content.appendChild(createTemplateField("Prompt Template", "prompt_template"));

        // Donation Section
        const donationSection = document.createElement("div");
        donationSection.style.marginTop = "30px";
        donationSection.style.paddingTop = "20px";
        donationSection.style.borderTop = "1px solid var(--ps-border)";
        donationSection.style.textAlign = "center";
        donationSection.innerHTML = `
            <div style="font-size: 11px; color: var(--ps-text); margin-bottom: 20px; line-height: 1.6; font-weight: bold; padding: 0 10px;">
                If you find my project useful, please consider supporting it! I work on it completely on my own, and your support will allow me to continue maintaining it and adding even more cool features!
            </div>
            <a href="https://www.buymeacoffee.com/MIUProject" target="_blank" style="display: inline-block; transition: transform 0.2s;" 
               onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">
                <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important; width: 217px !important; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.3);" >
            </a>
        `;
        content.appendChild(donationSection);

        panel.appendChild(header);
        panel.appendChild(content);

        this.canvasContainer.appendChild(panel);
    }

    showMessage(text, isError = false) {
        const overlay = document.createElement('div');
        overlay.className = 'vnccs-ps-modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'vnccs-ps-modal';
        modal.style.maxWidth = "300px";

        const title = document.createElement('div');
        title.className = 'vnccs-ps-modal-title';
        title.textContent = isError ? '⚠️ Error' : 'ℹ️ Information';

        const content = document.createElement('div');
        content.className = 'vnccs-ps-modal-content';
        content.style.textAlign = 'center';
        content.textContent = text;

        const okBtn = document.createElement('button');
        okBtn.className = 'vnccs-ps-modal-btn';
        okBtn.style.justifyContent = 'center';
        okBtn.textContent = 'OK';
        okBtn.onclick = () => overlay.remove();

        modal.appendChild(title);
        modal.appendChild(content);
        modal.appendChild(okBtn);
        overlay.appendChild(modal);

        this.canvasContainer.appendChild(overlay);
    }

    showDeleteConfirmModal(poseOrName) {
        const poseName = this.getLibraryPoseName(poseOrName);
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
            this.deleteFromLibrary(poseOrName);
            overlay.remove();
        };

        cancelBtn.onclick = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

        overlay.appendChild(modal);
        this.container.appendChild(overlay);
    }

    async deleteFromLibrary(poseOrName) {
        const name = this.getLibraryPoseName(poseOrName);
        try {
            await fetch(`/vnccs/pose_library/delete/${encodeURIComponent(name)}${this.getLibraryPoseQuery(poseOrName)}`, { method: 'DELETE' });
            if (typeof poseOrName === 'string' && this.librarySelectedName === name) this.librarySelectedName = null;
            if (typeof poseOrName !== 'string' && this.librarySelectedName === this.getLibraryPoseId(poseOrName)) this.librarySelectedName = null;
            this.refreshLibrary(true);
        } catch (err) {
            console.error("Failed to delete pose:", err);
        }
    }

    loadModel(showOverlay = true, recenterViewport = true) {
        if (showOverlay && this.loadingOverlay) this.loadingOverlay.style.display = "flex";

        // Sync skin type to viewer before loading
        if (this.viewer) {
            this.viewer.setSkinMode(this.exportParams.skin_type || "naked");
        }

        return api.fetchApi("/vnccs/character_studio/update_preview", {
            method: "POST",
            body: JSON.stringify(this.meshParams)
        }).then(r => r.json()).then(d => {
            if (this.viewer) {
                // Reload mesh data without implicit camera math; if we need a reset,
                // do the same explicit snap the Preview button uses.
                this.viewer.loadData(d, true);

                // Apply lighting configuration
                this.viewer.updateLights(this.lightParams);

                this.updateCaptureCameraPreview();

                // Strip absolute position data (hip, IK effectors, pole targets) from ALL poses
                // since those were saved for the old mesh geometry and don't apply to the new one.
                for (let i = 0; i < this.poses.length; i++) {
                    if (this.poses[i]) {
                        delete this.poses[i].hipBonePosition;
                        delete this.poses[i].ikEffectorPositions;
                        delete this.poses[i].poleTargetPositions;
                    }
                }

                // Apply pose immediately (no timeout/flicker)
                if (this.viewer.isInitialized()) {
                    this.viewer.setPose(this.poses[this.activeTab] || {}, true);
                    this.updateRotationSliders();

                    if (recenterViewport) {
                        this.applyCameraToViewer(true);
                    }

                    // Full recapture needed because mesh changed
                    this.syncToNode(true);
                }
            }
        }).finally(() => {
            if (this.loadingOverlay) this.loadingOverlay.style.display = "none";
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

        const isOverridden = this.exportParams.keepOriginalLighting;
        this.lightListContainer.style.opacity = isOverridden ? "0.3" : "1.0";
        this.lightListContainer.style.pointerEvents = isOverridden ? "none" : "auto";
        this.lightListContainer.title = isOverridden ? "Lighting is overridden by 'Keep Original Lighting' mode" : "";

        this.lightParams.forEach((light, index) => {
            const item = document.createElement('div');
            item.className = 'vnccs-ps-light-card';

            // --- Header ---
            const header = document.createElement('div');
            header.className = 'vnccs-ps-light-header';

            const title = document.createElement('span');
            title.className = 'vnccs-ps-light-title';

            // Icon
            let iconChar = '💡';
            if (light.type === 'directional') iconChar = '☀️';
            else if (light.type === 'ambient') iconChar = '☁️';

            title.innerHTML = `<span class="vnccs-ps-light-icon">${iconChar}</span> Light ${index + 1}`;

            const removeBtn = document.createElement('button');
            removeBtn.className = 'vnccs-ps-light-remove';
            removeBtn.innerHTML = '×';
            removeBtn.title = "Remove Light";
            removeBtn.onclick = (e) => {
                e.stopPropagation();
                this.lightParams.splice(index, 1);
                this.refreshLightUI();
                this.applyLighting();
            };

            header.appendChild(title);
            header.appendChild(removeBtn);
            item.appendChild(header);

            // --- Body ---
            const body = document.createElement('div');
            body.className = 'vnccs-ps-light-body';

            // Grid 1: Type & Color
            const grid1 = document.createElement('div');
            grid1.className = 'vnccs-ps-light-grid';

            // Type
            const typeSelect = document.createElement('select');
            typeSelect.className = 'vnccs-ps-light-select';
            ['ambient', 'directional', 'point'].forEach(t => {
                const opt = document.createElement('option');
                opt.value = t;
                opt.textContent = t.charAt(0).toUpperCase() + t.slice(1);
                if (t === light.type) opt.selected = true;
                typeSelect.appendChild(opt);
            });
            typeSelect.onchange = () => {
                light.type = typeSelect.value;
                this.refreshLightUI();
                this.applyLighting();
            };
            grid1.appendChild(typeSelect);

            // Color
            const colorInput = document.createElement('input');
            colorInput.type = 'color';
            colorInput.className = 'vnccs-ps-light-color';
            colorInput.value = light.color || '#ffffff';
            colorInput.oninput = (e) => {
                light.color = colorInput.value;
                clearTimeout(this.colorTimeout);
                this.colorTimeout = setTimeout(() => this.applyLighting(), 50);
            };
            grid1.appendChild(colorInput);
            body.appendChild(grid1);

            // Intensity
            const intensityRow = document.createElement('div');
            intensityRow.className = 'vnccs-ps-light-slider-row';

            const intLabel = document.createElement('span');
            intLabel.className = 'vnccs-ps-light-pos-label';
            intLabel.innerText = "Int";

            const isAmbient = light.type === 'ambient';
            const intSlider = document.createElement('input');
            intSlider.type = 'range';
            intSlider.className = 'vnccs-ps-light-slider';
            intSlider.min = 0;
            intSlider.max = isAmbient ? 2 : 5;
            intSlider.step = isAmbient ? 0.01 : 0.1;
            intSlider.value = light.intensity ?? (isAmbient ? 0.5 : 1);

            const intValue = document.createElement('span');
            intValue.className = 'vnccs-ps-light-value';
            intValue.innerText = parseFloat(intSlider.value).toFixed(2);

            intSlider.oninput = () => {
                light.intensity = parseFloat(intSlider.value);
                intValue.innerText = light.intensity.toFixed(2);
                this.applyLighting();
            };

            intensityRow.appendChild(intLabel);
            intensityRow.appendChild(intSlider);
            intensityRow.appendChild(intValue);
            body.appendChild(intensityRow);

            // Radius Slider (Point Light Only)
            if (light.type === 'point') {
                const radiusRow = document.createElement('div');
                radiusRow.className = 'vnccs-ps-light-slider-row';

                const radLabel = document.createElement('span');
                radLabel.className = 'vnccs-ps-light-pos-label';
                radLabel.innerText = "Rad";

                const radSlider = document.createElement('input');
                radSlider.type = 'range';
                radSlider.className = 'vnccs-ps-light-slider';
                radSlider.min = 5; radSlider.max = 300; radSlider.step = 1;
                radSlider.value = light.radius ?? 100;

                const radValue = document.createElement('span');
                radValue.className = 'vnccs-ps-light-value';
                radValue.innerText = radSlider.value;

                radSlider.oninput = () => {
                    light.radius = parseFloat(radSlider.value);
                    radValue.innerText = radSlider.value;
                    this.applyLighting();
                };

                radiusRow.appendChild(radLabel);
                radiusRow.appendChild(radSlider);
                radiusRow.appendChild(radValue);
                body.appendChild(radiusRow);
            }

            // Position Controls (if not Ambient)
            if (light.type !== 'ambient') {
                const radarWrap = document.createElement('div');
                radarWrap.className = 'vnccs-ps-light-radar-wrap';

                const radarMain = document.createElement('div');
                radarMain.className = 'vnccs-ps-light-radar-main';

                // Radar (X and Z - Top Down)
                const radar = this.createLightRadar(light);
                radarMain.appendChild(radar);

                // Height Slider (Y) - Vertical
                const hVertWrap = document.createElement('div');
                hVertWrap.className = 'vnccs-ps-light-slider-vert-wrap';

                const hLabel = document.createElement('span');
                hLabel.className = 'vnccs-ps-light-h-label';
                hLabel.innerText = "Y-HGT";

                const hVal = document.createElement('span');
                hVal.className = 'vnccs-ps-light-h-val';
                hVal.innerText = light.y || 0;

                const hSlider = document.createElement('input');
                hSlider.type = 'range';
                hSlider.className = 'vnccs-ps-light-slider-vert';
                hSlider.setAttribute('orient', 'vertical'); // Firefox support
                const isPoint = light.type === 'point';
                hSlider.min = isPoint ? -10 : -100;
                hSlider.max = isPoint ? 10 : 100;
                hSlider.step = isPoint ? 0.1 : 1;
                hSlider.value = light.y || 0;

                hSlider.oninput = () => {
                    light.y = parseFloat(hSlider.value);
                    hVal.innerText = hSlider.value;
                    this.applyLighting();
                };

                hVertWrap.appendChild(hVal);
                hVertWrap.appendChild(hSlider);
                hVertWrap.appendChild(hLabel);

                radarMain.appendChild(hVertWrap);
                radarWrap.appendChild(radarMain);
                body.appendChild(radarWrap);
            }

            item.appendChild(body);
            this.lightListContainer.appendChild(item);
        });

        // Add Light Button (Big)
        const addBtn = document.createElement('button');
        addBtn.className = 'vnccs-ps-btn-add-large';
        addBtn.innerHTML = '+ Add Light Source';
        addBtn.disabled = isOverridden;
        if (isOverridden) {
            addBtn.style.opacity = "0.5";
            addBtn.style.cursor = "not-allowed";
        }
        addBtn.onclick = () => {
            this.lightParams.push({
                type: 'directional',
                color: '#ffffff',
                intensity: 1.0,
                x: 0, y: 0, z: 5
            });
            this.refreshLightUI();
            this.applyLighting();
        };
        this.lightListContainer.appendChild(addBtn);
    }

    applyLighting() {
        if (this.viewer && this.viewer.isInitialized()) {
            if (this.exportParams.keepOriginalLighting) {
                // Override: Clean white render with 1.0 ambient only
                this.viewer.updateLights([{ type: 'ambient', color: '#ffffff', intensity: 1.0 }]);
            } else {
                // Manual/User lights
                this.viewer.updateLights(this.lightParams);
            }
        }

        // Lightweight sync for prompt/data (no capture) - Debounced to prevent UI lag during drag
        clearTimeout(this.lightingQuickSyncTimeout);
        this.lightingQuickSyncTimeout = setTimeout(() => {
            this.syncToNode(false);
        }, 100);

        // Debounce full capture (previews) to avoid lag/shaking during drag
        clearTimeout(this.lightingSyncTimeout);
        this.lightingSyncTimeout = setTimeout(() => {
            this.syncToNode(true);
        }, 500);
    }

    updateRotationSliders() {
        if (!this.viewer) return;
        const rArray = this.viewer.isInitialized() ? this.viewer.getPose().modelRotation : [0, 0, 0];
        const r = { x: rArray[0], y: rArray[1], z: rArray[2] };
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

    onMeshParamsChanged(changedKey = null) {
        if (changedKey === "age") {
            this.pendingAgeCameraFit = true;
        }

        // Update node widgets
        for (const [key, value] of Object.entries(this.meshParams)) {
            const widget = this.node.widgets?.find(w => w.name === key);
            if (widget) {
                widget.value = value;
            }
        }

        // Async Queue update
        this.pendingMeshUpdate = true;

        if (this.isMeshUpdating) return;
        this.isMeshUpdating = true;
        this.pendingMeshUpdate = false;

        this.loadModel(false).finally(() => {
            const hasPendingMeshUpdate = this.pendingMeshUpdate;
            this.isMeshUpdating = false;
            if (hasPendingMeshUpdate) {
                this.onMeshParamsChanged();
                return;
            }
            if (this.pendingAgeCameraFit) {
                this.pendingAgeCameraFit = false;
                const suppressAgeFitSync = this._suppressNextAgeFitSync === true;
                this._suppressNextAgeFitSync = false;
                if (this.applyAgeCameraFit()) {
                    if (!suppressAgeFitSync) {
                        this.syncToNode(this.interfaceMode !== "studio");
                    }
                }
            }
        });
    }

    resize() {
        this.updateMainUIScale();
        if (this.interfaceMode === "manager") {
            this.layoutPoseManager();
            return;
        }
        if (this.viewer && this.canvasContainer) {
            const rect = this.canvasContainer.getBoundingClientRect();
            const targetW = Math.round(rect.width);
            const targetH = Math.round(rect.height);

            if (targetW > 1 && targetH > 1) {
                const dw = Math.abs(targetW - (this._lastResizeW || 0));
                const dh = Math.abs(targetH - (this._lastResizeH || 0));
                if (dw < 2 && dh < 2) return;

                this._lastResizeW = targetW;
                this._lastResizeH = targetH;
                this.viewer.resize(targetW, targetH);
                if (this._activeHandSide) {
                    this.positionHandControlPopover(this._activeHandSide);
                }
            }
        }
    }

    updateMainUIScale() {
        if (!this.container) return;
        const width = this.container.clientWidth || this.node?.size?.[0] || 900;
        const height = this.container.clientHeight || this.node?.size?.[1] || 740;
        const scale = Math.max(0.85, Math.min(1.55, Math.min(width / 900, height / 740)));
        this.container.style.setProperty("--vnccs-ps-ui-scale", scale.toFixed(3));
    }

    startResizeObserver() {
        if (this._containerResizeObserver || !this.canvasContainer) return;

        this._containerResizeObserver = new ResizeObserver(() => {
            if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
            this._resizeRaf = requestAnimationFrame(() => this.resize());
        });

        this.updateMainUIScale();
        if (this.container) this._containerResizeObserver.observe(this.container);
        this._containerResizeObserver.observe(this.canvasContainer);
    }

    /**
     * Generate a natural language prompt from light parameters.
     * Maps RGB colors to basic names and describes position/intensity.
     */
    generatePromptFromLights(lights, userPromptOverride = null) {
        let finalPrompt = "";

        if (this.exportParams.keepOriginalLighting) {
            finalPrompt = "";
        } else if (lights && Array.isArray(lights)) {
            const getColorName = (lightColor) => {
                // Determine RGB components
                let r, g, b;
                if (typeof lightColor === 'string') {
                    const hex = lightColor.replace('#', '');
                    r = parseInt(hex.substring(0, 2), 16);
                    g = parseInt(hex.substring(2, 4), 16);
                    b = parseInt(hex.substring(4, 6), 16);
                } else if (Array.isArray(lightColor)) {
                    [r, g, b] = lightColor;
                } else if (lightColor && typeof lightColor.r === 'number') { // Handle THREE.Color
                    r = Math.round(lightColor.r * 255);
                    g = Math.round(lightColor.g * 255);
                    b = Math.round(lightColor.b * 255);
                } else {
                    r = g = b = 255;
                }

                // Reference color map for nearest-neighbor matching
                const colorMap = {
                    "White": [255, 255, 255], "Silver": [192, 192, 192], "Grey": [128, 128, 128], "Dark Grey": [64, 64, 64], "Black": [0, 0, 0],
                    "Red": [255, 0, 0], "Crimson": [220, 20, 60], "Maroon": [128, 0, 0], "Ruby": [224, 17, 95], "Rose": [255, 0, 127],
                    "Orange": [255, 165, 0], "Amber": [255, 191, 0], "Gold": [255, 215, 0], "Peach": [255, 218, 185], "Coral": [255, 127, 80],
                    "Yellow": [255, 255, 0], "Lemon": [255, 250, 205], "Cream": [255, 253, 208], "Sand": [194, 178, 128], "Sepia": [112, 66, 20],
                    "Green": [0, 255, 0], "Lime": [50, 205, 50], "Forest Green": [34, 139, 34], "Olive": [128, 128, 0], "Emerald": [80, 200, 120],
                    "Mint": [189, 252, 201], "Turquoise": [64, 224, 208], "Teal": [0, 128, 128], "Cyan": [0, 255, 255], "Aqua": [0, 255, 255],
                    "Blue": [0, 0, 255], "Navy": [0, 0, 128], "Azure": [0, 127, 255], "Sky Blue": [135, 206, 235], "Electric Blue": [125, 249, 255],
                    "Indigo": [75, 0, 130], "Purple": [128, 0, 128], "Violet": [238, 130, 238], "Lavender": [230, 230, 250], "Plum": [142, 69, 133],
                    "Magenta": [255, 0, 255], "Pink": [255, 192, 203], "Hot Pink": [255, 105, 180], "Deep Pink": [255, 20, 147], "Salmon": [250, 128, 114],
                    "Tan": [210, 180, 140], "Brown": [165, 42, 42], "Chocolate": [210, 105, 30], "Coffee": [111, 78, 55], "Copper": [184, 115, 51]
                };

                let bestName = "White";
                let minDistance = Infinity;

                for (const [name, [cr, cg, cb]] of Object.entries(colorMap)) {
                    // Simple Euclidean distance in RGB space
                    const distance = Math.sqrt(
                        Math.pow(r - cr, 2) +
                        Math.pow(g - cg, 2) +
                        Math.pow(b - cb, 2)
                    );
                    if (distance < minDistance) {
                        minDistance = distance;
                        bestName = name;
                    }
                }

                // Add saturation/lightness adjectives for more nuance
                const max = Math.max(r / 255, g / 255, b / 255);
                const min = Math.min(r / 255, g / 255, b / 255);
                const l = (max + min) / 2;
                const sat = (max === min) ? 0 : (l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min)) * 100;

                let name = bestName;
                if (sat < 15 && !["White", "Silver", "Grey", "Dark Grey", "Black"].includes(bestName)) {
                    if (l < 0.1) name = "Black";
                    else if (l < 0.35) name = "Dark Grey";
                    else if (l < 0.65) name = "Grey";
                    else name = "Whiteish";
                } else if (l < 0.25 && !bestName.includes("Dark") && !bestName.includes("Deep")) {
                    name = "Deep " + bestName;
                } else if (l > 0.85 && !bestName.includes("Pale") && !bestName.includes("Light")) {
                    name = "Pale " + bestName;
                }

                return { name, sat, l };
            };

            const dirPrompts = [];
            const ambPrompts = [];

            for (const light of lights) {
                const { name: colorName, sat, l } = getColorName(light.color);

                if (light.type === 'directional') {
                    // --- 2. Determine Position ---
                    const y = light.y || 0;
                    const x = light.x || 0;
                    const z = light.z || 0;
                    const isPoint = light.type === 'point';
                    const yRange = isPoint ? 10 : 100; // Point lights use -10..10, Directional -100..100
                    const yNorm = (y / yRange) * 100;

                    let vertDesc = "eye-level";
                    if (yNorm > 70) vertDesc = "overhead";
                    else if (yNorm > 25) vertDesc = "high";
                    else if (yNorm < -25) vertDesc = "low";
                    else if (yNorm < -70) vertDesc = "bottom-up";

                    const distXZ = Math.sqrt(x * x + z * z);
                    let horizDesc = "centered";

                    if (distXZ > (isPoint ? 0.5 : 5)) {
                        const angle = Math.atan2(z, x) * 180 / Math.PI;
                        let deg = angle;
                        if (deg < 0) deg += 360;

                        if (deg >= 337.5 || deg < 22.5) horizDesc = "right";
                        else if (deg >= 22.5 && deg < 67.5) horizDesc = "front-right";
                        else if (deg >= 67.5 && deg < 112.5) horizDesc = "front";
                        else if (deg >= 112.5 && deg < 157.5) horizDesc = "front-left";
                        else if (deg >= 157.5 && deg < 202.5) horizDesc = "left";
                        else if (deg >= 202.5 && deg < 247.5) horizDesc = "back-left";
                        else if (deg >= 247.5 && deg < 292.5) horizDesc = "back";
                        else if (deg >= 292.5 && deg < 337.5) horizDesc = "back-right";
                    }

                    const posName = (horizDesc === "centered") ? vertDesc : `${vertDesc} ${horizDesc}`;

                    // 3. Determine Intensity
                    const intensity = (light.intensity !== undefined) ? light.intensity : 1.0;
                    if (intensity < 0.1) continue; // Skip near-zero lights

                    let intDesc = "moderate";
                    if (intensity < 0.4) intDesc = "subtle";
                    else if (intensity < 0.8) intDesc = "faint";
                    else if (intensity < 1.2) intDesc = "soft";
                    else if (intensity < 1.7) intDesc = "gentle";
                    else if (intensity < 2.4) intDesc = "strong";
                    else if (intensity < 3.0) intDesc = "bright";
                    else if (intensity < 3.8) intDesc = "intense";
                    else if (intensity < 4.5) intDesc = "dazzling";
                    else intDesc = "blinding";

                    dirPrompts.push(`${intDesc} ${colorName} lighting coming from the ${posName}`);
                } else if (light.type === 'ambient') {
                    const intensity = (light.intensity !== undefined) ? light.intensity : 1.0;

                    // Slightly more specific suppression of the "default" mid-grey ambient
                    const isDefaultGrey = (colorName === "Dark Grey" && sat < 10 && intensity < 1.1 && l < 0.4);

                    if (intensity >= 0.05 && !isDefaultGrey) {
                        let ambPart = "";
                        if (colorName === "Black" || (l < 0.1 && sat < 10)) {
                            ambPart = "a pitch black, unlit environment";
                        } else {
                            let ambIntDesc = "moderate";
                            if (intensity < 0.4) ambIntDesc = "subtle";
                            else if (intensity < 0.8) ambIntDesc = "faint";
                            else if (intensity < 1.2) ambIntDesc = "soft";
                            else if (intensity < 1.7) ambIntDesc = "gentle";
                            else if (intensity < 2.4) ambIntDesc = "strong";
                            else if (intensity < 3.0) ambIntDesc = "bright";
                            else if (intensity < 3.8) ambIntDesc = "intense";
                            else if (intensity < 4.5) ambIntDesc = "dazzling";
                            else ambIntDesc = "blinding";
                            ambPart = `a ${ambIntDesc} ${colorName} ambient glow`;
                        }
                        ambPrompts.push(ambPart);
                    }
                }
            }

            finalPrompt = dirPrompts.join(". ");
            if (ambPrompts.length > 0) {
                if (finalPrompt.length > 0) finalPrompt += ". ";
                finalPrompt += "Scene filled with " + ambPrompts.join(" and ");
            } else {
                // If there are directional lights but no reported ambient light, emphasize the darkness of shadows
                finalPrompt += "";
            }
        }

        // Final Construction using Template
        let template = this.exportParams.prompt_template || "Draw character from image2\n<lighting>\n<user_prompt>";

        // Final Lighting string
        const lightingString = finalPrompt.trim();

        // User Prompt string
        const userPromptString = String(userPromptOverride ?? this.getPosePrompt(this.activeTab) ?? "").trim();

        // Perform Replacements (Robust Global Replace)
        let result = template
            .replace(/<lighting>/g, lightingString)
            .replace(/<user_prompt>/g, userPromptString);

        // Clean up accidental double-newlines, extra spaces, and empty lines
        result = result.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .join('\n');

        return result;
    }

    /**
     * Generate random debug parameters for model rotation, camera, and lighting.
     * Model must remain at least ~20% visible in frame.
     */
    generateDebugParams() {
        // Random Y rotation for model (-90 to 90)
        const modelYRotation = Math.random() * 180 - 90;

        // Camera Settings
        const viewW = this.exportParams.view_width || 1024;
        const viewH = this.exportParams.view_height || 1024;
        const ar = viewW / viewH;

        let zoom = 1.3 + Math.random() * 0.7;
        let offsetX = (Math.random() * 2 - 1) * (2.0 / zoom);
        let offsetY = (Math.random() * 2 - 1) * (2.0 / zoom);

        if (this.exportParams.debugPortraitMode) {
            // Portrait framing: High zoom, focused on head/torso
            // If AR is narrow (< 0.7), cap zoom to avoid shoulder clipping
            const maxZoom = ar < 0.7 ? (2.0 + ar * 2) : 3.5;
            zoom = 2.2 + Math.random() * (maxZoom - 2.2);

            offsetX = (Math.random() * 2 - 1) * 0.3; // Slight side jitter (world units)
            // Shift target UP to head area (Y approx 15-16). 
            // Pelvis is at Y=10. so offsetY = -5 to -6.
            offsetY = -5.5 + (Math.random() * 2 - 1) * 1.0;
        }

        // Random directional lighting
        let lights = [];
        let lightingPrompt = "";

        if (this.exportParams.debugKeepLighting) {
            // Use current manual lights
            lights = JSON.parse(JSON.stringify(this.lightParams));
            lightingPrompt = this.generatePromptFromLights(lights);
        } else {
            // Original randomization logic
            const prompts = [];
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

            for (let i = 0; i < numLights; i++) {
                const colorObj = colorPalette[Math.floor(Math.random() * colorPalette.length)];
                const intensity = 2.0 + Math.random() * 1.5;
                let x, y, z;
                if (numLights > 1) {
                    const slice = 120 / numLights;
                    const center = -60 + slice * i + slice / 2;
                    x = center + (Math.random() * 20 - 10);
                } else {
                    x = (Math.random() * 2 - 1) * 60;
                }
                y = 10 + Math.random() * 50;
                z = Math.random() * 60;

                let posDesc = "";
                if (y > 40) posDesc += "top ";
                else if (y < 20) posDesc += "low ";
                if (x > 20) posDesc += "right";
                else if (x < -20) posDesc += "left";
                else if (z > 30) posDesc += "front";
                else posDesc += "side";

                let intDesc = "strong";
                if (intensity > 3.0) intDesc = "blinding";
                else if (intensity < 2.5) intDesc = "bright";

                prompts.push(`${intDesc} ${colorObj.name} light from the ${posDesc.trim()}`);
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

            if (Math.random() < 0.7) {
                const h = Math.random();
                const s = 0.3 + Math.random() * 0.7;
                const l = 0.3 + Math.random() * 0.5;
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
                ambIntensity = 0.2 + Math.random() * 1.0;
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

    syncMeshProportionSlidersFromViewer() {
        if (!this.viewer?.boneLengthParams) return;
        const mapping = {
            upper_arm_l_length: 'upper_arm_l',
            upper_arm_r_length: 'upper_arm_r',
            forearm_l_length: 'forearm_l',
            forearm_r_length: 'forearm_r',
            thigh_l_length: 'thigh_l',
            thigh_r_length: 'thigh_r',
            shin_l_length: 'shin_l',
            shin_r_length: 'shin_r',
            spine_length: 'spine',
        };
        for (const [sliderKey, groupKey] of Object.entries(mapping)) {
            const value = this.viewer.boneLengthParams[groupKey];
            if (!Number.isFinite(Number(value))) continue;
            this.meshParams[sliderKey] = Number(value);
            const info = this.sliders?.[sliderKey];
            if (info?.slider) info.slider.value = value;
            if (info?.label) info.label.innerText = Number(value).toFixed(2);
        }
    }

    syncToNode(fullCapture = false, options = {}) {
        if (this._isSyncing) return;
        this._isSyncing = true;
        const skipCapture = options.skipCapture === true || (options.skipCapture !== false && this.interfaceMode === "manager" && !fullCapture);

        if (this.radarRedraw) this.radarRedraw();

        // Save current pose before syncing (only if we are NOT in a sub-sync loop)
        if (!fullCapture && this.viewer && this.viewer.isInitialized()) {
            const syncPose = this.viewer.getPose();
            if (!this._samCameraModeActive) {
                syncPose.cameraParams = this.currentCameraParams();
            } else {
                delete syncPose.cameraParams;
            }
            syncPose.prompt = this.getPosePrompt(this.activeTab);
            this.poses[this.activeTab] = syncPose;
        }

        // Cache Handling
        if (!this.poseCaptures) this.poseCaptures = [];
        if (!this.lightingPrompts) this.lightingPrompts = [];
        this.ensurePosePrompts();

        // Ensure size
        while (this.poseCaptures.length < this.poses.length) this.poseCaptures.push(null);
        while (this.poseCaptures.length > this.poses.length) this.poseCaptures.pop();

        while (this.lightingPrompts.length < this.poses.length) this.lightingPrompts.push("");
        while (this.lightingPrompts.length > this.poses.length) this.lightingPrompts.pop();

        // Capture Image (CSR)
        if (!skipCapture && this.viewer && this.viewer.isInitialized()) {
            const w = this.exportParams.view_width || 1024;
            const h = this.exportParams.view_height || 1024;
            const bg = this.exportParams.bg_color || [40, 40, 40];

            // Debug/Export Mode: apply randomized params if needed
            const isDebug = this.exportParams.debugMode;
            const isOriginalLighting = this.exportParams.keepOriginalLighting;
            const userLights = JSON.parse(JSON.stringify(this.lightParams));

            if (fullCapture) {
                const originalTab = this.activeTab;
                const originalLights = [...this.lightParams]; // Save original lighting

                for (let i = 0; i < this.poses.length; i++) {
                    this.activeTab = i; // Switch tab for capture

                    if (isDebug) {
                        // Generate fresh random params for each pose
                        const debugParams = this.generateDebugParams();

                        // Random Pose logic...
                        let randomPoseUsed = false;
                        if (this.libraryPoses && this.libraryPoses.length > 0) {
                            const randIdx = Math.floor(Math.random() * this.libraryPoses.length);
                            const poseItem = this.libraryPoses[randIdx];
                            if (poseItem.data) {
                                this.viewer.setPose(poseItem.data, true);
                                randomPoseUsed = true;
                            }
                        }
                        if (!randomPoseUsed) this.viewer.setPose(this.poses[i], true);

                        // Model Rotation
                        const rArray = this.viewer.isInitialized() ? this.viewer.getPose().modelRotation : [0, 0, 0];
                        const currentRot = { x: rArray[0], y: rArray[1], z: rArray[2] };
                        this.viewer.setModelRotation(currentRot.x, debugParams.modelYRotation, currentRot.z);

                        // Lighting
                        if (isOriginalLighting) {
                            this.viewer.updateLights([{ type: 'ambient', color: '#ffffff', intensity: 1.0 }]);
                        } else if (debugParams.lights) {
                            this.viewer.updateLights(debugParams.lights);
                        }

                        // Capture
                        this.poseCaptures[i] = this.viewer.capture(w, h, debugParams.zoom, debugParams.bgColor, debugParams.offsetX, debugParams.offsetY);

                        // Prompt
                        const promptLights = isOriginalLighting ? [{ type: 'ambient', color: '#ffffff', intensity: 1.0 }] : (debugParams.lights || originalLights);
                        this.lightingPrompts[i] = this.generatePromptFromLights(promptLights, this.getPosePrompt(i));
                    } else {
                        // Normal mode
                        this.viewer.setPose(this.poses[i], true);
                        const poseCam = this.poses[i].cameraParams || {};
                        const z = poseCam.zoom || this.exportParams.cam_zoom || 1.0;
                        const oX = (poseCam.offset_x !== undefined ? poseCam.offset_x : this.exportParams.cam_offset_x) || 0;
                        const oY = (poseCam.offset_y !== undefined ? poseCam.offset_y : this.exportParams.cam_offset_y) || 0;
                        const yaw = (poseCam.yaw_deg !== undefined ? poseCam.yaw_deg : this.exportParams.cam_yaw_deg) || 0;
                        const pitch = (poseCam.pitch_deg !== undefined ? poseCam.pitch_deg : this.exportParams.cam_pitch_deg) || 0;

                        // Lighting Toggle
                        if (isOriginalLighting) {
                            this.viewer.updateLights([{ type: 'ambient', color: '#ffffff', intensity: 1.0 }]);
                        } else {
                            this.viewer.updateLights(this.lightParams);
                        }

                        this.poseCaptures[i] = this.viewer.capture(w, h, z, bg, oX, oY, yaw, pitch);
                        this.lightingPrompts[i] = this.generatePromptFromLights(isOriginalLighting ? [] : this.lightParams, this.getPosePrompt(i));
                    }
                }

                // Restore original state and UI
                this.viewer.updateLights(userLights);
                this.activeTab = originalTab;
                this.viewer.setPose(this.poses[this.activeTab], true);
                this.updateTabs(); // Ensure UI reflects correct tab
                this.updateRotationSliders();

                // Restore Camera Visualization
                const z = this.exportParams.cam_zoom || 1.0;
                const oX = this.exportParams.cam_offset_x || 0;
                const oY = this.exportParams.cam_offset_y || 0;
                const yaw = this.exportParams.cam_yaw_deg || 0;
                const pitch = this.exportParams.cam_pitch_deg || 0;
                this.viewer.updateCaptureCamera(w, h, z, oX, oY, yaw, pitch);

            } else {
                // Capture only ACTIVE
                if (isDebug) {
                    const debugParams = this.generateDebugParams();
                    this.viewer.resetPose();
                    this.viewer.setModelRotation(0, debugParams.modelYRotation, 0);

                    if (isOriginalLighting) {
                        this.viewer.updateLights([{ type: 'ambient', color: '#ffffff', intensity: 1.0 }]);
                    } else if (debugParams.lights) {
                        this.viewer.updateLights(debugParams.lights);
                    }

                    this.poseCaptures[this.activeTab] = this.viewer.capture(w, h, debugParams.zoom, debugParams.bgColor, debugParams.offsetX, debugParams.offsetY, 0, 0);

                    const promptLights = isOriginalLighting ? [{ type: 'ambient', color: '#ffffff', intensity: 1.0 }] : (debugParams.lights || userLights);
                    this.lightingPrompts[this.activeTab] = this.generatePromptFromLights(promptLights, this.getPosePrompt(this.activeTab));

                    this.viewer.updateLights(userLights);
                    this.viewer.setPose(this.poses[this.activeTab], true);

                    const z = this.exportParams.cam_zoom || 1.0;
                    const oX = this.exportParams.cam_offset_x || 0;
                    const oY = this.exportParams.cam_offset_y || 0;
                    const yaw = this.exportParams.cam_yaw_deg || 0;
                    const pitch = this.exportParams.cam_pitch_deg || 0;
                    this.viewer.updateCaptureCamera(w, h, z, oX, oY, yaw, pitch);
                } else {
                    const z = this.exportParams.cam_zoom || 1.0;
                    const oX = this.exportParams.cam_offset_x || 0;
                    const oY = this.exportParams.cam_offset_y || 0;
                    const yaw = this.exportParams.cam_yaw_deg || 0;
                    const pitch = this.exportParams.cam_pitch_deg || 0;

                    if (isOriginalLighting) {
                        this.viewer.updateLights([{ type: 'ambient', color: '#ffffff', intensity: 1.0 }]);
                    } else {
                        this.viewer.updateLights(this.lightParams);
                    }

                    this.poseCaptures[this.activeTab] = this.viewer.capture(w, h, z, bg, oX, oY, yaw, pitch);
                    this.lightingPrompts[this.activeTab] = this.generatePromptFromLights(isOriginalLighting ? [] : this.lightParams, this.getPosePrompt(this.activeTab));

                    if (isOriginalLighting) {
                        this.viewer.updateLights(userLights);
                    }
                }
            }
        }

        // Update hidden pose_data widget
        // Exclude background_url and captured_images from widget to avoid inflating workflow size.
        // Captures are uploaded to server-side LRU cache; only the capture_id is stored in widget.
        const exportToSave = { ...this.exportParams };
        delete exportToSave.background_url;

        // captured_images are excluded from the widget to avoid inflating workflow size
        // (each 1024×1024 PNG is ~500KB base64; multiple poses exceed ComfyUI localStorage limit)
        // They are kept in this.poseCaptures (JS memory) and also uploaded to server-side LRU cache.
        // Only capture_id is stored in the widget so Python can fallback to the cache if needed.
        const captureId = `vnccs_capture_${this.node.id}`;

        const data = {
            mesh: this.meshParams,
            export: exportToSave,
            poses: this.poses,
            lights: this.lightParams,
            activeTab: this.activeTab,
            capture_id: captureId,
            lighting_prompts: this.lightingPrompts,
            background_url: this.exportParams.background_url || null
        };

        // Upload captures to server cache (fire-and-forget; errors are non-fatal)
        if (this.poseCaptures && this.poseCaptures.some(c => c)) {
            fetch('/vnccs/pose_captures_upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    capture_id: captureId,
                    captured_images: this.poseCaptures,
                    lighting_prompts: this.lightingPrompts || []
                })
            }).catch(e => console.warn("[VNCCS PoseStudio] Capture upload failed:", e));
        }

        const widget = this.node.widgets?.find(w => w.name === "pose_data");
        if (widget) {
            widget.value = JSON.stringify(data);

            // Force ComfyUI to recognize the state change so it saves to the workflow
            if (widget.callback) {
                widget.callback(widget.value);
            }
            if (app.graph && app.graph.setDirtyCanvas) {
                app.graph.setDirtyCanvas(true, true);
            }
        }

        this.renderPoseManager();
        this.renderPoseManagerDetailStrip();
        this._isSyncing = false;
    }

    loadFromNode() {
        this.clearSAMCameraMode();
        // Load from pose_data widget
        const widget = this.node.widgets?.find(w => w.name === "pose_data");
        if (!widget || !widget.value) {
            return;
        }

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

                // Sync bone scales
                if (this.viewer && this.meshParams.head_size !== undefined) {
                    this.viewer.updateHeadScale(this.meshParams.head_size);
                }
                if (this.viewer && this.meshParams.arm_size !== undefined) {
                    this.viewer.updateArmScale(this.meshParams.arm_size);
                }
                if (this.viewer && this.meshParams.hand_size !== undefined) {
                    this.viewer.updateHandScale(this.meshParams.hand_size);
                }
                if (data.mesh.arm_length !== undefined) {
                    if (data.mesh.upper_arm_l_length === undefined) this.meshParams.upper_arm_l_length = data.mesh.arm_length;
                    if (data.mesh.upper_arm_r_length === undefined) this.meshParams.upper_arm_r_length = data.mesh.arm_length;
                    if (data.mesh.forearm_l_length === undefined) this.meshParams.forearm_l_length = data.mesh.arm_length;
                    if (data.mesh.forearm_r_length === undefined) this.meshParams.forearm_r_length = data.mesh.arm_length;
                }
                if (data.mesh.upper_arm_length !== undefined) {
                    if (data.mesh.upper_arm_l_length === undefined) this.meshParams.upper_arm_l_length = data.mesh.upper_arm_length;
                    if (data.mesh.upper_arm_r_length === undefined) this.meshParams.upper_arm_r_length = data.mesh.upper_arm_length;
                }
                if (data.mesh.forearm_length !== undefined) {
                    if (data.mesh.forearm_l_length === undefined) this.meshParams.forearm_l_length = data.mesh.forearm_length;
                    if (data.mesh.forearm_r_length === undefined) this.meshParams.forearm_r_length = data.mesh.forearm_length;
                }
                if (data.mesh.leg_length !== undefined) {
                    if (data.mesh.thigh_l_length === undefined) this.meshParams.thigh_l_length = data.mesh.leg_length;
                    if (data.mesh.thigh_r_length === undefined) this.meshParams.thigh_r_length = data.mesh.leg_length;
                    if (data.mesh.shin_l_length === undefined) this.meshParams.shin_l_length = data.mesh.leg_length;
                    if (data.mesh.shin_r_length === undefined) this.meshParams.shin_r_length = data.mesh.leg_length;
                }
                if (data.mesh.thigh_length !== undefined) {
                    if (data.mesh.thigh_l_length === undefined) this.meshParams.thigh_l_length = data.mesh.thigh_length;
                    if (data.mesh.thigh_r_length === undefined) this.meshParams.thigh_r_length = data.mesh.thigh_length;
                }
                if (data.mesh.shin_length !== undefined) {
                    if (data.mesh.shin_l_length === undefined) this.meshParams.shin_l_length = data.mesh.shin_length;
                    if (data.mesh.shin_r_length === undefined) this.meshParams.shin_r_length = data.mesh.shin_length;
                }
                const lengthKeys = [
                    'upper_arm_l_length', 'upper_arm_r_length',
                    'forearm_l_length', 'forearm_r_length',
                    'thigh_l_length', 'thigh_r_length',
                    'shin_l_length', 'shin_r_length',
                    'spine_length',
                ];
                for (const key of lengthKeys) {
                    if (this.viewer && this.meshParams[key] !== undefined) {
                        this.viewer.updateBoneLengthScale(key.replace('_length', ''), this.meshParams[key]);
                    }
                }
            }

            if (data.export) {
                this.exportParams = { ...this.exportParams, ...data.export };

                // user_prompt in export is the legacy global prompt; per-tab prompts are in pose.prompt
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
                this.syncCameraWidgets();
            }
            if (this.viewer?.setKpFigureVisible) {
                this.viewer.setKpFigureVisible(this.exportParams.debugShowSAMHelper !== false);
            }
            if (this.updateOverrideBtn) this.updateOverrideBtn();

            if (data.poses && Array.isArray(data.poses)) {
                this.poses = data.poses;
                this.posePrompts = []; // rebuild from pose.prompt on next ensurePosePrompts() call
            }

            // Restore background image if present
            const bgUrl = data.background_url || this.exportParams.background_url;
            if (bgUrl && this.viewer) {
                this.exportParams.background_url = bgUrl;
                this.viewer.loadReferenceImage(bgUrl);
                if (this.refBtn) {
                    this.refBtn.innerHTML = '<span class="vnccs-ps-btn-icon">🗑️</span> Remove Background';
                    this.refBtn.classList.add('danger');
                }
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

            // captured_images are no longer persisted in widget (stored in server-side LRU cache).
            // poseCaptures will be regenerated on the next syncToNode(true) call.

            this.updateTabs();
            this.syncPromptFieldToActiveTab();
            this.refreshPoseManagerControls();
            this.setInterfaceMode(this.exportParams.interface_mode === "manager" ? "manager" : "studio", { sync: false });

            // Auto-load model
            // Restore skin type on the viewer before loading model
            if (this.exportParams.skin_type && this.viewer) {
                this.viewer.setSkinMode(this.exportParams.skin_type);
            }

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
        (() => {
            if (window.__vnccsPoseStudioCharacterCreatorSync) {
                return window.__vnccsPoseStudioCharacterCreatorSync;
            }

            const parseSource = (node) => {
                if (!node || node.type !== "CharacterCreatorV2") return null;
                const dataWidget = node.widgets?.find(w => w.name === "widget_data");
                if (dataWidget?.value) {
                    try {
                        const parsed = JSON.parse(dataWidget.value);
                        const info = parsed?.character_info || {};
                        const age = Number(info.age);
                        const sex = String(info.sex || "").toLowerCase();
                        const gender = sex === "male" ? 1.0 : (sex === "female" ? 0.0 : NaN);
                        return {
                            age: Number.isFinite(age) ? age : NaN,
                            gender,
                            signature: `${Number.isFinite(age) ? Math.round(age) : "?"}|${Number.isFinite(gender) ? gender : "?"}`
                        };
                    } catch (_) {
                        // Fall back to ordinary widgets below.
                    }
                }

                const ageWidget = node.widgets?.find(w => w.name === "age");
                const sexWidget = node.widgets?.find(w => w.name === "sex" || w.name === "gender");
                const age = Number(ageWidget?.value);
                const sex = String(sexWidget?.value || "").toLowerCase();
                const gender = sex === "male" ? 1.0 : (sex === "female" ? 0.0 : NaN);
                if (!Number.isFinite(age) && !Number.isFinite(gender)) return null;
                return {
                    age: Number.isFinite(age) ? age : NaN,
                    gender,
                    signature: `${Number.isFinite(age) ? Math.round(age) : "?"}|${Number.isFinite(gender) ? gender : "?"}`
                };
            };

            const api = {
                studios: new Set(),
                sourceSignatures: new WeakMap(),
                findSourceNode() {
                    const nodes = app.graph?._nodes || [];
                    return nodes.find(n => n?.type === "CharacterCreatorV2") || null;
                },
                applyToStudio(studio, values, options = {}) {
                    if (!studio || !values) return;
                    studio.applyExternalCharacterCreatorValues?.(values, options);
                },
                applySource(node, options = {}) {
                    const values = parseSource(node);
                    if (!values) return;
                    if (!options.initial) {
                        const previous = this.sourceSignatures.get(node);
                        if (previous === values.signature) return;
                    }
                    this.sourceSignatures.set(node, values.signature);
                    for (const studio of this.studios) {
                        this.applyToStudio(studio, values, options);
                    }
                },
                registerStudio(studio) {
                    if (!studio) return;
                    this.studios.add(studio);
                    this.scan();
                    const source = this.findSourceNode();
                    if (source) this.applyToStudio(studio, parseSource(source), { initial: true });
                },
                unregisterStudio(studio) {
                    this.studios.delete(studio);
                },
                hookNode(node) {
                    if (!node || node.type !== "CharacterCreatorV2") return;
                    const dataWidget = node.widgets?.find(w => w.name === "widget_data");
                    if (dataWidget && !dataWidget._vnccsPoseStudioValueHooked) {
                        let currentValue = dataWidget.value;
                        Object.defineProperty(dataWidget, "value", {
                            configurable: true,
                            get() {
                                return currentValue;
                            },
                            set: (value) => {
                                currentValue = value;
                                queueMicrotask(() => this.applySource(node));
                            }
                        });
                        dataWidget._vnccsPoseStudioValueHooked = true;
                    }

                    for (const name of ["age", "sex", "gender"]) {
                        const widget = node.widgets?.find(w => w.name === name);
                        if (!widget || widget._vnccsPoseStudioCallbackHooked) continue;
                        const original = widget.callback;
                        widget.callback = (...args) => {
                            const result = original?.apply(widget, args);
                            queueMicrotask(() => this.applySource(node));
                            return result;
                        };
                        widget._vnccsPoseStudioCallbackHooked = true;
                    }

                    this.applySource(node, { initial: true });
                },
                scan() {
                    const nodes = app.graph?._nodes || [];
                    for (const node of nodes) this.hookNode(node);
                }
            };

            window.__vnccsPoseStudioCharacterCreatorSync = api;
            return api;
        })();

        const uploadPoseStudioSync = async (node, nodeId) => {
            const poseWidget = node.widgets.find(w => w.name === "pose_data");
            if (!poseWidget) return;
            const widgetData = JSON.parse(poseWidget.value);
            const payload = {
                ...widgetData,
                node_id: nodeId,
                captured_images: node.studioWidget.poseCaptures || [],
                lighting_prompts: node.studioWidget.lightingPrompts || []
            };

            await fetch('/vnccs/pose_sync/upload_capture', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        };

        api.addEventListener("vnccs_req_pose_sync", async (event) => {
            const nodeId = event.detail.node_id;
            const node = app.graph.getNodeById(nodeId);
            if (node && node.studioWidget) {
                try {
                    // Safe mode: ensure viewer is initialized
                    if (!node.studioWidget.viewer || !node.studioWidget.viewer.isInitialized()) {
                        await node.studioWidget.loadModel();
                    }

                    // Update lights and state before capture
                    if (node.studioWidget.viewer) {
                        node.studioWidget.viewer.updateLights(node.studioWidget.lightParams);
                    }
                    node.studioWidget.syncToNode(true);

                    // Build payload from widget metadata + in-memory captures
                    // (captured_images are no longer stored in the widget to keep workflow size small)
                    await uploadPoseStudioSync(node, nodeId);
                } catch (e) {
                    console.error("[VNCCS] Batch Sync Error:", e);
                }
            }
        });

        api.addEventListener("vnccs_apply_sam3d_pose", async (event) => {
            const nodeId = event.detail.node_id;
            const poseData = event.detail.pose_data;
            const node = app.graph.getNodeById(nodeId);
            if (!node?.studioWidget || !poseData) return;

            try {
                const widget = node.studioWidget;
                if (!widget.viewer || !widget.viewer.isInitialized()) {
                    await widget.loadModel();
                }

                const fitData = await widget.prepareSAM3DRenderFit(poseData);
                const poseForImport = fitData?.poseData || poseData;

                const ok = widget.viewer.applySAM3DImport(
                    poseForImport,
                    widget._shoulderYOffset || 0
                );
                if (!ok) {
                    throw new Error("Failed to apply SAM 3D Body pose to Pose Studio.");
                }
                widget._lastSAM3DPoseData = poseForImport;
                widget._lastSAM3DMeshData = fitData?.meshData || null;
                if (fitData?.meshData) {
                    widget.applySAM3DMeshOverlayFit(fitData.meshData, poseForImport);
                } else {
                    await widget.refreshSAMMeshOverlay(poseForImport);
                }
                widget.syncMeshProportionSlidersFromViewer();
                widget.applySAM3DFrameCameraParams(poseForImport, fitData?.meshData || null);

                widget.poses[widget.activeTab] = widget.viewer.getPose();
                widget.updateTabs();
                widget.syncToNode(true);
                await uploadPoseStudioSync(node, nodeId);
            } catch (e) {
                console.error("[VNCCS] SAM3D pose_image apply error:", e);
            }
        });
    },

    async beforeRegisterNodeDef(nodeType, nodeData, _app) {
        if (nodeData.name !== "VNCCS_PoseStudio") return;

        const syncStudioDOMWidgetWidth = (node) => {
            const widget = node?.widgets?.find(w => w.name === "pose_studio_ui");
            const nodeWidth = Number(node?.size?.[0]);
            if (widget && Number.isFinite(nodeWidth) && nodeWidth > 0) {
                if (!widget._vnccsWidthBound) {
                    Object.defineProperty(widget, "width", {
                        configurable: true,
                        get() {
                            const width = Number(this._node?.size?.[0]);
                            return Number.isFinite(width) && width > 0 ? width : undefined;
                        },
                        set(_value) {
                            // ComfyUI may restore a stale widget.width from older DOM layouts.
                            // Keep this DOM widget tied to the node width instead.
                        }
                    });
                    widget._vnccsWidthBound = true;
                }
                if (typeof widget.triggerDraw === "function") widget.triggerDraw();
            }
        };

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onCreated) onCreated.apply(this, arguments);

            this.setSize([900, 740]);

            // Create widget
            this.studioWidget = new PoseStudioWidget(this);

            const studioDOMWidget = this.addDOMWidget("pose_studio_ui", "ui", this.studioWidget.container, {
                serialize: false,
                hideOnZoom: false
            });
            this.studioDOMWidget = studioDOMWidget;
            syncStudioDOMWidgetWidth(this);
            requestAnimationFrame(() => syncStudioDOMWidgetWidth(this));

            // Pre-load library for random functionality
            setTimeout(() => {
                if (this.studioWidget) {
                    this.studioWidget.refreshLibrary(false);
                    this.studioWidget.autoRefreshEnabledPoseRepositories();
                }
            }, 1000);

            // Hide pose_data widget (must work in both legacy LiteGraph and node2.0 Vue modes)
            const poseWidget = this.widgets?.find(w => w.name === "pose_data");
            if (poseWidget) {
                // Legacy LiteGraph mode
                poseWidget.type = "hidden";
                poseWidget.computeSize = () => [0, -4];
                // Node 2.0 Vue mode
                poseWidget.hidden = true;
                // Hide DOM element if it exists (node2.0 creates input elements)
                if (poseWidget.element) {
                    poseWidget.element.style.display = "none";
                }
            }
            // Load model after initialization
            setTimeout(() => {
                this.studioWidget.loadFromNode();
                window.__vnccsPoseStudioCharacterCreatorSync?.registerStudio(this.studioWidget);
                this.studioWidget.loadModel().then(() => {
                    if (this.studioWidget.viewer) {
                        this.studioWidget.updateCaptureCameraPreview();
                        // Force resize again after model load to ensure Three.js matches container
                        this.studioWidget.resize();
                    }
                });
                // Force a resize after initialization to fix stretching
                this.onResize(this.size);
            }, 800);
        };

        nodeType.prototype.onResize = function (size) {
            if (this.studioWidget) {
                // DON'T set container dimensions - let it fill naturally
                // Just trigger the viewer resize
                syncStudioDOMWidgetWidth(this);
                clearTimeout(this.resizeTimer);
                this.resizeTimer = setTimeout(() => {
                    syncStudioDOMWidgetWidth(this);
                    this.studioWidget.resize();
                }, 50);
            }
        };

        // Save state on configure
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            if (onConfigure) onConfigure.apply(this, arguments);

            if (this.studioWidget) {
                syncStudioDOMWidgetWidth(this);
                setTimeout(() => {
                    syncStudioDOMWidgetWidth(this);
                    this.studioWidget.loadFromNode();
                    window.__vnccsPoseStudioCharacterCreatorSync?.registerStudio(this.studioWidget);
                    this.studioWidget.loadModel();
                    this.studioWidget.refreshLibrary(false); // Pre-load library meta only
                    this.studioWidget.autoRefreshEnabledPoseRepositories();
                    this.onResize(this.size); // Force correct aspect ratio on config
                }, 500);
            }
        };

        // Re-capture with fresh random params on each execution when Debug Mode is enabled
        const onExecutionStart = nodeType.prototype.onExecutionStart;
        nodeType.prototype.onExecutionStart = function () {
            if (onExecutionStart) onExecutionStart.apply(this, arguments);

            // Removed redundant syncToNode(true) to avoid race conditions with vnccs_req_pose_sync
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            window.__vnccsPoseStudioCharacterCreatorSync?.unregisterStudio(this.studioWidget);
            if (onRemoved) onRemoved.apply(this, arguments);
            if (this.studioWidget) {
                if (this.studioWidget._containerResizeObserver) {
                    this.studioWidget._containerResizeObserver.disconnect();
                    this.studioWidget._containerResizeObserver = null;
                }
                if (this.studioWidget.managerResizeObserver) {
                    this.studioWidget.managerResizeObserver.disconnect();
                    this.studioWidget.managerResizeObserver = null;
                }
                if (this.studioWidget._resizeRaf) {
                    cancelAnimationFrame(this.studioWidget._resizeRaf);
                }
                if (this.studioWidget.viewer) {
                    this.studioWidget.viewer.dispose();
                }
            }
        };
    },

    nodeCreated(node) {
        window.__vnccsPoseStudioCharacterCreatorSync?.hookNode(node);
        if (node?.type === "CharacterCreatorV2") {
            setTimeout(() => window.__vnccsPoseStudioCharacterCreatorSync?.hookNode(node), 0);
            setTimeout(() => window.__vnccsPoseStudioCharacterCreatorSync?.hookNode(node), 500);
        }
    },

    loadedGraphNode(node) {
        window.__vnccsPoseStudioCharacterCreatorSync?.hookNode(node);
    },

    loadedGraph() {
        window.__vnccsPoseStudioCharacterCreatorSync?.scan();
    }
});
