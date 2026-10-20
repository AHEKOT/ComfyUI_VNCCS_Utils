import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { CGCreatorWidget } from "./cg_creator/widget.mjs?v=20261019.1";

function hideState(node) {
    const widget = node.widgets?.find(item => item.name === "cg_data");
    if (!widget) return;
    widget.hidden = true; widget.computeSize = () => [0, -4]; widget.draw = () => {};
    if (widget.element) widget.element.style.display = "none";
    if (widget.inputEl) widget.inputEl.style.display = "none";
    return widget;
}

function fit(node) {
    const widget = node.cgCreatorDOM;
    if (widget && !widget._cgWidthBound) {
        Object.defineProperty(widget, "width", { configurable: true, get: () => node.size[0], set: () => {} }); widget._cgWidthBound = true;
    }
    node.cgCreator?.resize(); widget?.triggerDraw?.();
}

app.registerExtension({
    name: "VNCCS.CGCreator",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "VNCCS_CGCreator") return;
        const created = nodeType.prototype.onNodeCreated, configured = nodeType.prototype.onConfigure;
        const resized = nodeType.prototype.onResize, serialized = nodeType.prototype.onSerialize, removed = nodeType.prototype.onRemoved;
        nodeType.prototype.onNodeCreated = function () {
            const result = created?.apply(this, arguments);
            if (this.cgCreator) return result;
            const state = hideState(this);
            this.cgCreator = new CGCreatorWidget(this, api);
            this.cgCreatorDOM = this.addDOMWidget("cg_ui", "ui", this.cgCreator.container, { serialize: false, hideOnZoom: false, getMinHeight: () => 550 });
            if (state) {
                const beforeQueued = state.beforeQueued;
                state.beforeQueued = (...args) => {
                    beforeQueued?.apply(state, args);
                    if (this.cgCreator.restoring) throw new Error("CG Creator is still restoring its scene.");
                    if (this.cgCreator.busy) throw new Error("Wait for CG Creator to finish its current operation.");
                    this.cgCreator.sync();
                };
                state.serializeValue = () => this.cgCreator.sync() || state.value;
            }
            this.setSize?.([1500, 950]); fit(this);
            this._cgRestore = setTimeout(() => this.cgCreator?.restore(), 0);
            return result;
        };
        nodeType.prototype.onConfigure = function () {
            this.cgCreator?.invalidateRestore();
            const result = configured?.apply(this, arguments);
            hideState(this); clearTimeout(this._cgRestore);
            this._cgRestore = setTimeout(() => this.cgCreator?.restore(), 0); fit(this); return result;
        };
        nodeType.prototype.onResize = function () { const result = resized?.apply(this, arguments); fit(this); return result; };
        nodeType.prototype.onSerialize = function (info) {
            const result = serialized?.apply(this, arguments), raw = this.cgCreator?.sync();
            const index = this.widgets?.findIndex(item => item.name === "cg_data");
            if (raw && info && index >= 0 && Array.isArray(info.widgets_values)) info.widgets_values[index] = raw;
            return result;
        };
        nodeType.prototype.onRemoved = function () { clearTimeout(this._cgRestore); this.cgCreator?.dispose(); this.cgCreator = null; return removed?.apply(this, arguments); };
    },
});
