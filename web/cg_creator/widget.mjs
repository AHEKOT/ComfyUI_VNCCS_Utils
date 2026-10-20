import { Factory3DViewer } from "../factory3d/viewer.js?v=20261019.1";
import { FactoryCommandHistory } from "../factory3d/editor_commands.mjs";
import { installCustomSelects } from "../shared/custom_select.mjs";
import { clone, readState, settingsDefaults, frameDimensions, sourceCameraView, MODEL_DEFAULTS } from "./state.mjs";

const BASE = "/vnccs/cg-creator";
const ASPECTS = ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9", "3:2", "2:3"];
const latestModel = (doc, id) => (doc.models || []).filter(model => model.source_image_id === id).at(-1);
const imageCGs = (doc, id) => (doc?.cgs || []).filter(cg => cg.source_image_id === id);

function styles() {
    for (const [id, path] of [["vnccs-3d-factory-styles", "../factory3d/styles.css?v=20260908.2"], ["vnccs-cg-creator-styles", "./styles.css?v=20261019.1"]]) {
        let link = document.getElementById(id);
        if (!link) { link = document.createElement("link"); link.id = id; link.rel = "stylesheet"; document.head.appendChild(link); }
        link.href = new URL(path, import.meta.url).href;
    }
}

export class CGCreatorWidget {
    constructor(node, api) {
        styles(); this.node = node; this.api = api;
        this.state = null; this.document = null; this.scene = null; this.viewer = null; this.catalog = [];
        this.epoch = 0; this.restoring = true; this.busy = false; this.disposed = false;
        this.events = new AbortController(); this.operations = Promise.resolve(); this.saveSerial = Promise.resolve(); this.dialogs = new Set();
        this.history = new FactoryCommandHistory({ onRestore: camera => this.viewer.setCameraState(camera, { emit: true }) });
        this.container = document.createElement("div"); this.container.className = "vnccs-i3s vnccs-cg-creator";
        this.container.innerHTML = `<header class="bg-header"><strong>VNCCS CG Creator</strong></header>
            <section class="cg-workspace">
                <aside class="bg-panel bg-model-source"><h3>Source background</h3><select data-library aria-label="Saved background"></select><button data-refresh>Refresh library</button>
                    <select data-image aria-label="Background variant"></select><img data-model-source alt="Selected background"><span data-model-dimensions></span>
                    <h3>Model generation</h3><div class="bg-model-card"><strong>TripoSplat</strong><span>Single-image Gaussian splat</span></div>
                    <label class="bg-field"><span>Gaussians</span><select data-model-setting="num_gaussians">${[32768, 65536, 131072, 262144, 524288, 1048576].map(n => `<option value="${n}">${n / 1024}K</option>`).join("")}</select></label>
                    <div class="bg-row"><label class="bg-field"><span>Steps</span><input type="number" min="1" max="100" data-model-setting="steps"></label><label class="bg-field"><span>Guidance</span><input type="number" min="1" max="20" step="0.1" data-model-setting="guidance_scale"></label></div>
                    <label class="bg-field"><span>Seed</span><input type="number" min="0" max="2147483647" data-model-setting="seed"></label>
                    <div class="bg-ready">Full background preserved</div><button class="primary bg-wide" data-action="model">Create model</button><span data-model-status></span><button data-settings>CG settings</button>
                </aside>
                <section class="bg-panel bg-viewport-panel"><h3>Model viewport <span class="bg-badge">Raw splat</span></h3><div class="bg-viewport"><div class="bg-camera-toolbar"><label>FOV <input type="range" min="5" max="120" step="0.1" value="60" data-fov aria-label="Camera field of view"><input type="number" min="5" max="120" step="0.1" value="60" data-fov-number aria-label="Exact camera field of view"></label><button class="primary" data-save-view>Save view</button><button data-recenter>Recenter</button></div><div data-viewer></div><div class="bg-viewer-empty" data-viewer-empty>Select a saved background and create its model.</div></div><div class="bg-hint">Drag to look · Middle-drag to pan · Scroll to move · Ctrl Z to undo</div></section>
                <aside class="bg-panel bg-cg-panel"><h3>Generated CG <span class="bg-badge" data-cg-count>0</span></h3><div class="bg-cg-list" data-cgs></div><p data-cg-empty>Save a camera view to generate its finished CG.</p></aside>
            </section><footer class="bg-status"><span role="status"></span><progress max="100" value="0" hidden></progress><button data-stop hidden>Stop</button></footer>`;
        this.host = this.container.querySelector("[data-viewer]"); this.status = this.container.querySelector("[role=status]");
        this.fov = this.container.querySelector("[data-fov]"); this.fovNumber = this.container.querySelector("[data-fov-number]");
        this.customSelects = installCustomSelects(this.container);
        this.on(this.container, "click", event => this.click(event)); this.on(this.container, "input", event => this.input(event)); this.on(this.container, "change", event => this.change(event));
        for (const type of ["change", "blur", "keyup", "pointerup", "pointercancel"]) this.on(this.container, type, () => this.commitGesture());
        this.on(this.host, "pointerdown", () => this.beginGesture(), { capture: true });
        this.on(this.host, "pointermove", () => { if (this.canEditCamera() && this.history.pending) this.sync(); });
        for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) this.on(this.host, type, () => this.commitGesture());
        this.on(this.host, "wheel", () => { this.beginGesture(); clearTimeout(this.wheelTimer); this.wheelTimer = setTimeout(() => this.commitGesture(), 180); }, { capture: true, passive: true });
        this.on(this.container, "keydown", event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.target.closest("input,textarea")) { event.preventDefault(); if (this.canEditCamera()) this.history[event.shiftKey ? "redo" : "undo"](); } });
        this.on(window, "beforeunload", event => { if (this.unsaved && this.draftFailed) { event.preventDefault(); event.returnValue = ""; } });
        this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(this.container); this.updateControls();
    }

    on(target, type, callback, options = {}) { target.addEventListener(type, callback, { ...options, signal: this.events.signal }); }
    message(text, error = false) { if (!this.disposed) { this.status.textContent = text; this.status.classList.toggle("error", error); } }
    async request(path, options = {}) {
        const response = await this.api.fetchApi(BASE + path, { ...options, signal: this.events.signal }), result = await response.json();
        if (!response.ok) throw new Error(result.error || `Request failed: HTTP ${response.status}`);
        return result;
    }
    json(path, data, method = "POST") { return this.request(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }); }
    canEditCamera() { return !this.disposed && !this.restoring && !this.busy && !this.loadingModel && Boolean(this.viewer && this.scene && this.scene.model_id === this.state?.model_id); }
    beginGesture() { if (this.canEditCamera()) this.history.begin("Camera", this.viewer.getCameraState()); }
    commitGesture() { if (this.canEditCamera()) { this.sync(); this.history.commit(this.viewer.getCameraState()); } }
    updateControls() {
        for (const control of this.container.querySelectorAll("button,input,select,textarea")) control.disabled = this.busy || this.restoring || Boolean(this.document?._recovery || this.document?.archived);
        for (const control of this.container.querySelectorAll("[data-library],[data-refresh]")) control.disabled = this.busy || this.restoring;
        for (const control of this.container.querySelectorAll("[data-fov],[data-fov-number],[data-recenter]")) control.disabled = !this.canEditCamera();
        this.container.querySelector("[data-save-view]").disabled = !this.canEditCamera() || Boolean(this.document?._recovery || this.document?.archived);
        this.container.querySelector('[data-action="model"]').disabled ||= !this.state?.selected_image_id;
        this.host.inert = !this.canEditCamera();
        const stop = this.container.querySelector("[data-stop]"); stop.hidden = !this.busy || !this.jobId; stop.disabled = !this.busy || !this.jobId;
        this.container.querySelector("progress").hidden = !this.busy;
    }

    invalidateRestore() { ++this.epoch; this.restoring = true; this.busy = false; this.jobId = ""; clearTimeout(this.saveTimer); this.updateControls(); }
    restore() {
        const epoch = ++this.epoch; this.restoring = true; this.message("Loading saved backgrounds…");
        this.operations = this.operations.catch(() => {}).then(async () => {
            if (this.disposed || epoch !== this.epoch) return;
            try {
                const state = readState(this.node.widgets.find(item => item.name === "cg_data").value);
                const [config, catalog] = await Promise.all([this.request("/config"), this.request("/backgrounds")]);
                if (this.disposed || epoch !== this.epoch) return;
                this.state = state; this.document = null; this.unsaved = false; this.config = config; this.catalog = catalog.backgrounds;
                if (state.background_id) await this.acceptDocument(await this.request(`/backgrounds/${state.background_id}`), false, epoch);
                if (this.disposed || epoch !== this.epoch) return;
                this.restoreDraft(); this.restoring = false; this.render(); this.sync();
                this.message(this.draftConflict ? "Recovered settings conflict with a newer scene. Review CG settings and save to confirm them." : this.document?._recovery ? "Recovered backup is read-only. The original data is preserved." : this.catalog.length ? "Set the camera and save a view to generate its CG." : "Create a background in VNCCS Background Creator, then refresh this library.", Boolean(this.document?._recovery || this.draftConflict));
            } catch (error) { if (!this.disposed && epoch === this.epoch) this.message(error.message + " Original workflow data is preserved.", true); }
            this.updateControls();
        }); return this.operations;
    }

    async acceptDocument(document, adopt = true, epoch = this.epoch) {
        if (this.disposed || epoch !== this.epoch) return;
        if (!adopt && document.background_id !== this.state.background_id) throw new Error("The response belongs to another background.");
        this.document = document; this.catalog = this.catalog.filter(item => item.background_id !== document.background_id);
        if (!document.archived) this.catalog.push(document);
        if (adopt) {
            this.state.background_id = document.background_id; this.state.selected_image_id = document.selected_image_id || document.images[0]?.image_id || "";
            this.state.model_id = latestModel(document, this.state.selected_image_id)?.model_id || "";
            this.state.settings = settingsDefaults(document.cg_settings); this.state.model_settings = { ...MODEL_DEFAULTS, ...document.model_settings };
            this.state.selected_cg_id = imageCGs(document, this.state.selected_image_id).at(-1)?.cg_id || "";
            const selected = document.cgs.find(cg => cg.cg_id === this.state.selected_cg_id);
            if (selected) this.state.model_id = selected.model_id;
            this.state.camera = null; this.state.frame = null;
        }
        if (this.state.model_id) await this.showModel(epoch);
        if (this.disposed || epoch !== this.epoch) return;
        this.render(); this.sync(); this.updateControls();
    }

    async showModel(epoch = this.epoch) {
        const modelId = this.state.model_id, backgroundId = this.state.background_id;
        if (!modelId) return;
        const scene = await this.request(`/backgrounds/${backgroundId}/models/${modelId}`);
        if (this.disposed || epoch !== this.epoch || modelId !== this.state.model_id) return;
        if (!this.viewer) {
            this.viewer = new Factory3DViewer(this.host, { cameraDragScale: 0.7, resolveAssetURL: path => this.api.apiURL(path),
                onSelectionChange: () => this.viewer.select("", { emit: false }),
                onStateChange: value => { if (this.canEditCamera()) { this.state.camera = clone(value.camera); this.syncFov(value.camera); this.sync(); } },
                onError: error => this.message(String(error.message || error), true) });
            this.viewer.controls.enableDamping = false; this.viewer.canvas.setAttribute("aria-label", "CG camera. Drag to look, middle-drag to pan, scroll to move.");
        }
        this.loadingModel = true;
        try {
            if (this.scene?.model_id !== modelId) { const result = await this.viewer.setScene(scene); if (result.failures.length) throw new Error("The model could not be loaded."); this.history.clear(); }
            if (this.disposed || epoch !== this.epoch || modelId !== this.state.model_id) return;
            this.scene = scene; this.state.selected_image_id = scene.source_image_id;
            const selected = this.document.cgs.find(cg => cg.cg_id === this.state.selected_cg_id && cg.model_id === modelId);
            const camera = this.state.camera || selected?.camera || sourceCameraView(scene.objects[0].source_camera || scene.camera);
            const source = this.document.images.find(image => image.image_id === scene.source_image_id);
            const size = this.state.frame || (selected ? { width: selected.width, height: selected.height } : frameDimensions(`${source.width}:${source.height}`, this.state.settings.resolution_mp));
            this.state.camera = clone(camera); this.state.frame = clone(size); this.viewer.setLighting({ preset: "off", background: "#000000" });
            this.viewer.setCaptureSettings({ ...size, show_camera_frame: true }); this.viewer.setCameraState(camera); this.viewer.select("", { emit: false }); this.syncFov(camera);
        } finally { this.loadingModel = false; }
        this.resize();
    }

    render() {
        if (!this.state) return;
        const scroll = [...this.container.querySelectorAll(".bg-panel,.bg-cg-list")].map(element => [element, element.scrollTop, element.scrollLeft]);
        const fill = (selector, entries, value, empty) => {
            const select = this.container.querySelector(selector); select.replaceChildren();
            if (empty) { const option = document.createElement("option"); option.value = ""; option.textContent = empty; select.appendChild(option); }
            for (const [id, label] of entries) { const option = document.createElement("option"); option.value = id; option.textContent = label; select.appendChild(option); }
            select.value = value;
        };
        fill("[data-library]", this.catalog.map(doc => [doc.background_id, doc.name]), this.state.background_id, "Select a background");
        fill("[data-image]", (this.document?.images || []).map((image, i) => [image.image_id, image.settings?.name || `Background ${i + 1}`]), this.state.selected_image_id);
        for (const control of this.container.querySelectorAll("[data-model-setting]")) if (document.activeElement !== control) control.value = this.state.model_settings[control.dataset.modelSetting];
        const source = this.document?.images.find(image => image.image_id === this.state.selected_image_id), image = this.container.querySelector("[data-model-source]");
        image.hidden = !source; if (source) image.src = this.api.apiURL(source.url);
        this.container.querySelector("[data-model-dimensions]").textContent = source ? `${source.width} × ${source.height}` : "";
        this.container.querySelector("[data-model-status]").textContent = this.state.model_id ? "Model ready" : "Model not created";
        const visible = Boolean(this.state.model_id && this.scene?.model_id === this.state.model_id); this.host.hidden = !visible; this.container.querySelector("[data-viewer-empty]").hidden = visible;
        const gallery = this.container.querySelector("[data-cgs]"); gallery.replaceChildren();
        const cgs = imageCGs(this.document, this.state.selected_image_id);
        for (const cg of cgs) {
            const card = document.createElement("button"); card.className = "bg-cg-card"; card.dataset.cgId = cg.cg_id; card.classList.toggle("selected", cg.cg_id === this.state.selected_cg_id);
            const title = document.createElement("strong"); title.textContent = cg.name; const image = document.createElement("img"); image.src = this.api.apiURL(cg.url); image.alt = cg.name;
            const meta = document.createElement("span"); meta.textContent = `${cg.width} × ${cg.height} · FOV ${Math.round(cg.camera.fov)}°`; card.append(title, image, meta); gallery.appendChild(card);
        }
        this.container.querySelector("[data-cg-count]").textContent = String(cgs.length); this.container.querySelector("[data-cg-empty]").hidden = Boolean(cgs.length);
        this.customSelects.refresh(); this.updateControls(); for (const [element, top, left] of scroll) { element.scrollTop = top; element.scrollLeft = left; } this.resize();
    }
    syncFov(camera) { this.fov.value = String(camera.fov); this.fovNumber.value = String(Math.round(camera.fov * 10) / 10); }
    sync() {
        if (this.disposed || this.restoring || !this.state) return;
        if (this.viewer && this.scene?.model_id === this.state.model_id && !this.busy && !this.loadingModel) this.state.camera = this.viewer.getCameraState();
        const raw = JSON.stringify(this.state), widget = this.node.widgets.find(item => item.name === "cg_data");
        if (widget && widget.value !== raw) { widget.value = raw; this.node.properties ??= {}; this.node.properties.cgCreator = raw; this.node.graph?.setDirtyCanvas?.(true, true); } return raw;
    }
    draftKey() {
        this.draftId ??= Math.random().toString(36).slice(2);
        const owner = this.node.id != null && this.node.id !== -1 ? this.node.id : this.draftId;
        return this.state?.background_id ? `VNCCS.CGCreator:${owner}:${this.state.background_id}` : null;
    }
    retainDraft() {
        try { if (this.draftKey()) localStorage.setItem(this.draftKey(), JSON.stringify({ settings: this.state.settings, model_settings: this.state.model_settings, revision: this.document.revision })); this.draftFailed = false; }
        catch (_) { this.draftFailed = true; this.message("Browser recovery is unavailable. Save this workflow until disk persistence succeeds.", true); }
    }
    restoreDraft() {
        this.draftConflict = false;
        try { const raw = this.draftKey() && localStorage.getItem(this.draftKey()); if (!raw) return; const draft = JSON.parse(raw);
            if (!draft || !Number.isInteger(draft.revision) || draft.revision < 1 || !draft.settings || !draft.model_settings) throw new Error("Invalid recovery draft");
            readState(JSON.stringify({ schema_version: 1, settings: draft.settings, model_settings: draft.model_settings }));
            this.state.settings = settingsDefaults(draft.settings); this.state.model_settings = { ...MODEL_DEFAULTS, ...draft.model_settings }; this.unsaved = true;
            this.draftConflict = draft.revision !== this.document.revision;
            if (this.draftConflict) this.message("Recovered settings conflict with a newer scene. Review CG settings and save to confirm them.", true);
        } catch (_) { this.message("A recovery draft could not be read. Its original bytes are preserved.", true); }
    }
    markEdited() { this.draftConflict = false; this.unsaved = true; this.sync(); this.retainDraft(); clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.persist().catch(error => this.message(error.message, true)), 450); }
    persist() {
        clearTimeout(this.saveTimer);
        const operation = this.saveSerial.catch(() => {}).then(async () => {
            if (!this.unsaved || !this.document || this.disposed || this.restoring) return;
            if (this.draftConflict) throw new Error("Review CG settings and save to confirm the recovered settings before continuing.");
            const id = this.state.background_id, epoch = this.epoch, settings = clone(this.state.settings), model = clone(this.state.model_settings);
            const draftKey = this.draftKey(); let draft;
            try { draft = localStorage.getItem(draftKey); } catch (_) {}
            const saved = await this.json(`/backgrounds/${id}`, { revision: this.document.revision, cg_settings: settings, model_settings: model }, "PATCH");
            if (this.disposed || epoch !== this.epoch || id !== this.state.background_id) return;
            this.document = saved; this.unsaved = JSON.stringify(settings) !== JSON.stringify(this.state.settings) || JSON.stringify(model) !== JSON.stringify(this.state.model_settings);
            if (!this.unsaved) { try { if (localStorage.getItem(draftKey) === draft) localStorage.removeItem(draftKey); } catch (_) {} } else this.markEdited();
        }); this.saveSerial = operation; return operation;
    }

    async dialog(title, fields, submitLabel = "Save") {
        const dialog = document.createElement("dialog"); dialog.className = "vnccs-bg-dialog"; const form = document.createElement("form"); form.method = "dialog";
        const heading = document.createElement("h2"); heading.textContent = title; form.appendChild(heading); const controls = {};
        for (const field of fields) {
            const label = document.createElement("label"), text = document.createElement("span"); text.textContent = field.label;
            const control = document.createElement(field.multiline ? "textarea" : field.options ? "select" : "input");
            if (field.options) for (const value of field.options) { const option = document.createElement("option"); option.textContent = value; control.appendChild(option); }
            if (!field.options && !field.multiline) control.type = field.type || "text";
            if (field.type === "number") { control.step = "any"; control.required = true; }
            if (field.type === "checkbox") control.checked = Boolean(field.value); else control.value = field.value ?? "";
            if (field.required) control.required = true; if (field.multiline) control.rows = 5;
            if (field.oninput) control.addEventListener("input", () => field.oninput(control.value));
            label.append(text, control); form.appendChild(label); controls[field.key] = control;
        }
        const row = document.createElement("div"); row.className = "bg-dialog-actions"; const cancel = document.createElement("button"), submit = document.createElement("button");
        cancel.textContent = "Cancel"; cancel.type = "button"; submit.textContent = submitLabel; submit.type = "submit"; row.append(cancel, submit); form.appendChild(row); dialog.appendChild(form); this.container.appendChild(dialog);
        const custom = installCustomSelects(dialog);
        return new Promise(resolve => {
            const finish = value => { if (!this.dialogs.delete(finish)) return; custom.disconnect(); dialog.close(); dialog.remove(); resolve(value); }; this.dialogs.add(finish);
            cancel.onclick = () => finish(null); dialog.oncancel = event => { event.preventDefault(); finish(null); };
            form.onsubmit = event => { event.preventDefault(); if (form.reportValidity()) finish(Object.fromEntries(Object.entries(controls).map(([key, c]) => [key, c.type === "checkbox" ? c.checked : c.value]))); }; dialog.showModal();
        });
    }

    async click(event) {
        const button = event.target.closest("button"); if (!button || !this.container.contains(button) || button.disabled) return; const epoch = this.epoch;
        let navigating = false;
        try {
            if (button.hasAttribute("data-refresh")) { navigating = this.busy = true; this.updateControls(); await this.persist(); const catalog = await this.request("/backgrounds"); if (epoch !== this.epoch || this.disposed) return; this.catalog = catalog.backgrounds; if (this.state.background_id) await this.acceptDocument(await this.request(`/backgrounds/${this.state.background_id}`), false, epoch); this.render(); return; }
            if (button.dataset.cgId) { navigating = this.busy = true; this.updateControls(); const cg = this.document.cgs.find(cg => cg.cg_id === button.dataset.cgId); Object.assign(this.state, { selected_cg_id: cg.cg_id, model_id: cg.model_id, camera: clone(cg.camera), frame: { width: cg.width, height: cg.height } }); await this.showModel(epoch); this.sync(); this.render(); return; }
            if (button.hasAttribute("data-recenter")) { this.beginGesture(); this.viewer.setCameraState(sourceCameraView(this.scene.objects[0].source_camera || this.scene.camera), { emit: true }); this.commitGesture(); return; }
            if (button.hasAttribute("data-stop")) { if (this.jobId) await this.json(`/jobs/${this.jobId}/cancel`, {}); return; }
            if (button.hasAttribute("data-settings")) {
                const gen = this.state.settings.generation;
                const values = await this.dialog("CG refinement settings · Qwen Image 2.1", [
                    { key: "resolution_mp", label: "Resolution · MP", value: this.state.settings.resolution_mp, type: "number" },
                    ...["steps", "cfg", "seed"].map(key => ({ key, label: key.toUpperCase(), value: gen[key], type: "number" })),
                    { key: "sampler", label: "Sampler", value: gen.sampler, options: this.config.samplers }, { key: "scheduler", label: "Scheduler", value: gen.scheduler, options: this.config.schedulers },
                    { key: "prompt_enhance", label: "Prompt enhancement", value: gen.prompt_enhance, type: "checkbox" }, { key: "turbo", label: "Viggle Turbo · 6 steps", value: gen.turbo, type: "checkbox" }]);
                if (!values || epoch !== this.epoch || this.disposed) return;
                this.state.settings.resolution_mp = Number(values.resolution_mp);
                for (const key of ["steps", "cfg", "seed"]) gen[key] = Number(values[key]); for (const key of ["sampler", "scheduler", "prompt_enhance", "turbo"]) gen[key] = values[key];
                if (gen.turbo) { gen.steps = 6; gen.cfg = 1; } this.markEdited(); return;
            }
            if (button.hasAttribute("data-save-view")) {
                const previous = clone(this.state.frame), ratio = value => { const [a, b] = value.split(":").map(Number); return a / b; };
                const aspect = ASPECTS.reduce((best, value) => Math.abs(ratio(value) - previous.width / previous.height) < Math.abs(ratio(best) - previous.width / previous.height) ? value : best, this.state.settings.aspect);
                const values = await this.dialog("Generate CG from this camera", [{ key: "name", label: "CG name", value: `View ${this.document.cgs.length + 1}`, required: true },
                    { key: "aspect", label: "Aspect ratio", value: aspect, options: ASPECTS, oninput: value => { if (epoch === this.epoch && !this.disposed) this.viewer.setCaptureSettings({ ...frameDimensions(value, this.state.settings.resolution_mp), show_camera_frame: true }); } },
                    { key: "prompt", label: "Refinement instruction", value: this.state.settings.prompt, multiline: true, required: true }], "Generate CG");
                if (!values || epoch !== this.epoch || this.disposed) { if (epoch === this.epoch && !this.disposed) this.viewer.setCaptureSettings({ ...previous, show_camera_frame: true }); return; }
                Object.assign(this.state.settings, { prompt: values.prompt, aspect: values.aspect }); this.markEdited(); const size = frameDimensions(values.aspect, this.state.settings.resolution_mp);
                const camera = clone(this.viewer.getCameraState()); this.state.frame = clone(size); this.sync(); this.viewer.setCaptureSettings({ ...size, show_camera_frame: true });
                this.busy = true; this.updateControls(); const raw = await this.viewer.capturePreview({ ...size, cameraState: camera });
                if (epoch !== this.epoch || this.disposed) return; await this.runJob("cg", { name: values.name, camera, model_id: this.state.model_id }, raw); return;
            }
            if (button.dataset.action) await this.runJob(button.dataset.action);
        } catch (error) { if (epoch === this.epoch && !this.disposed) { this.busy = false; this.updateControls(); this.message(error.message, true); } }
        finally { if (navigating && epoch === this.epoch && !this.disposed) { this.busy = false; this.render(); } }
    }
    input(event) {
        if (this.restoring || this.busy || !this.state) return; const control = event.target;
        if (control === this.fov || control === this.fovNumber) { const value = Number(control.value); if (!this.canEditCamera() || !control.value || !Number.isFinite(value)) return;
            this.beginGesture(); this.viewer.setCameraState({ ...this.viewer.getCameraState(), fov: Math.max(5, Math.min(120, value)) }, { emit: true });
        } else if (control.dataset.modelSetting && control.value !== "" && Number.isFinite(Number(control.value))) { this.state.model_settings[control.dataset.modelSetting] = Number(control.value); this.markEdited(); }
    }
    async change(event) {
        if (this.restoring || this.busy) return; const control = event.target; let epoch = this.epoch;
        let navigating = false;
        try {
            if (control.hasAttribute("data-library")) { const id = control.value; if (!id) return; navigating = this.busy = true; this.updateControls(); await this.persist(); if (epoch !== this.epoch || this.disposed) return; epoch = ++this.epoch;
                await this.acceptDocument(await this.request(`/backgrounds/${id}`), true, epoch); this.restoreDraft(); this.render();
            } else if (control.hasAttribute("data-image")) { navigating = this.busy = true; this.updateControls(); this.state.selected_image_id = control.value; this.state.model_id = latestModel(this.document, control.value)?.model_id || ""; this.state.selected_cg_id = ""; this.state.camera = null; this.state.frame = null;
                this.sync(); if (this.state.model_id) await this.showModel(epoch); this.sync(); this.render(); }
        } catch (error) { if (epoch === this.epoch && !this.disposed) this.message(error.message, true); }
        finally { if (navigating && epoch === this.epoch && !this.disposed) { this.busy = false; this.render(); } }
    }

    async runJob(action, extra = {}, raw = null) {
        if (!this.document) throw new Error("Select a saved background first."); const epoch = this.epoch, id = this.state.background_id;
        this.busy = true; this.updateControls(); this.message("Preparing " + action + "…");
        try {
            await this.persist(); if (epoch !== this.epoch || this.disposed || id !== this.state.background_id) return;
            const payload = { action, revision: this.document.revision, image_id: this.state.selected_image_id, model_settings: clone(this.state.model_settings), settings: clone(this.state.settings), ...extra };
            let result; if (raw) { const form = new FormData(); form.append("data", JSON.stringify(payload)); form.append("image", raw, "raw.png"); result = await this.request(`/backgrounds/${id}/jobs`, { method: "POST", body: form }); } else result = await this.json(`/backgrounds/${id}/jobs`, payload);
            if (epoch !== this.epoch || this.disposed || id !== this.state.background_id) return; this.jobId = result.job_id; this.updateControls();
            while (epoch === this.epoch && !this.disposed && id === this.state.background_id) {
                result = await this.request(`/jobs/${this.jobId}`); if (epoch !== this.epoch || this.disposed || id !== this.state.background_id) return;
                this.message(result.message || "Working…"); this.container.querySelector("progress").value = result.progress || 0;
                if (["completed", "failed", "cancelled"].includes(result.status)) break;
                await new Promise(resolve => { this.pollResolve = resolve; this.pollTimer = setTimeout(resolve, 500); });
            }
            if (epoch !== this.epoch || this.disposed || id !== this.state.background_id) return; if (result.status !== "completed") throw new Error(result.error || "Generation stopped.");
            const document = result.result.document;
            if (document.background_id !== id) throw new Error("The generation result belongs to another background.");
            if (action === "cg") { const cg = document.cgs.at(-1); Object.assign(this.state, { selected_cg_id: cg.cg_id, model_id: cg.model_id, camera: clone(cg.camera), frame: { width: cg.width, height: cg.height } }); }
            else { this.state.model_id = document.models.at(-1).model_id; this.state.selected_cg_id = ""; this.state.camera = null; this.state.frame = null; }
            await this.acceptDocument(document, false, epoch); this.sync(); this.render(); this.message(action === "cg" ? "CG saved with its camera. The selected CG is the workflow output." : "Model ready. Compose the camera and save a view.");
        } finally { if (epoch === this.epoch && !this.disposed) { this.jobId = ""; this.busy = false; this.updateControls(); } }
    }
    resize() { this.container.style.height = `${Math.max(550, (this.node.size?.[1] || 950) - 90)}px`; this.viewer?.resize(); }
    dispose() {
        if (this.disposed) return; if (this.unsaved) { this.sync(); this.retainDraft(); }
        this.disposed = true; ++this.epoch; this.events.abort(); clearTimeout(this.saveTimer); clearTimeout(this.wheelTimer); clearTimeout(this.pollTimer); this.pollResolve?.();
        for (const finish of [...this.dialogs]) finish(null); this.observer.disconnect(); this.customSelects.disconnect(); this.viewer?.dispose(); this.container.remove();
    }
}
