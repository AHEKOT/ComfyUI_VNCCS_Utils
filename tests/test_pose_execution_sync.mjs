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
    const requestUrls = [];
    const node = { widgets: [{ name: "pose_data", value: "{}" }] };
    const context = {
        setTimeout, clearTimeout, console: { error() {} },
        api: {
            addEventListener: (name, handler) => handlers.set(name, handler),
            fetchApi: (route, options) => context.fetch(`/comfy/api${route}`, options),
        },
        app: { graph: { getNodeById: id => String(id) === "703" ? node : null } },
        fetch: async (url, options) => {
            requestUrls.push(url);
            uploads.push(JSON.parse(options.body));
            return { ok: true };
        },
    };
    const Widget = vm.runInNewContext(widgetSource + "\nPoseStudioWidget", context);
    vm.runInNewContext(syncSource, context);
    return { Widget, node, uploads, requestUrls, handlers, context };
}

for (const eventName of ["vnccs_req_pose_sync", "vnccs_apply_sam3d_pose"]) {
    for (const location of ["root", "nested subgraph", "root while browsing a subgraph"]) {
        test(`${eventName} captures the execution node in ${location}`, async () => {
            const { node, context, handlers, uploads, requestUrls } = harness();
            node.studioWidget = {
                viewer: { isInitialized: () => true, updateLights() {} },
                exportParams: {}, lightParams: [],
                ensureDebugLibraryReady: async () => {}, awaitReadyForCompositeCapture: async () => {},
                applyEditorMode() {}, applyCapturedImageSize() {},
                applySAM3DProportionsToPoseManager: async () => {}, setSkydomeFromCameraPrompt() {},
                syncToNode(_fullCapture, options) {
                    assert.equal(options.executionCapture, true);
                    this._executionCaptureSnapshot = ["fresh-execution-capture"];
                },
                flushAnimationCacheUpload: async () => true,
            };
            let nodeId = "703";
            if (location === "nested subgraph") {
                const leafGraph = context.app.graph;
                const middleGraph = { getNodeById: id => id === "92" ? { subgraph: leafGraph } : null };
                context.app.rootGraph = { getNodeById: id => id === "91" ? { subgraph: middleGraph } : null };
                nodeId = "91:92:703";
            } else if (location === "root while browsing a subgraph") {
                context.app.rootGraph = context.app.graph;
                context.app.graph = { getNodeById: () => assert.fail("Current canvas is not the execution root") };
            }
            await handlers.get(eventName)({ detail: {
                node_id: nodeId, sync_token: "fresh", pose_data: {}, apply_mode: "manager_proportions",
            } });
            assert.equal(uploads.length, 1);
            assert.equal(uploads[0].node_id, `${nodeId}_fresh`);
            assert.deepEqual(uploads[0].captured_images, ["fresh-execution-capture"]);
            assert.deepEqual(requestUrls, ["/comfy/api/vnccs/pose_sync/upload_capture"]);
        });
    }

    for (const missing of ["node", "studioWidget", "pose_data"]) {
        test(`${eventName} reports a missing ${missing} without waiting for backend timeout`, async () => {
            const { node, context, handlers, uploads, requestUrls } = harness();
            if (missing === "node") context.app.graph.getNodeById = () => null;
            if (missing === "pose_data") {
                node.widgets = [];
                node.studioWidget = {
                    viewer: { isInitialized: () => true, updateLights() {} }, exportParams: {},
                    ensureDebugLibraryReady: async () => {}, applyEditorMode() {}, syncToNode() {},
                    applyCapturedImageSize() {}, applySAM3DProportionsToPoseManager: async () => {},
                    setSkydomeFromCameraPrompt() {},
                };
            }
            await handlers.get(eventName)({ detail: {
                node_id: "703", sync_token: "missing", pose_data: {}, apply_mode: "manager_proportions",
            } });
            assert.equal(uploads.length, 1);
            assert.equal(uploads[0].node_id, "703_missing");
            assert.match(uploads[0].sync_error, /widget is unavailable/);
            assert.equal(uploads[0].captured_images, undefined);
            assert.deepEqual(requestUrls, ["/comfy/api/vnccs/pose_sync/upload_capture"]);
        });
    }
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

for (const failure of ["apply", "upload"]) {
    test(`ordinary SAM pose reports ${failure} failure to its execution token`, async () => {
        const { node, uploads, handlers, context } = harness();
        node.studioWidget = {
            viewer: { isInitialized: () => true, applySAM3DImport: () => failure !== "apply" },
            applyCapturedImageSize() {}, prepareSAM3DRenderFit: async () => null,
            refreshSAMMeshOverlay: async () => {}, syncMeshProportionSlidersFromViewer() {},
            applySAM3DFrameCameraParams() {}, setSkydomeFromCameraPrompt() {}, updateTabs() {},
            ensureDebugLibraryReady: async () => {}, commitViewerPoseToCurrentEditor() {},
            flushAnimationCacheUpload: async () => true, poseCaptures: ["capture"],
        };
        context.fetch = async (_url, options) => {
            const body = JSON.parse(options.body); uploads.push(body);
            return body.sync_error ? { ok: true } : {
                ok: false, status: 413, json: async () => ({ error: "capture payload is too large" }),
            };
        };
        await handlers.get("vnccs_apply_sam3d_pose")({ detail: {
            node_id: "703", sync_token: "ordinary", pose_data: {},
        } });
        const last = uploads.at(-1);
        assert.equal(last.node_id, "703_ordinary");
        assert.match(last.sync_error, failure === "apply" ? /Failed to apply/ : /payload is too large/);
    });
}
