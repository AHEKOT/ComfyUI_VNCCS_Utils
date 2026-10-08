// ComfyUI theme tokens apply only to the sidebar workspace; node widgets keep their own theme.
export const STANDALONE_STYLES = `
.vnccs-unicanvas.vnccs-uc-standalone,
body.vnccs-unicanvas-standalone-mode .vnccs-pe-dialog,
body.vnccs-unicanvas-standalone-mode .vnccs-custom-select-menu {
  --uc-bg:var(--base-background, var(--bg-color));
  --uc-panel:var(--interface-panel-surface, var(--comfy-menu-bg));
  --uc-surface:var(--secondary-background, var(--comfy-input-bg));
  --uc-hover:var(--secondary-background-hover, var(--content-hover-bg));
  --uc-border:var(--interface-stroke, var(--border-color));
  --uc-text:var(--base-foreground, var(--input-text));
  --uc-muted:var(--muted-foreground, var(--descrip-text));
  --uc-accent:var(--p-primary-color, var(--primary-bg));
  --uc-accent-2:var(--uc-accent);
  --uc-danger:var(--p-red-400, var(--error-text));
  --uc-good:var(--p-green-400, var(--success-background));
  --uc-font:var(--font-inter, Arial, sans-serif);
  --uc-selected:var(--interface-panel-selected-surface, var(--content-hover-bg));
  --uc-radius:var(--p-border-radius-sm, 4px);
  --vnccs-uc-ui-scale:1 !important;
  font:12px/1.4 var(--uc-font);
  border-radius:0;
  color-scheme:inherit;
}
.vnccs-unicanvas.vnccs-uc-standalone :is(.vnccs-uc-left, .vnccs-uc-side) {
  width:280px; padding:8px; gap:8px; zoom:1; background:var(--uc-panel);
}
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-left { width:336px; }
.vnccs-unicanvas.vnccs-uc-standalone :is(.vnccs-uc-bottom, .vnccs-uc-generation-progress) {
  background:var(--uc-panel); border-color:var(--uc-border);
}
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-bottom { padding:6px 8px; gap:6px; }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-stage-wrap { border-radius:0; }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-stage { background:var(--uc-bg); color:color-mix(in srgb, var(--uc-text) 8%, transparent); }
.vnccs-unicanvas.vnccs-uc-standalone :is(.vnccs-uc-section, .vnccs-uc-side-control, .vnccs-uc-draw-control,
  .vnccs-uc-model-card, .vnccs-uc-h3-panel, .vnccs-uc-lora-item, .vnccs-uc-settings-section,
  .vnccs-uc-layer, .vnccs-uc-layer-group-empty, .vnccs-uc-pose-side-head, .vnccs-uc-pose-character,
  .vnccs-uc-pose-help-item) {
  background:var(--uc-panel); border-color:var(--uc-border); border-radius:var(--uc-radius); box-shadow:none;
}
.vnccs-unicanvas.vnccs-uc-standalone :is(.vnccs-uc-section-head, .vnccs-uc-layer-group-head,
  .vnccs-uc-turbo-title, .vnccs-uc-lora-stack-title, .vnccs-uc-modal-title,
  .vnccs-uc-settings-section > summary, .vnccs-uc-pose-side-head strong) {
  color:var(--uc-text); font-weight:600; text-transform:none; letter-spacing:normal;
}
.vnccs-unicanvas.vnccs-uc-standalone :is(.vnccs-uc-model-card-name, .vnccs-uc-model-card-model) { color:var(--uc-text); font-size:12px; font-weight:600; }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-layer-group + .vnccs-uc-layer-group { border-color:var(--uc-border); }
.vnccs-unicanvas.vnccs-uc-standalone :is(button, input, select, textarea) { font-family:var(--uc-font); }
.vnccs-unicanvas.vnccs-uc-standalone :is(.vnccs-uc-btn, .vnccs-uc-icon, .vnccs-uc-model-tab, .vnccs-uc-model-card-download,
  .vnccs-uc-input, .vnccs-uc-select, .vnccs-uc-textarea) {
  height:28px; box-sizing:border-box; border:1px solid var(--uc-border); border-radius:var(--uc-radius);
  background:var(--uc-surface); color:var(--uc-text); font-size:12px; font-weight:400; color-scheme:inherit; box-shadow:none;
}
.vnccs-unicanvas.vnccs-uc-standalone :is(.vnccs-uc-btn, .vnccs-uc-model-tab, .vnccs-uc-model-card-download) { text-transform:none; }
.vnccs-unicanvas.vnccs-uc-standalone :is(.vnccs-uc-btn, .vnccs-uc-icon, .vnccs-uc-model-tab,
  .vnccs-uc-model-card-download, .vnccs-uc-model-card):hover:not(:disabled) {
  background:var(--uc-hover); border-color:var(--uc-border);
}
.vnccs-unicanvas.vnccs-uc-standalone :is(.vnccs-uc-btn, .vnccs-uc-icon, .vnccs-uc-model-tab, .vnccs-uc-tool,
  .vnccs-uc-seed-dice):is(.active, .active:hover),
.vnccs-unicanvas.vnccs-uc-standalone :is(.vnccs-uc-layer.active, .vnccs-uc-layer.active.locked, .vnccs-uc-model-card.selected) {
  background:var(--uc-selected); border-color:var(--uc-accent); color:var(--uc-text); box-shadow:none;
}
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-btn.primary,
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-btn.primary:disabled:hover {
  background:var(--primary-background, var(--primary-bg)); color:var(--primary-fg); border-color:transparent; font-weight:600;
}
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-btn.primary:hover:not(:disabled) { background:var(--primary-background-hover, var(--primary-hover-bg)); }
.vnccs-unicanvas.vnccs-uc-standalone :is(.vnccs-uc-btn.danger, .vnccs-uc-icon.danger, .vnccs-uc-btn.stop) { color:var(--uc-danger); border-color:var(--uc-border); }
.vnccs-unicanvas.vnccs-uc-standalone :is(.vnccs-uc-btn, .vnccs-uc-icon):disabled:hover { background:var(--uc-surface); border-color:var(--uc-border); }
.vnccs-unicanvas.vnccs-uc-standalone :is(button, input, select, textarea, summary, [tabindex]):focus-visible {
  outline:2px solid var(--uc-accent); outline-offset:1px;
}
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-textarea { height:64px; min-height:64px; padding:6px 8px; }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-select option { background:var(--uc-surface); color:var(--uc-text); font-size:12px; }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-select option:checked { background:var(--uc-selected); }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-draw-control { grid-template-columns:minmax(0,1fr) 42px; padding:6px; }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-draw-control.generating { grid-template-columns:minmax(0,1fr) 60px 42px; }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-batch-input { width:42px; }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-denoise-control { min-height:28px; padding:6px; font-weight:400; }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-seed-row { grid-template-columns:minmax(0,1fr) 28px; }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-seed-dice { width:28px; }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-tools { left:8px; gap:4px; padding:4px; border-radius:var(--uc-radius); background:var(--uc-panel); box-shadow:none; zoom:1; }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-tools .vnccs-uc-icon { width:32px; height:32px; border-radius:var(--uc-radius); }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-tools svg { width:18px; height:18px; }
.vnccs-unicanvas.vnccs-uc-standalone :is(.vnccs-uc-gear, .vnccs-uc-staging-popover .vnccs-uc-icon) svg { width:16px; height:16px; }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-staging-popover .vnccs-uc-icon { width:28px; height:28px; }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-chip { padding:3px 6px; background:var(--uc-panel); border-radius:var(--uc-radius); }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-progress-fill { background:var(--uc-accent); }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-progress-track { background:var(--uc-surface); }
.vnccs-unicanvas.vnccs-uc-standalone :is(.vnccs-uc-layer.locked:not(.active), .vnccs-uc-layer .vnccs-uc-icon.locked) { background:var(--uc-surface); border-color:var(--uc-border); color:var(--uc-text); }
.vnccs-unicanvas.vnccs-uc-standalone :is(.vnccs-uc-settings-popover, .vnccs-uc-refs-popover, .vnccs-uc-staging-popover,
  .vnccs-uc-modal, .vnccs-uc-prompt-guide-card, .vnccs-uc-pose-help-card, .vnccs-uc-pose-editbar,
  .vnccs-uc-pose-drag-hint, .vnccs-uc2-toast) {
  background:var(--uc-panel); color:var(--uc-text); border-color:var(--uc-border); border-radius:var(--uc-radius);
  font-family:var(--uc-font); box-shadow:var(--interface-floating-panel-shadow, none);
}
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-modal { padding:16px; font-size:13px; }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-modal-title { font-size:14px; }
.vnccs-unicanvas.vnccs-uc-standalone :is(.vnccs-uc-modal-overlay, .vnccs-uc-prompt-guide, .vnccs-uc-pose-help) { background:var(--p-mask-background, rgb(0 0 0 / 40%)); backdrop-filter:none; }
.vnccs-unicanvas.vnccs-uc-standalone :is(.vnccs-uc-help, .vnccs-uc-prompt-help, .vnccs-uc-model-card-chevron, .vnccs-uc-refs-label) { background:var(--uc-surface); color:var(--uc-muted); border-color:var(--uc-border); }
.vnccs-unicanvas.vnccs-uc-standalone :is(.vnccs-uc-help:hover, .vnccs-uc-prompt-help[aria-expanded="true"], .vnccs-uc-settings-section > summary:hover, .vnccs-uc-refs-add:hover) { background:var(--uc-hover); border-color:var(--uc-accent); color:var(--uc-text); }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-toggle { background:var(--uc-surface); border-color:var(--uc-border); }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-toggle.active { background:var(--uc-accent); }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-toggle.active::after { background:var(--primary-fg); }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-donate-link { padding:6px; background:var(--uc-panel); color:var(--uc-muted); text-align:center; box-shadow:none; }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-enhance-spark { display:none; }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-enhance-btn { filter:none; animation:none; }
/* These layer surfaces carry inline styles in the shared node UI. */
.vnccs-unicanvas.vnccs-uc-standalone :is(.vnccs-uc-layer-menu, .vnccs-uc-remove-bg-prompt, .vnccs-uc-color-match-popover) {
  background:var(--uc-panel) !important; color:var(--uc-text) !important; border-color:var(--uc-border) !important;
  border-radius:var(--uc-radius) !important; font:12px/1.4 var(--uc-font) !important; box-shadow:var(--interface-floating-panel-shadow, none) !important;
}
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-layer-menu-item { color:var(--uc-text) !important; border-radius:var(--uc-radius) !important; }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-layer-menu-item:hover { background:var(--uc-hover) !important; }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-layer-menu-group { color:var(--uc-muted) !important; font-weight:600 !important; letter-spacing:normal !important; }
.vnccs-unicanvas.vnccs-uc-standalone :is(.vnccs-uc-pose-root, .vnccs-uc-pose-side, .vnccs-uc-pose-controls, .vnccs-uc-pose-root > .vnccs-ps-canvas-wrap) {
  --ps-bg:var(--uc-bg); --ps-panel:var(--uc-panel); --ps-elevated:var(--uc-surface);
  --ps-surface:var(--uc-surface); --ps-hover:var(--uc-hover); --ps-input-bg:var(--uc-surface);
  --ps-border:var(--uc-border); --ps-border-hover:var(--uc-border);
  --ps-accent:var(--uc-accent); --ps-accent-hover:var(--uc-accent); --ps-accent-lavender:var(--uc-accent);
  --ps-accent-glow:transparent; --ps-accent-subtle:var(--uc-selected); --ps-accent-border:var(--uc-border);
  --ps-text:var(--uc-text); --ps-text-muted:var(--uc-muted); --ps-text-dim:var(--uc-muted);
  --ps-success:var(--uc-good); --ps-danger:var(--uc-danger); --ps-warning:var(--p-yellow-400, var(--warning-foreground));
  --ps-font:var(--uc-font); --ps-radius-sm:var(--uc-radius); --ps-radius-md:var(--uc-radius); --ps-radius-lg:var(--uc-radius);
}
.vnccs-unicanvas.vnccs-uc-standalone :is(.vnccs-ps-btn, .vnccs-ps-toggle-btn, .vnccs-ps-input, .vnccs-ps-select) {
  min-height:28px; background:var(--uc-surface); color:var(--uc-text); font-size:12px; box-shadow:none; transform:none;
}
.vnccs-unicanvas.vnccs-uc-standalone :is(.vnccs-ps-btn.primary, .vnccs-ps-toggle-btn.active) { background:var(--uc-selected); color:var(--uc-text); border-color:var(--uc-accent); }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-ps-section { background:var(--uc-panel); box-shadow:none; }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-ps-section-header { background:var(--uc-panel); }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-ps-label { font-size:11px; font-weight:400; letter-spacing:normal; text-transform:none; }
.vnccs-unicanvas.vnccs-uc-standalone .vnccs-ps-slider { background:var(--uc-border); }
.vnccs-unicanvas.vnccs-uc-standalone :is(.vnccs-ps-btn.primary::after, .vnccs-ps-section::before, .vnccs-ps-section-title::before) { display:none; }
body.vnccs-unicanvas-standalone-mode .vnccs-pe-dialog { border-color:var(--uc-border); border-radius:var(--uc-radius); background:var(--uc-panel); }
body.vnccs-unicanvas-standalone-mode :is(.vnccs-pe-body, .vnccs-pe-tabs, .vnccs-pe-pane, .vnccs-pe-field, .vnccs-pe-field textarea) { background:var(--uc-panel); border-color:var(--uc-border); box-shadow:none; color:var(--uc-text); color-scheme:inherit; }
body.vnccs-unicanvas-standalone-mode :is(.vnccs-pe-head h2, .vnccs-pe-title h3, .vnccs-pe-field label) { color:var(--uc-text); font-weight:600; }
body.vnccs-unicanvas-standalone-mode :is(.vnccs-pe-btn, .vnccs-pe-tab[aria-selected="true"]) { background:var(--uc-surface); border-color:var(--uc-border); color:var(--uc-text); border-radius:var(--uc-radius); }
body.vnccs-unicanvas-standalone-mode .vnccs-pe-btn.primary { background:var(--primary-background, var(--primary-bg)); color:var(--primary-fg); height:28px; }
body.vnccs-unicanvas-standalone-mode #vnccs-uc-help-tooltip { background:var(--interface-panel-surface, var(--comfy-menu-bg)); color:var(--base-foreground, var(--input-text)); border-color:var(--interface-stroke, var(--border-color)); border-radius:var(--p-border-radius-sm, 4px); }
body.vnccs-unicanvas-standalone-mode .vnccs-custom-select-menu { background:var(--uc-panel); color:var(--uc-text); border-color:var(--uc-border); border-radius:var(--uc-radius); box-shadow:var(--interface-floating-panel-shadow, none); }
body.vnccs-unicanvas-standalone-mode :is(.vnccs-custom-select-option:hover, .vnccs-custom-select-option.is-highlighted) { background:var(--uc-hover); color:var(--uc-text); }
body.vnccs-unicanvas-standalone-mode .vnccs-custom-select-check { color:var(--uc-accent); }
body.vnccs-unicanvas-standalone-mode .vnccs-custom-select-group { color:var(--uc-muted); font-weight:600; }
body.vnccs-unicanvas-standalone-mode .vnccs-custom-select-option:focus-visible { outline:2px solid var(--uc-accent); outline-offset:-2px; }
@media (max-width:1100px) {
  .vnccs-unicanvas.vnccs-uc-standalone :is(.vnccs-uc-left, .vnccs-uc-side) { width:240px; }
  .vnccs-unicanvas.vnccs-uc-standalone .vnccs-uc-left { width:288px; }
}
`;
