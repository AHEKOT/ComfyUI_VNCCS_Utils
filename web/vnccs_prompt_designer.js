import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { PromptDesignerWidget } from "./prompt_designer/widget.mjs";
import { syncPromptOutputs } from "./prompt_designer/outputs.mjs";

function hideState(node) {
    const widget = node.widgets?.find(item => item.name === "node_state");
    if (widget) {
        widget.type = "hidden";
        widget.hidden = true;
        widget.computeSize = () => [0, -4];
        if (widget.element) widget.element.style.display = "none";
    }
    return widget;
}

function fit(node) {
    if (!node.promptDesigner) return;
    node.promptDesigner.container.style.width = `${Math.max(0, node.size[0] - 20)}px`;
    node.promptDesigner.container.style.height = `${Math.max(360, node.size[1] - 70)}px`;
}

function enablePromptCanvasNavigation(widget) {
    const canvas = () => app.canvasEl || app.canvas?.canvas || document.querySelector("canvas.litegraph");
    let panning = false, lastEvent;
    const forwarded = event => {
        Object.defineProperty(event, "_vnccsPromptForwardedCanvasInput", { value: true });
        return event;
    };
    const forwardPan = (type, event, buttons) => {
        const target = canvas();
        if (!target) return false;
        const init = {
            bubbles: true, cancelable: true, view: window,
            screenX: event.screenX, screenY: event.screenY, clientX: event.clientX, clientY: event.clientY,
            ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey,
            button: 1, buttons, pointerId: event.pointerId, pointerType: event.pointerType, isPrimary: event.isPrimary,
        };
        target.dispatchEvent(forwarded(new PointerEvent(type, init)));
        target.dispatchEvent(forwarded(new MouseEvent(type.replace("pointer", "mouse"), init)));
        return true;
    };
    widget.on(widget.container, "pointerdown", event => {
        if (event.button !== 1 || event._vnccsPromptForwardedCanvasInput) return;
        if (!forwardPan("pointerdown", event, 4)) return;
        panning = true; lastEvent = event;
        event.preventDefault(); event.stopPropagation();
    }, { capture: true });
    widget.on(window, "pointermove", event => {
        if (!panning || event._vnccsPromptForwardedCanvasInput) return;
        lastEvent = event;
        event.preventDefault(); event.stopPropagation();
        forwardPan("pointermove", event, 4);
    }, { capture: true });
    const finishPan = event => {
        if (!panning || event._vnccsPromptForwardedCanvasInput) return;
        panning = false;
        event.preventDefault(); event.stopPropagation();
        forwardPan("pointerup", event, 0);
    };
    widget.on(window, "pointerup", finishPan, { capture: true });
    widget.on(window, "pointercancel", finishPan, { capture: true });
    widget.on(widget.container, "auxclick", event => {
        if (event.button === 1) { event.preventDefault(); event.stopPropagation(); }
    }, { capture: true });
    widget.on(widget.container, "wheel", event => {
        if (event._vnccsPromptForwardedCanvasInput) return;
        if (!event.ctrlKey && !event.metaKey) {
            for (let element = event.target; element && element !== widget.container; element = element.parentElement) {
                const style = getComputedStyle(element);
                if ((/(auto|scroll|overlay)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1)
                    || (/(auto|scroll|overlay)/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1)) return;
            }
        }
        const target = canvas();
        if (!target) return;
        target.dispatchEvent(forwarded(new WheelEvent("wheel", event)));
        event.preventDefault(); event.stopPropagation();
    }, { capture: true, passive: false });
    widget.events.signal.addEventListener("abort", () => {
        if (panning) forwardPan("pointerup", lastEvent, 0);
        panning = false;
    }, { once: true });
}

app.registerExtension({
    name: "VNCCS.PromptDesigner",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "VNCCS_PromptDesigner") return;
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = created?.apply(this, arguments);
            const state = hideState(this);
            this.promptDesigner = new PromptDesignerWidget(this, api);
            enablePromptCanvasNavigation(this.promptDesigner);
            if (this.promptDesigner.state) syncPromptOutputs(this, this.promptDesigner.state);
            this.addDOMWidget("vnccs_prompt_designer_ui", "ui", this.promptDesigner.container, {
                serialize: false, hideOnZoom: false, getMinHeight: () => 360,
            });
            if (state) {
                const beforeQueued = state.beforeQueued;
                state.beforeQueued = (...args) => {
                    beforeQueued?.apply(state, args);
                    this.promptDesigner.prepareForQueue();
                };
                state.serializeValue = () => {
                    const widget = this.promptDesigner;
                    // Workflow autosave must retain raw state even while recovery is pending/failed.
                    if (widget.restoring || widget.container.inert || widget.restoreError) return state.value;
                    return widget.serializeForPrompt();
                };
            }
            this.setSize([2200, 1480]);
            fit(this);
            this._promptDesignerConfigure = setTimeout(() => this.promptDesigner?.loadFromNode(), 0);
            return result;
        };
        const configured = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            this.promptDesigner?.invalidateRestore();
            const result = configured?.apply(this, arguments);
            hideState(this);
            if (this.promptDesigner) this.promptDesigner.container.inert = true;
            clearTimeout(this._promptDesignerConfigure);
            this._promptDesignerConfigure = setTimeout(() => {
                this.promptDesigner?.loadFromNode();
                fit(this);
            }, 0);
            return result;
        };
        const resized = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            if (size) { size[0] = Math.max(620, size[0]); size[1] = Math.max(450, size[1]); }
            const result = resized?.apply(this, arguments);
            fit(this);
            return result;
        };
        const serialized = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (info) {
            const result = serialized?.apply(this, arguments);
            const value = this.promptDesigner?.persist();
            // LiteGraph may collect widget values before onSerialize is called.
            if (value && info) {
                const index = this.widgets.findIndex(item => item.name === "node_state");
                if (index >= 0 && Array.isArray(info.widgets_values)) info.widgets_values[index] = value;
                info.properties ??= {};
                info.properties.promptDesigner = { ...this.properties.promptDesigner };
            }
            if (info) {
                info.properties ??= {};
                for (const name of ["promptDesignerLibraryWidth", "promptDesignerInspectorWidth", "promptDesignerPanelScroll"]) {
                    if (this.properties?.[name] !== undefined) info.properties[name] = this.properties[name];
                }
            }
            return result;
        };
        const removed = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            clearTimeout(this._promptDesignerConfigure);
            this.promptDesigner?.dispose();
            return removed?.apply(this, arguments);
        };
    },
});
