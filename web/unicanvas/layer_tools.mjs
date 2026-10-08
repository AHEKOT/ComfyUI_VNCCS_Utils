/**
 * VNCCS UniCanvas layer utilities (design spec sections 10.1-10.4).
 *
 *  - 10.1 Right-clicking a layer row opens the grouped context menu: Layer
 *    (Duplicate / Move up / Move down, operating on the right-clicked layer),
 *    Content (copy the layer PNG with alpha to the clipboard, save it via the
 *    save_output route), Enhance (remove background via QI2.1 or BiRefNet, the
 *    prompt variant, color-match to the composite below), Name (auto-name) and
 *    the pose-layer entries Edit pose / Rasterize (pose layers only).
 *  - 10.2 PSD export/import live in one grouped row built by the widget's
 *    _buildDOM footer (label + Export + Import + hidden file input); this module
 *    only wires the import parse path through uc.wirePsdImport() and maps raster
 *    layers (name, visibility, opacity, blend mode) from the vendored ag-psd
 *    bundle, preserving order; anything UniCanvas cannot represent is skipped
 *    and reported in the status line.
 *  - 10.3 Background removal is one-shot with status-line progress and a
 *    single layerPixels history entry; the returned alpha is applied with
 *    destination-in so the layer keeps its own colors.
 *  - 10.4 Color match compares the active layer against the composite of the
 *    visible layers below it and previews live on a scratch copy while the
 *    strength slider is dragged; the release commits one history entry and
 *    stale previews are dropped (newest value wins).
 *
 * Like input_tools.mjs, everything is installed onto the
 * widget instance so the shared vnccs_unicanvas.js only needs an import and
 * one install call.
 */

import { clamp } from "./input_tools.mjs";
import { installCustomSelects } from "../shared/custom_select.mjs";
import { REMOVE_BG_DEFAULT_PROMPT, removeBgEditSettings, resolveRemoveBgSelection } from "./remove_bg.mjs";
import { autoNameLayers } from "./naming.mjs";

// Small inline stroke icons (14px in the menu): UI_ICONS lives inside
// vnccs_unicanvas.js and is not exported, so the menu owns its own set.
const MENU_ICONS = {
  duplicate: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4H5.5A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/></svg>`,
  up: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>`,
  down: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`,
  clipboard: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>`,
  image: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m5 18 5-5 3 3 3-3 3 3"/></svg>`,
  person: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7" r="3.4"/><path d="M5.5 20.5a6.5 6.5 0 0 1 13 0"/></svg>`,
  personSparkle: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9.5" cy="7.5" r="3.2"/><path d="M3.5 20a6 6 0 0 1 12 0"/><path d="M18 3.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z"/></svg>`,
  droplet: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5s6 6.5 6 10a6 6 0 0 1-12 0c0-3.5 6-10 6-10z"/></svg>`,
  tag: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 11V4.5a1 1 0 0 1 1-1H11l9.5 9.5a1 1 0 0 1 0 1.4l-6.6 6.6a1 1 0 0 1-1.4 0L3.5 11z"/><circle cx="8" cy="8" r="1.3"/></svg>`,
  pose: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2.2"/><path d="M12 7.2v6.3"/><path d="m12 9.2-4.5 2.3M12 9.2l4.5 2.3"/><path d="m12 13.5-3.2 6M12 13.5l3.2 6"/></svg>`,
  raster: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9.3h16M4 14.6h16M9.3 4v16M14.6 4v16"/></svg>`,
};

export const LAYER_MENU_ITEMS = Object.freeze([
  { id: "duplicate", label: "Duplicate layer", group: "Layer", icon: MENU_ICONS.duplicate },
  { id: "move-up", label: "Move up", group: "Layer", icon: MENU_ICONS.up },
  { id: "move-down", label: "Move down", group: "Layer", icon: MENU_ICONS.down },
  { id: "copy-clipboard", label: "Copy to clipboard", group: "Content", icon: MENU_ICONS.clipboard },
  { id: "save-image", label: "Save image", group: "Content", icon: MENU_ICONS.image },
  { id: "remove-bg", label: "Remove background", group: "Enhance", icon: MENU_ICONS.person },
  { id: "remove-bg-prompt", label: "Remove background (prompt)...", group: "Enhance", icon: MENU_ICONS.personSparkle, editOnly: true },
  { id: "color-match", label: "Color match to below", group: "Enhance", icon: MENU_ICONS.droplet },
  { id: "auto-name", label: "Auto-name", group: "Name", icon: MENU_ICONS.tag },
  { id: "edit-pose", label: "Edit pose", group: "Pose", icon: MENU_ICONS.pose, poseOnly: true },
  { id: "rasterize", label: "Rasterize", group: "Pose", icon: MENU_ICONS.raster, poseOnly: true },
]);

export const PSD_SKIP_REASONS = Object.freeze({
  clipping: "clipping mask",
  adjustment: "adjustment layer",
  effects: "layer effects",
  noRaster: "text/vector/smart-object layer without raster data",
});

export const PSD_BLEND_MODE_MAP = Object.freeze({
  normal: "source-over",
  dissolve: "source-over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  colordodge: "color-dodge",
  colorburn: "color-burn",
  hardlight: "hard-light",
  softlight: "soft-light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
});

export const COLOR_MATCH_METHODS = Object.freeze([
  "local_lab",
  "mkl",
  "hm",
  "reinhard",
  "mvgd",
  "hm-mvgd-hm",
  "hm-mkl-hm",
  "reinhard_lab_gpu",
]);
export const COLOR_MATCH_STRENGTH_MAX = 10;
export const COLOR_MATCH_ROUTE = "/vnccs/unicanvas/color_match";
export const REMOVE_BG_ROUTE = "/vnccs/unicanvas/remove_bg";
export const SAVE_OUTPUT_ROUTE = "/vnccs/unicanvas/save_output";
export const POSE_TOOLS_UNAVAILABLE = "[VNCCS UniCanvas] Pose tools are not available.";

function normalizePsdOpacity(value) {
  const opacity = Number(value);
  if (!Number.isFinite(opacity)) return 1;
  return clamp(opacity > 1 ? opacity / 255 : opacity, 0, 1);
}

function psdBlendModeToComposite(blendMode) {
  const key = String(blendMode || "normal").toLowerCase().replace(/[\s_-]/g, "");
  return PSD_BLEND_MODE_MAP[key] || "source-over";
}

function psdEntryToCanvas(entry) {
  if (entry.canvas) return entry.canvas;
  const data = entry.imageData;
  const width = data.width || entry.right - entry.left;
  const height = data.height || entry.bottom - entry.top;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext("2d");
  const clamped = data.data instanceof Uint8ClampedArray ? data.data : new Uint8ClampedArray(data.data);
  ctx.putImageData(new ImageData(clamped, canvas.width, canvas.height), 0, 0);
  return canvas;
}

function collectPsdRasterLayers(entries, imported, skipped) {
  for (const entry of entries || []) {
    if (!entry || typeof entry !== "object") continue;
    if (Array.isArray(entry.children)) {
      // Groups are structural: keep walking into them for their raster children.
      collectPsdRasterLayers(entry.children, imported, skipped);
      continue;
    }
    const name = entry.name || "Unnamed";
    if (entry.clipped) {
      skipped.push({ reason: PSD_SKIP_REASONS.clipping, name });
      continue;
    }
    if (entry.adjustment) {
      skipped.push({ reason: PSD_SKIP_REASONS.adjustment, name });
      continue;
    }
    if (entry.effects && Object.keys(entry.effects).length) {
      skipped.push({ reason: PSD_SKIP_REASONS.effects, name });
      continue;
    }
    if (!entry.canvas && !entry.imageData) {
      skipped.push({ reason: PSD_SKIP_REASONS.noRaster, name });
      continue;
    }
    imported.push(entry);
  }
}

function formatPsdImportReport(importedCount, skipped) {
  const base = `[VNCCS UniCanvas] PSD imported ${importedCount} raster layers`;
  if (!skipped.length) return `${base}; nothing skipped.`;
  const details = skipped.map((item) => `${item.reason} "${item.name}"`).join(", ");
  return `${base}; skipped ${skipped.length}: ${details}.`;
}

function createPsdLayer(uc, entry) {
  const source = psdEntryToCanvas(entry);
  const left = Number(entry.left) || 0;
  const top = Number(entry.top) || 0;
  const worldX = uc.bbox.x + left;
  const worldY = uc.bbox.y + top;
  uc.ensureWorldBounds(worldX + source.width, worldY + source.height, 64);
  uc.ensureWorldBounds(worldX, worldY, 64);
  const layer = uc.addLayer("raster", entry.name || "PSD Layer", true, true);
  layer.visible = entry.hidden ? false : true;
  layer.opacity = normalizePsdOpacity(entry.opacity);
  layer.blendMode = psdBlendModeToComposite(entry.blendMode);
  const ctx = uc.configureImageContext(layer.canvas.getContext("2d"));
  ctx.drawImage(source, worldX - uc.origin.x, worldY - uc.origin.y);
  uc.invalidateLayerCaches(layer);
  return layer;
}

async function importPSDFile(uc, file) {
  if (!file) return;
  try {
    uc.setStatus("[VNCCS UniCanvas] Reading PSD...");
    const { readPsd } = await uc.loadAgPsd();
    if (typeof readPsd !== "function") throw new Error("ag-psd readPsd is not available");
    const buffer = await file.arrayBuffer();
    const psd = readPsd(new Uint8Array(buffer), { useImageData: true });
    const imported = [];
    const skipped = [];
    collectPsdRasterLayers(psd.children || [], imported, skipped);
    // PSD children come top-to-bottom and new layers insert at the top, so
    // create them bottom-up to preserve the PSD stacking order.
    for (const entry of [...imported].reverse()) createPsdLayer(uc, entry);
    uc.renderLayerList();
    uc.requestRender();
    uc.syncLightStateToWidget();
    uc.scheduleFullSync();
    uc.setStatus(formatPsdImportReport(imported.length, skipped));
  } catch (err) {
    uc.setStatus(`[VNCCS UniCanvas] PSD import failed: ${err.message || err}`, true);
  }
}

async function copyLayerToClipboard(uc, layer) {
  try {
    const crop = uc.getLayerAlphaBounds(layer);
    const source = crop ? uc.cloneCanvasCrop(layer.canvas, crop) : layer.canvas;
    const blob = await new Promise((resolve, reject) => {
      source.toBlob((value) => (value ? resolve(value) : reject(new Error("PNG encoding failed"))), "image/png");
    });
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    uc.setStatus("[VNCCS UniCanvas] Layer copied to clipboard.");
  } catch (err) {
    uc.setStatus(`[VNCCS UniCanvas] Clipboard copy failed: ${err.message || err}`, true);
  }
}

async function saveLayerAsImage(uc, layer) {
  try {
    uc.setStatus("[VNCCS UniCanvas] Saving layer image...");
    const crop = uc.getLayerAlphaBounds(layer);
    const source = crop ? uc.cloneCanvasCrop(layer.canvas, crop) : layer.canvas;
    // Route owned by a parallel branch: only call it (contract #1), with the
    // layer id in both the query string and the body for compatibility.
    const res = await fetch(`${SAVE_OUTPUT_ROUTE}?layer_id=${encodeURIComponent(layer.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ layer_id: layer.id, name: layer.name, image: source.toDataURL("image/png") }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    uc.setStatus(`[VNCCS UniCanvas] Layer image saved to output/ (${data.filename || layer.name}).`);
  } catch (err) {
    uc.setStatus(`[VNCCS UniCanvas] Save layer failed: ${err.message || err}`, true);
  }
}

// Backend selection mirrors the UniCanvas settings popover (remove_bg.mjs).
export { resolveRemoveBgSelection };

// SAM 3: the user picks what to keep. The SAM tool opens on this layer with SAM 3 selected:
// clicks mark the subject (Alt/right click marks background), Segment builds the mask and
// Apply removes everything else from the layer.
function startSamRemoveBackground(uc, layer) {
  if (uc.activeLayerId !== layer.id) uc.setActiveLayer(layer.id);
  uc.sam.model = "sam3";
  uc.clearSamPrompt?.();
  uc.setTool("sam");
  uc.sam.status = "Click what to keep, then Segment and Apply";
  uc.renderSamPanel?.();
  uc.setStatus("[VNCCS UniCanvas] Remove bg – SAM 3: click what to keep (Alt/right click: remove), then Segment and Apply.");
}

/**
 * The Edit model prompt for one run: the universal prompt from the settings, then the
 * user's extra instruction on its own line.
 */
export function removeBgRunSettings(settings, editModel, extraPrompt = "") {
  const edit = removeBgEditSettings(settings, editModel);
  const extra = String(extraPrompt || "").trim();
  if (!extra) return edit;
  const base = String(edit.prompt ?? REMOVE_BG_DEFAULT_PROMPT).trim();
  return { ...edit, prompt: base ? `${base}
${extra}` : extra };
}

function openRemoveBgPromptPopover(uc, layer, point) {
  uc._vnccsRemoveBgPrompt?.remove();
  const element = document.createElement("div");
  element.className = "vnccs-uc-remove-bg-prompt";
  element.style.cssText = "position:absolute; z-index:40; width:300px; padding:10px; border-radius:10px; background:rgba(20,16,30,.97); border:1px solid rgba(255,255,255,.14); color:#e8e8f0; font:11px sans-serif; display:grid; gap:8px; box-shadow:0 8px 24px rgba(0,0,0,.45);";
  const title = document.createElement("div");
  title.style.fontWeight = "600";
  title.textContent = "Remove background with prompt";
  const hint = document.createElement("div");
  hint.style.cssText = "opacity:.75; line-height:1.35;";
  hint.textContent = "Added on a new line after the Remove bg prompt from UniCanvas settings, e.g. \"Keep the sword and the shadow under her feet.\" Ctrl+Enter runs.";
  const text = document.createElement("textarea");
  text.className = "vnccs-uc-textarea";
  text.rows = 4;
  text.value = uc._vnccsLastRemoveBgPrompt || "";
  const buttons = document.createElement("div");
  buttons.style.cssText = "display:grid; grid-template-columns:1fr 1fr; gap:6px;";
  const close = () => { element.remove(); if (uc._vnccsRemoveBgPrompt === element) uc._vnccsRemoveBgPrompt = null; };
  const run = () => {
    uc._vnccsLastRemoveBgPrompt = text.value;
    close();
    removeLayerBackground(uc, layer, text.value);
  };
  const cancelBtn = uc._button("Cancel", "vnccs-uc-btn", close, "Close without running");
  const runBtn = uc._button("Remove background", "vnccs-uc-btn primary", run, "Run the Edit model with this prompt");
  buttons.append(cancelBtn, runBtn);
  text.addEventListener("keydown", (e) => {
    e.stopPropagation(); // typing must not trigger canvas shortcuts
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
    if (e.key === "Escape") close();
  });
  element.append(title, hint, text, buttons);
  uc.container.appendChild(element);
  uc._vnccsRemoveBgPrompt = element;
  if (point) placeInHost(uc.container, element, point.x - 150, point.y - 40);
  text.focus();
}

async function removeLayerBackground(uc, layer, extraPrompt = "") {
  const { method, editModel } = resolveRemoveBgSelection(uc.settings);
  if (method === "sam3") {
    if (layer.locked) {
      uc.setStatus("[VNCCS UniCanvas] Remove bg: layer is locked.", true);
      return;
    }
    startSamRemoveBackground(uc, layer);
    return;
  }
  const editModelLabel = "Qwen Image 2.1";
  const label = method === "edit"
    ? `Remove bg – Edit model (${editModelLabel})`
    : `Remove bg – ${{ birefnet: "BiRefNet", rembg: "rembg", sam3: "SAM 3" }[method] || "Edit model"}`;
  const crop = uc.getLayerAlphaBounds(layer);
  if (!crop) {
    uc.setStatus("[VNCCS UniCanvas] Remove bg: layer is empty.", true);
    return;
  }
  if (layer.locked) {
    uc.setStatus("[VNCCS UniCanvas] Remove bg: layer is locked.", true);
    return;
  }
  const before = uc.createLayerPixelSnapshot(layer);
  const source = uc.cloneCanvasCrop(layer.canvas, crop);
  uc.setStatus(`[VNCCS UniCanvas] ${label} running...`);
  try {
    const res = await fetch(REMOVE_BG_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method,
        edit_model: editModel,
        edit_settings: method === "edit" ? removeBgRunSettings(uc.settings, editModel, extraPrompt) : undefined,
        image: source.toDataURL("image/png"),
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    const alpha = await uc.loadImage(data.alpha);
    uc.materializeRasterLayerForEditing(layer);
    const ctx = layer.canvas.getContext("2d");
    ctx.save();
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(alpha, 0, 0, alpha.width, alpha.height, crop.x, crop.y, crop.width, crop.height);
    ctx.restore();
    uc.markLayerPixelsChanged(layer, crop, false);
    // One-shot operation: exactly one layerPixels history entry.
    uc.pushHistoryEntry({
      kind: "layerPixels",
      layerId: layer.id,
      before,
      after: uc.createLayerPixelSnapshot(layer),
    });
    uc.refreshLayerRow(layer.id);
    uc.requestRender();
    uc.syncLightStateToWidget();
    uc.scheduleFullSync();
    uc.setStatus(`[VNCCS UniCanvas] ${label} complete.`);
  } catch (err) {
    uc.setStatus(`[VNCCS UniCanvas] ${label} failed: ${err.message || err}`, true);
  }
}

function buildColorMatchReference(uc, layer, crop) {
  const index = uc.layers.indexOf(layer);
  const below = uc.layers.slice(index + 1).filter((item) => item.visible);
  const pool = below.length ? below : uc.layers.filter((item) => item.visible && item.id !== layer.id);
  if (!pool.length) return null;
  const canvas = document.createElement("canvas");
  canvas.width = crop.width;
  canvas.height = crop.height;
  const ctx = uc.configureImageContext(canvas.getContext("2d"));
  const worldRect = { x: uc.origin.x + crop.x, y: uc.origin.y + crop.y, width: crop.width, height: crop.height };
  for (const item of [...pool].reverse()) {
    ctx.save();
    ctx.globalAlpha = clamp(Number(item.opacity ?? 1), 0, 1);
    ctx.globalCompositeOperation = item.blendMode || "source-over";
    // Same hi-res-aware semantics as the base composite paths.
    uc.drawRasterLayerToWorldRect(ctx, item, worldRect, { x: 0, y: 0, width: crop.width, height: crop.height });
    ctx.restore();
  }
  return canvas;
}

async function requestColorMatch(targetCanvas, referenceCanvas, method) {
  // Always the full-strength result: the strength slider blends it in the browser.
  const res = await fetch(COLOR_MATCH_ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image: targetCanvas.toDataURL("image/png"),
      reference: referenceCanvas.toDataURL("image/png"),
      method,
      strength: COLOR_MATCH_STRENGTH_MAX,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data.image;
}

/** Places an absolutely positioned popover at a client point, inside the (possibly zoomed) host. */
export function placeInHost(host, element, clientX, clientY) {
  const hostRect = host.getBoundingClientRect();
  const scale = hostRect.width / (host.offsetWidth || hostRect.width || 1) || 1;
  const hostWidth = host.clientWidth || hostRect.width / scale;
  const hostHeight = host.clientHeight || hostRect.height / scale;
  const width = element.offsetWidth || 240;
  const height = element.offsetHeight || 200;
  element.style.left = `${clamp((clientX - hostRect.left) / scale, 4, Math.max(4, hostWidth - width - 4))}px`;
  element.style.top = `${clamp((clientY - hostRect.top) / scale, 4, Math.max(4, hostHeight - height - 4))}px`;
}

// Layer pixels = the original crop with the matched result laid over it at strength/10.
function composeColorMatch(uc, preview) {
  const matched = preview.matched.get(preview.method);
  if (!matched || preview.closed) return;
  const { layer, crop } = preview;
  uc.materializeRasterLayerForEditing(layer);
  const ctx = uc.configureImageContext(layer.canvas.getContext("2d"));
  ctx.save();
  ctx.clearRect(crop.x, crop.y, crop.width, crop.height);
  ctx.drawImage(preview.targetBase, crop.x, crop.y, crop.width, crop.height);
  ctx.globalAlpha = clamp(preview.strength / COLOR_MATCH_STRENGTH_MAX, 0, 1);
  ctx.globalCompositeOperation = "source-atop"; // keeps the layer's own alpha
  ctx.drawImage(matched, crop.x, crop.y, crop.width, crop.height);
  ctx.restore();
  uc.markLayerPixelsChanged(layer, crop, false);
  uc.refreshLayerRow(layer.id);
  uc.requestRender();
}

function scheduleColorMatchPreview(uc, preview) {
  if (!preview.gestureBefore) preview.gestureBefore = uc.createLayerPixelSnapshot(preview.layer);
  if (preview.rafId) return;
  // Coalesce per-frame work; the newest slider value always wins.
  preview.rafId = requestAnimationFrame(() => {
    preview.rafId = 0;
    composeColorMatch(uc, preview);
  });
}

function commitColorMatchPreview(uc, preview) {
  if (!preview.gestureBefore) return;
  if (preview.rafId) {
    cancelAnimationFrame(preview.rafId);
    preview.rafId = 0;
    composeColorMatch(uc, preview);
  }
  uc.pushHistoryEntry({
    kind: "layerPixels",
    layerId: preview.layer.id,
    before: preview.gestureBefore,
    after: uc.createLayerPixelSnapshot(preview.layer),
  });
  preview.gestureBefore = null;
  preview.commits += 1;
  uc.syncLightStateToWidget();
  uc.scheduleFullSync();
}

function finishColorMatchGesture(uc, preview) {
  // End of one gesture: exactly one layerPixels history entry.
  if (preview.loading) {
    preview.commitRequested = true;
    return;
  }
  commitColorMatchPreview(uc, preview);
}

async function loadColorMatchMethod(uc, preview, method) {
  preview.method = method;
  if (preview.matched.has(method)) {
    scheduleColorMatchPreview(uc, preview);
    finishColorMatchGesture(uc, preview);
    return;
  }
  preview.seq += 1;
  const seq = preview.seq;
  preview.loading = true;
  preview.setNote("Computing the match…");
  try {
    const resultImage = await uc.loadImage(await requestColorMatch(preview.targetBase, preview.referenceBase, method));
    if (preview.closed || seq !== preview.seq) return; // stale preview dropped; newest value wins
    preview.matched.set(method, resultImage);
    preview.loading = false;
    preview.setNote("");
    scheduleColorMatchPreview(uc, preview);
    if (preview.commitRequested || !preview.dragging) {
      preview.commitRequested = false;
      commitColorMatchPreview(uc, preview);
    }
  } catch (err) {
    if (preview.closed || seq !== preview.seq) return;
    preview.loading = false;
    preview.setNote(`Failed: ${err.message || err}`, true);
    uc.setStatus(`[VNCCS UniCanvas] Color match failed: ${err.message || err}`, true);
  }
}

function closeColorMatchPreview(uc, commit) {
  const preview = uc._vnccsColorMatch;
  if (!preview) return;
  uc._vnccsColorMatch = null;
  if (commit) commitColorMatchPreview(uc, preview);
  preview.closed = true;
  preview.seq += 1; // drop any in-flight result
  if (preview.rafId) cancelAnimationFrame(preview.rafId);
  if (!commit) {
    // Cancel: back to the pixels from before the popover opened (undoable when a step was recorded).
    const current = uc.createLayerPixelSnapshot(preview.layer);
    uc.restoreLayerPixelSnapshot(preview.layer, preview.openedBefore);
    if (preview.commits) {
      uc.pushHistoryEntry({ kind: "layerPixels", layerId: preview.layer.id, before: current, after: preview.openedBefore });
    }
    uc.refreshLayerRow(preview.layer.id);
    uc.requestRender();
    uc.syncLightStateToWidget();
    uc.scheduleFullSync();
  } else {
    uc.setStatus("[VNCCS UniCanvas] Color match applied.");
  }
  preview.element?.remove();
}

const COLOR_MATCH_LABELS = {
  local_lab: "Local – follows the colors under each part",
  reinhard_lab_gpu: "Global – LAB mean/contrast (GPU)",
};

function escapeText(value) {
  return String(value ?? "").replace(/[<>&"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[ch]);
}

function openColorMatchPopover(uc, layer, point = null) {
  closeColorMatchPreview(uc, true);
  const crop = uc.getLayerAlphaBounds(layer);
  if (!crop) {
    uc.setStatus("[VNCCS UniCanvas] Color match to below: layer is empty.", true);
    return;
  }
  const referenceBase = buildColorMatchReference(uc, layer, crop);
  if (!referenceBase) {
    uc.setStatus("[VNCCS UniCanvas] Color match to below needs a visible reference layer.", true);
    return;
  }
  const targetBase = uc.cloneCanvasCrop(layer.canvas, crop);
  const element = document.createElement("div");
  element.className = "vnccs-uc-color-match-popover";
  element.style.cssText = "position:absolute; z-index:30; width:270px; padding:10px; border-radius:10px; background:rgba(20,16,30,.97); border:1px solid rgba(255,255,255,.14); color:#e8e8f0; font:11px sans-serif; display:grid; gap:8px; box-shadow:0 8px 24px rgba(0,0,0,.45);";
  const methodOptions = COLOR_MATCH_METHODS
    .map((method) => `<option value="${method}">${COLOR_MATCH_LABELS[method] || method}</option>`)
    .join("");
  element.innerHTML = `
    <div style="font-weight:600;">Color match to below – ${escapeText(layer.name || "layer")}</div>
    <div style="opacity:.75; line-height:1.35;">Recolors this layer to fit the layers under it. The canvas updates right away – just drag the Strength slider. Apply keeps the result, Cancel restores the layer.</div>
    <label style="display:grid; gap:4px;">Method
      <select class="vnccs-uc-select" data-control="colorMatchMethod">${methodOptions}</select>
    </label>
    <label style="display:grid; gap:4px;"><span>Strength <span data-color-match-readout>10.0</span></span>
      <input class="vnccs-uc-range" type="range" min="0" max="${COLOR_MATCH_STRENGTH_MAX}" step="0.1" value="${COLOR_MATCH_STRENGTH_MAX}" data-control="colorMatchStrength">
    </label>
    <div data-color-match-note style="min-height:14px; opacity:.8;"></div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
      <button class="vnccs-uc-btn" type="button" data-control="colorMatchCancel">Cancel</button>
      <button class="vnccs-uc-btn primary" type="button" data-control="colorMatchClose">Apply</button>
    </div>`;
  uc.container.appendChild(element);
  installCustomSelects(element);
  // Next to where the menu was opened (the layer row), never over the generate panel.
  if (point) placeInHost(uc.container, element, point.x - (element.offsetWidth || 270) - 12, point.y - 20);
  else {
    const rowRect = uc.layerList?.querySelector?.(`[data-layer-id="${layer.id}"]`)?.getBoundingClientRect();
    if (rowRect) placeInHost(uc.container, element, rowRect.left - (element.offsetWidth || 270) - 12, rowRect.top);
    else { element.style.left = "24px"; element.style.top = "48px"; }
  }

  const note = element.querySelector("[data-color-match-note]");
  const preview = {
    element,
    layer,
    crop,
    targetBase,
    referenceBase,
    method: COLOR_MATCH_METHODS[0],
    matched: new Map(),
    strength: COLOR_MATCH_STRENGTH_MAX,
    seq: 0,
    rafId: 0,
    loading: false,
    dragging: false,
    closed: false,
    commitRequested: false,
    commits: 0,
    gestureBefore: null,
    openedBefore: uc.createLayerPixelSnapshot(layer),
    setNote(text, isError = false) {
      note.textContent = text;
      note.style.color = isError ? "#ff8a8a" : "";
    },
  };
  uc._vnccsColorMatch = preview;

  const methodSelect = element.querySelector('[data-control="colorMatchMethod"]');
  const strengthInput = element.querySelector('[data-control="colorMatchStrength"]');
  const readout = element.querySelector("[data-color-match-readout]");
  methodSelect.value = preview.method;

  methodSelect.addEventListener("change", () => loadColorMatchMethod(uc, preview, methodSelect.value));
  strengthInput.addEventListener("pointerdown", () => { preview.dragging = true; });
  strengthInput.addEventListener("input", () => {
    preview.strength = clamp(Number(strengthInput.value), 0, COLOR_MATCH_STRENGTH_MAX);
    readout.textContent = preview.strength.toFixed(1);
    // Realtime: blended in the browser on every input event, no server round trip.
    scheduleColorMatchPreview(uc, preview);
  });
  strengthInput.addEventListener("pointerup", () => {
    preview.dragging = false;
    finishColorMatchGesture(uc, preview);
  });
  strengthInput.addEventListener("change", () => {
    // Keyboard-only adjustments fire no pointerup; change also ends a gesture.
    preview.dragging = false;
    finishColorMatchGesture(uc, preview);
  });
  element.querySelector('[data-control="colorMatchClose"]').addEventListener("click", () => closeColorMatchPreview(uc, true));
  element.querySelector('[data-control="colorMatchCancel"]').addEventListener("click", () => closeColorMatchPreview(uc, false));
  // Show the default method at full strength straight away.
  loadColorMatchMethod(uc, preview, preview.method);
}

function closeLayerContextMenu(uc) {
  uc._vnccsLayerMenu?.remove();
  uc._vnccsLayerMenu = null;
}

function openLayerContextMenu(uc, layer, e) {
  closeLayerContextMenu(uc);
  closeColorMatchPreview(uc, true);
  const menu = document.createElement("div");
  menu.className = "vnccs-uc-layer-menu";
  // Grouped and compact: ~12px rows, ~10px uppercase dim group labels, a 14px
  // icon per item. The class name stays `.vnccs-uc-layer-menu` (shared styling
  // elsewhere grants it user-select:text; this inline cssText must not override it).
  menu.style.cssText = `position:absolute; z-index:40; min-width:180px; padding:5px; border-radius:10px; background:rgba(20,16,30,.97); border:1px solid rgba(255,255,255,.12); display:grid; gap:1px; font:11px sans-serif;`;
  let group = null;
  for (const item of LAYER_MENU_ITEMS) {
    if (item.poseOnly && layer.type !== "pose") continue;
    // Only the Edit model backend reads a prompt.
    if (item.editOnly && resolveRemoveBgSelection(uc.settings).method !== "edit") continue;
    if (item.group !== group) {
      group = item.group;
      const head = document.createElement("div");
      head.className = "vnccs-uc-layer-menu-group";
      head.textContent = group;
      head.style.cssText = "padding:5px 7px 2px; color:rgba(232,232,240,.45); font-size:10px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; user-select:none; pointer-events:none;";
      menu.appendChild(head);
    }
    const entry = document.createElement("button");
    entry.type = "button";
    entry.className = "vnccs-uc-layer-menu-item";
    entry.innerHTML = `${item.icon}<span>${escapeText(item.label)}</span>`;
    entry.style.cssText = "display:flex; align-items:center; gap:7px; text-align:left; padding:4px 7px; border:0; border-radius:6px; background:transparent; color:#e8e8f0; cursor:pointer; font:inherit; font-size:12px; line-height:1.2;";
    const icon = entry.querySelector("svg");
    if (icon) icon.style.cssText = "width:14px; height:14px; flex:0 0 auto; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round;";
    entry.addEventListener("pointerenter", () => { entry.style.background = "rgba(255,255,255,.08)"; });
    entry.addEventListener("pointerleave", () => { entry.style.background = "transparent"; });
    entry.addEventListener("click", () => {
      closeLayerContextMenu(uc);
      runLayerMenuAction(uc, layer, item, { x: e.clientX, y: e.clientY });
    });
    menu.appendChild(entry);
  }
  uc.container.appendChild(menu);
  placeInHost(uc.container, menu, e.clientX, e.clientY);
  uc._vnccsLayerMenu = menu;
}

function runLayerMenuAction(uc, layer, item, point = null) {
  if (item.id === "duplicate") return typeof uc.duplicateLayer === "function" ? uc.duplicateLayer(layer) : undefined;
  if (item.id === "move-up") return typeof uc.moveLayerOrder === "function" ? uc.moveLayerOrder(layer, -1) : undefined;
  if (item.id === "move-down") return typeof uc.moveLayerOrder === "function" ? uc.moveLayerOrder(layer, 1) : undefined;
  if (item.id === "copy-clipboard") return copyLayerToClipboard(uc, layer);
  if (item.id === "save-image") return saveLayerAsImage(uc, layer);
  if (item.id === "remove-bg") return removeLayerBackground(uc, layer);
  if (item.id === "remove-bg-prompt") return openRemoveBgPromptPopover(uc, layer, point);
  if (item.id === "color-match") return openColorMatchPopover(uc, layer, point);
  if (item.id === "auto-name") return autoNameLayers(uc, [layer]);
  if (item.id === "rasterize") {
    if (typeof uc.rasterizePoseLayer === "function") return uc.rasterizePoseLayer(layer);
    uc.setStatus(POSE_TOOLS_UNAVAILABLE);
    return undefined;
  }
  if (item.id === "edit-pose") {
    if (typeof uc.editPoseLayer === "function") return uc.editPoseLayer(layer);
    uc.setStatus(POSE_TOOLS_UNAVAILABLE);
    return undefined;
  }
  return undefined;
}

export function installUniCanvasLayerTools(uc) {
  if (!uc || uc._vnccsLayerToolsInstalled) return uc;
  uc._vnccsLayerToolsInstalled = true;

  // The PSD row (group label + Export + Import + hidden file input) is built by
  // the widget's _buildDOM footer; this installer only wires the import parse
  // path through the explicit hook — no text-search button placement anymore.
  uc.wirePsdImport?.((file) => importPSDFile(uc, file));

  // The canvas right-click opens the same menu for the layer under the cursor.
  uc.openLayerContextMenu = (layer, e) => openLayerContextMenu(uc, layer, e);

  uc.layerList.addEventListener("contextmenu", (e) => {
    const row = e.target.closest?.("[data-layer-id]");
    if (!row) return;
    e.preventDefault();
    e.stopPropagation();
    const layer = uc.layers.find((item) => item.id === row.dataset.layerId);
    if (!layer) return;
    openLayerContextMenu(uc, layer, e);
  });

  const onDocumentPointerDown = (e) => {
    if (uc._vnccsLayerMenu && !uc._vnccsLayerMenu.contains(e.target)) closeLayerContextMenu(uc);
  };
  const onDocumentKeyDown = (e) => {
    if (e.key !== "Escape") return;
    if (uc._vnccsLayerMenu) closeLayerContextMenu(uc);
    else if (uc._vnccsColorMatch) closeColorMatchPreview(uc, false);
  };
  // The base widget wires its AbortController in _attachEvents (after this
  // installer runs), so bind on the next microtask and tie the listeners to
  // the widget's dispose signal.
  queueMicrotask(() => {
    if (uc._disposed) return;
    const options = { signal: uc._eventAbortController?.signal };
    document.addEventListener("pointerdown", onDocumentPointerDown, options);
    document.addEventListener("keydown", onDocumentKeyDown, options);
  });

  return uc;
}
