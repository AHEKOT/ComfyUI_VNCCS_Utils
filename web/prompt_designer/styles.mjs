export function ensureStyles() {
    if (document.getElementById("vnccs-prompt-designer-style")) return;
    const style = document.createElement("style");
    style.id = "vnccs-prompt-designer-style";
    style.textContent = `
.vnccs-pd { --pd-bg:#0a0a0f; --pd-panel:#12121a; --pd-raised:#1a1a26; --pd-text:#e8e8f0; --pd-muted:#9898a8; --pd-pink:#ff8fa3; --pd-lavender:#b8a9e8; --pd-border:rgba(255,255,255,.09); font:13px/1.5 'Sora',system-ui,sans-serif; color:var(--pd-text); background:var(--pd-bg); border:1px solid var(--pd-border); border-radius:12px; width:100%; height:100%; min-width:0; overflow:hidden; display:flex; flex-direction:column; container-type:inline-size; }
.vnccs-pd * { box-sizing:border-box; }
.vnccs-pd button,.vnccs-pd input,.vnccs-pd select,.vnccs-pd textarea { font:inherit; color:inherit; }
.vnccs-pd button { cursor:pointer; border:1px solid var(--pd-border); background:var(--pd-raised); border-radius:7px; padding:7px 11px; }
.vnccs-pd button:hover { border-color:var(--pd-pink); background:#252330; }
.vnccs-pd button:disabled { opacity:.45; cursor:default; }
.vnccs-pd button:focus-visible { outline:2px solid var(--pd-pink); outline-offset:2px; }
.vnccs-pd :is(input,select,textarea,[contenteditable="true"]):is(:focus,:focus-visible) { outline:none !important; box-shadow:none !important; border-color:var(--pd-border) !important; }
.vnccs-pd input,.vnccs-pd select { min-width:0; border:1px solid var(--pd-border); border-radius:7px; background:var(--pd-raised); padding:7px 10px; }
.vnccs-pd [hidden] { display:none !important; }
.vnccs-pd-workspace { display:grid; grid-template-columns:min(var(--pd-library-width,460px),calc(100% - 240px)) minmax(0,1fr); flex:1; min-height:200px; overflow:hidden; }
.vnccs-pd-workspace.has-inspector { --pd-inspector-size:min(var(--pd-inspector-width,310px),calc(100% - 480px)); grid-template-columns:min(var(--pd-library-width,460px),calc(100% - var(--pd-inspector-size) - 240px)) minmax(0,1fr) var(--pd-inspector-size); }
.vnccs-pd-inspector { position:relative; min-width:0; min-height:0; display:flex; flex-direction:column; gap:12px; padding:14px; border-left:1px solid var(--pd-border); background:var(--pd-panel); }
.vnccs-pd-inspector-head { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; flex-shrink:0; }
.vnccs-pd-inspector :is(.vnccs-pd-card-panel,.vnccs-pd-condition-panel,.vnccs-pd-multi-panel) { flex:1; min-height:0; max-height:none; overflow:auto; }
.vnccs-pd-card-panel { display:flex; flex-direction:column; gap:12px; }
.vnccs-pd-editor-modes { display:flex; gap:6px; }
.vnccs-pd-editor-modes button { flex:1; }
.vnccs-pd-editor-modes button.active { border-color:var(--pd-lavender); background:rgba(184,169,232,.2); }
.vnccs-pd-card-panel label { display:flex; flex-direction:column; gap:6px; color:var(--pd-muted); }
.vnccs-pd-card-panel :is(input,select) { width:100%; height:40px; flex-shrink:0; }
.vnccs-pd-card-panel input[type=color] { padding:4px; cursor:pointer; }
.vnccs-pd-card-panel input[type=color]::-webkit-color-swatch-wrapper { padding:0; }
.vnccs-pd-card-panel input[type=color]::-webkit-color-swatch { border:0; border-radius:4px; }
.vnccs-pd-card-panel input[type=color]::-moz-color-swatch { border:0; border-radius:4px; }
.vnccs-pd-inspector .vnccs-pd-condition-row { grid-template-columns:minmax(0,1fr); }
.vnccs-pd-inspector .vnccs-pd-condition-row :is(input,select) { height:40px; }
.vnccs-pd-library { position:relative; min-width:0; background:var(--pd-panel); border-right:1px solid var(--pd-border); display:flex; flex-direction:column; padding:14px; gap:10px; min-height:0; }
.vnccs-pd-library-tabs { display:flex; gap:6px; flex-shrink:0; }
.vnccs-pd-library-tabs button { flex:1; }
.vnccs-pd-library-tabs button.active { border-color:var(--pd-lavender); background:rgba(184,169,232,.2); }
.vnccs-pd-categories { display:flex; flex-wrap:wrap; gap:6px; max-height:150px; overflow:auto; flex-shrink:0; }
.vnccs-pd-categories button { padding:5px 9px; border-color:var(--pd-category-color,var(--pd-border)); }
.vnccs-pd-categories button.active { background:color-mix(in srgb,var(--pd-category-color,#b8a9e8) 22%,var(--pd-panel)); border-color:var(--pd-category-color,#b8a9e8); }
.vnccs-pd-category-form { display:flex; flex-wrap:wrap; gap:6px; }
.vnccs-pd-category-form input { flex:1; width:100%; }
.vnccs-pd-library-resize,.vnccs-pd-inspector-resize { position:absolute; top:0; bottom:0; width:8px; z-index:1; cursor:col-resize; touch-action:none; }
.vnccs-pd-library-resize { right:-4px; }
.vnccs-pd-inspector-resize { left:-4px; }
.vnccs-pd-library-resize:hover,.vnccs-pd-library-resize:focus-visible,.vnccs-pd-inspector-resize:hover,.vnccs-pd-inspector-resize:focus-visible { background:rgba(184,169,232,.25); }
.vnccs-pd-heading { text-transform:uppercase; letter-spacing:.08em; font-size:11px; color:var(--pd-lavender); font-weight:600; }
.vnccs-pd-list { flex:1; min-height:0; overflow:auto; display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr)); align-content:start; gap:8px; }
.vnccs-pd .vnccs-pd-block { min-width:0; width:100%; text-align:left; padding:10px !important; display:flex; gap:8px; align-items:center; border-color:color-mix(in srgb,var(--pd-chip-color,#b8a9e8) 45%,var(--pd-border)); background:color-mix(in srgb,var(--pd-chip-color,#b8a9e8) 12%,var(--pd-raised)); }
.vnccs-pd .vnccs-pd-block:hover { background:color-mix(in srgb,var(--pd-chip-color,#b8a9e8) 24%,var(--pd-raised)); }
.vnccs-pd .vnccs-pd-block.active { border-color:var(--pd-chip-color,#b8a9e8); box-shadow:inset 3px 0 var(--pd-chip-color,#b8a9e8); }
.vnccs-pd-block .handle { color:var(--pd-muted); cursor:grab; }
.vnccs-pd-block-copy { min-width:0; flex:1; }
.vnccs-pd-block-name { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vnccs-pd-excerpt { display:block; color:var(--pd-muted); font:11px/1.5 'JetBrains Mono',monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vnccs-pd-hint { font-size:11px; color:var(--pd-muted); }
.vnccs-pd-editing { min-width:0; min-height:0; display:flex; flex-direction:column; padding:12px; gap:10px; }
.vnccs-pd-toolbar { display:flex; align-items:center; gap:6px; min-width:0; }
.vnccs-pd-tabs { display:flex; flex:1; min-width:0; overflow:auto; gap:3px; }
.vnccs-pd-tab { display:flex; flex-shrink:0; align-items:center; border-radius:7px 7px 0 0; border:1px solid var(--pd-border); }
.vnccs-pd-tab.active { border-bottom:3px solid var(--pd-pink); background:rgba(255,143,163,.06); }
.vnccs-pd-tab button { border:0; background:transparent; white-space:nowrap; max-width:180px; overflow:hidden; text-overflow:ellipsis; }
.vnccs-pd-tab .close { padding:6px; color:var(--pd-muted); }
.vnccs-pd-doc { flex:1; min-width:0; min-height:0; display:flex; flex-direction:column; gap:8px; }
.vnccs-pd-doc-head { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.vnccs-pd-doc-head input { flex:1; }
.vnccs-pd-editor { flex:1; min-height:100px; overflow:auto; margin:0; padding:16px; border:1px solid var(--pd-border); border-radius:8px; background:#0d0d14; color:var(--pd-text); font:14px/1.9 'JetBrains Mono','SFMono-Regular',Consolas,monospace; white-space:pre-wrap; overflow-wrap:anywhere; tab-size:4; caret-color:var(--pd-pink); }
.vnccs-pd-editor:empty::before { content:'Write your prompt. Drag blocks here from the library.'; color:var(--pd-muted); pointer-events:none; }
.vnccs-pd-source-text { width:100%; resize:none; background:var(--pd-panel); caret-color:var(--pd-text); }
.vnccs-pd-variants-head { display:flex; align-items:center; gap:12px; }
.vnccs-pd-variants { flex:1; min-height:70px; overflow:auto; margin:0; padding:0; list-style:none; border:1px solid var(--pd-border); border-radius:8px; background:var(--pd-panel); }
.vnccs-pd-variant { display:grid; grid-template-columns:36px minmax(0,1fr); gap:10px; padding:10px 12px; border-bottom:1px solid var(--pd-border); }
.vnccs-pd-variant:last-child { border-bottom:0; }
.vnccs-pd-variant-index { color:var(--pd-lavender); font-variant-numeric:tabular-nums; text-align:right; }
.vnccs-pd-variant-text { white-space:pre-wrap; overflow-wrap:anywhere; user-select:text; font:13px/1.7 'JetBrains Mono','SFMono-Regular',Consolas,monospace; }
.vnccs-pd .vnccs-pd-variants:focus,.vnccs-pd .vnccs-pd-variant-text:focus { outline:none; box-shadow:none; }
.vnccs-pd-variant-text { min-height:1.7em; caret-color:var(--pd-text); }
.vnccs-pd-variant-text:empty::before { content:attr(data-placeholder); color:var(--pd-muted); pointer-events:none; }
.vnccs-pd-variant-text::selection,.vnccs-pd-variant-text ::selection,.vnccs-pd-source-text::selection { background:rgba(184,169,232,.2); }
.vnccs-pd-match { color:var(--pd-bg); background:var(--pd-pink); border-radius:2px; }
.vnccs-pd-chip { display:inline-block; white-space:nowrap; background:rgba(184,169,232,.10); color:#d9cff5; border:1px solid rgba(184,169,232,.4); border-radius:5px; padding:2px 5px; cursor:pointer; }
.vnccs-pd-chip[data-block-id] { border-color:var(--pd-chip-color,#b8a9e8); background:color-mix(in srgb,var(--pd-chip-color,#b8a9e8) 16%,#0d0d14); color:var(--pd-text); }
.vnccs-pd-chip:focus-visible { outline:2px solid var(--pd-pink); }
.vnccs-pd-chip.selected { box-shadow:0 0 0 1px var(--pd-text); background:rgba(232,232,240,.14); }
.vnccs-pd-chip.selected:focus { outline:none; }
.vnccs-pd-chip:hover { background:rgba(255,143,163,.12); border-color:var(--pd-pink); }
.vnccs-pd-condition { display:inline-flex; flex-wrap:nowrap; align-items:center; vertical-align:middle; gap:4px; padding:3px 5px; border-color:var(--pd-pink); min-width:0; max-width:min(100%,72ch); white-space:nowrap; overflow-x:auto; overflow-y:hidden; scrollbar-width:thin; scrollbar-color:var(--pd-muted) transparent; line-height:24px; cursor:default; }
.vnccs-pd-condition::-webkit-scrollbar { height:6px; }
.vnccs-pd-condition::-webkit-scrollbar-thumb { background:var(--pd-muted); border-radius:3px; }
.vnccs-pd-condition-output::-webkit-scrollbar { display:none; }
.vnccs-pd-condition > * { flex-shrink:0; }
.vnccs-pd-condition-label { font-weight:600; cursor:default; }
.vnccs-pd-condition-handle { cursor:grab; user-select:none; padding:0 2px; color:var(--pd-muted); }
.vnccs-pd-condition-handle:active { cursor:grabbing; }
.vnccs-pd-condition-clauses,.vnccs-pd-condition-inline-clause,.vnccs-pd-condition-inline-check { display:inline-flex; flex-wrap:nowrap; align-items:center; gap:4px; white-space:nowrap; }
.vnccs-pd-condition-clauses > *,.vnccs-pd-condition-inline-clause > *,.vnccs-pd-condition-inline-check > * { flex-shrink:0; }
.vnccs-pd-condition-extra { margin-bottom:8px; padding-top:8px; border-top:1px solid var(--pd-border); }
.vnccs-pd-condition-drop { display:inline-flex; align-items:center; max-width:calc(14ch + 8px); height:26px; padding:0 3px; border:1px dashed var(--pd-border); border-radius:5px; background:var(--pd-bg); }
.vnccs-pd-condition .vnccs-pd-chip { max-width:14ch; padding:0 3px; overflow:hidden; text-overflow:ellipsis; vertical-align:middle; line-height:20px; }
.vnccs-pd-condition-drop:empty::before { content:attr(data-placeholder); color:var(--pd-muted); }
.vnccs-pd-condition-drop:focus,.vnccs-pd-condition-source:focus { outline:none; box-shadow:none; }
.vnccs-pd-condition :is(input,select) { height:26px; padding:1px 4px; font:inherit; line-height:22px; text-overflow:ellipsis; }
.vnccs-pd-condition-value { width:calc(4ch + 12px); flex:none; }
.vnccs-pd-condition .vnccs-pd-condition-output { flex:none; width:max-content; min-width:4ch; max-width:18ch; height:26px; min-height:26px; max-height:26px; padding:1px 4px; border-radius:5px; font:inherit; line-height:22px; white-space:nowrap; overflow-x:auto; overflow-y:hidden; scrollbar-width:none; }
.vnccs-pd-condition-output:empty::before { content:attr(data-placeholder); }
.vnccs-pd-condition-suggestion { align-self:flex-start; color:var(--pd-pink) !important; }
.vnccs-pd-condition-panel { margin:0; padding:10px; border:1px solid var(--pd-pink); border-radius:8px; background:var(--pd-panel); max-height:250px; overflow:auto; flex-shrink:0; }
.vnccs-pd-condition-panel legend { color:var(--pd-pink); }
.vnccs-pd-condition-row { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; margin-bottom:8px; }
.vnccs-pd-condition-panel label { display:flex; flex-direction:column; gap:5px; margin-bottom:8px; color:var(--pd-muted); font-size:11px; }
.vnccs-pd-condition-panel input,.vnccs-pd-condition-panel select,.vnccs-pd-condition-panel textarea { width:100%; color:var(--pd-text); }
.vnccs-pd-condition-panel textarea { min-height:55px; resize:vertical; border:1px solid var(--pd-border); border-radius:7px; padding:7px 10px; background:var(--pd-raised); }
.vnccs-pd-condition-panel .vnccs-pd-editor { min-height:64px; max-height:180px; padding:8px 10px; color:var(--pd-text); }
.vnccs-pd-condition-source { cursor:default; }
.vnccs-pd-condition-source:empty::before { content:'Drop block here'; }
.vnccs-pd-condition-panel button { margin-right:6px; }
.vnccs-pd-tools { display:flex; gap:8px; flex-shrink:0; padding-top:4px; }
.vnccs-pd-multi { border-color:var(--pd-lavender); }
.vnccs-pd-multi-panel { flex-shrink:0; max-height:280px; overflow:auto; margin:0; padding:10px; border:1px solid var(--pd-lavender); border-radius:8px; background:var(--pd-panel); }
.vnccs-pd-multi-panel legend { color:var(--pd-lavender); }
.vnccs-pd-multi-row { margin:10px 0; }
.vnccs-pd-multi-head { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:6px; }
.vnccs-pd-multi-head span { color:var(--pd-lavender); }
.vnccs-pd-multi-head select { flex:1; }
.vnccs-pd-multi-head :is(button,select) { height:34px; }
.vnccs-pd-multi-panel .vnccs-pd-variant-editor { min-height:64px; max-height:120px; padding:8px 10px; }
.vnccs-pd-status { color:#00d68f; font-size:11px; min-height:17px; }
.vnccs-pd-status.error { color:#ff8f9a; }
.vnccs-pd-preview { flex:0 0 auto; border-top:1px solid var(--pd-border); padding:12px 14px; }
.vnccs-pd-preview-head { display:flex; align-items:center; gap:10px; margin-bottom:8px; }
.vnccs-pd-preview-head .vnccs-pd-status { flex:1; }
.vnccs-pd-output { margin:0; min-height:65px; max-height:140px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font:13px/1.7 'JetBrains Mono',monospace; background:var(--pd-panel); border:1px solid var(--pd-border); border-radius:8px; padding:12px; }
.vnccs-pd-footer { border-top:1px solid var(--pd-border); display:flex; align-items:center; flex-wrap:wrap; gap:10px; padding:10px 14px; }
.vnccs-pd-footer label { display:flex; align-items:center; gap:7px; color:var(--pd-muted); }
.vnccs-pd-seed { width:185px; font-family:'JetBrains Mono',monospace !important; }
.vnccs-pd button.primary { background:var(--pd-pink); border-color:var(--pd-pink); color:#21151c; font-weight:600; }
.vnccs-pd button.primary:hover:not(:disabled) { background:#ffb6c8; border-color:#ffb6c8; color:#21151c; }
.vnccs-pd button.primary:active:not(:disabled) { background:var(--pd-pink); border-color:var(--pd-pink); color:#21151c; }
.vnccs-pd-shuffle { margin-left:auto; }
.vnccs-pd-library-menu,.vnccs-pd-library-dialog { box-sizing:border-box; font:13px/1.5 'Sora',system-ui,sans-serif; color:#e8e8f0; background:#12121a; border:1px solid rgba(255,255,255,.12); box-shadow:0 18px 60px rgba(0,0,0,.5); }
.vnccs-pd-library-menu { position:fixed; z-index:2147483000; min-width:190px; max-width:calc(100vw - 16px); padding:6px; border-radius:10px; }
.vnccs-pd-library-menu button,.vnccs-pd-library-dialog button { font:inherit; cursor:pointer; border:1px solid rgba(255,255,255,.12); border-radius:7px; background:#1a1a26; color:inherit; padding:9px 14px; }
.vnccs-pd-library-menu button { display:block; width:100%; text-align:left; border:0; background:transparent; }
.vnccs-pd-library-menu button:hover,.vnccs-pd-library-menu button:focus-visible { background:#2a2a38; outline:none; }
.vnccs-pd-library-menu .danger { color:#ff8f9a; border-top:1px solid rgba(255,255,255,.09); margin-top:4px; }
.vnccs-pd-library-dialog { width:min(420px,calc(100vw - 32px)); padding:24px; border-radius:16px; }
.vnccs-pd-library-dialog::backdrop { background:rgba(0,0,0,.7); backdrop-filter:blur(5px); }
.vnccs-pd-library-dialog h2 { margin:0; font-size:18px; color:#b8a9e8; }
.vnccs-pd-library-dialog p { margin:14px 0; overflow-wrap:anywhere; color:#9898a8; }
.vnccs-pd-library-dialog input { box-sizing:border-box; width:100%; height:40px; font:inherit; border:1px solid rgba(255,255,255,.12); border-radius:7px; padding:8px 12px; background:#1a1a26; color:#e8e8f0; outline:none !important; box-shadow:none !important; }
.vnccs-pd-library-dialog input:is(:focus,:focus-visible) { border-color:rgba(255,255,255,.12) !important; }
.vnccs-pd-library-dialog .actions { display:flex; justify-content:flex-end; gap:10px; margin-top:22px; }
.vnccs-pd-library-dialog button.primary { background:#ff8fa3; border-color:#ff8fa3; color:#21151c; font-weight:600; }
.vnccs-pd-library-dialog button.primary:hover:not(:disabled) { background:#ffb6c8; border-color:#ffb6c8; }
.vnccs-pd-library-dialog button:focus-visible { outline:2px solid #b8a9e8; outline-offset:2px; }
.vnccs-pd-library-dialog button:disabled { opacity:.5; cursor:default; }
.vnccs-pd-library-dialog .error { color:#ff8f9a; }
@container (max-width:1000px) { .vnccs-pd-library { padding:10px; } .vnccs-pd-toolbar { flex-wrap:wrap; } .vnccs-pd-tabs { flex-basis:100%; } }
`;
    document.head.append(style);
}
