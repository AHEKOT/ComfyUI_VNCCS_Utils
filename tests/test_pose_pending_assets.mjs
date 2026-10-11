import assert from "node:assert/strict";
import test from "node:test";
import { createScene } from "./helpers/pose_studio_scene.mjs";

function referenceLoads(scene) {
    const loads = [];
    scene.viewer.THREE = { ...scene.THREE, TextureLoader: class {
        load(url, ready, _progress, error) { loads.push({ url, ready, error }); }
    } };
    return loads;
}
const texture = () => ({ dispose() {} });

test("captures wait for the newest background texture, including replacement while waiting", async () => {
    const scene = createScene(), loads = referenceLoads(scene);
    scene.viewer.loadReferenceImage("first");
    let finished = false;
    const ready = scene.viewer.waitForCaptureReady().then(() => { finished = true; });
    await Promise.resolve();
    assert.equal(scene.viewer.isCaptureReady(), false);
    assert.equal(finished, false);
    scene.viewer.loadReferenceImage("second");
    loads[0].ready(texture());
    await Promise.resolve();
    assert.equal(finished, false);
    loads[1].ready(texture());
    await ready;
    assert.equal(scene.viewer.isCaptureReady(), true);
});

test("failed backgrounds report a capture error and removing them releases pending captures", async () => {
    const scene = createScene(), loads = referenceLoads(scene);
    scene.viewer.loadReferenceImage("broken");
    const failed = scene.viewer.waitForCaptureReady();
    loads[0].error(new Error("decode failed"));
    await assert.rejects(failed, /background image/i);
    scene.viewer.loadReferenceImage("removed");
    const ready = scene.viewer.waitForCaptureReady();
    scene.viewer.removeReferenceImage();
    await ready;
    assert.equal(scene.viewer.isCaptureReady(), true);
});

test("disposing during background loading rejects pending capture readiness", async () => {
    const scene = createScene();
    referenceLoads(scene);
    scene.viewer.loadReferenceImage("pending");
    const ready = scene.viewer.waitForCaptureReady();
    scene.viewer.orbit.dispose = () => {};
    scene.viewer.dispose();
    await assert.rejects(ready, /disposed/i);
});

test("manager background failures end preview refresh with a useful error", async () => {
    const scene = createScene(), loads = referenceLoads(scene), messages = [];
    scene.w.interfaceMode = "manager";
    scene.w._managerPreviewRefreshGeneration = 1;
    scene.w.showMessage = message => messages.push(message);
    scene.viewer.loadReferenceImage("broken");
    scene.w.refreshAllManagerPreviews(1);
    loads[0].error(new Error("decode failed"));
    await new Promise(resolve => setImmediate(resolve));
    assert.match(scene.w._managerPreviewRefreshError.message, /background image/i);
    assert.equal(messages.length, 1);
    await assert.rejects(scene.w.awaitManagerPreviewRefresh(1), /background image/i);
});

test("a timed-out static morph response cannot overwrite the current body or stop another solve", async () => {
    const scene = createScene(), sent = [];
    scene.w.ensureMorphWorker = () => ({ postMessage: message => sent.push(message) });
    const pending = scene.w.requestStaticMorphModel();
    const timeout = [...scene.timers.values()].at(-1);
    timeout();
    await assert.rejects(pending, /Timed out/);
    scene.w._morphSolveInFlight = true;
    scene.viewer.updateBodyVertices = () => assert.fail("expired response must be ignored");
    scene.w.handleMorphWorkerMessage({ type: "result", seq: sent[0].seq });
    assert.equal(scene.w._morphSolveInFlight, true);
    scene.w.handleMorphWorkerMessage({ type: "error", seq: sent[0].seq, message: "expired failure" });
    assert.equal(scene.w._morphSolveInFlight, true);
    assert.equal(scene.w._morphWorkerFailed, false);
});

test("an unset thumbnail preference keeps the declared default size", () => {
    const scene = createScene();
    assert.equal(scene.w.libraryThumbSize, scene.w.getLibraryThumbnailBounds().defaultSize);
});
