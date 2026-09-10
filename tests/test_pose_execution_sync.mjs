import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await fs.readFile(new URL("../web/vnccs_pose_studio.js", import.meta.url), "utf8");
const widgetSource = source.slice(source.indexOf("class PoseStudioWidget {"),
    source.indexOf("// === ComfyUI Extension Registration ==="));
const syncSource = source.slice(source.indexOf("const waitForPoseStudioSyncIdle ="),
    source.indexOf("\n    },\n\n    async beforeRegisterNodeDef", source.indexOf("const waitForPoseStudioSyncIdle =")));

function harness() {
    const handlers = new Map();
    const uploads = [];
    const node = { widgets: [{ name: "pose_data", value: "{}" }] };
    const context = {
        setTimeout, clearTimeout, console: { error() {} },
        api: { addEventListener: (name, handler) => handlers.set(name, handler) },
        app: { graph: { getNodeById: id => String(id) === "703" ? node : null } },
        fetch: async (_url, options) => {
            uploads.push(JSON.parse(options.body));
            return { ok: true };
        },
    };
    const Widget = vm.runInNewContext(widgetSource + "\nPoseStudioWidget", context);
    vm.runInNewContext(syncSource, context);
    return { Widget, node, uploads, handlers };
}

test("SAM manager execution waits for cards invalidated by current character state", async () => {
    const { Widget, node, uploads, handlers } = harness();
    let runtimeCommitted = false;
    let cardsReady = false;
    const widget = Object.assign(Object.create(Widget.prototype), {
        interfaceMode: "manager",
        viewer: { isInitialized: () => true, waitForCaptureReady: async () => {} },
        applyCapturedImageSize() {},
        async applySAM3DProportionsToPoseManager() {
            // The fitting pass rendered cards before committing character state.
            this.poseCaptures = ["previous-card"];
        },
        setSkydomeFromCameraPrompt() {},
        captureActiveCharacterRuntime() { runtimeCommitted = true; },
        refreshManagerPreviewsIfNeeded() {
            if (runtimeCommitted) this._managerPreviewRefreshGeneration = 2;
            return this._managerPreviewRefreshGeneration || 1;
        },
        async awaitManagerPreviewRefresh(generation) {
            assert.equal(generation, 2);
            await Promise.resolve();
            cardsReady = true;
            this.poseCaptures = ["updated-card"];
        },
        syncToNode() {
            this.captureActiveCharacterRuntime();
            this.refreshManagerPreviewsIfNeeded();
            if (!cardsReady) throw new Error("Pose Manager previews are still refreshing.");
            this._executionCaptureSnapshot = this.poseCaptures.slice();
        },
        flushAnimationCacheUpload: async () => true,
    });
    node.studioWidget = widget;
    await handlers.get("vnccs_apply_sam3d_pose")({ detail: {
        node_id: "703", sync_token: "current-run", apply_mode: "manager_proportions", pose_data: {},
    } });
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].sync_error, undefined);
    assert.deepEqual(uploads[0].captured_images, ["updated-card"]);
    assert.equal(uploads[0].node_id, "703_current-run");
});
