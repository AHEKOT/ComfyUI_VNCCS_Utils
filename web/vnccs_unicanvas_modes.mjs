/**
 * VNCCS UniCanvas - fullscreen mode and standalone sidebar mode.
 *
 * The logic lives outside vnccs_unicanvas.js on purpose: parallel feature
 * branches share that file, so everything here hooks in through two small
 * calls (installUniCanvasWidgetModes and registerUniCanvasStandaloneSidebarTab).
 */

import { app } from "../../scripts/app.js";

export const UNICANVAS_STANDALONE_STORAGE_KEY = "vnccs-unicanvas-standalone";

const UNICANVAS_STANDALONE_TAB_ID = "vnccs-unicanvas-standalone";
const UNICANVAS_STANDALONE_BODY_CLASS = "vnccs-unicanvas-standalone-mode";
const UNICANVAS_PANELS_HIDDEN_CLASS = "vnccs-uc2-panels-hidden";
const UNICANVAS_SIDEBAR_ICON_CLASS = "vnccs-unicanvas-sidebar-icon";
const UNICANVAS_MODE_STYLE_ID = "vnccs-unicanvas-modes-styles";
const UNICANVAS_FULLSCREEN_CLASS = "vnccs-uc-fullscreen";

// The UniCanvas sidebar icon (web/assets/unicanvas_icon.svg): a stack of layers with a dashed
// selection around the active one. The ComfyUI sidebar tab strip renders the icon value as a CSS
// class on an <i> element, so the SVG is painted from CSS and stays visible without an icon font.
const UNICANVAS_SIDEBAR_ICON_SVG = new URL("./assets/unicanvas_icon.svg", import.meta.url).href;

const BRUSH_SIZE_MIN = 1;
const BRUSH_SIZE_MAX = 220;
const BRUSH_SIZE_STEP = 4;

// The UniCanvas shortcut map, active whenever the canvas has focus (fullscreen or not).
export const TOOL_SHORTCUTS = Object.freeze({
  b: "brush",
  v: "move",
  e: "eraser",
  m: "mask",
  l: "lasso",
  s: "rect",
});

const FULLSCREEN_ICON_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/></svg>';
const EXIT_FULLSCREEN_ICON_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>';
const TRUE_FULLSCREEN_ICON_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/><path d="M13 7h4a2 2 0 0 1 2 2v4"/><path d="M11 17H7a2 2 0 0 1-2-2v-4"/></svg>';

const UNICANVAS_MODE_STYLES = `
i.${UNICANVAS_SIDEBAR_ICON_CLASS} { display: inline-block; width: 1.6em; height: 1.6em; background: url("${UNICANVAS_SIDEBAR_ICON_SVG}") center / contain no-repeat; }
.vnccs-uc2-standalone-shell { position: fixed; top: 0; bottom: 0; display: flex; z-index: 2147481000; background: #0e0b12; }
.vnccs-uc2-standalone-shell > .vnccs-unicanvas { flex: 1 1 auto; width: 100%; min-width: 0; min-height: 0; }
body.${UNICANVAS_STANDALONE_BODY_CLASS} #comfyui-body-top,
body.${UNICANVAS_STANDALONE_BODY_CLASS} .comfyui-body-top,
body.${UNICANVAS_STANDALONE_BODY_CLASS} #comfy-menu,
body.${UNICANVAS_STANDALONE_BODY_CLASS} .comfyui-menu,
body.${UNICANVAS_STANDALONE_BODY_CLASS} #comfyui-body-bottom,
body.${UNICANVAS_STANDALONE_BODY_CLASS} .comfyui-body-bottom { display: none !important; }
.vnccs-uc-stage-wrap { position: relative; }
.vnccs-uc2-fullscreen-btn svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.vnccs-uc2-fullscreen-btn.exit { background: #e5484d; border-color: #e5484d; color: #fff; }
.vnccs-uc2-fullscreen-btn.exit:hover { background: #f2555a; }
.vnccs-uc2-fullscreen-portal { position: fixed; inset: 0; z-index: 2147482000; display: flex; flex-direction: column; background: #0e0b12; }
.vnccs-uc2-fullscreen-portal > .vnccs-unicanvas { flex: 1 1 auto; min-height: 0; min-width: 0; }
.vnccs-uc2-fullscreen-chrome { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: #171320; color: #e8e8f0; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
.vnccs-uc2-fullscreen-title { flex: 1 1 auto; font: 700 13px/1.2 inherit; letter-spacing: 0.04em; text-transform: uppercase; }
.vnccs-uc2-true-fullscreen { width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--uc-border, rgba(255, 255, 255, 0.14)); border-radius: 8px; background: var(--uc-surface, rgba(255, 255, 255, 0.045)); color: inherit; cursor: pointer; font: inherit; }
.vnccs-uc2-true-fullscreen svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.vnccs-uc2-true-fullscreen.active { border-color: rgba(255, 143, 163, 0.7); background: rgba(255, 143, 163, 0.18); color: #ffdce5; }
.vnccs-uc2-true-fullscreen:hover { background: var(--uc-hover, rgba(255, 255, 255, 0.1)); }
.vnccs-uc2-toasts { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 60; display: flex; flex-direction: column; gap: 6px; width: min(420px, calc(100% - 24px)); pointer-events: none; }
.vnccs-uc2-toast { display: flex; align-items: flex-start; gap: 10px; padding: 9px 10px 9px 12px; border: 1px solid rgba(80, 200, 140, 0.55); border-left-width: 3px; border-radius: 10px; background: rgba(18, 15, 26, 0.96); color: #e8e8f0; font: 12px/1.35 inherit; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5); pointer-events: auto; }
.vnccs-uc2-toast.error { border-color: rgba(229, 72, 77, 0.75); }
.vnccs-uc2-toast-body { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.vnccs-uc2-toast-title { font-weight: 800; margin-bottom: 2px; }
.vnccs-uc2-toast-close { flex: 0 0 auto; border: 0; background: none; color: inherit; opacity: 0.7; cursor: pointer; font: 700 14px/1 inherit; padding: 0 2px; }
/* Save to output: top-right of the right sidebar, kept visible whatever the sidebar shows (pose editing too). */
.vnccs-uc2-save-actions { display: flex; flex: 0 0 auto; }
.vnccs-uc2-save-actions .vnccs-uc-btn { flex: 1 1 auto; }
.vnccs-unicanvas.vnccs-uc-pose-editing .vnccs-uc-side > .vnccs-uc2-save-actions { display: flex !important; }
.${UNICANVAS_PANELS_HIDDEN_CLASS} .vnccs-uc-left, .${UNICANVAS_PANELS_HIDDEN_CLASS} .vnccs-uc-side { display: none !important; }
.vnccs-uc-fullscreen .vnccs-uc-tools { zoom: calc(var(--vnccs-uc-ui-scale, 1) * 0.5); }
body.${UNICANVAS_STANDALONE_BODY_CLASS} .vnccs-uc-tools { zoom: calc(var(--vnccs-uc-ui-scale, 1) * 0.5); }
/* ComfyUI's own dialogs (Settings, confirmers) and their dimming scrim must open
   ABOVE the standalone shell and the fullscreen portal, never behind them. The
   stylesheet flag beats the inline z-index that PrimeVue/Reka set on the masks. */
body:has(.vnccs-uc2-standalone-shell) .p-dialog-mask,
body:has(.vnccs-uc2-fullscreen-portal) .p-dialog-mask,
body:has(.vnccs-uc2-standalone-shell) .comfy-modal,
body:has(.vnccs-uc2-fullscreen-portal) .comfy-modal,
body:has(.vnccs-uc2-standalone-shell) [role="dialog"],
body:has(.vnccs-uc2-fullscreen-portal) [role="dialog"],
body:has(.vnccs-uc2-standalone-shell) [role="alertdialog"],
body:has(.vnccs-uc2-fullscreen-portal) [role="alertdialog"] { z-index: 2147484000 !important; }
`;

export function ensureUniCanvasModeStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(UNICANVAS_MODE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = UNICANVAS_MODE_STYLE_ID;
  style.textContent = UNICANVAS_MODE_STYLES;
  document.head.appendChild(style);
}

export function isUniCanvasTextTarget(event) {
  const target = event?.target;
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable]"));
}

export function isUniCanvasModalOpen(widget) {
  // The widget's confirm/prompt modal owns Enter and Escape while it is open.
  return Boolean(widget?.container?.querySelector(".vnccs-uc-modal-overlay"));
}

function isUniCanvasCanvasFocused(widget, event) {
  const target = event?.target;
  return Boolean(target && widget?.canvas && (target === widget.canvas || widget.canvas.contains(target)));
}

export function setUniCanvasBrushSize(widget, value) {
  const size = Math.max(BRUSH_SIZE_MIN, Math.min(BRUSH_SIZE_MAX, Math.round(Number(value) || BRUSH_SIZE_MIN)));
  if (size === widget.brushSize) return;
  widget.brushSize = size;
  // The slider stays in sync on every step (repo realtime rule).
  for (const input of widget.toolSettings?.querySelectorAll('[data-control="brushSize"]') || []) {
    input.value = String(size);
  }
  widget.updateToolPreviewOverlay?.();
  widget.updateHud?.();
  widget.requestRender?.();
}

export function toggleUniCanvasPanels(widget) {
  widget.container.classList.toggle(UNICANVAS_PANELS_HIDDEN_CLASS);
  widget.resize?.();
  widget.requestRender?.();
}

function consumeUniCanvasShortcut(event) {
  // The canvas owns the key while it has focus, so the graph's global shortcuts
  // must not also run for it.
  event.preventDefault();
  event.stopPropagation();
}

export function handleUniCanvasShortcut(widget, event, options = null) {
  if (!widget || !event || isUniCanvasTextTarget(event)) return false;
  // An open modal owns the keyboard: Enter activates its confirm button and
  // Escape closes the modal instead of leaving fullscreen or switching tools.
  if (isUniCanvasModalOpen(widget)) return false;
  const key = String(event.key || "");
  // Pose editing owns Enter/Esc first: both save the pose and leave the editor (a Pose
  // Studio dialog keeps them). A second Esc then leaves fullscreen.
  if ((key === "Escape" || key === "Enter") && widget.tool === "pose" && widget.poseEditSession
    && !widget.container?.querySelector?.(".vnccs-uc-pose-root [class*='modal']:not([hidden])")) {
    consumeUniCanvasShortcut(event);
    widget.finishPoseEdit?.(true);
    return true;
  }
  // An open Free Transform owns Enter (apply) and Esc (cancel), as in Photoshop.
  if ((key === "Escape" || key === "Enter") && widget.transformDraft) {
    consumeUniCanvasShortcut(event);
    if (key === "Enter") widget.applyTransformDraft?.();
    else widget.cancelTransformDraft?.();
    return true;
  }
  // Pose editing: Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z walk the mannequin's history from anywhere in
  // the widget (the Pose Studio viewport has focus then, not the canvas).
  const historyKey = (event.ctrlKey || event.metaKey) && !event.altKey ? key.toLowerCase() : "";
  if ((historyKey === "z" || historyKey === "y") && widget.tool === "pose" && widget.poseEditSession
    && widget.container?.contains?.(event.target)) {
    consumeUniCanvasShortcut(event);
    if (historyKey === "y" || event.shiftKey) widget.redo();
    else widget.undo();
    return true;
  }
  // Esc leaves the active tool before it leaves fullscreen: brush/eraser/mask/...
  // return to Move layer on the first Esc, and the next Esc (tool is move/pan
  // then) reaches the fullscreen exit below. Move/pan pass straight through.
  if (key === "Escape" && widget.tool !== "move" && widget.tool !== "pan") {
    consumeUniCanvasShortcut(event);
    widget.setTool("move");
    return true;
  }
  // Esc exits fullscreen from anywhere inside the fullscreen (chrome behavior).
  if (key === "Escape" && widget._vnccsFullscreen) {
    consumeUniCanvasShortcut(event);
    exitUniCanvasFullscreen(widget);
    return true;
  }
  const lower = key.toLowerCase();
  const modifier = event.ctrlKey || event.metaKey;
  // History: Ctrl+Z / Ctrl+Shift+Z. In fullscreen and in the standalone tab the
  // keys count no matter which element inside the widget holds the focus (the
  // fullscreen capture listener already routes them here; the focus may sit on
  // a panel button); elsewhere the canvas still has to hold the focus.
  const historyFocusBypass = Boolean(widget._vnccsFullscreen)
    || (Boolean(widget.standalone) && Boolean(widget.container?.isConnected))
    || Boolean(options?.historyBypass);
  if (modifier && !event.altKey && (lower === "z" || lower === "y")) {
    if (!historyFocusBypass && !isUniCanvasCanvasFocused(widget, event)) return false;
    consumeUniCanvasShortcut(event);
    if (lower === "y" || event.shiftKey) widget.redo();
    else widget.undo();
    return true;
  }
  // The rest of the shortcut map is active only while the canvas has focus
  // (spec 5), fullscreen or not.
  if (!isUniCanvasCanvasFocused(widget, event)) return false;
  if (modifier || event.altKey) return false;
  // Tools: B brush, V move, E eraser, M mask, L lasso, S rect.
  if (key.length === 1 && Object.prototype.hasOwnProperty.call(TOOL_SHORTCUTS, lower)) {
    consumeUniCanvasShortcut(event);
    widget.setTool(TOOL_SHORTCUTS[lower]);
    return true;
  }
  // Brush size: [ / ].
  if (key === "[") {
    consumeUniCanvasShortcut(event);
    setUniCanvasBrushSize(widget, widget.brushSize - BRUSH_SIZE_STEP);
    return true;
  }
  if (key === "]") {
    consumeUniCanvasShortcut(event);
    setUniCanvasBrushSize(widget, widget.brushSize + BRUSH_SIZE_STEP);
    return true;
  }
  // Tab toggles panel visibility.
  if (key === "Tab") {
    consumeUniCanvasShortcut(event);
    toggleUniCanvasPanels(widget);
    return true;
  }
  return false;
}

function installUniCanvasShortcuts(widget) {
  if (widget.canvas) {
    widget.canvas.tabIndex = 0;
    widget.canvas.setAttribute("aria-label", "UniCanvas stage");
    widget.canvas.addEventListener("pointerdown", () => {
      widget.canvas.focus({ preventScroll: true });
    });
  }
  widget.container.addEventListener("keydown", (event) => {
    handleUniCanvasShortcut(widget, event);
  });
  // Pose Studio's WebGL viewport does not take keyboard focus, so while a pose is edited the
  // history keys arrive on the document. They count when the last click was inside this widget.
  const controller = new AbortController();
  widget._vnccsPoseKeysAbort = controller;
  document.addEventListener("pointerdown", (event) => {
    widget._vnccsPointerInside = Boolean(widget.container?.contains?.(event.target));
  }, { capture: true, signal: controller.signal });
  document.addEventListener("keydown", (event) => {
    if (!widget.poseEditSession || widget.tool !== "pose" || !widget._vnccsPointerInside) return;
    if (widget.container?.contains?.(event.target) || isUniCanvasTextTarget(event)) return; // the container handler has it
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = String(event.key || "").toLowerCase();
    if (key !== "z" && key !== "y") return;
    consumeUniCanvasShortcut(event);
    if (key === "y" || event.shiftKey) widget.redo();
    else widget.undo();
  }, { signal: controller.signal });
}

// ---------------------------------------------------------------------------
// History isolation: Ctrl+Z / Ctrl+Y never reach ComfyUI's graph undo/redo
// while a UniCanvas surface owns the interaction
// ---------------------------------------------------------------------------

// ComfyUI's keybind handler listens on window in the BUBBLE phase
// (useEventListener in GraphView.vue) and routes Ctrl+Z / Ctrl+Y to the
// Comfy.Undo / Comfy.Redo commands, which revert the node workflow. A stray
// key pressed while the user works inside a UniCanvas surface must never get
// there: undoing the graph re-configures the node, which collapses an open
// fullscreen and "refreshes" the workflow under the user's hands.
//
// A UniCanvas surface owns the history keys when
//   - the standalone tab is active (its shell covers the whole app),
//   - the widget is in fullscreen, or
//   - the last pointerdown landed inside the widget (node mode; the DOM
//     widget does not hold keyboard focus reliably) or its canvas is focused.
// The capture listeners below register at module import, so they always run
// before the bubble-phase keybind handler; a focused text field keeps its
// native undo in every case.
const uniCanvasModeWidgets = new Set();
let standaloneHistoryWidget = null;
let uniCanvasHistoryLastClaimAt = 0;

// Hover tracking: in node mode the widget does not hold keyboard focus, so the
// mouse being over the widget is what makes Ctrl+Z belong to it. pointerover
// targets only land inside the container while the widget actually receives
// pointer events (ComfyUI toggles that as the mouse crosses the node).
function trackUniCanvasPointerHover(event) {
  for (const widget of uniCanvasModeWidgets) {
    widget._vnccsPointerHover = Boolean(widget.container?.isConnected && widget.container.contains(event.target));
  }
}

function uniCanvasHistoryOwner(event) {
  if (document.body.classList.contains(UNICANVAS_STANDALONE_BODY_CLASS) && standaloneHistoryWidget) {
    return standaloneHistoryWidget;
  }
  for (const widget of uniCanvasModeWidgets) {
    if (widget._vnccsFullscreen) return widget;
  }
  for (const widget of uniCanvasModeWidgets) {
    if (widget._vnccsPointerHover || widget._vnccsPointerInside || isUniCanvasCanvasFocused(widget, event)) return widget;
  }
  return null;
}

function isUniCanvasHistoryCombo(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  const key = String(event.key || "").toLowerCase();
  return key === "z" || key === "y";
}

function uniCanvasOwnsFullKeyboard(widget) {
  // Fullscreen and the standalone shell cover the whole app: no key may reach
  // ComfyUI there at all. Node mode only claims the history keys (below).
  return Boolean(widget._vnccsFullscreen)
    || (Boolean(widget.standalone) && document.body.classList.contains(UNICANVAS_STANDALONE_BODY_CLASS));
}

function handleUniCanvasHistoryKeyDown(event) {
  // Belt and braces: the tracker gate must exist before its rAF callback runs.
  installUniCanvasChangeTrackerGate();
  const widget = uniCanvasHistoryOwner(event);
  if (!widget || widget._disposed) return;
  uniCanvasHistoryLastClaimAt = Date.now();
  const fullKeyboard = uniCanvasOwnsFullKeyboard(widget);
  // Node mode only claims Ctrl+Z / Ctrl+Y; fullscreen/standalone claim everything.
  if (!fullKeyboard && !isUniCanvasHistoryCombo(event)) return;
  // Visible trace so the user can see who took the key (status line of the widget).
  if (isUniCanvasHistoryCombo(event)) {
    const label = String(event.key).toLowerCase() === "y" ? "Redo" : "Undo";
    widget.setStatus?.(`[VNCCS UniCanvas] ${label} key captured`);
  }
  if (isUniCanvasTextTarget(event)) {
    // A focused text field keeps its native editing and undo; ComfyUI still
    // never sees the key.
    event.stopImmediatePropagation();
    return;
  }
  // Run the widget map first (undo/redo, tool shortcuts, modal and pose
  // contracts); swallow the key even when the map declines or throws, so
  // nothing ever falls through to the graph. Tab keeps its default when the
  // map did not take it, so focus traversal inside the panels keeps working.
  widget._vnccsHistoryOwner = true;
  let handled;
  try {
    handled = handleUniCanvasShortcut(widget, event, { historyBypass: true });
  } catch (err) {
    console.error("[VNCCS UniCanvas] shortcut handling failed; key stays captured", err);
  } finally {
    delete widget._vnccsHistoryOwner;
  }
  event.stopImmediatePropagation();
  if (!handled && event.key !== "Tab") event.preventDefault();
}

function handleUniCanvasHistoryKeyUp(event) {
  const widget = uniCanvasHistoryOwner(event);
  if (!widget) return;
  if (isUniCanvasTextTarget(event)) return;
  if (!uniCanvasOwnsFullKeyboard(widget) && !isUniCanvasHistoryCombo(event)) return;
  event.stopImmediatePropagation();
}

function handleUniCanvasHistoryKeyPress(event) {
  const widget = uniCanvasHistoryOwner(event);
  if (!widget) return;
  if (isUniCanvasTextTarget(event)) return;
  if (!uniCanvasOwnsFullKeyboard(widget)) return;
  event.stopImmediatePropagation();
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.addEventListener("keydown", handleUniCanvasHistoryKeyDown, true);
  window.addEventListener("keyup", handleUniCanvasHistoryKeyUp, true);
  window.addEventListener("keypress", handleUniCanvasHistoryKeyPress, true);
  document.addEventListener("pointerover", trackUniCanvasPointerHover, true);
}

// Belt and braces for the non-keyboard paths (Edit menu, command palette):
// route the core commands through a gate while a UniCanvas surface owns the
// session. Installed lazily on first mode entry - by then ComfyUI has
// registered its core commands.
let uniCanvasUndoGateInstalled = false;

function uniCanvasOwnsHistorySession() {
  if (document.body.classList.contains(UNICANVAS_STANDALONE_BODY_CLASS) && standaloneHistoryWidget) return true;
  for (const widget of uniCanvasModeWidgets) {
    if (widget._vnccsFullscreen) return true;
  }
  // Node mode: a history key we just claimed also owns the session - the
  // command executes synchronously right after the keydown capture, so a
  // short claim window is enough to catch late dispatch paths.
  return Date.now() - uniCanvasHistoryLastClaimAt < 1500;
}

function installUniCanvasGraphUndoGate() {
  if (uniCanvasUndoGateInstalled) return;
  // ComfyUI's command store is a Pinia store exposing only `commands` and
  // `execute` (no getCommand/commandsById), so the only reliable seam is the
  // execute dispatcher itself: wrap it once and refuse Comfy.Undo / Comfy.Redo
  // while a UniCanvas surface owns the history. This covers the Edit menu,
  // the command palette and any keybind route - the graph can never revert.
  const commandStore = app?.extensionManager?.command;
  if (!commandStore || typeof commandStore.execute !== "function" || commandStore._vnccsGate) return;
  const originalExecute = commandStore.execute;
  commandStore._vnccsGate = true;
  commandStore.execute = async function (commandId, ...rest) {
    const id = String(commandId || "");
    if ((id === "Comfy.Undo" || id === "Comfy.Redo") && uniCanvasOwnsHistorySession()) return;
    return originalExecute.call(this, commandId, ...rest);
  };
  uniCanvasUndoGateInstalled = true;
}

// ComfyUI's ChangeTracker.init() registers its OWN window-capture keydown listener
// before any extension loads, and defers the actual work to requestAnimationFrame
// before calling changeTracker.undoRedo(event). That path never touches the command
// store, and stopImmediatePropagation cannot cancel an already-scheduled rAF - so
// the graph reloads (app.loadGraphData) and the node is torn down, which is what
// collapsed fullscreen and "refreshed the workflow" for the user. The only seam
// that covers it is the tracker itself: patch its prototype once so undo/redo
// refuse to run while a UniCanvas surface owns the history keys.
let uniCanvasChangeTrackerGateInstalled = false;

function uniCanvasChangeTracker() {
  try {
    return app?.extensionManager?.workflow?.activeWorkflow?.changeTracker ?? null;
  } catch (_err) {
    return null;
  }
}

function installUniCanvasChangeTrackerGate() {
  if (uniCanvasChangeTrackerGateInstalled) return;
  const tracker = uniCanvasChangeTracker();
  const proto = tracker ? Object.getPrototypeOf(tracker) : null;
  if (!proto || typeof proto.undoRedo !== "function") return;
  if (!proto._vnccsTrackerGate) {
    const originalUndoRedo = proto.undoRedo;
    const originalUndo = proto.undo;
    const originalRedo = proto.redo;
    proto._vnccsTrackerGate = true;
    proto.undoRedo = async function (event) {
      // Claim the key (true = handled) so the tracker's own listener stops here
      // instead of falling through to captureCanvasState.
      if (uniCanvasOwnsHistorySession()) return true;
      return originalUndoRedo.call(this, event);
    };
    if (typeof originalUndo === "function") {
      proto.undo = async function (...args) {
        if (uniCanvasOwnsHistorySession()) return undefined;
        return originalUndo.apply(this, args);
      };
    }
    if (typeof originalRedo === "function") {
      proto.redo = async function (...args) {
        if (uniCanvasOwnsHistorySession()) return undefined;
        return originalRedo.apply(this, args);
      };
    }
  }
  uniCanvasChangeTrackerGateInstalled = true;
}

function toggleUniCanvasTrueFullscreen(widget) {
  const portal = widget?._vnccsFullscreen?.portal;
  const doc = portal?.ownerDocument || (typeof document === "undefined" ? null : document);
  if (!doc) return;
  if (doc.fullscreenElement) {
    const leaving = doc.exitFullscreen?.();
    leaving?.catch?.(() => {});
    return;
  }
  const request = portal?.requestFullscreen?.();
  request?.catch?.((err) => {
    widget.setStatus(`[VNCCS UniCanvas] Browser fullscreen failed: ${err?.message || err}`, true);
  });
}

function buildUniCanvasFullscreenChrome(widget) {
  const chrome = document.createElement("div");
  chrome.className = "vnccs-uc2-fullscreen-chrome";
  const title = document.createElement("span");
  title.className = "vnccs-uc2-fullscreen-title";
  title.textContent = "Unicanvas";
  const trueFullscreenBtn = document.createElement("button");
  trueFullscreenBtn.type = "button";
  trueFullscreenBtn.className = "vnccs-uc2-true-fullscreen";
  trueFullscreenBtn.title = "Toggle browser fullscreen";
  trueFullscreenBtn.innerHTML = TRUE_FULLSCREEN_ICON_SVG;
  trueFullscreenBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleUniCanvasTrueFullscreen(widget);
  });
  // Leaving fullscreen is the corner-bar fullscreen button, which turns into a red X.
  chrome.append(title, trueFullscreenBtn);
  return { chrome, trueFullscreenBtn };
}

export function enterUniCanvasFullscreen(widget) {
  if (!widget || widget._vnccsFullscreen) return;
  ensureUniCanvasModeStyles();
  const container = widget.container;
  const restoreParent = container.parentNode;
  const restoreNextSibling = container.nextSibling;
  const portal = document.createElement("div");
  portal.className = "vnccs-uc2-fullscreen-portal";
  const { chrome, trueFullscreenBtn } = buildUniCanvasFullscreenChrome(widget);
  // Same widget instance is re-parented into the fixed portal; no reload.
  portal.append(chrome, container);
  document.body.appendChild(portal);
  // The vertical tools column renders 50% smaller while fullscreen (user request).
  container.classList.add(UNICANVAS_FULLSCREEN_CLASS);

  // Keyboard isolation for the duration of the fullscreen: window-level
  // capture-phase listeners swallow every key event that is not targeted at
  // input/textarea/select/[contenteditable], so LiteGraph and ComfyUI
  // shortcuts receive nothing. An open widget modal keeps its own Enter and
  // Escape contract, and the UniCanvas shortcut map runs first so the canvas
  // keeps its own keys.
  const modalOwnsKey = (event) => isUniCanvasModalOpen(widget) && (event.key === "Enter" || event.key === "Escape");
  const onKeyDown = (event) => {
    if (isUniCanvasTextTarget(event)) return;
    if (modalOwnsKey(event)) return;
    handleUniCanvasShortcut(widget, event);
    event.stopImmediatePropagation();
    event.preventDefault();
  };
  const onKeyUp = (event) => {
    if (isUniCanvasTextTarget(event)) return;
    if (modalOwnsKey(event)) return;
    event.stopImmediatePropagation();
    event.preventDefault();
  };
  const onKeyPress = (event) => {
    if (isUniCanvasTextTarget(event)) return;
    if (modalOwnsKey(event)) return;
    event.stopImmediatePropagation();
    event.preventDefault();
  };
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("keypress", onKeyPress, true);
  const onFullscreenChange = () => {
    if (!widget._vnccsFullscreen) return;
    trueFullscreenBtn.classList.toggle("active", Boolean(document.fullscreenElement));
  };
  document.addEventListener("fullscreenchange", onFullscreenChange);

  // enableUniCanvasGraphNavigationForwarding stays suspended until exit.
  container._vnccsUniCanvasGraphNavigationSuspended = true;

  widget._vnccsFullscreen = {
    portal,
    chrome,
    trueFullscreenBtn,
    restoreParent,
    restoreNextSibling,
    onKeyDown,
    onKeyUp,
    onKeyPress,
    onFullscreenChange,
  };
  installUniCanvasGraphUndoGate();
  installUniCanvasChangeTrackerGate();
  syncUniCanvasFullscreenButton(widget);
  // The graph canvas behind the portal may still hold keyboard focus (entering
  // fullscreen is mouse-only); pull focus into the widget so keys are aimed at
  // UniCanvas from the first press.
  widget.canvas?.focus?.({ preventScroll: true });
  // The ResizeObserver re-lays out; the view fits the new size.
  widget.resize();
  widget.fitView();
  widget.render();
}

export function exitUniCanvasFullscreen(widget) {
  const state = widget?._vnccsFullscreen;
  if (!state) return;
  window.removeEventListener("keydown", state.onKeyDown, true);
  window.removeEventListener("keyup", state.onKeyUp, true);
  window.removeEventListener("keypress", state.onKeyPress, true);
  document.removeEventListener("fullscreenchange", state.onFullscreenChange);
  widget.container._vnccsUniCanvasGraphNavigationSuspended = false;
  widget.container.classList.remove(UNICANVAS_FULLSCREEN_CLASS);
  if (document.fullscreenElement === state.portal) {
    const leaving = document.exitFullscreen?.();
    leaving?.catch?.(() => {});
  }
  state.portal.remove();
  if (state.restoreParent) {
    // Re-insert only when the saved anchor still sits in the saved parent; a
    // re-laid-out DOM widget area leaves a stale sibling reference behind.
    const sibling = state.restoreNextSibling;
    if (sibling && sibling.parentNode === state.restoreParent) {
      state.restoreParent.insertBefore(widget.container, sibling);
    } else {
      state.restoreParent.appendChild(widget.container);
    }
  }
  widget._vnccsFullscreen = null;
  syncUniCanvasFullscreenButton(widget);
  if (!widget._disposed) {
    widget.resize();
    widget.render();
  }
}

function syncUniCanvasFullscreenButton(widget) {
  const btn = widget?._vnccsFullscreenButton;
  if (!btn) return;
  const active = Boolean(widget._vnccsFullscreen);
  const label = active ? "Exit fullscreen" : "Fullscreen";
  btn.classList.toggle("exit", active);
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.innerHTML = active ? EXIT_FULLSCREEN_ICON_SVG : FULLSCREEN_ICON_SVG;
}

function installUniCanvasFullscreenButton(widget) {
  // The standalone tab already fills the window, so a fullscreen toggle there is redundant.
  if (widget.standalone) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "vnccs-uc-icon vnccs-uc2-fullscreen-btn";
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (widget._vnccsFullscreen) exitUniCanvasFullscreen(widget);
    else enterUniCanvasFullscreen(widget);
  });
  // Sits right of the settings gear in the corner bar; in fullscreen it is the red close button.
  const gear = widget.gearBtn;
  if (gear?.parentNode) gear.insertAdjacentElement("afterend", btn);
  else widget.stageWrap.appendChild(btn);
  widget._vnccsFullscreenButton = btn;
  syncUniCanvasFullscreenButton(widget);
}

// A toast inside the UniCanvas container: ComfyUI's own toasts sit under the standalone shell
// and the browser-fullscreen portal, so they would never be seen there.
export function showUniCanvasToast(widget, title, detail = "", kind = "success") {
  const host = widget?.container;
  if (!host) return null;
  let stack = widget._vnccsToastStack;
  if (!stack?.isConnected) {
    stack = document.createElement("div");
    stack.className = "vnccs-uc2-toasts";
    stack.setAttribute("aria-live", "polite");
    host.appendChild(stack);
    widget._vnccsToastStack = stack;
  }
  const toast = document.createElement("div");
  toast.className = `vnccs-uc2-toast ${kind === "error" ? "error" : "success"}`;
  toast.setAttribute("role", kind === "error" ? "alert" : "status");
  const body = document.createElement("div");
  body.className = "vnccs-uc2-toast-body";
  const head = document.createElement("div");
  head.className = "vnccs-uc2-toast-title";
  head.textContent = title;
  body.appendChild(head);
  if (detail) body.appendChild(document.createTextNode(detail));
  const close = document.createElement("button");
  close.type = "button";
  close.className = "vnccs-uc2-toast-close";
  close.title = "Close";
  close.textContent = "×";
  const remove = () => toast.remove();
  close.addEventListener("click", (event) => { event.stopPropagation(); remove(); });
  toast.addEventListener("pointerdown", (event) => event.stopPropagation());
  toast.append(body, close);
  stack.appendChild(toast);
  setTimeout(remove, kind === "error" ? 10000 : 5000);
  return toast;
}

// Canvas-pixel rectangle of the generation bbox (world coords minus the canvas origin).
export function uniCanvasBboxPixelRect(bbox, origin) {
  return {
    x: Math.round(Number(bbox?.x || 0) - Number(origin?.x || 0)),
    y: Math.round(Number(bbox?.y || 0) - Number(origin?.y || 0)),
    width: Math.max(1, Math.round(Number(bbox?.width) || 1)),
    height: Math.max(1, Math.round(Number(bbox?.height) || 1)),
  };
}

// Save to output: every visible image layer flattened, cropped to the generation bbox.
export function buildUniCanvasBboxCompositeCanvas(widget) {
  const full = buildUniCanvasCompositeCanvas(widget);
  const rect = uniCanvasBboxPixelRect(widget.bbox, widget.origin);
  const out = document.createElement("canvas");
  out.width = rect.width;
  out.height = rect.height;
  const ctx = widget.configureImageContext(out.getContext("2d"), false);
  ctx.drawImage(full, -rect.x, -rect.y);
  return out;
}

export function buildUniCanvasCompositeCanvas(widget) {
  // Flattened composite = exactly what flattenLayersToMaster draws: the shared
  // per-layer semantics of widget.drawFlattenedLayers (hi-res layers included),
  // over the whole canvas. Mask layers stay out of it, matching the node's image
  // socket output.
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(widget.size.width));
  out.height = Math.max(1, Math.round(widget.size.height));
  const ctx = widget.configureImageContext(out.getContext("2d"), false);
  widget.drawFlattenedLayers(ctx);
  return out;
}

export async function saveUniCanvasOutput(widget, layerId = null) {
  // layerId is the layer-context-menu call shape ("Save layer as image" in the
  // layer context menu of a parallel branch): it saves only that layer's PNG.
  try {
    widget.setStatus("[VNCCS UniCanvas] Saving to output...");
    let payload;
    if (layerId) {
      const layer = widget.layers.find((item) => item.id === String(layerId));
      if (!layer) throw new Error(`[VNCCS UniCanvas] Layer '${layerId}' was not found.`);
      payload = { state: { version: 2, layers: [widget.serializeLayer(layer, true)] }, layer_id: String(layerId) };
    } else {
      payload = { image: buildUniCanvasBboxCompositeCanvas(widget).toDataURL("image/png") };
    }
    const res = await fetch("/vnccs/unicanvas/save_output", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    let data = {};
    try { data = await res.json(); } catch (_) { data = {}; }
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status} ${res.statusText || ""}`.trim());
    const fileName = String(data.path || "").split(/[\\/]/).pop() || "image";
    const size = data.width && data.height ? ` (${data.width}×${data.height})` : "";
    widget.setStatus(`[VNCCS UniCanvas] Saved ${data.path}`);
    showUniCanvasToast(widget, "Saved to output", `${fileName}${size}`);
  } catch (err) {
    const message = String(err?.message || err).replace(/^\[VNCCS UniCanvas\]\s*/, "");
    widget.setStatus(`[VNCCS UniCanvas] Save to output failed: ${message}`, true);
    showUniCanvasToast(widget, "Save to output failed", message, "error");
  }
}

export async function newUniCanvasDocument(widget) {
  const confirmed = await widget.confirmInWidget(
    "New canvas",
    "Are you sure?\nConfirmation will delete <b>all layers</b> in canvas.",
    "Confirm"
  );
  if (!confirmed) return;
  // Clear every layer and image, then create one fresh base layer for new work.
  widget.stagingItems = [];
  widget.activeStagingIndex = -1;
  widget.layers = [];
  widget.activeLayerId = null;
  widget.undoStack = [];
  widget.redoStack = [];
  widget.addLayer("raster", "Base Layer", false);
  widget.updateHistoryButtons?.();
  widget.renderLayerList();
  widget.syncActiveLayerControls?.();
  widget.requestRender();
  widget.syncToNode?.();
  widget.setStatus("[VNCCS UniCanvas] Started a new canvas.");
}

function installUniCanvasOutputActions(widget) {
  // Only the standalone tab needs these: on a node the composite already goes to the
  // node's image output, so Save to output would just duplicate it.
  if (!widget.standalone) return;
  // New canvas sits centered in the top toolbar (between the undo/redo/Fit cluster and
  // the grid/gear/exit cluster) instead of a row above GENERATE; the CSS centers it
  // absolutely so the two clusters keep their layout.
  const newCanvasButton = widget._button(
    "New canvas", "vnccs-uc-btn vnccs-uc-new-canvas", () => void newUniCanvasDocument(widget), "New canvas"
  );
  widget.settingsBar?.appendChild(newCanvasButton);
  const saveRow = document.createElement("div");
  saveRow.className = "vnccs-uc2-save-actions";
  saveRow.append(widget._button("Save to output", "vnccs-uc-btn", () => void saveUniCanvasOutput(widget), "Save the flattened composite to the ComfyUI output directory"));
  widget.side.insertBefore(saveRow, widget.side.firstChild);
  widget._vnccsSaveActions = saveRow;
}

export function installUniCanvasWidgetModes(widget) {
  if (!widget || widget._vnccsModesInstalled) return widget;
  widget._vnccsModesInstalled = true;
  uniCanvasModeWidgets.add(widget);
  ensureUniCanvasModeStyles();
  installUniCanvasShortcuts(widget);
  installUniCanvasFullscreenButton(widget);
  installUniCanvasOutputActions(widget);
  installUniCanvasGraphUndoGate();
  installUniCanvasChangeTrackerGate();
  if (widget.standalone) {
    installStandalonePersistence(widget);
  }
  return widget;
}

// ---------------------------------------------------------------------------
// Standalone sidebar mode: "Unicanvas" tab, chrome hiding, local persistence
// ---------------------------------------------------------------------------

function writeStandaloneState(widget, state) {
  // Mirrors saveLocalStateBackup's degradation: persistence stops (after one
  // informative message) once localStorage cannot hold the document.
  if (widget.localStateBackupDisabled) return;
  try {
    state.storage = "local";
    const payload = JSON.stringify({ saved_at: Date.now(), state });
    if (payload.length > 4_000_000) {
      widget.localStateBackupDisabled = true;
      if (!widget.localStateBackupWarned) {
        widget.localStateBackupWarned = true;
        console.info("[VNCCS UniCanvas] Local backup skipped: state is too large for browser localStorage; work will not survive a reload.");
      }
      return;
    }
    window.localStorage?.setItem(UNICANVAS_STANDALONE_STORAGE_KEY, payload);
  } catch (err) {
    widget.localStateBackupDisabled = true;
    if (!widget.localStateBackupWarned) {
      widget.localStateBackupWarned = true;
      console.info("[VNCCS UniCanvas] Local backup disabled: browser localStorage quota is not enough; work will not survive a reload.");
    }
  }
}

const standalonePersistState = new WeakMap();

function installStandalonePersistence(widget) {
  // Standalone mode has no workflow widget and no server state cache: the
  // localStorage key "vnccs-unicanvas-standalone" holds the document instead.
  const entry = { timer: null };
  standalonePersistState.set(widget, entry);
  const schedulePersist = () => {
    if (entry.timer !== null) window.clearTimeout(entry.timer);
    entry.timer = window.setTimeout(() => {
      entry.timer = null;
      writeStandaloneState(widget, widget.buildSerializedState(true));
    }, 300);
  };
  widget.getStateBackupKey = () => UNICANVAS_STANDALONE_STORAGE_KEY;
  widget.uploadStatePayload = async (state) => {
    writeStandaloneState(widget, state);
  };
  const originalWriteLightStateToWidget = widget.writeLightStateToWidget;
  widget.writeLightStateToWidget = (...args) => {
    const result = originalWriteLightStateToWidget.call(widget, ...args);
    schedulePersist();
    return result;
  };
}

export function flushStandalonePersistence(widget) {
  const entry = widget ? standalonePersistState.get(widget) : null;
  if (!entry) return;
  if (entry.timer !== null) {
    window.clearTimeout(entry.timer);
    entry.timer = null;
  }
  // Write even for a disposed widget: the localStorage write is safe after
  // disposal and preserves the last pending document (symmetry with the
  // dispose()-time flushStateUpload path).
  writeStandaloneState(widget, widget.buildSerializedState(true));
}

export function teardownUniCanvasWidgetModes(widget) {
  if (!widget) return;
  // Runs from widget.dispose()/onRemoved and from the standalone tab destroy():
  // leave fullscreen (without touching a disposed widget) and flush/clear the
  // pending standalone persistence timer.
  uniCanvasModeWidgets.delete(widget);
  exitUniCanvasFullscreen(widget);
  flushStandalonePersistence(widget);
  widget._vnccsPoseKeysAbort?.abort();
  widget._vnccsPoseKeysAbort = null;
}

function readStandalonePersistedStateValue() {
  try {
    const raw = window.localStorage?.getItem(UNICANVAS_STANDALONE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const state = parsed && typeof parsed === "object" ? parsed.state : null;
    if (!state || typeof state !== "object" || !Array.isArray(state.layers)) return "";
    // The widget's own restore pipeline reads this hidden state widget; the
    // storage marker keeps it from reaching for the node-mode server cache.
    state.storage = "local";
    return JSON.stringify(state);
  } catch (err) {
    console.warn("[VNCCS UniCanvas] Standalone state restore failed", err);
    return "";
  }
}

function createStandaloneWidget(UniCanvasWidgetClass) {
  // No node and no workflow: the stub only feeds the existing restore pipeline
  // (hidden unicanvas_state widget) and carries a size hint.
  const stubNode = {
    id: undefined,
    inputs: [],
    size: [1280, 860],
    widgets: [{ name: "unicanvas_state", value: readStandalonePersistedStateValue() }],
  };
  const widget = new UniCanvasWidgetClass(stubNode);
  widget.standalone = true;
  installUniCanvasWidgetModes(widget);
  return widget;
}

function findUniCanvasSidebarRail(doc) {
  return doc.querySelector("nav.side-tool-bar-container") || doc.querySelector(".side-tool-bar-container");
}

function applyUniCanvasStandaloneShellInset(shell, doc) {
  // Entering the standalone tab hides all ComfyUI chrome and keeps only the
  // icon sidebar visible: the app surface stops exactly at the tab strip.
  const rail = findUniCanvasSidebarRail(doc);
  const railRect = rail?.getBoundingClientRect?.();
  shell.style.top = "0";
  shell.style.bottom = "0";
  shell.style.left = "0";
  shell.style.right = "0";
  const viewportWidth = doc.defaultView?.innerWidth || 0;
  if (railRect && railRect.width > 0 && viewportWidth > 0) {
    if (railRect.left + railRect.width / 2 < viewportWidth / 2) {
      shell.style.left = `${Math.ceil(railRect.right)}px`;
    } else {
      shell.style.right = `${Math.ceil(viewportWidth - railRect.left)}px`;
    }
  } else {
    shell.style.left = "56px";
  }
}

function watchUniCanvasStandaloneTab(onChange) {
  const state = { button: null, buttonObserver: null, scanObserver: null, disposed: false };
  const evaluate = () => {
    if (state.disposed || !state.button) return;
    onChange(state.button.classList.contains("side-bar-button-selected"));
  };
  const attach = (button) => {
    state.buttonObserver?.disconnect();
    state.button = button;
    state.buttonObserver = new MutationObserver(evaluate);
    state.buttonObserver.observe(button, { attributes: true, attributeFilter: ["class"] });
    evaluate();
  };
  const scan = () => {
    if (state.disposed) return;
    if (state.button && state.button.isConnected) return;
    const byTestId = document.querySelector(`[data-testid="${UNICANVAS_STANDALONE_TAB_ID}-tab-button"]`);
    const iconEl = byTestId || document.querySelector(`.${UNICANVAS_SIDEBAR_ICON_CLASS}`);
    const button = byTestId || iconEl?.closest?.("button") || null;
    if (button) {
      state.scanObserver?.disconnect();
      state.scanObserver = null;
      attach(button);
    }
  };
  state.scanObserver = new MutationObserver(scan);
  state.scanObserver.observe(document.body, { subtree: true, childList: true });
  scan();
  return {
    isSelected() {
      return Boolean(state.button?.isConnected && state.button.classList.contains("side-bar-button-selected"));
    },
    dispose() {
      state.disposed = true;
      state.buttonObserver?.disconnect();
      state.scanObserver?.disconnect();
    },
  };
}

// ComfyUI setting (Settings > VNCCS) that opts into the standalone sidebar tab. Off by default:
// the tab is an optional workspace, the node-based UniCanvas always works without it.
export const UNICANVAS_STANDALONE_SETTING_ID = "VNCCS.UniCanvas.StandaloneSidebar";

let standaloneTabHandle = null;

export function readUniCanvasStandaloneSetting() {
  try {
    const store = app?.extensionManager?.setting;
    if (typeof store?.get === "function") return store.get(UNICANVAS_STANDALONE_SETTING_ID) === true;
    return app?.ui?.settings?.getSettingValue?.(UNICANVAS_STANDALONE_SETTING_ID, false) === true;
  } catch (_err) {
    return false;
  }
}

// Registers or removes the standalone tab to match the setting; safe to call repeatedly.
export function syncUniCanvasStandaloneSidebarTab(UniCanvasWidgetClass, enabled) {
  if (enabled) {
    if (!standaloneTabHandle) standaloneTabHandle = registerUniCanvasStandaloneSidebarTab(UniCanvasWidgetClass);
    return;
  }
  if (!standaloneTabHandle) return;
  const handle = standaloneTabHandle;
  standaloneTabHandle = null;
  handle.dispose();
}

export function registerUniCanvasStandaloneSidebarTab(UniCanvasWidgetClass) {
  const extensionManager = app?.extensionManager;
  const registerSidebarTab = extensionManager?.registerSidebarTab;
  if (typeof registerSidebarTab !== "function") return null;
  ensureUniCanvasModeStyles();
  let widget = null;
  let shell = null;
  let mountContainer = null;
  let parking = null;
  let tabWatcher = null;
  let containerObserver = null;
  let windowResizeHandler = null;
  let active = false;

  const syncStandaloneChrome = () => {
    if (!widget) return;
    if (active) {
      if (widget._vnccsFullscreen) exitUniCanvasFullscreen(widget);
      if (!shell) {
        shell = document.createElement("div");
        shell.className = "vnccs-uc2-standalone-shell";
        document.body.appendChild(shell);
        windowResizeHandler = () => {
          if (!shell || !widget) return;
          applyUniCanvasStandaloneShellInset(shell, document);
          widget.resize?.();
        };
        window.addEventListener("resize", windowResizeHandler);
      }
      applyUniCanvasStandaloneShellInset(shell, document);
      if (widget.container.parentNode !== shell) shell.appendChild(widget.container);
      document.body.classList.add(UNICANVAS_STANDALONE_BODY_CLASS);
    } else {
      // Leaving the tab restores the standard ComfyUI chrome.
      if (widget._vnccsFullscreen) exitUniCanvasFullscreen(widget);
      document.body.classList.remove(UNICANVAS_STANDALONE_BODY_CLASS);
      if (windowResizeHandler) window.removeEventListener("resize", windowResizeHandler);
      windowResizeHandler = null;
      shell?.remove();
      shell = null;
      if (!parking) parking = document.createDocumentFragment();
      (mountContainer?.isConnected ? mountContainer : parking).appendChild(widget.container);
    }
    widget.resize?.();
    widget.requestRender?.();
  };

  const setActive = (next) => {
    if (active === next) {
      syncStandaloneChrome();
      return;
    }
    active = next;
    syncStandaloneChrome();
  };

  const teardown = () => {
    setActive(false);
    tabWatcher?.dispose();
    tabWatcher = null;
    containerObserver?.disconnect();
    containerObserver = null;
    mountContainer = null;
    // The history-isolation capture must never undo into a disposed widget.
    standaloneHistoryWidget = null;
    // Flush and clear the pending persistence timer before disposal.
    teardownUniCanvasWidgetModes(widget);
    widget?.dispose?.();
    widget = null;
  };

  registerSidebarTab.call(extensionManager, {
    id: UNICANVAS_STANDALONE_TAB_ID,
    title: "Unicanvas",
    tooltip: "Unicanvas",
    icon: UNICANVAS_SIDEBAR_ICON_CLASS,
    type: "custom",
    render(container) {
      mountContainer = container;
      if (!widget) widget = createStandaloneWidget(UniCanvasWidgetClass);
      standaloneHistoryWidget = widget;
      // Read-only E2E hook (tests/e2e): exposes full-resolution layer pixels
      // and a deep clone of a live pose layer's layer.pose for assertions.
      // No behavior change.
      globalThis.__VNCCS_UC_E2E__ = {
        listLayers: () => (widget.layers || []).map((l) => ({ id: l.id, type: l.type })),
        getLayerPixels: (layerId) => {
          const layer = (widget.layers || []).find((l) => l.id === layerId);
          if (!layer?.canvas) return null;
          return {
            width: layer.canvas.width,
            height: layer.canvas.height,
            dataURL: layer.canvas.toDataURL("image/png"),
          };
        },
        getPoseBackdrop: () => widget.poseEditor?.backdrop?.describe?.() ?? null,
        getLayerPose: (layerId) => {
          const layer = (widget.layers || []).find((l) => l.id === layerId);
          // Deep clone: the caller must not be able to mutate layer state.
          return layer?.pose ? JSON.parse(JSON.stringify(layer.pose)) : null;
        },
      };
      if (!tabWatcher) tabWatcher = watchUniCanvasStandaloneTab(setActive);
      if (!containerObserver && typeof IntersectionObserver === "function") {
        // Belt and braces: hiding/unmounting the tab panel also restores chrome.
        containerObserver = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            // The panel empties (and stops intersecting) once the widget moves into the
            // full-screen shell, so only an unselected tab button may end standalone mode.
            if (!entry.isIntersecting && !tabWatcher?.isSelected()) setActive(false);
          }
        });
      }
      containerObserver?.observe(container);
      setActive(true);
    },
    destroy() {
      teardown();
    },
  });
  return {
    dispose() {
      teardown();
      try {
        extensionManager.unregisterSidebarTab?.(UNICANVAS_STANDALONE_TAB_ID);
      } catch (err) {
        console.warn("[VNCCS UniCanvas] Could not remove the standalone sidebar tab", err);
      }
    },
  };
}
