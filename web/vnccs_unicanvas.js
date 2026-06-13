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
  width:100%; height:100%; min-height:620px; display:grid; grid-template-columns:minmax(0,1fr) 238px;
  grid-template-rows:minmax(0,1fr) 92px; background:var(--uc-bg); color:var(--uc-text);
  font:11px var(--uc-font); overflow:hidden; border-radius:12px; pointer-events:auto; position:relative;
}
.vnccs-uc-stage-wrap { grid-column:1; grid-row:1; position:relative; min-width:0; min-height:0; overflow:hidden; }
.vnccs-uc-stage { width:100%; height:100%; display:block; background:#07070c; cursor:crosshair; }
.vnccs-uc-hud { position:absolute; left:10px; top:10px; display:flex; gap:6px; align-items:center; pointer-events:none; }
.vnccs-uc-chip { background:rgba(10,10,15,.72); border:1px solid var(--uc-border); border-radius:8px; padding:5px 8px; color:var(--uc-muted); }
.vnccs-uc-side { grid-column:2; grid-row:1 / span 2; display:flex; flex-direction:column; gap:8px; padding:8px; border-left:1px solid var(--uc-border); background:rgba(6,5,12,.72); min-height:0; }
.vnccs-uc-section { background:var(--uc-panel); border:1px solid rgba(255,143,163,.2); border-radius:12px; overflow:hidden; box-shadow:0 4px 16px rgba(0,0,0,.35); }
.vnccs-uc-section-head { display:flex; align-items:center; justify-content:space-between; padding:7px 9px; color:var(--uc-accent); font-weight:700; border-bottom:1px solid var(--uc-border); }
.vnccs-uc-layers { flex:1; min-height:140px; overflow:auto; padding:6px; display:flex; flex-direction:column; gap:5px; }
.vnccs-uc-layer { display:grid; grid-template-columns:22px 1fr 22px 22px; gap:5px; align-items:center; padding:6px; border:1px solid var(--uc-border); border-radius:8px; background:rgba(255,255,255,.035); cursor:pointer; }
.vnccs-uc-layer.active { border-color:rgba(255,143,163,.55); background:rgba(255,143,163,.12); }
.vnccs-uc-layer-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vnccs-uc-layer-type { color:var(--uc-muted); font-size:10px; }
.vnccs-uc-bottom { grid-column:1; grid-row:2; display:grid; grid-template-columns:auto 1fr auto; gap:8px; align-items:stretch; padding:8px; border-top:1px solid var(--uc-border); background:rgba(6,5,12,.75); }
.vnccs-uc-tools, .vnccs-uc-settings, .vnccs-uc-actions { display:flex; align-items:center; gap:6px; min-width:0; }
.vnccs-uc-settings { overflow:auto; }
.vnccs-uc-btn, .vnccs-uc-icon { border:1px solid var(--uc-border); background:var(--uc-surface); color:var(--uc-text); border-radius:8px; height:28px; padding:0 9px; cursor:pointer; font:inherit; white-space:nowrap; }
.vnccs-uc-icon { width:30px; padding:0; display:grid; place-items:center; }
.vnccs-uc-btn:hover, .vnccs-uc-icon:hover { background:var(--uc-hover); border-color:rgba(255,255,255,.16); }
.vnccs-uc-btn.primary { background:linear-gradient(135deg,var(--uc-accent),var(--uc-accent-2)); color:#120b13; font-weight:800; border:0; }
.vnccs-uc-btn.danger { color:#ffdce1; border-color:rgba(255,71,87,.35); }
.vnccs-uc-tool.active { border-color:rgba(255,143,163,.7); background:rgba(255,143,163,.18); color:#ffdce5; }
.vnccs-uc-input, .vnccs-uc-select, .vnccs-uc-textarea { background:rgba(255,255,255,.045); border:1px solid var(--uc-border); color:var(--uc-text); border-radius:8px; height:28px; padding:0 8px; font:inherit; min-width:0; }
.vnccs-uc-textarea { height:54px; padding:7px 8px; resize:none; width:100%; box-sizing:border-box; }
.vnccs-uc-field { display:flex; flex-direction:column; gap:4px; min-width:62px; color:var(--uc-muted); }
.vnccs-uc-field.inline { flex-direction:row; align-items:center; }
.vnccs-uc-range { width:82px; accent-color:var(--uc-accent); }
.vnccs-uc-mini-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px; padding:8px; }
.vnccs-uc-stack { display:flex; flex-direction:column; gap:6px; padding:8px; }
.vnccs-uc-staging { min-height:92px; display:flex; flex-direction:column; gap:6px; }
.vnccs-uc-preview { width:100%; aspect-ratio:1.5; background:rgba(255,255,255,.035); border:1px dashed var(--uc-border); border-radius:8px; object-fit:contain; }
.vnccs-uc-status { min-height:16px; color:var(--uc-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vnccs-uc-file { display:none; }
`;

if (!document.getElementById("vnccs-unicanvas-styles")) {
  const style = document.createElement("style");
  style.id = "vnccs-unicanvas-styles";
  style.textContent = STYLES;
  document.head.appendChild(style);
}

const uid = () => `uc_${Math.random().toString(36).slice(2, 10)}`;
const MASK_OVERLAY_COLOR = "rgba(255, 143, 163, 0.48)";

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
    this.opacity = 1;
    this.fg = "#ffffff";
    this.isPointerDown = false;
    this.pointerMode = null;
    this.lastPoint = null;
    this.dragStart = null;
    this.didInitialCenter = false;
    this.staging = null;
    this.checkpoints = [];
    this.settings = {
      ckpt_name: "",
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
    this._isRestoring = true;
    this._loadFromNode().finally(() => {
      this._isRestoring = false;
      this.centerBbox(false);
      this.didInitialCenter = true;
      this.renderLayerList();
      this.render();
    });
    this._loadCheckpoints();
    this._attachEvents();
    this.resize();
    this.render();
  }

  _buildDOM() {
    this.stageWrap = document.createElement("div");
    this.stageWrap.className = "vnccs-uc-stage-wrap";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "vnccs-uc-stage";
    this.stageWrap.appendChild(this.canvas);
    this.hud = document.createElement("div");
    this.hud.className = "vnccs-uc-hud";
    this.stageWrap.appendChild(this.hud);

    this.side = document.createElement("div");
    this.side.className = "vnccs-uc-side";
    this.layerList = document.createElement("div");
    this.layerList.className = "vnccs-uc-layers";
    const layersSection = this._section("Layers", this.layerList, [
      ["+", "Add raster", () => this.addLayer("raster")],
      ["◐", "Add mask", () => this.addLayer("mask")],
      ["⧉", "Duplicate selected", () => this.duplicateActiveLayer()],
      ["↑", "Move selected up", () => this.moveActiveLayer(-1)],
      ["↓", "Move selected down", () => this.moveActiveLayer(1)],
    ]);

    this.promptBox = document.createElement("div");
    this.promptBox.className = "vnccs-uc-stack";
    this.promptBox.innerHTML = `
      <label class="vnccs-uc-field">Checkpoint<select class="vnccs-uc-select" data-setting="ckpt_name"></select></label>
      <label class="vnccs-uc-field">Positive<textarea class="vnccs-uc-textarea" data-setting="positive" placeholder="positive prompt"></textarea></label>
      <label class="vnccs-uc-field">Negative<textarea class="vnccs-uc-textarea" data-setting="negative" placeholder="negative prompt"></textarea></label>
      <div class="vnccs-uc-mini-grid">
        <label class="vnccs-uc-field">Seed<input class="vnccs-uc-input" data-setting="seed" type="number"></label>
        <label class="vnccs-uc-field">Steps<input class="vnccs-uc-input" data-setting="steps" type="number"></label>
        <label class="vnccs-uc-field">CFG<input class="vnccs-uc-input" data-setting="cfg" type="number" step="0.1"></label>
        <label class="vnccs-uc-field">Denoise<input class="vnccs-uc-input" data-setting="denoise" type="number" step="0.01" min="0" max="1"></label>
      </div>`;
    const promptSection = this._section("SDXL Draw", this.promptBox);

    this.stagingBox = document.createElement("div");
    this.stagingBox.className = "vnccs-uc-stack vnccs-uc-staging";
    this.preview = document.createElement("img");
    this.preview.className = "vnccs-uc-preview";
    const accept = this._button("Accept as layer", "vnccs-uc-btn", () => this.acceptStaging());
    this.status = document.createElement("div");
    this.status.className = "vnccs-uc-status";
    this.status.textContent = "Ready";
    this.stagingBox.append(this.preview, accept, this.status);
    const stagingSection = this._section("Staging", this.stagingBox);

    this.side.append(layersSection, promptSection, stagingSection);

    this.bottom = document.createElement("div");
    this.bottom.className = "vnccs-uc-bottom";
    this.tools = document.createElement("div");
    this.tools.className = "vnccs-uc-tools";
    [
      ["move", "↕", "Move layer/view"],
      ["brush", "●", "Brush"],
      ["eraser", "⌫", "Eraser"],
      ["mask", "◐", "Mask brush"],
      ["rect", "□", "Rectangle shape"],
      ["lasso", "⌁", "Lasso"],
      ["bbox", "▣", "Generation bbox"],
      ["pan", "✥", "Pan"],
    ].forEach(([tool, label, title]) => this.tools.appendChild(this._toolButton(tool, label, title)));

    this.settingsBar = document.createElement("div");
    this.settingsBar.className = "vnccs-uc-settings";
    this.settingsBar.innerHTML = `
      <label class="vnccs-uc-field inline">Size <input class="vnccs-uc-range" type="range" min="1" max="220" value="${this.brushSize}" data-control="brushSize"></label>
      <label class="vnccs-uc-field inline">Color <input class="vnccs-uc-input" type="color" value="${this.fg}" data-control="fg" style="width:42px;padding:0"></label>
      <label class="vnccs-uc-field inline">Alpha <input class="vnccs-uc-range" type="range" min="0" max="1" step="0.01" value="${this.opacity}" data-control="opacity"></label>
      <label class="vnccs-uc-field inline">Layer <input class="vnccs-uc-range" type="range" min="0" max="1" step="0.01" value="${this.activeLayer?.opacity || 1}" data-control="layerOpacity"></label>
      <button class="vnccs-uc-btn" data-action="fit">Fit</button>
      <button class="vnccs-uc-btn" data-action="import">Import</button>`;
    this.fileInput = document.createElement("input");
    this.fileInput.className = "vnccs-uc-file";
    this.fileInput.type = "file";
    this.fileInput.accept = "image/*";

    this.actions = document.createElement("div");
    this.actions.className = "vnccs-uc-actions";
    this.drawBtn = this._button("DRAW", "vnccs-uc-btn primary", () => this.draw());
    this.actions.append(this.drawBtn);
    this.bottom.append(this.tools, this.settingsBar, this.actions, this.fileInput);

    this.container.append(this.stageWrap, this.side, this.bottom);
  }

  _section(title, body, actions = []) {
    const section = document.createElement("div");
    section.className = "vnccs-uc-section";
    const head = document.createElement("div");
    head.className = "vnccs-uc-section-head";
    const text = document.createElement("span");
    text.textContent = title;
    const actionBox = document.createElement("div");
    actionBox.style.display = "flex";
    actionBox.style.gap = "4px";
    for (const [label, hint, fn] of actions) actionBox.append(this._button(label, "vnccs-uc-icon", fn, hint));
    head.append(text, actionBox);
    section.append(head, body);
    return section;
  }

  _button(label, className, onClick, title = label) {
    const btn = document.createElement("button");
    btn.className = className;
    btn.type = "button";
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick?.();
    });
    return btn;
  }

  _toolButton(tool, label, title) {
    const btn = this._button(label, "vnccs-uc-icon vnccs-uc-tool", () => this.setTool(tool), title);
    btn.dataset.tool = tool;
    return btn;
  }

  _createCanvas() {
    const c = document.createElement("canvas");
    c.width = this.size.width;
    c.height = this.size.height;
    return c;
  }

  _createInitialLayers() {
    if (this.layers.length) return;
    this.addLayer("raster", "Base Layer");
    this.addLayer("mask", "Inpaint Mask");
    this.activeLayerId = this.layers[0].id;
  }

  addLayer(type = "raster", name = null) {
    const layer = {
      id: uid(),
      name: name || (type === "mask" ? `Mask ${this.layers.filter((l) => l.type === "mask").length + 1}` : `Layer ${this.layers.filter((l) => l.type === "raster").length + 1}`),
      type,
      visible: true,
      locked: false,
      opacity: 1,
      canvas: this._createCanvas(),
    };
    this.layers.unshift(layer);
    this.activeLayerId = layer.id;
    this.renderLayerList();
    this.render();
    this.syncToNode();
    return layer;
  }

  get activeLayer() {
    return this.layers.find((l) => l.id === this.activeLayerId) || this.layers[0] || null;
  }

  setTool(tool) {
    this.tool = tool;
    this.container.querySelectorAll(".vnccs-uc-tool").forEach((btn) => btn.classList.toggle("active", btn.dataset.tool === tool));
    this.syncCursorStyle();
    this.render();
  }

  syncCursorStyle() {
    const cursorMap = {
      brush: "none",
      eraser: "none",
      mask: "none",
      rect: "crosshair",
      lasso: "crosshair",
      bbox: "move",
      move: "move",
      pan: "grab",
    };
    this.canvas.style.cursor = cursorMap[this.tool] || "default";
  }

  _attachEvents() {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.stageWrap);
    this.canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.canvas.addEventListener("pointerenter", (e) => this.onPointerHover(e));
    this.canvas.addEventListener("pointerleave", (e) => this.onPointerLeave(e));
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    this.canvas.addEventListener("auxclick", (e) => e.preventDefault());
    window.addEventListener("pointermove", (e) => this.onPointerMove(e));
    window.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });

    this.settingsBar.addEventListener("input", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.dataset.control === "brushSize") this.brushSize = Number(target.value);
      if (target.dataset.control === "fg") this.fg = target.value;
      if (target.dataset.control === "opacity") this.opacity = Number(target.value);
      if (target.dataset.control === "layerOpacity" && this.activeLayer) {
        this.activeLayer.opacity = Number(target.value);
        this.renderLayerList();
        this.syncToNode();
      }
      this.render();
    });
    this.settingsBar.addEventListener("click", (e) => {
      const action = e.target?.dataset?.action;
      if (action === "fit") this.fitView();
      if (action === "import") this.fileInput.click();
    });
    this.fileInput.addEventListener("change", () => this.importFile(this.fileInput.files?.[0]));
    this.side.addEventListener("input", (e) => {
      const target = e.target;
      const key = target?.dataset?.setting;
      if (!key) return;
      this.settings[key] = target.type === "number" ? Number(target.value) : target.value;
      this.syncToNode();
    });
    this.setTool(this.tool);
  }

  async _loadCheckpoints() {
    try {
      const res = await fetch("/vnccs/unicanvas/checkpoints");
      const data = await res.json();
      this.checkpoints = data.checkpoints || [];
      const select = this.container.querySelector('[data-setting="ckpt_name"]');
      select.innerHTML = this.checkpoints.map((name) => `<option value="${this._escape(name)}">${this._escape(name)}</option>`).join("");
      if (!this.settings.ckpt_name && this.checkpoints[0]) this.settings.ckpt_name = this.checkpoints[0];
      select.value = this.settings.ckpt_name;
      this.syncPromptControls();
    } catch (err) {
      this.setStatus(`Checkpoint list failed: ${err.message || err}`, true);
    }
  }

  _escape(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  resize() {
    const rect = this.stageWrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    if (!this.didInitialCenter && rect.width > 0 && rect.height > 0) {
      this.centerBbox(false);
      this.didInitialCenter = true;
    }
    this.render();
  }

  canvasPointFromEvent(e) {
    const style = getComputedStyle(this.canvas);
    const layoutW = Number.parseFloat(style.width) || this.canvas.offsetWidth || this.canvas.width;
    const layoutH = Number.parseFloat(style.height) || this.canvas.offsetHeight || this.canvas.height;
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (layoutW / Math.max(rect.width || 1, 1)),
      y: (e.clientY - rect.top) * (layoutH / Math.max(rect.height || 1, 1)),
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
    this.render();
  }

  onPointerLeave(e) {
    if (this.isPointerDown) return;
    this.hoverPointerType = e.pointerType || "mouse";
    this.hoverPoint = null;
    this.render();
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
    if (this.pointerMode === "bbox") {
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
      this.shapeComposite = e.ctrlKey || e.metaKey ? "destination-out" : "source-over";
      this.shapeDraft = this.getRectToolRect(point, point, e);
    } else if (this.pointerMode === "lasso") {
      this.shapeComposite = e.ctrlKey || e.metaKey ? "destination-out" : "source-over";
      this.lassoPoints = [point];
    } else if (this.pointerMode === "move" && !e.altKey && this.activeLayer && !this.activeLayer.locked) {
      this.pointerMode = "layer-move";
      this.dragStart.layerCanvas = this.cloneCanvas(this.activeLayer.canvas);
    }
    if (["brush", "eraser", "mask"].includes(this.pointerMode)) this.drawStroke(point, point);
  }

  onPointerMove(e) {
    const screen = this.canvasPointFromEvent(e);
    const point = this.worldFromCanvasPoint(screen);
    this.hoverPointerType = e.pointerType || "mouse";
    this.hoverPoint = point;
    if (!this.isPointerDown || !this.lastPoint) {
      this.render();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (this.pointerMode === "pan" || (this.pointerMode === "move" && e.altKey)) {
      this.view.x = this.dragStart.view.x + (screen.x - this.dragStart.screen.x);
      this.view.y = this.dragStart.view.y + (screen.y - this.dragStart.screen.y);
    } else if (this.pointerMode === "bbox-move") {
      const grid = e.shiftKey ? 8 : 1;
      this.bbox.x = this.roundToMultiple(this.dragStart.bbox.x + point.x - this.dragStart.point.x, grid);
      this.bbox.y = this.roundToMultiple(this.dragStart.bbox.y + point.y - this.dragStart.point.y, grid);
    } else if (this.pointerMode === "bbox-resize") {
      this.resizeBbox(point, e);
    } else if (this.pointerMode === "rect") {
      this.shapeDraft = this.getRectToolRect(this.dragStart.point, point, e);
    } else if (this.pointerMode === "lasso") {
      this.appendLassoPoint(point);
    } else if (this.pointerMode === "layer-move") {
      this.moveActiveLayerPixels(point.x - this.dragStart.point.x, point.y - this.dragStart.point.y);
    } else if (["brush", "eraser", "mask"].includes(this.pointerMode)) {
      this.drawStroke(this.lastPoint, point);
    }
    this.lastPoint = point;
    this.render();
  }

  onPointerUp(e) {
    if (!this.isPointerDown) return;
    e?.preventDefault?.();
    e?.stopPropagation?.();
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
    this.shapeDraft = null;
    this.lassoPoints = [];
    this.syncToNode();
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
    this.ensureWorldBounds(rect.x + rect.width, rect.y + rect.height, 128);
    this.ensureWorldBounds(rect.x, rect.y, 128);
    const ctx = layer.canvas.getContext("2d");
    ctx.save();
    ctx.globalAlpha = this.opacity;
    ctx.globalCompositeOperation = this.shapeComposite;
    ctx.fillStyle = layer.type === "mask" ? "#fff" : this.fg;
    ctx.fillRect(rect.x - this.origin.x, rect.y - this.origin.y, rect.width, rect.height);
    ctx.restore();
  }

  appendLassoPoint(point) {
    const last = this.lassoPoints[this.lassoPoints.length - 1];
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < Math.max(1, 2 / this.view.scale)) return;
    this.lassoPoints.push(point);
  }

  commitLassoShape() {
    const layer = this.activeLayer;
    if (!layer || layer.locked || this.lassoPoints.length < 3) return;
    const bounds = this.lassoPoints.reduce((acc, p) => ({
      minX: Math.min(acc.minX, p.x),
      minY: Math.min(acc.minY, p.y),
      maxX: Math.max(acc.maxX, p.x),
      maxY: Math.max(acc.maxY, p.y),
    }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    this.ensureWorldBounds(bounds.maxX, bounds.maxY, 128);
    this.ensureWorldBounds(bounds.minX, bounds.minY, 128);
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
  }

  cloneCanvas(canvas) {
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext("2d").drawImage(canvas, 0, 0);
    return copy;
  }

  moveActiveLayerPixels(dx, dy) {
    const layer = this.activeLayer;
    if (!layer || !this.dragStart?.layerCanvas) return;
    const ctx = layer.canvas.getContext("2d");
    ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    ctx.drawImage(this.dragStart.layerCanvas, Math.round(dx), Math.round(dy));
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
    let left = box.x;
    let right = box.x + box.width;
    let top = box.y;
    let bottom = box.y + box.height;
    if (handle.includes("w")) left = point.x;
    if (handle.includes("e")) right = point.x;
    if (handle.includes("n")) top = point.y;
    if (handle.includes("s")) bottom = point.y;
    if (right - left < 64) handle.includes("w") ? left = right - 64 : right = left + 64;
    if (bottom - top < 64) handle.includes("n") ? top = bottom - 64 : bottom = top + 64;
    let width = this.roundToMultiple(Math.max(64, right - left), grid);
    let height = this.roundToMultiple(Math.max(64, bottom - top), grid);
    if (handle.includes("w")) left = right - width;
    else right = left + width;
    if (handle.includes("n")) top = bottom - height;
    else bottom = top + height;
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
    const screen = this.canvasPointFromEvent(e);
    const before = this.worldFromCanvasPoint(screen);
    const factor = e.deltaY > 0 ? 0.92 : 1.087;
    this.view.scale = Math.min(8, Math.max(0.08, this.view.scale * factor));
    this.view.x = screen.x - before.x * this.view.scale;
    this.view.y = screen.y - before.y * this.view.scale;
    this.render();
  }

  ensureWorldBounds(x, y, padding = 256) {
    let left = this.origin.x;
    let top = this.origin.y;
    let right = this.origin.x + this.size.width;
    let bottom = this.origin.y + this.size.height;
    let changed = false;
    if (x < left + padding) { left = x - padding; changed = true; }
    if (y < top + padding) { top = y - padding; changed = true; }
    if (x > right - padding) { right = x + padding; changed = true; }
    if (y > bottom - padding) { bottom = y + padding; changed = true; }
    if (!changed) return;
    const newW = Math.ceil(right - left);
    const newH = Math.ceil(bottom - top);
    for (const layer of this.layers) {
      const next = document.createElement("canvas");
      next.width = newW;
      next.height = newH;
      next.getContext("2d").drawImage(layer.canvas, this.origin.x - left, this.origin.y - top);
      layer.canvas = next;
    }
    this.origin = { x: left, y: top };
    this.size = { width: newW, height: newH };
  }

  drawStroke(a, b) {
    const layer = this.tool === "mask" ? this.getOrCreateMaskLayer() : this.activeLayer;
    if (!layer || layer.locked) return;
    this.ensureWorldBounds(b.x, b.y, this.brushSize * 2);
    const start = this.alignCoordForTool(a, this.brushSize);
    const end = this.alignCoordForTool(b, this.brushSize);
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
  }

  getOrCreateMaskLayer() {
    let layer = this.activeLayer?.type === "mask" ? this.activeLayer : this.layers.find((l) => l.type === "mask");
    if (!layer) layer = this.addLayer("mask");
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
    ctx.imageSmoothingEnabled = false;
    for (const layer of [...this.layers].reverse()) {
      if (!layer.visible) continue;
      ctx.save();
      if (layer.type === "mask") {
        this.drawMaskLayer(ctx, layer);
      } else {
        ctx.globalAlpha = layer.opacity;
        ctx.drawImage(layer.canvas, this.origin.x, this.origin.y);
      }
      ctx.restore();
    }
    this.drawShapeDraft(ctx);
    this.drawLassoDraft(ctx);
    this.drawBbox(ctx);
    this.drawToolPreview(ctx);
    ctx.restore();
    this.hud.innerHTML = `<span class="vnccs-uc-chip">${this.tool}</span><span class="vnccs-uc-chip">${Math.round(this.view.scale * 100)}%</span><span class="vnccs-uc-chip">${this.bbox.width}×${this.bbox.height}</span>`;
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
    const tint = document.createElement("canvas");
    tint.width = layer.canvas.width;
    tint.height = layer.canvas.height;
    const tintCtx = tint.getContext("2d");
    tintCtx.drawImage(layer.canvas, 0, 0);
    tintCtx.globalCompositeOperation = "source-in";
    tintCtx.fillStyle = MASK_OVERLAY_COLOR;
    tintCtx.globalAlpha = layer.opacity;
    tintCtx.fillRect(0, 0, tint.width, tint.height);
    ctx.drawImage(tint, this.origin.x, this.origin.y);
  }

  drawBbox(ctx) {
    ctx.save();
    if (this.tool === "bbox") this.drawBboxOverlay(ctx);
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
    const rect = this.stageWrap.getBoundingClientRect();
    const x = -this.view.x / this.view.scale;
    const y = -this.view.y / this.view.scale;
    return {
      x,
      y,
      width: rect.width / this.view.scale,
      height: rect.height / this.view.scale,
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
    ctx.globalAlpha = this.opacity;
    ctx.fillStyle = this.shapeComposite === "destination-out" ? "rgba(255,255,255,.75)" : this.fg;
    ctx.strokeStyle = "rgba(212,216,234,.9)";
    ctx.lineWidth = 1 / this.view.scale;
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
    const point = this.alignCoordForTool(this.hoverPoint, this.brushSize);
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
    ctx.arc(this.hoverPoint.x, this.hoverPoint.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,.82)";
    ctx.beginPath();
    ctx.arc(this.hoverPoint.x, this.hoverPoint.y, radius + 1 / this.view.scale, 0, Math.PI * 2);
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
      row.innerHTML = `
        <button class="vnccs-uc-icon" title="Visible">${layer.visible ? "●" : "○"}</button>
        <div><div class="vnccs-uc-layer-name">${this._escape(layer.name)}</div><div class="vnccs-uc-layer-type">${layer.type}</div></div>
        <button class="vnccs-uc-icon" title="Lock">${layer.locked ? "◆" : "◇"}</button>
        <button class="vnccs-uc-icon danger" title="Delete">×</button>`;
      row.addEventListener("click", () => {
        this.activeLayerId = layer.id;
        this.renderLayerList();
      });
      row.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const next = prompt("Layer name", layer.name);
        if (next !== null) {
          layer.name = String(next).trim() || layer.name;
          this.renderLayerList();
          this.syncToNode();
        }
      });
      row.children[0].addEventListener("click", (e) => { e.stopPropagation(); layer.visible = !layer.visible; this.renderLayerList(); this.render(); this.syncToNode(); });
      row.children[2].addEventListener("click", (e) => { e.stopPropagation(); layer.locked = !layer.locked; this.renderLayerList(); this.syncToNode(); });
      row.children[3].addEventListener("click", (e) => { e.stopPropagation(); this.deleteLayer(layer.id); });
      this.layerList.append(row);
    }
    this.syncActiveLayerControls();
  }

  syncActiveLayerControls() {
    const opacity = this.container.querySelector('[data-control="layerOpacity"]');
    if (opacity && this.activeLayer) opacity.value = this.activeLayer.opacity;
  }

  deleteLayer(id) {
    if (this.layers.length <= 1) return;
    this.layers = this.layers.filter((l) => l.id !== id);
    if (this.activeLayerId === id) this.activeLayerId = this.layers[0]?.id || null;
    this.renderLayerList();
    this.render();
    this.syncToNode();
  }

  duplicateActiveLayer() {
    const layer = this.activeLayer;
    if (!layer) return;
    const copy = {
      id: uid(),
      name: `${layer.name} Copy`,
      type: layer.type,
      visible: layer.visible,
      locked: false,
      opacity: layer.opacity,
      canvas: this._createCanvas(),
    };
    copy.canvas.getContext("2d").drawImage(layer.canvas, 0, 0);
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
    const [layer] = this.layers.splice(index, 1);
    this.layers.splice(nextIndex, 0, layer);
    this.renderLayerList();
    this.render();
    this.syncToNode();
  }

  async importFile(file) {
    if (!file) return;
    const img = await this.loadImage(URL.createObjectURL(file));
    const layer = this.addLayer("raster", file.name.replace(/\.[^.]+$/, ""));
    this.ensureWorldBounds(this.bbox.x + img.width, this.bbox.y + img.height, 128);
    const ctx = layer.canvas.getContext("2d");
    ctx.drawImage(img, this.bbox.x - this.origin.x, this.bbox.y - this.origin.y);
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
    const rect = this.stageWrap.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const pad = 64;
    if (allowZoomOut) {
      const fitScale = Math.min(
        (rect.width - pad * 2) / this.bbox.width,
        (rect.height - pad * 2) / this.bbox.height,
        this.view.scale
      );
      this.view.scale = Math.max(0.08, fitScale);
    }
    this.view.x = rect.width / 2 - (this.bbox.x + this.bbox.width / 2) * this.view.scale;
    this.view.y = rect.height / 2 - (this.bbox.y + this.bbox.height / 2) * this.view.scale;
  }

  exportCanvas(type) {
    const out = document.createElement("canvas");
    out.width = Math.max(64, Math.round(this.bbox.width));
    out.height = Math.max(64, Math.round(this.bbox.height));
    const ctx = out.getContext("2d");
    if (type === "image") {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, out.width, out.height);
    }
    for (const layer of [...this.layers].reverse()) {
      if (!layer.visible) continue;
      if (type === "image" && layer.type !== "raster") continue;
      if (type === "mask" && layer.type !== "mask") continue;
      ctx.save();
      ctx.globalAlpha = type === "image" ? layer.opacity : 1;
      ctx.drawImage(
        layer.canvas,
        this.bbox.x - this.origin.x,
        this.bbox.y - this.origin.y,
        out.width,
        out.height,
        0,
        0,
        out.width,
        out.height
      );
      ctx.restore();
    }
    return out.toDataURL("image/png");
  }

  async draw() {
    if (!this.settings.ckpt_name) {
      this.setStatus("Select a checkpoint first", true);
      return;
    }
    const mode = this.hasMaskContent() ? "inpaint" : "img2img";
    this.setStatus(`Drawing ${mode}...`);
    this.drawBtn.disabled = true;
    try {
      const res = await fetch("/vnccs/unicanvas/draw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          image: this.exportCanvas("image"),
          mask: this.exportCanvas("mask"),
          bbox: this.bbox,
          settings: this.settings,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      const url = this.imageResultToURL(data.image);
      this.staging = { url, bbox: { ...this.bbox }, image: data.image };
      this.preview.src = url;
      this.setStatus("DRAW complete");
    } catch (err) {
      this.setStatus(`DRAW failed: ${err.message || err}`, true);
    } finally {
      this.drawBtn.disabled = false;
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
    if (!this.staging) return;
    const img = await this.loadImage(this.staging.url);
    const layer = this.addLayer("raster", "DRAW Result");
    this.ensureWorldBounds(this.staging.bbox.x + this.staging.bbox.width, this.staging.bbox.y + this.staging.bbox.height, 128);
    layer.canvas.getContext("2d").drawImage(img, this.staging.bbox.x - this.origin.x, this.staging.bbox.y - this.origin.y, this.staging.bbox.width, this.staging.bbox.height);
    this.render();
    this.syncToNode();
  }

  setStatus(text, isError = false) {
    this.status.textContent = text;
    this.status.style.color = isError ? "var(--uc-danger)" : "var(--uc-muted)";
  }

  syncPromptControls() {
    this.container.querySelectorAll("[data-setting]").forEach((el) => {
      const key = el.dataset.setting;
      if (key in this.settings) el.value = this.settings[key];
    });
  }

  syncToNode() {
    if (this._isRestoring) return;
    const widget = this.node.widgets?.find((w) => w.name === "unicanvas_state");
    if (!widget) return;
    const state = {
      version: 1,
      origin: this.origin,
      size: this.size,
      bbox: this.bbox,
      settings: this.settings,
      layers: this.layers.map((l) => this.serializeLayer(l)),
      activeLayerId: this.activeLayerId,
    };
    widget.value = JSON.stringify(state);
    widget.callback?.(widget.value);
    app.graph?.setDirtyCanvas?.(true, true);
  }

  serializeLayer(layer) {
    const crop = this.getCanvasAlphaBounds(layer.canvas);
    const payload = {
      id: layer.id,
      name: layer.name,
      type: layer.type,
      visible: layer.visible,
      locked: layer.locked,
      opacity: layer.opacity,
      crop,
      dataURL: null,
    };
    if (!crop) return payload;
    const out = document.createElement("canvas");
    out.width = crop.width;
    out.height = crop.height;
    out.getContext("2d").drawImage(layer.canvas, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    payload.dataURL = out.toDataURL("image/png");
    return payload;
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
      const state = JSON.parse(widget.value);
      if (state?.version !== 1 || !Array.isArray(state.layers)) return;
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
          canvas: this._createCanvas(),
        };
        if (item.dataURL) {
          const img = await this.loadImage(item.dataURL);
          if (item.crop) {
            layer.canvas.getContext("2d").drawImage(img, item.crop.x || 0, item.crop.y || 0);
          } else {
            layer.canvas.getContext("2d").drawImage(img, 0, 0);
          }
        }
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

  dispose() {
    this.resizeObserver?.disconnect();
  }
}

app.registerExtension({
  name: "VNCCS.UniCanvas",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "VNCCS_UniCanvas") return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      this.setSize([1040, 720]);
      this.uniCanvasWidget = new UniCanvasWidget(this);
      const domWidget = this.addDOMWidget("unicanvas_ui", "ui", this.uniCanvasWidget.container, {
        serialize: false,
        hideOnZoom: false,
      });
      this.uniCanvasDOMWidget = domWidget;
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
      clearTimeout(this._vnccsUniCanvasResizeTimer);
      this._vnccsUniCanvasResizeTimer = setTimeout(() => this.uniCanvasWidget?.resize(), 40);
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      setTimeout(async () => {
        if (!this.uniCanvasWidget) return;
        this.uniCanvasWidget._isRestoring = true;
        await this.uniCanvasWidget._loadFromNode();
        this.uniCanvasWidget._isRestoring = false;
        this.uniCanvasWidget.renderLayerList();
        this.uniCanvasWidget.resize();
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
