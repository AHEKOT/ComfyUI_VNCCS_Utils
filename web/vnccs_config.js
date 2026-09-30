import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { installCustomSelects } from "./vnccs_custom_select.mjs";
import {
  ensureConfigStyles,
  createCollapsibleSection,
  createStatusDot,
  createSliderNumber,
  createSwitch,
} from "./vnccs_config_ui.mjs";
import { referenceConventionHint, referenceSlotName } from "./vnccs_unicanvas_prompt_guide.mjs";

// MiniMax H3 (<Picture N>) and Qwen-Image-2.1 (<image N>) accept up to 10
// reference images beyond the working area. Inputs appear one at a time:
// connecting reference_image_N reveals the next optional socket, up to 10.
const REFERENCE_LIMIT = 10;
const CONNECTION_INPUTS = ["model", "clip", "vae", "audio_vae"];
const LORA_RECENTS_KEY = "vnccs-config-recent-loras";
const LORA_LIST_MAX_ROWS = 5;
// The node may be shorter than its content (user-resized): the panel then scrolls.
const MIN_UI_HEIGHT = 160;
const referenceName = (index) => "reference_image_" + index;

class UniCanvasConfigWidget {
  constructor(node) {
    this.node = node;
    this.state = this._readState();
    if (!this.state.open || typeof this.state.open !== "object") this.state.open = { loras: true, edit: true };
    this.loraNames = [];
    this.dragLoraIndex = null;
    this.filter = "";
    this._syncingReferences = false;

    ensureConfigStyles();
    this.container = document.createElement("div");
    this.container.className = "vnccs-config-ui";
    this.container.addEventListener("wheel", (event) => {
      if (this._canScroll(this.container, event.deltaY) || this._canScroll(event.target.closest?.(".vnccs-cfg-lora-list"), event.deltaY)) {
        event.stopPropagation();
      }
    }, { passive: true });

    // --- What the config does + which model sockets are wired ------------
    const intro = document.createElement("div");
    intro.className = "vnccs-cfg-intro";
    const introTitle = document.createElement("div");
    introTitle.className = "vnccs-cfg-intro-title";
    introTitle.textContent = "Overrides UniCanvas";
    const introText = document.createElement("div");
    introText.className = "vnccs-cfg-intro-text";
    introText.textContent = "When linked to a UniCanvas node, its model, CLIP, VAE, LoRAs and reference images come from here; those UniCanvas controls are greyed out.";
    this.statusRow = document.createElement("div");
    this.statusRow.className = "vnccs-cfg-status";
    this.statusDots = {};
    for (const name of CONNECTION_INPUTS) {
      const dot = createStatusDot(name);
      this.statusDots[name] = dot;
      this.statusRow.appendChild(dot.root);
    }
    intro.append(introTitle, introText, this.statusRow);
    this.container.appendChild(intro);

    // --- LoRA stack section ---------------------------------------------
    this.loraSection = createCollapsibleSection({
      title: "LoRA stack",
      open: this.state.open.loras !== false,
      onToggle: (open) => {
        this.state.open.loras = open;
        this._writeState();
      },
    });
    this.container.appendChild(this.loraSection.root);

    const toolbar = document.createElement("div");
    toolbar.className = "vnccs-cfg-row";
    this.filterInput = document.createElement("input");
    this.filterInput.className = "vnccs-cfg-input vnccs-cfg-grow";
    this.filterInput.placeholder = "Filter by name";
    this.filterInput.addEventListener("input", () => {
      this.filter = this.filterInput.value.trim().toLowerCase();
      this.renderLoras();
    });
    const addBtn = this._toolbarButton("+ Add LoRA", "add-lora");
    addBtn.classList.add("primary");
    toolbar.append(this.filterInput, addBtn);
    const bulk = document.createElement("div");
    bulk.className = "vnccs-cfg-row";
    bulk.append(
      this._toolbarButton("All on", "enable-all"),
      this._toolbarButton("All off", "disable-all"),
      this._toolbarButton("Sort", "sort"),
      this._toolbarButton("Clear", "clear-all"),
    );
    this.loraList = document.createElement("div");
    this.loraList.className = "vnccs-cfg-lora-list";
    this.loraList.style.display = "flex";
    this.loraList.style.flexDirection = "column";
    this.loraList.style.gap = "6px";
    this.loraSection.body.append(toolbar, this.loraList, bulk);

    // --- Edit model & references section --------------------------------
    this.editSection = createCollapsibleSection({
      title: "Edit model & references",
      open: this.state.open.edit !== false,
      onToggle: (open) => {
        this.state.open.edit = open;
        this._writeState();
      },
    });
    this.editSwitch = createSwitch(!!this.state.edit_model, (next) => {
      this.state.edit_model = next;
      this._syncReferenceInputs();
      this._writeState();
    });
    // The switch lives in the section header: keep its click from also
    // collapsing the section.
    this.editSwitch.root.addEventListener("click", (event) => event.stopPropagation());
    this.editSection.root.querySelector(".vnccs-cfg-section-head").appendChild(this.editSwitch.root);
    this.container.appendChild(this.editSection.root);

    this.refList = document.createElement("div");
    this.refList.className = "vnccs-cfg-refs";
    this.refHint = document.createElement("div");
    this.refHint.className = "vnccs-cfg-hint";
    this.editSection.body.append(this.refHint, this.refList);

    // Native selects (LoRA names) use the shared custom selector; the mutation
    // observer inside covers rows re-rendered later.
    installCustomSelects(this.container);

    this.container.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action], [data-lora-action]");
      if (!btn) return;
      const action = btn.dataset.action || btn.dataset.loraAction;
      if (action === "add-lora") {
        this.state.loras.push({ name: this._defaultNewLora(), strength: 1.0, clip_strength: null, enabled: true });
        this.renderLoras();
        this._writeState();
      } else if (action === "remove-lora") {
        this.state.loras.splice(Number(btn.dataset.index), 1);
        this.renderLoras();
        this._writeState();
      } else if (action === "enable-all" || action === "disable-all") {
        const enabled = action === "enable-all";
        this.state.loras.forEach((entry) => { entry.enabled = enabled; });
        this.renderLoras();
        this._writeState();
      } else if (action === "clear-all") {
        this.state.loras = [];
        this.renderLoras();
        this._writeState();
      } else if (action === "sort") {
        this.state.loras.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        this.renderLoras();
        this._writeState();
      }
    });
    // Realtime rule (AGENTS.md): strength updates from `input`, never on release.
    this.container.addEventListener("input", (e) => {
      const target = e.target;
      const index = Number(target.dataset.index);
      const entry = this.state.loras[index];
      if (!entry) return;
      if (target.dataset.field === "enabled") {
        entry.enabled = target.checked;
        target.closest(".vnccs-cfg-lora")?.classList.toggle("off", !entry.enabled);
      }
      this._writeState();
    });
    this.container.addEventListener("change", (e) => {
      const target = e.target;
      if (target.dataset.field === "name") {
        const entry = this.state.loras[Number(target.dataset.index)];
        if (!entry) return;
        entry.name = target.value;
        this._bumpRecentLora(target.value);
        this._writeState();
      }
    });

    this._loadLoraNames().then(() => {
      this.renderLoras();
      this._syncReferenceInputs();
      this.refreshConnectionStatus();
    });
  }

  _toolbarButton(label, action) {
    const btn = document.createElement("button");
    btn.className = "vnccs-cfg-btn";
    btn.textContent = label;
    btn.dataset.action = action;
    return btn;
  }

  _readState() {
    const widget = this.node.widgets?.find((w) => w.name === "node_state");
    try {
      return { loras: [], edit_model: false, ...JSON.parse(widget?.value || "{}") };
    } catch {
      return { loras: [], edit_model: false };
    }
  }

  _writeState() {
    const widget = this.node.widgets?.find((w) => w.name === "node_state");
    if (widget) widget.value = JSON.stringify(this.state);
    this._updateStackBadge();
    this.fitNode();
  }

  _canScroll(element, deltaY) {
    if (!element || element.scrollHeight <= element.clientHeight + 1) return false;
    if (deltaY < 0) return element.scrollTop > 0;
    return element.scrollTop + element.clientHeight < element.scrollHeight - 1;
  }

  // Full height of the panel content, including what is scrolled out of view.
  contentHeight() {
    return Math.ceil(this.container.scrollHeight || 0) + 4;
  }

  // The node grows (or shrinks) with its content when rows, sections or reference chips
  // change. A node the user made shorter keeps its size and the panel scrolls instead
  // (getMinHeight stays small), so every row stays reachable at any height.
  fitNode() {
    if (this._fitFrame) return;
    const schedule = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 0);
    this._fitFrame = schedule(() => {
      this._fitFrame = null;
      const content = this.contentHeight();
      if (this._lastContentHeight === content || !this.node.size) return;
      // The first measurement counts as growth, so a fresh node opens fully expanded.
      const grew = this._lastContentHeight === undefined ? content : content - this._lastContentHeight;
      this._lastContentHeight = content;
      const visible = this.container.clientHeight || 0;
      if (!visible) return;
      const overflow = content - 4 - visible;
      // Grow to show newly added content; shrink only when the panel has empty space left.
      const delta = grew > 0 ? Math.min(grew, Math.max(0, overflow)) : overflow < 0 ? overflow : 0;
      if (Math.abs(delta) < 2) return;
      const minHeight = this.node.computeSize?.()?.[1] || 0;
      this.node.setSize?.([this.node.size[0], Math.max(minHeight, (this.node.size[1] || 0) + delta)]);
      this.node.setDirtyCanvas?.(true, true);
    });
  }

  minHeight() {
    return Math.min(MIN_UI_HEIGHT, this.contentHeight());
  }

  async _loadLoraNames() {
    try {
      const res = await api.fetchApi("/vnccs/unicanvas/loras");
      const data = await res.json();
      this.loraNames = data.loras || [];
    } catch {
      this.loraNames = [];
    }
  }

  // Recents power the default name of a newly added row (kept in localStorage,
  // never persisted into node_state).
  _recentLoras() {
    try {
      const raw = JSON.parse(localStorage.getItem(LORA_RECENTS_KEY) || "[]");
      return Array.isArray(raw) ? raw.map(String).slice(0, 5) : [];
    } catch {
      return [];
    }
  }

  _bumpRecentLora(name) {
    if (!name) return;
    const next = [name, ...this._recentLoras().filter((item) => item !== name)].slice(0, 5);
    try {
      localStorage.setItem(LORA_RECENTS_KEY, JSON.stringify(next));
    } catch {
      // localStorage may be unavailable (private mode): recents are optional.
    }
  }

  _defaultNewLora() {
    const recent = this._recentLoras().find((name) => this.loraNames.includes(name));
    return recent || this.loraNames[0] || "";
  }

  refreshConnectionStatus() {
    for (const name of CONNECTION_INPUTS) {
      const input = (this.node.inputs || []).find((item) => item?.name === name);
      this.statusDots[name]?.set(input?.link != null);
    }
  }

  // Called on every graph connection change; the reference sync itself mutates
  // inputs, so it re-enters guarded (the flag swallows the echo events).
  onGraphConnectionsChanged() {
    if (this._syncingReferences) return;
    this.refreshConnectionStatus();
    this._syncReferenceInputs();
  }

  _syncReferenceInputs() {
    if (this._syncingReferences) return;
    this._syncingReferences = true;
    try {
      for (let n = 1; n <= REFERENCE_LIMIT; n++) {
        const name = referenceName(n);
        const inputs = this.node.inputs || [];
        const index = inputs.findIndex((input) => input?.name === name);
        // Incremental reveal: socket 1 appears with Edit model, socket N+1 only
        // once socket N is actually connected - up to the 10-image family limit.
        const previous = n === 1 ? null : inputs.find((input) => input?.name === referenceName(n - 1));
        const previousConnected = n === 1 || (previous != null && previous.link != null);
        const shouldExist = !!this.state.edit_model && previousConnected;
        if (shouldExist && index === -1) {
          this.node.addInput(name, "IMAGE");
        } else if (!shouldExist && index !== -1) {
          if (typeof this.node.disconnectInput === "function") this.node.disconnectInput(index);
          this.node.removeInput(index);
        }
      }
      this.node.setDirtyCanvas?.(true, true);
    } finally {
      this._syncingReferences = false;
    }
    this.renderReferenceSlots();
  }

  _connectedReferenceCount() {
    let count = 0;
    for (let n = 1; n <= REFERENCE_LIMIT; n++) {
      const input = (this.node.inputs || []).find((item) => item?.name === referenceName(n));
      if (input?.link != null) count = n + 1;
    }
    return Math.min(REFERENCE_LIMIT, count);
  }

  _graphLink(id) {
    const links = this.node.graph?.links ?? this.node.graph?._links;
    if (id == null || !links) return null;
    return typeof links.get === "function" ? links.get(id) : links[id] ?? null;
  }

  _graphNode(id) {
    return this.node.graph?.getNodeById?.(id) ?? null;
  }

  // The UniCanvas node this config feeds: its Mode (model family) decides how the prompt
  // names the references.
  _linkedUniCanvas() {
    for (const output of this.node.outputs || []) {
      for (const id of output?.links || []) {
        const target = this._graphNode(this._graphLink(id)?.target_id);
        if (target?.uniCanvasWidget) return target.uniCanvasWidget;
      }
    }
    return null;
  }

  _referenceNaming() {
    const canvas = this._linkedUniCanvas();
    return { index: canvas?.modelDescriptors, mode: canvas?.settings?.generation_mode };
  }

  _resolveInputPreview(name) {
    const input = (this.node.inputs || []).find((item) => item?.name === name);
    if (input?.link == null) return null;
    const link = this._graphLink(input.link);
    const origin = link?.origin_node ?? this._graphNode(link?.origin_id);
    if (!origin) return null;
    // Load Image style nodes: the chosen file names the reference.
    const imageWidget = origin.widgets?.find((widget) => widget?.name === "image");
    const info = origin.images?.[0];
    const raw = String(imageWidget?.value ?? info?.filename ?? "");
    if (raw) {
      const match = raw.match(/^(.*?)(?:\s*\[(input|output|temp)\])?$/);
      const path = match?.[1] || raw;
      const type = match?.[2] || info?.type || "input";
      const slash = path.lastIndexOf("/");
      const filename = slash === -1 ? path : path.slice(slash + 1);
      const params = new URLSearchParams({ filename, type });
      if (slash !== -1) params.set("subfolder", path.slice(0, slash));
      return { url: "/view?" + params.toString(), label: filename, key: raw };
    }
    if (origin.imgs?.[0]?.src) return { url: origin.imgs[0].src, label: origin.title || origin.type, key: origin.imgs[0].src };
    return { url: null, label: origin.title || String(origin.type || "image"), key: String(origin.id) };
  }

  // Cheap signature of everything the reference chips show; checked on canvas draws so a
  // new file in a Load Image node or a Mode change on the linked UniCanvas shows at once.
  _referenceSignature() {
    const { mode } = this._referenceNaming();
    const parts = [this.state.edit_model ? 1 : 0, mode || ""];
    for (let n = 1; n <= REFERENCE_LIMIT; n++) {
      const input = (this.node.inputs || []).find((item) => item?.name === referenceName(n));
      if (!input) break;
      parts.push(input.link == null ? "-" : this._resolveInputPreview(referenceName(n))?.key || String(input.link));
    }
    return parts.join("|");
  }

  refreshReferencesIfChanged() {
    const now = Date.now();
    if (now - (this._lastReferenceCheck || 0) < 250) return;
    this._lastReferenceCheck = now;
    const signature = this._referenceSignature();
    if (signature === this._renderedReferenceSignature) return;
    this.renderReferenceSlots();
  }

  renderReferenceSlots() {
    this.refList.textContent = "";
    this._renderedReferenceSignature = this._referenceSignature();
    this.fitNode();
    if (!this.state.edit_model) {
      this.refHint.textContent = "Turn on Edit model to attach reference images.";
      this._syncSocketLabels();
      return;
    }
    const naming = this._referenceNaming();
    this.refHint.textContent = referenceConventionHint(naming.index, naming.mode) +
      " Connecting one reveals the next slot, up to " + REFERENCE_LIMIT + ".";
    // Always show the next free slot, so the first reference socket is discoverable too.
    const visible = Math.max(1, this._connectedReferenceCount());
    for (let n = 1; n <= visible; n++) {
      const name = referenceName(n);
      const input = (this.node.inputs || []).find((item) => item?.name === name);
      const connected = input?.link != null;
      const preview = this._resolveInputPreview(name);
      const chip = document.createElement("div");
      chip.className = "vnccs-cfg-refchip" + (connected ? " connected" : "");
      const index = document.createElement("span");
      const slot = referenceSlotName(naming.index, naming.mode, n + 1);
      index.className = "vnccs-cfg-refindex" + (slot.natural ? " natural" : "");
      index.textContent = slot.text;
      index.title = slot.natural
        ? "This model family has no reference tag: describe the image in words"
        : "Name this reference with " + slot.text + " in the prompt";
      chip.appendChild(index);
      if (connected && preview) {
        if (preview.url) {
          const img = document.createElement("img");
          img.src = preview.url;
          img.alt = preview.label;
          chip.appendChild(img);
        }
        const label = document.createElement("span");
        label.className = "vnccs-cfg-reflabel";
        label.textContent = preview.label;
        label.title = preview.label;
        chip.appendChild(label);
        const disconnect = document.createElement("button");
        disconnect.className = "vnccs-cfg-x";
        disconnect.title = "Disconnect " + name;
        disconnect.textContent = "\u2715";
        disconnect.addEventListener("click", () => {
          const index2 = (this.node.inputs || []).findIndex((item) => item?.name === name);
          if (index2 !== -1 && typeof this.node.disconnectInput === "function") this.node.disconnectInput(index2);
          this.refreshConnectionStatus();
          this._syncReferenceInputs();
        });
        chip.appendChild(disconnect);
      } else {
        const label = document.createElement("span");
        label.className = "vnccs-cfg-reflabel";
        label.textContent = connected ? name : name + " (optional, next slot)";
        chip.appendChild(label);
      }
      this.refList.appendChild(chip);
    }
    this._syncSocketLabels();
  }

  // A connected reference socket shows the chosen file name instead of reference_image_N.
  _syncSocketLabels() {
    let changed = false;
    for (let n = 1; n <= REFERENCE_LIMIT; n++) {
      const input = (this.node.inputs || []).find((item) => item?.name === referenceName(n));
      if (!input) continue;
      const preview = input.link != null && this.state.edit_model ? this._resolveInputPreview(referenceName(n)) : null;
      const label = preview?.label ? preview.label : undefined;
      if (input.label === label) continue;
      if (label) input.label = label;
      else delete input.label;
      changed = true;
    }
    if (changed) this.node.setDirtyCanvas?.(true, true);
  }

  _updateStackBadge() {
    const total = this.state.loras.length;
    const active = this.state.loras.filter((entry) => entry.enabled).length;
    const sum = this.state.loras
      .filter((entry) => entry.enabled)
      .reduce((acc, entry) => acc + (Number(entry.strength) || 0), 0);
    this.loraSection.setBadge(total ? active + "/" + total + " \u00b7 \u03a3 " + sum.toFixed(2) : "");
  }

  renderLoras() {
    this.loraList.textContent = "";
    if (!this.state.loras.length) {
      const empty = document.createElement("div");
      empty.className = "vnccs-cfg-empty";
      empty.textContent = "No LoRAs: the connected model is used as is.";
      this.loraList.appendChild(empty);
    }
    this.state.loras.forEach((entry, index) => {
      // LoRA names come from the server listing and from persisted node_state
      // JSON, so every row is built with DOM APIs: no value is ever parsed as
      // HTML/attribute text.
      if (typeof entry.enabled !== "boolean") {
        entry.enabled = entry.enabled === undefined ? true : Boolean(entry.enabled);
      }
      const row = document.createElement("div");
      row.className = "vnccs-cfg-lora" + (entry.enabled ? "" : " off");
      row.draggable = true;
      row.dataset.index = String(index);
      row.title = "Drag to reorder";
      if (this.filter && !String(entry.name).toLowerCase().includes(this.filter)) {
        row.style.display = "none";
      }

      const select = document.createElement("select");
      select.className = "vnccs-cfg-input vnccs-cfg-lora-name";
      select.dataset.field = "name";
      select.dataset.index = String(index);
      const groups = new Map();
      this.loraNames.forEach((name) => {
        const folder = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "loras";
        if (!groups.has(folder)) groups.set(folder, []);
        groups.get(folder).push(name);
      });
      for (const [folder, names] of groups) {
        const group = document.createElement("optgroup");
        group.label = folder;
        names.forEach((name) => {
          const option = document.createElement("option");
          option.value = name;
          option.textContent = name.split("/").pop();
          if (name === entry.name) option.selected = true;
          select.appendChild(option);
        });
        select.appendChild(group);
      }

      const strength = createSliderNumber({
        min: 0, max: 2, step: 0.05, value: entry.strength, label: "Model",
        onInput: (value) => { entry.strength = value; this._writeState(); },
        onChange: (value) => { entry.strength = value; this._writeState(); },
        onReset: (value) => { entry.strength = value; this._writeState(); },
      });
      strength.root.title = "Strength (double-click resets to 1.0)";

      const clip = createSliderNumber({
        min: 0, max: 2, step: 0.05, value: entry.clip_strength == null ? 1 : entry.clip_strength, label: "CLIP",
        onInput: (value) => { entry.clip_strength = value; this._writeState(); },
        onChange: (value) => { entry.clip_strength = value; this._writeState(); },
        onReset: (value) => { entry.clip_strength = value; this._writeState(); },
      });
      clip.root.title = "Clip strength (double-click resets to 1.0)";
      const strengths = document.createElement("div");
      strengths.className = "vnccs-cfg-lora-strengths";
      strengths.append(strength.root, clip.root);

      const enabled = document.createElement("input");
      enabled.type = "checkbox";
      enabled.checked = entry.enabled;
      enabled.title = "Enable LoRA";
      enabled.dataset.field = "enabled";
      enabled.dataset.index = String(index);

      const remove = document.createElement("button");
      remove.className = "vnccs-cfg-x";
      remove.dataset.loraAction = "remove-lora";
      remove.dataset.index = String(index);
      remove.title = "Remove LoRA";
      remove.textContent = "\u2715";

      row.append(enabled, select, remove, strengths);

      row.addEventListener("dragstart", (e) => {
        if (e.target?.closest?.("input, select, button")) {
          e.preventDefault();
          return;
        }
        this.dragLoraIndex = index;
        row.classList.add("dragging");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(index));
        }
      });
      row.addEventListener("dragend", () => {
        this.dragLoraIndex = null;
        row.classList.remove("dragging");
        this.clearLoraDropMarkers();
      });
      row.addEventListener("dragover", (e) => {
        const from = this._dragLoraIndex(e);
        if (from === null || from === index) return;
        e.preventDefault();
        this.markLoraDropTarget(row);
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      });
      row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = this._dragLoraIndex(e);
        this.dragLoraIndex = null;
        this.clearLoraDropMarkers();
        if (from === null || from === index) return;
        this.reorderLoras(from, index);
      });

      this.loraList.appendChild(row);
    });
    // Long stacks scroll instead of stretching the node indefinitely.
    this.loraList.style.overflowY = "auto";
    this.loraList.style.maxHeight = this.state.loras.length > LORA_LIST_MAX_ROWS ? "320px" : "";
    this._updateStackBadge();
    this.fitNode();
  }

  _dragLoraIndex(e) {
    if (Number.isInteger(this.dragLoraIndex) && this.dragLoraIndex >= 0) return this.dragLoraIndex;
    const raw = e.dataTransfer?.getData?.("text/plain");
    const index = Number(raw);
    return raw !== undefined && raw !== "" && Number.isInteger(index) && index >= 0 ? index : null;
  }

  clearLoraDropMarkers() {
    this.loraList?.querySelectorAll?.(".drop-target").forEach((el) => el.classList.remove("drop-target"));
  }

  markLoraDropTarget(row) {
    this.clearLoraDropMarkers();
    row.classList.add("drop-target");
  }

  // Drop commit: the dragged entry lands on the index of the row it was dropped onto, then the
  // stack is re-rendered and persisted (single discrete action, no history entry).
  reorderLoras(from, to) {
    const total = this.state.loras.length;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return false;
    if (from < 0 || to < 0 || from >= total || to >= total) return false;
    const [entry] = this.state.loras.splice(from, 1);
    this.state.loras.splice(to, 0, entry);
    this.renderLoras();
    this._writeState();
    return true;
  }
}

app.registerExtension({
  name: "VNCCS.Config",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "VNCCS_Config") return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      const stateWidget = this.widgets?.find((w) => w.name === "node_state");
      if (stateWidget) {
        stateWidget.type = "hidden";
        stateWidget.hidden = true;
        stateWidget.computeSize = () => [0, -4];
        if (stateWidget.element) stateWidget.element.style.display = "none";
      }
      this.configWidget = new UniCanvasConfigWidget(this);
      const configWidget = this.configWidget;
      this.addDOMWidget("vnccs_config_ui", "ui", configWidget.container, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => configWidget.minHeight(),
      });
      // The widget needs room to render its rows correctly (user request): the
      // node never goes below 300 px wide.
      const MIN_NODE_WIDTH = 300;
      const originalComputeSize = this.computeSize;
      this.computeSize = function () {
        const size = originalComputeSize ? originalComputeSize.apply(this, arguments) : [MIN_NODE_WIDTH, 60];
        return [Math.max(MIN_NODE_WIDTH, size[0] || MIN_NODE_WIDTH), size[1]];
      };
      if (this.size[0] < MIN_NODE_WIDTH) this.setSize([MIN_NODE_WIDTH, this.size[1]]);
      const originalOnResize = this.onResize;
      this.onResize = function (size) {
        if (size && size[0] < MIN_NODE_WIDTH) size[0] = MIN_NODE_WIDTH;
        if (this.size && this.size[0] < MIN_NODE_WIDTH) this.size[0] = MIN_NODE_WIDTH;
        return originalOnResize ? originalOnResize.apply(this, arguments) : undefined;
      };
    };
    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      onConnectionsChange?.apply(this, arguments);
      this.configWidget?.onGraphConnectionsChanged?.();
    };
    const onDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function () {
      const result = onDrawForeground?.apply(this, arguments);
      this.configWidget?.refreshReferencesIfChanged?.();
      return result;
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      clearTimeout(this._vnccsConfigConfigureTimer);
      this._vnccsConfigConfigureTimer = setTimeout(() => {
        const widget = this.configWidget;
        if (!widget) return;
        // The constructor snapshot runs before widgets_values are applied, so re-read the persisted
        // node_state here, then resync the switch, the LoRA rows, the section
        // state and the reference sockets from it.
        widget.state = widget._readState();
        if (!widget.state.open || typeof widget.state.open !== "object") widget.state.open = { loras: true, edit: true };
        widget.editSwitch.set(!!widget.state.edit_model);
        widget.loraSection.setOpen(widget.state.open.loras !== false);
        widget.editSection.setOpen(widget.state.open.edit !== false);
        widget.renderLoras();
        widget._syncReferenceInputs();
        widget.refreshConnectionStatus();
      }, 50);
    };
  },
});