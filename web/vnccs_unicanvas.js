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
.vnccs-uc-preview-stage { position:absolute; inset:0; width:100%; height:100%; display:block; pointer-events:none; z-index:4; }
.vnccs-uc-hud { position:absolute; left:10px; top:10px; zoom:var(--vnccs-uc-ui-scale); display:flex; gap:6px; align-items:center; pointer-events:none; }
.vnccs-uc-chip { background:rgba(10,10,15,.72); border:1px solid var(--uc-border); border-radius:8px; padding:5px 8px; color:var(--uc-muted); }
.vnccs-uc-generation-progress { grid-column:2; grid-row:2; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; align-items:center; padding:7px 12px; background:rgba(10,10,15,.9); border-bottom:1px solid rgba(255,143,163,.24); box-sizing:border-box; pointer-events:none; min-width:0; visibility:hidden; opacity:0; transition:opacity .16s ease; }
.vnccs-uc-generation-progress.visible { visibility:visible; opacity:1; }
.vnccs-uc-progress-label { color:var(--uc-text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:700; }
.vnccs-uc-progress-percent { color:var(--uc-muted); font-variant-numeric:tabular-nums; min-width:42px; text-align:right; }
.vnccs-uc-progress-track { grid-column:1 / -1; height:6px; border-radius:999px; background:rgba(255,255,255,.12); overflow:hidden; }
.vnccs-uc-progress-fill { height:100%; width:0%; background:linear-gradient(90deg,var(--uc-accent),var(--uc-accent-2)); border-radius:inherit; transition:width .18s ease; }
.vnccs-uc-left { width:320px; zoom:var(--vnccs-uc-ui-scale); display:flex; flex-direction:column; gap:8px; padding:8px; background:rgba(6,5,12,.72); min-height:0; max-height:100%; box-sizing:border-box; overflow-y:auto; overflow-x:hidden; overscroll-behavior:contain; }
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
.vnccs-uc-layer-group { display:flex; flex-direction:column; gap:5px; }
.vnccs-uc-layer-group + .vnccs-uc-layer-group { margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,143,163,.24); }
.vnccs-uc-layer-group-head { display:flex; align-items:center; justify-content:space-between; padding:2px 3px 4px; color:var(--uc-muted); font-weight:800; font-size:10px; letter-spacing:0; text-transform:uppercase; }
.vnccs-uc-layer-group-head.mask { color:#ffd45c; }
.vnccs-uc-layer-group-empty { padding:7px 8px; border:1px dashed rgba(255,255,255,.10); border-radius:8px; color:var(--uc-muted); background:rgba(255,255,255,.025); }
.vnccs-uc-layer-subhead { padding:8px; border-bottom:1px solid var(--uc-border); display:grid; grid-template-columns:92px minmax(0,1fr); gap:8px; align-items:center; }
.vnccs-uc-layer-subhead .vnccs-uc-select { width:100%; }
.vnccs-uc-layer-opacity { display:grid; grid-template-columns:auto minmax(72px,1fr) 38px; gap:7px; align-items:center; color:var(--uc-muted); font-weight:700; }
.vnccs-uc-layer-opacity .vnccs-uc-range { width:100%; }
.vnccs-uc-layer-opacity-value { color:var(--uc-muted); text-align:right; font-variant-numeric:tabular-nums; }
.vnccs-uc-layers-top-actions { padding:6px; border-bottom:1px solid var(--uc-border); display:flex; flex-direction:column; gap:6px; }
.vnccs-uc-layers-top-actions .vnccs-uc-btn { width:100%; }
.vnccs-uc-layer { display:grid; grid-template-columns:34px minmax(0,1fr) 28px 28px; gap:6px; align-items:center; padding:6px; border:1px solid var(--uc-border); border-radius:8px; background:rgba(255,255,255,.035); cursor:pointer; }
.vnccs-uc-layer.active { border-color:rgba(255,143,163,.55); background:rgba(255,143,163,.12); }
.vnccs-uc-layer.locked { border-color:rgba(255,193,7,.42); background:rgba(255,193,7,.08); }
.vnccs-uc-layer.active.locked { border-color:rgba(255,193,7,.62); background:linear-gradient(90deg,rgba(255,193,7,.13),rgba(255,143,163,.10)); }
.vnccs-uc-layer.dragging { opacity:.46; }
.vnccs-uc-layer.drop-before { box-shadow:0 -2px 0 var(--uc-accent); }
.vnccs-uc-layer.drop-after { box-shadow:0 2px 0 var(--uc-accent); }
.vnccs-uc-thumb { width:34px; height:34px; border:1px solid var(--uc-border); border-radius:8px; background:rgba(255,255,255,.04); object-fit:cover; display:block; }
.vnccs-uc-layer-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vnccs-uc-layer-type { color:var(--uc-muted); font-size:10px; }
.vnccs-uc-bottom { grid-column:2; grid-row:1; zoom:var(--vnccs-uc-ui-scale); display:flex; gap:8px; align-items:center; padding:8px; border-bottom:1px solid var(--uc-border); background:rgba(6,5,12,.75); box-sizing:border-box; min-width:0; }
.vnccs-uc-tools { position:absolute; z-index:6; left:16px; top:50%; zoom:var(--vnccs-uc-ui-scale); transform:translateY(-50%); display:flex; flex-direction:column; align-items:stretch; gap:9px; padding:12px; border:1px solid var(--uc-border); border-radius:18px; background:rgba(10,10,15,.84); box-shadow:0 10px 28px rgba(0,0,0,.42); pointer-events:auto; max-height:calc((100% - 16px) / var(--vnccs-uc-ui-scale)); overflow-y:auto; overflow-x:hidden; }
.vnccs-uc-tool-settings { position:absolute; z-index:6; left:16px; top:52px; zoom:var(--vnccs-uc-ui-scale); display:none; flex-direction:column; gap:10px; width:248px; padding:14px; border:1px solid var(--uc-border); border-radius:14px; background:rgba(10,10,15,.86); box-shadow:0 10px 28px rgba(0,0,0,.42); pointer-events:auto; }
.vnccs-uc-tool-settings.visible { display:flex; }
.vnccs-uc-tool-settings-title { color:var(--uc-accent); font-weight:800; font-size:14px; }
.vnccs-uc-tool-setting { display:grid; grid-template-columns:72px minmax(0,1fr); align-items:center; gap:10px; color:var(--uc-muted); font-weight:700; }
.vnccs-uc-tool-setting-label { color:var(--uc-muted); font-size:12px; line-height:1; white-space:nowrap; }
.vnccs-uc-tool-settings .vnccs-uc-range { width:100%; accent-color:var(--uc-accent); }
.vnccs-uc-tool-settings .vnccs-uc-input[type="color"] { width:42px; height:28px; padding:0; border-radius:7px; }
.vnccs-uc-settings { display:flex; align-items:center; gap:6px; min-width:0; }
.vnccs-uc-settings { overflow:auto; flex:1 1 auto; }
.vnccs-uc-settings-spacer { flex:1 1 auto; min-width:16px; }
.vnccs-uc-sam-panel { display:none; flex:0 0 auto; align-items:center; gap:7px; min-width:0; }
.vnccs-uc-sam-panel.visible { display:flex; }
.vnccs-uc-sam-points { min-width:78px; color:var(--uc-muted); font-variant-numeric:tabular-nums; white-space:nowrap; }
.vnccs-uc-sam-dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:4px; vertical-align:-1px; background:var(--uc-good); }
.vnccs-uc-sam-dot.bg { background:var(--uc-danger); }
.vnccs-uc-sam-status { max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--uc-muted); }
.vnccs-uc-sam-mode { min-width:42px; }
.vnccs-uc-btn, .vnccs-uc-icon { border:1px solid var(--uc-border); background:var(--uc-surface); color:var(--uc-text); border-radius:8px; height:28px; padding:0 9px; cursor:pointer; font:inherit; white-space:nowrap; }
.vnccs-uc-icon { width:30px; padding:0; display:grid; place-items:center; }
.vnccs-uc-icon svg { width:16px; height:16px; display:block; fill:none; stroke:currentColor; stroke-width:2.2; stroke-linecap:round; stroke-linejoin:round; }
.vnccs-uc-icon svg .fill { fill:currentColor; stroke:none; }
.vnccs-uc-icon.danger { color:var(--uc-danger); border-color:rgba(255,71,87,.38); }
.vnccs-uc-layer .vnccs-uc-icon { width:28px; height:28px; border-radius:7px; }
.vnccs-uc-layer .vnccs-uc-icon.locked { color:#ffd45c; border-color:rgba(255,212,92,.55); background:rgba(255,212,92,.14); }
.vnccs-uc-tools .vnccs-uc-icon { width:66px; height:66px; border-radius:12px; font-size:18px; font-weight:800; }
.vnccs-uc-tools svg { width:36px; height:36px; display:block; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
.vnccs-uc-tools svg .fill { fill:currentColor; stroke:none; }
.vnccs-uc-btn:hover, .vnccs-uc-icon:hover { background:var(--uc-hover); border-color:rgba(255,255,255,.16); }
.vnccs-uc-btn:disabled, .vnccs-uc-icon:disabled { opacity:.38; cursor:not-allowed; }
.vnccs-uc-btn:disabled:hover, .vnccs-uc-icon:disabled:hover { background:var(--uc-surface); border-color:var(--uc-border); }
.vnccs-uc-btn.primary { background:linear-gradient(135deg,var(--uc-accent),var(--uc-accent-2)); color:#120b13; font-weight:800; border:0; }
.vnccs-uc-btn.primary:disabled,
.vnccs-uc-btn.primary:disabled:hover {
  opacity:.72; color:#120b13; background:linear-gradient(135deg,var(--uc-accent),var(--uc-accent-2)); border:0;
}
.vnccs-uc-btn.danger { color:#ffdce1; border-color:rgba(255,71,87,.35); }
.vnccs-uc-icon.active { border-color:rgba(255,143,163,.7); background:rgba(255,143,163,.18); color:#ffdce5; }
.vnccs-uc-btn.active { border-color:rgba(255,143,163,.7); background:rgba(255,143,163,.18); color:#ffdce5; }
.vnccs-uc-tool.active { border-color:rgba(255,143,163,.7); background:rgba(255,143,163,.18); color:#ffdce5; }
.vnccs-uc-input, .vnccs-uc-select, .vnccs-uc-textarea { background:rgba(255,255,255,.045); border:1px solid var(--uc-border); color:var(--uc-text); border-radius:8px; height:28px; padding:0 8px; font:inherit; min-width:0; color-scheme:dark; }
.vnccs-uc-select option { background:#171320; color:#e8e8f0; font-size:14px; line-height:1.35; }
.vnccs-uc-select option:checked,
.vnccs-uc-select option:hover { background:#3a2a3d; color:#ffdce5; }
.vnccs-uc-select-menu { position:fixed; z-index:999999; max-height:min(70vh, 520px); overflow:auto; overscroll-behavior:contain; padding:6px; border:1px solid rgba(255,143,163,.34); border-radius:12px; background:#171320; color:#e8e8f0; box-shadow:0 16px 44px rgba(0,0,0,.58); box-sizing:border-box; pointer-events:auto; }
.vnccs-uc-select-menu-option { min-height:32px; display:flex; align-items:center; gap:8px; padding:6px 10px; border:0; border-radius:8px; background:transparent; color:inherit; font:inherit; text-align:left; width:100%; cursor:pointer; box-sizing:border-box; }
.vnccs-uc-select-menu-option:hover,
.vnccs-uc-select-menu-option.active { background:rgba(255,143,163,.18); color:#ffdce5; }
.vnccs-uc-select-menu-check { width:18px; flex:0 0 18px; color:#ff8fa3; font-weight:900; }
.vnccs-uc-select-menu-label { flex:1 1 auto; min-width:0; overflow:visible; text-overflow:clip; white-space:nowrap; }
.vnccs-uc-textarea { min-height:54px; height:54px; padding:7px 8px; resize:none; width:100%; box-sizing:border-box; overflow:hidden; line-height:1.28; }
.vnccs-uc-field { display:flex; flex-direction:column; gap:4px; min-width:62px; color:var(--uc-muted); }
.vnccs-uc-field.inline { flex-direction:row; align-items:center; }
.vnccs-uc-range { width:82px; accent-color:var(--uc-accent); }
.vnccs-uc-mode-loader-row { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:6px; }
.vnccs-uc-generation-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:10px 8px; padding-top:2px; }
.vnccs-uc-generation-grid .wide { grid-column:1 / -1; }
.vnccs-uc-stack { display:flex; flex-direction:column; gap:6px; padding:8px; }
.vnccs-uc-model-tabs { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
.vnccs-uc-model-tab { height:30px; border:1px solid var(--uc-border); border-radius:8px; background:var(--uc-surface); color:var(--uc-muted); font:inherit; font-weight:800; text-transform:uppercase; cursor:pointer; }
.vnccs-uc-model-tab.active { border-color:rgba(255,143,163,.72); background:rgba(255,143,163,.18); color:#ffdce5; box-shadow:0 0 0 1px rgba(255,143,163,.12) inset; }
.vnccs-uc-model-panel { display:flex; flex-direction:column; gap:6px; }
.vnccs-uc-model-card-list { display:flex; flex-direction:column; gap:7px; }
.vnccs-uc-model-picker { display:flex; flex-direction:column; gap:8px; }
.vnccs-uc-model-picker-menu { display:none; flex-direction:column; gap:9px; padding:8px; border:1px solid rgba(255,143,163,.18); border-radius:10px; background:rgba(8,8,12,.48); }
.vnccs-uc-model-picker.open .vnccs-uc-model-picker-menu { display:flex; }
.vnccs-uc-model-picker-group { display:flex; flex-direction:column; gap:7px; }
.vnccs-uc-model-picker-group-title { color:#ffdce5; font-size:10px; font-weight:900; letter-spacing:.08em; text-transform:uppercase; }
.vnccs-uc-model-card { display:flex; flex-direction:column; gap:5px; padding:10px 11px 8px; border:1px solid rgba(0,214,143,.25); border-radius:10px; background:rgba(0,214,143,.05); cursor:pointer; min-width:0; }
.vnccs-uc-model-card.head { min-height:58px; }
.vnccs-uc-model-card.turbo { min-height:0; height:34px; padding:0 8px; justify-content:center; border-color:rgba(255,143,163,.76); background:rgba(255,143,163,.14); }
.vnccs-uc-model-card:hover { border-color:rgba(0,214,143,.44); background:rgba(0,214,143,.08); }
.vnccs-uc-model-card.turbo:hover { border-color:rgba(255,143,163,.82); background:rgba(255,143,163,.17); }
.vnccs-uc-model-card.selected { border-color:rgba(255,143,163,.76); background:rgba(255,143,163,.14); box-shadow:0 0 0 1px rgba(255,143,163,.14) inset; }
.vnccs-uc-model-card.missing { border-color:rgba(255,143,163,.32); background:rgba(255,143,163,.055); }
.vnccs-uc-model-card.turbo.missing { border-color:rgba(255,143,163,.52); background:rgba(255,143,163,.08); }
.vnccs-uc-model-card.progress { border-color:rgba(184,169,232,.46); background:rgba(184,169,232,.08); }
.vnccs-uc-model-card-top { display:flex; align-items:center; gap:7px; min-width:0; }
.vnccs-uc-model-card-badge { width:12px; height:12px; border-radius:50%; flex:0 0 auto; background:var(--uc-danger); }
.vnccs-uc-model-card-badge.ok { background:var(--uc-good); }
.vnccs-uc-model-card-badge.progress { background:var(--uc-accent-2); }
.vnccs-uc-model-card-name { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--uc-text); font-size:13px; font-weight:800; line-height:1.2; }
.vnccs-uc-model-card-status { flex:0 0 auto; color:var(--uc-danger); font-size:10px; font-weight:800; text-transform:uppercase; }
.vnccs-uc-model-card-status.ok { color:var(--uc-good); }
.vnccs-uc-model-card-status.progress { color:var(--uc-accent-2); }
.vnccs-uc-model-card-desc { color:var(--uc-muted); font-size:11px; line-height:1.35; }
.vnccs-uc-model-card-actions { display:flex; align-items:center; gap:7px; }
.vnccs-uc-model-card-download { width:100%; height:27px; border:1px solid rgba(255,143,163,.36); border-radius:8px; background:rgba(255,143,163,.1); color:#ffdce5; font:inherit; font-size:10px; font-weight:800; text-transform:uppercase; cursor:pointer; }
.vnccs-uc-model-card-download:disabled { opacity:.55; cursor:not-allowed; }
.vnccs-uc-turbo-section { display:flex; flex-direction:column; gap:6px; padding-top:2px; }
.vnccs-uc-turbo-title { color:var(--uc-accent); font-size:10px; font-weight:900; letter-spacing:.08em; text-transform:uppercase; }
.vnccs-uc-toggle { position:relative; flex:0 0 auto; width:42px; height:22px; border:1px solid rgba(255,143,163,.5); border-radius:999px; background:rgba(255,143,163,.16); }
.vnccs-uc-toggle::after { content:""; position:absolute; top:3px; left:3px; width:14px; height:14px; border-radius:50%; background:var(--uc-muted); transition:left .14s ease, background .14s ease; }
.vnccs-uc-toggle.active::after { left:23px; background:var(--uc-accent); }
.vnccs-uc-lora-stack { display:flex; flex-direction:column; gap:7px; padding-top:4px; }
.vnccs-uc-lora-stack-title { color:var(--uc-accent); font-size:10px; font-weight:900; letter-spacing:.08em; text-transform:uppercase; }
.vnccs-uc-lora-item { display:grid; grid-template-columns:minmax(0,2fr) minmax(64px,1fr); gap:7px; padding:8px; border:1px solid rgba(255,255,255,.07); border-radius:8px; background:rgba(255,255,255,.025); }
.vnccs-uc-lora-item.empty { opacity:.62; }
.vnccs-uc-lora-item .vnccs-uc-select,
.vnccs-uc-lora-item .vnccs-uc-input { width:100%; box-sizing:border-box; }
.vnccs-uc-seed-row { display:grid; grid-template-columns:minmax(0,1fr) 42px; gap:6px; align-items:stretch; }
.vnccs-uc-seed-row .vnccs-uc-input { width:100%; box-sizing:border-box; }
.vnccs-uc-seed-dice { height:28px; border-radius:8px; }
.vnccs-uc-seed-dice svg { width:17px; height:17px; }
.vnccs-uc-seed-dice.active { border-color:rgba(255,143,163,.7); background:rgba(255,143,163,.18); color:#ffdce5; box-shadow:0 0 0 1px rgba(255,143,163,.14) inset; }
.vnccs-uc-draw-footer { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; align-items:center; padding-top:2px; }
.vnccs-uc-layers-footer { padding:6px; border-top:1px solid var(--uc-border); display:flex; flex-direction:column; gap:6px; }
.vnccs-uc-layers-footer .vnccs-uc-btn { width:100%; }
.vnccs-uc-file { display:none; }
.vnccs-uc-row { display:flex; gap:6px; align-items:center; }
.vnccs-uc-staging-popover {
  position:absolute; zoom:var(--vnccs-uc-ui-scale); display:none; gap:8px; align-items:center; justify-content:center; z-index:5;
  padding:10px; background:rgba(10,10,15,.9); border:1px solid rgba(255,255,255,.16);
  border-radius:12px; box-shadow:0 10px 28px rgba(0,0,0,.42); pointer-events:auto;
}
.vnccs-uc-staging-popover.visible { display:flex; }
.vnccs-uc-staging-popover .vnccs-uc-icon { width:44px; height:44px; border-radius:10px; }
.vnccs-uc-staging-popover .vnccs-uc-icon svg { width:22px; height:22px; }
.vnccs-uc-staging-count { min-width:48px; text-align:center; color:var(--uc-text); font-weight:800; font-size:14px; }
.vnccs-uc-transform-label { min-width:92px; }
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

function enableUniCanvasGraphNavigationForwarding(root) {
  if (!root || root._vnccsUniCanvasGraphNavigationForwarding) return;
  root._vnccsUniCanvasGraphNavigationForwarding = true;

  const graphCanvas = () => app.canvasEl || app.canvas?.canvas || document.querySelector("canvas.litegraph");
  let panning = false;

  const markForwarded = (event) => {
    Object.defineProperty(event, "_vnccsUniCanvasForwardedGraphInput", { value: true });
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

  const cloneWheelEvent = (source) => markForwarded(new WheelEvent("wheel", {
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
    const canvasEl = graphCanvas();
    if (!canvasEl) return false;
    const pointerType = type === "mousedown" ? "pointerdown" : type === "mousemove" ? "pointermove" : "pointerup";
    canvasEl.dispatchEvent(clonePointerEvent(pointerType, event, buttons));
    canvasEl.dispatchEvent(cloneMouseEvent(type, event, buttons));
    return true;
  };

  const forwardWheel = (event) => {
    const canvasEl = graphCanvas();
    if (!canvasEl) return false;
    canvasEl.dispatchEvent(cloneWheelEvent(event));
    return true;
  };

  const hasOwnWheelHandler = (target) => {
    for (let el = target; el && el !== root; el = el.parentElement) {
      if (typeof el.onwheel === "function") return true;
    }
    return false;
  };

  const hasScrollableAncestor = (target) => {
    for (let el = target; el && el !== root; el = el.parentElement) {
      if (!(el instanceof HTMLElement)) continue;
      const style = getComputedStyle(el);
      const scrollY = /(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
      const scrollX = /(auto|scroll|overlay)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1;
      if (scrollY || scrollX) return true;
    }
    return false;
  };

  const hasInteractiveTarget = (target) => {
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
      ".vnccs-uc-tools",
      ".vnccs-uc-tool-settings",
      ".vnccs-uc-select-menu",
      ".vnccs-uc-staging-popover",
      ".vnccs-uc-modal-overlay",
      ".vnccs-uc-layers",
      ".vnccs-uc-layer",
    ].join(",")));
  };

  const canForwardFrom = (target) => {
    if (hasInteractiveTarget(target)) return false;
    if (hasOwnWheelHandler(target)) return false;
    if (hasScrollableAncestor(target)) return false;
    return true;
  };

  const finishPan = (event) => {
    if (event._vnccsUniCanvasForwardedGraphInput) return;
    if (!panning) return;
    panning = false;
    event.preventDefault();
    event.stopPropagation();
    forwardMouse("mouseup", event, 0);
    window.removeEventListener("mousemove", movePan, true);
    window.removeEventListener("mouseup", finishPan, true);
  };

  const movePan = (event) => {
    if (event._vnccsUniCanvasForwardedGraphInput) return;
    if (!panning) return;
    event.preventDefault();
    event.stopPropagation();
    forwardMouse("mousemove", event, event.buttons || 4);
  };

  root.addEventListener("mousedown", (event) => {
    if (event._vnccsUniCanvasForwardedGraphInput) return;
    if (event.button !== 1) return;
    if (!canForwardFrom(event.target)) return;
    if (!forwardMouse("mousedown", event, 4)) return;
    panning = true;
    event.preventDefault();
    event.stopPropagation();
    window.addEventListener("mousemove", movePan, true);
    window.addEventListener("mouseup", finishPan, true);
  }, true);

  root.addEventListener("auxclick", (event) => {
    if (event.button !== 1) return;
    if (!canForwardFrom(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  root.addEventListener("wheel", (event) => {
    if (event._vnccsUniCanvasForwardedGraphInput) return;
    if (!canForwardFrom(event.target)) return;
    if (!forwardWheel(event)) return;
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true, passive: false });
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
const STATE_UPLOAD_DEBOUNCE_MS = 1200;
const HISTORY_LIMIT = 20;
const MOVE_SNAP_GRID_SIZE = 64;
const RENDER_LOD_MIN_CANVAS_SIDE = 1024;
const RENDER_LOD_LEVELS = [0.5, 0.25, 0.125, 0.0625];
const RENDER_LOD_OVERSAMPLE = 2.25;
const UNICANVAS_LAYOUT_BASE_WIDTH = 320 / 0.2035;
const UNICANVAS_LAYOUT_BASE_HEIGHT = 34 / 0.0311;
const NUMERIC_SETTINGS = new Set(["inference_scale", "seed", "steps", "cfg", "denoise", "anima_lllite_strength", "fun_controlnet_strength"]);
const UNICANVAS_MODEL_MODULES = {
  sdxl: {
    key: "sdxl",
    aliases: ["illustrious"],
    label: "SDXL",
    base: "sdxl",
    isEditModel: false,
    detect: ["sdxl", "illustrious", "pony", "xl"],
    defaults: {
      generation_mode: "sdxl",
      sampler_name: "euler",
      scheduler: "normal",
      steps: 24,
      cfg: 7,
    },
  },
  anima: {
    key: "anima",
    aliases: [],
    label: "Anima",
    base: "anima",
    isEditModel: false,
    detect: ["anima"],
    defaults: {
      generation_mode: "anima",
      diffusion_model_name: "",
      clip_name: "qwen_3_06b_base.safetensors",
      vae_name: "qwen_image_vae.safetensors",
      clip_type: "stable_diffusion",
      sampler_name: "euler",
      scheduler: "simple",
      steps: 30,
      cfg: 4.5,
      turbo_enabled: false,
      dmd_lora_name: "anima\\anima-turbo-lora-v0.1.safetensors",
      dmd_lora_strength: 1,
      anima_lllite_inpaint: true,
      anima_lllite_name: "anima-lllite-inpainting-v2.safetensors",
      anima_lllite_strength: 1,
    },
  },
  flux_klein: {
    key: "flux_klein",
    aliases: ["flux-klein", "klein"],
    label: "Flux Klein",
    base: "flux_klein",
    isEditModel: true,
    detect: ["klein", "flux-2", "flux2"],
    defaults: {
      generation_mode: "flux_klein",
      model_loader: "diffusion_model",
      diffusion_model_name: "flux-2-klein-9b-fp8.safetensors",
      clip_name: "qwen_3_8b_fp8mixed.safetensors",
      vae_name: "flux2-vae.safetensors",
      clip_type: "flux2",
      sampler_name: "euler",
      scheduler: "simple",
      steps: 4,
      cfg: 1,
    },
  },
  z_image: {
    key: "z_image",
    aliases: ["z-image", "zimage", "z_image_turbo"],
    label: "Z-image",
    base: "z_image",
    isEditModel: false,
    detect: ["z_image", "z-image", "zimage", "z_image_turbo"],
    defaults: {
      generation_mode: "z_image",
      model_loader: "diffusion_model",
      diffusion_model_name: "z_image_turbo_bf16.safetensors",
      clip_name: "qwen_3_4b.safetensors",
      vae_name: "ae.safetensors",
      clip_type: "lumina2",
      sampler_name: "res_multistep",
      scheduler: "simple",
      steps: 8,
      cfg: 1,
      aura_flow_shift: 3,
      fun_controlnet_patch_name: "Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors",
      fun_controlnet_strength: 1,
      fun_controlnet_inpaint: true,
    },
  },
  qwen_image_edit: {
    key: "qwen_image_edit",
    aliases: ["qwen-edit", "qwen_edit", "qwen-image-edit", "qwen_image_edit_2511"],
    label: "Qwen Edit",
    base: "qwen_image_edit",
    isEditModel: true,
    detect: ["qwen-image-edit", "qwen_image_edit", "qwen-edit", "qwen"],
    defaults: {
      generation_mode: "qwen_image_edit",
      model_loader: "gguf",
      gguf_model_name: "qwen-image-edit-2511-Q5_0.gguf",
      clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
      vae_name: "qwen_image_vae.safetensors",
      clip_type: "qwen_image",
      sampler_name: "euler",
      scheduler: "simple",
      steps: 4,
      cfg: 1,
      denoise: 1,
      qwen_lora_name: "",
      qwen_lora_strength: 0,
      qwen_2511: true,
      qwen_target_vl_size: 384,
    },
  },
};
const UNICANVAS_MODEL_LOADERS = {
  checkpoint: {
    key: "checkpoint",
    label: "Checkpoint",
    forcedMode: "sdxl",
    defaults: { model_loader: "checkpoint" },
    fields: [
      { setting: "ckpt_name", label: "Checkpoint", asset: "checkpoints" },
    ],
    validate(settings) {
      return settings.ckpt_name ? null : "Select a checkpoint first";
    },
  },
  diffusion_model: {
    key: "diffusion_model",
    aliases: ["unet", "diffusion"],
    label: "Diffusion Model",
    defaults: { model_loader: "diffusion_model" },
    fields: [
      { setting: "diffusion_model_name", label: "Diffusion Model", asset: "diffusion_models" },
      { setting: "clip_name", label: "CLIP", asset: "text_encoders" },
      { setting: "vae_name", label: "VAE", asset: "vae_models" },
    ],
    validate(settings) {
      return settings.diffusion_model_name && settings.clip_name && settings.vae_name
        ? null
        : "Select diffusion model, CLIP and VAE first";
    },
  },
  gguf: {
    key: "gguf",
    label: "GGUF",
    defaults: { model_loader: "gguf" },
    fields: [
      { setting: "gguf_model_name", label: "GGUF Model", asset: "gguf_models" },
      { setting: "clip_name", label: "CLIP", asset: "text_encoders" },
      { setting: "vae_name", label: "VAE", asset: "vae_models" },
    ],
    validate(settings) {
      return settings.gguf_model_name && settings.clip_name && settings.vae_name
        ? null
        : "Select GGUF model, CLIP and VAE first";
    },
  },
};
const UNICANVAS_MODEL_ALIASES = Object.fromEntries(
  Object.values(UNICANVAS_MODEL_MODULES).flatMap((module) => [[module.key, module.key], ...(module.aliases || []).map((alias) => [alias, module.key])])
);
const UNICANVAS_LOADER_ALIASES = Object.fromEntries(
  Object.values(UNICANVAS_MODEL_LOADERS).flatMap((loader) => [[loader.key, loader.key], ...(loader.aliases || []).map((alias) => [alias, loader.key])])
);

function uniCanvasModelDetectMatches(name, pattern) {
  const source = String(name || "").toLowerCase();
  const token = String(pattern || "").toLowerCase();
  if (!source || !token) return false;
  if (/^[a-z0-9]+$/.test(token)) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[\\s_./\\\\-])${escaped}($|[\\s_./\\\\-])`, "i").test(source);
  }
  return source.includes(token);
}

function getUniCanvasModelModule(mode) {
  const key = UNICANVAS_MODEL_ALIASES[String(mode || "sdxl").toLowerCase()] || "sdxl";
  return UNICANVAS_MODEL_MODULES[key] || UNICANVAS_MODEL_MODULES.sdxl;
}

function getUniCanvasModelLoader(loaderType) {
  const key = UNICANVAS_LOADER_ALIASES[String(loaderType || "checkpoint").toLowerCase()] || "checkpoint";
  return UNICANVAS_MODEL_LOADERS[key] || UNICANVAS_MODEL_LOADERS.checkpoint;
}

function makeDefaultUniCanvasSettings() {
  return {
    ...UNICANVAS_MODEL_MODULES.sdxl.defaults,
    model_selection_mode: "presets",
    selected_preset_id: "sdxl",
    model_loader: "checkpoint",
    ckpt_name: "",
    diffusion_model_name: "",
    gguf_model_name: "",
    clip_name: UNICANVAS_MODEL_MODULES.anima.defaults.clip_name,
    vae_name: UNICANVAS_MODEL_MODULES.anima.defaults.vae_name,
    clip_type: UNICANVAS_MODEL_MODULES.anima.defaults.clip_type,
    turbo_enabled: false,
    dmd_lora_name: UNICANVAS_MODEL_MODULES.anima.defaults.dmd_lora_name,
    dmd_lora_strength: 1,
    lora_stack: [],
    inference_scale: 1,
    positive: "",
    negative: "",
    seed: 0,
    seed_mode: "fixed",
    denoise: 0.65,
    grow_mask_by: 6,
  };
}

const MODEL_SELECTION_SETTINGS = new Set(["ckpt_name", "diffusion_model_name", "gguf_model_name", "clip_name", "vae_name"]);
const TOOL_ICONS = {
  move: `<svg viewBox="0 0 256 256" aria-hidden="true"><path class="fill" d="M224.15,179.17l-46.83-46.82,37.93-13.51.76-.3a20,20,0,0,0-1.76-37.27L54.16,29A20,20,0,0,0,29,54.16L81.27,214.24A20,20,0,0,0,118.54,216c.11-.25.21-.5.3-.76l13.51-37.92,46.83,46.82a20,20,0,0,0,28.28,0l16.69-16.68A20,20,0,0,0,224.15,179.17Zm-30.83,25.17-48.48-48.48A20,20,0,0,0,130.7,150a20.66,20.66,0,0,0-3.74.35A20,20,0,0,0,112.35,162c-.11.25-.21.5-.3.76L100.4,195.5,54.29,54.29l141.21,46.1-32.71,11.66c-.26.09-.51.19-.76.3a20,20,0,0,0-6.17,32.48h0l48.49,48.48Z"/></svg>`,
  brush: `<svg viewBox="0 0 256 256" aria-hidden="true"><path class="fill" d="M236,32a12,12,0,0,0-12-12c-44.78,0-90,48.54-115.9,82a64,64,0,0,0-80,62c0,12-3.1,22.71-9.23,31.76A43,43,0,0,1,9.4,206.05a11.88,11.88,0,0,0-4.91,13.38A12.07,12.07,0,0,0,16.11,228h76A64,64,0,0,0,154,148C187.49,122.05,236,76.8,236,32ZM209.62,46.39c-4,12.92-13.15,27.49-26.92,42.91-3,3.39-6.16,6.7-9.35,9.89a104.31,104.31,0,0,0-16.5-16.51c3.19-3.19,6.49-6.32,9.88-9.35C182.15,59.55,196.71,50.43,209.62,46.39ZM92.07,204H42a80.17,80.17,0,0,0,10.14-40,40,40,0,1,1,40,40Zm38.18-91.32c3.12-3.93,6.55-8.09,10.23-12.35a80.52,80.52,0,0,1,15.23,15.24c-4.26,3.68-8.42,7.11-12.35,10.23A64.43,64.43,0,0,0,130.25,112.68Z"/></svg>`,
  eraser: `<svg viewBox="0 0 256 256" aria-hidden="true"><path class="fill" d="M216,204H141l86.84-86.84a28,28,0,0,0,0-39.6L186.43,36.19a28,28,0,0,0-39.6,0L28.19,154.82a28,28,0,0,0,0,39.6l30.06,30.07A12,12,0,0,0,66.74,228H216a12,12,0,0,0,0-24ZM163.8,53.16a4,4,0,0,1,5.66,0l41.38,41.38a4,4,0,0,1,0,5.65L160,151l-47-47ZM71.71,204,45.16,177.45a4,4,0,0,1,0-5.65L96,121l47,47-36,36Z"/></svg>`,
  mask: `<svg viewBox="0 0 256 256" aria-hidden="true"><path class="fill" d="M156,40a12,12,0,0,1-12,12H112a12,12,0,0,1,0-24h32A12,12,0,0,1,156,40ZM144,204H112a12,12,0,0,0,0,24h32a12,12,0,0,0,0-24ZM208,28H184a12,12,0,0,0,0,24h20V72a12,12,0,0,0,24,0V48A20,20,0,0,0,208,28Zm8,72a12,12,0,0,0-12,12v32a12,12,0,0,0,24,0V112A12,12,0,0,0,216,100Zm0,72a12,12,0,0,0-12,12v20H184a12,12,0,0,0,0,24h24a20,20,0,0,0,20-20V184A12,12,0,0,0,216,172ZM40,156a12,12,0,0,0,12-12V112a12,12,0,0,0-24,0v32A12,12,0,0,0,40,156Zm32,48H52V184a12,12,0,0,0-24,0v24a20,20,0,0,0,20,20H72a12,12,0,0,0,0-24ZM72,28H48A20,20,0,0,0,28,48V72a12,12,0,0,0,24,0V52H72a12,12,0,0,0,0-24Z"/></svg>`,
  sam: `<svg viewBox="0 0 256 256" aria-hidden="true"><path class="fill" d="M252,152a12,12,0,0,1-12,12H228v12a12,12,0,0,1-24,0V164H192a12,12,0,0,1,0-24h12V128a12,12,0,0,1,24,0v12h12A12,12,0,0,1,252,152ZM56,76H68V88a12,12,0,0,0,24,0V76h12a12,12,0,1,0,0-24H92V40a12,12,0,0,0-24,0V52H56a12,12,0,0,0,0,24ZM184,188h-4v-4a12,12,0,0,0-24,0v4h-4a12,12,0,0,0,0,24h4v4a12,12,0,0,0,24,0v-4h4a12,12,0,0,0,0-24ZM222.14,82.83,82.82,222.14a20,20,0,0,1-28.28,0L33.85,201.46a20,20,0,0,1,0-28.29L173.17,33.86a20,20,0,0,1,28.28,0l20.69,20.68A20,20,0,0,1,222.14,82.83ZM159,112,144,97,53.65,187.31l15,15Zm43.31-43.31-15-15L161,80l15,15Z"/></svg>`,
  rect: `<svg viewBox="0 0 256 256" aria-hidden="true"><path class="fill" d="M71.49,60.55a12,12,0,0,0-23,0l-36,120A12,12,0,0,0,24,196H96a12,12,0,0,0,11.49-15.45ZM40.13,172,60,105.76,79.87,172ZM212,74a54,54,0,1,0-54,54A54.06,54.06,0,0,0,212,74Zm-84,0a30,30,0,1,1,30,30A30,30,0,0,1,128,74Zm96,70H136a12,12,0,0,0-12,12v52a12,12,0,0,0,12,12h88a12,12,0,0,0,12-12V156A12,12,0,0,0,224,144Zm-12,52H148V168h64Z"/></svg>`,
  lasso: `<svg viewBox="0 0 256 256" aria-hidden="true"><path class="fill" d="M207.83,56.53C186.32,43.29,158,36,128,36S69.68,43.29,48.17,56.53C24.85,70.89,12,90.6,12,112s12.85,41.14,36.17,55.5c18.48,11.37,42,18.34,67.29,20.08-2,11.07-9.09,17.75-15.22,21.54-13.48,8.31-32.75,9.18-46.86,2.1A12,12,0,1,0,42.62,232.7a71.76,71.76,0,0,0,32,7.3,73.2,73.2,0,0,0,38.18-10.43c15.45-9.54,25-24.58,26.83-41.9,25.6-1.64,49.47-8.65,68.16-20.15C231.15,153.16,244,133.45,244,112S231.15,70.89,207.83,56.53Zm-134.44,97a21,21,0,0,1,20.16-9.35c10.36,1.39,16.54,9.43,19.72,19.13A135.3,135.3,0,0,1,73.39,153.56Zm64.87,10.14a61.84,61.84,0,0,0-10.76-24.82,46.08,46.08,0,0,0-30.75-18.46c-18-2.41-34.52,5.89-44.1,21C42.2,133,36,122.84,36,112c0-28.19,42.13-52,92-52s92,23.82,92,52C220,138.26,183.51,160.71,138.26,163.7Z"/></svg>`,
  resize: `<svg viewBox="0 0 256 256" aria-hidden="true"><path class="fill" d="M140,88a12,12,0,0,1,12-12h32a12,12,0,0,1,12,12v32a12,12,0,0,1-24,0V100H152A12,12,0,0,1,140,88ZM72,180h32a12,12,0,0,0,0-24H84V136a12,12,0,0,0-24,0v32A12,12,0,0,0,72,180ZM236,56V200a20,20,0,0,1-20,20H40a20,20,0,0,1-20-20V56A20,20,0,0,1,40,36H216A20,20,0,0,1,236,56Zm-24,4H44V196H212Z"/></svg>`,
  bbox: `<svg viewBox="0 0 256 256" aria-hidden="true"><path class="fill" d="M208,100a20,20,0,0,0,20-20V48a20,20,0,0,0-20-20H176a20,20,0,0,0-20,20v4H100V48A20,20,0,0,0,80,28H48A20,20,0,0,0,28,48V80a20,20,0,0,0,20,20h4v56H48a20,20,0,0,0-20,20v32a20,20,0,0,0,20,20H80a20,20,0,0,0,20-20v-4h56v4a20,20,0,0,0,20,20h32a20,20,0,0,0,20-20V176a20,20,0,0,0-20-20h-4V100ZM180,52h24V76H180ZM52,52H76V76H52ZM76,204H52V180H76Zm128,0H180V180h24Zm-24-48h-4a20,20,0,0,0-20,20v4H100v-4a20,20,0,0,0-20-20H76V100h4a20,20,0,0,0,20-20V76h56v4a20,20,0,0,0,20,20h4Z"/></svg>`,
  pan: `<svg viewBox="0 0 256 256" aria-hidden="true"><path class="fill" d="M188,44a32,32,0,0,0-8,1V44a32,32,0,0,0-60.79-14A32,32,0,0,0,76,60v50.83a32,32,0,0,0-52,36.7C55.82,214.6,75.35,244,128,244a92.1,92.1,0,0,0,92-92V76A32,32,0,0,0,188,44Zm8,108a68.08,68.08,0,0,1-68,68c-35.83,0-49.71-14-82.48-83.14-.14-.29-.29-.58-.45-.86a8,8,0,0,1,13.85-8l.21.35,18.68,30A12,12,0,0,0,100,152V60a8,8,0,0,1,16,0v60a12,12,0,0,0,24,0V44a8,8,0,0,1,16,0v76a12,12,0,0,0,24,0V76a8,8,0,0,1,16,0Z"/></svg>`,
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
  dice: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="8.5" cy="8.5" r="1.4" class="fill"/><circle cx="15.5" cy="8.5" r="1.4" class="fill"/><circle cx="12" cy="12" r="1.4" class="fill"/><circle cx="8.5" cy="15.5" r="1.4" class="fill"/><circle cx="15.5" cy="15.5" r="1.4" class="fill"/></svg>`,
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
    this.lastHudHTML = "";
    this.tool = "move";
    this.view = { x: 0, y: 0, scale: 1 };
    this.origin = { x: -512, y: -512 };
    this.size = { width: 2048, height: 2048 };
    this.bbox = { x: 0, y: 0, width: 1024, height: 1024 };
    this.shapeDraft = null;
    this.transformDraft = null;
    this.shapeComposite = "source-over";
    this.lassoPoints = [];
    this.hoverPoint = null;
    this.hoverPointerType = "mouse";
    this.brushSize = 48;
    this.lastDrawPointByTool = { brush: null, eraser: null, mask: null };
    this.opacity = 1;
    this.fg = "#ffffff";
    this.resizeKeepAspect = false;
    this.resizeTransformMode = "scale";
    this.isPointerDown = false;
    this.pointerMode = null;
    this.lastPoint = null;
    this.dragStart = null;
    this.dragLayerId = null;
    this.zoomDragStart = null;
    this.intendedScale = 1;
    this.activeSnapPoint = null;
    this.lastScrollEventTimestamp = null;
    this.snapTimeout = null;
    this.didInitialCenter = false;
    this._isRestoring = true;
    this.stateCacheId = this.readStateCacheIdFromWidget() || this.createStateCacheId();
    this.stateBackupKey = null;
    this.stateUploadTimer = null;
    this.lastUploadedStateJSON = "";
    this.pendingStateUpload = null;
    this.localStateBackupDisabled = false;
    this.localStateBackupWarned = false;
    this.stagingItems = [];
    this.activeStagingIndex = -1;
    this.drawInProgress = false;
    this.drawProgressTimer = null;
    this.renderQueued = false;
    this.settingsSyncTimer = null;
    this.fullSyncTimer = null;
    this.layoutLogTimer = null;
    this.customSelectMenu = null;
    this.customSelectSource = null;
    this.thumbnailRenderQueue = [];
    this.thumbnailRenderQueued = false;
    this.lodRenderQueue = [];
    this.lodRenderQueued = false;
    this.deferredCanvasCommitTimer = null;
    this.undoStack = [];
    this.redoStack = [];
    this.historyRestoring = false;
    this.snapToGrid = false;
    this.assets = { checkpoints: [], diffusion_models: [], gguf_models: [], text_encoders: [], vae_models: [], model_patches: [], loras: [], samplers: [], schedulers: [] };
    this.checkpoints = [];
    this.presets = [];
    this.presetDownloads = {};
    this.presetDownloadTimer = null;
    this.presetPickerOpen = false;
    this.settings = makeDefaultUniCanvasSettings();
    if (!this.settings.preset_runtime_settings || typeof this.settings.preset_runtime_settings !== "object") {
      this.settings.preset_runtime_settings = {};
    }
    this.sam = {
      model: "sam2_large",
      mode: "add",
      invert: false,
      points: [],
      maskCanvas: null,
      crop: null,
      layerId: null,
      busy: false,
      status: "",
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
    this.previewCanvas = document.createElement("canvas");
    this.previewCanvas.className = "vnccs-uc-preview-stage";
    this.stageWrap.appendChild(this.previewCanvas);
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
    this.transformControls = document.createElement("div");
    this.transformControls.className = "vnccs-uc-staging-popover";
    this.transformLabel = document.createElement("span");
    this.transformLabel.className = "vnccs-uc-staging-count vnccs-uc-transform-label";
    this.transformLabel.textContent = "Transform";
    this.transformControls.append(
      this._button(STAGING_ICONS.discard, "vnccs-uc-icon danger", () => this.cancelTransformDraft(), "Cancel transform"),
      this.transformLabel,
      this._button(STAGING_ICONS.accept, "vnccs-uc-icon", () => this.applyTransformDraft(), "Apply transform")
    );
    this.stageWrap.appendChild(this.transformControls);
    this.samPanel = document.createElement("div");
    this.samPanel.className = "vnccs-uc-staging-popover vnccs-uc-sam-panel";
    this.samModelSelect = document.createElement("select");
    this.samModelSelect.className = "vnccs-uc-select";
    this.samModelSelect.innerHTML = `
      <option value="sam2_large">SAM2 Large</option>
      <option value="sam1_huge">SAM1 Huge</option>`;
    this.samModelSelect.value = this.sam.model;
    this.samModelSelect.addEventListener("change", () => {
      this.sam.model = this.samModelSelect.value;
      this.clearSamMask(false);
      this.renderSamPanel();
    });
    this.samAddBtn = this._button("+", "vnccs-uc-btn vnccs-uc-sam-mode", () => this.setSamMode("add"), "Add foreground points");
    this.samSubtractBtn = this._button("-", "vnccs-uc-btn vnccs-uc-sam-mode", () => this.setSamMode("subtract"), "Subtract background points");
    this.samInvertBtn = this._button("Invert", "vnccs-uc-btn", () => this.toggleSamInvert(), "Invert mask");
    this.samPointsLabel = document.createElement("span");
    this.samPointsLabel.className = "vnccs-uc-sam-points";
    this.samSegmentBtn = this._button("Segment", "vnccs-uc-btn primary", () => this.segmentSamMask(), "Build SAM mask");
    this.samApplyBtn = this._button(STAGING_ICONS.accept, "vnccs-uc-icon", () => this.applySamMask(), "Apply mask to selected layer");
    this.samClearBtn = this._button(STAGING_ICONS.discard, "vnccs-uc-icon danger", () => this.clearSamPrompt(), "Clear SAM points and mask");
    this.samStatus = document.createElement("span");
    this.samStatus.className = "vnccs-uc-sam-status";
    this.samPanel.append(this.samClearBtn, this.samModelSelect, this.samAddBtn, this.samSubtractBtn, this.samInvertBtn, this.samPointsLabel, this.samSegmentBtn, this.samApplyBtn, this.samStatus);
    this.stageWrap.appendChild(this.samPanel);

    this.left = document.createElement("div");
    this.left.className = "vnccs-uc-left";
    this.side = document.createElement("div");
    this.side.className = "vnccs-uc-side";
    this.denoiseControl = document.createElement("div");
    this.denoiseControl.className = "vnccs-uc-side-control";
    this.denoiseControl.innerHTML = `
      <label class="vnccs-uc-denoise-control"><span data-denoise-label>Denoise</span>
        <input class="vnccs-uc-range" data-setting="denoise" type="range" min="0" max="1" step="0.01" value="${this.settings.denoise}">
        <input class="vnccs-uc-input" data-setting="denoise" type="number" lang="en-US" inputmode="decimal" min="0" max="1" step="0.01" value="${this.settings.denoise}">
      </label>`;
    this.layerList = document.createElement("div");
    this.layerList.className = "vnccs-uc-layers";
    this.maskLayerList = document.createElement("div");
    this.maskLayerList.className = "vnccs-uc-layer-group";
    this.rasterLayerList = document.createElement("div");
    this.rasterLayerList.className = "vnccs-uc-layer-group";
    this.layerList.append(this.maskLayerList, this.rasterLayerList);
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
    const modelModeOptions = Object.values(UNICANVAS_MODEL_MODULES)
      .map((module) => `<option value="${this._escape(module.key)}">${this._escape(module.label)}</option>`)
      .join("");
    const modelLoaderOptions = Object.values(UNICANVAS_MODEL_LOADERS)
      .map((loader) => `<option value="${this._escape(loader.key)}">${this._escape(loader.label)}</option>`)
      .join("");
    const loaderFields = Object.values(UNICANVAS_MODEL_LOADERS).flatMap((loader) =>
      (loader.fields || []).map((field) => `
        <label class="vnccs-uc-field" data-loader-field="${this._escape(loader.key)}">
          ${this._escape(field.label)}<select class="vnccs-uc-select" data-setting="${this._escape(field.setting)}"></select>
        </label>`)
    ).join("");
    this.promptBox.innerHTML = `
      <label class="vnccs-uc-field">Prompt<textarea class="vnccs-uc-textarea" data-setting="positive" placeholder="positive prompt"></textarea></label>
      <label class="vnccs-uc-field">Negative<textarea class="vnccs-uc-textarea" data-setting="negative" placeholder="negative prompt"></textarea></label>
      <div class="vnccs-uc-model-tabs">
        <button class="vnccs-uc-model-tab" type="button" data-model-selection-mode="presets">Presets</button>
        <button class="vnccs-uc-model-tab" type="button" data-model-selection-mode="custom">Custom</button>
      </div>
      <div class="vnccs-uc-model-panel" data-model-panel="presets">
        <div data-preset-card-list></div>
        <label class="vnccs-uc-field">Inference scale<input class="vnccs-uc-input" data-setting="inference_scale" type="number" lang="en-US" inputmode="decimal" min="0.125" step="0.125"></label>
      </div>
      <div class="vnccs-uc-model-panel" data-model-panel="custom">
        <div class="vnccs-uc-mode-loader-row">
          <label class="vnccs-uc-field">Mode<select class="vnccs-uc-select" data-setting="generation_mode">${modelModeOptions}</select></label>
          <label class="vnccs-uc-field">Loader<select class="vnccs-uc-select" data-setting="model_loader">${modelLoaderOptions}</select></label>
        </div>
        <label class="vnccs-uc-field">Inference scale<input class="vnccs-uc-input" data-setting="inference_scale" type="number" lang="en-US" inputmode="decimal" min="0.125" step="0.125"></label>
        ${loaderFields}
      </div>
      <div class="vnccs-uc-turbo-section" data-turbo-panel></div>
      <div class="vnccs-uc-generation-grid">
        <label class="vnccs-uc-field">Steps<input class="vnccs-uc-input" data-setting="steps" type="number"></label>
        <label class="vnccs-uc-field">Sampler<select class="vnccs-uc-select" data-setting="sampler_name"></select></label>
        <label class="vnccs-uc-field">CFG<input class="vnccs-uc-input" data-setting="cfg" type="number" lang="en-US" inputmode="decimal" step="0.1"></label>
        <label class="vnccs-uc-field">Scheduler<select class="vnccs-uc-select" data-setting="scheduler"></select></label>
        <label class="vnccs-uc-field wide">Seed
          <span class="vnccs-uc-seed-row">
            <input class="vnccs-uc-input" data-setting="seed" type="number" min="0">
            <button class="vnccs-uc-icon vnccs-uc-seed-dice" type="button" data-action="seed-mode" title="Random seed">${UI_ICONS.dice}</button>
          </span>
        </label>
      </div>
      <div class="vnccs-uc-lora-stack" data-lora-stack></div>`;
    this.drawBtn = this._button("GENERATE", "vnccs-uc-btn primary", () => this.draw(), "Generate");
    this.drawControl = document.createElement("div");
    this.drawControl.className = "vnccs-uc-draw-control";
    this.drawControl.append(this.drawBtn);
    const promptSection = this._section("Parameters", this.promptBox);

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
      ["sam", "SAM object mask"],
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
    this.fitBtn = this._button("Fit", "vnccs-uc-btn", () => this.fitView(), "Fit");
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
    const normalized = this.normalizeNumericInputValue(input);
    const value = Number(normalized);
    return Number.isFinite(value) ? value : fallback;
  }

  normalizeNumericInputValue(input) {
    const normalized = String(input.value ?? "").replaceAll(",", ".");
    if (input.value !== normalized) {
      input.value = normalized;
    }
    input.lang = "en-US";
    input.inputMode = "decimal";
    return normalized;
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

  generateRandomSeed() {
    const hi = Math.floor(Math.random() * 0x200000);
    const lo = Math.floor(Math.random() * 0x100000000);
    return hi * 0x100000000 + lo || 1;
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

  _createCanvas(width = this.size.width, height = this.size.height, options = { readFrequently: true }) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(width));
    c.height = Math.max(1, Math.round(height));
    if (options?.readFrequently) c.getContext("2d", { willReadFrequently: true });
    return c;
  }

  configureImageContext(ctx, smoothing = true) {
    if (!ctx) return ctx;
    ctx.imageSmoothingEnabled = smoothing;
    if (smoothing) ctx.imageSmoothingQuality = "high";
    return ctx;
  }

  getReadbackContext(canvas, smoothing = true) {
    return this.configureImageContext(canvas.getContext("2d", { willReadFrequently: true }), smoothing);
  }

  _createInitialLayers() {
    if (this.layers.length) return;
    this.addLayer("raster", "Base Layer");
    this.addLayer("mask", "Inpaint Mask");
    this.activeLayerId = this.layers.find((layer) => layer.type === "raster")?.id || this.layers[0]?.id || null;
  }

  getLayerInsertIndex(type = "raster") {
    if (type === "mask") return 0;
    const firstRaster = this.layers.findIndex((layer) => layer.type !== "mask");
    return firstRaster < 0 ? this.layers.length : firstRaster;
  }

  insertLayerByType(layer) {
    if (!layer) return;
    this.layers.splice(this.getLayerInsertIndex(layer.type), 0, layer);
  }

  normalizeLayerOrder() {
    const masks = this.layers.filter((layer) => layer.type === "mask");
    const rasters = this.layers.filter((layer) => layer.type !== "mask");
    this.layers = [...masks, ...rasters];
  }

  addLayer(type = "raster", name = null, recordHistory = true, deferRender = false) {
    const previousActiveLayerId = this.activeLayerId;
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
    this.insertLayerByType(layer);
    this.activeLayerId = layer.id;
    if (recordHistory) {
      this.pushHistoryEntry({ kind: "addLayer", layer, previousActiveLayerId });
    }
    if (deferRender) return layer;
    this.renderLayerList();
    this.requestRender();
    this.syncLightStateToWidget();
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
    layer._renderLodCache = null;
    layer._hiresRenderLodCache = null;
  }

  invalidateLayerThumbnail(layer) {
    if (!layer) return;
    layer._thumbCache = undefined;
  }

  invalidateLayerRenderCaches(layer) {
    if (!layer) return;
    layer._thumbCache = undefined;
    layer._renderLodCache = null;
    layer._hiresRenderLodCache = null;
  }

  markLayerPixelsChanged(layer, bounds = null, expandOnly = false) {
    if (!layer) return;
    layer._thumbCache = undefined;
    layer._renderLodCache = null;
    layer._hiresRenderLodCache = null;
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

  setTool(tool, force = false) {
    if (this.tool === tool && !force) return;
    const previousTool = this.tool;
    this.tool = tool;
    this.container.querySelectorAll(".vnccs-uc-tool").forEach((btn) => btn.classList.toggle("active", btn.dataset.tool === tool));
    this.syncCursorStyle();
    this.renderToolSettings();
    this.renderSamPanel();
    this.updateSamControls();
    this.updateHud();
    this.updateContextCursor();
    this.updateToolPreviewOverlay();
    if (force || this.toolNeedsCanvasRender(previousTool) || this.toolNeedsCanvasRender(tool)) this.requestRender();
  }

  toolNeedsCanvasRender(tool) {
    return ["bbox", "resize"].includes(tool) || Boolean(this.shapeDraft) || Boolean(this.transformDraft) || this.lassoPoints.length > 0;
  }

  getToolSettingControls(tool = this.tool) {
    if (tool === "brush") return ["brushSize", "fg", "opacity"];
    if (tool === "eraser" || tool === "mask") return ["brushSize", "opacity"];
    if (tool === "rect" || tool === "lasso") return ["fg", "opacity"];
    if (tool === "resize") return ["resizeMode", "keepAspect"];
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
    if (controls.includes("resizeMode")) {
      html.push(`<label class="vnccs-uc-tool-setting"><span class="vnccs-uc-tool-setting-label">Mode</span><select class="vnccs-uc-select" data-control="resizeMode"><option value="scale" ${this.resizeTransformMode === "scale" ? "selected" : ""}>Scale</option><option value="perspective" ${this.resizeTransformMode === "perspective" ? "selected" : ""}>Perspective</option></select></label>`);
    }
    this.toolSettings.innerHTML = html.join("");
    this.toolSettings.classList.add("visible");
  }

  renderSamPanel() {
    if (!this.samPanel) return;
    const fgCount = this.sam.points.filter((point) => point.label > 0).length;
    const bgCount = this.sam.points.length - fgCount;
    this.samPointsLabel.innerHTML = `<span class="vnccs-uc-sam-dot"></span>${fgCount} <span class="vnccs-uc-sam-dot bg"></span>${bgCount}`;
    this.samModelSelect.value = this.sam.model;
    this.samAddBtn.classList.toggle("active", this.sam.mode === "add");
    this.samSubtractBtn.classList.toggle("active", this.sam.mode === "subtract");
    this.samInvertBtn.classList.toggle("active", this.sam.invert);
    this.samSegmentBtn.disabled = this.sam.busy || !this.sam.points.length;
    this.samApplyBtn.disabled = this.sam.busy || !this.sam.maskCanvas;
    this.samClearBtn.disabled = this.sam.busy || (!this.sam.points.length && !this.sam.maskCanvas);
    this.samStatus.textContent = this.sam.busy ? "Segmenting..." : (this.sam.status || "");
  }

  setSamMode(mode) {
    this.sam.mode = mode === "subtract" ? "subtract" : "add";
    this.renderSamPanel();
    this.setStatus(this.sam.mode === "subtract" ? "SAM subtract mode" : "SAM add mode");
  }

  toggleSamInvert() {
    this.sam.invert = !this.sam.invert;
    this.renderSamPanel();
    this.updateToolPreviewOverlay();
    this.setStatus(this.sam.invert ? "SAM invert on" : "SAM invert off");
  }

  syncCursorStyle() {
    const cursorMap = {
      brush: "crosshair",
      eraser: "crosshair",
      mask: "crosshair",
      rect: "crosshair",
      lasso: "crosshair",
      sam: "crosshair",
      resize: "default",
      bbox: "move",
      move: "move",
      pan: "grab",
    };
    this.canvas.style.cursor = cursorMap[this.tool] || "default";
  }

  updateContextCursor(point = this.hoverPoint) {
    if (this.isPointerDown) return;
    if (this.tool !== "resize") {
      this.syncCursorStyle();
      return;
    }
    const bounds = this.transformDraft?.bounds || this.getLayerWorldBounds();
    const handle = point ? this.hitResizeHandle(point, bounds) : null;
    const cursorMap = {
      n: "ns-resize",
      s: "ns-resize",
      e: "ew-resize",
      w: "ew-resize",
      nw: "nwse-resize",
      se: "nwse-resize",
      ne: "nesw-resize",
      sw: "nesw-resize",
      rotate: "grab",
    };
    this.canvas.style.cursor = cursorMap[handle] || "default";
  }

  _attachEvents() {
    enableUniCanvasGraphNavigationForwarding(this.container);
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
      if (!(target instanceof HTMLInputElement) || !NUMERIC_SETTINGS.has(target.dataset.setting) || e.key !== ",") return;
      e.preventDefault();
      this.insertDecimalPoint(target);
    });
    const normalizeNumericEvent = (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement) || !target.dataset.setting) return;
      if (!NUMERIC_SETTINGS.has(target.dataset.setting)) return;
      this.normalizeNumericInputValue(target);
    };
    this.container.addEventListener("focusin", normalizeNumericEvent);
    this.container.addEventListener("input", normalizeNumericEvent);
    this.container.addEventListener("paste", () => window.setTimeout(() => {
      this.container.querySelectorAll("input[data-setting]").forEach((input) => {
        if (NUMERIC_SETTINGS.has(input.dataset.setting)) this.normalizeNumericInputValue(input);
      });
    }, 0));
    this.container.addEventListener("pointerdown", (e) => {
      const select = e.target?.closest?.("select.vnccs-uc-select");
      if (!(select instanceof HTMLSelectElement) || select.disabled) return;
      e.preventDefault();
      e.stopPropagation();
      this.openCustomSelect(select);
    }, true);
    window.addEventListener("pointerdown", (e) => {
      if (!this.customSelectMenu) return;
      if (this.customSelectMenu.contains(e.target) || e.target === this.customSelectSource) return;
      this.closeCustomSelect();
    }, true);
    window.addEventListener("keydown", (e) => {
      if (!this.customSelectMenu || e.key !== "Escape") return;
      e.preventDefault();
      this.closeCustomSelect();
    }, true);
    window.addEventListener("resize", () => this.closeCustomSelect(), { passive: true });
    this.container.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("[data-action], [data-model-selection-mode], [data-preset-picker-toggle], [data-preset-id], [data-preset-download], [data-turbo-download], [data-turbo-toggle]");
      if (!(btn instanceof HTMLElement)) return;
      if (btn.dataset.action === "seed-mode") {
        e.preventDefault();
        this.settings.seed_mode = (this.settings.seed_mode || "fixed") === "randomize" ? "fixed" : "randomize";
        this.syncSeedModeControl();
        this.syncSettingsToWidget();
      } else if (btn.dataset.modelSelectionMode) {
        e.preventDefault();
        this.settings.model_selection_mode = btn.dataset.modelSelectionMode === "custom" ? "custom" : "presets";
        this.renderModelSelectionControls();
        this.syncSettingsToWidget();
      } else if (btn.dataset.presetPickerToggle) {
        e.preventDefault();
        this.presetPickerOpen = !this.presetPickerOpen;
        this.renderModelSelectionControls();
      } else if (btn.dataset.presetId) {
        e.preventDefault();
        this.selectPreset(btn.dataset.presetId);
      } else if (btn.dataset.presetDownload) {
        e.preventDefault();
        this.downloadPreset(btn.dataset.presetDownload, "assets");
      } else if (btn.dataset.turboDownload) {
        e.preventDefault();
        this.downloadPreset(btn.dataset.turboDownload, "turbo");
      } else if (btn.dataset.turboToggle) {
        e.preventDefault();
        this.togglePresetTurbo(btn.dataset.turboToggle);
      }
    });
    this.canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.left.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    this.layerList.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    const onLayerSubheadChange = (e) => {
      const target = e.target;
      const layer = this.activeLayer;
      if (!layer || !(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
      if (target.dataset.layerControl === "blendMode") layer.blendMode = target.value || "source-over";
      if (target.dataset.layerControl === "opacity") {
        layer.opacity = Number(target.value);
        this.invalidateLayerThumbnail(layer);
      }
      this.syncActiveLayerControls();
      this.requestRender();
    };
    this.layerSubhead.addEventListener("input", onLayerSubheadChange);
    this.layerSubhead.addEventListener("change", (e) => {
      onLayerSubheadChange(e);
      const layer = this.activeLayer;
      const row = layer ? this.layerList.querySelector(`[data-layer-id="${layer.id}"]`) : null;
      if (row) this.updateLayerRow(row, layer);
      this.syncLightStateToWidget();
      this.clearInputHistoryMarker(e.target);
    });

    this.toolSettings.addEventListener("input", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.dataset.control === "brushSize") this.brushSize = Number(target.value);
      if (target.dataset.control === "fg") this.fg = target.value;
      if (target.dataset.control === "opacity") this.opacity = Number(target.value);
      if (target.dataset.control === "keepAspect") this.resizeKeepAspect = target.checked;
      if (["brushSize", "fg", "opacity"].includes(target.dataset.control)) this.updateToolPreviewOverlay();
      else this.requestRender();
    });
    this.toolSettings.addEventListener("change", (e) => {
      const target = e.target;
      if (target instanceof HTMLInputElement && target.dataset.control === "keepAspect") {
        this.resizeKeepAspect = target.checked;
        this.requestRender();
      }
      if (target instanceof HTMLSelectElement && target.dataset.control === "resizeMode") {
        this.resizeTransformMode = target.value === "perspective" ? "perspective" : "scale";
        this.requestRender();
      }
      this.clearInputHistoryMarker(target);
    });
    this.fileInput.addEventListener("change", () => this.importFile(this.fileInput.files?.[0]));
    this.denoiseControl.addEventListener("input", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement) || target.dataset.setting !== "denoise") return;
      const key = this.getDenoiseControlSetting();
      this.settings[key] = Math.max(0, Math.min(1, this.parseNumericInput(target, this.settings[key])));
      this.syncDenoiseControls(target);
    });
    this.denoiseControl.addEventListener("change", (e) => {
      const target = e.target;
      if (target instanceof HTMLInputElement && target.dataset.setting === "denoise") {
        const key = this.getDenoiseControlSetting();
        this.settings[key] = Math.max(0, Math.min(1, this.parseNumericInput(target, this.settings[key])));
        this.syncDenoiseControls();
        this.syncSettingsToWidget();
      }
      this.clearInputHistoryMarker(target);
    });
    this.left.addEventListener("input", (e) => {
      const target = e.target;
      if (target?.dataset?.loraStackIndex !== undefined) {
        this.updateLoraStackFromControl(target);
        this.syncSettingsToWidget();
        return;
      }
      const key = target?.dataset?.setting;
      if (!key) return;
      this.settings[key] = NUMERIC_SETTINGS.has(key) ? this.parseNumericInput(target, this.settings[key]) : target.value;
      if (target instanceof HTMLTextAreaElement) this.resizeTextareaToContent(target);
      if (key === "generation_mode") this.applyGenerationModeDefaults(target.value);
      if (key === "model_loader") this.applyModelLoaderDefaults(target.value);
      if (["ckpt_name", "diffusion_model_name", "gguf_model_name"].includes(key)) {
        this.autoDetectGenerationModeFromModel();
        this.syncPromptControls();
      }
      if (key === "inference_scale") this.syncInferenceControls(target);
      this.syncSettingsToWidget();
    });
    this.left.addEventListener("change", (e) => {
      const target = e.target;
      if (target?.dataset?.loraStackIndex !== undefined) {
        this.updateLoraStackFromControl(target);
        this.renderLoraStackControls();
        this.syncSettingsToWidget();
        this.clearInputHistoryMarker(target);
        return;
      }
      const key = target?.dataset?.setting;
      if (target instanceof HTMLInputElement && NUMERIC_SETTINGS.has(key)) {
        this.settings[key] = this.parseNumericInput(target, this.settings[key]);
        target.value = this.formatSettingNumber(this.settings[key], key === "inference_scale" ? 3 : 2);
        if (key === "inference_scale") this.syncInferenceControls(target);
        this.syncSettingsToWidget();
      } else if (key) {
        this.syncSettingsToWidget();
      }
      this.clearInputHistoryMarker(target);
    });
    this.setTool(this.tool, true);
  }

  async _loadAssets() {
    try {
      const res = await fetch("/vnccs/unicanvas/assets");
      const data = await res.json();
      this.assets = {
        checkpoints: data.checkpoints || [],
        diffusion_models: data.diffusion_models || [],
        gguf_models: data.gguf_models || [],
        text_encoders: data.text_encoders || [],
        vae_models: data.vae_models || [],
        model_patches: data.model_patches || [],
        loras: data.loras || [],
        samplers: data.samplers || [],
        schedulers: data.schedulers || [],
      };
      this.checkpoints = this.assets.checkpoints;
      for (const loader of Object.values(UNICANVAS_MODEL_LOADERS)) {
        for (const field of loader.fields || []) {
          this.fillSelect(field.setting, this.assets[field.asset] || []);
        }
      }
      this.fillSelect("sampler_name", this.assets.samplers || []);
      this.fillSelect("scheduler", this.assets.schedulers || []);
      this.renderLoraStackControls();
      if (!this.settings.ckpt_name && this.checkpoints[0]) this.settings.ckpt_name = this.checkpoints[0];
      if (!this.settings.diffusion_model_name && this.assets.diffusion_models[0]) this.settings.diffusion_model_name = this.assets.diffusion_models[0];
      if (!this.settings.gguf_model_name && this.assets.gguf_models[0]) this.settings.gguf_model_name = this.assets.gguf_models[0];
      if (!this.settings.clip_name && this.assets.text_encoders[0]) this.settings.clip_name = this.assets.text_encoders[0];
      if (!this.settings.vae_name && this.assets.vae_models[0]) this.settings.vae_name = this.assets.vae_models[0];
      this.normalizeGenerationSettings();
      await this.loadPresets();
      this.syncPromptControls();
    } catch (err) {
      this.setStatus(`Asset list failed: ${err.message || err}`, true);
    }
  }

  async loadPresets() {
    try {
      const res = await fetch(`/vnccs/unicanvas/presets?t=${Date.now()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Preset list failed");
      this.presets = Array.isArray(data.presets) ? data.presets : [];
      this.presetDownloads = data.downloads || {};
    } catch (err) {
      this.presets = [];
      this.presetDownloads = {};
      this.setStatus(`Preset list failed: ${err.message || err}`, true);
    }
  }

  fillSelect(setting, values) {
    const selects = this.container.querySelectorAll(`[data-setting="${setting}"]`);
    if (!selects.length) return;
    const optionValues = [...(values || [])];
    const current = this.settings?.[setting];
    if (setting !== "scheduler" && current && !optionValues.includes(current)) optionValues.unshift(current);
    const options = optionValues.map((name) => `<option value="${this._escape(name)}">${this._escape(name)}</option>`).join("");
    selects.forEach((select) => {
      select.innerHTML = options;
    });
  }

  ensureSelectOption(select, value) {
    if (!(select instanceof HTMLSelectElement) || !value) return;
    const valueString = String(value);
    for (const option of select.options) {
      if (option.value === valueString) return;
    }
    const option = document.createElement("option");
    option.value = valueString;
    option.textContent = valueString;
    select.prepend(option);
  }

  normalizeLoraStack() {
    if (!Array.isArray(this.settings.lora_stack)) this.settings.lora_stack = [];
    while (this.settings.lora_stack.length < 5) {
      this.settings.lora_stack.push({ name: "", strength: 1 });
    }
    this.settings.lora_stack = this.settings.lora_stack.slice(0, 5).map((item) => ({
      name: String(item?.name || item?.lora_name || ""),
      strength: Number.isFinite(Number(item?.strength)) ? Number(item.strength) : 1,
    }));
    return this.settings.lora_stack;
  }

  filteredLoraStack() {
    return this.normalizeLoraStack()
      .filter((item) => item.name && item.name !== "None" && Number(item.strength) !== 0)
      .map((item) => ({ name: item.name, strength: Number(item.strength) }));
  }

  makeSettingsPayload() {
    const settings = JSON.parse(JSON.stringify(this.settings));
    settings.lora_stack = this.filteredLoraStack();
    return settings;
  }

  renderLoraStackControls() {
    const container = this.container.querySelector("[data-lora-stack]");
    if (!container) return;
    const stack = this.normalizeLoraStack();
    const loraOptions = ["", ...(this.assets.loras || [])];
    const optionHTML = loraOptions.map((name) => {
      const label = name || "None";
      return `<option value="${this._escape(name)}">${this._escape(label)}</option>`;
    }).join("");
    container.innerHTML = `<div class="vnccs-uc-lora-stack-title">LoRA Stack</div>`;
    stack.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = `vnccs-uc-lora-item ${item.name ? "" : "empty"}`;
      row.innerHTML = `
        <select class="vnccs-uc-select" data-lora-stack-index="${index}" data-lora-stack-field="name">${optionHTML}</select>
        <input class="vnccs-uc-input" data-lora-stack-index="${index}" data-lora-stack-field="strength" type="number" lang="en-US" inputmode="decimal" step="0.05">`;
      const select = row.querySelector("select");
      const strength = row.querySelector("input");
      if (select) select.value = item.name || "";
      if (strength) strength.value = this.formatSettingNumber(item.strength, 2);
      container.appendChild(row);
    });
  }

  updateLoraStackFromControl(target) {
    const index = Number(target?.dataset?.loraStackIndex);
    const field = target?.dataset?.loraStackField;
    if (!Number.isInteger(index) || index < 0 || index >= 5 || !field) return;
    const stack = this.normalizeLoraStack();
    if (field === "name") stack[index].name = target.value || "";
    if (field === "strength") stack[index].strength = this.parseNumericInput(target, stack[index].strength);
  }

  normalizeRelName(value) {
    return String(value || "").replace(/\\/g, "/").toLowerCase();
  }

  getPresetById(id) {
    return (this.presets || []).find((preset) => preset.id === id) || null;
  }

  getActivePreset() {
    const mode = getUniCanvasModelModule(this.settings.generation_mode).key;
    const byId = this.getPresetById(this.settings.selected_preset_id);
    if (byId && getUniCanvasModelModule(byId.settings?.generation_mode).key === mode) return byId;
    return (this.presets || []).find((preset) => preset.settings?.generation_mode === mode || preset.id === mode) || null;
  }

  presetAssetStatus(asset) {
    const status = this.presetDownloads?.[asset?.download_key] || {};
    const state = status.status || asset?.status || (asset?.installed ? "installed" : "missing");
    const progress = ["queued", "downloading"].includes(state);
    return {
      state,
      progress,
      installed: asset?.installed || state === "success" || state === "installed",
      message: status.message || asset?.message || (asset?.installed ? "Installed" : "Missing"),
      progressValue: status.progress ?? asset?.progress ?? 0,
    };
  }

  presetStatus(preset) {
    const assets = Array.isArray(preset?.assets) ? preset.assets : [];
    if (!assets.length) return { state: "missing", installed: false, progress: false, message: "Missing" };
    const assetStates = assets.map((asset) => this.presetAssetStatus(asset));
    const progress = assetStates.some((item) => item.progress);
    const installed = assetStates.every((item) => item.installed);
    const error = assetStates.find((item) => item.state === "error");
    if (progress) return { state: "progress", installed: false, progress: true, message: "Downloading" };
    if (installed) return { state: "installed", installed: true, progress: false, message: "Installed" };
    if (error) return { state: "missing", installed: false, progress: false, message: error.message || "Error" };
    return { state: "missing", installed: false, progress: false, message: "Missing" };
  }

  buildPresetCard(preset, turbo = false, head = false) {
    const asset = turbo ? preset?.turbo?.asset : null;
    const status = turbo ? this.presetAssetStatus(asset) : this.presetStatus(preset);
    const selected = turbo ? this.isPresetTurboEnabled(preset) : this.settings.selected_preset_id === preset.id;
    const card = document.createElement("div");
    card.role = "button";
    card.tabIndex = 0;
    card.className = `vnccs-uc-model-card ${turbo ? "turbo" : ""} ${head ? "head" : ""} ${selected ? "selected" : ""} ${status.progress ? "progress" : status.installed ? "installed" : "missing"}`;
    if (turbo) {
      card.dataset.turboToggle = preset.id;
    } else if (head) {
      card.dataset.presetPickerToggle = "1";
    } else {
      card.dataset.presetId = preset.id;
    }
    const statusClass = status.progress ? "progress" : status.installed ? "ok" : "missing";
    const statusText = status.progress ? (status.message || "Downloading") : status.installed ? "Installed" : "Download";
    const title = turbo ? preset.turbo?.asset?.name : preset.title;
    const desc = turbo ? preset.turbo?.asset?.description : preset.description;
    const downloadAttrs = turbo ? `data-turbo-download="${this._escape(preset.id)}"` : `data-preset-download="${this._escape(preset.id)}"`;
    const downloadButton = turbo || status.installed || status.progress
      ? ""
      : `<div class="vnccs-uc-model-card-actions"><button type="button" class="vnccs-uc-model-card-download" ${downloadAttrs}>Download</button></div>`;
    const toggle = turbo ? `<span class="vnccs-uc-toggle ${selected ? "active" : ""}" aria-hidden="true"></span>` : "";
    const statusNode = `<span class="vnccs-uc-model-card-status ${statusClass}">${this._escape(statusText)}</span>`;
    card.innerHTML = `
      <span class="vnccs-uc-model-card-top">
        <span class="vnccs-uc-model-card-badge ${statusClass}"></span>
        <span class="vnccs-uc-model-card-name">${this._escape(title || preset.label || preset.id)}</span>
        ${turbo ? `${statusNode}${toggle}` : statusNode}
      </span>
      ${turbo ? "" : `<span class="vnccs-uc-model-card-desc">${this._escape(desc || "")}</span>`}
      ${downloadButton}`;
    return card;
  }

  getPresetGroupLabel(preset) {
    const raw = String(preset?.group || preset?.label || preset?.id || "Model");
    const map = {
      sdxl: "SDXL",
      illustrious: "SDXL",
      anima: "Anima",
      flux_klein: "Flux",
      "flux klein9b": "Flux",
      "z-image": "Z-image",
      "z_image": "Z-image",
      qie2511: "QIE2511",
      qwen_image_edit: "QIE2511",
    };
    return map[raw.toLowerCase()] || raw;
  }

  groupPresetsByType() {
    const groups = new Map();
    for (const preset of this.presets || []) {
      const label = this.getPresetGroupLabel(preset);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(preset);
    }
    return groups;
  }

  renderModelSelectionControls() {
    const mode = this.settings.model_selection_mode === "custom" ? "custom" : "presets";
    this.container.querySelectorAll("[data-model-selection-mode]").forEach((button) => {
      button.classList.toggle("active", button.dataset.modelSelectionMode === mode);
    });
    this.container.querySelectorAll("[data-model-panel]").forEach((panel) => {
      panel.style.display = panel.dataset.modelPanel === mode ? "" : "none";
    });
    const presetPanel = this.container.querySelector("[data-preset-card-list]");
    if (presetPanel) {
      presetPanel.innerHTML = "";
      const picker = document.createElement("div");
      picker.className = `vnccs-uc-model-picker ${this.presetPickerOpen ? "open" : ""}`;
      const activePreset = this.getActivePreset() || (this.presets || [])[0];
      if (activePreset && this.settings.model_selection_mode === "presets") this.settings.selected_preset_id = activePreset.id;
      if (activePreset) {
        picker.appendChild(this.buildPresetCard(activePreset, false, true));
      }
      const menu = document.createElement("div");
      menu.className = "vnccs-uc-model-picker-menu";
      for (const [groupLabel, groupPresets] of this.groupPresetsByType()) {
        const group = document.createElement("div");
        group.className = "vnccs-uc-model-picker-group";
        const title = document.createElement("div");
        title.className = "vnccs-uc-model-picker-group-title";
        title.textContent = groupLabel;
        group.appendChild(title);
        for (const preset of groupPresets) {
          group.appendChild(this.buildPresetCard(preset));
        }
        menu.appendChild(group);
      }
      picker.appendChild(menu);
      presetPanel.appendChild(picker);
    }
    const turboPanel = this.container.querySelector("[data-turbo-panel]");
    if (turboPanel) {
      turboPanel.innerHTML = "";
      const preset = this.getActivePreset();
      if (preset?.turbo?.asset) {
        const title = document.createElement("div");
        title.className = "vnccs-uc-turbo-title";
        title.textContent = "Turbo LoRA";
        turboPanel.append(title, this.buildPresetCard(preset, true));
        turboPanel.style.display = "";
      } else {
        turboPanel.style.display = "none";
      }
    }
  }

  presetRuntimeSettingKeys(preset) {
    const keys = [
      "steps",
      "cfg",
      "sampler_name",
      "scheduler",
      "inference_scale",
      "denoise",
      "turbo_enabled",
      "dmd_lora_name",
      "dmd_lora_strength",
      "qwen_lora_name",
      "qwen_lora_strength",
    ];
    const previousKey = this.getPresetTurboPreviousKey(preset);
    if (previousKey) keys.push(previousKey);
    return keys;
  }

  presetRuntimeSettingsStore() {
    if (!this.settings.preset_runtime_settings || typeof this.settings.preset_runtime_settings !== "object") {
      this.settings.preset_runtime_settings = {};
    }
    return this.settings.preset_runtime_settings;
  }

  snapshotPresetRuntimeSettings(preset) {
    if (!preset?.id) return;
    const snapshot = {};
    for (const key of this.presetRuntimeSettingKeys(preset)) {
      if (this.settings[key] !== undefined) snapshot[key] = this.settings[key];
    }
    this.presetRuntimeSettingsStore()[preset.id] = snapshot;
  }

  restorePresetRuntimeSettings(preset) {
    if (!preset?.id) return {};
    const saved = this.presetRuntimeSettingsStore()[preset.id];
    return saved && typeof saved === "object" ? saved : {};
  }

  applyPresetSettings(preset) {
    if (!preset?.settings) return;
    const savedRuntimeSettings = this.restorePresetRuntimeSettings(preset);
    this.settings = {
      ...this.settings,
      ...preset.settings,
      ...savedRuntimeSettings,
      model_selection_mode: "presets",
      selected_preset_id: preset.id,
    };
    this.presetRuntimeSettingsStore();
    const module = getUniCanvasModelModule(this.settings.generation_mode);
    this.settings.generation_mode = module.key;
    this.syncInferenceControls();
  }

  selectPreset(presetId) {
    const preset = this.getPresetById(presetId);
    if (!preset) return;
    const currentPreset = this.getActivePreset();
    if (currentPreset?.id && currentPreset.id !== preset.id) this.snapshotPresetRuntimeSettings(currentPreset);
    this.applyPresetSettings(preset);
    this.presetPickerOpen = false;
    const status = this.presetStatus(preset);
    if (!status.installed && !status.progress) this.downloadPreset(preset.id, "assets");
    this.syncPromptControls();
    this.syncSettingsToWidget();
  }

  isPresetTurboEnabled(preset) {
    const turbo = preset?.turbo;
    if (!turbo?.asset) return false;
    const setting = turbo.setting || "dmd_lora_name";
    const strengthSetting = turbo.strength_setting || "dmd_lora_strength";
    if (turbo.enable_setting && this.settings[turbo.enable_setting] !== true) return false;
    return this.normalizeRelName(this.settings[setting]) === this.normalizeRelName(turbo.asset.relative_name)
      && Number(this.settings[strengthSetting] ?? 0) > 0;
  }

  getPresetTurboPreviousKey(preset) {
    return `${preset?.id || "preset"}_turbo_previous_settings`;
  }

  getPresetTurboSettings(preset) {
    const fallbackTurboSettings = {
      sdxl: { steps: 4, cfg: 1 },
      anima: { steps: 12, cfg: 1 },
      qwen_image_edit: { steps: 4, cfg: 1 },
    };
    return {
      ...(fallbackTurboSettings[preset.id] || fallbackTurboSettings[preset.settings?.generation_mode] || {}),
      ...(preset?.turbo?.turbo_settings || {}),
    };
  }

  applyPresetTurboParameterProfile(preset) {
    if (!preset?.turbo?.asset) return;
    const previousKey = this.getPresetTurboPreviousKey(preset);
    const turboSettings = this.getPresetTurboSettings(preset);
    if (!this.settings[previousKey]) {
      this.settings[previousKey] = {
        steps: this.settings.steps,
        cfg: this.settings.cfg,
        sampler_name: this.settings.sampler_name,
        scheduler: this.settings.scheduler,
      };
    }
    if (Number.isFinite(Number(turboSettings.steps))) this.settings.steps = Number(turboSettings.steps);
    if (Number.isFinite(Number(turboSettings.cfg))) this.settings.cfg = Number(turboSettings.cfg);
    if (turboSettings.sampler_name) this.settings.sampler_name = turboSettings.sampler_name;
    if (turboSettings.scheduler) this.settings.scheduler = turboSettings.scheduler;
  }

  restorePresetTurboParameterProfile(preset) {
    if (!preset?.turbo?.asset) return;
    const previousKey = this.getPresetTurboPreviousKey(preset);
    const previous = this.settings[previousKey];
    if (previous && typeof previous === "object") {
      if (Number.isFinite(Number(previous.steps))) this.settings.steps = Number(previous.steps);
      if (Number.isFinite(Number(previous.cfg))) this.settings.cfg = Number(previous.cfg);
      if (previous.sampler_name) this.settings.sampler_name = previous.sampler_name;
      if (previous.scheduler) this.settings.scheduler = previous.scheduler;
    }
    this.settings[previousKey] = null;
  }

  togglePresetTurbo(presetId) {
    const preset = this.getPresetById(presetId);
    const turbo = preset?.turbo;
    if (!turbo?.asset) return;
    const setting = turbo.setting || "dmd_lora_name";
    const strengthSetting = turbo.strength_setting || "dmd_lora_strength";
    const enableSetting = turbo.enable_setting;
    const enabled = !this.isPresetTurboEnabled(preset);
    this.settings[setting] = enabled ? (turbo.asset.relative_name || this.settings[setting] || "") : "";
    this.settings[strengthSetting] = enabled ? 1 : 0;
    if (enableSetting) this.settings[enableSetting] = enabled;
    if (enabled) {
      this.applyPresetTurboParameterProfile(preset);
    } else {
      this.restorePresetTurboParameterProfile(preset);
    }
    if (enabled && !this.presetAssetStatus(turbo.asset).installed) this.downloadPreset(preset.id, "turbo");
    this.syncPromptControls();
    this.renderModelSelectionControls();
    this.syncSettingsToWidget();
  }

  async downloadPreset(presetId, kind = "assets") {
    try {
      const res = await fetch("/vnccs/unicanvas/presets/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset_id: presetId, kind }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Download failed");
      for (const key of data.queued || []) {
        this.presetDownloads[key] = { status: "queued", message: "Queued", progress: 0 };
      }
      this.renderModelSelectionControls();
      this.startPresetDownloadPolling();
    } catch (err) {
      this.setStatus(`Preset download failed: ${err.message || err}`, true);
    }
  }

  startPresetDownloadPolling() {
    if (this.presetDownloadTimer) return;
    this.presetDownloadTimer = window.setInterval(() => this.refreshPresetDownloadStatus(), 2000);
    this.refreshPresetDownloadStatus();
  }

  async refreshPresetDownloadStatus() {
    try {
      const res = await fetch(`/vnccs/unicanvas/presets/status?t=${Date.now()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Status failed");
      this.presetDownloads = data || {};
      await this.loadPresets();
      this.renderModelSelectionControls();
      const active = Object.values(this.presetDownloads).some((item) => ["queued", "downloading"].includes(item?.status));
      if (!active && this.presetDownloadTimer) {
        window.clearInterval(this.presetDownloadTimer);
        this.presetDownloadTimer = null;
        await this._loadAssets();
      }
    } catch (err) {
      if (this.presetDownloadTimer) {
        window.clearInterval(this.presetDownloadTimer);
        this.presetDownloadTimer = null;
      }
      this.setStatus(`Preset status failed: ${err.message || err}`, true);
    }
  }

  normalizeGenerationSettings() {
    const loader = getUniCanvasModelLoader(this.settings.model_loader);
    this.settings.model_loader = loader.key;
    if (this.settings.model_selection_mode !== "presets") {
      for (const field of loader.fields || []) {
        const values = this.assets[field.asset] || [];
        if (values.length && !values.includes(this.settings[field.setting])) {
          this.settings[field.setting] = values[0];
        }
      }
    }
    if (loader.forcedMode) this.settings.generation_mode = loader.forcedMode;
    const module = getUniCanvasModelModule(this.settings.generation_mode);
    this.settings.generation_mode = module.key;
    return { module, loader };
  }

  applyInferenceModuleDefaults(mode, options = {}) {
    const module = getUniCanvasModelModule(mode);
    const preserveModelSelection = Boolean(options.preserveModelSelection);
    const preserved = {};
    for (const key of MODEL_SELECTION_SETTINGS) {
      if (preserveModelSelection || !Object.prototype.hasOwnProperty.call(module.defaults, key) || module.defaults[key] === "") {
        preserved[key] = this.settings[key];
      }
    }
    this.settings = { ...this.settings, ...module.defaults, ...preserved, generation_mode: module.key };
    return module;
  }

  applyGenerationModeDefaults(mode) {
    this.applyInferenceModuleDefaults(mode);
    this.syncInferenceControls();
    this.syncPromptControls();
  }

  applyModelLoaderDefaults(loaderType) {
    const loader = getUniCanvasModelLoader(loaderType);
    this.settings = { ...this.settings, ...loader.defaults, model_loader: loader.key };
    for (const field of loader.fields || []) {
      const values = this.assets[field.asset] || [];
      if (values.length && !values.includes(this.settings[field.setting])) {
        this.settings[field.setting] = values[0];
      }
    }
    if (loader.forcedMode) {
      this.applyInferenceModuleDefaults(loader.forcedMode);
    } else {
      this.autoDetectGenerationModeFromModel();
    }
    this.syncPromptControls();
  }

  getSelectedModelNameForLoader() {
    const loader = getUniCanvasModelLoader(this.settings.model_loader);
    if (loader.key === "checkpoint") return this.settings.ckpt_name || "";
    if (loader.key === "gguf") return this.settings.gguf_model_name || "";
    return this.settings.diffusion_model_name || "";
  }

  autoDetectGenerationModeFromModel() {
    const loader = getUniCanvasModelLoader(this.settings.model_loader);
    if (loader.forcedMode) {
      this.applyInferenceModuleDefaults(loader.forcedMode);
      return;
    }
    const name = String(this.getSelectedModelNameForLoader() || "").toLowerCase();
    if (!name) return;
    for (const module of Object.values(UNICANVAS_MODEL_MODULES)) {
      if ((module.detect || []).some((pattern) => uniCanvasModelDetectMatches(name, pattern))) {
        this.applyInferenceModuleDefaults(module.key, { preserveModelSelection: true });
        return;
      }
    }
  }

  getModelBase() {
    return getUniCanvasModelModule(this.settings.generation_mode).base;
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

  syncInferenceControls(source = null) {
    const scaleInput = this.container.querySelector('[data-setting="inference_scale"]');
    const scale = Math.max(0.125, Number(this.settings.inference_scale) || 1);
    this.settings.inference_scale = scale;
    if (scaleInput && scaleInput !== source) scaleInput.value = this.formatSettingNumber(scale, 3);
  }

  getDenoiseControlSetting() {
    if (this.getModelBase() === "z_image") return "fun_controlnet_strength";
    if (this.getModelBase() === "anima") return "anima_lllite_strength";
    return "denoise";
  }

  syncDenoiseControls(source = null) {
    const key = this.getDenoiseControlSetting();
    const fallback = key === "fun_controlnet_strength" || key === "anima_lllite_strength" ? 1 : 0.65;
    const value = Math.max(0, Math.min(1, Number(this.settings[key] ?? fallback) || 0));
    this.settings[key] = value;
    const label = this.denoiseControl?.querySelector("[data-denoise-label]");
    if (label) label.textContent = key === "fun_controlnet_strength" || key === "anima_lllite_strength" ? "ControlNet strength" : "Denoise";
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
    if (this.previewCanvas) {
      if (this.previewCanvas.width !== nextWidth) this.previewCanvas.width = nextWidth;
      if (this.previewCanvas.height !== nextHeight) this.previewCanvas.height = nextHeight;
      this.previewCanvas.style.width = "100%";
      this.previewCanvas.style.height = "100%";
    }
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    if (!this.didInitialCenter && size.width > 0 && size.height > 0) {
      this.fitInitialView();
    }
    this.render();
    this.scheduleUILayoutLog("resize");
  }

  scheduleUILayoutLog(reason = "layout") {
    clearTimeout(this.layoutLogTimer);
    this.layoutLogTimer = setTimeout(() => {
      this.layoutLogTimer = null;
      this.logUILayout(reason);
    }, 120);
  }

  logUILayout(reason = "layout") {
    if (!this.container || !this.stageWrap) return;
    const containerRect = this.container.getBoundingClientRect();
    const stageRect = this.stageWrap.getBoundingClientRect();
    const nodeWidth = Number(this.node?.size?.[0]) || 0;
    const nodeHeight = Number(this.node?.size?.[1]) || 0;
    const round = (value) => Math.round((Number(value) || 0) * 100) / 100;
    const pct = (value, base) => base ? round((value / base) * 100) : 0;
    const localRect = (el, parentRect = containerRect) => {
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        x: round(rect.left - parentRect.left),
        y: round(rect.top - parentRect.top),
        width: round(rect.width),
        height: round(rect.height),
        right: round(rect.right - parentRect.left),
        bottom: round(rect.bottom - parentRect.top),
        widthPctOfContainer: pct(rect.width, containerRect.width),
        heightPctOfContainer: pct(rect.height, containerRect.height),
        widthPctOfStage: pct(rect.width, stageRect.width),
        heightPctOfStage: pct(rect.height, stageRect.height),
      };
    };
    const toolButtons = Array.from(this.tools?.querySelectorAll(".vnccs-uc-tool") || []);
    const payload = {
      reason,
      nodeSize: { width: round(nodeWidth), height: round(nodeHeight) },
      containerClient: { width: this.container.clientWidth, height: this.container.clientHeight },
      containerRect: {
        x: round(containerRect.left),
        y: round(containerRect.top),
        width: round(containerRect.width),
        height: round(containerRect.height),
      },
      graphScaleFromNodeToScreen: {
        x: nodeWidth ? round(containerRect.width / nodeWidth) : 0,
        y: nodeHeight ? round(containerRect.height / nodeHeight) : 0,
      },
      cssUiScale: this.container.style.getPropertyValue("--vnccs-uc-ui-scale") || "unset",
      parts: {
        left: localRect(this.left),
        stage: localRect(this.stageWrap),
        right: localRect(this.side),
        topBar: localRect(this.bottom),
        toolbarInContainer: localRect(this.tools),
        toolbarInStage: localRect(this.tools, stageRect),
        firstTool: localRect(toolButtons[0], stageRect),
        lastTool: localRect(toolButtons[toolButtons.length - 1], stageRect),
      },
      counts: {
        toolButtons: toolButtons.length,
      },
    };
    console.groupCollapsed("VNCCS UniCanvas layout");
    console.log(payload);
    console.table(payload.parts);
    console.groupEnd();
  }

  openCustomSelect(select) {
    if (this.customSelectMenu && this.customSelectSource === select) {
      this.closeCustomSelect();
      return;
    }
    this.closeCustomSelect();
    const options = Array.from(select.options || []);
    if (!options.length) return;
    const rect = select.getBoundingClientRect();
    const selectFontSize = Number.parseFloat(getComputedStyle(select).fontSize) || 14;
    const menu = document.createElement("div");
    menu.className = "vnccs-uc-select-menu";
    const viewportGap = 8;
    const longestOptionChars = options.reduce((max, option) => Math.max(max, (option.textContent || option.value || "").length), 0);
    const desiredWidth = Math.max(rect.width, Math.min(520, 64 + longestOptionChars * Math.max(7, selectFontSize * 0.62)));
    const menuWidth = Math.min(desiredWidth, window.innerWidth - viewportGap * 2);
    const menuLeft = Math.min(Math.max(viewportGap, rect.left), window.innerWidth - viewportGap - menuWidth);
    menu.style.left = `${Math.round(menuLeft)}px`;
    menu.style.top = `${Math.round(rect.bottom + 4)}px`;
    menu.style.width = `${Math.round(menuWidth)}px`;
    menu.style.fontSize = `${Math.round(selectFontSize * 100) / 100}px`;
    const availableBelow = window.innerHeight - rect.bottom - viewportGap;
    const availableAbove = rect.top - viewportGap;
    const maxHeight = Math.max(140, Math.min(520, Math.max(availableBelow, availableAbove)));
    menu.style.maxHeight = `${Math.round(maxHeight)}px`;
    if (availableBelow < 180 && availableAbove > availableBelow) {
      menu.style.top = "";
      menu.style.bottom = `${Math.round(window.innerHeight - rect.top + 4)}px`;
    }
    for (const option of options) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "vnccs-uc-select-menu-option";
      if (option.value === select.value) row.classList.add("active");
      row.dataset.value = option.value;
      row.innerHTML = `<span class="vnccs-uc-select-menu-check">${option.value === select.value ? "✓" : ""}</span><span class="vnccs-uc-select-menu-label"></span>`;
      row.querySelector(".vnccs-uc-select-menu-label").textContent = option.textContent || option.value;
      row.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      row.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.chooseCustomSelectValue(select, option.value);
      });
      menu.appendChild(row);
    }
    menu.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    document.body.appendChild(menu);
    this.customSelectMenu = menu;
    this.customSelectSource = select;
    const active = menu.querySelector(".vnccs-uc-select-menu-option.active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  chooseCustomSelectValue(select, value) {
    if (!(select instanceof HTMLSelectElement)) return;
    if (select.value !== value) {
      select.value = value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    this.closeCustomSelect();
  }

  closeCustomSelect() {
    if (this.customSelectMenu) this.customSelectMenu.remove();
    this.customSelectMenu = null;
    this.customSelectSource = null;
  }

  requestRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    window.requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  clearToolPreviewOverlay() {
    if (!this.previewCanvas) return;
    const ctx = this.previewCanvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.previewCanvas.width / dpr, this.previewCanvas.height / dpr);
  }

  updateToolPreviewOverlay() {
    if (!this.previewCanvas) return;
    const ctx = this.previewCanvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = this.previewCanvas.width / dpr;
    const h = this.previewCanvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (this.tool === "sam" || this.sam.maskCanvas) {
      ctx.save();
      ctx.translate(this.view.x, this.view.y);
      ctx.scale(this.view.scale, this.view.scale);
      this.drawSamPreview(ctx);
      ctx.restore();
    }
    if (!this.hoverPoint || this.hoverPointerType !== "mouse" || !["brush", "eraser", "mask"].includes(this.tool)) return;
    ctx.save();
    ctx.translate(this.view.x, this.view.y);
    ctx.scale(this.view.scale, this.view.scale);
    this.drawToolPreview(ctx);
    ctx.restore();
  }

  drawSamPreview(ctx) {
    if (this.sam.maskCanvas && this.sam.crop) {
      const maskCanvas = this.getSamMaskCanvasForCurrentMode();
      ctx.save();
      ctx.globalAlpha = 0.72;
      ctx.drawImage(maskCanvas, this.origin.x + this.sam.crop.x, this.origin.y + this.sam.crop.y, this.sam.crop.width, this.sam.crop.height);
      ctx.globalCompositeOperation = "source-in";
      ctx.fillStyle = MASK_OVERLAY_COLOR;
      ctx.fillRect(this.origin.x + this.sam.crop.x, this.origin.y + this.sam.crop.y, this.sam.crop.width, this.sam.crop.height);
      ctx.restore();
    }
    const radius = Math.max(4, 7 / Math.max(this.view.scale, 0.001));
    for (const point of this.sam.points) {
      ctx.save();
      ctx.fillStyle = point.label > 0 ? "rgba(0,214,143,.95)" : "rgba(255,71,87,.95)";
      ctx.strokeStyle = "rgba(8,8,12,.95)";
      ctx.lineWidth = Math.max(1.5, 2 / Math.max(this.view.scale, 0.001));
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  getSamMaskCanvasForCurrentMode() {
    if (!this.sam.maskCanvas || !this.sam.invert) return this.sam.maskCanvas;
    if (!this._samInvertScratch) this._samInvertScratch = document.createElement("canvas");
    const scratch = this._samInvertScratch;
    if (scratch.width !== this.sam.maskCanvas.width) scratch.width = this.sam.maskCanvas.width;
    if (scratch.height !== this.sam.maskCanvas.height) scratch.height = this.sam.maskCanvas.height;
    const ctx = scratch.getContext("2d");
    ctx.clearRect(0, 0, scratch.width, scratch.height);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, scratch.width, scratch.height);
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(this.sam.maskCanvas, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    return scratch;
  }

  updateHud() {
    if (!this.hud) return;
    const inferenceSize = this.getInferenceSize();
    const hudHTML = `<span class="vnccs-uc-chip">${this.tool}</span><span class="vnccs-uc-chip">${Math.round(this.view.scale * 100)}%</span><span class="vnccs-uc-chip">${this.bbox.width}×${this.bbox.height}</span><span class="vnccs-uc-chip">infer ${inferenceSize.width}×${inferenceSize.height}</span>`;
    if (hudHTML !== this.lastHudHTML) {
      this.lastHudHTML = hudHTML;
      this.hud.innerHTML = hudHTML;
    }
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
    const size = this.getStageViewportSize();
    if (!size.width || !size.height) return false;
    this.centerBbox(true);
    this.didInitialCenter = true;
    return true;
  }

  updateMainUIScale() {
    if (!this.container) return;
    const width = this.container.clientWidth || this.node?.size?.[0] || 1040;
    const height = this.container.clientHeight || this.node?.size?.[1] || 720;
    const scale = Math.max(0.35, Math.min(2.5, Math.min(width / UNICANVAS_LAYOUT_BASE_WIDTH, height / UNICANVAS_LAYOUT_BASE_HEIGHT)));
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
    this.updateContextCursor(this.hoverPoint);
    this.updateToolPreviewOverlay();
  }

  onPointerLeave(e) {
    if (this.isPointerDown) return;
    this.hoverPointerType = e.pointerType || "mouse";
    this.hoverPoint = null;
    this.updateContextCursor(null);
    this.clearToolPreviewOverlay();
  }

  onPointerDown(e) {
    if (![0, 1].includes(e.button) && !(this.tool === "sam" && e.button === 2)) return;
    e.preventDefault();
    e.stopPropagation();
    this.canvas.setPointerCapture?.(e.pointerId);
    this.isPointerDown = true;
    const screen = this.canvasPointFromEvent(e);
    const point = this.worldFromCanvasPoint(screen);
    this.hoverPointerType = e.pointerType || "mouse";
    this.hoverPoint = point;
    this.clearToolPreviewOverlay();
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
    if (this.transformDraft && !["pan", "zoom-drag", "resize"].includes(this.pointerMode)) {
      this.pointerMode = "idle";
      this.setStatus("Apply or cancel the active transform first", true);
      this.render();
      return;
    }
    if (this.pointerMode === "bbox") {
      if (this.isStagingActive()) {
        this.pointerMode = "idle";
        this.setStatus(this.drawInProgress ? "Wait for GENERATE to finish before moving bbox" : "Accept or discard the staged result before moving bbox", true);
        this.render();
        return;
      }
      const bboxHandle = this.hitBboxHandle(point);
      if (bboxHandle) {
        this.pointerMode = "bbox-resize";
        this.dragStart.bboxHandle = bboxHandle;
      } else if (this.isPointInBbox(point)) {
        this.pointerMode = "bbox-move";
      } else {
        this.pointerMode = "idle";
      }
    } else if (this.pointerMode === "rect") {
      if (this.activeLayer) {
        this.dragStart.layerId = this.activeLayer.id;
        this.dragStart.layerBefore = this.createLayerPixelSnapshot(this.activeLayer);
      }
      this.shapeComposite = e.ctrlKey || e.metaKey ? "destination-out" : "source-over";
      this.shapeDraft = this.getRectToolRect(point, point, e);
    } else if (this.pointerMode === "lasso") {
      const layer = this.getOrCreateMaskLayer();
      if (layer) {
        this.dragStart.layerId = layer.id;
        this.dragStart.layerBefore = this.createLayerPixelSnapshot(layer);
      }
      this.shapeComposite = e.ctrlKey || e.metaKey ? "destination-out" : "source-over";
      this.lassoPoints = [point];
    } else if (this.pointerMode === "move" && !e.altKey && this.activeLayer && !this.activeLayer.locked) {
      this.pointerMode = "layer-move";
      this.dragStart.layerId = this.activeLayer.id;
      this.dragStart.layerBefore = this.createLayerPixelSnapshot(this.activeLayer);
      this.dragStart.layerBounds = this.dragStart.layerBefore?.crop || null;
      this.dragStart.layerCanvas = this.dragStart.layerBounds ? this.cloneCanvasCrop(this.activeLayer.canvas, this.dragStart.layerBounds) : null;
      this.dragStart.hiresRect = this.activeLayer.hiresRect ? { ...this.activeLayer.hiresRect } : null;
      this.dragStart.layerOrigin = { ...this.origin };
    } else if (this.pointerMode === "resize") {
      const layer = this.activeLayer;
      const activeDraft = this.transformDraft?.layerId === layer?.id ? this.transformDraft : null;
      const bounds = activeDraft?.bounds || this.getLayerWorldBounds(layer);
      const handle = this.hitResizeHandle(point, bounds);
      if (!layer || layer.locked || !bounds || !handle) {
        this.pointerMode = "idle";
      } else {
        const source = activeDraft ? this.createTransformSourceFromDraft(activeDraft) : this.createTransformSource(layer);
        if (!source?.canvas || !source.bounds) {
          this.pointerMode = "idle";
          return;
        }
        this.dragStart.layerBefore = source.before;
        this.dragStart.layerId = layer.id;
        this.pointerMode = handle === "rotate" ? "layer-rotate" : (this.resizeTransformMode === "perspective" && this.isCornerResizeHandle(handle) ? "layer-perspective" : "layer-resize");
        this.dragStart.resizeHandle = handle;
        this.dragStart.resizeBounds = { ...source.bounds };
        this.dragStart.layerCanvas = source.canvas;
        this.dragStart.layerCanvasCrop = source.crop ? { ...source.crop } : null;
        this.dragStart.layerOrigin = { ...this.origin };
        this.dragStart.perspectiveQuad = source.quad || this.boundsToQuad(this.dragStart.resizeBounds);
        const center = this.rectCenter(this.dragStart.resizeBounds);
        this.dragStart.rotateCenter = center;
        this.dragStart.rotateStartAngle = Math.atan2(point.y - center.y, point.x - center.x);
        this.dragStart.rotateStartBounds = this.dragStart.resizeBounds;
        this.updateTransformDraft(point, e);
      }
    } else if (this.pointerMode === "sam") {
      this.addSamPoint(point, e);
      this.isPointerDown = false;
      this.pointerMode = null;
      this.dragStart = null;
      this.lastPoint = null;
      this.updateToolPreviewOverlay();
      this.renderSamPanel();
      return;
    }
    if (["brush", "eraser", "mask"].includes(this.pointerMode)) {
      if (!this.ensureVisibleWorldBounds(Math.max(128, this.brushSize * 2))) {
        this.pointerMode = "idle";
        this.isPointerDown = false;
        return;
      }
      const layer = this.pointerMode === "mask" ? this.getOrCreateMaskLayer() : this.activeLayer;
      if (layer) {
        this.dragStart.layerId = layer.id;
        this.dragStart.layerBefore = this.createLayerPixelSnapshot(layer);
      }
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
    this.updateContextCursor(point);
    if (!this.isPointerDown || !this.lastPoint) {
      this.updateToolPreviewOverlay();
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
      this.updateLayerMovePreview(point);
    } else if (this.pointerMode === "layer-resize") {
      this.updateTransformDraft(point, e);
    } else if (this.pointerMode === "layer-rotate") {
      this.updateTransformDraft(point, e);
    } else if (this.pointerMode === "layer-perspective") {
      this.updateTransformDraft(point, e);
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
    const finishedDragStart = this.dragStart;
    if (this.pointerMode === "rect" && this.shapeDraft) {
      this.commitRectShape();
    }
    if (this.pointerMode === "lasso" && this.lassoPoints.length > 2) {
      this.commitLassoShape();
    }
    if (this.pointerMode === "layer-move" && this.dragStart?.layerCanvas) {
      this.moveActiveLayerPixels(this.dragStart.previewDx || 0, this.dragStart.previewDy || 0, true);
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
    this.updateContextCursor(this.hoverPoint);
    this.updateToolPreviewOverlay();
    let committedLayerId = finishedDragStart?.layerId || null;
    if (["rect", "lasso", "brush", "eraser", "mask", "layer-move"].includes(finishedMode) && finishedDragStart?.layerBefore) {
      const changedLayerId = finishedDragStart.layerId || this.activeLayer?.id;
      const changedLayer = this.layers.find((layer) => layer.id === changedLayerId);
      if (changedLayer) {
        committedLayerId = changedLayer.id;
        this.pushHistoryEntry({
          kind: "layerPixels",
          layerId: changedLayerId,
          before: finishedDragStart.layerBefore,
          after: this.createLayerPixelSnapshot(changedLayer),
        });
      }
    }
    if (["brush", "eraser", "mask"].includes(finishedMode)) {
      this.scheduleDeferredCanvasCommit(committedLayerId);
    } else if (["rect", "lasso", "layer-move"].includes(finishedMode)) {
      this.refreshLayerRow(committedLayerId);
      this.syncLightStateToWidget();
      this.scheduleFullSync();
    } else if (["layer-resize", "layer-rotate", "layer-perspective"].includes(finishedMode)) {
      this.syncLightStateToWidget();
    } else if (["bbox-move", "bbox-resize"].includes(finishedMode)) {
      this.syncSettingsToWidget();
    } else {
      this.syncSettingsToWidget();
    }
  }

  scheduleDeferredCanvasCommit(layerId = null) {
    window.clearTimeout(this.deferredCanvasCommitTimer);
    this.deferredCanvasCommitTimer = window.setTimeout(() => {
      this.deferredCanvasCommitTimer = null;
      this.refreshLayerRow(layerId);
      this.syncLightStateToWidget();
      this.scheduleFullSync();
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

  cloneCanvasCrop(canvas, crop) {
    const copy = document.createElement("canvas");
    copy.width = Math.max(1, Math.round(crop?.width || 1));
    copy.height = Math.max(1, Math.round(crop?.height || 1));
    if (crop && crop.width > 0 && crop.height > 0) {
      this.configureImageContext(copy.getContext("2d")).drawImage(canvas, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    }
    return copy;
  }

  expandCanvasCrop(crop, canvas, padding = 0) {
    if (!crop || !canvas) return null;
    return this.clampCanvasBounds({
      x: crop.x - padding,
      y: crop.y - padding,
      width: crop.width + padding * 2,
      height: crop.height + padding * 2,
    }, canvas);
  }

  addSamPoint(point, event) {
    const layer = this.activeLayer;
    if (!layer || layer.type !== "raster") {
      this.setSamStatus("Select a raster layer", true);
      return;
    }
    if (layer.locked) {
      this.setSamStatus("Layer is locked", true);
      return;
    }
    const bounds = this.getLayerWorldBounds(layer);
    if (!bounds || point.x < bounds.x || point.y < bounds.y || point.x > bounds.x + bounds.width || point.y > bounds.y + bounds.height) {
      this.setSamStatus("Click inside selected layer", true);
      return;
    }
    const label = event.button === 2 || event.altKey || event.ctrlKey || event.metaKey || this.sam.mode === "subtract" ? 0 : 1;
    this.sam.points.push({ x: point.x, y: point.y, label });
    this.clearSamMask(false);
    this.sam.status = label > 0 ? "Foreground point" : "Background point";
    this.requestRender();
  }

  setSamStatus(text, isError = false) {
    this.sam.status = text;
    this.renderSamPanel();
    if (isError) this.updateGenerationProgress({ message: text, progress: 1, stage: "error" }, true);
  }

  clearSamMask(update = true) {
    this.sam.maskCanvas = null;
    this.sam.crop = null;
    this.sam.layerId = null;
    if (update) {
      this.renderSamPanel();
      this.updateToolPreviewOverlay();
    }
  }

  clearSamPrompt() {
    this.sam.points = [];
    this.clearSamMask(false);
    this.sam.status = "SAM cleared";
    this.renderSamPanel();
    this.requestRender();
    this.setStatus("SAM cleared");
  }

  async segmentSamMask() {
    const layer = this.activeLayer;
    if (!layer || layer.type !== "raster") {
      this.setSamStatus("Select a raster layer", true);
      return;
    }
    if (layer.locked) {
      this.setSamStatus("Layer is locked", true);
      return;
    }
    if (!this.sam.points.length) {
      this.setSamStatus("Add foreground point", true);
      return;
    }
    const alphaCrop = this.getLayerAlphaBounds(layer);
    const crop = this.expandCanvasCrop(alphaCrop, layer.canvas, 24);
    if (!crop) {
      this.setSamStatus("Layer is empty", true);
      return;
    }
    const points = this.sam.points
      .filter((point) => point.x >= this.origin.x + crop.x && point.y >= this.origin.y + crop.y && point.x <= this.origin.x + crop.x + crop.width && point.y <= this.origin.y + crop.y + crop.height)
      .map((point) => ({
        x: point.x - this.origin.x - crop.x,
        y: point.y - this.origin.y - crop.y,
        label: point.label > 0 ? 1 : 0,
      }));
    if (!points.length) {
      this.setSamStatus("SAM points are outside crop", true);
      return;
    }
    const source = this.cloneCanvasCrop(layer.canvas, crop);
    this.sam.busy = true;
    this.sam.status = "Segmenting...";
    this.renderSamPanel();
    this.setStatus("SAM segmenting...");
    try {
      const res = await fetch("/vnccs/unicanvas/segment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.sam.model,
          image: source.toDataURL("image/png"),
          points,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      const img = await this.loadImage(data.mask);
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = crop.width;
      maskCanvas.height = crop.height;
      this.configureImageContext(maskCanvas.getContext("2d")).drawImage(img, 0, 0, crop.width, crop.height);
      this.sam.maskCanvas = maskCanvas;
      this.sam.crop = { ...crop };
      this.sam.layerId = layer.id;
      this.sam.status = "Mask ready";
      this.setStatus("SAM mask ready");
    } catch (err) {
      this.sam.status = `SAM failed: ${err.message || err}`;
      this.setSamStatus(this.sam.status, true);
    } finally {
      this.sam.busy = false;
      this.renderSamPanel();
      this.requestRender();
    }
  }

  applySamMask() {
    const layer = this.layers.find((item) => item.id === this.sam.layerId) || this.activeLayer;
    if (!layer || layer.type !== "raster" || !this.sam.maskCanvas || !this.sam.crop) {
      this.setSamStatus("No SAM mask to apply", true);
      return;
    }
    if (layer.locked) {
      this.setSamStatus("Layer is locked", true);
      return;
    }
    const before = this.createLayerPixelSnapshot(layer);
    this.materializeRasterLayerForEditing(layer);
    const crop = this.clampCanvasBounds(this.sam.crop, layer.canvas);
    if (!crop) {
      this.setSamStatus("SAM crop is outside layer", true);
      return;
    }
    const ctx = layer.canvas.getContext("2d");
    const maskCanvas = this.getSamMaskCanvasForCurrentMode();
    ctx.save();
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(maskCanvas, 0, 0, maskCanvas.width, maskCanvas.height, crop.x, crop.y, crop.width, crop.height);
    ctx.restore();
    this.markLayerPixelsChanged(layer, crop, false);
    this.pushHistoryEntry({
      kind: "layerPixels",
      layerId: layer.id,
      before,
      after: this.createLayerPixelSnapshot(layer),
    });
    this.clearSamMask(false);
    this.sam.status = "Mask applied";
    this.renderSamPanel();
    this.refreshLayerRow(layer.id);
    this.requestRender();
    this.syncLightStateToWidget();
    this.scheduleFullSync();
    this.setStatus("SAM mask applied");
  }

  createTransformSource(layer) {
    if (!layer) return null;
    const before = this.createLayerPixelSnapshot(layer);
    if (layer.hiresCanvas && layer.hiresRect) {
      return {
        before,
        canvas: this.cloneCanvas(layer.hiresCanvas),
        bounds: { ...layer.hiresRect },
        crop: before?.crop ? { ...before.crop } : null,
      };
    }
    const crop = before?.crop;
    if (!crop || !before.canvas) return null;
    return {
      before,
      canvas: before.canvas,
      bounds: {
        x: this.origin.x + crop.x,
        y: this.origin.y + crop.y,
        width: crop.width,
        height: crop.height,
      },
      crop: { ...crop },
    };
  }

  createTransformSourceFromDraft(draft) {
    if (!draft?.sourceCanvas || !draft.bounds) return null;
    const bounds = {
      x: Math.floor(draft.bounds.x),
      y: Math.floor(draft.bounds.y),
      width: Math.max(1, Math.ceil(draft.bounds.width)),
      height: Math.max(1, Math.ceil(draft.bounds.height)),
    };
    const canvas = document.createElement("canvas");
    canvas.width = bounds.width;
    canvas.height = bounds.height;
    const ctx = this.configureImageContext(canvas.getContext("2d"), true);
    ctx.save();
    ctx.translate(-bounds.x, -bounds.y);
    this.drawTransformDraft(ctx, draft);
    ctx.restore();
    return {
      before: draft.before,
      canvas,
      bounds,
      crop: null,
    };
  }

  createLayerPixelSnapshot(layer) {
    if (!layer) return null;
    const crop = this.getLayerAlphaBounds(layer);
    return {
      id: layer.id,
      crop: crop ? { ...crop } : null,
      origin: { ...this.origin },
      size: { ...this.size },
      canvas: crop ? this.cloneCanvasCrop(layer.canvas, crop) : null,
      hiresCanvas: layer.hiresCanvas || null,
      hiresRect: layer.hiresRect ? { ...layer.hiresRect } : null,
    };
  }

  restoreLayerPixelSnapshot(layer, snapshot) {
    if (!layer || !snapshot) return;
    if (snapshot.origin && (snapshot.origin.x !== this.origin.x || snapshot.origin.y !== this.origin.y || snapshot.size?.width !== this.size.width || snapshot.size?.height !== this.size.height)) {
      this.ensureWorldBounds(snapshot.origin.x, snapshot.origin.y, 0);
      this.ensureWorldBounds(snapshot.origin.x + (snapshot.size?.width || 0), snapshot.origin.y + (snapshot.size?.height || 0), 0);
    }
    const ctx = layer.canvas.getContext("2d");
    ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    if (snapshot.crop && snapshot.canvas) {
      ctx.drawImage(snapshot.canvas, snapshot.crop.x + snapshot.origin.x - this.origin.x, snapshot.crop.y + snapshot.origin.y - this.origin.y);
    }
    layer.hiresCanvas = snapshot.hiresCanvas || null;
    layer.hiresRect = snapshot.hiresRect ? { ...snapshot.hiresRect } : null;
    this.invalidateLayerCaches(layer);
  }

  materializeRasterLayerForEditing(layer) {
    if (!layer || layer.type !== "raster" || !layer.hiresCanvas || !layer.hiresRect) return;
    const ctx = this.configureImageContext(layer.canvas.getContext("2d"), true);
    const rect = this.normalizeLayerWorldRect(layer.hiresRect);
    ctx.clearRect(rect.x - this.origin.x, rect.y - this.origin.y, rect.width, rect.height);
    ctx.drawImage(layer.hiresCanvas, rect.x - this.origin.x, rect.y - this.origin.y, rect.width, rect.height);
    layer.hiresCanvas = null;
    layer.hiresRect = null;
    this.sanitizeMaskLayer(layer);
    this.invalidateLayerRenderCaches(layer);
    layer._boundsCache = this.clampCanvasBounds({
      x: Math.round(rect.x - this.origin.x),
      y: Math.round(rect.y - this.origin.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }, layer.canvas);
  }

  normalizeLayerWorldRect(rect) {
    return {
      x: Math.round(Number(rect?.x) || 0),
      y: Math.round(Number(rect?.y) || 0),
      width: Math.max(1, Math.round(Number(rect?.width) || 1)),
      height: Math.max(1, Math.round(Number(rect?.height) || 1)),
    };
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

  createHistorySnapshot(clonePixels = true) {
    return {
      origin: { ...this.origin },
      size: { ...this.size },
      bbox: { ...this.bbox },
      tool: this.tool,
      brushSize: this.brushSize,
      opacity: this.opacity,
      fg: this.fg,
      resizeKeepAspect: this.resizeKeepAspect,
      resizeTransformMode: this.resizeTransformMode,
      snapToGrid: this.snapToGrid,
      settings: JSON.parse(JSON.stringify(this.settings)),
      activeLayerId: this.activeLayerId,
      layers: clonePixels ? this.layers.map((layer) => this.cloneHistoryLayer(layer)) : this.layers,
      stagingItems: clonePixels ? this.stagingItems.map((item) => this.cloneHistoryStagingItem(item)) : this.stagingItems,
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
    this.resizeTransformMode = snapshot.resizeTransformMode === "perspective" ? "perspective" : "scale";
    this.snapToGrid = typeof snapshot.snapToGrid === "boolean" ? snapshot.snapToGrid : this.snapToGrid;
    this.settings = JSON.parse(JSON.stringify(snapshot.settings || this.settings));
    this.layers = snapshot.layers || [];
    this.normalizeLayerOrder();
    for (const layer of this.layers) this.invalidateLayerCaches(layer);
    this.activeLayerId = snapshot.activeLayerId || this.layers[0]?.id || null;
    this.stagingItems = snapshot.stagingItems || [];
    for (const item of this.stagingItems) {
      item._maskedCanvas = null;
      item._maskedSource = null;
      item._maskedMask = null;
    }
    this.activeStagingIndex = Math.max(-1, Math.min(snapshot.activeStagingIndex ?? -1, this.stagingItems.length - 1));
    this.historyRestoring = false;
    this.setTool(this.tool, true);
    this.updateSnapButton();
    this.syncPromptControls();
    this.syncActiveLayerControls();
    this.renderLayerList();
    this.requestRender();
    this.syncLightStateToWidget();
    this.scheduleFullSync();
  }

  recordHistoryBefore() {
    if (this._isRestoring || this.historyRestoring) return;
    this.undoStack.push(this.createHistorySnapshot());
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.updateHistoryButtons();
  }

  pushHistoryEntry(entry) {
    if (this._isRestoring || this.historyRestoring || !entry) return;
    this.undoStack.push(entry);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.updateHistoryButtons();
  }

  undo() {
    if (!this.undoStack.length) return;
    if (this.transformDraft) {
      this.setStatus("Apply or cancel the active transform before undo", true);
      return;
    }
    const previous = this.undoStack.pop();
    if (previous?.kind) {
      this.applyHistoryEntry(previous, "undo");
      this.redoStack.push(previous);
      if (this.redoStack.length > HISTORY_LIMIT) this.redoStack.shift();
      this.updateHistoryButtons();
      this.setStatus("Undo");
      return;
    }
    this.redoStack.push(this.createHistorySnapshot(false));
    if (this.redoStack.length > HISTORY_LIMIT) this.redoStack.shift();
    this.restoreHistorySnapshot(previous);
    this.updateHistoryButtons();
    this.setStatus("Undo");
  }

  redo() {
    if (!this.redoStack.length) return;
    if (this.transformDraft) {
      this.setStatus("Apply or cancel the active transform before redo", true);
      return;
    }
    const next = this.redoStack.pop();
    if (next?.kind) {
      this.applyHistoryEntry(next, "redo");
      this.undoStack.push(next);
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.updateHistoryButtons();
      this.setStatus("Redo");
      return;
    }
    this.undoStack.push(this.createHistorySnapshot(false));
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.restoreHistorySnapshot(next);
    this.updateHistoryButtons();
    this.setStatus("Redo");
  }

  applyHistoryEntry(entry, direction) {
    if (!entry?.kind) return;
    this.cancelDeferredCanvasCommit();
    this.historyRestoring = true;
    if (entry.kind === "acceptStaging") {
      if (direction === "undo") {
        this.layers = this.layers.filter((layer) => layer.id !== entry.layer.id);
        this.stagingItems = entry.stagingItems || [];
        this.activeStagingIndex = entry.activeStagingIndex ?? (this.stagingItems.length ? this.stagingItems.length - 1 : -1);
        this.activeLayerId = entry.previousActiveLayerId || this.layers[0]?.id || null;
      } else {
        if (!this.layers.some((layer) => layer.id === entry.layer.id)) this.insertLayerByType(entry.layer);
        this.stagingItems = [];
        this.activeStagingIndex = -1;
        this.activeLayerId = entry.layer.id;
      }
      this.invalidateLayerCaches(entry.layer);
    }
    if (entry.kind === "addLayer") {
      if (direction === "undo") {
        this.layers = this.layers.filter((layer) => layer.id !== entry.layer.id);
        this.activeLayerId = entry.previousActiveLayerId || this.layers[0]?.id || null;
      } else {
        if (!this.layers.some((layer) => layer.id === entry.layer.id)) this.insertLayerByType(entry.layer);
        this.activeLayerId = entry.layer.id;
      }
      this.invalidateLayerCaches(entry.layer);
    }
    if (entry.kind === "layerPixels") {
      const layer = this.layers.find((item) => item.id === entry.layerId);
      this.restoreLayerPixelSnapshot(layer, direction === "undo" ? entry.before : entry.after);
      this.activeLayerId = layer?.id || this.activeLayerId;
    }
    this.historyRestoring = false;
    this.syncActiveLayerControls();
    this.renderLayerList();
    this.requestRender();
    this.syncLightStateToWidget();
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
    if (layer.hiresCanvas && layer.hiresRect) return this.normalizeLayerWorldRect(layer.hiresRect);
    const crop = this.getLayerAlphaBounds(layer);
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
    const rotateOffset = Math.max(32, 42 / this.view.scale);
    return [
      { handle: "nw", x, y },
      { handle: "n", x: midX, y },
      { handle: "ne", x: x + width, y },
      { handle: "e", x: x + width, y: midY },
      { handle: "se", x: x + width, y: y + height },
      { handle: "s", x: midX, y: y + height },
      { handle: "sw", x, y: y + height },
      { handle: "w", x, y: midY },
      { handle: "rotate", x: midX, y: y - rotateOffset },
    ];
  }

  isCornerResizeHandle(handle) {
    return ["nw", "ne", "se", "sw"].includes(handle);
  }

  rectCenter(rect) {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }

  boundsToQuad(bounds) {
    if (!bounds) return null;
    return {
      nw: { x: bounds.x, y: bounds.y },
      ne: { x: bounds.x + bounds.width, y: bounds.y },
      se: { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
      sw: { x: bounds.x, y: bounds.y + bounds.height },
    };
  }

  cloneQuad(quad) {
    if (!quad) return null;
    return {
      nw: { ...quad.nw },
      ne: { ...quad.ne },
      se: { ...quad.se },
      sw: { ...quad.sw },
    };
  }

  hitResizeHandle(point, bounds) {
    if (!bounds) return null;
    const threshold = Math.max(10, 12 / this.view.scale);
    let best = null;
    let bestDistance = Infinity;
    for (const item of this.getResizeHandlePoints(bounds)) {
      const distance = Math.hypot(point.x - item.x, point.y - item.y);
      const itemThreshold = item.handle === "rotate" ? Math.max(threshold, 18 / this.view.scale) : threshold;
      if (distance <= itemThreshold && distance < bestDistance) {
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
    if (!this.ensureWorldBounds(bounds.x, bounds.y, 256, false)) return;
    if (!this.ensureWorldBounds(bounds.x + bounds.width, bounds.y + bounds.height, 256, false)) return;
    const sourceOrigin = start.layerOrigin || this.origin;
    const source = start.resizeBounds;
    const ctx = this.configureImageContext(layer.canvas.getContext("2d"), true);
    ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    ctx.drawImage(
      start.layerCanvas,
      0,
      0,
      start.layerCanvas.width,
      start.layerCanvas.height,
      bounds.x - this.origin.x,
      bounds.y - this.origin.y,
      bounds.width,
      bounds.height
    );
    layer.hiresCanvas = null;
    layer.hiresRect = null;
    this.invalidateLayerRenderCaches(layer);
    layer._boundsCache = this.clampCanvasBounds({
      x: Math.round(bounds.x - this.origin.x),
      y: Math.round(bounds.y - this.origin.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    }, layer.canvas);
  }

  updateTransformDraft(point, event = null) {
    const start = this.dragStart;
    if (!start?.layerCanvas || !start.resizeBounds || !start.layerId) return;
    const base = {
      layerId: start.layerId,
      before: start.layerBefore,
      sourceCanvas: start.layerCanvas,
      sourceBounds: { ...start.resizeBounds },
      opacity: this.layers.find((layer) => layer.id === start.layerId)?.opacity ?? 1,
    };
    if (this.pointerMode === "layer-rotate") {
      const center = start.rotateCenter || this.rectCenter(start.resizeBounds);
      const angle = Math.atan2(point.y - center.y, point.x - center.x) - (start.rotateStartAngle || 0);
      const bounds = this.boundsFromPoints(this.boundsToPoints(start.rotateStartBounds || start.resizeBounds).map((p) => this.rotatePoint(p, center, angle)));
      this.transformDraft = { ...base, kind: "rotate", center, angle, bounds };
      return;
    }
    if (this.pointerMode === "layer-perspective" && this.isCornerResizeHandle(start.resizeHandle)) {
      const quad = {
        nw: { ...start.perspectiveQuad.nw },
        ne: { ...start.perspectiveQuad.ne },
        se: { ...start.perspectiveQuad.se },
        sw: { ...start.perspectiveQuad.sw },
      };
      quad[start.resizeHandle] = { x: Math.round(point.x), y: Math.round(point.y) };
      this.transformDraft = { ...base, kind: "perspective", quad, bounds: this.boundsFromPoints(Object.values(quad)) };
      return;
    }
    this.transformDraft = { ...base, kind: "scale", bounds: this.getResizedBounds(point, event) };
  }

  getLayerTransformDraft(layer) {
    return layer && this.transformDraft?.layerId === layer.id ? this.transformDraft : null;
  }

  drawTransformDraft(ctx, draft) {
    if (!draft?.sourceCanvas || !draft.bounds) return;
    ctx.save();
    this.configureImageContext(ctx, true);
    if (draft.kind === "rotate") {
      const center = draft.center || this.rectCenter(draft.sourceBounds);
      ctx.translate(center.x, center.y);
      ctx.rotate(draft.angle || 0);
      ctx.drawImage(draft.sourceCanvas, draft.sourceBounds.x - center.x, draft.sourceBounds.y - center.y, draft.sourceBounds.width, draft.sourceBounds.height);
    } else if (draft.kind === "perspective" && draft.quad) {
      this.drawWarpedCanvas(ctx, draft.sourceCanvas, draft.quad, 8);
    } else {
      ctx.drawImage(draft.sourceCanvas, draft.bounds.x, draft.bounds.y, draft.bounds.width, draft.bounds.height);
    }
    ctx.restore();
  }

  cancelTransformDraft() {
    if (!this.transformDraft) return;
    this.transformDraft = null;
    this.setStatus("Transform canceled");
    this.requestRender();
  }

  applyTransformDraft() {
    const draft = this.transformDraft;
    if (!draft?.sourceCanvas || !draft.bounds) return;
    const layer = this.layers.find((item) => item.id === draft.layerId);
    if (!layer || layer.locked) {
      this.cancelTransformDraft();
      return;
    }
    const bounds = draft.bounds;
    if (!this.ensureWorldBounds(bounds.x, bounds.y, 256, false)) return;
    if (!this.ensureWorldBounds(bounds.x + bounds.width, bounds.y + bounds.height, 256, false)) return;
    const ctx = this.configureImageContext(layer.canvas.getContext("2d"), true);
    ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    if (draft.kind === "rotate") {
      const center = draft.center || this.rectCenter(draft.sourceBounds);
      ctx.save();
      ctx.translate(center.x - this.origin.x, center.y - this.origin.y);
      ctx.rotate(draft.angle || 0);
      ctx.drawImage(draft.sourceCanvas, draft.sourceBounds.x - center.x, draft.sourceBounds.y - center.y, draft.sourceBounds.width, draft.sourceBounds.height);
      ctx.restore();
    } else if (draft.kind === "perspective" && draft.quad) {
      const layerQuad = {};
      for (const key of ["nw", "ne", "se", "sw"]) {
        layerQuad[key] = { x: draft.quad[key].x - this.origin.x, y: draft.quad[key].y - this.origin.y };
      }
      this.drawWarpedCanvas(ctx, draft.sourceCanvas, layerQuad, 18);
    } else {
      ctx.drawImage(draft.sourceCanvas, bounds.x - this.origin.x, bounds.y - this.origin.y, bounds.width, bounds.height);
    }
    layer.hiresCanvas = null;
    layer.hiresRect = null;
    this.invalidateLayerRenderCaches(layer);
    layer._boundsCache = this.clampCanvasBounds({
      x: Math.floor(bounds.x - this.origin.x),
      y: Math.floor(bounds.y - this.origin.y),
      width: Math.ceil(bounds.width),
      height: Math.ceil(bounds.height),
    }, layer.canvas);
    this.transformDraft = null;
    this.activeLayerId = layer.id;
    this.pushHistoryEntry({
      kind: "layerPixels",
      layerId: layer.id,
      before: draft.before,
      after: this.createLayerPixelSnapshot(layer),
    });
    this.refreshLayerRow(layer.id);
    this.syncLightStateToWidget();
    this.scheduleFullSync();
    this.requestRender();
  }

  rotateActiveLayerTo(point) {
    const layer = this.activeLayer;
    const start = this.dragStart;
    if (!layer || !start?.layerCanvas || !start.rotateCenter || !start.rotateStartBounds) return;
    const center = start.rotateCenter;
    const angle = Math.atan2(point.y - center.y, point.x - center.x) - start.rotateStartAngle;
    const bounds = this.boundsFromPoints(this.boundsToPoints(start.rotateStartBounds).map((p) => this.rotatePoint(p, center, angle)));
    if (!this.ensureWorldBounds(bounds.x, bounds.y, 256, false)) return;
    if (!this.ensureWorldBounds(bounds.x + bounds.width, bounds.y + bounds.height, 256, false)) return;
    const ctx = this.configureImageContext(layer.canvas.getContext("2d"), true);
    ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    ctx.save();
    ctx.translate(center.x - this.origin.x, center.y - this.origin.y);
    ctx.rotate(angle);
    ctx.drawImage(start.layerCanvas, start.rotateStartBounds.x - center.x, start.rotateStartBounds.y - center.y, start.rotateStartBounds.width, start.rotateStartBounds.height);
    ctx.restore();
    layer.hiresCanvas = null;
    layer.hiresRect = null;
    this.invalidateLayerRenderCaches(layer);
    layer._boundsCache = this.clampCanvasBounds({
      x: Math.floor(bounds.x - this.origin.x),
      y: Math.floor(bounds.y - this.origin.y),
      width: Math.ceil(bounds.width),
      height: Math.ceil(bounds.height),
    }, layer.canvas);
  }

  boundsToPoints(bounds) {
    return [
      { x: bounds.x, y: bounds.y },
      { x: bounds.x + bounds.width, y: bounds.y },
      { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
      { x: bounds.x, y: bounds.y + bounds.height },
    ];
  }

  rotatePoint(point, center, angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
  }

  boundsFromPoints(points) {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }

  perspectiveActiveLayerTo(point) {
    const layer = this.activeLayer;
    const start = this.dragStart;
    const handle = start?.resizeHandle;
    if (!layer || !start?.layerCanvas || !start.perspectiveQuad || !this.isCornerResizeHandle(handle)) return;
    const quad = {
      nw: { ...start.perspectiveQuad.nw },
      ne: { ...start.perspectiveQuad.ne },
      se: { ...start.perspectiveQuad.se },
      sw: { ...start.perspectiveQuad.sw },
    };
    quad[handle] = { x: Math.round(point.x), y: Math.round(point.y) };
    const bounds = this.boundsFromPoints(Object.values(quad));
    if (!this.ensureWorldBounds(bounds.x, bounds.y, 256, false)) return;
    if (!this.ensureWorldBounds(bounds.x + bounds.width, bounds.y + bounds.height, 256, false)) return;
    const ctx = this.configureImageContext(layer.canvas.getContext("2d"), true);
    ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    const layerQuad = {};
    for (const key of ["nw", "ne", "se", "sw"]) {
      layerQuad[key] = { x: quad[key].x - this.origin.x, y: quad[key].y - this.origin.y };
    }
    this.drawWarpedCanvas(ctx, start.layerCanvas, layerQuad, 18);
    layer.hiresCanvas = null;
    layer.hiresRect = null;
    this.invalidateLayerRenderCaches(layer);
    layer._boundsCache = this.clampCanvasBounds({
      x: Math.floor(bounds.x - this.origin.x),
      y: Math.floor(bounds.y - this.origin.y),
      width: Math.ceil(bounds.width),
      height: Math.ceil(bounds.height),
    }, layer.canvas);
  }

  drawWarpedCanvas(ctx, sourceCanvas, quad, segments = 16) {
    const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const bilerp = (u, v) => lerp(lerp(quad.nw, quad.ne, u), lerp(quad.sw, quad.se, u), v);
    for (let y = 0; y < segments; y += 1) {
      const v0 = y / segments;
      const v1 = (y + 1) / segments;
      for (let x = 0; x < segments; x += 1) {
        const u0 = x / segments;
        const u1 = (x + 1) / segments;
        const p00 = bilerp(u0, v0);
        const p10 = bilerp(u1, v0);
        const p11 = bilerp(u1, v1);
        const p01 = bilerp(u0, v1);
        const s00 = { x: u0 * sourceCanvas.width, y: v0 * sourceCanvas.height };
        const s10 = { x: u1 * sourceCanvas.width, y: v0 * sourceCanvas.height };
        const s11 = { x: u1 * sourceCanvas.width, y: v1 * sourceCanvas.height };
        const s01 = { x: u0 * sourceCanvas.width, y: v1 * sourceCanvas.height };
        this.drawWarpedTriangle(ctx, sourceCanvas, s00, s10, s11, p00, p10, p11);
        this.drawWarpedTriangle(ctx, sourceCanvas, s00, s11, s01, p00, p11, p01);
      }
    }
  }

  drawWarpedTriangle(ctx, sourceCanvas, s0, s1, s2, d0, d1, d2) {
    const denom = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
    if (Math.abs(denom) < 1e-6) return;
    const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / denom;
    const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / denom;
    const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / denom;
    const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / denom;
    const e = (d0.x * (s1.x * s2.y - s2.x * s1.y) + d1.x * (s2.x * s0.y - s0.x * s2.y) + d2.x * (s0.x * s1.y - s1.x * s0.y)) / denom;
    const f = (d0.y * (s1.x * s2.y - s2.x * s1.y) + d1.y * (s2.x * s0.y - s0.x * s2.y) + d2.y * (s0.x * s1.y - s1.x * s0.y)) / denom;
    const centroid = { x: (d0.x + d1.x + d2.x) / 3, y: (d0.y + d1.y + d2.y) / 3 };
    const expand = (p) => {
      const dx = p.x - centroid.x;
      const dy = p.y - centroid.y;
      const len = Math.hypot(dx, dy) || 1;
      const pad = 0.35;
      return { x: p.x + (dx / len) * pad, y: p.y + (dy / len) * pad };
    };
    const c0 = expand(d0);
    const c1 = expand(d1);
    const c2 = expand(d2);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(c0.x, c0.y);
    ctx.lineTo(c1.x, c1.y);
    ctx.lineTo(c2.x, c2.y);
    ctx.closePath();
    ctx.clip();
    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(sourceCanvas, 0, 0);
    ctx.restore();
  }

  toggleSnapToGrid() {
    this.snapToGrid = !this.snapToGrid;
    this.updateSnapButton();
    this.syncLightStateToWidget();
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
    return this.commitActiveLayerMove(dx, dy, true);
  }

  updateLayerMovePreview(point) {
    const layer = this.activeLayer;
    const start = this.dragStart;
    if (!layer || !start) return;
    let dx = point.x - start.point.x;
    let dy = point.y - start.point.y;
    const crop = start.layerBounds;
    const sourceOrigin = start.layerOrigin || this.origin;
    if (this.canSnapMovedLayer(layer, crop)) {
      ({ dx, dy } = this.snapMovedLayerDelta(dx, dy, crop, sourceOrigin));
    }
    start.previewDx = dx;
    start.previewDy = dy;
  }

  getLayerMovePreview(layer) {
    if (this.pointerMode !== "layer-move" || !this.dragStart || layer?.id !== this.dragStart.layerId) return null;
    return {
      dx: this.dragStart.previewDx || 0,
      dy: this.dragStart.previewDy || 0,
    };
  }

  commitActiveLayerMove(dx, dy, allowExpand = true) {
    const layer = this.activeLayer;
    if (!layer || !this.dragStart?.layerCanvas) return;
    const sourceOrigin = this.dragStart.layerOrigin || this.origin;
    const crop = this.dragStart.layerBounds;
    if (this.canSnapMovedLayer(layer, crop)) {
      ({ dx, dy } = this.snapMovedLayerDelta(dx, dy, crop, sourceOrigin));
    }
    if (crop) {
      if (!this.ensureWorldBounds(sourceOrigin.x + crop.x + dx, sourceOrigin.y + crop.y + dy, 256, allowExpand)) return;
      if (!this.ensureWorldBounds(sourceOrigin.x + crop.x + crop.width + dx, sourceOrigin.y + crop.y + crop.height + dy, 256, allowExpand)) return;
    }
    const ctx = this.configureImageContext(layer.canvas.getContext("2d"));
    ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    const cropX = crop?.x || 0;
    const cropY = crop?.y || 0;
    ctx.drawImage(
      this.dragStart.layerCanvas,
      Math.round(sourceOrigin.x + cropX - this.origin.x + dx),
      Math.round(sourceOrigin.y + cropY - this.origin.y + dy)
    );
    if (layer.hiresRect && this.dragStart.hiresRect) {
      layer.hiresRect = {
        ...this.dragStart.hiresRect,
        x: this.dragStart.hiresRect.x + dx,
        y: this.dragStart.hiresRect.y + dy,
      };
    }
    this.invalidateLayerRenderCaches(layer);
    layer._boundsCache = crop ? this.clampCanvasBounds({
      x: Math.round(sourceOrigin.x + cropX - this.origin.x + dx),
      y: Math.round(sourceOrigin.y + cropY - this.origin.y + dy),
      width: Math.round(crop.width),
      height: Math.round(crop.height),
    }, layer.canvas) : null;
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

  ensureWorldBounds(x, y, padding = 256, allowExpand = true) {
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
    if (!allowExpand) return false;
    const newW = Math.ceil(right - left);
    const newH = Math.ceil(bottom - top);
    const nextCanvases = [];
    try {
      for (const layer of this.layers) {
        const next = document.createElement("canvas");
        next.width = newW;
        next.height = newH;
        const nextCtx = this.configureImageContext(next.getContext("2d"));
        if (!nextCtx || next.width !== newW || next.height !== newH) throw new Error("browser refused canvas allocation");
        nextCtx.drawImage(layer.canvas, this.origin.x - left, this.origin.y - top);
        nextCanvases.push({ layer, canvas: next });
      }
    } catch (err) {
      console.warn("[VNCCS UniCanvas] Browser refused canvas backing expansion", { width: newW, height: newH, err });
      this.setStatus(`Browser refused canvas expansion (${newW}×${newH})`, true);
      return false;
    }
    for (const { layer, canvas } of nextCanvases) {
      layer.canvas = canvas;
      this.invalidateLayerCaches(layer);
    }
    this.origin = { x: left, y: top };
    this.size = { width: newW, height: newH };
    return true;
  }

  ensureWorldRectBounds(rect, padding = 256, allowExpand = true) {
    if (!rect) return false;
    if (!this.ensureWorldBounds(rect.x, rect.y, padding, allowExpand)) return false;
    if (!this.ensureWorldBounds(rect.x + rect.width, rect.y + rect.height, padding, allowExpand)) return false;
    return true;
  }

  ensureVisibleWorldBounds(padding = 256) {
    return this.ensureWorldRectBounds(this.visibleWorldRect(), padding, true);
  }

  drawStroke(a, b) {
    const layer = this.tool === "mask" ? this.getOrCreateMaskLayer() : this.activeLayer;
    if (!layer || layer.locked) return;
    if (!this.ensureVisibleWorldBounds(Math.max(128, this.brushSize * 2))) return;
    const start = this.alignCoordForTool(a, this.brushSize);
    const end = this.alignCoordForTool(b, this.brushSize);
    if (!this.ensureStrokeWorldBounds(start, end, this.brushSize)) return;
    this.materializeRasterLayerForEditing(layer);
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

  ensureStrokeWorldBounds(start, end, width) {
    const pad = width / 2 + 4;
    const left = Math.min(start.x, end.x) - pad;
    const top = Math.min(start.y, end.y) - pad;
    const right = Math.max(start.x, end.x) + pad;
    const bottom = Math.max(start.y, end.y) + pad;
    if (!this.ensureWorldBounds(left, top, Math.max(128, width * 2), true)) return false;
    if (!this.ensureWorldBounds(right, bottom, Math.max(128, width * 2), true)) return false;
    return true;
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
        const transformDraft = this.getLayerTransformDraft(layer);
        if (transformDraft) {
          ctx.globalAlpha = 1;
          this.drawMaskTransformDraft(ctx, transformDraft);
        } else {
          this.drawMaskLayer(ctx, layer);
        }
      } else {
        ctx.globalAlpha = layer.opacity;
        ctx.globalCompositeOperation = layer.blendMode || "source-over";
        const transformDraft = this.getLayerTransformDraft(layer);
        const movePreview = transformDraft ? null : this.getLayerMovePreview(layer);
        const visibleWorldRect = this._visibleWorldRectForRender;
        if (movePreview) {
          ctx.translate(movePreview.dx, movePreview.dy);
          this._visibleWorldRectForRender = {
            ...visibleWorldRect,
            x: visibleWorldRect.x - movePreview.dx,
            y: visibleWorldRect.y - movePreview.dy,
          };
        }
        if (transformDraft) this.drawTransformDraft(ctx, transformDraft);
        else this.drawRasterLayerVisible(ctx, layer);
        if (movePreview) this._visibleWorldRectForRender = visibleWorldRect;
      }
      ctx.restore();
    }
    this._visibleWorldRectForRender = null;
    this.drawStagingOverlay(ctx);
    this.drawShapeDraft(ctx);
    this.drawLassoDraft(ctx);
    this.drawResizeOverlay(ctx);
    this.drawBbox(ctx);
    ctx.restore();
    const inferenceSize = this.getInferenceSize();
    const hudHTML = `<span class="vnccs-uc-chip">${this.tool}</span><span class="vnccs-uc-chip">${Math.round(this.view.scale * 100)}%</span><span class="vnccs-uc-chip">${this.bbox.width}×${this.bbox.height}</span><span class="vnccs-uc-chip">infer ${inferenceSize.width}×${inferenceSize.height}</span>`;
    if (hudHTML !== this.lastHudHTML) {
      this.lastHudHTML = hudHTML;
      this.hud.innerHTML = hudHTML;
    }
    this.updateStagingControls();
    this.updateTransformControls();
    this.updateSamControls();
    this.updateToolPreviewOverlay();
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
    const crop = this.getVisibleLayerCrop(layer.canvas, this.getLayerRenderBounds(layer));
    if (!crop) return;
    const lod = this.shouldUseLayerLod(layer) ? this.getRenderLodCanvas(layer, layer.canvas, "_renderLodCache") : null;
    const source = lod?.canvas || layer.canvas;
    const scaleX = lod?.scaleX || lod?.scale || 1;
    const scaleY = lod?.scaleY || lod?.scale || 1;
    const tintWidth = Math.max(1, Math.round(crop.sw * scaleX));
    const tintHeight = Math.max(1, Math.round(crop.sh * scaleY));
    const tint = this.getMaskTintScratch(tintWidth, tintHeight);
    const tintCtx = tint.getContext("2d");
    tintCtx.clearRect(0, 0, tint.width, tint.height);
    tintCtx.globalCompositeOperation = "source-over";
    tintCtx.drawImage(source, crop.sx * scaleX, crop.sy * scaleY, crop.sw * scaleX, crop.sh * scaleY, 0, 0, tintWidth, tintHeight);
    tintCtx.globalCompositeOperation = "source-in";
    tintCtx.fillStyle = MASK_OVERLAY_COLOR;
    tintCtx.fillRect(0, 0, tintWidth, tintHeight);
    tintCtx.globalCompositeOperation = "source-over";
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(tint, 0, 0, tintWidth, tintHeight, crop.dx, crop.dy, crop.sw, crop.sh);
    ctx.restore();
  }

  drawMaskTransformDraft(ctx, draft) {
    if (!draft?.bounds) return;
    const bounds = {
      x: Math.floor(draft.bounds.x),
      y: Math.floor(draft.bounds.y),
      width: Math.max(1, Math.ceil(draft.bounds.width)),
      height: Math.max(1, Math.ceil(draft.bounds.height)),
    };
    if (!this._maskDraftScratch) this._maskDraftScratch = document.createElement("canvas");
    const scratch = this._maskDraftScratch;
    if (scratch.width !== bounds.width) scratch.width = bounds.width;
    if (scratch.height !== bounds.height) scratch.height = bounds.height;
    const scratchCtx = scratch.getContext("2d");
    scratchCtx.clearRect(0, 0, scratch.width, scratch.height);
    scratchCtx.save();
    scratchCtx.translate(-bounds.x, -bounds.y);
    this.drawTransformDraft(scratchCtx, draft);
    scratchCtx.restore();

    const tint = this.getMaskTintScratch(bounds.width, bounds.height);
    const tintCtx = tint.getContext("2d");
    tintCtx.clearRect(0, 0, tint.width, tint.height);
    tintCtx.drawImage(scratch, 0, 0);
    tintCtx.globalCompositeOperation = "source-in";
    tintCtx.fillStyle = MASK_OVERLAY_COLOR;
    tintCtx.fillRect(0, 0, tint.width, tint.height);
    tintCtx.globalCompositeOperation = "source-over";
    ctx.drawImage(tint, bounds.x, bounds.y, bounds.width, bounds.height);
  }

  getMaskTintScratch(width, height) {
    if (!this._maskTintScratch) this._maskTintScratch = document.createElement("canvas");
    if (this._maskTintScratch.width !== width) this._maskTintScratch.width = width;
    if (this._maskTintScratch.height !== height) this._maskTintScratch.height = height;
    return this._maskTintScratch;
  }

  drawLayerCanvasVisible(ctx, canvas, contentBounds = null) {
    const crop = this.getVisibleLayerCrop(canvas, contentBounds);
    if (!crop) return;
    ctx.drawImage(canvas, crop.sx, crop.sy, crop.sw, crop.sh, crop.dx, crop.dy, crop.sw, crop.sh);
  }

  drawLayerCanvasVisibleWithLod(ctx, layer, canvas, contentBounds = null, cacheKey = "_renderLodCache") {
    const crop = this.getVisibleLayerCrop(canvas, contentBounds);
    if (!crop) return;
    const lod = this.getRenderLodCanvas(layer, canvas, cacheKey);
    if (!lod) {
      ctx.drawImage(canvas, crop.sx, crop.sy, crop.sw, crop.sh, crop.dx, crop.dy, crop.sw, crop.sh);
      return;
    }
    const scaleX = lod.scaleX || lod.scale || 1;
    const scaleY = lod.scaleY || lod.scale || 1;
    ctx.drawImage(
      lod.canvas,
      crop.sx * scaleX,
      crop.sy * scaleY,
      crop.sw * scaleX,
      crop.sh * scaleY,
      crop.dx,
      crop.dy,
      crop.sw,
      crop.sh
    );
  }

  drawRasterLayerVisible(ctx, layer) {
    if (layer.hiresCanvas && layer.hiresRect) {
      const visible = this.visibleWorldRect();
      this.drawRasterLayerToWorldRect(ctx, layer, visible, visible, false, this.shouldUseLayerLod(layer));
      return;
    }
    if (this.shouldUseLayerLod(layer)) this.drawLayerCanvasVisibleWithLod(ctx, layer, layer.canvas, this.getLayerRenderBounds(layer));
    else this.drawLayerCanvasVisible(ctx, layer.canvas, this.getLayerRenderBounds(layer));
  }

  shouldUseLayerLod(layer) {
    return Boolean(layer && layer.id !== this.activeLayerId && !this.getLayerMovePreview(layer) && !this.getLayerTransformDraft(layer));
  }

  drawRasterLayerToWorldRect(ctx, layer, worldRect, destRect, smoothing = true, useLod = false) {
    if (layer.hiresCanvas && layer.hiresRect) {
      const rect = this.normalizeLayerWorldRect(layer.hiresRect);
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
      const lod = useLod ? this.getRenderLodCanvas(layer, layer.hiresCanvas, "_hiresRenderLodCache") : null;
      ctx.save();
      this.configureImageContext(ctx, smoothing);
      if (lod) {
        const scaleX = lod.scaleX || lod.scale || 1;
        const scaleY = lod.scaleY || lod.scale || 1;
        ctx.drawImage(lod.canvas, sx * scaleX, sy * scaleY, sw * scaleX, sh * scaleY, dx, dy, dw, dh);
      } else {
        ctx.drawImage(layer.hiresCanvas, sx, sy, sw, sh, dx, dy, dw, dh);
      }
      ctx.restore();
      return;
    }
    const lod = useLod ? this.getRenderLodCanvas(layer, layer.canvas, "_renderLodCache") : null;
    const sx = worldRect.x - this.origin.x;
    const sy = worldRect.y - this.origin.y;
    const source = lod?.canvas || layer.canvas;
    const scaleX = lod?.scaleX || lod?.scale || 1;
    const scaleY = lod?.scaleY || lod?.scale || 1;
    ctx.drawImage(source, sx * scaleX, sy * scaleY, worldRect.width * scaleX, worldRect.height * scaleY, destRect.x, destRect.y, destRect.width, destRect.height);
  }

  getRenderLodCanvas(layer, sourceCanvas, cacheKey = "_renderLodCache") {
    const scale = this.getRenderLodScale(sourceCanvas);
    if (scale >= 1) return null;
    const cache = layer[cacheKey];
    if (cache?.source === sourceCanvas && cache.scale === scale && cache.width === sourceCanvas.width && cache.height === sourceCanvas.height) {
      return cache;
    }
    this.queueRenderLodBuild(layer, sourceCanvas, cacheKey, scale);
    return null;
  }

  queueRenderLodBuild(layer, sourceCanvas, cacheKey, scale) {
    if (!layer || !sourceCanvas || !scale || scale >= 1) return;
    if (this.lodRenderQueue.some((item) => item.layer === layer && item.sourceCanvas === sourceCanvas && item.cacheKey === cacheKey && item.scale === scale)) return;
    this.lodRenderQueue.push({ layer, sourceCanvas, cacheKey, scale, width: sourceCanvas.width, height: sourceCanvas.height });
    if (this.lodRenderQueued) return;
    this.lodRenderQueued = true;
    const run = () => this.flushRenderLodQueue();
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run, { timeout: 800 });
    else window.setTimeout(run, 0);
  }

  flushRenderLodQueue() {
    const started = performance.now();
    while (this.lodRenderQueue.length && performance.now() - started < 10) {
      const item = this.lodRenderQueue.shift();
      if (!item || !this.layers.includes(item.layer) || item.sourceCanvas.width !== item.width || item.sourceCanvas.height !== item.height) continue;
      const cache = item.layer[item.cacheKey];
      if (cache?.source === item.sourceCanvas && cache.scale === item.scale && cache.width === item.width && cache.height === item.height) continue;
      this.buildRenderLodCanvas(item.layer, item.sourceCanvas, item.cacheKey, item.scale);
    }
    if (this.lodRenderQueue.length) {
      const run = () => this.flushRenderLodQueue();
      if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run, { timeout: 800 });
      else window.setTimeout(run, 0);
      return;
    }
    this.lodRenderQueued = false;
  }

  buildRenderLodCanvas(layer, sourceCanvas, cacheKey, scale) {
    const lod = document.createElement("canvas");
    lod.width = Math.max(1, Math.round(sourceCanvas.width * scale));
    lod.height = Math.max(1, Math.round(sourceCanvas.height * scale));
    const lodCtx = this.configureImageContext(lod.getContext("2d"), true);
    lodCtx.clearRect(0, 0, lod.width, lod.height);
    lodCtx.drawImage(sourceCanvas, 0, 0, lod.width, lod.height);
    layer[cacheKey] = {
      source: sourceCanvas,
      scale,
      scaleX: lod.width / sourceCanvas.width,
      scaleY: lod.height / sourceCanvas.height,
      width: sourceCanvas.width,
      height: sourceCanvas.height,
      canvas: lod,
    };
    return layer[cacheKey];
  }

  getRenderLodScale(canvas) {
    if (!canvas || Math.max(canvas.width, canvas.height) < RENDER_LOD_MIN_CANVAS_SIDE) return 1;
    const dpr = window.devicePixelRatio || 1;
    const targetScale = Math.min(1, this.view.scale * dpr * RENDER_LOD_OVERSAMPLE);
    for (const scale of RENDER_LOD_LEVELS) {
      if (targetScale >= scale) return scale;
    }
    return RENDER_LOD_LEVELS[RENDER_LOD_LEVELS.length - 1];
  }

  getLayerRenderBounds(layer) {
    if (!layer) return null;
    if (layer._boundsCache !== undefined) return layer._boundsCache;
    if (layer.hiresCanvas && layer.hiresRect) {
      const rect = this.normalizeLayerWorldRect(layer.hiresRect);
      return this.clampCanvasBounds({
        x: rect.x - this.origin.x,
        y: rect.y - this.origin.y,
        width: rect.width,
        height: rect.height,
      }, layer.canvas);
    }
    return { x: 0, y: 0, width: layer.canvas.width, height: layer.canvas.height };
  }

  getVisibleLayerCrop(canvas, contentBounds = null) {
    const visible = this._visibleWorldRectForRender || this.visibleWorldRect();
    let sx = Math.max(0, Math.floor(visible.x - this.origin.x));
    let sy = Math.max(0, Math.floor(visible.y - this.origin.y));
    let ex = Math.min(canvas.width, Math.ceil(visible.x + visible.width - this.origin.x));
    let ey = Math.min(canvas.height, Math.ceil(visible.y + visible.height - this.origin.y));
    if (contentBounds) {
      sx = Math.max(sx, Math.floor(contentBounds.x));
      sy = Math.max(sy, Math.floor(contentBounds.y));
      ex = Math.min(ex, Math.ceil(contentBounds.x + contentBounds.width));
      ey = Math.min(ey, Math.ceil(contentBounds.y + contentBounds.height));
    }
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
    const placement = this.normalizeLayerWorldRect(this.getStagingImageRect());
    const sourceWidth = Math.max(1, staging.img.naturalWidth || staging.img.width || placement.width);
    const sourceHeight = Math.max(1, staging.img.naturalHeight || staging.img.height || placement.height);
    const preview = this.makeMaskedStagingCanvas(staging, staging.img, sourceWidth, sourceHeight);
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.drawImage(preview, placement.x, placement.y, placement.width, placement.height);
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

  updateTransformControls() {
    if (!this.transformControls) return;
    if (!this.transformDraft) {
      this.transformControls.classList.remove("visible");
      return;
    }
    const labels = { scale: "Resize", rotate: "Rotate", perspective: "Perspective" };
    this.transformControls.style.left = "50%";
    this.transformControls.style.right = "";
    this.transformControls.style.top = "";
    this.transformControls.style.bottom = "12px";
    this.transformControls.style.width = "";
    this.transformControls.style.transform = "translateX(-50%)";
    if (this.transformLabel) this.transformLabel.textContent = labels[this.transformDraft.kind] || "Transform";
    this.transformControls.classList.add("visible");
  }

  updateSamControls() {
    if (!this.samPanel) return;
    if (this.tool !== "sam" || this.activeStaging || this.transformDraft) {
      this.samPanel.classList.remove("visible");
      return;
    }
    this.samPanel.style.left = "50%";
    this.samPanel.style.right = "";
    this.samPanel.style.top = "";
    this.samPanel.style.bottom = "12px";
    this.samPanel.style.width = "";
    this.samPanel.style.transform = "translateX(-50%)";
    this.renderSamPanel();
    this.samPanel.classList.add("visible");
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
    if (this.tool !== "resize" && !["layer-resize", "layer-rotate", "layer-perspective"].includes(this.pointerMode)) return;
    const draft = this.getLayerTransformDraft(this.activeLayer);
    const bounds = draft?.bounds || this.getLayerWorldBounds();
    if (!bounds) return;
    ctx.save();
    ctx.strokeStyle = "rgba(212,216,234,.95)";
    ctx.lineWidth = 1.2 / this.view.scale;
    ctx.setLineDash([6 / this.view.scale, 4 / this.view.scale]);
    if (draft?.kind === "perspective" && draft.quad) {
      ctx.beginPath();
      ctx.moveTo(draft.quad.nw.x, draft.quad.nw.y);
      ctx.lineTo(draft.quad.ne.x, draft.quad.ne.y);
      ctx.lineTo(draft.quad.se.x, draft.quad.se.y);
      ctx.lineTo(draft.quad.sw.x, draft.quad.sw.y);
      ctx.closePath();
      ctx.stroke();
    } else {
      ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
    }
    ctx.setLineDash([]);
    const size = 12 / this.view.scale;
    for (const point of this.getResizeHandlePoints(bounds)) {
      if (point.handle === "rotate") {
        ctx.beginPath();
        ctx.moveTo(bounds.x + bounds.width / 2, bounds.y);
        ctx.lineTo(point.x, point.y);
        ctx.strokeStyle = "rgba(255,212,92,.72)";
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(point.x, point.y, size * 0.55, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,212,92,.20)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255,212,92,.95)";
        ctx.stroke();
      } else {
        this.roundRectPath(ctx, point.x - size / 2, point.y - size / 2, size, size, 3 / this.view.scale);
        ctx.fillStyle = this.resizeTransformMode === "perspective" && this.isCornerResizeHandle(point.handle) ? "rgba(255,212,92,.22)" : "rgba(20,16,30,.92)";
        ctx.fill();
        ctx.strokeStyle = this.resizeTransformMode === "perspective" && this.isCornerResizeHandle(point.handle) ? "rgba(255,212,92,.95)" : "rgba(255,143,163,.95)";
        ctx.stroke();
      }
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
    this.thumbnailRenderQueue = [];
    this.normalizeLayerOrder();
    if (!this.maskLayerList || !this.rasterLayerList) {
      this.layerList.innerHTML = "";
      this.maskLayerList = document.createElement("div");
      this.maskLayerList.className = "vnccs-uc-layer-group";
      this.rasterLayerList = document.createElement("div");
      this.rasterLayerList.className = "vnccs-uc-layer-group";
      this.layerList.append(this.maskLayerList, this.rasterLayerList);
    }
    this.maskLayerList.innerHTML = "";
    this.rasterLayerList.innerHTML = "";
    const masks = this.layers.filter((layer) => layer.type === "mask");
    const rasters = this.layers.filter((layer) => layer.type !== "mask");
    this.maskLayerList.append(this.createLayerGroupHead("Masks", masks.length, "mask"));
    for (const layer of masks) this.maskLayerList.append(this.createLayerRow(layer));
    if (!masks.length) this.maskLayerList.append(this.createLayerGroupEmpty("No masks"));
    this.rasterLayerList.append(this.createLayerGroupHead("Raster Layers", rasters.length, "raster"));
    for (const layer of rasters) this.rasterLayerList.append(this.createLayerRow(layer));
    if (!rasters.length) this.rasterLayerList.append(this.createLayerGroupEmpty("No raster layers"));
    this.attachLayerGroupDrop(this.maskLayerList, "mask");
    this.attachLayerGroupDrop(this.rasterLayerList, "raster");
    this.syncActiveLayerControls();
  }

  createLayerGroupHead(label, count, type) {
    const head = document.createElement("div");
    head.className = `vnccs-uc-layer-group-head ${type === "mask" ? "mask" : ""}`;
    head.innerHTML = `<span>${this._escape(label)}</span><span>${count}</span>`;
    return head;
  }

  createLayerGroupEmpty(label) {
    const empty = document.createElement("div");
    empty.className = "vnccs-uc-layer-group-empty";
    empty.textContent = label;
    return empty;
  }

  attachLayerGroupDrop(group, type) {
    group.ondragover = (e) => {
      const source = this.layers.find((layer) => layer.id === (this.dragLayerId || e.dataTransfer.getData("text/plain")));
      if (!source || source.type !== type) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    };
    group.ondrop = (e) => {
      const sourceId = this.dragLayerId || e.dataTransfer.getData("text/plain");
      const source = this.layers.find((layer) => layer.id === sourceId);
      if (!source || source.type !== type) return;
      if (e.target !== group && e.target.closest?.(".vnccs-uc-layer")) return;
      e.preventDefault();
      const sameTypeLayers = this.layers.filter((layer) => layer.type === type);
      this.reorderLayer(sourceId, sameTypeLayers[sameTypeLayers.length - 1]?.id, "after");
    };
  }

  createLayerRow(layer) {
    const row = document.createElement("div");
    row.className = `vnccs-uc-layer ${layer.id === this.activeLayerId ? "active" : ""} ${layer.locked ? "locked" : ""}`;
    row.draggable = true;
    row.dataset.layerId = layer.id;
    row.dataset.layerType = layer.type;
    const thumb = document.createElement("canvas");
    thumb.className = "vnccs-uc-thumb";
    thumb.title = layer.visible ? "Hide layer" : "Show layer";
    thumb.width = 68;
    thumb.height = 68;
    this.drawLayerThumbnailPlaceholder(thumb, layer);
    this.queueLayerThumbnailRender(thumb, layer);
    const label = document.createElement("div");
    label.innerHTML = `<div class="vnccs-uc-layer-name">${this._escape(layer.name)}</div><div class="vnccs-uc-layer-type">${layer.type}${layer.visible ? "" : " hidden"}</div>`;
    const lock = this._button(layer.locked ? UI_ICONS.lock : UI_ICONS.unlock, "vnccs-uc-icon", null, layer.locked ? "Unlock layer" : "Lock layer");
    const del = this._button(UI_ICONS.trash, "vnccs-uc-icon danger", null, "Delete layer");
    row.append(thumb, label, lock, del);
    row.addEventListener("click", () => this.setActiveLayer(layer.id));
    row.addEventListener("dragstart", (e) => {
      this.activeLayerId = layer.id;
      this.dragLayerId = layer.id;
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", layer.id);
    });
    row.addEventListener("dragend", () => {
      this.dragLayerId = null;
      row.classList.remove("dragging", "drop-before", "drop-after");
      this.clearLayerDropMarkers();
    });
    row.addEventListener("dragover", (e) => {
      const source = this.layers.find((item) => item.id === (this.dragLayerId || e.dataTransfer.getData("text/plain")));
      if (!source || source.type !== layer.type) {
        e.dataTransfer.dropEffect = "none";
        return;
      }
      e.preventDefault();
      const placement = this.getLayerDropPlacement(row, e.clientY);
      this.markLayerDropTarget(row, placement);
      e.dataTransfer.dropEffect = "move";
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      const sourceId = this.dragLayerId || e.dataTransfer.getData("text/plain");
      const placement = this.getLayerDropPlacement(row, e.clientY);
      this.reorderLayer(sourceId, layer.id, placement);
    });
    label.addEventListener("dblclick", async (e) => {
      e.stopPropagation();
      const next = await this.promptInWidget("Rename Layer", "Layer name", layer.name);
      if (next !== null) {
        layer.name = String(next).trim() || layer.name;
        this.updateLayerRow(row, layer);
        this.syncLightStateToWidget();
      }
    });
    thumb.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.transformDraft) {
        this.setStatus("Apply or cancel the active transform first", true);
        return;
      }
      layer.visible = !layer.visible;
      this.updateLayerRow(row, layer);
      this.requestRender();
      this.syncLightStateToWidget();
    });
    thumb.addEventListener("dblclick", (e) => e.stopPropagation());
    lock.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.transformDraft) {
        this.setStatus("Apply or cancel the active transform first", true);
        return;
      }
      layer.locked = !layer.locked;
      this.updateLayerRow(row, layer);
      this.syncLightStateToWidget();
    });
    lock.addEventListener("dblclick", (e) => e.stopPropagation());
    del.addEventListener("click", (e) => { e.stopPropagation(); this.deleteLayer(layer.id); });
    del.addEventListener("dblclick", (e) => e.stopPropagation());
    return row;
  }

  updateLayerRow(row, layer) {
    if (!row || !layer) return;
    row.classList.toggle("active", layer.id === this.activeLayerId);
    row.classList.toggle("locked", !!layer.locked);
    const thumb = row.querySelector(".vnccs-uc-thumb");
    if (thumb instanceof HTMLCanvasElement) {
      thumb.title = layer.visible ? "Hide layer" : "Show layer";
      this.drawLayerThumbnailPlaceholder(thumb, layer);
      this.queueLayerThumbnailRender(thumb, layer);
    }
    const name = row.querySelector(".vnccs-uc-layer-name");
    if (name) name.textContent = layer.name;
    const type = row.querySelector(".vnccs-uc-layer-type");
    if (type) type.textContent = `${layer.type}${layer.visible ? "" : " hidden"}`;
    const buttons = row.querySelectorAll(".vnccs-uc-icon");
    const lock = buttons[0];
    if (lock) {
      lock.innerHTML = layer.locked ? UI_ICONS.lock : UI_ICONS.unlock;
      lock.title = layer.locked ? "Unlock layer" : "Lock layer";
      lock.classList.toggle("locked", !!layer.locked);
    }
  }

  refreshLayerRow(layerId) {
    if (!layerId) return;
    const layer = this.layers.find((item) => item.id === layerId);
    const row = this.layerList.querySelector(`[data-layer-id="${layerId}"]`);
    if (layer && row) this.updateLayerRow(row, layer);
  }

  drawLayerThumbnailPlaceholder(canvas, layer) {
    const ctx = canvas.getContext("2d");
    const size = canvas.width;
    ctx.clearRect(0, 0, size, size);
    this.drawCheckerboard(ctx, size, 5);
    ctx.fillStyle = layer.type === "mask" ? "rgba(255,143,163,.28)" : "rgba(255,255,255,.12)";
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.16, 0, Math.PI * 2);
    ctx.fill();
    if (!layer.visible) this.drawHiddenSlash(ctx, size);
  }

  queueLayerThumbnailRender(canvas, layer) {
    this.thumbnailRenderQueue.push({ canvas, layer, layerId: layer.id });
    if (this.thumbnailRenderQueued) return;
    this.thumbnailRenderQueued = true;
    this.scheduleLayerThumbnailFlush();
  }

  scheduleLayerThumbnailFlush() {
    const run = () => this.flushLayerThumbnailQueue();
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run, { timeout: 1000 });
    else window.setTimeout(run, 0);
  }

  flushLayerThumbnailQueue() {
    const started = performance.now();
    while (this.thumbnailRenderQueue.length && performance.now() - started < 6) {
      const item = this.thumbnailRenderQueue.shift();
      if (!item?.canvas?.isConnected || !this.layers.includes(item.layer) || item.layer.id !== item.layerId) continue;
      this.drawLayerThumbnail(item.canvas, item.layer);
    }
    if (this.thumbnailRenderQueue.length) {
      this.scheduleLayerThumbnailFlush();
      return;
    }
    this.thumbnailRenderQueued = false;
  }

  setActiveLayer(layerId) {
    if (!layerId || this.activeLayerId === layerId) return;
    if (this.transformDraft && this.transformDraft.layerId !== layerId) {
      this.setStatus("Apply or cancel the active transform first", true);
      return;
    }
    this.activeLayerId = layerId;
    this.updateLayerListActiveState();
    this.syncActiveLayerControls();
    this.requestRender();
  }

  updateLayerListActiveState() {
    this.layerList.querySelectorAll(".vnccs-uc-layer").forEach((row) => {
      row.classList.toggle("active", row.dataset.layerId === this.activeLayerId);
      const layer = this.layers.find((item) => item.id === row.dataset.layerId);
      row.classList.toggle("locked", !!layer?.locked);
    });
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
    if (this.transformDraft) {
      this.setStatus("Apply or cancel the active transform first", true);
      return;
    }
    const from = this.layers.findIndex((l) => l.id === sourceId);
    const target = this.layers.findIndex((l) => l.id === targetId);
    if (from < 0 || target < 0) return;
    if (this.layers[from].type !== this.layers[target].type) {
      this.setStatus("Masks and raster layers stay in separate sections", true);
      return;
    }
    const [layer] = this.layers.splice(from, 1);
    let to = this.layers.findIndex((l) => l.id === targetId);
    if (placement === "after") to += 1;
    this.layers.splice(Math.max(0, Math.min(this.layers.length, to)), 0, layer);
    this.activeLayerId = layer.id;
    this.renderLayerList();
    this.requestRender();
    this.syncLightStateToWidget();
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
    if (this.transformDraft) {
      this.setStatus("Apply or cancel the active transform first", true);
      return;
    }
    this.layers = this.layers.filter((l) => l.id !== id);
    if (this.activeLayerId === id) this.activeLayerId = this.layers[0]?.id || null;
    this.renderLayerList();
    this.requestRender();
    this.syncLightStateToWidget();
    this.scheduleFullSync();
  }

  duplicateActiveLayer() {
    if (this.transformDraft) {
      this.setStatus("Apply or cancel the active transform first", true);
      return;
    }
    const layer = this.activeLayer;
    if (!layer) return;
    const previousActiveLayerId = this.activeLayerId;
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
    this.pushHistoryEntry({ kind: "addLayer", layer: copy, previousActiveLayerId });
    this.renderLayerList();
    this.requestRender();
    this.syncLightStateToWidget();
    this.scheduleFullSync();
  }

  moveActiveLayer(direction) {
    if (this.transformDraft) {
      this.setStatus("Apply or cancel the active transform first", true);
      return;
    }
    const index = this.layers.findIndex((l) => l.id === this.activeLayerId);
    if (index < 0) return;
    const layer = this.layers[index];
    const sameType = this.layers
      .map((item, itemIndex) => ({ item, itemIndex }))
      .filter((entry) => entry.item.type === layer.type);
    const localIndex = sameType.findIndex((entry) => entry.itemIndex === index);
    const nextLocalIndex = Math.max(0, Math.min(sameType.length - 1, localIndex + direction));
    const nextIndex = sameType[nextLocalIndex]?.itemIndex ?? index;
    if (nextIndex === index) return;
    const [moved] = this.layers.splice(index, 1);
    this.layers.splice(nextIndex, 0, moved);
    this.renderLayerList();
    this.requestRender();
    this.syncLightStateToWidget();
  }

  async confirmFlattenLayers() {
    if (this.transformDraft) {
      this.setStatus("Apply or cancel the active transform first", true);
      return;
    }
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
    this.requestRender();
    this.syncLightStateToWidget();
    this.scheduleFullSync();
    this.setStatus("Layers flattened to Master Layer");
  }

  async importFile(file) {
    if (!file) return;
    if (this.transformDraft) {
      this.setStatus("Apply or cancel the active transform first", true);
      return;
    }
    const img = await this.loadImage(URL.createObjectURL(file));
    if (!this.ensureWorldBounds(this.bbox.x + img.width, this.bbox.y + img.height, 128)) return;
    if (!this.ensureWorldBounds(this.bbox.x, this.bbox.y, 128)) return;
    const layer = this.addLayer("raster", file.name.replace(/\.[^.]+$/, ""), true, true);
    const ctx = this.configureImageContext(layer.canvas.getContext("2d"));
    ctx.drawImage(img, this.bbox.x - this.origin.x, this.bbox.y - this.origin.y);
    this.invalidateLayerCaches(layer);
    this.requestRender();
    this.syncLightStateToWidget();
    this.scheduleFullSync();
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
    let safeLeft = STAGE_FIT_PADDING_PX;
    const safeRight = STAGE_FIT_PADDING_PX;
    const safeTop = STAGE_FIT_PADDING_PX;
    const safeBottom = STAGE_FIT_PADDING_PX;
    const stageRect = this.stageWrap?.getBoundingClientRect?.();
    const toolsRect = this.tools?.getBoundingClientRect?.();
    if (stageRect?.width && toolsRect?.width) {
      const stageScaleX = size.width / stageRect.width;
      const toolsRight = (toolsRect.right - stageRect.left) * stageScaleX;
      safeLeft = Math.max(safeLeft, toolsRight + STAGE_FIT_PADDING_PX);
    }
    const safeWidth = Math.max(1, size.width - safeLeft - safeRight);
    const safeHeight = Math.max(1, size.height - safeTop - safeBottom);
    if (allowZoomOut) {
      const fitScale = Math.min(
        safeWidth / this.bbox.width,
        safeHeight / this.bbox.height,
        1
      );
      this.view.scale = this.constrainStageScale(fitScale);
      this.intendedScale = this.view.scale;
      this.activeSnapPoint = null;
    }
    this.view.x = safeLeft + safeWidth / 2 - (this.bbox.x + this.bbox.width / 2) * this.view.scale;
    this.view.y = safeTop + safeHeight / 2 - (this.bbox.y + this.bbox.height / 2) * this.view.scale;
  }

  makeExportCanvas(type, inferenceSize = this.getInferenceSize(), options = {}) {
    const out = document.createElement("canvas");
    out.width = Math.max(64, Math.round(inferenceSize.width));
    out.height = Math.max(64, Math.round(inferenceSize.height));
    const ctx = this.getReadbackContext(out);
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
    const ctx = this.getReadbackContext(canvas);
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
    const ctx = this.getReadbackContext(canvas);
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
    const ctx = this.getReadbackContext(canvas, false);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const { data, width, height } = imageData;
    const total = width * height;
    const visited = new Uint8Array(total);
    let preserveData = null;
    if (preserveCanvas) {
      const preserve = document.createElement("canvas");
      preserve.width = width;
      preserve.height = height;
      const preserveCtx = this.getReadbackContext(preserve);
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
    const ctx = this.getReadbackContext(out);
    for (const layer of [...this.layers].reverse()) {
      if (!layer.visible || layer.type !== "raster") continue;
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      this.drawRasterLayerToWorldRect(ctx, layer, this.bbox, { x: 0, y: 0, width: out.width, height: out.height });
      ctx.restore();
    }
    return out;
  }

  makeOutpaintMaskCanvas(userMaskCanvas, inferenceSize = this.getInferenceSize()) {
    const out = document.createElement("canvas");
    out.width = Math.max(64, Math.round(inferenceSize.width));
    out.height = Math.max(64, Math.round(inferenceSize.height));
    const ctx = this.getReadbackContext(out);
    if (userMaskCanvas) ctx.drawImage(userMaskCanvas, 0, 0, out.width, out.height);
    this.sanitizeMaskCanvas(out);

    const rasterAlpha = this.makeRasterAlphaCanvas(inferenceSize);
    const maskData = ctx.getImageData(0, 0, out.width, out.height);
    const rasterData = this.getReadbackContext(rasterAlpha, false).getImageData(0, 0, out.width, out.height).data;
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

    const overlap = Math.max(
      32,
      Math.round((Number(this.settings.mask_blur) || 0) * 2),
      Math.round((Number(this.settings.canvas_coherence_edge_size) || 0) * 2)
    );
    if (overlap > 0) {
      const transparent = new Uint8Array(out.width * out.height);
      for (let y = 0; y < out.height; y++) {
        for (let x = 0; x < out.width; x++) {
          const index = y * out.width + x;
          transparent[index] = rasterData[index * 4 + 3] <= 8 ? 1 : 0;
        }
      }
      for (let y = 0; y < out.height; y++) {
        let leftDistance = Infinity;
        for (let x = 0; x < out.width; x++) {
          const index = y * out.width + x;
          if (transparent[index]) leftDistance = 0;
          else if (leftDistance !== Infinity) leftDistance++;
          if (leftDistance > 0 && leftDistance <= overlap) {
            data[index * 4] = 255;
            data[index * 4 + 1] = 255;
            data[index * 4 + 2] = 255;
            data[index * 4 + 3] = 255;
          }
        }
        let rightDistance = Infinity;
        for (let x = out.width - 1; x >= 0; x--) {
          const index = y * out.width + x;
          if (transparent[index]) rightDistance = 0;
          else if (rightDistance !== Infinity) rightDistance++;
          if (rightDistance > 0 && rightDistance <= overlap) {
            data[index * 4] = 255;
            data[index * 4 + 1] = 255;
            data[index * 4 + 2] = 255;
            data[index * 4 + 3] = 255;
          }
        }
      }
      for (let x = 0; x < out.width; x++) {
        let topDistance = Infinity;
        for (let y = 0; y < out.height; y++) {
          const index = y * out.width + x;
          if (transparent[index]) topDistance = 0;
          else if (topDistance !== Infinity) topDistance++;
          if (topDistance > 0 && topDistance <= overlap) {
            data[index * 4] = 255;
            data[index * 4 + 1] = 255;
            data[index * 4 + 2] = 255;
            data[index * 4 + 3] = 255;
          }
        }
        let bottomDistance = Infinity;
        for (let y = out.height - 1; y >= 0; y--) {
          const index = y * out.width + x;
          if (transparent[index]) bottomDistance = 0;
          else if (bottomDistance !== Infinity) bottomDistance++;
          if (bottomDistance > 0 && bottomDistance <= overlap) {
            data[index * 4] = 255;
            data[index * 4 + 1] = 255;
            data[index * 4 + 2] = 255;
            data[index * 4 + 3] = 255;
          }
        }
      }
    }
    ctx.putImageData(maskData, 0, 0);
    return out;
  }

  getCanvasAlphaStats(canvas) {
    const data = this.getReadbackContext(canvas, false).getImageData(0, 0, canvas.width, canvas.height).data;
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
    this.flushSettingsToWidget();
    const { loader } = this.normalizeGenerationSettings();
    const validationError = loader.validate?.(this.settings);
    if (validationError) {
      this.setStatus(validationError, true);
      return;
    }
    if ((this.settings.seed_mode || "fixed") === "randomize") {
      this.settings.seed = this.generateRandomSeed();
      this.syncPromptControls();
      this.flushSettingsToWidget();
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
    console.debug("[VNCCS UniCanvas] GENERATE request", debug);
    this.setStatus(`Generating ${mode} ${inferenceSize.width}×${inferenceSize.height}...`);
    this.updateGenerationProgress({ progress: 0.01, message: "Starting generation", step: 0, steps: Number(this.settings.steps) || 0 }, true);
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
          settings: this.makeSettingsPayload(),
          debug,
        }),
      });
      const data = await res.json();
      console.debug("[VNCCS UniCanvas] GENERATE response", { debugId, data });
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      const url = this.imageResultToURL(data.image);
      const img = await this.loadImage(url);
      const hasResultMask = Boolean(data.mask);
      const stagingMode = hasResultMask ? mode : (mode === "inpaint" || mode === "outpaint" ? "img2img" : mode);
      const stagingMaskCanvas = hasResultMask && (mode === "inpaint" || mode === "outpaint") ? maskCanvas : null;
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
      this.addStagingItem({
        url,
        bbox: { ...requestBbox },
        displaySize: outputSize,
        inferenceSize,
        image: data.image,
        img,
        visible: true,
        mode: stagingMode,
        maskCanvas: acceptMaskCanvas,
        userMaskCanvas: stagingMaskCanvas,
        resultMaskCanvas,
      });
      this.render();
      this.setStatus(`GENERATE complete (${this.stagingItems.length} staged)`);
      this.updateGenerationProgress({ progress: 1, message: "Complete", step: Number(this.settings.steps) || 0, steps: Number(this.settings.steps) || 0 }, true);
    } catch (err) {
      this.setStatus(`GENERATE failed: ${err.message || err}`, true);
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
    const previousStagingItems = this.stagingItems;
    const previousActiveStagingIndex = this.activeStagingIndex;
    const previousActiveLayerId = this.activeLayerId;
    const img = staging.img || await this.loadImage(staging.url);
    const placement = this.normalizeLayerWorldRect(this.getStagingImageRect());
    if (!this.ensureWorldBounds(placement.x + placement.width, placement.y + placement.height, 128)) return;
    if (!this.ensureWorldBounds(placement.x, placement.y, 128)) return;
    const layer = this.addLayer("raster", null, false, true);
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
    this.pushHistoryEntry({
      kind: "acceptStaging",
      layer,
      stagingItems: previousStagingItems,
      activeStagingIndex: previousActiveStagingIndex,
      previousActiveLayerId,
    });
    this.requestRender();
    this.renderLayerList();
    this.syncLightStateToWidget();
    this.scheduleFullSync();
    this.setStatus("Staging accepted; remaining results discarded");
  }

  discardStaging() {
    this.removeActiveStagingItem();
    this.requestRender();
    this.setStatus(this.stagingItems.length ? `Staging discarded (${this.stagingItems.length} left)` : "Staging discarded");
  }

  toggleStagingVisibility() {
    const staging = this.activeStaging;
    if (!staging) return;
    staging.visible = staging.visible === false;
    this.requestRender();
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
    if (!this.drawInProgress) this.updateGenerationProgress({ message: text, progress: isError ? 1 : 0, stage: isError ? "error" : "status" }, isError);
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
    const { loader } = this.normalizeGenerationSettings();
    this.syncInferenceControls();
    this.container.querySelectorAll("[data-loader-field]").forEach((el) => {
      el.style.display = el.dataset.loaderField === loader.key ? "" : "none";
    });
    const modeSelect = this.container.querySelector('[data-setting="generation_mode"]');
    if (modeSelect) {
      modeSelect.disabled = Boolean(loader.forcedMode);
      modeSelect.title = loader.forcedMode ? "Checkpoint loader always uses SDXL" : "";
    }
    this.container.querySelectorAll("[data-setting]").forEach((el) => {
      const key = el.dataset.setting;
      if (!(key in this.settings)) return;
      if (el instanceof HTMLInputElement && NUMERIC_SETTINGS.has(key)) {
        el.value = this.formatSettingNumber(this.settings[key], key === "inference_scale" ? 3 : 2);
      } else if (el instanceof HTMLSelectElement) {
        if (key !== "scheduler") this.ensureSelectOption(el, this.settings[key]);
        if (key === "scheduler" && this.settings[key] && !Array.from(el.options).some((option) => option.value === String(this.settings[key]))) {
          this.settings[key] = Array.from(el.options).some((option) => option.value === "simple") ? "simple" : (el.options[0]?.value || "");
        }
        el.value = this.settings[key];
      } else {
        el.value = this.settings[key];
      }
    });
    this.syncInferenceControls();
    this.syncDenoiseControls();
    this.syncSeedModeControl();
    this.renderModelSelectionControls();
    this.renderLoraStackControls();
    this.autoResizePromptTextareas();
  }

  resizeTextareaToContent(textarea) {
    if (!(textarea instanceof HTMLTextAreaElement)) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.max(54, textarea.scrollHeight)}px`;
  }

  autoResizePromptTextareas() {
    this.container.querySelectorAll(".vnccs-uc-textarea").forEach((textarea) => this.resizeTextareaToContent(textarea));
  }

  syncSeedModeControl() {
    const btn = this.container.querySelector('[data-action="seed-mode"]');
    if (!btn) return;
    const randomMode = (this.settings.seed_mode || "fixed") === "randomize";
    btn.classList.toggle("active", randomMode);
    btn.title = randomMode ? "Random seed" : "Fixed seed";
    btn.setAttribute("aria-pressed", randomMode ? "true" : "false");
  }

  syncToNode() {
    if (this._isRestoring) return;
    clearTimeout(this.settingsSyncTimer);
    this.settingsSyncTimer = null;
    clearTimeout(this.fullSyncTimer);
    this.fullSyncTimer = null;
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

  syncSettingsToWidget() {
    if (this._isRestoring) return;
    clearTimeout(this.settingsSyncTimer);
    this.settingsSyncTimer = window.setTimeout(() => this.writeLightStateToWidget(), 250);
  }

  flushSettingsToWidget() {
    clearTimeout(this.settingsSyncTimer);
    this.settingsSyncTimer = null;
    this.writeLightStateToWidget();
  }

  syncLightStateToWidget() {
    if (this._isRestoring) return;
    clearTimeout(this.settingsSyncTimer);
    this.settingsSyncTimer = window.setTimeout(() => this.writeLightStateToWidget(), 80);
  }

  writeLightStateToWidget() {
    if (this._isRestoring) return;
    const widget = this.node.widgets?.find((w) => w.name === "unicanvas_state");
    if (!widget) return;
    let state = null;
    try {
      state = widget.value ? JSON.parse(widget.value) : null;
    } catch (_) {
      state = null;
    }
    if (!state || typeof state !== "object") {
      state = this.buildSerializedState(false);
    }
    state.version = 2;
    state.storage = "server_cache";
    state.state_id = this.getStateCacheId();
    state.origin = this.origin;
    state.size = this.size;
    state.bbox = this.bbox;
    state.snapToGrid = this.snapToGrid;
    state.resizeTransformMode = this.resizeTransformMode;
    this.normalizeLoraStack();
    state.settings = { ...this.settings };
    state.activeLayerId = this.activeLayerId;
    const previousById = new Map((Array.isArray(state.layers) ? state.layers : []).map((layer) => [layer?.id, layer]));
    state.layers = this.layers.map((layer) => {
      const previous = previousById.get(layer.id) || {};
      return {
        id: layer.id,
        name: layer.name,
        type: layer.type,
        visible: layer.visible,
        locked: layer.locked,
        opacity: layer.opacity,
        blendMode: layer.blendMode || "source-over",
        crop: previous.crop ?? null,
        dataURL: null,
        cached: previous.cached ?? true,
        hiresRect: layer.hiresRect ? { ...layer.hiresRect } : null,
        hiresDataURL: null,
      };
    });
    widget.value = JSON.stringify(state);
  }

  scheduleFullSync(delay = 900) {
    if (this._isRestoring) return;
    clearTimeout(this.fullSyncTimer);
    this.fullSyncTimer = window.setTimeout(() => {
      this.fullSyncTimer = null;
      const run = () => {
        if (this.isPointerDown || this.drawInProgress) {
          this.scheduleFullSync(delay);
          return;
        }
        this.syncToNode();
      };
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(run, { timeout: 2500 });
      } else {
        window.setTimeout(run, 0);
      }
    }, delay);
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
      snapToGrid: this.snapToGrid,
      resizeTransformMode: this.resizeTransformMode,
      settings: this.settings,
      layers: this.layers.map((l) => this.serializeLayer(l, includeLayerData)),
      activeLayerId: this.activeLayerId,
    };
  }

  readStateCacheIdFromWidget() {
    try {
      const widget = this.node.widgets?.find((w) => w.name === "unicanvas_state");
      const state = widget?.value && widget.value !== "{}" ? JSON.parse(widget.value) : null;
      return typeof state?.state_id === "string" && state.state_id ? state.state_id : null;
    } catch (_) {
      return null;
    }
  }

  createStateCacheId() {
    return `vnccs_unicanvas_${this.node?.id ?? "node"}_${uid()}`;
  }

  isLegacyStateCacheId(id) {
    return /^vnccs_unicanvas_[^_]+$/.test(String(id || ""));
  }

  getStateCacheId() {
    if (!this.stateCacheId) this.stateCacheId = this.readStateCacheIdFromWidget() || this.createStateCacheId();
    return this.stateCacheId;
  }

  getStateBackupKey() {
    if (!this.stateBackupKey) this.stateBackupKey = `vnccs_unicanvas_backup_${this.getStateCacheId()}`;
    return this.stateBackupKey;
  }

  getLegacyStateBackupKey() {
    return `vnccs_unicanvas_backup_${this.node?.id ?? "node"}`;
  }

  stateHasLayerPixels(state) {
    return Array.isArray(state?.layers) && state.layers.some((layer) => Boolean(layer?.dataURL || layer?.hiresDataURL));
  }

  saveLocalStateBackup(state) {
    if (this.localStateBackupDisabled || !this.stateHasLayerPixels(state)) return;
    try {
      const payload = JSON.stringify({ saved_at: Date.now(), state });
      if (payload.length > 4_000_000) {
        this.localStateBackupDisabled = true;
        if (!this.localStateBackupWarned) {
          this.localStateBackupWarned = true;
          console.info("[VNCCS UniCanvas] Local backup skipped: state is too large for browser localStorage; server cache remains active.");
        }
        return;
      }
      window.localStorage?.setItem(this.getStateBackupKey(), payload);
    } catch (err) {
      this.localStateBackupDisabled = true;
      if (!this.localStateBackupWarned) {
        this.localStateBackupWarned = true;
        console.info("[VNCCS UniCanvas] Local backup disabled: browser localStorage quota is not enough; server cache remains active.");
      }
    }
  }

  loadLocalStateBackup() {
    try {
      for (const key of [this.getStateBackupKey(), this.getLegacyStateBackupKey()]) {
        const raw = window.localStorage?.getItem(key);
        if (!raw) continue;
        const payload = JSON.parse(raw);
        const state = payload?.state;
        if (![1, 2].includes(state?.version) || !Array.isArray(state.layers) || !this.stateHasLayerPixels(state)) continue;
        return state;
      }
      return null;
    } catch (err) {
      console.warn("[VNCCS UniCanvas] Local state backup restore failed", err);
      return null;
    }
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
    if (this.isPointerDown || this.drawInProgress) {
      this.scheduleStateUpload();
      return;
    }
    this.pendingStateUpload = null;
    const state = this.buildSerializedState(true);
    return this.uploadStatePayload(state, false);
  }

  async uploadStatePayload(state, keepalive = false) {
    const payload = JSON.stringify({ state_id: this.getStateCacheId(), state });
    if (payload === this.lastUploadedStateJSON) return;
    this.lastUploadedStateJSON = payload;
    this.saveLocalStateBackup(state);
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
    const crop = includeData ? this.getLayerAlphaBounds(layer) : (layer._boundsCache === undefined ? null : layer._boundsCache);
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
    if (layer.hiresCanvas && layer.hiresRect) {
      const rect = this.normalizeLayerWorldRect(layer.hiresRect);
      layer._boundsCache = this.clampCanvasBounds({
        x: rect.x - this.origin.x,
        y: rect.y - this.origin.y,
        width: rect.width,
        height: rect.height,
      }, layer.canvas);
      return layer._boundsCache;
    }
    layer._boundsCache = this.getCanvasAlphaBounds(layer.canvas);
    return layer._boundsCache;
  }

  getCanvasAlphaBounds(canvas) {
    const ctx = this.getReadbackContext(canvas, false);
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
      let cacheRestoreFailed = false;
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
          cacheRestoreFailed = true;
          console.warn("[VNCCS UniCanvas] State cache restore failed", err);
          this.setStatus("State cache missing; trying local backup", true);
        }
      }
      if (!this.stateHasLayerPixels(state)) {
        const backup = this.loadLocalStateBackup();
        if (backup) {
          state = backup;
          this.setStatus(cacheRestoreFailed ? "Restored canvas from local backup" : "Restored canvas backup");
        } else if (cacheRestoreFailed) {
          this.setStatus("State cache missing and no local image backup found", true);
          return;
        }
      }
      if (this.isLegacyStateCacheId(this.stateCacheId) && this.stateHasLayerPixels(state)) {
        this.stateCacheId = this.createStateCacheId();
        this.stateBackupKey = null;
        state.state_id = this.stateCacheId;
      }
      await this.applySerializedState(state);
    } catch (err) {
      console.warn("[VNCCS UniCanvas] Failed to restore state", err);
    }
  }

  async applySerializedState(state) {
    try {
      if (!this.stateHasLayerPixels(state)) {
        const backup = this.loadLocalStateBackup();
        if (backup && this.stateHasLayerPixels(backup)) {
          state = backup;
          this.setStatus("Recovered canvas images from local backup");
        } else if (this.layers.some((layer) => this.getLayerAlphaBounds(layer))) {
          this.setStatus("Skipped metadata-only canvas restore to protect existing images", true);
          return;
        }
      }
      this.origin = state.origin || this.origin;
      this.size = state.size || this.size;
      this.bbox = state.bbox || this.bbox;
      this.snapToGrid = state.snapToGrid === true;
      this.resizeTransformMode = state.resizeTransformMode === "perspective" ? "perspective" : "scale";
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
        this.normalizeLayerOrder();
        this.activeLayerId = state.activeLayerId && this.layers.some((layer) => layer.id === state.activeLayerId)
          ? state.activeLayerId
          : this.layers.find((layer) => layer.type !== "mask")?.id || this.layers[0].id;
        this.saveLocalStateBackup(state);
      }
      this.syncPromptControls();
      this.updateSnapButton();
      this.renderLayerList();
    } catch (err) {
      console.warn("[VNCCS UniCanvas] Failed to restore state", err);
    }
  }

  hasMaskContent() {
    for (const layer of this.layers) {
      if (layer.type !== "mask" || !layer.visible) continue;
      const ctx = this.getReadbackContext(layer.canvas, false);
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
    const compositeCtx = this.getReadbackContext(composite);
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
      this.setSize([1280, 1280]);
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
      setTimeout(() => {
        this.uniCanvasWidget?.resize();
        this.uniCanvasWidget?.fitInitialView();
        this.uniCanvasWidget?.render();
      }, 50);
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
