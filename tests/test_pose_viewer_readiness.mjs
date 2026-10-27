import assert from "node:assert/strict";
import test from "node:test";
import { PoseViewerCore } from "../web/pose_studio/core.js";
import { createScene } from "./helpers/pose_studio_scene.mjs";

test("model loading waits for viewer initialization before applying the restored pose", async () => {
    const { w, viewer } = createScene();
    w.exportParams.skin_type = "flat_color";
    let finishInit, requested = 0, applied = 0;
    viewer.initialized = false;
    w._viewerInitPromise = new Promise(resolve => { finishInit = resolve; });
    w.requestStaticMorphModel = async () => { requested++; return {}; };
    w.modelDataFromMorphMessage = () => ({});
    w.updateAnimationTimelineBones = w.updateCaptureCameraPreview = () => {};
    w.scheduleAllManagerPreviewRefresh = w.syncToNode = () => {};
    viewer.setPose = () => { applied++; };
    const loading = w.loadModel(false, false, { updateScene: false });
    assert.equal(w.loadModel(false, false), loading, "concurrent callers share the same load");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requested, 0, "model must not finish against an uninitialized viewer");
    assert.equal(applied, 0);
    viewer.initialized = true;
    finishInit();
    assert.equal(await loading, true);
    assert.equal(requested, 1);
    assert.equal(applied, 1);
});

test("failed initialization reaches model loading and capture without replacing saved state", async t => {
    t.mock.method(console, "error", () => {});
    const { w, node } = createScene();
    const saved = node.widgets[0].value;
    const viewer = w.viewer = new PoseViewerCore({});
    viewer.setupScene = () => { throw new Error("Error creating WebGL context."); };
    w._viewerInitPromise = viewer.init();
    w.requestStaticMorphModel = () => assert.fail("Do not load models after initialization fails");
    await w._viewerInitPromise;
    assert.equal(viewer.isInitialized(), false);
    await assert.rejects(w.loadModel(), /viewer initialization failed: Error creating WebGL context/);
    await assert.rejects(viewer.waitForCaptureReady(), /viewer initialization failed: Error creating WebGL context/);
    assert.equal(node.widgets[0].value, saved);
});

test("disposing during initialization cancels model work", async () => {
    const { w } = createScene();
    w.exportParams.skin_type = "flat_color";
    let finishInit;
    w._viewerInitPromise = new Promise(resolve => { finishInit = resolve; });
    w.requestStaticMorphModel = () => assert.fail("Disposed widgets must not start model work");
    const loading = w.loadModel();
    w._disposed = true;
    finishInit();
    assert.equal(await loading, false);
});

test("camera restoration tolerates pending initialization and applies after readiness", () => {
    const pending = new PoseViewerCore({});
    assert.doesNotThrow(() => pending.snapToCaptureCamera(512, 512));
    const { viewer } = createScene();
    viewer.orbit.enableDamping = true;
    viewer.snapToCaptureCamera(512, 512, 1.2, 2, 3, 30, 10);
    assert.deepEqual(viewer.camera.position.toArray(), viewer.captureCamera.position.toArray());
    assert.equal(viewer.orbit.enableDamping, true);
});
