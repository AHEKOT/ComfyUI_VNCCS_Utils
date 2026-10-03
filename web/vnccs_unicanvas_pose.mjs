/** Pose Studio host contract and image preparation for UniCanvas pose layers. */
import { PoseStudioWidget } from "./vnccs_pose_studio.js";

import { installCustomSelects } from "./vnccs_custom_select.mjs";
import { composePoseReference, poseAtPanoramaCamera, poseLayerBelow } from "./vnccs_unicanvas_pose_state.mjs";
import { applyTorsoFraming } from "./vnccs_unicanvas_pose_framing.mjs";
import { UniCanvasPoseBackdrop } from "./vnccs_unicanvas_pose_backdrop.mjs";
import { POSE_HELP_CSS, buildPoseHelp } from "./vnccs_unicanvas_pose_help.mjs";
import { installBodyDrag } from "./vnccs_unicanvas_pose_body_drag.mjs";
import { UniCanvasPoseWall, poseWallPlacement } from "./vnccs_unicanvas_pose_wall.mjs";
const EYE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.9 17.9A10.1 10.1 0 0 1 12 19c-6.4 0-10-7-10-7a17.7 17.7 0 0 1 4.1-4.9M9.9 5.2A9.7 9.7 0 0 1 12 5c6.4 0 10 7 10 7a17.8 17.8 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="M2 2l20 20"/></svg>';
// Pose Studio's own rotation gizmo size (vnccs_pose_studio_core.js: transform.setSize).
const GIZMO_SIZE = 0.8;
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

const styles = `
${POSE_HELP_CSS}
.vnccs-unicanvas .vnccs-uc-pose-root { position:absolute; inset:0; display:block; width:auto; height:auto; min-width:0; min-height:0; background:none; border:0; border-radius:0; pointer-events:none; z-index:5; --vnccs-ps-ui-scale:1; --vnccs-ps-relative-ui-scale:1; }
.vnccs-unicanvas .vnccs-uc-pose-root:has(> .vnccs-ps-modal-overlay) { z-index:1000; }
/* Pose Library inside UniCanvas: the modal is as large as the canvas, but its header, toolbar and
   settings keep a compact size (Pose Studio scales them with the modal width, up to 1.4x). */
.vnccs-unicanvas .vnccs-uc-pose-root .vnccs-ps-library-modal { --vnccs-ps-library-ui-scale: 0.62 !important; }
.vnccs-uc-pose-controls { position:absolute; pointer-events:none; overflow:hidden; z-index:1; }
/* Pose Studio's settings are re-parented into the UniCanvas sidebar and controls, outside the
   .vnccs-pose-studio root that defines its --ps-* theme variables. Without them the active toggle
   (e.g. Female) had no background and the slider thumbs no color. Map them onto the UniCanvas
   palette so the panel matches the rest of the UI. The embedded canvas wrap needs them too: the
   hand control popover mounts there (the center panel that hosted it stays hidden). */
.vnccs-unicanvas .vnccs-uc-pose-side, .vnccs-unicanvas .vnccs-uc-pose-controls,
.vnccs-unicanvas .vnccs-uc-pose-root > .vnccs-ps-canvas-wrap {
  --ps-bg: var(--uc-bg, #0a0a0f); --ps-panel: var(--uc-panel, rgba(20,16,30,.82)); --ps-elevated: #1a1a26;
  --ps-surface: var(--uc-surface, rgba(30,28,44,.9)); --ps-hover: var(--uc-hover, rgba(44,40,62,.95));
  --ps-border: var(--uc-border, rgba(255,255,255,.08)); --ps-border-hover: rgba(255,255,255,.14);
  --ps-accent: var(--uc-accent, #ff8fa3); --ps-accent-hover: #ffb6c8; --ps-accent-glow: rgba(255,143,163,.3);
  --ps-accent-subtle: rgba(255,143,163,.1); --ps-accent-border: rgba(255,143,163,.22); --ps-accent-lavender: var(--uc-accent-2, #b8a9e8);
  --ps-success: var(--uc-good, #00d68f); --ps-danger: var(--uc-danger, #ff4757); --ps-warning: #ffaa00;
  --ps-text: var(--uc-text, #e8e8f0); --ps-text-muted: var(--uc-muted, #9898a8); --ps-text-dim: #5e5e70;
  --ps-input-bg: rgba(255,255,255,.04); --ps-font: var(--uc-font, 'Sora', -apple-system, BlinkMacSystemFont, sans-serif);
  --ps-font-mono: 'JetBrains Mono', 'Fira Code', monospace; --ps-radius-sm: 8px; --ps-radius-md: 12px; --ps-radius-lg: 16px;
  --ps-transition: .2s ease; --vnccs-ps-ui-scale: 1; --vnccs-ps-relative-ui-scale: 1;
  color: var(--ps-text); font-family: var(--ps-font);
}
.vnccs-uc-pose-side { display:flex; flex-direction:column; gap:8px; flex:1 1 auto; min-height:0; min-width:0; }
.vnccs-uc-pose-side-head { display:flex; align-items:center; gap:8px; padding:8px 10px; border:1px solid rgba(255,143,163,.45); border-radius:10px; background:rgba(255,143,163,.08); }
.vnccs-uc-pose-side-head strong { font-size:12px; color:var(--uc-accent, #ff8fa3); text-transform:uppercase; letter-spacing:.05em; }
.vnccs-uc-pose-side-head span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--uc-muted); font-size:11px; }
.vnccs-uc-pose-dock { display:flex; flex-direction:column; gap:8px; flex:1 1 auto; min-height:0; }
.vnccs-uc-pose-tabs { display:flex; gap:4px; flex:none; }
.vnccs-uc-pose-tabs button { flex:1; min-width:0; }
.vnccs-uc-pose-tabs .vnccs-uc-pose-collapse { display:none; }
.vnccs-uc-pose-page { min-height:0; overflow:auto; flex:1; overscroll-behavior:contain; }
.vnccs-uc-pose-page > .vnccs-ps-left, .vnccs-uc-pose-page > .vnccs-ps-right-sidebar, .vnccs-uc-pose-page > .vnccs-ps-center { width:100%; flex:none; min-width:0; height:auto; max-height:none; overflow:visible; padding:0; border:0; background:transparent; zoom:1; }
.vnccs-uc-pose-editbar { position:absolute; left:50%; bottom:12px; transform:translateX(-50%); display:flex; align-items:center; gap:8px; max-width:calc(100% - 24px); padding:6px 8px 6px 12px; box-sizing:border-box; border:1px solid var(--uc-border); border-radius:12px; background:rgba(14,11,20,.94); box-shadow:0 12px 32px rgba(0,0,0,.45); pointer-events:auto; zoom:var(--vnccs-uc-ui-scale); z-index:3; }
.vnccs-uc-pose-editbar .vnccs-uc-pose-eye { width:30px; padding:0; display:inline-flex; align-items:center; justify-content:center; flex:none; }
.vnccs-uc-pose-editbar strong { color:var(--uc-accent, #ff8fa3); font-size:12px; white-space:nowrap; }
.vnccs-uc-pose-editbar .vnccs-uc-pose-hint { color:var(--uc-muted); font-size:11px; line-height:1.3; white-space:normal; min-width:0; max-width:340px; }
.vnccs-uc-pose-drag-hint { position:absolute; z-index:4; display:flex; align-items:center; gap:6px; padding:5px 9px 5px 6px; border-radius:10px; background:rgba(14,11,20,.9); border:1px solid var(--uc-border, rgba(255,255,255,.14)); color:var(--uc-accent, #ff8fa3); font-size:11px; pointer-events:none; white-space:nowrap; }
.vnccs-uc-pose-drag-hint.depth { color:var(--uc-accent-2, #b8a9e8); border-color:var(--uc-accent-2, #b8a9e8); }
.vnccs-uc-pose-drag-hint[hidden] { display:none; }
.vnccs-uc-pose-root > .vnccs-ps-canvas-wrap { position:absolute; flex:none; min-width:0; min-height:0; margin:0; padding:0; background:transparent; border:0; border-radius:0; pointer-events:auto; overflow:hidden; }
.vnccs-uc-pose-root > .vnccs-ps-canvas-wrap canvas { background:transparent; }
.vnccs-uc-pose-root > [class*="modal"], .vnccs-uc-pose-root > .vnccs-ps-manager, .vnccs-uc-pose-root > .vnccs-ps-manager-detail-strip { pointer-events:auto; }
.vnccs-uc-pose-root > .vnccs-ps-manager { position:absolute; inset:12px 300px 12px 330px; background:var(--uc-bg); }
.vnccs-uc-pose-character { display:flex; flex-direction:column; gap:8px; padding:10px; flex:none; background:var(--uc-panel); border:1px solid var(--uc-border); border-radius:10px; transition:border-color .2s, box-shadow .2s; }
.vnccs-uc-pose-character.attention { border-color:#ffd45c; box-shadow:0 0 0 2px rgba(255,212,92,.35); }
.vnccs-uc-pose-character-header { display:flex; align-items:center; gap:8px; }
.vnccs-uc-pose-character-header strong { flex:1; font-size:12px; }
.vnccs-uc-pose-character-row { display:flex; align-items:center; gap:8px; min-width:0; }
.vnccs-uc-pose-character-row img { width:44px; height:52px; flex:none; object-fit:contain; background:var(--uc-surface); border:1px solid var(--uc-border); border-radius:6px; }
.vnccs-uc-pose-character-row select { flex:1; min-width:0; width:100%; }
.vnccs-uc-pose-character-actions { display:flex; align-items:center; gap:8px; }
.vnccs-uc-pose-character-actions > button { flex:1; min-width:0; }
.vnccs-uc-pose-character-issue { color:#ffd45c; font-size:11px; }
.vnccs-uc-pose-root .vnccs-ps-loading-overlay { pointer-events:none; background:transparent; backdrop-filter:none; }
`;

export class UniCanvasPoseEditor {
    constructor(host) {
        this.host = host;
        this.token = 0;
        this.visible = false;
        this.ready = null;
        this.inspecting = false;
        this.viewOffsetKey = null;
        this.commitTimer = null;
        this.previewStale = false;
        this.pointerHeld = false;
        this.backdropSyncTimer = null;
        this.wheelInspectionTimer = null;
        this.abort = new AbortController();
        if (!document.getElementById("vnccs-uc-pose-style")) {
            const style = document.createElement("style");
            style.id = "vnccs-uc-pose-style"; style.textContent = styles;
            document.head.appendChild(style);
        }
    }

    async activate(layer, { show = true } = {}) {
        if (this.layer === layer && this.studio) {
            this.setVisible(show);
            await this.ready;
            return;
        }
        this.release();
        const token = ++this.token;
        this.layer = layer;
        const value = { name: "pose_data", value: JSON.stringify(layer.pose.studio || {}) };
        // An isolated state adapter, not a second graph node or another renderer implementation.
        const node = { id: `${this.host.node.id}_pose_${layer.id}`, widgets: [value], size: this.host.node.size };
        this.studio = new PoseStudioWidget(node, {
            embedded: true,
            onStateChange: data => {
                if (this.token !== token || !this.host.layers.includes(layer)) return;
                if (this.initialized) this.applyDimensions(data.export);
                const meshKey = JSON.stringify(data?.characters?.map?.(item => item?.mesh) ?? data?.mesh ?? null);
                if (meshKey !== this.meshKey) { this.meshKey = meshKey; this.backdrop?.invalidate(); this.wallKey = null; }
                const key = JSON.stringify([data, layer.pose.viewport]);
                layer.pose.studio = clone(data);
                if (key === this.stateKey) return;
                this.stateKey = key;
                this.host.syncLightStateToWidget();
                this.host.scheduleFullSync();
                // A real edit arrived (bone drag, hand slider, character change): bake the
                // final-quality pixels once the gesture settles. Pure camera navigation
                // never reaches this point - the viewer dispatches no state for it.
                this.scheduleCommit();
            },
            onViewportRender: () => {
                if (this.token !== token || !this.initialized || this.capturing || !this.visible) return;
                this.syncSessionViewOffset();
                this.syncGizmoSize();
                // While the live viewport replaces the layer pixels on screen, a per-frame capture is
                // invisible work that made every joint drag lag: it resizes the WebGL drawing buffer
                // to the capture size and back, renders the scene twice more, copies it into the
                // layer and repaints the stage. Edits bake once through scheduleCommit(); the pixels
                // are only marked stale here and re-captured when they are shown again (layout()).
                if (this.hidesLayerPixels(layer)) this.previewStale = true;
                else this.capturePreview();
            },
        });
        const studio = this.studio;
        // The Scene page's camera sliders are the capture-framing controls: applying them
        // re-seeds the persisted framing (and snaps the inspection view onto it). Free
        // navigation (orbit / pan / wheel) never runs through here.
        const applyCameraToViewer = studio.applyCameraToViewer;
        studio.applyCameraToViewer = (...args) => {
            applyCameraToViewer.apply(studio, args);
            if (this.initialized && !this.keepingCamera) this.saveCaptureFraming();
        };
        studio.container.classList.add("vnccs-uc-pose-root");
        this.host.container.appendChild(studio.container);
        this.buildDock();
        this.selectController = installCustomSelects(studio.container, { theme: "pose-studio" });
        this.setVisible(show);
        this.ready = (async () => {
            await studio._viewerInitPromise;
            if (this.token !== token) return;
            studio.loadFromNode();
            studio.exportParams.view_width = Math.round(layer.pose.rect.width);
            studio.exportParams.view_height = Math.round(layer.pose.rect.height);
            await studio.loadModel(true, false);
            if (this.token !== token) return;
            await studio.awaitReadyForCompositeCapture();
            if (this.token !== token || this.host._disposed) return;
            studio.viewer.scene.background = null;
            if (studio.viewer.gridHelper) studio.viewer.gridHelper.visible = false;
            if (studio.viewer.captureFrame) studio.viewer.captureFrame.visible = false;
            // Mannequin only, over a flat backdrop of the layers below that it cannot sink behind.
            this.backdrop = new UniCanvasPoseBackdrop(this);
            // layer.pose.viewport is the persisted CAPTURE framing: the camera the layer pixels
            // are rendered with (pre-0.6.8 contract). It doubles as the migration source - a
            // layer saved before the split stores exactly the framing of its baked pixels. The
            // orbit/wheel camera is a session-only INSPECTION view that starts on this framing
            // and is never persisted again.
            if (layer.pose.viewport) {
                this.applyViewerCamera(layer.pose.viewport);
            } else {
                studio.applyCameraToViewer(true);
                applyTorsoFraming(studio.viewer);
                this.saveCaptureFraming();
            }
            // The layers below stand as a wall in the scene, aligned with the capture framing.
            this.wall = new UniCanvasPoseWall(studio.viewer.THREE, studio.viewer.scene);
            this.backdrop.wall = this.wall;
            this.refreshWall();
            this.disposeBodyDrag = installBodyDrag(this);
            // The camera is a free 3D inspection view: the capture framing stays pinned to the
            // wall (the layers below), so orbiting can never move the mannequin in the image.
            studio.viewer.orbit.addEventListener("start", () => {
                if (this.token === token) this.inspecting = true;
            });
            studio.viewer.orbit.addEventListener("end", () => {
                if (this.token === token) this.inspecting = false;
            });
            // Wheel dollying bypasses OrbitControls events; keep captures out of its frames.
            studio.canvas.addEventListener("wheel", () => {
                if (this.token !== token) return;
                this.inspecting = true;
                clearTimeout(this.wheelInspectionTimer);
                this.wheelInspectionTimer = setTimeout(() => { this.inspecting = false; }, 160);
            }, { passive: true });
            this.initialized = true;
            this.layout();
            this.capturePreview(true);
            studio.syncToNode(false, { skipCapture: true, skipCaptureUpload: true });
            void studio.refreshLibrary(false);
        })();
        try { await this.ready; }
        catch (error) {
            if (this.token === token) {
                this.host.setStatus(`Pose Studio: ${error.message || error}`, true);
                this.release();
                this.host.setTool?.("move");
            }
            throw error;
        }
    }

    buildDock() {
        const studio = this.studio, root = studio.container;
        const controls = document.createElement("div"); controls.className = "vnccs-uc-pose-controls";
        this.controls = controls;
        // While editing, the right sidebar (denoise, masks, layers) is replaced by this panel.
        const side = document.createElement("div"); side.className = "vnccs-uc-pose-side";
        const head = document.createElement("div"); head.className = "vnccs-uc-pose-side-head";
        const headTitle = document.createElement("strong"); headTitle.textContent = "Edit pose";
        this.sideLayerName = document.createElement("span");
        head.append(headTitle, this.sideLayerName);
        const dock = document.createElement("div"); dock.className = "vnccs-uc-pose-dock";
        const tabs = document.createElement("div"); tabs.className = "vnccs-uc-pose-tabs";
        tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Pose settings");
        dock.appendChild(tabs);
        root.appendChild(studio.canvasContainer);
        // Keep shared scene state and action references alive without a second action toolbar.
        studio.centerPanel.hidden = true;
        // centerPanel is hidden here, so Pose Studio's hand popover must live in the visible
        // embedded viewport instead (see _handPopoverHost()); it was mounted into the
        // centerPanel during the studio constructor, before this host chose its own.
        studio.handPopoverHost = studio.canvasContainer;
        if (studio._handPopover && studio._handPopover.parentElement !== studio.canvasContainer) {
            studio.canvasContainer.appendChild(studio._handPopover);
        }
        const pages = [
            ["Body", studio.leftPanel], ["Scene", studio.rightSidebar],
        ];
        const panels = pages.map(([name, content], index) => {
            const page = document.createElement("div"); page.className = "vnccs-uc-pose-page";
            page.id = `uc-pose-${this.layer.id}-${index}`; page.setAttribute("role", "tabpanel");
            page.appendChild(content); page.hidden = index !== 0; dock.appendChild(page);
            const button = this.host._button(name, "vnccs-uc-btn", () => select(index));
            button.setAttribute("role", "tab"); button.setAttribute("aria-controls", page.id);
            button.setAttribute("aria-selected", String(index === 0));
            button.tabIndex = index === 0 ? 0 : -1;
            button.addEventListener("keydown", event => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === "Home" ? 0 : event.key === "End" ? pages.length - 1
                    : (index + (event.key === "ArrowRight" ? 1 : -1) + pages.length) % pages.length;
                select(next); panels[next].button.focus();
            });
            tabs.appendChild(button);
            return { page, button, scrollTop: 0, scrollLeft: 0 };
        });
        const select = index => {
            this.activePage = index;
            panels.forEach((entry, i) => {
                if (!entry.page.hidden) { entry.scrollTop = entry.page.scrollTop; entry.scrollLeft = entry.page.scrollLeft; }
                entry.page.hidden = i !== index;
                entry.button.classList.toggle("active", i === index);
                entry.button.setAttribute("aria-selected", String(i === index));
                entry.button.tabIndex = i === index ? 0 : -1;
                if (i === index) { entry.page.scrollTop = entry.scrollTop; entry.page.scrollLeft = entry.scrollLeft; }
            });
        };
        side.append(head, this.buildCharacterMenu(), dock);
        controls.append(this.buildEditBar(), this.help.overlay);
        root.appendChild(controls);
        this.sidePanel = side;
        this.dock = dock;
        this.pages = panels;
        const savedUI = this.layer.pose.ui;
        panels.forEach((entry, index) => {
            entry.page.hidden = true;
            entry.scrollTop = savedUI?.pages?.[index]?.top || 0;
            entry.scrollLeft = savedUI?.pages?.[index]?.left || 0;
            entry.page.querySelectorAll?.(".vnccs-ps-section").forEach((section, sectionIndex) => {
                const collapsed = savedUI?.pages?.[index]?.collapsed?.[sectionIndex];
                if (typeof collapsed !== "boolean") return;
                section.classList.toggle("collapsed", collapsed);
                section.querySelector(".vnccs-ps-section-header")?.setAttribute("aria-expanded", String(!collapsed));
            });
        });
        select(Math.max(0, Math.min(panels.length - 1, savedUI?.tab || 0)));
        this.uiAbort?.abort(); this.uiAbort = new AbortController();
        const signal = this.uiAbort.signal;
        // Keep all shared settings mounted; only visibility changes, so drafts and scroll survive.
        for (const element of [controls, side, studio.canvasContainer]) {
            // A held pointer (joint, gizmo, torso, orbit, slider) is a gesture in progress; see
            // isGestureActive(). Capture phase: the torso drag stops its own pointerdown.
            element.addEventListener("pointerdown", () => { this.pointerHeld = true; }, { capture: true, signal });
            element.addEventListener("keydown", event => {
                // Enter/Escape leave the editor from anywhere but a text field or a Pose Studio dialog.
                if ((event.key === "Escape" || event.key === "Enter") && !event.target.closest?.("input, textarea, select, [contenteditable], [role=dialog], [class*=modal]")) {
                    event.preventDefault();
                    this.host.finishPoseEdit(true);
                }
                event.stopPropagation();
            });
            element.addEventListener("pointerdown", event => event.stopPropagation());
            element.addEventListener("wheel", event => event.stopPropagation(), { passive: true });
        }
        const endGesture = () => { this.pointerHeld = false; };
        globalThis.addEventListener?.("pointerup", endGesture, { capture: true, signal });
        globalThis.addEventListener?.("pointercancel", endGesture, { capture: true, signal });
        // The window losing focus only: a captured blur would also fire for any element that loses
        // focus when the drag starts.
        globalThis.addEventListener?.("blur", endGesture, { signal });
    }

    // UniCanvas defers its full state sync and upload (another capture plus a PNG encode of every
    // layer) while this is true, so they never stall a drag that starts soon after the last edit.
    isGestureActive() {
        return Boolean(this.pointerHeld && this.visible && this.initialized);
    }

    buildEditBar() {
        const bar = document.createElement("div"); bar.className = "vnccs-uc-pose-editbar";
        const title = document.createElement("strong"); title.textContent = "Editing pose";
        const helpButton = this.host._button("?", "vnccs-uc-btn vnccs-uc-pose-eye", () => {
            if (this.help.open) this.help.hide(); else { this.help.show(); helpButton.setAttribute("aria-expanded", "true"); }
        }, "How editing a pose works");
        helpButton.setAttribute("aria-label", "Editing pose help"); helpButton.setAttribute("aria-expanded", "false");
        this.help = buildPoseHelp(document, { onClose: () => helpButton.setAttribute("aria-expanded", "false") });
        const eye = this.host._button("", "vnccs-uc-btn vnccs-uc-pose-eye", () => this.toggleWall(), "Show or hide the layers below (the wall)");
        eye.setAttribute("aria-label", "Toggle the layers below"); eye.setAttribute("aria-pressed", "true");
        eye.innerHTML = EYE_ICON;
        this.eyeButton = eye;
        const motion = this.host._button("Motion", "vnccs-uc-btn", () => this.studio?.openTextToMotionPanel?.({ poseOnly: true }), "Text to Motion: describe a movement, then pick the frame you want as this pose");
        const reset = this.host._button("Reset camera", "vnccs-uc-btn", () => this.resetCamera(), "Return the editing camera to the capture framing");
        const cancel = this.host._button("Cancel", "vnccs-uc-btn", () => this.host.finishPoseEdit(false), "Discard this edit session and restore the pose");
        const save = this.host._button("Save pose", "vnccs-uc-btn primary", () => this.host.finishPoseEdit(true), "Keep the pose and leave the editor (Enter / Esc)");
        bar.append(title, helpButton, eye, motion, reset, cancel, save);
        this.editBar = bar;
        return bar;
    }

    // The pose settings take the right sidebar only while the editor is shown.
    mountSidebar(show) {
        if (!this.sidePanel) return;
        const side = this.host.side;
        if (show && side) {
            if (this.sidePanel.parentNode !== side) side.appendChild(this.sidePanel);
            this.sideLayerName.textContent = this.layer?.name || "";
        } else this.sidePanel.remove();
        this.host.container.classList.toggle("vnccs-uc-pose-editing", Boolean(show && side));
    }

    // The character reference is an inline sidebar section: "open" draws attention to it.
    setCharacterOpen(open) {
        if (!this.characterMenu) return;
        this.characterMenu.classList.toggle("attention", Boolean(open));
        if (!open) return;
        this.characterMenu.scrollIntoView?.({ block: "nearest" });
        this.characterSelect?.focus({ preventScroll: true });
    }

    buildCharacterMenu() {
        const menu = document.createElement("div"); menu.className = "vnccs-uc-pose-character";
        menu.id = `uc-pose-character-${this.layer.id}`;
        menu.setAttribute("role", "group"); menu.setAttribute("aria-label", "Character reference");
        const header = document.createElement("div"); header.className = "vnccs-uc-pose-character-header";
        const title = document.createElement("strong"); title.textContent = "Character reference";
        header.append(title);
        const select = document.createElement("select"); select.className = "vnccs-uc-select";
        select.id = `${menu.id}-source`;
        select.setAttribute("aria-label", "Character image source");
        const image = document.createElement("img"); image.alt = "Selected character"; image.hidden = true;
        const row = document.createElement("div"); row.className = "vnccs-uc-pose-character-row";
        row.append(image, select);
        const issue = document.createElement("div"); issue.className = "vnccs-uc-pose-character-issue";
        const file = document.createElement("input"); file.type = "file"; file.accept = "image/*"; file.hidden = true;
        const upload = this.host._button("Upload image", "vnccs-uc-btn", () => file.click());
        const clear = this.host._button("Clear", "vnccs-uc-btn", () => {
            this.host.recordHistoryBefore(); this.layer.pose.character = null;
            this.refreshCharacterMenu(); this.host.syncToNode();
        });
        const actions = document.createElement("div"); actions.className = "vnccs-uc-pose-character-actions";
        actions.append(upload, clear);
        select.addEventListener("change", async () => {
            if (select.value === "__uploaded__") return;
            if (select.value.startsWith("vnccs:")) {
                await this.pickVnccsCharacter(select.value.slice(6));
                return;
            }
            this.host.recordHistoryBefore();
            this.layer.pose.character = select.value ? { source: "layer", layerId: select.value } : null;
            this.setCharacterOpen(false);
            this.refreshCharacterMenu(); this.host.syncToNode();
        });
        file.addEventListener("change", async () => {
            const chosen = file.files?.[0]; file.value = "";
            if (!chosen) return;
            const token = this.token, layer = this.layer;
            try {
                const url = URL.createObjectURL(chosen);
                let loaded;
                try { loaded = await this.host.loadImage(url); } finally { URL.revokeObjectURL(url); }
                if (token !== this.token || !this.host.layers.includes(layer)) return;
                const scale = Math.min(1, 2048 / Math.max(loaded.width, loaded.height));
                const surface = this.host._createCanvas(Math.max(1, Math.round(loaded.width * scale)), Math.max(1, Math.round(loaded.height * scale)));
                surface.getContext("2d").drawImage(loaded, 0, 0, surface.width, surface.height);
                this.host.recordHistoryBefore();
                layer.pose.character = { source: "upload", name: chosen.name, dataURL: surface.toDataURL("image/png") };
                this.characterMenuKey = null;
                this.setCharacterOpen(false);
                this.refreshCharacterMenu(); this.host.syncToNode();
            } catch (error) { this.host.setStatus(`Character image: ${error.message || error}`, true); }
        });
        menu.append(header, row, issue, actions, file);
        this.characterMenu = menu; this.characterClear = clear; this.characterIssue = issue;
        this.characterSelect = select; this.characterPreview = image;
        this.refreshCharacterMenu();
        return menu;
    }

    // Characters made with ComfyUI_VNCCS (Character Creator / Cloner), listed by its own
    // /vnccs/context_lists route; empty when that extension is not installed.
    async loadVnccsCharacters() {
        const host = this.host;
        if (host._vnccsCharacters) return host._vnccsCharacters;
        host._vnccsCharacters = fetch("/vnccs/context_lists")
            .then(res => (res.ok ? res.json() : {}))
            .then(data => (Array.isArray(data?.characters) ? data.characters.map(String).filter(Boolean) : []))
            .catch(() => []);
        const list = await host._vnccsCharacters;
        host._vnccsCharacters = Promise.resolve(list);
        return list;
    }

    async pickVnccsCharacter(name) {
        const token = this.token, layer = this.layer;
        try {
            const query = `character=${encodeURIComponent(name)}`;
            let res = await fetch(`/vnccs/get_cached_preview?${query}`);
            if (!res.ok) res = await fetch(`/vnccs/get_character_pose_preview?${query}&index=0`);
            if (!res.ok) throw new Error(`no preview image for ${name} (HTTP ${res.status})`);
            const blob = await res.blob();
            const dataURL = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(blob);
            });
            if (token !== this.token || !this.host.layers.includes(layer)) return;
            this.host.recordHistoryBefore();
            layer.pose.character = { source: "upload", name, vnccsCharacter: name, dataURL };
            this.characterMenuKey = null;
            this.setCharacterOpen(false);
            this.refreshCharacterMenu(); this.host.syncToNode();
        } catch (error) {
            this.host.setStatus(`Character reference: ${error.message || error}`, true);
            this.characterMenuKey = null;
            this.refreshCharacterMenu();
        }
    }

    refreshCharacterMenu() {
        if (!this.characterSelect) return;
        const select = this.characterSelect, character = this.layer.pose.character;
        const characters = this.host._vnccsCharacterList || [];
        const key = JSON.stringify([character?.source, character?.layerId, character?.name, characters]);
        if (key === this.characterMenuKey) return;
        this.characterMenuKey = key;
        if (!this.host._vnccsCharacterList) {
            void this.loadVnccsCharacters().then(list => {
                this.host._vnccsCharacterList = list;
                this.characterMenuKey = null;
                this.refreshCharacterMenu();
            });
        }
        select.replaceChildren(new Option(characters.length ? "Choose a character" : "No VNCCS characters - upload an image", ""));
        for (const name of characters) {
            if (character?.vnccsCharacter !== name) select.add(new Option(name, `vnccs:${name}`));
        }
        if (character?.source === "upload") select.add(new Option(character.name, "__uploaded__"));
        // Older poses referenced a canvas layer: keep showing that choice, but offer no new ones.
        const legacy = character?.source === "layer" ? this.host.layers.find(item => item.id === character.layerId) : null;
        if (legacy) select.add(new Option(`Layer: ${legacy.name}`, legacy.id));
        select.value = character?.source === "layer" ? character.layerId : character?.source === "upload" ? "__uploaded__" : "";
        const selected = character?.source === "layer" ? this.host.layers.find(item => item.id === character.layerId) : null;
        const src = character?.source === "upload" ? character.dataURL
            : selected ? this.host.getLayerThumbnailCanvas(selected, 256)?.toDataURL("image/png") : null;
        this.characterPreview.hidden = !src;
        if (src) this.characterPreview.src = src;
        else this.characterPreview.removeAttribute("src");
        this.characterClear.disabled = !character;
        this.characterIssue.textContent = character ? "" : "Needed to generate: pick a VNCCS character or upload an image.";
    }

    // Pose Studio's own history (mannequin edits; the animation timeline in animation mode),
    // driven by UniCanvas's Undo/Redo buttons and Ctrl+Z / Ctrl+Y while a pose is edited.
    historyDepth() {
        const viewer = this.studio?.viewer;
        return { undo: viewer?.history?.length || 0, redo: viewer?.future?.length || 0 };
    }

    // Pose Studio history snapshots carry the camera (view, framing sliders). Undo / redo must
    // only revert the mannequin: the inspection view, the capture framing and the wall stay put.
    keepingCameraDuring(action) {
        const { layer, studio } = this, viewer = studio.viewer;
        const framing = clone(layer.pose.viewport), inspection = this.snapshotViewerCamera();
        // Offset and zoom are the mannequin's own placement and scale, so they do undo; the view angles do not.
        const keys = ["cam_yaw_deg", "cam_pitch_deg"];
        const params = Object.fromEntries(keys.map(key => [key, studio.exportParams[key]]));
        this.keepingCamera = true;
        try { action(); }
        finally {
            this.keepingCamera = false;
            Object.assign(studio.exportParams, params);
            if (viewer.cameraParams) viewer.cameraParams = { ...viewer.cameraParams, yaw_deg: params.cam_yaw_deg, pitch_deg: params.cam_pitch_deg };
            layer.pose.viewport = framing;
            this.applyViewerCamera(inspection);
            studio.persistActivePoseCameraParams?.();
            viewer.requestRender?.();
        }
    }

    undo() {
        const studio = this.studio;
        if (!studio) return false;
        if (studio.isAnimationMode?.()) studio.undoAnimation?.();
        else this.keepingCameraDuring(() => studio.viewer?.undo?.());
        return true;
    }

    redo() {
        const studio = this.studio;
        if (!studio) return false;
        if (studio.isAnimationMode?.()) studio.redoAnimation?.();
        else this.keepingCameraDuring(() => studio.viewer?.redo?.());
        return true;
    }

    setVisible(visible) {
        this.visible = visible;
        if (!visible) this.pointerHeld = false;
        if (!this.studio) return;
        this.studio.container.hidden = !visible;
        if (!visible && this.studio.viewer?.orbit) this.studio.viewer.orbit.enableDamping = false;
        if (!visible) { this.resetCamera(); this.studio.viewer?.camera?.clearViewOffset?.(); this.viewOffsetKey = null; }
        this.host.container.classList.toggle("vnccs-uc-pose-active", visible);
        this.mountSidebar(visible);
        if (!visible) {
            this.setCharacterOpen(false);
            this.studio.animationTimeline?.stopPlayback?.();
            this.studio._closeCharacterRemoveModal?.();
            this.studio._activeSaveLibraryClose?.(true);
            this.studio._activeVideoImportClose?.();
            this.studio.hideHandControlPopover();
        }
        this.layout();
        this.host.requestRender();
    }

    layout() {
        if (!this.studio || !this.layer) return;
        if (!this.host.layers.includes(this.layer)) { this.release(); return; }
        const rect = this.layer.pose.rect, view = this.host.view, stage = this.host.stageWrap;
        const surface = this.studio.canvasContainer;
        // Controls are confined to the stage, leaving model settings, Generate and layers accessible.
        Object.assign(this.controls.style, { left: `${stage.offsetLeft}px`, top: `${stage.offsetTop}px`,
            width: `${stage.clientWidth}px`, height: `${stage.clientHeight}px` });
        this.controls.inert = this.layer.locked || !this.layer.visible || this.host.hasOpenStagingPanel();
        this.sidePanel.inert = this.layer.locked || !this.layer.visible;
        // The session viewport covers the whole stage, not the generation box: the camera is
        // free to look at (and edit) the mannequin anywhere, and the rect is only where the
        // framing lands (see syncSessionViewOffset).
        Object.assign(surface.style, { left: `${stage.offsetLeft}px`, top: `${stage.offsetTop}px`,
            width: `${stage.clientWidth}px`, height: `${stage.clientHeight}px` });
        surface.style.opacity = String(this.layer.opacity);
        surface.style.mixBlendMode = this.layer.blendMode === "source-over" ? "normal" : this.layer.blendMode;
        surface.hidden = !this.layer.visible || this.layer.locked || this.host.hasOpenStagingPanel();
        this.syncSessionViewOffset();
        if (this.initialized) this.refreshWall();
        // The baked pixels became visible (layer locked or hidden, staging panel opened) after frames
        // that skipped their capture: one viewport frame re-captures them through onViewportRender.
        if (this.previewStale && this.visible && this.initialized && !this.hidesLayerPixels(this.layer)) {
            this.studio.viewer?.requestRender?.();
        }
        if (!this.visible && this.initialized) {
            const scale = Math.min(1, 1024 / Math.max(rect.width, rect.height));
            this.studio.performViewerResize(Math.round(rect.width * scale), Math.round(rect.height * scale));
        }
        this.refreshCharacterMenu();
    }

    // The viewport camera renders a window of its frustum extended over the whole stage so the
    // capture framing lands exactly on the pose rect, pixel for pixel: the framing has the rect's
    // aspect and height rh px, the camera's own frustum (aspect A) is then A*rh px wide, centred
    // on the rect. Orbit / pan / wheel move the camera only; the offset stays.
    syncSessionViewOffset() {
        const v = this.studio?.viewer, camera = v?.camera, surface = this.studio?.canvasContainer;
        if (!this.initialized || !this.visible || !this.layer || typeof camera?.setViewOffset !== "function") return;
        const { view } = this.host, rect = this.layer.pose.rect;
        const cw = surface.clientWidth, ch = surface.clientHeight, aspect = camera.aspect;
        const rx = view.x + rect.x * view.scale, ry = view.y + rect.y * view.scale;
        const rw = rect.width * view.scale, rh = rect.height * view.scale;
        if (!(cw > 0 && ch > 0 && rw > 0 && rh > 0 && aspect > 0)) return;
        const key = [rx, ry, rw, rh, cw, ch, aspect].map(value => Math.round(value * 100) / 100).join(",");
        if (key === this.viewOffsetKey) return;
        this.viewOffsetKey = key;
        const fullWidth = aspect * rh;
        camera.setViewOffset(fullWidth, rh, fullWidth / 2 - (rx + rw / 2), -ry, cw, ch);
        camera.updateProjectionMatrix();
    }

    // The lower layers, composited over the wall region (rect plus what the layers add, within one
    // rect size around it), textured onto the wall. Rebuilt only when the inputs change.
    refreshWall() {
        if (!this.wall || !this.layer || !this.layer.pose.viewport) return;
        const rect = this.layer.pose.rect, lower = poseLayerBelow(this.host.layers, this.layer);
        const radius = (this.backdrop.bounds ||= this.backdrop.measure())?.radius;
        const key = JSON.stringify([rect, this.layer.pose.viewport, radius, lower.map(item => [item.id, item.opacity, item.blendMode])]);
        if (key === this.wallKey) return;
        this.wallKey = key;
        this.wallContent = lower.length > 0;
        if (!lower.length) { this.wall.update(null); return; }
        let x1 = rect.x, y1 = rect.y, x2 = rect.x + rect.width, y2 = rect.y + rect.height;
        for (const item of lower) {
            const b = this.host.getLayerWorldBounds(item);
            if (!b) continue;
            x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.width); y2 = Math.max(y2, b.y + b.height);
        }
        x1 = Math.max(x1, rect.x - rect.width); y1 = Math.max(y1, rect.y - rect.height);
        x2 = Math.min(x2, rect.x + 2 * rect.width); y2 = Math.min(y2, rect.y + 2 * rect.height);
        const region = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
        const scale = Math.min(1, 4096 / Math.max(region.width, region.height));
        const canvas = this.host._createCanvas(Math.max(1, Math.round(region.width * scale)), Math.max(1, Math.round(region.height * scale)));
        const ctx = canvas.getContext("2d");
        for (const item of [...lower].reverse()) {
            ctx.save();
            ctx.globalAlpha = item.opacity;
            ctx.globalCompositeOperation = item.blendMode || "source-over";
            this.host.drawRasterLayerToWorldRect(ctx, item, region, { x: 0, y: 0, width: canvas.width, height: canvas.height });
            ctx.restore();
        }
        const framing = this.layer.pose.viewport;
        const mesh = this.studio.viewer.skinnedMesh;
        this.wall.update(canvas, poseWallPlacement(this.studio.viewer.THREE,
            { rect, region, framing, radius: (radius || 10) * Math.max(1e-3, mesh?.scale?.x || 1) }));
        if (this.wallShown === false) this.wall.mesh.visible = false;
        this.studio.viewer.requestRender?.();
    }

    // The rotation gizmo keeps a constant screen size, so a zoomed-out (scaled-down) character
    // was dwarfed by it. Scale it with the character's zoom instead.
    syncGizmoSize() {
        const viewer = this.studio?.viewer, control = viewer?.transform;
        if (!control?.setSize) return;
        const size = GIZMO_SIZE * Math.max(0.15, Math.min(2, viewer.skinnedMesh?.scale?.x || 1));
        if (Math.abs((control.size ?? 0) - size) < 1e-3) return;
        control.setSize(size);
        viewer.requestRender?.();
    }

    // Show or hide the layers-below wall; the pixels of the layer are never affected.
    toggleWall() {
        if (!this.wall) return;
        this.wall.mesh.visible = !this.wall.mesh.visible;
        this.wallShown = this.wall.mesh.visible;
        this.eyeButton?.setAttribute("aria-pressed", String(this.wall.mesh.visible));
        if (this.eyeButton) this.eyeButton.innerHTML = this.wall.mesh.visible ? EYE_ICON : EYE_OFF_ICON;
        this.studio?.viewer?.requestRender?.();
        this.host.requestRender();
    }

    // Put the inspection camera back on the capture framing (the mannequin is untouched).
    resetCamera() {
        const framing = this.layer?.pose.viewport;
        if (!this.initialized || !framing) return;
        this.applyViewerCamera(framing);
        this.studio.viewer.requestRender?.();
    }

    // The persisted capture framing (what the layer pixels show), as a plain camera object.
    snapshotViewerCamera() {
        const v = this.studio.viewer;
        return { position: v.camera.position.toArray(), target: v.orbit.target.toArray(), fov: v.camera.fov, zoom: v.camera.zoom };
    }

    saveCaptureFraming() {
        this.layer.pose.viewport = this.snapshotViewerCamera();
    }

    applyViewerCamera(camera) {
        const v = this.studio.viewer;
        v.camera.position.fromArray(camera.position);
        v.orbit.target.fromArray(camera.target);
        v.camera.fov = camera.fov;
        v.camera.zoom = camera.zoom || 1;
        v.camera.updateProjectionMatrix();
        v.orbit.update();
    }

    // World rect the layer pixels cover: the pose rect grown to hold the whole mannequin as seen
    // by the capture framing (never clipped to the generation box), within one rect size around it.
    bakeRegion() {
        const rect = this.layer.pose.rect, v = this.studio.viewer, THREE = v.THREE;
        const framing = this.layer.pose.viewport;
        if (!framing || !THREE) return { ...rect };
        const camera = v.camera.clone();
        camera.position.fromArray(framing.position); camera.fov = framing.fov; camera.zoom = framing.zoom || 1;
        camera.aspect = rect.width / rect.height; camera.up.set(0, 1, 0);
        camera.lookAt(new THREE.Vector3().fromArray(framing.target));
        camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
        let x1 = rect.x, y1 = rect.y, x2 = rect.x + rect.width, y2 = rect.y + rect.height;
        const box = new THREE.Box3(), corner = new THREE.Vector3();
        for (const { mesh } of this.backdrop?.characterMeshes?.() || []) {
            mesh.updateMatrixWorld(true);
            box.setFromObject(mesh);
            if (box.isEmpty()) continue;
            for (let i = 0; i < 8; i += 1) {
                corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(camera);
                if (!Number.isFinite(corner.x + corner.y)) continue;
                const px = rect.x + (corner.x + 1) / 2 * rect.width, py = rect.y + (1 - corner.y) / 2 * rect.height;
                x1 = Math.min(x1, px); x2 = Math.max(x2, px); y1 = Math.min(y1, py); y2 = Math.max(y2, py);
            }
        }
        // Pad only the sides the figure actually crosses; a figure inside the box keeps the box.
        const pad = 0.04 * Math.max(rect.width, rect.height);
        const left = x1 < rect.x ? Math.max(rect.x - rect.width, Math.floor(x1 - pad)) : rect.x;
        const top = y1 < rect.y ? Math.max(rect.y - rect.height, Math.floor(y1 - pad)) : rect.y;
        const right = x2 > rect.x + rect.width ? Math.min(rect.x + 2 * rect.width, Math.ceil(x2 + pad)) : rect.x + rect.width;
        const bottom = y2 > rect.y + rect.height ? Math.min(rect.y + 2 * rect.height, Math.ceil(y2 + pad)) : rect.y + rect.height;
        const region = { x: left, y: top, width: right - left, height: bottom - top };
        return region.width > 0 && region.height > 0 && this.host.ensureWorldRectBounds(region, 0) ? region : { ...rect };
    }

    // `scale` is capture pixels per world pixel; the result covers `region` (default: the pose rect).
    captureSurface(scale, transparent = true, region = this.layer.pose.rect) {
        if (!this.initialized) return null;
        const width = Math.max(1, Math.round(region.width * scale)), height = Math.max(1, Math.round(region.height * scale));
        const target = transparent
            ? (this.previewSurface ||= this.host._createCanvas(width, height))
            : this.host._createCanvas(width, height);
        const w = this.studio, v = w.viewer, camera = v.camera, rect = this.layer.pose.rect;
        // The capture renders the STORED framing with zeroed offsets, never the live inspection
        // view: borrow the camera and put the inspection view back afterwards.
        const framing = this.layer.pose.viewport || this.snapshotViewerCamera();
        const inspection = this.snapshotViewerCamera();
        // three mutates camera.view in place: keep a copy, restore through the API.
        const savedView = camera.view ? { ...camera.view } : null, savedAspect = camera.aspect;
        this.applyViewerCamera(framing);
        // The framing has the pose rect's aspect; a window of it covers the (larger) region.
        camera.aspect = rect.width / rect.height;
        camera.setViewOffset(rect.width * scale, rect.height * scale,
            (region.x - rect.x) * scale, (region.y - rect.y) * scale, width, height);
        camera.updateProjectionMatrix();
        // The temporary camera move must not let the backdrop depth clamp translate anyone.
        if (this.backdrop) this.backdrop.suppressClamp = true;
        const wallWasVisible = this.wall?.mesh.visible;
        if (this.wall) this.wall.mesh.visible = false;
        try {
            return v.capture(width, height, 1, w.exportParams.bg_color, 0, 0,
                w.exportParams.cam_yaw_deg || 0, w.exportParams.cam_pitch_deg || 0,
                { targetCanvas: target, transparent, hideReference: true, viewport: true });
        } finally {
            if (this.wall) this.wall.mesh.visible = wallWasVisible;
            if (this.backdrop) this.backdrop.suppressClamp = false;
            camera.aspect = savedAspect;
            if (savedView?.enabled) camera.setViewOffset(savedView.fullWidth, savedView.fullHeight,
                savedView.offsetX, savedView.offsetY, savedView.width, savedView.height);
            else camera.clearViewOffset();
            this.applyViewerCamera(inspection);
            // capture() leaves the stored-framing image in the visible buffer; repaint the
            // inspection view synchronously so navigation never flashes the capture framing.
            if (this.visible && v.renderer) v.renderer.render(v.scene, camera);
        }
    }

    capturePreview(final = false) {
        if (this.capturing || !this.initialized || !this.host.layers.includes(this.layer)) return;
        // Navigation frames are inspection-only: the pixels hold the stored framing already.
        if (!final && this.inspecting) return;
        this.capturing = true;
        try {
            const rect = this.layer.pose.rect;
            // The live preview must stay sharp while the inspection camera moves around it:
            // the pixels re-capture on the stored framing, so a fixed low preview size looked
            // rasterized and jumped to smooth on the final capture.
            const cap = 2048 / Math.max(rect.width, rect.height);
            const screen = (this.host.view?.scale || 1) * (window.devicePixelRatio || 1);
            const scale = Math.min(1, cap, final ? Math.max(screen, cap) : screen);
            const region = this.bakeRegion();
            const surface = this.captureSurface(scale, true, region);
            if (!surface) return;
            const ctx = this.layer.canvas.getContext("2d");
            ctx.clearRect(0, 0, this.layer.canvas.width, this.layer.canvas.height);
            ctx.drawImage(surface, region.x - this.host.origin.x, region.y - this.host.origin.y, region.width, region.height);
            this.previewStale = false;
            this.layer.hiresCanvas = surface;
            this.layer.hiresRect = { ...region };
            this.host.markLayerPixelsChanged(this.layer);
            this.host.requestRender();
            if (final) this.host.refreshLayerRow?.(this.layer.id);
        } finally {
            this.capturing = false;
        }
    }

    applyDimensions(params) {
        if (!params) return;
        const previous = this.layer.pose.studio?.export || {};
        if (previous.view_width === params.view_width && previous.view_height === params.view_height) return;
        const rect = this.layer.pose.rect;
        const width = Math.max(64, Math.min(4096, Math.round(Number(params.view_width) || rect.width)));
        const height = Math.max(64, Math.min(4096, Math.round(Number(params.view_height) || rect.height)));
        if (rect.width === width && rect.height === height) return;
        const next = { ...rect, width, height };
        if (!this.host.ensureWorldRectBounds(next, 0)) return;
        const bbox = this.host.bbox;
        const followsBbox = ["x", "y", "width", "height"].every(key => bbox[key] === rect[key]);
        this.layer.pose.rect = next;
        if (followsBbox && !this.host.panorama) this.host.bbox = { ...next };
        this.layout();
        this.studio.performViewerResize(width, height);
        this.host.requestRender();
    }

    saveUI() {
        if (!this.layer || !this.pages) return;
        this.layer.pose.ui = { tab: this.activePage || 0, pages: this.pages.map(entry => ({
            top: entry.page.hidden ? entry.scrollTop : entry.page.scrollTop,
            left: entry.page.hidden ? entry.scrollLeft : entry.page.scrollLeft,
            collapsed: Array.from(entry.page.querySelectorAll?.(".vnccs-ps-section") || [], section => section.classList.contains("collapsed")),
        })) };
    }

    // While the editor is shown, its live viewport replaces the layer pixels on screen: the
    // stage must skip the bitmap so navigation cannot ghost the baked framing underneath
    // (the pre-0.6.8 editor did the same via layer._poseEditing). Mirrors the surface
    // visibility rules in layout(), so both the viewport and the bitmap hide together.
    // True while the editing view is shown: the stage skips the generation box outline.
    hidesBbox() {
        return Boolean(this.visible && this.initialized && this.layer?.visible && !this.layer.locked && !this.host.hasOpenStagingPanel());
    }

    hidesLayerPixels(layer) {
        const editing = this.visible && this.initialized && this.layer.visible && !this.layer.locked && !this.host.hasOpenStagingPanel();
        if (!editing) return false;
        // The layers below are drawn by the wall inside the 3D view while it is shown.
        return this.layer === layer || (this.wallContent && poseLayerBelow(this.host.layers, this.layer).includes(layer));
    }

    commit() {
        if (!this.initialized || !this.host.layers.includes(this.layer) || !poseAtPanoramaCamera(this.layer, this.host.panorama)) return;
        this.capturePreview(true);
        this.saveUI();
        this.host.panorama?.commitLayer(this.layer);
        this.studio.syncToNode(false, { skipCapture: true, skipCaptureUpload: true });
    }

    // One trailing full-quality bake per settled edit gesture (AGENTS.md realtime rule:
    // frames stay live, the expensive final capture follows the gesture).
    scheduleCommit() {
        if (!this.initialized) return;
        clearTimeout(this.commitTimer);
        const token = this.token;
        this.commitTimer = setTimeout(() => {
            this.commitTimer = null;
            if (token !== this.token || !this.studio) return;
            this.commit();
        }, 250);
    }

    // A torso drag or a depth clamp moved a character. The mesh and the camera sliders already
    // show it; persisting runs the whole Pose Studio serialization (and dirties the ComfyUI graph),
    // so it follows the movement once instead of running on every drag frame.
    scheduleBackdropSync() {
        clearTimeout(this.backdropSyncTimer);
        this.backdropSyncTimer = setTimeout(() => this.flushBackdropSync(), 120);
    }

    // Persist a pending character move now (called when the torso drag ends).
    flushBackdropSync() {
        if (!this.backdropSyncTimer) return;
        clearTimeout(this.backdropSyncTimer);
        this.backdropSyncTimer = null;
        this.studio?.syncToNode(false, { skipCapture: true, skipCaptureUpload: true });
    }

    async flush() {
        const token = this.token, studio = this.studio;
        await this.ready;
        if (token !== this.token) throw new Error("The pose layer changed while preparing the image.");
        if (!this.initialized) return;
        await studio.awaitReadyForCompositeCapture();
        if (token !== this.token) throw new Error("The pose layer changed while preparing the image.");
        this.commit();
        await this.studio.flushAnimationCacheUpload();
    }

    async generation(layer, size) {
        // A rotated spherical layer already contains the correctly warped pose.
        // Reopening its original camera here would change the generation view.
        const projected = !poseAtPanoramaCamera(layer, this.host.panorama);
        if (!projected) {
            await this.activate(layer, { show: this.host.tool === "pose" });
            await this.flush();
            if (this.layer !== layer) throw new Error("The pose layer changed. Generate again.");
        }
        if (!this.host.layers.includes(layer)) throw new Error("The pose layer changed. Generate again.");
        const token = this.token;
        const state = layer.pose.studio;
        const params = state.export || {};
        const bg = params.bg_color || [255, 255, 255];
        const image1 = this.host._createCanvas(size.width, size.height);
        const ctx = image1.getContext("2d");
        ctx.fillStyle = `rgb(${bg.join(",")})`;
        ctx.fillRect(0, 0, image1.width, image1.height);
        this.host.drawRasterLayerToWorldRect(ctx, layer, this.host.bbox,
            { x: 0, y: 0, width: image1.width, height: image1.height });
        const image2 = await composePoseReference(this.host, layer, size);
        if (token !== this.token || !this.host.layers.includes(layer)) throw new Error("The pose layer changed. Generate again.");
        const index = state.activeTab || 0;
        const posePrompt = state.pose_prompts?.[index] ?? state.poses?.[index]?.prompt ?? params.user_prompt ?? "";
        const userPrompt = [posePrompt, this.host.settings.positive].filter(Boolean).join("\n");
        const positive = PoseStudioWidget.prototype.generatePromptFromLights.call(
            { exportParams: params }, state.lights || [], userPrompt,
        );
        const reference = image2.toDataURL("image/png");
        return {
            pose_edit: { image1: image1.toDataURL("image/png"), image2: reference },
            positive,
        };
    }

    release() {
        this.saveUI();
        this.commit();
        ++this.token;
        this.initialized = false;
        this.inspecting = false;
        clearTimeout(this.commitTimer); this.commitTimer = null;
        clearTimeout(this.wheelInspectionTimer); this.wheelInspectionTimer = null;
        clearTimeout(this.backdropSyncTimer); this.backdropSyncTimer = null;
        this.previewStale = false; this.pointerHeld = false;
        this.backdrop?.dispose(); this.backdrop = null; this.meshKey = null;
        this.disposeBodyDrag?.(); this.disposeBodyDrag = null;
        this.wall?.dispose(); this.wall = null; this.wallKey = null; this.wallShown = true; this.wallContent = false;
        this.selectController?.disconnect();
        this.uiAbort?.abort(); this.uiAbort = null;
        this.selectController = null;
        this.studio?.dispose();
        this.studio?.container.remove();
        this.studio = null; this.layer = null; this.ready = null; this.previewSurface = null; this.viewOffsetKey = null;
        this.characterSelect = null; this.characterMenuKey = null; this.stateKey = null; this.pages = null;
        this.sidePanel?.remove();
        this.controls = null; this.characterMenu = null; this.sidePanel = null; this.editBar = null;
        this.host.container.classList.remove("vnccs-uc-pose-active", "vnccs-uc-pose-editing");
    }
    dispose() { this.release(); this.abort.abort(); }
}
