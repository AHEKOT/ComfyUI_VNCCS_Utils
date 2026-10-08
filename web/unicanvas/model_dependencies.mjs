// Preset and Custom selections share the server-owned family dependency catalog.
export const MODEL_DEPENDENCIES_CSS = `
.vnccs-uc-dependencies .vnccs-uc-modal { width:min(620px, calc(100% - 32px)); max-height:calc(100% - 32px); box-sizing:border-box; font-size:13px; gap:12px; }
.vnccs-uc-dependency-list { overflow:auto; min-height:0; display:flex; flex-direction:column; gap:10px; }
.vnccs-uc-dependency { padding:10px; border:1px solid var(--uc-border); border-radius:var(--uc-radius, 6px); }
.vnccs-uc-dependency label { display:flex; align-items:flex-start; gap:8px; font-weight:600; }
.vnccs-uc-dependency input { flex:none; accent-color:var(--uc-accent); }
.vnccs-uc-dependency-description { color:var(--uc-muted); font-size:12px; overflow-wrap:anywhere; margin:4px 0; }
.vnccs-uc-dependency progress { display:block; width:100%; height:6px; accent-color:var(--uc-accent); }
.vnccs-uc-dependency-status { font-size:12px; margin-top:4px; overflow-wrap:anywhere; }
.vnccs-uc-dependency-status[data-error="true"] { color:var(--uc-danger); }
`;

let nextDialogId = 0;

function downloadState(asset, downloads) {
  const state = downloads?.[asset.download_key] || asset;
  return { ...state, status:asset.installed ? "installed" : state.status || "missing" };
}

export function openModelDependencies(widget, catalog, selection) {
  widget._dependencyDialog?.close();
  const previousFocus = document.activeElement;
  const overlay = document.createElement("div");
  overlay.className = "vnccs-uc-modal-overlay vnccs-uc-dependencies";
  const modal = document.createElement("div");
  modal.className = "vnccs-uc-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  const title = document.createElement("div");
  title.className = "vnccs-uc-modal-title";
  title.id = `vnccs-uc-dependencies-${++nextDialogId}`;
  title.textContent = `${catalog.label} — related files`;
  modal.setAttribute("aria-labelledby", title.id);
  const message = document.createElement("div");
  message.textContent = "Some related files are missing. Choose which files to download. Optional files do not block the base model.";
  const list = document.createElement("div");
  list.className = "vnccs-uc-dependency-list";
  const rows = catalog.assets.filter(asset => !asset.installed).map(asset => {
    const row = document.createElement("div");
    row.className = "vnccs-uc-dependency";
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !asset.installed;
    const name = document.createElement("span");
    name.textContent = asset.name || asset.relative_name;
    label.append(checkbox, name);
    const description = document.createElement("div");
    description.className = "vnccs-uc-dependency-description";
    description.textContent = `${asset.required ? "Required" : "Optional"} · ${asset.description || asset.role || "Related file"}`;
    const progress = document.createElement("progress");
    progress.max = 100;
    progress.setAttribute("aria-label", name.textContent);
    const status = document.createElement("div");
    status.className = "vnccs-uc-dependency-status";
    row.append(label, description, progress, status);
    list.append(row);
    return { asset, row, checkbox, progress, status };
  });
  const summary = document.createElement("div");
  summary.setAttribute("role", "status");
  summary.setAttribute("aria-live", "polite");
  const actions = document.createElement("div");
  actions.className = "vnccs-uc-modal-actions";
  const closeButton = document.createElement("button");
  closeButton.type = "button"; closeButton.className = "vnccs-uc-btn"; closeButton.textContent = "Later";
  const downloadButton = document.createElement("button");
  downloadButton.type = "button"; downloadButton.className = "vnccs-uc-btn primary"; downloadButton.textContent = "Download selected";
  actions.append(closeButton, downloadButton);
  modal.append(title, message, list, summary, actions);
  overlay.append(modal);
  const background = [...widget.container.children].map(element => [element, element.inert]);
  widget.container.append(overlay);
  for (const [element] of background) element.inert = true;
  let closed = false, submitting = false;
  let downloads = Object.fromEntries(catalog.assets.map(asset => [asset.download_key, asset]));
  const missingSelected = () => rows.filter(({ asset, checkbox }) => checkbox.checked
    && !["installed", "success", "queued", "downloading"].includes(downloadState(asset, downloads).status));
  const update = (states = downloads) => {
    if (closed) return;
    const focused = document.activeElement;
    downloads = states;
    let active = 0, missing = 0;
    for (const { asset, row, checkbox, progress, status } of rows) {
      const state = downloadState(asset, downloads);
      const installed = ["installed", "success"].includes(state.status);
      const busy = ["queued", "downloading"].includes(state.status);
      row.hidden = installed;
      if (installed) checkbox.checked = false;
      checkbox.disabled = installed || busy || submitting;
      active += Number(busy);
      missing += Number(!installed);
      progress.hidden = !busy;
      if (state.total_bytes || state.status === "queued") progress.value = Number(state.progress || 0);
      else progress.removeAttribute("value");
      status.dataset.error = String(state.status === "error");
      status.textContent = installed ? "Installed" : state.status === "queued" ? "Queued"
        : state.status === "downloading" ? `${state.message || "Downloading"}${state.total_bytes ? ` — ${Math.floor(state.progress || 0)}% (${(state.downloaded_bytes / 1048576).toFixed(1)} / ${(state.total_bytes / 1048576).toFixed(1)} MB)` : ""}`
        : state.status === "error" ? `Download failed: ${state.message || "Please retry"}` : "Missing";
    }
    if (!missing) { close(); return; }
    summary.textContent = active ? `${active} file(s) downloading or queued. Downloads continue if you close this dialog.`
      : `${missing} file(s) missing.`;
    closeButton.textContent = missing && !active ? "Later" : "Close";
    downloadButton.disabled = submitting || !missingSelected().length;
    downloadButton.textContent = rows.some(({ status }) => status.dataset.error === "true") ? "Retry selected" : "Download selected";
    if (overlay.contains(focused) && focused.disabled) closeButton.focus();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    for (const [element, inert] of background) element.inert = inert;
    if (widget._dependencyDialog === dialog) widget._dependencyDialog = null;
    if (!widget._disposed && previousFocus?.isConnected) previousFocus.focus();
  };
  const error = text => { if (!closed) summary.textContent = text; };
  const dialog = { close, update, error };
  widget._dependencyDialog = dialog;
  closeButton.addEventListener("click", close);
  overlay.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key === "Tab") {
      const focusable = [...modal.querySelectorAll("button, input")].filter(element => !element.disabled && !element.closest("[hidden]"));
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  list.addEventListener("change", () => update());
  downloadButton.addEventListener("click", async () => {
    const keys = missingSelected().map(({ asset }) => asset.download_key);
    if (submitting || !keys.length) return;
    submitting = true; update();
    try {
      const response = await fetch("/vnccs/unicanvas/dependencies/download", {
        method:"POST", headers:{ "Content-Type":"application/json" },
        body:JSON.stringify({ ...selection, download_keys:keys }),
      });
      const result = await response.json();
      if (widget._disposed) return;
      if (!response.ok) throw new Error(result.error || "Download failed");
      for (const key of result.queued || []) widget.presetDownloads[key] = { status:"queued", progress:0 };
      submitting = false; update(widget.presetDownloads);
      widget.startPresetDownloadPolling();
    } catch (err) {
      submitting = false; update(); error(`Download failed: ${err.message || err}`);
    }
  });
  update();
  if (!closed) closeButton.focus();
  if (catalog.assets.some(asset => ["queued", "downloading"].includes(asset.status))) widget.startPresetDownloadPolling();
  return dialog;
}

export async function checkModelDependencies(widget, preset = null) {
  widget._dependencyCheckAbort?.abort();
  widget._dependencyDialog?.close();
  if (widget._disposed || widget._isConfigLinked?.()) return;
  const abort = new AbortController();
  widget._dependencyCheckAbort = abort;
  const selection = { generation_mode:widget.getModelBase(), preset_id:preset?.id || "" };
  if (!preset) {
    for (const key of ["clip_name", "vae_name"]) {
      if (widget.settings?.[key]) selection[key] = widget.settings[key];
    }
  }
  try {
    const response = await fetch(`/vnccs/unicanvas/dependencies?${new URLSearchParams(selection)}`, { signal:abort.signal });
    const catalog = await response.json();
    if (widget._disposed || abort.signal.aborted) return;
    if (!response.ok) throw new Error(catalog.error || "Dependency check failed");
    if (catalog.assets?.some(asset => !asset.installed)) openModelDependencies(widget, catalog, selection);
  } catch (err) {
    if (!abort.signal.aborted && !widget._disposed) widget.setStatus(`Dependency check failed: ${err.message || err}`, true);
  }
}

export function disposeModelDependencies(widget) {
  widget._dependencyCheckAbort?.abort();
  widget._dependencyDialog?.close();
}
