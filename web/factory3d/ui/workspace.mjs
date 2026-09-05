import { normalizedWorkspace, WORKSPACE_LAYOUTS, fitWorkspaceDocks } from "../core/editor_migrations.mjs";

/** A tab owns one panel, in both resizable and fixed-width layouts. */
export function activateWorkspaceTab(buttons, panels, side, tab) {
    let activeButton = null;
    for (const button of buttons) {
        if (button.dataset.workspaceSide !== side) continue;
        const active = button.dataset.workspaceTab === tab;
        button.setAttribute("aria-selected", String(active));
        button.tabIndex = active ? 0 : -1;
        if (active) activeButton = button;
    }
    for (const panel of panels) {
        if (panel.dataset.workspaceSide === side) panel.hidden = panel.dataset.workspacePanel !== tab;
    }
    return activeButton;
}

function button(label, action) {
    const control = document.createElement("button");
    control.type = "button";
    control.className = "vnccs-i3s__button";
    control.textContent = label;
    control.addEventListener("click", action);
    return control;
}

/** Owns panels and expansion; the existing widget keeps the same canvas/store. */
export class FactoryWorkspace {
    constructor({ root, getState, setState, resize, selectTab, command }) {
        Object.assign(this, { root, getState, setState, resize, selectTab, command });
        this.cleanups = [];
        this.frame = 0;
        this.drag = null;
        this.bar = document.createElement("nav");
        this.bar.className = "vnccs-i3s__workspace-bar";
        this.bar.setAttribute("aria-label", "Editor workspace");
        this.assets = button("Assets", () => this.change({ left_visible: !this.effectiveLeftVisible }));
        this.inspector = button("Scene tools", () => this.change({ right_visible: !this.state().right_visible }));
        this.layout = document.createElement("select");
        this.layout.className = "vnccs-i3s__select";
        this.layout.setAttribute("aria-label", "Workspace layout");
        for (const name of WORKSPACE_LAYOUTS) {
            const option = document.createElement("option");
            option.value = name; option.textContent = name[0].toUpperCase() + name.slice(1);
            this.layout.append(option);
        }
        this.layout.addEventListener("change", () => this.applyLayout(this.layout.value));
        this.commands = button("Commands", () => this.command("palette"));
        this.expand = button("Expand editor", () => this.toggleExpanded());
        this.legacy = button("Panel mode", () => this.change({ docked: !this.state().docked, left_visible: true, right_visible: true }));
        this.legacy.title = "Switch between resizable and fixed-width panels; tabs stay separate";
        this.bar.append(this.assets, this.layout, this.inspector, this.commands, this.legacy, this.expand);
        root.prepend(this.bar);
        this.leftGrip = this.grip("left_width", "Resize Assets dock", "vertical");
        this.rightGrip = this.grip("right_width", "Resize Inspector dock", "vertical");
        root.querySelector(".vnccs-i3s__side--left").append(this.leftGrip);
        root.querySelector(".vnccs-i3s__side--right").append(this.rightGrip);
        const keydown = event => {
            if (this.overlay && event.key === "Escape" && !event.defaultPrevented && !root.querySelector(".vnccs-i3s__modal-layer > *")) {
                event.preventDefault(); this.toggleExpanded(false);
            }
            if (!this.overlay || event.key !== "Tab") return;
            const focusable = [...root.querySelectorAll('button, input, select, textarea, [tabindex="0"]')]
                .filter(item => !item.disabled && item.getClientRects().length);
            const first = focusable[0], last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        };
        root.addEventListener("keydown", keydown);
        this.cleanups.push(() => root.removeEventListener("keydown", keydown));
        this.observer = new ResizeObserver(() => this.refresh());
        this.observer.observe(root);
        this.refresh();
    }

    state() { return normalizedWorkspace(this.getState()); }
    change(patch, final = true) {
        if (Object.hasOwn(patch, "left_visible")) this.drawerLeftOpen = patch.left_visible;
        if (this.root.clientWidth < 760 && patch.left_visible === true) patch.right_visible = false;
        if (this.root.clientWidth < 760 && patch.right_visible === true) patch.left_visible = false;
        this.setState(normalizedWorkspace({ ...this.state(), ...patch }), final);
        this.refresh();
        if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.resize(); });
    }

    applyLayout(layout) {
        this.change({ layout, docked: true, left_visible: ["scene", "camera"].includes(layout), right_visible: true });
        this.selectTab("left", layout === "camera" ? "cameras" : "generate");
        this.selectTab("right", layout === "output" ? "export" : "objects");
        if (layout === "lighting") this.command("lighting");
        // Layout changes do not change the active camera or viewport mode.
    }

    refresh() {
        const state = this.state();
        const width = this.root.clientWidth;
        this.root.classList.toggle("has-docked-workspace", state.docked);
        if (width >= 980) this.drawerLeftOpen = undefined;
        this.effectiveLeftVisible = state.left_visible && (width >= 980 || this.drawerLeftOpen === true);
        this.root.classList.toggle("workspace-hide-left", !this.effectiveLeftVisible);
        this.root.classList.toggle("workspace-hide-right", !state.right_visible);
        this.root.classList.toggle("workspace-drawers", width < 980);
        this.root.classList.toggle("workspace-small", width < 760);
        const fitted = fitWorkspaceDocks(state, width);
        this.root.style.setProperty("--factory-left-width", `${fitted.left}px`);
        this.root.style.setProperty("--factory-right-width", `${fitted.right}px`);
        this.layout.value = state.layout;
        this.assets.setAttribute("aria-pressed", String(this.effectiveLeftVisible));
        this.inspector.setAttribute("aria-pressed", String(state.right_visible));
        this.legacy.setAttribute("aria-pressed", String(state.docked));
        for (const grip of [this.leftGrip, this.rightGrip]) {
            grip.setAttribute("aria-valuenow", String(state[grip.dataset.property]));
        }
    }

    grip(property, label, orientation) {
        const grip = document.createElement("div");
        grip.className = `vnccs-i3s__dock-grip vnccs-i3s__dock-grip--${property}`;
        grip.dataset.property = property;
        grip.tabIndex = 0;
        grip.setAttribute("role", "separator");
        grip.setAttribute("aria-label", label);
        grip.setAttribute("aria-orientation", orientation);
        const limits = property === "left_width" ? [180, 420] : [240, 480];
        grip.setAttribute("aria-valuemin", String(limits[0]));
        grip.setAttribute("aria-valuemax", String(limits[1]));
        const settle = cancel => {
            if (this.drag?.property !== property) return;
            const start = this.drag.value;
            this.drag = null;
            this.change({ [property]: cancel ? start : this.state()[property] });
        };
        grip.addEventListener("pointerdown", event => {
            if (event.button !== 0) return;
            event.preventDefault(); event.stopPropagation();
            this.drag = { property, value: this.state()[property], x: event.clientX, y: event.clientY };
            grip.setPointerCapture(event.pointerId);
        });
        grip.addEventListener("pointermove", event => {
            if (this.drag?.property !== property) return;
            const scale = this.root.getBoundingClientRect().width / Math.max(1, this.root.clientWidth);
            const delta = (event.clientX - this.drag.x) / scale * (property === "right_width" ? -1 : 1);
            this.change({ [property]: this.drag.value + delta }, false);
        });
        grip.addEventListener("dblclick", () => this.change({ [property]: normalizedWorkspace()[property] }));
        grip.addEventListener("pointerup", () => settle(false));
        grip.addEventListener("pointercancel", () => settle(true));
        grip.addEventListener("lostpointercapture", () => settle(true));
        grip.addEventListener("keydown", event => {
            if (event.key === "Escape") { event.stopPropagation(); settle(true); return; }
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation();
            const delta = event.shiftKey ? 1 : 10;
            const value = event.key === "Home" ? limits[0] : event.key === "End" ? limits[1]
                : this.state()[property] + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -delta : delta);
            this.change({ [property]: value });
        });
        return grip;
    }

    toggleExpanded(enabled = !this.overlay) {
        if (enabled === Boolean(this.overlay)) return;
        const scroll = [...this.root.querySelectorAll("*")].filter(node => node.scrollTop || node.scrollLeft)
            .map(node => [node, node.scrollTop, node.scrollLeft]);
        if (enabled) {
            this.returnFocus = document.activeElement;
            this.placeholder = document.createComment("Factory editor home");
            this.root.before(this.placeholder);
            this.overlay = document.createElement("div");
            this.overlay.className = "vnccs-factory-expanded-host";
            this.overlay.setAttribute("role", "dialog");
            this.overlay.setAttribute("aria-modal", "true");
            this.overlay.setAttribute("aria-label", "Expanded 3D Factory editor");
            document.body.append(this.overlay);
            this.overlay.append(this.root);
            this.root.classList.add("is-expanded-editor");
            this.expand.textContent = "Close expanded editor";
        } else {
            this.placeholder.replaceWith(this.root);
            this.overlay.remove(); this.overlay = null; this.placeholder = null;
            this.root.classList.remove("is-expanded-editor");
            this.expand.textContent = "Expand editor";
        }
        this.resize(); this.refresh();
        for (const [node, top, left] of scroll) { node.scrollTop = top; node.scrollLeft = left; }
        const focus = !enabled && this.returnFocus?.isConnected ? this.returnFocus : this.expand;
        focus?.focus({ preventScroll: true });
        if (!enabled) this.returnFocus = null;
    }

    dispose() {
        if (this.overlay) this.toggleExpanded(false);
        this.observer.disconnect();
        if (this.frame) cancelAnimationFrame(this.frame);
        for (const cleanup of this.cleanups) cleanup();
        for (const element of [this.bar, this.leftGrip, this.rightGrip]) element.remove();
    }
}
