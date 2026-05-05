import { app } from "../../scripts/app.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

app.registerExtension({
    name: "Slimy.RTMWPose",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "VNCCS_RTMWPose") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);

            const preview = ComfyWidgets["STRING"](
                this, "rtmw_preview",
                ["STRING", { multiline: true }],
                app
            ).widget;
            preview.inputEl.readOnly         = true;
            preview.inputEl.style.fontFamily  = "monospace";
            preview.inputEl.style.fontSize    = "11px";
            preview.inputEl.style.height      = "160px";
            preview.value          = "Queue Promptを実行してください。";
            preview.inputEl.value  = "Queue Promptを実行してください。";

            this.addWidget("button", "save_btn", "💾 JSONを保存", () => {
                const text = this.widgets?.find(w => w.name === "rtmw_preview")?.value ?? "";
                if (!text || text.startsWith("Queue")) {
                    alert("まだデータがありません。先にQueue Promptを実行してください。");
                    return;
                }
                const d   = new Date();
                const ts  = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}_${String(d.getHours()).padStart(2,"0")}${String(d.getMinutes()).padStart(2,"0")}${String(d.getSeconds()).padStart(2,"0")}`;
                const name = `rtmw3d_${ts}.json`;
                const blob = new Blob([text], { type: "application/json" });
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement("a");
                a.href     = url;
                a.download = name;
                a.click();
                URL.revokeObjectURL(url);
            });

            refreshSize(this);
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            const text = message?.text?.[0];
            if (!text) return;
            const w = this.widgets?.find(w => w.name === "rtmw_preview");
            if (w) {
                w.value         = text;
                w.inputEl.value = text;
                refreshSize(this);
            }
        };
    },
});

function refreshSize(node) {
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            node.setSize(node.computeSize());
            app.graph.setDirtyCanvas(true, false);
        });
    });
}
