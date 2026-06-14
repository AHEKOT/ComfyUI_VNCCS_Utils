/**
 * VNCCS UniCanvas - in-node infinite canvas for SDXL img2img/inpaint.
 */

import { app } from "../../scripts/app.js";

const STYLES = `
.vnccs-unicanvas {
  --uc-bg:#0a0a0f; --uc-panel:rgba(20,16,30,.82); --uc-surface:rgba(30,28,44,.9);
  --uc-hover:rgba(44,40,62,.95); --uc-border:rgba(255,255,255,.08);
  --uc-accent:#ff8fa3; --uc-accent-2:#b8a9e8; --uc-text:#e8e8f0; --uc-muted:#9898a8;
  --uc-danger:#ff4757; --uc-good:#00d68f; --uc-font:'Sora',-apple-system,BlinkMacSystemFont,sans-serif;
  --vnccs-uc-ui-scale:1;
  width:100%; height:100%; display:grid; grid-template-columns:auto minmax(0,1fr) auto;
  grid-template-rows:auto 34px minmax(0,1fr); background:var(--uc-bg); color:var(--uc-text);
  font:11px var(--uc-font); overflow:hidden; border-radius:12px; pointer-events:auto; position:relative; box-sizing:border-box;
}
.vnccs-uc-stage-wrap { grid-column:2; grid-row:3; position:relative; min-width:0; min-height:0; overflow:hidden; border-radius:8px; }
.vnccs-uc-stage { width:100%; height:100%; display:block; background:#07070c; cursor:crosshair; }
.vnccs-uc-hud { position:absolute; left:10px; top:10px; display:flex; gap:6px; align-items:center; pointer-events:none; }
.vnccs-uc-chip { background:rgba(10,10,15,.72); border:1px solid var(--uc-border); border-radius:8px; padding:5px 8px; color:var(--uc-muted); }
.vnccs-uc-generation-progress { grid-column:2; grid-row:2; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; align-items:center; padding:7px 12px; background:rgba(10,10,15,.9); border-bottom:1px solid rgba(255,143,163,.24); box-sizing:border-box; pointer-events:none; min-width:0; visibility:hidden; opacity:0; transition:opacity .16s ease; }
.vnccs-uc-generation-progress.visible { visibility:visible; opacity:1; }
.vnccs-uc-progress-label { color:var(--uc-text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:700; }
.vnccs-uc-progress-percent { color:var(--uc-muted); font-variant-numeric:tabular-nums; min-width:42px; text-align:right; }
.vnccs-uc-progress-track { grid-column:1 / -1; height:6px; border-radius:999px; background:rgba(255,255,255,.12); overflow:hidden; }
.vnccs-uc-progress-fill { height:100%; width:0%; background:linear-gradient(90deg,var(--uc-accent),var(--uc-accent-2)); border-radius:inherit; transition:width .18s ease; }
.vnccs-uc-left { width:238px; zoom:var(--vnccs-uc-ui-scale); display:flex; flex-direction:column; gap:8px; padding:8px; background:rgba(6,5,12,.72); min-height:0; box-sizing:border-box; overflow:auto; }
.vnccs-uc-side { width:286px; zoom:var(--vnccs-uc-ui-scale); display:flex; flex-direction:column; gap:8px; padding:8px; background:rgba(6,5,12,.72); min-height:0; box-sizing:border-box; overflow:auto; }
.vnccs-uc-left { grid-column:1; grid-row:1 / span 3; border-right:1px solid var(--uc-border); }
.vnccs-uc-side { grid-column:3; grid-row:1 / span 3; border-left:1px solid var(--uc-border); overflow:hidden; }
.vnccs-uc-section { background:var(--uc-panel); border:1px solid rgba(255,143,163,.2); border-radius:12px; overflow:hidden; box-shadow:0 4px 16px rgba(0,0,0,.35); }
.vnccs-uc-side-control { background:var(--uc-panel); border:1px solid rgba(255,143,163,.2); border-radius:12px; padding:8px; box-shadow:0 4px 16px rgba(0,0,0,.35); }
.vnccs-uc-draw-control { background:var(--uc-panel); border:1px solid rgba(255,143,163,.2); border-radius:12px; padding:8px; box-shadow:0 4px 16px rgba(0,0,0,.35); }
.vnccs-uc-draw-control .vnccs-uc-btn { width:100%; height:34px; font-weight:800; }
.vnccs-uc-denoise-control { display:grid; grid-template-columns:auto minmax(0,1fr) 58px; gap:8px; align-items:center; color:var(--uc-muted); font-weight:700; }
.vnccs-uc-denoise-control .vnccs-uc-range { width:100%; }
.vnccs-uc-denoise-control .vnccs-uc-input { width:58px; box-sizing:border-box; text-align:right; }
.vnccs-uc-layers-section { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; }
.vnccs-uc-section-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:7px 9px; color:var(--uc-accent); font-weight:700; border-bottom:1px solid var(--uc-border); }
.vnccs-uc-section-title { flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vnccs-uc-section-actions { flex:0 0 auto; display:flex; gap:4px; align-items:center; }
.vnccs-uc-section-actions .vnccs-uc-icon { width:24px; height:24px; border-radius:7px; }
.vnccs-uc-section-actions .vnccs-uc-icon svg { width:14px; height:14px; }
.vnccs-uc-layers { flex:1 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden; overscroll-behavior:contain; padding:6px; display:flex; flex-direction:column; gap:5px; }
.vnccs-uc-layer-subhead { padding:8px; border-bottom:1px solid var(--uc-border); display:grid; grid-template-columns:92px minmax(0,1fr); gap:8px; align-items:center; }
.vnccs-uc-layer-subhead .vnccs-uc-select { width:100%; }
.vnccs-uc-layer-opacity { display:grid; grid-template-columns:auto minmax(72px,1fr) 38px; gap:7px; align-items:center; color:var(--uc-muted); font-weight:700; }
.vnccs-uc-layer-opacity .vnccs-uc-range { width:100%; }
.vnccs-uc-layer-opacity-value { color:var(--uc-muted); text-align:right; font-variant-numeric:tabular-nums; }
.vnccs-uc-layers-top-actions { padding:6px; border-bottom:1px solid var(--uc-border); display:flex; flex-direction:column; gap:6px; }
.vnccs-uc-layers-top-actions .vnccs-uc-btn { width:100%; }
.vnccs-uc-layer { display:grid; grid-template-columns:34px minmax(0,1fr) 28px 28px; gap:6px; align-items:center; padding:6px; border:1px solid var(--uc-border); border-radius:8px; background:rgba(255,255,255,.035); cursor:pointer; }
.vnccs-uc-layer.active { border-color:rgba(255,143,163,.55); background:rgba(255,143,163,.12); }
.vnccs-uc-layer.dragging { opacity:.46; }
.vnccs-uc-layer.drop-before { box-shadow:0 -2px 0 var(--uc-accent); }
.vnccs-uc-layer.drop-after { box-shadow:0 2px 0 var(--uc-accent); }
.vnccs-uc-thumb { width:34px; height:34px; border:1px solid var(--uc-border); border-radius:8px; background:rgba(255,255,255,.04); object-fit:cover; display:block; }
.vnccs-uc-layer-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vnccs-uc-layer-type { color:var(--uc-muted); font-size:10px; }
.vnccs-uc-bottom { grid-column:2; grid-row:1; zoom:var(--vnccs-uc-ui-scale); display:flex; gap:8px; align-items:center; padding:8px; border-bottom:1px solid var(--uc-border); background:rgba(6,5,12,.75); box-sizing:border-box; min-width:0; }
.vnccs-uc-tools { position:absolute; z-index:6; left:16px; top:50%; transform:translateY(-50%); display:flex; flex-direction:column; align-items:stretch; gap:9px; padding:12px; border:1px solid var(--uc-border); border-radius:18px; background:rgba(10,10,15,.84); box-shadow:0 10px 28px rgba(0,0,0,.42); pointer-events:auto; }
.vnccs-uc-tool-settings { position:absolute; z-index:6; left:16px; top:52px; display:none; flex-direction:column; gap:10px; width:248px; padding:14px; border:1px solid var(--uc-border); border-radius:14px; background:rgba(10,10,15,.86); box-shadow:0 10px 28px rgba(0,0,0,.42); pointer-events:auto; }
.vnccs-uc-tool-settings.visible { display:flex; }
.vnccs-uc-tool-settings-title { color:var(--uc-accent); font-weight:800; font-size:14px; }
.vnccs-uc-tool-setting { display:grid; grid-template-columns:72px minmax(0,1fr); align-items:center; gap:10px; color:var(--uc-muted); font-weight:700; }
.vnccs-uc-tool-setting-label { color:var(--uc-muted); font-size:12px; line-height:1; white-space:nowrap; }
.vnccs-uc-tool-settings .vnccs-uc-range { width:100%; accent-color:var(--uc-accent); }
.vnccs-uc-tool-settings .vnccs-uc-input[type="color"] { width:42px; height:28px; padding:0; border-radius:7px; }
.vnccs-uc-settings { display:flex; align-items:center; gap:6px; min-width:0; }
.vnccs-uc-settings { overflow:auto; flex:1 1 auto; }
.vnccs-uc-settings-spacer { flex:1 1 auto; min-width:16px; }
.vnccs-uc-btn, .vnccs-uc-icon { border:1px solid var(--uc-border); background:var(--uc-surface); color:var(--uc-text); border-radius:8px; height:28px; padding:0 9px; cursor:pointer; font:inherit; white-space:nowrap; }
.vnccs-uc-icon { width:30px; padding:0; display:grid; place-items:center; }
.vnccs-uc-icon svg { width:16px; height:16px; display:block; fill:none; stroke:currentColor; stroke-width:2.2; stroke-linecap:round; stroke-linejoin:round; }
.vnccs-uc-icon svg .fill { fill:currentColor; stroke:none; }
.vnccs-uc-icon.danger { color:var(--uc-danger); border-color:rgba(255,71,87,.38); }
.vnccs-uc-layer .vnccs-uc-icon { width:28px; height:28px; border-radius:7px; }
.vnccs-uc-tools .vnccs-uc-icon { width:66px; height:66px; border-radius:12px; font-size:18px; font-weight:800; }
.vnccs-uc-tools svg { width:36px; height:36px; display:block; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
.vnccs-uc-tools svg .fill { fill:currentColor; stroke:none; }
.vnccs-uc-btn:hover, .vnccs-uc-icon:hover { background:var(--uc-hover); border-color:rgba(255,255,255,.16); }
.vnccs-uc-btn:disabled, .vnccs-uc-icon:disabled { opacity:.38; cursor:not-allowed; }
.vnccs-uc-btn:disabled:hover, .vnccs-uc-icon:disabled:hover { background:var(--uc-surface); border-color:var(--uc-border); }
.vnccs-uc-btn.primary { background:linear-gradient(135deg,var(--uc-accent),var(--uc-accent-2)); color:#120b13; font-weight:800; border:0; }
.vnccs-uc-btn.danger { color:#ffdce1; border-color:rgba(255,71,87,.35); }
.vnccs-uc-icon.active { border-color:rgba(255,143,163,.7); background:rgba(255,143,163,.18); color:#ffdce5; }
.vnccs-uc-tool.active { border-color:rgba(255,143,163,.7); background:rgba(255,143,163,.18); color:#ffdce5; }
.vnccs-uc-input, .vnccs-uc-select, .vnccs-uc-textarea { background:rgba(255,255,255,.045); border:1px solid var(--uc-border); color:var(--uc-text); border-radius:8px; height:28px; padding:0 8px; font:inherit; min-width:0; }
.vnccs-uc-textarea { height:54px; padding:7px 8px; resize:none; width:100%; box-sizing:border-box; }
.vnccs-uc-field { display:flex; flex-direction:column; gap:4px; min-width:62px; color:var(--uc-muted); }
.vnccs-uc-field.inline { flex-direction:row; align-items:center; }
.vnccs-uc-range { width:82px; accent-color:var(--uc-accent); }
.vnccs-uc-mini-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px; padding:8px; }
.vnccs-uc-stack { display:flex; flex-direction:column; gap:6px; padding:8px; }
.vnccs-uc-draw-footer { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; align-items:center; padding-top:2px; }
.vnccs-uc-status { min-height:16px; color:var(--uc-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vnccs-uc-layers-footer { padding:6px; border-top:1px solid var(--uc-border); display:flex; flex-direction:column; gap:6px; }
.vnccs-uc-layers-footer .vnccs-uc-btn { width:100%; }
.vnccs-uc-file { display:none; }
.vnccs-uc-row { display:flex; gap:6px; align-items:center; }
.vnccs-uc-staging-popover {
  position:absolute; display:none; gap:8px; align-items:center; justify-content:center; z-index:5;
  padding:10px; background:rgba(10,10,15,.9); border:1px solid rgba(255,255,255,.16);
  border-radius:12px; box-shadow:0 10px 28px rgba(0,0,0,.42); pointer-events:auto;
}
.vnccs-uc-staging-popover.visible { display:flex; }
.vnccs-uc-staging-popover .vnccs-uc-icon { width:44px; height:44px; border-radius:10px; }
.vnccs-uc-staging-popover .vnccs-uc-icon svg { width:22px; height:22px; }
.vnccs-uc-staging-count { min-width:48px; text-align:center; color:var(--uc-text); font-weight:800; font-size:14px; }
.vnccs-uc-modal-overlay {
  position:absolute; inset:0; z-index:20; display:grid; place-items:center;
  background:rgba(4,4,8,.58); pointer-events:auto;
}
.vnccs-uc-modal {
  width:min(560px, calc(100% - 72px)); background:var(--uc-panel); color:var(--uc-text);
  border:1px solid rgba(255,143,163,.34); border-radius:12px; box-shadow:0 18px 48px rgba(0,0,0,.55);
  padding:22px; display:flex; flex-direction:column; gap:16px; font-size:16px; line-height:1.45;
}
.vnccs-uc-modal-title { color:var(--uc-accent); font-weight:800; font-size:18px; }
.vnccs-uc-modal-message { color:var(--uc-text); line-height:1.5; }
.vnccs-uc-modal-actions { display:flex; justify-content:flex-end; gap:8px; }
.vnccs-uc-modal-actions .vnccs-uc-btn { height:34px; padding:0 14px; font-size:14px; }
`;

if (!document.getElementById("vnccs-unicanvas-styles")) {
  const style = document.createElement("style");
  style.id = "vnccs-unicanvas-styles";
  style.textContent = STYLES;
  document.head.appendChild(style);
}

const uid = () => `uc_${Math.random().toString(36).slice(2, 10)}`;
const MASK_OVERLAY_COLOR = "rgba(255, 143, 163, 0.48)";
const STAGE_MIN_SCALE = 0.1;
const STAGE_MAX_SCALE = 20;
const STAGE_FIT_PADDING_PX = 48;
const STAGE_SCALE_FACTOR = 0.999;
const STAGE_SNAP_POINTS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5];
const STAGE_SNAP_TOLERANCE = 0.02;
const ZOOM_DRAG_PIXELS_PER_DOUBLING = 240;
const MAX_LAYER_CANVAS_SIDE = 8192;
const MAX_LAYER_CANVAS_PIXELS = 32 * 1024 * 1024;
const STATE_UPLOAD_DEBOUNCE_MS = 1200;
const HISTORY_LIMIT = 20;
const MOVE_SNAP_GRID_SIZE = 64;
const TOOL_ICONS = {
  move: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18"/><path d="M3 12h18"/><path d="m8 7 4-4 4 4"/><path d="m8 17 4 4 4-4"/><path d="m7 8-4 4 4 4"/><path d="m17 8 4 4-4 4"/></svg>`,
  brush: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5 19 10"/><path d="M4 20c3 0 5-1 6.5-2.5L19 9a2.8 2.8 0 0 0-4-4l-8.5 8.5C5 15 4 17 4 20Z"/><path d="M6.5 13.5 10.5 17.5"/></svg>`,
  eraser: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 15 8-8a3 3 0 0 1 4.2 0l3.8 3.8a3 3 0 0 1 0 4.2l-5 5H9Z"/><path d="m9 20-5-5"/><path d="m10.5 8.5 6 6"/><path d="M14 20h7"/></svg>`,
  mask: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8c2.6-2 5.3-3 8-3s5.4 1 8 3v4c0 4.8-3.2 8-8 8s-8-3.2-8-8Z"/><path d="M12 5v15"/><path d="M7.5 12.5h2"/><path d="M14.5 12.5h2"/><path d="M9 16c1.8 1 4.2 1 6 0"/></svg>`,
  rect: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="6" width="14" height="12" rx="1.5"/><path d="M8 6v12"/><path d="M16 6v12"/></svg>`,
  lasso: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 18c-2.5-1.2-4-3.2-4-5.5C4 8.9 7.6 6 12 6s8 2.9 8 6.5S16.4 19 12 19c-1.2 0-2.3-.2-3.3-.6"/><path d="M8 18 5 21"/><path d="M5 21h5"/></svg>`,
  resize: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1.5"/><path d="M9 9h6v6H9Z"/><path d="M5 2v3H2"/><path d="M19 2v3h3"/><path d="M5 22v-3H2"/><path d="M19 22v-3h3"/></svg>`,
  bbox: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3v4H3"/><path d="M17 3v4h4"/><path d="M7 21v-4H3"/><path d="M17 21v-4h4"/><rect x="7" y="7" width="10" height="10" rx="1.5" stroke-dasharray="3 2"/></svg>`,
  pan: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 12V7.5a1.5 1.5 0 0 1 3 0V12"/><path d="M11 11V6.5a1.5 1.5 0 0 1 3 0V12"/><path d="M14 11V8a1.5 1.5 0 0 1 3 0v5"/><path d="M8 12 6.8 10.8a1.6 1.6 0 0 0-2.2 2.3l4.7 5.1A6 6 0 0 0 19 14v-2a1.5 1.5 0 0 0-3 0"/></svg>`,
};
const UI_ICONS = {
  plus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
  mask: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="13" height="13" rx="2" stroke-dasharray="3 2"/><circle cx="10.5" cy="11.5" r="3.2" class="fill"/><path d="M18 14v6"/><path d="M15 17h6"/></svg>`,
  duplicate: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="10" height="10" rx="1.5"/><rect x="5" y="5" width="10" height="10" rx="1.5"/></svg>`,
  up: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>`,
  down: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>`,
  unlock: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.2-2.4"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 14h10l1-14"/><path d="M9 7V4h6v3"/></svg>`,
  undo: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 4 12l5 5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>`,
  redo: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 7 5 5-5 5"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg>`,
  snap: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14"/><path d="M5 12h14"/><path d="M5 19h14"/><path d="M5 5v14"/><path d="M12 5v14"/><path d="M19 5v14"/><path d="m14.5 9.5 3 3-3 3"/><path d="M8 12h9"/></svg>`,
};
const STAGING_ICONS = {
  discard: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>`,
  prev: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>`,
  next: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`,
  show: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="3"/></svg>`,
  hide: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 10.6A3 3 0 0 0 13.4 13.4"/><path d="M9.9 5.2A9.8 9.8 0 0 1 12 5c6 0 9.5 7 9.5 7a17.4 17.4 0 0 1-2.4 3.2"/><path d="M6.1 6.7C3.8 8.3 2.5 12 2.5 12s3.5 7 9.5 7a9.7 9.7 0 0 0 4-.8"/></svg>`,
  accept: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`,
};

class UniCanvasWidget {
  constructor(node) {
    this.node = node;
    this.container = document.createElement("div");
    this.container.className = "vnccs-unicanvas";
    this.layers = [];
    this.activeLayerId = null;
    this.tool = "move";
    this.view = { x: 0, y: 0, scale: 1 };
    this.origin = { x: -512, y: -512 };
    this.size = { width: 2048, height: 2048 };
    this.bbox = { x: 0, y: 0, width: 1024, height: 1024 };
    this.shapeDraft = null;
    this.shapeComposite = "source-over";
    this.lassoPoints = [];
    this.hoverPoint = null;
    this.hoverPointerType = "mouse";
    this.brushSize = 48;
    this.lastDrawPointByTool = { brush: null, eraser: null, mask: null };
    this.opacity = 1;
    this.fg = "#ffffff";
    this.resizeKeepAspect = false;
    this.isPointerDown = false;
    this.pointerMode = null;
    this.lastPoint = null;
    this.dragStart = null;
    this.zoomDragStart = null;
    this.intendedScale = 1;
    this.activeSnapPoint = null;
    this.lastScrollEventTimestamp = null;
    this.snapTimeout = null;
    this.didInitialCenter = false;
    this._isRestoring = true;
    this.stateCacheId = `vnccs_unicanvas_${this.node?.id ?? uid()}`;
    this.stateUploadTimer = null;
    this.lastUploadedStateJSON = "";
    this.pendingStateUpload = null;
    this.stagingItems = [];
    this.activeStagingIndex = -1;
    this.drawInProgress = false;
    this.drawProgressTimer = null;
    this.renderQueued = false;
    this.deferredCanvasCommitTimer = null;
    this.undoStack = [];
    this.redoStack = [];
    this.historyRestoring = false;
    this.snapToGrid = false;
    this.assets = { checkpoints: [], diffusion_models: [], text_encoders: [], vae_models: [], loras: [], samplers: [], schedulers: [] };
    this.checkpoints = [];
    this.settings = {
      generation_mode: "illustrious",
      ckpt_name: "",
      diffusion_model_name: "",
      clip_name: "qwen_3_06b_base.safetensors",
      vae_name: "qwen_image_vae.safetensors",
      clip_type: "stable_diffusion",
      turbo_enabled: false,
      dmd_lora_name: "anima\\anima-turbo-lora-v0.1.safetensors",
      dmd_lora_strength: 1,
      lora_stack: [],
      inference_scale: 1,
      positive: "",
      negative: "",
      seed: 0,
      steps: 24,
      cfg: 7,
      denoise: 0.65,
      sampler_name: "euler",
      scheduler: "normal",
      grow_mask_by: 6,
    };

    this._buildDOM();
    this._createInitialLayers();
    this._loadFromNode().finally(() => {
      this._isRestoring = false;
      this.fitInitialView();
      this.renderLayerList();
      this.render();
    });
    this._loadAssets();
    this._attachEvents();
    this.resize();
    this.render();
  }

  _buildDOM() {
    this.generationProgress = document.createElement("div");
    this.generationProgress.className = "vnccs-uc-generation-progress";
    this.generationProgress.innerHTML = `
      <div class="vnccs-uc-progress-label">Ready</div>
      <div class="vnccs-uc-progress-percent">0%</div>
      <div class="vnccs-uc-progress-track"><div class="vnccs-uc-progress-fill"></div></div>`;
    this.container.appendChild(this.generationProgress);
    this.stageWrap = document.createElement("div");
    this.stageWrap.className = "vnccs-uc-stage-wrap";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "vnccs-uc-stage";
    this.stageWrap.appendChild(this.canvas);
    this.hud = document.createElement("div");
    this.hud.className = "vnccs-uc-hud";
    this.stageWrap.appendChild(this.hud);
    this.stagingControls = document.createElement("div");
    this.stagingControls.className = "vnccs-uc-staging-popover";
    this.stagingPrevBtn = this._button(STAGING_ICONS.prev, "vnccs-uc-icon", () => this.selectRelativeStaging(-1), "Previous result");
    this.stagingCount = document.createElement("span");
    this.stagingCount.className = "vnccs-uc-staging-count";
    this.stagingNextBtn = this._button(STAGING_ICONS.next, "vnccs-uc-icon", () => this.selectRelativeStaging(1), "Next result");
    this.stagingToggleBtn = this._button(STAGING_ICONS.show, "vnccs-uc-icon", () => this.toggleStagingVisibility(), "Hide result preview");
    this.stagingControls.append(
      this._button(STAGING_ICONS.discard, "vnccs-uc-icon danger", () => this.discardStaging(), "Discard"),
      this.stagingPrevBtn,
      this.stagingCount,
      this.stagingNextBtn,
      this.stagingToggleBtn,
      this._button(STAGING_ICONS.accept, "vnccs-uc-icon", () => this.acceptStaging(), "Accept as layer")
    );
    this.stageWrap.appendChild(this.stagingControls);

    this.left = document.createElement("div");
    this.left.className = "vnccs-uc-left";
    this.side = document.createElement("div");
    this.side.className = "vnccs-uc-side";
    this.denoiseControl = document.createElement("div");
    this.denoiseControl.className = "vnccs-uc-side-control";
    this.denoiseControl.innerHTML = `
      <label class="vnccs-uc-denoise-control">Denoise
        <input class="vnccs-uc-range" data-setting="denoise" type="range" min="0" max="1" step="0.01" value="${this.settings.denoise}">
        <input class="vnccs-uc-input" data-setting="denoise" type="number" min="0" max="1" step="0.01" value="${this.settings.denoise}">
      </label>`;
    this.layerList = document.createElement("div");
    this.layerList.className = "vnccs-uc-layers";
    this.layerSubhead = document.createElement("div");
    this.layerSubhead.className = "vnccs-uc-layer-subhead";
    this.layerSubhead.innerHTML = `
      <select class="vnccs-uc-select" data-layer-control="blendMode">
        <option value="source-over">Normal</option>
        <option value="multiply">Multiply</option>
        <option value="screen">Screen</option>
        <option value="overlay">Overlay</option>
        <option value="darken">Darken</option>
        <option value="lighten">Lighten</option>
        <option value="color-dodge">Color Dodge</option>
        <option value="color-burn">Color Burn</option>
        <option value="hard-light">Hard Light</option>
        <option value="soft-light">Soft Light</option>
        <option value="difference">Difference</option>
        <option value="exclusion">Exclusion</option>
        <option value="hue">Hue</option>
        <option value="saturation">Saturation</option>
        <option value="color">Color</option>
        <option value="luminosity">Luminosity</option>
      </select>
      <label class="vnccs-uc-layer-opacity">Opacity <input class="vnccs-uc-range" type="range" min="0" max="1" step="0.01" data-layer-control="opacity"><span class="vnccs-uc-layer-opacity-value"></span></label>`;
    this.layersTopActions = document.createElement("div");
    this.layersTopActions.className = "vnccs-uc-layers-top-actions";
    this.layersTopActions.append(
      this._button("Import Image", "vnccs-uc-btn", () => this.fileInput.click(), "Import image")
    );
    this.flattenLayersFooter = document.createElement("div");
    this.flattenLayersFooter.className = "vnccs-uc-layers-footer";
    this.flattenLayersFooter.append(
      this._button("Flatten layers", "vnccs-uc-btn danger", () => this.confirmFlattenLayers(), "Flatten all layers"),
      this._button("Export Layers as PSD", "vnccs-uc-btn", () => this.exportPSD(), "Export visible raster layers to PSD")
    );
    const layersBody = document.createElement("div");
    layersBody.className = "vnccs-uc-layers-section";
    layersBody.append(this.layerSubhead, this.layersTopActions, this.layerList, this.flattenLayersFooter);
    const layersSection = this._section("Layers", layersBody, [
      [UI_ICONS.plus, "Add raster", () => this.addLayer("raster")],
      [UI_ICONS.mask, "Add mask", () => this.addLayer("mask")],
      [UI_ICONS.duplicate, "Duplicate selected", () => this.duplicateActiveLayer()],
      [UI_ICONS.up, "Move selected up", () => this.moveActiveLayer(-1)],
      [UI_ICONS.down, "Move selected down", () => this.moveActiveLayer(1)],
    ]);
    layersSection.classList.add("vnccs-uc-layers-section");

    this.promptBox = document.createElement("div");
    this.promptBox.className = "vnccs-uc-stack";
    this.promptBox.innerHTML = `
      <label class="vnccs-uc-field">Prompt<textarea class="vnccs-uc-textarea" data-setting="positive" placeholder="positive prompt"></textarea></label>
      <label class="vnccs-uc-field">Negative<textarea class="vnccs-uc-textarea" data-setting="negative" placeholder="negative prompt"></textarea></label>
      <label class="vnccs-uc-field">Mode<select class="vnccs-uc-select" data-setting="generation_mode">
        <option value="illustrious">SDXL checkpoint</option>
        <option value="anima">Anima</option>
      </select></label>
      <label class="vnccs-uc-field">Inference scale<input class="vnccs-uc-input" data-setting="inference_scale" type="number" min="0.125" step="0.125"></label>
      <label class="vnccs-uc-field">Checkpoint<select class="vnccs-uc-select" data-setting="ckpt_name"></select></label>
      <label class="vnccs-uc-field">Diffusion<select class="vnccs-uc-select" data-setting="diffusion_model_name"></select></label>
      <label class="vnccs-uc-field">CLIP<select class="vnccs-uc-select" data-setting="clip_name"></select></label>
      <label class="vnccs-uc-field">VAE<select class="vnccs-uc-select" data-setting="vae_name"></select></label>
      <div class="vnccs-uc-mini-grid">
        <label class="vnccs-uc-field">Seed<input class="vnccs-uc-input" data-setting="seed" type="number"></label>
        <label class="vnccs-uc-field">Steps<input class="vnccs-uc-input" data-setting="steps" type="number"></label>
        <label class="vnccs-uc-field">CFG<input class="vnccs-uc-input" data-setting="cfg" type="number" step="0.1"></label>
      </div>`;
    this.status = document.createElement("div");
    this.status.className = "vnccs-uc-status";
    this.status.textContent = "Ready";
    this.drawBtn = this._button("DRAW", "vnccs-uc-btn primary", () => this.draw());
    this.drawControl = document.createElement("div");
    this.drawControl.className = "vnccs-uc-draw-control";
    this.drawControl.append(this.drawBtn);
    this.drawFooter = document.createElement("div");
    this.drawFooter.className = "vnccs-uc-draw-footer";
    this.drawFooter.append(this.status);
    this.promptBox.appendChild(this.drawFooter);
    const promptSection = this._section("Draw", this.promptBox);

    this.left.append(this.drawControl, promptSection);
    this.side.append(this.denoiseControl, layersSection);

    this.bottom = document.createElement("div");
    this.bottom.className = "vnccs-uc-bottom";
    this.tools = document.createElement("div");
    this.tools.className = "vnccs-uc-tools";
    [
      ["move", "Move layer"],
      ["brush", "Brush"],
      ["eraser", "Eraser"],
      ["mask", "Mask brush"],
      ["rect", "Rectangle"],
      ["lasso", "Lasso"],
      ["resize", "Resize layer"],
      ["bbox", "Generation bbox"],
      ["pan", "Pan view"],
    ].forEach(([tool, title]) => this.tools.appendChild(this._toolButton(tool, title)));
    this.stageWrap.appendChild(this.tools);
    this.toolSettings = document.createElement("div");
    this.toolSettings.className = "vnccs-uc-tool-settings";
    this.stageWrap.appendChild(this.toolSettings);

    this.settingsBar = document.createElement("div");
    this.settingsBar.className = "vnccs-uc-settings";
    this.undoBtn = this._button(UI_ICONS.undo, "vnccs-uc-icon", () => this.undo(), "Undo");
    this.redoBtn = this._button(UI_ICONS.redo, "vnccs-uc-icon", () => this.redo(), "Redo");
    this.fitBtn = this._button("Fit", "vnccs-uc-btn", () => this.centerBbox(), "Fit");
    this.snapBtn = this._button(UI_ICONS.snap, "vnccs-uc-icon", () => this.toggleSnapToGrid(), "Snap to grid");
    const settingsSpacer = document.createElement("div");
    settingsSpacer.className = "vnccs-uc-settings-spacer";
    this.settingsBar.append(this.undoBtn, this.redoBtn, this.fitBtn, settingsSpacer, this.snapBtn);
    this.updateHistoryButtons();
    this.updateSnapButton();
    this.fileInput = document.createElement("input");
    this.fileInput.className = "vnccs-uc-file";
    this.fileInput.type = "file";
    this.fileInput.accept = "image/*";

    this.bottom.append(this.settingsBar, this.fileInput);

    this.container.append(this.left, this.stageWrap, this.side, this.bottom);
  }

  _section(title, body, actions = []) {
    const section = document.createElement("div");
    section.className = "vnccs-uc-section";
    const head = document.createElement("div");
    head.className = "vnccs-uc-section-head";
    const text = document.createElement("span");
    text.className = "vnccs-uc-section-title";
    text.textContent = title;
    const actionBox = document.createElement("div");
    actionBox.className = "vnccs-uc-section-actions";
    for (const [label, hint, fn] of actions) actionBox.append(this._button(label, "vnccs-uc-icon", fn, hint));
    head.append(text, actionBox);
    section.append(head, body);
    return section;
  }

  _button(label, className, onClick, title = label) {
    const btn = document.createElement("button");
    btn.className = className;
    btn.type = "button";
    if (typeof label === "string" && label.trim().startsWith("<svg")) {
      btn.innerHTML = label;
    } else {
      btn.textContent = label;
    }
    btn.title = title;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick?.();
    });
    return btn;
  }

  parseNumericInput(input, fallback = 0) {
    const normalized = String(input.value ?? "").replace(",", ".");
    if (input.value !== normalized) input.value = normalized;
    const value = Number(normalized);
    return Number.isFinite(value) ? value : fallback;
  }

  formatSettingNumber(value, digits = 2) {
    if (!Number.isFinite(Number(value))) return "0";
    return Number(value).toFixed(digits).replace(/\.?0+$/, "");
  }

  insertDecimalPoint(input) {
    if (String(input.value).includes(".")) return;
    input.value = `${input.value || "0"}.`;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  promptInWidget(title, label, value = "") {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "vnccs-uc-modal-overlay";
      const modal = document.createElement("div");
      modal.className = "vnccs-uc-modal";
      const titleEl = document.createElement("div");
      titleEl.className = "vnccs-uc-modal-title";
      titleEl.textContent = title;
      const field = document.createElement("label");
      field.className = "vnccs-uc-field";
      field.textContent = label;
      const input = document.createElement("input");
      input.className = "vnccs-uc-input";
      input.type = "text";
      input.value = value;
      const actions = document.createElement("div");
      actions.className = "vnccs-uc-modal-actions";
      const cancel = this._button("Cancel", "vnccs-uc-btn", () => close(null), "Cancel");
      const ok = this._button("OK", "vnccs-uc-btn primary", () => close(input.value), "OK");
      const close = (result) => {
        overlay.remove();
        resolve(result);
      };
      field.appendChild(input);
      actions.append(cancel, ok);
      modal.append(titleEl, field, actions);
      overlay.appendChild(modal);
      overlay.addEventListener("pointerdown", (e) => {
        if (e.target === overlay) close(null);
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") close(input.value);
        if (e.key === "Escape") close(null);
      });
      this.container.appendChild(overlay);
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    });
  }

  confirmInWidget(title, message, confirmLabel = "OK") {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "vnccs-uc-modal-overlay";
      const modal = document.createElement("div");
      modal.className = "vnccs-uc-modal";
      const titleEl = document.createElement("div");
      titleEl.className = "vnccs-uc-modal-title";
      titleEl.textContent = title;
      const messageEl = document.createElement("div");
      messageEl.className = "vnccs-uc-modal-message";
      messageEl.textContent = message;
      const actions = document.createElement("div");
      actions.className = "vnccs-uc-modal-actions";
      const cancel = this._button("Cancel", "vnccs-uc-btn", () => close(false), "Cancel");
      const ok = this._button(confirmLabel, "vnccs-uc-btn danger", () => close(true), confirmLabel);
      const close = (result) => {
        overlay.remove();
        resolve(result);
      };
      actions.append(cancel, ok);
      modal.append(titleEl, messageEl, actions);
      overlay.appendChild(modal);
      overlay.addEventListener("pointerdown", (e) => {
        if (e.target === overlay) close(false);
      });
      overlay.addEventListener("keydown", (e) => {
        if (e.key === "Escape") close(false);
        if (e.key === "Enter") close(true);
      });
      this.container.appendChild(overlay);
      requestAnimationFrame(() => {
        ok.focus();
      });
    });
  }

  _toolButton(tool, title) {
    const btn = this._button("", "vnccs-uc-icon vnccs-uc-tool", () => this.setTool(tool), title);
    btn.innerHTML = TOOL_ICONS[tool] || "";
    btn.setAttribute("aria-label", title);
    btn.dataset.tool = tool;
    return btn;
  }

  _createCanvas() {
    const c = document.createElement("canvas");
    c.width = this.size.width;
    c.height = this.size.height;
    return c;
  }

  configureImageContext(ctx, smoothing = true) {
    if (!ctx) return ctx;
    ctx.imageSmoothingEnabled = smoothing;
    if (smoothing) ctx.imageSmoothingQuality = "high";
    return ctx;
  }

  _createInitialLayers() {
    if (this.layers.length) return;
    this.addLayer("raster", "Base Layer");
    this.addLayer("mask", "Inpaint Mask");
    this.activeLayerId = this.layers[0].id;
  }

  addLayer(type = "raster", name = null, recordHistory = true) {
    if (recordHistory) this.recordHistoryBefore();
    const layer = {
      id: uid(),
      name: name || this.getNextLayerName(type),
      type,
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: "source-over",
      canvas: this._createCanvas(),
    };
    this.invalidateLayerCaches(layer);
    this.layers.unshift(layer);
    this.activeLayerId = layer.id;
    this.renderLayerList();
    this.render();
    this.syncToNode();
    return layer;
  }

  getNextLayerName(type = "raster") {
    const prefix = type === "mask" ? "Mask" : "Layer";
    const matcher = new RegExp(`^${prefix} (\\d+)$`);
    let max = 0;
    for (const layer of this.layers) {
      const match = String(layer.name || "").match(matcher);
      if (match) max = Math.max(max, Number(match[1]));
    }
    return `${prefix} ${max + 1}`;
  }

  invalidateLayerCaches(layer) {
    if (!layer) return;
    layer._boundsCache = undefined;
    layer._thumbCache = undefined;
  }

  markLayerPixelsChanged(layer, bounds = null, expandOnly = false) {
    if (!layer) return;
    layer._thumbCache = undefined;
    if (!expandOnly) {
      layer._boundsCache = undefined;
      return;
    }
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    const next = this.clampCanvasBounds(bounds, layer.canvas);
    if (!next) return;
    if (layer._boundsCache === undefined) return;
    if (layer._boundsCache === null) {
      layer._boundsCache = next;
      return;
    }
    const current = layer._boundsCache;
    const x1 = Math.min(current.x, next.x);
    const y1 = Math.min(current.y, next.y);
    const x2 = Math.max(current.x + current.width, next.x + next.width);
    const y2 = Math.max(current.y + current.height, next.y + next.height);
    layer._boundsCache = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }

  clampCanvasBounds(bounds, canvas) {
    const x1 = Math.max(0, Math.floor(bounds.x));
    const y1 = Math.max(0, Math.floor(bounds.y));
    const x2 = Math.min(canvas.width, Math.ceil(bounds.x + bounds.width));
    const y2 = Math.min(canvas.height, Math.ceil(bounds.y + bounds.height));
    if (x2 <= x1 || y2 <= y1) return null;
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }

  invalidateAllLayerCaches() {
    for (const layer of this.layers) this.invalidateLayerCaches(layer);
  }

  get activeLayer() {
    return this.layers.find((l) => l.id === this.activeLayerId) || this.layers[0] || null;
  }

  setTool(tool) {
    this.tool = tool;
    this.container.querySelectorAll(".vnccs-uc-tool").forEach((btn) => btn.classList.toggle("active", btn.dataset.tool === tool));
    this.syncCursorStyle();
    this.renderToolSettings();
    this.render();
  }

  getToolSettingControls(tool = this.tool) {
    if (tool === "brush") return ["brushSize", "fg", "opacity"];
    if (tool === "eraser" || tool === "mask") return ["brushSize", "opacity"];
    if (tool === "rect" || tool === "lasso") return ["fg", "opacity"];
    if (tool === "resize") return ["keepAspect"];
    return [];
  }

  renderToolSettings() {
    if (!this.toolSettings) return;
    const controls = this.getToolSettingControls();
    if (!controls.length) {
      this.toolSettings.classList.remove("visible");
      this.toolSettings.innerHTML = "";
      return;
    }
    const titleMap = { brush: "Brush", eraser: "Eraser", mask: "Mask Brush", rect: "Rectangle", lasso: "Lasso", resize: "Resize" };
    const title = titleMap[this.tool] || this.tool;
    const html = [`<div class="vnccs-uc-tool-settings-title">${this._escape(title)} Settings</div>`];
    if (controls.includes("brushSize")) {
      html.push(`<label class="vnccs-uc-tool-setting"><span class="vnccs-uc-tool-setting-label">Size</span><input class="vnccs-uc-range" type="range" min="1" max="220" value="${this.brushSize}" data-control="brushSize"></label>`);
    }
    if (controls.includes("fg")) {
      html.push(`<label class="vnccs-uc-tool-setting"><span class="vnccs-uc-tool-setting-label">Color</span><input class="vnccs-uc-input" type="color" value="${this.fg}" data-control="fg"></label>`);
    }
    if (controls.includes("opacity")) {
      html.push(`<label class="vnccs-uc-tool-setting"><span class="vnccs-uc-tool-setting-label">Opacity</span><input class="vnccs-uc-range" type="range" min="0" max="1" step="0.01" value="${this.opacity}" data-control="opacity"></label>`);
    }
    if (controls.includes("keepAspect")) {
      html.push(`<label class="vnccs-uc-tool-setting"><span class="vnccs-uc-tool-setting-label">Keep ratio</span><input type="checkbox" ${this.resizeKeepAspect ? "checked" : ""} data-control="keepAspect"></label>`);
    }
    this.toolSettings.innerHTML = html.join("");
    this.toolSettings.classList.add("visible");
  }

  syncCursorStyle() {
    const cursorMap = {
      brush: "crosshair",
      eraser: "crosshair",
      mask: "crosshair",
      rect: "crosshair",
      lasso: "crosshair",
      resize: "nwse-resize",
      bbox: "move",
      move: "move",
      pan: "grab",
    };
    this.canvas.style.cursor = cursorMap[this.tool] || "default";
  }

  _attachEvents() {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resizeObserver.observe(this.stageWrap);
    this.canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.canvas.addEventListener("pointerenter", (e) => this.onPointerHover(e));
    this.canvas.addEventListener("pointerleave", (e) => this.onPointerLeave(e));
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    this.canvas.addEventListener("auxclick", (e) => e.preventDefault());
    window.addEventListener("pointermove", (e) => this.onPointerMove(e));
    window.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this._flushStateBeforeUnload = () => this.flushStateUpload(true);
    window.addEventListener("pagehide", this._flushStateBeforeUnload);
    window.addEventListener("beforeunload", this._flushStateBeforeUnload);
    this.container.addEventListener("keydown", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement) || target.type !== "number" || e.key !== ",") return;
      e.preventDefault();
      this.insertDecimalPoint(target);
    });
    this.canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.layerList.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    const onLayerSubheadChange = (e) => {
      const target = e.target;
      const layer = this.activeLayer;
      if (!layer || !(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
      this.recordInputHistory(target);
      if (target.dataset.layerControl === "blendMode") layer.blendMode = target.value || "source-over";
      if (target.dataset.layerControl === "opacity") {
        layer.opacity = Number(target.value);
        this.invalidateLayerCaches(layer);
      }
      this.syncActiveLayerControls();
      this.renderLayerList();
      this.render();
      this.syncToNode();
    };
    this.layerSubhead.addEventListener("input", onLayerSubheadChange);
    this.layerSubhead.addEventListener("change", onLayerSubheadChange);
    this.layerSubhead.addEventListener("change", (e) => this.clearInputHistoryMarker(e.target));

    this.toolSettings.addEventListener("input", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;
      this.recordInputHistory(target);
      if (target.dataset.control === "brushSize") this.brushSize = Number(target.value);
      if (target.dataset.control === "fg") this.fg = target.value;
      if (target.dataset.control === "opacity") this.opacity = Number(target.value);
      if (target.dataset.control === "keepAspect") this.resizeKeepAspect = target.checked;
      this.render();
    });
    this.toolSettings.addEventListener("change", (e) => {
      const target = e.target;
      if (target instanceof HTMLInputElement && target.dataset.control === "keepAspect") {
        this.recordInputHistory(target);
        this.resizeKeepAspect = target.checked;
        this.render();
      }
      this.clearInputHistoryMarker(target);
    });
    this.fileInput.addEventListener("change", () => this.importFile(this.fileInput.files?.[0]));
    this.denoiseControl.addEventListener("input", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement) || target.dataset.setting !== "denoise") return;
      this.recordInputHistory(target);
      this.settings.denoise = Math.max(0, Math.min(1, this.parseNumericInput(target, this.settings.denoise)));
      this.syncDenoiseControls(target);
      this.syncToNode();
    });
    this.denoiseControl.addEventListener("change", (e) => {
      this.syncDenoiseControls();
      this.clearInputHistoryMarker(e.target);
    });
    this.left.addEventListener("input", (e) => {
      const target = e.target;
      const key = target?.dataset?.setting;
      if (!key) return;
      this.recordInputHistory(target);
      this.settings[key] = target.type === "number" ? this.parseNumericInput(target, this.settings[key]) : target.value;
      if (key === "generation_mode") this.applyGenerationModeDefaults(target.value);
      if (key === "inference_scale") this.syncInferenceControls();
      this.syncToNode();
    });
    this.left.addEventListener("change", (e) => this.clearInputHistoryMarker(e.target));
    this.setTool(this.tool);
  }

  async _loadAssets() {
    try {
      const res = await fetch("/vnccs/unicanvas/assets");
      const data = await res.json();
      this.assets = {
        checkpoints: data.checkpoints || [],
        diffusion_models: data.diffusion_models || [],
        text_encoders: data.text_encoders || [],
        vae_models: data.vae_models || [],
        loras: data.loras || [],
        samplers: data.samplers || [],
        schedulers: data.schedulers || [],
      };
      this.checkpoints = this.assets.checkpoints;
      this.fillSelect("ckpt_name", this.assets.checkpoints);
      this.fillSelect("diffusion_model_name", this.assets.diffusion_models);
      this.fillSelect("clip_name", this.assets.text_encoders);
      this.fillSelect("vae_name", this.assets.vae_models);
      if (!this.settings.ckpt_name && this.checkpoints[0]) this.settings.ckpt_name = this.checkpoints[0];
      if (!this.settings.diffusion_model_name && this.assets.diffusion_models[0]) this.settings.diffusion_model_name = this.assets.diffusion_models[0];
      if (!this.settings.clip_name && this.assets.text_encoders[0]) this.settings.clip_name = this.assets.text_encoders[0];
      if (!this.settings.vae_name && this.assets.vae_models[0]) this.settings.vae_name = this.assets.vae_models[0];
      this.syncPromptControls();
    } catch (err) {
      this.setStatus(`Asset list failed: ${err.message || err}`, true);
    }
  }

  fillSelect(setting, values) {
    const select = this.container.querySelector(`[data-setting="${setting}"]`);
    if (!select) return;
    select.innerHTML = (values || []).map((name) => `<option value="${this._escape(name)}">${this._escape(name)}</option>`).join("");
  }

  applyGenerationModeDefaults(mode) {
    if (mode === "anima") {
      this.settings.sampler_name = "er_sde";
      this.settings.scheduler = "simple";
      this.settings.steps = 30;
      this.settings.cfg = 4;
      if (!this.settings.diffusion_model_name && this.assets.diffusion_models[0]) this.settings.diffusion_model_name = this.assets.diffusion_models[0];
      if (!this.settings.clip_name) this.settings.clip_name = "qwen_3_06b_base.safetensors";
      if (!this.settings.vae_name) this.settings.vae_name = "qwen_image_vae.safetensors";
    } else {
      this.settings.sampler_name = "euler";
      this.settings.scheduler = "normal";
      this.settings.steps = 24;
      this.settings.cfg = 7;
    }
    this.syncInferenceControls();
    this.syncPromptControls();
  }

  getModelBase() {
    return (this.settings.generation_mode || "illustrious") === "anima" ? "anima" : "sdxl";
  }

  getGridSize() {
    return 8;
  }

  getOptimalDimension() {
    return 1024;
  }

  getInferenceSize() {
    const originalSize = {
      width: Math.max(64, Math.round(this.bbox.width)),
      height: Math.max(64, Math.round(this.bbox.height)),
    };
    const scale = Math.max(0.125, Number(this.settings.inference_scale) || 1);
    const targetSide = this.getOptimalDimension() * scale;
    const targetArea = targetSide * targetSide;
    const aspectRatio = originalSize.width / originalSize.height;
    const width = Math.sqrt(targetArea * aspectRatio);
    const height = width / aspectRatio;
    return {
      width: Math.max(64, this.roundToMultiple(width, this.getGridSize())),
      height: Math.max(64, this.roundToMultiple(height, this.getGridSize())),
    };
  }

  syncInferenceControls() {
    const scaleInput = this.container.querySelector('[data-setting="inference_scale"]');
    const scale = Math.max(0.125, Number(this.settings.inference_scale) || 1);
    this.settings.inference_scale = scale;
    if (scaleInput) scaleInput.value = this.formatSettingNumber(scale, 3);
  }

  syncDenoiseControls(source = null) {
    const value = Math.max(0, Math.min(1, Number(this.settings.denoise) || 0));
    this.settings.denoise = value;
    this.denoiseControl?.querySelectorAll('[data-setting="denoise"]').forEach((el) => {
      if (el === source) return;
      if (el instanceof HTMLInputElement) el.value = this.formatSettingNumber(value, 2);
    });
  }

  _escape(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  resize() {
    this.updateMainUIScale();
    const size = this.getStageViewportSize();
    const dpr = window.devicePixelRatio || 1;
    const nextWidth = Math.max(1, Math.floor(size.width * dpr));
    const nextHeight = Math.max(1, Math.floor(size.height * dpr));
    if (this.canvas.width !== nextWidth) this.canvas.width = nextWidth;
    if (this.canvas.height !== nextHeight) this.canvas.height = nextHeight;
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    if (!this.didInitialCenter && size.width > 0 && size.height > 0) {
      this.fitInitialView();
    }
    this.render();
  }

  requestRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    window.requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  getStageViewportSize() {
    const width = this.stageWrap?.clientWidth || this.canvas?.clientWidth || 0;
    const height = this.stageWrap?.clientHeight || this.canvas?.clientHeight || 0;
    if (width > 0 && height > 0) return { width, height };
    const rect = this.stageWrap?.getBoundingClientRect?.();
    return {
      width: Math.max(0, rect?.width || 0),
      height: Math.max(0, rect?.height || 0),
    };
  }

  fitInitialView() {
    this.centerBbox(true);
    this.didInitialCenter = true;
  }

  updateMainUIScale() {
    if (!this.container) return;
    const width = this.container.clientWidth || this.node?.size?.[0] || 1040;
    const height = this.container.clientHeight || this.node?.size?.[1] || 720;
    const scale = Math.max(0.78, Math.min(1.45, Math.min(width / 1040, height / 720)));
    const next = scale.toFixed(3);
    if (this.container.style.getPropertyValue("--vnccs-uc-ui-scale") !== next) {
      this.container.style.setProperty("--vnccs-uc-ui-scale", next);
    }
  }

  canvasPointFromEvent(e) {
    const rect = this.canvas.getBoundingClientRect();
    const size = this.getStageViewportSize();
    const visualWidth = Math.max(rect.width || size.width || 1, 1);
    const visualHeight = Math.max(rect.height || size.height || 1, 1);
    return {
      x: (e.clientX - rect.left) * (size.width / visualWidth),
      y: (e.clientY - rect.top) * (size.height / visualHeight),
    };
  }

  worldFromCanvasPoint(point) {
    return {
      x: (point.x - this.view.x) / this.view.scale,
      y: (point.y - this.view.y) / this.view.scale,
    };
  }

  worldFromEvent(e) {
    return this.worldFromCanvasPoint(this.canvasPointFromEvent(e));
  }

  onPointerHover(e) {
    this.hoverPointerType = e.pointerType || "mouse";
    this.hoverPoint = this.worldFromEvent(e);
    this.requestRender();
  }

  onPointerLeave(e) {
    if (this.isPointerDown) return;
    this.hoverPointerType = e.pointerType || "mouse";
    this.hoverPoint = null;
    this.requestRender();
  }

  onPointerDown(e) {
    if (![0, 1].includes(e.button)) return;
    e.preventDefault();
    e.stopPropagation();
    this.canvas.setPointerCapture?.(e.pointerId);
    this.isPointerDown = true;
    const screen = this.canvasPointFromEvent(e);
    const point = this.worldFromCanvasPoint(screen);
    this.hoverPointerType = e.pointerType || "mouse";
    this.hoverPoint = point;
    this.lastPoint = point;
    this.dragStart = { point, screen, view: { ...this.view }, bbox: { ...this.bbox } };
    this.pointerMode = e.button === 1 ? "pan" : this.tool;
    if (e.button === 1 && (e.ctrlKey || e.metaKey)) {
      this.pointerMode = "zoom-drag";
      this.zoomDragStart = {
        pointerId: e.pointerId,
        clientY: e.clientY,
        scale: this.view.scale,
        center: screen,
      };
    }
    if (this.pointerMode === "bbox") {
      if (this.isStagingActive()) {
        this.pointerMode = "idle";
        this.setStatus(this.drawInProgress ? "Wait for DRAW to finish before moving bbox" : "Accept or discard the staged result before moving bbox", true);
        this.render();
        return;
      }
      const bboxHandle = this.hitBboxHandle(point);
      if (bboxHandle) {
        this.recordHistoryBefore();
        this.pointerMode = "bbox-resize";
        this.dragStart.bboxHandle = bboxHandle;
      } else if (this.isPointInBbox(point)) {
        this.recordHistoryBefore();
        this.pointerMode = "bbox-move";
      } else {
        this.pointerMode = "idle";
      }
    } else if (this.pointerMode === "rect") {
      this.recordHistoryBefore();
      this.shapeComposite = e.ctrlKey || e.metaKey ? "destination-out" : "source-over";
      this.shapeDraft = this.getRectToolRect(point, point, e);
    } else if (this.pointerMode === "lasso") {
      this.recordHistoryBefore();
      this.shapeComposite = e.ctrlKey || e.metaKey ? "destination-out" : "source-over";
      this.lassoPoints = [point];
    } else if (this.pointerMode === "move" && !e.altKey && this.activeLayer && !this.activeLayer.locked) {
      this.recordHistoryBefore();
      this.pointerMode = "layer-move";
      this.dragStart.layerCanvas = this.cloneCanvas(this.activeLayer.canvas);
      this.dragStart.hiresRect = this.activeLayer.hiresRect ? { ...this.activeLayer.hiresRect } : null;
      this.dragStart.layerOrigin = { ...this.origin };
      this.dragStart.layerBounds = this.getCanvasAlphaBounds(this.dragStart.layerCanvas);
    } else if (this.pointerMode === "resize") {
      const layer = this.activeLayer;
      const bounds = this.getLayerWorldBounds(layer);
      const handle = this.hitResizeHandle(point, bounds);
      if (!layer || layer.locked || !bounds || !handle) {
        this.pointerMode = "idle";
      } else {
        this.recordHistoryBefore();
        this.materializeRasterLayerForEditing(layer);
        this.pointerMode = "layer-resize";
        this.dragStart.resizeHandle = handle;
        this.dragStart.resizeBounds = this.getLayerWorldBounds(layer);
        this.dragStart.layerCanvas = this.cloneCanvas(layer.canvas);
        this.dragStart.layerOrigin = { ...this.origin };
      }
    }
    if (["brush", "eraser", "mask"].includes(this.pointerMode)) {
      this.recordHistoryBefore();
      this.cancelDeferredCanvasCommit();
      const lastToolPoint = this.lastDrawPointByTool[this.pointerMode];
      if (e.shiftKey && lastToolPoint) {
        this.drawStroke(lastToolPoint, point);
      } else {
        this.drawStroke(point, point);
      }
      this.requestRender();
    }
  }

  onPointerMove(e) {
    const screen = this.canvasPointFromEvent(e);
    const point = this.worldFromCanvasPoint(screen);
    this.hoverPointerType = e.pointerType || "mouse";
    this.hoverPoint = point;
    if (!this.isPointerDown || !this.lastPoint) {
      this.requestRender();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (this.pointerMode === "pan" || (this.pointerMode === "move" && e.altKey)) {
      this.view.x = this.dragStart.view.x + (screen.x - this.dragStart.screen.x);
      this.view.y = this.dragStart.view.y + (screen.y - this.dragStart.screen.y);
    } else if (this.pointerMode === "zoom-drag" && this.zoomDragStart?.pointerId === e.pointerId) {
      const deltaY = e.clientY - this.zoomDragStart.clientY;
      const scaleFactor = 2 ** (-deltaY / ZOOM_DRAG_PIXELS_PER_DOUBLING);
      this.setStageScale(this.zoomDragStart.scale * scaleFactor, this.zoomDragStart.center);
    } else if (this.pointerMode === "bbox-move") {
      if (this.isStagingActive()) return;
      const grid = e.ctrlKey || e.metaKey ? 8 : 64;
      this.bbox.x = this.roundToMultiple(this.dragStart.bbox.x + point.x - this.dragStart.point.x, grid);
      this.bbox.y = this.roundToMultiple(this.dragStart.bbox.y + point.y - this.dragStart.point.y, grid);
    } else if (this.pointerMode === "bbox-resize") {
      if (this.isStagingActive()) return;
      this.resizeBbox(point, e);
    } else if (this.pointerMode === "rect") {
      this.shapeDraft = this.getRectToolRect(this.dragStart.point, point, e);
    } else if (this.pointerMode === "lasso") {
      this.appendLassoPoint(point);
    } else if (this.pointerMode === "layer-move") {
      this.moveActiveLayerPixels(point.x - this.dragStart.point.x, point.y - this.dragStart.point.y);
    } else if (this.pointerMode === "layer-resize") {
      this.resizeActiveLayerTo(this.getResizedBounds(point, e));
    } else if (["brush", "eraser", "mask"].includes(this.pointerMode)) {
      this.drawStroke(this.lastPoint, point);
    }
    this.lastPoint = point;
    this.requestRender();
  }

  onPointerUp(e) {
    if (!this.isPointerDown) return;
    e?.preventDefault?.();
    e?.stopPropagation?.();
    const finishedMode = this.pointerMode;
    if (this.pointerMode === "rect" && this.shapeDraft) {
      this.commitRectShape();
    }
    if (this.pointerMode === "lasso" && this.lassoPoints.length > 2) {
      this.commitLassoShape();
    }
    this.isPointerDown = false;
    this.pointerMode = null;
    this.lastPoint = null;
    this.dragStart = null;
    this.zoomDragStart = null;
    this.shapeDraft = null;
    this.lassoPoints = [];
    if (finishedMode === "bbox-resize") this.syncInferenceControls();
    this.requestRender();
    if (["brush", "eraser", "mask"].includes(finishedMode)) {
      this.scheduleDeferredCanvasCommit();
    } else {
      this.renderLayerList();
      this.syncToNode();
    }
  }

  scheduleDeferredCanvasCommit() {
    window.clearTimeout(this.deferredCanvasCommitTimer);
    this.deferredCanvasCommitTimer = window.setTimeout(() => {
      this.deferredCanvasCommitTimer = null;
      this.renderLayerList();
      this.syncToNode();
    }, 80);
  }

  cancelDeferredCanvasCommit() {
    if (this.deferredCanvasCommitTimer === null) return;
    window.clearTimeout(this.deferredCanvasCommitTimer);
    this.deferredCanvasCommitTimer = null;
  }

  isPointInBbox(point) {
    return point.x >= this.bbox.x && point.x <= this.bbox.x + this.bbox.width
      && point.y >= this.bbox.y && point.y <= this.bbox.y + this.bbox.height;
  }

  rectFromPoints(a, b, minSize = 1) {
    const width = Math.max(minSize, Math.abs(b.x - a.x));
    const height = Math.max(minSize, Math.abs(b.y - a.y));
    return {
      x: Math.round(Math.min(a.x, b.x)),
      y: Math.round(Math.min(a.y, b.y)),
      width: Math.round(width),
      height: Math.round(height),
    };
  }

  getRectToolRect(start, current, event) {
    if (event.altKey) {
      const dx = Math.abs(current.x - start.x);
      const dy = Math.abs(current.y - start.y);
      const size = event.shiftKey ? Math.max(dx, dy) : null;
      const width = Math.max(1, (size ?? dx) * 2);
      const height = Math.max(1, (size ?? dy) * 2);
      return {
        x: Math.round(start.x - width / 2),
        y: Math.round(start.y - height / 2),
        width: Math.round(width),
        height: Math.round(height),
      };
    }
    if (!event.shiftKey) return this.rectFromPoints(start, current, 1);
    const dx = current.x - start.x;
    const dy = current.y - start.y;
    const size = Math.max(1, Math.max(Math.abs(dx), Math.abs(dy)));
    return {
      x: Math.round(dx < 0 ? start.x - size : start.x),
      y: Math.round(dy < 0 ? start.y - size : start.y),
      width: Math.round(size),
      height: Math.round(size),
    };
  }

  commitRectShape() {
    const layer = this.activeLayer;
    const rect = this.shapeDraft;
    if (!layer || layer.locked || !rect || rect.width <= 0 || rect.height <= 0) return;
    if (!this.ensureWorldBounds(rect.x + rect.width, rect.y + rect.height, 128)) return;
    if (!this.ensureWorldBounds(rect.x, rect.y, 128)) return;
    this.materializeRasterLayerForEditing(layer);
    const ctx = layer.canvas.getContext("2d");
    ctx.save();
    ctx.globalAlpha = this.opacity;
    ctx.globalCompositeOperation = this.shapeComposite;
    ctx.fillStyle = layer.type === "mask" ? "#fff" : this.fg;
    ctx.fillRect(rect.x - this.origin.x, rect.y - this.origin.y, rect.width, rect.height);
    ctx.restore();
    this.invalidateLayerCaches(layer);
  }

  appendLassoPoint(point) {
    const last = this.lassoPoints[this.lassoPoints.length - 1];
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < Math.max(1, 2 / this.view.scale)) return;
    this.lassoPoints.push(point);
  }

  commitLassoShape() {
    const layer = this.getOrCreateMaskLayer();
    if (!layer || layer.locked || this.lassoPoints.length < 3) return;
    const bounds = this.lassoPoints.reduce((acc, p) => ({
      minX: Math.min(acc.minX, p.x),
      minY: Math.min(acc.minY, p.y),
      maxX: Math.max(acc.maxX, p.x),
      maxY: Math.max(acc.maxY, p.y),
    }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    if (!this.ensureWorldBounds(bounds.maxX, bounds.maxY, 128)) return;
    if (!this.ensureWorldBounds(bounds.minX, bounds.minY, 128)) return;
    const ctx = layer.canvas.getContext("2d");
    ctx.save();
    ctx.globalAlpha = this.opacity;
    ctx.globalCompositeOperation = this.shapeComposite;
    ctx.fillStyle = layer.type === "mask" ? "#fff" : this.fg;
    ctx.beginPath();
    this.lassoPoints.forEach((p, index) => {
      const x = p.x - this.origin.x;
      const y = p.y - this.origin.y;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    this.invalidateLayerCaches(layer);
  }

  cloneCanvas(canvas) {
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    this.configureImageContext(copy.getContext("2d")).drawImage(canvas, 0, 0);
    return copy;
  }

  materializeRasterLayerForEditing(layer) {
    if (!layer || layer.type !== "raster" || !layer.hiresCanvas || !layer.hiresRect) return;
    const ctx = this.configureImageContext(layer.canvas.getContext("2d"), true);
    const rect = layer.hiresRect;
    ctx.clearRect(rect.x - this.origin.x, rect.y - this.origin.y, rect.width, rect.height);
    ctx.drawImage(layer.hiresCanvas, rect.x - this.origin.x, rect.y - this.origin.y, rect.width, rect.height);
    layer.hiresCanvas = null;
    layer.hiresRect = null;
    this.invalidateLayerCaches(layer);
  }

  cloneHistoryLayer(layer) {
    const clone = {
      id: layer.id,
      name: layer.name,
      type: layer.type,
      visible: layer.visible,
      locked: layer.locked,
      opacity: layer.opacity,
      blendMode: layer.blendMode || "source-over",
      canvas: this.cloneCanvas(layer.canvas),
    };
    if (layer.hiresCanvas && layer.hiresRect) {
      clone.hiresCanvas = this.cloneCanvas(layer.hiresCanvas);
      clone.hiresRect = { ...layer.hiresRect };
    }
    this.invalidateLayerCaches(clone);
    return clone;
  }

  cloneHistoryStagingItem(item) {
    return {
      ...item,
      maskCanvas: item.maskCanvas ? this.cloneCanvas(item.maskCanvas) : null,
      userMaskCanvas: item.userMaskCanvas ? this.cloneCanvas(item.userMaskCanvas) : null,
      resultMaskCanvas: item.resultMaskCanvas ? this.cloneCanvas(item.resultMaskCanvas) : null,
      _maskedCanvas: null,
      _maskedSource: null,
      _maskedMask: null,
    };
  }

  createHistorySnapshot() {
    return {
      origin: { ...this.origin },
      size: { ...this.size },
      bbox: { ...this.bbox },
      tool: this.tool,
      brushSize: this.brushSize,
      opacity: this.opacity,
      fg: this.fg,
      resizeKeepAspect: this.resizeKeepAspect,
      settings: JSON.parse(JSON.stringify(this.settings)),
      activeLayerId: this.activeLayerId,
      layers: this.layers.map((layer) => this.cloneHistoryLayer(layer)),
      stagingItems: this.stagingItems.map((item) => this.cloneHistoryStagingItem(item)),
      activeStagingIndex: this.activeStagingIndex,
    };
  }

  restoreHistorySnapshot(snapshot) {
    if (!snapshot) return;
    this.cancelDeferredCanvasCommit();
    this.historyRestoring = true;
    this.origin = { ...snapshot.origin };
    this.size = { ...snapshot.size };
    this.bbox = { ...snapshot.bbox };
    this.tool = snapshot.tool || this.tool;
    this.brushSize = Number.isFinite(snapshot.brushSize) ? snapshot.brushSize : this.brushSize;
    this.opacity = Number.isFinite(snapshot.opacity) ? snapshot.opacity : this.opacity;
    this.fg = snapshot.fg || this.fg;
    this.resizeKeepAspect = typeof snapshot.resizeKeepAspect === "boolean" ? snapshot.resizeKeepAspect : this.resizeKeepAspect;
    this.settings = JSON.parse(JSON.stringify(snapshot.settings || this.settings));
    this.layers = snapshot.layers.map((layer) => this.cloneHistoryLayer(layer));
    this.activeLayerId = snapshot.activeLayerId || this.layers[0]?.id || null;
    this.stagingItems = (snapshot.stagingItems || []).map((item) => this.cloneHistoryStagingItem(item));
    this.activeStagingIndex = Math.max(-1, Math.min(snapshot.activeStagingIndex ?? -1, this.stagingItems.length - 1));
    this.historyRestoring = false;
    this.setTool(this.tool);
    this.syncPromptControls();
    this.syncActiveLayerControls();
    this.renderLayerList();
    this.render();
    this.syncToNode();
  }

  recordHistoryBefore() {
    if (this._isRestoring || this.historyRestoring) return;
    this.undoStack.push(this.createHistorySnapshot());
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.updateHistoryButtons();
  }

  undo() {
    if (!this.undoStack.length) return;
    const previous = this.undoStack.pop();
    this.redoStack.push(this.createHistorySnapshot());
    if (this.redoStack.length > HISTORY_LIMIT) this.redoStack.shift();
    this.restoreHistorySnapshot(previous);
    this.updateHistoryButtons();
    this.setStatus("Undo");
  }

  redo() {
    if (!this.redoStack.length) return;
    const next = this.redoStack.pop();
    this.undoStack.push(this.createHistorySnapshot());
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.restoreHistorySnapshot(next);
    this.updateHistoryButtons();
    this.setStatus("Redo");
  }

  updateHistoryButtons() {
    if (this.undoBtn) this.undoBtn.disabled = !this.undoStack.length;
    if (this.redoBtn) this.redoBtn.disabled = !this.redoStack.length;
  }

  recordInputHistory(target) {
    if (!target || target._vnccsHistoryRecorded) return;
    this.recordHistoryBefore();
    target._vnccsHistoryRecorded = true;
  }

  clearInputHistoryMarker(target) {
    if (target) target._vnccsHistoryRecorded = false;
  }

  getLayerWorldBounds(layer = this.activeLayer) {
    if (!layer) return null;
    if (layer.hiresCanvas && layer.hiresRect) return { ...layer.hiresRect };
    const crop = this.getCanvasAlphaBounds(layer.canvas);
    if (!crop) return null;
    return {
      x: this.origin.x + crop.x,
      y: this.origin.y + crop.y,
      width: crop.width,
      height: crop.height,
    };
  }

  getResizeHandlePoints(bounds) {
    if (!bounds) return [];
    const { x, y, width, height } = bounds;
    const midX = x + width / 2;
    const midY = y + height / 2;
    return [
      { handle: "nw", x, y },
      { handle: "n", x: midX, y },
      { handle: "ne", x: x + width, y },
      { handle: "e", x: x + width, y: midY },
      { handle: "se", x: x + width, y: y + height },
      { handle: "s", x: midX, y: y + height },
      { handle: "sw", x, y: y + height },
      { handle: "w", x, y: midY },
    ];
  }

  hitResizeHandle(point, bounds) {
    if (!bounds) return null;
    const threshold = Math.max(10, 12 / this.view.scale);
    let best = null;
    let bestDistance = Infinity;
    for (const item of this.getResizeHandlePoints(bounds)) {
      const distance = Math.hypot(point.x - item.x, point.y - item.y);
      if (distance <= threshold && distance < bestDistance) {
        best = item.handle;
        bestDistance = distance;
      }
    }
    return best;
  }

  getResizedBounds(point, event) {
    const start = this.dragStart?.resizeBounds;
    const handle = this.dragStart?.resizeHandle || "";
    if (!start) return null;
    const minSize = 4;
    let left = start.x;
    let top = start.y;
    let right = start.x + start.width;
    let bottom = start.y + start.height;
    if (handle.includes("w")) left = point.x;
    if (handle.includes("e")) right = point.x;
    if (handle.includes("n")) top = point.y;
    if (handle.includes("s")) bottom = point.y;

    if ((this.resizeKeepAspect || event?.shiftKey) && start.width > 0 && start.height > 0) {
      const ratio = start.width / start.height;
      let width = Math.max(minSize, Math.abs(right - left));
      let height = Math.max(minSize, Math.abs(bottom - top));
      if (!handle.includes("n") && !handle.includes("s")) height = width / ratio;
      else if (!handle.includes("w") && !handle.includes("e")) width = height * ratio;
      else if (width / height > ratio) width = height * ratio;
      else height = width / ratio;
      if (handle.includes("w")) left = right - width;
      else right = left + width;
      if (handle.includes("n")) top = bottom - height;
      else bottom = top + height;
    }

    if (right < left) [left, right] = [right, left];
    if (bottom < top) [top, bottom] = [bottom, top];
    return {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.max(minSize, Math.round(right - left)),
      height: Math.max(minSize, Math.round(bottom - top)),
    };
  }

  resizeActiveLayerTo(bounds) {
    const layer = this.activeLayer;
    const start = this.dragStart;
    if (!layer || !start?.layerCanvas || !start.resizeBounds || !bounds) return;
    if (!this.ensureWorldBounds(bounds.x, bounds.y, 256)) return;
    if (!this.ensureWorldBounds(bounds.x + bounds.width, bounds.y + bounds.height, 256)) return;
    const sourceOrigin = start.layerOrigin || this.origin;
    const source = start.resizeBounds;
    const ctx = this.configureImageContext(layer.canvas.getContext("2d"), true);
    ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    ctx.drawImage(
      start.layerCanvas,
      source.x - sourceOrigin.x,
      source.y - sourceOrigin.y,
      source.width,
      source.height,
      bounds.x - this.origin.x,
      bounds.y - this.origin.y,
      bounds.width,
      bounds.height
    );
    layer.hiresCanvas = null;
    layer.hiresRect = null;
    this.invalidateLayerCaches(layer);
  }

  toggleSnapToGrid() {
    this.snapToGrid = !this.snapToGrid;
    this.updateSnapButton();
  }

  updateSnapButton() {
    if (!this.snapBtn) return;
    this.snapBtn.classList.toggle("active", this.snapToGrid);
    this.snapBtn.setAttribute("aria-pressed", this.snapToGrid ? "true" : "false");
  }

  canSnapMovedLayer(layer, crop) {
    if (!this.snapToGrid || !layer || layer.type !== "raster" || !crop) return false;
    const width = Math.round(crop.width);
    const height = Math.round(crop.height);
    if (Math.min(width, height) < MOVE_SNAP_GRID_SIZE) return false;
    return Math.abs(width - height) <= 1;
  }

  snapMovedLayerDelta(dx, dy, crop, sourceOrigin) {
    if (!crop) return { dx, dy };
    const left = sourceOrigin.x + crop.x + dx;
    const top = sourceOrigin.y + crop.y + dy;
    const right = left + crop.width;
    const bottom = top + crop.height;
    const snapAxis = (start, end, targets) => {
      const candidates = [
        { delta: this.roundToMultiple(start, MOVE_SNAP_GRID_SIZE) - start },
        { delta: this.roundToMultiple(end, MOVE_SNAP_GRID_SIZE) - end },
        ...targets.map((target) => ({ delta: target - start })),
        ...targets.map((target) => ({ delta: target - end })),
      ];
      candidates.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
      return candidates[0]?.delta || 0;
    };
    const bboxXTargets = [this.bbox.x, this.bbox.x + this.bbox.width];
    const bboxYTargets = [this.bbox.y, this.bbox.y + this.bbox.height];
    return {
      dx: dx + snapAxis(left, right, bboxXTargets),
      dy: dy + snapAxis(top, bottom, bboxYTargets),
    };
  }

  moveActiveLayerPixels(dx, dy) {
    const layer = this.activeLayer;
    if (!layer || !this.dragStart?.layerCanvas) return;
    const sourceOrigin = this.dragStart.layerOrigin || this.origin;
    const crop = this.dragStart.layerBounds;
    if (this.canSnapMovedLayer(layer, crop)) {
      ({ dx, dy } = this.snapMovedLayerDelta(dx, dy, crop, sourceOrigin));
    }
    if (crop) {
      if (!this.ensureWorldBounds(sourceOrigin.x + crop.x + dx, sourceOrigin.y + crop.y + dy, 256)) return;
      if (!this.ensureWorldBounds(sourceOrigin.x + crop.x + crop.width + dx, sourceOrigin.y + crop.y + crop.height + dy, 256)) return;
    }
    const ctx = this.configureImageContext(layer.canvas.getContext("2d"));
    ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    ctx.drawImage(
      this.dragStart.layerCanvas,
      Math.round(sourceOrigin.x - this.origin.x + dx),
      Math.round(sourceOrigin.y - this.origin.y + dy)
    );
    if (layer.hiresRect && this.dragStart.hiresRect) {
      layer.hiresRect = {
        ...this.dragStart.hiresRect,
        x: this.dragStart.hiresRect.x + dx,
        y: this.dragStart.hiresRect.y + dy,
      };
    }
    this.invalidateLayerCaches(layer);
  }

  alignCoordForTool(point, width) {
    const roundedX = Math.round(point.x);
    const roundedY = Math.round(point.y);
    const offset = (width / 2) % 1;
    return {
      x: roundedX + Math.sign(point.x - roundedX) * offset,
      y: roundedY + Math.sign(point.y - roundedY) * offset,
    };
  }

  hitBboxHandle(point) {
    const threshold = Math.max(10, 12 / this.view.scale);
    const left = this.bbox.x;
    const right = this.bbox.x + this.bbox.width;
    const top = this.bbox.y;
    const bottom = this.bbox.y + this.bbox.height;
    const nearX = Math.abs(point.x - left) <= threshold ? "w" : Math.abs(point.x - right) <= threshold ? "e" : "";
    const nearY = Math.abs(point.y - top) <= threshold ? "n" : Math.abs(point.y - bottom) <= threshold ? "s" : "";
    if (nearX && point.y >= top - threshold && point.y <= bottom + threshold) return `${nearY}${nearX}` || nearX;
    if (nearY && point.x >= left - threshold && point.x <= right + threshold) return nearY;
    return null;
  }

  resizeBbox(point, event) {
    const box = { ...this.dragStart.bbox };
    const handle = this.dragStart.bboxHandle || "";
    const grid = event?.ctrlKey || event?.metaKey ? 8 : 64;
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    let left = box.x;
    let right = box.x + box.width;
    let top = box.y;
    let bottom = box.y + box.height;
    if (event?.altKey) {
      if (handle.includes("w") || handle.includes("e")) {
        const halfWidth = Math.abs(point.x - center.x);
        left = center.x - halfWidth;
        right = center.x + halfWidth;
      }
      if (handle.includes("n") || handle.includes("s")) {
        const halfHeight = Math.abs(point.y - center.y);
        top = center.y - halfHeight;
        bottom = center.y + halfHeight;
      }
    } else {
      if (handle.includes("w")) left = point.x;
      if (handle.includes("e")) right = point.x;
      if (handle.includes("n")) top = point.y;
      if (handle.includes("s")) bottom = point.y;
    }
    if (right - left < 64) handle.includes("w") ? left = right - 64 : right = left + 64;
    if (bottom - top < 64) handle.includes("n") ? top = bottom - 64 : bottom = top + 64;
    let width = this.roundToMultiple(Math.max(64, right - left), grid);
    let height = this.roundToMultiple(Math.max(64, bottom - top), grid);
    if (event?.shiftKey && !event?.altKey) {
      const ratio = box.width / box.height;
      if (width / height > ratio) width = this.roundToMultiple(height * ratio, grid);
      else height = this.roundToMultiple(width / ratio, grid);
      width = Math.max(64, width);
      height = Math.max(64, height);
    }
    if (handle.includes("w")) left = right - width;
    else right = left + width;
    if (handle.includes("n")) top = bottom - height;
    else bottom = top + height;
    if (event?.altKey) {
      left = center.x - width / 2;
      top = center.y - height / 2;
      right = center.x + width / 2;
      bottom = center.y + height / 2;
    }
    this.bbox = {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.round(width),
      height: Math.round(height),
    };
  }

  roundToMultiple(value, multiple) {
    if (multiple <= 1) return Math.round(value);
    return Math.round(value / multiple) * multiple;
  }

  onWheel(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) return;
    const screen = this.canvasPointFromEvent(e);
    const now = window.performance.now();
    const deltaT = this.lastScrollEventTimestamp === null ? Infinity : now - this.lastScrollEventTimestamp;
    this.lastScrollEventTimestamp = now;
    let dynamicScaleFactor = STAGE_SCALE_FACTOR;
    if (deltaT > 300) {
      dynamicScaleFactor = STAGE_SCALE_FACTOR + (1 - STAGE_SCALE_FACTOR) / 2;
    } else if (deltaT < 300) {
      dynamicScaleFactor = Math.min(STAGE_SCALE_FACTOR + (1 - STAGE_SCALE_FACTOR) * (deltaT / 200), 0.9999);
    }
    const scaleFactor = e.deltaY > 0
      ? dynamicScaleFactor ** Math.abs(e.deltaY)
      : (1 / dynamicScaleFactor) ** Math.abs(e.deltaY);
    this.intendedScale = this.constrainStageScale(this.intendedScale * scaleFactor);
    this.updateScaleWithSnapping(screen);
    if (this.snapTimeout !== null) window.clearTimeout(this.snapTimeout);
    this.snapTimeout = window.setTimeout(() => {
      this.intendedScale = this.view.scale;
    }, 300);
    this.render();
  }

  constrainStageScale(scale) {
    return Math.min(STAGE_MAX_SCALE, Math.max(STAGE_MIN_SCALE, scale));
  }

  setStageScale(scale, center = null) {
    const nextScale = this.constrainStageScale(scale);
    this.intendedScale = nextScale;
    this.activeSnapPoint = null;
    this.applyStageScale(nextScale, center);
  }

  applyStageScale(newScale, center = null) {
    const oldScale = this.view.scale;
    const size = this.getStageViewportSize();
    const zoomCenter = center || {
      x: size.width / 2,
      y: size.height / 2,
    };
    const deltaX = (zoomCenter.x - this.view.x) / oldScale;
    const deltaY = (zoomCenter.y - this.view.y) / oldScale;
    this.view.x = zoomCenter.x - deltaX * newScale;
    this.view.y = zoomCenter.y - deltaY * newScale;
    this.view.scale = newScale;
  }

  updateScaleWithSnapping(center) {
    if (this.activeSnapPoint !== null) {
      const threshold = this.activeSnapPoint * STAGE_SNAP_TOLERANCE;
      if (Math.abs(this.intendedScale - this.activeSnapPoint) > threshold) {
        this.activeSnapPoint = null;
        this.applyStageScale(this.intendedScale, center);
      } else {
        this.intendedScale = this.activeSnapPoint;
      }
      return;
    }
    for (const snapPoint of STAGE_SNAP_POINTS) {
      const threshold = snapPoint * STAGE_SNAP_TOLERANCE;
      if (Math.abs(this.intendedScale - snapPoint) < threshold) {
        this.activeSnapPoint = snapPoint;
        this.applyStageScale(snapPoint, center);
        return;
      }
    }
    this.applyStageScale(this.intendedScale, center);
  }

  ensureWorldBounds(x, y, padding = 256) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    let left = this.origin.x;
    let top = this.origin.y;
    let right = this.origin.x + this.size.width;
    let bottom = this.origin.y + this.size.height;
    let changed = false;
    if (x < left + padding) { left = x - padding; changed = true; }
    if (y < top + padding) { top = y - padding; changed = true; }
    if (x > right - padding) { right = x + padding; changed = true; }
    if (y > bottom - padding) { bottom = y + padding; changed = true; }
    if (!changed) return true;
    const newW = Math.ceil(right - left);
    const newH = Math.ceil(bottom - top);
    if (
      newW > MAX_LAYER_CANVAS_SIDE ||
      newH > MAX_LAYER_CANVAS_SIDE ||
      newW * newH > MAX_LAYER_CANVAS_PIXELS
    ) {
      this.setStatus(`Canvas backing limit reached (${newW}×${newH})`, true);
      return false;
    }
    for (const layer of this.layers) {
      const next = document.createElement("canvas");
      next.width = newW;
      next.height = newH;
      this.configureImageContext(next.getContext("2d")).drawImage(layer.canvas, this.origin.x - left, this.origin.y - top);
      layer.canvas = next;
      this.invalidateLayerCaches(layer);
    }
    this.origin = { x: left, y: top };
    this.size = { width: newW, height: newH };
    return true;
  }

  drawStroke(a, b) {
    const layer = this.tool === "mask" ? this.getOrCreateMaskLayer() : this.activeLayer;
    if (!layer || layer.locked) return;
    if (!this.ensureWorldBounds(b.x, b.y, this.brushSize * 2)) return;
    this.materializeRasterLayerForEditing(layer);
    const start = this.alignCoordForTool(a, this.brushSize);
    const end = this.alignCoordForTool(b, this.brushSize);
    const strokeBounds = this.getStrokeCanvasBounds(layer, start, end, this.brushSize);
    const ctx = layer.canvas.getContext("2d");
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = this.brushSize;
    ctx.globalAlpha = this.opacity;
    if (this.tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "#000";
    } else if (layer.type === "mask" || this.tool === "mask") {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "rgba(255,255,255,1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = this.fg;
    }
    ctx.beginPath();
    ctx.moveTo(start.x - this.origin.x, start.y - this.origin.y);
    ctx.lineTo(end.x - this.origin.x, end.y - this.origin.y);
    ctx.stroke();
    ctx.restore();
    this.markLayerPixelsChanged(layer, strokeBounds, this.tool !== "eraser");
    if (this.tool in this.lastDrawPointByTool) this.lastDrawPointByTool[this.tool] = { x: b.x, y: b.y };
  }

  getStrokeCanvasBounds(layer, start, end, width) {
    const pad = width / 2 + 2;
    const x = Math.min(start.x, end.x) - this.origin.x - pad;
    const y = Math.min(start.y, end.y) - this.origin.y - pad;
    const right = Math.max(start.x, end.x) - this.origin.x + pad;
    const bottom = Math.max(start.y, end.y) - this.origin.y + pad;
    return this.clampCanvasBounds({ x, y, width: right - x, height: bottom - y }, layer.canvas);
  }

  getOrCreateMaskLayer() {
    let layer = this.activeLayer?.type === "mask" ? this.activeLayer : this.layers.find((l) => l.type === "mask");
    if (!layer) layer = this.addLayer("mask", null, false);
    return layer;
  }

  render() {
    const ctx = this.canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    this.drawBackground(ctx, w, h);
    ctx.save();
    ctx.translate(this.view.x, this.view.y);
    ctx.scale(this.view.scale, this.view.scale);
    this.configureImageContext(ctx, false);
    this._visibleWorldRectForRender = this.visibleWorldRect();
    const hideMaskOverlays = this.hasOpenStagingPanel();
    for (const layer of [...this.layers].reverse()) {
      if (!layer.visible) continue;
      if (hideMaskOverlays && layer.type === "mask") continue;
      ctx.save();
      if (layer.type === "mask") {
        this.drawMaskLayer(ctx, layer);
      } else {
        ctx.globalAlpha = layer.opacity;
        ctx.globalCompositeOperation = layer.blendMode || "source-over";
        this.drawRasterLayerVisible(ctx, layer);
      }
      ctx.restore();
    }
    this._visibleWorldRectForRender = null;
    this.drawStagingOverlay(ctx);
    this.drawShapeDraft(ctx);
    this.drawLassoDraft(ctx);
    this.drawResizeOverlay(ctx);
    this.drawBbox(ctx);
    this.drawToolPreview(ctx);
    ctx.restore();
    const inferenceSize = this.getInferenceSize();
    this.hud.innerHTML = `<span class="vnccs-uc-chip">${this.tool}</span><span class="vnccs-uc-chip">${Math.round(this.view.scale * 100)}%</span><span class="vnccs-uc-chip">${this.bbox.width}×${this.bbox.height}</span><span class="vnccs-uc-chip">infer ${inferenceSize.width}×${inferenceSize.height}</span>`;
    this.updateStagingControls();
  }

  drawBackground(ctx, w, h) {
    ctx.fillStyle = "#07070c";
    ctx.fillRect(0, 0, w, h);
    const step = Math.max(8, 64 * this.view.scale);
    ctx.strokeStyle = "rgba(255,255,255,.045)";
    ctx.lineWidth = 1;
    const ox = this.view.x % step;
    const oy = this.view.y % step;
    for (let x = ox; x < w; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = oy; y < h; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  }

  drawMaskLayer(ctx, layer) {
    if (this.hasOpenStagingPanel()) return;
    const crop = this.getVisibleLayerCrop(layer.canvas);
    if (!crop) return;
    const tint = this.getMaskTintScratch(crop.sw, crop.sh);
    const tintCtx = tint.getContext("2d");
    tintCtx.clearRect(0, 0, tint.width, tint.height);
    tintCtx.globalCompositeOperation = "source-over";
    tintCtx.drawImage(layer.canvas, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);
    tintCtx.globalCompositeOperation = "source-in";
    tintCtx.fillStyle = MASK_OVERLAY_COLOR;
    tintCtx.fillRect(0, 0, crop.sw, crop.sh);
    tintCtx.globalCompositeOperation = "source-over";
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(tint, 0, 0, crop.sw, crop.sh, crop.dx, crop.dy, crop.sw, crop.sh);
    ctx.restore();
  }

  getMaskTintScratch(width, height) {
    if (!this._maskTintScratch) this._maskTintScratch = document.createElement("canvas");
    if (this._maskTintScratch.width !== width) this._maskTintScratch.width = width;
    if (this._maskTintScratch.height !== height) this._maskTintScratch.height = height;
    return this._maskTintScratch;
  }

  drawLayerCanvasVisible(ctx, canvas) {
    const crop = this.getVisibleLayerCrop(canvas);
    if (!crop) return;
    ctx.drawImage(canvas, crop.sx, crop.sy, crop.sw, crop.sh, crop.dx, crop.dy, crop.sw, crop.sh);
  }

  drawRasterLayerVisible(ctx, layer) {
    if (layer.hiresCanvas && layer.hiresRect) {
      const visible = this.visibleWorldRect();
      this.drawRasterLayerToWorldRect(ctx, layer, visible, visible, false);
      return;
    }
    this.drawLayerCanvasVisible(ctx, layer.canvas);
  }

  drawRasterLayerToWorldRect(ctx, layer, worldRect, destRect, smoothing = true) {
    if (layer.hiresCanvas && layer.hiresRect) {
      const rect = layer.hiresRect;
      const left = Math.max(worldRect.x, rect.x);
      const top = Math.max(worldRect.y, rect.y);
      const right = Math.min(worldRect.x + worldRect.width, rect.x + rect.width);
      const bottom = Math.min(worldRect.y + worldRect.height, rect.y + rect.height);
      if (right <= left || bottom <= top) return;
      const sx = ((left - rect.x) / rect.width) * layer.hiresCanvas.width;
      const sy = ((top - rect.y) / rect.height) * layer.hiresCanvas.height;
      const sw = ((right - left) / rect.width) * layer.hiresCanvas.width;
      const sh = ((bottom - top) / rect.height) * layer.hiresCanvas.height;
      const dx = destRect.x + ((left - worldRect.x) / worldRect.width) * destRect.width;
      const dy = destRect.y + ((top - worldRect.y) / worldRect.height) * destRect.height;
      const dw = ((right - left) / worldRect.width) * destRect.width;
      const dh = ((bottom - top) / worldRect.height) * destRect.height;
      ctx.save();
      this.configureImageContext(ctx, smoothing);
      ctx.drawImage(layer.hiresCanvas, sx, sy, sw, sh, dx, dy, dw, dh);
      ctx.restore();
      return;
    }
    ctx.drawImage(
      layer.canvas,
      worldRect.x - this.origin.x,
      worldRect.y - this.origin.y,
      worldRect.width,
      worldRect.height,
      destRect.x,
      destRect.y,
      destRect.width,
      destRect.height
    );
  }

  getVisibleLayerCrop(canvas) {
    const visible = this._visibleWorldRectForRender || this.visibleWorldRect();
    const sx = Math.max(0, Math.floor(visible.x - this.origin.x));
    const sy = Math.max(0, Math.floor(visible.y - this.origin.y));
    const ex = Math.min(canvas.width, Math.ceil(visible.x + visible.width - this.origin.x));
    const ey = Math.min(canvas.height, Math.ceil(visible.y + visible.height - this.origin.y));
    const sw = Math.max(0, ex - sx);
    const sh = Math.max(0, ey - sy);
    if (!sw || !sh) return null;
    return { sx, sy, sw, sh, dx: this.origin.x + sx, dy: this.origin.y + sy };
  }

  get activeStaging() {
    if (!this.stagingItems.length) return null;
    if (this.activeStagingIndex < 0 || this.activeStagingIndex >= this.stagingItems.length) {
      this.activeStagingIndex = this.stagingItems.length - 1;
    }
    return this.stagingItems[this.activeStagingIndex] || null;
  }

  isStagingActive() {
    return this.drawInProgress || this.hasOpenStagingPanel();
  }

  hasOpenStagingPanel() {
    return this.stagingItems.length > 0;
  }

  addStagingItem(item) {
    this.stagingItems.push(item);
    this.activeStagingIndex = this.stagingItems.length - 1;
  }

  selectRelativeStaging(direction) {
    if (this.stagingItems.length < 2) return;
    const count = this.stagingItems.length;
    this.activeStagingIndex = (this.activeStagingIndex + direction + count) % count;
    this.render();
  }

  removeActiveStagingItem() {
    if (!this.stagingItems.length) return null;
    const index = Math.max(0, Math.min(this.activeStagingIndex, this.stagingItems.length - 1));
    const [removed] = this.stagingItems.splice(index, 1);
    this.activeStagingIndex = this.stagingItems.length ? Math.min(index, this.stagingItems.length - 1) : -1;
    return removed || null;
  }

  makeMaskedStagingCanvas(staging, img, width, height) {
    const cacheWidth = Math.max(1, Math.round(width));
    const cacheHeight = Math.max(1, Math.round(height));
    if (
      staging._maskedCanvas &&
      staging._maskedCanvas.width === cacheWidth &&
      staging._maskedCanvas.height === cacheHeight &&
      staging._maskedSource === img &&
      staging._maskedMask === staging.maskCanvas
    ) {
      return staging._maskedCanvas;
    }
    const masked = document.createElement("canvas");
    masked.width = cacheWidth;
    masked.height = cacheHeight;
    const maskedCtx = this.configureImageContext(masked.getContext("2d"));
    maskedCtx.drawImage(img, 0, 0, masked.width, masked.height);
    if ((staging.mode === "inpaint" || staging.mode === "outpaint") && staging.maskCanvas) {
      maskedCtx.globalCompositeOperation = "destination-in";
      maskedCtx.drawImage(staging.maskCanvas, 0, 0, masked.width, masked.height);
      maskedCtx.globalCompositeOperation = "source-over";
    }
    staging._maskedCanvas = masked;
    staging._maskedSource = img;
    staging._maskedMask = staging.maskCanvas;
    return masked;
  }

  drawStagingOverlay(ctx) {
    const staging = this.activeStaging;
    if (!staging?.img || staging.visible === false) return;
    const placement = this.getStagingImageRect();
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.drawImage(staging.img, placement.x, placement.y, placement.width, placement.height);
    ctx.restore();
  }

  updateStagingControls() {
    if (!this.stagingControls) return;
    const staging = this.activeStaging;
    if (!staging?.img) {
      this.stagingControls.classList.remove("visible");
      return;
    }
    this.stagingControls.style.left = "50%";
    this.stagingControls.style.right = "";
    this.stagingControls.style.top = "";
    this.stagingControls.style.bottom = "12px";
    this.stagingControls.style.width = "";
    this.stagingControls.style.transform = "translateX(-50%)";
    if (this.stagingCount) this.stagingCount.textContent = `${this.activeStagingIndex + 1}/${this.stagingItems.length}`;
    if (this.stagingPrevBtn) this.stagingPrevBtn.disabled = this.stagingItems.length < 2;
    if (this.stagingNextBtn) this.stagingNextBtn.disabled = this.stagingItems.length < 2;
    if (this.stagingToggleBtn) {
      const visible = staging.visible !== false;
      this.stagingToggleBtn.classList.toggle("active", visible);
      this.stagingToggleBtn.innerHTML = visible ? STAGING_ICONS.show : STAGING_ICONS.hide;
      this.stagingToggleBtn.title = visible ? "Hide result preview" : "Show result preview";
    }
    this.stagingControls.classList.add("visible");
  }

  getImageFitInRect(img, rect) {
    const imgW = img?.naturalWidth || img?.width || rect.width;
    const imgH = img?.naturalHeight || img?.height || rect.height;
    const scale = Math.min(rect.width / Math.max(1, imgW), rect.height / Math.max(1, imgH));
    const width = Math.max(1, Math.round(imgW * scale));
    const height = Math.max(1, Math.round(imgH * scale));
    return {
      x: Math.round(rect.x + (rect.width - width) / 2),
      y: Math.round(rect.y + (rect.height - height) / 2),
      width,
      height,
    };
  }

  getStagingImageRect() {
    const staging = this.activeStaging;
    const rect = staging?.bbox || this.bbox;
    const img = staging?.img;
    if (staging?.displaySize) {
      return {
        x: rect.x,
        y: rect.y,
        width: staging.displaySize.width,
        height: staging.displaySize.height,
      };
    }
    return {
      x: rect.x,
      y: rect.y,
      width: img?.naturalWidth || img?.width || rect.width,
      height: img?.naturalHeight || img?.height || rect.height,
    };
  }

  drawBbox(ctx) {
    ctx.save();
    ctx.strokeStyle = this.tool === "bbox" ? "rgba(212,216,234,1)" : "rgba(255,143,163,.85)";
    ctx.lineWidth = 1 / this.view.scale;
    ctx.setLineDash([5 / this.view.scale, 5 / this.view.scale]);
    ctx.strokeRect(this.bbox.x, this.bbox.y, this.bbox.width, this.bbox.height);
    if (this.tool !== "bbox") {
      ctx.restore();
      return;
    }
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(212,216,234,1)";
    const size = 12 / this.view.scale;
    for (const point of this.bboxHandlePoints()) {
      this.roundRectPath(ctx, point.x - size / 2, point.y - size / 2, size, size, 3 / this.view.scale);
      ctx.fill();
    }
    ctx.strokeStyle = "rgb(42,42,42)";
    ctx.lineWidth = 1 / this.view.scale;
    for (const point of this.bboxHandlePoints()) {
      this.roundRectPath(ctx, point.x - size / 2, point.y - size / 2, size, size, 3 / this.view.scale);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawResizeOverlay(ctx) {
    if (this.tool !== "resize" && this.pointerMode !== "layer-resize") return;
    const bounds = this.pointerMode === "layer-resize" ? this.getLayerWorldBounds(this.activeLayer) : this.getLayerWorldBounds();
    if (!bounds) return;
    ctx.save();
    ctx.strokeStyle = "rgba(212,216,234,.95)";
    ctx.lineWidth = 1.2 / this.view.scale;
    ctx.setLineDash([6 / this.view.scale, 4 / this.view.scale]);
    ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
    ctx.setLineDash([]);
    const size = 12 / this.view.scale;
    for (const point of this.getResizeHandlePoints(bounds)) {
      this.roundRectPath(ctx, point.x - size / 2, point.y - size / 2, size, size, 3 / this.view.scale);
      ctx.fillStyle = "rgba(20,16,30,.92)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,143,163,.95)";
      ctx.stroke();
    }
    ctx.restore();
  }

  drawBboxOverlay(ctx) {
    const stage = this.visibleWorldRect();
    ctx.save();
    ctx.fillStyle = "rgba(13,15,23,.62)";
    ctx.beginPath();
    ctx.rect(stage.x, stage.y, stage.width, stage.height);
    ctx.rect(this.bbox.x, this.bbox.y, this.bbox.width, this.bbox.height);
    ctx.fill("evenodd");
    ctx.restore();
  }

  visibleWorldRect() {
    const size = this.getStageViewportSize();
    const x = -this.view.x / this.view.scale;
    const y = -this.view.y / this.view.scale;
    return {
      x,
      y,
      width: size.width / this.view.scale,
      height: size.height / this.view.scale,
    };
  }

  roundRectPath(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  drawShapeDraft(ctx) {
    if (!this.shapeDraft) return;
    ctx.save();
    ctx.globalAlpha = this.opacity;
    ctx.fillStyle = this.shapeComposite === "destination-out" ? "rgba(255,255,255,.75)" : this.fg;
    ctx.globalCompositeOperation = this.shapeComposite === "destination-out" ? "source-over" : "source-over";
    ctx.fillRect(this.shapeDraft.x, this.shapeDraft.y, this.shapeDraft.width, this.shapeDraft.height);
    ctx.restore();
  }

  drawLassoDraft(ctx) {
    if (this.lassoPoints.length < 2) return;
    ctx.save();
    ctx.fillStyle = "rgba(90,175,255,.2)";
    ctx.strokeStyle = "rgba(90,175,255,1)";
    ctx.lineWidth = 1.5 / this.view.scale;
    ctx.beginPath();
    this.lassoPoints.forEach((p, index) => {
      if (index === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    if (this.lassoPoints.length > 2) {
      ctx.closePath();
      ctx.fill();
    }
    ctx.stroke();
    ctx.restore();
  }

  drawToolPreview(ctx) {
    if (!this.hoverPoint || this.hoverPointerType !== "mouse" || !["brush", "eraser", "mask"].includes(this.tool)) return;
    const radius = this.brushSize / 2;
    const point = this.hoverPoint;
    ctx.save();
    ctx.globalAlpha = this.isPointerDown ? 0 : 0.22;
    ctx.fillStyle = this.tool === "eraser" ? "rgba(255,71,87,.65)" : this.tool === "mask" ? "rgba(255,255,255,.65)" : this.fg;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1 / this.view.scale;
    ctx.strokeStyle = "rgba(0,0,0,1)";
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,.82)";
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius + 1 / this.view.scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  bboxHandlePoints() {
    const x = this.bbox.x;
    const y = this.bbox.y;
    const w = this.bbox.width;
    const h = this.bbox.height;
    return [
      { x, y },
      { x: x + w / 2, y },
      { x: x + w, y },
      { x, y: y + h / 2 },
      { x: x + w, y: y + h / 2 },
      { x, y: y + h },
      { x: x + w / 2, y: y + h },
      { x: x + w, y: y + h },
    ];
  }

  renderLayerList() {
    this.layerList.innerHTML = "";
    for (const layer of this.layers) {
      const row = document.createElement("div");
      row.className = `vnccs-uc-layer ${layer.id === this.activeLayerId ? "active" : ""}`;
      row.draggable = true;
      row.dataset.layerId = layer.id;
      const thumb = document.createElement("canvas");
      thumb.className = "vnccs-uc-thumb";
      thumb.title = layer.visible ? "Hide layer" : "Show layer";
      thumb.width = 68;
      thumb.height = 68;
      this.drawLayerThumbnail(thumb, layer);
      const label = document.createElement("div");
      label.innerHTML = `<div class="vnccs-uc-layer-name">${this._escape(layer.name)}</div><div class="vnccs-uc-layer-type">${layer.type}${layer.visible ? "" : " hidden"}</div>`;
      const lock = this._button(layer.locked ? UI_ICONS.lock : UI_ICONS.unlock, "vnccs-uc-icon", null, layer.locked ? "Unlock layer" : "Lock layer");
      const del = this._button(UI_ICONS.trash, "vnccs-uc-icon danger", null, "Delete layer");
      row.append(thumb, label, lock, del);
      row.addEventListener("click", () => {
        this.activeLayerId = layer.id;
        this.renderLayerList();
        this.syncActiveLayerControls();
        this.render();
      });
      row.addEventListener("dragstart", (e) => {
        this.activeLayerId = layer.id;
        row.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", layer.id);
      });
      row.addEventListener("dragend", () => {
        row.classList.remove("dragging", "drop-before", "drop-after");
        this.clearLayerDropMarkers();
      });
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        const placement = this.getLayerDropPlacement(row, e.clientY);
        this.markLayerDropTarget(row, placement);
        e.dataTransfer.dropEffect = "move";
      });
      row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"));
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        const sourceId = e.dataTransfer.getData("text/plain");
        const placement = this.getLayerDropPlacement(row, e.clientY);
        this.reorderLayer(sourceId, layer.id, placement);
      });
      row.addEventListener("dblclick", async (e) => {
        e.stopPropagation();
        const next = await this.promptInWidget("Rename Layer", "Layer name", layer.name);
        if (next !== null) {
          this.recordHistoryBefore();
          layer.name = String(next).trim() || layer.name;
          this.renderLayerList();
          this.syncToNode();
        }
      });
      thumb.addEventListener("click", (e) => {
        e.stopPropagation();
        this.recordHistoryBefore();
        layer.visible = !layer.visible;
        this.renderLayerList();
        this.render();
        this.syncToNode();
        void this.flushStateUpload(false);
      });
      lock.addEventListener("click", (e) => { e.stopPropagation(); this.recordHistoryBefore(); layer.locked = !layer.locked; this.renderLayerList(); this.syncToNode(); });
      del.addEventListener("click", (e) => { e.stopPropagation(); this.deleteLayer(layer.id); });
      this.layerList.append(row);
    }
    this.layerList.ondragover = (e) => {
      if (!this.layers.length) return;
      e.preventDefault();
    };
    this.layerList.ondrop = (e) => {
      const sourceId = e.dataTransfer.getData("text/plain");
      if (!sourceId || e.target !== this.layerList) return;
      e.preventDefault();
      this.reorderLayer(sourceId, this.layers[this.layers.length - 1]?.id, "after");
    };
    this.syncActiveLayerControls();
  }

  clearLayerDropMarkers() {
    this.layerList.querySelectorAll(".drop-before,.drop-after").forEach((el) => {
      el.classList.remove("drop-before", "drop-after");
    });
  }

  getLayerDropPlacement(row, clientY) {
    const rect = row.getBoundingClientRect();
    return clientY < rect.top + rect.height / 2 ? "before" : "after";
  }

  markLayerDropTarget(row, placement) {
    this.clearLayerDropMarkers();
    row.classList.add(placement === "before" ? "drop-before" : "drop-after");
  }

  reorderLayer(sourceId, targetId, placement = "before") {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const from = this.layers.findIndex((l) => l.id === sourceId);
    const target = this.layers.findIndex((l) => l.id === targetId);
    if (from < 0 || target < 0) return;
    this.recordHistoryBefore();
    const [layer] = this.layers.splice(from, 1);
    let to = this.layers.findIndex((l) => l.id === targetId);
    if (placement === "after") to += 1;
    this.layers.splice(Math.max(0, Math.min(this.layers.length, to)), 0, layer);
    this.activeLayerId = layer.id;
    this.renderLayerList();
    this.render();
    this.syncToNode();
  }

  drawLayerThumbnail(canvas, layer) {
    const ctx = canvas.getContext("2d");
    const size = canvas.width;
    ctx.clearRect(0, 0, size, size);
    const base = this.getLayerThumbnailCanvas(layer, size);
    ctx.drawImage(base, 0, 0);
    if (!layer.visible) this.drawHiddenSlash(ctx, size);
  }

  getLayerThumbnailCanvas(layer, size) {
    if (layer._thumbCache && layer._thumbCache.width === size && layer._thumbCache.height === size) {
      return layer._thumbCache;
    }
    const thumb = document.createElement("canvas");
    thumb.width = size;
    thumb.height = size;
    const ctx = thumb.getContext("2d");
    this.drawCheckerboard(ctx, size, 5);
    const crop = this.getLayerAlphaBounds(layer);
    if (!crop) {
      ctx.fillStyle = layer.type === "mask" ? "rgba(255,143,163,.38)" : "rgba(255,255,255,.18)";
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size * 0.17, 0, Math.PI * 2);
      ctx.fill();
      layer._thumbCache = thumb;
      return thumb;
    }
    const scale = Math.max(size / crop.width, size / crop.height);
    const w = Math.max(1, crop.width * scale);
    const h = Math.max(1, crop.height * scale);
    const x = (size - w) / 2;
    const y = (size - h) / 2;
    if (layer.type === "mask") {
      const tint = document.createElement("canvas");
      tint.width = crop.width;
      tint.height = crop.height;
      const tintCtx = tint.getContext("2d");
      tintCtx.drawImage(layer.canvas, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
      tintCtx.globalCompositeOperation = "source-in";
      tintCtx.fillStyle = MASK_OVERLAY_COLOR;
      tintCtx.fillRect(0, 0, crop.width, crop.height);
      ctx.drawImage(tint, x, y, w, h);
    } else {
      ctx.globalAlpha = layer.opacity;
      ctx.drawImage(layer.canvas, crop.x, crop.y, crop.width, crop.height, x, y, w, h);
      ctx.globalAlpha = 1;
    }
    layer._thumbCache = thumb;
    return thumb;
  }

  drawHiddenSlash(ctx, size) {
    ctx.strokeStyle = "rgba(255,255,255,.68)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(size * 0.22, size * 0.78);
    ctx.lineTo(size * 0.78, size * 0.22);
    ctx.stroke();
  }

  drawCheckerboard(ctx, size, cell = 5) {
    ctx.fillStyle = "hsl(220 12% 10%)";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "hsl(220 12% 16%)";
    for (let y = 0; y < size; y += cell) {
      for (let x = 0; x < size; x += cell) {
        if (((x / cell) + (y / cell)) % 2 === 0) ctx.fillRect(x, y, cell, cell);
      }
    }
  }

  syncActiveLayerControls() {
    this.renderToolSettings();
    const layer = this.activeLayer;
    if (!this.layerSubhead || !layer) return;
    const blend = this.layerSubhead.querySelector('[data-layer-control="blendMode"]');
    const opacity = this.layerSubhead.querySelector('[data-layer-control="opacity"]');
    const opacityValue = this.layerSubhead.querySelector(".vnccs-uc-layer-opacity-value");
    if (blend) blend.value = layer.blendMode || "source-over";
    if (opacity) opacity.value = layer.opacity;
    if (opacityValue) opacityValue.textContent = `${Math.round(layer.opacity * 100)}%`;
  }

  deleteLayer(id) {
    if (this.layers.length <= 1) return;
    this.recordHistoryBefore();
    this.layers = this.layers.filter((l) => l.id !== id);
    if (this.activeLayerId === id) this.activeLayerId = this.layers[0]?.id || null;
    this.renderLayerList();
    this.render();
    this.syncToNode();
  }

  duplicateActiveLayer() {
    const layer = this.activeLayer;
    if (!layer) return;
    this.recordHistoryBefore();
    const copy = {
      id: uid(),
      name: `${layer.name} Copy`,
      type: layer.type,
      visible: layer.visible,
      locked: false,
      opacity: layer.opacity,
      blendMode: layer.blendMode || "source-over",
      canvas: this._createCanvas(),
    };
    this.configureImageContext(copy.canvas.getContext("2d")).drawImage(layer.canvas, 0, 0);
    if (layer.hiresCanvas && layer.hiresRect) {
      copy.hiresCanvas = this.cloneCanvas(layer.hiresCanvas);
      copy.hiresRect = { ...layer.hiresRect };
    }
    this.invalidateLayerCaches(copy);
    const index = this.layers.findIndex((l) => l.id === layer.id);
    this.layers.splice(Math.max(0, index), 0, copy);
    this.activeLayerId = copy.id;
    this.renderLayerList();
    this.render();
    this.syncToNode();
  }

  moveActiveLayer(direction) {
    const index = this.layers.findIndex((l) => l.id === this.activeLayerId);
    if (index < 0) return;
    const nextIndex = Math.max(0, Math.min(this.layers.length - 1, index + direction));
    if (nextIndex === index) return;
    this.recordHistoryBefore();
    const [layer] = this.layers.splice(index, 1);
    this.layers.splice(nextIndex, 0, layer);
    this.renderLayerList();
    this.render();
    this.syncToNode();
  }

  async confirmFlattenLayers() {
    if (this.layers.length <= 1) {
      this.setStatus("There is only one layer");
      return;
    }
    const confirmed = await this.confirmInWidget(
      "Flatten Layers",
      "All visible raster layers will be flattened into one master layer. All other layers will be deleted. This operation cannot be undone.",
      "Flatten"
    );
    if (!confirmed) return;
    this.flattenLayersToMaster();
  }

  flattenLayersToMaster() {
    this.recordHistoryBefore();
    const master = {
      id: uid(),
      name: "Master Layer",
      type: "raster",
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: "source-over",
      canvas: this._createCanvas(),
    };
    const ctx = this.configureImageContext(master.canvas.getContext("2d"), false);
    const worldRect = { x: this.origin.x, y: this.origin.y, width: this.size.width, height: this.size.height };
    const destRect = { x: 0, y: 0, width: this.size.width, height: this.size.height };
    for (const layer of [...this.layers].reverse()) {
      if (!layer.visible || layer.type !== "raster") continue;
      ctx.save();
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = layer.blendMode || "source-over";
      if (layer.hiresCanvas && layer.hiresRect) {
        this.drawRasterLayerToWorldRect(ctx, layer, worldRect, destRect, false);
      } else {
        ctx.drawImage(layer.canvas, 0, 0);
      }
      ctx.restore();
    }
    this.invalidateLayerCaches(master);
    this.layers = [master];
    this.activeLayerId = master.id;
    this.renderLayerList();
    this.render();
    this.syncToNode();
    this.setStatus("Layers flattened to Master Layer");
  }

  async importFile(file) {
    if (!file) return;
    this.recordHistoryBefore();
    const img = await this.loadImage(URL.createObjectURL(file));
    if (!this.ensureWorldBounds(this.bbox.x + img.width, this.bbox.y + img.height, 128)) return;
    if (!this.ensureWorldBounds(this.bbox.x, this.bbox.y, 128)) return;
    const layer = this.addLayer("raster", file.name.replace(/\.[^.]+$/, ""), false);
    const ctx = this.configureImageContext(layer.canvas.getContext("2d"));
    ctx.drawImage(img, this.bbox.x - this.origin.x, this.bbox.y - this.origin.y);
    this.invalidateLayerCaches(layer);
    this.render();
    this.syncToNode();
  }

  loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  fitView() {
    this.centerBbox(true);
    this.render();
  }

  centerBbox(allowZoomOut = false) {
    const size = this.getStageViewportSize();
    if (!size.width || !size.height) return;
    if (allowZoomOut) {
      const fitScale = Math.min(
        (size.width - STAGE_FIT_PADDING_PX * 2) / this.bbox.width,
        (size.height - STAGE_FIT_PADDING_PX * 2) / this.bbox.height,
        1
      );
      this.view.scale = this.constrainStageScale(fitScale);
      this.intendedScale = this.view.scale;
      this.activeSnapPoint = null;
    }
    this.view.x = size.width / 2 - (this.bbox.x + this.bbox.width / 2) * this.view.scale;
    this.view.y = size.height / 2 - (this.bbox.y + this.bbox.height / 2) * this.view.scale;
  }

  makeExportCanvas(type, inferenceSize = this.getInferenceSize(), options = {}) {
    const out = document.createElement("canvas");
    out.width = Math.max(64, Math.round(inferenceSize.width));
    out.height = Math.max(64, Math.round(inferenceSize.height));
    const ctx = this.configureImageContext(out.getContext("2d"));
    if (type === "image" && options.fillBackground) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, out.width, out.height);
    }
    for (const layer of [...this.layers].reverse()) {
      if (!layer.visible) continue;
      if (type === "image" && layer.type !== "raster") continue;
      if (type === "mask" && layer.type !== "mask") continue;
      ctx.save();
      ctx.globalAlpha = type === "image" ? layer.opacity : 1;
      ctx.globalCompositeOperation = type === "image" ? (layer.blendMode || "source-over") : "source-over";
      if (type === "image") {
        this.drawRasterLayerToWorldRect(ctx, layer, this.bbox, { x: 0, y: 0, width: out.width, height: out.height });
      } else {
        ctx.drawImage(
          layer.canvas,
          this.bbox.x - this.origin.x,
          this.bbox.y - this.origin.y,
          Math.max(1, Math.round(this.bbox.width)),
          Math.max(1, Math.round(this.bbox.height)),
          0,
          0,
          out.width,
          out.height
        );
      }
      ctx.restore();
    }
    if (type === "image" && options.forceOpaqueContentAlpha) {
      const imageData = ctx.getImageData(0, 0, out.width, out.height);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 8) data[i + 3] = 255;
      }
      ctx.putImageData(imageData, 0, 0);
    }
    if (type === "mask") this.sanitizeMaskCanvas(out);
    return out;
  }

  sanitizeMaskCanvas(canvas) {
    const ctx = this.configureImageContext(canvas.getContext("2d"));
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      data[i] = alpha > 0 ? 255 : 0;
      data[i + 1] = alpha > 0 ? 255 : 0;
      data[i + 2] = alpha > 0 ? 255 : 0;
      data[i + 3] = alpha;
    }
    ctx.putImageData(imageData, 0, 0);
  }

  makeAlphaMaskCanvasFromImage(img, width, height, options = {}) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const ctx = this.configureImageContext(canvas.getContext("2d"));
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      const luminance = Math.max(data[i], data[i + 1], data[i + 2]);
      const maskAlpha = alpha < 255 ? alpha : luminance;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = maskAlpha > 8 ? maskAlpha : 0;
    }
    ctx.putImageData(imageData, 0, 0);
    if (options.clearEdgeConnected) this.clearEdgeConnectedMaskAlpha(canvas, options.preserveCanvas || null);
    return canvas;
  }

  clearEdgeConnectedMaskAlpha(canvas, preserveCanvas = null) {
    const ctx = canvas.getContext("2d");
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const { data, width, height } = imageData;
    const total = width * height;
    const visited = new Uint8Array(total);
    let preserveData = null;
    if (preserveCanvas) {
      const preserve = document.createElement("canvas");
      preserve.width = width;
      preserve.height = height;
      const preserveCtx = this.configureImageContext(preserve.getContext("2d"));
      preserveCtx.drawImage(preserveCanvas, 0, 0, width, height);
      preserveData = preserveCtx.getImageData(0, 0, width, height).data;
    }
    const seeds = [];
    const alphaAt = (index) => data[index * 4 + 3];
    const preserveAlphaAt = (index) => preserveData ? preserveData[index * 4 + 3] : 0;
    const pushSeed = (x, y) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const index = y * width + x;
      if (alphaAt(index) > 8) seeds.push(index);
    };

    for (let x = 0; x < width; x += 1) {
      pushSeed(x, 0);
      pushSeed(x, height - 1);
    }
    for (let y = 1; y < height - 1; y += 1) {
      pushSeed(0, y);
      pushSeed(width - 1, y);
    }

    while (seeds.length) {
      const component = [];
      let hasPreservedPixels = false;
      const start = seeds.pop();
      if (visited[start] || alphaAt(start) <= 8) continue;
      visited[start] = 1;
      const componentStack = [start];
      while (componentStack.length) {
        const index = componentStack.pop();
        component.push(index);
        if (preserveAlphaAt(index) > 8) hasPreservedPixels = true;
        const x = index % width;
        const y = Math.floor(index / width);
        const pushNeighbor = (nx, ny) => {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
          const next = ny * width + nx;
          if (visited[next] || alphaAt(next) <= 8) return;
          visited[next] = 1;
          componentStack.push(next);
        };
        pushNeighbor(x + 1, y);
        pushNeighbor(x - 1, y);
        pushNeighbor(x, y + 1);
        pushNeighbor(x, y - 1);
      }
      if (!hasPreservedPixels) {
        for (const index of component) data[index * 4 + 3] = 0;
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }

  sanitizeMaskLayer(layer) {
    if (!layer || layer.type !== "mask") return;
    this.sanitizeMaskCanvas(layer.canvas);
  }

  exportCanvas(type, inferenceSize = this.getInferenceSize()) {
    return this.makeExportCanvas(type, inferenceSize).toDataURL("image/png");
  }

  makeRasterAlphaCanvas(inferenceSize = this.getInferenceSize()) {
    const out = document.createElement("canvas");
    out.width = Math.max(64, Math.round(inferenceSize.width));
    out.height = Math.max(64, Math.round(inferenceSize.height));
    const ctx = this.configureImageContext(out.getContext("2d"));
    for (const layer of [...this.layers].reverse()) {
      if (!layer.visible || layer.type !== "raster") continue;
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.drawImage(
        layer.canvas,
        this.bbox.x - this.origin.x,
        this.bbox.y - this.origin.y,
        Math.max(1, Math.round(this.bbox.width)),
        Math.max(1, Math.round(this.bbox.height)),
        0,
        0,
        out.width,
        out.height
      );
      ctx.restore();
    }
    return out;
  }

  makeOutpaintMaskCanvas(userMaskCanvas, inferenceSize = this.getInferenceSize()) {
    const out = document.createElement("canvas");
    out.width = Math.max(64, Math.round(inferenceSize.width));
    out.height = Math.max(64, Math.round(inferenceSize.height));
    const ctx = this.configureImageContext(out.getContext("2d"));
    if (userMaskCanvas) ctx.drawImage(userMaskCanvas, 0, 0, out.width, out.height);
    this.sanitizeMaskCanvas(out);

    const rasterAlpha = this.makeRasterAlphaCanvas(inferenceSize);
    const maskData = ctx.getImageData(0, 0, out.width, out.height);
    const rasterData = rasterAlpha.getContext("2d").getImageData(0, 0, out.width, out.height).data;
    const data = maskData.data;
    for (let i = 0; i < data.length; i += 4) {
      const rasterA = rasterData[i + 3];
      if (rasterA <= 8) {
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(maskData, 0, 0);
    return out;
  }

  getCanvasAlphaStats(canvas) {
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;
    let alphaSum = 0;
    let nonzero = 0;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const alpha = data[(y * canvas.width + x) * 4 + 3];
        alphaSum += alpha;
        if (alpha > 8) {
          nonzero++;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    return {
      size: { width: canvas.width, height: canvas.height },
      alphaSum,
      nonzeroAlphaPixels: nonzero,
      bboxAlphaGt8: nonzero ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
    };
  }

  getLayerDebugSummary() {
    return this.layers.map((layer, index) => ({
      index,
      id: layer.id,
      name: layer.name,
      type: layer.type,
      visible: layer.visible,
      locked: layer.locked,
      opacity: layer.opacity,
      alpha: layer.type === "mask" ? this.getCanvasAlphaStats(layer.canvas) : null,
    }));
  }

  async draw() {
    const generationMode = this.settings.generation_mode || "illustrious";
    if (generationMode !== "anima" && !this.settings.ckpt_name) {
      this.setStatus("Select a checkpoint first", true);
      return;
    }
    if (generationMode === "anima" && (!this.settings.diffusion_model_name || !this.settings.clip_name || !this.settings.vae_name)) {
      this.setStatus("Select Anima diffusion, CLIP and VAE first", true);
      return;
    }
    this.drawInProgress = true;
    const debugId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const requestBbox = { ...this.bbox };
    const inferenceSize = this.getInferenceSize();
    const outputSize = {
      width: Math.max(64, Math.round(requestBbox.width)),
      height: Math.max(64, Math.round(requestBbox.height)),
    };
    const rasterStats = this.getRasterContentInBboxStats();
    const maskStats = this.getMaskContentInBboxStats();
    const bboxPixels = Math.max(1, Math.round(this.bbox.width) * Math.round(this.bbox.height));
    const hasRaster = rasterStats.nonzeroAlphaPixels > 0;
    const rasterCoversBbox = rasterStats.nonzeroAlphaPixels >= bboxPixels;
    const mode = !hasRaster ? "txt2img" : rasterCoversBbox ? "inpaint" : "outpaint";
    const imageCanvas = this.makeExportCanvas("image", inferenceSize, {
      fillBackground: mode === "img2img",
      forceOpaqueContentAlpha: mode === "outpaint",
    });
    const userMaskCanvas = this.makeExportCanvas("mask", inferenceSize);
    const maskCanvas = mode === "outpaint" ? this.makeOutpaintMaskCanvas(userMaskCanvas, inferenceSize) : userMaskCanvas;
    const debug = {
      debugId,
      mode,
      bbox: { ...requestBbox },
      origin: { ...this.origin },
      worldSize: { ...this.size },
      view: { ...this.view },
      inferenceSize,
      outputSize,
      layers: this.getLayerDebugSummary(),
      rasterInBbox: rasterStats,
      maskInBbox: maskStats,
      exportedMask: this.getCanvasAlphaStats(maskCanvas),
    };
    console.debug("[VNCCS UniCanvas] DRAW request", debug);
    this.setStatus(`Drawing ${mode} ${inferenceSize.width}×${inferenceSize.height}...`);
    this.updateGenerationProgress({ progress: 0.01, message: "Starting draw", step: 0, steps: Number(this.settings.steps) || 0 }, true);
    this.startDrawProgressPolling(debugId);
    this.drawBtn.disabled = true;
    try {
      const res = await fetch("/vnccs/unicanvas/draw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          debug_id: debugId,
          mode,
          image: imageCanvas.toDataURL("image/png"),
          mask: maskCanvas.toDataURL("image/png"),
          source_empty: mode === "txt2img",
          bbox: requestBbox,
          inference_size: inferenceSize,
          output_size: outputSize,
          settings: this.settings,
          debug,
        }),
      });
      const data = await res.json();
      console.debug("[VNCCS UniCanvas] DRAW response", { debugId, data });
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      const url = this.imageResultToURL(data.image);
      const img = await this.loadImage(url);
      const stagingMaskCanvas = mode === "inpaint" || mode === "outpaint" ? maskCanvas : null;
      let resultMaskCanvas = null;
      if (data.mask) {
        const maskUrl = this.imageResultToURL(data.mask);
        const maskImg = await this.loadImage(maskUrl);
        resultMaskCanvas = this.makeAlphaMaskCanvasFromImage(maskImg, outputSize.width, outputSize.height, {
          clearEdgeConnected: mode === "inpaint",
          preserveCanvas: stagingMaskCanvas,
        });
      }
      const acceptMaskCanvas = resultMaskCanvas || stagingMaskCanvas;
      this.recordHistoryBefore();
      this.addStagingItem({
        url,
        bbox: { ...requestBbox },
        displaySize: outputSize,
        inferenceSize,
        image: data.image,
        img,
        visible: true,
        mode,
        maskCanvas: acceptMaskCanvas,
        userMaskCanvas: stagingMaskCanvas,
        resultMaskCanvas,
      });
      this.render();
      this.setStatus(`DRAW complete (${this.stagingItems.length} staged)`);
      this.updateGenerationProgress({ progress: 1, message: "Complete", step: Number(this.settings.steps) || 0, steps: Number(this.settings.steps) || 0 }, true);
    } catch (err) {
      this.setStatus(`DRAW failed: ${err.message || err}`, true);
      this.updateGenerationProgress({ progress: 1, message: `Failed: ${err.message || err}`, stage: "error" }, true);
    } finally {
      this.stopDrawProgressPolling();
      this.drawInProgress = false;
      this.drawBtn.disabled = false;
      window.setTimeout(() => {
        if (!this.drawInProgress) this.generationProgress?.classList.remove("visible");
      }, 1800);
    }
  }

  imageResultToURL(image) {
    const params = new URLSearchParams({
      filename: image.filename,
      type: image.type || "temp",
      subfolder: image.subfolder || "",
      t: Date.now().toString(),
    });
    return `/view?${params.toString()}`;
  }

  async acceptStaging() {
    const staging = this.activeStaging;
    if (!staging) return;
    this.recordHistoryBefore();
    const img = staging.img || await this.loadImage(staging.url);
    const placement = this.getStagingImageRect();
    if (!this.ensureWorldBounds(placement.x + placement.width, placement.y + placement.height, 128)) return;
    if (!this.ensureWorldBounds(placement.x, placement.y, 128)) return;
    const layer = this.addLayer("raster", null, false);
    const ctx = this.configureImageContext(layer.canvas.getContext("2d"));
    const hiresWidth = Math.max(1, img.naturalWidth || img.width || placement.width);
    const hiresHeight = Math.max(1, img.naturalHeight || img.height || placement.height);
    const masked = this.makeMaskedStagingCanvas(staging, img, hiresWidth, hiresHeight);
    layer.hiresCanvas = masked;
    layer.hiresRect = { ...placement };
    ctx.drawImage(masked, placement.x - this.origin.x, placement.y - this.origin.y, placement.width, placement.height);
    this.invalidateLayerCaches(layer);
    this.stagingItems = [];
    this.activeStagingIndex = -1;
    this.render();
    this.renderLayerList();
    this.syncToNode();
    this.setStatus("Staging accepted; remaining results discarded");
  }

  discardStaging() {
    this.recordHistoryBefore();
    this.removeActiveStagingItem();
    this.render();
    this.setStatus(this.stagingItems.length ? `Staging discarded (${this.stagingItems.length} left)` : "Staging discarded");
  }

  toggleStagingVisibility() {
    const staging = this.activeStaging;
    if (!staging) return;
    this.recordHistoryBefore();
    staging.visible = staging.visible === false;
    this.render();
  }

  async loadAgPsd() {
    if (this.agPsd) return this.agPsd;
    if (window.agPsd?.writePsd) {
      this.agPsd = window.agPsd;
      return this.agPsd;
    }
    try {
      this.agPsd = await import("./vendor/ag-psd.bundle.mjs");
      return this.agPsd;
    } catch (localErr) {
      console.warn("[VNCCS UniCanvas] local ag-psd load failed, trying CDN", localErr);
    }
    try {
      this.agPsd = await import("https://esm.sh/ag-psd@28.2.2?bundle");
      return this.agPsd;
    } catch (err) {
      throw new Error(`ag-psd load failed: ${err.message || err}`);
    }
  }

  async exportPSD() {
    try {
      this.setStatus("Preparing PSD...");
      const { writePsd } = await this.loadAgPsd();
      if (typeof writePsd !== "function") throw new Error("ag-psd writePsd is not available");
      const visibleLayers = this.layers.filter((layer) => layer.visible && layer.type === "raster" && this.getCanvasAlphaBounds(layer.canvas));
      if (!visibleLayers.length) {
        this.setStatus("No visible raster layers to export", true);
        return;
      }
      const visibleRect = this.getLayersVisibleWorldRect(visibleLayers);
      const maxDimension = 8192;
      const maxArea = maxDimension * maxDimension;
      if (visibleRect.width <= 0 || visibleRect.height <= 0) throw new Error("Invalid PSD bounds");
      if (visibleRect.width > maxDimension || visibleRect.height > maxDimension || visibleRect.width * visibleRect.height > maxArea) {
        throw new Error("Canvas is too large for PSD export");
      }
      const psdLayers = [...visibleLayers].reverse();
      const children = psdLayers.map((layer, index) => {
        const crop = this.getCanvasAlphaBounds(layer.canvas);
        const canvas = document.createElement("canvas");
        canvas.width = crop.width;
        canvas.height = crop.height;
        this.configureImageContext(canvas.getContext("2d")).drawImage(layer.canvas, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
        const worldX = this.origin.x + crop.x;
        const worldY = this.origin.y + crop.y;
        return {
          name: layer.name || `Layer ${index + 1}`,
          left: Math.floor(worldX - visibleRect.x),
          top: Math.floor(worldY - visibleRect.y),
          right: Math.floor(worldX - visibleRect.x + canvas.width),
          bottom: Math.floor(worldY - visibleRect.y + canvas.height),
          opacity: Math.floor(Math.max(0, Math.min(1, layer.opacity)) * 255),
          hidden: false,
          blendMode: layer.blendMode === "source-over" ? "normal" : (layer.blendMode || "normal"),
          canvas,
        };
      });
      const psd = {
        width: visibleRect.width,
        height: visibleRect.height,
        channels: 3,
        bitsPerChannel: 8,
        colorMode: 3,
        children,
      };
      const buffer = writePsd(psd);
      const blob = new Blob([buffer], { type: "application/octet-stream" });
      this.downloadBlob(blob, `unicanvas-layers-${new Date().toISOString().slice(0, 10)}.psd`);
      this.setStatus(`PSD exported: ${children.length} layers`);
    } catch (err) {
      this.setStatus(`PSD failed: ${err.message || err}`, true);
    }
  }

  getLayersVisibleWorldRect(layers) {
    const rects = layers.map((layer) => {
      const crop = this.getCanvasAlphaBounds(layer.canvas);
      return {
        x: this.origin.x + crop.x,
        y: this.origin.y + crop.y,
        width: crop.width,
        height: crop.height,
      };
    });
    const left = Math.floor(Math.min(...rects.map((rect) => rect.x)));
    const top = Math.floor(Math.min(...rects.map((rect) => rect.y)));
    const right = Math.ceil(Math.max(...rects.map((rect) => rect.x + rect.width)));
    const bottom = Math.ceil(Math.max(...rects.map((rect) => rect.y + rect.height)));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  setStatus(text, isError = false) {
    this.status.textContent = text;
    this.status.style.color = isError ? "var(--uc-danger)" : "var(--uc-muted)";
    if (!this.drawInProgress && isError) this.updateGenerationProgress({ message: text, progress: 1, stage: "error" }, true);
  }

  updateGenerationProgress(progress, visible = this.drawInProgress) {
    if (!this.generationProgress) return;
    const value = Math.max(0, Math.min(1, Number(progress?.progress) || 0));
    const step = Number(progress?.step) || 0;
    const steps = Number(progress?.steps) || 0;
    const message = progress?.message || progress?.stage || "Working";
    const detail = steps > 0 ? `${message} (${step}/${steps})` : message;
    this.generationProgress.querySelector(".vnccs-uc-progress-label").textContent = detail;
    this.generationProgress.querySelector(".vnccs-uc-progress-percent").textContent = `${Math.round(value * 100)}%`;
    this.generationProgress.querySelector(".vnccs-uc-progress-fill").style.width = `${value * 100}%`;
    this.generationProgress.classList.toggle("visible", Boolean(visible));
  }

  startDrawProgressPolling(drawId) {
    this.stopDrawProgressPolling();
    const poll = async () => {
      try {
        const res = await fetch(`/vnccs/unicanvas/progress/${encodeURIComponent(drawId)}?t=${Date.now()}`);
        if (!res.ok) return;
        const progress = await res.json();
        this.updateGenerationProgress(progress, true);
      } catch (_err) {
        // Keep the draw running; progress polling is best-effort.
      }
    };
    poll();
    this.drawProgressTimer = window.setInterval(poll, 350);
  }

  stopDrawProgressPolling() {
    if (this.drawProgressTimer) {
      window.clearInterval(this.drawProgressTimer);
      this.drawProgressTimer = null;
    }
  }

  syncPromptControls() {
    this.syncInferenceControls();
    this.container.querySelectorAll("[data-setting]").forEach((el) => {
      const key = el.dataset.setting;
      if (!(key in this.settings)) return;
      if (el instanceof HTMLInputElement && (el.type === "number" || el.type === "range")) {
        el.value = this.formatSettingNumber(this.settings[key], key === "inference_scale" ? 3 : 2);
      } else {
        el.value = this.settings[key];
      }
    });
    this.syncInferenceControls();
    this.syncDenoiseControls();
  }

  syncToNode() {
    if (this._isRestoring) return;
    const widget = this.node.widgets?.find((w) => w.name === "unicanvas_state");
    if (!widget) return;
    const state = this.buildSerializedState(false);
    const compactState = {
      ...state,
      layers: state.layers.map((layer) => ({ ...layer, cached: layer.crop !== null })),
    };
    widget.value = JSON.stringify(compactState);
    widget.callback?.(widget.value);
    app.graph?.setDirtyCanvas?.(true, true);
    this.scheduleStateUpload();
  }

  buildSerializedState(includeLayerData) {
    const stateId = this.getStateCacheId();
    return {
      version: 2,
      storage: "server_cache",
      state_id: stateId,
      origin: this.origin,
      size: this.size,
      bbox: this.bbox,
      settings: this.settings,
      layers: this.layers.map((l) => this.serializeLayer(l, includeLayerData)),
      activeLayerId: this.activeLayerId,
    };
  }

  getStateCacheId() {
    if (!this.stateCacheId) this.stateCacheId = `vnccs_unicanvas_${this.node?.id ?? uid()}`;
    return this.stateCacheId;
  }

  scheduleStateUpload() {
    clearTimeout(this.stateUploadTimer);
    this.pendingStateUpload = true;
    this.stateUploadTimer = window.setTimeout(() => {
      void this.uploadStateSnapshot();
    }, STATE_UPLOAD_DEBOUNCE_MS);
  }

  flushStateUpload(keepalive = false) {
    clearTimeout(this.stateUploadTimer);
    const state = this.buildSerializedState(true);
    this.pendingStateUpload = null;
    return this.uploadStatePayload(state, keepalive);
  }

  async uploadStateSnapshot() {
    if (!this.pendingStateUpload) return;
    this.pendingStateUpload = null;
    const state = this.buildSerializedState(true);
    return this.uploadStatePayload(state, false);
  }

  async uploadStatePayload(state, keepalive = false) {
    const payload = JSON.stringify({ state_id: this.getStateCacheId(), state });
    if (payload === this.lastUploadedStateJSON) return;
    this.lastUploadedStateJSON = payload;
    try {
      const safeKeepalive = keepalive && payload.length <= 60000;
      const res = await fetch("/vnccs/unicanvas_state_upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: safeKeepalive,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      this.lastUploadedStateJSON = "";
      console.warn("[VNCCS UniCanvas] State cache upload failed", err);
      this.setStatus(`State cache failed: ${err.message || err}`, true);
    }
  }

  serializeLayer(layer, includeData = true) {
    const crop = this.getLayerAlphaBounds(layer);
    const payload = {
      id: layer.id,
      name: layer.name,
      type: layer.type,
      visible: layer.visible,
      locked: layer.locked,
      opacity: layer.opacity,
      blendMode: layer.blendMode || "source-over",
      crop,
      dataURL: null,
      hiresRect: layer.hiresRect ? { ...layer.hiresRect } : null,
      hiresDataURL: null,
    };
    if (!crop || !includeData) return payload;
    const out = document.createElement("canvas");
    out.width = crop.width;
    out.height = crop.height;
    this.configureImageContext(out.getContext("2d")).drawImage(layer.canvas, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    payload.dataURL = out.toDataURL("image/png");
    if (layer.hiresCanvas && layer.hiresRect) payload.hiresDataURL = layer.hiresCanvas.toDataURL("image/png");
    return payload;
  }

  getLayerAlphaBounds(layer) {
    if (layer._boundsCache !== undefined) return layer._boundsCache;
    layer._boundsCache = this.getCanvasAlphaBounds(layer.canvas);
    return layer._boundsCache;
  }

  getCanvasAlphaBounds(canvas) {
    const ctx = canvas.getContext("2d");
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] <= 0) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < minX || maxY < minY) return null;
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  async _loadFromNode() {
    const widget = this.node.widgets?.find((w) => w.name === "unicanvas_state");
    if (!widget?.value || widget.value === "{}") return;
    try {
      let state = JSON.parse(widget.value);
      if (![1, 2].includes(state?.version) || !Array.isArray(state.layers)) return;
      if (state.state_id) this.stateCacheId = state.state_id;
      if (state.storage === "server_cache" && state.state_id) {
        try {
          const res = await fetch(`/vnccs/unicanvas_state/${encodeURIComponent(state.state_id)}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const cached = await res.json();
          if (cached?.state?.version && Array.isArray(cached.state.layers)) {
            state = cached.state;
            this.stateCacheId = state.state_id || this.stateCacheId;
          }
        } catch (err) {
          console.warn("[VNCCS UniCanvas] State cache restore failed", err);
          this.setStatus("State cache missing; restored metadata only", true);
        }
      }
      await this.applySerializedState(state);
    } catch (err) {
      console.warn("[VNCCS UniCanvas] Failed to restore state", err);
    }
  }

  async applySerializedState(state) {
    try {
      this.origin = state.origin || this.origin;
      this.size = state.size || this.size;
      this.bbox = state.bbox || this.bbox;
      this.settings = { ...this.settings, ...(state.settings || {}) };
      const layers = [];
      for (const item of state.layers) {
        const layer = {
          id: item.id || uid(),
          name: item.name || "Layer",
          type: item.type === "mask" ? "mask" : "raster",
          visible: item.visible !== false,
          locked: item.locked === true,
          opacity: Number.isFinite(item.opacity) ? item.opacity : 1,
          blendMode: typeof item.blendMode === "string" ? item.blendMode : "source-over",
          canvas: this._createCanvas(),
        };
        if (item.dataURL) {
          const img = await this.loadImage(item.dataURL);
          if (item.crop) {
            this.configureImageContext(layer.canvas.getContext("2d")).drawImage(img, item.crop.x || 0, item.crop.y || 0);
          } else {
            this.configureImageContext(layer.canvas.getContext("2d")).drawImage(img, 0, 0);
          }
        }
        if (item.hiresDataURL && item.hiresRect) {
          const hiresImg = await this.loadImage(item.hiresDataURL);
          const hires = document.createElement("canvas");
          hires.width = Math.max(1, hiresImg.naturalWidth || hiresImg.width);
          hires.height = Math.max(1, hiresImg.naturalHeight || hiresImg.height);
          this.configureImageContext(hires.getContext("2d")).drawImage(hiresImg, 0, 0);
          layer.hiresCanvas = hires;
          layer.hiresRect = { ...item.hiresRect };
        }
        this.sanitizeMaskLayer(layer);
        layers.push(layer);
      }
      if (layers.length) {
        this.layers = layers;
        this.activeLayerId = state.activeLayerId || layers[0].id;
      }
      this.syncPromptControls();
      this.renderLayerList();
    } catch (err) {
      console.warn("[VNCCS UniCanvas] Failed to restore state", err);
    }
  }

  hasMaskContent() {
    for (const layer of this.layers) {
      if (layer.type !== "mask" || !layer.visible) continue;
      const ctx = layer.canvas.getContext("2d");
      const data = ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height).data;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 8) return true;
      }
    }
    return false;
  }

  hasMaskContentInBbox() {
    return this.getMaskContentInBboxStats().nonzeroAlphaPixels > 0;
  }

  getRasterContentInBboxStats() {
    return this.getLayerTypeContentInBboxStats("raster");
  }

  getMaskContentInBboxStats() {
    return this.getLayerTypeContentInBboxStats("mask");
  }

  getLayerTypeContentInBboxStats(type) {
    const sx = Math.max(0, Math.floor(this.bbox.x - this.origin.x));
    const sy = Math.max(0, Math.floor(this.bbox.y - this.origin.y));
    const ex = Math.min(this.size.width, Math.ceil(this.bbox.x + this.bbox.width - this.origin.x));
    const ey = Math.min(this.size.height, Math.ceil(this.bbox.y + this.bbox.height - this.origin.y));
    const width = Math.max(0, ex - sx);
    const height = Math.max(0, ey - sy);
    const stats = {
      crop: { x: sx, y: sy, width, height },
      alphaSum: 0,
      nonzeroAlphaPixels: 0,
      bboxAlphaGt8: null,
    };
    if (!width || !height) return stats;
    const composite = document.createElement("canvas");
    composite.width = width;
    composite.height = height;
    const compositeCtx = this.configureImageContext(composite.getContext("2d"));
    for (const layer of [...this.layers].reverse()) {
      if (layer.type !== type || !layer.visible) continue;
      compositeCtx.save();
      compositeCtx.globalAlpha = type === "raster" ? layer.opacity : 1;
      compositeCtx.globalCompositeOperation = type === "raster" ? (layer.blendMode || "source-over") : "source-over";
      if (type === "raster") {
        this.drawRasterLayerToWorldRect(
          compositeCtx,
          layer,
          { x: this.origin.x + sx, y: this.origin.y + sy, width, height },
          { x: 0, y: 0, width, height }
        );
      } else {
        compositeCtx.drawImage(layer.canvas, sx, sy, width, height, 0, 0, width, height);
      }
      compositeCtx.restore();
    }
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    const data = compositeCtx.getImageData(0, 0, width, height).data;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const alpha = data[(y * width + x) * 4 + 3];
        stats.alphaSum += alpha;
        if (alpha > 8) {
          stats.nonzeroAlphaPixels++;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (stats.nonzeroAlphaPixels) {
      stats.bboxAlphaGt8 = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
    }
    return stats;
  }

  dispose() {
    this.flushStateUpload(true);
    clearTimeout(this.stateUploadTimer);
    if (this._flushStateBeforeUnload) {
      window.removeEventListener("pagehide", this._flushStateBeforeUnload);
      window.removeEventListener("beforeunload", this._flushStateBeforeUnload);
    }
    this.resizeObserver?.disconnect();
  }
}

app.registerExtension({
  name: "VNCCS.UniCanvas",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "VNCCS_UniCanvas") return;

    const syncUniCanvasDOMWidgetWidth = (node) => {
      const widget = node?.widgets?.find((w) => w.name === "unicanvas_ui");
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
              // Keep this DOM widget tied to the node width, matching Pose Studio.
            },
          });
          widget._vnccsWidthBound = true;
        }
        if (typeof widget.triggerDraw === "function") widget.triggerDraw();
      }
    };

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      this.setSize([1280, 720]);
      this.uniCanvasWidget = new UniCanvasWidget(this);
      const domWidget = this.addDOMWidget("unicanvas_ui", "ui", this.uniCanvasWidget.container, {
        serialize: false,
        hideOnZoom: false,
      });
      this.uniCanvasDOMWidget = domWidget;
      syncUniCanvasDOMWidgetWidth(this);
      requestAnimationFrame(() => syncUniCanvasDOMWidgetWidth(this));
      const stateWidget = this.widgets?.find((w) => w.name === "unicanvas_state");
      if (stateWidget) {
        stateWidget.type = "hidden";
        stateWidget.hidden = true;
        stateWidget.computeSize = () => [0, -4];
        if (stateWidget.element) stateWidget.element.style.display = "none";
      }
      setTimeout(() => this.uniCanvasWidget?.resize(), 50);
    };

    nodeType.prototype.onResize = function () {
      syncUniCanvasDOMWidgetWidth(this);
      clearTimeout(this._vnccsUniCanvasResizeTimer);
      this._vnccsUniCanvasResizeTimer = setTimeout(() => {
        syncUniCanvasDOMWidgetWidth(this);
        this.uniCanvasWidget?.resize();
      }, 50);
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      setTimeout(async () => {
        if (!this.uniCanvasWidget) return;
        syncUniCanvasDOMWidgetWidth(this);
        this.uniCanvasWidget._isRestoring = true;
        await this.uniCanvasWidget._loadFromNode();
        this.uniCanvasWidget._isRestoring = false;
        this.uniCanvasWidget.renderLayerList();
        this.uniCanvasWidget.resize();
        this.uniCanvasWidget.fitInitialView();
        this.uniCanvasWidget.render();
      }, 100);
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this.uniCanvasWidget?.dispose();
      onRemoved?.apply(this, arguments);
    };
  },
});
