// Hover tooltips for the UniCanvas help "?" icons.
//
// The UniCanvas sidebars are scroll containers (the Parameters panel and the
// right sidebar both clip their overflow), so a CSS pseudo-element tooltip was
// cut off as soon as it left the sidebar. Every ".vnccs-uc-help[data-tip]" icon
// instead drives one body-level layer here: position:fixed (never clipped by an
// ancestor), opened above the icon - flipped below when there is no room -
// clamped to the viewport and transparent to pointer events.

export const UNICANVAS_HELP_TOOLTIP_ID = "vnccs-uc-help-tooltip";
// Above the standalone shell (2147481000) and the fullscreen portal (2147482000),
// below the ComfyUI dialogs the UniCanvas shells raise to 2147484000.
export const UNICANVAS_HELP_TOOLTIP_Z_INDEX = 2147483000;

const HELP_TOOLTIP_STYLE_ID = "vnccs-uc-help-tooltip-styles";
const VIEWPORT_MARGIN = 8;
const ICON_GAP = 8;
const MAX_WIDTH = 300;

let helpTooltipLayer = null;
let helpTooltipsInstalled = false;

function ensureHelpTooltipStyles(doc) {
  if (!doc?.head || doc.getElementById(HELP_TOOLTIP_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = HELP_TOOLTIP_STYLE_ID;
  style.textContent = `
#${UNICANVAS_HELP_TOOLTIP_ID} { position:fixed; left:0; top:0; z-index:${UNICANVAS_HELP_TOOLTIP_Z_INDEX}; padding:6px 8px; border-radius:8px; background:#0a0a0f; border:1px solid rgba(255,255,255,.14); color:#e8e8f0; font:11px/1.4 sans-serif; text-align:left; white-space:normal; pointer-events:none; box-shadow:0 6px 18px rgba(0,0,0,.5); }
#${UNICANVAS_HELP_TOOLTIP_ID}[hidden] { display:none; }
`;
  doc.head.appendChild(style);
}

function ensureHelpTooltipLayer(doc) {
  if (helpTooltipLayer && helpTooltipLayer.isConnected) return helpTooltipLayer;
  if (!doc?.body) return null;
  ensureHelpTooltipStyles(doc);
  helpTooltipLayer = doc.createElement("div");
  helpTooltipLayer.id = UNICANVAS_HELP_TOOLTIP_ID;
  helpTooltipLayer.setAttribute("role", "tooltip");
  helpTooltipLayer.hidden = true;
  doc.body.appendChild(helpTooltipLayer);
  return helpTooltipLayer;
}

function helpIconFrom(target) {
  if (!target || typeof target.closest !== "function") return null;
  const icon = target.closest(".vnccs-uc-help");
  return icon && icon.dataset.tip ? icon : null;
}

// Measure the layer first (its text is already set), then pin it to the icon.
function positionHelpTooltip(layer, icon) {
  const rect = icon.getBoundingClientRect();
  const viewportWidth = window.innerWidth || rect.right + VIEWPORT_MARGIN;
  const viewportHeight = window.innerHeight || rect.bottom + VIEWPORT_MARGIN;
  layer.style.maxWidth = `${Math.max(120, Math.min(MAX_WIDTH, viewportWidth - VIEWPORT_MARGIN * 2))}px`;
  const size = layer.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - size.width / 2;
  left = Math.min(Math.max(VIEWPORT_MARGIN, left), viewportWidth - size.width - VIEWPORT_MARGIN);
  let top = rect.top - size.height - ICON_GAP;
  if (top < VIEWPORT_MARGIN) top = rect.bottom + ICON_GAP;
  top = Math.min(Math.max(VIEWPORT_MARGIN, top), viewportHeight - size.height - VIEWPORT_MARGIN);
  layer.style.left = `${Math.round(left)}px`;
  layer.style.top = `${Math.round(top)}px`;
}

function showHelpTooltip(icon) {
  const layer = ensureHelpTooltipLayer(icon.ownerDocument || document);
  if (!layer) return;
  const text = icon.dataset.tip || "";
  if (!text.trim()) return;
  layer.textContent = text;
  layer.hidden = false;
  positionHelpTooltip(layer, icon);
}

export function hideUniCanvasHelpTooltip() {
  if (helpTooltipLayer) helpTooltipLayer.hidden = true;
}

// One delegated listener set for the whole document: node widgets, the
// fullscreen portal and the standalone tab all share this layer.
export function installUniCanvasHelpTooltips(doc = document) {
  if (helpTooltipsInstalled || !doc?.addEventListener) return;
  helpTooltipsInstalled = true;
  doc.addEventListener("pointerover", (event) => {
    const icon = helpIconFrom(event.target);
    if (icon) showHelpTooltip(icon);
    else hideUniCanvasHelpTooltip();
  });
  doc.addEventListener("pointerdown", hideUniCanvasHelpTooltip, true);
  // A scrolling sidebar moves the icon out from under the tooltip.
  doc.addEventListener("scroll", hideUniCanvasHelpTooltip, true);
  window.addEventListener("resize", hideUniCanvasHelpTooltip);
}
