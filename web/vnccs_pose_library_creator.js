import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { PoseLibraryCreatorWidget } from "./pose_studio/library_creator.mjs";

function findNode(nodeId) {
    let graph = app.rootGraph ?? app.graph;
    let node;
    for (const id of String(nodeId).split(":")) {
        node = graph?.getNodeById?.(id);
        if (!node) return null;
        graph = node.subgraph;
    }
    return node;
}

app.registerExtension({
    name: "VNCCS.PoseLibraryCreator",
    setup() {
        api.addEventListener("vnccs_pose_library_creator_status", ({ detail }) => {
            findNode(detail.node_id)?.poseLibraryCreator?.update(detail);
        });
        api.addEventListener("vnccs_pose_library_creator_render", ({ detail }) => {
            void findNode(detail.node_id)?.poseLibraryCreator?.render(detail);
        });
    },
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "VNCCS_PoseLibraryCreator") return;
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = created?.apply(this, arguments);
            this.poseLibraryCreator = new PoseLibraryCreatorWidget(this, api);
            const widget = this.addDOMWidget("pose_library_creator_ui", "ui", this.poseLibraryCreator.container, {
                serialize: false, hideOnZoom: false, getMinHeight: () => 380,
            });
            Object.defineProperty(widget, "width", {
                configurable: true, get: () => this.size?.[0], set() {},
            });
            this.setSize([460, 860]);
            return result;
        };
        const executed = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const result = executed?.apply(this, arguments);
            const saved = message?.pose_library_result?.[0];
            if (saved) this.poseLibraryCreator?.showResult(saved);
            return result;
        };
        const configured = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            this.poseLibraryCreator?.cancelRender();
            if (this.poseLibraryCreator) {
                this.poseLibraryCreator.runId = null;
                ++this.poseLibraryCreator.imageSequence;
            }
            const result = configured?.apply(this, arguments);
            const category = this.widgets?.find(widget => widget.name === "category");
            // Older workflows stored the removed Turbo toggle in this position.
            if (category && typeof category.value === "boolean") category.value = "";
            if (this.size?.[1] < 860) this.setSize([this.size[0], 860]);
            return result;
        };
        const removed = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            this.poseLibraryCreator?.dispose();
            return removed?.apply(this, arguments);
        };
    },
});
