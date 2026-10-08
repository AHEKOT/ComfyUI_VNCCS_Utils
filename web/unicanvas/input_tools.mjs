/**
 * VNCCS UniCanvas input tools (design spec sections 8.1 and 8.2).
 *
 *  - 8.1 Alt + right-button drag resizes the brush: dragging right grows it,
 *    dragging left shrinks it (about 0.5 px radius per pointer px). Feedback is
 *    live: the tool preview circle, a floating px badge and the brushSize
 *    slider all sync during the drag; pointerup commits one history entry.
 *  - 8.2 A plain right-button hold (no Alt) opens a four-sector radial HUD at
 *    the cursor: up = size, right = opacity, down = hardness, left = foreground
 *    color. After a sector is picked, dragging adjusts that value live and the
 *    release commits it. Alt held means the HUD never opens.
 *  - brushHardness is a new brush-engine setting: values below 1 render the
 *    stroke as radial-gradient stamps (soft edges) with immediate effect.
 *
 * The installer wraps a small number of UniCanvasWidget methods and adds
 * canvas-local listeners, so the shared vnccs_unicanvas.js only needs an
 * import and one install call (kept merge-friendly for parallel branches).
 */

export const BRUSH_FAMILY_TOOLS = new Set(["brush", "eraser", "mask"]);
export const BRUSH_SIZE_MIN = 1;
export const BRUSH_SIZE_MAX = 220;
// Brush gestures move the brush RADIUS at 0.5 px per pointer px (spec 8.1);
// brushSize is the stroke width, so it changes at twice that rate.
export const RADIAL_HUD_SIZE_SENSITIVITY = 0.5;
export const DEFAULT_BRUSH_HARDNESS = 1;
export const RADIAL_HUD_SECTOR_THRESHOLD_PX = 8;
export const RADIAL_HUD_VALUE_SENSITIVITY = 0.005;
export const RADIAL_HUD_HUE_SENSITIVITY = 0.5;

export const RADIAL_HUD_SECTORS = Object.freeze([
  { direction: "up", key: "size", label: "Size" },
  { direction: "right", key: "opacity", label: "Opacity" },
  { direction: "down", key: "hardness", label: "Hardness" },
  { direction: "left", key: "color", label: "Foreground color" },
]);

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value) {
  return clamp(Number.isFinite(value) ? value : 0, 0, 1);
}

function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!match) return { r: 255, g: 255, b: 255 };
  const value = parseInt(match[1], 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function rgbToHsl({ r, g, b }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l: lightness };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue;
  if (max === rn) hue = ((gn - bn) / delta) % 6;
  else if (max === gn) hue = (bn - rn) / delta + 2;
  else hue = (rn - gn) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return { h: hue, s: saturation, l: lightness };
}

function hueToRgbChannel(p, q, t) {
  let value = t;
  if (value < 0) value += 1;
  if (value > 1) value -= 1;
  if (value < 1 / 6) return p + (q - p) * 6 * value;
  if (value < 1 / 2) return q;
  if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
  return p;
}

function hslToHex(h, s, l) {
  const hue = (((h % 360) + 360) % 360) / 360;
  let r;
  let g;
  let b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hueToRgbChannel(p, q, hue + 1 / 3);
    g = hueToRgbChannel(p, q, hue);
    b = hueToRgbChannel(p, q, hue - 1 / 3);
  }
  const toHex = (value) => Math.round(clamp01(value) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function rotateFgHue(hex, deltaDegrees) {
  const { h, s, l } = rgbToHsl(hexToRgb(hex));
  return hslToHex(h + deltaDegrees, s, l);
}

function formatHudValue(key, value) {
  if (key === "size") return `${Math.round(value)} px`;
  if (key === "color") return String(value);
  return `${Math.round(clamp01(value) * 100)}%`;
}

function syncBrushControlInputs(uc) {
  const panel = uc.toolSettings;
  if (!panel) return;
  const values = {
    brushSize: String(uc.brushSize),
    opacity: String(uc.opacity),
    brushHardness: String(clamp01(uc.brushHardness)),
    fg: uc.fg,
  };
  for (const [control, value] of Object.entries(values)) {
    const input = panel.querySelector(`input[data-control="${control}"]`);
    if (input instanceof HTMLInputElement && input.value !== value) input.value = value;
  }
}

function captureToolSettings(uc) {
  return uc.createHistorySnapshot(false);
}

function commitToolSettings(uc, before, message) {
  if (!before) return;
  uc.pushHistoryEntry(before);
  uc.syncLightStateToWidget();
  if (message) uc.setStatus(message);
}

function toolSettingsChanged(uc, before) {
  return Boolean(before)
    && (before.brushSize !== uc.brushSize
      || before.opacity !== uc.opacity
      || before.brushHardness !== uc.brushHardness
      || before.fg !== uc.fg);
}

function openRadialHud(uc, e) {
  const state = uc._vnccsInputTools;
  state.gesture = {
    kind: "hud",
    pointerId: e.pointerId,
    startClientX: e.clientX,
    startClientY: e.clientY,
    anchor: uc.canvasPointFromEvent(e),
    lastScreen: uc.canvasPointFromEvent(e),
    values: { brushSize: uc.brushSize, opacity: uc.opacity, brushHardness: uc.brushHardness, fg: uc.fg },
    before: captureToolSettings(uc),
    sector: null,
  };
}

function pickHudSector(dx, dy) {
  const threshold = RADIAL_HUD_SECTOR_THRESHOLD_PX;
  if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return null;
  if (Math.abs(dy) >= Math.abs(dx)) return RADIAL_HUD_SECTORS.find((sector) => sector.direction === (dy < 0 ? "up" : "down")) || null;
  return RADIAL_HUD_SECTORS.find((sector) => sector.direction === (dx > 0 ? "right" : "left")) || null;
}

function applyHudSectorValue(uc, gesture, dx) {
  const sector = gesture.sector;
  if (!sector) return;
  const start = gesture.values;
  if (sector.key === "size") {
    uc.brushSize = Math.round(clamp(start.brushSize + dx * RADIAL_HUD_SIZE_SENSITIVITY * 2, BRUSH_SIZE_MIN, BRUSH_SIZE_MAX));
  } else if (sector.key === "opacity") {
    uc.opacity = clamp01(start.opacity + dx * RADIAL_HUD_VALUE_SENSITIVITY);
  } else if (sector.key === "hardness") {
    uc.brushHardness = clamp01(start.brushHardness + dx * RADIAL_HUD_VALUE_SENSITIVITY);
  } else if (sector.key === "color") {
    uc.fg = rotateFgHue(start.fg, dx * RADIAL_HUD_HUE_SENSITIVITY);
  }
  syncBrushControlInputs(uc);
}

function updateGesture(uc, e) {
  const gesture = uc._vnccsInputTools.gesture;
  if (!gesture || e.pointerId !== gesture.pointerId) return;
  gesture.lastScreen = uc.canvasPointFromEvent(e);
  // Keep the tool preview circle under the cursor while the gesture runs.
  uc.hoverPoint = uc.worldFromCanvasPoint(gesture.lastScreen);
  const dx = e.clientX - gesture.startClientX;
  if (gesture.kind === "hud") {
    const dy = e.clientY - gesture.startClientY;
    if (!gesture.sector) gesture.sector = pickHudSector(dx, dy);
    if (gesture.sector) applyHudSectorValue(uc, gesture, dx);
    // The live value readout is drawn in the HUD center (drawRadialHud).
  }
  uc.updateToolPreviewOverlay();
}

function commitGesture(uc) {
  const state = uc._vnccsInputTools;
  const gesture = state.gesture;
  state.gesture = null;
  if (!gesture) return;
  if (!toolSettingsChanged(uc, gesture.before)) {
    uc.updateToolPreviewOverlay();
    return;
  }
  let message = "";
  if (gesture.sector) {
    const key = gesture.sector.key;
    const value = key === "color" ? uc.fg : (key === "size" ? uc.brushSize : (key === "opacity" ? uc.opacity : uc.brushHardness));
    message = `[VNCCS UniCanvas] ${gesture.sector.label} ${formatHudValue(key, value)}`;
  }
  commitToolSettings(uc, gesture.before, message);
  uc.updateToolPreviewOverlay();
}

function stampSoftCircle(ctx, x, y, radius, hardness, rgb) {
  const inner = clamp01(hardness) * radius;
  const gradient = ctx.createRadialGradient(x, y, inner, x, y, Math.max(radius, inner + 0.001));
  gradient.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},1)`);
  gradient.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawSoftStampStroke(uc, a, b) {
  const layer = uc.tool === "mask" ? uc.getOrCreateMaskLayer() : uc.activeLayer;
  if (!layer || layer.locked) return;
  if (!uc.ensureVisibleWorldBounds(Math.max(128, uc.brushSize * 2))) return;
  const start = uc.alignCoordForTool(a, uc.brushSize);
  const end = uc.alignCoordForTool(b, uc.brushSize);
  if (!uc.ensureStrokeWorldBounds(start, end, uc.brushSize)) return;
  uc.materializeRasterLayerForEditing(layer);
  const strokeBounds = uc.getStrokeCanvasBounds(layer, start, end, uc.brushSize);
  const radius = uc.brushSize / 2;
  const hardness = clamp01(uc.brushHardness);
  const ctx = layer.canvas.getContext("2d");
  let rgb = hexToRgb(uc.fg);
  ctx.save();
  ctx.globalAlpha = uc.opacity;
  if (uc.tool === "eraser") {
    ctx.globalCompositeOperation = "destination-out";
    rgb = { r: 0, g: 0, b: 0 };
  } else if (layer.type === "mask" || uc.tool === "mask") {
    ctx.globalCompositeOperation = "source-over";
    rgb = { r: 255, g: 255, b: 255 };
  } else {
    ctx.globalCompositeOperation = "source-over";
  }
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  const spacing = Math.max(1, radius * 0.25);
  const steps = Math.max(1, Math.ceil(length / spacing));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    stampSoftCircle(ctx, start.x - uc.origin.x + dx * t, start.y - uc.origin.y + dy * t, radius, hardness, rgb);
  }
  ctx.restore();
  uc.markLayerPixelsChanged(layer, strokeBounds, uc.tool !== "eraser");
  if (uc.tool in uc.lastDrawPointByTool) uc.lastDrawPointByTool[uc.tool] = { x: b.x, y: b.y };
}

function drawInputToolsOverlay(uc) {
  const gesture = uc._vnccsInputTools?.gesture;
  const canvas = uc.previewCanvas;
  if (!gesture || !canvas) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (gesture.kind === "hud") {
    drawRadialHud(ctx, uc, gesture);
  }
}

function drawRadialHud(ctx, uc, gesture) {
  const { x, y } = gesture.anchor;
  const innerRadius = 34;
  const outerRadius = 78;
  ctx.save();
  for (const sector of RADIAL_HUD_SECTORS) {
    const centerAngle = { up: -Math.PI / 2, right: 0, down: Math.PI / 2, left: Math.PI }[sector.direction];
    const selected = gesture.sector?.key === sector.key;
    ctx.beginPath();
    ctx.arc(x, y, outerRadius, centerAngle - Math.PI / 4, centerAngle + Math.PI / 4);
    ctx.arc(x, y, innerRadius, centerAngle + Math.PI / 4, centerAngle - Math.PI / 4, true);
    ctx.closePath();
    ctx.fillStyle = selected ? "rgba(255,143,163,.45)" : "rgba(10,10,15,.78)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.22)";
    ctx.stroke();
    const labelRadius = (innerRadius + outerRadius) / 2;
    const labelX = x + Math.cos(centerAngle) * labelRadius;
    const labelY = y + Math.sin(centerAngle) * labelRadius;
    ctx.fillStyle = "#e8e8f0";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(sector.label, labelX, labelY);
  }
  ctx.fillStyle = "rgba(10,10,15,.85)";
  ctx.beginPath();
  ctx.arc(x, y, innerRadius - 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#e8e8f0";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (gesture.sector) {
    const key = gesture.sector.key;
    const value = key === "color" ? uc.fg : (key === "size" ? uc.brushSize : (key === "opacity" ? uc.opacity : uc.brushHardness));
    ctx.fillText(formatHudValue(key, value), x, y);
  } else {
    ctx.fillText("drag", x, y);
  }
  ctx.restore();
}

export function installUniCanvasInputTools(uc) {
  if (!uc || uc._vnccsInputToolsInstalled) return uc;
  uc._vnccsInputToolsInstalled = true;
  if (!Number.isFinite(uc.brushHardness)) uc.brushHardness = DEFAULT_BRUSH_HARDNESS;
  uc._vnccsInputTools = { gesture: null };

  const originalDrawStroke = uc.drawStroke;
  uc.drawStroke = (a, b) => {
    if (uc.brushHardness >= 1) return Reflect.apply(originalDrawStroke, uc, [a, b]);
    return drawSoftStampStroke(uc, a, b);
  };

  const originalDrawToolPreview = uc.drawToolPreview;
  uc.drawToolPreview = (ctx) => {
    if (uc.brushHardness >= 1 || !uc.hoverPoint || uc.hoverPointerType !== "mouse" || !BRUSH_FAMILY_TOOLS.has(uc.tool)) {
      return Reflect.apply(originalDrawToolPreview, uc, [ctx]);
    }
    const radius = uc.brushSize / 2;
    const point = uc.hoverPoint;
    const rgb = uc.tool === "eraser" ? { r: 255, g: 71, b: 87 } : (uc.tool === "mask" ? { r: 255, g: 255, b: 255 } : hexToRgb(uc.fg));
    ctx.save();
    ctx.globalAlpha = uc.isPointerDown ? 0 : 0.22;
    stampSoftCircle(ctx, point.x, point.y, radius, clamp01(uc.brushHardness), rgb);
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1 / uc.view.scale;
    ctx.strokeStyle = "rgba(0,0,0,1)";
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  };

  const originalUpdateToolPreviewOverlay = uc.updateToolPreviewOverlay;
  uc.updateToolPreviewOverlay = () => {
    Reflect.apply(originalUpdateToolPreviewOverlay, uc, []);
    drawInputToolsOverlay(uc);
  };

  const originalRenderToolSettings = uc.renderToolSettings;
  uc.renderToolSettings = () => {
    Reflect.apply(originalRenderToolSettings, uc, []);
    const panel = uc.toolSettings;
    if (!panel || !panel.classList.contains("visible") || !BRUSH_FAMILY_TOOLS.has(uc.tool)) return;
    if (panel.querySelector('input[data-control="brushHardness"]')) return;
    panel.insertAdjacentHTML("beforeend", `<label class="vnccs-uc-tool-setting"><span class="vnccs-uc-tool-setting-label">Hardness</span><input class="vnccs-uc-range" type="range" min="0" max="1" step="0.01" value="${clamp01(uc.brushHardness)}" data-control="brushHardness"></label>`);
  };

  const originalCreateHistorySnapshot = uc.createHistorySnapshot;
  uc.createHistorySnapshot = (...args) => {
    const snapshot = Reflect.apply(originalCreateHistorySnapshot, uc, args);
    if (snapshot && typeof snapshot === "object") snapshot.brushHardness = clamp01(uc.brushHardness);
    return snapshot;
  };
  const originalRestoreHistorySnapshot = uc.restoreHistorySnapshot;
  uc.restoreHistorySnapshot = (snapshot) => {
    Reflect.apply(originalRestoreHistorySnapshot, uc, [snapshot]);
    if (snapshot && Number.isFinite(snapshot.brushHardness)) uc.brushHardness = clamp01(snapshot.brushHardness);
    uc.renderToolSettings();
  };

  uc.toolSettings.addEventListener("input", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement) || target.dataset.control !== "brushHardness") return;
    uc.recordInputHistory(target);
    uc.brushHardness = clamp01(Number(target.value));
    uc.updateToolPreviewOverlay();
  });

  uc.canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 2) return;
    if (uc._vnccsInputTools.gesture) return;
    e.preventDefault();
    e.stopPropagation();
    uc.canvas.setPointerCapture?.(e.pointerId);
    if (BRUSH_FAMILY_TOOLS.has(uc.tool)) {
      // Right-button hold opens the radial HUD - the only right-button gesture
      // (the former Alt brush-size drag was removed by request). Brush-family
      // tools only: the HUD edits size/opacity/hardness/color, which only the
      // brush family uses.
      openRadialHud(uc, e);
    }
    uc.updateToolPreviewOverlay();
  });

  uc.canvas.addEventListener("pointermove", (e) => {
    if (!uc._vnccsInputTools.gesture) return;
    e.preventDefault();
    e.stopPropagation();
    updateGesture(uc, e);
  });

  const endGesture = (e) => {
    const gesture = uc._vnccsInputTools.gesture;
    if (!gesture) return;
    if (e && gesture.pointerId !== e.pointerId) return;
    e?.preventDefault?.();
    e?.stopPropagation?.();
    // The layer menu opens only from the layer rows; a right click on the canvas is the HUD alone.
    commitGesture(uc);
    syncBrushControlInputs(uc);
  };
  uc.canvas.addEventListener("pointerup", endGesture);
  uc.canvas.addEventListener("pointercancel", endGesture);

  uc.renderToolSettings();
  return uc;
}
