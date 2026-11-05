const styles = `
.vnccs-pose-creator{box-sizing:border-box;width:100%;height:100%;min-height:380px;display:flex;flex-direction:column;gap:12px;padding:16px;background:#12121a;color:#e8e8f0;font:13px Sora,system-ui,sans-serif;pointer-events:none}
.vnccs-pose-creator *{box-sizing:border-box}
.vnccs-pose-creator-preview{position:relative;flex:1;min-height:180px;background:#1a1a26;border-radius:8px;display:grid;place-items:center;overflow:hidden}
.vnccs-pose-creator-preview img{position:absolute;width:100%;height:100%;object-fit:contain}
.vnccs-pose-creator-empty{margin:24px;max-width:28ch;text-align:center;color:#b7b7c8;line-height:1.6}
.vnccs-pose-creator-name{margin:0;font-size:16px;font-weight:600;line-height:1.4;overflow-wrap:anywhere}
.vnccs-pose-creator-category{margin:0;color:#b8a9e8;line-height:1.5;overflow-wrap:anywhere}
.vnccs-pose-creator-status{margin:0;color:#b7b7c8;line-height:1.5;overflow-wrap:anywhere;white-space:pre-wrap}
.vnccs-pose-creator[data-stage="done"] .vnccs-pose-creator-status{color:#00d68f}
.vnccs-pose-creator[data-stage="error"] .vnccs-pose-creator-status{color:#ff8fa3}
.vnccs-pose-studio.vnccs-pose-creator-renderer{position:fixed;left:-12000px;top:0;width:900px;height:740px;visibility:hidden;pointer-events:none}
`;

const terminal = new Set(["done", "error", "cancelled"]);

export class PoseLibraryCreatorWidget {
    constructor(node, api) {
        this.node = node;
        this.api = api;
        this.runId = null;
        this.disposed = false;
        this.renderController = null;
        this.studio = null;
        this.imageSequence = 0;
        if (!document.getElementById("vnccs-pose-creator-style")) {
            const style = document.createElement("style");
            style.id = "vnccs-pose-creator-style";
            style.textContent = styles;
            document.head.appendChild(style);
        }
        this.container = document.createElement("div");
        this.container.className = "vnccs-pose-creator";
        this.container.dataset.stage = "ready";
        this.preview = document.createElement("div");
        this.preview.className = "vnccs-pose-creator-preview";
        const empty = document.createElement("p");
        empty.className = "vnccs-pose-creator-empty";
        empty.textContent = "Connect a pose image and a character reference, then run the workflow.";
        this.preview.append(empty);
        this.name = document.createElement("p");
        this.name.className = "vnccs-pose-creator-name";
        this.name.textContent = "New library pose";
        this.category = document.createElement("p");
        this.category.className = "vnccs-pose-creator-category";
        this.category.textContent = "Local User Poses";
        this.status = document.createElement("p");
        this.status.className = "vnccs-pose-creator-status";
        this.status.setAttribute("role", "status");
        this.status.setAttribute("aria-live", "polite");
        this.status.textContent = "The name, category and tags are filled automatically.";
        this.container.append(this.preview, this.name, this.category, this.status);
    }

    cancelRender() {
        this.renderController?.abort();
        this.renderController = null;
        this.studio?.dispose();
        this.studio?.container.remove();
        this.studio = null;
    }

    update(detail) {
        if (this.disposed) return;
        if (detail.stage === "recognize") {
            this.cancelRender();
            this.runId = detail.run_id;
            ++this.imageSequence;
        }
        if (this.runId !== detail.run_id) return;
        this.container.dataset.stage = detail.stage;
        this.container.setAttribute("aria-busy", String(!terminal.has(detail.stage)));
        this.status.textContent = String(detail.message || "").slice(0, 240);
        this.status.title = String(detail.message || "");
        if (terminal.has(detail.stage)) this.cancelRender();
        if (detail.result) this.showResult(detail.result);
    }

    showResult(result) {
        if (this.disposed || (this.runId && this.runId !== result.run_id)) return;
        this.runId = result.run_id;
        this.name.textContent = result.name;
        this.category.textContent = result.category;
        this.container.dataset.stage = "done";
        this.container.setAttribute("aria-busy", "false");
        this.status.textContent = "Saved to Local User Poses";
        const sequence = ++this.imageSequence;
        const image = new Image();
        image.alt = result.name;
        image.draggable = false;
        image.onload = () => {
            if (!this.disposed && sequence === this.imageSequence) this.preview.replaceChildren(image);
        };
        image.onerror = () => {
            if (!this.disposed && sequence === this.imageSequence) {
                this.status.textContent = "Pose saved. Open Pose Studio to view its image.";
            }
        };
        const query = new URLSearchParams({ repository: result.repository, category: result.category,
            asset_type: "pose", v: result.run_id });
        const path = `/vnccs/pose_library/preview/${encodeURIComponent(result.name)}?${query}`;
        image.src = typeof this.api.apiURL === "function" ? this.api.apiURL(path) : path;
    }

    async upload(detail, payload) {
        const response = await this.api.fetchApi("/vnccs/pose_sync/upload_capture", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...payload, node_id: `${detail.node_id}_${detail.run_id}`, sync_token: detail.run_id }),
        });
        if (!response.ok) throw new Error(`Pose capture upload failed (HTTP ${response.status}).`);
    }

    async render(detail) {
        if (this.disposed || this.runId !== detail.run_id || terminal.has(this.container.dataset.stage)) return;
        this.cancelRender();
        const controller = this.renderController = new AbortController();
        const assertCurrent = () => {
            if (this.disposed || controller.signal.aborted || this.runId !== detail.run_id) {
                throw new Error("Pose creation was cancelled or replaced.");
            }
        };
        let studio;
        try {
            const { PoseStudioWidget } = await import("../vnccs_pose_studio.js");
            assertCurrent();
            const node = { id: `${detail.node_id}_${detail.run_id}`, size: [900, 740],
                widgets: [{ name: "pose_data", value: "{}" }] };
            studio = this.studio = new PoseStudioWidget(node, { embedded: true });
            studio.container.classList.add("vnccs-pose-creator-renderer");
            studio.container.inert = true;
            studio.container.setAttribute("aria-hidden", "true");
            document.body.append(studio.container);
            Object.assign(studio.exportParams, { samApplyCamera: true, capture_image_size: true });
            if (!studio.applyCapturedImageSize(detail.width, detail.height)) throw new Error("Invalid pose capture dimensions.");
            await studio.loadModel(false);
            assertCurrent();
            await studio.awaitReadyForCompositeCapture();
            assertCurrent();
            await studio.applySAM3DPoseForCapture(detail.pose_data, assertCurrent, controller.signal);
            await studio.awaitReadyForCompositeCapture();
            assertCurrent();
            studio.commitViewerPoseToCurrentEditor({ fullCapture: true, syncOptions: { executionCapture: true } });
            const pose = studio.buildLibraryAsset("");
            const captures = studio._executionCaptureSnapshot || studio.poseCaptures;
            if (captures?.length !== 1 || !captures[0]) throw new Error("Pose Studio did not render a pose image.");
            await this.upload(detail, { pose, captured_images: [captures[0]] });
        } catch (error) {
            if (!controller.signal.aborted && !this.disposed) {
                try { await this.upload(detail, { sync_error: String(error?.message || error).slice(0, 2048) }); }
                catch (uploadError) {
                    this.update({ ...detail, stage: "error", message: uploadError.message });
                }
            }
        } finally {
            studio?.dispose();
            studio?.container.remove();
            if (this.studio === studio) this.studio = null;
            if (this.renderController === controller) this.renderController = null;
        }
    }

    dispose() {
        this.disposed = true;
        ++this.imageSequence;
        this.cancelRender();
        this.container.remove();
    }
}
