/**
 * Editor overlay and controls of the Pose Studio crop guide.
 *
 * The guide is drawn on a separate 2D canvas above the WebGL viewport, so it can
 * never appear in an RGB capture or in any auxiliary pass, and dragging it only
 * redraws that canvas (no 3D render, no PNG encode). It is mapped onto the orange
 * capture frame through the capture camera: an image point (u, v) is the capture
 * ray through it, intersected with the frame's plane and projected with the editor
 * camera. The inverse mapping lets the rectangle be edited from any orbited view.
 *
 * Pointer input is intercepted in the capture phase on the viewport container,
 * and only while "Edit Crop" is on and the pointer hits the rectangle or one of
 * its handles; everything else (orbit, pan, bone editing) reaches the viewer.
 */
import {
    CROP_GUIDE_ASPECT_PRESETS,
    centerCropGuide,
    cropGuideLockedRatio,
    cropGuidePixelRect,
    cropGuidePresetRatio,
    fitCropGuide,
    moveCropGuide,
    resizeCropGuide,
    setCropGuideAspect,
    setCropGuidePixels,
} from "./crop_guide.mjs";

export const CROP_GUIDE_COLOR = "#00d9ff";
const HANDLE_UV = Object.freeze({
    nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5],
});
const CURSORS = Object.freeze({
    nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize",
    n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", move: "move",
});
const HANDLE_HIT_RADIUS = 9;
const HANDLE_SIZE = 8;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function insideConvex(points, x, y) {
    let sign = 0;
    for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
        if (Math.abs(cross) < 1e-9) continue;
        if (sign === 0) sign = Math.sign(cross);
        else if (Math.sign(cross) !== sign) return false;
    }
    return sign !== 0;
}

export class PoseCropGuideController {
    constructor(widget, { document: doc = globalThis.document } = {}) {
        this.widget = widget;
        this.document = doc;
        this.editing = false;
        this.drag = null;
        this.overlay = null;
        this.container = null;
        this.canvas = null;
        this.fields = {};
        this.geometry = null;
        this._signature = "";
        this._cursorSet = false;
        this._listeners = [];
        this.stats = { draws: 0, drawMs: 0, maxDrawMs: 0, moves: 0, moveMs: 0, maxMoveMs: 0 };
    }

    // --- Host state -------------------------------------------------------

    get guide() {
        return this.widget.getCropGuide();
    }

    outputSize() {
        const params = this.widget.exportParams || {};
        return {
            width: Math.max(1, Math.round(Number(params.view_width) || 1024)),
            height: Math.max(1, Math.round(Number(params.view_height) || 1024)),
        };
    }

    /** Only the Studio Image editor shows the capture frame the guide belongs to. */
    available() {
        const widget = this.widget;
        return widget.host?.embedded !== true
            && (widget.interfaceMode || "studio") === "studio"
            && !widget.isAnimationMode?.();
    }

    shown() {
        return this.widget.exportParams?.crop_guide_visible !== false;
    }

    shouldDraw() {
        return this.available() && this.shown() && (this.guide.enabled || this.editing);
    }

    // --- Projection between image space and the editor viewport ----------

    canvasSize() {
        return {
            width: this.canvas?.clientWidth || 0,
            height: this.canvas?.clientHeight || 0,
        };
    }

    frameMapping() {
        const viewer = this.widget.viewer;
        const THREE = viewer?.THREE;
        const capture = viewer?.captureCamera, frame = viewer?.captureFrame, camera = viewer?.camera;
        if (!THREE || !capture || !frame || !camera) return null;
        const { width, height } = this.canvasSize();
        if (!width || !height) return null;
        capture.updateMatrixWorld(true);
        frame.updateMatrixWorld(true);
        camera.updateMatrixWorld(true);
        const normal = new THREE.Vector3(0, 0, 1).transformDirection(frame.matrixWorld);
        const point = new THREE.Vector3().setFromMatrixPosition(frame.matrixWorld);
        return {
            THREE, capture, camera, width, height,
            plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point),
            origin: new THREE.Vector3().setFromMatrixPosition(capture.matrixWorld),
        };
    }

    /** Image point (u, v) -> point of the orange frame's plane seen there by the capture camera. */
    imageToWorld(mapping, u, v) {
        const { THREE } = mapping;
        const through = new THREE.Vector3(u * 2 - 1, 1 - v * 2, 0.5).unproject(mapping.capture);
        const ray = new THREE.Ray(mapping.origin.clone(), through.sub(mapping.origin).normalize());
        return ray.intersectPlane(mapping.plane, new THREE.Vector3());
    }

    worldToScreen(mapping, point) {
        const projected = point.clone().project(mapping.camera);
        if (![projected.x, projected.y, projected.z].every(Number.isFinite) || projected.z < -1 || projected.z > 1) return null;
        return { x: (projected.x + 1) / 2 * mapping.width, y: (1 - projected.y) / 2 * mapping.height };
    }

    imageToScreen(mapping, u, v) {
        const world = this.imageToWorld(mapping, u, v);
        return world ? this.worldToScreen(mapping, world) : null;
    }

    /** Viewport point (CSS pixels of the WebGL canvas) -> image point, through the frame's plane. */
    screenToImage(mapping, x, y) {
        const { THREE } = mapping;
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(x / mapping.width * 2 - 1, 1 - y / mapping.height * 2), mapping.camera);
        const hit = raycaster.ray.intersectPlane(mapping.plane, new THREE.Vector3());
        if (!hit) return null;
        const projected = hit.project(mapping.capture);
        if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return null;
        return { u: (projected.x + 1) / 2, v: (1 - projected.y) / 2 };
    }

    screenGeometry(mapping = this.frameMapping()) {
        if (!mapping) return null;
        const guide = this.guide;
        const corner = (u, v) => this.imageToScreen(mapping, u, v);
        const frame = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
        const at = (fu, fv) => corner(guide.x + guide.width * fu, guide.y + guide.height * fv);
        const rect = [at(0, 0), at(1, 0), at(1, 1), at(0, 1)];
        if ([...frame, ...rect].some(point => !point)) return null;
        const handles = {};
        for (const [name, [fu, fv]] of Object.entries(HANDLE_UV)) handles[name] = at(fu, fv);
        return { frame, rect, handles, center: at(0.5, 0.5) };
    }

    hitTest(x, y, geometry = this.geometry) {
        if (!geometry) return null;
        let best = null, bestDistance = HANDLE_HIT_RADIUS;
        for (const [name, point] of Object.entries(geometry.handles)) {
            if (!point) continue;
            const distance = Math.hypot(point.x - x, point.y - y);
            if (distance <= bestDistance) { best = name; bestDistance = distance; }
        }
        if (best) return best;
        return insideConvex(geometry.rect, x, y) ? "move" : null;
    }

    // --- Overlay --------------------------------------------------------

    attach(container, canvas) {
        this.detach();
        if (!container || !canvas || !this.document) return;
        this.container = container;
        this.canvas = canvas;
        const overlay = this.document.createElement("canvas");
        overlay.className = "vnccs-ps-crop-overlay";
        Object.assign(overlay.style, {
            position: "absolute", left: "0", top: "0", width: "100%", height: "100%",
            pointerEvents: "none", zIndex: "1",
        });
        overlay.setAttribute?.("aria-hidden", "true");
        container.appendChild(overlay);
        this.overlay = overlay;
        const listen = (type, handler) => {
            container.addEventListener(type, handler, true);
            this._listeners.push([type, handler]);
        };
        listen("pointerdown", event => this.handlePointerDown(event));
        listen("pointermove", event => this.handlePointerMove(event));
        listen("pointerup", event => this.handlePointerUp(event));
        listen("pointercancel", event => this.handlePointerUp(event));
        listen("lostpointercapture", event => this.handlePointerUp(event));
        this.draw();
    }

    detach() {
        for (const [type, handler] of this._listeners) this.container?.removeEventListener?.(type, handler, true);
        this._listeners = [];
        this.overlay?.remove?.();
        this.overlay = null;
        this.container = null;
        this.canvas = null;
        this.drag = null;
    }

    dispose() {
        this.detach();
        this.fields = {};
    }

    draw() {
        const started = now();
        this.syncControls();
        const overlay = this.overlay;
        if (!overlay) return;
        const { width, height } = this.canvasSize();
        const ratio = this.document?.defaultView?.devicePixelRatio || globalThis.devicePixelRatio || 1;
        const backingWidth = Math.max(1, Math.round(width * ratio)), backingHeight = Math.max(1, Math.round(height * ratio));
        if (overlay.width !== backingWidth) overlay.width = backingWidth;
        if (overlay.height !== backingHeight) overlay.height = backingHeight;
        const context = this._context || (this._context = overlay.getContext?.("2d"));
        if (!context) return;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, width, height);
        this.geometry = this.shouldDraw() ? this.screenGeometry() : null;
        if (this.geometry) this.paint(context, this.geometry);
        const elapsed = now() - started;
        this.stats.draws += 1;
        this.stats.drawMs += elapsed;
        this.stats.maxDrawMs = Math.max(this.stats.maxDrawMs, elapsed);
    }

    paint(context, geometry) {
        const guide = this.guide;
        const path = points => {
            context.moveTo(points[0].x, points[0].y);
            for (const point of points.slice(1)) context.lineTo(point.x, point.y);
            context.closePath();
        };
        if (guide.enabled && this.widget.exportParams?.crop_guide_dim !== false) {
            context.beginPath();
            path(geometry.frame);
            path(geometry.rect);
            context.fillStyle = "rgba(0, 0, 0, 0.45)";
            context.fill("evenodd");
        }
        context.beginPath();
        path(geometry.rect);
        context.setLineDash(guide.enabled ? [] : [6, 4]);
        context.lineWidth = this.editing ? 2 : 1.5;
        context.strokeStyle = CROP_GUIDE_COLOR;
        context.stroke();
        context.setLineDash([]);
        if (this.editing) {
            context.fillStyle = "#ffffff";
            for (const point of Object.values(geometry.handles)) {
                if (!point) continue;
                context.fillRect(point.x - HANDLE_SIZE / 2, point.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
                context.strokeRect(point.x - HANDLE_SIZE / 2, point.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
            }
        }
        const label = this.readout();
        const anchor = geometry.rect.reduce((best, point) => (point.y + point.x < best.y + best.x ? point : best));
        context.font = "11px sans-serif";
        context.textBaseline = "top";
        const textWidth = context.measureText?.(label)?.width || label.length * 6;
        context.fillStyle = "rgba(0, 0, 0, 0.65)";
        context.fillRect(anchor.x + 4, anchor.y + 4, textWidth + 8, 16);
        context.fillStyle = CROP_GUIDE_COLOR;
        context.fillText(label, anchor.x + 8, anchor.y + 6);
    }

    pixelRect() {
        const { width, height } = this.outputSize();
        return cropGuidePixelRect(this.guide, width, height);
    }

    readout() {
        const rect = this.pixelRect();
        const centerX = rect.x + rect.width / 2, centerY = rect.y + rect.height / 2;
        const state = this.guide.enabled ? "" : " (disabled)";
        return `${rect.width} × ${rect.height} px · center ${centerX}, ${centerY}${state}`;
    }

    refresh() {
        this._signature = "";
        this.draw();
    }

    // --- Pointer --------------------------------------------------------

    eventPoint(event) {
        const bounds = this.canvas?.getBoundingClientRect?.();
        const { width, height } = this.canvasSize();
        if (!bounds || !bounds.width || !bounds.height) return null;
        return {
            x: (event.clientX - bounds.left) / bounds.width * width,
            y: (event.clientY - bounds.top) / bounds.height * height,
        };
    }

    handlePointerDown(event) {
        if (!this.editing || this.drag || event.button !== 0 || !this.shouldDraw()) return;
        if (event.target !== this.canvas && event.target !== this.overlay) return;
        const point = this.eventPoint(event);
        const mapping = this.frameMapping();
        if (!point || !mapping) return;
        const handle = this.hitTest(point.x, point.y, this.screenGeometry(mapping));
        if (!handle) return;
        const uv = this.screenToImage(mapping, point.x, point.y);
        if (!uv) return;
        event.preventDefault?.();
        event.stopPropagation?.();
        event.stopImmediatePropagation?.();
        try { this.container?.setPointerCapture?.(event.pointerId); } catch (_) { /* pointer already released */ }
        this.widget.beginCropGuideGesture();
        this.drag = { pointerId: event.pointerId, handle, start: { ...this.guide }, uv, tab: this.widget.activeTab };
    }

    handlePointerMove(event) {
        if (!this.drag) {
            this.updateHoverCursor(event);
            return;
        }
        if (event.pointerId !== this.drag.pointerId) return;
        event.preventDefault?.();
        event.stopPropagation?.();
        const started = now();
        const point = this.eventPoint(event);
        const mapping = this.frameMapping();
        const uv = point && mapping ? this.screenToImage(mapping, point.x, point.y) : null;
        if (!uv) return;
        const { width, height } = this.outputSize();
        const { start, handle } = this.drag;
        const next = handle === "move"
            ? moveCropGuide(start, uv.u - this.drag.uv.u, uv.v - this.drag.uv.v, width, height)
            : resizeCropGuide(start, handle, uv.u, uv.v, width, height);
        this.widget.setCropGuide(this.drag.tab, next, { sync: false });
        const elapsed = now() - started;
        this.stats.moves += 1;
        this.stats.moveMs += elapsed;
        this.stats.maxMoveMs = Math.max(this.stats.maxMoveMs, elapsed);
    }

    handlePointerUp(event) {
        const drag = this.drag;
        if (!drag || (event.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
        this.drag = null;
        event.stopPropagation?.();
        try {
            if (this.container?.hasPointerCapture?.(drag.pointerId)) this.container.releasePointerCapture(drag.pointerId);
        } catch (_) { /* already released */ }
        // The last visible rectangle stays; the gesture commits one undo step and persists.
        this.widget.finishCropGuideGesture();
    }

    updateHoverCursor(event) {
        if (!this.canvas) return;
        let cursor = "";
        if (this.editing && this.shouldDraw() && event.target === this.canvas) {
            const point = this.eventPoint(event);
            const hit = point ? this.hitTest(point.x, point.y) : null;
            cursor = hit ? CURSORS[hit] : "";
        }
        if (cursor) {
            this.canvas.style.cursor = cursor;
            this._cursorSet = true;
        } else if (this._cursorSet) {
            this.canvas.style.cursor = "";
            this._cursorSet = false;
        }
    }

    setEditing(editing) {
        this.editing = editing === true && this.available();
        if (this.editing && this.widget.exportParams) this.widget.exportParams.crop_guide_visible = true;
        if (!this.editing && this._cursorSet && this.canvas) {
            this.canvas.style.cursor = "";
            this._cursorSet = false;
        }
        this.refresh();
    }

    // --- Controls -------------------------------------------------------

    /** One edit of the active guide from a control: undo step, change, persist. */
    commit(change) {
        if (!this.available()) return;
        this.widget.beginCropGuideGesture();
        const { width, height } = this.outputSize();
        this.widget.setCropGuide(this.widget.activeTab, change(this.guide, width, height), { sync: false });
        this.widget.finishCropGuideGesture();
    }

    createControls(content) {
        const make = (tag, className = "", text = "") => {
            const element = this.document.createElement(tag);
            if (className) element.className = className;
            if (text) element.innerText = text;
            return element;
        };
        const checkbox = (labelText, title, onChange) => {
            const field = make("label", "vnccs-ps-field vnccs-ps-checkbox-field");
            field.title = title;
            const input = make("input");
            input.type = "checkbox";
            input.addEventListener("change", () => onChange(input.checked));
            field.append(input, make("span", "vnccs-ps-label", labelText));
            return { field, input };
        };

        const enabled = checkbox("Enabled", "Use this tab's rectangle for crop_json, crop_image and crop_preview.",
            checked => {
                if (checked) this.widget.exportParams.crop_guide_visible = true;
                this.commit(guide => ({ ...guide, enabled: checked }));
            });
        const shown = checkbox("Show", "Show the crop guide in the viewport (editor only; never rendered into outputs).",
            checked => {
                this.widget.exportParams.crop_guide_visible = checked;
                if (!checked) this.editing = false;
                this.refresh();
                this.widget.syncToNode(false);
            });
        const dim = checkbox("Dim Outside", "Darken the capture frame outside the crop guide in the viewport.",
            checked => {
                this.widget.exportParams.crop_guide_dim = checked;
                this.refresh();
                this.widget.syncToNode(false);
            });
        // Two checkboxes per line keep the labels readable in the narrow side panel.
        const toggles = make("div", "vnccs-ps-row");
        toggles.style.flexWrap = "wrap";
        toggles.style.rowGap = "4px";
        for (const field of [enabled.field, shown.field, dim.field]) field.style.flex = "1 1 40%";
        toggles.append(enabled.field, shown.field, dim.field);
        content.appendChild(toggles);

        const actions = make("div", "vnccs-ps-row");
        const edit = make("button", "vnccs-ps-btn", "Edit Crop");
        edit.type = "button";
        edit.title = "Drag the rectangle in the viewport to move it and its handles to resize it. Orbit, pan and bones work outside it.";
        edit.addEventListener("click", () => this.setEditing(!this.editing));
        const center = make("button", "vnccs-ps-btn", "Center");
        center.type = "button";
        center.addEventListener("click", () => this.commit(centerCropGuide));
        const fit = make("button", "vnccs-ps-btn", "Fit to Frame");
        fit.type = "button";
        fit.title = "Largest centered rectangle of the selected aspect ratio";
        fit.addEventListener("click", () => this.commit(fitCropGuide));
        actions.append(edit, center, fit);
        content.appendChild(actions);

        const aspectField = make("div", "vnccs-ps-field");
        const aspectRow = make("div", "vnccs-ps-row");
        aspectRow.style.alignItems = "center";
        const aspect = make("select", "vnccs-ps-select");
        for (const preset of CROP_GUIDE_ASPECT_PRESETS) {
            const option = make("option");
            option.value = preset.key;
            option.innerText = preset.label;
            aspect.appendChild(option);
        }
        aspect.title = "Aspect ratio of the final crop in output pixels";
        aspect.addEventListener("change", () => this.commit((guide, width, height) => setCropGuideAspect(guide, aspect.value, width, height)));
        const customW = make("input", "vnccs-ps-input");
        const customH = make("input", "vnccs-ps-input");
        for (const input of [customW, customH]) {
            input.type = "number";
            input.min = "0.01";
            input.step = "0.01";
            input.title = "Custom aspect ratio (width : height)";
            this.widget.trackPoseGesture(input, { recordPose: true });
            input.addEventListener("input", () => {
                const ratio = [Number(customW.value), Number(customH.value)];
                if (!ratio.every(value => Number.isFinite(value) && value > 0) || !this.available()) return;
                const { width, height } = this.outputSize();
                this.widget.setCropGuide(this.widget.activeTab, setCropGuideAspect(this.guide, "custom", width, height, ratio), { sync: false });
            });
        }
        const lock = checkbox("Lock", "Keep the current aspect ratio while resizing (always on for fixed presets).",
            checked => this.commit(guide => ({ ...guide, aspect_ratio_locked: checked })));
        aspect.style.flex = "2 1 0";
        lock.field.style.flex = "1 1 0";
        aspectRow.append(aspect, lock.field);
        const customRow = make("div", "vnccs-ps-row");
        customRow.style.alignItems = "center";
        const colon = make("span", "vnccs-ps-label", ":");
        colon.style.flex = "0 0 auto";
        customRow.append(customW, colon, customH);
        aspectField.append(make("div", "vnccs-ps-label", "Aspect"), aspectRow, customRow);
        content.appendChild(aspectField);

        // X / Y and W / H as two rows of two, like the Camera Width / Height row.
        const numberRows = [make("div", "vnccs-ps-row"), make("div", "vnccs-ps-row")];
        const numberInputs = {};
        for (const [index, [key, labelText]] of [["x", "X"], ["y", "Y"], ["width", "W"], ["height", "H"]].entries()) {
            const wrap = make("label", "vnccs-ps-field");
            const input = make("input", "vnccs-ps-input");
            input.type = "number";
            input.step = "1";
            input.min = "0";
            input.title = `Crop ${labelText} in output pixels`;
            this.widget.trackPoseGesture(input, { recordPose: true });
            input.addEventListener("input", () => {
                if (input.value === "" || !Number.isFinite(Number(input.value)) || !this.available()) return;
                const { width, height } = this.outputSize();
                this.widget.setCropGuide(this.widget.activeTab, setCropGuidePixels(this.guide, key, input.value, width, height), { sync: false });
            });
            input.addEventListener("change", () => { this._signature = ""; this.syncControls({ force: true }); });
            wrap.append(make("div", "vnccs-ps-label", `${labelText} (px)`), input);
            numberRows[index >> 1].appendChild(wrap);
            numberInputs[key] = input;
        }
        content.append(...numberRows);

        const readout = make("div", "vnccs-ps-label");
        content.appendChild(readout);

        this.fields = {
            enabled: enabled.input, shown: shown.input, dim: dim.input, edit, center, fit,
            aspect, customRow, customW, customH, lock: lock.input, numbers: numberInputs, readout,
        };
        this.refresh();
    }

    syncControls({ force = false } = {}) {
        const fields = this.fields;
        if (!fields.enabled) return;
        const guide = this.guide;
        const { width, height } = this.outputSize();
        const available = this.available();
        const signature = JSON.stringify([guide, width, height, available, this.editing, this.shown(),
            this.widget.exportParams?.crop_guide_dim, this.widget.activeTab]);
        if (!force && signature === this._signature) return;
        this._signature = signature;
        const focused = this.document?.activeElement || null;
        const setValue = (input, value) => { if (input !== focused) input.value = String(value); };
        fields.enabled.checked = guide.enabled;
        fields.shown.checked = this.shown();
        fields.dim.checked = this.widget.exportParams?.crop_guide_dim !== false;
        fields.edit.classList?.toggle?.("active", this.editing);
        fields.edit.innerText = this.editing ? "Done Editing" : "Edit Crop";
        setValue(fields.aspect, guide.aspect_ratio);
        setValue(fields.customW, guide.custom_aspect_ratio[0]);
        setValue(fields.customH, guide.custom_aspect_ratio[1]);
        const custom = guide.aspect_ratio === "custom";
        fields.customRow.style.display = custom ? "" : "none";
        fields.lock.checked = guide.aspect_ratio_locked;
        fields.lock.disabled = !available || guide.aspect_ratio !== "free";
        const rect = cropGuidePixelRect(guide, width, height);
        for (const [key, input] of Object.entries(fields.numbers)) {
            input.max = String(key === "x" || key === "width" ? width : height);
            setValue(input, rect[key]);
            input.disabled = !available;
        }
        for (const control of [fields.enabled, fields.edit, fields.center, fields.fit, fields.aspect, fields.customW, fields.customH]) {
            control.disabled = !available;
        }
        const preset = cropGuidePresetRatio(guide);
        const actual = rect.width / rect.height;
        const locked = cropGuideLockedRatio(guide, width, height);
        let text = `${rect.width} × ${rect.height} px at ${rect.x}, ${rect.y} of ${width} × ${height}`
            + ` · ratio ${actual.toFixed(3)}`;
        if (preset && Math.abs(actual / preset - 1) > Math.max(1 / rect.width, 1 / rect.height) * 1.5) {
            text += ` (output size changed: ${guide.aspect_ratio} needs Fit or a resize)`;
        } else if (locked && !preset) text += " (locked)";
        if (!available) text += " · edit in Studio Image mode";
        fields.readout.innerText = text;
    }
}
