/** Durable canvas selection; staging never belongs to a document. */
const ROOT = "/vnccs/unicanvas/documents";

function formatCacheBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unavailable";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit++; }
  return `${bytes.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

export async function canvasRequest(path = "", method = "GET", body) {
  const response = await fetch(`${ROOT}${path}`, {
    method, cache: "no-store",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function available(widget) {
  if (widget.isPointerDown || widget.transformDraft || widget.poseEditor?.isGestureActive?.()) {
    widget.setStatus("Finish the current edit before managing canvases.", true);
    return false;
  }
  return !widget._disposed && !widget.editingBlocked && !widget.drawInProgress && !widget._canvasOperation && !widget._isRestoring;
}

export async function ensureCanvasDocument(widget) {
  const loadRevision = widget._stateLoadRevision;
  if (await widget.flushStateUpload() === false) throw new Error("Save the current canvas before managing documents.");
  if (widget._disposed || loadRevision !== widget._stateLoadRevision) throw new Error("The canvas editor changed while saving.");
  if (!widget.canvasId) {
    const stateId = widget.getStateCacheId();
    const { document } = await canvasRequest("", "POST", { state_id: stateId });
    if (widget._disposed || loadRevision !== widget._stateLoadRevision || stateId !== widget.getStateCacheId()) throw new Error("The canvas editor changed while saving.");
    widget.canvasId = document.canvas_id;
    widget._canvasPublishedStateId = document.state_id;
    if (widget._capturedStateJSON) {
      const saved = { ...JSON.parse(widget._capturedStateJSON), canvas_id: document.canvas_id };
      widget._frozenStateJSON = JSON.stringify(saved);
      widget.lastUploadedStateJSON = JSON.stringify({ state_id: saved.state_id, state: saved });
    }
    widget.syncToNode();
  }
  return (await canvasRequest(`/${widget.canvasId}`)).document;
}

async function leaveStaging(widget) {
  if (!widget.stagingItems?.length) return true;
  return widget.confirmInWidget("Discard unaccepted results?",
    "Unaccepted results are not saved. Switching canvases will discard them.", "Discard and continue");
}

function rememberSession(widget) {
  if (!widget.canvasId) return;
  widget._canvasSessions ||= new Map();
  widget._canvasSessions.set(widget.canvasId, {
    stateId: widget.getStateCacheId(), undoStack: widget.undoStack, redoStack: widget.redoStack, view: { ...widget.view },
  });
}

export async function applyCanvasDocument(widget, metadata) {
  const loadRevision = widget._stateLoadRevision;
  const response = await fetch(`/vnccs/unicanvas_state/${encodeURIComponent(metadata.state_id)}`, { cache: "no-store" });
  if (!response.ok) throw new Error("The selected canvas cache could not be loaded.");
  const cached = await response.json();
  const state = cached.state;
  if (![1, 2, 3].includes(state?.version) || !Array.isArray(state.layers) || widget.stateHasMissingLayerPixels(state)) {
    throw new Error("The selected canvas has invalid or missing saved pixels.");
  }
  if (widget._disposed || loadRevision !== widget._stateLoadRevision) return false;
  const identity = {
    stateCacheId: widget.stateCacheId, stateBackupKey: widget.stateBackupKey,
    canvasId: widget.canvasId, _stateRestoreFailed: widget._stateRestoreFailed,
  };
  rememberSession(widget);
  widget.cancelDeferredCanvasCommit?.();
  clearTimeout(widget.stateUploadTimer);
  clearTimeout(widget.fullSyncTimer);
  clearTimeout(widget.settingsSyncTimer);
  widget.pendingStateUpload = null;
  widget._stateLoadRevision = (widget._stateLoadRevision || 0) + 1;
  const restoreRevision = widget._stateLoadRevision;
  widget._importRevision = (widget._importRevision || 0) + 1;
  widget._isRestoring = true;
  widget.stateCacheId = metadata.state_id;
  widget.stateBackupKey = null;
  try {
    const restored = await widget.applySerializedState(state, { replaceDocument: true });
    if (widget._disposed || restoreRevision !== widget._stateLoadRevision) return false;
    if (!restored) throw new Error("Canvas restoration failed; the previous canvas is retained.");
    widget.canvasId = metadata.canvas_id;
    widget._canvasPublishedStateId = metadata.state_id;
    widget.stateCacheRevision = Number.isInteger(cached.revision) ? cached.revision : -1;
    widget.stateUploadRevision = widget.outputUploadRevision = Math.max(Date.now(), widget.stateCacheRevision,
      (widget.stateUploadRevision || 0) + 1, (widget.outputUploadRevision || 0) + 1);
    widget.lastUploadedStateJSON = widget.lastUploadedOutputJSON = null;
    widget._pendingStateCacheId = null;
    widget._frozenStateJSON = JSON.stringify({ ...state, canvas_id: metadata.canvas_id });
    widget._capturedStateJSON = null;
    widget._stateRestoreFailed = false;
    widget.stagingItems = [];
    widget.activeStagingIndex = -1;
    widget.clearSamPrompt?.();
    widget.transformDraft = widget.shapeDraft = null;
    widget.poseEditSession = null;
    widget.newPoseLayerId = null;
    widget.lassoPoints = [];
    const session = widget._canvasSessions?.get(metadata.canvas_id);
    const sameSnapshot = session?.stateId === metadata.state_id;
    widget.undoStack = sameSnapshot ? session.undoStack : [];
    widget.redoStack = sameSnapshot ? session.redoStack : [];
    if (session?.view) widget.view = { ...session.view };
    else widget.fitInitialView?.();
    clearTimeout(widget.snapTimeout);
    widget.snapTimeout = null;
    widget.intendedScale = widget.view.scale;
    widget.activeSnapPoint = null;
    widget.setTool?.("move", true);
    widget.updateHistoryButtons?.();
    widget.syncActiveLayerControls?.();
    widget.requestRender?.();
  } catch (error) {
    if (!widget._disposed && restoreRevision === widget._stateLoadRevision) Object.assign(widget, identity);
    throw error;
  } finally {
    if (restoreRevision === widget._stateLoadRevision) widget._isRestoring = false;
  }
  widget.syncToNode();
  widget.persistCanvasPointer?.();
  if (widget.standalone) {
    try { await canvasRequest("/active", "POST", { canvas_id: metadata.canvas_id }); }
    catch (error) { widget.setStatus(`Opened canvas: ${metadata.name}. Server selection could not be remembered: ${error.message}`, true); return true; }
  }
  widget.setStatus(`Opened canvas: ${metadata.name}`);
  return true;
}

async function operation(widget, action) {
  if (!available(widget)) return false;
  widget._canvasOperation = true;
  widget.syncInteractionLock?.();
  try { return await action(); }
  catch (error) { widget.setStatus(`Canvas manager: ${error.message || error}`, true); return false; }
  finally { widget._canvasOperation = false; widget.syncInteractionLock?.(); }
}

export async function openCanvasDocument(widget, metadata) {
  if (!available(widget) || (metadata.canvas_id === widget.canvasId && metadata.state_id === widget.getStateCacheId())) return false;
  if (!await leaveStaging(widget) || !available(widget)) return false;
  return operation(widget, async () => {
    widget.finishPoseEdit?.(true);
    if (!widget._stateRestoreFailed) await ensureCanvasDocument(widget);
    const latest = (await canvasRequest(`/${metadata.canvas_id}`)).document;
    return applyCanvasDocument(widget, latest);
  });
}

async function createSavedCanvas(widget, name) {
  const state = widget.createEmptyCanvasState();
  const response = await fetch("/vnccs/unicanvas_state_upload", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state_id: state.state_id, state, revision: Date.now(), base_revision: -1 }),
  });
  if (!response.ok) throw new Error((await response.json()).error || "New canvas could not be saved.");
  const { document } = await canvasRequest("", "POST", { state_id: state.state_id, name });
  return document;
}

export async function createCanvasDocument(widget) {
  if (!available(widget)) return false;
  const name = await widget.promptInWidget("New canvas", "Canvas name", "Untitled canvas");
  if (name === null || !available(widget) || !await leaveStaging(widget) || !available(widget)) return false;
  return operation(widget, async () => {
    widget.finishPoseEdit?.(true);
    if (!widget._stateRestoreFailed) await ensureCanvasDocument(widget);
    return applyCanvasDocument(widget, await createSavedCanvas(widget, name));
  });
}

export async function deleteCanvasDocument(widget, metadata) {
  if (!available(widget)) return false;
  const confirmed = await widget.confirmInWidget("Delete canvas?",
    "Remove this canvas from the manager? Saved workflow snapshots remain available.", "Delete canvas");
  if (!confirmed || !available(widget)) return false;
  if (metadata.canvas_id === widget.canvasId && (!await leaveStaging(widget) || !available(widget))) return false;
  return operation(widget, async () => {
    if (metadata.canvas_id === widget.canvasId) widget.finishPoseEdit?.(true);
    const current = await ensureCanvasDocument(widget);
    const target = metadata.canvas_id === widget.canvasId ? current : metadata;
    if (target.canvas_id === widget.canvasId) {
      const { documents } = await canvasRequest();
      const replacement = documents.find(item => item.canvas_id !== target.canvas_id)
        || await createSavedCanvas(widget, "Untitled canvas");
      if (!await applyCanvasDocument(widget, replacement)) return false;
    }
    await canvasRequest(`/${target.canvas_id}`, "DELETE", { expected_state_id: target.state_id });
    widget._canvasSessions?.delete(target.canvas_id);
    return true;
  });
}

export async function openCanvasManager(widget) {
  if (!available(widget)) return;
  const overlay = document.createElement("div");
  overlay.className = "vnccs-uc-modal-overlay";
  const modal = document.createElement("div");
  modal.className = "vnccs-uc-modal vnccs-uc-canvas-manager";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", "Canvas manager");
  const title = document.createElement("div");
  title.className = "vnccs-uc-modal-title";
  title.textContent = "Canvas manager";
  const note = document.createElement("p");
  note.textContent = "Each canvas keeps its own layers, references and generation settings.";
  const list = document.createElement("div");
  list.className = "vnccs-uc-canvas-list";
  const message = document.createElement("div");
  message.setAttribute("role", "status");
  const actions = document.createElement("div");
  actions.className = "vnccs-uc-modal-actions";
  const previousFocus = document.activeElement;
  const close = () => { overlay.remove(); previousFocus?.focus?.(); };
  const closeButton = widget._button("Close", "vnccs-uc-btn", close);
  const create = widget._button("New canvas", "vnccs-uc-btn primary", async () => {
    if (await createCanvasDocument(widget)) close();
    else message.textContent = widget.status?.textContent || "Canvas could not be created.";
  });
  actions.append(closeButton, create);
  modal.append(title, note, list, message, actions);
  overlay.append(modal);
  const reload = async () => {
    const scrollTop = list.scrollTop;
    message.textContent = "Loading canvases…";
    try {
      const catalog = await operation(widget, async () => { if (!widget._stateRestoreFailed) await ensureCanvasDocument(widget); return canvasRequest(); });
      if (!catalog) { message.textContent = "Canvases could not be loaded. Check the editor status."; return; }
      const { documents } = catalog;
      if (!overlay.isConnected || widget._disposed) return;
      list.replaceChildren();
      for (const item of documents) {
        const row = document.createElement("div");
        row.className = "vnccs-uc-canvas-card";
        row.classList.toggle("is-current", item.canvas_id === widget.canvasId);
        const copy = document.createElement("div");
        copy.className = "vnccs-uc-canvas-copy";
        const name = document.createElement("strong");
        name.textContent = item.name;
        const details = document.createElement("small");
        details.textContent = `${item.layer_count} layers · ${item.panorama ? "Panorama" : "Canvas"} · Cache: ${formatCacheBytes(item.cache_bytes)} · #${item.canvas_id.slice(0, 8)}`;
        details.title = `Disk usage of saved snapshots and output caches. Current snapshot: ${formatCacheBytes(item.current_cache_bytes)}. Saved snapshots: ${item.snapshot_count ?? "Unavailable"}.`;
        copy.append(name, details);
        const current = item.canvas_id === widget.canvasId && item.state_id === widget.getStateCacheId();
        const open = widget._button(current ? "Current" : "Open", "vnccs-uc-btn", async () => {
          if (await openCanvasDocument(widget, item)) close();
          else message.textContent = widget.status?.textContent || "Canvas could not be opened.";
        });
        open.disabled = current;
        const rename = widget._button("Rename", "vnccs-uc-btn", async () => {
          const name = await widget.promptInWidget("Rename canvas", "Canvas name", item.name);
          if (name === null || !available(widget)) return;
          await operation(widget, async () => canvasRequest(`/${item.canvas_id}`, "PATCH", { name, expected_state_id: item.state_id }));
          await reload();
        });
        const remove = widget._button("Delete", "vnccs-uc-btn danger", async () => {
          await deleteCanvasDocument(widget, item);
          await reload();
        });
        row.append(copy, open, rename, remove);
        list.append(row);
      }
      list.scrollTop = scrollTop;
      message.textContent = documents.length ? "" : "No saved canvases.";
    } catch (error) { message.textContent = error.message || String(error); }
  };
  overlay.addEventListener("pointerdown", event => { if (event.target === overlay) close(); });
  overlay.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.target.closest?.(".vnccs-uc-modal-overlay") !== overlay) return;
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key === "Tab") {
      const buttons = [...modal.querySelectorAll("button:not(:disabled)")];
      const index = buttons.indexOf(document.activeElement);
      if (buttons.length && ((event.shiftKey && index <= 0) || (!event.shiftKey && index === buttons.length - 1))) {
        event.preventDefault(); buttons[event.shiftKey ? buttons.length - 1 : 0].focus();
      }
    }
  });
  widget.container.append(overlay);
  closeButton.focus();
  await reload();
}

export function installCanvasDocuments(widget) {
  widget.openCanvasManager = () => openCanvasManager(widget);
  widget.createCanvasDocument = () => createCanvasDocument(widget);
  const button = widget._button("Canvases", "vnccs-uc-btn vnccs-uc-canvas-manager-button", widget.openCanvasManager, "Manage canvases");
  const create = widget._button('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    "vnccs-uc-btn vnccs-uc-icon vnccs-uc-new-canvas", widget.createCanvasDocument, "New canvas");
  create.setAttribute("aria-label", "New canvas");
  const actions = document.createElement("div");
  actions.className = "vnccs-uc-canvas-actions";
  actions.append(button, create);
  widget.settingsBar.append(actions);
  if (document.getElementById("vnccs-uc-documents-style")) return;
  const style = document.createElement("style");
  style.id = "vnccs-uc-documents-style";
  style.textContent = `
    .vnccs-uc-canvas-manager { width:min(760px,calc(100% - 24px)); max-height:90%; }
    .vnccs-uc-canvas-manager p,.vnccs-uc-canvas-copy small { color:var(--vnccs-uc-text-muted,#b8b3c5); }
    .vnccs-uc-canvas-list { max-height:60vh; overflow:auto; display:grid; gap:8px; }
    .vnccs-uc-canvas-card { display:flex; gap:8px; align-items:center; border:1px solid #45414f; border-radius:10px; padding:12px; }
    .vnccs-uc-canvas-card.is-current { border-color:#ff8fa3; background:#ff8fa312; }
    .vnccs-uc-canvas-copy { flex:1; min-width:0; display:grid; gap:4px; overflow-wrap:anywhere; }
    .vnccs-uc-canvas-manager button:focus-visible { outline:2px solid #ff8fa3; outline-offset:2px; }
    @media(max-width:600px) { .vnccs-uc-canvas-card { flex-wrap:wrap; } .vnccs-uc-canvas-copy { flex-basis:100%; } }
  `;
  document.head.append(style);
}
