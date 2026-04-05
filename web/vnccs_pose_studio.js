/**
 * VNCCS Pose Studio - Combined mesh editor and multi-pose generator
 * 
 * Combines Character Studio sliders, dynamic pose tabs, and Debug3 gizmo controls.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { PoseViewerCore, IK_CHAINS } from "./vnccs_pose_studio_core.js";
import { detectAndParseJSON, extractKeypointsFromImage, convertOpenPoseToPose, roundTripTest } from "./vnccs_openpose_import.js";

// Determine the extension's base URL dynamically to support varied directory names (e.g. ComfyUI_VNCCS_Utils or vnccs-utils)
const EXTENSION_URL = new URL(".", import.meta.url).toString();

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
    font-size: 11px;
    color: var(--ps-text);
    overflow: hidden;
    box-sizing: border-box;
    pointer-events: none;
    position: relative;
}

/* === Left Panel (Compact) === */
.vnccs-ps-left {
    width: 220px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    overflow-y: auto;
    border-right: 1px solid var(--ps-border);
    pointer-events: auto;
}

/* Scrollbar */
.vnccs-ps-left::-webkit-scrollbar { width: 6px; }
.vnccs-ps-left::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }

/* === Center Panel (Canvas) === */
.vnccs-ps-center {
    flex: 1;
    min-width: 400px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    pointer-events: auto;
}

/* === Right Sidebar (Lighting - Compact) === */
.vnccs-ps-right-sidebar {
    width: 220px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    overflow-y: auto;
    border-left: 1px solid var(--ps-border);
    pointer-events: auto;
    background: var(--ps-bg);
}

.vnccs-ps-right-sidebar::-webkit-scrollbar { width: 6px; }
.vnccs-ps-right-sidebar::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }

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
    padding: 5px 8px;
    background: #1a1a1a;
    border-bottom: 1px solid var(--ps-border);
    cursor: pointer;
    user-select: none;
}

.vnccs-ps-section-title {
    font-size: 10px;
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
    gap: 2px;
    pointer-events: auto;
}

.vnccs-ps-label {
    font-size: 9px;
    color: var(--ps-text-muted);
    text-transform: uppercase;
    font-weight: 600;
}

.vnccs-ps-value {
    font-size: 9px;
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
    gap: 6px;
    background: var(--ps-input-bg);
    border: 1px solid var(--ps-border);
    border-radius: 4px;
    padding: 3px 6px;
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
    width: 35px;
    text-align: right;
    font-size: 10px;
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
    padding: 4px 6px;
    font-family: inherit;
    font-size: 10px;
    width: 100%;
    box-sizing: border-box;
}

.vnccs-ps-input:focus {
    outline: none;
    border-color: var(--ps-accent);
}

.vnccs-ps-textarea {
    background: var(--ps-input-bg);
    border: 1px solid var(--ps-border);
    color: #fff;
    border-radius: 4px;
    padding: 8px;
    font-family: inherit;
    font-size: 12px;
    width: 100%;
    box-sizing: border-box;
    resize: none;
    overflow-y: hidden;
    line-height: 1.4;
    min-height: 60px;
    pointer-events: auto;
}

.vnccs-ps-textarea:focus {
    outline: none;
    border-color: var(--ps-accent);
}

/* Select */
.vnccs-ps-select {
    background: var(--ps-input-bg);
    border: 1px solid var(--ps-border);
    color: #fff;
    border-radius: 4px;
    padding: 4px 6px;
    font-family: inherit;
    font-size: 10px;
    width: 100%;
    cursor: pointer;
}

/* Counter-zoom removed as zoom is now 1.0 */
.vnccs-ps-select:focus {
    transform: none;
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
    padding: 4px 8px;
    cursor: pointer;
    border-radius: 3px;
    font-size: 10px;
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
    height: 24px;
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
    gap: 4px;
    padding: 4px 10px;
    background: #2a2a2a;
    border: 1px solid var(--ps-border);
    border-bottom: none;
    border-radius: 4px 4px 0 0;
    color: var(--ps-text-muted);
    cursor: pointer;
    font-size: 10px;
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
/* Lighting UI Styles (Reworked) */
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
    background: linear-gradient(135deg, #252525 0%, #1e1e1e 100%);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    transition: all 0.2s;
}
.vnccs-ps-light-card:hover {
    border-color: rgba(255,255,255,0.15);
    box-shadow: 0 6px 16px rgba(0,0,0,0.3);
    transform: translateY(-1px);
}

/* Header */
.vnccs-ps-light-header {
    background: rgba(255,255,255,0.03);
    padding: 6px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid rgba(255,255,255,0.05);
}
.vnccs-ps-light-title {
    font-weight: 600;
    font-size: 10px;
    color: #eee;
    display: flex;
    align-items: center;
    gap: 6px;
}
.vnccs-ps-light-icon {
    font-size: 14px;
    opacity: 0.8;
}

/* Remove Button */
.vnccs-ps-light-remove {
    width: 20px;
    height: 20px;
    border-radius: 4px;
    background: transparent;
    color: #666;
    border: 1px solid transparent;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    transition: all 0.2s;
    padding: 0;
}
.vnccs-ps-light-remove:hover {
    background: rgba(210, 50, 50, 0.1);
    color: #ff5555;
    border-color: rgba(210, 50, 50, 0.3);
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
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    align-items: center;
}

/* Input Styles */
.vnccs-ps-light-select {
    width: 100%;
    background: #151515;
    border: 1px solid #333;
    border-radius: 4px;
    color: #ccc;
    font-size: 10px;
    padding: 3px 6px;
    font-family: inherit;
    cursor: pointer;
}
.vnccs-ps-light-select:focus { border-color: var(--ps-accent); outline: none; }

.vnccs-ps-light-color {
    width: 100%;
    height: 20px;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 0;
    cursor: pointer;
    background: none;
}

/* Sliders */
.vnccs-ps-light-slider-row {
    display: flex;
    align-items: center;
    gap: 6px;
}
.vnccs-ps-light-slider {
    flex: 1;
    height: 4px;
    background: #333;
    border-radius: 2px;
    -webkit-appearance: none;
}
.vnccs-ps-light-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--ps-accent);
    cursor: pointer;
    box-shadow: 0 0 0 2px rgba(0,0,0,0.2);
}

/* Position Grid */
.vnccs-ps-light-pos-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 10px;
    align-items: center;
    background: rgba(0,0,0,0.2);
    padding: 8px;
    border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.03);
}
.vnccs-ps-light-pos-label {
    font-size: 9px;
    color: #888;
    font-weight: bold;
    width: 10px;
}
.vnccs-ps-light-value {
    width: 30px;
    flex-shrink: 0;
    text-align: right;
    font-size: 9px;
    color: #aaa;
}

/* Light Radar */
.vnccs-ps-light-radar-wrap {
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: rgba(0,0,0,0.3);
    padding: 10px;
    border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.03);
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
    border: 1px solid #333;
    cursor: crosshair;
    background: #111;
    box-shadow: inset 0 0 10px rgba(0,0,0,0.5);
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
    background: #333;
    margin: 0;
}
.vnccs-ps-light-slider-vert::-webkit-slider-runnable-track {
    background: transparent;
}
.vnccs-ps-light-slider-vert::-webkit-slider-thumb {
    width: 12px;
    height: 12px;
}
.vnccs-ps-light-h-val {
    font-size: 10px;
    color: #888;
    height: 12px;
    line-height: 12px;
    font-family: monospace;
}
.vnccs-ps-light-h-label {
    font-size: 9px;
    color: #555;
    font-weight: bold;
    height: 12px;
    line-height: 12px;
}



/* Large Add Btn */
.vnccs-ps-btn-add-large {
    width: 100%;
    padding: 8px;
    background: linear-gradient(to bottom, #2a2a2a, #222);
    border: 1px dashed #444;
    border-radius: 6px;
    color: #888;
    cursor: pointer;
    font-size: 11px;
    transition: all 0.2s;
    margin-top: 5px;
}
.vnccs-ps-btn-add-large:hover {
    border-color: var(--ps-accent);
    color: var(--ps-accent);
    background: rgba(53, 88, 199, 0.05);
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
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 8px;
    background: #1a1a1a;
    border-top: 1px solid var(--ps-border);
    flex-shrink: 0;
}

.vnccs-ps-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 6px 12px;
    background: #333;
    border: 1px solid #444;
    border-radius: 4px;
    color: var(--ps-text);
    cursor: pointer;
    font-size: 10px;
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

/* Library Modal Overlay */
.vnccs-ps-modal-overlay {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.85);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    pointer-events: auto;
    backdrop-filter: blur(4px);
}

.vnccs-ps-library-modal {
    width: 95%;
    max-width: 1200px;
    height: 90%;
    max-height: 900px;
    background: var(--ps-panel);
    border: 1px solid var(--ps-border);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 20px 50px rgba(0,0,0,0.8);
    overflow: hidden;
    flex-shrink: 0;
}

.vnccs-ps-library-modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 15px 20px;
    background: #1a1a1a;
    border-bottom: 1px solid var(--ps-border);
}

.vnccs-ps-library-modal-title {
    font-size: 18px;
    font-weight: bold;
    color: var(--ps-accent);
    display: flex;
    align-items: center;
    gap: 10px;
}

.vnccs-ps-modal-close {
    background: transparent;
    border: none;
    color: #888;
    font-size: 24px;
    cursor: pointer;
    transition: color 0.2s;
}

.vnccs-ps-modal-close:hover { color: #fff; }

.vnccs-ps-library-modal-grid {
    flex: 1;
    overflow-y: scroll; /* Force scrollbar space to be reserved */
    padding: 24px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 20px;
    align-content: start;
}
.vnccs-ps-library-modal-grid::-webkit-scrollbar {
    width: 10px;
}
.vnccs-ps-library-modal-grid::-webkit-scrollbar-track {
    background: #111;
}
.vnccs-ps-library-modal-grid::-webkit-scrollbar-thumb {
    background: #444;
    border-radius: 5px;
}
.vnccs-ps-library-modal-grid::-webkit-scrollbar-thumb:hover {
    background: var(--ps-accent);
}

.vnccs-ps-library-modal-footer {
    padding: 15px 20px;
    border-top: 1px solid var(--ps-border);
    background: #1a1a1a;
    display: flex;
    justify-content: flex-end;
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
    position: relative;
    /* Force a minimum height so items don't squash */
    min-height: 220px;
    display: flex;
    flex-direction: column;
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
    flex: 1; /* Take remaining space above labels */
    background: #1a1a1a;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ps-text-muted);
    font-size: 28px;
    overflow: hidden;
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

/* === Loading Overlay === */
.vnccs-ps-loading-overlay {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(4px);
    display: none;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 20px;
    z-index: 2000;
    color: white;
    cursor: wait;
}

.vnccs-ps-loading-spinner {
    width: 50px;
    height: 50px;
    border: 3px solid rgba(255, 255, 255, 0.1);
    border-top: 3px solid var(--ps-accent);
    border-radius: 50%;
    animation: ps-spin 1s cubic-bezier(0.4, 0, 0.2, 1) infinite;
    box-shadow: 0 0 15px rgba(53, 88, 199, 0.2);
}

@keyframes ps-spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
}

.vnccs-ps-loading-text {
    font-size: 16px;
    font-weight: 500;
    letter-spacing: 1px;
    color: var(--ps-accent);
    text-transform: uppercase;
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
        this.activeTab = 0;
        this.poseCaptures = []; // Cache for captured images
        this.ikMode = true; // IK mode toggle (false = FK, true = IK)

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
            debugMode: false,
            debugPortraitMode: false, // Focus on upper body in debug mode
            debugKeepLighting: false, // Use manual lighting in debug mode
            keepOriginalLighting: false, // Override to clean white lighting, no prompts
            user_prompt: "",
            prompt_template: "Draw character from image2\n<lighting>\n<user_prompt>",
            skin_type: "naked", // naked | naked_marks | dummy_white
            background_url: null
        };

        // Lighting settings (array of light configs)
        this.lightParams = [
            { type: 'directional', color: '#ffffff', intensity: 2.0, x: 10, y: 20, z: 30 },
            { type: 'ambient', color: '#505050', intensity: 1.0, x: 0, y: 0, z: 0 }
        ];

        this.sliders = {};
        this.exportWidgets = {};
        this.tabsContainer = null;
        this.canvasContainer = null;

        this.createUI();
    }

    createUI() {
        this._createLayout();
        this._createLeftPanel();
        this._createCenterPanel();
        this._createRightSidebar();
        this._setupFinalUI();
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

    _createLeftPanel() {
        const leftPanel = this.leftPanel;

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
        dimRow.className = "vnccs-ps-row";
        dimRow.appendChild(this.createInputField("Width", "view_width", "number", 64, 4096, 8));
        dimRow.appendChild(this.createInputField("Height", "view_height", "number", 64, 4096, 8));
        camSection.content.appendChild(dimRow);

        const zoomField = this.createSliderField("Zoom", "cam_zoom", 0.1, 7.0, 0.01, 1.0, this.exportParams, true);
        camSection.content.appendChild(zoomField);

        this.createCameraRadar(camSection);
        leftPanel.appendChild(camSection.el);

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
        this.tabsContainer = document.createElement("div");
        this.tabsContainer.className = "vnccs-ps-tabs";
        this.updateTabs();
        centerPanel.appendChild(this.tabsContainer);

        // Canvas Container
        this.canvasContainer = document.createElement("div");
        this.canvasContainer.className = "vnccs-ps-canvas-wrap";

        this.canvas = document.createElement("canvas");
        this.canvasContainer.appendChild(this.canvas);
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
        fileInput.type = "file"; fileInput.accept = ".json,.png,.jpg,.jpeg,.webp,image/*"; fileInput.style.display = "none";
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
        promptArea.value = this.exportParams.user_prompt || "";

        const autoExpand = () => {
            promptArea.style.height = 'auto';
            promptArea.style.height = (promptArea.scrollHeight) + 'px';
        };

        promptArea.addEventListener('input', () => {
            this.exportParams.user_prompt = promptArea.value;
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
            onPoseChange: (pose) => {
                // Return params request logic mapped into direct assignment beforehand 
                this.viewer.setCameraParams({
                    offset_x: this.exportParams.cam_offset_x,
                    offset_y: this.exportParams.cam_offset_y,
                    zoom: this.exportParams.cam_zoom
                });
                this.syncToNode();
            }
        });

        this.viewer.init();
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
        if (this.viewer && this.viewer.isInitialized()) {
            const savedPose = this.viewer.getPose();
            savedPose.cameraParams = {
                offset_x: this.exportParams.cam_offset_x,
                offset_y: this.exportParams.cam_offset_y,
                zoom: this.exportParams.cam_zoom
            };
            this.poses[this.activeTab] = savedPose;
            this.syncToNode(false);
        }

        this.activeTab = index;
        this.updateTabs();

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
        if (this.viewer && this.viewer.isInitialized()) {
            const savedPose = this.viewer.getPose();
            savedPose.cameraParams = {
                offset_x: this.exportParams.cam_offset_x,
                offset_y: this.exportParams.cam_offset_y,
                zoom: this.exportParams.cam_zoom
            };
            this.poses[this.activeTab] = savedPose;
            this.syncToNode(false);
        }

        this.poses.push({});
        this.activeTab = this.poses.length - 1;
        this.updateTabs();

        if (this.viewer && this.viewer.isInitialized()) {
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
            if (this.viewer && this.viewer.isInitialized()) {
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

    resetSelectedBone() {
        if (this.viewer && this.viewer.isInitialized()) {
            this.viewer.resetSelectedBone();
            this.syncToNode(false);
        }
    }

    copyPose() {
        if (this.viewer && this.viewer.isInitialized()) {
            const pose = this.viewer.getPose();
            pose.cameraParams = {
                offset_x: this.exportParams.cam_offset_x,
                offset_y: this.exportParams.cam_offset_y,
                zoom: this.exportParams.cam_zoom
            };
            this.poses[this.activeTab] = pose;
        }
        this._clipboard = JSON.parse(JSON.stringify(this.poses[this.activeTab]));
    }

    pastePose() {
        if (!this._clipboard) return;
        this.poses[this.activeTab] = JSON.parse(JSON.stringify(this._clipboard));
        if (this.viewer && this.viewer.isInitialized()) {
            this.viewer.setPose(this.poses[this.activeTab]);
        }
        if (this._clipboard.cameraParams) {
            this.exportParams.cam_offset_x = this._clipboard.cameraParams.offset_x || 0;
            this.exportParams.cam_offset_y = this._clipboard.cameraParams.offset_y || 0;
            this.exportParams.cam_zoom = this._clipboard.cameraParams.zoom || 1.0;
            if (this.exportWidgets.cam_offset_x) this.exportWidgets.cam_offset_x.value = this.exportParams.cam_offset_x;
            if (this.exportWidgets.cam_offset_y) this.exportWidgets.cam_offset_y.value = this.exportParams.cam_offset_y;
            if (this.exportWidgets.cam_zoom) this.exportWidgets.cam_zoom.value = this.exportParams.cam_zoom;
            if (this.viewer) this.viewer.snapToCaptureCamera(
                this.exportParams.view_width,
                this.exportParams.view_height,
                this.exportParams.cam_zoom,
                this.exportParams.cam_offset_x,
                this.exportParams.cam_offset_y
            );
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

        // Image files → parse as OpenPose image
        if (file.type.startsWith("image/")) {
            const reader = new FileReader();
            reader.onload = (event) => {
                const img = new Image();
                img.onload = () => {
                    const keypoints = extractKeypointsFromImage(img);
                    if (keypoints && this.viewer && this.viewer.isInitialized()) {
                        const poseData = convertOpenPoseToPose(keypoints, this.viewer);
                        if (poseData) {
                            this.poses[this.activeTab] = poseData;
                            this.viewer.setPose(poseData);
                            this.updateRotationSliders();
                            this.syncToNode(false);
                            this.showMessage("OpenPose image imported successfully.");
                        } else {
                            this.showMessage("Failed to convert OpenPose keypoints to pose.", true);
                        }
                    } else {
                        this.showMessage("Could not detect OpenPose keypoints in image.", true);
                    }
                };
                img.src = event.target.result;
                e.target.value = '';
            };
            reader.readAsDataURL(file);
            return;
        }

        // JSON files
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const data = JSON.parse(event.target.result);

                // Try OpenPose JSON formats first
                const openPoseKeypoints = detectAndParseJSON(data);
                if (openPoseKeypoints) {
                    if (this.viewer && this.viewer.isInitialized()) {
                        const poseData = convertOpenPoseToPose(openPoseKeypoints, this.viewer);
                        if (poseData) {
                            this.poses[this.activeTab] = poseData;
                            this.viewer.setPose(poseData);
                            this.updateRotationSliders();
                            this.syncToNode(false);

                            this.showMessage("OpenPose JSON imported successfully.");

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
                        this.poses = newPoses;
                        this.activeTab = 0;
                        this.updateTabs();
                        // Load first pose
                        if (this.viewer && this.viewer.isInitialized()) {
                            this.viewer.setPose(this.poses[0]);
                            this.updateRotationSliders();
                        }
                    }
                    this.syncToNode(true);
                } else if (data.type === "single_pose" || data.bones) {
                    // Import Single to current tab
                    const poseData = data.bones ? data : data;

                    this.poses[this.activeTab] = poseData;
                    if (this.viewer && this.viewer.isInitialized()) {
                        this.viewer.setPose(poseData);
                        this.updateRotationSliders();
                    }
                    this.syncToNode(false);
                }

            } catch (err) {
                console.error("Error importing pose:", err);
                this.showMessage("Failed to load pose file. Invalid JSON.", true);
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
            const dataUrl = event.target.result;
            if (this.viewer) {
                this.viewer.loadReferenceImage(dataUrl);
                this.exportParams.background_url = dataUrl;
                this.syncToNode(false);

                // Force model update (preview button effect) to fix camera shift
                this.loadModel(false);

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

    showLibraryModal() {
        const overlay = document.createElement('div');
        overlay.className = 'vnccs-ps-modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'vnccs-ps-library-modal';
        modal.innerHTML = `
            <div class="vnccs-ps-library-modal-header">
                <div class="vnccs-ps-library-modal-title">📚 Pose Library</div>
                <button class="vnccs-ps-modal-close">✕</button>
            </div>
            <div class="vnccs-ps-library-modal-grid"></div>
            <div class="vnccs-ps-library-modal-footer">
                 <button class="vnccs-ps-btn primary" style="width: auto; padding: 10px 20px;">
                    <span class="vnccs-ps-btn-icon">💾</span> Save Current Pose
                </button>
            </div>
        `;

        this.libraryGrid = modal.querySelector('.vnccs-ps-library-modal-grid');

        modal.querySelector('.vnccs-ps-modal-close').onclick = () => overlay.remove();
        modal.querySelector('.vnccs-ps-library-modal-footer button').onclick = () => this.showSaveToLibraryModal();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

        overlay.appendChild(modal);
        this.container.appendChild(overlay);

        this.refreshLibrary();
    }

    async refreshLibrary(forceFull = false) {
        try {
            const res = await fetch('/vnccs/pose_library/list' + (forceFull ? '?full=true' : ''));
            const data = await res.json();
            this.libraryPoses = data.poses || []; // Cache for random selection

            if (!this.libraryGrid) {
                this.libraryGrid = document.querySelector('.vnccs-ps-library-modal-grid');
            }
            if (!this.libraryGrid) return; // Still not found (modal closed)

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

                item.onclick = () => {
                    this.loadFromLibrary(pose.name);
                    const overlay = item.closest('.vnccs-ps-modal-overlay');
                    if (overlay) overlay.remove();
                };

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
            if (this.libraryGrid) {
                this.libraryGrid.innerHTML = '<div class="vnccs-ps-library-empty">Failed to load library.</div>';
            }
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
                // Refresh modal if open
                const libraryGrid = document.querySelector('.vnccs-ps-library-modal-grid');
                if (libraryGrid) this.refreshLibrary(false);
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
            this.refreshLibrary(false);
        } catch (err) {
            console.error("Failed to save pose:", err);
        }
    }

    async loadFromLibrary(name) {
        console.log("[VNCCS PoseStudio] loadFromLibrary triggered for:", name);
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
        content.appendChild(debugRow);

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
        content.appendChild(portraitRow);

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
        content.appendChild(keepLightRow);

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
            this.refreshLibrary(false);
        } catch (err) {
            console.error("Failed to delete pose:", err);
        }
    }

    loadModel(showOverlay = true) {
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
                    this.viewer.setPose(this.poses[this.activeTab] || {});
                    this.updateRotationSliders();
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

        if (this.isMeshUpdating) return;
        this.isMeshUpdating = true;
        this.pendingMeshUpdate = false;

        this.loadModel(false).finally(() => {
            this.isMeshUpdating = false;
            if (this.pendingMeshUpdate) {
                this.onMeshParamsChanged();
            }
        });
    }

    resize() {
        if (this.viewer && this.canvasContainer) {
            // Always measure the actual canvas container to ensure perfect aspect ratio.
            // rect.width is in screen pixels, divide by zoom factor to get logical CSS pixels for Three.js.
            const rect = this.canvasContainer.getBoundingClientRect();
            const zoomFactor = 1.0;
            const targetW = Math.round(rect.width / zoomFactor);
            const targetH = Math.round(rect.height / zoomFactor);

            // Guard against feedback loops: skip if size hasn't materially changed.
            // Without this, getBoundingClientRect → setSize → style change → rect grows → infinite loop
            // on some systems with non-integer DPI or zoom scaling.
            if (targetW > 1 && targetH > 1) {
                const dw = Math.abs(targetW - (this._lastResizeW || 0));
                const dh = Math.abs(targetH - (this._lastResizeH || 0));
                if (dw < 2 && dh < 2) return; // No meaningful change

                this._lastResizeW = targetW;
                this._lastResizeH = targetH;
                this.viewer.resize(targetW, targetH);
            }
        }
    }

    /**
     * Generate a natural language prompt from light parameters.
     * Maps RGB colors to basic names and describes position/intensity.
     */
    generatePromptFromLights(lights) {
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
        const userPromptString = (this.exportParams.user_prompt || "").trim();

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

    syncToNode(fullCapture = false) {
        if (this._isSyncing) return;
        this._isSyncing = true;

        if (this.radarRedraw) this.radarRedraw();

        // Save current pose before syncing (only if we are NOT in a sub-sync loop)
        if (!fullCapture && this.viewer && this.viewer.isInitialized()) {
            const syncPose = this.viewer.getPose();
            syncPose.cameraParams = {
                offset_x: this.exportParams.cam_offset_x,
                offset_y: this.exportParams.cam_offset_y,
                zoom: this.exportParams.cam_zoom
            };
            this.poses[this.activeTab] = syncPose;
        }

        // Cache Handling
        if (!this.poseCaptures) this.poseCaptures = [];
        if (!this.lightingPrompts) this.lightingPrompts = [];

        // Ensure size
        while (this.poseCaptures.length < this.poses.length) this.poseCaptures.push(null);
        while (this.poseCaptures.length > this.poses.length) this.poseCaptures.pop();

        while (this.lightingPrompts.length < this.poses.length) this.lightingPrompts.push("");
        while (this.lightingPrompts.length > this.poses.length) this.lightingPrompts.pop();

        // Capture Image (CSR)
        if (this.viewer && this.viewer.isInitialized()) {
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
                        console.log("PoseStudio: Randomizing due to debugMode=true");
                        // Generate fresh random params for each pose
                        const debugParams = this.generateDebugParams();

                        // Random Pose logic...
                        let randomPoseUsed = false;
                        if (this.libraryPoses && this.libraryPoses.length > 0) {
                            const randIdx = Math.floor(Math.random() * this.libraryPoses.length);
                            const poseItem = this.libraryPoses[randIdx];
                            if (poseItem.data) {
                                this.viewer.setPose(poseItem.data);
                                randomPoseUsed = true;
                            }
                        }
                        if (!randomPoseUsed) this.viewer.setPose(this.poses[i]);

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
                        this.lightingPrompts[i] = this.generatePromptFromLights(promptLights);
                    } else {
                        // Normal mode
                        this.viewer.setPose(this.poses[i]);
                        const poseCam = this.poses[i].cameraParams || {};
                        const z = poseCam.zoom || this.exportParams.cam_zoom || 1.0;
                        const oX = (poseCam.offset_x !== undefined ? poseCam.offset_x : this.exportParams.cam_offset_x) || 0;
                        const oY = (poseCam.offset_y !== undefined ? poseCam.offset_y : this.exportParams.cam_offset_y) || 0;

                        // Lighting Toggle
                        if (isOriginalLighting) {
                            this.viewer.updateLights([{ type: 'ambient', color: '#ffffff', intensity: 1.0 }]);
                        } else {
                            this.viewer.updateLights(this.lightParams);
                        }

                        this.poseCaptures[i] = this.viewer.capture(w, h, z, bg, oX, oY);
                        this.lightingPrompts[i] = this.generatePromptFromLights(isOriginalLighting ? [] : this.lightParams);
                    }
                }

                // Restore original state and UI
                this.viewer.updateLights(userLights);
                this.activeTab = originalTab;
                this.viewer.setPose(this.poses[this.activeTab]);
                this.updateTabs(); // Ensure UI reflects correct tab
                this.updateRotationSliders();

                // Restore Camera Visualization
                const z = this.exportParams.cam_zoom || 1.0;
                const oX = this.exportParams.cam_offset_x || 0;
                const oY = this.exportParams.cam_offset_y || 0;
                this.viewer.updateCaptureCamera(w, h, z, oX, oY);

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

                    this.poseCaptures[this.activeTab] = this.viewer.capture(w, h, debugParams.zoom, debugParams.bgColor, debugParams.offsetX, debugParams.offsetY);

                    const promptLights = isOriginalLighting ? [{ type: 'ambient', color: '#ffffff', intensity: 1.0 }] : (debugParams.lights || userLights);
                    this.lightingPrompts[this.activeTab] = this.generatePromptFromLights(promptLights);

                    this.viewer.updateLights(userLights);
                    this.viewer.setPose(this.poses[this.activeTab]);

                    const z = this.exportParams.cam_zoom || 1.0;
                    const oX = this.exportParams.cam_offset_x || 0;
                    const oY = this.exportParams.cam_offset_y || 0;
                    this.viewer.updateCaptureCamera(w, h, z, oX, oY);
                } else {
                    const z = this.exportParams.cam_zoom || 1.0;
                    const oX = this.exportParams.cam_offset_x || 0;
                    const oY = this.exportParams.cam_offset_y || 0;

                    if (isOriginalLighting) {
                        this.viewer.updateLights([{ type: 'ambient', color: '#ffffff', intensity: 1.0 }]);
                    } else {
                        this.viewer.updateLights(this.lightParams);
                    }

                    this.poseCaptures[this.activeTab] = this.viewer.capture(w, h, z, bg, oX, oY);
                    this.lightingPrompts[this.activeTab] = this.generatePromptFromLights(isOriginalLighting ? [] : this.lightParams);

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
            console.log("[VNCCS PoseStudio] syncToNode saved data to widget. capture_id:", captureId, "captures count:", this.poseCaptures.length);

            // Force ComfyUI to recognize the state change so it saves to the workflow
            if (widget.callback) {
                widget.callback(widget.value);
            }
            if (app.graph && app.graph.setDirtyCanvas) {
                app.graph.setDirtyCanvas(true, true);
            }
        }

        this._isSyncing = false;
    }

    loadFromNode() {
        console.log("[VNCCS PoseStudio] loadFromNode started");
        // Load from pose_data widget
        const widget = this.node.widgets?.find(w => w.name === "pose_data");
        if (!widget || !widget.value) {
            console.log("[VNCCS PoseStudio] loadFromNode: No widget or widget value found.");
            return;
        }

        try {
            const data = JSON.parse(widget.value);
            console.log("[VNCCS PoseStudio] loadFromNode data parsed successfully. Includes poses:", !!data.poses);

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

                // Sync user_prompt to sidebar if it exists
                if (data.export.user_prompt !== undefined && this.userPromptArea) {
                    this.userPromptArea.value = data.export.user_prompt;
                    // Trigger auto-expand
                    this.userPromptArea.style.height = 'auto';
                    this.userPromptArea.style.height = (this.userPromptArea.scrollHeight) + 'px';
                }
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
            if (this.updateOverrideBtn) this.updateOverrideBtn();

            if (data.poses && Array.isArray(data.poses)) {
                this.poses = data.poses;
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
                    const poseWidget = node.widgets.find(w => w.name === "pose_data");
                    if (poseWidget) {
                        const widgetData = JSON.parse(poseWidget.value);
                        const payload = {
                            ...widgetData,
                            node_id: nodeId,
                            // Inject captured_images from JS memory (not stored in widget to avoid size overflow)
                            captured_images: node.studioWidget.poseCaptures || [],
                            lighting_prompts: node.studioWidget.lightingPrompts || []
                        };

                        await fetch('/vnccs/pose_sync/upload_capture', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
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
                if (this.studioWidget) this.studioWidget.refreshLibrary(false);
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
                clearTimeout(this.resizeTimer);
                this.resizeTimer = setTimeout(() => {
                    this.studioWidget.resize();
                }, 50);
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
                    this.studioWidget.refreshLibrary(false); // Pre-load library meta only
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
    }
});
